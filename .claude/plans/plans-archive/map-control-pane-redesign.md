Status: done
Priority: high
Type: refinement
Last updated: 2026-08-10

# UI redesign: map + tabbed control pane, applied at every screen size

~~**This plan's tab-based design (below) was built, tested, and reported
complete -- then rejected in direct follow-up review.**~~ Superseded
2026-08-10. User's words: "I don't like that in 'setup'... The Legend tab
needs to go... The apogee altitude coming out over the map made sense
before and was working. It doesn't in the 'legend' tab. The specific
altitude edit over the slider control worked too... let's get rid of the
tabs completely." Reverted via `git stash` back to the pre-redesign
baseline (none of this attempt was ever committed) and rebuilt without
tabs -- see **Post-redirect: what actually shipped** at the end of this
file for the real final design. Everything below this notice is the
original plan and build record for the rejected attempt; kept as history,
not current guidance.

## Context

Requested directly: the current mobile experience is broken -- "scroll
shifting between the page and the map. The map is tiny in places and has
control overlap or so much that it hides the map." Started as a
mobile-only rethink ("use expert UX skills... start from scratch"), one
starting idea offered directly: a fixed map taking up half the screen with
a fullscreen toggle, and the rest of the controls in a scrollable pane or
tabs.

**Scope was explicitly widened during planning**: when the first draft of
this plan tried to keep desktop pixel-identical (only changing what DOM
constraints forced), the user redirected -- "if we are making improvements
for mobile that desktop would benefit from, let's apply them across the
board, not just DOM necessity changes." Confirmed via AskUserQuestion which
specific pieces should extend to desktop too: **all three** offered options
were selected -- the fullscreen map toggle, moving the rail-angle inputs
and specific-altitude field into a persistent (non-popup) location, and
switching from the always-everything-visible sidebar to a tabbed control
pane. So this is now one unified redesign applied at every screen size,
not a mobile patch bolted onto an unchanged desktop.

Superseded plan: `plans-archive/altitude-selector-redesign.md` (done,
unrelated prior work).

## Root causes of the reported mobile bugs (confirmed directly in code)

1. **"Map is tiny"**: `.map-wrap` (2D) is `aspect-ratio:1/1`,
   `.descent3d-canvas-wrap` (3D) is `aspect-ratio:4/3` -- both derive
   height purely from their own WIDTH, which on a narrow phone is only
   ~`100vw - 40px`. An explicit comment (`app.css` ~927-931) confirms this
   was a deliberate "let it shrink" decision, not an oversight.
2. **"Control overlap / hides the map"**: every map corner-overlay
   (`.map-view-toggle`, `.layer-toggle`, `.burn-ban-chip`, `.zoom-btns`,
   `.rail-angle-control`, `.map-alt-control`) is `position:absolute`
   against `.map-view-wrap` with the SAME fixed pixel offsets at every
   viewport width -- nothing repositions any of them for mobile. The left
   edge alone stacks 4 overlays on top of an already-short map.
3. **"Scroll shifting"**: the page is one normal-flow scrolling document
   (no `position:sticky` anywhere, zero `overscroll-behavior` rules). The
   map's own pan/zoom (`touch-action:none` + JS pointer handling) lives
   inside that one long scrolling page -- page scroll and the map's
   internal gesture handling structurally compete for the same touch input.
4. Direct prior evidence this exact overlay-popup approach already broke on
   a real device: a previous attempt to align the altitude fly-out to the
   slider's own tick positions forced it to full slider height and broke on
   a real iPhone 15 Pro Max test -- reverted to a plain list.

## Reusable primitives already in the codebase (build on these)

- A segmented-control pattern already exists (`#mode-toggle`: By
  altitude/By time of day/History) via `buildToggle()` (app.js) +
  `.toggle-btns` CSS -- reused visually for the new tab bar, but NOT wired
  through `buildToggle()` itself (that helper mutates `state` and calls a
  full `render()`, wrong for a UI-only tab switch).
