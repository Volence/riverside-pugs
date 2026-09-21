import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openDb, type DB } from '../src/db.js';
import { upsertPlayer } from '../src/players.js';
import { banPlayer } from '../src/admin/players.js';
import { addAlias } from '../src/aliases.js';
import { subscribeAdminEvents, type AdminEvent } from '../src/adminFeed.js';
import {
  fetchSteamSignals, getSteamSignals, refreshSteamSignals, refreshStaleSignals,
  SIGNAL_BATCH, SIGNAL_MAX_AGE_MS,
} from '../src/steamSignals.js';
import { fakeSteam } from './fakes/steamApi.js';

const A = '76561198000000001';
const B = '76561198000000002';
const LENDER = '76561198000000099';
const NOW = new Date('2026-09-21T12:00:00.000Z');

let db: DB;
let events: AdminEvent[];
let off: () => void;

function player(steamid: string): void {
  upsertPlayer(db, { steamid, name: `n${steamid.slice(-2)}`, avatar: null }, []);
}
function liveMatch(id: number, ...roster: string[]): void {
  db.prepare("INSERT INTO matches (id, season_id, state, campaign) VALUES (?, 1, 'live', 'dead_air')").run(id);
  for (const p of roster) db.prepare("INSERT INTO match_players (match_id, player_id, team) VALUES (?, ?, 'a')").run(id, p);
}

beforeEach(() => {
  db = openDb(':memory:');
  events = [];
  off = subscribeAdminEvents((e) => { events.push(e); });
});
afterEach(() => off());

describe('fetchSteamSignals', () => {
  it('normalises every signal for a public account', async () => {
    const steam = fakeSteam({
      [A]: { timecreated: 1_200_000_000, visibility: 3, profilestate: 1, l4d1Minutes: 6120, level: 14,
        bans: { vac: 1, game: 2, daysSince: 40, community: true, economy: 'probation' } },
    });
    const got = (await fetchSteamSignals([A], 'key', steam.fetch, { sharing: true })).get(A)!;
    expect(got.summary).toEqual({ timeCreated: 1_200_000_000, visibility: 3, profileState: 1 });
    expect(got.bans).toEqual({
      vacBanned: true, vacBans: 1, gameBans: 2, daysSinceLastBan: 40, communityBanned: true, economyBan: 'probation',
    });
    expect(got.games).toEqual({ visible: true, l4d1Minutes: 6120 });
    expect(got.level).toBe(14);
    expect(got.sharing).toEqual({ lender: null });
  });

  it('asks the batch endpoints once for many ids, and the rest per player', async () => {
    const steam = fakeSteam({ [A]: {}, [B]: {} });
    await fetchSteamSignals([A, B], 'key', steam.fetch);
    const count = (name: string) => steam.calls.filter((u) => u.includes(`/${name}/`)).length;
    expect(count('GetPlayerSummaries')).toBe(1);
    expect(count('GetPlayerBans')).toBe(1);
    expect(count('GetOwnedGames')).toBe(2);
    expect(count('GetSteamLevel')).toBe(2);
    // Only meaningful while in game, so never asked unless the caller says so.
    expect(count('IsPlayingSharedGame')).toBe(0);
    expect(steam.calls.find((u) => u.includes('GetOwnedGames'))).toContain('include_played_free_games=1');
    expect(decodeURIComponent(steam.calls.find((u) => u.includes('GetOwnedGames'))!)).toContain('appids_filter[0]=500');
  });

  it('splits more than a hundred ids across batch requests', async () => {
    const ids = Array.from({ length: 101 }, (_, i) => `765611980000${String(i).padStart(5, '0')}`);
    const steam = fakeSteam({});
    await fetchSteamSignals(ids, 'key', steam.fetch, { details: false });
    expect(steam.calls.filter((u) => u.includes('GetPlayerSummaries')).length).toBe(2);
    expect(steam.calls.filter((u) => u.includes('GetOwnedGames')).length).toBe(0);
  });

  it('reads a private profile as unknown, never as zero', async () => {
    const steam = fakeSteam({ [A]: { visibility: 1, l4d1Minutes: 'hidden', level: 'hidden' } });
    const got = (await fetchSteamSignals([A], 'key', steam.fetch)).get(A)!;
    expect(got.summary).toEqual({ timeCreated: null, visibility: 1, profileState: 1 });
    expect(got.games).toEqual({ visible: false, l4d1Minutes: null });
    expect(got.level).toBeNull();
  });

  it('tells a visible library without L4D1 apart from a hidden one', async () => {
    const steam = fakeSteam({ [A]: { l4d1Minutes: null } });
    const got = (await fetchSteamSignals([A], 'key', steam.fetch)).get(A)!;
    expect(got.games).toEqual({ visible: true, l4d1Minutes: null });
  });

  it('reports the lender while a borrowed game is being played', async () => {
    const steam = fakeSteam({ [A]: { lender: LENDER } });
    const got = (await fetchSteamSignals([A], 'key', steam.fetch, { sharing: true })).get(A)!;
    expect(got.sharing).toEqual({ lender: LENDER });
    expect(steam.calls.find((u) => u.includes('IsPlayingSharedGame'))).toContain('appid_playing=500');
  });

  it('loses only the signal whose call failed', async () => {
    const steam = fakeSteam({ [A]: { timecreated: 5, l4d1Minutes: 60, level: 3 } });
    steam.down.add('GetPlayerBans');
    steam.refused.add('GetSteamLevel');
    const got = (await fetchSteamSignals([A], 'key', steam.fetch, { sharing: true })).get(A)!;
    expect(got.bans).toBeNull();
    expect(got.level).toBeNull();
    expect(got.summary?.timeCreated).toBe(5);
    expect(got.games?.l4d1Minutes).toBe(60);
  });

  it('never throws and never fetches without an api key', async () => {
    const boom = async () => { throw new Error('must not fetch'); };
    expect((await fetchSteamSignals([A], null, boom)).size).toBe(0);
    const steam = fakeSteam({});
    for (const e of ['GetPlayerSummaries', 'GetPlayerBans', 'GetOwnedGames', 'GetSteamLevel', 'IsPlayingSharedGame']) steam.down.add(e);
    const got = (await fetchSteamSignals([A], 'key', steam.fetch, { sharing: true })).get(A)!;
    expect(got).toEqual({ summary: null, bans: null, games: null, level: null, sharing: null });
  });
});

