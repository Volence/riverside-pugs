# Overview Tiled Recapture Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Recapture Blood Harvest 1's map overview at 4x pixel density with no human at the keyboard, prove it against the existing 1x layers, and ship it live in the replay viewer.

**Architecture:** Python tooling in `/home/volence/l4d/overviews` plans a 2x2 grid of half-scale tiles per layer, generates an L4D1 console command chain that shoots them and quits, drives the game through one synthetic F9 per map (KWin focus + uinput), verifies each attempt from `console.log`, then stitches, cleans and checks the result. The pug web app picks the 4x map up through its existing overview converter with an override directory.

**Tech Stack:** Python 3 (stdlib, Pillow 12, numpy 2, python-evdev), pytest 9, KWin scripting over `qdbus6`, bash, ImageMagick `magick`; pug is TypeScript with vitest.

**Spec:** `/home/volence/l4d/pug/docs/superpowers/specs/2026-09-16-overview-tiled-recapture-design.md`

## Global Constraints

- No em dashes anywhere: code, comments, docs, commit messages.
- `overviews/out/` is never written by any new code. It is the source of what is deployed today.
- Scope is `l4d_vs_farm01_hilltop` only. No other map is captured, stitched, converted or deployed.
- Framing (camera x/y, engine scale, capture size) and cut heights come from the map's existing layer JSONs in `out/`, never from `compute_framing`.
- `setpos z = cut_height - 62`; `getpos` reports eye z, 62 above `setpos` z.
- Capture tile size is 2048x1271; stitched layers are 4096x2542.
- Settle 120 frames after each camera move, 30 frames after each screenshot, 3000 frames before the first shot.
- Log markers are single tokens: `OV_RUN_BEGIN`, `OV_RUN_DONE`. Spawn signal: `Redownloading all lightmaps`.
- Process matching always uses the bracket pattern `[l]eft4dead\.exe`.
- 4x file names carry `.4x` before the extension: `<map>_z<+NNNN>.4x.png`, `.4x.json`, `.4x.webp`.
- Void: `R+G+B < 12`, or `R <= 8 and B <= 8 and G >= 240`.
- No new dependencies. Everything above is already installed.
- Never deploy, restart or rcon the Dallas box without the owner's go-ahead at that moment. The web deploy runs only with 0 humans on the game server.
- Do not push either repo to GitHub unless the owner asks.
- Match the surrounding code: explanatory comments that say why, not what. `overviews` commits use plain sentence subjects; pug commits use `type(scope): subject`.
- Tasks 7 and 9 are operator tasks: they need the owner at the workstation and are run by the coordinating session, not by a subagent. No subagent runs `runner.py`, launches the game, or deploys.

## File Structure

`/home/volence/l4d/overviews` (git repo, branch `main`):

| file | status | responsibility |
|---|---|---|
| `pytest.ini` | create | test discovery and import path |
| `tests/conftest.py` | create | writes a synthetic 1x capture with farm01's real numbers |
| `plan.py` | create | framing from the existing capture, tile geometry, shot list, command chain, command validation |
| `runlog.py` | create | parse `console.log`: begin/done markers, ordered poses, refusals |
| `verdict.py` | create | judge one attempt directory against its plan |
| `desktop.py` | create | KWin scripts (place, focus, journal) and the uinput keyboard |
| `runner.py` | create | preflight, attempt loop, trigger timing, cleanup proof, retries |
| `stitch.py` | create | tile offsets, stitching, void cleanup, dip fill, `out4x/` output |
| `verify.py` | modify | expose `sample()` and `score()`; CLI output unchanged |
| `acceptance.py` | create | geometry, seams, entity and crop checks against `out/` |
| `MAP_OVERVIEWS.md` | modify | document the `out4x/` set |
| `spike_*.py`, `spike_wait.sh`, `gen_spike_cfg.py` | delete | superseded by `runner.py` |
| `tests/test_plan.py`, `test_runlog.py`, `test_verdict.py`, `test_runner.py`, `test_stitch.py`, `test_verify.py`, `test_acceptance.py` | create | unit tests |

`/home/volence/l4d/pug` (git repo, branch `master`):

| file | status | responsibility |
|---|---|---|
| `tests/mapOverviews.test.ts` | modify | pin farm01 at 4x, every other map at 1x, one size per map |
| `tools/gen-overviews.py` | modify | `--override DIR`, known-size set, notification mask only on 1x |
| `tools/convert-overviews.sh` | modify | override directory; re-encode only overridden maps |
| `src/mapOverviews.ts` | regenerate | never hand-edited |
| `web/public/overviews/l4d_vs_farm01_hilltop_z*.webp` | replace | 5 `.4x.webp` in place of 5 `.webp` |
| `docs/superpowers/specs/2026-09-16-overview-tiled-recapture-design.md` | modify | record measured acceptance numbers |

---

### Task 1: Shot planning and the command chain (`plan.py`)

**Files:**
- Create: `/home/volence/l4d/overviews/pytest.ini`
- Create: `/home/volence/l4d/overviews/tests/conftest.py`
- Create: `/home/volence/l4d/overviews/plan.py`
- Test: `/home/volence/l4d/overviews/tests/test_plan.py`

**Interfaces:**
- Consumes: `out/<map>.layers.json` and each layer's `out/<stem>.json` (fields `camera`, `engine_scale`, `image_w`, `image_h`, `cut_height`); `cvars_l4d1.txt`.
- Produces (used by Tasks 2, 4, 5, 6):
  - constants `EYE = 62.0`, `SETTLE = 120`, `AFTER_SHOT = 30`, `FADE = 3000`, `QUADRANTS = ('tl', 'tr', 'bl', 'br')`, `HERE`, `OUT`, `RUNS`
  - `Framing(map: str, cx: float, cy: float, scale: float, w: int, h: int, cut_heights: tuple[float, ...])` frozen dataclass
  - `Shot(index: int, layer: int, cut_height: float, quadrant: str, x: float, y: float, z: float, scale: float)` frozen dataclass; `quadrant` is one of `QUADRANTS` or `'control'`
  - `load_framing(out_dir: str, name: str) -> Framing`, raises `ValueError`
  - `spans(f) -> (span_x, span_y)`, `world_upper_left(f) -> (ulx, uly)`, `units_per_pixel_4x(f) -> float`, `tile_centre(f, quadrant) -> (x, y)`
  - `shots(f) -> list[Shot]`: layers ascending, `tl, tr, bl, br` per layer, then one control shot repeating shot 0
  - `plan_json(f, shot_list) -> dict` with keys `map`, `framing` (asdict, `cut_heights` a list), `world_upper_left` `[ulx, uly]`, `units_per_pixel`, `canvas` `[2w, 2h]`, `shots` (list of asdict)
  - `chain_cfg(f, shot_list) -> str`; F9 bound to `ov_r_s0`
  - `known_commands(path=...) -> set[str]`, `unknown_commands(cfg_text, known) -> set[str]`

- [ ] **Step 1: Create the test harness**

`/home/volence/l4d/overviews/pytest.ini`:

```ini
[pytest]
testpaths = tests
pythonpath = .
```

`/home/volence/l4d/overviews/tests/conftest.py`:

```python
"""Shared fixtures. The numbers are Blood Harvest 1's real 2026-09-12 capture."""
import json
import os

import pytest

NAME = 'l4d_vs_farm01_hilltop'
CUTS = (326.0, 582.0, 838.0, 1406.0, 2270.0)
CAMERA = (-9122.0, -10907.0)
SCALE = 9.0
SIZE = (2048, 1271)
UPP_1X = 7.250983477576711


def write_capture(root, name=NAME, cuts=CUTS, camera=CAMERA, scale=SCALE, size=SIZE):
    """Write a 1x capture's manifest and layer JSONs the way finish.py does."""
    upp = 1024.0 * scale / size[1]
    layers = []
    for cut in cuts:
        stem = '%s_z%+05d' % (name, round(cut))
        meta = {
            'map': name, 'image': stem + '.png',
            'image_w': size[0], 'image_h': size[1],
            'engine_scale': scale, 'units_per_pixel': upp,
            'world_upper_left': [-16547.0, -6299.0],
            'camera': [camera[0], camera[1], cut], 'cut_height': cut,
        }
        with open(os.path.join(root, stem + '.json'), 'w') as fh:
            json.dump(meta, fh)
        layers.append({'image': stem + '.png', 'cut_height': cut,
                       'units_per_pixel': upp, 'world_upper_left': [-16547.0, -6299.0]})
    with open(os.path.join(root, name + '.layers.json'), 'w') as fh:
        json.dump({'map': name, 'aligned': True, 'layers': layers}, fh)
    return str(root)


@pytest.fixture
def farm01(tmp_path):
    return write_capture(tmp_path)
```

- [ ] **Step 2: Write the failing tests**

`/home/volence/l4d/overviews/tests/test_plan.py`:

```python
import json
import os
import re

import pytest

import plan
from conftest import CAMERA, CUTS, NAME, SCALE, SIZE, UPP_1X, write_capture


def test_framing_comes_from_the_recorded_capture(farm01):
    f = plan.load_framing(farm01, NAME)
    assert (f.cx, f.cy) == CAMERA
    assert f.scale == SCALE
    assert (f.w, f.h) == SIZE
    assert f.cut_heights == CUTS


def test_refuses_a_map_with_no_capture(tmp_path):
    with pytest.raises(ValueError, match='no existing capture'):
        plan.load_framing(str(tmp_path), NAME)


def test_refuses_layers_that_disagree_on_the_camera(farm01):
    path = os.path.join(farm01, '%s_z+0582.json' % NAME)
    meta = json.load(open(path))
    meta['camera'][0] += 4
    json.dump(meta, open(path, 'w'))
    with pytest.raises(ValueError, match='camera'):
        plan.load_framing(farm01, NAME)


def test_4x_transform_keeps_the_1x_corner_and_halves_the_scale(farm01):
    f = plan.load_framing(farm01, NAME)
    ulx, uly = plan.world_upper_left(f)
    assert ulx == pytest.approx(-16547.0, abs=0.5)
    assert uly == pytest.approx(-6299.0, abs=0.5)
    assert plan.units_per_pixel_4x(f) == pytest.approx(UPP_1X / 2)


def test_every_tile_lands_exactly_on_the_2x2_grid(farm01):
    f = plan.load_framing(farm01, NAME)
    upp = plan.units_per_pixel_4x(f)
    ulx, uly = plan.world_upper_left(f)
    seen = set()
    for s in plan.shots(f)[:4]:
        # the tile's own units per pixel must equal the canvas's, or pasting would need resampling
        assert 1024.0 * s.scale / f.h == pytest.approx(upp)
        px = (s.x - f.w * upp / 2 - ulx) / upp
        py = (uly - (s.y + f.h * upp / 2)) / upp
        assert px == pytest.approx(round(px), abs=1e-6)
        assert py == pytest.approx(round(py), abs=1e-6)
        seen.add((round(px), round(py)))
    assert seen == {(0, 0), (f.w, 0), (0, f.h), (f.w, f.h)}


def test_shot_list_walks_layers_then_ends_with_a_control(farm01):
    f = plan.load_framing(farm01, NAME)
    shot_list = plan.shots(f)
    assert len(shot_list) == 4 * len(CUTS) + 1
    assert [s.index for s in shot_list] == list(range(len(shot_list)))
    assert [s.quadrant for s in shot_list[:4]] == ['tl', 'tr', 'bl', 'br']
    assert shot_list[4].layer == 1
    for s in shot_list[:-1]:
        assert s.z == s.cut_height - plan.EYE
        assert s.scale == SCALE / 2
    control, first = shot_list[-1], shot_list[0]
    assert control.quadrant == 'control'
    assert (control.x, control.y, control.z, control.scale) == (first.x, first.y, first.z, first.scale)


def test_plan_json_round_trips(farm01):
    f = plan.load_framing(farm01, NAME)
    p = json.loads(json.dumps(plan.plan_json(f, plan.shots(f))))
    assert p['map'] == NAME
    assert p['canvas'] == [4096, 2542]
    assert p['framing']['cut_heights'] == list(CUTS)
    assert len(p['shots']) == 21


def aliases(cfg):
    return dict(re.findall(r'^alias (\w+) "([^"]*)"$', cfg, re.M))


def test_chain_is_one_linked_list_from_f9_to_quit(farm01):
    f = plan.load_framing(farm01, NAME)
    shot_list = plan.shots(f)
    cfg = plan.chain_cfg(f, shot_list)
    table = aliases(cfg)
    assert re.search(r'^bind F9 ov_r_s0$', cfg, re.M)
    assert table['ov_r_s0'].startswith('unbind F9; echo OV_RUN_BEGIN')
    name, visited = 'ov_r_s0', []
    while name:
        visited.append(name)
        nxt = [t for t in (x.strip() for x in table[name].split(';')) if t.startswith('ov_r_')]
        name = nxt[0] if nxt else None
    assert visited[-1] == 'ov_r_end'
    assert table['ov_r_end'].endswith('quit')
    body = ' ; '.join(table[n] for n in visited)
    assert body.count('screenshot') == len(shot_list)
    assert body.count('getpos') == len(shot_list)
    assert 'noclip' in body and body.count('noclip') == 1


def test_chain_positions_still_land_on_the_grid_after_formatting(farm01):
    f = plan.load_framing(farm01, NAME)
    cfg = plan.chain_cfg(f, plan.shots(f))
    upp = plan.units_per_pixel_4x(f)
    ulx, uly = plan.world_upper_left(f)
    for x, y in re.findall(r'setpos (-?[\d.]+) (-?[\d.]+) ', cfg)[:4]:
        px = (float(x) - f.w * upp / 2 - ulx) / upp
        py = (uly - (float(y) + f.h * upp / 2)) / upp
        assert abs(px - round(px)) < 0.01 and abs(py - round(py)) < 0.01


def test_chain_uses_only_commands_l4d1_has_and_short_lines(farm01):
    f = plan.load_framing(farm01, NAME)
    cfg = plan.chain_cfg(f, plan.shots(f))
    assert plan.unknown_commands(cfg, plan.known_commands()) == set()
    assert max(len(line) for line in cfg.splitlines()) < 255


def test_unknown_commands_catches_a_typo():
    cfg = 'alias ov_r_s0 "noclip; mat_picmip -1; wait 3; ov_r_end"\n'
    assert plan.unknown_commands(cfg, plan.known_commands()) == {'mat_picmip'}
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `cd /home/volence/l4d/overviews && python3 -m pytest tests/test_plan.py -q`
Expected: collection error, `ModuleNotFoundError: No module named 'plan'`

- [ ] **Step 4: Write `plan.py`**

`/home/volence/l4d/overviews/plan.py`:

```python
#!/usr/bin/env python3
"""Plan a tiled 4x recapture of one map: the shot list and the command chain.

    ./plan.py l4d_vs_farm01_hilltop      writes runs/<map>/plan.json

Framing comes from the map's existing 1x capture in out/, not from
compute_framing. The 2026-09-12 session aligned Valve's upper-left corner rather
than the centre (farm01's camera is 2817 units east of compute_framing's), so
only the recorded camera keeps each 4x layer on the transform of the layer it
replaces.
"""
import json
import os
import re
import sys
from dataclasses import asdict, dataclass

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, 'out')
RUNS = os.path.join(HERE, 'runs')

