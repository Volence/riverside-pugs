#!/usr/bin/env python3
"""Rank emblems: one image per rank (Bronze III .. Master I) into web/public/ranks/.

    python3 scripts/rank-emblems.py           # site images only
    python3 scripts/rank-emblems.py --png DIR # also 1024px transparent PNGs + lineups into DIR (video, Discord)

The art is scripts/rank-art/<tier>.png: one emblem per tier, 1024x1024 on flat
#00FF00, all drawn at the same scale (the shields share one size and one
baseline, so the wings and crowns of the higher tiers make them bigger). The
owner had them AI-generated in October 2026 from our concept; no third-party
licence applies. To replace a tier, generate it the same way (same framing,
same green, no pips or text) and rerun this.

This script keys out the green, nudges two colours (Master toward violet so it
is not a pink Diamond, Platinum's teal up so it does not read as Silver at
badge size), crops every tier to one shared frame, and adds the division pips
under the shield: III one, II two, I three. Requires Pillow with WebP.
"""
import os
import sys

import numpy as np
from PIL import Image, ImageDraw

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ART = os.path.join(ROOT, 'scripts', 'rank-art')
OUT = os.path.join(ROOT, 'web', 'public', 'ranks')

TIERS = ['bronze', 'silver', 'gold', 'platinum', 'diamond', 'master']
DIVISIONS = ['iii', 'ii', 'i']  # lowest first, as in src/seasonRules.ts
# Pip colour per tier, close to the art's metal, a little brighter.
PIP = {
    'bronze': (200, 122, 72), 'silver': (214, 210, 202), 'gold': (232, 178, 70),
    'platinum': (112, 196, 176), 'diamond': (140, 186, 236), 'master': (186, 130, 236),
}
OUTLINE = (20, 16, 12)

# The shared frame, in source pixels: every emblem's art fits inside it
# (measured: the union of the six bounding boxes is x 73..953, y 111..894).
FRAME = (64, 96, 960, 1004)       # left, top, right, bottom: 896 x 908
PIP_Y = 950 - 96                   # pip centre, in frame pixels
PIP_R = 34                         # pip half-diagonal
PIP_GAP = 100                      # centre to centre
SITE_SIZE = (320, 324)             # web/public/ranks/*.webp
BADGE_SIZE = 64                    # web/public/ranks/*-badge.webp: tight, square, no pips


def key(img):
    """Green to alpha, with the green spill taken out of the edges."""
    a = np.asarray(img.convert('RGB')).astype(np.float32)
    r, g, b = a[..., 0], a[..., 1], a[..., 2]
    d = g - np.maximum(r, b)
    alpha = np.clip(1 - (d - 60) / 120, 0, 1)
    g2 = np.where(d > 20, np.maximum(r, b), g)
    return np.dstack([r, g2, b, alpha * 255])


def hsv(rgb):
    mx, mn = rgb.max(-1), rgb.min(-1)
    c = mx - mn
    r, g, b = rgb[..., 0], rgb[..., 1], rgb[..., 2]
    safe = np.where(c == 0, 1, c)
    h = np.where(mx == r, ((g - b) / safe) % 6, np.where(mx == g, (b - r) / safe + 2, (r - g) / safe + 4)) * 60
    s = np.where(mx == 0, 0, c / np.where(mx == 0, 1, mx))
    return np.where(c == 0, 0, h), s, mx


