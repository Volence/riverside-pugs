import type { DB } from './db.js';
import type { ServerReleaser } from './serverRelease.js';
import { archiveAborted } from './matchArchive.js';
import { insertBan } from './admin/players.js';
import { publishAdminEvent } from './adminFeed.js';
import { publishBanChange } from './banEvents.js';
import { noteMatchAborted } from './matchAborts.js';
import { applyAbandonPenalty } from './rating.js';
import { resolveAlias } from './aliases.js';

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
  /** The server records this player as one of the match's abandoners. */
  abandoner: boolean;
  /** Every player the server records as having run out of reconnect time
   *  (pug-match 0.3.31 lists them all; an older plugin only the first). */
  abandoners: string[];
  /** The STATUS gg line (pug-match 0.3.31): whether the match was decided,
   *  by the !gg rule, when the first of them ran out. Null from an older
   *  plugin, which then gets today's abort. */
  gg: { decided: 'a' | 'b' | null; gap: number; ceiling: number; known: boolean } | null;
}

export interface AbandonDeps {
  db: DB;
  releaser: ServerReleaser;
  /** Ask the game server whether it really recorded this player as an
   *  abandoner, who else it recorded, and whether the match was decided then
   *  (sm_pug_status). The log line alone arrives over UDP from an address
   *  anyone could spoof, and it ends a match and bans someone. A bare boolean
   *  is an answer with no list and no STATUS gg line, as from a plugin older
   *  than 0.3.31. */
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

/** Every abandoner an sm_pug_status body names: the legacy first-abandoner
 *  line, and pug-match 0.3.31's STATUS abandon line per quitter. */
export function statusAbandoners(body: string): string[] {
  const out = new Set<string>();
  for (const raw of body.split('\n')) {
    const l = raw.trim();
    const m = /^STATUS leave abandoner=(\d{17}) /.exec(l) ?? /^STATUS abandon steamid=(\d{17})(\s|$)/.exec(l);
    if (m) out.add(m[1]);
  }
  return [...out];
}

/** Whether an sm_pug_status body names `steamid` as an abandoner of the match. */
export function statusShowsAbandoner(body: string, steamid: string): boolean {
  return statusAbandoners(body).includes(steamid);
}

/** Read an sm_pug_status body for an abandon confirm: the abandoners, and
 *  the STATUS gg line when the plugin has one. Only a judgement made at the
 *  abandon (at=abandon) counts; a known=0 one is "not decided". */
export function parseAbandonStatus(body: string, steamid: string): AbandonConfirm {
  const abandoners = statusAbandoners(body);
  const abandoner = abandoners.includes(steamid);
  const line = body.split('\n').map((l) => l.trim()).find((l) => l.startsWith('STATUS gg '));
  if (!line) return { abandoner, abandoners, gg: null };
  const kv: Record<string, string> = {};
  for (const part of line.split(/\s+/).slice(2)) {
    const eq = part.indexOf('=');
    if (eq > 0) kv[part.slice(0, eq)] = part.slice(eq + 1);
  }
  const known = kv.known === '1' && kv.at === 'abandon';
  const decided = known && (kv.decided === 'a' || kv.decided === 'b') ? kv.decided : null;
  const num = (v: string | undefined) => (v !== undefined && /^-?\d+$/.test(v) ? Number(v) : -1);
  return { abandoner, abandoners, gg: { decided, gap: num(kv.gap), ceiling: num(kv.ceiling), known } };
}

function asConfirm(r: boolean | AbandonConfirm, steamid: string): AbandonConfirm {
  return typeof r === 'boolean' ? { abandoner: r, abandoners: r ? [steamid] : [], gg: null } : r;
}

/** One quitter newly on record: their ban was filed in the same write. */
export interface RecordedAbandon { steamid: string; minutes: number; reason: string }

/**
 * Put quitters on record for one match: a match_abandons row and an abandon
 * ban each (owner ruling 2026-10-10: every player who runs out of reconnect
 * time is a quitter, and each gets their own ban on their own ladder). Only
 * rostered players, and only ones not already on record, so a repeat is a
 * no-op. Call inside the caller's transaction; publish the bans after it
 * commits (publishRecorded), never inside it (see insertBan).
 */
export function recordAbandons(
  db: DB, matchId: number, steamids: string[], decided: 'a' | 'b' | null,
  gg: { gap: number; ceiling: number } | null,
): RecordedAbandon[] {
  const teamOf = db.prepare('SELECT team FROM match_players WHERE match_id = ? AND player_id = ?');
  const has = db.prepare('SELECT 1 FROM match_abandons WHERE match_id = ? AND player_id = ?');
  const ins = db.prepare(
    `INSERT INTO match_abandons (match_id, player_id, team, decided, gap, ceiling, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  const out: RecordedAbandon[] = [];
  for (const steamid of new Set(steamids)) {
    const row = teamOf.get(matchId, steamid) as { team: 'a' | 'b' } | undefined;
    if (!row || has.get(matchId, steamid)) continue;
    const minutes = abandonBanMinutes(db, steamid);
    const reason = `Abandoned match #${matchId}`;
    ins.run(matchId, steamid, row.team, decided, gg?.gap ?? null, gg?.ceiling ?? null, new Date().toISOString());
    insertBan(db, steamid, 'system', reason, minutes);
    out.push({ steamid, minutes, reason });
  }
  return out;
}

/** After the commit: tell the game servers about each new ban and staff
 *  about each quitter. */
export function publishRecorded(matchId: number, recorded: RecordedAbandon[], decided: 'a' | 'b' | null): void {
  for (const r of recorded) {
    publishBanChange({ kind: 'ban', steamid: r.steamid, reason: r.reason });
    publishAdminEvent({ kind: 'abandon', steamid: r.steamid, matchId, minutes: r.minutes, decided });
  }
}

interface MatchRow { id: number; server_id: number | null; booking_id: number | null; kind: string; token: string }

/**
 * A rostered player used up their reconnect allowance (pug-leave.inc).
 *
 * Owner rulings 2026-10-10 (docs/ship-abandon-rating.md):
 *  - Decided (the !gg rule, judged by the server when the first quitter ran
 *    out, read back over rcon): the match is NOT aborted. The plugin ends it
 *    with the score as it stands (sm_pug_abandon_end), the leading team wins,
 *    and it is collected and rated like any finished match, for everyone but
 *    the quitters.
 *  - Not decided, or a plugin too old to say: aborted, no rating change for
 *    anyone who stayed, server released, live scratch archived.
 *  - Either way EVERY quitter takes a rating loss (src/rating.ts
 *    quitterLoss) and an abandon ban, which escalates as before.
 *
 * The confirm records every abandoner the server names, not only the one on
 * this line, so two players who ran out together are both caught by one
 * rcon read. A quitter the server only names later is added by a later line
 * while the match is still live, or from the dump's ABANDON lines when the
 * result is collected (src/matchResult.ts).
 *
 * The match_abandons rows are the commit point: written with the bans, in one
 * transaction, before the plugin is asked to end anything. A repeat of a line
 * only retries the end that has not landed yet. Returns the match id when
 * this call ended the match (or handed it to the collector); null otherwise.
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
  if (!db.prepare('SELECT 1 FROM match_players WHERE match_id = ? AND player_id = ?').get(match.id, steamid)) return null;
  if (inFlight.has(token)) return null;
  inFlight.add(token);
  try {
    const rows = db.prepare('SELECT player_id, decided FROM match_abandons WHERE match_id = ?').all(match.id) as
      { player_id: string; decided: 'a' | 'b' | null }[];
    const onRecord = rows.find((r) => r.player_id === steamid);
    // The match already had its abandon; it is still live only because it
    // was decided and is being ended and collected.
    const decidedBefore = rows.find((r) => r.decided !== null)?.decided ?? null;
    if (onRecord) {
      if (onRecord.decided === null) return null;
      return await endAsDecided(deps, match, steamid, onRecord.decided);
    }

    let confirmed: AbandonConfirm;
    try {
      confirmed = asConfirm(await deps.confirm(match.server_id, steamid), steamid);
    } catch (err) {
      console.error(`[abandon] could not confirm abandon on match ${match.id}; will retry on the next line:`, err);
      return null;
    }
    // The plugin names accounts as they connected; the site keeps one
    // canonical account per person, as the log listener does for the line.
    const named = [...new Set(confirmed.abandoners.map((id) => resolveAlias(db, id)))];
    if (!confirmed.abandoner && !named.includes(steamid)) return null;
    confirmed = { ...confirmed, abandoner: true, abandoners: named };

    if (rows.length > 0) {
      // Another quitter on a match already ended as decided: on record with
      // the same outcome, and the end retried in case it has not landed.
      if (decidedBefore === null) return null;
      const added = db.transaction(() => recordAbandons(db, match.id, [steamid], decidedBefore, null))();
      publishRecorded(match.id, added, decidedBefore);
      return await endAsDecided(deps, match, steamid, decidedBefore);
    }

    const decided = match.kind === 'pug' && deps.endDecided ? confirmed.gg?.decided ?? null : null;
    const quitters = [steamid, ...confirmed.abandoners.filter((x) => x !== steamid)];
    const recorded = db.transaction(() => {
      const live = db.prepare("SELECT 1 FROM matches WHERE id = ? AND state IN ('configuring', 'live')").get(match.id);
      if (!live) return null;
      if (!decided) {
        db.prepare("UPDATE matches SET state = 'aborted', abort_cause = 'abandon', ended_at = datetime('now') WHERE id = ?").run(match.id);
      }
      return recordAbandons(db, match.id, quitters, decided, confirmed.gg);
    })();
    if (!recorded) return null;
    if (!decided) {
      publishRecorded(match.id, recorded, null);
      return abortForAbandon(deps, match);
    }
    publishRecorded(match.id, recorded, decided);
    return await endAsDecided(deps, match, steamid, decided);
  } finally {
    inFlight.delete(token);
  }
}

/** The undecided end: aborted (already written), archived, every quitter's
 *  loss, server released, everyone told. */
function abortForAbandon(deps: AbandonDeps, match: MatchRow): number {
  const { db } = deps;
  const quitters = (db.prepare('SELECT player_id FROM match_abandons WHERE match_id = ?').all(match.id) as { player_id: string }[])
    .map((r) => r.player_id);
  archiveAborted(db, match.id);
  // After the archive, which writes the match_maps the lineup is judged on.
  try {
    applyAbandonPenalty(db, match.id);
  } catch (err) {
    console.error(`[abandon] could not apply the abandon losses on match ${match.id}; a season recompute will:`, err);
  }
  deps.releaser.release(match.server_id!, { teardown: true, restart: true });
  // Those who stayed go back to the front of the queue; the quitters are
  // banned, which keeps them out of it anyway.
  noteMatchAborted(db, { matchId: match.id, cause: 'abandon', culprits: quitters, requeue: true });
  console.warn(`[abandon] match ${match.id} ended: ${quitters.join(', ')} abandoned it`);
  return match.id;
}

/** The decided end: the plugin ends the match and the ordinary collector
 *  completes and rates it. */
async function endAsDecided(deps: AbandonDeps, match: MatchRow, steamid: string, decided: 'a' | 'b'): Promise<number | null> {
  const { db } = deps;
  let answer: 'ok' | 'refused';
  try {
    answer = await deps.endDecided!(match.server_id!, match.token, steamid);
  } catch (err) {
    // The rows and bans stand. If the plugin did end it, its MATCH_END is
    // collected as usual and rated with the abandons; if not, it is still
    // repeating ABANDON and the next line asks again.
    console.error(`[abandon] could not tell the server to end decided match ${match.id}; will retry on the next line:`, err);
    return null;
  }
  if (answer === 'refused') {
    // The plugin would not end it (it disagrees, or is too old): today's
    // abort, with every quitter's loss.
    const flipped = db.transaction(() => {
      const n = db.prepare("UPDATE matches SET state = 'aborted', abort_cause = 'abandon', ended_at = datetime('now') WHERE id = ? AND state IN ('configuring', 'live')")
        .run(match.id).changes;
      if (n === 0) return false;
      db.prepare('UPDATE match_abandons SET decided = NULL WHERE match_id = ?').run(match.id);
      return true;
    })();
    if (!flipped) return null;
    console.warn(`[abandon] match ${match.id}: the server refused to end it as decided; aborting instead`);
    return abortForAbandon(deps, match);
  }
  console.warn(`[abandon] match ${match.id}: abandoned after it was decided; team ${decided} wins, collecting the result`);
  deps.finish?.(match.id);
  return match.id;
}
