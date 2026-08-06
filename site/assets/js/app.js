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
// state.isolatedRate ?? state.pinnedRate elsewhere in this file).
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
// Current render's "Final projection" (fast/slow preset) star. Per-flight
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
let TIME_COLORS_HEX = computeSequentialRamp(timeBaseColor, [9, 11, 13, 15]);

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
const HOUR_LABELS = { 9: '9am', 11: '11am', 13: '1pm', 15: '3pm' };
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

// History view: model identity is color (same MODEL_COLORS_HEX as every
// other view -- colored dots read better than a black/shape-only marker) AND
// shape, redundantly -- shape is the colorblind-safe fallback so identity
// never depends on color perception alone. Recency (which capture date a
// point is from) is its own selectable "Forecast age" filter
// (buildTimeLegend() in History mode) rather than a color/opacity gradient,
// so it doesn't need a channel here. "star" is deliberately not assigned to
// any model -- reserved for the actual-landing marker (see renderHistory())
// so it's never ambiguous with a model's projection.
const MODEL_SHAPES = { gfs: 'circle', ecmwf: 'square', gem: 'triangle-up', icon: 'diamond', arpege: 'triangle-down', hrrr: 'plus' };
// Circle = the faster rate, square = the slower one, so fast/slow reads at a
// glance without needing to hover. Single deploy uses the same fast/slow
// names as dual now (config.py's SINGLE_DEPLOY_RATES_FPS renamed 2026-08 --
// see zoneFor()), so this no longer needs to cover two different naming
// schemes.
const RATE_SHAPE = { slow: 'square', fast: 'circle' };

