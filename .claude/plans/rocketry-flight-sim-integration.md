Status: in-progress
Priority: high
Type: new-feature
Last updated: 2026-08-24

# Rocketry flight-sim integration (embedded, cross-origin — no code sharing)

## Tasks

- [x] Task 1 — "Simulate ascent path" button + modal markup (`index.html`)
- [x] Task 2 — `ROCKETRY_EMBED_BASE` config + iframe `src` builder (`app.js`)
- [x] Task 3 — `postMessage` listener + result wiring (`app.js`)
- [x] Task 4 — Generalize `?testAscent=1` prototype to real `ASCENT_RESULT` (`descent3d.js` + `app.js`) — includes a real fix found while generalizing: the actual `AscentResult` has no `summary.apogeeAltitudeFt` convenience field (that only existed in the old hand-built test fixture), so apogee altitude is now derived from the APOGEE waypoint's own `altitude` field directly.
- [x] CSS: modal, button, `.rail-angle-control.sim-active` (renamed from `.test-ascent-disabled`)
- [x] Static verification: JS brace/paren balance (no Node runtime available), no duplicate/dangling DOM ids, served content confirmed live via local dev server, CHANGELOG entry added
- [x] Rocketry-side "embed mode" — **shipped, contract evolved**: rocketry actually returns one ascent per forecast model (`results: [{model, ascentPath}]`, `type: "rocketry:ascentResults"`), not the single `ascentPath`/`rocketry:ascentResult` originally specified below. Confirmed against a real sample payload rocketry provided (`/home/ezrac/github/rocketry/sim-files/hutto-0815-loc-iv-k400-ascent-results.json`). See "Update 2026-08-16" callout after the original contract section for the actual shape and the splashcast-side consumer changes this required — kept as an addendum rather than rewriting the original spec, since that's still an accurate record of what was asked for.
- [x] Task 6 — Per-model ascent-path consumer rewrite (`descent3d.js` + `app.js`), tying each model's ascent curve to its own descent path so they toggle together via `state.selectedModels` — requested directly, see the Update callout.
- [ ] Full interactive round-trip verification (real rocket/motor pick → live `postMessage` → renders correctly) — blocked until rocketry's own embed page exists
- [ ] `postMessage` origin-rejection test (mismatched origin) — blocked, same reason
- [ ] Delete the local `ascent-path-test.json` fixture once the real path is verified end-to-end
- [x] Task 7 — Display rocket + motor name when a sim result is active (`app.js`, `index.html`, `app.css`), consuming rocketry's new optional `rocketConfig` field — see "Update 2026-08-16 (2)" below
- [x] Task 8 — Real-browser bug fixes + per-model apogee markers, found via live production testing — see "Update 2026-08-16 (3)" below
- [x] Task 9 — Background per-hour prefetch (`app.js`, `descent3d.js`), so the time slider updates apogee without leaving a frozen result — **splashcast-side only, no rocketry change needed** (confirmed directly: "they only digest what we send them") — see "Update 2026-08-16 (4)" below
- [x] Task 10 — `autoSend=1` param on prefetch-only requests, model-selection-aware apogee mean (rounded to nearest 10ft in 3D), and a real click-to-open popup for the Clouds row's warning badge — see "Update 2026-08-16 (5)" below. **`autoSend=1` needs matching rocketry-side support** (contract addition, not yet confirmed shipped) — everything else in this task is splashcast-only.
- [x] Task 11 — 15-minute ascent interpolation between the two bracketing real prefetched hours, dashed/faded when shown — **splashcast-side only, no rocketry change needed** (same reasoning as Task 9) — see "Update 2026-08-16 (6)" below
- [x] Task 12 — Draggable/resizable/full-screen-toggleable ascent-sim modal (`index.html`, `app.css`, `app.js`) — **splashcast-side only, entirely a wrapper around the existing iframe, no rocketry change needed** — see "Update 2026-08-16 (7)" below
- [x] Task 13 — Real per-rocket descent rates (`descentDevices`) now adjust `state.rateFps`/`state.deploy`, actually affecting the landing zone — see "Update 2026-08-17 (1)" below
- [x] Task 14 — Fixed real-flight landing-point popups showing blank/nothing once `ASCENT_RESULTS` is active — see "Update 2026-08-24 (1)" below

## Context

Splashcast currently approximates boost-phase weathercocking with a manual,
user-draggable rail-angle dial (`railAngleDeg`/`railHeadingDeg`,
`site/assets/js/app.js`) — a pure `tan(angle) * altitude` cone shift, no
real physics. A sibling project, `/home/ezrac/github/rocketry` (a browser-
based RK4 3D rocket flight simulator, GPLv3, `../rocketry/` from
splashcast), was independently built with this exact handoff as a design
goal — it already has a real rocket library, live ThrustCurve.org motor
search, a `parseSplashcastWindData()` parser matching splashcast's exact
published JSON shape, and an `AscentPath` output (named waypoints +
resampled trajectory) matching the shape this session's earlier local
prototype (`?testAscent=1`, never committed) already validated as a
consumer.

