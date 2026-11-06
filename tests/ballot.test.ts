import { describe, it, expect, beforeEach } from 'vitest';
import { openDb, type DB } from '../src/db.js';
import {
  rankPoints, ignoredKeep, drawBallot, nextBumps, loadHistories, createBallot, finishBallot,
  loadBumps, recentBallots, MAX_STICKIES, RECENT_WINDOW, SLOT_TOP, type BallotCandidate, type PlayerHistory,
} from '../src/ballot.js';
import { Matchmaker } from '../src/matchmaker.js';
import { upsertPlayer, currentSeasonId } from '../src/players.js';
import { setSetting } from '../src/settings.js';
import { validateSetting } from '../src/settingsSchema.js';
import { insertDraft, publishCampaign } from '../src/customCampaigns.js';
import { invalidateCampaignCache } from '../src/campaignRegistry.js';
import type { Scheduler } from '../src/lobby.js';

const C = (slug: string, category: BallotCandidate['category']): BallotCandidate => ({ slug, category });
const POOL: BallotCandidate[] = [
  C('no_mercy', 'l4d1'), C('dead_air', 'l4d1'),
  C('the_parish', 'l4d2'), C('hard_rain', 'l4d2'),
  C('dbd', 'custom'),
  C('no_mercy_mirror', 'mirror'),
];
/** A player's history from newest-first campaigns (match ids counting down
 *  from 100) and newest-first tallied ballots. */
const hist = (played: string[], ballots: PlayerHistory['ballots'] = []): PlayerHistory => ({
  played: played.map((campaign, i) => ({ matchId: 100 - i, campaign })),
  ballots,
});
const draw = (over: Partial<Parameters<typeof drawBallot>[0]> = {}) => drawBallot({
  candidates: POOL, histories: [hist([])], bumps: new Map(), stickies: [], rng: () => 0, ...over,
});

describe('rankPoints', () => {
  it('gives 4/3/2 to the three played longest ago and 0 to the rest', () => {
    const h = hist(['a', 'b', 'c', 'd']);
    expect(Object.fromEntries(rankPoints(h, ['a', 'b', 'c', 'd']))).toEqual({ d: 4, c: 3, b: 2, a: 0 });
    const six = hist(['a', 'b', 'c', 'd', 'e', 'f']);
    expect(Object.fromEntries(rankPoints(six, ['a', 'b', 'c', 'd', 'e', 'f']))).toEqual({ f: 4, e: 3, d: 2, c: 0, b: 0, a: 0 });
  });

  it('ranks never played first, ties sharing their places\' points', () => {
    // x, y, z share places one to three: (4 + 3 + 2) / 3.
    expect(Object.fromEntries(rankPoints(hist(['a']), ['a', 'x', 'y', 'z']))).toEqual({ x: 3, y: 3, z: 3, a: 0 });
    // Five never played share 4 + 3 + 2 + 0 + 0.
    const five = rankPoints(hist(['a']), ['a', 'v', 'w', 'x', 'y', 'z']);
    expect(five.get('v')).toBe(1.8);
    expect(five.get('a')).toBe(0);
  });
});

describe('ignoredKeep', () => {
  it('halves for a no-vote showing, wearing off by half per later ballot', () => {
    const shown = { matchId: 101, options: ['dead_air', 'x'], votes: { x: 6 } };
    const other = { matchId: 102, options: ['y'], votes: { y: 6 } };
    expect(ignoredKeep(hist([], [shown]), 'dead_air')).toBe(0.5);
    expect(ignoredKeep(hist([], [other, shown]), 'dead_air')).toBe(0.75);
    expect(ignoredKeep(hist([], [other, other, shown]), 'dead_air')).toBe(0.875);
  });

  it('stacks two showings', () => {
    const shown = (matchId: number) => ({ matchId, options: ['dead_air'], votes: { x: 6 } });
    expect(ignoredKeep(hist([], [shown(102), shown(101)]), 'dead_air')).toBe(0.375);
  });

  it('does not count one vote, or a showing before they last played it', () => {
    const oneVote = { matchId: 101, options: ['dead_air', 'x'], votes: { x: 5, dead_air: 1 } };
    expect(ignoredKeep(hist([], [oneVote]), 'dead_air')).toBe(1);
    const before = { matchId: 90, options: ['dead_air'], votes: { x: 6 } };
    expect(ignoredKeep(hist(['dead_air'], [before]), 'dead_air')).toBe(1);
  });
});

