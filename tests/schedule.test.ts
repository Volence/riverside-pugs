import { describe, it, expect } from 'vitest';
import * as P from '../src/events/play.js';
import * as R from '../src/events/room.js';
import * as S from '../src/events/schedule.js';
import { setSetting } from '../src/settings.js';
import { ADMIN, NOW } from './eventFixture.js';
import { A, B, OUTSIDER } from './entryFixture.js';
import { TIMERS, windowFixture, type RoomFixture } from './roomFixture.js';

const H = 3_600_000;
const at = (hours: number) => new Date(NOW.getTime() + hours * H);
const RULES: S.ScheduleRules = { autoAcceptHours: 24, leadMinutes: 20 };
const ok = <T>(r: { ok: true; value: T } | { ok: false; error: string }): T => { if (!r.ok) throw new Error(r.error); return r.value; };
const match = (f: RoomFixture) => P.getMatch(f.db, f.matchId)!;
const last = (f: RoomFixture) => f.db.prepare('SELECT action, actor FROM event_log ORDER BY id DESC LIMIT 1').get() as { action: string; actor: string | null };
const propose = (f: RoomFixture, by: string, hours: number, now = NOW) => S.proposeTime(f.db, { matchId: f.matchId, by, time: at(hours).toISOString(), rules: RULES, now });

describe('autoAcceptAt and reminderAt', () => {
  it('locks only a proposal made at least 48 h before its time, and reminds 24 h before the lock when that is an hour or more after the proposal', () => {
    expect(S.autoAcceptAt(NOW.getTime(), at(48).getTime(), 24)).toBe(at(24).toISOString());
    expect(S.autoAcceptAt(NOW.getTime(), at(47).getTime(), 24)).toBeNull();
    expect(S.autoAcceptAt(NOW.getTime(), at(100).getTime(), 6)).toBe(at(6).toISOString());
    expect(S.reminderAt(NOW.getTime(), at(24).toISOString())).toBeNull();
    expect(S.reminderAt(NOW.getTime(), at(25).toISOString())).toBe(at(1).toISOString());
    expect(S.reminderAt(NOW.getTime(), at(72).toISOString())).toBe(at(48).toISOString());
    expect(S.reminderAt(NOW.getTime(), null)).toBeNull();
  });

  it('never locks later than 24 h before the proposed time, however large the setting (review fix)', () => {
    expect(S.autoAcceptAt(NOW.getTime(), at(50).getTime(), 72)).toBe(at(26).toISOString());
    expect(S.autoAcceptAt(NOW.getTime(), at(48).getTime(), 72)).toBe(at(24).toISOString());
    expect(S.autoAcceptAt(NOW.getTime(), at(200).getTime(), 72)).toBe(at(72).toISOString());
  });

  it('reads the reschedule margins from the Competitive settings (plan T5 Ruling 2)', async () => {
    const f = await windowFixture();
    expect(S.scheduleRules(f.db)).toEqual({ autoAcceptHours: 24, leadMinutes: 20, minAheadMinutes: 60, autoAcceptMinAheadHours: 48, reminderHours: 24 });
    setSetting(f.db, 'reschedule_autoaccept_min_ahead_hours', '72');
    setSetting(f.db, 'reschedule_reminder_hours', '12');
    expect(S.scheduleRules(f.db)).toMatchObject({ autoAcceptMinAheadHours: 72, reminderHours: 12 });
    expect(S.autoAcceptAt(NOW.getTime(), at(60).getTime(), 24, null, 72 * 3_600_000)).toBeNull();
    expect(S.autoAcceptAt(NOW.getTime(), at(80).getTime(), 24, null, 72 * 3_600_000)).toBe(at(24).toISOString());
    expect(S.reminderAt(NOW.getTime(), at(24).toISOString(), 12 * 3_600_000)).toBe(at(12).toISOString());
  });
});

