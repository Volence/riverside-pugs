import { describe, it, expect, beforeEach } from 'vitest';
import { openDb, type DB } from '../src/db.js';
import { addServer } from '../src/serverPool.js';
import { appendTournamentGame, createTournamentBooking, getBooking, peopleOf, recordPresence, setNext, sidesOf, advancePlaylist } from '../src/bookings/bookings.js';
import { createTournamentGame, gameLinesOf, isPendingGame } from '../src/bookings/tournamentGames.js';

const P = Array.from({ length: 10 }, (_, i) => `765611990000009${String(i).padStart(2, '0')}`);
const NOW = new Date('2026-10-07T20:00:00.000Z');
let db: DB;

beforeEach(() => {
  db = openDb(':memory:');
  const ins = db.prepare("INSERT INTO players (steamid, name, status) VALUES (?, ?, 'active')");
  P.forEach((id, i) => ins.run(id, `p${i}`));
});

const sides = () => [
  { teamId: null, captain: P[0]!, players: P.slice(0, 4), spectators: [P[8]!] },
  { teamId: null, captain: P[4]!, players: P.slice(4, 8), spectators: [] },
] as const;

describe('createTournamentBooking', () => {
  it('makes a confirmed booking that starts now with the locked four as players and the rest as spectators', () => {
    const r = createTournamentBooking(db, { region: 'na', campaign: 'no_mercy', rulesJson: '{}', rulesetId: null, gameConfig: 'standard', createdBy: P[9]!, sides: [sides()[0], sides()[1]], now: NOW });
    if (!r.ok) throw new Error(r.error);
    const b = getBooking(db, r.value.id)!;
    expect(b).toMatchObject({ purpose: 'tournament', state: 'scheduled', region: 'na', starts_at: NOW.toISOString(), games_allowed: 1, playlist_pos: 0, created_by: P[9], next_map: null });
    expect(JSON.parse(b.playlist_json)).toEqual(['no_mercy']);
    // 15 base + 60 typical + 10 slack = 85, up to the 30 minute step and the 60 minute floor: 90.
    expect(Date.parse(b.ends_at) - Date.parse(b.starts_at)).toBe(90 * 60_000);
    expect(sidesOf(db, b.id).map((s) => [s.side, s.captain_steamid, s.confirmed_at !== null])).toEqual([['a', P[0], true], ['b', P[4], true]]);
    expect(peopleOf(db, b.id).map((p) => [p.side, p.steamid, p.role, p.status])).toEqual([
      ...P.slice(0, 4).map((s) => ['a', s, 'player', 'accepted']), ['a', P[8], 'spectator', 'accepted'],
      ...P.slice(4, 8).map((s) => ['b', s, 'player', 'accepted']),
    ]);
    const ev = db.prepare('SELECT event, detail FROM booking_events WHERE booking_id = ?').all(b.id) as { event: string; detail: string }[];
    expect(ev).toEqual([{ event: 'created', detail: JSON.stringify({ purpose: 'tournament', campaign: 'no_mercy', minutes: 90 }) }]);
  });

  it('refuses an unknown campaign or a game config that is off', () => {
    expect(createTournamentBooking(db, { region: 'na', campaign: 'nowhere', rulesJson: '{}', rulesetId: null, gameConfig: 'standard', createdBy: P[9]!, sides: [sides()[0], sides()[1]], now: NOW })).toEqual({ ok: false, error: 'bad_campaign' });
    expect(createTournamentBooking(db, { region: 'na', campaign: 'no_mercy', rulesJson: '{}', rulesetId: null, gameConfig: 'nope', createdBy: P[9]!, sides: [sides()[0], sides()[1]], now: NOW })).toEqual({ ok: false, error: 'bad_config' });
  });
});

