import type { DB } from './db.js';
import { statDef } from './statKeys.js';
import type { LogEvent } from './logParse.js';
import type { ServerReleaser } from './serverRelease.js';

/** How long without a HEARTBEAT before a match is shown as stale. The plugin
 *  emits one every 30s, so this tolerates three consecutive losses on a lossy
 *  transport before the page starts hedging. */
export const STALE_AFTER_MS = 120_000;

export interface LivePlayer {
  steamid: string;
  name: string;
  /** Cosmetic counters from the UDP feed. Empty until the first LIVESTAT
   *  arrives, and missing keys mean "not measured", never zero. */
  stats: Record<string, number>;
}
export interface LiveMap {
  ordinal: number;
  map: string;
  teamAScore: number;
  teamBScore: number;
  /** This map's own per-player stats, keyed by steamid. Derived from the
   *  difference between consecutive end-of-map snapshots. */
  stats: Record<string, Record<string, number>>;
}
export interface LiveDemo { ordinal: number; map: string; bytes: number }

export interface LiveEvent {
  seq: number;
  kind: string;
  /** Which map of the match it happened on, zero-based. */
  mapOrdinal: number;
  /** Which half of that map, 1 or 2. -1 when the event carried no round
   *  timing, which is what a pre-round-capture match looks like. */
  half: number;
  /** Milliseconds since that round went live, or -1 for no timing. Pairs of
   *  events are only comparable within one map and half. */
  tMs: number;
  actor: { steamid: string; name: string };
  target: { steamid: string; name: string } | null;
  value: number;
}
export interface LiveMatch {
  id: number;
  campaign: string;
  currentMap: string | null;
  teamA: LivePlayer[];
  teamB: LivePlayer[];
  maps: LiveMap[];
  teamAScore: number;
  teamBScore: number;
  lastSeen: string | null;
  stale: boolean;
  /** Demos completed so far this match. Metadata only; downloading still
   *  requires a session (see routes/stats.ts). */
  demos: LiveDemo[];
  /** Most recent first, capped. A summed total cannot tell you whether that
   *  was one big deadly pounce or six small ones; this can. */
  events: LiveEvent[];
}

/**
 * Live spectator state, fed from the lossy UDP feed.
 *
 * This is the cosmetic half of the two-channel design: every value here comes
 * from `logaddress` datagrams that may be dropped, duplicated or reordered, and
 * none of it is ever read back when computing a result. The authoritative
 * record is written once at completion from the rcon dump, into different
 * tables. A wrong live score self-corrects on the next datagram and is
 * overwritten wholesale at completion, so the worst case here is a page that
 * is briefly out of date, never a rating computed from bad data.
 */

/** Resolve a token to a match that is actually live. Returns null otherwise,
 *  which is what makes every recorder below safe to call on a stray datagram. */
function liveMatchIdOf(db: DB, token: string): number | null {
  const row = db
    .prepare("SELECT id FROM matches WHERE token = ? AND state = 'live'")
    .get(token) as { id: number } | undefined;
  return row?.id ?? null;
}

function touch(db: DB, matchId: number, map?: string | null): void {
  db.prepare(
    `INSERT INTO match_live (match_id, current_map, last_seen)
     VALUES (?, ?, datetime('now'))
     ON CONFLICT (match_id) DO UPDATE SET
       last_seen = datetime('now'),
       -- Only advance the map when this event carries one, so a HEARTBEAT
       -- cannot blank out the map a MATCH_START established.
       current_map = COALESCE(excluded.current_map, match_live.current_map)`,
  ).run(matchId, map ?? null);
}

export function recordMatchStart(db: DB, token: string, map: string): void {
  const id = liveMatchIdOf(db, token);
  if (id === null) return;
  touch(db, id, map);
}

export function recordHeartbeat(db: DB, token: string): void {
  const id = liveMatchIdOf(db, token);
  if (id === null) return;
  touch(db, id);
}

