"""Per-site launch-day schedule, driven by launch_calendar.json.

Encodes which site(s) actually need a pull_live_forecast.py/splash_zones.py
run on a given day, per club, so a daily driver can figure out "what's coming
up" without a human re-deriving nth-weekday-of-month math every time.

The actual schedule data (recurring club rules + one-off exceptions) lives in
launch_calendar.json, not here -- this module is a generic interpreter for
that file's small set of rule/override shapes, not a per-club hardcoded list.
See that file's own structure (or docs/adding-a-site.md) for how to add a
club, and the --cancel/--move/--add/--flag CLI flags below for editing
one-off exceptions without hand-writing JSON.

Recurring rule shapes (see RULE_HANDLERS): a fixed nth-weekday-of-month valid
across a month range, optionally with per-month exceptions or an extra event
N days after (nth_weekday_monthly); a named holiday-relative multi-day event
(holiday_relative_multiday); season-dependent site choice for one recurring
rule, with overlap months pulling *both* sites since the real trigger doesn't
happen on a fixed calendar date (seasonal_site_swap); and a fully hand-entered
per-year list for a club whose calendar has no reproducible formula at all
(hand_entered).

One-off override actions (see _apply_overrides()): cancel (this specific
occurrence isn't happening), move (moved to a different date and/or site),
add (a brand-new one-off date, no recurring rule involved), flag (annotates
an existing event as tentative/uncertain without changing what gets
generated or polled -- for a "may move, undecided" situation with no new
date to move *to* yet). cancel/move/flag all hard-fail if they don't match
an actual generated event, rather than silently no-op'ing on a typo'd date.
"""

import argparse
import dataclasses
import json
import subprocess
import sys
from dataclasses import dataclass
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from time import sleep as _sleep

import config

MON, TUE, WED, THU, FRI, SAT, SUN = range(7)
WEEKDAY_MAP = {"MON": MON, "TUE": TUE, "WED": WED, "THU": THU, "FRI": FRI, "SAT": SAT, "SUN": SUN}

CALENDAR_PATH = Path(__file__).parent / "launch_calendar.json"


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


HOLIDAYS = {"memorial_day": memorial_day}


@dataclass
class LaunchEvent:
    event_date: date
    site_id: str
    label: str
    # "confirmed" (default) or "tentative" -- see the add/flag override
    # actions below. Additive fields: every existing consumer of LaunchEvent
    # only ever reads event_date/site_id/label, so these are safe defaults.
    status: str = "confirmed"
    note: str | None = None


# --- Recurring-rule interpreters (one per launch_calendar.json rule "type") -

def _nth_weekday_monthly_events(rule: dict, year: int) -> list[LaunchEvent]:
    site_id = rule["site_id"]
    weekday = WEEKDAY_MAP[rule["weekday"]]
    n = rule["n"]
    months = rule.get("months", list(range(1, 13)))
    month_overrides = {int(k): v for k, v in rule.get("month_overrides", {}).items()}
    label = rule.get("label", "")
    plus_days_after = rule.get("plus_days_after", [])
    out = []
    for month in months:
        d = nth_weekday(year, month, weekday, month_overrides.get(month, n))
        out.append(LaunchEvent(d, site_id, label))
        for extra in plus_days_after:
            out.append(LaunchEvent(d + timedelta(days=extra["days"]), site_id, extra["label"]))
    return out


def _holiday_relative_multiday_events(rule: dict, year: int) -> list[LaunchEvent]:
    site_id = rule["site_id"]
    anchor = HOLIDAYS[rule["holiday"]](year)
    return [LaunchEvent(anchor + timedelta(days=o["days"]), site_id, o["label"]) for o in rule["offsets"]]


def _seasonal_site_swap_events(rule: dict, year: int) -> list[LaunchEvent]:
    weekday = WEEKDAY_MAP[rule["weekday"]]
    n = rule["n"]
    primary_site, primary_months = rule["primary_site"], set(rule["primary_months"])
    secondary_site, overlap_months = rule["secondary_site"], set(rule["overlap_months"])
    label = rule.get("label", "")
    overlap_label = rule.get("overlap_label", label)
    out = []
    for month in range(1, 13):
        d = nth_weekday(year, month, weekday, n)
        if month in overlap_months:
            out.append(LaunchEvent(d, primary_site, overlap_label))
            out.append(LaunchEvent(d, secondary_site, overlap_label))
        elif month in primary_months:
            out.append(LaunchEvent(d, primary_site, label))
        else:
            out.append(LaunchEvent(d, secondary_site, label))
    return out