- A collapsible-panel-with-chevron idiom reused 3x already
  (`weatherPanelCollapsed`, `controlsCollapsed`, the old altitude/rail-angle
  fly-outs) -- the new fullscreen-map toggle follows this exact pattern:
  a plain in-memory boolean, session-only, no persistence, no Fullscreen
  API (no precedent here, and iOS Safari's support for it is unreliable).
- Builder functions (`buildModelLegend()`, `buildAltList()`,
  `buildTimeLegend()`, `activateAltCustom()`/`syncAltCustomUI()`) are
  confirmed ID-based and DOM-location-agnostic -- relocating their existing
  markup into new tab-panel containers needs no logic rewrite, only the
  markup move plus deleting the now-dead open/close popup mechanism around
  them (see JS changes below).
- `zoomAt()` and `renderDescent3D()`'s `ResizeObserver`-driven canvas sizing
  both read `getBoundingClientRect()` fresh at call/observe time -- neither
  hardcodes aspect-ratio math, so changing the map pane's layout container
  needs no JS changes to pan/zoom/3D-resize logic.

## Design: one structure, arranged differently per breakpoint

```
.viz-root
  .mini-header            (site select, date select, #mode-toggle -- unchanged concept, all widths)
  .app-body                (flex-row on desktop, flex-column on mobile)
    .map-pane
      - 2D/3D switch, layer toggle + burn-ban chip (compact cluster)
      - Altitude slider (draggable widget only -- no more expand chevron)
      - Rail-angle dial (draggable widget only -- no more expand chevron)
      - #map-fullscreen-toggle (NEW, all widths)
      - Zoom buttons: desktop keeps them (mouse users have no pinch
        gesture); mobile hides them (redundant with native pinch/drag,
        which the existing `.zoom-hint` already tells touch users to use)
    .control-pane
      .tab-btns: Weather | Legend | Setup
      .tab-viewport (scrollable, own overscroll containment)
        [Weather]: existing weather grid + its time-of-day slider, moved wholesale
        [Legend]: model legend, altitude ladder + zone-color picker + main-deploy
                   reference (moved out of the old fly-out), time/age legend,
                   accuracy table (already self-hides outside History mode --
                   no new visibility wiring needed)
        [Setup]: rate/deploy editor, rail-angle heading/angle inputs + resets
                   (moved out of the old fly-out), specific-altitude free-text
                   field (moved out of the old inline-edit readout), pad-drag
                   reset/readout, copy-link
```

**Why this resolves the reported bugs, and why it's now one design, not two:**
the on-map popups (altitude fly-out, rail-angle fly-out) are the direct
mechanism that broke on a real device before (root cause #4) -- replacing
them with permanent tab content removes an entire class of "does this
popup fit/collide with the map at this size" problem instead of just
patching its mobile positioning again. Once that's done, the ONLY
remaining difference between desktop and mobile is arrangement (side-by-
side vs. stacked) and the map pane's height source (aspect-ratio on
desktop, where it isn't broken, vs. a deliberate `dvh`-based height on
mobile, where it is) -- not two structurally different systems bridged by
a `display:contents` trick, which the original (mobile-only) draft of this
plan needed and this one doesn't.

`#mode-toggle` (byAltitude/byTime/byHistory) stays in the mini-header,
visually distinct from the new tab bar (small inline pill vs. a bound
tab-strip) at every width -- these are orthogonal concepts (mode changes
what's ON the map; tabs change which control GROUP is visible) worth
keeping visually distinct regardless of screen size.

**On-map readouts become display-only.** The altitude control's numeric
readout above the slider currently turns into a click-to-edit field in
place; once the actual specific-altitude input lives permanently in the
Setup tab, the on-map readout becomes a plain live-updating label, editing
happens only in the tab.

## CSS structure

```css
.app-body { display: flex; flex-direction: row; gap: 20px; } /* desktop default */
.map-pane { flex: 1 1 auto; min-width: 0; }
.control-pane { flex: 0 0 400px; display: flex; flex-direction: column; } /* wider than
  today's 190-230px sidebar -- it now carries the weather grid + accuracy table, both of
  which want real width; tune the exact number during implementation against a real
  desktop screenshot */
.tab-btns { display: flex; flex-shrink: 0; }
.tab-viewport { flex: 1 1 auto; overflow-y: auto; overscroll-behavior: contain; }
.tab-panel { display: none; }
.control-pane[data-active-tab="weather"] .tab-panel[data-tab="weather"],
.control-pane[data-active-tab="legend"]  .tab-panel[data-tab="legend"],
.control-pane[data-active-tab="setup"]   .tab-panel[data-tab="setup"] { display: block; }

@media (max-width: 760px) {
  .viz-root { height: 100vh; height: 100dvh; display: flex; flex-direction: column;
              padding: 0; overflow: hidden; overscroll-behavior: none; }
  .app-body { flex: 1 1 auto; min-height: 0; flex-direction: column; }
  .map-pane { flex: 0 0 auto; height: 52vh; height: 52dvh; overflow: hidden; }
  .control-pane { flex: 1 1 auto; min-height: 0; }
  .tab-viewport { -webkit-overflow-scrolling: touch; }
  .zoom-btns { display: none; }
  #site-heading { display: none; }
}
@media (max-width: 760px) and (max-height: 500px) {
  /* landscape phones -- tune against real device numbers during implementation */
  .map-pane { height: 35vh; height: 35dvh; min-height: 200px; }
}
.viz-root.map-pane-expanded .mini-header,
.viz-root.map-pane-expanded .control-pane { display: none; }
.viz-root.map-pane-expanded .map-pane { flex: 1 1 auto; height: 100vh; height: 100dvh; }
```

`dvh` (Safari 15.4+/Chrome 108+) is declared right after a plain `vh`
fallback of the same property -- unsupported values are simply ignored by
older engines via the normal cascade, no `@supports` block needed.

**Scroll/gesture fix**: `.map-wrap`/`.descent3d-canvas-wrap` already have
`touch-action:none` (unchanged -- that's what gives the map's JS pointer
handlers full gesture ownership). The actual fix is structural: once
`.map-pane` and `.control-pane` are independently-managed regions (a fixed
`dvh` box + a scrollable sibling on mobile; a normal flex row on desktop)
rather than one long page with the map embedded in it, there's no more
page-vs-map gesture race to resolve. `overscroll-behavior` above is
standard belt-and-suspenders against scroll-chaining past each region's
own edges, applied at every width.

## JS changes (`site/assets/js/app.js`)

1. **Delete** the old fly-out open/close mechanism entirely: `toggleMapAltPanel()`/
   `setMapAltExpanded()` and whatever equivalent expand/collapse handler the
   rail-angle dial's `.rail-angle-panel` uses, plus the `controlsCollapsed`/
   `controlsToggleBtn`/etc. "Hide controls" block (retired -- solves a
   problem this redesign eliminates structurally). The chevron toggle
   buttons on both map widgets are removed from the markup.
2. **Keep, relocate only** (same IDs, same listeners -- confirmed
   DOM-location-agnostic): `buildAltList()`'s ladder rows, the zone-color
   picker, the main-deploy-altitude reference line, `activateAltCustom()`/
   `syncAltCustomUI()`'s target input, the rail-angle heading/angle number
   inputs + their reset buttons, `buildTimeLegend()`, `buildModelLegend()`,
   the rate/deploy editor, `#accuracy-section`, `.pad-move-control`. Moving
   their markup into the new tab-panel containers should not require
   touching the functions that build/update them -- verify this holds by
   grepping each for any `closest()`/`parentElement` traversal that assumes
   the old on-map nesting before treating it as a pure markup move.
3. New `activeTab` state (session-only, default `'weather'`) + a plain
   click handler on `.tab-btns` that sets `.control-pane`'s
   `data-active-tab` and toggles `.active` -- does **not** touch `state` or
   call `render()`.
4. New `mapPaneExpanded` state (session-only) + click handler on
   `#map-fullscreen-toggle` toggling `.viz-root.map-pane-expanded` --
   active at every width now, not mobile-only.
5. No changes needed to `zoomAt()`, `render()`, `buildToggle()`, rail-dial
   drag-to-set-heading pointer handlers, or the altitude slider's own
   drag handling -- confirmed `getBoundingClientRect()`-driven, not
   aspect-ratio-assuming, and dragging the compact widgets themselves is
   unaffected by where their OWN fly-out panels used to live.
6. `descent3d.js`: no changes anticipated -- its `ResizeObserver` and
   `dpr`/`rect` sizing are already resize-source-agnostic.

## Tasks

- [x] Read the full current `site/index.html`, relevant `app.css` sections,
      and relevant `app.js` sections (altitude control, rail-angle control,
      weather panel, model legend, rate editor, accuracy section, mode
      toggle) to ground exact edits.
- [x] Restructure `site/index.html`: new mini-header/app-body/map-pane/
      control-pane/tab-btns/tab-viewport/tab-panel markup; relocate content
      into Legend/Setup tabs; delete old fly-out wrapper markup and the
      Hide-controls row; add `#map-fullscreen-toggle`.
- [x] Restructure `site/assets/css/app.css`: replace `.layout` grid with
      the flex structure; delete fly-out positioning rules and
      `.controls-toggle-row` rules; add tab-bar/tab-panel/map-pane-expanded/
      `dvh`/`overscroll-behavior` rules.
- [x] Update `site/assets/js/app.js`: delete old fly-out toggle mechanism
      and the Hide-controls block; add `activeTab`/`mapPaneExpanded` state
      + handlers; verify relocated builder functions need no logic changes.
- [x] Verify `site/assets/js/descent3d.js` needs no changes -- confirmed;
      its `ResizeObserver`/`dpr`/`rect` sizing is resize-source-agnostic.
- [x] Test at 375/390/430px portrait AND landscape (667x375/844x390/
      932x430), desktop at 1024/1280/1440px; full mode(byAltitude/byTime/
      byHistory) x view(2d/3d) x viewport sweep, zero console errors.
      Verified: scroll/gesture independence (real touch-drag pan test,
      page scrollY stayed 0), tab-state preservation across switches
      (model-legend selection survived a tab round-trip), fullscreen
      toggle (desktop + mobile, collapses back cleanly), rail dial
      drag (grows to 160px mid-drag, Setup tab reflects live values),
      altitude slider drag, History mode's Legend tab (age legend +
      self-hiding accuracy table), 3D-disabled-in-byTime.
- [x] CHANGELOG entry + README update -- in progress.

### Real bugs found and fixed during testing (not pre-planned)

- **3D canvas collapsed to ~2px in any height-constrained context**
  (mobile, wide-landscape, fullscreen-expanded): `.descent3d-frame`'s
  `height:100%` had nothing to distribute to its children through, since
  neither it nor `.descent3d-main` were flex containers -- `.descent3d-main`
  ended up 2px tall (pure content-driven collapse) and `.descent3d-canvas-wrap`'s
  own `height:100%` resolved against that. Fixed by making `.descent3d-frame`
  a flex column and `.descent3d-main` `flex:1 1 auto` unconditionally
  (harmless on desktop, where nothing forces an explicit height anyway).
- **Direct `?mode=byHistory&view=3d` URL load crashed and silently aborted
  most of `initFromData()`** -- a real, serious, pre-existing bug (from an
  earlier same-session fix, not this redesign) that this redesign's full
  mode x viewport test sweep happened to catch: `updateMapViewModeUI()` was
  called before `BASE_VB`/`IMG_VB` were set; for byHistory+3D with nothing
  pinned yet, it can trigger `renderDescent3D()` -> a full `render()` of its
  own, which crashed on `BASE_VB[0]` of undefined. Since the crash was
  synchronous and uncaught, every line after that call site in
  `initFromData()` -- the mode toggle, altitude list, weather panel, ban
  status, the real `render()` call -- silently never ran. Fixed by moving
  the call to after `BASE_VB`/`IMG_VB` are set and the main `render()`
  completes.

## Verification

Match this codebase's own established device-testing convention (already
validated 375px/390px/430px + a real iPhone 15 Pro Max 430x932 @3x this
session):

