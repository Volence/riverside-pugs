import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import { authedCookie } from './helpers.js';
import { adminEventRoutes } from '../src/routes/adminEvents.js';
import type { Notifier } from '../src/notify/notify.js';
import { activatePlayer, upsertPlayer } from '../src/players.js';
import * as B from '../src/bookings/bookings.js';
import * as D from '../src/events/drafts.js';
import * as N from '../src/events/entries.js';
import * as R from '../src/events/room.js';
import { eventView } from '../src/events/views.js';
import { EVENT_ERRORS } from '../src/events/validate.js';
import { presetConfig } from '../src/events/vetoConfig.js';
import { ADMIN, NOW } from './eventFixture.js';
import { P, cutDraft, type DraftFixture } from './draftFixture.js';
import { A, B as BATS, OUTSIDER, entryFixture, rosterA } from './entryFixture.js';
import { POOL7, TIMERS, type RoomFixture } from './roomFixture.js';
import { MIN, driveLoserPicks, seriesFixture, type SeriesFixture } from './seriesFixture.js';

/**
 * Drafts plan D2c Task 3: staff remove a draft player and put a replacement
 * in, in one action (Rulings 4 to 7, Review Focus 2 to 5).
 */

const must = <T>(r: { ok: true; value: T } | { ok: false; error: string }): T => {
  if (!r.ok) throw new Error(`expected ok, got ${r.error}`);
  return r.value;
};
const LATER = new Date(NOW.getTime() + 3_600_000);
const BENCH = P[15]!;

/** Teams balanced and published: five draft entries (captains P[16..20]), P[15] on the bench. */
function published(o: { startsAt?: string; now?: Date } = {}): DraftFixture & { entries: number[] } {
  const f = cutDraft({ balance: true, ...o });
  const { entries } = must(N.createDraftEntries(f.db, { eventId: f.eventId, actor: ADMIN, now: o.now ?? NOW }));
  return { ...f, entries };
}
const starters = (f: { db: DraftFixture['db'] }, entryId: number) => N.rosterOf(f.db, entryId).starters;
const snapshot = (f: { db: DraftFixture['db'] }) => JSON.stringify([
  f.db.prepare('SELECT * FROM event_entries ORDER BY id').all(),
  f.db.prepare('SELECT * FROM event_entry_players ORDER BY id').all(),
  f.db.prepare('SELECT * FROM event_lineups ORDER BY id').all(),
  f.db.prepare('SELECT * FROM booking_people ORDER BY rowid').all(),
  f.db.prepare('SELECT * FROM match_players ORDER BY rowid').all(),
  f.db.prepare('SELECT COUNT(*) AS n FROM event_log').get(),
]);
const logs = (f: { db: DraftFixture['db'] }, action: string) =>
  (f.db.prepare('SELECT actor, detail FROM event_log WHERE action = ? ORDER BY id').all(action) as { actor: string; detail: string }[])
    .map((r) => ({ actor: r.actor, ...JSON.parse(r.detail) }));

