import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance } from 'fastify';
import { openDb, type DB } from '../src/db.js';
import { loadConfig } from '../src/config.js';
import { buildServer } from '../src/server.js';
import { fakeSteam, type FakeSteam } from './fakes/steamApi.js';
import { authedCookie, stubOrchestrator } from './helpers.js';
import { upsertPlayer } from '../src/players.js';
import { banPlayer, playerDetail } from '../src/admin/players.js';
import { addAlias } from '../src/aliases.js';
import { steamAccountView } from '../src/admin/steamAccount.js';

const P = '76561198000000001';
const LENDER = '76561198000000099';
const NOW = new Date('2026-09-21T12:00:00.000Z');
const DAY = 86_400;
const unix = (iso: string) => Math.floor(Date.parse(iso) / 1000);

let db: DB;

function signals(steamid: string, cols: Record<string, unknown>): void {
  const all = { steamid, checked_at: NOW.toISOString(), ...cols };
  const keys = Object.keys(all);
  db.prepare(`INSERT INTO player_steam_signals (${keys.join(', ')}) VALUES (${keys.map(() => '?').join(', ')})`)
    .run(...Object.values(all));
}
function firstMatch(steamid: string, createdAt: string): void {
  const id = Number(db.prepare("INSERT INTO matches (season_id, state, campaign, created_at) VALUES (1, 'completed', 'dead_air', ?)")
    .run(createdAt).lastInsertRowid);
  db.prepare("INSERT INTO match_players (match_id, player_id, team) VALUES (?, ?, 'a')").run(id, steamid);
}
/** Eight rated players on a ladder of SR, `steamid` placed at `place` (1 = top). */
function ladder(steamid: string, place: number): void {
  for (let i = 1; i <= 8; i++) {
    const id = i === place ? steamid : `7656119800000020${i}`;
    upsertPlayer(db, { steamid: id, name: `r${i}`, avatar: null }, []);
    db.prepare('INSERT OR REPLACE INTO player_ratings (player_id, season_id, mu, sigma, wins, losses) VALUES (?, 1, ?, 2, 3, 0)')
      .run(id, 40 - i);
    for (let g = 0; g < 3; g++) {
      db.prepare('INSERT INTO rating_history (player_id, match_id, season_id, mu_before, sigma_before, mu_after, sigma_after) VALUES (?, ?, 1, 25, 8, 25, 8)')
        .run(id, 1000 + i * 10 + g);
    }
  }
}
const flags = (steamid = P) => steamAccountView(db, steamid, NOW)!.flags.map((f) => f.kind);

beforeEach(() => {
  db = openDb(':memory:');
  upsertPlayer(db, { steamid: P, name: 'pat', avatar: null }, []);
  db.prepare("UPDATE players SET created_at = '2026-09-01 00:00:00' WHERE steamid = ?").run(P);
});

