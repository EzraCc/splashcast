"""Grid-edge error correlation: does a model's forecast accuracy actually
depend on how close its site sits to a grid-cell edge or corner?

Follow-up to grid_edge_accuracy_check.py, which found no clean benefit from
blending in one neighbor-cell test case. Per direct request, this instead
asks the more fundamental question first: is there any real statistical
relationship between grid position and accuracy at all, using data already
on disk -- no neighbor-cell reconstruction, no new API calls. If there
isn't, the neighbor-cell math in grid_edge_accuracy_check.py isn't worth
pursuing further.

Uses EVERY capture already on disk for every (site, target_date) that has a
real HRRR-analysis actual pulled -- not just the latest/T-0 one.
History mode already builds this same forecast-drift record (one capture
per day leading up to launch, T-7 through T-0); this script just pools all
of it across every site/date instead of picking one capture per date, which
multiplies the available sample for free (splash_zones.py's own
_all_captures(), not _latest_capture()).

Two views of the same data:
  1. Categorical -- every (site, model) pair classified middle/edge/corner
     via grid_position_report.py's own %x/%y position (same 15%-from-an-edge
     threshold that script already flags with), then a Kruskal-Wallis test
     (nonparametric -- distance-to-actual is a skewed, non-negative
     quantity, not assumed normal) across the three groups' error
     distributions, plus pairwise Mann-Whitney U tests (edge vs middle,
     corner vs middle).
  2. Continuous -- collapsing the three categories into one number per
     (site, model): how close to a cell boundary it sits (0 = right on a
     boundary, 50 = perfectly centered on both axes), correlated (Spearman,
     robust to outliers/nonlinearity, and doesn't assume a straight-line
     relationship) against that pair's own mean error.

Both views aggregate to one point per (site, model) pair for the
correlation/group-comparison (not one point per raw row) specifically to
avoid pseudo-replication: a site with many hour/altitude/rate/lead-time
combos shouldn't outweigh a site with fewer just because it has more rows.
A separate breakdown by lead_days bucket is also printed, to check the
categories aren't just differing because one happens to have more far-lead
(inherently less accurate) samples than another.

Caveat carried over from grid_edge_accuracy_check.py: HRRR-analysis is a
proxy for ground truth, not verified real GPS truth.

Usage: python grid_edge_error_correlation.py
"""

import math
from datetime import date
from pathlib import Path

import pandas as pd
from scipy import stats

import config
import grid_position_report as gpr
import splash_zones as sz

HOUR_BUCKETS = (11, 13)  # matches analyze_real_flight.py's own convention
LEAD_BUCKETS = [(0, 1), (2, 3), (4, 5), (6, 7)]


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


def site_date_errors_all_leads(site_id: str, target_date: date) -> list[dict]:
    """Every model's own forecast-vs-actual distance for this site/date, at
    EVERY capture on disk (every real lead time T-7..T-0 this pipeline
    happened to pull), not just the latest -- pools the same forecast-drift
    record History mode already builds, across every date, for a much
    larger sample than one capture per date would give."""
    target_dir = Path(config.DATA_DIR) / site_id / "live" / str(target_date)
    captures = sz._all_captures(target_dir)
    if not captures:
        return []
    actuals, _ = sz.compute_actual_points(site_id, target_date)
    if not actuals:
        return []
    rows = []
    for capture_date in captures:
        lead_days = (target_date - capture_date).days
        df = pd.read_parquet(target_dir / f"captured_{capture_date}.parquet")
        pts = sz.compute_splash_points(df, target_date, site_id)
        pts = pts[(pts["deploy"] == "dual") & (pts["hour"].isin(HOUR_BUCKETS))]
        for _, r in pts.iterrows():
            key = f"{r['hour']}_dual_{r['rate']}_{r['altitude']}"
            actual_pt = actuals.get(key)
            if not actual_pt:
                continue
            dist = math.hypot(r["x_ft"] - actual_pt["x_ft"], r["y_ft"] - actual_pt["y_ft"])
            rows.append({
                "site": site_id, "model": r["model"], "target_date": target_date,
                "capture_date": capture_date, "lead_days": lead_days,
                "hour": r["hour"], "altitude": r["altitude"], "rate": r["rate"], "dist_ft": dist,
            })
    return rows


