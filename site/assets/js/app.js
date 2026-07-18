let DATA = null;
// points_history.json for the current target date -- every capture's splash
// point per hour/deploy/rate/altitude, for the "History" view mode (see
// renderHistory()). Loaded alongside DATA; null if this target has no
// history file yet (shouldn't happen post-2026-07-17, but a target
// processed before this feature existed wouldn't have one).
let HISTORY = null;

// No single fixed hue reads well against every site: violet (the original
// ramp) washed out against Hearne's dark tree cover, and rose/magenta (the
// next attempt) fades into Hutto's light tan dirt (user's calls, both
// 2026-07-17) -- satellite terrain swings across too much of the hue wheel
// (greens, browns/tans, yellows, all season-dependent) for one hardcoded
// choice to survive every site/season combination. So the hue is now a
// user pick (see zoneColorPicker below); computeAltRamp() derives the 5
// altitude shades from it by walking lightness in OKLab (monotone, one hue,
// gamut-clamped chroma at the extremes) -- same shape the old validated
// ramp had, just built from whatever base color the user chooses instead of
// a single baked-in hex set.
function hexToRgb01(hex) {
  const n = parseInt(hex.replace('#', ''), 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}
function rgbToHex01([r, g, b]) {
  const c = v => Math.round(Math.min(1, Math.max(0, v)) * 255).toString(16).padStart(2, '0');
  return `#${c(r)}${c(g)}${c(b)}`;
}
function srgbToLinear(c) { return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); }
function linearToSrgb(c) { return c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055; }
// Björn Ottosson's OKLab -- perceptually even lightness steps, unlike HSL.
function rgbToOklab([r, g, b]) {
  const [lr, lg, lb] = [srgbToLinear(r), srgbToLinear(g), srgbToLinear(b)];
  const l = 0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb;
  const m = 0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb;
  const s = 0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb;
  const l_ = Math.cbrt(l), m_ = Math.cbrt(m), s_ = Math.cbrt(s);
  return [
    0.2104542553 * l_ + 0.7936177850 * m_ - 0.0040720468 * s_,
    1.9779984951 * l_ - 2.4285922050 * m_ + 0.4505937099 * s_,
    0.0259040371 * l_ + 0.7827717662 * m_ - 0.8086757660 * s_,
  ];
}
function oklabToRgb([L, a, b]) {
  const l_ = L + 0.3963377774 * a + 0.2158037573 * b;
  const m_ = L - 0.1055613458 * a - 0.0638541728 * b;
  const s_ = L - 0.0894841775 * a - 1.2914855480 * b;
  const l = l_ ** 3, m = m_ ** 3, s = s_ ** 3;
  const lr = 4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s;
  const lg = -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s;
  const lb = -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s;
  return [linearToSrgb(lr), linearToSrgb(lg), linearToSrgb(lb)];
}
function oklabToOklch([L, a, b]) { return [L, Math.sqrt(a * a + b * b), Math.atan2(b, a)]; }
function oklchToOklab([L, C, H]) { return [L, C * Math.cos(H), C * Math.sin(H)]; }
function inGamut(rgb) { return rgb.every(v => v >= -1e-4 && v <= 1 + 1e-4); }
// Reduce chroma until the color round-trips inside sRGB -- cheap enough to
// do live since it's only 5 colors per pick, not a bulk palette build.
function clampChroma(L, C, H) {
  let c = C;
  for (let i = 0; i < 20 && !inGamut(oklabToRgb(oklchToOklab([L, c, H]))); i++) c *= 0.9;
  return c;
}
// Lightest at the low end, darkest at the high end -- matches the shape of
// every ramp used here before this became user-adjustable. `keys` drives the
// step count directly (not a fixed 5) since altitude lists now vary in
// length per site (1,000ft up to that site's own waiver, 5-9 points --
// user's call 2026-07-17): a site with 8 altitudes needs 8 shades, not a
// lookup into a 5-entry table.
function computeSequentialRamp(baseHex, keys) {
  const [L0, C0, H0] = oklabToOklch(rgbToOklab(hexToRgb01(baseHex)));
  const n = keys.length;
  const ramp = {};
  keys.forEach((key, i) => {
    const t = n === 1 ? 0.5 : i / (n - 1);
    const L = Math.min(0.92, Math.max(0.18, L0 + (0.20 - t * 0.40)));
    ramp[key] = rgbToHex01(oklabToRgb(oklchToOklab([L, clampChroma(L, C0, H0), H0])));
  });
  return ramp;
}
const DEFAULT_ZONE_BASE_COLOR = '#c04886';
const ZONE_COLOR_STORAGE_KEY = 'splashcast_zone_base_color';
let zoneBaseColor = localStorage.getItem(ZONE_COLOR_STORAGE_KEY) || DEFAULT_ZONE_BASE_COLOR;
// Placeholder 5-key default until real data loads and ALT_COLORS_HEX gets
// recomputed against this site's actual altitude list (see initFromData()).
let ALT_COLORS_HEX = computeSequentialRamp(zoneBaseColor, [1000, 3000, 5000, 7000, 9000]);
// Orange used to be hardcoded (not independently validated the way the old
// blue altitude ramp was) -- same user-adjustable treatment as altitude now
// (user's call 2026-07-17): a fixed hue can't read well against every site's
// imagery any more here than it could for the zone fill.
const DEFAULT_TIME_BASE_COLOR = '#eb6834';
const TIME_COLOR_STORAGE_KEY = 'splashcast_time_base_color';
let timeBaseColor = localStorage.getItem(TIME_COLOR_STORAGE_KEY) || DEFAULT_TIME_BASE_COLOR;
let TIME_COLORS_HEX = computeSequentialRamp(timeBaseColor, [9, 11, 13, 15]);
const HOUR_LABELS = { 9: '9am', 11: '11am', 13: '1pm', 15: '3pm' };
const DEPLOY_LABELS = { single: 'Single', dual: 'Dual' };
const MODEL_LABELS = { gfs: 'GFS', hrrr: 'HRRR', ecmwf: 'ECMWF', icon: 'ICON', arpege: 'ARPEGE', gem: 'GEM' };
// "History" not "Drift" -- Driftcast (the tool this project extends) already
// owns that word for the wind-drift calc itself; reusing it for this view
// too would be confusing even though it'd otherwise fit (user's call
// 2026-07-17).
const MODE_LABELS = { byAltitude: 'By altitude', byTime: 'By time of day', byHistory: 'History' };
// Reference categorical palette in its validated fixed order, minus the two
// hues claimed by the zone fills (orange=time, magenta/rose=altitude as of
// 2026-07-17 -- was violet). ECMWF moved off the categorical "magenta" slot
// (#e87ba4) to the now-free "violet" slot (#4a3aa7, altitude's old color) --
// otherwise ECMWF's dot would sit close in hue to the new altitude ramp
// under it, the same legibility problem the ramp change was fixing.
// HRRR (green) and ARPEGE (aqua) are still in the same terrain-risky
// green family the altitude ramp just moved away from -- not changed here
// since only the zone-fill ramp was actually flagged, but flagged in
// conversation as a likely follow-up (small outlined point markers are far
// more forgiving than a big fill, so this is lower-priority, not ignored).
// CVD separation on the current 6-hex set (blue/violet/yellow/aqua/orange../
// green/red -- recheck after any further swap) lands in the 6-8 floor band
// for the weakest pair, legal only with secondary encoding, which this page
// already has (model name in every tooltip, text-labeled legend, white/dark
// stroke outline on every marker).
const MODEL_COLORS_HEX = {
  gfs: '#2a78d6', hrrr: '#008300', ecmwf: '#4a3aa7',
  icon: '#eda100', arpege: '#1baf7a', gem: '#e34948',
};
// Legend display order only (color assignments above are unaffected --
// this just controls what order buildModelLegend() lists them in): longest
// forecast horizon first, shortest last, so the models that keep contributing
// at longer lead times cluster together at the top and the ones that drop
// out early (see modelsWithData()) cluster at the bottom instead of being
// interleaved. Per each model's published range (GFS 16 days, ECMWF 15,
// GEM 10, ICON 7.5, ARPEGE 4, HRRR ~2) -- also matches the dropout order
// actually observed across T-1/T-3/T-5/T-7 captures (HRRR first, then
// ARPEGE, GFS/ECMWF/ICON/GEM still present at T-7).
const MODEL_LEGEND_ORDER = ['gfs', 'ecmwf', 'gem', 'icon', 'arpege', 'hrrr'];

// History view only: model identity moves from color (color is recency
// there instead) to shape. "star" is deliberately not assigned to any model
// -- reserved for the actual-landing marker (see renderHistory()) so it's
// never ambiguous with a model's projection.
const MODEL_SHAPES = { gfs: 'circle', ecmwf: 'square', gem: 'triangle-up', icon: 'diamond', arpege: 'triangle-down', hrrr: 'plus' };
// Circle = the faster rate, square = the slower one, so fast/slow reads at a
// glance without needing to hover -- covers both naming schemes (single
// deploy's 10/20fps, dual deploy's slow/fast).
const RATE_SHAPE = { '10fps': 'square', '20fps': 'circle', slow: 'square', fast: 'circle' };

// Fast/slow legend toggle: circle=fast, square=slow per RATE_SHAPE above (the
// same mapping the shapes already use), so this doesn't re-hardcode which of
// single-deploy's "10fps"/"20fps" or dual-deploy's "slow"/"fast" counts as
// which -- both are "fast" or "slow" through the same lookup.
function activeRate() {
  return state.isolatedRate ?? state.pinnedRate; // 'fast' | 'slow' | null
}
function rateMatches(pt, active) {
  if (!active) return true;
  const isFast = (RATE_SHAPE[pt.rate] || 'circle') === 'circle';
  return active === 'fast' ? isFast : !isFast;
}