describe('replaceDraftPlayer', () => {
  it('takes a starter off and puts a bench player on, with one log row, and the bench no longer lists them', () => {
    const f = published();
    const entryId = f.entries[0]!;
    const [captain, out, ...rest] = starters(f, entryId);
    const r = N.replaceDraftPlayer(f.db, { eventId: f.eventId, entryId, out: out!, in: BENCH, reason: 'conduct', note: 'Spammed slurs in voice', actor: ADMIN, now: LATER });
    expect(r).toEqual({ ok: true, value: { subbedInMatch: null } });
    expect(starters(f, entryId)).toEqual([captain, ...rest, BENCH]);
    expect(N.entryOfPlayer(f.db, f.eventId, out!)).toBeUndefined();
    expect(logs(f, 'entry_player_replaced')).toEqual([{ actor: ADMIN, entryId, out, in: BENCH, reason: 'conduct' }]);
    // The note is staff-only and never in the event log.
    expect(JSON.stringify(f.db.prepare('SELECT detail FROM event_log').all())).not.toContain('slurs');
    // Review Focus 5: the public bench drops the placed player, and the team lists them.
    const view = eventView(f.db, (f.db.prepare('SELECT * FROM events WHERE id = ?').get(f.eventId) as Parameters<typeof eventView>[1]));
    expect(view.draft?.cut?.bench).toEqual([]);
    expect(view.entries.find((e) => e.id === entryId)?.players).toContain('d15');
  });

  it('takes any eligible player who is on no entry, and works while the event is live', () => {
    const f = published();
    upsertPlayer(f.db, { steamid: OUTSIDER, name: 'fresh', avatar: null }, []);
    activatePlayer(f.db, OUTSIDER);
    f.db.prepare("UPDATE players SET discord_id = 'dz' WHERE steamid = ?").run(OUTSIDER);
    f.db.prepare("UPDATE events SET status = 'live' WHERE id = ?").run(f.eventId);
    const entryId = f.entries[1]!;
    const out = starters(f, entryId)[3]!;
    // OUTSIDER has no PUGs and the draft asks for some: refused with the problem named.
    const r0 = N.replaceDraftPlayer(f.db, { eventId: f.eventId, entryId, out, in: OUTSIDER, reason: 'left', note: null, actor: ADMIN, now: LATER });
    expect(r0.ok).toBe(false);
    expect(!r0.ok && r0.error).toBe('replace_ineligible');
    expect(!r0.ok && r0.detail?.[0]?.steamid).toBe(OUTSIDER);
    f.db.prepare("UPDATE events SET eligibility_json = json_set(eligibility_json, '$.minPugs', 0) WHERE id = ?").run(f.eventId);
    expect(must(N.replaceDraftPlayer(f.db, { eventId: f.eventId, entryId, out, in: OUTSIDER, reason: 'left', note: null, actor: ADMIN, now: LATER }))).toEqual({ subbedInMatch: null });
    expect(starters(f, entryId)).toContain(OUTSIDER);
  });

  it('refuses the captain, a player not on the entry, a player on another team, an ineligible player, a bad reason or note, and writes nothing', () => {
    const f = published();
    const [e0, e1] = f.entries as [number, number];
    const [captain, out] = starters(f, e0);
    const other = starters(f, e1)[2]!;
    upsertPlayer(f.db, { steamid: OUTSIDER, name: 'fresh', avatar: null }, []);
    activatePlayer(f.db, OUTSIDER);
    const before = snapshot(f);
    const go = (over: Partial<Parameters<typeof N.replaceDraftPlayer>[1]>) =>
      N.replaceDraftPlayer(f.db, { eventId: f.eventId, entryId: e0, out: out!, in: BENCH, reason: 'conduct', note: null, actor: ADMIN, now: LATER, ...over });
    const err = (r: ReturnType<typeof go>) => (r.ok ? null : r.error);
    expect(err(go({ out: captain! }))).toBe('captain_replace');
    expect(EVENT_ERRORS.captain_replace.text).toContain('Make another player captain first (Make captain), then replace this player.');
    expect(err(go({ out: other }))).toBe('replace_not_starter');
    expect(err(go({ out: BENCH, in: OUTSIDER }))).toBe('replace_not_starter');
    // Review Focus 3: the one-entry-per-player rule.
    expect(err(go({ in: other }))).toBe('player_entered');
    expect(err(go({ in: OUTSIDER }))).toBe('replace_ineligible');
    expect(err(go({ reason: 'rude' as never }))).toBe('replace_bad_reason');
    expect(err(go({ note: 'x'.repeat(201) }))).toBe('replace_bad_note');
    expect(err(go({ note: 'two\nlines' }))).toBe('replace_bad_note');
    expect(EVENT_ERRORS.replace_bad_note.text).toBe('A staff note is at most 200 characters of plain text, on one line.');
    expect(err(go({ entryId: 999_999 }))).toBe('entry_not_found');
    f.db.prepare("UPDATE events SET status = 'finished' WHERE id = ?").run(f.eventId);
    expect(err(go({}))).toBe('wrong_status');
    expect(snapshot(f)).toBe(before);
  });

  it('takes a staff note of exactly 200 characters', () => {
    const f = published();
    const out = starters(f, f.entries[0]!)[1]!;
    expect(N.replaceDraftPlayer(f.db, { eventId: f.eventId, entryId: f.entries[0]!, out, in: BENCH, reason: 'other', note: 'n'.repeat(200), actor: ADMIN, now: LATER }).ok).toBe(true);
  });

  it('refuses while the event has no teams made (wrong_status), and on a team entry', () => {
    const f = published();
    // Test setup only: the stamp cleared on an event whose entries exist.
    f.db.prepare('UPDATE events SET teams_made_at = NULL WHERE id = ?').run(f.eventId);
    const r = N.replaceDraftPlayer(f.db, { eventId: f.eventId, entryId: f.entries[0]!, out: starters(f, f.entries[0]!)[1]!, in: BENCH, reason: 'conduct', note: null, actor: ADMIN, now: LATER });
    expect(r.ok ? null : r.error).toBe('wrong_status');
    const t = entryFixture();
    const entryId = must(N.registerEntry(t.db, { eventId: t.eventId, teamId: t.teamA, by: A[0]!, roster: rosterA(), now: NOW })).entry.id;
    const r2 = N.replaceDraftPlayer(t.db, { eventId: t.eventId, entryId, out: A[2]!, in: OUTSIDER, reason: 'conduct', note: null, actor: ADMIN, now: NOW });
    expect(r2.ok ? null : r2.error).toBe('replace_not_draft');
  });
});

