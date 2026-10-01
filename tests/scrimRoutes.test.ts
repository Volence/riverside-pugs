import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import { openDb, type DB } from '../src/db.js';
import { addServer } from '../src/serverPool.js';
import { setSetting } from '../src/settings.js';
import { createTeam, invitePlayer, respondInvite, setRole } from '../src/teams/teams.js';
import { createBooking } from '../src/bookings/bookings.js';
import { Notifier } from '../src/notify/notify.js';
import { bookingRoutes } from '../src/routes/bookings.js';
import type { BookingRunner } from '../src/bookings/runner.js';
import { scrimRoutes } from '../src/routes/scrims.js';
import { authedCookie } from './helpers.js';

const P = Array.from({ length: 8 }, (_, i) => `765611990000010${String(i).padStart(2, '0')}`);
const ADMIN = '76561199000001090';
const MOD = '76561199000001091';
const START = '2026-10-02T20:00:00.000Z';
const NOW = new Date('2026-10-01T12:00:00.000Z');
const PUBLIC_URL = 'https://riversidepug.com';

let db: DB;
let app: FastifyInstance;
let cookies: Record<string, Record<string, string>>;
let dms: { to: string; content: string }[];

beforeEach(async () => {
  db = openDb(':memory:');
  dms = [];
  app = Fastify();
  await app.register(cookie, { secret: 'x'.repeat(32) });
  const notifier = new Notifier({
    db,
    dm: () => async (to, p) => { dms.push({ to, content: p.content ?? '' }); },
  });
  await app.register(scrimRoutes, { db, runner: null, notifier, publicUrl: PUBLIC_URL });
  await app.register(bookingRoutes, { db, runner: null });
  await app.ready();

  cookies = {};
  for (const id of [...P, ADMIN, MOD]) {
    cookies[id] = authedCookie(app, db, id);
    db.prepare('UPDATE players SET discord_id = ? WHERE steamid = ?').run(`d${id.slice(-4)}`, id);
  }
  db.prepare('UPDATE players SET is_admin = 1 WHERE steamid = ?').run(ADMIN);
  db.prepare('UPDATE players SET is_mod = 1 WHERE steamid = ?').run(MOD);
  setSetting(db, 'competitive_enabled', 'everyone');
  setSetting(db, 'map_pool', JSON.stringify(['no_mercy', 'death_toll', 'dead_air']));
  for (const n of ['a', 'bb', 'ccc', 'dddd']) {
    const id = addServer(db, { name: n, host: 'h', port: 27000 + n.length, rconPort: 1, rconPassword: 'x' });
    db.prepare("UPDATE servers SET status = 'idle' WHERE id = ?").run(id);
  }
});
afterEach(async () => { await app.close(); });

const call = (method: 'GET' | 'POST', url: string, as?: string, payload?: object) =>
  app.inject({ method, url, cookies: as ? cookies[as] : undefined, payload });

const discordOf = (steamid: string) => `d${steamid.slice(-4)}`;

const postBody = (over: object = {}) => ({
  startsAt: START, minutes: 90, campaigns: ['no_mercy', 'death_toll'], srRange: null, note: '', ...over,
});
/** Posts as `as` and returns the new post's id. */
const post = async (as: string, over: object = {}): Promise<number> => {
  const r = await call('POST', '/api/scrims', as, postBody(over));
  expect(r.statusCode).toBe(201);
  return r.json().id as number;
};
const accept = async (postId: number, as: string, over: object = {}) => {
  const r = await call('POST', `/api/scrims/${postId}/accept`, as, over);
  expect(r.statusCode).toBe(200);
  return r.json().id as number;
};
const team = (captain: string, name: string, tag: string, cocaptains: string[] = []): number => {
  const t = createTeam(db, { creator: captain, name, tag, now: NOW });
  if (!t.ok) throw new Error(t.error);
  for (const m of cocaptains) {
    const inv = invitePlayer(db, { teamId: t.value.id, by: captain, target: m, now: NOW });
    if (!inv.ok) throw new Error(inv.error);
    respondInvite(db, { inviteId: inv.value.inviteId, steamid: m, accept: true, now: NOW });
    setRole(db, { teamId: t.value.id, by: captain, target: m, role: 'cocaptain' });
  }
  return t.value.id;
};