def _hand_entered_events(rule: dict, year: int) -> list[LaunchEvent]:
    site_id = rule["site_id"]
    year_events = rule.get("years", {}).get(str(year))
    if year_events is None:
        print(f"(skipping hand-entered events for site {site_id!r} in {year}: no \"{year}\" key under this "
              f"rule's \"years\" dict in {CALENDAR_PATH.name} -- add one before relying on this past what's entered)",
              file=sys.stderr)
        return []
    return [LaunchEvent(date.fromisoformat(e["date"]), site_id, e["label"]) for e in year_events]


RULE_HANDLERS = {
    "nth_weekday_monthly": _nth_weekday_monthly_events,
    "holiday_relative_multiday": _holiday_relative_multiday_events,
    "seasonal_site_swap": _seasonal_site_swap_events,
    "hand_entered": _hand_entered_events,
}


# --- Calendar loading/validation ---------------------------------------------

def _validate_calendar(calendar: dict) -> None:
    """Collects every problem found (not just the first) and raises one
    ValueError listing all of them -- a typo here directly risks silently
    losing real cron coverage for a launch, so this fails loudly rather than
    skipping the one bad entry."""
    problems = []
    known_sites = set(config.SITES)

    def _check_date(d: str, where: str):
        try:
            date.fromisoformat(d)
        except (TypeError, ValueError):
            problems.append(f"{where}: {d!r} is not a valid ISO date")

    def _check_site(site_id, where: str):
        if site_id not in known_sites:
            problems.append(f"{where}: unknown site_id {site_id!r}")

    for club_key, club in calendar.get("clubs", {}).items():
        for i, rule in enumerate(club.get("rules", [])):
            where = f"clubs.{club_key}.rules[{i}]"
            rtype = rule.get("type")
            if rtype not in RULE_HANDLERS:
                problems.append(f"{where}: unknown rule type {rtype!r}")
                continue
            for site_field in ("site_id", "primary_site", "secondary_site"):
                if site_field in rule:
                    _check_site(rule[site_field], f"{where}.{site_field}")
            if rtype == "hand_entered":
                for year_str, entries in rule.get("years", {}).items():
                    for j, e in enumerate(entries):
                        _check_date(e.get("date"), f"{where}.years.{year_str}[{j}].date")

    for i, ov in enumerate(calendar.get("overrides", [])):
        where = f"overrides[{i}]"
        action = ov.get("action")
        if action not in ("cancel", "move", "add", "flag"):
            problems.append(f"{where}: unknown action {action!r}")
            continue
        if ov.get("status", "confirmed") not in ("confirmed", "tentative"):
            problems.append(f"{where}: unknown status {ov.get('status')!r}")
        if action == "move":
            for side in ("from", "to"):
                d = ov.get(side, {})
                _check_date(d.get("date"), f"{where}.{side}.date")
                _check_site(d.get("site_id"), f"{where}.{side}.site_id")
        else:
            _check_date(ov.get("date"), f"{where}.date")
            _check_site(ov.get("site_id"), f"{where}.site_id")

    if problems:
        raise ValueError(f"{CALENDAR_PATH} failed validation:\n  " + "\n  ".join(problems))


def load_calendar(path: Path = None) -> dict:
    path = path or CALENDAR_PATH
    try:
        calendar = json.loads(path.read_text())
    except json.JSONDecodeError as e:
        raise ValueError(f"{path} is not valid JSON: {e}") from e
    _validate_calendar(calendar)
    return calendar


def _recurring_events(year: int, calendar: dict) -> list[LaunchEvent]:
    out = []
    for club in calendar.get("clubs", {}).values():
        for rule in club.get("rules", []):
            out.extend(RULE_HANDLERS[rule["type"]](rule, year))
    return out


