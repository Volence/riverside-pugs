import { randomInt } from 'node:crypto';
import type { DB } from '../db.js';
import type { Notifier } from '../notify/notify.js';
import * as E from './events.js';
import * as N from './entries.js';
import * as P from './play.js';
import * as R from './room.js';
import { forfeitMatch, stageTable } from './flow.js';
import { tellReadyForfeit, tellRoomOpen } from './notices.js';
import { autoAction, isHumanStep, type Side } from './veto.js';

export const ROOM_TICK_MS = 5_000;

/** The statuses whose deadline the clock acts on and resumes: the T3a
 *  ready check, veto and lineups, and (plan T3b) a live match's between-game
 *  pick and the confirm window. A connect deadline is the engine's (presence). */
const ACTING: ReadonlySet<P.MatchStatus> = new Set<P.MatchStatus>(['veto', 'lineup', 'live', 'confirming']);

/**
 * The match room's clock (tournaments plan T3a), every 5 seconds. It opens
 * rooms in rolling stages (Ruling 2) and acts on every passed deadline: the
 * ready check (forfeit or hold), a veto step (from the team's saved order,
 * Ruling 7), the lineups (Ruling 9); from plan T3b it also ticks the series
 * engine, acts on a timed-out between-game pick and a passed confirm window,
 * and resumes both. resume() runs once at start (Ruling 16). Each match is
 * caught on its own, so one bad row never stops the rest; every change it
 * makes is pushed so the room page refetches.
 */

/** Ruling 5: the better stage seed in a bracket, the better standing (then
 *  seed) in a table stage. */
export function higherSide(db: DB, m: P.MatchRow): Side {
  const stage = E.getStage(db, m.stage_id)!;
  const entrants = P.stageEntrants(stage);
  const seed = (id: number) => (entrants.indexOf(id) < 0 ? 1_000_000 : entrants.indexOf(id));
  let rank = seed;
  if (stage.type === 'swiss' || stage.type === 'league' || stage.type === 'round_robin') {
    const pos = new Map(stageTable(db, stage).map((r) => [r.entryId, r.rank]));
    rank = (id) => (pos.get(id) ?? 1_000_000) * 1000 + seed(id);
  }
  return rank(m.entry_a!) <= rank(m.entry_b!) ? 'a' : 'b';
}

/** Rolling-stage matches whose room may open now: both teams known and
 *  still in, not_before passed, each team's earliest unresolved match of the
 *  stage, neither team busy, at most one room per team. */
export function dueRooms(db: DB, now: Date): P.MatchRow[] {
  const rows = db.prepare(
    `SELECT m.* FROM event_matches m JOIN event_stages s ON s.id = m.stage_id
     WHERE ${R.ROOM_LIVE_SQL} AND s.scheduling = 'rolling' AND m.status = 'waiting'
       AND m.entry_a IS NOT NULL AND m.entry_b IS NOT NULL AND (m.not_before IS NULL OR m.not_before <= ?)
     ORDER BY m.event_id, m.round, m.grp, m.slot`,
  ).all(now.toISOString()) as P.MatchRow[];
  const out: P.MatchRow[] = [];
  const taken = new Map<number, Set<number>>();
  for (const m of rows) {
    if (!taken.has(m.event_id)) taken.set(m.event_id, R.busyEntries(db, m.event_id));
    const busy = taken.get(m.event_id)!;
    const ids = [m.entry_a!, m.entry_b!];
    if (ids.some((id) => busy.has(id) || !N.isActive(N.getEntry(db, id)!))) continue;
    if (ids.some((id) => earliestOf(db, m.stage_id, id) !== m.id)) continue;
    ids.forEach((id) => busy.add(id));
    out.push(m);
  }
  return out;
}

function earliestOf(db: DB, stageId: number, entryId: number): number | undefined {
  const row = db.prepare(
    `SELECT id FROM event_matches WHERE stage_id = ? AND (entry_a = ? OR entry_b = ?) AND status NOT IN ('done','forfeit','bye')
     ORDER BY round, grp, slot LIMIT 1`,
  ).get(stageId, entryId, entryId) as { id: number } | undefined;
  return row?.id;
}