describe('steamAccountView', () => {
  it('is null for a player Steam has never been asked about', () => {
    expect(steamAccountView(db, P, NOW)).toBeNull();
    expect(playerDetail(db, P)!.steamAccount).toBeNull();
  });

  it('measures the account\'s age against the first match here', () => {
    signals(P, { time_created: unix('2026-08-22T00:00:00Z'), visibility: 3, profile_state: 1 });
    firstMatch(P, '2026-09-02 00:00:00');
    firstMatch(P, '2026-09-10 00:00:00');
    const v = steamAccountView(db, P, NOW)!;
    expect(v.createdAt).toBe('2026-08-22T00:00:00.000Z');
    expect(v.ageDays).toBe(30);
    expect(v.reference).toEqual({ kind: 'first_match', at: '2026-09-02T00:00:00.000Z' });
    expect(v.daysBeforeReference).toBe(11);
    expect(v.flags).toEqual([{
      kind: 'new_account',
      text: 'New account: created 11 days before their first match here. New players are also new accounts.',
    }]);
  });

  it('falls back to the day they joined when they have not played yet', () => {
    signals(P, { time_created: unix('2026-08-31T00:00:00Z'), visibility: 3 });
    const v = steamAccountView(db, P, NOW)!;
    expect(v.reference).toEqual({ kind: 'joined', at: '2026-09-01T00:00:00.000Z' });
    expect(v.flags[0].text).toContain('created 1 day before they joined here');
  });

  it('does not call an old account new', () => {
    signals(P, { time_created: unix('2012-01-01T00:00:00Z'), visibility: 3 });
    firstMatch(P, '2026-09-02 00:00:00');
    expect(flags()).toEqual([]);
  });

  it('flags a private profile, and knows no age for it', () => {
    signals(P, { visibility: 1, games_visible: 0 });
    const v = steamAccountView(db, P, NOW)!;
    expect(v.visibility).toBe('private');
    expect(v.createdAt).toBeNull();
    expect(v.l4d1).toEqual({ state: 'hidden', lastSeenHours: null });
    expect(v.flags.map((f) => f.kind)).toEqual(['private_profile']);
  });

  it('flags a ban elsewhere with how long ago, aged from the day it was read', () => {
    signals(P, {
      visibility: 3, vac_banned: 1, vac_bans: 1, game_bans: 2, days_since_last_ban: 100, community_banned: 0,
      economy_ban: 'none', bans_checked_at: new Date(NOW.getTime() - 5 * DAY * 1000).toISOString(),
    });
    const v = steamAccountView(db, P, NOW)!;
    expect(v.bans).toMatchObject({ vac: 1, game: 2, daysSinceLast: 105, community: false, economy: 'none' });
    expect(v.flags).toEqual([{
      kind: 'banned_elsewhere',
      text: 'Banned elsewhere: 1 VAC ban and 2 game bans on this Steam account, the latest 105 days ago. Steam does not say which game.',
    }]);
  });

  it('does not flag a clean ban record', () => {
    signals(P, { visibility: 3, vac_banned: 0, vac_bans: 0, game_bans: 0, days_since_last_ban: 0, bans_checked_at: NOW.toISOString() });
    expect(flags()).toEqual([]);
  });

  it('flags low hours only on a top-quartile rating, and only when the hours are visible', () => {
    ladder(P, 2);
    signals(P, { visibility: 3, games_visible: 1, l4d1_minutes: 49 * 60 });
    const v = steamAccountView(db, P, NOW)!;
    expect(v.l4d1).toEqual({ state: 'visible', hours: 49 });
    expect(v.flags).toEqual([{
      kind: 'low_hours',
      text: 'Low hours: 49 h of L4D1 on this account while rated in the top quarter of the season. Hours on another account or offline do not show here.',
    }]);

    db.prepare('UPDATE player_steam_signals SET l4d1_minutes = ? WHERE steamid = ?').run(50 * 60, P);
    expect(flags()).toEqual([]);
    // Hidden hours say nothing, even when an old figure is still stored.
    db.prepare('UPDATE player_steam_signals SET l4d1_minutes = 60, games_visible = 0 WHERE steamid = ?').run(P);
    expect(flags()).toEqual([]);
    expect(steamAccountView(db, P, NOW)!.l4d1).toEqual({ state: 'hidden', lastSeenHours: 1 });
  });

  it('does not flag low hours on a middling rating, or before a rating means anything', () => {
    ladder(P, 3);
    signals(P, { visibility: 3, games_visible: 1, l4d1_minutes: 60 });
    expect(flags()).toEqual([]);

    const fresh = '76561198000000777';
    upsertPlayer(db, { steamid: fresh, name: 'fresh', avatar: null }, []);
    db.prepare('INSERT INTO player_ratings (player_id, season_id, mu, sigma, wins, losses) VALUES (?, 1, 60, 1, 1, 0)').run(fresh);
    signals(fresh, { visibility: 3, games_visible: 1, l4d1_minutes: 60, time_created: unix('2012-01-01T00:00:00Z') });
    expect(flags(fresh)).toEqual([]);
  });

  it('says when L4D1 is not in a visible library', () => {
    signals(P, { visibility: 3, games_visible: 1, l4d1_minutes: null });
    expect(steamAccountView(db, P, NOW)!.l4d1).toEqual({ state: 'not_owned' });
  });

  it('names a lender who is a player here, and whether they are banned here', () => {
    upsertPlayer(db, { steamid: LENDER, name: 'lenny', avatar: null }, []);
    signals(P, { visibility: 3, lender_id: LENDER, lender_seen_at: '2026-09-20T20:00:00.000Z' });
    let v = steamAccountView(db, P, NOW)!;
    expect(v.lender).toEqual({
      steamid: LENDER, seenAt: '2026-09-20T20:00:00.000Z', player: { steamid: LENDER, name: 'lenny', banned: false },
    });
    expect(v.flags).toEqual([{
      kind: 'borrowed_game',
      text: 'Borrowed game: last seen playing on a copy shared by lenny through Steam Family Sharing. Households share libraries.',
    }]);

    banPlayer(db, LENDER, 'admin', 'cheating', null);
    v = steamAccountView(db, P, NOW)!;
    expect(v.lender!.player!.banned).toBe(true);
    expect(v.flags[0].text).toBe(
      'Borrowed game: last seen playing on a copy shared by lenny through Steam Family Sharing. lenny is banned here.',
    );
  });

  it('follows a lender that was merged into another account', () => {
    const main = '76561198000000098';
    upsertPlayer(db, { steamid: main, name: 'main', avatar: null }, []);
    addAlias(db, { steamid: LENDER, canonical: main, by: 'admin' });
    signals(P, { visibility: 3, lender_id: LENDER, lender_seen_at: NOW.toISOString() });
    expect(steamAccountView(db, P, NOW)!.lender).toMatchObject({ steamid: LENDER, player: { steamid: main, name: 'main' } });
  });

  it('shows a lender nobody here knows by id', () => {
    signals(P, { visibility: 3, lender_id: LENDER, lender_seen_at: NOW.toISOString() });
    const v = steamAccountView(db, P, NOW)!;
    expect(v.lender!.player).toBeNull();
    expect(v.flags[0].text).toContain(`shared by ${LENDER}`);
  });
});

