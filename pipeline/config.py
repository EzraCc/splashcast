"""Shared constants for Splashcast's historical multi-model pull.

Named/versioned per the expansion spec's guidance to keep tunable parameters
out of hardcoded logic (see docs/spec.md, Phase 1 note applied here to the
historical-pull parameters too).
"""

from pathlib import Path

# splashcast/pipeline/ and splashcast/site/ are fixed siblings -- resolved via
# __file__ rather than left cwd-relative like DATA_DIR below, since anything
# that publishes into site/ (fetch_site_maps.py, splash_zones.py) crosses
# that boundary regardless of which directory it happens to be run from.
SITE_DIR = Path(__file__).parent.parent / "site"

SITE_ID = "hutto"
SITE_LAT = 30.614698
SITE_LON = -97.497814  # west-negative; convert to 0-360 for grid lookups

# --- Multi-site lookup (data/maps only for now -- not yet wired into the
# live pull / splash-zone pipeline, which is still Hutto-only via SITE_ID/
# SITE_LAT/SITE_LON above; see docs/spec.md §8) -----------
# Coordinates found 2026-07-17, each sourced from the operating club's own
# site (or, for Hearne, the public Hearne Municipal Airport/KLHB record that
# Tripoli Houston's own site points to as its launch location) -- not
# surveyed/independently confirmed on the ground. Re-verify against the
# club directly before using for anything safety-critical (waiver-boundary
# math, range setup).
#
# elev_m (added 2026-07-18, fixing a real bug -- see below): ground elevation
# in meters MSL at each site's lat/lon, from Open-Meteo's free elevation API
# (api.open-meteo.com/v1/elevation -- same no-key service already used
# elsewhere in this pipeline, backed by a digital elevation model, not
# surveyed). Used to convert pressure levels to AGL feet (splash_zones.py's
# build_profile_single()) and for the air-density descent-rate scaling
# (descent_rate_at()) -- both previously used a single Hutto-only constant
# (the old module-level SITE_ELEV_M, now removed) for every site, which was
# wrong for anywhere that isn't Hutto; worst case was Tripoli Houston South
# (~1m elevation) vs. SD Rocket Jockies (~499m) being treated as the same
# ground level. Hutto's own value (197.0) matches the API exactly, which is
# what gave confidence to trust it for the rest.
SITES = {
    "hutto": {
        # Corrected 2026-07-17 (user's call): waiver is 10,000ft AGL, not
        # 15,000ft -- the 15,000 figure was wrong.
        "name": "Hutto", "club": "AARG", "lat": SITE_LAT, "lon": SITE_LON,
        "waiver_ft": 10000, "elev_m": 197.0,
    },
    "seymour": {
        # "TNT" not the full "Tripoli North Texas" -- matches how the club
        # names itself elsewhere in this project (launch_schedule.py's "TNT
        # Seymour" events) and keeps the site-picker's "club - site" labels
        # to short acronyms where one exists (user's call 2026-07-17).
        "name": "Seymour, TX (Rocket Ranch)", "club": "TNT",
        "lat": 33.501037, "lon": -99.338722, "waiver_ft": 45000, "elev_m": 417.0,
        # Waiver upgraded from an earlier 42,000' figure -- confirmed current
        # (45,000' AGL, 4 NM radius) via TNT's own site as of 2026-07-17.
    },
    "apache_pass": {
        # Same club as Hutto -- both are AARG sites (see the grow-season/
        # off-season site-swap in launch_schedule.py). Kept as the short
        # "AARG" (matching hutto's) rather than the long form, so the two
        # sort/group together in the site-picker by club (user's call
        # 2026-07-17) instead of reading as two different clubs.
        "name": "Apache Pass", "club": "AARG",
        "lat": 30.680694, "lon": -97.142621, "waiver_ft": 10000, "elev_m": 123.0,
    },
    "hearne": {
        # Updated 2026-07-17: club-provided coordinate for the actual point
        # on the runway they always launch from, not the airport's overall
        # reference point (KLHB's official coordinate, ~1.2km away, used
        # until now).
        "name": "Hearne, TX (Hearne Municipal Airport / KLHB)", "club": "Tripoli Houston",
        "lat": 30.861145710845943, "lon": -96.6225689682861, "waiver_ft": 12000, "elev_m": 82.0,
    },
    "tripoli_houston_south": {
        # Added 2026-07-18. Coordinate is the launch-pad candidate found via
        # a groups.io thread WebFetch couldn't load directly (paywalled/402)
        # -- taken from search-result text only, not read firsthand. It's
        # ~15.8km from the club's own confirmed South Site *entrance* gate
        # (29.27389, -95.14123, from tripolihouston.com/news-updates), which
        # roughly matches the club's own "~5 miles of gravel/dirt roads from
        # highway to launch site" figure -- consistent with being the real
        # pad, but not independently confirmed. User's call to use it "for
        # now"; re-verify against the club directly before trusting it for
        # anything safety-critical.
        # waiver_ft: 17,500 AGL, confirmed on tripolihouston.com's own
        # homepage ("Current waiver is 17.5 ... FAA waiver of 17,500 feet").
        "name": "Houston South Site", "club": "Tripoli Houston",
        "lat": 29.222881, "lon": -95.097461, "waiver_ft": 17500, "elev_m": 1.0,
    },
    "argonia": {
        "name": "Argonia, KS (The Rocket Pasture)", "club": "KLOUDBusters",
        "lat": 37.17028, "lon": -97.73667, "waiver_ft": 50000, "elev_m": 384.0,
    },
    "gunter": {
        # Dallas Area Rocket Society (DARS) -- note the actual club name is
        # "Rocket Society" not "Rocketry Group" (user's shorthand when this
        # was requested 2026-07-17); DARS as an acronym works for either.
        # Coordinates from DARS's own site (dars.org/Site-Gunter-Modroc.html)
        # -- its Google Maps short link resolves to 33.438004, -96.803632,
        # matching the page's own description (north of Frisco, just inside
        # Grayson County, southwest of Gunter, TX). waiver_ft corrected
        # 2026-07-17 (user's call) to 6,000ft -- the actual altitude this
        # site needs, superseding the FAA-waiver-number convention every
        # other site here still uses (the 10,000ft FAA figure and the two
        # conflicting club-practical-ceiling figures noted below are now
        # historical context, not what's stored).
        "name": "Gunter, TX", "club": "DARS",
        "lat": 33.438004, "lon": -96.803632, "waiver_ft": 6000, "elev_m": 217.0,
    },
    "sd_rocket_jockies": {
        # Coordinates given directly by the user 2026-07-17, not independently
        # researched. Officially "Rocket Jockeys" elsewhere (NAR #785,
        # rocketryforum.com) -- spelled "Jockies" here per the user's own
        # explicit instruction for how this should display, not a typo carried
        # over by mistake. No distinct field/town name given -- "name" reuses
        # the same string rather than guessing one (site-picker collapses the
        # club/name duplication, see siteLabel() in app.js).
        # waiver_ft: 14,000 AGL, per a club member's 2026-05-30 rocketryforum.com
        # post ("I was able to get a 14,000' waiver this year") -- up from
        # 8,000/9,000ft figures in earlier years; re-verify with the club before
        # relying on it for anything safety-critical, same caveat as every
        # other site here.
        # Coordinates corrected 2026-07-17 (user's call) to the exact launch
        # point -- ~200m west of the original figure, latitude essentially
        # unchanged.
        "name": "SD Rocket Jockies", "club": "SD Rocket Jockies",
        "lat": 44.5149338, "lon": -96.8551149, "waiver_ft": 14000, "elev_m": 499.0,
    },
}

