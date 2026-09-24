import type { DB } from '../db.js';

const TICKETS_OLD = ['id', 'target_id', 'status', 'outcome', 'outcome_note', 'restricted', 'claimed_by', 'opened_by', 'created_at', 'closed_at', 'closed_by'];
const REPORTS_OLD = ['id', 'ticket_id', 'reporter_id', 'category', 'text', 'match_id', 'map_ordinal', 'half', 't_ms', 'created_at', 'legacy_report_id', 'announced_at', 'feed_held'];
const PENDING_OLD = ['id', 'reporter_id', 'category', 'text', 'typed_name', 'candidates', 'created_at'];

const columnsOf = (db: DB, table: string) =>
  (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name);

function assertColumns(db: DB, table: string, expected: string[]): void {
  const extra = columnsOf(db, table).filter((c) => !expected.includes(c));
  if (extra.length > 0) {
    throw new Error(`widenTicketIdentity: ${table} has columns this rebuild would drop: ${extra.join(', ')}. Add them to identityMigration.ts.`);
  }
}

/** Every index on a table except the automatic ones and those in `skip`, so
 *  indexes added over time survive the rebuild without being listed here. */
const indexesOf = (db: DB, table: string, skip: string[]) =>
  (db.prepare("SELECT name, sql FROM sqlite_master WHERE type = 'index' AND tbl_name = ? AND sql IS NOT NULL").all(table) as { name: string; sql: string }[])
    .filter((i) => !skip.includes(i.name));

/** Every table with a foreign key pointing at `target`, found by asking
 *  the schema rather than hard-coding a list, so a table added later that
 *  references tickets is picked up without editing this file. */
function tablesReferencing(db: DB, target: string): string[] {
  const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all() as { name: string }[])
    .map((t) => t.name);
  return tables.filter((t) => (db.pragma(`foreign_key_list(${t})`) as { table: string }[]).some((fk) => fk.table === target));
}

/**
 * Phase 3: each side of a report is a player OR a Discord member. Rebuilds
 * tickets, ticket_reports and pending_reports so their player column is
 * nullable beside a Discord id, with a CHECK that exactly one is set, and
 * re-keys tickets_one_open over both. See the phase 3 spec, section 1.
 *
 * Runs on every open and does nothing once tickets has target_discord_id. A
 * fresh database is created in the old shape by ensureTicketSchema and
 * converted here, so there is one shape and one path to it.
 *
 * The 12-step SQLite recipe: foreign keys off (only possible outside a
 * transaction), everything else in one transaction, foreign_key_check before
 * commit, foreign keys back on. The check is scoped to the tables this
 * rebuild can affect (tickets, ticket_reports, pending_reports, and every
 * table with a foreign key pointing at tickets) rather than the whole
 * database: an unscoped foreign_key_check inspects every table, so a
 * pre-existing orphan row anywhere else (a table this rebuild never
 * touches, or something hand-edited on the production box) would make
 * openDb throw and the server fail to boot on every restart.
 */
