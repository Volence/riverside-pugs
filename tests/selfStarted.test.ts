import { describe, it, expect, beforeEach, vi } from 'vitest';
import { openDb, type DB } from '../src/db.js';
import { upsertPlayer } from '../src/players.js';
import { SelfStartedMatches } from '../src/selfStarted.js';
import type { LogEvent } from '../src/logParse.js';

const TOKEN = '0123456789abcdef0123456789abcdef';
const MAP = 'l4d_vs_hospital01_apartment';

function ids(n: number): string[] {
  return Array.from({ length: n }, (_, i) => `7656119900000000${i}`);
}

function create(token = TOKEN, players = 2, map = MAP): LogEvent {
  return { kind: 'match_create', token, map, players };
}
function roster(steamid: string, team: 'a' | 'b', name = 'someone', token = TOKEN, joinedMap = 0): LogEvent {
  return { kind: 'match_roster', token, steamid, team, name, joinedMap };
}
function end(players = 2, token = TOKEN): LogEvent {
  return { kind: 'match_create_end', token, players };
}

let db: DB;
let registered: string[];
let setIds: Array<{ token: string; matchId: number }>;
let adopter: SelfStartedMatches;

function build(serverId: number | null = 1) {
  registered = [];
  setIds = [];
  adopter = new SelfStartedMatches({
    db,
    listener: { register: (t: string) => registered.push(t) },
    setMatchId: async (token, matchId) => { setIds.push({ token, matchId }); },
    resolveServerId: () => serverId,
    adminSteamIds: [],
  });
}

beforeEach(() => {
  db = openDb(':memory:');
  db.prepare(
    "INSERT INTO servers (name, host, port, rcon_port, rcon_password, status) VALUES ('t','127.0.0.1',27015,27015,'x','idle')",
  ).run();
  build();
});

async function burst(n = 2) {
  const [a, b] = ids(n);
  adopter.handle(create(TOKEN, n));
  adopter.handle(roster(a, 'a', 'Alice'));
  if (n > 1) adopter.handle(roster(b, 'b', 'Bob'));
  adopter.handle(end(n));
  await vi.waitFor(() => expect(setIds.length).toBe(1));
}

