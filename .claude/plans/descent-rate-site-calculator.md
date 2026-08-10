Status: backlog
Priority: medium
Type: new-feature
Last updated: 2026-08-10

# Descent-rate site-elevation calculator

## Context

Raised directly (2026-08-10), during a review of the air-density math behind
descent rate scaling: `descent_rate_at()` (pipeline/splash_zones.py) /
`descentRateAt()` (app.js) both correctly use each site's real MSL elevation
when scaling a ground-level descent rate up through thinner air *at that one
site* -- that part isn't the gap. The gap is in what the rate *input* itself
means: `SINGLE_DEPLOY_RATES_FPS`/`DUAL_DEPLOY_RATES_FPS` (and any custom
typed value) are explicitly defined, per that module's own comment, as "the
rate you'd see on a low-altitude test drop **at this site's own ground**" --
site-relative by design, not a portable, sea-level-referenced constant. A
flyer who clocks a real descent rate at their home site and reuses that same
number at a different site's own field is implicitly telling the app "this
IS what my rig does at this new site's ground," which is only true if the
two sites happen to sit at the same elevation.

Confirmed with the user this mostly doesn't matter for local flying (most
people fly at one or a few home sites without much elevation spread) --
it's specifically a travel-meet problem: someone with real, trusted descent
data from their home site (e.g. Hearne, ~82m/~270ft) traveling to Airfest or
BALLS (both at meaningfully higher elevation) currently has no way to carry
that trusted number over correctly. Explicitly scoped down per direction:
**not** reworking how rates work generally, not automatic/implicit
conversion -- a standalone calculator widget near the existing rate
controls that a user opts into, explains why it matters, and does the
conversion math for them on request.

## Decisions made during planning

1. **Physics**: terminal velocity v ~ 1/sqrt(rho) (same relation
   `descent_rate_at()` already uses). Converting a rate recorded at site A to
   its equivalent at site B is one call: `rate_B = rate_A * sqrt(rho(elev_A)
   / rho(elev_B))`, both densities via the *existing*
   `air_density_ratio()`/`airDensityRatio()` (already MSL-correct, already
   ported 1:1 Python<->JS, no new physics to write or verify --see this
   session's own direct comparison confirming the JS/Python ports agree to
   <1e-6ft on real data). No sea-level intermediate needed explicitly; it
   cancels in the ratio the same way `descent_rate_at()`'s own ground/here
   ratio already does.

2. **Where it lives**: a small calculator UI near the existing Drogue/Main
   fps rate editor + Fast/Slow preset buttons (2D controls panel) -- not in
   the 3D-specific compact altitude control, not a new top-level mode. Two
   site pickers ("Recorded at" / "Flying at"), a short explanation of *why*
   this matters (reusing this plan's own Context framing -- rates are
   site-relative, not portable, worth surfacing directly rather than
   assuming users already know), a computed result, and an explicit
   "Apply" action that fills the existing rate fields the same way
   Fast/Slow already does -- no silent/automatic rewriting of whatever the
   user already typed.

3. **Done (2026-08-10): data-plumbing gap closed.** `fetch_site_maps.py`'s
   `refresh_regional_sites_metadata()` now publishes `"elev_ft":
   config.elev_ft_for_site(site_id)` per site, and `site/maps/regional/
   sites.json` has been regenerated with real values (e.g. hutto 646.3,
   tripoli_houston_south 3.3, sd_rocket_jockies 1637.1) -- confirmed present
   for all 8 sites. Every future `splash_zones.py` run refreshes this file
   automatically (it already calls `refresh_regional_sites_metadata()` on
   every target-date it processes), so no separate migration step is needed
   going forward. `regionalSites` (app.js) already fetches this whole file on
   load, so the calculator needs no new network request.

4. **No localStorage, for now** (direct instruction, 2026-08-10) --
   ~~persisting the user's last-used "recorded at" choice~~ is out of scope.
   Neither site picker gets special persistence; "Flying at" still defaults
   to whichever site is currently loaded in the main site picker (that part
   was never in question), "Recorded at" has no smart default -- reopen this
   as a real feature if it turns out to be real friction once this ships.

