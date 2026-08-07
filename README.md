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

- Pulls current wind forecasts from 6 independent weather models and lets you simulate the descent (apogee to ground) for any combination of time-of-day, deploy type (single/dual), apogee altitude up to that site's waiver, and editable Fast/Slow drogue/main descent rates — the simulation itself runs live in the browser from the published wind profile, not precomputed server-side.
- Shows the resulting landing points as a **convex-hull zone** per altitude/time — not a single predicted point — plus a boost-angle buffer band accounting for non-vertical launches and weathercocking.
- Re-pulls daily in the week leading up to a launch, so you can see how the forecast (and the projected splash zone) has drifted as the launch date approaches — the **History** view mode.
- Shows per-model ground wind, cloud cover, rain, and temperature (in that order) together in one combined weather panel below the map — a shared `Prior day | Morning | 9am | 11am | 1pm | 3pm` header whose 4 hour columns double as the map's own time-of-day selector, so there's one hour control instead of two duplicated ones. Wind (speed/gust/direction, 10m AGL) leads the panel and grades each cell green/yellow/orange/red on a graduated scale topping out at the one real cited limit (Tripoli USC §9-3 / NAR's Model Rocket Code, 20mph sustained). Clouds gets its own heading (with a "Show all altitudes" toggle) since it's the one metric here spanning more than a single row (low/mid/high, waiver-aware), and flags an hour where a majority of models agree it's at/above the safety-code cloud-cover threshold. Rain sums (not just samples) the hours it doesn't show a dedicated column for into the nearest kept one, so a passing shower can't hide inside a dropped hour. Temperature scales to that capture's own real range rather than a fixed scale (a Texas August day and a South Dakota April one have almost no overlap) and toggles between actual air temperature and Open-Meteo's combined "feels like" figure (default). Collapsible as a whole, plus a burn-ban status chip/overlay for sites with a real per-county feed to check.
- Shows each model's actual predicted **descent path in 3D** — not just the final landing point — from a chosen apogee down to the ground, in a collapsible panel below the map with its own orbit/zoom canvas, view-preset buttons (3D/Top/E/N — Top matches the 2D map's own north-up/east-right orientation exactly), and a vertical slider to explore any apogee live. Hovering a line shows that point's model, altitude, and wind speed/direction. Dots mark each model's own real reported wind-profile levels, so a model with sparser vertical resolution visibly shows fewer of them. A toggleable satellite/road ground plane (same imagery and geo-registration the 2D map uses) sits under the paths so drift is readable against real terrain, not just labeled axes.
- Once a launch date has passed, pulls NOAA's own HRRR analysis (its data-assimilation output, the closest free proxy to "what actually happened") and plots it as a star marker against every model's prior forecasts, with a per-model accuracy table.
- Lets you toggle satellite vs. road map imagery, drag the launch pad to try a nearby setup spot, and adjust the boost-angle buffer live — all client-side, no server.
- Lets you narrow the apogee-altitude list to a min/max range (a vertical slider beside the altitude legend, with the row list graying out whatever falls outside it) — useful once a tall-waiver site's list runs to 20+ options — on top of the existing per-altitude hover/pin isolation.
- Lets you type an exact predicted apogee instead of picking from the altitude list — since the drift sim runs client-side against any altitude, not just the list's own values, this is aimed at a flyer with one real predicted apogee rather than a launch director surveying several possible flights (who'd use the range selector above instead).
- Lets you edit the Fast/Slow descent-rate presets directly (drogue + main fps; hover/click a rate's own row to isolate/pin it on the map) — real observed rates on a given rocket/recovery setup often diverge from the defaults, and the map updates live as you type. Main is hard-capped at 35 fps (Tripoli USC §11-1's max landing speed), with a warning if you try to exceed it.
- Lets you toggle individual weather models on/off (click a model in the legend, like a checkbox — all start selected) or solo just one (double-click) — the zone hull is recomputed client-side from whichever subset is checked, and the weather panel's own per-model bars (wind/clouds/rain/temp) follow the same selection.

It is **not** a go/no-go safety tool — it surfaces model spread and forecast-drift patterns for a launch director to read against their own approved landing zone and safety code, not a pass/fail call. The viewer itself carries a disclaimer to the same effect: an aid for planning, not legal advice, and not a substitute for checking with local authorities on burn bans and other applicable rules.

## How it works

Two halves:

- **`pipeline/`** (Python, never deployed) pulls wind data and writes it as a compact per-model wind profile (speed/direction by altitude) into `site/data/`, along with the descent-sim constants needed to reproduce the simulation exactly.
- **`site/`** (static HTML/CSS/JS, deployed via GitHub Pages) runs the descent-drift simulation itself, client-side, for whatever altitude/deploy/rate/time-of-day is currently selected — no backend, no build step, no framework.

For the current altitude/time-of-day/deploy/rate combination, the viewer integrates wind vectors from apogee down to the ground in small steps (descent rate itself scales with air density at altitude, not held constant), giving one landing point per model — the same integration the pipeline used to run server-side, ported to JS so it can respond live to the altitude slider, deploy toggle, and the editable Fast/Slow drogue/main rate inputs. The **zone** shown on the map is the convex hull of those points, plus an outer buffer band representing boost-phase/weathercocking uncertainty (`apogee_ft * tan(boost_angle)`, adjustable live via a slider in the viewer). Point color = model, point shape = descent rate, so identity survives without relying on color alone.

For the full design rationale (why convex hulls instead of a weighted average, why the boost-angle buffer exists, how the descent simulation itself works) see [`docs/spec.md`](docs/spec.md).

## Data sources

- **Live multi-model forecasts — [Open-Meteo](https://open-meteo.com/)** (free tier, no API key): GFS, HRRR, NAM, NBM (NOAA), plus ECMWF, DWD ICON, Météo-France ARPEGE, and Environment Canada GEM. Surface wind speed/direction/gust for all 8 (gust is a surface-only diagnostic on Open-Meteo — confirmed live it doesn't exist at any other height or pressure level); pressure-level wind (winds aloft) for the 6 that expose it, at every level the models offer up to that site's own ceiling — not thinned down to the viewer's apogee-altitude options. Real per-model pressure-level coverage and forecast horizon vary quite a bit — see `config.py`'s `LIVE_PROFILE_MODELS` comment for the actual numbers. GEM's feed has been observed stale/unreliable on Open-Meteo's side; it's tolerated like any other model missing from a capture, not specially handled. GFS/HRRR/NAM/NBM share one literal Open-Meteo endpoint and are pulled together in a single grouped request rather than four separate ones — see [Automation](#automation-cron-jobs) for the retry/fallback behavior around that.
- **"Actual" landing point — NOAA HRRR, via [Herbie](https://herbie.readthedocs.io/)/AWS Open Data**: not a real post-flight GPS track (that's a possible future addition, not built), but HRRR's own `f00` analysis — its data-assimilation output at the model's init time, the closest free proxy to ground truth. Labeled `hrrr_f00_analysis` throughout, never claimed as "actual" outright. Pulled the day *after* a launch (not same-day) so HRRR's own archive has had time to finish publishing.
- **Satellite/road imagery — ArcGIS Online** (`World_Imagery`/`World_Street_Map`, free tier, no key), fetched once per site and re-fetched only if a site's coordinates or waiver change.
- **Burn-ban status — Texas A&M Forest Service**, checked per-site against each Texas site's real county (`config.BURN_BAN_COUNTY_BY_SITE`). Kansas/South Dakota sites have no equivalent statewide machine-readable feed and are marked explicitly unsupported rather than silently checked against the wrong county.

## Automation (cron jobs)

Two scheduled GitHub Actions jobs in [`.github/workflows/cron-pulls.yml`](.github/workflows/cron-pulls.yml) keep every site's data current with no manual steps:

| Job | Schedule (UTC) | What it does |
|---|---|---|
| `open-meteo-live` | every 6h, at `:15` past 0/6/12/18 | Pulls the current forecast for every site with a launch 0–7 days out (`launch_schedule.py --run-live`), building that day's forecast-drift snapshot. Stops pulling for a site once its launch day is past a per-site cutoff hour (`config.SITES[...]["cron_cutoff_hour_utc"]`). |
| `noaa-actuals` | daily at 11:00 | Pulls the HRRR-analysis "actual" for every site that launched the day before (`launch_schedule.py --run-actuals`), populating the History view's star marker and accuracy table. |

Both jobs commit their output (`pipeline/data/`, `site/data/`, `site/maps/`) straight back to `main` when something changed — that's what makes the data survive past the ephemeral runner, and it's also what triggers [`pages.yml`](.github/workflows/pages.yml)'s redeploy. Which sites/dates get pulled isn't hardcoded anywhere — it's derived from `pipeline/launch_calendar.json` (each club's recurring schedule, plus one-off cancel/move/add/flag exceptions for a single date -- see [Adding a site](docs/adding-a-site.md)), interpreted generically by `launch_schedule.py`. A fork just needs its own rule entry added to that file and the cron jobs pick it up automatically; a cancelled or moved launch (`launch_schedule.py --cancel`/`--move`) stops (or redirects) its pulls with no code change.

Both are also runnable on demand via the Actions tab's "Run workflow" button (`workflow_dispatch`, with a `live`/`actuals`/`both` picker) if you don't want to wait for the schedule.

The live pull is resilient to transient Open-Meteo failures at a few layers: models sharing one endpoint are requested together to cut request count, a group that fails as a whole falls back to pulling each model individually, and any model still missing after that gets polled every 60s (up to a 15-minute ceiling) in case it's a short-lived surge on Open-Meteo's side rather than a real outage — recovers as soon as the surge actually clears instead of always waiting out the full ceiling, but still bounded, since the next scheduled run is at most 6h away regardless. Sites are pulled strictly sequentially, not in parallel (parallel would only load Open-Meteo's shared endpoint harder), so a slow site's retries do delay whatever's queued after it in the same run. See `pull_live_forecast.py`'s `run()` and `SURGE_RETRY_POLL_S`/`SURGE_RETRY_MAX_WAIT_S`.

## Project layout

```
pipeline/                Python: pulls data, runs the simulation, publishes JSON. Never deployed.
  config.py                 Per-site config (coordinates, waiver, elevation, cron cutoff) + shared constants.
  launch_calendar.json       Per-club recurring launch-day rules + one-off cancel/move/add/flag exceptions (data, not code).
  launch_schedule.py         Generic interpreter for launch_calendar.json; the cron jobs' entry point.
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
  pages.yml                  Deploys site/ to GitHub Pages on every push to main.
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

The reusable comparison logic (flight segmentation, descent-rate derivation, wind-time blending, re-simulation, scoring) is source-format-agnostic. Turning a specific tracker's raw export into the plain sample list it consumes is not -- that's an intentionally small, separate loader function per format (`load_deluxe_tracker_csv()`, `load_aim_xtra_csv()`, `load_blueraven_lr_csv()`, `load_fluctus_fbb()`) that's expected to be replaced or added to as more tracker formats show up, until there's a standard one to write a single general parser against.

Not every altimeter has GPS, and even one that does can lose its fix exactly when it matters most. Real apogee altitude and real descent rates are still fully recoverable from the barometer alone either way, but boost-phase drift can't be *measured* without a real apogee GPS fix -- only *estimated*, by assuming the wind-only descent simulation is accurate and backing the boost-phase offset out of the difference between that simulation and some other real position. Which real position depends on what's available: `analyze_no_gps()` (a true no-GPS altimeter, `load_blueraven_lr_csv()`/BlueRaven) has only the real landing point to work with -- launch-rail and landing positions there are hand-recorded GPS pins, and because apogee is solved to match the landing point exactly, the predicted landing is a tautology, not an independent check. `analyze_partial_gps()` (a tracker whose GPS just isn't trustworthy at apogee specifically, `load_fluctus_fbb()`, confirmed on one flight where the ascent-phase fix never got a real 3D lock but tracking resumes partway down the descent) anchors to that closer real mid-descent fix instead -- a shorter, more locally-accurate extrapolation than reaching all the way to the landing point -- which means predicted landing there *is* a genuine, independently-scored prediction. Either way the apogee estimate is flagged end to end (`apogee.position_source`, a dedicated note in the viewer's info box) and never presented as if it were a measurement -- see each function's own docstring for the reasoning.

Raw tracker logs are never committed (`pipeline/data/actuals/` is gitignored -- per-second GPS tracks can be large and identify a specific flier); only the derived summary JSON (apogee, rates, landing coordinates, deltas from predictions) is published, under `site/data/<site_id>/real_flights/`. When one exists for the currently-viewed target date, the History view plots it as its own marker (distinct from every model's shape and from the "actual" star) -- hover for a quick look, click to pin the info box open (click anywhere else to close it; on touch, where there's no hover, the first tap does the same job as a click). Hovering/clicking also reveals this flight's launch-rail and apogee positions (real or, for a no-GPS flight, estimated) and its own predicted landing, and snaps the viewer's draggable "pad" crosshair to this flight's real launch-rail GPS offset, so the model/zone projections line up against where the rocket actually flew without dragging it there by hand -- released back to wherever it was on a normal close, though moving the pad yourself (drag, or its Reset button) closes the comparison instead of fighting your own placement.

## Further reading

- **[docs/spec.md](docs/spec.md)** — the project's running design doc: problem statement, architecture, and a dated decision log of *why* things are built the way they are.
- **[CHANGELOG.md](CHANGELOG.md)** — short, dated summary of notable changes.
