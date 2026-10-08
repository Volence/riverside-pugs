// tests/draftRoomFixture.ts
import * as D from '../src/events/drafts.js';
import * as DR from '../src/events/draftRoom.js';
import { ADMIN, NOW } from './eventFixture.js';
import { P, cutDraft, type DraftFixture } from './draftFixture.js';

/** Drafts plan D2b1: a live draft over cutDraft (21 signups in P order, 5
 *  teams, captains P[16..20] by SR, pool P[0..14], bench P[15], cut
 *  published). Captain SR is 1000 + 25*i, so the lowest-SR-first order is
 *  P[16], P[17], P[18], P[19], P[20]. The room clock starts at T0. */
export const T0 = new Date(NOW.getTime() + 3_600_000);
export const at = (s: number) => new Date(T0.getTime() + s * 1000);
export const ALL: DR.Present = () => true;
export const NONE: DR.Present = () => false;
export const CAPTAINS = P.slice(16, 21);
export const POOL = P.slice(0, 15);
export const BENCH = P[15]!;

export const must = <T>(r: { ok: true; value: T } | { ok: false; error: string }): T => {
  if (!r.ok) throw new Error(`expected ok, got ${r.error}`);
  return r.value;
};
export const err = (r: { ok: boolean; error?: string }) => (r.ok ? null : r.error);

/** cutDraft with Let captains pick chosen at T0. */
export function liveDraft(): DraftFixture {
  const f = cutDraft();
  must(D.chooseTeamMode(f.db, { eventId: f.eventId, mode: 'live', actor: ADMIN, now: T0 }));
  return f;
}

/** liveDraft, then the room started at T0. */
export function startedDraft(present: DR.Present = ALL): DraftFixture {
  const f = liveDraft();
  must(DR.startRoom(f.db, { eventId: f.eventId, actor: ADMIN, now: T0, present }));
  return f;
}

/** n picks, each by whoever picks next, of the first free pool player in
 *  signup order, one second apart starting at at(from). */
export function drive(f: DraftFixture, n: number, from = 1, present: DR.Present = ALL): void {
  for (let k = 0; k < n; k++) {
    const st = DR.roomState(f.db, f.eventId)!;
    must(DR.makePick(f.db, { eventId: f.eventId, steamid: st.picker!, player: st.available[0]!.steamid, pickNo: st.next!.pickNo, now: at(from + k), present }));
  }
}
