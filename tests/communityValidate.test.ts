import { describe, it, expect } from 'vitest';
import {
  checkTitle, checkDescription, checkCrosshairArt, checkHudDesign, checkPreview, PREVIEW_MAX_BYTES,
  COMMUNITY_XHAIR_CAPS, DESIGN_XHAIR_CAPS,
} from '../src/community/validate.js';

// Parity with the web's readArt and safeName, and checkImport (which needs
// the web's encodeVPK), live in web/src/community/validate.test.ts: those web
// modules do not typecheck under this project's NodeNext resolution.

/** A PNG header only: signature, then an IHDR chunk saying w x h. Enough for pngSize. */
function png(w: number, h: number, pad = 0): Uint8Array {
  const b = new Uint8Array(33 + pad);
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const dv = new DataView(b.buffer);
  dv.setUint32(8, 13);
  b.set([0x49, 0x48, 0x44, 0x52], 12);
  dv.setUint32(16, w);
  dv.setUint32(20, h);
  return b;
}
const b64 = (b: Uint8Array) => Buffer.from(b).toString('base64');
const dataUrl = (b: Uint8Array) => `data:image/png;base64,${b64(b)}`;

const errorOf = (r: { ok: boolean; error?: string }) => (r.ok ? null : r.error);

describe('checkTitle', () => {
  it('refuses too short and too long', () => {
    expect(checkTitle('ab')).toMatchObject({ ok: false, status: 400 });
    expect(checkTitle('x'.repeat(41))).toMatchObject({ ok: false, status: 400 });
    expect(checkTitle('x'.repeat(40))).toEqual({ ok: true, value: 'x'.repeat(40) });
  });
  it('refuses a second line and invisible characters', () => {
    expect(checkTitle('two\nlines').ok).toBe(false);
    expect(checkTitle('zero​width').ok).toBe(false);
    expect(checkTitle('flip‮ped').ok).toBe(false);
  });
  it('refuses a slur with the one fixed line', () => {
    expect(errorOf(checkTitle('my n1gga hud'))).toBe('That title is not allowed here.');
  });
  it('refuses anything that is not text', () => {
    expect(checkTitle(42).ok).toBe(false);
    expect(checkTitle(undefined).ok).toBe(false);
  });
  it('returns a good title trimmed', () => {
    expect(checkTitle('  Clean HUD  ')).toEqual({ ok: true, value: 'Clean HUD' });
  });
});

describe('checkDescription', () => {
  it('allows an empty one', () => {
    expect(checkDescription('')).toEqual({ ok: true, value: '' });
    expect(checkDescription(undefined)).toEqual({ ok: true, value: '' });
  });
  it('refuses over 280 characters and over 4 lines', () => {
    expect(checkDescription('x'.repeat(281)).ok).toBe(false);
    expect(checkDescription('x'.repeat(280)).ok).toBe(true);
    expect(checkDescription('a\nb\nc\nd\ne').ok).toBe(false);
    expect(checkDescription('a\nb\nc\nd')).toEqual({ ok: true, value: 'a\nb\nc\nd' });
  });
  it('refuses a link', () => {
    expect(errorOf(checkDescription('see twitch.tv/x'))).toMatch(/link/i);
  });
  it('refuses a slur', () => {
    expect(errorOf(checkDescription('made by a n1gga'))).toBe('That description is not allowed here.');
  });
  it('refuses control and bidi characters', () => {
    expect(checkDescription('tab\there').ok).toBe(false);
    expect(checkDescription('flip‮ped').ok).toBe(false);
  });
  it('normalises CRLF', () => {
    expect(checkDescription('one\r\ntwo\rthree')).toEqual({ ok: true, value: 'one\ntwo\nthree' });
  });
});

