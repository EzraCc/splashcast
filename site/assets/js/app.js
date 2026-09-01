// --- update check (see .github/workflows/pages.yml's asset-versioning step) ---
// GitHub Pages' Cache-Control (max-age=600, identical for every file --
// there's no per-path header control here) is short enough that a real
// reload picks up a new deploy on its own -- the actual mobile pain point is
// a backgrounded tab (or a home-screen-added PWA-like icon) coming back to
// the foreground straight from the OS/browser's own disk or bfcache, never
// touching the network at all, no matter how short max-age is. document.
// currentScript.src carries this deploy's ?v=<commit-sha> (empty during
// local dev, e.g. python -m http.server -- CURRENT_VERSION stays null and
// checkForUpdate() below just no-ops there, nothing to compare against).
// Reloading is safe UX-wise since it only ever fires right as a hidden tab
// becomes visible again (visibilitychange) or restores from bfcache
// (pageshow's persisted flag) -- never while someone's actively mid-interaction.
const CURRENT_VERSION = new URL(document.currentScript.src, location.href).searchParams.get('v');

// Same cache-busting as app.js/app.css's own ?v=<commit-sha> above, applied
// to every data fetch (manifest.json, and everything a manifest entry points
// at -- data_path/history_path/real_flight_paths) -- added after a real
// report that even a manual hard refresh kept serving a manifest.json from
// before a same-day deploy that added a second real_flight_paths entry.
// GitHub Pages' Cache-Control: max-age=600 was assumed short enough that any
// real reload would just pick up a new deploy on its own (see this file's
// very first comment) -- true for the HTML/JS/CSS a reload always re-fetches
// fresh, apparently not reliably true for a fetch() the running JS issues at
// runtime, whatever the exact browser/CDN mechanism. Tying the query string
// to CURRENT_VERSION means it changes on every deploy (data-only pushes
// redeploy too, see pages.yml's `on: push`) without needing `no-store`'s
// "never cache, even within the same deploy" cost. No-ops (returns the URL
// unchanged) during local dev, where CURRENT_VERSION is null.
function withVersion(url) {
  if (!CURRENT_VERSION) return url;
  return url + (url.includes('?') ? '&' : '?') + 'v=' + CURRENT_VERSION;
}

// Every data fetch (manifest.json and everything a manifest entry points at)
// goes through this instead of a bare fetch(withVersion(...)) -- in
// production withVersion()'s ?v=<sha> already does the real cache-busting
// (a new deploy is a new URL), so this is a plain passthrough there. Locally
// CURRENT_VERSION is null (see withVersion()'s own comment) and the URL
// never changes, so the browser's default heuristic caching can serve a
// splash_zones/manifest/points_history response from well before the last
// pipeline run indefinitely -- confirmed directly: python -m http.server
// sends Last-Modified but no Cache-Control, and DOES honor a conditional
// If-Modified-Since with a real 304 when the file is unchanged. `cache:
// 'no-cache'` (NOT 'no-store') asks the browser to always send that
// conditional request rather than trusting its own heuristic freshness
// window -- a cheap 304/headers-only round trip on every load when nothing
// changed, a real re-fetch the moment a cron/local pipeline run rewrites the
// file, and no unconditional full re-download the way tying this to
// Date.now() (writeLocalBustedTag()'s approach for app.js/app.css, chosen
// there because those need to reflect an in-progress local edit instantly)
// would cause for these -- deliberately not applied to app.js/app.css.
function fetchData(url) {
  return fetch(withVersion(url), CURRENT_VERSION ? undefined : { cache: 'no-cache' });
}

async function checkForUpdate() {
  if (!CURRENT_VERSION) return;
  try {
    const resp = await fetch(`version.json?_=${Date.now()}`, { cache: 'no-store' });
    const { version } = await resp.json();
    if (version && version !== CURRENT_VERSION) location.reload();
  } catch {
    // Offline, or version.json not deployed yet on a brand-new site -- no
    // harm done, the next visibility/pageshow event just tries again.
  }
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') checkForUpdate();
});
window.addEventListener('pageshow', evt => { if (evt.persisted) checkForUpdate(); });

let DATA = null;
// The relative path DATA was last fetched from (entry.data_path, set in
// loadDataset()) -- kept around so openAscentSimModal() can resolve it to
// an absolute, publicly-fetchable URL to hand to the rocketry embed. Not
// derivable from DATA itself (the JSON has no self-referential path field).
let CURRENT_DATA_PATH = null;
// points_history.json for the current target date -- every capture's splash
// point per hour/deploy/rate/altitude, for the "History" view mode (see
// renderHistory()). Loaded alongside DATA; null if this target has no
// history file yet (a target processed before this feature existed).
let HISTORY = null;

// Real GPS-tracked flights' summaries (see analyze_real_flight.py), for the
// same target date -- empty for almost every target, since this only exists
// where someone's fed in real tracker data. Usually 0 or 1 entries, but a
// site can fly more than one rocket the same day. Reset (with
// pinnedRealFlightIndex/hoveredRealFlightIndex) on every dataset load in
// loadDataset(), same as HISTORY.
let REAL_FLIGHTS = [];
// Which REAL_FLIGHTS entry is click-pinned/mouse-hovered right now -- null
// when neither. Kept separate (not one combined "active" flag) because a
// pin on one flight and a hover over a different flight's marker can be
// true at the same time; activeRealFlight() below resolves which one wins
// (hover takes precedence while it lasts, same pattern as
// state.isolatedHour ?? state.pinnedHour elsewhere in this file).
let pinnedRealFlightIndex = null;
let hoveredRealFlightIndex = null;
// The pad offset in effect right before pinning a real flight snapped it to
// the rail -- null whenever nothing's snapped. Restored on a normal close
// (unpin via the marker itself, or the click-away listener) so exploring one
// real flight doesn't strand the pad there once you're done looking; NOT
// restored if the pad itself gets dragged by hand while pinned (see the
// pad-drag handler) -- that drag already expresses where the user wants the
// pad, so there's nothing to revert. Only ever set on the *first* snap in a
// pin/switch/pin sequence (see drawRealFlightMarker()'s click handler) --
// switching the pin between two different flights re-snaps the pad without
// clobbering the original pre-snap position underneath.
let padOffsetBeforeRealFlightSnap = null;
// Current render's "Final projection" (current rate) star. Per-flight
// overlay -- "predicted landing" (its own real apogee/rates) star, real
// launch-rail marker, and real (or, for a no-GPS flight, estimated -- see
// apogee.position_source) apogee marker -- describes whichever flight
// activeRealFlight() currently resolves to; rebuilt by
// updateActiveRealFlightOverlay() rather than repositioned in place, since a
// 'target'-shape marker is a multi-element group. Re-set every
// renderHistory() call, referenced by setRealFlightComparing() to swap which
// ones are visible without a full re-render on every hover.
let projectionStarEl = null;
let predictedLandingStarEl = null;
let launchRailEl = null;
let apogeeMarkerEl = null;
// SVG-space [x, y] pairs for the overlay elements above (rail, predicted
// landing, apogee) -- kept alongside them so each landing marker's
// avoidPoints() (drawRealFlightMarker()) can find fresh screen positions for
// whichever flight is currently active without recomputing them itself.
let activeOverlaySvgPoints = [];

// Resolves which REAL_FLIGHTS entry (if any) the shared comparison overlay
// (rail/predicted-landing/apogee markers + info box) currently describes.
function activeRealFlight() {
  const idx = hoveredRealFlightIndex ?? pinnedRealFlightIndex;
  return idx === null ? null : REAL_FLIGHTS[idx];
}

// No single fixed hue reads well against every site: violet (the original
// ramp) washed out against Hearne's dark tree cover, and rose/magenta (the
// next attempt) faded into Hutto's light tan dirt -- satellite terrain swings
// across too much of the hue wheel (greens, browns/tans, yellows, all
// season-dependent) for one hardcoded choice to survive every site/season
// combination. So the hue is a user pick (see zoneColorPicker below);
// computeAltRamp() derives the altitude shades from it by walking lightness
// in OKLab (monotone, one hue, gamut-clamped chroma at the extremes).
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
// step count directly (not a fixed 5) since altitude lists vary in length
// per site (1,000ft up to that site's own waiver, 5-9 points): a site with 8
// altitudes needs 8 shades, not a lookup into a 5-entry table.
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
// Same user-adjustable treatment as the altitude ramp -- a fixed hue can't
// read well against every site's imagery any more here than for the zone fill.
const DEFAULT_TIME_BASE_COLOR = '#eb6834';
const TIME_COLOR_STORAGE_KEY = 'splashcast_time_base_color';
let timeBaseColor = localStorage.getItem(TIME_COLOR_STORAGE_KEY) || DEFAULT_TIME_BASE_COLOR;
// Placeholder only -- DATA isn't loaded yet at module-eval time (see DATA's
// own declaration below), so this can't read the real DATA.hours checkpoint
// list. initFromData() rebuilds this against that capture's own real hours
// on every load (same ALT_COLORS_HEX/DATA.altitudes pattern), which is the
// only version that actually matters -- this literal only exists so nothing
// reads `undefined` in the brief window before the first dataset loads.
let TIME_COLORS_HEX = computeSequentialRamp(timeBaseColor, [9, 11, 13, 15, 17]);

// Satellite vs. road/street map layer -- some sites (e.g. Hutto) have no real
// terrain features to avoid, where satellite imagery is closer to visual
// noise than useful signal; road tiles (fetch_site_maps.py's World_Street_Map
// pull, same bounds/zoom as its satellite sibling) are the alternative.
// Persisted across reloads/sites like the color pickers (so it stays put on a
// plain revisit), but also part of the permalink (?layer=sat|road, see
// buildPermalinkParams()) so a shared link can force a specific layer even
// if the recipient's own stored preference differs -- unlike the color
// pickers, this is something a club might want to standardize in a shared
// link (e.g. "road" for a site with no real terrain to avoid).
const MAP_LAYER_STORAGE_KEY = 'splashcast_map_layer';
function initialMapLayer() {
  const urlLayer = new URLSearchParams(location.search).get('layer');
  if (urlLayer === 'sat' || urlLayer === 'road') return urlLayer;
  return localStorage.getItem(MAP_LAYER_STORAGE_KEY) === 'road' ? 'road' : 'sat';
}
let mapLayer = initialMapLayer();
const DEPLOY_LABELS = { single: 'Single', dual: 'Dual' };
// Key order matches MODEL_LEGEND_ORDER below (published forecast horizon,
// longest first) -- one canonical model order shared by every model-keyed
// object/list on this page instead of each picking its own.
const MODEL_LABELS = { gfs: 'GFS', ecmwf: 'ECMWF', gem: 'GEM', icon: 'ICON', arpege: 'ARPEGE', hrrr: 'HRRR' };
// "History" not "Drift" -- Driftcast (the tool this project extends) already
// owns that word for the wind-drift calc itself; reusing it here would be
// confusing even though it'd otherwise fit.
const MODE_LABELS = { byAltitude: 'By altitude', byTime: 'By time of day', byHistory: 'History' };
// Reference categorical palette in its validated fixed order, minus the two
// hues claimed by the zone fills (orange=time, magenta/rose=altitude). ECMWF
// sits at the "violet" slot (#4a3aa7, altitude's old color before its ramp
// moved to magenta/rose) rather than the categorical "magenta" slot, to stay
// out of the altitude ramp's hue. HRRR (green) and ARPEGE (aqua) are still in
// the same terrain-risky green family the altitude ramp moved away from --
// a likely follow-up, lower priority since small outlined point markers are
// far more forgiving than a big fill. CVD separation on the current 6-hex
// set lands in the 6-8 floor band for the weakest pair, legal only with
// secondary encoding, which this page already has (model name in every
// tooltip, text-labeled legend, white/dark stroke outline on every marker).
const MODEL_COLORS_HEX = {
  gfs: '#2a78d6', ecmwf: '#4a3aa7', gem: '#e34948',
  icon: '#eda100', arpege: '#1baf7a', hrrr: '#008300',
};
// A tooltip's model name, colored to match that same model's own bar/point
// color everywhere else on the page -- per direction, every tooltip used to
// bold the name in the shared --accent blue regardless of which model it
// was (.tooltip b's own default), disconnected from the actual colored bar
// sitting right next to it in the same tooltip. Inline style, not a class,
// since the color is per-model data, not a themeable design token.
function modelNameHTML(m) {
  // 'actual' isn't a real model (the T+1 HRRR-analysis path, 3D History) --
  // special-cased rather than added to MODEL_COLORS_HEX/MODEL_LABELS
  // themselves, since both of those ARE iterated elsewhere as "every real
  // model" (CLOUD_MODELS, the ?models= URL validator) and a bogus 'actual'
  // entry would leak into both. PROJECTION_MARKER_COLOR matches the same
  // concept's own color in the 2D History star/legend.
  if (m === 'actual') return `<b style="color:${PROJECTION_MARKER_COLOR}">Actual (HRRR analysis)</b>`;
  return `<b style="color:${MODEL_COLORS_HEX[m] || 'var(--accent)'}">${MODEL_LABELS[m] || m.toUpperCase()}</b>`;
}
// Longest published forecast horizon first, shortest last (GFS 16 days,
// ECMWF 15, GEM 10, ICON 7.5, ARPEGE 4, HRRR ~2) -- matches the dropout
// order actually observed across T-1/T-3/T-5/T-7 captures (HRRR first, then
// ARPEGE, GFS/ECMWF/ICON/GEM still present at T-7). This is the canonical
// model order for the whole page, not just the legend -- MODEL_LABELS,
// MODEL_COLORS_HEX, MODEL_SHAPES, and config.py's LIVE_PROFILE_MODELS all
// mirror it, so there's one order to reason about instead of five different
// ones that happen to disagree. buildModelLegend() clusters the
// still-contributing models at the top and the dropped-out ones at the
// bottom (see modelsWithData()) using this same sequence.
const MODEL_LEGEND_ORDER = ['gfs', 'ecmwf', 'gem', 'icon', 'arpege', 'hrrr'];

// Model identity is color (MODEL_COLORS_HEX -- colored dots read better than
// a black/shape-only marker) AND shape, redundantly, everywhere a model's
// own point is drawn (byAltitude/byTime's drawPoint(), History's
// renderHistory(), the 3D view's landing-point markers) -- shape is the
// colorblind-safe fallback so identity never depends on color perception
// alone. Originally History-only, since byAltitude/byTime used to spend
// shape on Fast/Slow instead (two points per model, not one); duplicated
// everywhere else once that stopped being true (see buildRateEditor()'s own
// comment) rather than leaving color as the only channel outside History.
// "star" is deliberately not assigned to any model -- reserved for the
// actual-landing marker (see renderHistory()) so it's never ambiguous with
// a model's projection.
// icon is 'x', not 'diamond' -- a diamond is still fundamentally a rotated
// square, and read as one next to ECMWF's actual square (both "a square,
// just different sizes" per direction) despite being a genuinely different
// model. 'x' shares no silhouette family with 'square' at all.
const MODEL_SHAPES = { gfs: 'circle', ecmwf: 'square', gem: 'triangle-up', icon: 'x', arpege: 'triangle-down', hrrr: 'plus' };
// Not a real model -- the T+1 HRRR-analysis "actual" path (3D History,
// historyActualPathForAltitude()) reuses path3dDrawPath()'s own per-model
// shape/color lookup rather than a separate code path, so it needs an
// entry here too. Star, matching the same shape the 2D History star
// (PROJECTION_MARKER_COLOR) already uses for this exact concept. Safe to
// add here specifically -- unlike MODEL_COLORS_HEX/MODEL_LABELS, this dict
// is never iterated as "the list of every real model" (only ever indexed
// by a single already-known key), confirmed directly before adding this.
MODEL_SHAPES.actual = 'star';
// A circle radius=size / square half-width=size / triangle circumradius=
// size / diamond circumradius=size / plus-or-x arm-reach=size don't come
// out to the same visual area at the same `size` (a square is ~4x a
// plus's area, a diamond ~2x a triangle's) -- confirmed as the real cause
// behind "icon and ecmwf are both squares of different sizes" (diamond
// read smaller than square even though both used the same `size`).
// Applied once at each shape-drawer's own entry point (drawMarker(),
// shapeSwatchSVG(), descent3d.js's path3dShapePath()) rather than baked
// into shapePolygonPoints() itself, which stays pure geometry. Tuned by
// eye against a circle (left unscaled, at 1) as the baseline -- not derived
// from an exact area-matching formula, since "reads as roughly the same
// size" is the actual goal, not identical pixel area.
const SHAPE_SIZE_MULT = { square: 0.82, 'triangle-up': 1.35, 'triangle-down': 1.35, diamond: 1.15, plus: 1.35, x: 1.35 };
// Whether `fps` (a {drogue,main} pair) exactly matches one of the two named
// presets -- used to keep state.rateName truthful any time rateFps changes
// by a path other than clicking a preset button directly (a permalink's
// rates=, or DATA reloading on a site/date switch). null means "a custom
// pair, matches neither" -- not an error case, just loses the preset
// highlight and falls back to 'fast' for History's precomputed lookup (see
// historyPointsForAltitude()'s comment).
function rateNameMatching(fps) {
  for (const name of ['fast', 'slow']) {
    const p = DATA.descent_params.default_rates_fps[name];
    if (p.drogue === fps.drogue && p.main === fps.main) return name;
  }
  return null;
}

// Populated by initFromData() once the selected launch date's JSON has
// loaded -- DATA starts null since data now comes from fetch(), not an
// embedded blob (see the launch-date <select> / manifest.json loading below).
let state = null;

// Deliberately NOT part of `state` / freshState() -- state resets on every
// date/site switch by design (see initFromData()), but a rail angle the
// user dialed in is a standing preference about how they want the apogee
// shift drawn, not a "which zone am I looking at" selection, so it should
// survive switching dates the way currentSiteId does. null until the first
// dataset loads, then initialized to 0 (the magnitude only -- heading is
// handled separately below) and left alone by every subsequent switch --
// see initFromData()'s own comment on why 0, not a nonzero seed. Same
// standing-preference treatment the old single boostAngleDeg control had;
// this replaces it (see railShiftFt()'s own comment for the redesign this
// is part of -- a directional apogee shift instead of an omnidirectional
// buffer band).
let railAngleDeg = null;
// UNLIKE railAngleDeg above, this is NOT a cached/resolved value -- it's
// the user's own explicit override ONLY, null whenever they haven't
// touched the compass dial (or arrived via a link with no ?railheading=).
// Per direction, the un-chosen default should live-track the current
// ground wind direction (recomputed every render, not cached and
// invalidated) rather than being resolved once like railAngleDeg's
// magnitude -- see effectiveRailHeadingDeg().
let railHeadingDeg = null;

// Permalink support: site/date/mode/hour/deploy/rate/alt/compare read from
// the URL on first load, written back out on every render so a bookmark or a
// pasted link reproduces "what you were looking at" -- no login/accounts,
// just the querystring. Read once into a snapshot rather than re-reading
// location.search live -- freshState() consumes it exactly once (see
// urlStateApplied) so a later manual site/mode switch starts from real
// defaults, not a stale URL value from whatever page load first parsed.
const URL_PARAMS = new URLSearchParams(location.search);
let urlStateApplied = false;

// The launch date is deliberately NOT live-synced into the URL by default --
// a target date is inherently perishable (today's "latest" becomes stale the
// moment a newer capture is pulled), so a plain bookmark or a long-lived tab
// should keep tracking "whatever's current" rather than freeze on whatever
// date happened to be selected at the time. Date only gets written in once
// the user does one of two explicit things: picks a date from the dropdown
// themselves (see dateSelect's 'change' handler), or clicks "Copy link" (an
// unambiguous "give me a durable link to exactly this" ask) -- or if they
// arrived via a link that already had ?date= on it, which is itself evidence
// someone already did one of those two things.
let dateExplicitlyChosen = URL_PARAMS.has('date');

// Hour and deploy get the same treatment: their *default* is a fixed
// constant (DATA.hours[0]/DATA.deploys[0]) rather than a moving target like
// "latest date" is, so there's no staleness risk in leaving them out -- but a
// plain click around the map shouldn't start pinning "9am" or "Dual" into
// the address bar either, only a deliberate toggle click should (see the
// hour-toggle/deploy-toggle onChange callbacks in initFromData()). Unlike
// date, Copy Link does NOT force these in -- their default reproduces
// identically on any later visit, so there's nothing for it to protect
// against by forcing them.
let hourExplicitlyChosen = URL_PARAMS.has('t') || URL_PARAMS.has('hour');
let deployExplicitlyChosen = URL_PARAMS.has('deploy');
// Same treatment as hour/deploy above -- railAngleDeg's default (10°,
// below) reproduces identically on any later visit, so it only goes in the
// URL once the dial's magnitude has actually been touched (initFromData()'s
// own read of this flag) or arrived via a link that already had ?railangle=
// on it. Heading gets its own, separate flag -- its default isn't a fixed
// constant like the magnitude's, it live-tracks the current ground wind
// (see railHeadingDeg's own declaration), so it needs to distinguish "no
// heading chosen yet, keep tracking wind" from "user picked a heading" the
// same way, just independently of the magnitude.
let railAngleExplicitlyChosen = URL_PARAMS.has('railangle');
let railHeadingExplicitlyChosen = URL_PARAMS.has('railheading');
// pad needs SITE_GEOMETRY.site_lat/site_lon (to convert the URL's GPS
// coordinate back to a ft offset) which isn't available until
// loadSiteManifest()'s manifest fetch resolves, so unlike the flags above
// this can't just be read into a plain boolean here -- applied once, gated
// by this same sentinel, right where MAX_PAD_MOVE_FT is set (see
// initFromData()).
let padUrlApplied = false;

function freshState() {
  const base = {
    mode: 'byAltitude',
    // Minutes since midnight, not an hour int -- the time slider (see
    // addWeatherHeaderRow()) can land anywhere in 15-min steps, not just on
    // DATA.hours' own checkpoints. Defaults to the first (earliest) hour the
    // weather panel shows.
    timeMinutes: DATA.hours[0] * 60, deploy: DATA.deploys[0],
    isolatedHour: null, pinnedHour: null,
    // Multi-select checkboxes, not hover-isolate/click-pin -- byAltitude
    // mode's own ladder got this treatment 2026-08, mirroring
    // buildModelLegend()'s existing pattern exactly (see that function's own
    // comment): click toggles one altitude's zone on/off, double-click
    // solos it. null is a sentinel ("not resolved yet"), not "nothing
    // selected" -- buildAltList() resolves it to every altitude with a real
    // zone the first time it runs for this state, same as selectedModels.
    // byTime/byHistory don't use this at all -- they keep the single-select
    // compareAlt below, since those views render exactly one altitude at a
    // time, not several simultaneous zones.
    selectedAlts: null,
    // Snapshot of selectedAlts from right before a double-click solo -- see
    // selectedModels/preSoloModels' own comment, same mechanism.
    preSoloAlts: null,
    // Multi-select checkboxes, not hover-isolate/click-pin like every other
    // legend here -- see buildModelLegend()'s own comment for why models
    // specifically got this treatment. null is a sentinel ("not resolved
    // yet"), not "no models selected" -- buildModelLegend() resolves it to
    // every model with real data the first time it runs for this state.
    selectedModels: null,
    // Snapshot of selectedModels from right before a double-click solo, so a
    // second double-click on that same (now-soloed) model can undo it --
    // null whenever there's nothing to undo (no solo in effect, or it's
    // since been superseded by a plain click). See buildModelLegend()'s
    // dblclick handler.
    preSoloModels: null,
    isolatedCapture: null, pinnedCapture: null, // History mode only -- which capture_date ("forecast age") to isolate
    compareAlt: DATA.altitudes[0], // which altitude "by time of day"/History compares across hours/captures
    // Direct-entry altitude (see syncAltCustomUI()) -- null unless the
    // map-anchored readout's "Specific altitude" field is active. A real ft
    // value, not restricted to DATA.altitudes, since zoneFor() can simulate
    // any altitude now that the drift calc is client-side. Overrides the
    // whole ladder/selectedAlts selection above in byAltitude/byTime (see
    // render()).
    customAlt: null,
    // Editable drogue+main fps -- ONE active pair now, not a simultaneously-
    // computed fast/slow pair (see buildRateEditor()'s own comment for why:
    // per direction, matching descent3d.js's existing single-active-rate
    // pattern instead of every 2D zone doubling into two rate-labeled point
    // sets). Changes which points exist, not just how they're drawn, so it
    // lives here rather than as a standing "what-if" global like
    // railAngleDeg. structuredClone, not a plain reference --
    // DATA.descent_params.default_rates_fps must never be mutated (the Fast/
    // Slow preset buttons reset back to it, and rateName's divergence check
    // below compares against it).
    rateFps: structuredClone(DATA.descent_params.default_rates_fps.fast),
    // Tracks whether rateFps currently matches a named preset exactly --
    // 'fast'/'slow' right after clicking that preset button, null once the
    // user hand-edits a number away from it. Purely a UI/lookup concern (used
    // for the preset buttons' own active-highlight and to pick which of the
    // server's two precomputed History buckets to read -- see
    // historyPointsForAltitude()'s comment); the live simulation everywhere
    // else always reads rateFps directly, never this name.
    rateName: 'fast',
  };
  if (!urlStateApplied) {
    urlStateApplied = true;
    const mode = URL_PARAMS.get('mode');
    if (['byAltitude', 'byTime', 'byHistory'].includes(mode)) base.mode = mode;
    // ?t=HH:MM (new) preferred over the legacy ?hour=N int -- a link built
    // before the time slider shipped still loads at the right hour (as
    // N*60), just without the fractional precision a newer link can carry.
    const profileHours = sliderRealHours();
    const tMinutes = parseTimeParam(URL_PARAMS.get('t'));
    if (tMinutes !== null && tMinutes >= profileHours[0] * 60 && tMinutes <= profileHours[profileHours.length - 1] * 60) {
      base.timeMinutes = tMinutes;
    } else {
      const hour = Number(URL_PARAMS.get('hour'));
      if (DATA.hours.includes(hour)) base.timeMinutes = hour * 60;
    }
    const deploy = URL_PARAMS.get('deploy');
    if (DATA.deploys.includes(deploy)) base.deploy = deploy;
    const rate = URL_PARAMS.get('rate');
    if (rate === 'fast' || rate === 'slow') {
      base.rateName = rate;
      base.rateFps = structuredClone(DATA.descent_params.default_rates_fps[rate]);
    }
    // alts=<comma-separated ft values> -- byAltitude's new multi-select
    // ladder (2026-08), same validated-Set shape/convention as models=
    // below. Legacy alt=<ft> (the old single pinned value, from before this
    // was a Set) still works too, read-only -- never written by
    // buildPermalinkParams() any more, but an old shared link still
    // resolves sensibly ("select only this one"), same backward-compat
    // precedent this app already has for hour=N vs. t=HH:MM. alts= wins if
    // a URL somehow carries both.
    const altsParam = URL_PARAMS.get('alts');
    if (altsParam) {
      const requested = new Set(altsParam.split(',').map(Number).filter(a => DATA.altitudes.includes(a)));
      if (requested.size) base.selectedAlts = requested;
    } else {
      const legacyAlt = Number(URL_PARAMS.get('alt'));
      if (DATA.altitudes.includes(legacyAlt)) base.selectedAlts = new Set([legacyAlt]);
    }
    // models=<comma-separated keys> -- validated against MODEL_LABELS only,
    // not against "has data" (that's context-dependent -- byAltitude vs
    // History read different availability sources, and horizon/capture can
    // change which models actually have data anyway); buildModelLegend()
    // re-validates against real availability every time it resolves this.
    const modelsParam = URL_PARAMS.get('models');
    if (modelsParam) {
      const requested = new Set(modelsParam.split(',').filter(m => Object.keys(MODEL_LABELS).includes(m)));
      if (requested.size) base.selectedModels = requested;
    }
    const compare = Number(URL_PARAMS.get('compare'));
    if (DATA.altitudes.includes(compare)) base.compareAlt = compare;
    const capture = URL_PARAMS.get('capture');
    if (HISTORY && HISTORY.captures.includes(capture)) base.pinnedCapture = capture;
    // customalt=<ft> -- real value, not restricted to DATA.altitudes (that's
    // the whole point of it), just bounded to (0, site waiver].
    const customAlt = Number(URL_PARAMS.get('customalt'));
    if (Number.isFinite(customAlt) && customAlt > 0 && customAlt <= DATA.altitudes[DATA.altitudes.length - 1]) {
      base.customAlt = Math.round(customAlt);
    }
    // rates=<drogue>/<main> -- one pair now, not fast+slow -- defensive like
    // every other param here: a malformed value is ignored (falls back to
    // whatever `rate`/the default already set above), and every surviving
    // number gets clamped into rate_limits_fps (a hand-edited URL could carry
    // anything). Overrides `rate=fast|slow` above when both are present --
    // an explicit fps pair is more specific than a preset name.
    const ratesParam = URL_PARAMS.get('rates');
    if (ratesParam) {
      const limits = DATA.descent_params.rate_limits_fps;
      const clamp = (part, v) => Math.min(limits[part][1], Math.max(limits[part][0], v));
      const m = ratesParam.match(/^(\d+(?:\.\d+)?)\/(\d+(?:\.\d+)?)$/);
      if (m) {
        base.rateFps = { drogue: clamp('drogue', Number(m[1])), main: clamp('main', Number(m[2])) };
        // Only counts as a named preset if it lands exactly on one -- same
        // divergence check the rate-editor's own inputs apply on every edit.
        base.rateName = rateNameMatching(base.rateFps);
      }
    }
  }
  return base;
}

// Same DOM side effects setMode() applies on a real user click, extracted so
// initFromData() can apply them for whatever mode the URL/default resolved
// to on first load too -- without also running setMode()'s pin-clearing
// (which would stomp the selectedAlts a permalink just supplied).
function applyModeUI(mode) {
  // The time slider lives inside #weather-panel now (see
  // addWeatherHeaderRow()), not a standalone #hour-toggle -- same disabled-
  // in-byTime-mode treatment (byTime shows every DATA.hours zone at once and
  // ignores state.timeMinutes for its own zone selection), just scoped to
  // the panel via a descendant selector (app.css) instead of a dedicated
  // toggle-group div.
  document.getElementById('weather-panel').classList.toggle('hours-disabled', mode === 'byTime');
  document.getElementById('time-legend-block').style.display = (mode === 'byTime' || mode === 'byHistory') ? '' : 'none';
  document.getElementById('time-legend-title').textContent = mode === 'byHistory' ? 'Forecast age' : 'Time of day';
  document.getElementById('time-color-controls').style.display = mode === 'byHistory' ? 'none' : '';
  document.getElementById('alt-hint').textContent =
    mode === 'byTime' ? 'Click an altitude to compare it across all times of day. Map colors now show time of day, not altitude.'
    : mode === 'byHistory' ? 'Click an altitude to see how each model\'s point for it moved across capture dates. Or use "Specific altitude" below to see that instead -- the forecast-age markers simulate just like the map does, though the star (final projection) only ever shows at one of the altitudes listed here.'
    // No hover any more (2026-08) -- click an altitude to toggle its zone
    // on/off, like a checkbox; double-click to solo/revert, same rules as
    // the Model legend below. Reported directly: this branch was still
    // describing the OLD hover-isolate/click-pin design, overwriting the
    // correct static text index.html sets by default -- this runtime
    // version (applyModeUI() runs on every mode switch and on load) is the
    // one that actually reaches the page, so it's the one that has to be
    // right.
    : 'Click an altitude to toggle it on/off, like a checkbox -- all start selected. Double-click to solo just that one; double-click it again to bring back whatever was selected before. Or click the readout above the slider and type an exact predicted apogee instead of picking from the ladder; clear the field (or the × button) to go back. No single color reads well on every site\'s imagery -- pick one above that stands out here; shades for each altitude are generated from it.';
  document.getElementById('time-hint').textContent = mode === 'byHistory'
    ? 'Each row is one capture date -- swatch shade shows how many days before launch it was pulled (lighter = further out, darker = closer to launch). Hover to isolate just that capture (map + accuracy table); click to pin, click again to release.'
    : 'Hover a time to isolate it. Click to pin; click again to release.';
  document.getElementById('model-hint').textContent = mode === 'byHistory'
    ? 'Color and shape both mean model here (same colors as the main map) -- shape is the colorblind-safe backup. Click a model to toggle it on/off; double-click to solo just that one, double-click it again to bring back whatever was selected before.'
    : 'Click a model to toggle it on/off, like a checkbox -- all start selected. Double-click to solo just that one (zones collapse to a pad-to-point bearing line when only one model is selected, since a single point isn\'t a meaningful area); double-click it again to bring back whatever was selected before.';
  updateRateHint();
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

// Extracted from the #deploy-toggle buildToggle() call below (2026-08) so
// it's also reusable from applyDeployMode() -- rocketry's own real
// descent-device data (see that function's own comment) needs to trigger
// the exact same follow-up as a manual Single/Dual click, not a
// re-implementation of it.
function onDeployChanged() {
  deployExplicitlyChosen = true;
  // Which altitudes have a real zone changes with deploy (single-deploy
  // drops above SINGLE_DEPLOY_MAX_ALT_FT pipeline-side) -- refresh the row
  // list's unavailable rows/selectedAlts revalidation.
  buildAltList();
  // Single deploy's phase construction (zoneFor()) never reads the drogue
  // rate at all -- disable those inputs rather than leave them editable
  // and silently ignored.
  buildRateEditor();
  syncAltCustomUI(); // single/dual changes whether the custom altitude has a zone at all
}
// Same effect as clicking the Single/Dual toggle directly (state + the
// toggle's own active-highlight + onDeployChanged()'s follow-up), for use
// from code instead of a real click -- applyDescentDevices() below is the
// only caller today. No-op if already on that mode (rocketry's descent
// devices reflect the currently-active rocket, so a repeat sim result for
// the same rocket shouldn't visibly re-flash the toggle).
function applyDeployMode(mode) {
  if (state.deploy === mode) return;
  state.deploy = mode;
  buildToggle('deploy-toggle', DATA.deploys, DEPLOY_LABELS, 'deploy', onDeployChanged);
  onDeployChanged();
}

// Real, computed drogue/main descent rates from the currently-simulated
// rocket's actual recovery hardware (rocketry's `descentDevices`, added
// 2026-08 -- `rocketry/tmp/splashcast-caching-update.md`'s "descentDevices"
// section) -- terminal-velocity physics against that rocket's real
// descending mass, not a stub. Requested directly: "are we getting descent
// rates from rocketry... and adjusting them... to affect the landing
// zone?" -- this is that wiring. Pre-fills state.rateFps/state.deploy the
// same way clicking Fast/Slow or Single/Dual would (one-time seed, not a
// live override tied to ASCENT_RESULTS -- unlike apogee altitude, a
// descent rate is normal user-editable state elsewhere in this app, so it
// should behave like any other edit: stays put after the visitor closes
// the ascent panel, and remains hand-editable afterward same as always).
// `deployAltitudeM` is always null in the real contract right now (RockSim
// .rkt has no field for it at all) -- DATA.descent_params.main_deploy_altitude_ft
// (the site's own generic pipeline constant, read-only in this UI) is
// deliberately left untouched; per direction, a visitor who wants a
// different value has no in-app way to change it today ("they'll have to
// manually fix it or fix their sim file").
//
// Exactly one device -> single-stage (one canopy the whole way), applied
// to `main` -- a device's own `role` ("drogue"/"main") already tells
// rocketry's real recovery hardware apart (smaller device = drogue, larger
// = main, physically, which is what that role assignment reflects), not
// something this function re-derives from size. Two devices -> dual,
// mapped by role directly. Anything else (3+ devices, or a role missing
// from a 2-device set) is left alone rather than guessed at.
function applyDescentDevices(descentDevices) {
  if (!descentDevices || !descentDevices.length) return;
  const limits = DATA.descent_params.rate_limits_fps;
  // Same integer-fps/clamp/Tripoli-35fps-warning treatment the rate
  // editor's own manual-edit handler applies -- a real rocket's real
  // computed rate deserves the identical scrutiny a hand-typed one gets,
  // not a silent bypass. mainOverLimit tracked separately and applied via
  // showRateWarning() AFTER buildRateEditor() below, not before --
  // buildRateEditor() unconditionally resets the warning banner to hidden
  // as part of its own rebuild (see its own comment), so calling
  // showRateWarning() before it would just get immediately clobbered
  // (confirmed directly: a real over-limit rate silently showed no
  // warning at all until this ordering fix).
  let mainOverLimit = false;
  const toFps = mps => Math.round(mps * ASCENT_M_TO_FT);
  const setPart = (part, mps) => {
    const raw = toFps(mps);
    if (part === 'main' && raw > limits.main[1]) mainOverLimit = true;
    state.rateFps[part] = Math.min(limits[part][1], Math.max(limits[part][0], raw));
  };

  if (descentDevices.length === 1) {
    applyDeployMode('single');
    setPart('main', descentDevices[0].descentRateMs);
  } else {
    const drogue = descentDevices.find(d => d.role === 'drogue');
    const main = descentDevices.find(d => d.role === 'main');
    if (drogue && main) {
      applyDeployMode('dual');
      setPart('drogue', drogue.descentRateMs);
      setPart('main', main.descentRateMs);
    }
  }
  state.rateName = rateNameMatching(state.rateFps);
  invalidateZones();
  buildRateEditor();
  showRateWarning(mainOverLimit);
}

function setMode(mode) {
  // 3D only supports byAltitude and byHistory (renderDescent3D() shows an
  // empty-state hint for byTime, see its own guard) -- switching to byTime
  // while in 3D left the map area genuinely blank instead of falling back
  // to something useful. Auto-switch to 2D instead, per direction, rather
  // than leaving that half-broken until 3D supports every mode.
  // Deliberately one-way -- going back to byAltitude/byHistory does NOT
  // auto-restore 3D, so a user isn't surprised by the view silently
  // switching back on its own; they'd click 3D again if they want it.
  if (mode !== 'byAltitude' && mode !== 'byHistory' && mapViewMode === '3d') {
    mapViewMode = '2d';
  }
  state.mode = mode;
  // Unconditional (not just inside the forced-2d branch above) -- this also
  // syncs the 3D button's own disabled state (see its own comment), which
  // needs to update on every mode switch, not just the ones that force an
  // active 3D view back to 2D (e.g. byAltitude -> byTime while already in
  // 2D still needs the button to go from enabled to disabled). state.mode
  // must already be set by this point -- updateMapViewModeUI() reads it.
  updateMapViewModeUI();
  // fresh start on every mode switch -- a hidden zone-group carrying over from
  // the other mode's isolation state would reference a data-alt/data-hour that
  // doesn't apply here
  state.isolatedHour = null; state.pinnedHour = null;
  // selectedModels/selectedAlts are deliberately NOT reset here -- carry the
  // user's checkboxes across a mode switch instead of silently reselecting
  // everything. byAltitude/byTime and byHistory do read different
  // availability sources (modelsWithData() vs historyModelsAvailable();
  // selectedAlts isn't even read outside byAltitude at all), but
  // buildModelLegend()/buildAltList() already drop anything not valid for
  // the new mode and only fall back to "all available" if that empties the
  // selection entirely -- no separate reset needed here, and doing it here
  // as well was overriding that logic on every single mode switch, not just
  // the byHistory edge case it was meant for.
  state.preSoloModels = null; state.preSoloAlts = null; // nothing to undo across a mode switch
  state.isolatedCapture = null; state.pinnedCapture = null;
  // No rate reset here any more -- state.rateFps/rateName are one shared
  // setting across every mode now (see buildRateEditor()'s own comment),
  // not something History used to isolate separately from byAltitude/byTime.
  applyModeUI(mode);
  buildAltList();
  buildTimeLegend();
  buildModelLegend();
  buildRateEditor();
  // note: no render() here -- buildToggle() already calls it after this
  // onChange callback returns, for the mode-toggle click that triggers this.
}

// Descending -- the row list and the slider beside it both read top-to-bottom
// as high-to-low altitude, matching the real world (sky above, ground below)
// rather than the ascending order DATA.altitudes/config.ALTITUDES_MASTER_FT
// happen to store it in.
function altitudesDescending() { return [...DATA.altitudes].sort((a, b) => b - a); }
// Altitudes that actually have a zone for the current hour/deploy -- single
// deploy is dropped above config.SINGLE_DEPLOY_MAX_ALT_FT (10,000ft)
// pipeline-side, so a high-waiver site on Single has real zones for only
// part of DATA.altitudes.
function altitudesWithZones() {
  return new Set(zonesFor(state.timeMinutes, state.deploy).map(z => z.altitude));
}

// --- shared altitude control (2D + 3D): compact slider + fly-out ladder ---
// Promoted 2026-08 from 3D's own bespoke compact slider (previously
// path3dResolveAltFt()/path3dSetAlt() in descent3d.js, 3D-only) to one
// shared implementation both frames use now -- lives in .map-view-wrap
// (index.html), works identically whichever frame is showing. 2D's
// byAltitude ladder can have several rungs toggled on at once now
// (state.selectedAlts, a Set -- see buildAltList() below), but there's only
// one slider thumb/readout/3D descent path, so this collapses that set down
// to a single scalar the same way descent3d.js used to alone.
const mapAltControl = document.getElementById('map-alt-control');
const mapAltReadoutText = document.getElementById('map-alt-readout-text');
const mapAltSlider = document.getElementById('map-alt-slider');
const mapAltTicks = document.getElementById('map-alt-ticks');
const mapAltThumb = document.getElementById('map-alt-thumb');

// Set only by dragging/clicking this control's own slider -- null means
// "follow whatever mode/selection is currently active" (see
// resolveMapAltFt()). Mirrors descent3d.js's old path3dAltOverrideFt.
let mapAltOverrideFt = null;
let mapAltSliderJustMoved = false;
let mapAltLastStateSig = null;
// The altitude actually used by the most recent real resolve -- read by the
// slider's own keyboard handler instead of calling resolveMapAltFt() a
// second time mid-interaction (that function has side effects on the
// override/sig above, meant to run at most once per update).
let mapAltLastResolvedFt = null;

function mapAltSliderMaxFt() {
  return DATA.altitudes[DATA.altitudes.length - 1];
}

// Priority chain, highest first: a real rocketry sim result (2026-08,
// requested directly -- "we need to update the apogee number to match
// it"), then this slider's own drag override, then "Specific altitude"
// (customAlt), then per-mode -- byTime/byHistory read compareAlt (their
// own single-select "which altitude to compare across hours/captures,"
// unchanged); byAltitude reads whichever altitude is solo'd
// (state.selectedAlts has exactly one member, via double-click or by
// manually unchecking every other one) -- with several checked and none
// solo'd there's no single answer, so this falls back to the top of the
// site's own ladder, same as when nothing used to be pinned under the old
// single-select design. mapAltOverrideFt is cleared back to "follow the
// current selection" as soon as any of those inputs changes from a source
// OTHER than this slider's own drag (tracked via mapAltSliderJustMoved,
// reset every call -- so it only "protects" the override for the one
// update immediately following an actual drag).
//
// The sim-result branch wins over EVERYTHING else, including a manual
// slider drag or a solo'd ladder rung -- once a real physics answer exists
// for "what altitude does this rocket actually reach," a manually-picked
// number is stale, not a legitimate alternative choice, same reasoning
// renderDescent3D() (descent3d.js) already applied to the 3D view's own
// altitude before this fix brought the 2D map's readout/zone into line
// with it. ascentMeanApogeeFt() (descent3d.js), not any one model's own
// value -- same mean-across-models reasoning that function's own comment
// gives, since this feeds ONE shared descent-simulation altitude, not a
// plottable per-model position (that's drawPredictedApogeeMarker()'s own
// per-model markers below, a separate concern).
function resolveMapAltFt() {
  if (ASCENT_RESULTS) {
    // state.timeMinutes directly, not a snapped hour -- ascentMeanApogeeFt()
    // (descent3d.js) now interpolates each model's own apogee between the
    // two bracketing real hours, same as this app already does for wind.
    const mean = ascentMeanApogeeFt(state.timeMinutes);
    // Rounded -- ascentMeanApogeeFt() is a genuine float mean (unlike every
    // other source this function returns, which are always whole-number
    // ladder rungs/slider positions already), and this value both feeds
    // the visible readout text (mapAltReadoutText, plain toLocaleString()
    // with no rounding of its own) and the zoneFor()/descentPathsFor()
    // cache keys downstream -- confirmed directly via a real sim result:
    // without this the readout showed "6,841.416 ft" verbatim.
    if (mean) return Math.round(mean.altFt);
  }
  const soloAlt = (state.mode === 'byAltitude' && state.selectedAlts && state.selectedAlts.size === 1)
    ? [...state.selectedAlts][0] : null;
  const sig = `${state.mode}|${state.customAlt}|${soloAlt}|${state.compareAlt}`;
  if (mapAltOverrideFt !== null && !mapAltSliderJustMoved && sig !== mapAltLastStateSig) {
    mapAltOverrideFt = null;
  }
  mapAltLastStateSig = sig;
  mapAltSliderJustMoved = false;
  if (mapAltOverrideFt !== null) return mapAltOverrideFt;
  if (state.customAlt !== null) return state.customAlt;
  if (state.mode === 'byTime' || state.mode === 'byHistory') return state.compareAlt ?? mapAltSliderMaxFt();
  if (soloAlt !== null) return soloAlt;
  return mapAltSliderMaxFt();
}

// "2k'"..."50k'" -- short enough to read centered inside a compact tick
// hit-box; the flyout's own ladder rows show the full "2,000 ft" text
// instead (see buildAltList()). Every value in the current master ladder
// (config.ALTITUDES_MASTER_FT) is a clean multiple of 1,000ft, so this
// never needs a fractional/rounded case.
function shortAltLabel(alt) { return Math.round(alt / 1000) + "k'"; }

function mapAltUpdateSliderUI(altFt) {
  const max = mapAltSliderMaxFt();
  const frac = max > 0 ? Math.max(0, Math.min(1, altFt / max)) : 0;
  // `bottom` on .map-alt-thumb IS its own bottom EDGE, not its center
  // (translateX-only, see its own CSS comment) -- inset by the thumb's 9px
  // radius so its circle never spills past the track's ends.
  const centerFromBottom = `calc(9px + (100% - 18px) * ${frac})`;
  mapAltThumb.style.bottom = `calc(${centerFromBottom} - 9px)`;
  mapAltSlider.setAttribute('aria-valuenow', String(Math.round(altFt)));
  mapAltSlider.setAttribute('aria-valuemin', '0');
  mapAltSlider.setAttribute('aria-valuemax', String(Math.round(max)));
  mapAltRenderTicks();
}

// One tick per altitude in DATA.altitudes, colored via the SAME
// ALT_COLORS_HEX ramp the flyout's own ladder rows use -- requested
// directly, so the collapsed control's hit-boxes read as the same "which
// altitude is which color" language as the expanded list. Rebuilt on every
// call (cheap: DATA.altitudes is a handful of values) since the slider's
// own live pixel height -- which mapAltTicksToShow() decimates against --
// can change from a window resize independently of anything else that
// would otherwise trigger a rebuild.
function mapAltRenderTicks() {
  const rect = mapAltSlider.getBoundingClientRect();
  const trackPx = Math.max(0, rect.height - 18);
  const max = mapAltSliderMaxFt();
  mapAltTicks.innerHTML = '';
  const shown = new Set(mapAltTicksToShow(trackPx));
  shown.forEach(alt => {
    const frac = max > 0 ? alt / max : 0;
    const tick = document.createElement('button');
    tick.type = 'button';
    tick.className = 'map-alt-tick';
    tick.title = `${alt.toLocaleString()} ft`;
    tick.style.bottom = `calc(9px + (100% - 18px) * ${frac} - 9px)`;
    tick.style.background = ALT_COLORS_HEX[alt] || zoneBaseColor;
    tick.textContent = shortAltLabel(alt);
    // pointerdown + stopPropagation, not a plain 'click' -- a tick sits
    // inside #map-alt-slider, so an unstopped pointerdown would bubble up
    // into the slider's OWN pointerdown handler first and jump the thumb to
    // the click's raw Y before this corrects it to the exact tick value, a
    // visible "jump then snap back." Does NOT open the flyout (reported
    // directly: opening on every adjustment was unwanted) -- #map-alt-toggle
    // is the one explicit trigger now, see toggleMapAltPanel().
    tick.addEventListener('pointerdown', evt => {
      evt.stopPropagation();
      mapAltSetAlt(alt, true);
    });
    // Also a plain 'click' -- keyboard activation (Enter/Space on a focused
    // button) fires that without a preceding pointerdown at all.
    tick.addEventListener('click', () => mapAltSetAlt(alt, true));
    mapAltTicks.appendChild(tick);
  });
  // Unlabeled reference ticks filling the gaps -- see mapAltMinorStep()'s
  // own comment for the density reasoning. Excludes anything within
  // MIN_SPACING_PX of an already-shown labeled tick (own decimation walk
  // already keeps labeled ticks apart; this just also keeps minor ticks
  // from landing directly on/under one).
  mapAltMinorTicksToShow(trackPx, shown).forEach(alt => {
    const frac = max > 0 ? alt / max : 0;
    const tick = document.createElement('button');
    tick.type = 'button';
    tick.className = 'map-alt-tick-minor';
    tick.title = `${alt.toLocaleString()} ft`;
    tick.style.bottom = `calc(9px + (100% - 18px) * ${frac} - 1.5px)`;
    tick.addEventListener('pointerdown', evt => { evt.stopPropagation(); mapAltSetAlt(alt, true); });
    tick.addEventListener('click', () => mapAltSetAlt(alt, true));
    mapAltTicks.appendChild(tick);
  });
}

// Thins DATA.altitudes down to whatever actually fits `trackPx` without
// crowding -- ticks closer together than MIN_SPACING_PX get dropped,
// walking bottom-up so the kept set stays evenly spread. Always keeps the
// top of the ladder even if that means dropping its nearest-below neighbor
// instead. Taller minimum spacing than the old 3D-only dash ticks (22px) --
// these ticks now hold real centered text ("2k'".."50k'"), which needs more
// room than a bare dash did; the master ladder itself got sparser in the
// same redesign (11 rungs max now, down from 24), so this rarely bites in
// practice.
function mapAltTicksToShow(trackPx) {
  const all = DATA.altitudes;
  const max = mapAltSliderMaxFt();
  if (!all.length || max <= 0 || trackPx <= 0) return [];
  const MIN_SPACING_PX = 26;
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

// Unlabeled reference ticks between the labeled master-ladder rungs --
// requested directly ("on fields with lower ceilings, you can put the 1k'
// marks, but don't label them"), then corrected twice more: 500ft is a
// FLOOR on how fine these ever get, not a literal every-500ft grid
// regardless of site ("I said minimum, not minor tick"), and a high-waiver
// site's much taller real range can't fit that many marks in the same
// physical slider height without collapsing into each other ("high waivers
// can't have 100' increments, it may need to shrink on mobile too").
// MAP_ALT_MINOR_TICK_CANDIDATES walks finest-to-coarsest and
// mapAltMinorStep() picks the first one whose spacing actually fits --
// the SAME real pixel-height-driven mechanism mapAltTicksToShow() already
// uses for the labeled ticks, so this also coarsens for free on a short
// mobile slider, not just a tall-waiver site's much longer range.
const MAP_ALT_MINOR_TICK_CANDIDATES = [500, 1000, 2000, 2500, 5000, 10000];
const MINOR_TICK_MIN_SPACING_PX = 10;

function mapAltMinorStep(trackPx) {
  const max = mapAltSliderMaxFt();
  if (max <= 0 || trackPx <= 0) return null;
  for (const step of MAP_ALT_MINOR_TICK_CANDIDATES) {
    if ((step / max) * trackPx >= MINOR_TICK_MIN_SPACING_PX) return step;
  }
  return null; // even the coarsest candidate doesn't fit -- no minor ticks at all
}

function mapAltMinorTicksToShow(trackPx, labeledAlts) {
  const step = mapAltMinorStep(trackPx);
  if (!step) return [];
  const max = mapAltSliderMaxFt();
  const out = [];
  for (let alt = step; alt < max; alt += step) {
    if (!labeledAlts.has(alt)) out.push(alt);
  }
  return out;
}

function mapAltFromClientY(clientY) {
  const rect = mapAltSlider.getBoundingClientRect();
  const frac = 1 - Math.max(0, Math.min(1, (clientY - rect.top) / rect.height));
  return Math.round(frac * mapAltSliderMaxFt());
}

// Pushes a new apogee into both this slider's own override (immediate) and
// state.customAlt ("Specific altitude") -- unlike selectedAlts (which
// altitude ZONES show on the 2D map, a persistent multi-select choice),
// dragging this slider is a momentary "let me check one exact altitude"
// excursion; selectedAlts is deliberately left untouched by it (once
// customAlt clears again, the ladder's own checkbox selection resumes
// controlling the map exactly as it was, not reset to whatever the drag
// passed through -- a deliberate improvement over the old single-select
// design, which used to clear pinnedAlt/isolatedAlt here since those had no
// "set" concept to preserve). `commit` is false for the many intermediate
// pointermove updates during a drag (cheap: this slider's own UI refresh
// plus renderDescent3D(), no re-simulation), true for the drag's actual
// endpoint (a tick click, an arrow-key step, or pointerup) -- the one point
// a full render() runs.
function mapAltSetAlt(altFt, commit) {
  // Rounded to the nearest 100ft, not 1ft -- a freeform drag/keyboard step
  // implies false precision at 1ft resolution. A no-op for tick clicks --
  // every DATA.altitudes value is already a clean multiple of 1,000.
  const rounded = Math.round(altFt / 100) * 100;
  const clamped = Math.max(1, Math.min(mapAltSliderMaxFt(), rounded));
  mapAltOverrideFt = clamped;
  mapAltSliderJustMoved = true;
  state.customAlt = clamped;
  syncAltCustomUI();
  if (commit) {
    render();
  } else {
    mapAltUpdateSliderUI(clamped);
    if (typeof renderDescent3D === 'function') renderDescent3D();
  }
}
// No openMapAltPanel() call here any more -- reported directly, opening the
// fly-out on every drag was unwanted. Dragging/clicking the slider only
// ever sets the altitude now; #map-alt-toggle (below) is the one explicit
// way to open or close the panel.
mapAltSlider.addEventListener('pointerdown', evt => {
  evt.preventDefault();
  mapAltSlider.setPointerCapture(evt.pointerId);
  const move = e => mapAltSetAlt(mapAltFromClientY(e.clientY), false);
  const stop = () => {
    document.removeEventListener('pointermove', move);
    document.removeEventListener('pointerup', stop);
    // Final commit -- see mapAltSetAlt()'s own comment on why the drag
    // itself doesn't pay for a full render() on every intermediate step.
    if (mapAltOverrideFt !== null) mapAltSetAlt(mapAltOverrideFt, true);
  };
  document.addEventListener('pointermove', move);
  document.addEventListener('pointerup', stop);
  move(evt);
});
mapAltSlider.addEventListener('keydown', evt => {
  if (mapAltLastResolvedFt === null) return;
  const max = mapAltSliderMaxFt();
  const step = Math.max(1, Math.round(max / 50));
  let next = null;
  if (evt.key === 'ArrowUp' || evt.key === 'ArrowRight') next = Math.min(max, mapAltLastResolvedFt + step);
  else if (evt.key === 'ArrowDown' || evt.key === 'ArrowLeft') next = Math.max(0, mapAltLastResolvedFt - step);
  if (next !== null) {
    evt.preventDefault();
    mapAltSetAlt(next, true);
  }
});

// Explicit open/close -- replaced the old "any interaction opens it, click
// outside closes it" behavior (mirrored from #rail-angle-control) after
// direct feedback that opening on every slider adjustment was unwanted.
// #map-alt-toggle is now the ONLY thing that opens or closes this panel;
// outside-click-to-close is kept (same convenience #rail-angle-panel still
// has), just no more auto-open.
const mapAltToggleBtn = document.getElementById('map-alt-toggle');
// Glyph points the direction the panel actually moves, not a generic
// up/down caret (reported directly) -- "&laquo;" collapsed (opening grows
// LEFT, into the map, matching .map-alt-panel's own right:calc(100% + 8px)
// growth), "&raquo;" expanded (closing retracts back right).
function setMapAltExpanded(expanded) {
  mapAltControl.classList.toggle('expanded', expanded);
  mapAltToggleBtn.setAttribute('aria-expanded', expanded ? 'true' : 'false');
  mapAltToggleBtn.textContent = expanded ? '»' : '«';
}
function toggleMapAltPanel() {
  setMapAltExpanded(!mapAltControl.classList.contains('expanded'));
}
mapAltToggleBtn.addEventListener('click', toggleMapAltPanel);
document.addEventListener('click', evt => {
  if (!mapAltControl.contains(evt.target) && mapAltControl.classList.contains('expanded')) {
    setMapAltExpanded(false);
  }
});

// Runs the whole resolve-and-redraw pass for this control -- called once
// per real update (from applyIsolation(), itself called at the end of every
// render() and from the ladder's own cheap toggle path below), never
// several times per pass (resolveMapAltFt() has side effects meant to run
// exactly once per update, see its own comment).
function updateMapAltControl() {
  const altFt = resolveMapAltFt();
  mapAltLastResolvedFt = altFt;
  mapAltUpdateSliderUI(altFt);
  if (state.customAlt === null) mapAltReadoutText.textContent = altFt.toLocaleString() + ' ft';
}

// Read-only for now (per direction) -- DATA.descent_params.main_deploy_altitude_ft
// is already published/used for the phase construction every drift sim here
// runs (simulateDriftPath()'s [drogue, apogee, mainAlt] / [main, mainAlt, 0]
// phases); this just surfaces the same number in the flyout so it doesn't
// have to be inferred from the sim. Fixed per-site, not per-selection -- set
// once whenever a dataset loads, not on every render().
function renderMapAltDeployReadout() {
  const alt = DATA.descent_params.main_deploy_altitude_ft;
  document.getElementById('map-alt-deploy-readout').textContent = `Main deploy: ${alt.toLocaleString()} ft`;
}

// --- direct-entry altitude ("Specific altitude") -- overrides the whole
// ladder/selectedAlts selection above in every mode, including History (see
// render()/renderHistory()/historyPointsForAltitude()). Lives in the
// readout above the compact slider now (2026-08) -- plain text
// (mapAltReadoutText) showing the current resolved altitude until clicked,
// then this same input in its place; previously a permanently-visible field
// in the sidebar. No separate checkbox -- clicking the readout/focusing the
// input *is* the request to use it (real user feedback: a checkbox-then-
// type flow made people click twice for one intent).
//
// type="text" + inputmode="numeric" + pattern="[0-9]*" -- deliberately not
// type="number": that shows a mobile keypad with decimal/minus keys anyway
// on several real browsers (iOS Safari ignores inputmode once type=number
// is set), which doesn't match an integer-feet field. This combination is
// the standard portable way to get a real numeric-only keypad on a text
// input. Real validation (integer, clamped to this site's waiver) still
// happens in JS below on every keystroke and again on commit -- the input
// type is purely a mobile-keyboard/basic-pattern hint, not the source of
// truth.
const altCustomInput = document.getElementById('alt-custom-input');
const altCustomClear = document.getElementById('alt-custom-clear');
const altCustomInputRow = document.getElementById('alt-custom-input-row');
// Strips anything that isn't a digit as it's typed (pasted content included,
// since 'input' fires for that too) -- keeps the field itself always
// integer-clean rather than only cleaning up on blur/Enter.
altCustomInput.addEventListener('input', () => {
  const digitsOnly = altCustomInput.value.replace(/\D/g, '');
  if (digitsOnly !== altCustomInput.value) altCustomInput.value = digitsOnly;
});

// Swaps the readout between plain text (mapAltReadoutText) and this editable
// row -- NOT responsible for the resolved-altitude TEXT itself while
// inactive (updateMapAltControl() owns that, called once per real update);
// this only toggles which element shows and reflects the active value/
// status into the input, safe to call any time state.customAlt, hour, or
// deploy changes (cheap -- reads zoneFor()'s cache, doesn't re-simulate).
function syncAltCustomUI() {
  const active = state.customAlt !== null;
  mapAltReadoutText.style.display = active ? 'none' : '';
  altCustomInputRow.style.display = active ? '' : 'none';
  if (active) altCustomInput.value = state.customAlt;
  const statusEl = document.getElementById('alt-custom-status');
  if (!active) { statusEl.textContent = ''; return; }
  // zoneFor() itself already handles "no zone" gracefully (returns null --
  // single deploy above SINGLE_DEPLOY_MAX_ALT_FT, or an hour with no
  // published profile at all); this surfaces *why* rather than leaving the
  // map silently blank, which the row-list's .unavailable graying already
  // does for the ladder-based selector but a bare number input can't.
  const zone = zoneFor(state.timeMinutes, state.deploy, state.customAlt);
  statusEl.textContent = zone ? '' :
    (state.deploy === 'single'
      ? `No single-deploy zone above ${DATA.descent_params.single_deploy_max_alt_ft.toLocaleString()} ft`
      : 'No wind data for this altitude/hour');
}

// Activates on focus alone (before any typing) -- clicking into the field is
// the whole ask, per user feedback; a value already needs to be showing for
// that to mean anything, so seed one immediately rather than leaving it
// blank until the first keystroke.
function activateAltCustom() {
  if (state.customAlt !== null) return; // already active, focus alone shouldn't re-seed over a real edit in progress
  const maxAlt = DATA.altitudes[DATA.altitudes.length - 1];
  const seed = Number(altCustomInput.value) || mapAltLastResolvedFt || state.compareAlt || Math.round(maxAlt / 2);
  state.customAlt = Math.min(maxAlt, Math.max(1, Math.round(seed)));
  syncAltCustomUI();
  render();
}
// Neither of these opens the fly-out any more either -- #map-alt-toggle is
// the one explicit trigger (see its own comment); editing "Specific
// altitude" and browsing the ladder are independent actions now.
mapAltReadoutText.addEventListener('click', () => {
  activateAltCustom();
  altCustomInput.focus();
});
altCustomInput.addEventListener('focus', activateAltCustom);
altCustomInput.addEventListener('change', () => {
  // Clearing the field (deleting all digits, then blur/Enter) turns the
  // override off again -- the symmetric opposite of focus turning it on,
  // so there's no separate control needed just to get back to blank+off.
  if (altCustomInput.value.trim() === '') {
    state.customAlt = null;
    syncAltCustomUI();
    render();
    return;
  }
  const maxAlt = DATA.altitudes[DATA.altitudes.length - 1];
  let v = Number(altCustomInput.value);
  if (!Number.isFinite(v)) v = state.customAlt ?? maxAlt;
  v = Math.min(maxAlt, Math.max(1, Math.round(v)));
  altCustomInput.value = v;
  state.customAlt = v;
  syncAltCustomUI();
  render();
});
altCustomClear.addEventListener('click', () => {
  state.customAlt = null;
  altCustomInput.value = '';
  syncAltCustomUI();
  render();
});

// --- altitude list (the flyout's own ladder): byAltitude mode gets Models'
// own checkbox + double-click-solo/revert pattern (state.selectedAlts/
// preSoloAlts, mirrors buildModelLegend() exactly -- see that function's own
// comment for the full click/dblclick mechanics); byTime/byHistory keep the
// original single-select click-toggle (state.compareAlt), unchanged --
// those modes render exactly one altitude at a time, so there's no "set" to
// toggle a member of. Always renders every altitude with a real zone (no
// range filter any more -- that dual-thumb slider was removed 2026-08);
// unchecking one just hides its already-built zone-group (applyIsolation())
// rather than removing the row -- every rung's zone-group is built
// unconditionally now (see render()), so there's always something to
// re-show if it's checked again later.
function buildAltList() {
  const el = document.getElementById('alt-list');
  el.innerHTML = '';
  const withZones = altitudesWithZones();
  const isByAlt = state.mode === 'byAltitude';
  if (isByAlt) {
    if (state.selectedAlts === null) {
      state.selectedAlts = new Set(withZones);
    } else {
      // Drop anything selected that isn't actually available here (e.g. a
      // deploy switch that drops an altitude above SINGLE_DEPLOY_MAX_ALT_FT)
      // -- falls back to "all available" rather than leaving a confusing
      // empty map if that drops every selected altitude.
      const stillValid = new Set([...state.selectedAlts].filter(a => withZones.has(a)));
      state.selectedAlts = stillValid.size ? stillValid : new Set(withZones);
    }
  }
  altitudesDescending().forEach(alt => {
    const available = withZones.has(alt);
    const selected = isByAlt && state.selectedAlts.has(alt);
    const row = document.createElement('div');
    row.className = 'alt-row' + (!available ? ' unavailable' : (isByAlt ? (selected ? ' pinned' : ' deselected') : ''));
    row.innerHTML = `<div class="alt-swatch" style="background:${ALT_COLORS_HEX[alt]}"></div><span>${alt.toLocaleString()} ft</span>`;
    if (!available) { el.appendChild(row); return; }

    if (isByAlt) {
      // click vs dblclick: a browser fires click on both presses of a
      // double-click before the dblclick event itself, so the single-click
      // toggle is delayed briefly -- if a second click lands within the
      // window, it's a dblclick instead and the pending toggle is dropped.
      // Identical mechanics to buildModelLegend()'s own per-row timer.
      let clickTimer = null;
      row.addEventListener('click', () => {
        if (clickTimer) return;
        clickTimer = setTimeout(() => {
          clickTimer = null;
          if (state.selectedAlts.has(alt)) state.selectedAlts.delete(alt);
          else state.selectedAlts.add(alt);
          state.preSoloAlts = null; // a manual toggle supersedes any pending solo-undo
          buildAltList();
          applyIsolation(); // cheap show/hide -- every zone-group already exists, see render()
        }, 250);
      });
      row.addEventListener('dblclick', () => {
        if (clickTimer) { clearTimeout(clickTimer); clickTimer = null; }
        // Second double-click on the altitude that's currently soloed undoes
        // it back to whatever was selected right before -- otherwise this is
        // a fresh solo, so stash the pre-solo selection for that undo.
        if (state.preSoloAlts && state.selectedAlts.size === 1 && state.selectedAlts.has(alt)) {
          state.selectedAlts = state.preSoloAlts;
          state.preSoloAlts = null;
        } else {
          state.preSoloAlts = new Set(state.selectedAlts);
          state.selectedAlts = new Set([alt]);
        }
        buildAltList();
        applyIsolation();
      });
    } else {
      row.addEventListener('click', () => {
        // Toggle, same as byAltitude's selectedAlts above -- clicking the
        // already-selected altitude again clears it rather than being stuck
        // permanently selected.
        state.compareAlt = (state.compareAlt === alt) ? null : alt;
        [...el.children].forEach(r => r.classList.remove('pinned'));
        if (state.compareAlt === alt) row.classList.add('pinned');
        render();
      });
      if (state.compareAlt === alt) row.classList.add('pinned');
    }
    el.appendChild(row);
  });
}

// Which models published a usable wind profile at any hour -- a model beyond
// its forecast horizon for this lead time (e.g. HRRR ~48h out, by a T-5/T-7
// capture) has none at all. Used to gray those out in the legend instead of
// leaving them hoverable/clickable with nothing behind them, which just
// looked broken. No simulation needed -- this is just which keys exist in
// DATA.wind_profiles, unlike the old DATA.data-based version which had to
// scan every already-simulated point.
function modelsWithData() {
  const present = new Set();
  Object.values(DATA.wind_profiles || {}).forEach(models => {
    Object.keys(models).forEach(m => present.add(m));
  });
  return present;
}

// History mode only: does the currently-selected hour/deploy/rate/altitude
// combo have any history points for this model at all -- distinct from
// modelsWithData()'s "anywhere in the main hull view," since History reads
// from a different fetch (HISTORY, not DATA) with its own key.
function historyModelsAvailable() {
  if (!HISTORY) return new Set();
  if (state.customAlt !== null) {
    return new Set(historyPointsForAltitude(state.timeMinutes, state.deploy, state.customAlt).map(p => p.model));
  }
  // Ladder altitude: reads the server's precomputed bucket, keyed by exact
  // integer hour (build_points_history()'s own points_by_key -- a real grid
  // across every capture date, not something the client can resimulate on
  // the fly the way zoneFor()/profilesForTime() do for byAltitude/byTime),
  // so this snaps to the nearest real published hour rather than blending
  // -- see nearestPublishedHour()'s own comment. Also falls back to 'fast'
  // rather than state.rateFps directly -- see historyPointsForAltitude()'s
  // own comment for why.
  const key = `${nearestPublishedHour(state.timeMinutes)}_${state.deploy}_${state.rateName || 'fast'}_${state.compareAlt}`;
  return new Set((HISTORY.points_by_key[key] || []).map(p => p.model));
}

// Multi-select checkboxes, not hover-isolate/click-pin like every other
// legend in this file -- unlike a single altitude/rate/hour, "which models
// contributed to this zone" is naturally a set (you might want GFS+ECMWF
// together, or all-but-HRRR), and now that the drift sim runs client-side
// (zoneFor()) there's no cost to recomputing the hull from any subset on
// every click. Click toggles one model; double-click solos it (same as
// "select only this one"). state.selectedModels is the source of truth
// (drawZone()/renderHistory()/renderAccuracyTable() all read it directly);
// this function also resolves its null sentinel to "every available model"
// the first time it runs for a given state (see freshState()'s comment).
function buildModelLegend() {
  const el = document.getElementById('model-legend');
  el.innerHTML = '';
  const isHistory = state.mode === 'byHistory';
  const available = isHistory ? historyModelsAvailable() : modelsWithData();
  if (state.selectedModels === null) {
    state.selectedModels = new Set(available);
  } else {
    // Drop anything selected that isn't actually available here (e.g. a
    // permalink's ?models= naming one beyond this capture's horizon, or a
    // mode switch that reads a different availability source) -- falls
    // back to "all available" rather than leaving a confusing empty view
    // if that drops every selected model.
    const stillValid = new Set([...state.selectedModels].filter(m => available.has(m)));
    state.selectedModels = stillValid.size ? stillValid : new Set(available);
  }
  MODEL_LEGEND_ORDER.forEach(m => {
    const hasData = available.has(m);
    const selected = state.selectedModels.has(m);
    const row = document.createElement('div');
    row.className = 'alt-row' + (hasData ? (selected ? ' pinned' : ' deselected') : ' unavailable');
    const label = MODEL_LABELS[m] || m.toUpperCase();
    // Shape swatch everywhere now, not just History -- matches what's
    // actually drawn on the map in every mode (see MODEL_SHAPES's comment).
    const swatch = shapeSwatchSVG(MODEL_SHAPES[m], hasData ? MODEL_COLORS_HEX[m] : 'var(--text-muted)');
    // "N/A" not "no data" -- shorter (matters now that this legend is a
    // horizontal row of chips, not a vertical list with room to spare; two
    // models unavailable at once used to be enough to force a 3rd wrapped
    // row at a real mobile width). The full explanation is still one hover
    // away (row.title, just below) -- this is only the always-visible text.
    row.innerHTML = `${swatch}<span>${label}${hasData ? '' : ' (N/A)'}</span>`;
    if (hasData) {
      // click vs dblclick: a browser fires click on both presses of a
      // double-click before the dblclick event itself, so the single-click
      // toggle is delayed briefly -- if a second click lands within the
      // window, it's a dblclick instead and the pending toggle is dropped.
      // Per-row timer (not shared across the legend) so double-clicking one
      // model can't be confused by a stray click on another.
      let clickTimer = null;
      row.addEventListener('click', () => {
        if (clickTimer) return; // already mid-dblclick for this row
        clickTimer = setTimeout(() => {
          clickTimer = null;
          if (state.selectedModels.has(m)) state.selectedModels.delete(m);
          else state.selectedModels.add(m);
          state.preSoloModels = null; // a manual toggle supersedes any pending solo-undo
          buildModelLegend();
          renderWeatherPanel(); // weather rows follow the same model checkboxes the map does
          render();
        }, 250);
      });
      row.addEventListener('dblclick', () => {
        if (clickTimer) { clearTimeout(clickTimer); clickTimer = null; }
        // Second double-click on the model that's currently soloed undoes it
        // back to whatever was selected right before -- otherwise this is a
        // fresh solo, so stash the pre-solo selection for that undo.
        if (state.preSoloModels && state.selectedModels.size === 1 && state.selectedModels.has(m)) {
          state.selectedModels = state.preSoloModels;
          state.preSoloModels = null;
        } else {
          state.preSoloModels = new Set(state.selectedModels);
          state.selectedModels = new Set([m]);
        }
        buildModelLegend();
        renderWeatherPanel();
        render();
      });
    } else {
      row.title = `${label} has no data for this lead time -- likely beyond this model's forecast horizon.`;
    }
    el.appendChild(row);
  });
}

document.getElementById('model-reset').addEventListener('click', () => {
  state.selectedModels = null; // sentinel -- re-resolve to "all available"
  state.preSoloModels = null; // nothing to undo across a reset
  buildModelLegend();
  renderWeatherPanel();
  render();
});

// Editable drogue/main fps for ONE active rate -- Fast/Slow (#rate-preset-
// toggle, wired below) are quick-fill presets, not two independently-
// editable rows computed simultaneously any more (2026-08 simplification:
// per direction, every 2D zone doubling into two rate-labeled point sets
// made sense to whoever built it but not necessarily to anyone else reading
// the map cold -- matches descent3d.js's own single-active-rate pattern
// instead). See state.rateFps/state.rateName's own declarations in
// freshState() for why they live in `state` rather than as a standing
// "what-if" global like railAngleDeg.
function buildRateEditor() {
  const presetToggle = document.getElementById('rate-preset-toggle');
  presetToggle.querySelectorAll('button').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.rate === state.rateName);
    // Reassigned (not addEventListener'd again) each rebuild -- this
    // function reruns on every mode/deploy switch, and onclick= replacing
    // itself is simpler than tracking whether a listener's already attached.
    btn.onclick = () => {
      state.rateFps = structuredClone(DATA.descent_params.default_rates_fps[btn.dataset.rate]);
      state.rateName = btn.dataset.rate;
      invalidateZones();
      buildRateEditor(); // refreshes both the inputs below and this toggle's own active highlight
      render();
    };
  });

  const el = document.getElementById('rate-edit');
  el.innerHTML = '';
  showRateWarning(false); // stale otherwise -- #rate-warning lives outside #rate-edit, so a full rebuild wouldn't otherwise touch it
  const limits = DATA.descent_params.rate_limits_fps;

  // Unit lives once in the section title ("Rate (fps)") now, not repeated
  // per column.
  const head = (text) => { const d = document.createElement('div'); d.className = 'rate-edit-head'; d.textContent = text; el.appendChild(d); };
  head('Drogue'); head('Main');

  ['drogue', 'main'].forEach(part => {
    const input = document.createElement('input');
    input.type = 'number';
    input.min = limits[part][0];
    input.max = limits[part][1];
    input.step = 1;
    input.value = state.rateFps[part];
    // Single deploy is one canopy the whole way -- zoneFor()'s phase
    // construction never reads the drogue rate for it, so editing it
    // would silently do nothing. Disabled, not hidden: keeps the grid's
    // column structure stable across a deploy switch, and the value is
    // still visible for reference (and still applies immediately if the
    // user switches back to Dual).
    input.disabled = part === 'drogue' && state.deploy === 'single';
    // 'change' (blur/Enter/stepper), not 'input' -- typing "120" fires at
    // "1" mid-keystroke on 'input', and a transient 1fps rate would blow
    // up the view box (see growBaseViewBox()) before the user finishes.
    input.addEventListener('change', () => {
      let v = Number(input.value);
      if (!Number.isFinite(v)) v = state.rateFps[part];
      // Flagged separately from the generic clamp below -- Tripoli USC
      // §11-1's 35 fps max landing speed (limits.main[1]) is a real
      // safety-code number, not just an input sanity bound like drogue's,
      // so exceeding it gets an explicit on-screen reason instead of
      // silently reverting to a smaller number.
      showRateWarning(part === 'main' && v > limits.main[1]);
      v = Math.min(limits[part][1], Math.max(limits[part][0], v));
      input.value = v;
      state.rateFps[part] = v;
      // A hand-edit may have landed back exactly on a preset (e.g. nudging
      // main from 21 to 20) or moved off one -- re-check either way rather
      // than assuming "any edit means custom".
      state.rateName = rateNameMatching(state.rateFps);
      invalidateZones();
      // Refresh just the preset buttons' highlight, not a full
      // buildRateEditor() -- that would destroy and recreate every <input>
      // in this grid, including whichever one the browser was about to move
      // focus to on Tab. The destroyed element is a stale reference by the
      // time the browser tries to focus it, so Tab silently drops focus
      // instead of advancing. Real user report, not theoretical.
      presetToggle.querySelectorAll('button').forEach(b => b.classList.toggle('active', b.dataset.rate === state.rateName));
      updateRateHint();
      render();
    });
    el.appendChild(input);
  });

  updateRateHint();
}

// Shown only while actively relevant: every rate-input change event calls
// this (see buildRateEditor()'s change handler), passing false whenever
// that particular edit isn't a main-over-35fps attempt -- so it hides
// itself again the moment the user moves on, rather than needing a timer
// or a dismiss button.
function showRateWarning(show) {
  document.getElementById('rate-warning').style.display = show ? '' : 'none';
}

// Split from applyModeUI() -- the hint's numeric half depends on
// state.rateFps (editable, changes independently of mode), the interaction
// half depends on state.mode. Called from both buildRateEditor() (a rate
// just changed) and applyModeUI() (mode just changed) so either alone keeps
// the full sentence correct.
function updateRateHint() {
  const r = state.rateFps;
  document.getElementById('rate-hint').textContent =
    `${r.drogue}/${r.main} fps (drogue/main) -- editable above, or click Fast/Slow to fill in that preset's numbers. Not a rate at 0ft AGL (there's no real data right at the pad for either phase -- main deploys around 600-1,200ft AGL, drogue never gets anywhere near the ground at all): drogue is read as the rate around 2,000-1,000ft AGL, main around 500-0ft AGL, then the sim extrapolates each to the ground and scales for thinner air above that. Deriving this from real altimeter data? Read it off a short segment within that phase's own realistic window, not averaged across the whole drogue/main phase -- averaging blurs which altitude the number actually represents, and the true rate changes across that span.`;
}

function buildTimeLegend() {
  const el = document.getElementById('time-legend');
  el.innerHTML = '';
  if (state.mode === 'byHistory') {
    if (!HISTORY) return;
    // Selectable like every other legend here. Swatch uses the grayscale
    // recency ramp (recencyColor()) as a visual "how far back" cue on the
    // row itself; the markers it filters on the map use model color instead
    // (see MODEL_SHAPES's comment) since recency has its own channel here.
    [...HISTORY.captures].sort().forEach(captureDate => {
      const leadDays = Math.round((new Date(HISTORY.target_date) - new Date(captureDate)) / 86400000);
      const row = document.createElement('div');
      row.className = 'alt-row';
      row.innerHTML = `<div class="alt-swatch" style="background:${recencyColor(leadDays)}"></div><span>${leadDaysLabel(captureDate, HISTORY.target_date)} (${captureDate})</span>`;
      row.addEventListener('mouseenter', () => { state.isolatedCapture = captureDate; render(); });
      row.addEventListener('mouseleave', () => { state.isolatedCapture = null; render(); });
      row.addEventListener('click', () => {
        state.pinnedCapture = (state.pinnedCapture === captureDate) ? null : captureDate;
        [...el.children].forEach(r => r.classList.remove('pinned'));
        if (state.pinnedCapture === captureDate) row.classList.add('pinned');
        render();
      });
      if (state.pinnedCapture === captureDate) row.classList.add('pinned');
      el.appendChild(row);
    });
    const projectionRow = document.createElement('div');
    projectionRow.className = 'alt-row static';
    projectionRow.innerHTML = `${shapeSwatchSVG('star', PROJECTION_MARKER_COLOR)}<span>Final projection (once recorded)</span>`;
    el.appendChild(projectionRow);
    if (REAL_FLIGHTS.length) {
      const label = REAL_FLIGHTS.length > 1 ? `Real flights (${REAL_FLIGHTS.length}, hover or click for details)` : 'Real flight (hover or click for details)';
      const realFlightRow = document.createElement('div');
      realFlightRow.className = 'alt-row static';
      realFlightRow.innerHTML = `${shapeSwatchSVG('target', REAL_FLIGHT_COLOR)}<span>${label}</span>` +
        `<button class="info-btn" type="button" data-hint="real-flight-hint" title="Show details">i</button>`;
      el.appendChild(realFlightRow);

      // Generic across every real flight -- how launch/apogee/landing/
      // predicted-landing are each derived, not this flight's own numbers
      // (those already show in the info box itself, and a no-GPS flight's
      // own estimation caveat already shows there too via apogeeNote).
      // Built here (not static markup in index.html) since this row only
      // exists at all when REAL_FLIGHTS is non-empty -- wired directly
      // rather than relying on the one-time global .info-btn listener setup
      // (see that code's own comment: it only ever runs once, before this
      // element can exist).
      const hint = document.createElement('div');
      hint.className = 'alt-hint';
      hint.id = 'real-flight-hint';
      hint.innerHTML = 'Launch is the tracker’s own real GPS at liftoff (or a hand-recorded pin, for altimeters with no GPS) — shown for reference and the boost-angle figure, not itself an input to the predicted landing below. Apogee altitude is always real (barometric or GPS); its horizontal position is either real GPS too, or, for no-GPS altimeters, estimated from the real landing point and the wind model (flagged in that flight’s own note when this applies). Landing is a real GPS position (the tracker’s own fix, or a hand-recorded pin at recovery). Predicted landing (the cyan star) is this flight’s own apogee — real or estimated — plus its own derived descent rates and the real wind profile for its actual time of day, simulated forward to the ground: based on apogee, not the launch/rail position, so for GPS-tracked flights it’s an independent accuracy check against the real landing. Its “% of actual descent drift” scores that check against how far the wind actually carried the rocket from apogee to landing — not pad to landing, which real boost-phase drift (the rail angle, weathercocking) dominates and this sim never touches, since apogee’s position there is measured, not predicted.';
      el.appendChild(hint);
      realFlightRow.querySelector('.info-btn').addEventListener('click', () => {
        const isOpen = hint.classList.toggle('open');
        realFlightRow.querySelector('.info-btn').classList.toggle('open', isOpen);
      });
    }
    return;
  }
  DATA.hours.forEach(h => {
    const row = document.createElement('div');
    row.className = 'alt-row';
    row.innerHTML = `<div class="alt-swatch" style="background:${TIME_COLORS_HEX[h]}"></div><span>${hourAmPm(h)}</span>`;
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
    // Checkbox multi-select now (state.selectedAlts, a Set), not a single
    // isolate/pin value -- every zone-group whose altitude is in the set
    // shows, the rest hide. selectedAlts is only ever null before
    // buildAltList() has resolved its sentinel (see that function's own
    // comment); guarded the same defensive way just in case this runs
    // first.
    //
    // customAlt (Specific altitude) bypasses selectedAlts entirely -- when
    // it's active, render() builds exactly one zone-group, at whatever
    // arbitrary value the slider was dragged to (see render()'s own
    // altitudeZones branch), which is essentially never a member of
    // selectedAlts (that Set only ever holds the discrete ladder's own
    // rungs). Filtering it against selectedAlts anyway hid it unless the
    // drag happened to land exactly on a ladder value -- real bug, reported
    // directly ("the splash zone isn't being rendered unless it's on a 2k'
    // marker"). null here (not selectedAlts) so the one real zone-group
    // always shows, same as "nothing to filter against."
    const selected = (ASCENT_RESULTS || state.customAlt !== null) ? null : state.selectedAlts;
    document.querySelectorAll('.zone-group').forEach(g => {
      const alt = parseInt(g.dataset.alt, 10);
      g.style.display = (selected === null || selected.has(alt)) ? '' : 'none';
    });
  } else {
    const active = state.isolatedHour ?? state.pinnedHour;
    document.querySelectorAll('.zone-group').forEach(g => {
      const hour = parseInt(g.dataset.hour, 10);
      g.style.display = (active === null || hour === active) ? '' : 'none';
    });
  }
  syncUrl();
  // The compact map-anchored altitude control's own slider/readout is one
  // of the things whose resolved value depends on this same isolation state
  // (see resolveMapAltFt()) -- refreshed here so a checkbox toggle's cheap
  // path (buildAltList() -> applyIsolation(), no full render()) still keeps
  // it in sync, not just a full render() pass.
  updateMapAltControl();
  // A checkbox toggle on the altitude ladder only ever triggered this
  // lightweight SVG-visibility toggle before, not a full render() -- without
  // this the 3D view (descent3d.js) would go stale on every toggle, since
  // that's one of the altitude-resolution chain's own inputs (see its own
  // comment). Guarded, not a hard reference, so app.js doesn't break if that
  // file is ever missing/fails to load.
  if (typeof renderDescent3D === 'function') renderDescent3D();
}

// --- pan / zoom (viewBox-based) ---
const wrap = document.getElementById('map-wrap');
const svg = document.getElementById('overlay');
// Hand-tuned per-site default view (SVG viewBox: x,y,w,h -- same pixel-space
// units the map's own ft_to_px_scale produces, not raw feet), one site at a
// time via the map's own "copy view" button (see copyViewBtn below) --
// BASE_VB's own auto-fit framing (the current zones' bounding box, grown by
// a flat padding factor) doesn't always center on the real terrain/hazards
// a launch director actually cares about as well as a human's own judgment
// does. A site absent from this map falls back to BASE_VB as before (see
// defaultViewBox()) -- nothing breaks for a site that hasn't been tuned yet.
const SITE_DEFAULT_VIEWS = {
  hutto: [581, 331, 2329.9, 2329.9],
  apache_pass: [563.8, 381.1, 2266.9, 2266.9],
  gunter: [-166.7, -289.3, 2736.6, 2736.6],
  argonia: [3020.6, 3061.9, 3072.1, 3072.1],
  sd_rocket_jockies: [519.5, 614.4, 1761.9, 1761.9],
  seymour: [3052.8, 3118.9, 1723.6, 1723.6],
  hearne: [265.8, 291.4, 1378.6, 1378.6],
  tripoli_houston_south: [888.9, 761.4, 1117.9, 1117.9],
};
function defaultViewBox() {
  return SITE_DEFAULT_VIEWS[currentSiteId] || BASE_VB;
}
// Assigned per-dataset in initFromData() (was a one-time const off the
// embedded DATA blob; now DATA can change at runtime via the date selector).
let BASE_VB, IMG_VB, view, MIN_SPAN, MAX_SPAN;
// True once `view` has been set to this dataset's own BASE_VB for the
// first time -- render() does that itself (see its own comment), not
// initFromData(), since BASE_VB can still grow once the live rate/altitude
// selection is known (growBaseViewBox()) and initFromData() runs before
// that. Reset to false on every dataset load so a new site/date starts
// centered on what's actually relevant again, but left alone across
// ordinary re-renders (hour/rate/deploy changes) so a manual pan/zoom
// isn't silently fought on every interaction.
let viewInitialized = false;

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
// Shared by manual drag (below) and the real-flight marker's auto-snap
// (drawRealFlightMarker()) -- same cap either way, so snapping the pad to a
// real GPS rail can't silently exceed the site's own explored-range limit.
function setPadOffsetClamped(newX, newY) {
  const dist = Math.hypot(newX, newY);
  if (dist > MAX_PAD_MOVE_FT) {
    const scale = MAX_PAD_MOVE_FT / dist;
    padOffsetFt = { x: newX * scale, y: newY * scale };
  } else {
    padOffsetFt = { x: newX, y: newY };
  }
}

// ft offset <-> real GPS, for the permalink's `pad` param -- same flat-earth
// approximation splash_zones.py's own ft_to_px() uses server-side (not a
// full geodesic, but consistent with how this app already treats the local
// area, e.g. ft_to_px_scale). Encoding the drag as a GPS coordinate rather
// than the raw ft offset means an old shared link still points at the same
// real ground spot even if this site's own surveyed lat/lon is corrected
// later (SITE_GEOMETRY.site_lat/site_lon is always read fresh at load time,
// so the offset re-resolves against whatever the CURRENT default is).
const M_PER_DEG_LAT = 111320;
function padFtToLatLon(x_ft, y_ft) {
  const mPerDegLon = M_PER_DEG_LAT * Math.cos(SITE_GEOMETRY.site_lat * Math.PI / 180);
  const ftToM = 0.3048;
  return {
    lat: SITE_GEOMETRY.site_lat + (y_ft * ftToM) / M_PER_DEG_LAT,
    lon: SITE_GEOMETRY.site_lon + (x_ft * ftToM) / mPerDegLon,
  };
}
function padLatLonToFt(lat, lon) {
  const mPerDegLon = M_PER_DEG_LAT * Math.cos(SITE_GEOMETRY.site_lat * Math.PI / 180);
  const ftToM = 0.3048;
  return {
    x: ((lon - SITE_GEOMETRY.site_lon) * mPerDegLon) / ftToM,
    y: ((lat - SITE_GEOMETRY.site_lat) * M_PER_DEG_LAT) / ftToM,
  };
}

// See padOffsetBeforeRealFlightSnap's own declaration -- called on a normal
// close (unpin via the marker itself, or the click-away listener), not on
// the pad-drag-triggered unpin, which discards the saved value instead.
function restorePadFromRealFlightSnap() {
  if (!padOffsetBeforeRealFlightSnap) return;
  padOffsetFt = padOffsetBeforeRealFlightSnap;
  padOffsetBeforeRealFlightSnap = null;
  render();
}

let draggingPad = false, padLastX = 0, padLastY = 0;
window.addEventListener('pointermove', evt => {
  if (!draggingPad) return;
  const rect = wrap.getBoundingClientRect();
  const dxPx = (evt.clientX - padLastX) / rect.width * view.w;
  const dyPx = (evt.clientY - padLastY) / rect.height * view.h;
  padLastX = evt.clientX; padLastY = evt.clientY;

  const newX = padOffsetFt.x + dxPx / SITE_GEOMETRY.ft_to_px_scale.x;
  const newY = padOffsetFt.y - dyPx / SITE_GEOMETRY.ft_to_px_scale.y; // screen y grows downward, north is +y
  setPadOffsetClamped(newX, newY);
  // A pinned real-flight box means the pad is sitting exactly on that
  // flight's real rail (see drawRealFlightMarker()'s click handler) --
  // dragging it elsewhere by hand breaks that alignment, so treat the drag
  // itself as backing out of the comparison rather than leaving a pinned
  // box whose numbers no longer describe where the pad actually is.
  if (pinnedRealFlightIndex !== null) {
    pinnedRealFlightIndex = null;
    hideRealFlightBox();
    updateActiveRealFlightOverlay();
    setRealFlightComparing(hoveredRealFlightIndex !== null);
    // This drag itself is the user placing the pad -- unlike a normal
    // close, there's nothing to restore it to (see
    // padOffsetBeforeRealFlightSnap's own declaration).
    padOffsetBeforeRealFlightSnap = null;
  }
  render();
});
function endPadDrag() { draggingPad = false; wrap.classList.remove('dragging-pad'); }
window.addEventListener('pointerup', endPadDrag);
window.addEventListener('pointercancel', endPadDrag);

// Any button living inside #map-wrap (zoom controls) silently stops
// responding to clicks without this: wrap's own pointerdown handler
// (setPointerCapture() + drag tracking, above) has no evt.target check, so
// a pointerdown on a child button bubbles up and gets captured by wrap
// before the browser's click synthesis on the button completes. Same fix
// the pad marker/rail-angle-control use (stopPropagation() on their own
// pointerdown) -- applied here at the container level so every button
// inside inherits it without needing its own listener. Any *new* button
// added inside #map-wrap needs to be covered by this selector or the same
// bug recurs.
// .layer-toggle/.burn-ban-chip/.ban-overlay no longer live inside #map-wrap
// (moved to .map-view-wrap 2026-08-09 so they work in 3D too, same reason
// #rail-angle-control moved there first) -- this guard is harmless but
// genuinely unnecessary for them now, kept defensively rather than removed
// on the assumption the DOM structure never moves again.
document.querySelectorAll('.zoom-btns, .layer-toggle, .burn-ban-chip, .ban-overlay').forEach(el => {
  el.addEventListener('pointerdown', evt => evt.stopPropagation());
});

document.getElementById('zoom-in').addEventListener('click', () => {
  const rect = wrap.getBoundingClientRect();
  zoomAt(1 / 1.4, rect.left + rect.width / 2, rect.top + rect.height / 2);
});
document.getElementById('zoom-out').addEventListener('click', () => {
  const rect = wrap.getBoundingClientRect();
  zoomAt(1.4, rect.left + rect.width / 2, rect.top + rect.height / 2);
});
document.getElementById('zoom-reset').addEventListener('click', () => {
  // defaultViewBox() -- this site's own hand-tuned default if one's been
  // set (SITE_DEFAULT_VIEWS), else BASE_VB (what's actually relevant -- the
  // current zones' own extent), not IMG_VB (the full raw detail image) --
  // same box the first paint itself now starts at, see viewInitialized's
  // own comment. A user who explicitly wants the full wide image can still
  // zoom out from here (MAX_SPAN allows past it), this is just what
  // "reset" resets to.
  const vb = defaultViewBox();
  view = { x: vb[0], y: vb[1], w: vb[2], h: vb[3] };
  setViewBox();
});

// --- copy current pan/zoom as a link -- a hand-tuning tool, not the
// general-purpose Copy Link button above (which deliberately excludes
// pan/zoom, see its own file-top comment on "durable, what am I looking
// at" choices vs. personal display state -- this isn't meant to become
// part of ordinary shared launch-scenario links). Exists so a real
// per-site default view can be set by eye and handed back as exact
// numbers instead of guessed at from BASE_VB's own auto-fit framing.
// `vb` isn't read by anything yet -- applying a site's chosen default is a
// separate follow-up once real numbers come back for each site.
const copyViewBtn = document.getElementById('copy-view-btn');
copyViewBtn.addEventListener('click', () => {
  const p = new URLSearchParams();
  p.set('site', currentSiteId);
  if (dateSelect.value) p.set('date', dateSelect.value);
  // Rounded to 1 decimal -- these are SVG viewBox units (pixel-space, same
  // as ft_to_px_scale's own output), not raw feet; a whole extra digit of
  // precision here is meaningless for a hand-tuned default.
  p.set('vb', [view.x, view.y, view.w, view.h].map(n => Math.round(n * 10) / 10).join(','));
  const url = `${location.origin}${location.pathname}?${p.toString()}`;
  const showCopied = () => {
    // A checkmark, not the word "Copied!" the wider copy-link-btn shows --
    // no room for text in this 30x30px square (see #copy-view-btn.copied's
    // own CSS comment).
    const original = copyViewBtn.innerHTML;
    copyViewBtn.textContent = '✓';
    copyViewBtn.classList.add('copied');
    setTimeout(() => { copyViewBtn.innerHTML = original; copyViewBtn.classList.remove('copied'); }, 1500);
  };
  if (navigator.clipboard && window.isSecureContext) {
    navigator.clipboard.writeText(url).then(showCopied).catch(() => window.prompt('Copy this view link:', url));
  } else {
    window.prompt('Copy this view link:', url);
  }
});

const layerToggleEl = document.getElementById('layer-toggle');
function updateLayerToggleUI() {
  [...layerToggleEl.children].forEach(btn => btn.classList.toggle('active', btn.dataset.layer === mapLayer));
}
layerToggleEl.querySelectorAll('button').forEach(btn => {
  btn.addEventListener('click', () => {
    mapLayer = btn.dataset.layer;
    localStorage.setItem(MAP_LAYER_STORAGE_KEY, mapLayer);
    updateLayerToggleUI();
    render();
  });
});
updateLayerToggleUI();

// 2D (satellite/road hull view) and 3D (descent-path view) share one slot
// in .map-col-map now instead of living in two disconnected places on the
// page -- this is the single source of truth for which one is visible.
// Not persisted in localStorage (unlike mapLayer) -- no established local
// preference for this yet, and 2D is the safer, lighter-weight default to
// land on for a plain revisit regardless of what was picked last session.
// URL-shareable though (?view=3d, see buildPermalinkParams()) -- explicit
// only, same "don't pin defaults into a link" convention as deploy/hour/
// railangle, not read against any stored fallback the way mapLayer is.
// Corrected against the real state.mode once it's known (initFromData()
// below) -- 3D only supports byAltitude, same one-way fallback a live
// setMode() click already applies, kept consistent for a URL landing
// directly on an unsupported combination.
let mapViewMode = URL_PARAMS.get('view') === '3d' ? '3d' : '2d';
const mapViewToggleEl = document.getElementById('map-view-toggle');
const map3dToggleBtn = mapViewToggleEl.querySelector('button[data-mode="3d"]');
const map3dToggleBtnTitle = map3dToggleBtn.title;
const mapFrame2d = document.getElementById('map-frame-2d');
const mapFrame3d = document.getElementById('map-frame-3d');
const descent3dHintTitle = document.getElementById('descent3d-hint-title');
const descent3dHintEl = document.getElementById('descent3d-hint');
function updateMapViewModeUI() {
  const is3d = mapViewMode === '3d';
  [...mapViewToggleEl.children].forEach(btn => btn.classList.toggle('active', btn.dataset.mode === mapViewMode));
  // 3D has never supported byTime -- renderDescent3D()'s own guard
  // (descent3d.js) already falls back to an explanatory empty state there,
  // but that leaves the whole .map-view-wrap collapsed to almost nothing
  // (neither frame has real content/height), which read as "the map
  // disappeared" rather than "this combination isn't supported" (reported
  // directly). Disabling the button here prevents ever reaching that state
  // by clicking; the URL-bootstrap correction (initFromData()) and
  // setMode()'s own forced-2d fallback below independently cover landing on
  // or switching to byTime while already in 3D.
  // state is still null at the one call site that runs before initFromData()
  // has set it up (line ~1900, below) -- optional chaining, not a truthy
  // guard block, since "not yet loaded" and "loaded, not byTime" both mean
  // the same thing here (not disabled).
  const timeDisabled = state?.mode === 'byTime';
  map3dToggleBtn.disabled = timeDisabled;
  map3dToggleBtn.title = timeDisabled ? 'Not available in "By time of day" mode' : map3dToggleBtnTitle;
  mapFrame2d.style.display = is3d ? 'none' : '';
  mapFrame3d.style.display = is3d ? '' : 'none';
  descent3dHintTitle.style.display = is3d ? '' : 'none';
  descent3dHintEl.style.display = is3d ? '' : 'none';
  // Guarded, not a hard reference -- descent3d.js defines these, but
  // app.js shouldn't break if that file is ever missing/fails to load.
  // Only needs a nudge on switching TO 3d -- app.js's own render()/
  // applyIsolation() hooks already keep it live once visible. Default view
  // applied BEFORE the render, not after -- so the first paint in 3D
  // already reflects Top instead of flashing the oblique default for one
  // frame first (see path3dApplyDefaultViewIfUnset()'s own comment).
  if (is3d && typeof path3dApplyDefaultViewIfUnset === 'function') path3dApplyDefaultViewIfUnset();
  if (is3d && typeof renderDescent3D === 'function') renderDescent3D();
}
mapViewToggleEl.querySelectorAll('button').forEach(btn => {
  btn.addEventListener('click', () => {
    if (btn.dataset.mode === mapViewMode) return;
    mapViewMode = btn.dataset.mode;
    updateMapViewModeUI();
    // Not part of a full render() (mapViewMode doesn't affect the 2D SVG's
    // own content, just which frame + the 3D canvas, both already handled
    // above) -- just the address-bar sync, same minimal call the layer
    // toggle would need too if it didn't already ride along on its own
    // render() call for an unrelated reason (swapping ground imagery).
    syncUrl();
  });
});
updateMapViewModeUI();

// --- legal-disclaimer collapse: requested directly, the full paragraph was
// "taking up way too much space" -- collapsed to one summary line by
// default, same chevron-toggle idiom weatherPanelCollapsed/the toggle just
// above already use. Not persisted -- a "just for this look" preference.
const legalDisclaimerEl = document.getElementById('legal-disclaimer');
const legalDisclaimerSummary = document.getElementById('legal-disclaimer-summary');
const legalDisclaimerChevron = document.getElementById('legal-disclaimer-chevron');
function toggleLegalDisclaimer() {
  const expanded = legalDisclaimerEl.classList.toggle('expanded');
  legalDisclaimerSummary.setAttribute('aria-expanded', String(expanded));
  legalDisclaimerChevron.classList.toggle('collapsed', !expanded);
}
legalDisclaimerSummary.addEventListener('click', toggleLegalDisclaimer);
legalDisclaimerSummary.addEventListener('keydown', evt => {
  if (evt.key === 'Enter' || evt.key === ' ') { evt.preventDefault(); toggleLegalDisclaimer(); }
});

// --- fullscreen map toggle: requested directly, at every screen size --
// expands .map-view-wrap to fill the viewport (position:fixed, see
// app.css), collapses back on a second click. Self-contained -- no JS
// resize handling needed, zoomAt()/renderDescent3D()'s ResizeObserver both
// already re-measure their own box fresh on demand regardless of why it
// changed size.
let mapPaneExpanded = false;
const mapViewWrapEl = document.getElementById('map-view-wrap');
const mapFullscreenToggleBtn = document.getElementById('map-fullscreen-toggle');
mapFullscreenToggleBtn.addEventListener('click', () => {
  mapPaneExpanded = !mapPaneExpanded;
  mapViewWrapEl.classList.toggle('fullscreen-active', mapPaneExpanded);
  mapFullscreenToggleBtn.setAttribute('aria-expanded', String(mapPaneExpanded));
  mapFullscreenToggleBtn.title = mapPaneExpanded ? 'Collapse map back to normal view' : 'Expand map to full screen';
});

// --- hide-map-controls toggle: 2026-08 correction -- this used to hide the
// Launch Site/Date/View row above the map (see CHANGELOG), reported
// directly as wrong: "It's supposed be positioned near the map and hide
// the controls over the map." Lives next to the fullscreen toggle now and
// toggles .controls-hidden on .map-view-wrap, which hides the layer
// toggle, zoom buttons (+ hint), rail-angle dial, and altitude slider via
// app.css -- the widgets that actually overlay the map image. Deliberately
// leaves the burn-ban chip (a safety status, not a control) and this same
// corner's own 2D/3D/fullscreen switches alone. Not persisted -- same
// session-only idiom as mapPaneExpanded/weatherPanelCollapsed.
let mapControlsHidden = false;
const mapControlsToggleBtn = document.getElementById('map-controls-toggle-btn');
mapControlsToggleBtn.addEventListener('click', () => {
  mapControlsHidden = !mapControlsHidden;
  mapViewWrapEl.classList.toggle('controls-hidden', mapControlsHidden);
  mapControlsToggleBtn.setAttribute('aria-expanded', String(!mapControlsHidden));
  mapControlsToggleBtn.title = mapControlsHidden ? 'Show map controls' : 'Hide map controls (layer, zoom, rail angle, altitude)';
});

// --- permalink copy button: the URL bar is kept live-synced for
// site/mode/hour/deploy/rate/alt (see syncUrl()), but NOT the launch date by
// default -- clicking this button is itself the explicit "give me a durable
// link to exactly this" ask, so it always includes the currently-selected
// date regardless, and flips dateExplicitlyChosen so the address bar starts
// keeping it too from here on. ---
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

// --- rail angle: compass-dial widget (heading + magnitude) -----------------
// Recomputes the shifted zone/points client-side (see railShiftFt()) rather
// than reloading data -- railAngleDeg/railHeadingDeg are the only things
// that change, everything else needed (raw points, ft_to_px_scale) is
// already in the currently-loaded DATA. Same range the old single slider
// had (0-25deg) -- not a new decision, just carried over.
const RAIL_ANGLE_MAX_DEG = 25;
const railAngleControl = document.getElementById('rail-angle-control');
const railDial = document.getElementById('rail-dial');
const railDialWindRay = document.getElementById('rail-dial-wind-ray');
const railDialThumb = document.getElementById('rail-dial-thumb');
const railDialAngleLabel = document.getElementById('rail-dial-angle-label');
const railHeadingInput = document.getElementById('rail-heading-input');
const railAngleInput = document.getElementById('rail-angle-input');
const railHeadingResetBtn = document.getElementById('rail-heading-reset');
const railAngleResetBtn = document.getElementById('rail-angle-reset');
const railWindReadout = document.getElementById('rail-wind-readout');

// Lives in .map-view-wrap now (shared by both the 2D and 3D frames, not
// nested inside #map-wrap), so #map-wrap's own pan handler can't capture
// its pointerdowns any more the way it originally could -- but this guard
// is kept anyway, defensively, as one delegated listener on the container
// (not one per child: the dial, both inputs, both reset buttons) rather
// than removed on the assumption the DOM structure never moves again. See
// the pad marker/altitude ticks/color-picker popover for the same class of
// fix where it's still load-bearing.
railAngleControl.addEventListener('pointerdown', evt => evt.stopPropagation());

// The readouts panel opens (not toggles) on any interaction with the dial
// itself -- pointerdown/keydown/focus all ADD .expanded rather than
// toggling it; a toggle here would make a second click-to-fine-tune
// immediately close the panel that same press just opened. Closing is a
// separate, single mechanism: click anywhere outside the whole control.
// Note: the dial's own pointerdown handler (below, near
// railDialFromClientXY()) also opens the panel on a first/collapsed press
// -- not duplicated here, since checking classList synchronously inside
// that one handler is what lets it tell "first press" (not yet expanded)
// from "already open, this press should drag" apart.
function openRailAnglePanel() { railAngleControl.classList.add('expanded'); }
railDial.addEventListener('focus', openRailAnglePanel);
document.addEventListener('click', evt => {
  if (!railAngleControl.contains(evt.target)) railAngleControl.classList.remove('expanded');
});

// Single choke point for every way the dial's value can change (drag, typed
// number, or a tick) -- always updates both the JS state and every piece of
// UI that reflects it, so none of those call sites can drift out of sync
// with each other. `commitHeading`/`commitAngle` default true -- false only
// for the live-tracking case (see updateRailDialUI()) where headingDeg is
// being displayed but shouldn't itself count as an explicit user choice.
function setRailAngle(angleDeg, headingDeg, commitHeading = true, commitAngle = true) {
  railAngleDeg = Math.max(0, Math.min(RAIL_ANGLE_MAX_DEG, Math.round(angleDeg)));
  if (commitAngle) railAngleExplicitlyChosen = true;
  if (commitHeading) {
    railHeadingDeg = ((Math.round(headingDeg) % 360) + 360) % 360;
    railHeadingExplicitlyChosen = true;
  }
  updateRailDialUI();
  render();
}

function updateRailDialUI() {
  const headingDeg = effectiveRailHeadingDeg();
  const frac = railAngleDeg / RAIL_ANGLE_MAX_DEG;
  const headingRad = headingDeg * Math.PI / 180;
  // Same screen convention CSS rotate()/the wind vane already use elsewhere
  // in this app -- 0deg = up = north, clockwise for positive degrees. `left`/
  // `top` here are the thumb's own CENTER (unlike the time slider's edge-
  // based math -- this widget is small/circular enough that a transform:
  // translate(-50%,-50%) centering trick is simpler and in no danger of the
  // bottom+transform combination bug documented on the 3D alt slider,
  // since nothing here is ALSO using `bottom`).
  railDialThumb.style.left = `${50 + frac * 50 * Math.sin(headingRad)}%`;
  railDialThumb.style.top = `${50 - frac * 50 * Math.cos(headingRad)}%`;
  railDial.setAttribute('aria-valuetext', `${Math.round(headingDeg)}° heading, ${railAngleDeg}° off vertical`);
  // Numeric magnitude, collapsed-dial only (hidden once expanded, see CSS)
  // -- requested directly, the thumb's own distance from center is hard to
  // read precisely at 56px. Always an upper corner, left or right chosen
  // from the SAME sin(headingRad) sign the thumb's own left% above uses --
  // sin>=0 means the thumb sits right-of-center (or dead center), so the
  // label goes left; sin<0 means the thumb's on the left, so the label
  // goes right. Opposite side from the thumb, always, regardless of
  // magnitude -- e.g. 45deg (thumb upper-right) puts this upper-left; a
  // heading anywhere in 270-359deg (thumb somewhere on the left half)
  // puts it upper-right.
  railDialAngleLabel.textContent = `${railAngleDeg}°`;
  railDialAngleLabel.classList.toggle('right', Math.sin(headingRad) < 0);
  // Inputs reflect the LIVE-TRACKED heading even when not explicitly chosen
  // -- per direction, showing the actual default value being used (not a
  // blank/placeholder) so a user can see exactly what "not set" currently
  // resolves to before deciding whether to override it.
  if (document.activeElement !== railHeadingInput) railHeadingInput.value = Math.round(headingDeg);
  if (document.activeElement !== railAngleInput) railAngleInput.value = railAngleDeg;
  railHeadingResetBtn.style.display = railHeadingExplicitlyChosen ? '' : 'none';
  // Angle has no "live-tracked" default the way heading does (it's a flat
  // 0) -- this button just means "you've moved this off 0, want it back?",
  // shown by the same railAngleExplicitlyChosen flag drag/typing already
  // set (see setRailAngle()).
  railAngleResetBtn.style.display = railAngleExplicitlyChosen ? '' : 'none';
  const wind = currentGroundWind();
  // Reference ray -- always the REAL ground wind's own direction (not
  // effectiveRailHeadingDeg(), which would just retrace the thumb whenever
  // heading isn't explicitly chosen). Only useful once there's a rail
  // angle worth aiming, i.e. once the user's touched the dial at all --
  // hidden entirely with no wind data to reference.
  if (wind) {
    railDialWindRay.style.display = '';
    railDialWindRay.style.transform = `translateX(-50%) rotate(${wind.directionDeg}deg)`;
  } else {
    railDialWindRay.style.display = 'none';
  }
  // Direction shown as a rotated arrow (same .wind-vane glyph/rotation
  // convention windVaneHTML() uses elsewhere), not a bare "@ 185°" -- per
  // direction, degrees alone don't read at a glance. Rotated by the RAW
  // "from" bearing here (not +180 like windVaneHTML's downwind arrows) so
  // it points the same way the dial's own thumb/ray do -- "drag the dial
  // to match this arrow" has to mean the same rotation in both places.
  const arrowRotation = wind ? Math.round(wind.directionDeg) : 0;
  railWindReadout.innerHTML = wind
    ? `Ground wind: ${Math.round(wind.speedMph)}mph <span class="wind-vane" style="transform:rotate(${arrowRotation}deg)" title="${arrowRotation}&deg;">&uarr;</span> ${compassDir(wind.directionDeg)}`
    : 'No ground wind data for this hour';
}

function railDialFromClientXY(clientX, clientY) {
  const rect = railDial.getBoundingClientRect();
  const dx = clientX - (rect.left + rect.width / 2);
  const dy = clientY - (rect.top + rect.height / 2);
  const dist = Math.hypot(dx, dy);
  const radius = rect.width / 2;
  const angleDeg = Math.min(RAIL_ANGLE_MAX_DEG, (dist / radius) * RAIL_ANGLE_MAX_DEG);
  // atan2(dx, -dy), not atan2(dy, dx) -- screen dy grows downward but a
  // compass heading of 0deg (north) points up (negative dy); this is the
  // same "clockwise from north, north=up" convention windVaneHTML()'s own
  // CSS rotate() already uses, just derived from a drag position instead of
  // applied to a fixed glyph.
  const headingDeg = ((Math.atan2(dx, -dy) * 180 / Math.PI) + 360) % 360;
  return { angleDeg, headingDeg };
}

// Collapsed, the dial is a 56px indicator, not a precision drag target --
// a thumb press there is too easy to fat-finger past the intended angle,
// especially on a phone. First press just opens/enlarges it (see
// .rail-angle-control.expanded .rail-dial in app.css -- CSS grows the
// same element to a real finger-sized target); dragging only takes effect
// on a press that lands once it's already open, i.e. a deliberate second
// touch, not the same gesture that opened it.
railDial.addEventListener('pointerdown', evt => {
  evt.preventDefault();
  if (!railAngleControl.classList.contains('expanded')) {
    openRailAnglePanel();
    return;
  }
  railDial.setPointerCapture(evt.pointerId);
  const move = e => {
    const { angleDeg, headingDeg } = railDialFromClientXY(e.clientX, e.clientY);
    setRailAngle(angleDeg, headingDeg);
  };
  const stop = () => {
    document.removeEventListener('pointermove', move);
    document.removeEventListener('pointerup', stop);
  };
  document.addEventListener('pointermove', move);
  document.addEventListener('pointerup', stop);
  move(evt);
});
railDial.addEventListener('keydown', evt => {
  const step = { ArrowUp: 1, ArrowRight: 1, ArrowDown: -1, ArrowLeft: -1 }[evt.key];
  if (step === undefined) return;
  evt.preventDefault();
  // Arrow keys nudge the MAGNITUDE only -- there's no natural "arrow key"
  // mapping for a 2D heading that wouldn't be confusing (which arrow spins
  // which way?); heading stays precisely settable via the typed input or
  // the drag itself.
  setRailAngle(railAngleDeg + step, effectiveRailHeadingDeg(), false);
});

// Typed numeric entry -- same "widget + typed number" pattern
// alt-custom-input already establishes alongside the altitude ladder,
// type="text"/inputmode="numeric" included (see that input's own comment
// for why, not type="number"). Same digit-stripping on every keystroke
// (pasted content included, since 'input' fires for that too) keeping the
// field always integer-clean rather than only cleaning up on commit;
// real clamping/validation still happens in the 'change' handlers below.
railHeadingInput.addEventListener('input', () => {
  const digitsOnly = railHeadingInput.value.replace(/\D/g, '');
  if (digitsOnly !== railHeadingInput.value) railHeadingInput.value = digitsOnly;
});
railAngleInput.addEventListener('input', () => {
  const digitsOnly = railAngleInput.value.replace(/\D/g, '');
  if (digitsOnly !== railAngleInput.value) railAngleInput.value = digitsOnly;
});
railHeadingInput.addEventListener('change', () => {
  const v = Number(railHeadingInput.value);
  if (!Number.isNaN(v)) setRailAngle(railAngleDeg, v, true, false);
  else updateRailDialUI(); // invalid entry -- just redraw back to the real value, no state change
});
railAngleInput.addEventListener('change', () => {
  const v = Number(railAngleInput.value);
  if (!Number.isNaN(v)) setRailAngle(v, effectiveRailHeadingDeg(), false, true);
  else updateRailDialUI();
});
// Only clears the HEADING back to live-tracking -- the magnitude is a
// separate standing preference (see railAngleDeg's own declaration),
// untouched by this button.
railHeadingResetBtn.addEventListener('click', () => {
  railHeadingDeg = null;
  railHeadingExplicitlyChosen = false;
  updateRailDialUI();
  render();
});
// Magnitude back to its own default (0, no shift) -- separate from the
// heading reset above, since the two are independent standing preferences
// (see railAngleDeg's own declaration).
railAngleResetBtn.addEventListener('click', () => {
  railAngleDeg = 0;
  railAngleExplicitlyChosen = false;
  updateRailDialUI();
  render();
});

// --- rocketry ascent-path sim: cross-origin embed --------------------------
// Real RK4 3D flight sim (github.com/EzraCc/rocketry, GPLv3), replacing this
// dial's own tan(angle) shift with a real simulated ascent path once a
// result comes back. Deliberately NOT vendored into this app -- rocketry
// ports OpenRocket's own GPLv3 algorithms, and bundling that code into this
// repo/runtime would make this app a combined work, forcing it GPLv3 too (or
// at minimum real licensing exposure) -- not something to take on as a side
// effect of integration convenience. Instead: a visible, interactive iframe
// embed, cross-origin, postMessage back and forth, zero code sharing. Full
// contract: .claude/plans/rocketry-flight-sim-integration.md.
//
// ?rocketryBase= override lets local dev point at a locally-running
// rocketry (its own Vite dev server) instead of the deployed site -- same
// override pattern this app already uses elsewhere for local-vs-prod
// differences (e.g. ?rocketryOrigin= was considered and dropped in favor of
// this single value, since the expected postMessage-sender origin is just
// derived from it below rather than tracked separately).
const ROCKETRY_EMBED_BASE = URL_PARAMS.get('rocketryBase') || 'https://ezracc.github.io/rocketry/';
const ROCKETRY_ORIGIN = new URL(ROCKETRY_EMBED_BASE).origin;

const ascentSimBtn = document.getElementById('ascent-sim-btn');
const ascentSimModal = document.getElementById('ascent-sim-modal');
const ascentSimModalInner = document.querySelector('.ascent-sim-modal-inner');
const ascentSimModalHeader = document.querySelector('.ascent-sim-modal-header');
const ascentSimFullscreenBtn = document.getElementById('ascent-sim-fullscreen');
const ascentSimIframe = document.getElementById('ascent-sim-iframe');
const ascentSimClose = document.getElementById('ascent-sim-close');
const ascentSimError = document.getElementById('ascent-sim-error');
const ascentSimLabel = document.getElementById('ascent-sim-label');

// `{rocketName, parseWarnings, stability, rocketConfig?, resultsByHour}`
// once a sim result has come back, else null -- `resultsByHour` is
// `{[hour]: [{model, ascentPath}, ...]}`, one entry per hour rocketry has
// actually returned data for (built up incrementally by the background
// prefetch below, see ASCENT_PREFETCH_HOURS's own comment in
// descent3d.js), NOT a flat `results` array any more (2026-08 rewrite --
// the old single-hour shape is why "when the time is switched, apogee
// doesn't change" was reported: nothing re-fetched a new hour, so the
// first-requested hour's result just stayed frozen regardless of where the
// time slider moved afterward). null is also the signal every ascent*
// consumer (descent3d.js) and drawPredictedApogeeMarker() below use to
// fall back to the plain railShiftFt() dial approximation, same role
// TEST_ASCENT_DATA played in this session's local-only prototype.
//
// `rocketConfig` (2026-08-16, rocketry's repeat-visit caching update,
// `rocketry/tmp/splashcast-caching-update.md`) is optional -- present only
// when rocketry has a cached rocket+motor config to attach, absent
// (`undefined`) otherwise. Its `label` (e.g. "LOC-IV X2 + AeroTech K400C")
// is the one field this side actually reads from it today (see the message
// listener below) -- everything else in that object (`rocketSource`,
// `motorId`, `overrides`) is for a possible future "remember the pick on
// splashcast's own side too" feature, explicitly deferred, not read here.
let ASCENT_RESULTS = null;

// Hidden iframe driving the background per-hour prefetch (2026-08) -- a
// SEPARATE element from the visible ascentSimIframe so an in-flight
// background reload never collides with (or gets torn down by) the
// visitor reopening the interactive panel to change rocket/motor.
// display:none, never shown to the visitor -- rocketry's own auto-restore/
// auto-run (rocket-cache.ts, splashcast-caching-update.md) is what makes
// this possible with zero UI: the SAME rocket+motor the visitor already
// picked interactively gets remembered via rocketry's own localStorage and
// re-simulated automatically on each reload, no new CHOICE made silently
// on the visitor's behalf -- the "always visible iframe" rule this
// integration was built around was specifically about preserving that
// choice (see this plan's own Context section), which stays fully
// interactive for the first pick; only the repeat computation for hours
// the visitor hasn't scrubbed to yet happens unattended, confirmed
// directly as an acceptable extension of that rule rather than a
// violation of it. Rocketry itself needed zero changes for this -- "they
// only digest what we send them" -- it's purely a splashcast-side
// orchestration of the SAME single-hour contract that already existed,
// repeated across the 0900-1500 window (deliberately hourly-only, not the
// 15-minute drag resolution the time slider otherwise supports -- "to
// help manage data bloat").
const ascentPrefetchIframe = document.createElement('iframe');
ascentPrefetchIframe.style.display = 'none';
document.body.appendChild(ascentPrefetchIframe);
let ascentPrefetchQueue = [];
let ascentPrefetchHour = null; // hour currently in flight via the prefetch iframe, or null
// Bumped on every fresh interactive result AND on reset -- an in-flight
// background request started under a PREVIOUS rocket/motor pick (or before
// a reset) must never write its response into a resultsByHour that no
// longer belongs to it. ascentPrefetchStop() bumps this without needing
// the response to actually arrive and get compared -- the queue is also
// cleared and the iframe src reset, so nothing is left pending anyway; the
// epoch exists for the rarer case where a response is already in flight
// (network/compute time) at the moment of the bump.
let ascentEpoch = 0;

function ascentPrefetchNext() {
  if (!ASCENT_RESULTS || !ascentPrefetchQueue.length) { ascentPrefetchHour = null; return; }
  ascentPrefetchHour = ascentPrefetchQueue.shift();
  const params = new URLSearchParams({
    embed: '1',
    windUrl: new URL(CURRENT_DATA_PATH, location.href).href,
    hour: String(ascentPrefetchHour),
    parentOrigin: location.origin,
    // Requested directly, 2026-08 -- rocketry's own auto-restore/auto-run
    // (see ascentPrefetchIframe's own comment) still gates on some real
    // user-interaction signal that a background load has none of; autoSend
    // tells it to skip waiting on that and auto-run immediately once the
    // cached rocket+motor is restored. Only ever sent on the HIDDEN
    // prefetch iframe -- the visible/interactive one (openAscentSimModal())
    // deliberately does NOT set this, since that load's whole point is a
    // real, visible, user-driven "Simulate" click (or the visitor picking
    // a different rocket/motor), not an auto-run.
    autoSend: '1',
  });
  ascentPrefetchIframe.src = `${ROCKETRY_EMBED_BASE}?${params}`;
}
// ASCENT_PREFETCH_HOURS (descent3d.js) minus whichever hour the interactive
// request already covered (no need to refetch that one) and minus any hour
// this capture doesn't actually publish wind data for (windProfileHours(),
// same real-hours source nearestPublishedHour() itself already trusts) --
// avoids a wasted round trip that would just come back as a
// rocketry:error for an hour that was never going to have data, on an
// older/incomplete capture that doesn't cover the full 8am-5pm range.
function ascentPrefetchStart(coveredHour) {
  ascentEpoch++;
  const published = new Set(windProfileHours());
  ascentPrefetchQueue = ASCENT_PREFETCH_HOURS.filter(h => h !== coveredHour && published.has(h));
  ascentPrefetchNext();
}
function ascentPrefetchStop() {
  ascentEpoch++;
  ascentPrefetchQueue = [];
  ascentPrefetchHour = null;
  ascentPrefetchIframe.src = '';
}

// Which hour the currently-open (or most recently opened) interactive
// request was built for -- the message listener uses this as the key for
// that result in ASCENT_RESULTS.resultsByHour, since rocketry's own
// success payload doesn't echo the hour back.
let ascentSimRequestedHour = null;

// Only built when the panel actually opens (not reactively on every
// render) -- rebuilding the iframe src on an unrelated state change (e.g.
// dragging the altitude slider while the panel is open) would reload the
// embed and throw away an in-progress rocket/motor pick over there.
function openAscentSimModal() {
  ascentSimError.style.display = 'none';
  // Discards any in-progress background prefetch for a PREVIOUS pick --
  // about to be superseded by whatever the visitor picks this time, so
  // there's no reason to let it keep computing hours for a config that's
  // either about to be confirmed again (rocketry's own cache absorbs that
  // redundancy cheaply) or about to change entirely (in which case this
  // work is simply wasted).
  ascentPrefetchStop();
  ascentSimRequestedHour = nearestPublishedHour(state.timeMinutes);
  const params = new URLSearchParams({
    embed: '1',
    windUrl: new URL(CURRENT_DATA_PATH, location.href).href,
    hour: String(ascentSimRequestedHour),
    parentOrigin: location.origin,
  });
  ascentSimIframe.src = `${ROCKETRY_EMBED_BASE}?${params}`;
  ascentSimModal.style.display = 'flex';
  // Every fresh open starts back at the default centered/900x800 layout,
  // not wherever a previous session left it dragged/resized/full-screened
  // to -- a dialog reopening in an unpredictable spot (or still off-screen
  // from an earlier drag) is worse than just always starting clean, and
  // nothing here was asked to persist that state across separate opens.
  ascentModalResetLayout();
}
// Clears whatever drag/resize/full-screen state a previous open/close
// cycle left behind -- plain inline styles (position/left/top/margin, set
// by the header-drag handler below) and the native `resize` handle's own
// inline width/height (set directly by the browser, not by this app's own
// code, but cleared the same way) both fall back to the CSS defaults the
// moment they're removed, no separate "remembered default" to restore.
function ascentModalResetLayout() {
  ascentSimModalInner.style.position = '';
  ascentSimModalInner.style.left = '';
  ascentSimModalInner.style.top = '';
  ascentSimModalInner.style.margin = '';
  ascentSimModalInner.style.width = '';
  ascentSimModalInner.style.height = '';
  ascentSimFullscreen = false;
  ascentSimModal.classList.remove('fullscreen-active');
  ascentSimFullscreenBtn.setAttribute('aria-expanded', 'false');
  ascentSimFullscreenBtn.title = 'Expand to full screen';
}

// --- draggable (by the header) + resizable (native CSS `resize`, no JS
// needed for that half) + full-screen-toggleable modal -- requested
// directly. Drag switches the panel from the CSS default (flex-centered
// by .ascent-sim-modal's own align-items/justify-content) to an explicit
// position:fixed anchored at wherever it was actually rendered at
// drag-start (via getBoundingClientRect()), so taking over never causes a
// visible jump -- same "read the current rendered position before
// overriding it" approach this app already uses for the 3D view's own
// orbit-drag delta tracking. setPointerCapture() on the header (not
// document) is what keeps move/up events routed here even while the
// cursor passes directly over the cross-origin iframe below mid-drag --
// the exact same fix this app's own 3D-canvas orbit/pan and 2D-map pan
// already rely on, not a new mechanism invented for this. ---
let ascentDragPointerId = null, ascentDragOffsetX = 0, ascentDragOffsetY = 0;
ascentSimModalHeader.addEventListener('pointerdown', evt => {
  if (ascentSimFullscreen || evt.target.closest('button')) return; // no drag while full-screen, and a header button click shouldn't also start one
  const rect = ascentSimModalInner.getBoundingClientRect();
  ascentSimModalInner.style.position = 'fixed';
  ascentSimModalInner.style.left = rect.left + 'px';
  ascentSimModalInner.style.top = rect.top + 'px';
  ascentSimModalInner.style.margin = '0';
  ascentDragOffsetX = evt.clientX - rect.left;
  ascentDragOffsetY = evt.clientY - rect.top;
  ascentDragPointerId = evt.pointerId;
  ascentSimModalHeader.setPointerCapture(evt.pointerId);
  ascentSimModalHeader.classList.add('dragging');
});
ascentSimModalHeader.addEventListener('pointermove', evt => {
  if (ascentDragPointerId !== evt.pointerId) return;
  const rect = ascentSimModalInner.getBoundingClientRect();
  // Clamped so at least a margin-wide strip of the header always stays
  // reachable on every edge -- same "don't let a draggable thing become
  // unreachable" principle MAX_PAD_MOVE_FT/the rail dial's own pitch clamp
  // already establish elsewhere in this app, just applied to screen-space
  // position instead of a data value.
  const margin = 40;
  const x = Math.max(margin - rect.width, Math.min(window.innerWidth - margin, evt.clientX - ascentDragOffsetX));
  const y = Math.max(0, Math.min(window.innerHeight - margin, evt.clientY - ascentDragOffsetY));
  ascentSimModalInner.style.left = x + 'px';
  ascentSimModalInner.style.top = y + 'px';
});
function ascentDragEnd() {
  ascentDragPointerId = null;
  ascentSimModalHeader.classList.remove('dragging');
}
ascentSimModalHeader.addEventListener('pointerup', ascentDragEnd);
ascentSimModalHeader.addEventListener('pointercancel', ascentDragEnd);

// Same CSS-class-toggle pattern #map-fullscreen-toggle already established
// for the map's own fullscreen button (mapPaneExpanded/.fullscreen-active,
// above) -- not the native Fullscreen API, and not a JS position/size
// override either: the CSS rule's own !important wins over whatever
// inline drag/resize state is currently set, and reverts to it cleanly
// the instant this class comes back off (see that rule's own comment).
let ascentSimFullscreen = false;
ascentSimFullscreenBtn.addEventListener('click', evt => {
  evt.stopPropagation();
  ascentSimFullscreen = !ascentSimFullscreen;
  ascentSimModal.classList.toggle('fullscreen-active', ascentSimFullscreen);
  ascentSimFullscreenBtn.setAttribute('aria-expanded', String(ascentSimFullscreen));
  ascentSimFullscreenBtn.title = ascentSimFullscreen ? 'Collapse back to normal size' : 'Expand to full screen';
});
// Pure "hide" -- no ASCENT_RESULTS change. Used both by the explicit
// close/reset flow below AND by the message listener's own success path
// (which auto-closes the modal once a result arrives, but obviously
// shouldn't then immediately discard the result it just received).
function closeAscentSimModal() {
  ascentSimModal.style.display = 'none';
  ascentSimIframe.src = '';
}
// The X button / click-away are the ONLY user-initiated close actions --
// always a full reset back to manual rail-angle mode, even if a result had
// already arrived in an earlier open/simulate cycle (a successful sim
// closes the modal itself via the message listener, a different code path
// that never reaches this function) -- opening the panel again is a
// deliberate "let me change this" action, so backing out of it with no new
// pick shouldn't leave a stale previous result silently still driving the
// map.
function resetAscentSim() {
  ASCENT_RESULTS = null;
  ascentPrefetchStop();
  railAngleControl.classList.remove('sim-active');
  railAngleControl.title = '';
  ascentSimLabel.style.display = 'none';
  ascentSimLabel.textContent = '';
  closeAscentSimModal();
  renderDescent3D();
  render();
}
ascentSimBtn.addEventListener('click', evt => { evt.stopPropagation(); openAscentSimModal(); });
ascentSimClose.addEventListener('click', resetAscentSim);
// Click-outside-the-inner-box closes too (the modal itself, not its inner
// content, fills the viewport) -- same "click away to close" convention
// every other popover/panel in this app already uses.
ascentSimModal.addEventListener('click', evt => {
  if (evt.target === ascentSimModal) resetAscentSim();
});

// Validates event.origin BEFORE touching payload contents at all -- the one
// real security-relevant piece of this feature (see the plan's own
// "Verification" section). Anything not from the exact rocketry origin this
// page's own iframe was pointed at is silently ignored, not just distrusted
// -- a same-origin-policy violation here would mean an unrelated page could
// spoof a "flight result" into this app.
window.addEventListener('message', evt => {
  if (evt.origin !== ROCKETRY_ORIGIN) return;
  const data = evt.data;
  if (!data || typeof data !== 'object') return;

  // Background prefetch responses (evt.source is the HIDDEN iframe, not
  // the visible one) are handled entirely separately from the interactive
  // path below -- no modal to close, no label/dial state to touch (those
  // were already set by the interactive result that kicked this queue
  // off), and no ascentSimError surface (a background hour failing to
  // simulate is silently skipped, not shown to the visitor -- it just
  // means that hour falls back to the nearest hour that DID succeed via
  // ascentResultsForHour()'s own nearest-available lookup). Guarded on
  // ASCENT_RESULTS/ascentPrefetchHour both being non-null -- either can go
  // null between issuing this request and its response arriving (a reset,
  // or a new interactive pick that already called ascentPrefetchStop()),
  // in which case this response no longer belongs to anything and is
  // simply dropped rather than corrupting whatever replaced it.
  if (evt.source === ascentPrefetchIframe.contentWindow) {
    if (data.type === 'rocketry:ascentResults' && ASCENT_RESULTS && ascentPrefetchHour !== null) {
      ASCENT_RESULTS.resultsByHour[ascentPrefetchHour] = data.results;
      renderDescent3D();
      render();
    }
    ascentPrefetchNext();
    return;
  }

  if (data.type === 'rocketry:ascentResults') {
    // resultsByHour, not a flat `results` -- see ASCENT_RESULTS' own
    // comment for why (2026-08 rewrite, "when the time is switched, apogee
    // doesn't change"). ascentSimRequestedHour (set in openAscentSimModal())
    // is the key rocketry's own payload doesn't otherwise carry.
    ASCENT_RESULTS = {
      rocketName: data.rocketName,
      parseWarnings: data.parseWarnings,
      stability: data.stability,
      rocketConfig: data.rocketConfig,
      resultsByHour: { [ascentSimRequestedHour]: data.results },
    };
    // Real per-rocket descent rates (and, when there's only one recovery
    // device, a real single-vs-dual deploy correction) -- see
    // applyDescentDevices()'s own comment. Rocket-level, not wind/hour-
    // level (same as rocketName/stability/rocketConfig above), so this
    // only needs to run once here, not repeated on every background
    // prefetch response.
    applyDescentDevices(data.descentDevices);
    railAngleControl.classList.add('sim-active');
    railAngleControl.title = 'Dial disabled -- a real ascent-path simulation result is active. Its own weathercocking physics already replaces the simple rail-angle shift for this apogee. Use the rocket icon to change or clear it.';
    // rocketConfig.label ("LOC-IV X2 + AeroTech K400C") is the human-
    // friendly rocket+motor string rocketry sends ready to display as-is;
    // it's optional (only present when rocketry has a cached config to
    // attach), so fall back to the plain rocketName (rocket only, no
    // motor) rather than showing nothing.
    const label = data.rocketConfig?.label || data.rocketName;
    if (label) {
      ascentSimLabel.textContent = label;
      ascentSimLabel.style.display = 'block';
    }
    closeAscentSimModal();
    // Both, not just one -- a message arriving after the page's own initial
    // synchronous render() already happened is the same async-timing shape
    // as the local prototype's fetch callback (descent3d.js's own comment
    // on this), and missed exactly the same way if only one dependent view
    // gets told: renderDescent3D() alone left the 2D map's own predicted-
    // apogee marker never re-checking ASCENT_RESULTS at all.
    renderDescent3D();
    render();
    // Background-fills the rest of the 0900-1500 window, same rocket+motor
    // -- requested directly ("we need to resend to splashcast and get a
    // new ascent profile" once the time slider moves), see
    // ascentPrefetchIframe's own comment for the full mechanism.
    ascentPrefetchStart(ascentSimRequestedHour);
  } else if (data.type === 'rocketry:error') {
    ascentSimError.textContent = data.message || 'Simulation failed.';
    ascentSimError.style.display = 'block';
  }
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
const timeColorPicker = document.getElementById('time-color-picker');
const timeColorReset = document.getElementById('time-color-reset');
zoneColorPicker.value = zoneBaseColor;
timeColorPicker.value = timeBaseColor;

function applyZoneBaseColor(hex) {
  zoneBaseColor = hex;
  ALT_COLORS_HEX = computeSequentialRamp(zoneBaseColor, DATA ? DATA.altitudes : [1000, 3000, 5000, 7000, 9000]);
  zoneColorPicker.value = zoneBaseColor;
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
function applyTimeBaseColor(hex) {
  timeBaseColor = hex;
  // DATA.hours, not a hardcoded literal -- see initFromData()'s own comment
  // on why (this capture's real checkpoints, which can differ from
  // whatever this file's own SPLASH_HOURS_LOCAL-matching assumption is).
  TIME_COLORS_HEX = computeSequentialRamp(timeBaseColor, DATA.hours);
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
  // Same reasoning as the pad-drag handler -- explicitly moving the pad
  // (even back to zero) breaks a pinned real-flight snap, so back out of
  // that comparison rather than leave it pointing at a pad that's no
  // longer where it claims.
  if (pinnedRealFlightIndex !== null) {
    pinnedRealFlightIndex = null;
    hideRealFlightBox();
    updateActiveRealFlightOverlay();
    setRealFlightComparing(hoveredRealFlightIndex !== null);
    padOffsetBeforeRealFlightSnap = null;
  }
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
    // Same selectedAlts Set applyIsolation() checks (including the same
    // customAlt bypass -- see that function's own comment for the bug this
    // fixed: a Specific-altitude point's own altitude is essentially never
    // a member of selectedAlts, since that Set only ever holds the
    // discrete ladder's own rungs). A point whose altitude got unchecked
    // shouldn't still show a tooltip on hover just because its zone-group
    // is hidden, not removed -- but that's only a real concept when
    // selectedAlts is actually what's driving visibility.
    // ASCENT_RESULTS is the same bypass, for the same reason: a real sim
    // apogee (resolveMapAltFt()) is essentially never exactly one of the
    // ladder's rungs either. Missing here was a real, confirmed bug --
    // applyIsolation() already had this bypass (so the marker itself drew
    // fine), but hovering it found isPointVisible() false, so showTooltip()'s
    // `nearby` filter came back empty and the tooltip opened with NO content
    // (display:block, blank) rather than not opening at all -- reads exactly
    // like "the popup doesn't work," for every real flight whose apogee
    // doesn't happen to land on 2000/4000/6000/8000/10000ft.
    return state.customAlt !== null || !!ASCENT_RESULTS || state.selectedAlts === null || state.selectedAlts.has(rp.altitude);
  } else {
    const active = state.isolatedHour ?? state.pinnedHour;
    return active === null || rp.hour === active;
  }
}

// Clamps to the viewport -- verified directly on a 375px-wide screen that
// an unclamped tooltip (the burn-ban one especially, whose feed_header line
// runs long) can extend ~70px past the right edge, effectively unreadable
// with no way to scroll to it. Must run AFTER innerHTML/display are set on
// the caller's side -- offsetWidth/offsetHeight need the real, current
// content to measure correctly, not whatever was in the tooltip before.
function positionTooltip(evt) {
  const margin = 8;
  const maxLeft = window.innerWidth - tooltip.offsetWidth - margin;
  const maxTop = window.innerHeight - tooltip.offsetHeight - margin;
  tooltip.style.left = Math.max(margin, Math.min(evt.clientX + 14, maxLeft)) + 'px';
  tooltip.style.top = Math.max(margin, Math.min(evt.clientY + 14, maxTop)) + 'px';
}

function showTooltip(evt, hoveredPt) {
  const nearby = renderedPoints.filter(rp => {
    if (!isPointVisible(rp)) return false;
    const dx = rp.px - hoveredPt.px, dy = rp.py - hoveredPt.py;
    return Math.sqrt(dx * dx + dy * dy) <= PROXIMITY_PX;
  });
  tooltip.style.display = 'block';
  tooltip.innerHTML = nearby.map(rp => {
    const dist = Math.sqrt(rp.x_ft * rp.x_ft + rp.y_ft * rp.y_ft);
    const whenPart = state.mode === 'byTime' ? ` &middot; ${hourAmPm(rp.hour)}`
      : state.mode === 'byHistory' ? ` &middot; ${leadDaysLabel(rp.capture_date, HISTORY.target_date)} (captured ${rp.capture_date})`
      : '';
    // One active rate for every point now, not a per-point fast/slow label
    // (see buildRateEditor()'s own comment) -- show the live fps values
    // from state.rateFps directly.
    const r = state.rateFps;
    const rateLabel = state.deploy === 'single' ? `${r.main} fps` : `${r.drogue}/${r.main} fps`;
    return `<div class="tt-row">${modelNameHTML(rp.model)} &middot; ${rateLabel}${whenPart}<br>` +
      `apogee ${rp.altitude.toLocaleString()} ft<br>` +
      `offset: ${rp.x_ft >= 0 ? '+' : ''}${rp.x_ft.toFixed(0)} ft E, ${rp.y_ft >= 0 ? '+' : ''}${rp.y_ft.toFixed(0)} ft N<br>` +
      `distance from pad: ${dist.toFixed(0)} ft</div>`;
  }).join('');
  positionTooltip(evt);
}
function hideTooltip() { tooltip.style.display = 'none'; }

// --- combined weather panel: rain + temperature + clouds, below the map ----
// (see splash_zones.py's build_rain_data()/build_temperature_data()/
// build_cloud_data()). One shared grid instead of three separate widgets --
// clouds used to be a map-corner overlay, rain/temp were full-width rows
// ABOVE the map pushing it down the page. The header row's 5 hourly columns
// (config.SPLASH_HOURS_LOCAL/DATA.hours -- 8/10/12/2/4) line up under one
// continuous time slider that doubles as the map's own hour selector (see
// addWeatherTimeSlider()) -- clouds only ever published exactly those 5
// hours, so there was never a second real hour set to reconcile, just one
// duplicated across two widgets (this panel + the old standalone
// #hour-toggle in .controls, long since removed -- see initFromData()/
// applyModeUI()).
// Waiver-aware, same as before: clouds collapse to just the altitude bands a
// site's own waiver actually reaches (DATA.cloud_relevant_layers), with
// "Show all altitudes" revealing the rest (dimmed) plus the independently-
// computed Total -- Total is never shown by default, at any site (even a
// 50k-waiver one where every band shows), since a whole-sky "wall of
// clouds" number commonly reads scary on a day where the altitudes a site
// can actually fly through are clear, discouraging people from prepping and
// showing up over nothing.
const CLOUD_MODELS = Object.keys(MODEL_COLORS_HEX);

// Weather-panel rows (clouds/rain/temp/wind) now respect the same model
// checkboxes the map's own drift paths/points already do, instead of
// always showing every model regardless of what's deselected -- one
// shared filter so a deselected model disappears everywhere at once, not
// just from the map. `state.selectedModels === null` is the same
// null-sentinel buildModelLegend() itself resolves to "every available
// model" -- treated the same way here for the (normally brief) window
// before that resolution has run.
function weatherPanelModels() {
  return CLOUD_MODELS.filter(m => state.selectedModels === null || state.selectedModels.has(m));
}
const CLOUD_LAYERS = [
  { key: 'high', label: 'High', sub: '26,200ft+' },
  { key: 'mid', label: 'Mid', sub: '9,800–26,200ft' },
  { key: 'low', label: 'Low', sub: '0–9,800ft' },
];
let weatherPanelCollapsed = false; // gates the whole panel now, not just clouds
let cloudAltitudesExpanded = URL_PARAMS.get('clouds') === 'all';

function isCloudHot(vals) {
  // "Tends to agree" = a majority of models that actually reported this
  // hour/layer put it at or above the safety-code threshold
  // (DATA.cloud_nogo_pct -- config.CLOUD_COVER_NOGO_PCT, Tripoli Unified
  // Safety Code 9-5/9-6), not an average of the raw values (a handful of
  // models near the line individually clearing it counts; one outlier
  // dragging a low-consensus mean over the line does not).
  const real = vals.filter(x => x.v !== null);
  if (!real.length) return false;
  const atOrAbove = real.filter(x => x.v >= DATA.cloud_nogo_pct).length;
  return atOrAbove / real.length >= 0.5;
}

// Ground-level wind row's tier scale -- DATA.wind_nogo_mph (config.
// WIND_SPEED_NOGO_MPH, Tripoli USC §9-3 / NAR Safety Code item 9's 20mph
// sustained-wind limit) is the ONE real cited number here, same standing as
// DATA.cloud_nogo_pct above. The two breakpoints below it are NOT codified
// -- just a graduated "getting worse" read (calm/breezy/strong) chosen for
// display, kept out of config.py specifically so nothing there implies a
// citation that doesn't exist. Landed on clean 5mph steps (0-9/10-14/
// 15-19/20+) rather than the original 0-7/8-15/16-19 split, per direction
// -- lines up with the bars' own 10/20mph dashed reference lines
// (addWindCell()'s own comment) so the same two numbers double as both a
// visual gridline and a tier boundary, instead of two unrelated scales
// sharing one chart. "Strong," not "gusty" -- this scale grades SUSTAINED
// speed, a real separate field from gust (shown per-model as each bar's
// own hollow-outline cap now, not a text suffix); "gusty" would misstate
// which number the color is actually about.
const WIND_TIER_YELLOW_MIN_MPH = 10;
const WIND_TIER_ORANGE_MIN_MPH = 15;
// Same majority-vote principle isCloudHot() already uses for clouds,
// generalized across all three breakpoints instead of one -- per direction,
// with a real example (hearne 08/08 15:00: GFS alone at 10mph, every other
// model at 7mph or below): a cell's tier used to be set by the single
// WORST (max) model's own number, so one outlier could shift the whole
// cell's color on its own. Now it's the most severe threshold at least
// half of the models that actually reported this hour agree it's reached
// -- a real majority (half or more, same >= 0.5 isCloudHot() uses) moves
// it, one disagreeing model does not. Checked from the most severe
// threshold down: each successive check is strictly harder to clear, so a
// red-majority is automatically also an orange-majority and a
// yellow-majority, and falling through is correct without re-deriving
// that relationship explicitly.
function windTierMajority(speeds) {
  if (!speeds.length) return null;
  const atOrAboveMajority = mph => speeds.filter(s => s >= mph).length / speeds.length >= 0.5;
  if (atOrAboveMajority(DATA.wind_nogo_mph)) return 'red';
  if (atOrAboveMajority(WIND_TIER_ORANGE_MIN_MPH)) return 'orange';
  if (atOrAboveMajority(WIND_TIER_YELLOW_MIN_MPH)) return 'yellow';
  return 'green';
}

// --- Temperature-based heat/cold warnings (2026-08) -------------------------
// No rocketry safety code addresses temperature -- these implement NWS's own
// published criteria instead (config.HEAT_INDEX_ADVISORY_F/WARNING_F,
// config.WIND_CHILL_FROSTBITE_F -- see config.py's own citation comments for
// the verbatim sources). Both formulas take ACTUAL temperature only
// (cell.actual), never .apparent -- DATA.temperature's own "apparent" field
// is Open-Meteo's Steadman/Australian-BOM Apparent Temperature, a genuinely
// different formula (also factors in solar radiation) that does not
// reproduce NWS's Heat Index or Wind Chill numbers for the same conditions
// (confirmed against NWS's own published example: 96F/65%RH is a 121F NWS
// Heat Index). Feeding a different formula's output against an NWS-labeled
// threshold would silently mislabel the guidance, so this always starts
// from raw actual temp + this hour's own humidity/wind speed.

// NWS Heat Index (Rothfusz regression), verified directly against
// wpc.ncep.noaa.gov/html/heatindex_equation.shtml. Per that page's own
// wording: "the simple formula is computed first and the result averaged
// with the temperature. If this heat index value is 80 degrees F or
// higher, the full regression equation ... is applied" -- the switch
// condition is that AVERAGE, not the simple formula's own value alone.
function heatIndexF(tF, rh) {
  if (tF === null || rh === null) return null;
  const simple = 0.5 * (tF + 61.0 + (tF - 68.0) * 1.2 + rh * 0.094);
  if ((simple + tF) / 2 < 80) return simple;
  let hi = -42.379 + 2.04901523 * tF + 10.14333127 * rh - 0.22475541 * tF * rh
    - 0.00683783 * tF * tF - 0.05481717 * rh * rh + 0.00122874 * tF * tF * rh
    + 0.00085282 * tF * rh * rh - 0.00000199 * tF * tF * rh * rh;
  if (rh < 13 && tF >= 80 && tF <= 112) {
    hi -= ((13 - rh) / 4) * Math.sqrt((17 - Math.abs(tF - 95)) / 17);
  } else if (rh > 85 && tF >= 80 && tF <= 87) {
    hi += ((rh - 85) / 10) * ((87 - tF) / 5);
  }
  return hi;
}

// NWS Wind Chill, verified directly against weather.gov/safety/cold-wind-
// chill-chart. Only defined for actual temp <=50F and wind >3mph -- NWS's
// own stated validity bounds, not this app's own choice -- returns null
// outside them rather than a number NWS itself doesn't define.
function windChillF(tF, mph) {
  if (tF === null || mph === null || tF > 50 || mph <= 3) return null;
  return 35.74 + 0.6215 * tF - 35.75 * Math.pow(mph, 0.16) + 0.4275 * tF * Math.pow(mph, 0.16);
}

// What "Feels like" should actually show for an hourly cell -- the SAME
// number tempRiskTier()'s warning badge is computed from, not Open-Meteo's
// own apparent_temperature (see the block comment above). Reported
// directly: showing a different number than what actually drives the
// badge means a user sees a warning appear without "Feels like" itself
// looking any more extreme than the hour before it -- confusing, and
// undermines trust that the badge means anything. >=80F/<=50F gates match
// NWS's own real convention exactly (heat index isn't a published NWS
// concept below 80F, wind chill isn't defined above 50F/calm wind, see
// windChillF's own comment) -- in between, NWS doesn't publish an
// adjusted figure at all, so this returns actual temperature unchanged,
// same as NWS would.
function nwsFeelsLikeF(tF, rh, mph) {
  if (tF === null) return null;
  if (tF >= 80 && rh !== null) return heatIndexF(tF, rh);
  if (tF <= 50 && mph !== null) {
    const wc = windChillF(tF, mph);
    if (wc !== null) return wc;
  }
  return tF;
}

// Same majority-vote shape as windTierMajority()/isCloudHot() -- for each
// model present in both cells, classifies THAT model's own heat index (if
// its actual temp is warm enough for one to apply) or wind chill (if cold
// enough), then majority-votes (>=50% of models agree, same threshold
// every other tier check here uses) across models. Heat and cold can't
// both apply to the same model's own reading (the >=80F/<=50F gates below,
// same as nwsFeelsLikeF()'s own domain split, don't overlap), so the
// result is always at most one of the three tiers. The >=80F gate here
// (not just "humidity is available") matters for more than correctness --
// it's what keeps this in lockstep with nwsFeelsLikeF()'s own gate, so a
// vote here always corresponds to the exact number "Feels like" goes on to
// display for that same model/hour (see addTempCell()).
function tempRiskTier(hourlyCell, windHourCell) {
  if (!hourlyCell || !windHourCell) return null;
  const heatVotes = [];
  const chillVotes = [];
  for (const m in hourlyCell) {
    const cell = hourlyCell[m];
    const windCell = windHourCell[m];
    if (!cell || cell.actual === null) continue;
    if (cell.actual >= 80 && cell.humidity !== null) {
      heatVotes.push(heatIndexF(cell.actual, cell.humidity));
    }
    const wc = (windCell && windCell.speed !== undefined) ? windChillF(cell.actual, windCell.speed) : null;
    if (wc !== null) chillVotes.push(wc);
  }
  const majority = (votes, threshold, cmp) => votes.length > 0 && votes.filter(v => cmp(v, threshold)).length / votes.length >= 0.5;
  if (majority(heatVotes, DATA.heat_index_warning_f, (v, t) => v >= t)) return 'heat-warning';
  if (majority(heatVotes, DATA.heat_index_advisory_f, (v, t) => v >= t)) return 'heat-advisory';
  if (majority(chillVotes, DATA.wind_chill_frostbite_f, (v, t) => v <= t)) return 'frostbite';
  return null;
}

// Per-tier copy for the click-to-open popup (.temp-risk-badge/#temp-risk-box
// below) -- practical guidance, not a repeat of the numeric threshold
// already visible in the cell itself.
const TEMP_RISK_COPY = {
  'heat-advisory': {
    title: 'Heat Advisory',
    body: 'A majority of models put the heat index at or above 100&deg;F. Stay hydrated, take breaks in shade, and limit prolonged outdoor exposure.',
  },
  'heat-warning': {
    title: 'Excessive Heat Warning',
    body: 'A majority of models put the heat index at or above 105&deg;F. Avoid outdoor activity during peak hours if possible, hydrate aggressively, and watch for heat exhaustion/heat stroke signs.',
  },
  'frostbite': {
    title: 'Frostbite risk',
    body: 'A majority of models put the wind chill at or below -19&deg;F -- NWS’s own frostbite chart puts exposed skin at risk of freezing in about 30 minutes at that wind chill. Wear layers, limit exposed skin, and watch for numbness.',
  },
};

function tempRiskBoxHTML(tier) {
  const copy = TEMP_RISK_COPY[tier];
  return `<div class="rf-title">${copy.title}</div>${copy.body}`;
}

// Same click-to-open/position-near-cursor/click-away-to-close mechanism
// showRealFlightBox()/positionBoxAvoiding() already established (see those
// functions further down) -- reused here rather than reinvented, same
// touch-first reasoning (no native title-attribute tooltip, no per-id-fixed
// .info-btn/data-hint). openTempRiskBadge tracks which badge (if any) is
// currently showing its box, so a second click on that SAME badge toggles
// it closed instead of just re-opening the same content.
let openTempRiskBadge = null;
const tempRiskBox = document.getElementById('temp-risk-box');
function showTempRiskBox(evt, tier) {
  if (openTempRiskBadge === evt.currentTarget) { hideTempRiskBox(); return; }
  tempRiskBox.innerHTML = tempRiskBoxHTML(tier);
  // Own left-border color per tier (real-flight-box's default --real-
  // flight-color pink is that marker's own established meaning elsewhere
  // in the app -- reusing it here would misleadingly tie a heat/cold
  // warning to "real flight data").
  tempRiskBox.className = 'real-flight-box tier-' + tier;
  const [x, y] = positionBoxAvoiding(evt, []);
  tempRiskBox.style.left = x + 'px';
  tempRiskBox.style.top = y + 'px';
  tempRiskBox.style.display = 'block';
  openTempRiskBadge = evt.currentTarget;
}
function hideTempRiskBox() {
  tempRiskBox.style.display = 'none';
  openTempRiskBadge = null;
}
// Only ever sees clicks that didn't land on a badge itself -- each badge's
// own click handler stopPropagation()s, same fix #real-flight-box's own
// document-level listener already needed.
document.addEventListener('click', () => {
  if (openTempRiskBadge !== null) hideTempRiskBox();
});

// Same click-to-open/toggle-closed-on-repeat-click/click-away mechanism
// as showTempRiskBox() above, for the cloud row's own warning badge
// (addCloudRow()) -- a separate box/state pair rather than generalizing
// the temp one, since its content is a per-cell model breakdown built by
// the caller (cellContentHTML() in addCloudRow()), not a fixed lookup
// table keyed by tier the way TEMP_RISK_COPY is.
let openCloudRiskBadge = null;
const cloudRiskBox = document.getElementById('cloud-risk-box');
function showCloudRiskBox(evt, html) {
  if (openCloudRiskBadge === evt.currentTarget) { hideCloudRiskBox(); return; }
  cloudRiskBox.innerHTML = html;
  const [x, y] = positionBoxAvoiding(evt, []);
  cloudRiskBox.style.left = x + 'px';
  cloudRiskBox.style.top = y + 'px';
  cloudRiskBox.style.display = 'block';
  openCloudRiskBadge = evt.currentTarget;
}
function hideCloudRiskBox() {
  cloudRiskBox.style.display = 'none';
  openCloudRiskBadge = null;
}
document.addEventListener('click', () => {
  if (openCloudRiskBadge !== null) hideCloudRiskBox();
});

// Shared by addCloudRow() and addRainCell() -- three states per model,
// split across two flex rows (barsAbove/barsBelow) so zero gets real room
// to sit BELOW the baseline -- the one part of the cell that can never be
// mistaken for "a small measured amount," since rain/cloud-% can't be
// negative and nothing else ever renders there:
//   null (no data) -> hollow dashed mark, above the line (unchanged spot).
//   0 (confirmed zero) -> a small flat square BELOW the line.
//   nonzero -> a colored bar ABOVE the line, bottom flush with it (square
//     bottom corners, not rounded), height via the caller's own heightPct
//     (cloud's is the value itself, rain's is scaled against
//     RAIN_BAR_MAX_IN).
// Both rows always get one slot per model, even when empty, so per-model
// columns stay aligned between the two rows. `opacity` (only ever passed by
// addRainCell -- cloud has no separate confidence figure) fades a real bar
// by how likely it is, not just how much: a model that's 9% confident in
// 0.02in is a materially different claim than one that's confident, and the
// bar shouldn't look identical either way.
function appendValueBar(barsAbove, barsBelow, m, v, heightPct, opacity) {
  const above = document.createElement('div');
  const below = document.createElement('div');
  if (v === null) {
    above.className = 'cloud-bar bar-nodata';
    below.className = 'cloud-bar-slot';
  } else if (v === 0) {
    above.className = 'cloud-bar-slot';
    below.className = 'cloud-bar bar-zero';
    below.style.background = MODEL_COLORS_HEX[m];
  } else {
    above.className = 'cloud-bar';
    above.style.height = heightPct + '%';
    above.style.background = MODEL_COLORS_HEX[m];
    if (opacity !== undefined) above.style.opacity = opacity;
    below.className = 'cloud-bar-slot';
  }
  barsAbove.appendChild(above);
  barsBelow.appendChild(below);
}

// Full-width sub-heading for the cloud rows -- clouds is the only one of
// the three metrics here that's more than one row (Low/Mid/High, +Total
// when expanded), so unlike Rain/Temp's single-cell row label it gets a
// real heading of its own, spanning every column the same way
// .cloud-layer-divider already does. "Show all altitudes" lives here now,
// not in the panel's own header -- it's a clouds-specific control, not a
// whole-panel one. "showing Low"/"showing Low + Mid" lives here too, not
// tacked onto the site-name/waiver line above the grid -- it's telling you
// which of THIS heading's rows you're looking at, not a site-level fact.
function addCloudSectionHeading(grid, shownLabel) {
  const heading = document.createElement('div');
  heading.className = 'weather-section-heading';
  const label = document.createElement('span');
  label.textContent = `☁️ Clouds — showing ${shownLabel}`;
  heading.appendChild(label);
  const expandBtn = document.createElement('button');
  expandBtn.className = 'cloud-expand-btn';
  expandBtn.type = 'button';
  expandBtn.textContent = cloudAltitudesExpanded ? 'Show waiver altitudes only' : 'Show all altitudes';
  expandBtn.addEventListener('click', () => { cloudAltitudesExpanded = !cloudAltitudesExpanded; renderWeatherPanel(); syncUrl(); });
  heading.appendChild(expandBtn);
  grid.appendChild(heading);
}

function addCloudRow(grid, layerKey, label, sub, beyondWaiver) {
  const lab = document.createElement('div');
  lab.className = 'cloud-layer-label' + (beyondWaiver ? ' beyond-waiver' : '');
  lab.innerHTML = `<b>${label}</b>${sub}`;
  grid.appendChild(lab);

  DATA.hours.forEach(h => {
    const cell = document.createElement('div');
    const vals = weatherPanelModels().map(m => ({ m, v: DATA.clouds[m][h] ? DATA.clouds[m][h][layerKey] : null }));
    const real = vals.filter(x => x.v !== null);
    const hot = isCloudHot(vals);
    cell.className = 'cloud-cell' + (hot ? ' cell-hot' : '');

    const baseline = document.createElement('div');
    baseline.className = 'baseline';
    cell.appendChild(baseline);

    if (real.length) {
      const nums = real.map(x => x.v);
      const lo = Math.min(...nums), hi = Math.max(...nums);
      const rangeNum = document.createElement('div');
      rangeNum.className = 'range-num';
      rangeNum.textContent = lo === hi ? `${lo}%` : `${lo}–${hi}%`;
      cell.appendChild(rangeNum);
    }

    const bars = document.createElement('div');
    bars.className = 'bars';
    cell.appendChild(bars);
    // DATA.cloud_nogo_pct dashed reference line -- same idea as Wind's own
    // 10/20mph lines (.chart-ref-line, shared class -- see its own CSS
    // comment), just no scaling division needed since cloud values are
    // already raw 0-100 percentages. Appended before the per-model bars
    // below so it paints behind them, not on top.
    const refLine = document.createElement('div');
    refLine.className = 'chart-ref-line';
    refLine.style.bottom = DATA.cloud_nogo_pct + '%';
    bars.appendChild(refLine);
    const barsBelow = document.createElement('div');
    barsBelow.className = 'bars-below';
    cell.appendChild(barsBelow);
    vals.forEach(({ m, v }) => appendValueBar(bars, barsBelow, m, v, v));

    if (!real.length) {
      const nodata = document.createElement('div');
      nodata.className = 'no-data';
      cell.appendChild(nodata);
    }

    // Extracted so the hover tooltip (desktop, mousemove below) and the
    // click-to-open popup (badge, added just below) show IDENTICAL
    // content from one place -- same "one content builder, two triggers"
    // precedent this session's own descent-path tooltip/ascent-box split
    // already established (descent3d.js).
    function cellContentHTML() {
      // Two-column grid (name | %), not one row per model -- a stacked list
      // with a divider between every single model line read as a long,
      // slow-to-scan column of near-identical rows. Right-aligning the %
      // column lets the numbers themselves line up for a quick vertical read.
      // Models at/above the nogo threshold are bolded in place instead of
      // re-listed by name in the footer -- same information, once.
      const rows = vals.map(({ m, v }) => {
        const isHigh = v !== null && v >= DATA.cloud_nogo_pct;
        return `<div class="tt-model-name">${modelNameHTML(m)}</div>` +
          `<div class="tt-model-pct${isHigh ? ' pct-high' : ''}">${v === null ? 'no data' : v + '%'}</div>`;
      }).join('');
      // `hot` is the same isCloudHot() flag the cell's own warning badge
      // uses (majority of reporting models >=50%) -- not a separate rule,
      // so the hover state and the at-rest cell always agree.
      const badge = hot ? '<span class="cloud-badge" style="margin-right:5px;">&#9888;</span>' : '';
      return `<div class="tt-cloud-grid">${rows}</div>` +
        `<div class="tt-cloud-footer" style="color:var(--text-muted);">${badge}${label} · ${hourAmPm(h)}</div>`;
    }

    // One listener on the whole cell (not per-bar) so models with identical
    // or near-identical values are all listed together, never hidden behind
    // whichever mark happens to be under the cursor -- same real .tooltip
    // used everywhere else in the viewer.
    cell.addEventListener('mousemove', evt => {
      tooltip.innerHTML = cellContentHTML();
      tooltip.style.display = 'block';
      positionTooltip(evt);
    });
    cell.addEventListener('mouseleave', hideTooltip);

    // Real click-to-open badge, requested directly ("I'm not getting a
    // popup when clicking the warning icon") -- the warning icon here used
    // to be `.cloud-cell.cell-hot::after`, a CSS pseudo-element with no
    // click handler at all (same limitation the temp row's own
    // .temp-risk-badge was built to replace for ITS warning icon, per that
    // feature's own comment: "not the... pseudo-element, which can't carry
    // a click handler"). Clouds just never got the same upgrade at the
    // time. Same click-to-open/toggle-closed-on-repeat-click/click-away
    // mechanism showTempRiskBox() already established, reused directly
    // rather than reinvented -- only the content differs (this cell's own
    // per-model breakdown, via cellContentHTML() above, not a fixed
    // 3-message tier table).
    if (hot) {
      const badge = document.createElement('button');
      badge.type = 'button';
      badge.className = 'cloud-risk-badge';
      badge.innerHTML = '&#9888;';
      badge.title = 'Majority of models at/above the safety-code cloud-cover threshold';
      badge.addEventListener('click', evt => {
        evt.stopPropagation();
        showCloudRiskBox(evt, cellContentHTML());
      });
      cell.appendChild(badge);
    }

    grid.appendChild(cell);
  });
}

function hourAmPm(h) {
  const period = h < 12 ? 'am' : 'pm';
  return `${h % 12 || 12}${period}`;
}
// Any amount at/above this fills the bar -- real per-hour rain at a launch
// site rarely approaches this; a launch is a clear no-go well before the bar
// would need to go higher, so there's no value in a taller scale that just
// leaves everything looking small on an ordinary rainy hour.
const RAIN_BAR_MAX_IN = 0.3;
// Floor for chance-scaled bar opacity (see appendValueBar()'s opacity
// param) -- a bar fades toward this as probability drops, but never past
// it, so even a 9%-chance reading stays visibly present as real data.
const RAIN_MIN_OPACITY = 0.4;
// Rain drops from every real published hourly column (config.py's
// RAIN_WINDOW_START/END_HOUR_LOCAL, currently 8am-4pm) to the handful
// shared with clouds/the time selector (DATA.hours) -- see
// renderWeatherPanel()'s own comment for why. A shower can land entirely
// inside a dropped hour, so a plain "keep the checkpoints, drop the rest"
// sample would silently lose it. Instead each kept column buckets the real
// hours trailing up to it (non-overlapping, same "sum of what led up to
// this checkpoint" convention Prior day/Morning already use) -- see
// bucketRainCell().
//
// Computed live off DATA.hours + DATA.rain.hourly's own real keys, NOT a
// hardcoded per-checkpoint literal -- that was the original design and it
// broke in production: config.py's SPLASH_HOURS_LOCAL changed mid-session
// (9/11/13/15/17 -> 8/10/12/14/16) and every already-published capture's
// DATA.hours still had the OLD checkpoint values, so the new hardcoded
// object had no entry for them at all -- RAIN_HOUR_BUCKETS[9] was
// `undefined`, and `.forEach` on that threw immediately on page load for
// every real capture published before the change. Deriving the buckets
// from whatever DATA.hours/DATA.rain.hourly actually contain makes this
// self-adapting to any checkpoint set, old or new, with no lookup table to
// keep in sync by hand.
function rainHourBucket(h) {
  const checkpoints = [...DATA.hours].sort((a, b) => a - b);
  const idx = checkpoints.indexOf(h);
  const prevCheckpoint = idx > 0 ? checkpoints[idx - 1] : -Infinity;
  const isLast = idx === checkpoints.length - 1;
  const realHours = Object.keys(DATA.rain.hourly).map(Number).sort((a, b) => a - b);
  // Every other checkpoint's bucket is bounded above by its own value; the
  // LAST checkpoint's bucket absorbs everything remaining through the end
  // of the published window (matches the original hand-written buckets'
  // own trailing-catch-all behavior for whichever checkpoint was last).
  return realHours.filter(rh => rh > prevCheckpoint && (isLast || rh <= h));
}

// Sums `amount` across a bucket's hours (rain is additive) and takes the
// MAX `chance` (probabilities don't sum -- max surfaces the bucket's real
// spike, e.g. a 60% chance at 10am buried between two 20%-chance samples at
// 9/11, instead of averaging it away or hiding it behind whichever sample
// happened to land nearby). A model missing from one hour in the bucket
// just doesn't contribute that hour -- doesn't block the sum, doesn't count
// as a zero.
function bucketRainCell(h) {
  const out = {};
  CLOUD_MODELS.forEach(m => {
    let amountSum = null, chanceMax = null;
    rainHourBucket(h).forEach(hh => {
      const c = DATA.rain.hourly[hh]?.[m];
      if (!c) return;
      if (c.amount !== null) amountSum = (amountSum ?? 0) + c.amount;
      if (c.chance !== null) chanceMax = chanceMax === null ? c.chance : Math.max(chanceMax, c.chance);
    });
    out[m] = { amount: amountSum, chance: chanceMax };
  });
  return out;
}

// The real underlying window a bucketed column covers (e.g. "8am-9am"),
// shown only in the tooltip footer -- not worth a second label line on the
// cell itself now that the column header above it already says "9am".
function rainBucketWindowLabel(h) {
  const hours = rainHourBucket(h);
  return hours.length > 1 ? `${hourAmPm(hours[0])}–${hourAmPm(hours[hours.length - 1])}` : '';
}

// One rain data cell -- no per-cell label any more (the shared header row
// above already carries "Prior day"/"Morning"/9am-3pm once for the whole
// panel; see addWeatherHeaderRow()). Same per-model-bar-per-cell pattern as
// clouds (real-zero-vs-no-data distinction, one tooltip per cell), not a
// line graph: precip is bursty/discontinuous hour to hour (checked against
// real data -- models routinely disagree on which hour carries a spike),
// so connecting points with a line would imply a gradual ramp that isn't
// real.
function addRainCell(grid, cellData, tooltipLabel, tooltipWindow) {
  const cell = document.createElement('div');
  cell.className = 'cloud-cell rain-cell';

  const baseline = document.createElement('div');
  baseline.className = 'baseline';
  cell.appendChild(baseline);

  const vals = weatherPanelModels().map(m => ({ m, ...(cellData[m] || { amount: null, chance: null }) }));
  const real = vals.filter(x => x.amount !== null);

  if (real.length) {
    const nums = real.map(x => x.amount);
    const lo = Math.min(...nums), hi = Math.max(...nums);
    const rangeNum = document.createElement('div');
    rangeNum.className = 'range-num';
    rangeNum.textContent = lo === hi ? `${lo.toFixed(2)} in` : `${lo.toFixed(2)}-${hi.toFixed(2)} in`;
    cell.appendChild(rangeNum);
  }

  const bars = document.createElement('div');
  bars.className = 'bars';
  cell.appendChild(bars);
  const barsBelow = document.createElement('div');
  barsBelow.className = 'bars-below';
  cell.appendChild(barsBelow);
  vals.forEach(({ m, amount, chance }) => {
    const heightPct = amount === null ? null : Math.min(100, (amount / RAIN_BAR_MAX_IN) * 100);
    // Floored at RAIN_MIN_OPACITY, not scaled all the way to 0 -- a low-
    // chance bar should still read as "real reported data," just clearly
    // less likely, not fade out to nothing. No probability at all (ARPEGE)
    // stays full-opacity -- "unknown confidence" isn't the same claim as
    // "low confidence" and shouldn't look like it.
    const opacity = chance === null ? 1 : Math.max(RAIN_MIN_OPACITY, chance / 100);
    appendValueBar(bars, barsBelow, m, amount, heightPct, opacity);
  });

  if (!real.length) {
    const nodata = document.createElement('div');
    nodata.className = 'no-data';
    cell.appendChild(nodata);
  }

  // Same tooltip element as everywhere else, 3 columns (model | chance |
  // amount) instead of cloud's 2 -- chance is "n/a" rather than "no data"
  // for a model that never reports precipitation_probability at all
  // (ARPEGE on live Open-Meteo), distinct from a hole in an hour's amount
  // data (genuinely missing, beyond that model's horizon).
  cell.addEventListener('mousemove', evt => {
    const rows = vals.map(({ m, amount, chance }) =>
      `<div class="tt-model-name">${modelNameHTML(m)}</div>` +
      `<div class="tt-model-pct">${chance === null ? 'n/a' : chance + '%'}</div>` +
      `<div class="tt-model-pct">${amount === null ? 'no data' : amount.toFixed(2) + ' in'}</div>`
    ).join('');
    tooltip.innerHTML =
      `<div class="tt-rain-grid"><div class="tt-rain-head">Model</div><div class="tt-rain-head">Chance</div><div class="tt-rain-head">Amount</div>${rows}</div>` +
      `<div class="tt-cloud-footer" style="color:var(--text-muted);">${tooltipLabel}${tooltipWindow ? ' (' + tooltipWindow + ')' : ''} rain forecast</div>`;
    tooltip.style.display = 'block';
    positionTooltip(evt);
  });
  cell.addEventListener('mouseleave', hideTooltip);

  grid.appendChild(cell);
}

// Full-width heading, same treatment as Clouds' own addCloudSectionHeading()
// -- per direction, Rain/Temp used to fold their label into the first data
// cell of their one row instead (weather-row-label), which read as a much
// lower heading level than Clouds' real full-width row and packed the
// whole panel tighter than it needed to be.
function addRainSectionHeading(grid) {
  const heading = document.createElement('div');
  heading.className = 'weather-section-heading';
  heading.textContent = '🌧️ Rain';
  grid.appendChild(heading);
}

function addRainRow(grid) {
  // Empty -- Rain only ever has this one row, so its own label lives on
  // addRainSectionHeading() above instead of repeating here. Still a real
  // grid cell (not omitted) so this row keeps the same first-column
  // alignment every other row in the grid has.
  const lab = document.createElement('div');
  lab.className = 'weather-row-label';
  grid.appendChild(lab);

  const hourKeys = Object.keys(DATA.rain.hourly).map(Number).sort((a, b) => a - b);
  addRainCell(grid, DATA.rain.prior_day, 'Prior day', '');
  addRainCell(grid, DATA.rain.morning, 'Morning', `12am–${hourAmPm(hourKeys[0])}`);

  DATA.hours.forEach(h => {
    addRainCell(grid, bucketRainCell(h), hourAmPm(h), rainBucketWindowLabel(h));
  });
}

// --- temperature row -- see splash_zones.py's build_temperature_data().
// No fixed bar scale like rain's (temperature swings dramatically by
// season/site -- a Texas August capture and a South Dakota April one have
// nothing in common -- so a fixed range would either flatten one into a
// sliver or clip the other); scale is computed fresh from this capture's
// own data each render (every real value across the row, padded/rounded to
// a clean 5-degree span) and used only to normalize bar height -- not shown
// as its own axis any more (each cell's own range-num already gives exact
// numbers, and the shared header/reduced column count leaves less room for
// a dedicated axis column). No "confirmed zero" state either (unlike rain
// amount or cloud %, a temperature reading has no natural zero point, so
// there's nothing for appendValueBar()'s null/zero/real split to do here --
// just null-or-real).
//
// Each cell carries "actual" (raw temperature_2m) and, for hourly cells,
// "humidity" -- a toggle switches the bars between that and a "feels
// like" figure, default on since "does this feel dangerous" is closer to
// what a launch director actually needs than raw air temperature alone.
// Lives inline in the row label now instead of owning a full header row.
//
// "Feels like" is nwsFeelsLikeF() (NWS Heat Index/Wind Chill, actual+
// humidity/wind) for the 5 hourly columns, NOT Open-Meteo's own
// "apparent" field (a different formula, Steadman/Australian BOM's -- see
// the block comment above tempRiskTier()) -- reported directly: showing a
// different number than what the warning badge is actually computed from
// meant a badge could appear without "Feels like" looking any more
// extreme than the hour before, undermining trust that it means anything.
// prior_day/morning still show Open-Meteo's own "apparent" (no per-model
// humidity published there, see build_temperature_data()'s own comment) --
// harmless, since neither of those two columns ever carries a warning
// badge to misalign against.
let tempShowApparent = URL_PARAMS.get('temp') !== 'actual';

function addTempCell(grid, cellData, scaleMin, scaleMax, tooltipLabel, windHourCell) {
  const cell = document.createElement('div');
  // windHourCell is only ever passed for the DATA.hours hourly cells (see
  // addTempRow() below) -- prior_day/morning cells have no "humidity"
  // field at all (build_temperature_data()'s own comment: no single
  // well-defined RH reading for a window-MAX aggregate), so tempRiskTier()
  // only ever runs where the data actually supports it.
  const riskTier = windHourCell ? tempRiskTier(cellData, windHourCell) : null;
  cell.className = 'cloud-cell temp-cell' + (riskTier ? ' tier-' + riskTier : '');

  const baseline = document.createElement('div');
  baseline.className = 'baseline';
  cell.appendChild(baseline);

  const vals = weatherPanelModels().map(m => {
    const c = cellData[m];
    if (!tempShowApparent) return { m, v: c?.actual ?? null };
    if (windHourCell) {
      // Hourly: NWS-sourced, same value tempRiskTier() votes with -- see
      // tempShowApparent's own comment for why this isn't Open-Meteo's
      // "apparent" field.
      const windSpeed = windHourCell[m]?.speed ?? null;
      return { m, v: c ? nwsFeelsLikeF(c.actual, c.humidity ?? null, windSpeed) : null };
    }
    return { m, v: c?.apparent ?? null }; // prior_day/morning -- Open-Meteo's own figure, no humidity here to do better
  });
  const real = vals.filter(x => x.v !== null);

  if (riskTier) {
    const badge = document.createElement('button');
    badge.type = 'button';
    badge.className = 'temp-risk-badge tier-' + riskTier;
    badge.innerHTML = '&#9888;';
    badge.title = TEMP_RISK_COPY[riskTier].title;
    badge.addEventListener('click', evt => {
      evt.stopPropagation();
      showTempRiskBox(evt, riskTier);
    });
    cell.appendChild(badge);
  }

  if (real.length) {
    const nums = real.map(x => x.v);
    const lo = Math.min(...nums), hi = Math.max(...nums);
    const rangeNum = document.createElement('div');
    rangeNum.className = 'range-num';
    rangeNum.textContent = lo === hi ? `${Math.round(lo)}°` : `${Math.round(lo)}-${Math.round(hi)}°`;
    cell.appendChild(rangeNum);
  }

  const bars = document.createElement('div');
  bars.className = 'bars';
  cell.appendChild(bars);
  const span = scaleMax - scaleMin;
  vals.forEach(({ m, v }) => {
    const bar = document.createElement('div');
    if (v === null) {
      bar.className = 'cloud-bar bar-nodata';
    } else {
      bar.className = 'cloud-bar';
      bar.style.height = Math.max(0, Math.min(100, ((v - scaleMin) / span) * 100)) + '%';
      bar.style.background = MODEL_COLORS_HEX[m];
    }
    bars.appendChild(bar);
  });

  if (!real.length) {
    const nodata = document.createElement('div');
    nodata.className = 'no-data';
    cell.appendChild(nodata);
  }

  cell.addEventListener('mousemove', evt => {
    const rows = vals.map(({ m, v }) =>
      `<div class="tt-model-name">${modelNameHTML(m)}</div>` +
      `<div class="tt-model-pct">${v === null ? 'no data' : Math.round(v) + '°F'}</div>`
    ).join('');
    const modeLabel = tempShowApparent ? 'feels like' : 'actual';
    tooltip.innerHTML = `<div class="tt-cloud-grid">${rows}</div>` +
      `<div class="tt-cloud-footer" style="color:var(--text-muted);">${tooltipLabel} temperature forecast (${modeLabel})</div>`;
    tooltip.style.display = 'block';
    positionTooltip(evt);
  });
  cell.addEventListener('mouseleave', hideTooltip);

  grid.appendChild(cell);
}

// Full-width heading, same treatment as Clouds' own addCloudSectionHeading()
// -- per direction, matching Rain's own addRainSectionHeading() above. The
// Feels like/Actual toggle moves up here with it (was inline in the old
// one-cell row label) -- same "panel-specific control lives in its
// section's own heading, not the whole panel's" placement Clouds' own
// "Show all altitudes" button already established.
function addTempSectionHeading(grid) {
  const heading = document.createElement('div');
  heading.className = 'weather-section-heading';
  const label = document.createElement('span');
  label.textContent = '🌡️ Temp';
  heading.appendChild(label);
  // Radio-style pair (same .toggle-btns visual language as TIME/View/
  // Deploy in the controls bar, scaled down) -- both options always
  // labeled and visible, active one highlighted, so the current state is
  // read directly rather than decoded from what the OTHER option's link
  // text says.
  const modeToggle = document.createElement('div');
  modeToggle.className = 'temp-mode-toggle';
  [['apparent', 'Feels like'], ['actual', 'Actual']].forEach(([mode, text]) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = text;
    const isActive = (mode === 'apparent') === tempShowApparent;
    btn.className = isActive ? 'active' : '';
    btn.addEventListener('click', () => {
      if (isActive) return;
      tempShowApparent = (mode === 'apparent');
      renderWeatherPanel();
      syncUrl();
    });
    modeToggle.appendChild(btn);
  });
  heading.appendChild(modeToggle);
  grid.appendChild(heading);
}

function addTempRow(grid) {
  // Empty -- see addRainRow()'s own comment on why (Temp only ever has this
  // one row too, its label lives on addTempSectionHeading() above instead).
  const lab = document.createElement('div');
  lab.className = 'weather-row-label';
  grid.appendChild(lab);

  const field = tempShowApparent ? 'apparent' : 'actual';
  const allVals = [];
  Object.values(DATA.temperature.prior_day).forEach(c => { if (c[field] !== null) allVals.push(c[field]); });
  Object.values(DATA.temperature.morning).forEach(c => { if (c[field] !== null) allVals.push(c[field]); });
  Object.values(DATA.temperature.hourly).forEach(models => {
    Object.values(models).forEach(c => { if (c[field] !== null) allVals.push(c[field]); });
  });
  let scaleMin = 32, scaleMax = 100; // fallback for the (unlikely) all-missing case
  if (allVals.length) {
    scaleMin = Math.floor(Math.min(...allVals) / 5) * 5;
    scaleMax = Math.ceil(Math.max(...allVals) / 5) * 5;
    if (scaleMin === scaleMax) { scaleMin -= 5; scaleMax += 5; } // a perfectly flat reading still needs a real span to divide by
  }

  addTempCell(grid, DATA.temperature.prior_day, scaleMin, scaleMax, 'Prior day');
  addTempCell(grid, DATA.temperature.morning, scaleMin, scaleMax, 'Morning');
  DATA.hours.forEach(h => {
    addTempCell(grid, DATA.temperature.hourly[h], scaleMin, scaleMax, hourAmPm(h), DATA.wind.hourly[h]);
  });
}

// --- ground-level wind row -- see splash_zones.py's build_wind_data() and
// windTierMajority()'s own comment above. The one row here with a real
// go/no-go line drawn in it (DATA.wind_nogo_mph, the red tier).
//
// Bar height is scaled against a fixed ceiling (WIND_BAR_MAX_MPH), not a
// per-capture range like temperature's -- unlike temperature, wind speed
// has a real, meaningful fixed reference point (DATA.wind_nogo_mph) that a
// floating per-capture scale would obscure: a "high" bar should always
// mean the same thing (visually approaching/at the code limit) across
// every capture, not just "the windiest reading THIS capture happened to
// have." 25mph gives DATA.wind_nogo_mph (20) real headroom to still read
// as distinctly-less-than-full, without stretching the everyday 0-20mph
// range down into a cramped bottom sliver of the cell the way a taller
// ceiling would. A speed number itself is still clamped to this ceiling
// (a sustained reading past it would be an extraordinary outlier), but a
// GUST cap is deliberately NOT clamped -- per direction, if gust pushes
// past the scale, the cap should visibly extend off the top of the graph
// rather than being invisibly capped at 100%, since "this model's gust
// blew straight through the reference scale" is itself real information
// worth seeing, not something to quietly hide.
const WIND_BAR_MAX_MPH = 25;

// Small rotated arrow glyph pointing DOWNWIND -- the direction the wind
// (and therefore the rocket) is actually traveling TOWARD -- replacing a
// raw "@ 149°" number, per direction. Deliberately NOT the traditional
// physical weather-vane convention (a real vane's pointer faces where the
// wind comes FROM); confirmed as a real, reported point of confusion: a
// vane pointing SW for a "from-207°" reading looked contradictory next to
// a rocket path actually drifting NE, since most readers expect an arrow
// to show where something is going, not where it came from. Rotating by
// direction+180 instead points the arrow the same way the rocket
// actually drifts, matching the path on screen instead of fighting the
// reader's own intuition about what an arrow means.
// The displayed number (title=) shows that SAME downwind bearing now too,
// not Open-Meteo's own raw "from" convention -- per direction, the number,
// the arrow, and the actual rocket path all need to agree with each other,
// not each tell a technically-correct but differently-conventioned story.
// DATA.wind's own stored `direction` field is untouched (still the raw
// Open-Meteo "from" bearing simulateDrift()/interpWind() correctly expect
// as their input) -- only this display-layer conversion changed, nothing
// simulation-facing.
// CSS rotate() is clockwise for positive degrees, same as compass bearings
// (measured clockwise from north) -- an arrow drawn pointing up (0deg =
// north, unrotated) rotated by direction+180 lands exactly on the
// downwind compass bearing with no extra math needed. Shared by app.js's
// own wind row tooltip and descent3d.js's point tooltip -- one glyph/
// rotation convention to get right, not two.
function windVaneHTML(directionDeg) {
  const towardRounded = Math.round((directionDeg + 180) % 360);
  return `<span class="wind-vane" style="transform:rotate(${towardRounded}deg)" title="${towardRounded}&deg;">&uarr;</span>`;
}

function addWindCell(grid, cellData, tooltipLabel) {
  const cell = document.createElement('div');

  const baseline = document.createElement('div');
  baseline.className = 'baseline';
  cell.appendChild(baseline);

  const vals = weatherPanelModels().map(m => ({ m, ...(cellData[m] || { speed: null, gust: null, direction: null }) }));
  const real = vals.filter(x => x.speed !== null);
  // Majority vote across models, not the single worst (max) one -- see
  // windTierMajority()'s own comment.
  const tier = windTierMajority(real.map(x => x.speed));
  // cell-hot alongside tier-red (not instead of it) on the red tier -- still
  // gets the shared ⚠ badge (a real cited limit deserves that same signal
  // clouds' own hot cells use), but tier-red's own, more specific color
  // rule (below) wins over cell-hot's shared amber background/baseline --
  // see that rule's own comment for why amber stopped being reused here.
  cell.className = 'cloud-cell wind-cell' + (tier ? ' tier-' + tier : '') + (tier === 'red' ? ' cell-hot' : '');

  if (real.length) {
    const nums = real.map(x => x.speed);
    const lo = Math.min(...nums), hi = Math.max(...nums);
    // No more " · G16" suffix here -- that was a single maxed gust across
    // every model with no way to say which one it came from, and is now
    // genuinely redundant with the per-model gust cap each bar shows
    // directly (see the vals.forEach() below).
    // Unit suffix -- clouds/rain/temp's own range-num text already reads
    // "0-43%"/"0.00 in"/"82-92°"; wind's own was the one left bare with no
    // unit at all, per direction.
    const rangeNum = document.createElement('div');
    rangeNum.className = 'range-num';
    rangeNum.textContent = (lo === hi ? `${Math.round(lo)}` : `${Math.round(lo)}-${Math.round(hi)}`) + ' mph';
    cell.appendChild(rangeNum);
  }

  const bars = document.createElement('div');
  bars.className = 'bars';
  cell.appendChild(bars);
  // 10/20mph dashed reference lines -- WIND_BAR_MAX_MPH's own scale (see
  // its own comment) has no axis labeled anywhere else; appended before
  // the model columns below so they paint behind the bars, not on top.
  [10, 20].forEach(mph => {
    const line = document.createElement('div');
    line.className = 'chart-ref-line';
    line.style.bottom = Math.min(100, (mph / WIND_BAR_MAX_MPH) * 100) + '%';
    bars.appendChild(line);
  });
  vals.forEach(({ m, speed, gust }) => {
    // Wrapper per model, not a bare .cloud-bar -- holds the solid
    // sustained bar plus (when there's real gust data above it) a hollow
    // outline "cap" continuing upward to the gust height, both absolutely
    // positioned within it (see .wind-bar-col's own CSS comment for why
    // not a reversed flex column). Explicit height:100% on the wrapper
    // (CSS) is what lets both children's percentage heights below
    // actually resolve against the real 44px .bars zone.
    const col = document.createElement('div');
    col.className = 'wind-bar-col';
    const speedPct = speed === null ? 0 : Math.max(0, Math.min(100, (speed / WIND_BAR_MAX_MPH) * 100));
    const bar = document.createElement('div');
    if (speed === null) {
      bar.className = 'cloud-bar bar-nodata';
    } else {
      bar.className = 'cloud-bar';
      bar.style.height = speedPct + '%';
      bar.style.background = MODEL_COLORS_HEX[m];
    }
    col.appendChild(bar);
    // Gust cap: hollow outline from `speed` up to `gust`, this model's own
    // color, only when gust is real data ABOVE its own sustained figure.
    // Real per-model data can report gust BELOW sustained at low wind
    // speeds (a genuine model quirk, kept as the model's own number rather
    // than "corrected" -- see build_wind_data()'s own comment) -- skipped
    // entirely rather than clamped, since a zero/negative-height cap would
    // just be visually broken. Deliberately NOT clamped to the .bars zone's
    // own height at the top -- see WIND_BAR_MAX_MPH's own comment for why
    // a gust past the scale extends off the graph instead of being
    // invisibly capped at 100%; .wind-bar-col/.bars both allow overflow
    // for exactly this (see their own CSS comments).
    if (speed !== null && gust !== null && gust > speed) {
      const capPct = Math.max(0, ((gust - speed) / WIND_BAR_MAX_MPH) * 100);
      const cap = document.createElement('div');
      cap.className = 'wind-gust-cap';
      cap.style.bottom = speedPct + '%';
      cap.style.height = capPct + '%';
      cap.style.borderColor = MODEL_COLORS_HEX[m];
      col.appendChild(cap);
    }
    bars.appendChild(col);
  });

  if (!real.length) {
    const nodata = document.createElement('div');
    nodata.className = 'no-data';
    cell.appendChild(nodata);
  }

  cell.addEventListener('mousemove', evt => {
    // Own 4-column grid (Model | Sustained | Gust | Direction), same
    // headed-grid convention the rain cell's own .tt-rain-grid already
    // uses (see addRainCell()) -- per direction, easier to scan down one
    // column at a time than parsing "10 mph (G8) <arrow>" as one run-on
    // string per model.
    const rows = vals.map(({ m, speed, gust, direction }) => {
      const isHigh = speed !== null && speed >= DATA.wind_nogo_mph;
      return `<div class="tt-model-name">${modelNameHTML(m)}</div>` +
        `<div class="tt-model-pct${isHigh ? ' pct-high' : ''}">${speed === null ? 'no data' : Math.round(speed) + ' mph'}</div>` +
        `<div class="tt-model-pct">${gust === null ? '—' : Math.round(gust) + ' mph'}</div>` +
        `<div class="tt-model-pct">${direction === null ? '—' : windVaneHTML(direction)}</div>`;
    }).join('');
    tooltip.innerHTML =
      '<div class="tt-wind-grid"><div class="tt-wind-head">Model</div><div class="tt-wind-head">Sustained</div>' +
      `<div class="tt-wind-head">Gust</div><div class="tt-wind-head">Direction</div>${rows}</div>` +
      `<div class="tt-cloud-footer" style="color:var(--text-muted);">${tooltipLabel} ground-level wind (10m AGL)</div>`;
    tooltip.style.display = 'block';
    positionTooltip(evt);
  });
  cell.addEventListener('mouseleave', hideTooltip);

  grid.appendChild(cell);
}

// Full-width heading, same treatment as Clouds/Rain/Temp's own
// addCloudSectionHeading()/addRainSectionHeading()/addTempSectionHeading()
// -- per direction. No extra per-section control here (unlike Clouds' "Show
// all altitudes" or Temp's actual/feels-like toggle), just the label.
function addWindSectionHeading(grid) {
  const heading = document.createElement('div');
  heading.className = 'weather-section-heading';
  heading.textContent = '💨 Wind';
  grid.appendChild(heading);
}

function addWindRow(grid) {
  // Empty -- own label lives on addWindSectionHeading() above now, same
  // convention addRainRow()/addTempRow() already use.
  const lab = document.createElement('div');
  lab.className = 'weather-row-label';
  grid.appendChild(lab);
  // No Prior day/Morning data -- per direction, wind doesn't carry forward
  // the way rain (day-before precip context) or temp (morning trend) do; a
  // launch-day go/no-go call only cares about wind during the actual launch
  // window. Real blank cells for those two columns (not a wide spanning
  // label) so the row keeps the same 7-column rhythm every other row has
  // and the 4 hourly cells read as obviously lined up under their own
  // header buttons, not just placed correctly by coincidence of the grid
  // math.
  grid.appendChild(document.createElement('div'));
  grid.appendChild(document.createElement('div'));

  DATA.hours.forEach(h => {
    addWindCell(grid, DATA.wind.hourly[h], hourAmPm(h));
  });
}

// --- time-of-day slider (replaces the old row of weather-hour-btn buttons) -
// Continuous horizontal drag at 15-min resolution, landing exactly (no
// blend) on any real published hour via a tick -- modeled directly on
// descent3d.js's own altitude slider (continuous drag + fixed tick landing
// points, already solved in this exact codebase), axis flipped: `left` +
// translateX(-50%)-equivalent math here, never paired with a `top`-relative
// translateY (see that slider's own CSS comment for the bug class that
// combination causes). Unlike that slider, no cross-control sync is needed
// -- this is the ONLY thing that ever sets state.timeMinutes, so a drag or
// tick click just sets it directly, no priority-chain/override to maintain.
// Ticks come from sliderRealHours() (every real hour ANY weather field has
// data for -- often wider than just the wind-profile hours, see its own
// comment), not the panel's own sparse DATA.hours -- major ticks (labeled,
// = DATA.hours) double as this row's column headers, matching the buttons
// they replace; minor ticks (unlabeled dashes, the rest of
// sliderRealHours() when a capture has them) are still real, exact,
// blend-free landing points, just not a labeled panel column.
// The track's own 0%/100% edges -- NOT DATA.hours[0]/[last] directly.
// The slider spans exactly N real grid columns (grid-column: span N,
// N=DATA.hours.length, set per-dataset in addWeatherTimeSlider() -- see
// its own CSS comment), each an equal-width box, and a column's CENTER
// sits at (i+0.5)/N of the box, not i/(N-1) -- so anchoring the
// track's own edges exactly at the first/last major hour would leave every
// tick sitting off-center from its own column (confirmed by direct
// measurement: major ticks landed 34px off their real column's center on a
// 458px-wide slider). Expanding the range by half a column-width (half the
// gap between adjacent major hours) on each side is what makes tick i's
// time-proportional fraction equal (i+0.5)/5 exactly, landing it on its
// column's true center -- verified after this fix: tick/column centers
// matched to the pixel (previously off by up to 34px).
function timeSliderMinMax() {
  const majorHours = DATA.hours;
  const columnSpanMin = majorHours.length > 1
    ? (majorHours[majorHours.length - 1] - majorHours[0]) / (majorHours.length - 1) * 60
    : 120;
  const margin = columnSpanMin / 2;
  const marginMin = majorHours[0] * 60 - margin;
  const marginMax = majorHours[majorHours.length - 1] * 60 + margin;
  // Widened further, if needed, to guarantee every real hour in
  // sliderRealHours() (rain/temperature can extend past wind_profiles'
  // own range -- see its own comment) still lands at a valid, on-track
  // fraction -- the margin above is sized for column-centering the major
  // ticks specifically, not guaranteed to already cover a wider real range.
  const realHours = sliderRealHours();
  return [
    Math.min(marginMin, realHours[0] * 60),
    Math.max(marginMax, realHours[realHours.length - 1] * 60),
  ];
}

function timeFromClientX(slider, clientX) {
  const rect = slider.getBoundingClientRect();
  const [min, max] = timeSliderMinMax();
  const frac = rect.width > 0 ? Math.max(0, Math.min(1, (clientX - rect.left) / rect.width)) : 0;
  return Math.round((min + frac * (max - min)) / 15) * 15;
}

// Per direction, the zone re-renders live on every intermediate drag step
// now, not just on commit -- same "watch it update in real time" appeal
// the 3D altitude slider already has. Cheap enough to do unthrottled here:
// zoneFor()'s own simulation is memoized per timeMinutes (a re-visited
// 15-min step during a drag hits that cache), and render() itself is
// already called on plenty of other frequent interactions in this app
// (every altitude-range-slider pixel, for one) without a perf complaint.
// `commit` still exists to distinguish the drag's actual endpoint
// (pointerup, a tick click, an arrow-key step) from an intermediate step --
// syncAltCustomUI() (reflects the value into the sidebar's "Specific
// altitude" status line) stays commit-only since it's a cheap DOM text
// update with no reason to run 60x/sec, but render() runs either way.
function setSliderTime(sliderEls, timeMinutes, commit) {
  // Rounded to the nearest 15 minutes, not raw pixel/1-minute precision --
  // a freeform drag implies false precision at 1-minute resolution, per
  // direction (mirrors path3dSetAlt()'s own "round to nearest 100ft, not
  // 1ft" reasoning). A no-op for a tick's own exact value.
  //
  // Clamped to sliderRealHours()' own real range, NOT timeSliderMinMax()'s
  // margin-expanded one -- that wider range exists purely to make
  // column-center tick math work (see its own comment), not to make more
  // of the clock actually reachable. Clamping the thumb itself to that
  // wider range would let it sit somewhere past the real data where
  // profilesForTime() has already silently clamped back to the nearest
  // real wind-profile hour -- a real, confirmed UX mismatch (readout says
  // a time with no real data behind it at all, map stays flat at the
  // nearest real hour) that not allowing the drag there in the first place
  // avoids outright. sliderRealHours(), not windProfileHours() specifically
  // -- see its own comment: rain/temperature have real hours wind_profiles
  // doesn't, and a user should still be able to reach those on the slider.
  const hours = sliderRealHours();
  const [min, max] = [hours[0] * 60, hours[hours.length - 1] * 60];
  const rounded = Math.round(timeMinutes / 15) * 15;
  state.timeMinutes = Math.max(min, Math.min(max, rounded));
  hourExplicitlyChosen = true;
  updateTimeSliderUI(sliderEls, state.timeMinutes);
  if (commit) syncAltCustomUI();
  render();
}

function updateTimeSliderUI(sliderEls, timeMinutes) {
  const { slider, thumb, readout } = sliderEls;
  // Position math uses the margin-expanded range (column-center alignment,
  // see timeSliderMinMax()'s own comment) -- ARIA min/max use the real
  // reachable range instead (windProfileHours()), so a screen reader never
  // reports bounds the control can't actually be dragged/stepped to (see
  // setSliderTime()'s own comment on why the thumb itself is clamped
  // tighter than the visual track).
  const [posMin, posMax] = timeSliderMinMax();
  const frac = posMax > posMin ? (timeMinutes - posMin) / (posMax - posMin) : 0;
  // `left` on .weather-time-thumb IS its own left EDGE, not its center --
  // offset by the thumb's own 9px radius to convert a center position into
  // a left-edge one. NOT inset by a further 9px margin on each end the way
  // descent3d.js's alt slider is (see its own comment) -- that inset exists
  // there because ITS ticks really can sit at the raw 0%/100% edges
  // (altitude 0 or max). This slider's major ticks never reach past
  // 10%/90% by construction (timeSliderMinMax()'s own margin keeps them
  // there for column-center alignment), so adding a further edge inset
  // just shrinks the effective mapped range for no reason -- confirmed
  // directly: it was producing a consistent few-px drift between tick
  // centers and their real grid column centers (93px real column spacing
  // vs 88px inset-shrunk tick spacing) that the margin fix alone hadn't
  // caught.
  const centerFromLeft = `calc(100% * ${frac})`;
  thumb.style.left = `calc(${centerFromLeft} - 9px)`;
  readout.style.left = centerFromLeft;
  readout.textContent = formatTimeLabel(timeMinutes);
  const hours = sliderRealHours();
  slider.setAttribute('aria-valuenow', String(Math.round(timeMinutes)));
  slider.setAttribute('aria-valuemin', String(hours[0] * 60));
  slider.setAttribute('aria-valuemax', String(hours[hours.length - 1] * 60));
  slider.setAttribute('aria-valuetext', formatTimeLabel(timeMinutes));
}

function renderTimeTicks(sliderEls) {
  const { ticksEl } = sliderEls;
  const [min, max] = timeSliderMinMax();
  const majorHours = new Set(DATA.hours);
  ticksEl.innerHTML = '';
  sliderRealHours().forEach(h => {
    const t = h * 60;
    const frac = max > min ? (t - min) / (max - min) : 0;
    const isMajor = majorHours.has(h);
    const tick = document.createElement('button');
    tick.type = 'button';
    tick.className = 'weather-time-tick' + (isMajor ? ' major' : '');
    tick.style.left = `calc(100% * ${frac} - 9px)`; // same full-width mapping as updateTimeSliderUI()'s thumb -- see its own comment
    tick.title = formatTimeLabel(t);
    if (isMajor) {
      const label = document.createElement('span');
      label.className = 'weather-time-tick-label';
      label.textContent = formatTimeLabel(t); // same value as tick.title above, already computed
      tick.appendChild(label);
    }
    // pointerdown + stopPropagation, not just 'click' -- same reason
    // descent3d.js's own alt-slider ticks do this (see its own comment): an
    // unstopped pointerdown bubbles into the slider's own pointerdown
    // handler first and jumps the thumb to an approximate position before
    // snapping back to the exact tick a moment later.
    tick.addEventListener('pointerdown', evt => {
      evt.stopPropagation();
      setSliderTime(sliderEls, t, true);
    });
    // Also a plain 'click' -- keyboard activation (Enter/Space on a
    // focused button) fires that without a preceding pointerdown at all.
    tick.addEventListener('click', () => setSliderTime(sliderEls, t, true));
    ticksEl.appendChild(tick);
  });
}

function addWeatherTimeSlider(grid) {
  const slider = document.createElement('div');
  slider.className = 'weather-time-slider';
  slider.id = 'weather-time-slider';
  slider.tabIndex = 0;
  slider.setAttribute('role', 'slider');
  slider.setAttribute('aria-label', 'Time of day');
  // Matches the grid's own per-dataset column count (see renderWeatherPanel()'s
  // own comment) -- the static CSS default (app.css) assumes 5; overridden
  // here for whatever DATA.hours.length this capture actually has. This is
  // what was actually broken in the reported screenshot: an old 4-checkpoint
  // capture's slider still spanned 5 declared column tracks, so its own
  // tick fractions (correct relative to ITS OWN box) landed against a box
  // that didn't match the real 4-column data grid beneath it at all.
  slider.style.gridColumn = `span ${DATA.hours.length}`;

  const track = document.createElement('div');
  track.className = 'weather-time-track';
  const ticksEl = document.createElement('div');
  ticksEl.className = 'weather-time-ticks';
  const thumb = document.createElement('div');
  thumb.className = 'weather-time-thumb';
  const readout = document.createElement('div');
  readout.className = 'weather-time-readout';
  slider.appendChild(track);
  slider.appendChild(ticksEl);
  slider.appendChild(thumb);
  slider.appendChild(readout);
  grid.appendChild(slider);

  const sliderEls = { slider, thumb, readout, ticksEl };
  renderTimeTicks(sliderEls);
  updateTimeSliderUI(sliderEls, state.timeMinutes);

  // No target check here -- a tick's own pointerdown handler (below, in
  // renderTimeTicks()) calls stopPropagation() to keep this listener from
  // ALSO firing for a tick click, same as descent3d.js's own alt slider
  // (see its own comment). An evt.target allow-list was tried and rejected
  // here: .weather-time-ticks (the ticks' own container div) covers the
  // whole track via position:absolute;inset:0, so almost every click that
  // ISN'T on a tick itself lands on THAT div, not `slider`/`track`/`thumb`
  // directly -- an allow-list would have silently ignored most of the
  // track's own surface instead of jumping the thumb there.
  slider.addEventListener('pointerdown', evt => {
    evt.preventDefault();
    slider.classList.add('dragging');
    slider.setPointerCapture(evt.pointerId);
    const move = e => setSliderTime(sliderEls, timeFromClientX(slider, e.clientX), false);
    const stop = () => {
      slider.classList.remove('dragging');
      document.removeEventListener('pointermove', move);
      document.removeEventListener('pointerup', stop);
      // Final commit -- see setSliderTime()'s own comment on why the drag
      // itself doesn't pay for a full render() on every intermediate step.
      setSliderTime(sliderEls, state.timeMinutes, true);
    };
    document.addEventListener('pointermove', move);
    document.addEventListener('pointerup', stop);
    move(evt);
  });
  slider.addEventListener('keydown', evt => {
    let next = null;
    if (evt.key === 'ArrowRight' || evt.key === 'ArrowUp') next = state.timeMinutes + 15;
    else if (evt.key === 'ArrowLeft' || evt.key === 'ArrowDown') next = state.timeMinutes - 15;
    if (next !== null) {
      evt.preventDefault();
      setSliderTime(sliderEls, next, true);
    }
  });
}

// Shared header row: blank corner, Prior day, Morning, then the time
// slider spanning the hourly columns (see addWeatherTimeSlider() above) --
// it IS the hour selector now (formerly a row of buttons, and before that
// the standalone #hour-toggle in .controls, see initFromData()/the
// real-flight-jump branch).
function addWeatherHeaderRow(grid) {
  const corner = document.createElement('div');
  corner.className = 'weather-corner';
  grid.appendChild(corner);

  ['Prior day', 'Morning'].forEach(text => {
    const d = document.createElement('div');
    d.className = 'weather-hr-label';
    d.textContent = text;
    grid.appendChild(d);
  });

  addWeatherTimeSlider(grid);
}

function renderWeatherPanel() {
  const container = document.getElementById('weather-panel');
  if (!DATA.rain && !DATA.temperature && !DATA.clouds && !DATA.wind) { container.style.display = 'none'; return; } // pre-feature captures never regenerated
  container.style.display = '';
  container.innerHTML = '';

  const head = document.createElement('div');
  head.className = 'weather-head';

  const title = document.createElement('div');
  title.className = 'weather-title-toggle';
  title.tabIndex = 0;
  title.setAttribute('role', 'button');
  title.setAttribute('aria-expanded', String(!weatherPanelCollapsed));
  title.innerHTML = `Weather <span class="weather-chevron${weatherPanelCollapsed ? ' collapsed' : ''}">&#9660;</span>`;
  const toggleCollapsed = () => { weatherPanelCollapsed = !weatherPanelCollapsed; renderWeatherPanel(); };
  title.addEventListener('click', toggleCollapsed);
  title.addEventListener('keydown', evt => {
    if (evt.key === 'Enter' || evt.key === ' ') { evt.preventDefault(); toggleCollapsed(); }
  });
  head.appendChild(title);
  container.appendChild(head);

  const relevantLayers = DATA.cloud_relevant_layers || ['low', 'mid', 'high'];

  if (weatherPanelCollapsed) return;

  // Site name/waiver moved out to its own always-visible <h2> above the map
  // (renderSiteHeading(), called from selectSite()) -- it's a site-level
  // fact, not a clouds-specific one, and living inside this collapsible
  // panel meant it was easy to miss entirely when collapsed.

  const grid = document.createElement('div');
  grid.className = 'weather-grid';
  // Column count is DATA.hours.length, not a hardcoded 5 -- an older
  // capture (pulled before this session's checkpoint set existed) can have
  // fewer real hourly columns (confirmed directly: every currently-
  // published capture in this repo still has only 4). The static CSS rule
  // (app.css) assumes 5 and leaves a 5th, empty column track distorting
  // every row's rhythm when a capture has fewer -- overridden here per
  // dataset, same reasoning as .weather-time-slider's own grid-column
  // override just below (addWeatherTimeSlider()).
  grid.style.gridTemplateColumns = `minmax(78px, auto) repeat(2, minmax(56px, 1fr)) repeat(${DATA.hours.length}, minmax(52px, 1fr))`;
  container.appendChild(grid);

  addWeatherHeaderRow(grid);
  if (DATA.clouds) {
    const shownLayers = cloudAltitudesExpanded ? CLOUD_LAYERS.map(l => l.key) : relevantLayers;
    const shownLabel = shownLayers.map(k => CLOUD_LAYERS.find(l => l.key === k).label).join(' + ');
    addCloudSectionHeading(grid, shownLabel);
    // Total is independently-computed whole-sky cover, not low+mid+high
    // summed -- placed above High (never mixed in with the altitude bands
    // themselves) so it reads as the big picture, not the headline number.
    if (cloudAltitudesExpanded) {
      addCloudRow(grid, 'total', 'Total', 'all layers', false);
      const totalDivider = document.createElement('div');
      totalDivider.className = 'cloud-layer-divider';
      grid.appendChild(totalDivider);
    }
    const rowsToShow = cloudAltitudesExpanded ? CLOUD_LAYERS : CLOUD_LAYERS.filter(l => relevantLayers.includes(l.key));
    rowsToShow.forEach(l => addCloudRow(grid, l.key, l.label, l.sub, cloudAltitudesExpanded && !relevantLayers.includes(l.key)));
  }
  if (DATA.rain) { addRainSectionHeading(grid); addRainRow(grid); }
  // Right after Rain, not leading the panel any more -- per direction, it's
  // a ground-level reading (10m AGL), grouped with Rain/Temp's own
  // near-surface readings rather than sitting apart at the top.
  if (DATA.wind) { addWindSectionHeading(grid); addWindRow(grid); }
  if (DATA.temperature) { addTempSectionHeading(grid); addTempRow(grid); }

  // No per-model color key here -- the main "Model" legend in the side
  // column already maps every model to this same color (MODEL_COLORS_HEX),
  // so repeating it in this panel too would just be noise.
  if (DATA.wind) {
    const legend = document.createElement('div');
    legend.className = 'cloud-legend wind-legend';
    // Labeled now (previously just 4 bare dots with no heading at all) --
    // and "gusty" renamed to "strong": this scale grades SUSTAINED speed
    // (the wind row's own numbers), not gust, which is a real separate
    // field shown per-model now as each bar's own hollow-outline cap (see
    // addWindCell()'s own comment) -- "gusty" here was actively misleading
    // about which number the color refers to. Clean 5mph steps (0-9/
    // 10-14/15-19/20+), matching WIND_TIER_YELLOW_MIN_MPH/
    // WIND_TIER_ORANGE_MIN_MPH -- lines up with the bars' own 10/20mph
    // dashed reference lines, per direction, rather than an unrelated
    // 8/16 split.
    legend.innerHTML =
      '<span class="wind-legend-label">Sustained wind:</span>' +
      '<span class="wind-tier-key"><span class="wind-tier-dot tier-green"></span>&le;9 calm</span>' +
      '<span class="wind-tier-key"><span class="wind-tier-dot tier-yellow"></span>10-14 breezy</span>' +
      '<span class="wind-tier-key"><span class="wind-tier-dot tier-orange"></span>15-19 strong</span>' +
      `<span class="wind-tier-key"><span class="wind-tier-dot tier-red"></span>&ge;${DATA.wind_nogo_mph} no-go (Tripoli §9-3)</span>` +
      '<span class="wind-tier-key wind-gust-note">hollow outline on a bar = gust</span>';
    container.appendChild(legend);
  }
  // No separate cloud legend row -- the ⚠ badge/bolded-value treatment is
  // already explained in the cell's own tooltip (see addCloudRow()'s
  // mousemove handler) every time it actually appears. A standalone
  // "majority >=50% covered" line below the grid read as its own ambient
  // warning rather than a legend, sitting there regardless of whether any
  // cell was actually flagged that capture.
}

// --- burn-ban status (see pull_live_forecast.py's fetch_burn_ban()) --------
// Tri-state, matching the pipeline exactly: DATA.burn_ban is null (checked,
// but the request failed -- status genuinely unknown, so no chip at all,
// same as "not supported"), {supported:false} (Kansas/South Dakota -- no
// statewide feed exists to check), or a real checked result. Only the last
// case ever shows a chip -- a green "clear" chip for a site we never
// actually checked would claim a status that isn't real.
let banDismissed = false;

// checked_at is UTC but not always explicitly marked as such -- captures
// pulled before the ISO-with-offset fix land still carry the old naive
// "YYYY-MM-DD HH:MM:SS.ffffff" format (no zone at all), which browsers are
// free to guess is local time rather than UTC. Treat anything without an
// explicit offset/Z as UTC instead of letting that guess happen.
function parseUtcTimestamp(s) {
  const hasOffset = /[Zz]$|[+-]\d\d:?\d\d$/.test(s);
  return new Date(hasOffset ? s : s.replace(' ', 'T') + 'Z');
}
function formatCheckedAt(s) {
  const d = parseUtcTimestamp(s);
  return isNaN(d) ? s : d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

// Hover or click (touch has no hover) -- shows when this was last checked
// and against which county, so a real mismatch (the wrong county
// resurrected from a stale/pre-fix file, the exact bug class the per-site
// burn-ban fix exists to prevent) is visible at a glance instead of trusted
// blind. Reuses the same fixed-at-cursor #tooltip element as everywhere
// else in the viewer.
function showBanTooltip(evt) {
  const burnBan = DATA.burn_ban;
  if (!burnBan || !burnBan.supported) return;
  const site = regionalSites?.sites?.[currentSiteId];
  const countyTitleCase = `${burnBan.county.charAt(0)}${burnBan.county.slice(1).toLowerCase()}`;
  tooltip.innerHTML =
    `<div class="tt-row"><b>${site ? siteLabel(site) : currentSiteId}</b> — ${countyTitleCase} County</div>` +
    `<div class="tt-row">Checked ${formatCheckedAt(burnBan.checked_at)}</div>` +
    `<div class="tt-row" style="color:var(--text-muted);">Feed: ${burnBan.feed_header}</div>`;
  tooltip.style.display = 'block';
  positionTooltip(evt);
}
document.getElementById('burn-ban-chip').addEventListener('mousemove', showBanTooltip);
document.getElementById('burn-ban-chip').addEventListener('mouseleave', hideTooltip);

function renderBanStatus() {
  const chip = document.getElementById('burn-ban-chip');
  const overlay = document.getElementById('ban-overlay');
  const burnBan = DATA.burn_ban;
  if (!burnBan || !burnBan.supported) {
    chip.style.display = 'none';
    overlay.classList.remove('show');
    return;
  }
  const active = burnBan.active;
  overlay.classList.toggle('show', active && !banDismissed);
  document.getElementById('ban-headline').textContent = `Burn ban active — ${burnBan.county.charAt(0)}${burnBan.county.slice(1).toLowerCase()} County`;
  chip.style.display = '';
  chip.classList.toggle('clear', !active);
  chip.classList.toggle('banned', active);
  chip.innerHTML = active
    ? `<span class="sw"></span>Burn ban active — ${burnBan.county}`
    : `<span class="sw"></span>No burn ban`;
}
document.getElementById('ban-dismiss').addEventListener('click', () => { banDismissed = true; renderBanStatus(); });
// Clicking the small "banned" chip (once dismissed) reopens the full overlay
// -- dismiss only ever hides it, never discards the state. Also shows the
// checked-at/county tooltip regardless of state, same content mousemove
// gives desktop -- touch has no hover, so click is the only way to reach it.
document.getElementById('burn-ban-chip').addEventListener('click', evt => {
  if (document.getElementById('burn-ban-chip').classList.contains('banned')) { banDismissed = false; renderBanStatus(); }
  showBanTooltip(evt);
});

// --- real-flight info box (see analyze_real_flight.py) ---------------------
// Same fixed-at-cursor mechanism as the point tooltip above, but supports
// being pinned open on click (hover alone can't work on touch -- there's no
// hover state on mobile -- so click has to be a full substitute there, not
// just a bonus; see drawRealFlightMarker() for the interaction wiring).
const realFlightBox = document.getElementById('real-flight-box');

function realFlightBoxHTML() {
  const rf = activeRealFlight();
  if (!rf) return '';
  // GPS-tracked flights (analyze_real_flight.py's analyze()) score against
  // self_simulated_boost_adjusted -- a real measured apogee position makes
  // it a genuine accuracy check. No-GPS flights (analyze_no_gps(), see
  // apogee.position_source below) have neither self_simulated_boost_adjusted
  // nor self_simulated_descent_only: predicted_landing there is estimated
  // apogee + the same descent sim used to derive that estimate, so it
  // lands exactly on the real landing point by construction -- a self-
  // simulated delta would just be reporting back the zero it was solved to
  // produce, not a real accuracy check, so the pipeline omits it entirely.
  const boostAdjusted = rf.delta_from_predictions.self_simulated_boost_adjusted;
  const descentOnly = rf.delta_from_predictions.self_simulated_descent_only;
  const d = boostAdjusted || descentOnly;
  const deltaLabel = boostAdjusted ? 'delta from predicted landing' : 'delta from wind-only prediction (no boost data)';
  // boostAdjusted's error is purely descent-model (real measured apogee, not
  // predicted, cancels out of it -- see analyze_real_flight.py's own
  // comment), so it's scored as % of the real apogee-to-landing descent
  // drift (pct_of_descent_drift), not % of the real pad-to-landing drift
  // like descentOnly (whose own error already conflates an assumed-zero
  // boost drift with descent-model error, so pad-to-landing stays the fair
  // comparison there).
  const pct = boostAdjusted ? boostAdjusted.pct_of_descent_drift : (descentOnly && descentOnly.pct_of_actual_drift);
  const pctSuffix = boostAdjusted ? 'of actual descent drift' : 'of actual drift';
  const deltaLine = d ? `${deltaLabel}: ${d.ft.toFixed(0)} ft (${pct}% ${pctSuffix})<br>` : '';
  // Against the pad's *current* position (configured + any drag offset) --
  // not the fixed figure baked into the summary JSON at pipeline-run time.
  // No need to also show a "rail N ft from pad" readout here: clicking the
  // marker snaps the pad to the rail (see the marker's click handler
  // below), and dragging the pad by hand un-pins this box (see the pad-drag
  // handler), so the pad is always exactly at the rail for as long as this
  // box is actually visible -- that number would only ever read ~0.
  const land = rf.landing.offset_from_pad_ft;
  const landFt = Math.hypot(land.x - padOffsetFt.x, land.y - padOffsetFt.y);
  // Same "distance from the pad's current position" basis as landFt above --
  // once the pad's snapped to the rail (clicking the marker does this), this
  // reads as distance/angle from where the flight actually launched, not
  // just the configured survey point. Angle recomputed from that same live
  // distance rather than trusting the baked-in boost_angle_from_vertical_deg,
  // for the same reason.
  const apogeeOff = rf.apogee.offset_from_pad_ft;
  const apogeeFt = Math.hypot(apogeeOff.x - padOffsetFt.x, apogeeOff.y - padOffsetFt.y);
  const apogeeAngleDeg = Math.atan2(apogeeFt, rf.apogee.altitude_agl_ft) * 180 / Math.PI;
  // Carried by both no-GPS flights (analyze_no_gps()) and partial-GPS ones
  // (analyze_partial_gps(), see apogee.position_source) -- see this
  // function's own docstring and apogee.position_estimation_note in the
  // summary JSON. The two differ in whether predicted landing is a genuine
  // prediction: analyze_no_gps() solves apogee to match the real landing
  // point exactly (no delta line above, predicted-landing star sits right
  // on the real marker -- not a bug), where analyze_partial_gps() solves
  // apogee against a real GPS fix mid-descent instead, so predicted landing
  // is independent and does get scored (the delta line above).
  const apogeeNote = rf.apogee.position_source && rf.apogee.position_source !== 'gps_measured'
    ? (boostAdjusted
        ? `<div class="rf-note">No usable GPS fix at apogee on this flight -- apogee position (and the launch-angle direction) is calculated from wind models for this time of day, not measured, anchored to a real GPS fix partway down the descent instead of the landing point. The predicted-landing star is that same estimate re-simulated all the way to the ground -- a genuine prediction, scored above, not forced to match the real landing.</div>`
        : `<div class="rf-note">No usable GPS fix at apogee on this flight -- apogee position (and the launch-angle direction) is calculated from wind models for this time of day, not measured. The predicted-landing star is that same estimate re-simulated, so it matches the real landing by construction -- a self-consistency check, not an independent prediction.</div>`)
    : '';
  return `
    <div class="rf-title">Real flight</div>
    launch ${rf.launch.time_local.split('.')[0]}<br>
    apogee ${rf.apogee.altitude_agl_ft.toLocaleString()} ft (${apogeeFt.toFixed(0)} ft from pad, ${apogeeAngleDeg.toFixed(1)}&deg; off vertical)<br>
    drogue rate ~${rf.descent_rates_ground_equivalent_fps.drogue.mean.toFixed(0)} fps<br>
    main deploy ${rf.main_deploy.altitude_agl_ft.toLocaleString()} ft<br>
    main rate ~${rf.descent_rates_ground_equivalent_fps.main.mean.toFixed(0)} fps<br>
    landing ${landFt.toFixed(0)} ft from pad<br>
    ${deltaLine}${apogeeNote}`;
}

// SVG user-space (viewBox) coordinates -> actual screen pixels, accounting
// for the current zoom/pan transform -- needed to keep the info box clear
// of both the real-landing and predicted-landing markers (see
// showRealFlightBox()), since their fixed SVG positions don't map 1:1 to
// screen pixels once the map's been zoomed or panned.
function svgToScreen(px, py) {
  const pt = svg.createSVGPoint();
  pt.x = px; pt.y = py;
  const screen = pt.matrixTransform(svg.getScreenCTM());
  return [screen.x, screen.y];
}

// Picks a corner (relative to the cursor) for the info box that doesn't
// land on top of either marker -- tries the usual bottom-right first, falls
// back through the other three corners, and only gives up (uses the
// default) if a real flight's two points happen to bracket the cursor from
// every direction at once. Sizes are an estimate (the box's real height
// varies with content) -- generous on purpose, since overshooting a little
// is a much smaller problem than the overlap this exists to prevent.
function positionBoxAvoiding(evt, avoidScreenPoints) {
  const boxW = 260, boxH = 240, pad = 14, margin = 10;
  const candidates = [
    [evt.clientX + pad, evt.clientY + pad],
    [evt.clientX - boxW - pad, evt.clientY + pad],
    [evt.clientX + pad, evt.clientY - boxH - pad],
    [evt.clientX - boxW - pad, evt.clientY - boxH - pad],
  ];
  for (const [x, y] of candidates) {
    const overlaps = avoidScreenPoints.some(([px, py]) =>
      px >= x - margin && px <= x + boxW + margin && py >= y - margin && py <= y + boxH + margin);
    if (!overlaps) return [x, y];
  }
  return candidates[0];
}

function showRealFlightBox(evt, avoidScreenPoints) {
  realFlightBox.innerHTML = realFlightBoxHTML();
  const [x, y] = positionBoxAvoiding(evt, avoidScreenPoints || []);
  realFlightBox.style.left = x + 'px';
  realFlightBox.style.top = y + 'px';
  realFlightBox.style.display = 'block';
}
function hideRealFlightBox() {
  if (pinnedRealFlightIndex !== null) return; // stays open until something else is clicked -- see the document-level listener below
  realFlightBox.style.display = 'none';
}

// Swaps the map between the default History display (the generic "Final
// projection" star) and this one flight's own predicted landing (its real
// apogee/rates run through the same sim, a fair comparison against its real
// landing point in a way the fast/slow presets no longer are) -- active
// whenever the real-flight marker is hovered or pinned.
function setRealFlightComparing(active) {
  if (!projectionStarEl || !predictedLandingStarEl || !launchRailEl || !apogeeMarkerEl) return;
  projectionStarEl.style.display = active ? 'none' : '';
  predictedLandingStarEl.style.display = active ? '' : 'none';
  launchRailEl.style.display = active ? '' : 'none';
  apogeeMarkerEl.style.display = active ? '' : 'none';
}

// Closes the pinned box (and reverts the star swap) on any click elsewhere.
// Only ever sees clicks that didn't land on the marker itself -- its own
// click handler stopPropagation()s, the same fix already needed for
// #map-wrap's pointerdown to stop eating clicks on the zoom buttons/layer
// toggle/pad marker.
document.addEventListener('click', () => {
  if (pinnedRealFlightIndex === null) return;
  pinnedRealFlightIndex = null;
  realFlightBox.style.display = 'none';
  updateActiveRealFlightOverlay();
  setRealFlightComparing(hoveredRealFlightIndex !== null);
  restorePadFromRealFlightSnap();
});

// --- render ---
function polyPoints(hull) { return hull.map(p => p.join(',')).join(' '); }
const ns = 'http://www.w3.org/2000/svg';
let renderedPoints = [];

// --- client-side hull recompute (core hull, rail-shifted) ------------------
// Ported from pipeline/splash_zones.py's hull_of()/ft_to_px(). The hull is
// recomputed here on every render from each zone's raw x_ft/y_ft points
// (drawZone() does this, not a server-baked core_hull_px) -- needed for two
// independent reasons: the rail-angle dial has to move the shift live
// rather than being locked to whatever angle that day's pull baked in, and
// an edited rate has to actually recompute the hull from the new points
// rather than leaving a static outline around numbers that no longer match.

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

// --- client-side descent-drift simulation ----------------------------------
// Ported from pipeline/splash_zones.py's air_density_ratio()/descent_rate_at()/
// interp()/simulate(). Same reason the hull/buffer port above exists, one
// step further: the fast/slow descent rates are now user-editable (see
// buildRateEditor()), so every landing point has to be integrated here from
// the published wind profile rather than baked into the JSON at whatever
// rates that day's pull happened to use. That's also what removed the old
// `data` key entirely -- the pull now publishes a few hundred wind numbers
// (DATA.wind_profiles) instead of a pre-simulated point for every
// altitude x rate x model combination (hutto 2026-08-01: 143.9KB -> 10.5KB).
// std_atm_ft() is deliberately NOT ported -- pressure levels are already
// resolved to AGL feet server-side, in build_profile_single().
//
// Mirrors splash_zones.py's ICAO constants exactly (see that file's own
// comment for the ISA-table verification) -- not re-derived or re-verified
// here, just copied, so the two stay numerically identical by construction.
const ICAO_T0_K = 288.15;
const ICAO_LAPSE_K_PER_M = 0.0065;
const ICAO_TROP_TOP_M = 11000.0;
const ICAO_TROP_EXP = 5.25588;
const ICAO_STRAT_COEF_PER_M = 1.5768e-4;
const ICAO_RHO_RATIO_AT_TROPOPAUSE = (1 - ICAO_LAPSE_K_PER_M * ICAO_TROP_TOP_M / ICAO_T0_K) ** (ICAO_TROP_EXP - 1);
const FT_PER_M = 3.28084;
const MPH_TO_FTPS = 5280 / 3600;

function airDensityRatio(altMMsl) {
  if (altMMsl <= ICAO_TROP_TOP_M) {
    const theta = 1 - ICAO_LAPSE_K_PER_M * altMMsl / ICAO_T0_K;
    return theta ** (ICAO_TROP_EXP - 1);
  }
  return ICAO_RHO_RATIO_AT_TROPOPAUSE * Math.exp(-ICAO_STRAT_COEF_PER_M * (altMMsl - ICAO_TROP_TOP_M));
}

// groundRhoRatio is a default param, not recomputed per call like the Python
// does -- it's constant per site for the whole sim, and simulateDrift()
// below calls this once per integration step, so hoisting it avoids two
// Math.pow() calls x every step while descentRateAt() still reads as a
// faithful standalone port with the same argument order.
function descentRateAt(altAglFt, groundRateFtps, siteElevFt, groundRhoRatio = airDensityRatio(siteElevFt / FT_PER_M)) {
  const rhoHere = airDensityRatio((altAglFt + siteElevFt) / FT_PER_M);
  return groundRateFtps * Math.sqrt(groundRhoRatio / rhoHere);
}

// Real drogue/main fps can't actually be measured at 0ft AGL -- main
// deploys around 600-1,200ft AGL, so real main-phase altimeter data only
// ever exists somewhere in roughly a 500-0ft AGL window before touchdown;
// drogue is falling even higher, roughly 2,000-1,000ft AGL, and never
// reaches anywhere near the ground at all (main has already taken over by
// then). Per direction: state.rateFps's typed/preset numbers are now
// understood as the rate at each phase's own realistic sampling window --
// not literally "the rate at the pad" -- anchored at each window's
// midpoint (1,500ft for drogue, 250ft for main) since there's no finer
// guidance than "somewhere in this realistic window" to anchor to more
// precisely. This converts that pair to the 0ft-AGL-equivalent values
// descentRateAt()'s own math is actually built around (inverting its same
// formula: rate-at-anchor = groundRate * sqrt(rhoGround/rhoAnchor), so
// groundRate = rate-at-anchor * sqrt(rhoAnchor/rhoGround)) -- called once
// per zoneFor()/descentPathsFor()/historyPointsForAltitude() invocation,
// not per integration step, so it's outside the hot path descentRateAt()
// itself is on.
//
// Deliberately client-side only -- the pipeline's own default_rates_fps
// (config.py's DUAL_DEPLOY_RATES_FPS/SINGLE_DEPLOY_RATES_FPS, and every
// already-published/historical splash point computed from them) keeps the
// old direct-at-0ft-AGL interpretation, per direction, so this file's live
// simulation and History mode's server-precomputed points can diverge
// slightly for the same nominal "Fast"/"Slow" preset now -- an accepted,
// understood trade-off of scoping this fix to the live viewer only, not a
// bug.
const DROGUE_RATE_ANCHOR_AGL_FT = 1500; // midpoint of the realistic 2,000-1,000ft AGL drogue-phase window
const MAIN_RATE_ANCHOR_AGL_FT = 250; // midpoint of the realistic 500-0ft AGL main-phase window
function groundEquivalentRateFps(rateFps, siteElevFt) {
  const rhoGround = airDensityRatio(siteElevFt / FT_PER_M);
  const equivAt = (rateAtAnchorFtps, anchorAglFt) => {
    const rhoAnchor = airDensityRatio((anchorAglFt + siteElevFt) / FT_PER_M);
    return rateAtAnchorFtps * Math.sqrt(rhoAnchor / rhoGround);
  };
  return {
    drogue: equivAt(rateFps.drogue, DROGUE_RATE_ANCHOR_AGL_FT),
    main: equivAt(rateFps.main, MAIN_RATE_ANCHOR_AGL_FT),
  };
}

// Every real hour this capture has a wind profile for, ascending -- dense
// (up to 9, one per config.WIND_PROFILE_HOURS_LOCAL entry) on a fresh live
// pull, sparse (falls back to DATA.hours, the weather panel's own
// checkpoints) on an older capture pulled before wind_hours existed.
// profilesForTime()'s blend-bracketing and History's nearestPublishedHour()
// read this specifically -- for the slider's OWN tick marks/draggable
// range, see sliderRealHours() below instead, which is deliberately wider.
function windProfileHours() {
  return DATA.wind_hours || DATA.hours;
}

// Every real hour this capture has ANY weather data for -- the union of
// wind_profiles, rain, temperature, and wind's own real hourly keys,
// whichever is densest. Reported directly against an older capture: rain/
// temperature have always been published across a wider window than
// wind_profiles (build_rain_data()/build_temperature_data() loop
// config.RAIN_WINDOW_START/END_HOUR_LOCAL, a always-separate, always-wider
// figure than wind_profiles' own checkpoint/WIND_PROFILE_HOURS_LOCAL range
// -- confirmed directly on hutto/2026-08-01: wind_profiles only at
// 9/11/13/15, rain/temperature already dense at 8-16), so a user dragging
// the slider before the first or after the last wind-profile hour had
// nowhere to land at all, even though real rain/temp data existed right
// there to look at. windProfileHours() alone (map-simulation blend source)
// stays scoped tighter on purpose -- an hour with no nearby wind-profile
// bracket still blends fine from whichever two DO exist; widening the
// SLIDER's own reach doesn't require widening what profilesForTime()
// brackets against.
function sliderRealHours() {
  const union = new Set(windProfileHours());
  DATA.hours.forEach(h => union.add(h));
  if (DATA.rain) Object.keys(DATA.rain.hourly).forEach(h => union.add(Number(h)));
  if (DATA.temperature) Object.keys(DATA.temperature.hourly).forEach(h => union.add(Number(h)));
  if (DATA.wind) Object.keys(DATA.wind.hourly).forEach(h => union.add(Number(h)));
  return [...union].sort((a, b) => a - b);
}

// Nearest real published hour to a given time -- for the few places that
// read a server-precomputed grid keyed by exact integer hour (History
// mode's ladder-altitude view: points_by_key/actuals) rather than a raw
// profile the client can blend continuously (profilesForTime() below
// handles that path). Snapping instead of blending there is a real,
// accepted simplification -- the precomputed grid has no per-model wind
// field left to blend, only final x_ft/y_ft points, and this app has
// consistently preferred blending the underlying wind field over
// interpolating already-computed results (see profilesForTime()'s own
// comment) wherever that's actually possible.
function nearestPublishedHour(timeMinutes) {
  const hours = windProfileHours();
  return hours.reduce((best, h) =>
    Math.abs(h * 60 - timeMinutes) < Math.abs(best * 60 - timeMinutes) ? h : best, hours[0]);
}

// "1:15pm" -- the time slider's own readout/tick labels, and every other
// hour-to-text spot in this file (hourAmPm(), below, is the same format for
// a plain hour int specifically -- both read live off the value given
// rather than a hardcoded per-checkpoint lookup, which drifts out of sync
// with config.py's actual SPLASH_HOURS_LOCAL the moment that list changes
// -- a real, confirmed break this replaced, see RAIN_HOUR_BUCKETS'/
// bucketRainCell()'s own comment for the incident).
function formatTimeLabel(timeMinutes) {
  const h24 = Math.floor(timeMinutes / 60);
  const m = timeMinutes % 60;
  const period = h24 < 12 ? 'am' : 'pm';
  const h12 = h24 % 12 || 12;
  return m === 0 ? `${h12}${period}` : `${h12}:${String(m).padStart(2, '0')}${period}`;
}

// "13:15" -- the permalink's own ?t= format (24-hour HH:MM, unambiguous and
// directly sortable, unlike formatTimeLabel()'s "1:15pm" display form).
function formatTimeParam(timeMinutes) {
  const h = Math.floor(timeMinutes / 60), m = timeMinutes % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}
// Inverse of the above -- null (not NaN or some other garbage value) for a
// missing or malformed param, so callers can treat "absent" and "invalid"
// identically with one falsy-ish check rather than two.
function parseTimeParam(param) {
  if (!param) return null;
  const match = /^(\d{1,2}):(\d{2})$/.exec(param);
  if (!match) return null;
  const h = Number(match[1]), m = Number(match[2]);
  if (h < 0 || h > 23 || m < 0 || m > 59) return null;
  return h * 60 + m;
}

// Bracket the two real published hours in `hours` straddling timeMinutes
// and blend the matching entries of `profiles` -- the client-side port of
// pipeline/analyze_real_flight.py's blend_wind_profiles()/circular_blend()
// (which does exactly this for a real launch time between two published
// hours, auto-detected here off `hours` rather than that function's own
// caller-supplied wind_hour_a/wind_hour_b). Blends the underlying wind
// field, then feeds the result into the existing descent sim
// (simulateDrift() below) -- not interpolating already-computed zone
// points, for the same reason interpWind() blends the wind field rather
// than the drift result across altitude. Generic over `profiles`/`hours`
// (not hardcoded to DATA.wind_profiles/windProfileHours()) so
// historyPointsForAltitude() below can reuse it per-capture-date, since
// each capture's own real hour set can differ from the live one.
function blendProfilesForTime(profiles, hours, timeMinutes) {
  const exactHour = timeMinutes / 60;
  if (hours.includes(exactHour)) return profiles[exactHour]; // fast path, exact, no allocation
  const clamped = Math.max(hours[0] * 60, Math.min(hours[hours.length - 1] * 60, timeMinutes));
  // Bracketing pair: the largest published hour <= clamped and the
  // smallest >= clamped -- hours is ascending, so one forward scan finds
  // both ends at once.
  let hourA = hours[0], hourB = hours[hours.length - 1];
  for (let i = 0; i < hours.length - 1; i++) {
    if (hours[i] * 60 <= clamped && clamped <= hours[i + 1] * 60) {
      hourA = hours[i]; hourB = hours[i + 1];
      break;
    }
  }
  if (hourA === hourB) return profiles[hourA];
  const profilesA = profiles[hourA], profilesB = profiles[hourB];
  const weightB = (clamped - hourA * 60) / ((hourB - hourA) * 60);
  const blended = {};
  for (const model of Object.keys(profilesA)) {
    if (!profilesB[model]) continue; // a model missing one side of the bracket has nothing real to blend against
    const byAltB = new Map(profilesB[model].map(([alt, s, d]) => [alt, [s, d]]));
    // Only levels BOTH hours report, same intersection blend_wind_profiles()
    // uses -- in practice always the full set, same pipeline pull for every
    // hour. .filter()+.map() over profilesA[model] (already altitude-sorted
    // server-side) preserves that sort order, which interpWind() requires.
    blended[model] = profilesA[model]
      .filter(([alt]) => byAltB.has(alt))
      .map(([alt, s0, d0]) => {
        const [s1, d1] = byAltB.get(alt);
        const speed = s0 + weightB * (s1 - s0);
        // Same circular-shortest-path idiom interpWind() already uses below.
        const diff = (((d1 - d0 + 180) % 360) + 360) % 360 - 180;
        const direction = (((d0 + weightB * diff) % 360) + 360) % 360;
        return [alt, speed, direction];
      });
  }
  return blended;
}

// The live/current capture's own profilesForTime() -- thin wrapper around
// blendProfilesForTime() bound to DATA.wind_profiles/windProfileHours().
function profilesForTime(timeMinutes) {
  return blendProfilesForTime(DATA.wind_profiles, windProfileHours(), timeMinutes);
}

// Wind [speedMph, dirDeg] at `alt`, linearly interpolated (circular for
// direction) between the two profile points bracketing it -- mirrors
// interp(). `profile` is one of DATA.wind_profiles[hour][model], already
// sorted by altitude server-side.
function interpWind(profile, alt) {
  if (alt <= profile[0][0]) return [profile[0][1], profile[0][2]];
  const last = profile[profile.length - 1];
  if (alt >= last[0]) return [last[1], last[2]];
  for (let i = 0; i < profile.length - 1; i++) {
    const [a0, s0, d0] = profile[i];
    const [a1, s1, d1] = profile[i + 1];
    if (a0 <= alt && alt <= a1) {
      const f = (alt - a0) / (a1 - a0);
      const speed = s0 + f * (s1 - s0);
      // Python's `%` on a negative operand returns non-negative; JS's
      // doesn't -- both expressions below need the extra `+360, %360`
      // wrap or a heading crossing 0deg silently flips the drift vector.
      const diff = (((d1 - d0 + 180) % 360) + 360) % 360 - 180;
      const direction = (((d0 + f * diff) % 360) + 360) % 360;
      return [speed, direction];
    }
  }
  throw new Error('unreachable -- profile is sorted and alt is bounded above');
}

// Integrate drift (xFt east, yFt north) across one or more descent phases --
// mirrors simulate(). `phases` is [[rateFtps, segTopFt, segBottomFt], ...],
// e.g. dual-deploy passes a drogue phase down to main-deploy altitude, then
// a main phase down to the ground. rateFtps is scaled per-step by
// descentRateAt() (thinner air at altitude -> faster actual fall than the
// same drogue's ground-level rate), not held constant across the phase.
function simulateDrift(profile, apogeeFt, phases, siteElevFt, stepFt) {
  let x = 0, y = 0, alt = apogeeFt;
  const groundRhoRatio = airDensityRatio(siteElevFt / FT_PER_M);
  for (const [rateFtps, segTop, segBottom] of phases) {
    const top = Math.min(alt, segTop);
    const bottom = segBottom;
    if (top <= bottom) continue;
    const n = Math.max(1, Math.floor((top - bottom) / stepFt)); // top>bottom always here, so Math.floor==Math.trunc
    const dz = (top - bottom) / n;
    for (let i = 0; i < n; i++) {
      const mid = top - (i + 0.5) * dz;
      const [spdMph, drc] = interpWind(profile, mid);
      const spdFtps = spdMph * MPH_TO_FTPS;
      const u = -spdFtps * Math.sin(drc * Math.PI / 180);
      const v = -spdFtps * Math.cos(drc * Math.PI / 180);
      const dt = dz / descentRateAt(mid, rateFtps, siteElevFt, groundRhoRatio);
      x += u * dt;
      y += v * dt;
    }
    alt = bottom;
  }
  return [x, y];
}

// Same physics as simulateDrift() above -- literally the same phase-loop
// integration -- but returns the FULL cumulative path (one entry per
// integration breakpoint, apogee-first, x_ft/y_ft running totals not
// per-step deltas), not just the final [x, y]. Feeds the 3D descent-path
// view (descent3d.js), which wants to draw the actual shape of the fall,
// not just where it lands.
//
// Breakpoints are the sorted-descending union of the regular stepFt grid
// simulateDrift() already uses AND every altitude `profile` itself reports
// within each phase's range -- so a real reported wind level gets its own
// exact stop (isRealLevel: true) without changing the wind field being
// integrated, just subdividing whichever stepFt-sized interval it falls
// inside into two smaller ones. GFS reporting ~44 levels vs ICON's ~19
// shows up directly as visibly denser isRealLevel stops along an otherwise
// similar-length line -- an honest resolution difference, not styling.
//
// This changes exactly which altitudes get sampled for wind (extra
// midpoints from the subdivided intervals), so its own final point isn't
// bit-identical to simulateDrift()'s -- confirmed empirically it agrees to
// well under 1ft for real inputs, consistent with subdividing an
// already-fine 50ft grid rather than a different physics model.
function simulateDriftPath(profile, apogeeFt, phases, siteElevFt, stepFt) {
  const groundRhoRatio = airDensityRatio(siteElevFt / FT_PER_M);
  const profileAlts = profile.map(p => p[0]);
  let x = 0, y = 0, alt = apogeeFt;
  const path = [{ alt_ft: apogeeFt, x_ft: 0, y_ft: 0, isRealLevel: false }];
  for (const [rateFtps, segTop, segBottom] of phases) {
    const top = Math.min(alt, segTop);
    const bottom = segBottom;
    if (top <= bottom) continue;
    const n = Math.max(1, Math.floor((top - bottom) / stepFt));
    const dz = (top - bottom) / n;
    const gridBreaks = [];
    for (let k = 1; k <= n; k++) gridBreaks.push(top - k * dz);
    // Strictly inside this phase's open interval -- the phase's own top/
    // bottom are already guaranteed breakpoints via gridBreaks (k=n lands
    // exactly on bottom), so a real level that happens to equal a segment
    // boundary shouldn't be inserted a second time.
    const realBreaks = profileAlts.filter(a => a > bottom + 0.5 && a < top - 0.5);
    const breaks = [...new Set([...gridBreaks, ...realBreaks].map(v => Math.round(v * 100) / 100))]
      .sort((a, b) => b - a); // descending -- falling from top to bottom

    let prev = top;
    for (const z of breaks) {
      if (prev - z < 0.01) { prev = z; continue; } // dedupe a near-duplicate breakpoint, not a real extra step
      const dzStep = prev - z;
      const mid = (prev + z) / 2;
      const [spdMph, drc] = interpWind(profile, mid);
      const spdFtps = spdMph * MPH_TO_FTPS;
      const u = -spdFtps * Math.sin(drc * Math.PI / 180);
      const v = -spdFtps * Math.cos(drc * Math.PI / 180);
      const dt = dzStep / descentRateAt(mid, rateFtps, siteElevFt, groundRhoRatio);
      x += u * dt;
      y += v * dt;
      const isRealLevel = realBreaks.some(a => Math.abs(a - z) < 0.5);
      path.push({ alt_ft: z, x_ft: x, y_ft: y, isRealLevel });
      prev = z;
    }
    alt = bottom;
  }
  return path;
}

// Zone cache: `${hour}_${deploy}_${altitude}` -> {altitude, points}. Cleared
// on dataset load and on a rate edit -- and on nothing else, deliberately:
// x_ft/y_ft don't depend on padOffsetFt (applied later, in ftToPx()) or on
// railAngleDeg/railHeadingDeg (applied later, in railShiftFt()), so
// dragging the pad or the rail-angle dial stays a pure redraw with zero
// re-simulation.
// Also why several legend hover handlers (model/hour) calling render() on
// mouseenter/mouseleave don't re-simulate the whole grid on every mouse
// movement -- a full grid computes once per (dataset, rate-setting), every
// subsequent hover/pin/drag is a cache hit.
let zoneCache = new Map();
// Same idea, separate map: keyed on hour_deploy_altitude and sourced from
// HISTORY.wind_profiles_by_capture instead of DATA.wind_profiles -- see
// historyPointsForAltitude() below. Cleared alongside zoneCache since both
// depend on state.rateFps.
let historyZoneCache = new Map();
// Same idea again: descentPathsFor()'s own cache (see its own comment,
// below zonesFor()), cleared here too since it depends on state.rateFps
// exactly like the other two.
let pathCache = new Map();
// 3D History's own two path caches -- historyPathsForCapture() (one
// specific capture's forecast paths) and historyActualPathForAltitude()
// (the single T+1 analysis path, independent of capture) -- both depend on
// state.rateFps exactly like the three above, cleared alongside them.
let historyPathCache = new Map();
let historyActualPathCache = new Map();
function invalidateZones() {
  zoneCache.clear(); historyZoneCache.clear(); pathCache.clear();
  historyPathCache.clear(); historyActualPathCache.clear();
}

// One altitude's zone at the given time/deploy, computed just-in-time from
// DATA.wind_profiles at the current state.rateFps -- returns the same
// {altitude, points: [{model, x_ft, y_ft}]} shape drawZone() already
// consumes (it was already reading only these two fields; see drawZone()'s
// own comment). One point per model now, not two (fast+slow) -- see
// buildRateEditor()'s own comment for why. null above
// single_deploy_max_alt_ft for single deploy (mirrors
// compute_splash_points()'s own skip) or if `timeMinutes` falls outside
// every published hour's range entirely. `timeMinutes` (not an hour int)
// -- resolved via profilesForTime(), which returns an exact published
// hour's own profile unblended, or a blend of the two bracketing hours
// when it falls between them (see that function's own comment).
function zoneFor(timeMinutes, deploy, altitudeFt) {
  const cacheKey = `${timeMinutes}_${deploy}_${altitudeFt}`;
  if (zoneCache.has(cacheKey)) return zoneCache.get(cacheKey);

  const dp = DATA.descent_params;
  const profiles = profilesForTime(timeMinutes);
  let zone = null;
  // single_deploy_max_alt_ft is a guardrail for the GENERIC dial (the
  // assumption behind compute_splash_points()'s own skip: nobody flies a
  // single-deploy-at-apogee config to a wildly high altitude on purpose, so
  // past this point a single-deploy zone is more likely a mis-set dial than
  // a real plan). A real rocketry sim result (ASCENT_RESULTS) already knows
  // the ACTUAL hardware -- applyDescentDevices() only picks 'single' when
  // rocketry reported exactly one real recovery device -- so a real single-
  // deploy flight with a genuinely high real apogee is real, not a mistake,
  // and skipping it here silently produced a zone-less, point-less map (no
  // landing markers/popups at all) with apogee markers still showing fine
  // (those come from ascentPathForModel(), not zoneFor()) -- confirmed
  // directly: a single-device flight with a >10,000ft real apogee rendered
  // zero .zone-group/.pt elements until this bypass was added.
  if (profiles && !(!ASCENT_RESULTS && deploy === 'single' && altitudeFt > dp.single_deploy_max_alt_ft)) {
    const r = groundEquivalentRateFps(state.rateFps, dp.site_elev_ft);
    // Mirrors compute_splash_points()'s own phase construction exactly:
    // dual is a drogue phase down to main-deploy altitude then a main
    // phase to the ground; single is one main-rate phase the whole way.
    const phases = deploy === 'dual'
      ? [[r.drogue, altitudeFt, dp.main_deploy_altitude_ft], [r.main, dp.main_deploy_altitude_ft, 0]]
      : [[r.main, altitudeFt, 0]];
    const points = [];
    for (const [model, profile] of Object.entries(profiles)) {
      const [x_ft, y_ft] = simulateDrift(profile, altitudeFt, phases, dp.site_elev_ft, dp.descent_step_ft);
      points.push({ model, x_ft, y_ft });
    }
    zone = { altitude: altitudeFt, points };
  }
  zoneCache.set(cacheKey, zone);
  return zone;
}

function zonesFor(timeMinutes, deploy) {
  return DATA.altitudes.map(alt => zoneFor(timeMinutes, deploy, alt)).filter(z => z !== null);
}

// 3D descent-path view's data source (descent3d.js). Same phase
// construction as zoneFor() above, and now the same single active
// state.rateFps too (descent3d.js used to carry its own separate fast/slow
// toggle -- dropped once the sidebar's rate editor became single-active
// itself, see buildRateEditor()'s own comment; one shared control instead of
// two). Still simulateDriftPath()'s full path per model rather than
// zoneFor()'s final-point-only. Unfiltered by state.selectedModels here --
// filtering happens at render time, same separation zoneFor()/drawZone()
// already use. pathCache itself is declared above, alongside
// zoneCache/historyZoneCache.
function descentPathsFor(timeMinutes, deploy, altitudeFt) {
  const cacheKey = `${timeMinutes}_${deploy}_${altitudeFt}`;
  if (pathCache.has(cacheKey)) return pathCache.get(cacheKey);

  const dp = DATA.descent_params;
  const profiles = profilesForTime(timeMinutes);
  const out = [];
  // Same ASCENT_RESULTS bypass as zoneFor() above, and for the same reason
  // -- this is the 3D view's own path source, which hit the identical
  // zero-output failure for a real single-device flight above the generic
  // dial's altitude cap.
  if (profiles && !(!ASCENT_RESULTS && deploy === 'single' && altitudeFt > dp.single_deploy_max_alt_ft)) {
    const r = groundEquivalentRateFps(state.rateFps, dp.site_elev_ft);
    const phases = deploy === 'dual'
      ? [[r.drogue, altitudeFt, dp.main_deploy_altitude_ft], [r.main, dp.main_deploy_altitude_ft, 0]]
      : [[r.main, altitudeFt, 0]];
    for (const [model, profile] of Object.entries(profiles)) {
      const path = simulateDriftPath(profile, altitudeFt, phases, dp.site_elev_ft, dp.descent_step_ft);
      out.push({ model, path });
    }
  }
  pathCache.set(cacheKey, out);
  return out;
}

// History mode's equivalent of zoneFor(), for a "Specific altitude" override
// -- HISTORY.points_by_key only has data at the discrete ladder's own
// altitudes (precomputed server-side, at exactly the two named fast/slow
// presets -- see config.SINGLE_DEPLOY_RATES_FPS/DUAL_DEPLOY_RATES_FPS),
// same limitation zoneFor() itself doesn't have (it reads a published wind
// profile and can simulate any altitude, at whatever rate is currently
// active). Since build_points_history() now also publishes each capture's
// own wind profile (wind_profiles_by_capture, same shape as
// DATA.wind_profiles but one per capture date), this does the same
// just-in-time simulation renderHistory()/renderAccuracyTable() need,
// across every capture instead of just the current one -- at the current
// state.rateFps directly (unlike the ladder-altitude lookup elsewhere in
// History, this path is never reading the server's precomputed fast/slow
// buckets, so it isn't limited to naming one of them; a hand-edited custom
// rate applies here exactly like it does in byAltitude/byTime). Returns
// [{capture_date, model, x_ft, y_ft}, ...] -- the same flat shape
// HISTORY.points_by_key[key] already is, so callers don't need to branch on
// where the points came from.
function historyPointsForAltitude(timeMinutes, deploy, altitudeFt) {
  const cacheKey = `${timeMinutes}_${deploy}_${altitudeFt}`;
  if (historyZoneCache.has(cacheKey)) return historyZoneCache.get(cacheKey);

  const dp = DATA.descent_params;
  const points = [];
  if (!(deploy === 'single' && altitudeFt > dp.single_deploy_max_alt_ft)) {
    const r = groundEquivalentRateFps(state.rateFps, dp.site_elev_ft);
    const phases = deploy === 'dual'
      ? [[r.drogue, altitudeFt, dp.main_deploy_altitude_ft], [r.main, dp.main_deploy_altitude_ft, 0]]
      : [[r.main, altitudeFt, 0]];
    for (const captureDate of (HISTORY?.captures || [])) {
      // Each capture date has its OWN real hour set (dense on a fresh
      // capture, sparse on an old one pulled before WIND_PROFILE_HOURS_LOCAL
      // existed) -- blendProfilesForTime() (not the DATA-bound
      // profilesForTime() wrapper) brackets against THIS capture's own
      // keys, not the live/current capture's.
      const captureProfiles = HISTORY.wind_profiles_by_capture?.[captureDate];
      if (!captureProfiles) continue;
      const captureHours = Object.keys(captureProfiles).map(Number).sort((a, b) => a - b);
      if (!captureHours.length) continue;
      const timeProfiles = blendProfilesForTime(captureProfiles, captureHours, timeMinutes);
      if (!timeProfiles) continue;
      for (const [model, profile] of Object.entries(timeProfiles)) {
        const [x_ft, y_ft] = simulateDrift(profile, altitudeFt, phases, dp.site_elev_ft, dp.descent_step_ft);
        points.push({ capture_date: captureDate, model, x_ft, y_ft });
      }
    }
  }
  historyZoneCache.set(cacheKey, points);
  return points;
}

// 3D History's data source (descent3d.js) -- descentPathsFor()'s full-path
// treatment (simulateDriftPath(), not historyPointsForAltitude()'s
// landing-point-only simulateDrift()), but scoped to ONE specific capture
// date instead of looping every one of them. Unlike the 2D trend line
// (historyPointsForAltitude(), above), 3D can only show one path per model
// at a time -- there's no equivalent of "every capture superimposed" here,
// the caller picks a capture (state.isolatedCapture ?? state.pinnedCapture)
// the same way renderHistory() already does for the 2D hull.
function historyPathsForCapture(captureDate, timeMinutes, deploy, altitudeFt) {
  const cacheKey = `${captureDate}_${timeMinutes}_${deploy}_${altitudeFt}`;
  if (historyPathCache.has(cacheKey)) return historyPathCache.get(cacheKey);

  const dp = DATA.descent_params;
  const out = [];
  if (!(deploy === 'single' && altitudeFt > dp.single_deploy_max_alt_ft)) {
    const captureProfiles = HISTORY?.wind_profiles_by_capture?.[captureDate];
    const captureHours = captureProfiles ? Object.keys(captureProfiles).map(Number).sort((a, b) => a - b) : [];
    const timeProfiles = captureHours.length ? blendProfilesForTime(captureProfiles, captureHours, timeMinutes) : null;
    if (timeProfiles) {
      const r = groundEquivalentRateFps(state.rateFps, dp.site_elev_ft);
      const phases = deploy === 'dual'
        ? [[r.drogue, altitudeFt, dp.main_deploy_altitude_ft], [r.main, dp.main_deploy_altitude_ft, 0]]
        : [[r.main, altitudeFt, 0]];
      for (const [model, profile] of Object.entries(timeProfiles)) {
        out.push({ model, path: simulateDriftPath(profile, altitudeFt, phases, dp.site_elev_ft, dp.descent_step_ft) });
      }
    }
  }
  historyPathCache.set(cacheKey, out);
  return out;
}

// The T+1 HRRR-analysis "actual" flight, as a real path -- HISTORY.actuals
// (build_points_history()) already publishes this hour's landing POINT
// (the 2D star, unaffected by any of this), HISTORY.actual_wind_profile is
// the raw profile behind it, published alongside for exactly this: running
// the same simulateDriftPath() every model gets, so the actual result
// plots as a real apogee-to-ground path in 3D, not just a terminal dot.
// Independent of which capture is selected (state.pinnedCapture/
// isolatedCapture) -- it's the target date's own single post-flight
// analysis, not a forecast tied to any particular capture, so this shows
// regardless of which forecast date is currently active.
// HISTORY.actual_wind_profile, blended to timeMinutes the same circular-mean
// way every model's own forecast profile already is (blendProfilesForTime())
// -- null if no analysis has been published for this target date yet.
// Shared by historyActualPathForAltitude() (the full apogee-to-ground path)
// and descent3d.js's own hover tooltip (path3dHandleHover(), which only
// needs the profile itself to interpWind() at one altitude, not a whole
// simulated path) -- both need the identical blend, not two independent
// copies of the wrap-and-blend step.
function actualProfileForTime(timeMinutes) {
  const rawProfile = HISTORY?.actual_wind_profile;
  const hours = rawProfile ? Object.keys(rawProfile).map(Number).sort((a, b) => a - b) : [];
  if (!hours.length) return null;
  // Wrapped as a single-key {actual: profile} dict per hour so
  // blendProfilesForTime() -- built for {model: profile} -- blends this one
  // real source the exact same circular-mean way, no separate blend
  // implementation to keep correct.
  const wrapped = {};
  for (const h of hours) wrapped[h] = { actual: rawProfile[h] };
  return blendProfilesForTime(wrapped, hours, timeMinutes)?.actual || null;
}

function historyActualPathForAltitude(timeMinutes, deploy, altitudeFt) {
  const cacheKey = `${timeMinutes}_${deploy}_${altitudeFt}`;
  if (historyActualPathCache.has(cacheKey)) return historyActualPathCache.get(cacheKey);

  const dp = DATA.descent_params;
  let path = null;
  if (!(deploy === 'single' && altitudeFt > dp.single_deploy_max_alt_ft)) {
    const profile = actualProfileForTime(timeMinutes);
    if (profile) {
      const r = groundEquivalentRateFps(state.rateFps, dp.site_elev_ft);
      const phases = deploy === 'dual'
        ? [[r.drogue, altitudeFt, dp.main_deploy_altitude_ft], [r.main, dp.main_deploy_altitude_ft, 0]]
        : [[r.main, altitudeFt, 0]];
      path = simulateDriftPath(profile, altitudeFt, phases, dp.site_elev_ft, dp.descent_step_ft);
    }
  }
  historyActualPathCache.set(cacheKey, path);
  return path;
}

// Draggable launch pad: capped at DATA.max_pad_move_ft from the surveyed GPS
// point -- per-site (config.SITES[...]["max_pad_move_ft"] server-side, see
// its own comment there), since a club's real alternate pads aren't the
// same distance out everywhere. Defaults to 2000ft: every model here is on a
// grid coarser than that anyway (HRRR, the finest, is ~3km/~9,800ft), so
// nothing within it could ever pull a different forecast value regardless
// of exact placement, and it's generous enough for a real "set up on the
// other side of the field" adjustment without modeling an actually
// different site. Set per-dataset in initFromData(), not just on first
// load like railAngleDeg -- this is a physical fact about whichever site
// is currently selected, not a standing user preference that should
// survive a site switch unchanged.
let MAX_PAD_MOVE_FT = 2000;
// Not part of `state` -- like railAngleDeg, this is a standing "what if"
// exploration setting, not a "which zone am I looking at" selection. Reset
// on site switch (selectSite()) since a different site's pad is a genuinely
// different GPS point, but left alone across date switches within a site.
let padOffsetFt = { x: 0, y: 0 };

function ftToPx(x_ft, y_ft) {
  return [
    SITE_GEOMETRY.site_px[0] + (x_ft + padOffsetFt.x) * SITE_GEOMETRY.ft_to_px_scale.x,
    SITE_GEOMETRY.site_px[1] - (y_ft + padOffsetFt.y) * SITE_GEOMETRY.ft_to_px_scale.y,
  ];
}

// Same conversion, without padOffsetFt -- for points that are real/absolute
// GPS measurements (a real flight's launch rail, apogee, and landing; see
// drawRealFlightMarker()), not positions relative to wherever the pad
// marker currently is. Dragging the pad marker is a "what if the pad were
// here" hypothetical for the *model* points and splash zone, which really
// are defined relative to the assumed pad position -- a real GPS fix has
// its own fixed lat/lon and must not move just because the pad marker did.
function ftToPxAbsolute(x_ft, y_ft) {
  return [
    SITE_GEOMETRY.site_px[0] + x_ft * SITE_GEOMETRY.ft_to_px_scale.x,
    SITE_GEOMETRY.site_px[1] - y_ft * SITE_GEOMETRY.ft_to_px_scale.y,
  ];
}

// --- rail angle: directional apogee shift (replaces the old omnidirectional
// buffer band, computeBufferHullPx()/bufferedPointsFt()) --------------------
// Real weathercocking is directional, not a fog of uncertainty: with the
// rail pointed straight up, a rocket still naturally curves INTO the wind
// during boost due to aerodynamics alone (confirmed directly, not assumed --
// "rail is straight up, rocket turns into the wind as it leaves the rail
// due to wind"). The old buffer instead expanded every zone into a
// symmetric ring in every direction ("it could land pretty much anywhere"),
// which isn't what actually happens and hid the one interesting diagnostic
// this could offer: a real flight's deviation NOT lining up with that day's
// ground wind argues against weathercocking as the explanation (points at
// the rocket/motor instead) -- not built as a feature here, but the reason
// getting the heading right matters beyond just prettier output.
//
// RSO correction (leaning the rail to counter the expected weathercock) is
// deliberately NOT modeled -- confirmed directly: "We don't need to model
// that." This is purely the physical into-wind curve itself; adjusting away
// from the default heading is the user's own exploration (an intentionally
// angled rail, or testing a hypothesis about a real flight's deviation),
// not something this tool infers.
function circularMeanDeg(degrees) {
  if (!degrees.length) return 0;
  const sinSum = degrees.reduce((s, d) => s + Math.sin(d * Math.PI / 180), 0);
  const cosSum = degrees.reduce((s, d) => s + Math.cos(d * Math.PI / 180), 0);
  return ((Math.atan2(sinSum, cosSum) * 180 / Math.PI) + 360) % 360;
}

// {speedMph, directionDeg} averaged/circular-mean across every model
// currently reporting real ground wind for the slider's current time --
// null if this capture has no wind row at all, or no model has real data
// for the nearest published hour (a rare gap, not the common case).
// directionDeg is the SAME raw Open-Meteo "from" bearing DATA.wind's own
// direction field already is (see windVaneHTML()'s own comment) -- not
// flipped to a downwind display convention, since railShiftFt() below
// needs the true "which way is the wind coming FROM" bearing to shift the
// apogee INTO it, matching the confirmed physical convention directly.
function currentGroundWind() {
  if (!DATA.wind) return null;
  const h = nearestPublishedHour(state.timeMinutes);
  const cellData = DATA.wind.hourly[h];
  if (!cellData) return null;
  const real = weatherPanelModels().map(m => cellData[m]).filter(c => c && c.speed !== null && c.direction !== null);
  if (!real.length) return null;
  return {
    speedMph: real.reduce((s, c) => s + c.speed, 0) / real.length,
    directionDeg: circularMeanDeg(real.map(c => c.direction)),
  };
}

// railHeadingDeg itself is ONLY ever the user's own explicit override (null
// otherwise, see its own declaration) -- this is what every actual
// consumer (railShiftFt, the dial's own drawn position, the permalink
// builder) reads instead, so the un-chosen default is always freshly
// computed from whatever DATA/state.timeMinutes currently are, never a
// stale cached value that needs its own invalidation bookkeeping. Falls
// back to due north (0deg, an arbitrary but harmless default -- shift
// magnitude still defaults to a real, non-zero value even then) only when
// there's no wind data at all to track, which is rare.
function effectiveRailHeadingDeg() {
  if (railHeadingDeg !== null) return railHeadingDeg;
  const wind = currentGroundWind();
  return wind ? wind.directionDeg : 0;
}

// Pure display-time translation, exactly like padOffsetFt already is (see
// its own comment) -- NOT a re-simulation. Wind doesn't meaningfully vary
// across the few-hundred-foot lateral offsets this angle range produces,
// the same approximation that already justifies padOffsetFt not
// triggering one either, so "simulate straight up, then rigidly translate
// the result by the rail-tilt vector" is physically equivalent to actually
// starting the integration off-center, without touching the sim/cache/
// hit-testing code at all -- and composes for free with an active pad-
// offset preview, since both are just added together downstream (see
// ftToPxShifted() below).
//
// Direct sin/cos of the heading -- NOT the negated wind-PUSH convention
// simulateDrift() uses for its own vector math (`u = -spd*sin(drc)`, wind
// blowing FROM drc pushes the rocket toward drc+180). This is a different
// calculation: the shift's own heading target IS "point toward this
// compass bearing" directly, so no negation -- confirmed sign convention
// directly: the apogee shifts INTO the wind (toward its own FROM bearing),
// so effectiveRailHeadingDeg() (already the raw "from" bearing) is used
// as-is.
function railShiftFt(altitudeFt) {
  const shiftFt = Math.max(0, altitudeFt) * Math.tan((railAngleDeg ?? 0) * Math.PI / 180);
  const headingRad = effectiveRailHeadingDeg() * Math.PI / 180;
  return { x: shiftFt * Math.sin(headingRad), y: shiftFt * Math.cos(headingRad) };
}

// ftToPx(), plus the rail-angle shift at this altitude -- the one call
// every zone/point-drawing site should use instead of bare ftToPx() (see
// drawPoint()/drawZone()'s own call sites). Real/absolute GPS points (a
// real flight's own launch rail, apogee, landing) still go through
// ftToPxAbsolute() below, untouched -- the rail-angle shift is a property
// of the SIMULATED trajectory, not a real measurement.
function ftToPxShifted(x_ft, y_ft, altitudeFt) {
  const shift = railShiftFt(altitudeFt);
  return ftToPx(x_ft + shift.x, y_ft + shift.y);
}

// --- History view: one splash point per model per capture date ------------
// (see the comment at MODE_LABELS for why it's "History" not "Drift").
// Deliberately simplified relative to the main view: no wind speed/
// direction, no hull/buffer, just where each model's point landed and how
// that moved capture to capture, for one fixed hour/deploy/rate/altitude.

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
// grayscale ramp -- this needs to be unmistakable, not just another data
// point in the series. Called "final projection" in the UI, not "actual" --
// it's still HRRR's own post-launch analysis run through our own descent
// sim (assumed rates, not real ones), not a real GPS landing. That
// distinction only started mattering once real flights (below) existed too
// and "actual" started meaning two different things.
const PROJECTION_MARKER_COLOR = '#e0b400';
const PROJECTION_MARKER_STROKE = '#1a1a19';
// A real GPS-tracked flight (see analyze_real_flight.py) -- distinct from
// both the model-shape colors and PROJECTION_MARKER_COLOR's gold, since it's a
// genuinely different kind of thing (a real measured position, not any
// model's estimate, including the HRRR-analysis "actual" proxy).
const REAL_FLIGHT_COLOR = '#e91e8c';
// This one flight's own predicted landing (real apogee + real derived
// rates + real wind, see predicted_landing_offset_from_pad_ft) -- shown in
// place of PROJECTION_MARKER_COLOR's star while comparing a real flight
// (setRealFlightComparing()), so it needs to read as clearly different from
// that star, not just a variant of it.
const PREDICTED_LANDING_COLOR = '#06b6d4';
const PREDICTED_LANDING_STROKE = '#1a1a19';
// This flight's own apogee -- real (GPS-measured) or, for a no-GPS
// altimeter, estimated (see apogee.position_source and the info box's own
// note) -- shown alongside the other real-flight markers while comparing.
// Distinct from every other color already in use here.
const APOGEE_MARKER_COLOR = '#84cc16';
const APOGEE_MARKER_STROKE = '#1a1a19';

// Unified marker drawer for both model-shape points (History mode) and the
// star-shaped actual-landing marker -- one place that knows how to render
// each shape name, rather than scattering per-shape SVG construction.
function drawMarker(parent, shape, cx, cy, size, fill, stroke) {
  let el;
  // A raw circle radius=size / square half-width=size / triangle
  // circumradius=size / etc. don't come out to the same visual area
  // (a square is ~4x a plus's area at the same `size`, a diamond ~2x a
  // triangle's) -- this is why ICON (diamond) and ECMWF (square) used to
  // read as "two different-sized squares" rather than genuinely distinct
  // marks. SHAPE_SIZE_MULT nudges each shape's own size so they read as
  // roughly the same visual weight; 'target'/'star' keep their own
  // hand-tuned proportions (relative to `size`, not an absolute shape
  // comparison) and are deliberately excluded.
  if (shape !== 'target' && shape !== 'star') size *= (SHAPE_SIZE_MULT[shape] || 1);
  if (shape === 'target') {
    // ring + inner dot -- a real GPS-measured position (see the pad marker's
    // own ring+crosshair, same "this is a real surveyed/measured point, not
    // a model estimate" visual language), distinct from every model-shape
    // marker and from the "actual" star. Sets its own fill/stroke per
    // sub-element rather than the shared attrs below (a ring needs fill:none
    // where a dot needs a solid one), so it returns early.
    el = document.createElementNS(ns, 'g');
    // Invisible-but-painted backing circle spanning the full radius, drawn
    // first (so the ring/dot render on top of it) -- without this, the
    // annulus between the ring's stroke and the inner dot has no fill or
    // stroke at all, so it doesn't register pointer events. A mouse
    // crossing that gap while roaming the marker's bounding box then
    // repeatedly fires mouseenter/mouseleave (found via real jitter on
    // hover, not a hypothetical). fill-opacity near-zero, not exactly 0 --
    // SVG's default pointer-events value (visiblePainted) excludes fully
    // transparent fills from hit-testing, but not a technically-nonzero one.
    const hitArea = document.createElementNS(ns, 'circle');
    hitArea.setAttribute('cx', cx); hitArea.setAttribute('cy', cy); hitArea.setAttribute('r', size);
    hitArea.setAttribute('fill', fill);
    hitArea.setAttribute('fill-opacity', '0.01');
    el.appendChild(hitArea);
    const ring = document.createElementNS(ns, 'circle');
    ring.setAttribute('cx', cx); ring.setAttribute('cy', cy); ring.setAttribute('r', size);
    ring.setAttribute('fill', 'none');
    ring.setAttribute('stroke', fill);
    ring.setAttribute('stroke-width', 2.5);
    el.appendChild(ring);
    const dot = document.createElementNS(ns, 'circle');
    dot.setAttribute('cx', cx); dot.setAttribute('cy', cy); dot.setAttribute('r', size * 0.4);
    dot.setAttribute('fill', fill);
    el.appendChild(dot);
    parent.appendChild(el);
    return el;
  } else if (shape === 'circle') {
    el = document.createElementNS(ns, 'circle');
    el.setAttribute('cx', cx); el.setAttribute('cy', cy); el.setAttribute('r', size);
  } else if (shape === 'square') {
    el = document.createElementNS(ns, 'rect');
    el.setAttribute('x', cx - size); el.setAttribute('y', cy - size);
    el.setAttribute('width', size * 2); el.setAttribute('height', size * 2);
    el.setAttribute('rx', 2);
  } else {
    // polygon shapes: triangle-up, triangle-down, diamond, star, plus, x
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
  if (shape === 'plus' || shape === 'x') {
    // Same 12-point cross outline for both -- 'x' is just 'plus' rotated
    // 45 degrees, not a separately-derived shape, so there's one geometry
    // to keep correct instead of two.
    const a = size * 0.38, b = size; // arm half-width, arm reach
    const raw = [
      [-a, -b], [a, -b], [a, -a], [b, -a], [b, a], [a, a],
      [a, b], [-a, b], [-a, a], [-b, a], [-b, -a], [-a, -a],
    ];
    const rad = (shape === 'x' ? 45 : 0) * Math.PI / 180;
    const cos = Math.cos(rad), sin = Math.sin(rad);
    return raw.map(([x, y]) => [cx + x * cos - y * sin, cy + x * sin + y * cos]);
  }
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
  const cx = 8, cy = 8;
  let size = 5.5;
  if (shape === 'target') {
    return `<svg width="16" height="16" viewBox="0 0 16 16" style="flex-shrink:0;">
      <circle cx="${cx}" cy="${cy}" r="${size}" fill="none" stroke="${color}" stroke-width="2" />
      <circle cx="${cx}" cy="${cy}" r="${size * 0.4}" fill="${color}" /></svg>`;
  }
  if (shape !== 'star') size *= (SHAPE_SIZE_MULT[shape] || 1); // see drawMarker()'s own comment
  let inner;
  if (shape === 'circle') inner = `<circle cx="${cx}" cy="${cy}" r="${size}" />`;
  else if (shape === 'square') inner = `<rect x="${cx - size}" y="${cy - size}" width="${size * 2}" height="${size * 2}" rx="1.5" />`;
  else {
    const pts = shapePolygonPoints(shape, cx, cy, size);
    inner = `<polygon points="${pts.map(p => p.join(',')).join(' ')}" />`;
  }
  return `<svg width="16" height="16" viewBox="0 0 16 16" style="flex-shrink:0;"><g fill="${color}" stroke="var(--point-stroke)" stroke-width="1">${inner}</g></svg>`;
}

// Real GPS-tracked flight (see analyze_real_flight.py) -- hover shows the
// info box, click pins it open (click again to release, matching every
// other pin control in this app), and clicking anywhere else on the page
// closes it too (see the document-level listener by showRealFlightBox()).
// That last part matters more here than elsewhere: touch has no hover state
// at all, so click has to be a full substitute, not just a shortcut, and a
// pinned box needs its own way to close again on a device that can't hover
// off it to do so implicitly.
// Rebuilds the shared rail/predicted-landing/apogee overlay to describe
// whichever flight activeRealFlight() currently resolves to (or removes it
// entirely if that's none) -- a 'target'-shape marker is a multi-element
// group (see drawMarker()), so "moving" it means redrawing it, not just
// updating cx/cy. Always (re)creates hidden (display:none); the caller is
// responsible for calling setRealFlightComparing() to reveal it, same as
// drawRealFlightMarker() did inline before this was split out to also serve
// hover/pin switches between different flights on the same map.
function updateActiveRealFlightOverlay() {
  [launchRailEl, predictedLandingStarEl, apogeeMarkerEl].forEach(el => el && el.remove());
  launchRailEl = predictedLandingStarEl = apogeeMarkerEl = null;
  activeOverlaySvgPoints = [];
  const flight = activeRealFlight();
  if (!flight) return;

  // Real launch-rail GPS position -- separate from the pad's *configured*
  // lat/lon (a surveyed/estimated point, not necessarily exactly where this
  // rail sat). Model points and the splash zone stay anchored to the
  // configured pad *plus* padOffsetFt -- clicking a real-flight marker snaps
  // padOffsetFt to this rail offset automatically, so the projections line
  // up against where the rocket actually flew without the user needing to
  // find and drag the crosshair by hand. Not interactive itself
  // (pointer-events: none) -- purely informational.
  const railOffset = flight.launch.offset_from_pad_ft;
  const [railPx, railPy] = ftToPxAbsolute(railOffset.x, railOffset.y);
  launchRailEl = drawMarker(svg, 'target', railPx, railPy, 6, REAL_FLIGHT_COLOR, REAL_FLIGHT_COLOR);
  launchRailEl.style.display = 'none';
  launchRailEl.style.pointerEvents = 'none';

  // This flight's own predicted landing (real apogee + real derived rates +
  // real wind) -- shown in place of the generic "Final projection" star
  // while comparing, see setRealFlightComparing().
  const predOffset = flight.predicted_landing_offset_from_pad_ft;
  const [predPx, predPy] = ftToPxAbsolute(predOffset.x, predOffset.y);
  predictedLandingStarEl = drawMarker(svg, 'star', predPx, predPy, 13, PREDICTED_LANDING_COLOR, PREDICTED_LANDING_STROKE);
  predictedLandingStarEl.style.display = 'none';
  // Not interactive, same as apogeeMarkerEl/launchRailEl below -- matters
  // more here than for those two: for a no-GPS-style flight (analyze_no_gps())
  // this sits at the *exact same point* as the real landing marker beneath
  // it (predicted landing = estimated apogee + descent sim, solved to match
  // the real one), so without this the star's opaque fill silently eats
  // clicks meant for that marker, leaving only a thin sliver of its ring
  // clickable through the star's points -- confirmed directly: a real click
  // dead-center on the landing marker didn't pin it until this was added.
  predictedLandingStarEl.style.pointerEvents = 'none';

  // This flight's own apogee -- real if apogee.position_source is
  // 'gps_measured', otherwise estimated (see analyze_no_gps() and the info
  // box's own note, which explains the difference to the viewer). Same
  // treatment either way here: not interactive, revealed alongside the
  // other real-flight markers while comparing.
  const apogeeOffset = flight.apogee.offset_from_pad_ft;
  const [apogeePx, apogeePy] = ftToPxAbsolute(apogeeOffset.x, apogeeOffset.y);
  apogeeMarkerEl = drawMarker(svg, 'triangle-up', apogeePx, apogeePy, 9, APOGEE_MARKER_COLOR, APOGEE_MARKER_STROKE);
  apogeeMarkerEl.style.display = 'none';
  apogeeMarkerEl.style.pointerEvents = 'none';

  activeOverlaySvgPoints = [[railPx, railPy], [predPx, predPy], [apogeePx, apogeePy]];
}

function drawRealFlightMarker() {
  REAL_FLIGHTS.forEach((flight, i) => {
    const { x, y } = flight.landing.offset_from_pad_ft;
    const [px, py] = ftToPxAbsolute(x, y);
    const marker = drawMarker(svg, 'target', px, py, 11, REAL_FLIGHT_COLOR, REAL_FLIGHT_COLOR);
    marker.style.cursor = 'pointer';

    // Screen-space positions of every point the info box needs to dodge --
    // computed fresh per event since pan/zoom can move them between
    // renders, and re-reads activeOverlaySvgPoints (rather than closing over
    // a snapshot) since it's only valid for whichever flight is active at
    // call time -- always this one, since it's read right after this
    // marker's own handlers make flight `i` active below.
    const avoidPoints = () => [svgToScreen(px, py), ...activeOverlaySvgPoints.map(([ax, ay]) => svgToScreen(ax, ay))];

    marker.addEventListener('pointerdown', evt => evt.stopPropagation()); // don't let #map-wrap's pan handler eat this click
    marker.addEventListener('mousemove', evt => {
      hoveredRealFlightIndex = i;
      updateActiveRealFlightOverlay();
      setRealFlightComparing(true);
      showRealFlightBox(evt, avoidPoints());
    });
    marker.addEventListener('mouseleave', () => {
      hoveredRealFlightIndex = null;
      updateActiveRealFlightOverlay();
      setRealFlightComparing(pinnedRealFlightIndex !== null);
      hideRealFlightBox();
    });
    marker.addEventListener('click', evt => {
      evt.stopPropagation(); // don't let the document-level click-away listener immediately re-close this
      const alreadyPinnedHere = pinnedRealFlightIndex === i;
      pinnedRealFlightIndex = alreadyPinnedHere ? null : i;
      if (pinnedRealFlightIndex !== null) {
        // No reason to leave the pad marker somewhere that isn't this
        // flight's real launch position once it's known -- snap it here
        // instead of making the user find and drag the crosshair by hand to
        // see the projections lined up against where the rocket actually
        // flew. Only save the pre-snap position on the *first* snap (see
        // padOffsetBeforeRealFlightSnap's own declaration) -- switching the
        // pin straight from one flight to another shouldn't clobber it with
        // the previous flight's rail. render() rebuilds every marker
        // (including this overlay, via renderHistory() -> drawRealFlightMarker()
        // -> updateActiveRealFlightOverlay()); avoidPoints() below reads it
        // fresh afterward.
        if (padOffsetBeforeRealFlightSnap === null) padOffsetBeforeRealFlightSnap = padOffsetFt;
        setPadOffsetClamped(flight.launch.offset_from_pad_ft.x, flight.launch.offset_from_pad_ft.y);
        // Line the displayed splash zone/history key up with this flight's
        // own real launch time and apogee altitude, rather than leaving
        // whatever hour/altitude happened to already be selected -- these
        // are exactly the buckets analyze_real_flight.py itself picked as
        // "closest" for its own model-forecast comparison (closest_hour /
        // altitude_bucket_used_ft), so this is the one apples-to-apples zone
        // for this flight. Not reverted on unpin (see restorePadFromRealFlightSnap()
        // below, which only ever reverts the pad snap) -- unlike that snap,
        // this is a normal user-facing selection worth leaving as-is.
        state.timeMinutes = flight.closest_hour * 60;
        hourExplicitlyChosen = true;
        // Nearest-match, not exact equality -- the published bucket may not
        // exist verbatim in DATA.altitudes if this date's zone JSON predates
        // a master-ladder change (see config.ALTITUDES_MASTER_FT).
        const bucket = flight.delta_from_predictions.altitude_bucket_used_ft;
        state.compareAlt = DATA.altitudes.reduce((best, a) =>
          Math.abs(a - bucket) < Math.abs(best - bucket) ? a : best, DATA.altitudes[0]);
        // A pinned real flight compares against its own published altitude
        // bucket specifically -- a specific-altitude override active from
        // before would show an unrelated zone instead, so clear it.
        state.customAlt = null;
        syncAltCustomUI();
        // Resync the slider's thumb position against the state.timeMinutes
        // reassignment above -- a full renderWeatherPanel() rebuild, same
        // way this used to re-run buildToggle('hour-toggle', ...) just to
        // refresh its active button.
        renderWeatherPanel();
        buildAltList();
        render();
      } else {
        restorePadFromRealFlightSnap();
      }
      updateActiveRealFlightOverlay();
      setRealFlightComparing(pinnedRealFlightIndex !== null || hoveredRealFlightIndex !== null);
      if (pinnedRealFlightIndex !== null) showRealFlightBox(evt, avoidPoints());
      else hideRealFlightBox();
    });
  });

  updateActiveRealFlightOverlay();

  // Keeps the info box current if it's left open (pinned, or still hovered)
  // while the pad marker gets dragged by hand -- otherwise it'd only ever
  // reflect whatever it read at the moment the box was last (re)opened.
  if (realFlightBox.style.display === 'block') realFlightBox.innerHTML = realFlightBoxHTML();
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

  // Ladder-altitude lookup key reads the server's precomputed bucket, which
  // only ever exists at the two named presets -- falls back to 'fast' if
  // the current rateFps is a custom edit matching neither (see
  // historyPointsForAltitude()'s own comment; the customAlt branch below
  // doesn't have this limitation, it simulates at whatever rateFps actually
  // is right now).
  const rate = state.rateName || 'fast';
  // "Specific altitude" overrides the ladder selection here too, same as
  // byAltitude/byTime -- computed just-in-time per capture date via
  // historyPointsForAltitude() instead of the precomputed
  // HISTORY.points_by_key lookup, which only has data at the ladder's own
  // altitudes. actuals (the HRRR-analysis star) stays ladder-only either
  // way (see build_points_history()'s comment) -- keying it off the same
  // effective altitude means it naturally, silently doesn't show for a
  // custom altitude, same tri-state UX as a date with no actuals at all.
  const altitude = state.customAlt !== null ? state.customAlt : state.compareAlt;
  const key = `${nearestPublishedHour(state.timeMinutes)}_${state.deploy}_${rate}_${altitude}`;
  const rawPoints = state.customAlt !== null
    ? historyPointsForAltitude(state.timeMinutes, state.deploy, altitude)
    : (HISTORY.points_by_key[key] || []);
  const seriesByModel = {};
  rawPoints.forEach(pt => {
    (seriesByModel[pt.model] ??= []).push(pt);
  });
  const actual = HISTORY.actuals[key];

  const activeCapture = state.isolatedCapture ?? state.pinnedCapture;

  // Splash polygon for the hovered/pinned forecast age: same core-hull
  // treatment drawZone() uses for the main view (no separate buffer band
  // any more -- see railShiftFt()'s own comment), built from that one
  // capture date's own shifted points across the currently-selected models
  // (same composable filtering the accuracy table already does) -- lets
  // the actual star be read against "how big was the projected area that
  // day," not just its distance to each individual point.
  if (activeCapture) {
    const dayPoints = rawPoints.filter(pt => {
      if (pt.capture_date !== activeCapture) return false;
      if (!state.selectedModels.has(pt.model)) return false;
      return true;
    });
    if (dayPoints.length) {
      const corePx = convexHull(dayPoints.map(p => [p.x_ft, p.y_ft])).map(([x, y]) => ftToPxShifted(x, y, altitude));
      const core = document.createElementNS(ns, 'polygon');
      core.setAttribute('points', polyPoints(corePx));
      core.setAttribute('class', 'zone-core');
      core.setAttribute('fill', zoneBaseColor);
      core.setAttribute('fill-opacity', '0.42');
      core.setAttribute('stroke', zoneBaseColor);
      core.setAttribute('stroke-opacity', '0.85');
      svg.appendChild(core);
    }
  }

  Object.entries(seriesByModel).forEach(([model, series]) => {
    if (!state.selectedModels.has(model)) return;
    let sorted = [...series].sort((a, b) => new Date(a.capture_date) - new Date(b.capture_date));
    if (activeCapture) sorted = sorted.filter(pt => pt.capture_date === activeCapture);
    if (!sorted.length) return;
    const shape = MODEL_SHAPES[model] || 'circle';
    const pxPts = sorted.map(p => ftToPxShifted(p.x_ft, p.y_ft, altitude));

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
      const [px, py] = pxPts[i];
      const marker = drawMarker(svg, shape, px, py, 9, MODEL_COLORS_HEX[model] || 'var(--point-fill)');
      marker.classList.add('pt');
      // rp.hour stays a plain integer hour (not state.timeMinutes directly)
      // -- isPointVisible()/applyIsolation() compare it against
      // state.isolatedHour/pinnedHour, which are themselves plain hours
      // shared with byTime mode's own rp construction elsewhere; History
      // mode doesn't actually drive those two fields (it isolates by
      // capture date instead, see activeCapture above), so this is inert
      // today either way, just kept type-consistent.
      const rp = { model, x_ft: pt.x_ft, y_ft: pt.y_ft, px, py, capture_date: pt.capture_date, altitude, hour: nearestPublishedHour(state.timeMinutes) };
      renderedPoints.push(rp);
      marker.addEventListener('mousemove', evt => showTooltip(evt, rp));
      marker.addEventListener('mouseleave', hideTooltip);
    });
  });

  projectionStarEl = null;
  if (actual) {
    // Shifted like every other simulated point -- `actual` is the HRRR-
    // analysis wind profile run through the same simulate() every model
    // uses (see compute_actual_points()), not a real GPS measurement, so
    // it gets the same rail-angle treatment as any other model's point.
    const [px, py] = ftToPxShifted(actual.x_ft, actual.y_ft, altitude);
    projectionStarEl = drawMarker(svg, 'star', px, py, 13, PROJECTION_MARKER_COLOR, PROJECTION_MARKER_STROKE);
  }

  drawRealFlightMarker();
  // A render can happen for reasons unrelated to this marker (e.g. toggling
  // a model checkbox elsewhere) while the box is still pinned or hovered
  // open -- reapply the swap so a fresh render doesn't silently revert it.
  setRealFlightComparing(pinnedRealFlightIndex !== null || hoveredRealFlightIndex !== null);
}

// --- Accuracy-vs-actual table (History mode only) ---------------------------
// Cell color uses the fixed 4-step status scale (good/warning/serious/
// critical), not a plain sequential ramp -- the color here literally means
// "how accurate," not just "big number" (dataviz skill's own carve-out for
// exactly this case: status tokens are legal, even required, when the color
// *means* good/bad rather than encoding identity). Dark ink (#1a1a19) on all
// four clears >=3:1 text contrast (verified 5.19/9.49/6.6/3.62); every
// cell's number is always visible as text too, so color is never the sole
// channel.
//
// Green means the same thing across every site/date/altitude, not "best of
// what happens to be in this table" -- an earlier per-table-quartile version
// let the same color mean wildly different things (e.g. a 188ft miss read
// as the worst color in one low-altitude/calm-day table while 337ft read as
// the best color in a higher-drift one elsewhere, since each table was only
// ever graded against itself). A miss is graded instead against how far the
// wind actually carried the rocket that day (the actual point's own
// distance from the pad) -- the same absolute error matters more on a
// short, calm flight than a long, windy one. Below
// ACCURACY_GREEN_FLOOR_FT it's always green regardless of that ratio --
// a miss that small is one nobody's actually unhappy with in practice, and
// percentage-of-a-tiny-drift blows up meaninglessly on very calm days
// anyway. The percentage bands beyond that floor are placeholders (25/50/
// 100% of the actual drift distance), not a principled derivation --
// revisit as more real launches accumulate.
const ACCURACY_COLORS = ['#0ca30c', '#fab219', '#ec835a', '#d03b3b']; // good -> critical
const ACCURACY_GREEN_FLOOR_FT = 200;
const ACCURACY_PCT_BANDS = [0.25, 0.50, 1.00]; // good/warning/serious cutoffs, as a fraction of the actual drift distance

function accuracyColor(errorFt, actualDistFt) {
  // Monotonically non-decreasing by construction: ACCURACY_PCT_BANDS is
  // itself increasing, so pct*actualDistFt only grows across the array, and
  // max(floor, x) preserves that ordering -- no separate clamp needed.
  const cutoffs = ACCURACY_PCT_BANDS.map(pct => Math.max(ACCURACY_GREEN_FLOOR_FT, pct * actualDistFt));
  if (errorFt <= cutoffs[0]) return ACCURACY_COLORS[0];
  if (errorFt <= cutoffs[1]) return ACCURACY_COLORS[1];
  if (errorFt <= cutoffs[2]) return ACCURACY_COLORS[2];
  return ACCURACY_COLORS[3];
}

const ACCURACY_BAND_LABELS = ['Good', 'Warning', 'Serious', 'Critical'];
// Built from the same constants accuracyColor() itself uses, not
// hand-duplicated text -- if the bands above ever change, this changes with
// them instead of quietly going stale.
const ACCURACY_BAND_DESCRIPTIONS = [
  `within ${ACCURACY_GREEN_FLOOR_FT}ft, or ${Math.round(ACCURACY_PCT_BANDS[0] * 100)}% of the day's drift`,
  `up to ${Math.round(ACCURACY_PCT_BANDS[1] * 100)}% of the day's drift`,
  `up to ${Math.round(ACCURACY_PCT_BANDS[2] * 100)}% of the day's drift`,
  `over ${Math.round(ACCURACY_PCT_BANDS[2] * 100)}% of the day's drift`,
];

function buildAccuracyLegend() {
  const el = document.getElementById('accuracy-legend');
  if (el.childElementCount) return; // static -- doesn't depend on data, build once
  el.innerHTML = ACCURACY_COLORS.map((color, i) => `
    <span class="accuracy-legend-item">
      <span class="accuracy-legend-swatch" style="background:${color}"></span>
      ${ACCURACY_BAND_LABELS[i]} <span class="accuracy-legend-desc">(${ACCURACY_BAND_DESCRIPTIONS[i]})</span>
    </span>`).join('');
}

function renderAccuracyTable() {
  const section = document.getElementById('accuracy-section');
  // Same 'fast' fallback renderHistory() uses -- see its own comment.
  const rate = state.rateName || 'fast';
  // Same effective-altitude override renderHistory() uses. actuals is only
  // ever precomputed at the discrete ladder's own altitudes (see
  // build_points_history()'s comment), so a custom altitude simply finds no
  // `actual` below and the whole table stays hidden -- same as any other
  // date with no actuals published yet, not a special case to code around.
  const altitude = state.customAlt !== null ? state.customAlt : state.compareAlt;
  const key = `${nearestPublishedHour(state.timeMinutes)}_${state.deploy}_${rate}_${altitude}`;
  const actual = HISTORY && HISTORY.actuals[key];
  if (!actual) return; // stays hidden -- render() already set display:none
  buildAccuracyLegend();

  // Respects the same model-checkbox selection and isolate/pin forecast-age
  // filters as the map so the table always matches what's plotted --
  // deselecting models narrows the rows, isolating one forecast age narrows
  // the columns.
  const activeCapture = state.isolatedCapture ?? state.pinnedCapture;

  const seriesByModel = {};
  (HISTORY.points_by_key[key] || []).forEach(pt => {
    if (!state.selectedModels.has(pt.model)) return;
    (seriesByModel[pt.model] ??= []).push(pt);
  });
  // Ordered to match the Model legend (MODEL_LEGEND_ORDER), not
  // alphabetically -- so a model's row/column position reads the same here
  // as its swatch position in the legend everywhere else in the viewer.
  const models = MODEL_LEGEND_ORDER.filter(m => seriesByModel[m]);
  if (!models.length) return;
  const captures = activeCapture ? [activeCapture] : HISTORY.captures;

  // The pad is always the ft-space origin (see simulate()/ftToPx()), so the
  // actual point's own distance from it is just its own magnitude -- this is
  // accuracyColor()'s scale reference, computed once per table since it
  // doesn't vary per model/capture.
  const actualDistFt = Math.hypot(actual.x_ft, actual.y_ft);

  const cellData = {}; // model -> capture_date -> {dist, dx, dy}
  let hasAnyCell = false;
  models.forEach(model => {
    cellData[model] = {};
    seriesByModel[model].forEach(pt => {
      if (activeCapture && pt.capture_date !== activeCapture) return;
      const dx = pt.x_ft - actual.x_ft, dy = pt.y_ft - actual.y_ft;
      const dist = Math.hypot(dx, dy);
      cellData[model][pt.capture_date] = { dist, dx, dy };
      hasAnyCell = true;
    });
  });
  if (!hasAnyCell) return;

  const table = document.getElementById('accuracy-table');
  let html = '<thead><tr><th>Model</th>';
  captures.forEach(c => {
    html += `<th>${leadDaysLabel(c, HISTORY.target_date)}</th>`;
  });
  html += '</tr></thead><tbody>';
  models.forEach(model => {
    html += `<tr><th>${model}</th>`;
    captures.forEach(c => {
      const cell = cellData[model][c];
      if (!cell) {
        html += '<td class="accuracy-empty">&mdash;</td>';
        return;
      }
      const color = accuracyColor(cell.dist, actualDistFt);
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
  // px/py computed here via ftToPx(), not carried on `pt` itself -- zoneFor()
  // only produces raw x_ft/y_ft (see its own comment), and even before that
  // change a baked pixel position would only ever be right when the pad
  // hasn't been dragged (see padOffsetFt); computing it fresh here is what
  // makes every rendered point actually move with the pad, same as the
  // hulls (which already go through ftToPxShifted() too).
  const [px, py] = ftToPxShifted(pt.x_ft, pt.y_ft, altitude);
  const rp = Object.assign({}, pt, { altitude, hour, px, py });
  renderedPoints.push(rp);
  // Shape = model now (see MODEL_SHAPES's comment), same signal History
  // mode already used -- duplicated here once shape stopped being needed
  // for Fast/Slow (only one point per model any more, see
  // buildRateEditor()'s own comment).
  const shape = MODEL_SHAPES[pt.model] || 'circle';
  const marker = drawMarker(g, shape, px, py, 9, fillColor);
  marker.classList.add('pt');
  marker.addEventListener('mousemove', evt => showTooltip(evt, rp));
  marker.addEventListener('mouseleave', hideTooltip);
}

function drawZone(zone, color, hour) {
  const g = document.createElementNS(ns, 'g');
  g.setAttribute('class', 'zone-group');
  g.dataset.alt = zone.altitude;
  g.dataset.hour = hour;

  const points = zone.points.filter(pt => state.selectedModels.has(pt.model));

  if (state.selectedModels.size === 1) {
    // Exactly one model selected (via single-click-to-only or double-click
    // solo -- either path lands here the same way): exactly one point now
    // (one model, one active rate -- see buildRateEditor()'s own comment),
    // so a filled hull isn't meaningful either. Draw the pad->point bearing
    // as a line instead, and plot the point itself -- colored by the MODEL
    // now, not the zone (altitude/time). Used to be zone-colored, back when
    // shape meant nothing here (every point was a plain circle, so color
    // was the only channel available at all); now that shape identifies
    // model everywhere (see MODEL_SHAPES's own comment), a zone-colored fill
    // under a model-specific shape sent two contradicting signals -- "this
    // is GFS" (shape) filled with "this is the 9,000ft zone" (color).
    // Reported directly as a real regression once shape started meaning
    // something here. altitude/time still reads from the legend the user
    // just isolated/pinned to get here, same as before -- only the point's
    // own paint changed.
    const modelPoints = points;
    if (modelPoints.length > 0) {
      const modelColor = MODEL_COLORS_HEX[modelPoints[0].model] || color;
      // The pad itself -- offset-aware (padOffsetFt), but NOT rail-shifted:
      // the shift represents where the ROCKET ends up relative to a fixed
      // rail base, not the rail base itself moving.
      const [sx, sy] = ftToPx(0, 0);
      const line = document.createElementNS(ns, 'polyline');
      const linePts = [[sx, sy], ...modelPoints.map(p => ftToPxShifted(p.x_ft, p.y_ft, zone.altitude))];
      line.setAttribute('points', linePts.map(p => p.join(',')).join(' '));
      line.setAttribute('fill', 'none');
      line.setAttribute('stroke', modelColor);
      line.setAttribute('stroke-width', 3);
      line.setAttribute('stroke-opacity', '0.85');
      g.appendChild(line);

      modelPoints.forEach(pt => drawPoint(g, pt, hour, zone.altitude, modelColor));
    }
    svg.appendChild(g);
    return;
  }

  // The hull is recomputed from `points` -- `zone.points` itself is
  // computed just-in-time by zoneFor() (see its own comment) from the
  // published wind profile at whatever rate the rate editor currently has
  // set -- there's no separate server-baked point set any more to fall
  // back to. No separate buffer polygon any more (see railShiftFt()'s own
  // comment) -- the core hull itself is built from each point's own
  // rail-shifted position instead of a symmetric band drawn around the
  // unshifted points.
  const corePx = convexHull(points.map(p => [p.x_ft, p.y_ft])).map(([x, y]) => ftToPxShifted(x, y, zone.altitude));
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
// isolatedX (pure hover, cleared on mouseleave) or padOffsetFt/the color
// pickers (personal display preferences already persisted via localStorage,
// not part of a shareable launch scenario). `layer` is the exception among
// the localStorage-backed prefs -- see mapLayer's own comment for why it's
// also shareable. `date`/`t`/`deploy`/`railangle`/`railheading` are further
// gated behind an explicit user action each -- see
// dateExplicitlyChosen/hourExplicitlyChosen/deployExplicitlyChosen/
// railAngleExplicitlyChosen/railHeadingExplicitlyChosen's declarations for
// why.
function buildPermalinkParams(includeDate) {
  const p = new URLSearchParams();
  p.set('site', currentSiteId);
  if (includeDate && dateSelect.value) p.set('date', dateSelect.value);
  p.set('mode', state.mode);
  p.set('layer', mapLayer);
  // Explicit-only, unlike mode/layer just above -- 2D is the fixed default
  // (no stored-preference fallback to override the way layer's is), so
  // there's nothing for an unconditional write to protect against; only
  // worth spending the query-string space when it's actually 3D.
  if (mapViewMode === '3d') p.set('view', '3d');
  // t=HH:MM, not the legacy hour=N int -- carries the slider's own 15-min
  // precision. freshState() still reads a bare ?hour=N link too (as N*60),
  // so an old shared permalink keeps working, just without that precision.
  if (hourExplicitlyChosen) p.set('t', formatTimeParam(state.timeMinutes));
  if (deployExplicitlyChosen) p.set('deploy', state.deploy);
  if (railAngleExplicitlyChosen) p.set('railangle', railAngleDeg);
  // Only the CHOSEN heading, never the live-tracked default -- a shared
  // link should reproduce "the user picked this exact heading," not freeze
  // in whatever the ground wind happened to be at the moment of sharing
  // (a stale ?railheading= would silently stop tracking wind for whoever
  // opens it later, the opposite of what an un-chosen heading means).
  if (railHeadingExplicitlyChosen) p.set('railheading', railHeadingDeg);
  // Only emit when it's a real subset -- same "don't pin defaults into the
  // URL" convention as everywhere else here. buildModelLegend() always
  // resolves the sentinel/re-validates before this can run (it runs on
  // every render, and a permalink is only ever built from a live view), so
  // state.selectedModels is a real Set by the time we get here.
  if (state.selectedModels) {
    const available = state.mode === 'byHistory' ? historyModelsAvailable() : modelsWithData();
    if (state.selectedModels.size !== available.size) {
      p.set('models', [...state.selectedModels].join(','));
    }
  }
  if (!tempShowApparent) p.set('temp', 'actual');
  if (cloudAltitudesExpanded) p.set('clouds', 'all');
  if (padOffsetFt.x !== 0 || padOffsetFt.y !== 0) {
    const { lat, lon } = padFtToLatLon(padOffsetFt.x, padOffsetFt.y);
    p.set('pad', `${lat.toFixed(6)},${lon.toFixed(6)}`);
  }
  // Altitude is a URL param on every view -- just under a different state
  // field/param name depending which one that view actually uses:
  // byAltitude's multi-select ladder (selectedAlts, see buildAltList()) via
  // `alts` (comma-joined, only when a real subset -- same "don't pin
  // defaults into the URL" convention as `models` above; legacy single-value
  // `alt=` is still read on load for backward compat, but never written any
  // more), or the "which altitude to compare across hours/captures"
  // selection byTime and byHistory both use (compareAlt) via `compare`.
  if (state.mode === 'byAltitude' && state.selectedAlts) {
    const withZones = altitudesWithZones();
    if (state.selectedAlts.size !== withZones.size) {
      p.set('alts', [...state.selectedAlts].join(','));
    }
  }
  if ((state.mode === 'byTime' || state.mode === 'byHistory') && state.compareAlt !== null) p.set('compare', state.compareAlt);
  if (state.mode === 'byHistory' && state.pinnedCapture !== null) p.set('capture', state.pinnedCapture);
  // Direct-entry altitude (see syncAltCustomUI()) -- a real ft value, always
  // worth sharing when set (there's no "default" for it to differ from).
  if (state.customAlt !== null) p.set('customalt', state.customAlt);
  // Editable rate (see buildRateEditor()) -- emitted only when it differs
  // from the 'fast' default, same convention as altmin/altmax above. Prefers
  // the short `rate=slow` form when rateFps exactly matches a named preset
  // (rateName tracks that -- see freshState()'s comment); falls back to the
  // explicit `rates=drogue/main` pair for a hand-edited value matching
  // neither.
  const r = state.rateFps;
  if (state.rateName && state.rateName !== 'fast') {
    p.set('rate', state.rateName);
  } else if (!state.rateName) {
    p.set('rates', `${r.drogue}/${r.main}`);
  }
  return p;
}

function syncUrl() {
  if (!DATA) return;
  history.replaceState(null, '', `${location.pathname}?${buildPermalinkParams(dateExplicitlyChosen).toString()}`);
}

// BASE_VB seeds from the pull's own default-rate sweep (splash_zones.py's
// build_viewer_data(), a disc-extent sweep at config.DUAL_DEPLOY_RATES_FPS/
// SINGLE_DEPLOY_RATES_FPS) -- a user dialing in a slower rate client-side can
// drift past that box. Grows (never shrinks -- a monotonic ceiling avoids the
// zoom-out limit jittering as the selection changes) to whatever the
// currently-drawn zones' own rail-shifted points actually reach, reassigned
// as a new array each time (not mutated in place) so a fresh
// DATA.base_view_box on the next dataset load starts clean. `zones` is
// whatever render() is about to draw -- computing their shifted px extent
// here duplicates a little of drawZone()'s own work, but it's cheap (see
// simulateDrift()'s own comment on performance headroom) and lets the
// background rect be sized correctly *before* it's drawn, not after.
function growBaseViewBox(zones) {
  const allX = [], allY = [];
  zones.forEach(zone => {
    zone.points.forEach(pt => {
      const [x, y] = ftToPxShifted(pt.x_ft, pt.y_ft, zone.altitude);
      allX.push(x); allY.push(y);
    });
  });
  if (!allX.length) return;
  const pad = 80;
  const minX = Math.min(BASE_VB[0], Math.min(...allX) - pad);
  const minY = Math.min(BASE_VB[1], Math.min(...allY) - pad);
  const maxX = Math.max(BASE_VB[0] + BASE_VB[2], Math.max(...allX) + pad);
  const maxY = Math.max(BASE_VB[1] + BASE_VB[3], Math.max(...allY) + pad);
  const span = Math.max(maxX - minX, maxY - minY);
  const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
  BASE_VB = [cx - span / 2, cy - span / 2, span, span];
  MAX_SPAN = Math.max(BASE_VB[2], BASE_VB[3]) * 1.4;
}

function render() {
  svg.innerHTML = '';
  renderedPoints = [];
  document.getElementById('accuracy-section').style.display = 'none'; // shown by renderAccuracyTable() in History mode only, when actuals exist

  // Zones computed before the background rect below is sized/drawn -- see
  // growBaseViewBox()'s own comment -- so a slower-than-default rate that
  // drifts past the pull's own default-rate sweep still gets a correctly
  // sized background instead of being clipped.
  // state.customAlt (the "Specific altitude" field) overrides the whole
  // ladder/selectedAlts selection in every mode -- byAltitude/byTime read it
  // here via zoneFor(); byHistory reads it inside renderHistory()/
  // renderAccuracyTable() themselves (via historyPointsForAltitude()) since
  // that branch doesn't build zones the same way, so it's untouched below.
  let altitudeZones = [], timeZones = [];
  if (state.mode === 'byAltitude') {
    // Every rung's zone-group is built unconditionally now, not filtered by
    // a range (removed 2026-08 along with the old dual-thumb slider) --
    // applyIsolation() toggles which ones are actually visible afterward
    // (state.selectedAlts), a cheap show/hide against DOM that already
    // exists. Building only the selected subset here would work for the
    // FIRST toggle but break re-checking a previously-unchecked altitude --
    // applyIsolation() doesn't rebuild, so there'd be nothing in the DOM
    // left to un-hide.
    // A real rocketry sim result (ASCENT_RESULTS) collapses the whole
    // ladder down to ONE zone, at resolveMapAltFt()'s own sim-priority
    // altitude (2026-08, same "apogee number" fix as resolveMapAltFt()'s
    // own comment -- once a real physics answer exists, the manually-
    // checked ladder rungs are stale, same reasoning customAlt already
    // gets below) -- mirrors what renderDescent3D() (descent3d.js) already
    // does for the 3D view's own altitude, so the two views agree on which
    // altitude the descent actually starts from instead of the zone here
    // silently still reflecting whatever was checked before the sim ran.
    altitudeZones = ASCENT_RESULTS
      ? [zoneFor(state.timeMinutes, state.deploy, resolveMapAltFt())].filter(Boolean)
      : state.customAlt !== null
        ? [zoneFor(state.timeMinutes, state.deploy, state.customAlt)].filter(Boolean)
        : zonesFor(state.timeMinutes, state.deploy);
    growBaseViewBox(altitudeZones);
  } else if (state.mode === 'byTime') {
    // Unaffected by the time slider -- this mode shows every DATA.hours
    // zone at once (its own weather-panel-independent concept), each an
    // exact published hour, never blended. zoneFor() itself now takes
    // minutes, so `hour*60` here, not state.timeMinutes.
    const orderedHours = [...DATA.hours].sort((a, b) => b - a);
    const alt = state.customAlt !== null ? state.customAlt : state.compareAlt;
    timeZones = orderedHours.map(hour => ({ hour, zone: zoneFor(hour * 60, state.deploy, alt) })).filter(hz => hz.zone);
    growBaseViewBox(timeZones.map(hz => hz.zone));
  }

  // First real render for this dataset: start the visible view at this
  // site's own hand-tuned default if one's been set (SITE_DEFAULT_VIEWS),
  // else BASE_VB (what's actually relevant -- the current zones' own
  // extent, just grown above for byAltitude/byTime, or the server's own
  // default sweep as-is for byHistory, which doesn't grow it) rather than
  // the far wider full detail image -- per direction, a user shouldn't need
  // to zoom in just to see their own data; zooming OUT (up to MAX_SPAN) is
  // still how to reach the wider image for context. Only the very first
  // render after a dataset loads does this -- every render after that
  // leaves `view` alone, so an ordinary hour/rate/deploy change never
  // fights a manual pan/zoom already in progress.
  if (!viewInitialized) {
    const vb = defaultViewBox();
    view = { x: vb[0], y: vb[1], w: vb[2], h: vb[3] };
    viewInitialized = true;
  }

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
  const wideImgHref = `maps/${currentSiteId}/wide_${mapLayer}_web.jpg`;
  const detailImgHref = `maps/${currentSiteId}/detail_${mapLayer}_web.jpg`;

  const WIDE_VB = SITE_GEOMETRY.wide_view_box;
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
    // one time of day, every in-range altitude, colored by altitude.
    // ALT_COLORS_HEX is a ramp built from DATA.altitudes (initFromData()) --
    // a custom altitude won't be a key in it, so falls back to the user's
    // own chosen base zone color directly rather than an undefined fill.
    const ordered = [...altitudeZones].sort((a, b) => b.altitude - a.altitude);
    // drawZone()'s own `hour` param stays a plain integer hour everywhere
    // (g.dataset.hour/rp.hour are shared with byTime mode's own isolation/
    // tooltip logic below, which assume exactly that) -- not the slider's
    // full timeMinutes precision, which isn't displayed via this path
    // anyway (showTooltip()'s whenPart is empty for byAltitude regardless).
    ordered.forEach(zone => drawZone(zone, ALT_COLORS_HEX[zone.altitude] || zoneBaseColor, nearestPublishedHour(state.timeMinutes)));
  } else if (state.mode === 'byHistory') {
    renderHistory();
    renderAccuracyTable();
  } else {
    // "I'm flying to this altitude -- what time of day is best?": one fixed
    // altitude, all 4 times of day at once, colored by time instead.
    // Drawn latest-time-first so earlier times layer on top, matching the
    // by-altitude view's "smallest/most-relevant on top" convention.
    timeZones.forEach(({ hour, zone }) => drawZone(zone, TIME_COLORS_HEX[hour], hour));
  }

  drawPadMarker();
  drawPredictedApogeeMarker();

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

// Where apogee actually ends up, ground-projected -- pad + the rail-angle
// boost deviation (railShiftFt(), same math the 3D view's own dashed boost
// line uses for its apogee end, see path3dDrawBoostLine()'s comment).
// Requested directly: at any nonzero rail angle, every zone/point already
// silently starts its descent sim from this shifted point (see
// railShiftFt()'s own comment), but the 2D map itself never showed WHERE
// that was, unlike 3D -- only the pad marker (always at padOffsetFt, never
// shifted by rail angle) and the zones themselves (descent drift already
// mixed in, not a clean "here's just the boost deviation" reference point).
// Reuses the exact same triangle-up marker style
// (APOGEE_MARKER_COLOR/APOGEE_MARKER_STROKE) the real-flight overlay's own
// apogee marker already uses elsewhere in this file -- same concept (a
// rocket's apogee position), same visual language, not a new color/shape
// invented for this. resolveMapAltFt() (shared with the map-anchored
// altitude slider/3D) picks ONE representative altitude regardless of mode
// -- same "one shared boost deviation, not per-model/per-hour/per-capture"
// reasoning path3dDrawBoostLine() already established, since the boost
// phase finishes before any wind data (or capture-date choice) comes into
// play at all. Hidden at rail angle 0 -- apogee sits directly above the pad
// then, and a second marker stacked exactly on top of the pad's own
// crosshair would be pure clutter with nothing new to show.
//
// Interactive on hover (requested directly, 2026-08-10) -- own
// mousemove/mouseleave pair directly on the marker element, same idiom
// drawRealFlightMarker() already uses for its own fixed (non-drag) markers,
// rather than routing through showTooltip()'s renderedPoints-proximity
// system, which this marker isn't a member of. Content mirrors
// showTooltip()'s own "offset:.../distance from pad:..." phrasing for a
// consistent feel, plus heading (effectiveRailHeadingDeg() directly -- the
// same value the shift itself was computed from, not re-derived via
// atan2(shift.x, shift.y), which would just be a roundabout way of
// recovering the same number).
// With a real rocketry sim result active (ASCENT_RESULTS, set by the
// message listener above), its own apogee ground offset stands in for the
// tan(angle) approximation here too -- same substitution path3dDrawScene()
// (descent3d.js) already makes for the 3D view's own boost line/railShift,
// see that function's own comment. Shown regardless of railAngleDeg (which
// is disabled/irrelevant in this mode -- see the message listener's own
// `.sim-active` class toggle): the real sim's own weathercocking always
// produces a nonzero ground offset, unlike the dial defaulting to 0.
// One marker PER MODEL now while a sim is active (2026-08, requested
// directly: "Apogee on 2d is still showing as a single triangle... matching
// the color/symbols for the forecasts... so the user can tell which models
// are predicting where" -- real per-model apogee offsets are worth
// distinguishing here, unlike ascentMeanApogeeFt()'s mean, which stays a
// single number feeding ONE shared descent-simulation start altitude
// (resolveMapAltFt()), a different concern from "where does each model's
// own apogee actually land"). Same MODEL_SHAPES/MODEL_COLORS_HEX
// convention every landing-point marker on this map already uses (see
// drawPoint()) plus a same-colored ring around each one (requested
// directly) -- without it a shape+color-matched apogee marker would be
// visually indistinguishable from an actual landing-point marker at a
// glance; the ring is this view's equivalent of the 3D view's own hollow
// apogee circle (path3dDrawPath()), a second visual cue for "this is
// apogee, not a landing point." Dial mode (no sim) keeps the single
// triangle below -- there's no per-model position to plot there at all,
// the dial only ever produces one shared tan(angle) shift.
function drawPredictedApogeeMarker() {
  const simActive = !!ASCENT_RESULTS;
  if (!simActive && !(railAngleDeg ?? 0)) return;

  if (simActive) {
    // state.timeMinutes directly, not a snapped hour -- same interpolated
    // lookup renderDescent3D() uses (descent3d.js's ascentPathForModel()
    // own comment), so the 2D and 3D views never disagree about what
    // they're each showing at this exact slider position.
    const models = (state.selectedModels ? [...state.selectedModels] : MODEL_LEGEND_ORDER)
      .filter(model => ascentPathForModel(model, state.timeMinutes));
    models.forEach(model => {
      const shift = ascentApogeeFt(ascentPathForModel(model, state.timeMinutes));
      const color = MODEL_COLORS_HEX[model] || '#888';
      const [sx, sy] = ftToPx(shift.x, shift.y);
      const marker = drawMarker(svg, MODEL_SHAPES[model] || 'circle', sx, sy, 9, color);
      marker.style.cursor = 'help';
      const ring = document.createElementNS(ns, 'circle');
      ring.setAttribute('cx', sx); ring.setAttribute('cy', sy); ring.setAttribute('r', 14);
      ring.setAttribute('fill', 'none');
      ring.setAttribute('stroke', color);
      ring.setAttribute('stroke-width', 2);
      ring.setAttribute('pointer-events', 'none'); // sits over the marker's own hover target, must not steal its events
      svg.appendChild(ring);

      marker.addEventListener('mousemove', evt => {
        const dist = Math.hypot(shift.x, shift.y);
        const heading = ascentBearingDeg(shift.x, shift.y);
        tooltip.style.display = 'block';
        tooltip.innerHTML = `<div class="tt-row">${modelNameHTML(model)} &mdash; predicted apogee</div>` +
          `<div class="tt-row">${Math.round(shift.altFt).toLocaleString()} ft<br>` +
          `offset: ${shift.x >= 0 ? '+' : ''}${shift.x.toFixed(0)} ft E, ${shift.y >= 0 ? '+' : ''}${shift.y.toFixed(0)} ft N<br>` +
          `distance from pad: ${dist.toFixed(0)} ft<br>` +
          `heading: ${Math.round(heading)}&deg; (${compassDir(heading)})</div>`;
        positionTooltip(evt);
      });
      marker.addEventListener('mouseleave', hideTooltip);
    });
    return;
  }

  // Dial mode -- unchanged single triangle (no sim, no per-model data).
  const altFt = resolveMapAltFt();
  const shift = railShiftFt(altFt);
  const [sx, sy] = ftToPx(shift.x, shift.y);
  const marker = drawMarker(svg, 'triangle-up', sx, sy, 9, APOGEE_MARKER_COLOR, APOGEE_MARKER_STROKE);
  marker.style.cursor = 'help';
  marker.addEventListener('mousemove', evt => {
    const dist = Math.hypot(shift.x, shift.y);
    const heading = effectiveRailHeadingDeg();
    tooltip.style.display = 'block';
    tooltip.innerHTML = `<div class="tt-row"><b>Predicted apogee</b><br>` +
      `${Math.round(altFt).toLocaleString()} ft<br>` +
      `offset: ${shift.x >= 0 ? '+' : ''}${shift.x.toFixed(0)} ft E, ${shift.y >= 0 ? '+' : ''}${shift.y.toFixed(0)} ft N<br>` +
      `distance from pad: ${dist.toFixed(0)} ft<br>` +
      `heading: ${Math.round(heading)}&deg; (${compassDir(heading)})</div>`;
    positionTooltip(evt);
  });
  marker.addEventListener('mouseleave', hideTooltip);
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
    // Empty, not a restated "at default" sentence -- see index.html's own
    // comment above .pad-move-control for why that line was dropped.
    padReadout.textContent = '';
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
  // Same one-way 3D-only-supports-byAltitude/byHistory fallback setMode()
  // applies on a live click (see its own comment) -- a URL combining
  // ?view=3d with ?mode=byTime would otherwise land on a combination
  // renderDescent3D() already tolerates gracefully (its own empty-state
  // hint), but correcting it here keeps first-load behavior identical to
  // what clicking those buttons in that order already does live.
  if (mapViewMode === '3d' && state.mode !== 'byAltitude' && state.mode !== 'byHistory') {
    mapViewMode = '2d';
  }
  // Altitude count varies 5-9 per site (scaled to that site's own waiver --
  // see config.altitudes_for_site()), so the ramp is rebuilt against this
  // dataset's real list every time, not just when the picker changes.
  ALT_COLORS_HEX = computeSequentialRamp(zoneBaseColor, DATA.altitudes);
  // Same reasoning, same fix -- DATA.hours' own checkpoint values can
  // differ from whatever this module's top-level TIME_COLORS_HEX literal
  // assumed (a real, confirmed break: an already-published capture's
  // DATA.hours still had the OLD checkpoint set the day SPLASH_HOURS_LOCAL
  // changed, and every DATA.hours-keyed lookup against the NEW hardcoded
  // literal came back undefined -- crashing bucketRainCell() outright via
  // RAIN_HOUR_BUCKETS, see its own comment for that fix). Rebuilt against
  // this capture's own real DATA.hours every load, not assumed to match
  // config.py's current SPLASH_HOURS_LOCAL.
  TIME_COLORS_HEX = computeSequentialRamp(timeBaseColor, DATA.hours);
  BASE_VB = DATA.base_view_box;
  IMG_VB = SITE_GEOMETRY.image_view_box;
  // Not set to BASE_VB here either -- BASE_VB can still grow once render()
  // (called at the end of this function) runs growBaseViewBox() against
  // the live rate/altitude selection, which isn't resolved yet at this
  // point. render() itself sets `view` from the final grown BASE_VB on
  // this first call (viewInitialized, declared above).
  viewInitialized = false;
  MIN_SPAN = IMG_VB[2] * 0.15;
  MAX_SPAN = Math.max(BASE_VB[2], BASE_VB[3]) * 1.4;
  if (railAngleDeg === null) {
    // first load only -- see its declaration. URL wins over the default
    // when the link was explicitly built with one (see
    // railAngleExplicitlyChosen), clamped to the dial's own range since a
    // hand-edited URL could carry anything. Default is 0 (no shift), not
    // DATA.boost_angle_deg -- per direction, showing a nonzero shift before
    // the user has ever touched the dial implied a false certainty about
    // which way the rail's tipped; the reference wind ray on the dial
    // itself (see updateRailDialUI()) is what points at the live default
    // heading now, without silently pre-applying its magnitude too.
    const urlRailAngle = Number(URL_PARAMS.get('railangle'));
    railAngleDeg = (railAngleExplicitlyChosen && !Number.isNaN(urlRailAngle))
      ? Math.min(RAIL_ANGLE_MAX_DEG, Math.max(0, urlRailAngle))
      : 0;
  }
  // Heading, unlike the magnitude above, is NOT resolved once and cached --
  // only a URL-supplied explicit choice sets the actual railHeadingDeg
  // variable here (first load only, same as the magnitude); otherwise it
  // stays null so effectiveRailHeadingDeg() keeps live-tracking the ground
  // wind on every subsequent load/render, not just the first.
  if (railHeadingExplicitlyChosen && railHeadingDeg === null) {
    const urlRailHeading = Number(URL_PARAMS.get('railheading'));
    if (!Number.isNaN(urlRailHeading)) railHeadingDeg = ((Math.round(urlRailHeading) % 360) + 360) % 360;
  }
  updateRailDialUI();
  // Every load, not just first -- see MAX_PAD_MOVE_FT's own declaration.
  MAX_PAD_MOVE_FT = DATA.max_pad_move_ft ?? 2000;
  // Every load, not just first -- a new dataset means a new windUrl/hour
  // context, so a previous sim result (a different launch's own ascent
  // path) would be actively wrong here, not just stale.
  ASCENT_RESULTS = null;
  railAngleControl.classList.remove('sim-active');
  railAngleControl.title = '';
  if (!padUrlApplied) {
    padUrlApplied = true;
    const urlPad = URL_PARAMS.get('pad');
    if (urlPad && SITE_GEOMETRY.site_lat !== undefined) {
      const [latStr, lonStr] = urlPad.split(',');
      const lat = Number(latStr), lon = Number(lonStr);
      if (!Number.isNaN(lat) && !Number.isNaN(lon)) {
        const { x, y } = padLatLonToFt(lat, lon);
        setPadOffsetClamped(x, y); // same cap manual dragging respects -- a hand-edited URL could carry anything
      }
    }
  }

  buildToggle('mode-toggle', ['byAltitude', 'byTime', 'byHistory'], MODE_LABELS, 'mode', () => setMode(state.mode));
  // Hour selection is built as part of renderWeatherPanel() below (its
  // header row's own time slider) -- no standalone #hour-toggle any more.
  buildToggle('deploy-toggle', DATA.deploys, DEPLOY_LABELS, 'deploy', onDeployChanged);
  buildTimeLegend();
  buildAltList();
  buildModelLegend();
  buildRateEditor();
  renderMapAltDeployReadout();
  syncAltCustomUI(); // reflects a URL-loaded ?customalt= on first render
  banDismissed = false; // a dismiss on a previous site/date shouldn't suppress a genuinely new ban
  renderWeatherPanel();
  renderBanStatus();
  render();
  // Moved to run AFTER render() (2026-08 fix) -- also syncs the 3D button's
  // own disabled-in-byTime state (see its own comment). Was called much
  // earlier in this function, right after the mode-fallback check above --
  // a real, confirmed bug: this can trigger renderDescent3D(), which for
  // byHistory+3D with nothing pinned yet calls a full render() of its own
  // (see that function's own comment). Called this early, BASE_VB/IMG_VB
  // above hadn't been set yet, so that inner render() crashed on
  // `BASE_VB[0]` of undefined -- and since the crash was synchronous and
  // uncaught, every line after the old call site (the mode toggle,
  // altitude list, weather panel, ban status, this very render() call)
  // silently never ran at all for a direct byHistory+3D URL load --
  // confirmed via a full mode x view x viewport sweep, not a single
  // isolated case. Safe to move here: state.mode (all this function
  // needs) is already set at the very top of initFromData(), and by this
  // point BASE_VB/IMG_VB/the first real render() have all already
  // completed successfully, so a second render() this triggers is exactly
  // as safe as any other post-load render.
  updateMapViewModeUI();
}

// --- launch-date selector: driven by data/manifest.json, never a server-side
// directory listing (this is a static site -- pulls happen out-of-band via
// pull_live_forecast.py + splash_zones.py, which regenerates this manifest
// every time it processes a target date) ---
const subtitleEl = document.getElementById('subtitle');
const dateSelect = document.getElementById('date-select');
let manifestEntries = [];
// Static per-site map-projection geometry (site_px/image_view_box/
// wide_view_box/ft_to_px_scale/site_lat/site_lon) -- lives in manifest.json
// (fetched once per site, see loadSiteManifest() below), NOT in each dated
// capture's own JSON (DATA). 2026-08-11 fix: it used to be duplicated into
// every capture, which meant correcting a site's configured pad GPS left
// every already-published historical date silently pointing at the old
// pixel location until each one was individually regenerated. Reading it
// from here instead means a pad correction only ever needs manifest.json
// rebuilt (pipeline/splash_zones.py's regenerate_manifest(), no network,
// no per-date work) to take effect everywhere at once.
let SITE_GEOMETRY = null;

function describeEntry(entry) {
  const lead = entry.lead_days === 0 ? 'captured this morning' : `captured ${entry.capture_date} (T-${entry.lead_days})`;
  return `Target ${entry.target_date} &middot; ${lead} &middot; descent-only drift + rail-angle shift, per model`;
}

async function loadDataset(entry) {
  subtitleEl.textContent = 'Loading…';
  const resp = await fetchData(entry.data_path);
  DATA = await resp.json();
  CURRENT_DATA_PATH = entry.data_path;
  // zoneCache/pathCache/historyZoneCache below are keyed on
  // `${timeMinutes}_${deploy}_${altitude}` only -- no site or dataset
  // identifier -- despite zoneCache's own comment already claiming this was
  // cleared "on dataset load". It wasn't: switching sites (or dates) via the
  // dropdown calls loadDataset() without a page reload, so a cache hit here
  // silently returned a PREVIOUS site's zone for the same time/deploy/
  // altitude combo. Confirmed directly: SD Rocket Jockies at 9am/dual/
  // 10,000ft, then switching to Hutto at the same 9am/dual/10,000ft, kept
  // returning SD Rocket Jockies' own drift points (a different site's
  // geometry entirely) until a full page reload cleared the in-memory
  // cache -- reported as "Hutto disagreeing with itself at exactly 9am,"
  // which it wasn't; it was disagreeing with a different site's zones.
  invalidateZones();
  // wind_profiles/descent_params landed 2026-08, replacing precomputed
  // per-rate points -- everything downstream (freshState()'s rateFps seed,
  // zoneFor(), the rate editor) assumes they exist. Rather than scatter
  // defensive checks through all of that, bail out here before any of it
  // runs: an old-schema file predates client-side rate control and has no
  // zones to show at all, so say so plainly instead of leaving the
  // previous date's map on screen or crashing partway through setup.
  if (!DATA.wind_profiles) {
    svg.innerHTML = '';
    subtitleEl.innerHTML = `Target ${entry.target_date} &middot; <strong>this date predates client-side rate control -- re-run the pipeline to see its splash zones</strong>`;
    return;
  }
  // history_path is null for a target processed before this feature existed
  // -- HISTORY just stays null and the History view mode shows its own
  // "nothing published yet" state (see renderHistory()) instead of erroring.
  HISTORY = entry.history_path ? await (await fetchData(entry.history_path)).json() : null;
  // Empty for the overwhelming majority of targets -- a real GPS-tracked
  // flight is a rare, manually-fed-in thing (see analyze_real_flight.py),
  // not something every launch has. Usually 0 or 1 paths, occasionally more
  // than one (a site can fly more than one rocket the same day).
  REAL_FLIGHTS = entry.real_flight_paths?.length
    ? await Promise.all(entry.real_flight_paths.map(p => fetchData(p).then(r => r.json())))
    : [];
  pinnedRealFlightIndex = null;
  hoveredRealFlightIndex = null;
  padOffsetBeforeRealFlightSnap = null; // stale otherwise -- it'd belong to whatever target was just left
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

// Viewer's own local calendar date as "YYYY-MM-DD" -- lexicographically
// comparable directly against target_date strings with no Date parsing on
// the other side. Local (not UTC) so a page loaded a few hours either side
// of midnight still reads "today" the way the person looking at it would.
function todayLocalISO() {
  const d = new Date();
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function loadSiteManifest(manifestPath) {
  fetchData(manifestPath)
    .then(r => r.json())
    .then(manifest => {
      SITE_GEOMETRY = manifest.site_geometry;
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
      // Default to the NEXT upcoming launch (soonest target_date >= today),
      // not the latest one overall -- a real, reported bug: a multi-day event
      // (e.g. AIRFest spanning 9/4-9/7) defaulted to 9/7, the LAST day, since
      // manifestEntries is sorted descending and [0] is simply the largest
      // target_date regardless of whether it's already passed. People
      // planning ahead want the next thing coming up, not the last one on
      // the books. manifestEntries stays sorted descending here (upcoming is
      // a prefix of it, in the same order), so the soonest upcoming entry is
      // the LAST element of that filtered prefix, not its first.
      // Falls back to entries[0] (the most recent past date) exactly when no
      // entry is upcoming at all -- the requested "last date only if nothing
      // future is filled in" behavior.
      const upcoming = manifestEntries.filter(e => e.target_date >= todayLocalISO());
      let initialEntry = upcoming.length ? upcoming[upcoming.length - 1] : manifestEntries[0];
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
// (built by fetch_site_maps.py --regional; still reads the same
// name/club/has_data fields it would if this were a clickable regional map
// instead of a dropdown, just not the px/image_size_px marker-position
// ones). has_data per site comes from fetch_site_maps.py's
// refresh_regional_sites_metadata() (a real check against that site's
// manifest, not a hardcoded list); a site with no pull yet is still
// selectable but shows an honest "no data yet" state rather than a broken
// fetch.
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
// Site name + waiver -- an <h2> above the map now, not a line inside the
// (collapsible, and easy to miss) weather panel below it. A site-level fact
// that matters regardless of whether that panel happens to be open, so it
// gets its own always-visible header instead of living inside content that
// can be hidden.
function renderSiteHeading() {
  const el = document.getElementById('site-heading');
  const site = regionalSites?.sites?.[currentSiteId];
  el.textContent = site ? `${siteLabel(site)} — ${site.waiver_ft.toLocaleString()}ft waiver` : '';
}

function selectSite(siteId) {
  currentSiteId = siteId;
  siteSelect.value = siteId;
  padOffsetFt = { x: 0, y: 0 }; // a different site is a genuinely different GPS point, unlike a date switch
  const site = regionalSites.sites[siteId];
  renderSiteHeading();

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

fetchData('maps/regional/sites.json')
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
window.__CACHEBUST_TEST_MARKER__ = 'v2';
window.__CACHEBUST_TEST_MARKER__ = 'v2';
