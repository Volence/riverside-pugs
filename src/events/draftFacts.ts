import type { DB } from '../db.js';
import { abandonsSince } from '../abandon.js';
import { noShowsSince } from '../penalties.js';
import { getPlayer } from '../players.js';
import * as E from './events.js';
import * as D from './drafts.js';
import { playerFacts } from './entries.js';
import * as R from './entryRules.js';

/**
 * What the Events desk shows beside each draft signup (drafts plan D1): SR,
 * the private preference and note, the working role, PUG reliability over 30
 * days (Ruling 8) and eligibility problems (Ruling 7). Read only, staff only:
 * nothing here goes into a public or player response.
 */

const RELIABILITY_DAYS = 30;

export interface SignupFacts {
  steamid: string; name: string; sr: number; captainPref: D.CaptainPref; note: string | null; signedUpAt: string;
  role: D.SignupRow['role']; manual: boolean; abandons30d: number; noShows30d: number;
  /** Eligibility problems as the desk's entries list words them. */
  problems: string[];
}

/** Every active signup, in signup order. */
export function signupFacts(db: DB, eventId: number, now: Date): SignupFacts[] {
  const ev = E.getEvent(db, eventId);
  if (!ev) return [];
  const elig = E.fieldsOf(ev).eligibility;
  const since = new Date(now.getTime() - RELIABILITY_DAYS * 86_400_000);
  return D.activeSignups(db, ev.id).map((s) => {
    const facts = playerFacts(db, s.steamid, now);
    return {
      steamid: s.steamid, name: getPlayer(db, s.steamid)?.name ?? s.steamid, sr: facts.sr, captainPref: s.captain_pref, note: s.note,
      signedUpAt: s.created_at, role: s.role, manual: s.role_manual === 1,
      abandons30d: abandonsSince(db, s.steamid, since), noShows30d: noShowsSince(db, s.steamid, since),
      problems: R.problemsOf(elig, facts, 'starter').map((k) => R.problemText(k, elig, facts)),
    };
  });
}

const ROLE_ORDER: Record<string, number> = { captain: 0, pool: 1, bench: 2 };

/** The desk's order: by role (captains, pool, bench, then any without one);
 *  within a role, captains and volunteers ('want') first by SR descending,
 *  then everyone else in signup order. Input is in signup order. */
export function deskOrder(facts: SignupFacts[]): SignupFacts[] {
  const ranked = (f: SignupFacts) => f.role === 'captain' || f.captainPref === 'want';
  return facts.map((f, i) => ({ f, i })).sort((a, b) => {
    const r = (ROLE_ORDER[a.f.role ?? ''] ?? 3) - (ROLE_ORDER[b.f.role ?? ''] ?? 3);
    if (r !== 0) return r;
    const ra = ranked(a.f), rb = ranked(b.f);
    if (ra !== rb) return ra ? -1 : 1;
    if (ra && a.f.sr !== b.f.sr) return b.f.sr - a.f.sr;
    return a.i - b.i;
  }).map((x) => x.f);
}