function activeRate() {
  return state.isolatedRate ?? state.pinnedRate; // 'fast' | 'slow' | null
}
function rateMatches(pt, active) {
  return !active || pt.rate === active;
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
let hourExplicitlyChosen = URL_PARAMS.has('hour');
let deployExplicitlyChosen = URL_PARAMS.has('deploy');
// Same treatment as hour/deploy above -- boostAngleDeg's default (10°,
// below) reproduces identically on any later visit, so it only goes in the
// URL once the slider's actually been touched (initFromData()'s own read of
// this flag) or arrived via a link that already had ?boost= on it.
let boostAngleExplicitlyChosen = URL_PARAMS.has('boost');
// pad needs DATA.site_lat/site_lon (to convert the URL's GPS coordinate
// back to a ft offset) which isn't available until initFromData() runs, so
// unlike the flags above this can't just be read into a plain boolean here
// -- applied once, gated by this same sentinel, right where MAX_PAD_MOVE_FT
// is set (see initFromData()).
let padUrlApplied = false;

function freshState() {
  const base = {
    mode: 'byAltitude',
    hour: DATA.hours[0], deploy: DATA.deploys[0],
    isolatedAlt: null, pinnedAlt: null,
    isolatedHour: null, pinnedHour: null,
    // Multi-select checkboxes, not hover-isolate/click-pin like every other
    // legend here -- see buildModelLegend()'s own comment for why models
    // specifically got this treatment. null is a sentinel ("not resolved
    // yet"), not "no models selected" -- buildModelLegend() resolves it to
    // every model with real data the first time it runs for this state.
    selectedModels: null,
    isolatedRate: null, pinnedRate: null,
    isolatedCapture: null, pinnedCapture: null, // History mode only -- which capture_date ("forecast age") to isolate
    compareAlt: DATA.altitudes[0], // which altitude "by time of day" mode compares across hours
    // Coarse pre-filter in front of isolatedAlt/pinnedAlt/compareAlt above --
    // see buildAltRange(). Defaults to the site's full ladder.
    altMin: DATA.altitudes[0], altMax: DATA.altitudes[DATA.altitudes.length - 1],
    // Direct-entry altitude (see syncAltCustomUI()) -- null unless the
    // "Specific altitude" checkbox is on. A real ft value, not restricted
    // to DATA.altitudes, since zoneFor() can simulate any altitude now
    // that the drift calc is client-side. Overrides the whole
    // range/ladder selection above in byAltitude/byTime (see render()).
    customAlt: null,
    // Editable Fast/Slow drogue+main fps (see buildRateEditor()) -- changes
    // which points exist, not just how they're drawn, so it lives here
    // rather than as a standing "what-if" global like boostAngleDeg.
    // structuredClone, not a plain reference -- DATA.descent_params.default_rates_fps
    // must never be mutated (it's the reset target and the permalink's
    // "is this the default" comparison).
    rateFps: structuredClone(DATA.descent_params.default_rates_fps),
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
    if (base.mode === 'byHistory' && !base.pinnedRate) base.pinnedRate = 'fast';
    // Same defensive includes() guard as alt/compare above -- a link from a
    // different site, or from before the master altitude ladder changed,
    // just degrades to the full range instead of an empty map.
    const altMin = Number(URL_PARAMS.get('altmin'));
    if (DATA.altitudes.includes(altMin)) base.altMin = altMin;
    const altMax = Number(URL_PARAMS.get('altmax'));
    if (DATA.altitudes.includes(altMax) && altMax >= base.altMin) base.altMax = altMax;
    // A URL can carry alt/compare and altmin/altmax independently (e.g. an
    // older link built before altmin/altmax existed, then hand-narrowed) --
    // clamp both into the resolved range so byTime/byHistory never end up
    // showing a zone outside the range the selects display as active.
    const inRange = a => a >= base.altMin && a <= base.altMax;
    const nearestInRange = target => {
      const candidates = DATA.altitudes.filter(inRange);
      return candidates.length
        ? candidates.reduce((best, a) => Math.abs(a - target) < Math.abs(best - target) ? a : best)
        : null;
    };
    if (base.pinnedAlt !== null && !inRange(base.pinnedAlt)) base.pinnedAlt = null;
    if (base.compareAlt !== null && !inRange(base.compareAlt)) base.compareAlt = nearestInRange(base.compareAlt);
    // customalt=<ft> -- real value, not restricted to DATA.altitudes/inRange
    // (that's the whole point of it), just bounded to (0, site waiver].
    const customAlt = Number(URL_PARAMS.get('customalt'));
    if (Number.isFinite(customAlt) && customAlt > 0 && customAlt <= DATA.altitudes[DATA.altitudes.length - 1]) {
      base.customAlt = Math.round(customAlt);
    }
    // rates=<fastDrogue>/<fastMain>,<slowDrogue>/<slowMain> -- defensive like
    // every other param here: a malformed component falls back to that
    // preset/part's own default rather than half-applying, and every
    // surviving number gets clamped into rate_limits_fps (a hand-edited URL
    // could carry anything).
    const ratesParam = URL_PARAMS.get('rates');
    if (ratesParam) {
      const limits = DATA.descent_params.rate_limits_fps;
      const clamp = (part, v) => Math.min(limits[part][1], Math.max(limits[part][0], v));
      const [fastStr, slowStr] = ratesParam.split(',');
      const parsed = { fast: fastStr, slow: slowStr };
      for (const name of ['fast', 'slow']) {
        const m = parsed[name] && parsed[name].match(/^(\d+(?:\.\d+)?)\/(\d+(?:\.\d+)?)$/);
        if (m) {
          base.rateFps[name] = { drogue: clamp('drogue', Number(m[1])), main: clamp('main', Number(m[2])) };
        }
      }
    }
  }
  return base;
}

// Same DOM side effects setMode() applies on a real user click, extracted so
// initFromData() can apply them for whatever mode the URL/default resolved
// to on first load too -- without also running setMode()'s pin-clearing
// (which would stomp the pinnedAlt/pinnedRate a permalink just supplied).
function applyModeUI(mode) {
  document.getElementById('hour-toggle-group').classList.toggle('disabled', mode === 'byTime');
  // History reads points_history.json, precomputed server-side at only the
  // discrete ladder's own altitudes -- state.customAlt has nothing to show
  // there (render()'s byHistory branch never reads it). Gated visually
  // rather than clearing the value, so switching to History to check
  // something and back doesn't lose what was typed.
  document.getElementById('alt-custom-control').classList.toggle('disabled', mode === 'byHistory');
  document.getElementById('time-legend-block').style.display = (mode === 'byTime' || mode === 'byHistory') ? '' : 'none';
  document.getElementById('time-legend-title').textContent = mode === 'byHistory' ? 'Forecast age' : 'Time of day';
  document.getElementById('time-color-controls').style.display = mode === 'byHistory' ? 'none' : '';
  document.getElementById('alt-hint').textContent =
    mode === 'byTime' ? 'Click an altitude to compare it across all times of day. Map colors now show time of day, not altitude.'
    : mode === 'byHistory' ? 'Click an altitude to see how each model\'s point for it moved across capture dates.'
    : 'Hover an altitude to isolate its zone. Click to pin it; click again to release. No single color reads well on every site\'s imagery -- pick one above that stands out here; shades for each altitude are generated from it.';
  document.getElementById('time-hint').textContent = mode === 'byHistory'
    ? 'Each row is one capture date -- swatch shade shows how many days before launch it was pulled (lighter = further out, darker = closer to launch). Hover to isolate just that capture (map + accuracy table); click to pin, click again to release.'
    : 'Hover a time to isolate it. Click to pin; click again to release.';
  document.getElementById('model-hint').textContent = mode === 'byHistory'
    ? 'Color and shape both mean model here (same colors as the main map) -- shape is the colorblind-safe backup. Click a model to toggle it on/off; double-click to solo just that one, click again to bring the rest back.'
    : 'Click a model to toggle it on/off, like a checkbox -- all start selected. Double-click to solo just that one (zones collapse to a line when only one model is selected, since a single model\'s fast/slow points fall on the same bearing from the pad).';
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

function setMode(mode) {
  state.mode = mode;
  // fresh start on every mode switch -- a hidden zone-group carrying over from
  // the other mode's isolation state would reference a data-alt/data-hour that
  // doesn't apply here
  state.isolatedAlt = null; state.pinnedAlt = null;
  state.isolatedHour = null; state.pinnedHour = null;
  // null sentinel -- byAltitude/byTime and byHistory read different
  // availability sources (modelsWithData() vs historyModelsAvailable()), so
  // re-resolve to "all available" for whichever mode this is switching to
  // rather than carrying over a selection that might not even exist there.
  state.selectedModels = null;
  state.isolatedCapture = null; state.pinnedCapture = null;
  // Rate resets here too, same as everything else above -- otherwise the
  // rate History auto-pins (below) leaks into byAltitude/byTime afterward,
  // silently filtering them to "fast only" until the user notices and
  // manually clears it.
  state.isolatedRate = null; state.pinnedRate = null;
  // History always shows exactly one rate -- showing both would double the
  // model x capture-date marker count for little benefit. Default to fast
  // the first time this mode is entered, then leave the user's pick alone.
  if (mode === 'byHistory' && !state.pinnedRate) state.pinnedRate = 'fast';
  applyModeUI(mode);
  buildAltList();
  buildAltRange();
  buildTimeLegend();
  buildModelLegend();
  buildRateEditor();
  // note: no render() here -- buildToggle() already calls it after this
  // onChange callback returns, for the mode-toggle click that triggers this.
}

// --- altitude range: coarse min/max filter in front of the per-row list below ---
function altInRange(alt) { return alt >= state.altMin && alt <= state.altMax; }
// Descending -- the row list and the slider beside it both read top-to-bottom
// as high-to-low altitude, matching the real world (sky above, ground below)
// rather than the ascending order DATA.altitudes/config.ALTITUDES_MASTER_FT
// happen to store it in.
function altitudesDescending() { return [...DATA.altitudes].sort((a, b) => b - a); }
function altitudesInRange() { return altitudesDescending().filter(altInRange); }
// Altitudes that actually have a zone for the current hour/deploy -- single
// deploy is dropped above config.SINGLE_DEPLOY_MAX_ALT_FT (10,000ft)
// pipeline-side, so a high-waiver site on Single has real zones for only
// part of DATA.altitudes.
function altitudesWithZones() {
  return new Set(zonesFor(state.hour, state.deploy).map(z => z.altitude));
}

// Row centers, in px from the top of #alt-list's content, for whichever rows
// are currently rendered there. offsetTop/offsetHeight (not
// getBoundingClientRect()) deliberately -- they reflect position within the
// full content box regardless of scroll, so this stays correct even if
// .alt-list ever scrolls internally. Relies on buildAltList() having already
// run for the current dataset/mode (every buildAltRange() call site calls it
// first) so #alt-list's rows exist and are in the same order as
// altitudesDescending().
function altRowCentersPx() {
  return [...document.getElementById('alt-list').children].map(row => row.offsetTop + row.offsetHeight / 2);
}

// Repositions the two thumbs/fill/readout from current state -- cheap, safe
// to call on every altMin/altMax change (drag, keyboard, reset, permalink
// load, real-flight snap). Drag/keyboard interaction itself is wired up once
// in initAltRangeSlider() below, not rebuilt here, so an in-progress drag
// never loses its listeners mid-gesture.
function buildAltRange() {
  const listEl = document.getElementById('alt-list');
  const sliderEl = document.getElementById('alt-range-slider');
  // Matches #alt-list's real content height exactly (not a formula/estimate)
  // so each thumb's % position lines up with its row's actual center, not
  // just a proportional guess -- see altRowCentersPx()'s own comment.
  const listHeight = listEl.scrollHeight;
  sliderEl.style.height = listHeight + 'px';

  const alts = altitudesDescending(); // index 0 = highest (top), last = lowest (bottom)
  const n = alts.length;
  const maxIdx = alts.indexOf(state.altMax);
  const minIdx = alts.indexOf(state.altMin);
  const centers = altRowCentersPx();
  const pct = i => listHeight > 0 ? (centers[i] / listHeight) * 100 : 50;

  const maxThumb = document.getElementById('alt-max-thumb');
  const minThumb = document.getElementById('alt-min-thumb');
  const fill = document.getElementById('alt-range-fill');
  maxThumb.style.top = pct(maxIdx) + '%';
  minThumb.style.top = pct(minIdx) + '%';
  fill.style.top = pct(maxIdx) + '%';
  fill.style.height = (pct(minIdx) - pct(maxIdx)) + '%';

  [[maxThumb, state.altMax], [minThumb, state.altMin]].forEach(([thumb, val]) => {
    thumb.setAttribute('aria-valuemin', alts[n - 1]);
    thumb.setAttribute('aria-valuemax', alts[0]);
    thumb.setAttribute('aria-valuenow', val);
    thumb.setAttribute('aria-valuetext', val.toLocaleString() + ' ft');
  });

  const full = state.altMin === alts[n - 1] && state.altMax === alts[0];
  document.getElementById('alt-range-readout-text').textContent = full
    ? 'All altitudes' : `${state.altMin.toLocaleString()}–${state.altMax.toLocaleString()} ft`;
}

function onAltRangeChanged() {
  if (state.pinnedAlt !== null && !altInRange(state.pinnedAlt)) state.pinnedAlt = null;
  if (state.isolatedAlt !== null && !altInRange(state.isolatedAlt)) state.isolatedAlt = null;
  if (state.compareAlt !== null && !altInRange(state.compareAlt)) {
    const inRange = altitudesInRange();
    state.compareAlt = inRange.length ? inRange.reduce((best, a) =>
      Math.abs(a - state.compareAlt) < Math.abs(best - state.compareAlt) ? a : best) : null;
  }
  buildAltList();
  buildAltRange();
  render();
}

document.getElementById('alt-range-reset').addEventListener('click', () => {
  state.altMin = DATA.altitudes[0];
  state.altMax = DATA.altitudes[DATA.altitudes.length - 1];
  onAltRangeChanged();
});

// --- direct-entry altitude ("Specific altitude") -- overrides the whole
// range/ladder selection above in byAltitude/byTime, see render(). No
// separate checkbox -- clicking into the input *is* the request to use it
// (real user feedback: a checkbox-then-type flow made people click twice
// for one intent). Reflects state.customAlt into the input/status text and
// dims the range row while active; safe to call any time state.customAlt,
// hour, or deploy changes (cheap -- reads zoneFor()'s cache, doesn't
// re-simulate).
const altCustomInput = document.getElementById('alt-custom-input');
const altCustomClear = document.getElementById('alt-custom-clear');

function syncAltCustomUI() {
  const active = state.customAlt !== null;
  if (active) altCustomInput.value = state.customAlt;
  altCustomClear.style.display = active ? '' : 'none';
  document.querySelector('.alt-range-row').classList.toggle('alt-custom-dimmed', active);
  const statusEl = document.getElementById('alt-custom-status');
  if (!active) { statusEl.textContent = ''; return; }
  // zoneFor() itself already handles "no zone" gracefully (returns null --
  // single deploy above SINGLE_DEPLOY_MAX_ALT_FT, or an hour with no
  // published profile at all); this surfaces *why* rather than leaving the
  // map silently blank, which the row-list's .unavailable graying already
  // does for the ladder-based selector but a bare number input can't.
  const zone = zoneFor(state.hour, state.deploy, state.customAlt);
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
  const seed = Number(altCustomInput.value) || state.compareAlt || Math.round(maxAlt / 2);
  state.customAlt = Math.min(maxAlt, Math.max(1, Math.round(seed)));
  // Isolate/pin among the ladder rows stops meaning anything once a single
  // specific-altitude zone is the whole view -- clear rather than leave a
  // dangling selection that resurfaces confusingly if this gets cleared
  // later.
  state.pinnedAlt = null;
  state.isolatedAlt = null;
  syncAltCustomUI();
  render();
}
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

// Drag (pointer events, so mouse/touch/pen share one code path) + keyboard
// wiring for the two thumbs -- attached once at load, not rebuilt per
// dataset (buildAltRange() above only repositions). Always reads
// altitudesDescending()/state fresh rather than closing over a snapshot, so
// it stays correct across site/date switches without needing to be re-armed.
function initAltRangeSlider() {
  const maxThumb = document.getElementById('alt-max-thumb');
  const minThumb = document.getElementById('alt-min-thumb');

  // Nearest row *center* to the pointer, not a linear fraction of the
  // slider's own height -- the two aren't the same thing (a naive
  // index/(n-1) fraction puts index 0 at the slider's top edge, not the
  // first row's center, which is exactly the misalignment this was built to
  // fix). Measures the live rows directly rather than re-deriving their
  // positions, so it's automatically correct for whatever's currently
  // rendered.
  function indexFromClientY(clientY) {
    const rows = [...document.getElementById('alt-list').children];
    const listRect = document.getElementById('alt-list').getBoundingClientRect();
    let bestIdx = 0, bestDist = Infinity;
    rows.forEach((row, i) => {
      const center = listRect.top + row.offsetTop + row.offsetHeight / 2;
      const dist = Math.abs(clientY - center);
      if (dist < bestDist) { bestDist = dist; bestIdx = i; }
    });
    return bestIdx;
  }

  // which thumb's index moves to idx, clamped so the two thumbs can never
  // cross (max-thumb's index can't exceed min-thumb's, and vice versa --
  // remember higher index = lower altitude, since the array is descending).
  function commitIndex(which, idx) {
    const alts = altitudesDescending();
    const n = alts.length;
    const maxIdx = alts.indexOf(state.altMax);
    const minIdx = alts.indexOf(state.altMin);
    if (which === 'max') {
      idx = Math.max(0, Math.min(idx, minIdx));
      if (idx === maxIdx) return;
      state.altMax = alts[idx];
    } else {
      idx = Math.min(n - 1, Math.max(idx, maxIdx));
      if (idx === minIdx) return;
      state.altMin = alts[idx];
    }
    onAltRangeChanged();
  }

  function startDrag(which, thumbEl) {
    return evt => {
      evt.preventDefault();
      thumbEl.setPointerCapture(evt.pointerId);
      const move = e => commitIndex(which, indexFromClientY(e.clientY));
      const stop = () => {
        document.removeEventListener('pointermove', move);
        document.removeEventListener('pointerup', stop);
      };
      document.addEventListener('pointermove', move);
      document.addEventListener('pointerup', stop);
      commitIndex(which, indexFromClientY(evt.clientY));
    };
  }
  maxThumb.addEventListener('pointerdown', startDrag('max', maxThumb));
  minThumb.addEventListener('pointerdown', startDrag('min', minThumb));

  function keyStep(which) {
    return evt => {
      const alts = altitudesDescending();
      const maxIdx = alts.indexOf(state.altMax);
      const minIdx = alts.indexOf(state.altMin);
      const cur = which === 'max' ? maxIdx : minIdx;
      if (evt.key === 'Home') { commitIndex(which, which === 'max' ? 0 : maxIdx); evt.preventDefault(); return; }
      if (evt.key === 'End') { commitIndex(which, which === 'max' ? minIdx : alts.length - 1); evt.preventDefault(); return; }
      const delta = { ArrowUp: -1, ArrowLeft: -1, ArrowDown: 1, ArrowRight: 1, PageUp: -3, PageDown: 3 }[evt.key];
      if (delta === undefined) return;
      evt.preventDefault();
      commitIndex(which, cur + delta);
    };
  }
  maxThumb.addEventListener('keydown', keyStep('max'));
  minThumb.addEventListener('keydown', keyStep('min'));
}
initAltRangeSlider();

// --- altitude list: hover-isolate in "by altitude" mode, single-select in "by time" mode ---
// Always renders every altitude in the site's full ladder (descending), never
// just the in-range subset -- the slider beside it positions its stops
// against the full list too (see altRangeSliderHeightPx()), and removing
// rows as the range narrows made the list reflow/shift, breaking that visual
// alignment. Out-of-range rows get the same dimmed/non-interactive treatment
// as a real no-zone row (.unavailable) instead of disappearing.
function buildAltList() {
  const el = document.getElementById('alt-list');
  el.innerHTML = '';
  const withZones = altitudesWithZones();
  altitudesDescending().forEach(alt => {
    const row = document.createElement('div');
    const available = withZones.has(alt) && altInRange(alt);
    row.className = 'alt-row' + (available ? '' : ' unavailable');
    row.innerHTML = `<div class="alt-swatch" style="background:${ALT_COLORS_HEX[alt]}"></div><span>${alt.toLocaleString()} ft</span>`;
    if (!available) { el.appendChild(row); return; }

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
        // Toggle, same as byAltitude's pinnedAlt above -- clicking the
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
  const key = `${state.hour}_${state.deploy}_${state.pinnedRate}_${state.compareAlt}`;
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
    // History mode swatch shows shape (its markers' distinguishing feature
    // there, for colorblind-safe redundancy) filled with the same color as
    // everywhere else -- see MODEL_SHAPES's comment.
    const swatch = isHistory
      ? shapeSwatchSVG(MODEL_SHAPES[m], hasData ? MODEL_COLORS_HEX[m] : 'var(--text-muted)')
      : `<div class="alt-swatch" style="background:${hasData ? MODEL_COLORS_HEX[m] : 'var(--text-muted)'}"></div>`;
    row.innerHTML = `${swatch}<span>${label}${hasData ? '' : ' (no data)'}</span>`;
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
          buildModelLegend();
          render();
        }, 250);
      });
      row.addEventListener('dblclick', () => {
        if (clickTimer) { clearTimeout(clickTimer); clickTimer = null; }
        state.selectedModels = new Set([m]);
        buildModelLegend();
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
  buildModelLegend();
  render();
});

// Fast/slow keys shared with the rate editor below -- shape drives both
// RATE_SHAPE (marker shape on the map) and the editor's row swatches.
const RATE_LEGEND_ITEMS = [
  { key: 'fast', label: 'Fast', shape: 'circle' },
  { key: 'slow', label: 'Slow', shape: 'square' },
];

// Editable drogue/main fps per Fast/Slow preset -- see state.rateFps's own
// declaration in freshState() for why this lives in `state` rather than as
// a standing "what-if" global like boostAngleDeg. Always both deploy modes'
// worth of numbers (drogue + main) regardless of the current deploy toggle
// -- single deploy only ever uses `main` (see zoneFor()), but the editor
// edits the shared preset definitions, not a deploy-specific view of them.
function buildRateEditor() {
  const el = document.getElementById('rate-edit');
  el.innerHTML = '';
  showRateWarning(false); // stale otherwise -- #rate-warning lives outside #rate-edit, so a full rebuild wouldn't otherwise touch it
  const limits = DATA.descent_params.rate_limits_fps;

  // Unit lives once in the section title ("Rate (fps)") now, not repeated
  // per column.
  const head = (text) => { const d = document.createElement('div'); d.className = 'rate-edit-head'; d.textContent = text; el.appendChild(d); };
  head(''); head('Drogue'); head('Main');

  RATE_LEGEND_ITEMS.forEach(({ key, label, shape }) => {
    const swatchStyle = shape === 'circle' ? 'border-radius:50%;' : 'border-radius:3px;';
    const labelEl = document.createElement('div');
    labelEl.className = 'rate-edit-label';
    labelEl.innerHTML = `<div style="width:12px;height:12px;${swatchStyle}background:var(--text-secondary);flex-shrink:0;"></div><span>${label}</span>`;
    // Hover-isolate/click-pin, same behavior the standalone #rate-legend
    // used to provide before it was folded into this grid (2026-08-05) --
    // Fast/Slow no longer needs to appear twice in the sidebar (once as a
    // pure legend, once as this editor's row labels).
    labelEl.addEventListener('mouseenter', () => { state.isolatedRate = key; render(); });
    labelEl.addEventListener('mouseleave', () => { state.isolatedRate = null; render(); });
    labelEl.addEventListener('click', () => {
      // Toggle, same as the altitude list -- clicking the already-selected
      // rate again clears it rather than being stuck permanently selected.
      // History defaults to 'fast' the first time that mode is entered (see
      // setMode()) so it doesn't start out showing nothing, but from there
      // behaves the same as byAltitude/byTime.
      state.pinnedRate = (state.pinnedRate === key) ? null : key;
      el.querySelectorAll('.rate-edit-label').forEach(r => r.classList.remove('pinned'));
      if (state.pinnedRate === key) labelEl.classList.add('pinned');
      render();
    });
    if (state.pinnedRate === key) labelEl.classList.add('pinned');
    el.appendChild(labelEl);

    ['drogue', 'main'].forEach(part => {
      const input = document.createElement('input');
      input.type = 'number';
      input.min = limits[part][0];
      input.max = limits[part][1];
      input.step = 1;
      input.value = state.rateFps[key][part];
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
        if (!Number.isFinite(v)) v = state.rateFps[key][part];
        // Flagged separately from the generic clamp below -- Tripoli USC
        // §11-1's 35 fps max landing speed (limits.main[1]) is a real
        // safety-code number, not just an input sanity bound like drogue's,
        // so exceeding it gets an explicit on-screen reason instead of
        // silently reverting to a smaller number.
        showRateWarning(part === 'main' && v > limits.main[1]);
        v = Math.min(limits[part][1], Math.max(limits[part][0], v));
        input.value = v;
        state.rateFps[key][part] = v;
        invalidateZones();
        // updateRateHint() only, NOT buildRateEditor() -- a full rebuild
        // destroys and recreates every <input> in this grid, including
        // whichever one the browser was about to move focus to on Tab.
        // The destroyed element is a stale reference by the time the
        // browser tries to focus it, so Tab silently drops focus instead
        // of advancing. Real user report, not theoretical.
        updateRateHint();
        render();
      });
      el.appendChild(input);
    });
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
  const f = state.rateFps.fast, s = state.rateFps.slow;
  document.getElementById('rate-hint').textContent =
    `Fast = ${f.drogue}/${f.main} fps (drogue/main), Slow = ${s.drogue}/${s.main} fps -- editable above (ground-level rates; the sim scales each faster for the thinner air higher up, so the actual drogue rate near a 30,000-50,000ft apogee can be 1.5-2.5x the ground number). Reset with the button above the legend.`
    + (state.mode === 'byHistory' ? ' History starts on fast -- click to switch, click again to clear.' : ' Hover a rate to isolate it; click to pin, click again to release.');
}

document.getElementById('rate-reset').addEventListener('click', () => {
  state.rateFps = structuredClone(DATA.descent_params.default_rates_fps);
  invalidateZones();
  buildRateEditor();
  render();
});

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
// later (DATA.site_lat/site_lon is always read fresh at load time, so the
// offset re-resolves against whatever the CURRENT default is).
const M_PER_DEG_LAT = 111320;
function padFtToLatLon(x_ft, y_ft) {
  const mPerDegLon = M_PER_DEG_LAT * Math.cos(DATA.site_lat * Math.PI / 180);
  const ftToM = 0.3048;
  return {
    lat: DATA.site_lat + (y_ft * ftToM) / M_PER_DEG_LAT,
    lon: DATA.site_lon + (x_ft * ftToM) / mPerDegLon,
  };
}
function padLatLonToFt(lat, lon) {
  const mPerDegLon = M_PER_DEG_LAT * Math.cos(DATA.site_lat * Math.PI / 180);
  const ftToM = 0.3048;
  return {
    x: ((lon - DATA.site_lon) * mPerDegLon) / ftToM,
    y: ((lat - DATA.site_lat) * M_PER_DEG_LAT) / ftToM,
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

  const newX = padOffsetFt.x + dxPx / DATA.ft_to_px_scale.x;
  const newY = padOffsetFt.y - dyPx / DATA.ft_to_px_scale.y; // screen y grows downward, north is +y
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

// Any button living inside #map-wrap (zoom controls, the layer toggle below)
// silently stops responding to clicks without this: wrap's own pointerdown
// handler (setPointerCapture() + drag tracking, above) has no evt.target
// check, so a pointerdown on a child button bubbles up and gets captured by
// wrap before the browser's click synthesis on the button completes. Same
// fix the pad marker uses (stopPropagation() on its own pointerdown) --
// applied here at the container level so every button inside inherits it
// without needing its own listener. Any *new* button added inside #map-wrap
// needs to be covered by this selector or the same bug recurs.
document.querySelectorAll('.zoom-btns, .layer-toggle, .cloud-overlay, .burn-ban-chip, .ban-overlay').forEach(el => {
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
  view = { x: IMG_VB[0], y: IMG_VB[1], w: IMG_VB[2], h: IMG_VB[3] };
  setViewBox();
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

// --- boost-angle slider: recomputes the buffer band client-side (see
// computeBufferHullPx()) rather than reloading data -- boostAngleDeg is the
// only thing that changes, everything it needs (raw points, ft_to_px_scale)
// is already in the currently-loaded DATA. ---
const boostAngleSlider = document.getElementById('boost-angle-slider');
const boostAngleReadout = document.getElementById('boost-angle-readout');
boostAngleSlider.addEventListener('input', () => {
  boostAngleDeg = Number(boostAngleSlider.value);
  boostAngleReadout.textContent = `${boostAngleDeg}°`;
  boostAngleExplicitlyChosen = true; // render() -> applyIsolation() -> syncUrl() picks this up
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
const padHint = document.getElementById('pad-hint');
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
    const active = state.isolatedAlt ?? state.pinnedAlt;
    return active === null || rp.altitude === active;
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
    const whenPart = state.mode === 'byTime' ? ` &middot; ${HOUR_LABELS[rp.hour]}`
      : state.mode === 'byHistory' ? ` &middot; ${leadDaysLabel(rp.capture_date, HISTORY.target_date)} (captured ${rp.capture_date})`
      : '';
    // Rate name alone ("fast") is ambiguous now that the numbers behind it
    // are user-editable -- show the live fps values from state.rateFps
    // rather than a name the viewer's own controls could disagree with.
    const r = state.rateFps ? state.rateFps[rp.rate] : null;
    const rateLabel = r ? (state.deploy === 'single' ? `${rp.rate} (${r.main} fps)` : `${rp.rate} (${r.drogue}/${r.main} fps)`) : rp.rate;
    return `<div class="tt-row"><b>${MODEL_LABELS[rp.model] || rp.model.toUpperCase()}</b> &middot; ${rateLabel}${whenPart}<br>` +
      `apogee ${rp.altitude.toLocaleString()} ft<br>` +
      `offset: ${rp.x_ft >= 0 ? '+' : ''}${rp.x_ft.toFixed(0)} ft E, ${rp.y_ft >= 0 ? '+' : ''}${rp.y_ft.toFixed(0)} ft N<br>` +
      `distance from pad: ${dist.toFixed(0)} ft</div>`;
  }).join('');
  positionTooltip(evt);
}
function hideTooltip() { tooltip.style.display = 'none'; }

// --- cloud panel (see splash_zones.py's build_cloud_data()) -----------------
// Map-corner overlay, waiver-aware: collapsed to just the altitude bands a
// site's own waiver actually reaches (DATA.cloud_relevant_layers), with
// "Show all altitudes" revealing the rest (dimmed) plus the independently-
// computed Total -- Total is never shown by default, at any site (even a
// 50k-waiver one where every band shows), since a whole-sky "wall of
// clouds" number commonly reads scary on a day where the altitudes a site
// can actually fly through are clear, discouraging people from prepping and
// showing up over nothing.
const CLOUD_MODELS = Object.keys(MODEL_COLORS_HEX);
const CLOUD_LAYERS = [
  { key: 'high', label: 'High', sub: '26,200ft+' },
  { key: 'mid', label: 'Mid', sub: '9,800–26,200ft' },
  { key: 'low', label: 'Low', sub: '0–9,800ft' },
];
let cloudPanelCollapsed = false;
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

function addCloudRow(grid, layerKey, label, sub, beyondWaiver) {
  const lab = document.createElement('div');
  lab.className = 'cloud-layer-label' + (beyondWaiver ? ' beyond-waiver' : '');
  lab.innerHTML = `<b>${label}</b>${sub}`;
  grid.appendChild(lab);

  DATA.hours.forEach(h => {
    const cell = document.createElement('div');
    const vals = CLOUD_MODELS.map(m => ({ m, v: DATA.clouds[m][h] ? DATA.clouds[m][h][layerKey] : null }));
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
    const barsBelow = document.createElement('div');
    barsBelow.className = 'bars-below';
    cell.appendChild(barsBelow);
    vals.forEach(({ m, v }) => appendValueBar(bars, barsBelow, m, v, v));

    if (!real.length) {
      const nodata = document.createElement('div');
      nodata.className = 'no-data';
      cell.appendChild(nodata);
    }

    // One listener on the whole cell (not per-bar) so models with identical
    // or near-identical values are all listed together, never hidden behind
    // whichever mark happens to be under the cursor -- same real .tooltip
    // used everywhere else in the viewer.
    cell.addEventListener('mousemove', evt => {
      // Two-column grid (name | %), not one row per model -- a stacked list
      // with a divider between every single model line read as a long,
      // slow-to-scan column of near-identical rows. Right-aligning the %
      // column lets the numbers themselves line up for a quick vertical read.
      // Models at/above the nogo threshold are bolded in place instead of
      // re-listed by name in the footer -- same information, once.
      const rows = vals.map(({ m, v }) => {
        const isHigh = v !== null && v >= DATA.cloud_nogo_pct;
        return `<div class="tt-model-name"><b>${MODEL_LABELS[m] || m.toUpperCase()}</b></div>` +
          `<div class="tt-model-pct${isHigh ? ' pct-high' : ''}">${v === null ? 'no data' : v + '%'}</div>`;
      }).join('');
      // `hot` is the same isCloudHot() flag the cell's own warning badge
      // uses (majority of reporting models >=50%) -- not a separate rule,
      // so the hover state and the at-rest cell always agree.
      const badge = hot ? '<span class="cloud-badge" style="margin-right:5px;">&#9888;</span>' : '';
      tooltip.innerHTML = `<div class="tt-cloud-grid">${rows}</div>` +
        `<div class="tt-cloud-footer" style="color:var(--text-muted);">${badge}${label} · ${HOUR_LABELS[h]}</div>`;
      tooltip.style.display = 'block';
      positionTooltip(evt);
    });
    cell.addEventListener('mouseleave', hideTooltip);

    grid.appendChild(cell);
  });
}

function renderCloudPanel() {
  const container = document.getElementById('cloud-overlay');
  if (!DATA.clouds) { container.style.display = 'none'; return; } // pre-feature captures never regenerated
  container.style.display = '';
  container.innerHTML = '';

  const head = document.createElement('div');
  head.className = 'cloud-head';

  const title = document.createElement('div');
  title.className = 'cloud-title-toggle';
  title.tabIndex = 0;
  title.setAttribute('role', 'button');
  title.setAttribute('aria-expanded', String(!cloudPanelCollapsed));
  title.innerHTML = `Clouds <span class="cloud-chevron${cloudPanelCollapsed ? ' collapsed' : ''}">&#9660;</span>`;
  const toggleCollapsed = () => { cloudPanelCollapsed = !cloudPanelCollapsed; renderCloudPanel(); };
  title.addEventListener('click', toggleCollapsed);
  title.addEventListener('keydown', evt => {
    if (evt.key === 'Enter' || evt.key === ' ') { evt.preventDefault(); toggleCollapsed(); }
  });
  head.appendChild(title);

  const relevantLayers = DATA.cloud_relevant_layers || ['low', 'mid', 'high'];
  if (!cloudPanelCollapsed) {
    const expandBtn = document.createElement('button');
    expandBtn.className = 'cloud-expand-btn';
    expandBtn.type = 'button';
    expandBtn.textContent = cloudAltitudesExpanded ? 'Show waiver altitudes only' : 'Show all altitudes';
    expandBtn.addEventListener('click', () => { cloudAltitudesExpanded = !cloudAltitudesExpanded; renderCloudPanel(); syncUrl(); });
    head.appendChild(expandBtn);
  }
  container.appendChild(head);

  if (cloudPanelCollapsed) return;

  const site = regionalSites?.sites?.[currentSiteId];
  const waiverNote = document.createElement('div');
  waiverNote.className = 'waiver-note';
  const shownLayers = cloudAltitudesExpanded ? CLOUD_LAYERS.map(l => l.key) : relevantLayers;
  const shownLabel = shownLayers.map(k => CLOUD_LAYERS.find(l => l.key === k).label).join(' + ');
  if (site) {
    waiverNote.innerHTML = `<b>${siteLabel(site)}</b> — ${site.waiver_ft.toLocaleString()}ft waiver, showing ${shownLabel}`;
  } else {
    waiverNote.textContent = `Showing ${shownLabel}`;
  }
  container.appendChild(waiverNote);

  const hoursRow = document.createElement('div');
  hoursRow.className = 'cloud-hours';
  const cornerLabel = document.createElement('div');
  cornerLabel.className = 'cloud-corner-label';
  cornerLabel.textContent = '% covered';
  hoursRow.appendChild(cornerLabel);
  DATA.hours.forEach(h => {
    const d = document.createElement('div');
    d.className = 'hr-label';
    d.textContent = HOUR_LABELS[h];
    hoursRow.appendChild(d);
  });
  container.appendChild(hoursRow);

  const grid = document.createElement('div');
  grid.className = 'cloud-grid';
  container.appendChild(grid);

  // Total is independently-computed whole-sky cover, not low+mid+high summed
  // -- placed above High (never mixed in with the altitude bands
  // themselves) so it reads as the big picture, not the headline number.
  if (cloudAltitudesExpanded) {
    addCloudRow(grid, 'total', 'Total', 'all layers', false);
    const totalDivider = document.createElement('div');
    totalDivider.className = 'cloud-layer-divider';
    grid.appendChild(totalDivider);
  }

  const rowsToShow = cloudAltitudesExpanded ? CLOUD_LAYERS : CLOUD_LAYERS.filter(l => relevantLayers.includes(l.key));
  rowsToShow.forEach(l => addCloudRow(grid, l.key, l.label, l.sub, cloudAltitudesExpanded && !relevantLayers.includes(l.key)));

  // No per-model color key here -- the main "Model" legend in the side
  // column already maps every model to this same color (MODEL_COLORS_HEX),
  // so repeating it in every collapsible panel would just be noise.
  const legend = document.createElement('div');
  legend.className = 'cloud-legend';
  const hotKey = document.createElement('div');
  hotKey.className = 'hot-key';
  hotKey.innerHTML = `<span class="cloud-badge">&#9888;</span> majority ≥${DATA.cloud_nogo_pct}% covered`;
  legend.appendChild(hotKey);
  container.appendChild(legend);
}

// --- rain timeline (above the map; see splash_zones.py's build_rain_data())
// One row: "Prior day" + "Morning" aggregate cells, then one cell per hour
// 8am-4pm (config.RAIN_WINDOW_START/END_HOUR_LOCAL on the pipeline side) --
// reuses the cloud panel's per-model-bar-per-cell pattern (same real-zero-
// vs-no-data distinction, same one-tooltip-per-cell), not a line graph:
// precip is bursty/discontinuous hour to hour (checked against real data --
// models routinely disagree on which hour carries a spike, not just how
// much), so connecting points with a line would imply a gradual ramp that
// isn't real and wouldn't read as more than 8 overlapping near-zero lines.
function hourAmPm(h) {
  const period = h < 12 ? 'am' : 'pm';
  return `${h % 12 || 12}${period}`;
}
// Any amount at/above this fills the bar -- real per-hour rain at a launch
// site rarely approaches this; a launch is a clear no-go well before the bar
// would need to go higher, so there's no value in a taller scale that just
// leaves everything looking small on an ordinary rainy hour.
const RAIN_BAR_MAX_IN = 0.3;
// Same hours as SPLASH_HOURS_LOCAL/DATA.hours -- marked in the timeline so
// they read as the same "9/11/1/3" the rest of the viewer already uses, not
// a separate unrelated set of times.
const RAIN_MARKED_HOURS = new Set([9, 11, 13, 15]);
// Floor for chance-scaled bar opacity (see appendValueBar()'s opacity
// param) -- a bar fades toward this as probability drops, but never past
// it, so even a 9%-chance reading stays visibly present as real data.
const RAIN_MIN_OPACITY = 0.4;

function addRainCell(row, label, sub, cellData, marked) {
  // `sub` (the exact window, e.g. "12am-8am") only appears in the tooltip
  // footer below, not stacked under the visible label -- the cell's own
  // range-num floats up into that same space (cloud grid's -14px trick,
  // which only avoids collision there because labels and cells sit in
  // separate columns; here every slot's label sits directly above its own
  // cell), so a second label line would overlap it. Hover for the exact
  // window instead, same "spell it out in the help, not the label" call
  // already made for the hourly buckets.
  const lab = document.createElement('div');
  lab.className = 'rain-cell-label' + (marked ? ' marked' : '');
  lab.innerHTML = `<b>${label}</b>`;
  row.appendChild(lab);

  const cell = document.createElement('div');
  cell.className = 'cloud-cell rain-cell' + (marked ? ' marked' : '');

  const baseline = document.createElement('div');
  baseline.className = 'baseline';
  cell.appendChild(baseline);

  const vals = CLOUD_MODELS.map(m => ({ m, ...(cellData[m] || { amount: null, chance: null }) }));
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
      `<div class="tt-model-name"><b>${MODEL_LABELS[m] || m.toUpperCase()}</b></div>` +
      `<div class="tt-model-pct">${chance === null ? 'n/a' : chance + '%'}</div>` +
      `<div class="tt-model-pct">${amount === null ? 'no data' : amount.toFixed(2) + ' in'}</div>`
    ).join('');
    tooltip.innerHTML =
      `<div class="tt-rain-grid"><div class="tt-rain-head">Model</div><div class="tt-rain-head">Chance</div><div class="tt-rain-head">Amount</div>${rows}</div>` +
      `<div class="tt-cloud-footer" style="color:var(--text-muted);">${label}${sub ? ' ' + sub : ''} rain forecast</div>`;
    tooltip.style.display = 'block';
    positionTooltip(evt);
  });
  cell.addEventListener('mouseleave', hideTooltip);

  row.appendChild(cell);
}

function renderRainTimeline() {
  const container = document.getElementById('rain-timeline');
  if (!DATA.rain) { container.style.display = 'none'; return; } // pre-feature captures never regenerated
  container.style.display = '';
  container.innerHTML = '';

  const title = document.createElement('div');
  title.className = 'rain-timeline-title';
  title.textContent = '🌧️ Rain forecast';
  container.appendChild(title);

  const row = document.createElement('div');
  row.className = 'rain-grid';
  container.appendChild(row);

  const hourKeys = Object.keys(DATA.rain.hourly).map(Number).sort((a, b) => a - b);
  // First hourly key is the timeline's own start (config.RAIN_WINDOW_START_
  // HOUR_LOCAL on the pipeline side) -- read from the data rather than
  // hardcoded here too, so the two can't drift out of sync.
  addRainCell(row, 'Prior day', '', DATA.rain.prior_day, false);
  addRainCell(row, 'Morning', `12am–${hourAmPm(hourKeys[0])}`, DATA.rain.morning, false);

  hourKeys.forEach(h => {
    addRainCell(row, hourAmPm(h), '', DATA.rain.hourly[h], RAIN_MARKED_HOURS.has(h));
  });
}

// --- temperature timeline (below the rain one; see splash_zones.py's
// build_temperature_data()) -- same 11-slot row shell as rain (shared
// .rain-grid/.temp-grid CSS), but two real differences: no fixed bar scale
// (temperature swings dramatically by season/site -- a Texas August capture
// and a South Dakota April one have nothing in common -- so a fixed range
// like RAIN_BAR_MAX_IN would either flatten one into a sliver or clip the
// other), and no "confirmed zero" state to special-case (unlike rain amount
// or cloud %, a temperature reading has no natural zero point, so there's
// nothing for appendValueBar()'s null/zero/real split to do here -- just
// null-or-real).
//
// Scale is computed fresh from this capture's own data (every real value
// across the whole row, padded and rounded to a clean 5-degree span) and
// shown as an axis -- sticky-positioned so it stays in view while the row
// scrolls horizontally on mobile, otherwise the one reference for "how tall
// is tall" would scroll away exactly when comparing a far-right hour.
//
// Each cell carries both "actual" (raw temperature_2m) and "apparent"
// (Open-Meteo's own combined wind+humidity+temperature "feels like" figure
// -- covers both heat-index-when-hot and wind-chill-when-cold in one
// number, not two separate fields) -- a toggle switches which one the bars
// show, default apparent since "does this feel dangerous" is closer to
// what a launch director actually needs than raw air temperature alone.
let tempShowApparent = URL_PARAMS.get('temp') !== 'actual';

function addTempAxis(row, minV, maxV) {
  const lab = document.createElement('div');
  lab.className = 'temp-cell-label';
  lab.innerHTML = '<b>°F</b>';
  row.appendChild(lab);

  const cell = document.createElement('div');
  cell.className = 'temp-cell temp-axis';
  const maxLabel = document.createElement('div');
  maxLabel.className = 'temp-axis-max';
  maxLabel.textContent = Math.round(maxV);
  cell.appendChild(maxLabel);
  const minLabel = document.createElement('div');
  minLabel.className = 'temp-axis-min';
  minLabel.textContent = Math.round(minV);
  cell.appendChild(minLabel);
  row.appendChild(cell);
}

function addTempCell(row, label, cellData, marked, scaleMin, scaleMax) {
  const lab = document.createElement('div');
  lab.className = 'temp-cell-label' + (marked ? ' marked' : '');
  lab.innerHTML = `<b>${label}</b>`;
  row.appendChild(lab);

  const cell = document.createElement('div');
  cell.className = 'cloud-cell temp-cell' + (marked ? ' marked' : '');

  const baseline = document.createElement('div');
  baseline.className = 'baseline';
  cell.appendChild(baseline);

  const field = tempShowApparent ? 'apparent' : 'actual';
  const vals = CLOUD_MODELS.map(m => ({ m, v: cellData[m]?.[field] ?? null }));
  const real = vals.filter(x => x.v !== null);

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
      `<div class="tt-model-name"><b>${MODEL_LABELS[m] || m.toUpperCase()}</b></div>` +
      `<div class="tt-model-pct">${v === null ? 'no data' : Math.round(v) + '°F'}</div>`
    ).join('');
    const modeLabel = tempShowApparent ? 'feels like' : 'actual';
    tooltip.innerHTML = `<div class="tt-cloud-grid">${rows}</div>` +
      `<div class="tt-cloud-footer" style="color:var(--text-muted);">${label} temperature forecast (${modeLabel})</div>`;
    tooltip.style.display = 'block';
    positionTooltip(evt);
  });
  cell.addEventListener('mouseleave', hideTooltip);

  row.appendChild(cell);
}

