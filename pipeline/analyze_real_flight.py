"""Compare a real GPS-tracked flight against this pipeline's own forecasts/actuals.

Two halves, deliberately kept separate:
  1. The reusable core below: flight segmentation (apogee/main-deploy),
     ground-referenced descent-rate derivation, wind-time interpolation,
     re-simulation via splash_zones.simulate(), and comparison against
     published forecasts/hulls -- independent of what tracker format the
     raw samples came from.
  2. Tracker-specific loaders (see load_deluxe_tracker_csv() at the bottom):
     turn one specific raw export format into the plain FlightSample list
     the core consumes. Each tracker/export format needs its own small
     loader like this until there's a standard format to write one general
     parser against -- expect these to multiply/get replaced, unlike the
     core above.

Raw tracker logs (per-second GPS/telemetry, potentially identifying of a
specific flier) are never published -- see pipeline/data/actuals/ in
.gitignore. Only this script's derived summary JSON is.
"""

import json
import math
import os
from dataclasses import dataclass
from datetime import date, datetime
from pathlib import Path

import pandas as pd

import config
import splash_zones as sz


@dataclass
class FlightSample:
    t: datetime
    agl_ft: float
    lat: float
    lon: float
    horzv_fps: float = 0.0
    heading_deg: float = 0.0
    vertv_fps: float | None = None  # if the tracker reports it directly; derived from agl_ft deltas otherwise


# --- Reusable core -----------------------------------------------------------

def _vertv(samples: list[FlightSample], i: int) -> float:
    if samples[i].vertv_fps is not None:
        return samples[i].vertv_fps
    if i == 0:
        return 0.0
    dt = (samples[i].t - samples[i - 1].t).total_seconds()
    return (samples[i - 1].agl_ft - samples[i].agl_ft) / dt if dt > 0 else 0.0


def find_apogee_index(samples: list[FlightSample]) -> int:
    return max(range(len(samples)), key=lambda i: samples[i].agl_ft)


def find_liftoff_index(samples: list[FlightSample], ground_agl_baseline: float, apogee_idx: int, threshold_ft: float = 150.0) -> int:
    """Last sample before apogee that's still within threshold_ft of the
    ground-level baseline -- an approximation of "moment of launch," since
    trackers often lose or degrade their fix right at liftoff (vibration,
    rapid acceleration) so the true first instant of motion is rarely a
    clean fix to point to directly."""
    idx = 0
    for i in range(apogee_idx):
        if samples[i].agl_ft - ground_agl_baseline < threshold_ft:
            idx = i
    return idx


def boost_angle_from_vertical(apogee_offset_dist_ft: float, apogee_agl_ft: float) -> float:
    """Angle (deg) between vertical and the line from the pad to apogee --
    the real-flight equivalent of config.BOOST_ANGLE_OFF_VERTICAL_DEG,
    measured directly from GPS rather than assumed. A sanity check on that
    config value, not something to recalibrate it from off a single flight."""
    return math.degrees(math.atan2(apogee_offset_dist_ft, apogee_agl_ft))


def find_main_deploy_index(samples: list[FlightSample], apogee_idx: int) -> int | None:
    """First index after apogee where the descent rate settles onto a
    slower regime. Looks for a sustained (3-sample) drop below 65% of the
    trailing 6-sample baseline rate -- the real transition eases over a
    sample or two rather than a single sharp cliff, so a bare threshold
    crossing false-triggers on noise."""
    for i in range(apogee_idx + 7, len(samples) - 3):
        baseline = sum(abs(_vertv(samples, j)) for j in range(i - 6, i)) / 6
        if baseline <= 40:
            continue
        if all(abs(_vertv(samples, j)) < baseline * 0.65 for j in range(i, i + 3)):
            return i
    return None


def implied_ground_rate(samples: list[FlightSample], site_elev_ft: float) -> tuple[float, float, float]:
    """(mean, min, max) ground-level-equivalent descent rate (fps) for a
    segment, inverting splash_zones.air_density_ratio() point-by-point
    (avg altitude between consecutive samples) rather than assuming one
    flat rate for the whole segment -- matches how the sim itself scales
    rate continuously with altitude, not in one jump."""
    rates = []
    ground_rho = sz.air_density_ratio(site_elev_ft / 3.28084)
    for a, b in zip(samples, samples[1:]):
        dt = (b.t - a.t).total_seconds()
        if dt <= 0:
            continue
        observed_rate = (a.agl_ft - b.agl_ft) / dt
        if observed_rate <= 0:
            continue
        mid_alt_agl = (a.agl_ft + b.agl_ft) / 2
        rho_here = sz.air_density_ratio((mid_alt_agl + site_elev_ft) / 3.28084)
        rates.append(observed_rate * math.sqrt(rho_here / ground_rho))
    return sum(rates) / len(rates), min(rates), max(rates)


def segment_between_altitudes(samples: list[FlightSample], lo_agl: float, hi_agl: float) -> list[FlightSample]:
    return [s for s in samples if lo_agl <= s.agl_ft <= hi_agl]


