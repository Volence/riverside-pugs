import { describe, it, expect, afterEach } from 'vitest';
import * as E from '../src/events/events.js';
import * as P from '../src/events/play.js';
import * as R from '../src/events/room.js';
import { matchRoomView, phaseOf, prefsView } from '../src/events/roomViews.js';
import { NOW } from './eventFixture.js';
import { A, B, OUTSIDER } from './entryFixture.js';
import { TIMERS, roomFixture, windowFixture, type RoomFixture } from './roomFixture.js';
import * as S from '../src/events/schedule.js';
import { seriesFixture, type SeriesFixture, MIN } from './seriesFixture.js';

const at = (min: number) => new Date(NOW.getTime() + min * 60_000);
const view = (f: RoomFixture, viewer: string | null, staff = false) =>
  matchRoomView(f.db, E.getEvent(f.db, f.eventId)!, P.getMatch(f.db, f.matchId)!, viewer, staff, at(5));
const toLineups = (f: RoomFixture) => {
  R.openRoom(f.db, { matchId: f.matchId, by: null, higher: 'a', seed: 0, timers: TIMERS, now: NOW });
  R.readyUp(f.db, { matchId: f.matchId, steamid: A[0], timers: TIMERS, now: at(1) });
  R.readyUp(f.db, { matchId: f.matchId, steamid: B[0], timers: TIMERS, now: at(1) });
  R.actVeto(f.db, { matchId: f.matchId, steamid: A[0], step: 0, action: 'first', campaign: null, timers: TIMERS, now: at(2) });
  R.actVeto(f.db, { matchId: f.matchId, steamid: A[0], step: 1, action: 'ban', campaign: 'dead_air', timers: TIMERS, now: at(2) });
  R.actVeto(f.db, { matchId: f.matchId, steamid: B[0], step: 2, action: 'survivors', campaign: null, timers: TIMERS, now: at(2) });
};

