// 3D descent-path view -- each model's actual predicted drift path from a
// chosen apogee down to the ground, not a raw wind-vs-altitude profile
// (confirmed with direction that "drift during descent, all layers, not
// just apogee" is what was meant here). A plain global-scope script, same
// as app.js (no bundler/module system anywhere in this app -- see
// index.html's own comment on the two <script> tags), loaded after it so
// this file can freely read DATA/state/MODEL_COLORS_HEX/MODEL_LEGEND_ORDER/
// MODEL_LABELS/descentPathsFor()/simulateDriftPath() as plain globals.
//
// Rendering is a hand-rolled canvas 2D projection (yaw/pitch rotation),
// not a 3D library pulled in via CDN -- consistent with this app's
// existing zero-runtime-dependency precedent (nothing here, including the
// hand-built bar-chart weather cells and the SVG map itself, uses a
// library). Orthographic, not perspective: a perspective divide makes the
// same real magnitude look different-sized depending on depth, which
// actively fights the "axes labeled so magnitude is clear" requirement
// rather than serving it.
//
// X/Y/Z all share ONE true-to-scale ft-per-pixel factor (path3dDrawScene()'s
// scaleFt) -- 2026-08, per direction: an earlier version normalized
// altitude independently from horizontal drift (each stretched to fill the
// same visual radius), which read as far more dramatic sideways drift than
// actually happened relative to how far the rocket fell. Altitude
// routinely dwarfs horizontal drift in real numbers, and this view now
// shows that honestly rather than fighting it -- a real trade-off is a
// small, often thin-looking horizontal spread near the vertical axis
// rather than a bold one filling the frame; real tick labels at each
// gridline are what keep magnitude readable at that scale, not an
// artificially inflated horizontal extent.
//
// Altitude selection is a priority chain (see resolveAltFt()) topped by
// this panel's own vertical slider, so a user can explore any apogee
// without leaving this section, while still following whatever's already
// selected in the sidebar (typed specific altitude, pinned/hovered ladder
// row, or the range slider's current max) the rest of the time.

// Default camera: yaw=0 specifically, not an arbitrary angle -- at yaw=0,
// path3dRotate()'s rx == nx exactly (screen-X is pure east, zero
// north-axis contamination) and rd == ny (north maps purely into the
// depth/vertical axis, which pitch then tilts upward) -- i.e. north-up,
// east-right, the standard map convention a human expects to see first.
// A nonzero default yaw (tried -35deg initially) mixes east and north
// together via rx = nx*cosY - ny*sinY, which can visually read as "east on
// the left" purely from an arbitrary starting orbit angle, not a real
// data/axis bug -- confirmed directly by walking the rotation math for a
// pure-east unit vector at that angle. Orbiting away from yaw=0 by
// dragging is still exactly this same rotation, just user-chosen.
let path3dYaw = 0;
let path3dPitch = 22 * Math.PI / 180;
let path3dZoom = 1;
// Default ON -- unlike most of this app's toggles (default-minimal, opt
// in), this is a brand-new visualization being evaluated for the first
// time; showing it immediately makes that evaluation possible without an
// extra click, and it's one click to turn back off if it's too busy.
let path3dShowGround = true;

// Set only by dragging this panel's own slider (altSlider's pointerdown
// handler below) -- null means "follow the sidebar" (see resolveAltFt()).
let path3dAltOverrideFt = null;
// True for exactly one renderDescent3D() call right after a drag on this
// panel's own slider -- lets resolveAltFt() tell "the override just
// changed because of OUR OWN drag" apart from "the sidebar moved since our
// last render", without needing to touch any of app.js's several separate
// customAlt/pinnedAlt/isolatedAlt/altMax call sites individually.
let path3dSliderJustMoved = false;
let path3dLastSidebarAltSig = null;
// The altitude actually used by the most recent real render -- read by the
// slider's own keyboard handler instead of calling resolveAltFt() a second
// time mid-interaction (that function has side effects on the override/sig
// above, meant to run at most once per render).
let path3dLastResolvedAltFt = null;

const path3dCanvas = document.getElementById('descent3d-canvas');
const path3dCtx = path3dCanvas.getContext('2d');
const path3dMain = document.getElementById('descent3d-main');
const path3dEmptyHint = document.getElementById('descent3d-empty-hint');
const path3dViewToggle = document.getElementById('descent3d-view-toggle');
const path3dGroundToggle = document.getElementById('descent3d-ground-toggle');
const path3dAltSlider = document.getElementById('descent3d-alt-slider');
const path3dAltTicks = document.getElementById('descent3d-alt-ticks');
const path3dAltThumb = document.getElementById('descent3d-alt-thumb');
const path3dAltReadout = document.getElementById('descent3d-alt-readout');
const path3dCanvasWrap = document.querySelector('.descent3d-canvas-wrap');

function path3dCssVar(name) {
  return getComputedStyle(document.querySelector('.viz-root')).getPropertyValue(name).trim();
}

function path3dAltSliderMaxFt() {
  return DATA.altitudes[DATA.altitudes.length - 1];
}

// Priority chain, highest first: this panel's own slider override, then
// whatever's already selected in the sidebar, falling back to the range
// slider's current max -- always defined, so this view always has
// something sensible to show, never a bare "pick an altitude" dead end.
// path3dAltOverrideFt is cleared back to "follow the sidebar" as soon as
// any of the four sidebar values changes from a source OTHER than this
// panel's own slider (tracked via path3dSliderJustMoved, reset to false
// every call -- so it only "protects" the override for the one render
// immediately following an actual drag).
function path3dResolveAltFt() {
  const sig = `${state.customAlt}|${state.pinnedAlt}|${state.isolatedAlt}|${state.altMax}`;
  if (path3dAltOverrideFt !== null && !path3dSliderJustMoved && sig !== path3dLastSidebarAltSig) {
    path3dAltOverrideFt = null;
  }
  path3dLastSidebarAltSig = sig;
  path3dSliderJustMoved = false;
  if (path3dAltOverrideFt !== null) return path3dAltOverrideFt;
  if (state.customAlt !== null) return state.customAlt;
  if (state.pinnedAlt !== null) return state.pinnedAlt;
  if (state.isolatedAlt !== null) return state.isolatedAlt;
  return state.altMax;
}

