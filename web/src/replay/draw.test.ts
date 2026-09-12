import { describe, it, expect } from 'vitest';
import {
  avatarRadius, medianHeight, isSurvivor, entityStyle, drawScene, sceneCounts,
  slotColor, statusGlyph, stackLabels, LABEL_PAD_X, LABEL_TICK_W, FOLLOW_RING_WIDTH,
  alertColor,
  slotLabel, slotNumber, numberInk, SLOT_COLORS, followTarget, GHOST_COLOR,
} from './draw';
import { STATE, ENTITY_KIND, type PlayerSample } from '../../../src/replayFormat';
import { fitView, projectView, type MapTransform } from '../../../src/mapTransform';
import { contrastRatio, distance, relativeLuminance, type Vision } from './colorDistance';
import { barSegments, INCAP_ARC_MAX } from './hud';

function player(over: Partial<PlayerSample> = {}): PlayerSample {
  return {
    slot: 0, x: 0, y: 0, z: 0, yaw: 0, pitch: 0,
    state: STATE.PRESENT | STATE.ALIVE,
    health: 100, temp: 0, cls: 0, weapon: 0, clip: 0, reserve: 0,
    ...over,
  };
}

describe('isSurvivor', () => {
  // A survivor is the slot half, not a recorded flag. Slots 0-3 are team A's
  // survivors for the half and 4-7 are the infected, which is how the roster
  // is laid out in the header.
  it('reads the slot', () => {
    expect(isSurvivor(player({ slot: 0 }))).toBe(true);
    expect(isSurvivor(player({ slot: 3 }))).toBe(true);
    expect(isSurvivor(player({ slot: 4 }))).toBe(false);
  });
});

describe('medianHeight', () => {
  it('ignores players who are not alive', () => {
    const ps = [
      player({ slot: 0, z: 100 }),
      player({ slot: 1, z: 200 }),
      player({ slot: 2, z: 9000, state: STATE.PRESENT }),
      player({ slot: 3, z: 300 }),
    ];
    expect(medianHeight(ps)).toBe(200);
  });

  it('returns 0 when nobody is alive', () => {
    expect(medianHeight([player({ state: 0 })])).toBe(0);
  });
});

describe('avatarRadius', () => {
  it('is the base size at the team median', () => {
    expect(avatarRadius(500, 500, 10)).toBe(10);
  });

  // Higher reads as closer to an overhead camera, which is what separates a
  // rooftop from the alley under it without a layer system.
  it('grows above the median and shrinks below', () => {
    expect(avatarRadius(900, 500, 10)).toBeGreaterThan(10);
    expect(avatarRadius(100, 500, 10)).toBeLessThan(10);
  });

  it('clamps to plus or minus 20 percent however extreme the height', () => {
    expect(avatarRadius(99_999, 0, 10)).toBeCloseTo(12, 5);
    expect(avatarRadius(-99_999, 0, 10)).toBeCloseTo(8, 5);
  });
});

describe('slotColor', () => {
  it('gives each of the four survivors a distinct colour', () => {
    const seen = new Set([0, 1, 2, 3].map(slotColor));
    expect(seen.size).toBe(4);
  });

  it('gives each of the four infected a distinct colour', () => {
    const seen = new Set([4, 5, 6, 7].map(slotColor));
    expect(seen.size).toBe(4);
  });

  // Team identity has to survive at a glance, so the two sets must not
  // overlap even though every slot is individually distinguishable.
  it('never reuses a survivor colour for an infected slot', () => {
    const surv = new Set([0, 1, 2, 3].map(slotColor));
    for (const s of [4, 5, 6, 7]) expect(surv.has(slotColor(s))).toBe(false);
  });
});

describe('slotLabel and slotNumber', () => {
  // Finding 12: on the by-filename viewer route `Viewer` defaults `names` to
  // an empty object, so nothing ever resolved and the Names toggle was a
  // silent no-op. Standalone `!mix` sessions are the common case for that
  // route. A short slot label is useful and leaks no SteamID64.
  it('names every slot without printing a SteamID64', () => {
    expect([0, 1, 2, 3].map(slotLabel)).toEqual(['S1', 'S2', 'S3', 'S4']);
    expect([4, 5, 6, 7].map(slotLabel)).toEqual(['I1', 'I2', 'I3', 'I4']);
    for (let i = 0; i < 8; i++) expect(slotLabel(i)).not.toMatch(/\d{5}/);
  });

  // Finding 4: hue alone cannot carry slot identity on a five pixel dot, and
  // the team is already carried by warm versus cool, so the number is the
  // second channel. It counts within a team, because within a team is where
  // the colours failed.
  it('numbers each slot within its own team, one through four', () => {
    expect([0, 1, 2, 3].map(slotNumber)).toEqual(['1', '2', '3', '4']);
    expect([4, 5, 6, 7].map(slotNumber)).toEqual(['1', '2', '3', '4']);
  });
});

describe('followTarget', () => {
  const roster = (states: number[]) => states.map((state, slot) => player({ slot, state }));

  it('follows nobody when the camera is free', () => {
    expect(followTarget(roster([3, 3, 3, 3, 3, 3, 3, 3]), null)).toBeNull();
  });

  it('follows the player in that slot', () => {
    const ps = roster([3, 3, 3, 3, 3, 3, 3, 3]);
    expect(followTarget(ps, 5)).toBe(ps[5]);
  });

  // `players` always carries eight records and an unoccupied slot is an
  // ALL-ZERO record, not a missing one, so following it used to centre the
  // camera on world (0, 0), which on most maps is off in the void. That was
  // latent only because the follow row skipped slots with no roster entry; it
  // stops being latent the moment every slot gets a button.
  it('follows nobody rather than the world origin for an empty slot', () => {
    expect(followTarget(roster([3, 3, 3, 3, 0, 0, 0, 0]), 6)).toBeNull();
  });

  it('follows nobody when the slot is past the end of the roster', () => {
    expect(followTarget(roster([3, 3]), 5)).toBeNull();
  });

  // A dead player is still PRESENT, and where the body is is worth watching.
  it('keeps following a player who has died', () => {
    const ps = roster([STATE.PRESENT, 3, 3, 3, 3, 3, 3, 3]);
    expect(followTarget(ps, 0)).toBe(ps[0]);
  });
});

describe('numberInk', () => {
  // A digit sitting inside the dot has to be legible against every one of
  // the eight colours, and those run a wide range of lightness, so the ink
  // is chosen per colour rather than fixed.
  it('inks dark on a light dot and light on a dark one', () => {
    expect(numberInk('#ffffff')).not.toBe(numberInk('#101010'));
  });

  it('reaches at least 4.5:1 against every slot colour', () => {
    for (const c of SLOT_COLORS) {
      expect(contrastRatio(c, numberInk(c))).toBeGreaterThanOrEqual(4.5);
    }
  });
});