def check_density_scaling(drogue_segment: list[FlightSample], main_deploy_agl: float, site_elev_ft: float,
                           early_skip_ft: float = 300.0, early_window_ft: float = 2000.0,
                           late_skip_ft: float = 250.0, late_window_ft: float = 2000.0) -> dict | None:
    """Compares the drogue phase's implied ground-equivalent rate measured
    early (soon after the chute's fully inflated and stable, skipping the
    initial apogee transient where the rocket is still transitioning out of
    flight) against late (just before main, skipping a buffer for main's
    own inflation blending into the reading) -- if the air-density scaling
    this pipeline uses (splash_zones.air_density_ratio()/descent_rate_at(),
    a pure v ~ 1/sqrt(density) model) is right, these two should come out
    close to each other despite being measured at very different altitudes
    (and so very different air densities), since normalizing that
    difference out is the entire point of the scaling. A real, systematic
    gap between them would suggest the model doesn't fully hold, not just
    measurement noise -- None if there isn't enough of the drogue phase to
    split into two clean, non-overlapping windows.
    """
    apogee_agl = drogue_segment[0].agl_ft
    early = segment_between_altitudes(drogue_segment, apogee_agl - early_skip_ft - early_window_ft, apogee_agl - early_skip_ft)
    late = segment_between_altitudes(drogue_segment, main_deploy_agl + late_skip_ft, main_deploy_agl + late_skip_ft + late_window_ft)
    if len(early) < 3 or len(late) < 3:
        return None
    early_rate, early_lo, early_hi = implied_ground_rate(early, site_elev_ft)
    late_rate, late_lo, late_hi = implied_ground_rate(late, site_elev_ft)
    return {
        "early_drogue": {
            "mean_ground_equivalent_fps": round(early_rate, 1), "range": [round(early_lo, 1), round(early_hi, 1)],
            "altitude_range_agl_ft": [round(min(s.agl_ft for s in early)), round(max(s.agl_ft for s in early))],
            "n_samples": len(early),
        },
        "late_drogue": {
            "mean_ground_equivalent_fps": round(late_rate, 1), "range": [round(late_lo, 1), round(late_hi, 1)],
            "altitude_range_agl_ft": [round(min(s.agl_ft for s in late)), round(max(s.agl_ft for s in late))],
            "n_samples": len(late),
        },
        "pct_difference": round(abs(early_rate - late_rate) / ((early_rate + late_rate) / 2) * 100, 1),
    }


def latlon_to_ft(lat: float, lon: float, pad_lat: float, pad_lon: float) -> tuple[float, float]:
    """(x_ft east, y_ft north) offset from (pad_lat, pad_lon) -- same
    equirectangular-ish local-scale convention build_zone_data() uses."""
    m_per_deg_lat = 111320
    m_per_deg_lon = 111320 * math.cos(math.radians(pad_lat))
    x_ft = (lon - pad_lon) * m_per_deg_lon / 0.3048
    y_ft = (lat - pad_lat) * m_per_deg_lat / 0.3048
    return x_ft, y_ft


def extrapolate_touchdown(last: FlightSample, ground_agl_baseline: float, main_ground_rate: float) -> tuple[float, float, float]:
    """(lat, lon, seconds_extrapolated) for the point where the tracker's
    own AGL scale would read `ground_agl_baseline` -- most trackers don't
    have a real fix right at touchdown, so this projects forward from the
    last real one using its own heading/horizontal speed. Pass the
    tracker's real measured ground-level AGL reading as the baseline, not
    0 -- its own "AGL" zero-point is whatever it was calibrated/reset to,
    which is often offset from true ground level by tens of feet."""
    remaining_agl = last.agl_ft - ground_agl_baseline
    remaining_time_s = remaining_agl / main_ground_rate
    heading_rad = math.radians(last.heading_deg)
    dx_ft = last.horzv_fps * remaining_time_s * math.sin(heading_rad)
    dy_ft = last.horzv_fps * remaining_time_s * math.cos(heading_rad)
    m_per_deg_lat = 111320
    m_per_deg_lon = 111320 * math.cos(math.radians(last.lat))
    lat = last.lat + (dy_ft * 0.3048) / m_per_deg_lat
    lon = last.lon + (dx_ft * 0.3048) / m_per_deg_lon
    return lat, lon, remaining_time_s


def circular_blend(d0: float, d1: float, w: float) -> float:
    diff = ((d1 - d0 + 180) % 360) - 180
    return (d0 + w * diff) % 360


def blend_wind_profiles(profile_a: list[tuple[float, float, float]], profile_b: list[tuple[float, float, float]], weight_b: float) -> list[tuple[float, float, float]]:
    """Blend two (agl_ft, speed_mph, dir_deg) profiles (e.g. the bracketing
    SPLASH_HOURS_LOCAL actual/analysis samples either side of a real launch
    time) by altitude level, weighted `weight_b` toward profile_b. Only
    levels present in both are kept -- both sides come from the same
    HRRR-analysis pull, so in practice the level sets always match."""
    a_by_alt = {round(alt, 1): (s, d) for alt, s, d in profile_a}
    b_by_alt = {round(alt, 1): (s, d) for alt, s, d in profile_b}
    blended = []
    for alt in sorted(set(a_by_alt) & set(b_by_alt)):
        s0, d0 = a_by_alt[alt]
        s1, d1 = b_by_alt[alt]
        blended.append((alt, s0 + weight_b * (s1 - s0), circular_blend(d0, d1, weight_b)))
    return blended


