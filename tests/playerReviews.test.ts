import { describe, it, expect, beforeEach } from 'vitest';
import { openDb, type DB } from '../src/db.js';
import { upsertPlayer, activatePlayer } from '../src/players.js';
import { addAlias } from '../src/aliases.js';
import { mergePlayers, MERGE_HANDLED_PLAYER_COLUMNS } from '../src/mergePlayers.js';
import { lastReviewOf, markLookedAt, reviewsOf } from '../src/admin/reviews.js';
import { playerTimeline } from '../src/admin/playerTimeline.js';

const MAIN = '76561199000000001';
const ALT = '76561199000000002';
const STAFF = '76561199000000009';
let db: DB;

beforeEach(() => {
  db = openDb(':memory:');
  for (const id of [MAIN, ALT, STAFF]) {
    upsertPlayer(db, { steamid: id, name: `p${id.slice(-3)}`, avatar: null }, []);
    activatePlayer(db, id);
  }
  db.prepare('UPDATE players SET is_admin = 1 WHERE steamid = ?').run(STAFF);
});

describe('reviews', () => {
  it('records who looked, when, and with what note', () => {
    const r = markLookedAt(db, MAIN, STAFF, 'watched the clip, nothing there', new Date('2026-09-21T10:00:00.000Z'));
    expect(r).toMatchObject({ steamid: MAIN, reviewedBy: STAFF, reviewedAt: '2026-09-21T10:00:00.000Z' });
    expect(r.reviewedByName).toBe('p009');
    expect(lastReviewOf(db, MAIN)).toMatchObject({ id: r.id, note: 'watched the clip, nothing there' });
    expect(lastReviewOf(db, ALT)).toBeNull();
  });

  it('keeps only the newest as the last review, and follows a merged account', () => {
    markLookedAt(db, MAIN, STAFF, 'first', new Date('2026-09-20T10:00:00.000Z'));
    markLookedAt(db, MAIN, STAFF, 'second', new Date('2026-09-21T10:00:00.000Z'));
    expect(lastReviewOf(db, MAIN)!.note).toBe('second');
    addAlias(db, { steamid: ALT, canonical: MAIN, by: 'test' });
    expect(lastReviewOf(db, ALT)!.note).toBe('second');
    expect(reviewsOf(db, [MAIN])).toHaveLength(2);
  });

  it('shows on the timeline as a note of its own kind', () => {
    markLookedAt(db, MAIN, STAFF, 'nothing to see', new Date('2026-09-21T10:00:00.000Z'));
    const [item] = playerTimeline(db, MAIN, STAFF);
    expect(item.source).toBe('note');
    expect(item.kind).toBe('review');
    expect(item.summary).toContain('looked at this file');
    expect(item.summary).toContain('nothing to see');
  });

  it('a merge carries reviews onto the surviving account', () => {
    markLookedAt(db, ALT, STAFF, 'on the alt');
    mergePlayers(db, { from: ALT, into: MAIN, by: STAFF });
    expect(lastReviewOf(db, MAIN)!.note).toBe('on the alt');
    expect(MERGE_HANDLED_PLAYER_COLUMNS).toContainEqual(['player_reviews', 'steamid']);
    expect(MERGE_HANDLED_PLAYER_COLUMNS).toContainEqual(['player_reviews', 'reviewed_by']);
  });
});