describe('appendTournamentGame, setNext with a map, presence', () => {
  it('grows the playlist, the count and the slot, and stages a single chapter as the next map', () => {
    const r = createTournamentBooking(db, { region: 'na', campaign: 'no_mercy', rulesJson: '{}', rulesetId: null, gameConfig: 'standard', createdBy: P[9]!, sides: [sides()[0], sides()[1]], now: NOW });
    if (!r.ok) throw new Error(r.error);
    const id = r.value.id;
    const a = appendTournamentGame(db, { bookingId: id, campaign: 'dead_air', map: null, now: NOW });
    expect(a).toEqual({ ok: true, value: { gamesAllowed: 2, endsAt: new Date(Date.parse(getBooking(db, id)!.starts_at) + 90 * 60_000 + 90 * 60_000).toISOString() } });
    const t = appendTournamentGame(db, { bookingId: id, campaign: 'dead_air', map: 'l4d_vs_airport04_terminal', now: NOW });
    expect(t.ok && t.value.gamesAllowed).toBe(3);
    expect(JSON.parse(getBooking(db, id)!.playlist_json)).toEqual(['no_mercy', 'dead_air', 'dead_air']);
    db.prepare("UPDATE bookings SET state = 'active' WHERE id = ?").run(id);
    expect(setNext(db, id, 'dead_air', NOW.toISOString(), NOW, null, 'l4d_vs_airport04_terminal')).toBe(true);
    expect(getBooking(db, id)).toMatchObject({ next_campaign: 'dead_air', next_map: 'l4d_vs_airport04_terminal' });
    expect(advancePlaylist(db, id, 2, NOW)).toBe(true);
    expect(getBooking(db, id)).toMatchObject({ next_campaign: null, next_map: null, playlist_pos: 2 });
    recordPresence(db, id, { a: 3, b: 4 }, true, NOW);
    expect(sidesOf(db, id).map((s) => [s.peak_present, s.present_now])).toEqual([[3, 3], [4, 4]]);
    recordPresence(db, id, { a: 1, b: 4 }, true, NOW);
    expect(sidesOf(db, id).map((s) => [s.peak_present, s.present_now])).toEqual([[3, 1], [4, 4]]);
    db.prepare("UPDATE bookings SET ending_at = ? WHERE id = ?").run(NOW.toISOString(), id);
    expect(appendTournamentGame(db, { bookingId: id, campaign: 'dead_air', map: null, now: NOW })).toEqual({ ok: false, error: 'wrong_state' });
  });
});

describe('createTournamentGame and gameLinesOf', () => {
  it('inserts a participants-only tournament game under the booking and builds the plugin burst', () => {
    const r = createTournamentBooking(db, { region: 'na', campaign: 'no_mercy', rulesJson: '{"x":1}', rulesetId: null, gameConfig: 'standard', createdBy: P[9]!, sides: [sides()[0], sides()[1]], now: NOW });
    if (!r.ok) throw new Error(r.error);
    const serverId = addServer(db, { name: 'box', host: '10.0.0.1', port: 27015, rconPort: 1, rconPassword: 'x' });
    const g = createTournamentGame(db, { bookingId: r.value.id, serverId, campaign: 'no_mercy', teams: { a: P.slice(4, 8), b: P.slice(0, 4) }, bookingSideA: 'b', now: NOW });
    const row = db.prepare('SELECT state, campaign, server_id, token, origin, kind, visibility, rules_json, game_config, booking_id, booking_side_a, went_live_at FROM matches WHERE id = ?').get(g.matchId) as Record<string, unknown>;
    expect(row).toEqual({ state: 'live', campaign: 'no_mercy', server_id: serverId, token: g.token, origin: 'queue', kind: 'tournament', visibility: 'participants', rules_json: '{"x":1}', game_config: 'standard', booking_id: r.value.id, booking_side_a: 'b', went_live_at: null });
    const players = db.prepare('SELECT player_id, team, source FROM match_players WHERE match_id = ? ORDER BY team, player_id').all(g.matchId);
    expect(players).toEqual([...P.slice(4, 8).map((s) => ({ player_id: s, team: 'a', source: 'web' })), ...P.slice(0, 4).map((s) => ({ player_id: s, team: 'b', source: 'web' }))]);
    expect(isPendingGame(db, g.matchId)).toBe(true);
    const lines = gameLinesOf(db, { matchId: g.matchId, stopAfterMap: 'l4d_vs_hospital04_interior', notice: 'Riverside Cup: Rats vs Bats, game 1' });
    expect(lines[0]).toBe(`sm_pug_match ${g.matchId} ${g.token} no_mercy "l4d_vs_hospital04_interior"`);
    expect(lines.slice(1, 9)).toEqual([...P.slice(4, 8).map((s) => `sm_pug_roster "${s}:a"`), ...P.slice(0, 4).map((s) => `sm_pug_roster "${s}:b"`)]);
    expect(lines[9]).toBe('l4d_ready_league_notice "Riverside Cup: Rats vs Bats, game 1"');
    expect(gameLinesOf(db, { matchId: g.matchId, stopAfterMap: null, notice: 'x' })[0]).toBe(`sm_pug_match ${g.matchId} ${g.token} no_mercy`);
    expect(() => gameLinesOf(db, { matchId: g.matchId, stopAfterMap: 'bad map;quit', notice: 'x' })).toThrow();
    db.prepare("INSERT INTO match_live (match_id, current_map, last_seen) VALUES (?, 'l4d_vs_hospital01_apartment', datetime('now'))").run(g.matchId);
    expect(isPendingGame(db, g.matchId)).toBe(false);
    expect((db.prepare("SELECT COUNT(*) AS n FROM booking_events WHERE booking_id = ? AND event = 'game_started'").get(r.value.id) as { n: number }).n).toBe(1);
  });
});