function path3dUpdateAltSliderUI(altFt) {
  const max = path3dAltSliderMaxFt();
  const frac = max > 0 ? Math.max(0, Math.min(1, altFt / max)) : 0;
  // `bottom` on .descent3d-alt-thumb IS its own bottom EDGE, not its
  // center (translateX-only, see its own CSS comment) -- inset by the
  // thumb's 9px radius so its circle never spills past the track's ends
  // into whatever sits beside it (confirmed directly: at frac=1 the thumb's
  // circle overlapped the "Apogee" readout label sitting just above the
  // track).
  const centerFromBottom = `calc(9px + (100% - 18px) * ${frac})`;
  path3dAltThumb.style.bottom = `calc(${centerFromBottom} - 9px)`;
  path3dAltReadout.textContent = Math.round(altFt).toLocaleString() + ' ft';
  path3dAltSlider.setAttribute('aria-valuenow', String(Math.round(altFt)));
  path3dAltSlider.setAttribute('aria-valuemin', '0');
  path3dAltSlider.setAttribute('aria-valuemax', String(Math.round(max)));
  path3dRenderAltTicks();
}

// Dash-mark ticks at each of this site's real apogee-altitude options
// (DATA.altitudes, the same list the sidebar's own ladder shows) -- lets a
// tap land exactly on a "real" altitude instead of eyeballing a freeform
// drag. Rebuilt on every call (cheap: DATA.altitudes is a handful of
// values) since the slider's own live pixel height -- which
// path3dTicksToShow() decimates against -- can change from a window
// resize/orientation change independently of anything else that would
// otherwise trigger a rebuild.
function path3dRenderAltTicks() {
  const rect = path3dAltSlider.getBoundingClientRect();
  // Matches the 9px-inset-each-end usable range centerFromBottom above
  // already uses, so a tick and the thumb land in the identical spot when
  // the current altitude is exactly one of the ladder's own values.
  const trackPx = Math.max(0, rect.height - 18);
  const max = path3dAltSliderMaxFt();
  path3dAltTicks.innerHTML = '';
  path3dTicksToShow(trackPx).forEach(alt => {
    const frac = max > 0 ? alt / max : 0;
    const tick = document.createElement('button');
    tick.type = 'button';
    tick.className = 'descent3d-alt-tick';
    tick.title = `${alt.toLocaleString()} ft`;
    tick.style.bottom = `calc(9px + (100% - 18px) * ${frac} - 9px)`;
    // pointerdown + stopPropagation, not a plain 'click' -- a tick sits
    // inside #descent3d-alt-slider, so an unstopped pointerdown would bubble
    // up into the slider's OWN pointerdown handler first (that one fires
    // before this element's later 'click' does) and jump the thumb to
    // whatever approximate Y-coordinate value that click landed on, then
    // this handler would correct it to the exact tick altitude a moment
    // later -- a real, confirmed visible "jump then snap back" rather than
    // landing precisely in one motion (the entire point of a tick target).
    tick.addEventListener('pointerdown', evt => {
      evt.stopPropagation();
      path3dSetAlt(alt, true);
    });
    // Also a plain 'click' -- keyboard activation (Enter/Space on a focused
    // button) fires that without a preceding pointerdown at all. Redundant
    // with the pointerdown handler above for a real mouse/touch click (both
    // fire, both set the identical value), which is harmless, not worth
    // guarding against.
    tick.addEventListener('click', () => path3dSetAlt(alt, true));
    path3dAltTicks.appendChild(tick);
  });
}

// Thins DATA.altitudes down to whatever actually fits `trackPx` without
// crowding -- ticks closer together than MIN_SPACING_PX get dropped, walking
// bottom-up so the kept set stays evenly spread rather than clustering near
// one end. Always keeps the top of the ladder (the last entry) even if that
// means dropping its nearest-below neighbor instead, so the highest real
// altitude option is never the one that silently disappears. A short
// mobile slider naturally lands on a coarser real spacing this way (e.g.
// every 3,000ft instead of every 1,000ft) without a hardcoded breakpoint --
// it falls out of the same real pixel-spacing math at any slider height.
function path3dTicksToShow(trackPx) {
  const all = DATA.altitudes;
  const max = path3dAltSliderMaxFt();
  if (!all.length || max <= 0 || trackPx <= 0) return [];
  const MIN_SPACING_PX = 22;
  const kept = [];
  let lastPx = -Infinity;
  all.forEach((alt, i) => {
    const px = (alt / max) * trackPx;
    const isLast = i === all.length - 1;
    if (isLast && kept.length && px - lastPx < MIN_SPACING_PX) kept.pop();
    if (px - lastPx >= MIN_SPACING_PX || isLast) {
      kept.push(alt);
      lastPx = px;
    }
  });
  return kept;
}

// Round to a clean interval from the data's own real extent -- same
// "don't claim more precision than the data has" approach addTempRow()'s
// scaleMin/scaleMax already uses, generalized to pick a step rather than
// just a floor/ceiling.
function path3dNiceStep(maxAbs, targetTicks) {
  if (!(maxAbs > 0)) return 1;
  const raw = maxAbs / targetTicks;
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const norm = raw / mag;
  const step = norm < 1.5 ? 1 : norm < 3.5 ? 2 : norm < 7.5 ? 5 : 10;
  return step * mag;
}

// Rotates a normalized point (each coordinate roughly in [-1,1]) by yaw
// (around the vertical/Z axis) then pitch (tilting the resulting depth
// axis against Z) -- a standard orbit-camera rotation. sx/sy are the
// orthographic screen-plane coordinates (still needing a scale+translate
// to real pixels); depth is kept only for draw-order sorting, never used
// in the projection itself (orthographic, not perspective -- see file-top
// comment).
function path3dRotate(nx, ny, nz) {
  const cosY = Math.cos(path3dYaw), sinY = Math.sin(path3dYaw);
  const rx = nx * cosY - ny * sinY;
  const rd = nx * sinY + ny * cosY;
  const cosP = Math.cos(path3dPitch), sinP = Math.sin(path3dPitch);
  const depth = rd * cosP - nz * sinP;
  const sy = rd * sinP + nz * cosP;
  return { sx: rx, sy, depth };
}