/** The series fixture's two team entries made into draft entries before the
 *  room runs (test setup only): no site team, a captain each, A[4] (a team
 *  sub) off the roster, and the event a draft whose teams are made. */
const asDraft = (f: RoomFixture) => {
  f.db.prepare("UPDATE events SET entry_kind = 'draft', teams_made_at = ? WHERE id = ?").run(NOW.toISOString(), f.eventId);
  f.db.prepare('UPDATE event_entries SET team_id = NULL, captain_steamid = CASE id WHEN ? THEN ? ELSE ? END WHERE id IN (?, ?)')
    .run(f.entryA, A[0], BATS[0], f.entryA, f.entryB);
  f.db.prepare('UPDATE event_entry_players SET removed_at = ? WHERE entry_id = ? AND steamid = ?').run(NOW.toISOString(), f.entryA, A[4]);
};

describe('a staff replace during a booked series (Ruling 5, Review Focus 2)', () => {
  let s: SeriesFixture;
  afterEach(() => { vi.restoreAllMocks(); s?.close(); });
  const replace = (over: { out?: string; in?: string } = {}) => s.series.staffReplace({
    eventId: s.eventId, entryId: s.entryA, out: over.out ?? A[3]!, in: over.in ?? OUTSIDER, reason: 'cheating', note: null, actor: ADMIN, now: new Date(s.t.t),
  });

  it('between games: the lineup, the booking and the next game\'s burst use the new player, and the team\'s subs are untouched', async () => {
    s = await seriesFixture({ pool: POOL7, veto: presetConfig('loser_picks', 7), drive: (f) => { asDraft(f); driveLoserPicks(f); } });
    await s.tick();
    const g1 = s.gameOf(1);
    s.goLive(g1.match_id!);
    // Bats (match team a) 400, Rats 600: Rats win game 1, Bats pick game 2.
    s.endGame(g1.match_id!, [{ map: 'm1', a: 300, b: 200 }, { map: 'm2', a: 100, b: 400 }]);
    expect(s.match().status).toBe('live');
    s.sent.length = 0;
    const r = await replace();
    expect(r).toEqual({ ok: true, value: { subbedInMatch: s.matchId } });
    // No game was on the box: nothing was sent to it.
    expect(s.sent.some((c) => c.startsWith('sm_pug_sub '))).toBe(false);
    expect(R.lineupFour(s.db, s.matchId, s.entryA)).toEqual([A[0], A[1], A[2], OUTSIDER]);
    expect(R.subsUsed(s.db, s.match(), 'a')).toBe(0);
    expect(N.rosterOf(s.db, s.entryA).starters).toEqual([A[0], A[1], A[2], OUTSIDER]);
    const people = B.peopleOf(s.db, s.booking().id).filter((p) => p.side === 'a').map((p) => [p.steamid, p.role, p.status]);
    expect(people.find((p) => p[0] === OUTSIDER)).toEqual([OUTSIDER, 'player', 'accepted']);
    expect(people.find((p) => p[0] === A[3])).toBeUndefined();
    expect(logs(s, 'entry_player_replaced')).toEqual([{ actor: ADMIN, entryId: s.entryA, out: A[3], in: OUTSIDER, reason: 'cheating', matchId: s.matchId }]);
    expect(s.pushes).toContain(s.matchId);
    // Item 9: the box's allow list goes at once, with the new player and without the removed one.
    const allow = s.sent.filter((c) => c.startsWith('sm_booking_allow_add ')).join(' ');
    expect(s.sent).toContain('sm_booking_allow_begin');
    expect(allow).toContain(OUTSIDER);
    expect(allow).not.toContain(A[3]!);
    // Bats pick, Rats choose survivors: game 2's burst rosters the new player.
    must(R.actVeto(s.db, { matchId: s.matchId, steamid: BATS[0]!, step: 7, action: 'pick', campaign: POOL7[4]!, timers: TIMERS, now: new Date(s.t.t) }));
    s.series.afterPick(s.matchId);
    must(R.actVeto(s.db, { matchId: s.matchId, steamid: A[0]!, step: 8, action: 'survivors', campaign: null, timers: TIMERS, now: new Date(s.t.t) }));
    s.series.afterPick(s.matchId);
    s.t.t += MIN;
    await s.tick();
    const g2 = s.gameOf(2);
    expect(g2.match_id).not.toBeNull();
    const roster = s.sent.filter((c) => c.startsWith('sm_pug_roster '));
    expect(roster).toContain(`sm_pug_roster "${OUTSIDER}:a"`);
    expect(roster.some((c) => c.includes(A[3]!))).toBe(false);
    expect(s.db.prepare('SELECT player_id FROM match_players WHERE match_id = ? AND team = ? ORDER BY rowid').all(g2.match_id!, 'a').map((x) => (x as { player_id: string }).player_id))
      .toEqual([A[0], A[1], A[2], OUTSIDER]);
  });

  it('during a game between chapters: the box takes the sub first, then the game roster carries the new player', async () => {
    s = await seriesFixture({ drive: (f) => { asDraft(f); driveLoserPicks(f); }, pool: POOL7, veto: presetConfig('loser_picks', 7) });
    await s.tick();
    const g1 = s.gameOf(1).match_id!;
    s.goLive(g1);
    const token = s.liveGameToken();
    s.sent.length = 0;
    const firstLog = (s.db.prepare('SELECT COALESCE(MAX(id), 0) AS n FROM event_log').get() as { n: number }).n;
    expect(await replace()).toEqual({ ok: true, value: { subbedInMatch: s.matchId } });
    expect(s.sent).toContain(`sm_pug_sub ${token} ${A[3]} ${OUTSIDER}`);
    // Exactly the room's own row (marked staff) and the replace's row.
    expect(s.db.prepare('SELECT action, json_extract(detail, \'$.staff\') AS staff FROM event_log WHERE id > ? ORDER BY id').all(firstLog))
      .toEqual([{ action: 'player_subbed', staff: 1 }, { action: 'entry_player_replaced', staff: null }]);
    expect(R.lineupFour(s.db, s.matchId, s.entryA)).toEqual([A[0], A[1], A[2], OUTSIDER]);
    expect(R.subsUsed(s.db, s.match(), 'a')).toBe(0);
    // Rats are match team b on game 1 (Bats survive first).
    expect(s.db.prepare('SELECT team, source FROM match_players WHERE match_id = ? AND player_id = ?').get(g1, OUTSIDER)).toEqual({ team: 'b', source: 'web' });
  });

  it('mid-chapter: refused with replace_in_game and the server\'s reason, and nothing is written', async () => {
    s = await seriesFixture({ drive: (f) => { asDraft(f); driveLoserPicks(f); }, pool: POOL7, veto: presetConfig('loser_picks', 7) });
    await s.tick();
    s.goLive(s.gameOf(1).match_id!);
    s.box.subOk = false;
    s.box.subErr = 'not between chapters';
    const before = snapshot(s);
    const r = await replace();
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error).toBe('replace_in_game');
    expect(!r.ok && r.detail).toEqual([{ steamid: A[3], problems: ['The server said: not between chapters.'] }]);
    expect(snapshot(s)).toBe(before);
    expect(R.lineupFour(s.db, s.matchId, s.entryA)).toEqual(A.slice(0, 4));
  });

  it('no answer from the box: it may have taken the sub, so the reverse sub is sent, staff are told, and the replace is refused with nothing written', async () => {
    s = await seriesFixture({ drive: (f) => { asDraft(f); driveLoserPicks(f); }, pool: POOL7, veto: presetConfig('loser_picks', 7) });
    await s.tick();
    s.goLive(s.gameOf(1).match_id!);
    const token = s.liveGameToken();
    const before = snapshot(s);
    const real = s.runner.send.bind(s.runner);
    vi.spyOn(s.runner, 'send').mockImplementation(async (id, lines, what) => {
      if (lines[0] === `sm_pug_sub ${token} ${A[3]} ${OUTSIDER}`) return null;
      return real(id, lines, what);
    });
    s.sent.length = 0;
    const r = await replace();
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error).toBe('replace_in_game');
    expect(!r.ok && r.detail).toEqual([{ steamid: A[3], problems: ['The server did not answer.'] }]);
    expect(s.sent).toContain(`sm_pug_sub ${token} ${OUTSIDER} ${A[3]}`);
    const alert = s.alerts.find((a): a is Extract<typeof a, { kind: 'problem' }> => a.kind === 'problem' && a.text.includes('staff replace'))!;
    expect(alert.text).toContain('got no answer from the server');
    expect(alert.text).toContain('the server undid it.');
    expect(snapshot(s)).toBe(before);
  });

  it('no answer from the box and no answer to the reverse sub either: staff are told the site cannot confirm the server\'s state', async () => {
    s = await seriesFixture({ drive: (f) => { asDraft(f); driveLoserPicks(f); }, pool: POOL7, veto: presetConfig('loser_picks', 7) });
    await s.tick();
    s.goLive(s.gameOf(1).match_id!);
    const token = s.liveGameToken();
    const before = snapshot(s);
    const real = s.runner.send.bind(s.runner);
    vi.spyOn(s.runner, 'send').mockImplementation(async (id, lines, what) => {
      if (lines[0] === `sm_pug_sub ${token} ${A[3]} ${OUTSIDER}` || lines[0] === `sm_pug_sub ${token} ${OUTSIDER} ${A[3]}`) return null;
      return real(id, lines, what);
    });
    const r = await replace();
    expect(r.ok ? null : r.error).toBe('replace_in_game');
    const alert = s.alerts.find((a): a is Extract<typeof a, { kind: 'problem' }> => a.kind === 'problem' && a.text.includes('staff replace'))!;
    expect(alert.text).toContain('got no answer from the server');
    expect(alert.text).toContain(`could not confirm the server's state: it may have p${A.length + BATS.length} or p3. Check the live roster or use !sub.`);
    expect(alert.text).not.toContain('NOT undone');
    expect(snapshot(s)).toBe(before);
  });

  it('no answer from the box and the reverse sub refused: the same could-not-confirm wording', async () => {
    s = await seriesFixture({ drive: (f) => { asDraft(f); driveLoserPicks(f); }, pool: POOL7, veto: presetConfig('loser_picks', 7) });
    await s.tick();
    s.goLive(s.gameOf(1).match_id!);
    const token = s.liveGameToken();
    const real = s.runner.send.bind(s.runner);
    vi.spyOn(s.runner, 'send').mockImplementation(async (id, lines, what) => {
      if (lines[0] === `sm_pug_sub ${token} ${A[3]} ${OUTSIDER}`) { s.box.subOk = false; return null; }
      return real(id, lines, what);
    });
    const r = await replace();
    expect(r.ok ? null : r.error).toBe('replace_in_game');
    const alert = s.alerts.find((a): a is Extract<typeof a, { kind: 'problem' }> => a.kind === 'problem' && a.text.includes('staff replace'))!;
    expect(alert.text).toContain(`could not confirm the server's state: it may have p${A.length + BATS.length} or p3. Check the live roster or use !sub.`);
  });

  it('a room state refusal unrelated to the box is replace_not_possible with the room\'s reason, and nothing is written', async () => {
    s = await seriesFixture({ drive: (f) => { asDraft(f); driveLoserPicks(f); }, pool: POOL7, veto: presetConfig('loser_picks', 7) });
    await s.tick();
    s.db.prepare("UPDATE event_matches SET status = 'veto' WHERE id = ?").run(s.matchId);
    const before = snapshot(s);
    const r = await replace();
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error).toBe('replace_not_possible');
    expect(!r.ok && r.detail).toEqual([{ steamid: A[3], problems: [`The match room refused it: ${EVENT_ERRORS.not_live_phase.text}`] }]);
    expect(EVENT_ERRORS.replace_not_possible.status).toBe(409);
    expect(snapshot(s)).toBe(before);
  });

  for (const undone of [true, false]) {
    it(`the box took it but the site then refused: the box is asked to undo it (${undone ? 'undone' : 'not undone'}), staff are told, nothing is written`, async () => {
      s = await seriesFixture({ drive: (f) => { asDraft(f); driveLoserPicks(f); }, pool: POOL7, veto: presetConfig('loser_picks', 7) });
      await s.tick();
      s.goLive(s.gameOf(1).match_id!);
      const token = s.liveGameToken();
      const before = snapshot(s);
      const real = s.runner.send.bind(s.runner);
      // Between the check and the commit the event leaves live (the commit is then refused as wrong_status).
      vi.spyOn(s.runner, 'send').mockImplementation(async (id, lines, what) => {
        const out = await real(id, lines, what);
        if (lines[0] === `sm_pug_sub ${token} ${A[3]} ${OUTSIDER}`) {
          s.db.prepare("UPDATE events SET status = 'finished' WHERE id = ?").run(s.eventId);
          if (!undone) s.box.subOk = false;
        }
        return out;
      });
      s.sent.length = 0;
      const r = await replace();
      expect(r.ok ? null : r.error).toBe('wrong_status');
      expect(s.sent).toContain(`sm_pug_sub ${token} ${OUTSIDER} ${A[3]}`);
      const alert = s.alerts.find((a): a is Extract<typeof a, { kind: 'problem' }> => a.kind === 'problem' && a.text.includes('staff replace'))!;
      expect(alert.text).toContain(undone ? 'the server undid it.' : 'it was NOT undone: the server has');
      expect(snapshot(s)).toBe(before);
    });
  }

  it('refuses without the series engine when a game is on a box, and writes nothing', async () => {
    s = await seriesFixture({ drive: (f) => { asDraft(f); driveLoserPicks(f); }, pool: POOL7, veto: presetConfig('loser_picks', 7) });
    await s.tick();
    s.goLive(s.gameOf(1).match_id!);
    const before = snapshot(s);
    const r = N.replaceDraftPlayer(s.db, { eventId: s.eventId, entryId: s.entryA, out: A[3]!, in: OUTSIDER, reason: 'conduct', note: null, actor: ADMIN, now: new Date(s.t.t) });
    expect(r.ok ? null : r.error).toBe('replace_in_game');
    expect(snapshot(s)).toBe(before);
  });
});