def _apply_overrides(events: list[LaunchEvent], year: int, overrides: list[dict]) -> list[LaunchEvent]:
    """Applies cancel/move/add/flag on top of the recurring events for this
    one year, in file order. Matching is always by (date, site_id) -- never
    club/label text, which can get restyled without meaning anything
    changed. cancel/move's "from" side/flag all hard-fail (raise) if they
    don't match an actual generated event -- silently no-op'ing a typo'd
    override date is exactly the bug class this exists to prevent."""
    by_key: dict[tuple[date, str], list[LaunchEvent]] = {}
    for e in events:
        by_key.setdefault((e.event_date, e.site_id), []).append(e)

    def _year_of(d: str) -> int:
        return date.fromisoformat(d).year

    def _pop_required(d: str, site_id: str, ov: dict) -> None:
        key = (date.fromisoformat(d), site_id)
        if not by_key.get(key):
            raise ValueError(f"override {ov} has no matching event at {key} in {year} -- check the date/site_id "
                              f"against the recurring schedule (python launch_schedule.py --days-ahead ...)")
        by_key[key] = []
        return key

    for ov in overrides:
        action = ov["action"]
        status = ov.get("status", "confirmed")
        if action == "cancel":
            if _year_of(ov["date"]) != year:
                continue
            _pop_required(ov["date"], ov["site_id"], ov)
        elif action == "move":
            if _year_of(ov["from"]["date"]) == year:
                _pop_required(ov["from"]["date"], ov["from"]["site_id"], ov)
            if _year_of(ov["to"]["date"]) == year:
                to_key = (date.fromisoformat(ov["to"]["date"]), ov["to"]["site_id"])
                by_key.setdefault(to_key, []).append(LaunchEvent(to_key[0], to_key[1], ov.get("label", ""), status=status))
        elif action == "add":
            if _year_of(ov["date"]) != year:
                continue
            key = (date.fromisoformat(ov["date"]), ov["site_id"])
            by_key.setdefault(key, []).append(LaunchEvent(key[0], key[1], ov.get("label", ""), status=status))
        elif action == "flag":
            if _year_of(ov["date"]) != year:
                continue
            key = (date.fromisoformat(ov["date"]), ov["site_id"])
            if not by_key.get(key):
                raise ValueError(f"override {ov} has no matching event at {key} in {year}")
            by_key[key] = [dataclasses.replace(e, status=status, note=ov.get("reason")) for e in by_key[key]]
        else:
            raise ValueError(f"unknown override action {action!r}")

    out = []
    for evs in by_key.values():
        out.extend(evs)
    return out


def all_events(year: int, apply_overrides: bool = True) -> list[LaunchEvent]:
    calendar = load_calendar()
    events = _recurring_events(year, calendar)
    if apply_overrides:
        events = _apply_overrides(events, year, calendar.get("overrides", []))
    return sorted(events, key=lambda e: e.event_date)


def upcoming(from_date: date = None, days_ahead: int = 60) -> list[LaunchEvent]:
    from_date = from_date or date.today()
    to_date = from_date + timedelta(days=days_ahead)
    years_needed = {from_date.year, to_date.year}
    events = [e for y in years_needed for e in all_events(y)]
    return sorted([e for e in events if from_date <= e.event_date <= to_date], key=lambda e: e.event_date)


