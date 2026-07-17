"""Recurring per-site launch-day schedule.

Encodes which site(s) actually need a pull_live_forecast.py/splash_zones.py
run on a given day, per club, so a daily driver can figure out "what's coming
up" without a human re-deriving nth-weekday-of-month math every time. Rules
gathered 2026-07-17 directly from each club (AARG/Hearne/TNT) or their
published calendar (KLOUDBusters); re-verify before trusting a season this
schedule hasn't been checked against yet -- clubs change their own schedules
without this file knowing.

Every site here must already exist in config.SITES.

Four distinct kinds of rule, because the clubs don't actually share one:
  1. Fixed nth-weekday-of-month, valid across a month range (AARG, Hearne,
     TNT Seymour's regular flight day) -- computed generically, works for
     any year.
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
from datetime import date, timedelta

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


# --- Rule 1+2: Tripoli North Texas @ Seymour -------------------------------
# Regular monthly launch is 4th Saturday, but only Jan-May (no listed
# off-season pattern given, so no launches assumed Jun-Dec until told
# otherwise). Texas Shootout is a separate, holiday-anchored event -- doesn't
# assume it lands on the "4th Saturday" even though it usually falls near it;
# some years those are two different Saturdays.
TNT_SEYMOUR_MONTHLY_MONTHS = range(1, 6)  # January(1)..May(5)


def tnt_seymour_events(year: int) -> list[LaunchEvent]:
    out = [LaunchEvent(nth_weekday(year, m, SAT, 4), "seymour", "TNT Seymour") for m in TNT_SEYMOUR_MONTHLY_MONTHS]
    mem_day = memorial_day(year)
    for d, label in [(mem_day - timedelta(days=2), "Texas Shootout (Sat)"),
                      (mem_day - timedelta(days=1), "Texas Shootout (Sun)"),
                      (mem_day, "Texas Shootout (Memorial Day Mon)")]:
        out.append(LaunchEvent(d, "seymour", label))
    return out


# --- Rule 4: KLOUDBusters @ Argonia -- no fixed weekday-of-month rule ------
# Confirmed 2026-07-17 against KLOUDBusters' own published 2026 schedule PDF
# (kloudbusters.org, "2026 Launch Schedule"): unlike every other club here,
# their monthly "Fun Fly" isn't pinned to a specific nth-weekday -- it moves
# between Saturday and Sunday per month at the club's discretion, and several
# months get *no* launch at all ("Break for Wheat", mid-April through June,
# to stay off the landowner's winter wheat before harvest). No formula
# reproduces this -- hand-entered per year from their PDF, and this dict
# needs a new year added before relying on it (nothing here extrapolates
# past what's actually published). "April Rail Cleaning" (a work day, not a
# launch) is deliberately excluded.
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
    events = aarg_events(year) + hearne_events(year) + tnt_seymour_events(year)
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


def run_pulls_for(target_date: date, dry_run: bool = False) -> None:
    """Runs pull_live_forecast.py + splash_zones.py for every site with an
    event on target_date -- the daily driver's actual job. Safe to call for
    any date repeatedly (each day's capture is its own file, per
    pull_live_forecast.py's design), so re-running today's date just adds
    today's capture to that target's forecast-drift history."""
    events = [e for e in all_events(target_date.year) if e.event_date == target_date]
    if not events:
        print(f"no scheduled launches on {target_date}")
        return
    # Two events can land on the same site+date (e.g. TNT's regular 4th-Saturday
    # slot happening to coincide with Texas Shootout's Saturday) -- pull that
    # site once, not once per coinciding event.
    sites_seen = {}
    for e in events:
        sites_seen.setdefault(e.site_id, []).append(e.label)
    for site_id, labels in sites_seen.items():
        print(f"=== {', '.join(labels)}: {site_id} on {target_date} ===")
        if dry_run:
            continue
        subprocess.run([sys.executable, "pull_live_forecast.py", str(target_date), "--site", site_id], check=True)
        subprocess.run([sys.executable, "splash_zones.py", str(target_date), "--site", site_id], check=True)


if __name__ == "__main__":
    import argparse

    parser = argparse.ArgumentParser()
    parser.add_argument("--days-ahead", type=int, default=60)
    parser.add_argument("--run-today", action="store_true", help="actually run pulls for today's scheduled launches (not just list them)")
    parser.add_argument("--dry-run", action="store_true", help="with --run-today, print what would run without pulling")
    args = parser.parse_args()

    if args.run_today:
        run_pulls_for(date.today(), dry_run=args.dry_run)
    else:
        print(f"Upcoming launches (next {args.days_ahead} days):")
        for e in upcoming(days_ahead=args.days_ahead):
            print(f"  {e.event_date:%a %Y-%m-%d}  {e.site_id:12s} {e.label}")
