import { describe, it, expect, beforeEach } from 'vitest';
import { openDb, type DB } from '../src/db.js';
import { addServer } from '../src/serverPool.js';
import { appendTournamentGame, createTournamentBooking, getBooking, peopleOf, recordPresence, setNext, sidesOf, advancePlaylist, swapPlayer, beginMove, holdBox, markSetup, markReady } from '../src/bookings/bookings.js';
import { addTournamentSub, boxNeedsGame, createTournamentGame, gameLinesOf, isPendingGame } from '../src/bookings/tournamentGames.js';

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
    const all = gameLinesOf(db, { matchId: g.matchId, stopAfterMap: 'l4d_vs_hospital04_interior', notice: 'Riverside Cup: Rats vs Bats, game 1' });
    // T3b final review: no PUG abandon, no end kick, set before the match line.
    expect(all.slice(0, 2)).toEqual(['sm_pug_leave_budget 0', 'sm_pug_end_kick 0']);
    const lines = all.slice(2);
    expect(lines[0]).toBe(`sm_pug_match ${g.matchId} ${g.token} no_mercy "l4d_vs_hospital04_interior"`);
    expect(lines.slice(1, 9)).toEqual([...P.slice(4, 8).map((s) => `sm_pug_roster "${s}:a"`), ...P.slice(0, 4).map((s) => `sm_pug_roster "${s}:b"`)]);
    expect(lines[9]).toBe('l4d_ready_league_notice "Riverside Cup: Rats vs Bats, game 1"');
    expect(gameLinesOf(db, { matchId: g.matchId, stopAfterMap: null, notice: 'x' })[2]).toBe(`sm_pug_match ${g.matchId} ${g.token} no_mercy`);
    expect(() => gameLinesOf(db, { matchId: g.matchId, stopAfterMap: 'bad map;quit', notice: 'x' })).toThrow();
    db.prepare("INSERT INTO match_live (match_id, current_map, last_seen) VALUES (?, 'l4d_vs_hospital01_apartment', datetime('now'))").run(g.matchId);
    expect(isPendingGame(db, g.matchId)).toBe(false);
    expect((db.prepare("SELECT COUNT(*) AS n FROM booking_events WHERE booking_id = ? AND event = 'game_started'").get(r.value.id) as { n: number }).n).toBe(1);
  });
});

describe('boxNeedsGame (T3b final review)', () => {
  const body = (state: string, match: number) => `STATUS state=${state} match=${match} token=abc campaign=no_mercy map=x stopAfterMap=(none)\nSTATUS orient a=survivor b=infected\nSTATUS end`;
  it('wants the burst again only on a box that holds neither this game nor another live one', () => {
    expect(boxNeedsGame(body('none', 0), 5)).toBe(true);
    expect(boxNeedsGame(body('ended', 4), 5)).toBe(true);
    expect(boxNeedsGame(body('pending', 4), 5)).toBe(true);
    for (const s of ['pending', 'live', 'ended']) expect(boxNeedsGame(body(s, 5), 5)).toBe(false);
    expect(boxNeedsGame(body('live', 4), 5)).toBe(false);
    expect(boxNeedsGame('', 5)).toBe(false);
    expect(boxNeedsGame('Unknown command "sm_pug_status"', 5)).toBe(false);
  });
});

