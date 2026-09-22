import type { DB } from '../db.js';

/**
 * Tickets: player reports grouped into one case per accused player.
 *
 * No CHECK on status, outcome, category or event kind: those sets will grow,
 * and SQLite cannot widen a CHECK without rebuilding the table.
 *
 * tickets_one_open is what makes "one open case per player" a fact rather
 * than a convention. It is keyed on restricted as well, so a restricted
 * report never has to attach to a ticket the whole team can read: it opens a
 * restricted sibling instead.
 *
 * ticket_threads says which Discord thread belongs to which ticket. `surface`
 * is where it lives ('forum' for the staff forum, 'private' for a private
 * thread in the tickets channel) and is stored rather than worked out from
 * channel_id, so changing the forum setting cannot change what an old row
 * means. `locked` is what the bot last did in Discord, which is how the
 * reconciler knows a closed ticket's post still needs locking. `card_hash`
 * is written only after Discord accepted the edit it stands for.
 *
 * ticket_messages is the mirror of a ticket's Discord threads. `thread_id` is
 * the Discord thread's id, not a ticket_threads row id: a message belongs to
 * the ticket, and outlives the thread row it arrived through. `deleted_at` is
 * a Discord-side delete and keeps everything; `removed_at` is a removal and
 * keeps only the tombstone. `discord_gone` is 1 once the Discord message is
 * known to be gone, which is how a removal that committed while the bot was
 * down still gets its Discord message deleted later.
 *
 * ticket_attachments never holds a file, only where it is: `stored_name` is a
 * random name under TICKET_ATTACHMENTS_DIR, NULL when the file was not kept
 * (`skip_reason` says why) or is no longer there.
 */
export function ensureTicketSchema(db: DB): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS tickets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      target_id TEXT NOT NULL REFERENCES players(steamid),
      status TEXT NOT NULL DEFAULT 'open',
      outcome TEXT,
      outcome_note TEXT NOT NULL DEFAULT '',
      restricted INTEGER NOT NULL DEFAULT 0,
      claimed_by TEXT,
      opened_by TEXT,
      created_at TEXT NOT NULL,
      closed_at TEXT,
      closed_by TEXT
    );
    CREATE UNIQUE INDEX IF NOT EXISTS tickets_one_open ON tickets (target_id, restricted) WHERE status = 'open';

    CREATE TABLE IF NOT EXISTS ticket_reports (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ticket_id INTEGER NOT NULL REFERENCES tickets(id),
      reporter_id TEXT NOT NULL REFERENCES players(steamid),
      category TEXT NOT NULL,
      text TEXT NOT NULL DEFAULT '',
      match_id INTEGER REFERENCES matches(id),
      map_ordinal INTEGER,
      half INTEGER,
      t_ms INTEGER,
      created_at TEXT NOT NULL,
      legacy_report_id INTEGER UNIQUE
    );
    CREATE INDEX IF NOT EXISTS idx_ticket_reports_ticket ON ticket_reports (ticket_id);
    CREATE INDEX IF NOT EXISTS idx_ticket_reports_reporter ON ticket_reports (reporter_id, created_at);

    CREATE TABLE IF NOT EXISTS ticket_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ticket_id INTEGER NOT NULL REFERENCES tickets(id),
      actor_id TEXT,
      kind TEXT NOT NULL,
      detail TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_ticket_events_ticket ON ticket_events (ticket_id);

    CREATE TABLE IF NOT EXISTS ticket_access (
      ticket_id INTEGER NOT NULL REFERENCES tickets(id),
      steamid TEXT NOT NULL,
      added_by TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (ticket_id, steamid)
    );

    CREATE TABLE IF NOT EXISTS ticket_threads (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ticket_id INTEGER NOT NULL REFERENCES tickets(id),
      kind TEXT NOT NULL,
      reporter_id TEXT REFERENCES players(steamid),
      channel_id TEXT NOT NULL,
      thread_id TEXT NOT NULL UNIQUE,
      state TEXT NOT NULL DEFAULT 'open',
      created_at TEXT NOT NULL,
      surface TEXT NOT NULL,
      card_message_id TEXT,
      card_hash TEXT NOT NULL DEFAULT '',
      locked INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_ticket_threads_ticket ON ticket_threads (ticket_id);

    CREATE TABLE IF NOT EXISTS ticket_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ticket_id INTEGER NOT NULL REFERENCES tickets(id),
      thread_id TEXT NOT NULL,
      channel TEXT NOT NULL,
      discord_message_id TEXT NOT NULL UNIQUE,
      author_discord_id TEXT NOT NULL,
      author_player_id TEXT REFERENCES players(steamid),
      author_name TEXT NOT NULL,
      content TEXT NOT NULL DEFAULT '',
      history TEXT NOT NULL DEFAULT '[]',
      created_at TEXT NOT NULL,
      edited_at TEXT,
      deleted_at TEXT,
      removed_at TEXT,
      removed_by TEXT,
      removed_reason TEXT,
      discord_gone INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_ticket_messages_ticket ON ticket_messages (ticket_id);
    CREATE INDEX IF NOT EXISTS idx_ticket_messages_thread ON ticket_messages (thread_id);

    CREATE TABLE IF NOT EXISTS ticket_attachments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      message_id INTEGER NOT NULL REFERENCES ticket_messages(id),
      discord_attachment_id TEXT NOT NULL,
      filename TEXT NOT NULL,
      content_type TEXT NOT NULL DEFAULT '',
      size INTEGER NOT NULL DEFAULT 0,
      sha256 TEXT,
      stored_name TEXT,
      skip_reason TEXT,
      removed_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_ticket_attachments_message ON ticket_attachments (message_id);
  `);
}
