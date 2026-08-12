Status: done
Priority: high
Type: refinement
Last updated: 2026-08-12

# Rate editor relocation + cloud reference line + temperature warnings

## Context

Three requests in one message, unrelated to each other except that all three
touch the weather panel / layout area of the viewer:

1. The descent-rate editor is buried on mobile and is now the *only* thing
   left in the desktop sidebar (`.side-col`) — everything else (altitude
   ladder, model legend, rail-angle inputs) already got moved out of it in
   earlier rounds. Move it to a horizontal row above the map, on all screen
   sizes, matching how the Model legend was already relocated.
2. The Clouds row in the weather panel should get a 50% reference line, the
   same visual treatment Wind's 10/20mph dashed lines already have — 50% is
   already the published, safety-code-cited cloud-cover threshold
   (`config.CLOUD_COVER_NOGO_PCT`), just not drawn as a line yet.
3. Add temperature-based warnings (heat and cold), following the same
   "majority of models agree" pattern wind/cloud already use, with a
   per-cell icon that opens contextual safety guidance. There's no rocketry
   safety-code number for this (unlike wind's Tripoli USC citation), so this
   needs real NWS criteria, verified directly against NWS's own published
   sources — not paraphrased or guessed at. NWS has no single national "Cold
   Weather Advisory" number (set per regional office, -15°F to -35°F wind
   chill) — resolved directly with the user: cite NWS's Wind Chill
   frostbite-time chart instead (a genuinely national NWS product), framed
   as "frostbite risk" (wind chill ≤ -19°F ≈ frostbite in ~30 min), not a
   named advisory implying one national threshold exists.

Full research/design detail (exact file:line references, verified formulas,
citation text) lives in the plan-mode transcript; this file tracks
implementation status per this repo's own convention.

## Tasks

### Task 1 — Rate editor above the map, every screen size
- [x] Move Rate block (`site/index.html:344-372`, currently in `.side-col`)
      into new `#rate-editor-row` right before `.map-view-wrap`
- [x] Relocate `#time-legend-block` next to `#accuracy-section`
- [x] Delete `.side-col`/"side" grid area; collapse `.layout` to single
      column at every width (`app.css:214-220`, `243-245`, `1465-1469`)
- [x] New `#rate-editor-row` flex-row CSS; override `.rate-toggle-row`'s
      `space-between`/fixed-`140px` width for row context
- [x] Verify wrap behavior at 375/390/430px

### Task 2 — Clouds 50% reference line
- [x] Rename `.wind-ref-line` → `.chart-ref-line` (`app.css:598` + JS call
      sites)
- [x] Insert reference line in `addCloudRow()` (`app.js:~2538`) at
      `DATA.cloud_nogo_pct`

### Task 3 — Temperature heat/cold warnings
- [x] `pull_live_forecast.py`: add `relative_humidity_2m` to
      `_hourly_variables()` (~line 104)
- [x] `splash_zones.py`: `build_temperature_data()` — add `humidity` to
      hourly cells only (not prior_day/morning)
- [x] `config.py`: add `HEAT_INDEX_ADVISORY_F=100`, `HEAT_INDEX_WARNING_F=105`,
      `WIND_CHILL_FROSTBITE_F=-19` with verbatim NWS citations; publish as
      `DATA.heat_index_advisory_f`/`heat_index_warning_f`/`wind_chill_frostbite_f`
- [x] `app.js`: `heatIndexF(tF, rh)` (NWS Rothfusz regression) and
      `windChillF(tF, mph)` (NWS formula) — both from **actual** temp only,
      never `.apparent` (Open-Meteo's apparent_temperature is the Steadman/
      Australian BOM formula, not NWS's — confirmed via
      github.com/open-meteo/open-meteo/discussions/651 — different formula,
      not interchangeable with NWS's cited thresholds)
- [x] `app.js`: `tempRiskTier()` majority-vote (mirrors `windTierMajority()`)
- [x] Wire into `addTempCell()`/`addTempRow()`, hourly only
- [x] New `.temp-risk-badge` + `#temp-risk-box`/`tempRiskBoxHTML()`, reusing
      `showRealFlightBox()`'s click-to-open/`positionBoxAvoiding()`/
      click-away pattern (not `.cell-hot::after`, not `.info-btn`/
      `data-hint`, not a bare `title` — none fit 3 distinct dynamic
      per-cell messages on a touch-first UI)
- [x] New `--cold-bg`/`--cold-border`/`--cold-text` tokens (light + both
      dark blocks)

### Verification (all tasks)
- [x] Spot-check `heatIndexF()`/`windChillF()` against known NWS values
      (96°F/65%RH→121°F; 0°F/15mph→-19°F)
- [x] Real pull + `splash_zones.py` run, confirm new JSON fields
- [x] In-browser Playwright: badge renders/colors/popup text correct,
      click-away closes, no false positives
- [x] Rate editor row at 1200/1024/375/390/430px, all interactions intact
- [x] Clouds line renders on every cloud-relevant site, light+dark theme
- [x] Full mode × view × viewport error sweep, zero console errors
- [x] CHANGELOG entries + README check before push

## Decisions

- Cold-weather citation: NWS frostbite-time chart (wind chill ≤ -19°F),
  not a regional "Cold Weather Advisory" number — user's explicit choice,
  since NWS has no single national cold threshold.
- Heat-index/wind-chill computed from **actual** temperature only, never
  `apparent_temperature` — confirmed Open-Meteo's apparent_temperature is
  the Steadman/Australian BOM formula (also factors in solar radiation),
  not NWS's Heat Index or Wind Chill formula; using it against NWS-cited
  thresholds would misrepresent what's being measured. User raised this
  directly as "wouldn't apparent already account for that" — resolved with
  the formula-identity evidence above, not just an assertion.
- `dew_point_2m` intentionally not pulled — Heat Index formula uses
  relative humidity, not dew point; no other consumer, would be unused
  scope.
- Rate/cloud/temp grading follows the existing wind/cloud convention:
  pipeline publishes raw values + a bare threshold constant, all
  majority-vote/tier logic lives client-side in app.js.

## Open questions

None outstanding — plan approved via ExitPlanMode 2026-08-12.