def pct_of_actual_drift(delta_ft: float, actual_dist_ft: float) -> float | None:
    """Delta as a percentage of how far the wind actually carried the rocket
    that day -- the same framing the History accuracy table uses (500ft
    reads very differently against a 3,500ft actual drift than against a
    500ft one). None if the actual drift itself was ~0 (percentage isn't
    meaningful against a near-zero denominator)."""
    return round(delta_ft / actual_dist_ft * 100, 1) if actual_dist_ft > 1 else None


def point_in_polygon(x: float, y: float, poly: list[list[float]]) -> bool:
    inside = False
    n = len(poly)
    for i in range(n):
        x0, y0 = poly[i]
        x1, y1 = poly[(i + 1) % n]
        if ((y0 > y) != (y1 > y)) and (x < (x1 - x0) * (y - y0) / (y1 - y0) + x0):
            inside = not inside
    return inside


def _delta(x_ft: float, y_ft: float, real_x_ft: float, real_y_ft: float, real_dist_ft: float) -> dict:
    d = math.hypot(x_ft - real_x_ft, y_ft - real_y_ft)
    return {"ft": round(d, 1), "pct_of_actual_drift": pct_of_actual_drift(d, real_dist_ft)}


def compare_to_pipeline(site_id: str, target_date: date, real_x_ft: float, real_y_ft: float, real_dist_ft: float, altitude_bucket: int, hour_buckets: tuple[int, ...] = (11, 13)) -> dict:
    """Distances (both absolute ft and as a % of the real drift distance --
    500ft reads very differently at a 3,500ft actual drift than at a 500ft
    one) from the real GPS landing point to: each model's own T-0 forecast
    (what would have actually been available before/during the flight), the
    HRRR-analysis "actual" proxy (retrospective-only -- it needs a day for
    HRRR's own archive to finish publishing, so it was never a real-time
    predictor), and whether the real point falls inside the published core
    hull (all models/both rates, the default combined view) at the closest
    altitude bucket."""
    hist_path = config.SITE_DIR / "data" / site_id / "live" / str(target_date) / "points_history.json"
    zone_path = config.SITE_DIR / "data" / site_id / "live" / str(target_date) / f"splash_zones_captured_{target_date}.json"
    hist = json.loads(hist_path.read_text())
    zone_data = json.loads(zone_path.read_text())

    result = {"t0_model_forecasts": {}, "hrrr_analysis_actual_proxy": {}, "within_published_core_hull": {}}
    for hb in hour_buckets:
        zones = zone_data["data"].get(f"{hb}_dual", [])
        zone = next((z for z in zones if z["altitude"] == altitude_bucket), None)
        if zone:
            hull_ft = sz.hull_of([(p["x_ft"], p["y_ft"]) for p in zone["points"]])
            result["within_published_core_hull"][str(hb)] = point_in_polygon(real_x_ft, real_y_ft, hull_ft)
        for deploy, rate in [("dual", "fast"), ("dual", "slow")]:
            key = f"{hb}_{deploy}_{rate}_{altitude_bucket}"
            per_model = {
                pt["model"]: _delta(pt["x_ft"], pt["y_ft"], real_x_ft, real_y_ft, real_dist_ft)
                for pt in hist["points_by_key"].get(key, [])
                if pt["capture_date"] == str(target_date)
            }
            if per_model:
                result["t0_model_forecasts"][key] = per_model
            actual_pt = hist["actuals"].get(key)
            if actual_pt:
                result["hrrr_analysis_actual_proxy"][key] = _delta(actual_pt["x_ft"], actual_pt["y_ft"], real_x_ft, real_y_ft, real_dist_ft)
    return result


def write_summary(out_path: str, summary: dict) -> None:
    os.makedirs(os.path.dirname(out_path), exist_ok=True)
    with open(out_path, "w") as f:
        json.dump(summary, f, indent=2)


