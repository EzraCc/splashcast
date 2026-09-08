Status: done
Priority: medium
Type: new-feature
Last updated: 2026-09-07

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

## Tasks
- [x] New `descent_anchor` field in `analyze_partial_gps()`'s output
      (`pipeline/analyze_real_flight.py`) -- the one real GPS fix mid-descent
      that flight's apogee estimate is backsolved against, computed
      already but never published. Regenerated
      `hutto/2026-08-01_summary.json` from its still-present raw `.fbb` log
      (confirmed identical apogee/landing/error numbers, only the new field
      added).
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
- [x] Verified via headless-Chromium across every real-flight record on the
      site (hutto x3, apache_pass, hearne) -- no console errors on hover for
      any of them, including an older hearne file predating the
      `position_source` field entirely (degrades gracefully). Visually
      confirmed on the partial-GPS flight: the dashed line passes near, not
      through, the anchor's solid marker, and the real landing marker sits
      visibly apart from the diamond predicted-landing endpoint.

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

## Open questions
(none)