// Standard-view shortcuts, same idea as any 3D modeler's view cube --
// yaw/pitch pairs chosen so each preset's horizontal/vertical axes are
// exactly one of the three orthogonal planes, not an arbitrary angle:
//   3D:    yaw=0, pitch=22deg -- the default oblique view (all 3 axes visible)
//   Top:   yaw=0, pitch=90deg -- straight down; rx=nx, sy=ny exactly, so
//          this is pixel-for-pixel the same north-up/east-right
//          orientation as the 2D map above (directly cross-checkable
//          against it -- see path3dRotate()'s own comment for the algebra)
//   East:  yaw=0, pitch=0 -- East vs. Altitude, North collapses to depth
//   North: yaw=90deg, pitch=0 -- North vs. Altitude, East collapses to depth
// Orbit-dragging away from a preset afterward still works exactly the same
// as always -- these just set a starting yaw/pitch, nothing more.
const PATH3D_VIEW_PRESETS = {
  '3d': [0, 22 * Math.PI / 180],
  top: [0, 90 * Math.PI / 180],
  east: [0, 0],
  north: [90 * Math.PI / 180, 0],
};
// Set the moment the user actually touches the camera themselves (a preset
// button or an orbit-drag) -- see path3dApplyDefaultViewIfUnset()'s own
// comment for what this gates. Same xExplicitlyChosen pattern this app
// already uses for hour/deploy/boost.
let path3dViewExplicitlyChosen = false;
path3dViewToggle.querySelectorAll('button').forEach(btn => {
  btn.addEventListener('click', () => {
    const [yaw, pitch] = PATH3D_VIEW_PRESETS[btn.dataset.view];
    path3dYaw = yaw; path3dPitch = pitch;
    // A preset promises a known, standard framing (e.g. Top matching the 2D
    // map exactly) -- a leftover pan offset from an earlier gesture would
    // quietly break that promise, so presets also re-center.
    path3dPanPxX = 0; path3dPanPxY = 0;
    path3dViewExplicitlyChosen = true;
    path3dViewToggle.querySelectorAll('button').forEach(b => b.classList.toggle('active', b === btn));
    renderDescent3D();
  });
});
// A manual orbit-drag no longer corresponds to any single preset button --
// deselect all of them rather than leaving a stale one highlighted (see
// the pointerup handler below, path3dEndDrag()).
function path3dClearViewPreset() {
  path3dViewExplicitlyChosen = true;
  path3dViewToggle.querySelectorAll('button').forEach(b => b.classList.remove('active'));
}

// Called by app.js's #map-view-toggle click handler right before switching
// INTO 3D mode -- the very first time a user sees this view in a session,
// it opens already lined up with the 2D map they were just looking at
// (Top is pixel-for-pixel the same north-up/east-right orientation, see
// PATH3D_VIEW_PRESETS's own comment) instead of the oblique "3D" default,
// so the points don't appear to jump/reorient on the switch -- less
// disorienting, per direction. Stops applying as soon as
// path3dViewExplicitlyChosen is set (a preset click or a real orbit-drag),
// so it only ever overrides the untouched starting state, never a real
// choice the user already made.
function path3dApplyDefaultViewIfUnset() {
  if (path3dViewExplicitlyChosen) return;
  const [yaw, pitch] = PATH3D_VIEW_PRESETS.top;
  path3dYaw = yaw; path3dPitch = pitch;
  path3dPanPxX = 0; path3dPanPxY = 0;
  path3dViewToggle.querySelectorAll('button').forEach(b => b.classList.toggle('active', b.dataset.view === 'top'));
}

path3dGroundToggle.querySelector('button').addEventListener('click', evt => {
  path3dShowGround = !path3dShowGround;
  evt.currentTarget.classList.toggle('active', path3dShowGround);
  renderDescent3D();
});

function path3dAltFromClientY(clientY) {
  const rect = path3dAltSlider.getBoundingClientRect();
  const frac = 1 - Math.max(0, Math.min(1, (clientY - rect.top) / rect.height));
  return Math.round(frac * path3dAltSliderMaxFt());
}
// Pushes a new apogee into both this panel's own override (immediate) and
// the sidebar's "Specific altitude" field (app.js's syncAltCustomUI()) --
// previously one-way (sidebar -> this panel only; dragging here never told
// the sidebar anything). `commit` is false for the many intermediate
// pointermove updates during a drag (cheap: this panel's own canvas redraw
// plus syncAltCustomUI(), which just reflects a number into an input/status
// line -- no re-simulation), true for the drag's actual endpoint (a tick
// click, an arrow-key step, or pointerup) -- that's the one point a full
// render() runs, which also redraws the (hidden, while in 3D mode) 2D SVG
// map and the sidebar's altitude-ladder highlighting, real cost not worth
// paying on every pixel of a still-moving drag.
function path3dSetAlt(altFt, commit) {
  // Rounded to the nearest 100ft, not 1ft -- a freeform drag/keyboard step
  // implies false precision at 1ft resolution (neither the model nor a
  // mouse gesture is that exact, and dragging to land on an exact foot
  // isn't a reasonable ask of anyone). A no-op for tick clicks -- every
  // DATA.altitudes value is already a clean multiple of 1,000. Someone who
  // genuinely wants an exact number still has the sidebar's "Specific
  // altitude" field for that, untouched by this rounding.
  const rounded = Math.round(altFt / 100) * 100;
  const clamped = Math.max(1, Math.min(path3dAltSliderMaxFt(), rounded));
  path3dAltOverrideFt = clamped;
  path3dSliderJustMoved = true;
  state.customAlt = clamped;
  // Same clearing activateAltCustom() (app.js) does when the sidebar's own
  // input turns "Specific altitude" on -- isolate/pin among the ladder rows
  // stops meaning anything once one specific-altitude zone is the whole
  // view, regardless of which control (sidebar or this slider) set it.
  state.pinnedAlt = null;
  state.isolatedAlt = null;
  syncAltCustomUI();
  if (commit) render(); else renderDescent3D();
}
path3dAltSlider.addEventListener('pointerdown', evt => {
  evt.preventDefault();
  path3dAltSlider.setPointerCapture(evt.pointerId);
  const move = e => path3dSetAlt(path3dAltFromClientY(e.clientY), false);
  const stop = () => {
    document.removeEventListener('pointermove', move);
    document.removeEventListener('pointerup', stop);
    // Final commit -- see path3dSetAlt()'s own comment on why the drag
    // itself doesn't pay for a full render() on every intermediate step.
    if (path3dAltOverrideFt !== null) path3dSetAlt(path3dAltOverrideFt, true);
  };
  document.addEventListener('pointermove', move);
  document.addEventListener('pointerup', stop);
  move(evt);
});
path3dAltSlider.addEventListener('keydown', evt => {
  if (path3dLastResolvedAltFt === null) return;
  const max = path3dAltSliderMaxFt();
  const step = Math.max(1, Math.round(max / 50));
  let next = null;
  if (evt.key === 'ArrowUp' || evt.key === 'ArrowRight') next = Math.min(max, path3dLastResolvedAltFt + step);
  else if (evt.key === 'ArrowDown' || evt.key === 'ArrowLeft') next = Math.max(0, path3dLastResolvedAltFt - step);
  if (next !== null) {
    evt.preventDefault();
    path3dSetAlt(next, true);
  }
});

