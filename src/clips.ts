import { campaignDisplayName } from './campaignRegistry.js';
import type { DB } from './db.js';
import { completedPug } from './matchKinds.js';
import { getPlayer } from './players.js';
import { STREAK_MIN, streakRuns } from './skeetStreaks.js';

/**
 * First-person highlight clips (owner 2026-11-22, after suprep's tool): every
 * double-or-better skeet burst by one player in one map half (same 5 s window
 * as the triple post) is queued here, rendered on a spare box by clipd (the 3D
 * viewer in headless Chrome, theatre-spike/clip/), and shown on /clips and the
 * player's profile. Triples also get the video on their Discord post
 * (skeetStreakPoster.ts); doubles stay on the site (owner: no channel spam).
 *
 * The database is the queue, as for the skeet posts: a completed match is
 * scanned once (clip_scans), its bursts are stored, and the worker claims them
 * one at a time over /api/clips/worker/*.
 */

export const CLIP_MIN = 2;
/** Doubles are queued for matches that ended from here on (deploy day, plus
 *  a day of backlog for the page to start with); triples go back to when the
 *  triple posts started, so every post can get its video. */
export const CLIPS_SINCE = '2026-11-21 00:00:00';
export const CLIP_TRIPLES_SINCE = '2026-09-28 02:00:00';
/** A claim older than this is the worker dying mid-render: queued again. */
export const CLAIM_TIMEOUT_MIN = 60;
export const MAX_ATTEMPTS = 3;

export interface ClipBurst { steamid: string; mapOrdinal: number; half: number; times: number[]; kind?: 'skeet' | 'quad'; people?: string[] }

/** Four pins must all land within this of the first. */
export const QUAD_WINDOW_MS = 5000;

/**
 * Quad caps from the pin feed, by the rule the quad_caps stat settles at round
 * end (l4d1-quad-caps): all four survivors pinned at once, and nobody back on
 * their feet before the round ends. Per map half, in order: a pin ends when its
 * victim is cleared or dies, its attacker dies, or its attacker pins someone
 * else (one infected holds one survivor; an incap does not end a pin); four
 * different survivors held, all pinned within QUAD_WINDOW_MS, is a candidate.
 * The rest of the half must then take them down (incap or death; the last one,
 * whose incap ends the round, is not in the feed, so three will do) with none
 * getting up first: cleared, freed by their capper dying, or in a revive. A
 * tongue that breaks leaves no event, but the round then goes on, so that
 * survivor's own going down shows up later or the count falls short. The fourth capper's eyes film it. The
 * caller also needs the match's quad_caps stat.
 */
export function findQuads(db: DB, matchId: number): ClipBurst[] {
  const rows = db.prepare(
    `SELECT kind, actor, target, map_ordinal AS o, half AS h, t_ms AS t FROM match_live_events
     WHERE match_id = ? AND kind IN ('pinned', 'cleared', 'death', 'incap', 'revive') AND t_ms != -1
     ORDER BY map_ordinal, half, t_ms, seq`,
  ).all(matchId) as { kind: string; actor: string; target: string | null; o: number; h: number; t: number }[];
  const out: ClipBurst[] = [];
  let held = new Map<string, { by: string; t: number }>();   // victim -> pin
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i]!;
    if (i === 0 || r.o !== rows[i - 1]!.o || r.h !== rows[i - 1]!.h) held = new Map();
    if (r.kind === 'pinned' && r.target) {
      for (const [v, p] of held) if (p.by === r.actor || r.t - p.t > QUAD_WINDOW_MS) held.delete(v);
      held.set(r.target, { by: r.actor, t: r.t });
      if (held.size < 4) continue;
      const pins = [...held].sort((a, b) => a[1].t - b[1].t);
      held = new Map();   // one quad per hold
      if (!staysDown(rows, i + 1, new Map(pins.map(([v, p]) => [v, p.by])))) continue;
      out.push({ kind: 'quad', steamid: r.actor, mapOrdinal: r.o, half: r.h, times: pins.map(([, p]) => p.t), people: pins.map(([, p]) => p.by) });
    } else if (r.kind === 'cleared' && r.target) held.delete(r.target);
    else if (r.kind === 'death') {   // death: actor is who died
      held.delete(r.actor);
      for (const [v, p] of held) if (p.by === r.actor) held.delete(v);
    }
  }
  return out;
}

/** From rows[from] to the end of that map half: does every victim (victim ->
 *  capper) go down (incap or death), none getting up first? */
