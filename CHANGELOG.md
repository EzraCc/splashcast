# Changelog

Dated, terse log of notable changes. For the full design rationale and decision history, see [docs/spec.md](docs/spec.md).

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