export function widenTicketIdentity(db: DB): void {
  db.exec(`CREATE TABLE IF NOT EXISTS discord_sanctions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    discord_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    until TEXT,
    reason TEXT NOT NULL,
    ticket_id INTEGER REFERENCES tickets(id),
    created_by TEXT NOT NULL,
    created_at TEXT NOT NULL,
    lifted_by TEXT,
    lifted_at TEXT
  )`);
  db.exec('CREATE INDEX IF NOT EXISTS idx_discord_sanctions_discord ON discord_sanctions (discord_id)');
  if (!columnsOf(db, 'ticket_threads').includes('reporter_discord_id')) {
    db.exec('ALTER TABLE ticket_threads ADD COLUMN reporter_discord_id TEXT');
  }
  if (columnsOf(db, 'tickets').includes('target_discord_id')) return;

  assertColumns(db, 'tickets', TICKETS_OLD);
  assertColumns(db, 'ticket_reports', REPORTS_OLD);
  assertColumns(db, 'pending_reports', PENDING_OLD);
  const triggers = db.prepare("SELECT name FROM sqlite_master WHERE type = 'trigger' AND tbl_name IN ('tickets', 'ticket_reports', 'pending_reports')").all();
  if (triggers.length > 0) throw new Error('widenTicketIdentity: triggers on the ticket tables are not handled');

  const seqOf = (name: string) => (db.prepare('SELECT seq FROM sqlite_sequence WHERE name = ?').get(name) as { seq: number } | undefined)?.seq;
  const seqs = { tickets: seqOf('tickets'), ticket_reports: seqOf('ticket_reports'), pending_reports: seqOf('pending_reports') };
  const keepTickets = indexesOf(db, 'tickets', ['tickets_one_open']);
  const keepReports = indexesOf(db, 'ticket_reports', []);
  const keepPending = indexesOf(db, 'pending_reports', []);

  db.pragma('foreign_keys = OFF');
  try {
    db.transaction(() => {
      db.exec(`
        CREATE TABLE tickets_new (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          target_id TEXT REFERENCES players(steamid),
          target_discord_id TEXT,
          target_name TEXT NOT NULL DEFAULT '',
          status TEXT NOT NULL DEFAULT 'open',
          outcome TEXT,
          outcome_note TEXT NOT NULL DEFAULT '',
          restricted INTEGER NOT NULL DEFAULT 0,
          claimed_by TEXT,
          opened_by TEXT,
          created_at TEXT NOT NULL,
          closed_at TEXT,
          closed_by TEXT,
          CHECK ((target_id IS NULL) <> (target_discord_id IS NULL))
        );
        INSERT INTO tickets_new (${TICKETS_OLD.join(', ')}) SELECT ${TICKETS_OLD.join(', ')} FROM tickets;
        DROP TABLE tickets;
        ALTER TABLE tickets_new RENAME TO tickets;
        CREATE UNIQUE INDEX tickets_one_open ON tickets (COALESCE(target_id, 'd:' || target_discord_id), restricted) WHERE status = 'open';
        CREATE INDEX idx_tickets_target_discord ON tickets (target_discord_id);

        CREATE TABLE ticket_reports_new (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          ticket_id INTEGER NOT NULL REFERENCES tickets(id),
          reporter_id TEXT REFERENCES players(steamid),
          reporter_discord_id TEXT,
          reporter_name TEXT NOT NULL DEFAULT '',
          category TEXT NOT NULL,
          text TEXT NOT NULL DEFAULT '',
          match_id INTEGER REFERENCES matches(id),
          map_ordinal INTEGER,
          half INTEGER,
          t_ms INTEGER,
          created_at TEXT NOT NULL,
          legacy_report_id INTEGER UNIQUE,
          announced_at TEXT,
          feed_held INTEGER NOT NULL DEFAULT 0,
          CHECK ((reporter_id IS NULL) <> (reporter_discord_id IS NULL))
        );
        INSERT INTO ticket_reports_new (${REPORTS_OLD.join(', ')}) SELECT ${REPORTS_OLD.join(', ')} FROM ticket_reports;
        DROP TABLE ticket_reports;
        ALTER TABLE ticket_reports_new RENAME TO ticket_reports;
        CREATE INDEX idx_ticket_reports_reporter_discord ON ticket_reports (reporter_discord_id, created_at);

        CREATE TABLE pending_reports_new (
          id          INTEGER PRIMARY KEY AUTOINCREMENT,
          reporter_id TEXT REFERENCES players(steamid),
          reporter_discord_id TEXT,
          category    TEXT NOT NULL,
          text        TEXT NOT NULL DEFAULT '',
          typed_name  TEXT NOT NULL,
          candidates  TEXT NOT NULL,
          created_at  TEXT NOT NULL,
          CHECK ((reporter_id IS NULL) <> (reporter_discord_id IS NULL))
        );
        INSERT INTO pending_reports_new (${PENDING_OLD.join(', ')}) SELECT ${PENDING_OLD.join(', ')} FROM pending_reports;
        DROP TABLE pending_reports;
        ALTER TABLE pending_reports_new RENAME TO pending_reports;
      `);
      for (const i of [...keepTickets, ...keepReports, ...keepPending]) db.exec(i.sql);
      for (const [name, seq] of Object.entries(seqs)) {
        if (seq === undefined) continue;
        const has = db.prepare('SELECT 1 FROM sqlite_sequence WHERE name = ?').get(name);
        if (has) db.prepare('UPDATE sqlite_sequence SET seq = MAX(seq, ?) WHERE name = ?').run(seq, name);
        else db.prepare('INSERT INTO sqlite_sequence (name, seq) VALUES (?, ?)').run(name, seq);
      }
      const checkTables = new Set(['tickets', 'ticket_reports', 'pending_reports', ...tablesReferencing(db, 'tickets')]);
      const broken = [...checkTables].flatMap((t) => db.pragma(`foreign_key_check(${t})`) as unknown[]);
      if (broken.length > 0) throw new Error(`widenTicketIdentity: foreign_key_check failed: ${JSON.stringify(broken.slice(0, 5))}`);
    })();
  } finally {
    db.pragma('foreign_keys = ON');
  }
}
