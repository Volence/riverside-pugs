import { describe, it, expect } from 'vitest';
import {
  MAX_PIN_MS, enrichEvents, enrichmentText, fmtSeconds, fromLiveEvents, fromTimeline, type EnrichableEvent,
} from './eventEnrich';
import type { TimelineEntry } from './replay/timeline';

const ev = (
  seq: number, tMs: number, kind: string, actor: string, target: string | null, value = 0,
  over: Partial<EnrichableEvent> = {},
): EnrichableEvent => ({ seq, tMs, half: 1, mapOrdinal: 0, kind, actor, target, value, ...over });

const names: Record<string, string> = { S: 'Heart and Soul', H: 'PowerMu$tache', K: 'KoRn', Y: 'happy', I: 'intel' };
const nameOf = (id: string) => names[id] ?? id;

describe('enrichEvents: attacker class', () => {
  it('names the class the attacker spawned as, for incaps and deaths', () => {
    const en = enrichEvents([
      ev(1, 1000, 'si_spawn', 'S', null, 1),          // smoker
      ev(2, 5000, 'incap', 'K', 'S'),
      ev(3, 6000, 'death', 'K', 'S'),
    ]);
    expect(en.get(2)?.via).toBe('smoker');
    expect(en.get(3)?.via).toBe('smoker');
  });

  it('follows respawns, tank hand-offs, and forgets across a round boundary', () => {
    const en = enrichEvents([
      ev(1, 1000, 'si_spawn', 'H', null, 3),          // hunter
      ev(2, 2000, 'incap', 'K', 'H'),
      ev(3, 3000, 'tank_take', 'H', null),
      ev(4, 4000, 'incap', 'Y', 'H'),
      ev(5, 5000, 'tank_give', 'H', null),
      ev(6, 6000, 'incap', 'I', 'H'),
      ev(7, 1000, 'incap', 'K', 'H', 0, { half: 2 }),
    ]);
    expect(en.get(2)?.via).toBe('hunter');
    expect(en.get(4)?.via).toBe('tank');
    expect(en.get(6)?.via).toBeUndefined();
    expect(en.get(7)?.via).toBeUndefined();
  });

  it('says nothing when the attacker never spawned in the stream', () => {
    expect(enrichEvents([ev(1, 1000, 'incap', 'K', 'S')]).get(1)).toBeUndefined();
  });
});

describe('enrichEvents: pins', () => {
  it('tells a clear who it freed the victim from, and the pin how it ended', () => {
    const en = enrichEvents([
      ev(1, 1000, 'pinned', 'H', 'K'),
      ev(2, 5200, 'cleared', 'I', 'K'),
    ]);
    expect(en.get(2)?.from).toEqual({ pinner: 'H', afterMs: 4200 });
    expect(en.get(1)?.pin).toEqual({ durationMs: 4200, outcome: 'cleared', by: 'I' });
  });

  it('ends a pin with the victim death when nobody cleared it', () => {
    const en = enrichEvents([
      ev(1, 1000, 'pinned', 'H', 'K'),
      ev(2, 7000, 'death', 'K', 'H'),
    ]);
    expect(en.get(1)?.pin).toEqual({ durationMs: 6000, outcome: 'died', by: null });
  });

  it('leaves an open pin without an outcome and a clear without a pin bare', () => {
    const en = enrichEvents([ev(1, 1000, 'pinned', 'H', 'K'), ev(2, 2000, 'cleared', 'I', 'Y')]);
    expect(en.get(1)).toBeUndefined();
    expect(en.get(2)).toBeUndefined();
  });

  it('pairs by victim inside one round only, and accepts events newest-first', () => {
    const en = enrichEvents([
      ev(3, 500, 'cleared', 'I', 'K', 0, { half: 2 }),
      ev(2, 1500, 'pinned', 'S', 'Y'),
      ev(1, 1000, 'pinned', 'H', 'K'),
      ev(4, 2000, 'cleared', 'I', 'Y'),
    ]);
    expect(en.get(4)?.from?.pinner).toBe('S');
    expect(en.get(3)).toBeUndefined();
    expect(en.get(1)).toBeUndefined();
  });

  it('closes the pin when the victim goes down, so a later clear has nothing to pair with', () => {
    const en = enrichEvents([
      ev(1, 1000, 'pinned', 'H', 'K'),
      ev(2, 4000, 'incap', 'K', 'H'),
      ev(3, 9000, 'cleared', 'I', 'K'),
    ]);
    expect(en.get(1)?.pin).toEqual({ durationMs: 3000, outcome: 'incapped', by: null });
    expect(en.get(3)?.from).toBeUndefined();
  });

  it('forgets every pin a pinner held once they respawn; the duration is unknown', () => {
    const en = enrichEvents([
      ev(1, 1000, 'pinned', 'H', 'K'),
      ev(2, 20000, 'si_spawn', 'H', null, 3),
      ev(3, 21000, 'cleared', 'I', 'K'),
    ]);
    expect(en.get(1)?.pin).toEqual({ durationMs: null, outcome: 'ended', by: null });
    expect(en.get(3)?.from).toBeUndefined();
  });

  it('forgets a stale pin when its pinner shows up killing someone else', () => {
    const en = enrichEvents([
      ev(1, 1000, 'pinned', 'H', 'K'),
      ev(2, 5000, 'death', 'Y', 'H'),
      ev(3, 6000, 'cleared', 'I', 'K'),
    ]);
    expect(en.get(1)?.pin).toEqual({ durationMs: null, outcome: 'ended', by: null });
    expect(en.get(2)?.via).toBeUndefined();
    expect(en.get(3)?.from).toBeUndefined();
  });

  it('never pairs a clear with a pin more than MAX_PIN_MS old', () => {
    const en = enrichEvents([
      ev(1, 1000, 'pinned', 'H', 'K'),
      ev(2, 1000 + MAX_PIN_MS + 1, 'cleared', 'I', 'K'),
    ]);
    expect(en.get(2)?.from).toBeUndefined();
    expect(en.get(1)?.pin).toEqual({ durationMs: null, outcome: 'ended', by: null });
    // Exactly at the limit still pairs: the cap is on stale pins, not on a
    // long tongue drag.
    const edge = enrichEvents([
      ev(1, 1000, 'pinned', 'H', 'K'),
      ev(2, 1000 + MAX_PIN_MS, 'cleared', 'I', 'K'),
    ]);
    expect(edge.get(2)?.from).toEqual({ pinner: 'H', afterMs: MAX_PIN_MS });
  });

  it('match 18: an unrostered pin, the victim incapped, a clear 71.8 s later says nothing', () => {
    // The plugin emitted `pinned` with no target for the unrostered pinner,
    // then a real pin on K ended by incap, then a clear of K much later. The
    // feed read "cleared K from H after 71.8 seconds"; it must read nothing.
    const en = enrichEvents([
      ev(1, 500, 'pinned', 'X', null),
      ev(2, 1000, 'pinned', 'H', 'K'),
      ev(3, 6000, 'incap', 'K', 'H'),
      ev(4, 72800, 'cleared', 'I', 'K'),
    ]);
    expect(enrichmentText('cleared', en.get(4), nameOf, 'KoRn')).toBe('');
    expect(enrichmentText('pinned', en.get(2), nameOf, 'KoRn')).toBe('for 5.0 seconds, until KoRn went down');
    expect(en.get(1)).toBeUndefined();
  });
});

