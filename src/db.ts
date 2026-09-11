import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export type DB = Database.Database;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS players (
  steamid TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  avatar TEXT,
  status TEXT NOT NULL DEFAULT 'invited' CHECK (status IN ('invited','active','banned')),
  is_admin INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS seasons (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  started_at TEXT NOT NULL DEFAULT (datetime('now')),
  ended_at TEXT
);
CREATE TABLE IF NOT EXISTS player_ratings (
  player_id TEXT NOT NULL REFERENCES players(steamid),
  season_id INTEGER NOT NULL REFERENCES seasons(id),
  mu REAL NOT NULL,
  sigma REAL NOT NULL,
  wins INTEGER NOT NULL DEFAULT 0,
  losses INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (player_id, season_id)
);
CREATE TABLE IF NOT EXISTS servers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  host TEXT NOT NULL,
  port INTEGER NOT NULL,
  rcon_port INTEGER NOT NULL,
  rcon_password TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'offline' CHECK (status IN ('idle','reserved','live','offline'))
);
CREATE TABLE IF NOT EXISTS matches (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  season_id INTEGER NOT NULL REFERENCES seasons(id),
  state TEXT NOT NULL CHECK (state IN ('configuring','live','completed','aborted')),
  campaign TEXT NOT NULL,
  server_id INTEGER REFERENCES servers(id),
  token TEXT,
  team_a_score INTEGER NOT NULL DEFAULT 0,
  team_b_score INTEGER NOT NULL DEFAULT 0,
  winner TEXT CHECK (winner IN ('a','b','draw')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  ended_at TEXT
);
CREATE TABLE IF NOT EXISTS match_players (
  match_id INTEGER NOT NULL REFERENCES matches(id),
  player_id TEXT NOT NULL REFERENCES players(steamid),
  team TEXT NOT NULL CHECK (team IN ('a','b')),
  si_damage INTEGER NOT NULL DEFAULT 0,
  si_kills INTEGER NOT NULL DEFAULT 0,
  common_kills INTEGER NOT NULL DEFAULT 0,
  ff_dealt INTEGER NOT NULL DEFAULT 0,
  revives INTEGER NOT NULL DEFAULT 0,
  stats_json TEXT NOT NULL DEFAULT '{}',
  PRIMARY KEY (match_id, player_id)
);
CREATE TABLE IF NOT EXISTS match_maps (
  match_id INTEGER NOT NULL REFERENCES matches(id),
  ordinal INTEGER NOT NULL,
  map TEXT NOT NULL,
  team_a_score INTEGER NOT NULL DEFAULT 0,
  team_b_score INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (match_id, ordinal)
);
-- Which pug team played survivor in each round, and what they scored.
--
-- Written from the UDP feed, unlike match_maps which is written once at
-- completion from the rcon dump. That is acceptable here because nothing in
-- the rating path reads this table: it exists so stats and events can be
-- attributed to a side and a moment, which is presentation, not scoring.
--
-- 'reliable' goes to 0 when the round was restarted after stats accrued, or a
-- rostered player changed team mid-match. Consumers must show an unreliable
-- round as unavailable rather than guessing, the same way absent stats are
-- never rendered as fabricated zeros.
CREATE TABLE IF NOT EXISTS match_rounds (
  match_id   INTEGER NOT NULL REFERENCES matches(id),
  ordinal    INTEGER NOT NULL,
  half       INTEGER NOT NULL,
  surv_team  TEXT    NOT NULL CHECK (surv_team IN ('a','b')),
  score      INTEGER NOT NULL DEFAULT 0,
  reliable   INTEGER NOT NULL DEFAULT 1,
  started_at TEXT,
  ended_at   TEXT,
  PRIMARY KEY (match_id, ordinal, half)
);
CREATE TABLE IF NOT EXISTS match_player_stats (
  match_id  INTEGER NOT NULL REFERENCES matches(id),
  player_id TEXT    NOT NULL REFERENCES players(steamid),
  stat      TEXT    NOT NULL,
  value     INTEGER NOT NULL,
  PRIMARY KEY (match_id, player_id, stat)
);
CREATE INDEX IF NOT EXISTS idx_mps_stat ON match_player_stats(stat, value DESC);
CREATE TABLE IF NOT EXISTS rating_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  player_id TEXT NOT NULL,
  match_id INTEGER NOT NULL,
  season_id INTEGER NOT NULL,
  mu_before REAL NOT NULL,
  sigma_before REAL NOT NULL,
  mu_after REAL NOT NULL,
  sigma_after REAL NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_rating_history_match_player ON rating_history (match_id, player_id);
-- Live-view scratch state, written from the LOSSY UDP feed.
-- Deliberately SEPARATE from match_maps: the authoritative record is written
-- once, at completion, from the rcon dump. Keeping the cosmetic running score
-- in its own tables means a duplicated or dropped datagram can never corrupt
-- the result a rating was computed from. Rows are dropped once the match
-- completes.
CREATE TABLE IF NOT EXISTS match_live (
  match_id    INTEGER PRIMARY KEY REFERENCES matches(id),
  current_map TEXT,
  last_seen   TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS match_live_maps (
  match_id     INTEGER NOT NULL REFERENCES matches(id),
  map          TEXT    NOT NULL,
  ordinal      INTEGER NOT NULL,
  team_a_score INTEGER NOT NULL,
  team_b_score INTEGER NOT NULL,
  -- Keyed by map, not ordinal: MAP_RESULT carries no ordinal, and UDP can
  -- deliver the same datagram twice. Upserting on the map name makes a
  -- duplicate idempotent instead of a second row.
  PRIMARY KEY (match_id, map)
);
CREATE TABLE IF NOT EXISTS match_live_players (
  match_id   INTEGER NOT NULL REFERENCES matches(id),
  player_id  TEXT    NOT NULL,
  -- JSON rather than a row per stat: this is throwaway spectator scratch, the
  -- key set changes with what the plugin decides to send, and it is never
  -- queried by stat. The authoritative per-stat rows live in
  -- match_player_stats, written once from the dump.
  stats_json TEXT    NOT NULL,
  PRIMARY KEY (match_id, player_id)
);
-- Cumulative per-player stats as they stood when each map ENDED. Map N's own
-- stats are snapshot(N) - snapshot(N-1); the map in progress is
-- totals - snapshot(last). Storing snapshots rather than per-map deltas means
-- the plugin keeps sending one simple cumulative line and a lost datagram
-- self-corrects on the next one.
CREATE TABLE IF NOT EXISTS match_live_map_stats (
  match_id   INTEGER NOT NULL REFERENCES matches(id),
  ordinal    INTEGER NOT NULL,
  player_id  TEXT    NOT NULL,
  stats_json TEXT    NOT NULL,
  PRIMARY KEY (match_id, ordinal, player_id)
);
CREATE TABLE IF NOT EXISTS match_live_events (
  match_id INTEGER NOT NULL REFERENCES matches(id),
  -- Which map of the match this happened on, stamped at write time from the
  -- number of maps already completed. Without it a feed is ambiguous three
  -- maps in: "volence pounced Bone Breaker for 15" could be from any of them.
  map_ordinal INTEGER NOT NULL DEFAULT 0,
  -- Plugin-assigned, monotonic per match. Primary key with match_id so a
  -- duplicated UDP datagram upserts over itself instead of double-counting.
  seq      INTEGER NOT NULL,
  kind     TEXT    NOT NULL,
  actor    TEXT    NOT NULL,
  target   TEXT,
  value    INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (match_id, seq)
);
CREATE TABLE IF NOT EXISTS match_demos (
  match_id INTEGER NOT NULL REFERENCES matches(id),
  ordinal  INTEGER NOT NULL,
  map      TEXT    NOT NULL,
  filename TEXT    NOT NULL,
  bytes    INTEGER NOT NULL,
  PRIMARY KEY (match_id, ordinal)
);
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

const DEFAULT_SETTINGS: Record<string, string> = {
  invite_code: 'change-me',
  ready_seconds: '60',
  vote_seconds: '30',
  map_pool: JSON.stringify(['no_mercy', 'death_toll', 'dead_air', 'blood_harvest']),
  discord_webhook_url: '',
  discord_queue_thresholds: JSON.stringify([4, 6]),
};

/** Add a column if the table lacks it. No-op when already present. */
function ensureColumn(db: DB, table: string, column: string, ddl: string): void {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  if (cols.some((c) => c.name === column)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
}

export function openDb(path: string): DB {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA);
  // CREATE TABLE IF NOT EXISTS never adds a column to a table that already
  // exists, so a column introduced after a database was created needs this.
  // Idempotent and cheap; there is no migration framework here by design.
  ensureColumn(db, 'match_live_events', 'map_ordinal', 'INTEGER NOT NULL DEFAULT 0');
  // -1, not 0 or NULL: ALTER TABLE ADD COLUMN on a populated table needs a
  // non-null default, and 0 is a real value here (an event in the first
  // millisecond of a round). -1 means "recorded before round timing existed".
  ensureColumn(db, 'match_live_events', 'half', 'INTEGER NOT NULL DEFAULT -1');
  ensureColumn(db, 'match_live_events', 't_ms', 'INTEGER NOT NULL DEFAULT -1');
  seed(db);
  return db;
}

function seed(db: DB): void {
  const seasonCount = db.prepare('SELECT COUNT(*) AS n FROM seasons').get() as { n: number };
  if (seasonCount.n === 0) {
    db.prepare('INSERT INTO seasons (name) VALUES (?)').run('Season 1');
  }
  const insert = db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)');
  for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) insert.run(key, value);
}