describe('matchRoomView', () => {
  it('shows the ready phase with the deadline and who is ready, to anyone', async () => {
    const f = await roomFixture();
    R.openRoom(f.db, { matchId: f.matchId, by: null, higher: 'a', seed: 0, timers: TIMERS, now: NOW });
    R.readyUp(f.db, { matchId: f.matchId, steamid: B[0], timers: TIMERS, now: at(1) });
    const v = view(f, null);
    expect(v).toMatchObject({ phase: 'ready', higher: 'a', deadline: at(10).toISOString(), serverNow: at(5).toISOString(), ready: { a: false, b: true }, me: null });
    expect(v.a?.name).toBe('Rats');
    expect(v.vetoSummary).toMatch(/^Bo1: ban down to 1/);
  });

  it('shows the pool with bans and the decider, the log, the games and the next step', async () => {
    const f = await roomFixture();
    toLineups(f);
    const v = view(f, null);
    expect(v.phase).toBe('lineup');
    expect(v.pool.map((c) => [c.slug, c.state, c.by, c.game])).toEqual([['no_mercy', 'decider', null, 1], ['dead_air', 'banned', 'a', null]]);
    expect(v.log.map((l) => [l.step, l.side, l.action, l.campaign, l.auto])).toEqual([[0, 'a', 'first', null, false], [1, 'a', 'ban', 'dead_air', false], [2, 'b', 'survivors', null, false]]);
    expect(v.games).toEqual([expect.objectContaining({ game: 1, campaign: 'no_mercy', pickedBy: null, sideBy: 'b', firstSurvivors: 'b' })]);
    expect(v.next).toBeNull();
  });

  it('keeps a locked lineup secret from the other team and outsiders until both are locked', async () => {
    const f = await roomFixture();
    toLineups(f);
    R.lockLineup(f.db, { matchId: f.matchId, steamid: A[0], steamids: [A[1], A[2], A[3], A[4]], timers: TIMERS, now: at(3) });
    expect(view(f, B[2]).lineups).toEqual({ a: null, b: null, aLocked: true, bLocked: false });
    expect(view(f, OUTSIDER).lineups.a).toBeNull();
    expect(view(f, null).lineups.a).toBeNull();
    expect(view(f, B[0]).lineups.a).toBeNull();
    expect(view(f, A[3]).lineups.a!.map((p) => p.steamid)).toEqual([A[1], A[2], A[3], A[4]]);
    expect(view(f, '76561199000000700', true).lineups.a).not.toBeNull();
    R.lockLineup(f.db, { matchId: f.matchId, steamid: B[0], steamids: B.slice(0, 4), timers: TIMERS, now: at(4) });
    const after = view(f, OUTSIDER);
    expect(after.phase).toBe('server');
    expect(after.lineups.b!.map((p) => p.steamid)).toEqual(B.slice(0, 4));
  });

  it('gives a manager their playable roster and default four, a member only their side', async () => {
    const f = await roomFixture();
    toLineups(f);
    R.savePrefs(f.db, { entryId: f.entryA, by: A[0], staff: false, prefs: { defaultFour: [A[1], A[2], A[3], A[4]], side: null, campaigns: {} }, now: NOW });
    expect(view(f, A[1]).me).toMatchObject({ side: 'a', manager: true, defaultFour: [A[1], A[2], A[3], A[4]] });
    expect(view(f, A[1]).me!.playable.map((p) => p.steamid)).toEqual(A.slice(0, 5));
    expect(view(f, A[3]).me).toEqual({ side: 'a', manager: false, playable: [], defaultFour: null });
  });

  it('shows the schedule of a window match to everyone, and what the viewer may do (plan T4)', async () => {
    const f = await windowFixture();
    const time = at(72 * 60).toISOString();
    expect(view(f, null).schedule).toMatchObject({ scheduledAt: null, source: null, windowStart: NOW.toISOString(), opensAt: null, leadMinutes: 20, proposal: null, log: [], canPropose: false, canAnswer: false, canWithdraw: false });
    expect(view(f, A[0]).schedule).toMatchObject({ canPropose: true, canAnswer: false, canWithdraw: false });
    expect(view(f, A[3]).schedule!.canPropose).toBe(false);
    const p = S.proposeTime(f.db, { matchId: f.matchId, by: A[0], time, note: 'late', rules: { autoAcceptHours: 24, leadMinutes: 20 }, now: NOW });
    if (!p.ok) throw new Error(p.error);
    const a = view(f, A[0]).schedule!;
    expect(a.proposal).toMatchObject({ id: p.value.id, side: 'a', time, note: 'late', autoAcceptAt: at(24 * 60).toISOString(), status: 'open', respondedByName: null });
    expect(a.proposal!.byName).toBe((await import('../src/players.js')).getPlayer(f.db, A[0])!.name);
    expect([a.canPropose, a.canAnswer, a.canWithdraw]).toEqual([false, false, true]);
    const b = view(f, B[0]).schedule!;
    expect([b.canPropose, b.canAnswer, b.canWithdraw]).toEqual([false, true, false]);
    S.respondProposal(f.db, { matchId: f.matchId, by: B[0], accept: true, now: at(1) });
    const after = view(f, A[3]).schedule!;
    expect(after).toMatchObject({ scheduledAt: time, source: 'agreed', opensAt: at(72 * 60 - 20).toISOString(), proposal: null });
    expect(after.log.map((l) => [l.status, l.respondedByName !== null])).toEqual([['accepted', true]]);
    // Outsiders see the locked time and the window, never the proposals; staff see them all.
    expect(view(f, null).schedule).toMatchObject({ scheduledAt: time, source: 'agreed', windowStart: NOW.toISOString(), proposal: null, log: [] });
    expect(view(f, OUTSIDER).schedule!.log).toEqual([]);
    expect(view(f, null, true).schedule!.log).toHaveLength(1);
    S.proposeTime(f.db, { matchId: f.matchId, by: B[0], time: at(96 * 60).toISOString(), rules: { autoAcceptHours: 24, leadMinutes: 20 }, now: at(2) });
    expect(view(f, OUTSIDER).schedule!.proposal).toBeNull();
    expect(view(f, A[3]).schedule!.proposal).toMatchObject({ side: 'b' });
    expect(view(f, null, true).schedule).toMatchObject({ proposal: { side: 'b' }, canPropose: false, canAnswer: false, canWithdraw: false });
    const g = await roomFixture();
    expect(view(g, A[0]).schedule).toBeNull();
  });

  it('maps every status to a phase', () => {
    const m = (status: P.MatchStatus, extra: Partial<P.MatchRow> = {}) => ({ status, ready_a_at: null, ready_b_at: null, ...extra }) as P.MatchRow;
    expect(phaseOf(m('veto'))).toBe('ready');
    expect(phaseOf(m('veto', { ready_a_at: 'x', ready_b_at: 'y' }))).toBe('veto');
    expect(['pending', 'waiting', 'lineup', 'booking', 'admin_hold', 'done', 'forfeit', 'bye'].map((s) => phaseOf(m(s as P.MatchStatus))))
      .toEqual(['pending', 'waiting', 'lineup', 'server', 'hold', 'done', 'done', 'done']);
  });
});

describe('prefsView', () => {
  it('lists the roster (no coach), each stage\'s pool and the saved order', async () => {
    const f = await roomFixture();
    R.savePrefs(f.db, { entryId: f.entryA, by: A[0], staff: false, prefs: { defaultFour: null, side: 'infected', campaigns: { [String(f.stageId)]: ['dead_air'] } }, now: NOW });
    const v = prefsView(f.db, E.getEvent(f.db, f.eventId)!, f.entryA);
    expect(v).toMatchObject({ entryId: f.entryA, defaultFour: null, side: 'infected' });
    expect(v.roster.map((p) => p.steamid)).toEqual(A.slice(0, 5));
    expect(v.stages).toEqual([{ stageId: f.stageId, ordinal: 1, pool: [expect.objectContaining({ slug: 'no_mercy' }), expect.objectContaining({ slug: 'dead_air' })], order: ['dead_air'] }]);
  });
});