describe('the replace route', () => {
  let desk: FastifyInstance;
  let send: ReturnType<typeof vi.fn>;
  let f: DraftFixture & { entries: number[] };
  const MOD = '76561199000000990';
  beforeEach(async () => {
    const now = new Date();
    f = published({ startsAt: new Date(Date.now() + 9 * 86_400_000).toISOString(), now });
    upsertPlayer(f.db, { steamid: MOD, name: 'mod', avatar: null }, []);
    f.db.prepare('UPDATE players SET is_mod = 1 WHERE steamid = ?').run(MOD);
    send = vi.fn(() => 1);
    desk = Fastify();
    await desk.register(cookie, { secret: 'x'.repeat(32) });
    await desk.register(adminEventRoutes, { db: f.db, store: () => { throw new Error('no store'); }, notifier: { send } as unknown as Notifier, publicUrl: 'https://x' });
    await desk.ready();
  });
  afterEach(async () => { await desk.close(); });
  const post = (as: string, body: object) => desk.inject({
    method: 'POST', url: `/api/admin/events/${f.eventId}/entries/${f.entries[0]}/replace`, cookies: authedCookie(desk, f.db, as), payload: body,
  });

  it('refuses a mod; replaces as an admin with an audit row, a staff note on the removed player, and the three DMs', async () => {
    const [captain, out] = starters(f, f.entries[0]!);
    const body = { out, in: BENCH, reason: 'cheating', note: 'Aim snaps in replay 41' };
    expect((await post(MOD, body)).statusCode).toBe(403);
    expect(send).not.toHaveBeenCalled();
    const res = await post(ADMIN, body);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ subbedInMatch: null });
    const audit = f.db.prepare("SELECT admin_id, detail FROM admin_actions WHERE action = 'event_entry_replace'").all() as { admin_id: string; detail: string }[];
    expect(audit).toHaveLength(1);
    expect(JSON.parse(audit[0]!.detail)).toEqual({ entryId: f.entries[0], out, in: BENCH, reason: 'cheating', note: 'Aim snaps in replay 41' });
    const team = N.getEntry(f.db, f.entries[0]!)!.name;
    expect(f.db.prepare('SELECT author_id, text FROM player_notes WHERE player_id = ?').all(out)).toEqual([
      { author_id: ADMIN, text: `Removed from ${team} in Draft Night by staff (cheating): Aim snaps in replay 41` },
    ]);
    const name = (s: string) => `d${P.indexOf(s)}`;
    const calls = send.mock.calls.map(([to, type, payload]) => ({ to: [...(to as string[])], type, content: (payload as { content: string }).content }));
    expect(calls).toEqual([
      { to: [out], type: 'draft_player_removed', content: `You were removed from ${team} in Draft Night by staff (cheating).` },
      { to: [BENCH], type: 'draft_player_added', content: `You are now on ${team} in Draft Night, captained by ${name(captain!)}: https://x/event/${f.slug}` },
      { to: [captain], type: 'draft_roster_changed', content: `${name(out!)} was replaced by ${name(BENCH)} on your team in Draft Night.` },
    ]);
    expect(JSON.stringify(calls)).not.toContain('Aim snaps');
    // A second try is refused: the player is no longer on the entry.
    const again = await post(ADMIN, body);
    expect(again.statusCode).toBe(409);
    expect(again.json().error).toBe(EVENT_ERRORS.replace_not_starter.text);
  });

  it('refuses with the sentence and the problems, and sends nothing', async () => {
    const [captain] = starters(f, f.entries[0]!);
    const res = await post(ADMIN, { out: captain, in: BENCH, reason: 'conduct', note: null });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe(EVENT_ERRORS.captain_replace.text);
    expect((await post(ADMIN, { out: 5, in: BENCH, reason: 'conduct' })).statusCode).toBe(400);
    expect(send).not.toHaveBeenCalled();
    expect(f.db.prepare("SELECT COUNT(*) AS n FROM admin_actions WHERE action = 'event_entry_replace'").get()).toEqual({ n: 0 });
  });

  it('lists the bench and each draft entry\'s captain for the desk', async () => {
    const res = await desk.inject({ method: 'GET', url: `/api/admin/events/${f.eventId}/entries`, cookies: authedCookie(desk, f.db, MOD) });
    const body = res.json();
    expect(body.bench).toEqual([{ steamid: BENCH, name: 'd15' }]);
    expect(body.entries[0].captainSteamid).toBe(starters(f, f.entries[0]!)[0]);
    must(N.replaceDraftPlayer(f.db, { eventId: f.eventId, entryId: f.entries[0]!, out: starters(f, f.entries[0]!)[1]!, in: BENCH, reason: 'left', note: null, actor: ADMIN, now: new Date() }));
    const after = (await desk.inject({ method: 'GET', url: `/api/admin/events/${f.eventId}/entries`, cookies: authedCookie(desk, f.db, MOD) })).json();
    expect(after.bench).toEqual([]);
    // The signup itself stays; only the bench list drops a placed player.
    expect(D.activeSignups(f.db, f.eventId).some((x) => x.steamid === BENCH)).toBe(true);
  });
});