- Widths 375/390/430px, **both orientations** at each (this redesign is
  explicitly height-dependent on mobile -- landscape is first-class), plus
  a real-device pass if available.
- Desktop at 1024px and >=1200px -- since desktop intentionally changes
  now, this needs a fresh design review against the new tabbed layout, not
  a parity diff against the old grid.
- No page-level scroll competing with map gestures on mobile -- specifically
  test a gesture starting exactly at the map/control-pane seam.
- Mobile map pane renders at its intended ~52dvh (not silently collapsed by
  a flex `min-height:0` trap); desktop map pane fills its flex row sensibly
  at common widths (1024/1280/1440px).
- Tab switching preserves each tab's own control state (time-slider
  position, checked models, fps values, altitude ladder selection) across
  switches, at every width.
- Fullscreen toggle: expand/collapse at desktop AND mobile widths, confirm
  2D SVG and 3D canvas both re-render correctly at the new box size, no
  leftover inline styles after collapsing back.
- Mode-toggle through all 3 modes -- confirm the Legend tab's accuracy
  table shows/hides correctly per its own existing self-hiding logic.
- Confirm dragging the on-map altitude slider and rail-angle dial still
  works identically to today (only their fly-out panels moved, not their
  own drag interaction), and that their Setup/Legend-tab counterparts
  (typed values, resets) correctly reflect live drags on the map widgets
  and vice versa.
