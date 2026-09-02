"""Grid-edge accuracy check: for one site/model sitting near a corner of its
weather model's own grid cell, does a decided-in-advance BLEND of the
surrounding grid cells forecast more accurately than the single cell
Open-Meteo actually snapped to?

Follow-up spike to grid_position_report.py's finding that 34 of 60 site/
model combinations sit within 15% of a grid-cell edge (7 of them within 15%
on BOTH axes -- a true corner, bordering 3 neighbor cells instead of 1).
Read-only: doesn't touch the live pipeline, the app's forecast math, or any
site coordinate.

IMPORTANT METHODOLOGY NOTE (v2 of this script): the first version compared
each neighbor cell SEPARATELY and reported whichever one happened to land
closest to the actual -- a hindsight pick that overstates what's achievable
in real time, since which neighbor is "best" isn't knowable in advance.
This version instead builds ONE deterministic candidate -- a bilinear-
weighted blend of the own cell + its 3 neighbors, weighted purely by the
site's geometric %x/%y position within its cell (grid_position_report.py's
own numbers, decided before any forecast or actual data is looked at) -- and
compares THAT single candidate against the own cell alone. The old hindsight
numbers are still reported for context but are explicitly not the verdict.
We can't shift which cell we query without guessing (no way to know in
advance which neighbor would be closer) -- blending is the only
decidable-in-advance lever available.

Default test case: hearne/ecmwf (pct_x=1.0%, pct_y=94.5% -- right at the
corner shared with 3 neighbors), chosen because it's the only corner case
with a real HRRR-analysis "actual" already pulled for every one of its
historical target dates -- no backfill needed to start (see
pull_historical.py --actual-only for the other flagged sites, which mostly
aren't covered yet).

Methodology, per historical target date:
  1. "Own cell": the REAL forecast this app actually published --
     build_profile_single() against whichever captured_*.parquet is latest
     on disk for that target (splash_zones.py's own _latest_capture() --
     usually T-0, but the daily pull can silently stop early before some
     launches; see analyze_real_flight.py's own nearest_altitude_bucket()/
     compare_to_pipeline() docstrings for a confirmed real instance of that).
  2. "Neighbor cells": the model's 3 grid neighbors toward whichever edge the
     site sits near (from grid_position_report.py's own %x/%y calc) -- NOT
     re-reading the live capture (Open-Meteo's live endpoint always serves
     "whatever's currently freshest," no pinned run -- see config.py's own
     LIVE_MODELS comment), but a single-runs-api pull at that launch day's
     own 00Z cycle (pull_live_forecast.py's fetch_model_at_run(), the same
     mechanism backfill_capture() already uses for a T-0 backfill). This is
     the best available same-day approximation, not a byte-identical
     same-run comparison to #1 -- a real limitation of this check, not
     hidden here.
  3. "Blended": a bilinear-weighted average of all 4 profiles (own + 3
     neighbors), weighted by fractional distance from the own node toward
     each neighbor (see grid_geometry()) -- linear for speed, circular for
     direction, per matching altitude level (blend_profiles()).
  4. "Ground truth proxy": splash_zones.py's compute_actual_points(), the
     HRRR-analysis f00 "actual" this app already backfills via
     pull_historical.py --actual-only. Itself a proxy, not real ground
     truth -- analyze_real_flight.py never calls it "actual" outright
     either (field name hrrr_analysis_actual_proxy), and this script
     follows that convention.

For every (hour in 11/13) x (altitude in this site's own ladder) x (dual
deploy rate in slow/fast) combo with real data at every step, computes the
distance from the own-cell and blended forecasts to the actual proxy --
then prints a per-date summary and an overall verdict.

Usage: python grid_edge_accuracy_check.py [--site hearne] [--model ecmwf]
"""

import argparse
import math
import time
from datetime import date, datetime
from datetime import time as dtime
from pathlib import Path

import pandas as pd

import config
import grid_position_report as gpr
import pull_historical
import pull_live_forecast as plf
import splash_zones as sz

HOUR_BUCKETS = (11, 13)  # matches analyze_real_flight.py's own convention
API_PAUSE_S = 0.5  # same politeness pause backfill_capture() already uses


