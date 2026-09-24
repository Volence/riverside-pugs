import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { openDb, type DB } from '../src/db.js';
import { loadConfig } from '../src/config.js';
import { buildServer } from '../src/server.js';
import { addServer, getServer } from '../src/serverPool.js';
import { setSetting } from '../src/settings.js';
import { AdminFeedPoster } from '../src/discord/adminFeedPoster.js';
import { FakeTransport } from './fakes/fakeTransport.js';
import { authedCookie, stubOrchestrator } from './helpers.js';

const ADMIN = '76561199000000000';
const USER = '76561199000000001';

let db: DB;
let app: FastifyInstance;
let admin: Record<string, string>;
let serverId: number;
let pushes: { server: string; secret: string }[];
let pushAnswers: boolean | Error;

beforeEach(async () => {
  db = openDb(':memory:');
  pushes = [];
  pushAnswers = true;
  app = await buildServer({
    config: loadConfig({}), db, orchestrator: stubOrchestrator(),
    serverCleaner: async () => {}, serverExec: async () => {},
    logSecretPusher: async (server, secret) => {
      pushes.push({ server: server.name, secret });
      if (pushAnswers instanceof Error) throw pushAnswers;
      return pushAnswers;
    },
  });
  admin = authedCookie(app, db, ADMIN);
  db.prepare('UPDATE players SET is_admin = 1 WHERE steamid = ?').run(ADMIN);
  serverId = addServer(db, { name: 'chicago', host: '104.153.111.16', port: 27015, rconPort: 27015, rconPassword: 'x' });
});
afterEach(async () => { await app.close(); });

const post = (url: string, payload: object = {}, cookies = admin) => app.inject({ method: 'POST', url, cookies, payload });
const overviewRow = async () => (await app.inject({ method: 'GET', url: '/api/admin/overview', cookies: admin }))
  .json().servers.find((s: { id: number }) => s.id === serverId);

describe('admin: log signing per server', () => {
  it('generates a secret on first use, stores it, pushes it, and never shows it to the browser', async () => {
    const res = await post(`/api/admin/servers/${serverId}/log-secret`);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, pushed: true, rotated: false });
    const stored = getServer(db, serverId)!.log_secret!;
    expect(stored).toMatch(/^[0-9a-f]{32}$/);
    expect(pushes).toEqual([{ server: 'chicago', secret: stored }]);
    expect(res.body).not.toContain(stored);
    const row = await overviewRow();
    expect(JSON.stringify(row)).not.toContain(stored);
    expect(row.logAuth).toMatchObject({ mode: 'off', hasSecret: true, counters: { ok: 0, missing: 0, badMac: 0, replay: 0 } });
  });

  it('pushes the SAME secret again when asked again: that is the repair for a box that lost it', async () => {
    await post(`/api/admin/servers/${serverId}/log-secret`);
    const first = getServer(db, serverId)!.log_secret;
    await post(`/api/admin/servers/${serverId}/log-secret`);
    expect(getServer(db, serverId)!.log_secret).toBe(first);
    expect(pushes.map((p) => p.secret)).toEqual([first, first]);
  });

  it('keeps a first secret even when the box does not know the cvar yet, and says the push did not land', async () => {
    pushAnswers = false;
    const res = await post(`/api/admin/servers/${serverId}/log-secret`);
    expect(res.json()).toMatchObject({ ok: true, pushed: false });
    expect(getServer(db, serverId)!.log_secret).toMatch(/^[0-9a-f]{32}$/);
  });

  it('rotates only when the new secret reached the box: a failed rotation must not strand an enforcing server', async () => {
    await post(`/api/admin/servers/${serverId}/log-secret`);
    const first = getServer(db, serverId)!.log_secret;
    pushAnswers = new Error('rcon down');
    const failed = await post(`/api/admin/servers/${serverId}/log-secret`, { rotate: true });
    expect(failed.statusCode).toBe(502);
    expect(getServer(db, serverId)!.log_secret).toBe(first);
    pushAnswers = true;
    const ok = await post(`/api/admin/servers/${serverId}/log-secret`, { rotate: true });
    expect(ok.json()).toEqual({ ok: true, pushed: true, rotated: true });
    expect(getServer(db, serverId)!.log_secret).not.toBe(first);
  });

  it('sets the mode, refuses one it does not know, and refuses log or enforce with no secret to check against', async () => {
    expect((await post(`/api/admin/servers/${serverId}/log-auth`, { mode: 'enforce' })).statusCode).toBe(409);
    await post(`/api/admin/servers/${serverId}/log-secret`);
    expect((await post(`/api/admin/servers/${serverId}/log-auth`, { mode: 'banana' })).statusCode).toBe(400);
    expect((await post(`/api/admin/servers/${serverId}/log-auth`, { mode: 'log' })).statusCode).toBe(200);
    expect(getServer(db, serverId)!.log_auth).toBe('log');
    expect((await overviewRow()).logAuth.mode).toBe('log');
    expect((await post(`/api/admin/servers/${serverId}/log-auth`, { mode: 'off' })).statusCode).toBe(200);
    expect((await post('/api/admin/servers/9999/log-auth', { mode: 'off' })).statusCode).toBe(404);
  });

  it('is admin only, and leaves an audit row that does not hold the secret', async () => {
    const user = authedCookie(app, db, USER);
    expect((await post(`/api/admin/servers/${serverId}/log-secret`, {}, user)).statusCode).toBe(403);
    expect((await post(`/api/admin/servers/${serverId}/log-auth`, { mode: 'off' }, user)).statusCode).toBe(403);
    await post(`/api/admin/servers/${serverId}/log-secret`);
    const secret = getServer(db, serverId)!.log_secret!;
    const audit = JSON.stringify(db.prepare('SELECT * FROM admin_actions').all());
    expect(audit).toContain('server_log_secret');
    expect(audit).not.toContain(secret);
  });

  it('keeps the secret out of a failed push, which names the command it timed out on', async () => {
    // The same shape as the clock control leak: RconClient.exec puts the
    // command into its timeout message, and here the command is the secret.
    setSetting(db, 'discord_admin_channel_id', 'admins');
    const transport = new FakeTransport();
    const feed = new AdminFeedPoster({ db, transport, publicUrl: 'https://pug.test' });
    feed.start();
    try {
      await post(`/api/admin/servers/${serverId}/log-secret`);
      const secret = getServer(db, serverId)!.log_secret!;
      pushAnswers = new Error(`rcon exec timeout: sm_pug_log_secret "${secret}"`);
      const res = await post(`/api/admin/servers/${serverId}/log-secret`);
      await feed.idle();

      expect(res.statusCode).toBe(502);
      const audit = JSON.stringify(db.prepare('SELECT * FROM admin_actions').all());
      const posted = JSON.stringify(transport.messages.map((m) => m.payload));
      for (const seen of [res.body, audit, posted]) expect(seen).not.toContain(secret);
      expect(res.json().error).toContain('could not reach chicago: rcon exec timeout');
      expect(audit).toContain('rcon exec timeout');
    } finally {
      feed.stop();
    }
  });
});
