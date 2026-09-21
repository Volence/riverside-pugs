import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, type DB } from '../src/db.js';
import { upsertPlayer, activatePlayer } from '../src/players.js';
import { migrateLegacyReports } from '../src/tickets/migrate.js';
import { mergePlayers } from '../src/mergePlayers.js';
import { fileReport } from '../src/tickets/filing.js';

const IDS = Array.from({ length: 6 }, (_, i) => `7656119900000000${i}`);
const [R1, R2, T1, T2, ADMIN, ALT] = IDS;
let db: DB;
let matchId: number;

beforeEach(() => {
  db = openDb(':memory:');
  for (const id of IDS) {
    upsertPlayer(db, { steamid: id, name: `p${id.slice(-1)}`, avatar: null }, []);
    activatePlayer(db, id);
  }
  db.prepare('UPDATE players SET is_admin = 1 WHERE steamid = ?').run(ADMIN);
  matchId = Number(db.prepare("INSERT INTO matches (season_id, state, campaign) VALUES (1, 'completed', 'dead_air')").run().lastInsertRowid);
});

const legacy = (reporter: string, target: string, status: string, note: string | null = null) =>
  db.prepare(
    `INSERT INTO reports (match_id, reporter_id, target_id, category, text, status, resolved_by, resolution_note, created_at, resolved_at)
     VALUES (?, ?, ?, 'cheating', 'old text', ?, ?, ?, '2026-09-18T10:00:00.000Z', ?)`,
  ).run(matchId, reporter, target, status, status === 'open' ? null : ADMIN, note, status === 'open' ? null : '2026-09-19T10:00:00.000Z');

describe('migrateLegacyReports', () => {
  it('groups open reports by target, gives each settled report its own closed ticket, and runs once', () => {
    legacy(R1, T1, 'open');
    legacy(R2, T1, 'open');
    legacy(R1, T2, 'resolved', 'warned him');
    legacy(R2, T2, 'dismissed');
    expect(migrateLegacyReports(db)).toBe(4);
    expect(migrateLegacyReports(db)).toBe(0);
    const tickets = db.prepare('SELECT target_id, status, outcome, outcome_note, closed_by FROM tickets ORDER BY id').all();
    expect(tickets).toEqual([
      { target_id: T1, status: 'open', outcome: null, outcome_note: '', closed_by: null },
      { target_id: T2, status: 'closed', outcome: 'action_taken', outcome_note: 'warned him', closed_by: ADMIN },
      { target_id: T2, status: 'closed', outcome: 'invalid', outcome_note: '', closed_by: ADMIN },
    ]);
    expect(db.prepare('SELECT COUNT(*) AS n FROM ticket_reports WHERE ticket_id = 1').get()).toEqual({ n: 2 });
    expect(db.prepare('SELECT match_id, text, created_at FROM ticket_reports WHERE id = 1').get())
      .toEqual({ match_id: matchId, text: 'old text', created_at: '2026-09-18T10:00:00.000Z' });
  });

  it('restricts a migrated ticket about staff', () => {
    db.prepare('UPDATE players SET is_mod = 1 WHERE steamid = ?').run(T1);
    legacy(R1, T1, 'open');
    migrateLegacyReports(db);
    expect(db.prepare('SELECT restricted FROM tickets').get()).toEqual({ restricted: 1 });
    expect(db.prepare('SELECT steamid FROM ticket_access').all()).toEqual([{ steamid: ADMIN }]);
  });

  // openDb(':memory:') cannot be reopened over the same handle, so this
  // proves the wiring with a real file: seed a legacy report, wipe the
  // tables migrateLegacyReports would have populated, close the handle, and
  // reopen the same file. openDb must run the migration again on its own.
  it('runs from openDb', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pug-ticket-migrate-'));
    const path = join(dir, 'test.db');
    try {
      let fileDb = openDb(path);
      for (const id of IDS) {
        upsertPlayer(fileDb, { steamid: id, name: `p${id.slice(-1)}`, avatar: null }, []);
        activatePlayer(fileDb, id);
      }
      const fileMatchId = Number(
        fileDb.prepare("INSERT INTO matches (season_id, state, campaign) VALUES (1, 'completed', 'dead_air')").run().lastInsertRowid,
      );
      const reportId = Number(
        fileDb.prepare(
          `INSERT INTO reports (match_id, reporter_id, target_id, category, text, status, created_at)
           VALUES (?, ?, ?, 'cheating', 'old text', 'open', '2026-09-18T10:00:00.000Z')`,
        ).run(fileMatchId, R1, T1).lastInsertRowid,
      );
      fileDb.prepare('DELETE FROM ticket_reports').run();
      fileDb.prepare('DELETE FROM tickets').run();
      fileDb.close();

      fileDb = openDb(path);
      const rows = fileDb.prepare('SELECT legacy_report_id FROM ticket_reports').all();
      expect(rows).toEqual([{ legacy_report_id: reportId }]);
      fileDb.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('merging players', () => {
  it('folds the alt open ticket into the main one and repoints everything else', () => {
    const deps = { adminSteamIds: [] };
    const main = (fileReport(db, R1, { targetId: T1, category: 'afk', text: '' }, deps) as { ticketId: number }).ticketId;
    const alt = (fileReport(db, R2, { targetId: ALT, category: 'cheating', text: 'x' }, deps) as { ticketId: number }).ticketId;
    fileReport(db, ALT, { targetId: T2, category: 'afk', text: '' }, deps);
    mergePlayers(db, { from: ALT, into: T1, by: ADMIN });
    expect(db.prepare('SELECT id, target_id FROM tickets ORDER BY id').all()).toEqual([
      { id: main, target_id: T1 },
      { id: alt + 1, target_id: T2 },
    ]);
    expect(db.prepare('SELECT COUNT(*) AS n FROM ticket_reports WHERE ticket_id = ?').get(main)).toEqual({ n: 2 });
    expect(db.prepare('SELECT reporter_id FROM ticket_reports WHERE ticket_id = ?').get(alt + 1)).toEqual({ reporter_id: T1 });
  });
});