EYE = 62.0          # getpos reports eye height, this far above the setpos z
SETTLE = 120        # frames after a camera move: 2 still shows the old view, 120 matches 960
AFTER_SHOT = 30     # frames for the screenshot to be written before the next move
FADE = 3000         # frames for the sv_cheats notification to fade before the first shot
QUADRANTS = ('tl', 'tr', 'bl', 'br')

# Console built-ins that `cvarlist` does not print. `wait` is proven by the
# 2026-09-16 spike; the rest are listed anyway but cost nothing to allow.
BUILTINS = {'alias', 'bind', 'unbind', 'echo', 'wait', 'quit'}


@dataclass(frozen=True)
class Framing:
    map: str
    cx: float
    cy: float
    scale: float
    w: int
    h: int
    cut_heights: tuple


@dataclass(frozen=True)
class Shot:
    index: int
    layer: int
    cut_height: float
    quadrant: str
    x: float
    y: float
    z: float
    scale: float


def load_framing(out_dir, name):
    """The framing the 1x set was really shot with, refusing anything inconsistent."""
    path = os.path.join(out_dir, name + '.layers.json')
    if not os.path.exists(path):
        raise ValueError('%s: no existing capture at %s' % (name, path))
    with open(path) as fh:
        manifest = json.load(fh)
    metas = []
    for layer in manifest['layers']:
        stem = os.path.splitext(layer['image'])[0]
        with open(os.path.join(out_dir, stem + '.json')) as fh:
            metas.append(json.load(fh))
    first = metas[0]
    for meta in metas[1:]:
        for key in ('engine_scale', 'image_w', 'image_h'):
            if meta[key] != first[key]:
                raise ValueError('%s: layers disagree on %s' % (name, key))
        if meta['camera'][:2] != first['camera'][:2]:
            raise ValueError('%s: layers disagree on camera x/y' % name)
    return Framing(
        map=name,
        cx=float(first['camera'][0]), cy=float(first['camera'][1]),
        scale=float(first['engine_scale']),
        w=int(first['image_w']), h=int(first['image_h']),
        cut_heights=tuple(sorted(float(m['cut_height']) for m in metas)),
    )


def spans(f):
    """World units covered by one full-scale frame. Vertical is always 1024*scale."""
    span_y = 1024.0 * f.scale
    return span_y * f.w / f.h, span_y


def world_upper_left(f):
    span_x, span_y = spans(f)
    return f.cx - span_x / 2, f.cy + span_y / 2


def units_per_pixel_4x(f):
    # A half-scale tile covers half the span in the same pixel count.
    return 1024.0 * f.scale / f.h / 2


def tile_centre(f, quadrant):
    span_x, span_y = spans(f)
    dx = -span_x / 4 if quadrant in ('tl', 'bl') else span_x / 4
    dy = span_y / 4 if quadrant in ('tl', 'tr') else -span_y / 4
    return f.cx + dx, f.cy + dy


def shots(f):
    out = []
    for layer, cut in enumerate(f.cut_heights):
        for quadrant in QUADRANTS:
            x, y = tile_centre(f, quadrant)
            out.append(Shot(len(out), layer, cut, quadrant, x, y, cut - EYE, f.scale / 2))
    first = out[0]
    # Re-shoot tile 0's pose last. If it is not pixel-identical, something changed
    # during the run: leftover notification text, exposure drift, a spawned entity.
    out.append(Shot(len(out), first.layer, first.cut_height, 'control',
                    first.x, first.y, first.z, first.scale))
    return out


def plan_json(f, shot_list):
    framing = asdict(f)
    framing['cut_heights'] = list(f.cut_heights)
    ulx, uly = world_upper_left(f)
    return {
        'map': f.map,
        'framing': framing,
        'world_upper_left': [ulx, uly],
        'units_per_pixel': units_per_pixel_4x(f),
        'canvas': [2 * f.w, 2 * f.h],
        'shots': [asdict(s) for s in shot_list],
    }


# Setup is split across aliases only to keep each console line short.
SETUP = [
    # unbind first: a second F9 must never start a second, interleaved chain
    'unbind F9; echo OV_RUN_BEGIN; sv_allow_wait_command 1; sv_cheats 1',
    'mat_fullbright 1; mat_dynamic_tonemapping 0; mat_hdr_uncapexposure 1; '
    'r_novis 1; r_portalsopenall 1; r_visocclusion 0; r_drawskybox 0',
    'fog_enable 0; fog_enableskybox 0; cl_drawhud 0; r_drawviewmodel 0; net_graph 0; '
    'crosshair 0; cl_crosshair_alpha 0; cl_crosshair_dynamic 0; cl_crosshair_thickness 0',
    # noclip exactly once: it is a toggle, and setpos is refused without it
    'director_stop; nb_delete_all; z_common_limit 0; sb_stop 1; noclip; wait %d' % FADE,
]


def chain_cfg(f, shot_list):
    """One alias per step, each naming the next, started by F9 and ending in quit.

    No alias defined anywhere else is referenced and nothing is latched: a
    latched alias silently skipped noclip during the spike.
    """
    names = (['ov_r_s%d' % i for i in range(len(SETUP))]
             + ['ov_r_%03d' % s.index for s in shot_list] + ['ov_r_end'])
    bodies = list(SETUP)
    for s in shot_list:
        bodies.append('setpos %.3f %.3f %.3f; setang 0 90 0; cl_leveloverview %.2f; '
                      'wait %d; getpos; screenshot; wait %d'
                      % (s.x, s.y, s.z, s.scale, SETTLE, AFTER_SHOT))
    bodies.append('echo OV_RUN_DONE; wait 120; quit')
    lines = ['// Tiled 4x capture chain for %s. Generated by plan.py; do not edit.' % f.map,
             '// F9 starts it. Its first command unbinds F9, so a second press is inert.']
    for i, (name, body) in enumerate(zip(names, bodies)):
        nxt = '; ' + names[i + 1] if i + 1 < len(names) else ''
        lines.append('alias %s "%s%s"' % (name, body, nxt))
    lines.append('bind F9 %s' % names[0])
    lines.append('echo "[OV] armed %s: %d shots, press F9"' % (f.map, len(shot_list)))
    return '\n'.join(lines) + '\n'


def known_commands(path=os.path.join(HERE, 'cvars_l4d1.txt')):
    with open(path) as fh:
        return set(fh.read().split())


def unknown_commands(cfg_text, known):
    """Commands L4D1 does not have. It ignores them silently, so check up front."""
    bad = set()
    for m in re.finditer(r'^alias \w+\s+"([^"]*)"', cfg_text, re.M):
        for statement in m.group(1).split(';'):
            tokens = statement.split()
            if not tokens:
                continue
            cmd = tokens[0]
            if cmd.startswith('ov_') or cmd in BUILTINS or cmd in known:
                continue
            bad.add(cmd)
    return bad


def main(argv):
    if len(argv) != 2:
        print('usage: plan.py <map>')
        return 2
    name = argv[1]
    f = load_framing(OUT, name)
    shot_list = shots(f)
    bad = unknown_commands(chain_cfg(f, shot_list), known_commands())
    if bad:
        print('commands L4D1 does not have: %s' % sorted(bad))
        return 1
    mdir = os.path.join(RUNS, name)
    os.makedirs(mdir, exist_ok=True)
    with open(os.path.join(mdir, 'plan.json'), 'w') as fh:
        json.dump(plan_json(f, shot_list), fh, indent=2)
    ulx, uly = world_upper_left(f)
    print('%s: %d layers, %d tiles + 1 control, scale %.2f -> %.2f'
          % (name, len(f.cut_heights), len(shot_list) - 1, f.scale, f.scale / 2))
    print('  canvas %dx%d at %.4f u/px, upper-left %.3f %.3f'
          % (2 * f.w, 2 * f.h, units_per_pixel_4x(f), ulx, uly))
    print('  wrote %s' % os.path.join(mdir, 'plan.json'))
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv))
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd /home/volence/l4d/overviews && python3 -m pytest tests/test_plan.py -q`
Expected: `11 passed`

- [ ] **Step 6: Run the CLI against the real capture**

Run: `cd /home/volence/l4d/overviews && python3 plan.py l4d_vs_farm01_hilltop`
Expected:
```
l4d_vs_farm01_hilltop: 5 layers, 20 tiles + 1 control, scale 9.00 -> 4.50
  canvas 4096x2542 at 3.6255 u/px, upper-left -16547.007 -6299.000
  wrote /home/volence/l4d/overviews/runs/l4d_vs_farm01_hilltop/plan.json
```

- [ ] **Step 7: Commit**

```bash
cd /home/volence/l4d/overviews
git add pytest.ini tests/conftest.py tests/test_plan.py plan.py
git commit -m "Plan tiled 4x shots and the capture command chain

Framing and cut heights come from each map's recorded 1x capture, so every
4x layer keeps the transform of the layer it replaces. The chain is a
single linked list of aliases from F9 to quit that unbinds F9 first and
toggles noclip exactly once."
```

---

### Task 2: Reading the log and judging an attempt (`runlog.py`, `verdict.py`)

**Files:**
- Create: `/home/volence/l4d/overviews/runlog.py`
- Create: `/home/volence/l4d/overviews/verdict.py`
- Test: `/home/volence/l4d/overviews/tests/test_runlog.py`
- Test: `/home/volence/l4d/overviews/tests/test_verdict.py`

**Interfaces:**
- Consumes: `plan.EYE`, `plan.Framing`, `plan.shots`, `plan.plan_json` (Task 1).
- Produces (used by Tasks 4, 5):
  - `runlog.BEGIN = 'OV_RUN_BEGIN'`, `runlog.DONE = 'OV_RUN_DONE'`, `runlog.SPAWNED = 'Redownloading all lightmaps'`, `runlog.REFUSED = 'setpos into world'`
  - `runlog.RunLog` dataclass: `begins: int`, `done: bool`, `poses: list[tuple[float x6]]` (x, y, z, pitch, yaw, roll), `refusals: int`
  - `runlog.parse(text: str) -> RunLog`
  - `verdict.tga_size(path) -> (w, h) | None`
  - `verdict.tiles_in(directory, map_name) -> list[str]` sorted file names
  - `verdict.judge(p: dict, attempt_dir: str) -> dict` with keys `ok: bool`, `reasons: list[str]`, `tiles: list[str]`, `poses: list[list[float]]`, `max_pos_error: float`, `tile_sizes: list[list[int]]`, `control_identical: bool | None`

- [ ] **Step 1: Write the failing tests**

`/home/volence/l4d/overviews/tests/test_runlog.py`:

```python
import runlog

REAL = """\
Host_NewGame on map l4d_vs_farm01_hilltop
setpos 0.000000 0.000000 0.000000;setang 0.000000 0.000000 0.000000
Redownloading all lightmaps
OV_RUN_BEGIN
noclip ON
setpos into world, use noclip to unstick yourself!
Overview: scale 4.50, pos_x -16547, pos_y -6299
setpos -12834.503906 -8603.000000 264.000000;setang 0.000000 90.000000 0.000000
setpos -5409.496094 -8603.000000 264.000000;setang 0.024200 90.000000 0.000000
OV_RUN_DONE
"""


def test_poses_are_only_those_after_the_begin_marker():
    log = runlog.parse(REAL)
    assert log.begins == 1
    assert log.done is True
    assert log.poses == [
        (-12834.503906, -8603.0, 264.0, 0.0, 90.0, 0.0),
        (-5409.496094, -8603.0, 264.0, 0.0242, 90.0, 0.0),
    ]


def test_counts_refusals_after_begin():
    assert runlog.parse(REAL).refusals == 1


def test_a_log_that_never_began_has_nothing():
    log = runlog.parse('Redownloading all lightmaps\nsetpos 1 2 3;setang 0 90 0\n')
    assert (log.begins, log.done, log.poses, log.refusals) == (0, False, [], 0)


def test_counts_a_second_begin():
    assert runlog.parse('OV_RUN_BEGIN\nOV_RUN_BEGIN\n').begins == 2
```

`/home/volence/l4d/overviews/tests/test_verdict.py`:

```python
import os

from PIL import Image

import plan
import verdict


def tiny_plan():
    f = plan.Framing('m_test', 0.0, 0.0, 1.0, 8, 6, (100.0, 200.0))
    return plan.plan_json(f, plan.shots(f))


def pose_line(shot, dz=0.0, yaw=90.0):
    return ('setpos %.6f %.6f %.6f;setang 0.000000 %.6f 0.000000'
            % (shot['x'], shot['y'], shot['z'] + plan.EYE + dz, yaw))