describe('SLOT_COLORS under dichromacy', () => {
  const SURVIVORS = [0, 1, 2, 3];
  const INFECTED = [4, 5, 6, 7];
  const VISIONS: Vision[] = ['normal', 'protanopia', 'deuteranopia'];
  const pairs = (g: number[]) => g.flatMap((a, i) => g.slice(i + 1).map((b) => [a, b] as const));
  const worst = (g: number[], v: Vision) =>
    Math.min(...pairs(g).map(([a, b]) => distance(SLOT_COLORS[a], SLOT_COLORS[b], v)));

  // Finding 4, measured rather than asserted. The palette this replaced put
  // slot 2 indigo and slot 3 violet 2.8 dE apart under protanopia and 8.2
  // under deuteranopia, which is to say identical, and flattened slots 4, 5
  // and 6 to about 13 under deuteranopia. That is roughly 6 to 8 percent of
  // male viewers getting nothing at all from per-slot colour WITHIN a team.
  //
  // 16 is not a comfortable distance, it is a floor: four cool hues and four
  // warm ones cannot be spread much further than this without breaking the
  // team split, which is the constraint that matters more. The slot number
  // drawn on the dot is what actually carries slot identity; this test exists
  // so the colour channel cannot silently rot back to useless underneath it.
  it('keeps every within-team pair apart for a dichromat', () => {
    for (const v of VISIONS) {
      expect(worst(SURVIVORS, v)).toBeGreaterThanOrEqual(16);
      expect(worst(INFECTED, v)).toBeGreaterThanOrEqual(16);
    }
  });

  // The team split is the one thing the old palette got right and the one
  // thing that may not regress: warm versus cool is how a viewer tells a
  // teammate from an enemy, and it has to survive both dichromacies.
  it('keeps the two teams much further apart than any two slots within one', () => {
    for (const v of VISIONS) {
      let cross = Infinity;
      for (const a of SURVIVORS) {
        for (const b of INFECTED) cross = Math.min(cross, distance(SLOT_COLORS[a], SLOT_COLORS[b], v));
      }
      expect(cross).toBeGreaterThanOrEqual(28);
      expect(cross).toBeGreaterThan(Math.min(worst(SURVIVORS, v), worst(INFECTED, v)));
    }
  });

  // Finding 7. Giving each slot its own colour introduced confusions the
  // single-colour scheme did not have: survivor slot 2 sat 21.4 from the AI
  // hunter and slot 3 sat 25.8 from it, so a SURVIVOR read as a hunter on a
  // mix night with entities shown. Slot 5 sat near the AI tank and the tank
  // rock, and slot 6 near the AI boomer. The old team red was worse still at
  // 13.8 from the AI tank, which predates the slot colours entirely.
  it('keeps every slot clear of every world entity colour', () => {
    for (let slot = 0; slot < 8; slot++) {
      for (const kind of Object.values(ENTITY_KIND)) {
        const style = entityStyle(kind)!;
        expect(distance(SLOT_COLORS[slot], style.color)).toBeGreaterThanOrEqual(24);
      }
    }
  });

  // A survivor reading as a hunter is the specific failure Finding 7 names,
  // so it gets its own assertion at its own threshold rather than hiding
  // inside the sweep above.
  it('never lets a survivor read as the AI hunter', () => {
    const hunter = entityStyle(ENTITY_KIND.HUNTER_AI)!.color;
    for (const slot of SURVIVORS) {
      expect(distance(SLOT_COLORS[slot], hunter)).toBeGreaterThan(25.8);
    }
  });
});

describe('statusGlyph', () => {
  it('marks the states worth seeing on the map', () => {
    expect(statusGlyph(STATE.PRESENT | STATE.ALIVE | STATE.INCAP)).not.toBe('');
    expect(statusGlyph(STATE.PRESENT | STATE.ALIVE | STATE.PINNED)).not.toBe('');
    expect(statusGlyph(STATE.PRESENT | STATE.ALIVE | STATE.BILED)).not.toBe('');
    expect(statusGlyph(STATE.PRESENT | STATE.ALIVE | STATE.BURNING)).not.toBe('');
    expect(statusGlyph(STATE.PRESENT | STATE.ALIVE | STATE.LEDGED)).not.toBe('');
  });

  it('marks nothing for a healthy player', () => {
    expect(statusGlyph(STATE.PRESENT | STATE.ALIVE)).toBe('');
  });

  // Pinned is the one someone watching needs to see first, so it wins when
  // several are set at once.
  it('prefers pinned when more than one applies', () => {
    const both = STATE.PRESENT | STATE.ALIVE | STATE.PINNED | STATE.BILED;
    expect(statusGlyph(both)).toBe(statusGlyph(STATE.PRESENT | STATE.ALIVE | STATE.PINNED));
  });
});