def analyze(site_id: str, target_date: date, samples: list[FlightSample], ground_agl_baseline: float, wind_hour_a: int = 11, wind_hour_b: int = 13, altitude_bucket: int | None = None) -> dict:
    """Full pipeline: segment the flight, derive real rates, blend the real
    wind profile to the real launch time, re-simulate, and compare against
    everything already published for this site/date. `samples` must already
    be filtered to the actual flight window (see the tracker-specific loader
    for how -- this function doesn't know how to find "launch" in a longer
    log on its own)."""
    site = config.SITES[site_id]
    site_elev_ft = config.elev_ft_for_site(site_id)
    pad_lat, pad_lon = site["lat"], site["lon"]

    apogee_idx = find_apogee_index(samples)
    apogee = samples[apogee_idx]
    liftoff = samples[find_liftoff_index(samples, ground_agl_baseline, apogee_idx)]
    main_deploy_idx = find_main_deploy_index(samples, apogee_idx)
    if main_deploy_idx is None:
        raise ValueError("couldn't find a main-deploy changepoint -- inspect the flight data manually")
    main_deploy = samples[main_deploy_idx]
    last = samples[-1]

    # Real launch-rail GPS position -- separate from the pad's *configured*
    # lat/lon in config.SITES, which is a surveyed/estimated point, not
    # necessarily exactly where this specific rail sat. Every model point
    # and the splash zone itself are still anchored to the configured pad,
    # not this -- shown only so a real offset between the two is visible,
    # not auto-corrected anywhere.
    liftoff_x_ft, liftoff_y_ft = latlon_to_ft(liftoff.lat, liftoff.lon, pad_lat, pad_lon)
    liftoff_dist_ft = math.hypot(liftoff_x_ft, liftoff_y_ft)

    drogue_segment = samples[apogee_idx:main_deploy_idx + 1]
    drogue_rate, dg_lo, dg_hi = implied_ground_rate(drogue_segment, site_elev_ft)
    main_rate, mg_lo, mg_hi = implied_ground_rate(samples[main_deploy_idx:], site_elev_ft)
    density_scaling_check = check_density_scaling(drogue_segment, main_deploy.agl_ft, site_elev_ft)

    land_lat, land_lon, extrap_s = extrapolate_touchdown(last, ground_agl_baseline, main_rate)
    real_x_ft, real_y_ft = latlon_to_ft(land_lat, land_lon, pad_lat, pad_lon)
    real_dist_ft = math.hypot(real_x_ft, real_y_ft)

    apogee_x_ft, apogee_y_ft = latlon_to_ft(apogee.lat, apogee.lon, pad_lat, pad_lon)
    apogee_dist_ft = math.hypot(apogee_x_ft, apogee_y_ft)
    boost_angle_deg = boost_angle_from_vertical(apogee_dist_ft, apogee.agl_ft)

    # Real wind profile, blended between the two bracketing HRRR-analysis
    # hours to the real launch time.
    raw_path = Path(config.DATA_DIR) / site_id / "raw" / f"{target_date}_actual.parquet"
    raw = pd.read_parquet(raw_path)
    hdt_a = sz.datetime.combine(target_date, sz.dtime(wind_hour_a, 0), tzinfo=sz._SITE_TZ).astimezone(sz.timezone.utc).replace(tzinfo=None)
    hdt_b = sz.datetime.combine(target_date, sz.dtime(wind_hour_b, 0), tzinfo=sz._SITE_TZ).astimezone(sz.timezone.utc).replace(tzinfo=None)
    profile_a = sz.build_actual_profile(raw[raw["valid_time"] == hdt_a], site_elev_ft)
    profile_b = sz.build_actual_profile(raw[raw["valid_time"] == hdt_b], site_elev_ft)
    span_s = (datetime.combine(date.min, sz.dtime(wind_hour_b, 0)) - datetime.combine(date.min, sz.dtime(wind_hour_a, 0))).total_seconds()
    launch_offset_s = (apogee.t - datetime.combine(apogee.t.date(), sz.dtime(wind_hour_a, 0))).total_seconds()
    weight_b = max(0.0, min(1.0, launch_offset_s / span_s))
    blended_profile = blend_wind_profiles(profile_a, profile_b, weight_b)

    phases = [(drogue_rate, apogee.agl_ft, main_deploy.agl_ft), (main_rate, main_deploy.agl_ft, 0)]
    sim_x, sim_y = sz.simulate(blended_profile, apogee.agl_ft, phases, site_elev_ft)
    descent_only_delta = _delta(sim_x, sim_y, real_x_ft, real_y_ft, real_dist_ft)

    total_x, total_y = apogee_x_ft + sim_x, apogee_y_ft + sim_y
    boost_adjusted_delta = _delta(total_x, total_y, real_x_ft, real_y_ft, real_dist_ft)

    if altitude_bucket is None:
        altitudes = config.altitudes_for_site(site_id)
        altitude_bucket = min(altitudes, key=lambda a: abs(a - apogee.agl_ft))
    comparison = compare_to_pipeline(site_id, target_date, real_x_ft, real_y_ft, real_dist_ft, altitude_bucket, (wind_hour_a, wind_hour_b))
    # Whichever bracketing hour the real launch was closer to -- lets a
    # client pick one "delta from actual" figure to show by default (deploy
    # is always "dual" here; this module only handles two-rate flights so far)
    # instead of needing to know both hour_a/hour_b exist.
    closest_hour = wind_hour_a if weight_b < 0.5 else wind_hour_b

    return {
        "site_id": site_id,
        "target_date": str(target_date),
        "deploy": "dual",
        "closest_hour": closest_hour,
        "launch": {
            "time_local": liftoff.t.strftime("%H:%M:%S.%f")[:-3],
            "offset_from_pad_ft": {"x": round(liftoff_x_ft, 1), "y": round(liftoff_y_ft, 1), "dist": round(liftoff_dist_ft, 1)},
        },
        "apogee": {
            "time_local": apogee.t.strftime("%H:%M:%S.%f")[:-3],
            "altitude_agl_ft": round(apogee.agl_ft, 1),
            "offset_from_pad_ft": {"x": round(apogee_x_ft, 1), "y": round(apogee_y_ft, 1), "dist": round(apogee_dist_ft, 1)},
            "boost_angle_from_vertical_deg": round(boost_angle_deg, 2),
            "configured_boost_angle_deg": config.BOOST_ANGLE_OFF_VERTICAL_DEG,
            # Distinguishes this from analyze_no_gps()'s apogee position,
            # which is *inferred* (from the real landing point + an assumed-
            # accurate wind sim), not measured -- see that function's own
            # docstring. Real per-sample GPS here, same as the rest of this
            # flight's track.
            "position_source": "gps_measured",
        },
        "main_deploy": {"time_local": main_deploy.t.strftime("%H:%M:%S.%f")[:-3], "altitude_agl_ft": round(main_deploy.agl_ft, 1)},
        "descent_rates_ground_equivalent_fps": {
            "drogue": {"mean": round(drogue_rate, 1), "range": [round(dg_lo, 1), round(dg_hi, 1)]},
            "main": {"mean": round(main_rate, 1), "range": [round(mg_lo, 1), round(mg_hi, 1)]},
            "configured_dual_deploy_fps": config.DUAL_DEPLOY_RATES_FPS,
        },
        # Sanity check on air_density_ratio()/descent_rate_at()'s scaling
        # itself (see check_density_scaling()'s own docstring) -- None if
        # the drogue phase was too short to split into two clean windows.
        "density_scaling_check": density_scaling_check,
        "landing": {
            "lat": round(land_lat, 6), "lon": round(land_lon, 6),
            "offset_from_pad_ft": {"x": round(real_x_ft, 1), "y": round(real_y_ft, 1), "dist": round(real_dist_ft, 1)},
            "note": f"extrapolated {extrap_s:.1f}s past the last real GPS fix ({last.agl_ft:.0f}ft on the tracker's own AGL scale, "
                    f"vs a measured ~{ground_agl_baseline:.0f}ft ground-level baseline on that same scale) using its own heading/horizontal speed",
        },
        # This flight's own predicted landing: real measured boost-phase
        # drift (apogee's own GPS offset from the pad) plus simulated
        # wind-only descent drift (real apogee + real derived rates + the
        # blended real wind profile above) -- i.e. what this specific
        # flight's own numbers predict, not a generic fast/slow preset. In
        # the same pad-relative ft coordinates as `landing` above, so a
        # client can plot both on the same map.
        "predicted_landing_offset_from_pad_ft": {"x": round(float(total_x), 1), "y": round(float(total_y), 1)},
        "delta_from_predictions": {
            "self_simulated_descent_only": descent_only_delta,
            "self_simulated_boost_adjusted": boost_adjusted_delta,
            "altitude_bucket_used_ft": altitude_bucket,
            **comparison,
        },
    }


