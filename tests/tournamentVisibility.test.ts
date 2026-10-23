import { describe, it, expect } from 'vitest';
import { openDb } from '../src/db.js';
import { seedPlayers, seedMatch } from './weeklyFixtures.js';
import { viewerFor, canViewMatch, visibleMatchesSql } from '../src/matchVisibility.js';

/**
 * Foundation spec: "Tournament matches are public." A tournament game is
 * stored as participants (no public live delay exists), so it opens to
 * everyone only once it is over (owner, 2026-10-23: the match page's game
 * stats must work for everyone).
 */
describe('tournament game visibility', () => {
  const setup = (state: 'live' | 'completed' | 'aborted') => {
    const db = openDb(':memory:');
    const ids = seedPlayers(db, 9);
    const lines = ids.slice(0, 8).map((id, i) => ({ id, team: (i < 4 ? 'a' : 'b') as 'a' | 'b' }));
    const id = seedMatch(db, { endedAt: '2026-10-23T08:44:00.000Z', lines, kind: 'tournament', visibility: 'participants', state });
    return { db, id, outsider: ids[8]! };
  };

  it('opens a finished tournament game to signed-out and outside viewers', () => {
    const { db, id, outsider } = setup('completed');
    expect(canViewMatch(db, viewerFor(db, null), id)).toBe(true);
    expect(canViewMatch(db, viewerFor(db, outsider), id)).toBe(true);
  });

  it('keeps a live tournament game to its participants', () => {
    const { db, id, outsider } = setup('live');
    expect(canViewMatch(db, viewerFor(db, null), id)).toBe(false);
    expect(canViewMatch(db, viewerFor(db, outsider), id)).toBe(false);
  });

  it('keeps an aborted tournament game to its participants', () => {
    const { db, id } = setup('aborted');
    expect(canViewMatch(db, viewerFor(db, null), id)).toBe(false);
  });

  it('does not add finished tournament games to the public recent-matches list', () => {
    const { db, id } = setup('completed');
    const vis = visibleMatchesSql(viewerFor(db, null), 'm');
    const rows = db.prepare(`SELECT m.id FROM matches m WHERE ${vis.sql}`).all(...vis.params) as { id: number }[];
    expect(rows.map((r) => r.id)).not.toContain(id);
  });
});
