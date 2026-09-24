import { describe, it, expect, beforeEach } from 'vitest';
import { elementById } from './elements';
import { buildHud, elementRect } from './build';
import { validateDesign, type HudDesign } from './design';
import { parseKv, kvFind, kvGet, type KvNode } from './kv';
import { drawHud, hitTest, shownInState } from './mock';
import { placeElement } from './edit';
import { _setImageFactory, _resetAssetCache, DEFAULT_PREVIEW, type PreviewState } from './render';
import { parsePos, SCREEN_H, screenW } from './units';

/**
 * The minor elements (plan tasks M1, M2). Probe answers,
 * /home/volence/l4d/hud/probe-phase2-rest/RESULTS.md:
 * - V2: HudVoiceSelfStatus moves and sizes (r1/shots/crops/voice-g.png, 48x48 at c-24, 60).
 * - VO: CHudVote moves, VoteActive's bgcolor_override is honoured (r4/shots/r4/r4-e.png).
 * - H1: HudHoldoutTimer moves, in survival (r2/shots/r2/r2-g.png).
 */
type D = ReturnType<typeof validateDesign>;
const read = (d: D, path: string) => {
  const f = buildHud(d).find((x) => x.path === path);
  return f ? parseKv(new TextDecoder('latin1').decode(f.data))[0].value as KvNode[] : undefined;
};
const layout = (d: D, key: string) => kvFind(read(d, 'scripts/hudlayout.res')!, [key])!;
const OCCASIONAL: PreviewState = { ...DEFAULT_PREVIEW, occasional: true };

type Call = { m: string; a: unknown[]; fill: string; alpha: number };
function calls(design: HudDesign, side: 'survivor' | 'infected', state: PreviewState = OCCASIONAL, selected: string | null = null) {
  _setImageFactory((url) => ({ src: url, complete: true, naturalWidth: 64, naturalHeight: 64, onload: null, onerror: null }) as unknown as HTMLImageElement);
  const out: Call[] = [];
  const t: Record<string | symbol, unknown> = {
    fillStyle: '', strokeStyle: '', font: '', textAlign: 'left', textBaseline: 'alphabetic', globalAlpha: 1, lineWidth: 1,
    canvas: { width: 1920, height: 1080, getContext: () => null },
    measureText: (s: string) => ({ width: s.length * 10 }),
  };
  for (const m of ['clearRect', 'fillRect', 'strokeRect', 'fillText', 'drawImage', 'putImageData', 'beginPath', 'rect', 'clip', 'arc', 'stroke',
    'fill', 'save', 'restore', 'setLineDash', 'moveTo', 'lineTo', 'closePath', 'roundRect', 'ellipse', 'quadraticCurveTo']) t[m] = () => {};
  const ctx = new Proxy(t, {
    get: (o, k) => (typeof o[k] === 'function'
      ? (...a: unknown[]) => { out.push({ m: String(k), a, fill: String(o.fillStyle), alpha: o.globalAlpha as number }); return (o[k] as (...x: unknown[]) => unknown)(...a); }
      : o[k]),
    set: (o, k, v) => { o[k] = v; return true; },
  }) as unknown as CanvasRenderingContext2D;
  drawHud(ctx, 1920, 1080, design, side, selected, undefined, { state });
  _setImageFactory(null);
  return out;
}
const text = (c: Call[], s: string) => c.find((x) => x.m === 'fillText' && x.a[0] === s);
const K = 2.25;

