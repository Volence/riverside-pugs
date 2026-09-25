#!/usr/bin/env python3
"""
Export the HUD textures the editor's preview draws, from the owner's own copy of
pak01, to PNGs under web/src/hud/art/, plus a generated TypeScript index. Also
the teammate card's item icons, which are not textures but glyphs of the game's
ToolBox icon font (resource/toolbox.vfont, loose in the install, not in pak01),
drawn to PNGs the same way, and the weapon selection's icons, which are cells of
one texture (vgui/hud/iconsheet) that scripts/mod_textures.txt cuts out.
And the stock HUD's two text faces, Trade Gothic and Trade Gothic Bold
(resource/tg.vfont and tgb.vfont, loose in the install), decoded to TrueType so
the preview draws labels in the game's own letters, with a small table of each
face's metrics so the preview sizes text as the game does without parsing a
font at runtime.

Preview only. These files never enter a build: build.ts does not import them and
a test says so, and another that no download holds a byte of the fonts. The list below is the only way a texture gets in here, and the
script refuses to write more than 1 MB in total so a mistake cannot bloat the
page. Run by hand, from the repo root:

    /home/volence/l4d/hud/.venv/bin/python scripts/export-hud-art.py

Requires the game installed at the Steam path below. Never run this on a server.
"""
import io, json, math, os, re, struct, sys
import vpk
from PIL import Image, ImageChops, ImageDraw, ImageFont
from srctools.vtf import VTF

PAK = os.path.expanduser('~/.steam/steam/steamapps/common/left 4 dead/left4dead/pak01_dir.vpk')
VFONT = os.path.expanduser('~/.steam/steam/steamapps/common/left 4 dead/left4dead/resource/toolbox.vfont')
RESOURCE = os.path.expanduser('~/.steam/steam/steamapps/common/left 4 dead/left4dead/resource')
ROBOTO = os.path.join(os.path.dirname(__file__), '..', 'web', 'src', 'hud', 'base', 'fonts', 'RobotoCondensed-Regular.ttf')
MOD_TEXTURES = os.path.expanduser('~/.steam/steam/steamapps/common/left 4 dead/left4dead/scripts/mod_textures.txt')
HUD_TEXTURES = os.path.expanduser('~/.steam/steam/steamapps/common/left 4 dead/left4dead/scripts/hud_textures.txt')
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
    # the own health panel: the crouch icon is DuckingIcon's art, named by localplayerpanel.res;
    # the outline is HealthPanel's frame, named by client.dll (probe B1 Q3 and the B13 parity
    # shots: the game draws it around the own bar with the fill inset inside it)
    'vgui/hud/crouch_survivor', 'vgui/hud/s_healthbar_outline',
    # your infected health's crouch icon: DuckingIcon's art, named by hunterhealth.res,
    # smokerhealth.res and boomerhealth.res
    'vgui/hud/crouch_infected',
    # the kill notice box, named by pzdamagerecordpanel.res label4background (probe B2 f)
    'vgui/hud/scalablepanel_bgblack_outlinegrey',
    # the ability timer: pz_charge_bg is set by code on AbilityTimerHud.res BackgroundImage,
    # the class icons on AbilityImage (their red rings are in the textures), pz_charge_meter is
    # Progress's fg_image. The Hunter's icon is pz_charge_lunge (the leaping Hunter the game
    # draws, probe-phase2/b13/compare/stock-infected-bottom.png); pz_charge_pounce is unused.
    'vgui/hud/pz_charge_bg', 'vgui/hud/pz_charge_meter',
    'vgui/hud/pz_charge_lunge', 'vgui/hud/pz_charge_smoker', 'vgui/hud/pz_charge_boomer', 'vgui/hud/pz_charge_tank',
    # the ability marker around the infected crosshair: HudCrosshair's own CircularProgressBar,
    # which code gives HUD/PZ_charge_crosshair (client.dll 0x10240e55, probe Q16a)
    'vgui/hud/pz_charge_crosshair',
    # the infected teammate card's class icon: code sets hud/ZombieTeamImage_<class> on PlayerImage
    # (client.dll strings beside ZombieTeamDisplayPlayer.res); a ghost's hud/GhostTeamImage_<class>
    # is a material over the same texture with a pulsing alpha, so no texture of its own
    'vgui/hud/zombieteamimage_hunter', 'vgui/hud/zombieteamimage_smoker',
    'vgui/hud/zombieteamimage_boomer', 'vgui/hud/zombieteamimage_tank',
    # the Tab screen: the versus panel's team and stat boxes, named by versusmodescoreboard.res's
    # highlight images (nine-sliced with 16-texel corners), and the teammate rows' blue-grey fade,
    # named by scoreboardsurvivor.res PlayerBackground (tab screen spec 1.5, 1.6)
    'vgui/hud/scalablepanel_bgblack_outlinered', 'vgui/background_survivor',
]

