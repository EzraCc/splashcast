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
// Altitude selection (resolveMapAltFt(), app.js) is shared with the 2D map
// now -- 2026-08, promoted from this file's own bespoke slider/priority
// chain to one implementation both frames use, since the compact altitude
// control it drove is no longer 3D-only. renderDescent3D() just reads
// whatever that resolves to on each call.

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
// --- real ascent-path integration: splices real (rocketry-generated) ------
// boost-phase simulations into this view in place of the straight-line
// tan(angle) approximation railShiftFt() (app.js) otherwise stands in for.
// ASCENT_RESULTS (app.js) is null until a visitor opens the "Simulate real
// ascent path" panel and runs a sim in rocketry's own embedded UI -- see
// app.js's own "rocketry ascent-path sim" section for the postMessage
// listener that sets it, and .claude/plans/rocketry-flight-sim-
// integration.md for the full cross-origin contract. Rocketry computes one
// ascent per forecast model (the same wind profile each model's own descent
// path already integrates), not a single result -- ASCENT_RESULTS.results
// is `[{model, ascentPath}, ...]`. Every function below that used to read
// "the" ascent path now takes a specific model's `ascentPath` object
// explicitly, and every draw site below is keyed off `paths` (the SAME
// already state.selectedModels-filtered list path3dDrawPath() draws descent
// lines from, see renderDescent3D()) -- an ascent curve only ever gets drawn
// for a model whose descent line is also currently showing, which is what
// ties the two together and makes them toggle as one unit. While a sim
// result is active, the rail-angle dial is disabled (see app.js's message
// listener) -- its own simple shift would double up against/contradict the
// real weathercocking physics the sim result already accounts for, and
// "just move apogee along the same line" isn't how a real sim's own apogee
// offset works, so the two aren't reconcilable as-is.
const ASCENT_M_TO_FT = 3.28084; // same literal pipeline/config.py's own elev_ft_for_site() uses

// PREFETCH_HOURS -- ASCENT_RESULTS.resultsByHour (2026-08, hour-aware
// rewrite) is `{[hour]: [{model, ascentPath}, ...]}`, keyed by hour, not a
// flat `results` array any more -- reported directly: "when the time is
// switched, apogee doesn't change," because the old single-hour contract
// froze whatever hour the panel happened to be opened at. Rocketry itself
// didn't need to change at all ("they only digest what we send them") --
// app.js's message listener now drives a background prefetch through the
// hidden #ascent-sim-prefetch-iframe, one hour at a time, same rocket/motor
// auto-restored via rocketry's own existing caching, and stores each
// result here as it arrives. Deliberately hourly-only, 0900-1500 (per
// direction, "I don't want 15 minute resolution... to help manage data
// bloat") -- NOT the full 15-minute drag resolution the time slider
// otherwise supports elsewhere in this app.
const ASCENT_PREFETCH_HOURS = [9, 10, 11, 12, 13, 14, 15];

// Every real hour ASCENT_RESULTS.resultsByHour has DATA FOR THIS SPECIFIC
// MODEL -- a model can be present in some hours' results and missing from
// others (e.g. a background-prefetch hour that errored, or 'actual',
// History's real-flight overlay, which never has a matching sim result at
// all), same per-model tolerance this file always had. Ascending, for the
// bracket-finding below.
function ascentAvailableHoursForModel(model) {
  if (!ASCENT_RESULTS) return [];
  return Object.keys(ASCENT_RESULTS.resultsByHour)
    .map(Number)
    .filter(h => ASCENT_RESULTS.resultsByHour[h].some(r => r.model === model))
    .sort((a, b) => a - b);
}

// {model: ascentPath} for the given model at the given RAW time (not a
// snapped/clamped hour any more -- 2026-08, requested directly: "can we
// interpolate the 15 minute increments between hours for the ascent using
// the before/after bracketing that we do for descents?"). Brackets the two
// real hours THIS MODEL has data for that straddle timeMinutes -- same
// bracket-finding shape blendProfilesForTime() (app.js) already
// established for wind -- and linearly interpolates between their two
// real ascentPath OUTPUTS when the time doesn't land exactly on one.
// Unlike descent (which blends the wind INPUT and cheaply re-simulates
// client-side), ascent's own physics only exists in rocketry, cross-
// origin -- there's no "re-simulate" available here, so this blends the
// two real outputs directly instead. Confirmed acceptable directly: "the
// x,y,z delta is likely to come out similarly... we'll fade or dash the
// line on the non-sim points to show they were approximated, not
// simulated" -- same "not real data, just linear math" honesty this app
// already applies to wind blending, extended to ascent's own output
// instead of its input. Always returns a real ascentPath-shaped object
// (or null if this model has no data at all), tagged `.interpolated` --
// true when blended between two hours, false when it lands exactly on one
// real hour or clamps to the nearest edge hour outside this model's own
// range (same clamp-not-revert behavior already established for time
// outside 0900-1500) -- ascentIsInterpolated is never left undefined, so
// callers can check it directly. path3dDrawAscentPath() reads this tag to
// dash/fade the curve; callers that just want a number (ascentApogeeFt()
// etc.) can ignore it entirely.
function ascentPathForModel(model, timeMinutes) {
  const hours = ascentAvailableHoursForModel(model);
  if (!hours.length) return null;

  const clamped = Math.max(hours[0] * 60, Math.min(hours[hours.length - 1] * 60, timeMinutes));
  let hourA = hours[0], hourB = hours[hours.length - 1];
  for (let i = 0; i < hours.length - 1; i++) {
    if (hours[i] * 60 <= clamped && clamped <= hours[i + 1] * 60) {
      hourA = hours[i]; hourB = hours[i + 1];
      break;
    }
  }
  const pathA = ASCENT_RESULTS.resultsByHour[hourA].find(r => r.model === model).ascentPath;
  // Exact hit on hourA (covers the single-hour case, hourA===hourB, too)
  // -- NOT just hourA===hourB alone, which only ever caught the single-
  // hour degenerate case and missed every OTHER exact-hour landing (e.g.
  // clamped === hourA*60 in the middle of a multi-hour range still finds
  // a real bracket [hourA,hourB] via the loop above, so hourA!==hourB
  // there even though no actual blending should happen) -- confirmed
  // directly via a real test: without this check, `interpolated` was
  // `true` on every exact-hour hit, weightB just happened to numerically
  // land on 0, an incorrect label even though the VALUE was already right.
  if (clamped === hourA * 60) return Object.assign({}, pathA, { interpolated: false });
  const pathB = ASCENT_RESULTS.resultsByHour[hourB].find(r => r.model === model).ascentPath;
  // Exact hit on hourB, same reasoning (also covers hourA===hourB, since
  // clamped then equals both hourA*60 and hourB*60 -- caught above first).
  if (clamped === hourB * 60) return Object.assign({}, pathB, { interpolated: false });
  const weightB = (clamped - hourA * 60) / ((hourB - hourA) * 60);
  return ascentInterpolatePath(pathA, pathB, weightB);
}

function ascentLerp(a, b, f) { return a + (b - a) * f; }
// Same circular-shortest-path idiom blendProfilesForTime() (app.js)
// already uses for wind direction -- a straight linear blend of two
// compass bearings can cross the wrong way around the circle (10deg and
// 350deg averaging to 180deg instead of 0deg), this takes the shorter arc.
function ascentLerpDirDeg(d0, d1, f) {
  const diff = (((d1 - d0 + 180) % 360) + 360) % 360 - 180;
  return (((d0 + f * diff) % 360) + 360) % 360;
}