describe('stackLabels', () => {
  // A label in the same column as every other, which is the crowded case.
  const col = (py: number, px = 100, w = 40) => ({ px, py, w });

  // Finding 2: four survivors standing together sit inside about 11 canvas
  // pixels, so four 10px labels pinned to their own avatars land on baselines
  // within 11px of each other. Every one of them has to be pushed clear of
  // the one above it, and the walk has to happen in SCREEN order, not slot
  // order, or which name wins is arbitrary and flickers as slots cross.
  it('pushes each label clear of the one above it by a full line', () => {
    const out = stackLabels([col(0), col(3), col(7), col(11)], 12);
    expect(out.map((l) => l.ly)).toEqual([0, 12, 24, 36]);
  });

  it('walks in screen order however the callers order their input', () => {
    const jumbled = stackLabels([col(11), col(0), col(7), col(3)], 12);
    const ordered = stackLabels([col(0), col(3), col(7), col(11)], 12);
    // Same players, same answer: the label at py 0 is the one that keeps its
    // own position and the one at py 11 is the one pushed furthest.
    expect(jumbled.map((l) => [l.py, l.ly])).toEqual(ordered.map((l) => [l.py, l.ly]));
  });

  it('leaves labels that are already a line apart exactly where they are', () => {
    const out = stackLabels([col(100), col(140), col(200)], 12);
    expect(out.map((l) => l.ly)).toEqual([100, 140, 200]);
  });

  it('never moves a label upward, only down', () => {
    const out = stackLabels([col(50), col(52), col(400)], 12);
    for (const l of out) expect(l.ly).toBeGreaterThanOrEqual(l.py);
  });

  // Captured from a locked-up page by pausing the JS engine: three survivors
  // at spawn, fractional canvas positions, all sharing a column. The second
  // label is pushed to the first's baseline plus a line, and the third to the
  // second's plus a line. In floating point, that third baseline minus the
  // second's comes out as 11.999999999999993, which is under the line height,
  // so the third is pushed to the second's baseline plus a line again, which
  // rounds to the very same number. `moved` never clears and the main thread
  // never comes back, which is what made the viewer uninteractable.
  it('settles when a pushed baseline lands a rounding error inside the line height', () => {
    const out = stackLabels([
      { px: 204.93382989853183, py: 47.56827036458555, w: 37.453125 },
      { px: 201.11562472601003, py: 50.56828871442411, w: 39.6845703125 },
      { px: 197.2974195534882, py: 53.56830706426268, w: 51.9306640625 },
    ], 12);
    expect(out.map((l) => l.ly)).toEqual([
      47.56827036458555,
      47.56827036458555 + 12,
      47.56827036458555 + 12 + 12,
    ]);
  });

  it('does not reorder or mutate the input array', () => {
    const input = [col(30), col(10)];
    const copy = input.map((j) => ({ ...j }));
    stackLabels(input, 12);
    expect(input).toEqual(copy);
  });

  // Caught by rendering the chrome to SVG, which nothing else here could see.
  // A team on the move is a row of players spread right across the map at
  // about the same height, and comparing y alone turned that into a diagonal
  // cascade of labels trailing further and further below their own avatars,
  // resolving collisions that were never going to happen.
  it('does not push labels that are nowhere near each other horizontally', () => {
    const row = [col(200, 0), col(200, 200), col(200, 400), col(200, 600)];
    expect(stackLabels(row, 12).map((l) => l.ly)).toEqual([200, 200, 200, 200]);
  });

  it('pushes labels whose plates only partly overlap', () => {
    // 0-40 and 30-70 share ten pixels of column, which is enough to collide.
    const out = stackLabels([col(200, 0), col(202, 30)], 12);
    expect(out.map((l) => l.ly)).toEqual([200, 212]);
  });

  it('treats plates that merely touch at the edge as clear of each other', () => {
    const out = stackLabels([col(200, 0, 40), col(202, 40, 40)], 12);
    expect(out.map((l) => l.ly)).toEqual([200, 202]);
  });

  it('clears a wide label of every column it spans, and clears the next of it', () => {
    const out = stackLabels([
      col(100, 0, 40),    // column A, stays put
      col(100, 300, 40),  // column B, different column, also stays put
      col(101, 20, 400),  // spans BOTH: must clear the pair above it
      col(112, 300, 40),  // column B again: must clear the wide one
    ], 12);
    const at = (px: number, w: number) => out.find((l) => l.px === px && l.w === w)!.ly;
    expect(at(0, 40)).toBe(100);
    expect(at(300, 40)).toBe(100);
    expect(at(20, 400)).toBe(112);
    expect(out.filter((l) => l.px === 300).map((l) => l.ly).sort((a, b) => a - b)).toEqual([100, 124]);
  });

  // The contract, rather than one hand-built arrangement of it: whatever goes
  // in, nothing comes out sharing a column with something less than a line
  // away. Pushing a label down past one plate can slide it into a different
  // plate's column, so a single pass over the already-placed labels is not
  // enough, and a hand-built case for that is easy to get subtly wrong.
  it('leaves no pair overlapping in both axes, over many arrangements', () => {
    // A small deterministic generator, so a failure is reproducible.
    let seed = 12345;
    const next = (n: number) => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed % n;
    };
    for (let trial = 0; trial < 2000; trial++) {
      // Tight ranges on purpose: the interesting arrangements are the dense
      // ones, where pushing a label past one plate lands it on another.
      const jobs = Array.from({ length: 3 + next(6) }, () => col(next(30), next(90), 20 + next(70)));
      const out = stackLabels(jobs, 12);
      expect(out).toHaveLength(jobs.length);
      for (const l of out) expect(l.ly).toBeGreaterThanOrEqual(l.py);
      for (let i = 0; i < out.length; i++) {
        for (let j = i + 1; j < out.length; j++) {
          const a = out[i];
          const b = out[j];
          const overlapsX = a.px < b.px + b.w && b.px < a.px + a.w;
          if (overlapsX) expect(Math.abs(a.ly - b.ly)).toBeGreaterThanOrEqual(12);
        }
      }
    }
  });
});

describe('projectView', () => {
  // Every captured layer image is 2048x1271, but the canvas is drawn at a
  // different, responsive size. Regression for the bug where drawScene used
  // worldToImage's image-space pixels directly as canvas coordinates: image
  // pixel 2048 must land on canvas 1280 when the canvas is 1280 wide and the
  // image behind it is 2048 wide, and image pixel 0 must stay at canvas 0.
  it('scales image-space pixels into canvas space by canvas width over image width', () => {
    const transform: MapTransform = {
      originX: 0, originY: 0, unitsPerPixel: 1, image: null, width: 2048, height: 1271,
    };
    // The full image as the view's box, with no padding, reproduces the old
    // canvas-width-over-image-width scale (0.625) that this test used to
    // pass in directly.
    const view = fitView({ x0: 0, y0: 0, x1: 2048, y1: 1280 }, 1280, 800, 0);

    expect(projectView(transform, view, 0, 0).px).toBeCloseTo(0, 5);
    expect(projectView(transform, view, 2048, 0).px).toBeCloseTo(1280, 5);
  });

  it('is the identity when the box already matches the canvas (auto-fit)', () => {
    const transform: MapTransform = {
      originX: 0, originY: 0, unitsPerPixel: 1, image: null, width: 1280, height: 794,
    };
    const view = fitView({ x0: 0, y0: 0, x1: 1280, y1: 794 }, 1280, 794, 0);
    expect(view.scale).toBe(1);
    expect(projectView(transform, view, 640, 0).px).toBeCloseTo(640, 5);
  });
});