def make_attempt(d, p, *, lines=None, tiles=None, size=(8, 6),
                 control=(10, 20, 30), begins=1, done=True):
    shots = p['shots']
    if lines is None:
        lines = ['Redownloading all lightmaps'] + ['OV_RUN_BEGIN'] * begins
        lines += [pose_line(s) for s in shots]
        if done:
            lines.append('OV_RUN_DONE')
    with open(os.path.join(d, 'console.log'), 'w') as fh:
        fh.write('\n'.join(lines) + '\n')
    count = len(shots) if tiles is None else tiles
    for i in range(count):
        if i == len(shots) - 1:
            color = control
        elif i == 0:
            color = (10, 20, 30)
        else:
            color = (i, i, i)
        Image.new('RGB', size, color).save(os.path.join(d, '%s%04d.tga' % (p['map'], i)))
    return str(d)


def test_a_clean_attempt_passes(tmp_path):
    p = tiny_plan()
    v = verdict.judge(p, make_attempt(tmp_path, p))
    assert v['ok'], v['reasons']
    assert v['control_identical'] is True
    assert len(v['tiles']) == 9 and len(v['poses']) == 9
    assert v['tile_sizes'] == [[8, 6]]


def test_two_begins_fail(tmp_path):
    p = tiny_plan()
    v = verdict.judge(p, make_attempt(tmp_path, p, begins=2))
    assert not v['ok']
    assert any('began 2 times' in r for r in v['reasons'])


def test_missing_done_fails(tmp_path):
    p = tiny_plan()
    assert not verdict.judge(p, make_attempt(tmp_path, p, done=False))['ok']


def test_a_refused_setpos_fails(tmp_path):
    p = tiny_plan()
    lines = (['OV_RUN_BEGIN', 'setpos into world, use noclip to unstick yourself!']
             + [pose_line(s) for s in p['shots']] + ['OV_RUN_DONE'])
    v = verdict.judge(p, make_attempt(tmp_path, p, lines=lines))
    assert any('noclip' in r for r in v['reasons'])


def test_a_missing_tile_fails(tmp_path):
    p = tiny_plan()
    v = verdict.judge(p, make_attempt(tmp_path, p, tiles=8))
    assert any('8 tiles, expected 9' in r for r in v['reasons'])


def test_a_camera_off_plan_fails(tmp_path):
    p = tiny_plan()
    lines = ['OV_RUN_BEGIN'] + [pose_line(s, dz=1.0 if s['index'] == 3 else 0.0)
                                for s in p['shots']] + ['OV_RUN_DONE']
    v = verdict.judge(p, make_attempt(tmp_path, p, lines=lines))
    assert any('off plan' in r for r in v['reasons'])


def test_a_wrong_view_angle_fails(tmp_path):
    p = tiny_plan()
    lines = ['OV_RUN_BEGIN'] + [pose_line(s, yaw=175.0 if s['index'] == 2 else 90.0)
                                for s in p['shots']] + ['OV_RUN_DONE']
    v = verdict.judge(p, make_attempt(tmp_path, p, lines=lines))
    assert any('shot 2 looked at' in r for r in v['reasons'])


def test_wrong_tile_size_fails(tmp_path):
    p = tiny_plan()
    v = verdict.judge(p, make_attempt(tmp_path, p, size=(7, 6)))
    assert any('tile sizes' in r for r in v['reasons'])
    assert v['control_identical'] is None


def test_a_control_that_differs_fails(tmp_path):
    p = tiny_plan()
    v = verdict.judge(p, make_attempt(tmp_path, p, control=(11, 20, 30)))
    assert v['control_identical'] is False
    assert any('control shot' in r for r in v['reasons'])


def test_tga_size_is_none_for_a_file_still_being_written(tmp_path):
    path = tmp_path / 'partial.tga'
    path.write_bytes(b'\x00' * 10)
    assert verdict.tga_size(str(path)) is None
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd /home/volence/l4d/overviews && python3 -m pytest tests/test_runlog.py tests/test_verdict.py -q`
Expected: collection errors, `No module named 'runlog'` and `No module named 'verdict'`

- [ ] **Step 3: Write `runlog.py`**

`/home/volence/l4d/overviews/runlog.py`:

```python
"""Read what a capture chain actually did, out of console.log.

console.log has no timestamps and Source can reorder words within a line, so
everything here keys on single-token markers and on getpos output, which the
chain prints exactly once per shot.
"""
import re
from dataclasses import dataclass, field

BEGIN = 'OV_RUN_BEGIN'
DONE = 'OV_RUN_DONE'
SPAWNED = 'Redownloading all lightmaps'      # the client is in the world and rendering
REFUSED = 'setpos into world'                 # noclip was off, so the move was refused

RE_GETPOS = re.compile(
    r'^setpos\s+(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s*;\s*'
    r'setang\s+(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)')


@dataclass
class RunLog:
    begins: int = 0
    done: bool = False
    poses: list = field(default_factory=list)
    refusals: int = 0


def parse(text):
    """Poses, refusals and completion, counting only what follows OV_RUN_BEGIN.

    Anything before it belongs to loading: getpos there reports the origin
    because the player has not spawned.
    """
    log = RunLog()
    for raw in text.splitlines():
        line = raw.strip()
        if BEGIN in line:
            log.begins += 1
            continue
        if not log.begins:
            continue
        if DONE in line:
            log.done = True
        elif REFUSED in line:
            log.refusals += 1
        else:
            m = RE_GETPOS.match(line)
            if m:
                log.poses.append(tuple(float(g) for g in m.groups()))
    return log
```

- [ ] **Step 4: Write `verdict.py`**

`/home/volence/l4d/overviews/verdict.py`:

```python
"""Decide whether one capture attempt is good enough to stitch.

Pairs the plan with what really happened, by order: shot N is the Nth getpos
after OV_RUN_BEGIN and the Nth screenshot of the session.
"""
import os
import struct

from PIL import Image, ImageChops

import plan
import runlog

POS_TOL = 0.5      # world units; setpos is exact under noclip, this only absorbs float noise
ANGLE_TOL = 1.0    # degrees; the ortho render ignores view angles, so only gross drift matters


def tga_size(path):
    """(width, height) from a TGA header, or None while the file is still too short."""
    try:
        with open(path, 'rb') as fh:
            head = fh.read(18)
    except OSError:
        return None
    if len(head) < 18:
        return None
    return struct.unpack_from('<HH', head, 12)


def tiles_in(directory, map_name):
    """The engine names shots <map>NNNN.tga, numbered from 0000 each session."""
    return sorted(f for f in os.listdir(directory)
                  if f.startswith(map_name) and f.endswith('.tga'))


def judge(p, attempt_dir):
    shots = p['shots']
    want = (p['framing']['w'], p['framing']['h'])
    reasons = []

    text = ''
    log_path = os.path.join(attempt_dir, 'console.log')
    if os.path.exists(log_path):
        with open(log_path, errors='replace') as fh:
            text = fh.read()
    rl = runlog.parse(text)
    if rl.begins != 1:
        reasons.append('chain began %d times, expected 1' % rl.begins)
    if not rl.done:
        reasons.append('chain never reached %s' % runlog.DONE)
    if rl.refusals:
        reasons.append('%d setpos refused, so noclip was off' % rl.refusals)

    tiles = tiles_in(attempt_dir, p['map'])
    if len(tiles) != len(shots):
        reasons.append('%d tiles, expected %d' % (len(tiles), len(shots)))
    if len(rl.poses) != len(shots):
        reasons.append('%d getpos lines, expected %d' % (len(rl.poses), len(shots)))

    worst = 0.0
    for shot, pose in zip(shots, rl.poses):
        err = max(abs(pose[0] - shot['x']), abs(pose[1] - shot['y']),
                  abs(pose[2] - (shot['z'] + plan.EYE)))
        worst = max(worst, err)
        if abs(pose[3]) > ANGLE_TOL or abs(pose[4] - 90.0) > ANGLE_TOL:
            reasons.append('shot %d looked at %.2f %.2f, expected 0 90'
                           % (shot['index'], pose[3], pose[4]))
    if worst > POS_TOL:
        reasons.append('camera off plan by up to %.3f units' % worst)

    raw_sizes = [tga_size(os.path.join(attempt_dir, t)) for t in tiles]
    if any(s is None for s in raw_sizes):
        reasons.append('unreadable tile header')
    sizes = sorted({s for s in raw_sizes if s})
    if tiles and sizes != [want]:
        reasons.append('tile sizes %s, expected %s' % (sizes, want))

    control_identical = None
    if len(tiles) == len(shots) and len(tiles) >= 2 and sizes == [want]:
        first = Image.open(os.path.join(attempt_dir, tiles[0])).convert('RGB')
        control = Image.open(os.path.join(attempt_dir, tiles[-1])).convert('RGB')
        control_identical = ImageChops.difference(first, control).getbbox() is None
        if not control_identical:
            reasons.append('control shot differs from tile 0')

    return {
        'ok': not reasons,
        'reasons': reasons,
        'tiles': tiles,
        'poses': [list(pose) for pose in rl.poses],
        'max_pos_error': worst,
        'tile_sizes': [list(s) for s in sizes],
        'control_identical': control_identical,
    }
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd /home/volence/l4d/overviews && python3 -m pytest tests/test_runlog.py tests/test_verdict.py -q`
Expected: `14 passed`

- [ ] **Step 6: Commit**

```bash
cd /home/volence/l4d/overviews
git add runlog.py verdict.py tests/test_runlog.py tests/test_verdict.py
git commit -m "Judge a capture attempt from its console.log and tiles

Checks the chain ran exactly once to completion, noclip held, every camera
pose matched the plan, every tile is the capture size, and a control shot
re-taken at the end is pixel-identical to the first tile."
```

---

### Task 3: Desktop control (`desktop.py`)

**Files:**
- Create: `/home/volence/l4d/overviews/desktop.py`

**Interfaces:**
- Consumes: nothing from other tasks.
- Produces (used by Task 4):
  - `PLACE_JS: str`, `FOCUS_JS: str`
  - `load(name: str, source: str, script_dir: str) -> None` (raises `RuntimeError`), `unload(name: str) -> None`
  - `kwin_available() -> bool`, `uinput_writable() -> bool`
  - `focus_game(script_dir: str) -> None`
  - `save_journal(since: float, path: str) -> None`
  - `Keyboard()` with `press_f9() -> None` and `close() -> None`

This module is the thin side-effect layer and has no unit tests; Step 2 is a smoke check against the live desktop. It needs the owner's KDE session, but not the game.

- [ ] **Step 1: Write `desktop.py`**

`/home/volence/l4d/overviews/desktop.py`:

```python
"""The only parts of a capture run that touch the desktop: KWin and a virtual keyboard.

KWin's focus-stealing prevention stops a freshly launched window from taking
focus, and a synthetic key goes to whatever window has it. So every keypress is
preceded by a KWin script that activates the game window explicitly.
"""
import os
import subprocess
import time

KWIN = ['qdbus6', 'org.kde.KWin', '/Scripting']

# A window created on the 1080p output (DP-2) captures at 1920x1080; the
# 2026-09-12 set came from DP-1, the 2844x1600 logical 4K panel.
PLACE_JS = r"""
const CAPTION = "Left 4 Dead", TARGET = "DP-1";
function place(w) {
    if (!w || !w.caption || w.caption.indexOf(CAPTION) === -1) return;
    const out = workspace.screens.find(o => o.name === TARGET);
    if (out && w.output !== out) workspace.sendClientToScreen(w, out);
    workspace.activeWindow = w;
    console.info("ov-place: '" + w.caption + "' on " + (w.output ? w.output.name : "?")
                 + " " + w.width + "x" + w.height);
}
// Wine can title the window after creating it, so watch the caption too.
function watch(w) { place(w); w.captionChanged.connect(() => place(w)); }
workspace.windowAdded.connect(watch);
for (const w of workspace.windowList()) watch(w);
"""

FOCUS_JS = r"""
let found = false;
for (const w of workspace.windowList()) {
    if (w.caption && w.caption.indexOf("Left 4 Dead") !== -1) {
        workspace.activeWindow = w;
        found = true;
        console.info("ov-focus: activated '" + w.caption + "' " + w.width + "x" + w.height
                     + " on " + (w.output ? w.output.name : "?"));
    }
}
if (!found) console.info("ov-focus: no Left 4 Dead window");
"""


def _kwin(*args):
    return subprocess.run(KWIN + list(args), capture_output=True, text=True, timeout=10)


def load(name, source, script_dir):
    """Load and start a KWin script, replacing any earlier one of the same name."""
    os.makedirs(script_dir, exist_ok=True)
    path = os.path.join(script_dir, name + '.js')
    with open(path, 'w') as fh:
        fh.write(source)
    _kwin('org.kde.kwin.Scripting.unloadScript', name)
    r = _kwin('org.kde.kwin.Scripting.loadScript', path, name)
    if r.returncode != 0:
        raise RuntimeError('KWin refused script %s: %s' % (name, r.stderr.strip()))
    _kwin('org.kde.kwin.Scripting.start')


def unload(name):
    _kwin('org.kde.kwin.Scripting.unloadScript', name)


def kwin_available():
    try:
        return _kwin('org.kde.kwin.Scripting.isScriptLoaded', 'ov_probe').returncode == 0
    except (OSError, subprocess.TimeoutExpired):
        return False


def uinput_writable():
    return os.access('/dev/uinput', os.W_OK)


def focus_game(script_dir):
    load('ov_focus', FOCUS_JS, script_dir)
    time.sleep(0.3)
    unload('ov_focus')


def save_journal(since, path):
    """What KWin's scripts reported during an attempt: which output, what size."""
    r = subprocess.run(['journalctl', '--since', '@%d' % int(since), '--no-pager',
                        '-o', 'short-iso', '-g', 'ov-(place|focus)'],
                       capture_output=True, text=True)
    with open(path, 'w') as fh:
        fh.write(r.stdout)