- Keyboard-tab-through + a VoiceOver pass on the real test device.
- CHANGELOG entry + README update (README's control-position descriptions
  will need real updates now, not just the mobile-specific footnotes
  originally anticipated) before any push, per repo convention.

## Decisions

- Zero-desktop-impact was the ORIGINAL constraint during planning, then
  explicitly overridden by direct instruction: "if we are making
  improvements for mobile that desktop would benefit from, let's apply
  them across the board, not just DOM necessity changes." Confirmed via
  AskUserQuestion -- all three offered desktop-reaching changes (fullscreen
  toggle, relocating rail-angle/altitude inputs, tabbed control pane)
  approved for desktop too. This plan supersedes the earlier "preserve
  desktop pixel-exactly via display:contents" approach entirely.
- 3 tabs (Weather/Legend/Setup), not the 4 first sketched -- avoids a tab
  literally named "History" sitting next to `#mode-toggle`'s own "History"
  button, and the accuracy table's existing self-hiding logic means no new
  visibility wiring is needed if it just lives in Legend.

## Open questions

- Exact `.control-pane` width on desktop (sketched at 400px, wider than
  today's 190-230px sidebar) -- needs tuning against a real screenshot once
  the weather grid/accuracy table are actually rendering inside it.
- Exact landscape-phone map-pane height (sketched at 35dvh/200px floor) --
  needs tuning against real device numbers during implementation.

## Post-redirect: what actually shipped (2026-08-10)

Everything above this section describes the tab-based attempt, which was
reverted whole (`git stash`, scoped to `site/index.html`,
`site/assets/css/app.css`, `site/assets/js/app.js`,
`site/assets/js/descent3d.js`) back to the pre-redesign baseline, then
rebuilt with only the pieces of the attempt the user didn't object to.

- **No tabs, no page-wide fixed shell.** The on-map altitude-ladder
  fly-out, the click-to-edit specific-altitude readout, and the rail-angle
  fly-out are all back to their original on-map behavior -- unchanged from
  pre-redesign HEAD. Model legend and weather panel stay in their original
  position directly below the map; the rate/deploy editor stays in the
  sidebar. None of the "delete the fly-out mechanism, relocate everything
  into tab panels" JS changes from the original plan survived.
- **Kept from the reverted attempt**: a fullscreen-map toggle
  (`#map-fullscreen-toggle`, self-contained to `.map-view-wrap` via
  `position:fixed;inset:0` on a `.fullscreen-active` class -- simpler than
  the original plan's `.viz-root.map-pane-expanded` mechanism, which needed
  the whole page to be a flex shell) and a legal-disclaimer collapse (one
  summary line + click-to-expand, requested directly: "It's taking up way
  too much space").
- **Mobile map height fix, simplified**: instead of turning `.viz-root`
  into a fixed `100dvh` flex shell with `.control-pane` as an independent
  scroll region (the original plan's approach), the real fix is just
  `.map-wrap`/`.descent3d-canvas-wrap { aspect-ratio:unset; height:50vh;
  height:50dvh; min-height:280px; }` inside the existing `max-width:760px`
  breakpoint. The rest of the page stays in normal scrolling flow. Much
  smaller change, and the user never actually objected to normal-flow
  scrolling -- only to the tab system and control placement.
- **New, per direct request**: the restored fly-out panels' `z-index`
  bumped from 6 to 10 ("when an expandable control is selected, make sure
  it has top z-index so other things aren't blocking it").
- **Both real bugs found during the original attempt's testing** (3D
  canvas collapsing to ~2px under any explicit-height ancestor; a
  `?mode=byHistory&view=3d` direct-load crash from `updateMapViewModeUI()`
  running before `BASE_VB`/`IMG_VB` were set) were confirmed to still apply
  under the simplified design and re-fixed identically -- the flex-column
  fix on `.descent3d-frame`/`.descent3d-main`, and moving the
  `updateMapViewModeUI()` call to the end of `initFromData()`.
- Verified: full mode x view x viewport error sweep (zero console errors),
  both fly-outs opening with correct z-index, fullscreen toggle,
  legal-disclaimer expand/collapse, and mobile 3D canvas rendering at a
  real height (390x844 viewport: 348x420px canvas, not collapsed).
- CHANGELOG.md and README.md corrected to describe this final design
  instead of the reverted tab-based one (neither had been pushed, so the
  draft entries were corrected in place rather than superseded with a
  follow-up entry).
