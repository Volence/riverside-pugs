import { describe, it, expect } from 'vitest';
import { arrivedSince } from '../src/admin/arrived.js';
import type { TimelineItem } from '../src/admin/timeline/types.js';

const item = (over: Partial<TimelineItem>): TimelineItem => ({
  at: '2026-09-22T10:00:00.000Z', source: 'input', kind: 'x', summary: '', matchId: 1, replay: null, ref: null, ...over,
});

describe('arrivedSince', () => {
  it('says what is new in one line, by source, with counts and no scores', () => {
    const text = arrivedSince([
      item({ kind: 'pistol_rate', summary: 'one-tick presses at a fixed rate no hand-spun scroll wheel holds' }),
      item({ kind: 'pounce_spam', matchId: 2 }),
      item({ source: 'lilac', kind: 'aimlock' }),
      item({ source: 'lilac', kind: 'aimlock' }),
      item({ source: 'cvar', kind: 'cpu_level', matchId: 1 }),
      item({ source: 'cvar', kind: 'cpu_level', matchId: 3 }),
      item({ source: 'steam', kind: 'recent_ban' }),
      item({ source: 'drop', kind: 'repeat' }),
    ], null);
    expect(text).toBe(
      '2 input flags (pistol_rate, pounce_spam), steady taps · Little Anti-Cheat: aimlock ×2 · '
      + 'client setting cpu_level 0 (2 matches) · Steam: recent VAC or game ban · repeated connect drops',
    );
  });

  it('counts only what arrived after the last look, and leaves out what is not evidence', () => {
    const text = arrivedSince([
      item({ at: '2026-09-20T00:00:00.000Z', kind: 'old_one' }),
      item({ kind: 'pounce_spam' }),
      item({ kind: 'pistol_rate', allowed: true }),
      item({ source: 'note', kind: 'note' }),
      item({ source: 'drop', kind: 'drop' }),
    ], '2026-09-21T00:00:00.000Z');
    expect(text).toBe('1 input flag (pounce_spam)');
  });
});