def analyze_no_gps(site_id: str, target_date: date, samples: list[FlightSample],
                    rail_lat: float, rail_lon: float, landing_lat: float, landing_lon: float,
                    wind_hour_a: int = 11, wind_hour_b: int = 13, altitude_bucket: int | None = None) -> dict:
    """Same reusable core as analyze() -- segmentation, ground-referenced
    descent-rate derivation, wind-time blending, re-simulation, scoring --
    for altimeters with no GPS at all (e.g. a BlueRaven; see
    load_blueraven_lr_csv()). `samples` carry real barometric altitude/time
    only -- lat/lon are unused placeholders, since find_apogee_index()/
    find_liftoff_index()/find_main_deploy_index()/implied_ground_rate()/
    check_density_scaling() only ever touch .t/.agl_ft. Real launch-rail and
    landing positions come from hand-recorded GPS pins passed in directly
    (a phone/handheld reading at the pad and at the recovery site), since
    there's no track to derive them from.

    Without a real apogee GPS fix, boost-phase drift can't be *measured* --
    it's *estimated* here, by assuming the wind-only descent simulation
    (real apogee altitude + real derived rates + the real wind profile for
    the actual flight time) is accurate, and backing the difference out of
    the real recorded landing point. This holds regardless of where apogee
    actually was, because the wind model varies only with altitude, not
    horizontal position -- descent drift is ~translation-invariant. That
    estimate is clearly flagged (apogee.position_source) and drives both the
    map's apogee marker AND predicted_landing_offset_from_pad_ft (estimated
    apogee + the same descent sim) -- which means, by construction,
    predicted_landing_offset_from_pad_ft always lands exactly on the real
    recorded landing point. That's intentional: it's a self-consistency
    check on the reconstructed picture (rail -> estimated apogee -> real
    wind descent -> landing), not an independent prediction, so there's no
    self_simulated_* accuracy figure in delta_from_predictions for this kind
    of flight -- publishing one here would just be circular, not a real
    accuracy check. The T-0 model-forecast comparisons (compare_to_pipeline())
    remain fully independent and are the only real scoring available."""
    site = config.SITES[site_id]
    site_elev_ft = config.elev_ft_for_site(site_id)
    pad_lat, pad_lon = site["lat"], site["lon"]

    apogee_idx = find_apogee_index(samples)
    apogee = samples[apogee_idx]
    liftoff = samples[find_liftoff_index(samples, 0.0, apogee_idx)]
    main_deploy_idx = find_main_deploy_index(samples, apogee_idx)
    if main_deploy_idx is None:
        raise ValueError("couldn't find a main-deploy changepoint -- inspect the flight data manually")
    main_deploy = samples[main_deploy_idx]

    # Real hand-recorded GPS, both relative to the *configured* site pad --
    # same convention analyze() uses for launch/landing, so this stays
    # comparable against every published model point/hull (all anchored to
    # that same configured pad, not wherever this specific rail really was).
    rail_x_ft, rail_y_ft = latlon_to_ft(rail_lat, rail_lon, pad_lat, pad_lon)
    rail_dist_ft = math.hypot(rail_x_ft, rail_y_ft)
    real_x_ft, real_y_ft = latlon_to_ft(landing_lat, landing_lon, pad_lat, pad_lon)
    real_dist_ft = math.hypot(real_x_ft, real_y_ft)

    drogue_segment = samples[apogee_idx:main_deploy_idx + 1]
    drogue_rate, dg_lo, dg_hi = implied_ground_rate(drogue_segment, site_elev_ft)
    main_rate, mg_lo, mg_hi = implied_ground_rate(samples[main_deploy_idx:], site_elev_ft)
    density_scaling_check = check_density_scaling(drogue_segment, main_deploy.agl_ft, site_elev_ft)

    # Real wind profile, blended between the two bracketing HRRR-analysis
    # hours to the real apogee time -- same as analyze().
    raw_path = Path(config.DATA_DIR) / site_id / "raw" / f"{target_date}_actual.parquet"
    raw = pd.read_parquet(raw_path)
    hdt_a = sz.datetime.combine(target_date, sz.dtime(wind_hour_a, 0), tzinfo=sz._SITE_TZ).astimezone(sz.timezone.utc).replace(tzinfo=None)
    hdt_b = sz.datetime.combine(target_date, sz.dtime(wind_hour_b, 0), tzinfo=sz._SITE_TZ).astimezone(sz.timezone.utc).replace(tzinfo=None)
    profile_a = sz.build_actual_profile(raw[raw["valid_time"] == hdt_a], site_elev_ft)
    profile_b = sz.build_actual_profile(raw[raw["valid_time"] == hdt_b], site_elev_ft)
    span_s = (datetime.combine(date.min, sz.dtime(wind_hour_b, 0)) - datetime.combine(date.min, sz.dtime(wind_hour_a, 0))).total_seconds()
    launch_offset_s = (apogee.t - datetime.combine(apogee.t.date(), sz.dtime(wind_hour_a, 0))).total_seconds()
    weight_b = max(0.0, min(1.0, launch_offset_s / span_s))
    blended_profile = blend_wind_profiles(profile_a, profile_b, weight_b)

    phases = [(drogue_rate, apogee.agl_ft, main_deploy.agl_ft), (main_rate, main_deploy.agl_ft, 0)]
    sim_x, sim_y = sz.simulate(blended_profile, apogee.agl_ft, phases, site_elev_ft)

    # Estimated apogee position, relative to the configured pad -- built from
    # the real rail GPS, the real BlueRaven data through apogee (real apogee
    # altitude + real derived descent rates, which is everything sim_x/sim_y
    # depends on), and the real recorded landing point. Solving
    # rail_offset + boost_drift + sim = real_landing for boost_drift and
    # adding it back to rail_offset is algebraically identical to just
    # real_landing - sim (rail_offset cancels out of that sum) -- so this
    # already incorporates the rail GPS correctly without needing to
    # reference it explicitly here.
    est_x, est_y = float(real_x_ft - sim_x), float(real_y_ft - sim_y)
    est_dist_ft = math.hypot(est_x, est_y)
    estimated_boost_angle_deg = math.degrees(math.atan2(est_dist_ft, apogee.agl_ft))

    # Predicted landing = estimated apogee + the same wind-only descent sim
    # used to derive that estimate -- by construction this lands exactly on
    # the real landing point (est_x/est_y was solved specifically to make it
    # do so), so it's a self-consistency check on the reconstructed picture
    # (rail -> estimated apogee -> real wind descent -> landing), not an
    # independent accuracy score. See delta_from_predictions below -- there's
    # deliberately no self_simulated_* accuracy figure for this reason; the
    # T-0 model-forecast comparisons remain the only real scoring here.
    pred_x, pred_y = float(est_x + sim_x), float(est_y + sim_y)

    if altitude_bucket is None:
        altitudes = config.altitudes_for_site(site_id)
        altitude_bucket = min(altitudes, key=lambda a: abs(a - apogee.agl_ft))
    comparison = compare_to_pipeline(site_id, target_date, real_x_ft, real_y_ft, real_dist_ft, altitude_bucket, (wind_hour_a, wind_hour_b))
    closest_hour = wind_hour_a if weight_b < 0.5 else wind_hour_b

    return {
        "site_id": site_id,
        "target_date": str(target_date),
        "deploy": "dual",
        "closest_hour": closest_hour,
        "launch": {
            "time_local": liftoff.t.strftime("%H:%M:%S.%f")[:-3],
            "offset_from_pad_ft": {"x": round(rail_x_ft, 1), "y": round(rail_y_ft, 1), "dist": round(rail_dist_ft, 1)},
        },
        "apogee": {
            "time_local": apogee.t.strftime("%H:%M:%S.%f")[:-3],
            "altitude_agl_ft": round(apogee.agl_ft, 1),
            "offset_from_pad_ft": {"x": round(est_x, 1), "y": round(est_y, 1), "dist": round(est_dist_ft, 1)},
            "boost_angle_from_vertical_deg": round(estimated_boost_angle_deg, 2),
            "configured_boost_angle_deg": config.BOOST_ANGLE_OFF_VERTICAL_DEG,
            "position_source": "estimated_from_landing_and_wind_model",
            "position_estimation_note": (
                "No GPS on this altimeter -- this position is *inferred*, not measured: it "
                "assumes the descent-only wind simulation (real apogee altitude + real derived "
                "descent rates + the real wind profile for this flight's actual time of day) is "
                "accurate, then backs the boost-phase offset out of the difference between that "
                "simulation and the real recorded landing point. predicted_landing_offset_from_pad_ft "
                "is this same estimated apogee plus that same descent sim, so it lands exactly on the "
                "real landing point by construction -- a self-consistency check on the reconstructed "
                "flight, not an independent prediction (see delta_from_predictions, which has no "
                "self-simulated accuracy figure for this flight for the same reason)."
            ),
        },
        "main_deploy": {"time_local": main_deploy.t.strftime("%H:%M:%S.%f")[:-3], "altitude_agl_ft": round(main_deploy.agl_ft, 1)},
        "descent_rates_ground_equivalent_fps": {
            "drogue": {"mean": round(drogue_rate, 1), "range": [round(dg_lo, 1), round(dg_hi, 1)]},
            "main": {"mean": round(main_rate, 1), "range": [round(mg_lo, 1), round(mg_hi, 1)]},
            "configured_dual_deploy_fps": config.DUAL_DEPLOY_RATES_FPS,
        },
        "density_scaling_check": density_scaling_check,
        "landing": {
            "lat": round(landing_lat, 6), "lon": round(landing_lon, 6),
            "offset_from_pad_ft": {"x": round(real_x_ft, 1), "y": round(real_y_ft, 1), "dist": round(real_dist_ft, 1)},
            "note": "Hand-recorded GPS pin at the recovery site (this altimeter has no onboard GPS) -- not extrapolated from a track.",
        },
        # Estimated apogee + descent sim -- lands exactly on the real
        # landing point by construction. See the docstring above.
        "predicted_landing_offset_from_pad_ft": {"x": round(pred_x, 1), "y": round(pred_y, 1)},
        "delta_from_predictions": {
            "altitude_bucket_used_ft": altitude_bucket,
            **comparison,
        },
    }


