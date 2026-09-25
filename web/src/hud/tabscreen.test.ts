import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { drawTabScreen, TAB_SAMPLES, tabRows } from './tabscreen';
import { drawHud } from './mock';
import { DEFAULT_DESIGN, validateDesign, type HudDesign } from './design';
import { _setImageFactory, _resetAssetCache, panelColour, DEFAULT_PREVIEW, type PreviewState } from './render';
import { _setProbe } from './probes';

/**
 * The Tab screen painter (tab screen spec 3.2 and 3.3, tasks 13 and 14):
 * what it draws, read off the draw calls on a stub context at 1920 x 1080
 * (k = 2.25 px a unit), as the other painters' tests do. The in-game
 * shots it answers to are /home/volence/l4d/hud/probe-modern-art/runs/stock/tab/tab-a.png
 * (stock), .../runs/after/tab/tab-a.png (Modern) and the TAB-1 and TAB-4
 * shots under /home/volence/l4d/hud/probe-tab/.
 */
const K = 1080 / 480;
type Call = { m: string; a: unknown[]; fill: string; alpha: number };

function stub(): { ctx: CanvasRenderingContext2D; out: Call[] } {
  const out: Call[] = [];
  const t: Record<string | symbol, unknown> = {
    fillStyle: '', strokeStyle: '', font: '', textAlign: 'left', textBaseline: 'alphabetic', globalAlpha: 1, lineWidth: 1,
    canvas: { width: 1920, height: 1080, getContext: () => null },
    measureText: (s: string) => ({ width: s.length * 10 }),
  };
  for (const m of ['clearRect', 'fillRect', 'strokeRect', 'fillText', 'drawImage', 'putImageData', 'beginPath', 'rect', 'clip', 'arc', 'stroke',
    'fill', 'save', 'restore', 'setLineDash', 'moveTo', 'lineTo', 'closePath', 'roundRect', 'setTransform', 'translate']) t[m] = () => {};
  const ctx = new Proxy(t, {
    get: (o, k) => (typeof o[k] === 'function'
      ? (...a: unknown[]) => { out.push({ m: String(k), a, fill: String(o.fillStyle), alpha: Number(o.globalAlpha) }); return (o[k] as (...x: unknown[]) => unknown)(...a); }
      : o[k]),
    set: (o, k, v) => { o[k] = v; return true; },
  }) as unknown as CanvasRenderingContext2D;
  return { ctx, out };
}

const loaded = () => _setImageFactory((url) => ({ src: url, complete: true, naturalWidth: 128, naturalHeight: 128, onload: null, onerror: null }) as unknown as HTMLImageElement);
beforeEach(() => { _resetAssetCache(); loaded(); });
afterEach(() => { _setImageFactory(null); });

function tab(design: HudDesign, side: 'survivor' | 'infected' = 'survivor', state: PreviewState = { ...DEFAULT_PREVIEW, tab: true }) {
  const { ctx, out } = stub();
  drawTabScreen(ctx, design, side, K, { state });
  return out;
}
const texts = (out: Call[]) => out.filter((c) => c.m === 'fillText').map((c) => c.a[0] as string);
const near = (a: number, b: number) => Math.abs(a - b) < 0.01;
const rectAt = (out: Call[], x: number, y: number, w: number, h: number) =>
  out.find((c) => c.m === 'fillRect' && near(c.a[0] as number, x * K) && near(c.a[1] as number, y * K) && near(c.a[2] as number, w * K) && near(c.a[3] as number, h * K));
/** A nine-slice's top-left corner piece: drawImage(img, 0, 0, 16, 16, x, y, ...). */
const sliceAt = (out: Call[], x: number, y: number) =>
  out.find((c) => c.m === 'drawImage' && c.a.length === 9 && c.a[1] === 0 && c.a[2] === 0 && near(c.a[5] as number, x * K) && near(c.a[6] as number, y * K));
const pic = (out: Call[], material: string) => out.filter((c) => c.m === 'drawImage' && String((c.a[0] as { src?: string }).src ?? '').includes(material));

