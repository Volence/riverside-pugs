import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, type DB } from '../src/db.js';
import { seedPlayers, seedMatch } from './weeklyFixtures.js';
import { WEEK_MATCHES } from '../src/weeklyAwards.js';
import { pendingRounds } from '../src/metrics/job.js';
import { planPrune } from '../src/replayPrune.js';

let db: DB;
let ids: string[];
let dir: string;
const lines = () => ids.map((id, i) => ({ id, team: (i < 4 ? 'a' : 'b') as 'a' | 'b' }));

function roundAndReplay(matchId: number) {
  db.prepare("INSERT INTO match_rounds (match_id, ordinal, half, surv_team, score, ended_at) VALUES (?, 1, 1, 'a', 100, '2026-09-21 12:00:00')").run(matchId);
  db.prepare("INSERT INTO match_replays (match_id, ordinal, half, filename, bytes, frames, sample_hz) VALUES (?, 1, 1, ?, 10, 10, 10)").run(matchId, `r${matchId}.bin`);
  writeFileSync(join(dir, `r${matchId}.bin`), 'x'.repeat(10));
}

beforeEach(() => {
  db = openDb(':memory:');
  ids = seedPlayers(db, 8);
  dir = mkdtempSync(join(tmpdir(), 'prune-'));
});

describe('weekly and analytics filters', () => {
  it('WEEK_MATCHES returns PUGs only', () => {
    const pug = seedMatch(db, { endedAt: '2026-09-22 12:00:00', lines: lines() });
    seedMatch(db, { endedAt: '2026-09-22 13:00:00', kind: 'scrim', visibility: 'participants', lines: lines() });
    seedMatch(db, { endedAt: '2026-09-22 14:00:00', kind: 'tournament', lines: lines() });
    expect(db.prepare(WEEK_MATCHES).all('2026-09-21 12:00:00', '2026-09-28 12:00:00')).toEqual([{ id: pug }]);
  });

  it('the metrics job never queues a scrim round', () => {
    const scrim = seedMatch(db, { endedAt: '2026-09-21 12:00:00', kind: 'scrim', visibility: 'participants', lines: lines() });
    roundAndReplay(scrim);
    const keys = pendingRounds(db, { engine: 'test-engine', replayWaitMin: 0, limit: 50, now: '2026-09-22 12:00:00' });
    expect(keys.filter((k) => k.matchId === scrim)).toEqual([]);
  });

  it('an unmeasured scrim replay is still a prune candidate', () => {
    const scrim = seedMatch(db, { endedAt: '2026-09-21 12:00:00', kind: 'scrim', visibility: 'participants', lines: lines() });
    roundAndReplay(scrim);
    const pug = seedMatch(db, { endedAt: '2026-09-21 13:00:00', lines: lines() });
    roundAndReplay(pug);
    // planPrune(db, dir, now, retentionDays, freeBytes, floorBytes, opts): both rounds are
    // far past a 1-day retention, so only the metrics hold can keep one.
    const plan = planPrune(db, dir, new Date('2026-12-01T00:00:00Z'), 1, 1e12, 0);
    const matches = plan.map((c: { matchId: number }) => c.matchId);
    expect(matches).toContain(scrim);    // no metrics rule pins a scrim
    expect(matches).not.toContain(pug);  // the unmeasured PUG round is still kept
  });
});