describe('the switch', () => {
  it('off hides every route from players; admins-only lets admins through, staff bypass extends to good standing only', async () => {
    setSetting(db, 'competitive_enabled', 'off');
    expect((await call('GET', '/api/scrims', P[0])).statusCode).toBe(404);
    expect((await call('GET', '/api/scrims/options', P[0])).statusCode).toBe(404);
    expect((await call('POST', '/api/scrims', P[0], postBody())).statusCode).toBe(404);

    setSetting(db, 'competitive_enabled', 'admins');
    expect((await call('GET', '/api/scrims', ADMIN)).statusCode).toBe(200);
    expect((await call('GET', '/api/scrims', MOD)).statusCode).toBe(200);
    expect((await call('GET', '/api/scrims', P[0])).statusCode).toBe(404);

    db.prepare("UPDATE players SET status = 'banned' WHERE steamid = ?").run(MOD);
    expect((await call('GET', '/api/scrims', MOD)).statusCode).toBe(404);
  });

  it('anonymous callers get 404, not 401, under every mode', async () => {
    expect((await call('GET', '/api/scrims')).statusCode).toBe(404);
    setSetting(db, 'competitive_enabled', 'off');
    expect((await call('GET', '/api/scrims')).statusCode).toBe(404);
  });
});

describe('rights', () => {
  it('withdraw and confirm are refused to anyone but the post\'s own manager', async () => {
    const id = await post(P[0]);
    const withdrawn = await call('POST', `/api/scrims/${id}/withdraw`, P[1]);
    expect(withdrawn.statusCode).toBe(403);
    expect(withdrawn.json().error).toBe('Only a captain or co-captain of that side can do that.');
    const acceptId = await accept(id, P[1]);
    const confirmed = await call('POST', `/api/scrims/accepts/${acceptId}/confirm`, P[2]);
    expect(confirmed.statusCode).toBe(403);
  });

  it('a non-integer id answers 404 rather than reaching the domain', async () => {
    expect((await call('POST', '/api/scrims/not-a-number/withdraw', P[0])).statusCode).toBe(404);
    expect((await call('POST', '/api/scrims/accepts/nope/decline', P[0])).statusCode).toBe(404);
  });
});

