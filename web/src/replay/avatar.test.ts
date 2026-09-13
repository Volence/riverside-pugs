import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  AVATAR_BASE_R, ARC_GAP, DISC_COLOR, STATE_RING_GAP, FOLLOW_RING_GAP, drawMedallion, type MedallionSpec,
} from './avatar';
import { resetPictogramCache } from './pictograms';
import { TEMP_HEALTH_COLOR } from './hud';

class FakePath2D { constructor(public d: string) {} }

/** Records every context call with the paint state at the time. `fill` and
 *  `stroke` are recorded with the Path2D argument when one was passed, so a
 *  test can tell a pictogram fill from a disc fill. */
function stubCtx() {
  const calls: { fn: string; args: unknown[]; fill: string; stroke: string; width: number; alpha: number }[] = [];
  let fillStyle = ''; let strokeStyle = ''; let lineWidth = 0; let globalAlpha = 1;
  const rec = (fn: string) => (...args: unknown[]) => {
    calls.push({ fn, args, fill: fillStyle, stroke: strokeStyle, width: lineWidth, alpha: globalAlpha });
  };
  const ctx = {
    save: rec('save'), restore: rec('restore'), beginPath: rec('beginPath'), closePath: rec('closePath'),
    arc: rec('arc'), moveTo: rec('moveTo'), lineTo: rec('lineTo'), fill: rec('fill'), stroke: rec('stroke'),
    clip: rec('clip'), drawImage: rec('drawImage'), fillText: rec('fillText'), strokeText: rec('strokeText'),
    translate: rec('translate'), scale: rec('scale'), rotate: rec('rotate'),
    set fillStyle(v: string) { fillStyle = v; }, set strokeStyle(v: string) { strokeStyle = v; },
    set lineWidth(v: number) { lineWidth = v; }, set globalAlpha(v: number) { globalAlpha = v; },
    set font(_v: string) {}, set textAlign(_v: string) {}, set textBaseline(_v: string) {},
    set filter(_v: string) {}, set lineCap(_v: string) {},
  } as unknown as CanvasRenderingContext2D;
  return { calls, ctx };
}

const face = { width: 64, height: 64 } as HTMLImageElement;
const base: MedallionSpec = { x: 100, y: 50, r: AVATAR_BASE_R, rim: '#57a7f1' };

describe('drawMedallion', () => {
  beforeEach(() => { (globalThis as any).Path2D = FakePath2D; resetPictogramCache(); });
  afterEach(() => { delete (globalThis as any).Path2D; resetPictogramCache(); });

  it('clips the portrait into the disc and strokes the rim in the slot colour', () => {
    const { calls, ctx } = stubCtx();
    drawMedallion(ctx, { ...base, face });
    const clip = calls.findIndex((c) => c.fn === 'clip');
    const img = calls.findIndex((c) => c.fn === 'drawImage');
    expect(clip).toBeGreaterThan(-1);
    expect(img).toBeGreaterThan(clip);
    // Drawn to the disc's bounding square: x - r, y - r, 2r, 2r.
    expect(calls[img].args.slice(1)).toEqual([100 - 11, 50 - 11, 22, 22]);
    const rim = calls.filter((c) => c.fn === 'stroke' && c.stroke === '#57a7f1');
    expect(rim.length).toBeGreaterThan(0);
  });

  it('fills the pictogram over a dark disc when there is no face', () => {
    const { calls, ctx } = stubCtx();
    drawMedallion(ctx, { ...base, rim: '#cc4760', pictogram: 'hunter' });
    expect(calls.some((c) => c.fn === 'fill' && c.fill === DISC_COLOR)).toBe(true);
    const pict = calls.find((c) => c.fn === 'fill' && c.args[0] instanceof FakePath2D);
    expect(pict).toBeTruthy();
    expect(pict!.fill).toBe('#ffffff');
    expect(calls.some((c) => c.fn === 'drawImage')).toBe(false);
  });

  it('draws the state ring under the rim at r + gap, and the arc outside at r + arc gap', () => {
    const { calls, ctx } = stubCtx();
    drawMedallion(ctx, { ...base, ring: '#a85cf0', arc: { perm: 0.5, temp: 0.25, color: '#45b39c' } });
    const arcs = calls.filter((c) => c.fn === 'arc');
    const ring = arcs.find((c) => c.args[2] === AVATAR_BASE_R + STATE_RING_GAP);
    expect(ring).toBeTruthy();
    const ringStroke = calls[calls.indexOf(ring!) + 1];
    expect(ringStroke.fn).toBe('stroke');
    expect(ringStroke.stroke).toBe('#a85cf0');
    const health = arcs.filter((c) => c.args[2] === AVATAR_BASE_R + ARC_GAP);
    // Permanent then temporary: two arcs at the arc radius.
    expect(health).toHaveLength(2);
    const [perm, temp] = health;
    expect(perm.args[3]).toBeCloseTo(-Math.PI / 2);
    expect(perm.args[4]).toBeCloseTo(-Math.PI / 2 + Math.PI);
    expect(temp.args[4]).toBeCloseTo(-Math.PI / 2 + Math.PI * 1.5);
    expect(calls[calls.indexOf(temp) + 1].stroke).toBe(TEMP_HEALTH_COLOR);
  });

  it('draws the badge digit and the facing wedge for a living player', () => {
    const { calls, ctx } = stubCtx();
    drawMedallion(ctx, { ...base, badge: { text: '3', ink: '#0b0908' }, yaw: 90 });
    const digit = calls.find((c) => c.fn === 'fillText');
    expect(digit?.args[0]).toBe('3');
    expect(digit?.fill).toBe('#0b0908');
    // yaw 90 is straight up on screen (canvas y grows down), so the wedge's
    // apex sits above the centre.
    const wedge = calls.filter((c) => c.fn === 'lineTo');
    expect(wedge.length).toBeGreaterThanOrEqual(2);
    const apexY = Math.min(...calls.filter((c) => c.fn === 'moveTo' || c.fn === 'lineTo').map((c) => c.args[1] as number));
    expect(apexY).toBeLessThan(50 - AVATAR_BASE_R);
  });

  it('a hollow ghost is one stroked arc in the rim colour and nothing else', () => {
    const { calls, ctx } = stubCtx();
    drawMedallion(ctx, {
      ...base, rim: '#9c5f5a', hollow: true, alpha: 0.35,
      face, pictogram: 'hunter', badge: { text: '1', ink: '#fff' }, yaw: 0,
      ring: '#a85cf0', arc: { perm: 1, temp: 0, color: '#45b39c' }, follow: true,
    });
    expect(calls.filter((c) => c.fn === 'arc')).toHaveLength(1);
    expect(calls.filter((c) => c.fn === 'stroke')).toHaveLength(1);
    expect(calls.find((c) => c.fn === 'stroke')!.stroke).toBe('#9c5f5a');
    expect(calls.find((c) => c.fn === 'stroke')!.alpha).toBe(0.35);
    for (const fn of ['fill', 'drawImage', 'fillText', 'lineTo', 'clip']) {
      expect(calls.filter((c) => c.fn === fn)).toHaveLength(0);
    }
  });

  it('a dead player gets a dagger and keeps face and rim, with no badge, wedge or arc', () => {
    const { calls, ctx } = stubCtx();
    drawMedallion(ctx, {
      ...base, rim: '#6d675e', dead: true, face,
      badge: { text: '2', ink: '#fff' }, yaw: 45, arc: { perm: 1, temp: 0, color: '#45b39c' },
    });
    expect(calls.some((c) => c.fn === 'drawImage')).toBe(true);
    const texts = calls.filter((c) => c.fn === 'fillText').map((c) => c.args[0]);
    expect(texts).toEqual(['†']);
    expect(calls.filter((c) => c.fn === 'arc' && c.args[2] === AVATAR_BASE_R + ARC_GAP)).toHaveLength(0);
    expect(calls.filter((c) => c.fn === 'lineTo')).toHaveLength(0);
  });

  it('draws the follow ring outside everything, white over a dark halo', () => {
    const { calls, ctx } = stubCtx();
    drawMedallion(ctx, { ...base, follow: true });
    const strokes = calls.filter((c) => c.fn === 'stroke');
    const last = strokes[strokes.length - 1];
    const halo = strokes[strokes.length - 2];
    expect(last.stroke).toBe('#ffffff');
    expect(halo.stroke).toBe('rgba(0,0,0,0.85)');
    expect(halo.width).toBeGreaterThan(last.width);
  });
});

