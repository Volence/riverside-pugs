import { describe, it, expect } from 'vitest';
import { buildHud } from './build';
import { DEFAULT_DESIGN, validateDesign, type HudDesign } from './design';
import { baseFile } from './base';

/**
 * The item pickup fly-in (plan task M3). Probe F1,
 * /home/volence/l4d/hud/probe-phase2-rest/RESULTS.md (r1-b): the addon's
 * hudanimations.txt is read, and rewriting StartItemPickup1..3 changed where
 * the picked-up icon drew, so rewriting them to hold it clear switches it off.
 */
const ANIMS = 'scripts/hudanimations.txt';
const text = (files: { path: string; data: Uint8Array }[], path: string) => {
  const f = files.find((x) => x.path === path);
  return f ? new TextDecoder('latin1').decode(f.data) : undefined;
};
const body = (anims: string, n: number) => {
  const m = new RegExp(`event\\s+StartItemPickup${n}\\s*\\{([^}]*)\\}`).exec(anims);
  return m ? m[1].trim() : undefined;
};
const plain = (p: Partial<HudDesign> = {}): HudDesign => ({ ...structuredClone(DEFAULT_DESIGN), elements: {}, ...p });

describe('item pickup fly-in off (plan task M3)', () => {
  it('keeps pickupFlyIn only as false', () => {
    expect(validateDesign({ v: 1, pickupFlyIn: false }).pickupFlyIn).toBe(false);
    expect(validateDesign({ v: 1, pickupFlyIn: true }).pickupFlyIn).toBeUndefined();
    expect(validateDesign({ v: 1, pickupFlyIn: 'no' }).pickupFlyIn).toBeUndefined();
  });

  it('rewrites the three pickup events to hold their image clear, and nothing else', () => {
    const anims = text(buildHud(validateDesign({ v: 1, pickupFlyIn: false })), ANIMS)!;
    for (const n of [1, 2, 3]) expect(body(anims, n), `StartItemPickup${n}`).toBe(`Animate image${n} Alpha 0 Linear 0.0 0.001`);
    // Everything outside the three events is the base file's.
    const strip = (s: string) => s.replace(/event\s+StartItemPickup[123]\s*\{[^}]*\}/g, '');
    expect(strip(anims)).toBe(strip(baseFile('stock', ANIMS)));
  });

  it('writes nothing while the fly-in is on', () => {
    expect(text(buildHud(plain()), ANIMS)).toBeUndefined();
  });

  it('keeps the chat position rewrite in the same file', () => {
    const anims = text(buildHud(validateDesign({ v: 1, pickupFlyIn: false, elements: { chat: { x: 134, y: 320 } } })), ANIMS)!;
    expect(anims.match(/Animate\s+HudChat\s+Position\s+"134 /g)).toHaveLength(3);
    expect(body(anims, 2)).toBe('Animate image2 Alpha 0 Linear 0.0 0.001');
  });

  it('works on Modern\'s own animation file', () => {
    const d = validateDesign({ v: 1, preset: 'modern', pickupFlyIn: false });
    const anims = text(buildHud(d, { fonts: { regular: new Uint8Array(1), bold: new Uint8Array(1) } }), ANIMS)!;
    for (const n of [1, 2, 3]) expect(body(anims, n)).toBe(`Animate image${n} Alpha 0 Linear 0.0 0.001`);
  });
});
