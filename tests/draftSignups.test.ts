import { describe, it, expect, vi } from 'vitest';
import * as D from '../src/events/drafts.js';
import * as E from '../src/events/events.js';
import { NOTE_MAX, cleanNote } from '../src/events/draftRules.js';
import { EventRunner } from '../src/events/runner.js';
import type { Notifier } from '../src/notify/notify.js';
import { ADMIN, NOW, START, eventFixture } from './eventFixture.js';
import { P, draftFixture, givePugs } from './draftFixture.js';
import { upsertPlayer, activatePlayer } from '../src/players.js';

const must = <T>(r: { ok: true; value: T } | { ok: false; error: string }): T => {
  if (!r.ok) throw new Error(`expected ok, got ${r.error}`);
  return r.value;
};
const err = (r: { ok: boolean; error?: string }) => (r.ok ? null : r.error);
const logs = (db: ReturnType<typeof draftFixture>['db'], action: string) =>
  db.prepare('SELECT actor, detail FROM event_log WHERE action = ? ORDER BY id').all(action) as { actor: string | null; detail: string }[];
const sign = (f: ReturnType<typeof draftFixture>, steamid: string, over: Partial<{ captainPref: D.CaptainPref; note: string | null; now: Date }> = {}) =>
  D.signUp(f.db, { eventId: f.eventId, steamid, captainPref: 'willing', note: null, now: NOW, ...over });