describe('proposeTime', () => {
  it('opens one proposal from a manager inside the window, at least an hour ahead, with the lock time, and logs it', async () => {
    const f = await windowFixture();
    const p = ok(propose(f, A[0]!, 72));
    expect(p).toMatchObject({ event_match_id: f.matchId, side: 'a', proposed_by: A[0], proposed_time: at(72).toISOString(), status: 'open', auto_accept_at: at(24).toISOString(), note: '' });
    expect(last(f)).toEqual({ action: 'reschedule_proposed', actor: A[0] });
    expect(match(f).scheduled_at).toBeNull();
    expect(propose(f, B[0]!, 50)).toEqual({ ok: false, error: 'proposal_open' });
  });

  it('refuses a non-manager, a time outside the window or too soon, the time already set, a bad note, and a match that is not waiting in a window stage', async () => {
    const f = await windowFixture();
    expect(propose(f, OUTSIDER, 72)).toEqual({ ok: false, error: 'not_manager' });
    expect(propose(f, A[3]!, 72)).toEqual({ ok: false, error: 'not_manager' });
    expect(propose(f, A[0]!, 0.5)).toEqual({ ok: false, error: 'bad_time' });
    expect(propose(f, A[0]!, 24 * 8)).toEqual({ ok: false, error: 'bad_time' });
    expect(S.proposeTime(f.db, { matchId: f.matchId, by: A[0]!, time: 'tomorrow', rules: RULES, now: NOW })).toEqual({ ok: false, error: 'bad_time' });
    f.db.prepare("UPDATE event_matches SET scheduled_at = ?, schedule_source = 'default' WHERE id = ?").run(at(72).toISOString(), f.matchId);
    expect(propose(f, A[0]!, 72)).toEqual({ ok: false, error: 'bad_time' });
    expect(S.proposeTime(f.db, { matchId: f.matchId, by: A[0]!, time: at(50).toISOString(), note: 'x'.repeat(301), rules: RULES, now: NOW })).toEqual({ ok: false, error: 'bad_reason' });
    const p = ok(S.proposeTime(f.db, { matchId: f.matchId, by: A[0]!, time: at(50).toISOString(), note: '  after  work ', rules: RULES, now: NOW }));
    expect(p.note).toBe('after work');
    ok(S.withdrawProposal(f.db, { matchId: f.matchId, by: A[1]!, now: NOW }));
    R.openRoom(f.db, { matchId: f.matchId, by: null, higher: 'a', seed: 0, timers: TIMERS, now: NOW });
    expect(propose(f, A[0]!, 50)).toEqual({ ok: false, error: 'not_schedulable' });
    const g = await windowFixture();
    g.db.prepare("UPDATE event_stages SET scheduling = 'rolling' WHERE id = ?").run(g.stageId);
    expect(propose(g, A[0]!, 50)).toEqual({ ok: false, error: 'not_schedulable' });
    g.db.prepare("UPDATE event_stages SET scheduling = 'window' WHERE id = ?").run(g.stageId);
    g.db.prepare('UPDATE event_matches SET window_start = NULL, window_end = NULL WHERE id = ?').run(g.matchId);
    expect(propose(g, A[0]!, 50)).toEqual({ ok: false, error: 'not_schedulable' });
    const h = await windowFixture({ to: at(1) });
    expect(propose(h, A[0]!, 0.9, at(2))).toEqual({ ok: false, error: 'not_schedulable' });
  });
});

