"""Shared constants for Splashcast's historical multi-model pull.

Named/versioned per the expansion spec's guidance to keep tunable parameters
out of hardcoded logic (see docs/spec.md).
"""

from pathlib import Path

# Resolved via __file__, not left cwd-relative like DATA_DIR below -- anything
# that publishes into site/ (fetch_site_maps.py, splash_zones.py) crosses this
# boundary regardless of which directory it's run from.
SITE_DIR = Path(__file__).parent.parent / "site"

SITE_ID = "hutto"
# Pinned against the porta-potty/trailer visible on satellite imagery --
# ~510ft off the road from where this used to point, a more reliable
# landmark for the real rail setup spot.
SITE_LAT = 30.613928
SITE_LON = -97.496454  # west-negative; convert to 0-360 for grid lookups

# --- Per-site config ---------------------------------------------------------
# Coordinates are sourced from each club's own site/materials, not surveyed --
# re-verify before relying on one for anything safety-critical (waiver-boundary
# math, range setup). Per-field notes below only flag sourcing that's weaker
# than that baseline (a forum post, an unconfirmed placeholder, etc).
#
# elev_m: ground elevation (m MSL), from Open-Meteo's elevation API
# (api.open-meteo.com/v1/elevation, DEM-derived, not surveyed). Feeds
# pressure-to-AGL conversion and the air-density descent-rate scaling in
# splash_zones.py -- both need each site's real ground level, not a shared
# constant.
#
# cron_cutoff_hour_utc: last UTC hour the T-3..T-0 cron window should still
# pull for this site. Everything else in the pipeline runs on UTC directly;
# this is the one place local time matters (don't keep pulling once a launch
# day is functionally over). A fixed stored number rather than live DST math,
# biased to the later of CDT/CST's UTC-equivalent of "2pm local" (19:00/20:00
# UTC -> stored as 20) so a real last-pull opportunity is never missed -- the
# tradeoff is pulling slightly past 2pm local during CDT months.
#
# max_pad_move_ft: how far the viewer's draggable pad marker can move from
# the surveyed point (app.js's MAX_PAD_MOVE_FT, sent to the client via
# build_zone_data()'s output). 2000 by default -- generous enough for a real
# "set up on the other side of the field" adjustment without pretending to
# model an actually different site, while every model here is on a grid
# coarser than that anyway (HRRR, the finest, is ~3km/~9,800ft), so nothing
# within it could ever pull a different forecast value regardless of exact
# placement. Raised per-site only where a club's own real alternate pads
# (not just "try a nearby spot") sit further out than that.
SITES = {
    "hutto": {
        "name": "Hutto", "club": "AARG", "lat": SITE_LAT, "lon": SITE_LON,
        "waiver_ft": 10000, "elev_m": 197.0, "cron_cutoff_hour_utc": 20, "max_pad_move_ft": 2000,
    },
    "seymour": {
        "name": "Seymour, TX (Rocket Ranch)", "club": "TNT",
        "lat": 33.501037, "lon": -99.338722, "waiver_ft": 45000, "elev_m": 417.0, "cron_cutoff_hour_utc": 20, "max_pad_move_ft": 2000,
        # waiver_ft: 45,000ft AGL, 4 NM radius, per TNT's own site.
    },
    "apache_pass": {
        # AARG site, like Hutto (see the grow-season site swap in
        # launch_schedule.py) -- kept as "AARG" so the two group together in
        # the site-picker by club.
        "name": "Apache Pass", "club": "AARG",
        "lat": 30.680694, "lon": -97.142621, "waiver_ft": 10000, "elev_m": 123.0, "cron_cutoff_hour_utc": 20, "max_pad_move_ft": 2000,
    },
    "hearne": {
        # Club-provided coordinate for the actual launch point on the runway,
        # not KLHB's official airport reference point (~1.2km away).
        "name": "Hearne, TX (Hearne Municipal Airport / KLHB)", "club": "Tripoli Houston",
        "lat": 30.861145710845943, "lon": -96.6225689682861, "waiver_ft": 12000, "elev_m": 82.0, "cron_cutoff_hour_utc": 20, "max_pad_move_ft": 2000,
    },
    "tripoli_houston_south": {
        # waiver_ft: 17,500 AGL, per tripolihouston.com's homepage.
        # name is "South Site", not "Houston South Site" -- club is already
        # "Tripoli Houston", and siteLabel() in app.js joins them as
        # "{club} - {name}"; the longer form doubled up on "Houston" there.
        "name": "South Site", "club": "Tripoli Houston",
        "lat": 29.22320, "lon": -95.09726, "waiver_ft": 17500, "elev_m": 1.0, "cron_cutoff_hour_utc": 20, "max_pad_move_ft": 2000,
    },
    "argonia": {
        # Coordinate is the middle of the field, not the original figure --
        # the club runs "away" and "far away" pads that can sit up to
        # ~2,500ft east of it, so max_pad_move_ft is raised past the default
        # to actually reach them (with a little headroom).
        "name": "Argonia, KS (The Rocket Pasture)", "club": "KLOUDBusters",
        "lat": 37.166623, "lon": -97.738819, "waiver_ft": 50000, "elev_m": 382.0, "cron_cutoff_hour_utc": 20, "max_pad_move_ft": 3000,
    },
    "gunter": {
        # Dallas Area Rocket Society (DARS). waiver_ft is the club's actual
        # practical ceiling (6,000ft), not the FAA waiver number every other
        # site here stores.
        #
        # Coordinates moved ~2,000ft (user's own direct knowledge of the
        # field) from dars.org's figure, which is the gate, to the middle of
        # the field where setup actually happens -- the gate coordinate ate
        # nearly the entire default max_pad_move_ft budget on its own,
        # leaving no real room to try a different spot within the field.
        "name": "Gunter, TX", "club": "DARS",
        "lat": 33.435039, "lon": -96.8091009, "waiver_ft": 6000, "elev_m": 213.0, "cron_cutoff_hour_utc": 20, "max_pad_move_ft": 2000,
    },
    "sd_rocket_jockies": {
        # Coordinates and waiver given directly by the user, not independently
        # verified against the club. Spelled "Jockies" (vs. NAR's official
        # "Jockeys") per explicit instruction on display naming.
        "name": "SD Rocket Jockies", "club": "SD Rocket Jockies",
        "lat": 44.5149338, "lon": -96.8551149, "waiver_ft": 14000, "elev_m": 499.0, "cron_cutoff_hour_utc": 20, "max_pad_move_ft": 2000,
    },
}

