import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import * as B from '../src/bookings/bookings.js';
import { recordResultFlow } from '../src/events/flow.js';
import * as R from '../src/events/room.js';
import * as E from '../src/events/events.js';
import { matchRoomView } from '../src/events/roomViews.js';
import { SERVER_ALERT_MS, PRESENCE_FALLBACK_MS, DEFAULT_GRACE_MINUTES } from '../src/events/series.js';
import { presetConfig } from '../src/events/vetoConfig.js';
import { adminEventRoutes } from '../src/routes/adminEvents.js';
import { eventRoutes } from '../src/routes/events.js';
import type { AdminEvent } from '../src/adminFeed.js';
import { authedCookie } from './helpers.js';
import { ADMIN, NOW } from './eventFixture.js';
import { A, B as BATS } from './entryFixture.js';
import { POOL7, TIMERS, type RoomFixture } from './roomFixture.js';
import { MIN, driveLoserPicks, seriesFixture, type SeriesFixture } from './seriesFixture.js';
import { ServerReleaser } from '../src/serverRelease.js';
import { claimIdle, claimableServers } from '../src/serverPool.js';
import { isHeld } from '../src/serverHolds.js';
import { invalidateCampaignCache, setMissionsDirs } from '../src/campaignRegistry.js';
import { EVENT_ERRORS } from '../src/events/validate.js';
import { adminPauseTook, parseSubReply } from '../src/events/series.js';
import { recordPresenceLine } from '../src/presence.js';
import { restoreSnapshot } from '../src/bookings/restore.js';

// addTournamentSub returns null for a game that is not a tournament one; the
// engine's token lookup cannot reach that, so a test forces it (plan T3c ledger).
const subHook = vi.hoisted(() => ({ nullNext: false }));
vi.mock('../src/bookings/tournamentGames.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../src/bookings/tournamentGames.js')>();
  return { ...orig, addTournamentSub: (...a: Parameters<typeof orig.addTournamentSub>) => (subHook.nullNext ? null : orig.addTournamentSub(...a)) };
});

/** A restore needs the campaign's chapter list (the base game's missions file). */
function useNoMercy(): void {
  const NO_MERCY = `"mission"
{
  "Name" "hospital"
  "DisplayTitle" "No Mercy"
  "modes"
  {
    "versus"
    {
      "1" { "Map" "l4d_vs_hospital01_apartment" "DisplayName" "The Apartments" }
      "2" { "Map" "l4d_vs_hospital02_subway" "DisplayName" "The Subway" }
      "3" { "Map" "l4d_vs_hospital03_sewers" "DisplayName" "The Sewers" }
      "4" { "Map" "l4d_vs_hospital04_interior" "DisplayName" "The Hospital" }
      "5" { "Map" "l4d_vs_hospital05_rooftop" "DisplayName" "Rooftop Finale" }
    }
  }
}
`;
  let missionsDir = '';
  beforeEach(() => {
    missionsDir = mkdtempSync(join(tmpdir(), 'missions-'));
    writeFileSync(join(missionsDir, 'hospital.txt'), NO_MERCY);
    setMissionsDirs([missionsDir]);
    invalidateCampaignCache();
  });
  afterEach(() => {
    setMissionsDirs([]);
    invalidateCampaignCache();
    rmSync(missionsDir, { recursive: true, force: true });
  });
}

let f: SeriesFixture;
afterEach(() => f?.close());

describe('SeriesEngine: booking, the game burst and connect', () => {
  it('books a server the moment lineups lock, pushes game 1 with the veto\'s sides before the changelevel, and opens connect with a DM', async () => {
    f = await seriesFixture();
    await f.tick();
    const b = f.booking();
    expect(b).toMatchObject({ purpose: 'tournament', state: 'ready', games_allowed: 1, region: 'na' });
    expect(JSON.parse(b.playlist_json)).toEqual(['no_mercy']);
    expect(B.peopleOf(f.db, b.id).map((p) => [p.side, p.steamid, p.role])).toEqual([
      ...A.slice(0, 4).map((s) => ['a', s, 'player']), ['a', A[4], 'spectator'], ...BATS.slice(0, 4).map((s) => ['b', s, 'player']),
    ]);
    const m = f.match();
    expect(m).toMatchObject({ status: 'connect', booking_id: b.id, booked_at: new Date(f.t.t).toISOString() });
    expect(m.deadline).toBe(new Date(f.t.t + B.bookingRules(b)!.noShowGraceMinutes * MIN).toISOString());
    const g1 = f.gameOf(1);
    expect(g1.match_id).not.toBeNull();
    expect(f.db.prepare('SELECT booking_side_a, kind, visibility, state FROM matches WHERE id = ?').get(g1.match_id!)).toEqual({ booking_side_a: 'b', kind: 'tournament', visibility: 'participants', state: 'live' });
    expect(f.sent).toContain('sm_pug_auto_track 0');
    const matchLine = f.sent.find((c) => c.startsWith('sm_pug_match '))!;
    expect(matchLine).toMatch(new RegExp(`^sm_pug_match ${g1.match_id} [A-Za-z0-9]+ no_mercy( "l4d_vs_hospital\\w+")?$`));
    expect(f.sent.indexOf(matchLine)).toBeLessThan(f.sent.indexOf('changelevel l4d_vs_hospital01_apartment'));
    // T3b final review: no PUG abandon and no end kick on a tournament box, set in the game burst itself.
    const burst = f.sent.slice(0, f.sent.indexOf(matchLine));
    expect(burst.slice(-3)).toEqual(['sm_pug_tournament 1', 'sm_pug_leave_budget 0', 'sm_pug_end_kick 0']);
    // Bats survive first: their four are pug team a.
    expect(f.sent.filter((c) => c.startsWith('sm_pug_roster '))).toEqual([...BATS.slice(0, 4).map((s) => `sm_pug_roster "${s}:a"`), ...A.slice(0, 4).map((s) => `sm_pug_roster "${s}:b"`)]);
    expect(f.sent.some((c) => c.startsWith('say [Match] Game 1: No Mercy. Bats start as survivors.'))).toBe(true);
    expect(f.send).toHaveBeenCalledWith(expect.arrayContaining([A[0], A[4], BATS[3]]), 'event_match_connect', expect.objectContaining({ content: expect.stringContaining(`password ${b.password}`) }));
    expect(f.send).not.toHaveBeenCalledWith(expect.anything(), 'booking_ready', expect.anything());
    expect(f.pushes).toContain(f.matchId);
  });

  it('waits for a server, alerts staff once after ten minutes, and takes the first box freed', async () => {
    f = await seriesFixture();
    f.db.prepare("UPDATE servers SET status = 'live'").run();
    await f.tick();
    expect(f.match()).toMatchObject({ status: 'booking', server_alerted_at: null });
    expect(f.booking()).toMatchObject({ state: 'scheduled', server_id: null, ending_at: null });
    f.t.t += SERVER_ALERT_MS;
    await f.tick();
    await f.tick();
    expect(f.alerts.filter((a) => a.kind === 'problem' && a.text.includes('waited 10 minutes'))).toHaveLength(1);
    expect(f.match().server_alerted_at).not.toBeNull();
    f.db.prepare("UPDATE servers SET status = 'idle'").run();
    await f.tick();
    expect(f.match().status).toBe('connect');
  });

  it('re-pushes the game burst each minute until the game heartbeats, only to a box that lost it', async () => {
    f = await seriesFixture();
    await f.tick();
    const line = f.sent.find((c) => c.startsWith('sm_pug_match '))!;
    // The box holds the game (pending): nothing is sent again.
    f.sent.length = 0;
    f.t.t += MIN;
    await f.tick();
    expect(f.sent).toContain('sm_pug_status');
    expect(f.sent).not.toContain(line);
    // T3b final review: the game is live on the box but its MATCH_START never arrived: never reset it.
    f.box.pug.state = 'live';
    f.sent.length = 0;
    f.t.t += MIN;
    await f.tick();
    expect(f.sent).not.toContain(line);
    // The box lost it (a burst that never arrived, srcds restarted under the game): sent again.
    f.box.pug = { state: 'none', match: 0 };
    f.sent.length = 0;
    f.t.t += MIN;
    await f.tick();
    expect(f.sent).toContain(line);
    f.goLive(f.gameOf(1).match_id!);
    f.sent.length = 0;
    f.t.t += MIN;
    await f.tick();
    expect(f.sent).not.toContain(line);
  });
});

describe('SeriesEngine: a setup retry after a heartbeat (T3b final review)', () => {
  it('pushes the same game again when the box heartbeated but the game never started, and creates no second game', async () => {
    f = await seriesFixture();
    await f.tick();
    const g1 = f.gameOf(1).match_id!;
    const line = f.sent.find((c) => c.startsWith('sm_pug_match '))!;
    // A heartbeat (no map: only MATCH_START or a round start names one), then setup or recovery restarts the box and asks again.
    f.db.prepare("INSERT INTO match_live (match_id, current_map, last_seen) VALUES (?, NULL, datetime('now'))").run(g1);
    const again = f.series.gameLines(f.booking().id, 'no_mercy');
    expect(again).toContain(line);
    expect(f.db.prepare('SELECT COUNT(*) FROM matches WHERE booking_id = ?').pluck().get(f.booking().id)).toBe(1);
    // The minute re-push keeps the heartbeat rule: a heartbeating game is not pushed each minute.
    expect(f.series.pendingLines(f.booking().id)).toEqual([]);
    // Once the game started (MATCH_START named its map) it is never pushed again.
    f.goLive(g1);
    expect(() => f.series.gameLines(f.booking().id, 'no_mercy')).toThrow();
  });
});

describe('SeriesEngine: no-show on the server', () => {
  it('forfeits the side with fewer than four locked players on the box when the grace ends, and ends the booking', async () => {
    f = await seriesFixture();
    await f.tick();
    const grace = B.bookingRules(f.booking())!.noShowGraceMinutes;
    f.box.humans = [...A.slice(0, 4), ...BATS.slice(0, 3), A[4]!];
    f.t.t += (grace - 1) * MIN;
    await f.tick();
    expect(f.match().status).toBe('connect');
    f.t.t += 2 * MIN;
    await f.tick();
    expect(f.match()).toMatchObject({ status: 'forfeit', winner_entry: f.entryA, result_source: 'forfeit' });
    expect(f.booking()).toMatchObject({ end_reason: 'no_show' });
    expect(B.sidesOf(f.db, f.booking().id).map((s) => s.no_show_at)).toEqual([null, null]);
    expect(f.send).toHaveBeenCalledWith(expect.arrayContaining([A[0], BATS[0]]), 'event_match_forfeit', expect.objectContaining({ content: expect.stringMatching(/is a forfeit win for Rats: Bats did not have four players on the server when the grace to connect ended\.$/) }));
  });

  it('holds a match when neither side showed, and a game going live before the deadline ends the question', async () => {
    f = await seriesFixture();
    await f.tick();
    const grace = B.bookingRules(f.booking())!.noShowGraceMinutes;
    f.box.humans = [...A.slice(0, 2), ...BATS.slice(0, 2)];
    f.t.t += (grace + 1) * MIN;
    await f.tick();
    expect(f.match()).toMatchObject({ status: 'admin_hold', hold_reason: 'no_show_both' });
    expect(f.booking().ending_at).toBeNull();
    f.close();
    f = await seriesFixture();
    await f.tick();
    // Bats are one short on the box: only the game being live keeps the no-show rule away.
    f.box.humans = [...A.slice(0, 4), ...BATS.slice(0, 3)];
    f.goLive(f.gameOf(1).match_id!);
    expect(f.match().status).toBe('live');
    f.t.t += (grace + 1) * MIN;
    await f.tick();
    expect(f.match().status).toBe('live');
    expect(f.booking().ending_at).toBeNull();
  });

  it('holds a connect match whose box cannot be watched for three minutes past the deadline', async () => {
    f = await seriesFixture();
    await f.tick();
    const grace = B.bookingRules(f.booking())!.noShowGraceMinutes;
    f.box.down = true;
    f.t.t += grace * MIN + PRESENCE_FALLBACK_MS - MIN;
    await f.tick();
    expect(f.match().status).toBe('connect');
    f.t.t += 2 * MIN;
    await f.tick();
    expect(f.match()).toMatchObject({ status: 'admin_hold', hold_reason: 'no_presence' });
  });

  it('leaves a stale connect match alone once its stage is no longer live', async () => {
    f = await seriesFixture();
    await f.tick();
    const grace = B.bookingRules(f.booking())!.noShowGraceMinutes;
    f.box.down = true;
    f.db.prepare("UPDATE event_stages SET status = 'finished' WHERE id = ?").run(f.match().stage_id);
    f.t.t += grace * MIN + PRESENCE_FALLBACK_MS + MIN;
    f.series.tick(new Date(f.t.t));
    expect(f.match().status).toBe('connect');
  });

  it('holds a match whose booking ends mid-series and alerts staff', async () => {
    f = await seriesFixture();
    await f.tick();
    const b = f.booking();
    B.cancelBooking(f.db, { bookingId: b.id, by: '76561199000000700', staff: true, now: new Date(f.t.t) });
    f.runner.onCancelled(b.id, '76561199000000700', null);
    await f.runner.idle();
    expect(f.match()).toMatchObject({ status: 'admin_hold', hold_reason: 'booking_staff' });
    expect(f.alerts.filter((a) => a.kind === 'problem' && a.text.includes('server booking ended'))).toHaveLength(1);
    // The runner may fire the hook twice (windDown): the second does nothing.
    f.series.hooks().ended(b.id, 'staff');
    expect(f.alerts.filter((a) => a.kind === 'problem' && a.text.includes('server booking ended'))).toHaveLength(1);
  });

  it('holds a match whose game crash recovery could not restore, once, and alerts staff', async () => {
    f = await seriesFixture();
    await f.tick();
    const g1 = f.gameOf(1).match_id!;
    f.box.humans = [...A.slice(0, 4), ...BATS.slice(0, 4)];
    f.goLive(g1);
    const hooks = f.series.hooks();
    hooks.gameLost!(f.booking().id, g1 + 1000);
    expect(f.match().status).toBe('live');
    hooks.gameLost!(f.booking().id, g1);
    hooks.gameLost!(f.booking().id, g1);
    expect(f.match()).toMatchObject({ status: 'admin_hold', hold_reason: 'game_lost' });
    expect(f.alerts.filter((a) => a.kind === 'problem' && a.text.includes('could not be restored'))).toHaveLength(1);
  });
});

