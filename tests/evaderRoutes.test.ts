import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { openDb, type DB } from '../src/db.js';
import { loadConfig } from '../src/config.js';
import { buildServer } from '../src/server.js';
import { authedCookie, stubOrchestrator } from './helpers.js';
import { upsertPlayer } from '../src/players.js';
import { personByLabel, personOf } from '../src/evaderPeople.js';
import { fakeDiscordApi } from './fakes/fakeDiscordApi.js';
import { addMember, createPerson } from '../src/evaderPeople.js';
import { placeFingerprintHold, placeAltHold } from '../src/altHolds.js';
import { hasActiveBan } from '../src/banState.js';
import { recordPlayerNet } from '../src/playerNetworks.js';
import { playMatch } from './fingerprintFixtures.js';

const EVADER = '76561198000000001';
const PLAYER = '76561198000000004';
const MOD = '76561198000000008';

let db: DB;
let app: FastifyInstance;
let mod: Record<string, string>;

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
  upsertPlayer(db, { steamid: EVADER, name: 'nepmir', avatar: null }, []);
  mod = authedCookie(app, db, MOD);
  db.prepare('UPDATE players SET is_mod = 1 WHERE steamid = ?').run(MOD);
});
afterEach(async () => { await app.close(); });

const post = (url: string, payload: object = {}, cookies = mod) => app.inject({ method: 'POST', url, cookies, payload });

describe('person routes', () => {
  it('a moderator creates a person, once per label', async () => {
    expect((await post('/api/admin/people/evaders', { label: 'dethisa', note: 'five accounts' })).statusCode).toBe(200);
    expect(personByLabel(db, 'dethisa')).not.toBeNull();
    expect((await post('/api/admin/people/evaders', { label: 'dethisa' })).statusCode).toBe(400);
  });

  it('adds an account to an existing person or a new one', async () => {
    const created = (await post('/api/admin/people/evaders', { label: 'dethisa' })).json() as { id: number };
    expect((await post(`/api/admin/people/${EVADER}/evader-person`, { personId: created.id })).statusCode).toBe(200);
    expect(personOf(db, 'steam', EVADER)?.label).toBe('dethisa');
    upsertPlayer(db, { steamid: PLAYER, name: 'other', avatar: null }, []);
    expect((await post(`/api/admin/people/${PLAYER}/evader-person`, { label: 'shove' })).statusCode).toBe(200);
    expect(personOf(db, 'steam', PLAYER)?.label).toBe('shove');
    expect((await post(`/api/admin/people/${PLAYER}/evader-person`, { personId: created.id })).statusCode).toBe(409);
    expect((await post(`/api/admin/people/${PLAYER}/evader-person`, { personId: 999 })).statusCode).toBe(404);
  });

  it('removes a member and closes a person', async () => {
    const { id } = (await post('/api/admin/people/evaders', { label: 'dethisa' })).json() as { id: number };
    await post(`/api/admin/people/${EVADER}/evader-person`, { personId: id });
    expect((await post(`/api/admin/people/evaders/${id}/members/remove`, { kind: 'steam', ident: EVADER })).statusCode).toBe(200);
    expect(personOf(db, 'steam', EVADER)).toBeNull();
    expect((await post(`/api/admin/people/evaders/${id}/members/remove`, { kind: 'steam', ident: EVADER })).statusCode).toBe(404);
    expect((await post(`/api/admin/people/evaders/${id}/close`)).statusCode).toBe(200);
    expect((await post(`/api/admin/people/evaders/${id}/close`)).statusCode).toBe(404);
  });

  it('is staff only, and the old flag routes are gone', async () => {
    const player = authedCookie(app, db, PLAYER);
    expect((await post('/api/admin/people/evaders', { label: 'x' }, player)).statusCode).toBe(403);
    expect((await post(`/api/admin/people/${EVADER}/evader`, { reason: 'x' })).statusCode).toBe(404);
  });

  it('the player file says which person an account belongs to, and offers the open ones', async () => {
    const { id } = (await post('/api/admin/people/evaders', { label: 'dethisa' })).json() as { id: number };
    await post(`/api/admin/people/${EVADER}/evader-person`, { personId: id });
    const file = (await app.inject({ method: 'GET', url: `/api/admin/people/${EVADER}`, cookies: mod })).json() as {
      sections: { identity: { evaderPerson: unknown; evaderOptions: unknown } };
    };
    expect(file.sections.identity.evaderPerson).toEqual({ id, label: 'dethisa', closed: false });
    expect(file.sections.identity.evaderOptions).toEqual([{ id, label: 'dethisa' }]);
  });
});