describe('the Tab screen: backdrop and title (task 13)', () => {
  it('fills the PC backdrop, 340 wide and the full height, in its file colour (BackgroundImage [$WIN32], not the 400-wide console one)', () => {
    const r = rectAt(tab(DEFAULT_DESIGN), 0, 0, 340, 480);
    expect(r?.fill).toBe(`rgba(0,0,0,${230 / 255})`);
    expect(rectAt(tab(DEFAULT_DESIGN), 0, 0, 400, 480)).toBeUndefined();
  });
  it('draws Modern\'s lighter backdrop, and a design\'s own colour', () => {
    expect(rectAt(tab(validateDesign({ v: 1, preset: 'modern' })), 0, 0, 340, 480)?.fill).toBe(`rgba(0,0,0,${200 / 255})`);
    const d = validateDesign({ v: 1, children: { tabBoard: { BackgroundImage: { keys: { bgcolor_override: '0 0 96 200' } } } } });
    expect(rectAt(tab(d), 0, 0, 340, 480)?.fill).toBe(`rgba(0,0,96,${200 / 255})`);
  });
  it('writes the sample title in the file\'s colour, and draws no console or coop piece', () => {
    const out = tab(DEFAULT_DESIGN);
    const title = out.find((c) => c.m === 'fillText' && c.a[0] === TAB_SAMPLES.title)!;
    expect(title.fill).toBe('rgba(255,255,255,1)');
    // MissionTitle at 20, 13 (north-west): the text starts at the block's left edge.
    expect(title.a[1]).toBeCloseTo(20 * K);
    const d = validateDesign({ v: 1, children: { tabBoard: { MissionTitle: { color: '255 0 0 255' } } } });
    expect(tab(d).find((c) => c.m === 'fillText' && c.a[0] === TAB_SAMPLES.title)!.fill).toBe('rgba(255,0,0,1)');
    // Medals, the chapter strip and the server panel are code's to show, not in versus.
    expect(pic(out, 'medal')).toEqual([]);
  });
});

describe('the Tab screen: the versus panel (task 13)', () => {
  it('nine-slices your team\'s box at its embedded x (15 + 20), and the stat box 320 wide at its embedded place', () => {
    const out = tab(DEFAULT_DESIGN);
    const team = sliceAt(out, 35, 25 + 43)!;
    expect(team).toBeDefined();
    expect(String((team.a[0] as { src: string }).src)).toContain('outlinered');
    expect(sliceAt(out, 15, 25 + 70)).toBeDefined();
    // The stat box's right-hand corner: 320 wide less its 8-unit corner.
    expect(out.some((c) => c.m === 'drawImage' && c.a.length === 9 && near(c.a[5] as number, (15 + 320 - 8) * K) && near(c.a[6] as number, 95 * K))).toBe(true);
  });
  it('draws no enemy box on the survivor side (code shows one team\'s box), and the enemy\'s in its place on the infected side', () => {
    expect(sliceAt(tab(DEFAULT_DESIGN), 15 + 160, 68)).toBeUndefined();
    const inf = tab(DEFAULT_DESIGN, 'infected');
    expect(sliceAt(inf, 15 + 160, 68)).toBeDefined();
    expect(sliceAt(inf, 35, 68)).toBeUndefined();
  });
  it('writes the sample texts, and leaves out what code hides in the first half and the embedded panel\'s title and frame', () => {
    const t = texts(tab(DEFAULT_DESIGN));
    for (const s of ['Your Team', 'Enemy Team', '262', 'N/A', 'Average Distance:', '1%', 'Health Bonus:', '200']) expect(t, s).toContain(s);
    for (const s of ['Survival Multiplier:', 'You will play Survivors first in the next chapter.', 'Versus Mode', '#L4D_VSScoreboard_Title']) expect(t, s).not.toContain(s);
    expect(sliceAt(tab(DEFAULT_DESIGN), 15, 25)).toBeUndefined();
  });
  it('colours the scores grey whatever the file says (TS2 failed), and the labels by the file', () => {
    const d = validateDesign({ v: 1, children: { tabVersus: { TeamYours: { color: '255 255 0 255' }, DistanceAmount: { color: '255 0 255 255' } } } });
    const out = tab(d);
    const last = (s: string) => out.filter((c) => c.m === 'fillText' && c.a[0] === s).pop()!;
    expect(last('262').fill).toBe('rgba(145,145,145,1)');
    expect(last('Your Team').fill).toBe('rgba(255,255,0,1)');
    expect(last('1%').fill).toBe('rgba(255,0,255,1)');
    expect(last('Health Bonus:').fill).toBe('rgba(255,255,255,1)');
  });
  it('places the stat line by its pin chain: "1%" 10 units after "Average Distance:" ends', () => {
    const out = tab(DEFAULT_DESIGN);
    const x = (s: string) => out.find((c) => c.m === 'fillText' && c.a[0] === s)!.a[1] as number;
    // The stub measures 10 px a character: the label is 170 px, 170 / K units, wide.
    expect(x('Average Distance:')).toBeCloseTo((15 + 13) * K);
    expect(x('1%')).toBeCloseTo((15 + 13) * K + 170 + 10 * K);
  });
  it('moves the whole panel with the element (TS4) and draws neither hidden label nor the number pinned to one (TS7)', () => {
    const d = validateDesign({ v: 1, elements: { tabVersus: { x: 420, y: 20 } },
      children: { tabVersus: { TeamEnemy: { visible: false }, HealthLabel: { visible: false } } } });
    const out = tab(d);
    expect(sliceAt(out, 420, 20 + 70)).toBeDefined();
    const t = texts(out);
    expect(t).not.toContain('Enemy Team');
    expect(t).not.toContain('Health Bonus:');
    expect(t).not.toContain('200');
    expect(t).toContain('N/A');
  });
  it('draws the versus panel not at all once it is hidden, and dimmed while it is picked', () => {
    const d = validateDesign({ v: 1, elements: { tabVersus: { visible: false } } });
    expect(texts(tab(d))).not.toContain('Your Team');
    const { ctx, out } = stub();
    drawTabScreen(ctx, d, 'survivor', K, { state: { ...DEFAULT_PREVIEW, tab: true }, picked: ['tabVersus'] });
    expect(out.find((c) => c.m === 'fillText' && c.a[0] === 'Your Team')?.alpha).toBeCloseTo(0.25);
  });
  it('draws a box\'s style as a flat fill in its colour (tabStatBox, tabTeamBox), and Modern\'s flat panels as theirs', () => {
    const d = validateDesign({ v: 1, styles: { tabStatBox: { kind: 'flat', color: '0 255 0 255' }, tabTeamBox: { kind: 'flat', color: '255 0 255 255' } } });
    const out = tab(d);
    expect(rectAt(out, 15, 95, 320, 45)?.fill).toBe('rgba(0,255,0,1)');
    expect(rectAt(out, 35, 68, 125, 32)?.fill).toBe('rgba(255,0,255,1)');
    const m = tab(validateDesign({ v: 1, preset: 'modern' }));
    expect(rectAt(m, 35, 25 + 46, 125, 28)?.fill).toBe(`rgba(95,22,22,${205 / 255})`);
    expect(rectAt(m, 15, 95, 320, 45)?.fill).toBe(`rgba(0,0,0,${140 / 255})`);
  });
});