/**
 * Store the cosmetic per-player counters for the live page.
 *
 * Self-visibility stats are stripped HERE, at the write, rather than trusted
 * not to arrive. The plugin currently sends only public keys, but the live
 * payload is served to anonymous viewers with no per-viewer redaction step, so
 * a private key that ever reached this table would be published to everyone.
 * Filtering at the boundary means the scratch table simply cannot hold one.
 * Keys absent from the registry (hp, ck, sidmg, sikill, ff, rev) are the
 * always-public core and pass through.
 */
export function recordLiveStat(
  db: DB, token: string, steamid: string, stats: Record<string, number>,
): void {
  const id = liveMatchIdOf(db, token);
  if (id === null) return;
  const safe: Record<string, number> = {};
  for (const [k, v] of Object.entries(stats)) {
    if (statDef(k)?.visibility === 'self') continue;
    safe[k] = v;
  }
  // Merge, never replace: the end-of-map skill set arrives as several LIVESTAT
  // lines per player (EmitSkillLive splits it to fit the plugin's buffer), and
  // the ten-second line carries a subset. A key that stops arriving keeps its
  // last value, which is what a counter should do.
  const prev = db
    .prepare('SELECT stats_json FROM match_live_players WHERE match_id = ? AND player_id = ?')
    .get(id, steamid) as { stats_json: string } | undefined;
  let merged: Record<string, number> = safe;
  if (prev) {
    try { merged = { ...(JSON.parse(prev.stats_json) as Record<string, number>), ...safe }; } catch { merged = safe; }
  }
  db.prepare(
    `INSERT INTO match_live_players (match_id, player_id, stats_json) VALUES (?, ?, ?)
     ON CONFLICT (match_id, player_id) DO UPDATE SET stats_json = excluded.stats_json`,
  ).run(id, steamid, JSON.stringify(merged));
  touch(db, id);
}

/** Cap on how many feed entries the payload carries. The table keeps
 *  everything for the life of the match; this is only about not shipping an
 *  unbounded list to a page that shows the recent ones. */
export const LIVE_EVENT_LIMIT = 40;

/** Takes the parsed LogEvent directly rather than a hand-built object.
 *
 *  Not cosmetic: the LogEvent's own `kind` is the parser's discriminator and
 *  is always the literal 'live_event', while the thing that happened is in
 *  `event`. Passing the whole object through to a {kind} parameter stored
 *  "live_event" as the event type for every entry, which is exactly what
 *  happened on 2026-09-11. Narrowing the parameter to the event type makes
 *  that mistake impossible to express. */
export function recordLiveEvent(
  db: DB, token: string,
  ev: Extract<LogEvent, { kind: 'live_event' }>,
): void {
  const id = liveMatchIdOf(db, token);
  if (id === null) return;
  // The map in progress is however many have already finished. Stamped at
  // write time because nothing on the wire carries it and it cannot be
  // reconstructed afterwards.
  const done = db
    .prepare('SELECT COUNT(*) AS n FROM match_live_maps WHERE match_id = ?')
    .get(id) as { n: number };
  db.prepare(
    `INSERT INTO match_live_events (match_id, seq, kind, actor, target, value, map_ordinal, half, t_ms)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (match_id, seq) DO UPDATE SET
       kind = excluded.kind, actor = excluded.actor,
       target = excluded.target, value = excluded.value`,
    // map_ordinal, half and t_ms are deliberately NOT updated on conflict. A
    // duplicate datagram can arrive after the map it belongs to has ended,
    // and re-stamping would silently move an old event onto the current map
    // or overwrite its timing with whatever the duplicate happened to carry.
    // The first write is the one that saw the right map and timing.
  ).run(id, ev.seq, ev.event, ev.actor, ev.target, ev.value, done.n, ev.half, ev.tMs);
  touch(db, id);
}

/** Store one chat message. Mirrors recordLiveEvent, including the deliberate
 *  choice NOT to re-stamp map_ordinal, half or t_ms on conflict: a duplicate
 *  datagram can arrive after the map it belongs to has ended, and re-stamping
 *  would move an old message onto the current map. The first write is the one
 *  that saw the right map. */
