"""Emit src/mapOverviews.ts from the capture manifests.

Generated rather than hand-written because it is 182 layers across 22 maps, and
because the numbers are read back from the engine at capture time: retyping them
is exactly the kind of transcription error that puts every avatar on a map in the
wrong place while nothing reports an error.

The emitted module has NO imports, deliberately. It is loaded by the browser as
well as the server, and its types are written out structurally so that
src/mapTransform.ts can declare matching named types without either file
importing the other.
"""
import argparse
import json
import os

from PIL import Image, ImageChops, ImageDraw

parser = argparse.ArgumentParser()
parser.add_argument('src', help='the 1x capture directory')
parser.add_argument('out', help='the TypeScript module to write')
parser.add_argument('--override', help='a directory whose manifests replace same-named maps in src')
args = parser.parse_args()
src, out = args.src, args.out

# The sizes a capture can legitimately be: a single 1x shot, or a 2x2 stitch of
# them. Asserting against the real file rather than taking it on trust is the
# point: an off-size capture would otherwise be written out with the wrong
# dimensions and silently put every avatar on that map in the wrong place,
# which is the exact failure class this generated file exists to prevent.
KNOWN_SIZES = {(2048, 1271), (4096, 2542)}
ONE_X = (2048, 1271)

# mat_fullbright void is pure black; this only rejects encoder noise.
THRESHOLD = 12

# Two capture artifacts, found by running this generator and looking at the
# per-map coverage it printed: several maps reported a box touching x=62 for
# no reason a real map footprint would share, and one map (and one layer of
# another) reported the entire frame as content. Both turned out to be real
# pixels in the source PNGs, not encoder noise, and not level geometry:
#
# - A console notification ("Server cvar '...' changed to N") is baked into
#   many of the captures at a fixed screen position, left over from whatever
#   toggled sv_cheats before the shot. Confirmed by three unrelated maps
#   (garage02_lots, greenhouse, farm05_cornfield) producing the pixel-for-pixel
#   identical bounding box (62, 782)-(448, 801) for it in isolation. Padded a
#   little here for anti-aliased edges. Blanking it before thresholding is
#   safe: across every one of the 22 maps, doing so only ever pulled a box
#   boundary inward, never outward, meaning no map's real content lives there.
# - A solid, saturated green (R and B both at or near zero) shows up where a
#   capture's camera height was low enough that the render found no floor at
#   all: l4d_vs_airport05_runway's z-378 layer is almost entirely this green,
#   and l4d_vs_hospital04_interior carries a wedge of it in one corner across
#   every layer regardless of cut height. Real geometry under mat_fullbright
#   does not render with the red and blue channels pinned to zero, so this is
#   excluded on that signature rather than by hand-picking a rectangle.
HUD_TEXT_BOX = (55, 775, 455, 808)


def content_box(paths):
    """Union of the non-black bounding boxes of every layer of one map."""
    box = None
    for p in paths:
        with Image.open(p) as im:
            rgb = im.convert('RGB')
            # The notification sits at a fixed screen position in 1x captures only;
            # the tiled capture waits for it to fade before shooting.
            if rgb.size == ONE_X:
                ImageDraw.Draw(rgb).rectangle(HUD_TEXT_BOX, fill=(0, 0, 0))
            r, _g, bch = rgb.split()
            bright = rgb.convert('L').point(lambda v: 255 if v > THRESHOLD else 0)
            not_pure_green = ImageChops.lighter(r, bch).point(lambda v: 255 if v > 0 else 0)
            mask = ImageChops.multiply(bright, not_pure_green)
            b = mask.getbbox()
        if b is None:
            continue          # a layer with no geometry at all, which is legal
        box = b if box is None else (
            min(box[0], b[0]), min(box[1], b[1]), max(box[2], b[2]), max(box[3], b[3])
        )
    return box


# Later directories win per map, so a recaptured map replaces its 1x version
# without touching any other.
manifests = {}
for directory in [src] + ([args.override] if args.override and os.path.isdir(args.override) else []):
    for name in os.listdir(directory):
        if name.endswith('.layers.json'):
            manifests[name] = directory