describe('SeriesEngine: a game aborted outside crash recovery (T3b final review)', () => {
  it('holds the match once and alerts staff when its running game is aborted by staff, the reaper or an abandon', async () => {
    f = await seriesFixture();
    await f.tick();
    const g1 = f.gameOf(1).match_id!;
    f.box.humans = [...A.slice(0, 4), ...BATS.slice(0, 4)];
    f.goLive(g1);
    // The staff Abort on the match page (src/admin/matches.ts) writes the row and nothing tells the engine.
    f.db.prepare("UPDATE matches SET state = 'aborted', abort_cause = 'admin', ended_at = datetime('now') WHERE id = ?").run(g1);
    await f.tick();
    expect(f.match()).toMatchObject({ status: 'admin_hold', hold_reason: 'game_aborted' });
    await f.tick();
    expect(f.alerts.filter((a) => a.kind === 'problem' && a.text.includes(`match ${g1}) was aborted`))).toHaveLength(1);
    // The booking still runs: staff replay or decide.
    expect(f.booking().ending_at).toBeNull();
  });

  it('holds a match still in connect whose pushed game was aborted', async () => {
    f = await seriesFixture();
    await f.tick();
    const g1 = f.gameOf(1).match_id!;
    f.db.prepare("UPDATE matches SET state = 'aborted', abort_cause = 'orphaned', ended_at = datetime('now') WHERE id = ?").run(g1);
    f.series.tick(new Date(f.t.t));
    expect(f.match()).toMatchObject({ status: 'admin_hold', hold_reason: 'game_aborted' });
  });
});

describe('SeriesEngine: games, picks, tiebreaks and the confirm window', () => {
  it('plays a Bo3 with loser picks: records game 1, opens the loser\'s pick, schedules each game with its sides, and ends in the confirm window', async () => {
    f = await seriesFixture({ pool: POOL7, veto: presetConfig('loser_picks', 7), drive: driveLoserPicks });
    await f.tick();
    const g1 = f.gameOf(1);
    // Bats survive first on game 1: match team a is Bats (entry b).
    expect(f.db.prepare('SELECT booking_side_a FROM matches WHERE id = ?').get(g1.match_id!)).toEqual({ booking_side_a: 'b' });
    f.goLive(g1.match_id!);
    expect(f.match().status).toBe('live');
    // Bats (team a) 400, Rats (team b) 600: Rats win game 1, Bats pick game 2.
    f.endGame(g1.match_id!, [{ map: 'm1', a: 300, b: 200 }, { map: 'm2', a: 100, b: 400 }]);
    expect(f.gameOf(1)).toMatchObject({ score_a: 600, score_b: 400, winner: f.entryA, forfeit_side: null });
    const picking = f.match();
    expect(picking.status).toBe('live');
    expect(picking.deadline).toBe(new Date(f.t.t + 60_000).toISOString());
    expect(R.roomState(f.db, picking).next).toEqual({ kind: 'pick', by: 'b', game: 2 });
    expect(f.sent.some((c) => c.startsWith('say [Match] Bats: pick game 2'))).toBe(true);
    expect(f.booking().next_campaign).toBeNull();
    // A second pass (the hook twice, or a stray afterPick) opens nothing new.
    f.series.continueSeries(f.matchId);
    expect(f.match().deadline).toBe(picking.deadline);
    expect(f.sent.filter((c) => c.startsWith('say [Match] Bats: pick game 2')).length).toBe(1);
    // Bats pick, Rats choose survivors: game 2 is scheduled a minute out.
    const pick = R.actVeto(f.db, { matchId: f.matchId, steamid: BATS[0]!, step: 7, action: 'pick', campaign: POOL7[4]!, timers: TIMERS, now: new Date(f.t.t) });
    expect(pick.ok).toBe(true);
    f.series.afterPick(f.matchId);
    expect(f.booking().next_campaign).toBeNull();
    const side = R.actVeto(f.db, { matchId: f.matchId, steamid: A[0]!, step: 8, action: 'survivors', campaign: null, timers: TIMERS, now: new Date(f.t.t) });
    expect(side.ok && side.value.deadline).toBeNull();
    f.series.afterPick(f.matchId);
    f.series.afterPick(f.matchId);
    expect(f.booking()).toMatchObject({ next_campaign: POOL7[4], next_map: null, games_allowed: 2 });
    expect(f.sent.filter((c) => c.startsWith('say [Match] Next: game 2')).length).toBe(1);
    f.sent.length = 0;
    f.t.t += MIN;
    await f.tick();
    const g2 = f.gameOf(2);
    expect(g2.match_id).not.toBeNull();
    expect(f.db.prepare('SELECT booking_side_a FROM matches WHERE id = ?').get(g2.match_id!)).toEqual({ booking_side_a: 'a' });
    expect(f.sent.filter((c) => c.startsWith('sm_pug_roster '))).toEqual([...A.slice(0, 4).map((s) => `sm_pug_roster "${s}:a"`), ...BATS.slice(0, 4).map((s) => `sm_pug_roster "${s}:b"`)]);
    expect(f.sent.some((c) => c.startsWith('changelevel '))).toBe(true);
    f.goLive(g2.match_id!);
    // Rats (team a) lose game 2: 1-1, the decider's sides are chosen by Rats (Bats made the last ban).
    f.endGame(g2.match_id!, [{ map: 'm1', a: 100, b: 500 }]);
    expect(R.roomState(f.db, f.match()).next).toEqual({ kind: 'side', by: 'a', game: 3 });
    expect(f.match().deadline).not.toBeNull();
    expect(R.actVeto(f.db, { matchId: f.matchId, steamid: A[0]!, step: 9, action: 'infected', campaign: null, timers: TIMERS, now: new Date(f.t.t) }).ok).toBe(true);
    f.series.afterPick(f.matchId);
    expect(f.booking()).toMatchObject({ next_campaign: POOL7[6], games_allowed: 3 });
    f.t.t += MIN;
    await f.tick();
    const g3 = f.gameOf(3);
    f.goLive(g3.match_id!);
    f.endGame(g3.match_id!, [{ map: 'm1', a: 100, b: 900 }]);
    // Bats survive first on game 3 (Rats chose infected), so team a is Bats: Rats win 2-1.
    const done = f.match();
    expect(done).toMatchObject({ status: 'confirming', deadline: new Date(f.t.t + 15 * MIN).toISOString(), confirm_a_at: null, confirm_b_at: null });
    expect(f.booking().close_at).toBe(new Date(f.t.t + 5 * MIN).toISOString());
    expect(f.sent.some((c) => c.startsWith('say [Match] Series over: Rats beat Bats 2 games to 1'))).toBe(true);
    expect(f.send).toHaveBeenCalledWith(expect.arrayContaining([A[0], BATS[0]]), 'event_match_result', expect.objectContaining({ content: expect.stringContaining('Rats beat Bats 2 games to 1') }));
    // Before the window passes the result waits; the room clock records it once it has.
    f.t.t += 15 * MIN - 1_000;
    await f.tick();
    expect(f.match().status).toBe('confirming');
    f.t.t += 1_000;
    await f.tick();
    expect(f.match()).toMatchObject({ status: 'done', winner_entry: f.entryA, score_a: 2, score_b: 1, result_source: 'auto' });
  });

  it('acts for a team that runs out of time on its pick, from its saved order, and schedules the game', async () => {
    f = await seriesFixture({ pool: POOL7, veto: presetConfig('loser_picks', 7), drive: driveLoserPicks });
    R.savePrefs(f.db, { entryId: f.entryB, by: BATS[0]!, staff: false, prefs: { defaultFour: null, side: null, campaigns: { [String(f.stageId)]: [POOL7[6]!] } }, now: new Date(f.t.t) });
    await f.tick();
    const g1 = f.gameOf(1);
    f.goLive(g1.match_id!);
    f.endGame(g1.match_id!, [{ map: 'm1', a: 100, b: 500 }]);
    f.t.t += MIN;
    await f.tick();
    expect(f.gameOf(2)).toMatchObject({ campaign: POOL7[6], picked_by: f.entryB });
    // The side step is a human step again: nothing is scheduled yet.
    expect(f.booking().next_campaign).toBeNull();
    f.t.t += MIN;
    await f.tick();
    // Rats did not pick, so Rats choose sides; with no saved side the clock takes survivors first.
    expect(f.gameOf(2).first_survivors).toBe(f.entryA);
    expect(f.booking()).toMatchObject({ next_campaign: POOL7[6], games_allowed: 2 });
    const rows = f.db.prepare('SELECT action, campaign, auto FROM event_vetoes ORDER BY step').all().slice(-2);
    expect(rows).toEqual([{ action: 'pick', campaign: POOL7[6], auto: 1 }, { action: 'survivors', campaign: null, auto: 1 }]);
  });

  it('replays the last chapter as a tiebreak when a game ties, with the team that survived second starting as survivors', async () => {
    f = await seriesFixture();
    await f.tick();
    const g1 = f.gameOf(1);
    f.goLive(g1.match_id!);
    // Team a is Bats. On the last map Rats (team b) survived first, so Bats survive first in the tiebreak.
    f.endGame(g1.match_id!, [{ map: 'l4d_vs_hospital01_apartment', a: 100, b: 100, half1Surv: 'a' }, { map: 'l4d_vs_hospital02_subway', a: 200, b: 200, half1Surv: 'b' }]);
    const tb = R.gamesOf(f.db, f.matchId).find((g) => g.tiebreak_of === g1.id)!;
    expect(tb).toMatchObject({ ordinal: 11, campaign: 'no_mercy', map: 'l4d_vs_hospital02_subway', first_survivors: f.entryB, match_id: null });
    expect(f.booking()).toMatchObject({ next_campaign: 'no_mercy', next_map: 'l4d_vs_hospital02_subway', games_allowed: 2 });
    expect(f.sent.some((c) => c.startsWith('say [Match] Game 1 is tied 300 to 300'))).toBe(true);
    // Idempotent: a second pass adds no second tiebreak.
    f.series.continueSeries(f.matchId);
    expect(R.gamesOf(f.db, f.matchId).filter((g) => g.tiebreak_of === g1.id)).toHaveLength(1);
    f.sent.length = 0;
    f.t.t += MIN;
    await f.tick();
    const started = f.gameOf(11);
    expect(started.match_id).not.toBeNull();
    const line = f.sent.find((c) => c.startsWith('sm_pug_match '))!;
    expect(line).toBe(`sm_pug_match ${started.match_id} ${f.db.prepare('SELECT token FROM matches WHERE id = ?').pluck().get(started.match_id!)} no_mercy "l4d_vs_hospital02_subway"`);
    expect(f.sent.indexOf(line)).toBeLessThan(f.sent.indexOf('changelevel l4d_vs_hospital02_subway'));
    expect(f.sent.filter((c) => c.startsWith('sm_pug_roster '))).toEqual([...BATS.slice(0, 4).map((s) => `sm_pug_roster "${s}:a"`), ...A.slice(0, 4).map((s) => `sm_pug_roster "${s}:b"`)]);
    f.goLive(started.match_id!);
    f.endGame(started.match_id!, [{ map: 'l4d_vs_hospital02_subway', a: 50, b: 20 }]);
    expect(f.gameOf(11)).toMatchObject({ score_a: 20, score_b: 50, winner: f.entryB });
    expect(f.match().status).toBe('confirming');
    // Both captains confirm: done at once.
    expect((await f.series.confirm(f.matchId, A[1]!, new Date(f.t.t))).ok).toBe(true);
    expect(f.match().status).toBe('confirming');
    expect((await f.series.confirm(f.matchId, BATS[0]!, new Date(f.t.t))).ok).toBe(true);
    expect(f.match()).toMatchObject({ status: 'done', winner_entry: f.entryB, score_a: 0, score_b: 1, result_source: 'auto' });
  });

  it('takes a game ending twice once, refuses a dispute after the deadline, files one before it, and shrugs off a booking end after the series', async () => {
    f = await seriesFixture();
    await f.tick();
    const g1 = f.gameOf(1);
    f.goLive(g1.match_id!);
    f.endGame(g1.match_id!, [{ map: 'm1', a: 100, b: 300 }]);
    f.runner.onGameEnded(g1.match_id!);
    f.series.gameEnded(f.booking().id, g1.match_id!);
    expect(f.db.prepare("SELECT COUNT(*) AS n FROM event_log WHERE action = 'game_recorded'").pluck().get()).toBe(1);
    expect(f.db.prepare("SELECT COUNT(*) AS n FROM event_log WHERE action = 'match_confirming'").pluck().get()).toBe(1);
    expect(f.match().status).toBe('confirming');
    const b = f.booking();
    B.closeBooking(f.db, b.id, 'ended', 'idle', new Date(f.t.t));
    f.runner.settle(b.id);
    await f.runner.idle();
    expect(f.match().status).toBe('confirming');
    expect(f.series.dispute(f.matchId, BATS[0]!, 'Rats had five on map 2', new Date(f.t.t + 16 * MIN))).toEqual({ ok: false, error: 'confirm_closed' });
    const d = f.series.dispute(f.matchId, BATS[0]!, 'Rats had five on map 2', new Date(f.t.t));
    expect(d.ok && d.value).toMatchObject({ status: 'admin_hold', hold_reason: 'dispute', dispute_side: 'b' });
    const alert = f.alerts.find((a): a is Extract<AdminEvent, { kind: 'problem' }> => a.kind === 'problem' && a.text.includes('DISPUTED'))!;
    expect(alert.text).toContain('Rats had five on map 2');
    expect(alert.text).toContain(`/match/${g1.match_id}`);
    expect(alert.link?.path).toBe(`/event/${f.slug}/match/${f.matchId}`);
    f.t.t += 20 * MIN;
    await f.tick();
    expect(f.match().status).toBe('admin_hold');
  });

  it('resets a booked room by cancelling the booking first, without holding the match', async () => {
    f = await seriesFixture();
    await f.tick();
    const b = f.booking();
    const r = f.series.reset(f.matchId, '76561199000000700', new Date(f.t.t));
    expect(r.ok && r.value).toMatchObject({ status: 'waiting', booking_id: null });
    await f.runner.idle();
    expect(B.getBooking(f.db, b.id)).toMatchObject({ state: 'cancelled', end_reason: 'staff' });
    expect(f.db.prepare("SELECT COUNT(*) AS n FROM event_log WHERE action = 'match_held'").pluck().get()).toBe(0);
    expect(f.db.prepare("SELECT state FROM matches WHERE booking_id = ?").pluck().get(b.id)).toBe('aborted');
  });
});

