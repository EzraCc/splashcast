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
// Axes are independently normalized per-axis, not held to one shared
// ft-per-pixel scale -- altitude commonly spans thousands of feet while
// horizontal drift is typically tens to a few thousand, so a single
// true-to-scale axis would flatten the horizontal spread (the actually
// interesting part of "how does this model's path curve") into a barely-
// visible sliver. Real tick labels at each gridline keep magnitude
// honestly readable despite the normalization.
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
let path3dRate = 'fast';
let path3dCollapsed = true;
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
const path3dBody = document.getElementById('descent3d-body');
const path3dMain = document.getElementById('descent3d-main');
const path3dEmptyHint = document.getElementById('descent3d-empty-hint');
const path3dTitleToggle = document.getElementById('descent3d-title-toggle');
const path3dChevron = document.getElementById('descent3d-chevron');
const path3dRateToggle = document.getElementById('descent3d-rate-toggle');
const path3dViewToggle = document.getElementById('descent3d-view-toggle');
const path3dGroundToggle = document.getElementById('descent3d-ground-toggle');
const path3dAltSlider = document.getElementById('descent3d-alt-slider');
const path3dAltFill = document.getElementById('descent3d-alt-fill');
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
  path3dAltFill.style.height = (frac * 100) + '%';
  path3dAltThumb.style.bottom = (frac * 100) + '%';
  path3dAltReadout.textContent = Math.round(altFt).toLocaleString() + ' ft';
  path3dAltSlider.setAttribute('aria-valuenow', String(Math.round(altFt)));
  path3dAltSlider.setAttribute('aria-valuemin', '0');
  path3dAltSlider.setAttribute('aria-valuemax', String(Math.round(max)));
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

function path3dToggleCollapsed() {
  path3dCollapsed = !path3dCollapsed;
  path3dTitleToggle.setAttribute('aria-expanded', String(!path3dCollapsed));
  path3dChevron.classList.toggle('collapsed', path3dCollapsed);
  path3dBody.style.display = path3dCollapsed ? 'none' : '';
  if (!path3dCollapsed) renderDescent3D();
}
path3dTitleToggle.addEventListener('click', path3dToggleCollapsed);
path3dTitleToggle.addEventListener('keydown', evt => {
  if (evt.key === 'Enter' || evt.key === ' ') { evt.preventDefault(); path3dToggleCollapsed(); }
});

