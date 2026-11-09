import { describe, it, expect } from 'vitest';
import * as D from '../src/events/drafts.js';
import * as E from '../src/events/events.js';
import { eventMessage } from '../src/events/messages.js';
import { ADMIN, NOW } from './eventFixture.js';
import { P, draftFixture, type DraftFixture } from './draftFixture.js';

/**
 * Owner 2026-11-09: a draft's signups check in before the draft, and
 * whoever has not when check-in closes is taken off before the cut. The
 * window is the event's check-in setting measured from the draft.
 */

const must = <T>(r: { ok: true; value: T } | { ok: false; error: string }): T => {
  if (!r.ok) throw new Error(`expected ok, got ${r.error}`);
  return r.value;
};
const err = (r: { ok: boolean; error?: string }): string => (r.ok ? 'ok' : r.error!);
// draftFixture: signups close 18:00Z, draft 19:00Z on 2026-10-10. A day-long
// check-in closing at the signup close, as Draft Tourney #2 runs it.
const OPENS = new Date('2026-10-09T19:00:00.000Z');
const IN = new Date('2026-10-10T12:00:00.000Z');
const CLOSES = new Date('2026-10-10T18:00:00.000Z');
const set = (f: DraftFixture, checkin: { enabled: boolean; opensMinutes: number; closesMinutes: number }) =>
  must(E.updateEvent(f.db, { eventId: f.eventId, by: ADMIN, fields: { checkin }, now: NOW }));
const fixture = () => {
  const f = draftFixture();
  set(f, { enabled: true, opensMinutes: 1440, closesMinutes: 60 });
  return f;
};
const signUp = (f: DraftFixture, s: string, now: Date) => must(D.signUp(f.db, { eventId: f.eventId, steamid: s, captainPref: 'willing', note: null, now }));
const active = (f: DraftFixture) => D.activeSignups(f.db, f.eventId).map((s) => s.steamid);

describe('draft check-in', () => {
  it('the window is measured from the draft', () => {
    const f = fixture();
    expect(D.draftCheckin(E.getEvent(f.db, f.eventId)!)).toEqual({ opensAt: OPENS.toISOString(), closesAt: CLOSES.toISOString() });
    set(f, { enabled: false, opensMinutes: 1440, closesMinutes: 60 });
    expect(D.draftCheckin(E.getEvent(f.db, f.eventId)!)).toBeNull();
  });

  it('a signup checks in only while the window is open, once', () => {
    const f = fixture();
    signUp(f, P[0]!, NOW);
    expect(err(D.checkInSignup(f.db, { eventId: f.eventId, steamid: P[0]!, now: NOW }))).toBe('checkin_not_open');
    expect(err(D.checkInSignup(f.db, { eventId: f.eventId, steamid: P[1]!, now: IN }))).toBe('not_signed_up');
    must(D.checkInSignup(f.db, { eventId: f.eventId, steamid: P[0]!, now: IN }));
    expect(err(D.checkInSignup(f.db, { eventId: f.eventId, steamid: P[0]!, now: IN }))).toBe('already_checked_in');
    expect(err(D.checkInSignup(f.db, { eventId: f.eventId, steamid: P[0]!, now: CLOSES }))).toBe('checkin_not_open');
  });

  it('signing up while the window is open checks in too', () => {
    const f = fixture();
    signUp(f, P[0]!, IN);
    expect(D.signupOf(f.db, f.eventId, P[0]!)?.checked_in_at).toBe(IN.toISOString());
  });

  it('opening is marked once, inside the window', () => {
    const f = fixture();
    expect(err(D.openDraftCheckin(f.db, { eventId: f.eventId, now: NOW }))).toBe('checkin_not_due');
    must(D.openDraftCheckin(f.db, { eventId: f.eventId, now: IN }));
    expect(err(D.openDraftCheckin(f.db, { eventId: f.eventId, now: IN }))).toBe('checkin_not_due');
  });

  it('closing takes off everyone not checked in, once, and keeps the rest', () => {
    const f = fixture();
    for (const s of P.slice(0, 10)) signUp(f, s, NOW);
    for (const s of P.slice(0, 8)) must(D.checkInSignup(f.db, { eventId: f.eventId, steamid: s, now: IN }));
    expect(err(D.closeDraftCheckin(f.db, { eventId: f.eventId, now: IN }))).toBe('checkin_not_due');
    expect(must(D.closeDraftCheckin(f.db, { eventId: f.eventId, now: CLOSES })).removed).toEqual([P[8], P[9]]);
    expect(active(f)).toEqual(P.slice(0, 8));
    expect(err(D.closeDraftCheckin(f.db, { eventId: f.eventId, now: CLOSES }))).toBe('checkin_not_due');
  });

  it('after the signup close a removed pool player is replaced from the bench', () => {
    const f = fixture();
    // Check-in closing after the signups close: 30 minutes before the draft.
    set(f, { enabled: true, opensMinutes: 1440, closesMinutes: 30 });
    for (const s of P.slice(0, 12)) signUp(f, s, NOW);
    for (const s of P.slice(0, 12)) if (s !== P[0]) must(D.checkInSignup(f.db, { eventId: f.eventId, steamid: s, now: IN }));
    must(D.closeSignups(f.db, { eventId: f.eventId, actor: ADMIN, now: CLOSES }));
    const before = D.activeSignups(f.db, f.eventId);
    expect(before.find((s) => s.steamid === P[0])?.role).toBe('pool');
    const bench = before.filter((s) => s.role === 'bench').map((s) => s.steamid);
    must(D.closeDraftCheckin(f.db, { eventId: f.eventId, now: new Date('2026-10-10T18:30:00.000Z') }));
    expect(D.signupOf(f.db, f.eventId, bench[0]!)?.role).toBe('pool');
  });

  it('a late signup by staff counts as checked in', () => {
    const f = fixture();
    for (const s of P.slice(0, 8)) signUp(f, s, NOW);
    must(D.closeSignups(f.db, { eventId: f.eventId, actor: ADMIN, now: CLOSES }));
    must(D.addLateSignup(f.db, { eventId: f.eventId, steamid: P[12]!, captainPref: 'no', actor: ADMIN, now: CLOSES }));
    expect(D.signupOf(f.db, f.eventId, P[12]!)?.checked_in_at).not.toBeNull();
  });

  it('the DM says when check-in closes and links the event; the removal DM names check-in', () => {
    const f = fixture();
    const open = eventMessage(f.db, 'https://x', f.eventId, 'draft_checkin_open', {})!;
    expect(open.content).toContain(`<t:${Math.floor(CLOSES.getTime() / 1000)}:F>`);
    expect(open.components[0]![0]).toMatchObject({ kind: 'link', label: 'Check in' });
    expect(eventMessage(f.db, 'https://x', f.eventId, 'draft_signup_removed', { removal: 'no_checkin' })!.content).toContain('did not check in');
  });
});
