import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, type DB } from '../src/db.js';
import { loadConfig } from '../src/config.js';
import { buildServer } from '../src/server.js';
import { authedCookie, stubOrchestrator } from './helpers.js';
import { png } from './pngFixture.js';

const P = Array.from({ length: 6 }, (_, i) => `7656119900000020${i}`);
const ADMIN = '76561199000000290';
const MOD = '76561199000000291';

let db: DB;
let app: FastifyInstance;
let cookies: Record<string, Record<string, string>>;

beforeEach(async () => {
  db = openDb(':memory:');
  app = await buildServer({
    config: { ...loadConfig({}), communityDir: mkdtempSync(join(tmpdir(), 'teamroutes-')) },
    db, orchestrator: stubOrchestrator(), serverCleaner: async () => {}, serverExec: async () => {},
  });
  cookies = {};
  for (const id of [...P, ADMIN, MOD]) cookies[id] = authedCookie(app, db, id);
  db.prepare('UPDATE players SET is_admin = 1 WHERE steamid = ?').run(ADMIN);
  db.prepare('UPDATE players SET is_mod = 1 WHERE steamid = ?').run(MOD);
  P.forEach((id, i) => db.prepare('UPDATE players SET name = ? WHERE steamid = ?').run(`player${i}`, id));
  db.prepare("UPDATE settings SET value = 'everyone' WHERE key = 'competitive_enabled'").run();
});
afterEach(async () => { await app.close(); });

const call = (method: 'GET' | 'POST', url: string, as?: string, payload?: object) =>
  app.inject({ method, url, cookies: as ? cookies[as] : undefined, payload });
const create = async (as: string, name: string, tag: string) => {
  const r = await call('POST', '/api/teams', as, { name, tag });
  expect(r.statusCode).toBe(201);
  return r.json().slug as string;
};

describe('the switch', () => {
  it('off hides every route, admins-only lets admins through', async () => {
    db.prepare("UPDATE settings SET value = 'off' WHERE key = 'competitive_enabled'").run();
    expect((await call('GET', '/api/teams', ADMIN)).statusCode).toBe(404);
    expect((await call('POST', '/api/teams', ADMIN, { name: 'Rats', tag: 'RR' })).statusCode).toBe(404);
    db.prepare("UPDATE settings SET value = 'admins' WHERE key = 'competitive_enabled'").run();
    expect((await call('GET', '/api/teams', ADMIN)).statusCode).toBe(200);
    expect((await call('GET', '/api/teams', P[0])).statusCode).toBe(404);
    expect((await call('GET', '/api/teams')).statusCode).toBe(404);
  });

  it('/api/me says whether to show teams', async () => {
    expect((await call('GET', '/api/me', P[0])).json().teams).toBe(true);
    db.prepare("UPDATE settings SET value = 'off' WHERE key = 'competitive_enabled'").run();
    expect((await call('GET', '/api/me', P[0])).json().teams).toBe(false);
  });
});

describe('public team pages', () => {
  it('a signed-out visitor reads the list and a team page while the switch is everyone, not admins', async () => {
    const slug = await create(P[0], 'Rats', 'RR');
    expect((await call('GET', '/api/teams')).statusCode).toBe(200);
    expect((await call('GET', `/api/teams/${slug}`)).statusCode).toBe(200);
    expect((await call('POST', '/api/teams', undefined, { name: 'Mice', tag: 'MM' })).statusCode).toBe(404);
    db.prepare("UPDATE settings SET value = 'admins' WHERE key = 'competitive_enabled'").run();
    expect((await call('GET', '/api/teams')).statusCode).toBe(404);
    expect((await call('GET', `/api/teams/${slug}`)).statusCode).toBe(404);
  });
});

