import { describe, it, expect } from 'vitest';
import {
  avatarRadius, medianHeight, isSurvivor, entityStyle, drawScene, sceneCounts,
  slotColor, statusGlyph,
} from './draw';
import { STATE, ENTITY_KIND, type PlayerSample } from '../../../src/replayFormat';
import { fitView, projectView, type MapTransform } from '../../../src/mapTransform';

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
    const calls: { fn: string; args: number[] }[] = [];
    const texts: { fn: string; text: string }[] = [];
    const rec = (fn: string) => (...args: unknown[]) => {
      calls.push({ fn, args: args.filter((a) => typeof a === 'number') as number[] });
    };
    // fillText/strokeText carry the label or glyph string as their first
    // argument, which the numeric-only `rec` above would silently drop, so
    // the name-resolution tests below need their own recorder that keeps it.
    const recText = (fn: string) => (text: string) => {
      texts.push({ fn, text });
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
        set fillStyle(_v: string) {}, set strokeStyle(_v: string) {},
        set lineWidth(_v: number) {}, set globalAlpha(_v: number) {},
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

  const identityScene = () => {
    const transform: MapTransform = {
      originX: 0, originY: 0, unitsPerPixel: 1, image: null, width: 1280, height: 794,
    };
    return { transform, view: fitView({ x0: 0, y0: 0, x1: 1280, y1: 794 }, 1280, 794, 0) };
  };

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

  it('keeps a ghost hollow: no health ring, glyph, label or follow highlight', () => {
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
    // Stroked before filled, so the outline sits under the fill rather than
    // over it.
    expect(known.texts).toEqual([
      { fn: 'strokeText', text: 'Zoey' },
      { fn: 'fillText', text: 'Zoey' },
    ]);

    // No roster entry for this slot: draw nothing, never the seventeen-digit
    // SteamID64 itself.
    const unknown = stubCtx();
    drawScene(unknown.ctx, {
      transform, view, backdrop: null, trail: [],
      players: [player({ slot: 0 })],
      entities: [],
      show: { ci: true, entities: true, names: true },
      width: 1280, height: 794,
      names: {}, slots, followSlot: null,
    });
    expect(unknown.texts).toHaveLength(0);
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
