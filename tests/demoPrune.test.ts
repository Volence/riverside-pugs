import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, utimesSync, readdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, type DB } from '../src/db.js';
import { setSetting } from '../src/settings.js';
import { pruneDemos } from '../src/demoPrune.js';

const TOKEN = 'c'.repeat(32);
let db: DB;
let dir: string;

const write = (name: string, ageDays: number) => {
  const p = join(dir, name);
  writeFileSync(p, 'x'.repeat(100));
  const t = (Date.now() - ageDays * 86_400_000) / 1000;
  utimesSync(p, t, t);
};

beforeEach(() => {
  db = openDb(':memory:');
  dir = mkdtempSync(join(tmpdir(), 'pug-demoprune-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('pruneDemos', () => {
  it('drops old auto recordings, keeps recent ones and young match demos', () => {
    write('auto-20260101-1200-l4d_vs_farm01_hilltop.dem', 30);
    write('auto-20260901-1200-l4d_vs_farm01_hilltop.dem', 2);
    write(`pug_${TOKEN}_0_l4d_vs_farm01_hilltop.dem`, 30);
    write('something-else.txt', 400);
    const r = pruneDemos(db, dir);
    expect(r.deleted).toBe(1);
    expect(readdirSync(dir).sort()).toEqual([
      'auto-20260901-1200-l4d_vs_farm01_hilltop.dem',
      `pug_${TOKEN}_0_l4d_vs_farm01_hilltop.dem`,
      'something-else.txt',
    ]);
  });

  it('drops match demos past their retention and unlinks them from the match', () => {
    const name = `pug_${TOKEN}_0_l4d_vs_farm01_hilltop.dem`;
    write(name, 100);
    db.prepare("INSERT INTO matches (season_id, state, campaign, token) VALUES (1, 'completed', 'dead_air', ?)").run(TOKEN);
    db.prepare('INSERT INTO match_demos (match_id, ordinal, map, filename, bytes) VALUES (1, 0, ?, ?, 100)')
      .run('l4d_vs_farm01_hilltop', name);
    expect(pruneDemos(db, dir).deleted).toBe(1);
    expect(db.prepare('SELECT COUNT(*) AS n FROM match_demos').get()).toEqual({ n: 0 });
  });

  it('keeps the row when the demo is in R2, so the redirect keeps working', () => {
    // The row outlives the local file on purpose once a demo is in the bucket:
    // it is what carries r2_key, and the download route reads that to redirect.
    // Deleting it would orphan a good object and break a link that still worked.
    const name = `pug_${TOKEN}_0_l4d_vs_farm01_hilltop.dem`;
    write(name, 100);
    db.prepare("INSERT INTO matches (season_id, state, campaign, token) VALUES (1, 'completed', 'dead_air', ?)").run(TOKEN);
    db.prepare("INSERT INTO match_demos (match_id, ordinal, map, filename, bytes, r2_key) VALUES (1, 0, ?, ?, 100, 'demos/1/x.dem')")
      .run('l4d_vs_farm01_hilltop', name);

    const r = pruneDemos(db, dir);

    // The local file still goes: that is the space being reclaimed.
    expect(r.deleted).toBe(1);
    expect(existsSync(join(dir, name))).toBe(false);
    // The row, and therefore the download, survives.
    const row = db.prepare('SELECT r2_key AS k FROM match_demos').get() as { k: string } | undefined;
    expect(row?.k).toBe('demos/1/x.dem');
  });

  it('honours the settings and does nothing without a directory', () => {
    write('auto-20260101-1200-x.dem', 3);
    expect(pruneDemos(db, dir).deleted).toBe(0);
    setSetting(db, 'demo_autorecord_days', '2');
    expect(pruneDemos(db, dir).deleted).toBe(1);
    expect(pruneDemos(db, '').deleted).toBe(0);
  });
});
