import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { openDb, type DB } from '../src/db.js';
import { loadConfig } from '../src/config.js';
import { buildServer } from '../src/server.js';
import { authedCookie, stubOrchestrator } from './helpers.js';
import { createLinkCode, getPlayer, linkDiscord, unlinkDiscord, upsertPlayer } from '../src/players.js';
import { banPlayer, publicBans } from '../src/admin/players.js';
import { hasActiveBan } from '../src/banState.js';
import { mergePlayers } from '../src/mergePlayers.js';
import { subscribeAdminEvents, type AdminEvent } from '../src/adminFeed.js';
import { subscribeBanChanges } from '../src/banEvents.js';
import { fakeDiscordApi } from './fakes/fakeDiscordApi.js';

// Owner ruling 2026-10-03: a Discord arriving from another Steam account puts
// the new account on hold at once; a moderator lifts it after the appeal.
const OLD = '76561198000000001';
const NEW = '76561198000000002';
const THIRD = '76561198000000003';
const MOD = '76561198000000008';
const ADMIN = '76561198000000009';

let db: DB;
let app: FastifyInstance;
let events: AdminEvent[];
let off: () => void;

beforeEach(async () => {
  db = openDb(':memory:');
  app = await buildServer({
    config: loadConfig({
      PUBLIC_URL: 'https://pug.test',
      DISCORD_CLIENT_ID: 'cid', DISCORD_CLIENT_SECRET: 'secret', DISCORD_BOT_TOKEN: 'bot', DISCORD_GUILD_ID: 'guild',
    }),
    db, orchestrator: stubOrchestrator(),
    discordApi: fakeDiscordApi({ users: {}, members: {} }),
    serverExec: async () => {}, serverCleaner: async () => {},
  });
  upsertPlayer(db, { steamid: OLD, name: 'telltale', avatar: null }, []);
  authedCookie(app, db, MOD);
  authedCookie(app, db, ADMIN);
  db.prepare('UPDATE players SET is_mod = 1 WHERE steamid = ?').run(MOD);
  db.prepare('UPDATE players SET is_admin = 1 WHERE steamid = ?').run(ADMIN);
  events = [];
  off = subscribeAdminEvents((e) => { if (e.kind === 'alt') events.push(e); });
});
afterEach(async () => { off(); await app.close(); });

/** `steamid` links Discord 111 through the link-code route, as a player would. */
async function linkAs(steamid: string, discordId = '111', name = 'dethisa') {
  const cookies = authedCookie(app, db, steamid, { active: false });
  const code = createLinkCode(db, discordId, name);
  return app.inject({ method: 'POST', url: '/api/discord/link-code', cookies, payload: { code } });
}

/** OLD held Discord 111 and let it go. */
function oldHadIt() {
  linkDiscord(db, OLD, '111', 'dethisa');
  unlinkDiscord(db, OLD);
}

const holds = () => db.prepare('SELECT * FROM alt_holds ORDER BY id').all() as {
  id: number; steamid: string; other_steamid: string; resolution: string | null; ban_id: number;
}[];
const as = (who: string) => authedCookie(app, db, who);

