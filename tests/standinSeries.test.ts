import { describe, it, expect, afterEach, vi } from 'vitest';
import * as N from '../src/events/entries.js';
import * as R from '../src/events/room.js';
import * as ST from '../src/events/standins.js';
import { presetConfig } from '../src/events/vetoConfig.js';
import { A, OUTSIDER } from './entryFixture.js';
import { POOL7 } from './roomFixture.js';
import { driveLoserPicks, seriesFixture, type SeriesFixture } from './seriesFixture.js';
import { asDraft, benchOn, offeredFor } from './standinFixture.js';

/** Plan D3a Task 4: a match stand-in accepted while game 1 is on the box. */
describe('a stand-in during a booked series', () => {
  let s: SeriesFixture;
  afterEach(() => { vi.restoreAllMocks(); s?.close(); });
  const setup = async () => {
    s = await seriesFixture({ pool: POOL7, veto: presetConfig('loser_picks', 7), drive: (f) => { asDraft(f); driveLoserPicks(f); } });
    benchOn(s.db, s.eventId, OUTSIDER);
    await s.tick();
    s.goLive(s.gameOf(1).match_id!);
    return offeredFor(s, s.entryA, A[3]!, 'match', new Date(s.t.t));
  };
  const accept = (o: { requestId: number; offerId: number }) =>
    s.series.standinPlace({ eventId: s.eventId, requestId: o.requestId, offerId: o.offerId, steamid: OUTSIDER, acceptedAt: new Date(s.t.t) });
  const rows = () => JSON.stringify([
    s.db.prepare('SELECT * FROM event_entry_players ORDER BY id').all(),
    s.db.prepare('SELECT * FROM event_lineups ORDER BY id').all(),
    s.db.prepare('SELECT * FROM match_players ORDER BY rowid').all(),
    s.db.prepare('SELECT * FROM draft_standins ORDER BY id').all(),
    s.db.prepare('SELECT * FROM draft_standin_offers ORDER BY id').all(),
  ]);

  it('between chapters: the box takes the sub first, then the lineup, the game roster and the request follow, and no sub is used', async () => {
    const o = await setup();
    const token = s.liveGameToken();
    s.sent.length = 0;
    const r = await accept(o);
    expect(r.ok && r.value).toMatchObject({ subbedInMatch: s.matchId, scope: 'match', out: A[3], in: OUTSIDER });
    expect(s.sent).toContain(`sm_pug_sub ${token} ${A[3]} ${OUTSIDER}`);
    expect(R.lineupFour(s.db, s.matchId, s.entryA)).toEqual([A[0], A[1], A[2], OUTSIDER]);
    expect(R.subsUsed(s.db, s.match(), 'a')).toBe(0);
    expect(N.rosterOf(s.db, s.entryA)).toMatchObject({ starters: A.slice(0, 4), subs: [OUTSIDER] });
    expect(ST.requestOf(s.db, o.requestId)?.status).toBe('filled');
    expect(s.db.prepare('SELECT COUNT(*) AS n FROM match_players WHERE player_id = ?').get(OUTSIDER)).toEqual({ n: 1 });
    expect(s.pushes).toContain(s.matchId);
  });

  it('Review Focus 3: mid-chapter the box refuses, nothing is written, and the offer stays open for another press', async () => {
    const o = await setup();
    s.box.subOk = false;
    s.box.subErr = 'not between chapters';
    const before = rows();
    const r = await accept(o);
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error).toBe('replace_in_game');
    expect(!r.ok && r.detail).toEqual([{ steamid: A[3], problems: ['The server said: not between chapters.'] }]);
    expect(rows()).toBe(before);
    expect(ST.offerOf(s.db, o.offerId)?.answer).toBeNull();
    // Between chapters the same press goes through.
    s.box.subOk = true;
    expect((await accept(o)).ok).toBe(true);
  });

  it('a stand-in whose offer is gone is refused before the box is asked', async () => {
    const o = await setup();
    s.sent.length = 0;
    const r = await s.series.standinPlace({ eventId: s.eventId, requestId: o.requestId, offerId: o.offerId + 999, steamid: OUTSIDER, acceptedAt: new Date(s.t.t) });
    expect(!r.ok && r.error).toBe('standin_offer_gone');
    expect(s.sent.some((c) => c.startsWith('sm_pug_sub '))).toBe(false);
  });
});
