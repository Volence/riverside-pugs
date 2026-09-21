import { describe, it, expect, beforeEach } from 'vitest';
import { readFile } from 'node:fs/promises';
import { openDb, type DB } from '../src/db.js';
import { upsertPlayer } from '../src/players.js';
import { addServer, setEnabled } from '../src/serverPool.js';
import { setSetting } from '../src/settings.js';
import { subscribeAdminEvents, type AdminEvent } from '../src/adminFeed.js';
import { logAdmin } from '../src/admin/audit.js';
import { banPlayer, unbanPlayer } from '../src/admin/players.js';
import { ServerAdminSync, adminFlags, renderAdminsCfg, websiteAdmins } from '../src/serverAdmins.js';
import type { AddonsTransport, transportFor } from '../src/addonsTransport.js';
import type { ServerRow } from '../src/serverPool.js';

const MAL = '76561198030413993';
const BONE = '76561197972484944';

let db: DB;
/** Every file any box was handed this run: server name to the bytes written. */
let written: Map<string, string>;
/** Every console command any box was sent. */
let ran: { server: string; commands: string[] }[];
let failPutOn: Set<string>;

function fakeTransport(server: ServerRow, dir?: string): AddonsTransport | null {
  if ((server as ServerRow & { addons_dir?: string }).addons_dir === 'UNREACHABLE') return null;
  return {
    async put(localPath, remoteName) {
      if (failPutOn.has(server.name)) throw new Error('connection refused');
      written.set(`${server.name}:${dir}/${remoteName}`, await readFile(localPath, 'utf8'));
    },
    async size() { return null; },
    async remove() {},
  };
}

function sync(): ServerAdminSync {
  return new ServerAdminSync({
    db,
    exec: async (server, commands) => { ran.push({ server: server.name, commands }); },
    transport: fakeTransport as typeof transportFor,
  });
}

function server(name: string, addonsDir: string | null): number {
  const id = addServer(db, { name, host: '1.2.3.4', port: 27015, rconPort: 27015, rconPassword: 'x' });
  db.prepare('UPDATE servers SET addons_dir = ? WHERE id = ?').run(addonsDir, id);
  return id;
}

beforeEach(() => {
  db = openDb(':memory:');
  upsertPlayer(db, { steamid: MAL, name: 'Mal', avatar: null }, []);
  upsertPlayer(db, { steamid: BONE, name: 'Bone Breaker', avatar: null }, []);
  db.prepare('UPDATE players SET is_admin = 1 WHERE steamid IN (?, ?)').run(MAL, BONE);
  written = new Map();
  ran = [];
  failPutOn = new Set();
});

describe('renderAdminsCfg', () => {
  it('writes one block per admin, with the configured flags', () => {
    const cfg = renderAdminsCfg(db);
    // 76561198030413993 is logged by the Dallas box as STEAM_1:1:35074132.
    expect(cfg).toContain('"identity"\t"STEAM_1:1:35074132"');
    // One entry, not one per universe digit: SourceMod stores the identity
    // with the STEAM_X: prefix stripped, so the two spellings are one admin.
    expect(cfg.match(/"identity"/g)).toHaveLength(2);
    expect(cfg).toContain('"Mal"');
    expect(cfg).toContain('"Bone Breaker"');
    // Root, matching the hand-written entries already on the boxes.
    expect(cfg).toContain('"flags"\t\t"z"');
    expect(cfg.trimEnd().endsWith('}')).toBe(true);
  });

  it('honours a narrowed flag setting', () => {
    setSetting(db, 'server_admin_flags', 'bcdefg');
    expect(adminFlags(db)).toBe('bcdefg');
    expect(renderAdminsCfg(db)).toContain('"flags"\t\t"bcdefg"');
  });

  it('falls back to root rather than writing a flag string SourceMod cannot read', () => {
    setSetting(db, 'server_admin_flags', 'not flags!');
    expect(adminFlags(db)).toBe('z');
  });

  it('leaves no quote in a Steam persona able to break out of the KeyValues string', () => {
    upsertPlayer(db, { steamid: '76561198000000001', name: 'ev"il"\n"flags" "z', avatar: null }, []);
    db.prepare('UPDATE players SET is_admin = 1 WHERE steamid = ?').run('76561198000000001');
    const cfg = renderAdminsCfg(db);
    expect(cfg).not.toContain('ev"il"');
    // One block each, still: three admins.
    expect(cfg.match(/"flags"/g)).toHaveLength(3);
  });

  it('drops someone the moment their admin is taken away', () => {
    db.prepare('UPDATE players SET is_admin = 0 WHERE steamid = ?').run(BONE);
    expect(websiteAdmins(db).map((a) => a.steamid)).toEqual([MAL]);
    expect(renderAdminsCfg(db)).not.toContain('Bone Breaker');
  });
});

