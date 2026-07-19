"""Recurring per-site launch-day schedule.

Encodes which site(s) actually need a pull_live_forecast.py/splash_zones.py
run on a given day, per club, so a daily driver can figure out "what's coming
up" without a human re-deriving nth-weekday-of-month math every time. Rules
are sourced directly from each club (AARG/Hearne/TNT) or their published
calendar (KLOUDBusters) except where a per-rule comment below says otherwise;
re-verify before trusting a season this schedule hasn't been checked against
-- clubs change their own schedules without this file knowing.

Every site here must already exist in config.SITES.

Four distinct kinds of rule, because the clubs don't actually share one:
  1. Fixed nth-weekday-of-month, valid across a month range (AARG, Hearne,
     TNT Seymour's regular flight day, SD Rocket Jockies, Tripoli Houston
     South Site) -- computed generically, works for any year.
  2. A named holiday-relative multi-day event (Texas Shootout: the Sat/Sun/
     Mon of Memorial Day weekend) -- also computed generically.
  3. Season-dependent site choice for one recurring rule (AARG: Apache Pass
     April-September, Hutto the rest of the year), with the two transition
     months pulling *both* sites since the real trigger -- planting/harvest
     -- doesn't happen on a fixed calendar date.
  4. A club whose actual calendar doesn't fit any of the above at all
     (KLOUDBusters -- see KLOUDBUSTERS_2026 below) and has to be hand-entered
     per year from their published PDF instead of computed.
"""

import subprocess
import sys
from dataclasses import dataclass
from datetime import date, datetime, timedelta, timezone

import config

MON, TUE, WED, THU, FRI, SAT, SUN = range(7)


def nth_weekday(year: int, month: int, weekday: int, n: int) -> date:
    """The n-th occurrence of `weekday` (Mon=0..Sun=6) in `year`-`month`.
    n=1 is the first, n=-1 is the last (whichever one actually falls in that
    month, not "one from the end of a fixed 5-week grid")."""
    if n > 0:
        d = date(year, month, 1)
        offset = (weekday - d.weekday()) % 7
        return d + timedelta(days=offset + 7 * (n - 1))
    # n == -1: walk back from next month's 1st
    if month == 12:
        d = date(year + 1, 1, 1)
    else:
        d = date(year, month + 1, 1)
    d -= timedelta(days=1)
    offset = (d.weekday() - weekday) % 7
    return d - timedelta(days=offset)


def memorial_day(year: int) -> date:
    """Last Monday of May (the US federal holiday)."""
    return nth_weekday(year, 5, MON, -1)


@dataclass
class LaunchEvent:
    event_date: date
    site_id: str
    label: str


# --- Rule 1+3: AARG -- 1st Saturday every month, site by grow season -------
# "Grow season" (Apache Pass, April-September) vs. the rest of the year
# (Hutto) -- the exact planting/harvest date isn't known in advance, so the
# two transition months (April, September) pull *both* sites rather than
# guessing which side of the season boundary that Saturday actually falls on.
AARG_GROW_SEASON_MONTHS = range(4, 10)  # April(4)..September(9) inclusive
AARG_OVERLAP_MONTHS = {4, 9}


def aarg_events(year: int) -> list[LaunchEvent]:
    out = []
    for month in range(1, 13):
        d = nth_weekday(year, month, SAT, 1)
        if month in AARG_OVERLAP_MONTHS:
            out.append(LaunchEvent(d, "apache_pass", "AARG (grow-season/off-season overlap)"))
            out.append(LaunchEvent(d, "hutto", "AARG (grow-season/off-season overlap)"))
        elif month in AARG_GROW_SEASON_MONTHS:
            out.append(LaunchEvent(d, "apache_pass", "AARG"))
        else:
            out.append(LaunchEvent(d, "hutto", "AARG"))
    return out


# --- Rule 1: Tripoli Houston @ Hearne -- 2nd Saturday every month ----------
def hearne_events(year: int) -> list[LaunchEvent]:
    return [LaunchEvent(nth_weekday(year, m, SAT, 2), "hearne", "Tripoli Houston") for m in range(1, 13)]


