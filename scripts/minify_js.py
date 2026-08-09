#!/usr/bin/env python3
# Regenerates site/assets/js/app.min.js and descent3d.min.js from their
# source files. Run by the Pages deploy workflow (.github/workflows/
# pages.yml) on every push to main -- never committed itself, so it's
# always built fresh off whatever the source currently says, the same way
# that workflow's own cache-busting version query string is generated at
# deploy time rather than checked in.
#
# descent3d.js added here 2026-08-09 -- it existed unminified AND
# unversioned in production until now (pages.yml's own sed only ever
# rewrote assets/js/app.js's reference, never descent3d.js's -- a real gap
# found while chasing an unrelated local-dev caching report, confirmed
# directly against this script and that sed command, not assumed).
import pathlib
import rjsmin

ROOT = pathlib.Path(__file__).resolve().parent.parent
JS_DIR = ROOT / "site/assets/js"

for name in ("app.js", "descent3d.js"):
    src_path = JS_DIR / name
    out_path = JS_DIR / (name.removesuffix(".js") + ".min.js")
    src = src_path.read_text()
    minified = rjsmin.jsmin(src)
    out_path.write_text(minified)
    orig_bytes = len(src.encode("utf-8"))
    min_bytes = len(minified.encode("utf-8"))
    print(f"{name}: {orig_bytes} -> {min_bytes} bytes ({min_bytes / orig_bytes:.0%})")
