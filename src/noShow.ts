import type { DB } from './db.js';
import { settingNumber } from './settings.js';
import type { ServerReleaser } from './serverRelease.js';
import { recordPenalty } from './penalties.js';
import { publishAdminEvent } from './adminFeed.js';
import { noteMatchAborted } from './matchAborts.js';
import { escapeName } from './identity.js';

/** Minutes staff may add to one match's no-show deadline, in total. Enough to
 *  wait out a slow download or a Steam hiccup; past that the match is not
 *  going to happen and the seven who did turn up are better off requeued. */
export const NOSHOW_EXTEND_STEP_MIN = 5;
export const NOSHOW_EXTEND_MAX_MIN = 30;

/** sqlite's datetime('now') or an ISO string, as epoch milliseconds. Shared
 *  with the live board, which reads the same pop and live times. */
export const toMs = (t: string): number => Date.parse(t.includes('T') ? t : `${t.replace(' ', 'T')}Z`);

/**
 * Every rostered player with a connect drop since the pop and no entry after
 * it (markEntered stamps every open drop the moment the same steamid gets
 * in), with when the latest one was. The one query behind both the live
 * board's "rejected by the file check" and fileCheckRejects below, so the
 * board and the reaper cannot disagree about who was turned away.
 */
export function signonDropsSincePop(db: DB, matchId: number): Map<string, { at: string; connected: boolean }> {
  const m = db.prepare('SELECT created_at FROM matches WHERE id = ?').get(matchId) as { created_at: string } | undefined;
  if (!m) return new Map();
  const poppedIso = new Date(toMs(m.created_at)).toISOString();
  const rows = db.prepare(
    `SELECT mp.player_id, MAX(d.at) AS at, mp.connected_at IS NOT NULL AS connected FROM match_players mp
     JOIN signon_drops d ON d.steamid = mp.player_id AND d.at >= ? AND d.entered_after_at IS NULL
     WHERE mp.match_id = ? GROUP BY mp.player_id`,
  ).all(poppedIso, matchId) as { player_id: string; at: string; connected: number }[];
  return new Map(rows.map((r) => [r.player_id, { at: r.at, connected: r.connected === 1 }]));
}

/**
 * Rostered players the file check turned away since the pop and who have not
 * got in since: the same "rejected by the file check" the live board shows.
 * They tried to connect, so a no-show abort does not penalise them.
 */
export function fileCheckRejects(db: DB, matchId: number): string[] {
  return [...signonDropsSincePop(db, matchId)].filter(([, d]) => !d.connected).map(([p]) => p);
}

/**
 * Stamp the first time a rostered player is seen on the match server.
 *
 * First connect only: the plugin re-fires PLAYER connect for every client
 * across a map transition (they "reconnect" through the changelevel), so
 * overwriting would make every timestamp read as the most recent map change.
 */
export function recordPlayerConnect(db: DB, token: string, steamid: string): void {
  db.prepare(
    `UPDATE match_players SET connected_at = datetime('now')
     WHERE player_id = ?
       AND connected_at IS NULL
       AND match_id IN (SELECT id FROM matches WHERE token = ?)`,
  ).run(steamid, token);
}

/**
 * Abort live matches that never actually got going, and free their box.
 *
 * The orphan reaper cannot see these. Timer_Heartbeat fires whenever the
 * plugin holds a match, connected humans or not, so a match nobody joined
 * heartbeats forever and pins servers.status = 'live' forever. Since a match
 * with no free server now waits rather than aborting, that pin would deadlock
 * every future queue pop.
 *
 * Two rules:
 *   1. Past noshow_minutes, plus whatever staff added to this match from the
 *      live board (matches.noshow_extra_minutes), with fewer than
 *      noshow_min_connected of the roster ever connected: nobody turned up.
 *   2. Past no_round_minutes, plus the same extra minutes, with no round
 *      ever recorded: everyone turned up and then nobody readied.
 */