// Interpolates the 4 named waypoints (LIFTOFF/LAUNCHROD/BURNOUT/APOGEE --
// always the same fixed set regardless of wind, matched by `type`) between
// two real ascentPaths. Only the fields any splashcast consumer actually
// reads get blended (position, altitude, speed, time) -- tiltFromVerticalDeg/
// aoaDeg/wind are copied from `wpA` unchanged, since nothing here reads
// them (ascentPositionTiltDeg() computes its own geometric angle from
// position, not from tiltFromVerticalDeg -- see that function's own
// comment for why those two numbers can disagree).
function ascentInterpolateWaypoints(wpA, wpB, f) {
  return wpA.map(a => {
    const b = wpB.find(w => w.type === a.type);
    if (!b) return a; // shouldn't happen -- the 4 types are always the same set
    return Object.assign({}, a, {
      time: ascentLerp(a.time, b.time, f),
      position: {
        x: ascentLerp(a.position.x, b.position.x, f),
        y: ascentLerp(a.position.y, b.position.y, f),
        z: ascentLerp(a.position.z, b.position.z, f),
      },
      altitude: ascentLerp(a.altitude, b.altitude, f),
      speed: ascentLerp(a.speed, b.speed, f),
    });
  });
}

// One sample at a fractional INDEX position (0=first point, 1=last) along
// a path[] polyline, interpolated between its two nearest real points --
// NOT a real-time or arc-length position, just "how far along this
// array." Needed because pathA/pathB's own point counts aren't guaranteed
// equal (rocketry's integration step count isn't guaranteed wind-
// independent) -- ascentInterpolatePathPoints() below resamples both
// sides onto a shared index grid via this before blending across hours.
function ascentSampleAlongPath(path, frac) {
  const idx = frac * (path.length - 1);
  const i0 = Math.floor(idx), i1 = Math.min(path.length - 1, i0 + 1);
  const t = idx - i0;
  const p0 = path[i0], p1 = path[i1];
  return {
    time: ascentLerp(p0.time, p1.time, t),
    position: {
      x: ascentLerp(p0.position.x, p1.position.x, t),
      y: ascentLerp(p0.position.y, p1.position.y, t),
      z: ascentLerp(p0.position.z, p1.position.z, t),
    },
    altitude: ascentLerp(p0.altitude, p1.altitude, t),
  };
}
function ascentInterpolatePathPoints(pathA, pathB, f) {
  const n = Math.max(pathA.length, pathB.length);
  const out = [];
  for (let i = 0; i < n; i++) {
    const frac = n === 1 ? 0 : i / (n - 1);
    const sa = ascentSampleAlongPath(pathA, frac);
    const sb = ascentSampleAlongPath(pathB, frac);
    out.push({
      time: ascentLerp(sa.time, sb.time, f),
      position: {
        x: ascentLerp(sa.position.x, sb.position.x, f),
        y: ascentLerp(sa.position.y, sb.position.y, f),
        z: ascentLerp(sa.position.z, sb.position.z, f),
      },
      altitude: ascentLerp(sa.altitude, sb.altitude, f),
    });
  }
  return out;
}

function ascentInterpolatePath(pathA, pathB, f) {
  return {
    waypoints: ascentInterpolateWaypoints(pathA.waypoints, pathB.waypoints, f),
    path: ascentInterpolatePathPoints(pathA.path, pathB.path, f),
    segments: pathA.segments, // structural only, not numerically consumed
    windShear: {
      ground: {
        vx: ascentLerp(pathA.windShear.ground.vx, pathB.windShear.ground.vx, f),
        vy: ascentLerp(pathA.windShear.ground.vy, pathB.windShear.ground.vy, f),
        speed: ascentLerp(pathA.windShear.ground.speed, pathB.windShear.ground.speed, f),
        directionFromDeg: ascentLerpDirDeg(pathA.windShear.ground.directionFromDeg, pathB.windShear.ground.directionFromDeg, f),
      },
      aloft: pathA.windShear.aloft, // not read by any splashcast consumer, structural only
      speedDeltaMs: pathA.windShear.speedDeltaMs,
      directionDeltaDeg: pathA.windShear.directionDeltaDeg,
    },
    interpolated: true,
  };
}

// (x_ft, y_ft) = a specific model's own real sim APOGEE offset from the
// pad, converted m->ft -- substituted for railShiftFt(altFt)'s output at
// that model's own draw sites in path3dDrawScene() below, since it's the
// same "constant offset from pad to apogee" concept, just from a real
// simulation instead of a tan(angle) stand-in. altFt comes from the APOGEE
// waypoint's own `altitude` field (meters AGL, = position.z per rocketry's
// ascent-path-export.README.md) -- NOT a `summary.apogeeAltitudeFt`
// convenience field, which only ever existed in this session's earlier
// hand-built single-model test fixture, not in the real per-model results
// rocketry's library actually returns (confirmed directly against
// src/lib.ts).
function ascentApogeeFt(ascentPath) {
  const apogee = ascentPath.waypoints.find(w => w.type === 'APOGEE');
  return {
    x: apogee.position.x * ASCENT_M_TO_FT,
    y: apogee.position.y * ASCENT_M_TO_FT,
    altFt: apogee.altitude * ASCENT_M_TO_FT,
  };
}

// Mean across every CURRENTLY SELECTED model in the current sim result --
// used wherever ONE representative shift/altitude is needed rather than a
// specific model's own value: the 2D map's single ground marker (app.js),
// and the 3D scene's overall Z-axis scaling/apogee-altitude label/the
// descent-side simulation's own starting altitude (renderDescent3D() --
// descentPathsFor() still runs once for all models, same as before this
// change, not re-simulated per model). Filtered by state.selectedModels
// (2026-08, requested directly: "if only HRRR is showing, then show it...
// if they change from 6 to 4 models, recalc it") -- apogee differs
// meaningfully between models because of weathercocking (which eats real
// altitude, not just position), so a mean across models the visitor has
// deliberately hidden would misrepresent what's actually on screen. Falls
// back to every model with data when nothing is deselected
// (state.selectedModels === null, same "null means everything" convention
// state.selectedModels uses everywhere else in this app) or when the
// filtered set would otherwise be empty (e.g. the only selected model has
// no sim result at all, same as 'actual' never having one) -- an apogee
// number from a real model that isn't even showing beats no number at
// all. Takes raw timeMinutes now (2026-08, same interpolation rewrite as
// ascentPathForModel() above), not a snapped hour -- each model's own
// ascentApogeeFt() is computed from its own (possibly interpolated)
// ascentPathForModel() at the exact slider position, so this mean stays
// consistent with whatever the ascent curves themselves are showing at
// that same instant, not a separately-snapped value.
function ascentMeanApogeeFt(timeMinutes) {
  if (!ASCENT_RESULTS) return null;
  const allModels = [...new Set(
    Object.values(ASCENT_RESULTS.resultsByHour).flatMap(results => results.map(r => r.model))
  )];
  if (!allModels.length) return null;
  const selected = state.selectedModels ? allModels.filter(m => state.selectedModels.has(m)) : allModels;
  const usable = selected.length ? selected : allModels;
  const all = usable
    .map(m => ascentPathForModel(m, timeMinutes))
    .filter(Boolean)
    .map(ascentApogeeFt);
  if (!all.length) return null;
  const n = all.length;
  return {
    x: all.reduce((s, a) => s + a.x, 0) / n,
    y: all.reduce((s, a) => s + a.y, 0) / n,
    altFt: all.reduce((s, a) => s + a.altFt, 0) / n,
  };
}

// Compass bearing (0=N, 90=E, clockwise) of a real East/North offset --
// NOT a wind "from" bearing like windShear's own directionFromDeg fields,
// this is the direction the rocket actually leaned/moved TOWARD, so
// (unlike windVaneHTML()'s own +180 from->toward conversion) the arrow
// below rotates to this value directly.
function ascentBearingDeg(xEast, yNorth) {
  return (Math.atan2(xEast, yNorth) * 180 / Math.PI + 360) % 360;
}
// Same rotated-arrow-glyph mechanism/CSS class (.wind-vane, app.css)
// windVaneHTML() (app.js) already established for wind direction --
// reused here rather than a second arrow implementation, minus that
// function's own +180 shift (see ascentBearingDeg()'s own comment for
// why this bearing doesn't need it). Requested directly: "use arrows for
// heading, not numbers."
function ascentArrowHTML(bearingDeg) {
  const rounded = Math.round(bearingDeg);
  return `<span class="wind-vane" style="transform:rotate(${rounded}deg)" title="${rounded}&deg;">&uarr;</span>`;
}

