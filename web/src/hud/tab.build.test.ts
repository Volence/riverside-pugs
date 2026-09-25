import { describe, it, expect } from 'vitest';
import { buildHud } from './build';
import { DEFAULT_DESIGN, type HudDesign } from './design';
import { parseKv, writeKv, kvGet, pcFind, type KvNode } from './kv';
import { baseFile } from './base';

/**
 * The Tab screen in the download (tab screen spec
 * docs/superpowers/specs/2026-09-25-hud-editor-tab-screen-design.md, 4.4,
 * tasks 6 to 8, and the probe answers of section 7).
 */
const SCOREBOARD = 'resource/ui/scoreboard.res';
const VERSUS = 'resource/ui/versusmodescoreboard.res';
const SURVIVOR_ROW = 'resource/ui/scoreboardsurvivor.res';
const FONTS = { fonts: { regular: new Uint8Array(1), bold: new Uint8Array(1) } };

const design = (patch: Partial<HudDesign>): HudDesign => ({ ...structuredClone(DEFAULT_DESIGN), elements: {}, ...patch });
const build = (d: HudDesign) => buildHud(d, FONTS);
const text = (files: { path: string; data: Uint8Array }[], path: string) => {
  const f = files.find((x) => x.path === path);
  return f ? new TextDecoder('latin1').decode(f.data) : undefined;
};
/** A file's root children as the build wrote it, or the stock file when the build left it alone. */
const tree = (files: { path: string; data: Uint8Array }[], path: string) =>
  parseKv(text(files, path) ?? baseFile('stock', path))[0].value as KvNode[];
const stockTree = (path: string) => parseKv(baseFile('stock', path))[0].value as KvNode[];
/** The block with this name and conditional, as the file has it. */
const blockOf = (nodes: KvNode[], key: string, cond?: string) => nodes.find((n) => n.key === key && n.cond === cond)!;
const kids = (c: HudDesign['children']) => design({ children: c });

describe('Tab files are read and written as the PC game reads them (pcFind)', () => {
  it('puts a backdrop colour on the 340-wide [$WIN32] BackgroundImage and leaves the [$X360] block byte for byte', () => {
    const got = tree(build(kids({ tabBoard: { BackgroundImage: { keys: { bgcolor_override: '0 0 96 200' } } } })), SCOREBOARD);
    const pc = blockOf(got, 'BackgroundImage', '[$WIN32]');
    expect(kvGet(pc, 'wide')).toBe('340');
    expect(kvGet(pc, 'bgcolor_override')).toBe('0 0 96 200');
    const console = blockOf(got, 'BackgroundImage', '[$X360]');
    expect(writeKv([console])).toBe(writeKv([blockOf(stockTree(SCOREBOARD), 'BackgroundImage', '[$X360]')]));
  });

  it('hides the PC backdrop, not the console one', () => {
    const got = tree(build(kids({ tabBoard: { BackgroundImage: { visible: false } } })), SCOREBOARD);
    expect(kvGet(blockOf(got, 'BackgroundImage', '[$WIN32]'), 'visible')).toBe('0');
    expect(writeKv([blockOf(got, 'BackgroundImage', '[$X360]')])).toBe(writeKv([blockOf(stockTree(SCOREBOARD), 'BackgroundImage', '[$X360]')]));
  });
});
