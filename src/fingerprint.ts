import { decodeIntervals, MAX_HOLDS } from './inputStats.js';

/**
 * Press fingerprints: how long a player holds infected buttons down.
 *
 * Design: docs/superpowers/specs/2026-10-17-evader-fingerprints-design.md
 *
 * dethisa's fifth account (nepmir, 2026-10-16) came on a new Discord and a
 * VPN exit nobody had used, so the Discord-move hold and the shared
 * connection check had nothing to see. What did match was how long they hold
 * the claw, pounce and smoker buttons, which no aimbot drives: their median
 * holds sat where every earlier dethisa account's did.
 *
 * A fingerprint is one histogram per press class of holds 2 to 20 ticks long.
 * 1-tick presses are a scroll wheel or a script, and over 20 is a held button
 * (30 is the plugin's "30 or more"), so neither says anything about a hand.
 *
 * Pure: no database, so the live check, the history replay and the web can
 * all use it. It says "could be them", never "is them": across first matches
 * of 183 honest players, the dethisa pool landed in the top 5 for 3%.
 */

export const HOLD_MIN = 2;
export const HOLD_MAX = 20;
export const BINS = HOLD_MAX - HOLD_MIN + 1;
export const BASE_KINDS = ['fire', 'pounce'] as const;
export const BASE_WEAPONS = ['weapon_hunter_claw', 'weapon_smoker_claw', 'weapon_boomer_claw'] as const;
/** Both spellings, for SQL. The plugin sends weapon_*, but the parser accepts
 *  a bare name too (an early parser test feeds `hunter_claw`). */
export const BASE_WEAPON_NAMES: readonly string[] = BASE_WEAPONS.flatMap((w) => [w, w.slice('weapon_'.length)]);

export const MIN_CANDIDATE_CLASS = 15;
export const MIN_REFERENCE_CLASS = 30;
export const MIN_SHARED_CLASSES = 2;
/** Enough data to check anyone at all. nepmir had about 220 after one match. */
export const MIN_CANDIDATE_HOLDS = 150;
export const MIN_MEMBER_MATCH_HOLDS = 100;
/** For scale: nepmir to dethisa was 0.203, honest first matches had a p5 of 0.250. */
export const FALLBACK_THRESHOLD = 0.25;
export const THRESHOLD_PERCENTILE = 0.9;
export const MIN_THRESHOLD_SAMPLES = 3;
export const TOP_RANK = 5;
export const MEMBERS_WINDOW = 10;

/** Class key ("fire:weapon_hunter_claw") to BINS counts; bin i is a hold of
 *  i + HOLD_MIN ticks. Counts, not shares, so pooling is addition. */
export type Fingerprint = Record<string, number[]>;

export interface BurstHoldRow { kind: string; weapon: string; holds: string | null }

export function classOf(kind: string, weapon: string): string | null {
  const w = weapon.startsWith('weapon_') ? weapon : `weapon_${weapon}`;
  if (!(BASE_KINDS as readonly string[]).includes(kind)) return null;
  if (!(BASE_WEAPONS as readonly string[]).includes(w)) return null;
  return `${kind}:${w}`;
}

/** "hunter claw", "smoker air attack": for a moderator, not a programmer. */
export function classLabel(cls: string): string {
  const [kind, weapon = ''] = cls.split(':');
  const who = weapon.replace(/^weapon_/, '').replace(/_claw$/, '');
  return kind === 'fire' ? `${who} claw` : `${who} air attack`;
}

export function addHolds(fp: Fingerprint, cls: string, holds: readonly number[]): void {
  for (const h of holds) {
    if (h < HOLD_MIN || h > HOLD_MAX) continue;
    (fp[cls] ??= new Array<number>(BINS).fill(0))[h - HOLD_MIN] += 1;
  }
}

/** One stored burst. A corrupt holds string decodes to null and is skipped
 *  rather than guessed at, as everywhere else holds are read. */
export function addBurst(fp: Fingerprint, row: BurstHoldRow): void {
  if (!row.holds) return;
  const cls = classOf(row.kind, row.weapon);
  if (!cls) return;
  const holds = decodeIntervals(row.holds, MAX_HOLDS);
  if (holds) addHolds(fp, cls, holds);
}

export function fingerprintOf(rows: Iterable<BurstHoldRow>): Fingerprint {
  const fp: Fingerprint = {};
  for (const r of rows) addBurst(fp, r);
  return fp;
}

export function mergeInto(target: Fingerprint, src: Fingerprint): Fingerprint {
  for (const [cls, counts] of Object.entries(src)) {
    const t = (target[cls] ??= new Array<number>(BINS).fill(0));
    counts.forEach((n, i) => { t[i] += n; });
  }
  return target;
}

export function pooled(fps: Iterable<Fingerprint>): Fingerprint {
  const out: Fingerprint = {};
  for (const f of fps) mergeInto(out, f);
  return out;
}

/** `total` with `part` taken out, for leave-one-out. */
export function without(total: Fingerprint, part: Fingerprint): Fingerprint {
  const out: Fingerprint = {};
  for (const [cls, counts] of Object.entries(total)) {
    const p = part[cls];
    out[cls] = counts.map((n, i) => Math.max(0, n - (p?.[i] ?? 0)));
  }
  return out;
}

export const countOf = (counts?: readonly number[]): number => (counts ? counts.reduce((a, b) => a + b, 0) : 0);

export function holdTotal(fp: Fingerprint): number {
  return Object.values(fp).reduce((s, c) => s + countOf(c), 0);
}

/** Total-variation distance of the two normalised histograms: half the sum
 *  of absolute differences, 0 for the same shape, 1 for no overlap. Callers
 *  guarantee both are non-empty. */