// Orbit-drag + pan + zoom -- same pointer-capture idiom the map's own pan/
// zoom (#map-wrap) already uses, for consistency rather than a new
// paradigm. When NOT dragging, pointermove instead does proximity hit-
// testing against path3dHitPoints (populated fresh each render by
// path3dDrawPath()) and shows the shared #tooltip -- model, altitude, and
// the wind speed/direction actually driving that point (re-interpolated
// live from DATA.wind_profiles via interpWind(), not stored on the point
// itself).
//
// Pan is a separate gesture from orbit, not an overload of the same drag --
// path3dRotate(0,0,0) is a deliberate invariant (always exactly canvas
// center, see its own comment), so orbit always pivots around the pad by
// design; shifting the camera's actual focus point away from the pad needs
// its own trigger. Right-click-drag on desktop (evt.button === 2, with the
// browser's own context menu suppressed below), or a second simultaneous
// touch point on mobile (path3dActiveTouches, tracked because pointer
// events don't otherwise expose "how many fingers are down right now" --
// there's no pinch-to-zoom on this canvas yet to conflict with).
let path3dDragging = false, path3dLastX = 0, path3dLastY = 0, path3dDragDistPx = 0;
let path3dPanMode = false;
let path3dPanPxX = 0, path3dPanPxY = 0;
const path3dActiveTouches = new Map(); // pointerId -> {x, y}, touch pointers only

function path3dTouchMidpoint() {
  const pts = [...path3dActiveTouches.values()];
  if (pts.length < 2) return null;
  return [(pts[0].x + pts[1].x) / 2, (pts[0].y + pts[1].y) / 2];
}

path3dCanvas.addEventListener('contextmenu', evt => evt.preventDefault()); // right-click is "pan" here, not a menu

path3dCanvas.addEventListener('pointerdown', evt => {
  if (evt.pointerType === 'touch') path3dActiveTouches.set(evt.pointerId, { x: evt.clientX, y: evt.clientY });
  const twoFingerPan = path3dActiveTouches.size >= 2;
  path3dPanMode = evt.button === 2 || twoFingerPan;
  path3dDragging = true;
  path3dDragDistPx = 0;
  path3dCanvas.classList.add('dragging');
  path3dCanvas.setPointerCapture(evt.pointerId);
  const mid = twoFingerPan ? path3dTouchMidpoint() : [evt.clientX, evt.clientY];
  path3dLastX = mid[0]; path3dLastY = mid[1];
});
path3dCanvas.addEventListener('pointermove', evt => {
  if (evt.pointerType === 'touch' && path3dActiveTouches.has(evt.pointerId)) {
    path3dActiveTouches.set(evt.pointerId, { x: evt.clientX, y: evt.clientY });
  }
  if (!path3dDragging) {
    path3dHandleHover(evt);
    return;
  }
  // Tracks the touch pair's own midpoint while panning with two fingers,
  // not each finger's individual movement separately -- averaging two
  // independently-updating pointers through one shared lastX/lastY would
  // otherwise mix their deltas together into an erratic combined motion.
  const mid = (path3dPanMode && path3dActiveTouches.size >= 2) ? path3dTouchMidpoint() : [evt.clientX, evt.clientY];
  const dx = mid[0] - path3dLastX, dy = mid[1] - path3dLastY;
  path3dLastX = mid[0]; path3dLastY = mid[1];
  path3dDragDistPx += Math.abs(dx) + Math.abs(dy);
  // A real orbit/pan no longer matches any single preset button -- deselect
  // once the drag has moved enough to be real, not a stray sub-pixel jitter
  // on what was meant as a click.
  if (path3dDragDistPx > 4) path3dClearViewPreset();
  if (path3dPanMode) {
    path3dPanPxX += dx; path3dPanPxY += dy;
  } else {
    path3dYaw += dx * 0.008;
    // Pitch clamped to [0, 90deg] -- NOT allowed to go negative. A negative
    // pitch means the camera has orbited past looking level and is now
    // looking up from BELOW the horizon, which flips the sign of sin(pitch)
    // in path3dRotate()'s sy term -- north (and everything else with a
    // north component) then renders on the opposite side of the screen
    // from where it did a moment before, which reads as "the chart broke"
    // rather than "the camera went upside down" (confirmed directly: a
    // large enough downward drag from the Top preset, pitch=90deg, swung
    // pitch past 0 into negative territory and put S where N had been).
    // Yaw is deliberately left unclamped -- spinning 360 degrees around the
    // vertical axis is normal orbit-camera behavior and self-consistent
    // (E/W swap screen sides together with the data, an expected result of
    // walking around to the other side of the scene, not a broken one).
    path3dPitch = Math.max(0, Math.min(Math.PI / 2, path3dPitch - dy * 0.008));
  }
  hideTooltip();
  renderDescent3D();
});
function path3dEndDrag(evt) {
  if (evt && evt.pointerType === 'touch') path3dActiveTouches.delete(evt.pointerId);
  path3dDragging = false;
  path3dPanMode = false;
  path3dCanvas.classList.remove('dragging');
}
path3dCanvas.addEventListener('pointerup', path3dEndDrag);
path3dCanvas.addEventListener('pointercancel', path3dEndDrag);
path3dCanvas.addEventListener('mouseleave', hideTooltip);
path3dCanvas.addEventListener('wheel', evt => {
  evt.preventDefault();
  // Max raised from 3x to 20x -- 3x was tuned back when X/Y/Z were each
  // independently normalized to fill the same radius, so the landing
  // cluster already used a good portion of the frame at low zoom. Now that
  // Z is true-to-scale (usually dominated by altitude, see toScreen()'s
  // own comment) that same cluster can render tiny even at 3x, with no way
  // to actually inspect it -- per direction, seeing landing detail matters
  // more than keeping apogee in frame; zooming in far enough to do that
  // means apogee legitimately scrolls off-canvas, which is expected, not
  // a bug (pan -- right-click/two-finger drag -- reaches it again if
  // needed).
  path3dZoom = Math.max(0.4, Math.min(20, path3dZoom * (evt.deltaY < 0 ? 1.08 : 0.92)));
  renderDescent3D();
}, { passive: false });

