import { describe, it, expect, beforeEach } from 'vitest';
import { openDb, type DB } from '../src/db.js';
import { upsertPlayer, ensureRating, currentSeasonId } from '../src/players.js';
import { mergePlayers, MERGE_HANDLED_PLAYER_COLUMNS } from '../src/mergePlayers.js';

const MAIN = '76561198005192652';
const ALT = '76561199861598482';
const OTHER = '76561197972484944';

let db: DB;

function match(id: number, state = 'completed'): void {
  db.prepare(
    "INSERT INTO matches (id, season_id, state, campaign, winner, ended_at) VALUES (?, 1, ?, 'dead_air', 'a', ?)",
  ).run(id, state, `2026-09-2${id} 00:00:00`);
}
function rosters(matchId: number, player: string, team: 'a' | 'b', stats: Partial<Record<string, number>> = {}): void {
  db.prepare(
    `INSERT INTO match_players (match_id, player_id, team, si_damage, si_kills, common_kills, ff_dealt, revives, joined_map)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)`,
  ).run(matchId, player, team, stats.si_damage ?? 0, stats.si_kills ?? 0, stats.common_kills ?? 0, stats.ff_dealt ?? 0, stats.revives ?? 0);
}
function stat(matchId: number, player: string, key: string, value: number): void {
  db.prepare('INSERT INTO match_player_stats (match_id, player_id, stat, value) VALUES (?, ?, ?, ?)')
    .run(matchId, player, key, value);
}

beforeEach(() => {
  db = openDb(':memory:');
  for (const id of [MAIN, ALT, OTHER]) upsertPlayer(db, { steamid: id, name: `n${id.slice(-2)}`, avatar: null }, []);
  for (const id of [MAIN, ALT, OTHER]) ensureRating(db, id);
});

