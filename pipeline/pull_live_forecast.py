"""Live multi-model forecast pull for a site's launch-day weather window.

Pulls the *current* forecast (not historical/archived data -- see
pull_historical.py for that) from Open-Meteo's free endpoints: NOAA's GFS/
HRRR/NAM/NBM plus ECMWF/DWD ICON/Meteo-France ARPEGE/Environment Canada GEM,
each on its own endpoint (config.LIVE_MODELS[key]["url"]) rather than one
shared URL. Pulls surface wind speed/direction/gust (10m) for all 8 models
-- gust is a surface-only diagnostic on Open-Meteo, not available at any
other height or pressure level -- and pressure-level wind at every level
the models offer up to each site's own ceiling
(config.levels_mb_for_site()) for the 6 in config.LIVE_PROFILE_MODELS -- NAM
(live-side only) and NBM have no
pressure-level profile here, so they're limited to near-surface heights
(config.LIVE_NBM_HEIGHTS_M for NBM). Also pulls cloud cover by layer
(low/mid/high -- the safety-code-relevant field, since no model exposes a
working cloud-base altitude here), precipitation, temperature, and CAPE (a
convective/lightning-risk proxy). Also checks Williamson County's burn-ban
status against the Texas A&M Forest Service's live feed (non-Open-Meteo).

Each run is checkpointed as its own dated "capture" under
data/<site>/live/{target_date}/captured_{capture_date}.parquet (+ a burn-ban
JSON sidecar), not one file per target_date -- running this daily against the
same upcoming launch builds a T-7..T-0 forecast-drift record per model, so
each day's snapshot has to survive the next day's run. If a prior capture
exists for the same target, a delta report against the most recent one is
printed automatically.

A T-0 (capture_date == target_date) pull that lands before
config.MORNING_SNAPSHOT_HOUR_LOCAL local time also gets frozen as a second
captured_{capture_date}_morning.parquet (save_capture()) -- the last one
written before that hour is what splash_zones.py's History mode uses for
T-0, so it reflects what a launch director actually saw before flying
rather than whichever same-day pull happened to run last.

Data-pull only, per the expansion spec: no go/no-go thresholds or
landing-zone math yet. Default target date is the coming Saturday; pass an
explicit YYYY-MM-DD to override (launches sometimes move to Sunday).
"""

import itertools
import json
import logging
import math
import re
import warnings
from datetime import date, datetime, time, timedelta, timezone
from pathlib import Path
from time import sleep as _sleep
from zoneinfo import ZoneInfo

import pandas as pd
import requests

import config

warnings.filterwarnings("ignore")
logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("splashcast.live")

_LEVEL_RE = re.compile(r"^(?P<var>.+)_(?P<value>\d+)(?P<unit>hPa|m)$")

# Measured directly against the real API (32 successful requests, mixed
# sites/models, 2026-07-30): mean 1.04s, median 1.05s, p90 1.37s, max 2.24s.
# 30s (the old value) meant a genuinely stuck request sat for a full 30s
# before either succeeding late or giving up -- with real successes never
# even approaching 3s, waiting anywhere near that long only delays detecting
# a real failure, not more often catching a slow-but-real response. 10s
# leaves ~4x headroom over the slowest success actually observed.
# Re-checked 2026-08-05 against argonia's grouped gfs/hrrr/nam/nbm request
# after levels_mb_for_site() stopped thinning to the apogee list (49 -> 124
# hourly variables, 88.7KB -> 229KB response): 0.72-1.08s over 5 requests,
# no meaningful latency change despite the ~2.6x larger payload -- Open-Meteo
# isn't request-size-bound here. Re-checked again same day after dropping
# geopotential_height_{lvl}hPa (124 -> 87 variables, 229KB -> 146.5KB):
# 0.71-0.97s over 5 requests, same conclusion. Timeout left as-is.
REQUEST_TIMEOUT_S = 10

STAT_LABELS = {
    "ground_wind_max": ("ground wind max", "mph"),
    "cloud_low_max": ("cloud low max", "%"),
    "cloud_mid_max": ("cloud mid max", "%"),
    "cloud_total_max": ("cloud total max", "%"),
    "temp_min": ("temp min", "F"),
    "temp_max": ("temp max", "F"),
    "cape_max": ("CAPE max", "J/kg"),
    "window_precip": ("window precip", "in"),
    "prior_precip": ("day-before precip", "in"),
}


def next_saturday(today: date) -> date:
    return today + timedelta(days=(5 - today.weekday()) % 7)


def _hourly_variables(model_key: str, site_id: str) -> list[str]:
    variables = [
        # wind_gusts_10m: confirmed live this is the ONLY height/level gust
        # exists at on Open-Meteo -- wind_gusts_{lvl}hPa and wind_gusts_{h}m
        # (other heights) both hard-error. There's no "gust aloft" to pull
        # even in principle, not just a field this repo chose to skip.
        "wind_speed_10m", "wind_direction_10m", "wind_gusts_10m",
        "cloud_cover", "cloud_cover_low", "cloud_cover_mid", "cloud_cover_high",
        "precipitation", "rain", "showers", "precipitation_probability",
        "temperature_2m", "apparent_temperature", "cape",
        # Added 2026-08 for the temperature-based heat/cold warnings --
        # NWS's own Heat Index formula needs relative humidity specifically
        # (not apparent_temperature, which is a different formula -- see
        # build_temperature_data()'s own comment). Confirmed live, real
        # non-null data from every one of this app's 8 models. dew_point_2m
        # deliberately not pulled -- Heat Index uses RH, not dew point, and
        # nothing else here would consume it.
        "relative_humidity_2m",
    ]
    if model_key == "nbm":
        for h in config.LIVE_NBM_HEIGHTS_M:
            variables += [f"wind_speed_{h}m", f"wind_direction_{h}m"]
    else:
        # Every pressure level the models offer up to this site's own
        # ceiling (config.levels_mb_for_site()) -- not one fixed bracket for
        # every site, and (since 2026-08) not thinned down to whatever the
        # user-facing altitude list happens to sample either. Wind only, not
        # geopotential_height_{lvl}hPa (dropped 2026-08) -- pulled since this
        # field existed but consumed nowhere: build_profile_single() places
        # each level via std_atm_ft()'s ICAO approximation, not a real
        # per-hour geometric height. Using it for that would be a genuine
        # accuracy improvement, but a separate change (alters every
        # published point's altitude mapping, needs its own validation
        # against the ISA baseline, touches pull_historical.py's parallel
        # path too) -- see docs/spec.md §9's "still open" list.
        for lvl in config.levels_mb_for_site(site_id):
            variables += [f"wind_speed_{lvl}hPa", f"wind_direction_{lvl}hPa"]
    return variables