# --- Pressure levels requested for winds aloft, per site --------------------
# Used to be one flat global (LEVELS_MB = [1000, 900, 800, 700, 650], sized to
# Hutto's waiver with a margin) applied to every site regardless of its own
# waiver -- wrong for anything taller (Seymour 45,000ft, Argonia 50,000ft
# never got real data anywhere near their actual ceiling) and wasteful for
# anything shorter (Gunter's 6,000ft waiver doesn't need levels reaching
# 12,000ft). Fixed 2026-07-18: PRESSURE_LEVEL_MASTER_MB below is a static
# hPa->approx-altitude table (ICAO standard atmosphere, sea-level reference --
# a few hundred ft of site-elevation error doesn't change which of these
# ~hundred/thousand-ft-spaced levels is nearest, so this doesn't need to be
# per-site the way splash_zones.py's actual wind-profile math is); every
# value in it was empirically confirmed (not just doc-page-sourced -- an
# earlier docs-only pass on ECMWF's ceiling turned out wrong) to return real,
# non-null wind data for every model in LIVE_PROFILE_MODELS at least as high
# as 100 hPa (~53,000ft) -- see docs/spec.md §9 for the full per-model probe
# results. levels_mb_for_site() below picks, for each of a site's own target
# apogee altitudes (altitudes_for_site()), the smallest available level whose
# altitude is at or above that target -- guarantees the profile actually
# reaches each target instead of falling just short of it.
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
# Saturdays sample the same local hour-of-day -- a fixed UTC hour would silently
# drift the local sample time by an hour across the DST boundary, which would
# bias the Phase 2.5 seasonal comparison (see docs/spec.md).
SITE_TZ = "America/Chicago"
TARGET_VALID_HOUR_LOCAL = 10