describe('the Tab screen: the rows (task 14)', () => {
  it('lists you first, then three bots, on the survivor side; four bots and your infected row on the infected side', () => {
    expect(tabRows('survivor').survivors.map((r) => [r.name, r.self])).toEqual([['Player', true], ['Francis', false], ['Louis', false], ['Zoey', false]]);
    expect(tabRows('survivor').infected).toEqual([]);
    expect(tabRows('infected').survivors.every((r) => !r.self)).toBe(true);
    expect(tabRows('infected').infected.map((r) => [r.name, r.self])).toEqual([['Player', true]]);
  });
  it('draws row 1 with your row colour and your name beside the avatar, rows 2 to 4 with the bot name and no ping', () => {
    const out = tab(DEFAULT_DESIGN);
    // Survivor1 at 20, c-95 (145); the row background at 0, 22 inside it, 300 x 28.
    expect(rectAt(out, 20, 167, 300, 28)?.fill).toBe('rgba(140,0,0,1)');
    const name = (s: string) => out.find((c) => c.m === 'fillText' && c.a[0] === s)!;
    expect(name('Player').a[1]).toBeCloseTo((20 + 50) * K);                      // SurvivorStatsName x 50
    expect(name('Francis').a[1]).toBeCloseTo((20 + 30) * K);                     // SurvivorStatsNoAvatarName x 30
    expect(name('Louis').a[2]).toBeGreaterThan(name('Francis').a[2] as number);
    for (const s of ['Player', 'Francis', 'Louis', 'Zoey']) expect(name(s).fill, s).toBe('rgba(255,255,255,1)');
    expect(texts(out).filter((s) => s === TAB_SAMPLES.ping)).toHaveLength(1);
    // The teammate rows' fade, stretched over each bot row only.
    const fades = pic(out, 'background_survivor');
    expect(fades.map((c) => Math.round((c.a[2] as number) / K))).toEqual([197, 227, 257]);
  });
  it('draws the portraits and bars on every row, the bars in the file\'s grey (TS3)', () => {
    const out = tab(DEFAULT_DESIGN);
    expect(pic(out, 's_panel_').length).toBe(4);
    expect(pic(out, 's_healthbar_outline').length).toBe(4);
    expect(panelColour(DEFAULT_DESIGN, 'tabSurvivors')).toEqual([192, 192, 192]);
    const red = validateDesign({ v: 1, children: { tabSurvivors: { SurvivorStatsHealth: { keys: { monochrome_color: '255 0 0 255' } } } } });
    expect(panelColour(red, 'tabSurvivors')).toEqual([255, 0, 0]);
    const byHealth = validateDesign({ v: 1, children: { tabSurvivors: { SurvivorStatsHealth: { keys: { monochrome_color: '' } } } } });
    expect(panelColour(byHealth, 'tabSurvivors')).toBeUndefined();
    _setProbe('TS3', false);
    try { expect(panelColour(red, 'tabSurvivors')).toBeUndefined(); } finally { _setProbe('TS3', null); }
  });
  it('draws the ping glyph on your row, and not once it is hidden (TS7)', () => {
    const glyph = (out: Call[]) => out.filter((c) => c.m === 'fillRect' && c.fill === TAB_SAMPLES.pingBar);
    expect(glyph(tab(DEFAULT_DESIGN))).toHaveLength(3);
    expect(glyph(tab(validateDesign({ v: 1, children: { tabSurvivors: { PingImage: { visible: false } } } })))).toEqual([]);
  });
  it('draws the teammate rows\' style and your row\'s colour from the design', () => {
    const d = validateDesign({ v: 1, styles: { tabRowBg: { kind: 'flat', color: '128 0 255 255' } },
      children: { tabSurvivors: { PlayerBackground_Selected: { keys: { bgcolor_override: '0 128 0 255' } } } } });
    const out = tab(d);
    expect(rectAt(out, 20, 167, 300, 28)?.fill).toBe('rgba(0,128,0,1)');
    expect(rectAt(out, 20, 197, 300, 28)?.fill).toBe('rgba(128,0,255,1)');
  });
  it('draws your infected row on the infected side (c33 + 15), in its colour with its name in the file\'s colour (TS5, TS6)', () => {
    const d = validateDesign({ v: 1, children: { tabInfected: { PlayerBackground_Selected: { keys: { bgcolor_override: '255 255 0 255' } }, Name: { color: '0 255 255 255' } } } });
    const out = tab(d, 'infected');
    expect(rectAt(out, 20, 288, 300, 19)?.fill).toBe('rgba(255,255,0,1)');
    const names = out.filter((c) => c.m === 'fillText' && c.a[0] === 'Player');
    expect(names).toHaveLength(1);
    expect(names[0].fill).toBe('rgba(0,255,255,1)');
    expect(names[0].a[1]).toBeCloseTo((20 + 20) * K);
    // No survivor row is yours on the infected side, and none is drawn in your row colour.
    expect(rectAt(out, 20, 167, 300, 28)).toBeUndefined();
    expect(texts(out)).toContain('HUNTER');
    expect(texts(tab(d, 'infected', { ...DEFAULT_PREVIEW, tab: true, infected: 'ghost' }))).toContain('SPAWNING');
    expect(rectAt(tab(d), 20, 288, 300, 19)).toBeUndefined();
  });
});