class Keyboard:
    """A uinput device that can press F9. Create it once, well before first use."""

    def __init__(self):
        from evdev import UInput, ecodes
        self._codes = ecodes
        self._ui = UInput({ecodes.EV_KEY: [ecodes.KEY_F9]}, name='ov-capture-keyboard')
        time.sleep(2.0)      # a fresh device takes a moment to be picked up

    def press_f9(self):
        e = self._codes
        self._ui.write(e.EV_KEY, e.KEY_F9, 1)
        self._ui.syn()
        time.sleep(0.06)
        self._ui.write(e.EV_KEY, e.KEY_F9, 0)
        self._ui.syn()

    def close(self):
        self._ui.close()
```

- [ ] **Step 2: Smoke check on the live desktop (game not running)**

Run:
```bash
cd /home/volence/l4d/overviews && python3 - <<'EOF'
import time, desktop
print('kwin', desktop.kwin_available(), 'uinput', desktop.uinput_writable())
t = time.time()
desktop.focus_game('runs/kwin')
desktop.load('ov_place', desktop.PLACE_JS, 'runs/kwin'); time.sleep(0.5); desktop.unload('ov_place')
time.sleep(1)
desktop.save_journal(t, 'runs/kwin/smoke.log')
print(open('runs/kwin/smoke.log').read())
kb = desktop.Keyboard(); kb.close(); print('keyboard ok')
EOF
```
Expected: `kwin True uinput True`, a journal line containing `ov-focus: no Left 4 Dead window`, and `keyboard ok`. No `ov-place` line is expected with the game closed. If `kwin` is `False`, run `qdbus6 org.kde.KWin /Scripting` and use the method name it lists for checking a loaded script in `kwin_available()`.

- [ ] **Step 3: Commit**

```bash
cd /home/volence/l4d/overviews
git add desktop.py
git commit -m "Add KWin and uinput control for unattended capture

Places the game window on DP-1 when it appears, activates it before each
keypress so focus-stealing prevention cannot swallow the key, and presses
F9 through a uinput virtual keyboard."
```

---

### Task 4: The unattended runner (`runner.py`)

**Files:**
- Create: `/home/volence/l4d/overviews/runner.py`
- Test: `/home/volence/l4d/overviews/tests/test_runner.py`

**Interfaces:**
- Consumes: `plan.load_framing`, `plan.shots`, `plan.plan_json`, `plan.chain_cfg`, `plan.known_commands`, `plan.unknown_commands`, `plan.OUT`, `plan.RUNS`, `plan.FADE`, `plan.SETTLE`, `plan.AFTER_SHOT` (Task 1); `runlog.BEGIN`, `runlog.DONE`, `runlog.SPAWNED` (Task 2); `verdict.judge`, `verdict.tga_size` (Task 2); everything in `desktop` (Task 3); `profile.sh on|off`.
- Produces (used by Tasks 5 and 7):
  - `runs/<map>/plan.json`
  - `runs/<map>/attempt-N/` holding `<map>NNNN.tga`, `console.log`, `timeline.log`, `kwin.log`, `verdict.json`, and `before/` (whatever was parked)
  - `runs/<map>/verified`: one line, the passing attempt's directory name (for example `attempt-1`)
  - pure helpers under test: `Trigger`, `LogTail`, `chain_seconds(n_shots) -> float`, `snapshot(game_dir) -> dict`, `leftovers(game_dir, baseline) -> list[str]`, `next_attempt_dir(map_dir) -> str`

- [ ] **Step 1: Write the failing tests**

`/home/volence/l4d/overviews/tests/test_runner.py`:

```python
import os

import runner


def test_trigger_waits_for_spawn_then_settles_before_pressing():
    t = runner.Trigger(settle=3.0, patience=10.0)
    assert t.due(0.0) is None
    t.saw('Redownloading all lightmaps', 100.0)
    assert t.due(102.9) is None
    assert t.due(103.0) == 'press'


def test_trigger_presses_once_more_then_gives_up():
    t = runner.Trigger(settle=3.0, patience=10.0)
    t.saw('Redownloading all lightmaps', 0.0)
    t.pressed(3.0)
    assert t.due(12.9) is None
    assert t.due(13.0) == 'press'
    t.pressed(13.0)
    assert t.due(22.9) is None
    assert t.due(23.0) == 'fail'


def test_trigger_goes_quiet_once_the_chain_begins():
    t = runner.Trigger()
    t.saw('Redownloading all lightmaps', 0.0)
    t.pressed(3.0)
    t.saw('OV_RUN_BEGIN', 3.5)
    assert t.begun
    assert t.due(1000.0) is None


def test_log_tail_returns_only_complete_new_lines(tmp_path):
    path = tmp_path / 'console.log'
    path.write_text('one\ntw')
    tail = runner.LogTail(str(path))
    assert tail.read_lines() == ['one']
    with open(path, 'a') as fh:
        fh.write('o\r\nthree\n')
    assert tail.read_lines() == ['two', 'three']
    assert tail.read_lines() == []


def test_chain_seconds_scales_with_shots():
    assert runner.chain_seconds(21) > runner.chain_seconds(1) > 10.0


def fake_game(root, addons=('a.vpk', 'b.vpk'), modernhud=True):
    for sub in ('cfg', 'addons'):
        os.makedirs(os.path.join(root, sub), exist_ok=True)
    for name in addons:
        open(os.path.join(root, 'addons', name), 'w').close()
    lines = ['"GameInfo"', '{', '\tGame\tmodernhud' if modernhud else '', '\tGame\tleft4dead', '}']
    with open(os.path.join(root, 'gameinfo.txt'), 'w') as fh:
        fh.write('\n'.join(lines) + '\n')
    with open(os.path.join(root, 'cfg', 'config.cfg'), 'w') as fh:
        fh.write('bind "1" "slot1"\n')
    return str(root)


def test_a_restored_game_has_no_leftovers(tmp_path):
    game = fake_game(tmp_path)
    assert runner.leftovers(game, runner.snapshot(game)) == []


def test_leftovers_name_every_trace_of_a_capture(tmp_path):
    game = fake_game(tmp_path)
    baseline = runner.snapshot(game)
    # rewrite gameinfo.txt and config.cfg first, then plant the traces on top
    fake_game(tmp_path, addons=(), modernhud=False)
    os.remove(os.path.join(game, 'addons', 'b.vpk'))
    open(os.path.join(game, 'cfg', 'ov_run.cfg'), 'w').close()
    open(os.path.join(game, 'cfg', 'video.txt.ovbak'), 'w').close()
    with open(os.path.join(game, 'cfg', 'config.cfg'), 'a') as fh:
        fh.write('bind "F9" "ov_r_s0"\n')
    problems = ' | '.join(runner.leftovers(game, baseline))
    for expected in ('ov_run.cfg', 'video.txt.ovbak', 'ov_ binds', 'addons', 'modernhud'):
        assert expected in problems


def test_leftovers_catch_a_hook_cfg_like_the_spike_leaked(tmp_path):
    game = fake_game(tmp_path)
    baseline = runner.snapshot(game)
    with open(os.path.join(game, 'cfg', 'listenserver.cfg'), 'w') as fh:
        fh.write('echo "[HOOK] listenserver.cfg fired"\n')
    assert any('listenserver.cfg' in p for p in runner.leftovers(game, baseline))


def test_attempt_directories_count_up(tmp_path):
    first = runner.next_attempt_dir(str(tmp_path))
    assert os.path.basename(first) == 'attempt-1'
    os.makedirs(first)
    assert os.path.basename(runner.next_attempt_dir(str(tmp_path))) == 'attempt-2'
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd /home/volence/l4d/overviews && python3 -m pytest tests/test_runner.py -q`
Expected: collection error, `No module named 'runner'`

- [ ] **Step 3: Write `runner.py`**

`/home/volence/l4d/overviews/runner.py`:

```python
#!/usr/bin/env python3
"""Capture maps unattended: launch the game, press F9 once, verify, retry.

    ./runner.py l4d_vs_farm01_hilltop [more maps ...]

Keep your hands off the keyboard while it runs. Each map takes keyboard focus
for about a second when the chain starts, and a key typed elsewhere at that
moment lands in the game instead.
"""
import glob
import json
import os
import re
import shutil
import subprocess
import sys
import time

import desktop
import plan
import runlog
import verdict

HERE = os.path.dirname(os.path.abspath(__file__))
GAME_DIR = os.path.expanduser('~/.steam/steam/steamapps/common/left 4 dead/left4dead')
KWIN_DIR = os.path.join(plan.RUNS, 'kwin')
ATTEMPTS = 3
# Bracket pattern: without it pgrep -f matches its own command line.
GAME_PATTERN = r'[l]eft4dead\.exe'
SPAWN_TIMEOUT = 120.0
FPS = 300.0                # measured in overview mode by the spike


class AttemptFailed(Exception):
    """One attempt went wrong in a way a fresh launch might fix."""


class Trigger:
    """When to press F9: settle seconds after spawn, once more if the chain has
    not begun patience seconds later, then give up.

    A second press is always safe. The chain's first command unbinds F9, so if
    the first press did land, the second does nothing.
    """

    def __init__(self, settle=3.0, patience=10.0, max_presses=2):
        self.settle = settle
        self.patience = patience
        self.max_presses = max_presses
        self.spawned_at = None
        self.begun = False
        self.presses = 0
        self.last_press = None

    def saw(self, line, now):
        if self.spawned_at is None and runlog.SPAWNED in line:
            self.spawned_at = now
        if runlog.BEGIN in line:
            self.begun = True

    def due(self, now):
        """'press', 'fail', or None."""
        if self.begun or self.spawned_at is None:
            return None
        if self.presses == 0:
            return 'press' if now - self.spawned_at >= self.settle else None
        if now - self.last_press < self.patience:
            return None
        return 'press' if self.presses < self.max_presses else 'fail'

    def pressed(self, now):
        self.presses += 1
        self.last_press = now


class LogTail:
    """Complete lines appended to a file since the last read."""

    def __init__(self, path):
        self._fh = open(path, errors='replace')
        self._partial = ''

    def read_lines(self):
        chunk = self._fh.read()
        if not chunk:
            return []
        *lines, self._partial = (self._partial + chunk).split('\n')
        return [line.rstrip('\r') for line in lines]


class Timeline:
    """console.log has no timestamps, so stamp every line with wall-clock time as it arrives."""

    def __init__(self, path):
        self.t0 = time.time()
        self._fh = open(path, 'w')

    def note(self, msg):
        line = '%7.2f  %s' % (time.time() - self.t0, msg)
        self._fh.write(line + '\n')
        self._fh.flush()
        if msg.startswith('>>'):
            print(line, flush=True)

    def close(self):
        self._fh.close()


def chain_seconds(n_shots):
    """Rough wall-clock length of a chain: frames at FPS plus a second per screenshot write."""
    frames = plan.FADE + n_shots * (plan.SETTLE + plan.AFTER_SHOT) + 120
    return frames / FPS + n_shots * 1.0


def _has_modernhud(gameinfo):
    try:
        with open(gameinfo) as fh:
            return re.search(r'^\s*Game\s+modernhud\s*$', fh.read(), re.M) is not None
    except OSError:
        return False


def snapshot(game_dir):
    """The parts of the install a capture profile swaps, as they are right now."""
    return {
        'addons': sorted(os.path.basename(p) for p in glob.glob(os.path.join(game_dir, 'addons', '*.vpk'))),
        'modernhud': _has_modernhud(os.path.join(game_dir, 'gameinfo.txt')),
    }


def leftovers(game_dir, baseline):
    """Every way the game still differs from how the owner left it. Empty means clean."""
    problems = []
    cfg = os.path.join(game_dir, 'cfg')
    if os.path.exists(os.path.join(cfg, 'ov_run.cfg')):
        problems.append('cfg/ov_run.cfg still present')
    for bak in sorted(glob.glob(os.path.join(cfg, '*.ovbak')) + glob.glob(os.path.join(game_dir, '*.ovbak'))):
        problems.append('%s not restored' % os.path.basename(bak))
    # A hook cfg fires in normal play. The spike's own cleanup once restored its
    # listenserver.cfg from a backup of itself, so look for the markers, not names.
    for path in sorted(glob.glob(os.path.join(cfg, '*.cfg'))):
        if os.path.basename(path) in ('ov_run.cfg', 'config.cfg'):
            continue
        with open(path, errors='replace') as fh:
            text = fh.read()
        if 'OV_RUN_BEGIN' in text or '[HOOK]' in text:
            problems.append('capture hook left in cfg/%s' % os.path.basename(path))
    conf = os.path.join(cfg, 'config.cfg')
    if os.path.exists(conf):
        with open(conf, errors='replace') as fh:
            if re.search(r'^bind .*ov_', fh.read(), re.M):
                problems.append('ov_ binds left in config.cfg')
    now = snapshot(game_dir)
    if now['addons'] != baseline['addons']:
        problems.append('addons %s, expected %s' % (now['addons'], baseline['addons']))
    if now['modernhud'] != baseline['modernhud']:
        problems.append('modernhud mounted=%s, expected %s' % (now['modernhud'], baseline['modernhud']))
    return problems


def next_attempt_dir(map_dir):
    n = 1
    while os.path.exists(os.path.join(map_dir, 'attempt-%d' % n)):
        n += 1
    return os.path.join(map_dir, 'attempt-%d' % n)


def game_running():
    return subprocess.run(['pgrep', '-f', GAME_PATTERN], capture_output=True).returncode == 0


def kill_game():
    subprocess.run(['pkill', '-f', GAME_PATTERN], capture_output=True)
    for _ in range(60):
        if not game_running():
            return
        time.sleep(0.5)
    subprocess.run(['pkill', '-9', '-f', GAME_PATTERN], capture_output=True)


def profile(*args):
    subprocess.run([os.path.join(HERE, 'profile.sh'), *args], cwd=HERE, check=True,
                   stdout=subprocess.DEVNULL)


def move_into(dest, paths):
    os.makedirs(dest, exist_ok=True)
    for path in paths:
        shutil.move(path, os.path.join(dest, os.path.basename(path)))