// Populated by initFromData() once the selected launch date's JSON has
// loaded -- DATA starts null since data now comes from fetch(), not an
// embedded blob (see the launch-date <select> / manifest.json loading below).
let state = null;

// Deliberately NOT part of `state` / freshState() -- state resets on every
// date/site switch by design (see initFromData()), but a boost-angle the
// user dialed in is a standing preference about how they want the buffer
// drawn, not a "which zone am I looking at" selection, so it should survive
// switching dates the way currentSiteId does. null until the first dataset
// loads, then initialized from that dataset's boost_angle_deg and left alone
// by every subsequent switch.
let boostAngleDeg = null;

// Permalink support: site/date/mode/hour/deploy/rate/alt/compare read from
// the URL on first load, written back out on every render so a bookmark or a
// pasted link reproduces "what you were looking at" -- no login/accounts,
// just the querystring (user's call 2026-07-17: a club sends out a link to a
// launch date, or a flier bookmarks their home site + a fast/slow-only
// view). Read once into a snapshot rather than re-reading location.search
// live -- freshState() consumes it exactly once (see urlStateApplied) so a
// later manual site/mode switch starts from real defaults, not a stale URL
// value from whatever page load first parsed.
const URL_PARAMS = new URLSearchParams(location.search);
let urlStateApplied = false;

// The launch date is deliberately NOT live-synced into the URL by default --
// a target date is inherently perishable (today's "latest" becomes stale the
// moment a newer capture is pulled), so a plain bookmark or a long-lived tab
// should keep tracking "whatever's current," not silently freeze on whatever
// date happened to be selected at the time (user's call 2026-07-17). Date
// only gets written in once the user does one of two explicit things: picks
// a date from the dropdown themselves (see dateSelect's 'change' handler), or
// clicks "Copy link" (an unambiguous "give me a durable link to exactly
// this" ask) -- or if they arrived via a link that already had ?date= on it,
// which is itself evidence someone already did one of those two things.
let dateExplicitlyChosen = URL_PARAMS.has('date');

// Hour and deploy get the same treatment (user's call 2026-07-17, same day):
// their *default* is a fixed constant (DATA.hours[0]/DATA.deploys[0]) rather
// than a moving target like "latest date" is, so there's no staleness risk
// in leaving them out -- but a plain click around the map shouldn't start
// pinning "9am" or "Dual" into the address bar either, only a deliberate
// toggle click should (see the hour-toggle/deploy-toggle onChange callbacks
// in initFromData()). Unlike date, Copy Link does NOT force these in --
// since their default reproduces identically on any later visit, there's
// nothing for Copy Link to protect against by forcing them.
let hourExplicitlyChosen = URL_PARAMS.has('hour');
let deployExplicitlyChosen = URL_PARAMS.has('deploy');

function freshState() {
  const base = {
    mode: 'byAltitude',
    hour: DATA.hours[0], deploy: DATA.deploys[0],
    isolatedAlt: null, pinnedAlt: null,
    isolatedHour: null, pinnedHour: null,
    isolatedModel: null, pinnedModel: null,
    isolatedRate: null, pinnedRate: null,
    compareAlt: DATA.altitudes[0], // which altitude "by time of day" mode compares across hours
  };
  if (!urlStateApplied) {
    urlStateApplied = true;
    const mode = URL_PARAMS.get('mode');
    if (['byAltitude', 'byTime', 'byHistory'].includes(mode)) base.mode = mode;
    const hour = Number(URL_PARAMS.get('hour'));
    if (DATA.hours.includes(hour)) base.hour = hour;
    const deploy = URL_PARAMS.get('deploy');
    if (DATA.deploys.includes(deploy)) base.deploy = deploy;
    const rate = URL_PARAMS.get('rate');
    if (rate === 'fast' || rate === 'slow') base.pinnedRate = rate;
    const alt = Number(URL_PARAMS.get('alt'));
    if (DATA.altitudes.includes(alt)) base.pinnedAlt = alt;
    const compare = Number(URL_PARAMS.get('compare'));
    if (DATA.altitudes.includes(compare)) base.compareAlt = compare;
    if (base.mode === 'byHistory' && !base.pinnedRate) base.pinnedRate = 'fast';
  }
  return base;
}

// Same DOM side effects setMode() applies on a real user click, extracted so
// initFromData() can apply them for whatever mode the URL/default resolved
// to on first load too -- without also running setMode()'s pin-clearing
// (which would stomp the pinnedAlt/pinnedRate a permalink just supplied).
function applyModeUI(mode) {
  document.getElementById('hour-toggle-group').classList.toggle('disabled', mode === 'byTime');
  document.getElementById('time-legend-block').style.display = (mode === 'byTime' || mode === 'byHistory') ? '' : 'none';
  document.getElementById('time-legend-title').textContent = mode === 'byHistory' ? 'Forecast age' : 'Time of day';
  document.getElementById('time-color-controls').style.display = mode === 'byHistory' ? 'none' : '';
  document.getElementById('alt-hint').textContent =
    mode === 'byTime' ? 'Click an altitude to compare it across all times of day. Map colors now show time of day, not altitude.'
    : mode === 'byHistory' ? 'Click an altitude to see how each model\'s point for it moved across capture dates.'
    : 'Hover an altitude to isolate its zone. Click to pin it; click again to release. No single color reads well on every site\'s imagery -- pick one above that stands out here; shades for each altitude are generated from it.';
  document.getElementById('time-hint').textContent = mode === 'byHistory'
    ? 'Color = how many days before launch that capture was pulled (lighter = further out, darker = closer to launch).'
    : 'Hover a time to isolate it. Click to pin; click again to release.';
  document.getElementById('model-hint').textContent = mode === 'byHistory'
    ? 'Shape = model here (color means forecast age instead). Hover a model to isolate its path; click to pin, click again to release.'
    : 'Hover a model to isolate it -- zones collapse to a line (a single model\'s fast/slow points fall on the same bearing from the pad). Click to pin; click again to release.';
  document.getElementById('rate-hint').textContent =
    'Fast = single deploy 20 fps, or dual deploy drogue 100 fps + main 20 fps. Slow = single deploy 10 fps, or dual deploy drogue 80 fps + main 10 fps.'
    + (mode === 'byHistory' ? ' History always shows exactly one -- click the other to switch.' : ' Hover a rate to isolate it; click to pin, click again to release.');
}

// --- toggles ---
function buildToggle(containerId, options, labels, stateKey, onChange) {
  const el = document.getElementById(containerId);
  el.innerHTML = '';
  options.forEach(opt => {
    const btn = document.createElement('button');
    btn.textContent = labels[opt] || opt;
    btn.className = (opt === state[stateKey]) ? 'active' : '';
    btn.addEventListener('click', () => {
      state[stateKey] = opt;
      [...el.children].forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      if (onChange) onChange();
      render();
    });
    el.appendChild(btn);
  });
}

function setMode(mode) {
  state.mode = mode;
  // fresh start on every mode switch -- a hidden zone-group carrying over from
  // the other mode's isolation state would reference a data-alt/data-hour that
  // doesn't apply here
  state.isolatedAlt = null; state.pinnedAlt = null;
  state.isolatedHour = null; state.pinnedHour = null;
  state.isolatedModel = null; state.pinnedModel = null;
  // Rate resets here too, same as everything else above -- otherwise the
  // rate History auto-pins (below) leaks into byAltitude/byTime afterward,
  // silently filtering them to "fast only" until the user notices and
  // manually clears it.
  state.isolatedRate = null; state.pinnedRate = null;
  // History always shows exactly one rate (user's call 2026-07-17 -- showing
  // both would double the model x capture-date marker count for little
  // benefit); default to fast the first time this mode is entered, then
  // leave whatever the user picked alone on later visits.
  if (mode === 'byHistory' && !state.pinnedRate) state.pinnedRate = 'fast';
  applyModeUI(mode);
  buildAltList();
  buildTimeLegend();
  buildModelLegend();
  buildRateLegend();
  // note: no render() here -- buildToggle() already calls it after this
  // onChange callback returns, for the mode-toggle click that triggers this.
}

// --- altitude list: hover-isolate in "by altitude" mode, single-select in "by time" mode ---
function buildAltList() {
  const el = document.getElementById('alt-list');
  el.innerHTML = '';
  DATA.altitudes.forEach(alt => {
    const row = document.createElement('div');
    row.className = 'alt-row';
    row.innerHTML = `<div class="alt-swatch" style="background:${ALT_COLORS_HEX[alt]}"></div><span>${alt.toLocaleString()} ft</span>`;

    if (state.mode === 'byAltitude') {
      row.addEventListener('mouseenter', () => { state.isolatedAlt = alt; applyIsolation(); });
      row.addEventListener('mouseleave', () => { state.isolatedAlt = null; applyIsolation(); });
      row.addEventListener('click', () => {
        state.pinnedAlt = (state.pinnedAlt === alt) ? null : alt;
        [...el.children].forEach(r => r.classList.remove('pinned'));
        if (state.pinnedAlt === alt) row.classList.add('pinned');
        applyIsolation();
      });
      if (state.pinnedAlt === alt) row.classList.add('pinned');
    } else {
      row.addEventListener('click', () => {
        state.compareAlt = alt;
        [...el.children].forEach(r => r.classList.remove('pinned'));
        row.classList.add('pinned');
        render();
      });
      if (state.compareAlt === alt) row.classList.add('pinned');
    }
    el.appendChild(row);
  });
}

// Which models actually contributed a point anywhere in the current DATA
// (any hour/deploy/altitude) -- a model beyond its forecast horizon for this
// lead time (e.g. HRRR ~48h out, by a T-5/T-7 capture) has none at all. Used
// to gray those out in the legend instead of leaving them hoverable/
// clickable with nothing behind them, which just looked broken.
function modelsWithData() {
  const present = new Set();
  Object.values(DATA.data).forEach(zones => {
    zones.forEach(zone => zone.points.forEach(pt => present.add(pt.model)));
  });
  return present;
}

