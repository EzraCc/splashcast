Status: done
Priority: medium
Type: refinement
Last updated: 2026-08-09

# Altitude selector redesign: unify around the 3D-style compact control

## Context

Requested directly: the user likes the small collapsed altitude slider that
already lives on the 3D map ("how it stays with the map") and wants it
promoted to be THE altitude selector everywhere, replacing today's split
between (a) the 2D sidebar's "Apogee altitude" section -- a ladder list, a
dual-thumb min/max range-filter slider, and a separate "Specific altitude"
text input -- and (b) 3D's own bare compact slider, which has no fly-out and
doesn't exist in 2D at all. The redesign also folds in the Model legend's
existing double-click-solo/revert interaction (already fully built, just
never applied to altitudes) and sparsifies the site altitude ladder itself.
Work happens on branch `altitude-selector-redesign`, not main directly, per
the user's own instruction.

Confirmed directly, out of scope: the Drogue/Main descent-rate controls
(Fast/Slow presets, rate inputs) stay exactly where they are today, untouched.

Full research + design writeup (research summary, all resolved decisions,
implementation sequence, critical files, verification plan) lives in the
plan-mode file this was promoted from:
`/home/ezrac/.claude/plans/precious-bouncing-orbit.md` -- read that in full
before resuming if context has been lost; the summary below is the
short-form tracker only.

## Tasks

- [x] 1. `pipeline/config.py`: swap `ALTITUDES_MASTER_FT` to
      `[2000, 4000, 6000, 8000, 10000, 15000, 20000, 25000, 30000, 40000, 50000]`.
      Verify via `python config.py` (`validate_altitude_density()`). Done --
      zero density violations; every site's ladder confirmed (Gunter's
      6,000ft waiver -> [2000,4000,6000]; Argonia's 50,000ft -> all 11 rungs).
- [x] 2. Shared compact-control + fly-out scaffolding (HTML/CSS) in
      `.map-view-wrap`, working standalone in both 2D and 3D before touching
      the old sidebar section. Resolve the `.zoom-btns` layout collision --
      moved to top-left, stacked below the layer toggle.
- [x] 3. State model + rendering rewrite (`app.js`): `selectedAlts`/
      `preSoloAlts`, unconditional zone-group building in `render()`,
      `applyIsolation()`/`isPointVisible()` rewritten to read
      `selectedAlts`. Verified correct via direct JS-state assertions before
      the full UI pass.
- [x] 4. Fly-out content: ported ladder rows (full "2,000 ft" text),
      mode-branched click/dblclick handlers, main-deploy-altitude read-only
      line, relocated zone color-picker.
- [x] 5. Click-to-edit "Specific altitude" readout on the compact control.
- [x] 6. Delete old sidebar section + all dead state/functions (`altMin`/
      `altMax`, `altInRange()`, `buildAltRange()`/`initAltRangeSlider()`/
      `onAltRangeChanged()`, real-flight-pin range-widening, `freshState()`
      in-range clamping, `syncAltCustomUI()`'s dangling selector). Confirmed
      via full-codebase grep -- zero stale references remain outside
      historical comments.
- [x] 7. `descent3d.js` cleanup: removed the old 3D-only alt-slider family,
      `renderDescent3D()` wired to the new shared resolver (solo-else-
      ladder-top rule).
- [x] 8. URL params: added `alts=`, kept `alt=` as read-only legacy, dropped
      `altmin`/`altmax`. Round-trip confirmed in-browser both directions.
- [x] 9. CSS cleanup: removed dead `.alt-range-*`/`.alt-custom-*`/old
      `.descent3d-alt-*` rules, including stale comment cross-references.
- [x] 10. Full in-browser verification pass (Playwright): toggle/solo/revert,
      byTime/byHistory unchanged, 2D+3D slider sync, click-to-edit, main-
      deploy readout, zone-color-picker, URL params, mobile width, dark
      mode -- zero console errors throughout, across 5+ site/mode
      combinations. `python config.py` confirms zero density violations.
      CHANGELOG entry added; README's 3D/altitude-control bullets updated
      (min/max-range bullet rewritten, "range selector" cross-reference
      fixed). Not yet committed/pushed -- awaiting the user's go-ahead.

## Decisions

- 3D/the compact slider's readout, when 2D has multiple altitudes checked on
  at once: solo (exactly one active) wins; otherwise falls back to the top
  of the site's own ladder. User's explicit choice over two alternatives
  (most-recently-checked; specific-altitude-only) -- see plan-mode file for
  the full option set considered.
- No data-migration/regeneration step for already-published dates -- the
  pipeline already tolerates `ALTITUDES_MASTER_FT` changing over time
  (confirmed via `analyze_real_flight.py`'s own comment: this has happened
  before, 2026-08).
- byTime/byHistory modes keep single-select `compareAlt`, unchanged --
  multi-select + double-click-solo is byAltitude-only, since that's the only
  mode that renders multiple simultaneous zones today.

## Detours

(none yet)

## Open questions

(none outstanding -- the one open design question from planning, resolved
above under Decisions)
