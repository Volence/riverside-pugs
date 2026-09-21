import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { ensureTicketSchema } from './tickets/schema.js';
import { migrateLegacyReports } from './tickets/migrate.js';

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
-- A player's off-site presence. Handles, never URLs: the URL is generated
-- server-side from a per-platform template, so there is no code path that
-- renders a link a player typed. On a public site that has already had one
-- identity forgery bug, a free URL field is somewhere to hang a phishing link.
--
-- Deliberately no CHECK on 'platform', unlike most of this schema. SQLite
-- cannot alter a CHECK without rebuilding the table, which would make adding a
-- platform exactly the migration this table exists to avoid. The permitted set
-- lives in LINK_PLATFORMS in src/profileFields.ts, which has to be correct
-- anyway because it also builds the URLs.
CREATE TABLE IF NOT EXISTS player_links (
  player_id TEXT NOT NULL REFERENCES players(steamid),
  platform  TEXT NOT NULL,
  handle    TEXT NOT NULL,
  PRIMARY KEY (player_id, platform)
);
-- The Twitch poll cache, overwritten every minute. Separate from 'players' on
-- purpose: this is volatile data on a hot write path, and it must never touch
-- the row where identity, admin flag and ban status live.
--
-- 'checked_at' is always written, even when nothing changed, because the read
-- path uses it to decide the cache is too stale to claim anyone is live. A
-- LIVE badge stuck on forever after the poller dies would make the whole page
-- untrustworthy; a wrong "offline" is a shrug.
CREATE TABLE IF NOT EXISTS twitch_status (
  player_id    TEXT PRIMARY KEY REFERENCES players(steamid),
  is_live      INTEGER NOT NULL DEFAULT 0,
  title        TEXT,
  game_name    TEXT,
  viewers      INTEGER,
  thumbnail    TEXT,
  started_at   TEXT,
  last_live_at TEXT,
  checked_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_twitch_status_live ON twitch_status (is_live, viewers DESC);
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
-- Post-match endorsements. The primary key is an anti abuse rule expressed
-- structurally: one endorsement per giver per recipient per match, so nobody
-- stacks all three kinds on one friend. Everything a CHECK cannot see (both
-- rostered, match completed, inside the window, within the budget, not self)
-- is enforced by src/endorsements.ts. from_id is never shown to anybody; it is
-- kept so farming can be audited if it ever happens.
CREATE TABLE IF NOT EXISTS endorsements (
  match_id   INTEGER NOT NULL REFERENCES matches(id),
  from_id    TEXT NOT NULL REFERENCES players(steamid),
  to_id      TEXT NOT NULL REFERENCES players(steamid),
  kind       TEXT NOT NULL CHECK (kind IN ('caller','clutch','vibes')),
  created_at TEXT NOT NULL,
  PRIMARY KEY (match_id, from_id, to_id)
);
CREATE INDEX IF NOT EXISTS idx_endorsements_to ON endorsements (to_id, kind);
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
-- Every pause of a match, kept after the match ends: the record an admin
-- reads when one side says the other paused them to death. Written from the
-- plugin's PHASE transitions, so a lost datagram can leave ended_at NULL
-- until the next heartbeat closes it.
CREATE TABLE IF NOT EXISTS match_pauses (
  id          INTEGER PRIMARY KEY,
  match_id    INTEGER NOT NULL REFERENCES matches(id),
  map_ordinal INTEGER NOT NULL,
  half        INTEGER,
  team        TEXT CHECK (team IN ('a','b')),
  leave_pause INTEGER NOT NULL DEFAULT 0,
  started_at  TEXT NOT NULL,
  ended_at    TEXT
);
CREATE INDEX IF NOT EXISTS match_pauses_match ON match_pauses(match_id);
-- Every ready-up of a match, and who was still not ready in the last report
-- before it went live (a JSON list of steamids). Kept after the match ends.
CREATE TABLE IF NOT EXISTS match_readyups (
  id           INTEGER PRIMARY KEY,
  match_id     INTEGER NOT NULL REFERENCES matches(id),
  map_ordinal  INTEGER NOT NULL,
  half         INTEGER,
  started_at   TEXT NOT NULL,
  ended_at     TEXT,
  last_unready TEXT NOT NULL DEFAULT '[]'
);
CREATE INDEX IF NOT EXISTS match_readyups_match ON match_readyups(match_id);
-- Seconds each player spent not ready in one ready-up, summed from the
-- intervals between the plugin's roster reports.
CREATE TABLE IF NOT EXISTS match_readyup_players (
  readyup_id INTEGER NOT NULL REFERENCES match_readyups(id),
  match_id   INTEGER NOT NULL REFERENCES matches(id),
  player_id  TEXT    NOT NULL,
  seconds    INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (readyup_id, player_id)
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
-- Integrity measurements. Written by the analyzer, never by the game server.
-- These hold MEASUREMENTS, not verdicts: rankings are computed at read time in
-- src/integrity/score.ts so a threshold change re-scores the whole history
-- without a migration.
CREATE TABLE IF NOT EXISTS integrity_rounds (
  match_id         INTEGER NOT NULL REFERENCES matches(id),
  ordinal          INTEGER NOT NULL,
  half             INTEGER NOT NULL,
  slot             INTEGER NOT NULL,
  steamid          TEXT    NOT NULL,
  analyzer_version INTEGER NOT NULL,
  metrics          TEXT    NOT NULL,
  computed_at      TEXT    NOT NULL,
  PRIMARY KEY (match_id, ordinal, half, slot)
);
-- Derived and disposable: a re-analysis deletes and rewrites these. Nothing an
-- admin types may live here, which is why integrity_reviews is separate.
CREATE TABLE IF NOT EXISTS integrity_clips (
  id               INTEGER PRIMARY KEY,
  match_id         INTEGER NOT NULL REFERENCES matches(id),
  ordinal          INTEGER NOT NULL,
  half             INTEGER NOT NULL,
  slot             INTEGER NOT NULL,
  steamid          TEXT    NOT NULL,
  start_ms         INTEGER NOT NULL,
  end_ms           INTEGER NOT NULL,
  kind             TEXT    NOT NULL,
  score            REAL    NOT NULL,
  detail           TEXT    NOT NULL,
  analyzer_version INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS integrity_clips_player ON integrity_clips (steamid);
-- Flags raised by something other than the replay analyser: today Little
-- Anti-Cheat, reported live from the game server by l4d_lilac_report.smx.
-- Separate from integrity_clips because a clip is a span of a recorded round an
-- admin can watch, while a flag is a moment another plugin shouted about with no
-- replay behind it. Evidence for an admin; never shown to players.
CREATE TABLE IF NOT EXISTS integrity_flags (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  match_id  INTEGER,
  server_id INTEGER,
  steamid   TEXT NOT NULL,
  source    TEXT NOT NULL,
  kind      TEXT NOT NULL,
  severity  TEXT NOT NULL,
  detail    TEXT NOT NULL DEFAULT '',
  at        TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS integrity_flags_player ON integrity_flags (steamid, at);
CREATE INDEX IF NOT EXISTS integrity_flags_at ON integrity_flags (at);
-- Survives every re-analysis. Keyed by the player-round because that is stable
-- no matter how the clips inside it are recomputed.
CREATE TABLE IF NOT EXISTS integrity_reviews (
  match_id    INTEGER NOT NULL REFERENCES matches(id),
  ordinal     INTEGER NOT NULL,
  half        INTEGER NOT NULL,
  slot        INTEGER NOT NULL,
  state       TEXT    NOT NULL DEFAULT 'new',
  note        TEXT    NOT NULL DEFAULT '',
  reviewed_by TEXT,
  reviewed_at TEXT,
  PRIMARY KEY (match_id, ordinal, half, slot)
);
-- The pooled aim prior per map, and each round's own contribution to it so a
-- round can be subtracted before it is scored (leave-one-round-out).
CREATE TABLE IF NOT EXISTS integrity_prior (
  map              TEXT PRIMARY KEY,
  frames           INTEGER NOT NULL,
  rounds           INTEGER NOT NULL,
  counts           TEXT    NOT NULL,
  analyzer_version INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS integrity_prior_rounds (
  match_id INTEGER NOT NULL REFERENCES matches(id),
  ordinal  INTEGER NOT NULL,
  half     INTEGER NOT NULL,
  frames   INTEGER NOT NULL,
  counts   TEXT    NOT NULL,
  map      TEXT,
  analyzer_version INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (match_id, ordinal, half)
);
-- Rounds the analyzer tried and could not measure: the replay is not on disk,
-- or is not something this analyzer version can read. Without this a round
-- like that is pending for ever and the server starts an analysis process for
-- it every minute. Keyed to the version that failed, so a newer analyzer tries
-- again, and cleared by saveRound the moment the round is measured.
CREATE TABLE IF NOT EXISTS integrity_unanalysable (
  match_id         INTEGER NOT NULL REFERENCES matches(id),
  ordinal          INTEGER NOT NULL,
  half             INTEGER NOT NULL,
  analyzer_version INTEGER NOT NULL,
  reason           TEXT    NOT NULL,
  at               TEXT    NOT NULL,
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
-- Where each player was sitting when the bot pulled them into a team channel,
-- so the sweep can put them back rather than dropping them out of voice when
-- it deletes the channels.
CREATE TABLE IF NOT EXISTS discord_voice_origin (
  match_id INTEGER NOT NULL,
  user_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  PRIMARY KEY (match_id, user_id)
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
CREATE TABLE IF NOT EXISTS custom_campaigns (
  slug TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  vpk_filename TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  sha256 TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('draft','published')),
  enabled INTEGER NOT NULL DEFAULT 0,
  uploaded_by TEXT,
  uploaded_at INTEGER NOT NULL,
  notes TEXT
);
CREATE TABLE IF NOT EXISTS custom_campaign_chapters (
  slug TEXT NOT NULL REFERENCES custom_campaigns(slug) ON DELETE CASCADE,
  ordinal INTEGER NOT NULL,
  map TEXT NOT NULL,
  display TEXT,
  is_finale INTEGER NOT NULL DEFAULT 0,
  included INTEGER NOT NULL DEFAULT 1,
  play_order INTEGER,
  PRIMARY KEY (slug, ordinal)
);
CREATE TABLE IF NOT EXISTS custom_campaign_installs (
  slug TEXT NOT NULL REFERENCES custom_campaigns(slug) ON DELETE CASCADE,
  server_id INTEGER NOT NULL REFERENCES servers(id),
  state TEXT NOT NULL CHECK (state IN ('pending','installed','failed')),
  sha256 TEXT,
  error TEXT,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (slug, server_id)
);
CREATE INDEX IF NOT EXISTS custom_chapter_map ON custom_campaign_chapters(map);
CREATE TABLE IF NOT EXISTS campaign_play_rules (
  slug TEXT PRIMARY KEY,
  maps_to_play INTEGER NOT NULL
);
-- A client that connected, never entered the game and left by its own hand on
-- a map that forced files: the only trace a file-consistency rejection leaves
-- on the server, and also what a cancelled loading screen looks like. A hint,
-- never an accusation. steamid is deliberately NOT a foreign key: most drops
-- happen to people who have never signed in to the site. Timestamps are ISO
-- strings written by the app, so the ten minute rule is testable with a clock.
-- entered_after_at is when the same steamid was next seen in game, which is
-- what separates "came back clean" from "still trying".
CREATE TABLE IF NOT EXISTS signon_drops (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  steamid TEXT NOT NULL,
  name TEXT NOT NULL,
  secs_connected INTEGER NOT NULL,
  forced_count INTEGER NOT NULL,
  at TEXT NOT NULL,
  entered_after_at TEXT
);
CREATE INDEX IF NOT EXISTS signon_drops_steamid ON signon_drops(steamid, at);

-- Input bursts from l4d_inputstats.smx: a run of button presses with no gap
-- longer than 300ms. The raw ORDERED intervals are kept rather than a summary
-- because the checks that catch a macro with jitter added compare each interval
-- to the next one, and that ordering cannot be recovered from a summary or a
-- histogram afterwards. Storing them is also what lets a signature written
-- later be re-run over everything recorded before it existed.
-- A burst is evidence, never an accusation, and is admin-only.
CREATE TABLE IF NOT EXISTS input_bursts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  match_id INTEGER,
  server_id INTEGER,
  steamid TEXT NOT NULL,
  kind TEXT NOT NULL,
  weapon TEXT NOT NULL DEFAULT '',
  n INTEGER NOT NULL,
  ground_ticks INTEGER NOT NULL,
  air_presses INTEGER NOT NULL,
  server_tick INTEGER NOT NULL,
  client_tick INTEGER NOT NULL,
  intervals TEXT NOT NULL,
  at TEXT NOT NULL,
  -- 1: plugin 0.1.0, intervals are SERVER TICKS, and usercmds bunched into one
  -- tick after lag were dropped. 2: intervals are USERCMDS (cmdnum deltas).
  wire INTEGER NOT NULL DEFAULT 1,
  -- Server ticks from first press to last; wire 2 only. A cross-check on the
  -- sum of the intervals, which is the client's own command sequence.
  server_span INTEGER,
  -- How long each press was held down, one character per PRESS, same encoding
  -- as intervals. NULL from plugin 0.1.0. It separates a mouse wheel (one
  -- tick), a scripted hold (constant) and a hand (5 to 12 ticks, never the
  -- same), and unlike a signature it cannot be backfilled: if it was not
  -- captured, it is gone.
  holds TEXT
);
CREATE INDEX IF NOT EXISTS input_bursts_match ON input_bursts(match_id);
CREATE INDEX IF NOT EXISTS input_bursts_steamid ON input_bursts(steamid, at);

-- The plugin stops sending a kind of burst for a player once that kind's
-- budget for the round is spent, and says so once. A row here means the
-- capture for that player, kind and round is TRUNCATED, which is not the same
-- thing as nothing having happened.
CREATE TABLE IF NOT EXISTS input_caps (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  match_id INTEGER,
  server_id INTEGER,
  steamid TEXT NOT NULL,
  kind TEXT NOT NULL,
  server_tick INTEGER NOT NULL,
  at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS input_caps_steamid ON input_caps(steamid, at);

-- One row per signature that fired on a burst. Separate from the burst so that
-- re-running an improved signature adds rows without rewriting the evidence.
CREATE TABLE IF NOT EXISTS input_detections (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  burst_id INTEGER NOT NULL,
  match_id INTEGER,
  steamid TEXT NOT NULL,
  kind TEXT NOT NULL,
  signature TEXT NOT NULL,
  severity TEXT NOT NULL,
  at TEXT NOT NULL,
  -- Bursts that qualified in this match so far, and their ids as a JSON array.
  -- A detection is one row per player, match and signature, written only once
  -- the signature has repeated; burst_id is the burst that completed it.
  hits INTEGER NOT NULL DEFAULT 1,
  evidence TEXT NOT NULL DEFAULT '[]',
  -- What the holds across the evidence look like (wheel-like, fixed-hold,
  -- variable-hold, no-hold-data). An annotation for the admin, not a verdict.
  note TEXT NOT NULL DEFAULT '',
  UNIQUE(burst_id, signature)
);
CREATE INDEX IF NOT EXISTS input_detections_steamid ON input_detections(steamid, at);
CREATE INDEX IF NOT EXISTS input_detections_match ON input_detections(match_id);

-- What Steam itself says about an account: age, bans elsewhere, L4D1 hours,
-- level, and whose copy of the game it plays on. One row per player, refreshed
-- at login, at match start and slowly in the background (src/steamSignals.ts).
-- Context for an admin reading a player page, never a verdict, and admin-only:
-- nothing here may reach a public route, the WebSocket or a public embed.
-- NULL always means "not known": a private profile or a failed call leaves the
-- column alone rather than writing a zero that would read as a fact.
CREATE TABLE IF NOT EXISTS player_steam_signals (
  steamid TEXT PRIMARY KEY REFERENCES players(steamid),
  -- Unix seconds, as Steam sends it. Absent from a private profile, and kept
  -- once seen: an account's creation date does not change when it goes private.
  time_created INTEGER,
  -- communityvisibilitystate: 3 is public, anything else is not.
  visibility INTEGER,
  -- 1 once the account has set up a community profile.
  profile_state INTEGER,
  vac_banned INTEGER,
  vac_bans INTEGER,
  game_bans INTEGER,
  -- As of bans_checked_at, not as of now: Steam sends an age, not a date.
  days_since_last_ban INTEGER,
  community_banned INTEGER,
  economy_ban TEXT,
  bans_checked_at TEXT,
  -- 0: game details are private, so l4d1_minutes is whatever was last seen
  -- (or NULL) and must be shown as hidden. 1 with NULL minutes: the library
  -- is visible and L4D1 is not in it.
  games_visible INTEGER,
  l4d1_minutes INTEGER,
  steam_level INTEGER,
  -- Family Sharing. Steam only names a lender while the player is in game, so
  -- this is the last NON-zero answer and when it was given, not the current one.
  lender_id TEXT,
  lender_seen_at TEXT,
  checked_at TEXT NOT NULL
);

-- What has already been said in the admin feed about a player's Steam account,
-- so the same fact is not posted again every match. The marker is what makes a
-- condition news again: the ban count for recent_ban, the lender's id for
-- banned_lender.
CREATE TABLE IF NOT EXISTS steam_signal_alerts (
  player_id TEXT NOT NULL REFERENCES players(steamid),
  kind TEXT NOT NULL,
  marker TEXT NOT NULL,
  match_id INTEGER,
  at TEXT NOT NULL,
  PRIMARY KEY (player_id, kind, marker)
);
`;

const DEFAULT_SETTINGS: Record<string, string> = {
  invite_code: 'change-me',
  ready_seconds: '120',
  vote_seconds: '30',
  map_pool: JSON.stringify(['no_mercy', 'death_toll', 'dead_air', 'blood_harvest']),
  discord_webhook_url: '',
  discord_queue_thresholds: JSON.stringify([4, 6]),
  discord_pug_role_id: '',
  // Empty: guild membership alone activates a linked player. A role id: the
  // member must also hold that role.
  discord_required_role_id: '',
  // 1: the bot makes Team A / Team B voice channels per match and moves players in.
  discord_voice_enabled: '1',
  // Where the sweep drops anyone still in a team channel who was not pulled
  // out of one of their own. Empty means leave them where they are, which
  // Discord turns into being dropped out of voice when the channel goes.
  discord_lobby_channel_id: '',
  // Queueing needs a linked Discord account that is in the guild.
  // Presses per second, in the air on the hunter claw, at or above which an
  // airborne phase counts toward pounce_spam. See DEFAULT_THRESHOLDS in
  // src/inputStats.ts for why 12. A NEW key on purpose: the first signature
  // seeded input_pounce_spam_threshold = 12 TICKS into production, and seeding
  // never overwrites, so that row is now ignored rather than reinterpreted.
  input_pounce_min_rate: '12',
  // The same, for primary fire on a pistol sustained over three seconds.
  input_pistol_min_rate: '12',
  require_discord_to_queue: '1',
  // Pressing Ready needs that account to be in a voice channel on the guild.
  require_voice_to_ready: '1',
  discord_invite_url: '',
  // Private channel the bot posts the admin feed to; empty turns the feed off.
  // Empty is the off state: no role is let into the team voice channels.
  discord_staff_role_id: '',
  discord_admin_channel_id: '',
  // Where match results are posted. Empty keeps them in the queue channel.
  discord_results_channel_id: '',
  // Games before a player's per-match figures are ranked for the profile
  // badges. Deliberately higher than RANKED_MIN_GAMES: three games is enough
  // for a rating to be worth showing and nowhere near enough for a per-match
  // average to mean anything, so the badges used to land on whoever had
  // played least.
  standing_min_games: '10',
  admin_feed_reports: '1',
  ticket_mod_ban_max_minutes: '10080',
  ticket_reports_per_day: '5',
  admin_feed_actions: '1',
  admin_feed_penalties: '1',
  admin_feed_accounts: '1',
  admin_feed_problems: '1',
  replay_retention_days: '90',
  demo_retention_days: '90',
  demo_autorecord_days: '7',
  replay_free_floor_gb: '10',
  noshow_minutes: '10',
  noshow_min_connected: '6',
  no_round_minutes: '30',
  // Where a server is sent after a cancelled match empties it. No Mercy 1 is
  // the stock default map, so an idle box looks the way a fresh one does.
  reset_map: 'l4d_hospital01_apartment',
  // SourceMod flags a website admin gets on every game box. Root, to match
  // the hand-written entries already in admins_simple.ini rather than create
  // a second tier nobody can keep straight (owner, 2026-09-21).
  server_admin_flags: 'z',
  // Reconnect allowance per player per match, and whether the game unpauses
  // itself once everyone is back. Pushed to the plugin at match setup.
  leave_budget_seconds: '300',
  leave_auto_unpause: '1',
  penalties_enabled: '1',
  penalty_window_days: '7',
  penalty_minutes: JSON.stringify([5, 15, 60, 1440]),
  // Minimum shared matches before a with/against win rate is worth showing.
  // Its own knob rather than a reuse of standing_min_games for the reason
  // given in 5d2ae85: "we have played five together" and "is your per-match
  // average meaningful" are different questions with different answers.
  chemistry_min_games: '5',
  // Endorsements a player may give per match, and how long after the match
  // ends giving stays open. The window exists so a pair cannot decide one
  // evening to farm every match they have ever played together.
  endorse_budget: '2',
  endorse_window_hours: '24',
  // Before a kind becomes a visible title: that many endorsements of the kind,
  // and that many matches played at all.
  endorse_title_min: '5',
  endorse_title_min_games: '10',
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
  // What the game is doing right now, as last reported by the plugin, and
  // since when. NULL until a plugin that emits PHASE has spoken.
  ensureColumn(db, 'match_live', 'phase', 'TEXT');
  ensureColumn(db, 'match_live', 'phase_since', 'TEXT');
  ensureColumn(db, 'match_live', 'phase_team', 'TEXT');
  ensureColumn(db, 'match_live', 'phase_limit', 'INTEGER NOT NULL DEFAULT 0');
  ensureColumn(db, 'match_live', 'phase_leave', 'INTEGER NOT NULL DEFAULT 0');
  // The not-ready roster as last reported (JSON), and when that report
  // arrived, so the seconds since can be charged to those players.
  ensureColumn(db, 'match_live', 'phase_unready', 'TEXT');
  ensureColumn(db, 'match_live', 'phase_unready_at', 'TEXT');
  // -1, not 0 or NULL: ALTER TABLE ADD COLUMN on a populated table needs a
  // non-null default, and 0 is a real value here (an event in the first
  // millisecond of a round). -1 means "recorded before round timing existed".
  ensureColumn(db, 'match_live_events', 'half', 'INTEGER NOT NULL DEFAULT -1');
  ensureColumn(db, 'match_live_events', 't_ms', 'INTEGER NOT NULL DEFAULT -1');
  // Which map a round's share of the aim prior belongs to, and which analyzer
  // built it. A map's pool is DEFINED as the sum of its current-version shares
  // (see poolRounds in src/integrity/store.ts), so a share has to say both. A
  // row from before these existed reads as map NULL, version 0, which no pool
  // will ever sum: it is rebuilt the next time its round is measured.
  ensureColumn(db, 'integrity_prior_rounds', 'map', 'TEXT');
  ensureColumn(db, 'integrity_prior_rounds', 'analyzer_version', 'INTEGER NOT NULL DEFAULT 0');
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
  // Who put this player on the roster. 'web' is the site's own roster push for
  // a match it queued. 'udp' is a MATCH_ROSTER line off the log stream: every
  // player of a match started in game, and every late joiner on any match.
  // The stream is lossy and forgeable, so a 'udp' row is only a claim until
  // the RCON dump names the same player; see reconcile in src/matchResult.ts.
  // Defaulted to 'web' so rows that predate it are never second-guessed.
  ensureColumn(db, 'match_players', 'source', "TEXT NOT NULL DEFAULT 'web'");
  // 0 keeps the row for the record and keeps the player out of the rating
  // step, now and on every later recompute. unrated_reason says why.
  ensureColumn(db, 'match_players', 'rated', 'INTEGER NOT NULL DEFAULT 1');
  ensureColumn(db, 'match_players', 'unrated_reason', 'TEXT');
  // Input detections became one row per player, match and signature, carrying
  // how many bursts qualified and which. Rows from before this default to one
  // hit and no evidence list; scripts/rerun-input-signatures.ts rebuilds them.
  ensureColumn(db, 'input_detections', 'hits', 'INTEGER NOT NULL DEFAULT 1');
  ensureColumn(db, 'input_detections', 'evidence', "TEXT NOT NULL DEFAULT '[]'");
  // Which clock a burst's intervals are in. Everything stored before this was
  // plugin 0.1.0, which is what the default says.
  ensureColumn(db, 'input_bursts', 'wire', 'INTEGER NOT NULL DEFAULT 1');
  ensureColumn(db, 'input_bursts', 'server_span', 'INTEGER');
  ensureColumn(db, 'input_bursts', 'holds', 'TEXT');
  ensureColumn(db, 'input_detections', 'note', "TEXT NOT NULL DEFAULT ''");
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
  // What players.status was when the account was banned, so the end of the
  // ban can put it back. NULL when the account is not banned, and on a row
  // banned before this column existed, which restoreStatus in
  // src/admin/players.ts works out from the evidence instead.
  ensureColumn(db, 'players', 'status_before_ban', 'TEXT');
  // Bumped to end every session a player holds at once: the signed cookie
  // carries the value it was issued under. See src/session.ts.
  ensureColumn(db, 'players', 'session_epoch', 'INTEGER NOT NULL DEFAULT 0');
  // Every Discord link there has ever been, open or closed. The players row
  // only knows the link as it stands, which is what let one Discord account
  // serve any number of Steam accounts in sequence with nothing to show for
  // it. No foreign key on `steamid`, like the evidence tables: a merge moves
  // these rows rather than being blocked by them. See linkDiscord.
  db.exec(`CREATE TABLE IF NOT EXISTS discord_link_history (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    steamid      TEXT NOT NULL,
    discord_id   TEXT NOT NULL,
    discord_name TEXT NOT NULL DEFAULT '',
    linked_at    TEXT NOT NULL,
    linked_by    TEXT NOT NULL,
    unlinked_at  TEXT,
    unlinked_by  TEXT
  )`);
  db.exec('CREATE INDEX IF NOT EXISTS idx_discord_link_history_discord ON discord_link_history (discord_id)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_discord_link_history_steamid ON discord_link_history (steamid)');
  // Links made before this table existed get an open row, so the first unlink
  // after the upgrade has something to close. `backfill` marks linked_at as
  // the time of the upgrade rather than of the link, which nobody recorded.
  db.prepare(
    `INSERT INTO discord_link_history (steamid, discord_id, discord_name, linked_at, linked_by)
     SELECT p.steamid, p.discord_id, COALESCE(p.discord_name, ''), ?, 'backfill' FROM players p
     WHERE p.discord_id IS NOT NULL AND NOT EXISTS (
       SELECT 1 FROM discord_link_history h
       WHERE h.steamid = p.steamid AND h.discord_id = p.discord_id AND h.unlinked_at IS NULL
     )`,
  ).run(new Date().toISOString());
  // Player-authored profile fields. All three are constrained rather than
  // trusted: see src/profileFields.ts. They are columns rather than rows in
  // player_links because they are one-per-player and are rendered with the
  // name itself rather than as a list.
  ensureColumn(db, 'players', 'bio', 'TEXT');
  ensureColumn(db, 'players', 'pronouns', 'TEXT');
  ensureColumn(db, 'players', 'country', 'TEXT');
  // Twitch identity. The id is canonical and the login is a cache: Twitch
  // logins change and ids do not, so every lookup and every unique constraint
  // keys on the id. Partial index for the same reason as discord_id: almost
  // every row is NULL and NULLs must not collide.
  ensureColumn(db, 'players', 'twitch_id', 'TEXT');
  ensureColumn(db, 'players', 'twitch_name', 'TEXT');
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS players_twitch_id ON players(twitch_id) WHERE twitch_id IS NOT NULL');
  // Second Steam accounts, pointed at the one account their owner really is.
  // Written by a merge and read on every line the game server sends, so a
  // reconnect on the alt is rostered as the person rather than as a new
  // identity with its own rating. No foreign key on `steamid`: the whole
  // point is that the alt's player row is gone, and the id still has to
  // resolve. See src/aliases.ts.
  db.exec(`CREATE TABLE IF NOT EXISTS player_aliases (
    steamid      TEXT PRIMARY KEY,
    canonical_id TEXT NOT NULL REFERENCES players(steamid),
    created_at   TEXT NOT NULL,
    created_by   TEXT NOT NULL
  )`);
  db.exec('CREATE INDEX IF NOT EXISTS idx_player_aliases_canonical ON player_aliases (canonical_id)');
  // Where accounts connect from, for noticing that two of them are one
  // person. The address is NEVER stored: ip_hash is an HMAC under a salt
  // generated once per installation (settings.ip_hash_salt), so these rows
  // answer "same connection?" and nothing else. See src/playerNetworks.ts.
  db.exec(`CREATE TABLE IF NOT EXISTS player_networks (
    player_id  TEXT NOT NULL,
    ip_hash    TEXT NOT NULL,
    country    TEXT,
    first_seen TEXT NOT NULL,
    last_seen  TEXT NOT NULL,
    seen_count INTEGER NOT NULL DEFAULT 1,
    PRIMARY KEY (player_id, ip_hash)
  )`);
  db.exec('CREATE INDEX IF NOT EXISTS idx_player_networks_hash ON player_networks (ip_hash)');
  // A voided match: an admin decided the result must not count. It is also
  // set to 'aborted', which is what drops it from every stat query.
  // SourceTV, per server: anyone can watch a live match, and the tv_delay is
  // what keeps that from being ghosting.
  ensureColumn(db, 'servers', 'tv_port', 'INTEGER');
  ensureColumn(db, 'servers', 'tv_password', 'TEXT');
  ensureColumn(db, 'servers', 'tv_enabled', 'INTEGER NOT NULL DEFAULT 0');
  // Whether the matchmaker may claim this box at all, which is a separate
  // question from whether it is idle right now. Defaults to 1 so every existing
  // row stays claimable across this migration; taking a server out of rotation
  // has to be a deliberate act, never a side effect of upgrading.
  ensureColumn(db, 'servers', 'enabled', 'INTEGER NOT NULL DEFAULT 1');
  // Off by default, and turned on per box by an admin who can watch the
  // first one. Asking a box to quit when nothing brings it back leaves it
  // gone until someone opens its host's control panel, so this is not a
  // switch to flip for four servers at once. See src/serverRestart.ts.
  ensureColumn(db, 'servers', 'restart_after_match', 'INTEGER NOT NULL DEFAULT 0');
  // Object key once a demo has been copied to R2, NULL while it is still only
  // on disk. The row carries both states on purpose: the local file is deleted
  // only after the upload is verified, so for a moment a demo is in both places
  // and the key is what says which copy the download route should serve.
  ensureColumn(db, 'match_demos', 'r2_key', 'TEXT');
  ensureColumn(db, 'match_demos', 'r2_at', 'TEXT');
  ensureColumn(db, 'matches', 'voided_at', 'TEXT');
  ensureColumn(db, 'matches', 'void_reason', 'TEXT');
  // How a campaign VPK reaches this box. 'local' is a filesystem copy, which
  // is only correct when the web app runs on the same machine as the game
  // server; anything else needs 'ftp'. Defaulted to 'local' with a NULL
  // addons_dir so an existing row is inert until an admin configures it:
  // a half-configured transport must no-op, never write to a guessed path.
  ensureColumn(db, 'servers', 'addons_transport', "TEXT NOT NULL DEFAULT 'local'");
  ensureColumn(db, 'servers', 'addons_dir', 'TEXT');
  ensureColumn(db, 'servers', 'ftp_host', 'TEXT');
  ensureColumn(db, 'servers', 'ftp_port', 'INTEGER');
  ensureColumn(db, 'servers', 'ftp_user', 'TEXT');
  ensureColumn(db, 'servers', 'ftp_password', 'TEXT');
  // Path to the private key used by the 'sftp' addons transport. Our own second
  // machine (Riverside) is reachable only over ssh: no shared filesystem like
  // Dallas, no FTP like Chicago. Kept as a path, not the key material, so the
  // secret stays in the filesystem with its own permissions and never in a DB
  // backup. Reuses ftp_host/ftp_port/ftp_user for the connection details.
  ensureColumn(db, 'servers', 'ssh_key_path', 'TEXT');
  // Whether this box's dlc4 mappack has been proved present by probing its
  // own transport (see src/dlc4.ts), not set by hand. Defaults to 0 so an
  // existing row stays out of the dlc4 map pool until it is actually checked.
  ensureColumn(db, 'servers', 'has_dlc4', 'INTEGER NOT NULL DEFAULT 0');
  // Signed log lines; see src/logAuth.ts. The secret is generated here and
  // pushed to the box over rcon, NULL until an admin asks for one. log_auth is
  // off | log | enforce and defaults to off, so nothing changes for a server
  // until someone turns it on. The last two are where the replay check had
  // got to, kept so a backend restart does not reopen the window.
  ensureColumn(db, 'servers', 'log_secret', 'TEXT');
  ensureColumn(db, 'servers', 'log_auth', "TEXT NOT NULL DEFAULT 'off'");
  ensureColumn(db, 'servers', 'log_auth_boot', 'INTEGER NOT NULL DEFAULT 0');
  ensureColumn(db, 'servers', 'log_auth_seq', 'INTEGER NOT NULL DEFAULT 0');
  // Moderators: may work tickets and nothing else. Deliberately not read by
  // serverAdmins.ts, so the flag grants nothing on a game server.
  ensureColumn(db, 'players', 'is_mod', 'INTEGER NOT NULL DEFAULT 0');
  // The ticket a ban was issued from, so the ban list and the ticket point at
  // each other. Null for every ban issued from the Players tab.
  ensureColumn(db, 'bans', 'ticket_id', 'INTEGER');
  // "Somebody has looked at this file." What takes a player off the Needs a
  // look list, and what puts them back when something newer arrives.
  //
  // No foreign key on steamid, like the evidence tables: the evidence that
  // raises a file can sit under a merged alt's id, and a review of that file
  // must not be blocked by whether that id still has a player row. No CHECK
  // anywhere: this is a log, and a log has nothing to constrain.
  db.exec(`CREATE TABLE IF NOT EXISTS player_reviews (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    steamid     TEXT NOT NULL,
    reviewed_by TEXT NOT NULL,
    reviewed_at TEXT NOT NULL,
    note        TEXT NOT NULL DEFAULT ''
  )`);
  db.exec('CREATE INDEX IF NOT EXISTS player_reviews_steamid ON player_reviews (steamid, reviewed_at)');
  ensureTicketSchema(db);
  migrateLegacyReports(db);
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
