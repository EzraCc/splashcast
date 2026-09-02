"""Grid-edge accuracy check: for one site/model sitting near a corner of its
weather model's own grid cell, does the neighboring cell's forecast differ
enough -- and would it have been measurably more accurate -- to justify
building any kind of cell-blending logic?

Follow-up spike to grid_position_report.py's finding that 34 of 60 site/
model combinations sit within 15% of a grid-cell edge (7 of them within 15%
on BOTH axes -- a true corner, bordering 3 neighbor cells instead of 1).
Read-only: doesn't touch the live pipeline, the app's forecast math, or any
site coordinate.

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
  3. "Ground truth proxy": splash_zones.py's compute_actual_points(), the
     HRRR-analysis f00 "actual" this app already backfills via
     pull_historical.py --actual-only. Itself a proxy, not real ground
     truth -- analyze_real_flight.py never calls it "actual" outright
     either (field name hrrr_analysis_actual_proxy), and this script
     follows that convention.

For every (hour in 11/13) x (altitude in this site's own ladder) x (dual
deploy rate in slow/fast) combo with real data at every step, computes the
distance from the own-cell forecast to the actual proxy, the distance from
each neighbor-cell forecast to the same proxy, and the raw own-vs-neighbor
deltas -- then prints a per-date summary and an overall verdict.

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


def neighbor_coords(site_id: str, model_key: str) -> list[tuple[str, float, float]]:
    """This site's 3 grid-cell neighbors for `model_key` -- toward whichever
    edge grid_position_report.py's own live %x/%y lookup says the site is
    closest to, not a fixed direction. Reuses that module's grid_position()
    and MODEL_GRID_SPACING_DEG directly rather than duplicating either, so
    this stays correct if that module's measured spacing is ever refined."""
    site = config.SITES[site_id]
    lat, lon = site["lat"], site["lon"]
    r = gpr.grid_position(lat, lon, model_key)
    lat_spacing, lon_spacing = gpr.MODEL_GRID_SPACING_DEG[model_key]
    d_lat = lat_spacing if r["pct_y"] >= 50 else -lat_spacing
    d_lon = lon_spacing if r["pct_x"] >= 50 else -lon_spacing
    ns, ew = ("north" if d_lat > 0 else "south"), ("east" if d_lon > 0 else "west")
    return [
        (ew, lat, lon + d_lon),
        (ns, lat + d_lat, lon),
        (f"{ns}-{ew} diagonal", lat + d_lat, lon + d_lon),
    ]


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


def check_date(site_id: str, model_key: str, target_date: date, neighbors: list[tuple[str, float, float]]) -> list[dict]:
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
    for label, nlat, nlon in neighbors:
        # single-runs-api has shown real transient flakiness during this
        # investigation (502s, occasional 30s timeouts on hearne's larger
        # multi-level requests) beyond what fetch_model_at_run()'s own
        # internal retries absorb -- one extra retry here rather than
        # silently dropping a neighbor and skewing the "best neighbor"
        # comparison toward whichever ones happened to answer.
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
                neighbor_dists, neighbor_deltas = {}, {}
                for label, profiles in neighbor_profiles.items():
                    nprofile = profiles.get(h)
                    if not nprofile:
                        continue
                    nx, ny = sz.simulate(nprofile, float(alt), phases, site_elev_ft)
                    neighbor_dists[label] = math.hypot(nx - actual_pt["x_ft"], ny - actual_pt["y_ft"])
                    neighbor_deltas[label] = math.hypot(nx - own_x, ny - own_y)
                if neighbor_dists:
                    rows.append({
                        "date": target_date, "hour": h, "altitude": alt, "rate": rate_name,
                        "own_dist_ft": own_dist, "neighbor_dists_ft": neighbor_dists, "neighbor_deltas_ft": neighbor_deltas,
                    })
    return rows


def summarize(site_id: str, model_key: str, all_rows: list[dict]) -> None:
    if not all_rows:
        print("\nNo comparable data at all -- nothing to summarize.")
        return
    n = len(all_rows)
    own_dists = [r["own_dist_ft"] for r in all_rows]
    best_neighbor_dists = [min(r["neighbor_dists_ft"].values()) for r in all_rows]
    own_vs_best_neighbor_deltas = [min(r["neighbor_deltas_ft"].values()) for r in all_rows]
    beats = sum(1 for r in all_rows if min(r["neighbor_dists_ft"].values()) < r["own_dist_ft"])

    def _mean(xs):
        return sum(xs) / len(xs)

    def _median(xs):
        s = sorted(xs)
        m = len(s) // 2
        return s[m] if len(s) % 2 else (s[m - 1] + s[m]) / 2

    print(f"\n=== Summary: {site_id}/{model_key}, {n} hour/altitude/rate combos across "
          f"{len(set(r['date'] for r in all_rows))} date(s) ===")
    print(f"  own-cell forecast vs actual proxy:      mean {_mean(own_dists):7.0f}ft  median {_median(own_dists):7.0f}ft")
    print(f"  best-neighbor forecast vs actual proxy: mean {_mean(best_neighbor_dists):7.0f}ft  median {_median(best_neighbor_dists):7.0f}ft")
    print(f"  raw own-cell vs best-neighbor delta:    mean {_mean(own_vs_best_neighbor_deltas):7.0f}ft  median {_median(own_vs_best_neighbor_deltas):7.0f}ft")
    print(f"  a neighbor beat the own cell in {beats}/{n} combos ({100 * beats / n:.0f}%)")

    print("\nVerdict (this test case only -- see the plan's own caveats about sample size and the actual-proxy):")
    if beats / n > 0.65:
        print("  Neighbor cells were consistently closer to the actual proxy than the cell actually used --")
        print("  worth widening this check to more dates/sites before building anything.")
    elif beats / n < 0.35:
        print("  The cell actually used was usually closer to the actual proxy than its neighbors --")
        print("  no evidence blending/preferring a neighbor would help here.")
    else:
        print("  Roughly a coin flip which cell is closer, and/or the own-vs-neighbor deltas are small --")
        print("  consistent with 'no averaging needed' for this site/model. Small sample -- treat as suggestive, not final.")


def run(site_id: str, model_key: str) -> None:
    print(f"Grid-edge accuracy check: {site_id}/{model_key}")
    print("(HRRR-analysis 'actual' is a proxy for ground truth, not the real thing -- see this file's own docstring)\n")
    neighbors = neighbor_coords(site_id, model_key)
    print(f"Neighbors probed: {', '.join(f'{label} ({lat:.3f},{lon:.3f})' for label, lat, lon in neighbors)}\n")

    target_dir = Path(config.DATA_DIR) / site_id / "live"
    target_dates = sorted(date.fromisoformat(p.name) for p in target_dir.iterdir() if p.is_dir())

    all_rows = []
    for target_date in target_dates:
        if target_date > date.today():
            continue
        print(f"{target_date}:")
        rows = check_date(site_id, model_key, target_date, neighbors)
        if rows:
            print(f"  {len(rows)} hour/altitude/rate combos computed")
        all_rows.extend(rows)

    summarize(site_id, model_key, all_rows)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--site", default="hearne", choices=list(config.SITES))
    parser.add_argument("--model", default="ecmwf", choices=list(config.LIVE_PROFILE_MODELS))
    args = parser.parse_args()
    run(args.site, args.model)