describe('enrichmentText', () => {
  it('reads as the owner asked: class, who from, how long and how it ended', () => {
    const en = enrichEvents([
      ev(1, 1000, 'si_spawn', 'S', null, 1),
      ev(2, 2000, 'pinned', 'H', 'K'),
      ev(3, 3000, 'pinned', 'S', 'Y'),
      ev(4, 6200, 'cleared', 'I', 'K'),
      ev(5, 7000, 'incap', 'Y', 'S'),
      ev(6, 9000, 'death', 'Y', 'S'),
    ]);
    expect(enrichmentText('incap', en.get(5), nameOf, 'happy')).toBe('(smoker)');
    expect(enrichmentText('cleared', en.get(4), nameOf, 'KoRn')).toBe('from PowerMu$tache after 4.2 seconds');
    expect(enrichmentText('pinned', en.get(2), nameOf, 'KoRn')).toBe('for 4.2 seconds, cleared by intel');
    // The pin ends at the incap, not at the death two seconds later.
    expect(enrichmentText('pinned', en.get(3), nameOf, 'happy')).toBe('for 4.0 seconds, until happy went down');
    expect(enrichmentText('boom', en.get(99), nameOf, null)).toBe('');
  });
});

describe('adapters', () => {
  it('reduces live events and timeline entries to the same shape', () => {
    const live = fromLiveEvents([{
      seq: 1, kind: 'cleared', mapOrdinal: 2, half: 1, tMs: 500,
      actor: { steamid: 'I', name: 'intel' }, target: { steamid: 'K', name: 'KoRn' }, value: 0,
    }]);
    expect(live[0]).toEqual({ seq: 1, tMs: 500, half: 1, mapOrdinal: 2, kind: 'cleared', actor: 'I', target: 'K', value: 0 });
    const tl: TimelineEntry[] = [
      { seq: 1, tMs: 500, kind: 'event', event: 'dp', actor: 'H', target: 'K', value: 20 },
      { seq: 2, tMs: 600, kind: 'chat', actor: 'K', team: 'survivor', text: 'ow' },
    ];
    expect(fromTimeline(tl)).toEqual([{ seq: 1, tMs: 500, half: 1, mapOrdinal: 0, kind: 'dp', actor: 'H', target: 'K', value: 20 }]);
  });
});

describe('fmtSeconds', () => {
  it('spells the unit out, singular at exactly one', () => {
    expect(fmtSeconds(1300)).toBe('1.3 seconds');
    expect(fmtSeconds(1000)).toBe('1.0 second');
    expect(fmtSeconds(0)).toBe('0.0 seconds');
  });
});