def run_pulls_for(target_date: date, dry_run: bool = False, only_sites: set[str] | None = None, pause_before_first: bool = False) -> None:
    """Runs pull_live_forecast.py + splash_zones.py for every site with an
    event on target_date -- the daily driver's actual job. Safe to call for
    any date repeatedly (each day's capture is its own file, per
    pull_live_forecast.py's design), so re-running today's date just adds
    today's capture to that target's forecast-drift history.

    only_sites: if given, sites with an event on target_date but not in this
    set are silently skipped -- lets run_live_pulls() drop just the sites
    past their own cron cutoff without touching others sharing this date.

    pause_before_first: whether to pace even the first site pulled here --
    False for a genuinely first call (nothing's hit Open-Meteo yet this run,
    no reason to wait), True when run_live_pulls() is calling this for a
    later target_date group in the same job, so the gap between the last
    site of one group and the first of the next still gets paced (see the
    per-site pause below for why this matters).
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
    for i, (site_id, labels) in enumerate(sites_seen.items()):
        if (i or pause_before_first) and not dry_run:
            # Confirmed directly in six days of real cron logs: gunter's gfs+hrrr
            # pull failed in 18/18 consecutive runs, always the 2nd site pulled
            # right after another site's own full 8-model burst against Open-
            # Meteo, while whichever site ran first each time never failed at
            # all -- same "hammering the endpoint back-to-back" issue as
            # pull_live_forecast.py's own per-model pacing, one level up.
            # Skipped for dry runs -- nothing's actually hitting Open-Meteo, so
            # there's no reason to make a --dry-run wait through it.
            _sleep(1.0)
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

    for i, (target_date, site_ids) in enumerate(sorted(by_date.items())):
        run_pulls_for(target_date, dry_run=dry_run, only_sites=site_ids, pause_before_first=i > 0)


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


# --- CLI helper for editing launch_calendar.json's one-off overrides --------

def _site_club(site_id: str) -> str:
    if site_id not in config.SITES:
        raise SystemExit(f"error: unknown site_id {site_id!r} -- known: {list(config.SITES)}")
    return config.SITES[site_id]["club"]


def _append_override(override: dict, *, require_match: bool) -> None:
    calendar = load_calendar()
    if require_match:
        if override["action"] == "move":
            target_date, target_site = date.fromisoformat(override["from"]["date"]), override["from"]["site_id"]
        else:
            target_date, target_site = date.fromisoformat(override["date"]), override["site_id"]
        recurring = _recurring_events(target_date.year, calendar)
        if not any(e.event_date == target_date and e.site_id == target_site for e in recurring):
            raise SystemExit(f"error: no recurring event on {target_date} at site {target_site!r} -- check the "
                              f"date/site_id against `python launch_schedule.py --days-ahead ...` first "
                              f"(overrides can only reference events the recurring schedule actually generates)")
    calendar.setdefault("overrides", []).append(override)
    _validate_calendar(calendar)
    CALENDAR_PATH.write_text(json.dumps(calendar, indent=2) + "\n")
    print(f"added override: {override}")
    print(f"-> {CALENDAR_PATH}")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--days-ahead", type=int, default=60)
    parser.add_argument("--run-today", action="store_true", help="actually run pulls for today's scheduled launches only (not just list them)")
    parser.add_argument("--run-live", action="store_true", help="cron entry point: Open-Meteo pulls for every site T-0..T-7 out (see run_live_pulls())")
    parser.add_argument("--run-actuals", action="store_true", help="cron entry point: NOAA actual pull for every site that launched yesterday (see run_actual_pulls())")
    parser.add_argument("--dry-run", action="store_true", help="with --run-today/--run-live/--run-actuals, print what would run without pulling")

    parser.add_argument("--cancel", nargs=3, metavar=("SITE_ID", "DATE", "REASON"), help="mark a recurring event cancelled, e.g. --cancel gunter 2026-07-25 \"cancelled due to heat\"")
    parser.add_argument("--move", nargs=3, metavar=("SITE_ID", "DATE", "NEW_SITE_ID"), help="move a recurring event to a different site (and/or --new-date), e.g. --move apache_pass 2026-08-01 hutto --reason \"field plowed\"")
    parser.add_argument("--new-date", metavar="DATE", help="with --move: new date, if it's changing too (default: same as DATE)")
    parser.add_argument("--add", nargs=3, metavar=("SITE_ID", "DATE", "LABEL"), help="add a brand-new one-off event, e.g. --add apache_pass 2026-08-15 \"AARG extra date\" --tentative")
    parser.add_argument("--flag", nargs=3, metavar=("SITE_ID", "DATE", "REASON"), help="annotate an existing event as tentative/uncertain without changing what's polled, e.g. --flag apache_pass 2026-09-05 \"may move for Airfest\"")
    parser.add_argument("--reason", default="", help="with --move/--add: optional reason text")
    parser.add_argument("--tentative", action="store_true", help="with --move/--add: mark status tentative instead of confirmed")
    args = parser.parse_args()

    if args.cancel:
        site_id, date_str, reason = args.cancel
        _append_override({"action": "cancel", "club": _site_club(site_id), "date": date_str, "site_id": site_id, "reason": reason}, require_match=True)
    elif args.move:
        site_id, date_str, new_site_id = args.move
        _site_club(new_site_id)  # validates new_site_id too
        _append_override({
            "action": "move", "club": _site_club(site_id),
            "from": {"date": date_str, "site_id": site_id},
            "to": {"date": args.new_date or date_str, "site_id": new_site_id},
            "label": f"{_site_club(site_id)} (moved from {config.SITES[site_id]['name']})",
            "reason": args.reason, "status": "tentative" if args.tentative else "confirmed",
        }, require_match=True)
    elif args.add:
        site_id, date_str, label = args.add
        _append_override({
            "action": "add", "club": _site_club(site_id),
            "date": date_str, "site_id": site_id, "label": label,
            "reason": args.reason, "status": "tentative" if args.tentative else "confirmed",
        }, require_match=False)
    elif args.flag:
        site_id, date_str, reason = args.flag
        _append_override({"action": "flag", "club": _site_club(site_id), "date": date_str, "site_id": site_id, "reason": reason, "status": "tentative"}, require_match=True)
    elif args.run_live:
        run_live_pulls(dry_run=args.dry_run)
    elif args.run_actuals:
        run_actual_pulls(dry_run=args.dry_run)
    elif args.run_today:
        run_pulls_for(date.today(), dry_run=args.dry_run)
    else:
        print(f"Upcoming launches (next {args.days_ahead} days):")
        for e in upcoming(days_ahead=args.days_ahead):
            tag = f" [{e.status}]" if e.status != "confirmed" else ""
            note = f"  -- {e.note}" if e.note else ""
            print(f"  {e.event_date:%a %Y-%m-%d}  {e.site_id:12s} {e.label}{tag}{note}")
