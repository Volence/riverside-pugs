import type { DB } from './db.js';
import type { ServerReleaser } from './serverRelease.js';
import { archiveAborted } from './matchArchive.js';
import { insertBan } from './admin/players.js';
import { publishAdminEvent } from './adminFeed.js';
import { publishBanChange } from './banEvents.js';
import { noteMatchAborted } from './matchAborts.js';
import { applyAbandonPenalty } from './rating.js';

/** Abandon bans escalate within this window: 1 day, then 3, then 7. */
const LADDER_MINUTES = [1440, 4320, 10080];
const WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * The next abandon ban's length, from the abandons already on record.
 *
 * A ban staff lifted by hand does not count: lifting one is staff saying the
 * abandon was not the player's doing (a crash, our server, a mistaken end),
 * and it used to push the player's next real abandon up the ladder anyway. A
 * ban that ran out still counts, lifted_by 'system' being the expiry sweep
 * (liftExpiredBans), and so does one a human lifted only after it had already
 * run out, since that one was served in full.
 */
export function abandonBanMinutes(db: DB, steamid: string, now = new Date()): number {
  const n = abandonsSince(db, steamid, new Date(now.getTime() - WINDOW_MS));
  return LADDER_MINUTES[Math.min(n, LADDER_MINUTES.length - 1)];
}

/** Abandon bans on record since `since`, counted as abandonBanMinutes counts
 *  them: a ban staff lifted by hand before it ran out does not count. The
 *  draft desk shows it as PUG reliability (drafts plan D1 Ruling 8). */
export function abandonsSince(db: DB, steamid: string, since: Date): number {
  return (db.prepare(
    `SELECT COUNT(*) AS n FROM bans
     WHERE player_id = ? AND reason LIKE 'Abandoned match #%' AND created_at >= ?
       AND (lifted_at IS NULL OR lifted_by = 'system' OR (expires_at IS NOT NULL AND lifted_at >= expires_at))`,
  ).get(steamid, since.toISOString()) as { n: number }).n;
}

/** What the game server says about an abandon, read from sm_pug_status. */
export interface AbandonConfirm {
  /** The server records this player as the match's abandoner. */
  abandoner: boolean;
  /** The STATUS gg line (pug-match 0.3.31): whether the match was decided,
   *  by the !gg rule, when they ran out. Null from an older plugin, which
   *  then gets today's abort. */
  gg: { decided: 'a' | 'b' | null; gap: number; ceiling: number; known: boolean } | null;
}

export interface AbandonDeps {
  db: DB;
  releaser: ServerReleaser;
  /** Ask the game server whether it really recorded this player as the
   *  abandoner, and whether the match was decided then (sm_pug_status). The
   *  log line alone arrives over UDP from an address anyone could spoof, and
   *  it ends a match and bans someone. A bare boolean is an answer with no
   *  STATUS gg line, as from a plugin older than 0.3.31. */
  confirm: (serverId: number, steamid: string) => Promise<boolean | AbandonConfirm>;
  /** Tell the plugin to end a decided match with the leading team winning
   *  (sm_pug_abandon_end). 'refused' when it answered PUGERR (it does not
   *  agree, or predates the command); throws when the box could not be
   *  reached. Absent: no match is ever ended as decided. */
  endDecided?: (serverId: number, token: string, steamid: string) => Promise<'ok' | 'refused'>;
  /** Collect the result the plugin now reports, as MATCH_END would
   *  (finishWithRetry). */
  finish?: (matchId: number) => void;
}

const inFlight = new Set<string>();
/** Booked games whose ABANDON was refused, logged once each (the plugin repeats the line every heartbeat). */
const bookedLogged = new Set<string>();

/** Whether an sm_pug_status body names `steamid` as the match's abandoner. */
export function statusShowsAbandoner(body: string, steamid: string): boolean {
  return body.split('\n').some((l) => l.trim().startsWith(`STATUS leave abandoner=${steamid} `));
}

/** Read an sm_pug_status body for an abandon confirm: the abandoner line,
 *  and the STATUS gg line when the plugin has one. Only a judgement made at
 *  the abandon (at=abandon) counts; a known=0 one is "not decided". */
