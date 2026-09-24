#!/usr/bin/env bash
# Build a sample HUD VPK with the real generator and read it back with the Python vpk reader.
set -euo pipefail
cd "$(dirname "$0")/.."
OUT="$(mktemp -d)/sample.vpk"
HUD_VPK_OUT="$OUT" npx vitest run --project web --dir web/src/hud sample.vpkcheck.test.ts >/dev/null
/home/volence/l4d/hud/.venv/bin/python - "$OUT" <<'PY'
import io, os, sys, vpk
pak = vpk.open(sys.argv[1])
names = sorted(pak)
assert pak.version == 1, pak.version
assert 'scripts/hudlayout.res' in names, names
for n in names: pak[n].read()          # every CRC is verified on read
if os.environ.get('HUD_SAMPLE') == 's':
    # Sample s: the three custom damage splatters, read by srctools, not by our own decoder.
    from srctools.vtf import VTF, ImageFormats
    for n in ('splatteam', 'splattop', 'splatbottom'):
        for ext in ('vtf', 'vmt'):
            assert f'materials/vgui/hud/hudeditor/{n}.{ext}' in names, (n, ext, names)
    tex = VTF.read(io.BytesIO(pak['materials/vgui/hud/hudeditor/splatteam.vtf'].read()))
    assert (tex.width, tex.height) == (512, 256), (tex.width, tex.height)
    assert tex.format == ImageFormats.BGRA8888, tex.format
    tex.load()
    px = tex.get()[10, 10]
    assert (px.r, px.g, px.b, px.a) == (255, 0, 0, 200), px
    vmt = pak['materials/vgui/hud/hudeditor/splatbottom.vmt'].read().decode('latin1')
    assert '$vertexcolor' not in vmt.lower(), vmt
    card = pak['resource/ui/hud/teammatepanel.res'].read().decode('latin1')
    assert 'HudEdSplatter' in card and 'hud/hudeditor/splatteam' in card, card
if os.environ.get('HUD_SAMPLE') == 'u':
    # Sample u: weapon icon and box uploads, the cells and textures read by srctools.
    from srctools.keyvalues import Keyvalues
    from srctools.vtf import VTF
    kv = Keyvalues.parse(pak['scripts/mod_textures.txt'].read().decode('latin1'))
    cells = next(iter(kv)).find_key('TextureData')
    def cell(name):
        b = cells.find_key(name)
        return {k: b[k] for k in ('file', 'x', 'y', 'width', 'height')}
    assert cell('icon_equip_machinegun') == {'file': 'vgui/hud/hudeditor/icon_equip_machinegun', 'x': '0', 'y': '0', 'width': '192', 'height': '64'}, cell('icon_equip_machinegun')
    assert cell('icon_equip_pills') == {'file': 'vgui/hud/hudeditor/icon_equip_pills', 'x': '0', 'y': '0', 'width': '64', 'height': '64'}, cell('icon_equip_pills')
    assert cell('rounded_background_glow') == {'file': 'vgui/hud/hudeditor/weaponboxactive', 'x': '0', 'y': '0', 'width': '128', 'height': '128'}
    assert cell('icon_equip_rifle')['file'] == 'vgui/hud/iconsheet'
    for n, size, at, want in (('icon_equip_machinegun', (192, 64), (150, 10), (0, 0, 255, 255)),
                              ('icon_equip_pills', (64, 64), (40, 5), (255, 0, 0, 255)),
                              ('weaponboxactive', (128, 128), (2, 2), (255, 255, 0, 255))):
        tex = VTF.read(io.BytesIO(pak[f'materials/vgui/hud/hudeditor/{n}.vtf'].read()))
        assert (tex.width, tex.height) == size, (n, tex.width, tex.height)
        tex.load()
        px = tex.get()[at]
        assert (px.r, px.g, px.b, px.a) == want, (n, px)
        assert f'materials/vgui/hud/hudeditor/{n}.vmt' in names
    print('sample u: cells and textures ok')
