import type { MatchRoomView, RoomGame } from '../api';
import type { CastDraftCard, CastDraftPick, CastDraftPlayer, CastDraftView, CastLiveRound, CastMatchView, CastPlayer, CastTeam, OverlayFeed, StudioState } from '../../../src/cast/types';

/**
 * A made-up match for the producer panel's preview while nothing is on air,
 * so a caster can see and set up every scene before a match exists. Never
 * sent to OBS: the overlay pages draw only the real feed (nothing on air is
 * a transparent frame there), and the panel labels the preview as a sample.
 */

const player = (steamid: string, name: string): CastPlayer => ({
  steamid, name, avatar: null, stats: { sidmg: 412, sikill: 7, ck: 96, skeets: 2, team_skeets: 1, dps_landed: 1, tank_damage: 940, boomer_spawns: 5, boom_successes: 2 }, sr: null,
  career: { scope: 'Season 1', matches: 42, wins: 23, losses: 19, skeets: 31, dps: 12, boomerRate: 38 }, role: null,
});

const team = (key: 'a' | 'b', name: string, tag: string, color: string, score: number, side: CastTeam['side'], names: string[]): CastTeam => ({
  key, name, tag, color, logoUrl: null, score, overridden: [], side,
  players: names.map((n, i) => player(`0000000000000${key === 'a' ? 1 : 2}00${i}`, n)),
});

export function sampleFeed(studio: StudioState, now: number): OverlayFeed {
  const a = team('a', 'Sample A', 'SMA', '#5b8fd9', 512, 'survivor', ['Survivor One', 'Survivor Two', 'Survivor Three', 'Survivor Four']);
  const b = team('b', 'Sample B', 'SMB', '#d9913f', 448, 'infected', ['Infected One', 'Infected Two', 'Infected Three', 'Infected Four']);
  const match: CastMatchView = {
    id: 0, kind: 'pug', state: 'live', campaign: 'dead_air', campaignName: 'Dead Air', currentMap: 'l4d_vs_airport02_offices',
    mapNumber: 2, mapCount: 4, half: 1, phase: 'live', phaseSinceMs: now - 180_000, winner: null,
    teams: { a, b },
    chapters: [
      { number: 1, map: 'l4d_vs_airport01_greenhouse', a: 512, b: 448, firstSurvivor: 'b', state: 'done' },
      { number: 2, map: 'l4d_vs_airport02_offices', a: null, b: null, firstSurvivor: 'a', state: 'playing' },
      { number: 3, map: 'l4d_vs_airport03_garage', a: null, b: null, firstSurvivor: null, state: 'next' },
      { number: 4, map: 'l4d_vs_airport04_terminal', a: null, b: null, firstSurvivor: null, state: 'next' },
    ],
    events: [], game: null, lastRound: null, winChanceA: 0.64,
  };
  const s = (i: number, character: string, health: number, temp: number, extra: Partial<CastLiveRound['survivors'][number]> = {}) => ({
    slot: i, steamid: a.players[i]!.steamid, name: a.players[i]!.name, character, health, temp, alive: true,
    incap: false, ledge: false, pinned: false, biled: false, weapon: 'Auto Shotgun', flow: 52, items: 3, dmg: 120, ...extra,
  });
  const live: CastLiveRound = {
    ordinal: 1, half: 1, map: 'l4d_vs_airport02_offices', tMs: 180_000, ageMs: 200,
    survivors: [
      s(0, 'bill', 71, 0, { items: 1 | 2 | 8 }),
      s(1, 'zoey', 38, 22, { items: 2 }),
      s(2, 'francis', 210, 0, { incap: true, items: 4 }),
      s(3, 'louis', 100, 0, { items: 1 }),
    ],
    infected: [
      { slot: 4, steamid: b.players[0]!.steamid, name: b.players[0]!.name, cls: 'hunter', ghost: false, alive: true, health: 250, dmg: 157 },
      { slot: 5, steamid: b.players[1]!.steamid, name: b.players[1]!.name, cls: 'tank', ghost: false, alive: true, health: 4200, dmg: 61 },
      { slot: 6, steamid: b.players[2]!.steamid, name: b.players[2]!.name, cls: 'smoker', ghost: true, alive: true, health: 0, dmg: 58 },
      { slot: 7, steamid: b.players[3]!.steamid, name: b.players[3]!.name, cls: '', ghost: false, alive: false, health: 0, dmg: 30 },
    ],
    tank: { health: 4200, maxHealth: 6000, controller: b.players[1]!.name },
    witches: 1,
    hud: { progress: 52, tank: 74, witch: 31, rivalReach: 61, scores: { round: 1, distance: 48, bonus: 131, alive: 4, mult: 1.25, hbPct: 47, pillsPct: 50, wiped: 60, made: 1155, gap: null } },
  };
  match.lastRound = {
    mapNumber: 2, map: 'l4d_vs_airport02_offices', half: 1,
    halves: [{ half: 1, survTeam: 'a', score: 412, alive: 3, seconds: 371 }],
    players: [...a.players.map((p, i) => ({ steamid: p.steamid, name: p.name, team: 'a' as const, stats: { sidmg: [930, 610, 420, 300][i] ?? 0, sikill: [9, 6, 4, 3][i] ?? 0, ck: [88, 71, 52, 40][i] ?? 0, skeets: [2, 0, 1, 0][i] ?? 0 } })),
      ...b.players.map((p, i) => ({ steamid: p.steamid, name: p.name, team: 'b' as const, stats: { damage_as_si: [212, 180, 96, 60][i] ?? 0, dps_landed: [1, 0, 0, 0][i] ?? 0, survivors_biled: [0, 3, 0, 1][i] ?? 0, dmg_as_tank: [0, 0, 240, 0][i] ?? 0 } }))],
  };
  return { rev: 0, serverNow: now, studio, match, live, tankRecap: null, witchRecap: null, casterAvatars: studio.casters.map(() => null), draft: sampleDraft(now), room: sampleRoom(now) };
}