describe('refreshSteamSignals', () => {
  it('stores one row per player', async () => {
    player(A);
    const steam = fakeSteam({ [A]: { timecreated: 1_200_000_000, l4d1Minutes: 6120, level: 14, bans: { game: 1, daysSince: 12 } } });
    expect(await refreshSteamSignals({ db, apiKey: 'key', fetchFn: steam.fetch, now: () => NOW }, [A])).toBe(1);
    expect(getSteamSignals(db, A)).toMatchObject({
      steamid: A, time_created: 1_200_000_000, visibility: 3, profile_state: 1,
      vac_banned: 0, vac_bans: 0, game_bans: 1, days_since_last_ban: 12, community_banned: 0, economy_ban: 'none',
      bans_checked_at: NOW.toISOString(), games_visible: 1, l4d1_minutes: 6120, steam_level: 14,
      lender_id: null, lender_seen_at: null, checked_at: NOW.toISOString(),
    });
  });

  it('degrades silently to no signals without an api key', async () => {
    player(A);
    const boom = async () => { throw new Error('must not fetch'); };
    expect(await refreshSteamSignals({ db, apiKey: null, fetchFn: boom }, [A])).toBe(0);
    expect(getSteamSignals(db, A)).toBeNull();
  });

  it('ignores an id that is not a player', async () => {
    const steam = fakeSteam({ [A]: {} });
    expect(await refreshSteamSignals({ db, apiKey: 'key', fetchFn: steam.fetch }, [A])).toBe(0);
    expect(steam.calls).toEqual([]);
  });

  it('keeps what it knew when a later call fails or the profile goes private', async () => {
    player(A);
    const accounts = { [A]: { timecreated: 1_200_000_000, l4d1Minutes: 6120 as number | 'hidden', level: 14, bans: { vac: 1, daysSince: 3 } } };
    const steam = fakeSteam(accounts);
    await refreshSteamSignals({ db, apiKey: 'key', fetchFn: steam.fetch, now: () => NOW }, [A]);

    const later = new Date(NOW.getTime() + 86_400_000);
    steam.down.add('GetPlayerBans');
    steam.down.add('GetSteamLevel');
    delete (accounts[A] as { timecreated?: number }).timecreated;
    accounts[A].l4d1Minutes = 'hidden';
    await refreshSteamSignals({ db, apiKey: 'key', fetchFn: steam.fetch, now: () => later }, [A]);

    expect(getSteamSignals(db, A)).toMatchObject({
      time_created: 1_200_000_000, vac_bans: 1, days_since_last_ban: 3, bans_checked_at: NOW.toISOString(),
      steam_level: 14, games_visible: 0, l4d1_minutes: 6120, checked_at: later.toISOString(),
    });
  });

  it('writes nothing at all when Steam is unreachable', async () => {
    player(A);
    const steam = fakeSteam({ [A]: {} });
    steam.down.add('GetPlayerSummaries');
    steam.down.add('GetPlayerBans');
    expect(await refreshSteamSignals({ db, apiKey: 'key', fetchFn: steam.fetch }, [A])).toBe(0);
    expect(getSteamSignals(db, A)).toBeNull();
    // And it does not go on to ask the per-player endpoints of a dead API.
    expect(steam.calls.length).toBe(2);
  });

  it('remembers the last lender seen, and when, after the game is closed', async () => {
    player(A);
    const accounts: Record<string, { lender?: string }> = { [A]: { lender: LENDER } };
    const steam = fakeSteam(accounts);
    await refreshSteamSignals({ db, apiKey: 'key', fetchFn: steam.fetch, now: () => NOW }, [A], { sharing: true });
    delete accounts[A].lender;
    await refreshSteamSignals(
      { db, apiKey: 'key', fetchFn: steam.fetch, now: () => new Date(NOW.getTime() + 3_600_000) }, [A], { sharing: true },
    );
    expect(getSteamSignals(db, A)).toMatchObject({ lender_id: LENDER, lender_seen_at: NOW.toISOString() });
  });

  it('only asks about sharing for a player whose other signals are fresh', async () => {
    player(A);
    const steam = fakeSteam({ [A]: {} });
    const deps = { db, apiKey: 'key', fetchFn: steam.fetch, now: () => NOW };
    await refreshSteamSignals(deps, [A]);
    steam.calls.length = 0;
    await refreshSteamSignals(deps, [A], { sharing: true, freshMs: 3_600_000 });
    expect(steam.calls.length).toBe(1);
    expect(steam.calls[0]).toContain('IsPlayingSharedGame');
  });
});

