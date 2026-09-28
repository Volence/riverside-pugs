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

  it('pins the 7-day stale cutoff: 6d21h ago still pending, 7d1h ago skipped', async () => {
    // A blank channel so the distinction is visible in posted_at (NULL vs
    // 'skipped') rather than being masked by an immediate send.
    setSetting(db, 'discord_weekly_channel_id', '');
    const now = new Date('2026-10-10 12:00:00Z');
    const dayMs = 24 * 60 * 60_000;
    const fresh = new Date(now.getTime() - (6 * dayMs + 21 * 60 * 60_000)).toISOString().replace('T', ' ').slice(0, 19);
    const stale = new Date(now.getTime() - (7 * dayMs + 60 * 60_000)).toISOString().replace('T', ' ').slice(0, 19);
    // Distinct map_ordinal so the two matches' rows never collide, and times
    // that stay comfortably inside SKEET_STREAKS_SINCE.
    const freshId = seedTripleMatch({ endedAt: fresh });
    const staleId = seedTripleMatch({ endedAt: stale });
    const clocked = new SkeetStreakPoster({ db, transport: t, publicUrl: 'https://pug.test', tickMs: 0, now: () => now });
    clocked.start(); await clocked.idle();
    clocked.stop();
    expect(db.prepare('SELECT posted_at FROM skeet_streaks WHERE match_id = ?').get(freshId)).toEqual({ posted_at: null });
    expect(db.prepare('SELECT posted_at FROM skeet_streaks WHERE match_id = ?').get(staleId)).toEqual({ posted_at: 'skipped' });
  });

  it('stores scanned_at in the same date format as the rest of the schema (space, no fractional seconds/offset)', async () => {
    seedTripleMatch();
    poster.start(); await poster.idle();
    const row = db.prepare('SELECT scanned_at FROM skeet_streak_scans').get() as { scanned_at: string };
    expect(row.scanned_at).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
  });

  describe('retraction', () => {
    it('removes the posted message once a match is voided, and does not re-send or re-remove it', async () => {
      const id = seedTripleMatch();
      poster.start(); await poster.idle();
      expect(inWeekly()).toHaveLength(1);
      const messageId = inWeekly()[0].id;

      db.prepare("UPDATE matches SET voided_at = ended_at WHERE id = ?").run(id);
      await poster.tickNow();
      expect(t.byId(messageId)?.deleted).toBe(true);
      expect(db.prepare('SELECT posted_at, message_id FROM skeet_streaks').get())
        .toEqual({ posted_at: 'retracted', message_id: messageId });

      // A second tick must not remove it again or send anything new.
      const removedBefore = t.messages.filter((m) => m.deleted).length;
      await poster.tickNow();
      expect(inWeekly()).toHaveLength(0);
      expect(t.messages.filter((m) => m.deleted).length).toBe(removedBefore);
    });

    it('retries a failed retraction on the next tick and retracts it once', async () => {
      const id = seedTripleMatch();
      poster.start(); await poster.idle();
      const messageId = inWeekly()[0].id;
      const postedAtBefore = (db.prepare('SELECT posted_at FROM skeet_streaks').get() as { posted_at: string }).posted_at;
      db.prepare("UPDATE matches SET voided_at = ended_at WHERE id = ?").run(id);

      const real = t.remove.bind(t);
      let calls = 0;
      t.remove = async (ch, m) => { calls++; if (calls === 1) throw new Error('discord down'); return real(ch, m); };
      await poster.tickNow();
      // Left exactly as it was: still posted, message not deleted, not yet retracted.
      expect(db.prepare('SELECT posted_at, message_id FROM skeet_streaks').get()).toEqual({ posted_at: postedAtBefore, message_id: messageId });
      expect(t.byId(messageId)?.deleted).toBeFalsy();

      await poster.tickNow();
      expect(db.prepare('SELECT posted_at FROM skeet_streaks').get()).toEqual({ posted_at: 'retracted' });
      expect(t.byId(messageId)?.deleted).toBe(true);
      expect(calls).toBe(2);
    });

    it('never sends a burst for a match voided after it was scanned but before it was ever posted', async () => {
      setSetting(db, 'discord_weekly_channel_id', '');
      const id = seedTripleMatch();
      poster.start(); await poster.idle();   // scans and stores the row, blank channel sends nothing
      expect(db.prepare('SELECT COUNT(*) AS n FROM skeet_streaks WHERE posted_at IS NULL').get()).toEqual({ n: 1 });

      db.prepare("UPDATE matches SET voided_at = ended_at WHERE id = ?").run(id);
      setSetting(db, 'discord_weekly_channel_id', 'weekly');
      await poster.tickNow();
      expect(inWeekly()).toHaveLength(0);
      expect(db.prepare('SELECT posted_at, message_id FROM skeet_streaks').get()).toEqual({ posted_at: null, message_id: null });
    });
  });
});
