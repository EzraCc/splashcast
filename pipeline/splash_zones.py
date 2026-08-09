"""Wind capture -> splash-zone viewer data, for index.html.

Two stages (see config.py for the shared constants):
  1. compute_splash_points(): wind capture parquet -> per-model/hour/altitude/
     deploy/rate drift points (apogee-to-ground descent integration). Still
     runs on every pull, but (as of 2026-08) no longer feeds the live zone
     JSON directly -- only points_history.json/History mode and
     compare_to_pipeline()'s hull check consume its output now.
  2. build_viewer_data(): wind profiles (build_profile_single(), the same
     per-model/hour data compute_splash_points() itself builds internally)
     + the descent-sim constants (config.py's rate/altitude/step values) +
     map-projection scaling -- the small JSON the viewer computes its own
     zones from client-side (see app.js's simulateDrift(), a direct port of
     this file's simulate()). The drift integration for whatever
     hour/deploy/rate/altitude is currently selected happens in the
     browser now, not here -- this used to publish every combination
     pre-simulated (thousands of points per file); publishing the wind
     profile instead let users edit the fast/slow rates live and cut
     published file size by roughly 80-90%.

CLI: `python splash_zones.py <target_date> [--site site_id]` finds that
target's latest capture under pipeline/data/<site_id>/live/, runs both
stages, and publishes into the deployable site/ tree: the zone JSON + a
points_history.json (see build_points_history() -- every capture's splash
points for this target date, not just the latest, for the viewer's History
mode) + a regenerated site/data/<site_id>/manifest.json (so the viewer's
date selector picks up both) + a refresh of the regional site-picker's
has_data flags (fetch_site_maps.refresh_regional_sites_metadata()).
Intermediate artifacts (the splash-points parquet per capture) stay in
pipeline/data/, never published -- only the zone JSON and points_history are
public.
"""

import json
import math
from datetime import date, datetime, timedelta, timezone
from datetime import time as dtime
from pathlib import Path
from zoneinfo import ZoneInfo

import numpy as np
import pandas as pd
from scipy.spatial import ConvexHull

import config
import fetch_site_maps

MPH_TO_FTPS = 5280 / 3600
_SITE_TZ = ZoneInfo(config.SITE_TZ)


# --- ICAO standard atmosphere (troposphere + lower stratosphere, 0-20km MSL)
# -- shared by std_atm_ft() (pressure -> altitude, used to place wind-profile
# points) and air_density_ratio() (altitude -> density, used by
# descent_rate_at() below). Verified against published ISA tables to the 3rd
# decimal at the tropopause and at 50,000ft; comfortably covers every current
# site's waiver (Argonia's 50,000ft is the tallest) with margin. NOT valid
# for near-space altitudes like Jim Jarvis's ~200,000ft flights -- those are
# governed by a very different non-equilibrium/high-Mach freefall regime
# neither formula models (see docs/spec.md §9's "still open" items).
_ICAO_T0_K = 288.15
_ICAO_P0_HPA = 1013.25
_ICAO_LAPSE_K_PER_M = 0.0065
_ICAO_TROP_TOP_M = 11000.0
_ICAO_TROP_EXP = 5.25588  # g0*M / (R*L)
_ICAO_STRAT_COEF_PER_M = 1.5768e-4  # g0*M / (R*T_stratosphere)
_ICAO_P11_HPA = _ICAO_P0_HPA * (1 - _ICAO_LAPSE_K_PER_M * _ICAO_TROP_TOP_M / _ICAO_T0_K) ** _ICAO_TROP_EXP
_ICAO_RHO_RATIO_AT_TROPOPAUSE = (1 - _ICAO_LAPSE_K_PER_M * _ICAO_TROP_TOP_M / _ICAO_T0_K) ** (_ICAO_TROP_EXP - 1)


def std_atm_ft(hpa: float) -> float:
    """Standard-atmosphere height (ft MSL) for a pressure level (hPa). Uses
    the two-layer model above (not a troposphere-only formula, valid only to
    ~36,089ft) since per-site pressure brackets reach well above that for
    taller-waiver sites."""
    if hpa >= _ICAO_P11_HPA:
        theta = (hpa / _ICAO_P0_HPA) ** (1 / _ICAO_TROP_EXP)
        return (_ICAO_T0_K / _ICAO_LAPSE_K_PER_M) * (1 - theta) * 3.28084
    h_m = _ICAO_TROP_TOP_M - math.log(hpa / _ICAO_P11_HPA) / _ICAO_STRAT_COEF_PER_M
    return h_m * 3.28084


# --- Air-density-scaled descent rate ----------------------------------------
# Terminal velocity under a fixed drogue/canopy scales as 1/sqrt(air density)
# -- at terminal velocity, drag (0.5*rho*v^2*Cd*A) equals weight, and Cd*A is
# roughly constant for a given rig, so v ~ 1/sqrt(rho). SINGLE_DEPLOY_RATES_FPS/
# DUAL_DEPLOY_RATES_FPS are treated as the rate AT THIS SITE'S OWN GROUND LEVEL
# (AGL=0 -- the number you'd see on a low-altitude test drop), scaled up for
# thinner air higher via the density-ratio formula above. descent_rate_at()
# and build_profile_single() below both take site_elev_ft per-site
# (config.elev_ft_for_site()), since a site's real elevation changes this.
def air_density_ratio(alt_m_msl: float) -> float:
    """Air density relative to sea-level standard (ICAO atmosphere)."""
    if alt_m_msl <= _ICAO_TROP_TOP_M:
        theta = 1 - _ICAO_LAPSE_K_PER_M * alt_m_msl / _ICAO_T0_K
        return theta ** (_ICAO_TROP_EXP - 1)
    return _ICAO_RHO_RATIO_AT_TROPOPAUSE * math.exp(-_ICAO_STRAT_COEF_PER_M * (alt_m_msl - _ICAO_TROP_TOP_M))


def descent_rate_at(alt_agl_ft: float, ground_rate_ftps: float, site_elev_ft: float) -> float:
    """`ground_rate_ftps` (a SINGLE_DEPLOY_RATES_FPS/DUAL_DEPLOY_RATES_FPS
    value) scaled for the thinner air at `alt_agl_ft` AGL at a site whose
    ground sits at `site_elev_ft` MSL -- see the module comment above."""
    ground_rho_ratio = air_density_ratio(site_elev_ft / 3.28084)
    rho_here = air_density_ratio((alt_agl_ft + site_elev_ft) / 3.28084)
    return ground_rate_ftps * math.sqrt(ground_rho_ratio / rho_here)