export function reapNoShowMatches(db: DB, releaser: ServerReleaser): number[] {
  // settingNumber, not Number(): a blank row here once aborted every live
  // match, and that is the incident the helper's comment records.
  const noShowMin = settingNumber(db, 'noshow_minutes', 10);
  const minConnected = settingNumber(db, 'noshow_min_connected', 6);
  const noRoundMin = settingNumber(db, 'no_round_minutes', 30);

  const rows = db
    .prepare(
      `SELECT m.id, m.server_id, m.noshow_extra_minutes AS extra,
              (julianday('now') - julianday(m.went_live_at)) * 24 * 60 AS age_min,
              (SELECT COUNT(*) FROM match_players mp
                WHERE mp.match_id = m.id AND mp.connected_at IS NOT NULL) AS connected,
              (SELECT COUNT(*) FROM match_rounds r WHERE r.match_id = m.id) AS rounds
         FROM matches m
        WHERE m.state = 'live' AND m.went_live_at IS NOT NULL`,
    )
    .all() as { id: number; server_id: number | null; extra: number; age_min: number; connected: number; rounds: number }[];

  const noShows = (r: (typeof rows)[number]) => r.age_min >= noShowMin + r.extra && r.connected < minConnected;
  // The extension moves this rule too. Otherwise extending past the no-round
  // deadline buys nothing: the players staff are waiting for connect, nobody
  // can have readied yet, and the backstop ends the match on the old clock.
  const doomed = rows.filter((r) => noShows(r) || (r.age_min >= noRoundMin + r.extra && r.rounds === 0));

  for (const r of doomed) {
    // No clearLive() here, unlike the sibling reapOrphanedMatches, and that is
    // deliberate rather than an oversight: getLiveMatches only ever selects
    // matches in state 'live', so the leftover match_live rows of a match we
    // have just marked 'aborted' are unreachable scratch. The orphan reaper
    // clears them because it runs on matches that WERE heartbeating and so
    // have a full scratch set worth reclaiming; a no-show match has almost
    // none. Adding the call would be harmless, but nothing depends on it.
    // Only the "nobody turned up" rule names culprits. The no-round rule means
    // everyone connected and the game never started, which is nobody's no-show.
    // A player the file check turned away did try to connect, so they are no
    // no-show either; the match still aborts, since they are not in it.
    const noShowRule = noShows(r);
    db.prepare("UPDATE matches SET state = 'aborted', abort_cause = ?, ended_at = datetime('now') WHERE id = ?")
      .run(noShowRule ? 'no_show' : 'no_round', r.id);
    if (r.server_id !== null) releaser.release(r.server_id, { teardown: true });
    let culprits: string[] = [];
    let rejected: string[] = [];
    if (noShowRule) {
      rejected = fileCheckRejects(db, r.id);
      const absent = (db.prepare('SELECT player_id FROM match_players WHERE match_id = ? AND connected_at IS NULL')
        .all(r.id) as { player_id: string }[]).map((a) => a.player_id);
      culprits = absent.filter((p) => !rejected.includes(p));
      for (const p of culprits) recordPenalty(db, p, 'no_show', r.id);
    }
    // Named, with their side: "6 connected" alone sent staff to the match
    // page to find out who was missing (owner, 2026-10-05).
    const named = (ids: string[]) => ids.map((p) => {
      const row = db.prepare(
        'SELECT COALESCE(p.name, mp.player_id) AS name, mp.team FROM match_players mp LEFT JOIN players p ON p.steamid = mp.player_id WHERE mp.match_id = ? AND mp.player_id = ?',
      ).get(r.id, p) as { name: string; team: string } | undefined;
      return `**${escapeName(row?.name ?? p)}** (Team ${(row?.team ?? '?').toUpperCase()})`;
    }).join(', ');
    const spared = (culprits.length === 0 ? ''
      : ` Never connected: ${named(culprits)}.`)
      + (rejected.length === 0 ? ''
        : ` Rejected by the file check, so they did try and got no penalty: ${named(rejected)}.`);
    publishAdminEvent({
      kind: 'problem', matchId: r.id,
      text: !noShowRule
        ? `Match #${r.id} aborted: nobody readied up in game after ${Math.round(r.age_min)} minutes.`
        : `Match #${r.id} aborted for no-shows: only ${r.connected} connected after ${Math.round(r.age_min)} minutes.${spared}`,
    });
    // The no-round rule requeues nobody: all eight were there and let it die,
    // and putting them straight back at the front would pop the same lobby.
    noteMatchAborted(db, noShowRule
      ? { matchId: r.id, cause: 'no_show', culprits, fileCheck: rejected, requeue: true }
      : { matchId: r.id, cause: 'no_round', requeue: false });
    console.warn(
      `[noShow] aborted match ${r.id}: ${r.connected} connected, ${r.rounds} rounds, ${Math.round(r.age_min)} min live`,
    );
  }
  return doomed.map((r) => r.id);
}

