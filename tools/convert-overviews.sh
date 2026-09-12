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

# Convert only the layers a manifest actually names.
#
# The capture directory also holds experiments and superseded cuts: fullbright
# trials, zoom tests, a second capture at a height the manifest does not use.
# Globbing every PNG shipped four of those as web assets that nothing loads,
# and the duplicate cut sitting next to the one in use is worse than dead
# weight because it reads as a real layer. The manifests are the list of what
# is real, so take the list from them. Note this stops new orphans appearing;
# a layer DROPPED from a manifest still leaves its webp behind, and that one
# has to be deleted by hand.
mapfile -t WANTED < <(
  python3 -c '
import json, os, sys
src = sys.argv[1]
for name in sorted(os.listdir(src)):
    if not name.endswith(".layers.json"):
        continue
    with open(os.path.join(src, name)) as fh:
        for layer in json.load(fh)["layers"]:
            print(layer["image"])
' "$SRC"
)

for name in "${WANTED[@]}"; do
  base="${name%.png}"
  magick "$SRC/$name" -quality 82 "$OUT/$base.webp"
done

python3 "$REPO/tools/gen-overviews.py" "$SRC" "$REPO/src/mapOverviews.ts"
