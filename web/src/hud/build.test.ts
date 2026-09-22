import { describe, it, expect } from 'vitest';
import { buildHud, elementRect, teamLayout } from './build';
import { DEFAULT_DESIGN, type HudDesign } from './design';
import { parseKv, kvFind, kvGet, type KvNode } from './kv';
import { baseFile } from './base';
import { elementById } from './elements';

const text = (files: { path: string; data: Uint8Array }[], path: string) => {
  const f = files.find((x) => x.path === path);
  return f ? new TextDecoder('latin1').decode(f.data) : undefined;
};
const layoutOf = (files: { path: string; data: Uint8Array }[]) =>
  parseKv(text(files, 'scripts/hudlayout.res')!)[0].value as KvNode[];
const design = (patch: Partial<HudDesign>): HudDesign => ({ ...structuredClone(DEFAULT_DESIGN), ...patch });

describe('buildHud, layout', () => {
  it('ships stock hudlayout plus the xHair element for an empty design', () => {
    const files = buildHud(design({}));
    const got = layoutOf(files);
    const stock = parseKv(baseFile('stock', 'scripts/hudlayout.res'))[0].value as KvNode[];
    expect(got.filter((n) => n.key !== 'xHair')).toEqual(stock);
    const x = kvFind(got, ['xHair'])!;
    expect(kvGet(x, 'image')).toBe('hud/altcrosshair');
    expect(kvGet(x, 'xpos')).toBe('c-13');
    expect(files.map((f) => f.path)).toContain('addoninfo.txt');
  });

  it('leaves xHair out when the player has no crosshair addon', () => {
    expect(kvFind(layoutOf(buildHud(design({ xhair: false }))), ['xHair'])).toBeUndefined();
  });

  it('does not duplicate xHair on the modern preset, which already has it', () => {
    const got = layoutOf(buildHud(design({ preset: 'modern' }), { fonts: { regular: new Uint8Array(1), bold: new Uint8Array(1) } }));
    expect(got.filter((n) => n.key.toLowerCase() === 'xhair').length).toBe(1);
  });

  it('moves one element and nothing else', () => {
    const got = layoutOf(buildHud(design({ elements: { ownHealth: { x: 8, y: 400 } } })));
    const p = kvFind(got, ['CHudLocalPlayerDisplay'])!;
    expect(kvGet(p, 'xpos')).toBe('8');
    expect(kvGet(p, 'ypos')).toBe('r80');
    expect(kvGet(p, 'wide')).toBe('150');
    const other = kvFind(got, ['HudWeaponSelection'])!;
    expect(kvGet(other, 'xpos')).toBe('r98');
  });

  it('hides an element', () => {
    const got = layoutOf(buildHud(design({ elements: { killFeed: { visible: false } } })));
    expect(kvGet(kvFind(got, ['HudDeathNotice'])!, 'visible')).toBe('0');
  });

  it('ignores a move on an element that cannot move', () => {
    const got = layoutOf(buildHud(design({ elements: { targetId: { x: 5, y: 5 } } })));
    expect(kvGet(kvFind(got, ['TargetID'])!, 'xpos')).toBe('c-320');
  });

  it('free-resizes chat and rewrites the three chat animations', () => {
    const files = buildHud(design({ elements: { chat: { x: 134, y: 320, w: 280, h: 100 } } }));
    const c = kvFind(layoutOf(files), ['HudChat'])!;
    expect(kvGet(c, 'xpos')).toBe('134');
    expect(kvGet(c, 'ypos')).toBe('r160');
    expect(kvGet(c, 'wide')).toBe('280');
    const anim = text(files, 'scripts/hudanimations.txt')!;
    const hits = anim.match(/Animate\s+HudChat\s+Position\s+"134 r160"/g) ?? [];
    expect(hits.length).toBe(3);
  });

  it('does not ship hudanimations when chat has not moved', () => {
    expect(text(buildHud(design({})), 'scripts/hudanimations.txt')).toBeUndefined();
  });

  it('ships every file the modern preset overrides even when nothing is edited', () => {
    const paths = buildHud(design({ preset: 'modern' }), { fonts: { regular: new Uint8Array(1), bold: new Uint8Array(1) } }).map((f) => f.path);
    expect(paths).toContain('resource/ui/hud/teammatepanel.res');
    expect(paths).toContain('scripts/hudanimations.txt');
  });

  it('never ships a crosshair image', () => {
    for (const preset of ['stock', 'modern'] as const) {
      expect(buildHud(design({ preset }), { fonts: { regular: new Uint8Array(1), bold: new Uint8Array(1) } }).some((f) => f.path.includes('altcrosshair'))).toBe(false);
    }
  });

  it('anchors a team display by what it shows, not by its full-width container', () => {
    const got = layoutOf(buildHud(design({ elements: { teamColumn: { x: 8, y: 332 } } })));
    expect(kvGet(kvFind(got, ['CHudTeamDisplay'])!, 'xpos')).toBe('8');
  });
});