# --- Tracker-specific loaders (expect more of these / replacements later) ---

def load_deluxe_tracker_csv(path: str, flight_start_after: str, ground_baseline_window: tuple[str, str]) -> tuple[list[FlightSample], float]:
    """One specific tracker export's CSV schema (TRACKER/DATE/TIME, GS Lat/
    Lon, TRACKER Lat/Lon/Alt asl, FIX, HORZV, VERTV, HEAD, Alt AGL (ft), ...)
    -- combined/compiled from multiple tracker sources into one file per the
    user, not a standard format. Expect this function (or a sibling one) to
    be replaced once there's a standard export format to write a general
    loader against; nothing above this point depends on its specific column
    names.

    flight_start_after: "HH:MM[:SS]" -- only rows at/after this time are
    considered (the raw log spans a long pre-launch idle period this isn't
    meant to search through automatically; a glitchy low-FIX-quality fix
    during that wait can otherwise look like a plausible false apogee).
    ground_baseline_window: (start, end) "HH:MM:SS" -- window shortly before
    liftoff to average for the tracker's own ground-level AGL reading (its
    "AGL" zero-point is whatever it was calibrated/reset to, often offset
    from true ground level by tens of feet -- confirmed on the first real
    flight run through this: a stable ~76ft plateau right before liftoff,
    distinct from a noisier near-zero plateau several minutes earlier that
    turned out to be a stale calibration state, not the real one).
    """
    import csv

    rows = list(csv.DictReader(open(path)))
    for r in rows:
        r["_t"] = datetime.strptime(r["TIME"], "%H:%M:%S.%f")
        r["_agl"] = float(r["Alt AGL (ft)"])
        r["_fix"] = int(r["FIX"])

    start_t = datetime.strptime(flight_start_after, "%H:%M:%S" if flight_start_after.count(":") == 2 else "%H:%M")
    flight_rows = [r for r in rows if r["_t"] >= start_t and r["_fix"] == 3]
    samples = [
        FlightSample(
            t=r["_t"], agl_ft=r["_agl"], lat=float(r["TRACKER Lat"]), lon=float(r["TRACKER Lon"]),
            horzv_fps=float(r["HORZV"]), heading_deg=float(r["HEAD"]), vertv_fps=float(r["VERTV"]),
        )
        for r in flight_rows
    ]

    win_start, win_end = (datetime.strptime(t, "%H:%M:%S") for t in ground_baseline_window)
    baseline_rows = [r for r in rows if win_start <= r["_t"] < win_end and r["_fix"] == 3]
    ground_agl_baseline = sum(r["_agl"] for r in baseline_rows) / len(baseline_rows)

    return samples, ground_agl_baseline