export function recordChat(
  db: DB, token: string,
  ev: Extract<LogEvent, { kind: 'chat' }>,
): void {
  const id = liveMatchIdOf(db, token);
  if (id === null) return;
  const ordinal = currentOrdinal(db, id);
  db.prepare(
    `INSERT INTO match_chat (match_id, seq, map_ordinal, half, t_ms, steamid, team, message)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (match_id, seq) DO UPDATE SET
       steamid = excluded.steamid, team = excluded.team, message = excluded.message`,
  ).run(id, ev.seq, ordinal, ev.half, ev.tMs, ev.steamid, ev.team, ev.message);
  touch(db, id);
}

export interface RoundRow {
  ordinal: number;
  half: number;
  survTeam: 'a' | 'b';
  /** The survivor score for this half. The column is NOT NULL DEFAULT 0, so
   *  this is 0 both for "they scored nothing" and for "ROUND_END never
   *  arrived". `endedAt` is what tells those two apart. */
  score: number;
  /** When ROUND_END closed this half, or null if it never did. Exposed
   *  alongside score precisely so a consumer can refuse to render a score that
   *  is really just the column default: this codebase does not fabricate
   *  zeros, and the plugin's retries-exhausted path deliberately emits a
   *  score of 0 as well. */
  endedAt: string | null;
  reliable: boolean;
}

/** Which map this round belongs to: however many have already finished.
 *  Same derivation recordLiveEvent uses for map_ordinal, and for the same
 *  reason: nothing on the wire carries it. */
function currentOrdinal(db: DB, matchId: number): number {
  const done = db
    .prepare('SELECT COUNT(*) AS n FROM match_live_maps WHERE match_id = ?')
    .get(matchId) as { n: number };
  return done.n;
}

/** ROUND_START with no side at all.
 *
 *  The plugin omits `surv` when its orientation mapping has not settled, which
 *  is honest but leaves a NOT NULL column to fill. 'a' is written as a
 *  PLACEHOLDER and the row is marked reliable = 0 in the same statement, so
 *  nothing downstream can mistake it for an observation. The reliable flag is
 *  reported to consumers, and it is the consumer's responsibility to refuse to
 *  display an unreliable round. ROUND_END promotes the row back to reliable = 1
 *  when it supplies the authoritative side.
 *
 *  Writing the row at all, rather than skipping it, is what preserves
 *  started_at: every event's t_ms is measured from the round going live, and
 *  without this row that origin is lost for good. */
const PLACEHOLDER_SIDE = 'a';

export function recordRoundStart(
  db: DB, token: string,
  ev: Extract<LogEvent, { kind: 'round_start' }>,
): void {
  const id = liveMatchIdOf(db, token);
  if (id === null) return;
  db.prepare(
    `INSERT INTO match_rounds (match_id, ordinal, half, surv_team, reliable, started_at)
     VALUES (?, ?, ?, ?, ?, datetime('now'))
     ON CONFLICT (match_id, ordinal, half) DO NOTHING`,
    // DO NOTHING, not an update: a duplicated ROUND_START must not reset the
    // started_at that t_ms values are already measured against.
  ).run(id, currentOrdinal(db, id), ev.half, ev.surv ?? PLACEHOLDER_SIDE, ev.surv === null ? 0 : 1);
  touch(db, id);
}

/** Which map a ROUND_END belongs to.
 *
 *  Prefer the map name the line carries: both this and recordMapResult derive
 *  an ordinal from COUNT(match_live_maps) at write time, and the plugin emits
 *  the half-2 ROUND_END immediately before FinalizeMap's MAP_RESULT. Those two
 *  datagrams reordering in flight would otherwise file the round under the
 *  NEXT map. Resolving by name is immune to that, and is the same lookup
 *  recordMapResult already does.
 *
 *  Falls back to the count when the name is absent (older plugin) or unknown
 *  (the map row has not been written yet, which is the normal case for a
 *  half-1 round). */
function ordinalForRoundEnd(db: DB, matchId: number, map: string | null): number {
  if (map !== null) {
    const row = db
      .prepare('SELECT ordinal FROM match_live_maps WHERE match_id = ? AND map = ?')
      .get(matchId, map) as { ordinal: number } | undefined;
    if (row) return row.ordinal;
  }
  return currentOrdinal(db, matchId);
}