// History mode only: does the currently-selected hour/deploy/rate/altitude
// combo have any history points for this model at all -- distinct from
// modelsWithData()'s "anywhere in the main hull view," since History reads
// from a different fetch (HISTORY, not DATA) with its own key.
function historyModelsAvailable() {
  if (!HISTORY) return new Set();
  const key = `${state.hour}_${state.deploy}_${state.pinnedRate}_${state.compareAlt}`;
  return new Set((HISTORY.points_by_key[key] || []).map(p => p.model));
}

function buildModelLegend() {
  const el = document.getElementById('model-legend');
  el.innerHTML = '';
  const isHistory = state.mode === 'byHistory';
  const available = isHistory ? historyModelsAvailable() : modelsWithData();
  MODEL_LEGEND_ORDER.forEach(m => {
    const hasData = available.has(m);
    const row = document.createElement('div');
    row.className = 'alt-row' + (hasData ? '' : ' unavailable');
    const label = MODEL_LABELS[m] || m.toUpperCase();
    // History mode: model identity is shape, not color (color means recency
    // there instead) -- see MODEL_SHAPES.
    const swatch = isHistory
      ? shapeSwatchSVG(MODEL_SHAPES[m], hasData ? 'var(--text-secondary)' : 'var(--text-muted)')
      : `<div class="alt-swatch" style="background:${hasData ? MODEL_COLORS_HEX[m] : 'var(--text-muted)'}"></div>`;
    row.innerHTML = `${swatch}<span>${label}${hasData ? '' : ' (no data)'}</span>`;
    if (hasData) {
      row.addEventListener('mouseenter', () => { state.isolatedModel = m; render(); });
      row.addEventListener('mouseleave', () => { state.isolatedModel = null; render(); });
      row.addEventListener('click', () => {
        state.pinnedModel = (state.pinnedModel === m) ? null : m;
        [...el.children].forEach(r => r.classList.remove('pinned'));
        if (state.pinnedModel === m) row.classList.add('pinned');
        render();
      });
      if (state.pinnedModel === m) row.classList.add('pinned');
    } else {
      row.title = `${label} has no data for this lead time -- likely beyond this model's forecast horizon.`;
    }
    el.appendChild(row);
  });
}

const RATE_LEGEND_ITEMS = [
  { key: 'fast', label: 'Fast', shape: 'circle' },
  { key: 'slow', label: 'Slow', shape: 'square' },
];

function buildRateLegend() {
  const el = document.getElementById('rate-legend');
  el.innerHTML = '';
  RATE_LEGEND_ITEMS.forEach(({ key, label, shape }) => {
    const row = document.createElement('div');
    row.className = 'alt-row';
    const swatchStyle = shape === 'circle' ? 'border-radius:50%;' : 'border-radius:3px;';
    row.innerHTML = `<div style="width:16px;height:16px;${swatchStyle}background:var(--text-secondary);flex-shrink:0;"></div><span>${label}</span>`;
    row.addEventListener('mouseenter', () => { state.isolatedRate = key; render(); });
    row.addEventListener('mouseleave', () => { state.isolatedRate = null; render(); });
    row.addEventListener('click', () => {
      // History always shows exactly one rate -- clicking the already-
      // selected one stays selected instead of toggling back to "both"
      // (which byAltitude/byTime support but History deliberately doesn't).
      state.pinnedRate = state.mode === 'byHistory' ? key : (state.pinnedRate === key ? null : key);
      [...el.children].forEach(r => r.classList.remove('pinned'));
      if (state.pinnedRate === key) row.classList.add('pinned');
      render();
    });
    if (state.pinnedRate === key) row.classList.add('pinned');
    el.appendChild(row);
  });
}

function buildTimeLegend() {
  const el = document.getElementById('time-legend');
  el.innerHTML = '';
  if (state.mode === 'byHistory') {
    if (!HISTORY) return;
    [...HISTORY.captures].sort().forEach(captureDate => {
      const leadDays = Math.round((new Date(HISTORY.target_date) - new Date(captureDate)) / 86400000);
      const row = document.createElement('div');
      row.className = 'alt-row static';
      row.innerHTML = `<div class="alt-swatch" style="background:${recencyColor(leadDays)}"></div><span>${leadDaysLabel(captureDate, HISTORY.target_date)} (${captureDate})</span>`;
      el.appendChild(row);
    });
    const actualRow = document.createElement('div');
    actualRow.className = 'alt-row static';
    actualRow.innerHTML = `${shapeSwatchSVG('star', ACTUAL_MARKER_COLOR)}<span>Actual landing (once recorded)</span>`;
    el.appendChild(actualRow);
    return;
  }
  DATA.hours.forEach(h => {
    const row = document.createElement('div');
    row.className = 'alt-row';
    row.innerHTML = `<div class="alt-swatch" style="background:${TIME_COLORS_HEX[h]}"></div><span>${HOUR_LABELS[h]}</span>`;
    row.addEventListener('mouseenter', () => { state.isolatedHour = h; applyIsolation(); });
    row.addEventListener('mouseleave', () => { state.isolatedHour = null; applyIsolation(); });
    row.addEventListener('click', () => {
      state.pinnedHour = (state.pinnedHour === h) ? null : h;
      [...el.children].forEach(r => r.classList.remove('pinned'));
      if (state.pinnedHour === h) row.classList.add('pinned');
      applyIsolation();
    });
    if (state.pinnedHour === h) row.classList.add('pinned');
    el.appendChild(row);
  });
}

function applyIsolation() {
  if (state.mode === 'byAltitude') {
    const active = state.isolatedAlt ?? state.pinnedAlt;
    document.querySelectorAll('.zone-group').forEach(g => {
      const alt = parseInt(g.dataset.alt, 10);
      g.style.display = (active === null || alt === active) ? '' : 'none';
    });
  } else {
    const active = state.isolatedHour ?? state.pinnedHour;
    document.querySelectorAll('.zone-group').forEach(g => {
      const hour = parseInt(g.dataset.hour, 10);
      g.style.display = (active === null || hour === active) ? '' : 'none';
    });
  }
  syncUrl();
}

// --- pan / zoom (viewBox-based) ---
const wrap = document.getElementById('map-wrap');
const svg = document.getElementById('overlay');
// Assigned per-dataset in initFromData() (was a one-time const off the
// embedded DATA blob; now DATA can change at runtime via the date selector).
let BASE_VB, IMG_VB, view, MIN_SPAN, MAX_SPAN;

function setViewBox() {
  svg.setAttribute('viewBox', `${view.x} ${view.y} ${view.w} ${view.h}`);
}

function zoomAt(factor, clientX, clientY) {
  const rect = wrap.getBoundingClientRect();
  const fx = (clientX - rect.left) / rect.width;
  const fy = (clientY - rect.top) / rect.height;
  const newW = Math.min(MAX_SPAN, Math.max(MIN_SPAN, view.w * factor));
  const newH = Math.min(MAX_SPAN, Math.max(MIN_SPAN, view.h * factor));
  const actualFactor = newW / view.w;
  view.x = view.x + fx * view.w * (1 - actualFactor);
  view.y = view.y + fy * view.h * (1 - actualFactor);
  view.w = newW;
  view.h = newH;
  setViewBox();
}

wrap.addEventListener('wheel', evt => {
  evt.preventDefault();
  const factor = evt.deltaY > 0 ? 1.15 : 1 / 1.15;
  zoomAt(factor, evt.clientX, evt.clientY);
}, { passive: false });

// --- pan (1 finger/mouse) + pinch-zoom (2 fingers), via Pointer Events so
// mouse and touch share one code path. mapPointers excludes any pointer that
// started on the pad marker (drawPadMarker() stopPropagation's those) so
// dragging the pad never also pans the map. Pointer capture keeps events
// targeting wrap even once a fast finger drags outside its bounds.
const mapPointers = new Map(); // pointerId -> {x, y}
let dragging = false, lastX = 0, lastY = 0;
let pinchDist = null, pinchMid = null;

wrap.addEventListener('pointerdown', evt => {
  wrap.setPointerCapture(evt.pointerId);
  mapPointers.set(evt.pointerId, { x: evt.clientX, y: evt.clientY });
  if (mapPointers.size === 1) {
    dragging = true;
    wrap.classList.add('dragging');
    lastX = evt.clientX; lastY = evt.clientY;
  } else if (mapPointers.size === 2) {
    dragging = false;
    wrap.classList.remove('dragging');
    const [p1, p2] = mapPointers.values();
    pinchDist = Math.hypot(p1.x - p2.x, p1.y - p2.y);
    pinchMid = { x: (p1.x + p2.x) / 2, y: (p1.y + p2.y) / 2 };
  }
});
wrap.addEventListener('pointermove', evt => {
  if (!mapPointers.has(evt.pointerId)) return;
  mapPointers.set(evt.pointerId, { x: evt.clientX, y: evt.clientY });

  if (mapPointers.size >= 2) {
    const [p1, p2] = mapPointers.values();
    const dist = Math.hypot(p1.x - p2.x, p1.y - p2.y);
    const mid = { x: (p1.x + p2.x) / 2, y: (p1.y + p2.y) / 2 };
    if (pinchDist != null) {
      zoomAt(pinchDist / dist, mid.x, mid.y); // fingers spreading -> dist grows -> factor<1 -> zoom in
      const rect = wrap.getBoundingClientRect();
      view.x -= (mid.x - pinchMid.x) / rect.width * view.w;
      view.y -= (mid.y - pinchMid.y) / rect.height * view.h;
      setViewBox();
    }
    pinchDist = dist;
    pinchMid = mid;
  } else if (dragging) {
    const rect = wrap.getBoundingClientRect();
    const dx = (evt.clientX - lastX) / rect.width * view.w;
    const dy = (evt.clientY - lastY) / rect.height * view.h;
    view.x -= dx; view.y -= dy;
    lastX = evt.clientX; lastY = evt.clientY;
    setViewBox();
  }
});
function endMapPointer(evt) {
  mapPointers.delete(evt.pointerId);
  if (mapPointers.size === 0) {
    dragging = false;
    wrap.classList.remove('dragging');
    pinchDist = null; pinchMid = null;
  } else if (mapPointers.size === 1) {
    // one finger lifted out of a pinch -- resume single-finger pan from the remaining one
    dragging = true;
    pinchDist = null; pinchMid = null;
    const [p] = mapPointers.values();
    lastX = p.x; lastY = p.y;
  }
}
wrap.addEventListener('pointerup', endMapPointer);
wrap.addEventListener('pointercancel', endMapPointer);

