// Shadow store for health-run scoring: one match_round_alt row per half and
// rule. Nothing here touches match_rounds or any real result.
import type { DB } from './db.js';
import type { AltRoundFields } from './logParse.js';

/** Write one half's alt score. The completion dump is authoritative: a 'dump'
 *  write always replaces, a 'udp' write never overwrites a 'dump' row (a late
 *  or duplicated datagram must not undo the dump). */
export function upsertAltRound(db: DB, matchId: number, ordinal: number, f: AltRoundFields, source: 'udp' | 'dump'): void {
  const r = f.raw;
  db.prepare(
    `INSERT INTO match_round_alt (match_id, ordinal, half, rule, surv_team, walk, tank, door, walk_mult, door_mult,
       ws, wt, wr, ts, tt, tr, ds, dt, dr, tank_pct, tank_by, tanks, survivors_in, source)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (match_id, ordinal, half, rule) DO UPDATE SET
       surv_team = excluded.surv_team, walk = excluded.walk, tank = excluded.tank, door = excluded.door,
       walk_mult = excluded.walk_mult, door_mult = excluded.door_mult,
       ws = excluded.ws, wt = excluded.wt, wr = excluded.wr, ts = excluded.ts, tt = excluded.tt, tr = excluded.tr,
       ds = excluded.ds, dt = excluded.dt, dr = excluded.dr,
       tank_pct = excluded.tank_pct, tank_by = excluded.tank_by, tanks = excluded.tanks,
       survivors_in = excluded.survivors_in, source = excluded.source
     WHERE excluded.source = 'dump' OR match_round_alt.source = 'udp'`,
  ).run(matchId, ordinal, f.half, f.rule, f.surv, f.walk, f.tank, f.door, f.walkMult, f.doorMult,
    r.ws, r.wt, r.wr, r.ts, r.tt, r.tr, r.ds, r.dt, r.dr, f.tankPct, f.tankBy, f.tanks, f.survivorsIn, source);
}