describe('occasional panels: drawn and picked only when the page asks', () => {
  beforeEach(() => { _resetAssetCache(); });

  it('marks the mic, the vote and the survival timer occasional, each with a note saying when the game shows it', () => {
    for (const id of ['ownMic', 'vote', 'holdoutTimer']) {
      const el = elementById(id)!;
      expect(el.occasional, id).toBe(true);
      expect(el.note, id).toBeTruthy();
    }
    expect(elementById('holdoutTimer')!.note).toMatch(/Survival/);
  });

  it('shows an occasional element only with the toggle on', () => {
    const el = elementById('vote')!;
    expect(shownInState(el, DEFAULT_PREVIEW)).toBe(false);
    expect(shownInState(el, OCCASIONAL)).toBe(true);
    expect(shownInState(elementById('chat')!, DEFAULT_PREVIEW)).toBe(true);
  });

  it('picks the vote only with the toggle on', () => {
    const d = validateDesign({ v: 1 });
    const r = elementRect(d, 'vote', d.aspect);
    expect(hitTest(d, 'survivor', r.x + r.w / 2, r.y + 20, DEFAULT_PREVIEW)).not.toBe('vote');
    expect(hitTest(d, 'survivor', r.x + r.w / 2, r.y + 20, OCCASIONAL)).toBe('vote');
  });

  it('draws a picked occasional element even with the toggle off, so Layers can show it', () => {
    const d = validateDesign({ v: 1 });
    expect(text(calls(d, 'survivor', DEFAULT_PREVIEW), 'VOTE:')).toBeUndefined();
    expect(text(calls(d, 'survivor', DEFAULT_PREVIEW, 'vote'), 'VOTE:')).toBeDefined();
    expect(text(calls(d, 'survivor', OCCASIONAL), 'VOTE:')).toBeDefined();
  });
});

describe('your microphone (plan task M1)', () => {
  beforeEach(() => { _resetAssetCache(); });

  it('is HudVoiceSelfStatus on both sides, moved and sized freely', () => {
    expect(elementById('ownMic')).toMatchObject({ key: 'HudVoiceSelfStatus', side: 'both', move: true, resize: 'free' });
  });

  it('writes a move and a size into HudVoiceSelfStatus (V2: 48x48 at c-24, 60)', () => {
    const W = screenW('16:9');
    const d = validateDesign({ v: 1, elements: { ownMic: { x: W / 2 - 24, y: 60, w: 48, h: 48 } } });
    const n = layout(d, 'HudVoiceSelfStatus');
    expect(parsePos(kvGet(n, 'xpos')!, W)).toBeCloseTo(W / 2 - 24, 0);
    expect(parsePos(kvGet(n, 'ypos')!, SCREEN_H)).toBe(60);
    expect([kvGet(n, 'wide'), kvGet(n, 'tall')]).toEqual(['48', '48']);
  });

  it('hard-hides it', () => {
    const n = layout(validateDesign({ v: 1, elements: { ownMic: { visible: false } } }), 'HudVoiceSelfStatus');
    expect(['visible', 'wide', 'tall'].map((k) => kvGet(n, k))).toEqual(['0', '0', '0']);
  });

  it('draws a microphone inside its box', () => {
    const d = validateDesign({ v: 1 });
    const r = elementRect(d, 'ownMic', d.aspect);
    expect(r).toMatchObject({ w: 24, h: 24 });
    const drawn = calls(d, 'survivor').filter((x) => x.m === 'fill' || x.m === 'fillRect' || x.m === 'stroke');
    expect(drawn.length).toBeGreaterThan(0);
  });
});