**The first plan for this (superseded below) vendored rocketry's built
library (`dist-lib/rocketry.iife.js`) directly into splashcast and called
it in-browser.** Rejected once raised directly: rocketry is GPLv3
(it ports OpenRocket's own GPLv3 algorithms). Copying/bundling that code
into splashcast's own repo and runtime would make splashcast a combined
work, forcing splashcast itself to be GPLv3 (or creating real licensing
exposure) — not something to do by accident as a side effect of an
integration convenience. **Decision: keep the two codebases fully
separate.** Splashcast will never vendor, import, or execute rocketry's
code. Instead:

- splashcast already publishes its weather JSON publicly (confirmed live:
  `https://ezracc.github.io/splashcast/data/<site>/manifest.json` serves
  with `access-control-allow-origin: *`, same for the per-date
  `splash_zones_captured_*.json` files — GitHub Pages sets this by default,
  no config needed on either side).
- rocketry (separately, in its own repo, by the user's own account —
  **out of scope for this plan**) gets a new "embed" entry point that
  accepts a wind-JSON URL + hour via query params, fetches and parses that
  JSON with its own existing `parseSplashcastWindData()`, and shows its
  own real rocket-library/motor-search/simulate UI (already built) —
  pre-wired to that wind data instead of the manual constant-wind input it
  has today.
- splashcast embeds that page in a **visible** iframe (not hidden) so the
  visitor keeps full rocket/motor choice through rocketry's own real UI —
  an earlier hidden/silent-iframe idea was raised and rejected directly by
  the user for exactly this reason: a hidden call has no UI for the
  visitor to pick anything, forcing a permanently fixed rocket/motor. The
  user also asked directly whether merging the two repos would be needed
  to preserve selection — it isn't: a visible, interactive iframe
  preserves full rocket/motor choice via rocketry's own already-built UI
  with zero code sharing, so there's no reason to merge and reintroduce
  the GPLv3 concern this whole redesign exists to avoid.
- when the visitor runs a simulation over there, rocketry `postMessage`s
  the resulting `AscentPath` JSON back to splashcast, which renders it in
  the existing (already-prototyped) 3D/2D consumer code.

**Confirmed with the user**: no silent/automatic default simulation on
page load — the ascent-path marker only appears once a visitor explicitly
opens the panel and runs a sim in rocketry's own UI. Simpler, one code
path, and matches "for now" scope (this replaces the rail-angle dial's
*manual* interaction model with a *different*, richer manual interaction,
not an always-on background computation).

## What already exists (confirmed directly)

- **rocketry**: `src/physics/wind/splashcast-import.ts` /
  `parseSplashcastWindData(json)` already parses splashcast's exact
  published shape (`wind_profiles: {hour: {model: [altFt, speedMph,
  dirDeg][]}}`, `wind_hours`, `descent_params.site_elev_ft`). Real rocket
  library (`sim-files/{LOC,Apogee,Mach1}/*.rkt`, browsable/uploadable in
  its UI) and live ThrustCurve.org motor search
  (`src/physics/motor/thrustcurve-client.ts`) are already built and used
  in rocketry's own existing browser UI (`src/main.ts`) — none of this
  needs to be built, only wired to URL-param wind input instead of the
  manual constant-wind field it uses today, and wired to emit a
  `postMessage` on simulate. Output shape (`AscentPath`: `waypoints`,
  `path`, `segments`, `windShear`, world frame x=East/y=North/z=up-AGL,
  meters) is documented in full in
  `rocketry/sim-files/ascent-path-export.README.md`.
- **splashcast, local-only prototype already built this session**
  (`?testAscent=1`, uncommitted): `site/assets/js/descent3d.js`
  (`testAscentApogeeFt()`, `testAscentBoxHTML()`, `testAscentBearingDeg()`,
  `testAscentPositionTiltDeg()`, `path3dDrawTestAscentPath()`,
  `path3dDrawScene()`'s substitution of the sim's apogee offset in place
  of `railShiftFt()`'s output) and `site/assets/js/app.js`
  (`drawPredictedApogeeMarker()`'s `testActive` branch). This code already
  reads exactly the `AscentPath` shape rocketry produces — the consumer
  side needs renaming (`testAscent*` → `ascent*`) and re-pointing from a
  static local fetch to the postMessage payload, but the actual
  data-shape handling and the earlier `tiltFromVerticalDeg`-is-attitude-
  not-position-angle bugfix carry over unchanged.
- **Correction to rocketry's own README**: it describes splashcast's
  current approximation as a fixed `boost_angle_deg` + `max_pad_move_ft`.
  Verified directly this is stale/half wrong — `DATA.boost_angle_deg` is
  published but not actually applied as a default (`railAngleDeg` inits to
  0, deliberately, per an explicit comment in `app.js`), and
  `max_pad_move_ft` is unrelated to weathercocking at all (it's the
  launch-*pad*-marker drag cap, `MAX_PAD_MOVE_FT`). Only
  `railAngleDeg`/`railHeadingDeg`/`railShiftFt()`/the rail dial are what
  this feature actually replaces.

## Interface contract (splashcast ↔ rocketry) — full handoff spec

The user is directly driving rocketry-side development (a separate Claude
Code session in that repo) and asked for **explicit, self-contained
directions** to feed that session — not just a shape sketch. This section
is written to be copy-pasted/handed off as-is. Splashcast's own
implementation (further below) is this plan's actual job; everything in
this section is the contract splashcast needs the other side to satisfy,
written precisely enough that the two sides can be built independently
without drift or back-and-forth.

### What rocketry needs to build: an "embed mode"

Reuse the existing single-page app (`src/main.ts`/`index.html`) behind a
URL flag rather than adding a whole new Vite multi-page entry — simplest
to implement, no build-config changes. Recommended URL shape:

```
https://ezracc.github.io/rocketry/?embed=1&windUrl=<url-encoded splashcast JSON URL>&hour=<int>&parentOrigin=<url-encoded splashcast origin>
```

**Query params, all required when `embed=1`:**
- `windUrl` — absolute URL to a splashcast `splash_zones_captured_*.json`.
  Fetch it directly (`fetch(windUrl)`); CORS is already open (`access-
  control-allow-origin: *`, confirmed live on GitHub Pages for both sites,
  no special handling needed). Parse with the already-existing
  `parseSplashcastWindData()` (`src/physics/wind/splashcast-import.ts`) —
  no changes needed to that parser, it already matches this exact JSON.
- `hour` — integer local hour (e.g. `13`). Must be a key in the parsed
  data's `hours` array (i.e. present in `SplashcastWindData.hours`). If
  it's missing, that's a hard error case (see below) — don't silently pick
  a different hour.
- `parentOrigin` — the exact origin `postMessage` results must be sent
  back to (e.g. `http://localhost:8000` in dev, `https://ezracc.github.io`
  in prod). **Never use `'*'` as the postMessage target** — always this
  exact value, so a malicious/unrelated embedding page can't intercept
  results. Splashcast is responsible for passing its own real origin here
  correctly (see splashcast Task 2 below).

**UI behavior in embed mode:**
1. On load, fetch+parse `windUrl`. If the fetch fails (network error,
   non-200) or parsing throws (schema mismatch), post the error message
   (below) immediately and show an inline error state — don't leave the
   user staring at a blank/broken picker.
2. Call `.modelsForHour(hour)` on the parsed result to get the models
   available at that hour; if empty (or `hour` isn't in `.hours` at all),
   that's the same hard-fetch-error case — post an error, don't fall back
   to a different hour silently.
3. Show a model picker (radio buttons/select, whatever fits the existing
   UI style) populated from that list — this replaces splashcast guessing
   a "primary" model; rocketry has the full multi-model data for this hour
   and is the right place for this choice to live. Selecting a model calls
   `.profileFor(hour, model)` to get the `WindProfile` and sets it as the
   *active* wind input for the existing simulate flow, replacing (not
   supplementing) the manual constant-speed/direction field embed mode
   should hide entirely — a visitor arriving via splashcast shouldn't be
   offered a manual-wind option that produces a result disconnected from
   the forecast they came from.
4. Existing rocket-library browsing/upload UI and existing ThrustCurve
   motor search UI are otherwise unchanged — full selection stays
   available exactly as it works in rocketry's normal (non-embed) mode.
   This is the entire reason embed mode is a visible iframe and not a
   silent background call.
5. When the visitor triggers the existing "Simulate" action and a flight
   result is produced (**regardless of `stability.flyable`** — a marginal
   or unstable pick is still a legitimate, real answer to "what would this
   rocket actually do," not something to silently block; splashcast will
   surface the warning, see below), `postMessage` the success payload
   (below) to `parentOrigin`.
6. If `simulateFlight3D`/`buildAscentPath`/the underlying parse throws for
   any other reason (bad motor data, parser exception, etc.), catch it and
   post the error payload instead of letting it propagate as an
   unhandled UI exception.

**`postMessage` — success**, sent to exactly `parentOrigin`:
```json
{
  "type": "rocketry:ascentResult",
  "rocketName": "string",
  "parseWarnings": ["string", "..."],
  "stability": { "marginCalibers": 1.5, "flyable": true, "warnings": ["..."] },
  "ascentPath": {
    "waypoints": [
      {
        "type": "LIFTOFF | LAUNCHROD | BURNOUT | APOGEE",
        "label": "string", "time": 0.0,
        "position": { "x": 0.0, "y": 0.0, "z": 0.0 },
        "altitude": 0.0, "tiltFromVerticalDeg": 0.0, "aoaDeg": 0.0, "speed": 0.0,
        "wind": { "vx": 0.0, "vy": 0.0, "speed": 0.0, "directionFromDeg": 0.0 }
      }
    ],
    "path": [
      { "time": 0.0, "position": { "x": 0.0, "y": 0.0, "z": 0.0 }, "altitude": 0.0, "tiltFromVerticalDeg": 0.0 }
    ],
    "segments": [ { "from": "LAUNCHROD", "to": "BURNOUT", "label": "string", "description": "string" } ],
    "windShear": {
      "ground": { "vx": 0.0, "vy": 0.0, "speed": 0.0, "directionFromDeg": 0.0 },
      "aloft": { "vx": 0.0, "vy": 0.0, "speed": 0.0, "directionFromDeg": 0.0 },
      "speedDeltaMs": 0.0, "directionDeltaDeg": 0.0
    }
  }
}
```
This is exactly `AscentResult` from `src/lib.ts` (already defined,
already produced by `buildAscentPath()`/`simulateFlight3D()` today) —
field-by-field meanings are already fully documented in
`rocketry/sim-files/ascent-path-export.README.md`; no new fields to
invent, just wrap the existing result in this envelope and post it.
Positions are meters, world frame x=East/y=North/z=up-AGL — same
convention the already-built splashcast consumer code expects (validated
this session against a hand-built fixture in exactly this shape).

**`postMessage` — error**, sent to exactly `parentOrigin`:
```json
{ "type": "rocketry:error", "message": "human-readable reason" }
```
Cover at minimum: wind fetch failed (network/404), wind JSON failed to
parse against the expected schema, `hour` not present in the wind data,
and any uncaught exception from the simulate call itself. `message` should
be specific enough to show directly to the splashcast visitor (e.g. "Could
not load wind data for hour 13" rather than a raw stack trace).

**Acceptance test for the rocketry-side work** (to confirm before calling
it done, independent of splashcast): load
`http://localhost:5173/?embed=1&windUrl=<a real, currently-published
splashcast JSON URL>&hour=13&parentOrigin=http://localhost:8000` directly
in a browser, with a `window.addEventListener('message', e =>
console.log(e.origin, e.data))` registered in that same tab's console
(simulating what splashcast will do) — confirm wind loads, model picker
populates, a real rocket+motor selection runs a simulation, and the
console listener logs a well-formed `rocketry:ascentResult` (or
`rocketry:error` when deliberately forcing a bad `windUrl`/`hour`).

> **Update 2026-08-16 — actual shipped contract differs from the spec
> above.** Rocketry's real embed page computes one ascent simulation **per
> forecast model** (the same 6 wind profiles each model's own descent path
> already integrates), not a single result — confirmed directly against a
> real sample payload rocketry provided:
> `/home/ezrac/github/rocketry/sim-files/hutto-0815-loc-iv-k400-ascent-results.json`.
> The actual success payload:
> ```json
> {
>   "type": "rocketry:ascentResults",
>   "rocketName": "string",
>   "parseWarnings": ["string", "..."],
>   "stability": { "margin": 4.22, "flyable": true, "warnings": ["..."] },
>   "results": [
>     { "model": "gfs", "ascentPath": { "waypoints": [...], "path": [...], "segments": [...], "windShear": {...} } },
>     { "model": "ecmwf", "ascentPath": { ... } },
>     { "model": "gem", "ascentPath": { ... } },
>     { "model": "icon", "ascentPath": { ... } },
>     { "model": "arpege", "ascentPath": { ... } },
>     { "model": "hrrr", "ascentPath": { ... } }
>   ]
> }
> ```
> `type` is `rocketry:ascentResults` (plural), `results` replaces the old
> top-level `ascentPath` with an array of `{model, ascentPath}`. `stability`/
> `parseWarnings` stay shared/top-level — they come from the rocket+motor
> config, not the wind, so they don't vary per model. The sample's 6 models
> (`gfs`/`ecmwf`/`gem`/`icon`/`arpege`/`hrrr`) match `MODEL_LEGEND_ORDER`
> (`app.js`) exactly. `rocketry:error` is unchanged.
>
> **Why**: requested directly — "The ascent paths per forecast model should
> be tied to the descent paths, and toggle with them as models are selected/
> deselected." A single shared ascent path couldn't do that; per-model
> results, tied 1:1 to each model's own descent path via the same
> `state.selectedModels` filtering, can. Splashcast's consumer code
> (`ASCENT_RESULTS`, `descent3d.js`/`app.js`) has been updated to match —
> see Task 6 below. No further rocketry-side change expected for this; note
> here only so this doc's earlier spec isn't mistaken for the current
> contract.

### Splashcast's half of the contract (this plan's actual job, below)

- Build the iframe `src` with all three query params (`windUrl`, `hour`,
  `parentOrigin`) — `parentOrigin` must be `window.location.origin` read
  live, not a hardcoded string, so this works identically in local dev and
  production without a manual switch.
- Listen for both `rocketry:ascentResult` and `rocketry:error`, validate
  `event.origin` matches the rocketry origin the iframe was actually
  pointed at before touching payload contents.
- Render `stability.warnings`/`parseWarnings` (not just `ascentPath`)
  somewhere visible when present — rocketry is intentionally sending a
  flyable:false result through rather than blocking it, so splashcast is
  the layer responsible for making that visible rather than silently
  plotting a result from an unstable configuration as if it were routine.

## Implementation plan (splashcast side only)

### Task 1 — "Simulate ascent path" panel UI

- Add a button/affordance near the existing rail-angle dial (`.rail-angle-
  control`, `site/index.html`) — e.g. "Simulate real ascent path" — that
  opens a panel/modal containing an `<iframe>`.
- Construct the iframe `src` only when the panel is opened (not
  reactively on every render, so an in-progress rocket/motor pick inside
  the iframe isn't disrupted by unrelated state changes elsewhere in
  splashcast): `${ROCKETRY_EMBED_BASE}?embed=1&windUrl=${encodeURIComponent(
  currentWindJsonUrl)}&hour=${nearestPublishedHour(state.timeMinutes)}&parentOrigin=${encodeURIComponent(window.location.origin)}`.
  `currentWindJsonUrl` is the absolute URL of the already-fetched
  `splash_zones_captured_*.json` for the current site/date.
- A visible close/reset control that hides the panel and reverts to the
  manual rail-angle dial (see Task 4) without needing a result.

### Task 2 — `ROCKETRY_EMBED_BASE` config

- New constant, e.g. in `app.js` near other top-level config:
  `ROCKETRY_EMBED_BASE = 'https://ezracc.github.io/rocketry/'` in
  production. For local dev against a locally-running rocketry (e.g. its
  Vite dev server), make this overridable via a `?rocketryBase=` URL param
  rather than a manual code edit — the expected postMessage-sender origin
  for Task 3 is then simply `new URL(ROCKETRY_EMBED_BASE).origin`, derived
  from this one value rather than tracked separately, since the contract
  (Interface contract, above) already has rocketry sending back to exactly
  the `parentOrigin` splashcast itself provided — the only thing splashcast
  needs to validate on receipt is that the message actually came from the
  rocketry origin it opened, not an unrelated one.

### Task 3 — `postMessage` listener + result wiring

- `window.addEventListener('message', evt => { if (evt.origin !==
  new URL(ROCKETRY_EMBED_BASE).origin) return; ... })` — reject anything
  not from the expected rocketry origin before touching payload contents
  at all.
- On `type: "rocketry:ascentResult"`: store `evt.data.ascentPath`
  (replaces the old `TEST_ASCENT_DATA`), trigger `renderDescent3D()` +
  `render()` (both, per the async-timing bugfix already learned this
  session with the local prototype — a fetch/message resolving after the
  initial synchronous render must explicitly re-trigger every dependent
  view, not just the one you're focused on), and switch the rail dial into
  its disabled/sim-driven display state (Task 4).
- On `type: "rocketry:error"`: surface `evt.data.message` somewhere visible
  in the panel (not a silent console-only failure) and leave the rail dial
  in its normal manual-control state.
- On panel close/reset (Task 1): clear the stored ascent path and revert
  to manual rail-angle mode, regardless of whether a result had arrived.

### Task 4 — Generalize the existing local prototype from `?testAscent=1` to the real data source

- `descent3d.js`: remove the `TEST_ASCENT_ENABLED` URL-param gate and the
  static `fetch('data/hutto/live/2026-08-15/ascent-path-test.json')` call.
  Rename `testAscentApogeeFt()` → `ascentApogeeFt()`,
  `testAscentBoxHTML()` → `ascentBoxHTML()`, `testAscentBearingDeg()` →
  `ascentBearingDeg()`, `testAscentPositionTiltDeg()` →
  `ascentPositionTiltDeg()`, `path3dDrawTestAscentPath()` →
  `path3dDrawAscentPath()` — logic unchanged, now reading from the
  postMessage-populated data (Task 3) instead of a fetched fixture.
- `app.js`: same rename/generalize for `drawPredictedApogeeMarker()`'s
  `testActive` branch → becomes the active path whenever a received
  ascent path exists, falling back to `railShiftFt()`/the manual dial
  otherwise (which is also simply the everything-before-this-feature
  default state, not a new fallback path to build).
- Rail dial: reuse the existing `.rail-angle-control.test-ascent-disabled`
  CSS (rename to drop "test-", e.g. `.rail-angle-control.sim-active`) and
  its tooltip copy for the "disabled while a real ascent-path result is
  active" state — this was already built and validated this session.

### Task 5 — Verification

- Confirm the iframe loads, and that `windUrl`'s target
  (`splash_zones_captured_*.json`) is genuinely fetchable cross-origin
  from rocketry's page once that side exists — the CORS header is already
  confirmed present (`access-control-allow-origin: *` verified live via
  curl against both `ezracc.github.io/splashcast/...` and
  `ezracc.github.io/rocketry/`), so this should just work, but confirm end
  to end once both sides are live rather than trusting the header check
  alone.
- Confirm `postMessage` origin validation actually rejects a message from
  an unexpected origin (test by temporarily posting from the browser
  console against a mismatched origin) — this is the one real security-
  relevant piece of this feature.
- Confirm the full round trip on at least one real site/date: open panel →
  pick a real rocket + real motor in rocketry's UI → run sim → result
  renders correctly in splashcast's 2D marker and 3D boost line → close
  panel reverts cleanly to the manual dial.
- Confirm the `rocketry:error` path renders visibly (force it with a
  deliberately non-flyable rocket pick, or a mismatched/missing wind hour).
- Delete the local `site/data/hutto/live/2026-08-15/ascent-path-test.json`
  fixture once the real path is verified working (always untracked/local-
  only, safe to remove once superseded).
- CHANGELOG entry + README staleness check before any push, per this
  repo's standing convention (`CLAUDE.md`).

### Task 6 — Per-model ascent-path consumer rewrite (2026-08-16, once rocketry actually shipped)

Added once rocketry's real embed page returned real per-model results (see
the "Update 2026-08-16" callout above) instead of the single-result shape
Task 4 was built against.

- `app.js`: `ASCENT_RESULT` → `ASCENT_RESULTS` (renamed), stores the whole
  `{rocketName, parseWarnings, stability, results: [{model, ascentPath}]}`
  payload. Message listener now matches `rocketry:ascentResults`.
- `descent3d.js`: every ascent function now takes an explicit `ascentPath`
  (or `model`) argument instead of reading one global —
  `ascentPathForModel(model)`, `ascentApogeeFt(ascentPath)`,
  `ascentPositionTiltDeg(waypoint, ascentPath)`, `ascentBoxHTML(kind,
  model)`. New `ascentMeanApogeeFt()` (mean across every model in the
  result) for the few places that need ONE representative value rather
  than a specific model's own (Z-axis scaling, the apogee-altitude label,
  the shared descent-simulation starting altitude, and the 2D map's single
  ground marker) — apogee position/altitude varies only ~0.5% model to
  model in the real sample data, so a mean is honest, not a fudge.
- `path3dDrawAscentPath(toScreen, model, ascentPath)` now draws ONE
  model's ascent curve, colored via `MODEL_COLORS_HEX[model]` — the exact
  same color as that model's own descent line, which is what visually
  "ties" the two together (one continuous color, liftoff through apogee
  down to landing).
- `path3dDrawScene()`: ascent curves are drawn by iterating `paths` (the
  descent-path list already filtered by `state.selectedModels` — see
  `renderDescent3D()`), one `path3dDrawAscentPath()` call per entry that
  has a matching model in `ASCENT_RESULTS.results`. This is the actual
  toggle mechanism requested — no separate ascent-visibility flag exists
  to fall out of sync with the descent-path model selection, because
  ascent visibility is *derived from* the same already-filtered list.
- Each model's own descent path now starts from THAT model's own true
  ascent apogee offset (`shiftForModel(model)`), not one shared value —
  previously (Task 4) every model's descent line was rigidly offset by a
  single shift regardless of that model's own simulated weathercocking.
- `ascentHitPoints` gained a `model` tag; `ascentBoxOpenKind` became a
  composite `${model}|${kind}` key so several models' weathercock/burnout
  popups don't collide; popup titles now use `modelNameHTML(model)` (same
  colored model name every descent-path tooltip already uses).
- 2D map's `drawPredictedApogeeMarker()` deliberately stayed a single
  summary marker (not exploded per model) — the "tied to descent paths"
  request was specifically about the 3D view (the 2D map has no per-model
  descent-*path* curve, only point scatter/zones, to tie an ascent curve
  to); it now uses `ascentMeanApogeeFt()` instead of one model's value.
- Verified: JS brace/paren balance, no stray singular
  `ASCENT_RESULT`/`rocketry:ascentResult` references, the sample payload's
  6 models confirmed to match `MODEL_LEGEND_ORDER` exactly, served content
  confirmed live via the local dev server. Full interactive round-trip
  (real rocket/motor pick in rocketry's UI → live `postMessage` → renders
  correctly with per-model toggling) still not yet done in an actual
  browser — no browser automation available in this environment.

> **Update 2026-08-16 (2) — rocket+motor name display, from rocketry's
> repeat-visit caching update.** Rocketry's caching write-up
> (`/home/ezrac/github/rocketry/tmp/splashcast-caching-update.md`) added
> one new optional field to `rocketry:ascentResults`: `rocketConfig?:
> { label: string; rocketSource; motorId; overrides }`, present whenever
> rocketry has a cached rocket+motor config to attach (absent otherwise).
> `label` is human-friendly and ready to display as-is (e.g. "LOC-IV X2 +
> AeroTech K400C" — rocket **and** motor, unlike the existing top-level
> `rocketName`, which is rocket-only). Requested directly: show this when a
> flight profile is loaded.
>
> Implementation: new `#ascent-sim-label` element (`index.html`), a small
> pill anchored above `#rail-angle-control` (`.ascent-sim-label`,
> `app.css`) — `.rail-angle-control` is already `position: absolute`, so it
> doubles as the containing block, no new positioning context needed. The
> message listener (`app.js`) sets its text to
> `data.rocketConfig?.label || data.rocketName` (falls back to the
> rocket-only name on any payload that predates the caching update, or any
> visit where rocketry has no cached config yet — e.g. private browsing,
> first-ever pick before a sim has run) and shows it; `resetAscentSim()`
> clears and hides it. Only `label` is read — `rocketSource`/`motorId`/
> `overrides` are for a possible future "remember the pick on splashcast's
> own side too" feature (mentioned as optional/deferred in rocketry's
> write-up), not implemented here.
>
> Verified via a local Playwright script dispatching a synthetic
> `message` event (real rocketry embed page not available in this
> environment) against the sample payload
> (`rocketry/sim-files/hutto-0815-loc-iv-k400-ascent-results.json`) with a
> hand-added `rocketConfig.label`: label renders correctly
> ("LOC-IV X2 + AeroTech K400C"), falls back to `rocketName` alone
> ("LOC-IV-X2") when `rocketConfig` is omitted, and clears on
> close/reset — screenshot confirmed the pill's placement above the dial
> reads cleanly, no overlap with the map or other controls.

> **Update 2026-08-16 (3) — real-browser bugs found testing on production,
> plus per-model apogee markers.** The user tested the live round trip on
> production (Sunday, low traffic, explicitly accepted the risk) and
> reported four things directly. Investigated each with a real headless-
> Chromium session (Playwright) dispatching a synthetic `rocketry:
> ascentResults` message against the real sample payload — no browser
> automation had been available in this environment for any earlier task
> in this plan, so this was the first time any of Task 6's per-model
> rewrite actually ran in a browser at all.
>
> 1. **"The 3d map is not working after we get flight data" — real crash,
>    confirmed and fixed.** `path3dDrawScene()` referenced `ascentMean` at
>    line 919 (old numbering), a `const` that only ever existed inside
>    `renderDescent3D()`, a separate top-level function — not a closure
>    variable. This threw `ReferenceError: ascentMean is not defined` on
>    **every single 3D render**, confirmed via a real browser test that
>    reproduced the error even before any sim message arrived (plain page
>    load with `?view=3d`) — the 3D view had been completely broken since
>    Task 6 shipped, not just once flight data arrived; the user just
>    hadn't opened 3D before testing the sim specifically. Fixed by passing
>    `ascentMean` in explicitly: `path3dDrawScene(paths, altFt, ascentMean)`.
>    This was live on production between the previous push and this fix —
>    flagged to the user directly, not glossed over.
> 2. **"We need to update the apogee number to match it."** `resolveMapAltFt()`
>    (`app.js`) had no awareness of `ASCENT_RESULTS` at all — the 2D
>    altitude readout/slider and the `byAltitude` zone(s) actually drawn
>    still reflected whatever the manual ladder/slider was set to, even
>    with a real sim result active, while `renderDescent3D()` (3D) already
>    correctly overrode altitude with `ascentMeanApogeeFt().altFt`. Fixed
>    by giving the sim result top priority in `resolveMapAltFt()`'s own
>    chain, and collapsing `render()`'s `byAltitude` ladder to the single
>    sim-altitude zone (`applyIsolation()` updated to match, same
>    `selected = null` bypass `customAlt` already gets) — mirrors 3D's
>    already-established precedent instead of inventing a new rule. Found
>    and fixed a self-introduced bug while verifying this: the readout
>    initially rendered `"6,841.416 ft"` (an unrounded float mean, unlike
>    every other value this function returns) — `resolveMapAltFt()` now
>    rounds the sim branch explicitly.
> 3. **"Apogee on 2d is still showing as a single triangle... matching the
>    color/symbols for the forecasts... putting a same colored circle
>    around them."** `drawPredictedApogeeMarker()` (`app.js`) now draws one
>    marker per model while a sim is active — `MODEL_SHAPES`/
>    `MODEL_COLORS_HEX`, the same convention every landing-point marker
>    already uses — plus a same-colored ring around each one. Dial mode
>    (no sim) is unchanged: still the single triangle, since there's no
>    per-model position to plot there.
> 4. **"Those are ground markers, even on 3d. they can just follow the
>    color of the line elsewhere."** New `path3dDrawGroundApogeeMarker()`
>    (`descent3d.js`) draws each model's own apogee X/Y offset projected
>    onto the z=0 ground plane in the 3D view too, colored to match that
>    model's own line (no shape needed there — 3D already ties color to
>    model via the line itself).
> 5. **"Make sure the paths (ascent and descent) are mobile friendly and
>    can be clicked."** Ascent points (weathercock/burnout) already had
>    touch support (`path3dEndDrag`'s tap hit-test, built with Task 6) —
>    **descent-path points had none at all**, hover-only
>    (`path3dHandleHover`, explicitly desktop-only by its own prior
>    comment). Extracted `path3dFindDescentHit()`/`path3dShowDescentTooltip()`
>    so hover (desktop) and tap (touch, via `path3dEndDrag`) share one
>    implementation; tap now toggles the same tooltip hover already shows,
>    keyed by `model|sx|sy` (not object identity — `path3dHitPoints` is
>    rebuilt every render). New `PATH3D_TAP_PROXIMITY_PX` (36px, wider than
>    desktop hover's 22px `PROXIMITY_PX`) for both ascent and descent tap
>    hit-testing — a finger's contact area is coarser than a mouse cursor
>    and touch has no hover fallback to recover a near-miss.
>
> **Verified**, all via real headless-Chromium sessions (Playwright),
> dispatching a synthetic `rocketry:ascentResults` message against the real
> sample payload (rocketry's own embed page still isn't live to test
> against end-to-end): 3D renders with zero console errors before and after
> a sim message, both with and without a sim active; 2D readout/zone/marker
> altitude all agree with 3D's own apogee label (all three read "6,841 ft"
> off the same real sample); 6 per-model markers + 6 rings render in 2D,
> color/shape-matched to the model legend; 3D ground markers render at each
> model's own apogee offset; dial-mode (no sim) single-triangle marker
> confirmed unchanged (regression check); a real `PointerEvent` with
> `pointerType: 'touch'` dispatched directly at a descent-path point's
> screen position opens the tooltip with correct content, and at an ascent
> point opens the ascent box with correct content — both confirmed via
> direct `PointerEvent` dispatch after Playwright's own higher-level
> `touchscreen.tap()` helper showed a false negative (tooltip content set
> correctly, then immediately hidden by some emulation-layer follow-up
> event distinct from anything this app's own code fired) that didn't
> reproduce with a raw dispatched event, i.e. confirmed as a test-harness
> artifact, not a real bug.

> **Update 2026-08-16 (4) — background per-hour prefetch, splashcast-side
> only.** Reported directly: "when the time is switched, apogee doesn't
> change. We need to resend to splashcast and get a new ascent profile."
> Confirmed why: `rocketry:ascentResults` only ever carried ONE hour's
> results (whichever `hour` the panel was opened with), and nothing
> re-triggered a new simulate call as the time slider moved afterward, so
> the first-requested hour's result just stayed frozen regardless.
>
> **First considered, then dropped**: extending rocketry's own contract to
> return an array of hours in one response. Corrected directly: rocketry
> "only digest[s] what we send them" — it has no concept of "give me
> several hours," it just simulates whatever single `windUrl`+`hour` it's
> given. **No rocketry-side change was needed at all.** The fix is entirely
> a splashcast-side orchestration of the SAME single-hour contract that
> already existed, repeated across the 0900-1500 window and cached locally.
>
> **Design, confirmed directly**: after the first visible/interactive
> simulate returns, splashcast automatically drives a **hidden** iframe
> (`ascentPrefetchIframe`, `app.js` — a separate element from the visible
> `ascentSimIframe`) through the other 6 hours in `{9,10,11,12,13,14,15}`,
> one at a time, same rocket+motor auto-restored via rocketry's own
> existing caching (`splashcast-caching-update.md`) with zero new UI
> interaction. Deliberately **hourly-only, 0900-1500** — not the 15-minute
> drag resolution the time slider otherwise supports ("I don't want 15
> minute resolution with real flight sims... to help manage data bloat").
> Confirmed this doesn't violate the plan's own earlier "always visible
> iframe" decision (Context, above): that rule was about preserving the
> visitor's real CHOICE of rocket+motor, which stays fully interactive for
> the first pick; the 6 background reruns make no new choice on the
> visitor's behalf, they just repeat an already-made one for hours not yet
> viewed.
>
> **Implementation**:
> - `ASCENT_RESULTS.resultsByHour` (`{[hour]: [{model,ascentPath},...]}`)
>   replaces the old flat `.results` — the interactive result seeds one
>   entry (keyed by `ascentSimRequestedHour`, tracked since rocketry's own
>   payload doesn't echo the hour back), then `ascentPrefetchStart()` queues
>   the other 6 and `ascentPrefetchNext()` walks them one at a time,
>   reloading the hidden iframe's `src` per hour.
> - The message listener now branches on `evt.source` — `ascentSimIframe`
>   (interactive: closes the modal, sets the dial/label state, kicks off
>   the prefetch queue) vs. `ascentPrefetchIframe` (background: stores the
>   hour silently, re-renders, advances the queue; a `rocketry:error` for a
>   background hour is silently skipped, not shown to the visitor — that
>   hour just stays unavailable, see `ascentResultsForHour()` below).
> - An `ascentEpoch` counter, bumped by `ascentPrefetchStart()`/
>   `ascentPrefetchStop()`, guards a stale in-flight background response
>   (started under a since-replaced or since-reset rocket/motor) from
>   writing into a `resultsByHour` it no longer belongs to.
> - New `ascentResultsForHour(hour)` (descent3d.js): clamps to [9,15] first
>   (confirmed directly: outside 9am-3pm the sim result stays the
>   active/authoritative one, clamped to the nearest edge hour, rather than
>   reverting to the manual dial), then picks the NEAREST hour actually
>   present in `resultsByHour` yet (not just nearest in the abstract 9-15
>   range) — this is what keeps the map showing something sim-driven
>   immediately after the first interactive result, before the background
>   prefetch has finished filling in the rest.
> - `ascentPathForModel(model, hour)` and `ascentMeanApogeeFt(hour)` both
>   gained an explicit `hour` argument; every render-time caller
>   (`renderDescent3D()`, `resolveMapAltFt()`, `drawPredictedApogeeMarker()`,
>   `path3dDrawScene()`'s per-model loop) computes
>   `nearestPublishedHour(state.timeMinutes)` fresh and passes it through.
>   `ascentBoxHTML()` (the click/hover info popup) recomputes the current
>   hour live at call time instead of threading it through hit-point
>   objects — it only ever runs interactively, so "whatever's on screen
>   right now" is always correct with no staleness risk.
>
> **Verified** via headless-Chromium (Playwright), network-isolated (real
> `ezracc.github.io` traffic blocked — confirmed it's actually live and was
> answering the hidden iframe's real navigations during an early test run,
> which had to be isolated out to get a clean result): interactive result
> seeds hour 9, prefetch queue drains through 10→15 in order via synthetic
> per-hour responses, all 7 hours end up in `resultsByHour`; a direct check
> with distinct fake altitudes at hours 9/12/15 confirmed
> `ascentMeanApogeeFt()` picks the exactly-matching hour when scrubbed
> there, the correct NEARER neighbor when scrubbed between two available
> hours, and clamps correctly outside 9-15 (7am and 5pm both resolved to
> hour 9's/15's own data respectively, per the confirmed clamp-not-revert
> decision); closing the panel mid-prefetch (`resetAscentSim()`) correctly
> clears the queue, bumps the epoch, and a stale in-flight response
> arriving after that reset is dropped without resurrecting
> `ASCENT_RESULTS`. Zero console errors throughout. Full real-rocketry
> round trip (interactive pick + real background prefetch against the live
> deployed rocketry embed) still not done — same standing blocker as
> Task 5's own unchecked items, rocketry's real embed page behavior can
> only be confirmed once tested together live.

> **Update 2026-08-16 (5) — autoSend param, model-aware apogee mean, cloud
> badge popup.** Three items, requested directly in one message:
>
> 1. **`autoSend=1`** — the background prefetch requests (`ascentPrefetchNext()`,
>    app.js) now send `autoSend=1` alongside the existing `embed`/`windUrl`/
>    `hour`/`parentOrigin` params. Rocketry's own auto-restore/auto-run
>    apparently still gates on some real user-interaction signal a hidden
>    background load has none of; this tells it to skip that and auto-run
>    immediately once the cached rocket+motor is restored. **Only sent on
>    the hidden prefetch iframe** — `openAscentSimModal()`'s own visible/
>    interactive request deliberately does NOT set it, since that load's
>    whole point is a real "Simulate" click or a fresh rocket/motor pick,
>    not an auto-run. Needs matching rocketry-side support to actually take
>    effect — noted as Task 10's own open item above.
> 2. **Model-aware apogee mean.** `ascentMeanApogeeFt(hour)` (descent3d.js)
>    now filters to `state.selectedModels` before averaging (falling back
>    to every model in that hour's results if the filtered set would be
>    empty) — requested directly: "apogee may differ between forecasts
>    because of weathercocking, which eats altitude... if only HRRR is
>    showing, then show it. If they change from 6 to 4 models, recalc it."
>    No new wiring needed for the "recalc on toggle" part -- toggling a
>    model already triggers a re-render, which already calls
>    `ascentMeanApogeeFt()` fresh every time. Verified directly: with HRRR
>    solo'd, `ascentMeanApogeeFt()`'s result matches HRRR's own individual
>    `ascentApogeeFt()` output exactly (x/y/altFt all identical).
> 3. **Nearest-10 rounding, 3D apogee label only.** `path3dDrawApogeeLabel()`
>    now displays `Math.round(altFt / 10) * 10` instead of `Math.round(altFt)`
>    — "~5,280', round it to the nearest 10... these are estimators and
>    shouldn't pretend to be to-the-foot accurate." Only the printed text
>    rounds; the label's screen POSITION still uses the exact value, so it
>    stays visually anchored to the real marker point. Scoped to the 3D
>    label specifically (not the 2D altitude readout or the per-model
>    marker tooltips), matching where this was asked.
> 4. **Cloud warning badge, real click-to-open popup.** Reported directly:
>    "I'm not getting a popup when clicking the warning icon" for the
>    Clouds row's >=50%-cover flag. Root cause: that icon was always
>    `.cloud-cell.cell-hot::after`, a CSS pseudo-element with no click
>    handler at all — the exact same limitation `.temp-risk-badge`
>    (temperature's own warning icon) was built to replace, documented
>    directly in that feature's own CSS comment ("not the... pseudo-
>    element, which can't carry a click handler") — clouds just never got
>    the same upgrade. Fixed by giving cloud cells a real
>    `<button class="cloud-risk-badge">` (`addCloudRow()`, app.js) with the
>    exact same click-to-open/toggle-closed-on-repeat-click/click-away
>    mechanism `showTempRiskBox()` already established (`showCloudRiskBox()`,
>    new `#cloud-risk-box` element, index.html), showing the cell's own
>    per-model breakdown (same content the hover tooltip already built,
>    extracted into a shared `cellContentHTML()` so hover and click always
>    agree). The old `::after` pseudo-element is suppressed specifically
>    for non-`.wind-cell` cells (`.cloud-cell.cell-hot:not(.wind-cell)::after
>    { display: none; }`) so it doesn't double up with the new button —
>    **wind cells keep their existing (still unclickable) badge exactly as
>    before**, out of scope for this fix (only Clouds was reported).
>
> **Verified** via headless-Chromium (Playwright): prefetch iframe's `src`
> contains `autoSend=1`, the interactive iframe's does not; `ascentMeanApogeeFt()`
> with only HRRR selected returns exactly HRRR's own individual apogee;
> the cloud badge opens the popup on click, closes on click-away, and
> toggles closed on a repeat click on the same badge; exactly 1 badge
> rendered for the 1 real hot cell present (no stray/duplicate badges);
> wind/temp's own existing badges visually unaffected. Zero console errors.

> **Update 2026-08-16 (6) — 15-minute ascent interpolation.** Requested
> directly: "can we interpolate the 15 minute increments between hours for
> the ascent using the before/after bracketing that we do for descents?
> ...if we can allow full functionality on the 15 minute increments for
> ascent similarly, why not." Confirmed the two aren't quite symmetric
> first: descent blends the WIND INPUT (`blendProfilesForTime()`, app.js)
> then cheaply re-simulates client-side; ascent's own physics only exists
> in rocketry, cross-origin, so there's no client-side "re-simulate"
> available — this blends the two real ascentPath OUTPUTS instead.
> Confirmed acceptable directly: "the x,y,z delta is likely to come out
> similarly... we'll fade or dash the line on the non-sim points to show
> they were approximated, not simulated."
>
> **Implementation** (`descent3d.js`): `ascentPathForModel(model, timeMinutes)`
> now takes RAW time (not a snapped hour) and brackets the two real hours
> THIS MODEL has prefetched data for that straddle it — same bracket-
> finding shape `blendProfilesForTime()` already established — then
> linearly interpolates between the two real `ascentPath` outputs. Only
> the fields any splashcast consumer actually reads get blended (waypoint
> position/altitude/speed/time, `path[]` points, `windShear.ground`
> speed+direction — the last via the same circular-shortest-path idiom
> `blendProfilesForTime()` uses for wind, not a naive linear blend that
> could cross the wrong way around the compass); `tiltFromVerticalDeg`/
> `aoaDeg`/per-waypoint `wind`/`segments`/`windShear.aloft` are copied
> unchanged since nothing reads them. The continuous `path[]` polyline is
> resampled onto a shared index grid before blending across hours (pathA/
> pathB aren't guaranteed the same point count — rocketry's integration
> step count isn't guaranteed wind-independent). Returns a real
> ascentPath-shaped object tagged `.interpolated` (true when genuinely
> blended between two different hours; false on an exact-hour hit
> anywhere in the range, the degenerate single-hour case, AND the
> outside-0900-1500 clamp — that last one is real, unmodified data for
> its own hour just held past its valid window, a different kind of
> approximation than an inter-hour blend, not flagged the same way).
> `ascentMeanApogeeFt(timeMinutes)` also switched to raw time so the 3D
> apogee label/2D readout/descent-simulation start altitude all stay
> consistent with whatever the ascent curves themselves show at that exact
> slider position, not a separately-snapped value.
>
> **Visual**: `path3dDrawAscentPath()` dashes (`[5,4]`, same pattern/intent
> `path3dDrawBoostLine()` already uses for the dial's own tan(angle) stand-
> in) and fades (`globalAlpha 0.6`) a model's curve whenever
> `ascentPath.interpolated` is true — scoped to the line itself, per
> direction ("fade or dash the line"); the weathercock/burnout click
> points and ground apogee marker stay full-opacity/solid, since they're
> still real interactive info points showing genuine (interpolated but
> meaningful) numbers.
>
> **A real bug found and fixed during verification**: the first pass
> always took the interpolation branch and computed `weightB`, which
> numerically lands on exactly 0 or 1 at a real hour boundary (so the
> VALUE came out right) but never set `interpolated: false` for it except
> in the single-hour degenerate case — confirmed directly via a browser
> test (every exact-hour hit reported `interpolated: true`). Fixed by
> explicitly checking `clamped === hourA*60` / `clamped === hourB*60`
> before falling through to the blend.
>
> **Verified** via headless-Chromium (Playwright): a synthetic 3-hour
> dataset (9/10/15, distinct altitudes, deliberately different `path[]`
> point counts on two of them) confirmed exact-hour hits at every
> boundary (start/middle/end of the available range) report
> `interpolated: false` with the exact real value; 9:15/9:30 (quarter/half
> between 9-10) and 12:30 (the midpoint of the 10→15 gap, since 11-14 had
> no data in this synthetic set) all interpolate to the exact expected
> linear value; outside 0900-1500 (7am/5pm) clamp to their real edge
> hour's data with `interpolated: false`; the circular wind-direction
> blend lands on the correct shorter-arc midpoint. Against the real sample
> payload prefetched across all 7 real hours: scrubbing 15-minute
> increments from 9am-3pm toggles `interpolated` correctly at every step
> (false only exactly on the hour), zero console errors. Directly
> instrumented `ctx.setLineDash` to confirm zero dash calls at an exact
> hour and a dash call for every visible model at a mid-hour position.

> **Update 2026-08-16 (7) — draggable/resizable/full-screen modal.**
> Requested directly: "make the iframe resizable, draggable, and give it a
> 'full screen' toggle."
>
> - **Resizable**: native CSS `resize: both` on `.ascent-sim-modal-inner`
>   — the browser's own bottom-right corner handle, no hand-rolled resize
>   math needed, and immune to the cross-origin-iframe-steals-events
>   problem entirely (handled UA-internally, not via page-level JS).
>   Default size stays the old 900x800 (`width: min(900px, calc(100vw -
>   32px))`, separate from `max-width: calc(100vw - 32px)`, which is what
>   actually allows growing past 900x800 up to nearly the full viewport).
> - **Draggable**: grab the header (`.ascent-sim-modal-header`, cursor:grab).
>   First drag switches the panel from the CSS default (flex-centered by
>   `.ascent-sim-modal`) to an explicit `position:fixed` anchored at its
>   current rendered position (`getBoundingClientRect()` at drag-start), so
>   taking over never causes a jump. `setPointerCapture()` on the header —
>   same fix this app's own 3D-canvas orbit/2D-map pan already rely on —
>   is what keeps the drag alive even while the cursor passes directly
>   over the cross-origin iframe mid-drag. Clamped so a 40px strip of the
>   header always stays reachable on every edge.
> - **Full-screen toggle**: same CSS-class-toggle pattern
>   `#map-fullscreen-toggle` already established for the map's own button
>   (`.fullscreen-active`, not the native Fullscreen API). The override
>   CSS uses `!important` specifically so it wins over whatever inline
>   drag/resize state is currently set without JS needing to save/restore
>   it — toggling back off reverts to exactly the dragged/resized state
>   automatically, since the underlying inline styles were never touched.
>   Dragging is a no-op while full-screen (nothing to drag to).
> - Every fresh `openAscentSimModal()` call resets all of this back to the
>   default centered/900x800/non-full-screen layout (`ascentModalResetLayout()`)
>   — a dialog reopening in an unpredictable spot from a previous session
>   is worse than always starting clean; nothing here was asked to persist
>   position across separate opens.
>
> **Verified** via headless-Chromium (Playwright): default rect exactly
> centered at 900x800 in a 1200x900 viewport; dragging moves the panel by
> the expected delta (and correctly clamps at the top edge when a drag
> would push it off-screen); a simulated resize (setting inline width/
> height, since Playwright can't drive the browser's own native resize
> handle) correctly reflows the iframe inside it; full-screen exactly
> matches the viewport; un-full-screen reverts to the exact dragged+resized
> rect, not the original default; a drag attempt while full-screen is
> correctly a no-op; closing and reopening the modal resets fully back to
> the default layout. Zero console errors throughout.

> **Update 2026-08-17 (1) — real per-rocket descent rates now drive the
> landing zone.** Asked directly: "are we getting descent rates from
> rocketry after the handoff and adjusting them, along with main deploy
> altitude, to affect the landing zone?" Answer at the time: no, on either
> count — splashcast's descent simulation only ever read
> `state.rateFps`/`DATA.descent_params.main_deploy_altitude_ft` (generic,
> site-level), and rocketry didn't even parse recovery hardware at all
> (`.ork` parser explicitly skips `parachute` as a "known but ignored"
> tag). Confirmed both independently before answering — not a guess.
>
> Rocketry has since added `descentDevices` (see
> `rocketry/tmp/splashcast-caching-update.md`'s own "descentDevices"
> section) — a new, optional, single top-level field (not per-model,
> descent rate doesn't depend on wind):
> ```ts
> descentDevices?: { role: "drogue" | "main"; type: "parachute" | "streamer"; descentRateMs: number; deployAltitudeM: number | null }[]
> ```
> Real terminal-velocity physics against the actual rocket's descending
> mass and launch-site air density (rocketry's own existing local
> "Recovery devices" panel calculation, not a stub), present only for
> RockSim `.rkt` uploads/library picks (`.ork`/RASAero recovery-device
> extraction doesn't exist yet). **`deployAltitudeM` is always `null`** —
> RockSim's own file format has no field for it at all (confirmed against
> every device in rocketry's vendored library and against OpenRocket's own
> RockSim importer). Per direction: `main_deploy_altitude_ft` stays the
> site's generic pipeline constant, untouched — "they'll have to manually
> fix it or fix their sim file" (there's no in-app way to edit it today;
> `main_deploy_altitude_ft` is explicitly read-only in this UI, per its
> own existing comment).
>
> **Implementation** (`app.js`): new `applyDescentDevices(descentDevices)`,
> called once from the interactive-result branch of the message listener
> (not the background-prefetch branch — rocket-level data doesn't vary by
> hour, so applying it once per rocket pick is correct). Exactly one
> device → single-stage, applied to `main` (a device's own `role` already
> tells drogue/main apart physically — smaller device is drogue, larger is
> main, which is what that role assignment reflects — not something this
> function re-derives from size, per direction). Two devices → mapped by
> `role` directly, switches deploy to `dual`. Real m/s values converted to
> integer fps (`ASCENT_M_TO_FT`, descent3d.js's own conversion constant,
> reused rather than duplicated) and run through the exact same
> clamp/Tripoli-35fps-warning treatment the rate editor's own manual-edit
> handler applies — a real rocket's real computed rate gets the identical
> scrutiny a hand-typed one does, not a silent bypass. New `applyDeployMode()`/
> `onDeployChanged()` (the latter extracted from the existing Single/Dual
> toggle's own click handler, now shared) apply the deploy-mode switch the
> same way a real click would, keeping the toggle buttons' own
> active-highlight and every deploy-dependent UI element in sync.
>
> Deliberately a **one-time seed, not a live override** — unlike apogee
> altitude (which genuinely reverts once `ASCENT_RESULTS` clears, since
> dial-mode apogee is a different concept entirely), a descent rate is
> normal user-editable state elsewhere in this app; pre-filling it from a
> real rocket should behave like any other edit (Fast/Slow preset, manual
> typing) — it stays put after the ascent panel closes, and remains
> hand-editable afterward exactly as before.
>
> **A real bug found and fixed during verification**: the Tripoli-35fps
> safety warning silently never appeared, even for a genuinely over-limit
> rate. Root cause: `buildRateEditor()` unconditionally resets the warning
> banner to hidden as part of its own rebuild (needed so a stale warning
> from an earlier edit doesn't linger) — `applyDescentDevices()` was
> calling `showRateWarning()` BEFORE that rebuild, so it got immediately
> clobbered. Fixed by tracking the over-limit flag locally and calling
> `showRateWarning()` after `buildRateEditor()`, not before.
>
> **Verified** via headless-Chromium (Playwright): a 2-device payload
> (drogue 21.37 m/s, main 6.95 m/s — the same real LOC-IV X2 numbers the
> rocketry-side doc's own worked example cites) correctly produced dual
> deploy at 70/23 fps, matching both the internal state AND the rate
> editor's own displayed input values; a 1-device payload switched to
> single-stage with the drogue input correctly disabled; a deliberately
> oversized main rate (49fps raw) correctly triggered the safety warning
> and clamped display to 35fps; a payload with no `descentDevices` field
> at all left `state.deploy`/`state.rateFps` completely unchanged
> (backward compatible); and — the real point of the whole feature —
> `zoneFor()`'s own output points differ before/after applying real
> descent rates, confirming the landing zone itself actually changes, not
> just the displayed numbers. Zero console errors throughout.

> **Update 2026-08-24 (1)**: Reported directly — "when we get back data
> from rocketry for actual flights, the landing point popups aren't
> working. The apogee markers are working." Two independent bugs, both
> tracing back to the `ASCENT_RESULTS` single-zone-override work, neither
> touching the apogee markers (`drawPredictedApogeeMarker()`, which reads
> `ascentPathForModel()` directly, not `zoneFor()`).
>
> **Bug 1 — `isPointVisible()` (`app.js`)**: its byAltitude branch only
> exempted `state.customAlt` from the `selectedAlts` ladder-rung check
> (2000/4000/6000/8000/10000ft) — its own comment already documents why: a
> `customAlt` value is "essentially never a member of `selectedAlts`,"
> since that Set only ever holds the discrete ladder's own rungs. A real
> sim apogee has the exact same problem and never got the same exemption.
> `applyIsolation()` (marker *visibility*) already had this bypass; only
> `isPointVisible()` (marker *tooltip content*, used by `showTooltip()`'s
> `nearby` filter) was missing it — so for nearly every real flight (any
> apogee not landing exactly on a rung), the marker drew fine but hovering
> it opened a tooltip box with **zero content**. Fixed by adding the same
> `!!ASCENT_RESULTS` bypass already used in `applyIsolation()`.
>
> **Bug 2 — `zoneFor()`/`descentPathsFor()` (`app.js`)**: both skip
> computing anything at all when `deploy === 'single' && altitudeFt >
> single_deploy_max_alt_ft` (10,000ft), mirroring
> `compute_splash_points()`'s own server-side skip — a guardrail for the
> generic dial's assumed single-deploy altitude range, not a real hardware
> limit. Since `applyDescentDevices()` (Task 13) sets `state.deploy` from
> rocketry's own real device count, a real single-device flight legitimately
> flying past 10,000ft (common on single-deploy-at-apogee L2/L3 builds at
> high-waiver sites) is real, not an operator mistake — produced **zero**
> zone-groups/points at all, not just an empty tooltip. Fixed by bypassing
> the cap in both functions whenever `ASCENT_RESULTS` is active; the
> ordinary (no-sim) dial path is untouched.
>
> **Verified** via headless-Chromium with a synthetic `rocketry:ascentResults`
> payload: before the fix, a dual-deploy flight with a non-round apogee
> (3,000ft) rendered its 6 landing points but opened a blank tooltip; a
> single-device flight with a 12,000ft apogee rendered zero zone-
> groups/points. After both fixes, both cases render fully populated
> tooltips. Confirmed no regression: a manual (non-sim) single-deploy pick
> with `customAlt` above 10,000ft is still correctly suppressed, and
> ordinary ladder/`customAlt` tooltips are unchanged.

## Explicitly out of scope for this plan

- Anything inside the `rocketry` repo itself (the new embed route,
  URL-param wind loading, the `postMessage` emit call) — a separate repo,
  separate session, this plan only specifies the contract it needs to
  satisfy.
- Feeding the sim's ascent path into the descent-side drift Monte Carlo
  (`simulateDrift()` still starts from a fixed `x=y=0` at apogee) —
  boost-phase visualization only, per the user's original "in place of the
  rail angle and direction, for now" framing.
- A silent/automatic default simulation on page load (explicitly declined
  — interactive-only, see Context).