describe('signUp', () => {
  it('stores a signup with its preference and note, and logs it without the note', () => {
    const f = draftFixture();
    const s = must(sign(f, P[0], { captainPref: 'want', note: 'prefer infected' }));
    expect(s).toMatchObject({ event_id: f.eventId, steamid: P[0], captain_pref: 'want', note: 'prefer infected', withdrawn_at: null, role: null });
    const l = logs(f.db, 'draft_signup');
    expect(l).toHaveLength(1);
    expect(l[0]!.actor).toBe(P[0]);
    expect(JSON.parse(l[0]!.detail)).toEqual({ steamid: P[0], captainPref: 'want' });
    expect(l[0]!.detail).not.toContain('prefer infected');
    expect(D.signupOf(f.db, f.eventId, P[0])).toEqual(s);
    expect(D.activeSignups(f.db, f.eventId)).toEqual([s]);
  });

  it('refuses a second signup, and allows signing up again after a withdrawal', () => {
    const f = draftFixture();
    must(sign(f, P[0]));
    expect(err(sign(f, P[0]))).toBe('already_signed_up');
    must(D.withdrawSignup(f.db, { eventId: f.eventId, steamid: P[0], now: NOW }));
    expect(D.signupOf(f.db, f.eventId, P[0])).toBeNull();
    expect(err(D.withdrawSignup(f.db, { eventId: f.eventId, steamid: P[0], now: NOW }))).toBe('not_signed_up');
    must(sign(f, P[0], { captainPref: 'no' }));
    const rows = f.db.prepare('SELECT withdrawn_at, withdraw_reason FROM draft_signups WHERE steamid = ? ORDER BY id').all(P[0]);
    expect(rows).toEqual([{ withdrawn_at: NOW.toISOString(), withdraw_reason: 'withdrawn' }, { withdrawn_at: null, withdraw_reason: null }]);
    expect(D.activeSignups(f.db, f.eventId).map((s) => s.captain_pref)).toEqual(['no']);
    expect(logs(f.db, 'draft_withdraw')).toHaveLength(1);
  });

  it('keeps signup order by time, then id', () => {
    const f = draftFixture();
    must(sign(f, P[2], { now: new Date(NOW.getTime() + 2000) }));
    must(sign(f, P[1], { now: new Date(NOW.getTime() + 1000) }));
    must(sign(f, P[0], { now: new Date(NOW.getTime() + 1000) }));
    expect(D.activeSignups(f.db, f.eventId).map((s) => s.steamid)).toEqual([P[1], P[0], P[2]]);
  });

  it('refuses a team event with not_draft', () => {
    const f = eventFixture('registration');
    upsertPlayer(f.db, { steamid: P[0], name: 'x', avatar: null }, []);
    expect(err(D.signUp(f.db, { eventId: f.eventId, steamid: P[0], captainPref: 'want', note: null, now: NOW }))).toBe('not_draft');
  });

  it('answers an unpublished draft event, or none, as not_found', () => {
    const f = draftFixture({ publish: false });
    expect(err(sign(f, P[0]))).toBe('not_found');
    expect(err(D.signUp(f.db, { eventId: f.eventId + 99, steamid: P[0], captainPref: 'want', note: null, now: NOW }))).toBe('not_found');
  });

  it('refuses before signups open (announced) as closed', () => {
    const f = draftFixture({ open: false });
    expect(err(sign(f, P[0]))).toBe('closed');
  });

  it('refuses one second after signupsCloseAt even with locked_at still NULL', () => {
    const f = draftFixture();
    const late = new Date(Date.parse(f.closeAt) + 1000);
    expect(E.getEvent(f.db, f.eventId)!.locked_at).toBeNull();
    expect(err(sign(f, P[0], { now: late }))).toBe('closed');
    expect(err(sign(f, P[0], { now: new Date(f.closeAt) }))).toBe('closed');
    must(sign(f, P[1], { now: new Date(Date.parse(f.closeAt) - 1000) }));
    expect(err(D.withdrawSignup(f.db, { eventId: f.eventId, steamid: P[1], now: late }))).toBe('closed');
  });

  it('refuses an ineligible player with the problems', () => {
    const f = draftFixture();
    const x = '76561199000000990';
    upsertPlayer(f.db, { steamid: x, name: 'new', avatar: null }, []);
    activatePlayer(f.db, x);
    f.db.prepare("UPDATE players SET discord_id = 'dx' WHERE steamid = ?").run(x);
    givePugs(f.db, x, 2);
    const r = sign(f, x);
    expect(r).toEqual({ ok: false, error: 'ineligible', detail: [{ steamid: x, problems: ['2 of 5 completed PUGs'] }] });
    expect(f.db.prepare('SELECT COUNT(*) AS n FROM draft_signups').get()).toEqual({ n: 0 });
    expect(logs(f.db, 'draft_signup')).toHaveLength(0);
  });

  it('refuses a bad note and stores a blank one as NULL', () => {
    const f = draftFixture();
    expect(err(sign(f, P[0], { note: 'x'.repeat(NOTE_MAX + 1) }))).toBe('bad_note');
    expect(err(sign(f, P[0], { note: 'retards' }))).toBe('bad_note');
    expect(err(sign(f, P[0], { note: 'line\u0007bell' }))).toBe('bad_note');
    expect(must(sign(f, P[0], { note: '   ' })).note).toBeNull();
    expect(must(sign(f, P[1], { note: `  ${'y'.repeat(NOTE_MAX)}  ` })).note).toBe('y'.repeat(NOTE_MAX));
  });
});

describe('cleanNote', () => {
  it('trims, empties to null, and refuses what is not a short plain line', () => {
    expect(cleanNote(undefined)).toBeNull();
    expect(cleanNote(null)).toBeNull();
    expect(cleanNote('  hi  ')).toBe('hi');
    expect(cleanNote('')).toBeNull();
    expect(cleanNote(5)).toBe('bad');
    expect(cleanNote('a\nb')).toBe('bad');
    expect(cleanNote('‍')).toBe('bad');
  });
});