def load_blueraven_lr_csv(path: str) -> list[FlightSample]:
    """A BlueRaven altimeter's low-rate ("LR") export -- no GPS at all (see
    analyze_no_gps(), which this feeds instead of analyze()). agl_ft comes
    straight from the onboard barometer (Baro_Altitude_AGL_(feet)), already
    zeroed to the pad on power-up -- unlike the Deluxe tracker's own AGL
    scale, no separate ground-baseline window is needed to find true zero.
    lat/lon are 0.0 placeholders: analyze_no_gps() never reads them (real
    launch-rail/landing positions come from hand-recorded GPS pins passed in
    separately, not derived from a track).

    Deliberately does NOT touch this format's own onboard inertial-
    navigation fields (Inertial_Altitude/Inertial_DR_Position/
    Inertial_CR_position/Velocity_Up) -- BlueRaven's own user manual
    documents that these lose accuracy once the rocket's rotation rate
    exceeds the gyro's +-2000 deg/sec measurement range (common right around
    apogee/deployment), and it's not just a documented risk: checked
    directly against a real flight's raw high-rate gyro data, confirmed
    exactly that failure at apogee, and confirmed the corruption cascades
    into Velocity_Up too (BlueRaven's own summary-reported descent rates are
    downstream of that same channel) -- so this loader relies on the
    barometer alone throughout, same as it's used for the reliable altitude
    profile in every other tracker format this module supports.

    Decimated to ~1 sample/sec: the LR export itself runs much faster (50Hz
    on the flight this loader was built against), but find_main_deploy_index()'s
    windowing (a 6-sample trailing baseline, 3-sample confirmation, +7-sample
    post-apogee skip) is tuned against the Deluxe tracker's own roughly-1Hz
    cadence -- run against it undecimated, apogee's near-zero-crossing
    vertical-velocity noise (amplified right at apogee here specifically by
    the same attitude/tumble instability documented above) false-triggered a
    "main deploy" a fraction of a second after apogee instead of the real
    one two minutes later. Decimating instead of reworking those windows to
    be rate-aware keeps every tracker format feeding the shared core the
    same implicit sample-rate contract, rather than risking a change to
    logic the GPS-tracked path also depends on."""
    import csv

    rows = list(csv.DictReader(open(path)))
    samples = [
        FlightSample(
            t=datetime.strptime(f"{r['Year']}-{r['Month']}-{r['Day']} {r['Time']}", "%Y-%m-%d %H:%M:%S.%f"),
            agl_ft=float(r["Baro_Altitude_AGL_(feet)"]),
            lat=0.0, lon=0.0,
        )
        for r in rows
    ]
    sample_interval_s = (samples[1].t - samples[0].t).total_seconds()
    step = max(1, round(1.0 / sample_interval_s))
    return samples[::step]