// --- draggable launch pad (see MAX_PAD_MOVE_FT/padOffsetFt) -- pointerdown is
// wired per-render on the marker itself (drawPadMarker()); this just handles
// the drag continuation, mirroring the map-pan pointermove/pointerup above
// (screen-px delta -> SVG-unit delta via the same rect/view ratio), then one
// more conversion from SVG px to ft via ft_to_px_scale, since padOffsetFt is
// stored in feet (stays valid across zoom/pan, unlike a raw pixel offset).
let draggingPad = false, padLastX = 0, padLastY = 0;
window.addEventListener('pointermove', evt => {
  if (!draggingPad) return;
  const rect = wrap.getBoundingClientRect();
  const dxPx = (evt.clientX - padLastX) / rect.width * view.w;
  const dyPx = (evt.clientY - padLastY) / rect.height * view.h;
  padLastX = evt.clientX; padLastY = evt.clientY;

  const newX = padOffsetFt.x + dxPx / DATA.ft_to_px_scale.x;
  const newY = padOffsetFt.y - dyPx / DATA.ft_to_px_scale.y; // screen y grows downward, north is +y
  const dist = Math.hypot(newX, newY);
  if (dist > MAX_PAD_MOVE_FT) {
    const scale = MAX_PAD_MOVE_FT / dist;
    padOffsetFt = { x: newX * scale, y: newY * scale };
  } else {
    padOffsetFt = { x: newX, y: newY };
  }
  render();
});
function endPadDrag() { draggingPad = false; wrap.classList.remove('dragging-pad'); }
window.addEventListener('pointerup', endPadDrag);
window.addEventListener('pointercancel', endPadDrag);

document.getElementById('zoom-in').addEventListener('click', () => {
  const rect = wrap.getBoundingClientRect();
  zoomAt(1 / 1.4, rect.left + rect.width / 2, rect.top + rect.height / 2);
});
document.getElementById('zoom-out').addEventListener('click', () => {
  const rect = wrap.getBoundingClientRect();
  zoomAt(1.4, rect.left + rect.width / 2, rect.top + rect.height / 2);
});
document.getElementById('zoom-reset').addEventListener('click', () => {
  view = { x: IMG_VB[0], y: IMG_VB[1], w: IMG_VB[2], h: IMG_VB[3] };
  setViewBox();
});

// --- permalink copy button: the URL bar is kept live-synced for
// site/mode/hour/deploy/rate/alt (see syncUrl()), but NOT the launch date by
// default -- clicking this button is itself the explicit "give me a durable
// link to exactly this" ask (user's call 2026-07-17), so it always includes
// the currently-selected date regardless, and flips dateExplicitlyChosen so
// the address bar starts keeping it too from here on. ---
const copyLinkBtn = document.getElementById('copy-link-btn');
copyLinkBtn.addEventListener('click', () => {
  dateExplicitlyChosen = true;
  const url = `${location.origin}${location.pathname}?${buildPermalinkParams(true).toString()}`;
  syncUrl(); // address bar reflects the now-included date immediately too
  const showCopied = () => {
    const original = copyLinkBtn.textContent;
    copyLinkBtn.textContent = 'Copied!';
    copyLinkBtn.classList.add('copied');
    setTimeout(() => { copyLinkBtn.textContent = original; copyLinkBtn.classList.remove('copied'); }, 1500);
  };
  if (navigator.clipboard && window.isSecureContext) {
    navigator.clipboard.writeText(url).then(showCopied).catch(() => window.prompt('Copy this link:', url));
  } else {
    window.prompt('Copy this link:', url);
  }
});

// --- boost-angle slider: recomputes the buffer band client-side (see
// computeBufferHullPx()) rather than reloading data -- boostAngleDeg is the
// only thing that changes, everything it needs (raw points, ft_to_px_scale)
// is already in the currently-loaded DATA. ---
const boostAngleSlider = document.getElementById('boost-angle-slider');
const boostAngleReadout = document.getElementById('boost-angle-readout');
boostAngleSlider.addEventListener('input', () => {
  boostAngleDeg = Number(boostAngleSlider.value);
  boostAngleReadout.textContent = `${boostAngleDeg}°`;
  render();
});

// --- zone + time-of-day color pickers: no fixed hue survives every site's
// imagery (see the comment above computeSequentialRamp), so the user picks a
// base color for each and computeSequentialRamp() derives the shades live.
// Persisted in localStorage so the choice sticks across reloads/sites --
// it's a "what reads well on my screen" preference, not a per-site fact.
// Altitude's key list comes from DATA.altitudes (varies 5-9 per site's
// waiver); time's is always the fixed 4 hours. ---
const zoneColorPicker = document.getElementById('zone-color-picker');
const zoneColorReset = document.getElementById('zone-color-reset');
const bufferSwatch = document.getElementById('buffer-swatch');
const timeColorPicker = document.getElementById('time-color-picker');
const timeColorReset = document.getElementById('time-color-reset');
zoneColorPicker.value = zoneBaseColor;
timeColorPicker.value = timeBaseColor;

function applyZoneBaseColor(hex) {
  zoneBaseColor = hex;
  ALT_COLORS_HEX = computeSequentialRamp(zoneBaseColor, DATA ? DATA.altitudes : [1000, 3000, 5000, 7000, 9000]);
  zoneColorPicker.value = zoneBaseColor;
  bufferSwatch.style.background = zoneBaseColor;
  bufferSwatch.style.borderColor = zoneBaseColor;
  buildAltList();
  render();
}
zoneColorPicker.addEventListener('input', () => {
  localStorage.setItem(ZONE_COLOR_STORAGE_KEY, zoneColorPicker.value);
  applyZoneBaseColor(zoneColorPicker.value);
});
zoneColorReset.addEventListener('click', () => {
  localStorage.removeItem(ZONE_COLOR_STORAGE_KEY);
  applyZoneBaseColor(DEFAULT_ZONE_BASE_COLOR);
});
// Just the swatch here, not the full applyZoneBaseColor() -- DATA hasn't
// loaded yet at this point in script execution, so buildAltList()/render()
// would have nothing to draw. ALT_COLORS_HEX is already correct (computed
// at module load above); the normal initFromData() -> render() flow below
// recomputes it against the real per-site altitude list once data arrives.
bufferSwatch.style.background = zoneBaseColor;
bufferSwatch.style.borderColor = zoneBaseColor;

function applyTimeBaseColor(hex) {
  timeBaseColor = hex;
  TIME_COLORS_HEX = computeSequentialRamp(timeBaseColor, [9, 11, 13, 15]);
  timeColorPicker.value = timeBaseColor;
  buildTimeLegend();
  render();
}
timeColorPicker.addEventListener('input', () => {
  localStorage.setItem(TIME_COLOR_STORAGE_KEY, timeColorPicker.value);
  applyTimeBaseColor(timeColorPicker.value);
});
timeColorReset.addEventListener('click', () => {
  localStorage.removeItem(TIME_COLOR_STORAGE_KEY);
  applyTimeBaseColor(DEFAULT_TIME_BASE_COLOR);
});

// --- pad-move reset/readout (dragging itself is wired in drawPadMarker()) ---
const padReadout = document.getElementById('pad-readout');
const padResetBtn = document.getElementById('pad-reset-btn');
padResetBtn.addEventListener('click', () => {
  padOffsetFt = { x: 0, y: 0 };
  render();
});

// --- legend info buttons: hints are collapsed by default (the hover/click-
// to-isolate interaction is the same standard pattern across every legend,
// not worth showing unprompted) -- click the "i" to reveal/hide it. Static
// markup (not rebuilt per render like the legends themselves), so wired once.
document.querySelectorAll('.info-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    const hint = document.getElementById(btn.dataset.hint);
    const isOpen = hint.classList.toggle('open');
    btn.classList.toggle('open', isOpen);
  });
});

// --- tooltip ---
// Points that end up within PROXIMITY_PX of each other (common near apogee
// where several models roughly agree) render as overlapping circles that are
// hard to individually target -- rather than fight for exact hit-precision,
// hovering any one of them shows all of them together in one tooltip.
const tooltip = document.getElementById('tooltip');
const PROXIMITY_PX = 22; // a bit more than 2x the marker radius (9)

function isPointVisible(rp) {
  if (state.mode === 'byAltitude') {
    const active = state.isolatedAlt ?? state.pinnedAlt;
    return active === null || rp.altitude === active;
  } else {
    const active = state.isolatedHour ?? state.pinnedHour;
    return active === null || rp.hour === active;
  }
}