describe('elementRect', () => {
  it('reads the base position at the asked aspect', () => {
    expect(elementRect(design({}), 'ownHealth', '16:9')).toMatchObject({ x: 728, y: 389, visible: true });
    expect(elementRect(design({}), 'ownHealth', '4:3')).toMatchObject({ x: 515, y: 389 });
  });
  it('re-projects a moved element through its anchor', () => {
    const d = design({ aspect: '16:9', elements: { ownHealth: { x: 728, y: 389 } } });
    expect(elementRect(d, 'ownHealth', '4:3').x).toBe(515);
  });
});

describe('buildHud, scale', () => {
  const scheme = (files: { path: string; data: Uint8Array }[]) =>
    parseKv(text(files, 'resource/clientscheme.res')!)[0].value as KvNode[];

  it('multiplies the container and every child, and points children at scaled fonts', () => {
    const files = buildHud(design({ elements: { teamColumn: { scale: 1.5 } } }));
    const stockPanel = parseKv(baseFile('stock', 'resource/ui/hud/teammatepanel.res'))[0].value as KvNode[];
    const gotPanel = parseKv(text(files, 'resource/ui/hud/teammatepanel.res')!)[0].value as KvNode[];
    const named = stockPanel.find((n) => typeof n.value !== 'string' && kvGet(n, 'font') === 'PlayerDisplayName')!;
    const after = kvFind(gotPanel, [named.key])!;
    expect(kvGet(after, 'wide')).toBe(String(Math.round(parseFloat(kvGet(named, 'wide')!) * 1.5)));
    expect(kvGet(after, 'font')).toBe('HudEd_PlayerDisplayName_150');

    const fonts = kvFind(scheme(files), ['Fonts'])!;
    const stockFont = kvFind(parseKv(baseFile('stock', 'resource/clientscheme.res'))[0].value as KvNode[], ['Fonts', 'PlayerDisplayName', '1'])!;
    const scaled = kvFind(fonts.value as KvNode[], ['HudEd_PlayerDisplayName_150', '1'])!;
    expect(kvGet(scaled, 'tall')).toBe(String(Math.round(parseFloat(kvGet(stockFont, 'tall')!) * 1.5)));
    expect(kvGet(scaled, 'name')).toBe(kvGet(stockFont, 'name'));
  });

  it('writes nothing extra at scale 1', () => {
    const paths = buildHud(design({ elements: { teamColumn: { scale: 1 } } })).map((f) => f.path);
    expect(paths).not.toContain('resource/clientscheme.res');
  });

  it('scales all six infected health files together', () => {
    const paths = buildHud(design({ elements: { siHealth: { scale: 1.2 } } })).map((f) => f.path);
    for (const n of ['boomerhealth', 'hunterhealth', 'smokerhealth', 'tankhealth', 'zombiehealthleft_large', 'zombiehealthleft_small']) {
      expect(paths).toContain(`resource/ui/hud/${n}.res`);
    }
  });
});

