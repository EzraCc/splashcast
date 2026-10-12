Status: done
Priority: medium
Type: new-feature
Last updated: 2026-10-12

# Real-flight 3D descent path

## Context

Follow-up to [Manual real-flight entries](manual-real-flight-entries.md).
Asked directly whether real flights (`REAL_FLIGHTS`) were wired into the 3D
view with a dashed-vs-solid distinction for predicted-vs-measured segments.
Checked directly (grep `descent3d.js`): they weren't wired in at all -- what
the user remembered turned out to describe two other existing features (the
HRRR-analysis "actual" path's amber line, and the ascent-sim boost line's
dash convention), neither of which is about a specific real flight.
Clarified: the descent line is simulated math end to end regardless of
flight type ("the entire thing is built on math for the 3D model"); only
this flight's own genuinely real points (rail/anchor/landing/a GPS-measured
apogee) should read as real. Any disagreement between a real fix and where
the simulated line passes at that same altitude is left visible, not
reconciled -- explicitly deferred by the user as a future problem.

## History

- 2026-09-07: built (see Tasks below).
- 2026-09-08: swept into an unrelated revert alongside manual real-flight
  entries (see that feature's own History) -- a different, unrelated 3D
  feature broke and the whole stack got reverted together.
- 2026-10-12: restored byte-for-byte from `git show 9c24b29`, re-applied by
  hand against the current `app.js`/`descent3d.js` (five weeks of unrelated
  changes in between -- the ascent-sim integration, rail dial rework --
  meant a raw patch didn't apply cleanly). Triggered by a direct report:
  "the actual for the pawhuska flight looks nothing like the kml file,"
  which turned out to be two compounding problems, not one -- see Detours.

## Tasks
- [x] New `descent_anchor` field in `analyze_partial_gps()`'s output
      (`pipeline/analyze_real_flight.py`) -- the one real GPS fix mid-descent
      that flight's apogee estimate is backsolved against, computed
      already but never published. Regenerated
      `hutto/2026-08-01_summary.json` from its still-present raw `.fbb` log
      (confirmed identical apogee/landing/error numbers, only the new field
      added). *(Not re-applied 2026-10-12 -- the one flight needing this
      restoration, pawhuska/2026-09-27, is a manual record with no
      `descent_anchor` at all; `path3dDrawRealFlightMarkers()` already
      skips it gracefully when absent, so the pipeline half of this task
      stayed out of scope.)*
- [x] `realFlightDescentPath()` (`app.js`) -- same
      `actualProfileForTime()`/`simulateDriftPath()` construction
      `historyActualPathForAltitude()` already uses for the HRRR-analysis
      path, seeded from the active real flight's own apogee/rates instead.
- [x] `path3dDrawPath()` `real_flight` special case (`descent3d.js`):
      `REAL_FLIGHT_COLOR`, always dashed, `'diamond'` landing-marker shape
      (the path's own simulated endpoint -- deliberately not the "measured"
      `'target'` shape).
- [x] New `path3dDrawRealFlightMarkers()` -- solid ring+dot markers for
      whichever real points this flight actually has: rail, `descent_anchor`,
      landing (always), apogee (only when `position_source === 'gps_measured'`).
- [x] `shiftForModel('real_flight')` in `path3dDrawScene()` -- shifts by
      this flight's own apogee offset, not the generic rail-angle/ascent-sim
      shift every forecast model uses.
- [x] Verified via headless-Chromium against pawhuska/2026-09-27 (the flight
      that prompted the restoration) -- dashed magenta path renders from the
      real 11,235ft apogee offset down to the real landing, solid rail/
      landing markers present, no console errors.

## Decisions
- Predicted-landing marker shape is `'diamond'`, not `'target'` -- `'target'`
  is reserved for genuinely real/measured points (drawn separately by
  `path3dDrawRealFlightMarkers()`). Predicted only equals real for a
  no-GPS/manual flight (solved to match it by construction); for a full or
  partial-GPS flight it's an independent prediction that can visibly miss,
  and using the "measured" shape there would misrepresent a simulated point.
- Did not attempt to reconcile a real fix (e.g. `descent_anchor`) against
  where the simulated line passes at that same altitude -- explicitly
  deferred by the user ("we'll deal with that later... that's a future
  problem"). The gap is left visible on the map, not resolved.
- Did not add hit-testing/hover-tooltips for the new solid real-point
  markers -- the existing 2D info box already covers this flight's own
  numbers; out of scope for "add the path."

## Detours (2026-10-12)
- The reported symptom ("actual looks nothing like the KML") was two
  independent problems, not one: (1) this whole feature being missing
  entirely since the 2026-09-08 revert -- without it, the only "actual"
  thing in 3D History is the unrelated NOAA/HRRR post-flight reanalysis
  proxy (`historyActualPathForAltitude()`), which has no connection to any
  specific real flight's own data at all; and (2) a real, pre-existing bug
  in the real-flight pin/click-away handling (`document.addEventListener
  ('click', ...)` at `setRealFlightComparing()`'s call site, `app.js`) that
  unconditionally unpins on ANY click anywhere on the page, with no
  `target`-containment check -- unlike the two other popup-dismiss
  listeners in this file (`mapAltControl`/`railAngleControl`), which both
  correctly check `!container.contains(evt.target)`. Since the real-flight
  marker only exists in the 2D SVG (hidden once 3D is showing), the only
  way to ever see this feature's 3D line was pin-in-2D-then-switch-to-3D --
  and that one required click (the view-toggle button) was itself always
  read as "away," clearing the pin in the same gesture meant to reveal it.
  A dead end with no sequence of clicks that could ever show the 3D path,
  likely present (unnoticed) in the original 2026-09-07 build too, since it
  was reverted the next day for an unrelated reason before this exact
  pin-then-switch flow got exercised.
- Fixed narrowly, not by rewriting the click-away listener's general
  semantics: added `evt.stopPropagation()` to `#map-view-toggle`'s buttons
  (`app.js`) and to `#descent3d-view-toggle`/`#descent3d-ground-toggle`'s
  buttons (`descent3d.js`) -- the minimum needed so switching 2D&harr;3D or
  between 3D sub-views (Top/W-E/N-S) doesn't count as clicking away.
  Deliberately did not touch whether *other* controls (rate editor,
  model-legend checkboxes, etc.) also still unpin on click -- that's
  existing, intentional-looking "click anywhere else to dismiss" behavior,
  out of scope for this report.

## Open questions
(none)
