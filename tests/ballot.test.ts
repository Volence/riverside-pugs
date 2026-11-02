import { describe, it, expect, beforeEach } from 'vitest';
import { openDb, type DB } from '../src/db.js';
import {
  baseWeight, drawBallot, nextBumps, matchesSince, lastQueueCampaign, createBallot, finishBallot,
  loadBumps, recentBallots, MAX_STICKIES, type BallotCandidate,
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
const draw = (over: Partial<Parameters<typeof drawBallot>[0]> = {}) => drawBallot({
  candidates: POOL, since: new Map(), bumps: new Map(), exclude: null, stickies: [], rng: () => 0, ...over,
});

describe('baseWeight', () => {
  it('is 1 + n/10 capped at 3, and the cap when never played', () => {
    expect(baseWeight(0)).toBe(1);
    expect(baseWeight(5)).toBe(1.5);
    expect(baseWeight(20)).toBe(3);
    expect(baseWeight(80)).toBe(3);
    expect(baseWeight(null)).toBe(3);
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

  it('weights by matches since last played', () => {
    // no_mercy played 0 matches ago (weight 1), dead_air never (3): total 4,
    // so rng below 0.25 is no_mercy and anything above is dead_air.
    const since = new Map<string, number | null>([['no_mercy', 0], ['dead_air', null]]);
    const pick = (r: number) => draw({ since, rng: () => r })[0];
    expect(pick(0.2).slug).toBe('no_mercy');
    expect(pick(0.3).slug).toBe('dead_air');
    expect(pick(0.3)).toMatchObject({ weight: 3, base: 3, since: null, bump: 0 });
  });

  it('adds the lost-vote bump on top of the base weight', () => {
    const since = new Map<string, number | null>([['no_mercy', 0], ['dead_air', 0]]);
    const bumps = new Map([['no_mercy', 0.5]]);
    // 1.5 vs 1: no_mercy takes the first 60%.
    expect(draw({ since, bumps, rng: () => 0.59 })[0].slug).toBe('no_mercy');
    expect(draw({ since, bumps, rng: () => 0.61 })[0].slug).toBe('dead_air');
    expect(draw({ since, bumps })[0]).toMatchObject({ weight: 1.5, base: 1, bump: 0.5 });
  });

  it('leaves the last queue match\'s campaign out of its slot, and skips the slot if that empties it', () => {
    const b = draw({ exclude: 'no_mercy' });
    expect(b[0].slug).toBe('dead_air');
    expect(draw({ exclude: 'dbd' }).map((o) => o.slot)).toEqual(['l4d1', 'l4d2', 'mirror']);
  });

  it('adds stickies after the slots, deduped against them, at most three', () => {
    const b = draw({ stickies: ['no_mercy', 'city17', 'c2', 'c3', 'c4'] });
    expect(b.map((o) => o.slug)).toEqual(['no_mercy', 'the_parish', 'dbd', 'no_mercy_mirror', 'city17', 'c2']);
    expect(b.filter((o) => o.slot === 'sticky').map((o) => o.weight)).toEqual([null, null]);
    expect(MAX_STICKIES).toBe(3);
  });

  it('keeps a sticky even when it is the last queue match\'s campaign', () => {
    const b = draw({ exclude: 'no_mercy', stickies: ['no_mercy'] });
    expect(b.map((o) => o.slug)).toEqual(['dead_air', 'the_parish', 'dbd', 'no_mercy_mirror', 'no_mercy']);
  });
});

describe('nextBumps', () => {
  it('bumps a loser with two or more votes, not one with one', () => {
    const next = nextBumps(new Map(), { no_mercy: 5, dead_air: 2, hard_rain: 1 }, 'no_mercy');
    expect([...next]).toEqual([['dead_air', 0.5]]);
  });

  it('halves standing bumps each tally and drops them once tiny', () => {
    let b: Map<string, number> = new Map([['dead_air', 0.5]]);
    b = nextBumps(b, { no_mercy: 8 }, 'no_mercy');
    expect(b.get('dead_air')).toBe(0.25);
    for (let i = 0; i < 10; i++) b = nextBumps(b, { no_mercy: 8 }, 'no_mercy');
    expect(b.has('dead_air')).toBe(false);
  });

  it('stacks a new loss on a decayed bump', () => {
    const next = nextBumps(new Map([['dead_air', 0.5]]), { no_mercy: 4, dead_air: 3 }, 'no_mercy');
    expect(next.get('dead_air')).toBe(0.75);
  });

  it('resets the winner', () => {
    const next = nextBumps(new Map([['dead_air', 1]]), { dead_air: 4, no_mercy: 4 }, 'dead_air');
    expect(next.has('dead_air')).toBe(false);
    expect(next.get('no_mercy')).toBe(0.5);
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

describe('matchesSince', () => {
  it('counts completed queue PUGs on any campaign since this one was last played or won', () => {
    addMatch('no_mercy');
    addMatch('dead_air');
    addMatch('dead_air', { state: 'aborted' }); // not a completed PUG: not counted
    addMatch('the_parish');
    addMatch('dead_air', { kind: 'scrim', origin: null }); // a scrim: neither counted nor an anchor
    addMatch('hard_rain', { state: 'aborted' }); // won a vote, then aborted: the anchor still moves
    const since = matchesSince(db, ['no_mercy', 'dead_air', 'the_parish', 'hard_rain', 'blood_harvest']);
    expect(since.get('no_mercy')).toBe(2);
    expect(since.get('dead_air')).toBe(1);
    expect(since.get('the_parish')).toBe(0);
    expect(since.get('hard_rain')).toBe(0);
    expect(since.get('blood_harvest')).toBeNull();
  });

  it('counts a self-started PUG as played but not as a match in the count', () => {
    addMatch('no_mercy');
    addMatch('dead_air', { origin: 'in_game' });
    addMatch('the_parish');
    const since = matchesSince(db, ['no_mercy', 'dead_air']);
    expect(since.get('no_mercy')).toBe(1);
    expect(since.get('dead_air')).toBe(1);
  });
});

describe('createBallot and finishBallot', () => {
  it('records the ballot, leaves out the last queue campaign, and keeps the tally and bumps', () => {
    addMatch('no_mercy', { state: 'live' });
    expect(lastQueueCampaign(db)).toBe('no_mercy');
    const pool = ['no_mercy', 'dead_air', 'the_parish', 'no_mercy_mirror'];
    const options = createBallot(db, 'lob_1', pool, () => 0);
    expect(options).toEqual(['dead_air', 'the_parish', 'no_mercy_mirror']);

    const matchId = addMatch('the_parish', { state: 'configuring' });
    finishBallot(db, 'lob_1', { the_parish: 5, dead_air: 3 }, 'the_parish', matchId);
    const [rec] = recentBallots(db);
    expect(rec).toMatchObject({ lobbyId: 'lob_1', winner: 'the_parish', matchId, votes: { the_parish: 5, dead_air: 3 } });
    expect(rec.options.map((o) => o.slot)).toEqual(['l4d1', 'l4d2', 'mirror']);
    expect(rec.options[0]).toMatchObject({ slug: 'dead_air', since: null, weight: 3 });
    expect([...loadBumps(db)]).toEqual([['dead_air', 0.5]]);

    // A second finish of the same lobby changes nothing.
    finishBallot(db, 'lob_1', { dead_air: 8 }, 'dead_air', matchId);
    expect([...loadBumps(db)]).toEqual([['dead_air', 0.5]]);
  });

  it('adds runnable stickies outside the pool and drops ones that cannot run', () => {
    publish('fresh');
    setSetting(db, 'ballot_sticky', JSON.stringify(['fresh', 'dark_carnival']));
    // An enabled server with neither fresh's VPK nor the dlc4 pack: both
    // stickies are dropped.
    db.prepare("INSERT INTO servers (name, host, port, rcon_port, rcon_password, status, enabled, has_dlc4) VALUES ('s', 'h', 1, 2, 'p', 'idle', 1, 0)").run();
    const options = createBallot(db, 'lob_2', ['no_mercy'], () => 0);
    expect(options).toEqual(['no_mercy']);
    // With no enabled server left to miss them, both run.
    db.prepare('DELETE FROM servers').run();
    expect(createBallot(db, 'lob_3', ['no_mercy'], () => 0)).toEqual(['no_mercy', 'fresh', 'dark_carnival']);
  });

  it('falls back to the pool when nothing can be drawn', () => {
    expect(createBallot(db, 'lob_4', [], () => 0)).toEqual([]);
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