describe('admin feed alerts', () => {
  it('posts once for a rostered player with a ban newer than a year', async () => {
    player(A);
    liveMatch(7, A);
    const steam = fakeSteam({ [A]: { bans: { vac: 1, game: 1, daysSince: 200 } } });
    const deps = { db, apiKey: 'key', fetchFn: steam.fetch, now: () => NOW };
    await refreshSteamSignals(deps, [A], { matchId: 7 });
    expect(events).toEqual([{
      kind: 'steam_signal', steamid: A, matchId: 7,
      signal: { what: 'recent_ban', vacBans: 1, gameBans: 1, daysSinceLastBan: 200 },
    }]);

    // The next match does not repost it.
    liveMatch(8, A);
    await refreshSteamSignals(deps, [A], { matchId: 8 });
    expect(events.length).toBe(1);
  });

  it('posts again when the account picks up another ban', async () => {
    player(A);
    const accounts = { [A]: { bans: { vac: 1, daysSince: 200 } as { vac: number; game?: number; daysSince: number } } };
    const steam = fakeSteam(accounts);
    const deps = { db, apiKey: 'key', fetchFn: steam.fetch, now: () => NOW };
    await refreshSteamSignals(deps, [A], { matchId: 7 });
    accounts[A].bans = { vac: 1, game: 1, daysSince: 0 };
    await refreshSteamSignals(deps, [A], { matchId: 8 });
    expect(events.length).toBe(2);
  });

  it('says nothing about an old ban, or outside a match', async () => {
    player(A);
    player(B);
    const steam = fakeSteam({ [A]: { bans: { vac: 1, daysSince: 366 } }, [B]: { bans: { vac: 1, daysSince: 5 } } });
    const deps = { db, apiKey: 'key', fetchFn: steam.fetch, now: () => NOW };
    await refreshSteamSignals(deps, [A], { matchId: 7 });
    await refreshSteamSignals(deps, [B]);
    expect(events).toEqual([]);
  });

  it('posts once when the game is borrowed from an account banned here', async () => {
    player(A);
    player(LENDER);
    banPlayer(db, LENDER, 'admin', 'cheating', null);
    events.length = 0;
    const steam = fakeSteam({ [A]: { lender: LENDER } });
    const deps = { db, apiKey: 'key', fetchFn: steam.fetch, now: () => NOW };
    await refreshSteamSignals(deps, [A], { sharing: true, matchId: 7 });
    await refreshSteamSignals(deps, [A], { sharing: true, matchId: 8 });
    expect(events).toEqual([{
      kind: 'steam_signal', steamid: A, matchId: 7, signal: { what: 'banned_lender', lenderId: LENDER },
    }]);
  });

  it('follows a lender that was merged into a banned account', async () => {
    player(A);
    player(B);
    banPlayer(db, B, 'admin', 'cheating', null);
    addAlias(db, { steamid: LENDER, canonical: B, by: 'admin' });
    events.length = 0;
    const steam = fakeSteam({ [A]: { lender: LENDER } });
    await refreshSteamSignals({ db, apiKey: 'key', fetchFn: steam.fetch, now: () => NOW }, [A], { sharing: true, matchId: 7 });
    expect(events.length).toBe(1);
  });

  it('says nothing about a lender in good standing, or a stale lender', async () => {
    player(A);
    player(LENDER);
    const accounts: Record<string, { lender?: string }> = { [A]: { lender: LENDER } };
    const steam = fakeSteam(accounts);
    const deps = { db, apiKey: 'key', fetchFn: steam.fetch, now: () => NOW };
    await refreshSteamSignals(deps, [A], { sharing: true, matchId: 7 });
    expect(events).toEqual([]);

    // Banned later, but the player now owns the game: the stored lender is
    // history, not what they are playing on tonight.
    banPlayer(db, LENDER, 'admin', 'cheating', null);
    events.length = 0;
    delete accounts[A].lender;
    await refreshSteamSignals(deps, [A], { sharing: true, matchId: 8 });
    expect(events).toEqual([]);
  });
});