export class RoomClock {
  private ticking = false;
  private readonly now: () => number;
  /** Matches whose overdue action was refused, keyed by kind and id: the
   *  clock retries every tick, so a refusal is logged once until it clears. */
  private readonly refused = new Set<string>();

  constructor(private readonly deps: {
    db: DB; notifier?: Notifier; publicUrl?: string; push?: (matchId: number) => void; now?: () => number; seed?: () => number;
    /** The series engine (plan T3b). */
    series?: { tick(now: Date): void; afterPick(matchId: number): void; finalize(matchId: number, now: Date): Promise<boolean> };
  }) {
    this.now = deps.now ?? Date.now;
  }

  /** Tells the room page to refetch; public so the room routes push the
   *  same way after a person acts (Task 6). Never throws. */
  pushChange(matchId: number): void {
    try { this.deps.push?.(matchId); } catch (err) { console.warn('[rooms] push failed:', err instanceof Error ? err.message : err); }
  }

  private refusedOnce(kind: string, matchId: number, line: string): void {
    const key = `${kind}:${matchId}`;
    if (this.refused.has(key)) return;
    this.refused.add(key);
    console.error(line);
  }

  /** Ruling 16, once at start. */
  resume(): void {
    const { db } = this.deps;
    const now = new Date(this.now());
    const timers = R.roomTimers(db);
    const rows = db.prepare(
      `SELECT m.id FROM event_matches m WHERE ${R.ROOM_LIVE_SQL} AND m.status IN ('veto','lineup','live','confirming') AND m.deadline IS NOT NULL AND m.deadline <= ?`,
    ).all(now.toISOString()) as { id: number }[];
    for (const { id } of rows) {
      try { R.resumeDeadline(db, { matchId: id, timers, now }); } catch (err) { console.error(`[rooms] resume of match ${id} failed:`, err); }
    }
  }