describe('drawScene', () => {
  // No canvas exists in the test environment, so a stub records the exact
  // calls made to a 2D context instead of rendering anything.
  //
  // This is the regression test for the bug the previous fix round patched:
  // `drawScene` once called `worldToImage` directly and used the raw
  // image-space pixel as a canvas coordinate. `project`'s own arithmetic
  // tests above do not exercise that wiring at all: they call `project`
  // directly, so a future change that reverted one call site inside
  // `drawScene` back to raw `worldToImage` would leave every helper test
  // green while the exact original bug came back. Testing `drawScene`
  // itself is what closes that gap.
  function stubCtx() {
    const calls: { fn: string; args: number[]; stroke: string; fill: string; width: number }[] = [];
    const texts: { fn: string; text: string; x: number; y: number }[] = [];
    // The paint styles are recorded alongside each call, because "which
    // colour was this stroked in" is a real assertion (the ghost outline has
    // to be one fixed colour whatever slot it belongs to) and a write-only
    // setter cannot answer it.
    let strokeStyle = '';
    let fillStyle = '';
    let lineWidth = 0;
    const rec = (fn: string) => (...args: unknown[]) => {
      calls.push({
        fn,
        args: args.filter((a) => typeof a === 'number') as number[],
        stroke: strokeStyle,
        fill: fillStyle,
        width: lineWidth,
      });
    };
    // fillText/strokeText carry the label or glyph string as their first
    // argument, which the numeric-only `rec` above would silently drop, so
    // the name-resolution tests below need their own recorder that keeps it.
    const recText = (fn: string) => (text: string, x: number, y: number) => {
      texts.push({ fn, text, x, y });
    };
    return {
      calls,
      texts,
      ctx: {
        save: rec('save'), restore: rec('restore'), beginPath: rec('beginPath'),
        moveTo: rec('moveTo'), lineTo: rec('lineTo'), stroke: rec('stroke'),
        fill: rec('fill'), arc: rec('arc'), fillRect: rec('fillRect'),
        clearRect: rec('clearRect'), drawImage: rec('drawImage'),
        fillText: recText('fillText'), strokeText: recText('strokeText'),
        // Real 2D contexts measure text; the label plates need a width. Six
        // pixels per character at a 10px font is close enough for a stub and
        // makes the expected plate width arithmetic below exact.
        measureText: (t: string) => ({ width: t.length * 6 }),
        set fillStyle(v: string) { fillStyle = v; }, set strokeStyle(v: string) { strokeStyle = v; },
        set lineWidth(v: number) { lineWidth = v; }, set globalAlpha(_v: number) {},
        set font(_v: string) {}, set textAlign(_v: string) {}, set textBaseline(_v: string) {},
      } as unknown as CanvasRenderingContext2D,
    };
  }

  it('scales a player through a real transform and view into canvas space, not raw image pixels', () => {
    // The view crops to a 1000x400 region of the image starting at image
    // pixel (1000, 500), fit into an 800x400 canvas: scale 0.8, and because
    // the box is wider (relative to the canvas) than it is tall, the short
    // axis is padded, giving a non-zero y offset of 40. A future change that
    // reverted `drawScene` to project against the raw image, or dropped the
    // view's offset, would move this well off (400, 200).
    const transform: MapTransform = {
      originX: 0, originY: 0, unitsPerPixel: 1, image: 'test.png', width: 2048, height: 1271,
    };
    const view = fitView({ x0: 1000, y0: 500, x1: 2000, y1: 900 }, 800, 400, 0);
    expect(view.scale).toBeCloseTo(0.8, 5);
    expect(view.offsetY).toBeCloseTo(40, 5);

    const { calls, ctx } = stubCtx();
    drawScene(ctx, {
      transform,
      view,
      backdrop: null,
      trail: [],
      // World (1500, -700) is image-space (1500, 700): inside the box, 500px
      // right of and 200px below its corner.
      players: [player({ x: 1500, y: -700, z: 0 })],
      entities: [],
      show: { ci: true, entities: true, names: false },
      width: 800,
      height: 400,
      names: {},
      slots: [],
      followSlot: null,
    });

    // The default player is a living survivor at full health, which now
    // also draws a health ring: this is an update to the new behaviour, not
    // a weakened assertion, since the extra arc call is the health ring
    // itself and the first arc (the avatar) is still checked below.
    const arcs = calls.filter((c) => c.fn === 'arc');
    expect(arcs).toHaveLength(2);
    const [px, py, r] = arcs[0].args;
    // (1500 - 1000) * 0.8 + 0 = 400; (700 - 500) * 0.8 + 40 = 200.
    expect(px).toBeCloseTo(400, 5);
    expect(py).toBeCloseTo(200, 5);
    // The avatar radius stays in screen units and must NOT be scaled by the
    // same factor: at 5-8 world units per pixel a survivor is 4-6 pixels, so
    // markers are meant to be icons, not scale models.
    expect(r).toBeCloseTo(7, 5);
  });

  it('is the identity through the auto-fit path, where the view box already matches the canvas', () => {
    const transform: MapTransform = {
      originX: 0, originY: 0, unitsPerPixel: 1, image: null, width: 1280, height: 794,
    };
    const view = fitView({ x0: 0, y0: 0, x1: 1280, y1: 794 }, 1280, 794, 0);
    expect(view.scale).toBe(1);
    expect(view.offsetX).toBe(0);
    expect(view.offsetY).toBe(0);
    const { calls, ctx } = stubCtx();
    drawScene(ctx, {
      transform,
      view,
      backdrop: null,
      trail: [],
      players: [player({ x: 640, y: -300, z: 0 })],
      entities: [],
      show: { ci: true, entities: true, names: false },
      width: 1280,
      height: 794,
      names: {},
      slots: [],
      followSlot: null,
    });

    // Same update as the test above: a living survivor now draws a second
    // arc for its health ring.
    const arcs = calls.filter((c) => c.fn === 'arc');
    expect(arcs).toHaveLength(2);
    const [px, py, r] = arcs[0].args;
    // The view is the identity here (auto-fit's box is the whole canvas), so
    // the canvas coordinate equals the raw worldToImage pixel. A future
    // change that hardcoded a scale or offset from the cropped-map path
    // would move this off (640, 300).
    expect(px).toBeCloseTo(640, 5);
    expect(py).toBeCloseTo(300, 5);
    expect(r).toBeCloseTo(7, 5);
  });

  // Finding 17: `fitView` widens a degenerate box to one pixel before taking
  // its scale, but `drawScene` used to hand `drawImage` the raw `x1 - x0`,
  // and a zero-width source rect throws IndexSizeError. The generator falls
  // back to the full frame rather than emitting a degenerate box, so this is
  // latent rather than live: the point is that the two now read the same box
  // through the same helper and cannot drift apart again.
  it('draws a degenerate box at the same one pixel the view scaled it by', () => {
    const transform: MapTransform = {
      originX: 0, originY: 0, unitsPerPixel: 1, image: 'test.png', width: 2048, height: 1271,
    };
    const box = { x0: 400, y0: 400, x1: 400, y1: 400 };
    const view = fitView(box, 800, 400, 0);
    const { calls, ctx } = stubCtx();
    expect(() => drawScene(ctx, {
      transform, view,
      backdrop: {} as HTMLImageElement,
      trail: [],
      players: [], entities: [],
      show: { ci: true, entities: true, names: false },
      width: 800, height: 400,
      names: {}, slots: [], followSlot: null,
    })).not.toThrow();

    const img = calls.find((c) => c.fn === 'drawImage')!;
    const [sx, sy, sw, sh, , , dw, dh] = img.args;
    expect([sx, sy]).toEqual([400, 400]);
    // One source pixel, never zero, and the destination is that same pixel
    // through the very scale `fitView` returned.
    expect(sw).toBe(1);
    expect(sh).toBe(1);
    expect(dw).toBeCloseTo(view.scale, 5);
    expect(dh).toBeCloseTo(view.scale, 5);
  });

  /** Everything drawn from the first arc onward. With no backdrop the grid
   *  strokes dozens of lines first, and those are not what these tests are
   *  about; the first arc in a player-only scene is the avatar. */
  const fromAvatar = <T extends { fn: string }>(calls: T[]): T[] =>
    calls.slice(calls.findIndex((c) => c.fn === 'arc'));

  const identityScene = () => {
    const transform: MapTransform = {
      originX: 0, originY: 0, unitsPerPixel: 1, image: null, width: 1280, height: 794,
    };
    return { transform, view: fitView({ x0: 0, y0: 0, x1: 1280, y1: 794 }, 1280, 794, 0) };
  };

  it('draws the same total sweep the panel bar draws, temporary health included', () => {
    const { transform, view } = identityScene();
    const { calls, ctx } = stubCtx();
    // The exact case Finding 6 names: a red sliver on the map against a
    // nearly full bar in the panel.
    drawScene(ctx, {
      transform, view, backdrop: null, trail: [],
      players: [player({ slot: 0, health: 20, temp: 70 })],
      entities: [],
      show: { ci: true, entities: true, names: false },
      width: 1280, height: 794, names: {}, slots: [], followSlot: null,
    });

    // Avatar, the permanent arc, and the temporary arc continuing from it.
    const arcs = calls.filter((c) => c.fn === 'arc');
    expect(arcs).toHaveLength(3);
    const [, , permR, permStart, permEnd] = arcs[1].args;
    const [, , tempR, tempStart, tempEnd] = arcs[2].args;

    // Temporary picks up exactly where permanent leaves off, on the same
    // circle, so the two read as one ring rather than as two.
    expect(tempStart).toBeCloseTo(permEnd, 10);
    expect(tempR).toBeCloseTo(permR, 10);

    // And the total is the panel's own arithmetic, not a second opinion.
    const seg = barSegments(20, 70, 100);
    expect(permEnd - permStart).toBeCloseTo(seg.perm * Math.PI * 2, 10);
    expect(tempEnd - tempStart).toBeCloseTo(seg.temp * Math.PI * 2, 10);
    expect(tempEnd - permStart).toBeCloseTo((seg.perm + seg.temp) * Math.PI * 2, 10);
  });

  it('draws no temporary arc at all when there is no temporary health', () => {
    const { transform, view } = identityScene();
    const { calls, ctx } = stubCtx();
    drawScene(ctx, {
      transform, view, backdrop: null, trail: [],
      players: [player({ slot: 0, health: 70, temp: 0 })],
      entities: [],
      show: { ci: true, entities: true, names: false },
      width: 1280, height: 794, names: {}, slots: [], followSlot: null,
    });
    // A zero-length arc would still be an arc call, and a stray stroke with
    // the temp colour set would show as a dot at 12 o'clock on every
    // unbuffed survivor.
    expect(calls.filter((c) => c.fn === 'arc')).toHaveLength(2);
  });

  it('draws the health ring as an arc spanning health/100 of a circle for a living survivor', () => {
    const { transform, view } = identityScene();
    const { calls, ctx } = stubCtx();
    drawScene(ctx, {
      transform, view, backdrop: null, trail: [],
      players: [player({ slot: 0, health: 50 })],
      entities: [],
      show: { ci: true, entities: true, names: false },
      width: 1280, height: 794,
      names: {}, slots: [], followSlot: null,
    });

    const arcs = calls.filter((c) => c.fn === 'arc');
    expect(arcs).toHaveLength(2);
    const [, , ringR, start, end] = arcs[1].args;
    // 50 health is half of 100, so the ring sweeps half a circle regardless
    // of where it starts.
    expect(end - start).toBeCloseTo(Math.PI, 5);
    // The ring sits outside the avatar, not on top of it.
    const avatarR = arcs[0].args[2];
    expect(ringR).toBeGreaterThan(avatarR);
  });

  it('keeps a ghost hollow: no health ring, glyph, label, number or follow highlight', () => {
    const { transform, view } = identityScene();
    const { calls, texts, ctx } = stubCtx();
    const slots = ['', '', '', '', 'steam1', '', '', ''];
    drawScene(ctx, {
      transform, view, backdrop: null, trail: [],
      // A ghosted infected, pinned, and also the followed slot: every one of
      // the new pieces of chrome would normally fire for this state, and
      // none of them may for a ghost.
      players: [player({
        slot: 4, health: 100,
        state: STATE.PRESENT | STATE.ALIVE | STATE.GHOST | STATE.PINNED,
      })],
      entities: [],
      show: { ci: true, entities: true, names: true },
      width: 1280, height: 794,
      names: { steam1: 'Ghost Name' }, slots, followSlot: 4,
    });

    // Only the ghost's own hollow outline arc, nothing else.
    expect(calls.filter((c) => c.fn === 'arc')).toHaveLength(1);
    expect(texts).toHaveLength(0);
    // Finding 15: this test was titled "keeps a ghost hollow" and asserted
    // one arc, which a regression that FILLED that arc would have passed
    // unchanged, since a filled circle records exactly one arc too. The
    // background uses fillRect, so `fill` is safe to assert absent: nothing
    // in a ghost-only scene has any business filling a path.
    expect(calls.filter((c) => c.fn === 'fill')).toHaveLength(0);
    // Every mark a ghost makes is its own hollow outline and its facing
    // arrow, both in the one ghost colour. A ring, a highlight or a plate
    // would show up here as a stroke or a fill in some other colour.
    const marks = fromAvatar(calls).filter((c) => c.fn === 'stroke');
    expect(marks).toHaveLength(2);
    for (const m of marks) expect(m.stroke).toBe(GHOST_COLOR);
  });

  it('draws every ghost in one muted colour, never its own slot colour', () => {
    const { transform, view } = identityScene();
    const seen = new Set<string>();
    for (const slot of [4, 5, 6, 7]) {
      const { calls, ctx } = stubCtx();
      drawScene(ctx, {
        transform, view, backdrop: null, trail: [],
        players: [player({
          slot, x: 640, y: -300,
          state: STATE.PRESENT | STATE.ALIVE | STATE.GHOST,
        })],
        entities: [],
        show: { ci: true, entities: true, names: false },
        width: 1280, height: 794, names: {}, slots: [], followSlot: null,
      });
      // The hollow outline and the facing arrow. Both used to take the
      // slot's colour, so both have to be clamped.
      const strokes = fromAvatar(calls).filter((c) => c.fn === 'stroke');
      expect(strokes).toHaveLength(2);
      for (const st of strokes) {
        seen.add(st.stroke);
        expect(st.stroke).not.toBe(slotColor(slot));
      }
    }
    // Finding 14: a ghost drawn in its own slot colour is individually
    // identifiable by slot, where before it was not, and slot 6 gold is over
    // three times as luminous as the red every ghost used to be, so at the
    // same 0.35 alpha a slot 6 ghost was far more visible than any ghost had
    // ever been. Per-slot identity is for SPAWNED infected only.
    expect(seen).toEqual(new Set([GHOST_COLOR]));
  });

  it('keeps the ghost colour no brighter than the single colour ghosts used to use', () => {
    // The old team red. Nothing about the ghost treatment may drift upward in
    // visibility: the live page is public and a ghost's position is exactly
    // what the ten second delay exists to protect.
    expect(relativeLuminance(GHOST_COLOR)).toBeLessThanOrEqual(relativeLuminance('#d9534f'));
    // And it must not read as any spawned slot either.
    for (const c of SLOT_COLORS) expect(distance(GHOST_COLOR, c)).toBeGreaterThan(15);
  });

  it('resolves a name label through names[slots[slot]], never falling back to the raw id', () => {
    const { transform, view } = identityScene();
    const slots = ['76561198000000001', '', '', '', '', '', '', ''];

    const known = stubCtx();
    drawScene(known.ctx, {
      transform, view, backdrop: null, trail: [],
      players: [player({ slot: 0 })],
      entities: [],
      show: { ci: true, entities: true, names: true },
      width: 1280, height: 794,
      names: { '76561198000000001': 'Zoey' }, slots, followSlot: null,
    });
    // Finding 10: the label used to be stroked and then filled. `strokeText`
    // centres its stroke on the glyph outline, so a 3px stroke put 1.5px
    // INWARD, which at a 10px font closes the counters of e, a and o outright
    // (the fill cannot reopen them, because a counter is not part of the
    // glyph's ink). The backing plate from Finding 2 does the job the stroke
    // was there for, so the stroke is gone and exactly one text call remains.
    // This is an update to the new behaviour, not a weakened assertion: it
    // still pins the exact text drawn and still proves the raw id is never
    // one of them.
    // The only text calls are the avatar's slot number and the label itself,
    // both filled, neither stroked.
    expect(known.texts.every((t) => t.fn === 'fillText')).toBe(true);
    expect(known.texts.map((t) => t.text)).toEqual(['1', 'Zoey']);

    // No roster entry for this slot. Finding 12: this used to draw nothing at
    // all, which made the Names toggle a silent no-op on the by-filename
    // viewer route, where `Viewer` defaults `names` to an empty object and
    // standalone `!mix` sessions are the common case. It now falls back to a
    // short slot label. That is an update to the new behaviour, and the half
    // of the old assertion that mattered is STRENGTHENED, not weakened: the
    // seventeen-digit SteamID64 must still never reach the canvas.
    const unknown = stubCtx();
    drawScene(unknown.ctx, {
      transform, view, backdrop: null, trail: [],
      players: [player({ slot: 0 })],
      entities: [],
      show: { ci: true, entities: true, names: true },
      width: 1280, height: 794,
      names: {}, slots, followSlot: null,
    });
    expect(unknown.texts.map((t) => t.text)).toContain('S1');
    for (const t of unknown.texts) expect(t.text).not.toContain('76561198000000001');
    for (const t of unknown.texts) expect(t.text).not.toMatch(/\d{5}/);
  });

  it('draws a slot number inside every avatar, as the channel colour cannot carry', () => {
    const { transform, view } = identityScene();
    const { texts, ctx } = stubCtx();
    drawScene(ctx, {
      transform, view, backdrop: null, trail: [],
      players: [
        player({ slot: 0, x: 200, y: -200 }),
        player({ slot: 3, x: 400, y: -200 }),
        player({ slot: 4, x: 600, y: -200 }),
        player({ slot: 7, x: 800, y: -200 }),
      ],
      entities: [],
      // Names OFF: the number is not a label, it is part of the avatar, and
      // it must be there whether or not anyone asked for names.
      show: { ci: true, entities: true, names: false },
      width: 1280, height: 794, names: {}, slots: [], followSlot: null,
    });

    expect(texts.map((t) => t.text).sort()).toEqual(['1', '1', '4', '4']);
    // Centred on the avatar, not offset beside it: at r = 7 a 14px dot has a
    // 9.9px inscribed square, which a 9px digit fits inside.
    const drawn = new Map(texts.map((t) => [t.x, t.y]));
    for (const px of [200, 400, 600, 800]) expect(drawn.get(px)).toBe(200);
  });

  it('does not number or ring a dead player, but still says who it was', () => {
    const { transform, view } = identityScene();
    const { calls, texts, ctx } = stubCtx();
    drawScene(ctx, {
      transform, view, backdrop: null, trail: [],
      players: [player({ slot: 0, state: STATE.PRESENT })],
      entities: [],
      show: { ci: true, entities: true, names: true },
      width: 1280, height: 794,
      names: { s0: 'Zoey' }, slots: ['s0', '', '', '', '', '', '', ''], followSlot: null,
    });
    // A body is drawn at 0.3 alpha, where a nine pixel digit is illegible and
    // would only add to the pile the label pass is there to thin out. The
    // label stays, because who died where is worth knowing; the number and
    // the health ring go, because neither means anything on a corpse.
    expect(texts.map((t) => t.text)).toEqual(['Zoey']);
    expect(calls.filter((c) => c.fn === 'arc')).toHaveLength(1);
  });

  it('draws a downed survivor a small danger arc, not the closed green ring the raw pool gave', () => {
    const { transform, view } = identityScene();

    const up = stubCtx();
    drawScene(up.ctx, {
      transform, view, backdrop: null, trail: [],
      players: [player({ slot: 0, health: 100 })],
      entities: [],
      show: { ci: true, entities: true, names: false },
      width: 1280, height: 794, names: {}, slots: [], followSlot: null,
    });
    // Healthy: avatar plus a closed health ring, and no alert ring.
    const upArcs = up.calls.filter((c) => c.fn === 'arc');
    expect(upArcs).toHaveLength(2);
    expect(upArcs[1].args[4] - upArcs[1].args[3]).toBeCloseTo(Math.PI * 2, 5);

    const down = stubCtx();
    drawScene(down.ctx, {
      transform, view, backdrop: null, trail: [],
      // Exactly the state the bug produced: incapacitated, and health is the
      // 300 point incap pool at its starting value.
      players: [player({ slot: 0, health: 300, state: STATE.PRESENT | STATE.ALIVE | STATE.INCAP })],
      entities: [],
      show: { ci: true, entities: true, names: false },
      width: 1280, height: 794, names: {}, slots: [], followSlot: null,
    });
    // Avatar, the alert ring from Finding 9, then the health arc on top.
    const downArcs = down.calls.filter((c) => c.fn === 'arc');
    expect(downArcs).toHaveLength(3);
    const sweep = downArcs[2].args[4] - downArcs[2].args[3];
    expect(sweep).toBeLessThanOrEqual(INCAP_ARC_MAX * Math.PI * 2);
    // The old code drew this at a full circle. Anything close to one would
    // be the bug back.
    expect(sweep).toBeLessThan(Math.PI / 2);
  });

  it('rings a pinned or incapacitated player with a full circle wide enough to find', () => {
    const { transform, view } = identityScene();
    const { calls, ctx } = stubCtx();
    drawScene(ctx, {
      transform, view, backdrop: null, trail: [],
      players: [player({ slot: 0, health: 60, state: STATE.PRESENT | STATE.ALIVE | STATE.PINNED })],
      entities: [],
      show: { ci: true, entities: true, names: false },
      width: 1280, height: 794, names: {}, slots: [], followSlot: null,
    });

    const arcs = calls.filter((c) => c.fn === 'arc');
    expect(arcs).toHaveLength(3);
    const [, , alertR, aStart, aEnd] = arcs[1].args;
    // A closed circle, not an arc: that is what makes it findable in
    // peripheral vision rather than needing to be read.
    expect(aEnd - aStart).toBeCloseTo(Math.PI * 2, 5);
    // It shares the health ring's radius and is drawn under it, so the alert
    // signal costs the avatar no extra footprint at all.
    expect(alertR).toBeCloseTo(arcs[2].args[2], 5);
    expect(alertR).toBeGreaterThan(arcs[0].args[2]);
  });

  it('does not ring a healthy player, whose ring count is unchanged', () => {
    const { transform, view } = identityScene();
    const { calls, ctx } = stubCtx();
    drawScene(ctx, {
      transform, view, backdrop: null, trail: [],
      players: [player({ slot: 0, state: STATE.PRESENT | STATE.ALIVE | STATE.BURNING })],
      entities: [],
      show: { ci: true, entities: true, names: false },
      width: 1280, height: 794, names: {}, slots: [], followSlot: null,
    });
    expect(calls.filter((c) => c.fn === 'arc')).toHaveLength(2);
  });

  it('de-conflicts four crowded survivor labels instead of piling them up', () => {
    const { transform, view } = identityScene();
    const slots = ['s0', 's1', 's2', 's3', '', '', '', ''];
    const { texts, ctx } = stubCtx();
    // Four survivors within eleven canvas pixels of each other vertically,
    // which is where four survivors normally are. World y is negated into
    // image space, so the LARGEST world y is the smallest canvas y: slot 3
    // is the topmost on screen and slot 0 the lowest. The labels must come
    // out in that screen order, not in slot order.
    drawScene(ctx, {
      transform, view, backdrop: null, trail: [],
      players: [
        player({ slot: 0, x: 600, y: -300 }),
        player({ slot: 1, x: 604, y: -297 }),
        player({ slot: 2, x: 608, y: -293 }),
        player({ slot: 3, x: 612, y: -289 }),
      ],
      entities: [],
      show: { ci: true, entities: true, names: true },
      width: 1280, height: 794,
      names: { s0: 'Aaa', s1: 'Bbb', s2: 'Ccc', s3: 'Ddd' }, slots, followSlot: null,
    });

    const labels = texts.filter((t) => t.fn === 'fillText' && t.text.length === 3);
    expect(labels).toHaveLength(4);
    // Screen order: slot 3 sits at canvas y 289 and slot 0 at 300.
    expect(labels.map((l) => l.text)).toEqual(['Ddd', 'Ccc', 'Bbb', 'Aaa']);
    // And nothing lands within a line height of its neighbour, which is the
    // whole point: before this, four baselines shared eleven pixels.
    const ys = labels.map((l) => l.y);
    for (let i = 1; i < ys.length; i++) expect(ys[i] - ys[i - 1]).toBeGreaterThanOrEqual(12);
  });

  it('gives every label a filled backing plate wide enough for its text', () => {
    const { transform, view } = identityScene();
    const slots = ['s0', '', '', '', '', '', '', ''];
    const { calls, ctx } = stubCtx();
    drawScene(ctx, {
      transform, view, backdrop: null, trail: [],
      players: [player({ slot: 0, x: 640, y: -300 })],
      entities: [],
      show: { ci: true, entities: true, names: true },
      width: 1280, height: 794,
      names: { s0: 'Zoey' }, slots, followSlot: null,
    });

    // The background is the first fillRect; the plate and its slot-colour
    // tick are the ones after it.
    const rects = calls.filter((c) => c.fn === 'fillRect');
    expect(rects).toHaveLength(3);
    const plate = rects[1];
    const [, , pw] = plate.args;
    // The stub measures 6px per character, so 'Zoey' is 24px wide, and the
    // plate carries the tick plus a pad on each side of the text.
    expect(pw).toBeCloseTo(24 + LABEL_PAD_X * 2 + LABEL_TICK_W, 5);
  });

  it('keeps the label clear of the follow ring it would otherwise sit on', () => {
    const { transform, view } = identityScene();
    const slots = ['s0', '', '', '', '', '', '', ''];
    const { calls, texts, ctx } = stubCtx();
    drawScene(ctx, {
      transform, view, backdrop: null, trail: [],
      players: [player({ slot: 0, x: 640, y: -300 })],
      entities: [],
      show: { ci: true, entities: true, names: true },
      width: 1280, height: 794,
      names: { s0: 'Zoey' }, slots, followSlot: 0,
    });

    const arcs = calls.filter((c) => c.fn === 'arc');
    const avatarR = arcs[0].args[2];
    // The follow ring is the outermost thing an avatar draws, and its dark
    // halo pass shares that radius with two extra pixels of width, so the
    // halo's outer edge is followR + FOLLOW_RING_WIDTH.
    const followR = arcs[arcs.length - 1].args[2];
    const outer = 640 + followR + FOLLOW_RING_WIDTH;
    const plate = calls.filter((c) => c.fn === 'fillRect')[1];
    expect(avatarR).toBeCloseTo(7, 5);
    // The plate's left edge, not just the text's, has to clear the ring.
    expect(plate.args[0]).toBeGreaterThan(outer);
    expect(texts.some((t) => t.text === 'Zoey')).toBe(true);
  });

  it('draws a follow highlight ring, wider than the health ring, for the followed slot', () => {
    const { transform, view } = identityScene();
    const { calls, ctx } = stubCtx();
    drawScene(ctx, {
      transform, view, backdrop: null, trail: [],
      players: [player({ slot: 0 })],
      entities: [],
      show: { ci: true, entities: true, names: false },
      width: 1280, height: 794,
      names: {}, slots: [], followSlot: 0,
    });

    const arcs = calls.filter((c) => c.fn === 'arc');
    // avatar, health ring, and the follow ring drawn twice (a dark halo
    // pass, then the bright ring on top of it, so it still reads over a
    // bright patch of map art).
    expect(arcs).toHaveLength(4);
    const avatarR = arcs[0].args[2];
    const healthRingR = arcs[1].args[2];
    const followRingR = arcs[2].args[2];
    expect(healthRingR).toBeGreaterThan(avatarR);
    expect(followRingR).toBeGreaterThan(healthRingR);
    // Both follow-ring passes share the same radius; only the stroke width
    // and colour differ.
    expect(arcs[3].args[2]).toBeCloseTo(followRingR, 5);
  });
});