describe('drawBallot', () => {
  it('draws one campaign per slot in L4D1, L4D2, custom, mirror order', () => {
    const b = draw();
    expect(b.map((o) => [o.slot, o.slug])).toEqual([
      ['l4d1', 'no_mercy'], ['l4d2', 'the_parish'], ['custom', 'dbd'], ['mirror', 'no_mercy_mirror'],
    ]);
  });

  it('skips a slot with nothing in the pool', () => {
    const b = draw({ candidates: POOL.filter((c) => c.category !== 'custom') });
    expect(b.map((o) => o.slot)).toEqual(['l4d1', 'l4d2', 'mirror']);
  });

  it('offers the L4D1 campaign the fewest just played when every one is someone\'s last', () => {
    // Owner's example: last played blood_harvest by 2, no_mercy 2,
    // death_toll 3, dead_air 1. Each player gives their own last 0 and the
    // other three 3: dead_air 21/8, blood_harvest and no_mercy 18/8,
    // death_toll 15/8. L4D1 offers its top score, whatever the rng.
    const l4d1 = ['no_mercy', 'death_toll', 'dead_air', 'blood_harvest'];
    const last = ['blood_harvest', 'blood_harvest', 'no_mercy', 'no_mercy', 'death_toll', 'death_toll', 'death_toll', 'dead_air'];
    const histories = last.map((c) => hist([c]));
    expect(SLOT_TOP.l4d1).toBe(1);
    for (const r of [0, 0.5, 0.99]) {
      const b = drawBallot({ candidates: l4d1.map((s) => C(s, 'l4d1')), histories, bumps: new Map(), stickies: [], rng: () => r });
      expect(b[0]).toMatchObject({ slug: 'dead_air', base: 2.625, recentBy: 1 });
    }
  });

  it('draws the other slots from their top three, weighted by score', () => {
    // e5 never played (4), e4 (3), e3 (2), e2 and e1 (0): 4/9, 3/9, 2/9.
    const histories = [hist(['x', 'y', 'z', 'e1', 'e2', 'e3', 'e4'])];
    const slugs = ['e1', 'e2', 'e3', 'e4', 'e5'];
    const pick = (category: BallotCandidate['category'], r: number) => drawBallot({
      candidates: slugs.map((s) => C(s, category)), histories, bumps: new Map(), stickies: [], rng: () => r,
    })[0].slug;
    expect(SLOT_TOP).toEqual({ l4d1: 1, l4d2: 3, custom: 3, mirror: 3 });
    for (const category of ['l4d2', 'custom', 'mirror'] as const) {
      expect([0.44, 0.45, 0.77, 0.78, 0.99].map((r) => pick(category, r))).toEqual(['e5', 'e4', 'e4', 'e3', 'e3']);
    }
    expect([0, 0.5, 0.99].map((r) => pick('l4d1', r))).toEqual(['e5', 'e5', 'e5']);
  });

  it('adds the lost-vote bump on top of the score', () => {
    // dead_air played longer ago (4) than no_mercy (3).
    const histories = [hist(['x', 'y', 'z', 'no_mercy', 'dead_air'])];
    expect(draw({ histories })[0]).toMatchObject({ slug: 'dead_air', base: 4, weight: 4, bump: 0 });
    const b = draw({ histories, bumps: new Map([['no_mercy', 1.5]]) });
    expect(b[0]).toMatchObject({ slug: 'no_mercy', base: 3, bump: 1.5, weight: 4.5 });
  });

  it('halves a player\'s points after a no-vote showing, and counts them', () => {
    const shown = { matchId: 101, options: ['no_mercy'], votes: { x: 6 } };
    // Alone in its slot: 4 from each, halved for player one, averages 3.
    const b = draw({ candidates: [C('no_mercy', 'l4d1')], histories: [hist([], [shown]), hist([])] });
    expect(b[0]).toMatchObject({ slug: 'no_mercy', base: 3, ignoredBy: 1 });
    // Against dead_air (3.5 from each) it loses: (1.75 + 3.5) / 2.
    expect(draw({ histories: [hist([], [shown]), hist([])] })[0].slug).toBe('dead_air');
  });

  it('leaves out a campaign in any lobby player\'s last three matches', () => {
    expect(RECENT_WINDOW).toBe(3);
    const b = draw({ histories: [hist(['x', 'y', 'no_mercy']), hist(['the_parish', 'hard_rain'])] });
    // Both L4D2 campaigns are recent for player two, so both are scored:
    // hard_rain is the older one for them (3.75 against 3.25).
    expect(b.map((o) => o.slug)).toEqual(['dead_air', 'hard_rain', 'dbd', 'no_mercy_mirror']);
    expect(b[0]).toMatchObject({ recentBy: 0 });
    expect(b[1]).toMatchObject({ recentBy: 1, base: 3.75 });
  });

  it('offers one played four matches ago again', () => {
    const b = draw({ histories: [hist(['x', 'y', 'z', 'no_mercy']), hist(['x', 'y', 'z', 'dead_air', 'no_mercy'])] });
    expect(b[0]).toMatchObject({ slug: 'no_mercy', recentBy: 0, freshest: 3 });
  });

  it('scores every campaign in a slot where all are recent', () => {
    // dead_air: 3 + 4 + 4 + 3.5; no_mercy: 4 + 3 + 3 + 3.5.
    const histories = [hist(['x', 'y', 'dead_air']), hist(['no_mercy']), hist(['x', 'no_mercy']), hist(['dbd'])];
    const b = draw({ histories, rng: () => 0.99 });
    expect(b[0]).toMatchObject({ slot: 'l4d1', slug: 'dead_air', recentBy: 1, base: 3.625 });
    // The only custom campaign is still offered.
    expect(b[2]).toMatchObject({ slot: 'custom', slug: 'dbd', recentBy: 1, freshest: 0 });
  });

  it('cannot swing a slot between two campaigns', () => {
    // Four L4D1 campaigns; the same lobby keeps playing whatever L4D1 tile
    // it is offered. Each lands once in any four in a row.
    const l4d1 = ['no_mercy', 'death_toll', 'dead_air', 'blood_harvest'];
    const candidates = l4d1.map((s) => C(s, 'l4d1'));
    const played: string[] = [];
    for (let i = 0; i < 12; i++) {
      const pick = drawBallot({ candidates, histories: [hist(played)], bumps: new Map(), stickies: [], rng: Math.random })[0].slug;
      played.unshift(pick);
    }
    for (let i = 0; i + 4 <= played.length; i++) expect(new Set(played.slice(i, i + 4)).size).toBe(4);
  });

  it('adds stickies after the slots, deduped against them, at most three', () => {
    const b = draw({ stickies: ['no_mercy', 'city17', 'c2', 'c3', 'c4'] });
    expect(b.map((o) => o.slug)).toEqual(['no_mercy', 'the_parish', 'dbd', 'no_mercy_mirror', 'city17', 'c2']);
    expect(b.filter((o) => o.slot === 'sticky').map((o) => o.weight)).toEqual([null, null]);
    expect(MAX_STICKIES).toBe(3);
  });

  it('drops a sticky in a lobby player\'s last three matches', () => {
    const b = draw({ histories: [hist([]), hist(['x', 'y', 'city17'])], stickies: ['city17', 'c2'] });
    expect(b.map((o) => o.slug)).toEqual(['no_mercy', 'the_parish', 'dbd', 'no_mercy_mirror', 'c2']);
  });
});

