import { describe, it, expect, afterEach } from 'vitest';
import * as B from '../src/bookings/bookings.js';
import * as R from '../src/events/room.js';
import { SERVER_ALERT_MS, PRESENCE_FALLBACK_MS } from '../src/events/series.js';
import { A, B as BATS } from './entryFixture.js';
import { MIN, seriesFixture, type SeriesFixture } from './seriesFixture.js';

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

  it('re-pushes the game burst each minute until the game heartbeats', async () => {
    f = await seriesFixture();
    await f.tick();
    const line = f.sent.find((c) => c.startsWith('sm_pug_match '))!;
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
    expect(f.send).toHaveBeenCalledWith(expect.arrayContaining([A[0], BATS[0]]), 'event_match_forfeit', expect.objectContaining({ content: expect.stringContaining('four players on the server') }));
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
    f.box.humans = [...A.slice(0, 4), ...BATS.slice(0, 4)];
    f.goLive(f.gameOf(1).match_id!);
    expect(f.match().status).toBe('live');
    f.t.t += (grace + 1) * MIN;
    await f.tick();
    expect(f.match().status).toBe('live');
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
