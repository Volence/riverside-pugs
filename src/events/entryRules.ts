import { fail, ok, type Checked, type Checkin, type Eligibility, type RosterLock, type RosterRules } from './validate.js';

/**
 * Every entry rule that needs no database (tournaments plan T1b): a roster's
 * shape, who is eligible and how to say why not, the waitlist, the seed
 * order, the check-in window and the roster lock. src/events/entries.ts reads
 * the facts and calls these inside its transactions.
 */

export type Role = 'starter' | 'sub' | 'coach';
export const STARTERS = 4;
export interface Roster { starters: string[]; subs: string[]; coach: string | null }

export const DROP_REASONS = ['withdrawn', 'no_checkin', 'over_cap', 'incomplete', 'team_disbanded'] as const;
export type DropReason = (typeof DROP_REASONS)[number];
/** Why an entry is out, as the end of "X is out of the event: ...". */
export const DROP_TEXT: Record<DropReason, string> = {
  withdrawn: 'it was withdrawn',
  no_checkin: 'it did not check in in time',
  over_cap: 'the event was full when the entry list closed',
  incomplete: 'it did not have 4 starters when the entry list closed',
  team_disbanded: 'the team was disbanded',
};

export type Problem = 'closed' | 'standing' | 'pugs' | 'discord' | 'sr_low' | 'sr_high';
export interface PlayerFacts { open: boolean; good: boolean; pugs: number; discord: boolean; sr: number }

/** What keeps a player off a roster in this role. A coach does not play, so
 *  the PUG count and the SR range do not apply to one. */
export function problemsOf(e: Eligibility, f: PlayerFacts, role: Role): Problem[] {
  const out: Problem[] = [];
  if (!f.good) out.push('standing');
  if (!f.open) out.push('closed');
  if (role !== 'coach' && f.pugs < e.minPugs) out.push('pugs');
  if (e.requireDiscord && !f.discord) out.push('discord');
  if (role !== 'coach' && e.srFloor !== null && f.sr < e.srFloor) out.push('sr_low');
  if (role !== 'coach' && e.srCeiling !== null && f.sr > e.srCeiling) out.push('sr_high');
  return out;
}

export function problemText(p: Problem, e: Eligibility, f: PlayerFacts): string {
  switch (p) {
    case 'standing': return 'Account is not in good standing';
    case 'closed': return 'Cannot use competitive features yet';
    case 'pugs': return `${f.pugs} of ${e.minPugs} completed PUGs`;
    case 'discord': return 'Discord is not linked';
    case 'sr_low': return `SR ${f.sr} is below the floor of ${e.srFloor}`;
    case 'sr_high': return `SR ${f.sr} is above the ceiling of ${e.srCeiling}`;
  }
}

const STEAMID = /^\d{17}$/;
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const ids = (v: unknown): string[] | null => (Array.isArray(v) && v.every((s) => typeof s === 'string' && STEAMID.test(s)) ? v as string[] : null);

export function parseEntryRoster(raw: unknown, rules: RosterRules): Checked<Roster> {
  if (!isObj(raw)) return fail('bad_entry_roster');
  const starters = ids(raw.starters);
  const subs = raw.subs === undefined ? [] : ids(raw.subs);
  const coach = raw.coach === undefined || raw.coach === null ? null : typeof raw.coach === 'string' && STEAMID.test(raw.coach) ? raw.coach : undefined;
  if (!starters || !subs || coach === undefined) return fail('bad_entry_roster');
  if (starters.length !== STARTERS || subs.length > rules.maxSubs) return fail('bad_entry_roster');
  const all = [...starters, ...subs, ...(coach ? [coach] : [])];
  if (new Set(all).size !== all.length) return fail('bad_entry_roster');
  return ok({ starters, subs, coach });
}

export function rosterList(r: Roster): { steamid: string; role: Role }[] {
  return [
    ...r.starters.map((steamid) => ({ steamid, role: 'starter' as const })),
    ...r.subs.map((steamid) => ({ steamid, role: 'sub' as const })),
    ...(r.coach ? [{ steamid: r.coach, role: 'coach' as const }] : []),
  ];
}

export interface Placement { placed: number[]; waitlist: number[] }

const byRegistration = (a: { id: number; created_at: string }, b: { id: number; created_at: string }) =>
  (a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : a.id - b.id);

/** Ruling 3: computed, never stored. Active entries in registration order;
 *  the first `cap` are in, the rest wait in that order. */
export function placeEntries(rows: { id: number; created_at: string; status: string }[], cap: number | null): Placement {
  const active = rows.filter((r) => r.status !== 'dropped' && r.status !== 'disqualified').sort(byRegistration).map((r) => r.id);
  return cap === null ? { placed: active, waitlist: [] } : { placed: active.slice(0, cap), waitlist: active.slice(cap) };
}

/** Spec section 2: highest average SR first, ties by registration order. */
export function seedOrder(rows: { id: number; sr: number; created_at: string }[]): number[] {
  return [...rows].sort((a, b) => b.sr - a.sr || byRegistration(a, b)).map((r) => r.id);
}

export function averageSr(srs: number[]): number {
  return srs.length === 0 ? 0 : Math.round(srs.reduce((a, b) => a + b, 0) / srs.length);
}

export function checkinTimes(startsAt: string, c: Checkin): { opensAt: string; closesAt: string } {
  const start = Date.parse(startsAt);
  return {
    opensAt: new Date(start - c.opensMinutes * 60_000).toISOString(),
    closesAt: new Date(start - c.closesMinutes * 60_000).toISOString(),
  };
}

/** Ruling 6: a lock `at` a time holds from that time; `after_round` needs
 *  played rounds, which arrive with rollout plan 3, so it never holds yet. */
export function rosterLocked(lock: RosterLock, now: string): boolean {
  return lock.kind === 'at' && now >= lock.at;
}
