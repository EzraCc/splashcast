Status: done
Priority: medium
Type: new-feature
Last updated: 2026-09-22

# Accuracy table column downloads

## Context

Requested directly: make the published forecast/actual JSON data downloadable
from the site, based on how it's actually stored rather than inventing a new
layout. User explicitly ruled out a single "download everything" zip and
asked for the download to live at the History accuracy table's T-x column
headers, with actuals under a new T+1 column.

Storage check (done before implementing, see prior conversation turn):
`site/data/<site>/live/<target_date>/splash_zones_captured_<capture_date>.json`
is one file per (site, target_date, capture_date), all models bundled
inside -- but not every capture date in `HISTORY.captures` actually has one
of these on disk (older/backfilled captures via `pull_historical.py` only
ever wrote the raw parquet + folded into `points_history.json`, never a full
JSON snapshot -- confirmed 2 of 8 missing for hutto/2026-09-05). Ground-truth
("actual") wind data has no standalone file at all -- it only ever lives
inside `points_history.json`'s own `actual_wind_profile` field.

## Tasks
- [x] `downloadJSON(filename, dataObj)` helper (`app.js`) -- Blob + object
      URL + synthetic `<a download>` click, no server involved.
- [x] `.download-btn` CSS (`app.css`) -- same 15px round-icon convention as
      `.info-btn`/`.zone-color-reset-btn`, added to the same coarse-pointer
      touch-target expansion.
- [x] `renderAccuracyTable()` (`app.js`): download icon in each T-x `<th>`,
      downloading `HISTORY.wind_profiles_by_capture[captureDate]`; new
      "T+1 (actual)" `<th>` (only when `HISTORY.actual_wind_profile`
      exists) downloading that field; empty dash cells added under the T+1
      column in every model row so the table stays rectangular.
- [x] Verified via headless-Chromium: T-7 (2026-08-29, no file on disk)
      still downloads correct real wind data; T+1 downloads the actual
      profile; no console errors; a site/date with the table hidden
      (no actuals yet) is unaffected.

## Decisions
- Build every download from `HISTORY`'s already-loaded in-memory data, not
  a direct link to the static per-capture JSON file -- the file doesn't
  reliably exist for every capture date (see Context), so a direct link
  would have been a dead link for ~1/4 of columns on a real site/date.
  `HISTORY.wind_profiles_by_capture`/`actual_wind_profile` are guaranteed
  present for every column this table ever renders, since they're the same
  data the table's own accuracy numbers are computed from.
- Actuals labeled "T+1", not a separate heading scheme -- it's
  chronologically the real post-launch pull, continuing the same T-axis
  rather than reading as an unrelated column.
- Download scope is wind profiles only (per capture) / the actual wind
  profile only -- not the fuller `splash_zones_captured_*.json` shape
  (clouds/rain/temp/burn-ban/descent_params), since that fuller file isn't
  reliably available for every column anyway and the accuracy table's own
  subject is wind-driven drift, not the whole weather panel.

## Open questions
(none)
