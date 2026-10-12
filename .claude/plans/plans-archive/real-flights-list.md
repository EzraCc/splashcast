Status: done
Priority: medium
Type: new-feature
Last updated: 2026-10-12

# Clickable real-flights list (History)

## Context

Requested directly: "Let's create a list of actual flights in the history
section users can click on. Order it by time and list the altitude.
Clicking on it should advance the time selector to where it needs to be,
and show the information just like a user had clicked on the landing dot."

Immediately follows a question about why the 3D view never shows a real
flight's descent path by default -- the real-flight comparison (pin/snap
pad/time/altitude) could previously only be triggered by hovering or
clicking the 2D marker (`drawRealFlightMarker()`), which lives in the 2D
SVG overlay and doesn't exist at all once the 3D frame is showing. This
list, being plain DOM in the sidebar rather than part of either map frame,
is reachable in both 2D and 3D -- so it also closes that gap as a side
effect, not just a separate ask.

## Tasks
- [x] Extracted the 2D marker's click handler into two shared top-level
      functions (`app.js`) so the list and the marker trigger the exact
      same behavior instead of two parallel implementations:
      `realFlightAvoidPoints(flight)` (the info-box dodge-point list) and
      `activateRealFlight(i, evt, avoidPoints)` (toggle pin, snap pad, jump
      time/altitude to the flight's own `closest_hour`/
      `altitude_bucket_used_ft`, open the info box).
- [x] Replaced the old single static "Real flight (hover or click for
      details)" legend row (`buildTimeLegend()`) with a real, sorted,
      per-flight list -- one row per `REAL_FLIGHTS` entry, earliest launch
      first, each showing `HH:MM:SS -- apogee ft`. Hover previews (same as
      hovering the marker); click calls `activateRealFlight()`.
      Sorts a copy of indices, not `REAL_FLIGHTS` itself, since both
      `activeRealFlight()` and `activateRealFlight()` index into it by its
      own original (unsorted) position.
- [x] New `.real-flight-row` class, distinct from the plain `.alt-row` the
      capture-date rows above it in the same list already use -- needed so
      the row-level `.pinned` toggle (both the row's own click handler and
      the document-level click-away listener) only ever touches a real
      flight's own pin state, never `state.pinnedCapture`'s independent one
      sharing the same `#time-legend` container.
- [x] Verified with headless Chromium: list shows `10:41:40 -- 11,235 ft`
      for the one real Pawhuska flight; clicking it from a direct 3D load
      (no prior 2D interaction at all) correctly pins, snaps the pad, jumps
      time/altitude, opens the info box, AND renders the 3D dashed descent
      path (`'real_flight'` now appears in `path3dHitPoints` immediately).
      Verified multi-flight sort order and independent per-row pin
      toggling with a synthetic second flight injected via the console
      (no real second-flight date published yet to test against directly).
      No console errors in either view.

## Decisions
- Did not change anything about auto-showing a real flight's 3D path with
  zero interaction at all (the question that prompted this) -- this list
  is a different, lower-effort answer to the same underlying problem
  (reachability in 3D), requested in place of that, not in addition to it.
- Clicking a list row still requires its own explicit click per flight
  (no "select all/show every real flight at once" mode) -- matches
  `activeRealFlight()`'s own single-active-flight model throughout the
  rest of the codebase (2D marker, 3D path, info box); changing that would
  be a bigger rework than what was asked.

## Open questions
(none)
