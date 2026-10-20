#!/usr/bin/env python3
"""Rank emblems: one SVG per rank (Bronze III .. Master I) into web/public/ranks/.

    python3 scripts/rank-emblems.py           # SVGs only
    python3 scripts/rank-emblems.py --png DIR # also 1024px PNGs into DIR (video, Discord)

Each tier adds to the one below it, so the shape alone says how high a rank is:
Bronze is a bare shield, Silver grows blades, Gold laurel wings, Platinum a
crown, Diamond turns the shield into a cut gem, Master adds the halo. The claw
marks in the middle are the one thing every rank shares. Pips under the emblem
are the division: III one, II two, I three. Colours match .rankbadge--* in
web/src/styles/app.css.
"""
import math
import os
import subprocess
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, 'web', 'public', 'ranks')

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

def f(n):
    return f'{n:.1f}'.rstrip('0').rstrip('.')

def pts(points):
    return ' '.join(f'{f(x)},{f(y)}' for x, y in points)

def shield(inset=0.0):
    """The shield outline, inset toward its centre."""
    t, s, b = 30 + inset, 46 + inset * 0.6, 150 - inset * 1.4
    l, r = 38 + inset, 122 - inset
    return (f'M{f(CX)} {f(t)} L{f(r)} {f(t + 14)} V{f(s + 40)} '
            f'C{f(r)} {f(b - 30)} {f(CX + 22)} {f(b - 8)} {f(CX)} {f(b)} '
            f'C{f(CX - 22)} {f(b - 8)} {f(l)} {f(b - 30)} {f(l)} {f(s + 40)} V{f(t + 14)} Z')

def gem(inset=0.0):
    """Diamond's cut-gem body: a tall octagon."""
    i = inset
    return pts([(CX, 26 + i), (114 - i, 48 + i * 0.4), (122 - i, 86), (108 - i, 122 - i * 0.4),
                (CX, 152 - i), (52 + i, 122 - i * 0.4), (38 + i, 86), (46 + i, 48 + i * 0.4)])

def feather(bx, by, ang, ln, w, side):
    """One tapered, slightly curved feather from (bx, by) at `ang` degrees above
    horizontal, pointing away from the shield on `side`."""
    a = math.radians(ang)
    dx, dy = side * math.cos(a), -math.sin(a)
    nx, ny = -dy * side, dx * side  # normal, toward the lower edge
    tx, ty = bx + dx * ln, by + dy * ln
    # control points bow the upper edge out and keep the lower edge straighter
    c1 = (bx + dx * ln * 0.55 - nx * w * 1.1, by + dy * ln * 0.55 - ny * w * 1.1)
    c2 = (bx + dx * ln * 0.6 + nx * w * 0.9, by + dy * ln * 0.6 + ny * w * 0.9)
    p0 = (bx - nx * w * 0.6, by - ny * w * 0.6)
    p1 = (bx + nx * w * 0.6, by + ny * w * 0.6)
    return (f'M{f(p0[0])} {f(p0[1])} Q{f(c1[0])} {f(c1[1])} {f(tx)} {f(ty)} '
            f'Q{f(c2[0])} {f(c2[1])} {f(p1[0])} {f(p1[1])} Z')

def wing(side, count, length, fill, stroke):
    """Feathers fanned from the shield's shoulder: the top one climbs, each
    one below it is shorter and flatter, like a folded-open wing."""
    out = []
    angles = [38, 20, 4, -12, -26][:count]
    for k, ang in reversed(list(enumerate(angles))):  # lowest first, so upper feathers overlap
        ln = length * (1 - 0.14 * k)
        bx, by = CX + side * 30, 56 + k * 11
        d = feather(bx, by, ang, ln, 7.5 - k * 0.6, side)
        out.append(f'<path d="{d}" fill="{fill}" stroke="{stroke}" stroke-width="1.2" stroke-linejoin="round"/>')
    return out

def blades(fill, stroke):
    out = []
    for side in (-1, 1):
        poly = [(CX + side * 40, 52), (CX + side * 64, 66), (CX + side * 40, 86)]
        out.append(f'<polygon points="{pts(poly)}" fill="{fill}" stroke="{stroke}" stroke-width="1.4" stroke-linejoin="round"/>')
    return out

def crown(fill, stroke, light, tall=False):
    """Sits on the shield's top point, in front of it."""
    base, h = 34, (24 if tall else 18)
    poly = [(CX - 22, base), (CX - 25, base - h * 0.75), (CX - 11, base - h * 0.42), (CX, base - h),
            (CX + 11, base - h * 0.42), (CX + 25, base - h * 0.75), (CX + 22, base)]
    out = [f'<polygon points="{pts(poly)}" fill="{fill}" stroke="{stroke}" stroke-width="1.4" stroke-linejoin="round"/>',
           f'<line x1="{f(CX - 21)}" y1="{f(base - 4)}" x2="{f(CX + 21)}" y2="{f(base - 4)}" stroke="{stroke}" stroke-width="1.2"/>']
    for x, y in [(CX - 25, base - h * 0.75), (CX, base - h), (CX + 25, base - h * 0.75)]:
        out.append(f'<circle cx="{f(x)}" cy="{f(y)}" r="2.6" fill="{light}" stroke="{stroke}" stroke-width="1"/>')
    return out