describe('alt holds', () => {
  it('a Discord moving to a new Steam account puts the new one on hold', async () => {
    oldHadIt();
    expect((await linkAs(NEW)).statusCode).toBe(200);
    expect(holds()).toMatchObject([{ steamid: NEW, other_steamid: OLD, resolution: null }]);
    expect(hasActiveBan(db, NEW)).toBe(true);
    expect(getPlayer(db, NEW)?.status).toBe('banned');
    expect(events).toMatchObject([{ kind: 'alt', what: 'hold', steamid: NEW, otherSteamid: OLD }]);
  });

  it('holds however long ago the Discord moved: there is no window', async () => {
    linkDiscord(db, OLD, '111', 'dethisa', { now: new Date('2026-01-01') });
    unlinkDiscord(db, OLD, OLD, new Date('2026-01-02'));
    await linkAs(NEW);
    expect(holds()).toHaveLength(1);
  });

  it('a first link, and relinking your own Discord, hold nothing', async () => {
    await linkAs(NEW);
    unlinkDiscord(db, NEW);
    await linkAs(NEW);
    expect(holds()).toHaveLength(0);
    expect(events).toHaveLength(0);
  });

  it('the hold is off the public ban list, and the player is told it is a hold', async () => {
    oldHadIt();
    await linkAs(NEW);
    expect(publicBans(db, '')).toHaveLength(0);
    const me = (await app.inject({ method: 'GET', url: '/api/me', cookies: authedCookie(app, db, NEW, { active: false }) })).json();
    expect(me.ban).toMatchObject({ hold: true });
    expect(me.ban.reason).toContain('telltale');
  });

  it('tells the game servers, like a ban', async () => {
    const seen: string[] = [];
    const stop = subscribeBanChanges((e) => seen.push(`${e.kind}:${e.steamid}`));
    try {
      oldHadIt();
      await linkAs(NEW);
    } finally { stop(); }
    expect(seen).toEqual([`ban:${NEW}`]);
  });

  it('a Steam account swapping to a different Discord is reported, never held', async () => {
    upsertPlayer(db, { steamid: NEW, name: 'new', avatar: null }, []);
    linkDiscord(db, NEW, '222', 'first');
    unlinkDiscord(db, NEW);
    await linkAs(NEW, '333', 'second');
    expect(holds()).toHaveLength(0);
    expect(events).toMatchObject([{ kind: 'alt', what: 'discord_swap', steamid: NEW, previousDiscordName: 'first' }]);
  });

  it('a staff account is reported, not held', async () => {
    oldHadIt();
    authedCookie(app, db, NEW);
    db.prepare('UPDATE players SET is_mod = 1 WHERE steamid = ?').run(NEW);
    await linkAs(NEW);
    expect(holds()).toHaveLength(0);
    expect(events).toMatchObject([{ what: 'moved' }]);
  });

  it('the Alts tab lists the hold for a moderator, and a moderator can lift it', async () => {
    oldHadIt();
    await linkAs(NEW);
    const list = (await app.inject({ method: 'GET', url: '/api/admin/people/alts', cookies: as(MOD) })).json();
    expect(list.open).toMatchObject([{ steamid: NEW, otherSteamid: OLD, name: `p${NEW.slice(-3)}`, otherName: 'telltale' }]);
    expect(list.clusters[0]).toMatchObject({ hasOpenHold: true, strong: true });
    expect(list.clusters[0].members.map((m: { steamid: string }) => m.steamid).sort()).toEqual([OLD, NEW]);

    const id = list.open[0].id;
    const res = await app.inject({ method: 'POST', url: `/api/admin/people/alts/${id}/lift`, cookies: as(MOD) });
    expect(res.statusCode).toBe(200);
    expect(hasActiveBan(db, NEW)).toBe(false);
    expect(getPlayer(db, NEW)?.status).not.toBe('banned');
    expect(holds()[0].resolution).toBe('cleared');
    // Settled twice is refused.
    expect((await app.inject({ method: 'POST', url: `/api/admin/people/alts/${id}/lift`, cookies: as(MOD) })).statusCode).toBe(409);
  });

  it('a cleared pair is never held again', async () => {
    oldHadIt();
    await linkAs(NEW);
    await app.inject({ method: 'POST', url: `/api/admin/people/alts/${holds()[0].id}/lift`, cookies: as(MOD) });
    // The Discord goes back to OLD and returns to NEW.
    unlinkDiscord(db, NEW);
    linkDiscord(db, OLD, '111', 'dethisa');
    unlinkDiscord(db, OLD);
    await linkAs(NEW);
    expect(holds()).toHaveLength(1);
    expect(hasActiveBan(db, NEW)).toBe(false);
  });

  it('lifting a hold leaves any other ban in force', async () => {
    oldHadIt();
    await linkAs(NEW);
    banPlayer(db, NEW, ADMIN, 'toxic', null);
    await app.inject({ method: 'POST', url: `/api/admin/people/alts/${holds()[0].id}/lift`, cookies: as(MOD) });
    expect(hasActiveBan(db, NEW)).toBe(true);
    expect(getPlayer(db, NEW)?.status).toBe('banned');
  });

  it('only an admin turns a hold into a public ban', async () => {
    oldHadIt();
    await linkAs(NEW);
    const id = holds()[0].id;
    expect((await app.inject({ method: 'POST', url: `/api/admin/people/alts/${id}/ban`, cookies: as(MOD) })).statusCode).toBe(404);
    const res = await app.inject({ method: 'POST', url: `/api/admin/people/alts/${id}/ban`, cookies: as(ADMIN), payload: {} });
    expect(res.statusCode).toBe(200);
    expect(holds()[0].resolution).toBe('banned');
    expect(hasActiveBan(db, NEW)).toBe(true);
    expect(publicBans(db, '')).toMatchObject([{ steamid: NEW, reason: 'Alt account of telltale', permanent: true, active: true }]);
  });

  it('merging the held account into the old one ends the hold and does not lock the main out', async () => {
    oldHadIt();
    await linkAs(NEW);
    mergePlayers(db, { from: NEW, into: OLD, by: ADMIN });
    expect(holds()[0].resolution).toBe('merged');
    expect(hasActiveBan(db, OLD)).toBe(false);
  });

  it('a held account cannot pass its Discord on to a third one', async () => {
    oldHadIt();
    await linkAs(NEW);
    // The unlink route refuses while held; even a forced unlink does not help,
    // because a Discord last held by a banned account cannot be linked.
    expect((await app.inject({ method: 'POST', url: '/api/discord/unlink', cookies: authedCookie(app, db, NEW, { active: false }) })).statusCode).toBe(409);
    unlinkDiscord(db, NEW);
    const res = await linkAs(THIRD);
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('discord_banned');
  });

  it('a lifted account that later hands its Discord on holds the next one', async () => {
    oldHadIt();
    await linkAs(NEW);
    await app.inject({ method: 'POST', url: `/api/admin/people/alts/${holds()[0].id}/lift`, cookies: as(MOD) });
    unlinkDiscord(db, NEW);
    await linkAs(THIRD);
    expect(holds().map((h) => [h.steamid, h.other_steamid])).toEqual([[NEW, OLD], [THIRD, NEW]]);
  });

  it('groups accounts on a shared connection, marked as the weak signal it is', async () => {
    const seen = db.prepare(
      "INSERT INTO player_networks (player_id, ip_hash, country, first_seen, last_seen, seen_count) VALUES (?, 'h1', 'US', '2026-10-01', '2026-10-02', 1)",
    );
    seen.run(OLD);
    seen.run(THIRD);
    const list = (await app.inject({ method: 'GET', url: '/api/admin/people/alts', cookies: as(MOD) })).json();
    expect(list.clusters).toMatchObject([{ strong: false, hasOpenHold: false, edges: [{ signal: 'connection' }] }]);
  });

  it('is staff only', async () => {
    const player = authedCookie(app, db, THIRD);
    expect((await app.inject({ method: 'GET', url: '/api/admin/people/alts', cookies: player })).statusCode).toBe(403);
    expect((await app.inject({ method: 'POST', url: '/api/admin/people/alts/1/lift', cookies: player })).statusCode).toBe(403);
  });
});