function renderTempTimeline() {
  const container = document.getElementById('temp-timeline');
  if (!DATA.temperature) { container.style.display = 'none'; return; } // pre-feature captures never regenerated
  container.style.display = '';
  container.innerHTML = '';

  const head = document.createElement('div');
  head.className = 'temp-head';
  const title = document.createElement('div');
  title.className = 'temp-timeline-title';
  title.textContent = '🌡️ Temperature forecast';
  head.appendChild(title);
  // Radio-style pair (same .toggle-btns visual language as TIME/View/
  // Deploy in the controls bar, scaled down for this header) -- both
  // options always labeled and visible, active one highlighted, so the
  // current state is read directly rather than decoded from what the
  // OTHER option's link text says (the single link-button this replaced
  // only ever showed the mode you'd switch TO).
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
      renderTempTimeline();
      syncUrl();
    });
    modeToggle.appendChild(btn);
  });
  head.appendChild(modeToggle);
  container.appendChild(head);

  const row = document.createElement('div');
  row.className = 'temp-grid';
  container.appendChild(row);

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

  addTempAxis(row, scaleMin, scaleMax);
  addTempCell(row, 'Prior day', DATA.temperature.prior_day, false, scaleMin, scaleMax);
  addTempCell(row, 'Morning', DATA.temperature.morning, false, scaleMin, scaleMax);

  const hourKeys = Object.keys(DATA.temperature.hourly).map(Number).sort((a, b) => a - b);
  hourKeys.forEach(h => {
    addTempCell(row, hourAmPm(h), DATA.temperature.hourly[h], RAIN_MARKED_HOURS.has(h), scaleMin, scaleMax);
  });
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