def build_profile_single(df: pd.DataFrame, hour_dt: datetime, model_key: str, site_elev_ft: float, levels_mb: list[int]) -> list[tuple[float, float, float]]:
    """(agl_ft, speed_mph, dir_deg) profile for one model/hour, sorted by altitude.

    Surface 10m wind anchors the bottom; each of `levels_mb` (every level the
    models offer up to this site's own ceiling -- config.levels_mb_for_site())
    except 1000mb (its standard-atm height is unreliable this close
    to the surface -- surface wind covers that end of the profile instead)
    contributes one more point, converted from pressure level to AGL feet via
    `site_elev_ft` (this site's own ground elevation MSL --
    config.elev_ft_for_site()).
    """
    points = []
    cell = df[(df["valid_time_local"] == hour_dt) & (df["level_type"] == "height") & (df["level_value"] == 10.0) & (df["model"] == model_key)]
    spd = cell[cell["variable"] == "wind_speed"]["value"]
    drc = cell[cell["variable"] == "wind_direction"]["value"]
    if len(spd) and len(drc):
        points.append((0.0, float(spd.iloc[0]), float(drc.iloc[0])))
    for lvl in levels_mb:
        if lvl == 1000:
            continue
        agl = std_atm_ft(lvl) - site_elev_ft
        cell = df[(df["valid_time_local"] == hour_dt) & (df["level_type"] == "pressure") & (df["level_value"] == float(lvl)) & (df["model"] == model_key)]
        spd = cell[cell["variable"] == "wind_speed"]["value"]
        drc = cell[cell["variable"] == "wind_direction"]["value"]
        if len(spd) and len(drc):
            points.append((agl, float(spd.iloc[0]), float(drc.iloc[0])))
    return sorted(points)


def interp(profile: list[tuple[float, float, float]], alt: float) -> tuple[float, float]:
    """Wind (speed_mph, dir_deg) at `alt`, linearly interpolated (circular for direction)."""
    if alt <= profile[0][0]:
        return profile[0][1], profile[0][2]
    if alt >= profile[-1][0]:
        return profile[-1][1], profile[-1][2]
    for i in range(len(profile) - 1):
        a0, s0, d0 = profile[i]
        a1, s1, d1 = profile[i + 1]
        if a0 <= alt <= a1:
            f = (alt - a0) / (a1 - a0)
            speed = s0 + f * (s1 - s0)
            diff = ((d1 - d0 + 180) % 360) - 180
            direction = (d0 + f * diff) % 360
            return speed, direction
    raise AssertionError("unreachable -- profile is sorted and alt is bounded above")


def simulate(profile: list[tuple[float, float, float]], apogee_ft: float, phases: list[tuple[float, float, float]], site_elev_ft: float, step_ft: float = None) -> tuple[float, float]:
    """Integrate drift (x_ft east, y_ft north) across one or more descent phases.

    Each phase is (rate_ftps, seg_top_ft, seg_bottom_ft) -- e.g. dual-deploy
    passes a drogue phase down to main-deploy altitude, then a main phase down
    to the ground. Wind sampled at each step_ft slice's midpoint altitude.

    rate_ftps is scaled per-step by descent_rate_at() (thinner air at
    altitude -> faster actual fall than the same drogue's ground-level rate)
    rather than held constant across the whole phase -- see that function's
    docstring/the module comment above it. site_elev_ft is this site's own
    ground elevation MSL (config.elev_ft_for_site()), needed for that scaling.
    """
    step_ft = config.DESCENT_STEP_FT if step_ft is None else step_ft
    x = y = 0.0
    alt = apogee_ft
    for rate_ftps, seg_top, seg_bottom in phases:
        top = min(alt, seg_top)
        bottom = seg_bottom
        if top <= bottom:
            continue
        n = max(1, int((top - bottom) / step_ft))
        dz = (top - bottom) / n
        for i in range(n):
            mid = top - (i + 0.5) * dz
            spd_mph, drc = interp(profile, mid)
            spd_ftps = spd_mph * MPH_TO_FTPS
            u = -spd_ftps * math.sin(math.radians(drc))
            v = -spd_ftps * math.cos(math.radians(drc))
            dt = dz / descent_rate_at(mid, rate_ftps, site_elev_ft)
            x += u * dt
            y += v * dt
        alt = bottom
    return x, y


def compute_splash_points(df: pd.DataFrame, target_date: date, site_id: str = "hutto") -> pd.DataFrame:
    """Wind capture -> drift points for every hour/model/altitude/deploy/rate combo.

    Two independent callers: build_viewer_data() (this function's `pts` is
    used only to size base_view_box there, see its own comment) and
    build_points_history() (where this IS the real data source for History
    mode's ladder-altitude view, points_by_key -- unlike byAltitude/byTime,
    which always resimulate client-side off DATA.wind_profiles via zoneFor(),
    History's ladder view stays server-precomputed across every capture date
    at once, so it needs its own real per-hour grid here, not just a
    viewbox estimate). Looped over WIND_PROFILE_HOURS_LOCAL (hourly) for
    both reasons -- more real hours for History's own slider ticks, and a
    same-or-larger viewbox estimate for the other caller (never smaller,
    so it's a safe widening for that use too).

    Models with fewer than 2 usable profile points at a given hour (i.e. beyond
    that model's forecast horizon at this lead time) are skipped for that
    hour -- this is the mechanism that naturally drops short-horizon models
    (e.g. HRRR) at longer lead times without any lead-time-specific logic here.

    Altitudes are per-site (config.altitudes_for_site()), not one fixed list
    for every site -- a 10,000ft-waiver site and a 50,000ft-waiver site need
    very different apogees simulated. Pressure levels sampled for the wind
    profile are likewise per-site (config.levels_mb_for_site()), but sized to
    reach the site's ceiling directly rather than derived from the altitude
    list above -- the two are deliberately decoupled (2026-08) so the wind
    profile itself uses the models' full real vertical resolution regardless
    of how coarse or fine the user-facing apogee list is. Single-deploy
    points are skipped above config.SINGLE_DEPLOY_MAX_ALT_FT -- not a
    realistic recovery configuration at higher altitude (see that constant's
    own comment in config.py).
    """
    site_elev_ft = config.elev_ft_for_site(site_id)
    levels_mb = config.levels_mb_for_site(site_id)
    altitudes = config.altitudes_for_site(site_id)
    all_points = []
    for h in config.WIND_PROFILE_HOURS_LOCAL:
        hdt = datetime.combine(target_date, dtime(h, 0))
        for m in config.LIVE_PROFILE_MODELS:
            profile = build_profile_single(df, hdt, m, site_elev_ft, levels_mb)
            if len(profile) < 2:
                continue
            for alt in altitudes:
                if alt <= config.SINGLE_DEPLOY_MAX_ALT_FT:
                    for rate_name, rate in config.SINGLE_DEPLOY_RATES_FPS.items():
                        x, y = simulate(profile, float(alt), [(rate, float(alt), 0)], site_elev_ft)
                        all_points.append((h, "single", rate_name, alt, m, x, y))
                for rate_name, (drogue, main) in config.DUAL_DEPLOY_RATES_FPS.items():
                    phases = [(drogue, float(alt), config.MAIN_DEPLOY_ALTITUDE_FT), (main, config.MAIN_DEPLOY_ALTITUDE_FT, 0)]
                    x, y = simulate(profile, float(alt), phases, site_elev_ft)
                    all_points.append((h, "dual", rate_name, alt, m, x, y))
    return pd.DataFrame(all_points, columns=["hour", "deploy", "rate", "altitude", "model", "x_ft", "y_ft"])


# --- "Actual" splash points from HRRR's own analysis ------------------------
# pull_historical.py's pull_actual() fetches HRRR's f00 (its own data-
# assimilation output, not a forecast) at every WIND_PROFILE_HOURS_LOCAL
# hour (hourly, 9am-5pm -- widened from the sparser SPLASH_HOURS_LOCAL so
# this has the same real hourly density the live pull publishes) for a past
# target date -- the closest this project has to "what actually happened"
# absent real post-flight GPS (see build_points_history()'s comment on
# points_history.json's actuals key). The two functions below turn that raw
# pull into the same kind of simulated point every forecast gets, so the
# viewer's star marker has something real to show.
MPS_TO_MPH = 2.236936


