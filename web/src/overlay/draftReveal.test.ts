import { describe, it, expect } from 'vitest';
import { DRAFT_REVEAL_MS, REVEAL_STALE_MS, emptyReveal, revealKey, stepReveal } from './draftReveal';
import type { CastDraftPick, CastDraftView } from '../../../src/cast/types';

/** Drafts plan D2b2 Ruling 5; Review Focus 3, 4 and 5. */
const T = Date.parse('2026-10-08T20:00:00.000Z');
const pick = (pickNo: number, steamid: string, atMs: number): CastDraftPick => ({
  pickNo, round: 1, captain: 'c1', steamid, name: `n${steamid}`, auto: false, at: new Date(atMs).toISOString(),
});
const draft = (picks: CastDraftPick[], eventId = 4): CastDraftView => ({
  eventId, eventName: 'Draft Night', status: 'running', deadlineAt: null, pausedLeftMs: null, pickSeconds: 75, totalPicks: 15, rounds: 3,
  onClock: null, teams: [], picks, cards: {}, best: [], poolLeft: 15 - picks.length,
});

describe('pick reveal queue', () => {
  it('treats what is there on the first feed as history (an overlay loading mid-draft)', () => {
    const q = stepReveal(emptyReveal(), draft([pick(1, 'a', T - 1000), pick(2, 'b', T - 500)]), T);
    expect(q.showing).toBeNull();
    expect(q.pending).toEqual([]);
  });

  it('reveals a new pick for DRAFT_REVEAL_MS, then clears', () => {
    let q = stepReveal(emptyReveal(), draft([]), T);
    const p = pick(1, 'a', T + 500);
    q = stepReveal(q, draft([p]), T + 1000);
    expect(q.showing?.key).toBe(revealKey(p));
    q = stepReveal(q, draft([p]), T + 1000 + DRAFT_REVEAL_MS - 1);
    expect(q.showing?.key).toBe(revealKey(p));
    q = stepReveal(q, draft([p]), T + 1000 + DRAFT_REVEAL_MS);
    expect(q.showing).toBeNull();
  });

  it('shows two picks that land in one feed one after the other (the forced final pick)', () => {
    let q = stepReveal(emptyReveal(), draft([]), T);
    const a = pick(14, 'a', T + 200);
    const b = pick(15, 'b', T + 200);
    q = stepReveal(q, draft([a, b]), T + 1000);
    expect(q.showing?.pick.steamid).toBe('a');
    q = stepReveal(q, draft([a, b]), T + 1000 + DRAFT_REVEAL_MS);
    expect(q.showing?.pick.steamid).toBe('b');
    q = stepReveal(q, draft([a, b]), T + 1000 + 2 * DRAFT_REVEAL_MS);
    expect(q.showing).toBeNull();
  });

  it('drops a revealed pick that staff undo, and reveals the slot again when it is re-picked', () => {
    let q = stepReveal(emptyReveal(), draft([]), T);
    const a = pick(3, 'a', T + 100);
    q = stepReveal(q, draft([a]), T + 1000);
    expect(q.showing?.pick.steamid).toBe('a');
    q = stepReveal(q, draft([]), T + 2000);
    expect(q.showing).toBeNull();
    const again = pick(3, 'z', T + 9000);
    q = stepReveal(q, draft([again]), T + 9500);
    expect(q.showing?.pick.steamid).toBe('z');
  });

  it('drops a queued pick that is undone before its turn', () => {
    let q = stepReveal(emptyReveal(), draft([]), T);
    const a = pick(5, 'a', T + 100);
    const b = pick(6, 'b', T + 200);
    q = stepReveal(q, draft([a, b]), T + 1000);
    q = stepReveal(q, draft([a]), T + 2000);
    expect(q.pending).toEqual([]);
  });

  it('never replays a backlog older than REVEAL_STALE_MS (an overlay OBS throttled)', () => {
    let q = stepReveal(emptyReveal(), draft([]), T);
    const fresh = pick(3, 'c', T + REVEAL_STALE_MS + 5000);
    q = stepReveal(q, draft([pick(1, 'a', T + 100), pick(2, 'b', T + 200), fresh]), T + REVEAL_STALE_MS + 6000);
    expect(q.showing?.pick.steamid).toBe('c');
    expect(q.pending).toEqual([]);
  });

  it('starts over on another draft, its picks history', () => {
    let q = stepReveal(emptyReveal(), draft([]), T);
    q = stepReveal(q, draft([pick(1, 'a', T + 100)], 9), T + 1000);
    expect(q.showing).toBeNull();
  });

  it('shows nothing with no draft on air', () => {
    let q = stepReveal(emptyReveal(), draft([]), T);
    q = stepReveal(q, draft([pick(1, 'a', T + 100)]), T + 1000);
    expect(q.showing).not.toBeNull();
    expect(stepReveal(q, null, T + 1500).showing).toBeNull();
  });
});
