# Adding a site

A step-by-step guide for pointing Splashcast at a new launch site — your own club's field, if you've forked this. Every site needs two things registered in the pipeline (a config entry and a recurring-launch rule in `launch_calendar.json`) plus a one-time map fetch; after that, the [cron jobs](../README.md#automation-cron-jobs) pick it up automatically with no further per-site setup.

## 1. Add the site to `config.SITES`

Open `pipeline/config.py` and add an entry to the `SITES` dict:

```python
"your_site_id": {
    "name": "Your Site Name", "club": "Your Club",
    "lat": 30.123456, "lon": -97.123456,
    "waiver_ft": 10000, "elev_m": 200.0, "cron_cutoff_hour_utc": 20,
},
```

- **`lat`/`lon`**: the real launch-rail coordinates, not a general airport/field reference point — this drives the pad marker position, the map crop, and every wind-pull location. Prefer the club's own stated coordinates over a guess; re-verify before trusting one for anything safety-critical.
- **`waiver_ft`**: your site's actual FAA waiver altitude (or practical ceiling, if the club caps lower than the paper waiver). Everything else — the apogee list, pressure levels pulled, map crop size — scales off this.
- **`elev_m`**: ground elevation in meters MSL. Get it from Open-Meteo's free elevation API, no key needed:
  ```bash
  curl "https://api.open-meteo.com/v1/elevation?latitude=30.123456&longitude=-97.123456"
  ```
- **`cron_cutoff_hour_utc`**: the last UTC hour the live-pull cron job should still pull for this site on launch day itself. `20` (i.e. 8pm UTC) covers a ~2-3pm Central launch window across both DST states; adjust if your site is in a different timezone (see the comment above `SITES` in `config.py` for the full reasoning).

## 2. Add a recurring launch-schedule rule

`pipeline/launch_calendar.json` is what tells the cron jobs *when* your site actually needs a pull — nothing gets pulled automatically just because a site exists in `config.SITES`. It's a plain JSON file, not Python: add an entry under `"clubs"` with your club's real recurring schedule, described as one or more rules. `pipeline/launch_schedule.py` is a generic interpreter for these rule shapes, not a place you need to write code.

The common case — a fixed nth-weekday-of-month, e.g. "3rd Saturday every month":

```json
"your_club": {
  "label": "Your Club",
  "rules": [
    {"type": "nth_weekday_monthly", "site_id": "your_site_id", "weekday": "SAT", "n": 3, "label": "Your Club"}
  ]
}
```

If your club's schedule doesn't fit that (has a fixed off-season, needs holiday-relative dates like Memorial Day weekend, alternates between two sites seasonally, or has no reproducible formula at all), there are three more rule `type`s already in use — `holiday_relative_multiday`, `seasonal_site_swap`, and `hand_entered` — see the existing `"aarg"`, `"tnt_seymour"`, and `"kloudbusters"` entries in `launch_calendar.json` for real examples of each, and `launch_schedule.py`'s own module docstring for the full parameter list per type.

**One-off exceptions** (a single cancelled/moved/added/uncertain date, without touching the recurring rule) go in the same file's `"overrides"` list — use the CLI instead of hand-editing JSON:

```bash
cd pipeline
python launch_schedule.py --cancel your_site_id 2026-07-18 "cancelled due to heat"
python launch_schedule.py --move your_site_id 2026-08-01 some_other_site_id --reason "field was plowed"
python launch_schedule.py --add your_site_id 2026-08-15 "extra August launch" --tentative
python launch_schedule.py --flag your_site_id 2026-09-05 "may move for a conflicting event, undecided"
```

Each of these validates the target date/site against the recurring schedule before writing (refuses if it doesn't match anything, rather than silently writing a no-op override) and auto-fills the club from `config.SITES`.

Verify it's wired up correctly:

```bash
cd pipeline
python launch_schedule.py --days-ahead 90   # your site's upcoming dates should show up in the list
```

## 3. Fetch map imagery

```bash
cd pipeline
python fetch_site_maps.py your_site_id     # satellite + road imagery for this one site
python fetch_site_maps.py --regional       # refreshes the regional site-picker map to include it
```

This pulls both a close-in "detail" crop and a wider "context" crop, sized relative to your site's waiver (a 50,000ft-waiver site gets a bigger box than a 6,000ft one), plus a road/street alternative to the satellite imagery for sites with no real terrain features to route around.

## 4. Pull a first capture and verify locally

```bash
cd pipeline
python pull_live_forecast.py <a-real-upcoming-date> --site your_site_id
python splash_zones.py <that-same-date> --site your_site_id
```

Then serve `site/` locally (`python -m http.server` from inside `site/` — opening `index.html` directly via `file://` won't work, the viewer loads its data via `fetch()`) and pick your new site from the dropdown. You should see real zones on the map. If you want an "actual" star marker and accuracy table to show up too without waiting a full week, `pull_live_forecast.py <past-date> --backfill --site your_site_id` pulls a full T-7..T-0 lead-time history in one shot via Open-Meteo's Single Runs API, and `pull_historical.py --site your_site_id --actual-only <that-date>` (then re-run `splash_zones.py` for that date) backfills the HRRR-analysis actual.

## 5. That's it — the cron jobs take over

Once your site is in `config.SITES` and has a rule entry in `launch_calendar.json`, the two scheduled GitHub Actions jobs (see the [README](../README.md#automation-cron-jobs)) will pull forecasts leading up to every future launch and the HRRR actual the day after, with no further per-site configuration. Nothing needs to be added to the workflow file itself — it iterates whatever `launch_schedule.py` reports.

If you're running this in your own fork, make sure your repo's **Settings → Actions → General → Workflow permissions** is set to "Read and write permissions" — the cron jobs commit their pulled data straight back to the repo, and that's off by default on most repos.