# --- Rule 1: DARS @ Gunter -- 3rd Saturday every month ---------------------
# Per dars.org: "Gunter launches are normally held on the third Saturday."
def gunter_events(year: int) -> list[LaunchEvent]:
    return [LaunchEvent(nth_weekday(year, m, SAT, 3), "gunter", "DARS") for m in range(1, 13)]


# --- Rule 1: Tripoli Houston @ South Site -- 4th Saturday every month ------
# Placeholder as all-year -- club materials mention a Feb-Aug season similar
# to TNT Seymour's, but left as every month until that's confirmed/narrowed.
def tripoli_houston_south_events(year: int) -> list[LaunchEvent]:
    return [LaunchEvent(nth_weekday(year, m, SAT, 4), "tripoli_houston_south", "Tripoli Houston South") for m in range(1, 13)]


# --- Rule 1+2: Tripoli North Texas @ Seymour -------------------------------
# Regular monthly launch is 4th Saturday, but only Jan-May (no listed
# off-season pattern given, so no launches assumed Jun-Dec until told
# otherwise). Texas Shootout is a separate, holiday-anchored event -- doesn't
# assume it lands on the "4th Saturday" even though it usually falls near it;
# some years those are two different Saturdays.
TNT_SEYMOUR_MONTHLY_MONTHS = range(1, 6)  # January(1)..May(5)


def tnt_seymour_events(year: int) -> list[LaunchEvent]:
    # 4th Saturday's regular monthly launch runs into the Sunday directly
    # after it too, not a Saturday-only event.
    out = []
    for m in TNT_SEYMOUR_MONTHLY_MONTHS:
        sat = nth_weekday(year, m, SAT, 4)
        out.append(LaunchEvent(sat, "seymour", "TNT Seymour (Sat)"))
        out.append(LaunchEvent(sat + timedelta(days=1), "seymour", "TNT Seymour (Sun)"))
    mem_day = memorial_day(year)
    for d, label in [(mem_day - timedelta(days=2), "Texas Shootout (Sat)"),
                      (mem_day - timedelta(days=1), "Texas Shootout (Sun)"),
                      (mem_day, "Texas Shootout (Memorial Day Mon)")]:
        out.append(LaunchEvent(d, "seymour", label))
    return out


# --- Rule 1: SD Rocket Jockies -- 1st Saturday, April-October ---------------
# Given directly by the user, not sourced from the club's own calendar like
# the rules above -- re-verify before trusting this season.
SD_ROCKET_JOCKIES_MONTHS = range(4, 11)  # April(4)..October(10) inclusive


def sd_rocket_jockies_events(year: int) -> list[LaunchEvent]:
    return [LaunchEvent(nth_weekday(year, m, SAT, 1), "sd_rocket_jockies", "SD Rocket Jockies")
            for m in SD_ROCKET_JOCKIES_MONTHS]


# --- Rule 4: KLOUDBusters @ Argonia -- no fixed weekday-of-month rule ------
# Per KLOUDBusters' own published 2026 schedule PDF (kloudbusters.org):
# unlike every other club here, their monthly "Fun Fly" isn't pinned to a
# specific nth-weekday -- it moves between Saturday and Sunday at the club's
# discretion, and several months get *no* launch ("Break for Wheat",
# mid-April through June, to stay off the landowner's winter wheat before
# harvest). No formula reproduces this -- hand-entered per year from their
# PDF, and needs a new year added before relying on it past what's published.
# "April Rail Cleaning" (a work day, not a launch) is deliberately excluded.
KLOUDBUSTERS_2026 = [
    (date(2026, 1, 10), "January Fun Fly"),
    (date(2026, 2, 15), "February Fun Fly"),
    (date(2026, 3, 8), "March Fun Fly"),
    (date(2026, 3, 21), "Argonia Cup / KLOUDBurst 34 (Sat)"),
    (date(2026, 3, 22), "Argonia Cup / KLOUDBurst 34 (Sun)"),
    # ------------ Break for Wheat (no launches) ------------
    (date(2026, 7, 11), "July Fun Fly"),
    (date(2026, 8, 2), "August Fun Fly"),
    (date(2026, 8, 30), "AIRFest Set Up (Sun)"),
    (date(2026, 9, 4), "AIRFest 32 (Fri)"),
    (date(2026, 9, 5), "AIRFest 32 (Sat)"),
    (date(2026, 9, 6), "AIRFest 32 (Sun)"),
    (date(2026, 9, 7), "AIRFest 32 (Mon)"),
    (date(2026, 10, 10), "October Fun Fly (Sat)"),
    (date(2026, 10, 11), "October Fun Fly (Sun)"),
    (date(2026, 11, 14), "Distant Thunder '26 (Sat)"),
    (date(2026, 11, 15), "Distant Thunder '26 (Sun)"),
    (date(2026, 12, 13), "December Fun Fly"),
]