describe('post, accept, confirm: the booking and its notices', () => {
  it('options list campaigns, limits, the viewer\'s managed teams and live teams', async () => {
    const rats = team(P[0], 'Rats', 'RR');
    const r = (await call('GET', '/api/scrims/options', P[0])).json();
    expect(r.campaigns.map((c: { slug: string }) => c.slug)).toEqual(['no_mercy', 'death_toll', 'dead_air']);
    expect(r.limits).toMatchObject({ minMinutes: 60, maxMinutes: 180, playlistMax: 4, stepMinutes: 30 });
    expect(r.myTeams.map((t: { id: number }) => t.id)).toEqual([rats]);
    expect(r.teams.map((t: { id: number }) => t.id)).toEqual([rats]);
  });

  it('the board is a no-store read and lists an open post', async () => {
    const id = await post(P[0]);
    const r = await call('GET', '/api/scrims', P[1]);
    expect(r.headers['cache-control']).toBe('no-store');
    expect(r.json().posts.map((p: { id: number }) => p.id)).toEqual([id]);
  });

  it('accept tells the poster\'s managers (scrim_accepted), confirm tells both sides (scrim_booked) and the runner-style booking is visible on /api/bookings/:id, and a passed-over accepter is told scrim_taken', async () => {
    const id = await post(P[0]);
    const acceptId = await accept(id, P[1]);
    expect(dms).toHaveLength(1);
    expect(dms[0].to).toBe(discordOf(P[0]));
    expect(dms[0].content).toMatch(/accepted your scrim post/);

    const otherAcceptId = await accept(id, P[2]);
    expect(dms).toHaveLength(2);

    dms.length = 0;
    const confirmed = await call('POST', `/api/scrims/accepts/${acceptId}/confirm`, P[0]);
    expect(confirmed.statusCode).toBe(200);
    const bookingId = confirmed.json().bookingId as number;
    expect(typeof bookingId).toBe('number');

    const view = (await call('GET', `/api/bookings/${bookingId}`, P[0])).json();
    expect(view.sides[0].confirmed).toBe(true);
    expect(view.sides[1].confirmed).toBe(true);

    // scrim_booked to the poster and the chosen accepter, scrim_taken to the other.
    expect(dms).toHaveLength(3);
    const booked = dms.filter((d) => d.content.includes('Your scrim is booked'));
    expect(booked.map((d) => d.to).sort()).toEqual([discordOf(P[0]), discordOf(P[1])].sort());
    const taken = dms.filter((d) => d.content.includes('this acceptance is closed'));
    expect(taken).toHaveLength(1);
    expect(taken[0].to).toBe(discordOf(P[2]));

    // Booked: off the open board.
    expect((await call('GET', '/api/scrims', P[0])).json().posts).toEqual([]);
    expect(otherAcceptId).toBeTypeOf('number');
  });

  it('a confirm calls only the runner\'s allocate(), never onCreated/onConfirmed, and each side gets exactly one scrim_booked DM', async () => {
    const calls: string[] = [];
    const stubRunner = {
      onCreated: () => calls.push('onCreated'),
      onConfirmed: () => calls.push('onConfirmed'),
      allocate: () => calls.push('allocate'),
    } as unknown as BookingRunner;
    const notifier = new Notifier({ db, dm: () => async (to, p) => { dms.push({ to, content: p.content ?? '' }); } });
    const stubApp = Fastify();
    await stubApp.register(cookie, { secret: 'x'.repeat(32) });
    await stubApp.register(scrimRoutes, { db, runner: stubRunner, notifier, publicUrl: PUBLIC_URL });
    await stubApp.ready();

    const id = await post(P[0]);
    const acceptId = await accept(id, P[1]);
    dms.length = 0;
    const r = await stubApp.inject({ method: 'POST', url: `/api/scrims/accepts/${acceptId}/confirm`, cookies: cookies[P[0]] });
    expect(r.statusCode).toBe(200);
    // onCreated/onConfirmed would send booking_invite/booking_confirmed DMs
    // that are stale or duplicate here: the one notice is scrim_booked.
    expect(calls).toEqual(['allocate']);
    const booked = dms.filter((d) => d.content.includes('Your scrim is booked'));
    expect(booked.map((d) => d.to).sort()).toEqual([discordOf(P[0]), discordOf(P[1])].sort());
    expect(dms).toHaveLength(2);

    await stubApp.close();
  });

  it('a confirm still answers and still sends scrim_booked even when allocate() throws', async () => {
    const stubRunner = {
      onCreated: () => {},
      onConfirmed: () => {},
      allocate: () => { throw new Error('no idle box'); },
    } as unknown as BookingRunner;
    const notifier = new Notifier({ db, dm: () => async (to, p) => { dms.push({ to, content: p.content ?? '' }); } });
    const stubApp = Fastify();
    await stubApp.register(cookie, { secret: 'x'.repeat(32) });
    await stubApp.register(scrimRoutes, { db, runner: stubRunner, notifier, publicUrl: PUBLIC_URL });
    await stubApp.ready();

    const id = await post(P[0]);
    const acceptId = await accept(id, P[1]);
    dms.length = 0;
    const r = await stubApp.inject({ method: 'POST', url: `/api/scrims/accepts/${acceptId}/confirm`, cookies: cookies[P[0]] });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toHaveProperty('bookingId');
    const booked = dms.filter((d) => d.content.includes('Your scrim is booked'));
    expect(booked.map((d) => d.to).sort()).toEqual([discordOf(P[0]), discordOf(P[1])].sort());

    await stubApp.close();
  });

  it('a decline tells every current manager of that accepter\'s side (scrim_declined), not only its stored captain', async () => {
    const id = await post(P[0]);
    const mice = team(P[1], 'Mice', 'MM', [P[2]]);
    const acceptId = await accept(id, P[1], { teamId: mice });
    dms.length = 0;
    const r = await call('POST', `/api/scrims/accepts/${acceptId}/decline`, P[0]);
    expect(r.statusCode).toBe(200);
    expect(dms.map((d) => d.to).sort()).toEqual([discordOf(P[1]), discordOf(P[2])].sort());
    expect(dms[0].content).toMatch(/is closed: the poster declined it/);
  });

  it('withdrawing a post tells every current manager of each pending accepter\'s side (scrim_declined, "the post was withdrawn")', async () => {
    const id = await post(P[0]);
    const mice = team(P[1], 'Mice', 'MM', [P[2]]);
    await accept(id, P[1], { teamId: mice });
    dms.length = 0;
    const r = await call('POST', `/api/scrims/${id}/withdraw`, P[0]);
    expect(r.statusCode).toBe(200);
    expect(dms.map((d) => d.to).sort()).toEqual([discordOf(P[1]), discordOf(P[2])].sort());
    expect(dms[0].content).toMatch(/is closed: the post was withdrawn/);
  });

  it('withdrawing a post with no pending acceptance sends no notice', async () => {
    const id = await post(P[0]);
    dms.length = 0;
    const r = await call('POST', `/api/scrims/${id}/withdraw`, P[0]);
    expect(r.statusCode).toBe(200);
    expect(dms).toEqual([]);
  });

  it('a confirm offers the nearest slot inline when the capacity is gone by then, DMs nobody, and leaves the acceptance pending', async () => {
    const id = await post(P[0], { startsAt: START, minutes: 60 });
    const mice = team(P[1], 'Mice', 'MM', [P[2]]);
    const acceptId = await accept(id, P[1], { teamId: mice });
    for (const [a, b] of [[P[3], P[4]], [P[5], P[6]]]) {
      const r = createBooking(db, { by: a, opponent: { steamid: b }, startsAt: START, minutes: 60, playlist: ['no_mercy'], now: NOW });
      expect(r.ok).toBe(true);
    }
    dms.length = 0;
    const confirmed = await call('POST', `/api/scrims/accepts/${acceptId}/confirm`, P[0]);
    expect(confirmed.statusCode).toBe(409);
    expect(confirmed.json().error).toMatch(/not enough servers/i);
    expect(confirmed.json()).toHaveProperty('nearestSlot');
    const nearestSlot = confirmed.json().nearestSlot as string | null;
    expect(nearestSlot).toBeTruthy();

    // The poster already sees the nearestSlot right in this response; the
    // accepter is not DMed, and nothing closes their pending acceptance.
    expect(dms).toEqual([]);
    const board = (await call('GET', '/api/scrims', P[0])).json().posts as { id: number; accepts: { id: number }[] | null }[];
    expect(board.find((p) => p.id === id)?.accepts?.map((a) => a.id)).toEqual([acceptId]);
  });
});