export interface NoShowClock {
  /** Minutes staff have added to this match's deadline so far. */
  extraMinutes: number;
  /** Seconds until the no-show rule aborts this match, as of `now`, or null
   *  when it cannot: enough of the roster has connected, a round has been
   *  played, or the match is not live. Never negative. */
  deadlineS: number | null;
  /** Whether the "+5 min" button belongs on the card at all: the match is
   *  live, nobody has played a round, and someone has never connected. */
  applies: boolean;
  /** Whether "+5 min" may be pressed now, and if not, why not. */
  canExtend: boolean;
  why: string | null;
}

/**
 * Where a live match stands against rule 1, for the live board and the
 * "+5 min" button. The same numbers reapNoShowMatches decides on, read the
 * same way, so the countdown on the board is the deadline the reaper keeps.
 */
export function noShowClock(db: DB, matchId: number, now = new Date()): NoShowClock | null {
  const m = db.prepare(
    `SELECT m.state, m.went_live_at, m.noshow_extra_minutes AS extra,
            (SELECT COUNT(*) FROM match_players mp WHERE mp.match_id = m.id AND mp.connected_at IS NOT NULL) AS connected,
            (SELECT COUNT(*) FROM match_players mp WHERE mp.match_id = m.id AND mp.connected_at IS NULL) AS absent,
            (SELECT COUNT(*) FROM match_rounds r WHERE r.match_id = m.id) AS rounds
     FROM matches m WHERE m.id = ?`,
  ).get(matchId) as { state: string; went_live_at: string | null; extra: number; connected: number; absent: number; rounds: number } | undefined;
  if (!m) return null;
  const noShowMin = settingNumber(db, 'noshow_minutes', 10);
  const minConnected = settingNumber(db, 'noshow_min_connected', 6);
  const running = m.state === 'live' && m.went_live_at !== null && m.rounds === 0;
  const deadlineS = running && m.connected < minConnected
    ? Math.max(0, Math.floor((toMs(m.went_live_at!) + (noShowMin + m.extra) * 60_000 - now.getTime()) / 1000))
    : null;
  const why = m.state !== 'live' || m.went_live_at === null ? 'the match is not live yet'
    : m.rounds > 0 ? 'a round has been played, so the no-show rule no longer applies'
    : m.absent === 0 ? 'everyone has connected'
    // The rule is already off, so a later deadline would change nothing.
    : m.connected >= minConnected ? `enough players have connected (${m.connected} of ${minConnected} needed), so the no-show rule will not end this match`
    : m.extra + NOSHOW_EXTEND_STEP_MIN > NOSHOW_EXTEND_MAX_MIN ? `the deadline is already ${m.extra} minutes later, the most it can move`
    : null;
  const applies = running && m.absent > 0;
  return { extraMinutes: m.extra, deadlineS, applies, canExtend: why === null, why };
}

/** Move one match's no-show deadline five minutes later. The whole rule
 *  moves, not one player's clock: everyone still missing gets the same five
 *  minutes (owner, 2026-09-29). */
export function extendNoShow(db: DB, matchId: number, now = new Date()):
  { ok: true; extraMinutes: number } | { ok: false; status: number; error: string } {
  const clock = noShowClock(db, matchId, now);
  if (!clock) return { ok: false, status: 404, error: 'no such match' };
  if (!clock.canExtend) return { ok: false, status: 409, error: clock.why ?? 'cannot extend' };
  db.prepare('UPDATE matches SET noshow_extra_minutes = noshow_extra_minutes + ? WHERE id = ?').run(NOSHOW_EXTEND_STEP_MIN, matchId);
  return { ok: true, extraMinutes: clock.extraMinutes + NOSHOW_EXTEND_STEP_MIN };
}
