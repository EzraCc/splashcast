"""Historical multi-model wind-drift pull for the Hutto site.

For each Saturday in range, pulls:
  - the HRRR f00 analysis at the target valid time (the "actual"/best-estimate
    proxy per the spec -- labeled hrrr_f00_analysis, never "actual")
  - each profile model's (GFS/HRRR/RAP/NAM) forecast for that same valid time,
    issued at lead times T-7 .. T-0 days (anchored to the 00Z cycle)
  - NBM's near-surface (10/30/80m) forecast for the same lead times, kept
    separate since NBM has no isobaric wind profile to compare at altitude

Checkpointed per (date, kind) parquet file under data/raw/ so an interrupted
run can resume without re-pulling what's already on disk.
"""

import logging
import signal
import warnings
from contextlib import contextmanager
from datetime import date, datetime, time, timedelta, timezone
from pathlib import Path
from zoneinfo import ZoneInfo

import numpy as np
import pandas as pd
from herbie import Herbie

import config

warnings.filterwarnings("ignore")
logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("splashcast")

RAW_DIR = Path(config.DATA_DIR) / "raw"
RAW_DIR.mkdir(parents=True, exist_ok=True)

# Observed in practice: a half-closed (CLOSE-WAIT) S3 connection can leave a
# pull blocked forever, since neither Herbie nor the underlying requests call
# sets a read timeout (logged as "read timeout=None") -- so no exception is
# ever raised for the existing try/except to catch. This wraps each pull in a
# wall-clock watchdog (SIGALRM, so it works regardless of which library/layer
# is actually stuck) that raises TimeoutError instead, which the try/except
# already handles like any other pull failure. Unix-only; fine here since
# eccodes/cfgrib is Linux-oriented anyway.
PULL_TIMEOUT_SECONDS = 180


@contextmanager
def pull_timeout(seconds: int = PULL_TIMEOUT_SECONDS):
    def _on_alarm(signum, frame):
        raise TimeoutError(f"pull exceeded {seconds}s (likely a hung/half-closed connection)")

    previous = signal.signal(signal.SIGALRM, _on_alarm)
    signal.alarm(seconds)
    try:
        yield
    finally:
        signal.alarm(0)
        signal.signal(signal.SIGALRM, previous)

SITE_TZ = ZoneInfo(config.SITE_TZ)


def target_valid_time(saturday: date) -> datetime:
    """10am local (Central) time on `saturday`, as a naive UTC datetime.

    DST-aware so the local sample hour stays 10am across both seasons -- see
    config.SITE_TZ / TARGET_VALID_HOUR_LOCAL for why a fixed UTC hour isn't used.
    """
    local_dt = datetime.combine(saturday, time(config.TARGET_VALID_HOUR_LOCAL, 0), tzinfo=SITE_TZ)
    return local_dt.astimezone(timezone.utc).replace(tzinfo=None)