function showTooltip(evt, hoveredPt) {
  const nearby = renderedPoints.filter(rp => {
    if (!isPointVisible(rp)) return false;
    const dx = rp.px - hoveredPt.px, dy = rp.py - hoveredPt.py;
    return Math.sqrt(dx * dx + dy * dy) <= PROXIMITY_PX;
  });
  tooltip.style.display = 'block';
  tooltip.style.left = (evt.clientX + 14) + 'px';
  tooltip.style.top = (evt.clientY + 14) + 'px';
  tooltip.innerHTML = nearby.map(rp => {
    const dist = Math.sqrt(rp.x_ft * rp.x_ft + rp.y_ft * rp.y_ft);
    const whenPart = state.mode === 'byTime' ? ` &middot; ${HOUR_LABELS[rp.hour]}`
      : state.mode === 'byHistory' ? ` &middot; ${leadDaysLabel(rp.capture_date, HISTORY.target_date)} (captured ${rp.capture_date})`
      : '';
    return `<div class="tt-row"><b>${MODEL_LABELS[rp.model] || rp.model.toUpperCase()}</b> &middot; ${rp.rate}${whenPart}<br>` +
      `apogee ${rp.altitude.toLocaleString()} ft<br>` +
      `offset: ${rp.x_ft >= 0 ? '+' : ''}${rp.x_ft.toFixed(0)} ft E, ${rp.y_ft >= 0 ? '+' : ''}${rp.y_ft.toFixed(0)} ft N<br>` +
      `distance from pad: ${dist.toFixed(0)} ft</div>`;
  }).join('');
}
function hideTooltip() { tooltip.style.display = 'none'; }

// --- render ---
function polyPoints(hull) { return hull.map(p => p.join(',')).join(' '); }
const ns = 'http://www.w3.org/2000/svg';
let renderedPoints = [];

// --- client-side hull recompute (boost-angle buffer + core hull) ----------
// Ported from pipeline/splash_zones.py's hull_of()/buffered_points()/
// ft_to_px(). Both the buffer band and the core hull are recomputed here on
// every render from each zone's raw x_ft/y_ft points (drawZone() does this,
// not the server-baked core_hull_px/buffer_hull_px) -- needed for two
// independent reasons: the boost-angle slider has to move the buffer live
// rather than being locked to whatever angle that day's pull baked in, and
// the Fast/Slow filter has to actually shrink both hulls to whichever rate
// is currently visible rather than leaving a static both-rates outline
// around a filtered set of dots.

// Convex hull via Andrew's monotone chain -- doesn't need to match scipy's
// ConvexHull vertex order exactly, just needs to be a valid hull polygon,
// which any correct hull algorithm gives.
function convexHull(points) {
  if (points.length < 3) return points;
  const pts = [...points].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower = [];
  for (const p of pts) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop();
    lower.push(p);
  }
  const upper = [];
  for (let i = pts.length - 1; i >= 0; i--) {
    const p = pts[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop();
    upper.push(p);
  }
  upper.pop(); lower.pop();
  return lower.concat(upper);
}

function bufferedPointsFt(pointsFt, radiusFt, n = 12) {
  const out = [];
  for (const [x, y] of pointsFt) {
    for (let i = 0; i < n; i++) {
      const theta = 2 * Math.PI * i / n;
      out.push([x + radiusFt * Math.cos(theta), y + radiusFt * Math.sin(theta)]);
    }
  }
  return out;
}

// Draggable launch pad: capped at 2,000 ft from the surveyed GPS point --
// (a) every model here is on a grid coarser than that (HRRR, the finest,
// is ~3km/~9,800ft; GFS/ECMWF/etc. much coarser), so nothing within this
// radius could ever pull a different forecast value regardless of exact
// pad placement -- the cap can't accidentally imply "a different location's
// weather" the way a multi-mile move could; (b) it's generous enough for a
// real "set up on the other side of the field" adjustment without
// pretending to model an actually different site; (c) it stays inside even
// the smallest site's detail-map crop (Apache Pass's ~3,800 ft half-width),
// so the pad marker can never drag off the visible imagery. User's call
// 2026-07-17 to add this at all; this number is Claude's estimate of where
// "same field" stops being a reasonable description, not a club-specified
// figure -- revisit if a club says otherwise.
const MAX_PAD_MOVE_FT = 2000;
// Not part of `state` -- like boostAngleDeg, this is a standing "what if"
// exploration setting, not a "which zone am I looking at" selection. Reset
// on site switch (selectSite()) since a different site's pad is a genuinely
// different GPS point, but left alone across date switches within a site.
let padOffsetFt = { x: 0, y: 0 };

function ftToPx(x_ft, y_ft) {
  return [
    DATA.site_px[0] + (x_ft + padOffsetFt.x) * DATA.ft_to_px_scale.x,
    DATA.site_px[1] - (y_ft + padOffsetFt.y) * DATA.ft_to_px_scale.y,
  ];
}

// Caller passes whichever points should currently count -- drawZone() passes
// the rate-filtered set so isolating Fast/Slow actually shrinks the buffer,
// not the unfiltered zone.points (see drawZone()'s comment on why that
// changed 2026-07-17: a static both-rates outline around filtered-down dots
// read as broken, not as "the buffer means something different").
function computeBufferHullPx(zonePoints, boostAngleDeg, altitudeFt) {
  const radiusFt = altitudeFt * Math.tan(boostAngleDeg * Math.PI / 180);
  const ptsFt = zonePoints.map(p => [p.x_ft, p.y_ft]);
  const hullFt = convexHull(bufferedPointsFt(ptsFt, radiusFt));
  return hullFt.map(([x, y]) => ftToPx(x, y));
}

// --- History view: one splash point per model per capture date ------------
// (see docstring at MODE_LABELS/MODEL_SHAPES for why it's "History" not
// "Drift"). Deliberately simplified relative to the main view per the
// 2026-07-17 direction that started this: no wind speed/direction, no
// hull/buffer, just where each model's point landed and how that moved
// capture to capture, for one fixed hour/deploy/rate/altitude.

// Grayscale, not another hue -- avoids relitigating which of the six
// categorical hues (already spoken for: violet=altitude, orange=time,
// the remaining six=model identity elsewhere) is "free" for recency, and
// "fades from ghost to solid as launch approaches" is a reasonably
// intuitive metaphor on its own. Anchored to a fixed 7-day scale (not
// stretched to whatever range this particular target happens to have
// captures across) so T-1 always reads as the same shade regardless of
// whether a target has 2 captures or 6.
const RECENCY_MAX_LEAD_DAYS = 7;
const RECENCY_COLOR_FAR = [201, 200, 194]; // light -- long lead (T-7+)
const RECENCY_COLOR_NEAR = [26, 26, 25]; // dark -- T-0

function recencyColor(leadDays) {
  const t = Math.max(0, Math.min(1, 1 - leadDays / RECENCY_MAX_LEAD_DAYS));
  const mixed = RECENCY_COLOR_FAR.map((v, i) => Math.round(v + (RECENCY_COLOR_NEAR[i] - v) * t));
  return `rgb(${mixed.join(',')})`;
}

function leadDaysLabel(captureDateStr, targetDateStr) {
  const leadDays = Math.round((new Date(targetDateStr) - new Date(captureDateStr)) / 86400000);
  return leadDays > 0 ? `T-${leadDays}` : 'T-0';
}

// Bright, saturated, and outside both the model-shape set and the recency
// grayscale ramp -- an actual landing needs to be unmistakable, not just
// another data point in the series.
const ACTUAL_MARKER_COLOR = '#e0b400';
const ACTUAL_MARKER_STROKE = '#1a1a19';

// Unified marker drawer for both model-shape points (History mode) and the
// star-shaped actual-landing marker -- one place that knows how to render
// each shape name, rather than scattering per-shape SVG construction.
function drawMarker(parent, shape, cx, cy, size, fill, stroke) {
  let el;
  if (shape === 'circle') {
    el = document.createElementNS(ns, 'circle');
    el.setAttribute('cx', cx); el.setAttribute('cy', cy); el.setAttribute('r', size);
  } else if (shape === 'square') {
    el = document.createElementNS(ns, 'rect');
    el.setAttribute('x', cx - size); el.setAttribute('y', cy - size);
    el.setAttribute('width', size * 2); el.setAttribute('height', size * 2);
    el.setAttribute('rx', 2);
  } else if (shape === 'plus') {
    el = document.createElementNS(ns, 'path');
    const a = size * 0.38, b = size; // arm half-width, arm reach
    el.setAttribute('d', `M${cx - a},${cy - b} h${2 * a} v${b - a} h${b - a} v${2 * a} h${-(b - a)} v${b - a} h${-2 * a} v${-(b - a)} h${-(b - a)} v${-2 * a} h${b - a} Z`);
  } else {
    // polygon shapes: triangle-up, triangle-down, diamond, star
    const pts = shapePolygonPoints(shape, cx, cy, size);
    el = document.createElementNS(ns, 'polygon');
    el.setAttribute('points', pts.map(p => p.join(',')).join(' '));
  }
  el.setAttribute('fill', fill);
  el.setAttribute('stroke', stroke || 'var(--point-stroke)');
  el.setAttribute('stroke-width', 2);
  parent.appendChild(el);
  return el;
}

function shapePolygonPoints(shape, cx, cy, size) {
  const rot = { 'triangle-up': -90, 'triangle-down': 90, diamond: -45 }[shape];
  if (shape === 'star') {
    const pts = [];
    for (let i = 0; i < 10; i++) {
      const r = i % 2 === 0 ? size * 1.15 : size * 0.45;
      const angle = (Math.PI / 5) * i - Math.PI / 2;
      pts.push([cx + r * Math.cos(angle), cy + r * Math.sin(angle)]);
    }
    return pts;
  }
  const n = shape === 'diamond' ? 4 : 3;
  const pts = [];
  for (let i = 0; i < n; i++) {
    const angle = (2 * Math.PI * i) / n + (rot * Math.PI) / 180;
    pts.push([cx + size * Math.cos(angle), cy + size * Math.sin(angle)]);
  }
  return pts;
}

