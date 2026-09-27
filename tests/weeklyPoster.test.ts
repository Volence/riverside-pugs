import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openDb, type DB } from '../src/db.js';
import { setSetting } from '../src/settings.js';
import { WeeklyPoster } from '../src/discord/weeklyPoster.js';
import { FakeTransport } from './fakes/fakeTransport.js';
import { seedMatch, seedPlayers } from './weeklyFixtures.js';

let db: DB; let t: FakeTransport; let poster: WeeklyPoster; let now: Date;
const inWeekly = () => t.live().filter((m) => m.channelId === 'weekly');

beforeEach(() => {
  db = openDb(':memory:');
  const [p] = seedPlayers(db, 1);
  for (let i = 0; i < 5; i++) seedMatch(db, { endedAt: `2026-09-22 1${i}:00:00`, lines: [{ id: p, team: 'a', stats: { skeets: 3 } }] });
  setSetting(db, 'discord_weekly_channel_id', 'weekly');
  t = new FakeTransport();
  now = new Date('2026-09-28T00:10:00Z');   // Monday just after the week of Sep 21 closed
  poster = new WeeklyPoster({ db, transport: t, publicUrl: 'https://pug.test', tickMs: 0, now: () => now });
});
afterEach(() => poster.stop());

describe('WeeklyPoster', () => {
  it('freezes the closed week and posts the recap then the awards, once', async () => {
    poster.start(); await poster.idle();
    expect(inWeekly()).toHaveLength(2);
    expect(inWeekly()[0].payload.content).toContain('Weekly recap, week of Sep 21');
    expect(inWeekly()[1].payload.embeds[0].title).toBe('Weekly awards, week of Sep 21');
    await poster.tickNow();
    expect(inWeekly()).toHaveLength(2);
    expect(db.prepare("SELECT posted_at FROM weekly_award_weeks WHERE week_start = '2026-09-21'").get()).not.toEqual({ posted_at: null });
  });

  it('a blank channel posts nothing but still freezes', async () => {
    setSetting(db, 'discord_weekly_channel_id', '');
    poster.start(); await poster.idle();
    expect(t.live()).toHaveLength(0);
    expect(db.prepare("SELECT COUNT(*) AS n FROM weekly_award_weeks WHERE posted_at IS NULL").get()).toEqual({ n: 1 });
  });

  it('a failure after the recap resends only the awards', async () => {
    const kind = (m: { payload: { content?: string } }) => (m.payload.content ? 'recap' : 'awards');
    let sends = 0;
    const real = t.send.bind(t);
    t.send = async (ch, p) => { sends++; if (sends === 2) throw new Error('discord down'); return real(ch, p); };
    await poster.tickNow();
    expect(inWeekly().map(kind)).toEqual(['recap']);
    await poster.tickNow();
    expect(inWeekly().map(kind)).toEqual(['recap', 'awards']);
  });

  it('does not freeze or post the week still in progress', async () => {
    now = new Date('2026-09-24T12:00:00Z');
    poster.start(); await poster.idle();
    expect(db.prepare("SELECT week_start FROM weekly_award_weeks").all()).toEqual([{ week_start: '2026-09-14' }]);
    // Last week had no matches: a short "no matches" recap and no awards embed.
    expect(inWeekly()).toHaveLength(1);
    expect(inWeekly()[0].payload.content).toContain('No matches were played');
  });
});