# --- Pressure levels requested for winds aloft, per site --------------------
# PRESSURE_LEVEL_MASTER_MB is a static hPa->approx-altitude table (ICAO
# standard atmosphere, sea-level reference -- site-elevation error doesn't
# change which of these levels is nearest, so this table itself doesn't need
# to be per-site). Every level was empirically confirmed against the live API
# (not just docs -- doc pages have been wrong here before) to return real wind
# data for every model in LIVE_PROFILE_MODELS at least to 100 hPa (~53,000ft).
# levels_mb_for_site() requests every level up to a site's own ceiling (plus
# one above it), not just the levels nearest ALTITUDES_MASTER_FT's values --
# see that function's own docstring for why the two were deliberately
# decoupled (2026-08).
PRESSURE_LEVEL_MASTER_MB = [
    (1000, 364), (975, 1061), (950, 1773), (925, 2500), (900, 3243), (875, 4003),
    (850, 4781), (825, 5578), (800, 6394), (775, 7232), (750, 8091), (725, 8974),
    (700, 9882), (675, 10817), (650, 11780), (625, 12774), (600, 13801), (575, 14862),
    (550, 15962), (525, 17103), (500, 18289), (475, 19524), (450, 20812), (425, 22160),
    (400, 23574), (375, 25062), (350, 26631), (325, 28295), (300, 30065), (275, 31960),
    (250, 33999), (225, 36211), (200, 38662), (175, 41440), (150, 44647), (125, 48441),
    (100, 53084), (70, 60505), (50, 67506), (40, 72149), (30, 78135), (20, 86571),
    (15, 92557), (10, 100994),
]


