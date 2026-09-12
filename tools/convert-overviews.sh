#!/usr/bin/env bash
# Convert the generated map overviews into web assets and emit the layer manifest.
#
# The source PNGs are 2048x1271 and total about 256 MB, which is far too heavy to
# serve. WebP at quality 82 takes the set to roughly 27 MB with no visible loss:
# these are flat-lit top-down renders that are mostly void black, which is exactly
# what WebP is good at. Verified by eye on a round-tripped layer before choosing it.
#
# Both the images and the generated manifest are committed, so nothing here runs at
# build or deploy time. This script exists to document where they came from.
set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
SRC=/home/volence/l4d/overviews/out
OUT="$REPO/web/public/overviews"

mkdir -p "$OUT"
# The ten single-layer Valve BMP conversions are superseded by these.
rm -f "$OUT"/*.png

for f in "$SRC"/*.png; do
  base="$(basename "${f%.png}")"
  magick "$f" -quality 82 "$OUT/$base.webp"
done

python3 "$REPO/tools/gen-overviews.py" "$SRC" "$REPO/src/mapOverviews.ts"