def launch(map_name):
    # +sv_cheats on the launch line, so its "Server cvar changed" notification
    # shows during loading and has faded long before the first shot.
    subprocess.run(['steam', '-applaunch', '500', '-novid', '-console', '-condebug',
                    '-window', '-w', '2048', '-h', '1600',
                    '+sv_lan', '1', '+sv_cheats', '1', '+exec', 'ov_run.cfg', '+map', map_name],
                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


def watch(p, keyboard, timeline):
    """Drive one launched attempt until the game quits. Raises AttemptFailed."""
    log_path = os.path.join(GAME_DIR, 'console.log')
    shots_dir = os.path.join(GAME_DIR, 'screenshots')
    want = (p['framing']['w'], p['framing']['h'])
    deadline = time.time() + SPAWN_TIMEOUT
    trigger = Trigger()
    tail = None
    size_checked = False
    while True:
        now = time.time()
        if tail is None and os.path.exists(log_path):
            tail = LogTail(log_path)
        for line in (tail.read_lines() if tail else []):
            if 'Overview:' in line:          # printed every frame; keep the timeline readable
                continue
            timeline.note('LOG ' + line)
            trigger.saw(line, now)
            if runlog.BEGIN in line:
                timeline.note('>> chain began')
                deadline = now + 60 + 3 * chain_seconds(len(p['shots']))
            elif runlog.SPAWNED in line:
                timeline.note('>> in the world')
            elif runlog.DONE in line:
                timeline.note('>> chain done')

        action = trigger.due(now)
        if action == 'press':
            timeline.note('>> focusing the game and pressing F9')
            desktop.focus_game(KWIN_DIR)
            time.sleep(0.5)
            keyboard.press_f9()
            trigger.pressed(time.time())
        elif action == 'fail':
            raise AttemptFailed('F9 never started the chain')

        # Catch a wrong window size on the first tile, not after all of them.
        if not size_checked:
            first = sorted(glob.glob(os.path.join(shots_dir, p['map'] + '*.tga')))
            size = verdict.tga_size(first[0]) if first else None
            if size:
                size_checked = True
                timeline.note('>> first tile is %dx%d' % size)
                if size != want:
                    raise AttemptFailed('first tile is %dx%d, expected %dx%d' % (size + want))

        if trigger.begun and not game_running():
            timeline.note('>> game exited')
            return
        if now > deadline:
            raise AttemptFailed('timed out ' + ('capturing' if trigger.begun
                                                else 'waiting for the chain to start'))
        time.sleep(0.1)


def attempt(p, framing, shot_list, keyboard, baseline):
    map_dir = os.path.join(plan.RUNS, p['map'])
    attempt_dir = next_attempt_dir(map_dir)
    os.makedirs(attempt_dir)
    timeline = Timeline(os.path.join(attempt_dir, 'timeline.log'))
    shots_dir = os.path.join(GAME_DIR, 'screenshots')
    log_path = os.path.join(GAME_DIR, 'console.log')
    cfg_path = os.path.join(GAME_DIR, 'cfg', 'ov_run.cfg')
    since = time.time()
    failure = None

    def game_log():
        return [log_path] if os.path.exists(log_path) else []

    try:
        # Park strays so screenshot numbering starts at 0000 and the log is this run's.
        # Never into out/raw: its filenames collide with the 2026-09-12 captures.
        move_into(os.path.join(attempt_dir, 'before'),
                  glob.glob(os.path.join(shots_dir, '*.tga')) + game_log())
        # off first: `on` exits early as "already active" if a crash left backups.
        profile('off')
        profile('on', '2048', '1600')
        with open(cfg_path, 'w') as fh:
            fh.write(plan.chain_cfg(framing, shot_list))
        desktop.load('ov_place', desktop.PLACE_JS, KWIN_DIR)
        timeline.note('>> launching %s' % p['map'])
        launch(p['map'])
        watch(p, keyboard, timeline)
    except AttemptFailed as exc:
        failure = str(exc)
        timeline.note('>> FAILED: ' + failure)
    finally:
        desktop.unload('ov_place')
        if game_running():
            timeline.note('>> killing the game')
            kill_game()
        move_into(attempt_dir, glob.glob(os.path.join(shots_dir, p['map'] + '*.tga')) + game_log())
        if os.path.exists(cfg_path):
            os.remove(cfg_path)
        profile('off')
        desktop.save_journal(since, os.path.join(attempt_dir, 'kwin.log'))
        timeline.close()
        problems = leftovers(GAME_DIR, baseline)
        if problems:
            raise SystemExit('cleanup left the game changed, stopping: ' + '; '.join(problems))

    v = verdict.judge(p, attempt_dir)
    if failure:
        v['ok'] = False
        v['reasons'].insert(0, failure)
    with open(os.path.join(attempt_dir, 'verdict.json'), 'w') as fh:
        json.dump(v, fh, indent=2)
    return os.path.basename(attempt_dir), v


def run_map(name, keyboard, baseline):
    map_dir = os.path.join(plan.RUNS, name)
    marker = os.path.join(map_dir, 'verified')
    if os.path.exists(marker):
        with open(marker) as fh:
            print('%s: already verified (%s), skipping' % (name, fh.read().strip()))
        return True
    framing = plan.load_framing(plan.OUT, name)
    shot_list = plan.shots(framing)
    p = plan.plan_json(framing, shot_list)
    os.makedirs(map_dir, exist_ok=True)
    with open(os.path.join(map_dir, 'plan.json'), 'w') as fh:
        json.dump(p, fh, indent=2)
    for _ in range(ATTEMPTS):
        attempt_name, v = attempt(p, framing, shot_list, keyboard, baseline)
        if v['ok']:
            with open(marker, 'w') as fh:
                fh.write(attempt_name + '\n')
            print('%s: verified on %s' % (name, attempt_name))
            return True
        print('%s: %s failed: %s' % (name, attempt_name, '; '.join(v['reasons'])))
    return False


def preflight(names):
    problems = []
    if game_running():
        problems.append('Left 4 Dead is running; quit it first')
    if not desktop.uinput_writable():
        problems.append('/dev/uinput is not writable')
    if not desktop.kwin_available():
        problems.append('KWin scripting is not reachable over qdbus6')
    cfg = os.path.join(GAME_DIR, 'cfg')
    if glob.glob(os.path.join(cfg, '*.ovbak')) or glob.glob(os.path.join(GAME_DIR, '*.ovbak')):
        problems.append('a capture profile is still active from an earlier run; run ./profile.sh off')
    known = plan.known_commands()
    for name in names:
        try:
            f = plan.load_framing(plan.OUT, name)
        except ValueError as exc:
            problems.append(str(exc))
            continue
        bad = plan.unknown_commands(plan.chain_cfg(f, plan.shots(f)), known)
        if bad:
            problems.append('%s: commands L4D1 lacks: %s' % (name, sorted(bad)))
    return problems


def main(argv):
    names = argv[1:]
    if not names:
        print(__doc__)
        return 2
    problems = preflight(names)
    if problems:
        for problem in problems:
            print('preflight: ' + problem)
        return 1
    baseline = snapshot(GAME_DIR)
    keyboard = desktop.Keyboard()
    try:
        for name in names:
            if not run_map(name, keyboard, baseline):
                print('%s: %d attempts failed; stopping' % (name, ATTEMPTS))
                return 1
    finally:
        keyboard.close()
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv))
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd /home/volence/l4d/overviews && python3 -m pytest -q`
Expected: all tests pass (`34 passed` across Tasks 1, 2 and 4)

- [ ] **Step 5: Check preflight without launching anything**

Run:
```bash
cd /home/volence/l4d/overviews && python3 -c "import runner; print(runner.preflight(['l4d_vs_farm01_hilltop']))"
```
Expected: `[]`

- [ ] **Step 6: Commit**

```bash
cd /home/volence/l4d/overviews
git add runner.py tests/test_runner.py
git commit -m "Add the unattended capture runner

Launches one map, presses F9 once when console.log shows the client in the
world, aborts on a wrong-size first tile, waits for the chain to quit, then
proves the game is back as the owner left it before judging the attempt.
Retries up to three attempts and resumes past maps already verified."
```

---

### Task 5: Stitching and cleanup (`stitch.py`)

**Files:**
- Create: `/home/volence/l4d/overviews/stitch.py`
- Test: `/home/volence/l4d/overviews/tests/test_stitch.py`

**Interfaces:**
- Consumes: `plan.Framing`, `plan.shots`, `plan.plan_json`, `plan.EYE`, `plan.RUNS`, `plan.HERE` (Task 1); `runs/<map>/verified`, `runs/<map>/plan.json`, `runs/<map>/<attempt>/verdict.json` and tiles (Task 4).
- Produces (used by Tasks 6 and 8):
  - `BLACK_SUM = 12`, `OUT4X` path
  - `tile_offset(p, pose) -> (float, float)`, `snap(offset, w, h) -> (int, int)` (raises `ValueError`)
  - `stitch_layer(p, tiles: list[tuple[pose, PIL.Image]]) -> PIL.Image`
  - `void_mask(a: np.ndarray) -> np.ndarray[bool]`
  - `clean(arrays: list[np.ndarray]) -> (list[np.ndarray], list[int])`, arrays ascending by cut height
  - files: `runs/<map>/prefill/<map>_z<+NNNN>.4x.png`; `out4x/<map>_z<+NNNN>.4x.png`, `out4x/<map>_z<+NNNN>.4x.json`, `out4x/<map>.layers.json`

- [ ] **Step 1: Write the failing tests**

`/home/volence/l4d/overviews/tests/test_stitch.py`:

```python
import numpy as np
import pytest
from PIL import Image

import plan
import stitch

COLORS = {'tl': (200, 10, 10), 'tr': (10, 200, 10), 'bl': (10, 10, 200), 'br': (200, 200, 10)}


def tiny():
    f = plan.Framing('m_test', 100.0, -50.0, 1.0, 8, 6, (100.0, 200.0))
    return plan.plan_json(f, plan.shots(f))


def pose_of(shot, dx=0.0):
    return [shot['x'] + dx, shot['y'], shot['z'] + plan.EYE, 0.0, 90.0, 0.0]


def layer_tiles(p, layer=0, dx=0.0):
    return [(pose_of(s, dx if s['quadrant'] == 'tr' else 0.0),
             Image.new('RGB', (8, 6), COLORS[s['quadrant']]))
            for s in p['shots'] if s['layer'] == layer and s['quadrant'] != 'control']


def test_tiles_land_in_their_quadrants():
    p = tiny()
    canvas = np.asarray(stitch.stitch_layer(p, layer_tiles(p)))
    assert canvas.shape == (12, 16, 3)
    assert tuple(canvas[0, 0]) == COLORS['tl']
    assert tuple(canvas[0, 15]) == COLORS['tr']
    assert tuple(canvas[11, 0]) == COLORS['bl']
    assert tuple(canvas[11, 15]) == COLORS['br']
    assert tuple(canvas[5, 7]) == COLORS['tl'] and tuple(canvas[6, 8]) == COLORS['br']


def test_a_tile_half_a_pixel_off_is_refused():
    p = tiny()
    with pytest.raises(ValueError, match='not on the 2x2 grid'):
        stitch.stitch_layer(p, layer_tiles(p, dx=p['units_per_pixel'] * 0.5))


def test_void_is_near_black_or_the_pure_green_signature():
    a = np.array([[[3, 3, 3], [0, 254, 0], [8, 240, 8], [0, 230, 0], [9, 250, 0], [40, 40, 40]]],
                 dtype=np.uint8)
    assert stitch.void_mask(a).tolist() == [[True, True, True, False, False, False]]


def test_clean_blacks_out_green_and_fills_dips_from_below():
    low = np.full((1, 3, 3), 90, np.uint8)
    low[0, 0] = (0, 0, 0)                   # real void: black in every layer
    high = np.full((1, 3, 3), 150, np.uint8)
    high[0, 0] = (0, 0, 0)
    high[0, 1] = (0, 254, 0)                # green: void, and the layer below has content
    top = np.full((1, 3, 3), 200, np.uint8)
    top[0, 1] = (1, 1, 1)                   # void here and in `high` after cleaning: cascades to `low`
    cleaned, filled = stitch.clean([low, high, top])
    assert cleaned[0][0, 0].tolist() == [0, 0, 0]
    assert cleaned[1][0, 0].tolist() == [0, 0, 0]
    assert cleaned[1][0, 1].tolist() == [90, 90, 90]
    assert cleaned[2][0, 1].tolist() == [90, 90, 90]
    assert filled == [0, 1, 1]
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd /home/volence/l4d/overviews && python3 -m pytest tests/test_stitch.py -q`
Expected: collection error, `No module named 'stitch'`

- [ ] **Step 3: Write `stitch.py`**

`/home/volence/l4d/overviews/stitch.py`:

```python
#!/usr/bin/env python3
"""Stitch a verified tiled capture into 4x layers, then clean them.

    ./stitch.py l4d_vs_farm01_hilltop

Writes the stitched layers before cleanup to runs/<map>/prefill/ (acceptance
checks compare those against the 1x set) and the cleaned layers with their
JSONs and manifest to out4x/. Never touches out/.
"""
import json
import os
import sys

import numpy as np
from PIL import Image

import plan

OUT4X = os.path.join(plan.HERE, 'out4x')
BLACK_SUM = 12          # mat_fullbright void is pure black; this only rejects noise
OFFSET_TOL = 0.01       # pixels
SELECT = 'lowest layer whose cut_height exceeds the survivors median z'


def tile_offset(p, pose):
    """Canvas pixel of a tile's upper-left, from where the camera really was.

    The ortho view is centred on the camera to the unit, and a half-scale tile
    has exactly the canvas's units per pixel, so this is pure arithmetic.
    """
    fr = p['framing']
    upp = p['units_per_pixel']
    ulx, uly = p['world_upper_left']
    tile_ulx = pose[0] - fr['w'] * upp / 2
    tile_uly = pose[1] + fr['h'] * upp / 2
    return (tile_ulx - ulx) / upp, (uly - tile_uly) / upp