describe('create, invite, accept, page', () => {
  it('runs the whole flow and the page shows what each viewer may see', async () => {
    const slug = await create(P[0], 'Riverside Rats', 'RR');
    expect((await call('POST', '/api/teams', P[1], { name: 'riverside rats', tag: 'XX' })).statusCode).toBe(409);

    const inv = await call('POST', `/api/teams/${slug}/invites`, P[0], { steamid: P[1] });
    expect(inv.statusCode).toBe(201);
    const mine = (await call('GET', '/api/teams/mine', P[1])).json();
    expect(mine.invites).toMatchObject([{ slug, name: 'Riverside Rats', invitedByName: 'player0' }]);
    expect((await call('POST', `/api/teams/invites/${inv.json().inviteId}/accept`, P[2])).statusCode).toBe(404);
    expect((await call('POST', `/api/teams/invites/${inv.json().inviteId}/accept`, P[1])).json()).toEqual({ slug });

    const asCaptain = (await call('GET', `/api/teams/${slug}`, P[0])).json();
    expect(asCaptain.members.map((m: { steamid: string; role: string }) => [m.steamid, m.role])).toEqual([[P[0], 'captain'], [P[1], 'member']]);
    expect(asCaptain.viewer).toEqual({ role: 'captain', staff: false });
    expect(asCaptain.manage).toEqual({ invites: [], joinLinkToken: null });

    const asMember = (await call('GET', `/api/teams/${slug}`, P[1])).json();
    expect(asMember.manage).toBeNull();
    const asStranger = (await call('GET', `/api/teams/${slug}`, P[3])).json();
    expect(asStranger.viewer).toEqual({ role: null, staff: false });
    expect(asStranger.manage).toBeNull();
    expect((await call('GET', '/api/teams/no-such-team', P[3])).statusCode).toBe(404);

    expect((await call('GET', '/api/teams', P[3])).json().teams).toEqual([{ slug, name: 'Riverside Rats', tag: 'RR', logoKey: null, members: 2, captainName: 'player0' }]);
  });

  it('player search finds active players by name prefix, at least two characters', async () => {
    expect((await call('GET', '/api/teams/player-search?q=p', P[0])).json().players).toEqual([]);
    const found = (await call('GET', '/api/teams/player-search?q=PLAYER1', P[0])).json().players;
    expect(found.map((p: { steamid: string }) => p.steamid)).toEqual([P[1]]);
    db.prepare("UPDATE players SET status = 'banned' WHERE steamid = ?").run(P[1]);
    expect((await call('GET', '/api/teams/player-search?q=player1', P[0])).json().players).toEqual([]);
  });
});

describe('join link', () => {
  it('the captain sees the token, a co-captain does not, a player joins with it', async () => {
    const slug = await create(P[0], 'Rats', 'RR');
    const tok = (await call('POST', `/api/teams/${slug}/join-link`, P[0], { on: true })).json().token as string;
    expect((await call('GET', `/api/teams/join/${tok}`, P[2])).json()).toEqual({ slug, name: 'Rats', tag: 'RR', logoKey: null, members: 1, captainName: 'player0' });
    expect((await call('POST', `/api/teams/join/${tok}`, P[2])).json()).toEqual({ slug });
    db.prepare("UPDATE team_members SET role = 'cocaptain' WHERE steamid = ?").run(P[2]);
    expect((await call('GET', `/api/teams/${slug}`, P[2])).json().manage.joinLinkToken).toBeNull();
    expect((await call('GET', `/api/teams/${slug}`, P[0])).json().manage.joinLinkToken).toBe(tok);
    await call('POST', `/api/teams/${slug}/join-link`, P[0], { on: false });
    expect((await call('GET', `/api/teams/join/${tok}`, P[3])).statusCode).toBe(404);
  });
});

describe('staff', () => {
  it('a staff no-op (captain already captain, rename to the same name) is not audited', async () => {
    const slug = await create(P[0], 'Rats', 'RR');
    expect((await call('POST', `/api/teams/${slug}/captain`, MOD, { steamid: P[0] })).statusCode).toBe(200);
    expect((await call('POST', `/api/teams/${slug}/rename`, MOD, { name: 'Rats', tag: 'RR' })).statusCode).toBe(200);
    expect(db.prepare("SELECT COUNT(*) AS n FROM admin_actions WHERE action LIKE 'team_%'").get()).toEqual({ n: 0 });
  });

  it('player search leaves out banned players', async () => {
    db.prepare("INSERT INTO bans (player_id, reason, created_by, created_at) VALUES (?, 'x', ?, '2026-09-01T00:00:00.000Z')").run(P[2], ADMIN);
    const names = (await call('GET', '/api/teams/player-search?q=player', P[0])).json().players.map((p: { name: string }) => p.name);
    expect(names).toContain('player1');
    expect(names).not.toContain('player2');
  });

  it('a mod renames and disbands a team they are not on, and both land in the audit log', async () => {
    const slug = await create(P[0], 'Rats', 'RR');
    expect((await call('POST', `/api/teams/${slug}/rename`, P[1], { name: 'Nope' })).statusCode).toBe(403);
    expect((await call('POST', `/api/teams/${slug}/rename`, MOD, { name: 'Clean Name' })).json()).toEqual({ name: 'Clean Name', tag: 'RR' });
    expect((await call('POST', `/api/teams/${slug}/disband`, MOD)).statusCode).toBe(200);
    expect(db.prepare("SELECT admin_id, action FROM admin_actions WHERE action LIKE 'team_%' ORDER BY id").all())
      .toEqual([{ admin_id: MOD, action: 'team_rename' }, { admin_id: MOD, action: 'team_disband' }]);
    expect((await call('GET', `/api/teams/${slug}`, P[3])).json().disbandedAt).not.toBeNull();
  });

  it('a captain renaming their own team is not audited', async () => {
    const slug = await create(P[0], 'Rats', 'RR');
    await call('POST', `/api/teams/${slug}/rename`, P[0], { tag: 'RT' });
    expect(db.prepare("SELECT COUNT(*) AS n FROM admin_actions WHERE action LIKE 'team_%'").get()).toEqual({ n: 0 });
  });

  it('a captain handing captaincy to a member leaves no team_% row', async () => {
    const slug = await create(P[0], 'Rats', 'RR');
    const inv = await call('POST', `/api/teams/${slug}/invites`, P[0], { steamid: P[1] });
    await call('POST', `/api/teams/invites/${inv.json().inviteId}/accept`, P[1]);
    expect((await call('POST', `/api/teams/${slug}/captain`, P[0], { steamid: P[1] })).statusCode).toBe(200);
    expect(db.prepare("SELECT COUNT(*) AS n FROM admin_actions WHERE action LIKE 'team_%'").get()).toEqual({ n: 0 });
  });

  it('a mod transferring captaincy on a team they are not on records one team_captain row', async () => {
    const slug = await create(P[0], 'Rats', 'RR');
    const inv = await call('POST', `/api/teams/${slug}/invites`, P[0], { steamid: P[1] });
    await call('POST', `/api/teams/invites/${inv.json().inviteId}/accept`, P[1]);
    expect((await call('POST', `/api/teams/${slug}/captain`, MOD, { steamid: P[1] })).statusCode).toBe(200);
    expect(db.prepare("SELECT admin_id, action FROM admin_actions WHERE action LIKE 'team_%'").all())
      .toEqual([{ admin_id: MOD, action: 'team_captain' }]);
  });
});