def fetch_model(model_key: str, target_date: date, site_id: str = "hutto", attempts: int = 3, timeout: int = REQUEST_TIMEOUT_S) -> dict:
    # UTC throughout, not date.today() -- unambiguous regardless of the
    # runner's local timezone. The one place local time matters is the
    # per-site pull cutoff (config.py's cron_cutoff_hour_utc).
    today = datetime.now(timezone.utc).date()
    days_ahead = (target_date - today).days
    if days_ahead < 0:
        raise ValueError(
            f"target_date {target_date} is in the past -- this pulls live forecasts, "
            "not historical data (see pull_historical.py for that)"
        )
    site = config.SITES[site_id]
    model_info = config.LIVE_MODELS[model_key]
    params = {
        "latitude": site["lat"],
        "longitude": site["lon"],
        "hourly": ",".join(_hourly_variables(model_key, site_id)),
        "models": model_info["model"],
        "timezone": config.SITE_TZ,
        # +2, not +1: Open-Meteo appears to anchor forecast_days' countdown to
        # its own resolved "today" in the requested `timezone` (Central), not
        # our UTC `today` above. During the ~7pm-midnight Central window where
        # the UTC date has already rolled over but Central's hasn't, a bare
        # `days_ahead + 1` returns a horizon ending *before* target_date (the
        # launch window then lands entirely outside the response even though
        # the request succeeds). The extra day of margin is cheap insurance.
        "forecast_days": days_ahead + 2,
        "wind_speed_unit": "mph",
        "temperature_unit": "fahrenheit",
        "precipitation_unit": "inch",
    }
    if days_ahead == 0:
        params["past_days"] = 1

    # Observed in testing: Open-Meteo itself times out intermittently, not just
    # the burn-ban feed -- different models fail on different runs, not the
    # same one each time, so more than one attempt is worth it before giving
    # up to run()'s try/except.
    last_exc = None
    for attempt in range(attempts):
        if attempt:
            _sleep(1.0)  # don't immediately re-fire at a model that just timed out/failed
        try:
            # Session as a context manager, not requests.get() directly -- guarantees
            # the underlying connection is torn down the moment this raises (Session.
            # __exit__ always runs, even on exception), rather than leaving an
            # abandoned in-flight request for Open-Meteo to keep processing while we've
            # already stopped waiting on it and are about to fire attempt N+1.
            with requests.Session() as session:
                resp = session.get(model_info["url"], params=params, timeout=timeout)
                resp.raise_for_status()
                data = resp.json()
            if data.get("error"):
                raise RuntimeError(f"Open-Meteo error for {model_key}: {data.get('reason')}")
            return data
        except Exception as e:
            last_exc = e
            log.debug(f"{model_key} fetch attempt {attempt + 1}/{attempts} failed: {e}")
    raise last_exc


def fetch_grouped_models(model_keys: list[str], target_date: date, site_id: str = "hutto", attempts: int = 3, timeout: int = REQUEST_TIMEOUT_S) -> dict:
    """Like fetch_model(), but for several models that share one literal
    Open-Meteo endpoint (config.LIVE_MODELS[...]["url"]) -- gfs/hrrr/nam/nbm
    all live on /v1/gfs. One request with a comma-separated `models` param
    instead of one per model; Open-Meteo suffixes every hourly variable name
    with the model id (confirmed live), which _split_grouped_response()
    below undoes. Cuts request count against that specific endpoint, which
    run()'s loop comment ties directly to the observed back-to-back-hammering
    failures."""
    today = datetime.now(timezone.utc).date()
    days_ahead = (target_date - today).days
    if days_ahead < 0:
        raise ValueError(
            f"target_date {target_date} is in the past -- this pulls live forecasts, "
            "not historical data (see pull_historical.py for that)"
        )
    site = config.SITES[site_id]
    variables = []
    for mk in model_keys:
        for v in _hourly_variables(mk, site_id):
            if v not in variables:
                variables.append(v)
    params = {
        "latitude": site["lat"],
        "longitude": site["lon"],
        "hourly": ",".join(variables),
        "models": ",".join(config.LIVE_MODELS[mk]["model"] for mk in model_keys),
        "timezone": config.SITE_TZ,
        "forecast_days": days_ahead + 2,  # see fetch_model()'s own comment for the +2
        "wind_speed_unit": "mph",
        "temperature_unit": "fahrenheit",
        "precipitation_unit": "inch",
    }
    if days_ahead == 0:
        params["past_days"] = 1

    url = config.LIVE_MODELS[model_keys[0]]["url"]
    label = "+".join(model_keys)
    last_exc = None
    for attempt in range(attempts):
        if attempt:
            _sleep(1.0)
        try:
            with requests.Session() as session:
                resp = session.get(url, params=params, timeout=timeout)
                resp.raise_for_status()
                data = resp.json()
            if data.get("error"):
                raise RuntimeError(f"Open-Meteo error for {label}: {data.get('reason')}")
            return data
        except Exception as e:
            last_exc = e
            log.debug(f"{label} grouped fetch attempt {attempt + 1}/{attempts} failed: {e}")
    raise last_exc


def _split_grouped_response(raw: dict, model_keys: list[str], site_id: str = "hutto") -> dict[str, dict]:
    """Undo fetch_grouped_models()'s multi-model response, back into
    fetch_model()-shaped per-model dicts -- so parse_hourly() doesn't need
    to know a grouped request happened.

    Filters each model back down to its own _hourly_variables() set, not
    just whatever the combined response happens to include: the `hourly`
    param is shared across every model in the group, so e.g. nbm's height-
    level wind variables get requested (and Open-Meteo returns real,
    non-null data) for gfs/hrrr/nam too even though those models were never
    asked for them individually -- silently changing their stored schema
    otherwise (extra "height"-type wind rows alongside their normal
    "pressure"-type ones)."""
    hourly = raw["hourly"]
    units = raw.get("hourly_units", {})
    out = {}
    for mk in model_keys:
        suffix = f"_{config.LIVE_MODELS[mk]['model']}"
        wanted = set(_hourly_variables(mk, site_id))
        mk_hourly = {"time": hourly["time"]}
        mk_units = {}
        for name, values in hourly.items():
            if name.endswith(suffix):
                base = name[: -len(suffix)]
                if base not in wanted:
                    continue
                mk_hourly[base] = values
                if name in units:
                    mk_units[base] = units[name]
        out[mk] = {"hourly_units": mk_units, "hourly": mk_hourly}
    return out