export function recordRoundEnd(
  db: DB, token: string,
  ev: Extract<LogEvent, { kind: 'round_end' }>,
): void {
  const id = liveMatchIdOf(db, token);
  if (id === null) return;
  const ordinal = ordinalForRoundEnd(db, id, ev.map);
  const existing = db.prepare(
    'SELECT surv_team, reliable FROM match_rounds WHERE match_id = ? AND ordinal = ? AND half = ?',
  ).get(id, ordinal, ev.half) as { surv_team: string; reliable: number } | undefined;
  // reliable = 0 on the existing row means ROUND_START never knew the side and
  // wrote a placeholder, so there is nothing to disagree with. Only a side
  // that was actually observed and then moved is worth logging.
  if (existing && existing.reliable === 1 && existing.surv_team !== ev.surv) {
    // Not an error. The orientation mapping is provisional early in a round,
    // which is why pug-match reconciles it at all. Logged so a systematic
    // disagreement is visible rather than silently absorbed.
    console.warn(
      `[rounds] match ${id} map ${ordinal} half ${ev.half}: side moved ${existing.surv_team} -> ${ev.surv}`,
    );
  }
  // A negative score is the plugin saying "side known, score unknown": every
  // read of the engine's round score failed. Stored unreliable with a zero
  // rather than as a zero that looks like a result (matches 16 and 17 on
  // 2026-09-13 showed 0 to 0 for a map that was played).
  const known = ev.score >= 0;
  db.prepare(
    `INSERT INTO match_rounds (match_id, ordinal, half, surv_team, score, reliable, ended_at, survivors_alive)
     VALUES (?, ?, ?, ?, ?, ?, datetime('now'), ?)
     ON CONFLICT (match_id, ordinal, half) DO UPDATE SET
       surv_team = excluded.surv_team,
       score = excluded.score,
       -- Promotes a round whose START had no side: this line carries the
       -- authoritative one, so the placeholder is now replaced by an
       -- observation and the row is trustworthy again. Unless the score
       -- itself is unknown, in which case the row stays unreliable.
       reliable = excluded.reliable,
       ended_at = excluded.ended_at,
       -- COALESCE, not a plain overwrite: a duplicate ROUND_END that carries
       -- no reading must not erase one already observed. Every other column
       -- here is authoritative on every line, but this one is the single
       -- field an older plugin can omit, so absence has to lose to presence
       -- rather than win by arriving second.
       survivors_alive = COALESCE(excluded.survivors_alive, match_rounds.survivors_alive)`,
  ).run(id, ordinal, ev.half, ev.surv, known ? ev.score : 0, known ? 1 : 0, ev.alive);
  touch(db, id);
}

export function roundsFor(db: DB, matchId: number): RoundRow[] {
  return (db.prepare(
    `SELECT ordinal, half, surv_team, score, ended_at, reliable FROM match_rounds
     WHERE match_id = ? ORDER BY ordinal, half`,
  ).all(matchId) as {
    ordinal: number; half: number; surv_team: 'a' | 'b';
    score: number; ended_at: string | null; reliable: number;
  }[])
    .map((r) => ({
      ordinal: r.ordinal, half: r.half, survTeam: r.surv_team,
      score: r.score, endedAt: r.ended_at, reliable: r.reliable === 1,
    }));
}