describe('respondProposal, counterProposal, withdrawProposal', () => {
  it('the other side accepts: the time locks as agreed; or declines: nothing changes', async () => {
    const f = await windowFixture();
    ok(propose(f, A[0]!, 72));
    expect(S.respondProposal(f.db, { matchId: f.matchId, by: A[1]!, accept: true, now: at(1) })).toEqual({ ok: false, error: 'own_proposal' });
    expect(S.respondProposal(f.db, { matchId: f.matchId, by: OUTSIDER, accept: true, now: at(1) })).toEqual({ ok: false, error: 'not_manager' });
    const r = ok(S.respondProposal(f.db, { matchId: f.matchId, by: B[0]!, accept: true, now: at(1) }));
    expect(r.m).toMatchObject({ scheduled_at: at(72).toISOString(), schedule_source: 'agreed', status: 'waiting' });
    expect(r.proposal).toMatchObject({ status: 'accepted', responded_by: B[0], responded_at: at(1).toISOString() });
    expect(last(f)).toEqual({ action: 'reschedule_accepted', actor: B[0] });
    expect(S.respondProposal(f.db, { matchId: f.matchId, by: B[0]!, accept: true, now: at(1) })).toEqual({ ok: false, error: 'no_proposal' });
    ok(propose(f, B[0]!, 96, at(2)));
    const d = ok(S.respondProposal(f.db, { matchId: f.matchId, by: A[0]!, accept: false, now: at(3) }));
    expect(d.proposal.status).toBe('declined');
    expect(match(f).scheduled_at).toBe(at(72).toISOString());
    expect(last(f)).toEqual({ action: 'reschedule_declined', actor: A[0] });
  });

  it('a counter closes the open proposal and opens the other side\'s in one row; a withdrawal is the proposer\'s alone', async () => {
    const f = await windowFixture();
    const first = ok(propose(f, A[0]!, 72));
    expect(S.counterProposal(f.db, { matchId: f.matchId, by: A[0]!, time: at(80).toISOString(), rules: RULES, now: at(1) })).toEqual({ ok: false, error: 'own_proposal' });
    const logs = (f.db.prepare('SELECT COUNT(*) AS n FROM event_log').get() as { n: number }).n;
    const c = ok(S.counterProposal(f.db, { matchId: f.matchId, by: B[0]!, time: at(80).toISOString(), rules: RULES, now: at(1) }));
    expect(c).toMatchObject({ side: 'b', proposed_time: at(80).toISOString(), status: 'open', auto_accept_at: at(25).toISOString() });
    expect(S.getProposal(f.db, first.id)).toMatchObject({ status: 'countered', responded_by: B[0] });
    expect((f.db.prepare('SELECT COUNT(*) AS n FROM event_log').get() as { n: number }).n).toBe(logs + 1);
    expect(last(f)).toEqual({ action: 'reschedule_countered', actor: B[0] });
    expect(S.withdrawProposal(f.db, { matchId: f.matchId, by: A[0]!, now: at(2) })).toEqual({ ok: false, error: 'not_your_proposal' });
    const w = ok(S.withdrawProposal(f.db, { matchId: f.matchId, by: B[0]!, now: at(2) }));
    expect(w.status).toBe('withdrawn');
    expect(S.openProposal(f.db, f.matchId)).toBeUndefined();
    expect(S.withdrawProposal(f.db, { matchId: f.matchId, by: B[0]!, now: at(2) })).toEqual({ ok: false, error: 'no_proposal' });
    expect(S.proposalsOf(f.db, f.matchId).map((p) => p.status)).toEqual(['countered', 'withdrawn']);
  });
});

describe('the clock\'s proposals', () => {
  it('auto-accepts a due proposal once, refusing one already answered or whose time passed', async () => {
    const f = await windowFixture();
    const p = ok(propose(f, A[0]!, 72));
    expect(S.autoAcceptDue(f.db, at(23))).toEqual([]);
    expect(S.autoAcceptDue(f.db, at(24)).map((x) => x.id)).toEqual([p.id]);
    const r = ok(S.autoAccept(f.db, { proposalId: p.id, now: at(24) }));
    expect(r).toMatchObject({ scheduled_at: at(72).toISOString(), schedule_source: 'agreed' });
    expect(last(f)).toEqual({ action: 'reschedule_auto_accepted', actor: null });
    expect(S.getProposal(f.db, p.id)).toMatchObject({ status: 'auto_accepted', responded_by: null, responded_at: at(24).toISOString() });
    expect(S.autoAccept(f.db, { proposalId: p.id, now: at(24) })).toEqual({ ok: false, error: 'changed' });
    const q = ok(propose(f, B[0]!, 100, at(25)));
    expect(S.autoAccept(f.db, { proposalId: q.id, now: at(101) })).toEqual({ ok: false, error: 'changed' });
    const short = await windowFixture();
    const s = ok(propose(short, A[0]!, 30));
    expect(s.auto_accept_at).toBeNull();
    expect(S.autoAcceptDue(short.db, at(200))).toEqual([]);
  });

  it('reminds once, 24 h before the lock, and expires a proposal whose time passed', async () => {
    const f = await windowFixture();
    const p = ok(S.proposeTime(f.db, { matchId: f.matchId, by: A[0]!, time: at(100).toISOString(), rules: { autoAcceptHours: 48, leadMinutes: 20 }, now: NOW }));
    expect(p.auto_accept_at).toBe(at(48).toISOString());
    expect(S.remindersDue(f.db, at(23))).toEqual([]);
    expect(S.remindersDue(f.db, at(24)).map((x) => x.id)).toEqual([p.id]);
    ok(S.noteReminded(f.db, { proposalId: p.id, now: at(24) }));
    expect(last(f)).toEqual({ action: 'reschedule_reminded', actor: null });
    expect(S.remindersDue(f.db, at(25))).toEqual([]);
    expect(S.noteReminded(f.db, { proposalId: p.id, now: at(24) })).toEqual({ ok: false, error: 'changed' });
    const g = await windowFixture();
    const q = ok(propose(g, A[0]!, 30));
    expect(S.staleProposals(g.db, at(29))).toEqual([]);
    expect(S.staleProposals(g.db, at(30)).map((x) => x.id)).toEqual([q.id]);
    const e = ok(S.expireProposal(g.db, { proposalId: q.id, reason: 'time_passed', now: at(30) }));
    expect(e.status).toBe('expired');
    expect(g.db.prepare('SELECT action, actor, detail FROM event_log ORDER BY id DESC LIMIT 1').get()).toMatchObject({ action: 'reschedule_expired', actor: null });
    expect(S.expireProposal(g.db, { proposalId: q.id, reason: 'time_passed', now: at(30) })).toEqual({ ok: false, error: 'changed' });
  });

  it('names the silent side at the window end: no proposal and no answer while the other side proposed', async () => {
    const f = await windowFixture();
    expect(S.silentSide(f.db, match(f))).toBeNull();
    ok(propose(f, A[0]!, 72));
    expect(S.silentSide(f.db, match(f))).toBe('b');
    ok(S.respondProposal(f.db, { matchId: f.matchId, by: B[0]!, accept: false, now: at(1) }));
    expect(S.silentSide(f.db, match(f))).toBeNull();
    const g = await windowFixture();
    ok(propose(g, B[0]!, 72));
    ok(S.counterProposal(g.db, { matchId: g.matchId, by: A[0]!, time: at(80).toISOString(), rules: RULES, now: at(1) }));
    expect(S.silentSide(g.db, match(g))).toBeNull();
    const h = await windowFixture({ to: at(48) });
    ok(propose(h, B[0]!, 30));
    expect(S.expiredWindows(h.db, at(47))).toEqual([]);
    expect(S.expiredWindows(h.db, at(48)).map((m) => m.id)).toEqual([h.matchId]);
    expect(S.silentSide(h.db, match(h))).toBe('a');
  });
});

