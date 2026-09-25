import type { DB } from './db.js';
import type { DemoShift } from './logParse.js';

/** Correct the demo sync of rounds recorded by pug-match 0.3.12 to 0.3.14.
 *
 *  Those plugins stamped demo ticks off GetGameTickCount, which stands still
 *  while the server is paused while the SourceTV demo keeps recording. So a
 *  pause on a map made every later half's demo_tick early by the pause's
 *  length (match 186 map 2: 67 s), and a pause inside a half put every later
 *  moment of that half early by the same (t_ms is game time too). 0.3.15
 *  reads the demo's own tick and lists in-half pauses as demo_shifts.
 *
 *  The pause ledger (match_pauses) is what this rebuilds both from. It is
 *  wall-clock seconds from 1 Hz PHASE lines, as is match_rounds.started_at,
 *  so a corrected tick is good to about a second or two (100 to 200 ticks at
 *  100 tick), against errors the length of the pause before.
 *
 *  Only rounds that went live before `before` (the 0.3.15 rollout, UTC,
 *  'YYYY-MM-DD HH:MM:SS') and of matches no longer live: a 0.3.15 round is
 *  already right, and correcting it again would break it. A processed row
 *  gets demo_shifts '[]' when it had no in-half pause, which is what makes a
 *  second run a no-op. */

export interface DemoShiftFix {
  matchId: number; ordinal: number; half: number;
  oldTick: number; newTick: number; shifts: DemoShift[];
}

function sec(ts: string): number {
  return Date.parse(`${ts.replace(' ', 'T')}Z`) / 1000;
}

export function planDemoShiftBackfill(db: DB, before: string): DemoShiftFix[] {
  const rounds = db.prepare(
    `SELECT r.match_id AS matchId, r.ordinal, r.half, r.started_at AS startedAt, r.ended_at AS endedAt,
            r.demo_tick AS tick, r.demo_hz AS hz
     FROM match_rounds r JOIN matches m ON m.id = r.match_id
     WHERE r.demo_tick IS NOT NULL AND r.demo_hz IS NOT NULL AND r.demo_shifts IS NULL
       AND r.started_at IS NOT NULL AND r.started_at < ? AND m.state != 'live'
     ORDER BY r.match_id, r.ordinal, r.half`,
  ).all(before) as {
    matchId: number; ordinal: number; half: number; startedAt: string; endedAt: string | null;
    tick: number; hz: number;
  }[];
  const pausesOf = db.prepare(
    `SELECT started_at AS startedAt, ended_at AS endedAt FROM match_pauses
     WHERE match_id = ? AND map_ordinal = ? AND ended_at IS NOT NULL ORDER BY started_at, id`,
  );

  const fixes: DemoShiftFix[] = [];
  for (const r of rounds) {
    const start = sec(r.startedAt);
    const end = r.endedAt === null ? Infinity : sec(r.endedAt);
    const pauses = (pausesOf.all(r.matchId, r.ordinal) as { startedAt: string; endedAt: string }[])
      .map((p) => ({ from: sec(p.startedAt), to: sec(p.endedAt) }))
      .filter((p) => Number.isFinite(p.from) && Number.isFinite(p.to) && p.to > p.from);

    // Paused before this half went live, on this map's demo: the go-live
    // tick itself was early by all of it.
    let earlier = 0;
    for (const p of pauses) if (p.to <= start) earlier += p.to - p.from;

    // Paused inside this half: where on the round clock, which did not run
    // through the earlier pauses of the half.
    const shifts: DemoShift[] = [];
    let inHalf = 0;
    for (const p of pauses) {
      if (p.from < start || p.from >= end) continue;
      const tMs = Math.max(0, Math.round((p.from - start - inHalf) * 1000));
      const ticks = Math.round((p.to - p.from) * r.hz);
      inHalf += p.to - p.from;
      if (ticks > 0) shifts.push({ tMs, ticks });
    }

    fixes.push({
      matchId: r.matchId, ordinal: r.ordinal, half: r.half,
      oldTick: r.tick, newTick: r.tick + Math.round(earlier * r.hz), shifts,
    });
  }
  return fixes;
}

export function applyDemoShiftBackfill(db: DB, fixes: DemoShiftFix[]): void {
  const update = db.prepare(
    `UPDATE match_rounds SET demo_tick = ?, demo_shifts = ?
     WHERE match_id = ? AND ordinal = ? AND half = ? AND demo_shifts IS NULL AND demo_tick = ?`,
  );
  db.transaction(() => {
    for (const f of fixes) {
      update.run(f.newTick, JSON.stringify(f.shifts), f.matchId, f.ordinal, f.half, f.oldTick);
    }
  })();
}
