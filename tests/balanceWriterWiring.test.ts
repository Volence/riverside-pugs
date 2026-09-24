import { afterEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import dgram from 'node:dgram';
import type { AddressInfo } from 'node:net';
import { openDb } from '../src/db.js';
import { buildServer } from '../src/server.js';
import { loadConfig } from '../src/config.js';
import { addServer } from '../src/serverPool.js';
import type { AddonsTransport } from '../src/addonsTransport.js';
import { authedCookie, stubOrchestrator } from './helpers.js';

const ADMIN = '76561198000000009';

// Copied verbatim from tests/balanceWiring.test.ts.
function freeUdpPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = dgram.createSocket('udp4');
    s.on('error', reject);
    s.bind(0, '127.0.0.1', () => {
      const { port } = s.address() as AddressInfo;
      s.close(() => resolve(port));
    });
  });
}

describe('balance writer wiring', () => {
  let close: (() => Promise<void>) | undefined;
  afterEach(async () => { await close?.(); });

  it('verifies and writes the active rollout at boot through the injected transport', async () => {
    const db = openDb(':memory:');
    const sid = addServer(db, { name: 'dallas', host: '127.0.0.1', port: 27015, rconPort: 27015, rconPassword: 'x' });
    db.prepare("UPDATE servers SET status = 'idle', addons_dir = '/g/left4dead/addons' WHERE id = ?").run(sid);
    db.prepare("INSERT INTO balance_patches (id, fingerprint, source, first_seen_at) VALUES (1, 'f', 'announced', 'now')").run();
    db.prepare("INSERT INTO balance_rollouts (id, patch_id, values_json, content, created_by, created_at) VALUES (1, 1, '{}', 'CONTENT', 'a', 'now')").run();
    db.prepare("INSERT INTO balance_rollout_servers (rollout_id, server_id, state) VALUES (1, ?, 'pending')").run(sid);
    const disk = new Map<string, string>();
    const transport = (): AddonsTransport => ({
      put: async (local, name) => { disk.set(name, readFileSync(local, 'utf8')); },
      readText: async (name) => disk.get(name) ?? null, size: async () => null, remove: async () => {},
    });
    const app = await buildServer({ config: { ...loadConfig({}), devMode: false, logListenPort: await freeUdpPort() }, db,
      serverCleaner: async () => {}, serverExec: async () => {}, balanceTransport: transport });
    close = () => app.close();
    await new Promise((r) => setTimeout(r, 100));
    expect(disk.get('pug_balance.cfg')).toBe('CONTENT');
    expect(db.prepare('SELECT state FROM balance_rollout_servers').get()).toEqual({ state: 'written' });
  });

  it('a dev install never writes on release', async () => {
    const db = openDb(':memory:');
    const sid = addServer(db, { name: 'dallas', host: '127.0.0.1', port: 27015, rconPort: 27015, rconPassword: 'x' });
    db.prepare("UPDATE servers SET status = 'live', addons_dir = '/g/left4dead/addons' WHERE id = ?").run(sid);
    db.prepare("INSERT INTO balance_patches (id, fingerprint, source, first_seen_at) VALUES (1, 'f', 'announced', 'now')").run();
    db.prepare("INSERT INTO balance_rollouts (id, patch_id, values_json, content, created_by, created_at) VALUES (1, 1, '{}', 'CONTENT', 'a', 'now')").run();
    db.prepare("INSERT INTO balance_rollout_servers (rollout_id, server_id, state) VALUES (1, ?, 'pending')").run(sid);
    const puts: string[] = [];
    const transport = (): AddonsTransport => ({
      put: async (_local, name) => { puts.push(name); },
      readText: async () => null, size: async () => null, remove: async () => {},
    });
    const app = await buildServer({ config: { ...loadConfig({}), devMode: true }, db, orchestrator: stubOrchestrator(),
      serverCleaner: async () => {}, serverExec: async () => {}, balanceTransport: transport });
    close = () => app.close();
    const cookies = await authedCookie(app, db, ADMIN);
    db.prepare('UPDATE players SET is_admin = 1 WHERE steamid = ?').run(ADMIN);
    const res = await app.inject({ method: 'POST', url: `/api/admin/servers/${sid}/idle`, cookies });
    expect(res.statusCode).toBe(200);
    await new Promise((r) => setTimeout(r, 50));
    expect(puts).toEqual([]);
    expect(db.prepare('SELECT state FROM balance_rollout_servers').get()).toEqual({ state: 'pending' });
  });
});
