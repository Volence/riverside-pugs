import type { DB } from '../db.js';

/**
 * The community page's tables: HUDs and crosshairs players share, and the
 * likes on them. See docs/superpowers/specs/2026-09-24-hud-community-design.md.
 *
 * An entry is never deleted outright. A delete by its author, or a removal by
 * staff, is a tombstone: deleted_at, deleted_by and delete_reason are set and
 * the row leaves every list at once, but the payload and files stay for 30
 * days as evidence for a report. The sweep then purges it: payload becomes ''
 * and purged_at is set, and its preview and blob go from disk unless a live
 * entry still uses them. The row itself stays, so a ticket that links to it
 * still resolves to "This entry was removed."
 *
 * kind, preset and aspect carry no CHECK, as in the tickets tables: those
 * sets grow, and a CHECK would need a table rebuild each time one does.
 * deleted_by has no foreign key, like admin_actions.target.
 */
export function ensureCommunitySchema(db: DB): void {
  db.exec(`
CREATE TABLE IF NOT EXISTS community_entries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,                      -- 'hud' | 'crosshair'; no CHECK (tickets convention)
  author_id TEXT NOT NULL REFERENCES players(steamid),
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  payload TEXT NOT NULL,                   -- design JSON or CrosshairArt JSON; '' once purged
  preset TEXT,                             -- hud: 'stock' | 'modern' | 'imported'
  aspect TEXT,                             -- hud: '16:9' | '16:10' | '4:3'
  advanced INTEGER NOT NULL DEFAULT 0,
  import_id TEXT,                          -- hud on an imported base: the blob's hudId
  import_name TEXT,
  preview TEXT,                            -- hud: sha256 hex of the preview PNG
  bytes INTEGER NOT NULL DEFAULT 0,        -- payload + preview + blob (if this entry wrote it), for the cap
  created_at TEXT NOT NULL,
  deleted_at TEXT,
  deleted_by TEXT,                         -- author (self-delete) or staff steamid; no FK, like admin_actions.target
  delete_reason TEXT,
  purged_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_community_list ON community_entries (kind, deleted_at, id);
CREATE INDEX IF NOT EXISTS idx_community_author ON community_entries (author_id, deleted_at);
CREATE INDEX IF NOT EXISTS idx_community_import ON community_entries (import_id);
CREATE INDEX IF NOT EXISTS idx_community_preview ON community_entries (preview);

CREATE TABLE IF NOT EXISTS community_likes (
  entry_id INTEGER NOT NULL REFERENCES community_entries(id),
  player_id TEXT NOT NULL REFERENCES players(steamid),
  created_at TEXT NOT NULL,
  PRIMARY KEY (entry_id, player_id)
);
`);
}