// Reset each render (path3dDrawScene()), populated by path3dDrawPath() --
// {sx, sy, model, alt_ft, x_ft, y_ft} per point, real levels and
// interpolated steps alike, so hovering anywhere along a line finds
// something nearby, not just the sparse real-level dots.
let path3dHitPoints = [];

function path3dHandleHover(evt) {
  const rect = path3dCanvas.getBoundingClientRect();
  const mx = evt.clientX - rect.left, my = evt.clientY - rect.top;
  let best = null, bestDist = Infinity;
  for (const h of path3dHitPoints) {
    const d = Math.hypot(h.sx - mx, h.sy - my);
    if (d < bestDist) { bestDist = d; best = h; }
  }
  // PROXIMITY_PX -- the same "how close counts as a hover hit" constant
  // the 2D map's own point tooltips use (app.js), not a separate figure
  // invented for this view.
  if (!best || bestDist > PROXIMITY_PX) { hideTooltip(); return; }

  const timeProfiles = profilesForTime(state.timeMinutes);
  const profile = timeProfiles && timeProfiles[best.model];
  // modelNameHTML() (app.js) -- same per-model-colored name every other
  // tooltip on the page uses now, not a plain bolded --accent-blue name.
  const rows = [`<div class="tt-row">${modelNameHTML(best.model)}</div>`,
    `<div class="tt-row">${Math.round(best.alt_ft).toLocaleString()} ft AGL</div>`];
  if (profile) {
    const [spdMph, drc] = interpWind(profile, best.alt_ft);
    // windVaneHTML() (app.js) -- same rotated-arrow-into-the-wind glyph the
    // 2D weather panel's own wind tooltip uses, not a raw degree number.
    rows.push(`<div class="tt-row">${Math.round(spdMph)} mph ${windVaneHTML(drc)}</div>`);
  }
  rows.push(`<div class="tt-row" style="color:var(--text-muted);">${Math.round(best.x_ft)} ft E, ${Math.round(best.y_ft)} ft N of pad</div>`);
  tooltip.innerHTML = rows.join('');
  tooltip.style.display = 'block';
  positionTooltip(evt);
}

if (window.ResizeObserver) {
  new ResizeObserver(() => { if (mapViewMode === '3d') renderDescent3D(); }).observe(path3dCanvasWrap);
} else {
  window.addEventListener('resize', () => { if (mapViewMode === '3d') renderDescent3D(); });
}

// --- ground-plane imagery (satellite/road texture on the z=0 plane) -------
// Reuses the exact same image files and geo-registration data the 2D map
// already publishes (DATA.site_px/ft_to_px_scale/wide_view_box/
// image_view_box, render()'s wideImage/detailImage construction in
// app.js) -- no new pipeline work, purely a client-side addition. Lazy-
// loaded per (site, layer) pair, cached, keyed off the same global
// mapLayer ("sat"/"road") the 2D map's own Satellite/Road toggle already
// drives, so that toggle switches this texture too.
const path3dGroundImages = new Map();
function path3dGetGroundImage(kind) {
  const key = `${currentSiteId}_${mapLayer}_${kind}`;
  let img = path3dGroundImages.get(key);
  if (!img) {
    img = new Image();
    img.onload = () => { if (path3dShowGround && mapViewMode === '3d') renderDescent3D(); };
    img.src = `maps/${currentSiteId}/${kind}_${mapLayer}_web.jpg`;
    path3dGroundImages.set(key, img);
  }
  return img;
}

// Both source images live in one shared pixel space (the DETAIL image's
// own native pixel grid -- app.js's render() positions the wide image
// into that same space via DATA.wide_view_box, not its own separate
// space). Real feet convert to/from that space via
// DATA.site_px/ft_to_px_scale (ft_to_px_scale's own comment in
// splash_zones.py: "exposing scale.x/scale.y explicitly... is what lets
// the boost-angle buffer move client-side" -- same published fields,
// reused here for a different client-side geometry need).
function path3dDetailPxToFt(px, py) {
  return [(px - DATA.site_px[0]) / DATA.ft_to_px_scale.x, (DATA.site_px[1] - py) / DATA.ft_to_px_scale.y];
}
// Corners in real feet (relative to the pad), for the image's own 3
// defining corners: top-left, top-right, bottom-left (a 4th corner is
// redundant -- 3 points fully determine an affine map).
//
// Both layers go through the SAME fractional remap -- a delivered "_web"
// JPEG's own real pixel dimensions (img.naturalWidth/Height) do NOT
// necessarily match the resolution site_px/ft_to_px_scale were computed
// against server-side (confirmed directly: hutto's detail_sat_web.jpg is
// 1600x1600 but DATA.image_view_box says 3384x3384; hearne's is
// 1599x1600 against a published 2035x2036 -- the "_web" files are resized
// down for file size, independently of the geo-registration math). An
// earlier version treated the detail image's own native pixel space as
// if it WERE already detail-pixel-space with no remap at all, which
// squashed it toward its own top-left corner by whatever the resize
// factor happened to be -- correct at exactly pixel (0,0), increasingly
// wrong moving away from it, which is why it looked closer to right for
// hutto (small site_px offset from that corner) and badly wrong for
// hearne (confirmed via a user screenshot: pad crosshair and 3D origin
// landed nowhere near each other on the same imagery). DATA.image_view_box
// (always [0,0,true_w,true_h]) is the detail image's own equivalent of
// wide_view_box -- using it here the same way removes the asymmetry.
function path3dGroundCornersFt(kind, img) {
  const w = img.naturalWidth, h = img.naturalHeight;
  const [vx, vy, vw, vh] = kind === 'detail' ? DATA.image_view_box : DATA.wide_view_box;
  const corners = [[0, 0], [w, 0], [0, h]];
  return corners.map(([px, py]) => path3dDetailPxToFt(vx + (px / w) * vw, vy + (py / h) * vh));
}

// Solves the 2x3 affine matrix [a,b,c,d,e,f] (ctx.transform()'s own
// argument order) mapping source points (0,0)/(w,0)/(0,h) to their given
// screen-space images -- i.e. reconstructs an affine map from 3
// correspondences.  p0->s0, p1->s1, p2->s2 with p0=(0,0), p1=(w,0),
// p2=(0,h): a=(s1x-s0x)/w, b=(s1y-s0y)/w, c=(s2x-s0x)/h, d=(s2y-s0y)/h,
// e=s0x, f=s0y.
function path3dSolveAffine(w, h, s0, s1, s2) {
  return [(s1[0] - s0[0]) / w, (s1[1] - s0[1]) / w, (s2[0] - s0[0]) / h, (s2[1] - s0[1]) / h, s0[0], s0[1]];
}