5. **Free-type recorded-rate fields, confirmed** (direct instruction,
   2026-08-10): the calculator needs its own editable drogue/main fps inputs
   for "what I actually recorded," not just a read-only display -- same
   free-type affordance the main rate editor already has, not a dropdown of
   presets. **Default population**: opening the calculator pre-fills these
   from whatever the main Drogue/Main fields currently hold (e.g. main
   fields already read 75/15 -> calculator's recorded-rate fields open
   already showing 75/15) -- *unless* the calculator has already computed a
   result this session, in which case reopening it must NOT stomp that
   in-progress calculation back to the main fields' raw values. Practically:
   the calculator needs its own small piece of state, seeded from
   `state.rateFps` once, that then stays independent of the main fields
   until the user explicitly re-syncs or types over it.

6. **Apply stores a "base" value for reset, confirmed** (direct instruction,
   2026-08-10): hitting Apply does two things, not one -- (a) overwrites the
   main Drogue/Main fps fields with the *calculated* (site-adjusted)
   numbers, same mechanism the Fast/Slow presets already use to fill those
   fields, and (b) separately remembers the *pre-conversion* recorded values
   (e.g. 75/15) as a distinct "base," so the user can later get back to
   their original recorded numbers without having to reopen the calculator
   and retype them. Needs new session state distinct from `state.rateFps`
   itself (e.g. a `state.rateBaseFps` holding the pre-conversion pair, or
   `null` when no calculation has been applied) and, most likely, a small
   "reset to recorded value" affordance surfaced once that base exists --
   lives inside the calculator panel itself (direct instruction, 2026-08-10),
   not a separate button near the main rate fields -- reopening the
   calculator is how you get back to your recorded 75/15 and re-Apply,
   rather than a standalone control living outside it. **If the user then
   edits the main Drogue/Main fields directly** (not via the calculator),
   that clears `state.rateBaseFps` (direct instruction, 2026-08-10) -- a
   manual edit means the previously-applied conversion no longer describes
   what's actually in those fields, so there's nothing valid left to reset
   back to. Whatever's typed becomes the new reality, full stop, same as any
   other manual rate edit today.

## Tasks

- [x] `fetch_site_maps.py`: add `elev_ft` to `refresh_regional_sites_metadata()`'s
      per-site output; regenerated `site/maps/regional/sites.json` directly
      (no network call needed) and confirmed real values for all 8 sites.
- [ ] Design the calculator's exact UI: "Recorded at" / "Flying at" site
      dropdowns (reuse `regionalSites`, already fetched client-side, now
      elevation-complete), explanatory copy, free-type drogue/main recorded-
      rate fields (single-deploy: main only), a Calculate step producing a
      computed preview, an Apply button. Default-population and Apply/base-
      value behavior specified in Decisions 5-6 above -- implement those
      exactly, not a simplified version.
- [ ] New session state: something like `state.rateBaseFps` (the pre-
      conversion recorded pair, `null` until Apply is first used, cleared
      again the moment the main Drogue/Main fields are edited directly) plus
      whatever the calculator's own in-progress recorded-rate fields need to
      survive being closed/reopened without resyncing to the main fields
      (Decision 5's "don't stomp an in-progress calculation" requirement).
      The existing main-field input handlers need a small addition to clear
      `rateBaseFps` on direct edit -- check they're not also fired
      programmatically by Apply itself, or Apply would immediately erase the
      base it just set.
- [ ] A reset affordance, inside the calculator panel itself, that restores
      the main Drogue/Main fields from `state.rateBaseFps` once it's set.
- [ ] Implement the conversion as a small pure function (JS, mirroring
      `descent_rate_at()`'s existing ratio math) -- `rateAtSite(rateFtps,
      fromElevFt, toElevFt)` or similar, unit-testable against the existing
      Python side the same way this session verified `simulateDrift()`
      against `simulate()`.
- [ ] Wire Apply to overwrite the existing rate fields, same mechanism
      Fast/Slow preset buttons already use (so it participates correctly in
      `invalidateZones()`'s cache-clearing, live map updates, etc. with no
      new code path).
- [ ] CHANGELOG entry + README update (new controls-panel feature) before
      any push, per repo convention.

## Open questions

- Exact copy for "why this matters" -- how much physics detail vs. a plain-
  language one-liner. Should probably lean plain-language given the
  existing app's disclaimer tone ("aid for planning, not legal advice"),
  but not decided.