// Zone cache: `${hour}_${deploy}_${altitude}` -> {altitude, points}. Cleared
// on dataset load and on a rate edit -- and on nothing else, deliberately:
// x_ft/y_ft don't depend on padOffsetFt (applied later, in ftToPx()) or on
// boostAngleDeg (applied later, in computeBufferHullPx()), so dragging the
// pad or moving the boost slider stays a pure redraw with zero re-simulation.
// Also why several legend hover handlers (model/rate/hour) calling render()
// on mouseenter/mouseleave don't re-simulate the whole grid on every mouse
// movement -- a full grid computes once per (dataset, rate-setting), every
// subsequent hover/pin/drag is a cache hit.
let zoneCache = new Map();
function invalidateZones() { zoneCache.clear(); }

// One altitude's zone at the given hour/deploy, computed just-in-time from
// DATA.wind_profiles at the current state.rateFps -- returns the same
// {altitude, points: [{model, rate, x_ft, y_ft}]} shape drawZone() already
// consumes (it was already reading only these two fields; see drawZone()'s
// own comment). null above single_deploy_max_alt_ft for single deploy
// (mirrors compute_splash_points()'s own skip) or if the hour has no
// published profiles at all.
function zoneFor(hour, deploy, altitudeFt) {
  const cacheKey = `${hour}_${deploy}_${altitudeFt}`;
  if (zoneCache.has(cacheKey)) return zoneCache.get(cacheKey);

  const dp = DATA.descent_params;
  const profiles = DATA.wind_profiles[hour];
  let zone = null;
  if (profiles && !(deploy === 'single' && altitudeFt > dp.single_deploy_max_alt_ft)) {
    const points = [];
    for (const [model, profile] of Object.entries(profiles)) {
      for (const rateName of ['fast', 'slow']) {
        const r = state.rateFps[rateName];
        // Mirrors compute_splash_points()'s own phase construction exactly:
        // dual is a drogue phase down to main-deploy altitude then a main
        // phase to the ground; single is one main-rate phase the whole way.
        const phases = deploy === 'dual'
          ? [[r.drogue, altitudeFt, dp.main_deploy_altitude_ft], [r.main, dp.main_deploy_altitude_ft, 0]]
          : [[r.main, altitudeFt, 0]];
        const [x_ft, y_ft] = simulateDrift(profile, altitudeFt, phases, dp.site_elev_ft, dp.descent_step_ft);
        points.push({ model, rate: rateName, x_ft, y_ft });
      }
    }
    zone = { altitude: altitudeFt, points };
  }
  zoneCache.set(cacheKey, zone);
  return zone;
}

