import { describe, it, expect } from 'vitest';
import * as N from '../src/events/entries.js';
import { profileEvents } from '../src/events/profileEvents.js';
import { ADMIN, NOW } from './eventFixture.js';
import { cutDraft } from './draftFixture.js';

/** Owner 2026-10-23: event play shows on profiles, in its own section. */
const must = <T>(r: { ok: true; value: T } | { ok: false; error: string }): T => {
  if (!r.ok) throw new Error(`expected ok, got ${r.error}`);
  return r.value;
};

function withEntries() {
  const f = cutDraft({ balance: true });
  const { entries } = must(N.createDraftEntries(f.db, { eventId: f.eventId, actor: ADMIN, now: NOW }));
  const stageId = (f.db.prepare('SELECT id FROM event_stages WHERE event_id = ? ORDER BY ordinal LIMIT 1').get(f.eventId) as { id: number }).id;
  return { ...f, entries, stageId };
}

describe('profileEvents', () => {
  it('lists the event once per entry with the team, captaincy and record', () => {
    const f = withEntries();
    const [e1, e2] = f.entries as [number, number];
    const captain = N.getEntry(f.db, e1)!.captain_steamid!;
    const mate = N.rosterOf(f.db, e1).starters.find((s) => s !== captain)!;
    f.db.prepare(
      `INSERT INTO event_matches (event_id, stage_id, grp, round, slot, entry_a, entry_b, status, best_of, winner_entry, score_a, score_b, created_at, finished_at)
       VALUES (?, ?, 1, 1, 1, ?, ?, 'done', 1, ?, 1, 0, ?, ?)`,
    ).run(f.eventId, f.stageId, e1, e2, e1, NOW.toISOString(), NOW.toISOString());

    const mine = profileEvents(f.db, captain);
    expect(mine).toHaveLength(1);
    expect(mine[0]!.entry).toMatchObject({ id: e1, captain: true });
    expect(mine[0]!).toMatchObject({ wins: 1, losses: 0 });
    expect(mine[0]!.matches[0]).toMatchObject({ result: 'win', scoreFor: 1, scoreAgainst: 0, opponent: N.getEntry(f.db, e2)!.name });

    expect(profileEvents(f.db, mate)[0]!.entry.captain).toBe(false);
    const theirs = profileEvents(f.db, N.getEntry(f.db, e2)!.captain_steamid!);
    expect(theirs[0]!).toMatchObject({ wins: 0, losses: 1 });
    expect(theirs[0]!.matches[0]).toMatchObject({ result: 'loss', scoreFor: 0, scoreAgainst: 1 });
  });

  it('shows nothing for a player on no entry, or for a cancelled event', () => {
    const f = withEntries();
    expect(profileEvents(f.db, '76561190000000999')).toEqual([]);
    const captain = N.getEntry(f.db, f.entries[0]!)!.captain_steamid!;
    f.db.prepare("UPDATE events SET status = 'cancelled' WHERE id = ?").run(f.eventId);
    expect(profileEvents(f.db, captain)).toEqual([]);
  });
});
