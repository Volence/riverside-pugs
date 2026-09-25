import { describe, it, expect, afterEach, vi } from 'vitest';
import { prepareHudShare, renderPreview, renderPreviews, buildHudForm, PREVIEW_SIZE } from './publish';
import * as mock from '../hud/mock';
import { DEFAULT_PREVIEW } from '../hud/render';
import { resetGameBackdrops } from '../crosshair/draw';
import { registerImport, unregisterImport, hasImport } from '../hud/base';
import * as importCheck from '../hud/importCheck';
import { validateDesign, type HudDesign } from '../hud/design';
import { sampleHud, latin1 } from '../hud/importFixtures';
import { encodeVPK } from '../vpk';
import { readVPK } from '../vpk/read';
import { hudId, shareableHudFiles, HUD_CAPS } from '../../../src/hudFiles';

const used = new Set<string>();
afterEach(() => {
  for (const id of used) unregisterImport(id);
  used.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  resetGameBackdrops();
  FakeImage.made = [];
});

/** An Image that loads (or fails) only when the test says so. */
class FakeImage {
  static made: FakeImage[] = [];
  static auto: 'load' | 'error' | null = 'load';
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  naturalWidth = 1920;
  naturalHeight = 1080;
  private s = '';
  constructor() { FakeImage.made.push(this); }
  get src() { return this.s; }
  set src(v: string) {
    this.s = v;
    const how = FakeImage.auto;
    if (how) setTimeout(() => (how === 'load' ? this.onload?.() : this.onerror?.()), 0);
  }
}

const modern = (): HudDesign => validateDesign({ v: 1, name: 'mine', preset: 'modern' });
async function onImport(files: Map<string, Uint8Array>): Promise<HudDesign> {
  const id = await hudId(files);
  used.add(id);
  registerImport(id, files);
  return validateDesign({ v: 1, name: 'mine', preset: 'imported', imported: { id, name: 'edgehud' } });
}

describe('prepareHudShare', () => {
  it('passes a Modern design through with no import', async () => {
    const d = modern();
    expect(await prepareHudShare(d)).toEqual({ design: d, importFiles: null, left: [] });
  });

  it('leaves out what the allowlist refuses, and moves the design onto the kept set', async () => {
    const files = sampleHud({ 'cfg/autoexec.cfg': 'bind x quit\n' });
    const d = await onImport(files);
    const spy = vi.spyOn(importCheck, 'importProblem');
    const p = await prepareHudShare(d);
    expect(p.left.some((l) => l.startsWith('cfg/autoexec.cfg: '))).toBe(true);
    expect(p.importFiles!.has('cfg/autoexec.cfg')).toBe(false);
    const kept = await hudId(p.importFiles!);
    used.add(kept);
    expect(p.design.imported!.id).toBe(kept);
    expect(kept).not.toBe(d.imported!.id);
    expect(p.design.imported!.name).toBe('edgehud');
    expect(hasImport(kept)).toBe(true);
    expect(spy).toHaveBeenCalledWith(kept);
    // The rest of the design is untouched.
    expect({ ...p.design, imported: undefined }).toEqual({ ...d, imported: undefined });
  });

  it('refuses a set that breaks a cap after filtering, with the cap sentence', async () => {
    const files = shareableHudFiles(sampleHud()).kept;
    for (let i = 0; i <= HUD_CAPS.files; i++) {
      files.set(`materials/vgui/pad/p${i}.vmt`, latin1('"UnlitGeneric"\n{\n\t"$basetexture" "vgui/pad/p"\n}\n'));
    }
    const d = await onImport(files);
    await expect(prepareHudShare(d)).rejects.toThrow(`A shared HUD may hold at most ${HUD_CAPS.files} files.`);
  });
});

/** happy-dom has no 2D context: a do-nothing one that logs its calls, and a toBlob that hands back a PNG-typed blob. */
function stubCanvas() {
  const made: HTMLCanvasElement[] = [];
  const blobTypes: (string | undefined)[] = [];
  const calls: [string, unknown[]][] = [];
  vi.stubGlobal('Image', FakeImage);
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(function (this: HTMLCanvasElement) {
    made.push(this);
    return new Proxy({}, {
      get: (_t, k) => (k === 'canvas' ? this : (...a: unknown[]) => {
        calls.push([String(k), a]);
        if (k === 'measureText') return { width: 10 };
        if (k === 'getImageData') return { data: new Uint8ClampedArray(4) };
        if (k === 'createLinearGradient' || k === 'createRadialGradient' || k === 'createPattern') return { addColorStop() {} };
        return undefined;
      }),
      set: () => true,
    }) as never;
  } as never);
  vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation(function (this: HTMLCanvasElement, cb: BlobCallback, type?: string) {
    blobTypes.push(type);
    calls.push(['toBlob', []]);
    cb(new Blob([new Uint8Array([0x89, 0x50])], { type: type ?? 'image/png' }));
  } as never);
  return { made, blobTypes, calls };
}