maps = []
for name in sorted(manifests):
    base = manifests[name]
    with open(os.path.join(base, name)) as fh:
        m = json.load(fh)
    layers = sorted(m['layers'], key=lambda l: l['cut_height'])
    paths = []
    for layer in layers:
        path = os.path.join(base, layer['image'])
        paths.append(path)
        with Image.open(path) as im:
            size = im.size
        if size not in KNOWN_SIZES:
            raise SystemExit(
                f"{layer['image']} is {size[0]}x{size[1]}, not a known capture size "
                f'{sorted(KNOWN_SIZES)}.'
            )
        layer['width'], layer['height'] = size
    if len({(l['width'], l['height']) for l in layers}) != 1:
        raise SystemExit(f"{m['map']}: layers disagree on image size")

    # The source PNGs are lossless; the union across every layer is the map's
    # true footprint, since a deep layer showing only a basement would
    # otherwise crop the whole map down to the basement. If no layer has any
    # geometry at all, fall back to the full frame rather than omitting the
    # field, so consumers never have to branch.
    box = content_box(paths)
    w, h = layers[0]['width'], layers[0]['height']
    if box is None:
        box = (0, 0, w, h)
    fraction = ((box[2] - box[0]) * (box[3] - box[1])) / (w * h)
    print(
        f"{m['map']}: box=({box[0]}, {box[1]}, {box[2]}, {box[3]}) "
        f'coverage={fraction:.3f}'
    )

    maps.append((m['map'], layers, box))

lines = [
    '/**',
    ' * Map overview layers, generated by tools/gen-overviews.py.',
    ' *',
    ' * Do not edit by hand. Every number here is read back from the engine at',
    ' * capture time, so a typo puts every avatar on that map in the wrong place',
    ' * and nothing reports an error.',
    ' *',
    ' * Each map is a stack of horizontal slices cut at different camera heights,',
    ' * ascending. A layer shows everything below its cut height and nothing above,',
    ' * so the right one to draw is the lowest whose cut is still above the players.',
    ' * All layers of a map share one transform, so switching between them needs no',
    ' * repositioning.',
    ' *',
    ' * This module has no imports, deliberately: it is loaded by the browser as',
    ' * well as the server. See src/mapTransform.ts for the matching named types.',
    ' */',
    '',
    'export const OVERVIEWS: Record<string, {',
    '  map: string;',
    '  layers: {',
    '    image: string;',
    '    cutHeight: number;',
    '    unitsPerPixel: number;',
    '    originX: number;',
    '    originY: number;',
    '    width: number;',
    '    height: number;',
    '  }[];',
    '  contentBox: { x0: number; y0: number; x1: number; y1: number };',
    '}> = {',
]

for map_name, layers, box in maps:
    lines.append(f"  '{map_name}': {{")
    lines.append(f"    map: '{map_name}',")
    lines.append('    layers: [')
    for l in layers:
        ulx, uly = l['world_upper_left']
        img = l['image'].replace('.png', '.webp')
        lines.append(
            '      { '
            f"image: '/overviews/{img}', "
            f"cutHeight: {l['cut_height']:g}, "
            f"unitsPerPixel: {l['units_per_pixel']:.6f}, "
            f"originX: {ulx:g}, originY: {uly:g}, "
            f"width: {l['width']}, height: {l['height']} }},"
        )
    lines.append('    ],')
    lines.append(
        f'    contentBox: {{ x0: {box[0]}, y0: {box[1]}, x1: {box[2]}, y1: {box[3]} }},'
    )
    lines.append('  },')

lines += [
    '};',
    '',
    '/** The overview stack for a map, or null when there is no art for it.',
    ' *',
    ' *  Keys are the names the server reports, including the `vs_` infix for versus',
    ' *  maps and the co-op names for Crash Course, which ships no versus variant. The',
    ' *  second-chance lookup exists because a miss here is silent: the viewer falls',
    ' *  back to auto-fit and simply looks worse, with nothing logged. */',
    'export function overviewFor(map: string): (typeof OVERVIEWS)[string] | null {',
    '  const key = map.toLowerCase();',
    '  if (OVERVIEWS[key]) return OVERVIEWS[key];',
    "  const swapped = key.startsWith('l4d_vs_')",
    "    ? key.replace('l4d_vs_', 'l4d_')",
    "    : key.replace('l4d_', 'l4d_vs_');",
    '  return OVERVIEWS[swapped] ?? null;',
    '}',
    '',
]

with open(out, 'w') as fh:
    fh.write('\n'.join(lines))
print(f'wrote {out}: {len(maps)} maps, {sum(len(l) for _, l, _ in maps)} layers')