def categorize(pct_x: float, pct_y: float) -> str:
    near_x = min(pct_x, 100 - pct_x) < gpr.EDGE_FLAG_PCT
    near_y = min(pct_y, 100 - pct_y) < gpr.EDGE_FLAG_PCT
    if near_x and near_y:
        return "corner"
    if near_x or near_y:
        return "edge"
    return "middle"


def edge_closeness_pct(pct_x: float, pct_y: float) -> float:
    """0 = right on a grid-cell boundary, 50 = perfectly centered on both
    axes -- the continuous version of categorize()."""
    return min(pct_x, 100 - pct_x, pct_y, 100 - pct_y)


def lead_bucket(lead_days: int) -> str:
    for lo, hi in LEAD_BUCKETS:
        if lo <= lead_days <= hi:
            return f"T-{lo}..{hi}"
    return f"T-{lead_days}"


def run() -> None:
    site_dates = discover_actual_dates()
    print(f"Sites with at least one real actual pulled: {', '.join(f'{s} ({len(d)} date(s))' for s, d in site_dates.items())}\n")

    all_rows = []
    for site_id, dates in site_dates.items():
        for target_date in dates:
            all_rows.extend(site_date_errors_all_leads(site_id, target_date))

    if not all_rows:
        print("No comparable data at all.")
        return

    df = pd.DataFrame(all_rows)
    print(f"Total rows (every site/model/date/lead/hour/altitude/rate combo with a real actual): {len(df)}\n")

    # One category/closeness value per (site, model) pair -- fixed by
    # geometry, doesn't vary by date/lead/hour/altitude/rate.
    pair_geom = {}
    for site_id, model in df[["site", "model"]].drop_duplicates().itertuples(index=False):
        site = config.SITES[site_id]
        try:
            r = gpr.grid_position(site["lat"], site["lon"], model)
        except Exception:
            continue
        pair_geom[(site_id, model)] = {
            "category": categorize(r["pct_x"], r["pct_y"]),
            "closeness": edge_closeness_pct(r["pct_x"], r["pct_y"]),
        }
    df["category"] = df.apply(lambda r: pair_geom.get((r["site"], r["model"]), {}).get("category"), axis=1)
    df["closeness"] = df.apply(lambda r: pair_geom.get((r["site"], r["model"]), {}).get("closeness"), axis=1)
    df["lead_bucket"] = df["lead_days"].apply(lead_bucket)

    print("=== Per-(site,model) pair: category, closeness, sample count ===")
    pair_summary = df.groupby(["site", "model", "category", "closeness"])["dist_ft"].agg(["mean", "count"]).reset_index()
    for _, row in pair_summary.sort_values("closeness").iterrows():
        print(f"  {row['site']:22s} {row['model']:7s} {row['category']:7s} closeness={row['closeness']:5.1f}  "
              f"mean_err={row['mean']:7.0f}ft  n={row['count']:.0f}")

    print(f"\n=== Categorical: raw-row error distribution by category ===")
    for cat in ("middle", "edge", "corner"):
        sub = df[df["category"] == cat]["dist_ft"]
        if len(sub):
            print(f"  {cat:7s}: n={len(sub):5d}  mean={sub.mean():7.0f}ft  median={sub.median():7.0f}ft")

    groups = {cat: df[df["category"] == cat]["dist_ft"].values for cat in ("middle", "edge", "corner")}
    usable = {cat: g for cat, g in groups.items() if len(g) >= 5}
    if len(usable) >= 2:
        print(f"\n=== Statistical tests (raw rows -- see the per-pair table above for the de-duplicated view) ===")
        if len(usable) == 3:
            h, p = stats.kruskal(*usable.values())
            print(f"  Kruskal-Wallis (middle vs edge vs corner): H={h:.2f}, p={p:.4f}"
                  f"{' -- SIGNIFICANT at p<0.05' if p < 0.05 else ' -- not significant'}")
        if "middle" in usable and "edge" in usable:
            u, p = stats.mannwhitneyu(usable["edge"], usable["middle"], alternative="two-sided")
            print(f"  Mann-Whitney (edge vs middle): U={u:.0f}, p={p:.4f}"
                  f"{' -- SIGNIFICANT' if p < 0.05 else ' -- not significant'}")
        if "middle" in usable and "corner" in usable:
            u, p = stats.mannwhitneyu(usable["corner"], usable["middle"], alternative="two-sided")
            print(f"  Mann-Whitney (corner vs middle): U={u:.0f}, p={p:.4f}"
                  f"{' -- SIGNIFICANT' if p < 0.05 else ' -- not significant'}")
    else:
        print("\nNot enough categories with >=5 samples each to run a statistical test.")

    print(f"\n=== Continuous: per-(site,model) mean error vs. edge-closeness (Spearman correlation) ===")
    if len(pair_summary) >= 4:
        rho, p = stats.spearmanr(pair_summary["closeness"], pair_summary["mean"])
        direction = "closer to an edge -> HIGHER error" if rho < 0 else "closer to an edge -> LOWER error (or no relationship)"
        print(f"  n={len(pair_summary)} (site,model) pairs, Spearman rho={rho:.3f}, p={p:.4f}"
              f"{' -- SIGNIFICANT' if p < 0.05 else ' -- not significant'}")
        print(f"  ({direction} -- closeness=0 is right on a boundary, 50 is perfectly centered, so a NEGATIVE")
        print(f"   correlation between closeness and error means error goes UP as you approach an edge)")
    else:
        print("  Not enough (site,model) pairs yet for a meaningful correlation.")

    print(f"\n=== Error by lead-time bucket x category (checking the above isn't just a lead-time confound) ===")
    pivot = df.groupby(["lead_bucket", "category"])["dist_ft"].mean().unstack()
    print(pivot.round(0).to_string())

    print(f"\n=== Within-site comparisons (fully controls for SITE identity -- same dates/weather/site, only the model's grid position differs) ===")
    site_stats = []
    for site_id, g in df.groupby("site"):
        cats_present = g["category"].unique()
        if len(cats_present) < 2:
            continue
        by_cat = g.groupby("category")["dist_ft"].agg(["mean", "count"])
        middle_mean = by_cat.loc["middle", "mean"] if "middle" in by_cat.index else None
        line = f"  {site_id:22s} " + ", ".join(f"{cat}={by_cat.loc[cat, 'mean']:.0f}ft(n={by_cat.loc[cat, 'count']:.0f})" for cat in ("corner", "edge", "middle") if cat in by_cat.index)
        print(line)
        if middle_mean is not None:
            for cat in ("corner", "edge"):
                if cat in by_cat.index:
                    site_stats.append({"site": site_id, "category": cat, "vs_middle_ratio": by_cat.loc[cat, "mean"] / middle_mean})
    if site_stats:
        ss = pd.DataFrame(site_stats)
        print(f"\n  Across {ss['site'].nunique()} sites with a middle model to compare against:")
        for cat in ("corner", "edge"):
            sub = ss[ss["category"] == cat]
            if len(sub):
                worse_count = (sub["vs_middle_ratio"] > 1).sum()
                print(f"    {cat}: worse than middle at {worse_count}/{len(sub)} sites, mean ratio {sub['vs_middle_ratio'].mean():.2f}x "
                      f"of middle's error (>1 = worse)")
    else:
        print("  No site has both a middle-classified model and an edge/corner one to compare within-site.")

    print("\n=== Verdict ===")
    print("If neither the Kruskal-Wallis test nor the Spearman correlation above is significant,")
    print("there is no evidence in the data we have that edge/corner-sited models are inherently")
    print("less accurate than centered ones -- the neighbor-cell blending math is not worth pursuing")
    print("further on this basis. If either IS significant, that's real support for building it.")


if __name__ == "__main__":
    run()