def snap(offset, w, h):
    ox, oy = offset
    sx, sy = round(ox), round(oy)
    if (abs(ox - sx) > OFFSET_TOL or abs(oy - sy) > OFFSET_TOL
            or sx not in (0, w) or sy not in (0, h)):
        raise ValueError('tile lands at %.3f,%.3f, not on the 2x2 grid' % (ox, oy))
    return sx, sy


def stitch_layer(p, tiles):
    """Paste one layer's four (pose, image) tiles onto a 2w x 2h canvas. No resampling."""
    fr = p['framing']
    canvas = Image.new('RGB', (2 * fr['w'], 2 * fr['h']))
    for pose, image in tiles:
        canvas.paste(image.convert('RGB'), snap(tile_offset(p, pose), fr['w'], fr['h']))
    return canvas


def void_mask(a):
    """Near-black, or the pure green the renderer paints where a low cut finds no surface.

    Green is not water in general: the houseboat lake renders normally. The web
    generator already treated it as void.
    """
    a = a.astype(np.int16)
    dark = a.sum(axis=2) < BLACK_SUM
    green = (a[..., 0] <= 8) & (a[..., 2] <= 8) & (a[..., 1] >= 240)
    return dark | green


def clean(arrays):
    """Black out void, then fill each layer's void from the nearest lower layer.

    Layers ascend by cut height. The lowest is only blacked out. A dip too deep
    for a high camera shows in a lower one, so taking the already-filled layer
    below cascades down to whichever layer first has content. Void outside the
    map is black in every layer, so it stays black.
    """
    out, filled = [], []
    below = None
    for a in arrays:
        void = void_mask(a)
        cleaned = a.copy()
        cleaned[void] = 0
        count = 0
        if below is not None:
            take = void & ~void_mask(below)
            cleaned[take] = below[take]
            count = int(take.sum())
        out.append(cleaned)
        filled.append(count)
        below = cleaned
    return out, filled


def main(argv):
    if len(argv) != 2:
        print('usage: stitch.py <map>')
        return 2
    name = argv[1]
    map_dir = os.path.join(plan.RUNS, name)
    marker = os.path.join(map_dir, 'verified')
    if not os.path.exists(marker):
        print('%s: no verified attempt; run runner.py first' % name)
        return 1
    with open(marker) as fh:
        attempt = fh.read().strip()
    attempt_dir = os.path.join(map_dir, attempt)
    with open(os.path.join(map_dir, 'plan.json')) as fh:
        p = json.load(fh)
    with open(os.path.join(attempt_dir, 'verdict.json')) as fh:
        v = json.load(fh)
    fr = p['framing']
    ulx, uly = p['world_upper_left']
    upp = p['units_per_pixel']

    prefill_dir = os.path.join(map_dir, 'prefill')
    os.makedirs(prefill_dir, exist_ok=True)
    os.makedirs(OUT4X, exist_ok=True)

    rows, arrays = [], []
    for layer, cut in enumerate(fr['cut_heights']):
        members = [s for s in p['shots'] if s['layer'] == layer and s['quadrant'] != 'control']
        tiles = [(v['poses'][s['index']], Image.open(os.path.join(attempt_dir, v['tiles'][s['index']])))
                 for s in members]
        canvas = stitch_layer(p, tiles)
        stem = '%s_z%+05d.4x' % (name, round(cut))
        canvas.save(os.path.join(prefill_dir, stem + '.png'))
        arrays.append(np.asarray(canvas))
        rows.append((cut, stem, [v['tiles'][s['index']] for s in members]))
        print('  stitched %s.png' % stem)

    cleaned, filled = clean(arrays)
    manifest_layers = []
    for (cut, stem, files), a, count in zip(rows, cleaned, filled):
        Image.fromarray(a).save(os.path.join(OUT4X, stem + '.png'))
        meta = {
            'map': name,
            'image': stem + '.png',
            'image_w': 2 * fr['w'], 'image_h': 2 * fr['h'],
            # The whole stitched frame is `scale` at twice the height, which keeps
            # units_per_pixel = 1024 * engine_scale / image_h true for this image.
            'engine_scale': fr['scale'],
            'tile_engine_scale': fr['scale'] / 2,
            'units_per_pixel': upp,
            'world_upper_left': [ulx, uly],
            'world_span': [2 * fr['w'] * upp, 2 * fr['h'] * upp],
            'camera': [fr['cx'], fr['cy'], cut],
            'cut_height': cut,
            'transform': 'px = (world_x - ulx)/upp ; py = (uly - world_y)/upp',
            'tiles': {'attempt': attempt, 'files': files},
            'dip_filled_px': count,
        }
        with open(os.path.join(OUT4X, stem + '.json'), 'w') as fh:
            json.dump(meta, fh, indent=2)
        manifest_layers.append({'image': stem + '.png', 'cut_height': cut,
                                'units_per_pixel': upp, 'world_upper_left': [ulx, uly]})
        print('  %s.png  cut z=%.0f  dip-filled %d px' % (stem, cut, count))

    with open(os.path.join(OUT4X, name + '.layers.json'), 'w') as fh:
        json.dump({'map': name, 'aligned': True, 'layers': manifest_layers, 'select': SELECT},
                  fh, indent=2)
    print('%s: %d layers into %s' % (name, len(rows), OUT4X))
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv))
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd /home/volence/l4d/overviews && python3 -m pytest tests/test_stitch.py -q`
Expected: `4 passed`

- [ ] **Step 5: Commit**

```bash
cd /home/volence/l4d/overviews
git add stitch.py tests/test_stitch.py
git commit -m "Stitch verified tiles into 4x layers and clean them

Places each tile from its verified camera pose and refuses anything off the
2x2 grid. Near-black and the pure-green no-surface fill become void, and
each layer's void is filled from the nearest lower layer with content."
```

---

### Task 6: Acceptance checks (`verify.py` refactor, `acceptance.py`)

**Files:**
- Modify: `/home/volence/l4d/overviews/verify.py` (whole file)
- Create: `/home/volence/l4d/overviews/acceptance.py`
- Test: `/home/volence/l4d/overviews/tests/test_verify.py`
- Test: `/home/volence/l4d/overviews/tests/test_acceptance.py`

**Interfaces:**
- Consumes: `plan.RUNS`, `plan.OUT` (Task 1); `stitch.BLACK_SUM`, `stitch.OUT4X` (Task 5); `bsp.origins(path) -> list[(x, y, z)]` (existing).
- Produces (used by Task 7):
  - `verify.MAPS`, `verify.sample(im, meta, pts) -> list[(px, py, lit)]`, `verify.score(sampled) -> float`
  - `acceptance.downscale2(a) -> np.ndarray`, `acceptance.geometry(one, four) -> dict`, `acceptance.seams(four) -> dict`, `acceptance.busiest_window(one) -> (x, y)`
  - files: `runs/<map>/acceptance.json` and `runs/<map>/acceptance/<stem>_1x.png`, `<stem>_4x.png`, `<stem>_4x_filled.png`

- [ ] **Step 1: Write the failing tests**

`/home/volence/l4d/overviews/tests/test_verify.py`:

```python
from PIL import Image

import verify


def test_score_counts_points_on_geometry_inside_the_frame():
    im = Image.new('RGB', (10, 10), (0, 0, 0))
    for x in range(5):
        for y in range(10):
            im.putpixel((x, y), (255, 255, 255))
    meta = {'units_per_pixel': 1.0, 'world_upper_left': [0.0, 10.0]}
    pts = [(2.5, 5.0, 0.0), (7.5, 5.0, 0.0), (50.0, 5.0, 0.0)]
    sampled = verify.sample(im, meta, pts)
    assert [lit for _, _, lit in sampled] == [True, False]
    assert verify.score(sampled) == 50.0
    assert verify.score([]) == 0.0
```

`/home/volence/l4d/overviews/tests/test_acceptance.py`:

```python
import numpy as np

import acceptance


def textured(h=100, w=160, seed=0):
    return np.random.default_rng(seed).integers(20, 255, size=(h, w, 3), dtype=np.uint8)


def upscale(a):
    return np.repeat(np.repeat(a, 2, axis=0), 2, axis=1)


def test_downscale2_inverts_a_nearest_upscale():
    a = textured()
    assert np.array_equal(acceptance.downscale2(upscale(a)).astype(np.uint8), a)


def test_geometry_passes_a_faithful_4x():
    result = acceptance.geometry(textured(), upscale(textured()))
    assert result['ok']
    assert all(q['mad'] == 0.0 for q in result['quadrants'].values())


def test_geometry_fails_the_quadrant_holding_a_misplaced_tile():
    one = textured()
    four = upscale(one)
    four[:100, 160:] = upscale(textured(seed=7))[:100, 160:]     # a wrong top-right tile
    result = acceptance.geometry(one, four)
    assert not result['ok']
    assert not result['quadrants']['tr']['ok']
    assert result['quadrants']['tl']['ok']


def test_geometry_ignores_quadrants_with_too_little_content():
    one = np.zeros((100, 160, 3), np.uint8)
    four = upscale(textured())[:200, :320] * 0
    four[0, 0] = (255, 255, 255)
    assert acceptance.geometry(one, four)['ok']


def smooth(h=200, w=320):
    ramp = np.linspace(40, 200, w, dtype=np.float32)
    return np.repeat(np.repeat(ramp[None, :, None], h, axis=0), 3, axis=2).astype(np.uint8)


def test_seams_pass_continuous_imagery():
    result = acceptance.seams(smooth())
    assert result['vertical']['ok'] and result['horizontal']['ok']


def test_seams_fail_a_jump_at_the_middle():
    four = smooth()
    four[:, 160:] = 255 - four[:, 160:]
    assert not acceptance.seams(four)['vertical']['ok']


def test_busiest_window_finds_the_textured_region():
    one = np.zeros((1271, 2048, 3), np.uint8)
    one[500:800, 1200:1700] = textured(300, 500)
    x, y = acceptance.busiest_window(one)
    assert 1000 <= x <= 1700 and 375 <= y <= 800
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd /home/volence/l4d/overviews && python3 -m pytest tests/test_verify.py tests/test_acceptance.py -q`
Expected: `test_verify.py` fails with `AttributeError: module 'verify' has no attribute 'sample'` (importing `verify` today also runs its script body against `sys.argv`, which may raise first); `test_acceptance.py` errors with `No module named 'acceptance'`

- [ ] **Step 3: Rewrite `verify.py` with the same CLI output**

`/home/volence/l4d/overviews/verify.py` (whole file; `collect.sh` reads line 2 of the output, which is unchanged):

```python
#!/usr/bin/env python3
"""Prove a capture's transform by projecting BSP entity origins onto it.

If the world-to-pixel mapping is right, entities land on visible geometry;
if it is wrong, they scatter into the black void.

    ./verify.py <stem>      checks out/<stem>.json against its image in out/
"""
import json
import os
import sys

from PIL import Image, ImageDraw

import bsp

MAPS = os.path.expanduser('~/.steam/steam/steamapps/common/left 4 dead/left4dead/maps')


def sample(im, meta, pts):
    """(px, py, lit) for every point inside the frame, tested on the image as given."""
    upp = meta['units_per_pixel']
    ulx, uly = meta['world_upper_left']
    w, h = im.size
    out = []
    for (x, y, _z) in pts:
        px, py = (x - ulx) / upp, (uly - y) / upp
        if not (0 <= px < w and 0 <= py < h):
            continue
        r, g, b = im.getpixel((int(px), int(py)))
        out.append((px, py, (r + g + b) > 24))
    return out


def score(sampled):
    """Percentage of in-frame points that land on rendered geometry."""
    if not sampled:
        return 0.0
    return 100.0 * sum(1 for _, _, lit in sampled if lit) / len(sampled)


def main(stem):
    with open(f'out/{stem}.json') as fh:
        meta = json.load(fh)
    im = Image.open(f"out/{meta['image']}").convert('RGB')
    pts = bsp.origins(os.path.join(MAPS, meta['map'] + '.bsp'))
    # Sample every point against the untouched image BEFORE drawing anything,
    # otherwise later points get tested against circles already drawn.
    sampled = sample(im, meta, pts)
    d = ImageDraw.Draw(im)
    for px, py, lit in sampled:
        d.ellipse([px - 4, py - 4, px + 4, py + 4],
                  outline=(0, 255, 80) if lit else (255, 40, 40), width=2)
    im.save(f'out/{stem}_verify.png')
    on_geo = sum(1 for _, _, lit in sampled if lit)
    print(f'{len(sampled)} entity origins fall inside the frame')
    print(f'{on_geo} of them ({score(sampled):.1f}%) land on rendered geometry, not void')
    print(f'wrote out/{stem}_verify.png  (green = on geometry, red = in void)')


if __name__ == '__main__':
    main(sys.argv[1])
```

- [ ] **Step 4: Write `acceptance.py`**

`/home/volence/l4d/overviews/acceptance.py`:

```python
#!/usr/bin/env python3
"""Phase 1 checks: does the 4x capture agree with the 1x layers it replaces?

    ./acceptance.py l4d_vs_farm01_hilltop

Compares runs/<map>/prefill/ (stitched, before cleanup) against out/, so dip
fill cannot hide a misplaced tile. Writes runs/<map>/acceptance.json and crops
for a side-by-side look. Exit status 0 only if every check passes.
"""
import json
import os
import sys

import numpy as np
from PIL import Image

import bsp
import plan
import stitch
import verify

# The "Server cvar changed" notification baked into some 1x captures, in 1x pixels.
HUD_TEXT_BOX_1X = (55, 775, 455, 808)
SHIFT = 32              # 1x pixels: what a misplaced tile looks like
MIN_CONTENT = 1000      # quadrants with fewer comparable pixels are reported, not judged
CROP = (400, 250)       # 1x pixels


def dark(a):
    return a.astype(np.int16).sum(axis=2) < stitch.BLACK_SUM


