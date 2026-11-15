import { describe, it, expect } from 'vitest';
import * as F from '../src/events/flow.js';
import * as E from '../src/events/events.js';
import { bracketPreview } from '../src/events/bracketPreview.js';
import { stagePlayViews } from '../src/events/playViews.js';
import { ADMIN, NOW } from './eventFixture.js';
import { SE, SWISS, playFixture } from './playFixture.js';

const shape = (v: NonNullable<Awaited<ReturnType<typeof bracketPreview>>>) =>
  v.rounds.map((r) => ({ group: r.group, round: r.round, matches: r.matches.map((m) => [m.a?.id ?? null, m.b?.id ?? null]) }));

describe('projected bracket (owner 2026-11-14)', () => {
  it('5 teams: only seeds 4 and 5 play round 1, and the preview matches the bracket the start draws', async () => {
    const f = playFixture({ stages: [SE(true)], entries: 5 });
    const ev = E.getEvent(f.db, f.eventId)!;
    const preview = await bracketPreview(f.db, ev);
    expect(preview?.status).toBe('projected');
    const [, , , s4, s5] = f.entries;
    const r1 = preview!.rounds.find((r) => r.group === 1 && r.round === 1)!;
    expect(r1.matches.map((m) => [m.a?.id, m.b?.id])).toEqual([[s4, s5]]);
    expect(preview!.rounds.every((r) => r.matches.every((m) => m.id < 0 && m.desk === undefined))).toBe(true);
    // Nothing was written.
    expect(E.stagesOf(f.db, f.eventId).every((s) => s.status === 'pending')).toBe(true);
    const before = shape(preview!);
    expect((await F.startEventFlow(f.db, { eventId: f.eventId, by: ADMIN, now: NOW })).ok).toBe(true);
    expect(shape(stagePlayViews(f.db, E.getEvent(f.db, f.eventId)!)[0]!)).toEqual(before);
    // Once started, no preview.
    expect(await bracketPreview(f.db, E.getEvent(f.db, f.eventId)!)).toBeNull();
  });

  it('no preview for a table first stage', async () => {
    const f = playFixture({ stages: [SWISS(3, 4), SE(true)], entries: 8 });
    expect(await bracketPreview(f.db, E.getEvent(f.db, f.eventId)!)).toBeNull();
  });
});
