import { describe, it, expect } from 'vitest';
import {
  autoPickChoice, cleanPickList, firstRoundOrder, parseRoomSettings, roomSettingsOf, snakeSlots,
  PICK_SECONDS_DEFAULT, LIST_MAX,
} from '../src/events/draftRules.js';

describe('room settings', () => {
  it('reads the defaults from a draft_json without them, or with junk', () => {
    expect(roomSettingsOf(null)).toEqual({ firstPick: 'lowest_sr', pickSeconds: PICK_SECONDS_DEFAULT });
    expect(roomSettingsOf(JSON.stringify({ signupsCloseAt: 'x', draftAt: 'y' }))).toEqual({ firstPick: 'lowest_sr', pickSeconds: 75 });
    expect(roomSettingsOf(JSON.stringify({ draftFirstPick: 'coin', pickSeconds: 12 }))).toEqual({ firstPick: 'lowest_sr', pickSeconds: 75 });
    expect(roomSettingsOf(JSON.stringify({ draftFirstPick: 'random', pickSeconds: 120 }))).toEqual({ firstPick: 'random', pickSeconds: 120 });
  });

  it('parses a desk body, refusing anything out of range', () => {
    expect(parseRoomSettings({ firstPick: 'highest_sr', pickSeconds: 30 })).toEqual({ firstPick: 'highest_sr', pickSeconds: 30 });
    expect(parseRoomSettings({ firstPick: 'highest_sr', pickSeconds: 300 })).toEqual({ firstPick: 'highest_sr', pickSeconds: 300 });
    for (const bad of [null, 'x', { firstPick: 'coin', pickSeconds: 75 }, { firstPick: 'random', pickSeconds: 29 },
      { firstPick: 'random', pickSeconds: 301 }, { firstPick: 'random', pickSeconds: 75.5 }, { firstPick: 'random', pickSeconds: '75' }]) {
      expect(parseRoomSettings(bad)).toBeNull();
    }
  });
});

describe('round 1 order', () => {
  const caps = [{ steamid: 'x', sr: 1500, order: 0 }, { steamid: 'y', sr: 1400, order: 1 }, { steamid: 'z', sr: 1400, order: 2 }];
  it('puts the lowest SR first by default, ties by signup order', () => {
    expect(firstRoundOrder(caps, 'lowest_sr', () => 0)).toEqual(['y', 'z', 'x']);
  });
  it('puts the highest SR first when asked, ties by signup order', () => {
    expect(firstRoundOrder(caps, 'highest_sr', () => 0)).toEqual(['x', 'y', 'z']);
  });
  it('shuffles signup order with the given random source (Fisher-Yates)', () => {
    // rand always 0 swaps each position with the first: [x,y,z] -> [z,y,x] -> [y,z,x].
    expect(firstRoundOrder(caps, 'random', () => 0)).toEqual(['y', 'z', 'x']);
    // rand(n) = n - 1 swaps each position with itself: signup order stays.
    expect(firstRoundOrder(caps, 'random', (n) => n - 1)).toEqual(['x', 'y', 'z']);
  });
});

describe('the snake', () => {
  it('goes forward in odd rounds and back in even ones, numbering every pick', () => {
    expect(snakeSlots(['a', 'b', 'c'])).toEqual([
      { pickNo: 1, round: 1, captain: 'a' }, { pickNo: 2, round: 1, captain: 'b' }, { pickNo: 3, round: 1, captain: 'c' },
      { pickNo: 4, round: 2, captain: 'c' }, { pickNo: 5, round: 2, captain: 'b' }, { pickNo: 6, round: 2, captain: 'a' },
      { pickNo: 7, round: 3, captain: 'a' }, { pickNo: 8, round: 3, captain: 'b' }, { pickNo: 9, round: 3, captain: 'c' },
    ]);
    expect(snakeSlots([])).toEqual([]);
  });
});

describe('the auto-pick choice', () => {
  const free = [{ steamid: 'p1', sr: 1100, order: 1 }, { steamid: 'p2', sr: 1300, order: 2 }, { steamid: 'p3', sr: 1300, order: 0 }];
  it('takes the first free player on the list, skipping anyone taken or unknown', () => {
    expect(autoPickChoice(free, ['gone', 'bench', 'p1', 'p2'])).toBe('p1');
  });
  it('takes the highest SR with no usable list, ties by signup order', () => {
    expect(autoPickChoice(free, [])).toBe('p3');
    expect(autoPickChoice(free, ['gone'])).toBe('p3');
  });
});

describe('cleaning a pick list', () => {
  const pool = new Set(['a', 'b', 'c']);
  it('keeps pool players in order, once each', () => {
    expect(cleanPickList(['c', 'x', 'a', 'c', 'b'], pool)).toEqual(['c', 'a', 'b']);
    expect(cleanPickList([], pool)).toEqual([]);
  });
  it('refuses anything that is not a list of strings, or too long', () => {
    expect(cleanPickList('a', pool)).toBeNull();
    expect(cleanPickList(['a', 3], pool)).toBeNull();
    expect(cleanPickList(Array.from({ length: LIST_MAX + 1 }, () => 'a'), pool)).toBeNull();
  });
});