describe('SeriesEngine: the end of a series and the box (T3b ledger rulings)', () => {
  it('moves a finished Bo1 into its confirm window before the box closes, so the booking ending as done holds nothing', async () => {
    f = await seriesFixture();
    await f.tick();
    const g1 = f.gameOf(1);
    f.box.humans = [...A.slice(0, 4), ...BATS.slice(0, 4)];
    f.goLive(g1.match_id!);
    // Team a is Bats: Rats 500 to Bats 300.
    f.endGame(g1.match_id!, [{ map: 'l4d_vs_hospital01_apartment', a: 300, b: 500 }]);
    expect(f.gameOf(1)).toMatchObject({ score_a: 500, score_b: 300, forfeit_side: null, winner: f.entryA });
    expect(f.match().status).toBe('confirming');
    const b = f.booking();
    expect(b.close_at).toBe(new Date(f.t.t + 5 * MIN).toISOString());
    const deadline = f.match().deadline!;
    f.box.humans = [];
    f.t.t += 5 * MIN;
    await f.tick();
    expect(B.getBooking(f.db, b.id)).toMatchObject({ state: 'ended', end_reason: 'done' });
    expect(B.getBooking(f.db, b.id)!.ended_at).not.toBeNull();
    expect(f.match()).toMatchObject({ status: 'confirming', deadline, hold_reason: null });
    expect(f.db.prepare("SELECT COUNT(*) AS n FROM event_log WHERE action = 'match_held'").pluck().get()).toBe(0);
    expect(f.alerts.filter((a) => a.kind === 'problem' && a.text.includes('server booking ended'))).toHaveLength(0);
    f.t.t += 10 * MIN;
    await f.tick();
    expect(f.match()).toMatchObject({ status: 'done', winner_entry: f.entryA, score_a: 1, score_b: 0, result_source: 'auto' });
  });

  it('records a !gg as a forfeit of the side that typed it, oriented by the game\'s booking side, with no winner field', async () => {
    f = await seriesFixture();
    await f.tick();
    const g1 = f.gameOf(1);
    f.goLive(g1.match_id!);
    // Team a is Bats (entry b). Bats lead on score but type !gg: Rats win the game and the Bo1.
    f.db.prepare("UPDATE matches SET forfeit_team = 'a' WHERE id = ?").run(g1.match_id!);
    f.endGame(g1.match_id!, [{ map: 'l4d_vs_hospital01_apartment', a: 400, b: 100 }]);
    expect(f.gameOf(1)).toMatchObject({ score_a: 100, score_b: 400, forfeit_side: 'b', winner: f.entryA });
    const log = JSON.parse(f.db.prepare("SELECT detail FROM event_log WHERE action = 'game_recorded'").pluck().get() as string);
    expect(log).toMatchObject({ scoreA: 100, scoreB: 400, forfeit: 'b', winner: 'a' });
    expect(f.match().status).toBe('confirming');
    // The room page marks it (T3b final review): Bats lead on score but forfeited.
    const view = matchRoomView(f.db, E.getEvent(f.db, f.eventId)!, f.match(), null, false, new Date(f.t.t));
    expect(view.games[0]).toMatchObject({ state: 'done', scoreA: 100, scoreB: 400, winner: 'a', forfeit: 'b' });
  });

  it('ends the running booking as a staff end when an admin enters the result on the desk', async () => {
    f = await seriesFixture();
    f.db.prepare("UPDATE players SET is_admin = 1, status = 'active' WHERE steamid = ?").run(ADMIN);
    await f.tick();
    const g1 = f.gameOf(1);
    f.box.humans = [...A.slice(0, 4), ...BATS.slice(0, 4)];
    f.goLive(g1.match_id!);
    const b = f.booking();
    const app = Fastify();
    await app.register(cookie, { secret: 'x'.repeat(32) });
    await app.register(adminEventRoutes, { db: f.db, store: () => { throw new Error('no store'); }, publicUrl: 'https://x', series: f.series });
    await app.ready();
    try {
      const res = await app.inject({
        method: 'POST', url: `/api/admin/events/${f.eventId}/matches/${f.matchId}/result`,
        cookies: authedCookie(app, f.db, ADMIN), payload: { winner: 'a', scoreA: 900, scoreB: 400 },
      });
      expect(res.statusCode).toBe(200);
      await f.runner.idle();
      expect(f.match()).toMatchObject({ status: 'done', result_source: 'admin', winner_entry: f.entryA });
      expect(B.getBooking(f.db, b.id)).toMatchObject({ state: 'ended', end_reason: 'staff' });
      expect(B.getBooking(f.db, b.id)!.ended_at).not.toBeNull();
      // The game in progress was aborted by the wind-down, and nothing was held.
      expect(f.db.prepare('SELECT state FROM matches WHERE id = ?').pluck().get(g1.match_id!)).toBe('aborted');
      expect(f.db.prepare("SELECT COUNT(*) AS n FROM event_log WHERE action = 'match_held'").pluck().get()).toBe(0);
      // Twice is harmless: the booking is no longer open.
      const events = f.db.prepare('SELECT COUNT(*) FROM booking_events WHERE booking_id = ?').pluck();
      const before = events.get(b.id);
      f.series.staffResult(f.matchId, ADMIN);
      expect(events.get(b.id)).toBe(before);
    } finally {
      await app.close();
    }
  });

  it('ends the running booking as a staff end when a team is disqualified mid-series (T3b final review)', async () => {
    f = await seriesFixture();
    f.db.prepare("UPDATE players SET is_admin = 1, status = 'active' WHERE steamid = ?").run(ADMIN);
    await f.tick();
    const g1 = f.gameOf(1);
    f.box.humans = [...A.slice(0, 4), ...BATS.slice(0, 4)];
    f.goLive(g1.match_id!);
    const b = f.booking();
    const app = Fastify();
    await app.register(cookie, { secret: 'x'.repeat(32) });
    await app.register(adminEventRoutes, { db: f.db, store: () => { throw new Error('no store'); }, publicUrl: 'https://x', series: f.series });
    await app.ready();
    try {
      const res = await app.inject({
        method: 'POST', url: `/api/admin/events/${f.eventId}/entries/${f.entryB}/disqualify`,
        cookies: authedCookie(app, f.db, ADMIN), payload: { reason: 'Ringer on the roster' },
      });
      expect(res.statusCode).toBe(200);
      await f.runner.idle();
      expect(f.match()).toMatchObject({ status: 'forfeit', winner_entry: f.entryA });
      expect(B.getBooking(f.db, b.id)).toMatchObject({ state: 'ended', end_reason: 'staff' });
      expect(f.db.prepare('SELECT state FROM matches WHERE id = ?').pluck().get(g1.match_id!)).toBe('aborted');
      expect(f.db.prepare("SELECT COUNT(*) AS n FROM event_log WHERE action = 'match_held'").pluck().get()).toBe(0);
    } finally {
      await app.close();
    }
  });

  it('ends a booking still waiting for a box (scheduled) when the result is entered while held', async () => {
    f = await seriesFixture();
    f.db.prepare("UPDATE servers SET status = 'live'").run();
    await f.tick();
    const b = f.booking();
    expect(b.state).toBe('scheduled');
    expect(R.holdMatch(f.db, { matchId: f.matchId, by: ADMIN, reason: 'staff look', now: new Date(f.t.t) }).ok).toBe(true);
    const r = await recordResultFlow(f.db, { eventId: f.eventId, matchId: f.matchId, by: ADMIN, result: { winner: 'b', scoreA: 0, scoreB: 1 }, now: new Date(f.t.t) });
    expect(r.ok).toBe(true);
    f.series.staffResult(f.matchId, ADMIN);
    await f.runner.idle();
    expect(B.getBooking(f.db, b.id)).toMatchObject({ state: 'cancelled', end_reason: 'staff' });
    expect(f.match().status).toBe('done');
  });

  it('logs a match it cannot book once, not on every tick', async () => {
    f = await seriesFixture();
    f.db.prepare('DELETE FROM event_lineups WHERE event_match_id = ? AND entry_id = ?').run(f.matchId, f.entryB);
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await f.tick();
      await f.tick();
      f.series.tick(new Date(f.t.t));
      expect(err.mock.calls.filter((c) => String(c[0]).includes('cannot book'))).toHaveLength(1);
      expect(f.match()).toMatchObject({ status: 'booking', booking_id: null });
    } finally {
      err.mockRestore();
    }
  });
});