describe('the vote panel (plan task M1)', () => {
  beforeEach(() => { _resetAssetCache(); });

  it('is CHudVote on both sides, moved, sized as its VoteActive box', () => {
    expect(elementById('vote')).toMatchObject({ key: 'CHudVote', side: 'both', move: true, resize: 'none' });
    const d = validateDesign({ v: 1 });
    expect(elementRect(d, 'vote', d.aspect)).toMatchObject({ w: 200, h: 140 });
  });

  it('writes a move into CHudVote (VO: c-100, 60)', () => {
    const W = screenW('16:9');
    const d = validateDesign({ v: 1, elements: { vote: { x: W / 2 - 100, y: 60 } } });
    const n = layout(d, 'CHudVote');
    expect(parsePos(kvGet(n, 'xpos')!, W)).toBeCloseTo(W / 2 - 100, 0);
    expect(parsePos(kvGet(n, 'ypos')!, SCREEN_H)).toBe(60);
  });

  it('writes its background colour on votehud.res VoteActive, and ships no votehud.res without one', () => {
    expect(read(validateDesign({ v: 1 }), 'resource/ui/hud/votehud.res')).toBeUndefined();
    const t = read(validateDesign({ v: 1, elements: { vote: { bg: '128 0 128 240' } } }), 'resource/ui/hud/votehud.res')!;
    expect(kvGet(kvFind(t, ['VoteActive'])!, 'bgcolor_override')).toBe('128 0 128 240');
    // Only the active box: the passed and failed boxes were never seen recoloured.
    expect(kvGet(kvFind(t, ['VotePassed'])!, 'bgcolor_override')).toBe('0 0 0 240');
  });

  it('draws the box in its colour, at the element, with the header and the question (r4-e)', () => {
    const W = screenW('16:9');
    const d = validateDesign({ v: 1, elements: { vote: { x: W / 2 - 100, y: 60, bg: '128 0 128 240' } } });
    const all = calls(d, 'survivor');
    const box = all.find((x) => x.m === 'roundRect' && Math.abs((x.a[2] as number) - 450) < 2)!.a as number[];
    // r4-e: the box at x 735 to 1185, y 135 to 450 px.
    for (const [got, want] of [[box[0], 734.6], [box[1], 135], [box[2], 450], [box[3], 315]]) expect(Math.abs(got - want)).toBeLessThanOrEqual(1.5);
    expect(all.some((x) => x.m === 'fill' && x.fill === `rgba(128,0,128,${240 / 255})`)).toBe(true);
    expect(text(all, 'VOTE:')).toBeDefined();
    expect(text(all, 'Change difficulty to Normal?')).toBeDefined();
    expect(text(all, 'Press F1 to vote YES')).toBeDefined();
  });

  it('hard-hides it', () => {
    const n = layout(validateDesign({ v: 1, elements: { vote: { visible: false } } }), 'CHudVote');
    expect(['visible', 'wide', 'tall'].map((k) => kvGet(n, k))).toEqual(['0', '0', '0']);
  });
});

describe('the survival timer (plan task M1)', () => {
  beforeEach(() => { _resetAssetCache(); });

  it('is HudHoldoutTimer, survivor only, moved', () => {
    expect(elementById('holdoutTimer')).toMatchObject({ key: 'HudHoldoutTimer', side: 'survivor', move: true, resize: 'none' });
  });

  it('writes a move (H1: c-220, 150) and draws its two times there (r2-g)', () => {
    const W = screenW('16:9');
    const d = validateDesign({ v: 1, elements: { holdoutTimer: { x: W / 2 - 220, y: 150 } } });
    const n = layout(d, 'HudHoldoutTimer');
    expect(parsePos(kvGet(n, 'ypos')!, SCREEN_H)).toBe(150);
    const r = elementRect(d, 'holdoutTimer', d.aspect);
    const all = calls(d, 'survivor');
    const now = text(all, '00:00.50')!;
    expect(now).toBeDefined();
    expect(text(all, '04:00.00')).toBeDefined();
    // CurrentTimeDigits sits 25 units into the panel.
    expect(Math.abs((now.a[1] as number) - (r.x + 25) * K)).toBeLessThanOrEqual(1);
  });

  it('is not on the infected side', () => {
    const d = validateDesign({ v: 1 });
    expect(text(calls(d, 'infected'), '00:00.50')).toBeUndefined();
  });

  it('hard-hides it', () => {
    const n = layout(validateDesign({ v: 1, elements: { holdoutTimer: { visible: false } } }), 'HudHoldoutTimer');
    expect(['visible', 'wide', 'tall'].map((k) => kvGet(n, k))).toEqual(['0', '0', '0']);
  });
});

describe('placing an occasional element', () => {
  it('moves the vote like any element', () => {
    const d = placeElement(validateDesign({ v: 1 }), 'vote', 300, 60);
    // Stored through the build's own token arithmetic: within the half unit a centre token reads back at.
    expect(Math.abs(d.elements.vote.x! - 300)).toBeLessThanOrEqual(1);
    expect(d.elements.vote.y).toBe(60);
  });
});
