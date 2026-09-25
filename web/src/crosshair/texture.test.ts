import { describe, it, expect, afterEach, vi } from 'vitest';
import { artPixels, uploadArt, importedCrosshair, XHAIR_TEXTURE } from './texture';
import { crosshairPixels } from './saved';
import { DEFAULT_STATE, TEX } from './draw';
import { PNG_PREFIX, type CrosshairArt } from './model';
import { encodeVPK, encodeVTF } from '../vpk';
import { handMade } from '../vpk/fixtures';

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

/**
 * happy-dom has no 2D context. Every canvas gets one that records its calls
 * with the canvas's size, and hands back `pixels` from getImageData.
 */
function stubCanvas(pixels: Uint8ClampedArray = new Uint8ClampedArray(TEX * TEX * 4).fill(7)) {
  const calls: { size: [number, number]; m: string; a: unknown[] }[] = [];
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(function (this: HTMLCanvasElement) {
    const size: [number, number] = [this.width, this.height];
    return new Proxy({}, {
      get: (_t, k) => (...a: unknown[]) => {
        calls.push({ size, m: String(k), a });
        if (k === 'getImageData') return { data: pixels };
        if (k === 'createImageData') return { data: new Uint8ClampedArray((a[0] as number) * (a[1] as number) * 4), width: a[0], height: a[1] };
        return undefined;
      },
      set: () => true,
    }) as never;
  } as never);
  vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockReturnValue(`${PNG_PREFIX}UE5H`);
  return { calls, pixels };
}

/** An Image whose load finishes at once, as a data URL's would. */
function stubImage() {
  const loaded: string[] = [];
  vi.stubGlobal('Image', class {
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;
    set src(v: string) { loaded.push(v); queueMicrotask(() => this.onload?.()); }
  });
  return loaded;
}

describe('artPixels', () => {
  it("draws a built crosshair exactly as the Crosshair page's download does", async () => {
    const state = { ...DEFAULT_STATE, shape: 'circledot' as const, radius: 6 };
    const page = stubCanvas();
    const want = crosshairPixels(state, null);
    const pageCalls = page.calls.map((c) => ({ ...c }));
    vi.restoreAllMocks();
    const hud = stubCanvas(want!);
    expect(await artPixels({ kind: 'built', state })).toBe(want);
    // The same calls, argument for argument, into the same TEX x TEX canvas.
    expect(hud.calls).toEqual(pageCalls);
  });

  it('draws an image into the TEX square, aspect kept and centred, and returns those pixels', async () => {
    const { calls, pixels } = stubCanvas();
    const loaded = stubImage();
    const art: CrosshairArt = { kind: 'image', png: `${PNG_PREFIX}AAAA`, w: 64, h: 32 };
    expect(await artPixels(art)).toBe(pixels);
    expect(loaded).toEqual([art.png]);
    const draw = calls.find((c) => c.m === 'drawImage')!;
    expect(draw.size).toEqual([TEX, TEX]);
    expect(draw.a.slice(1)).toEqual([0, TEX / 4, TEX, TEX / 2]);
  });

  it('fails in a sentence when the stored image will not decode', async () => {
    stubCanvas();
    vi.stubGlobal('Image', class {
      onerror: (() => void) | null = null;
      set src(_v: string) { queueMicrotask(() => this.onerror?.()); }
    });
    await expect(artPixels({ kind: 'image', png: PNG_PREFIX, w: 1, h: 1 })).rejects.toThrow(/crosshair image will not decode/);
  });
});

