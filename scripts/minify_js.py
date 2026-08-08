#!/usr/bin/env python3
# Regenerates site/assets/js/app.min.js from app.js. Run by the Pages deploy
# workflow (.github/workflows/pages.yml) on every push to main -- never
# committed itself, so it's always built fresh off whatever app.js currently
# says, the same way that workflow's own cache-busting version query string
# is generated at deploy time rather than checked in.
import pathlib
import rjsmin

ROOT = pathlib.Path(__file__).resolve().parent.parent
SRC = ROOT / "site/assets/js/app.js"
OUT = ROOT / "site/assets/js/app.min.js"

src = SRC.read_text()
minified = rjsmin.jsmin(src)
OUT.write_text(minified)

orig_bytes = len(src.encode("utf-8"))
min_bytes = len(minified.encode("utf-8"))
print(f"{SRC.name}: {orig_bytes} -> {min_bytes} bytes ({min_bytes / orig_bytes:.0%})")