# --- Historical backfill -----------------------------------------------------
# Separate from fetch_model() above -- hits Open-Meteo's Single Runs API
# (free tier, despite its pricing page's summary text suggesting otherwise)
# instead of the live-forecast endpoints, letting us pull a SPECIFIC past
# model run (run=<cycle time>) rather than only "the current forecast."
# Returns that run's full ~7-day horizon from its init time forward (no
# start_date/end_date param accepted), so backfill_capture() filters down to
# the target date after parsing.
#
# Archive floor is ~2026-04-02 for most models (checked empirically -- docs
# have been wrong here before). GEM errors on every run tested (raw
# "modelRunUnavailable" failure, unlike other models' clean JSON `error`
# shape) -- treated as "unavailable" like any other missing model, not
# root-caused further.
#
# precipitation_probability is dropped from the variable list here (unlike
# the live pull, which keeps it) -- requesting it against this endpoint fails
# the WHOLE request ("model run not available... Model: ncep_gefs05"), even
# with every other variable fine. It's ensemble-derived (needs spread across
# members) and this endpoint silently tries to route it to GEFS internally
# and fails, rather than nulling just that field the way live-forecast
# endpoints do for an unsupported variable.
SINGLE_RUNS_URL = "https://single-runs-api.open-meteo.com/v1/forecast"


def fetch_model_at_run(model_key: str, run_dt: datetime, site_id: str = "hutto", attempts: int = 3, timeout: int = REQUEST_TIMEOUT_S) -> dict:
    site = config.SITES[site_id]
    model_info = config.LIVE_MODELS[model_key]
    variables = [v for v in _hourly_variables(model_key, site_id) if v != "precipitation_probability"]
    params = {
        "latitude": site["lat"],
        "longitude": site["lon"],
        "hourly": ",".join(variables),
        "models": model_info["model"],
        "timezone": config.SITE_TZ,
        "run": run_dt.strftime("%Y-%m-%dT%H:%M"),
        "wind_speed_unit": "mph",
        "temperature_unit": "fahrenheit",
        "precipitation_unit": "inch",
    }
    last_exc = None
    for attempt in range(attempts):
        if attempt:
            _sleep(1.0)  # see fetch_model()'s own comment -- same reasoning applies here
        try:
            with requests.Session() as session:
                resp = session.get(SINGLE_RUNS_URL, params=params, timeout=timeout)
                resp.raise_for_status()
                data = resp.json()
            if data.get("error"):
                raise RuntimeError(f"Open-Meteo error for {model_key} @ run {run_dt}: {data.get('reason')}")
            return data
        except Exception as e:
            last_exc = e
            log.debug(f"{model_key} @ run {run_dt} fetch attempt {attempt + 1}/{attempts} failed: {e}")
    raise last_exc


def backfill_capture(target_date: date, lead_days: int, site_id: str = "hutto") -> tuple[pd.DataFrame, date]:
    """Like run(), but for a specific PAST target_date/lead_days combo instead
    of "today's" live forecast -- capture_date is derived (target_date minus
    lead_days), not date.today(). No burn-ban check (that's current-status
    only, meaningless for a backfilled past date)."""
    run_dt = datetime.combine(target_date - timedelta(days=lead_days), time(0, 0))
    capture_date = run_dt.date()
    frames = []
    for i, model_key in enumerate(config.LIVE_MODELS):
        if i:
            _sleep(0.5)  # observed transient 502s hammering this endpoint back-to-back with no pause
        try:
            raw = fetch_model_at_run(model_key, run_dt, site_id)
            df = parse_hourly(raw, model_key)
            if not df.empty:
                df = df[df["valid_time_local"].dt.date == target_date]
            frames.append(df)
        except Exception as e:
            log.warning(f"{model_key} backfill pull failed ({site_id}, target {target_date}, lead {lead_days}): {e}")
    combined = pd.concat(frames, ignore_index=True) if frames else pd.DataFrame()
    if not combined.empty:
        combined["target_date"] = target_date
        combined["capture_date"] = capture_date
        combined["lead_time_days"] = lead_days
    return combined, capture_date


def _split_variable(name: str) -> tuple[str, str | None, float | None]:
    match = _LEVEL_RE.match(name)
    if not match:
        return name, None, None
    var, value, unit = match.group("var"), float(match.group("value")), match.group("unit")
    return var, ("pressure" if unit == "hPa" else "height"), value


def parse_hourly(raw: dict, model_key: str) -> pd.DataFrame:
    """Flatten Open-Meteo's {variable_name: [values]} response into a tidy long table."""
    hourly = raw["hourly"]
    units = raw.get("hourly_units", {})
    times = pd.to_datetime(hourly["time"])
    rows = []
    for name, values in hourly.items():
        if name == "time":
            continue
        var, level_type, level_value = _split_variable(name)
        unit = units.get(name)
        for t, v in zip(times, values):
            if v is None:
                continue
            rows.append(
                {
                    "model": model_key,
                    "valid_time_local": t,
                    "variable": var,
                    "level_type": level_type,
                    "level_value": level_value,
                    "value": v,
                    "unit": unit,
                }
            )
    return pd.DataFrame(rows)


# A different host from Open-Meteo entirely (tfsfrp.tamu.edu, Texas A&M
# Forest Service -- a tiny static text file, not a computed forecast), so
# REQUEST_TIMEOUT_S's justification doesn't transfer -- measured this one
# separately: 8 real requests, mean 0.29s, median 0.29s, max 0.31s. Even
# faster and tighter than Open-Meteo's own numbers, as expected for a static
# file vs. a computed response, but kept a wider margin (~16x the observed
# max, vs. Open-Meteo's ~4x) since this is a smaller sample against a single
# small government feed server, not the larger check Open-Meteo itself got.
BURN_BAN_TIMEOUT_S = 5


