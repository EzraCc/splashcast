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
SITE_LAT = 30.614698
SITE_LON = -97.497814  # west-negative; convert to 0-360 for grid lookups

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
SITES = {
    "hutto": {
        "name": "Hutto", "club": "AARG", "lat": SITE_LAT, "lon": SITE_LON,
        "waiver_ft": 10000, "elev_m": 197.0, "cron_cutoff_hour_utc": 20,
    },
    "seymour": {
        "name": "Seymour, TX (Rocket Ranch)", "club": "TNT",
        "lat": 33.501037, "lon": -99.338722, "waiver_ft": 45000, "elev_m": 417.0, "cron_cutoff_hour_utc": 20,
        # waiver_ft: 45,000ft AGL, 4 NM radius, per TNT's own site.
    },
    "apache_pass": {
        # AARG site, like Hutto (see the grow-season site swap in
        # launch_schedule.py) -- kept as "AARG" so the two group together in
        # the site-picker by club.
        "name": "Apache Pass", "club": "AARG",
        "lat": 30.680694, "lon": -97.142621, "waiver_ft": 10000, "elev_m": 123.0, "cron_cutoff_hour_utc": 20,
    },
    "hearne": {
        # Club-provided coordinate for the actual launch point on the runway,
        # not KLHB's official airport reference point (~1.2km away).
        "name": "Hearne, TX (Hearne Municipal Airport / KLHB)", "club": "Tripoli Houston",
        "lat": 30.861145710845943, "lon": -96.6225689682861, "waiver_ft": 12000, "elev_m": 82.0, "cron_cutoff_hour_utc": 20,
    },
    "tripoli_houston_south": {
        # waiver_ft: 17,500 AGL, per tripolihouston.com's homepage.
        # name is "South Site", not "Houston South Site" -- club is already
        # "Tripoli Houston", and siteLabel() in app.js joins them as
        # "{club} - {name}"; the longer form doubled up on "Houston" there.
        "name": "South Site", "club": "Tripoli Houston",
        "lat": 29.22320, "lon": -95.09726, "waiver_ft": 17500, "elev_m": 1.0, "cron_cutoff_hour_utc": 20,
    },
    "argonia": {
        "name": "Argonia, KS (The Rocket Pasture)", "club": "KLOUDBusters",
        "lat": 37.17028, "lon": -97.73667, "waiver_ft": 50000, "elev_m": 384.0, "cron_cutoff_hour_utc": 20,
    },
    "gunter": {
        # Dallas Area Rocket Society (DARS). waiver_ft is the club's actual
        # practical ceiling (6,000ft), not the FAA waiver number every other
        # site here stores.
        #
        # Coordinates moved ~2,000ft (user's own direct knowledge of the
        # field) from dars.org's figure, which is the gate, to the middle of
        # the field where setup actually happens -- the gate coordinate ate
        # nearly the entire MAX_PAD_MOVE_FT drag budget (app.js) on its own,
        # leaving no real room to try a different spot within the field.
        "name": "Gunter, TX", "club": "DARS",
        "lat": 33.435039, "lon": -96.8091009, "waiver_ft": 6000, "elev_m": 213.0, "cron_cutoff_hour_utc": 20,
    },
    "sd_rocket_jockies": {
        # Coordinates and waiver given directly by the user, not independently
        # verified against the club. Spelled "Jockies" (vs. NAR's official
        # "Jockeys") per explicit instruction on display naming.
        "name": "SD Rocket Jockies", "club": "SD Rocket Jockies",
        "lat": 44.5149338, "lon": -96.8551149, "waiver_ft": 14000, "elev_m": 499.0, "cron_cutoff_hour_utc": 20,
    },
}

# --- Pressure levels requested for winds aloft, per site --------------------
# PRESSURE_LEVEL_MASTER_MB is a static hPa->approx-altitude table (ICAO
# standard atmosphere, sea-level reference -- site-elevation error doesn't
# change which of these levels is nearest, so this table itself doesn't need
# to be per-site). Every level was empirically confirmed against the live API
# (not just docs -- doc pages have been wrong here before) to return real wind
# data for every model in LIVE_PROFILE_MODELS at least to 100 hPa (~53,000ft).
# levels_mb_for_site() picks, for each of a site's target apogee altitudes,
# the smallest available level at or above that target, so the profile always
# reaches it.
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
    levels = []
    for alt in altitudes_for_site(site_id):
        candidates = [lvl for lvl, lvl_alt in PRESSURE_LEVEL_MASTER_MB if lvl_alt >= alt]
        chosen = min(candidates, key=lambda lvl: dict(PRESSURE_LEVEL_MASTER_MB)[lvl]) if candidates else PRESSURE_LEVEL_MASTER_MB[-1][0]
        if chosen not in levels:
            levels.append(chosen)
    return sorted(levels, reverse=True)

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
LIVE_PROFILE_MODELS = ["gfs", "hrrr", "ecmwf", "icon", "arpege", "gem"]

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

# Texas A&M Forest Service's live per-county burn-ban list (plain text,
# UTF-16 encoded, no auth). County name must match its ALL-CAPS spelling in
# that feed exactly.
BURN_BAN_URL = "http://tfsfrp.tamu.edu/WILDFIRES/BURNBAN.txt"
BURN_BAN_COUNTY = "WILLIAMSON"

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


# Times of day the splash-zone viewer samples. Fixed across every capture/
# target-date/site so the viewer's toggles don't need to vary per dataset.
SPLASH_HOURS_LOCAL = [9, 11, 13, 15]

# --- Per-site apogee altitude list ------------------------------------------
# ALTITUDES_MASTER_FT tapers in density by band rather than using one even
# step: most real flights apogee under 10,000ft, a smaller group in
# 10-20,000ft, very few above that, so resolution is concentrated where
# flights actually land instead of being uniform across a 2,000-50,000ft
# range. altitudes_for_site() caps this list to each site's own waiver_ft
# (points above it dropped) and always appends the waiver itself as the final
# point if the capped list doesn't already end there, so every site's profile
# reaches its real legal ceiling even between two master-list points.
ALTITUDES_MASTER_FT = [2000, 4000, 6000, 8000, 10000, 13500, 17000, 20000, 25000, 30000, 40000, 50000]


def altitudes_for_site(site_id: str) -> list[int]:
    waiver_ft = SITES[site_id]["waiver_ft"]
    altitudes = [a for a in ALTITUDES_MASTER_FT if a <= waiver_ft]
    if not altitudes or altitudes[-1] != waiver_ft:
        altitudes.append(waiver_ft)
    return altitudes

# Single-deploy: one rate for the whole descent (narrow real-world range).
SINGLE_DEPLOY_RATES_FPS = {"10fps": 10.0, "20fps": 20.0}
# Above this altitude, single-deploy points are dropped from the sim entirely.
# Not a number codified in Tripoli's Unified Safety Code -- the closest rule
# is §11-1's 35 ft/s max landing speed, which argues against high-altitude
# single-deploy practically (a chute sized to hit that speed from 45-50,000ft
# drifts for a very long time) but doesn't itself set an altitude threshold.
# Treated as a real operational convention worth modeling regardless.
SINGLE_DEPLOY_MAX_ALT_FT = 10000
# Dual-deploy: (drogue_fps, main_fps) pairs -- drogue extremes paired with
# main's corresponding extreme (not a fixed midpoint -- see Phase 1 note in
# docs/spec.md).
DUAL_DEPLOY_RATES_FPS = {"slow": (80.0, 10.0), "fast": (100.0, 20.0)}
MAIN_DEPLOY_ALTITUDE_FT = 800.0
DESCENT_STEP_FT = 50.0