describe('nextBumps', () => {
  it('bumps a loser with two or more votes, not one with one', () => {
    const next = nextBumps(new Map(), { no_mercy: 5, dead_air: 2, hard_rain: 1 }, 'no_mercy');
    expect([...next]).toEqual([['dead_air', 1]]);
  });

  it('halves standing bumps each tally and drops them once tiny', () => {
    let b: Map<string, number> = new Map([['dead_air', 1]]);
    b = nextBumps(b, { no_mercy: 8 }, 'no_mercy');
    expect(b.get('dead_air')).toBe(0.5);
    for (let i = 0; i < 10; i++) b = nextBumps(b, { no_mercy: 8 }, 'no_mercy');
    expect(b.has('dead_air')).toBe(false);
  });

  it('stacks a new loss on a decayed bump', () => {
    const next = nextBumps(new Map([['dead_air', 0.5]]), { no_mercy: 4, dead_air: 3 }, 'no_mercy');
    expect(next.get('dead_air')).toBe(1.25);
  });

  it('resets the winner', () => {
    const next = nextBumps(new Map([['dead_air', 1]]), { dead_air: 4, no_mercy: 4 }, 'dead_air');
    expect(next.has('dead_air')).toBe(false);
    expect(next.get('no_mercy')).toBe(1);
  });
});