export function recordMapResult(db: DB, token: string, map: string, a: number, b: number): void {
  const id = liveMatchIdOf(db, token);
  if (id === null) return;
  db.transaction(() => {
    // Freeze the cumulative totals as they stand now. Up to one LIVESTAT
    // interval (10s) of end-of-map activity can land in the next map's
    // bucket; that is acceptable for a cosmetic split, and the authoritative
    // per-player totals still come from the dump, untouched by any of this.
    const existing = db
      .prepare('SELECT ordinal FROM match_live_maps WHERE match_id = ? AND map = ?')
      .get(id, map) as { ordinal: number } | undefined;
    const ordinal = existing?.ordinal
      ?? (db.prepare('SELECT COUNT(*) AS n FROM match_live_maps WHERE match_id = ?')
        .get(id) as { n: number }).n;
    db.prepare(
      `INSERT INTO match_live_maps (match_id, map, ordinal, team_a_score, team_b_score)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (match_id, map) DO UPDATE SET
         team_a_score = excluded.team_a_score, team_b_score = excluded.team_b_score`,
    ).run(id, map, ordinal, a, b);

    const snap = db.prepare(
      `INSERT INTO match_live_map_stats (match_id, ordinal, player_id, stats_json)
       VALUES (?, ?, ?, ?)
       ON CONFLICT (match_id, ordinal, player_id) DO UPDATE SET stats_json = excluded.stats_json`,
    );
    const cur = db
      .prepare('SELECT player_id, stats_json FROM match_live_players WHERE match_id = ?')
      .all(id) as { player_id: string; stats_json: string }[];
    for (const r of cur) snap.run(id, ordinal, r.player_id, r.stats_json);

    touch(db, id);
  })();
}

/** Per-map values from two consecutive end-of-map snapshots.
 *
 *  Counters are differenced and floored at zero: a counter should never run
 *  backwards, and a missing snapshot would otherwise put a nonsense negative
 *  on the page instead of a visible absence.
 *
 *  LEVELS are carried through as-is rather than differenced. Health is a level:
 *  "how much HP did you have when that map ended" is the meaningful number,
 *  and subtracting one map's ending health from the previous map's is noise.
 *  The value is as of the last LIVESTAT before the map ended, so it can be up
 *  to one 10s interval stale. */
const LEVEL_KEYS = new Set(['hp', 'hp_temp', 'hp_perm']);

function diffStats(
  cur: Record<string, number>, prev: Record<string, number>,
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(cur)) {
    if (LEVEL_KEYS.has(k)) { out[k] = v; continue; }
    const d = v - (prev[k] ?? 0);
    out[k] = d > 0 ? d : 0;
  }
  return out;
}

/** A match with no heartbeat for this long is presumed dead: the plugin was
 *  reloaded, srcds restarted, or the box fell over. Generous on purpose. The
 *  plugin heartbeats every 30s even through ready-up and map transitions, so
 *  ten minutes of total silence is not a slow map change, it is a match that
 *  no longer exists on the server side. */
export const ORPHAN_AFTER_MS = 600_000;

/**
 * Abort matches the game server has clearly forgotten.
 *
 * Without this a match sits 'live' forever: it shows on the live page as
 * permanently "no signal", and worse, its server row stays reserved so
 * claimIdle can never hand that server to another match. Both happened
 * repeatedly while iterating on the plugin, since every reload drops the
 * plugin's match state while the database still believes a match is running.
 *
 * Only touches matches that have actually gone quiet: one with no heartbeat
 * row at all is left alone, because it may have been adopted seconds ago and
 * not yet reported in.
 */
export function reapOrphanedMatches(
  db: DB,
  releaser: ServerReleaser,
  olderThanMs = ORPHAN_AFTER_MS,
): number[] {
  const cutoff = new Date(Date.now() - olderThanMs).toISOString().replace('T', ' ').slice(0, 19);
  const rows = db
    .prepare(
      `SELECT m.id, m.server_id FROM matches m
       JOIN match_live l ON l.match_id = m.id
       WHERE m.state = 'live' AND l.last_seen < ?`,
    )
    .all(cutoff) as { id: number; server_id: number | null }[];

  for (const r of rows) {
    db.prepare("UPDATE matches SET state = 'aborted', ended_at = datetime('now') WHERE id = ?")
      .run(r.id);
    // Through the releaser, not a raw status write: a reaped match is exactly
    // the one whose sv_password nobody is left to clear by hand.
    if (r.server_id !== null) releaser.release(r.server_id);
    clearLive(db, r.id);
    console.warn(`[liveView] reaped orphaned match ${r.id}: no heartbeat for ${olderThanMs}ms`);
  }
  return rows.map((r) => r.id);
}