def build_actual_profile(hour_df: pd.DataFrame, site_elev_ft: float) -> list[tuple[float, float, float]]:
    """(agl_ft, speed_mph, dir_deg) profile for one hour, from
    pull_historical.py's extract_profile()/extract_surface() output --
    same shape as build_profile_single()'s return, but sourced from that
    script's simpler (pressure_level_hpa, wind_speed[[m/s]], wind_direction)
    schema instead of the live pull's tidy long format, and needing the
    m/s -> mph conversion the live pull's own wind_speed_unit=mph param
    already handles for us elsewhere."""
    points = []
    surf = hour_df[hour_df["pressure_level_hpa"].isna()]
    if not surf.empty:
        row = surf.iloc[0]
        points.append((0.0, row["wind_speed"] * MPS_TO_MPH, row["wind_direction"]))
    for _, row in hour_df.dropna(subset=["pressure_level_hpa"]).iterrows():
        agl = std_atm_ft(row["pressure_level_hpa"]) - site_elev_ft
        points.append((agl, row["wind_speed"] * MPS_TO_MPH, row["wind_direction"]))
    return sorted(points)


def compute_actual_points(site_id: str, target_date: date) -> tuple[dict[str, dict], dict[str, list]]:
    """One simulated point per hour/deploy/rate/altitude -- same grid
    compute_splash_points() iterates, just against the single HRRR-analysis
    profile per hour instead of every live model -- keyed exactly like
    points_by_key so the viewer can look either up the same way. Returns
    ({}, {}) if pull_historical.py hasn't pulled this site/date yet (most
    target dates won't have this -- it's a manually-run backfill, not part
    of the daily live-pull path).

    Second return value is the raw per-hour wind profile itself (same
    [[alt_ft, speed_mph, dir_deg], ...] shape build_viewer_data() publishes
    for each live model in DATA.wind_profiles) -- previously computed here
    and discarded once simulate() ran, now also returned so the viewer can
    run its own simulateDriftPath() against it and draw a real apogee-to-
    ground path for the "actual" flight in 3D, not just the single landing
    point simulate() itself produces."""
    raw_path = Path(config.DATA_DIR) / site_id / "raw" / f"{target_date}_actual.parquet"
    if not raw_path.exists():
        return {}, {}
    raw = pd.read_parquet(raw_path)
    site_elev_ft = config.elev_ft_for_site(site_id)
    altitudes = config.altitudes_for_site(site_id)
    actuals = {}
    wind_profile_by_hour = {}
    for h in config.WIND_PROFILE_HOURS_LOCAL:
        # raw["valid_time"] is UTC-naive (straight from the GRIB2 files via
        # Herbie, which does no timezone conversion) -- NOT local like the
        # live pull's "valid_time_local" column build_profile_single() reads
        # elsewhere. h is a local hour (config.WIND_PROFILE_HOURS_LOCAL), so
        # it has to go through the same local->UTC conversion pull_historical.py's
        # target_valid_time() already does, or every lookup here would
        # silently match nothing.
        hdt_utc = datetime.combine(target_date, dtime(h, 0), tzinfo=_SITE_TZ).astimezone(timezone.utc).replace(tzinfo=None)
        hour_df = raw[raw["valid_time"] == hdt_utc]
        if hour_df.empty:
            continue
        profile = build_actual_profile(hour_df, site_elev_ft)
        if len(profile) < 2:
            continue
        # float() before round() -- build_actual_profile()'s tuples carry
        # numpy float32/64 scalars (sourced from a pandas DataFrame, unlike
        # build_profile_single()'s already-native-float return), and
        # round(numpy_float, ndigits) returns that SAME numpy type rather
        # than coercing to a plain Python float -- confirmed directly (a
        # bare `round(a)` with no ndigits DOES coerce to Python int, which
        # is why this wasn't caught by the no-ndigits altitude case, only
        # the two round(..., 2) calls). json.dump() can't serialize a
        # numpy scalar; explicit float() first guarantees a native type
        # regardless of what round() does to it.
        wind_profile_by_hour[str(h)] = [[round(float(a)), round(float(s), 2), round(float(d), 2)] for a, s, d in profile]
        for alt in altitudes:
            if alt <= config.SINGLE_DEPLOY_MAX_ALT_FT:
                for rate_name, rate in config.SINGLE_DEPLOY_RATES_FPS.items():
                    x, y = simulate(profile, float(alt), [(rate, float(alt), 0)], site_elev_ft)
                    actuals[f"{h}_single_{rate_name}_{alt}"] = {"x_ft": round(float(x), 1), "y_ft": round(float(y), 1)}
            for rate_name, (drogue, main) in config.DUAL_DEPLOY_RATES_FPS.items():
                phases = [(drogue, float(alt), config.MAIN_DEPLOY_ALTITUDE_FT), (main, config.MAIN_DEPLOY_ALTITUDE_FT, 0)]
                x, y = simulate(profile, float(alt), phases, site_elev_ft)
                actuals[f"{h}_dual_{rate_name}_{alt}"] = {"x_ft": round(float(x), 1), "y_ft": round(float(y), 1)}
    return actuals, wind_profile_by_hour


def hull_of(points_xy: list[tuple[float, float]]) -> list[list[float]]:
    arr = np.array(points_xy)
    if len(arr) < 3:
        return arr.tolist()
    try:
        h = ConvexHull(arr)
        return arr[h.vertices].tolist()
    except Exception:
        return arr.tolist()