// ---------- database ----------

let db: DB;
beforeEach(() => {
  db = openDb(':memory:');
  invalidateCampaignCache();
});

const addMatch = (campaign: string, opts: { state?: string; origin?: string | null; kind?: string } = {}) =>
  Number(db.prepare('INSERT INTO matches (season_id, state, campaign, origin, kind) VALUES (?, ?, ?, ?, ?)')
    .run(currentSeasonId(db), opts.state ?? 'completed', campaign, opts.origin === undefined ? 'queue' : opts.origin, opts.kind ?? 'pug').lastInsertRowid);

const publish = (slug: string) => {
  insertDraft(db, { slug, name: slug, vpkFilename: `${slug}.vpk`, sizeBytes: 1, sha256: 'a'.repeat(64), uploadedBy: null },
    [{ map: `${slug}_1`, display: '1', isFinale: false }, { map: `${slug}_2`, display: '2', isFinale: true }]);
  publishCampaign(db, slug, slug);
  invalidateCampaignCache();
};

const P1 = '76561198000000101';
const P2 = '76561198000000102';
const withPlayers = (matchId: number, players: string[]) => {
  for (const p of players) {
    upsertPlayer(db, { steamid: p, name: p.slice(-3), avatar: null }, []);
    db.prepare("INSERT INTO match_players (match_id, player_id, team) VALUES (?, ?, 'a')").run(matchId, p);
  }
  return matchId;
};

describe('loadHistories', () => {
  it('lists each player\'s completed PUGs newest first, from the queue or not', () => {
    withPlayers(addMatch('no_mercy'), [P1, P2]);
    withPlayers(addMatch('dead_air', { state: 'aborted' }), [P1]); // not completed: not played
    withPlayers(addMatch('the_parish', { origin: 'in_game' }), [P1]);
    withPlayers(addMatch('hard_rain', { kind: 'scrim', origin: null }), [P1]); // a scrim: not a PUG
    const [h1, h2] = loadHistories(db, [P1, P2]);
    expect(h1.played.map((p) => p.campaign)).toEqual(['the_parish', 'no_mercy']);
    expect(h2.played.map((p) => p.campaign)).toEqual(['no_mercy']);
    expect(loadHistories(db, ['nobody'])[0]).toEqual({ played: [], ballots: [] });
  });

  it('lists the tallied ballots each player was in, newest first', () => {
    createBallot(db, 'lob_a', ['no_mercy', 'the_parish'], [P1, P2], () => 0);
    const m1 = addMatch('no_mercy', { state: 'configuring' });
    finishBallot(db, 'lob_a', { no_mercy: 6 }, 'no_mercy', m1);
    createBallot(db, 'lob_b', ['dead_air', 'the_parish'], [P1], () => 0);
    createBallot(db, 'lob_c', ['dead_air'], [P1], () => 0); // never tallied: left out
    const m2 = addMatch('dead_air', { state: 'configuring' });
    finishBallot(db, 'lob_b', { dead_air: 6 }, 'dead_air', m2);
    const [h1, h2] = loadHistories(db, [P1, P2]);
    expect(h1.ballots).toEqual([
      { matchId: m2, options: ['dead_air', 'the_parish'], votes: { dead_air: 6 } },
      { matchId: m1, options: ['no_mercy', 'the_parish'], votes: { no_mercy: 6 } },
    ]);
    expect(h2.ballots.map((b) => b.matchId)).toEqual([m1]);
  });
});