if os.environ.get('HUD_SAMPLE') == 'o':
    # Sample o: your own health fitted, scaled 1.5, with piece edits and a
    # rounded "Your health background", read by srctools, not by our own parser.
    from srctools.keyvalues import Keyvalues
    from srctools.vtf import VTF, ImageFormats
    def blocks(path):
        root = list(Keyvalues.parse(pak[path].read().decode('latin1')))[0]
        return list(root)
    own = blocks('resource/ui/hud/localplayerpanel.res')
    by = {b.real_name: b for b in own}
    assert own[0].real_name == 'HudEdOwnBg', [b.real_name for b in own]
    assert (by['HealthbarTextureBottom']['wide'], by['HealthbarTextureBottom']['tall']) == ('0', '0'), by['HealthbarTextureBottom']
    assert by['DuckingIcon']['zpos'] == '9', by['DuckingIcon']
    font = by['HealthNumber']['font']
    assert font.startswith('HudEd_'), font
    scheme = pak['resource/clientscheme.res'].read().decode('latin1')
    assert f'"{font}"' in scheme, font
    # The fitted box, worked out here from the stock file on its own: the
    # visible content (Head as the sample moves it, Health, HealthIcon,
    # HealthNumber) and the kept decoration (the top scratches, the crouch
    # icon) cut to the stock LocalPlayer (0, 0, 130, 85); the bottom
    # scratches are hidden. Then scaled 1.5.
    stock = {b.real_name: b for b in list(Keyvalues.parse(open('web/src/hud/base/stock/resource/ui/hud/localplayerpanel.res', encoding='latin1').read()))[0]}
    def rect(n):
        b = stock[n]
        x = b['xpos', ''] or '36'          # HealthNumber's xpos is PC/Mac conditional; the PC line is 36
        return [int(x), int(b['ypos']), int(b['wide']), int(b['tall'])]
    rects = [[100, 50, 20, 20]] + [rect(n) for n in ('Health', 'HealthIcon', 'HealthNumber')]
    for n in ('HealthbarTextureTop', 'DuckingIcon'):
        x, y, w, h = rect(n)
        rects.append([max(0, x), max(0, y), min(130, x + w) - max(0, x), min(85, y + h) - max(0, y)])
    x0 = min(r[0] for r in rects); y0 = min(r[1] for r in rects)
    x1 = max(r[0] + r[2] for r in rects); y1 = max(r[1] + r[3] for r in rects)
    want = [str(round(v * 1.5)) for v in (x0, y0, x1 - x0, y1 - y0)]
    lp = {b.real_name: b for b in blocks('resource/ui/hud/localplayerdisplay.res')}['LocalPlayer']
    got = [lp['xpos'], lp['ypos'], lp['wide'], lp['tall']]
    assert got == want, (got, want)
    bg = by['HudEdOwnBg']
    assert (bg['wide'], bg['tall']) == (lp['wide'], lp['tall']), (bg['wide'], bg['tall'])
    assert bg['image'] == 'hud/hudeditor/ownbg', bg['image']
    tex = VTF.read(io.BytesIO(pak['materials/vgui/hud/hudeditor/ownbg.vtf'].read()))
    assert (tex.width, tex.height) == (32, 32), (tex.width, tex.height)
    assert tex.format == ImageFormats.BGRA8888, tex.format
    print('sample o: LocalPlayer', ' '.join(got), 'font', font)
if os.environ.get('HUD_SAMPLE') == 'z':
    # Sample z: the infected panels, read by srctools, with the expected
    # numbers worked out here from the stock files and the plan's rules.
    from srctools.keyvalues import Keyvalues
    rnd = lambda v: int(v + 0.5)                # the generator's Math.round, not Python's banker's round
    def blocks(path):
        root = list(Keyvalues.parse(pak[path].read().decode('latin1')))[0]
        return {b.real_name: b for b in root}
    def stock(path):
        root = list(Keyvalues.parse(open('web/src/hud/base/stock/' + path, encoding='latin1').read()))[0]
        return {b.real_name: b for b in root}
    H, S, B = ('resource/ui/hud/%s.res' % n for n in ('hunterhealth', 'smokerhealth', 'boomerhealth'))
    for path in (H, S, B):
        got = blocks(path)
        assert got['Health']['monochrome_color'] == '255 0 255 255', (path, got['Health'])
        assert got['HealthNumber']['fgcolor_override'] == '0 0 255 255', (path, got['HealthNumber'])
    # The Hunter's bar 112 wide at 1.25; the Boomer's in proportion to its own stock bar (plan decision 3).
    sh, sb = stock(H)['Health'], stock(B)['Health']
    assert blocks(H)['Health']['wide'] == str(rnd(112 * 1.25)), blocks(H)['Health']['wide']
    assert blocks(S)['Health']['wide'] == blocks(H)['Health']['wide']
    want_b = rnd(rnd(112 * int(sb['wide']) / int(sh['wide'])) * 1.25)
    assert blocks(B)['Health']['wide'] == str(want_b), (blocks(B)['Health']['wide'], want_b)
    # The fit keeps the frame: (250, 0) 150 x 100 on stock, then scaled (plan decision 1).
    layout = blocks('scripts/hudlayout.res')
    zh = layout['HudZombieHealth']
    assert (zh['wide'], zh['tall']) == (str(rnd(150 * 1.25)), str(rnd(100 * 1.25))), (zh['wide'], zh['tall'])
    # The card fits to (0, 10) 133 x 64; the row steps by the card plus the gap.
    card = blocks('resource/ui/hud/zombieteamdisplayplayer.res')
    me = card['ZombieTeamDisplayPlayer']
    assert (me['wide'], me['tall']) == ('133', '64'), (me['wide'], me['tall'])
    assert card['HealthPanel']['monochrome_color'] == '0 255 255 255', card['HealthPanel']
    assert card['NameLabel']['fgcolor_override'] == '0 255 0 255', card['NameLabel']
    assert card['HealthPanel']['ypos'] == str(int(stock('resource/ui/hud/zombieteamdisplayplayer.res')['HealthPanel']['ypos']) - 10), card['HealthPanel']
    assert layout['CHudZombieTeamDisplay']['HorizPanelSpacing'] == '143', layout['CHudZombieTeamDisplay']
    ring = layout['CHudAbilityTimer']
    assert ring['ability_ready_color'] == '255 0 255 255' and ring['wide'] == '120', ring
    cross = layout['HudCrosshair']
    assert cross['ability_size'] == '30' and cross['ability_ready_color'] == '0 255 0 255', cross
    assert 'never_draw' not in {k.real_name for k in cross}, cross
    print('sample z: SI', zh['wide'], zh['tall'], 'Boomer bar', blocks(B)['Health']['wide'], 'card', me['wide'], me['tall'])
print(len(names), 'files ok')
PY