# All 4 profile models have a 00Z cycle every day, so lead times are anchored
# there for a consistent T-7 .. T-0 comparison across models.
ANCHOR_CYCLE_HOUR_UTC = 0
LEAD_DAYS = list(range(8))  # 0 (morning-of) through 7 (one week out)

# max_fxx = each model's real max forecast-hour reach for the 00Z anchor cycle
# specifically (some models extend further on 00/06/12/18Z runs than on their
# other cycles). A lead_days=7 pull needs fxx ~= 183-184h, which HRRR/RAP/NAM
# cannot reach regardless of file availability -- pull_historical.py uses this
# to skip those combinations instead of issuing a doomed request. Sourced from
# NOAA product descriptions; RAP's number assumes it follows the same
# 00/06/12/18Z-extended-cycle pattern as HRRR (not independently confirmed) --
# worth re-checking against the pull log if skips/failures look off near the
# boundary.
PROFILE_MODELS = {
    "hrrr": {"model": "hrrr", "product": "prs", "max_fxx": 48},
    "gfs": {"model": "gfs", "product": "pgrb2.0p25", "max_fxx": 384},
    "rap": {"model": "rap", "product": "awp130pgrb", "max_fxx": 39},
    "nam": {"model": "nam", "product": "conusnest.hiresf", "max_fxx": 60},
}

# Common archive window across all 4 profile models' AWS buckets (verified by
# listing each bucket directly on 2026-07-15): NAM starts latest at 2021-09-16.
# Enforced in pull_historical.py's __main__ as a floor on the requested start
# date, so an overly large `weeks` argument can't generate guaranteed-empty
# requests before this date.
ARCHIVE_START = "2021-09-18"  # first Saturday on/after NAM's bucket start

DATA_DIR = "data"