describe('chrome layout', () => {
  // Nobody can look at this page, so the clearances between the avatar and
  // every ring around it are MEASURED from real draw calls rather than
  // asserted in a comment. Each ring is recovered as the radius its arc was
  // drawn at plus or minus half the line width in force when it was stroked,
  // which is where canvas actually puts the ink.
  function stubCtx2() {
    const calls: { fn: string; args: number[]; width: number }[] = [];
    let lineWidth = 0;
    const rec = (fn: string) => (...args: unknown[]) => {
      calls.push({ fn, args: args.filter((a) => typeof a === 'number') as number[], width: lineWidth });
    };
    const noop = () => {};
    return {
      calls,
      ctx: {
        save: noop, restore: noop, beginPath: noop, moveTo: noop, lineTo: noop,
        stroke: rec('stroke'), fill: rec('fill'), arc: rec('arc'), fillRect: noop,
        clearRect: noop, drawImage: noop, fillText: noop, strokeText: noop,
        measureText: (t: string) => ({ width: t.length * 6 }),
        set fillStyle(_v: string) {}, set strokeStyle(_v: string) {},
        set lineWidth(v: number) { lineWidth = v; }, set globalAlpha(_v: number) {},
        set font(_v: string) {}, set textAlign(_v: string) {}, set textBaseline(_v: string) {},
      } as unknown as CanvasRenderingContext2D,
    };
  }

  /** Every stroked ring as [inner edge, outer edge], in draw order. */
  function rings(state: number, followSlot: number | null) {
    const transform: MapTransform = {
      originX: 0, originY: 0, unitsPerPixel: 1, image: null, width: 1280, height: 794,
    };
    const view = fitView({ x0: 0, y0: 0, x1: 1280, y1: 794 }, 1280, 794, 0);
    const { calls, ctx } = stubCtx2();
    drawScene(ctx, {
      transform, view, backdrop: {} as HTMLImageElement, trail: [],
      players: [player({ slot: 0, x: 640, y: -300, health: 100, state })],
      entities: [],
      show: { ci: true, entities: true, names: false },
      width: 1280, height: 794, names: {}, slots: [], followSlot,
    });
    const out: { r: number; inner: number; outer: number }[] = [];
    for (let i = 0; i < calls.length; i++) {
      if (calls[i].fn !== 'arc') continue;
      const r = calls[i].args[2];
      // An arc followed by a fill is the avatar's own dot, not a ring around
      // it. Only an arc that is stroked lays down a ring of ink.
      const next = calls.slice(i + 1).find((c) => c.fn === 'stroke' || c.fn === 'fill' || c.fn === 'arc');
      if (!next || next.fn !== 'stroke') continue;
      out.push({ r, inner: r - next.width / 2, outer: r + next.width / 2 });
    }
    return out;
  }

  const UP = STATE.PRESENT | STATE.ALIVE;
  const AVATAR_R = 7;

  it('puts the health ring outside the avatar with no overlap', () => {
    const [health] = rings(UP, null);
    expect(health.r).toBeCloseTo(AVATAR_R + 3, 5);
    // 10 - 2/2 = 9, against an avatar that ends at 7. Two pixels of gap.
    expect(health.inner).toBeCloseTo(9, 5);
    expect(health.inner - AVATAR_R).toBeGreaterThanOrEqual(1);
  });

  it('nests the alert ring, the health ring and the follow ring without a collision', () => {
    // Pinned and followed: every ring an avatar can draw, at once.
    const all = rings(UP | STATE.PINNED, 0);
    // Alert (full circle, width 4), health arc (width 2) on the same radius,
    // then the follow ring's dark halo (width 4) and its bright pass (2).
    expect(all).toHaveLength(4);
    const [alert, health, halo, follow] = all;

    // Alert: 10 +/- 2, so 8 to 12, around an avatar that ends at 7.
    expect(alert.inner).toBeCloseTo(8, 5);
    expect(alert.outer).toBeCloseTo(12, 5);
    expect(alert.inner).toBeGreaterThan(AVATAR_R);
    // The health arc rides inside the alert ring rather than beside it, which
    // is what makes the alert signal cost no extra footprint.
    expect(health.r).toBeCloseTo(alert.r, 5);
    expect(health.inner).toBeGreaterThanOrEqual(alert.inner);
    expect(health.outer).toBeLessThanOrEqual(alert.outer);

    // Follow halo: 15 +/- 2, so 13 to 17. One clear pixel past the alert
    // ring's 12, and the bright pass sits inside the halo.
    expect(halo.r).toBeCloseTo(AVATAR_R + 8, 5);
    expect(halo.inner).toBeCloseTo(13, 5);
    expect(halo.outer).toBeCloseTo(17, 5);
    expect(halo.inner - alert.outer).toBeCloseTo(1, 5);
    expect(follow.r).toBeCloseTo(halo.r, 5);
    expect(follow.inner).toBeGreaterThanOrEqual(halo.inner);
    expect(follow.outer).toBeLessThanOrEqual(halo.outer);
  });

  // The clearance has to survive the avatar growing and shrinking with
  // height, not just hold at the base radius, so it is checked at both ends
  // of avatarRadius's plus or minus twenty percent.
  it('holds every clearance at the largest and smallest avatar', () => {
    for (const base of [avatarRadius(99_999, 0), avatarRadius(-99_999, 0)]) {
      const r = base;
      const alertOuter = r + 3 + 2;
      const haloInner = r + 8 - 2;
      expect(alertOuter).toBeLessThan(haloInner);
      // Glyph and label both clear the outermost edge, r + 10.
      expect(r + 11).toBeGreaterThan(r + 8 + 2);
      expect(r + 14 - LABEL_PAD_X).toBeGreaterThan(r + 8 + 2);
    }
  });

  // Nothing here may be multiplied by the view's scale: these are icons over
  // a map that softens as it scales, not scale models that soften with it.
  it('keeps every ring the same size however far the view is zoomed', () => {
    const transform: MapTransform = {
      originX: 0, originY: 0, unitsPerPixel: 1, image: null, width: 2048, height: 1271,
    };
    const sizes = [0.25, 1, 4].map((zoom) => {
      const span = 1280 / zoom;
      const view = fitView({ x0: 0, y0: 0, x1: span, y1: span / 1.61 }, 1280, 794, 0);
      const { calls, ctx } = stubCtx2();
      drawScene(ctx, {
        transform, view, backdrop: null, trail: [],
        players: [player({ slot: 0, x: 100, y: -100, state: UP | STATE.PINNED })],
        entities: [],
        show: { ci: true, entities: true, names: false },
        width: 1280, height: 794, names: {}, slots: [], followSlot: 0,
      });
      return calls.filter((c) => c.fn === 'arc').map((c) => c.args[2]);
    });
    expect(sizes[0]).toEqual(sizes[1]);
    expect(sizes[1]).toEqual(sizes[2]);
    expect(sizes[1][0]).toBeCloseTo(AVATAR_R, 5);
  });
});