export function parseAbandonStatus(body: string, steamid: string): AbandonConfirm {
  const abandoner = statusShowsAbandoner(body, steamid);
  const line = body.split('\n').map((l) => l.trim()).find((l) => l.startsWith('STATUS gg '));
  if (!line) return { abandoner, gg: null };
  const kv: Record<string, string> = {};
  for (const part of line.split(/\s+/).slice(2)) {
    const eq = part.indexOf('=');
    if (eq > 0) kv[part.slice(0, eq)] = part.slice(eq + 1);
  }
  const known = kv.known === '1' && kv.at === 'abandon';
  const decided = known && (kv.decided === 'a' || kv.decided === 'b') ? kv.decided : null;
  const num = (v: string | undefined) => (v !== undefined && /^-?\d+$/.test(v) ? Number(v) : -1);
  return { abandoner, gg: { decided, gap: num(kv.gap), ceiling: num(kv.ceiling), known } };
}

function asConfirm(r: boolean | AbandonConfirm): AbandonConfirm {
  return typeof r === 'boolean' ? { abandoner: r, gg: null } : r;
}

interface MatchRow { id: number; server_id: number | null; booking_id: number | null; kind: string; token: string }

/**
 * A rostered player used up their reconnect allowance (pug-leave.inc).
 *
 * Owner rulings 2026-10-10 (docs/ship-abandon-rating.md):
 *  - Decided (the !gg rule, judged by the server when they ran out and read
 *    back over rcon): the match is NOT aborted. The plugin ends it with the
 *    score as it stands (sm_pug_abandon_end), the leading team wins, and it
 *    is collected and rated like any finished match, for everyone else.
 *  - Not decided, or a plugin too old to say: aborted, no rating change for
 *    the other seven, server released, live scratch archived.
 *  - Either way the quitter takes a rating loss (src/rating.ts quitterLoss)
 *    and the abandon ban, which escalates as before.
 *
 * The match_abandons row is the commit point: written with the ban, in one
 * transaction, before the plugin is asked to end anything. A repeat of the
 * line finds it and only retries the end that has not landed yet; a second
 * player's line finds it and is ignored. Returns the match id when this call
 * ended the match (or handed it to the collector); null otherwise.
 */