export function tvDistance(a: readonly number[], b: readonly number[]): number {
  const na = countOf(a);
  const nb = countOf(b);
  let sum = 0;
  for (let i = 0; i < BINS; i++) sum += Math.abs((a[i] ?? 0) / na - (b[i] ?? 0) / nb);
  return sum / 2;
}

/** Mean total-variation distance over the classes both sides have enough of,
 *  or null when fewer than MIN_SHARED_CLASSES qualify. */
export function distance(candidate: Fingerprint, reference: Fingerprint): number | null {
  const ds: number[] = [];
  for (const [cls, c] of Object.entries(candidate)) {
    const r = reference[cls];
    if (countOf(c) >= MIN_CANDIDATE_CLASS && r && countOf(r) >= MIN_REFERENCE_CLASS) ds.push(tvDistance(c, r));
  }
  return ds.length >= MIN_SHARED_CLASSES ? ds.reduce((a, b) => a + b, 0) / ds.length : null;
}

/** Median hold in ticks (the lower one on an even count), or null. */
export function medianHold(counts?: readonly number[]): number | null {
  const total = countOf(counts);
  if (!counts || total === 0) return null;
  const target = Math.floor((total - 1) / 2);
  let cum = 0;
  for (let i = 0; i < counts.length; i++) {
    cum += counts[i];
    if (cum > target) return i + HOLD_MIN;
  }
  return null;
}

/** Nearest-rank percentile of a non-empty list. */
export function percentile(values: readonly number[], p: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(p * sorted.length) - 1)];
}

/**
 * How close is close enough for this person: the 90th percentile of how far
 * each of their own single matches (>= 100 holds) sits from the rest of them.
 * A person who plays consistently gets a tight threshold, one who does not
 * gets a loose one. Under three usable matches there is nothing to take a
 * percentile of, so the global fallback applies.
 */
export function personThreshold(memberMatches: readonly Fingerprint[]): number {
  const usable = memberMatches.filter((m) => holdTotal(m) >= MIN_MEMBER_MATCH_HOLDS);
  if (usable.length < MIN_THRESHOLD_SAMPLES) return FALLBACK_THRESHOLD;
  const all = pooled(usable);
  const ds = usable.map((m) => distance(m, without(all, m))).filter((d): d is number => d !== null);
  return ds.length >= MIN_THRESHOLD_SAMPLES ? percentile(ds, THRESHOLD_PERCENTILE) : FALLBACK_THRESHOLD;
}

/** One comparable fingerprint in the field: `steam:<id>` (a player's whole
 *  history) or `person:<id>` (a person's pooled accounts). */
export interface FieldEntry { subject: string; fp: Fingerprint }

export interface PersonModel {
  id: number;
  label: string;
  /** Steam members. */
  members: readonly string[];
  pooled: Fingerprint;
  threshold: number;
}

export interface PersonHit {
  personId: number;
  distance: number;
  threshold: number;
  /** 1 + how many field entries are strictly closer, with this person's own
   *  accounts and the candidate taken out so the person counts once. */
  rank: number;
  /** The closest member account, for alt_holds.other_steamid. */
  nearestMember: string | null;
  /** Member accounts among the candidate's MEMBERS_WINDOW nearest
   *  individual entries (second sign 4). */
  membersInTop10: number;
  /** Top 5 and within the person's threshold. */
  matched: boolean;
}

/** Score `candidate` against every person. Empty when the candidate has too
 *  little data to be checked at all. A person the candidate cannot be
 *  compared with (no shared classes) is left out. */
export function matchPersons(
  candidate: Fingerprint, candidateId: string, field: readonly FieldEntry[], persons: readonly PersonModel[],
): PersonHit[] {
  if (holdTotal(candidate) < MIN_CANDIDATE_HOLDS) return [];
  const self = `steam:${candidateId}`;
  const scored: { subject: string; d: number }[] = [];
  for (const e of field) {
    if (e.subject === self) continue;
    const d = distance(candidate, e.fp);
    if (d !== null) scored.push({ subject: e.subject, d });
  }
  const out: PersonHit[] = [];
  for (const p of persons) {
    const dP = distance(candidate, p.pooled);
    if (dP === null) continue;
    const own = new Set(p.members.map((m) => `steam:${m}`));
    const subject = `person:${p.id}`;
    const rank = 1 + scored.filter((e) => e.subject !== subject && !own.has(e.subject) && e.d < dP).length;
    const nearest = scored.filter((e) => e.subject !== subject).sort((a, b) => a.d - b.d).slice(0, MEMBERS_WINDOW);
    let nearestMember: string | null = null;
    let best = Infinity;
    for (const e of scored) {
      if (own.has(e.subject) && e.d < best) { best = e.d; nearestMember = e.subject.slice('steam:'.length); }
    }
    out.push({
      personId: p.id, distance: dP, threshold: p.threshold, rank, nearestMember,
      membersInTop10: nearest.filter((e) => own.has(e.subject)).length,
      matched: rank <= TOP_RANK && dP <= p.threshold,
    });
  }
  return out;
}

/** What else, seen on the candidate, lifts a fingerprint alert to a hold.
 *  Here rather than in fingerprintSigns.ts so the web can import the words. */
export type SecondSign = 'vpn' | 'fresh_identity' | 'cheat_flag' | 'two_members' | 'shared_connection';
export const SIGN_ORDER: readonly SecondSign[] = ['vpn', 'fresh_identity', 'cheat_flag', 'two_members', 'shared_connection'];
export const SIGN_TEXT: Record<SecondSign, string> = {
  vpn: 'a VPN or hosting connection',
  fresh_identity: 'a fresh identity',
  cheat_flag: 'a cheat flag',
  two_members: 'two of their accounts among the 10 nearest',
  shared_connection: 'a connection shared with one of their accounts',
};
