// tests/castDraft.test.ts
import { describe, it, expect } from 'vitest';
import type { DB } from '../src/db.js';
import * as DR from '../src/events/draftRoom.js';
import { activatePlayer, upsertPlayer } from '../src/players.js';
import { playerCard } from '../src/events/draftCards.js';
import { canCastDraft, pickableDrafts } from '../src/cast/access.js';
import { castDraftView, makeCardCache } from '../src/cast/draftView.js';
import { ADMIN } from './eventFixture.js';
import { cutDraft, type DraftFixture } from './draftFixture.js';
import { ALL, CAPTAINS, POOL, T0, at, drive, liveDraft, must, startedDraft } from './draftRoomFixture.js';

/** Drafts plan D2b2 Rulings 2, 3, 7, 8 and 9. */
const CASTER = '76561199000000791';
function caster(db: DB, id = CASTER): string {
  upsertPlayer(db, { steamid: id, name: 'caster', avatar: null }, []);
  activatePlayer(db, id);
  db.prepare('UPDATE players SET is_caster = 1 WHERE steamid = ?').run(id);
  return id;
}
const view = (f: DraftFixture, now = at(5)) => castDraftView(f.db, f.eventId, now, (s) => playerCard(f.db, s))!;
const HOUR = 3_600_000;

describe('which drafts a caster may follow', () => {
  it('offers a live draft once its cut is published, and not an auto-balance one', () => {
    const live = liveDraft();
    caster(live.db);
    expect(canCastDraft(live.db, CASTER, live.eventId, T0)).toBe(true);
    expect(pickableDrafts(live.db, CASTER, T0)).toEqual([
      { id: live.eventId, name: 'Draft Night', slug: live.slug, status: 'ready', picks: 0, totalPicks: 15 },
    ]);
    const auto = cutDraft({ balance: true });
    caster(auto.db);
    expect(canCastDraft(auto.db, CASTER, auto.eventId, T0)).toBe(false);
    expect(pickableDrafts(auto.db, CASTER, T0)).toEqual([]);
  });

  it('needs a caster in good standing with the competitive switch open to them', () => {
    const f = liveDraft();
    expect(canCastDraft(f.db, POOL[0]!, f.eventId, T0)).toBe(false);
    caster(f.db);
    f.db.prepare("UPDATE settings SET value = 'admins' WHERE key = 'competitive_enabled'").run();
    expect(canCastDraft(f.db, CASTER, f.eventId, T0)).toBe(false);
    expect(pickableDrafts(f.db, CASTER, T0)).toEqual([]);
    f.db.prepare('UPDATE players SET is_admin = 1 WHERE steamid = ?').run(CASTER);
    expect(canCastDraft(f.db, CASTER, f.eventId, T0)).toBe(true);
  });

  it('keeps a draft six hours after its teams are published, then drops it', () => {
    const f = startedDraft();
    caster(f.db);
    f.db.prepare('UPDATE events SET teams_made_at = ? WHERE id = ?').run(T0.toISOString(), f.eventId);
    expect(canCastDraft(f.db, CASTER, f.eventId, new Date(T0.getTime() + 5 * HOUR))).toBe(true);
    expect(canCastDraft(f.db, CASTER, f.eventId, new Date(T0.getTime() + 7 * HOUR))).toBe(false);
    expect(pickableDrafts(f.db, CASTER, new Date(T0.getTime() + 7 * HOUR))).toEqual([]);
  });

  it('drops a cancelled event and an unknown id', () => {
    const f = liveDraft();
    caster(f.db);
    f.db.prepare("UPDATE events SET status = 'cancelled' WHERE id = ?").run(f.eventId);
    expect(canCastDraft(f.db, CASTER, f.eventId, T0)).toBe(false);
    expect(canCastDraft(f.db, CASTER, 99_999, T0)).toBe(false);
  });

  it('lists a running room with its pick count', () => {
    const f = startedDraft();
    caster(f.db);
    drive(f, 3);
    expect(pickableDrafts(f.db, CASTER, at(10))).toEqual([expect.objectContaining({ id: f.eventId, status: 'running', picks: 3, totalPicks: 15 })]);
  });
});