def levels_mb_for_site(site_id: str) -> list[int]:
    """Every pressure level the models offer up to this site's own ceiling,
    plus the first one above it.

    Deliberately NOT derived from altitudes_for_site() any more (it was,
    through 2026-08): the apogee list is a user-facing sampling choice, while
    this is the actual vertical resolution of the wind field -- tying the
    second to the first threw away most of the real levels the models
    publish (e.g. Hutto only ever requested 5 of the 44 available), leaving
    interp() to linearly bridge gaps of 1,500-2,400ft and average real wind
    shear away.

    Ceiling is waiver_ft + this site's ground elevation, because
    PRESSURE_LEVEL_MASTER_MB's altitudes are MSL and waiver_ft is AGL -- the
    old AGL-vs-MSL mismatch here left at least one site's top requested level
    short of its own waiver in AGL terms.
    """
    ceiling_ft = SITES[site_id]["waiver_ft"] + elev_ft_for_site(site_id)
    levels = [lvl for lvl, alt in PRESSURE_LEVEL_MASTER_MB if alt <= ceiling_ft]
    above = [lvl for lvl, alt in PRESSURE_LEVEL_MASTER_MB if alt > ceiling_ft]
    if above:
        levels.append(above[0])  # table is ascending in altitude -- first one over the top
    return sorted(set(levels), reverse=True)

# NBM has no isobaric wind profile (post-processed guidance product, not a full
# 3D field model) -- only near-surface heights are available.
NBM_HEIGHTS_M = [10, 30, 80]

# Representative launch-window time: 10am *local* (Central) time, DST-aware.
# Kept as local time + zone rather than a fixed UTC hour so summer and winter
# Saturdays sample the same local hour-of-day.
SITE_TZ = "America/Chicago"
TARGET_VALID_HOUR_LOCAL = 10

# All 4 profile models have a 00Z cycle every day, so lead times are anchored
# there for a consistent T-7 .. T-0 comparison across models.
ANCHOR_CYCLE_HOUR_UTC = 0
LEAD_DAYS = list(range(8))  # 0 (morning-of) through 7 (one week out)

# max_fxx = each model's real max forecast-hour reach for the 00Z cycle
# specifically (some models extend further on 00/06/12/18Z runs than others).
# pull_historical.py uses this to skip lead/model combos beyond a model's
# reach instead of issuing a doomed request. Sourced from NOAA product
# descriptions; RAP's number assumes the same extended-cycle pattern as HRRR
# (not independently confirmed).
PROFILE_MODELS = {
    "hrrr": {"model": "hrrr", "product": "prs", "max_fxx": 48},
    "gfs": {"model": "gfs", "product": "pgrb2.0p25", "max_fxx": 384},
    "rap": {"model": "rap", "product": "awp130pgrb", "max_fxx": 39},
    "nam": {"model": "nam", "product": "conusnest.hiresf", "max_fxx": 60},
}

# Common archive window across all 4 profile models' AWS buckets: NAM starts
# latest, at 2021-09-16. Enforced in pull_historical.py's __main__ as a floor
# on the requested start date.
ARCHIVE_START = "2021-09-18"  # first Saturday on/after NAM's bucket start

DATA_DIR = "data"

