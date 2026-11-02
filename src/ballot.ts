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
 * Inside a slot the draw is weighted toward campaigns nobody has played for a
 * while: 1 + n/10, capped at 3, where n is the completed queue PUGs (on any
 * campaign) since this one was last played or won a vote. Counting every
 * campaign's matches is what makes it fair across slots: three L4D2 picks in a
 * row raise every L4D1 campaign's count by the same three. Never played is the
 * cap. A campaign that lost a vote with two or more votes gets a bump on top,
 * which halves at every later tally it does not win and goes once it wins.
 */

export const BALLOT_SLOTS: readonly CampaignCategory[] = ['l4d1', 'l4d2', 'custom', 'mirror'];
/** Matches since last played for one more unit of weight. */
export const WEIGHT_STEP = 10;
export const WEIGHT_CAP = 3;
/** What a close loss (two or more votes) adds to a campaign's weight. */
export const LOST_VOTE_BUMP = 0.5;
/** A decayed bump under this is dropped rather than halved forever. */
const BUMP_FLOOR = 0.01;
export const MAX_STICKIES = 3;

export type BallotMode = 'all' | 'slots';

export function ballotMode(db: DB): BallotMode {
  return getSetting(db, 'ballot_mode') === 'slots' ? 'slots' : 'all';
}

export interface BallotOption {
  slug: string;
  slot: CampaignCategory | 'sticky';
  /** What the draw used: base + bump. Null for a sticky (not drawn). */
  weight: number | null;
  base: number | null;
  /** Completed queue PUGs since it was last played; null = never. */
  since: number | null;
  bump: number;
}

export interface BallotCandidate { slug: string; category: CampaignCategory }

export interface DrawInput {
  /** The pool, already narrowed to campaigns the site can run. */
  candidates: BallotCandidate[];
  since: ReadonlyMap<string, number | null>;
  bumps: ReadonlyMap<string, number>;
  /** The last queue match's campaign, left out of its slot. */
  exclude: string | null;
  stickies: string[];
  rng: () => number;
}

/** A slot's weight before any bump: 1 + n/WEIGHT_STEP, capped; never played is the cap. */
export function baseWeight(since: number | null): number {
  if (since === null) return WEIGHT_CAP;
  return Math.min(1 + since / WEIGHT_STEP, WEIGHT_CAP);
}

/** One weighted pick. `rng` returns [0, 1) like Math.random. */
function weightedPick<T extends { weight: number }>(items: T[], rng: () => number): T {
  const total = items.reduce((a, it) => a + it.weight, 0);
  let r = rng() * total;
  for (const it of items) {
    r -= it.weight;
    if (r < 0) return it;
  }
  return items[items.length - 1];
}

/** The ballot: one drawn option per non-empty slot in BALLOT_SLOTS order,
 *  then each sticky not already drawn. Pure, for tests. */
export function drawBallot(input: DrawInput): BallotOption[] {
  const out: BallotOption[] = [];
  for (const slot of BALLOT_SLOTS) {
    const inSlot = input.candidates
      .filter((c) => c.category === slot && c.slug !== input.exclude)
      .map((c) => {
        const since = input.since.get(c.slug) ?? null;
        const base = baseWeight(since);
        const bump = input.bumps.get(c.slug) ?? 0;
        return { slug: c.slug, since, base, bump, weight: base + bump };
      });
    if (inSlot.length === 0) continue;
    const pick = weightedPick(inSlot, input.rng);
    out.push({ slug: pick.slug, slot, weight: pick.weight, base: pick.base, since: pick.since, bump: pick.bump });
  }
  for (const slug of input.stickies.slice(0, MAX_STICKIES)) {
    if (out.some((o) => o.slug === slug)) continue;
    out.push({ slug, slot: 'sticky', weight: null, base: null, since: input.since.get(slug) ?? null, bump: input.bumps.get(slug) ?? 0 });
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

/** Completed queue PUGs since each campaign was last played (a completed PUG
 *  on it, from the queue or not) or won a vote (any queue match on it, since
 *  a queue match only exists because its campaign won one). Null when
 *  neither ever happened. */
export function matchesSince(db: DB, slugs: string[]): Map<string, number | null> {
  const anchorOf = db.prepare(`
    SELECT MAX(id) AS id FROM matches
    WHERE campaign = ? AND (origin = 'queue' OR (${completedPug()}))`);
  const countAfter = db.prepare(`
    SELECT COUNT(*) AS n FROM matches WHERE ${completedPug()} AND origin = 'queue' AND id > ?`);
  const out = new Map<string, number | null>();
  for (const slug of slugs) {
    const anchor = (anchorOf.get(slug) as { id: number | null }).id;
    out.set(slug, anchor === null ? null : (countAfter.get(anchor) as { n: number }).n);
  }
  return out;
}

/** The campaign the most recent queue match was made for, whatever became of it. */
export function lastQueueCampaign(db: DB): string | null {
  const row = db.prepare("SELECT campaign FROM matches WHERE origin = 'queue' ORDER BY id DESC LIMIT 1")
    .get() as { campaign: string } | undefined;
  return row?.campaign ?? null;
}

/**
 * Draw and record a ballot for a new lobby. `pool` is the vote pool the lobby
 * would otherwise offer (map_pool minus practice maps). Returns the options in
 * ballot order; when nothing at all can be drawn (an empty pool and no
 * stickies) it returns `pool` unchanged and records nothing, so a pop never
 * gets an empty vote.
 */
export function createBallot(db: DB, lobbyId: string, pool: string[], rng: () => number): string[] {
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
    since: matchesSince(db, [...new Set([...candidates.map((c) => c.slug), ...stickies])]),
    bumps: loadBumps(db),
    exclude: lastQueueCampaign(db),
    stickies,
    rng,
  });
  if (options.length === 0) return pool;
  db.prepare('INSERT INTO ballots (lobby_id, options_json) VALUES (?, ?)').run(lobbyId, JSON.stringify(options));
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
