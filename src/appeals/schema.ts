import type { DB } from '../db.js';

const columnsOf = (db: DB, table: string): string[] =>
  (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name);

/**
 * Ban appeals. Called at the very end of openDb, after widenTicketIdentity
 * (which creates discord_sanctions), so the ALTERs below always have a table.
 *
 * One open appeal per ban is a partial unique index rather than only a
 * check in canAppeal: two submits racing each other both pass the check, and
 * the index is what makes the second one fail.
 */
export function ensureAppealSchema(db: DB): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS appeals (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      ban_id           INTEGER REFERENCES bans(id),
      sanction_id      INTEGER REFERENCES discord_sanctions(id),
      steamid          TEXT REFERENCES players(steamid),
      discord_id       TEXT,
      appellant_name   TEXT NOT NULL DEFAULT '',
      what_happened    TEXT NOT NULL,
      why_lift         TEXT NOT NULL,
      state            TEXT NOT NULL CHECK (state IN
                         ('open','asked','answered','accepted','shortened','denied','auto_denied','lapsed','moot')),
      question         TEXT,
      asked_by         TEXT,
      asked_at         TEXT,
      answer           TEXT,
      answered_at      TEXT,
      decided_by       TEXT,
      decided_at       TEXT,
      new_expires_at   TEXT,
      slurs            TEXT,
      source           TEXT NOT NULL CHECK (source IN ('site','discord_button','appeal_page')),
      created_at       TEXT NOT NULL,
      forum_thread_id  TEXT,
      forum_message_id TEXT,
      forum_state      TEXT,
      dm_state         TEXT,
      CHECK ((ban_id IS NULL) != (sanction_id IS NULL)),
      CHECK (steamid IS NOT NULL OR discord_id IS NOT NULL)
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_appeals_open_ban ON appeals (ban_id)
      WHERE ban_id IS NOT NULL AND state IN ('open','asked','answered');
    CREATE UNIQUE INDEX IF NOT EXISTS idx_appeals_open_sanction ON appeals (sanction_id)
      WHERE sanction_id IS NOT NULL AND state IN ('open','asked','answered');
    CREATE INDEX IF NOT EXISTS idx_appeals_state ON appeals (state);

    -- The standing message carrying the Appeal button, beside the Report
    -- button in the same channel. One row, ever (the report_message pattern).
    CREATE TABLE IF NOT EXISTS appeal_message (
      id         INTEGER PRIMARY KEY CHECK (id = 1),
      channel_id TEXT NOT NULL,
      message_id TEXT NOT NULL,
      hash       TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);
  // Admin-only "this ban cannot be appealed".
  if (!columnsOf(db, 'bans').includes('no_appeal')) db.exec('ALTER TABLE bans ADD COLUMN no_appeal INTEGER NOT NULL DEFAULT 0');
  if (!columnsOf(db, 'discord_sanctions').includes('no_appeal')) {
    db.exec('ALTER TABLE discord_sanctions ADD COLUMN no_appeal INTEGER NOT NULL DEFAULT 0');
  }
}