/** A made-up draft for the panel's preview (drafts plan D2b2 Ruling 12):
 *  five teams, seven picks, pick 8 on the clock for Captain Three with 42 s
 *  left. Pick times are fixed, so the preview never fires a reveal. */
export function sampleDraft(now: number): CastDraftView {
  const card = (i: number, name: string, sr: number): CastDraftCard => ({
    steamid: `0000000000000${String(900 + i)}`, name, avatar: null, sr, pugs: 20 + i, form: ['W', 'L', 'W', 'W', 'L'],
    survivor: { siDamage: 640 + i * 10, commonKills: 88 }, infected: { damageAsSi: 180 + i * 4, dpsLanded: 0.6 }, bestClass: 'hunter',
  });
  const strip = (c: CastDraftCard): CastDraftPlayer => ({ steamid: c.steamid, name: c.name, avatar: c.avatar, sr: c.sr });
  const caps = ['Captain One', 'Captain Two', 'Captain Three', 'Captain Four', 'Captain Five'].map((n, i) => card(i, n, 1500 - i * 40));
  const pool = Array.from({ length: 15 }, (_, i) => card(10 + i, `Player ${i + 1}`, 1460 - i * 22));
  const taken = 7;
  // Snake over five teams: round 1 to teams 0..4, round 2 back from 4 to 0.
  const picks: CastDraftPick[] = pool.slice(0, taken).map((p, k) => ({
    pickNo: k + 1, round: k < 5 ? 1 : 2, captain: caps[k < 5 ? k : 9 - k]!.steamid, steamid: p.steamid, name: p.name,
    auto: k === 4, at: `2026-01-01T00:00:0${k}.000Z`,
  }));
  return {
    eventId: 0, eventName: 'Sample draft', status: 'running', deadlineAt: new Date(now + 42_000).toISOString(), pausedLeftMs: null,
    pickSeconds: 75, totalPicks: 15, rounds: 3,
    onClock: { pickNo: 8, round: 2, captain: caps[2]!.steamid, picker: caps[2]!.steamid },
    teams: caps.map((c, ti) => ({
      captain: strip(c),
      players: picks.filter((p) => p.captain === c.steamid).map((p) => strip(pool.find((x) => x.steamid === p.steamid)!)),
      slots: [ti + 1, 10 - ti, 11 + ti],
    })),
    picks,
    cards: Object.fromEntries(pool.slice(0, taken).map((c) => [c.steamid, c])),
    best: pool.slice(taken, taken + 3),
    poolLeft: 15 - taken,
  };
}