function staysDown(
  rows: { kind: string; actor: string; target: string | null; o: number; h: number }[], from: number, victims: Map<string, string>,
): boolean {
  const o = rows[from - 1]!.o, h = rows[from - 1]!.h;
  const down = new Set<string>();
  for (let i = from; i < rows.length && rows[i]!.o === o && rows[i]!.h === h; i++) {
    const r = rows[i]!;
    const t = r.target ?? '';
    // incap and death name the one going down as actor; cleared names the freed survivor as target
    if ((r.kind === 'incap' || r.kind === 'death') && victims.has(r.actor)) { down.add(r.actor); continue; }
    if (r.kind === 'cleared' && victims.has(t) && !down.has(t)) return false;
    if (r.kind === 'death') for (const [v, by] of victims) if (by === r.actor && !down.has(v)) return false;
    if (r.kind === 'revive' && (victims.has(t) || victims.has(r.actor))) return false;
  }
  // the incap that ends the round (the last survivor going down) is not in the feed, so one may be missing
  return down.size >= victims.size - 1;
}

/**
 * Bursts of one match: triples (and more) exactly as findSkeetStreaks makes
 * them, so a triple's clip shares its key (match, player, map, half, first
 * t_ms) with its skeet_streaks row; then doubles among the skeets no triple
 * took, each stretch between two triples scanned on its own.
 */
export function findClipBursts(db: DB, matchId: number): ClipBurst[] {
  const rows = db.prepare(
    `SELECT actor, map_ordinal AS mapOrdinal, half, t_ms AS tMs FROM match_live_events
     WHERE match_id = ? AND kind = 'skeet' AND t_ms != -1
     ORDER BY actor, map_ordinal, half, t_ms`,
  ).all(matchId) as { actor: string; mapOrdinal: number; half: number; tMs: number }[];
  const groups = new Map<string, { steamid: string; mapOrdinal: number; half: number; times: number[] }>();
  for (const r of rows) {
    const key = `${r.actor}\u0000${r.mapOrdinal}\u0000${r.half}`;
    let g = groups.get(key);
    if (!g) groups.set(key, (g = { steamid: r.actor, mapOrdinal: r.mapOrdinal, half: r.half, times: [] }));
    g.times.push(r.tMs);
  }
  const out: ClipBurst[] = [];
  for (const g of groups.values()) {
    const big = streakRuns(g.times, STREAK_MIN);
    const add = (i: number, j: number) => out.push({ steamid: g.steamid, mapOrdinal: g.mapOrdinal, half: g.half, times: g.times.slice(i, j + 1) });
    let from = 0;
    for (const [i, j] of [...big, [g.times.length, g.times.length] as [number, number]]) {
      const gap = g.times.slice(from, i);
      for (const [a, b] of streakRuns(gap, CLIP_MIN)) add(from + a, from + b);
      if (i < g.times.length) add(i, j);
      from = j + 1;
    }
  }
  return out.sort((a, b) => a.mapOrdinal - b.mapOrdinal || a.half - b.half || a.times[0]! - b.times[0]!);
}

const stamp = (d: Date) => d.toISOString().replace('T', ' ').slice(0, 19);

