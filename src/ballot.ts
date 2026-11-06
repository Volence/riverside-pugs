import type { DB } from './db.js';
import { campaignRegistry, poolableCampaigns, type CampaignCategory } from './campaignRegistry.js';
import { completedPug } from './matchKinds.js';
import { getSetting, getStickyCampaigns } from './settings.js';

/**
 * The four-slot campaign ballot (owner, 2026-11-02), behind `ballot_mode`.
 *
 * With 'all' (the default) the vote offers every campaign in map_pool, as it
 * always has, and nothing here runs. With 'slots' a popped lobby is offered
 * one campaign per category (L4D1, L4D2, custom, mirror), each drawn from the
 * pool, then the sticky campaigns. The vote itself is unchanged: plurality,
 * random tie-break, a random option when nobody votes.
 *
 * The draw is about the players in the lobby, not the server (owner,
 * 2026-11-04):
 *
 * - A campaign any of them played in their last RECENT_WINDOW matches is
 *   left out, from its slot and from the stickies (owner, 2026-11-06: one
 *   match in between let Dead Air back on four ballots in a row). A slot
 *   that empties that way is scored over all of its campaigns instead.
 * - The rest are scored by points (owner, 2026-11-06). Each player ranks
 *   them by how long since they played each one: the one played longest ago
 *   gets 4 points, the next 3, the next 2, any others 0 (in L4D1, with four
 *   campaigns, that is 4/3/2/0). Never played counts as longest ago, and
 *   campaigns tied on a player's ranking share those places' points. A
 *   campaign's score is the average over the lobby. L4D1 offers its top
 *   score; the other slots draw from their top three, weighted by score.
 * - A campaign a player saw on a ballot that gave it no votes steps back for
 *   that player: half its points, wearing off by half at every later ballot
 *   that player is in, and gone once they play it. One vote is enough to
 *   count as wanted.
 * - A campaign that lost a vote with two or more votes gets a bump on top,
 *   for every lobby: it halves at every later tally it does not win and goes
 *   once it wins.
 */

export const BALLOT_SLOTS: readonly CampaignCategory[] = ['l4d1', 'l4d2', 'custom', 'mirror'];
/** A player's points for the campaigns they played longest ago, longest
 *  first; every later place gets 0. */
export const RANK_POINTS: readonly number[] = [4, 3, 2];
/** How many of a slot's top scores its draw is made from. */
export const SLOT_TOP: Readonly<Record<CampaignCategory, number>> = { l4d1: 1, l4d2: 3, custom: 3, mirror: 3 };
/** What a close loss (two or more votes) adds to a campaign's score. */
export const LOST_VOTE_BUMP = 1;
/** The share of a player's points a no-vote showing takes away. */
export const IGNORED_STEP = 0.5;
/** A player's tallied ballots looked back over for no-vote showings. By the
 *  last one a step has worn off to under 1%. */
export const IGNORED_LOOKBACK = 8;
/** A decayed bump under this is dropped rather than halved forever. */
const BUMP_FLOOR = 0.01;
export const MAX_STICKIES = 3;
/** A campaign in any lobby player's last this many matches is left out. */
export const RECENT_WINDOW = 3;
/** A player's completed PUGs looked back over; a campaign further back
 *  ranks as never played. */
const PLAYED_LOOKBACK = 40;
/** Scores closer than this are a tie (they are averages of fractions). */
const SCORE_EPSILON = 1e-9;

export type BallotMode = 'all' | 'slots';

export function ballotMode(db: DB): BallotMode {
  return getSetting(db, 'ballot_mode') === 'slots' ? 'slots' : 'all';
}