path3dRateToggle.querySelectorAll('button').forEach(btn => {
  btn.addEventListener('click', () => {
    if (btn.dataset.rate === path3dRate) return;
    path3dRate = btn.dataset.rate;
    path3dRateToggle.querySelectorAll('button').forEach(b => b.classList.toggle('active', b === btn));
    renderDescent3D();
  });
});

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
path3dViewToggle.querySelectorAll('button').forEach(btn => {
  btn.addEventListener('click', () => {
    const [yaw, pitch] = PATH3D_VIEW_PRESETS[btn.dataset.view];
    path3dYaw = yaw; path3dPitch = pitch;
    path3dViewToggle.querySelectorAll('button').forEach(b => b.classList.toggle('active', b === btn));
    renderDescent3D();
  });
});
// A manual orbit-drag no longer corresponds to any single preset button --
// deselect all of them rather than leaving a stale one highlighted (see
// the pointerup handler below, path3dEndDrag()).
function path3dClearViewPreset() {
  path3dViewToggle.querySelectorAll('button').forEach(b => b.classList.remove('active'));
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
path3dAltSlider.addEventListener('pointerdown', evt => {
  evt.preventDefault();
  path3dAltSlider.setPointerCapture(evt.pointerId);
  const move = e => {
    path3dAltOverrideFt = path3dAltFromClientY(e.clientY);
    path3dSliderJustMoved = true;
    renderDescent3D();
  };
  const stop = () => {
    document.removeEventListener('pointermove', move);
    document.removeEventListener('pointerup', stop);
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
    path3dAltOverrideFt = next;
    path3dSliderJustMoved = true;
    renderDescent3D();
  }
});

// Orbit-drag + zoom -- same pointer-capture idiom the map's own pan/zoom
// (#map-wrap) already uses, for consistency rather than a new paradigm.
// When NOT dragging, pointermove instead does proximity hit-testing
// against path3dHitPoints (populated fresh each render by path3dDrawPath())
// and shows the shared #tooltip -- model, altitude, and the wind speed/
// direction actually driving that point (re-interpolated live from
// DATA.wind_profiles via interpWind(), not stored on the point itself).
let path3dDragging = false, path3dLastX = 0, path3dLastY = 0, path3dDragDistPx = 0;
path3dCanvas.addEventListener('pointerdown', evt => {
  path3dDragging = true;
  path3dDragDistPx = 0;
  path3dCanvas.classList.add('dragging');
  path3dCanvas.setPointerCapture(evt.pointerId);
  path3dLastX = evt.clientX; path3dLastY = evt.clientY;
});
path3dCanvas.addEventListener('pointermove', evt => {
  if (!path3dDragging) {
    path3dHandleHover(evt);
    return;
  }
  const dx = evt.clientX - path3dLastX, dy = evt.clientY - path3dLastY;
  path3dLastX = evt.clientX; path3dLastY = evt.clientY;
  path3dDragDistPx += Math.abs(dx) + Math.abs(dy);
  // A real orbit no longer matches any single preset button -- deselect
  // once the drag has moved enough to be a real orbit, not a stray
  // sub-pixel jitter on what was meant as a click.
  if (path3dDragDistPx > 4) path3dClearViewPreset();
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
  hideTooltip();
  renderDescent3D();
});
function path3dEndDrag() { path3dDragging = false; path3dCanvas.classList.remove('dragging'); }
path3dCanvas.addEventListener('pointerup', path3dEndDrag);
path3dCanvas.addEventListener('pointercancel', path3dEndDrag);
path3dCanvas.addEventListener('mouseleave', hideTooltip);
path3dCanvas.addEventListener('wheel', evt => {
  evt.preventDefault();
  path3dZoom = Math.max(0.4, Math.min(3, path3dZoom * (evt.deltaY < 0 ? 1.08 : 0.92)));
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

  const profile = DATA.wind_profiles[state.hour] && DATA.wind_profiles[state.hour][best.model];
  const rows = [`<div class="tt-row"><b>${MODEL_LABELS[best.model] || best.model.toUpperCase()}</b></div>`,
    `<div class="tt-row">${Math.round(best.alt_ft).toLocaleString()} ft AGL</div>`];
  if (profile) {
    const [spdMph, drc] = interpWind(profile, best.alt_ft);
    rows.push(`<div class="tt-row">${Math.round(spdMph)} mph @ ${Math.round(drc)}&deg;</div>`);
  }
  rows.push(`<div class="tt-row" style="color:var(--text-muted);">${Math.round(best.x_ft)} ft E, ${Math.round(best.y_ft)} ft N of pad</div>`);
  tooltip.innerHTML = rows.join('');
  tooltip.style.display = 'block';
  positionTooltip(evt);
}

if (window.ResizeObserver) {
  new ResizeObserver(() => { if (!path3dCollapsed) renderDescent3D(); }).observe(path3dCanvasWrap);
} else {
  window.addEventListener('resize', () => { if (!path3dCollapsed) renderDescent3D(); });
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
    img.onload = () => { if (path3dShowGround && !path3dCollapsed) renderDescent3D(); };
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
function path3dGroundCornersFt(kind, img) {
  const w = img.naturalWidth, h = img.naturalHeight;
  const corners = [[0, 0], [w, 0], [0, h]];
  if (kind === 'detail') {
    return corners.map(([px, py]) => path3dDetailPxToFt(px, py));
  }
  // wide: first remap its own native pixel space into detail-pixel space
  // via DATA.wide_view_box ([vx, vy, vw, vh]), same as app.js's render()
  // does when positioning the <image> element for the 2D map.
  const [vx, vy, vw, vh] = DATA.wide_view_box;
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
  if (path3dCollapsed) return;
  if (!DATA || !state) return;

  const altFt = path3dResolveAltFt();
  path3dLastResolvedAltFt = altFt;
  path3dUpdateAltSliderUI(altFt);

  if (state.mode !== 'byAltitude') {
    path3dShowEmpty('Switch to "By altitude" view to see a descent path here.');
    return;
  }

  const pathsRaw = descentPathsFor(state.hour, state.deploy, altFt, path3dRate);
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
  // visually tilt off axis. Only Z (altitude) gets its own independent
  // scale (see file-top comment) -- that's a deliberate, different kind of
  // axis (the entire point of a 3D view here is showing vertical descent,
  // and altitude range routinely dwarfs horizontal drift), not an
  // oversight; X vs Y have no equivalent justification for differing.
  let maxXY = 1;
  const maxZ = Math.max(1, altFt);
  paths.forEach(p => p.path.forEach(pt => {
    maxXY = Math.max(maxXY, Math.abs(pt.x_ft), Math.abs(pt.y_ft));
  }));
  const maxX = maxXY, maxY = maxXY;

  const cx = rect.width / 2, cy = rect.height / 2 + 8;
  const radius = Math.min(rect.width, rect.height) * 0.34 * path3dZoom;

  function toScreen(xFt, yFt, zFt) {
    const r = path3dRotate(xFt / maxX, yFt / maxY, zFt / maxZ);
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

  // Ground-end gust halo -- the ONE altitude gust data actually exists for
  // (Open-Meteo has no gust field at any other height/pressure level,
  // confirmed live -- see splash_zones.py's build_wind_data() comment).
  // Not fabricated anywhere else along the path.
  const groundCell = DATA.wind && DATA.wind.hourly[state.hour] ? DATA.wind.hourly[state.hour][p.model] : null;
  const gust = groundCell ? groundCell.gust : null;
  if (gust !== null && gust !== undefined) {
    const last = p.path[p.path.length - 1];
    const [sx, sy] = toScreen(last.x_ft, last.y_ft, last.alt_ft);
    const r = 3 + Math.min(10, gust / 3);
    ctx.beginPath(); ctx.arc(sx, sy, r, 0, Math.PI * 2);
    ctx.globalAlpha = 0.5; ctx.lineWidth = 1.5; ctx.strokeStyle = color; ctx.stroke();
    ctx.globalAlpha = 1;
  }

  // Apogee marker -- small hollow circle at the top of the path,
  // distinguishes "start" from "landing" at a glance without a legend.
  const top = toScreen(0, 0, altFt);
  ctx.beginPath(); ctx.arc(top[0], top[1], 3, 0, Math.PI * 2);
  ctx.fillStyle = path3dCssVar('--surface-1'); ctx.fill();
  ctx.lineWidth = 1.5; ctx.strokeStyle = color; ctx.stroke();

  ctx.restore();
}