// Small inline-SVG legend swatch for a shape (History mode's model legend,
// and the actual-landing star in the recency legend) -- reuses
// shapePolygonPoints() so the legend icon is drawn by the exact same math
// as the real marker, not a hand-drawn approximation of it.
function shapeSwatchSVG(shape, color) {
  const cx = 8, cy = 8, size = 5.5;
  let inner;
  if (shape === 'circle') inner = `<circle cx="${cx}" cy="${cy}" r="${size}" />`;
  else if (shape === 'square') inner = `<rect x="${cx - size}" y="${cy - size}" width="${size * 2}" height="${size * 2}" rx="1.5" />`;
  else if (shape === 'plus') {
    const a = size * 0.38, b = size;
    inner = `<path d="M${cx - a},${cy - b} h${2 * a} v${b - a} h${b - a} v${2 * a} h${-(b - a)} v${b - a} h${-2 * a} v${-(b - a)} h${-(b - a)} v${-2 * a} h${b - a} Z" />`;
  } else {
    const pts = shapePolygonPoints(shape, cx, cy, size);
    inner = `<polygon points="${pts.map(p => p.join(',')).join(' ')}" />`;
  }
  return `<svg width="16" height="16" viewBox="0 0 16 16" style="flex-shrink:0;"><g fill="${color}" stroke="var(--point-stroke)" stroke-width="1">${inner}</g></svg>`;
}

function renderHistory() {
  if (!HISTORY) {
    const label = document.createElementNS(ns, 'text');
    label.setAttribute('x', IMG_VB[2] / 2); label.setAttribute('y', IMG_VB[3] / 2);
    label.setAttribute('text-anchor', 'middle');
    label.setAttribute('class', 'pad-label');
    label.textContent = 'No forecast history published for this target date yet.';
    svg.appendChild(label);
    return;
  }

  const rate = state.pinnedRate; // always set once byHistory is entered -- see setMode()
  const key = `${state.hour}_${state.deploy}_${rate}_${state.compareAlt}`;
  const seriesByModel = {};
  (HISTORY.points_by_key[key] || []).forEach(pt => {
    (seriesByModel[pt.model] ??= []).push(pt);
  });
  const actual = HISTORY.actuals[key];

  const activeModel = state.isolatedModel ?? state.pinnedModel;

  Object.entries(seriesByModel).forEach(([model, series]) => {
    if (activeModel && model !== activeModel) return;
    const sorted = [...series].sort((a, b) => new Date(a.capture_date) - new Date(b.capture_date));
    const shape = MODEL_SHAPES[model] || 'circle';
    const pxPts = sorted.map(p => ftToPx(p.x_ft, p.y_ft));

    if (pxPts.length > 1) {
      const line = document.createElementNS(ns, 'polyline');
      line.setAttribute('points', pxPts.map(p => p.join(',')).join(' '));
      line.setAttribute('fill', 'none');
      line.setAttribute('stroke', 'var(--text-secondary)');
      line.setAttribute('stroke-width', 1.5);
      line.setAttribute('stroke-opacity', '0.6');
      line.setAttribute('pointer-events', 'none'); // don't steal hover from the marker dots on top of it
      svg.appendChild(line);
    }

    sorted.forEach((pt, i) => {
      const leadDays = Math.round((new Date(HISTORY.target_date) - new Date(pt.capture_date)) / 86400000);
      const [px, py] = pxPts[i];
      const marker = drawMarker(svg, shape, px, py, 9, recencyColor(leadDays));
      marker.classList.add('pt');
      const rp = { model, rate, x_ft: pt.x_ft, y_ft: pt.y_ft, px, py, capture_date: pt.capture_date, altitude: state.compareAlt, hour: state.hour };
      renderedPoints.push(rp);
      marker.addEventListener('mousemove', evt => showTooltip(evt, rp));
      marker.addEventListener('mouseleave', hideTooltip);
    });
  });

  if (actual) {
    const [px, py] = ftToPx(actual.x_ft, actual.y_ft);
    drawMarker(svg, 'star', px, py, 13, ACTUAL_MARKER_COLOR, ACTUAL_MARKER_STROKE);
  }
}

// --- Accuracy-vs-actual table (History mode only, added 2026-07-18) --------
// Cell color uses the fixed 4-step status scale (good/warning/serious/
// critical), not a plain sequential ramp -- the color here literally means
// "how accurate," not just "big number" (dataviz skill's own carve-out for
// exactly this case: status tokens are legal, even required, when the color
// *means* good/bad rather than encoding identity). Dark ink (#1a1a19) on all
// four clears >=3:1 text contrast (verified 5.19/9.49/6.6/3.62); every
// cell's number is always visible as text too, so color is never the sole
// channel. Thresholds are quartiles of the distances actually present in
// THIS table, not a fixed-feet scale -- 200ft is a great miss at a
// 50,000ft-waiver site and a mediocre one at a 6,000ft site, so "green"
// here means "relatively best in this specific comparison," not some
// universal accuracy bar.
const ACCURACY_COLORS = ['#0ca30c', '#fab219', '#ec835a', '#d03b3b']; // good -> critical

function accuracyColor(dist, thresholds) {
  if (dist <= thresholds[0]) return ACCURACY_COLORS[0];
  if (dist <= thresholds[1]) return ACCURACY_COLORS[1];
  if (dist <= thresholds[2]) return ACCURACY_COLORS[2];
  return ACCURACY_COLORS[3];
}

function quartileThresholds(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const q = p => sorted[Math.min(sorted.length - 1, Math.floor(p * (sorted.length - 1)))];
  return [q(0.25), q(0.5), q(0.75)];
}

function renderAccuracyTable() {
  const section = document.getElementById('accuracy-section');
  const rate = state.pinnedRate;
  const key = `${state.hour}_${state.deploy}_${rate}_${state.compareAlt}`;
  const actual = HISTORY && HISTORY.actuals[key];
  if (!actual) return; // stays hidden -- render() already set display:none

  const seriesByModel = {};
  (HISTORY.points_by_key[key] || []).forEach(pt => {
    (seriesByModel[pt.model] ??= []).push(pt);
  });
  const models = Object.keys(seriesByModel).sort();
  if (!models.length) return;

  const cellData = {}; // model -> capture_date -> {dist, dx, dy}
  const allDists = [];
  models.forEach(model => {
    cellData[model] = {};
    seriesByModel[model].forEach(pt => {
      const dx = pt.x_ft - actual.x_ft, dy = pt.y_ft - actual.y_ft;
      const dist = Math.hypot(dx, dy);
      cellData[model][pt.capture_date] = { dist, dx, dy };
      allDists.push(dist);
    });
  });
  const thresholds = quartileThresholds(allDists);

  const table = document.getElementById('accuracy-table');
  let html = '<thead><tr><th>Model</th>';
  HISTORY.captures.forEach(c => {
    html += `<th>${leadDaysLabel(c, HISTORY.target_date)}</th>`;
  });
  html += '</tr></thead><tbody>';
  models.forEach(model => {
    html += `<tr><th>${model}</th>`;
    HISTORY.captures.forEach(c => {
      const cell = cellData[model][c];
      if (!cell) {
        html += '<td class="accuracy-empty">&mdash;</td>';
        return;
      }
      const color = accuracyColor(cell.dist, thresholds);
      const dxStr = (cell.dx >= 0 ? '+' : '') + Math.round(cell.dx);
      const dyStr = (cell.dy >= 0 ? '+' : '') + Math.round(cell.dy);
      html += `<td style="background:${color}"><div class="accuracy-dist">${Math.round(cell.dist)} ft</div><div class="accuracy-xy">(${dxStr}, ${dyStr})</div></td>`;
    });
    html += '</tr>';
  });
  html += '</tbody>';
  table.innerHTML = html;
  section.style.display = '';
}

function drawPoint(g, pt, hour, altitude, fillColor) {
  // Recomputed from x_ft/y_ft via ftToPx() rather than trusting pt.px/pt.py
  // (the server-baked pixel position) -- the baked value is only ever right
  // when the pad hasn't been dragged (see padOffsetFt); recomputing here is
  // what makes every rendered point actually move with the pad instead of
  // just the hulls/buffer (which already went through ftToPx()).
  const [px, py] = ftToPx(pt.x_ft, pt.y_ft);
  const rp = Object.assign({}, pt, { altitude, hour, px, py });
  renderedPoints.push(rp);
  const shape = RATE_SHAPE[pt.rate] || 'circle';
  let c;
  if (shape === 'square') {
    c = document.createElementNS(ns, 'rect');
    c.setAttribute('x', px - 8);
    c.setAttribute('y', py - 8);
    c.setAttribute('width', 16);
    c.setAttribute('height', 16);
    c.setAttribute('rx', 3);
  } else {
    c = document.createElementNS(ns, 'circle');
    c.setAttribute('cx', px);
    c.setAttribute('cy', py);
    c.setAttribute('r', 9);
  }
  c.setAttribute('class', 'pt');
  c.setAttribute('fill', fillColor);
  c.addEventListener('mousemove', evt => showTooltip(evt, rp));
  c.addEventListener('mouseleave', hideTooltip);
  g.appendChild(c);
}

