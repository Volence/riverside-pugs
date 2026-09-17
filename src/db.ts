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
  joined_map INTEGER NOT NULL DEFAULT 0,
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
-- 'reliable' is 0 when this round's side attribution must not be trusted.
-- Consumers must show an unreliable round as unavailable rather than guessing,
-- the same way absent stats are never rendered as fabricated zeros.
--
-- Today exactly one thing writes a 0: recordRoundStart, when the plugin sent a
-- ROUND_START with no side because its orientation mapping had not settled.
-- ROUND_END promotes that row back to 1 when it supplies the real side. One
-- further suppression exists but is NOT stored here: roundAttribution forces
-- both halves of an ordinal unreliable in its RETURN VALUE when they fail to
-- partition the sides, leaving the rows untouched.
--
-- The two cases that most want this column, a round restarted after stats
-- accrued and a rostered player changing team mid-match, are NOT detected by
-- anything yet. Detecting them is plugin work that has not been done. Until it
-- is, a reliable = 1 round means "nothing has demonstrated this round wrong",
-- not "this round has been verified correct". Do not build on the stronger
-- reading.
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
-- In-game chat, from the same lossy UDP feed as match_live_events and with
-- the same discipline: cosmetic, never counted, never read when a result is
-- computed.
--
-- seq is the SAME counter match_live_events uses, so one monotonic sequence
-- orders chat and events together and a duplicated datagram upserts over
-- itself rather than producing a second copy of a message.
CREATE TABLE IF NOT EXISTS match_chat (
  match_id    INTEGER NOT NULL REFERENCES matches(id),
  seq         INTEGER NOT NULL,
  map_ordinal INTEGER NOT NULL DEFAULT 0,
  -- -1 when the message was sent outside a live round, which is common and
  -- not an error: chat is deliberately not gated on stats being active.
  half        INTEGER NOT NULL DEFAULT -1,
  t_ms        INTEGER NOT NULL DEFAULT -1,
  steamid     TEXT    NOT NULL,
  team        TEXT,
  message     TEXT    NOT NULL,
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
-- One row per replay file on disk. Mirrors match_demos: the bytes live on
-- disk, this is the index. The row deliberately OUTLIVES the file, so a
-- pruned replay can be reported as expired rather than 404ing: pruned_at is
-- set, the row stays.
--
-- frames and sample_hz are read from the file's own header rather than sent
-- over UDP. There is no REPLAY datagram: discovery is by filename, exactly
-- as discoverMatchDemos works, because the filename already carries the
-- match link by construction and a lost datagram would otherwise leave a
-- real file permanently unindexed.
CREATE TABLE IF NOT EXISTS match_replays (
  match_id  INTEGER NOT NULL REFERENCES matches(id),
  ordinal   INTEGER NOT NULL,
  half      INTEGER NOT NULL,
  filename  TEXT    NOT NULL,
  bytes     INTEGER NOT NULL,
  frames    INTEGER NOT NULL,
  sample_hz INTEGER NOT NULL,
  pruned_at TEXT,
  PRIMARY KEY (match_id, ordinal, half)
);
-- One-time codes a Discord user follows to link their Steam account from
-- Discord (the bot hands them out). Single use, 15 minutes; created_at is an
-- ISO string written by the app so expiry can be tested with an injected clock.
CREATE TABLE IF NOT EXISTS discord_link_codes (
  code TEXT PRIMARY KEY,
  discord_id TEXT NOT NULL,
  discord_name TEXT NOT NULL,
  created_at TEXT NOT NULL,
  used_at TEXT
);
-- The Discord bot's own messages (queue panel, match cards, result posts), so a
-- restart edits them instead of posting duplicates. See src/discord/messageStore.ts.
CREATE TABLE IF NOT EXISTS discord_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,
  ref TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'open',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (kind, ref)
);
-- Team voice channels the bot made for a match. ended_at is when the sweep
-- first saw the match finished; deleted_at when the channels were removed.
CREATE TABLE IF NOT EXISTS discord_voice (
  match_id INTEGER PRIMARY KEY,
  category_id TEXT NOT NULL,
  team_a_id TEXT NOT NULL,
  team_b_id TEXT NOT NULL,
  ended_at TEXT,
  deleted_at TEXT
);
-- Admin panel. Every mutation writes admin_actions. Ban and note timestamps
-- are ISO strings written by the app, so expiry is testable with a clock.
CREATE TABLE IF NOT EXISTS admin_actions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  admin_id TEXT NOT NULL,
  action TEXT NOT NULL,
  target TEXT NOT NULL,
  detail TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS bans (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  player_id TEXT NOT NULL REFERENCES players(steamid),
  reason TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT,
  lifted_by TEXT,
  lifted_at TEXT
);
CREATE TABLE IF NOT EXISTS player_notes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  player_id TEXT NOT NULL REFERENCES players(steamid),
  author_id TEXT NOT NULL,
  text TEXT NOT NULL,
  created_at TEXT NOT NULL
);
-- No-show and missed-ready-check offenses. Each one lengthens the next queue
-- timeout; see src/penalties.ts.
CREATE TABLE IF NOT EXISTS penalties (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  player_id TEXT NOT NULL REFERENCES players(steamid),
  kind TEXT NOT NULL CHECK (kind IN ('ready_fail', 'no_show')),
  match_id INTEGER,
  created_at TEXT NOT NULL,
  cleared_by TEXT,
  cleared_at TEXT
);
-- Player reports, filed from a match page by someone who played in it.
CREATE TABLE IF NOT EXISTS reports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  match_id INTEGER NOT NULL REFERENCES matches(id),
  reporter_id TEXT NOT NULL REFERENCES players(steamid),
  target_id TEXT NOT NULL REFERENCES players(steamid),
  category TEXT NOT NULL,
  text TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved', 'dismissed')),
  resolved_by TEXT,
  resolution_note TEXT,
  created_at TEXT NOT NULL,
  resolved_at TEXT,
  UNIQUE (match_id, reporter_id, target_id)
);
-- The queue and open lobbies, saved on every change so a restart resumes them.
CREATE TABLE IF NOT EXISTS matchmaker_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