# --- Live forecast pull (pull_live_forecast.py) -----------------------------
# Separate from the historical Herbie/GRIB2 pull above: hits Open-Meteo's free
# endpoints directly (JSON over HTTP, no API key) for the *current* forecast.
# Each model family lives on its own endpoint, not one shared URL -- Open-Meteo
# hosts many national agencies' models this way, not just NOAA's. Model IDs
# were verified live against the API, not taken from docs (which have been
# wrong here before). RAP/HREF/SREF don't exist on Open-Meteo -- the NOAA side
# tops out at GFS/HRRR/NAM/NBM.
LIVE_MODELS = {
    # ncep_gfs_global, not ncep_gfs_seamless: the "seamless" blend silently
    # splices in raw HRRR data for near-term lead times (best-available-model
    # per lead time, by design), which would double-count HRRR as two
    # "independent" models in any cross-model consensus/spread math. Confirmed
    # by finding GFS and HRRR returning identical wind to the decimal early in
    # a real capture, diverging normally once past HRRR's horizon.
    "gfs": {"model": "ncep_gfs_global", "url": "https://api.open-meteo.com/v1/gfs"},
    "hrrr": {"model": "ncep_hrrr_conus", "url": "https://api.open-meteo.com/v1/gfs"},
    "nam": {"model": "ncep_nam_conus", "url": "https://api.open-meteo.com/v1/gfs"},
    "nbm": {"model": "ncep_nbm_conus", "url": "https://api.open-meteo.com/v1/gfs"},
    # Other free national-agency models on Open-Meteo -- independently
    # confirmed to have real (non-null) pressure-level wind, giving genuinely
    # independent winds-aloft sources rather than more NOAA.
    "ecmwf": {"model": "ecmwf_ifs025", "url": "https://api.open-meteo.com/v1/ecmwf"},
    "icon": {"model": "icon_global", "url": "https://api.open-meteo.com/v1/dwd-icon"},
    "arpege": {"model": "arpege_world", "url": "https://api.open-meteo.com/v1/meteofrance"},
    "gem": {"model": "gem_global", "url": "https://api.open-meteo.com/v1/gem"},
}

# Open-Meteo only exposes near-surface wind at these fixed heights regardless
# of source model -- NBM has no pressure-level profile here either, so it's
# limited to these vs. the pressure-level models below.
LIVE_NBM_HEIGHTS_M = [10, 80, 120, 180]

# Winds aloft (pressure levels) are only real for these on the *live* side.
# NAM's wind_speed_*hPa fields are null across the whole profile via
# Open-Meteo (surface wind is fine) -- a live-API-specific gap, since the
# historical Herbie/GRIB2 pull's raw NAM isobaric data IS real. NBM has no
# pressure levels on either side. The two pulls don't have matching
# level-availability per model.
#
# Ordered by published forecast horizon, longest first (GFS 16 days, ECMWF
# 15, GEM 10, ICON 7.5, ARPEGE 4, HRRR ~2) -- matches app.js's
# MODEL_LEGEND_ORDER/MODEL_LABELS/MODEL_COLORS_HEX/MODEL_SHAPES exactly, so
# there's one canonical model order shared by the pipeline and the viewer
# instead of each picking its own.
LIVE_PROFILE_MODELS = ["gfs", "ecmwf", "gem", "icon", "arpege", "hrrr"]

# Coverage is NOT uniform across LIVE_PROFILE_MODELS -- confirmed by probing
# the live API directly at every PRESSURE_LEVEL_MASTER_MB level (docs proved
# unreliable here, e.g. ECMWF's docs claim a 50 hPa ceiling but the API
# actually returns real wind at 10 hPa). Real (non-null) levels per model, of
# the 44 in the master table:
#   gfs:     44/44, down to 10 hPa / ~85,000ft
#   hrrr:    38/44, down to 50 hPa / ~67,500ft
#   arpege:  29/44, down to 10 hPa / ~85,000ft
#   gem:     28/44, down to 10 hPa / ~85,000ft
#   icon:    19/44, down to 30 hPa / ~78,000ft
#   ecmwf:   14/44, down to 10 hPa / ~101,000ft -- sparser levels, not a lower
#            ceiling (1000/925/850/700/600/500/400/300/250/200/150/100/50/10)
# Every model clears every current site's waiver (Argonia's 50,000ft is the
# tallest) with real data. A missing level is treated as "that model didn't
# contribute at that altitude" (same as being beyond forecast horizon), so
# sparser models just contribute less to the winds-aloft profile -- expected,
# not a bug.

# Launch-day window: 8am-5pm local. Flying itself typically runs 9am-3pm, but
# setup starts at 8am and cleanup/weather delays can run past 3pm -- widened
# to cover the full day range that can actually matter.
LAUNCH_WINDOW_START_HOUR_LOCAL = 8
LAUNCH_WINDOW_END_HOUR_LOCAL = 17

