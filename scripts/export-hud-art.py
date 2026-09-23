#!/usr/bin/env python3
"""
Export the HUD textures the editor's preview draws, from the owner's own copy of
pak01, to PNGs under web/src/hud/art/, plus a generated TypeScript index. Also
the teammate card's item icons, which are not textures but glyphs of the game's
ToolBox icon font (resource/toolbox.vfont, loose in the install, not in pak01),
drawn to PNGs the same way, and the weapon selection's icons, which are cells of
one texture (vgui/hud/iconsheet) that scripts/mod_textures.txt cuts out.

Preview only. These files never enter a build: build.ts does not import them and
a test says so. The list below is the only way a texture gets in here, and the
script refuses to write more than 1 MB in total so a mistake cannot bloat the
page. Run by hand, from the repo root:

    /home/volence/l4d/hud/.venv/bin/python scripts/export-hud-art.py

Requires the game installed at the Steam path below. Never run this on a server.
"""
import io, json, math, os, re, sys
import vpk
from PIL import Image, ImageDraw, ImageFont
from srctools.vtf import VTF

PAK = os.path.expanduser('~/.steam/steam/steamapps/common/left 4 dead/left4dead/pak01_dir.vpk')
VFONT = os.path.expanduser('~/.steam/steam/steamapps/common/left 4 dead/left4dead/resource/toolbox.vfont')
MOD_TEXTURES = os.path.expanduser('~/.steam/steam/steamapps/common/left 4 dead/left4dead/scripts/mod_textures.txt')
OUT = os.path.join(os.path.dirname(__file__), '..', 'web', 'src', 'hud', 'art')
CAP = 1_000_000

# Lower-case material names, relative to materials/, no extension. Keep this list
# identical to NEEDED_MATERIALS in web/src/hud/art.ts; art.test.ts checks the index
# covers every one of those, so a name added there without being added here fails.
MATERIALS = [
    # survivor portraits: game code chooses one of these for every Head / PlayerImage
    'vgui/s_panel_biker', 'vgui/s_panel_manager', 'vgui/s_panel_namvet', 'vgui/s_panel_teenangst',
    # panel backgrounds and bar frames named by the .res files
    'vgui/s_panel_background',
    'vgui/hud/healthbar_bg_1', 'vgui/hud/healthbar_bg_2', 'vgui/hud/healthbar_bg_3', 'vgui/hud/healthbar_bg_4',
    'vgui/hud/infected_healthbar_bg_1',
    'vgui/hud/pz_healthbar_50', 'vgui/hud/pz_healthbar_250', 'vgui/hud/pz_healthbar_3000',
    'vgui/hud/detail_scratches_top_1', 'vgui/hud/detail_scratches_bottom_1',
    'vgui/hud/overlay_dead',
    # bar fills, named by game code
    'vgui/healthbar_green', 'vgui/healthbar_orange', 'vgui/healthbar_red', 'vgui/healthbar_white', 'vgui/healthbar_grey',
    # weapon boxes, the advanced-mode slots
    'vgui/hud/scalablepanel_bgmidgrey', 'vgui/hud/scalablepanel_bgmidgrey_glow',
    # state panels the advanced-mode slots can restyle (drawn nowhere yet, exported so the index is complete)
    'vgui/s_panel_dead',
    'vgui/s_panel_biker_incap', 'vgui/s_panel_manager_incap', 'vgui/s_panel_namvet_incap', 'vgui/s_panel_teenangst_incap',
]

# The item icons: index name -> ToolBox character. The characters are the ones
# client.dll writes into the teammate card's Items label (the function that
# builds that text, found by disassembly: '!' medkit, '"' pills, then '$' pipe
# bomb or '#' molotov, with a space between each), which the contact sheet of
# the decoded font confirms are those four pictures. The weapon scripts name
# other glyphs of the same font ('a' pills, 'b' molotov), but the weapon
# selection paint never reads them: it draws icon_equip_* cells of
# vgui/hud/iconsheet instead (see EQUIP below), so those glyphs go unused.
GLYPHS = {
    'icon/item/medkit': '!',
    'icon/item/pills': '"',
    'icon/item/molotov': '#',
    'icon/item/pipebomb': '$',
}
# The weapon selection's icons: index name -> mod_textures.txt entry. The game's
# weapon selection (TerrorWeaponSelection.cpp in client.dll) looks these names up
# with gHUD.GetIcon when its scheme is applied and draws the cell each one cuts
# from vgui/hud/iconsheet: the primary weapon, the pistol or dual pistols, and
# the three item slots (molotov or pipe bomb, medkit, pills). Not the ToolBox
# glyphs the weapon scripts name, which that code never reads. Only the sample
# loadout the preview shows is exported.
EQUIP = {
    'icon/equip/pumpshotgun': 'icon_equip_pumpshotgun',
    'icon/equip/dualpistols': 'icon_equip_dualpistols',
    'icon/equip/molotov': 'icon_equip_molotov',
    'icon/equip/medkit': 'icon_equip_medkit',
    'icon/equip/pills': 'icon_equip_pills',
}
# Every glyph is drawn into the font's whole cell (ascent plus descent) at this
# many pixels tall, so the preview can scale a PNG to the label's font tall and
# have the glyph sit where the font puts it inside that height.
GLYPH_CELL = 64

