import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { openDb } from '../src/db.js';
import { addServer } from '../src/serverPool.js';
import { subscribeAdminEvents } from '../src/adminFeed.js';
import { parseLogDatagram } from '../src/logParse.js';
import { BalanceWatchWriter, dataDirOf, renderWatchFile, WATCH_FILE } from '../src/balanceWatch.js';
import type { AddonsTransport } from '../src/addonsTransport.js';
import { KNOBS } from './balanceFixtures.js';
import { loadCatalogue, watchKnobs } from '../src/balanceCatalogue.js';

describe('renderWatchFile', () => {
  it('lists cvars, files, dirs and weapon keys in knobs order', () => {
    const text = renderWatchFile({ ...KNOBS, files: [{ path: 'cfg/pug_match.cfg', label: 'x' }],
      dirs: [{ path: 'addons/stripper/maps', ext: '.cfg', label: 'y' }], weapons: [{ weapon: 'weapon_smg', key: 'SpreadPerShot', label: 'z' }] });
    const body = text.split('\n').filter((l) => l && !l.startsWith('//'));
    expect(body).toEqual([
      'cvar z_tank_health', 'cvar versus_boss_flow_min', 'cvar versus_boss_flow_max', 'cvar z_witch_health',
      'file cfg/pug_match.cfg', 'dir addons/stripper/maps .cfg', 'weapon weapon_smg SpreadPerShot',
    ]);
    expect(text.endsWith('\n')).toBe(true);
  });
  it('lists each entry once, cvars compared ignoring case (FindConVar does)', () => {
    const f = { path: 'cfg/a.cfg', label: 'x' }, d = { path: 'cfg/d', ext: '.cfg', label: 'y' };
    const w = { weapon: 'weapon_smg', key: 'Damage', label: 'z' };
    const text = renderWatchFile({ ...KNOBS, cvars: [{ cvar: 'gfc_ff_zc_flags', label: 'a', group: 'g' }, { cvar: 'gfc_FF_zc_flags', label: 'b', group: 'g' }],
      files: [f, f], dirs: [d, d], weapons: [w, w] });
    expect(text.split('\n').filter((l) => l && !l.startsWith('//'))).toEqual([
      'cvar gfc_ff_zc_flags', 'file cfg/a.cfg', 'dir cfg/d .cfg', 'weapon weapon_smg Damage',
    ]);
  });
  it('a catalogue cvar spelled with other case joins neither the list nor the file twice, and the catalogue refuses two spellings', () => {
    const cat = { groups: [{ id: 'g', label: 'G' }], rules: [], values: [
      { id: 'Z_Tank_Health', group: 'g', label: 'T', source: 'cvar' as const },
      { id: 'weapon_smg.Damage', group: 'g', label: 'U', source: 'weapon' as const },
    ] };
    const k = watchKnobs({ ...KNOBS, weapons: [{ weapon: 'weapon_smg', key: 'Damage', label: 'U' }] }, cat);
    expect(k.cvars.map((c) => c.cvar.toLowerCase()).filter((c) => c === 'z_tank_health')).toHaveLength(1);
    expect(k.weapons).toHaveLength(1);
    expect(() => loadCatalogue('', { ...cat, values: [...cat.values, { id: 'z_tank_health', group: 'g', label: 'T', source: 'cvar' }] })).toThrow(/duplicate/);
  });
  it('finds the data dir from the addons dir', () => {
    expect(dataDirOf({ addons_dir: '/g/left4dead/addons' } as never)).toBe('/g/left4dead/addons/sourcemod/data');
    expect(dataDirOf({ addons_dir: null } as never)).toBeNull();
  });
});

describe('BALANCE lines', () => {
  it('keep w: items', () => {
    const tok = 'a'.repeat(32);
    const ev = parseLogDatagram(Buffer.concat([Buffer.from([0xff, 0xff, 0xff, 0xff, 0x52]), Buffer.from(`L 09/24/2026 - 10:00:00: PUG ${tok} BALANCE half=1 part=0 w:weapon_smg.SpreadPerShot=0.22 c:z_tank_health=8000\n`)]));
    expect(ev).toMatchObject({ kind: 'balance_part', items: { 'w:weapon_smg.SpreadPerShot': '0.22', 'c:z_tank_health': '8000' } });
  });
});

describe('BalanceWatchWriter', () => {
  let db: ReturnType<typeof openDb>;
  let files: Record<number, Map<string, string>>;
  let failing: Set<number>;
  let reads: number;
  let problems: string[];
  let unsub: () => void;
  const transport = (s: { id: number }): AddonsTransport => ({
    put: async (local, name) => { if (failing.has(s.id)) throw new Error('ftp down'); files[s.id].set(name, readFileSync(local, 'utf8')); },
    size: async () => null, remove: async () => {},
    readText: async (name) => { reads++; if (failing.has(s.id)) throw new Error('ftp down'); return files[s.id].get(name) ?? null; },
  });
  beforeEach(() => {
    db = openDb(':memory:');
    for (const n of ['dallas', 'chicago']) {
      const id = addServer(db, { name: n, host: '10.0.0.1', port: 27015, rconPort: 27015, rconPassword: 'x' });
      db.prepare("UPDATE servers SET addons_dir = '/g/left4dead/addons' WHERE id = ?").run(id);
    }
    files = { 1: new Map(), 2: new Map() };
    failing = new Set();
    reads = 0;
    problems = [];
    unsub = subscribeAdminEvents((e) => { if (e.kind === 'problem') problems.push(e.text); });
  });
  afterEach(() => unsub());

  it('writes when missing, not when equal, again when the content changes', async () => {
    let content = 'cvar a\n';
    let t = 0;
    const w = new BalanceWatchWriter({ db, content: () => content, transport, now: () => t });
    expect((await w.sync()).map((r) => r.wrote)).toEqual([true, true]);
    expect(files[1].get(WATCH_FILE)).toBe('cvar a\n');
    const before = reads;
    expect((await w.sync()).map((r) => r.wrote)).toEqual([false, false]);
    expect(reads).toBe(before); // verified recently: not read again
    content = 'cvar a\ncvar b\n';
    expect((await w.sync()).map((r) => r.wrote)).toEqual([true, true]);
    t += 7 * 3_600_000;
    await w.sync();
    expect(reads).toBeGreaterThan(before + 4);
  });

  it('skips a busy box, isolates a failing one and reports it once', async () => {
    db.prepare("UPDATE servers SET status = 'live' WHERE id = 1").run();
    failing.add(2);
    const w = new BalanceWatchWriter({ db, content: () => 'cvar a\n', transport });
    const r = await w.sync();
    expect(r).toEqual([
      { serverId: 1, server: 'dallas', ok: false, skipped: 'busy' },
      { serverId: 2, server: 'chicago', ok: false, error: 'ftp down' },
    ]);
    await w.sync();
    expect(problems).toHaveLength(1);
    failing.clear();
    await w.sync();
    expect(files[2].get(WATCH_FILE)).toBe('cvar a\n');
  });

  it('writes in the release hook while the box restarts, and does nothing without content', async () => {
    db.prepare("UPDATE servers SET status = 'offline' WHERE id = 1").run();
    await new BalanceWatchWriter({ db, content: () => 'cvar a\n', transport }).writeForRelease(1);
    expect(files[1].get(WATCH_FILE)).toBe('cvar a\n');
    expect(await new BalanceWatchWriter({ db, content: () => null, transport }).sync()).toEqual([]);
  });
});