// Orthographic projection of a flat (z=0) rectangle is exactly an affine
// transform (toScreen(x,y,0) reduces to a 2x2 matrix multiply + constant
// translation, the z-term drops out entirely) -- so this draws with zero
// warping error, not an approximation. At the East/North view presets
// (looking edge-on at the ground plane), the 3 corners' screen positions
// collapse toward a line and the resulting transform squashes the image
// to a near-zero-height sliver -- mathematically valid and visually
// correct (you genuinely are looking at the ground edge-on from there),
// not a bug to "fix" later.
function path3dDrawGroundLayer(kind, toScreen) {
  const img = path3dGetGroundImage(kind);
  if (!img.complete || !img.naturalWidth) return; // not loaded yet -- onload above re-renders when ready
  const cornersFt = path3dGroundCornersFt(kind, img);
  const [s0, s1, s2] = cornersFt.map(([xFt, yFt]) => toScreen(xFt, yFt, 0));
  const ctx = path3dCtx;
  ctx.save();
  // transform(), not setTransform() -- composes onto the devicePixelRatio
  // scale path3dDrawScene() already applied, rather than replacing it.
  ctx.transform(...path3dSolveAffine(img.naturalWidth, img.naturalHeight, s0, s1, s2));
  ctx.drawImage(img, 0, 0);
  ctx.restore();
}

function path3dShowEmpty(msg) {
  path3dEmptyHint.textContent = msg;
  path3dEmptyHint.style.display = '';
  path3dMain.style.display = 'none';
}
function path3dShowCanvas() {
  path3dEmptyHint.style.display = 'none';
  path3dMain.style.display = '';
}

function renderDescent3D() {
  if (mapViewMode !== '3d') return;
  if (!DATA || !state) return;

  const altFt = path3dResolveAltFt();
  path3dLastResolvedAltFt = altFt;
  path3dUpdateAltSliderUI(altFt);

  if (state.mode !== 'byAltitude') {
    path3dShowEmpty('Switch to "By altitude" view to see a descent path here.');
    return;
  }

  const pathsRaw = descentPathsFor(state.timeMinutes, state.deploy, altFt);
  const paths = pathsRaw.filter(p => state.selectedModels === null || state.selectedModels.has(p.model));

  if (!paths.length) {
    path3dShowEmpty('No wind profile available for this hour/deploy/altitude -- try a different combination, or select at least one model.');
    return;
  }

  path3dShowCanvas();
  path3dDrawScene(paths, altFt);
}

function path3dDrawScene(paths, altFt) {
  const dpr = window.devicePixelRatio || 1;
  const rect = path3dCanvas.getBoundingClientRect();
  const w = Math.max(1, Math.round(rect.width * dpr));
  const h = Math.max(1, Math.round(rect.height * dpr));
  if (path3dCanvas.width !== w || path3dCanvas.height !== h) { path3dCanvas.width = w; path3dCanvas.height = h; }
  path3dCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
  path3dCtx.clearRect(0, 0, rect.width, rect.height);
  path3dHitPoints = [];

  // X and Y (both horizontal feet, real east/north drift) share ONE scale
  // -- maxXY, not independent maxX/maxY. Normalizing them separately would
  // rescale east and north by different factors whenever a path drifted
  // further in one direction than the other (the common case), which
  // silently lies about real compass bearing: an actual 45-degree drift
  // could render at some other angle entirely, or a due-east drift could
  // visually tilt off axis.
  // padOffsetFt (app.js) is the 2D map's "try a nearby setup spot"
  // exploration -- a pure display-time shift of the whole rigid scene, not
  // a re-simulation (same wind applies close by), exactly mirroring how
  // ftToPx() adds it to x_ft/y_ft before scaling to pixels. Added here too
  // so the 3D view stays in sync with the 2D map's own preview instead of
  // always showing the true surveyed pad regardless of that exploration --
  // per direction, the two should track each other. Applied to the raw ft
  // value BEFORE normalization (both here and in maxXY below), not as a
  // post-hoc screen-space nudge, so it's a real shift of the world, not a
  // cosmetic one -- the origin marker and ground-plane image both move
  // with it, same as the 2D map's own pad crosshair does.
  //
  // railShiftFt(pt.alt_ft) (app.js) is the same rail-heading/angle shift
  // the 2D map applies per-altitude via ftToPxShifted() -- grows with
  // altitude, so it's evaluated per-point here (not once at apogee) to
  // match the 2D view's own per-altitude treatment exactly. At alt_ft=0
  // it's always {0,0}, so the pad/ground-plane origin (toScreen(...,0))
  // is naturally unaffected without any special-casing.
  let maxXY = 1;
  const maxZ = Math.max(1, altFt);
  paths.forEach(p => p.path.forEach(pt => {
    const shift = railShiftFt(pt.alt_ft);
    maxXY = Math.max(maxXY, Math.abs(pt.x_ft + padOffsetFt.x + shift.x), Math.abs(pt.y_ft + padOffsetFt.y + shift.y));
  }));
  const maxX = maxXY, maxY = maxXY;

  // How much Z actually contributes to the CURRENT view's vertical screen
  // position -- path3dRotate()'s sy term is `rd*sinP + nz*cosP`, so at
  // pitch=90deg (Top) cosP=0 and Z contributes NOTHING to sy at all (it
  // becomes pure depth instead -- see path3dRotate()'s own comment); at
  // pitch=0deg (W-E/N-S) cosP=1 and Z is the entire vertical axis. Reused
  // below for both the projection scale and the origin's vertical position
  // -- same underlying fact driving two different pieces of the layout,
  // not two independent tunings that happen to agree.
  const verticalWeight = Math.cos(path3dPitch); // 1 at pitch=0 (W-E/N-S), 0 at pitch=90deg (Top)

  // True-to-scale, per direction -- X/Y/Z all divide by the SAME scaleFt,
  // not independently normalized (independent normalization used to make
  // horizontal drift read as far more dramatic than it actually was
  // relative to how far the rocket fell). But blended by verticalWeight,
  // not a flat max(maxXY, maxZ) -- at Top, Z isn't rendered at all (see
  // verticalWeight's own comment), so scaling by it there was needlessly
  // shrinking the one thing Top actually shows (X/Y) for no honesty
  // benefit; confirmed as a real, reported problem ("even on top view you
  // can't get in far enough to see clearly"). At pitch=0 this is exactly
  // max(maxXY, maxZ) (the original true-to-scale intent, unchanged); at
  // Top it's exactly maxXY (full frame usage, since X:Y's own ratio is
  // still preserved regardless of the absolute divisor -- dividing X, Y,
  // AND Z by the same number never distorts their relative proportions,
  // only how much of the frame the whole scene fills). maxX/maxY/maxZ
  // (above) still carry each axis's own real data extent for axis-length/
  // tick-spacing purposes (path3dDrawAxes() below) -- only the shared
  // projection divisor changed, not what range each axis actually reports.
  // The ground-plane image is unaffected code-wise (path3dDrawGroundLayer()
  // already goes through this same toScreen()) -- like everything else, it
  // renders larger now at pitches closer to Top, smaller closer to W-E/N-S.
  const scaleFt = maxXY + (Math.max(maxXY, maxZ) - maxXY) * verticalWeight;

  // Origin sits near the bottom of the frame, not dead center, whenever
  // altitude (Z) is contributing real vertical screen space -- Z only ever
  // spans 0..maxZ (apogee down to the ground, never negative, unlike X/Y
  // which drift either direction), so centering it wastes the bottom half
  // of the canvas on nothing while cramping the actual path into the top
  // half -- exactly the "have to pan every time" friction per direction.
  // At pitch=90deg (Top) the origin stays centered instead, matching Y/X's
  // own +/- symmetric range in that view (verticalWeight=0 there); at
  // pitch=0deg (W-E/N-S) it shifts all the way down (verticalWeight=1);
  // the oblique "3D" default (pitch=22deg) and any manual orbit land
  // smoothly in between, not as separate cases to enumerate.
  const centeredCy = rect.height / 2 + 8;
  const bottomCy = rect.height * 0.82;
  const cx = rect.width / 2 + path3dPanPxX;
  const cy = centeredCy + (bottomCy - centeredCy) * verticalWeight + path3dPanPxY;
  const radius = Math.min(rect.width, rect.height) * 0.34 * path3dZoom;

  function toScreen(xFt, yFt, zFt) {
    const shift = railShiftFt(zFt);
    const r = path3dRotate((xFt + padOffsetFt.x + shift.x) / scaleFt, (yFt + padOffsetFt.y + shift.y) / scaleFt, zFt / scaleFt);
    return [cx + r.sx * radius, cy - r.sy * radius, r.depth];
  }

  // Ground plane first, before axes/paths, so it reads as a floor
  // underneath them -- wide layer behind (broad coverage), detail layer
  // in front (sharper close-up near the pad), same compositing order the
  // 2D map itself uses.
  if (path3dShowGround) {
    path3dDrawGroundLayer('wide', toScreen);
    path3dDrawGroundLayer('detail', toScreen);
  }

  path3dDrawAxes(toScreen, maxX, maxY, maxZ, rect.width, rect.height);

  // Depth-sort so nearer lines draw over farther ones -- purely visual
  // (disentangles overlapping model lines when orbited), touches no data.
  const ordered = paths
    .map(p => ({ p, depth: p.path.reduce((s, pt) => s + toScreen(pt.x_ft, pt.y_ft, pt.alt_ft)[2], 0) / p.path.length }))
    .sort((a, b) => a.depth - b.depth)
    .map(o => o.p);

  ordered.forEach(p => path3dDrawPath(p, toScreen, altFt));
}