describe('checkCrosshairArt', () => {
  const caps = COMMUNITY_XHAIR_CAPS;
  it('uses the community caps the spec gives', () => {
    expect(caps).toEqual({ side: 128, b64: 100_000 });
    expect(DESIGN_XHAIR_CAPS).toEqual({ side: 512, b64: 1_400_000 });
  });
  it('refuses a built art the builder could not have made', () => {
    expect(checkCrosshairArt({ kind: 'built', state: { shape: 'star' } }, caps).ok).toBe(false);
    expect(checkCrosshairArt({ kind: 'built', state: { len: Number.NaN } }, caps).ok).toBe(false);
    expect(checkCrosshairArt({ kind: 'built', state: { color: 'red' } }, caps).ok).toBe(false);
    expect(checkCrosshairArt({ kind: 'weird' }, caps).ok).toBe(false);
    expect(checkCrosshairArt('built', caps).ok).toBe(false);
  });
  it('clamps an out-of-range number', () => {
    const r = checkCrosshairArt({ kind: 'built', state: { len: 999 } }, caps);
    expect(r.ok && r.value.kind === 'built' && r.value.state.len).toBe(30);
  });
  it('refuses an image whose IHDR disagrees with w and h', () => {
    expect(checkCrosshairArt({ kind: 'image', png: dataUrl(png(64, 64)), w: 128, h: 128 }, caps).ok).toBe(false);
  });
  it('refuses an image over the side cap', () => {
    expect(checkCrosshairArt({ kind: 'image', png: dataUrl(png(129, 129)), w: 129, h: 129 }, caps).ok).toBe(false);
  });
  it('refuses an image over the base64 cap', () => {
    expect(checkCrosshairArt({ kind: 'image', png: dataUrl(png(128, 128, 80_000)), w: 128, h: 128 }, caps).ok).toBe(false);
  });
  it('refuses an image that is not a PNG', () => {
    const notPng = png(128, 128); notPng[1] = 0;
    expect(checkCrosshairArt({ kind: 'image', png: dataUrl(notPng), w: 128, h: 128 }, caps).ok).toBe(false);
    expect(checkCrosshairArt({ kind: 'image', png: 'data:image/png;base64,<script>', w: 128, h: 128 }, caps).ok).toBe(false);
  });
  it('passes a good 128 x 128 PNG unchanged', () => {
    const art = { kind: 'image', png: dataUrl(png(128, 128)), w: 128, h: 128 };
    expect(checkCrosshairArt(art, caps)).toEqual({ ok: true, value: art });
  });
});

const ID = 'a'.repeat(64);
const stock = (extra: Record<string, unknown> = {}) => ({
  v: 1, name: 'whatever', preset: 'stock', advanced: false, aspect: '16:9', font: 'preset',
  crosshair: 'none', elements: {}, styles: {}, images: {}, children: {}, ...extra,
});
const imported = (extra: Record<string, unknown> = {}) =>
  stock({ preset: 'imported', imported: { id: ID, name: 'Their HUD!' }, ...extra });
const design = (d: unknown, opts: { importId?: string; title?: string } = {}) =>
  checkHudDesign(JSON.stringify(d), { title: 'My Clean HUD', ...opts });