# --- Live forecast pull (pull_live_forecast.py) -----------------------------
# Separate from the historical Herbie/GRIB2 pull above: this hits Open-Meteo's
# free endpoints directly (JSON over HTTP, no API key, 10k calls/day) for the
# *current* forecast rather than archived data. Each model family lives on
# its own endpoint (not one shared URL) -- Open-Meteo hosts many national
# agencies' models this way, not just NOAA's.
#
# Model IDs and endpoints verified live on 2026-07-16/17 (docs prose has been
# wrong before in this project -- these came from testing each candidate
# string against the API, not from docs alone). RAP, HREF, and SREF do NOT
# exist anywhere on Open-Meteo (confirmed absent from the model list and by
# direct query), so the NOAA side tops out at GFS/HRRR/NAM/NBM.
LIVE_MODELS = {
    # "ncep_gfs_seamless" (not used here) silently splices in raw HRRR data for
    # near-term lead times -- found 2026-07-17 when GFS and HRRR returned
    # *identical* wind to the decimal at 3 consecutive hours in a real capture,
    # diverging normally once past HRRR's horizon. "seamless" blend products
    # do this by design (best available model per lead time), but it means
    # gfs_seamless is NOT independent of hrrr_conus early on -- would have
    # silently double-counted one model as two in any cross-model spread/
    # consensus math. ncep_gfs_global is the actual raw, non-blended GFS;
    # confirmed to diverge from HRRR at the same hour/level (19.4 vs 15.9 mph
    # at 700mb, 9am) and to still carry all the other variables we need
    # (cloud/precip/temp/cape/surface wind).
    "gfs": {"model": "ncep_gfs_global", "url": "https://api.open-meteo.com/v1/gfs"},
    "hrrr": {"model": "ncep_hrrr_conus", "url": "https://api.open-meteo.com/v1/gfs"},
    "nam": {"model": "ncep_nam_conus", "url": "https://api.open-meteo.com/v1/gfs"},
    "nbm": {"model": "ncep_nbm_conus", "url": "https://api.open-meteo.com/v1/gfs"},
    # Added 2026-07-17: other free national-agency models on Open-Meteo, each
    # independently confirmed to have real (non-null) pressure-level wind --
    # unlike NAM/NBM's live-side gap below, these give genuinely independent
    # winds-aloft sources (different agencies/physics, not just more NOAA).
    "ecmwf": {"model": "ecmwf_ifs025", "url": "https://api.open-meteo.com/v1/ecmwf"},
    "icon": {"model": "icon_global", "url": "https://api.open-meteo.com/v1/dwd-icon"},
    "arpege": {"model": "arpege_world", "url": "https://api.open-meteo.com/v1/meteofrance"},
    "gem": {"model": "gem_global", "url": "https://api.open-meteo.com/v1/gem"},
}

# Open-Meteo only exposes near-surface wind at these fixed heights regardless
# of source model -- NBM has no pressure-level profile here either (same
# limitation as the historical pull), so it's limited to these vs. the
# pressure-level models below.
LIVE_NBM_HEIGHTS_M = [10, 80, 120, 180]

# Winds aloft (pressure levels) are only real for these on the *live* side --
# checked 2026-07-16/17: NAM's wind_speed_*hPa fields are null across the
# whole profile via Open-Meteo (surface wind works fine for NAM, just not
# pressure levels), unlike the historical Herbie/GRIB2 pull where NAM's raw
# isobaric data is real -- a live-API-specific gap, not a NAM limitation in
# general. NBM never had pressure levels on either side. Don't assume the two
# pulls have matching level-availability per model.
LIVE_PROFILE_MODELS = ["gfs", "hrrr", "ecmwf", "icon", "arpege", "gem"]

# Coverage is NOT uniform across LIVE_PROFILE_MODELS -- re-checked 2026-07-18
# by directly probing the live API at every one of PRESSURE_LEVEL_MASTER_MB's
# 44 levels (not from docs pages, which turned out unreliable here -- Open-
# Meteo's ECMWF docs page said its ceiling was 50 hPa, but the live API
# actually returns real, non-null wind at 10 hPa too; always verify against
# the API directly for anything this decision-relevant). Real (non-null)
# levels per model, of the 44:
#   gfs:     44/44 (all of them, down to 10 hPa / ~85,000ft)
#   hrrr:    38/44, down to 50 hPa / ~67,500ft
#   arpege:  29/44, down to 10 hPa / ~85,000ft
#   gem:     28/44, down to 10 hPa / ~85,000ft
#   icon:    19/44, down to 30 hPa / ~78,000ft
#   ecmwf:   14/44, down to 10 hPa / ~101,000ft -- fewest levels, but not the
#            lowest ceiling; its levels are just sparser (1000/925/850/700/
#            600/500/400/300/250/200/150/100/50/10)
# Every model here clears every current site's waiver (Argonia's 50,000ft is
# the tallest) with real data, several with a lot of room to spare. Downstream
# code already treats a missing level as "that model didn't contribute at
# that altitude" (same handling as a model being beyond its forecast
# horizon), so sparser models (ECMWF, ICON) just contribute less to the
# winds-aloft profile than GFS/ARPEGE/GEM -- expected, not a bug.