  async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      const now = new Date(this.now());
      this.openDue(now);
      // Tournaments plan T3b: bookings, the server wait alert, the presence fallback.
      try { this.deps.series?.tick(now); } catch (err) { console.error('[rooms] series tick failed:', err instanceof Error ? err.message : err); }
      await this.expire(now);
    } catch (err) {
      console.error('[rooms] tick failed:', err instanceof Error ? err.message : err);
    } finally {
      this.ticking = false;
    }
  }

  private openDue(now: Date): void {
    const { db } = this.deps;
    const timers = R.roomTimers(db);
    for (const m of dueRooms(db, now)) {
      try {
        const r = R.openRoom(db, { matchId: m.id, by: null, higher: higherSide(db, m), seed: this.deps.seed?.() ?? randomInt(2 ** 31), timers, now });
        if (!r.ok) continue;
        tellRoomOpen(this.deps, m.event_id, m.id);
        this.pushChange(m.id);
      } catch (err) {
        console.error(`[rooms] open of match ${m.id} failed:`, err instanceof Error ? err.message : err);
      }
    }
  }

  private async expire(now: Date): Promise<void> {
    const { db } = this.deps;
    const rows = db.prepare(
      `SELECT m.* FROM event_matches m WHERE ${R.ROOM_LIVE_SQL} AND m.status IN ('veto','lineup','live','confirming') AND m.deadline IS NOT NULL AND m.deadline <= ?
       ORDER BY m.deadline, m.id`,
    ).all(now.toISOString()) as P.MatchRow[];
    // A refusal is forgotten once its match is no longer overdue, however it
    // left (a staff hold, a captain's step, a result): the set stays as small
    // as the overdue list, and a later refusal is logged again (T3b final review).
    const overdue = new Set(rows.map((m) => m.id));
    for (const key of this.refused) if (!overdue.has(Number(key.slice(key.indexOf(':') + 1)))) this.refused.delete(key);
    for (const m of rows) {
      try {
        await this.expireOne(m, now);
      } catch (err) {
        console.error(`[rooms] deadline of match ${m.id} failed:`, err instanceof Error ? err.message : err);
      }
    }
  }

  /** snap is the row as expire() selected it, possibly several awaits ago:
   *  a captain may have taken the overdue step (and reset the deadline) in
   *  between, so the row is re-read and acted on only if still overdue. */
  private async expireOne(snap: P.MatchRow, now: Date): Promise<void> {
    const { db } = this.deps;
    const m = P.getMatch(db, snap.id);
    if (!m || !ACTING.has(m.status) || m.deadline === null || m.deadline > now.toISOString()) return;
    const timers = R.roomTimers(db);
    if (m.status === 'confirming') {
      // T3b Ruling 9: the window passed with no dispute.
      if (!this.deps.series) return;
      if (await this.deps.series.finalize(m.id, now)) {
        this.refused.delete(`confirm:${m.id}`);
        this.pushChange(m.id);
      } else this.refusedOnce('confirm', m.id, `[rooms] match ${m.id}: its confirm window passed but no result was recorded; retrying every tick`);
      return;
    }
    if (m.status === 'veto' && (m.ready_a_at === null || m.ready_b_at === null)) {
      const a = m.ready_a_at !== null;
      const b = m.ready_b_at !== null;
      if (a !== b) {
        const r = await forfeitMatch(db, {
          eventId: m.event_id, matchId: m.id, winner: a ? 'a' : 'b', now,
          expect: (x) => x.status === 'veto' && x.ready_a_at === m.ready_a_at && x.ready_b_at === m.ready_b_at,
        });
        if (r.ok) tellReadyForfeit(this.deps, m.event_id, m.id);
      } else {
        R.holdMatch(db, { matchId: m.id, by: null, reason: 'nobody_ready', now });
      }
      this.pushChange(m.id);
      return;
    }
    if (m.status === 'veto' || m.status === 'live') {
      const st = R.roomState(db, m);
      if (!isHumanStep(st.next)) return;
      const stage = E.getStage(db, m.stage_id)!;
      const entryId = R.entryOn(m, st.next.by);
      const pool = E.stageSettingsOf(stage).campaignPool;
      const a = autoAction(st, pool, { campaigns: R.campaignPrefs(db, entryId, stage.id), side: R.entryPrefs(db, entryId).side });
      const r = R.actVeto(db, { matchId: m.id, steamid: null, step: st.used, action: a.action, campaign: a.campaign, timers, now });
      if (!r.ok) {
        this.refusedOnce('veto', m.id, `[rooms] match ${m.id}: the timed-out ${a.action} at step ${st.used} was refused (${r.error}); retrying every tick`);
        return;
      }
      this.refused.delete(`veto:${m.id}`);
      // T3b Ruling 4: a timed-out between-game pick; once nothing human is left the game is scheduled.
      // The pick is committed, so a throw is logged and the push still goes out.
      if (r.value.status === 'live') {
        try { this.deps.series?.afterPick(m.id); } catch (err) { console.error(`[rooms] scheduling match ${m.id} after the timed-out pick failed:`, err instanceof Error ? err.message : err); }
      }
      this.pushChange(m.id);
      return;
    }
    const locked = new Set(R.lineupsOf(db, m.id).filter((l) => l.game === 1).map((l) => l.entry_id));
    for (const side of ['a', 'b'] as const) {
      const entryId = R.entryOn(m, side);
      if (locked.has(entryId)) continue;
      const four = R.autoFour({ defaultFour: R.entryPrefs(db, entryId).defaultFour, lastFour: R.lastFour(db, entryId), playable: R.playableOf(db, entryId) });
      const r = R.lockLineup(db, { matchId: m.id, steamid: null, side, steamids: four, timers, now });
      if (!r.ok && r.error === 'bad_lineup') {
        R.holdMatch(db, { matchId: m.id, by: null, reason: 'lineup_short', now });
        break;
      }
    }
    this.pushChange(m.id);
  }
}
