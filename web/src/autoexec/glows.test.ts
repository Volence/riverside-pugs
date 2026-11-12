import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  DEFAULT_STATE, GLOWS, RIVERSIDE_GLOWS, buildCfg, fromHex, legalChannel, parseCfg, readState, toHex,
} from './glows';

describe('glow catalog', () => {
  it('offers only settable glow colour cvars, never the cheat or dev-only ones', () => {
    const banned = ['brightness', 'blur_scale', 'force', 'noise', 'los_delay', 'los_fade_in_time', 'los_fade_out_time', 'infected_ghosts'];
    for (const g of GLOWS) expect(banned).not.toContain(g.id);
    // cl_glow_infected (dev-only on/off) is not offered; cl_glow_infected_r/g/b (the colour) is.
    expect(new Set(GLOWS.map((g) => g.id)).size).toBe(GLOWS.length);
    expect(GLOWS).toHaveLength(18);
  });

  it('has every default inside the legal range', () => {
    for (const g of GLOWS) for (const v of g.def) expect(v).toBe(legalChannel(v));
  });
});

describe('legal values', () => {
  it('clamps to 0..1 at three decimals', () => {
    expect(legalChannel(1.7)).toBe(1);
    expect(legalChannel(-3)).toBe(0);
    expect(legalChannel(Number.NaN)).toBe(0);
    expect(legalChannel(0.12345)).toBe(0.123);
  });

  it('round-trips hex codes', () => {
    expect(fromHex('#ff8000')).toEqual([1, 0.502, 0]);
    expect(fromHex('0f0')).toEqual([0, 1, 0]);
    expect(fromHex('#zzzzzz')).toBeNull();
    expect(fromHex('#12345')).toBeNull();
    expect(toHex([1, 0.502, 0])).toBe('#ff8000');
    expect(toHex([2, -1, 0.5])).toBe('#ff0080');
  });
});

describe('cfg', () => {
  it('writes all 54 glow lines and nothing for cl_colorblind left alone', () => {
    const cfg = buildCfg(DEFAULT_STATE);
    expect(cfg.split('\n').filter((l) => l.startsWith('cl_glow_'))).toHaveLength(54);
    expect(cfg).not.toMatch(/^cl_colorblind/m);
    expect(cfg).toContain('cl_glow_survivor_r "0.3"');
  });

  it('writes cl_colorblind only when chosen', () => {
    expect(buildCfg({ ...DEFAULT_STATE, colorblind: '2' })).toMatch(/^cl_colorblind "2"$/m);
  });

  it('reads back what it writes', () => {
    const state = { glows: { ...DEFAULT_STATE.glows, survivor: [0.1, 0.2, 0.3] as const }, colorblind: '1' as const };
    const r = parseCfg(buildCfg(state));
    expect(r.state).toEqual(state);
    expect(r.read).toBe(55);
  });

  it('reads the site autoexec, skips other cvars, clamps out-of-range values', () => {
    const site = readFileSync(resolve(__dirname, '../../public/autoexec.cfg'), 'utf8');
    const r = parseCfg(site);
    expect(r.state.glows).toEqual({ ...DEFAULT_STATE.glows, ...RIVERSIDE_GLOWS });
    expect(r.state.colorblind).toBe('1');

    const odd = parseCfg('cl_glow_item_r 5; cl_glow_item_g "-1" // comment\ncl_glow_brightness 3\nsensitivity 2');
    expect(odd.state.glows.item).toEqual([1, 0, 1]);
    expect(odd.ignored).toEqual(['cl_glow_brightness']);
  });

  it('cleans stored state', () => {
    const s = readState({ glows: { survivor: [9, 0.5, 'x'], ability: [2, -1, 0.5], bogus: [1, 1, 1] }, colorblind: '7' });
    expect(s.glows.survivor).toEqual(DEFAULT_STATE.glows.survivor);
    expect(s.glows.ability).toEqual([1, 0, 0.5]);
    expect(s.glows).not.toHaveProperty('bogus');
    expect(s.colorblind).toBe('keep');
  });
});