describe('direct challenges', () => {
  it('a challenge is invisible to a stranger but notifies the target team\'s managers (scrim_challenge) and is visible to them', async () => {
    const rats = team(P[0], 'Rats', 'RR');
    const mice = team(P[1], 'Mice', 'MM', [P[2]]);
    dms.length = 0;
    const id = await post(P[0], { teamId: rats, targetTeamId: mice });

    // The captain and the co-captain of the target team both get the DM.
    expect(dms).toHaveLength(2);
    expect(dms.map((d) => d.to).sort()).toEqual([discordOf(P[1]), discordOf(P[2])].sort());
    expect(dms[0].content).toMatch(/challenges you to a scrim/);
    // The target has no decline action, only accept or let it pass.
    expect(dms[0].content).toMatch(/Accept it on the site, or let it pass\./);
    expect(dms[0].content).not.toMatch(/decline/i);

    // A stranger: 404 on every action, and it is absent from their board.
    expect((await call('GET', '/api/scrims', P[3])).json().posts).toEqual([]);
    expect((await call('POST', `/api/scrims/${id}/withdraw`, P[3])).statusCode).toBe(404);
    expect((await call('POST', `/api/scrims/${id}/accept`, P[3])).statusCode).toBe(404);

    // The target team's captain sees it and may accept as that team.
    expect((await call('GET', '/api/scrims', P[1])).json().posts.map((p: { id: number }) => p.id)).toEqual([id]);
    const acc = await call('POST', `/api/scrims/${id}/accept`, P[1], { teamId: mice });
    expect(acc.statusCode).toBe(200);
  });

  it('DMs only target managers who can use competitive play, under admins', async () => {
    const rats = team(P[0], 'Rats', 'RR');
    const mice = team(P[1], 'Mice', 'MM', [P[2]]);
    setSetting(db, 'competitive_enabled', 'admins');
    db.prepare("UPDATE players SET is_admin = 1 WHERE steamid = ?").run(P[0]);
    dms.length = 0;
    // Neither of Mice's managers is an admin: nobody is DMed.
    await post(P[0], { teamId: rats, targetTeamId: mice });
    expect(dms).toEqual([]);

    db.prepare("UPDATE players SET is_admin = 1 WHERE steamid = ?").run(P[1]);
    dms.length = 0;
    // Now P[1] can use the board: only P[1] is DMed, not the co-captain P[2].
    await post(P[0], { teamId: rats, targetTeamId: mice });
    expect(dms.map((d) => d.to)).toEqual([discordOf(P[1])]);
  });
});