describe('SeriesEngine: robustness (T3b Task 6 review)', () => {
  it('adds no second tiebreak while the first is being played', async () => {
    f = await seriesFixture();
    await f.tick();
    const g1 = f.gameOf(1);
    f.goLive(g1.match_id!);
    f.endGame(g1.match_id!, [{ map: 'l4d_vs_hospital02_subway', a: 200, b: 200 }]);
    f.t.t += MIN;
    await f.tick();
    const tb = f.gameOf(11);
    expect(tb.match_id).not.toBeNull();
    f.goLive(tb.match_id!);
    f.series.continueSeries(f.matchId);
    expect(R.gamesOf(f.db, f.matchId).filter((g) => g.tiebreak_of === g1.id)).toHaveLength(1);
    expect(f.booking().games_allowed).toBe(2);
    expect(f.match()).toMatchObject({ status: 'live', hold_reason: null });
  });

  it('holds the match and tells staff once when the tiebreak is refused', async () => {
    f = await seriesFixture();
    await f.tick();
    const g1 = f.gameOf(1);
    // All nine tiebreak slots of game 1 already used, each tied: the next one is refused.
    const ins = f.db.prepare("INSERT INTO event_games (event_match_id, ordinal, campaign, tiebreak_of, map, score_a, score_b, created_at) VALUES (?, ?, 'no_mercy', ?, 'm', 10, 10, ?)");
    for (let i = 11; i <= 19; i++) ins.run(f.matchId, i, g1.id, new Date(f.t.t).toISOString());
    f.goLive(g1.match_id!);
    f.endGame(g1.match_id!, [{ map: 'l4d_vs_hospital02_subway', a: 200, b: 200 }]);
    expect(f.match()).toMatchObject({ status: 'admin_hold', hold_reason: 'tiebreak_refused' });
    f.series.continueSeries(f.matchId);
    f.series.gameEnded(f.booking().id, g1.match_id!);
    expect(f.alerts.filter((a) => a.kind === 'problem' && a.text.includes('tiebreak'))).toHaveLength(1);
  });

  it('refuses to reset a finished match and leaves its booking running', async () => {
    f = await seriesFixture();
    await f.tick();
    const g1 = f.gameOf(1);
    f.goLive(g1.match_id!);
    f.endGame(g1.match_id!, [{ map: 'm1', a: 100, b: 500 }]);
    expect((await f.series.confirm(f.matchId, A[0]!, new Date(f.t.t))).ok).toBe(true);
    expect((await f.series.confirm(f.matchId, BATS[0]!, new Date(f.t.t))).ok).toBe(true);
    expect(f.match().status).toBe('done');
    const b = f.booking();
    expect(B.isOpen(b)).toBe(true);
    expect(f.series.reset(f.matchId, ADMIN, new Date(f.t.t))).toEqual({ ok: false, error: 'wrong_status' });
    expect(B.getBooking(f.db, b.id)).toMatchObject({ state: b.state, ending_at: null });
  });

  it('says "1 game to 0" for a Bo1, and promises the close only when it was set', async () => {
    f = await seriesFixture();
    await f.tick();
    const g1 = f.gameOf(1);
    f.goLive(g1.match_id!);
    // A close the booking refuses (more games allowed than played): no promise of a close.
    f.db.prepare('UPDATE bookings SET games_allowed = 5 WHERE id = ?').run(f.booking().id);
    f.endGame(g1.match_id!, [{ map: 'm1', a: 100, b: 500 }]);
    const line = f.sent.find((c) => c.startsWith('say [Match] Series over:'))!;
    expect(line).toContain('Rats beat Bats 1 game to 0.');
    expect(line).not.toContain('closes in 5 minutes');
    expect(f.booking().close_at).toBeNull();
    expect(f.send).toHaveBeenCalledWith(expect.anything(), 'event_match_result', expect.objectContaining({ content: expect.stringContaining('Rats beat Bats 1 game to 0.') }));
  });
});

describe('SeriesEngine: a load that failed after the game was appended (T3b final review)', () => {
  it('schedules the next game again without appending it twice', async () => {
    f = await seriesFixture({ pool: POOL7, veto: presetConfig('loser_picks', 7), drive: driveLoserPicks });
    await f.tick();
    const g1 = f.gameOf(1);
    f.goLive(g1.match_id!);
    f.endGame(g1.match_id!, [{ map: 'm1', a: 300, b: 200 }, { map: 'm2', a: 100, b: 400 }]);
    expect(R.actVeto(f.db, { matchId: f.matchId, steamid: BATS[0]!, step: 7, action: 'pick', campaign: POOL7[4]!, timers: TIMERS, now: new Date(f.t.t) }).ok).toBe(true);
    expect(R.actVeto(f.db, { matchId: f.matchId, steamid: A[0]!, step: 8, action: 'survivors', campaign: null, timers: TIMERS, now: new Date(f.t.t) }).ok).toBe(true);
    f.series.afterPick(f.matchId);
    expect(f.booking()).toMatchObject({ next_campaign: POOL7[4], games_allowed: 2 });
    // loadNext could not build the burst: it cleared the load (runner.ts) and alerted staff.
    B.setNext(f.db, f.booking().id, null, null, new Date(f.t.t));
    const endsAt = f.booking().ends_at;
    f.series.continueSeries(f.matchId);
    expect(f.booking()).toMatchObject({ next_campaign: POOL7[4], games_allowed: 2, ends_at: endsAt });
    expect(JSON.parse(f.booking().playlist_json)).toHaveLength(2);
    f.t.t += MIN;
    await f.tick();
    expect(f.gameOf(2).match_id).not.toBeNull();
  });

  it('schedules a tiebreak again whose load failed, without appending it twice', async () => {
    f = await seriesFixture();
    await f.tick();
    const g1 = f.gameOf(1);
    f.goLive(g1.match_id!);
    f.endGame(g1.match_id!, [{ map: 'l4d_vs_hospital02_subway', a: 200, b: 200 }]);
    expect(f.booking()).toMatchObject({ next_campaign: 'no_mercy', next_map: 'l4d_vs_hospital02_subway', games_allowed: 2 });
    B.setNext(f.db, f.booking().id, null, null, new Date(f.t.t));
    f.series.continueSeries(f.matchId);
    expect(f.booking()).toMatchObject({ next_campaign: 'no_mercy', next_map: 'l4d_vs_hospital02_subway', games_allowed: 2 });
    expect(R.gamesOf(f.db, f.matchId).filter((g) => g.tiebreak_of === g1.id)).toHaveLength(1);
  });
});

describe('SeriesEngine: a staff hold while a game runs (T3b final review)', () => {
  it('records the game that ends under the hold, and moves the series no further', async () => {
    f = await seriesFixture({ pool: POOL7, veto: presetConfig('loser_picks', 7), drive: driveLoserPicks });
    await f.tick();
    const g1 = f.gameOf(1);
    f.goLive(g1.match_id!);
    expect(R.holdMatch(f.db, { matchId: f.matchId, by: ADMIN, reason: 'checking a report', now: new Date(f.t.t) }).ok).toBe(true);
    f.endGame(g1.match_id!, [{ map: 'm1', a: 300, b: 200 }, { map: 'm2', a: 100, b: 400 }]);
    expect(f.gameOf(1)).toMatchObject({ score_a: 600, score_b: 400, winner: f.entryA });
    expect(f.match()).toMatchObject({ status: 'admin_hold', hold_reason: 'checking a report', deadline: null });
    expect(f.booking().next_campaign).toBeNull();
    expect(f.sent.some((c) => c.startsWith('say [Match] Bats: pick game 2'))).toBe(false);
    // Twice is harmless.
    f.series.gameEnded(f.booking().id, g1.match_id!);
    expect(f.db.prepare("SELECT COUNT(*) AS n FROM event_log WHERE action = 'game_recorded'").pluck().get()).toBe(1);
  });
});

describe('SeriesEngine: a Bo2 home and away (T3b final review)', () => {
  const HA = ['no_mercy', 'dead_air', 'death_toll', 'blood_harvest'];
  /** Rats go second, Bats pick death_toll and Rats survive first, Rats pick no_mercy and Bats take infected: Rats survive first in both. */
  const driveHomeAway = (r: RoomFixture): void => {
    const at = (min: number) => new Date(NOW.getTime() + min * 60_000);
    const ok = <T>(x: { ok: true; value: T } | { ok: false; error: string }): T => { if (!x.ok) throw new Error(x.error); return x.value; };
    ok(R.openRoom(r.db, { matchId: r.matchId, by: null, higher: 'a', seed: 0, timers: TIMERS, now: NOW }));
    for (const who of [A[0]!, BATS[0]!]) ok(R.readyUp(r.db, { matchId: r.matchId, steamid: who, timers: TIMERS, now: at(1) }));
    const steps: [string, number, string, string | null][] = [
      [A[0]!, 0, 'second', null], [BATS[0]!, 1, 'pick', 'death_toll'], [A[0]!, 2, 'survivors', null], [A[0]!, 3, 'pick', 'no_mercy'], [BATS[0]!, 4, 'infected', null],
    ];
    for (const [who, step, action, campaign] of steps) ok(R.actVeto(r.db, { matchId: r.matchId, steamid: who, step, action, campaign, timers: TIMERS, now: at(2) }));
    ok(R.lockLineup(r.db, { matchId: r.matchId, steamid: A[0]!, steamids: A.slice(0, 4), timers: TIMERS, now: at(4) }));
    ok(R.lockLineup(r.db, { matchId: r.matchId, steamid: BATS[0]!, steamids: BATS.slice(0, 4), timers: TIMERS, now: at(4) }));
  };

  it('plays both games, and tied totals replay game 2\'s last chapter as the tiebreak', async () => {
    f = await seriesFixture({ pool: HA, veto: presetConfig('home_away', 4), drive: driveHomeAway });
    await f.tick();
    const g1 = f.gameOf(1);
    expect(g1).toMatchObject({ campaign: 'death_toll', first_survivors: f.entryA });
    f.goLive(g1.match_id!);
    // Rats are team a (they survive first): Rats 500, Bats 400.
    f.endGame(g1.match_id!, [{ map: 'l4d_vs_smalltown01_caves', a: 500, b: 400 }]);
    expect(f.gameOf(1)).toMatchObject({ score_a: 500, score_b: 400 });
    // Total score: game 2 always follows, with no pick step in between.
    expect(f.match()).toMatchObject({ status: 'live', deadline: null });
    expect(f.booking()).toMatchObject({ next_campaign: 'no_mercy', next_map: null, games_allowed: 2 });
    f.t.t += MIN;
    await f.tick();
    const g2 = f.gameOf(2);
    expect(g2.match_id).not.toBeNull();
    expect(f.sent.some((c) => c === 'changelevel l4d_vs_hospital01_apartment')).toBe(true);
    f.goLive(g2.match_id!);
    // Rats 300, Bats 400: 800 to 800 on total.
    f.endGame(g2.match_id!, [{ map: 'l4d_vs_hospital01_apartment', a: 100, b: 100, half1Surv: 'a' }, { map: 'l4d_vs_hospital02_subway', a: 200, b: 300, half1Surv: 'b' }]);
    const tb = R.gamesOf(f.db, f.matchId).find((g) => g.tiebreak_of === g2.id)!;
    // On game 2's last chapter Bats (team b) survived first, so Rats start the tiebreak as survivors.
    expect(tb).toMatchObject({ ordinal: 21, campaign: 'no_mercy', map: 'l4d_vs_hospital02_subway', first_survivors: f.entryA });
    expect(R.gamesOf(f.db, f.matchId).filter((g) => g.tiebreak_of === g1.id)).toEqual([]);
    expect(f.booking()).toMatchObject({ next_campaign: 'no_mercy', next_map: 'l4d_vs_hospital02_subway', games_allowed: 3 });
    f.sent.length = 0;
    f.t.t += MIN;
    await f.tick();
    const played = f.gameOf(21);
    expect(f.sent).toContain('changelevel l4d_vs_hospital02_subway');
    f.goLive(played.match_id!);
    f.endGame(played.match_id!, [{ map: 'l4d_vs_hospital02_subway', a: 50, b: 80 }]);
    expect(f.match().status).toBe('confirming');
    expect(f.sent.some((c) => c.startsWith('say [Match] Series over: Bats beat Rats'))).toBe(true);
    expect((await f.series.confirm(f.matchId, A[0]!, new Date(f.t.t))).ok).toBe(true);
    expect((await f.series.confirm(f.matchId, BATS[0]!, new Date(f.t.t))).ok).toBe(true);
    expect(f.match()).toMatchObject({ status: 'done', winner_entry: f.entryB, result_source: 'auto' });
  });
});

describe('SeriesEngine: the pick route on a live match (plan T3b Task 8)', () => {
  let f: SeriesFixture;
  afterEach(() => { vi.restoreAllMocks(); f?.close(); });

  it('hands a human pick and side choice on a live match to the engine, which schedules the next game', async () => {
    f = await seriesFixture({ pool: POOL7, veto: presetConfig('loser_picks', 7), drive: driveLoserPicks });
    await f.tick();
    const g1 = f.gameOf(1);
    f.goLive(g1.match_id!);
    f.endGame(g1.match_id!, [{ map: 'm1', a: 300, b: 200 }, { map: 'm2', a: 100, b: 400 }]);
    expect(R.roomState(f.db, f.match()).next).toEqual({ kind: 'pick', by: 'b', game: 2 });
    const afterPick = vi.spyOn(f.series, 'afterPick');
    const app = Fastify();
    await app.register(cookie, { secret: 'x'.repeat(32) });
    await app.register(eventRoutes, { db: f.db, store: () => { throw new Error('no store'); }, publicUrl: 'https://x', series: f.series });
    await app.ready();
    try {
      const url = (a: string) => `/api/events/${f.slug}/matches/${f.matchId}/${a}`;
      const pick = await app.inject({ method: 'POST', url: url('veto'), cookies: authedCookie(app, f.db, BATS[0]!), payload: { step: 7, action: 'pick', campaign: POOL7[4] } });
      expect(pick.statusCode).toBe(200);
      expect(afterPick).toHaveBeenCalledTimes(1);
      expect(f.booking().next_campaign).toBeNull();
      // A refused pick hands nothing on.
      expect((await app.inject({ method: 'POST', url: url('veto'), cookies: authedCookie(app, f.db, BATS[0]!), payload: { step: 8, action: 'survivors' } })).statusCode).toBe(409);
      expect(afterPick).toHaveBeenCalledTimes(1);
      const side = await app.inject({ method: 'POST', url: url('veto'), cookies: authedCookie(app, f.db, A[0]!), payload: { step: 8, action: 'survivors' } });
      expect(side.statusCode).toBe(200);
      expect(afterPick).toHaveBeenCalledTimes(2);
      expect(f.booking()).toMatchObject({ next_campaign: POOL7[4], games_allowed: 2 });
    } finally {
      await app.close();
    }
  });
});