function path3dDrawAxes(toScreen, maxX, maxY, maxZ, canvasW, canvasH) {
  const ctx = path3dCtx;
  ctx.save();
  ctx.strokeStyle = path3dCssVar('--border');
  ctx.fillStyle = path3dCssVar('--text-muted');
  // Tick density AND font size both scale down on a small canvas (a narrow
  // phone gets a small canvas from the aspect-ratio box) -- a fixed 4
  // ticks/axis at 11px overlapped into unreadable text soup well before
  // 375px, confirmed directly via screenshot. Fewer, larger-relative-to-
  // canvas ticks stay legible down to the smallest tested width instead of
  // just shrinking text until it's technically present but unreadable.
  const minSide = Math.min(canvasW, canvasH);
  const fontPx = minSide < 260 ? 9 : minSide < 420 ? 10 : 11;
  const targetXYTicks = minSide < 260 ? 2 : minSide < 420 ? 3 : 4;
  const targetZTicks = minSide < 260 ? 3 : minSide < 420 ? 4 : 5;
  ctx.font = `${fontPx}px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif`;
  ctx.lineWidth = 1;

  const origin = toScreen(0, 0, 0);
  const xPos = toScreen(maxX, 0, 0), xNeg = toScreen(-maxX, 0, 0);
  const yPos = toScreen(0, maxY, 0), yNeg = toScreen(0, -maxY, 0);
  const zPos = toScreen(0, 0, maxZ);
  [[xNeg, xPos], [yNeg, yPos], [origin, zPos]].forEach(([a, b]) => {
    ctx.beginPath(); ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]); ctx.stroke();
  });

  const xStep = path3dNiceStep(maxX, targetXYTicks), yStep = path3dNiceStep(maxY, targetXYTicks), zStep = path3dNiceStep(maxZ, targetZTicks);

  ctx.textAlign = 'center'; ctx.textBaseline = 'top';
  for (let v = -Math.floor(maxX / xStep) * xStep; v <= maxX + 1e-6; v += xStep) {
    if (Math.abs(v) < 1e-6) continue;
    const [sx, sy] = toScreen(v, 0, 0);
    ctx.fillText(String(Math.round(v)), sx, sy + 4);
  }
  ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
  for (let v = -Math.floor(maxY / yStep) * yStep; v <= maxY + 1e-6; v += yStep) {
    if (Math.abs(v) < 1e-6) continue;
    const [sx, sy] = toScreen(0, v, 0);
    ctx.fillText(String(Math.round(v)), sx + 4, sy);
  }
  ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
  for (let v = zStep; v <= maxZ + 1e-6; v += zStep) {
    const [sx, sy] = toScreen(0, 0, v);
    ctx.fillText(Math.round(v).toLocaleString() + 'ft', sx - 6, sy);
  }

  // Both ends of each horizontal axis get an explicit compass letter (not
  // just a label at the positive end, leaving the negative end to be
  // inferred) -- single letters (E/W/N/S), same compact convention the
  // rest of this app already uses for compass directions (pad-readout's
  // compassDir(), pull_live_forecast.py's compass()), not spelled out.
  ctx.font = `600 ${fontPx}px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif`;
  ctx.fillStyle = path3dCssVar('--text-secondary');
  const xCap = toScreen(maxX * 1.12, 0, 0), xCapNeg = toScreen(-maxX * 1.12, 0, 0);
  ctx.textAlign = 'center'; ctx.textBaseline = 'top';
  ctx.fillText('E', xCap[0], xCap[1] + 6);
  ctx.fillText('W', xCapNeg[0], xCapNeg[1] + 6);
  const yCap = toScreen(0, maxY * 1.12, 0), yCapNeg = toScreen(0, -maxY * 1.12, 0);
  ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
  ctx.fillText('N', yCap[0] + 6, yCap[1]);
  ctx.textAlign = 'right';
  ctx.fillText('S', yCapNeg[0] - 6, yCapNeg[1]);
  const zCap = toScreen(0, 0, maxZ * 1.08);
  ctx.textAlign = 'center'; ctx.textBaseline = 'bottom'; ctx.fillText('Altitude AGL (ft)', zCap[0], zCap[1] - 6);

  // Pad marker -- small filled dot at the true origin, so "where is 0,0,0"
  // reads at a glance regardless of orbit angle.
  ctx.fillStyle = path3dCssVar('--text-primary');
  ctx.beginPath(); ctx.arc(origin[0], origin[1], 2.5, 0, Math.PI * 2); ctx.fill();

  ctx.restore();
}

