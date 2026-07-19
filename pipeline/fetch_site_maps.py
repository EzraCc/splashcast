"""Satellite-map fetching for a launch site, from ArcGIS World Imagery (free, no key).

Re-runnable for any entry in config.SITES (see docs/spec.md §8).

Writes into config.SITE_DIR / "maps" -- the deployable site/ tree, not
pipeline/ -- since map images are always public, unlike the raw wind-capture
parquets in pipeline/data/.

Two images per site, matching Hutto's original convention:
  - "detail": a close-in, high-zoom crop for reading the splash zone against
    real terrain/roads.
  - "wide": a lower-zoom, larger-area crop for context once a zoomed-out
    drift scenario carries past the detail crop's edge.
Each also gets a resized+recompressed "_web.jpg" sibling (matching Hutto's
original long-edge/quality convention) -- the raw PNGs are tens of MB, fine
for local archival but not something a page should ever load directly; the
viewer's <image> elements point at the _web.jpg variants.

Box size scales with the site's waiver altitude relative to Hutto's (bigger
waiver -> bigger possible drift -> needs a bigger map), using Hutto's own
current detail/wide boxes as the baseline ratio rather than a hardcoded
constant, so re-running this after any future change to Hutto's own bounds
stays consistent automatically. Zoom level is chosen per box size (not
hardcoded to Hutto's zoom 17/14) to keep the tile count in the same
ballpark as Hutto's original fetch (~250-350 tiles/image) regardless of how
much bigger the box is -- Seymour/Argonia's ~3x-larger boxes would mean
~9x the tiles at a fixed zoom, which is both slow and more likely to hit
rate limits for no real benefit (a 45,000 ft-waiver map doesn't need
Hutto's close-in zoom 17 resolution over an area that much larger).

Also builds the non-satellite regional site-selector map (all of config.SITES
at once, roads/labels instead of imagery) -- see build_regional_map_image()
and refresh_regional_sites_metadata(). Those two are deliberately separate:
fetching the image needs network + is only ever necessary when a site is
added/moved; refreshing sites.json's has_data flags is a fast, local,
no-network check that splash_zones.py re-runs every time it processes a
target date, so a new site's first real pull flips it from gray to
colored on the picker map without anyone re-fetching tiles.
"""

import io
import json
import math
import time
from pathlib import Path

import requests
from PIL import Image, ImageDraw

import config

TILE_SIZE = 256
TILE_BUDGET = 350  # keep each image's tile count in Hutto's original ballpark
DETAIL_ZOOM_CANDIDATES = [17, 16, 15, 14]
WIDE_ZOOM_CANDIDATES = [14, 13, 12, 11]
DETAIL_WEB_LONG_EDGE = 1600  # matches Hutto's original _web.jpg convention
WIDE_WEB_LONG_EDGE = 900
WEB_JPEG_QUALITY = 85

MAPS_DIR = config.SITE_DIR / "maps"
DATA_DIR = config.SITE_DIR / "data"
# Raw satellite PNGs are tens of MB and never loaded by the page (only the
# resized _web.jpg siblings are) -- kept in pipeline/ as source material for
# regenerating _web.jpg later, not published under site/maps/.
RAW_MAPS_DIR = Path(config.DATA_DIR) / "maps_raw"


def lonlat_to_tile(lon: float, lat: float, zoom: int) -> tuple[float, float]:
    n = 2 ** zoom
    x = (lon + 180.0) / 360.0 * n
    lat_rad = math.radians(lat)
    y = (1.0 - math.log(math.tan(lat_rad) + 1 / math.cos(lat_rad)) / math.pi) / 2.0 * n
    return x, y


def tile_to_lonlat(x: float, y: float, zoom: int) -> tuple[float, float]:
    n = 2 ** zoom
    lon = x / n * 360.0 - 180.0
    lat_rad = math.atan(math.sinh(math.pi * (1 - 2 * y / n)))
    return lon, math.degrees(lat_rad)


def bbox_for(lat: float, lon: float, size_m: float) -> dict:
    """A square bounding box of side `size_m`, centered on (lat, lon)."""
    dlat = size_m / 111320
    dlon = size_m / (111320 * math.cos(math.radians(lat)))
    return {"lat_n": lat + dlat / 2, "lat_s": lat - dlat / 2, "lon_w": lon - dlon / 2, "lon_e": lon + dlon / 2}


def _tile_grid(bounds: dict, zoom: int) -> tuple[int, int, int, int]:
    x_w, y_n = lonlat_to_tile(bounds["lon_w"], bounds["lat_n"], zoom)
    x_e, y_s = lonlat_to_tile(bounds["lon_e"], bounds["lat_s"], zoom)
    return math.floor(x_w) - 1, math.floor(x_e) + 1, math.floor(y_n) - 1, math.floor(y_s) + 1


