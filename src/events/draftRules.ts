import { findSlurs } from '../slurs.js';
import { DEFAULT_IGNORABLE, hasUnsafeChars } from '../profileFields.js';
import type { CaptainPref } from './drafts.js';

/**
 * The draft rules that need no database (drafts plan D1): the signup note,
 * the team count, the default cut, publish validation and captain offer
 * order. src/events/drafts.ts calls these inside its transactions.
 */

/** Ruling 10: a note is optional free text of 1 to 80 characters. */
export const NOTE_MAX = 80;

/** A signup note, trimmed: null when absent or blank, 'bad' when longer than
 *  NOTE_MAX, not plain one-line text, or caught by the slur filter team names
 *  go through. */
export function cleanNote(s: unknown): string | null | 'bad' {
  if (s === undefined || s === null) return null;
  if (typeof s !== 'string') return 'bad';
  const note = s.normalize('NFC').trim();
  if (note === '') return null;
  if (note.length > NOTE_MAX || hasUnsafeChars(note) || DEFAULT_IGNORABLE.test(note)) return 'bad';
  if (findSlurs(note).length > 0) return 'bad';
  return note;
}

export type CutRole = 'captain' | 'pool' | 'bench';

/** Ruling 5: one team per four active signups, rounded down. */
export function maxTeams(activeCount: number): number {
  return Math.floor(Math.max(0, activeCount) / 4);
}

/** Roles for every active signup (Ruling 5): captains as given, then pool =
 *  the first teams*3 non-captains in signup order, the rest bench. A captain
 *  not among the signups is ignored. */
export function defaultRoles(signups: { steamid: string }[], captains: ReadonlySet<string>, teams: number): Map<string, CutRole> {
  const out = new Map<string, CutRole>();
  let pool = Math.max(0, teams) * 3;
  for (const s of signups) {
    if (captains.has(s.steamid)) out.set(s.steamid, 'captain');
    else if (pool > 0) { out.set(s.steamid, 'pool'); pool--; }
    else out.set(s.steamid, 'bench');
  }
  return out;
}

export type CutProblem = 'too_few_teams' | 'too_many_teams' | 'too_few_captains' | 'too_many_captains' | 'pool_size' | 'unassigned' | 'ineligible';

/** Why a working cut cannot be published, in this order of checks; [] =
 *  publishable. Publish refuses unless the pool is exactly teams x 3
 *  (Review Focus 3). */
export function cutProblems(o: { teams: number | null; active: number; captains: number; pool: number; unassigned: number; ineligible: number }): CutProblem[] {
  const out: CutProblem[] = [];
  const teams = o.teams ?? 0;
  if (o.teams === null || teams < 2) out.push('too_few_teams');
  if (teams > maxTeams(o.active)) out.push('too_many_teams');
  if (o.captains < teams) out.push('too_few_captains');
  if (o.captains > teams) out.push('too_many_captains');
  if (o.pool !== teams * 3) out.push('pool_size');
  if (o.unassigned > 0) out.push('unassigned');
  if (o.ineligible > 0) out.push('ineligible');
  return out;
}

/** Ruling 6: who is offered captaincy next. The highest-SR signup who said
 *  willing, is not a captain, is eligible and was never offered in this
 *  event (a decline, an expiry or a stop all count); ties go to the earlier
 *  signup, which is input order. null when nobody is left. */
export function nextOfferee(
  signups: { steamid: string; captainPref: CaptainPref; sr: number; role: string | null; eligible: boolean }[],
  offered: ReadonlySet<string>,
): string | null {
  let best: { steamid: string; sr: number } | null = null;
  for (const s of signups) {
    if (s.captainPref !== 'willing' || s.role === 'captain' || !s.eligible || offered.has(s.steamid)) continue;
    if (!best || s.sr > best.sr) best = s;
  }
  return best?.steamid ?? null;
}

/**
 * The live draft room's rules (drafts plan D2b1), pure like the rest of this
 * file: the two settings kept in events.draft_json next to the D1 times, the
 * round 1 order, the snake, the auto-pick choice and a saved pick list.
 */

export type FirstPick = 'lowest_sr' | 'highest_sr' | 'random';
export const FIRST_PICKS: readonly FirstPick[] = ['lowest_sr', 'highest_sr', 'random'];
export const PICK_SECONDS_DEFAULT = 75;
export const PICK_SECONDS_MIN = 30;
export const PICK_SECONDS_MAX = 300;
/** Captain + 3 picks per team (spec section 4). */
export const ROUNDS = 3;
/** A list longer than any pool is not a list this site sends. */
export const LIST_MAX = 200;

export interface RoomSettings { firstPick: FirstPick; pickSeconds: number }

const goodSeconds = (s: unknown): s is number =>
  typeof s === 'number' && Number.isInteger(s) && s >= PICK_SECONDS_MIN && s <= PICK_SECONDS_MAX;

/** Ruling 5: the settings as stored, each falling back to its default. */
export function roomSettingsOf(draftJson: string | null): RoomSettings {
  const d = draftJson ? (JSON.parse(draftJson) as Record<string, unknown>) : {};
  return {
    firstPick: FIRST_PICKS.includes(d.draftFirstPick as FirstPick) ? (d.draftFirstPick as FirstPick) : 'lowest_sr',
    pickSeconds: goodSeconds(d.pickSeconds) ? d.pickSeconds : PICK_SECONDS_DEFAULT,
  };
}

