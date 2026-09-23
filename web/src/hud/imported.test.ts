import { describe, it, expect, afterEach } from 'vitest';
import { baseFile, baseOf, registerImport, unregisterImport, hasImport, MissingImportError } from './base';
import { baseTeam, validateDesign, decodeShare, encodeShare } from './design';
import { buildTrees, baseHasChild, buildHud, cardChild, baseHasElement, importedHasXhair } from './build';
import { parseKv, writeKv, kvFind, kvSet, type KvNode } from './kv';
import { drawHud, visibleElements } from './mock';
import { elementById } from './elements';
import { decodeText } from './text';
import { sampleHud, latin1, MARKER_PANEL, dropBlock, recordingCtx } from './importFixtures';

const A = 'a'.repeat(64);
const B = 'b'.repeat(64);
/**
 * An id is its files' content hash, so the base caches (baseTree, baseTeam)
 * keep what they read for an id for ever. A test that registers different
 * files must use an id no other test registers other files under, or it
 * reads a stale cache and passes or fails by test order.
 */
const LACKING = 'c'.repeat(64);
const NO_CARD = 'd'.repeat(64);
const PLAIN = 'e'.repeat(64);
const WITH_XHAIR = 'f'.repeat(64);
afterEach(() => { for (const id of [A, B, LACKING, NO_CARD, PLAIN, WITH_XHAIR]) unregisterImport(id); });

const TEAM = 'resource/ui/hud/teamdisplayhud.res';
/** The stock team file with TeamPlayer2 moved down: a column, not a row. */
const columnTeam = () => {
  const t = parseKv(baseFile('stock', TEAM));
  kvSet(kvFind(t[0].value as KvNode[], ['TeamPlayer2'])!, 'ypos', '99');
  return writeKv(t);
};

describe('the imported layer', () => {
  it("reads the upload's copy of a file, whatever case the editor asks in, and the stock file where the upload has none", () => {
    registerImport(A, sampleHud());
    expect(baseFile(`imported:${A}`, 'scripts/hudlayout.res')).toContain(MARKER_PANEL);
    expect(baseFile(`imported:${A}`, 'Scripts/HudLayout.res')).toContain(MARKER_PANEL);
    expect(baseFile(`imported:${A}`, 'resource/ui/basechat.res')).toBe(baseFile('stock', 'resource/ui/basechat.res'));
  });

  it('fails with MissingImportError, never with stock, when the HUD is not loaded in this browser', () => {
    expect(hasImport(A)).toBe(false);
    expect(() => baseFile(`imported:${A}`, 'scripts/hudlayout.res')).toThrow(MissingImportError);
  });

  it('strips a UTF-8 byte order mark before the editor parses a file', () => {
    const text = baseFile('stock', TEAM);
    registerImport(A, sampleHud({ [TEAM]: new Uint8Array([0xef, 0xbb, 0xbf, ...latin1(text)]) }));
    expect(baseFile(`imported:${A}`, TEAM)).toBe(text);
  });

  it('keys the base team on the import, so two imports never share it', () => {
    registerImport(A, sampleHud());
    registerImport(B, sampleHud({ [TEAM]: columnTeam() }));
    expect(baseTeam(`imported:${A}`).dir).toBe('row');
    expect(baseTeam(`imported:${B}`).dir).toBe('column');
    expect(baseTeam('stock').dir).toBe('row');
  });

  it("asks the import's own card file whether a child is there", () => {
    registerImport(A, sampleHud({ 'resource/ui/hud/teammatepanel.res': baseFile('modern', 'resource/ui/hud/teammatepanel.res') }));
    expect(baseHasChild('stock', 'HealthNumber')).toBe(false);
    expect(baseHasChild(`imported:${A}`, 'HealthNumber')).toBe(true);
  });

  it("builds an imported design's trees from the upload, and a stock design's from stock", () => {
    registerImport(A, sampleHud());
    const d = validateDesign({ v: 1, preset: 'imported', imported: { id: A, name: 'edgehud' }, crosshair: 'none' });
    expect(baseOf(d)).toBe(`imported:${A}`);
    expect(kvFind(buildTrees(d)('scripts/hudlayout.res'), [MARKER_PANEL])).toBeDefined();
    expect(kvFind(buildTrees(validateDesign({ v: 1, preset: 'stock' }))('scripts/hudlayout.res'), [MARKER_PANEL])).toBeUndefined();
  });
});

