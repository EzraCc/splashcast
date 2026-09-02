"""Cross-site/model grid-edge error correlation: using forecast-vs-actual
data ALREADY on disk (no new API calls, no waiting), does a model sitting
near a grid-cell edge/corner at a given site show consistently higher error
than a well-centered model at that same site?

Follow-up to grid_edge_accuracy_check.py, which found that a single
decided-in-advance neighbor-cell BLEND didn't clearly beat the own cell for
one test case (hearne/ecmwf) -- that check only had 3 dates for one
site/model pair. This script instead uses every (site, target_date) combo
that already has a real HRRR-analysis "actual" pulled (pull_historical.py
--actual-only), across every site and every one of config.LIVE_PROFILE_MODELS
at once -- no neighbor-cell reconstruction, no single-runs-api calls, just
the SAME forecast-vs-actual comparison analyze_real_flight.py's
compare_to_pipeline() already does for one flight, run over every model at
every site with actual data. A genuinely larger, real sample, immediately
available.

For each (site, model) pair, computes mean/median distance from that
model's own forecast to the HRRR-analysis actual proxy across every
(date, hour, altitude, rate) combo available, then cross-references against
grid_position_report.py's own %x/%y position for that pair -- both an
overall near-edge-vs-centered comparison and, more usefully, a WITHIN-SITE
comparison (same dates, same weather regime, only the model differs) for
any site that has both a flagged and an unflagged model.

Caveat carried over from grid_edge_accuracy_check.py: HRRR-analysis is a
proxy for ground truth, not verified real GPS truth; the "own-cell forecast"
here is whichever capture is latest on disk for that target (usually T-0,
occasionally older if the daily pull stopped early -- not filtered out,
just be aware more captures are approximations for some rows than others).

Usage: python grid_edge_error_correlation.py
"""

import math
from datetime import date
from pathlib import Path

import pandas as pd

import config
import grid_position_report as gpr
import splash_zones as sz

HOUR_BUCKETS = (11, 13)  # matches analyze_real_flight.py's own convention


def discover_actual_dates() -> dict[str, list[date]]:
    """Every site with at least one real HRRR-analysis actual already
    pulled, and which target dates -- from data/<site_id>/raw/*_actual.parquet,
    not the legacy top-level data/raw/ (hutto's original pre-multi-site
    Saturday backfill, a different schema/model set entirely -- out of
    scope here, see pull_historical.py's own module docstring)."""
    out = {}
    for site_id in config.SITES:
        raw_dir = Path(config.DATA_DIR) / site_id / "raw"
        if not raw_dir.exists():
            continue
        dates = []
        for p in raw_dir.glob("*_actual.parquet"):
            stem = p.stem.removesuffix("_actual")
            try:
                dates.append(date.fromisoformat(stem))
            except ValueError:
                continue  # e.g. a "_noon_oneoff" variant -- not a plain date stem
        if dates:
            out[site_id] = sorted(dates)
    return out


def site_date_errors(site_id: str, target_date: date) -> list[dict]:
    """Every model's own forecast-vs-actual distance for this site/date,
    across every (hour, altitude, rate) combo -- reuses
    compute_splash_points() (already computes every model/hour/altitude/
    rate/deploy combo in one pass) and compute_actual_points() directly,
    rather than re-deriving per-model profiles by hand."""
    target_dir = Path(config.DATA_DIR) / site_id / "live" / str(target_date)
    capture_date = sz._latest_capture(target_dir)
    if capture_date is None:
        return []
    actuals, _ = sz.compute_actual_points(site_id, target_date)
    if not actuals:
        return []
    df = pd.read_parquet(target_dir / f"captured_{capture_date}.parquet")
    pts = sz.compute_splash_points(df, target_date, site_id)
    pts = pts[(pts["deploy"] == "dual") & (pts["hour"].isin(HOUR_BUCKETS))]
    rows = []
    for _, r in pts.iterrows():
        key = f"{r['hour']}_dual_{r['rate']}_{r['altitude']}"
        actual_pt = actuals.get(key)
        if not actual_pt:
            continue
        dist = math.hypot(r["x_ft"] - actual_pt["x_ft"], r["y_ft"] - actual_pt["y_ft"])
        rows.append({
            "site": site_id, "model": r["model"], "date": target_date,
            "hour": r["hour"], "altitude": r["altitude"], "rate": r["rate"],
            "dist_ft": dist, "capture_date": capture_date,
        })
    return rows