describe('uploadArt', () => {
  const vpk = (files: { path: string; data: Uint8Array }[]) => new File([encodeVPK(files)], 'mine.vpk');

  it("takes a crosshair addon's texture, fitted into the TEX square, as an image crosshair", async () => {
    const { calls } = stubCanvas();
    const rgba = new Uint8ClampedArray(64 * 32 * 4).map((_, i) => i & 0xff);
    const file = vpk([
      { path: XHAIR_TEXTURE, data: encodeVTF(64, 32, rgba) },
      { path: 'scripts/hudlayout.res', data: new TextEncoder().encode('x') },
    ]);
    expect(await uploadArt(file)).toEqual({ kind: 'image', png: `${PNG_PREFIX}UE5H`, w: TEX, h: TEX });
    // The decoded pixels go into a canvas their own size, which is then fitted into the texture.
    const put = calls.find((c) => c.m === 'putImageData')!;
    expect(put.size).toEqual([64, 32]);
    expect([...(put.a[0] as ImageData).data]).toEqual([...rgba]);
    const draw = calls.find((c) => c.m === 'drawImage')!;
    expect(draw.size).toEqual([TEX, TEX]);
    expect(draw.a.slice(1)).toEqual([0, TEX / 4, TEX, TEX / 2]);
  });

  it('says so when a .vpk has no crosshair in it', async () => {
    stubCanvas();
    await expect(uploadArt(vpk([{ path: 'scripts/hudlayout.res', data: new Uint8Array(1) }]))).rejects.toThrow('No crosshair found in this file.');
  });

  it('says so when the crosshair is in a side archive of a multi-part addon', async () => {
    stubCanvas();
    const bytes = handMade([{ path: XHAIR_TEXTURE, archive: 0, offset: 0, length: 4096, preload: new Uint8Array(0) }]);
    await expect(uploadArt(new File([bytes], 'crosshair_dir.vpk'))).rejects.toThrow(
      'This addon is split across several files (..._dir.vpk plus _000.vpk); the site needs a single-file .vpk.');
  });

  it('reads a .vpk by its signature, whatever it is called, and refuses a broken one by its name', async () => {
    stubCanvas();
    const bytes = encodeVPK([{ path: XHAIR_TEXTURE, data: encodeVTF(1, 1, new Uint8ClampedArray(4)) }]);
    expect((await uploadArt(new File([bytes], 'crosshair.bin'))).kind).toBe('image');
    await expect(uploadArt(new File([new Uint8Array(40)], 'broken.vpk'))).rejects.toThrow(/not a \.vpk/);
  });

  it('takes an image file the same way', async () => {
    const { calls } = stubCanvas();
    const bitmap = { width: 20, height: 40 };
    vi.stubGlobal('createImageBitmap', vi.fn(async () => bitmap));
    expect(await uploadArt(new File([new Uint8Array(8)], 'x.png', { type: 'image/png' }))).toEqual({ kind: 'image', png: `${PNG_PREFIX}UE5H`, w: TEX, h: TEX });
    const draw = calls.find((c) => c.m === 'drawImage')!;
    expect(draw.a).toEqual([bitmap, TEX / 4, 0, TEX / 2, TEX]);
  });

  it('refuses a file that is neither, or is too big', async () => {
    stubCanvas();
    vi.stubGlobal('createImageBitmap', vi.fn(async () => { throw new Error('no'); }));
    await expect(uploadArt(new File(['hello'], 'notes.txt'))).rejects.toThrow(/not a crosshair/);
    await expect(uploadArt(new File([new Uint8Array(4_000_001)], 'big.png'))).rejects.toThrow(/over 4 MB/);
  });
});

describe('importedCrosshair', () => {
  it("takes an imported HUD's own altcrosshair texture, fitted like an uploaded one", () => {
    stubCanvas();
    const rgba = new Uint8ClampedArray(64 * 32 * 4).map((_, i) => i & 0xff);
    expect(importedCrosshair(new Map([[XHAIR_TEXTURE, encodeVTF(64, 32, rgba)]]))).toEqual({ kind: 'image', png: `${PNG_PREFIX}UE5H`, w: TEX, h: TEX });
  });

  it('gives nothing when the HUD has no crosshair texture or it will not decode', () => {
    stubCanvas();
    expect(importedCrosshair(new Map())).toBeNull();
    expect(importedCrosshair(new Map([[XHAIR_TEXTURE, new Uint8Array(10)]]))).toBeNull();
  });
});
