import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { openDb, type DB } from '../src/db.js';
import { loadConfig } from '../src/config.js';
import { buildServer } from '../src/server.js';
import { getPlayer, linkDiscord, createLinkCode, upsertPlayer } from '../src/players.js';
import { authedCookie, stubOrchestrator } from './helpers.js';
import { fakeDiscordApi } from './fakes/fakeDiscordApi.js';

const P1 = '76561198000000001';
const P2 = '76561198000000002';
const DISCORD_ENV = {
  PUBLIC_URL: 'https://pug.test',
  DISCORD_CLIENT_ID: 'cid', DISCORD_CLIENT_SECRET: 'secret', DISCORD_BOT_TOKEN: 'bot', DISCORD_GUILD_ID: 'guild',
};

let db: DB;
let app: FastifyInstance;

async function build(env: Record<string, string>, api = fakeDiscordApi({
  users: { good: { id: '111', username: 'alice', globalName: 'Alice' } },
  members: { '111': [] },
})) {
  db = openDb(':memory:');
  app = await buildServer({
    config: loadConfig(env), db, orchestrator: stubOrchestrator(),
    verifyLogin: async () => P1,
    fetchPersona: async () => ({ name: 'alice', avatar: null }),
    discordApi: api,
    serverExec: async () => {},
  });
}

afterEach(async () => { await app.close(); });

describe('discord auth, unconfigured', () => {
  beforeEach(() => build({}));
  it('every discord route 404s', async () => {
    const cookies = authedCookie(app, db, P1);
    expect((await app.inject({ method: 'GET', url: '/auth/discord', cookies })).statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: '/auth/discord/callback?code=x&state=y', cookies })).statusCode).toBe(404);
    expect((await app.inject({ method: 'POST', url: '/api/discord/link-code', cookies, payload: { code: 'x' } })).statusCode).toBe(404);
    expect((await app.inject({ method: 'POST', url: '/api/discord/unlink', cookies })).statusCode).toBe(404);
  });
  it('/api/me reports discord disabled', async () => {
    const cookies = authedCookie(app, db, P1);
    const me = (await app.inject({ method: 'GET', url: '/api/me', cookies })).json();
    expect(me.discordEnabled).toBe(false);
    expect(me.discord).toBeNull();
  });
});