def pick_zoom(bounds: dict, candidates: list[int], tile_budget: int = TILE_BUDGET) -> int:
    """Highest-resolution zoom (from `candidates`, checked high to low) whose
    tile count for `bounds` doesn't exceed `tile_budget`."""
    for zoom in candidates:
        tx_min, tx_max, ty_min, ty_max = _tile_grid(bounds, zoom)
        n_tiles = (tx_max - tx_min + 1) * (ty_max - ty_min + 1)
        if n_tiles <= tile_budget:
            return zoom
    return candidates[-1]  # coarsest candidate, even if still over budget


def _fetch_and_crop(bounds: dict, zoom: int, service: str) -> tuple[Image.Image, callable]:
    """Fetch+stitch the tile grid covering `bounds`, crop to it exactly, and
    return (cropped_image, lonlat_to_px) where lonlat_to_px(lon, lat) maps
    into the *cropped* image's pixel space -- shared by fetch_satellite()
    (one marked site) and build_regional_map_image() (several)."""
    tx_min, tx_max, ty_min, ty_max = _tile_grid(bounds, zoom)
    grid_w, grid_h = tx_max - tx_min + 1, ty_max - ty_min + 1
    n_tiles = grid_w * grid_h
    print(f"  zoom {zoom}: {grid_w}x{grid_h} = {n_tiles} tiles")

    img = Image.new("RGB", (grid_w * TILE_SIZE, grid_h * TILE_SIZE))
    session = requests.Session()
    session.headers.update({"User-Agent": "splashcast-research/1.0 (personal rocketry club tool)"})

    ok = 0
    for tx in range(tx_min, tx_max + 1):
        for ty in range(ty_min, ty_max + 1):
            # ArcGIS tile REST convention: {level}/{row}/{column} = z/y/x
            url = f"https://server.arcgisonline.com/ArcGIS/rest/services/{service}/MapServer/tile/{zoom}/{ty}/{tx}"
            for attempt in range(3):
                try:
                    r = session.get(url, timeout=25)
                    if r.status_code == 200:
                        tile = Image.open(io.BytesIO(r.content)).convert("RGB")
                        img.paste(tile, ((tx - tx_min) * TILE_SIZE, (ty - ty_min) * TILE_SIZE))
                        ok += 1
                        break
                except Exception:
                    pass
                time.sleep(0.4)
            time.sleep(0.15)
    print(f"  fetched {ok}/{n_tiles} tiles")

    full_lon_w, full_lat_n = tile_to_lonlat(tx_min, ty_min, zoom)
    full_lon_e, full_lat_s = tile_to_lonlat(tx_max + 1, ty_max + 1, zoom)

    def lonlat_to_px_in_full(lon, lat):
        px = (lon - full_lon_w) / (full_lon_e - full_lon_w) * img.width
        py = (full_lat_n - lat) / (full_lat_n - full_lat_s) * img.height
        return px, py

    crop_x0, crop_y0 = lonlat_to_px_in_full(bounds["lon_w"], bounds["lat_n"])
    crop_x1, crop_y1 = lonlat_to_px_in_full(bounds["lon_e"], bounds["lat_s"])
    cropped = img.crop((int(crop_x0), int(crop_y0), int(crop_x1), int(crop_y1)))

    def lonlat_to_px(lon, lat):
        px, py = lonlat_to_px_in_full(lon, lat)
        return px - crop_x0, py - crop_y0

    return cropped, lonlat_to_px


def _make_web_jpg(png_path: Path, out_path: Path, max_long_edge: int) -> None:
    """Resized+recompressed sibling of a raw map PNG, for the page to actually load."""
    im = Image.open(png_path).convert("RGB")
    scale = max_long_edge / max(im.size)
    if scale < 1:
        im = im.resize((round(im.width * scale), round(im.height * scale)), Image.LANCZOS)
    im.save(out_path, "JPEG", quality=WEB_JPEG_QUALITY)
    print(f"  web jpg -> {out_path.name}: {im.size}")


