"""Grid-edge diagnostic: where each site sits within each wind-profile
model's own native grid cell.

Every model on Open-Meteo lives on its own regular lat/lon grid (different
spacing, different origin -- none of them line up with each other), and
Open-Meteo snaps a query to the nearest grid node, returning that node's
real latitude/longitude in the response. A site sitting near the middle of
its cell is well-represented by that node; a site sitting near an edge or
corner is close enough to a neighboring cell that a real forecast
difference between the two could matter, and this app currently has no way
to notice that -- it always just uses whichever single node Open-Meteo
picked.

Requested directly, using argonia's own AIRFest weekend as motivation:
"check if there are gps x,y coords and span or something for the grid
squares each of our launch sites sits in." This is a read-only diagnostic
report, not wired into the live pipeline -- rerun by hand
(`python grid_position_report.py`) after adding a site, or if a model
provider changes its native grid resolution (which would silently make
MODEL_GRID_SPACING_DEG below wrong -- see its own comment for how to
re-measure it).
"""

import math

import requests

import config

# Empirically measured (not the nominal published resolution -- Open-Meteo
# doesn't necessarily serve what a model's docs claim; this repo's own
# config.py has hit that before, see PRESSURE_LEVEL_MASTER_MB's comment).
# Measured by sweeping latitude/longitude in 0.005 deg steps from a
# mid-continent reference point (argonia) and finding where the API's own
# returned grid latitude/longitude jumps to the next node. gfs/gem/icon/
# arpege/ecmwf are plain regular lat/lon grids (spacing is the same
# everywhere); hrrr is a ~3km Lambert-conformal grid reprojected onto
# lat/lon, so its degree-spacing isn't square -- lon spacing widens at
# higher latitudes in real km terms even though the degree value here is
# fixed, which %x below doesn't correct for (informational only, not worth
# the complexity for a diagnostic).
MODEL_GRID_SPACING_DEG = {
    "gfs": (0.11719, 0.11719),      # (lat_deg, lon_deg)
    "ecmwf": (0.25, 0.25),
    "gem": (0.15, 0.15),
    "icon": (0.125, 0.125),
    "arpege": (0.25, 0.25),
    "hrrr": (0.02698, 0.03386),
}

# Within this many percent of either edge (0 or 100) on EITHER axis --
# meaning within roughly half that margin's fraction of a full cell width
# of a real neighbor -- gets flagged. A judgment call, not a physical
# threshold; 15 was picked as "close enough that checking the neighbor
# cell by hand seems worthwhile," not derived from anything.
EDGE_FLAG_PCT = 15

KM_PER_DEG_LAT = 111.0


def grid_position(lat: float, lon: float, model_key: str) -> dict:
    """One site/model's real grid node (from Open-Meteo directly) plus this
    site's %x/%y position within that node's assumed cell (50/50 =
    centered on the node; 0 or 100 = right at the boundary with the next
    cell over)."""
    info = config.LIVE_MODELS[model_key]
    resp = requests.get(info["url"], params={
        "latitude": lat, "longitude": lon,
        "hourly": "wind_speed_10m", "models": info["model"], "forecast_days": 1,
    }, timeout=10)
    resp.raise_for_status()
    data = resp.json()
    if data.get("error"):
        return {"error": data.get("reason")}
    glat, glon = data["latitude"], data["longitude"]
    lat_spacing, lon_spacing = MODEL_GRID_SPACING_DEG[model_key]
    pct_x = 50 + ((lon - glon) / lon_spacing) * 100
    pct_y = 50 + ((lat - glat) / lat_spacing) * 100
    # Clamped to [0, 100] only for the distance estimate below -- a site
    # right at (or fractionally past, from MODEL_GRID_SPACING_DEG's own
    # measurement imprecision) a boundary should read as "~0km to the
    # edge," not a nonsensical negative distance.
    clamped_x, clamped_y = max(0, min(100, pct_x)), max(0, min(100, pct_y))
    km_to_lon_edge = min(clamped_x, 100 - clamped_x) / 100 * lon_spacing * KM_PER_DEG_LAT * math.cos(math.radians(lat))
    km_to_lat_edge = min(clamped_y, 100 - clamped_y) / 100 * lat_spacing * KM_PER_DEG_LAT
    return {
        "grid_lat": glat, "grid_lon": glon,
        "pct_x": pct_x, "pct_y": pct_y,
        "km_to_nearest_edge": min(km_to_lon_edge, km_to_lat_edge),
        "near_edge": min(pct_x, 100 - pct_x, pct_y, 100 - pct_y) < EDGE_FLAG_PCT,
    }


def run() -> None:
    print(f"{'site':22s} {'model':7s} {'grid node used':>22s} {'%x (lon)':>9s} {'%y (lat)':>9s} {'km to edge':>11s}")
    for site_id, site in config.SITES.items():
        for model_key in config.LIVE_PROFILE_MODELS:
            try:
                r = grid_position(site["lat"], site["lon"], model_key)
            except Exception as e:
                print(f"{site_id:22s} {model_key:7s}  ERROR: {e}")
                continue
            if "error" in r:
                print(f"{site_id:22s} {model_key:7s}  unavailable ({r['error']})")
                continue
            flag = "  <-- near edge/corner" if r["near_edge"] else ""
            node = f"({r['grid_lat']:.3f},{r['grid_lon']:.3f})"
            print(f"{site_id:22s} {model_key:7s} {node:>22s} {r['pct_x']:8.1f}% {r['pct_y']:8.1f}% "
                  f"{r['km_to_nearest_edge']:9.1f}km{flag}")


if __name__ == "__main__":
    run()