def rgb_of(h, s, v):
    c = v * s
    x = c * (1 - np.abs((h / 60) % 2 - 1))
    m = v - c
    k = (h // 60).astype(int) % 6
    z = np.zeros_like(h)
    r = np.choose(k, [c, x, z, z, x, c])
    g = np.choose(k, [x, c, c, x, z, z])
    b = np.choose(k, [z, z, x, c, c, x])
    return np.dstack([r + m, g + m, b + m])


def regrade(px, tier):
    """Hue and saturation nudges on the metal only: the black, the cream
    border and the blood are left alone."""
    if tier not in ('master', 'platinum'):
        return px
    h, s, v = hsv(px[..., :3] / 255.0)
    if tier == 'master':
        sel = (h >= 270) & (h <= 345) & (s > 0.12)
        h = np.where(sel, h - 22, h)
        s = np.where(sel, np.minimum(1, s * 1.1), s)
    else:
        sel = (h >= 130) & (h <= 210) & (s > 0.06)
        s = np.where(sel, np.minimum(1, s * 1.55), s)
    out = px.copy()
    out[..., :3] = rgb_of(h, s, v) * 255
    return out


def pips(draw, filled, colour, scale):
    """Three diamonds under the shield; the first `filled` lit."""
    cx = (FRAME[2] - FRAME[0]) / 2
    for k in range(3):
        x, y, r = (cx + (k - 1) * PIP_GAP) * scale, PIP_Y * scale, PIP_R * scale
        poly = [(x, y - r), (x + r, y), (x, y + r), (x - r, y)]
        if k < filled:
            draw.polygon(poly, fill=colour + (255,), outline=OUTLINE + (255,), width=max(2, round(6 * scale)))
        else:
            draw.polygon(poly, fill=OUTLINE + (200,), outline=colour + (150,), width=max(2, round(5 * scale)))


def emblem(base, tier, division_index, size):
    """One rank at `size` (w, h): the tier's art in the shared frame, plus pips."""
    img = base.resize(size, Image.LANCZOS)
    pips(ImageDraw.Draw(img), division_index + 1, PIP[tier], size[0] / (FRAME[2] - FRAME[0]))
    return img


def main():
    os.makedirs(OUT, exist_ok=True)
    png = sys.argv[sys.argv.index('--png') + 1] if '--png' in sys.argv else None
    bases = {}
    for tier in TIERS:
        px = regrade(key(Image.open(os.path.join(ART, f'{tier}.png'))), tier)
        full = Image.fromarray(np.clip(px, 0, 255).astype(np.uint8), 'RGBA').crop(FRAME)
        bases[tier] = full
        for d in range(3):
            emblem(full, tier, d, SITE_SIZE).save(os.path.join(OUT, f'{tier}-{DIVISIONS[d]}.webp'), quality=88, method=6)
        # Badge size (about 20px in a table row): the tier's own art, cropped
        # tight and centred in a square, so a wide Master is not a speck.
        # Divisions are written beside a badge, so it carries no pips.
        tight = full.crop(full.getbbox())
        side = max(tight.size)
        sq = Image.new('RGBA', (side, side), (0, 0, 0, 0))
        sq.alpha_composite(tight, ((side - tight.width) // 2, (side - tight.height) // 2))
        sq.resize((BADGE_SIZE, BADGE_SIZE), Image.LANCZOS).save(os.path.join(OUT, f'{tier}-badge.webp'), quality=90, method=6)
    print(f'wrote {len(TIERS) * 3} emblems and {len(TIERS)} badges to {OUT}')
    if not png:
        return
    os.makedirs(png, exist_ok=True)
    big = (1010, 1024)
    tiles = []
    for tier in TIERS:
        for d in range(3):
            im = emblem(bases[tier], tier, d, big)
            im.save(os.path.join(png, f'{tier}-{DIVISIONS[d]}.png'))
            if d == 2:
                tiles.append(im)
    # Lineups: the six tiers at their I division, side by side.
    tw, th = 505, 512
    for name, bg in (('lineup-transparent.png', (0, 0, 0, 0)), ('lineup-dark.png', (11, 13, 16, 255))):
        sheet = Image.new('RGBA', (tw * 6 + 80, th + 80), bg)
        for i, t in enumerate(tiles):
            sheet.alpha_composite(t.resize((tw, th), Image.LANCZOS), (40 + i * tw, 40))
        sheet.save(os.path.join(png, name))
    print(f'and 1024px PNGs + lineups to {png}')


if __name__ == '__main__':
    main()