function path3dDrawPath(p, toScreen, altFt) {
  const ctx = path3dCtx;
  const color = MODEL_COLORS_HEX[p.model] || '#888';
  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineWidth = 1.75;
  ctx.beginPath();
  p.path.forEach((pt, i) => {
    const [sx, sy] = toScreen(pt.x_ft, pt.y_ft, pt.alt_ft);
    if (i === 0) ctx.moveTo(sx, sy); else ctx.lineTo(sx, sy);
    path3dHitPoints.push({ sx, sy, model: p.model, alt_ft: pt.alt_ft, x_ft: pt.x_ft, y_ft: pt.y_ft });
  });
  ctx.stroke();

  // Dots only at real reported wind-profile altitudes -- the rest of the
  // line is a smooth interpolation between them. GFS's ~44 levels read as
  // visibly denser dots than ICON's ~19 at the same altitude, an honest
  // resolution difference this makes visible rather than hiding it.
  ctx.fillStyle = color;
  p.path.forEach(pt => {
    if (!pt.isRealLevel) return;
    const [sx, sy] = toScreen(pt.x_ft, pt.y_ft, pt.alt_ft);
    ctx.beginPath(); ctx.arc(sx, sy, 2.4, 0, Math.PI * 2); ctx.fill();
  });

  const last = p.path[p.path.length - 1];
  const [lx, ly] = toScreen(last.x_ft, last.y_ft, last.alt_ft);

  // Ground-end gust halo -- the ONE altitude gust data actually exists for
  // (Open-Meteo has no gust field at any other height/pressure level,
  // confirmed live -- see splash_zones.py's build_wind_data() comment).
  // Not fabricated anywhere else along the path.
  // DATA.wind.hourly is already dense (every real hour in
  // config.RAIN_WINDOW_START/END_HOUR_LOCAL, not just the weather panel's
  // sparse SPLASH_HOURS_LOCAL checkpoints -- see build_wind_data()'s own
  // comment), so nearest-hour rounding is a real hour's own reading here,
  // not an approximation across a wide gap.
  const groundHour = nearestPublishedHour(state.timeMinutes);
  const groundCell = DATA.wind && DATA.wind.hourly[groundHour] ? DATA.wind.hourly[groundHour][p.model] : null;
  const gust = groundCell ? groundCell.gust : null;
  if (gust !== null && gust !== undefined) {
    const r = 3 + Math.min(10, gust / 3);
    ctx.beginPath(); ctx.arc(lx, ly, r, 0, Math.PI * 2);
    ctx.globalAlpha = 0.5; ctx.lineWidth = 1.5; ctx.strokeStyle = color; ctx.stroke();
    ctx.globalAlpha = 1;
  }

  // Landing marker -- color AND shape both mean model here too now (same
  // MODEL_SHAPES signal app.js's drawPoint()/History already use, see that
  // constant's own comment), not just color -- the colorblind-safe backup
  // shouldn't stop existing just because this view renders to a <canvas>
  // instead of SVG. path3dShapePath() (below) shares the actual point
  // geometry with app.js's shapePolygonPoints() directly, only the last
  // "draw these points" step differs by API.
  ctx.beginPath();
  path3dShapePath(ctx, MODEL_SHAPES[p.model] || 'circle', lx, ly, 7);
  ctx.fillStyle = color;
  ctx.fill();
  ctx.lineWidth = 2; ctx.strokeStyle = path3dCssVar('--point-stroke'); ctx.stroke();

  // Apogee marker -- small hollow circle at the top of the path,
  // distinguishes "start" from "landing" at a glance without a legend.
  const top = toScreen(0, 0, altFt);
  ctx.beginPath(); ctx.arc(top[0], top[1], 3, 0, Math.PI * 2);
  ctx.fillStyle = path3dCssVar('--surface-1'); ctx.fill();
  ctx.lineWidth = 1.5; ctx.strokeStyle = color; ctx.stroke();

  ctx.restore();
}

// Canvas equivalent of app.js's drawMarker() shape branch -- appends to
// whatever path ctx.beginPath() already started, doesn't stroke/fill itself
// (caller decides that, same division of labor path3dDrawPath()'s other
// shapes already use). Circle/square are their own canvas primitives, but
// everything else (triangle-up/triangle-down/diamond/plus/x/star) reuses
// app.js's shapePolygonPoints() directly for the actual point geometry --
// that math is pure coordinate generation with no SVG-specific step in it,
// so duplicating it here (an earlier version of this function did exactly
// that) was real, avoidable drift risk, not a necessary SVG-vs-canvas
// difference. SHAPE_SIZE_MULT (app.js) applied here too, same as
// drawMarker()/shapeSwatchSVG() -- otherwise the 3D view's landing markers
// would show the same "different shapes, different visual weight"
// mismatch this whole change exists to fix.
function path3dShapePath(ctx, shape, cx, cy, size) {
  if (shape === 'circle') {
    ctx.arc(cx, cy, size, 0, Math.PI * 2);
    return;
  }
  const scaled = size * (SHAPE_SIZE_MULT[shape] || 1);
  if (shape === 'square') {
    ctx.rect(cx - scaled, cy - scaled, scaled * 2, scaled * 2);
    return;
  }
  shapePolygonPoints(shape, cx, cy, scaled).forEach(([x, y], i) => {
    if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  });
  ctx.closePath();
}