describe('checkHudDesign', () => {
  it('refuses what is not JSON, or too big', () => {
    expect(checkHudDesign('{nope', { title: 't' })).toMatchObject({ ok: false, status: 400 });
    const big = JSON.stringify(stock({ pad: 'x'.repeat(2 * 1024 * 1024) }));
    expect(checkHudDesign(big, { title: 't' })).toMatchObject({ ok: false, status: 413 });
  });
  it('refuses the wrong version, preset, aspect or advanced', () => {
    expect(design(stock({ v: 2 })).ok).toBe(false);
    expect(design([stock()]).ok).toBe(false);
    expect(design(stock({ preset: 'fancy' })).ok).toBe(false);
    expect(design(stock({ aspect: '21:9' })).ok).toBe(false);
    expect(design(stock({ advanced: 'yes' })).ok).toBe(false);
  });
  it('ties imported.id to the upload both ways', () => {
    expect(design(stock({ preset: 'imported' }), { importId: ID }).ok).toBe(false);
    expect(design(imported({ imported: { id: 'b'.repeat(64), name: 'x' } }), { importId: ID }).ok).toBe(false);
    expect(design(imported()).ok).toBe(false);
    expect(design(stock(), { importId: ID }).ok).toBe(false);
    expect(design(stock({ imported: { id: ID, name: 'x' } })).ok).toBe(false);
    expect(design(imported(), { importId: ID }).ok).toBe(true);
  });
  it('checks every style image is a real PNG within the caps', () => {
    const notPng = png(40, 10); notPng[0] = 0;
    expect(design(stock({ images: { panelBg: { w: 40, h: 10, png: b64(notPng) } } })).ok).toBe(false);
    expect(design(stock({ images: { panelBg: { w: 600, h: 10, png: b64(png(600, 10)) } } })).ok).toBe(false);
    expect(design(stock({ images: { panelBg: { w: 40, h: 10, png: b64(png(41, 10)) } } })).ok).toBe(false);
    expect(design(stock({ images: { panelBg: { w: 40, h: 10, png: b64(png(40, 10)) } } })).ok).toBe(true);
    expect(design(stock({ images: 'nope' })).ok).toBe(false);
  });
  it('checks xhairArt with the design caps', () => {
    const art = (side: number) => ({ kind: 'image', png: dataUrl(png(side, side)), w: side, h: side });
    expect(design(stock({ xhairArt: art(512) })).ok).toBe(true);
    expect(design(stock({ xhairArt: art(513) })).ok).toBe(false);
    expect(design(stock({ xhairArt: { kind: 'built', state: { shape: 'star' } } })).ok).toBe(false);
  });
  it('returns the summary and renames the design after its title', () => {
    const r = design(imported({ advanced: true, aspect: '4:3' }), { importId: ID, title: 'My <b>Clean</b> HUD!' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value).toMatchObject({ preset: 'imported', aspect: '4:3', advanced: true, importName: 'Their HUD' });
    const back = JSON.parse(r.value.json);
    expect(back.name).toBe('My bCleanb HUD');
    expect(back.imported).toEqual({ id: ID, name: 'Their HUD' });
    const plain = design(stock());
    expect(plain.ok && plain.value.importName).toBe(null);
  });
});

describe('checkPreview', () => {
  it('passes the size that matches the aspect', () => {
    expect(checkPreview(png(960, 540), '16:9').ok).toBe(true);
    expect(checkPreview(png(864, 540), '16:10').ok).toBe(true);
    expect(checkPreview(png(720, 540), '4:3').ok).toBe(true);
  });
  it('refuses a size for another aspect', () => {
    expect(checkPreview(png(960, 540), '4:3').ok).toBe(false);
  });
  it('names the side in its refusal when asked', () => {
    expect(checkPreview(png(960, 540), '4:3', 'The infected preview')).toMatchObject({ ok: false, error: 'The infected preview must be 720 x 540 for 4:3.' });
    expect(checkPreview(new TextEncoder().encode('<html>'), '16:9', 'The infected preview')).toMatchObject({ error: 'The infected preview is not a PNG.' });
  });
  it('allows any PNG a 960 x 540 canvas can encode: the cap is above its raw RGBA size', () => {
    // 4 bytes a pixel plus one filter byte a row, before zlib: an encoder
    // that stores it uncompressed still fits, so a real preview is never refused.
    expect(960 * 540 * 4 + 540 + 64 * 1024).toBeLessThan(PREVIEW_MAX_BYTES);
  });
  it('refuses over 2.5 MB, and what is not a PNG', () => {
    expect(checkPreview(png(960, 540, 2.5 * 1024 * 1024 - 33 + 1), '16:9')).toMatchObject({ ok: false, status: 413, error: 'The preview is over 2.5 MB.' });
    expect(checkPreview(png(960, 540, 2.5 * 1024 * 1024 - 33), '16:9').ok).toBe(true);
    expect(checkPreview(new TextEncoder().encode('<html>'), '16:9')).toMatchObject({ ok: false, status: 400 });
  });
});
