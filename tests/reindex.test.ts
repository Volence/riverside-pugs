import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, type DB } from '../src/db.js';
import { reindexRecentMatches } from '../src/reindex.js';

const TOKEN = 'b'.repeat(32);
let db: DB;
let dir: string;

beforeEach(() => {
  db = openDb(':memory:');
  dir = mkdtempSync(join(tmpdir(), 'pug-reindex-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function match(state: string, endedSql: string): number {
  return Number(db.prepare(
    `INSERT INTO matches (season_id, state, campaign, token, ended_at) VALUES (1, ?, 'dead_air', ?, ${endedSql})`,
  ).run(state, TOKEN).lastInsertRowid);
}

describe('reindexRecentMatches', () => {
  it('links a demo that arrived after the match ended, and is idempotent', () => {
    const id = match('completed', "datetime('now', '-30 minutes')");
    writeFileSync(join(dir, `pug_${TOKEN}_0_l4d_vs_farm01_hilltop.dem`), 'x'.repeat(1000));
    expect(reindexRecentMatches(db, dir, '')).toBe(1);
    const row = db.prepare('SELECT match_id, ordinal, map FROM match_demos').get();
    expect(row).toMatchObject({ match_id: id, ordinal: 0, map: 'l4d_vs_farm01_hilltop' });
    reindexRecentMatches(db, dir, '');
    expect(db.prepare('SELECT COUNT(*) AS n FROM match_demos').get()).toEqual({ n: 1 });
  });

  it('ignores matches older than the window and leaves live ones alone', () => {
    match('completed', "datetime('now', '-9 hours')");
    writeFileSync(join(dir, `pug_${TOKEN}_0_l4d_vs_farm01_hilltop.dem`), 'x');
    expect(reindexRecentMatches(db, dir, '')).toBe(0);
    db.prepare('DELETE FROM matches').run();
    db.prepare("INSERT INTO matches (season_id, state, campaign, token) VALUES (1, 'live', 'dead_air', ?)").run(TOKEN);
    expect(reindexRecentMatches(db, dir, '')).toBe(0);
  });

  it('does nothing without directories configured', () => {
    match('completed', "datetime('now')");
    expect(reindexRecentMatches(db, '', '')).toBe(0);
  });
});