describe('BookingRunner on a tournament box (plan T3c)', () => {
  useNoMercy();

  it('pushes sm_pug_tournament 1 with the booking lines and sends a burst to the running box only', async () => {
    f = await seriesFixture();
    expect(await f.runner.send(999, ['say hi'], 'nothing')).toBeNull();
    await f.tick();
    expect(f.sent).toContain('sm_pug_tournament 1');
    const replies = await f.runner.send(f.booking().id, ['sm_pug_status'], 'a look');
    expect(replies).toHaveLength(1);
    expect(f.sent.at(-1)).toBe('sm_pug_status');
    f.box.down = true;
    expect(await f.runner.send(f.booking().id, ['say hi'], 'a line')).toBeNull();
  });

  it('replays a chapter: abort, resume, prepare, changelevel, the lines again; aborts the game when the plugin refuses', async () => {
    f = await seriesFixture();
    await f.tick();
    const g1 = f.gameOf(1).match_id!;
    f.goLive(g1, 'l4d_vs_hospital02_subway');
    const token = (f.db.prepare('SELECT token FROM matches WHERE id = ?').get(g1) as { token: string }).token;
    const round = f.db.prepare("INSERT INTO match_rounds (match_id, ordinal, half, surv_team, score, ended_at) VALUES (?, ?, ?, ?, ?, datetime('now'))");
    round.run(g1, 0, 1, 'a', 300); round.run(g1, 0, 2, 'b', 200); round.run(g1, 1, 1, 'a', 50);
    // match_live_maps keys on (match_id, map) and needs both scores (NOT NULL).
    f.db.prepare("INSERT INTO match_live_maps (match_id, ordinal, map, team_a_score, team_b_score) VALUES (?, 0, 'l4d_vs_hospital01_apartment', 300, 200), (?, 1, 'l4d_vs_hospital02_subway', 0, 0)").run(g1, g1);
    const { restoreSnapshot } = await import('../src/bookings/restore.js');
    const snap = restoreSnapshot(f.db, g1, { replayFrom: 1 })!;
    expect(snap.map).toBe('l4d_vs_hospital02_subway');
    f.box.resumeOk = true;
    f.sent.length = 0;
    expect(await f.runner.replayGame(f.booking().id, g1, snap)).toBe('ok');
    const i = (p: string) => f.sent.findIndex((c) => c.startsWith(p));
    expect(i(`sm_pug_abort ${token}`)).toBeGreaterThanOrEqual(0);
    expect(i('sm_pug_resume ')).toBeGreaterThan(i(`sm_pug_abort ${token}`));
    expect(i('sm_pug_resume_commit')).toBeLessThan(i('changelevel l4d_vs_hospital02_subway'));
    expect(f.sent.filter((c) => c.startsWith('sm_pug_resume_map '))).toEqual(['sm_pug_resume_map l4d_vs_hospital01_apartment 300 200']);
    expect(f.db.prepare('SELECT COUNT(*) AS n FROM match_rounds WHERE match_id = ? AND ordinal >= 1').get(g1)).toEqual({ n: 0 });
    expect(f.db.prepare('SELECT state FROM matches WHERE id = ?').get(g1)).toEqual({ state: 'live' });
    expect(f.sent.some((c) => c.startsWith('say [Match] Staff replayed'))).toBe(true);
    // The plugin refuses: the game is aborted, the match held.
    round.run(g1, 1, 1, 'a', 50);
    f.box.resumeOk = false;
    const again = restoreSnapshot(f.db, g1, { replayFrom: 1 })!;
    expect(await f.runner.replayGame(f.booking().id, g1, again)).toBe('refused');
    expect(f.db.prepare('SELECT state, abort_cause FROM matches WHERE id = ?').get(g1)).toEqual({ state: 'aborted', abort_cause: 'server_lost' });
    expect(f.match()).toMatchObject({ status: 'admin_hold', hold_reason: 'game_lost' });
  });

  it('moves a booking: the old box goes back, a fresh one is taken and set up again with the game restored', async () => {
    f = await seriesFixture();
    await f.tick();
    const old = f.booking().server_id!;
    const second = f.addServer('box2');
    const g1 = f.gameOf(1).match_id!;
    f.goLive(g1, 'l4d_vs_hospital01_apartment');
    f.box.resumeOk = true;
    expect(await f.runner.moveBooking(f.booking().id)).toBe(old);
    // Taken at once by the relocate pass: the old box went offline before it ran.
    expect(f.booking().server_id).toBe(second);
    await f.runner.idle();
    expect(f.booking()).toMatchObject({ server_id: second, recovering_at: null, waiting_since: null });
    expect(f.db.prepare('SELECT server_id FROM matches WHERE id = ?').get(g1)).toEqual({ server_id: second });
    expect(f.db.prepare('SELECT status FROM servers WHERE id = ?').get(old)).toEqual({ status: 'idle' });
    expect(f.sent.some((c) => c.startsWith('sm_pug_resume '))).toBe(true);
    expect(f.send).toHaveBeenCalledWith(expect.arrayContaining([A[0]]), 'booking_recovered', expect.objectContaining({ content: expect.stringContaining('moved') }));
    // No other box free: the booking waits as after a crash (the second box is
    // offline while the releaser restarts it; the old one is taken out by hand).
    f.db.prepare("UPDATE servers SET status = 'offline' WHERE id = ?").run(old);
    expect(await f.runner.moveBooking(f.booking().id)).toBe(second);
    expect(f.booking()).toMatchObject({ server_id: null, recovering_at: expect.any(String), waiting_since: expect.any(String) });
    // A booking already moving (no box, recovering) is not moved again.
    expect(await f.runner.moveBooking(f.booking().id)).toBeNull();
  });

  it('a move takes the old box out of the pool in the same tick it lets go of it, through the real releaser, so no holder can claim it', async () => {
    let answer: ((back: boolean) => void) | null = null;
    const restarted: number[] = [];
    f = await seriesFixture({
      releaser: (db) => new ServerReleaser(db, async () => {}, {
        restart: (s) => { restarted.push(s.id); return new Promise<boolean>((r) => { answer = r; }); },
      }),
    });
    await f.tick();
    const id = f.booking().id;
    const old = f.booking().server_id!;
    const g1 = f.gameOf(1).match_id!;
    f.goLive(g1, 'l4d_vs_hospital01_apartment');
    f.box.resumeOk = true;
    // Not awaited: everything below runs before any other task or microtask could.
    const moved = f.runner.moveBooking(id);
    expect(f.booking()).toMatchObject({ server_id: null, waiting_since: expect.any(String) });
    // The booking no longer holds it, and still nothing can take it: it is offline, not idle.
    expect(isHeld(f.db, old)).toBe(false);
    expect(f.db.prepare('SELECT status FROM servers WHERE id = ?').get(old)).toEqual({ status: 'offline' });
    expect(claimableServers(f.db).map((s) => s.id)).not.toContain(old);
    expect(claimIdle(f.db, f.t.t)).toBeNull();
    expect(f.runner.pickBox(f.booking())).toBeNull();
    expect(await moved).toBe(old);
    await new Promise((r) => setTimeout(r, 0));
    // The releaser is restarting it, and the booking waits meanwhile.
    expect(restarted).toEqual([old]);
    expect(f.db.prepare('SELECT status FROM servers WHERE id = ?').get(old)).toEqual({ status: 'offline' });
    expect(f.booking()).toMatchObject({ server_id: null });
    // The restart answers: the box is idle again, the releaser wakes the runner and the waiting booking takes the clean box.
    answer!(true);
    await new Promise((r) => setTimeout(r, 0));
    await f.runner.idle();
    expect(f.booking()).toMatchObject({ server_id: old, recovering_at: null, waiting_since: null });
    expect(f.db.prepare('SELECT state FROM matches WHERE id = ?').get(g1)).toEqual({ state: 'live' });
  });
});

