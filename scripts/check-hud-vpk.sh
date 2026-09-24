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
print(len(names), 'files ok')
PY