export interface BallotOption {
  slug: string;
  slot: CampaignCategory | 'sticky';
  /** What the draw used: base + bump. Null for a sticky (not drawn). On
   *  ballots drawn before 2026-11-07 a 1-3 weight, since then a 0-4 score. */
  weight: number | null;
  /** The lobby average of each player's points. Null for a sticky. */
  base: number | null;
  bump: number;
  /** Lobby players with it in their last RECENT_WINDOW matches: 0 unless
   *  its slot had to fall back. Absent on ballots drawn before 2026-11-06. */
  recentBy?: number;
  /** Matches since the lobby player who played it most recently last did;
   *  null = none of them in their lookback. Absent before 2026-11-06. */
  freshest?: number | null;
  /** Ballots drawn 2026-11-04 to 11-06 only: lobby players whose last
   *  match was on it. */
  lastPlayedBy?: number;
  /** Lobby players it is stepped back for after a no-vote showing.
   *  Absent on ballots drawn before 2026-11-04. */
  ignoredBy?: number;
  /** Ballots drawn before 2026-11-04 only: server-wide completed queue PUGs
   *  since it was last played; null = never. */
  since?: number | null;
}

export interface BallotCandidate { slug: string; category: CampaignCategory }

/** One lobby player's history, newest first, by match id. */
export interface PlayerHistory {
  /** Completed PUGs they played. */
  played: { matchId: number; campaign: string }[];
  /** Tallied ballots they were in. */
  ballots: { matchId: number; options: string[]; votes: Readonly<Record<string, number>> }[];
}

export interface DrawInput {
  /** The pool, already narrowed to campaigns the site can run. */
  candidates: BallotCandidate[];
  /** One per lobby player. */
  histories: PlayerHistory[];
  bumps: ReadonlyMap<string, number>;
  stickies: string[];
  rng: () => number;
}

/** Each player's points for `slugs`: ranked by matches since they last
 *  played each one (never played first), RANK_POINTS down that ranking,
 *  ties sharing their places' points. Pure. */
export function rankPoints(h: PlayerHistory, slugs: string[]): Map<string, number> {
  const since = (slug: string) => {
    const at = h.played.findIndex((p) => p.campaign === slug);
    return at < 0 ? Infinity : at;
  };
  const sorted = slugs.map((slug) => ({ slug, n: since(slug) })).sort((x, y) => y.n - x.n);
  const out = new Map<string, number>();
  for (let i = 0; i < sorted.length;) {
    let j = i;
    while (j < sorted.length && sorted[j].n === sorted[i].n) j++;
    let sum = 0;
    for (let k = i; k < j; k++) sum += RANK_POINTS[k] ?? 0;
    for (let k = i; k < j; k++) out.set(sorted[k].slug, sum / (j - i));
    i = j;
  }
  return out;
}

/** The share of a player's points for a campaign left after no-vote
 *  showings: each showing since they last played it takes
 *  IGNORED_STEP / 2^k, k being their tallied ballots since. Pure. */
export function ignoredKeep(h: PlayerHistory, slug: string): number {
  const at = h.played.findIndex((p) => p.campaign === slug);
  const lastPlayed = at < 0 ? 0 : h.played[at].matchId;
  let keep = 1;
  h.ballots.slice(0, IGNORED_LOOKBACK).forEach((b, k) => {
    if (b.matchId > lastPlayed && b.options.includes(slug) && !b.votes[slug]) {
      keep *= 1 - IGNORED_STEP / 2 ** k;
    }
  });
  return keep;
}

/** One weighted pick. `rng` returns [0, 1) like Math.random. */
function weightedPick<T extends { weight: number }>(items: T[], rng: () => number): T {
  const total = items.reduce((a, it) => a + it.weight, 0);
  // All zero: an even pick.
  if (total <= 0) return items[Math.min(Math.floor(rng() * items.length), items.length - 1)];
  let r = rng() * total;
  for (const it of items) {
    r -= it.weight;
    if (r < 0) return it;
  }
  return items[items.length - 1];
}

/** Matches since the lobby player who played `slug` most recently last did;
 *  null when none of them has it in their history. */
function freshestPlay(histories: PlayerHistory[], slug: string): number | null {
  let min: number | null = null;
  for (const h of histories) {
    const at = h.played.findIndex((p) => p.campaign === slug);
    if (at >= 0 && (min === null || at < min)) min = at;
  }
  return min;
}

/** The ballot: one drawn option per non-empty slot in BALLOT_SLOTS order,
 *  then each sticky not already drawn and not recent for anyone. Pure, for
 *  tests. */