describe('SeriesEngine: subs from the box (plan T3c)', () => {
  const live = async () => {
    f = await seriesFixture();
    await f.tick();
    f.box.humans = [...A.slice(0, 4), ...BATS.slice(0, 4), A[4]!];
    f.goLive(f.gameOf(1).match_id!);
    return f.liveGameToken();
  };
  it('puts a registered member in for a locked player: lineup, booking people, the game roster, the box, a chat line', async () => {
    const token = await live();
    const g1 = f.gameOf(1).match_id!;
    f.sent.length = 0;
    await f.line(`PUG ${token} SUB by=${A[1]} out=${A[3]} in=${A[4]} map=0`);
    expect(R.lineupFour(f.db, f.matchId, f.entryA)).toEqual([A[0], A[1], A[2], A[4]]);
    expect(B.peopleOf(f.db, f.booking().id).filter((p) => p.side === 'a').map((p) => [p.steamid, p.role]).sort()).toEqual([[A[0], 'player'], [A[1], 'player'], [A[2], 'player'], [A[3], 'spectator'], [A[4], 'player']].sort());
    expect(f.db.prepare('SELECT team, joined_map, source FROM match_players WHERE match_id = ? AND player_id = ?').get(g1, A[4]!)).toEqual({ team: 'b', joined_map: 0, source: 'web' });
    expect(f.sent).toContain(`sm_pug_sub ${token} ${A[3]} ${A[4]}`);
    expect(f.sent.some((c) => /^say \[Match\] .+ is in for .+ \(Rats, sub 1 of 2\)\.$/.test(c))).toBe(true);
    expect(f.pushes).toContain(f.matchId);
    expect(f.send).not.toHaveBeenCalledWith(expect.anything(), 'event_match_staff', expect.anything());
    // Later games are rostered with the sub.
    f.endGame(g1, [{ map: 'm1', a: 100, b: 900 }]);
    expect(f.match().status).toBe('confirming');
  });

  it('refuses on the box with the site\'s sentence, and re-sends a sub the box did not take', async () => {
    const token = await live();
    f.sent.length = 0;
    await f.line(`PUG ${token} SUB by=${BATS[0]} out=${A[3]} in=${A[4]} map=0`);
    expect(f.sent.some((c) => c.startsWith(`say [Match] Sub refused: ${EVENT_ERRORS.not_manager.text}`))).toBe(true);
    expect(R.lineupFour(f.db, f.matchId, f.entryA)).toEqual(A.slice(0, 4));
    await f.line(`PUG ${token} SUB by=${A[0]} out=${A[3]} in=${BATS[0]} map=0`);
    expect(f.sent.some((c) => c.startsWith(`say [Match] Sub refused: ${EVENT_ERRORS.sub_not_member.text}`))).toBe(true);
    f.box.subOk = false;
    await f.line(`PUG ${token} SUB by=${A[0]} out=${A[3]} in=${A[4]} map=0`);
    expect(R.lineupFour(f.db, f.matchId, f.entryA)).toEqual([A[0], A[1], A[2], A[4]]);
    expect(f.sent.some((c) => c.includes('the server did not take it'))).toBe(true);
    f.box.subOk = true;
    f.sent.length = 0;
    await f.line(`PUG ${token} SUB by=${A[0]} out=${A[3]} in=${A[4]} map=0`);
    expect(f.sent).toContain(`sm_pug_sub ${token} ${A[3]} ${A[4]}`);
    expect(R.subsUsed(f.db, f.match(), 'a')).toBe(1);
  });

  it('counts the stage\'s limit and refuses the third sub of a side', async () => {
    const token = await live();
    await f.line(`PUG ${token} SUB by=${A[0]} out=${A[3]} in=${A[4]} map=0`);
    await f.line(`PUG ${token} SUB by=${A[0]} out=${A[4]} in=${A[3]} map=0`);
    f.sent.length = 0;
    await f.line(`PUG ${token} SUB by=${A[0]} out=${A[3]} in=${A[4]} map=0`);
    expect(f.sent.some((c) => c.startsWith(`say [Match] Sub refused: ${EVENT_ERRORS.sub_limit.text}`))).toBe(true);
  });

  it('refuses a ringer the booking accepted but the entry never registered, and leaves the booking alone (ledger)', async () => {
    const token = await live();
    const b = f.booking().id;
    f.db.prepare("INSERT INTO booking_people (booking_id, side, steamid, role, status, added_by, added_at) VALUES (?, 'a', ?, 'ringer', 'accepted', ?, ?)")
      .run(b, A[5]!, A[0]!, new Date(f.t.t).toISOString());
    const people = B.peopleOf(f.db, b);
    f.sent.length = 0;
    await f.line(`PUG ${token} SUB by=${A[0]} out=${A[3]} in=${A[5]} map=0`);
    expect(f.sent.some((c) => c.startsWith(`say [Match] Sub refused: ${EVENT_ERRORS.sub_not_member.text}`))).toBe(true);
    expect(f.sent.some((c) => c.startsWith('sm_pug_sub '))).toBe(false);
    expect(B.peopleOf(f.db, b)).toEqual(people);
    expect(R.lineupFour(f.db, f.matchId, f.entryA)).toEqual(A.slice(0, 4));
  });

  it('undoes a sub the box refuses because a chapter is being played, and tells the captain (ledger)', async () => {
    const token = await live();
    const g1 = f.gameOf(1).match_id!;
    const people = B.peopleOf(f.db, f.booking().id);
    f.box.subOk = false;
    f.box.subErr = 'not between chapters';
    f.sent.length = 0;
    await f.line(`PUG ${token} SUB by=${A[0]} out=${A[3]} in=${A[4]} map=0`);
    expect(f.sent).toContain(`sm_pug_sub ${token} ${A[3]} ${A[4]}`);
    expect(f.sent.some((c) => c.startsWith('say [Match] Sub refused: subs are made between chapters'))).toBe(true);
    expect(R.lineupFour(f.db, f.matchId, f.entryA)).toEqual(A.slice(0, 4));
    expect(R.subsUsed(f.db, f.match(), 'a')).toBe(0);
    expect(B.peopleOf(f.db, f.booking().id)).toEqual(people);
    expect(f.db.prepare('SELECT 1 FROM match_players WHERE match_id = ? AND player_id = ?').get(g1, A[4]!)).toBeUndefined();
    // At the next ready-up the same !sub goes through, as the first of two.
    f.box.subOk = true;
    f.sent.length = 0;
    await f.line(`PUG ${token} SUB by=${A[0]} out=${A[3]} in=${A[4]} map=0`);
    expect(R.lineupFour(f.db, f.matchId, f.entryA)).toEqual([A[0], A[1], A[2], A[4]]);
    expect(f.sent.some((c) => /\(Rats, sub 1 of 2\)\.$/.test(c))).toBe(true);
    expect(R.subsUsed(f.db, f.match(), 'a')).toBe(1);
  });

  it('keeps a recorded sub the box has not taken yet when a re-send meets a chapter in play', async () => {
    const token = await live();
    f.box.subOk = false;
    await f.line(`PUG ${token} SUB by=${A[0]} out=${A[3]} in=${A[4]} map=0`);
    f.box.subErr = 'not between chapters';
    f.sent.length = 0;
    await f.line(`PUG ${token} SUB by=${A[0]} out=${A[3]} in=${A[4]} map=0`);
    expect(f.sent.some((c) => c.includes('but a chapter is being played. Type the !sub again at the next ready-up.'))).toBe(true);
    expect(R.lineupFour(f.db, f.matchId, f.entryA)).toEqual([A[0], A[1], A[2], A[4]]);
    expect(R.subsUsed(f.db, f.match(), 'a')).toBe(1);
  });

  it('lets the sub stand when the game has no tournament roster row to add (addTournamentSub null, ledger)', async () => {
    const token = await live();
    const g1 = f.gameOf(1).match_id!;
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    let logged: unknown[][] = [];
    subHook.nullNext = true;
    try {
      await f.line(`PUG ${token} SUB by=${A[0]} out=${A[3]} in=${A[4]} map=0`);
      logged = [...err.mock.calls];
    } finally {
      subHook.nullNext = false;
      err.mockRestore();
    }
    expect(logged.some((c) => String(c[0]).includes(`got no roster row for ${A[4]}`))).toBe(true);
    expect(R.lineupFour(f.db, f.matchId, f.entryA)).toEqual([A[0], A[1], A[2], A[4]]);
    expect(f.db.prepare('SELECT 1 FROM match_players WHERE match_id = ? AND player_id = ?').get(g1, A[4]!)).toBeUndefined();
    expect(f.sent).toContain(`sm_pug_sub ${token} ${A[3]} ${A[4]}`);
  });

  it('ignores the subbed-out player\'s PLAYER disconnect: no drop, no hold, the match plays on (ledger)', async () => {
    const token = await live();
    await f.line(`PUG ${token} PLAYER event=connect steamid=${A[3]}`);
    await f.line(`PUG ${token} SUB by=${A[0]} out=${A[3]} in=${A[4]} map=0`);
    const presence = () => f.db.prepare('SELECT state FROM match_presence WHERE steamid = ?').get(A[3]!);
    expect(presence()).toEqual({ state: 'connected' });
    await f.line(`PUG ${token} PLAYER event=disconnect steamid=${A[3]}`);
    expect(recordPresenceLine(f.db, { kind: 'player', token, steamid: A[3]!, event: 'disconnect' })).toBeNull();
    f.box.humans = f.box.humans.filter((s) => s !== A[3]);
    f.t.t += MIN;
    await f.tick();
    expect(presence()).toEqual({ state: 'connected' });
    expect(f.match().status).toBe('live');
    expect(f.alerts.filter((a) => a.kind === 'problem' || a.kind === 'abandon')).toEqual([]);
    expect(f.db.prepare('SELECT state FROM matches WHERE id = ?').get(f.gameOf(1).match_id!)).toEqual({ state: 'live' });
  });
});

describe('SeriesEngine: the staff freeze (plan T3c)', () => {
  const live = async () => {
    f = await seriesFixture();
    await f.tick();
    f.goLive(f.gameOf(1).match_id!);
    return f.liveGameToken();
  };
  it('mirrors the box\'s ADMINPAUSE lines, alerting staff on a call', async () => {
    const token = await live();
    await f.line(`PUG ${token} ADMINPAUSE state=on by=${A[2]} cause=call`);
    expect(f.match()).toMatchObject({ admin_pause_at: new Date(f.t.t).toISOString(), admin_pause_by: A[2] });
    expect(f.alerts.filter((a) => a.kind === 'problem' && a.text.includes('called staff from the server'))).toHaveLength(1);
    await f.line(`PUG ${token} ADMINPAUSE state=on by=${A[2]} cause=call`);
    expect(f.alerts.filter((a) => a.kind === 'problem' && a.text.includes('called staff'))).toHaveLength(1);
    await f.line(`PUG ${token} ADMINPAUSE state=off by=site cause=reset`);
    expect(f.match().admin_pause_at).toBeNull();
    await f.line(`PUG ${'0'.repeat(32)} ADMINPAUSE state=on by=site cause=staff`);
    expect(f.match().admin_pause_at).toBeNull();
  });

  it('freezes and unfreezes from the desk through the box, telling both rosters', async () => {
    const token = await live();
    f.sent.length = 0;
    const r = await f.series.freeze(f.matchId, ADMIN, true);
    expect(r.ok).toBe(true);
    expect(f.sent.find((c) => c.startsWith('sm_pug_adminpause '))).toBe(`sm_pug_adminpause ${token} on "boss"`);
    expect(f.match().admin_pause_by).toBe(ADMIN);
    expect(f.send).toHaveBeenCalledWith(expect.arrayContaining([A[0], BATS[0]]), 'event_match_staff', expect.objectContaining({ content: expect.stringContaining('staff froze the game') }));
    expect(await f.series.freeze(f.matchId, ADMIN, true)).toEqual({ ok: false, error: 'already_frozen' });
    // The box's own line for the same change is a no-op.
    await f.line(`PUG ${token} ADMINPAUSE state=on by=site cause=staff`);
    expect(f.db.prepare("SELECT COUNT(*) AS n FROM event_log WHERE action = 'match_frozen'").get()).toEqual({ n: 1 });
    f.box.down = true;
    expect(await f.series.freeze(f.matchId, ADMIN, false)).toEqual({ ok: false, error: 'no_box' });
    f.box.down = false;
    expect((await f.series.freeze(f.matchId, ADMIN, false)).ok).toBe(true);
    expect(f.match().admin_pause_at).toBeNull();
    f.endGame(f.gameOf(1).match_id!, [{ map: 'm1', a: 100, b: 900 }]);
    expect(await f.series.freeze(f.matchId, ADMIN, true)).toEqual({ ok: false, error: 'not_live_phase' });
  });

  it('records nothing when the box refuses the freeze', async () => {
    await live();
    f.box.freezeOk = false;
    expect(await f.series.freeze(f.matchId, ADMIN, true)).toEqual({ ok: false, error: 'no_box' });
    expect(f.match().admin_pause_at).toBeNull();
    expect(f.send).not.toHaveBeenCalledWith(expect.anything(), 'event_match_staff', expect.anything());
  });

  it('keeps cause forced: an admin\'s !forceunpause lifts the freeze, logged and shown to staff as forced (ledger)', async () => {
    const token = await live();
    await f.line(`PUG ${token} ADMINPAUSE state=on by=${A[2]} cause=call`);
    await f.line(`PUG ${token} ADMINPAUSE state=off by=${ADMIN} cause=forced`);
    expect(f.match().admin_pause_at).toBeNull();
    const row = f.db.prepare("SELECT actor, json_extract(detail, '$.cause') AS cause FROM event_log WHERE action = 'match_unfrozen'").get();
    expect(row).toEqual({ actor: ADMIN, cause: 'forced' });
    expect(f.alerts.filter((a) => a.kind === 'problem' && a.text.includes('boss lifted the staff freeze in game with !forceunpause (forced)'))).toHaveLength(1);
  });

  it('takes the reset line an ended game\'s token carries, and never lets it lift a later game\'s freeze (ledger)', async () => {
    const t1 = await live();
    const g1 = f.gameOf(1).match_id!;
    await f.line(`PUG ${t1} ADMINPAUSE state=on by=${A[2]} cause=call`);
    // The game is aborted under the freeze (staff, the reaper): the match is held and the token is old.
    f.db.prepare("UPDATE matches SET state = 'aborted', abort_cause = 'admin', ended_at = datetime('now') WHERE id = ?").run(g1);
    await f.tick();
    expect(f.match()).toMatchObject({ status: 'admin_hold' });
    await f.line(`PUG ${t1} ADMINPAUSE state=off by=site cause=reset`);
    expect(f.match().admin_pause_at).toBeNull();
  });

  it('a late reset from game 1 leaves the tiebreak\'s freeze alone', async () => {
    const t1 = await live();
    const g1 = f.gameOf(1);
    f.endGame(g1.match_id!, [{ map: 'l4d_vs_hospital02_subway', a: 200, b: 200 }]);
    f.t.t += MIN;
    await f.tick();
    const tb = R.gamesOf(f.db, f.matchId).find((g) => g.tiebreak_of === g1.id)!;
    expect(tb.match_id).not.toBeNull();
    f.goLive(tb.match_id!);
    const t2 = f.liveGameToken();
    expect(t2).not.toBe(t1);
    await f.line(`PUG ${t2} ADMINPAUSE state=on by=${A[2]} cause=call`);
    await f.line(`PUG ${t1} ADMINPAUSE state=off by=site cause=reset`);
    expect(f.match().admin_pause_by).toBe(A[2]);
    // The tiebreak's own reset lifts it.
    await f.line(`PUG ${t2} ADMINPAUSE state=off by=site cause=reset`);
    expect(f.match().admin_pause_at).toBeNull();
  });
});

describe('pug-match 0.3.25 rcon answers (plugin/pug-tourney.inc)', () => {
  const OUT = '76561199000000804';
  const IN = '76561199000000805';
  it('reads sm_pug_sub\'s answers', () => {
    expect(parseSubReply(`PUGOK sub out=${OUT} in=${IN} slot=8`, OUT, IN)).toEqual({ ok: true, already: false });
    expect(parseSubReply('PUGOK sub already', OUT, IN)).toEqual({ ok: true, already: true });
    expect(parseSubReply('PUGERR not between chapters', OUT, IN)).toEqual({ ok: false, error: 'not between chapters' });
    expect(parseSubReply('PUGERR already rostered\n', OUT, IN)).toEqual({ ok: false, error: 'already rostered' });
    expect(parseSubReply(`L 10/07/2026 - 20:00:00: noise\nPUGOK sub out=${OUT} in=${IN} slot=3\n`, OUT, IN)).toEqual({ ok: true, already: false });
    expect(parseSubReply(`PUGOK sub out=${IN} in=${OUT} slot=3`, OUT, IN)).toEqual({ ok: false, error: 'other players' });
    expect(parseSubReply('Unknown command "sm_pug_sub"', OUT, IN)).toBeNull();
    expect(parseSubReply('', OUT, IN)).toBeNull();
    expect(parseSubReply(undefined, OUT, IN)).toBeNull();
  });
  it('reads sm_pug_adminpause\'s answers', () => {
    expect(adminPauseTook('PUGOK adminpause=on frozen=1', true)).toBe(true);
    expect(adminPauseTook('PUGOK adminpause=off frozen=0\n', false)).toBe(true);
    expect(adminPauseTook('PUGOK adminpause=on frozen=0', true)).toBe(false);
    expect(adminPauseTook('PUGOK adminpause=off frozen=0', true)).toBe(false);
    expect(adminPauseTook('PUGERR bad token', true)).toBe(false);
    expect(adminPauseTook(null, false)).toBe(false);
  });
});

