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
  now = new Date('2026-09-28T12:10:00Z');   // Monday just after the noon UTC close of the week of Sep 21
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

  it('freezes and posts nothing while the first tracked week is still open', async () => {
    now = new Date('2026-09-24T12:00:00Z');   // inside the week of 2026-09-21, WEEKLY_FIRST_WEEK
    poster.start(); await poster.idle();
    expect(db.prepare('SELECT week_start FROM weekly_award_weeks').all()).toEqual([]);
    expect(inWeekly()).toHaveLength(0);
  });

  it('catches up one week on the next tick after an outage', async () => {
    poster.start(); await poster.idle();   // freezes and posts 2026-09-21
    expect(inWeekly()).toHaveLength(2);
    now = new Date('2026-10-06T00:10:00Z');   // the week after 2026-09-28 closed
    await poster.tickNow();
    expect(db.prepare('SELECT week_start FROM weekly_award_weeks ORDER BY week_start').all())
      .toEqual([{ week_start: '2026-09-21' }, { week_start: '2026-09-28' }]);
    // 2026-09-28 had no matches: only a "no matches" recap gets posted for it.
    expect(inWeekly()).toHaveLength(3);
    expect(inWeekly()[2].payload.content).toContain('Weekly recap, week of Sep 28');
    expect(inWeekly()[2].payload.content).toContain('No matches were played');
    expect(db.prepare("SELECT posted_at FROM weekly_award_weeks WHERE week_start = '2026-09-28'").get()).not.toEqual({ posted_at: null });
  });

  it('catches up every closed week from a cold start, posting only the newest', async () => {
    now = new Date('2026-10-13T00:10:00Z');   // three weeks have closed since WEEKLY_FIRST_WEEK
    poster.start(); await poster.idle();
    expect(db.prepare('SELECT week_start FROM weekly_award_weeks ORDER BY week_start').all())
      .toEqual([{ week_start: '2026-09-21' }, { week_start: '2026-09-28' }, { week_start: '2026-10-05' }]);
    // Only the newest week is ever posted; the older catch-up weeks are frozen silently.
    expect(db.prepare("SELECT posted_at FROM weekly_award_weeks WHERE week_start != '2026-10-05'").all())
      .toEqual([{ posted_at: null }, { posted_at: null }]);
    expect(db.prepare("SELECT posted_at FROM weekly_award_weeks WHERE week_start = '2026-10-05'").get())
      .not.toEqual({ posted_at: null });
    expect(inWeekly()).toHaveLength(1);
    expect(inWeekly()[0].payload.content).toContain('Weekly recap, week of Oct 5');
    expect(inWeekly()[0].payload.content).toContain('No matches were played');
  });
});
