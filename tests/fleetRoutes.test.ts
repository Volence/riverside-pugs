import { beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../src/db.js';
import { buildServer } from '../src/server.js';
import { loadConfig } from '../src/config.js';
import { addServer } from '../src/serverPool.js';
import { authedCookie, stubOrchestrator } from './helpers.js';
import { FleetReader } from '../src/fleetReader.js';

const ADMIN = '76561198000000009';
const P = 'left4dead/addons/sourcemod/plugins/pug-match.smx';

describe('fleet routes', () => {
  let db: ReturnType<typeof openDb>;
  let fleetDir: string;
  beforeEach(() => {
    db = openDb(':memory:');
    addServer(db, { name: 'dallas', host: '10.0.0.1', port: 27015, rconPort: 27015, rconPassword: 'x' });
    addServer(db, { name: 'chicago', host: '10.0.0.2', port: 27015, rconPort: 27015, rconPassword: 'x' });
    fleetDir = mkdtempSync(join(tmpdir(), 'fleet-'));
    writeFileSync(join(fleetDir, 'repo.json'), JSON.stringify({ kind: 'repo', label: '57add2c', at: '2026-09-24T14:00:00Z', files: { [P]: { size: 81241, sha256: 'r' } } }));
  });

  async function app(admin = true) {
    const fleetReader = new FleetReader({ db, reader: (s) => ({ kind: 'local', read: async () => [{ path: P, size: s.id === 1 ? 81639 : 81241, sha256: s.id === 1 ? 'd' : 'r' }] }) });
    const a = await buildServer({ config: loadConfig({ FLEET_DIR: fleetDir }), db, orchestrator: stubOrchestrator(), serverCleaner: async () => {}, serverExec: async () => {}, fleetReader });
    const cookies = await authedCookie(a, db, admin ? ADMIN : '76561198000000010');
    if (admin) db.prepare('UPDATE players SET is_admin = 1 WHERE steamid = ?').run(ADMIN);
    return { a, cookies, fleetReader };
  }

  it('checks all boxes, audits, and shows the difference against the repo', async () => {
    const { a, cookies, fleetReader } = await app();
    const res = await a.inject({ method: 'POST', url: '/api/admin/fleet/check', cookies, payload: { all: true } });
    expect(res.json()).toEqual({ states: { 1: 'queued', 2: 'queued' } });
    await fleetReader.idle();
    const body = (await a.inject({ method: 'GET', url: '/api/admin/fleet', cookies })).json() as {
      repo: { label: string }; base: null; boxes: { name: string; readAt: string | null }[];
      rows: { path: string; cells: Record<string, { label: string; highlight: boolean }> }[] };
    expect(body.repo.label).toBe('57add2c');
    expect(body.base).toBeNull();
    expect(body.boxes.every((b) => b.readAt !== null)).toBe(true);
    expect(body.rows[0].cells['1']).toMatchObject({ label: 'neither', highlight: true });
    expect(body.rows[0].cells['2']).toMatchObject({ label: 'repo', highlight: false });
    expect(db.prepare("SELECT COUNT(*) AS n FROM admin_actions WHERE action = 'fleet_check'").get()).toEqual({ n: 1 });
  });

  it('answers busy for a box in a match and refuses a bad body', async () => {
    db.prepare("UPDATE servers SET status = 'live' WHERE id = 1").run();
    const { a, cookies } = await app();
    expect((await a.inject({ method: 'POST', url: '/api/admin/fleet/check', cookies, payload: { serverId: 1 } })).json())
      .toEqual({ states: { 1: 'busy' } });
    expect((await a.inject({ method: 'POST', url: '/api/admin/fleet/check', cookies, payload: {} })).statusCode).toBe(400);
  });

  it('refuses a non-admin', async () => {
    const { a, cookies } = await app(false);
    expect((await a.inject({ method: 'GET', url: '/api/admin/fleet', cookies })).statusCode).toBe(403);
    expect((await a.inject({ method: 'POST', url: '/api/admin/fleet/check', cookies, payload: { all: true } })).statusCode).toBe(403);
  });
});