describe('SeriesEngine: the desk tools (plan T3c)', () => {
  useNoMercy();

  it('replays a chapter of the live game through the box and tells both rosters; refuses the finale and a chapter not reached', async () => {
    f = await seriesFixture();
    await f.tick();
    const g1 = f.gameOf(1).match_id!;
    f.goLive(g1, 'l4d_vs_hospital03_sewers');
    const round = f.db.prepare("INSERT INTO match_rounds (match_id, ordinal, half, surv_team, score, ended_at) VALUES (?, ?, ?, ?, ?, datetime('now'))");
    round.run(g1, 0, 1, 'a', 300); round.run(g1, 0, 2, 'b', 200); round.run(g1, 1, 1, 'a', 100); round.run(g1, 1, 2, 'b', 150); round.run(g1, 2, 1, 'a', 10);
    f.db.prepare("INSERT INTO match_live_maps (match_id, ordinal, map, team_a_score, team_b_score) VALUES (?, 0, 'l4d_vs_hospital01_apartment', 300, 200), (?, 1, 'l4d_vs_hospital02_subway', 100, 150), (?, 2, 'l4d_vs_hospital03_sewers', 0, 0)").run(g1, g1, g1);
    expect(f.series.replayable(f.matchId)).toEqual([
      { ordinal: 0, map: 'l4d_vs_hospital01_apartment' }, { ordinal: 1, map: 'l4d_vs_hospital02_subway' }, { ordinal: 2, map: 'l4d_vs_hospital03_sewers' },
    ]);
    expect(await f.series.replayChapter(f.matchId, ADMIN, 3)).toEqual({ ok: false, error: 'chapter_not_replayable' });
    expect(await f.series.replayChapter(f.matchId, ADMIN, 'x')).toEqual({ ok: false, error: 'chapter_not_replayable' });
    f.box.resumeOk = true;
    f.sent.length = 0;
    expect(await f.series.replayChapter(f.matchId, ADMIN, 1)).toEqual({ ok: true, value: { map: 'l4d_vs_hospital02_subway' } });
    expect(f.sent).toContain('changelevel l4d_vs_hospital02_subway');
    expect(f.db.prepare('SELECT COUNT(*) AS n FROM match_rounds WHERE match_id = ?').get(g1)).toEqual({ n: 2 });
    expect(f.db.prepare("SELECT detail FROM event_log WHERE action = 'chapter_replayed'").get()).toEqual({ detail: JSON.stringify({ matchId: f.matchId, gameId: f.gameOf(1).id, ordinal: 1, map: 'l4d_vs_hospital02_subway' }) });
    expect(f.send).toHaveBeenCalledWith(expect.arrayContaining([A[0], BATS[0]]), 'event_match_staff', expect.objectContaining({ content: expect.stringContaining('replayed from its start (chapter 2 of No Mercy)') }));
    expect(f.match().status).toBe('live');
    // The plugin refuses: aborted, held, the route hears replay_failed.
    f.box.resumeOk = false;
    expect(await f.series.replayChapter(f.matchId, ADMIN, 0)).toEqual({ ok: false, error: 'replay_failed' });
    expect(f.match()).toMatchObject({ status: 'admin_hold', hold_reason: 'game_lost', hold_from: 'live' });
    expect(await f.series.replayChapter(f.matchId, ADMIN, 0)).toEqual({ ok: false, error: 'not_live_phase' });
  });

  it('moves the match to another server and notes it; refuses with no spare box only once the wait runs out', async () => {
    f = await seriesFixture();
    await f.tick();
    f.goLive(f.gameOf(1).match_id!, 'l4d_vs_hospital01_apartment');
    f.box.resumeOk = true;
    const old = f.booking().server_id!;
    f.addServer('box2');
    const r = await f.series.moveServer(f.matchId, ADMIN);
    expect(r.ok).toBe(true);
    await f.runner.idle();
    expect(f.booking().server_id).not.toBe(old);
    expect(f.db.prepare("SELECT detail FROM event_log WHERE action = 'server_moved'").get()).toEqual({ detail: JSON.stringify({ matchId: f.matchId, fromServerId: old }) });
    expect(f.send).toHaveBeenCalledWith(expect.arrayContaining([A[0], BATS[0]]), 'event_match_staff', expect.objectContaining({ content: expect.stringContaining('moved the match to another server') }));
    expect(f.match().status).toBe('live');
    // Recovering: a second move is refused.
    f.db.prepare("UPDATE bookings SET recovering_at = ? WHERE id = ?").run(new Date(f.t.t).toISOString(), f.booking().id);
    expect(await f.series.moveServer(f.matchId, ADMIN)).toEqual({ ok: false, error: 'no_box' });
  });

  it('extends the grace and says so on the box; releases a hold back where it came from; reopens the veto and cancels the booking', async () => {
    f = await seriesFixture();
    await f.tick();
    expect(f.series.extendGrace(f.matchId, ADMIN, 61)).toEqual({ ok: false, error: 'bad_minutes' });
    const before = f.match().deadline!;
    const r = f.series.extendGrace(f.matchId, ADMIN, 10);
    expect(r.ok && r.value.deadline).toBe(new Date(Date.parse(before) + 10 * MIN).toISOString());
    expect(f.sent.some((c) => c.startsWith('say [Match] Staff gave both teams 10 more minutes to connect'))).toBe(true);
    expect(f.send).toHaveBeenCalledWith(expect.anything(), 'event_match_staff', expect.objectContaining({ content: expect.stringContaining('extended the time to connect (10 minutes)') }));
    // A hold from connect releases to a fresh grace from the booking's rules.
    R.holdMatch(f.db, { matchId: f.matchId, by: ADMIN, reason: 'Checking', now: new Date(f.t.t) });
    f.t.t += 3 * MIN;
    const released = f.series.releaseHold(f.matchId, ADMIN);
    const grace = B.bookingRules(f.booking())!.noShowGraceMinutes;
    expect(released.ok && released.value).toMatchObject({ status: 'connect', deadline: new Date(f.t.t + grace * MIN).toISOString() });
    expect(f.send).toHaveBeenCalledWith(expect.anything(), 'event_match_staff', expect.objectContaining({ content: expect.stringContaining('released the hold') }));
    expect(f.series.releaseHold(f.matchId, ADMIN)).toEqual({ ok: false, error: 'not_held' });
    // Reopen: a booked room with no game pushed yet (the game row exists, so it is refused) and a room before booking.
    expect(f.series.reopenVeto(f.matchId, ADMIN)).toEqual({ ok: false, error: 'game_started' });
    expect(f.booking().ending_at).toBeNull();
    f.close();
    f = await seriesFixture();
    f.db.prepare("UPDATE servers SET status = 'live'").run();
    await f.tick();
    expect(f.match().status).toBe('booking');
    expect(f.booking().state).toBe('scheduled');
    const reopened = f.series.reopenVeto(f.matchId, ADMIN);
    expect(reopened.ok && reopened.value.status).toBe('veto');
    expect(f.db.prepare('SELECT state FROM bookings').get()).toEqual({ state: 'cancelled' });
    expect(f.match().booking_id).toBeNull();
    expect(f.send).toHaveBeenCalledWith(expect.anything(), 'event_match_staff', expect.objectContaining({ content: expect.stringContaining('reopened the veto') }));
  });
});

/** A live game 1 on the subway with chapter 1 finished (Task 4 and Task 7 ledger tests). */
async function liveOnSubway(): Promise<{ g1: number; token: string; rounds: () => number }> {
  f = await seriesFixture();
  await f.tick();
  const g1 = f.gameOf(1).match_id!;
  f.goLive(g1, 'l4d_vs_hospital02_subway');
  const round = f.db.prepare("INSERT INTO match_rounds (match_id, ordinal, half, surv_team, score, ended_at) VALUES (?, ?, ?, ?, ?, datetime('now'))");
  round.run(g1, 0, 1, 'a', 300); round.run(g1, 0, 2, 'b', 200); round.run(g1, 1, 1, 'a', 50);
  f.db.prepare("INSERT INTO match_live_maps (match_id, ordinal, map, team_a_score, team_b_score) VALUES (?, 0, 'l4d_vs_hospital01_apartment', 300, 200), (?, 1, 'l4d_vs_hospital02_subway', 0, 0)").run(g1, g1);
  return {
    g1, token: f.liveGameToken(),
    rounds: () => (f.db.prepare('SELECT COUNT(*) AS n FROM match_rounds WHERE match_id = ?').get(g1) as { n: number }).n,
  };
}

describe('BookingRunner.replayGame answers (plan T3c Task 4 ledger)', () => {
  useNoMercy();
  const state = (id: number) => f.db.prepare('SELECT state, abort_cause FROM matches WHERE id = ?').get(id);

  it('refused: the game is aborted but the rows of the chapters the replay would have dropped stay', async () => {
    const { g1, rounds } = await liveOnSubway();
    f.box.resumeOk = false;
    expect(await f.runner.replayGame(f.booking().id, g1, restoreSnapshot(f.db, g1, { replayFrom: 0 })!)).toBe('refused');
    expect(state(g1)).toEqual({ state: 'aborted', abort_cause: 'server_lost' });
    expect(rounds()).toBe(3);
    expect(f.db.prepare('SELECT COUNT(*) AS n FROM match_live_maps WHERE match_id = ?').get(g1)).toEqual({ n: 2 });
  });

  it('error: the abort line never got an answer, so nothing is aborted, held or dropped', async () => {
    const { g1, rounds } = await liveOnSubway();
    f.box.resumeOk = true;
    f.box.failOn = 'sm_pug_abort';
    f.sent.length = 0;
    expect(await f.runner.replayGame(f.booking().id, g1, restoreSnapshot(f.db, g1, { replayFrom: 1 })!)).toBe('error');
    expect(state(g1)).toEqual({ state: 'live', abort_cause: null });
    expect(f.match().status).toBe('live');
    expect(rounds()).toBe(3);
    expect(f.sent.some((c) => c.startsWith('sm_pug_resume') || c.startsWith('changelevel'))).toBe(false);
  });

  it('dropped: the resume burst failed after the abort was answered: the game stays live on the site for staff to try again', async () => {
    const { g1, rounds } = await liveOnSubway();
    f.box.resumeOk = true;
    f.box.failOn = 'sm_pug_resume_commit';
    expect(await f.runner.replayGame(f.booking().id, g1, restoreSnapshot(f.db, g1, { replayFrom: 1 })!)).toBe('dropped');
    expect(f.alerts.some((a) => a.kind === 'problem' && a.text.includes('dropped the game') && a.text.includes('replay again now'))).toBe(true);
    expect(state(g1)).toEqual({ state: 'live', abort_cause: null });
    expect(f.match().status).toBe('live');
    expect(rounds()).toBe(3);
    // Staff try again once the box answers.
    f.box.failOn = null;
    expect(await f.runner.replayGame(f.booking().id, g1, restoreSnapshot(f.db, g1, { replayFrom: 1 })!)).toBe('ok');
    expect(rounds()).toBe(2);
  });

  it('busy: a booking not running, another game, another token or a replay already running touch nothing', async () => {
    const { g1, rounds } = await liveOnSubway();
    f.box.resumeOk = true;
    const snap = restoreSnapshot(f.db, g1, { replayFrom: 1 })!;
    const id = f.booking().id;
    f.sent.length = 0;
    expect(await f.runner.replayGame(id + 1000, g1, snap)).toBe('busy');
    expect(await f.runner.replayGame(id, g1 + 1000, snap)).toBe('busy');
    expect(await f.runner.replayGame(id, g1, { ...snap, token: 'f'.repeat(32) })).toBe('busy');
    expect(f.sent).toEqual([]);
    const first = f.runner.replayGame(id, g1, snap);
    expect(await f.runner.replayGame(id, g1, snap)).toBe('busy');
    expect(await first).toBe('ok');
    expect(f.sent.filter((c) => c.startsWith('sm_pug_abort '))).toHaveLength(1);
    expect(rounds()).toBe(2);
  });
});