def grid_geometry(site_id: str, model_key: str) -> dict:
    """This site's 3 grid-cell neighbors for `model_key` (toward whichever
    edges grid_position_report.py's own live %x/%y lookup says the site
    sits nearest) plus a bilinear interpolation weight for each of the 4
    candidate cells (own + 3 neighbors) -- decided purely from geometry,
    BEFORE looking at any forecast or actual data, so a blend built from
    these weights is a fair decided-in-advance candidate, not a hindsight
    pick. Reuses grid_position_report.py's grid_position()/
    MODEL_GRID_SPACING_DEG directly rather than duplicating either.

    fx/fy are each in [0, 0.5]: the fraction of the way from the own node
    toward the near neighbor on that axis (0 = site sits right on the own
    node, 0.5 = site sits exactly on the boundary, equidistant) -- always
    <= 0.5 since Open-Meteo's own node is by definition the NEAREST one.
    Standard bilinear weights follow directly from fx/fy.
    """
    site = config.SITES[site_id]
    lat, lon = site["lat"], site["lon"]
    r = gpr.grid_position(lat, lon, model_key)
    lat_spacing, lon_spacing = gpr.MODEL_GRID_SPACING_DEG[model_key]
    d_lat = lat_spacing if r["pct_y"] >= 50 else -lat_spacing
    d_lon = lon_spacing if r["pct_x"] >= 50 else -lon_spacing
    ns, ew = ("north" if d_lat > 0 else "south"), ("east" if d_lon > 0 else "west")
    diag = f"{ns}-{ew} diagonal"
    fx, fy = abs(r["pct_x"] - 50) / 100, abs(r["pct_y"] - 50) / 100
    return {
        "pct_x": r["pct_x"], "pct_y": r["pct_y"],
        "neighbors": {ew: (lat, lon + d_lon), ns: (lat + d_lat, lon), diag: (lat + d_lat, lon + d_lon)},
        "weights": {"own": (1 - fx) * (1 - fy), ew: fx * (1 - fy), ns: (1 - fx) * fy, diag: fx * fy},
    }


def blend_profiles(profiles: dict[str, list], weights: dict[str, float]) -> list:
    """Weighted-average wind profile across several profiles that share the
    same altitude levels (linear for speed, circular for direction -- same
    convention interp() elsewhere in this pipeline uses for interpolating
    ALONG one profile; this interpolates ACROSS profiles at a shared
    altitude instead). An altitude only makes it into the result if every
    profile with a nonzero weight actually reported it -- a level only 3 of
    4 inputs have would otherwise silently bias the blend toward whichever
    3 happened to answer."""
    labels = [l for l, w in weights.items() if w > 0 and profiles.get(l)]
    if not labels:
        return []
    total_w = sum(weights[l] for l in labels)
    by_alt: dict[float, list] = {}
    for l in labels:
        for alt, spd, drc in profiles[l]:
            by_alt.setdefault(alt, []).append((weights[l] / total_w, spd, drc))
    blended = []
    for alt, entries in sorted(by_alt.items()):
        if len(entries) < len(labels):
            continue
        spd = sum(w * s for w, s, _ in entries)
        sin_sum = sum(w * math.sin(math.radians(d)) for w, _, d in entries)
        cos_sum = sum(w * math.cos(math.radians(d)) for w, _, d in entries)
        drc = math.degrees(math.atan2(sin_sum, cos_sum)) % 360
        blended.append((alt, spd, drc))
    return blended


def fetch_profiles_by_hour(model_key: str, site_id: str, lat: float, lon: float, run_dt: datetime,
                            forecast_days: int, hours: tuple[int, ...]) -> dict[int, list]:
    """One single-runs-api pull (a specific past model run, at a possibly-
    nudged lat/lon) -> {hour: profile}, via the same parse_hourly()/
    build_profile_single() pipeline the live pull already uses -- one real
    API call covers every hour requested, not one per hour."""
    # Longer timeout than the live pipeline's own default (10s, sized for a
    # tight cron budget) -- this diagnostic isn't on a schedule, and a
    # multi-pressure-level request occasionally runs past 10s with no
    # retry-worthy error, just a slow response.
    raw = plf.fetch_model_at_run(model_key, run_dt, site_id, forecast_days=forecast_days, lat=lat, lon=lon, timeout=30)
    df = plf.parse_hourly(raw, model_key)
    site_elev_ft = config.elev_ft_for_site(site_id)
    levels_mb = config.levels_mb_for_site(site_id)
    out = {}
    for h in hours:
        hdt = datetime.combine(run_dt.date(), dtime(h, 0))
        profile = sz.build_profile_single(df, hdt, model_key, site_elev_ft, levels_mb)
        if len(profile) >= 2:
            out[h] = profile
    return out