if __name__ == "__main__":
    import argparse

    def out_path_for(site, target_date, explicit):
        return explicit or str(config.SITE_DIR / "data" / site / "real_flights" / f"{target_date}_summary.json")

    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="tracker", required=True)

    p_deluxe = sub.add_parser("deluxe", help="GPS-tracked flight (Deluxe-format CSV) -- full boost+descent reconstruction")
    p_deluxe.add_argument("csv_path")
    p_deluxe.add_argument("--site", required=True, choices=list(config.SITES))
    p_deluxe.add_argument("--date", required=True, type=date.fromisoformat)
    p_deluxe.add_argument("--flight-start-after", required=True, help="HH:MM or HH:MM:SS -- skip the pre-launch idle period in the raw log")
    p_deluxe.add_argument("--baseline-window", nargs=2, required=True, metavar=("START", "END"), help="HH:MM:SS HH:MM:SS -- window right before liftoff to measure the tracker's own ground-level AGL reading")
    p_deluxe.add_argument("--out", default=None)

    p_br = sub.add_parser("blueraven", help="No-GPS altimeter (BlueRaven LR export) -- apogee/rates only, real launch/landing come from hand-recorded GPS pins")
    p_br.add_argument("lr_csv_path")
    p_br.add_argument("--site", required=True, choices=list(config.SITES))
    p_br.add_argument("--date", required=True, type=date.fromisoformat)
    p_br.add_argument("--rail-lat", required=True, type=float)
    p_br.add_argument("--rail-lon", required=True, type=float)
    p_br.add_argument("--landing-lat", required=True, type=float)
    p_br.add_argument("--landing-lon", required=True, type=float)
    p_br.add_argument("--out", default=None)

    args = parser.parse_args()

    out_path = out_path_for(args.site, args.date, args.out)

    if args.tracker == "deluxe":
        samples, ground_baseline = load_deluxe_tracker_csv(args.csv_path, args.flight_start_after, tuple(args.baseline_window))
        summary = analyze(args.site, args.date, samples, ground_baseline)
        write_summary(out_path, summary)
        headline = summary["delta_from_predictions"]["self_simulated_boost_adjusted"]
        print(f"apogee {summary['apogee']['altitude_agl_ft']}ft, "
              f"landing {summary['landing']['offset_from_pad_ft']['dist']}ft from pad, "
              f"boost-adjusted error {headline['ft']}ft ({headline['pct_of_actual_drift']}% of actual drift)")
    else:
        samples = load_blueraven_lr_csv(args.lr_csv_path)
        summary = analyze_no_gps(args.site, args.date, samples, args.rail_lat, args.rail_lon, args.landing_lat, args.landing_lon)
        write_summary(out_path, summary)
        apogee = summary["apogee"]
        print(f"apogee {summary['apogee']['altitude_agl_ft']}ft, "
              f"landing {summary['landing']['offset_from_pad_ft']['dist']}ft from pad, "
              f"estimated boost angle {apogee['boost_angle_from_vertical_deg']} deg off vertical "
              f"(estimated apogee offset {apogee['offset_from_pad_ft']['dist']}ft -- no GPS on this flight, "
              f"see apogee.position_estimation_note; no self-simulated accuracy figure, "
              f"see delta_from_predictions -- only the T-0 model-forecast comparisons are independent scoring here)")
    print(f"-> {out_path}")