# Launch-day window: 8am-5pm local. Flying itself typically runs 9am-3pm, but
# setup starts at 8am and cleanup can run past 3pm; NOA (the club) extends to
# 5pm when weather makes that necessary -- widened here so the pull covers the
# full day range that can actually matter, not just the nominal flying hours.
LAUNCH_WINDOW_START_HOUR_LOCAL = 8
LAUNCH_WINDOW_END_HOUR_LOCAL = 17

# Wind-agreement thresholds: a model's wind for a given hour/level is called
# out separately (rather than folded into the consensus group) if it isn't
# mutually within this of every other model in that group -- see
# _split_consensus() in pull_live_forecast.py.
#
# WIND_SPEED_AGREEMENT_MPH started at 4, chosen by eyeballing when only
# 2-4 (mostly NOAA) models were compared at the surface. Widened to 6 on
# 2026-07-17 after adding 4 more independent-agency models for winds aloft --
# at 4mph, real cross-model spread aloft (6 genuinely independent models
# legitimately disagree more than 2-4 NOAA models did) fragmented the output
# into noise (81 outlier-flags across 50 level/hour cells on a real capture).
# Swept 4/6/7/8mph against that same data: no value cleanly separates "real
# spread" from "one standout model" -- 6 was picked as a middle ground (cuts
# noise by ~40% vs. 4, still catches clear standouts like a model 6-8mph off
# from a tight cluster of the rest) rather than as a value with a principled
# derivation. Expect to revisit again as more captures accumulate.
WIND_DIR_AGREEMENT_DEG = 45
WIND_SPEED_AGREEMENT_MPH = 6

# Cloud-cover threshold is from Tripoli Unified Safety Code 9-5/9-6 (checked
# 2026-07-16): no launch through any altitude with >50% cloud coverage, and
# none into/through an actual cloud. No cloud-base/ceiling *altitude* rule
# exists in the codes -- coverage % at the transited altitude is what's
# actually regulated, which is convenient since Open-Meteo's `cloud_base`
# field returns null for every NCEP model (checked same day) -- not usable
# regardless. This constant isn't applied as a go/no-go yet (data-pull only,
# per user direction) -- it's kept here for when that logic gets built.
#
# NBM has no cloud_cover_low/mid/high breakdown either (always null, checked
# same day) -- only a single blended `cloud_cover` total, no altitude
# attribution. GFS/HRRR/NAM all support the by-layer fields fine.
CLOUD_COVER_NOGO_PCT = 50

# Texas A&M Forest Service's live per-county burn-ban list (plain text, UTF-16
# encoded, refreshed regularly, no auth) -- confirmed working 2026-07-16.
# County name must match its ALL-CAPS spelling in that feed exactly.
BURN_BAN_URL = "http://tfsfrp.tamu.edu/WILDFIRES/BURNBAN.txt"
BURN_BAN_COUNTY = "WILLIAMSON"

# --- Splash-zone drift calc (ad-hoc analysis, not yet a permanent script) ---
# Boost-phase uncertainty: apogee isn't fixed directly above the pad -- a
# non-vertical launch-rail angle plus real-world weathercocking means it can
# land anywhere within roughly a cone of this half-angle around vertical, so
# the descent-only splash zone (computed from wind alone) gets buffered
# outward by `apogee_ft * tan(angle)` before being called final. Deliberately
# picked below the safety code's actual 20-degree HP limit -- user's call
# 2026-07-17: nobody flies rail angle that extreme in practice, but flights
# aren't perfectly vertical either, so this is a "things happen" allowance,
# not the code's hard ceiling. Scales with altitude (small offset for a
# 1,000 ft flight, much larger for 9,000 ft), which is the point: the same
# angular uncertainty means more absolute drift the higher the rocket goes
# before that angle stops mattering.
#
# This is now only the *default* -- the viewer's boost-angle slider (added
# 2026-07-17) lets a user override it live per session without a new pull;
# this value just seeds that slider and is what a fresh, unadjusted pull
# bakes into buffer_hull_px/buffer_radius_ft. Lowered 15 -> 10 the same day,
# user's call, no reasoning beyond that given.
BOOST_ANGLE_OFF_VERTICAL_DEG = 10