def build_viewer_data(df: pd.DataFrame, pts: pd.DataFrame, site_meta: dict, site_id: str, target_date: date) -> dict:
    """Wind profiles + descent-sim constants + map-projection scaling -- the
    exact JSON schema index.html's DATA expects. `pts` (compute_splash_points()'s
    output) is used only to size base_view_box (see below) -- the zones
    themselves are no longer precomputed here, they're built client-side by
    app.js's simulateDrift() from wind_profiles below, at whatever rate the
    viewer's rate editor currently has selected."""
    detail = site_meta["detail"]
    wide = site_meta["wide"]
    img_w, img_h = detail["image_size_px"]
    b = detail["bounds"]
    lat_s, lat_n = b["lat_s"], b["lat_n"]
    lon_w, lon_e = b["lon_w"], b["lon_e"]
    site_lat, site_lon = site_meta["site_lat"], site_meta["site_lon"]

    m_per_deg_lat = 111320
    m_per_deg_lon = 111320 * math.cos(math.radians(site_lat))
    ft_to_m = 0.3048

    def ft_to_px(x_ft, y_ft):
        lat = site_lat + (y_ft * ft_to_m) / m_per_deg_lat
        lon = site_lon + (x_ft * ft_to_m) / m_per_deg_lon
        return lonlat_to_px(lon, lat)

    def lonlat_to_px(lon, lat):
        px = (lon - lon_w) / (lon_e - lon_w) * img_w
        py = (lat_n - lat) / (lat_n - lat_s) * img_h
        return px, py

    wb = wide["bounds"]
    wx0, wy0 = lonlat_to_px(wb["lon_w"], wb["lat_n"])
    wx1, wy1 = lonlat_to_px(wb["lon_e"], wb["lat_s"])
    wide_view_box = [round(wx0, 1), round(wy0, 1), round(wx1 - wx0, 1), round(wy1 - wy0, 1)]

    boost_angle_rad = math.radians(config.BOOST_ANGLE_OFF_VERTICAL_DEG)
    site_elev_ft = config.elev_ft_for_site(site_id)
    levels_mb = config.levels_mb_for_site(site_id)
    altitudes = config.altitudes_for_site(site_id)
    # Unconditionally both -- the ladder's minimum (1,000ft) is always
    # <= SINGLE_DEPLOY_MAX_ALT_FT, so single deploy always has at least one
    # real altitude regardless of site. Previously derived from pts["deploy"]
    # (compute_splash_points()'s own output), now a fixed literal since that
    # grid no longer feeds this function.
    deploys = ["dual", "single"]

    # Wind profile per hour/model -- the same build_profile_single() call
    # compute_splash_points() makes internally, just not fed into a drift
    # integration here. This is the entire per-hour/per-model dataset the
    # client needs to run simulateDrift() (app.js) for itself; everything
    # else in this JSON is projection scaling and sim constants. Looped over
    # WIND_PROFILE_HOURS_LOCAL (hourly, 9am-5pm), not the sparser
    # SPLASH_HOURS_LOCAL -- df already has every hour's data in memory (the
    # live pull fetches full hourly Open-Meteo data regardless), so this is
    # free: no extra network cost, just publishing more of what's already
    # been fetched. The map's time slider (app.js) can then land exactly on
    # any of these hours with no blending, only estimating the remaining
    # sub-hour gaps.
    wind_profiles = {}
    for h in config.WIND_PROFILE_HOURS_LOCAL:
        hdt = datetime.combine(target_date, dtime(h, 0))
        hour_profiles = {}
        for m in config.LIVE_PROFILE_MODELS:
            profile = build_profile_single(df, hdt, m, site_elev_ft, levels_mb)
            if len(profile) < 2:
                continue
            hour_profiles[m] = [[round(a), round(s, 2), round(d, 2)] for a, s, d in profile]
        if hour_profiles:
            wind_profiles[h] = hour_profiles
    # "hours" stays the weather panel's own sparse, curated set (its Clouds/
    # Rain/Wind/Temp columns are built directly off SPLASH_HOURS_LOCAL
    # elsewhere in this module, unaffected by the wider loop above) --
    # deliberately NOT every key wind_profiles now has, or that table would
    # balloon to 9 columns. "wind_hours" is the real, dense set the map's
    # slider actually reads for its tick marks/blend-bracketing -- see
    # profilesForTime() (app.js).
    hours = sorted(h for h in wind_profiles.keys() if h in config.SPLASH_HOURS_LOCAL)
    wind_hours = sorted(wind_profiles.keys())

    # ft_to_px() above is linear in x_ft/y_ft (no rotation/shear -- just an
    # equirectangular-ish local scale), so it reduces to px = site_px.x +
    # x_ft*scale.x, py = site_px.y - y_ft*scale.y (derived directly from
    # ft_to_px()'s own formula, not measured empirically). Exposing scale.x/
    # scale.y explicitly -- rather than making the viewer reverse-engineer
    # them from point pairs -- is what lets the boost-angle buffer move
    # client-side: the buffer polygon only depends on raw points + this
    # scale, not on anything else server-side, so the viewer can recompute
    # it live from a slider instead of the angle being fixed at whatever
    # this pull baked in. As of 2026-08 this is load-bearing for the whole
    # zone, not just the buffer -- the client derives every point's px/py
    # itself (simulateDrift() -> ftToPx()) since raw ft coordinates are no
    # longer pre-projected server-side at all.
    px_per_ft_x = (ft_to_m / m_per_deg_lon) / (lon_e - lon_w) * img_w
    px_per_ft_y = (ft_to_m / m_per_deg_lat) / (lat_n - lat_s) * img_h

    output = {
        "hours": [int(h) for h in hours], "wind_hours": [int(h) for h in wind_hours],
        "deploys": deploys, "altitudes": [int(a) for a in altitudes],
        "site_px": list(ft_to_px(0, 0)), "image_view_box": [0, 0, img_w, img_h],
        "wide_view_box": wide_view_box,
        "ft_to_px_scale": {"x": round(px_per_ft_x, 6), "y": round(px_per_ft_y, 6)},
        "boost_angle_deg": config.BOOST_ANGLE_OFF_VERTICAL_DEG,
        "max_pad_move_ft": config.SITES[site_id]["max_pad_move_ft"],
        # Published so the viewer can round-trip a dragged pad position as a
        # real GPS coordinate (permalink's `pad` param) instead of a raw ft
        # offset -- an offset alone breaks silently if this site's own
        # surveyed lat/lon is ever corrected later (has happened more than
        # once in this project's history), since the same offset would then
        # describe a different real spot. A GPS coordinate re-resolves
        # against whatever the CURRENT site_lat/site_lon is at load time,
        # so an old shared link still points at the same real ground spot.
        "site_lat": site_lat, "site_lon": site_lon,
        "wind_profiles": wind_profiles,
        # Everything app.js's simulateDrift()/zoneFor() need to reproduce
        # compute_splash_points()'s own phase construction and integration
        # exactly, client-side, at whatever rate the viewer's rate editor
        # currently has selected -- see config.py's default_rates_fps_payload()
        # and RATE_INPUT_LIMITS_FPS.
        "descent_params": {
            "site_elev_ft": round(site_elev_ft, 1),
            "main_deploy_altitude_ft": config.MAIN_DEPLOY_ALTITUDE_FT,
            "single_deploy_max_alt_ft": config.SINGLE_DEPLOY_MAX_ALT_FT,
            "descent_step_ft": config.DESCENT_STEP_FT,
            "default_rates_fps": config.default_rates_fps_payload(),
            "rate_limits_fps": {k: list(v) for k, v in config.RATE_INPUT_LIMITS_FPS.items()},
        },
    }

    # base_view_box sized from pts (still computed in run() regardless, to
    # feed points_history.json) WITHOUT building a hull per altitude: a
    # boost-angle buffer is a uniform-radius disc around each point, so its
    # axis-aligned extent is exactly the extent of that point's four
    # cardinal offsets (x+-radius,y) and (x,y+-radius) -- same result as
    # hull_of(buffered_points(...)) gave before, without the 12-point ring
    # or the hull computation. This box reflects the DEFAULT rates only
    # (pts was computed at config.DUAL_DEPLOY_RATES_FPS/SINGLE_DEPLOY_RATES_FPS);
    # a user dialing in a slower rate client-side can drift past it -- the
    # viewer grows (never shrinks) the box live from what it actually draws
    # (see app.js's growBaseViewBox()), so this is a starting point, not a
    # hard bound.
    all_x, all_y = [0, img_w], [0, img_h]
    for alt, sub in pts.groupby("altitude"):
        radius_ft = alt * math.tan(boost_angle_rad)
        for x_ft, y_ft in zip(sub["x_ft"], sub["y_ft"]):
            for bx, by in ((x_ft - radius_ft, y_ft), (x_ft + radius_ft, y_ft),
                           (x_ft, y_ft - radius_ft), (x_ft, y_ft + radius_ft)):
                px, py = ft_to_px(bx, by)
                all_x.append(px)
                all_y.append(py)

    pad = 80
    min_x, max_x = min(all_x) - pad, max(all_x) + pad
    min_y, max_y = min(all_y) - pad, max(all_y) + pad
    span = max(max_x - min_x, max_y - min_y)
    cx, cy = (min_x + max_x) / 2, (min_y + max_y) / 2
    output["base_view_box"] = [round(cx - span / 2, 1), round(cy - span / 2, 1), round(span, 1), round(span, 1)]

    return output