/**
 * Drop the volatile rows once a match is no longer live.
 *
 * Deliberately KEEPS `match_live_map_stats` and `match_live_events`. They were
 * originally cleared with everything else, which meant completing a match
 * destroyed the only per-map player breakdown and the whole event feed that
 * had just been collected: the match page could never show them. They are the
 * historical record, not scratch.
 *
 * What does go is genuinely transient: `match_live` is heartbeat and
 * current-map bookkeeping, `match_live_players` is a running cumulative total
 * superseded by the authoritative `match_players` rows, and `match_live_maps`
 * is superseded by `match_maps` from the dump.
 *
 * Nothing here is keyed on by the live page, which only ever looks at matches
 * in state 'live', so retained rows cost nothing but a little disk.
 */
export function clearLive(db: DB, matchId: number): void {
  db.transaction(() => {
    db.prepare('DELETE FROM match_live_players WHERE match_id = ?').run(matchId);
    db.prepare('DELETE FROM match_live_maps WHERE match_id = ?').run(matchId);
    db.prepare('DELETE FROM match_live WHERE match_id = ?').run(matchId);
  })();
}

/** Per-map per-player stats for any match, live or finished, as
 *  {ordinal: {steamid: stats}}. Shared by the live page and the match page so
 *  a map's numbers are computed one way only. */
export function mapStatsFor(db: DB, matchId: number): Map<number, Record<string, Record<string, number>>> {
  const rows = db
    .prepare(
      `SELECT ordinal, player_id, stats_json FROM match_live_map_stats
       WHERE match_id = ? ORDER BY ordinal`,
    )
    .all(matchId) as { ordinal: number; player_id: string; stats_json: string }[];

  const snaps = new Map<number, Map<string, Record<string, number>>>();
  for (const r of rows) {
    if (!snaps.has(r.ordinal)) snaps.set(r.ordinal, new Map());
    try {
      snaps.get(r.ordinal)!.set(r.player_id, JSON.parse(r.stats_json));
    } catch { /* a corrupt row must not break the page */ }
  }

  const out = new Map<number, Record<string, Record<string, number>>>();
  for (const [ordinal, cur] of snaps) {
    const prev = snaps.get(ordinal - 1) ?? new Map();
    const stats: Record<string, Record<string, number>> = {};
    for (const [pid, s2] of cur) stats[pid] = diffStats(s2, prev.get(pid) ?? {});
    out.set(ordinal, stats);
  }
  return out;
}

/** The event feed for any match, newest first. */
export function eventsFor(db: DB, matchId: number, limit = LIVE_EVENT_LIMIT): {
  seq: number; kind: string; mapOrdinal: number; half: number; tMs: number;
  actor: string; target: string | null; value: number;
}[] {
  return (db
    .prepare(
      `SELECT seq, kind, actor, target, value, map_ordinal, half, t_ms FROM match_live_events
       WHERE match_id = ? ORDER BY seq DESC LIMIT ?`,
    )
    .all(matchId, limit) as {
      seq: number; kind: string; actor: string; target: string | null;
      value: number; map_ordinal: number; half: number; t_ms: number;
    }[]).map((e) => ({
      seq: e.seq, kind: e.kind, mapOrdinal: e.map_ordinal, half: e.half, tMs: e.t_ms,
      actor: e.actor, target: e.target, value: e.value,
    }));
}

/** Everything currently being played. Public payload, served to anonymous
 *  viewers: no steamid is secret (they are visible to anyone in the server
 *  anyway), and the per-player stats are public-visibility only, enforced at
 *  write time by recordLiveStat rather than filtered here.
 *
 *  The match token is deliberately not in this payload, and neither is
 *  anything it can be recovered from. It seeds the server password in
 *  orchestrator.ts, so publishing it here would hand anyone reading the live
 *  page a way into a private ranked match. The replay viewer addresses a live
 *  match by id throughout: /api/replays/live/match/:id answers with an
 *  (ordinal, half) pair rather than a filename, because a ranked filename is
 *  `pug_<token>_<ordinal>_<half>.rpl` and would carry the token as surely as
 *  a token field would, and /api/replays/match/:id/:ordinal/:half resolves
 *  that pair to a file server-side. The token bytes in the replay header are
 *  zeroed on the way out by routes/replays.ts, so the file contents do not
 *  leak it either. */