# Rain-specific window for pull_live_forecast.py's rain_stats() -- 8am-5pm,
# a deliberately separate figure from LAUNCH_WINDOW_START/END_HOUR_LOCAL
# above (which also drives wind/cloud/temp/CAPE stats and day-over-day drift
# tracking in delta_report() -- not touched here, so changing this doesn't
# ripple into those). Starts at setup (8am, same reasoning as the general
# window) and now ends at 5pm again, matching SPLASH_HOURS_LOCAL's own
# 9am-5pm checkpoint span below -- this and that constant have swapped
# between 8am-4pm/9am-5pm a couple of times this same session chasing the
# right checkpoint parity; see SPLASH_HOURS_LOCAL's own comment for the
# final call (odd-hour majors, 8am kept reachable as a real minor tick
# rather than promoted to its own column).
RAIN_WINDOW_START_HOUR_LOCAL = 8
RAIN_WINDOW_END_HOUR_LOCAL = 17

# The hour (local) treated as "just before people start flying" -- a T-0
# same-day pull captured before this hour gets additionally frozen as a
# standalone morning snapshot (pull_live_forecast.py's save_capture()) so
# History mode's T-0 row (splash_zones.py's build_points_history()) can show
# "what the forecast looked like before launch" instead of whatever the
# continuously-updated same-day capture has drifted to by the time someone
# looks at it after flying. Deliberately its own constant, not
# RAIN_WINDOW_START_HOUR_LOCAL -- that one's about when rain accumulation
# starts mattering for go/no-go, a different question from "when did
# someone last check the forecast before flying."
MORNING_SNAPSHOT_HOUR_LOCAL = 9

# Wind-agreement thresholds: a model's wind for a given hour/level is called
# out separately (not folded into the consensus group) unless mutually within
# this of every other model in that group -- see _split_consensus() in
# pull_live_forecast.py. WIND_SPEED_AGREEMENT_MPH is 6, not a principled
# derivation -- 4mph worked with only 2-4 NOAA models compared at the surface,
# but fragmented into noise once 4 more independent-agency winds-aloft models
# were added (genuine cross-model spread reading as many separate outliers).
# 6 was chosen empirically as a middle ground; expect to revisit as more
# captures accumulate.
WIND_DIR_AGREEMENT_DEG = 45
WIND_SPEED_AGREEMENT_MPH = 6

# From Tripoli Unified Safety Code 9-5/9-6: no launch through any altitude
# with >50% cloud coverage, and none into/through an actual cloud -- coverage
# %, not a cloud-base altitude, is what's regulated (convenient, since
# Open-Meteo's `cloud_base` field is null for every NCEP model anyway). Not
# yet applied as a go/no-go (data-pull only) -- kept here for when that logic
# gets built. NBM has no low/mid/high breakdown, only a blended total;
# GFS/HRRR/NAM all support the by-layer fields.
CLOUD_COVER_NOGO_PCT = 50

# From Tripoli Unified Safety Code 9-3: "No rockets shall launch when the
# sustained surface winds exceed 20 MPH (32 KPH)." Verified directly against
# the primary-source USC PDF, not taken from a paraphrase. NAR's Model Rocket
# Safety Code (item 9) carries the same 20mph figure. Ground-level (10m AGL)
# SUSTAINED wind specifically -- not gust (Open-Meteo has no gust field at
# any level other than 10m, confirmed live, so there's no equivalent aloft
# number to cite here) and not winds-aloft (no codified limit exists for
# that; the drift-zone hull itself is the viewer's answer there). Like
# CLOUD_COVER_NOGO_PCT above, this is the one real cited number -- any
# additional display-only color breakpoints belong in the frontend, not
# here, so this file never implies a citation that doesn't exist.
WIND_SPEED_NOGO_MPH = 20

# Which of Open-Meteo's low/mid/high cloud bands (surface-9,800ft /
# 9,800-26,200ft / 26,200ft+) are actually relevant to display by default for
# each site's waiver -- shown collapsed to just these in the viewer, with the
# rest available (dimmed) via "Show all altitudes". Not a strict "waiver_ft >
# band ceiling" formula: Hutto/Apache Pass's 10,000ft waiver sits only ~200ft
# over the low/mid boundary (itself a rounded conversion of Open-Meteo's 3km
# cutoff), not meaningfully into Mid, so it's treated as a Low-only site
# rather than technically-also-Mid.
CLOUD_LAYERS_BY_SITE = {
    "hutto": ["low"],
    "apache_pass": ["low"],
    "gunter": ["low"],
    "hearne": ["low", "mid"],
    "tripoli_houston_south": ["low", "mid"],
    "sd_rocket_jockies": ["low", "mid"],
    "seymour": ["low", "mid", "high"],
    "argonia": ["low", "mid", "high"],
}