def kloudbusters_events(year: int) -> list[LaunchEvent]:
    if year != 2026:
        raise ValueError(
            f"no published KLOUDBusters schedule entered for {year} -- only 2026 is hand-entered "
            "(see KLOUDBUSTERS_2026 above). Check kloudbusters.org's own published PDF for that "
            "year and add it before relying on this for anything past 2026."
        )
    return [LaunchEvent(d, "argonia", label) for d, label in KLOUDBUSTERS_2026]


def all_events(year: int) -> list[LaunchEvent]:
    events = (aarg_events(year) + hearne_events(year) + tnt_seymour_events(year)
              + sd_rocket_jockies_events(year) + tripoli_houston_south_events(year)
              + gunter_events(year))
    try:
        events += kloudbusters_events(year)
    except ValueError as e:
        print(f"(skipping KLOUDBusters for {year}: {e})", file=sys.stderr)
    return sorted(events, key=lambda e: e.event_date)


def upcoming(from_date: date = None, days_ahead: int = 60) -> list[LaunchEvent]:
    from_date = from_date or date.today()
    to_date = from_date + timedelta(days=days_ahead)
    years_needed = {from_date.year, to_date.year}
    events = [e for y in years_needed for e in all_events(y)]
    return sorted([e for e in events if from_date <= e.event_date <= to_date], key=lambda e: e.event_date)


def run_pulls_for(target_date: date, dry_run: bool = False, only_sites: set[str] | None = None) -> None:
    """Runs pull_live_forecast.py + splash_zones.py for every site with an
    event on target_date -- the daily driver's actual job. Safe to call for
    any date repeatedly (each day's capture is its own file, per
    pull_live_forecast.py's design), so re-running today's date just adds
    today's capture to that target's forecast-drift history.

    only_sites: if given, sites with an event on target_date but not in this
    set are silently skipped -- lets run_live_pulls() drop just the sites
    past their own cron cutoff without touching others sharing this date.
    """
    events = [e for e in all_events(target_date.year) if e.event_date == target_date]
    if not events:
        print(f"no scheduled launches on {target_date}")
        return
    # Two events can land on the same site+date (e.g. TNT's regular 4th-Saturday
    # slot happening to coincide with Texas Shootout's Saturday) -- pull that
    # site once, not once per coinciding event.
    sites_seen = {}
    for e in events:
        if only_sites is not None and e.site_id not in only_sites:
            continue
        sites_seen.setdefault(e.site_id, []).append(e.label)
    if not sites_seen:
        print(f"no scheduled launches on {target_date} (after site filter)")
        return
    for site_id, labels in sites_seen.items():
        print(f"=== {', '.join(labels)}: {site_id} on {target_date} ===")
        if dry_run:
            continue
        subprocess.run([sys.executable, "pull_live_forecast.py", str(target_date), "--site", site_id], check=True)
        subprocess.run([sys.executable, "splash_zones.py", str(target_date), "--site", site_id], check=True)


def events_by_lead(today: date, min_lead: int, max_lead: int) -> list[LaunchEvent]:
    """Events whose event_date is min_lead..max_lead days out from `today`
    (inclusive both ends)."""
    years = {today.year, (today + timedelta(days=max_lead)).year}
    events = [e for y in years for e in all_events(y)]
    return sorted([e for e in events if min_lead <= (e.event_date - today).days <= max_lead], key=lambda e: e.event_date)