function drawZone(zone, color, hour) {
  const g = document.createElementNS(ns, 'g');
  g.setAttribute('class', 'zone-group');
  g.dataset.alt = zone.altitude;
  g.dataset.hour = hour;

  const activeModel = state.isolatedModel ?? state.pinnedModel;
  const points = zone.points.filter(pt => rateMatches(pt, activeRate()));

  if (activeModel) {
    // One model selected: the fast/slow points aren't a meaningful 2D spread
    // any more (they're the *same* wind profile at two rates -- for single
    // deploy they're exactly collinear with the pad, for dual deploy very
    // close to it), so a filled hull would overstate the uncertainty. Draw
    // the pad->near->far bearing as a line instead, colored by the zone
    // (altitude or time, matching the non-isolated view), and only plot this
    // model's own points.
    const modelPoints = points.filter(p => p.model === activeModel);
    if (modelPoints.length > 0) {
      const [sx, sy] = ftToPx(0, 0); // the pad -- offset-aware, not DATA.site_px directly
      const sorted = [...modelPoints].sort((a, b) => {
        const da = a.x_ft ** 2 + a.y_ft ** 2;
        const db = b.x_ft ** 2 + b.y_ft ** 2;
        return da - db;
      });
      const line = document.createElementNS(ns, 'polyline');
      const linePts = [[sx, sy], ...sorted.map(p => ftToPx(p.x_ft, p.y_ft))];
      line.setAttribute('points', linePts.map(p => p.join(',')).join(' '));
      line.setAttribute('fill', 'none');
      line.setAttribute('stroke', color);
      line.setAttribute('stroke-width', 3);
      line.setAttribute('stroke-opacity', '0.85');
      g.appendChild(line);

      modelPoints.forEach(pt => drawPoint(g, pt, hour, zone.altitude, color));
    }
    svg.appendChild(g);
    return;
  }

  // Both hulls are recomputed from `points` -- the *currently visible*
  // (rate-filtered) set -- rather than zone.points/zone.core_hull_px (every
  // rate, baked server-side): isolating Fast or Slow should shrink the zone
  // to what that rate alone actually covers, not just hide dots inside an
  // unchanged both-rates outline. core_hull_px still seeds the initial
  // render before any filter is touched (same points, same result), so this
  // isn't a behavior change at the default "both rates" state.
  const buf = document.createElementNS(ns, 'polygon');
  buf.setAttribute('points', polyPoints(computeBufferHullPx(points, boostAngleDeg, zone.altitude)));
  buf.setAttribute('class', 'zone-buffer');
  buf.setAttribute('fill', color);
  buf.setAttribute('fill-opacity', '0.30');
  g.appendChild(buf);

  const corePx = convexHull(points.map(p => [p.x_ft, p.y_ft])).map(([x, y]) => ftToPx(x, y));
  const core = document.createElementNS(ns, 'polygon');
  core.setAttribute('points', polyPoints(corePx));
  core.setAttribute('class', 'zone-core');
  core.setAttribute('fill', color);
  core.setAttribute('fill-opacity', '0.42');
  core.setAttribute('stroke', color);
  core.setAttribute('stroke-opacity', '0.85');
  g.appendChild(core);

  points.forEach(pt => drawPoint(g, pt, hour, zone.altitude, MODEL_COLORS_HEX[pt.model] || '#21201c'));

  svg.appendChild(g);
}

// Only the durable, "what am I looking at" choices go in the URL -- not
// isolatedX (pure hover, cleared on mouseleave) or boostAngleDeg/padOffsetFt/
// the color pickers (personal display preferences already persisted via
// localStorage, not part of a shareable launch scenario). `date`/`hour`/
// `deploy` are further gated behind an explicit user action each -- see
// dateExplicitlyChosen/hourExplicitlyChosen/deployExplicitlyChosen's
// declarations for why.
function buildPermalinkParams(includeDate) {
  const p = new URLSearchParams();
  p.set('site', currentSiteId);
  if (includeDate && dateSelect.value) p.set('date', dateSelect.value);
  p.set('mode', state.mode);
  if (hourExplicitlyChosen) p.set('hour', state.hour);
  if (deployExplicitlyChosen) p.set('deploy', state.deploy);
  if (state.pinnedRate) p.set('rate', state.pinnedRate);
  if (state.mode === 'byAltitude' && state.pinnedAlt !== null) p.set('alt', state.pinnedAlt);
  if (state.mode === 'byTime') p.set('compare', state.compareAlt);
  return p;
}

function syncUrl() {
  if (!DATA) return;
  history.replaceState(null, '', `${location.pathname}?${buildPermalinkParams(dateExplicitlyChosen).toString()}`);
}

function render() {
  svg.innerHTML = '';
  renderedPoints = [];
  document.getElementById('accuracy-section').style.display = 'none'; // shown by renderAccuracyTable() in History mode only, when actuals exist

  // background covering the full pannable extent, then two geo-registered image
  // layers on top: a coarser wide-area satellite image for context when zoomed
  // out, and the sharper detail crop (Chandler Rd - TX 29) layered over it at
  // its true sub-position -- so zooming out reveals real imagery instead of a
  // flat background.
  const bg = document.createElementNS(ns, 'rect');
  bg.setAttribute('x', BASE_VB[0]); bg.setAttribute('y', BASE_VB[1]);
  bg.setAttribute('width', BASE_VB[2]); bg.setAttribute('height', BASE_VB[3]);
  bg.setAttribute('fill', 'var(--map-bg)');
  svg.appendChild(bg);

  // Map images are real files per site (site/maps/<site_id>/*_web.jpg), not
  // embedded data URIs -- lets the JS bundle stay a real JS file (no
  // megabyte-long base64 lines) and lets each site use its own imagery
  // instead of one hardcoded to Hutto's.
  const wideImgHref = `maps/${currentSiteId}/wide_sat_web.jpg`;
  const detailImgHref = `maps/${currentSiteId}/detail_sat_web.jpg`;

  const WIDE_VB = DATA.wide_view_box;
  const wideImage = document.createElementNS(ns, 'image');
  wideImage.setAttribute('href', wideImgHref);
  wideImage.setAttributeNS('http://www.w3.org/1999/xlink', 'href', wideImgHref);
  wideImage.setAttribute('x', WIDE_VB[0]); wideImage.setAttribute('y', WIDE_VB[1]);
  wideImage.setAttribute('width', WIDE_VB[2]); wideImage.setAttribute('height', WIDE_VB[3]);
  wideImage.setAttribute('preserveAspectRatio', 'none');
  svg.appendChild(wideImage);

  const image = document.createElementNS(ns, 'image');
  image.setAttribute('href', detailImgHref);
  image.setAttributeNS('http://www.w3.org/1999/xlink', 'href', detailImgHref);
  image.setAttribute('x', IMG_VB[0]); image.setAttribute('y', IMG_VB[1]);
  image.setAttribute('width', IMG_VB[2]); image.setAttribute('height', IMG_VB[3]);
  image.setAttribute('preserveAspectRatio', 'none');
  svg.appendChild(image);

  if (state.mode === 'byAltitude') {
    // one time of day, all 5 altitudes, colored by altitude
    const key = `${state.hour}_${state.deploy}`;
    const zones = DATA.data[key] || [];
    const ordered = [...zones].sort((a, b) => b.altitude - a.altitude);
    ordered.forEach(zone => drawZone(zone, ALT_COLORS_HEX[zone.altitude], state.hour));
  } else if (state.mode === 'byHistory') {
    renderHistory();
    renderAccuracyTable();
  } else {
    // "I'm flying to this altitude -- what time of day is best?": one fixed
    // altitude, all 4 times of day at once, colored by time instead.
    // Drawn latest-time-first so earlier times layer on top, matching the
    // by-altitude view's "smallest/most-relevant on top" convention.
    const orderedHours = [...DATA.hours].sort((a, b) => b - a);
    orderedHours.forEach(hour => {
      const key = `${hour}_${state.deploy}`;
      const zone = (DATA.data[key] || []).find(z => z.altitude === state.compareAlt);
      if (zone) drawZone(zone, TIME_COLORS_HEX[hour], hour);
    });
  }

  drawPadMarker();

  applyIsolation();
  setViewBox();
  updatePadReadout();
}

// Draggable launch pad -- see MAX_PAD_MOVE_FT/padOffsetFt above. A circle +
// crosshair (not just the text label) since it needs to actually grab-able,
// not just a landmark; drawn from ftToPx(0,0) so it always shows where the
// pad *currently* is, offset included.
function drawPadMarker() {
  const [sx, sy] = ftToPx(0, 0);
  const g = document.createElementNS(ns, 'g');
  g.setAttribute('class', 'pad-marker' + (padOffsetFt.x || padOffsetFt.y ? ' moved' : ''));

  const ring = document.createElementNS(ns, 'circle');
  ring.setAttribute('cx', sx); ring.setAttribute('cy', sy); ring.setAttribute('r', 12);
  g.appendChild(ring);
  const hLine = document.createElementNS(ns, 'line');
  hLine.setAttribute('x1', sx - 18); hLine.setAttribute('x2', sx + 18); hLine.setAttribute('y1', sy); hLine.setAttribute('y2', sy);
  g.appendChild(hLine);
  const vLine = document.createElementNS(ns, 'line');
  vLine.setAttribute('x1', sx); vLine.setAttribute('x2', sx); vLine.setAttribute('y1', sy - 18); vLine.setAttribute('y2', sy + 18);
  g.appendChild(vLine);

  const label = document.createElementNS(ns, 'text');
  label.setAttribute('x', sx + 22);
  label.setAttribute('y', sy + 8);
  label.setAttribute('class', 'pad-label');
  label.textContent = padOffsetFt.x || padOffsetFt.y ? 'Launch pad (moved)' : 'Launch pad';
  g.appendChild(label);

  g.addEventListener('pointerdown', evt => {
    evt.stopPropagation(); // don't also start a map-pan drag (see wrap's own pointerdown)
    g.setPointerCapture(evt.pointerId);
    draggingPad = true;
    padLastX = evt.clientX; padLastY = evt.clientY;
    wrap.classList.add('dragging-pad');
  });

  svg.appendChild(g);
}

function updatePadReadout() {
  const moved = padOffsetFt.x || padOffsetFt.y;
  padResetBtn.style.display = moved ? '' : 'none';
  if (moved) {
    const distFt = Math.hypot(padOffsetFt.x, padOffsetFt.y);
    // atan2(east, north), not atan2(north, east) -- compass bearing measures
    // clockwise from north, not the usual math-angle-from-x-axis convention.
    const bearingDeg = (Math.atan2(padOffsetFt.x, padOffsetFt.y) * 180 / Math.PI + 360) % 360;
    padReadout.textContent = `Pad moved ${distFt.toFixed(0)} ft ${compassDir(bearingDeg)} of surveyed position`;
  } else {
    padReadout.textContent = 'Pad at surveyed GPS position';
  }
}

