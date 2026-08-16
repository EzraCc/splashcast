Status: in-progress
Priority: high
Type: new-feature
Last updated: 2026-08-15

# Rocketry flight-sim integration (embedded, cross-origin — no code sharing)

## Tasks

- [x] Task 1 — "Simulate ascent path" button + modal markup (`index.html`)
- [x] Task 2 — `ROCKETRY_EMBED_BASE` config + iframe `src` builder (`app.js`)
- [x] Task 3 — `postMessage` listener + result wiring (`app.js`)
- [x] Task 4 — Generalize `?testAscent=1` prototype to real `ASCENT_RESULT` (`descent3d.js` + `app.js`) — includes a real fix found while generalizing: the actual `AscentResult` has no `summary.apogeeAltitudeFt` convenience field (that only existed in the old hand-built test fixture), so apogee altitude is now derived from the APOGEE waypoint's own `altitude` field directly.
- [x] CSS: modal, button, `.rail-angle-control.sim-active` (renamed from `.test-ascent-disabled`)
- [x] Static verification: JS brace/paren balance (no Node runtime available), no duplicate/dangling DOM ids, served content confirmed live via local dev server, CHANGELOG entry added
- [ ] Rocketry-side "embed mode" itself — separate repo, out of scope here, contract already specified above
- [ ] Full interactive round-trip verification (real rocket/motor pick → live `postMessage` → renders correctly) — blocked until rocketry's own embed page exists
- [ ] `postMessage` origin-rejection test (mismatched origin) — blocked, same reason
- [ ] Delete the local `ascent-path-test.json` fixture once the real path is verified end-to-end

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