describe('the draft view the overlay gets', () => {
  it('is the public room: board, clock, picks, cards for picked players and the best three by SR', () => {
    const f = startedDraft();
    drive(f, 2);
    const v = view(f);
    expect(v).toMatchObject({ eventId: f.eventId, eventName: 'Draft Night', status: 'running', rounds: 3, totalPicks: 15, pickSeconds: 75, poolLeft: 13 });
    expect(v.teams.map((t) => t.captain.steamid)).toEqual(CAPTAINS);
    expect(v.teams[0]!.slots).toEqual([1, 10, 11]);
    expect(v.teams[4]!.slots).toEqual([5, 6, 15]);
    expect(v.picks.map((p) => p.steamid)).toEqual([POOL[0], POOL[1]]);
    expect(v.teams[0]!.players.map((p) => p.steamid)).toEqual([POOL[0]]);
    expect(Object.keys(v.cards).sort()).toEqual([POOL[0]!, POOL[1]!].sort());
    expect(v.onClock).toMatchObject({ pickNo: 3, round: 1, captain: CAPTAINS[2], picker: CAPTAINS[2] });
    expect(v.deadlineAt).not.toBeNull();
    // SR is 1000 + 25 * i, so the best free players are the highest left in the pool.
    expect(v.best.map((c) => c.steamid)).toEqual([POOL[14], POOL[13], POOL[12]]);
  });

  it('carries nothing private: exact keys, no list, note or chemistry', () => {
    const f = liveDraft();
    f.db.prepare('UPDATE draft_signups SET note = ? WHERE event_id = ? AND steamid = ?').run('secret note 4410', f.eventId, POOL[0]);
    must(DR.savePickList(f.db, { eventId: f.eventId, steamid: CAPTAINS[0]!, list: [POOL[7]!, POOL[3]!], now: T0 }));
    must(DR.startRoom(f.db, { eventId: f.eventId, actor: ADMIN, now: T0, present: ALL }));
    drive(f, 1);
    const v = view(f);
    expect(Object.keys(v).sort()).toEqual([
      'best', 'cards', 'deadlineAt', 'eventId', 'eventName', 'onClock', 'pausedLeftMs', 'pickSeconds', 'picks', 'poolLeft', 'rounds', 'status', 'teams', 'totalPicks',
    ]);
    expect(Object.keys(v.cards[POOL[0]!]!).sort()).toEqual(['avatar', 'bestClass', 'form', 'infected', 'name', 'pugs', 'sr', 'steamid', 'survivor']);
    expect(Object.keys(v.teams[0]!.captain).sort()).toEqual(['avatar', 'name', 'sr', 'steamid']);
    const s = JSON.stringify(v);
    expect(s).not.toContain('secret note 4410');
    expect(s).not.toContain(JSON.stringify([POOL[7], POOL[3]]));
    for (const k of ['"note"', '"notes"', '"lists"', '"list"', '"chemistry"', '"together"', '"me"', '"delegates"', '"skills"', '"trend"']) expect(s).not.toContain(k);
  });

  it('is null for a draft that is not in live mode', () => {
    const auto = cutDraft({ balance: true });
    expect(castDraftView(auto.db, auto.eventId, T0, (s) => playerCard(auto.db, s))).toBeNull();
    const undecided = cutDraft();
    expect(castDraftView(undecided.db, undecided.eventId, T0, (s) => playerCard(undecided.db, s))).toBeNull();
  });

  it('shows a ready room with captains and no pick numbers, and a paused one with its clock frozen', () => {
    const f = liveDraft();
    const ready = view(f, T0);
    expect(ready.status).toBe('ready');
    expect(ready.teams.map((t) => t.captain.steamid)).toEqual(CAPTAINS);
    expect(ready.teams.every((t) => t.slots.length === 0 && t.players.length === 0)).toBe(true);
    expect(ready.onClock).toBeNull();
    must(DR.startRoom(f.db, { eventId: f.eventId, actor: ADMIN, now: T0, present: ALL }));
    must(DR.pauseRoom(f.db, { eventId: f.eventId, actor: ADMIN, now: at(30) }));
    const paused = view(f, at(40));
    expect(paused).toMatchObject({ status: 'paused', deadlineAt: null, pausedLeftMs: 45_000, onClock: null });
  });

  it('memoizes cards per event for a minute', () => {
    const f = liveDraft();
    const cache = makeCardCache(f.db, 60_000);
    const first = cache(f.eventId, 0)(POOL[0]!);
    expect(cache(f.eventId, 59_000)(POOL[0]!)).toBe(first);
    expect(cache(f.eventId, 61_000)(POOL[0]!)).not.toBe(first);
  });
});