describe('known evaders view and ban as same person', () => {
  const ADMIN = '76561198000000009';
  const NEW = '76561198000000002';
  let admin: Record<string, string>;
  let personId: number;

  beforeEach(() => {
    admin = authedCookie(app, db, ADMIN);
    db.prepare('UPDATE players SET is_admin = 1 WHERE steamid = ?').run(ADMIN);
    upsertPlayer(db, { steamid: NEW, name: 'fresh', avatar: null }, []);
    personId = createPerson(db, 'dethisa', 'five accounts', ADMIN);
    addMember(db, personId, 'steam', EVADER, ADMIN, 'seed');
    addMember(db, personId, 'discord', '286250932470153217', ADMIN, 'seed');
    recordPlayerNet(db, { steamid: EVADER, ip: '198.51.100.4', country: 'GB' }, new Date(), { lookup: () => ({ asn: 212238, org: 'DATACAMP-LIMITED' }) });
    playMatch(db, EVADER, null, 12, 40);
  });

  it('lists each person with accounts, Discords, tagged connections and hold medians', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/admin/people/evaders', cookies: mod });
    const [p] = (res.json() as { people: import('../src/admin/knownEvaders.js').KnownEvader[] }).people;
    expect(p).toMatchObject({ id: personId, label: 'dethisa', note: 'five accounts' });
    expect(p.steam.map((s) => s.name)).toEqual(['nepmir']);
    expect(p.discord.map((d) => d.id)).toEqual(['286250932470153217']);
    expect(p.connections[0]).toMatchObject({ country: 'GB', asOrg: 'DATACAMP-LIMITED', vpn: true });
    expect(JSON.stringify(p)).not.toContain('198.51.100.4');
    expect(p.medians.find((m) => m.cls === 'hunter claw')?.person).toBe(12);
  });

  it('only an admin bans as same person from an alert', async () => {
    const url = `/api/admin/people/evaders/${personId}/ban-same-person`;
    expect((await post(url, { steamid: NEW })).statusCode).toBe(403); // a moderator
    expect(hasActiveBan(db, NEW)).toBe(false);
    expect((await post(url, { steamid: NEW }, admin)).statusCode).toBe(200);
    expect(hasActiveBan(db, NEW)).toBe(true);
    expect(personOf(db, 'steam', NEW)?.label).toBe('dethisa');
  });

  it('validates the steamid and maps refusals to clean statuses', async () => {
    const url = `/api/admin/people/evaders/${personId}/ban-same-person`;
    expect((await post(url, { steamid: 'nope' }, admin)).statusCode).toBe(400);
    expect((await post(url, {}, admin)).statusCode).toBe(400);
    expect((await post(url, { steamid: '76561198000000777' }, admin)).statusCode).toBe(404);
    expect((await post('/api/admin/people/evaders/999/ban-same-person', { steamid: NEW }, admin)).statusCode).toBe(404);
    const other = createPerson(db, 'shove', '', ADMIN);
    addMember(db, other, 'steam', NEW, ADMIN, 'seed');
    expect((await post(url, { steamid: NEW }, admin)).statusCode).toBe(409);
    expect(hasActiveBan(db, NEW)).toBe(false);
  });

  it('bans as same person from a fingerprint hold, never from a Discord hold', async () => {
    const f = placeFingerprintHold(db, NEW, personId, EVADER) as { id: number };
    expect((await post(`/api/admin/people/alts/${f.id}/ban-same-person`, {}).then((r) => r.statusCode))).toBe(403);
    expect((await post(`/api/admin/people/alts/${f.id}/ban-same-person`, {}, admin)).statusCode).toBe(200);
    expect(personOf(db, 'steam', NEW)?.label).toBe('dethisa');
    upsertPlayer(db, { steamid: PLAYER, name: 'other', avatar: null }, []);
    const d = placeAltHold(db, PLAYER, EVADER, '111', 'dethisa')!;
    expect((await post(`/api/admin/people/alts/${d}/ban-same-person`, {}, admin)).statusCode).toBe(409);
  });
});
