#!/usr/bin/env python3
"""Rank emblems: one SVG per rank (Bronze III .. Master I) into web/public/ranks/.

    python3 scripts/rank-emblems.py           # SVGs only
    python3 scripts/rank-emblems.py --png DIR # also 1024px PNGs into DIR (video, Discord)

The art is from game-icons.net (CC BY 3.0); the icons are vendored in
scripts/rank-icons/ so the build never touches the network, and ICONS below
names the author of each. This script only composes them, colours them and
adds the division marks.

Each tier adds to the one below it, so the shape alone says how high a rank is:
every rank is a metal shield with the biohazard cut into it. Silver adds the
laurel wreath, Gold trades it for wings, Platinum crowns them, Diamond wears a
jewelled crown with a lit stone and Master puts a glowing star burst behind it
all. Pips under
the emblem are the division: III one, II two, I three. Colours match
.rankbadge--* in web/src/styles/app.css.
"""
import os
import re
import subprocess
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, 'web', 'public', 'ranks')
ICON_DIR = os.path.join(ROOT, 'scripts', 'rank-icons')

# key: (author, icon name, bbox of the drawn shape in the icon's 512 box,
# measured once by rendering the icon). File is rank-icons/<author>_<name>.svg.
ICONS = {
    'shield':    ('sbed',       'shield',           (106.0, 16.0, 406.0, 496.0)),
    'biohazard': ('lorc',       'biohazard',        (20.5, 41.5, 493.8, 453.8)),
    'laurels':   ('lorc',       'laurels',          (21.2, 18.0, 490.8, 494.0)),
    'wing':      ('delapouite', 'liberty-wing',     (25.0, 37.0, 487.0, 475.0)),
    'crown':     ('lorc',       'queen-crown',      (21.2, 59.2, 489.8, 425.2)),
    'jewel_crown':    ('delapouite', 'crenel-crown',     (27.8, 68.0, 484.2, 423.2)),
    'star':      ('delapouite', 'polar-star',       (19.8, 19.8, 492.2, 492.2)),
}

TIERS = [
    # name, base colour (= --rank-c), light, dark
    ('bronze',   '#c3804f', '#f0bb8c', '#5c3218'),
    ('silver',   '#b9c1c9', '#f2f5f8', '#4a525b'),
    ('gold',     '#e3b341', '#fff0b0', '#7a5410'),
    ('platinum', '#5fc9bd', '#d4fff8', '#1b5c55'),
    ('diamond',  '#6fa8ff', '#e0ecff', '#1f3f80'),
    ('master',   '#c88cff', '#f3e3ff', '#4f1f80'),
]
DIVISIONS = ['iii', 'ii', 'i']  # lowest first, as in src/seasonRules.ts

W, H = 160, 180
CX = 80
INK = '#14100c'  # the shared outline: near black, a touch warm
OUTLINE = 2.4    # outline width in emblem units (the viewBox is 160 wide)

_paths = {}

def icon_path(key):
    if key not in _paths:
        author, name, _ = ICONS[key]
        with open(os.path.join(ICON_DIR, f'{author}_{name}.svg')) as fh:
            svg = fh.read()
        # every game-icons file is a black 512 square then the white icon path
        ds = re.findall(r'<path[^>]*\sd="([^"]+)"', svg)
        _paths[key] = [d for d in ds if d != 'M0 0h512v512H0z']
    return _paths[key]

def f(n):
    return f'{n:.2f}'.rstrip('0').rstrip('.')

def place(key, cx, cy, w=None, h=None, flip=False, rot=0, d=None, **attrs):
    """The icon `key` fitted to width w (or height h, or both to stretch),
    centred on (cx, cy). `attrs` become SVG attributes; stroke_width is given
    in emblem units and scaled back so every outline matches. `d` draws that
    path instead of the icon, in the icon's own coordinates."""
    x0, y0, x1, y1 = ICONS[key][2]
    bw, bh = x1 - x0, y1 - y0
    sx = w / bw if w else h / bh
    sy = h / bh if h else sx
    if w and not h:
        sy = sx
    mx, my = (x0 + x1) / 2, (y0 + y1) / 2
    sw = attrs.pop('stroke_width', None)
    a = ''.join(f' {k.replace("_", "-")}="{v}"' for k, v in attrs.items())
    if sw is not None:
        a += f' stroke-width="{f(sw / min(sx, sy))}" stroke-linejoin="round" paint-order="stroke"'
    rt = f' rotate({f(rot)})' if rot else ''
    t = f'translate({f(cx)} {f(cy)}){rt} scale({f(-sx if flip else sx)} {f(sy)}) translate({f(-mx)} {f(-my)})'
    return ''.join(f'<path transform="{t}" d="{p}"{a}/>' for p in ([d] if d else icon_path(key)))

