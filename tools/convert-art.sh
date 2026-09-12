#!/usr/bin/env bash
# One-off conversion of shipped game art into web assets.
#
# The source is outside this repo and not redistributable game data we want to
# regenerate on every build, so the PNGs are committed and this script exists
# to document exactly where they came from.
#
# Map overviews used to be converted here too, from the ten Valve-shipped BMPs.
# They are superseded by real height-sliced captures from the game; see
# tools/convert-overviews.sh.
set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
PORTRAIT_SRC=/home/volence/Games/L4D-June-2008/L4D_June2008/left4dead/materials/vgui
VENV_PY=/home/volence/l4d/hud/.venv/bin/python

mkdir -p "$REPO/web/public/portraits"

# Portraits, straight out of the VTFs.
"$VENV_PY" - <<'PY'
import io, os
from srctools.vtf import VTF
from PIL import Image

SRC = '/home/volence/Games/L4D-June-2008/L4D_June2008/left4dead/materials/vgui'
OUT = os.path.abspath(os.path.join(os.getcwd(), 'web', 'public', 'portraits'))
NAMES = {
    's_panel_namvet': 'bill',
    's_panel_biker': 'francis',
    's_panel_manager': 'louis',
    's_panel_teenangst': 'zoey',
    's_panel_dead': 'dead',
}
os.makedirs(OUT, exist_ok=True)
for vtf_name, out_name in NAMES.items():
    with open(os.path.join(SRC, vtf_name + '.vtf'), 'rb') as fh:
        v = VTF.read(io.BytesIO(fh.read()))
    img = v.get().to_PIL().convert('RGBA')
    img.save(os.path.join(OUT, out_name + '.png'))
    print('wrote', out_name + '.png', img.size)

# A neutral stand-in for a version 1 replay, which does not record which
# survivor a player was. Drawn rather than sourced, because there is no
# "generic survivor" portrait in the game to take.
silhouette = Image.new('RGBA', (128, 128), (0, 0, 0, 0))
px = silhouette.load()
for y in range(128):
    for x in range(128):
        # Head circle plus shoulders, in the same washed grey the panels use.
        head = (x - 64) ** 2 + (y - 44) ** 2 < 26 ** 2
        body = y > 74 and (x - 64) ** 2 / 46 ** 2 + (y - 128) ** 2 / 60 ** 2 < 1
        if head or body:
            px[x, y] = (150, 150, 150, 255)
silhouette.save(os.path.join(OUT, 'unknown.png'))
print('wrote unknown.png')
PY