describe('staffSetTime and the hold from waiting', () => {
  it('staff set any future time on a waiting window match, expiring an open proposal in the same row', async () => {
    const f = await windowFixture();
    const p = ok(propose(f, A[0]!, 72));
    expect(S.staffSetTime(f.db, { matchId: f.matchId, by: ADMIN, time: at(-1).toISOString(), now: NOW })).toEqual({ ok: false, error: 'bad_time' });
    const logs = (f.db.prepare('SELECT COUNT(*) AS n FROM event_log').get() as { n: number }).n;
    const m = ok(S.staffSetTime(f.db, { matchId: f.matchId, by: ADMIN, time: at(24 * 9).toISOString(), now: NOW }));
    expect(m).toMatchObject({ scheduled_at: at(24 * 9).toISOString(), schedule_source: 'staff' });
    expect(S.getProposal(f.db, p.id)).toMatchObject({ status: 'expired', responded_by: ADMIN });
    expect((f.db.prepare('SELECT COUNT(*) AS n FROM event_log').get() as { n: number }).n).toBe(logs + 1);
    expect(last(f)).toEqual({ action: 'match_time_set', actor: ADMIN });
    R.openRoom(f.db, { matchId: f.matchId, by: null, higher: 'a', seed: 0, timers: TIMERS, now: NOW });
    expect(S.staffSetTime(f.db, { matchId: f.matchId, by: ADMIN, time: at(50).toISOString(), now: NOW })).toEqual({ ok: false, error: 'not_schedulable' });
  });

  it('a waiting match can be held at the window end and released back to waiting with no deadline', async () => {
    const f = await windowFixture();
    const h = ok(R.holdMatch(f.db, { matchId: f.matchId, by: null, reason: 'window_expired', now: NOW }));
    expect(h).toMatchObject({ status: 'admin_hold', hold_from: 'waiting', hold_reason: 'window_expired' });
    const r = ok(R.releaseHold(f.db, { matchId: f.matchId, by: ADMIN, timers: TIMERS, graceMinutes: 15, now: NOW }));
    expect(r).toMatchObject({ status: 'waiting', deadline: null, hold_from: null, hold_reason: null });
  });
});

