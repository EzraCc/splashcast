"""Live multi-model forecast pull for the Hutto launch-day weather window.

Pulls the *current* forecast (not historical/archived data -- see
pull_historical.py for that) from Open-Meteo's free endpoints -- NOAA's GFS/
HRRR/NAM/NBM plus, added 2026-07-17, four other national agencies' models
(ECMWF, DWD ICON, Meteo-France ARPEGE, Environment Canada GEM), each on its
own endpoint (config.LIVE_MODELS[key]["url"]) rather than one shared URL:
  - surface wind (10m) for all 8 models, and pressure-level wind up to each
    site's own waiver altitude (config.levels_mb_for_site(), added 2026-07-18
    -- previously one fixed ~12,000ft bracket for every site regardless of
    waiver) for the 6 in config.LIVE_PROFILE_MODELS -- NAM (live-side only)
    and NBM have no pressure-level profile here, so they're limited to
    surface/near-surface (config.LIVE_NBM_HEIGHTS_M for NBM specifically),
    same limitation as the historical pull for NBM, but a live-API-specific
    gap for NAM (its historical/GRIB2 data does have it).
  - cloud cover by layer (low/mid/high) -- the safety-code-relevant field,
    since no model exposes a working cloud-base/ceiling altitude here.
  - precipitation (total/rain/showers/probability), temperature, and CAPE
    (a convective/lightning-risk proxy -- there's no direct lightning
    forecast field available).
Also checks Williamson County's burn-ban status against the Texas A&M Forest
Service's live feed (a separate, non-Open-Meteo source).

Each run is checkpointed as its own dated "capture" under
data/live/{target_date}/captured_{capture_date}.parquet (+ a burn-ban JSON
sidecar) rather than one file per target_date -- running this daily against
the same upcoming launch is the point (building a T-7..T-0 forecast-drift
record per model), so each day's snapshot has to survive the next day's run
instead of being overwritten by it. If a prior capture exists for the same
target, a delta report against the most recent one is printed automatically.

Data-pull only, per the expansion spec: no go/no-go thresholds or
landing-zone math yet -- those come later once a launch director defines the
actual cutoffs. Default target date is the coming Saturday; pass an explicit
YYYY-MM-DD to override (launches sometimes move to Sunday for weather).
"""

import itertools
import json
import logging
import math
import re
import warnings
from datetime import date, datetime, time, timedelta
from pathlib import Path
from time import sleep as _sleep

import pandas as pd
import requests

import config

warnings.filterwarnings("ignore")
logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("splashcast.live")

_LEVEL_RE = re.compile(r"^(?P<var>.+)_(?P<value>\d+)(?P<unit>hPa|m)$")

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
        "wind_speed_10m", "wind_direction_10m",
        "cloud_cover", "cloud_cover_low", "cloud_cover_mid", "cloud_cover_high",
        "precipitation", "rain", "showers", "precipitation_probability",
        "temperature_2m", "cape",
    ]
    if model_key == "nbm":
        for h in config.LIVE_NBM_HEIGHTS_M:
            variables += [f"wind_speed_{h}m", f"wind_direction_{h}m"]
    else:
        # Per-site since 2026-07-18 (config.levels_mb_for_site()) -- sized to
        # reach this site's own waiver instead of one fixed bracket for
        # every site regardless of how tall its waiver actually is.
        for lvl in config.levels_mb_for_site(site_id):
            variables += [f"wind_speed_{lvl}hPa", f"wind_direction_{lvl}hPa", f"geopotential_height_{lvl}hPa"]
    return variables


def fetch_model(model_key: str, target_date: date, site_id: str = "hutto", attempts: int = 2) -> dict:
    today = date.today()
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
        "forecast_days": days_ahead + 1,
        "wind_speed_unit": "mph",
        "temperature_unit": "fahrenheit",
        "precipitation_unit": "inch",
    }
    if days_ahead == 0:
        params["past_days"] = 1

    # Observed in testing: Open-Meteo itself times out intermittently, not just
    # the burn-ban feed -- different models fail on different runs, not the
    # same one each time, so a single retry is worth it before giving up to
    # run()'s try/except.
    last_exc = None
    for attempt in range(attempts):
        try:
            resp = requests.get(model_info["url"], params=params, timeout=30)
            resp.raise_for_status()
            data = resp.json()
            if data.get("error"):
                raise RuntimeError(f"Open-Meteo error for {model_key}: {data.get('reason')}")
            return data
        except Exception as e:
            last_exc = e
            log.debug(f"{model_key} fetch attempt {attempt + 1}/{attempts} failed: {e}")
    raise last_exc


