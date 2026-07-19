"""Wind capture -> splash-zone viewer data, for index.html.

Two stages (see config.py for the shared constants):
  1. compute_splash_points(): wind capture parquet -> per-model/hour/altitude/
     deploy/rate drift points (apogee-to-ground descent integration).
  2. build_zone_data(): drift points -> convex-hull zones in map-pixel space
     (core hull + boost-angle-buffered hull), the exact JSON schema the
     viewer's render()/drawZone() expect.

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
from datetime import date, datetime, timezone
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

    Surface 10m wind anchors the bottom; each of `levels_mb` (this site's own
    pressure-level bracket -- config.levels_mb_for_site(), sized to its
    waiver) except 1000mb (its standard-atm height is unreliable this close
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

    Models with fewer than 2 usable profile points at a given hour (i.e. beyond
    that model's forecast horizon at this lead time) are skipped for that
    hour -- this is the mechanism that naturally drops short-horizon models
    (e.g. HRRR) at longer lead times without any lead-time-specific logic here.

    Altitudes are per-site (config.altitudes_for_site()), not one fixed list
    for every site -- a 10,000ft-waiver site and a 50,000ft-waiver site need
    very different apogees simulated. Pressure levels sampled for the wind
    profile are likewise per-site (config.levels_mb_for_site()), sized to
    reach each site's own waiver. Single-deploy points are skipped above
    config.SINGLE_DEPLOY_MAX_ALT_FT -- not a realistic recovery configuration
    at higher altitude (see that constant's own comment in config.py).
    """
    site_elev_ft = config.elev_ft_for_site(site_id)
    levels_mb = config.levels_mb_for_site(site_id)
    all_points = []
    for h in config.SPLASH_HOURS_LOCAL:
        hdt = datetime.combine(target_date, dtime(h, 0))
        for m in config.LIVE_PROFILE_MODELS:
            profile = build_profile_single(df, hdt, m, site_elev_ft, levels_mb)
            if len(profile) < 2:
                continue
            for alt in config.altitudes_for_site(site_id):
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
# assimilation output, not a forecast) at every SPLASH_HOURS_LOCAL hour for
# a past target date -- the closest this project has to "what actually
# happened" absent real post-flight GPS (see build_points_history()'s
# comment on points_history.json's actuals key). The two functions below
# turn that raw pull into the same kind of simulated point every forecast
# gets, so the viewer's star marker has something real to show.
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


def compute_actual_points(site_id: str, target_date: date) -> dict[str, dict]:
    """One simulated point per hour/deploy/rate/altitude -- same grid
    compute_splash_points() iterates, just against the single HRRR-analysis
    profile per hour instead of every live model -- keyed exactly like
    points_by_key so the viewer can look either up the same way. Returns {}
    if pull_historical.py hasn't pulled this site/date yet (most target
    dates won't have this -- it's a manually-run backfill, not part of the
    daily live-pull path)."""
    raw_path = Path(config.DATA_DIR) / site_id / "raw" / f"{target_date}_actual.parquet"
    if not raw_path.exists():
        return {}
    raw = pd.read_parquet(raw_path)
    site_elev_ft = config.elev_ft_for_site(site_id)
    actuals = {}
    for h in config.SPLASH_HOURS_LOCAL:
        # raw["valid_time"] is UTC-naive (straight from the GRIB2 files via
        # Herbie, which does no timezone conversion) -- NOT local like the
        # live pull's "valid_time_local" column build_profile_single() reads
        # elsewhere. h is a local hour (config.SPLASH_HOURS_LOCAL), so it has
        # to go through the same local->UTC conversion pull_historical.py's
        # target_valid_time() already does, or every lookup here would
        # silently match nothing.
        hdt_utc = datetime.combine(target_date, dtime(h, 0), tzinfo=_SITE_TZ).astimezone(timezone.utc).replace(tzinfo=None)
        hour_df = raw[raw["valid_time"] == hdt_utc]
        if hour_df.empty:
            continue
        profile = build_actual_profile(hour_df, site_elev_ft)
        if len(profile) < 2:
            continue
        for alt in config.altitudes_for_site(site_id):
            if alt <= config.SINGLE_DEPLOY_MAX_ALT_FT:
                for rate_name, rate in config.SINGLE_DEPLOY_RATES_FPS.items():
                    x, y = simulate(profile, float(alt), [(rate, float(alt), 0)], site_elev_ft)
                    actuals[f"{h}_single_{rate_name}_{alt}"] = {"x_ft": round(float(x), 1), "y_ft": round(float(y), 1)}
            for rate_name, (drogue, main) in config.DUAL_DEPLOY_RATES_FPS.items():
                phases = [(drogue, float(alt), config.MAIN_DEPLOY_ALTITUDE_FT), (main, config.MAIN_DEPLOY_ALTITUDE_FT, 0)]
                x, y = simulate(profile, float(alt), phases, site_elev_ft)
                actuals[f"{h}_dual_{rate_name}_{alt}"] = {"x_ft": round(float(x), 1), "y_ft": round(float(y), 1)}
    return actuals