describe('drawHud with the Tab screen (tasks 13 and 15)', () => {
  function hud(design: HudDesign, state: PreviewState, selected: string | null = null) {
    const { ctx, out } = stub();
    drawHud(ctx, 1920, 1080, design, 'survivor', selected, undefined, { state });
    return texts(out);
  }
  it('draws the Tab screen only while Tab is held, or while a Tab element or piece is picked', () => {
    expect(hud(DEFAULT_DESIGN, DEFAULT_PREVIEW)).not.toContain(TAB_SAMPLES.title);
    expect(hud(DEFAULT_DESIGN, { ...DEFAULT_PREVIEW, tab: true })).toContain(TAB_SAMPLES.title);
    expect(hud(DEFAULT_DESIGN, DEFAULT_PREVIEW, 'tabVersus')).toContain(TAB_SAMPLES.title);
  });
  it('takes the teammate cards off while Tab is held (underTab), and keeps your own health', () => {
    // A teammate card writes its sample name, and so does the Tab row of the same survivor.
    const francis = (t: string[]) => t.filter((s) => s === 'Francis').length;
    expect(francis(hud(DEFAULT_DESIGN, DEFAULT_PREVIEW))).toBe(1);
    expect(francis(hud(DEFAULT_DESIGN, { ...DEFAULT_PREVIEW, tab: true }))).toBe(1);
    expect(hud(DEFAULT_DESIGN, { ...DEFAULT_PREVIEW, tab: true })).toContain('100');
    // Picking a Tab piece with Tab not held draws the screen over the whole HUD, cards and all.
    expect(francis(hud(DEFAULT_DESIGN, DEFAULT_PREVIEW, 'tabBoard'))).toBe(2);
  });
});
