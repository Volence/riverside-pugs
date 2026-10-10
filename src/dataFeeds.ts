import type { DB } from './db.js';
import type { DataFeedEvent, ConnStage, SiLife } from './dataFeedParse.js';
import { roundOrdinal } from './roundStatLines.js';
import { campaignForMap, DLC4_CAMPAIGNS } from './campaigns.js';

/**
 * Storage for pug-match's data feeds (docs/data-feeds-2026-10-10.md):
 *
 *   A. match_connect_funnel and player_pack_status: when each rostered player
 *      connected, got in game, joined a team and readied, per map, and why
 *      they dropped; and whether a player is known to have the L4D2 map pack.
 *   B. match_survivor_downs, match_round_feeds, and the flow/prog/cause
 *      columns on match_live_events: where and why survivors went down.
 *   C. match_si_lives: one row per infected life.
 *
 * Like the rest of the UDP feed this is lossy and never read when a result is
 * computed. Every write is an upsert keyed on what the plugin sent, so a
 * duplicated datagram lands on itself. Nothing here is shown to players.
 */

export function ensureDataFeedsSchema(db: DB): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS match_connect_funnel (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      match_id    INTEGER NOT NULL REFERENCES matches(id),
      -- '' on a mapload row, which is the map's own start, not a player's.
      steamid     TEXT    NOT NULL,
      map         TEXT    NOT NULL,
      stage       TEXT    NOT NULL CHECK (stage IN ('mapload','connect','ingame','team','ready','drop')),
      -- Unix seconds on the game server's clock, as sent.
      at          INTEGER NOT NULL,
      team        INTEGER,
      -- drop only: 1 = never got in game on this map (dropped while loading).
      pre         INTEGER,
      secs        INTEGER,
      -- drop only: the engine's reason string. A client can write its own,
      -- so it is evidence to read, never a verdict.
      reason      TEXT,
      received_at TEXT    NOT NULL DEFAULT (datetime('now')),
      UNIQUE (match_id, steamid, map, stage, at)
    );
    CREATE INDEX IF NOT EXISTS match_connect_funnel_player ON match_connect_funnel (steamid, at);

    -- What the site knows about a player's L4D2 map pack, newest evidence
    -- first: 'ok' = got in game on an L4D2-port map; 'missing' = dropped
    -- while loading one with a missing-map/file reason; 'suspect' = dropped
    -- while loading one with a generic reason and never seen to load one.
    -- Read by packStatus (the future pack-check vote gate).
    CREATE TABLE IF NOT EXISTS player_pack_status (
      steamid  TEXT PRIMARY KEY,
      status   TEXT NOT NULL CHECK (status IN ('ok','missing','suspect')),
      map      TEXT NOT NULL,
      match_id INTEGER,
      reason   TEXT,
      at       TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS match_survivor_downs (
      match_id INTEGER NOT NULL REFERENCES matches(id),
      ordinal  INTEGER NOT NULL,
      half     INTEGER NOT NULL,
      t_ms     INTEGER NOT NULL,
      steamid  TEXT    NOT NULL,
      kind     TEXT    NOT NULL CHECK (kind IN ('incap','death')),
      cause    TEXT    NOT NULL,
      attacker TEXT,
      flow     INTEGER,
      prog     INTEGER,
      pinned   INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (match_id, ordinal, half, steamid, kind, t_ms)
    );

    -- One row per round: where the survivors were when it ended, and how many
    -- SI lives the plugin recorded (lives) against how many rows arrived.
    CREATE TABLE IF NOT EXISTS match_round_feeds (
      match_id     INTEGER NOT NULL REFERENCES matches(id),
      ordinal      INTEGER NOT NULL,
      half         INTEGER NOT NULL,
      end_prog     INTEGER,
      end_flows    TEXT,
      si_lives     INTEGER,
      si_dropped   INTEGER,
      PRIMARY KEY (match_id, ordinal, half)
    );

    CREATE TABLE IF NOT EXISTS match_si_lives (
      match_id      INTEGER NOT NULL REFERENCES matches(id),
      ordinal       INTEGER NOT NULL,
      half          INTEGER NOT NULL,
      -- The life's index within the round, as the plugin numbered it.
      idx           INTEGER NOT NULL,
      steamid       TEXT    NOT NULL,
      zc            INTEGER NOT NULL,
      ghost_ms      INTEGER,
      spawn_ms      INTEGER,
      spawn_flow    INTEGER,
      spawn_prog    INTEGER,
      first_hit_ms  INTEGER,
      dmg           INTEGER NOT NULL DEFAULT 0,
      dmg_incapped  INTEGER NOT NULL DEFAULT 0,
      end_ms        INTEGER,
      end_cause     TEXT    NOT NULL,
      killer        TEXT,
      respawn_s     INTEGER,
      PRIMARY KEY (match_id, ordinal, half, idx)
    );
    CREATE INDEX IF NOT EXISTS match_si_lives_player ON match_si_lives (steamid);
  `);
  for (const [col, ddl] of [['flow', 'INTEGER'], ['prog', 'INTEGER'], ['cause', 'TEXT']] as const) {
    const cols = db.prepare('PRAGMA table_info(match_live_events)').all() as { name: string }[];
    if (!cols.some((c) => c.name === col)) db.exec(`ALTER TABLE match_live_events ADD COLUMN ${col} ${ddl}`);
  }
}

/** A map from the L4D2 port pack: L4D2 naming (c<n>m<n>_) in one of the dlc4
 *  campaigns. The Sacrifice's river maps are filed under Passifice but are
 *  stock L4D1, which is why the name has to match as well. */
export function isL4d2PortMap(map: string): boolean {
  if (!/^c\d+m\d+_/i.test(map)) return false;
  const c = campaignForMap(map);
  return c !== null && DLC4_CAMPAIGNS.has(c);
}

/** A disconnect reason that says the client lacked a map or file. Reasons
 *  seen so far are guesses until a real drop is captured (see the doc); a
 *  self-drop usually reaches the server as "Disconnect by user.". */
const MISSING_RE = /missing\s+(map|file)|\b(map|file)\b[^.]{0,80}\b(missing|not found|could not be loaded|unable to load)|couldn'?t (find|load) map|unable to (find|load) map/i;

export function isMissingReason(reason: string | null): boolean {
  return reason !== null && MISSING_RE.test(reason);
}

export type PackStatus = 'ok' | 'missing' | 'suspect' | 'unknown';

/** The flag the future pack-check vote gate reads. 'unknown' = never seen on
 *  an L4D2-port map either way. */
export function packStatus(db: DB, steamid: string): PackStatus {
  const r = db.prepare('SELECT status FROM player_pack_status WHERE steamid = ?').get(steamid) as { status: PackStatus } | undefined;
  return r?.status ?? 'unknown';
}

export function packStatusMany(db: DB, steamids: string[]): Map<string, PackStatus> {
  const out = new Map<string, PackStatus>();
  for (const id of steamids) out.set(id, packStatus(db, id));
  return out;
}

function setPack(db: DB, steamid: string, status: Exclude<PackStatus, 'unknown'>, map: string, matchId: number, reason: string | null, now: Date): void {
  db.prepare(
    `INSERT INTO player_pack_status (steamid, status, map, match_id, reason, at) VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT (steamid) DO UPDATE SET status = excluded.status, map = excluded.map,
       match_id = excluded.match_id, reason = excluded.reason, at = excluded.at`,
  ).run(steamid, status, map, matchId, reason, now.toISOString());
}

/** The match a token names, while it is being set up or played. The funnel
 *  matters most before go-live, so configuring counts. */
function matchOf(db: DB, token: string, live: boolean): number | null {
  const sql = live
    ? "SELECT id FROM matches WHERE token = ? AND state = 'live'"
    : "SELECT id FROM matches WHERE token = ? AND state IN ('configuring','live')";
  const r = db.prepare(sql).get(token) as { id: number } | undefined;
  return r?.id ?? null;
}

/** Store one data feed line. Returns true when something the admin live board
 *  shows may have changed (a funnel stage), so the caller can nudge it. */
export function recordDataFeed(db: DB, ev: DataFeedEvent, now = new Date()): boolean {
  switch (ev.kind) {
    case 'conn': {
      const id = matchOf(db, ev.token, false);
      if (id === null) return false;
      const inserted = db.prepare(
        `INSERT OR IGNORE INTO match_connect_funnel (match_id, steamid, map, stage, at, team, pre, secs, reason)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(id, ev.steamid, ev.map, ev.stage, ev.at, ev.team, ev.pre === null ? null : ev.pre ? 1 : 0, ev.secs, ev.reason).changes > 0;
      if (isL4d2PortMap(ev.map)) {
        if (ev.stage === 'ingame') setPack(db, ev.steamid, 'ok', ev.map, id, null, now);
        else if (ev.stage === 'drop' && ev.pre === true) {
          if (isMissingReason(ev.reason)) setPack(db, ev.steamid, 'missing', ev.map, id, ev.reason, now);
          else if (packStatus(db, ev.steamid) === 'unknown') setPack(db, ev.steamid, 'suspect', ev.map, id, ev.reason, now);
        }
      }
      return inserted;
    }
    case 'map_load': {
      const id = matchOf(db, ev.token, false);
      if (id === null) return false;
      db.prepare(
        `INSERT OR IGNORE INTO match_connect_funnel (match_id, steamid, map, stage, at) VALUES (?, '', ?, 'mapload', ?)`,
      ).run(id, ev.map, ev.at);
      return true;
    }
    case 'down': {
      const id = matchOf(db, ev.token, true);
      if (id === null) return false;
      db.prepare(
        `INSERT INTO match_survivor_downs (match_id, ordinal, half, t_ms, steamid, kind, cause, attacker, flow, prog, pinned)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (match_id, ordinal, half, steamid, kind, t_ms) DO NOTHING`,
      ).run(id, roundOrdinal(db, id, ev.half), ev.half, ev.tMs, ev.steamid, ev.down, ev.cause, ev.by, ev.flow, ev.prog, ev.pinned ? 1 : 0);
      return false;
    }
    case 'round_flow': {
      const id = matchOf(db, ev.token, true);
      if (id === null) return false;
      const flows = JSON.stringify(Object.fromEntries(ev.flows.map((f) => [f.steamid, f.flow])));
      db.prepare(
        `INSERT INTO match_round_feeds (match_id, ordinal, half, end_prog, end_flows) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (match_id, ordinal, half) DO UPDATE SET end_prog = excluded.end_prog, end_flows = excluded.end_flows`,
      ).run(id, roundOrdinal(db, id, ev.half), ev.half, ev.prog, flows);
      return false;
    }
    case 'si_lives': {
      const id = matchOf(db, ev.token, true);
      if (id === null) return false;
      const ordinal = roundOrdinal(db, id, ev.half);
      const ins = db.prepare(
        `INSERT INTO match_si_lives (match_id, ordinal, half, idx, steamid, zc, ghost_ms, spawn_ms, spawn_flow, spawn_prog,
           first_hit_ms, dmg, dmg_incapped, end_ms, end_cause, killer, respawn_s)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (match_id, ordinal, half, idx) DO UPDATE SET
           steamid = excluded.steamid, zc = excluded.zc, ghost_ms = excluded.ghost_ms, spawn_ms = excluded.spawn_ms,
           spawn_flow = excluded.spawn_flow, spawn_prog = excluded.spawn_prog, first_hit_ms = excluded.first_hit_ms,
           dmg = excluded.dmg, dmg_incapped = excluded.dmg_incapped, end_ms = excluded.end_ms,
           end_cause = excluded.end_cause, killer = excluded.killer, respawn_s = excluded.respawn_s`,
      );
      db.transaction(() => {
        ev.lives.forEach((l: SiLife, n: number) => ins.run(
          id, ordinal, ev.half, ev.first + n, l.steamid, l.zc, l.ghostMs, l.spawnMs, l.spawnFlow, l.spawnProg,
          l.firstHitMs, l.dmg, l.dmgIncapped, l.endMs, l.end, l.killer, l.respawnS,
        ));
      })();
      return false;
    }
    case 'si_lives_end': {
      const id = matchOf(db, ev.token, true);
      if (id === null) return false;
      db.prepare(
        `INSERT INTO match_round_feeds (match_id, ordinal, half, si_lives, si_dropped) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (match_id, ordinal, half) DO UPDATE SET si_lives = excluded.si_lives, si_dropped = excluded.si_dropped`,
      ).run(id, roundOrdinal(db, id, ev.half), ev.half, ev.lives, ev.dropped);
      return false;
    }
  }
}