def fetch_satellite(bounds: dict, zoom: int, out_path: Path, mark_site: tuple[float, float] | None = None, service: str = "World_Imagery") -> tuple[tuple[int, int], tuple[float, float] | None]:
    """service is any ArcGIS Online MapServer name on the same free tile REST
    API -- "World_Imagery" for satellite (the per-site detail/wide maps)."""
    cropped, lonlat_to_px = _fetch_and_crop(bounds, zoom, service)

    site_px_crop = None
    if mark_site:
        site_px_crop = lonlat_to_px(mark_site[1], mark_site[0])
        draw = ImageDraw.Draw(cropped)
        r = max(6, cropped.width // 200)
        sx, sy = site_px_crop
        draw.ellipse([sx - r, sy - r, sx + r, sy + r], outline=(255, 40, 40), width=max(2, r // 3))
        draw.line([sx - r * 2, sy, sx + r * 2, sy], fill=(255, 40, 40), width=max(1, r // 4))
        draw.line([sx, sy - r * 2, sx, sy + r * 2], fill=(255, 40, 40), width=max(1, r // 4))

    cropped.save(out_path)
    print(f"  saved {out_path.name}: {cropped.size}")
    return cropped.size, site_px_crop


REGIONAL_DIR = MAPS_DIR / "regional"
REGIONAL_MAP_PATH = REGIONAL_DIR / "site_map.png"
REGIONAL_META_PATH = REGIONAL_DIR / "sites.json"
REGIONAL_ZOOM_CANDIDATES = [8, 7, 6, 5]
REGIONAL_PAD_FRACTION = 0.15  # keeps outermost sites off the image edge


def _site_has_data(site_id: str) -> bool:
    """Real check, not a hardcoded list: does this site have a non-empty
    published manifest? Flips automatically the first time splash_zones.py
    processes a target date for a new site -- see refresh_regional_sites_metadata()."""
    manifest_path = DATA_DIR / site_id / "manifest.json"
    if not manifest_path.exists():
        return False
    try:
        manifest = json.loads(manifest_path.read_text())
    except (json.JSONDecodeError, OSError):
        return False
    return bool(manifest.get("launch_dates"))


def refresh_regional_sites_metadata() -> Path:
    """Recompute sites.json's has_data flags (and, defensively, marker pixel
    positions) against the *existing* regional map image -- no network call,
    safe to run every time splash_zones.py processes any target date. Requires
    build_regional_map_image() to have been run at least once already."""
    meta = json.loads(REGIONAL_META_PATH.read_text())
    img_w, img_h = meta["image_size_px"]
    bounds = meta["bounds"]
    lon_w, lon_e, lat_s, lat_n = bounds["lon_w"], bounds["lon_e"], bounds["lat_s"], bounds["lat_n"]

    def lonlat_to_px(lon, lat):
        px = (lon - lon_w) / (lon_e - lon_w) * img_w
        py = (lat_n - lat) / (lat_n - lat_s) * img_h
        return px, py

    for site_id, site in config.SITES.items():
        px, py = lonlat_to_px(site["lon"], site["lat"])
        meta["sites"][site_id] = {
            "name": site["name"], "club": site["club"],
            "lat": site["lat"], "lon": site["lon"], "waiver_ft": site["waiver_ft"],
            "px": [round(px, 1), round(py, 1)],
            "has_data": _site_has_data(site_id),
        }

    with open(REGIONAL_META_PATH, "w") as f:
        json.dump(meta, f, indent=2)
    return REGIONAL_META_PATH


def build_regional_map_image() -> Path:
    """Fetches the non-satellite (roads/labels) regional map spanning every
    config.SITES entry -- the site-picker's map itself. Network + tile-fetch,
    only needed when a site is added/moved (unlike refresh_regional_sites_metadata(),
    which is cheap/local and runs far more often)."""
    REGIONAL_DIR.mkdir(parents=True, exist_ok=True)
    lats = [s["lat"] for s in config.SITES.values()]
    lons = [s["lon"] for s in config.SITES.values()]
    lat_pad = (max(lats) - min(lats)) * REGIONAL_PAD_FRACTION
    lon_pad = (max(lons) - min(lons)) * REGIONAL_PAD_FRACTION
    bounds = {
        "lat_s": min(lats) - lat_pad, "lat_n": max(lats) + lat_pad,
        "lon_w": min(lons) - lon_pad, "lon_e": max(lons) + lon_pad,
    }
    zoom = pick_zoom(bounds, REGIONAL_ZOOM_CANDIDATES, tile_budget=80)

    print(f"=== regional site-selector map -- {len(config.SITES)} sites, zoom {zoom} ===")
    cropped, _ = _fetch_and_crop(bounds, zoom, service="World_Street_Map")
    cropped.save(REGIONAL_MAP_PATH)
    print(f"saved {REGIONAL_MAP_PATH.name}: {cropped.size}")

    meta = {
        "bounds": bounds, "image_size_px": list(cropped.size), "zoom": zoom,
        "service": "World_Street_Map (server.arcgisonline.com)",
        "fetched_at": time.strftime("%Y-%m-%d"),
        "sites": {},  # filled in by refresh_regional_sites_metadata()
    }
    with open(REGIONAL_META_PATH, "w") as f:
        json.dump(meta, f, indent=2)

    refresh_regional_sites_metadata()
    print(f"metadata -> {REGIONAL_META_PATH.name}")
    return REGIONAL_META_PATH


def build_site_maps(site_key: str) -> Path:
    site = config.SITES[site_key]
    lat, lon, waiver_ft = site["lat"], site["lon"], site["waiver_ft"]
    site_dir = MAPS_DIR / site_key
    site_dir.mkdir(parents=True, exist_ok=True)
    raw_dir = RAW_MAPS_DIR / site_key
    raw_dir.mkdir(parents=True, exist_ok=True)

    hutto_detail_m, hutto_wide_m = _hutto_baseline_m()
    factor = waiver_ft / config.SITES["hutto"]["waiver_ft"]
    detail_m, wide_m = hutto_detail_m * factor, hutto_wide_m * factor

    print(f"=== {site_key} ({site['name']}, {site['club']}) -- waiver {waiver_ft}ft, scale factor {factor:.2f}x Hutto ===")

    detail_png = raw_dir / "detail_sat.png"
    detail_bounds = bbox_for(lat, lon, detail_m)
    detail_zoom = pick_zoom(detail_bounds, DETAIL_ZOOM_CANDIDATES)
    print(f"detail: {detail_m/1000:.1f}km box")
    detail_size, detail_site_px = fetch_satellite(detail_bounds, detail_zoom, detail_png, mark_site=(lat, lon))
    _make_web_jpg(detail_png, site_dir / "detail_sat_web.jpg", DETAIL_WEB_LONG_EDGE)

    wide_png = raw_dir / "wide_sat.png"
    wide_bounds = bbox_for(lat, lon, wide_m)
    wide_zoom = pick_zoom(wide_bounds, WIDE_ZOOM_CANDIDATES)
    print(f"wide: {wide_m/1000:.1f}km box")
    wide_size, _ = fetch_satellite(wide_bounds, wide_zoom, wide_png, mark_site=None)
    _make_web_jpg(wide_png, site_dir / "wide_sat_web.jpg", WIDE_WEB_LONG_EDGE)

    # Road/street layer: same bounds/zoom as the satellite crops above, just
    # World_Street_Map instead of World_Imagery (same ArcGIS service the
    # regional site-picker map uses, see build_regional_map_image()), so it's
    # pixel-aligned with its satellite sibling and the viewer can toggle
    # between them without recomputing anything (same viewBox, same site_px).
    # Some sites (e.g. Hutto) have no real terrain features to avoid, where
    # satellite imagery is closer to visual noise than useful signal.
    detail_road_png = raw_dir / "detail_road.png"
    detail_road_size, _ = fetch_satellite(detail_bounds, detail_zoom, detail_road_png, mark_site=(lat, lon), service="World_Street_Map")
    _make_web_jpg(detail_road_png, site_dir / "detail_road_web.jpg", DETAIL_WEB_LONG_EDGE)

    wide_road_png = raw_dir / "wide_road.png"
    wide_road_size, _ = fetch_satellite(wide_bounds, wide_zoom, wide_road_png, mark_site=None, service="World_Street_Map")
    _make_web_jpg(wide_road_png, site_dir / "wide_road_web.jpg", WIDE_WEB_LONG_EDGE)

    meta = {
        "site_lat": lat, "site_lon": lon,
        "detail": {"bounds": detail_bounds, "image_size_px": list(detail_size), "site_px": list(detail_site_px), "zoom": detail_zoom},
        "wide": {"bounds": wide_bounds, "image_size_px": list(wide_size), "zoom": wide_zoom},
        "source": "ArcGIS World Imagery (server.arcgisonline.com)",
        "road_source": "ArcGIS World Street Map (server.arcgisonline.com)",
        "fetched_at": time.strftime("%Y-%m-%d"),
    }
    out_path = site_dir / "site.json"
    with open(out_path, "w") as f:
        json.dump(meta, f, indent=2)
    print(f"metadata -> {site_key}/{out_path.name}\n")
    return out_path


def _hutto_baseline_m() -> tuple[float, float]:
    """(detail_box_m, wide_box_m) implied by Hutto's own current bounds."""
    meta = json.loads((MAPS_DIR / "hutto" / "site.json").read_text())
    lat = meta["site_lat"]

    def box_size_m(bounds):
        dlat_m = (bounds["lat_n"] - bounds["lat_s"]) * 111320
        dlon_m = (bounds["lon_e"] - bounds["lon_w"]) * 111320 * math.cos(math.radians(lat))
        return (dlat_m + dlon_m) / 2  # average -- boxes are near-square already

    return box_size_m(meta["detail"]["bounds"]), box_size_m(meta["wide"]["bounds"])


if __name__ == "__main__":
    import sys

    args = sys.argv[1:]
    if args == ["--regional"]:
        build_regional_map_image()
    else:
        keys = args or [k for k in config.SITES if k != "hutto"]
        for key in keys:
            if key not in config.SITES:
                raise SystemExit(f"unknown site {key!r} -- known: {list(config.SITES)}")
            build_site_maps(key)