describe('mergePlayers', () => {
  it('refuses to merge an account into itself, or an id it has never seen', () => {
    expect(() => mergePlayers(db, { from: MAIN, into: MAIN })).toThrow(/same/i);
    expect(() => mergePlayers(db, { from: '76561199999999999', into: MAIN })).toThrow(/not found/i);
    expect(() => mergePlayers(db, { from: ALT, into: '76561199999999999' })).toThrow(/not found/i);
  });

  it('moves a match only the alt played onto the main', () => {
    match(1);
    rosters(1, ALT, 'b', { si_damage: 3509, si_kills: 20, common_kills: 162, revives: 1 });
    stat(1, ALT, 'skeets', 4);

    mergePlayers(db, { from: ALT, into: MAIN });

    const row = db.prepare('SELECT * FROM match_players WHERE match_id = 1').get() as any;
    expect(row.player_id).toBe(MAIN);
    expect(row.si_damage).toBe(3509);
    expect((db.prepare('SELECT value FROM match_player_stats WHERE match_id = 1 AND player_id = ?').get(MAIN) as any).value).toBe(4);
  });

  // The shape match 65 actually had: both accounts rostered on the same team,
  // one of them a ghost that never connected and scored nothing.
  it('collapses a match both accounts were rostered in, summing their figures', () => {
    match(1);
    rosters(1, MAIN, 'b', { si_damage: 0, si_kills: 0, common_kills: 0, revives: 0 });
    rosters(1, ALT, 'b', { si_damage: 3509, si_kills: 20, common_kills: 162, revives: 1 });
    stat(1, MAIN, 'skeets', 0);
    stat(1, ALT, 'skeets', 7);

    mergePlayers(db, { from: ALT, into: MAIN });

    const rows = db.prepare('SELECT * FROM match_players WHERE match_id = 1').all() as any[];
    expect(rows).toHaveLength(1);
    expect(rows[0].player_id).toBe(MAIN);
    expect(rows[0].si_damage).toBe(3509);
    expect(rows[0].si_kills).toBe(20);
    expect(rows[0].common_kills).toBe(162);
    expect(rows[0].revives).toBe(1);

    const stats = db.prepare('SELECT player_id, value FROM match_player_stats WHERE match_id = 1').all() as any[];
    expect(stats).toEqual([{ player_id: MAIN, value: 7 }]);
  });

  it('leaves the team it plays for alone and never touches anyone else', () => {
    match(1);
    rosters(1, OTHER, 'a', { si_damage: 100 });
    rosters(1, ALT, 'b', { si_damage: 200 });
    mergePlayers(db, { from: ALT, into: MAIN });

    const rows = db.prepare('SELECT player_id, team, si_damage FROM match_players WHERE match_id = 1 ORDER BY team').all() as any[];
    expect(rows).toEqual([
      { player_id: OTHER, team: 'a', si_damage: 100 },
      { player_id: MAIN, team: 'b', si_damage: 200 },
    ]);
  });

  it('deletes the alt entirely: no player row, no rating, no history', () => {
    match(1);
    rosters(1, ALT, 'b');
    mergePlayers(db, { from: ALT, into: MAIN });

    expect(db.prepare('SELECT 1 FROM players WHERE steamid = ?').get(ALT)).toBeUndefined();
    expect(db.prepare('SELECT 1 FROM player_ratings WHERE player_id = ?').get(ALT)).toBeUndefined();
    expect(db.prepare('SELECT 1 FROM rating_history WHERE player_id = ?').get(ALT)).toBeUndefined();
    expect(db.prepare('SELECT 1 FROM match_players WHERE player_id = ?').get(ALT)).toBeUndefined();
  });

  // The reason the merge exists at all: two ratings for one person, and four
  // matches scored as five-a-side.
  it('recomputes the season so the merged player holds exactly one rating', () => {
    match(1);
    rosters(1, MAIN, 'a');
    rosters(1, ALT, 'a');
    rosters(1, OTHER, 'b');

    mergePlayers(db, { from: ALT, into: MAIN });

    const ratings = db.prepare('SELECT player_id FROM player_ratings WHERE season_id = ? ORDER BY player_id')
      .all(currentSeasonId(db)) as any[];
    expect(ratings.map((r) => r.player_id)).toEqual([MAIN, OTHER].sort());
    // Rebuilt from the merged rosters, so the win is counted once.
    const hist = db.prepare('SELECT COUNT(*) AS n FROM rating_history WHERE player_id = ?').get(MAIN) as any;
    expect(hist.n).toBe(1);
  });

  it('carries scratch and audit rows across, and drops a duplicate rather than failing', () => {
    match(1, 'live');
    db.prepare('INSERT INTO match_live_players (match_id, player_id, stats_json) VALUES (1, ?, ?)').run(MAIN, '{}');
    db.prepare('INSERT INTO match_live_players (match_id, player_id, stats_json) VALUES (1, ?, ?)').run(ALT, '{"skeets":3}');
    db.prepare("INSERT INTO match_chat (match_id, seq, map_ordinal, half, t_ms, steamid, team, message) VALUES (1,1,0,1,0,?,'b','hi')").run(ALT);

    expect(() => mergePlayers(db, { from: ALT, into: MAIN })).not.toThrow();
    expect(db.prepare('SELECT COUNT(*) AS n FROM match_live_players WHERE match_id = 1').get() as any).toEqual({ n: 1 });
    expect((db.prepare('SELECT steamid FROM match_chat').get() as any).steamid).toBe(MAIN);
  });

  // player_links and twitch_status both reference players with no cascade, so
  // one TikTok handle on the alt used to make the whole merge throw
  // "FOREIGN KEY constraint failed" and roll back.
  describe('an alt with a social profile', () => {
    const link = (player: string, platform: string, handle: string): void => {
      db.prepare('INSERT INTO player_links (player_id, platform, handle) VALUES (?, ?, ?)').run(player, platform, handle);
    };
    const twitch = (player: string, id: string, name: string): void => {
      db.prepare('UPDATE players SET twitch_id = ?, twitch_name = ? WHERE steamid = ?').run(id, name, player);
      db.prepare("INSERT INTO twitch_status (player_id, is_live, checked_at) VALUES (?, 1, '2026-09-21T00:00:00Z')").run(player);
    };
    const linksOf = (player: string) =>
      db.prepare('SELECT platform, handle FROM player_links WHERE player_id = ? ORDER BY platform').all(player);

    it('merges an alt that has one social link', () => {
      link(ALT, 'tiktok', 'alt_tt');
      expect(() => mergePlayers(db, { from: ALT, into: MAIN })).not.toThrow();
      expect(db.prepare('SELECT 1 FROM players WHERE steamid = ?').get(ALT)).toBeUndefined();
      expect(linksOf(MAIN)).toEqual([{ platform: 'tiktok', handle: 'alt_tt' }]);
    });

    it('keeps the main account\'s handle where both have the platform', () => {
      link(MAIN, 'tiktok', 'main_tt');
      link(ALT, 'tiktok', 'alt_tt');
      link(ALT, 'youtube', 'alt_yt');
      mergePlayers(db, { from: ALT, into: MAIN });
      expect(linksOf(MAIN)).toEqual([
        { platform: 'tiktok', handle: 'main_tt' },
        { platform: 'youtube', handle: 'alt_yt' },
      ]);
      expect(linksOf(ALT)).toEqual([]);
    });

    it('carries the alt\'s Twitch link over when the main has none', () => {
      twitch(ALT, '4242', 'alt_tv');
      mergePlayers(db, { from: ALT, into: MAIN });
      expect(db.prepare('SELECT twitch_id, twitch_name FROM players WHERE steamid = ?').get(MAIN))
        .toEqual({ twitch_id: '4242', twitch_name: 'alt_tv' });
      expect(db.prepare('SELECT player_id, is_live FROM twitch_status').all()).toEqual([{ player_id: MAIN, is_live: 1 }]);
    });

    it('keeps the main\'s Twitch link and drops the alt\'s when both have one', () => {
      twitch(MAIN, '1111', 'main_tv');
      twitch(ALT, '4242', 'alt_tv');
      mergePlayers(db, { from: ALT, into: MAIN });
      expect(db.prepare('SELECT twitch_id, twitch_name FROM players WHERE steamid = ?').get(MAIN))
        .toEqual({ twitch_id: '1111', twitch_name: 'main_tv' });
      expect(db.prepare('SELECT player_id FROM twitch_status').all()).toEqual([{ player_id: MAIN }]);
      // The alt's Twitch account is free to be linked again, by anyone.
      expect(db.prepare("SELECT 1 FROM players WHERE twitch_id = '4242'").get()).toBeUndefined();
    });

    it('counts both in a dry run, and changes nothing', () => {
      link(ALT, 'tiktok', 'alt_tt');
      twitch(ALT, '4242', 'alt_tv');
      const plan = mergePlayers(db, { from: ALT, into: MAIN, dryRun: true });
      expect(plan.rowsByTable.player_links).toBe(1);
      expect(plan.rowsByTable.twitch_status).toBe(1);
      expect(linksOf(ALT)).toHaveLength(1);
      expect(linksOf(MAIN)).toHaveLength(0);
    });
  });

  // Evidence against an alt is evidence against the person. None of these
  // tables has a foreign key, so leaving them out never failed: the rows just
  // stayed on an id with no player row and no admin page.
  describe('anti-cheat evidence follows the merge', () => {
    beforeEach(() => {
      db.prepare(
        "INSERT INTO integrity_flags (steamid, source, kind, severity, at) VALUES (?, 'lilac', 'aimbot', 'high', '2026-09-21T00:00:00Z')",
      ).run(ALT);
      db.prepare(
        `INSERT INTO input_bursts (id, steamid, kind, n, ground_ticks, air_presses, server_tick, client_tick, intervals, at)
         VALUES (1, ?, 'fire', 3, 0, 0, 1, 1, '3,3,3', '2026-09-21T00:00:00Z')`,
      ).run(ALT);
      db.prepare(
        "INSERT INTO input_detections (burst_id, steamid, kind, signature, severity, at) VALUES (1, ?, 'fire', 'rate', 'high', '2026-09-21T00:00:00Z')",
      ).run(ALT);
      db.prepare(
        "INSERT INTO signon_drops (steamid, name, secs_connected, forced_count, at) VALUES (?, 'alt', 4, 651, '2026-09-21T00:00:00Z')",
      ).run(ALT);
    });

    it('moves flags, bursts, detections and signon drops', () => {
      mergePlayers(db, { from: ALT, into: MAIN });
      for (const table of ['integrity_flags', 'input_bursts', 'input_detections', 'signon_drops']) {
        expect(db.prepare(`SELECT steamid FROM ${table}`).all(), table).toEqual([{ steamid: MAIN }]);
      }
    });

    it('reports them in a dry run', () => {
      const plan = mergePlayers(db, { from: ALT, into: MAIN, dryRun: true });
      expect(plan.rowsByTable).toMatchObject({ integrity_flags: 1, input_bursts: 1, input_detections: 1, signon_drops: 1 });
    });

    it('moves network sightings, adding up an address both accounts were seen on', () => {
      const seen = (player: string, hash: string, first: string, last: string, n: number): void => {
        db.prepare(
          'INSERT INTO player_networks (player_id, ip_hash, country, first_seen, last_seen, seen_count) VALUES (?, ?, NULL, ?, ?, ?)',
        ).run(player, hash, first, last, n);
      };
      seen(MAIN, 'shared', '2026-09-10T00:00:00Z', '2026-09-12T00:00:00Z', 2);
      seen(ALT, 'shared', '2026-09-08T00:00:00Z', '2026-09-20T00:00:00Z', 5);
      seen(ALT, 'altonly', '2026-09-09T00:00:00Z', '2026-09-09T00:00:00Z', 1);

      const plan = mergePlayers(db, { from: ALT, into: MAIN, dryRun: true });
      expect(plan.rowsByTable.player_networks).toBe(2);
      mergePlayers(db, { from: ALT, into: MAIN });

      expect(db.prepare('SELECT player_id, ip_hash, first_seen, last_seen, seen_count FROM player_networks ORDER BY ip_hash').all())
        .toEqual([
          { player_id: MAIN, ip_hash: 'altonly', first_seen: '2026-09-09T00:00:00Z', last_seen: '2026-09-09T00:00:00Z', seen_count: 1 },
          { player_id: MAIN, ip_hash: 'shared', first_seen: '2026-09-08T00:00:00Z', last_seen: '2026-09-20T00:00:00Z', seen_count: 7 },
        ]);
    });
  });

  it('reports what it moved, so a dry run can be read before it is committed', () => {
    match(1);
    rosters(1, ALT, 'b');
    stat(1, ALT, 'skeets', 2);
    const plan = mergePlayers(db, { from: ALT, into: MAIN, dryRun: true });

    expect(plan.matchesMoved).toBe(1);
    expect(plan.rowsByTable.match_players).toBe(1);
    expect(plan.rowsByTable.match_player_stats).toBe(1);
    // Nothing actually changed.
    expect(db.prepare('SELECT 1 FROM players WHERE steamid = ?').get(ALT)).toBeTruthy();
    expect((db.prepare('SELECT player_id FROM match_players WHERE match_id = 1').get() as any).player_id).toBe(ALT);
  });

  // Endorsements have two player columns inside one primary key, so they
  // were not covered by PLAIN or KEYED and the merge threw a foreign key
  // violation the moment either column pointed at a deleted player.
  describe('endorsements', () => {
    function endorse(matchId: number, from: string, to: string, kind = 'vibes'): void {
      db.prepare(
        "INSERT INTO endorsements (match_id, from_id, to_id, kind, created_at) VALUES (?, ?, ?, ?, datetime('now'))",
      ).run(matchId, from, to, kind);
    }

    it('merges when `from` gave an endorsement', () => {
      match(1);
      endorse(1, ALT, OTHER);

      expect(() => mergePlayers(db, { from: ALT, into: MAIN })).not.toThrow();
      const row = db.prepare('SELECT from_id, to_id FROM endorsements WHERE match_id = 1').get() as any;
      expect(row).toEqual({ from_id: MAIN, to_id: OTHER });
    });

    it('merges when `from` received an endorsement', () => {
      match(1);
      endorse(1, OTHER, ALT, 'caller');

      expect(() => mergePlayers(db, { from: ALT, into: MAIN })).not.toThrow();
      const row = db.prepare('SELECT from_id, to_id FROM endorsements WHERE match_id = 1').get() as any;
      expect(row).toEqual({ from_id: OTHER, to_id: MAIN });
    });

    it('collapses to one row when the same giver endorsed both accounts on one match', () => {
      match(1);
      endorse(1, OTHER, MAIN, 'clutch');
      endorse(1, OTHER, ALT, 'vibes');

      expect(() => mergePlayers(db, { from: ALT, into: MAIN })).not.toThrow();
      const rows = db.prepare('SELECT from_id, to_id FROM endorsements WHERE match_id = 1').all() as any[];
      expect(rows).toEqual([{ from_id: OTHER, to_id: MAIN }]);
    });

    it('drops an endorsement between the two merged accounts instead of leaving a self endorsement', () => {
      match(1);
      endorse(1, MAIN, ALT, 'caller');

      mergePlayers(db, { from: ALT, into: MAIN });

      expect(db.prepare('SELECT 1 FROM endorsements WHERE match_id = 1').get()).toBeUndefined();
    });

    it('reports the endorsements count on a dry run and changes nothing', () => {
      match(1);
      endorse(1, ALT, OTHER);
      endorse(1, OTHER, ALT, 'caller');

      const plan = mergePlayers(db, { from: ALT, into: MAIN, dryRun: true });

      expect(plan.rowsByTable.endorsements).toBe(2);
      expect((db.prepare('SELECT from_id, to_id FROM endorsements WHERE match_id = 1 AND from_id = ?').get(ALT) as any))
        .toEqual({ from_id: ALT, to_id: OTHER });
    });
  });

  // Predates this branch: player_links and twitch_status were added to the
  // schema with a foreign key on players and never taught to the merge, so
  // an alt's socials and Twitch cache silently stayed behind under a steamid
  // that no longer resolved to anyone.
  it('handles every foreign key that points at players', () => {
    const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[])
      .map((r) => r.name);
    const refs: [string, string][] = [];
    for (const table of tables) {
      const fks = db.prepare(`PRAGMA foreign_key_list(${table})`).all() as { table: string; from: string }[];
      for (const fk of fks) if (fk.table === 'players') refs.push([table, fk.from]);
    }
    for (const ref of refs) expect(MERGE_HANDLED_PLAYER_COLUMNS).toContainEqual(ref);
  });

  it('moves player_links and twitch_status onto the surviving account', () => {
    db.prepare("INSERT INTO player_links (player_id, platform, handle) VALUES (?, 'twitter', 'alt_handle')").run(ALT);
    // The cached status follows the Twitch link and nothing else, so the alt
    // needs a linked channel for its row to move: a status without a link
    // would show the survivor live on a channel that is not theirs.
    db.prepare("UPDATE players SET twitch_id = 'tw_alt', twitch_name = 'alt_tv' WHERE steamid = ?").run(ALT);
    db.prepare("INSERT INTO twitch_status (player_id, is_live, checked_at) VALUES (?, 0, datetime('now'))").run(ALT);

    mergePlayers(db, { from: ALT, into: MAIN });

    expect((db.prepare('SELECT handle FROM player_links WHERE player_id = ?').get(MAIN) as any).handle).toBe('alt_handle');
    expect(db.prepare('SELECT 1 FROM twitch_status WHERE player_id = ?').get(MAIN)).toBeTruthy();
    expect(db.prepare('SELECT 1 FROM player_links WHERE player_id = ?').get(ALT)).toBeUndefined();
    expect(db.prepare('SELECT 1 FROM twitch_status WHERE player_id = ?').get(ALT)).toBeUndefined();
  });

  it('keeps the surviving account row for player_links and twitch_status when both already have one', () => {
    db.prepare("INSERT INTO player_links (player_id, platform, handle) VALUES (?, 'twitter', 'main_handle')").run(MAIN);
    db.prepare("INSERT INTO player_links (player_id, platform, handle) VALUES (?, 'twitter', 'alt_handle')").run(ALT);
    db.prepare("INSERT INTO twitch_status (player_id, is_live, checked_at) VALUES (?, 1, datetime('now'))").run(MAIN);
    db.prepare("INSERT INTO twitch_status (player_id, is_live, checked_at) VALUES (?, 0, datetime('now'))").run(ALT);

    mergePlayers(db, { from: ALT, into: MAIN });

    expect((db.prepare('SELECT handle FROM player_links WHERE player_id = ?').get(MAIN) as any).handle).toBe('main_handle');
    expect((db.prepare('SELECT is_live FROM twitch_status WHERE player_id = ?').get(MAIN) as any).is_live).toBe(1);
  });
});