describe('SeriesEngine: the desk tools against the box (plan T3c Task 7 ledger)', () => {
  useNoMercy();
  const reset = (token: string) => `PUG ${token} ADMINPAUSE state=off by=site cause=reset`;

  it('a replay the box never answered is refused for staff without holding the match', async () => {
    const { g1, rounds } = await liveOnSubway();
    f.box.resumeOk = true;
    f.box.failOn = 'sm_pug_abort';
    expect(await f.series.replayChapter(f.matchId, ADMIN, 1)).toEqual({ ok: false, error: 'replay_no_answer' });
    expect(f.match()).toMatchObject({ status: 'live', hold_reason: null });
    expect(f.db.prepare('SELECT state FROM matches WHERE id = ?').get(g1)).toEqual({ state: 'live' });
    expect(rounds()).toBe(3);
    expect(f.db.prepare("SELECT COUNT(*) AS n FROM event_log WHERE action = 'chapter_replayed'").get()).toEqual({ n: 0 });
    expect(f.send).not.toHaveBeenCalledWith(expect.anything(), 'event_match_staff', expect.anything());
    expect(EVENT_ERRORS.replay_no_answer.status).toBe(502);
  });

  it('a late reset from a replay\'s abort never lifts a freeze set after the replay; a later reset of the game still does', async () => {
    const { token } = await liveOnSubway();
    await f.line(`PUG ${token} ADMINPAUSE state=on by=${A[2]} cause=call`);
    f.box.resumeOk = true;
    expect((await f.series.replayChapter(f.matchId, ADMIN, 1)).ok).toBe(true);
    // The abort lifted the box's freeze: the site says so before the box's line arrives.
    expect(f.match().admin_pause_at).toBeNull();
    expect(f.db.prepare("SELECT actor, json_extract(detail, '$.cause') AS cause FROM event_log WHERE action = 'match_unfrozen'").all()).toEqual([{ actor: null, cause: 'reset' }]);
    expect((await f.series.freeze(f.matchId, ADMIN, true)).ok).toBe(true);
    await f.line(reset(token));
    expect(f.match().admin_pause_by).toBe(ADMIN);
    // Consumed once: the game's own next reset is the truth again.
    await f.line(reset(token));
    expect(f.match().admin_pause_at).toBeNull();
  });

  it('the abort\'s reset arriving during the replay lifts the freeze once and leaves later lines alone', async () => {
    const { token } = await liveOnSubway();
    await f.line(`PUG ${token} ADMINPAUSE state=on by=${A[2]} cause=call`);
    f.box.resumeOk = true;
    const orig = f.runner.replayGame.bind(f.runner);
    vi.spyOn(f.runner, 'replayGame').mockImplementationOnce(async (...a) => { await f.line(reset(token)); return orig(...a); });
    expect((await f.series.replayChapter(f.matchId, ADMIN, 1)).ok).toBe(true);
    expect(f.match().admin_pause_at).toBeNull();
    expect(f.db.prepare("SELECT COUNT(*) AS n FROM event_log WHERE action = 'match_unfrozen'").get()).toEqual({ n: 1 });
    expect((await f.series.freeze(f.matchId, ADMIN, true)).ok).toBe(true);
    await f.line(reset(token));
    expect(f.match().admin_pause_at).toBeNull();
  });

  it('a late reset after a move leaves the freeze set on the new box alone, and the move records the old box\'s freeze as lifted', async () => {
    f = await seriesFixture();
    await f.tick();
    f.goLive(f.gameOf(1).match_id!, 'l4d_vs_hospital01_apartment');
    const token = f.liveGameToken();
    f.box.resumeOk = true;
    f.addServer('box2');
    await f.line(`PUG ${token} ADMINPAUSE state=on by=${A[2]} cause=call`);
    expect((await f.series.moveServer(f.matchId, ADMIN)).ok).toBe(true);
    await f.runner.idle();
    expect(f.match().admin_pause_at).toBeNull();
    expect(f.liveGameToken()).toBe(token);
    expect((await f.series.freeze(f.matchId, ADMIN, true)).ok).toBe(true);
    await f.line(reset(token));
    expect(f.match().admin_pause_by).toBe(ADMIN);
  });

  it('a move of an unfrozen match expects no reset: a later freeze and its reset behave as before', async () => {
    f = await seriesFixture();
    await f.tick();
    f.goLive(f.gameOf(1).match_id!, 'l4d_vs_hospital01_apartment');
    const token = f.liveGameToken();
    f.box.resumeOk = true;
    f.addServer('box2');
    expect((await f.series.moveServer(f.matchId, ADMIN)).ok).toBe(true);
    await f.runner.idle();
    expect(f.db.prepare("SELECT COUNT(*) AS n FROM event_log WHERE action = 'match_unfrozen'").get()).toEqual({ n: 0 });
    await f.line(`PUG ${token} ADMINPAUSE state=on by=${A[2]} cause=call`);
    await f.line(reset(token));
    expect(f.match().admin_pause_at).toBeNull();
  });
});

describe('SeriesEngine: the desk tools, Task 7 review folded into Task 8', () => {
  useNoMercy();
  const reset = (token: string) => `PUG ${token} ADMINPAUSE state=off by=site cause=reset`;

  it('a replay refused as busy while another runs leaves the running replay\'s expected reset alone', async () => {
    const { token } = await liveOnSubway();
    await f.line(`PUG ${token} ADMINPAUSE state=on by=${A[2]} cause=call`);
    f.box.resumeOk = true;
    const first = f.series.replayChapter(f.matchId, ADMIN, 1);
    expect(await f.series.replayChapter(f.matchId, ADMIN, 1)).toEqual({ ok: false, error: 'changed' });
    expect(await f.series.moveServer(f.matchId, ADMIN)).toEqual({ ok: false, error: 'no_box' });
    expect((await first).ok).toBe(true);
    // The running replay still owned its expectation: the freeze is recorded lifted, and its late line is consumed.
    expect(f.match().admin_pause_at).toBeNull();
    expect((await f.series.freeze(f.matchId, ADMIN, true)).ok).toBe(true);
    await f.line(reset(token));
    expect(f.match().admin_pause_by).toBe(ADMIN);
  });

  it('a replay whose resume burst failed after the abort tells staff the server dropped the game and records the freeze lifted', async () => {
    const { g1, token } = await liveOnSubway();
    await f.line(`PUG ${token} ADMINPAUSE state=on by=${A[2]} cause=call`);
    f.box.resumeOk = true;
    f.box.failOn = 'sm_pug_resume_commit';
    expect(await f.series.replayChapter(f.matchId, ADMIN, 1)).toEqual({ ok: false, error: 'replay_dropped' });
    expect(EVENT_ERRORS.replay_dropped.text).toBe('The server dropped the game while replaying; replay again now.');
    expect(f.match()).toMatchObject({ status: 'live', admin_pause_at: null });
    expect(f.db.prepare('SELECT state FROM matches WHERE id = ?').get(g1)).toEqual({ state: 'live' });
    // Replay again now: the box answers this time.
    f.box.failOn = null;
    expect((await f.series.replayChapter(f.matchId, ADMIN, 1)).ok).toBe(true);
  });

  it('a replay whose abort failed leaves the freeze standing on the site', async () => {
    const { token } = await liveOnSubway();
    await f.line(`PUG ${token} ADMINPAUSE state=on by=${A[2]} cause=call`);
    f.box.resumeOk = true;
    f.box.failOn = 'sm_pug_abort';
    expect(await f.series.replayChapter(f.matchId, ADMIN, 1)).toEqual({ ok: false, error: 'replay_no_answer' });
    expect(f.match().admin_pause_at).not.toBeNull();
  });

  it('the move\'s staff alert says a freeze is lifted and to freeze again from the desk', async () => {
    f = await seriesFixture();
    await f.tick();
    f.goLive(f.gameOf(1).match_id!, 'l4d_vs_hospital01_apartment');
    const token = f.liveGameToken();
    f.addServer('box2');
    await f.line(`PUG ${token} ADMINPAUSE state=on by=${A[2]} cause=call`);
    expect((await f.series.moveServer(f.matchId, ADMIN)).ok).toBe(true);
    await f.runner.idle();
    expect(f.alerts.some((a) => a.kind === 'problem' && a.text.includes('staff moved it off') && a.text.includes('The staff freeze is lifted') && a.text.includes('freeze it again from the Events desk'))).toBe(true);
  });

  it('the sub phases are the room\'s, and the grace fallback is 15 minutes', () => {
    expect([...R.SUB_PHASES]).toEqual(['connect', 'live']);
    expect(DEFAULT_GRACE_MINUTES).toBe(15);
  });
});

describe('SeriesEngine: subs and the freeze, Task 6 ledger', () => {
  const live = async () => {
    f = await seriesFixture();
    await f.tick();
    f.box.humans = [...A.slice(0, 4), ...BATS.slice(0, 4), A[4]!];
    f.goLive(f.gameOf(1).match_id!);
    return f.liveGameToken();
  };

  it('re-sends a recorded sub only for a manager of its side and only while the match is in a sub phase', async () => {
    const token = await live();
    f.box.subOk = false;
    await f.line(`PUG ${token} SUB by=${A[0]} out=${A[3]} in=${A[4]} map=0`);
    expect(R.lineupFour(f.db, f.matchId, f.entryA)).toEqual([A[0], A[1], A[2], A[4]]);
    f.box.subOk = true;
    f.sent.length = 0;
    await f.line(`PUG ${token} SUB by=${BATS[0]} out=${A[3]} in=${A[4]} map=0`);
    expect(f.sent.some((c) => c.startsWith(`say [Match] Sub refused: ${EVENT_ERRORS.not_manager.text}`))).toBe(true);
    expect(f.sent.some((c) => c.startsWith('sm_pug_sub '))).toBe(false);
    R.holdMatch(f.db, { matchId: f.matchId, by: ADMIN, reason: 'Checking', now: new Date(f.t.t) });
    f.sent.length = 0;
    await f.line(`PUG ${token} SUB by=${A[0]} out=${A[3]} in=${A[4]} map=0`);
    expect(f.sent.some((c) => c.startsWith(`say [Match] Sub refused: ${EVENT_ERRORS.not_live_phase.text}`))).toBe(true);
    expect(f.sent.some((c) => c.startsWith('sm_pug_sub '))).toBe(false);
    expect(R.subsUsed(f.db, f.match(), 'a')).toBe(1);
  });

  it('alerts staff when a sub the box refused cannot be undone, and tells the captain the site still has it', async () => {
    const token = await live();
    f.box.subOk = false;
    f.box.subErr = 'not between chapters';
    const orig = f.runner.send.bind(f.runner);
    // Staff hold the match while the box is asked: the undo is refused.
    vi.spyOn(f.runner, 'send').mockImplementationOnce(async (...a) => {
      R.holdMatch(f.db, { matchId: f.matchId, by: ADMIN, reason: 'Checking', now: new Date(f.t.t) });
      return orig(...a);
    });
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    f.sent.length = 0;
    try {
      await f.line(`PUG ${token} SUB by=${A[0]} out=${A[3]} in=${A[4]} map=0`);
    } finally {
      err.mockRestore();
    }
    expect(f.sent.some((c) => c.startsWith('say [Match] Sub refused'))).toBe(false);
    expect(f.sent.some((c) => c.includes('but a chapter is being played') && c.includes('Staff were told'))).toBe(true);
    expect(f.alerts.filter((a) => a.kind === 'problem' && a.text.includes('could not be undone'))).toHaveLength(1);
    expect(R.lineupFour(f.db, f.matchId, f.entryA)).toEqual([A[0], A[1], A[2], A[4]]);
  });

  it('the box\'s own staff line during a desk freeze or unfreeze records the staff member, not a null actor', async () => {
    const token = await live();
    const orig = f.runner.send.bind(f.runner);
    const echo = (state: 'on' | 'off') => async (...a: Parameters<typeof orig>) => {
      const r = await orig(...a);
      await f.line(`PUG ${token} ADMINPAUSE state=${state} by=site cause=staff`);
      return r;
    };
    const spy = vi.spyOn(f.runner, 'send').mockImplementationOnce(echo('on'));
    expect((await f.series.freeze(f.matchId, ADMIN, true)).ok).toBe(true);
    expect(f.match().admin_pause_by).toBe(ADMIN);
    spy.mockImplementationOnce(echo('off'));
    expect((await f.series.freeze(f.matchId, ADMIN, false)).ok).toBe(true);
    expect(f.db.prepare("SELECT action, actor FROM event_log WHERE action IN ('match_frozen', 'match_unfrozen') ORDER BY id").all())
      .toEqual([{ action: 'match_frozen', actor: ADMIN }, { action: 'match_unfrozen', actor: ADMIN }]);
    // Outside a desk call the box's staff line is recorded as it says.
    await f.line(`PUG ${token} ADMINPAUSE state=on by=site cause=staff`);
    expect(f.match()).toMatchObject({ admin_pause_by: null });
    expect(f.match().admin_pause_at).not.toBeNull();
  });
});
