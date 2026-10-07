import { describe, it, expect } from 'vitest';
import * as E from '../src/events/events.js';
import * as N from '../src/events/entries.js';
import { eventView } from '../src/events/views.js';
import { ADMIN, NOW, eventFixture } from './eventFixture.js';
import { P, cutDraft } from './draftFixture.js';

const must = <T>(r: { ok: true; value: T } | { ok: false; error: string }): T => {
  if (!r.ok) throw new Error(`expected ok, got ${r.error}`);
  return r.value;
};
const BENCH = P[15]!;

function madeDraft() {
  const f = cutDraft({ balance: true });
  must(N.createDraftEntries(f.db, { eventId: f.eventId, actor: ADMIN, now: new Date(NOW.getTime() + 3_600_000) }));
  return f;
}
const viewOf = (f: ReturnType<typeof madeDraft>) => eventView(f.db, E.getEvent(f.db, f.eventId)!);

describe('players on public draft teams (plan D2c)', () => {
  it('lists the four starters of each draft entry, captain first, by display name', () => {
    const f = madeDraft();
    const v = viewOf(f);
    expect(v.entries).toHaveLength(5);
    for (const e of v.entries) {
      const row = N.entriesOf(f.db, f.eventId).find((r) => r.id === e.id)!;
      const want = N.rosterOf(f.db, e.id).starters.map((s) => `d${P.indexOf(s)}`);
      expect(e.players).toHaveLength(4);
      expect(e.players).toEqual(want);
      expect(e.players![0]).toBe(`d${P.indexOf(row.captain_steamid!)}`);
    }
  });

  it('leaves out a removed starter and never carries SR', () => {
    const f = madeDraft();
    const e = N.entriesOf(f.db, f.eventId)[0]!;
    const out = N.rosterOf(f.db, e.id).starters[3]!;
    f.db.prepare('UPDATE event_entry_players SET removed_at = ? WHERE entry_id = ? AND steamid = ?').run(NOW.toISOString(), e.id, out);
    const v = viewOf(f);
    expect(v.entries.find((x) => x.id === e.id)!.players).toHaveLength(3);
    expect(JSON.stringify(v)).not.toMatch(/"sr"|mu"|sigma/i);
  });

  it('gives team-event entries no players', () => {
    const f = eventFixture('registration');
    const v = eventView(f.db, E.getEvent(f.db, f.eventId)!);
    for (const e of v.entries) expect(e).not.toHaveProperty('players');
    expect(JSON.stringify(v)).not.toContain('"players"');
  });

  it('drops a placed player from the bench list, and keeps one who is still unplaced', () => {
    const f = madeDraft();
    expect(viewOf(f).draft!.cut!.bench).toEqual(['d15']);
    // Simulate a replace: the bench player takes a starter's place.
    const e = N.entriesOf(f.db, f.eventId)[0]!;
    const out = N.rosterOf(f.db, e.id).starters[3]!;
    f.db.prepare('UPDATE event_entry_players SET removed_at = ? WHERE entry_id = ? AND steamid = ?').run(NOW.toISOString(), e.id, out);
    f.db.prepare("INSERT INTO event_entry_players (entry_id, steamid, role, added_at) VALUES (?, ?, 'starter', ?)").run(e.id, BENCH, NOW.toISOString());
    const v = viewOf(f);
    expect(v.draft!.cut!.bench).toEqual([]);
    expect(v.entries.find((x) => x.id === e.id)!.players).toContain('d15');
  });
});
