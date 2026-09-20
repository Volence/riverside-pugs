import { describe, it, expect, beforeEach, vi } from 'vitest';
import { openDb, type DB } from '../src/db.js';
import { upsertPlayer } from '../src/players.js';
import { SelfStartedMatches } from '../src/selfStarted.js';
import type { LogEvent } from '../src/logParse.js';
import { subscribeAdminEvents } from '../src/adminFeed.js';
import { addAlias, canonicalise } from '../src/aliases.js';

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

// Match 65 (2026-09-20): a player connected on a second Steam account that
// had never signed in anywhere, and the plugin rostered both of his accounts.
// Team B went to five, the account that never connected held a replay slot as
// a permanently empty panel, the account that actually played fell off the end
// of the eight the replay format carries, and both were rated, scoring his
// team as a five-man side in four matches.
//
// Nothing in here refuses a roster wholesale: a roster line describes players
// who are ON the server, and dropping one loses a real person's stats. What it
// refuses is the one shape that cannot be legitimate, and it reports the rest.
describe('SelfStartedMatches over-full teams', () => {
  const problems: string[] = [];
  let unsub: () => void;
  beforeEach(() => {
    problems.length = 0;
    unsub?.();
    unsub = subscribeAdminEvents((e) => { if (e.kind === 'problem') problems.push(e.text); });
  });

  async function fullTeamB(): Promise<string[]> {
    const members = ids(8);
    adopter.handle(create(TOKEN, 8));
    members.forEach((id, i) => adopter.handle(roster(id, i < 4 ? 'a' : 'b', `p${i}`)));
    adopter.handle(end(8));
    await vi.waitFor(() => expect(setIds.length).toBe(1));
    return members;
  }

  it('commits an over-full burst rather than dropping anyone, and says so', async () => {
    const members = ids(9);
    adopter.handle(create(TOKEN, 9));
    members.forEach((id, i) => adopter.handle(roster(id, i < 4 ? 'a' : 'b', `p${i}`)));
    adopter.handle(end(9));
    await vi.waitFor(() => expect(setIds.length).toBe(1));

    // Everyone is rostered: the fifth player is really on the server and
    // really scoring, and silently dropping them would lose that.
    const n = db.prepare("SELECT COUNT(*) AS n FROM match_players WHERE match_id = 1 AND team = 'b'").get() as any;
    expect(n.n).toBe(5);
    expect(problems.join('\n')).toMatch(/team b/i);
    expect(problems.join('\n')).toMatch(/5/);
  });

  it('refuses a late joiner onto a full team when that account has never signed in', async () => {
    await fullTeamB();
    const alt = '76561199861598482';
    adopter.handle(roster(alt, 'b', 'mayhem', TOKEN, 2));

    expect(db.prepare('SELECT 1 FROM match_players WHERE match_id = 1 AND player_id = ?').get(alt)).toBeUndefined();
    // And no player row is conjured for it either, which is what gave the alt
    // a rating of its own.
    expect(db.prepare('SELECT 1 FROM players WHERE steamid = ?').get(alt)).toBeUndefined();
    expect(problems.join('\n')).toMatch(/mayhem/);
  });

  it('still allows a known player to sub onto a full team, and reports it', async () => {
    await fullTeamB();
    const sub = '76561198000000123';
    upsertPlayer(db, { steamid: sub, name: 'sub', avatar: null }, [sub]); // admin => active

    adopter.handle(roster(sub, 'b', 'sub', TOKEN, 2));
    expect(db.prepare('SELECT 1 FROM match_players WHERE match_id = 1 AND player_id = ?').get(sub)).toBeTruthy();
    expect(problems.join('\n')).toMatch(/sub/);
  });

  // The end of the story that started with match 65: once the two accounts
  // are merged, the alt is not refused, it is simply the person. This is what
  // makes the merge permanent rather than a nightly chore.
  it('rosters a merged alt as the account it was merged into, not as a fifth player', async () => {
    const members = await fullTeamB();
    const alt = '76561199861598482';
    addAlias(db, { steamid: alt, canonical: members[4], by: 'admin' });

    // What server.ts does to every datagram before dispatching it.
    adopter.handle(canonicalise(db, roster(alt, 'b', 'mayhem', TOKEN, 2)));

    expect(db.prepare("SELECT COUNT(*) AS n FROM match_players WHERE match_id = 1 AND team = 'b'").get())
      .toEqual({ n: 4 });
    expect(db.prepare('SELECT 1 FROM players WHERE steamid = ?').get(alt)).toBeUndefined();
    expect(problems).toEqual([]);
  });

  it('says nothing when a late joiner lands on a team with room', async () => {
    await burst();
    adopter.handle(roster('76561199000000009', 'b', 'mayhem', TOKEN, 2));
    expect(problems).toEqual([]);
  });
});

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
    adopter.handle(create(TOKEN, 1, 'de_dust2'));
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

describe('SelfStartedMatches: the no-show reaper must not see these', () => {
  // went_live_at is the no-show reaper's entire scope guard (src/noShow.ts).
  // Stamping it here enrolled adopted matches in a reaper they can never
  // satisfy: rule 1 counts match_players.connected_at, which is written only
  // from `PLAYER ... event=connect`, which the plugin emits only from
  // OnClientPostAdminCheck for a client joining a match that already has a
  // roster. An adopted match snapshots its roster from players who are already
  // in game, so that forward never fires and all eight stay NULL. Ten minutes
  // after adoption the reaper would abort a match being actively played and
  // hand its server to the next queue pop, which would changelevel everyone
  // out mid-match. The reaper is for web-driven matches only.
  it('leaves went_live_at NULL so an adopted match is out of the reaper scope', async () => {
    await burst(2);
    const m = db.prepare('SELECT state, went_live_at FROM matches WHERE id = 1').get() as
      { state: string; went_live_at: string | null };
    expect(m.state).toBe('live');
    expect(m.went_live_at).toBeNull();
  });
});