describe('createBallot and finishBallot', () => {
  it('records the ballot and lobby, leaves out the lobby\'s last campaigns, and keeps the tally and bumps', () => {
    withPlayers(addMatch('no_mercy'), [P1]);
    const pool = ['no_mercy', 'dead_air', 'the_parish', 'no_mercy_mirror'];
    const options = createBallot(db, 'lob_1', pool, [P1, P2], () => 0);
    expect(options).toEqual(['dead_air', 'the_parish', 'no_mercy_mirror']);
    expect(db.prepare("SELECT players_json FROM ballots WHERE lobby_id = 'lob_1'").get())
      .toEqual({ players_json: JSON.stringify([P1, P2]) });

    const matchId = addMatch('the_parish', { state: 'configuring' });
    finishBallot(db, 'lob_1', { the_parish: 5, dead_air: 3 }, 'the_parish', matchId);
    const [rec] = recentBallots(db);
    expect(rec).toMatchObject({ lobbyId: 'lob_1', winner: 'the_parish', matchId, votes: { the_parish: 5, dead_air: 3 } });
    expect(rec.options.map((o) => o.slot)).toEqual(['l4d1', 'l4d2', 'mirror']);
    expect(rec.options[0]).toMatchObject({ slug: 'dead_air', weight: 4, recentBy: 0, freshest: null, ignoredBy: 0 });
    expect([...loadBumps(db)]).toEqual([['dead_air', 1]]);

    // A second finish of the same lobby changes nothing.
    finishBallot(db, 'lob_1', { dead_air: 8 }, 'dead_air', matchId);
    expect([...loadBumps(db)]).toEqual([['dead_air', 1]]);

    // Both saw no_mercy_mirror get no votes: half its points for each.
    const next = createBallot(db, 'lob_2', ['no_mercy_mirror'], [P1, P2], () => 0);
    expect(next).toEqual(['no_mercy_mirror']);
    expect(recentBallots(db)[0].options[0]).toMatchObject({ base: 2, ignoredBy: 2 });
  });

  it('adds runnable stickies outside the pool and drops ones that cannot run', () => {
    publish('fresh');
    setSetting(db, 'ballot_sticky', JSON.stringify(['fresh', 'dark_carnival']));
    // An enabled server with neither fresh's VPK nor the dlc4 pack: both
    // stickies are dropped.
    db.prepare("INSERT INTO servers (name, host, port, rcon_port, rcon_password, status, enabled, has_dlc4) VALUES ('s', 'h', 1, 2, 'p', 'idle', 1, 0)").run();
    const options = createBallot(db, 'lob_3', ['no_mercy'], [], () => 0);
    expect(options).toEqual(['no_mercy']);
    // With no enabled server left to miss them, both run.
    db.prepare('DELETE FROM servers').run();
    expect(createBallot(db, 'lob_4', ['no_mercy'], [], () => 0)).toEqual(['no_mercy', 'fresh', 'dark_carnival']);
  });

  it('falls back to the pool when nothing can be drawn', () => {
    expect(createBallot(db, 'lob_5', [], [], () => 0)).toEqual([]);
    expect(recentBallots(db)).toEqual([]);
  });
});