def fetch_burn_ban(county: str, attempts: int = 3, timeout: int = BURN_BAN_TIMEOUT_S) -> dict:
    # This endpoint has been observed to time out intermittently (not a one-off
    # in testing) -- more than one attempt is worth it before giving up to
    # run()'s own try/except.
    last_exc = None
    for attempt in range(attempts):
        if attempt:
            _sleep(1.0)  # same reasoning as fetch_model()'s own comment
        try:
            with requests.Session() as session:
                resp = session.get(config.BURN_BAN_URL, timeout=timeout)
                resp.raise_for_status()
                text = resp.content.decode("utf-16")
            lines = [line.strip() for line in text.splitlines() if line.strip()]
            counties = set(lines[1:])
            return {
                "supported": True,
                # Explicit .isoformat() (with tzinfo, not the naive
                # datetime.utcnow() this used to be) -- guarantees a real
                # offset marker in the published JSON (json.dump's
                # default=str fallback on a naive datetime produced an
                # ambiguous "2026-07-31 14:33:53.253923" with no timezone at
                # all), so the viewer can parse it reliably instead of
                # guessing which zone a bare string is in.
                "checked_at": datetime.now(timezone.utc).isoformat(),
                "feed_header": lines[0] if lines else "",
                "county": county,
                "active": county in counties,
                "counties_under_ban": sorted(counties),
            }
        except Exception as e:
            last_exc = e
            log.debug(f"burn ban fetch attempt {attempt + 1}/{attempts} failed: {e}")
    raise last_exc


# Retry timing for a model still missing after both the immediate attempts
# (fetch_model()/fetch_grouped_models()'s own 3x retry) and, for grouped
# models, the individual-pull fallback below. Not about a single stuck
# request -- every request already has a hard 10s timeout (REQUEST_TIMEOUT_S)
# inside a `with requests.Session()` block, so a request can never hang past
# that regardless of retries. This is for the case where Open-Meteo itself is
# having a bad few minutes (a real "surge" on their side, not our own
# back-to-back hammering -- that's what grouping already reduced): firing
# right back at it within the same minute just catches the same surge again.
#
# Polls every SURGE_RETRY_POLL_S instead of taking one long blind wait --
# sites are pulled sequentially (run_pulls_for() in launch_schedule.py calls
# pull_live_forecast.py once per site via a blocking subprocess.run(), not in
# parallel -- parallel would only load the shared endpoint harder, the
# opposite of what grouping above is for), so a slow site's wait fully
# blocks every site queued after it. A single blind wait pays the full
# ceiling even when the surge clears in under a minute; polling recovers as
# soon as it actually does, while still capping at SURGE_RETRY_MAX_WAIT_S
# total so one bad site can't run away with the whole job. Same constants for
# every site/model -- this is app-level pacing, not something tuned per
# launch site. Not a loop past that ceiling -- if it's still down after 15min
# of real surge room, this isn't the only chance to recover the data anyway,
# since the next scheduled cron run is at most 6h away and will try again
# fresh.
SURGE_RETRY_POLL_S = 60
SURGE_RETRY_MAX_WAIT_S = 900

# Open-Meteo's forecast_days parameter caps at 16 regardless of model
# (https://open-meteo.com/en/docs -- GFS/ECMWF's own real horizons top out
# right around there too, the longest of the 8 models here). fetch_model()/
# fetch_grouped_models() request forecast_days = days_ahead + 2 (their own
# margin, see that comment), so the largest days_ahead a request can ever
# actually satisfy is MAX_FORECAST_DAYS_PARAM - 2. Requesting further out
# doesn't degrade gracefully to "fewer models available" the way a real
# coverage gap does -- every single model 400s immediately (confirmed live,
# 2026-08-11: a 61-day-out pull for a brand-new site failed all 8 the same
# way), and that used to fall straight into the SURGE_RETRY_MAX_WAIT_S loop
# above on the wrong assumption it was a transient surge -- burning a full
# 15 minutes to fail the exact same way it already failed instantly.
# Checked in run(), before any request goes out -- not worth the surge-retry
# treatment at all, since no amount of waiting fixes an out-of-range date.
MAX_FORECAST_DAYS_PARAM = 16


def _fetch_one_model(model_key: str, target_date: date, site_id: str) -> pd.DataFrame | None:
    """fetch_model() + parse_hourly(), collapsed to None (and logged) on
    failure instead of raising -- shared by run()'s main pass, its grouped-
    request fallback, and its surge retry, so each has one place to fail."""
    try:
        raw = fetch_model(model_key, target_date, site_id)
        return parse_hourly(raw, model_key)
    except Exception as e:
        log.warning(f"{model_key} pull failed: {e}")
        return None