# Texas A&M Forest Service's live per-county burn-ban list (plain text,
# UTF-16 encoded, no auth). County name must match its ALL-CAPS spelling in
# that feed exactly.
BURN_BAN_URL = "http://tfsfrp.tamu.edu/WILDFIRES/BURNBAN.txt"
# Texas A&M Forest Service's feed is Texas-only and county-level -- there's no
# equivalent statewide, machine-readable burn-ban feed for Kansas (argonia) or
# South Dakota (sd_rocket_jockies): both states leave burn bans to individual
# county commissioners with no central aggregator, so there's nothing to point
# at. Sites simply absent from this dict get no burn-ban check at all (see
# pull_live_forecast.run()'s "supported" handling) instead of silently being
# checked against some other site's county.
#
# County names verified via FCC's Census Area API
# (geo.fcc.gov/api/census/area?lat=..&lon=..), not guessed from the site
# names -- Apache Pass and Gunter in particular sit in different counties
# than their nearest city name might suggest. Spelling/case matched to how
# BURNBAN.txt itself lists them (bare uppercase county name, no "COUNTY" suffix).
BURN_BAN_COUNTY_BY_SITE = {
    "hutto": "WILLIAMSON",
    "apache_pass": "MILAM",
    "hearne": "ROBERTSON",
    "tripoli_houston_south": "BRAZORIA",
    "gunter": "GRAYSON",
    "seymour": "BAYLOR",
}

# --- Splash-zone drift calc (ad-hoc analysis, not yet a permanent script) ---
# Boost-phase uncertainty: apogee isn't fixed directly above the pad -- a
# non-vertical rail angle plus real-world weathercocking means it can land
# anywhere within roughly a cone of this half-angle around vertical, so the
# descent-only splash zone (wind alone) gets buffered outward by
# `apogee_ft * tan(angle)`. Deliberately below the safety code's 20-degree HP
# limit -- a "things happen" allowance for near-vertical flights, not the
# code's hard ceiling. Scales with altitude by design: the same angular
# uncertainty means more absolute drift the higher the rocket goes.
#
# This is only the *default* -- the viewer's boost-angle slider lets a user
# override it live per session; this value just seeds that slider and is what
# an unadjusted pull bakes into buffer_hull_px/buffer_radius_ft.
BOOST_ANGLE_OFF_VERTICAL_DEG = 10

# --- Splash-zone point-generation pipeline (splash_zones.py) ----------------
# Formalized from a one-off analysis script (see docs/spec.md).
def elev_ft_for_site(site_id: str) -> float:
    return SITES[site_id]["elev_m"] * 3.28084


# Times of day the weather panel (Clouds/Rain/Wind/Temp columns) samples,
# and the map's time-slider's own labeled/major checkpoints -- fixed,
# deliberately sparse/curated so the table stays a handful of columns
# regardless of how much raw hourly data is actually available (see
# WIND_PROFILE_HOURS_LOCAL below for the denser figure the slider's minor
# ticks and blend-bracketing use instead). Back to 9/11/13/15/17 (this
# constant's own value earlier the same session briefly moved to
# 8/10/12/14/16, then reverted) -- per direction, the leftmost weather-panel
# column/major slider tick should always be 9am specifically, with 8am kept
# reachable as a real slider minor tick (see WIND_PROFILE_HOURS_LOCAL
# below), not promoted to its own labeled column.
SPLASH_HOURS_LOCAL = [9, 11, 13, 15, 17]