describe('layout', () => {
  beforeEach(() => { (globalThis as any).Path2D = FakePath2D; resetPictogramCache(); });
  afterEach(() => { delete (globalThis as any).Path2D; resetPictogramCache(); });

  it('keeps the rim, state ring, arc and follow halo pairwise clear of each other', () => {
    const { calls, ctx } = stubCtx();
    drawMedallion(ctx, {
      ...base,
      ring: '#a85cf0',
      arc: { perm: 0.6, temp: 0.1, color: '#45b39c' },
      follow: true,
    });

    // Several strokes can share one radius (the rim's dark edge and colour
    // passes, the arc's permanent and temporary passes, the follow ring's
    // halo and white passes). The widest of them at a given radius is the
    // one that actually determines the visible band; a narrower pass at the
    // same radius sits inside its own halo pass, which is expected and not
    // itself a collision. Each pass's true width is read from the `stroke`
    // call immediately following its `arc` call, never from an imported
    // constant, since that stroke is what the stub records the live
    // `lineWidth` against.
    const widestBandAt = (radius: number): { inner: number; outer: number } => {
      const hits = calls
        .map((c, i) => ({ c, i }))
        .filter(({ c }) => c.fn === 'arc' && Math.abs((c.args[2] as number) - radius) < 1e-6);
      expect(hits.length).toBeGreaterThan(0);
      let widest = 0;
      for (const { i } of hits) {
        const stroke = calls[i + 1];
        expect(stroke.fn).toBe('stroke');
        widest = Math.max(widest, stroke.width);
      }
      return { inner: radius - widest / 2, outer: radius + widest / 2 };
    };

    const rim = widestBandAt(AVATAR_BASE_R);
    const ring = widestBandAt(AVATAR_BASE_R + STATE_RING_GAP);
    const arc = widestBandAt(AVATAR_BASE_R + ARC_GAP);
    const follow = widestBandAt(AVATAR_BASE_R + FOLLOW_RING_GAP);

    // Pairwise non-overlapping, in the order they nest outward from the
    // disc: touching at a shared edge is fine (that is exactly what "flush"
    // means), overlapping into each other's band is not.
    const bands = [rim, ring, arc, follow];
    for (let a = 0; a < bands.length; a++) {
      for (let b = a + 1; b < bands.length; b++) {
        expect(bands[a].outer).toBeLessThanOrEqual(bands[b].inner);
      }
    }
    // The geometry the controller ruling fixed: the state ring used to be
    // overdrawn by the rim edge down to 0.75px of visible colour. It must
    // now start at or beyond the rim halo's own outer edge.
    expect(ring.inner).toBeGreaterThanOrEqual(rim.outer);
  });
});
