Status: in-progress
Priority: medium
Type: new-feature
Last updated: 2026-09-02

# Grid-edge accuracy investigation

## Context

`pipeline/grid_position_report.py` (added 2026-09-02) found that 34 of 60
site/model combinations sit within 15% of a grid-cell edge, 7 of them within
15% on *both* axes (a true corner, bordering 3 neighboring cells instead of
1). Requested directly: pick one test case and check whether the neighbor
cell's forecast is different enough, and whether it would have been more
accurate historically, to justify building any kind of cell-blending logic
-- if deltas are small/noise-level, no averaging is needed. This is a
read-only spike, not a forecast-math change.

## Tasks
- [x] Build `pipeline/grid_edge_accuracy_check.py` (CLI: `--site`, `--model`,
      default hearne/ecmwf)
- [x] For each of hearne's 3 dates with real `actuals` (2026-07-11, 07-25,
      08-08): pull own-cell T-0 ECMWF profile + 3 neighbor-cell archived
      profiles (`fetch_model_at_run()`, nudged coordinates), run `simulate()`
      on all 4, compare against `compute_actual_points()`'s own output
      (same data `points_history.json["actuals"]` publishes)
- [x] Print per-date/hour report: own-cell-vs-actual distance,
      neighbor-cell-vs-actual distance, raw own-vs-neighbor deltas
- [x] Report verdict: consistent neighbor improvement -> worth widening;
      small/inconsistent -> no-averaging-needed hypothesis holds
- [ ] Sanity-check one date's own-cell number against
      `analyze_real_flight.py`'s `hrrr_analysis_actual_proxy` math -- not
      done yet, worth doing before fully trusting the magnitude (not just
      the direction) of the result below

## Result (hearne/ecmwf, 3 dates: 2026-07-11, 07-25, 08-08)

72 hour/altitude/rate combos. Own-cell forecast vs actual proxy: mean
515ft/median 383ft off. Best-of-3-neighbors vs actual proxy: mean
285ft/median 234ft off. A neighbor beat the own cell in **57/72 (79%)** of
combos. This is a real, consistent signal in this one test case -- NOT the
"probably negligible" outcome floated at the start. Caveats: single
site/model pair, 3 dates, and the ground truth itself is an HRRR-analysis
proxy, not verified real GPS truth. 2026-07-25's "own cell" was actually a
T-7 capture (the daily pull stopped early before that launch), not a true
T-0 -- noted by the script, not excluded.

## Decisions
- Test case: hearne/ecmwf, chosen over sd_rocket_jockies/gfs specifically
  because it already has real `actuals` ground-truth data for all 3 of its
  historical dates (no backfill needed to start) -- confirmed with the user.
- Reuse existing functions rather than reimplement: `splash_zones.py`'s
  `simulate()`/`interp()` (drift physics), `pull_historical.py`'s
  `pull_actual()`/`--actual-only` (actual backfill), `pull_live_forecast.py`'s
  `fetch_model_at_run()` (single-runs API for a specific past run at an
  arbitrary/nudged coordinate).
- HRRR-analysis "actual" is a proxy, not ground truth -- state this
  explicitly in the script's output, don't overstate confidence from 3 dates.

## Detours
(none yet)

## Open questions
- If hearne/ecmwf is inconclusive, widen to gunter/apache_pass/sd_rocket_jockies
  (backfilling their missing `--actual-only` dates first) -- explicit
  follow-up, not automatic; ask before doing it.

## Explicitly out of scope
- No changes to `app.js`, the live pipeline's forecast math, or site
  coordinates.
- Not deciding the averaging question for all 34 flagged combos at once.
