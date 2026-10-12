Status: done
Priority: medium
Type: refinement
Last updated: 2026-10-12

# Pad-drag range raised to 2km

## Context

Reported directly while testing the Pawhuska real flight (98mm Alien
Interceptor, 2026-09-27): "I can't move the launch pad far enough to match
apogee to test if the landing was within the splash." The real flight's own
apogee offset from the surveyed pad is ~4050ft (`apogee.offset_from_pad_ft`
in the published real-flight record), well past the old 2000ft
`max_pad_move_ft` default -- dragging the pad to line a predicted zone up
against a real GPS landing was the actual blocked workflow, not just "try a
different setup spot."

Direction given: remove the cap's implicit tie to map-tile coverage, add a
background fallback for anything that drags past the fetched imagery, and
raise the cap itself to 2km -- justified because every model's own wind
grid is already coarser than that (~3km/~9,800ft for HRRR, the finest), so
nothing within 2km of drag could ever pull a different forecast value
regardless of exact placement. Explicitly scoped down: "for fields with
very high ceilings, there's no way around that without full maps loaded
dynamically as needed" -- no dynamic/streamed tile loading attempted here.

## Tasks
- [x] Checked every site's actual fetched-image coverage before raising
      anything (`site/maps/<site>/site.json` bounds, converted to a radius
      in ft) -- confirmed the smallest site's own "wide" context image
      (Gunter, ~8640ft radius) already comfortably clears a 2km (6562ft)
      drag, so no site needs new/bigger imagery for this change.
- [x] Found the real gap wasn't image coverage at all: `growBaseViewBox()`
      (`app.js`), which grows the SVG background rect + zoom-out ceiling to
      follow whatever's actually drawn, was never called for `byHistory`
      mode at all (confirmed via its own call sites -- only wired into
      `byAltitude`/`byTime`). A History-mode drag past the server's static
      `base_view_box` had nothing to grow around it.
- [x] `config.py`: raised `max_pad_move_ft` from 2000 (3000 for Argonia's
      own override) to 6562 (2km) for every site. Argonia's override is now
      redundant (the shared default already clears its real ~2500ft need)
      -- struck, not deleted, per this repo's superseded-decision
      convention. Gunter's own comment about the old default eating most of
      its coordinate-offset budget is resolved by the same bump, noted
      inline rather than rewritten.
- [x] `app.js`: `MAX_PAD_MOVE_FT`'s pre-data-load fallback raised to match
      (6562). `growBaseViewBox()` now always folds in the pad marker's own
      current position (`ftToPx(0,0)`) and every active real flight's fixed
      points (rail/landing/apogee, via `ftToPxAbsolute()` -- these don't
      move with the pad) -- unconditional, every render, every mode, not
      just byHistory's real-flight case. Also now called from a new
      `byHistory` branch in `render()`'s early zones block, recomputing the
      same `rawPoints` `renderHistory()` itself looks up a second time (a
      small duplicated lookup, same tradeoff this function's own top
      comment already accepted for `drawZone()`'s work).
- [x] Regenerated Pawhuska's (2026-09-27, the flight that prompted this)
      and Gunter's (the smallest-image site, as a stress check) currently-
      published data files locally via `splash_zones.py` so the live
      `max_pad_move_ft` value actually reflects the new default --
      confirmed via headless Chromium (`MAX_PAD_MOVE_FT` reads 6562, a real
      pointer-drag reaches the full 2km before clamping, `BASE_VB`/
      `MAX_SPAN` grow to include the dragged pad with the same 80px margin
      every other grown extent already uses). Every other site's published
      data keeps its old cap until its own next regular pull (cron already
      covers near-term sites automatically) -- not force-regenerated here.

## Decisions
- Did not build a true "dynamic tile loading" system -- explicitly out of
  scope per direction. The fallback is the plain `--map-bg` background rect
  `render()` already drew everywhere beyond the fetched imagery; the real
  fix was making sure that rect (and the zoom-out ceiling it feeds,
  `MAX_SPAN`) actually grows for every mode a user might drag the pad in,
  not adding a new rendering layer.
- Did not add auto-pan-while-dragging. `render()` already re-runs
  `growBaseViewBox()` on every drag step (confirmed: the pad's `pointermove`
  handler calls `render()` directly), so the background/zoom-out ceiling
  stay correct throughout a drag -- but the visible pan/zoom window itself
  doesn't follow, so a long drag can carry the marker off the current
  viewport before the user zooms out to see where it landed. Verified this
  is reachable (a real simulated pointer-drag past the visible canvas
  still correctly reaches the full 2km clamp, confirming `window`-level
  pointermove tracking already handles a cursor leaving the element) but
  left as-is -- the existing zoom controls already reach the grown extent,
  and auto-pan wasn't part of what was asked. Worth a follow-up if a 2km
  drag turns out to feel disorienting in practice.

## Open questions
(none)