def decode_vfont(data: bytes) -> bytes:
    """
    A .vfont is a TrueType file with every byte XORed against a running key,
    then a salt, the salt's length and the marker "VFONT1" appended. The key
    starts at 167 folded with all but the last salt byte, and after each byte
    becomes that encoded byte plus 167. The same routine as ValveResourceFormat's
    ValveFont.cs, the public reading of the format.
    """
    magic = b'VFONT1'
    if not data.endswith(magic):
        raise ValueError('not a VFONT1 file')
    salt_len = data[-len(magic) - 1]
    end = len(data) - len(magic) - salt_len
    key = 167
    for b in data[end:end + salt_len - 1]:
        key ^= (b + 167) % 256
    out = bytearray(end)
    for i in range(end):
        out[i] = data[i] ^ key
        key = (data[i] + 167) % 256
    if bytes(out[:4]) not in (b'\x00\x01\x00\x00', b'OTTO', b'true'):
        raise ValueError('decoded vfont is not a TrueType font')
    return bytes(out)

def export_glyphs() -> tuple[dict[str, bytes], dict[str, float], float]:
    """
    Each item glyph, white on transparent, one font cell tall and one advance
    wide (widened if the ink overhangs it). Returns the PNGs, each glyph's
    advance and the space's advance, both as a fraction of the cell height,
    which is how the game spaces the row: glyph, space, glyph.
    """
    ttf = decode_vfont(open(VFONT, 'rb').read())
    size = GLYPH_CELL
    font = ImageFont.truetype(io.BytesIO(ttf), size)
    while sum(font.getmetrics()) < GLYPH_CELL:        # the smallest size whose cell reaches the target
        size += 1
        font = ImageFont.truetype(io.BytesIO(ttf), size)
    cell = sum(font.getmetrics())
    pngs: dict[str, bytes] = {}
    advances: dict[str, float] = {}
    for name, ch in GLYPHS.items():
        bbox = font.getbbox(ch, anchor='la')
        if bbox[2] <= bbox[0] or bbox[3] <= bbox[1]:
            sys.exit('refusing: the ToolBox font draws nothing for %r (%s)' % (ch, name))
        adv = font.getlength(ch)
        img = Image.new('RGBA', (max(math.ceil(adv), bbox[2]), cell), (255, 255, 255, 0))
        ImageDraw.Draw(img).text((0, 0), ch, font=font, fill=(255, 255, 255, 255), anchor='la')
        buf = io.BytesIO(); img.save(buf, 'PNG', optimize=True)
        pngs[name] = buf.getvalue()
        advances[name] = round(adv / cell, 4)
        print('  %-48s %4dx%-4d %6d bytes  (%r)' % (name, img.width, img.height, len(buf.getvalue()), ch))
    return pngs, advances, round(font.getlength(' ') / cell, 4)

def texture_cells(text: str) -> dict[str, dict[str, str]]:
    """
    Every entry of a hud/mod_textures.txt TextureData block: name -> its keys
    (file, x, y, width, height). The file is flat KeyValues two levels deep, so
    a small tokenizer is enough; comments are dropped as the game drops them.
    """
    toks = re.findall(r'"([^"]*)"|([{}])|([^\s{}"]+)', re.sub(r'//[^\n]*', '', text))
    words = [a or b or c for a, b, c in toks]
    cells: dict[str, dict[str, str]] = {}
    i = words.index('TextureData') + 2                  # past the name and its {
    while words[i] != '}':
        name = words[i]; i += 2                          # past the name and its {
        keys: dict[str, str] = {}
        while words[i] != '}':
            keys[words[i].lower()] = words[i + 1]; i += 2
        cells[name.lower()] = keys; i += 1
    return cells