def ensure_actuals(site_id: str, target_date: date) -> dict:
    """actuals dict from compute_actual_points(), backfilling the raw HRRR-
    analysis pull first (pull_historical.py --actual-only's own function)
    if it hasn't been pulled yet for this date. Idempotent -- pull_actual()
    itself skips the fetch if the parquet already exists."""
    actuals, _ = sz.compute_actual_points(site_id, target_date)
    if actuals:
        return actuals
    try:
        pull_historical.pull_actual(target_date, site_id)
    except Exception as e:
        print(f"    (could not backfill actual for {target_date}: {e})")
        return {}
    actuals, _ = sz.compute_actual_points(site_id, target_date)
    return actuals


def check_date(site_id: str, model_key: str, target_date: date, geom: dict) -> list[dict]:
    target_dir = Path(config.DATA_DIR) / site_id / "live" / str(target_date)
    capture_date = sz._latest_capture(target_dir)
    if capture_date is None:
        print(f"  {target_date}: no capture on disk at all -- skipping")
        return []
    if capture_date != target_date:
        print(f"  {target_date}: own-cell forecast is actually from {capture_date} "
              f"(T-{(target_date - capture_date).days} -- the daily pull stopped early before this launch)")

    actuals = ensure_actuals(site_id, target_date)
    if not actuals:
        print(f"  {target_date}: no HRRR-analysis actual available (even after trying to backfill) -- skipping")
        return []

    own_df = pd.read_parquet(target_dir / f"captured_{capture_date}.parquet")
    site_elev_ft = config.elev_ft_for_site(site_id)
    levels_mb = config.levels_mb_for_site(site_id)
    altitudes = config.altitudes_for_site(site_id)

    run_dt = datetime.combine(target_date, dtime(0, 0))
    forecast_days = 2  # lead 0 + 2, same margin backfill_capture() uses
    neighbor_profiles = {}
    for label, (nlat, nlon) in geom["neighbors"].items():
        # single-runs-api has shown real transient flakiness during this
        # investigation (502s, occasional 30s timeouts on hearne's larger
        # multi-level requests) beyond what fetch_model_at_run()'s own
        # internal retries absorb -- one extra retry here rather than
        # silently dropping a neighbor and skewing the blend toward
        # whichever ones happened to answer.
        for attempt in range(2):
            try:
                neighbor_profiles[label] = fetch_profiles_by_hour(model_key, site_id, nlat, nlon, run_dt, forecast_days, HOUR_BUCKETS)
                break
            except Exception as e:
                if attempt == 1:
                    print(f"    ({label} neighbor pull failed twice: {e})")
                    neighbor_profiles[label] = {}
                else:
                    time.sleep(2.0)
        time.sleep(API_PAUSE_S)

    rows = []
    for h in HOUR_BUCKETS:
        hdt = datetime.combine(target_date, dtime(h, 0))
        own_profile = sz.build_profile_single(own_df, hdt, model_key, site_elev_ft, levels_mb)
        if len(own_profile) < 2:
            continue
        profiles_by_label = {"own": own_profile}
        for label, profiles in neighbor_profiles.items():
            if h in profiles:
                profiles_by_label[label] = profiles[h]
        blended_profile = blend_profiles(profiles_by_label, geom["weights"])
        if len(blended_profile) < 2:
            continue
        for alt in altitudes:
            phases_by_rate = {
                rate_name: [(drogue, float(alt), config.MAIN_DEPLOY_ALTITUDE_FT), (main, config.MAIN_DEPLOY_ALTITUDE_FT, 0)]
                for rate_name, (drogue, main) in config.DUAL_DEPLOY_RATES_FPS.items()
            }
            for rate_name, phases in phases_by_rate.items():
                key = f"{h}_dual_{rate_name}_{alt}"
                actual_pt = actuals.get(key)
                if not actual_pt:
                    continue
                own_x, own_y = sz.simulate(own_profile, float(alt), phases, site_elev_ft)
                own_dist = math.hypot(own_x - actual_pt["x_ft"], own_y - actual_pt["y_ft"])
                blend_x, blend_y = sz.simulate(blended_profile, float(alt), phases, site_elev_ft)
                blend_dist = math.hypot(blend_x - actual_pt["x_ft"], blend_y - actual_pt["y_ft"])

                # Hindsight-only, for context -- NOT the verdict (see this
                # file's own module docstring for why picking the best
                # neighbor after seeing the actual overstates what's
                # achievable in real time).
                hindsight_dists = {}
                for label, profiles in neighbor_profiles.items():
                    nprofile = profiles.get(h)
                    if not nprofile:
                        continue
                    nx, ny = sz.simulate(nprofile, float(alt), phases, site_elev_ft)
                    hindsight_dists[label] = math.hypot(nx - actual_pt["x_ft"], ny - actual_pt["y_ft"])

                rows.append({
                    "date": target_date, "hour": h, "altitude": alt, "rate": rate_name,
                    "own_dist_ft": own_dist, "blend_dist_ft": blend_dist,
                    "hindsight_best_dist_ft": min(hindsight_dists.values()) if hindsight_dists else None,
                })
    return rows