describe('discord auth, configured', () => {
  beforeEach(() => build(DISCORD_ENV));

  it('authorize needs a session', async () => {
    expect((await app.inject({ method: 'GET', url: '/auth/discord' })).statusCode).toBe(401);
  });

  it('authorize redirects to discord with client id, redirect uri and a state', async () => {
    const cookies = authedCookie(app, db, P1, { active: false });
    const res = await app.inject({ method: 'GET', url: '/auth/discord', cookies });
    expect(res.statusCode).toBe(302);
    const url = new URL(res.headers.location as string);
    expect(url.origin + url.pathname).toBe('https://discord.com/oauth2/authorize');
    expect(url.searchParams.get('client_id')).toBe('cid');
    expect(url.searchParams.get('redirect_uri')).toBe('https://pug.test/auth/discord/callback');
    expect(url.searchParams.get('scope')).toBe('identify');
    expect(url.searchParams.get('state')).toBeTruthy();
  });

  async function stateFor(cookies: Record<string, string>): Promise<string> {
    const res = await app.inject({ method: 'GET', url: '/auth/discord', cookies });
    return new URL(res.headers.location as string).searchParams.get('state')!;
  }

  it('callback with a bad state is rejected and links nothing', async () => {
    const cookies = authedCookie(app, db, P1, { active: false });
    const res = await app.inject({ method: 'GET', url: '/auth/discord/callback?code=good&state=forged:123', cookies });
    expect(res.statusCode).toBe(400);
    expect(getPlayer(db, P1)?.discord_id).toBeNull();
  });

  it('a state minted for another session does not work', async () => {
    const other = authedCookie(app, db, P2, { active: false });
    const state = await stateFor(other);
    const cookies = authedCookie(app, db, P1, { active: false });
    const res = await app.inject({ method: 'GET', url: `/auth/discord/callback?code=good&state=${encodeURIComponent(state)}`, cookies });
    expect(res.statusCode).toBe(400);
  });

  it('callback links the account, activates a guild member and returns to the profile', async () => {
    const cookies = authedCookie(app, db, P1, { active: false });
    const state = await stateFor(cookies);
    const res = await app.inject({ method: 'GET', url: `/auth/discord/callback?code=good&state=${encodeURIComponent(state)}`, cookies });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe(`/player/${P1}?discord=linked`);
    const p = getPlayer(db, P1)!;
    expect(p.discord_id).toBe('111');
    expect(p.discord_name).toBe('Alice');
    expect(p.status).toBe('active');
  });

  it('callback for an account linked elsewhere redirects with taken and changes nothing', async () => {
    upsertPlayer(db, { steamid: P2, name: 'bob', avatar: null }, []);
    linkDiscord(db, P2, '111', 'Alice');
    const cookies = authedCookie(app, db, P1, { active: false });
    const state = await stateFor(cookies);
    const res = await app.inject({ method: 'GET', url: `/auth/discord/callback?code=good&state=${encodeURIComponent(state)}`, cookies });
    expect(res.headers.location).toBe(`/player/${P1}?discord=taken`);
    expect(getPlayer(db, P1)?.discord_id).toBeNull();
  });

  it('callback where Discord refuses the code redirects with failed', async () => {
    const cookies = authedCookie(app, db, P1, { active: false });
    const state = await stateFor(cookies);
    const res = await app.inject({ method: 'GET', url: `/auth/discord/callback?code=bad&state=${encodeURIComponent(state)}`, cookies });
    expect(res.headers.location).toBe(`/player/${P1}?discord=failed`);
  });

  it('link-code links, activates, and cannot be reused', async () => {
    const cookies = authedCookie(app, db, P1, { active: false });
    const code = createLinkCode(db, '111', 'Alice');
    const res = await app.inject({ method: 'POST', url: '/api/discord/link-code', cookies, payload: { code } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, active: true, discordName: 'Alice' });
    expect(getPlayer(db, P1)?.discord_id).toBe('111');
    const again = await app.inject({ method: 'POST', url: '/api/discord/link-code', cookies, payload: { code } });
    expect(again.statusCode).toBe(400);
    expect(again.json().error).toBe('invalid_code');
  });

  it('link-code for a taken account is 409', async () => {
    upsertPlayer(db, { steamid: P2, name: 'bob', avatar: null }, []);
    linkDiscord(db, P2, '111', 'Alice');
    const cookies = authedCookie(app, db, P1, { active: false });
    const code = createLinkCode(db, '111', 'Alice');
    const res = await app.inject({ method: 'POST', url: '/api/discord/link-code', cookies, payload: { code } });
    expect(res.statusCode).toBe(409);
  });

  it('a pending link code can be read without spending it, so the page can ask first', async () => {
    const cookies = authedCookie(app, db, P1, { active: false });
    const code = createLinkCode(db, '111', 'Alice');
    const peek = await app.inject({ method: 'GET', url: `/api/discord/link-code?code=${code}`, cookies });
    expect(peek.statusCode).toBe(200);
    expect(peek.json()).toEqual({ discordId: '111', discordName: 'Alice' });
    // Reading it changed nothing, and it still works afterwards.
    expect(getPlayer(db, P1)?.discord_id).toBeNull();
    const res = await app.inject({ method: 'POST', url: '/api/discord/link-code', cookies, payload: { code } });
    expect(res.statusCode).toBe(200);
    const spent = await app.inject({ method: 'GET', url: `/api/discord/link-code?code=${code}`, cookies });
    expect(spent.statusCode).toBe(400);
    expect(spent.json().error).toBe('invalid_code');
  });

  it('reading a link code needs a session and a real code', async () => {
    const code = createLinkCode(db, '111', 'Alice');
    expect((await app.inject({ method: 'GET', url: `/api/discord/link-code?code=${code}` })).statusCode).toBe(401);
    const cookies = authedCookie(app, db, P1, { active: false });
    expect((await app.inject({ method: 'GET', url: '/api/discord/link-code?code=nope', cookies })).statusCode).toBe(400);
  });

  // The hijack: the attacker asks the bot for a code for HIS Discord and sends
  // the victim the URL. It must never replace the Discord the victim has.
  it('link-code refuses to replace a different Discord the account already has, and keeps the code', async () => {
    const cookies = authedCookie(app, db, P1);
    linkDiscord(db, P1, '111', 'Alice');
    const code = createLinkCode(db, '666', 'Mallory');
    const res = await app.inject({ method: 'POST', url: '/api/discord/link-code', cookies, payload: { code } });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('already_linked');
    expect(getPlayer(db, P1)?.discord_id).toBe('111');
    expect(getPlayer(db, P1)?.discord_name).toBe('Alice');
    // Not spent: after unlinking, the same link still works.
    const row = db.prepare('SELECT used_at FROM discord_link_codes WHERE code = ?').get(code) as { used_at: string | null };
    expect(row.used_at).toBeNull();
  });

  it('the OAuth callback refuses to replace a different Discord too', async () => {
    const cookies = authedCookie(app, db, P1);
    linkDiscord(db, P1, '999', 'Old');
    const state = await stateFor(cookies);
    const res = await app.inject({ method: 'GET', url: `/auth/discord/callback?code=good&state=${encodeURIComponent(state)}`, cookies });
    expect(res.headers.location).toBe(`/player/${P1}?discord=already_linked`);
    expect(getPlayer(db, P1)?.discord_id).toBe('999');
  });

  it('link-code needs a session', async () => {
    const code = createLinkCode(db, '111', 'Alice');
    expect((await app.inject({ method: 'POST', url: '/api/discord/link-code', payload: { code } })).statusCode).toBe(401);
  });

  it('unlink clears the link', async () => {
    const cookies = authedCookie(app, db, P1);
    linkDiscord(db, P1, '111', 'Alice');
    expect((await app.inject({ method: 'POST', url: '/api/discord/unlink', cookies })).statusCode).toBe(200);
    expect(getPlayer(db, P1)?.discord_id).toBeNull();
  });

  // The Discord account is the anchor that makes "one person, one account"
  // enforceable. Letting it go at will, while banned above all, lets one
  // Discord serve any number of Steam accounts in sequence.
  it('unlink is refused while banned, and the link stays', async () => {
    const { banPlayer } = await import('../src/admin/players.js');
    const cookies = authedCookie(app, db, P1);
    linkDiscord(db, P1, '111', 'Alice');
    banPlayer(db, P1, P2, 'griefing', 60);
    const res = await app.inject({ method: 'POST', url: '/api/discord/unlink', cookies });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toMatch(/banned/);
    expect(getPlayer(db, P1)?.discord_id).toBe('111');
  });

  it('unlink is refused during a queue timeout', async () => {
    const { recordPenalty } = await import('../src/penalties.js');
    const cookies = authedCookie(app, db, P1);
    linkDiscord(db, P1, '111', 'Alice');
    recordPenalty(db, P1, 'ready_fail', null);
    const res = await app.inject({ method: 'POST', url: '/api/discord/unlink', cookies });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toMatch(/timeout/);
    expect(getPlayer(db, P1)?.discord_id).toBe('111');
  });

  it('unlink is refused while queued, and works again after leaving', async () => {
    const cookies = authedCookie(app, db, P1);
    linkDiscord(db, P1, '111', 'Alice');
    expect((await app.inject({ method: 'POST', url: '/api/queue/join', cookies })).statusCode).toBe(200);
    const res = await app.inject({ method: 'POST', url: '/api/discord/unlink', cookies });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toMatch(/queue/);
    await app.inject({ method: 'POST', url: '/api/queue/leave', cookies });
    expect((await app.inject({ method: 'POST', url: '/api/discord/unlink', cookies })).statusCode).toBe(200);
  });

  it('unlink is refused while on the roster of a match that is being set up or played', async () => {
    const cookies = authedCookie(app, db, P1);
    linkDiscord(db, P1, '111', 'Alice');
    for (const state of ['configuring', 'live']) {
      const id = Number(db.prepare("INSERT INTO matches (season_id, state, campaign) VALUES (1, ?, 'dead_air')").run(state).lastInsertRowid);
      db.prepare("INSERT INTO match_players (match_id, player_id, team) VALUES (?, ?, 'a')").run(id, P1);
      const res = await app.inject({ method: 'POST', url: '/api/discord/unlink', cookies });
      expect(res.statusCode, state).toBe(409);
      expect(res.json().error).toMatch(/match/);
      db.prepare("UPDATE matches SET state = 'completed' WHERE id = ?").run(id);
    }
    expect((await app.inject({ method: 'POST', url: '/api/discord/unlink', cookies })).statusCode).toBe(200);
  });

  it('a Discord last held by a banned Steam account cannot be linked, and the code is kept', async () => {
    const { banPlayer } = await import('../src/admin/players.js');
    const { unlinkDiscord } = await import('../src/players.js');
    upsertPlayer(db, { steamid: P2, name: 'bob', avatar: null }, []);
    linkDiscord(db, P2, '111', 'Alice');
    unlinkDiscord(db, P2);
    banPlayer(db, P2, P1, 'cheating', null);
    const cookies = authedCookie(app, db, P1, { active: false });
    const code = createLinkCode(db, '111', 'Alice');
    const res = await app.inject({ method: 'POST', url: '/api/discord/link-code', cookies, payload: { code } });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('discord_banned');
    expect(getPlayer(db, P1)?.discord_id).toBeNull();
  });

  it('tells the admin feed when a Discord moves to a different Steam account inside 30 days', async () => {
    const { subscribeAdminEvents } = await import('../src/adminFeed.js');
    const { unlinkDiscord } = await import('../src/players.js');
    upsertPlayer(db, { steamid: P2, name: 'bob', avatar: null }, []);
    linkDiscord(db, P2, '111', 'Alice');
    unlinkDiscord(db, P2);
    const seen: string[] = [];
    const off = subscribeAdminEvents((e) => { if (e.kind === 'problem') seen.push(e.text); });
    try {
      const cookies = authedCookie(app, db, P1, { active: false });
      const code = createLinkCode(db, '111', 'Alice');
      await app.inject({ method: 'POST', url: '/api/discord/link-code', cookies, payload: { code } });
    } finally {
      off();
    }
    expect(seen).toHaveLength(1);
    expect(seen[0]).toContain(P1);
    expect(seen[0]).toContain(P2);
    expect(seen[0]).toContain('Alice');
  });

  it('/api/me carries the link', async () => {
    const cookies = authedCookie(app, db, P1);
    linkDiscord(db, P1, '111', 'Alice');
    const me = (await app.inject({ method: 'GET', url: '/api/me', cookies })).json();
    expect(me.discordEnabled).toBe(true);
    expect(me.discord).toEqual({ id: '111', name: 'Alice' });
  });

  it('/api/site reports the Discord requirement and invite link', async () => {
    const { setSetting } = await import('../src/settings.js');
    setSetting(db, 'discord_invite_url', 'https://discord.gg/abc');
    expect((await app.inject({ method: 'GET', url: '/api/site' })).json())
      .toEqual({ discordEnabled: true, discordInviteUrl: 'https://discord.gg/abc', requireDiscord: true });
  });

  it('an active player without Discord linked cannot join the queue over HTTP', async () => {
    const cookies = authedCookie(app, db, P1);
    const res = await app.inject({ method: 'POST', url: '/api/queue/join', cookies });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('link your Discord account first');
    linkDiscord(db, P1, '111', 'Alice');
    expect((await app.inject({ method: 'POST', url: '/api/queue/join', cookies })).statusCode).toBe(200);
  });

  it('steam login activates an invited player already linked to a guild member', async () => {
    upsertPlayer(db, { steamid: P1, name: 'alice', avatar: null }, []);
    linkDiscord(db, P1, '111', 'Alice');
    await app.inject({ method: 'GET', url: '/auth/steam/return?openid.mode=id_res' });
    expect(getPlayer(db, P1)?.status).toBe('active');
  });
});