/** A desk body, or null when either field is missing or out of range. */
export function parseRoomSettings(raw: unknown): RoomSettings | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Record<string, unknown>;
  if (!FIRST_PICKS.includes(r.firstPick as FirstPick) || !goodSeconds(r.pickSeconds)) return null;
  return { firstPick: r.firstPick as FirstPick, pickSeconds: r.pickSeconds };
}

// ---------- bench stand-ins (plan D3a) ----------

/** Ruling 3: the event's stand-in SR margin, draft_json.standinSrMargin. */
export const STANDIN_MARGIN_DEFAULT = 100;
export const STANDIN_MARGIN_MAX = 2000;
/** Ruling 5: each stand-in offer is open this long. */
export const STANDIN_OFFER_MINUTES = 10;
/** Discord custom id prefix of the stand-in buttons (src/discord/standinButtons.ts). */
export const STANDIN_BUTTON_PREFIX = 'ds:';

const goodMargin = (m: unknown): m is number => typeof m === 'number' && Number.isInteger(m) && m >= 0 && m <= STANDIN_MARGIN_MAX;

/** The margin as stored, or the default. */
export function standinMarginOf(draftJson: string | null): number {
  const d = draftJson ? (JSON.parse(draftJson) as Record<string, unknown>) : {};
  return goodMargin(d.standinSrMargin) ? d.standinSrMargin : STANDIN_MARGIN_DEFAULT;
}

/** A desk body's margin, or null. */
export function parseStandinMargin(raw: unknown): number | null {
  return goodMargin(raw) ? raw : null;
}

/** A bench player as the stand-in offers see them. busy: holds a place on a
 *  team of this event, or has an open offer for another request. */
export interface BenchCandidate { steamid: string; sr: number; order: number; eligible: boolean; busy: boolean }

/** Ruling 3: who is asked, in order. Eligible, not busy, not offered this
 *  request before, SR at most `margin` above the missing player's (any
 *  amount below; null is no limit), closest SR first, ties by signup order. */
export function standinOrder(bench: readonly BenchCandidate[], outSr: number, margin: number | null, offered: ReadonlySet<string>): string[] {
  return bench
    .filter((c) => c.eligible && !c.busy && !offered.has(c.steamid) && (margin === null || c.sr <= outSr + margin))
    .sort((a, b) => Math.abs(a.sr - outSr) - Math.abs(b.sr - outSr) || a.order - b.order)
    .map((c) => c.steamid);
}

/** A player as the room ranks them: current-season SR, then signup order. */
export interface RankedPlayer { steamid: string; sr: number; order: number }

/** Round 1 order (Ruling 5). Random shuffles the captains in signup order
 *  with rand(n) in [0, n), Fisher-Yates. */
export function firstRoundOrder(captains: RankedPlayer[], mode: FirstPick, rand: (n: number) => number): string[] {
  if (mode === 'random') {
    const out = [...captains].sort((a, b) => a.order - b.order).map((c) => c.steamid);
    for (let i = out.length - 1; i > 0; i--) {
      const j = rand(i + 1);
      [out[i], out[j]] = [out[j]!, out[i]!];
    }
    return out;
  }
  const dir = mode === 'lowest_sr' ? 1 : -1;
  return [...captains].sort((a, b) => dir * (a.sr - b.sr) || a.order - b.order).map((c) => c.steamid);
}

export interface Slot { pickNo: number; round: number; captain: string }

/** Every pick of the draft, in order: round r forward when r is odd, back
 *  when even; pickNo counts from 1 across the whole draft. */
export function snakeSlots(order: string[], rounds = ROUNDS): Slot[] {
  const out: Slot[] = [];
  for (let r = 1; r <= rounds; r++) {
    const seq = r % 2 === 1 ? order : [...order].reverse();
    for (const captain of seq) out.push({ pickNo: out.length + 1, round: r, captain });
  }
  return out;
}

/** Ruling 7: the first player on the list who is still free, else the
 *  highest SR free player, ties by signup order. available is never empty
 *  (the room only asks with a pick open). */
export function autoPickChoice(available: RankedPlayer[], list: readonly string[]): string {
  const free = new Set(available.map((p) => p.steamid));
  const fromList = list.find((s) => free.has(s));
  if (fromList) return fromList;
  return [...available].sort((a, b) => b.sr - a.sr || a.order - b.order)[0]!.steamid;
}

/** A pick list as saved (Ruling 2): pool players only, each once, in the
 *  given order. null when it is not a list of strings or is too long. */
export function cleanPickList(raw: unknown, pool: ReadonlySet<string>): string[] | null {
  if (!Array.isArray(raw) || raw.length > LIST_MAX || raw.some((s) => typeof s !== 'string')) return null;
  const seen = new Set<string>();
  const out: string[] = [];
  for (const s of raw as string[]) {
    if (!pool.has(s) || seen.has(s)) continue;
    seen.add(s);
    out.push(s);
  }
  return out;
}

// ---------- Keep this team (plan D3b) ----------

/** Ruling 2: offers are made within this many days of the event finishing. */
export const KEEP_OFFER_DAYS = 7;
/** Ruling 2: voting runs this long from the captain's Keep. */
export const KEEP_VOTE_HOURS = 48;
/** Ruling 3 (spec): 3 of the 4. */
export const KEEP_MAJORITY = 3;
/** Discord custom id prefix of the keep buttons (src/discord/keepButtons.ts). */
export const KEEP_BUTTON_PREFIX = 'dk:';