export function getLiveMatches(db: DB): LiveMatch[] {
  const matches = db
    .prepare(
      `SELECT m.id, m.campaign, l.current_map AS currentMap, l.last_seen AS lastSeen
       FROM matches m
       LEFT JOIN match_live l ON l.match_id = m.id
       WHERE m.state = 'live'
       ORDER BY m.id DESC`,
    )
    .all() as { id: number; campaign: string; currentMap: string | null; lastSeen: string | null }[];
  if (matches.length === 0) return [];

  const playersOf = db.prepare(
    `SELECT mp.player_id AS steamid, p.name, mp.team
     FROM match_players mp JOIN players p ON p.steamid = mp.player_id
     WHERE mp.match_id = ? ORDER BY mp.player_id`,
  );
  const statsOf = db.prepare(
    'SELECT player_id, stats_json FROM match_live_players WHERE match_id = ?',
  );
  const eventsOf = db.prepare(
    `SELECT seq, kind, actor, target, value, map_ordinal, half, t_ms FROM match_live_events
     WHERE match_id = ? ORDER BY seq DESC LIMIT ?`,
  );
  const demosOf = db.prepare(
    'SELECT ordinal, map, bytes FROM match_demos WHERE match_id = ? ORDER BY ordinal',
  );
  const mapsOf = db.prepare(
    `SELECT ordinal, map, team_a_score AS teamAScore, team_b_score AS teamBScore
     FROM match_live_maps WHERE match_id = ? ORDER BY ordinal`,
  );

  const now = Date.now();
  return matches.map((m) => {
    const ps = playersOf.all(m.id) as { steamid: string; name: string; team: 'a' | 'b' }[];
    const rawMaps = mapsOf.all(m.id) as Omit<LiveMap, 'stats'>[];
    const byMap = mapStatsFor(db, m.id);
    const maps: LiveMap[] = rawMaps.map((mp) => ({ ...mp, stats: byMap.get(mp.ordinal) ?? {} }));
    const statRows = statsOf.all(m.id) as { player_id: string; stats_json: string }[];
    const statsBy = new Map<string, Record<string, number>>();
    for (const r of statRows) {
      try {
        statsBy.set(r.player_id, JSON.parse(r.stats_json));
      } catch {
        // A corrupt scratch row must not take down the whole live page.
      }
    }
    const nameOf = (id: string) => ps.find((p) => p.steamid === id)?.name ?? id;
    const named = (p: { steamid: string; name: string }): LivePlayer => ({
      steamid: p.steamid, name: p.name, stats: statsBy.get(p.steamid) ?? {},
    });
    return {
      id: m.id,
      campaign: m.campaign,
      currentMap: m.currentMap ?? null,
      teamA: ps.filter((p) => p.team === 'a').map(named),
      teamB: ps.filter((p) => p.team === 'b').map(named),
      maps,
      teamAScore: maps.reduce((t, x) => t + x.teamAScore, 0),
      teamBScore: maps.reduce((t, x) => t + x.teamBScore, 0),
      demos: demosOf.all(m.id) as LiveDemo[],
      events: (eventsOf.all(m.id, LIVE_EVENT_LIMIT) as {
        seq: number; kind: string; actor: string; target: string | null;
        value: number; map_ordinal: number; half: number; t_ms: number;
      }[]).map((e) => ({
        seq: e.seq,
        kind: e.kind,
        mapOrdinal: e.map_ordinal,
        half: e.half,
        tMs: e.t_ms,
        // Names resolved from the roster we already loaded, so the feed never
        // shows a bare steamid for someone in the match.
        actor: { steamid: e.actor, name: nameOf(e.actor) },
        target: e.target ? { steamid: e.target, name: nameOf(e.target) } : null,
        value: e.value,
      })),
      lastSeen: m.lastSeen,
      // No heartbeat yet is NOT stale: a match adopted seconds ago has simply
      // not had one. It goes stale only once a heartbeat has been seen and
      // then stopped.
      stale: m.lastSeen !== null && now - Date.parse(`${m.lastSeen.replace(' ', 'T')}Z`) > STALE_AFTER_MS,
    };
  });
}