# --- Cloud cover, per model/hour (viewer's map-corner cloud panel) ---------
# Sourced from the same raw captured dataframe compute_splash_points() reads
# for wind, but never passed through it -- clouds don't feed the drift sim,
# they're a separate go/no-go signal (config.CLOUD_COVER_NOGO_PCT, Tripoli
# Unified Safety Code 9-5/9-6) that the viewer displays alongside it.

def build_cloud_data(df: pd.DataFrame, target_date: date) -> dict:
    """{model: {hour: {"total": .., "low": .., "mid": .., "high": ..}}} for
    the 6 LIVE_PROFILE_MODELS at each SPLASH_HOURS_LOCAL hour -- hour keyed
    as a plain int (JSON-serializes to a string key, but matches app.js's own
    HOUR_LABELS/DATA.hours convention, not a separate "HH:MM" format only
    this one field would use). NAM/NBM excluded here too, for consistency
    with the model set used everywhere else in the viewer (NBM in particular
    has no low/mid/high breakdown at all, only a blended total). A layer
    value is None when that model didn't report cloud data for that hour
    (beyond its forecast horizon), same "missing, not zero" convention
    build_profile_single() uses for wind."""
    layer_vars = {"total": "cloud_cover", "low": "cloud_cover_low", "mid": "cloud_cover_mid", "high": "cloud_cover_high"}
    out: dict[str, dict[int, dict[str, float | None]]] = {}
    for m in config.LIVE_PROFILE_MODELS:
        model_out = {}
        for h in config.SPLASH_HOURS_LOCAL:
            hdt = datetime.combine(target_date, dtime(h, 0))
            layer_out = {}
            for layer, var in layer_vars.items():
                cell = df[(df["valid_time_local"] == hdt) & (df["model"] == m) & (df["variable"] == var)]
                layer_out[layer] = int(round(cell["value"].iloc[0])) if len(cell) else None
            model_out[h] = layer_out
        out[m] = model_out
    return out


# --- Rain, per model/hour (viewer's above-map rain timeline) ---------------
# Same rationale as build_cloud_data() above: sourced from the raw captured
# dataframe, never passed through the drift sim -- rain doesn't move the
# splash zone, it's a separate go/no-go signal (can't fly in rain; wet
# fields/access roads can cancel a launch even on a dry launch day).

def build_rain_data(df: pd.DataFrame, target_date: date) -> dict:
    """{"prior_day": {model: cell}, "morning": {model: cell}, "hourly":
    {hour: {model: cell}}} where cell = {"amount": inches|None, "chance":
    pct|None}. hourly covers every hour from config.RAIN_WINDOW_START through
    END_HOUR_LOCAL inclusive (8am-5pm, 10 hours) -- finer-grained than
    pull_live_forecast.py's own CLI rain_stats() (which pairs hours into 4
    buckets around the SPLASH_HOURS_LOCAL sample points for a terse log
    line); the timeline wants each raw hour for a real "when does it clear
    up" read, not a compact summary.

    Restricted to LIVE_PROFILE_MODELS, same as build_cloud_data() -- the
    model set/color legend used everywhere else in the viewer, and it
    happens to remove one of the two models missing real
    precipitation_probability data on live Open-Meteo (NAM; ARPEGE is the
    remaining gap and reports "chance": None throughout).

    "chance" for the two aggregate cells (prior_day/morning, each spanning
    many hours) is the MAX hourly probability within that window, not a mean
    or sum -- summing percentages isn't meaningful, and a launch director
    cares whether the window ever carried real risk, not an average that
    undersells a short, sharp threat.

    "amount"/"chance" are both None (not 0) when a model reports no rows at
    all for that window -- same "missing, not zero" convention as
    build_cloud_data()'s layer values.
    """
    prior_day_start = datetime.combine(target_date - timedelta(days=1), dtime(0, 0))
    prior_day_end = datetime.combine(target_date, dtime(0, 0))
    morning_start = datetime.combine(target_date, dtime(0, 0))
    morning_end = datetime.combine(target_date, dtime(config.RAIN_WINDOW_START_HOUR_LOCAL, 0))
    hours = list(range(config.RAIN_WINDOW_START_HOUR_LOCAL, config.RAIN_WINDOW_END_HOUR_LOCAL + 1))

    def cell(m_df: pd.DataFrame, start: datetime, end: datetime) -> dict:
        w = m_df[(m_df["valid_time_local"] >= start) & (m_df["valid_time_local"] < end)]
        amt = w[w["variable"] == "precipitation"]
        prob = w[w["variable"] == "precipitation_probability"]
        return {
            "amount": round(float(amt["value"].sum()), 2) if len(amt) else None,
            "chance": int(round(prob["value"].max())) if len(prob) else None,
        }

    out: dict = {"prior_day": {}, "morning": {}, "hourly": {h: {} for h in hours}}
    for m in config.LIVE_PROFILE_MODELS:
        m_df = df[df["model"] == m]
        if m_df.empty:
            continue
        out["prior_day"][m] = cell(m_df, prior_day_start, prior_day_end)
        out["morning"][m] = cell(m_df, morning_start, morning_end)
        for h in hours:
            hdt = datetime.combine(target_date, dtime(h, 0))
            out["hourly"][h][m] = cell(m_df, hdt, hdt + timedelta(hours=1))
    return out


# --- Temperature, per model/hour (viewer's timeline, below the rain one) ---
# Same rationale as build_rain_data() above: sourced from the raw captured
# dataframe, never passed through the drift sim. Already pulled for every
# model (temperature_2m is in _hourly_variables()'s base list) and already
# used pipeline-side (window_stats()'s temp_min/temp_max for the CLI
# summary) -- this just publishes the same data to the viewer, not a new
# pull.
#
# Structurally simpler than build_rain_data(): temperature has no
# "chance"-equivalent second field (no probability concept the way rain
# has), and -- unlike rain amount or cloud % -- has no natural zero point,
# so there's no "confirmed zero" state to special-case. A cell here is just
# a plain Fahrenheit float (or None if a model reports no rows for that
# window), not a dict.