describe('swapPlayer and beginMove (plan T3c)', () => {
  const booked = () => {
    const r = createTournamentBooking(db, { region: 'na', campaign: 'no_mercy', rulesJson: '{}', rulesetId: null, gameConfig: 'standard', createdBy: P[9]!, sides: [sides()[0], sides()[1]], now: NOW });
    if (!r.ok) throw new Error(r.error);
    return r.value.id;
  };
  it('swaps a locked player and a spectator of the same side', () => {
    const id = booked();
    expect(swapPlayer(db, { bookingId: id, side: 'a', outId: P[8]!, inId: P[0]!, now: NOW })).toEqual({ ok: false, error: 'not_person' });
    expect(swapPlayer(db, { bookingId: id, side: 'a', outId: P[0]!, inId: P[4]!, now: NOW })).toEqual({ ok: false, error: 'not_person' });
    expect(swapPlayer(db, { bookingId: id, side: 'a', outId: P[0]!, inId: P[8]!, now: NOW })).toEqual({ ok: true, value: null });
    expect(peopleOf(db, id).filter((p) => p.side === 'a').map((p) => `${p.steamid}:${p.role}`).sort())
      .toEqual([`${P[0]}:spectator`, `${P[1]}:player`, `${P[2]}:player`, `${P[3]}:player`, `${P[8]}:player`].sort());
    expect(db.prepare("SELECT detail FROM booking_events WHERE booking_id = ? AND event = 'player_swapped'").get(id)).toEqual({ detail: JSON.stringify({ side: 'a', out: P[0], in: P[8] }) });
  });

  it('lets a running booking go of its box without marking the box offline', () => {
    const id = booked();
    const serverId = addServer(db, { name: 'box', host: '10.0.0.1', port: 27015, rconPort: 1, rconPassword: 'x' });
    db.prepare("UPDATE servers SET status = 'idle' WHERE id = ?").run(serverId);
    expect(beginMove(db, id, NOW)).toBeNull();
    expect(holdBox(db, id, serverId, NOW)).toBe(true);
    markSetup(db, id, NOW);
    markReady(db, id, NOW);
    expect(beginMove(db, id, NOW)).toBe(serverId);
    expect(getBooking(db, id)).toMatchObject({ server_id: null, recovering_at: NOW.toISOString(), recover_reason: 'gone', waiting_since: NOW.toISOString(), state: 'ready' });
    expect(db.prepare('SELECT status, gone_since FROM servers WHERE id = ?').get(serverId)).toEqual({ status: 'idle', gone_since: null });
    expect(beginMove(db, id, NOW)).toBeNull();
  });

  it('adds a sub to a tournament game with the maps finished so far', () => {
    const id = booked();
    const serverId = addServer(db, { name: 'box', host: '10.0.0.1', port: 27015, rconPort: 1, rconPassword: 'x' });
    const g = createTournamentGame(db, { bookingId: id, serverId, campaign: 'no_mercy', teams: { a: P.slice(0, 4), b: P.slice(4, 8) }, bookingSideA: 'a', now: NOW });
    const round = db.prepare("INSERT INTO match_rounds (match_id, ordinal, half, surv_team, score, ended_at) VALUES (?, ?, ?, 'a', 100, '2026-10-07 20:30:00')");
    round.run(g.matchId, 0, 1); round.run(g.matchId, 0, 2); round.run(g.matchId, 1, 1);
    expect(addTournamentSub(db, { matchId: g.matchId, inId: P[8]!, team: 'a', now: NOW })).toEqual({ joinedMap: 1 });
    expect(db.prepare('SELECT team, joined_map, source FROM match_players WHERE match_id = ? AND player_id = ?').get(g.matchId, P[8]!)).toEqual({ team: 'a', joined_map: 1, source: 'web' });
    // Again: the row stays as it was.
    expect(addTournamentSub(db, { matchId: g.matchId, inId: P[8]!, team: 'b', now: NOW })).toEqual({ joinedMap: 1 });
    expect(db.prepare('SELECT team FROM match_players WHERE match_id = ? AND player_id = ?').get(g.matchId, P[8]!)).toEqual({ team: 'a' });
  });

  it('swapPlayer refuses a booking that is over, an invited person, and pins a ringer coming in as a player', () => {
    const id = booked();
    const add = db.prepare("INSERT INTO booking_people (booking_id, side, steamid, role, status, added_by, added_at) VALUES (?, 'a', ?, ?, ?, ?, ?)");
    add.run(id, P[9]!, 'spectator', 'invited', P[0]!, NOW.toISOString());
    expect(swapPlayer(db, { bookingId: id, side: 'a', outId: P[0]!, inId: P[9]!, now: NOW })).toEqual({ ok: false, error: 'not_person' });
    db.prepare("UPDATE booking_people SET role = 'ringer', status = 'accepted' WHERE booking_id = ? AND steamid = ?").run(id, P[9]!);
    expect(swapPlayer(db, { bookingId: id, side: 'a', outId: P[0]!, inId: P[9]!, now: NOW })).toEqual({ ok: true, value: null });
    expect(peopleOf(db, id).filter((p) => p.steamid === P[9] || p.steamid === P[0]).map((p) => `${p.steamid}:${p.role}`).sort())
      .toEqual([`${P[0]}:spectator`, `${P[9]}:player`].sort());
    db.prepare('UPDATE bookings SET ending_at = ? WHERE id = ?').run(NOW.toISOString(), id);
    expect(swapPlayer(db, { bookingId: id, side: 'a', outId: P[1]!, inId: P[8]!, now: NOW })).toEqual({ ok: false, error: 'wrong_state' });
    expect(swapPlayer(db, { bookingId: 9999, side: 'a', outId: P[1]!, inId: P[8]!, now: NOW })).toEqual({ ok: false, error: 'not_found' });
  });

  it('beginMove takes an active booking off its box with one event, and refuses one that is ending', () => {
    const id = booked();
    const serverId = addServer(db, { name: 'box', host: '10.0.0.1', port: 27015, rconPort: 1, rconPassword: 'x' });
    db.prepare("UPDATE servers SET status = 'idle' WHERE id = ?").run(serverId);
    expect(holdBox(db, id, serverId, NOW)).toBe(true);
    markSetup(db, id, NOW);
    markReady(db, id, NOW);
    db.prepare("UPDATE bookings SET state = 'active' WHERE id = ?").run(id);
    db.prepare('UPDATE bookings SET ending_at = ? WHERE id = ?').run(NOW.toISOString(), id);
    expect(beginMove(db, id, NOW)).toBeNull();
    expect(getBooking(db, id)).toMatchObject({ server_id: serverId, recovering_at: null });
    db.prepare('UPDATE bookings SET ending_at = NULL WHERE id = ?').run(id);
    expect(beginMove(db, id, NOW)).toBe(serverId);
    expect(getBooking(db, id)).toMatchObject({ server_id: null, recover_reason: 'gone', state: 'active' });
    expect(db.prepare("SELECT detail FROM booking_events WHERE booking_id = ? AND event = 'box_moved_by_staff'").all(id)).toEqual([{ detail: JSON.stringify({ serverId }) }]);
  });

  it('addTournamentSub writes one sub_added event, none on a second call, and nothing on a PUG match', () => {
    const id = booked();
    const serverId = addServer(db, { name: 'box', host: '10.0.0.1', port: 27015, rconPort: 1, rconPassword: 'x' });
    const g = createTournamentGame(db, { bookingId: id, serverId, campaign: 'no_mercy', teams: { a: P.slice(0, 4), b: P.slice(4, 8) }, bookingSideA: 'a', now: NOW });
    addTournamentSub(db, { matchId: g.matchId, inId: P[8]!, team: 'a', now: NOW });
    addTournamentSub(db, { matchId: g.matchId, inId: P[8]!, team: 'a', now: NOW });
    expect(db.prepare("SELECT detail FROM booking_events WHERE booking_id = ? AND event = 'sub_added'").all(id))
      .toEqual([{ detail: JSON.stringify({ matchId: g.matchId, steamid: P[8], team: 'a', joinedMap: 0 }) }]);
    const pug = Number(db.prepare("INSERT INTO matches (season_id, state, campaign, origin) VALUES ((SELECT MAX(id) FROM seasons), 'live', 'no_mercy', 'in_game')").run().lastInsertRowid);
    expect(addTournamentSub(db, { matchId: pug, inId: P[8]!, team: 'a', now: NOW })).toBeNull();
    expect(db.prepare('SELECT COUNT(*) AS n FROM match_players WHERE match_id = ?').get(pug)).toEqual({ n: 0 });
  });
});
