Status: done
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

## Result v1 (hearne/ecmwf, hindsight best-of-3-neighbors -- SUPERSEDED, see v2)

~~72 combos. Own-cell vs actual: mean 515ft. Best-of-3-neighbors vs actual:
mean 285ft. A neighbor beat the own cell in 57/72 (79%).~~ -- superseded:
picking whichever neighbor happened to be closest AFTER seeing the actual
overstates what's achievable in real time (you can't know in advance which
neighbor to trust). Correctly flagged by direct question: "did you use the
neighboring cell data, or a % combination... we can't shift cells without
guessing."

## Result v2 (hearne/ecmwf, decided-in-advance bilinear blend)

Same 3 dates, same 72 combos, but comparing the own cell against ONE
deterministic candidate -- a bilinear blend of own + 3 neighbors, weighted
purely by the site's geometric %x/%y position (decided before looking at
any forecast/actual data). Result: **blend performed WORSE on average**
(mean 562ft vs own cell's 515ft), despite beating the own cell in 44/72
(61%) of individual combos -- when it won it won by less than when it lost.
No evidence blending helps for this specific site/model. The v1 "79%" figure
was a hindsight artifact, not a real signal.

## Result: cross-site/model error correlation (new script, existing data only)

Requested directly: use forecast-vs-actual data already on disk across
every site with a real actual pulled (8 sites, no new API calls) to check
whether a near-edge-flagged model shows consistently higher error than an
unflagged model at the SAME site (same dates/weather regime, controls for
site-specific difficulty). `pipeline/grid_edge_error_correlation.py`.

Within-site result across the 6 sites with both a flagged and unflagged
model: **flagged is worse at 4 sites (gunter, hutto, seymour,
tripoli_houston_south), better at 2 (hearne, sd_rocket_jockies)** -- mixed,
no dominant direction. The naive overall (not within-site) comparison
showed flagged models with LOWER mean error, but that's confounded: it mixes
different sites with wildly different inherent difficulty (argonia's
non-flagged icon/ecmwf both average >4,000ft error, clearly a site with its
own problems unrelated to grid position) and different specific models
(ecmwf/arpege share one grid and are flagged together; which models get
flagged varies site to site) -- the within-site comparison is the
meaningful one, and it does not show a clean signal either way.

## Result: definitive statistical check (rebuilt `grid_edge_error_correlation.py`)

Requested directly: stop looking at neighboring grids/blending for a moment
-- use the full historical record (every capture T-7..T-0 already on disk
for every site with a real actual, not just the latest one) and check
whether edge/corner-sited models are inherently less accurate, categorically
(middle/edge/corner) or continuously (%-distance-from-an-edge vs error).

Pooled 8,488 rows across 8 sites, 44 (site, model) pairs, every lead time
T-0 through T-7. Two views, both properly controlling for confounds:
- **Per-pair correlation** (one point per (site,model), avoiding
  pseudo-replication): Spearman rho=0.042, p=0.79 -- **no relationship**.
- **Within-site comparison** (same site/dates/weather, only the model's
  grid position differs -- fully controls for site identity): corner models
  averaged 0.98x middle's error (worse at only 1/3 sites); edge models
  averaged 1.03x middle's error (worse at 4/6 sites, but only 3% on
  average) -- both **noise-level, not a real effect**.
- A naive pooled-row Kruskal-Wallis test WAS significant (p<0.0001), but in
  the physically implausible direction (corner/edge looked BETTER than
  middle) -- traced to a real site-identity confound: argonia/seymour have
  inherently large drift errors and happen to be classified "middle," while
  hearne/gunter/apache_pass have smaller inherent errors and happen to have
  more edge/corner-flagged models. Once site is controlled for (either view
  above), the effect vanishes. This is the reason NOT to trust a raw pooled
  comparison for this kind of question.

**Conclusion: no evidence, in the data available, that edge/corner-sited
models are inherently less accurate than centered ones.** The neighbor-cell
blending math from `grid_edge_accuracy_check.py` is not worth pursuing
further on this basis -- consistent with (and now backed by real statistics
across every site, not just one) that script's own decided-in-advance-blend
result for hearne/ecmwf.

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
- The accuracy question itself is now settled (no evidence of an effect,
  see the definitive statistical check above) -- backfilling more data or
  starting forward-looking neighbor-cell collection is no longer needed on
  this basis.
- Whether to still surface a persistent near-edge/corner flag "somehow"
  (per an earlier direct request) purely for informational/transparency
  reasons, given the data doesn't show it currently matters for accuracy --
  worth checking with the user now that the underlying question is answered,
  not asked yet since the accuracy investigation took priority.
- `pull_historical.py`'s legacy top-level `data/raw/` (hutto's original
  pre-multi-site NOAA-only Saturday backfill) was deliberately excluded from
  the statistical check (different schema/model set) -- not revisited, no
  need to.

## Explicitly out of scope
- No changes to `app.js`, the live pipeline's forecast math, or site
  coordinates.
- Not deciding the averaging question for all 34 flagged combos at once.