def build_temperature_data(df: pd.DataFrame, target_date: date) -> dict:
    """{"prior_day": {model: cell}, "morning": {model: cell}, "hourly":
    {hour: {model: cell}}} where cell = {"actual": degF|None, "apparent":
    degF|None}. hourly covers config.RAIN_WINDOW_START through
    END_HOUR_LOCAL inclusive (8am-5pm, 10 hours), same time axis as
    build_rain_data() so the two timelines line up. Each hourly cell is that
    single hour's own reading, not an aggregate (matches rain's hourly cells
    being one hour's own value).

    "apparent" is Open-Meteo's own apparent_temperature -- one combined
    "feels like" figure (folds in wind + humidity, not just temperature),
    covering both heat-index-when-hot and wind-chill-when-cold in a single
    number rather than needing two separate fields. Viewer defaults to
    showing this, with "actual" (raw temperature_2m) as a toggle-away
    option -- see app.js's renderTempTimeline().

    prior_day/morning use each window's MAX, not a mean -- multi-hour spans
    reduced to one number, and peak heat is the more safety-relevant read
    (gear/propellant left out, crew heat exposure) than an average that
    smooths over a spike. Same MAX treatment for "apparent" too, for the
    same reason.

    Restricted to LIVE_PROFILE_MODELS, same as build_rain_data()/
    build_cloud_data() -- the model set/color legend used everywhere else in
    the viewer.
    """
    prior_day_start = datetime.combine(target_date - timedelta(days=1), dtime(0, 0))
    prior_day_end = datetime.combine(target_date, dtime(0, 0))
    morning_start = datetime.combine(target_date, dtime(0, 0))
    morning_end = datetime.combine(target_date, dtime(config.RAIN_WINDOW_START_HOUR_LOCAL, 0))
    hours = list(range(config.RAIN_WINDOW_START_HOUR_LOCAL, config.RAIN_WINDOW_END_HOUR_LOCAL + 1))

    def window_max(m_df: pd.DataFrame, var: str, start: datetime, end: datetime) -> float | None:
        w = m_df[(m_df["variable"] == var) & (m_df["valid_time_local"] >= start) & (m_df["valid_time_local"] < end)]
        return round(float(w["value"].max()), 1) if len(w) else None

    def hour_value(m_df: pd.DataFrame, var: str, hdt: datetime) -> float | None:
        w = m_df[(m_df["variable"] == var) & (m_df["valid_time_local"] == hdt)]
        return round(float(w["value"].iloc[0]), 1) if len(w) else None

    out: dict = {"prior_day": {}, "morning": {}, "hourly": {h: {} for h in hours}}
    for m in config.LIVE_PROFILE_MODELS:
        m_df = df[df["model"] == m]
        if m_df.empty:
            continue
        out["prior_day"][m] = {
            "actual": window_max(m_df, "temperature", prior_day_start, prior_day_end),
            "apparent": window_max(m_df, "apparent_temperature", prior_day_start, prior_day_end),
        }
        out["morning"][m] = {
            "actual": window_max(m_df, "temperature", morning_start, morning_end),
            "apparent": window_max(m_df, "apparent_temperature", morning_start, morning_end),
        }
        for h in hours:
            hdt = datetime.combine(target_date, dtime(h, 0))
            out["hourly"][h][m] = {
                "actual": hour_value(m_df, "temperature", hdt),
                "apparent": hour_value(m_df, "apparent_temperature", hdt),
            }
    return out


# --- Wind, per model/hour (viewer's ground-level go/no-go row) -------------
# Same rationale as build_rain_data()/build_temperature_data() above:
# sourced from the raw captured dataframe, never passed through the drift
# sim. This is ground-level (10m AGL) wind specifically -- the number
# flyers/LCOs actually use as the go/no-go call (config.WIND_SPEED_NOGO_MPH,
# Tripoli USC 9-3) -- a separate, much simpler thing from the winds-aloft
# profile build_profile_single() already publishes for the drift sim.

def build_wind_data(df: pd.DataFrame, target_date: date) -> dict:
    """{"prior_day": {model: cell}, "morning": {model: cell}, "hourly":
    {hour: {model: cell}}} where cell = {"speed": mph|None, "gust": mph|None,
    "direction": deg|None}. hourly covers config.RAIN_WINDOW_START through
    END_HOUR_LOCAL inclusive (8am-4pm), same time axis as
    build_rain_data()/build_temperature_data() so all three line up.

    Sourced from the same level_type=="height" & level_value==10.0 filter
    build_profile_single() already uses for its own surface wind point.

    prior_day/morning cells use the window's MAX sustained speed (same
    "peak is the safety-relevant read" reasoning build_temperature_data()
    already established) -- gust/direction for those two aggregate cells
    are read from that SAME hour the max speed came from, not each field's
    own independent max, so one cell's three numbers always describe one
    real reading, never three cherry-picked from different hours.

    "speed"/"gust"/"direction" are each None (not 0) when a model reports
    no rows at all for that window -- same "missing, not zero" convention
    as build_cloud_data()/build_rain_data(). "gust" is None wherever a
    capture predates this field being pulled, or wherever a model simply
    never got asked for it -- gust doesn't exist at any level besides this
    one on Open-Meteo (confirmed live), so there's no fallback to reach for.

    Restricted to LIVE_PROFILE_MODELS, same as build_rain_data()/
    build_cloud_data()/build_temperature_data().

    Not clamped to gust >= speed even though that's true almost everywhere:
    confirmed directly against a real capture that GFS occasionally reports
    a lower gust than its own sustained speed at the same hour (e.g. 6.7mph
    gust vs 7.5mph speed) -- a real quirk of gust-parameterization products
    at low wind speeds, not a parsing bug here. Published as-is, model's own
    number, not silently "corrected" into something it didn't actually say.
    """
    prior_day_start = datetime.combine(target_date - timedelta(days=1), dtime(0, 0))
    prior_day_end = datetime.combine(target_date, dtime(0, 0))
    morning_start = datetime.combine(target_date, dtime(0, 0))
    morning_end = datetime.combine(target_date, dtime(config.RAIN_WINDOW_START_HOUR_LOCAL, 0))
    hours = list(range(config.RAIN_WINDOW_START_HOUR_LOCAL, config.RAIN_WINDOW_END_HOUR_LOCAL + 1))

    def surface(m_df: pd.DataFrame) -> pd.DataFrame:
        return m_df[(m_df["level_type"] == "height") & (m_df["level_value"] == 10.0)]

    def cell_at(w: pd.DataFrame, hdt) -> dict:
        def val(var: str) -> float | None:
            row = w[(w["variable"] == var) & (w["valid_time_local"] == hdt)]
            return round(float(row["value"].iloc[0]), 1) if len(row) else None
        return {"speed": val("wind_speed"), "gust": val("wind_gusts"), "direction": val("wind_direction")}

    def window_cell(m_df: pd.DataFrame, start: datetime, end: datetime) -> dict:
        w = surface(m_df)
        w = w[(w["valid_time_local"] >= start) & (w["valid_time_local"] < end)]
        spd = w[w["variable"] == "wind_speed"]
        if not len(spd):
            return {"speed": None, "gust": None, "direction": None}
        peak_time = spd.loc[spd["value"].idxmax(), "valid_time_local"]
        return cell_at(w, peak_time)

    def hour_cell(m_df: pd.DataFrame, hdt: datetime) -> dict:
        return cell_at(surface(m_df), hdt)

    out: dict = {"prior_day": {}, "morning": {}, "hourly": {h: {} for h in hours}}
    for m in config.LIVE_PROFILE_MODELS:
        m_df = df[df["model"] == m]
        if m_df.empty:
            continue
        out["prior_day"][m] = window_cell(m_df, prior_day_start, prior_day_end)
        out["morning"][m] = window_cell(m_df, morning_start, morning_end)
        for h in hours:
            hdt = datetime.combine(target_date, dtime(h, 0))
            out["hourly"][h][m] = hour_cell(m_df, hdt)
    return out


# --- Manifest (drives the viewer's launch-date selector) -------------------

def _latest_capture(target_dir: Path) -> date | None:
    caps = []
    for p in target_dir.glob("captured_*.parquet"):
        try:
            caps.append(date.fromisoformat(p.stem.removeprefix("captured_")))
        except ValueError:
            continue
    return max(caps) if caps else None


