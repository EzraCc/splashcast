# Splashcast

A multi-model wind-drift and splash-zone viewer for high-power rocket launch sites. Given a launch site, apogee altitude, and recovery configuration, it shows where a rocket is likely to land under current forecast winds — as a convex-hull zone across several independent weather models (GFS, HRRR, ECMWF, ICON, ARPEGE, GEM), not a single point estimate.

**Live site: [ezracc.github.io/splashcast](https://ezracc.github.io/splashcast/)**

Built for the author's own Texas/Kansas/South Dakota rocketry clubs, but the pipeline is generic per-site config — see [Adding a site](docs/adding-a-site.md) if you want to point it at your own club's launch site.

## Contents

- [What it does](#what-it-does)
- [How it works](#how-it-works)
- [Data sources](#data-sources)
- [Automation (cron jobs)](#automation-cron-jobs)
- [Project layout](#project-layout)
- [Running it yourself](#running-it-yourself)
- [Adding a site](#adding-a-site)
- [Comparing a real flight against predictions](#comparing-a-real-flight-against-predictions)
- [Further reading](#further-reading)

## What it does

For each launch site and upcoming launch date, Splashcast:

- Pulls current wind forecasts from 6 independent weather models and simulates the descent (apogee to ground) for every combination of time-of-day, deploy type (single/dual), descent rate (fast/slow), and apogee altitude up to that site's waiver.
- Shows the resulting landing points as a **convex-hull zone** per altitude/time — not a single predicted point — plus a boost-angle buffer band accounting for non-vertical launches and weathercocking.
- Re-pulls daily in the week leading up to a launch, so you can see how the forecast (and the projected splash zone) has drifted as the launch date approaches — the **History** view mode.
- Once a launch date has passed, pulls NOAA's own HRRR analysis (its data-assimilation output, the closest free proxy to "what actually happened") and plots it as a star marker against every model's prior forecasts, with a per-model accuracy table.
- Lets you toggle satellite vs. road map imagery, drag the launch pad to try a nearby setup spot, and adjust the boost-angle buffer live — all client-side, no server.

It is **not** a go/no-go safety tool — it surfaces model spread and forecast-drift patterns for a launch director to read against their own approved landing zone and safety code, not a pass/fail call.

## How it works

Two halves:

- **`pipeline/`** (Python, never deployed) pulls wind data, runs the descent-drift simulation, and writes the results as JSON into `site/data/`.
- **`site/`** (static HTML/CSS/JS, deployed via GitHub Pages) reads that JSON and renders it — no backend, no build step, no framework.

For each altitude/time-of-day/deploy/rate combination, the pipeline integrates wind vectors from apogee down to the ground in small steps (descent rate itself scales with air density at altitude, not held constant), giving one landing point per model. The **zone** shown on the map is the convex hull of those points, plus an outer buffer band representing boost-phase/weathercocking uncertainty (`apogee_ft * tan(boost_angle)`, adjustable live via a slider in the viewer). Point color = model, point shape = descent rate, so identity survives without relying on color alone.

For the full design rationale (why convex hulls instead of a weighted average, why the boost-angle buffer exists, how the descent simulation itself works) see [`docs/spec.md`](docs/spec.md).

## Data sources

- **Live multi-model forecasts — [Open-Meteo](https://open-meteo.com/)** (free tier, no API key): GFS, HRRR, NAM, NBM (NOAA), plus ECMWF, DWD ICON, Météo-France ARPEGE, and Environment Canada GEM, each pulled from its own endpoint. Surface wind for all 8; pressure-level wind (winds aloft) for the 6 that expose it, sized per site to reach that site's own waiver altitude. Real per-model pressure-level coverage and forecast horizon vary quite a bit — see `config.py`'s `LIVE_PROFILE_MODELS` comment for the actual numbers. GEM's feed has been observed stale/unreliable on Open-Meteo's side; it's tolerated like any other model missing from a capture, not specially handled.
- **"Actual" landing point — NOAA HRRR, via [Herbie](https://herbie.readthedocs.io/)/AWS Open Data**: not a real post-flight GPS track (that's a possible future addition, not built), but HRRR's own `f00` analysis — its data-assimilation output at the model's init time, the closest free proxy to ground truth. Labeled `hrrr_f00_analysis` throughout, never claimed as "actual" outright. Pulled the day *after* a launch (not same-day) so HRRR's own archive has had time to finish publishing.
- **Satellite/road imagery — ArcGIS Online** (`World_Imagery`/`World_Street_Map`, free tier, no key), fetched once per site and re-fetched only if a site's coordinates or waiver change.
- **Burn-ban status — Texas A&M Forest Service**, Hutto/Williamson-County-specific (not yet generalized per-site).

## Automation (cron jobs)

Two scheduled GitHub Actions jobs in [`.github/workflows/cron-pulls.yml`](.github/workflows/cron-pulls.yml) keep every site's data current with no manual steps:

| Job | Schedule (UTC) | What it does |
|---|---|---|
| `open-meteo-live` | every 6h, at `:15` past 0/6/12/18 | Pulls the current forecast for every site with a launch 0–7 days out (`launch_schedule.py --run-live`), building that day's forecast-drift snapshot. Stops pulling for a site once its launch day is past a per-site cutoff hour (`config.SITES[...]["cron_cutoff_hour_utc"]`). |
| `noaa-actuals` | daily at 11:00 | Pulls the HRRR-analysis "actual" for every site that launched the day before (`launch_schedule.py --run-actuals`), populating the History view's star marker and accuracy table. |

Both jobs commit their output (`pipeline/data/`, `site/data/`, `site/maps/`) straight back to `master` when something changed — that's what makes the data survive past the ephemeral runner, and it's also what triggers [`pages.yml`](.github/workflows/pages.yml)'s redeploy. Which sites/dates get pulled isn't hardcoded anywhere — it's derived from each club's real recurring schedule in `launch_schedule.py` (see [Adding a site](docs/adding-a-site.md)), so a fork just needs its own schedule rule added there and the cron jobs pick it up automatically.

Both are also runnable on demand via the Actions tab's "Run workflow" button (`workflow_dispatch`, with a `live`/`actuals`/`both` picker) if you don't want to wait for the schedule.

## Project layout

```
pipeline/                Python: pulls data, runs the simulation, publishes JSON. Never deployed.
  config.py                 Per-site config (coordinates, waiver, elevation, cron cutoff) + shared constants.
  launch_schedule.py         Per-club recurring launch-day rules; the cron jobs' entry point.
  pull_live_forecast.py      Live Open-Meteo pull -- one capture per day, building forecast-drift history.
  pull_historical.py         NOAA HRRR-analysis "actual" pull + a separate multi-week backfill mode.
  splash_zones.py            Wind capture -> drift simulation -> convex-hull zone JSON for the viewer.
  fetch_site_maps.py         Satellite/road map imagery fetch, per site.
  analyze_real_flight.py     Real GPS-tracked flight vs. this pipeline's own forecasts/actuals (see below).
  data/                      Working data (gitignored raw pulls; live captures ARE tracked, see .gitignore).
site/                     The deployable static app -- no backend, no build step.
  index.html, assets/        Markup, CSS, and the viewer's JS (rendering, interaction, permalinks).
  maps/<site_id>/            Per-site satellite + road imagery.
  data/<site_id>/            Published zone JSON + points_history.json, one tree per site.
docs/
  spec.md                    Full design doc: problem statement, architecture, dated decision log.
  adding-a-site.md           Step-by-step guide for pointing this at a new club/site.
.github/workflows/
  cron-pulls.yml             The two scheduled data-pull jobs (see above).
  pages.yml                  Deploys site/ to GitHub Pages on every push to master.
CHANGELOG.md               Short, dated summary of notable changes.
```

## Running it yourself

Requires Python 3.11+ (developed and CI-tested against 3.14) and a virtualenv.

```bash
pip install -r pipeline/requirements-live.txt   # pull_live_forecast.py + splash_zones.py only
pip install -r pipeline/requirements.txt        # + pull_historical.py's herbie/cfgrib/eccodes stack

cd pipeline
python pull_live_forecast.py <target_date> --site <site_id>   # pull today's forecast for a site
python splash_zones.py <target_date> --site <site_id>         # turn a pull into published zone data
python pull_historical.py --site <site_id> --actual-only <past_date>  # pull the "actual" for a past date
python fetch_site_maps.py <site_id>                           # fetch satellite/road imagery for a site
python launch_schedule.py                                     # list upcoming scheduled launches, all sites
python launch_schedule.py --run-live --dry-run                # preview what the live cron job would pull today
```

Everything reads site config from `config.SITES` and takes `--site <site_id>` where applicable; all commands are run from inside `pipeline/`. To view the site locally, serve `site/` with anything that isn't `file://` (browsers block the `fetch()` calls the viewer uses to load JSON otherwise) -- e.g. `python -m http.server` from inside `site/`.

## Adding a site

Short version: add an entry to `config.SITES`, add a recurring-launch rule to `launch_schedule.py`, run `fetch_site_maps.py` once, then let the cron jobs take it from there.

Full step-by-step guide: **[docs/adding-a-site.md](docs/adding-a-site.md)**.

## Comparing a real flight against predictions

`pipeline/analyze_real_flight.py` takes a real GPS-tracker log and scores it against everything this pipeline already published for that site/date: derives real apogee (and the real boost-phase angle off vertical, measured from GPS rather than assumed), drogue/main descent rates, launch time, and landing point from the raw track; re-simulates using the real apogee + real rates + a real (HRRR-analysis) wind profile interpolated to the actual launch time; and reports the delta (both in feet and as a % of that day's actual drift distance, since 500ft reads very differently at a 3,500ft drift than at a 500ft one) against that self-simulation, every model's own same-day forecast, and whether the real landing fell inside the published splash zone.

The reusable comparison logic (flight segmentation, descent-rate derivation, wind-time blending, re-simulation, scoring) is source-format-agnostic. Turning a specific tracker's raw export into the plain sample list it consumes is not -- that's an intentionally small, separate loader function (`load_deluxe_tracker_csv()` is the one example so far) that's expected to be replaced or added to as more tracker formats show up, until there's a standard one to write a single general parser against.

Raw tracker logs are never committed (`pipeline/data/actuals/` is gitignored -- per-second GPS tracks can be large and identify a specific flier); only the derived summary JSON (apogee, rates, landing coordinates, deltas from predictions) is published, under `site/data/<site_id>/real_flights/`. When one exists for the currently-viewed target date, the History view plots it as its own marker (distinct from every model's shape and from the "actual" star) -- hover for a quick look, click to pin the info box open (click anywhere else to close it; on touch, where there's no hover, the first tap does the same job as a click). Clicking it also snaps the viewer's draggable "pad" crosshair to this flight's real launch-rail GPS offset, so the model/zone projections line up against where the rocket actually flew without dragging it there by hand -- released back to wherever it was on a normal close, though moving the pad yourself (drag, or its Reset button) closes the comparison instead of fighting your own placement.

## Further reading

- **[docs/spec.md](docs/spec.md)** — the project's running design doc: problem statement, architecture, and a dated decision log of *why* things are built the way they are.
- **[CHANGELOG.md](CHANGELOG.md)** — short, dated summary of notable changes.