def summarize(site_id: str, model_key: str, geom: dict, all_rows: list[dict]) -> None:
    if not all_rows:
        print("\nNo comparable data at all -- nothing to summarize.")
        return
    n = len(all_rows)
    own_dists = [r["own_dist_ft"] for r in all_rows]
    blend_dists = [r["blend_dist_ft"] for r in all_rows]
    hindsight_dists = [r["hindsight_best_dist_ft"] for r in all_rows if r["hindsight_best_dist_ft"] is not None]
    blend_beats_own = sum(1 for r in all_rows if r["blend_dist_ft"] < r["own_dist_ft"])

    def _mean(xs):
        return sum(xs) / len(xs)

    def _median(xs):
        s = sorted(xs)
        m = len(s) // 2
        return s[m] if len(s) % 2 else (s[m - 1] + s[m]) / 2

    print(f"\n=== Summary: {site_id}/{model_key}, {n} hour/altitude/rate combos across "
          f"{len(set(r['date'] for r in all_rows))} date(s) ===")
    print(f"  bilinear weights (decided from geometry alone): {', '.join(f'{k}={v:.2f}' for k, v in geom['weights'].items())}")
    print(f"  own-cell forecast vs actual proxy:   mean {_mean(own_dists):7.0f}ft  median {_median(own_dists):7.0f}ft")
    print(f"  BLENDED forecast vs actual proxy:    mean {_mean(blend_dists):7.0f}ft  median {_median(blend_dists):7.0f}ft")
    print(f"  blend beat the own cell in {blend_beats_own}/{n} combos ({100 * blend_beats_own / n:.0f}%)")
    if hindsight_dists:
        print(f"  (for context only, not the verdict -- best-of-3-neighbors picked WITH hindsight knowledge of the "
              f"actual: mean {_mean(hindsight_dists):7.0f}ft median {_median(hindsight_dists):7.0f}ft)")

    print("\nVerdict -- decided-in-advance BLEND vs the single own cell (this test case only; small sample, proxy ground truth):")
    if blend_beats_own / n > 0.65:
        print("  The blend was consistently closer to the actual proxy than the cell alone --")
        print("  worth widening this check to more dates/sites, and worth starting to collect neighbor-cell")
        print("  data going forward for a larger, real (not retrospectively-reconstructed) sample.")
    elif blend_beats_own / n < 0.35:
        print("  The own cell alone was usually closer to the actual proxy than the blend --")
        print("  no evidence blending would help here.")
    else:
        print("  Roughly a coin flip, and/or the own-vs-blend deltas are small -- consistent with")
        print("  'no averaging needed' for this site/model. Small sample -- treat as suggestive, not final.")


def run(site_id: str, model_key: str) -> None:
    print(f"Grid-edge accuracy check: {site_id}/{model_key}")
    print("(HRRR-analysis 'actual' is a proxy for ground truth, not the real thing -- see this file's own docstring)\n")
    geom = grid_geometry(site_id, model_key)
    print(f"Site sits at pct_x={geom['pct_x']:.1f}%, pct_y={geom['pct_y']:.1f}% within its own cell.")
    print(f"Neighbors probed: {', '.join(f'{label} ({lat:.3f},{lon:.3f})' for label, (lat, lon) in geom['neighbors'].items())}\n")

    target_dir = Path(config.DATA_DIR) / site_id / "live"
    target_dates = sorted(date.fromisoformat(p.name) for p in target_dir.iterdir() if p.is_dir())

    all_rows = []
    for target_date in target_dates:
        if target_date > date.today():
            continue
        print(f"{target_date}:")
        rows = check_date(site_id, model_key, target_date, geom)
        if rows:
            print(f"  {len(rows)} hour/altitude/rate combos computed")
        all_rows.extend(rows)

    summarize(site_id, model_key, geom, all_rows)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--site", default="hearne", choices=list(config.SITES))
    parser.add_argument("--model", default="ecmwf", choices=list(config.LIVE_PROFILE_MODELS))
    args = parser.parse_args()
    run(args.site, args.model)