def run_live_pulls(today: date = None, dry_run: bool = False) -> None:
    """The Open-Meteo "leading up to launch" cron job: pulls the current
    forecast for every site with a launch T-0..T-(config.LEAD_DAYS max) days
    out, building that day's forecast-drift snapshot. Meant to run several
    times a day (see .github/workflows/cron-pulls.yml) -- capture_date dedup
    (UTC day, in pull_live_forecast.py's run()) keeps only one stored point
    per model per day regardless of how often this fires.

    UTC throughout (today defaults to UTC-now). The one per-site local-time
    exception is config.SITES[...]["cron_cutoff_hour_utc"]: once a launch
    day (lead 0) is past that stored UTC hour, stop pulling for it.
    """
    today = today or datetime.now(timezone.utc).date()
    max_lead = max(config.LEAD_DAYS)
    events = events_by_lead(today, 0, max_lead)
    if not events:
        print(f"no launches 0-{max_lead} days out from {today} (UTC)")
        return

    now_hour_utc = datetime.now(timezone.utc).hour
    by_date: dict[date, set[str]] = {}
    for e in events:
        lead = (e.event_date - today).days
        cutoff = config.SITES[e.site_id]["cron_cutoff_hour_utc"]
        if lead == 0 and now_hour_utc > cutoff:
            print(f"skip {e.site_id} {e.event_date} (T-0): past today's {cutoff}:00 UTC cron cutoff")
            continue
        by_date.setdefault(e.event_date, set()).add(e.site_id)

    for target_date, site_ids in sorted(by_date.items()):
        run_pulls_for(target_date, dry_run=dry_run, only_sites=site_ids)


def run_actual_pulls(today: date = None, dry_run: bool = False) -> None:
    """The NOAA "day after" cron job: pulls the HRRR-analysis "actual" (see
    pull_historical.py's pull_actual()) for every site that launched
    yesterday (UTC), then re-runs splash_zones.py so points_history.json's
    actuals key picks it up. Deliberately not same-day -- pull_actual()'s
    own docstring explains why (HRRR's AWS archive needs a full day to
    finish publishing that day's cycles)."""
    today = today or datetime.now(timezone.utc).date()
    yesterday = today - timedelta(days=1)
    site_ids = sorted({e.site_id for e in all_events(yesterday.year) if e.event_date == yesterday})
    if not site_ids:
        print(f"no launches on {yesterday} -- nothing to pull actuals for")
        return
    for site_id in site_ids:
        print(f"=== actual: {site_id} for {yesterday} ===")
        if dry_run:
            continue
        try:
            subprocess.run([sys.executable, "pull_historical.py", "--site", site_id, "--actual-only", str(yesterday)], check=True)
            subprocess.run([sys.executable, "splash_zones.py", str(yesterday), "--site", site_id], check=True)
        except subprocess.CalledProcessError as e:
            print(f"actual pull failed for {site_id} {yesterday}: {e}", file=sys.stderr)


if __name__ == "__main__":
    import argparse

    parser = argparse.ArgumentParser()
    parser.add_argument("--days-ahead", type=int, default=60)
    parser.add_argument("--run-today", action="store_true", help="actually run pulls for today's scheduled launches only (not just list them)")
    parser.add_argument("--run-live", action="store_true", help="cron entry point: Open-Meteo pulls for every site T-0..T-7 out (see run_live_pulls())")
    parser.add_argument("--run-actuals", action="store_true", help="cron entry point: NOAA actual pull for every site that launched yesterday (see run_actual_pulls())")
    parser.add_argument("--dry-run", action="store_true", help="with --run-today/--run-live/--run-actuals, print what would run without pulling")
    args = parser.parse_args()

    if args.run_live:
        run_live_pulls(dry_run=args.dry_run)
    elif args.run_actuals:
        run_actual_pulls(dry_run=args.dry_run)
    elif args.run_today:
        run_pulls_for(date.today(), dry_run=args.dry_run)
    else:
        print(f"Upcoming launches (next {args.days_ahead} days):")
        for e in upcoming(days_ahead=args.days_ahead):
            print(f"  {e.event_date:%a %Y-%m-%d}  {e.site_id:12s} {e.label}")
