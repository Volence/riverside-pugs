import { describe, it, expect, beforeEach } from 'vitest';
import { openDb, type DB } from '../src/db.js';
import { addServer } from '../src/serverPool.js';
import { setSetting } from '../src/settings.js';
import { createTeam, disbandTeam } from '../src/teams/teams.js';
import { acceptPost, createPost, getAccept, getPost, type ScrimResult } from '../src/scrims/scrims.js';
import { Notifier } from '../src/notify/notify.js';
import { ScrimBoard } from '../src/scrims/board.js';

const P = Array.from({ length: 4 }, (_, i) => `765611990000020${String(i).padStart(2, '0')}`);
const NOW = new Date('2026-10-01T12:00:00.000Z');
const START = '2026-10-02T20:00:00.000Z';
const PUBLIC_URL = 'https://riversidepug.com';

let db: DB;
let dms: { to: string; content: string }[];

const value = <T>(r: ScrimResult<T>): T => {
  if (!r.ok) throw new Error(r.error);
  return r.value;
};

beforeEach(() => {
  db = openDb(':memory:');
  dms = [];
  const ins = db.prepare("INSERT INTO players (steamid, name, status, discord_id) VALUES (?, ?, 'active', ?)");
  P.forEach((id, i) => ins.run(id, `p${i}`, `d${i}`));
  setSetting(db, 'competitive_enabled', 'everyone');
  setSetting(db, 'map_pool', JSON.stringify(['no_mercy', 'death_toll']));
  for (const n of ['a', 'bb', 'ccc']) {
    const id = addServer(db, { name: n, host: 'h', port: 27000 + n.length, rconPort: 1, rconPassword: 'x' });
    db.prepare("UPDATE servers SET status = 'idle' WHERE id = ?").run(id);
  }
});

const fakeNotifier = () => new Notifier({ db, dm: () => async (to, p) => { dms.push({ to, content: p.content ?? '' }); } });
const teamOf = (captain: string): number => {
  const t = createTeam(db, { creator: captain, name: 'Rats', tag: 'RR', now: NOW });
  if (!t.ok) throw new Error(t.error);
  return t.value.id;
};

describe('ScrimBoard.tick', () => {
  it('expires a post past its start and tells its pending accepter scrim_declined, "it expired"', async () => {
    const postId = value(createPost(db, {
      by: P[0], startsAt: START, minutes: 90, campaigns: ['no_mercy'], srRange: null, note: '', now: NOW,
    })).id;
    const acceptId = value(acceptPost(db, { postId, by: P[1], now: NOW })).id;

    const board = new ScrimBoard({ db, notifier: fakeNotifier(), publicUrl: PUBLIC_URL, now: () => Date.parse(START) });
    await board.tick();

    expect(dms).toHaveLength(1);
    expect(dms[0].to).toBe('d1');
    expect(dms[0].content).toMatch(/is closed: it expired/);
    expect(getPost(db, postId)?.status).toBe('expired');
    expect(getAccept(db, acceptId)?.status).toBe('expired');
  });

  it('a stale 2-hour-old acceptance on a still-open post is expired and its accepter told too', async () => {
    const postId = value(createPost(db, {
      by: P[0], startsAt: START, minutes: 90, campaigns: ['no_mercy'], srRange: null, note: '', now: NOW,
    })).id;
    const acceptId = value(acceptPost(db, { postId, by: P[1], now: NOW })).id;

    const twoHoursLater = Date.parse(NOW.toISOString()) + 2 * 3_600_000;
    const board = new ScrimBoard({ db, notifier: fakeNotifier(), publicUrl: PUBLIC_URL, now: () => twoHoursLater });
    await board.tick();

    expect(dms).toHaveLength(1);
    expect(dms[0].to).toBe('d1');
    // The post itself has not started yet: it goes back to open, not expired.
    expect(getPost(db, postId)?.status).toBe('open');
    expect(getAccept(db, acceptId)?.status).toBe('expired');
  });

  it('tells the accepter of a post withdrawn because its team was disbanded (the withdrawn branch, not accepts)', async () => {
    const rats = teamOf(P[0]);
    const postId = value(createPost(db, {
      by: P[0], teamId: rats, startsAt: START, minutes: 90, campaigns: ['no_mercy'], srRange: null, note: '', now: NOW,
    })).id;
    const acceptId = value(acceptPost(db, { postId, by: P[1], now: NOW })).id;
    disbandTeam(db, { teamId: rats, by: P[0], now: NOW });

    const board = new ScrimBoard({ db, notifier: fakeNotifier(), publicUrl: PUBLIC_URL, now: () => Date.parse(NOW.toISOString()) });
    await board.tick();

    expect(dms).toHaveLength(1);
    expect(dms[0].to).toBe('d1');
    expect(dms[0].content).toMatch(/is closed: it expired/);
    expect(getPost(db, postId)?.status).toBe('withdrawn');
    expect(getAccept(db, acceptId)?.status).toBe('withdrawn');
  });

  it('leaves a booked post and its chosen acceptance alone: no notice', async () => {
    const postId = value(createPost(db, {
      by: P[0], startsAt: START, minutes: 90, campaigns: ['no_mercy'], srRange: null, note: '', now: NOW,
    })).id;
    value(acceptPost(db, { postId, by: P[1], now: NOW }));

    const board = new ScrimBoard({ db, notifier: fakeNotifier(), publicUrl: PUBLIC_URL, now: () => Date.parse(NOW.toISOString()) });
    await board.tick();
    expect(dms).toEqual([]);
  });

  it('calls poster.tickNow() only when one is wired', async () => {
    let ticked = 0;
    const notifier = fakeNotifier();
    const withPoster = new ScrimBoard({
      db, notifier, publicUrl: PUBLIC_URL, now: () => Date.parse(NOW.toISOString()),
      poster: () => ({ tickNow: () => { ticked++; } }),
    });
    await withPoster.tick();
    expect(ticked).toBe(1);

    const withoutPoster = new ScrimBoard({ db, notifier, publicUrl: PUBLIC_URL, now: () => Date.parse(NOW.toISOString()) });
    await expect(withoutPoster.tick()).resolves.toBeUndefined();

    // A poster getter that currently has none wired (Task 4 not built yet) is a no-op, not a throw.
    const noneYet = new ScrimBoard({ db, notifier, publicUrl: PUBLIC_URL, now: () => Date.parse(NOW.toISOString()), poster: () => null });
    await expect(noneYet.tick()).resolves.toBeUndefined();
  });
});
