import { describe, it, expect, vi } from 'vitest';
import * as E from '../src/events/events.js';
import * as N from '../src/events/entries.js';
import * as P from '../src/events/play.js';
import * as T from '../src/teams/teams.js';
import { EventRunner } from '../src/events/runner.js';
import { eventMessage } from '../src/events/messages.js';
import type { Notifier } from '../src/notify/notify.js';
import type { DB } from '../src/db.js';
import { upsertPlayer } from '../src/players.js';
import { NOW, START, ADMIN } from './eventFixture.js';
import { A, B, entryFixture, rosterA, rosterB } from './entryFixture.js';
import { playFixture, SWISS, SE } from './playFixture.js';

const must = <T>(r: { ok: true; value: T } | { ok: false; error: string }): T => {
  if (!r.ok) throw new Error(`expected ok, got ${r.error}`);
  return r.value;
};
const startMinus = (min: number) => new Date(Date.parse(START) - min * 60_000);

function runner(db: Parameters<typeof E.getEvent>[0]) {
  const send = vi.fn((_to: Iterable<string>, _type: string, _payload: unknown) => 1);
  return { send, r: new EventRunner({ db, notifier: { send } as unknown as Notifier, publicUrl: 'https://x' }) };
}

describe('EventRunner', () => {
  it('does nothing before the window', () => {
    const f = entryFixture();
    const { r, send } = runner(f.db);
    r.step(startMinus(61));
    expect(E.getEvent(f.db, f.eventId)!.status).toBe('registration');
    expect(send).not.toHaveBeenCalled();
  });

  it('opens check-in at the window and tells the managers of every active entry, waitlisted ones too', () => {
    const f = entryFixture({ teamCap: 1 });
    must(N.registerEntry(f.db, { eventId: f.eventId, teamId: f.teamA, by: A[0], roster: rosterA(), now: NOW }));
    must(N.registerEntry(f.db, { eventId: f.eventId, teamId: f.teamB, by: B[0], roster: rosterB(), now: NOW }));
    const { r, send } = runner(f.db);
    r.step(startMinus(60));
    expect(E.getEvent(f.db, f.eventId)!.status).toBe('checkin');
    const told = send.mock.calls.flatMap((c) => [...(c[0] as Iterable<string>)]);
    expect(told.sort()).toEqual([A[0], A[1], B[0]].sort());
    expect(send.mock.calls.every((c) => c[1] === 'event_checkin_open')).toBe(true);
  });

  it('after downtime, opens on one tick and closes on the next, never both at once', () => {
    const f = entryFixture();
    must(N.registerEntry(f.db, { eventId: f.eventId, teamId: f.teamA, by: A[0], roster: rosterA(), now: NOW }));
    const { r, send } = runner(f.db);
    r.step(startMinus(5));
    expect(E.getEvent(f.db, f.eventId)).toMatchObject({ status: 'checkin', locked_at: null });
    r.step(startMinus(4));
    expect(E.getEvent(f.db, f.eventId)!.locked_at).toBe(startMinus(4).toISOString());
    expect(send.mock.calls.at(-1)![1]).toBe('event_dropped');
    r.step(startMinus(3));
    expect((f.db.prepare("SELECT COUNT(*) AS n FROM event_log WHERE action = 'entries_locked'").get() as { n: number }).n).toBe(1);
  });

  it('with check-in off, finalises at the start', () => {
    const f = entryFixture({ checkin: false });
    must(N.registerEntry(f.db, { eventId: f.eventId, teamId: f.teamA, by: A[0], roster: rosterA(), now: NOW }));
    const { r } = runner(f.db);
    r.step(startMinus(1));
    expect(E.getEvent(f.db, f.eventId)!.locked_at).toBeNull();
    r.step(startMinus(0));
    expect(E.getEvent(f.db, f.eventId)!.locked_at).not.toBeNull();
  });

  it('drops a disbanded team on any tick before the list is final', () => {
    const f = entryFixture();
    const { entry } = must(N.registerEntry(f.db, { eventId: f.eventId, teamId: f.teamB, by: B[0], roster: rosterB(), now: NOW }));
    must(T.disbandTeam(f.db, { teamId: f.teamB, by: B[0], now: NOW }));
    runner(f.db).r.step(startMinus(600));
    expect(N.getEntry(f.db, entry.id)!.drop_reason).toBe('team_disbanded');
  });

  it('keeps going when one event fails', () => {
    const f = entryFixture();
    const { r } = runner(f.db);
    const spy = vi.spyOn(E, 'openCheckin').mockImplementationOnce(() => { throw new Error('boom'); });
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(() => r.step(startMinus(60))).not.toThrow();
    expect(err).toHaveBeenCalled();
    spy.mockRestore();
    err.mockRestore();
  });
});