def pips(filled, on, off):
    """Division mark: three small diamonds, III fills one, I all three."""
    out = []
    for k in range(3):
        x, y = CX + (k - 1) * 20, 166
        d = f'M{f(x)} {f(y - 7)} L{f(x + 7)} {f(y)} L{f(x)} {f(y + 7)} L{f(x - 7)} {f(y)} Z'
        if k < filled:
            out.append(f'<path d="{d}" fill="{on}" stroke="{INK}" stroke-width="1.6" stroke-linejoin="round" paint-order="stroke"/>')
        else:
            out.append(f'<path d="{d}" fill="{INK}" fill-opacity="0.35" stroke="{off}" stroke-opacity="0.6" stroke-width="1.4" stroke-linejoin="round"/>')
    return out

# The stone inside crenel-crown's gem setting, traced in its 512 box, so
# Diamond and Master can light it up.
CROWN_STONE = 'M256 225 L293.5 290 L281 350 L268.5 359 L243.5 359 L231 347.5 L217.5 290 Z'

MOTIF = 'biohazard'

def emblem(t, division):
    name, base, light, dark = TIERS[t]
    gid = f'{name}{division}'
    defs = (f'<defs>'
            f'<linearGradient id="m{gid}" x1="0" y1="0" x2="0.3" y2="1"><stop offset="0" stop-color="{light}"/>'
            f'<stop offset="0.5" stop-color="{base}"/><stop offset="1" stop-color="{dark}"/></linearGradient>'
            f'<linearGradient id="w{gid}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="{light}"/>'
            f'<stop offset="1" stop-color="{base}"/></linearGradient>'
            f'<radialGradient id="r{gid}" cx="0.5" cy="0.5" r="0.5"><stop offset="0.35" stop-color="{light}"/>'
            f'<stop offset="1" stop-color="{base}"/></radialGradient>'
            f'<radialGradient id="h{gid}" cx="0.5" cy="0.5" r="0.5"><stop offset="0.2" stop-color="{base}" stop-opacity="0.6"/>'
            f'<stop offset="1" stop-color="{base}" stop-opacity="0"/></radialGradient>'
            f'</defs>')
    metal, soft, glow = f'url(#m{gid})', f'url(#w{gid})', f'url(#r{gid})'
    sy = 92  # shield centre; the shield spans y 36..148 on every rank
    body = []
    if t == 5:
        body.append(f'<circle cx="{CX}" cy="{sy - 6}" r="80" fill="url(#h{gid})"/>')
        body.append(place('star', CX, sy - 8, w=146, rot=45, fill=glow, stroke=INK, stroke_width=OUTLINE))
    if t == 1:
        body.append(place('laurels', CX, sy + 12, w=108, h=110, fill=soft, stroke=INK, stroke_width=OUTLINE))
    if t >= 2:
        ww = {2: 50, 3: 54, 4: 57, 5: 60}[t]
        for side in (-1, 1):
            body.append(place('wing', CX + side * (20 + ww / 2), sy - 12, w=ww,
                              flip=side < 0, fill=soft, stroke=INK, stroke_width=OUTLINE))
    body.append(place('shield', CX, sy, w=80, h=112, fill=metal, stroke=INK, stroke_width=OUTLINE))
    body.append(place('shield', CX, sy - 1, w=68, h=98, fill='none', stroke=light, stroke_opacity='0.55', stroke_width=1.6))
    # the motif, cut into the metal: a light lip offset below, the dark cut on top
    body.append(place(MOTIF, CX + 0.6, sy + 4.8, w=56, fill=light, fill_opacity='0.5'))
    body.append(place(MOTIF, CX, sy + 4, w=56, fill=INK))
    if t == 3:
        body.append(place('crown', CX, 26, w=54, fill=metal, stroke=INK, stroke_width=OUTLINE))
    if t >= 4:
        body.append(place('jewel_crown', CX, 25, w=60, fill=metal, stroke=INK, stroke_width=OUTLINE))
        body.append(place('jewel_crown', CX, 25, w=60, d=CROWN_STONE, fill=soft))
    body += pips(division + 1, light, base)
    label = f'{name.title()} {DIVISIONS[division].upper()}'
    return (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {W} {H}" width="{W}" height="{H}" role="img" aria-label="{label}">'
            f'<title>{label}</title>{defs}{"".join(body)}</svg>\n')

def main():
    os.makedirs(OUT, exist_ok=True)
    png = sys.argv[sys.argv.index('--png') + 1] if '--png' in sys.argv else None
    if png:
        os.makedirs(png, exist_ok=True)
    for t in range(len(TIERS)):
        for d in range(3):
            stem = f'{TIERS[t][0]}-{DIVISIONS[d]}'
            path = os.path.join(OUT, f'{stem}.svg')
            with open(path, 'w') as fh:
                fh.write(emblem(t, d))
            if png:
                subprocess.run(['rsvg-convert', '-w', '1024', '-o', os.path.join(png, f'{stem}.png'), path], check=True)
    print(f'wrote {len(TIERS) * 3} emblems to {OUT}' + (f' and PNGs to {png}' if png else ''))

if __name__ == '__main__':
    main()