def run() -> None:
    site_dates = discover_actual_dates()
    print(f"Sites with at least one real actual pulled: {', '.join(f'{s} ({len(d)})' for s, d in site_dates.items())}\n")

    all_rows = []
    for site_id, dates in site_dates.items():
        for target_date in dates:
            all_rows.extend(site_date_errors(site_id, target_date))

    if not all_rows:
        print("No comparable data at all.")
        return

    df = pd.DataFrame(all_rows)
    agg = df.groupby(["site", "model"])["dist_ft"].agg(["mean", "median", "count"]).reset_index()

    for i, row in agg.iterrows():
        site = config.SITES[row["site"]]
        try:
            r = gpr.grid_position(site["lat"], site["lon"], row["model"])
        except Exception:
            r = {"pct_x": None, "pct_y": None, "near_edge": None}
        agg.loc[i, "pct_x"] = r["pct_x"]
        agg.loc[i, "pct_y"] = r["pct_y"]
        agg.loc[i, "near_edge"] = r["near_edge"]

    print(f"{'site':22s} {'model':7s} {'mean ft':>9s} {'median ft':>10s} {'n':>4s} {'%x':>6s} {'%y':>6s}  flag")
    for _, row in agg.sort_values(["site", "near_edge"], ascending=[True, False]).iterrows():
        flag = "  <-- near edge/corner" if row["near_edge"] else ""
        print(f"{row['site']:22s} {row['model']:7s} {row['mean']:9.0f} {row['median']:10.0f} {row['count']:4.0f} "
              f"{row['pct_x']:6.1f} {row['pct_y']:6.1f}{flag}")

    flagged = agg[agg["near_edge"] == True]
    centered = agg[agg["near_edge"] == False]
    print(f"\n=== Overall: near-edge/corner-flagged models vs well-centered models, weighted by sample count ===")
    if len(flagged) and len(centered):
        flagged_mean = (flagged["mean"] * flagged["count"]).sum() / flagged["count"].sum()
        centered_mean = (centered["mean"] * centered["count"]).sum() / centered["count"].sum()
        print(f"  flagged:   mean {flagged_mean:7.0f}ft  ({int(flagged['count'].sum())} combos across {flagged['site'].nunique()} sites)")
        print(f"  centered:  mean {centered_mean:7.0f}ft  ({int(centered['count'].sum())} combos across {centered['site'].nunique()} sites)")
    else:
        print("  not enough of one category to compare.")

    print(f"\n=== Within-site comparisons (same dates/weather regime, only the model differs) ===")
    any_within_site = False
    for site_id, g in agg.groupby("site"):
        flagged_g, centered_g = g[g["near_edge"] == True], g[g["near_edge"] == False]
        if len(flagged_g) and len(centered_g):
            any_within_site = True
            f_mean = (flagged_g["mean"] * flagged_g["count"]).sum() / flagged_g["count"].sum()
            c_mean = (centered_g["mean"] * centered_g["count"]).sum() / centered_g["count"].sum()
            worse = "WORSE" if f_mean > c_mean else "better"
            print(f"  {site_id:22s} flagged models avg {f_mean:7.0f}ft vs centered models avg {c_mean:7.0f}ft -- flagged is {worse}")
    if not any_within_site:
        print("  no site currently has both a flagged and an unflagged model with actual data -- can't do a within-site comparison yet.")


if __name__ == "__main__":
    run()
