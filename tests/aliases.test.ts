import { describe, it, expect, beforeEach } from 'vitest';
import { openDb, type DB } from '../src/db.js';
import { upsertPlayer, ensureRating } from '../src/players.js';
import { addAlias, aliasesOf, canonicalise, removeAlias, resolveAlias } from '../src/aliases.js';
import { mergePlayers } from '../src/mergePlayers.js';
import type { LogEvent } from '../src/logParse.js';

const MAIN = '76561198005192652';
const ALT = '76561199861598482';
const OTHER = '76561197972484944';
const TOKEN = '0123456789abcdef0123456789abcdef';

let db: DB;

beforeEach(() => {
  db = openDb(':memory:');
  for (const id of [MAIN, ALT, OTHER]) upsertPlayer(db, { steamid: id, name: `n${id.slice(-2)}`, avatar: null }, []);
  for (const id of [MAIN, ALT, OTHER]) ensureRating(db, id);
});

describe('aliases', () => {
  it('resolves an id with no alias to itself, so every caller can resolve unconditionally', () => {
    expect(resolveAlias(db, OTHER)).toBe(OTHER);
    expect(resolveAlias(db, '76561199999999999')).toBe('76561199999999999');
  });

  it('resolves an aliased id to its canonical account', () => {
    addAlias(db, { steamid: ALT, canonical: MAIN, by: 'admin' });
    expect(resolveAlias(db, ALT)).toBe(MAIN);
    expect(aliasesOf(db, MAIN).map((a) => a.steamid)).toEqual([ALT]);
  });

  it('refuses an alias that points at another alias, so resolution is one hop forever', () => {
    addAlias(db, { steamid: ALT, canonical: MAIN, by: 'admin' });
    expect(() => addAlias(db, { steamid: MAIN, canonical: OTHER, by: 'admin' })).toThrow(/alias/i);
  });

  it('refuses to alias an account to itself', () => {
    expect(() => addAlias(db, { steamid: ALT, canonical: ALT, by: 'admin' })).toThrow(/itself/i);
  });

  it('is undoable: removing the alias makes the id its own account again', () => {
    addAlias(db, { steamid: ALT, canonical: MAIN, by: 'admin' });
    removeAlias(db, ALT);
    expect(resolveAlias(db, ALT)).toBe(ALT);
  });

  // The whole point. A merge without this is a one-off clean-up that the same
  // person undoes the next time they log in on the other account.
  it('a merge leaves an alias behind, so the alt can never become a second identity again', () => {
    mergePlayers(db, { from: ALT, into: MAIN });
    expect(resolveAlias(db, ALT)).toBe(MAIN);
  });

  // Someone with three accounts, merged two at a time. The first merge's
  // alias must follow the second, or the earliest alt silently stops
  // resolving and is free to become an identity again.
  it('carries an existing alias along when its canonical account is itself merged', () => {
    const third = '76561199000000077';
    upsertPlayer(db, { steamid: third, name: 'third', avatar: null }, []);
    ensureRating(db, third);

    mergePlayers(db, { from: third, into: ALT });   // third -> ALT
    mergePlayers(db, { from: ALT, into: MAIN });    // ALT   -> MAIN

    expect(resolveAlias(db, ALT)).toBe(MAIN);
    expect(resolveAlias(db, third)).toBe(MAIN);
    expect(aliasesOf(db, MAIN).map((a) => a.steamid).sort()).toEqual([ALT, third].sort());
  });

  describe('canonicalise', () => {
    const roster = (steamid: string): LogEvent =>
      ({ kind: 'match_roster', token: TOKEN, steamid, team: 'b', name: 'mayhem', joinedMap: 0 });

    beforeEach(() => addAlias(db, { steamid: ALT, canonical: MAIN, by: 'admin' }));

    it('rewrites the steamid on a roster line, so the alt is rostered as the main', () => {
      const ev = canonicalise(db, roster(ALT)) as Extract<LogEvent, { kind: 'match_roster' }>;
      expect(ev.steamid).toBe(MAIN);
      // Everything else survives untouched.
      expect(ev.team).toBe('b');
      expect(ev.name).toBe('mayhem');
    });

    it('rewrites both ends of a live event', () => {
      const ev = canonicalise(db, {
        kind: 'live_event', token: TOKEN, seq: 1, event: 'skeet', actor: ALT, target: ALT, value: 1, half: 1, tMs: 0,
      }) as Extract<LogEvent, { kind: 'live_event' }>;
      expect(ev.actor).toBe(MAIN);
      expect(ev.target).toBe(MAIN);
    });

    it('leaves an unaliased event completely alone, object identity included', () => {
      const ev = roster(OTHER);
      expect(canonicalise(db, ev)).toBe(ev);
    });

    it('covers every event kind that carries a steamid', () => {
      const kinds: LogEvent[] = [
        { kind: 'leave', token: TOKEN, steamid: ALT, remaining: 1 },
        { kind: 'return', token: TOKEN, steamid: ALT, remaining: 1 },
        { kind: 'abandon', token: TOKEN, steamid: ALT },
        { kind: 'player', token: TOKEN, steamid: ALT, event: 'connect' },
        { kind: 'live_stat', token: TOKEN, steamid: ALT, stats: { skeets: 1 } },
        { kind: 'entered', steamid: ALT },
      ];
      for (const ev of kinds) {
        expect((canonicalise(db, ev) as { steamid: string }).steamid, ev.kind).toBe(MAIN);
      }
    });
  });
});

// A merged alt's future connects have to land on the account it became, or
// the shared-address panel would show the merge undoing itself.
describe('canonicalise covers network sightings', () => {
  it('rewrites a PUGNET steamid to the canonical account', () => {
    addAlias(db, { steamid: ALT, canonical: MAIN, by: 'admin' });
    const ev = canonicalise(db, { kind: 'player_net', steamid: ALT, ip: '203.0.113.9', country: 'US' });
    expect((ev as { steamid: string }).steamid).toBe(MAIN);
  });
});

// Evidence against an alt is evidence against the person. Left on the alt's
// id it sits on an account that no longer has an admin page.
describe('canonicalise covers anti-cheat evidence', () => {
  it('rewrites a LilAC flag to the canonical account', () => {
    addAlias(db, { steamid: ALT, canonical: MAIN, by: 'admin' });
    const ev = canonicalise(db, { kind: 'lilac_flag', steamid: ALT, cheat: 3, banned: false });
    expect(ev).toEqual({ kind: 'lilac_flag', steamid: MAIN, cheat: 3, banned: false });
  });

  it('rewrites an input burst to the canonical account', () => {
    addAlias(db, { steamid: ALT, canonical: MAIN, by: 'admin' });
    const burst: LogEvent = {
      kind: 'input_burst', steamid: ALT, burstKind: 'fire', weapon: 'pistol',
      groundTicks: 0, airPresses: 0, serverTick: 100, clientTick: 100, intervals: [3, 3, 3],
    };
    expect(canonicalise(db, burst)).toEqual({ ...burst, steamid: MAIN });
  });
});