// Real trig, rail (LIFTOFF) GPS position -> the given waypoint's own GPS
// position, both from the SAME model's ascentPath -- requested directly,
// NOT waypoint.tiltFromVerticalDeg, which is the sim's own vehicle
// ATTITUDE (nose angle) at that instant, a different quantity that can
// diverge hugely from the actual position angle (confirmed directly
// against a real fixture: an APOGEE waypoint reporting
// tiltFromVerticalDeg=87.8 degrees -- the vehicle tumbling/coasting
// unstably in attitude by apogee -- while its real position was only ~9
// degrees off vertical from the rail). "Degree to apogee/motor burnout"
// means the real geometric angle to that point, not the vehicle's own
// nose angle when it got there.
function ascentPositionTiltDeg(waypoint, ascentPath) {
  const rail = ascentPath.waypoints.find(w => w.type === 'LIFTOFF').position;
  const dx = waypoint.position.x - rail.x, dy = waypoint.position.y - rail.y, dz = waypoint.position.z - rail.z;
  return Math.atan2(Math.hypot(dx, dy), dz) * 180 / Math.PI;
}

// Reset once per render (path3dDrawScene(), before the per-model draw
// loop), appended to by path3dDrawAscentPath() below for EACH model drawn
// -- {sx, sy, kind, model} for the 2 clickable points per model, same shape
// convention path3dHitPoints already uses for the descent paths' own hover
// hit-testing, plus a `model` tag so a hit can be traced back to which
// model's own ascentPath to read.
let ascentHitPoints = [];

// Warnings are shared across every model (stability/parse warnings come
// from the rocket+motor config, not the wind), so this stays a single
// top-level block, prepended into whichever popup is open regardless of
// model -- rocketry deliberately sends a flyable:false/warned result
// through rather than blocking it (see the integration plan's own
// "Splashcast's half of the contract"), so this is the layer responsible
// for surfacing that rather than silently plotting an unstable
// configuration's result as if it were routine.
function ascentWarningsHTML() {
  const warnings = [...(ASCENT_RESULTS.stability?.warnings ?? []), ...(ASCENT_RESULTS.parseWarnings ?? [])];
  if (!warnings.length) return '';
  return `<div class="ascent-warning">${warnings.map(w => `&#9888; ${w}`).join('<br>')}</div>`;
}

// modelNameHTML() (app.js) in the title -- same per-model-colored name
// every descent-path tooltip already uses, so this popup visibly reads as
// "this model's own ascent," not a generic/unlabeled one now that several
// can be open (one at a time, but for different models) across a session.
function ascentBoxHTML(kind, model) {
  // state.timeMinutes read fresh here rather than threaded through
  // ascentHitPoints/the click event -- this only ever runs interactively
  // (hover/click), so "whatever's on screen right now" is always the
  // correct answer, no staleness risk the way a value captured at draw
  // time could have if the slider moved between render and click.
  const ascentPath = ascentPathForModel(model, state.timeMinutes);
  const launchrod = ascentPath.waypoints.find(w => w.type === 'LAUNCHROD');
  const burnout = ascentPath.waypoints.find(w => w.type === 'BURNOUT');
  const apogee = ascentPath.waypoints.find(w => w.type === 'APOGEE');
  if (kind === 'burnout') {
    const ft = Math.round(burnout.altitude * ASCENT_M_TO_FT).toLocaleString();
    return `${ascentWarningsHTML()}<div class="rf-title">${modelNameHTML(model)} &mdash; motor burnout</div>${ft} ft AGL`;
  }
  // kind === 'weathercock' -- requested directly: rail exit velocity,
  // ground wind speed (both converted m/s -> fps, same ASCENT_M_TO_FT
  // literal the whole path already converts positions with -- ft and fps
  // share the same per-second/per-foot conversion factor), and degree +
  // bearing number + arrow-heading to both motor burnout and apogee.
  // Degree is ascentPositionTiltDeg() -- real trig off the rail/apogee
  // GPS positions, NOT waypoint.tiltFromVerticalDeg (see that function's
  // own comment for why those two numbers disagree, sometimes hugely);
  // bearing/heading is ascentBearingDeg() of that same waypoint's own
  // real position -- the actual direction it ended up, not assumed to
  // match the ground wind's own push direction. Every line leads with its
  // number(s) (requested directly, "numbers on the far left") rather than
  // a label -- "94 fps rail exit velocity", not "Rail exit velocity: 94
  // fps".
  const railFps = (launchrod.speed * ASCENT_M_TO_FT).toFixed(0);
  const groundWindFps = (ascentPath.windShear.ground.speed * ASCENT_M_TO_FT).toFixed(0);
  // windVaneHTML() (app.js), NOT ascentArrowHTML() -- ground wind is a
  // real wind "from" bearing (windShear.ground.directionFromDeg), the same
  // shape/convention every other wind arrow in this app already reads,
  // unlike the burnout/apogee bearings below (which are real position-
  // vector "toward" bearings, ascentBearingDeg()'s own case).
  const groundWindArrow = windVaneHTML(ascentPath.windShear.ground.directionFromDeg);
  const toBurnoutDeg = ascentPositionTiltDeg(burnout, ascentPath).toFixed(1);
  const toBurnoutBearing = Math.round(ascentBearingDeg(burnout.position.x, burnout.position.y));
  const toApogeeDeg = ascentPositionTiltDeg(apogee, ascentPath).toFixed(1);
  const toApogeeBearing = Math.round(ascentBearingDeg(apogee.position.x, apogee.position.y));
  return `${ascentWarningsHTML()}<div class="rf-title">${modelNameHTML(model)} &mdash; weathercocking (rail to burnout)</div>` +
    `${railFps} fps rail exit velocity<br>` +
    `${groundWindFps} fps ${groundWindArrow} ground wind speed<br>` +
    `${toBurnoutDeg}&deg; @ ${toBurnoutBearing}&deg; ${ascentArrowHTML(toBurnoutBearing)} to motor burnout<br>` +
    `${toApogeeDeg}&deg; @ ${toApogeeBearing}&deg; ${ascentArrowHTML(toApogeeBearing)} to apogee`;
}

// Opens on hover (desktop, via path3dHandleHover() below -- same as the
// descent-path waypoints' own tooltip, requested directly to match) AND on
// click/tap (touch, which has no hover to drive it -- see path3dEndDrag's
// own click hit-test). showAscentBox() itself is a plain idempotent
// "set content + show" (safe to call repeatedly every mousemove while
// hovering, same as tooltip's own positionTooltip(evt) already does);
// toggle-closed-on-repeat-click is the CALLER's job now (path3dEndDrag),
// not baked in here, since hover calling this on every mousemove tick
// would otherwise fight a toggle baked into the function itself.
// Same underlying mechanism showRealFlightBox()/showTempRiskBox() already
// established (positionBoxAvoiding(), further down this file/app.js) --
// tried always-visible labels first, reported as colliding with the
// descent paths in a rotatable 3D scene ("interference... not easy to
// solve"); click/hover-to-reveal sidesteps needing to solve label
// placement instead.
// ascentBoxOpenKind is a composite "model|kind" key now (not just kind) --
// several models can each have their own open-able weathercock/burnout
// point on screen at once, so the toggle-closed-on-repeat-click/hover
// check needs to know WHICH model's point is currently open, not just
// which kind.
let ascentBoxOpenKind = null;
const ascentBox = document.getElementById('ascent-box');
function showAscentBox(evt, kind, model) {
  ascentBox.innerHTML = ascentBoxHTML(kind, model);
  const [x, y] = positionBoxAvoiding(evt, []);
  ascentBox.style.left = x + 'px';
  ascentBox.style.top = y + 'px';
  ascentBox.style.display = 'block';
  ascentBoxOpenKind = `${model}|${kind}`;
}
function hideAscentBox() {
  ascentBox.style.display = 'none';
  ascentBoxOpenKind = null;
}
document.addEventListener('click', () => {
  if (ascentBoxOpenKind !== null) hideAscentBox();
});