describe('ServerAdminSync', () => {
  it('writes admins.cfg into each box configs directory and reloads it', async () => {
    server('Dallas', '/home/l4d/l4d1-server/left4dead/addons');
    server('Chicago', '/left4dead/addons');

    const results = await sync().sync();

    expect(results.every((r) => r.ok)).toBe(true);
    expect([...written.keys()].sort()).toEqual([
      'Chicago:/left4dead/addons/sourcemod/configs/admins.cfg',
      'Dallas:/home/l4d/l4d1-server/left4dead/addons/sourcemod/configs/admins.cfg',
    ]);
    // The file on disk does nothing until SourceMod re-reads it.
    expect(ran.map((r) => r.commands)).toEqual([['sm_reloadadmins'], ['sm_reloadadmins']]);
  });

  it('never writes admins_simple.ini, which is the hand-maintained one', async () => {
    server('Dallas', '/addons');
    await sync().sync();
    expect([...written.keys()].some((k) => k.includes('admins_simple'))).toBe(false);
  });

  it('skips a box that is out of the pool', async () => {
    server('Dallas', '/addons');
    const chicago = server('Chicago', '/addons');
    setEnabled(db, chicago, false);

    const results = await sync().sync();

    expect(results.map((r) => r.server)).toEqual(['Dallas']);
  });

  it('reports the box that failed and still updates the others', async () => {
    server('Dallas', '/addons');
    server('Chicago', '/addons');
    failPutOn.add('Chicago');

    const results = await sync().sync();

    expect(results.find((r) => r.server === 'Dallas')!.ok).toBe(true);
    const chicago = results.find((r) => r.server === 'Chicago')!;
    expect(chicago.ok).toBe(false);
    expect(chicago.error).toMatch(/connection refused/);
    // A box that could not take the file must not be told to reload it.
    expect(ran.map((r) => r.server)).toEqual(['Dallas']);
  });

  it('reports a box with no transport rather than counting it as done', async () => {
    server('Riverside', 'UNREACHABLE');
    const results = await sync().sync();
    expect(results[0]).toMatchObject({ ok: false });
    expect(results[0].error).toMatch(/no addons transport/);
  });

  it('pushes by itself when someone is made an admin', async () => {
    server('Dallas', '/addons');
    const s = sync();
    s.start();
    try {
      logAdmin(db, MAL, 'set_admin', BONE, { isAdmin: true });
      await s.sync(); // the chain serialises, so this settles the one above too
      expect(ran.map((r) => r.server)).toContain('Dallas');
    } finally {
      s.stop();
    }
  });

  // A banned admin kept SourceMod root on every box: the list was built from
  // is_admin alone, and nothing told the sync that a ban had happened.
  it('leaves a banned admin out of the file, and puts them back when the ban ends', () => {
    const BONE_ID = '"identity"\t"STEAM_1:0:6109608"';
    expect(renderAdminsCfg(db)).toContain(BONE_ID);
    banPlayer(db, BONE, MAL, 'abuse', null);
    expect(websiteAdmins(db).map((a) => a.steamid)).toEqual([MAL]);
    expect(renderAdminsCfg(db)).not.toContain(BONE_ID);
    unbanPlayer(db, BONE, MAL);
    expect(renderAdminsCfg(db)).toContain(BONE_ID);
  });

  it('asks the bans table, not only the cached status', () => {
    banPlayer(db, BONE, MAL, 'abuse', null);
    db.prepare("UPDATE players SET status = 'active' WHERE steamid = ?").run(BONE);
    expect(websiteAdmins(db).map((a) => a.steamid)).toEqual([MAL]);
  });

  it('pushes by itself when an admin is banned and again when they are unbanned', async () => {
    server('Dallas', '/addons');
    const s = sync();
    s.start();
    try {
      banPlayer(db, BONE, MAL, 'abuse', null);
      await s.sync();
      // The push the ban triggered, then the one awaited above.
      expect(ran).toHaveLength(2);
      expect(written.get('Dallas:/addons/sourcemod/configs/admins.cfg')).not.toContain('Bone Breaker');
      unbanPlayer(db, BONE, MAL);
      await s.sync();
      expect(ran).toHaveLength(4);
      expect(written.get('Dallas:/addons/sourcemod/configs/admins.cfg')).toContain('Bone Breaker');
    } finally {
      s.stop();
    }
  });

  it('does not push for a ban on somebody who is not an admin', async () => {
    const PLAYER = '76561197960265730';
    upsertPlayer(db, { steamid: PLAYER, name: 'someone', avatar: null }, []);
    server('Dallas', '/addons');
    const s = sync();
    s.start();
    try {
      banPlayer(db, PLAYER, MAL, 'afk', 60);
      await s.sync();
      expect(ran).toHaveLength(1);
    } finally {
      s.stop();
    }
  });

  it('ignores admin actions that do not change who is an admin', () => {
    const seen: AdminEvent[] = [];
    const off = subscribeAdminEvents((e) => seen.push(e));
    try {
      logAdmin(db, MAL, 'ban', BONE, { reason: 'x' });
      expect(seen.some((e) => ServerAdminSync.affects(e))).toBe(false);
      logAdmin(db, MAL, 'set_admin', BONE, { isAdmin: false });
      expect(seen.some((e) => ServerAdminSync.affects(e))).toBe(true);
    } finally {
      off();
    }
  });
});