# --- Splash-zone point-generation pipeline (splash_zones.py) ----------------
# Formalized from a one-off analysis script (see docs/spec.md
# §9) -- values unchanged from that script, just named/versioned per this
# file's own stated convention instead of living inline.
#
# Site elevation used to live here as a single Hutto-only constant
# (SITE_ELEV_M = 197.0) applied to every site -- fixed 2026-07-18, now
# per-site via SITES[site_id]["elev_m"]/elev_ft_for_site() below.
def elev_ft_for_site(site_id: str) -> float:
    return SITES[site_id]["elev_m"] * 3.28084


# Times of day the splash-zone viewer samples. Fixed across every capture/
# target-date/site by design, so the viewer's toggles don't need to vary per
# dataset.
SPLASH_HOURS_LOCAL = [9, 11, 13, 15]

# --- Per-site apogee altitude list ------------------------------------------
# Every site used to share one fixed list (1,000-9,000ft, 5 points) regardless
# of its actual waiver -- wrong at both ends: Apache Pass/DARS (10,000ft
# waivers) already sit within ~1,000ft of that list's top, while TNT/Argonia
# (45,000/50,000ft waivers) never got simulated anywhere near what they can
# actually fly (user's call 2026-07-17: "it makes no sense to go to 9k' for
# DARS... or to stop at 9k' for TNT"). Scaled to an even step across the
# whole waiver range next (2026-07-17 -> 07-18), which over-resolved the top
# of tall-waiver sites and under-resolved exactly where most real flights
# land: most flights apogee under 10,000ft, a smaller group in 10-20,000ft,
# very few above that (user's call 2026-07-18) -- so density now tapers by
# band instead of one uniform step, and it's a fixed list, not a formula:
# 2,000ft steps 2,000-10,000ft, then 13,500/17,000/20,000, then 5-10,000ft
# steps 25,000-50,000ft (2,000ft steps at that altitude would be
# indistinguishable/pointless -- almost nothing flies there at all, let
# alone needs 2,000ft resolution). altitudes_for_site() caps this master
# list to each site's own waiver_ft (points above it are dropped) and always
# appends the waiver itself as the final point if the capped list doesn't
# already end there exactly, so every site's profile still reaches its real
# legal ceiling even when it falls between two master-list points.
ALTITUDES_MASTER_FT = [2000, 4000, 6000, 8000, 10000, 13500, 17000, 20000, 25000, 30000, 40000, 50000]


def altitudes_for_site(site_id: str) -> list[int]:
    waiver_ft = SITES[site_id]["waiver_ft"]
    altitudes = [a for a in ALTITUDES_MASTER_FT if a <= waiver_ft]
    if not altitudes or altitudes[-1] != waiver_ft:
        altitudes.append(waiver_ft)
    return altitudes

# Single-deploy: one rate for the whole descent (narrow real-world range).
SINGLE_DEPLOY_RATES_FPS = {"10fps": 10.0, "20fps": 20.0}
# Above this altitude, single-deploy points are dropped from the sim entirely
# (user's call 2026-07-18) -- not a number found written into Tripoli's own
# Unified Safety Code (checked the full text 2026-07-18; the closest rule is
# §11-1's 35 ft/s max landing speed, which argues against high-altitude
# single-deploy practically -- a chute sized to hit that speed from 45-
# 50,000ft would drift for a very long time -- but doesn't set an altitude
# threshold itself). Treated as a real operational convention worth modeling
# even without a codified number behind it; re-verify if a specific
# prefecture's own local rule turns out to say otherwise.
SINGLE_DEPLOY_MAX_ALT_FT = 10000
# Dual-deploy: (drogue_fps, main_fps) pairs -- drogue extremes paired with
# main's corresponding extreme (not a fixed midpoint -- see Phase 1 note in
# docs/spec.md; this is what the original script actually ran,
# preserved as-is here).
DUAL_DEPLOY_RATES_FPS = {"slow": (80.0, 10.0), "fast": (100.0, 20.0)}
MAIN_DEPLOY_ALTITUDE_FT = 800.0
DESCENT_STEP_FT = 50.0