describe('login return-to', () => {
  beforeEach(() => build({}));

  it('returns to a relative next path after steam login', async () => {
    const start = await app.inject({ method: 'GET', url: '/auth/steam?next=%2Flink%2Fdiscord%3Fcode%3Dabc' });
    const nextCookie = start.cookies.find((c) => c.name === 'pug_next');
    expect(nextCookie).toBeTruthy();
    const res = await app.inject({
      method: 'GET', url: '/auth/steam/return?openid.mode=id_res',
      cookies: { pug_next: nextCookie!.value },
    });
    expect(res.headers.location).toBe('/link/discord?code=abc');
  });

  it('ignores an absolute or protocol-relative next', async () => {
    for (const next of ['//evil.com/x', 'https://evil.com', '/\\evil.com']) {
      const start = await app.inject({ method: 'GET', url: `/auth/steam?next=${encodeURIComponent(next)}` });
      const c = start.cookies.find((x) => x.name === 'pug_next');
      const res = await app.inject({
        method: 'GET', url: '/auth/steam/return?openid.mode=id_res',
        cookies: c ? { pug_next: c.value } : {},
      });
      expect(res.headers.location).toBe('/');
    }
  });

  // A URL parser strips tab, CR and LF before it resolves anything, so
  // "/<tab>/evil.example" is "//evil.example" to a browser: another host.
  it('ignores a next that hides a second slash behind a control character', async () => {
    // The exploit, stated with the same parser a browser uses.
    expect(new URL('/\t/evil.example', 'https://pug.example').host).toBe('evil.example');
    for (const next of ['/\t/evil.example', '/\n/evil.example', '/\r/evil.example', '/\t\\evil.example', '/x\u0000y']) {
      const start = await app.inject({ method: 'GET', url: `/auth/steam?next=${encodeURIComponent(next)}` });
      expect(start.cookies.find((x) => x.name === 'pug_next'), JSON.stringify(next)).toBeUndefined();
    }
  });

  it('ignores a next that does not open with an ordinary path segment', async () => {
    for (const next of ['/.', '/../x', '/@evil.example', '/%09/evil.example', '/?x=1', '/#x']) {
      const start = await app.inject({ method: 'GET', url: `/auth/steam?next=${encodeURIComponent(next)}` });
      expect(start.cookies.find((x) => x.name === 'pug_next'), next).toBeUndefined();
    }
  });

  it('still accepts the paths the site really sends people back to', async () => {
    for (const next of ['/', '/match/12', '/link/discord?code=abc', '/player/76561198000000001', '/how-to-play']) {
      const start = await app.inject({ method: 'GET', url: `/auth/steam?next=${encodeURIComponent(next)}` });
      const c = start.cookies.find((x) => x.name === 'pug_next');
      expect(c, next).toBeTruthy();
      const res = await app.inject({
        method: 'GET', url: '/auth/steam/return?openid.mode=id_res',
        cookies: { pug_next: c!.value },
      });
      expect(res.headers.location).toBe(next);
    }
  });
});