# Every hour the map's time-of-day slider can land on exactly (no blend
# needed) -- distinct from SPLASH_HOURS_LOCAL above, which stays sparse on
# purpose for the weather panel table. Both the live pull (Open-Meteo
# hourly data, already fetched in full -- pull_live_forecast.py) and the
# historical/actuals pull (HRRR f00 analysis via Herbie, real data for any
# hour it's asked for -- pull_historical.py) can supply real data at every
# one of these hours, not just SPLASH_HOURS_LOCAL's checkpoints; the
# splash-zone viewer only needs to *blend* (see analyze_real_flight.py's
# blend_wind_profiles/circular_blend, the same technique the client ports
# for the slider) across whatever gap remains between two of these, at most
# 1 hour instead of the old up-to-2-hour gap between SPLASH_HOURS_LOCAL
# checkpoints. Starts at 8am, one hour earlier than SPLASH_HOURS_LOCAL's own
# first checkpoint -- per direction, 8am should still be a real, selectable
# point on the slider (a minor tick), just not its own major/labeled column.
WIND_PROFILE_HOURS_LOCAL = list(range(8, 18))

# --- Per-site apogee altitude list ------------------------------------------
# ALTITUDES_MASTER_FT tapers in density by band rather than using one even
# step: most real flights apogee under 10,000ft, a smaller group in
# 10-20,000ft, very few above that, so resolution is concentrated where
# flights actually land instead of being uniform across a 2,000-50,000ft
# range. altitudes_for_site() caps this list to each site's own waiver_ft
# (points above it dropped) and always appends the waiver itself as the final
# point if the capped list doesn't already end there, so every site's profile
# reaches its real legal ceiling even between two master-list points.
#
# Density is bounded by PRESSURE_LEVEL_MASTER_MB, not chosen freely --
# validate_altitude_density() below checks every gap here against the models'
# real vertical resolution in that same band, so this never claims finer
# apogee resolution than the wind field actually supports. Round numbers, not
# the pressure table's own MSL altitudes converted to AGL: those come out
# site-specific and unreadable (e.g. 1,854ft at one site vs 1,990ft at
# another for the "same" level) and would break exact-match lookups like a
# published real-flight summary's altitude_bucket_used_ft. 10 of the previous
# 12 values survive verbatim here (all but 13,500/17,000).
ALTITUDES_MASTER_FT = [
    1000, 2000, 3000, 4000, 5000, 6000, 7000, 8000, 9000, 10000,   # 1,000ft steps -- where most flights apogee
    12000, 14000, 16000, 18000, 20000,                              # 2,000ft
    22500, 25000, 27500, 30000,                                     # 2,500ft
    35000, 40000, 45000, 50000,                                     # 5,000ft
]


def altitudes_for_site(site_id: str) -> list[int]:
    waiver_ft = SITES[site_id]["waiver_ft"]
    altitudes = [a for a in ALTITUDES_MASTER_FT if a <= waiver_ft]
    if not altitudes or altitudes[-1] != waiver_ft:
        altitudes.append(waiver_ft)
    return altitudes


def validate_altitude_density() -> list[str]:
    """Every ALTITUDES_MASTER_FT gap vs. the models' real vertical resolution
    in that same band (the tightest gap between the two PRESSURE_LEVEL_MASTER_MB
    altitudes bracketing the ladder gap's midpoint). Returns a list of
    violation descriptions (empty == fine). Not an import-time assert -- a
    cron pull shouldn't die on a curation question; run via `python config.py`
    or call this directly."""
    import bisect

    pressure_alts = sorted(alt for _, alt in PRESSURE_LEVEL_MASTER_MB)
    violations = []
    for lo, hi in zip(ALTITUDES_MASTER_FT, ALTITUDES_MASTER_FT[1:]):
        mid = (lo + hi) / 2
        i = bisect.bisect_left(pressure_alts, mid)
        lo_i = max(0, i - 1)
        hi_i = min(len(pressure_alts) - 1, lo_i + 1)
        local_model_res = pressure_alts[hi_i] - pressure_alts[lo_i]
        ladder_gap = hi - lo
        if ladder_gap < local_model_res:
            violations.append(
                f"{lo}-{hi}ft: ladder gap {ladder_gap}ft is finer than the models' "
                f"~{local_model_res}ft resolution there"
            )
    return violations