def hull_of(points_xy: list[tuple[float, float]]) -> list[list[float]]:
    arr = np.array(points_xy)
    if len(arr) < 3:
        return arr.tolist()
    try:
        h = ConvexHull(arr)
        return arr[h.vertices].tolist()
    except Exception:
        return arr.tolist()


def buffered_points(points_xy: list[tuple[float, float]], radius_ft: float, n: int = 12) -> list[tuple[float, float]]:
    out = []
    for x, y in points_xy:
        for i in range(n):
            theta = 2 * math.pi * i / n
            out.append((x + radius_ft * math.cos(theta), y + radius_ft * math.sin(theta)))
    return out


def build_zone_data(pts: pd.DataFrame, site_meta: dict) -> dict:
    """Drift points -> the exact JSON schema index.html's DATA expects."""
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
    hours = sorted(pts["hour"].unique())
    deploys = sorted(pts["deploy"].unique())
    altitudes = sorted(pts["altitude"].unique())

    # ft_to_px() above is linear in x_ft/y_ft (no rotation/shear -- just an
    # equirectangular-ish local scale), so it reduces to px = site_px.x +
    # x_ft*scale.x, py = site_px.y - y_ft*scale.y (derived directly from
    # ft_to_px()'s own formula, not measured empirically). Exposing scale.x/
    # scale.y explicitly -- rather than making the viewer reverse-engineer
    # them from point pairs -- is what lets the boost-angle buffer move
    # client-side: the buffer polygon only depends on raw points + this
    # scale, not on anything else server-side, so the viewer can recompute
    # it live from a slider instead of the angle being fixed at whatever
    # this pull baked in.
    px_per_ft_x = (ft_to_m / m_per_deg_lon) / (lon_e - lon_w) * img_w
    px_per_ft_y = (ft_to_m / m_per_deg_lat) / (lat_n - lat_s) * img_h

    output = {
        "hours": [int(h) for h in hours], "deploys": deploys, "altitudes": [int(a) for a in altitudes],
        "site_px": list(ft_to_px(0, 0)), "image_view_box": [0, 0, img_w, img_h],
        "wide_view_box": wide_view_box,
        "ft_to_px_scale": {"x": round(px_per_ft_x, 6), "y": round(px_per_ft_y, 6)},
        "boost_angle_deg": config.BOOST_ANGLE_OFF_VERTICAL_DEG,
        "data": {},
    }

    all_x, all_y = [0, img_w], [0, img_h]

    for h in hours:
        for dep in deploys:
            key = f"{h}_{dep}"
            zones = []
            for alt in altitudes:
                sub = pts[(pts["hour"] == h) & (pts["deploy"] == dep) & (pts["altitude"] == alt)]
                if sub.empty:
                    continue
                raw_xy = list(zip(sub["x_ft"], sub["y_ft"]))
                core_hull_px = [list(ft_to_px(x, y)) for x, y in hull_of(raw_xy)]

                radius_ft = alt * math.tan(boost_angle_rad)
                buffer_hull_px = [list(ft_to_px(x, y)) for x, y in hull_of(buffered_points(raw_xy, radius_ft))]
                for x, y in buffer_hull_px:
                    all_x.append(x)
                    all_y.append(y)

                points_out = []
                for _, row in sub.iterrows():
                    px, py = ft_to_px(row["x_ft"], row["y_ft"])
                    all_x.append(px)
                    all_y.append(py)
                    points_out.append({
                        "model": row["model"], "rate": row["rate"],
                        "x_ft": round(row["x_ft"], 1), "y_ft": round(row["y_ft"], 1),
                        "px": round(px, 1), "py": round(py, 1),
                    })

                zones.append({
                    "altitude": int(alt),
                    "core_hull_px": [[round(x, 1), round(y, 1)] for x, y in core_hull_px],
                    "buffer_hull_px": [[round(x, 1), round(y, 1)] for x, y in buffer_hull_px],
                    "buffer_radius_ft": round(radius_ft, 1),
                    "points": points_out,
                })
            output["data"][key] = zones

    pad = 80
    min_x, max_x = min(all_x) - pad, max(all_x) + pad
    min_y, max_y = min(all_y) - pad, max(all_y) + pad
    span = max(max_x - min_x, max_y - min_y)
    cx, cy = (min_x + max_x) / 2, (min_y + max_y) / 2
    output["base_view_box"] = [round(cx - span / 2, 1), round(cy - span / 2, 1), round(span, 1), round(span, 1)]

    return output


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
    frames = []
    for capture_date in captures:
        points_path = target_dir / f"splash_points_captured_{capture_date}.parquet"
        if not points_path.exists():
            df = pd.read_parquet(target_dir / f"captured_{capture_date}.parquet")
            pts = compute_splash_points(df, target_date, site_id)
            pts.to_parquet(points_path)
        else:
            pts = pd.read_parquet(points_path)
        pts = pts.copy()
        pts["capture_date"] = str(capture_date)
        frames.append(pts)

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

    return {
        "target_date": str(target_date),
        "captures": [str(c) for c in captures],
        "points_by_key": points_by_key,
        # HRRR-analysis-based best-guess (compute_actual_points()) if
        # pull_historical.py has backfilled this site/date -- {} otherwise
        # (most target dates won't have it yet). Real post-flight GPS
        # (spec.md Phase 3, not built) would replace this under the same key
        # scheme once that lands, not need a second one.
        "actuals": compute_actual_points(site_id, target_date),
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
        entries.append({
            "target_date": str(target_date),
            "capture_date": str(capture_date),
            "lead_days": (target_date - capture_date).days,
            "label": _format_label(target_date, capture_date),
            "data_path": f"data/{site_id}/live/{target_date}/splash_zones_captured_{capture_date}.json",
            "history_path": f"data/{site_id}/live/{target_date}/points_history.json" if history_path.exists() else None,
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
    zone_data = build_zone_data(pts, site_meta)

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

    print(f"[{site_id}] target {target_date} (capture {capture_date}, T-{(target_date - capture_date).days}): "
          f"{len(pts)} points -> pipeline/{points_path.relative_to(Path(config.DATA_DIR).parent)}, "
          f"{len(zone_data['data'])} zone groups -> site/{zone_path.relative_to(config.SITE_DIR)}")
    print(f"history: {len(history['captures'])} capture(s) ({', '.join(history['captures'])}) -> "
          f"site/{history_path.relative_to(config.SITE_DIR)}")

    print("models contributing per hour (of the 6 in config.LIVE_PROFILE_MODELS):")
    for h in config.SPLASH_HOURS_LOCAL:
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