def run(target_date: date, site_id: str = "hutto") -> tuple[pd.DataFrame, dict | None, date]:
    # UTC, not date.today() -- see fetch_model()'s comment above. capture_date
    # is the key every downstream file is named/deduped by (save_capture(),
    # available_captures(), points_history.json's per-day entries), so it has
    # to be unambiguous regardless of what machine runs this. A same-UTC-day
    # re-pull (the T-3..T-0 cron window firing more than once) intentionally
    # overwrites the same capture_date's file -- one retained data point per
    # day, not a bug.
    capture_date = datetime.now(timezone.utc).date()
    days_ahead = (target_date - capture_date).days
    max_days_ahead = MAX_FORECAST_DAYS_PARAM - 2
    if days_ahead > max_days_ahead:
        log.error(
            f"target_date {target_date} is {days_ahead} days out -- past every model's real forecast "
            f"horizon ({max_days_ahead} days_ahead max, see MAX_FORECAST_DAYS_PARAM's own comment). "
            "Not attempting the pull -- every model would 400 immediately and this isn't a transient "
            "failure worth surge-retrying."
        )
        return pd.DataFrame(), None, capture_date
    frames = []
    failed_models = []
    # Models sharing one literal Open-Meteo endpoint (gfs/hrrr/nam/nbm, all
    # on /v1/gfs) are pulled together via fetch_grouped_models() -- one
    # request instead of four against that endpoint, directly addressing the
    # back-to-back-hammering failures below (gunter's gfs+hrrr pull failed in
    # 18/18 consecutive real cron runs, always the 2nd site processed, right
    # after another site's own 8-request burst against the same endpoint).
    groups: dict[str, list[str]] = {}
    for model_key in config.LIVE_MODELS:
        groups.setdefault(config.LIVE_MODELS[model_key]["url"], []).append(model_key)

    for i, model_keys in enumerate(groups.values()):
        if i:
            _sleep(0.5)  # same reasoning as fetch_model_at_run()'s loop -- observed transient
            # 502s/timeouts hammering these endpoints back-to-back with no pause.
        if len(model_keys) == 1:
            model_key = model_keys[0]
            df = _fetch_one_model(model_key, target_date, site_id)
            if df is not None:
                frames.append(df)
            else:
                failed_models.append(model_key)
            continue
        try:
            raw = fetch_grouped_models(model_keys, target_date, site_id)
            for model_key, model_raw in _split_grouped_response(raw, model_keys, site_id).items():
                frames.append(parse_hourly(model_raw, model_key))
        except Exception as e:
            # The grouped request failed as a whole -- rather than lose every
            # model in the group to what might be one bad request, fall back
            # to pulling each individually (the pre-grouping behavior), so a
            # group failure degrades to "however many of these still work"
            # instead of "all of them are gone this capture."
            log.warning(f"{'+'.join(model_keys)} grouped pull failed ({e}) -- falling back to individual pulls")
            for model_key in model_keys:
                df = _fetch_one_model(model_key, target_date, site_id)
                if df is not None:
                    frames.append(df)
                else:
                    failed_models.append(model_key)

    if failed_models:
        log.warning(
            f"{', '.join(failed_models)} still missing after immediate attempts + fallback -- "
            f"polling every {SURGE_RETRY_POLL_S}s (up to {SURGE_RETRY_MAX_WAIT_S // 60}min total) "
            "in case it's a transient Open-Meteo-side surge"
        )
        still_failed = failed_models
        waited = 0
        while still_failed and waited < SURGE_RETRY_MAX_WAIT_S:
            _sleep(SURGE_RETRY_POLL_S)
            waited += SURGE_RETRY_POLL_S
            retry_now, still_failed = still_failed, []
            for model_key in retry_now:
                df = _fetch_one_model(model_key, target_date, site_id)
                if df is not None:
                    frames.append(df)
                else:
                    still_failed.append(model_key)
        if still_failed:
            log.warning(f"{', '.join(still_failed)} still failed after {waited}s of surge polling -- giving up for this capture")
        else:
            log.info(f"recovered {', '.join(failed_models)} after {waited}s of surge polling")

    combined = pd.concat(frames, ignore_index=True) if frames else pd.DataFrame()
    if not combined.empty:
        combined["target_date"] = target_date
        combined["capture_date"] = capture_date
        combined["lead_time_days"] = (target_date - capture_date).days

    # Every Texas site maps to its own real county (config.BURN_BAN_COUNTY_BY_SITE);
    # Kansas/South Dakota sites have no equivalent statewide feed to check at
    # all, so they get an explicit "not supported" marker rather than either
    # silently reusing another site's county or a bare None -- None is reserved
    # for "we tried to check and the request itself failed" (status genuinely
    # unknown), which is a different situation from "there's nothing to check
    # here" and downstream (summarize(), delta_report(), and eventually the
    # site UI) needs to tell them apart instead of showing a false green/red.
    county = config.BURN_BAN_COUNTY_BY_SITE.get(site_id)
    if county is None:
        burn_ban = {"supported": False}
    else:
        try:
            burn_ban = fetch_burn_ban(county)
        except Exception as e:
            log.warning(f"burn ban check failed: {e}")
            burn_ban = None

    return combined, burn_ban, capture_date


# --- Per-day capture storage -------------------------------------------------
# Keyed by (target_date, capture_date) rather than target_date alone -- running
# this daily against the same upcoming launch must not overwrite yesterday's
# snapshot, since the day-to-day drift *is* the thing being logged. Lives
# under pipeline/data/ -- internal working data, never published to site/.

def capture_dir(target_date: date, site_id: str = "hutto") -> Path:
    d = Path(config.DATA_DIR) / site_id / "live" / str(target_date)
    d.mkdir(parents=True, exist_ok=True)
    return d


def save_capture(
    df: pd.DataFrame, burn_ban: dict | None, target_date: date, capture_date: date,
    site_id: str = "hutto", is_morning_snapshot: bool = False,
) -> Path:
    d = capture_dir(target_date, site_id)
    out_path = d / f"captured_{capture_date}.parquet"
    df.to_parquet(out_path)
    with open(d / f"captured_{capture_date}_burnban.json", "w") as f:
        json.dump(burn_ban, f, default=str)
    if is_morning_snapshot:
        # A second, distinctly-named copy -- deliberately re-written by
        # every T-0 pull that still lands before MORNING_SNAPSHOT_HOUR_LOCAL
        # (so the latest of those wins: "closest point before launch
        # start"), then left untouched by every later-in-the-day pull once
        # local time passes that hour. The out_path file above keeps
        # getting overwritten all day regardless, same as always -- that's
        # what keeps the live/current maps fresh "as people fly." This copy
        # exists so History mode's T-0 row (build_points_history() in
        # splash_zones.py) has something to read that wasn't clobbered by a
        # pull that happened hours after launches were already over. Caller
        # (this module's __main__) decides is_morning_snapshot -- it needs
        # real wall-clock "now," which only makes sense for a live pull, not
        # backfill_capture()'s retrospective one.
        df.to_parquet(d / f"captured_{capture_date}_morning.parquet")
    return out_path


def available_captures(target_date: date, site_id: str = "hutto") -> list[date]:
    out = []
    for p in capture_dir(target_date, site_id).glob("captured_*.parquet"):
        try:
            out.append(date.fromisoformat(p.stem.removeprefix("captured_")))
        except ValueError:
            continue
    return sorted(out)


def load_capture(target_date: date, capture_date: date, site_id: str = "hutto") -> tuple[pd.DataFrame, dict | None]:
    d = capture_dir(target_date, site_id)
    df = pd.read_parquet(d / f"captured_{capture_date}.parquet")
    ban_path = d / f"captured_{capture_date}_burnban.json"
    burn_ban = json.loads(ban_path.read_text()) if ban_path.exists() else None
    return df, burn_ban


# --- Stats / reporting -------------------------------------------------------

