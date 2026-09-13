import { describe, it, expect } from 'vitest';
import { EVENT_KINDS, eventPhrase, eventSentence, groupLabel, roleOf, valueText } from './eventText';

const names: Record<string, string> = { A: 'volence', B: 'tino' };
const nameOf = (id: string) => names[id] ?? id;

describe('eventSentence', () => {
  it('reads actor, verb, target and unit plus value', () => {
    expect(eventSentence({ event: 'dp', actor: 'A', target: 'B', value: 22 }, nameOf))
      .toBe('volence pounced tino for 22');
  });

  it('reads a target with no value', () => {
    expect(eventSentence({ event: 'boom', actor: 'A', target: 'B', value: 0 }, nameOf))
      .toBe('volence boomed tino');
  });

  it('reads a kind with no target at all', () => {
    expect(eventSentence({ event: 'car_alarm', actor: 'A', target: null, value: 0 }, nameOf))
      .toBe('volence set off a car alarm');
  });

  // The plugin puts the survivor it happened to first for death and incap so
  // the live feed reads naturally; the link word goes between verb and target.
  it('links a victim-first kind to its attacker', () => {
    expect(eventSentence({ event: 'death', actor: 'B', target: 'A', value: 0 }, nameOf))
      .toBe('tino died to volence');
    expect(eventSentence({ event: 'death', actor: 'B', target: null, value: 0 }, nameOf))
      .toBe('tino died');
  });

  it('names the infected class for a spawn instead of printing the index', () => {
    expect(eventSentence({ event: 'si_spawn', actor: 'A', target: null, value: 3 }, nameOf))
      .toBe('volence spawned as hunter');
  });

  // A silently dropped event is worse than an ugly one.
  it('falls back to the raw slug for an unknown kind', () => {
    expect(eventSentence({ event: 'moonwalk', actor: 'A', target: 'B', value: 5 }, nameOf))
      .toBe('volence moonwalk tino 5');
  });

  it('resolves every id in the sentence, never only the actor', () => {
    const s = eventSentence({ event: 'pinned', actor: 'A', target: 'B', value: 0 }, nameOf);
    expect(s).not.toMatch(/\bB\b/);
    expect(s).toBe('volence pinned tino');
  });

  it('phrase is the sentence without the actor', () => {
    expect(eventPhrase({ event: 'dp', actor: 'A', target: 'B', value: 22 }, nameOf)).toBe('pounced tino for 22');
  });
});

describe('valueText', () => {
  it('is null for a zero value on an ordinary kind', () => {
    expect(valueText('boom', 0)).toBeNull();
  });
  it('is the class name for si_spawn even when the class is 0', () => {
    expect(valueText('si_spawn', 0)).toBe('class 0');
    expect(valueText('si_spawn', 5)).toBe('tank');
  });
});

describe('roleOf', () => {
  it('actor did it and target suffered it for a doer-first kind', () => {
    const e = { event: 'dp', actor: 'A', target: 'B', value: 22 };
    expect(roleOf(e, 'A')).toBe('did');
    expect(roleOf(e, 'B')).toBe('suffered');
    expect(roleOf(e, 'C')).toBeNull();
  });

  it('inverts for the victim-first kinds', () => {
    for (const kind of ['death', 'incap']) {
      const e = { event: kind, actor: 'B', target: 'A', value: 0 };
      expect(roleOf(e, 'B')).toBe('suffered');
      expect(roleOf(e, 'A')).toBe('did');
    }
  });

  it('treats an unknown kind as doer-first', () => {
    expect(roleOf({ event: 'moonwalk', actor: 'A', target: null, value: 0 }, 'A')).toBe('did');
  });
});

describe('groupLabel', () => {
  it('reads from the selected player side', () => {
    expect(groupLabel('boom', 'suffered')).toBe('Got boomed');
    expect(groupLabel('dp', 'did')).toBe('Pounces');
    expect(groupLabel('death', 'suffered')).toBe('Deaths');
    expect(groupLabel('death', 'did')).toBe('Kills');
  });
  it('falls back to the slug', () => {
    expect(groupLabel('moonwalk', 'did')).toBe('moonwalk');
  });
});

describe('EVENT_KINDS', () => {
  // Every kind the plugin emits today. Adding a kind to the plugin means
  // adding it here; this list is the reminder.
  it('covers every kind pug-match.sp and pug-stats.inc emit', () => {
    for (const k of [
      'dp', 'skeet', 'boom', 'pinned', 'cleared', 'ff', 'revive', 'death', 'incap',
      'si_spawn', 'tank_spawn', 'tank_death', 'tank_take', 'tank_give',
      'witch_aggro', 'witch_killed', 'car_alarm',
    ]) expect(EVENT_KINDS[k], k).toBeDefined();
  });
});