# Materials drawn by a two-texture shader: the material name -> its second
# texture, which the shader multiplies into the first. pz_charge_meter.vmt is
# UnlitTwoTexture with $texture2 vgui/hud/PZ_charge_meter_motion, a red
# swirl the vmt's proxies turn slowly, so the meter the game draws is red
# with an orange glint (probe Q15, probe-phase2-infected/b10/shots/crops/
# progress-f-zoom.png: R 176, G 3, B 1 at the lit arc), not the base
# texture's orange (206 152 73). The PNG is the product at rest.
TWO_TEXTURE = {
    'vgui/hud/pz_charge_meter': 'vgui/hud/pz_charge_meter_motion',
}

# Cells of scripts/hud_textures.txt (loose in the install): index name -> entry.
# The infected crosshair is PZ_crosshair_open, a 32 x 32 cell of
# sprites/crosshairs that the game draws at its own pixels, 32 x 32 at 1080p
# (probe B9 v2, b9/shots-v2/b9v2/b9v2-d.png: x 944 to 975, y 524 to 555).
HUD_CELLS = {
    'icon/pz_crosshair_open': 'pz_crosshair_open',
}

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
    # not a weapon: the use/heal bar's AwardIcon (progressbar.res "icon" "icon_healing"), a cell of the same sheet
    'icon/healing': 'icon_healing',
    # not a weapon either: the infected card's dead skull, drawn by client.dll at SkullIconPlacement
    # (the name icon_skull sits beside that block's name in its strings; probe Q19)
    'icon/skull': 'icon_skull',
    # the spawn panel's ClassImage: client.dll sets tip_<class> by class (its CHudGhostPanel string run names
    # tip_smoker, tip_hunter, tip_boomer), cells of vgui/tipgraphic (probe G4, probe-phase2-rest/r3/shots/r3/r3-a.png);
    # the too-far panel's SurvivorsImage draws the same class picture, not its file's tip_crouch (r6/shots/r6/r6-a.png)
    'icon/tip_hunter': 'tip_hunter',
    'icon/tip_smoker': 'tip_smoker',
    'icon/tip_boomer': 'tip_boomer',
}
# The stock HUD's faces: the name clientscheme.res gives each -> its vfont
# in the install and the file it is written to here. The name must be the one
# inside the font (its full name, which GDI matches as well as the family), or
# the scheme would not find it in game either; export_fonts checks that.
FONTS = {
    'Trade Gothic': ('tg.vfont', 'font-trade-gothic.ttf'),
    'Trade Gothic Bold': ('tgb.vfont', 'font-trade-gothic-bold.ttf'),
    # The icon face of L4D_Icons and its sizes: the own health panel's
    # HealthIcon label writes "," in it, which the face draws as the "+".
    'ToolBox': ('toolbox.vfont', 'font-toolbox.ttf'),
}
# Faces the schemes name that are not in the install: Windows' own. Their
# metrics (unitsPerEm, usWinAscent, usWinDescent) are the Windows fonts'
# published values; the preview draws them in the viewer's own copy, or a
# fallback, and only needs these to size the text as the game would.
SYSTEM_METRICS = {
    'Verdana': (2048, 2059, 430),
    'Tahoma': (2048, 2049, 423),
    'Arial': (2048, 1854, 434),
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

def sfnt_tables(ttf: bytes) -> dict[str, bytes]:
    """A TrueType file's tables by tag, from its table directory."""
    count = struct.unpack('>H', ttf[4:6])[0]
    tables: dict[str, bytes] = {}
    for i in range(count):
        tag, _sum, off, length = struct.unpack('>4sIII', ttf[12 + 16 * i:28 + 16 * i])
        tables[tag.decode('latin-1')] = ttf[off:off + length]
    return tables

def font_names(ttf: bytes) -> set[str]:
    """The Windows family (name id 1) and full (id 4) names in a font."""
    t = sfnt_tables(ttf)['name']
    _fmt, count, strings = struct.unpack('>HHH', t[:6])
    out: set[str] = set()
    for i in range(count):
        pid, _eid, _lid, nid, length, off = struct.unpack('>HHHHHH', t[6 + 12 * i:18 + 12 * i])
        if pid == 3 and nid in (1, 4):
            out.add(t[strings + off:strings + off + length].decode('utf-16-be'))
    return out

def font_metrics(ttf: bytes) -> dict:
    """
    What the preview needs to size text as GDI does: unitsPerEm (head),
    usWinAscent and usWinDescent (OS/2), and the VDMX table's rows when the
    font has one. VGUI's tall is a cell height, and for a cell height GDI
    picks the largest ppem whose VDMX yMax - yMin fits it, taking the cell's
    ascent and descent from that row; only a font without VDMX falls back to
    scaling the em by winAscent + winDescent. Only the 1:1 ratio group is
    kept, the one a square-pixel screen uses; rows are flattened to
    [ppem, yMax, yMin, ...].
    """
    t = sfnt_tables(ttf)
    upem = struct.unpack('>H', t['head'][18:20])[0]
    win_ascent, win_descent = struct.unpack('>HH', t['OS/2'][74:78])
    m: dict = {'unitsPerEm': upem, 'winAscent': win_ascent, 'winDescent': win_descent}
    v = t.get('VDMX')
    if v:
        _ver, _recs, ratios = struct.unpack('>HHH', v[:6])
        for i in range(ratios):
            charset, x, y0, y1 = struct.unpack('>BBBB', v[6 + 4 * i:10 + 4 * i])
            if (x, y0, y1) == (0, 0, 0) or x == 1 and y0 <= 1 <= y1:
                off = struct.unpack('>H', v[6 + 4 * ratios + 2 * i:8 + 4 * ratios + 2 * i])[0]
                n = struct.unpack('>H', v[off:off + 2])[0]
                rows = [struct.unpack('>Hhh', v[off + 4 + 6 * j:off + 10 + 6 * j]) for j in range(n)]
                m['vdmx'] = [x for row in rows for x in row]
                break
    return m

def export_fonts() -> tuple[dict[str, bytes], dict[str, str], dict[str, dict]]:
    """
    The stock faces as TrueType files, their file names, and the metrics of
    every face a scheme names: the stock two, Roboto Condensed (the Modern
    preset's, the file the build already ships) and Windows' own.
    """
    files: dict[str, bytes] = {}
    names: dict[str, str] = {}
    metrics: dict[str, dict] = {}
    for face, (vfont, fname) in FONTS.items():
        ttf = decode_vfont(open(os.path.join(RESOURCE, vfont), 'rb').read())
        if face not in font_names(ttf):
            sys.exit('refusing: %s is named %s inside, not %r' % (vfont, sorted(font_names(ttf)), face))
        files[fname] = ttf
        names[face] = fname
        metrics[face] = font_metrics(ttf)
        print('  %-48s %6d bytes  (%s, %s)' % (fname, len(ttf), vfont, 'VDMX' if 'vdmx' in metrics[face] else 'no VDMX'))
    metrics['Roboto Condensed'] = font_metrics(open(ROBOTO, 'rb').read())
    for face, (upem, asc, desc) in SYSTEM_METRICS.items():
        metrics[face] = {'unitsPerEm': upem, 'winAscent': asc, 'winDescent': desc}
    return files, names, metrics

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

def export_hud_cells(pak) -> dict[str, bytes]:
    """
    Each HUD_CELLS entry cut from its sprite sheet where hud_textures.txt says,
    at the sheet's own pixels (the same cutter as export_equip).
    """
    cells = texture_cells(open(HUD_TEXTURES, encoding='latin-1').read())
    pngs: dict[str, bytes] = {}
    for name, entry in HUD_CELLS.items():
        c = cells[entry]
        sheet = c['file'].lower().replace('\\', '/')
        img = VTF.read(io.BytesIO(pak['materials/%s.vtf' % sheet].read())).get().to_PIL().convert('RGBA')
        x, y, w, h = (int(c[k]) for k in ('x', 'y', 'width', 'height'))
        img = img.crop((x, y, x + w, y + h))
        if img.getbbox() is None:
            sys.exit('refusing: %s (%s) is empty on %s' % (entry, name, sheet))
        buf = io.BytesIO(); img.save(buf, 'PNG', optimize=True)
        pngs[name] = buf.getvalue()
        print('  %-48s %4dx%-4d %6d bytes  (%s)' % (name, w, h, len(buf.getvalue()), entry))
    return pngs

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
        if name in TWO_TEXTURE:
            second = VTF.read(io.BytesIO(pak['materials/%s.vtf' % TWO_TEXTURE[name]].read())).get().to_PIL().convert('RGBA')
            if second.size != img.size:
                second = second.resize(img.size, Image.BILINEAR)
            r1, g1, b1, a1 = img.split()
            r2, g2, b2, _ = second.split()
            img = Image.merge('RGBA', (ImageChops.multiply(r1, r2), ImageChops.multiply(g1, g2), ImageChops.multiply(b1, b2), a1))
        buf = io.BytesIO(); img.save(buf, 'PNG', optimize=True)
        data = buf.getvalue()
        total += len(data)
        if total > CAP:
            sys.exit('refusing: total exceeds %d bytes at %s' % (CAP, name))
        exported[name] = data
        print('  %-48s %4dx%-4d %6d bytes' % (name, img.width, img.height, len(data)))
    glyphs, advances, space = export_glyphs()
    equip, equip_sizes = export_equip(pak)
    hud_cells = export_hud_cells(pak)
    for name, data in {**glyphs, **equip, **hud_cells}.items():
        total += len(data)
        if total > CAP:
            sys.exit('refusing: total exceeds %d bytes at %s' % (CAP, name))
        exported[name] = data
    font_files, font_names_, metrics = export_fonts()
    for fname, data in font_files.items():
        total += len(data)
        if total > CAP:
            sys.exit('refusing: total exceeds %d bytes at %s' % (CAP, fname))
    # art.ts bundles every PNG and TTF in the folder (import.meta.glob), not
    # just the ones the index names, so a file left over from an older list
    # would ship to the page and could push it past the cap. The folder is
    # cleared of both before the new set is written.
    os.makedirs(OUT, exist_ok=True)
    for old in os.listdir(OUT):
        if old.lower().endswith(('.png', '.ttf')):
            os.remove(os.path.join(OUT, old))
    for fname, data in font_files.items():
        with open(os.path.join(OUT, fname), 'wb') as f: f.write(data)
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
              '// The stock text faces: the name clientscheme.res gives each -> its TrueType file in this folder.',
              'export const FONT_FILES: Record<string, string> = {']
    for k in sorted(font_names_): lines.append("  '%s': '%s'," % (k, font_names_[k]))
    lines += ['};', '',
              '// Every face a scheme names: unitsPerEm, usWinAscent and usWinDescent, and the VDMX rows',
              '// (ppem, yMax, yMin, flattened) for a face that has them. fonts.ts turns a cell height into a size.',
              'export interface FontMetrics { unitsPerEm: number; winAscent: number; winDescent: number; vdmx?: number[] }',
              'export const FONT_METRICS: Record<string, FontMetrics> = {']
    for k in sorted(metrics):
        m = metrics[k]
        vd = (', vdmx: [%s]' % ','.join(str(x) for x in m['vdmx'])) if 'vdmx' in m else ''
        lines.append("  '%s': { unitsPerEm: %d, winAscent: %d, winDescent: %d%s }," % (k, m['unitsPerEm'], m['winAscent'], m['winDescent'], vd))
    lines += ['};', '',
              'export const ART_TOTAL_BYTES = %d;' % total, '']
    with open(os.path.join(OUT, 'index.ts'), 'w') as f: f.write('\n'.join(lines))
    print('%d files, %d bytes total' % (len(index) + len(font_files), total))
    return 0

if __name__ == '__main__':
    sys.exit(main())