describe('review fixes: a locked time is never forfeited, and the clock re-checks', () => {
  it('a staff time set past the window end is not an expired window', async () => {
    const f = await windowFixture({ to: at(48) });
    ok(propose(f, A[0]!, 30));
    ok(S.staffSetTime(f.db, { matchId: f.matchId, by: ADMIN, time: at(24 * 5).toISOString(), now: at(1) }));
    expect(S.expiredWindows(f.db, at(48))).toEqual([]);
    expect(S.silentSide(f.db, match(f))).toBeNull();
  });

  it('an auto-accepted time still waiting at the window end names no silent side', async () => {
    const f = await windowFixture({ to: at(100) });
    const p = ok(propose(f, A[0]!, 72));
    ok(S.autoAccept(f.db, { proposalId: p.id, now: at(24) }));
    expect(S.expiredWindows(f.db, at(100)).map((m) => m.id)).toEqual([f.matchId]);
    expect(S.silentSide(f.db, match(f))).toBeNull();
    const g = await windowFixture({ to: at(100) });
    ok(propose(g, A[0]!, 72));
    ok(S.respondProposal(g.db, { matchId: g.matchId, by: B[0]!, accept: true, now: at(1) }));
    g.db.prepare("UPDATE event_matches SET schedule_source = NULL WHERE id = ?").run(g.matchId); // test setup: only the accepted row says so
    expect(S.silentSide(g.db, match(g))).toBeNull();
  });

  it('silentSide takes the answering side from the proposal, not from who manages the team now', async () => {
    const f = await windowFixture();
    const p = ok(propose(f, A[0]!, 72));
    ok(S.respondProposal(f.db, { matchId: f.matchId, by: B[0]!, accept: false, now: at(1) }));
    // test setup: the captain who declined has since left the team
    f.db.prepare('UPDATE event_reschedules SET responded_by = ? WHERE id = ?').run(OUTSIDER, p.id);
    expect(S.silentSide(f.db, match(f))).toBeNull();
  });

  it('autoAccept refuses when the event stopped, an entry is out, or the window moved off the proposed time', async () => {
    const f = await windowFixture();
    const p = ok(propose(f, A[0]!, 72));
    f.db.prepare('UPDATE event_matches SET window_end = ? WHERE id = ?').run(at(60).toISOString(), f.matchId);
    expect(S.autoAccept(f.db, { proposalId: p.id, now: at(24) })).toEqual({ ok: false, error: 'changed' });
    const g = await windowFixture();
    const q = ok(propose(g, A[0]!, 72));
    g.db.prepare("UPDATE event_entries SET status = 'dropped' WHERE id = ?").run(g.entryB);
    expect(S.autoAccept(g.db, { proposalId: q.id, now: at(24) })).toEqual({ ok: false, error: 'entry_out' });
    const h = await windowFixture();
    const r = ok(propose(h, A[0]!, 72));
    h.db.prepare("UPDATE events SET status = 'cancelled' WHERE id = ?").run(h.eventId);
    expect(S.autoAccept(h.db, { proposalId: r.id, now: at(24) })).toEqual({ ok: false, error: 'not_live' });
    expect(match(f).scheduled_at).toBeNull();
  });

  it('respondProposal will not accept a time the window no longer holds, though a decline still goes through', async () => {
    const f = await windowFixture();
    ok(propose(f, A[0]!, 72));
    f.db.prepare('UPDATE event_matches SET window_end = ? WHERE id = ?').run(at(60).toISOString(), f.matchId);
    expect(S.respondProposal(f.db, { matchId: f.matchId, by: B[0]!, accept: true, now: at(1) })).toEqual({ ok: false, error: 'bad_time' });
    expect(ok(S.respondProposal(f.db, { matchId: f.matchId, by: B[0]!, accept: false, now: at(1) })).proposal.status).toBe('declined');
  });
});

