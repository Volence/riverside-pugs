import { describe, it, expect } from 'vitest';
import { buildHud, elementRect, teamLayout, packHud, buildTrees, cardChild, baseHasChild, teamCardRects, isFreeTeam, growBack, keepOnScreen, cardFrame } from './build';
import { parsePos, screenW } from './units';
import { DEFAULT_DESIGN, validateDesign, type HudDesign, type ElementOverride } from './design';
import { parseKv, kvFind, kvGet, kvSet, type KvNode } from './kv';
import { baseFile } from './base';
import { elementById } from './elements';
import { PANEL_FILE, childRects } from './render';

const text = (files: { path: string; data: Uint8Array }[], path: string) => {
  const f = files.find((x) => x.path === path);
  return f ? new TextDecoder('latin1').decode(f.data) : undefined;
};
const layoutOf = (files: { path: string; data: Uint8Array }[]) =>
  parseKv(text(files, 'scripts/hudlayout.res')!)[0].value as KvNode[];
/** An untouched design: no element overrides, not even DEFAULT_DESIGN's fitted teammate card, which has its own tests. */
const design = (patch: Partial<HudDesign>): HudDesign => ({ ...structuredClone(DEFAULT_DESIGN), elements: {}, ...patch });
const CARD_FILE = 'resource/ui/hud/teammatepanel.res';
const TEAM_FILE = 'resource/ui/hud/teamdisplayhud.res';
const SCHEME_FILE = 'resource/clientscheme.res';
/** A file's root children as the build wrote it, or the base file when the build left it alone (as the game would read it). */
const tree = (files: { path: string; data: Uint8Array }[], path: string, preset: 'stock' | 'modern' = 'stock') =>
  parseKv(text(files, path) ?? baseFile(preset, path))[0].value as KvNode[];
const cardAt = (nodes: KvNode[], name: string) => ['xpos', 'ypos', 'wide', 'tall'].map((k) => kvGet(kvFind(nodes, [name])!, k));

describe('buildHud, childPass', () => {
  const kids = (c: Record<string, unknown>) => ({ teamColumn: c }) as HudDesign['children'];

  it('writes only the overridden keys', () => {
    const got = tree(buildHud(design({ children: kids({ Name: { x: 20 } }) })), CARD_FILE);
    const expected = parseKv(baseFile('stock', CARD_FILE))[0].value as KvNode[];
    kvSet(kvFind(expected, ['Name'])!, 'xpos', '20');
    expect(got).toEqual(expected);
  });

  it('hides a child', () => {
    const got = tree(buildHud(design({ children: kids({ Head: { visible: false } }) })), CARD_FILE);
    expect(kvGet(kvFind(got, ['Head'])!, 'visible')).toBe('0');
  });

  it('adds the health number after Name on stock, and removes it on Modern', () => {
    const stock = tree(buildHud(design({ children: kids({ HealthNumber: { on: true } }) })), CARD_FILE);
    const at = stock.findIndex((n) => n.key === 'HealthNumber');
    expect(stock[at - 1].key).toBe('Name');
    expect(cardAt(stock, 'HealthNumber')).toEqual(['103', '60', '30', '12']);
    expect(kvGet(stock[at], 'labelText')).toBe('%HealthNumber%');

    const fonts = { regular: new Uint8Array(1), bold: new Uint8Array(1) };
    const modern = tree(buildHud(design({ preset: 'modern', children: kids({ HealthNumber: { on: false } }) }), { fonts }), CARD_FILE, 'modern');
    expect(kvFind(modern, ['HealthNumber'])).toBeUndefined();
  });

  it('ignores edits to an addable child that is off in this preset', () => {
    const files = buildHud(design({ children: kids({ HealthNumber: { x: 5 } }) }));
    expect(kvFind(tree(files, CARD_FILE), ['HealthNumber'])).toBeUndefined();
  });

  it('writes a label colour raw', () => {
    const got = tree(buildHud(design({ children: kids({ Name: { color: '10 20 30 255' } }) })), CARD_FILE);
    expect(kvGet(kvFind(got, ['Name'])!, 'fgcolor_override')).toBe('10 20 30 255');
  });

  it('points a sized label at a HudEd_<font>_t<size> copy of its font', () => {
    const files = buildHud(design({ children: kids({ Name: { fontSize: 14 } }) }));
    expect(kvGet(kvFind(tree(files, CARD_FILE), ['Name'])!, 'font')).toBe('HudEd_PlayerDisplayName_t14');
    const copy = kvFind(tree(files, SCHEME_FILE), ['Fonts', 'HudEd_PlayerDisplayName_t14', '1'])!;
    expect(kvGet(copy, 'tall')).toBe('14');
    // Other labels on the same font keep the original.
    expect(kvGet(kvFind(tree(files, CARD_FILE), ['Status'])!, 'font')).toBe('PlayerDisplayName');
  });

  it('sizes the item icons by their font and grows the label with them', () => {
    const files = buildHud(design({ children: kids({ Items: { fontSize: 22 } }) }));
    const items = kvFind(tree(files, CARD_FILE), ['Items'])!;
    expect(kvGet(items, 'font')).toBe('HudEd_L4D_Icons_medium_t22');
    expect(kvGet(items, 'tall')).toBe('22');
  });

  it('widens the item icon row with the icon size, so the icons are not cut off on the right', () => {
    // Stock Items is 50 wide at an 18-tall font: at 36 it is 50 * 36 / 18 = 100 wide.
    const items = kvFind(tree(buildHud(design({ children: kids({ Items: { fontSize: 36 } }) })), CARD_FILE), ['Items'])!;
    expect([kvGet(items, 'wide'), kvGet(items, 'tall')]).toEqual(['100', '36']);
    // Modern: 50 wide at a 16-tall font, 20 gives 63 (62.5 rounded).
    const fonts = { regular: new Uint8Array(1), bold: new Uint8Array(1) };
    const modern = kvFind(tree(buildHud(design({ preset: 'modern', children: kids({ Items: { fontSize: 20 } }) }), { fonts }), CARD_FILE, 'modern'), ['Items'])!;
    expect([kvGet(modern, 'wide'), kvGet(modern, 'tall')]).toEqual(['63', '20']);
  });

  // childPass writes unscaled numbers before scalePass, which multiplies them with the rest of the file.
  it('lets the element scale multiply the edited values', () => {
    const files = buildHud(design({ elements: { teamColumn: { scale: 1.5 } }, children: kids({ Name: { x: 20, fontSize: 14 } }) }));
    const name = kvFind(tree(files, CARD_FILE), ['Name'])!;
    expect(kvGet(name, 'xpos')).toBe('30');
    // scalePass collects the t14 leaf like any other font and clones it again.
    expect(kvGet(name, 'font')).toBe('HudEd_HudEd_PlayerDisplayName_t14_150');
    const copy = kvFind(tree(files, SCHEME_FILE), ['Fonts', 'HudEd_HudEd_PlayerDisplayName_t14_150', '1'])!;
    expect(kvGet(copy, 'tall')).toBe(String(Math.round(14 * 1.5)));
  });

  // The `t` in the tag: without it a size-60 label and a 0.60 scale on the same font would share one key.
  it('keeps a size-60 label and a 0.60 scale on the same font apart', () => {
    const files = buildHud(design({ elements: { teamColumn: { scale: 0.6 } }, children: kids({ Name: { fontSize: 60 } }) }));
    const fonts = kvFind(tree(files, SCHEME_FILE), ['Fonts'])!.value as KvNode[];
    expect(kvGet(kvFind(fonts, ['HudEd_PlayerDisplayName_60', '1'])!, 'tall')).toBe(String(Math.round(12 * 0.6)));
    expect(kvGet(kvFind(fonts, ['HudEd_HudEd_PlayerDisplayName_t60_60', '1'])!, 'tall')).toBe('36');
  });

  // childPass and fontPass are order independent: fontPass renames every face in the scheme, copies included.
  it('gives a sized label the chosen font', () => {
    const files = buildHud(design({ font: 'roboto', children: kids({ Name: { fontSize: 14 } }) }),
      { fonts: { regular: new Uint8Array(1), bold: new Uint8Array(1) } });
    const copy = kvFind(tree(files, SCHEME_FILE), ['Fonts', 'HudEd_PlayerDisplayName_t14', '1'])!;
    expect(kvGet(copy, 'name')).toBe('Roboto Condensed');
  });

  it('fails naming the file and child for an edit the child cannot take', () => {
    // validateDesign strips these; this is the guard for a design that skipped it.
    expect(() => buildHud(design({ children: kids({ HealthNumber: { on: true, color: '1 2 3 255' } }) })))
      .toThrow(/teammatepanel\.res: HealthNumber takes no colour/);
    expect(() => buildHud(design({ children: kids({ Head: { fontSize: 20 } }) })))
      .toThrow(/teammatepanel\.res: Head takes no text size/);
    expect(() => buildHud(design({ children: kids({ Nope: { x: 1 } }) })))
      .toThrow(/teammatepanel\.res: Nope is not an editable child/);
    // D2: a wrong-kind edit fails the same way for size and position.
    expect(() => buildHud(design({ children: kids({ BackgroundImage: { w: 10, h: 10 } }) })))
      .toThrow(/teammatepanel\.res: BackgroundImage takes no size/);
    expect(() => buildHud(design({ children: kids({ BackgroundImage: { x: 1, y: 1 } }) })))
      .toThrow(/teammatepanel\.res: BackgroundImage cannot move/);
  });
});

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

  // Probe T2: never_draw on HudCrosshair hides the engine crosshair for both teams.
  it('writes never_draw on HudCrosshair only when the player hides the game crosshair', () => {
    const fonts = { regular: new Uint8Array(1), bold: new Uint8Array(1) };
    for (const preset of ['stock', 'modern'] as const) {
      const on = kvFind(layoutOf(buildHud(design({ preset, hideGameCrosshair: true }), { fonts })), ['HudCrosshair'])!;
      expect(kvGet(on, 'never_draw'), preset).toBe('1');
      const off = kvFind(layoutOf(buildHud(design({ preset }), { fonts })), ['HudCrosshair'])!;
      expect(kvGet(off, 'never_draw'), preset).toBeUndefined();
    }
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
    const got = layoutOf(buildHud(design({ elements: { targetId: { visible: false } } })));
    expect(kvGet(kvFind(got, ['TargetID'])!, 'visible')).toBe('0');
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

  it('scales the five infected health files the game reads, and never writes tankhealth.res', () => {
    const paths = buildHud(design({ elements: { siHealth: { scale: 1.2 } } })).map((f) => f.path);
    for (const n of ['boomerhealth', 'hunterhealth', 'smokerhealth', 'zombiehealthleft_large', 'zombiehealthleft_small']) {
      expect(paths).toContain(`resource/ui/hud/${n}.res`);
    }
    expect(paths).not.toContain('resource/ui/hud/tankhealth.res');
  });
});

