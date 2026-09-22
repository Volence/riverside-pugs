import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { openDb } from '../src/db.js';
import { upsertPlayer, activatePlayer, currentSeasonId } from '../src/players.js';

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'ident-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

const cols = (db: Database.Database, t: string) =>
  (db.prepare(`PRAGMA table_info(${t})`).all() as { name: string; notnull: number }[]);

/** Put a database into the pre-phase-3 shape: open it (which migrates), then
 *  rebuild the three tables the old way. Kept inside the test, so the test
 *  does not depend on an old copy of the source. */
function oldShape(path: string): void {
  const db = openDb(path);
  db.close();
  const raw = new Database(path);
  raw.pragma('foreign_keys = OFF');
  raw.exec(`
    DROP INDEX IF EXISTS tickets_one_open;
    CREATE TABLE t_old (id INTEGER PRIMARY KEY AUTOINCREMENT, target_id TEXT NOT NULL REFERENCES players(steamid),
      status TEXT NOT NULL DEFAULT 'open', outcome TEXT, outcome_note TEXT NOT NULL DEFAULT '', restricted INTEGER NOT NULL DEFAULT 0,
      claimed_by TEXT, opened_by TEXT, created_at TEXT NOT NULL, closed_at TEXT, closed_by TEXT);
    DROP TABLE tickets; ALTER TABLE t_old RENAME TO tickets;
    CREATE UNIQUE INDEX tickets_one_open ON tickets (target_id, restricted) WHERE status = 'open';
    CREATE TABLE r_old (id INTEGER PRIMARY KEY AUTOINCREMENT, ticket_id INTEGER NOT NULL REFERENCES tickets(id),
      reporter_id TEXT NOT NULL REFERENCES players(steamid), category TEXT NOT NULL, text TEXT NOT NULL DEFAULT '',
      match_id INTEGER REFERENCES matches(id), map_ordinal INTEGER, half INTEGER, t_ms INTEGER, created_at TEXT NOT NULL,
      legacy_report_id INTEGER UNIQUE, announced_at TEXT, feed_held INTEGER NOT NULL DEFAULT 0);
    DROP TABLE ticket_reports; ALTER TABLE r_old RENAME TO ticket_reports;
    CREATE INDEX idx_ticket_reports_ticket ON ticket_reports (ticket_id);
    CREATE INDEX idx_ticket_reports_reporter ON ticket_reports (reporter_id, created_at);
    CREATE TABLE p_old (id INTEGER PRIMARY KEY AUTOINCREMENT, reporter_id TEXT NOT NULL REFERENCES players(steamid),
      category TEXT NOT NULL, text TEXT NOT NULL DEFAULT '', typed_name TEXT NOT NULL, candidates TEXT NOT NULL, created_at TEXT NOT NULL);
    DROP TABLE pending_reports; ALTER TABLE p_old RENAME TO pending_reports;
    CREATE INDEX idx_pending_reports_created ON pending_reports (created_at);
    DROP TABLE IF EXISTS discord_sanctions;
  `);
  raw.close();
}

const A = '76561199000000301';
const B = '76561199000000302';

describe('widenTicketIdentity', () => {
  it('keeps every row and every id, and widens the three tables', () => {
    const path = join(dir, 'pug.db');
    oldShape(path);
    // Fill the old shape through a raw handle: openDb would migrate it.
    const raw = new Database(path);
    raw.prepare("INSERT INTO players (steamid, name) VALUES (?, 'a'), (?, 'b')").run(A, B);
    raw.prepare("INSERT INTO tickets (id, target_id, created_at) VALUES (1, ?, '2026-09-22T00:00:00Z')").run(B);
    raw.prepare("INSERT INTO tickets (id, target_id, created_at) VALUES (7, ?, '2026-09-22T00:00:00Z')").run(A);
    raw.prepare('DELETE FROM tickets WHERE id = 7').run(); // a folded ticket: seq stays at 7
    raw.prepare("INSERT INTO ticket_reports (ticket_id, reporter_id, category, created_at, feed_held) VALUES (1, ?, 'afk', '2026-09-22T00:00:00Z', 1)").run(A);
    raw.prepare("INSERT INTO pending_reports (reporter_id, category, typed_name, candidates, created_at) VALUES (?, 'afk', 'bo', '[]', '2026-09-22T00:00:00Z')").run(A);
    raw.close();

    const db = openDb(path);
    expect(db.prepare('SELECT id, target_id, target_discord_id, target_name FROM tickets').all())
      .toEqual([{ id: 1, target_id: B, target_discord_id: null, target_name: '' }]);
    expect(db.prepare('SELECT reporter_id, feed_held FROM ticket_reports').get()).toEqual({ reporter_id: A, feed_held: 1 });
    expect(db.prepare('SELECT reporter_id FROM pending_reports').get()).toEqual({ reporter_id: A });
    // The next ticket must not reuse the folded id 7.
    const next = db.prepare("INSERT INTO tickets (target_id, created_at) VALUES (?, 'x')").run(A).lastInsertRowid;
    expect(Number(next)).toBe(8);
    expect(db.pragma('foreign_key_check')).toEqual([]);
    expect(db.pragma('integrity_check', { simple: true })).toBe('ok');
    expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
    db.close();
  });

  it('matches a fresh database column for column, and a second open changes nothing', () => {
    const path = join(dir, 'pug.db');
    oldShape(path);
    openDb(path).close();
    const migrated = new Database(path);
    const fresh = openDb(':memory:');
    for (const t of ['tickets', 'ticket_reports', 'pending_reports', 'ticket_threads', 'discord_sanctions']) {
      expect(cols(migrated, t)).toEqual(cols(fresh as unknown as Database.Database, t));
    }
    const schema = () => migrated.prepare("SELECT name, sql FROM sqlite_master ORDER BY name").all();
    const before = schema();
    migrated.close();
    openDb(path).close();
    const again = new Database(path);
    expect(again.prepare("SELECT name, sql FROM sqlite_master ORDER BY name").all()).toEqual(before);
    again.close();
  });

  it('enforces exactly one identity on each side', () => {
    const db = openDb(':memory:');
    upsertPlayer(db, { steamid: A, name: 'a', avatar: null }, []);
    const ins = db.prepare('INSERT INTO tickets (target_id, target_discord_id, created_at) VALUES (?, ?, ?)');
    expect(() => ins.run(null, null, 'x')).toThrow(/CHECK/);
    expect(() => ins.run(A, '111', 'x')).toThrow(/CHECK/);
    ins.run(null, '111', 'x');
    // One open case per person holds for Discord people too.
    expect(() => ins.run(null, '111', 'x')).toThrow(/UNIQUE/);
    const rep = db.prepare("INSERT INTO ticket_reports (ticket_id, reporter_id, reporter_discord_id, category, created_at) VALUES (1, ?, ?, 'afk', 'x')");
    expect(() => rep.run(null, null)).toThrow(/CHECK/);
    rep.run(null, '222');
  });

  it('refuses to run over a column it does not know', () => {
    const path = join(dir, 'pug.db');
    oldShape(path);
    const raw = new Database(path);
    raw.exec('ALTER TABLE tickets ADD COLUMN surprise TEXT');
    raw.close();
    expect(() => openDb(path)).toThrow(/surprise/);
  });
});