describe('matchRoomView with a server and a series (plan T3b)', () => {
  let f: SeriesFixture;
  afterEach(() => f?.close());
  const sview = (viewer: string | null, staff = false) => matchRoomView(f.db, E.getEvent(f.db, f.eventId)!, P.getMatch(f.db, f.matchId)!, viewer, staff, new Date(f.t.t));

  it('shows the connect line only to the booking\'s people and staff, with the grace and who is on', async () => {
    f = await seriesFixture();
    await f.tick();
    f.box.humans = [...A.slice(0, 4), B[0]!];
    f.t.t += MIN;
    await f.tick();
    const b = f.booking();
    const mine = sview(A[4]);
    expect(mine.phase).toBe('connect');
    expect(mine.server).toEqual({ state: 'ready', name: 'box', since: b.created_at, connect: { host: '10.0.0.1', port: 27015, password: b.password }, present: { a: 4, b: 1 }, graceEndsAt: f.match().deadline });
    expect(sview(OUTSIDER).server!.connect).toBeNull();
    expect(sview(B[4]).server!.connect).toBeNull();
    expect(sview('76561199000000700', true).server!.connect).not.toBeNull();
    // Signed out, with the box ready: no connect line, and the password nowhere in the view (T3b final review).
    const out = sview(null);
    expect(out.server).toMatchObject({ state: 'ready', connect: null });
    expect(JSON.stringify(out)).not.toContain(b.password);
    expect(mine.games).toEqual([expect.objectContaining({ game: 1, ordinal: 1, tiebreak: false, state: 'live', scoreA: null, matchId: f.gameOf(1).match_id, live: null })]);
    expect(mine.series).toEqual({ bestOf: 1, totalScore: false, winsA: 0, winsB: 0, totalA: 0, totalB: 0, over: false, winner: null });
  });

  it('shows waiting for a server, then the live score, the pick step, the result and the confirm window', async () => {
    f = await seriesFixture();
    f.db.prepare("UPDATE servers SET status = 'live'").run();
    await f.tick();
    expect(sview(null).server).toMatchObject({ state: 'waiting', name: null, connect: null });
    expect(sview(null).phase).toBe('server');
    f.db.prepare("UPDATE servers SET status = 'idle'").run();
    await f.tick();
    const g1 = f.gameOf(1);
    f.goLive(g1.match_id!, 'l4d_vs_hospital02_subway');
    f.db.prepare("INSERT INTO match_rounds (match_id, ordinal, half, surv_team, score) VALUES (?, 0, 1, 'a', 120), (?, 0, 2, 'b', 80)").run(g1.match_id!, g1.match_id!);
    const live = sview(null);
    expect(live.phase).toBe('live');
    // Match team a is Bats: 120 for Bats is score_b for the room.
    expect(live.games[0]!.live).toEqual({ map: 'l4d_vs_hospital02_subway', scoreA: 80, scoreB: 120 });
    f.endGame(g1.match_id!, [{ map: 'l4d_vs_hospital02_subway', a: 300, b: 400 }]);
    const done = sview(null);
    expect(done.phase).toBe('confirming');
    expect(done.games[0]).toMatchObject({ state: 'done', scoreA: 400, scoreB: 300, winner: 'a', live: null });
    expect(done.series).toMatchObject({ winsA: 1, winsB: 0, over: true, winner: 'a' });
    expect(done.confirm).toEqual({ deadline: f.match().deadline, a: false, b: false });
    expect(done.dispute).toBeNull();
    f.series.dispute(f.matchId, B[0]!, 'Rats had five', new Date(f.t.t));
    expect(sview(null)).toMatchObject({ phase: 'hold', holdReason: 'dispute', dispute: { side: 'b', byName: expect.any(String), reason: 'Rats had five' } });
  });

  it('says when staff froze the game (plan T3c)', async () => {
    f = await seriesFixture();
    await f.tick();
    f.goLive(f.gameOf(1).match_id!);
    expect(sview(null).frozen).toBe(false);
    R.setAdminPause(f.db, { matchId: f.matchId, on: true, by: A[0]!, cause: 'call', now: new Date(f.t.t) });
    expect(sview(A[3]).frozen).toBe(true);
  });

  it('maps the series statuses to phases', () => {
    const m = (status: P.MatchStatus) => ({ status, ready_a_at: 'x', ready_b_at: 'y' }) as P.MatchRow;
    expect(['booking', 'connect', 'live', 'confirming'].map((s) => phaseOf(m(s as P.MatchStatus)))).toEqual(['server', 'connect', 'live', 'confirming']);
  });
});