def _all_captures(target_dir: Path) -> list[date]:
    caps = []
    for p in target_dir.glob("captured_*.parquet"):
        try:
            caps.append(date.fromisoformat(p.stem.removeprefix("captured_")))
        except ValueError:
            continue
    return sorted(caps)


# --- History view (per-model splash point across every capture date, not
# just the latest) -- called "History" in the viewer, deliberately not
# "drift" (which already names the wind-drift calc this tool descends from,
# Driftcast). Simplified relative to the main hull/zone view: one point per
# model per capture date -- no wind speed/direction-by-altitude, no
# hull/buffer, just where each model's splash point for one fixed
# hour/deploy/rate/altitude landed, and how that moved capture to capture.

def build_points_history(target_dir: Path, target_date: date, site_id: str = "hutto") -> dict:
    """Backfills splash_points_captured_<date>.parquet for any capture under
    `target_dir` that doesn't have one yet (a capture only gets its points
    computed when this function -- or run(), which calls it -- processes
    it; older captures pulled before this feature existed haven't been
    computed at all), then bundles every capture's points into one lookup
    keyed by hour_deploy_rate_altitude, so the viewer's History mode can
    pull a whole capture-to-capture series with one lookup instead of one
    fetch per day."""
    captures = _all_captures(target_dir)
    current_altitudes = set(config.altitudes_for_site(site_id))
    current_rates = set(config.SINGLE_DEPLOY_RATES_FPS) | set(config.DUAL_DEPLOY_RATES_FPS)
    site_elev_ft = config.elev_ft_for_site(site_id)
    levels_mb = config.levels_mb_for_site(site_id)
    frames = []
    wind_profiles_by_capture: dict[str, dict] = {}
    for capture_date in captures:
        # T-0's own row should reflect "what did the forecast look like
        # before launch" (the frozen morning snapshot pull_live_forecast.py
        # writes when a T-0 pull lands before MORNING_SNAPSHOT_HOUR_LOCAL --
        # see save_capture()'s comment), not whatever the ongoing same-day
        # file has since been overwritten to by a pull hours after flying
        # was done. Only capture_date == target_date can even have a
        # same-day overwrite at all -- T-1..T-7 rows are one capture per
        # day regardless, so this never applies to them. Older target dates
        # captured before this feature existed have no _morning file, so
        # they silently keep the prior (ongoing-file) behavior.
        suffix = "_morning" if capture_date == target_date and (target_dir / f"captured_{capture_date}_morning.parquet").exists() else ""
        df = pd.read_parquet(target_dir / f"captured_{capture_date}{suffix}.parquet")

        points_path = target_dir / f"splash_points_captured_{capture_date}{suffix}.parquet"
        pts = pd.read_parquet(points_path) if points_path.exists() else None
        # A stored points parquet is keyed by whatever altitude ladder/rate
        # names were current when it was written -- recompute when either no
        # longer matches config, or points_history.json ends up ragged across
        # captures (History mode would show a single-point series for any
        # altitude only the newest capture has, or silently drop a rate whose
        # name changed -- exactly what happened when SINGLE_DEPLOY_RATES_FPS's
        # keys were renamed "10fps"/"20fps" -> "slow"/"fast", 2026-08). Every
        # site's old level bracket already reached its waiver in MSL terms, so
        # an altitude-ladder change never extrapolates past the stored wind
        # profile -- only coarseness changes, which build_profile_single()/
        # interp() already handle.
        if pts is None or set(pts["altitude"].unique()) != current_altitudes or not set(pts["rate"].unique()) <= current_rates:
            pts = compute_splash_points(df, target_date, site_id)
            pts.to_parquet(points_path)
        pts = pts.copy()
        pts["capture_date"] = str(capture_date)
        frames.append(pts)

        # This capture's own wind profile, same shape build_viewer_data()
        # publishes for the live/latest capture (including the same
        # WIND_PROFILE_HOURS_LOCAL hourly density, not the sparser
        # SPLASH_HOURS_LOCAL) -- lets the viewer simulate a History point at
        # any altitude AND any time client-side (the map's time slider), not
        # just the discrete ladder compute_splash_points() precomputed into
        # points_by_key above. Cheap to rebuild every run: captured_*.parquet
        # is tens of KB, and the payload win from the client-side migration
        # was in the *precomputed point grid*, not the raw profile -- so
        # there's no separate staleness check to maintain here, unlike pts
        # above. A capture pulled before WIND_PROFILE_HOURS_LOCAL existed
        # still only has its original sparse hours here (this loop can't
        # invent data captured_*.parquet never had) -- the client's slider
        # falls back gracefully per-capture, same as it does for the current
        # live capture.
        hour_profiles: dict[str, dict] = {}
        for h in config.WIND_PROFILE_HOURS_LOCAL:
            hdt = datetime.combine(target_date, dtime(h, 0))
            model_profiles = {}
            for m in config.LIVE_PROFILE_MODELS:
                profile = build_profile_single(df, hdt, m, site_elev_ft, levels_mb)
                if len(profile) >= 2:
                    model_profiles[m] = profile
            if model_profiles:
                hour_profiles[str(h)] = model_profiles
        wind_profiles_by_capture[str(capture_date)] = hour_profiles

    points_by_key: dict[str, list[dict]] = {}
    if frames:
        all_pts = pd.concat(frames, ignore_index=True)
        for (hour, deploy, rate, altitude), sub in all_pts.groupby(["hour", "deploy", "rate", "altitude"]):
            key = f"{hour}_{deploy}_{rate}_{altitude}"
            rows = sub.sort_values("capture_date")
            points_by_key[key] = [
                {"capture_date": r.capture_date, "model": r.model, "x_ft": round(r.x_ft, 1), "y_ft": round(r.y_ft, 1)}
                for r in rows.itertuples()
            ]

    actuals, actual_wind_profile = compute_actual_points(site_id, target_date)
    return {
        "target_date": str(target_date),
        "captures": [str(c) for c in captures],
        "points_by_key": points_by_key,
        "wind_profiles_by_capture": wind_profiles_by_capture,
        # HRRR-analysis-based best-guess (compute_actual_points()) if
        # pull_historical.py has backfilled this site/date -- {} otherwise
        # (most target dates won't have it yet). Real post-flight GPS
        # (spec.md Phase 3, not built) would replace this under the same key
        # scheme once that lands, not need a second one. Only precomputed at
        # the discrete ladder's own altitudes (same as points_by_key) -- a
        # "Specific altitude" override has no actual/star marker to show,
        # same tri-state UX users already see on dates with no actuals at all.
        "actuals": actuals,
        # The raw profile behind the points above -- {} whenever actuals is
        # too (same backfill gate). Lets the viewer run its own
        # simulateDriftPath() and plot the actual flight as a real
        # apogee-to-ground path (3D) rather than only a landing point (2D's
        # existing star, unaffected by this -- see actuals above), at ANY
        # altitude/rate, not just the discrete ladder actuals itself is
        # limited to.
        "actual_wind_profile": actual_wind_profile,
    }


def _format_label(target_date: date, capture_date: date) -> str:
    lead = (target_date - capture_date).days
    lead_str = f"T-{lead}" if lead > 0 else "T-0"
    return f"{target_date:%a, %b %-d} ({lead_str})"


