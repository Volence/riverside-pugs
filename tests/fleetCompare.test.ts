import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { areaOf, compareFleet, loadManifest, type FileSig, type Manifest } from '../src/fleetCompare.js';

const sig = (h: string, size = 1): FileSig => ({ size, sha256: h });
const man = (kind: 'repo' | 'base', files: Record<string, FileSig>): Manifest => ({ kind, label: kind, at: 't', files });
const box = (serverId: number, files: Record<string, FileSig> | null) => ({ serverId, files: files ? new Map(Object.entries(files)) : null });
const P = 'left4dead/addons/sourcemod/plugins/pug-match.smx';
const C = 'left4dead/cfg/pug_match.cfg';
const X = 'left4dead/addons/sourcemod/plugins/extra.smx';

describe('compareFleet', () => {
  it('repo is the reference: a box that differs or lacks the file is highlighted', () => {
    const rows = compareFleet(man('repo', { [P]: sig('r') }), man('base', { [P]: sig('b') }),
      [box(1, { [P]: sig('d') }), box(2, { [P]: sig('r') }), box(3, {})]);
    const r = rows.find((x) => x.path === P)!;
    expect(r.cells[1]).toMatchObject({ label: 'neither', highlight: true });
    expect(r.cells[2]).toMatchObject({ label: 'repo', highlight: false });
    expect(r.cells[3]).toMatchObject({ label: 'missing', highlight: true });
    expect(r.differs).toBe(true);
  });

  it('base patched the same way on every box is not highlighted', () => {
    const rows = compareFleet(null, man('base', { [C]: sig('b') }), [box(1, { [C]: sig('p') }), box(2, { [C]: sig('p') })]);
    expect(rows[0]).toMatchObject({ patchedEverywhere: true, differs: false });
    expect(rows[0].cells[1]).toMatchObject({ label: 'neither', highlight: false });
  });

  it('a base file gone from every box reads removed; a repo file gone from every box stays highlighted', () => {
    const rows = compareFleet(man('repo', { [C]: sig('c') }), man('base', { [X]: sig('x') }), [box(1, {}), box(2, {})]);
    expect(rows.find((r) => r.path === X)).toMatchObject({ removedEverywhere: true, differs: false });
    expect(rows.find((r) => r.path === C)).toMatchObject({ removedEverywhere: false, differs: true });
  });

  it('a box layer is that box\'s reference and ends the per-box exemption; origins name the release', () => {
    const L = 'left4dead/cfg/local.cfg';
    const rows = compareFleet(man('repo', {}), null, [box(1, { [L]: sig('dal') }), box(2, { [L]: sig('chi-old') })], {
      boxRefs: new Map([[1, new Map([[L, sig('dal')]])], [2, new Map([[L, sig('chi')]])]]),
      origins: new Map([[1, new Map([[L, { releaseId: 12, sha256: 'dal' }]])]]),
    });
    expect(rows[0].perBox).toBe(false);
    expect(rows[0].cells[1]).toMatchObject({ label: 'repo', highlight: false, origin: 12 });
    expect(rows[0].cells[2]).toMatchObject({ label: 'neither', highlight: true, origin: null });
  });

  it('a per-box file is shown but never highlighted', () => {
    const S = 'left4dead/cfg/secrets.cfg';
    const rows = compareFleet(null, null, [box(1, { [S]: sig('a') }), box(2, { [S]: sig('b') }), box(3, {})]);
    expect(rows[0]).toMatchObject({ perBox: true, differs: false });
  });

  it('without a reference the minority is highlighted; a tie highlights everyone', () => {
    const rows = compareFleet(null, null, [box(1, { [X]: sig('a') }), box(2, {}), box(3, {}), box(4, {})]);
    expect(rows[0].cells[1]).toMatchObject({ label: 'neither', highlight: true });
    expect(rows[0].cells[2]).toMatchObject({ label: 'missing', highlight: false });
    const tie = compareFleet(null, null, [box(1, { [X]: sig('a') }), box(2, { [X]: sig('b') })]);
    expect(Object.values(tie[0].cells).every((c) => c.highlight)).toBe(true);
  });

  it('an unread box takes no part and shows unread; size-only compares by size', () => {
    const rows = compareFleet(man('repo', { [C]: { size: 5, sha256: null } }), null,
      [box(1, null), box(2, { [C]: { size: 5, sha256: null } })]);
    expect(rows[0].cells[1]).toMatchObject({ label: 'unread', highlight: false });
    expect(rows[0].cells[2]).toMatchObject({ label: 'repo', highlight: false, sizeOnly: true });
  });

  it('ignores unmanaged paths in the manifests and sorts by area then path', () => {
    const rows = compareFleet(man('repo', { 'left4dead/maps/x.bsp': sig('m'), [C]: sig('c'), [P]: sig('p') }), null, []);
    expect(rows.map((r) => r.path)).toEqual([P, C]);
  });
});

describe('areaOf', () => {
  it('groups by folder', () => {
    expect(areaOf(P)).toBe('plugins');
    expect(areaOf('left4dead/addons/sourcemod/plugins/disabled/a.smx')).toBe('plugins');
    expect(areaOf(C)).toBe('configs');
    expect(areaOf('left4dead/addons/sourcemod/configs/admins.cfg')).toBe('configs');
    expect(areaOf('left4dead/addons/sourcemod/data/a.txt')).toBe('data');
    expect(areaOf('left4dead/addons/sourcemod/gamedata/a.txt')).toBe('gamedata');
    expect(areaOf('left4dead/addons/sourcemod/extensions/a.so')).toBe('extensions');
    expect(areaOf('left4dead/addons/stripper/maps/c1m1.cfg')).toBe('stripper');
    expect(areaOf('left4dead/addons/metamod.vdf')).toBe('other');
  });
});

describe('loadManifest', () => {
  let dir = '';
  afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); });
  it('reads a manifest and answers null for missing or broken files', () => {
    dir = mkdtempSync(join(tmpdir(), 'man-'));
    expect(loadManifest(dir, 'repo')).toBeNull();
    writeFileSync(join(dir, 'repo.json'), JSON.stringify(man('repo', { [C]: sig('c') })));
    expect(loadManifest(dir, 'repo')?.files[C]).toEqual(sig('c'));
    writeFileSync(join(dir, 'base.json'), '{nope');
    expect(loadManifest(dir, 'base')).toBeNull();
    writeFileSync(join(dir, 'base.json'), JSON.stringify({ ...man('repo', {}) }));
    expect(loadManifest(dir, 'base')).toBeNull(); // kind must match the file
  });
});