describe('refreshStaleSignals', () => {
  it('takes a small batch: never checked first, then the oldest past seven days', async () => {
    const ids = Array.from({ length: SIGNAL_BATCH + 3 }, (_, i) => `7656119800000010${i}`);
    for (const id of ids) player(id);
    const steam = fakeSteam(Object.fromEntries(ids.map((id) => [id, {}])));
    const old = new Date(NOW.getTime() - SIGNAL_MAX_AGE_MS - 60_000);
    const fresh = new Date(NOW.getTime() - SIGNAL_MAX_AGE_MS + 60_000);
    await refreshSteamSignals({ db, apiKey: 'key', fetchFn: steam.fetch, now: () => old }, [ids[0]]);
    await refreshSteamSignals({ db, apiKey: 'key', fetchFn: steam.fetch, now: () => fresh }, [ids[1]]);
    steam.calls.length = 0;

    const deps = { db, apiKey: 'key', fetchFn: steam.fetch, now: () => NOW };
    expect(await refreshStaleSignals(deps)).toBe(SIGNAL_BATCH);
    // One batch request per endpoint, whatever the batch size.
    expect(steam.calls.filter((u) => u.includes('GetPlayerSummaries')).length).toBe(1);
    expect(steam.calls.filter((u) => u.includes('IsPlayingSharedGame')).length).toBe(0);
    expect(getSteamSignals(db, ids[1])!.checked_at).toBe(fresh.toISOString());
    expect(getSteamSignals(db, ids[0])!.checked_at).toBe(old.toISOString());

    expect(await refreshStaleSignals(deps)).toBe(2);
    expect(getSteamSignals(db, ids[0])!.checked_at).toBe(NOW.toISOString());
    expect(await refreshStaleSignals(deps)).toBe(0);
  });

  it('does nothing without an api key', async () => {
    player(A);
    const boom = async () => { throw new Error('must not fetch'); };
    expect(await refreshStaleSignals({ db, apiKey: null, fetchFn: boom })).toBe(0);
  });
});