def downscale2(a):
    """Box filter to half size."""
    h, w = a.shape[0] // 2, a.shape[1] // 2
    return a[:2 * h, :2 * w].reshape(h, 2, w, 2, a.shape[2]).astype(np.float32).mean(axis=(1, 3))


def _mad(a, b, valid):
    if not valid.any():
        return 0.0
    d = np.abs(a.astype(np.float32) - b.astype(np.float32)).mean(axis=2)
    return float(d[valid].mean())


def _quadrants(h, w):
    return (('tl', slice(0, h // 2), slice(0, w // 2)), ('tr', slice(0, h // 2), slice(w // 2, w)),
            ('bl', slice(h // 2, h), slice(0, w // 2)), ('br', slice(h // 2, h), slice(w // 2, w)))


def geometry(one, four):
    """Each quadrant of the downscaled 4x layer against the 1x layer, over content pixels.

    Calibrated per quadrant against the same 1x quadrant shifted by SHIFT pixels,
    because how much a quadrant differs legitimately depends on what is in it.
    """
    small = downscale2(four)
    h, w = one.shape[:2]
    keep = np.ones((h, w), bool)
    x0, y0, x1, y1 = HUD_TEXT_BOX_1X
    keep[y0:y1, x0:x1] = False
    one_dark, small_dark = dark(one), dark(small)
    out, ok = {}, True
    for name, ys, xs in _quadrants(h, w):
        q1, q4, k, d1 = one[ys, xs], small[ys, xs], keep[ys, xs], one_dark[ys, xs]
        valid = k & ~(d1 & small_dark[ys, xs])
        mad = _mad(q1, q4, valid)
        s = SHIFT
        shifted_valid = k[s:, s:] & k[:-s, :-s] & ~(d1[s:, s:] & d1[:-s, :-s])
        baseline = _mad(q1[s:, s:], q1[:-s, :-s], shifted_valid)
        content = int(valid.sum())
        passed = content < MIN_CONTENT or mad < 0.5 * baseline
        out[name] = {'content_px': content, 'mad': mad, 'shifted_mad': baseline, 'ok': bool(passed)}
        ok = ok and passed
    return {'quadrants': out, 'ok': bool(ok)}


def seams(four):
    """Line-to-line difference across each seam against the same 8 px away on both sides."""
    h, w = four.shape[:2]
    out = {}
    for name, axis, at in (('vertical', 1, w // 2), ('horizontal', 0, h // 2)):
        def line(i, axis=axis):
            return (four[:, i] if axis == 1 else four[i, :]).astype(np.float32)

        def diff(i, j):
            return float(np.abs(line(i) - line(j)).mean())

        seam = diff(at - 1, at)
        neighbourhood = (diff(at - 9, at - 8) + diff(at + 8, at + 9)) / 2
        out[name] = {'seam': seam, 'neighbourhood': neighbourhood,
                     'ok': bool(seam <= 1.5 * max(neighbourhood, 1.0))}
    return out


def busiest_window(one):
    """Upper-left of the CROP-sized 1x window with the most detail, on a half-step grid."""
    g = one.astype(np.float32).mean(axis=2)
    cw, ch = CROP
    best, where = -1.0, (0, 0)
    for y in range(0, g.shape[0] - ch + 1, ch // 2):
        for x in range(0, g.shape[1] - cw + 1, cw // 2):
            v = float(g[y:y + ch, x:x + cw].std())
            if v > best:
                best, where = v, (x, y)
    return where


def crops(one, prefill, filled, stem, out_dir):
    x, y = busiest_window(one)
    cw, ch = CROP
    Image.fromarray(one[y:y + ch, x:x + cw]).resize((2 * cw, 2 * ch), Image.NEAREST).save(
        os.path.join(out_dir, stem + '_1x.png'))
    Image.fromarray(prefill[2 * y:2 * (y + ch), 2 * x:2 * (x + cw)]).save(
        os.path.join(out_dir, stem + '_4x.png'))
    Image.fromarray(filled[2 * y:2 * (y + ch), 2 * x:2 * (x + cw)]).save(
        os.path.join(out_dir, stem + '_4x_filled.png'))
    return {'x': x, 'y': y, 'w': cw, 'h': ch}


def main(argv):
    if len(argv) != 2:
        print('usage: acceptance.py <map>')
        return 2
    name = argv[1]
    map_dir = os.path.join(plan.RUNS, name)
    marker = os.path.join(map_dir, 'verified')
    if not os.path.exists(marker):
        print('%s: no verified attempt' % name)
        return 1
    with open(marker) as fh:
        attempt = fh.read().strip()
    with open(os.path.join(stitch.OUT4X, name + '.layers.json')) as fh:
        manifest = json.load(fh)
    pts = bsp.origins(os.path.join(verify.MAPS, name + '.bsp'))
    crop_dir = os.path.join(map_dir, 'acceptance')
    os.makedirs(crop_dir, exist_ok=True)

    report = {'map': name, 'verified_attempt': attempt, 'layers': []}
    all_ok = True
    for layer in manifest['layers']:
        stem4 = layer['image'][:-len('.png')]
        stem1 = stem4[:-len('.4x')]
        with open(os.path.join(plan.OUT, stem1 + '.json')) as fh:
            meta1 = json.load(fh)
        with open(os.path.join(stitch.OUT4X, stem4 + '.json')) as fh:
            meta4 = json.load(fh)
        im1 = Image.open(os.path.join(plan.OUT, meta1['image'])).convert('RGB')
        pre_im = Image.open(os.path.join(map_dir, 'prefill', layer['image'])).convert('RGB')
        one, pre = np.asarray(im1), np.asarray(pre_im)
        filled = np.asarray(Image.open(os.path.join(stitch.OUT4X, layer['image'])).convert('RGB'))

        g = geometry(one, pre)
        s = seams(pre)
        score1 = verify.score(verify.sample(im1, meta1, pts))
        score4 = verify.score(verify.sample(pre_im, meta4, pts))
        e = {'score_1x': score1, 'score_4x': score4, 'ok': bool(score4 >= score1 - 2.0)}
        c = crops(one, pre, filled, stem1, crop_dir)
        layer_ok = g['ok'] and s['vertical']['ok'] and s['horizontal']['ok'] and e['ok']
        all_ok = all_ok and layer_ok
        report['layers'].append({'image': layer['image'], 'cut_height': layer['cut_height'],
                                 'geometry': g, 'seams': s, 'entities': e, 'crop': c,
                                 'dip_filled_px': meta4['dip_filled_px'], 'ok': bool(layer_ok)})
        worst = max(g['quadrants'].values(), key=lambda q: q['mad'] / max(q['shifted_mad'], 1e-6))
        print('%s  %s  geometry mad %.2f vs shifted %.2f  seams %.2f/%.2f  entities %.1f%% vs %.1f%%'
              % ('PASS' if layer_ok else 'FAIL', stem4, worst['mad'], worst['shifted_mad'],
                 s['vertical']['seam'], s['horizontal']['seam'], score4, score1))

    report['ok'] = bool(all_ok)
    with open(os.path.join(map_dir, 'acceptance.json'), 'w') as fh:
        json.dump(report, fh, indent=2)
    print('%s: %s' % (name, 'ALL CHECKS PASS' if all_ok else 'CHECKS FAILED'))
    return 0 if all_ok else 1


if __name__ == '__main__':
    sys.exit(main(sys.argv))
```

- [ ] **Step 5: Run the whole suite**

Run: `cd /home/volence/l4d/overviews && python3 -m pytest -q`
Expected: all tests pass (`46 passed`)

- [ ] **Step 6: Confirm the verify CLI is unchanged on a real layer**

Run: `cd /home/volence/l4d/overviews && python3 verify.py l4d_vs_farm01_hilltop_z+2270`
Expected: three lines, the second of the form `N of them (P%) land on rendered geometry, not void`. Then `git status --short` shows `out/` untouched apart from the ignored `_verify.png`.

- [ ] **Step 7: Commit**

```bash
cd /home/volence/l4d/overviews
git add verify.py acceptance.py tests/test_verify.py tests/test_acceptance.py
git commit -m "Add acceptance checks for a 4x capture against the 1x set

Geometry per quadrant against its own 32 px shifted baseline over content
pixels, seam continuity, entity projection relative to the 1x layer, and
detail crops for a side-by-side look. verify.py now exposes its scoring
with the CLI output unchanged."
```

---

### Task 7 (operator): Capture Blood Harvest 1 and pass acceptance

Run by the coordinating session with the owner at the workstation. Not a subagent task.

**Files:**
- Modify: `/home/volence/l4d/pug/docs/superpowers/specs/2026-09-16-overview-tiled-recapture-design.md` (record measured numbers)

**Interfaces:**
- Consumes: `plan.py`, `runner.py`, `stitch.py`, `acceptance.py` (Tasks 1 to 6).
- Produces (used by Task 8): `overviews/out4x/l4d_vs_farm01_hilltop.layers.json` plus 5 `.4x.png` and 5 `.4x.json`; an owner-approved visual comparison.

- [ ] **Step 1: Full test suite and plan**

Run: `cd /home/volence/l4d/overviews && python3 -m pytest -q && python3 plan.py l4d_vs_farm01_hilltop`
Expected: all pass; plan output as in Task 1 Step 6.

- [ ] **Step 2: Ask the owner for the run**

Tell the owner: L4D must be closed, the Steam client should already be running (a cold Steam start can eat the 120 s spawn budget), the run takes about two minutes, and the keyboard should be left alone while it runs. Wait for their go-ahead.

- [ ] **Step 3: Run the capture**

Run: `cd /home/volence/l4d/overviews && python3 runner.py l4d_vs_farm01_hilltop`
Expected: `>>` timeline lines ending in `>> game exited`, then `l4d_vs_farm01_hilltop: verified on attempt-1`.

If an attempt fails, read `runs/l4d_vs_farm01_hilltop/attempt-N/verdict.json`, `timeline.log` and `kwin.log` before anything else. Known failure shapes:
- `first tile is 1920x1080`: the window was created on DP-2. Check `kwin.log` for the `ov-place` output name. Fallback: ask the owner to click on the DP-1 desktop right before launch and rerun.
- `F9 never started the chain`: check `kwin.log` for `ov-focus: activated`. If it activated and the chain still did not begin, check that `cfg/ov_run.cfg` was written and that `console.log` shows `[OV] armed`.
- `control shot differs from tile 0`: diff the two tiles and look at where they differ before changing anything.

- [ ] **Step 4: Confirm the game is back to normal**

Run: `cd /home/volence/l4d/overviews && python3 -c "import runner; print(runner.leftovers(runner.GAME_DIR, {'addons': ['crosshair_2.vpk', 'my_crosshair.vpk'], 'modernhud': True}))"`
Expected: `[]`

- [ ] **Step 5: Stitch**

Run: `cd /home/volence/l4d/overviews && python3 stitch.py l4d_vs_farm01_hilltop`
Expected: 5 `stitched` lines, 5 lines with `dip-filled N px`, and `l4d_vs_farm01_hilltop: 5 layers into /home/volence/l4d/overviews/out4x`

- [ ] **Step 6: Acceptance**

Run: `cd /home/volence/l4d/overviews && python3 acceptance.py l4d_vs_farm01_hilltop`
Expected: 5 `PASS` lines and `l4d_vs_farm01_hilltop: ALL CHECKS PASS`

If any layer fails, stop and show the owner the failing numbers from `runs/l4d_vs_farm01_hilltop/acceptance.json` with the crops before proposing a change.

- [ ] **Step 7: Show the owner the comparison**

Load the `artifact-design` skill, then publish an artifact titled "Blood Harvest 4x" that shows, for each of the 5 layers, `acceptance/<stem>_1x.png` next to `<stem>_4x.png` at the same on-screen size, with a toggle to `<stem>_4x_filled.png`, plus the layer's acceptance numbers. Give the owner the link and wait for approval. Without approval, Task 8 does not start.

- [ ] **Step 8: Record the measured numbers in the spec**

Append to the spec's "Acceptance for Blood Harvest 1" section a table with one row per layer: cut height, worst quadrant MAD and its shifted baseline, both seam values with neighbourhoods, entity score 1x and 4x, dip-filled pixels. Then:

```bash
cd /home/volence/l4d/pug
git add docs/superpowers/specs/2026-09-16-overview-tiled-recapture-design.md
git commit -m "docs(overviews): record Blood Harvest 1 acceptance numbers"
```

---

### Task 8: Web integration (pug)

**Files:**
- Modify: `/home/volence/l4d/pug/tests/mapOverviews.test.ts`
- Modify: `/home/volence/l4d/pug/tools/gen-overviews.py`
- Modify: `/home/volence/l4d/pug/tools/convert-overviews.sh`
- Regenerate: `/home/volence/l4d/pug/src/mapOverviews.ts`
- Replace: `/home/volence/l4d/pug/web/public/overviews/l4d_vs_farm01_hilltop_z*.webp`

**Interfaces:**
- Consumes: `overviews/out4x/l4d_vs_farm01_hilltop.layers.json` and its 5 `.4x.png` (Task 7); `overviews/out/` for the other 21 maps.
- Produces (used by Task 9): `OVERVIEWS['l4d_vs_farm01_hilltop']` with 5 layers, each `image: '/overviews/l4d_vs_farm01_hilltop_z+NNNN.4x.webp'`, `width: 4096`, `height: 2542`, `unitsPerPixel: 3.625492`; `gen-overviews.py SRC OUT --override DIR`.

- [ ] **Step 1: Update the tests first**

In `/home/volence/l4d/pug/tests/mapOverviews.test.ts`, replace:

```ts
  it('points every layer at a webp under /overviews/', () => {
    for (const m of Object.values(OVERVIEWS)) {
      for (const l of m.layers) {
        expect(l.image).toMatch(/^\/overviews\/[a-z0-9_+-]+\.webp$/);
      }
    }
  });

  it('carries the spec values for a known map', () => {
    const m = overviewFor('l4d_vs_farm01_hilltop')!;
    expect(m.layers).toHaveLength(5);
    expect(m.layers[0].unitsPerPixel).toBeCloseTo(7.250983, 5);
    expect(m.layers[0].originX).toBe(-16547);
    expect(m.layers[0].originY).toBe(-6299);
  });
```

with:

```ts
  it('points every layer at a webp under /overviews/', () => {
    for (const m of Object.values(OVERVIEWS)) {
      for (const l of m.layers) {
        expect(l.image).toMatch(/^\/overviews\/[a-z0-9_+-]+(\.4x)?\.webp$/);
      }
    }
  });

  // Blood Harvest 1 is the 4x tiled recapture: same corner, half the units per
  // pixel, twice the pixels on each side.
  it('carries the spec values for a known map', () => {
    const m = overviewFor('l4d_vs_farm01_hilltop')!;
    expect(m.layers).toHaveLength(5);
    expect(m.layers[0].unitsPerPixel).toBeCloseTo(3.625492, 5);
    expect(m.layers[0].originX).toBeCloseTo(-16547, 0);
    expect(m.layers[0].originY).toBeCloseTo(-6299, 0);
  });

  // The transform is per layer, but a map whose layers disagreed on size would
  // mean one of them came from a different capture.
  it('gives every layer of a map one image size', () => {
    for (const m of Object.values(OVERVIEWS)) {
      const sizes = new Set(m.layers.map((l) => `${l.width}x${l.height}`));
      expect(sizes.size).toBe(1);
    }
  });

  // Phase 1 of the recapture ships one map. Anything else at 4x, or farm01 at
  // 1x, means the converter took the wrong source.
  it('ships Blood Harvest 1 at 4x and every other map at 1x', () => {
    for (const m of Object.values(OVERVIEWS)) {
      const is4x = m.map === 'l4d_vs_farm01_hilltop';
      for (const l of m.layers) {
        expect([l.width, l.height]).toEqual(is4x ? [4096, 2542] : [2048, 1271]);
        expect(l.image.endsWith('.4x.webp')).toBe(is4x);
      }
    }
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd /home/volence/l4d/pug && npx vitest run tests/mapOverviews.test.ts`
Expected: FAIL on `carries the spec values for a known map` (received 7.250983) and `ships Blood Harvest 1 at 4x and every other map at 1x`

- [ ] **Step 3: Teach `gen-overviews.py` the override and the size set**

In `/home/volence/l4d/pug/tools/gen-overviews.py`:

Replace:
```python
import json
import os
import sys

from PIL import Image, ImageChops, ImageDraw

src, out = sys.argv[1], sys.argv[2]

# Every capture so far is this size, and the emitted table says so for each
# layer. Asserting it against the real file rather than taking it on trust is
# the point: an off-size capture would otherwise be written out as 2048x1271
# and silently put every avatar on that map in the wrong place, which is the
# exact failure class this generated file exists to prevent.
EXPECTED_SIZE = (2048, 1271)
```
with:
```python
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
```

Replace:
```python
            rgb = im.convert('RGB')
            ImageDraw.Draw(rgb).rectangle(HUD_TEXT_BOX, fill=(0, 0, 0))
```
with:
```python
            rgb = im.convert('RGB')
            # The notification sits at a fixed screen position in 1x captures only;
            # the tiled capture waits for it to fade before shooting.
            if rgb.size == ONE_X:
                ImageDraw.Draw(rgb).rectangle(HUD_TEXT_BOX, fill=(0, 0, 0))
```

Replace:
```python
maps = []
for name in sorted(os.listdir(src)):
    if not name.endswith('.layers.json'):
        continue
    with open(os.path.join(src, name)) as fh:
        m = json.load(fh)
    layers = sorted(m['layers'], key=lambda l: l['cut_height'])
    paths = []
    for layer in layers:
        path = os.path.join(src, layer['image'])
        paths.append(path)
        with Image.open(path) as im:
            size = im.size
        if size != EXPECTED_SIZE:
            raise SystemExit(
                f"{layer['image']} is {size[0]}x{size[1]}, expected "
                f'{EXPECTED_SIZE[0]}x{EXPECTED_SIZE[1]}. Either the capture is '
                'wrong or this generator needs to emit per-layer dimensions.'
            )
        layer['width'], layer['height'] = size
```
with:
```python
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
```

- [ ] **Step 4: Teach `convert-overviews.sh` the override**

In `/home/volence/l4d/pug/tools/convert-overviews.sh`, replace everything from the line `SRC=/home/volence/l4d/overviews/out` to the end of the file with:

```bash
SRC=/home/volence/l4d/overviews/out
# Recaptured maps. A manifest here replaces the same map's manifest in SRC.
OVERRIDE=/home/volence/l4d/overviews/out4x
OUT="$REPO/web/public/overviews"

mkdir -p "$OUT"
# The ten single-layer Valve BMP conversions are superseded by these.
rm -f "$OUT"/*.png

# Convert only the layers a manifest actually names.
#
# The capture directory also holds experiments and superseded cuts: fullbright
# trials, zoom tests, a second capture at a height the manifest does not use.
# Globbing every PNG shipped four of those as web assets that nothing loads,
# and the duplicate cut sitting next to the one in use is worse than dead
# weight because it reads as a real layer. The manifests are the list of what
# is real, so take the list from them. Note this stops new orphans appearing;
# a layer DROPPED from a manifest still leaves its webp behind, and that one
# has to be deleted by hand.
mapfile -t WANTED < <(
  python3 -c '
import json, os, sys
src, override = sys.argv[1], sys.argv[2]
manifests = {}
for directory in (src, override):
    if not os.path.isdir(directory):
        continue
    for name in sorted(os.listdir(directory)):
        if name.endswith(".layers.json"):
            manifests[name] = directory
for name in sorted(manifests):
    directory = manifests[name]
    with open(os.path.join(directory, name)) as fh:
        m = json.load(fh)
    for layer in m["layers"]:
        print("%s\t%s\t%s" % (directory, m["map"], layer["image"]))
' "$SRC" "$OVERRIDE"
)

# An overridden map drops every old webp first, since its new names differ.
# Every other map is encoded only when its webp is missing, so re-running this
# for one recaptured map leaves the other 21 byte-identical.
declare -A CLEARED=()
for row in "${WANTED[@]}"; do
  IFS=$'\t' read -r dir map name <<<"$row"
  base="${name%.png}"
  if [ "$dir" = "$OVERRIDE" ]; then
    if [ -z "${CLEARED[$map]:-}" ]; then
      rm -f "$OUT/${map}"_z*.webp
      CLEARED[$map]=1
    fi
    magick "$dir/$name" -quality 82 "$OUT/$base.webp"
  elif [ ! -e "$OUT/$base.webp" ]; then
    magick "$dir/$name" -quality 82 "$OUT/$base.webp"
  fi
done

python3 "$REPO/tools/gen-overviews.py" "$SRC" "$REPO/src/mapOverviews.ts" --override "$OVERRIDE"
```

- [ ] **Step 5: Regenerate**

Run: `cd /home/volence/l4d/pug && ./tools/convert-overviews.sh`
Expected: 22 `box=... coverage=...` lines and `wrote .../src/mapOverviews.ts: 22 maps, 182 layers`.

Then: `git status --short`
Expected: `M src/mapOverviews.ts`, `M tools/...`, `M tests/...`, 5 deleted `web/public/overviews/l4d_vs_farm01_hilltop_z+NNNN.webp`, 5 new `...z+NNNN.4x.webp`, and no other `web/public/overviews` changes.

- [ ] **Step 6: Check the generated farm01 entry**

Run: `cd /home/volence/l4d/pug && grep -A8 "'l4d_vs_farm01_hilltop': {" src/mapOverviews.ts`
Expected: 5 layers with `.4x.webp` images, `unitsPerPixel: 3.625492`, `originX: -16547, originY: -6299`, `width: 4096, height: 2542`, and a `contentBox` with coordinates roughly double the old one.

- [ ] **Step 7: Tests, typecheck, build**

Run: `cd /home/volence/l4d/pug && npm test && npm run typecheck && npm run build`
Expected: all green

- [ ] **Step 8: Commit**

Run `du -ch web/public/overviews/l4d_vs_farm01_hilltop_z*.4x.webp | tail -1` and put the total in the message.

```bash
cd /home/volence/l4d/pug
git add tests/mapOverviews.test.ts tools/gen-overviews.py tools/convert-overviews.sh src/mapOverviews.ts web/public/overviews
git commit -m "feat(replay): Blood Harvest 1 overview at 4x from the tiled recapture

Five 4096x2542 layers at 3.63 units per pixel replace the 2048x1271 ones,
same corner and cut heights. The converter takes recaptured maps from an
override directory and leaves the other 21 untouched. farm01 webp weight:
<TOTAL from du>."
```

---

### Task 9 (operator): Deploy

Run by the coordinating session. Not a subagent task.

**Files:** none

**Interfaces:**
- Consumes: pug `master` with Task 8 committed.
- Produces: farm01 4x live at https://riversidepug.com.

- [ ] **Step 1: Ask the owner for the go-ahead**

Tell the owner the deploy restarts `pug-web` (the site, Discord bot and match tracking run in that process). Wait for an explicit yes.

- [ ] **Step 2: Check the game server is empty**

Run:
```bash
cd /home/volence/l4d/deploy && python3 -c "
import importlib.util
spec = importlib.util.spec_from_file_location('er', 'empty-restart.py')
er = importlib.util.module_from_spec(spec); spec.loader.exec_module(er)
print(er.a2s_humans('45.32.199.85', 27015))"
```
Expected: `(0, <maxplayers>)`. Any other count: stop and tell the owner who is on.

- [ ] **Step 3: Deploy**

Run: `cd /home/volence/l4d/pug && ./deploy-web.sh`
Expected: ends with `active` and `==> https://riversidepug.com HTTP 200`

- [ ] **Step 4: Check the new images are served**

Run:
```bash
cd /home/volence/l4d/pug && for f in web/public/overviews/l4d_vs_farm01_hilltop_z*.4x.webp; do
  n=$(basename "$f"); want=$(stat -c %s "$f")
  got=$(curl -sI "https://riversidepug.com/overviews/$n" | awk 'tolower($1)=="content-length:"{print $2}' | tr -d '\r')
  code=$(curl -s -o /dev/null -w '%{http_code}' "https://riversidepug.com/overviews/$n")
  echo "$code $n local=$want served=$got"
done
```
Expected: five lines, each `200` with `local` equal to `served`.

- [ ] **Step 5: Owner checks it against match data**

Ask the owner to open a Blood Harvest 1 replay on the live site, zoom in, and confirm the map is sharp and the player markers sit where they should.

Rollback if anything is wrong: `git revert <Task 8 commit>`, `./tools/convert-overviews.sh` is not needed (the revert restores the old webps and module), then `./deploy-web.sh` after the same empty-server check.

---

### Task 10: Docs, spike removal, memory

**Files:**
- Modify: `/home/volence/l4d/overviews/MAP_OVERVIEWS.md`
- Delete: `/home/volence/l4d/overviews/spike_wait.sh`, `spike_report.py`, `spike_drive.py`, `gen_spike_cfg.py`
- Modify: `/home/volence/.claude/projects/-home-volence-l4d/memory/l4d1-overview-regen-plan.md`, `/home/volence/.claude/projects/-home-volence-l4d/memory/MEMORY.md` (coordinating session only)

**Interfaces:**
- Consumes: everything above.
- Produces: documentation that matches what is live.

- [ ] **Step 1: Update `MAP_OVERVIEWS.md`**

In `/home/volence/l4d/overviews/MAP_OVERVIEWS.md`, replace the sentence `22 maps, 182 layers, 269 MB. Every image is **2048 x 1271**.` with:

```markdown
22 maps, 182 layers, 269 MB. Every image in `out/` is **2048 x 1271**. Recaptured
maps live in `out4x/` instead; see "The 4x set" below.
```

Then append this section at the end of the file:

```markdown
## The 4x set (`out4x/`)

Maps recaptured as a 2x2 grid of half-scale tiles, stitched without resampling.
So far: `l4d_vs_farm01_hilltop` only.

| file | what it is |
|---|---|
| `<map>_z<+/-NNNN>.4x.png` | one layer, **4096 x 2542** |
| `<map>_z<+/-NNNN>.4x.json` | that layer's transform, same fields as the 1x JSON plus `tile_engine_scale`, `tiles`, `dip_filled_px` |
| `<map>.layers.json` | the layer stack, same format as `out/` |

Same corner (`world_upper_left`) and cut heights as the 1x layer each replaces,
half the `units_per_pixel`. The same world-to-pixel formulas apply unchanged.

Differences from `out/`:

- **Pure green is gone.** The `(0, ~254, 0)` fill a low cut paints where it finds no
  surface is treated as void.
- **Dips are filled.** A void pixel takes the nearest lower layer's content at that
  spot, so deep ground that a high camera cannot reach still shows. Void outside the
  map stays black. `dip_filled_px` says how much each layer changed.
- **No notification text.** The capture waits for "Server cvar changed" to fade.

Produced by `runner.py` (unattended capture, one synthetic F9 per map),
`stitch.py`, and checked by `acceptance.py` against the 1x layers. Raw attempts,
verdicts and the pre-cleanup stitch live in `runs/<map>/`.
```

- [ ] **Step 2: Remove the spike and commit**

```bash
cd /home/volence/l4d/overviews
git rm spike_wait.sh spike_report.py spike_drive.py gen_spike_cfg.py
git add MAP_OVERVIEWS.md
git commit -m "Document the 4x set and remove the spike

runner.py supersedes the spike scripts; their findings live in the design
spec and in git history at 3eb43b5."
```

- [ ] **Step 3: Update memory (coordinating session)**

Update `l4d1-overview-regen-plan.md`: Phase 1 (Blood Harvest 1) live with its deploy date and the pug commit; Phase 2 (21 maps) pending the owner's go-ahead; the tooling entry points (`runner.py`, `stitch.py`, `acceptance.py`, `tools/convert-overviews.sh`); and any failure shapes met during Task 7. Update its `MEMORY.md` line to match.