describe('validateDesign on an imported design', () => {
  it('keeps the HUD reference with a safe name, and the HUD keeps its own fonts', () => {
    const d = validateDesign({ v: 1, preset: 'imported', imported: { id: A, name: 'edge<hud>' }, font: 'roboto' });
    expect(d.preset).toBe('imported');
    expect(d.imported).toEqual({ id: A, name: 'edgehud' });
    expect(d.font).toBe('preset');
  });

  it('turns an imported design with no usable reference into Stock, and drops a reference from any other preset', () => {
    expect(validateDesign({ v: 1, preset: 'imported', imported: { id: 'nope', name: 'x' } }).preset).toBe('stock');
    expect(validateDesign({ v: 1, preset: 'imported', imported: { id: A.toUpperCase(), name: 'x' } }).preset).toBe('stock');
    expect(validateDesign({ v: 1, preset: 'imported' }).imported).toBeUndefined();
    expect(validateDesign({ v: 1, preset: 'modern', imported: { id: A, name: 'x' } }).imported).toBeUndefined();
  });

  it('validates a design whose HUD is not loaded without touching its files, dropping the legacy spacing', () => {
    const d = validateDesign({ v: 1, preset: 'imported', imported: { id: A, name: 'e' }, elements: { teamColumn: { spacing: 140, scale: 1.2 } } });
    expect(d.elements.teamColumn).toEqual({ scale: 1.2 });
  });

  it('carries the reference, not the files, through a share link', async () => {
    const d = validateDesign({ v: 1, preset: 'imported', imported: { id: A, name: 'edgehud' } });
    const back = await decodeShare(await encodeShare(d));
    expect(back?.preset).toBe('imported');
    expect(back?.imported).toEqual({ id: A, name: 'edgehud' });
  });
});

describe('an imported HUD that lacks a panel or a child', () => {
  const lacking = () => sampleHud({
    'scripts/hudlayout.res': dropBlock(decodeText(sampleHud().get('scripts/hudlayout.res')!).text, 'HudPZDamageRecord'),
    'resource/ui/hud/teammatepanel.res': dropBlock(baseFile('stock', 'resource/ui/hud/teammatepanel.res'), 'Items'),
  });
  const design = (extra: Record<string, unknown> = {}) => {
    registerImport(LACKING, lacking());
    return validateDesign({ v: 1, preset: 'imported', imported: { id: LACKING, name: 'e' }, crosshair: 'none', ...extra });
  };

  it('offers no element the layout lacks, and still offers it on stock', () => {
    const d = design();
    expect(visibleElements('survivor', d).map((e) => e.id)).not.toContain('killNotices');
    expect(visibleElements('survivor', validateDesign({ v: 1, preset: 'stock' })).map((e) => e.id)).toContain('killNotices');
    expect(baseHasElement(`imported:${LACKING}`, elementById('killNotices')!)).toBe(false);
  });

  it('offers no teammate child the card file lacks', () => {
    expect(cardChild(design(), 'Items')).toBeNull();
    expect(cardChild(design(), 'Name')).not.toBeNull();
  });

  it('drops the teammates when the team file lacks a card', () => {
    registerImport(NO_CARD, sampleHud({ [TEAM]: dropBlock(baseFile('stock', TEAM), 'TeamPlayer4') }));
    expect(baseHasElement(`imported:${NO_CARD}`, elementById('teamColumn')!)).toBe(false);
  });

  it('builds a design that still carries edits for them, leaving them out, without throwing', () => {
    const d = design({ elements: { killNotices: { visible: false, x: 40 } }, children: { teamColumn: { Items: { x: 40 } } } });
    const out = new Map(buildHud(d).map((f) => [f.path, f.data]));
    const tree = (p: string) => parseKv(decodeText(out.get(p)!).text)[0].value as KvNode[];
    expect(kvFind(tree('scripts/hudlayout.res'), ['HudPZDamageRecord'])).toBeUndefined();
    // Nothing landed in the card file, so it goes out as the upload had it.
    expect(out.get('resource/ui/hud/teammatepanel.res')).toEqual(lacking().get('resource/ui/hud/teammatepanel.res'));
  });

  it('draws both sides without throwing', () => {
    const d = design();
    const { ctx } = recordingCtx();
    expect(() => drawHud(ctx, 853, 480, d, 'survivor', null)).not.toThrow();
    expect(() => drawHud(ctx, 853, 480, d, 'infected', null)).not.toThrow();
  });
});

describe('importedHasXhair', () => {
  it("says whether the upload's own layout has an xHair element", () => {
    registerImport(PLAIN, sampleHud());
    const withX = decodeText(sampleHud().get('scripts/hudlayout.res')!).text.replace(/\}\s*$/, '\t"xHair"\r\n\t{\r\n\t\t"fieldName" "xHair"\r\n\t}\r\n}\r\n');
    registerImport(WITH_XHAIR, sampleHud({ 'scripts/hudlayout.res': withX }));
    expect(importedHasXhair(`imported:${PLAIN}`)).toBe(false);
    expect(importedHasXhair(`imported:${WITH_XHAIR}`)).toBe(true);
  });
});
