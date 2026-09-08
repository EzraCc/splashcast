Status: done
Priority: medium
Type: new-feature
Last updated: 2026-09-07

# Manual real-flight entries

## Context

Requested directly: add a real flight (hutto, 9/5) to the History view's
real-flight tracking, knowing only the headline facts by hand (apogee
altitude, launch time, landing GPS) -- "I may [get] GPS data from this
flight later." A second flight followed with a rail GPS pin too, then a
known single-deploy rate for flight 1, and for flight 2, a request to reuse
a *previous* flight's real descent rates since "it's the same rocket."
`analyze_real_flight.py`'s existing entry points (`analyze()`,
`analyze_no_gps()`, `analyze_partial_gps()`) all need a real per-second
altitude-vs-time sample series to segment the flight and derive rates --
none fit "just the summary numbers, no track at all."

## Tasks
- [x] New `analyze_manual()` (`pipeline/analyze_real_flight.py`): takes
      apogee altitude, launch time, landing GPS, optionally rail GPS, and
      optionally a deploy config (hand-reported or `--reused-from` a
      previous flight of the same rocket). With a config + a real
      HRRR-analysis actual pull for the site/date, unlocks the same
      estimated-apogee/self-consistent-predicted-landing construction
      `analyze_no_gps()` uses; without one, apogee position and descent
      rates are left out of the JSON entirely.
- [x] New `manual` CLI subcommand, matching the existing `deluxe`/
      `blueraven`/`aim_xtra`/`fluctus` pattern (`--out`/`--label` etc.)
- [x] Fixed real crashes this exposed in `app.js` for ANY partial record --
      `realFlightBoxHTML()`, `updateActiveRealFlightOverlay()`, and the
      real-flight marker's click handler all unconditionally dereferenced
      fields (`apogee.offset_from_pad_ft`, `descent_rates_ground_equivalent_fps`,
      `main_deploy`, `launch.offset_from_pad_ft`) a partial record may not
      have. All four now degrade gracefully.
- [x] Added `closest_hour` to `analyze_manual()`'s output -- missed on the
      first pass, would have silently set `state.timeMinutes = NaN` on
      marker click (every other `analyze_*()` already sets this field).
- [x] Two real flights added for hutto/2026-09-05: 9:31am (apogee 7,050ft,
      single deploy 25fps, no rail) and 12:05pm (apogee 6,615ft, dual
      deploy reusing Konrad/YEET's rocket's real rates + main-deploy
      altitude from `apache_pass/real_flights/2026-07-04_summary.json`,
      real rail GPS).
- [x] Verified via headless-Chromium: hover/click both flights, no console
      errors; info box renders correctly for both shapes (single-deploy,
      dual-deploy-with-rail).
- [x] README.md updated with the new manual-entry capability.

## Decisions
- Identified Konrad/YEET's prior flight by boost angle, not a name field
  (none exists in the schema) -- three AARG-site candidates with
  notably strong angles (13-21°) were found; confirmed with the user which
  one (`apache_pass/2026-07-04`, 21.4°) before reusing its rates. Real
  consequence to guessing wrong here (wrong physics baked into a real
  record), so asked rather than assumed.
- `reused_from` is recorded in the summary JSON's own
  `descent_rates_ground_equivalent_fps.note`/`main_deploy.note` and folded
  into `apogee.position_estimation_note` -- never silently presented as if
  derived from this flight's own track.
- Didn't extend `analyze_manual()` to fabricate `density_scaling_check`,
  `boost_angle_from_vertical_deg`'s "configured" comparison context, or any
  other field that genuinely requires a real track -- left out, not
  approximated, per the same honesty convention `analyze_no_gps()` already
  established (`position_source` flags, never silently presented as
  measured).

## Detours
- Found and fixed the same day, unrelated to this feature: History mode's
  "actual" star only worked at the discrete ladder altitudes, not a custom
  one (`historyActualPointForAltitude()`, see CHANGELOG 2026-09-07) --
  reported independently by the user mid-session, not something surfaced
  by this feature's own testing.

## Open questions
(none)
