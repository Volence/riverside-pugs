import { describe, it, expect, beforeEach } from 'vitest';
import { openDb, type DB } from '../src/db.js';
import {
  getMapsToPlay, setMapsToPlay, clearMapsToPlay, allMapsToPlay,
} from '../src/campaignRules.js';

let db: DB;
beforeEach(() => { db = openDb(':memory:'); });

describe('campaign play rules', () => {
  // Absent is the default, and the default is today's behaviour. This is the
  // one that protects every match the site already runs.
  it('has no rule for a campaign nobody configured', () => {
    expect(getMapsToPlay(db, 'dead_air')).toBeNull();
  });

  it('stores and reads a rule', () => {
    setMapsToPlay(db, 'dead_air', 3);
    expect(getMapsToPlay(db, 'dead_air')).toBe(3);
  });

  // The admin panel writes this on every change, not only the first.
  it('overwrites an existing rule', () => {
    setMapsToPlay(db, 'dead_air', 3);
    setMapsToPlay(db, 'dead_air', 5);
    expect(getMapsToPlay(db, 'dead_air')).toBe(5);
  });

  // Clearing returns the campaign to the default rather than storing a zero,
  // which would mean "play no maps" and is not a thing.
  it('clears a rule back to absent', () => {
    setMapsToPlay(db, 'dead_air', 3);
    clearMapsToPlay(db, 'dead_air');
    expect(getMapsToPlay(db, 'dead_air')).toBeNull();
  });

  it('reads every rule at once', () => {
    setMapsToPlay(db, 'dead_air', 3);
    setMapsToPlay(db, 'no_mercy', 5);
    expect(allMapsToPlay(db)).toEqual(new Map([['dead_air', 3], ['no_mercy', 5]]));
  });

  // Stock and custom campaigns share this table on purpose: a stock finale is
  // excluded for the same reason a custom one is, and a second mechanism for
  // stock is how the two-switch confusion started.
  it('holds stock and custom slugs alike', () => {
    setMapsToPlay(db, 'no_mercy', 4);
    setMapsToPlay(db, 'city17_v2_8', 5);
    expect(getMapsToPlay(db, 'city17_v2_8')).toBe(5);
    expect(getMapsToPlay(db, 'no_mercy')).toBe(4);
  });
});
