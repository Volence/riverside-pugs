import { describe, it, expect } from 'vitest';
import * as D from '../src/events/drafts.js';
import * as E from '../src/events/events.js';
import { roomSettingsOf } from '../src/events/draftRules.js';
import { ADMIN, NOW } from './eventFixture.js';
import { cutDraft, type DraftFixture } from './draftFixture.js';

const T0 = new Date(NOW.getTime() + 3_600_000);
const must = <T>(r: { ok: true; value: T } | { ok: false; error: string }): T => {
  if (!r.ok) throw new Error(`expected ok, got ${r.error}`);
  return r.value;
};
const err = (r: { ok: boolean; error?: string }) => (r.ok ? null : r.error);
const mode = (f: DraftFixture, m: 'auto' | 'live' | null) => D.chooseTeamMode(f.db, { eventId: f.eventId, mode: m, actor: ADMIN, now: T0 });
const settings = (f: DraftFixture, s: unknown) => D.setRoomSettings(f.db, { eventId: f.eventId, settings: s, actor: ADMIN, now: T0 });
/** A room row as draftRoom.ts (Task 3) will write it; Task 2 only reads its status. */
const room = (f: DraftFixture, status: string) => f.db.prepare(
  "INSERT OR REPLACE INTO draft_rooms (event_id, status, order_json, pick_seconds, delegates_json) VALUES (?, ?, '[]', 75, '{}')",
).run(f.eventId, status);
const rows = (f: DraftFixture) => JSON.stringify([
  f.db.prepare('SELECT * FROM events ORDER BY id').all(),
  f.db.prepare('SELECT * FROM draft_signups ORDER BY id').all(),
  f.db.prepare('SELECT COUNT(*) AS n FROM event_log').get(),
]);

describe('the live method (Ruling 6)', () => {
  it('can be chosen, and left again while no room has started', () => {
    const f = cutDraft();
    must(mode(f, 'live'));
    expect(E.getEvent(f.db, f.eventId)!.team_mode).toBe('live');
    must(mode(f, 'auto'));
    must(mode(f, 'live'));
    room(f, 'ready');
    must(mode(f, null));
    expect(E.getEvent(f.db, f.eventId)!.team_mode).toBeNull();
  });

  it('cannot be left once the room has started, and the refusal writes nothing', () => {
    for (const status of ['running', 'paused', 'done']) {
      const f = cutDraft();
      must(mode(f, 'live'));
      room(f, status);
      const before = rows(f);
      expect(err(mode(f, 'auto'))).toBe('room_started');
      expect(err(mode(f, null))).toBe('room_started');
      expect(rows(f)).toBe(before);
      must(mode(f, 'live'));
    }
  });

  it('refuses staff swaps in live mode', () => {
    const f = cutDraft();
    must(mode(f, 'live'));
    const [c0, c1] = D.activeSignups(f.db, f.eventId).filter((s) => s.role === 'captain');
    const [p0, p1] = D.activeSignups(f.db, f.eventId).filter((s) => s.role === 'pool');
    f.db.prepare('UPDATE draft_signups SET draft_team = ? WHERE id = ?').run(c0!.id, p0!.id);
    f.db.prepare('UPDATE draft_signups SET draft_team = ? WHERE id = ?').run(c1!.id, p1!.id);
    expect(err(D.moveDraftPlayers(f.db, { eventId: f.eventId, a: p0!.steamid, b: p1!.steamid, actor: ADMIN, now: T0 }))).toBe('live_mode');
  });
});

describe('room settings (Ruling 5)', () => {
  it('saves both settings into draft_json and keeps the draft times', () => {
    const f = cutDraft();
    const times = E.fieldsOf(E.getEvent(f.db, f.eventId)!).draft;
    expect(must(settings(f, { firstPick: 'random', pickSeconds: 60 }))).toEqual({ firstPick: 'random', pickSeconds: 60 });
    const ev = E.getEvent(f.db, f.eventId)!;
    expect(roomSettingsOf(ev.draft_json)).toEqual({ firstPick: 'random', pickSeconds: 60 });
    expect(E.fieldsOf(ev).draft).toEqual(times);
    const log = f.db.prepare("SELECT actor, detail FROM event_log WHERE action = 'draft_room_settings'").all() as { actor: string; detail: string }[];
    expect(log.map((r) => ({ actor: r.actor, ...JSON.parse(r.detail) }))).toEqual([{ actor: ADMIN, firstPick: 'random', pickSeconds: 60 }]);
  });

  it('refuses bad values, a started room and a cut not yet published', () => {
    const f = cutDraft();
    expect(err(settings(f, { firstPick: 'random', pickSeconds: 10 }))).toBe('bad_room_settings');
    must(mode(f, 'live'));
    room(f, 'running');
    expect(err(settings(f, { firstPick: 'random', pickSeconds: 60 }))).toBe('room_started');
    const g = cutDraft({ publish: false });
    expect(err(settings(g, { firstPick: 'random', pickSeconds: 60 }))).toBe('cut_not_published');
  });
});