/** Scan completed public pugs not scanned yet and queue their bursts. */
export function scanClips(db: DB): number {
  const matches = db.prepare(
    `SELECT id, ended_at AS endedAt FROM matches
     WHERE ${completedPug()} AND voided_at IS NULL AND visibility = 'public' AND ended_at >= ?
       AND id NOT IN (SELECT match_id FROM clip_scans)`,
  ).all(CLIP_TRIPLES_SINCE) as { id: number; endedAt: string }[];
  const ins = db.prepare(
    `INSERT OR IGNORE INTO clips (match_id, player_id, map_ordinal, half, t_ms, count, span_ms, times_json, kind, people_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const known = db.prepare('SELECT 1 FROM players WHERE steamid = ?');
  const quadStat = db.prepare(`SELECT COUNT(*) AS n FROM match_player_stats WHERE match_id = ? AND stat = 'quad_caps' AND value > 0`);
  const scanned = db.prepare('INSERT INTO clip_scans (match_id, scanned_at) VALUES (?, ?)');
  let n = 0;
  for (const m of matches) {
    const doubles = m.endedAt >= CLIPS_SINCE;
    const bursts = findClipBursts(db, m.id).filter((b) => (doubles || b.times.length >= STREAK_MIN) && known.get(b.steamid));
    if (doubles && (quadStat.get(m.id) as { n: number }).n > 0) bursts.push(...findQuads(db, m.id).filter((b) => known.get(b.steamid)));
    db.transaction(() => {
      for (const b of bursts) {
        n += ins.run(m.id, b.steamid, b.mapOrdinal, b.half, b.times[0], b.times.length, b.times.at(-1)! - b.times[0]!, JSON.stringify(b.times),
          b.kind ?? 'skeet', b.people ? JSON.stringify(b.people) : null).changes;
      }
      scanned.run(m.id, stamp(new Date()));
    })();
  }
  return n;
}

export interface ClipRow {
  id: number; match_id: number; player_id: string; map_ordinal: number; half: number; t_ms: number;
  count: number; span_ms: number; times_json: string; kind: 'skeet' | 'quad'; people_json: string | null; status: string; attempts: number;
  claimed_at: string | null; error: string | null; video_key: string | null; thumb_key: string | null;
  bytes: number | null; created_at: string; done_at: string | null;
}

export function burstName(count: number): string {
  return count === 2 ? 'double skeet' : count === 3 ? 'triple skeet' : count === 4 ? 'quad skeet' : `${count}-skeet streak`;
}

/** What the worker needs for one clip: where the demo is, whose eyes, which
 *  moments, and the two caption lines (written here so the wording lives with
 *  the site, not on the render box). */
export interface ClipJob {
  id: number; matchId: number; ordinal: number; half: number; steamid: string; times: number[];
  count: number; kind: 'skeet' | 'quad'; caption: [string, string];
  /** seconds of track before the first moment and after the last */
  lead: number; tail: number;
}

export function jobFor(db: DB, row: ClipRow): ClipJob {
  const name = getPlayer(db, row.player_id)?.name ?? row.player_id;
  const m = db.prepare('SELECT campaign FROM matches WHERE id = ?').get(row.match_id) as { campaign: string } | undefined;
  const campaign = campaignDisplayName(db, m?.campaign ?? '');
  const secs = (row.span_ms / 1000).toFixed(1);
  const base = {
    id: row.id, matchId: row.match_id, ordinal: row.map_ordinal, half: row.half, steamid: row.player_id,
    times: JSON.parse(row.times_json) as number[], count: row.count, kind: row.kind,
  };
  const where = `Match ${row.match_id} · ${campaign}, map ${row.map_ordinal + 1}`;
  if (row.kind === 'quad') {
    const names = (JSON.parse(row.people_json ?? '[]') as string[]).map((id) => getPlayer(db, id)?.name ?? id);
    return { ...base, lead: 3, tail: 4.3, caption: [`QUAD CAP: ${names.join(', ')}`, `${where} · 4 pins in ${secs} s`] };
  }
  return { ...base, lead: 3.3, tail: 2.7, caption: [`${name}: ${burstName(row.count).toUpperCase()}`, `${where} · ${row.count} hunters in ${secs} s`] };
}

/** Hand the next clip to the worker: a stale claim goes back first (it used
 *  an attempt), then the newest match's biggest burst, so fresh clips come
 *  before the backlog and a triple before a double of the same match. */
export function claimClip(db: DB, now = new Date()): ClipRow | null {
  return db.transaction(() => {
    const stale = stamp(new Date(now.getTime() - CLAIM_TIMEOUT_MIN * 60_000));
    db.prepare(
      `UPDATE clips SET status = CASE WHEN attempts >= ? THEN 'failed' ELSE 'queued' END,
         error = COALESCE(error, 'claim timed out')
       WHERE status = 'rendering' AND claimed_at < ?`,
    ).run(MAX_ATTEMPTS, stale);
    const row = db.prepare(
      `SELECT c.* FROM clips c JOIN matches m ON m.id = c.match_id
       WHERE c.status = 'queued' AND m.voided_at IS NULL
       ORDER BY c.match_id DESC, c.count DESC, c.id LIMIT 1`,
    ).get() as ClipRow | undefined;
    if (!row) return null;
    db.prepare(`UPDATE clips SET status = 'rendering', claimed_at = ?, attempts = attempts + 1 WHERE id = ?`).run(stamp(now), row.id);
    return { ...row, status: 'rendering', attempts: row.attempts + 1, claimed_at: stamp(now) };
  })();
}

export function getClip(db: DB, id: number): ClipRow | null {
  return (db.prepare('SELECT * FROM clips WHERE id = ?').get(id) as ClipRow | undefined) ?? null;
}

export function setClipFile(db: DB, id: number, which: 'video' | 'thumb', key: string, bytes?: number): void {
  if (which === 'video') db.prepare('UPDATE clips SET video_key = ?, bytes = ? WHERE id = ?').run(key, bytes ?? null, id);
  else db.prepare('UPDATE clips SET thumb_key = ? WHERE id = ?').run(key, id);
}

/** Done needs the video on R2 (the poster frame is optional). */
export function finishClip(db: DB, id: number): boolean {
  return db.prepare(
    `UPDATE clips SET status = 'done', done_at = datetime('now'), error = NULL
     WHERE id = ? AND status = 'rendering' AND video_key IS NOT NULL`,
  ).run(id).changes === 1;
}

export function failClip(db: DB, id: number, error: string): void {
  db.prepare(
    `UPDATE clips SET status = CASE WHEN attempts >= ? THEN 'failed' ELSE 'queued' END, error = ?
     WHERE id = ? AND status = 'rendering'`,
  ).run(MAX_ATTEMPTS, error.slice(0, 500), id);
}

export interface PublicClip {
  id: number; matchId: number; ordinal: number; half: number; tMs: number; count: number; spanMs: number;
  kind: 'skeet' | 'quad'; people: { steamid: string; name: string }[];
  player: { steamid: string; name: string; avatar: string | null }; campaign: string; doneAt: string;
  video: string; thumb: string | null;
}

/** Finished clips of public, non-voided pugs, newest first; `before` pages
 *  by id. urlFor turns an R2 key into its public address. */
export function listClips(
  db: DB, urlFor: (key: string) => string,
  opts: { player?: string; before?: number; limit?: number; minCount?: number; kind?: 'skeet' | 'quad' } = {},
): PublicClip[] {
  const limit = Math.max(1, Math.min(60, opts.limit ?? 24));
  const where = [`c.status = 'done'`, 'm.voided_at IS NULL', `m.visibility = 'public'`, completedPug('m')];
  const args: unknown[] = [];
  // a quad shows on all four cappers' profiles, not only the one whose eyes filmed it
  if (opts.player) { where.push(`(c.player_id = ? OR (c.kind = 'quad' AND EXISTS (SELECT 1 FROM json_each(c.people_json) WHERE value = ?)))`); args.push(opts.player, opts.player); }
  if (opts.kind) { where.push('c.kind = ?'); args.push(opts.kind); }
  if (opts.before) { where.push('c.id < ?'); args.push(opts.before); }
  if (opts.minCount) { where.push(`c.kind = 'skeet' AND c.count >= ?`); args.push(opts.minCount); }
  const rows = db.prepare(
    `SELECT c.*, m.campaign, p.name, p.avatar FROM clips c JOIN matches m ON m.id = c.match_id
     JOIN players p ON p.steamid = c.player_id
     WHERE ${where.join(' AND ')} ORDER BY c.id DESC LIMIT ${limit}`,
  ).all(...args) as (ClipRow & { campaign: string; name: string; avatar: string | null })[];
  return rows.map((r) => ({
    id: r.id, matchId: r.match_id, ordinal: r.map_ordinal, half: r.half, tMs: r.t_ms, count: r.count, spanMs: r.span_ms,
    kind: r.kind, people: (JSON.parse(r.people_json ?? '[]') as string[]).map((id) => ({ steamid: id, name: getPlayer(db, id)?.name ?? id })),
    player: { steamid: r.player_id, name: getPlayer(db, r.player_id)?.name ?? r.name, avatar: r.avatar },
    campaign: campaignDisplayName(db, r.campaign), doneAt: r.done_at ?? r.created_at,
    video: urlFor(r.video_key!), thumb: r.thumb_key ? urlFor(r.thumb_key) : null,
  }));
}

/** The R2 key of a finished clip's video for a triple's post, or null. */
export function clipVideoKey(db: DB, k: { matchId: number; steamid: string; mapOrdinal: number; half: number; tMs: number }): string | null {
  const r = db.prepare(
    `SELECT video_key FROM clips WHERE kind = 'skeet' AND match_id = ? AND player_id = ? AND map_ordinal = ? AND half = ? AND t_ms = ? AND status = 'done'`,
  ).get(k.matchId, k.steamid, k.mapOrdinal, k.half, k.tMs) as { video_key: string } | undefined;
  return r?.video_key ?? null;
}

export const clipVideoKeyFor = (matchId: number, id: number) => `clips/${matchId}/${id}.mp4`;
export const clipThumbKeyFor = (matchId: number, id: number) => `clips/${matchId}/${id}.jpg`;