describe('logo', () => {
  it('a captain uploads a 256 px PNG; it is served; anything else is refused', async () => {
    const slug = await create(P[0], 'Rats', 'RR');
    const bad = await call('POST', `/api/teams/${slug}/logo`, P[0], { png: png(64, 64).toString('base64') });
    expect(bad.statusCode).toBe(400);
    const good = await call('POST', `/api/teams/${slug}/logo`, P[0], { png: png(256, 256).toString('base64') });
    expect(good.statusCode).toBe(200);
    const key = good.json().logoKey as string;
    expect((await call('GET', `/api/teams/${slug}`, P[3])).json().logoKey).toBe(key);
    const file = await call('GET', `/api/teams/logos/${key}.png`, P[3]);
    expect(file.statusCode).toBe(200);
    expect(file.headers['content-type']).toBe('image/png');
    expect((await call('GET', `/api/teams/logos/${key}.png`)).statusCode).toBe(200);
    expect((await call('GET', `/api/teams/logos/${'b'.repeat(64)}.png`, P[3])).statusCode).toBe(404);
    expect((await call('POST', `/api/teams/${slug}/logo`, P[3], { png: png(256, 256).toString('base64') })).statusCode).toBe(403);
  });

  it('a co-captain uploading a logo records no team_% row', async () => {
    const slug = await create(P[0], 'Rats', 'RR');
    const inv = await call('POST', `/api/teams/${slug}/invites`, P[0], { steamid: P[1] });
    await call('POST', `/api/teams/invites/${inv.json().inviteId}/accept`, P[1]);
    db.prepare("UPDATE team_members SET role = 'cocaptain' WHERE steamid = ?").run(P[1]);
    expect((await call('POST', `/api/teams/${slug}/logo`, P[1], { png: png(256, 256).toString('base64') })).statusCode).toBe(200);
    expect(db.prepare("SELECT COUNT(*) AS n FROM admin_actions WHERE action LIKE 'team_%'").get()).toEqual({ n: 0 });
  });

  it('a mod uploading a logo to a team they are not on records one team_logo row', async () => {
    const slug = await create(P[0], 'Rats', 'RR');
    expect((await call('POST', `/api/teams/${slug}/logo`, MOD, { png: png(256, 256).toString('base64') })).statusCode).toBe(200);
    expect(db.prepare("SELECT admin_id, action FROM admin_actions WHERE action LIKE 'team_%'").all())
      .toEqual([{ admin_id: MOD, action: 'team_logo' }]);
  });
});

describe('leave and kick over HTTP', () => {
  it('the captain leaving hands over; the last one out disbands', async () => {
    const slug = await create(P[0], 'Rats', 'RR');
    const tok = (await call('POST', `/api/teams/${slug}/join-link`, P[0], { on: true })).json().token as string;
    await call('POST', `/api/teams/join/${tok}`, P[1]);
    expect((await call('POST', `/api/teams/${slug}/leave`, P[0])).json()).toEqual({ disbanded: false, captain: P[1] });
    expect((await call('POST', `/api/teams/${slug}/members/${P[1]}/kick`, P[1])).statusCode).toBe(400);
    expect((await call('POST', `/api/teams/${slug}/leave`, P[1])).json()).toEqual({ disbanded: true, captain: null });
  });
});