/** A replayed or restarted half: its downs, lives and round row belong to
 *  the previous attempt. Called beside resetRoundLines. */
export function resetRoundFeeds(db: DB, matchId: number, ordinal: number, half: 1 | 2): void {
  db.transaction(() => {
    for (const t of ['match_survivor_downs', 'match_si_lives', 'match_round_feeds']) {
      db.prepare(`DELETE FROM ${t} WHERE match_id = ? AND ordinal = ? AND half = ?`).run(matchId, ordinal, half);
    }
  })();
}

/** Where a rostered player is in getting onto the CURRENT map, from the
 *  funnel: null when no funnel line has arrived for them on it (an older
 *  plugin, or a lost datagram), which the board shows as nothing at all. */
export type FunnelStage = 'loading' | 'in_game' | 'on_team' | 'ready' | 'dropped';

export interface FunnelState { stage: FunnelStage; pack: PackStatus }

const STAGE_RANK: Record<ConnStage, number> = { connect: 1, ingame: 2, team: 3, ready: 4, drop: 0 };

export function funnelFor(db: DB, matchId: number, map: string | null): Map<string, FunnelState> {
  const out = new Map<string, FunnelState>();
  // The newest map the funnel heard of, when the caller does not know it.
  const cur = map ?? (db.prepare(
    "SELECT map FROM match_connect_funnel WHERE match_id = ? ORDER BY at DESC, id DESC LIMIT 1",
  ).get(matchId) as { map: string } | undefined)?.map ?? null;
  if (cur === null) return out;
  const rows = db.prepare(
    `SELECT steamid, stage, at, id FROM match_connect_funnel
      WHERE match_id = ? AND steamid != '' AND (map = ? OR stage IN ('connect','drop'))
      ORDER BY at, id`,
  ).all(matchId, cur) as { steamid: string; stage: ConnStage; at: number; id: number }[];
  // In time order: a connect or a drop always moves them (a reconnect starts
  // over), the per-map stages only ever move them forward. A connect on an
  // earlier map still counts, because a changelevel sends no new connect:
  // until this map's ingame arrives they are loading it.
  const best = new Map<string, ConnStage>();
  for (const r of rows) {
    const prev = best.get(r.steamid);
    if (r.stage === 'connect' || r.stage === 'drop' || prev === undefined || STAGE_RANK[r.stage] > STAGE_RANK[prev]) best.set(r.steamid, r.stage);
  }
  for (const [steamid, s] of best) {
    const stage: FunnelStage = s === 'connect' ? 'loading' : s === 'ingame' ? 'in_game' : s === 'team' ? 'on_team' : s === 'ready' ? 'ready' : 'dropped';
    out.set(steamid, { stage, pack: packStatus(db, steamid) });
  }
  return out;
}