# --- Historical backfill (added 2026-07-18) --------------------------------
# Separate from fetch_model() above -- hits Open-Meteo's Single Runs API
# (single-runs-api.open-meteo.com, free tier despite what its own pricing
# page's summarized text initially suggested; verified against the raw
# pricing table directly) instead of the live-forecast endpoints, letting us
# pull a SPECIFIC past model run (run=<cycle time>) rather than only "the
# current forecast." Returns that run's full ~7-day forecast horizon from
# its init time forward (no start_date/end_date param -- not accepted by
# this endpoint), so backfill_capture() below filters down to just the
# target date after parsing.
#
# Archive floor is 2026-04-02 for most models (checked empirically, not just
# from docs -- the same docs-vs-live-API mismatch already found for ECMWF's
# level ceiling). GEM specifically errors on every run tested here (a raw
# "modelRunUnavailable" failure, not the clean JSON `error` shape the other
# models return) -- unclear if that's an archive gap or an API quirk
# specific to this model; treated as "unavailable," same tolerance as any
# other model missing from a given capture, not investigated further.
#
# precipitation_probability is dropped from the variable list entirely here
# (unlike the live pull, which keeps it) -- found 2026-07-18 that requesting
# it against this endpoint fails the WHOLE request with "model run not
# available... Model: ncep_gefs05" even when every other variable is fine.
# It's an ensemble-derived field (needs spread across members, not a single
# deterministic run) that this endpoint silently tries to route to GEFS
# internally and fails, rather than nulling just that one field the way the
# live-forecast endpoints do for an unsupported variable. Confirmed via
# direct curl isolation, not guessed.
SINGLE_RUNS_URL = "https://single-runs-api.open-meteo.com/v1/forecast"


def fetch_model_at_run(model_key: str, run_dt: datetime, site_id: str = "hutto", attempts: int = 2) -> dict:
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
        try:
            resp = requests.get(SINGLE_RUNS_URL, params=params, timeout=30)
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


def fetch_burn_ban(attempts: int = 2) -> dict:
    # This endpoint has been observed to time out intermittently (not a one-off
    # in testing) -- one retry before giving up to run()'s own try/except.
    last_exc = None
    for attempt in range(attempts):
        try:
            resp = requests.get(config.BURN_BAN_URL, timeout=30)
            resp.raise_for_status()
            text = resp.content.decode("utf-16")
            lines = [line.strip() for line in text.splitlines() if line.strip()]
            counties = set(lines[1:])
            return {
                "checked_at": datetime.utcnow(),
                "feed_header": lines[0] if lines else "",
                "county": config.BURN_BAN_COUNTY,
                "active": config.BURN_BAN_COUNTY in counties,
                "counties_under_ban": sorted(counties),
            }
        except Exception as e:
            last_exc = e
            log.debug(f"burn ban fetch attempt {attempt + 1}/{attempts} failed: {e}")
    raise last_exc


def run(target_date: date, site_id: str = "hutto") -> tuple[pd.DataFrame, dict | None, date]:
    capture_date = date.today()
    frames = []
    for model_key in config.LIVE_MODELS:
        try:
            raw = fetch_model(model_key, target_date, site_id)
            frames.append(parse_hourly(raw, model_key))
        except Exception as e:
            log.warning(f"{model_key} pull failed: {e}")
    combined = pd.concat(frames, ignore_index=True) if frames else pd.DataFrame()
    if not combined.empty:
        combined["target_date"] = target_date
        combined["capture_date"] = capture_date
        combined["lead_time_days"] = (target_date - capture_date).days

    # Burn-ban check stays Williamson-County/Hutto-specific regardless of
    # site_id -- config.BURN_BAN_COUNTY isn't a per-site field (no other site
    # needs this yet). Worth revisiting once a non-Hutto site actually pulls.
    try:
        burn_ban = fetch_burn_ban()
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


def save_capture(df: pd.DataFrame, burn_ban: dict | None, target_date: date, capture_date: date, site_id: str = "hutto") -> Path:
    d = capture_dir(target_date, site_id)
    out_path = d / f"captured_{capture_date}.parquet"
    df.to_parquet(out_path)
    with open(d / f"captured_{capture_date}_burnban.json", "w") as f:
        json.dump(burn_ban, f, default=str)
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
    config.WIND_SPEED_AGREEMENT_MPH / WIND_DIR_AGREEMENT_DEG of each other
    (a clique in the pairwise-agreement graph), not the models closest to a
    single shared mean. That distinction matters once there are more than a
    couple of models: with only 2-4 models and one clear outlier, "distance
    from the group mean" and "mutual agreement" pick the same group. But with
    6 models split into two genuine clusters (e.g. 2 models near 16 mph, 2
    near 25 mph, 2 in between), a mean-based approach can fragment into two
    near-even "everyone's an outlier" groups, since the mean sits in the gap
    between clusters and pulls every model far enough away to get excluded.
    A mutual-agreement clique instead finds whichever real cluster is
    actually largest. Brute-force over subsets is fine here -- model counts
    are small (<=8), so worst case is a few hundred combinations.
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
    name -- not a full column per model.

    The day-wide max/min in window_stats() can hide a pattern like "calm at
    10am, gusty by 2pm" -- wind is the one hard numeric safety threshold
    (20 mph) where that intraday shape is exactly what matters, so it gets
    its own table rather than being collapsed into a single aggregate.

    Direction is shown alongside speed -- at Hutto specifically, direction
    changes which speeds are actually a concern: southerly winds drift away
    from the road, northerly winds drift toward it, so "12 mph" reads very
    differently depending on which way it's blowing. No safe/hazard
    classification is applied (data-pull only, per the expansion spec) --
    this just surfaces both numbers for a launch director to judge.
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
        lines.append(f"Burn ban ({config.BURN_BAN_COUNTY}): check failed (see warning above) -- status unknown")
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

    if burn_ban_today is None or burn_ban_prev is None:
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

    out_path = save_capture(df, burn_ban, target_date, capture_date, site_id)
    log.info(f"Wrote {len(df)} rows to {out_path}")

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