def _stat(window: pd.DataFrame, var: str, level_type: str | None = None, level_value: float | None = None, agg: str = "max"):
    sub = window[window["variable"] == var]
    if level_type is not None:
        sub = sub[sub["level_type"] == level_type]
    if level_value is not None:
        sub = sub[sub["level_value"] == level_value]
    if sub.empty:
        return None
    return getattr(sub["value"], agg)()


def window_stats(df: pd.DataFrame, target_date: date) -> dict[str, dict | None]:
    """Per-model launch-window + day-before stats. Shared by summarize() and delta_report()."""
    window_start = datetime.combine(target_date, time(config.LAUNCH_WINDOW_START_HOUR_LOCAL, 0))
    window_end = datetime.combine(target_date, time(config.LAUNCH_WINDOW_END_HOUR_LOCAL, 0))
    prior_day_start = datetime.combine(target_date - timedelta(days=1), time(0, 0))

    out: dict[str, dict | None] = {}
    if df.empty:
        return out
    for model_key in df["model"].unique():
        m = df[df["model"] == model_key]
        window = m[(m["valid_time_local"] >= window_start) & (m["valid_time_local"] <= window_end)]
        if window.empty:
            out[model_key] = None
            continue
        prior = m[(m["valid_time_local"] >= prior_day_start) & (m["valid_time_local"] < window_start.replace(hour=0))]
        out[model_key] = {
            "ground_wind_max": _stat(window, "wind_speed", "height", 10.0, "max"),
            "cloud_low_max": _stat(window, "cloud_cover_low", agg="max"),
            "cloud_mid_max": _stat(window, "cloud_cover_mid", agg="max"),
            "cloud_total_max": _stat(window, "cloud_cover", agg="max"),
            "temp_min": _stat(window, "temperature", "height", 2.0, "min"),
            "temp_max": _stat(window, "temperature", "height", 2.0, "max"),
            "cape_max": _stat(window, "cape", agg="max"),
            "window_precip": window[window["variable"] == "precipitation"]["value"].sum(),
            "prior_precip": prior[prior["variable"] == "precipitation"]["value"].sum(),
        }
    return out


def _hour_ampm(h: int) -> str:
    return f"{h % 12 or 12}{'am' if h < 12 else 'pm'}"


def rain_stats(df: pd.DataFrame, target_date: date) -> dict[str, dict | None]:
    """Per-model rain accounting for a cancel/no-go call -- can't fly in
    rain, and wet fields (soaked grass/dirt access roads) can cancel a
    launch even on a dry launch day if it rained heavily beforehand. All
    four figures are sums of the same hourly `precipitation` values already
    pulled for every model (no extra request needed -- it's in every
    capture's base variable list regardless of this function).

    - morning_precip: midnight-8am target_date (before setup starts).
    - launch_precip: config.RAIN_WINDOW_START/END_HOUR_LOCAL (8am-4pm),
      distinct from window_stats()'s wider 8am-5pm LAUNCH_WINDOW -- see that
      constant's own comment for why they're deliberately different.
    - day_before_precip: the full calendar day immediately before
      target_date (local midnight to midnight) -- ground-wetness signal,
      independent of whether target_date itself sees any rain at all.
    - hourly_precip: one figure per config.SPLASH_HOURS_LOCAL hour (the same
      9/11/1/3 slots shown throughout the viewer), each summing that hour's
      own bucket plus the one before it -- e.g. "9am" sums the 8:00 and 9:00
      hourly values (which together cover rain fallen 8:00-10:00 local,
      since each hourly value is precip *during* that clock hour) -- read as
      "around 9am," not "starting at 9am."
    """
    morning_start = datetime.combine(target_date, time(0, 0))
    morning_end = datetime.combine(target_date, time(config.RAIN_WINDOW_START_HOUR_LOCAL, 0))
    launch_start = datetime.combine(target_date, time(config.RAIN_WINDOW_START_HOUR_LOCAL, 0))
    launch_end = datetime.combine(target_date, time(config.RAIN_WINDOW_END_HOUR_LOCAL, 0))
    day_before_start = datetime.combine(target_date - timedelta(days=1), time(0, 0))
    day_before_end = datetime.combine(target_date, time(0, 0))

    out: dict[str, dict | None] = {}
    if df.empty:
        return out
    for model_key in df["model"].unique():
        m = df[(df["model"] == model_key) & (df["variable"] == "precipitation")]
        if m.empty:
            out[model_key] = None
            continue

        def window_sum(start, end):
            w = m[(m["valid_time_local"] >= start) & (m["valid_time_local"] < end)]
            return float(w["value"].sum())

        hourly_precip = {}
        for h in config.SPLASH_HOURS_LOCAL:
            same_day = m["valid_time_local"].dt.date == target_date
            bucket = m[same_day & m["valid_time_local"].dt.hour.isin([h - 1, h])]
            hourly_precip[h] = float(bucket["value"].sum())

        out[model_key] = {
            "morning_precip": window_sum(morning_start, morning_end),
            "launch_precip": window_sum(launch_start, launch_end),
            "day_before_precip": window_sum(day_before_start, day_before_end),
            "hourly_precip": hourly_precip,
        }
    return out


def format_rain_summary(rain: dict[str, dict | None]) -> str:
    lines = [
        f"Rain (in): morning 12am-{_hour_ampm(config.RAIN_WINDOW_START_HOUR_LOCAL)} | "
        f"launch {_hour_ampm(config.RAIN_WINDOW_START_HOUR_LOCAL)}-{_hour_ampm(config.RAIN_WINDOW_END_HOUR_LOCAL)} | "
        "day before (full day) | around each sampled hour (±1hr bucket)"
    ]
    for model_key, r in rain.items():
        if r is None:
            lines.append(f"[{model_key}] no precip data")
            continue
        hourly_str = " / ".join(f"{_hour_ampm(h)} {r['hourly_precip'][h]:.2f}" for h in config.SPLASH_HOURS_LOCAL)
        lines.append(
            f"[{model_key}] morning {r['morning_precip']:.2f} | launch {r['launch_precip']:.2f} | "
            f"day before {r['day_before_precip']:.2f} | {hourly_str}"
        )
    return "\n".join(lines)


_COMPASS_POINTS = ["N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE", "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW"]


