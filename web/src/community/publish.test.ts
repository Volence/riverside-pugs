import { describe, it, expect, afterEach, vi } from 'vitest';
import { prepareHudShare, renderPreview, buildHudForm, PREVIEW_SIZE } from './publish';
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
});

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

/** happy-dom has no 2D context: a do-nothing one, and a toBlob that hands back a PNG-typed blob. */
function stubCanvas() {
  const made: HTMLCanvasElement[] = [];
  const blobTypes: (string | undefined)[] = [];
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(function (this: HTMLCanvasElement) {
    made.push(this);
    return new Proxy({}, {
      get: (_t, k) => (k === 'canvas' ? this : (..._a: unknown[]) => {
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
    cb(new Blob([new Uint8Array([0x89, 0x50])], { type: type ?? 'image/png' }));
  } as never);
  return { made, blobTypes };
}

describe('renderPreview', () => {
  for (const [aspect, w] of [['16:9', 960], ['4:3', 720], ['16:10', 864]] as const) {
    it(`draws ${aspect} at ${w}x540 and exports a PNG`, async () => {
      const { made, blobTypes } = stubCanvas();
      const blob = await renderPreview(validateDesign({ v: 1, name: 'x', preset: 'stock', aspect }), { quietMs: 5, maxMs: 50 });
      expect(PREVIEW_SIZE[aspect]).toEqual({ w, h: 540 });
      expect(blob.type).toBe('image/png');
      expect(blobTypes).toEqual(['image/png']);
      expect(made.some((c) => c.width === w && c.height === 540)).toBe(true);
    });
  }
});

describe('buildHudForm', () => {
  const preview = new Blob([new Uint8Array([1, 2, 3])], { type: 'image/png' });

  it('sends meta and preview only for a design with no import', async () => {
    const d = modern();
    const form = buildHudForm({ title: 'Clean', description: 'd', permission: true, prepared: { design: d, importFiles: null, left: [] }, preview });
    expect([...form.keys()]).toEqual(['meta', 'preview']);
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