describe('steam account over HTTP', () => {
  const ADMIN = '76561198000000500';
  const SENTINELS = ['4242', '987654', LENDER, '1199145600', 'probation-sentinel'];
  const KEYS = /steamAccount|vacBan|vac_ban|gameBan|game_bans|lender|l4d1|steam_level|steamLevel|time_created|daysSinceLast/i;

  let app: FastifyInstance;
  let steam: FakeSteam;
  afterEach(async () => { await app.close(); });

  const build = async (env: Record<string, string>) => {
    steam = fakeSteam({ [P]: { timecreated: 1_199_145_600, level: 4242, l4d1Minutes: 987_654, lender: LENDER, bans: { vac: 1, daysSince: 3, economy: 'probation-sentinel' } } });
    app = await buildServer({
      config: loadConfig(env), db, orchestrator: stubOrchestrator(), serverCleaner: async () => {},
      serverExec: async () => {}, steamFetch: steam.fetch,
    });
  };
  const adminCookie = () => {
    const c = authedCookie(app, db, ADMIN);
    db.prepare('UPDATE players SET is_admin = 1 WHERE steamid = ?').run(ADMIN);
    return c;
  };

  it('an admin can ask Steam again now, and sees the result on the player', async () => {
    await build({ STEAM_API_KEY: 'key' });
    const cookies = adminCookie();
    const res = await app.inject({ method: 'POST', url: `/api/admin/players/${P}/steam-refresh`, cookies });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, refreshed: 1 });
    const detail = (await app.inject({ method: 'GET', url: `/api/admin/players/${P}`, cookies })).json();
    expect(detail.steamAccount).toMatchObject({ level: 4242, bans: { vac: 1 }, lender: { steamid: LENDER } });
  });

  it('the refresh is for admins only, and says so plainly when there is no api key', async () => {
    await build({});
    const user = authedCookie(app, db, '76561198000000501');
    const url = `/api/admin/players/${P}/steam-refresh`;
    expect((await app.inject({ method: 'POST', url })).statusCode).toBe(401);
    expect((await app.inject({ method: 'POST', url, cookies: user })).statusCode).toBe(403);
    const res = await app.inject({ method: 'POST', url, cookies: adminCookie() });
    expect(res.statusCode).toBe(503);
    expect(steam.calls).toEqual([]);
    const detail = (await app.inject({ method: 'GET', url: `/api/admin/players/${P}`, cookies: adminCookie() })).json();
    expect(detail.steamAccount).toBeNull();
  });

  it('never reaches a public payload, signed in or not', async () => {
    await build({ STEAM_API_KEY: 'key' });
    await app.inject({ method: 'POST', url: `/api/admin/players/${P}/steam-refresh`, cookies: adminCookie() });
    expect(steamAccountView(db, P)).not.toBeNull();
    firstMatch(P, '2026-09-02 00:00:00');
    const matchId = (db.prepare('SELECT MAX(id) AS id FROM matches').get() as { id: number }).id;

    const self = authedCookie(app, db, P);
    const urls = [
      `/api/players/${P}`, '/api/leaderboard', '/api/matches', `/api/matches/${matchId}`, '/api/live',
      '/api/queue', '/api/state', '/api/streams', '/api/me', '/api/site',
    ];
    for (const cookies of [undefined, self]) {
      for (const url of urls) {
        const res = await app.inject({ method: 'GET', url, cookies });
        if (res.statusCode === 401) continue;
        expect(res.statusCode, url).toBe(200);
        expect(res.body, url).not.toMatch(KEYS);
        for (const s of SENTINELS) expect(res.body, `${url} leaks ${s}`).not.toContain(s);
      }
    }
    // The player's own profile is the one most likely to grow a field by
    // accident, so it is checked by name as well as by value.
    const profile = await app.inject({ method: 'GET', url: `/api/players/${P}`, cookies: self });
    expect(profile.statusCode).toBe(200);
    expect(Object.keys(profile.json())).not.toContain('steamAccount');
  });

  it('is read only by the admin player page, the refreshers and the merge', () => {
    // The public routes, the WebSocket and the Discord cards are all built
    // from modules that never touch these tables. A new reader has to be
    // added here on purpose, which is the moment to ask who can see it. That
    // includes anything that imports playerFile.js or playerFileSummary.js:
    // either one hands its caller steamFlags (among other staff-only fields)
    // without the caller ever mentioning steamAccount.js or steamSignals.js
    // itself, so a module reaching this data only through one of them would
    // otherwise never trip this guard.
    const allowed = new Set([
      'src/steamSignals.ts', 'src/admin/steamAccount.ts', 'src/admin/players.ts', 'src/mergePlayers.ts',
      'src/db.ts', 'src/server.ts', 'src/admin/timeline/steam.ts',
      'src/admin/playerFile.ts', 'src/admin/playerFileSummary.ts', 'src/routes/people.ts',
      'src/routes/tickets.ts',
    ]);
    const root = join(dirname(fileURLToPath(import.meta.url)), '..');
    const walk = (dir: string): string[] => readdirSync(join(root, dir), { withFileTypes: true })
      .flatMap((e) => (e.isDirectory() ? walk(`${dir}/${e.name}`) : e.name.endsWith('.ts') ? [`${dir}/${e.name}`] : []));
    const readers = walk('src').filter((f) =>
      /player_steam_signals|steam_signal_alerts|steamSignals\.js|steamAccount\.js|playerFileSummary\.js|playerFile\.js/
        .test(readFileSync(join(root, f), 'utf8')));
    expect(readers.filter((f) => !allowed.has(f))).toEqual([]);
  });
});