def compass(degrees: float) -> str:
    return _COMPASS_POINTS[int(degrees / 22.5 + 0.5) % 16]


def _compass_range(dirs: list[float]) -> str:
    lo, hi = compass(min(dirs)), compass(max(dirs))
    return lo if lo == hi else f"{lo}-{hi}"


def _circular_mean_deg(degrees: list[float]) -> float:
    sin_sum = sum(math.sin(math.radians(d)) for d in degrees)
    cos_sum = sum(math.cos(math.radians(d)) for d in degrees)
    return math.degrees(math.atan2(sin_sum, cos_sum)) % 360


def _circular_diff_deg(a: float, b: float) -> float:
    diff = abs(a - b) % 360
    return min(diff, 360 - diff)


def _split_consensus(readings: dict[str, tuple[float, float]]) -> tuple[list[str], list[str]]:
    """readings: {model: (speed_mph, direction_deg)}. Returns (consensus_models, outlier_models).

    Finds the largest subset of models that are all *mutually* within
    config.WIND_SPEED_AGREEMENT_MPH / WIND_DIR_AGREEMENT_DEG of each other (a
    clique in the pairwise-agreement graph), not the models closest to a
    single shared mean -- a mean-based approach can fragment two genuine
    clusters (e.g. 2 models near 16mph, 2 near 25mph) into "everyone's an
    outlier" groups, since the mean sits in the gap between them. Brute-force
    over subsets is fine at this scale (<=8 models).
    """
    models = list(readings)
    if len(models) <= 1:
        return models, []

    def mutually_agree(a, b):
        spd_a, dir_a = readings[a]
        spd_b, dir_b = readings[b]
        return abs(spd_a - spd_b) <= config.WIND_SPEED_AGREEMENT_MPH and _circular_diff_deg(dir_a, dir_b) <= config.WIND_DIR_AGREEMENT_DEG

    best_clique: list[str] = []
    for size in range(len(models), 1, -1):
        for combo in itertools.combinations(models, size):
            if all(mutually_agree(a, b) for a, b in itertools.combinations(combo, 2)):
                best_clique = list(combo)
                break
        if best_clique:
            break

    if len(best_clique) < 2:
        return [], models
    outliers = [m for m in models if m not in best_clique]
    return best_clique, outliers


def hourly_wind_table(df: pd.DataFrame, target_date: date) -> str:
    """Hour-by-hour ground wind across the window: a consensus range for the
    models that roughly agree, with only the divergent model(s) called out by
    name -- not a full column per model. The day-wide max/min in
    window_stats() can hide a pattern like "calm at 10am, gusty by 2pm," so
    this gets its own table. Direction is shown alongside speed since it
    changes which speeds are actually a concern (e.g. at Hutto, southerly
    winds drift away from the road, northerly toward it). No safe/hazard
    classification applied -- this just surfaces both numbers for a launch
    director to judge.
    """
    window_start = datetime.combine(target_date, time(config.LAUNCH_WINDOW_START_HOUR_LOCAL, 0))
    window_end = datetime.combine(target_date, time(config.LAUNCH_WINDOW_END_HOUR_LOCAL, 0))

    in_window = (df["valid_time_local"] >= window_start) & (df["valid_time_local"] <= window_end)
    is_10m = (df["level_type"] == "height") & (df["level_value"] == 10.0)
    speed = df[(df["variable"] == "wind_speed") & is_10m & in_window]
    direction = df[(df["variable"] == "wind_direction") & is_10m & in_window]
    if speed.empty:
        return "(no ground wind data in window)"

    speed_pivot = speed.pivot_table(index="valid_time_local", columns="model", values="value")
    dir_pivot = direction.pivot_table(index="valid_time_local", columns="model", values="value")
    models = [m for m in config.LIVE_MODELS if m in speed_pivot.columns]

    header = "  Hour  |  Wind (models in agreement)  |  Differs"
    lines = [header, "  " + "-" * (len(header) - 2)]
    for t in speed_pivot.index:
        readings = {}
        for m in models:
            spd = speed_pivot.loc[t, m] if m in speed_pivot.columns else None
            drc = dir_pivot.loc[t, m] if m in dir_pivot.columns and t in dir_pivot.index else None
            if pd.notna(spd) and pd.notna(drc):
                readings[m] = (float(spd), float(drc))
        missing = [m for m in models if m not in readings]

        consensus, outliers = _split_consensus(readings)

        if len(consensus) >= 2:
            speeds = [readings[m][0] for m in consensus]
            dirs = [readings[m][1] for m in consensus]
            speed_str = f"{min(speeds):.0f} mph" if max(speeds) - min(speeds) < 1 else f"{min(speeds):.0f}-{max(speeds):.0f} mph"
            consensus_str = f"{speed_str} {_compass_range(dirs)}"
        elif len(readings) == 1:
            m = next(iter(readings))
            spd, drc = readings[m]
            consensus_str = f"{spd:.0f} mph {compass(drc)}"
        else:
            consensus_str = "n/a"

        differs = [f"{m.upper()}: {readings[m][0]:.0f} mph {compass(readings[m][1])}" for m in outliers]
        if missing:
            differs.append(f"({'/'.join(m.upper() for m in missing)} beyond horizon)")

        lines.append(f"  {t:%H:%M}  |  {consensus_str:<28} |  {'; '.join(differs)}")
    lines.append("  (direction = where the wind is blowing FROM, e.g. \"S\" drifts north, away from the road)")
    return "\n".join(lines)


