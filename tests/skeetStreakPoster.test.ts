import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openDb, type DB } from '../src/db.js';
import { upsertPlayer } from '../src/players.js';
import { setSetting } from '../src/settings.js';
import { SkeetStreakPoster, SKEET_STREAKS_SINCE } from '../src/discord/skeetStreakPoster.js';
import { FakeTransport } from './fakes/fakeTransport.js';

const PID = 'STEAM_0:0:1';
let db: DB; let t: FakeTransport; let poster: SkeetStreakPoster;
const inWeekly = () => t.live().filter((m) => m.channelId === 'weekly');

/** A completed (or otherwise) match with one triple skeet on map 1, half 1,
 *  starting at t=0. Returns the match id. */
function seedTripleMatch(over: { state?: string; endedAt?: string; voided?: boolean } = {}): number {
  const { state = 'completed', endedAt = '2026-09-29 12:00:00', voided = false } = over;
  const id = Number(db.prepare(
    "INSERT INTO matches (season_id, state, campaign, ended_at, voided_at) VALUES (1, ?, 'no_mercy', ?, ?)",
  ).run(state, endedAt, voided ? endedAt : null).lastInsertRowid);
  const ins = db.prepare(
    'INSERT INTO match_live_events (match_id, map_ordinal, seq, kind, actor, half, t_ms) VALUES (?, 1, ?, ?, ?, 1, ?)',
  );
  [0, 1000, 2000].forEach((tMs, i) => ins.run(id, i, 'skeet', PID, tMs));
  return id;
}

beforeEach(() => {
  db = openDb(':memory:');
  upsertPlayer(db, { steamid: PID, name: 'VII', avatar: null }, []);
  setSetting(db, 'discord_weekly_channel_id', 'weekly');
  t = new FakeTransport();
  poster = new SkeetStreakPoster({ db, transport: t, publicUrl: 'https://pug.test', tickMs: 0 });
});
afterEach(() => poster.stop());

describe('SkeetStreakPoster', () => {
  it('posts exactly one message for a triple, and nothing more on the next tick', async () => {
    const id = seedTripleMatch();
    poster.start(); await poster.idle();
    expect(inWeekly()).toHaveLength(1);
    expect(inWeekly()[0].payload.content).toContain(`match ${id}`);
    expect(db.prepare('SELECT posted_at FROM skeet_streaks').get()).not.toEqual({ posted_at: null });

    await poster.tickNow();
    expect(inWeekly()).toHaveLength(1);
  });

  it('never scans or posts a match that ended before the feature shipped', async () => {
    const before = new Date(new Date(`${SKEET_STREAKS_SINCE}Z`).getTime() - 60_000).toISOString().replace('T', ' ').slice(0, 19);
    seedTripleMatch({ endedAt: before });
    poster.start(); await poster.idle();
    expect(inWeekly()).toHaveLength(0);
    expect(db.prepare('SELECT COUNT(*) AS n FROM skeet_streaks').get()).toEqual({ n: 0 });
    expect(db.prepare('SELECT COUNT(*) AS n FROM skeet_streak_scans').get()).toEqual({ n: 0 });
  });

  it('does not scan a live match, but finds and posts it once it completes', async () => {
    const id = seedTripleMatch({ state: 'live', endedAt: '2026-09-29 12:00:00' });
    poster.start(); await poster.idle();
    expect(inWeekly()).toHaveLength(0);
    expect(db.prepare('SELECT COUNT(*) AS n FROM skeet_streak_scans').get()).toEqual({ n: 0 });

    db.prepare("UPDATE matches SET state = 'completed' WHERE id = ?").run(id);
    await poster.tickNow();
    expect(inWeekly()).toHaveLength(1);
  });

  it('stores rows but sends nothing with a blank channel, then sends them once the channel is set', async () => {
    setSetting(db, 'discord_weekly_channel_id', '');
    seedTripleMatch();
    poster.start(); await poster.idle();
    expect(inWeekly()).toHaveLength(0);
    expect(db.prepare('SELECT COUNT(*) AS n FROM skeet_streaks WHERE posted_at IS NULL').get()).toEqual({ n: 1 });

    setSetting(db, 'discord_weekly_channel_id', 'weekly');
    await poster.tickNow();
    expect(inWeekly()).toHaveLength(1);
  });

  it('retries a failed send on the next tick and posts it once', async () => {
    t.failSends = 1;
    seedTripleMatch();
    poster.start(); await poster.idle();
    expect(inWeekly()).toHaveLength(0);
    expect(db.prepare('SELECT posted_at FROM skeet_streaks').get()).toEqual({ posted_at: null });

    await poster.tickNow();
    expect(inWeekly()).toHaveLength(1);
  });

  it('never announces a voided match', async () => {
    seedTripleMatch({ voided: true });
    poster.start(); await poster.idle();
    expect(inWeekly()).toHaveLength(0);
    expect(db.prepare('SELECT COUNT(*) AS n FROM skeet_streaks').get()).toEqual({ n: 0 });
  });
});