describe('final review fixes (plan T4)', () => {
  it('staff Set time on a hold from waiting releases it in the same row, with the staff time', async () => {
    const f = await windowFixture({ to: at(48) });
    ok(R.holdMatch(f.db, { matchId: f.matchId, by: null, reason: 'window_expired', now: at(48) }));
    const logs = (f.db.prepare('SELECT COUNT(*) AS n FROM event_log').get() as { n: number }).n;
    const m = ok(S.staffSetTime(f.db, { matchId: f.matchId, by: ADMIN, time: at(24 * 5).toISOString(), now: at(49) }));
    expect(m).toMatchObject({ status: 'waiting', hold_from: null, hold_reason: null, deadline: null, scheduled_at: at(24 * 5).toISOString(), schedule_source: 'staff' });
    expect((f.db.prepare('SELECT COUNT(*) AS n FROM event_log').get() as { n: number }).n).toBe(logs + 1);
    const row = f.db.prepare('SELECT action, actor, detail FROM event_log ORDER BY id DESC LIMIT 1').get() as { action: string; actor: string; detail: string };
    expect(row).toMatchObject({ action: 'match_time_set', actor: ADMIN });
    expect(JSON.parse(row.detail)).toMatchObject({ released: 'window_expired' });
    // A hold from another phase is not a Set time.
    const g = await windowFixture();
    R.openRoom(g.db, { matchId: g.matchId, by: null, higher: 'a', seed: 0, timers: TIMERS, now: NOW });
    ok(R.holdMatch(g.db, { matchId: g.matchId, by: ADMIN, reason: 'staff look', now: NOW }));
    expect(S.staffSetTime(g.db, { matchId: g.matchId, by: ADMIN, time: at(50).toISOString(), now: NOW })).toEqual({ ok: false, error: 'not_schedulable' });
  });

  it('releasing a hold from waiting whose window ended clears the window end, so the match is never an expired window again', async () => {
    const f = await windowFixture({ to: at(48) });
    ok(R.holdMatch(f.db, { matchId: f.matchId, by: null, reason: 'window_expired', now: at(48) }));
    const r = ok(R.releaseHold(f.db, { matchId: f.matchId, by: ADMIN, timers: TIMERS, graceMinutes: 15, now: at(49) }));
    expect(r).toMatchObject({ status: 'waiting', window_end: null });
    expect(S.expiredWindows(f.db, at(100))).toEqual([]);
    // A window still open keeps its end.
    const g = await windowFixture();
    ok(R.holdMatch(g.db, { matchId: g.matchId, by: ADMIN, reason: 'staff look', now: NOW }));
    expect(ok(R.releaseHold(g.db, { matchId: g.matchId, by: ADMIN, timers: TIMERS, graceMinutes: 15, now: at(1) })).window_end).not.toBeNull();
  });

  it('a proposal needs an answer when its lock would fall after the room opens at the time already set', async () => {
    const opens = at(40).getTime() - 20 * 60_000;
    expect(S.autoAcceptAt(NOW.getTime(), at(72).getTime(), 24, opens)).toBe(at(24).toISOString());
    expect(S.autoAcceptAt(NOW.getTime(), at(72).getTime(), 24, at(20).getTime())).toBeNull();
    expect(S.autoAcceptAt(NOW.getTime(), at(72).getTime(), 24, null)).toBe(at(24).toISOString());
    const f = await windowFixture();
    f.db.prepare("UPDATE event_matches SET scheduled_at = ?, schedule_source = 'default' WHERE id = ?").run(at(20).toISOString(), f.matchId);
    expect(ok(propose(f, A[0]!, 72)).auto_accept_at).toBeNull();
    const g = await windowFixture();
    g.db.prepare("UPDATE event_matches SET scheduled_at = ?, schedule_source = 'default' WHERE id = ?").run(at(40).toISOString(), g.matchId);
    expect(ok(propose(g, A[0]!, 72)).auto_accept_at).toBe(at(24).toISOString());
  });

  it('a lock already due gets no reminder (after downtime the lock goes out alone)', async () => {
    const f = await windowFixture();
    const p = ok(S.proposeTime(f.db, { matchId: f.matchId, by: A[0]!, time: at(100).toISOString(), rules: { autoAcceptHours: 48, leadMinutes: 20 }, now: NOW }));
    expect(S.remindersDue(f.db, at(47)).map((x) => x.id)).toEqual([p.id]);
    expect(S.remindersDue(f.db, at(48))).toEqual([]);
    expect(S.remindersDue(f.db, at(60))).toEqual([]);
  });

  it('a counter at the open proposal\'s own time is refused', async () => {
    const f = await windowFixture();
    ok(propose(f, A[0]!, 72));
    expect(S.counterProposal(f.db, { matchId: f.matchId, by: B[0]!, time: at(72).toISOString(), rules: RULES, now: at(1) })).toEqual({ ok: false, error: 'bad_time' });
  });

  it('staff Set time refuses a match with a team out', async () => {
    const f = await windowFixture();
    f.db.prepare("UPDATE event_entries SET status = 'dropped' WHERE id = ?").run(f.entryB);
    expect(S.staffSetTime(f.db, { matchId: f.matchId, by: ADMIN, time: at(50).toISOString(), now: NOW })).toEqual({ ok: false, error: 'entry_out' });
  });

  it('expireProposal takes the reason room_opened', async () => {
    const f = await windowFixture();
    const p = ok(propose(f, A[0]!, 72));
    ok(S.expireProposal(f.db, { proposalId: p.id, reason: 'room_opened', now: at(1) }));
    expect(JSON.parse((f.db.prepare('SELECT detail FROM event_log ORDER BY id DESC LIMIT 1').get() as { detail: string }).detail)).toMatchObject({ reason: 'room_opened' });
  });
});
