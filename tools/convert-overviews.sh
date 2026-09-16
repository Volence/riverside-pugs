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
# Recaptured maps. A manifest here replaces the same map's manifest in SRC.
OVERRIDE=/home/volence/l4d/overviews/out4x
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
src, override = sys.argv[1], sys.argv[2]
manifests = {}
for directory in (src, override):
    if not os.path.isdir(directory):
        continue
    for name in sorted(os.listdir(directory)):
        if name.endswith(".layers.json"):
            manifests[name] = directory
for name in sorted(manifests):
    directory = manifests[name]
    with open(os.path.join(directory, name)) as fh:
        m = json.load(fh)
    for layer in m["layers"]:
        print("%s\t%s\t%s" % (directory, m["map"], layer["image"]))
' "$SRC" "$OVERRIDE"
)

# An overridden map drops every old webp first, since its new names differ.
# Every other map is encoded only when its webp is missing, so re-running this
# for one recaptured map leaves the other 21 byte-identical.
declare -A CLEARED=()
for row in "${WANTED[@]}"; do
  IFS=$'\t' read -r dir map name <<<"$row"
  base="${name%.png}"
  if [ "$dir" = "$OVERRIDE" ]; then
    if [ -z "${CLEARED[$map]:-}" ]; then
      rm -f "$OUT/${map}"_z*.webp
      CLEARED[$map]=1
    fi
    # Recaptured maps exist to be zoomed into, where quality 82 left visible
    # blotches in fine ground texture, so they spend more bytes on detail.
    magick "$dir/$name" -quality 90 "$OUT/$base.webp"
  elif [ ! -e "$OUT/$base.webp" ]; then
    magick "$dir/$name" -quality 82 "$OUT/$base.webp"
  fi
done

python3 "$REPO/tools/gen-overviews.py" "$SRC" "$REPO/src/mapOverviews.ts" --override "$OVERRIDE"
