# Changelog

Dated, terse log of notable changes. For the full design rationale and decision history, see [docs/spec.md](docs/spec.md).

## 2026-07-19

**Tripoli Houston South Site schedule narrowed**
- Was an all-year placeholder (4th Saturday every month); confirmed directly against tripolihouston.com/news-updates ("South site 4th Saturday of each month February thru August") and narrowed to that Feb-Aug season -- a member-only site that doesn't operate the rest of the year. The live cron job will stop attempting pulls for it outside that window.

## 2026-07-18

**Mobile UI**
- Map pan/zoom/pad-drag now work on touch (was mouse-only) — switched to Pointer Events, added pinch-to-zoom.
- Long always-visible info text (rail-buffer note, pad-drag hint) collapsed behind info buttons, matching the legend pattern.
- Mobile layout reordered (CSS Grid) so the altitude/model/rate legends land right after the map, before the longer notes.

**New sites**
- Added Tripoli Houston South Site (`tripoli_houston_south`, 17,500ft waiver) — coordinates unverified against the club directly, flagged for re-check. Scheduled 4th Saturday, every month (placeholder season, to be narrowed).
- Added SD Rocket Jockies to the launch schedule: 1st Saturday, April–October.

**Descent-rate physics**
- Descent rate now scales with air density at altitude (ICAO standard atmosphere) instead of being one constant fps for a whole descent phase — a drogue's real fall rate at 35,000ft is ~1.8x its rate below 5,000ft. Configured fps values are treated as each site's ground-level rate.
- Fixed a real bug found while building the above: site ground elevation was a single Hutto-only constant applied to every site. Now per-site (`config.SITES[site_id]["elev_m"]`, sourced from Open-Meteo's elevation API).
- Single-deploy points are no longer simulated above 10,000ft (dual-deploy unaffected) — not a realistic recovery config at altitude; no codified altitude threshold found in Tripoli's safety code, so this is a chosen convention, not a cited regulation.

**Per-site data pulls**
- Apogee altitude list redesigned: fixed tiered list (denser under 10k', coarser above) instead of one evenly-spaced formula, capped to each site's own waiver.
- Pressure levels requested for winds aloft are now sized per site's waiver (e.g. up to ~50,000ft for Argonia, ~6,000ft for Gunter/DARS) instead of one fixed ~12,000ft bracket for every site. Verified against the live Open-Meteo API (not just docs, which turned out wrong for ECMWF's real ceiling).
- All previously-published site/dates regenerated against every fix above.

**Schedule/site corrections**
- Tripoli Houston South Site coordinate corrected (29.222881,-95.097461 → 29.22320,-95.09726 — user's own direct knowledge of the rail setup, not the earlier unverified guess); maps re-fetched to keep the pad marker's pixel position accurate.
- TNT Seymour launches the Sunday right after their 4th-Saturday monthly launch too, not Saturday-only.

**Data reset for a clean history baseline**
- Cleared all in-session test captures (target dates 07-18 through 07-24 — pulled under a mix of pre- and post-fix bracket/altitude logic, no longer consistent) from both local working data and the published site.
- Pulled a fresh, consistent capture for every site targeting **2026-07-25** (next Saturday) — the first of what'll be a real accumulating multi-capture history through launch day, not backfilled/fake data.
- `pipeline/data/<site_id>/live/` (per-capture wind + splash-point history) is now tracked in git, not gitignored — needed so history persists across GitHub Actions' ephemeral runners once scheduled pulls are wired up, and so the History view has real data to show. Raw satellite PNGs and the old historical-archive pulls stay excluded (large, redundant/separate). Expiring or archiving older captures (e.g. to S3) is a deliberate later step, not built yet.

**Historical backfill (real T-7..T-0 history, not just forward-collected)**
- Added DARS's real schedule (`gunter_events()`, 3rd Saturday every month — confirmed directly from dars.org, DARS previously had no schedule entry at all).
- New reusable capability in `pull_live_forecast.py`: `fetch_model_at_run()`/`backfill_capture()`/`--backfill` CLI flag pull a *specific past model run* (Open-Meteo's Single Runs API — free tier, despite an initial summarized read of the pricing page wrongly suggesting otherwise; verified against the raw pricing table directly) instead of only "today's" forecast, so a whole T-7..T-0 lead-time history can be backfilled for a past date in one shot rather than waiting a week of daily pulls. Doesn't hardcode an archive cutoff anywhere — just tries each lead day and skips gracefully (logged, not fatal) whatever the API reports unavailable.
- Two real findings from building it: `precipitation_probability` fails the *entire* request on this endpoint (routes internally to an ensemble model that isn't available here) — dropped from the backfill's variable list only, live pull unaffected. GEM fails on every run tested regardless of date — tolerated the same as any other model missing from a capture, not root-caused further.
- Backfilled every site's most recent actually-scheduled Saturday (per each site's own schedule, one date per site — not an exhaustive multi-month history): Hutto 04-04, Apache Pass 07-04, Hearne 07-11, Argonia 07-11, Gunter 07-18, Seymour 05-25, Tripoli Houston South 06-27, SD Rocket Jockies 07-04. Real per-club cancellations/reschedules weren't individually verified (an early attempt to scrape AARG's groups.io for confirmed dates was dropped as unnecessary scope) — this is what the schedule formulas say, used as a reasonable stand-in to seed real data now; the archive floor (empirically ~2026-04-02 for most models) meant Hutto only got 3 lead-days (T-0..T-2) instead of the usual 7, since its target date sat right at that edge.

**Real "actual" points (the History view's star marker) + a model-accuracy table**
- `pull_historical.py` made multi-site (was Hutto-only) and now pulls HRRR's own f00 analysis (its data-assimilation output, not a forecast) at every `SPLASH_HOURS_LOCAL` hour, plus a surface wind sample to match the live pull's profile shape. Meant to run the day *after* a launch, not same-day — not because the data itself is delayed, but so HRRR's own archive has had time to fully publish that day's cycles before the pull goes looking for them.
- `splash_zones.py` runs that analysis through the same descent simulation as every forecast, populating `points_history.json`'s `actuals` key (previously always `{}`) — the star marker now shows something real instead of never rendering. Caught two real bugs building this: a timezone mismatch (Herbie's GRIB2 timestamps are UTC; the live pull's are local-labeled) and a JSON-serialization failure (`np.float32` values aren't serializable — needed explicit casts).
- New accuracy-vs-actual table in the viewer: distance from each model's forecast to the actual point, per lead time, shown only in History mode and only when actual data exists for the current selection. Color-coded using the fixed status-color scale (good→critical), binned by quartile rank *within that table* — not a fixed-feet scale, since 200ft is a great miss at a 50,000ft-waiver site and mediocre at a 6,000ft one.
- Backfilled the actual point for all 8 sites' already-pulled target dates and republished.

**Storage/timezone fix, History mode redesign, satellite/road map toggle**
- Fixed the actual capture-storage bug: `capture_date` is now explicit UTC (`datetime.now(timezone.utc).date()`) instead of `date.today()`, which resolved against whatever timezone the machine running it happens to be in — ambiguous on something like a GitHub Actions runner. Everything else already runs on UTC (matches the models' own UTC-anchored refresh cycles); the one place local time genuinely matters — when to stop pulling on launch day — is now `config.SITES[...]["cron_cutoff_hour_utc"]`, a stored per-site value (not live DST math), ready for the cron workflow.
- History mode redesigned: markers now use the same per-model colors as the main splash view (were black/shape-only before), with shape kept as a redundant colorblind-safe backup. "Forecast age" (capture date) is now a real selectable filter — hover/click like every other legend, was a static list — filtering both the map and the accuracy table so one lead time can be isolated across models.
- Added a satellite/road map layer toggle, persisted like the color pickers. `fetch_site_maps.py` now pulls a `World_Street_Map` layer alongside the existing satellite imagery for every site (same bounds/zoom, pixel-aligned, no other geometry needs to change) — some sites (Hutto) have no real terrain features to avoid, where satellite imagery is closer to visual noise than useful signal.
- Found and fixed a real regression while verifying the toggle: `#map-wrap`'s touch-pan `pointerdown` handler captures the pointer unconditionally, with no check for whether it started on a child button — this had silently broken the zoom +/−/Reset buttons too (confirmed against the currently-live committed code, not just today's changes), not only the new toggle. Fixed with the same `stopPropagation()` pattern already used for the pad marker. Verified with a real headless Chromium (installed natively, working around missing system libraries by extracting `.deb` packages without root) actually clicking through both button groups — not just read the code and assumed it worked.

**History mode: consensus splash polygon on hover**
- Hovering or pinning a "forecast age" row in History mode now draws the same buffer+core hull the main view uses, built from that one capture date's points across models (or just the isolated model, if one's also active) — lets the actual point be read against how big the projected area was that day, not just its distance to each individual model's point.

**Scheduled cron jobs — Open-Meteo leading up to launches, NOAA the day after**
- New `.github/workflows/cron-pulls.yml`, two jobs on independent schedules: `open-meteo-live` (every 6h) pulls the current forecast for every site with a launch 0–7 days out (`launch_schedule.py`'s new `run_live_pulls()`, gated per-site by `cron_cutoff_hour_utc`); `noaa-actuals` (daily) pulls the HRRR-analysis "actual" for every site that launched the day before (`run_actual_pulls()`, via `pull_historical.py`'s new `--actual-only` flag — a lean single-date pull instead of the full multi-week backfill). Both commit their pulled data straight back to `master`, which is what persists it across the ephemeral runner and triggers the Pages redeploy. Also runnable on demand via `workflow_dispatch`.
- Which sites/dates get pulled isn't hardcoded in the workflow — it's derived from `launch_schedule.py`'s real per-club recurring schedule, so a newly added site needs no workflow changes, just its own config + schedule-rule entries (see the new `docs/adding-a-site.md`).
- Two real bugs caught while testing the new path end to end against live data (not just dry-run): Open-Meteo's `forecast_days` param is anchored to its own resolved local "today" once a `timezone` param is passed, not our UTC `today` — during the ~7pm-midnight Central window where the UTC calendar date has already rolled over, that 1-day skew silently returned a horizon ending *before* the target date (confirmed: a real T-6 pull for a real upcoming launch came back with 0 rows in every model's launch window despite the request succeeding). Fixed with a 1-day safety margin. Separately, the cron schedule now fires at `:15` past each 6-hour UTC boundary rather than exactly on it, as a buffer for Open-Meteo's own documented "eventually consistent" multi-server sync (checked real per-model publish lag via their metadata API while investigating — it ranges ~80min to ~7h across models, well past what a fixed offset could target for all of them anyway; this is just avoiding a sync race, not chasing freshness).

**Comment cleanup**
- Passed over every comment in `pipeline/*.py`, `site/assets/js/app.js`, `site/assets/css/app.css`, and the GitHub Actions workflows: condensed multi-paragraph blocks, removed dev-history narration (dated "added 2026-07-18"/"user's call" tags — that's what git blame and this changelog are for) that had accumulated over the course of building this, and kept only what explains genuinely non-obvious *why* (API quirks, safety-code citations, accessibility verification numbers). Also caught and fixed a few comments that had gone stale and were describing old, no-longer-true architecture (e.g. a couple of "Hutto-only" claims left over from before multi-site support existed) — worth a periodic re-check as the single-site-origin comments age out.

**README rewrite + new "adding a site" guide**
- `README.md` rewritten from a short stub into a full overview: what the tool does, how it works, data sources, the cron automation, project layout, and a local-usage quickstart — condensed versions of what's explained at length in `docs/spec.md`/in the viewer's own on-page hints, not a duplicate of either.
- New `docs/adding-a-site.md`: step-by-step guide for forks pointing this at their own club/site (config entry, launch-schedule rule, map fetch, first pull, verifying locally) — the README's own "Adding a site" section stays short and links here for the detail.