describe('buildHud, team layout', () => {
  const team = (files: { path: string; data: Uint8Array }[]) =>
    parseKv(text(files, 'resource/ui/hud/teamdisplayhud.res')!)[0].value as KvNode[];

  it('stacks the survivor team as a column', () => {
    const t = team(buildHud(design({ elements: { teamColumn: { dir: 'column', spacing: 34 } } })));
    expect([1, 2, 3, 4].map((n) => [kvGet(kvFind(t, [`TeamPlayer${n}`])!, 'xpos'), kvGet(kvFind(t, [`TeamPlayer${n}`])!, 'ypos')]))
      .toEqual([['0', '0'], ['0', '34'], ['0', '68'], ['0', '102']]);
  });

  it('lays it out as a row', () => {
    const t = team(buildHud(design({ elements: { teamColumn: { dir: 'row', spacing: 140 } } })));
    expect(kvGet(kvFind(t, ['TeamPlayer3'])!, 'xpos')).toBe('280');
    expect(kvGet(kvFind(t, ['TeamPlayer3'])!, 'ypos')).toBe('0');
  });

  it('grows the container so a column is not clipped', () => {
    const got = layoutOf(buildHud(design({ elements: { teamColumn: { dir: 'column', spacing: 40 } } })));
    expect(parseFloat(kvGet(kvFind(got, ['CHudTeamDisplay'])!, 'tall')!)).toBeGreaterThanOrEqual(4 * 40);
  });

  it('sets infected spacing in hudlayout', () => {
    const got = layoutOf(buildHud(design({ elements: { infectedRow: { spacing: 124 } } })));
    expect(kvGet(kvFind(got, ['CHudZombieTeamDisplay'])!, 'HorizPanelSpacing')).toBe('124');
  });
});

describe('buildHud, fonts', () => {
  const ttf = { regular: new Uint8Array([1, 2, 3]), bold: new Uint8Array([4, 5, 6]) };

  it('switches every Trade Gothic face to Roboto and ships both files', () => {
    const files = buildHud(design({ font: 'roboto' }), { fonts: ttf });
    const s = text(files, 'resource/clientscheme.res')!;
    expect(s).not.toMatch(/Trade Gothic/);
    expect(s).toMatch(/Roboto Condensed/);
    expect(s).toMatch(/resource\/robotocondensed-regular\.ttf/i);
    expect(files.map((f) => f.path)).toEqual(expect.arrayContaining(
      ['resource/robotocondensed-regular.ttf', 'resource/robotocondensed-bold.ttf']));
  });

  it('ships the fonts for the modern preset, whose scheme already names them', () => {
    const paths = buildHud(design({ preset: 'modern' }), { fonts: ttf }).map((f) => f.path);
    expect(paths).toContain('resource/robotocondensed-bold.ttf');
  });

  it('fails clearly when Roboto is needed and was not loaded', () => {
    expect(() => buildHud(design({ font: 'roboto' }))).toThrow(/font/i);
  });
});

describe('teamLayout, real base-file defaults', () => {
  it('reads the modern preset real spacing when nothing is overridden', () => {
    // Verified directly against the base files: modern's teamdisplayhud.res
    // lays TeamPlayer1/TeamPlayer2 out 34 units apart in ypos (a column),
    // and its hudlayout.res sets CHudZombieTeamDisplay's HorizPanelSpacing
    // to 124, neither of which is the row/column fallback constant.
    const d = design({ preset: 'modern' });
    expect(teamLayout(d, elementById('teamColumn')!)).toEqual({ dir: 'column', spacing: 34 });
    expect(teamLayout(d, elementById('infectedRow')!)).toEqual({ dir: 'row', spacing: 124 });
  });

  it('reads the stock preset real spacing, not a hardcoded constant', () => {
    const teamFile = parseKv(baseFile('stock', 'resource/ui/hud/teamdisplayhud.res'))[0].value as KvNode[];
    const p1 = kvFind(teamFile, ['TeamPlayer1'])!, p2 = kvFind(teamFile, ['TeamPlayer2'])!;
    const rowGap = Math.abs(parseFloat(kvGet(p2, 'xpos')!) - parseFloat(kvGet(p1, 'xpos')!));
    const layout = parseKv(baseFile('stock', 'scripts/hudlayout.res'))[0].value as KvNode[];
    const zombieGap = parseFloat(kvGet(kvFind(layout, ['CHudZombieTeamDisplay'])!, 'HorizPanelSpacing')!);

    const d = design({});
    expect(teamLayout(d, elementById('teamColumn')!)).toEqual({ dir: 'row', spacing: rowGap });
    expect(teamLayout(d, elementById('infectedRow')!)).toEqual({ dir: 'row', spacing: zombieGap });
  });
});