describe('eventMessage', () => {
  it('words each DM with the event link and escaped names', () => {
    const f = entryFixture();
    const { entry } = must(N.registerEntry(f.db, { eventId: f.eventId, teamId: f.teamA, by: A[0], roster: rosterA(), now: NOW }));
    const slug = E.getEvent(f.db, f.eventId)!.slug;
    const open = eventMessage(f.db, 'https://x', f.eventId, 'event_checkin_open', { entryId: entry.id })!;
    expect(open.content).toContain('Check-in is open for Riverside Cup');
    expect(open.components[0]![0]).toMatchObject({ kind: 'link', url: `https://x/event/${slug}` });
    expect(eventMessage(f.db, 'https://x', f.eventId, 'event_dropped', { entryId: entry.id, reason: 'no_checkin' })!.content)
      .toBe('Rats is out of Riverside Cup: it did not check in in time.');
    expect(eventMessage(f.db, 'https://x', f.eventId, 'event_roster_added', { entryId: entry.id, by: A[0], role: 'sub' })!.content)
      .toContain("put you on Rats's roster for Riverside Cup as a sub");
  });
});

describe('EventRunner.play (plan T2)', () => {
  const runner = (db: DB) => new EventRunner({ db, notifier: { notify: () => {} } as never, publicUrl: 'http://x' });
  const START_AT = new Date('2026-10-10T20:00:00.000Z');

  it('starts a final event at its start time, not before', async () => {
    const f = playFixture({ stages: [SWISS(2, 2), SE()], entries: 4 });
    const r = runner(f.db);
    await r.play(new Date(START_AT.getTime() - 60_000));
    expect(E.getEvent(f.db, f.eventId)!.status).toBe('checkin');
    await r.play(START_AT);
    expect(E.getEvent(f.db, f.eventId)!.status).toBe('live');
    expect(E.eventLog(f.db, f.eventId).at(-1)).toMatchObject({ action: 'event_started', actor: null });
  });

  it('leaves an event with fewer than 2 entries waiting, writing nothing', async () => {
    const f = playFixture({ stages: [SE()], entries: 1 });
    const logs = E.eventLog(f.db, f.eventId).length;
    await runner(f.db).play(START_AT);
    expect(E.getEvent(f.db, f.eventId)!.status).toBe('checkin');
    expect(E.eventLog(f.db, f.eventId)).toHaveLength(logs);
  });

  it('with check-in off, closes the list and starts in the same tick', async () => {
    const f = playFixture({ stages: [SE()], entries: 2 });
    f.db.prepare("UPDATE events SET status = 'registration', locked_at = NULL, checkin_json = ? WHERE id = ?")
      .run(JSON.stringify({ enabled: false, opensMinutes: 60, closesMinutes: 15 }), f.eventId);
    f.db.prepare("UPDATE event_entries SET status = 'registered'").run();
    // The entries were inserted directly, so they have no starters; give each 4 so the list keeps them.
    const add = f.db.prepare("INSERT INTO event_entry_players (entry_id, steamid, role, added_at) VALUES (?, ?, 'starter', ?)");
    let n = 900;
    for (const id of f.entries) for (let i = 0; i < 4; i++) {
      const sid = `76561199000000${n++}`;
      upsertPlayer(f.db, { steamid: sid, name: sid, avatar: null }, []);
      add.run(id, sid, START_AT.toISOString());
    }
    const r = runner(f.db);
    r.step(START_AT);
    await r.play(START_AT);
    expect(E.getEvent(f.db, f.eventId)!.status).toBe('live');
  });

  it('settles live events: a disqualification on the desk becomes a forfeit on the next tick, and a second tick changes nothing', async () => {
    const f = playFixture({ stages: [SWISS(2, null)], entries: 4 });
    const r = runner(f.db);
    await r.play(START_AT);
    N.disqualifyEntry(f.db, { entryId: f.entries[3]!, by: ADMIN, reason: 'gone', now: START_AT });
    await r.play(START_AT);
    const s = E.stagesOf(f.db, f.eventId)[0]!;
    expect(P.matchesOf(f.db, s.id).some((m) => m.status === 'forfeit')).toBe(true);
    const snap = JSON.stringify(f.db.prepare('SELECT * FROM event_log ORDER BY id').all());
    await r.play(START_AT);
    expect(JSON.stringify(f.db.prepare('SELECT * FROM event_log ORDER BY id').all())).toBe(snap);
  });
});