export function drawBallot(input: DrawInput): BallotOption[] {
  const recentBy = (slug: string) => input.histories
    .filter((h) => h.played.slice(0, RECENT_WINDOW).some((p) => p.campaign === slug)).length;
  const out: BallotOption[] = [];
  for (const slot of BALLOT_SLOTS) {
    const inSlot = input.candidates.filter((c) => c.category === slot);
    if (inSlot.length === 0) continue;
    const fresh = inSlot.filter((c) => recentBy(c.slug) === 0);
    // Every one recent for someone: score them all.
    const scored = (fresh.length > 0 ? fresh : inSlot).map((c) => c.slug);
    const perPlayer = input.histories.map((h) => ({ h, points: rankPoints(h, scored) }));
    const options = scored.map((slug) => {
      const each = perPlayer.map(({ h, points }) => {
        const keep = ignoredKeep(h, slug);
        return { points: points.get(slug)! * keep, ignored: keep < 1 };
      });
      const base = each.length === 0 ? RANK_POINTS[0] : each.reduce((a, e) => a + e.points, 0) / each.length;
      const bump = input.bumps.get(slug) ?? 0;
      return {
        slug, base, bump, weight: base + bump,
        recentBy: recentBy(slug), freshest: freshestPlay(input.histories, slug),
        ignoredBy: each.filter((e) => e.ignored).length,
      };
    });
    // The top SLOT_TOP scores, and anything tied with the last of them.
    const ranked = [...options].sort((x, y) => y.weight - x.weight);
    const cut = ranked[Math.min(SLOT_TOP[slot], ranked.length) - 1].weight;
    const pick = weightedPick(ranked.filter((o) => o.weight >= cut - SCORE_EPSILON), input.rng);
    out.push({ ...pick, slot });
  }
  for (const slug of input.stickies.slice(0, MAX_STICKIES)) {
    if (out.some((o) => o.slug === slug) || recentBy(slug) > 0) continue;
    out.push({
      slug, slot: 'sticky', weight: null, base: null, bump: input.bumps.get(slug) ?? 0,
      recentBy: 0, freshest: freshestPlay(input.histories, slug), ignoredBy: 0,
    });
  }
  return out;
}

/** The bumps after a tally: every standing bump halves (the winner's goes),
 *  then each loser with two or more votes gains LOST_VOTE_BUMP. Pure. */
export function nextBumps(
  bumps: ReadonlyMap<string, number>, votes: Readonly<Record<string, number>>, winner: string,
): Map<string, number> {
  const out = new Map<string, number>();
  for (const [slug, b] of bumps) {
    if (slug === winner) continue;
    const half = b / 2;
    if (half >= BUMP_FLOOR) out.set(slug, half);
  }
  for (const [slug, n] of Object.entries(votes)) {
    if (slug !== winner && n >= 2) out.set(slug, (out.get(slug) ?? 0) + LOST_VOTE_BUMP);
  }
  return out;
}

// ---------- database side ----------

export function loadBumps(db: DB): Map<string, number> {
  const rows = db.prepare('SELECT slug, bump FROM ballot_bumps').all() as { slug: string; bump: number }[];
  return new Map(rows.map((r) => [r.slug, r.bump]));
}

/** Each player's recent completed PUGs (from the queue or not) and the
 *  tallied ballots they were in, newest first. */
export function loadHistories(db: DB, players: string[]): PlayerHistory[] {
  const played = db.prepare(`
    SELECT m.id AS matchId, m.campaign FROM match_players mp JOIN matches m ON m.id = mp.match_id
    WHERE mp.player_id = ? AND ${completedPug('m')} ORDER BY m.id DESC LIMIT ${PLAYED_LOOKBACK}`);
  const ballots = db.prepare(`
    SELECT b.match_id AS matchId, b.options_json, b.votes_json FROM ballots b, json_each(b.players_json) j
    WHERE j.value = ? AND b.winner IS NOT NULL AND b.match_id IS NOT NULL
    ORDER BY b.id DESC LIMIT ${IGNORED_LOOKBACK}`);
  return players.map((p) => ({
    played: played.all(p) as PlayerHistory['played'],
    ballots: (ballots.all(p) as { matchId: number; options_json: string; votes_json: string | null }[]).map((r) => ({
      matchId: r.matchId,
      options: (JSON.parse(r.options_json) as BallotOption[]).map((o) => o.slug),
      votes: r.votes_json ? JSON.parse(r.votes_json) as Record<string, number> : {},
    })),
  }));
}