def regenerate_manifest(site_id: str, published_live_dir: Path) -> Path:
    """Rescan site/data/<site_id>/live/*/ for each target date's latest
    capture's zone JSON.

    This is "the list on our side that updates the html" -- the viewer never
    lists a directory itself; it only ever reads this file, which we rebuild
    every time splash_zones.py processes a target date for this site.
    """
    entries = []
    for target_dir in sorted(published_live_dir.iterdir()) if published_live_dir.exists() else []:
        if not target_dir.is_dir():
            continue
        target_date = date.fromisoformat(target_dir.name)
        zone_paths = sorted(target_dir.glob("splash_zones_captured_*.json"))
        if not zone_paths:
            continue
        capture_date = max(date.fromisoformat(p.stem.removeprefix("splash_zones_captured_")) for p in zone_paths)
        history_path = target_dir / "points_history.json"
        # Usually zero or one real flight per date, but a site can fly more
        # than one rocket the same day (see tripoli_houston_south's
        # 2026-07-25) -- glob rather than assume a single fixed filename.
        # Sorted for a deterministic marker order in the viewer.
        real_flight_paths = sorted((published_live_dir.parent / "real_flights").glob(f"{target_date}*_summary.json"))
        entries.append({
            "target_date": str(target_date),
            "capture_date": str(capture_date),
            "lead_days": (target_date - capture_date).days,
            "label": _format_label(target_date, capture_date),
            "data_path": f"data/{site_id}/live/{target_date}/splash_zones_captured_{capture_date}.json",
            "history_path": f"data/{site_id}/live/{target_date}/points_history.json" if history_path.exists() else None,
            "real_flight_paths": [f"data/{site_id}/real_flights/{p.name}" for p in real_flight_paths],
        })
    # Descending -- the viewer's date <select> lists these in this order and
    # defaults to entries[0] (see loadSiteManifest() in app.js), so this is
    # what makes "load the site" default to the soonest upcoming launch
    # (or, in the gap after one's passed and before the next enters the
    # pull window, the most recent one) instead of the oldest backfilled date.
    entries.sort(key=lambda e: e["target_date"], reverse=True)
    manifest = {"site_id": site_id, "generated_at": datetime.now().isoformat(timespec="seconds"), "launch_dates": entries}
    out_path = published_live_dir.parent / "manifest.json"
    with open(out_path, "w") as f:
        json.dump(manifest, f, indent=2)
    return out_path


def run(target_date: date, site_id: str = "hutto") -> None:
    pipeline_dir = Path(config.DATA_DIR) / site_id / "live" / str(target_date)
    capture_date = _latest_capture(pipeline_dir)
    if capture_date is None:
        raise FileNotFoundError(f"no captured_*.parquet under {pipeline_dir}")

    df = pd.read_parquet(pipeline_dir / f"captured_{capture_date}.parquet")
    pts = compute_splash_points(df, target_date, site_id)
    points_path = pipeline_dir / f"splash_points_captured_{capture_date}.parquet"
    pts.to_parquet(points_path)

    with open(config.SITE_DIR / "maps" / site_id / "site.json") as f:
        site_meta = json.load(f)
    zone_data = build_viewer_data(df, pts, site_meta, site_id, target_date)

    zone_data["clouds"] = build_cloud_data(df, target_date)
    zone_data["cloud_relevant_layers"] = config.CLOUD_LAYERS_BY_SITE[site_id]
    zone_data["cloud_nogo_pct"] = config.CLOUD_COVER_NOGO_PCT

    zone_data["rain"] = build_rain_data(df, target_date)
    zone_data["temperature"] = build_temperature_data(df, target_date)
    zone_data["wind"] = build_wind_data(df, target_date)
    zone_data["wind_nogo_mph"] = config.WIND_SPEED_NOGO_MPH

    # config.BURN_BAN_COUNTY_BY_SITE is authoritative here, not just "does a
    # _burnban.json file exist" -- captures pulled before the per-site fix
    # landed have a real file for every site, including KS/SD ones, stamped
    # with Williamson County's result (the old bug: one hardcoded county
    # checked for every site regardless of where it actually was). A site
    # absent from that dict always publishes {"supported": False}, even if a
    # stale pre-fix file is sitting right there on disk.
    if site_id not in config.BURN_BAN_COUNTY_BY_SITE:
        zone_data["burn_ban"] = {"supported": False}
    else:
        # Not every capture has a burn-ban file (older captures predate the
        # feature entirely) -- None here means "checked, but we don't know,"
        # same tri-state pull_live_forecast.run() already established.
        # counties_under_ban (all ~90 Texas counties currently listed) is
        # dropped -- useful for pipeline-side debugging, not something the
        # viewer needs to ship publicly.
        burn_ban_path = pipeline_dir / f"captured_{capture_date}_burnban.json"
        # A file that exists but contains literal `null` is real, not a bug
        # to guard against here -- save_capture() writes whatever burn_ban
        # it was given unconditionally, including None from run()'s own
        # "the check itself failed" case, so the file existing doesn't
        # guarantee real content. Same tri-state either way: unknown.
        raw_burn_ban = json.loads(burn_ban_path.read_text()) if burn_ban_path.exists() else None
        if raw_burn_ban is None:
            zone_data["burn_ban"] = None
        else:
            zone_data["burn_ban"] = {k: v for k, v in raw_burn_ban.items() if k != "counties_under_ban"}

    published_live_dir = config.SITE_DIR / "data" / site_id / "live" / str(target_date)
    published_live_dir.mkdir(parents=True, exist_ok=True)
    zone_path = published_live_dir / f"splash_zones_captured_{capture_date}.json"
    with open(zone_path, "w") as f:
        json.dump(zone_data, f)

    history = build_points_history(pipeline_dir, target_date, site_id)
    history_path = published_live_dir / "points_history.json"
    with open(history_path, "w") as f:
        json.dump(history, f)

    manifest_path = regenerate_manifest(site_id, published_live_dir.parent)
    fetch_site_maps.refresh_regional_sites_metadata()

    n_profiles = sum(len(models) for models in zone_data["wind_profiles"].values())
    print(f"[{site_id}] target {target_date} (capture {capture_date}, T-{(target_date - capture_date).days}): "
          f"{len(pts)} points -> pipeline/{points_path.relative_to(Path(config.DATA_DIR).parent)}, "
          f"{n_profiles} wind profiles across {len(zone_data['wind_profiles'])} hours -> "
          f"site/{zone_path.relative_to(config.SITE_DIR)}")
    print(f"history: {len(history['captures'])} capture(s) ({', '.join(history['captures'])}) -> "
          f"site/{history_path.relative_to(config.SITE_DIR)}")

    print("models contributing per hour (of the 6 in config.LIVE_PROFILE_MODELS):")
    for h in config.WIND_PROFILE_HOURS_LOCAL:
        models_present = sorted(pts[pts["hour"] == h]["model"].unique())
        missing = [m for m in config.LIVE_PROFILE_MODELS if m not in models_present]
        print(f"  {h}:00 -- {len(models_present)}/6 present: {models_present}" + (f"  (missing: {missing})" if missing else ""))

    print(f"manifest -> site/{manifest_path.relative_to(config.SITE_DIR)} "
          f"({len(json.load(open(manifest_path))['launch_dates'])} launch dates listed)")
    print("regional site-picker has_data flags refreshed")


if __name__ == "__main__":
    import argparse

    parser = argparse.ArgumentParser()
    parser.add_argument("target_date", type=date.fromisoformat)
    parser.add_argument("--site", default="hutto", choices=list(config.SITES))
    args = parser.parse_args()
    run(args.target_date, args.site)
