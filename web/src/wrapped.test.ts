import { describe, it, expect } from 'vitest';
import {
  buildDeck, freshWrapped, groupAwards, hourLabel, leaderPairs, playerCards, rotateHours, sidesVerdict,
  standingBeat, topPct, whenYouPlay, wrappedMapName,
} from './wrapped';
import { COMMUNITY, DROPIN, FULL, FULL2, SHORT } from './wrapped.fixture';
import type { WrappedPlayer } from './api';

const COMMUNITY_CARDS = ['c_numbers', 'c_standings', 'c_leaders', 'c_moments', 'next'];

describe('Wrapped decks', () => {
  it('gives a full player every card, in the mockup order, then the community cards', () => {
    expect(buildDeck(FULL, COMMUNITY, { loggedIn: true })).toEqual([
      'intro', 'numbers', 'standing', 'streak', 'campaign', 'people', 'rivals', 'signature', 'bestMap', 'sides',
      'endorsed', 'trophies', 'when', 'started', ...COMMUNITY_CARDS,
    ]);
  });

  it('gives a short deck the cards a handful of games carry, and its own closer', () => {
    expect(playerCards(SHORT)).toEqual(['intro', 'numbers', 'standing', 'people', 'bestMap', 'sides', 'when', 'started', 'closer']);
    // A short deck never has the full-deck-only cards, even with the data.
    const loaded: WrappedPlayer = { ...SHORT, streaks: { win: 5, loss: 1 }, rivals: FULL.rivals, signature: FULL.signature };
    expect(playerCards(loaded)).not.toContain('streak');
    expect(playerCards(loaded)).not.toContain('rivals');
    expect(playerCards(loaded)).not.toContain('signature');
  });

  it('gives a drop-in one card, then everyone', () => {
    expect(buildDeck(DROPIN, COMMUNITY, { loggedIn: true })).toEqual(['dropin', ...COMMUNITY_CARDS]);
  });

  it('starts a signed-out deck with the sign-in card, and an absent player with the sat-out card', () => {
    expect(buildDeck(null, COMMUNITY, { loggedIn: false })[0]).toBe('login');
    expect(buildDeck(null, COMMUNITY, { loggedIn: true })[0]).toBe('nodeck');
    expect(buildDeck(null, COMMUNITY, { loggedIn: false, shared: true })).toEqual(COMMUNITY_CARDS);
  });

  it('skips a card whose data is empty', () => {
    const p: WrappedPlayer = {
      ...FULL,
      standing: null,
      streaks: { win: 2, loss: 4 },
      rivals: { nemesis: null, favourite: null, mostFaced: FULL.rivals.mostFaced },
      endorsements: { ...FULL.endorsements, counts: { caller: 0, clutch: 0, vibes: 0 }, givers: 0 },
      trophies: { ...FULL.trophies, weekly: [], skeetTriples: 0 },
      signature: [],
    };
    const cards = playerCards(p);
    for (const gone of ['standing', 'streak', 'rivals', 'endorsed', 'trophies', 'signature']) expect(cards).not.toContain(gone);
    expect(cards).toContain('people');
  });

  it('keeps the rivals card for a favourite opponent alone (a null nemesis is just left off it)', () => {
    const p: WrappedPlayer = { ...FULL, rivals: { ...FULL.rivals, nemesis: null } };
    expect(playerCards(p)).toContain('rivals');
  });

  it('keeps the short people card to most-played-with, and drops it without one', () => {
    expect(playerCards({ ...SHORT, people: { mostWith: null, bestDuo: FULL.people.bestDuo, teammates: 3 } })).not.toContain('people');
  });
});