def claws(dark, light, y=90, scale=1.0):
    """Three slashes: the infected's mark, shared by every rank. Each is a
    crescent, sharp at both ends, cut in dark with a light lip below it so it
    reads as carved into the metal."""
    out = []
    for k in (-1, 0, 1):
        x = CX + k * 13 * scale
        top = (x + 9 * scale, y - 27 * scale)
        bot = (x - 9 * scale, y + 27 * scale)
        bulge = 4.2 * scale
        d = (f'M{f(top[0])} {f(top[1])} Q{f(x + 3 * scale + bulge)} {f(y)} {f(bot[0])} {f(bot[1])} '
             f'Q{f(x + 3 * scale - bulge)} {f(y)} {f(top[0])} {f(top[1])} Z')
        out.append(f'<path d="{d}" fill="{light}" fill-opacity="0.45" transform="translate(1.4 1.6)"/>')
        out.append(f'<path d="{d}" fill="{dark}"/>')
    return out

def pips(filled, on, off):
    out = []
    for k in range(3):
        x = CX + (k - 1) * 18
        d = pts([(x, 160), (x + 6, 166), (x, 172), (x - 6, 166)])
        if k < filled:
            out.append(f'<polygon points="{d}" fill="{on}"/>')
        else:
            out.append(f'<polygon points="{d}" fill="none" stroke="{off}" stroke-width="1.5"/>')
    return out

def emblem(tier_index, division_index):
    name, base, light, dark = TIERS[tier_index]
    gid = f'{name}{division_index}'
    defs = f'''<defs>
<linearGradient id="m{gid}" x1="0" y1="0" x2="0.35" y2="1"><stop offset="0" stop-color="{light}"/><stop offset="0.45" stop-color="{base}"/><stop offset="1" stop-color="{dark}"/></linearGradient>
<linearGradient id="w{gid}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="{light}"/><stop offset="1" stop-color="{base}"/></linearGradient>
<radialGradient id="h{gid}" cx="0.5" cy="0.48" r="0.5"><stop offset="0.55" stop-color="{base}" stop-opacity="0.55"/><stop offset="1" stop-color="{base}" stop-opacity="0"/></radialGradient>
</defs>'''
    metal, wingfill = f'url(#m{gid})', f'url(#w{gid})'
    body = []
    if tier_index == 5:  # Master: halo behind everything
        body.append(f'<circle cx="{CX}" cy="88" r="78" fill="url(#h{gid})"/>')
        for k in range(16):
            a = math.radians(k * 22.5)
            x1, y1 = CX + 58 * math.cos(a), 88 + 58 * math.sin(a)
            x2, y2 = CX + 74 * math.cos(a), 88 + 74 * math.sin(a)
            body.append(f'<line x1="{f(x1)}" y1="{f(y1)}" x2="{f(x2)}" y2="{f(y2)}" stroke="{light}" stroke-opacity="0.5" stroke-width="2" stroke-linecap="round"/>')
    if tier_index >= 2:  # wings from Gold up, more feathers each tier
        count = {2: 3, 3: 4, 4: 4, 5: 5}[tier_index]
        length = {2: 38, 3: 44, 4: 48, 5: 54}[tier_index]
        for side in (-1, 1):
            body += wing(side, count, length, wingfill, dark)
    if tier_index == 1:
        body += blades(wingfill, dark)
    if tier_index >= 4:
        body.append(f'<polygon points="{gem()}" fill="{metal}" stroke="{dark}" stroke-width="2" stroke-linejoin="round"/>')
        body.append(f'<polygon points="{gem(9)}" fill="none" stroke="{light}" stroke-opacity="0.55" stroke-width="1.5" stroke-linejoin="round"/>')
        # facets
        for a, b in [((CX, 26), (CX, 152)), ((46, 48), (108, 122)), ((114, 48), (52, 122))]:
            body.append(f'<line x1="{f(a[0])}" y1="{f(a[1])}" x2="{f(b[0])}" y2="{f(b[1])}" stroke="{light}" stroke-opacity="0.18" stroke-width="1.2"/>')
    else:
        body.append(f'<path d="{shield()}" fill="{metal}" stroke="{dark}" stroke-width="2" stroke-linejoin="round"/>')
        body.append(f'<path d="{shield(8)}" fill="none" stroke="{light}" stroke-opacity="0.55" stroke-width="1.5" stroke-linejoin="round"/>')
    if tier_index >= 3:
        body += crown(metal, dark, light, tall=tier_index == 5)
    body += claws(dark, light, 92, 1.0)
    body += pips(division_index + 1, light if tier_index else base, base)
    label = f'{name.title()} {DIVISIONS[division_index].upper()}'
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