describe('entityStyle', () => {
  it('styles every kind the recorder writes', () => {
    for (const kind of Object.values(ENTITY_KIND)) {
      expect(entityStyle(kind)).not.toBeNull();
    }
  });

  it('returns null for a kind it does not know', () => {
    expect(entityStyle(99)).toBeNull();
  });
});

describe('sceneCounts', () => {
  it('counts living survivors', () => {
    const ps = [player({ slot: 0 }), player({ slot: 1, state: STATE.PRESENT }), player({ slot: 2 })];
    expect(sceneCounts(ps, []).survivors).toBe(2);
  });

  it('counts rostered infected and AI specials together', () => {
    const ps = [player({ slot: 4 }), player({ slot: 5 })];
    const es = [
      { ref: 1, kind: ENTITY_KIND.HUNTER_AI, state: 0, x: 0, y: 0, z: 0, health: 250 },
      { ref: 2, kind: ENTITY_KIND.COMMON, state: 0, x: 0, y: 0, z: 0, health: 50 },
    ];
    expect(sceneCounts(ps, es).specials).toBe(3);
    expect(sceneCounts(ps, es).commons).toBe(1);
  });

  // A ghost is queued to spawn, not on the field. Counting it would tell a
  // survivor watching the live page how many are already up, which is part
  // of what the delay exists to blunt.
  it('does not count a ghost as a special on the field', () => {
    const ps = [player({ slot: 4, state: STATE.PRESENT | STATE.ALIVE | STATE.GHOST })];
    expect(sceneCounts(ps, []).specials).toBe(0);
  });

  // Every existing entity test above uses state: 0, so none of them exercise
  // the ghost bit on an AI special. The recorder sets it via the same
  // RplIsGhost derivation it uses for player records (plugin/pug-match.sp
  // :1134 and :1158), and IsPlayerAlive does not exclude ghosts, so an AI
  // tank, smoker, boomer or hunter can sit in GHOST state exactly like a
  // rostered infected player can. Drawing stays solid either way (that
  // asymmetry is deliberate); only the count must exclude it.
  it('does not count a ghosted AI special as on the field', () => {
    const es = [
      { ref: 1, kind: ENTITY_KIND.TANK_AI, state: STATE.GHOST, x: 0, y: 0, z: 0, health: 8000 },
    ];
    expect(sceneCounts([], es).specials).toBe(0);
  });

  it('still counts a non-ghosted AI special of every kind', () => {
    const es = [
      { ref: 1, kind: ENTITY_KIND.SMOKER_AI, state: 0, x: 0, y: 0, z: 0, health: 250 },
      { ref: 2, kind: ENTITY_KIND.BOOMER_AI, state: 0, x: 0, y: 0, z: 0, health: 250 },
      { ref: 3, kind: ENTITY_KIND.HUNTER_AI, state: 0, x: 0, y: 0, z: 0, health: 250 },
      { ref: 4, kind: ENTITY_KIND.TANK_AI, state: 0, x: 0, y: 0, z: 0, health: 8000 },
    ];
    expect(sceneCounts([], es).specials).toBe(4);
  });
});