const DEFAULT_SETTINGS: Record<string, string> = {
  invite_code: 'change-me',
  ready_seconds: '120',
  vote_seconds: '30',
  map_pool: JSON.stringify(['no_mercy', 'death_toll', 'dead_air', 'blood_harvest']),
  discord_webhook_url: '',
  discord_queue_thresholds: JSON.stringify([4, 6]),
  // Empty: guild membership alone activates a linked player. A role id: the
  // member must also hold that role.
  discord_required_role_id: '',
  // 1: the bot makes Team A / Team B voice channels per match and moves players in.
  discord_voice_enabled: '1',
  // Queueing needs a linked Discord account that is in the guild.
  require_discord_to_queue: '1',
  discord_invite_url: '',
  // Private channel the bot posts the admin feed to; empty turns the feed off.
  discord_admin_channel_id: '',
  admin_feed_reports: '1',
  admin_feed_actions: '1',
  admin_feed_penalties: '1',
  admin_feed_accounts: '1',
  admin_feed_problems: '1',
  replay_retention_days: '90',
  replay_free_floor_gb: '10',
  noshow_minutes: '10',
  noshow_min_connected: '6',
  no_round_minutes: '30',
  penalties_enabled: '1',
  penalty_window_days: '7',
  penalty_minutes: JSON.stringify([5, 15, 60, 1440]),
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
  // Which map a player was rostered on: 0 for the starting roster, later for a
  // sub rostered at a go-live. The rating step skips anyone who played under
  // half the maps.
  ensureColumn(db, 'match_players', 'joined_map', 'INTEGER NOT NULL DEFAULT 0');
  // When the match actually went live, which is not when its row was inserted:
  // a match with no free server now waits in 'configuring' instead of aborting,
  // so created_at can be arbitrarily older. The no-show reaper times from here.
  ensureColumn(db, 'matches', 'went_live_at', 'TEXT');
  // First time this rostered player was seen connected to the match server.
  // Null means they never turned up, which is what the no-show reaper counts.
  ensureColumn(db, 'match_players', 'connected_at', 'TEXT');
  // How many survivors were still standing when the round ended. NULL, not 0,
  // as the default: every round recorded before the plugin emitted this was
  // simply not measured, and 0 is a real value here (a wipe). Defaulting to 0
  // would retroactively record every historic round as a wipe and drag
  // survival rate to nothing.
  ensureColumn(db, 'match_rounds', 'survivors_alive', 'INTEGER');
  // Discord identity. Steam stays canonical; this is a link, and one Discord
  // account maps to at most one player. Partial index so the many unlinked
  // players do not collide on NULL.
  ensureColumn(db, 'players', 'discord_id', 'TEXT');
  ensureColumn(db, 'players', 'discord_name', 'TEXT');
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS players_discord_id ON players(discord_id) WHERE discord_id IS NOT NULL');
  // A voided match: an admin decided the result must not count. It is also
  // set to 'aborted', which is what drops it from every stat query.
  ensureColumn(db, 'matches', 'voided_at', 'TEXT');
  ensureColumn(db, 'matches', 'void_reason', 'TEXT');
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
