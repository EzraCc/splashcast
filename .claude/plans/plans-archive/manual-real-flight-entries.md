Status: done
Priority: medium
Type: new-feature
Last updated: 2026-10-10

# Manual real-flight entries

## Context

`analyze_manual()` (`pipeline/analyze_real_flight.py`) publishes a real
flight from headline facts alone -- apogee altitude, launch time, landing
GPS, optionally rail GPS + a known/reused descent config -- with no
barometric/GPS track required, unlike every other `analyze_*()` entry
point. First built 2026-09-07 for two hutto flights known only by hand.

## History

- 2026-09-07: built, used for two hutto/2026-09-05 flights.
- 2026-09-08: swept into an unrelated revert. The 3D real-flight-path
  feature built on top of it (separate commit) turned out broken with no
  time to fix, and the user asked to revert "before we added the manual
  actuals" -- `analyze_manual()` itself wasn't the problem, but the whole
  commit stack (including it and the two hutto flight records) got reverted
  together rather than picked apart. See CHANGELOG 2026-09-08.
- 2026-10-10: restored byte-for-byte from `git show 1f39fb2` (not
  rewritten) to publish a Pawhuska 2026-09-27 flight (98mm Alien
  Interceptor) reconstructed earlier the same day from a synthesized KML
  (GPS + dual-altimeter analysis, see that flight's own `pipeline/data/
  actuals/pawhuska/2026_09_27/` working files). Explicitly requested as the
  lightweight path ("the rest doesn't need to be re-engineered... skip the
  XLSX part") over building a new general-purpose NMEA+XLSX ingestor, which
  was in progress and discarded uncommitted. See CHANGELOG 2026-10-10.

## Decisions
- Real numbers for the Pawhuska flight were read directly off the
  synthesized KML's own placemark coordinates (not re-transcribed by hand a
  second time) -- the KML is the one place those figures had already been
  cross-checked (apogee/main-inflation altitude agreement across two
  independent altimeter boards, GPS position at each). Descent rates are
  the one exception: computed fresh via `splash_zones.air_density_ratio()`
  from the real event timing, since the KML itself carries no timestamps.
- The hutto flights this function originally published were themselves
  reverted and not recreated -- only the function came back, not that data.

## Open questions
(none)