function zonesFor(hour, deploy) {
  return DATA.altitudes.map(alt => zoneFor(hour, deploy, alt)).filter(z => z !== null);
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
// load like boostAngleDeg -- this is a physical fact about whichever site
// is currently selected, not a standing user preference that should
// survive a site switch unchanged.
let MAX_PAD_MOVE_FT = 2000;
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

// Same conversion, without padOffsetFt -- for points that are real/absolute
// GPS measurements (a real flight's launch rail, apogee, and landing; see
// drawRealFlightMarker()), not positions relative to wherever the pad
// marker currently is. Dragging the pad marker is a "what if the pad were
// here" hypothetical for the *model* points and splash zone, which really
// are defined relative to the assumed pad position -- a real GPS fix has
// its own fixed lat/lon and must not move just because the pad marker did.
function ftToPxAbsolute(x_ft, y_ft) {
  return [
    DATA.site_px[0] + x_ft * DATA.ft_to_px_scale.x,
    DATA.site_px[1] - y_ft * DATA.ft_to_px_scale.y,
  ];
}

// Caller passes whichever points should currently count -- drawZone() passes
// the rate-filtered set so isolating Fast/Slow actually shrinks the buffer,
// not the unfiltered zone.points (a static both-rates outline around
// filtered-down dots reads as broken, not as "the buffer means something
// different").
function computeBufferHullPx(zonePoints, boostAngleDeg, altitudeFt) {
  const radiusFt = altitudeFt * Math.tan(boostAngleDeg * Math.PI / 180);
  const ptsFt = zonePoints.map(p => [p.x_ft, p.y_ft]);
  const hullFt = convexHull(bufferedPointsFt(ptsFt, radiusFt));
  return hullFt.map(([x, y]) => ftToPx(x, y));
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
  if (shape === 'target') {
    return `<svg width="16" height="16" viewBox="0 0 16 16" style="flex-shrink:0;">
      <circle cx="${cx}" cy="${cy}" r="${size}" fill="none" stroke="${color}" stroke-width="2" />
      <circle cx="${cx}" cy="${cy}" r="${size * 0.4}" fill="${color}" /></svg>`;
  }
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
        state.hour = flight.closest_hour;
        hourExplicitlyChosen = true;
        // Nearest-match, not exact equality -- the published bucket may not
        // exist verbatim in DATA.altitudes if this date's zone JSON predates
        // a master-ladder change (see config.ALTITUDES_MASTER_FT). Widen the
        // range filter to include it if the current selection excludes it.
        const bucket = flight.delta_from_predictions.altitude_bucket_used_ft;
        state.compareAlt = DATA.altitudes.reduce((best, a) =>
          Math.abs(a - bucket) < Math.abs(best - bucket) ? a : best, DATA.altitudes[0]);
        if (state.compareAlt < state.altMin) state.altMin = state.compareAlt;
        if (state.compareAlt > state.altMax) state.altMax = state.compareAlt;
        // A pinned real flight compares against its own published altitude
        // bucket specifically -- a specific-altitude override active from
        // before would show an unrelated zone instead, so clear it.
        state.customAlt = null;
        syncAltCustomUI();
        buildToggle('hour-toggle', DATA.hours, HOUR_LABELS, 'hour', () => { hourExplicitlyChosen = true; syncAltCustomUI(); });
        buildAltList();
        buildAltRange();
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

  const rate = state.pinnedRate; // always set once byHistory is entered -- see setMode()
  const key = `${state.hour}_${state.deploy}_${rate}_${state.compareAlt}`;
  const seriesByModel = {};
  (HISTORY.points_by_key[key] || []).forEach(pt => {
    (seriesByModel[pt.model] ??= []).push(pt);
  });
  const actual = HISTORY.actuals[key];

  const activeCapture = state.isolatedCapture ?? state.pinnedCapture;

  // Splash polygon for the hovered/pinned forecast age: same buffer+core
  // hull treatment drawZone() uses for the main view, but built from that
  // one capture date's points across the currently-selected models (same
  // composable filtering the accuracy table already does) -- lets the
  // actual star be read against "how big was the projected area that day,"
  // not just its distance to each individual point.
  if (activeCapture) {
    const dayPoints = (HISTORY.points_by_key[key] || []).filter(pt => {
      if (pt.capture_date !== activeCapture) return false;
      if (!state.selectedModels.has(pt.model)) return false;
      return true;
    });
    if (dayPoints.length) {
      const buf = document.createElementNS(ns, 'polygon');
      buf.setAttribute('points', polyPoints(computeBufferHullPx(dayPoints, boostAngleDeg, state.compareAlt)));
      buf.setAttribute('class', 'zone-buffer');
      buf.setAttribute('fill', zoneBaseColor);
      buf.setAttribute('fill-opacity', '0.30');
      svg.appendChild(buf);

      const corePx = convexHull(dayPoints.map(p => [p.x_ft, p.y_ft])).map(([x, y]) => ftToPx(x, y));
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
      const [px, py] = pxPts[i];
      const marker = drawMarker(svg, shape, px, py, 9, MODEL_COLORS_HEX[model] || 'var(--point-fill)');
      marker.classList.add('pt');
      const rp = { model, rate, x_ft: pt.x_ft, y_ft: pt.y_ft, px, py, capture_date: pt.capture_date, altitude: state.compareAlt, hour: state.hour };
      renderedPoints.push(rp);
      marker.addEventListener('mousemove', evt => showTooltip(evt, rp));
      marker.addEventListener('mouseleave', hideTooltip);
    });
  });

  projectionStarEl = null;
  if (actual) {
    const [px, py] = ftToPx(actual.x_ft, actual.y_ft);
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
  const rate = state.pinnedRate;
  const key = `${state.hour}_${state.deploy}_${rate}_${state.compareAlt}`;
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
  const models = Object.keys(seriesByModel).sort();
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
  // hulls/buffer (which already go through ftToPx() too).
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

  const points = zone.points.filter(pt => rateMatches(pt, activeRate()) && state.selectedModels.has(pt.model));

  if (state.selectedModels.size === 1) {
    // Exactly one model selected (via single-click-to-only or double-click
    // solo -- either path lands here the same way): the fast/slow points
    // aren't a meaningful 2D spread any more (they're the *same* wind
    // profile at two rates -- for single deploy they're exactly collinear
    // with the pad, for dual deploy very close to it), so a filled hull
    // would overstate the uncertainty. Draw the pad->near->far bearing as a
    // line instead, colored by the zone (altitude or time, matching the
    // multi-model view), and only plot this model's own points.
    const modelPoints = points;
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
  // (rate-filtered) set: isolating Fast or Slow should shrink the zone to
  // what that rate alone actually covers, not just hide dots inside an
  // unchanged both-rates outline. `zone.points` itself is computed
  // just-in-time by zoneFor() (see its own comment) from the published wind
  // profile at whatever rate the rate editor currently has set -- there's
  // no separate server-baked point set any more to fall back to.
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
// isolatedX (pure hover, cleared on mouseleave) or padOffsetFt/the color
// pickers (personal display preferences already persisted via localStorage,
// not part of a shareable launch scenario). `layer` is the exception among
// the localStorage-backed prefs -- see mapLayer's own comment for why it's
// also shareable. `date`/`hour`/`deploy`/`boost` are further gated behind an
// explicit user action each -- see
// dateExplicitlyChosen/hourExplicitlyChosen/deployExplicitlyChosen/
// boostAngleExplicitlyChosen's declarations for why.
function buildPermalinkParams(includeDate) {
  const p = new URLSearchParams();
  p.set('site', currentSiteId);
  if (includeDate && dateSelect.value) p.set('date', dateSelect.value);
  p.set('mode', state.mode);
  p.set('layer', mapLayer);
  if (hourExplicitlyChosen) p.set('hour', state.hour);
  if (deployExplicitlyChosen) p.set('deploy', state.deploy);
  if (boostAngleExplicitlyChosen) p.set('boost', boostAngleDeg);
  if (state.pinnedRate) p.set('rate', state.pinnedRate);
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
  // field/param name depending which one that view actually uses: byAltitude's
  // pin/isolate selection (pinnedAlt) via `alt`, or the "which altitude to
  // compare across hours" selection byTime and byHistory both use
  // (compareAlt, see buildAltList()) via `compare`.
  if (state.mode === 'byAltitude' && state.pinnedAlt !== null) p.set('alt', state.pinnedAlt);
  if ((state.mode === 'byTime' || state.mode === 'byHistory') && state.compareAlt !== null) p.set('compare', state.compareAlt);
  if (state.mode === 'byHistory' && state.pinnedCapture !== null) p.set('capture', state.pinnedCapture);
  // Altitude range filter (see buildAltRange()) -- emitted only when actually
  // narrowed from this site's full ladder, same "don't pin defaults into the
  // URL" reasoning as hour/deploy/boost above. Real ft values, not list
  // indices, so a link survives the master ladder changing (as it did
  // 2026-08) and resolves sanely against a different site's shorter list.
  if (state.altMin !== DATA.altitudes[0]) p.set('altmin', state.altMin);
  if (state.altMax !== DATA.altitudes[DATA.altitudes.length - 1]) p.set('altmax', state.altMax);
  // Direct-entry altitude (see syncAltCustomUI()) -- a real ft value, always
  // worth sharing when set (there's no "default" for it to differ from,
  // unlike altmin/altmax's ladder-derived defaults).
  if (state.customAlt !== null) p.set('customalt', state.customAlt);
  // Editable rates (see buildRateEditor()) -- emitted only when they differ
  // from this dataset's own defaults, same convention as altmin/altmax
  // above. fast-then-slow, drogue-then-main.
  const dr = DATA.descent_params.default_rates_fps;
  const r = state.rateFps;
  if (r.fast.drogue !== dr.fast.drogue || r.fast.main !== dr.fast.main || r.slow.drogue !== dr.slow.drogue || r.slow.main !== dr.slow.main) {
    p.set('rates', `${r.fast.drogue}/${r.fast.main},${r.slow.drogue}/${r.slow.main}`);
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
// currently-drawn zones' buffer hulls actually reach, reassigned as a new
// array each time (not mutated in place) so a fresh DATA.base_view_box on
// the next dataset load starts clean. `zones` is whatever render() is about
// to draw -- computing their buffer-hull px extent here duplicates a little
// of drawZone()'s own work, but it's cheap (see simulateDrift()'s own
// comment on performance headroom) and lets the background rect be sized
// correctly *before* it's drawn, not after.
function growBaseViewBox(zones) {
  const allX = [], allY = [];
  zones.forEach(zone => {
    const points = zone.points.filter(pt => rateMatches(pt, activeRate()));
    computeBufferHullPx(points, boostAngleDeg, zone.altitude).forEach(([x, y]) => { allX.push(x); allY.push(y); });
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
  // ladder/range selection in both live-computed modes -- byHistory can't
  // use it at all (points_history.json only has data at the discrete
  // ladder's own altitudes, precomputed server-side; see syncAltCustomUI()'s
  // comment) so that branch is untouched below.
  let altitudeZones = [], timeZones = [];
  if (state.mode === 'byAltitude') {
    altitudeZones = state.customAlt !== null
      ? [zoneFor(state.hour, state.deploy, state.customAlt)].filter(Boolean)
      : zonesFor(state.hour, state.deploy).filter(z => altInRange(z.altitude));
    growBaseViewBox(altitudeZones);
  } else if (state.mode === 'byTime') {
    const orderedHours = [...DATA.hours].sort((a, b) => b - a);
    const alt = state.customAlt !== null ? state.customAlt : state.compareAlt;
    timeZones = orderedHours.map(hour => ({ hour, zone: zoneFor(hour, state.deploy, alt) })).filter(hz => hz.zone);
    growBaseViewBox(timeZones.map(hz => hz.zone));
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
    // one time of day, every in-range altitude, colored by altitude.
    // ALT_COLORS_HEX is a ramp built from DATA.altitudes (initFromData()) --
    // a custom altitude won't be a key in it, so falls back to the user's
    // own chosen base zone color directly rather than an undefined fill.
    const ordered = [...altitudeZones].sort((a, b) => b.altitude - a.altitude);
    ordered.forEach(zone => drawZone(zone, ALT_COLORS_HEX[zone.altitude] || zoneBaseColor, state.hour));
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
  if (boostAngleDeg === null) {
    // first load only -- see its declaration. URL wins over the dataset's
    // own default when the link was explicitly built with one (see
    // boostAngleExplicitlyChosen), clamped to the slider's own range since
    // a hand-edited URL could carry anything.
    const urlBoost = Number(URL_PARAMS.get('boost'));
    boostAngleDeg = (boostAngleExplicitlyChosen && !Number.isNaN(urlBoost))
      ? Math.min(Number(boostAngleSlider.max), Math.max(Number(boostAngleSlider.min), urlBoost))
      : DATA.boost_angle_deg;
  }
  boostAngleSlider.value = boostAngleDeg;
  boostAngleReadout.textContent = `${boostAngleDeg}°`;
  // Every load, not just first -- see MAX_PAD_MOVE_FT's own declaration.
  MAX_PAD_MOVE_FT = DATA.max_pad_move_ft ?? 2000;
  padHint.textContent = `Drag the crosshair on the map to try a nearby setup spot (capped at ${MAX_PAD_MOVE_FT.toLocaleString()} ft from the surveyed point -- everything shifts with it).`;
  if (!padUrlApplied) {
    padUrlApplied = true;
    const urlPad = URL_PARAMS.get('pad');
    if (urlPad && DATA.site_lat !== undefined) {
      const [latStr, lonStr] = urlPad.split(',');
      const lat = Number(latStr), lon = Number(lonStr);
      if (!Number.isNaN(lat) && !Number.isNaN(lon)) {
        const { x, y } = padLatLonToFt(lat, lon);
        setPadOffsetClamped(x, y); // same cap manual dragging respects -- a hand-edited URL could carry anything
      }
    }
  }

  buildToggle('mode-toggle', ['byAltitude', 'byTime', 'byHistory'], MODE_LABELS, 'mode', () => setMode(state.mode));
  buildToggle('hour-toggle', DATA.hours, HOUR_LABELS, 'hour', () => { hourExplicitlyChosen = true; syncAltCustomUI(); });
  buildToggle('deploy-toggle', DATA.deploys, DEPLOY_LABELS, 'deploy', () => {
    deployExplicitlyChosen = true;
    // Which altitudes have a real zone changes with deploy (single-deploy
    // drops above SINGLE_DEPLOY_MAX_ALT_FT pipeline-side) -- refresh both the
    // row list's unavailable rows and the slider's thumb positions.
    buildAltList();
    buildAltRange();
    // Single deploy's phase construction (zoneFor()) never reads the drogue
    // rate at all -- disable those inputs rather than leave them editable
    // and silently ignored.
    buildRateEditor();
    syncAltCustomUI(); // single/dual changes whether the custom altitude has a zone at all
  });
  buildTimeLegend();
  buildAltList();
  buildAltRange();
  buildModelLegend();
  buildRateEditor();
  syncAltCustomUI(); // reflects a URL-loaded ?customalt= on first render
  banDismissed = false; // a dismiss on a previous site/date shouldn't suppress a genuinely new ban
  renderCloudPanel();
  renderRainTimeline();
  renderTempTimeline();
  renderBanStatus();
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
  const resp = await fetch(withVersion(entry.data_path));
  DATA = await resp.json();
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
  HISTORY = entry.history_path ? await (await fetch(withVersion(entry.history_path))).json() : null;
  // Empty for the overwhelming majority of targets -- a real GPS-tracked
  // flight is a rare, manually-fed-in thing (see analyze_real_flight.py),
  // not something every launch has. Usually 0 or 1 paths, occasionally more
  // than one (a site can fly more than one rocket the same day).
  REAL_FLIGHTS = entry.real_flight_paths?.length
    ? await Promise.all(entry.real_flight_paths.map(p => fetch(withVersion(p)).then(r => r.json())))
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

function loadSiteManifest(manifestPath) {
  fetch(withVersion(manifestPath))
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

fetch(withVersion('maps/regional/sites.json'))
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