describe('card rules', () => {
  it('gives the peak its own beat only when it is 100 or more above the finish', () => {
    expect(standingBeat(FULL.standing!)).toEqual({ kind: 'peak' });
    expect(standingBeat({ ...FULL.standing!, peakSr: FULL.standing!.sr + 99 }).kind).not.toBe('peak');
    // Peaked at the last game: the climb is the story, from Season 0's 833 start.
    expect(standingBeat(SHORT.standing!)).toEqual({ kind: 'climb', from: 833, to: 893 });
    expect(standingBeat(FULL2.standing!)).toEqual({ kind: 'climb', from: 833, to: 2081 });
    expect(standingBeat({ ...SHORT.standing!, sr: 700, peakSr: 720 })).toEqual({ kind: 'flat' });
  });

  it('rounds Top X% up', () => {
    expect(topPct(3, 103)).toBe(3);
    expect(topPct(19, 103)).toBe(19);
    expect(topPct(1, 103)).toBe(1);
    expect(topPct(103, 103)).toBe(100);
  });

  it('words sides as team numbers with a verdict', () => {
    expect(sidesVerdict(FULL.sides)).toEqual({ surv: 49, inf: 7, verdict: 'A survivor main.' });
    expect(sidesVerdict(FULL2.sides)).toEqual({ surv: 20, inf: -64, verdict: 'A survivor main.' });
    expect(sidesVerdict({ ...FULL.sides, survivorAvg: 285, concededAvg: 270 })!.verdict).toBe('Even on both sides.');
    expect(sidesVerdict({ ...FULL.sides, survivorAvg: null })).toBeNull();
  });

  it('names stock maps by campaign and chapter, and others by chapter title', () => {
    expect(wrappedMapName('l4d_vs_hospital02_subway')).toBe('No Mercy 2');
    expect(wrappedMapName('l4d_vs_smalltown04_mainstreet')).toBe('Death Toll 4');
    expect(wrappedMapName('l4d_vs_stadium2_underground')).toBe('Underground');
  });

  it('groups weekly awards by label, most first', () => {
    expect(groupAwards(FULL.trophies.weekly).slice(0, 2)).toEqual([
      { label: 'Tongue clears', count: 3 }, { label: 'Common kills', count: 2 },
    ]);
  });

  it('pairs each season total with its per-match leader', () => {
    const skeets = leaderPairs(COMMUNITY).find((l) => l.label === 'Skeets')!;
    expect(skeets.total.name).toBe('VII');
    expect(skeets.perMatch!.name).toBe('evanesce');
  });
});

describe('when you play', () => {
  it('rotates the UTC hour-of-week into a local zone, wrapping the week', () => {
    const h = new Array(168).fill(0);
    h[0] = 1; // Sunday 00:00 UTC
    h[167] = 2; // Saturday 23:00 UTC
    const et = rotateHours(h, -4);
    expect(et[164]).toBe(1); // Saturday 20:00 EDT
    expect(et[163]).toBe(2);
    expect(rotateHours(h, 5)[4]).toBe(2); // Sunday 04:00 at UTC+5
    expect(rotateHours(h, 0)).toEqual(h);
  });

  it('matches the spec for Bone Breaker in US Eastern: 11 pm, 56% after midnight, Sundays', () => {
    const w = whenYouPlay(rotateHours(FULL.hours, -4))!;
    expect(hourLabel(w.peakHour)).toBe('11 pm');
    expect(w.peakShare).toBe(14);
    expect(w.afterMidnight).toBe(56);
    expect(w.topDay).toBe(0);
  });

  it('labels hours', () => {
    expect([0, 1, 11, 12, 13, 23].map(hourLabel)).toEqual(['midnight', '1 am', '11 am', 'noon', '1 pm', '11 pm']);
  });

  it('reads an empty histogram as nothing to show', () => {
    expect(whenYouPlay(new Array(168).fill(0))).toBeNull();
  });
});

describe('the home strip window', () => {
  const s = { id: 1, name: 'Season 0', frozenAt: '2026-11-03 17:00:00' };
  it('points at the newest Wrapped for 30 days', () => {
    expect(freshWrapped([s], Date.parse('2026-11-20T00:00:00Z'))).toEqual(s);
    expect(freshWrapped([s], Date.parse('2026-12-04T00:00:00Z'))).toBeNull();
    expect(freshWrapped([], Date.now())).toBeNull();
  });
});