const lastDrawImage = (calls: [string, unknown[]][]) => {
  const upTo = calls.findIndex(([k]) => k === 'toBlob');
  return calls.slice(0, upTo).filter(([k, a]) => k === 'drawImage' && a[0] instanceof FakeImage).pop()?.[1];
};

describe('renderPreview', () => {
  for (const [aspect, w] of [['16:9', 960], ['4:3', 720], ['16:10', 864]] as const) {
    it(`draws ${aspect} at ${w}x540 and exports a PNG`, async () => {
      const { made, blobTypes } = stubCanvas();
      const blob = await renderPreview(validateDesign({ v: 1, name: 'x', preset: 'stock', aspect }), 'survivor', { quietMs: 5, maxMs: 50 });
      expect(PREVIEW_SIZE[aspect]).toEqual({ w, h: 540 });
      expect(blob.type).toBe('image/png');
      expect(blobTypes).toEqual(['image/png']);
      expect(made.some((c) => c.width === w && c.height === 540)).toBe(true);
    });
  }
});

describe('renderPreview on the in-game backdrops', () => {
  const stock = () => validateDesign({ v: 1, name: 'x', preset: 'stock', aspect: '16:9' });

  it('draws the survivor side on the forest shot, Healthy and holding the gun', async () => {
    FakeImage.auto = 'load';
    const { calls } = stubCanvas();
    const hud = vi.spyOn(mock, 'drawHud');
    await renderPreview(stock(), 'survivor', { quietMs: 5, maxMs: 50 });
    const img = FakeImage.made.find((i) => i.src === '/hud-backdrops/survivor-hilltop.jpg');
    expect(img).toBeTruthy();
    expect(lastDrawImage(calls)).toEqual([img, 0, 0, 960, 540]);
    expect(hud.mock.calls.at(-1)!.slice(4, 5)).toEqual(['survivor']);
    expect(hud.mock.calls.at(-1)![7]).toEqual({ state: 'healthy', held: 'primary' });
  });

  it('draws the infected side on the Hunter shot, a spawned Hunter with its ability ready', async () => {
    FakeImage.auto = 'load';
    const { calls } = stubCanvas();
    const hud = vi.spyOn(mock, 'drawHud');
    await renderPreview(stock(), 'infected', { quietMs: 5, maxMs: 50 });
    const img = FakeImage.made.find((i) => i.src === '/hud-backdrops/infected-hunter.jpg');
    expect(lastDrawImage(calls)).toEqual([img, 0, 0, 960, 540]);
    expect(hud.mock.calls.at(-1)![4]).toBe('infected');
    expect(hud.mock.calls.at(-1)![7]).toEqual({ state: DEFAULT_PREVIEW });
    expect(DEFAULT_PREVIEW).toMatchObject({ infected: 'alive', siClass: 'hunter', ability: 'ready' });
  });

  it('shows on the infected side exactly what a spawned Hunter always sees: no occasional panel, no other class or state', async () => {
    FakeImage.auto = 'load';
    const { calls } = stubCanvas();
    const hud = vi.spyOn(mock, 'drawHud');
    for (const preset of ['stock', 'modern'] as const) {
      const d = validateDesign({ v: 1, name: 'x', preset, aspect: '16:9' });
      await renderPreview(d, 'infected', { quietMs: 5, maxMs: 50 });
      const view = hud.mock.calls.at(-1)![7]!;
      expect(hud.mock.calls.at(-1)![5]).toBeNull();
      const shown = mock.visibleElements('infected', d).filter((el) => mock.shownInState(el, view.state)).map((el) => el.id);
      // The chat and the kill notices are the everyday stand-ins both sides show; the ability marker is the crosshair's centre.
      expect(shown.sort(), preset).toEqual(['abilityMarker', 'abilityRing', 'chat', 'infectedRow', 'killNotices', 'siHealth', 'xhair']);
    }
    // The too-far box shows in the game only when a spawned infected strays far from the survivors.
    expect(calls.some(([m, a]) => m === 'fillText' && a[0] === 'TOO FAR FROM THE SURVIVORS')).toBe(false);
  });

  it('shows on the survivor side exactly what a Healthy survivor always sees: no use bar, no occasional panel', async () => {
    FakeImage.auto = 'load';
    const { calls } = stubCanvas();
    const hud = vi.spyOn(mock, 'drawHud');
    for (const preset of ['stock', 'modern'] as const) {
      const d = validateDesign({ v: 1, name: 'x', preset, aspect: '16:9' });
      await renderPreview(d, 'survivor', { quietMs: 5, maxMs: 50 });
      const view = hud.mock.calls.at(-1)![7]!;
      expect(hud.mock.calls.at(-1)![5]).toBeNull();
      const shown = mock.visibleElements('survivor', d).filter((el) => mock.shownInState(el, view.state)).map((el) => el.id);
      // Your health, the teammates, the weapons and the crosshair are always up; the chat and the
      // kill notices are the everyday stand-ins both sides show. The mic, vote, voice list, survival
      // timer, finale meter, peril notice and wait-for-teammates warning come and go.
      expect(shown.sort(), preset).toEqual(['chat', 'killNotices', 'ownHealth', 'teamColumn', 'weaponSelection', 'xhair']);
    }
    // The use bar shows in the game only while you heal, revive or are revived.
    expect(calls.some(([m, a]) => m === 'fillText' && a[0] === 'HEALING YOURSELF')).toBe(false);
  });

  it('waits for the backdrop before it draws anything', async () => {
    FakeImage.auto = null;
    const { calls } = stubCanvas();
    let done = false;
    const p = renderPreview(stock(), 'survivor', { quietMs: 5, maxMs: 50 }).then((b) => { done = true; return b; });
    await new Promise((r) => setTimeout(r, 80));
    expect(done).toBe(false);
    expect(calls.some(([k]) => k === 'fillRect' || k === 'drawImage')).toBe(false);
    FakeImage.made[0]!.onload!();
    await p;
    expect(lastDrawImage(calls)?.[0]).toBe(FakeImage.made[0]);
  });

  it('falls back to the drawn saferoom when the shot cannot load', async () => {
    FakeImage.auto = 'error';
    const { calls, blobTypes } = stubCanvas();
    await renderPreview(stock(), 'infected', { quietMs: 5, maxMs: 50 });
    expect(blobTypes).toEqual(['image/png']);
    expect(calls.some(([k]) => k === 'createLinearGradient')).toBe(true);
    expect(lastDrawImage(calls)).toBeUndefined();
  });

  it('renderPreviews makes both sides', async () => {
    FakeImage.auto = 'load';
    const { blobTypes } = stubCanvas();
    const hud = vi.spyOn(mock, 'drawHud');
    const both = await renderPreviews(stock(), { quietMs: 5, maxMs: 50 });
    expect(both.survivor).toBeInstanceOf(Blob);
    expect(both.infected).toBeInstanceOf(Blob);
    expect(blobTypes).toEqual(['image/png', 'image/png']);
    expect(new Set(hud.mock.calls.map((c) => c[4]))).toEqual(new Set(['survivor', 'infected']));
  });
});