// Draws one model's real multi-point ascent curve (ascentPath.path[],
// liftoff->apogee), colored to match that SAME model's own descent line
// (MODEL_COLORS_HEX, app.js) -- this is what visually "ties" an ascent
// curve to its descent path: one continuous color from liftoff through
// apogee down to landing, and (since this is only ever called for models
// present in `paths`, which is already filtered by state.selectedModels --
// see path3dDrawScene()'s own call site) toggling a model off hides both
// halves together for free, no separate visibility flag to keep in sync.
// Draws with plain `toScreen` (NOT toScreenPath), since these positions are
// already the real absolute pad-relative trajectory, not a drift-since-
// apogee value needing a shift added on top the way each model's own
// descent path does. Solid, not dashed -- unlike the rail-angle stand-in,
// this really is a simulated trajectory, same visual language
// path3dDrawPath() already uses for the (real, wind-integrated) descent
// paths below apogee.
function path3dDrawAscentPath(toScreen, model, ascentPath) {
  const ctx = path3dCtx;
  const color = MODEL_COLORS_HEX[model] || '#06b6d4'; // same fallback cyan RAIL_BOOST_LINE_COLOR used for the single-line stand-in
  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineWidth = 2;
  // Dashed + faded when this curve was INTERPOLATED between two real
  // simulated hours (ascentPath.interpolated, see ascentPathForModel()'s
  // own comment) rather than landing exactly on one -- requested directly:
  // "fade or dash the line on the non-sim points to show they were
  // approximated, not simulated." Same dash pattern/intent
  // path3dDrawBoostLine() already uses for the dial's own tan(angle)
  // stand-in (a different kind of "not a real sim," same visual language:
  // dashed means "derived, not directly computed here").
  if (ascentPath.interpolated) {
    ctx.setLineDash([5, 4]);
    ctx.globalAlpha = 0.6;
  }
  ctx.beginPath();
  ascentPath.path.forEach((pt, i) => {
    const [sx, sy] = toScreen(pt.position.x * ASCENT_M_TO_FT, pt.position.y * ASCENT_M_TO_FT, pt.altitude * ASCENT_M_TO_FT);
    if (i === 0) ctx.moveTo(sx, sy); else ctx.lineTo(sx, sy);
  });
  ctx.stroke();
  ctx.restore();

  // Only 2 of the 4 named waypoints get a clickable point now: APOGEE is
  // dropped entirely (already marked/labeled by the existing, separate
  // path3dDrawApogeeLabel()/path3dDrawPath() apogee circles a few pixels
  // away), and LAUNCHROD ("Rod exit") is dropped in favor of LIFTOFF
  // ("base") as the one ground-level reference point -- same reasoning as
  // when these were still always-visible labels, still applies to where
  // the points themselves sit.
  const base = ascentPath.waypoints.find(w => w.type === 'LIFTOFF');
  const burnout = ascentPath.waypoints.find(w => w.type === 'BURNOUT');
  const [bx, by] = toScreen(base.position.x * ASCENT_M_TO_FT, base.position.y * ASCENT_M_TO_FT, base.altitude * ASCENT_M_TO_FT);
  const [ux, uy] = toScreen(burnout.position.x * ASCENT_M_TO_FT, burnout.position.y * ASCENT_M_TO_FT, burnout.altitude * ASCENT_M_TO_FT);

  ctx.save();
  ctx.fillStyle = color;
  ctx.fillRect(bx - 3, by - 3, 6, 6);
  ctx.fillRect(ux - 3, uy - 3, 6, 6);
  ctx.restore();

  // Appended, not reassigned -- path3dDrawScene() resets this to [] once,
  // before calling this function once per visible model.
  ascentHitPoints.push(
    { sx: bx, sy: by, kind: 'weathercock', model },
    { sx: ux, sy: uy, kind: 'burnout', model },
  );
}

// Small filled dot + same-colored ring at z=0, positioned at this model's
// own real apogee X/Y offset -- see path3dDrawScene()'s own call-site
// comment for why (2D's ground-plane equivalent, requested directly).
// `toScreen`, not `toScreenPath` -- `shift` (ascentApogeeFt()'s output) is
// already the real absolute pad-relative offset, same reasoning
// path3dDrawAscentPath() above already documents for its own points.
function path3dDrawGroundApogeeMarker(toScreen, model, shift) {
  const ctx = path3dCtx;
  const color = MODEL_COLORS_HEX[model] || '#888';
  const [sx, sy] = toScreen(shift.x, shift.y, 0);
  ctx.save();
  ctx.beginPath();
  ctx.arc(sx, sy, 4, 0, Math.PI * 2);
  ctx.fillStyle = color;
  ctx.fill();
  ctx.lineWidth = 1.5;
  ctx.strokeStyle = path3dCssVar('--point-stroke');
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(sx, sy, 8, 0, Math.PI * 2);
  ctx.lineWidth = 1.5;
  ctx.strokeStyle = color;
  ctx.stroke();
  ctx.restore();
}

let path3dYaw = 0;
let path3dPitch = 22 * Math.PI / 180;
let path3dZoom = 1;
// Default ON -- unlike most of this app's toggles (default-minimal, opt
// in), this is a brand-new visualization being evaluated for the first
// time; showing it immediately makes that evaluation possible without an
// extra click, and it's one click to turn back off if it's too busy.
let path3dShowGround = true;

const path3dCanvas = document.getElementById('descent3d-canvas');
const path3dCtx = path3dCanvas.getContext('2d');
const path3dMain = document.getElementById('descent3d-main');
const path3dEmptyHint = document.getElementById('descent3d-empty-hint');
const path3dViewToggle = document.getElementById('descent3d-view-toggle');
const path3dGroundToggle = document.getElementById('descent3d-ground-toggle');
const path3dCanvasWrap = document.querySelector('.descent3d-canvas-wrap');