def summarize(df: pd.DataFrame, target_date: date, burn_ban: dict | None) -> str:
    lines = [f"=== Splashcast live forecast for {target_date} ({config.LAUNCH_WINDOW_START_HOUR_LOCAL}am-{config.LAUNCH_WINDOW_END_HOUR_LOCAL - 12}pm Central) ==="]
    if burn_ban is None:
        lines.append("Burn ban: check failed (see warning above) -- status unknown")
    elif not burn_ban.get("supported", True):
        lines.append("Burn ban: not tracked for this site (no statewide feed for this state)")
    else:
        lines.append(
            f"Burn ban ({burn_ban['county']}): {'ACTIVE' if burn_ban['active'] else 'not active'} "
            f"(feed: {burn_ban['feed_header']})"
        )

    stats = window_stats(df, target_date)
    if not stats:
        lines.append("No model data retrieved -- all pulls failed.")
        return "\n".join(lines)

    lines.append("")
    lines.append(hourly_wind_table(df, target_date))
    lines.append("")

    def fmt(v, suffix=""):
        return f"{v:.0f}{suffix}" if v is not None else "n/a"

    for model_key, s in stats.items():
        if s is None:
            lines.append(f"[{model_key}] no data in launch window (likely beyond this model's forecast horizon)")
            continue
        # NBM has no low/mid/high breakdown (always null, see config.py) -- only
        # the blended total, so its line falls back to that instead of "n/a/n/a".
        if s["cloud_low_max"] is None and s["cloud_mid_max"] is None:
            cloud_str = f"total max {fmt(s['cloud_total_max'], '%')} (no low/mid breakdown for this model)"
        else:
            cloud_str = f"low/mid max {fmt(s['cloud_low_max'], '%')}/{fmt(s['cloud_mid_max'], '%')}"

        lines.append(
            f"[{model_key}] ground wind up to {fmt(s['ground_wind_max'], ' mph')} | "
            f"cloud {cloud_str} | "
            f"temp {fmt(s['temp_min'])}-{fmt(s['temp_max'], 'F')} | "
            f"window precip {s['window_precip']:.2f}in | day-before precip {s['prior_precip']:.2f}in | "
            f"CAPE max {fmt(s['cape_max'], ' J/kg')}"
        )

    lines.append("")
    lines.append(format_rain_summary(rain_stats(df, target_date)))
    return "\n".join(lines)


def delta_report(
    target_date: date,
    capture_date: date,
    stats_today: dict,
    burn_ban_today: dict | None,
    prev_capture_date: date,
    stats_prev: dict,
    burn_ban_prev: dict | None,
) -> str:
    lead_prev = (target_date - prev_capture_date).days
    lead_today = (target_date - capture_date).days
    lines = [f"--- Delta vs {prev_capture_date} capture (T-{lead_prev}d -> T-{lead_today}d) ---"]

    today_unsupported = burn_ban_today is not None and not burn_ban_today.get("supported", True)
    prev_unsupported = burn_ban_prev is not None and not burn_ban_prev.get("supported", True)
    if today_unsupported or prev_unsupported:
        pass  # nothing to compare -- this site has no burn-ban coverage, not an error
    elif burn_ban_today is None or burn_ban_prev is None:
        lines.append("(burn ban comparison unavailable -- a check failed on one of the two days)")
    elif burn_ban_today["active"] != burn_ban_prev["active"]:
        was = "ACTIVE" if burn_ban_prev["active"] else "not active"
        now = "ACTIVE" if burn_ban_today["active"] else "not active"
        lines.append(f"BURN BAN CHANGED: {was} ({prev_capture_date}) -> {now} ({capture_date})")

    for model_key in sorted(set(stats_today) | set(stats_prev)):
        s_today, s_prev = stats_today.get(model_key), stats_prev.get(model_key)
        if s_today is None and s_prev is None:
            continue
        if s_today is None:
            lines.append(f"[{model_key}] now beyond forecast horizon (was in range on {prev_capture_date})")
            continue
        if s_prev is None:
            lines.append(f"[{model_key}] newly in forecast horizon (wasn't in range on {prev_capture_date})")
            continue

        deltas = []
        for key, (label, unit) in STAT_LABELS.items():
            a, b = s_prev.get(key), s_today.get(key)
            if a is None or b is None or abs(b - a) < 0.005:
                continue
            sign = "+" if b - a > 0 else ""
            deltas.append(f"{label} {sign}{b - a:.2f}{unit} ({a:.1f}->{b:.1f})")
        lines.append(f"[{model_key}] " + ("; ".join(deltas) if deltas else "no meaningful change"))

    return "\n".join(lines)


if __name__ == "__main__":
    import argparse

    parser = argparse.ArgumentParser()
    parser.add_argument("target_date", nargs="?", type=date.fromisoformat, default=next_saturday(date.today()))
    parser.add_argument("--site", default="hutto", choices=list(config.SITES))
    parser.add_argument("--backfill", action="store_true", help="target_date is in the past -- pull its full T-7..T-0 lead-time history via the Single Runs API instead of today's live forecast")
    args = parser.parse_args()
    target_date, site_id = args.target_date, args.site

    if args.backfill:
        for lead_days in config.LEAD_DAYS:
            df, capture_date = backfill_capture(target_date, lead_days, site_id)
            if df.empty:
                log.warning(f"[{site_id}] no data for {target_date} at lead {lead_days}d (run {capture_date}) -- skipping, not saved")
                continue
            out_path = save_capture(df, None, target_date, capture_date, site_id)
            log.info(f"[{site_id}] backfilled {target_date} T-{lead_days}d (run {capture_date}): {len(df)} rows -> {out_path}")
        raise SystemExit(0)

    df, burn_ban, capture_date = run(target_date, site_id)
    log.info(f"[{site_id}] Pulling live forecast for {target_date} (captured {capture_date}, T-{(target_date - capture_date).days}d)")

    # Real wall-clock "now" -- only meaningful here (the live path), not in
    # the --backfill branch above, which reads archived model-run times with
    # no "did I check before 9am" question to ask. See save_capture()'s
    # is_morning_snapshot comment for what this gates.
    now_local_hour = datetime.now(ZoneInfo(config.SITE_TZ)).hour
    is_morning_snapshot = capture_date == target_date and now_local_hour < config.MORNING_SNAPSHOT_HOUR_LOCAL

    out_path = save_capture(df, burn_ban, target_date, capture_date, site_id, is_morning_snapshot=is_morning_snapshot)
    log.info(f"Wrote {len(df)} rows to {out_path}" + (" (+ morning snapshot)" if is_morning_snapshot else ""))

    print(summarize(df, target_date, burn_ban))

    prior_captures = [d for d in available_captures(target_date, site_id) if d < capture_date]
    if prior_captures:
        prev_capture_date = max(prior_captures)
        prev_df, prev_burn_ban = load_capture(target_date, prev_capture_date, site_id)
        print()
        print(
            delta_report(
                target_date, capture_date,
                window_stats(df, target_date), burn_ban,
                prev_capture_date,
                window_stats(prev_df, target_date), prev_burn_ban,
            )
        )
    else:
        print(f"\n(first capture for {target_date} -- no delta yet)")