describe('ballot settings', () => {
  it('ballot_mode is all or slots, all by default', () => {
    expect(validateSetting('ballot_mode', 'slots')).toEqual({ ok: true, value: 'slots' });
    expect(validateSetting('ballot_mode', 'some').ok).toBe(false);
    expect(db.prepare("SELECT value FROM settings WHERE key = 'ballot_mode'").get()).toEqual({ value: 'all' });
  });

  it('ballot_sticky may be empty and holds at most three', () => {
    const slugs = new Set(['no_mercy', 'dead_air', 'the_parish', 'hard_rain']);
    expect(validateSetting('ballot_sticky', [], { campaignSlugs: slugs })).toEqual({ ok: true, value: '[]' });
    expect(validateSetting('ballot_sticky', ['no_mercy', 'dead_air', 'the_parish'], { campaignSlugs: slugs }).ok).toBe(true);
    expect(validateSetting('ballot_sticky', ['no_mercy', 'dead_air', 'the_parish', 'hard_rain'], { campaignSlugs: slugs }).ok).toBe(false);
    expect(validateSetting('ballot_sticky', ['nope'], { campaignSlugs: slugs }).ok).toBe(false);
    // The pool's own rule is unchanged.
    expect(validateSetting('map_pool', [], { campaignSlugs: slugs }).ok).toBe(false);
  });
});

// ---------- through the matchmaker ----------

const IDS = Array.from({ length: 8 }, (_, i) => `7656119800000000${i + 1}`);
class FakeScheduler implements Scheduler {
  timers = new Map<number, () => void>();
  private nextId = 1;
  set(fn: () => void): number { const id = this.nextId++; this.timers.set(id, fn); return id; }
  clear(id: number): void { this.timers.delete(id); }
}

describe('matchmaker with ballot_mode = slots', () => {
  const make = () => {
    for (const id of IDS) upsertPlayer(db, { steamid: id, name: id.slice(-1), avatar: null }, []);
    setSetting(db, 'require_voice_to_ready', '0');
    setSetting(db, 'require_discord_to_queue', '0');
    return new Matchmaker(db, {
      broadcast: () => {},
      orchestrator: { setupMatch: async () => {}, finishMatch: async () => {} },
      scheduler: new FakeScheduler(),
      rng: () => 0,
    });
  };

  it('offers the drawn ballot, marks downloads, and records the result', () => {
    setSetting(db, 'map_pool', JSON.stringify(['no_mercy', 'dead_air', 'the_parish', 'dead_air_mirror']));
    setSetting(db, 'ballot_mode', 'slots');
    const mm = make();
    for (const id of IDS) mm.join(id);
    for (const id of IDS) mm.ready(id);
    const lobby = mm.stateFor(IDS[0]).lobby!;
    expect(lobby.options).toEqual(['no_mercy', 'the_parish', 'dead_air_mirror']);
    expect(lobby.downloads).toEqual(['the_parish', 'dead_air_mirror']);
    // Not on the ballot: refused, as any non-option always was.
    expect(mm.vote(IDS[0], 'dead_air')).toBe(false);
    for (const id of IDS.slice(0, 5)) mm.vote(id, 'the_parish');
    const [rec] = recentBallots(db);
    expect(rec).toMatchObject({ winner: 'the_parish', votes: { the_parish: 5 } });
    expect(rec.matchId).toBe((db.prepare('SELECT id FROM matches ORDER BY id DESC LIMIT 1').get() as { id: number }).id);
  });

  it('leaves the all-mode lobby without ballot fields or records', () => {
    setSetting(db, 'map_pool', JSON.stringify(['no_mercy', 'dead_air', 'the_parish']));
    const mm = make();
    for (const id of IDS) mm.join(id);
    for (const id of IDS) mm.ready(id);
    const lobby = mm.stateFor(IDS[0]).lobby!;
    expect(lobby.options).toEqual(['no_mercy', 'dead_air', 'the_parish']);
    expect('downloads' in lobby).toBe(false);
    for (const id of IDS) mm.vote(id, 'dead_air');
    expect(recentBallots(db)).toEqual([]);
  });
});