def forecast_lead_hours(saturday: date, lead_days: int) -> tuple[datetime, int]:
    """init_dt (00Z anchor) and fxx (forecast hour) for a given Saturday/lead."""
    valid_dt = target_valid_time(saturday)
    init_dt = datetime.combine(saturday - timedelta(days=lead_days), time(config.ANCHOR_CYCLE_HOUR_UTC, 0))
    fxx = int((valid_dt - init_dt).total_seconds() // 3600)
    return init_dt, fxx


def get_saturdays(start: date, end: date) -> list[date]:
    d = start
    while d.weekday() != 5:  # Saturday
        d += timedelta(days=1)
    out = []
    while d <= end:
        out.append(d)
        d += timedelta(days=7)
    return out


def _point_df() -> pd.DataFrame:
    return pd.DataFrame(
        {
            "latitude": [config.SITE_LAT],
            "longitude": [config.SITE_LON + 360],
            "point_name": [config.SITE_ID],
        }
    )


def _base_row(model: str, source_type: str, run_init_time: datetime, lead_time_hours: int) -> dict:
    return {
        "model": model,
        "source_type": source_type,
        "run_init_time": run_init_time,
        "lead_time_hours": lead_time_hours,
        "site_id": config.SITE_ID,
        "lat": config.SITE_LAT,
        "lon": config.SITE_LON,
        "captured_at": datetime.utcnow(),
    }


def extract_profile(H: Herbie, model: str, source_type: str, run_init_time: datetime, lead_time_hours: int) -> pd.DataFrame:
    # This script is still Hutto-only (config.SITE_ID/SITE_LAT/SITE_LON above,
    # no --site option like pull_live_forecast.py/splash_zones.py have) -- so
    # levels_mb_for_site() is called with config.SITE_ID specifically, not
    # left as a bare global the way the old flat LEVELS_MB was.
    level_pattern = "|".join(str(l) for l in config.levels_mb_for_site(config.SITE_ID))
    ds = H.xarray(f":(UGRD|VGRD):({level_pattern}) mb", remove_grib=True)
    picked = ds.herbie.pick_points(_point_df(), method="nearest")
    df = picked[["u", "v", "isobaricInhPa", "valid_time"]].to_dataframe().reset_index()
    df["wind_speed"] = np.sqrt(df["u"] ** 2 + df["v"] ** 2)
    df["wind_direction"] = np.degrees(np.arctan2(-df["u"], -df["v"])) % 360
    df["pressure_level_hpa"] = df["isobaricInhPa"]
    base = _base_row(model, source_type, run_init_time, lead_time_hours)
    for k, v in base.items():
        df[k] = v
    return df[
        [
            "model", "source_type", "run_init_time", "valid_time", "lead_time_hours",
            "site_id", "lat", "lon", "pressure_level_hpa",
            "wind_speed", "wind_direction", "captured_at",
        ]
    ]


def extract_nbm(H: Herbie, source_type: str, run_init_time: datetime, lead_time_hours: int) -> pd.DataFrame:
    height_pattern = "|".join(str(h) for h in config.NBM_HEIGHTS_M)
    result = H.xarray(f":(WIND|WDIR):({height_pattern}) m above ground", remove_grib=True)
    datasets = result if isinstance(result, list) else [result]
    rows = []
    for ds in datasets:
        picked = ds.herbie.pick_points(_point_df(), method="nearest")
        if "si10" in picked:
            rows.append(
                {
                    "valid_time": pd.Timestamp(picked["valid_time"].item()),
                    "altitude_m": 10.0,
                    "wind_speed": float(picked["si10"].item()),
                    "wind_direction": float(picked["wdir10"].item()),
                }
            )
        else:
            for h in picked["heightAboveGround"].values:
                sub = picked.sel(heightAboveGround=h)
                rows.append(
                    {
                        "valid_time": pd.Timestamp(sub["valid_time"].item()),
                        "altitude_m": float(h),
                        "wind_speed": float(sub["ws"].item()),
                        "wind_direction": float(sub["wdir"].item()),
                    }
                )
    df = pd.DataFrame(rows)
    base = _base_row("nbm", source_type, run_init_time, lead_time_hours)
    for k, v in base.items():
        df[k] = v
    return df[
        [
            "model", "source_type", "run_init_time", "valid_time", "lead_time_hours",
            "site_id", "lat", "lon", "altitude_m",
            "wind_speed", "wind_direction", "captured_at",
        ]
    ]


def pull_actual(saturday: date) -> pd.DataFrame | None:
    out_path = RAW_DIR / f"{saturday}_actual.parquet"
    if out_path.exists():
        return pd.read_parquet(out_path)
    valid_dt = target_valid_time(saturday)
    try:
        with pull_timeout():
            H = Herbie(valid_dt, model="hrrr", product="prs", fxx=0, verbose=False)
            df = extract_profile(H, "hrrr", "hrrr_f00_analysis", valid_dt, 0)
        df.to_parquet(out_path)
        return df
    except Exception as e:
        log.warning(f"actual pull failed for {saturday}: {e}")
        return None


def pull_forecast(saturday: date, model_key: str, lead_days: int) -> pd.DataFrame | None:
    out_path = RAW_DIR / f"{saturday}_{model_key}_lead{lead_days}.parquet"
    if out_path.exists():
        return pd.read_parquet(out_path)
    cfg = config.PROFILE_MODELS[model_key]
    init_dt, fxx = forecast_lead_hours(saturday, lead_days)
    if fxx > cfg["max_fxx"]:
        log.debug(f"skip {model_key} lead={lead_days}d for {saturday}: fxx={fxx}h exceeds model max {cfg['max_fxx']}h")
        return None
    try:
        with pull_timeout():
            H = Herbie(init_dt, model=cfg["model"], product=cfg["product"], fxx=fxx, verbose=False)
            df = extract_profile(H, model_key, "forecast", init_dt, fxx)
        df.to_parquet(out_path)
        return df
    except Exception as e:
        log.warning(f"{model_key} lead={lead_days}d pull failed for {saturday}: {e}")
        return None


def pull_nbm(saturday: date, lead_days: int) -> pd.DataFrame | None:
    out_path = RAW_DIR / f"{saturday}_nbm_lead{lead_days}.parquet"
    if out_path.exists():
        return pd.read_parquet(out_path)
    init_dt, fxx = forecast_lead_hours(saturday, lead_days)
    try:
        with pull_timeout():
            H = Herbie(init_dt, model="nbm", product="co", fxx=fxx, verbose=False)
            df = extract_nbm(H, "forecast", init_dt, fxx)
        df.to_parquet(out_path)
        return df
    except Exception as e:
        log.warning(f"nbm lead={lead_days}d pull failed for {saturday}: {e}")
        return None


def run(saturdays: list[date]) -> None:
    n_ok, n_fail, n_skip = 0, 0, 0
    for saturday in saturdays:
        log.info(f"=== {saturday} ===")
        if pull_actual(saturday) is None:
            n_fail += 1
        else:
            n_ok += 1
        for model_key, cfg in config.PROFILE_MODELS.items():
            for lead_days in config.LEAD_DAYS:
                _, fxx = forecast_lead_hours(saturday, lead_days)
                if fxx > cfg["max_fxx"]:
                    n_skip += 1
                    continue
                if pull_forecast(saturday, model_key, lead_days) is None:
                    n_fail += 1
                else:
                    n_ok += 1
        for lead_days in config.LEAD_DAYS:
            if pull_nbm(saturday, lead_days) is None:
                n_fail += 1
            else:
                n_ok += 1
    log.info(f"Done. {n_ok} pulls succeeded, {n_fail} failed, {n_skip} skipped (beyond model's max lead time).")


def consolidate() -> pd.DataFrame | None:
    """Combine all per-pull parquet files under data/raw/ into one dataframe."""
    paths = sorted(RAW_DIR.glob("*.parquet"))
    if not paths:
        log.warning("No parquet files under data/raw/ to consolidate -- every pull failed or was skipped.")
        return None
    frames = [pd.read_parquet(p) for p in paths]
    combined = pd.concat(frames, ignore_index=True)
    out_path = Path(config.DATA_DIR) / "hutto_historical_wind.parquet"
    combined.to_parquet(out_path)
    log.info(f"Wrote {len(combined)} rows to {out_path}")
    return combined


if __name__ == "__main__":
    import sys

    weeks = int(sys.argv[1]) if len(sys.argv) > 1 else 12
    end = date.today()
    start = max(end - timedelta(weeks=weeks), date.fromisoformat(config.ARCHIVE_START))
    saturdays = get_saturdays(start, end)
    log.info(f"Pulling {len(saturdays)} Saturdays from {saturdays[0]} to {saturdays[-1]}")
    run(saturdays)
    consolidate()