describe('closeSignups and removeSignup', () => {
  it('closes signups once; after it nobody signs up or withdraws, and staff can still remove', () => {
    const f = draftFixture();
    must(sign(f, P[0]));
    must(sign(f, P[1]));
    must(D.closeSignups(f.db, { eventId: f.eventId, actor: ADMIN, now: NOW }));
    expect(E.getEvent(f.db, f.eventId)!.locked_at).toBe(NOW.toISOString());
    expect(JSON.parse(logs(f.db, 'draft_signups_closed')[0]!.detail)).toEqual({ by: ADMIN, signups: 2 });
    expect(err(D.closeSignups(f.db, { eventId: f.eventId, actor: ADMIN, now: NOW }))).toBe('closed');
    expect(err(sign(f, P[2]))).toBe('closed');
    expect(err(D.withdrawSignup(f.db, { eventId: f.eventId, steamid: P[0], now: NOW }))).toBe('closed');
    must(D.removeSignup(f.db, { eventId: f.eventId, steamid: P[0], reason: 'ineligible', actor: ADMIN, now: NOW }));
    expect(f.db.prepare('SELECT withdraw_reason FROM draft_signups WHERE steamid = ?').get(P[0])).toEqual({ withdraw_reason: 'ineligible' });
    expect(JSON.parse(logs(f.db, 'draft_signup_removed')[0]!.detail)).toEqual({ steamid: P[0], reason: 'ineligible' });
    expect(err(D.removeSignup(f.db, { eventId: f.eventId, steamid: P[0], reason: 'removed', actor: ADMIN, now: NOW }))).toBe('not_signed_up');
    expect(D.activeSignups(f.db, f.eventId).map((s) => s.steamid)).toEqual([P[1]]);
  });

  it('refuses a removal once the cut is published, and closing a team event', () => {
    const f = draftFixture();
    must(sign(f, P[0]));
    f.db.prepare('UPDATE events SET cut_at = ? WHERE id = ?').run(NOW.toISOString(), f.eventId);
    expect(err(D.removeSignup(f.db, { eventId: f.eventId, steamid: P[0], reason: 'removed', actor: ADMIN, now: NOW }))).toBe('cut_published');
    const t = eventFixture('registration');
    expect(err(D.closeSignups(t.db, { eventId: t.eventId, actor: null, now: NOW }))).toBe('not_draft');
  });
});

describe('the runner closes signups on the clock', () => {
  it('closes at signupsCloseAt once, and a second tick is a no-op', () => {
    const f = draftFixture();
    must(sign(f, P[0]));
    const send = vi.fn(() => 1);
    const r = new EventRunner({ db: f.db, notifier: { send } as unknown as Notifier, publicUrl: 'https://x' });
    r.step(new Date(Date.parse(f.closeAt) - 60_000));
    expect(E.getEvent(f.db, f.eventId)!.locked_at).toBeNull();
    r.step(new Date(f.closeAt));
    expect(E.getEvent(f.db, f.eventId)!.locked_at).toBe(f.closeAt);
    r.step(new Date(Date.parse(f.closeAt) + 60_000));
    const l = logs(f.db, 'draft_signups_closed');
    expect(l).toHaveLength(1);
    expect(l[0]!.actor).toBeNull();
    expect(JSON.parse(l[0]!.detail)).toEqual({ by: 'clock', signups: 1 });
    expect(E.getEvent(f.db, f.eventId)!.status).toBe('registration');
    expect(send).not.toHaveBeenCalled();
  });

  it('leaves a draft event at the start alone (startEvent refuses drafts) and still locks team events as before', () => {
    const f = draftFixture();
    const r = new EventRunner({ db: f.db, notifier: { send: vi.fn(() => 1) } as unknown as Notifier, publicUrl: 'https://x' });
    r.step(new Date(START));
    expect(logs(f.db, 'draft_signups_closed')).toHaveLength(1);
    expect(logs(f.db, 'entries_locked')).toHaveLength(0);
  });
});

describe('the events list count of a draft-kind event', () => {
  it('counts the active signups, not team entries, and a withdrawn signup drops out', async () => {
    const { eventListItems } = await import('../src/events/views.js');
    const f = draftFixture();
    must(sign(f, P[0]));
    must(sign(f, P[1]));
    must(sign(f, P[2]));
    must(D.withdrawSignup(f.db, { eventId: f.eventId, steamid: P[2], now: NOW }));
    const item = eventListItems(f.db, { staff: true }).find((e) => e.slug === f.slug)!;
    expect(item.entryKind).toBe('draft');
    expect(item.entries).toBe(2);
  });
});
