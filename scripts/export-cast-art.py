"""Export the caster studio's game art from the L4D1 client's pak01 into
web/public/cast-art/ (served at /cast-art/<name>.png).

- survivor-<name>.png: the released character-select portraits
  (materials/vgui/select_<name>.vtf), cropped to the face, 128 px.
- si-<class>.png: the game HUD's own infected team icons
  (materials/vgui/hud/zombieteamimage_<class>.vtf), 64 px.
- witch.png: L4D1 has no HUD icon for the witch; this is the witch figure
  from the "Don't awaken the witch" achievement art, cropped to the
  figure, 64 px.
- item-kit/pills/pipe/molotov.png: the game's own inventory glyphs, copied
  from web/src/hud/art (scripts/export-hud-art.py already exports them from
  the same pak01).

Run by hand from the repo root, with the HUD toolbox venv (vpk + srctools):

    /home/volence/l4d/hud/.venv/bin/python scripts/export-cast-art.py

Requires the game installed at the Steam path below. Never run on a server.
"""
import io
import os
import shutil

import vpk
from srctools.vtf import VTF

PAK = os.path.expanduser('~/.steam/steam/steamapps/common/left 4 dead/left4dead/pak01_dir.vpk')
OUT = os.path.join(os.path.dirname(__file__), '..', 'web', 'public', 'cast-art')

# (x, y, size) of the face in each 256x256 select portrait, picked by eye.
FACES = {
    'bill': (44, 26, 88),
    'zoey': (88, 24, 92),
    'francis': (84, 18, 96),
    'louis': (92, 18, 96),
}


def load(pak, path):
    v = VTF.read(io.BytesIO(pak.get_file(path).read()))
    v.load()
    return v.get().to_PIL().convert('RGBA')


def main() -> None:
    pak = vpk.open(PAK)
    os.makedirs(OUT, exist_ok=True)
    for name, (x, y, s) in FACES.items():
        img = load(pak, f'materials/vgui/select_{name}.vtf').crop((x, y, x + s, y + s)).resize((128, 128))
        img.save(os.path.join(OUT, f'survivor-{name}.png'))
    for cls in ('hunter', 'smoker', 'boomer', 'tank'):
        load(pak, f'materials/vgui/hud/zombieteamimage_{cls}.vtf').resize((64, 64)).save(os.path.join(OUT, f'si-{cls}.png'))
    # Cropped to the crouching figure so it still reads at pin size.
    load(pak, 'materials/vgui/achievements/l4d_achievement_dont_awaken_witch.vtf').crop((10, 8, 54, 52)).resize((64, 64)).save(os.path.join(OUT, 'witch.png'))
    art = os.path.join(os.path.dirname(__file__), '..', 'web', 'src', 'hud', 'art')
    for src, dst in (('medkit', 'kit'), ('pills', 'pills'), ('pipebomb', 'pipe'), ('molotov', 'molotov')):
        shutil.copyfile(os.path.join(art, f'icon-item-{src}.png'), os.path.join(OUT, f'item-{dst}.png'))


if __name__ == '__main__':
    main()