def export_equip(pak) -> tuple[dict[str, bytes], dict[str, tuple[int, int]]]:
    """
    Each weapon selection icon, cut from its sheet where mod_textures.txt says,
    at the sheet's own pixels. Returns the PNGs and each cell's size, which the
    preview needs: the game draws the primary weapon's icon as wide as its
    cell's shape allows at a fixed height.
    """
    cells = texture_cells(open(MOD_TEXTURES, encoding='latin-1').read())
    sheets: dict[str, Image.Image] = {}
    pngs: dict[str, bytes] = {}
    sizes: dict[str, tuple[int, int]] = {}
    for name, entry in EQUIP.items():
        c = cells[entry]
        sheet = c['file'].lower().replace('\\', '/')
        if sheet not in sheets:
            sheets[sheet] = VTF.read(io.BytesIO(pak['materials/%s.vtf' % sheet].read())).get().to_PIL().convert('RGBA')
        x, y, w, h = (int(c[k]) for k in ('x', 'y', 'width', 'height'))
        img = sheets[sheet].crop((x, y, x + w, y + h))
        if img.getbbox() is None:
            sys.exit('refusing: %s (%s) is empty on %s' % (entry, name, sheet))
        buf = io.BytesIO(); img.save(buf, 'PNG', optimize=True)
        pngs[name] = buf.getvalue()
        sizes[name] = (w, h)
        print('  %-48s %4dx%-4d %6d bytes  (%s)' % (name, w, h, len(buf.getvalue()), entry))
    return pngs, sizes

def main() -> int:
    pak = vpk.open(PAK)
    # Everything is exported in memory first, so a failure (a missing texture,
    # the size cap) leaves the folder exactly as it was.
    exported: dict[str, bytes] = {}
    total = 0
    for name in MATERIALS:
        raw = pak['materials/%s.vtf' % name].read()
        img = VTF.read(io.BytesIO(raw)).get().to_PIL().convert('RGBA')
        buf = io.BytesIO(); img.save(buf, 'PNG', optimize=True)
        data = buf.getvalue()
        total += len(data)
        if total > CAP:
            sys.exit('refusing: total exceeds %d bytes at %s' % (CAP, name))
        exported[name] = data
        print('  %-48s %4dx%-4d %6d bytes' % (name, img.width, img.height, len(data)))
    glyphs, advances, space = export_glyphs()
    equip, equip_sizes = export_equip(pak)
    for name, data in {**glyphs, **equip}.items():
        total += len(data)
        if total > CAP:
            sys.exit('refusing: total exceeds %d bytes at %s' % (CAP, name))
        exported[name] = data
    # art.ts bundles every PNG in the folder (import.meta.glob), not just the
    # ones the index names, so a PNG left over from an older list would ship
    # to the page and could push it past the cap. The folder is cleared of
    # PNGs before the new set is written.
    os.makedirs(OUT, exist_ok=True)
    for old in os.listdir(OUT):
        if old.lower().endswith('.png'):
            os.remove(os.path.join(OUT, old))
    index: dict[str, str] = {}
    for name, data in exported.items():
        fname = name.replace('/', '-') + '.png'
        with open(os.path.join(OUT, fname), 'wb') as f: f.write(data)
        index[name] = fname
    lines = ['// GENERATED by scripts/export-hud-art.py. Do not edit; rerun the script.',
             '// Material name (lower case, relative to materials/, no extension), icon/item/* for an item glyph,',
             '// or icon/equip/* for a weapon selection icon -> png in this folder.',
             'export const ART: Record<string, string> = {']
    for k in sorted(index): lines.append("  '%s': '%s'," % (k, index[k]))
    lines += ['};', '',
              '// Item icon glyphs: how far each one advances the row, and the space the game puts',
              '// between two, as a fraction of the font cell height the PNGs are drawn at.',
              'export const ICON_ADVANCE: Record<string, number> = {']
    for k in sorted(advances): lines.append("  '%s': %s," % (k, advances[k]))
    lines += ['};', '', 'export const ICON_SPACE = %s;' % space, '',
              '// Weapon selection icons: each cell\'s width and height on its icon sheet, in texels.',
              'export const EQUIP_ICON_SIZE: Record<string, [number, number]> = {']
    for k in sorted(equip_sizes): lines.append("  '%s': [%d, %d]," % (k, *equip_sizes[k]))
    lines += ['};', '',
              'export const ART_TOTAL_BYTES = %d;' % total, '']
    with open(os.path.join(OUT, 'index.ts'), 'w') as f: f.write('\n'.join(lines))
    print('%d files, %d bytes total' % (len(index), total))
    return 0

if __name__ == '__main__':
    sys.exit(main())