/**
 * Draw and record a ballot for a new lobby. `pool` is the vote pool the lobby
 * would otherwise offer (map_pool minus practice maps); `players` is the
 * lobby, whose histories weight the draw. Returns the options in
 * ballot order; when nothing at all can be drawn (an empty pool and no
 * stickies) it returns `pool` unchanged and records nothing, so a pop never
 * gets an empty vote.
 */
export function createBallot(db: DB, lobbyId: string, pool: string[], players: string[], rng: () => number): string[] {
  const registry = campaignRegistry(db);
  const candidates: BallotCandidate[] = pool
    .map((slug) => registry.get(slug))
    .filter((e) => !!e && !e.practiceOnly)
    .map((e) => ({ slug: e!.slug, category: e!.category }));
  // Checked again here, not only when saved: a sticky need not be in the
  // pool, so nothing else stands between it and a server without its files.
  const runnable = new Set(poolableCampaigns(db).map((c) => c.slug));
  const stickies = getStickyCampaigns(db).filter((slug) => runnable.has(slug)).slice(0, MAX_STICKIES);
  const options = drawBallot({
    candidates,
    histories: loadHistories(db, players),
    bumps: loadBumps(db),
    stickies,
    rng,
  });
  if (options.length === 0) return pool;
  db.prepare('INSERT INTO ballots (lobby_id, options_json, players_json) VALUES (?, ?, ?)')
    .run(lobbyId, JSON.stringify(options), JSON.stringify(players));
  return options.map((o) => o.slug);
}

/** Whether this lobby drew a slot ballot. */
export function hasBallot(db: DB, lobbyId: string): boolean {
  return db.prepare('SELECT 1 FROM ballots WHERE lobby_id = ?').get(lobbyId) !== undefined;
}

/** Record a ballot's tally and move the bumps on. Nothing for a lobby with no
 *  ballot (the 'all' mode, or one drawn before the switch). */
export function finishBallot(
  db: DB, lobbyId: string, votes: Readonly<Record<string, number>>, winner: string, matchId: number,
): void {
  db.transaction(() => {
    const done = db.prepare(
      'UPDATE ballots SET votes_json = ?, winner = ?, match_id = ? WHERE lobby_id = ? AND winner IS NULL',
    ).run(JSON.stringify(votes), winner, matchId, lobbyId);
    if (done.changes === 0) return;
    const next = nextBumps(loadBumps(db), votes, winner);
    db.prepare('DELETE FROM ballot_bumps').run();
    const ins = db.prepare('INSERT INTO ballot_bumps (slug, bump) VALUES (?, ?)');
    for (const [slug, bump] of next) ins.run(slug, bump);
  })();
}

export interface BallotRecord {
  id: number;
  lobbyId: string;
  createdAt: string;
  options: BallotOption[];
  votes: Record<string, number> | null;
  winner: string | null;
  matchId: number | null;
}

/** The most recent ballots, newest first, for the admin review. */
export function recentBallots(db: DB, limit = 50): BallotRecord[] {
  const rows = db.prepare(
    'SELECT id, lobby_id, created_at, options_json, votes_json, winner, match_id FROM ballots ORDER BY id DESC LIMIT ?',
  ).all(limit) as { id: number; lobby_id: string; created_at: string; options_json: string; votes_json: string | null; winner: string | null; match_id: number | null }[];
  return rows.map((r) => ({
    id: r.id, lobbyId: r.lobby_id, createdAt: r.created_at,
    options: JSON.parse(r.options_json) as BallotOption[],
    votes: r.votes_json ? JSON.parse(r.votes_json) as Record<string, number> : null,
    winner: r.winner, matchId: r.match_id,
  }));
}
