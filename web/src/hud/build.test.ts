import { describe, it, expect } from 'vitest';
import { buildHud, elementRect } from './build';
import { DEFAULT_DESIGN, type HudDesign } from './design';
import { parseKv, kvFind, kvGet, type KvNode } from './kv';
import { baseFile } from './base';

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
    const got = layoutOf(buildHud(design({ preset: 'modern' })));
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
    const paths = buildHud(design({ preset: 'modern' })).map((f) => f.path);
    expect(paths).toContain('resource/ui/hud/teammatepanel.res');
    expect(paths).toContain('scripts/hudanimations.txt');
  });

  it('never ships a crosshair image', () => {
    for (const preset of ['stock', 'modern'] as const) {
      expect(buildHud(design({ preset })).some((f) => f.path.includes('altcrosshair'))).toBe(false);
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
