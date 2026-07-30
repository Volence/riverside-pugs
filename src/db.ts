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
};

export function openDb(path: string): DB {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA);
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