const COMPASS_16 = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
function compassDir(deg) {
  return COMPASS_16[Math.round(deg / 22.5) % 16];
}

// Re-run everything that depends on DATA -- called once the first dataset
// loads, and again every time the launch-date <select> changes. hours/
// deploys/altitudes are fixed across every capture by construction (see
// config.SPLASH_HOURS_LOCAL etc.), so rebuilding these toggles per dataset is
// just cheap idempotent work, not dataset-specific logic.
function initFromData() {
  state = freshState();
  // Matches whatever DOM side effects the resolved mode needs (hour-toggle
  // disabled state, hint text, etc.) -- on a real user click this same logic
  // runs via setMode(), but the initial mode here can come from a permalink
  // (see freshState()) rather than always being the 'byAltitude' default.
  applyModeUI(state.mode);
  // Altitude count varies 5-9 per site (scaled to that site's own waiver --
  // see config.altitudes_for_site()), so the ramp is rebuilt against this
  // dataset's real list every time, not just when the picker changes.
  ALT_COLORS_HEX = computeSequentialRamp(zoneBaseColor, DATA.altitudes);
  BASE_VB = DATA.base_view_box;
  IMG_VB = DATA.image_view_box;
  view = { x: IMG_VB[0], y: IMG_VB[1], w: IMG_VB[2], h: IMG_VB[3] };
  MIN_SPAN = IMG_VB[2] * 0.15;
  MAX_SPAN = Math.max(BASE_VB[2], BASE_VB[3]) * 1.4;
  if (boostAngleDeg === null) boostAngleDeg = DATA.boost_angle_deg; // first load only -- see its declaration
  boostAngleSlider.value = boostAngleDeg;
  boostAngleReadout.textContent = `${boostAngleDeg}°`;

  buildToggle('mode-toggle', ['byAltitude', 'byTime', 'byHistory'], MODE_LABELS, 'mode', () => setMode(state.mode));
  buildToggle('hour-toggle', DATA.hours, HOUR_LABELS, 'hour', () => { hourExplicitlyChosen = true; });
  buildToggle('deploy-toggle', DATA.deploys, DEPLOY_LABELS, 'deploy', () => { deployExplicitlyChosen = true; });
  buildTimeLegend();
  buildAltList();
  buildModelLegend();
  buildRateLegend();
  render();
}

// --- launch-date selector: driven by data/manifest.json, never a server-side
// directory listing (this is a static site -- pulls happen out-of-band via
// pull_live_forecast.py + splash_zones.py, which regenerates this manifest
// every time it processes a target date) ---
const subtitleEl = document.getElementById('subtitle');
const dateSelect = document.getElementById('date-select');
let manifestEntries = [];

function describeEntry(entry) {
  const lead = entry.lead_days === 0 ? 'captured this morning' : `captured ${entry.capture_date} (T-${entry.lead_days})`;
  return `Target ${entry.target_date} &middot; ${lead} &middot; descent-only drift + boost-angle buffer, per model`;
}

async function loadDataset(entry) {
  subtitleEl.textContent = 'Loading…';
  const resp = await fetch(entry.data_path);
  DATA = await resp.json();
  // history_path is null for a target processed before this feature existed
  // (shouldn't happen post-2026-07-17, but handled rather than assumed) --
  // HISTORY just stays null and the History view mode shows its own
  // "nothing published yet" state (see renderHistory()) instead of erroring.
  HISTORY = entry.history_path ? await (await fetch(entry.history_path)).json() : null;
  initFromData();
  subtitleEl.innerHTML = describeEntry(entry);
}

dateSelect.addEventListener('change', () => {
  // A real user pick (this listener only fires on genuine interaction, not
  // the programmatic dateSelect.value assignments during bootstrap) -- from
  // here on the date is a deliberate choice worth keeping in the URL.
  dateExplicitlyChosen = true;
  const entry = manifestEntries.find(e => e.target_date === dateSelect.value);
  if (entry) loadDataset(entry);
});

// One-shot, like urlStateApplied -- a permalink's ?date= should only steer
// the very first manifest load. loadSiteManifest() runs again on every
// manual site switch afterward, and a stale target_date from the original
// link almost certainly doesn't exist in a different site's manifest anyway.
let urlDateApplied = false;

function loadSiteManifest(manifestPath) {
  fetch(manifestPath)
    .then(r => r.json())
    .then(manifest => {
      manifestEntries = manifest.launch_dates;
      if (manifestEntries.length === 0) {
        subtitleEl.textContent = `No processed launch dates found in ${manifestPath}.`;
        return;
      }
      dateSelect.innerHTML = '';
      manifestEntries.forEach(entry => {
        const opt = document.createElement('option');
        opt.value = entry.target_date;
        opt.textContent = entry.label;
        dateSelect.appendChild(opt);
      });
      let initialEntry = manifestEntries[0];
      if (!urlDateApplied) {
        urlDateApplied = true;
        const urlDate = URL_PARAMS.get('date');
        const found = urlDate && manifestEntries.find(e => e.target_date === urlDate);
        if (found) initialEntry = found;
      }
      dateSelect.value = initialEntry.target_date;
      loadDataset(initialEntry);
    })
    .catch(err => {
      subtitleEl.textContent = `Failed to load ${manifestPath} -- see console.`;
      console.error(err);
    });
}

// --- launch-site picker: a plain <select> over maps/regional/sites.json
// (built by fetch_site_maps.py --regional) -- was a clickable regional map
// with markers, replaced 2026-07-17 per user direction back to a simple
// dropdown. Still reads the same sites.json (name/club/has_data), just no
// longer needs its px/image_size_px marker-position fields. Only Hutto has
// a real pull_live_forecast.py/splash_zones.py pipeline run against it so
// far -- has_data per site comes from fetch_site_maps.py's
// refresh_regional_sites_metadata() (a real check against that site's
// manifest, not a hardcoded list); sites without one are still selectable
// but show an honest "no data yet" state rather than a broken fetch.
const siteEmptyState = document.getElementById('site-empty-state');
const mainLayout = document.getElementById('main-layout');
const siteDataControls = document.getElementById('site-data-controls');
const siteSelect = document.getElementById('site-select');

let regionalSites = null; // { sites: {id: {name, club, has_data, waiver_ft, ...}} }
let currentSiteId = 'hutto';

// "Seymour, TX (Rocket Ranch)" -> "Seymour" -- the descriptive long form is
// still used elsewhere (empty-state heading, marker tooltips historically),
// but the dropdown option pairs it with the club instead ("TNT - Seymour"),
// so the shorter place name reads better there.
function shortSiteName(name) {
  return name.split(',')[0];
}

// A site with no separate field/town name (e.g. SD Rocket Jockies -- the
// club name IS the site name, nothing more specific was ever given) would
// otherwise read as "SD Rocket Jockies - SD Rocket Jockies" everywhere this
// pairing is built; collapse to the single string when club and short-name
// are identical.
function siteLabel(site) {
  const short = shortSiteName(site.name);
  return short === site.club ? site.club : `${site.club} - ${short}`;
}

// Every site's manifest lives at the same path (data/<site_id>/manifest.json,
// written by splash_zones.py's regenerate_manifest()) -- has_data (computed
// by fetch_site_maps.py's refresh_regional_sites_metadata() from whether that
// file actually exists and is non-empty) is what decides whether to fetch it
// or show the empty state, not a hardcoded per-site path list.
function selectSite(siteId) {
  currentSiteId = siteId;
  siteSelect.value = siteId;
  padOffsetFt = { x: 0, y: 0 }; // a different site is a genuinely different GPS point, unlike a date switch
  const site = regionalSites.sites[siteId];

  if (site.has_data) {
    siteEmptyState.style.display = 'none';
    mainLayout.style.display = '';
    siteDataControls.style.display = 'contents';
    loadSiteManifest(`data/${siteId}/manifest.json`);
  } else {
    mainLayout.style.display = 'none';
    siteDataControls.style.display = 'none';
    siteEmptyState.style.display = '';
    siteEmptyState.innerHTML = `
      <p style="font-weight:600; margin: 0 0 6px;">${site.name}${site.name === site.club ? '' : ` (${site.club})`}</p>
      <p style="margin: 0;">No live forecast data pulled yet for this site.<br>
      Run <code>pull_live_forecast.py</code> + <code>splash_zones.py</code> for this site to populate this view.</p>`;
    subtitleEl.textContent = `${site.name} -- no data pulled yet`;
  }
}

siteSelect.addEventListener('change', () => selectSite(siteSelect.value));

fetch('maps/regional/sites.json')
  .then(r => r.json())
  .then(data => {
    regionalSites = data;
    const ids = Object.keys(data.sites).sort((a, b) => {
      const sa = data.sites[a], sb = data.sites[b];
      return sa.club.localeCompare(sb.club) || shortSiteName(sa.name).localeCompare(shortSiteName(sb.name));
    });
    siteSelect.innerHTML = '';
    ids.forEach(siteId => {
      const site = data.sites[siteId];
      const opt = document.createElement('option');
      opt.value = siteId;
      opt.textContent = siteLabel(site) + (site.has_data ? '' : ' (no data yet)');
      siteSelect.appendChild(opt);
    });
    // This whole fetch runs exactly once per page load (site switches call
    // selectSite() directly, not this again) -- no one-shot guard needed,
    // unlike the date param inside loadSiteManifest().
    const urlSite = URL_PARAMS.get('site');
    if (urlSite && data.sites[urlSite]) currentSiteId = urlSite;
    selectSite(currentSiteId);
  })
  .catch(err => {
    console.error('failed to load maps/regional/sites.json', err);
    loadSiteManifest('data/hutto/manifest.json');
  });
