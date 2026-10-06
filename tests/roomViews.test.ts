import { describe, it, expect } from 'vitest';
import * as E from '../src/events/events.js';
import * as P from '../src/events/play.js';
import * as R from '../src/events/room.js';
import { matchRoomView, phaseOf, prefsView } from '../src/events/roomViews.js';
import { NOW } from './eventFixture.js';
import { A, B, OUTSIDER } from './entryFixture.js';
import { TIMERS, roomFixture, type RoomFixture } from './roomFixture.js';

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
