import { describe, it, expect } from 'vitest';
import { buildHud, elementRect, teamLayout, packHud } from './build';
import { DEFAULT_DESIGN, validateDesign, type HudDesign, type ElementOverride } from './design';
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

  it('scales the infected row spacing the preview shows, and only once', () => {
    const d = design({ elements: { infectedRow: { scale: 1.5 } } });
    const got = layoutOf(buildHud(d));
    // Stock HorizPanelSpacing is 140; teamLayout is the only thing that
    // applies the scale, so the file gets 210 and not 315.
    expect(teamLayout(d, elementById('infectedRow')!).spacing).toBe(210);
    expect(kvGet(kvFind(got, ['CHudZombieTeamDisplay'])!, 'HorizPanelSpacing')).toBe('210');
  });
});

/**
 * The whole point of teamLayout: one function decides a team element's
 * direction, spacing, card size and container size, the generator writes
 * exactly those numbers and elementRect reports exactly that container, so
 * the canvas cannot show a layout the downloaded file contradicts. Before
 * this, the preview drew cards at their unscaled spacing inside a scaled
 * container while the file had them scaled, which is what a player would
 * have seen the moment they resized the teammate panels.
 */
describe('team geometry: the canvas and the file agree for any scale, dir and spacing', () => {
  const fonts = { regular: new Uint8Array(1), bold: new Uint8Array(1) };
  for (const preset of ['stock', 'modern'] as const) {
    for (const dir of ['row', 'column'] as const) {
      for (const spacing of [undefined, 20, 140]) {
        for (const scale of [undefined, 0.75, 1.25]) {
          const label = `${preset} ${dir} spacing=${spacing} scale=${scale}`;
          it(label, () => {
            const o: ElementOverride = { dir };
            if (spacing !== undefined) o.spacing = spacing;
            if (scale !== undefined) o.scale = scale;
            const d = design({ preset, elements: { teamColumn: o } });
            const files = buildHud(d, { fonts });
            const t = teamLayout(d, elementById('teamColumn')!);
            const rect = elementRect(d, 'teamColumn', d.aspect);

            const team = parseKv(text(files, 'resource/ui/hud/teamdisplayhud.res')!)[0].value as KvNode[];
            for (let n = 1; n <= 4; n++) {
              const p = kvFind(team, [`TeamPlayer${n}`])!;
              const along = String(t.spacing * (n - 1));
              expect(kvGet(p, 'xpos'), `${label} TeamPlayer${n} xpos`).toBe(t.dir === 'row' ? along : '0');
              expect(kvGet(p, 'ypos'), `${label} TeamPlayer${n} ypos`).toBe(t.dir === 'row' ? '0' : along);
              expect(kvGet(p, 'wide'), `${label} TeamPlayer${n} wide`).toBe(String(Math.round(t.card!.w)));
              expect(kvGet(p, 'tall'), `${label} TeamPlayer${n} tall`).toBe(String(Math.round(t.card!.h)));
            }
            // The container the preview draws is the container the file has.
            const c = kvFind(layoutOf(files), ['CHudTeamDisplay'])!;
            expect(kvGet(c, 'wide'), `${label} container wide`).toBe(String(Math.round(rect.w)));
            expect(kvGet(c, 'tall'), `${label} container tall`).toBe(String(Math.round(rect.h)));
            // And it covers all four cards, so nothing is clipped away that
            // the canvas drew.
            expect(rect.w, `${label} covers the last card`).toBeGreaterThanOrEqual(
              t.dir === 'row' ? t.spacing * 3 + t.card!.w : t.card!.w);
            expect(rect.h, `${label} covers the last card`).toBeGreaterThanOrEqual(
              t.dir === 'column' ? t.spacing * 3 + t.card!.h : 0);
          });
        }
      }
    }
  }

  it('gives the owner sample (a) the same four cards on screen and in the file', () => {
    // The exact design sample.vpkcheck.test.ts builds, and the case that
    // used to disagree: the file had the cards 45 units apart at 188 tall in
    // a 322-tall box while the canvas drew three 31-unit cards in a 94-unit
    // box.
    const d = design({ elements: { teamColumn: { scale: 1.25, dir: 'column', spacing: 36 } } });
    expect(teamLayout(d, elementById('teamColumn')!)).toEqual({
      dir: 'column', spacing: 36, card: { w: 187.5, h: 187.5 }, container: { w: 187.5, h: 295.5 },
    });
    const t = parseKv(text(buildHud(d), 'resource/ui/hud/teamdisplayhud.res')!)[0].value as KvNode[];
    expect([1, 2, 3, 4].map((n) => kvGet(kvFind(t, [`TeamPlayer${n}`])!, 'ypos'))).toEqual(['0', '36', '72', '108']);
    expect(kvGet(kvFind(t, ['TeamPlayer1'])!, 'tall')).toBe('188');
  });

  it('leaves the container at its mock size while the generator writes no team geometry', () => {
    // Nothing in the design touches the team layout, so no file says anything
    // about it and the registry's mockSize (what the panel actually shows,
    // not its full-width container) still stands.
    expect(elementRect(design({}), 'teamColumn', '16:9')).toMatchObject({ w: 430, h: 75 });
    expect(teamLayout(design({}), elementById('teamColumn')!).container).toBeUndefined();
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

  // scalePass clones existing scheme entries, and those clones carry the base
  // face name, so fontPass has to run after it. Reversed, the panels the
  // player resized would be the only ones left on Trade Gothic.
  it('gives a scaled panel the chosen font, which only holds while scalePass runs before fontPass', () => {
    const files = buildHud(design({ font: 'roboto', elements: { teamColumn: { scale: 1.5 } } }), { fonts: ttf });
    const s = text(files, 'resource/clientscheme.res')!;
    const fonts = kvFind(parseKv(s)[0].value as KvNode[], ['Fonts'])!;
    const scaled = kvFind(fonts.value as KvNode[], ['HudEd_PlayerDisplayName_150', '1'])!;
    expect(kvGet(scaled, 'name')).toBe('Roboto Condensed');
    expect(s).not.toMatch(/Trade Gothic/);
  });

  // The chat box draws from its own scheme, which carries its own six Trade
  // Gothic faces; the spec lists chatscheme.res as an output whenever the
  // font changes for exactly this reason.
  it('moves the chat scheme to Roboto as well, and registers the font files there', () => {
    const chat = text(buildHud(design({ font: 'roboto' }), { fonts: ttf }), 'resource/chatscheme.res');
    expect(chat).toBeDefined();
    expect(chat).not.toMatch(/Trade Gothic/);
    expect(chat).toMatch(/Roboto Condensed/);
    expect(chat).toMatch(/resource\/robotocondensed-regular\.ttf/);
    expect(chat).toMatch(/resource\/robotocondensed-bold\.ttf/);
  });

  it('leaves the chat scheme out entirely when the font did not change', () => {
    expect(text(buildHud(design({})), 'resource/chatscheme.res')).toBeUndefined();
  });
});

describe('buildHud, bad numbers', () => {
  // parseFloat('') is NaN, and a NaN position comes out of formatPos as the
  // token "rNaN": a file the game cannot read, and one the canvas reads back
  // as 0, so the preview and the file disagree as well. Every control drops a
  // non-finite entry, and download() runs the design through validateDesign
  // before packing, which is the guard this pins.
  it('cannot write a literal NaN into a shipped file, whatever the design carries', () => {
    const bad = { ...design({}), elements: { chat: { x: NaN, y: 10, w: NaN, h: 60 },
      teamColumn: { scale: NaN, spacing: NaN, dir: 'column' }, infectedRow: { spacing: NaN } } };
    const files = buildHud(validateDesign(bad));
    for (const f of files) {
      expect(new TextDecoder('latin1').decode(f.data), f.path).not.toMatch(/NaN/i);
    }
    // The good values in the same override survive.
    expect(kvGet(kvFind(layoutOf(files), ['HudChat'])!, 'tall')).toBe('60');
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

describe('buildHud, styles', () => {
  const fonts = { regular: new Uint8Array(1), bold: new Uint8Array(1) };

  it('writes a new texture and points the panels at it', () => {
    const files = buildHud(design({ styles: { panelBg: { kind: 'flat', color: '0 0 0 140' } } }));
    const paths = files.map((f) => f.path);
    expect(paths).toContain('materials/vgui/hud/hudeditor/panelbg.vtf');
    expect(paths).toContain('materials/vgui/hud/hudeditor/panelbg.vmt');
    const t = parseKv(text(files, 'resource/ui/hud/teamdisplayhud.res')!)[0].value as KvNode[];
    expect(kvGet(kvFind(t, ['TeamPlayer2'])!, 'image')).toBe('hud/hudeditor/panelbg');
  });

  it('uses an uploaded image when the slot asks for one', () => {
    const rgba = new Uint8ClampedArray(32 * 32 * 4).fill(7);
    const files = buildHud(design({ styles: { panelBg: { kind: 'image' } } }), { images: { panelBg: rgba } });
    const vtf = files.find((f) => f.path.endsWith('panelbg.vtf'))!;
    expect(vtf.data.length).toBe(80 + 32 * 32 * 4);
    expect(vtf.data[80]).toBe(7);
  });

  // panelBg is the one slot with a normal-mode route (it has targets and is
  // not advancedOnly), so it is the only slot that can prove the rule. An
  // advancedOnly slot is skipped outright in normal mode and would pass this
  // by emitting no materials at all.
  it('never writes a stock texture name in normal mode', () => {
    const files = buildHud(design({ styles: { panelBg: { kind: 'flat', color: '0 0 0 140' } } }));
    const materials = files.filter((f) => f.path.startsWith('materials/'));
    expect(materials.length).toBeGreaterThan(0);
    for (const f of materials) expect(f.path, f.path).toMatch(/^materials\/vgui\/hud\/hudeditor\//);
  });

  it('writes stock names in advanced mode', () => {
    const files = buildHud(design({ advanced: true, styles: { barGreen: { kind: 'flat', color: '0 255 0 255' } } }));
    expect(files.map((f) => f.path)).toEqual(expect.arrayContaining(
      ['materials/vgui/healthbar_green.vtf', 'materials/vgui/healthbar_green.vmt']));
  });

  it('keeps every path lower case', () => {
    const files = buildHud(design({ preset: 'modern', advanced: true,
      styles: { incapPanel: { kind: 'flat' }, panelBg: { kind: 'rounded' } } }), { fonts });
    for (const f of files) expect(f.path).toBe(f.path.toLowerCase());
  });
});

describe('packHud', () => {
  it('gives normal mode a VPK v1 named after the design', () => {
    const p = packHud(design({ name: 'night hud' }));
    expect(p.filename).toBe('night hud.vpk');
    const dv = new DataView(p.bytes.buffer);
    expect(dv.getUint32(0, true)).toBe(0x55AA1234);
    expect(dv.getUint32(4, true)).toBe(1);
  });

  it('gives advanced mode a zip holding the mount folder and a README', () => {
    const p = packHud(design({ name: 'night hud', advanced: true }));
    expect(p.filename).toBe('night hud.zip');
    const s = new TextDecoder('latin1').decode(p.bytes);
    expect(s).toContain('riversidehud/pak01_dir.vpk');
    expect(s).toContain('README.txt');
    expect(s).toContain('Game\triversidehud');
  });
});