describe('SelfStartedMatches', () => {
  it('adds a late joiner to a live match from a lone MATCH_ROSTER line', async () => {
    await burst();
    const sub = '76561199000000009';
    adopter.handle(roster(sub, 'b', 'mayhem', TOKEN, 2));
    const rows = db.prepare('SELECT player_id, team, joined_map FROM match_players WHERE match_id = 1 ORDER BY player_id').all() as any[];
    expect(rows).toHaveLength(3);
    expect(rows.find((r) => r.player_id === sub)).toEqual({ player_id: sub, team: 'b', joined_map: 2 });
    expect((db.prepare('SELECT name, status FROM players WHERE steamid = ?').get(sub) as any)).toEqual({ name: 'mayhem', status: 'invited' });
    // A repeat of the same line changes nothing and creates no second match.
    adopter.handle(roster(sub, 'b', 'mayhem', TOKEN, 2));
    expect((db.prepare('SELECT COUNT(*) AS n FROM match_players WHERE match_id = 1').get() as any).n).toBe(3);
    expect((db.prepare('SELECT COUNT(*) AS n FROM matches').get() as any).n).toBe(1);
  });

  it('creates a live match with the right campaign, players and teams', async () => {
    await burst(2);
    const [a, b] = ids(2);

    const match = db.prepare('SELECT * FROM matches WHERE token = ?').get(TOKEN) as any;
    expect(match).toBeDefined();
    expect(match.state).toBe('live');
    expect(match.campaign).toBe('no_mercy');
    expect(match.server_id).toBe(1);

    const mp = db
      .prepare('SELECT player_id, team FROM match_players WHERE match_id = ? ORDER BY player_id')
      .all(match.id) as Array<{ player_id: string; team: string }>;
    expect(mp).toEqual([
      { player_id: a, team: 'a' },
      { player_id: b, team: 'b' },
    ]);
  });

  it('auto-creates unknown players using their in-game name', async () => {
    await burst(2);
    const row = db.prepare('SELECT name, status FROM players WHERE steamid = ?').get(ids(2)[0]) as any;
    expect(row.name).toBe('Alice');
    // Recorded, but not granted site access just for being in a server.
    expect(row.status).toBe('invited');
  });

  it('does NOT overwrite an existing player name or status', async () => {
    // Someone who already signed in has a real Steam persona and an avatar.
    // An in-game nickname must not clobber that.
    const [a] = ids(2);
    upsertPlayer(db, { steamid: a, name: 'RealPersona', avatar: 'http://x/y.jpg' }, []);
    db.prepare("UPDATE players SET status = 'active' WHERE steamid = ?").run(a);

    await burst(2);

    const row = db.prepare('SELECT name, status, avatar FROM players WHERE steamid = ?').get(a) as any;
    expect(row.name).toBe('RealPersona');
    expect(row.status).toBe('active');
    expect(row.avatar).toBe('http://x/y.jpg');
  });

  it('registers the token and hands the match id back to the plugin', async () => {
    await burst(2);
    const match = db.prepare('SELECT id FROM matches WHERE token = ?').get(TOKEN) as any;
    expect(registered).toEqual([TOKEN]);
    expect(setIds).toEqual([{ token: TOKEN, matchId: match.id }]);
  });

  it('is idempotent: a duplicate burst does not create a second match', async () => {
    await burst(2);
    adopter.handle(create(TOKEN, 2));
    adopter.handle(roster(ids(2)[0], 'a', 'Alice'));
    adopter.handle(end(2));
    await new Promise((r) => setTimeout(r, 30));

    const n = db.prepare('SELECT COUNT(*) AS n FROM matches').get() as { n: number };
    expect(n.n).toBe(1);
  });

  it('tolerates roster lines arriving before the create line', async () => {
    // UDP is unordered. Roster lines must not be dropped just for being early.
    const [a, b] = ids(2);
    adopter.handle(roster(a, 'a', 'Alice'));
    adopter.handle(create(TOKEN, 2));
    adopter.handle(roster(b, 'b', 'Bob'));
    adopter.handle(end(2));
    await vi.waitFor(() => expect(setIds.length).toBe(1));

    const match = db.prepare('SELECT id FROM matches WHERE token = ?').get(TOKEN) as any;
    const n = db.prepare('SELECT COUNT(*) AS n FROM match_players WHERE match_id = ?').get(match.id) as { n: number };
    expect(n.n).toBe(2);
  });

  it('commits once the expected roster has arrived even if MATCH_CREATE_END is lost', async () => {
    const [a, b] = ids(2);
    adopter.handle(create(TOKEN, 2));
    adopter.handle(roster(a, 'a', 'Alice'));
    adopter.handle(roster(b, 'b', 'Bob'));
    // no end line
    await vi.waitFor(() => expect(setIds.length).toBe(1));
  });

  it('refuses an unknown map rather than filing it under a wrong campaign', async () => {
    adopter.handle(create(TOKEN, 1, 'c5m1_waterfront'));
    adopter.handle(roster(ids(1)[0], 'a', 'Alice'));
    adopter.handle(end(1));
    await new Promise((r) => setTimeout(r, 30));

    expect(db.prepare('SELECT COUNT(*) AS n FROM matches').get()).toEqual({ n: 0 });
    expect(setIds).toEqual([]);
  });

  it('refuses to adopt when no server can be resolved', async () => {
    build(null);
    adopter.handle(create(TOKEN, 1));
    adopter.handle(roster(ids(1)[0], 'a', 'Alice'));
    adopter.handle(end(1));
    await new Promise((r) => setTimeout(r, 30));

    expect(db.prepare('SELECT COUNT(*) AS n FROM matches').get()).toEqual({ n: 0 });
  });

  it('ignores a burst with no roster at all', async () => {
    adopter.handle(create(TOKEN, 1));
    adopter.handle(end(1));
    await new Promise((r) => setTimeout(r, 30));
    expect(db.prepare('SELECT COUNT(*) AS n FROM matches').get()).toEqual({ n: 0 });
  });

  it('does not create a match if one with that token already exists', async () => {
    db.prepare(
      "INSERT INTO matches (season_id, state, campaign, token) VALUES (1, 'live', 'no_mercy', ?)",
    ).run(TOKEN);
    adopter.handle(create(TOKEN, 1));
    adopter.handle(roster(ids(1)[0], 'a', 'Alice'));
    adopter.handle(end(1));
    await new Promise((r) => setTimeout(r, 30));

    const n = db.prepare('SELECT COUNT(*) AS n FROM matches').get() as { n: number };
    expect(n.n).toBe(1);
  });

  it('survives setMatchId failing: the match is still recorded', async () => {
    // If the rcon call back to the plugin fails, the dump will later mismatch
    // on match id, but losing the row entirely would be worse.
    registered = [];
    setIds = [];
    adopter = new SelfStartedMatches({
      db,
      listener: { register: (t: string) => registered.push(t) },
      setMatchId: async () => { throw new Error('rcon down'); },
      resolveServerId: () => 1,
      adminSteamIds: [],
    });
    adopter.handle(create(TOKEN, 1));
    adopter.handle(roster(ids(1)[0], 'a', 'Alice'));
    adopter.handle(end(1));
    await vi.waitFor(() => {
      const n = db.prepare('SELECT COUNT(*) AS n FROM matches').get() as { n: number };
      expect(n.n).toBe(1);
    });
  });
});

describe('SelfStartedMatches: server status', () => {
  it('marks the server live so a queued match cannot claim it mid-PUG', async () => {
    await burst(2);
    const s = db.prepare('SELECT status FROM servers WHERE id = 1').get() as { status: string };
    expect(s.status).toBe('live');
  });
});