export async function handleAbandon(deps: AbandonDeps, token: string, steamid: string): Promise<number | null> {
  const { db } = deps;
  const match = db.prepare(
    "SELECT id, server_id, booking_id, kind, token FROM matches WHERE token = ? AND state IN ('configuring', 'live')",
  ).get(token) as MatchRow | undefined;
  if (!match || match.server_id === null) return null;
  // A booked game (a scrim, or a tournament game the series engine started)
  // is never ended as an abandon: no abort, no ban, no requeue. A tournament
  // box is pushed sm_pug_leave_budget 0 so the plugin never sends this; an
  // older box or a lost push must still not stall a series (T3b final review).
  if (match.booking_id !== null) {
    if (!bookedLogged.has(token)) {
      bookedLogged.add(token);
      console.warn(`[abandon] ignored ABANDON of ${steamid} on match ${match.id}: it is a booked game (booking ${match.booking_id})`);
    }
    return null;
  }
  const rostered = db.prepare('SELECT team FROM match_players WHERE match_id = ? AND player_id = ?').get(match.id, steamid) as
    { team: 'a' | 'b' } | undefined;
  if (!rostered) return null;
  if (inFlight.has(token)) return null;
  inFlight.add(token);
  try {
    const existing = db.prepare('SELECT player_id, decided FROM match_abandons WHERE match_id = ?').get(match.id) as
      { player_id: string; decided: 'a' | 'b' | null } | undefined;
    if (existing) {
      // One abandon per match: the first one confirmed stands. What is left
      // to do is only a decided end that has not landed yet.
      if (existing.player_id !== steamid || existing.decided === null) return null;
      return await endAsDecided(deps, match, steamid, existing.decided, null);
    }

    let confirmed: AbandonConfirm;
    try {
      confirmed = asConfirm(await deps.confirm(match.server_id, steamid));
    } catch (err) {
      console.error(`[abandon] could not confirm abandon on match ${match.id}; will retry on the next line:`, err);
      return null;
    }
    if (!confirmed.abandoner) return null;

    const decided = match.kind === 'pug' && deps.endDecided ? confirmed.gg?.decided ?? null : null;
    const minutes = abandonBanMinutes(db, steamid);
    const reason = `Abandoned match #${match.id}`;
    const changed = db.transaction(() => {
      const live = db.prepare("SELECT 1 FROM matches WHERE id = ? AND state IN ('configuring', 'live')").get(match.id);
      if (!live) return false;
      if (!decided) {
        db.prepare("UPDATE matches SET state = 'aborted', abort_cause = 'abandon', ended_at = datetime('now') WHERE id = ?").run(match.id);
      }
      db.prepare(
        `INSERT INTO match_abandons (match_id, player_id, team, decided, gap, ceiling, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run(match.id, steamid, rostered.team, decided, confirmed.gg?.gap ?? null, confirmed.gg?.ceiling ?? null, new Date().toISOString());
      insertBan(db, steamid, 'system', reason, minutes);
      return true;
    })();
    if (!changed) return null;
    // After the outer commit, never inside it: see insertBan's doc comment.
    publishBanChange({ kind: 'ban', steamid, reason });
    if (!decided) return abortForAbandon(deps, match, steamid, minutes);
    return await endAsDecided(deps, match, steamid, decided, minutes);
  } finally {
    inFlight.delete(token);
  }
}

/** The undecided end: aborted (already written), archived, the quitter's
 *  loss, server released, everyone told. */
function abortForAbandon(deps: AbandonDeps, match: MatchRow, steamid: string, minutes: number): number {
  const { db } = deps;
  archiveAborted(db, match.id);
  // After the archive, which writes the match_maps the lineup is judged on.
  try {
    applyAbandonPenalty(db, match.id);
  } catch (err) {
    console.error(`[abandon] could not apply the abandon loss on match ${match.id}; a season recompute will:`, err);
  }
  deps.releaser.release(match.server_id!, { teardown: true, restart: true });
  publishAdminEvent({ kind: 'abandon', steamid, matchId: match.id, minutes, decided: null });
  // The seven who stayed go back to the front of the queue; the leaver is
  // banned, which keeps them out of it anyway.
  noteMatchAborted(db, { matchId: match.id, cause: 'abandon', culprits: [steamid], requeue: true });
  console.warn(`[abandon] match ${match.id} ended: ${steamid} abandoned it; banned for ${minutes} minutes`);
  return match.id;
}

/** The decided end: the plugin ends the match and the ordinary collector
 *  completes and rates it. `minutes` is null on a retry, whose ban was
 *  already filed and announced. */
async function endAsDecided(
  deps: AbandonDeps, match: MatchRow, steamid: string, decided: 'a' | 'b', minutes: number | null,
): Promise<number | null> {
  const { db } = deps;
  let answer: 'ok' | 'refused';
  try {
    answer = await deps.endDecided!(match.server_id!, match.token, steamid);
  } catch (err) {
    // The row and the ban stand. If the plugin did end it, its MATCH_END is
    // collected as usual and rated with the abandon; if not, it is still
    // repeating ABANDON and the next line asks again.
    console.error(`[abandon] could not tell the server to end decided match ${match.id}; will retry on the next line:`, err);
    return null;
  }
  if (answer === 'refused') {
    // The plugin would not end it (it disagrees, or is too old): today's
    // abort, with the quitter's loss.
    const flipped = db.transaction(() => {
      const n = db.prepare("UPDATE matches SET state = 'aborted', abort_cause = 'abandon', ended_at = datetime('now') WHERE id = ? AND state IN ('configuring', 'live')")
        .run(match.id).changes;
      if (n === 0) return false;
      db.prepare('UPDATE match_abandons SET decided = NULL WHERE match_id = ?').run(match.id);
      return true;
    })();
    if (!flipped) return null;
    console.warn(`[abandon] match ${match.id}: the server refused to end it as decided; aborting instead`);
    return abortForAbandon(deps, match, steamid, minutes ?? abandonBanMinutes(db, steamid));
  }
  publishAdminEvent({ kind: 'abandon', steamid, matchId: match.id, minutes: minutes ?? currentAbandonBanMinutes(db, steamid, match.id), decided });
  console.warn(`[abandon] match ${match.id}: ${steamid} abandoned a decided match; team ${decided} wins, collecting the result`);
  deps.finish?.(match.id);
  return match.id;
}

/** The length of the abandon ban already filed for this match, in minutes. */
function currentAbandonBanMinutes(db: DB, steamid: string, matchId: number): number {
  const b = db.prepare('SELECT created_at, expires_at FROM bans WHERE player_id = ? AND reason = ? ORDER BY id DESC LIMIT 1')
    .get(steamid, `Abandoned match #${matchId}`) as { created_at: string; expires_at: string | null } | undefined;
  if (!b?.expires_at) return 0;
  return Math.round((Date.parse(b.expires_at) - Date.parse(b.created_at)) / 60_000);
}
