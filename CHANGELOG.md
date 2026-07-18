# Changelog

Dated, terse log of notable changes. For the full design rationale and decision history, see [docs/spec.md](docs/spec.md).

## 2026-07-18

**Mobile UI**
- Map pan/zoom/pad-drag now work on touch (was mouse-only) — switched to Pointer Events, added pinch-to-zoom.
- Long always-visible info text (rail-buffer note, pad-drag hint) collapsed behind info buttons, matching the legend pattern.
- Mobile layout reordered (CSS Grid) so the altitude/model/rate legends land right after the map, before the longer notes.

**New sites**
- Added Tripoli Houston South Site (`tripoli_houston_south`, 17,500ft waiver) — coordinates unverified against the club directly, flagged for re-check. Scheduled 4th Saturday, every month (placeholder season, to be narrowed).
- Added SD Rocket Jockies to the launch schedule: 1st Saturday, April–October.

**Descent-rate physics**
- Descent rate now scales with air density at altitude (ICAO standard atmosphere) instead of being one constant fps for a whole descent phase — a drogue's real fall rate at 35,000ft is ~1.8x its rate below 5,000ft. Configured fps values are treated as each site's ground-level rate.
- Fixed a real bug found while building the above: site ground elevation was a single Hutto-only constant applied to every site. Now per-site (`config.SITES[site_id]["elev_m"]`, sourced from Open-Meteo's elevation API).
- Single-deploy points are no longer simulated above 10,000ft (dual-deploy unaffected) — not a realistic recovery config at altitude; no codified altitude threshold found in Tripoli's safety code, so this is a chosen convention, not a cited regulation.

**Per-site data pulls**
- Apogee altitude list redesigned: fixed tiered list (denser under 10k', coarser above) instead of one evenly-spaced formula, capped to each site's own waiver.
- Pressure levels requested for winds aloft are now sized per site's waiver (e.g. up to ~50,000ft for Argonia, ~6,000ft for Gunter/DARS) instead of one fixed ~12,000ft bracket for every site. Verified against the live Open-Meteo API (not just docs, which turned out wrong for ECMWF's real ceiling).
- All previously-published site/dates regenerated against every fix above.