/** A made-up tournament room for the panel's preview (owner 2026-11-22): a
 *  total-score Bo2 with game 1 done and game 2 live, so the room scene and
 *  the series math show every part. */
export function sampleRoom(now: number): MatchRoomView {
  const entry = (id: number, name: string, tag: string, seed: number) => ({ id, name, tag, logoKey: null, seed, out: false });
  const game = (n: number, campaign: string, campaignName: string, over: Partial<RoomGame>): RoomGame => ({
    id: n, game: n, ordinal: n, tiebreak: false, campaign, campaignName, map: null, pickedBy: null, sideBy: null, firstSurvivors: null,
    matchId: null, state: 'upcoming', scoreA: null, scoreB: null, winner: null, forfeit: null, live: null, ...over,
  });
  const pool: MatchRoomView['pool'] = [
    { slug: 'no_mercy', name: 'No Mercy', state: 'picked', by: 'a', game: 1 },
    { slug: 'dead_air', name: 'Dead Air', state: 'banned', by: 'b', game: null },
    { slug: 'death_toll', name: 'Death Toll', state: 'banned', by: 'a', game: null },
    { slug: 'blood_harvest', name: 'Blood Harvest', state: 'picked', by: 'a', game: 2 },
    { slug: 'dead_center', name: 'Dead Center', state: 'banned', by: 'b', game: null },
    { slug: 'dark_carnival', name: 'Dark Carnival', state: 'open', by: null, game: null },
  ];
  return {
    id: 0, eventSlug: 'sample', eventName: 'Sample Cup', roundLabel: 'Grand final', a: entry(1, 'Sample A', 'SMA', 1), b: entry(2, 'Sample B', 'SMB', 2),
    phase: 'live', finishedAt: null, higher: 'a', deadline: null, serverNow: new Date(now).toISOString(), ready: { a: true, b: true },
    vetoSummary: 'Two games, total score: bans, picks and sides', pool, log: [],
    games: [
      game(1, 'no_mercy', 'No Mercy', { pickedBy: 'a', sideBy: 'b', firstSurvivors: 'b', matchId: 1, state: 'done', scoreA: 2211, scoreB: 2480, winner: 'b' }),
      game(2, 'blood_harvest', 'Blood Harvest', { pickedBy: 'a', sideBy: 'b', firstSurvivors: 'b', matchId: 2, state: 'live', live: { map: 'l4d_vs_farm03_bridge', scoreA: 930, scoreB: 148 } }),
    ],
    plan: [
      { kind: 'order', by: 'a', game: null, state: 'done', tentative: false },
      { kind: 'ban', by: 'b', game: null, state: 'done', tentative: false },
      { kind: 'ban', by: 'a', game: null, state: 'done', tentative: false },
      { kind: 'ban', by: 'b', game: null, state: 'done', tentative: false },
      { kind: 'pick', by: 'a', game: 1, state: 'done', tentative: false },
      { kind: 'side', by: 'b', game: 1, state: 'done', tentative: false },
      { kind: 'pick', by: 'a', game: 2, state: 'done', tentative: false },
      { kind: 'side', by: 'b', game: 2, state: 'done', tentative: false },
    ],
    next: null, lineups: { a: null, b: null, aLocked: true, bLocked: true }, holdReason: null, result: null, me: null,
    series: { bestOf: 2, totalScore: true, winsA: 0, winsB: 1, totalA: 2211, totalB: 2480, over: false, winner: null },
    server: null, confirm: null, dispute: null, frozen: false, schedule: null, pauses: [],
  };
}
