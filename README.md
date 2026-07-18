# Splashcast

A multi-model wind-drift and splash-zone viewer for high-power rocket launch sites. Given a launch site, apogee altitude, and recovery configuration, it shows where a rocket is likely to land under current forecast winds — as a convex-hull zone across several independent weather models (GFS, HRRR, ECMWF, ICON, ARPEGE, GEM), not a single point estimate.

Live site: published via GitHub Pages from `site/` on every push to `master`.

## Layout

- **`pipeline/`** — Python: pulls wind data, runs the descent-drift simulation, builds the zone data the viewer reads. Never deployed; `pipeline/data/` (raw captures) is gitignored.
- **`site/`** — the deployable static app: `index.html` + `assets/` (CSS/JS) + `maps/` (per-site satellite imagery) + `data/` (published zone JSON, one tree per site).
- **`docs/spec.md`** — the project's running design doc: problem statement, architecture, and a dated decision log of *why* things are built the way they are. Start there for context beyond what's in code comments.
- **`CHANGELOG.md`** — short, dated summary of notable changes.

## Running the pipeline

All scripts read site config from `pipeline/config.py` (`config.SITES`) and take `--site <site_id>` where applicable.

```
python pull_live_forecast.py <target_date> --site <site_id>   # pull today's forecast for a site
python splash_zones.py <target_date> --site <site_id>         # turn a pull into published zone data
python fetch_site_maps.py <site_id>                           # fetch satellite imagery for a new site
python launch_schedule.py                                     # list upcoming scheduled launches across all sites
```

`pull_historical.py` is a separate, still Hutto-only archival pull (NOAA GRIB2 via Herbie) used for forecast-drift/seasonal-skill research — not part of the per-site live pipeline above.

## Adding a site

Add an entry to `config.SITES` (coordinates, waiver altitude, elevation), then run `fetch_site_maps.py`, `pull_live_forecast.py`, and `splash_zones.py` for it. See `docs/spec.md` §8/§9 for the full history of how multi-site support was built.