function path3dCssVar(name) {
  return getComputedStyle(document.querySelector('.viz-root')).getPropertyValue(name).trim();
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
// events don't otherwise expose "how many fingers are down right now").
// Two-finger touch ALSO pinch-zooms now (2026-08, reported directly:
// "does not zoom with pinch/pull, ends up translating on 2 fingers") --
// same combined pan+pinch-zoom gesture #map-wrap's own 2D pan/zoom
// (app.js) already uses: the pair's midpoint drives pan, the change in
// distance between the two fingers drives zoom, both computed from the
// same two tracked points every move, not two separate gestures to
// disambiguate.
let path3dDragging = false, path3dLastX = 0, path3dLastY = 0, path3dDragDistPx = 0;
let path3dPanMode = false;
let path3dPanPxX = 0, path3dPanPxY = 0;
const path3dActiveTouches = new Map(); // pointerId -> {x, y}, touch pointers only
let path3dPinchDist = null; // distance between the two touches as of the last move -- null unless a real 2-finger touch is in progress

function path3dTouchMidpoint() {
  const pts = [...path3dActiveTouches.values()];
  if (pts.length < 2) return null;
  return [(pts[0].x + pts[1].x) / 2, (pts[0].y + pts[1].y) / 2];
}
function path3dTouchDist() {
  const pts = [...path3dActiveTouches.values()];
  if (pts.length < 2) return null;
  return Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
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
  path3dPinchDist = twoFingerPan ? path3dTouchDist() : null;
});
path3dCanvas.addEventListener('pointermove', evt => {
  if (evt.pointerType === 'touch' && path3dActiveTouches.has(evt.pointerId)) {
    path3dActiveTouches.set(evt.pointerId, { x: evt.clientX, y: evt.clientY });
  }
  if (!path3dDragging) {
    path3dHandleHover(evt);
    return;
  }
  const twoFingerPan = path3dPanMode && path3dActiveTouches.size >= 2;
  // Tracks the touch pair's own midpoint while panning with two fingers,
  // not each finger's individual movement separately -- averaging two
  // independently-updating pointers through one shared lastX/lastY would
  // otherwise mix their deltas together into an erratic combined motion.
  const mid = twoFingerPan ? path3dTouchMidpoint() : [evt.clientX, evt.clientY];
  const dx = mid[0] - path3dLastX, dy = mid[1] - path3dLastY;
  path3dLastX = mid[0]; path3dLastY = mid[1];
  path3dDragDistPx += Math.abs(dx) + Math.abs(dy);
  // A real orbit/pan no longer matches any single preset button -- deselect
  // once the drag has moved enough to be real, not a stray sub-pixel jitter
  // on what was meant as a click.
  if (path3dDragDistPx > 4) path3dClearViewPreset();
  if (path3dPanMode) {
    path3dPanPxX += dx; path3dPanPxY += dy;
    if (twoFingerPan) {
      // Fingers spreading apart -> dist grows -> zoom in -- same direction
      // the mouse wheel handler below already uses (scrolling "up"/away
      // zooms in). Ratio against the LAST move's distance, not the
      // pointerdown-time distance, so the zoom rate stays proportional to
      // how fast the pinch is actually moving right now, same idea
      // path3dSetAlt()'s per-move updates use elsewhere in this file.
      const dist = path3dTouchDist();
      if (path3dPinchDist != null && dist != null) {
        path3dZoom = Math.max(0.4, Math.min(20, path3dZoom * (dist / path3dPinchDist)));
      }
      path3dPinchDist = dist;
    }
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
// Wider than PROXIMITY_PX (22, tuned for a mouse cursor's single pixel) --
// requested directly ("make sure the paths... are mobile friendly and can
// be clicked"): a tap's actual contact area is much coarser than a mouse,
// and touch has no hover fallback to recover a near-miss the way desktop
// does, so a tap needs a genuinely bigger target to land reliably. Used by
// BOTH hit-tests below (ascent points and descent-path points), not just
// one -- same reasoning applies equally to either.
const PATH3D_TAP_PROXIMITY_PX = 36;

// Tap-toggle state for a descent-path point's tooltip -- a composite key
// (model + rounded screen position), not a reference into path3dHitPoints
// itself, since that array is rebuilt fresh on every render() and a stored
// object reference would never compare equal again even for "the same"
// point conceptually. null when no tap-opened tooltip is currently up.
let path3dTapTooltipKey = null;

function path3dEndDrag(evt) {
  if (evt && evt.pointerType === 'touch') path3dActiveTouches.delete(evt.pointerId);
  // A genuine click/tap (didn't move enough to count as an orbit/pan drag
  // -- same >4px threshold path3dClearViewPreset()'s own call site above
  // already uses to draw that line) hit-tests against ascentHitPoints
  // FIRST, then path3dHitPoints (the descent-path lines) -- this is the
  // ONLY way to open either on touch (no hover there), and on desktop it's
  // a secondary path alongside path3dHandleHover()'s own hover-open below,
  // so a second click on an already-open point closes it explicitly rather
  // than leaving hover to silently reopen it next mousemove. Checked only
  // on 'pointerup' (not 'pointercancel', which path3dEndDrag also handles
  // but doesn't represent a completed click).
  if (evt && evt.type === 'pointerup' && path3dDragDistPx <= 4) {
    const rect = path3dCanvas.getBoundingClientRect();
    const mx = evt.clientX - rect.left, my = evt.clientY - rect.top;

    let ascentHit = false;
    if (ASCENT_RESULTS) {
      let best = null, bestDist = Infinity;
      ascentHitPoints.forEach(h => {
        const d = Math.hypot(h.sx - mx, h.sy - my);
        if (d < bestDist) { bestDist = d; best = h; }
      });
      if (best && bestDist <= PATH3D_TAP_PROXIMITY_PX) {
        ascentHit = true;
        if (ascentBoxOpenKind === `${best.model}|${best.kind}`) hideAscentBox();
        else showAscentBox(evt, best.kind, best.model);
      }
    }

    // Only reached when the tap didn't already hit an ascent point --
    // same "ascent checked first" precedence path3dHandleHover()'s own
    // hover path already establishes, so a tap near both never shows both
    // at once. Previously this whole branch didn't exist at all -- a
    // descent-path point (real wind-drift line, every 3D render, sim
    // active or not) had NO touch affordance whatsoever, only the desktop-
    // only hover path below could ever show it.
    if (!ascentHit) {
      const hit = path3dFindDescentHit(mx, my, PATH3D_TAP_PROXIMITY_PX);
      if (hit) {
        const key = `${hit.model}|${Math.round(hit.sx)}|${Math.round(hit.sy)}`;
        if (path3dTapTooltipKey === key) { hideTooltip(); path3dTapTooltipKey = null; }
        else { path3dShowDescentTooltip(evt, hit); path3dTapTooltipKey = key; }
      } else {
        hideTooltip();
        path3dTapTooltipKey = null;
        hideAscentBox();
      }
    }
  }
  path3dDragging = false;
  path3dPanMode = false;
  path3dPinchDist = null;
  path3dCanvas.classList.remove('dragging');
}
path3dCanvas.addEventListener('pointerup', path3dEndDrag);
path3dCanvas.addEventListener('pointercancel', path3dEndDrag);
// Prevents the browser's own synthetic 'click' (fired after pointerup on
// the same element, even after a drag) from bubbling up to the document-
// level click-away listener showAscentBox()/hideAscentBox() install below
// -- that listener would otherwise immediately re-close the box this same
// gesture just opened. The real click handling (hit-testing
// ascentHitPoints) lives in path3dEndDrag above via 'pointerup', not here
// -- this listener exists purely to stop propagation, same idiom the
// real-flight marker's own click handler (app.js) already uses for the
// same reason.
path3dCanvas.addEventListener('click', evt => evt.stopPropagation());
path3dCanvas.addEventListener('mouseleave', () => {
  hideTooltip();
  path3dTapTooltipKey = null;
  // Closes a hover-opened ascent-box when the pointer leaves the canvas
  // entirely -- without this it'd stay stuck open (no more mousemove
  // events to trigger path3dHandleHover()'s own close check) until the
  // next unrelated document click.
  if (ascentBoxOpenKind !== null) hideAscentBox();
});
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

// Nearest path3dHitPoints entry within maxDist, or null -- shared by the
// desktop hover path (path3dHandleHover, PROXIMITY_PX) and the touch/click
// path (path3dEndDrag, the wider PATH3D_TAP_PROXIMITY_PX), so there's one
// hit-test to keep correct instead of two copies drifting apart.
function path3dFindDescentHit(mx, my, maxDist) {
  let best = null, bestDist = Infinity;
  for (const h of path3dHitPoints) {
    const d = Math.hypot(h.sx - mx, h.sy - my);
    if (d < bestDist) { bestDist = d; best = h; }
  }
  return (best && bestDist <= maxDist) ? best : null;
}

// Renders the shared #tooltip for a descent-path hit -- extracted so both
// the hover path below and path3dEndDrag's own tap-to-toggle path (touch
// has no hover) show identical content from one place.
function path3dShowDescentTooltip(evt, hit) {
  // 'actual' (3D History's T+1 flight) has no entry in DATA.wind_profiles --
  // that's only ever forecast models, keyed off the currently-selected
  // capture. Its own profile lives separately (HISTORY.actual_wind_profile,
  // independent of which capture is pinned -- see historyActualPathForAltitude()'s
  // own comment) and needs actualProfileForTime() (app.js), not
  // profilesForTime(), to blend it the same way -- without this branch the
  // wind row below silently never appeared for actual's own points.
  const timeProfiles = profilesForTime(state.timeMinutes);
  const profile = hit.model === 'actual'
    ? actualProfileForTime(state.timeMinutes)
    : timeProfiles && timeProfiles[hit.model];
  // modelNameHTML() (app.js) -- same per-model-colored name every other
  // tooltip on the page uses now, not a plain bolded --accent-blue name.
  const rows = [`<div class="tt-row">${modelNameHTML(hit.model)}</div>`,
    `<div class="tt-row">${Math.round(hit.alt_ft).toLocaleString()} ft AGL</div>`];
  if (profile) {
    const [spdMph, drc] = interpWind(profile, hit.alt_ft);
    // windVaneHTML() (app.js) -- same rotated-arrow-into-the-wind glyph the
    // 2D weather panel's own wind tooltip uses, not a raw degree number.
    rows.push(`<div class="tt-row">${Math.round(spdMph)} mph ${windVaneHTML(drc)}</div>`);
  }
  rows.push(`<div class="tt-row" style="color:var(--text-muted);">${Math.round(hit.x_ft)} ft E, ${Math.round(hit.y_ft)} ft N of pad</div>`);
  tooltip.innerHTML = rows.join('');
  tooltip.style.display = 'block';
  positionTooltip(evt);
}

function path3dHandleHover(evt) {
  const rect = path3dCanvas.getBoundingClientRect();
  const mx = evt.clientX - rect.left, my = evt.clientY - rect.top;

  // Opens ascent-box on hover, requested directly ("like the descent path
  // waypoints" -- their own tooltip below already opens this same way, on
  // plain pointermove with no click needed). Checked first, and returns on
  // a hit, so an ascent-path point near a descent-path point doesn't show
  // both the box AND the tooltip at once. Touch never reaches this
  // function at all (pointermove after pointerdown is always
  // path3dDragging=true there, see that listener's own comment), so this
  // is desktop-only by construction, same as the tooltip hover it's
  // modeled on -- touch opens either via path3dEndDrag's own tap hit-test.
  if (ASCENT_RESULTS) {
    let tBest = null, tBestDist = Infinity;
    ascentHitPoints.forEach(h => {
      const d = Math.hypot(h.sx - mx, h.sy - my);
      if (d < tBestDist) { tBestDist = d; tBest = h; }
    });
    if (tBest && tBestDist <= PROXIMITY_PX) {
      hideTooltip();
      showAscentBox(evt, tBest.kind, tBest.model);
      return;
    }
    if (ascentBoxOpenKind !== null) hideAscentBox();
  }

  // PROXIMITY_PX -- the same "how close counts as a hover hit" constant
  // the 2D map's own point tooltips use (app.js), not a separate figure
  // invented for this view.
  const hit = path3dFindDescentHit(mx, my, PROXIMITY_PX);
  if (!hit) { hideTooltip(); return; }
  path3dShowDescentTooltip(evt, hit);
}

if (window.ResizeObserver) {
  new ResizeObserver(() => { if (mapViewMode === '3d') renderDescent3D(); }).observe(path3dCanvasWrap);
} else {
  window.addEventListener('resize', () => { if (mapViewMode === '3d') renderDescent3D(); });
}

// --- ground-plane imagery (satellite/road texture on the z=0 plane) -------
// Reuses the exact same image files and geo-registration data the 2D map
// already publishes (SITE_GEOMETRY.site_px/ft_to_px_scale/wide_view_box/
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
// into that same space via SITE_GEOMETRY.wide_view_box, not its own
// separate space). Real feet convert to/from that space via
// SITE_GEOMETRY.site_px/ft_to_px_scale (ft_to_px_scale's own comment in
// splash_zones.py: "exposing scale.x/scale.y explicitly... is what lets
// the boost-angle buffer move client-side" -- same published fields,
// reused here for a different client-side geometry need).
function path3dDetailPxToFt(px, py) {
  return [(px - SITE_GEOMETRY.site_px[0]) / SITE_GEOMETRY.ft_to_px_scale.x, (SITE_GEOMETRY.site_px[1] - py) / SITE_GEOMETRY.ft_to_px_scale.y];
}
// Corners in real feet (relative to the pad), for the image's own 3
// defining corners: top-left, top-right, bottom-left (a 4th corner is
// redundant -- 3 points fully determine an affine map).
//
// Both layers go through the SAME fractional remap -- a delivered "_web"
// JPEG's own real pixel dimensions (img.naturalWidth/Height) do NOT
// necessarily match the resolution site_px/ft_to_px_scale were computed
// against server-side (confirmed directly: hutto's detail_sat_web.jpg is
// 1600x1600 but SITE_GEOMETRY.image_view_box says 3384x3384; hearne's is
// 1599x1600 against a published 2035x2036 -- the "_web" files are resized
// down for file size, independently of the geo-registration math). An
// earlier version treated the detail image's own native pixel space as
// if it WERE already detail-pixel-space with no remap at all, which
// squashed it toward its own top-left corner by whatever the resize
// factor happened to be -- correct at exactly pixel (0,0), increasingly
// wrong moving away from it, which is why it looked closer to right for
// hutto (small site_px offset from that corner) and badly wrong for
// hearne (confirmed via a user screenshot: pad crosshair and 3D origin
// landed nowhere near each other on the same imagery). SITE_GEOMETRY.image_view_box
// (always [0,0,true_w,true_h]) is the detail image's own equivalent of
// wide_view_box -- using it here the same way removes the asymmetry.
function path3dGroundCornersFt(kind, img) {
  const w = img.naturalWidth, h = img.naturalHeight;
  const [vx, vy, vw, vh] = kind === 'detail' ? SITE_GEOMETRY.image_view_box : SITE_GEOMETRY.wide_view_box;
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

  // resolveMapAltFt()/mapAltUpdateSliderUI()/mapAltLastResolvedFt (app.js) --
  // shared with the 2D map's own compact altitude control since 2026-08,
  // see that file's own comment. Safe to call here even when
  // updateMapAltControl() already ran earlier in the same synchronous pass
  // (e.g. via applyIsolation(), which calls both) -- resolveMapAltFt()'s
  // own signature check is idempotent across two calls with unchanged state
  // in between, only the FIRST call in a pass can actually flip anything.
  // Splice at the real ascent sim's own apogee altitude, not whatever the
  // ladder/slider has selected, once a sim result is active -- see
  // ascentMeanApogeeFt()'s own comment for why this is a mean across
  // models rather than any one model's own value (this altitude feeds the
  // shared descent-path simulation below, which still runs once for every
  // model, not re-simulated per model).
  // state.timeMinutes directly, not a snapped hour any more (2026-08,
  // interpolated between the two bracketing real hours -- see
  // ascentPathForModel()'s own comment) -- this is what makes the descent
  // path/apogee actually follow the slider now, instead of staying frozen
  // at whichever hour the panel was originally opened with (reported
  // directly: "when the time is switched, apogee doesn't change").
  const ascentMean = ASCENT_RESULTS ? ascentMeanApogeeFt(state.timeMinutes) : null;
  const altFt = ascentMean ? ascentMean.altFt : resolveMapAltFt();
  mapAltLastResolvedFt = altFt;
  mapAltUpdateSliderUI(altFt);

  if (state.mode !== 'byAltitude' && state.mode !== 'byHistory') {
    path3dShowEmpty('Switch to "By altitude" or "History" view to see a descent path here.');
    return;
  }

  let paths;
  if (state.mode === 'byHistory') {
    // First time landing on 3D+History with nothing hovered/pinned yet --
    // default to the most recent forecast (T-0, or whatever's closest),
    // requested directly rather than showing an empty "pick a date" dead
    // end. A REAL pin (state.pinnedCapture), not a 3D-only concept, so 2D's
    // own hull/trend-line and the Age legend's own highlighted row land on
    // the same date -- both views agree on "what am I looking at" by
    // default, and the existing legend (hover or click) still changes it
    // for both, same mechanism as always ("user should still be able to
    // select through the other forecast days").
    if (state.isolatedCapture === null && state.pinnedCapture === null && HISTORY?.captures?.length) {
      state.pinnedCapture = HISTORY.captures[HISTORY.captures.length - 1];
      // Re-render from the top (not just this canvas) so the 2D hull/Age
      // legend catch up to the pin THIS render, not one render behind --
      // render() calls renderDescent3D() again at its own end, and by then
      // pinnedCapture is already set, so this branch doesn't re-trigger.
      render();
      return;
    }
    const activeCapture = state.isolatedCapture ?? state.pinnedCapture;
    const pathsRaw = historyPathsForCapture(activeCapture, state.timeMinutes, state.deploy, altFt);
    paths = pathsRaw.filter(p => state.selectedModels === null || state.selectedModels.has(p.model));
    // Independent of activeCapture/selectedModels -- see
    // historyActualPathForAltitude()'s own comment for why.
    const actualPath = historyActualPathForAltitude(state.timeMinutes, state.deploy, altFt);
    if (actualPath) paths.push({ model: 'actual', path: actualPath });
  } else {
    const pathsRaw = descentPathsFor(state.timeMinutes, state.deploy, altFt);
    paths = pathsRaw.filter(p => state.selectedModels === null || state.selectedModels.has(p.model));
  }

  if (!paths.length) {
    path3dShowEmpty('No wind profile available for this hour/deploy/altitude -- try a different combination, or select at least one model.');
    return;
  }

  path3dShowCanvas();
  path3dDrawScene(paths, altFt, ascentMean);
}

// ascentMean passed in explicitly (not re-read as a free variable) --
// it's computed in renderDescent3D() above, a SEPARATE top-level function,
// not an enclosing closure of this one; referencing it here as if it were
// still in scope threw "ascentMean is not defined" on every single 3D
// render regardless of whether a sim result was even active (confirmed via
// a real browser test -- the error fired on plain page load with no sim
// data at all), which is why the 3D view stopped rendering anything the
// moment this per-model rewrite shipped.
function path3dDrawScene(paths, altFt, ascentMean) {
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
  // railShiftFt(altFt) (app.js) is the same rail-heading/angle shift the
  // 2D map applies via ftToPxShifted() -- computed ONCE here, from the
  // path's own apogee altitude, not per-point along the descent. The
  // boost-phase deviation this represents finishes accumulating at
  // burnout/apogee; everything from apogee down to the ground is a rigid
  // wind-drift descent starting from that already-offset point, not a
  // second thing that keeps growing as altitude changes during descent --
  // descent is apogee-based, not rail-based (reported directly: landing
  // points weren't shifting in 3D, because the old per-point-altitude
  // version decayed the shift back toward 0 as each point's OWN altitude
  // fell toward the ground, which is backwards). Matches how the 2D map
  // already did this -- drawZone() passes zone.altitude (the zone's own
  // apogee), not each landing point's own altitude (always ~0 anyway,
  // landing points are ground-level by definition), to ftToPxShifted().
  // Applied explicitly at the path/apogee-marker draw sites below via
  // toScreenPath(), NOT baked into the shared toScreen() -- the ground
  // plane, axes, and origin marker are the FIXED map/coordinate grid the
  // path is plotted against, not the path itself, and must stay put
  // regardless of rail angle (only padOffsetFt, a real "what if the pad
  // were somewhere else" scene translation, legitimately moves those too).
  // Once a sim result is active, EACH model's own real apogee offset
  // stands in for the tan(angle) approximation for THAT model's own
  // descent path -- shiftForModel() below resolves that per model
  // (falling back to the mean, e.g. for 'actual', which never has its own
  // sim result). railShift itself stays the single representative/default
  // value (the mean) used for scene bounds, the apogee-altitude label, and
  // the boost-line fallback when no sim result is active at all -- see
  // ascentMeanApogeeFt()'s own comment for why a mean rather than picking
  // one model arbitrarily.
  const railShift = ascentMean || railShiftFt(altFt);
  function shiftForModel(model) {
    if (!ASCENT_RESULTS) return railShift; // dial-based, shared, unchanged from before this feature existed
    const ascentPath = ascentPathForModel(model, state.timeMinutes);
    return ascentPath ? ascentApogeeFt(ascentPath) : railShift; // per-model when rocketry returned one, else the mean (e.g. 'actual')
  }
  let maxXY = 1;
  const maxZ = Math.max(1, altFt);
  paths.forEach(p => {
    const shift = shiftForModel(p.model);
    p.path.forEach(pt => {
      maxXY = Math.max(maxXY, Math.abs(pt.x_ft + padOffsetFt.x + shift.x), Math.abs(pt.y_ft + padOffsetFt.y + shift.y));
    });
  });
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
    const r = path3dRotate((xFt + padOffsetFt.x) / scaleFt, (yFt + padOffsetFt.y) / scaleFt, zFt / scaleFt);
    return [cx + r.sx * radius, cy - r.sy * radius, r.depth];
  }
  // Same as toScreen(), plus a constant rail-angle/ascent shift -- used
  // only for the actual flight path/apogee marker (path3dDrawPath below),
  // never for the ground plane/axes/origin, which stay anchored to the
  // real, unshifted coordinate grid. A factory, not one fixed closure, now
  // that each model can have its own shift (shiftForModel() above) --
  // toScreenPath itself is kept as the default/mean-shifted version, used
  // wherever ONE representative version is still wanted (the depth-sort
  // below, the boost-line fallback, the apogee label); the per-model
  // descent-path draw loop further down asks for its own per-model version
  // explicitly instead.
  function toScreenPathFor(shift) {
    return (xFt, yFt, zFt) => toScreen(xFt + shift.x, yFt + shift.y, zFt);
  }
  const toScreenPath = toScreenPathFor(railShift);

  // Ground plane first, before axes/paths, so it reads as a floor
  // underneath them -- wide layer behind (broad coverage), detail layer
  // in front (sharper close-up near the pad), same compositing order the
  // 2D map itself uses.
  if (path3dShowGround) {
    path3dDrawGroundLayer('wide', toScreen);
    path3dDrawGroundLayer('detail', toScreen);
  }

  path3dDrawAxes(toScreen, maxX, maxY, maxZ, rect.width, rect.height);

  // Boost-phase line: pad (real, unshifted origin) to apogee (the rail-
  // shifted point every model's own descent path actually starts from) --
  // makes the thing railAngleDeg/railHeadingDeg control visible as an
  // actual flight segment, not just an offset the descent paths happen to
  // start from. One line, not per-model -- boost phase finishes before any
  // wind-profile data comes into play, so every model shares the exact
  // same apogee point regardless of rail angle; there's nothing per-model
  // to show here the way there is for the wind-driven descent below.
  // Dashed, not solid -- unlike the descent paths (a real wind-vector
  // integration), this is a straight-line stand-in for a boost trajectory
  // this app was never asked to simulate (a real rail-tip has some curve
  // to it under thrust); the dash pattern is a deliberate "approximate/
  // stand-in" signal, matching this app's usual care about not presenting
  // a derived/simplified value as if it were a measurement or a sim.
  // Real multi-point ascent curve per model instead of the single straight
  // dashed stand-in, once a sim result is active -- one call per entry in
  // `paths` (already filtered by state.selectedModels, see
  // renderDescent3D()'s own comment), so a model with no matching sim
  // result (e.g. 'actual') or one the visitor has deselected simply never
  // gets a curve drawn, no separate visibility check needed here.
  ascentHitPoints = [];
  if (ASCENT_RESULTS) {
    paths.forEach(p => {
      const ascentPath = ascentPathForModel(p.model, state.timeMinutes);
      if (ascentPath) {
        path3dDrawAscentPath(toScreen, p.model, ascentPath);
        // Ground-projected reference marker (z=0) at THIS model's own real
        // apogee X/Y offset -- requested directly ("those are ground
        // markers, even on 3d"), same per-model apogee-marker treatment
        // app.js's drawPredictedApogeeMarker() now draws on the 2D map,
        // just projected onto this view's own ground plane instead. Colored
        // to match that model's line only (no shape distinction needed the
        // way 2D's flat top-down view needs one -- "they can just follow
        // the color of the line elsewhere," per direction), distinct from
        // the true-altitude hollow apogee circle path3dDrawPath() already
        // draws at the top of this same model's own curve.
        path3dDrawGroundApogeeMarker(toScreen, p.model, ascentApogeeFt(ascentPath));
      }
    });
  } else {
    path3dDrawBoostLine(toScreen, toScreenPath, altFt);
  }

  // Depth-sort so nearer lines draw over farther ones -- purely visual
  // (disentangles overlapping model lines when orbited), touches no data.
  // toScreenPath(), not toScreen() -- sorting by the ACTUAL (shifted)
  // rendered depth, not the unshifted one, so the sort matches what's
  // actually drawn a few lines down. Uses the default/mean-shifted
  // toScreenPath for ordering purposes even though each model draws with
  // its own per-model shift below -- the shifts are close enough
  // (apogee position barely varies model to model, see
  // ascentMeanApogeeFt()'s own comment) that draw order never visibly
  // flips from this simplification.
  const ordered = paths
    .map(p => ({ p, depth: p.path.reduce((s, pt) => s + toScreenPath(pt.x_ft, pt.y_ft, pt.alt_ft)[2], 0) / p.path.length }))
    .sort((a, b) => a.depth - b.depth)
    .map(o => o.p);

  ordered.forEach(p => {
    const shift = shiftForModel(p.model);
    path3dDrawPath(p, toScreenPathFor(shift), altFt, shift);
  });

  // Drawn LAST -- on top of the ground plane, axes, and every model's own
  // path/apogee marker, so it's never occluded by any of them regardless
  // of orbit angle.
  path3dDrawApogeeLabel(toScreenPath, altFt);
}

// Apogee altitude label -- reported directly: with the satellite ground
// plane on, the existing axis-tick text (--text-muted/--text-secondary,
// fine over this app's own surface color) washed out against real map
// imagery. Solid white background, independent of light/dark theme, since
// the point is contrast against a photo, not matching the app's own
// palette. One label, not per-model -- positioned at the mean apogee
// point/altitude across all models (railShift/altFt, see
// ascentMeanApogeeFt()'s own comment), since real per-model apogees sit
// close enough together that per-model labels would just stack
// unreadably on top of each other for little real information gained.
function path3dDrawApogeeLabel(toScreenPath, altFt) {
  const ctx = path3dCtx;
  const [ax, ay] = toScreenPath(0, 0, altFt);
  // Nearest 10ft, not nearest 1ft -- requested directly ("~5,280', round
  // it to the nearest 10... these are estimators and shouldn't pretend to
  // be to-the-foot accurate"), particularly once a sim is active: this is
  // a MEAN across whichever models are currently selected
  // (ascentMeanApogeeFt()), and real per-model apogees already diverge
  // from each other (weathercocking eats real altitude, not just
  // position) -- displaying it to the exact foot would overstate the
  // precision of an average that's already smoothing over that spread.
  // Position (toScreenPath above) stays exact -- only the printed number
  // rounds, so the label still lands visually on the real marker point.
  const text = `Apogee ${(Math.round(altFt / 10) * 10).toLocaleString()} ft`;

  ctx.save();
  ctx.font = `600 12px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const padX = 7, padY = 4;
  const boxW = ctx.measureText(text).width + padX * 2;
  const boxH = 12 + padY * 2;
  // Centered above the marker point, clear of the small hollow apogee
  // circles path3dDrawPath() draws right at that same point for every model.
  const boxCx = ax, boxCy = ay - boxH / 2 - 12;
  const x = boxCx - boxW / 2, y = boxCy - boxH / 2;

  ctx.fillStyle = '#ffffff';
  ctx.strokeStyle = 'rgba(0, 0, 0, 0.25)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.roundRect(x, y, boxW, boxH, 4);
  ctx.fill();
  ctx.stroke();

  ctx.fillStyle = '#1a1a19';
  ctx.fillText(text, boxCx, boxCy + 1);
  ctx.restore();
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

// See path3dDrawScene()'s own call-site comment for why this is one
// dashed line (not per-model, not solid) rather than folded into
// path3dDrawPath(). toScreen(0,0,0) for the pad end (the real, unshifted
// origin -- NOT toScreenPath, which would wrongly apply the full apogee-
// level shift there too, since it adds a CONSTANT offset regardless of
// the zFt it's called with); toScreenPath(0,0,altFt) for the apogee end,
// same shifted point path3dDrawPath()'s own apogee marker lands on for
// every model.
//
// Color: NOT var(--accent) (a first pass used it) -- reported directly
// that it visually overlapped a real model's own color, and checking
// confirmed why: --accent is #2a78d6 in light mode, byte-identical to
// MODEL_COLORS_HEX.gfs (app.js) -- the boost line was rendering in
// literally the same blue as the GFS descent line right next to it.
// #06b6d4 (cyan) matches PREDICTED_LANDING_COLOR (app.js's own "this is a
// derived reference point, not a model result" color, used for the 2D
// map's predicted-landing star) -- reused here for the same reason, and
// confirmed to sit clearly outside every hue MODEL_COLORS_HEX/the pad-
// marker/projection-marker already use (blue, purple, red, orange, two
// greens, amber).
const RAIL_BOOST_LINE_COLOR = '#06b6d4';
function path3dDrawBoostLine(toScreen, toScreenPath, altFt) {
  const ctx = path3dCtx;
  const [px, py] = toScreen(0, 0, 0);
  const [ax, ay] = toScreenPath(0, 0, altFt);
  ctx.save();
  ctx.strokeStyle = RAIL_BOOST_LINE_COLOR;
  ctx.lineWidth = 2;
  ctx.setLineDash([5, 4]);
  ctx.beginPath();
  ctx.moveTo(px, py);
  ctx.lineTo(ax, ay);
  ctx.stroke();
  ctx.restore();
}

function path3dDrawPath(p, toScreen, altFt, railShift) {
  const ctx = path3dCtx;
  // 'actual' (3D History's T+1 flight, renderDescent3D()) isn't a real
  // model -- reuses PROJECTION_MARKER_COLOR (app.js), the same amber the
  // 2D History star already draws this exact concept in, rather than
  // falling through to the generic '#888' every other unrecognized model
  // key gets.
  const color = p.model === 'actual' ? PROJECTION_MARKER_COLOR : (MODEL_COLORS_HEX[p.model] || '#888');
  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineWidth = 1.75;
  ctx.beginPath();
  p.path.forEach((pt, i) => {
    const [sx, sy] = toScreen(pt.x_ft, pt.y_ft, pt.alt_ft);
    if (i === 0) ctx.moveTo(sx, sy); else ctx.lineTo(sx, sy);
    // pt.x_ft/y_ft is cumulative drift SINCE APOGEE (simulateDriftPath()
    // starts every path at x=0,y=0 there, see that function's own comment)
    // -- reported directly as "apogee shows 0,0 from the pad, descent path
    // reports distance from apogee, not the pad." Pad-relative feet needs
    // + railShift (the rail-angle boost deviation apogee itself sits at,
    // same shift toScreen() gets via the toScreenPath() closure this
    // function is always called through) on top of the raw drift --
    // deliberately NOT + padOffsetFt too: padOffsetFt translates the pad
    // and every path point by the same constant (see toScreen()'s own
    // comment), so it cancels out of a PAD-relative distance by
    // construction, same as it cancels out of the boost line's own start-
    // to-end geometry.
    path3dHitPoints.push({ sx, sy, model: p.model, alt_ft: pt.alt_ft, x_ft: pt.x_ft + railShift.x, y_ft: pt.y_ft + railShift.y });
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