describe('buildHud, team layout', () => {
  const team = (files: { path: string; data: Uint8Array }[]) =>
    parseKv(text(files, 'resource/ui/hud/teamdisplayhud.res')!)[0].value as KvNode[];

  it('stacks the survivor team as a column', () => {
    const t = team(buildHud(design({ elements: { teamColumn: { dir: 'column', gap: 0 } } })));
    expect([1, 2, 3, 4].map((n) => [kvGet(kvFind(t, [`TeamPlayer${n}`])!, 'xpos'), kvGet(kvFind(t, [`TeamPlayer${n}`])!, 'ypos')]))
      .toEqual([['0', '0'], ['0', '150'], ['0', '300'], ['0', '450']]);
  });

  it('lays it out as a row', () => {
    const t = team(buildHud(design({ elements: { teamColumn: { dir: 'row' } } })));
    expect(kvGet(kvFind(t, ['TeamPlayer3'])!, 'xpos')).toBe('280');
    expect(kvGet(kvFind(t, ['TeamPlayer3'])!, 'ypos')).toBe('0');
  });

  it('grows the container so a column is not clipped', () => {
    const got = layoutOf(buildHud(design({ elements: { teamColumn: { dir: 'column', gap: 10 } } })));
    expect(parseFloat(kvGet(kvFind(got, ['CHudTeamDisplay'])!, 'tall')!)).toBeGreaterThanOrEqual(3 * 160 + 150);
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
 * direction, pitch, card, offset and container, the generator writes exactly
 * those numbers and elementRect reports exactly that container, so the
 * canvas cannot show a layout the downloaded file contradicts.
 */
describe('team geometry: the canvas and the file agree for any scale, dir, gap and fit', () => {
  const fonts = { regular: new Uint8Array(1), bold: new Uint8Array(1) };
  for (const preset of ['stock', 'modern'] as const) {
    for (const dir of ['row', 'column'] as const) {
      for (const gap of [undefined, 0, 20]) {
        for (const scale of [undefined, 0.75, 1.25]) {
          for (const fit of [false, true]) {
            const label = `${preset} ${dir} gap=${gap} scale=${scale} fit=${fit}`;
            it(label, () => {
              const o: ElementOverride = { dir };
              if (gap !== undefined) o.gap = gap;
              if (scale !== undefined) o.scale = scale;
              if (fit) o.fit = true;
              const d = design({ preset, elements: { teamColumn: o } });
              const files = buildHud(d, { fonts });
              const t = teamLayout(d, elementById('teamColumn')!);
              const rect = elementRect(d, 'teamColumn', d.aspect);
              // The pitch is one card plus the gap, both scaled.
              expect(t.spacing, label).toBe(Math.round((t.dir === 'row' ? t.card!.w : t.card!.h) + t.gap! * (scale ?? 1)));
              const team = tree(files, TEAM_FILE, preset);
              for (let n = 1; n <= 4; n++) {
                const p = kvFind(team, [`TeamPlayer${n}`])!;
                const along = t.spacing * (n - 1);
                expect(kvGet(p, 'xpos'), `${label} TeamPlayer${n} xpos`).toBe(String(t.offset!.x + (t.dir === 'row' ? along : 0)));
                expect(kvGet(p, 'ypos'), `${label} TeamPlayer${n} ypos`).toBe(String(t.offset!.y + (t.dir === 'row' ? 0 : along)));
                expect(t.cards![n - 1], `${label} TeamPlayer${n} tokens`).toEqual({ xpos: kvGet(p, 'xpos'), ypos: kvGet(p, 'ypos') });
                expect(kvGet(p, 'wide'), `${label} TeamPlayer${n} wide`).toBe(String(Math.round(t.card!.w)));
                expect(kvGet(p, 'tall'), `${label} TeamPlayer${n} tall`).toBe(String(Math.round(t.card!.h)));
              }
              // The container the preview draws is the container the file has, where the file puts it.
              const c = kvFind(layoutOf(files), ['CHudTeamDisplay'])!;
              expect(kvGet(c, 'wide'), `${label} container wide`).toBe(String(Math.round(rect.w)));
              expect(kvGet(c, 'tall'), `${label} container tall`).toBe(String(Math.round(rect.h)));
              expect(parsePos(kvGet(c, 'xpos')!, screenW(d.aspect)), `${label} container xpos`).toBe(rect.x);
              expect(parsePos(kvGet(c, 'ypos')!, 480), `${label} container ypos`).toBe(rect.y);
              // And it covers all four cards, so nothing is clipped away that the canvas drew.
              if (t.dir === 'row') expect(rect.w, label).toBeGreaterThanOrEqual(t.offset!.x + t.spacing * 3 + t.card!.w);
              else expect(rect.h, label).toBeGreaterThanOrEqual(t.offset!.y + t.spacing * 3 + t.card!.h);
            });
          }
        }
      }
    }
  }

  it('lays out a fitted, scaled column as the sample does', () => {
    const d = design({ elements: { teamColumn: { scale: 1.25, dir: 'column', fit: true, gap: 4 } } });
    expect(teamLayout(d, elementById('teamColumn')!)).toEqual({
      dir: 'column', spacing: 50, gap: 4, offset: { x: 16, y: 45 }, card: { w: 151.25, h: 45 },
      container: { w: 167.25, h: 240 },
      cards: [{ xpos: '16', ypos: '45' }, { xpos: '16', ypos: '95' }, { xpos: '16', ypos: '145' }, { xpos: '16', ypos: '195' }],
      // 240 tall grows up from stock's r75 until its bottom is on the screen's.
      at: { ypos: 'r240' },
    });
    const t = tree(buildHud(d), TEAM_FILE);
    expect(kvGet(kvFind(t, ['TeamPlayer1'])!, 'tall')).toBe('45');
    expect(kvGet(kvFind(t, ['TeamPlayer1'])!, 'wide')).toBe('151');
  });

  it('leaves the container at its mock size while the generator writes no team geometry', () => {
    expect(elementRect(design({}), 'teamColumn', '16:9')).toMatchObject({ w: 430, h: 75 });
    expect(teamLayout(design({}), elementById('teamColumn')!).container).toBeUndefined();
  });
});

describe('a team container anchored to the far edge grows back toward it', () => {
  it('keeps a stock fitted column on screen by growing it up from the bottom', () => {
    // Stock's container sits at r75 and would grow down from y 405, putting the cards at 441, 481, 521.
    const d = design({ elements: { teamColumn: { fit: true, dir: 'column', gap: 4 } } });
    const cards = teamCardRects(d, '16:9');
    for (const c of cards) {
      expect(c.y).toBeGreaterThanOrEqual(0);
      expect(c.y + c.h).toBeLessThanOrEqual(480);
    }
    // 192 tall, bottom on the screen's bottom edge.
    const c = kvFind(layoutOf(buildHud(d)), ['CHudTeamDisplay'])!;
    expect([kvGet(c, 'ypos'), kvGet(c, 'tall')]).toEqual(['r192', '192']);
    expect(elementRect(d, 'teamColumn', '16:9')).toMatchObject({ y: 288, h: 192 });
    expect(cards.map((r) => r.y)).toEqual([324, 364, 404, 444]);
  });

  it('keeps the owner sample column on screen at scale 1.25', () => {
    const d = design({ elements: { teamColumn: { scale: 1.25, dir: 'column', fit: true, gap: 4 } } });
    for (const c of teamCardRects(d, '16:9')) expect(c.y + c.h).toBeLessThanOrEqual(480);
  });

  it('leaves a Row where it was along the screen, lifts it just enough to end on it, and leaves a moved team where the player put it', () => {
    // Fitted, gap 30, scale 1.5: the cards reach 108 into a container at r75,
    // so the container lifts to r108 and the cards end on the bottom edge.
    const row = kvFind(layoutOf(buildHud(design({ elements: { teamColumn: { fit: true, gap: 30, scale: 1.5 } } }))), ['CHudTeamDisplay'])!;
    expect([kvGet(row, 'xpos'), kvGet(row, 'ypos')]).toEqual(['0', 'r108']);
    const moved = design({ elements: { teamColumn: { fit: true, dir: 'column', gap: 4, x: 8, y: 100 } } });
    expect(elementRect(moved, 'teamColumn', '16:9')).toMatchObject({ x: 8, y: 100 });
    // Moving it across only (the X box alone) leaves the column growing up from the bottom.
    const across = design({ elements: { teamColumn: { fit: true, dir: 'column', gap: 4, x: 8 } } });
    expect(elementRect(across, 'teamColumn', '16:9')).toMatchObject({ x: 8, y: 288 });
    expect(kvGet(kvFind(layoutOf(buildHud(across)), ['CHudTeamDisplay'])!, 'ypos')).toBe('r192');
  });

  it('never moves a container that did not grow past its file size, so fitting alone still moves nothing', () => {
    // Modern's column: 136 tall in the file, 130 fitted, so it stays at r148.
    const d = design({ preset: 'modern', elements: { teamColumn: { fit: true } } });
    const c = kvFind(layoutOf(buildHud(d, { fonts: { regular: new Uint8Array(1), bold: new Uint8Array(1) } })), ['CHudTeamDisplay'])!;
    expect(kvGet(c, 'ypos')).toBe('r148');
  });

  it('grows back only toward a far edge, by what it grew, and stays on screen', () => {
    expect(growBack(405, 192, 100, 480, true)).toBe(288);          // grew 92 past a bottom already off screen: clamped to the edge
    expect(growBack(300, 150, 100, 480, true)).toBe(250);          // grew 50: the bottom stays at 400
    expect(growBack(300, 80, 100, 480, true)).toBe(300);           // shrank: never moves down
    expect(growBack(405, 192, 100, 480, false)).toBe(405);         // anchored to the near edge: grows away from it
    expect(growBack(700, 900, 100, 853, true)).toBe(0);            // taller than the screen: its start stays on it
    expect(growBack(600, 400, 200, 853, true)).toBe(400);          // a right-anchored row grows left the same way
  });
});

describe('the whole team stays on screen', () => {
  it('lifts a scaled Row off the bottom edge so its cards end on the screen', () => {
    const d = design({ elements: { teamColumn: { fit: true, scale: 1.25 } } });
    expect(elementRect(d, 'teamColumn', '16:9')).toMatchObject({ x: 0, y: 390 });
    expect(teamCardRects(d, '16:9')[0]).toMatchObject({ y: 435, h: 45 });
    expect(kvGet(kvFind(layoutOf(buildHud(d)), ['CHudTeamDisplay'])!, 'ypos')).toBe('r90');
  });

  it('keeps a moved team switched to Column on screen', () => {
    // 237 tall at y 300 would end at 537: it comes up to 243, the last card ending on the edge.
    const d = design({ elements: { teamColumn: { fit: true, dir: 'column', x: 500, y: 300 } } });
    expect(elementRect(d, 'teamColumn', '16:9')).toMatchObject({ x: 500, y: 243, h: 237 });
    const last = teamCardRects(d, '16:9')[3];
    expect(last.y + last.h).toBe(480);
  });

  it('brings a team moved past the top and left edges back to 0', () => {
    const d = design({ elements: { teamColumn: { fit: true, x: -50, y: -20 } } });
    expect(elementRect(d, 'teamColumn', '16:9')).toMatchObject({ x: 0, y: 0 });
    const c = kvFind(layoutOf(buildHud(d)), ['CHudTeamDisplay'])!;
    expect([kvGet(c, 'xpos'), kvGet(c, 'ypos')]).toEqual(['0', '0']);
  });

  it('leaves an unscaled team exactly where the preset puts it, fitted or not', () => {
    // Stock's own container hangs 25 off the bottom, but its cards do not: nothing moves.
    expect(elementRect(DEFAULT_DESIGN, 'teamColumn', '16:9')).toMatchObject({ y: 405 });
    expect(teamCardRects(DEFAULT_DESIGN, '16:9')[0]).toMatchObject({ x: 13, y: 441 });
    expect(elementRect(design({ elements: { teamColumn: { gap: 30 } } }), 'teamColumn', '16:9')).toMatchObject({ y: 405 });
    const modern = design({ preset: 'modern', elements: { teamColumn: { fit: true } } });
    expect(elementRect(modern, 'teamColumn', '16:9')).toMatchObject({ x: 8, y: 332 });
  });

  it('clamps a start so the reach ends on the screen, never before 0', () => {
    expect(keepOnScreen(405, 90, 480)).toBe(390);
    expect(keepOnScreen(405, 72, 480)).toBe(405);
    expect(keepOnScreen(-20, 72, 480)).toBe(0);
    expect(keepOnScreen(300, 900, 853)).toBe(0);
  });
});

describe('cardFrame', () => {
  it("reports the frame a child's stored numbers are drawn in, the one the generator used", () => {
    expect(cardFrame(DEFAULT_DESIGN)).toEqual({ shift: { x: 13, y: 36 }, k: 1 });
    expect(cardFrame(design({ elements: { teamColumn: { scale: 1.5 } } }))).toEqual({ shift: { x: 0, y: 0 }, k: 1.5 });
    const c = teamCardRects(DEFAULT_DESIGN, '16:9')[1];
    const f = cardFrame(DEFAULT_DESIGN);
    const info = cardChild(DEFAULT_DESIGN, 'Head')!;
    const head = childRects(DEFAULT_DESIGN, 'teamColumn', { x: c.x, y: c.y }, 1).find((r) => r.name === 'Head')!;
    expect(head.x).toBe(c.x + (info.x - f.shift.x) * f.k);
    expect(head.y).toBe(c.y + (info.y - f.shift.y) * f.k);
  });
});

describe('teamLayout, the gap', () => {
  const layout = (d: HudDesign) => teamLayout(d, elementById('teamColumn')!);

  it('derives the gap from the preset file when none is stored, so a new design looks like its preset', () => {
    // Stock row pitch 140: fitted card 121 leaves 19; the unfitted 150 overlaps by 10.
    expect(layout(design({ elements: { teamColumn: { fit: true } } }))).toMatchObject({ gap: 19, spacing: 140 });
    expect(layout(design({}))).toMatchObject({ gap: -10, spacing: 140 });
    // Modern column pitch 34: fitted card 26 tall leaves 8.
    expect(layout(design({ preset: 'modern', elements: { teamColumn: { fit: true } } }))).toMatchObject({ gap: 8, spacing: 34 });
  });

  it('steps a fitted stock column by the card plus the gap', () => {
    const files = buildHud(design({ elements: { teamColumn: { fit: true, dir: 'column', gap: 4 } } }));
    const team = tree(files, TEAM_FILE);
    expect([1, 2, 3, 4].map((n) => kvGet(kvFind(team, [`TeamPlayer${n}`])!, 'ypos'))).toEqual(['36', '76', '116', '156']);
    expect(kvGet(kvFind(team, ['TeamPlayer1'])!, 'xpos')).toBe('13');
    const c = kvFind(layoutOf(files), ['CHudTeamDisplay'])!;
    expect([kvGet(c, 'wide'), kvGet(c, 'tall')]).toEqual(['134', '192']);
  });

  it('leaves the content of an overlapping old column where it was, inside the container', () => {
    // Before the migration: the unfitted 150-tall card stepped 40 (a gap of -110).
    const before = design({ elements: { teamColumn: { dir: 'column', gap: -110 } } });
    const after = validateDesign({ v: 1, elements: { teamColumn: { dir: 'column', spacing: 40 } } });
    expect(after.elements.teamColumn).toMatchObject({ fit: true, gap: 4 });
    const content = (d: HudDesign) => {
      const files = buildHud(d);
      const team = tree(files, TEAM_FILE), card = tree(files, CARD_FILE);
      return [1, 2, 3, 4].flatMap((n) => ['Head', 'Health', 'Name', 'Items', 'Status'].map((name) => {
        const p = kvFind(team, [`TeamPlayer${n}`])!, c = kvFind(card, [name])!;
        return [parseFloat(kvGet(p, 'xpos')!) + parseFloat(kvGet(c, 'xpos')!), parseFloat(kvGet(p, 'ypos')!) + parseFloat(kvGet(c, 'ypos')!)];
      }));
    };
    expect(content(after)).toEqual(content(before));
  });

  it('gives a migrated design the pitch it had', () => {
    expect(layout(validateDesign({ v: 1, elements: { teamColumn: { dir: 'column', spacing: 180 } } })).spacing).toBe(180);
    expect(layout(validateDesign({ v: 1, preset: 'modern', elements: { teamColumn: { spacing: 45, scale: 1.25 } } })).spacing).toBe(45);
  });
});

const FOUR = [{ x: 8, y: 100 }, { x: 8, y: 150 }, { x: 700, y: 100 }, { x: 400, y: 440 }];

describe('buildHud, Free', () => {
  const free = (patch: Partial<ElementOverride> = {}) =>
    design({ elements: { teamColumn: { fit: true, dir: 'free', slots: FOUR, ...patch } } });

  it('writes the full-screen container and four anchored card positions', () => {
    const files = buildHud(free());
    const c = kvFind(layoutOf(files), ['CHudTeamDisplay'])!;
    expect(['xpos', 'ypos', 'wide', 'tall'].map((k) => kvGet(c, k))).toEqual(['0', '0', 'f0', 'f0']);
    const team = tree(files, TEAM_FILE);
    // Each fitted card is drawn the fit offset (13, 36) in from its slot. Anchors
    // follow the card's centre, like an element's: left third plain, middle third c, right third r.
    expect([1, 2, 3, 4].map((n) => [kvGet(kvFind(team, [`TeamPlayer${n}`])!, 'xpos'), kvGet(kvFind(team, [`TeamPlayer${n}`])!, 'ypos')]))
      .toEqual([['21', '136'], ['21', 'c-54'], ['r140', '136'], ['c-13', 'r4']]);
    expect(kvGet(kvFind(team, ['TeamPlayer1'])!, 'wide')).toBe('121');
  });

  it('reports the full screen as the container and each card the fit offset in from its slot', () => {
    const d = free();
    expect(elementRect(d, 'teamColumn', '16:9')).toMatchObject({ x: 0, y: 0, w: 853, h: 480 });
    const cards = teamCardRects(d, '16:9');
    expect(cards.slice(0, 3)).toEqual([
      { x: 21, y: 136, w: 121, h: 36 }, { x: 21, y: 186, w: 121, h: 36 }, { x: 713, y: 136, w: 121, h: 36 },
    ]);
    expect(Math.abs(cards[3].x - 413)).toBeLessThanOrEqual(0.5);          // c-13 on an odd-width screen
    // A right-anchored card stays at the right edge on another aspect.
    expect(teamCardRects(d, '4:3')[2].x).toBe(640 - 140);
  });

  it('keeps the slots while in Row, so switching back to Free restores the cards', () => {
    const row = design({ elements: { teamColumn: { fit: true, dir: 'row', slots: FOUR } } });
    expect(kvGet(kvFind(tree(buildHud(row), TEAM_FILE), ['TeamPlayer1'])!, 'xpos')).toBe('13');
    expect(isFreeTeam(row)).toBe(false);
    const back = validateDesign({ v: 1, elements: { teamColumn: { ...row.elements.teamColumn, dir: 'free' } } });
    expect(isFreeTeam(back)).toBe(true);
    expect(kvGet(kvFind(tree(buildHud(back), TEAM_FILE), ['TeamPlayer1'])!, 'xpos')).toBe('21');
  });

  // Spec rule 4: a slot is the card's unfitted origin, so fitting alone moves
  // nothing in Free either; the drawn card moves by the fit offset instead.
  for (const scale of [undefined, 1.25]) {
    it(`leaves the portrait where it was when fit is toggled in Free${scale ? ` at scale ${scale}` : ''}`, () => {
      const head = (fit: boolean) => {
        const d = design({ elements: { teamColumn: { dir: 'free', slots: FOUR, ...(scale ? { scale } : {}), ...(fit ? { fit: true } : {}) } } });
        return teamCardRects(d, '16:9').slice(0, 3).map((c) => {
          const r = childRects(d, 'teamColumn', { x: c.x, y: c.y }, 1).find((x) => x.name === 'Head')!;
          return [r.x, r.y, r.w, r.h];
        });
      };
      expect(head(true)).toEqual(head(false));
    });
  }

  it('reads a Free without four slots as the preset direction', () => {
    const d = design({ elements: { teamColumn: { dir: 'free' } } });
    expect(teamLayout(d, elementById('teamColumn')!).dir).toBe('row');
  });

  it('reads the row cards from the file the same way', () => {
    expect(teamCardRects(design({ elements: { teamColumn: { fit: true } } }), '16:9')).toEqual([
      { x: 13, y: 441, w: 121, h: 36 }, { x: 153, y: 441, w: 121, h: 36 },
      { x: 293, y: 441, w: 121, h: 36 }, { x: 433, y: 441, w: 121, h: 36 },
    ]);
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

  // scalePass clones existing scheme entries into HudEd_<font>_<tag> font
  // entries for a scaled panel. Those clones must end up on the chosen font
  // too, not left behind on the base face, regardless of whether scalePass
  // or fontPass runs first (see the note above buildHud).
  it('gives a scaled panel the chosen font', () => {
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
      teamColumn: { scale: NaN, gap: NaN, dir: 'column' }, infectedRow: { spacing: NaN } } };
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
    const d = design({ preset: 'modern' });
    expect(teamLayout(d, elementById('teamColumn')!)).toMatchObject({ dir: 'column', spacing: 34, gap: 0 });
    expect(teamLayout(d, elementById('infectedRow')!)).toEqual({ dir: 'row', spacing: 124 });
  });

  it('reads the stock preset real spacing, not a hardcoded constant', () => {
    const teamFile = parseKv(baseFile('stock', 'resource/ui/hud/teamdisplayhud.res'))[0].value as KvNode[];
    const p1 = kvFind(teamFile, ['TeamPlayer1'])!, p2 = kvFind(teamFile, ['TeamPlayer2'])!;
    const rowGap = Math.abs(parseFloat(kvGet(p2, 'xpos')!) - parseFloat(kvGet(p1, 'xpos')!));
    const layout = parseKv(baseFile('stock', 'scripts/hudlayout.res'))[0].value as KvNode[];
    const zombieGap = parseFloat(kvGet(kvFind(layout, ['CHudZombieTeamDisplay'])!, 'HorizPanelSpacing')!);
    const d = design({});
    expect(teamLayout(d, elementById('teamColumn')!)).toMatchObject({ dir: 'row', spacing: rowGap, gap: rowGap - 150 });
    expect(teamLayout(d, elementById('infectedRow')!)).toEqual({ dir: 'row', spacing: zombieGap });
  });
});

describe('buildHud, styles', () => {
  const fonts = { regular: new Uint8Array(1), bold: new Uint8Array(1) };

  it('writes a new texture and points the card background at it', () => {
    const files = buildHud(design({ styles: { panelBg: { kind: 'rounded', color: '0 0 0 140' } } }));
    const paths = files.map((f) => f.path);
    expect(paths).toContain('materials/vgui/hud/hudeditor/panelbg.vtf');
    expect(paths).toContain('materials/vgui/hud/hudeditor/panelbg.vmt');
    expect(kvGet(tree(files, CARD_FILE)[0], 'image')).toBe('hud/hudeditor/panelbg');
  });

  it('uses an uploaded image when the slot asks for one', () => {
    const rgba = new Uint8ClampedArray(32 * 32 * 4).fill(7);
    const files = buildHud(design({ styles: { panelBg: { kind: 'image' } }, images: { panelBg: { w: 32, h: 32, png: 'AAAA' } } }),
      { images: { panelBg: rgba } });
    const vtf = files.find((f) => f.path.endsWith('panelbg.vtf'))!;
    expect(vtf.data.length).toBe(80 + 32 * 32 * 4);
    expect(vtf.data[80]).toBe(7);
  });

  it('never writes a stock texture name in normal mode', () => {
    const files = buildHud(design({ styles: { panelBg: { kind: 'rounded', color: '0 0 0 140' } } }));
    const materials = files.filter((f) => f.path.startsWith('materials/'));
    expect(materials.length).toBeGreaterThan(0);
    for (const f of materials) expect(f.path, f.path).toMatch(/^materials\/vgui\/hud\/hudeditor\//);
  });

  it('writes stock names in advanced mode', () => {
    const files = buildHud(design({ advanced: true, styles: { incapPanel: { kind: 'flat', color: '95 22 22 205' } } }));
    expect(files.map((f) => f.path)).toEqual(expect.arrayContaining(
      ['materials/vgui/s_panel_biker_incap.vtf', 'materials/vgui/s_panel_biker_incap.vmt']));
  });

  it('never writes a health bar texture, since the game draws bar fills in code (probe T8)', () => {
    const files = buildHud(design({ advanced: true, styles: { barGreen: { kind: 'flat', color: '0 255 0 255' } } }));
    expect(files.some((f) => f.path.includes('healthbar_'))).toBe(false);
  });

  it('keeps every path lower case', () => {
    const files = buildHud(design({ preset: 'modern', advanced: true,
      styles: { incapPanel: { kind: 'flat' }, panelBg: { kind: 'rounded' } } }), { fonts });
    for (const f of files) expect(f.path).toBe(f.path.toLowerCase());
  });
});

describe('buildHud, card background', () => {
  const rounded = { panelBg: { kind: 'rounded' as const, color: '0 0 0 150' } };

  it('injects HudEdCardBg first in the card file, at the fitted card size', () => {
    const card = tree(buildHud(design({ elements: { teamColumn: { fit: true } }, styles: rounded })), CARD_FILE);
    const bg = card[0];
    expect(bg.key).toBe('HudEdCardBg');
    expect(['ControlName', 'xpos', 'ypos', 'zpos', 'wide', 'tall', 'scaleImage', 'image'].map((k) => kvGet(bg, k)))
      .toEqual(['ImagePanel', '0', '0', '-2', '121', '36', '1', 'hud/hudeditor/panelbg']);
  });

  it('covers the whole file card when fit is off', () => {
    const bg = tree(buildHud(design({ styles: rounded })), CARD_FILE)[0];
    expect([kvGet(bg, 'wide'), kvGet(bg, 'tall')]).toEqual(['150', '150']);
  });

  it('draws a flat background with fillcolor and ships no texture for it', () => {
    const files = buildHud(design({ elements: { teamColumn: { fit: true } }, styles: { panelBg: { kind: 'flat' } } }));
    const bg = tree(files, CARD_FILE)[0];
    expect(kvGet(bg, 'fillcolor')).toBe('0 0 0 140');                   // the slot's default colour
    expect(kvGet(bg, 'image')).toBeUndefined();
    expect(files.some((f) => f.path.includes('panelbg'))).toBe(false);
  });

  it('scales with the card', () => {
    const files = buildHud(design({ elements: { teamColumn: { fit: true, scale: 1.5 } }, styles: rounded }));
    const bg = tree(files, CARD_FILE)[0];
    const card = kvFind(tree(files, TEAM_FILE), ['TeamPlayer1'])!;
    expect([kvGet(bg, 'wide'), kvGet(bg, 'tall')]).toEqual([kvGet(card, 'wide'), kvGet(card, 'tall')]);
  });

  // Probe T6: the card block's own image is never painted, which is why the old target did nothing.
  it('never writes the card block image', () => {
    const team = tree(buildHud(design({ elements: { teamColumn: { fit: true } }, styles: rounded })), TEAM_FILE);
    for (let n = 1; n <= 4; n++) expect(kvGet(kvFind(team, [`TeamPlayer${n}`])!, 'image')).toBe('../vgui/s_panel_background');
  });

  it('adds nothing for an Image style with no upload stored', () => {
    const files = buildHud(design({ styles: { panelBg: { kind: 'image' } } }));
    expect(text(files, CARD_FILE)).toBeUndefined();
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

describe('buildTrees', () => {
  // The preview draws from buildTrees, the download is buildHud: this is what
  // makes the picture the file. Every file the preview reads (each panel's
  // file, the team and layout files that place them, and the scheme its
  // labels read fonts and colours from) is compared in both presets, advanced
  // on and off, with the panels scaled and two slots restyled so every pass
  // has something to write. A file the build does not emit must still be the
  // base file, since that is what the game will read. The fitted variant also
  // moves the item icons and turns the health number on, so fitPass shifts,
  // re-fits and squares the card in both trees.
  for (const preset of ['stock', 'modern'] as const) {
    for (const advanced of [false, true]) {
      for (const fit of [false, true]) {
        for (const dir of ['row', 'column', 'free'] as const) {
        it(`returns every file the preview reads exactly as buildHud writes it: ${preset} ${dir}${advanced ? ', advanced' : ''}${fit ? ', fitted' : ''}`, () => {
          const d = design({ preset, advanced,
            elements: { ownHealth: { scale: 1.25 }, siHealth: { scale: 0.8 }, infectedRow: { scale: 1.3 },
              teamColumn: { scale: 1.5, dir, gap: 6, slots: FOUR, ...(fit ? { fit: true } : {}) } },
            styles: { panelBg: { kind: 'rounded', color: '0 0 0 150' }, incapPanel: { kind: 'flat', color: '255 0 0 255' } },
            children: { teamColumn: { Name: { x: 20, fontSize: 14 }, Head: { visible: false },
              ...(fit ? { Items: { x: 37, y: 40 }, HealthNumber: { on: true, x: 140 } } : {}) } } });
          const files = buildHud(d, { fonts: { regular: new Uint8Array(1), bold: new Uint8Array(1) } });
          const paths = [...Object.values(PANEL_FILE), 'resource/ui/hud/teamdisplayhud.res', 'scripts/hudlayout.res', 'resource/clientscheme.res'];
          for (const path of paths) {
            const t = text(files, path);
            const expected = parseKv(t ?? baseFile(preset, path))[0].value as KvNode[];
            const got = buildTrees(d)(path);
            if (path === 'resource/clientscheme.res' && preset === 'modern') {
              // fontPass, which buildTrees skips, registers the ttf files in
              // CustomFontFiles on the modern preset. Nothing in the preview
              // reads that block, so it is the one part left out.
              const drop = (nodes: KvNode[]) => nodes.filter((n) => n.key.toLowerCase() !== 'customfontfiles');
              expect(drop(got), `${preset} ${path}`).toEqual(drop(expected));
            } else {
              expect(got, `${preset} ${path}`).toEqual(expected);
            }
          }
        });
        }
      }
    }
  }

  it('does not need the font files even when the design wants Roboto', () => {
    const d = design({ font: 'roboto' });
    expect(() => buildTrees(d)('resource/ui/hud/localplayerpanel.res')).not.toThrow();
    expect(() => buildHud(d)).toThrow(/font/i);        // buildHud is unchanged
  });

  it('is memoised per design object and rebuilt for a new one', () => {
    const d = design({});
    const a = buildTrees(d)('scripts/hudlayout.res');
    expect(buildTrees(d)('scripts/hudlayout.res')).toBe(a);
    const d2 = { ...d, elements: { chat: { x: 5, y: 5 } } };
    expect(buildTrees(d2)('scripts/hudlayout.res')).not.toBe(a);
  });

  it('parses a file it has not been asked for before from the same design', () => {
    const d = design({});
    const t = buildTrees(d)('resource/ui/hud/hunterhealth.res');
    expect(kvFind(t, ['HealthNumber'])).toBeDefined();
  });
});

describe('buildHud, fit', () => {
  const fonts = { regular: new Uint8Array(1), bold: new Uint8Array(1) };
  const fitted = (preset: 'stock' | 'modern' = 'stock', children: HudDesign['children'] = {}) =>
    design({ preset, elements: { teamColumn: { fit: true } }, children });

  it('fits the stock card to 121 x 36 and shifts its content by (13, 36)', () => {
    const files = buildHud(fitted());
    const card = tree(files, CARD_FILE);
    expect(cardAt(card, 'Head')).toEqual(['0', '2', '23', '23']);
    expect(cardAt(card, 'Health')).toEqual(['24', '16', '96', '7']);
    expect(cardAt(card, 'Name')).toEqual(['0', '24', '120', '12']);
    expect(cardAt(card, 'Status')).toEqual(['51', '2', '70', '12']);
    expect(cardAt(card, 'Items')).toEqual(['26', '0', '50', '14']);
    const team = tree(files, TEAM_FILE);
    for (let n = 1; n <= 4; n++) {
      expect([kvGet(kvFind(team, [`TeamPlayer${n}`])!, 'wide'), kvGet(kvFind(team, [`TeamPlayer${n}`])!, 'tall')]).toEqual(['121', '36']);
    }
  });

  it('fits the Modern card to 113 x 26 from (3, 2)', () => {
    const files = buildHud(fitted('modern'), { fonts });
    expect(cardAt(tree(files, CARD_FILE, 'modern'), 'Head')).toEqual(['0', '1', '25', '25']);
    expect(kvGet(kvFind(tree(files, TEAM_FILE, 'modern'), ['TeamPlayer1'])!, 'wide')).toBe('113');
    expect(kvGet(kvFind(tree(files, TEAM_FILE, 'modern'), ['TeamPlayer1'])!, 'tall')).toBe('26');
  });

  for (const preset of ['stock', 'modern'] as const) {
    it(`fitting alone moves nothing on screen: ${preset}`, () => {
      const dir = preset === 'stock' ? 'row' as const : 'column' as const;
      const onScreen = (d: HudDesign) => {
        const files = buildHud(d, { fonts });
        const team = tree(files, TEAM_FILE, preset);
        const card = tree(files, CARD_FILE, preset);
        const container = kvFind(layoutOf(files), ['CHudTeamDisplay'])!;
        const out: Record<string, number[]> = { container: [kvGet(container, 'xpos'), kvGet(container, 'ypos')].map((v) => parseFloat(v!.replace(/^r/, '-'))) };
        for (let n = 1; n <= 4; n++) {
          const p = kvFind(team, [`TeamPlayer${n}`])!;
          for (const name of ['Head', 'Health', 'Name', 'Items', 'Status', 'HealthNumber']) {
            const c = kvFind(card, [name]);
            if (!c) continue;
            out[`${n} ${name}`] = [parseFloat(kvGet(p, 'xpos')!) + parseFloat(kvGet(c, 'xpos')!),
              parseFloat(kvGet(p, 'ypos')!) + parseFloat(kvGet(c, 'ypos')!)];
          }
        }
        return out;
      };
      expect(onScreen(design({ preset, elements: { teamColumn: { dir, fit: true } } })))
        .toEqual(onScreen(design({ preset, elements: { teamColumn: { dir } } })));
    });
  }

  it('re-fits when the icons move above a shorter bar', () => {
    // Head 13..36, Health now 37..85, Name 13..133 at y 60..72, Status 64..134, Items 37..87 at y 40..54: box y 38..72.
    const files = buildHud(fitted('stock', { teamColumn: { Items: { x: 37, y: 40 }, Health: { w: 48 } } }));
    expect(kvGet(kvFind(tree(files, TEAM_FILE), ['TeamPlayer1'])!, 'tall')).toBe('34');
    expect(cardAt(tree(files, CARD_FILE), 'Items').slice(0, 2)).toEqual(['24', '2']);
  });

  it('re-fits when the health number is turned on and moved past the card', () => {
    const files = buildHud(fitted('stock', { teamColumn: { HealthNumber: { on: true, x: 140 } } }));
    expect(kvGet(kvFind(tree(files, TEAM_FILE), ['TeamPlayer1'])!, 'wide')).toBe('157');
    expect(cardAt(tree(files, CARD_FILE), 'HealthNumber').slice(0, 2)).toEqual(['127', '24']);
  });

  it('squares the state art at the card height and fits the splatter to the card width', () => {
    const stock = tree(buildHud(fitted()), CARD_FILE);
    expect(cardAt(stock, 'Incapacitated')).toEqual(['0', '0', '36', '36']);
    expect(cardAt(stock, 'Dead')).toEqual(['0', '0', '36', '36']);
    expect(cardAt(stock, 'Voice')).toEqual(['105', '0', '16', '16']);
    expect(cardAt(stock, 'BackgroundImage')).toEqual(['0', '0', '121', '61']);
    const modern = tree(buildHud(fitted('modern'), { fonts }), CARD_FILE, 'modern');
    // Modern's own Incapacitated is 88 x 31 and Dead 120 x 31: the fit rule is what makes them square.
    expect(cardAt(modern, 'Incapacitated')).toEqual(['0', '0', '26', '26']);
    expect(cardAt(modern, 'Dead')).toEqual(['0', '0', '26', '26']);
    expect(cardAt(modern, 'Voice')).toEqual(['97', '0', '16', '16']);
    expect(cardAt(modern, 'BackgroundImage')).toEqual(['0', '0', '113', '57']);
    // Modern's own fill background covers the fitted card, like the splatter, so a grown card stays covered.
    expect(cardAt(modern, 'ModBg')).toEqual(['0', '0', '113', '26']);
  });

  it("grows Modern's fill background with a card that grew past the file card", () => {
    // The health number moved right, to 140..170, and the name down to y 40: the card grows to 167 x 49.
    const files = buildHud(fitted('modern', { teamColumn: { HealthNumber: { x: 140 }, Name: { y: 40 } } }), { fonts });
    const team = kvFind(tree(files, TEAM_FILE, 'modern'), ['TeamPlayer1'])!;
    expect(cardAt(tree(files, CARD_FILE, 'modern'), 'ModBg')).toEqual(['0', '0', kvGet(team, 'wide'), kvGet(team, 'tall')]);
    expect([kvGet(team, 'wide'), kvGet(team, 'tall')]).toEqual(['167', '49']);
  });

  it('keeps a moved or sized state picture where the player put it, still square', () => {
    const files = buildHud(fitted('stock', { teamColumn: { Incapacitated: { x: 50, y: 40, w: 30, h: 30 } } }));
    expect(cardAt(tree(files, CARD_FILE), 'Incapacitated')).toEqual(['37', '4', '30', '30']);
  });

  it('keeps the full card and says so when every content child is hidden', () => {
    const hidden = Object.fromEntries(['Head', 'Health', 'Name', 'Items', 'Status'].map((n) => [n, { visible: false }]));
    const d = fitted('stock', { teamColumn: hidden });
    const files = buildHud(d);
    expect(kvGet(kvFind(tree(files, TEAM_FILE), ['TeamPlayer1'])!, 'wide')).toBe('150');
    expect(cardAt(tree(files, CARD_FILE), 'Head').slice(0, 2)).toEqual(['13', '38']);
    expect(teamLayout(d, elementById('teamColumn')!).fitEmpty).toBe(true);
  });

  it('leaves the card file alone when fit is off', () => {
    expect(text(buildHud(design({ elements: { teamColumn: { dir: 'row' } } })), CARD_FILE)).toBeUndefined();
  });

  it('fits DEFAULT_DESIGN, which every new design starts from', () => {
    expect(kvGet(kvFind(tree(buildHud(structuredClone(DEFAULT_DESIGN)), TEAM_FILE), ['TeamPlayer1'])!, 'wide')).toBe('121');
  });
});

describe('cardChild', () => {
  const fitted = (children: HudDesign['children'] = {}) => design({ elements: { teamColumn: { fit: true } }, children });

  it('reports a child in the unfitted frame its override is stored in', () => {
    expect(cardChild(fitted(), 'Head')).toMatchObject({ x: 13, y: 38, w: 23, h: 23, visible: true });
    expect(cardChild(design({}), 'Head')).toMatchObject({ x: 13, y: 38, w: 23, h: 23 });
  });

  it('reports the state art where the fit rule put it, so a drag starts where the preview draws it', () => {
    expect(cardChild(fitted(), 'Incapacitated')).toMatchObject({ x: 13, y: 36, w: 36, h: 36 });
    expect(cardChild(design({}), 'Incapacitated')).toMatchObject({ x: 10, y: 4, w: 96, h: 96 });
  });

  it('reports the font size, a raw colour, and nothing for an addable child that is off', () => {
    expect(cardChild(fitted(), 'HealthNumber')).toBeNull();
    expect(cardChild(fitted({ teamColumn: { HealthNumber: { on: true } } }), 'HealthNumber'))
      .toMatchObject({ x: 103, y: 60, w: 30, h: 12, fontTall: 12, color: '255 255 255 255' });
    expect(cardChild(fitted({ teamColumn: { Name: { fontSize: 14 } } }), 'Name')!.fontTall).toBe(14);
    expect(cardChild(fitted(), 'Name')!.color).toBeUndefined();                  // "White" is a scheme name, not raw
  });

  it('knows which children a preset file has', () => {
    expect(baseHasChild('stock', 'HealthNumber')).toBe(false);
    expect(baseHasChild('modern', 'HealthNumber')).toBe(true);
  });
});