# Single-deploy: one rate for the whole descent (narrow real-world range).
# Keyed slow/fast, not a literal "10fps"/"20fps" (through 2026-08) -- once
# these numbers became viewer-editable (see app.js's rate editor), a label
# that says "10fps" while the actual value is something else the user typed
# would be a lie on screen. slow/fast take DUAL_DEPLOY_RATES_FPS's `main`
# component directly (single deploy is one canopy the whole way, i.e. the
# main, from apogee to ground) -- asserted equal in default_rates_fps_payload()
# below rather than left as a coincidence two dicts happen to share. This
# also repairs a latent bug: points_history.json's single-deploy keys used
# the old "10fps"/"20fps" names while the viewer's History mode looked up
# "slow"/"fast" regardless of deploy -- they never matched, so History was
# silently empty for Single. They match now.
SINGLE_DEPLOY_RATES_FPS = {"slow": 15.0, "fast": 20.0}
# Above this altitude, single-deploy points are dropped from the sim entirely.
# Not a number codified in Tripoli's Unified Safety Code -- the closest rule
# is §11-1's 35 ft/s max landing speed, which argues against high-altitude
# single-deploy practically (a chute sized to hit that speed from 45-50,000ft
# drifts for a very long time) but doesn't itself set an altitude threshold.
# Treated as a real operational convention worth modeling regardless.
SINGLE_DEPLOY_MAX_ALT_FT = 10000
# Dual-deploy: (drogue_fps, main_fps) pairs -- drogue extremes paired with
# main's corresponding extreme (not a fixed midpoint -- see Phase 1 note in
# docs/spec.md). Updated 2026-08-05 per user direction, replacing the
# original placeholder numbers with values closer to real observed rates
# -- these are still just the viewer's editable *defaults* now (see
# app.js's rate editor), not a hard constant, but worth keeping close to
# reality since most users won't bother changing them.
DUAL_DEPLOY_RATES_FPS = {"slow": (50.0, 15.0), "fast": (80.0, 20.0)}
MAIN_DEPLOY_ALTITUDE_FT = 800.0
DESCENT_STEP_FT = 50.0
# Bounds for the viewer's editable drogue/main fps number inputs -- input
# limits, not physics; the sim itself has no opinion on what's realistic.
# Main's ceiling is Tripoli USC §11-1's 35 ft/s max landing speed --
# enforced (per explicit user direction, 2026-08-05, overriding an earlier
# looser 60fps ceiling that treated it as just a design target) rather than
# left editable past it. app.js's rate editor shows a warning when a typed
# value gets clamped here specifically, not just silently reverts it.
RATE_INPUT_LIMITS_FPS = {"drogue": (20.0, 200.0), "main": (5.0, 35.0)}


def default_rates_fps_payload() -> dict:
    """{"fast": {"drogue": .., "main": ..}, "slow": {...}} -- the viewer's
    editable rate-editor defaults, and the single source of truth for the
    published JSON's descent_params.default_rates_fps. Asserts
    SINGLE_DEPLOY_RATES_FPS agrees with DUAL_DEPLOY_RATES_FPS's main
    component (see that dict's own comment) rather than trusting the two
    were kept in sync by hand."""
    out = {}
    for name, (drogue, main) in DUAL_DEPLOY_RATES_FPS.items():
        assert SINGLE_DEPLOY_RATES_FPS[name] == main, (
            f"SINGLE_DEPLOY_RATES_FPS[{name!r}]={SINGLE_DEPLOY_RATES_FPS[name]!r} "
            f"must equal DUAL_DEPLOY_RATES_FPS[{name!r}]'s main component ({main!r})"
        )
        out[name] = {"drogue": drogue, "main": main}
    return out


if __name__ == "__main__":
    violations = validate_altitude_density()
    if violations:
        print(f"{len(violations)} ALTITUDES_MASTER_FT density violation(s):")
        for v in violations:
            print(f"  - {v}")
    else:
        print("ALTITUDES_MASTER_FT: no density violations "
              f"({len(ALTITUDES_MASTER_FT)} altitudes, {len(PRESSURE_LEVEL_MASTER_MB)} pressure levels available).")
    for site_id in SITES:
        print(f"  {site_id}: {len(altitudes_for_site(site_id))} altitudes, "
              f"{len(levels_mb_for_site(site_id))} pressure levels")