describe('buildHudForm', () => {
  const preview = new Blob([new Uint8Array([1, 2, 3])], { type: 'image/png' });

  it('sends meta and preview only for a design with no import', async () => {
    const d = modern();
    const form = buildHudForm({ title: 'Clean', description: 'd', permission: true, prepared: { design: d, importFiles: null, left: [] }, preview });
    expect([...form.keys()]).toEqual(['meta', 'preview']);
    const both = buildHudForm({ title: 'Clean', description: 'd', permission: true, prepared: { design: d, importFiles: null, left: [] }, preview, previewInfected: preview });
    expect([...both.keys()]).toEqual(['meta', 'preview', 'previewInfected']);
    const meta = JSON.parse(form.get('meta') as string);
    expect(meta).toEqual({ title: 'Clean', description: 'd', permission: true, design: JSON.stringify(d) });
    expect(form.get('preview')).toBeInstanceOf(Blob);
  });

  it('adds the import as the VPK encodeVPK writes, with its id', async () => {
    const files = shareableHudFiles(sampleHud()).kept;
    const d = await onImport(files);
    const form = buildHudForm({ title: 'Edge', description: '', permission: true, prepared: { design: d, importFiles: files, left: [] }, preview });
    expect([...form.keys()]).toEqual(['meta', 'preview', 'import']);
    const meta = JSON.parse(form.get('meta') as string);
    expect(meta.importId).toBe(d.imported!.id);
    expect(JSON.parse(meta.design).imported.id).toBe(d.imported!.id);
    const sent = new Uint8Array(await (form.get('import') as Blob).arrayBuffer());
    expect(sent).toEqual(encodeVPK([...files].map(([path, data]) => ({ path, data }))));
    expect(readVPK(sent).size).toBe(files.size);
  });
});
