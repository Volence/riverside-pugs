import { describe, it, expect } from 'vitest';
import { openDb, type DB } from '../src/db.js';
import { currentSeasonId } from '../src/players.js';
import { PendingMatches } from '../src/pendingMatches.js';

function configuringMatch(db: DB): number {
  return Number(
    db.prepare("INSERT INTO matches (season_id, state, campaign) VALUES (?, 'configuring', 'no_mercy')")
      .run(currentSeasonId(db)).lastInsertRowid,
  );
}

describe('PendingMatches', () => {
  it('retries the oldest waiting match when a box frees', async () => {
    const db = openDb(':memory:');
    const a = configuringMatch(db);
    const b = configuringMatch(db);
    const tried: number[] = [];
    const pending = new PendingMatches(db, async (id) => { tried.push(id); });

    pending.add(a);
    pending.add(b);
    pending.drain();
    await new Promise((r) => setImmediate(r));

    expect(tried).toEqual([a]);
    expect(pending.size()).toBe(1);
  });

  it('does not retry a match that is no longer configuring', async () => {
    const db = openDb(':memory:');
    const id = configuringMatch(db);
    const tried: number[] = [];
    const pending = new PendingMatches(db, async (i) => { tried.push(i); });

    pending.add(id);
    db.prepare("UPDATE matches SET state = 'aborted' WHERE id = ?").run(id);
    pending.drain();
    await new Promise((r) => setImmediate(r));

    expect(tried).toEqual([]);
    expect(pending.size()).toBe(0);
  });

  it('never queues the same match twice', () => {
    const db = openDb(':memory:');
    const id = configuringMatch(db);
    const pending = new PendingMatches(db, async () => {});

    pending.add(id);
    pending.add(id);

    expect(pending.size()).toBe(1);
  });

  it('rebuilds from the database at boot so a restart does not strand anyone', () => {
    const db = openDb(':memory:');
    const a = configuringMatch(db);
    const b = configuringMatch(db);
    db.prepare("UPDATE matches SET state = 'live' WHERE id = ?").run(b);
    const pending = new PendingMatches(db, async () => {});

    pending.rebuildFromDb();

    expect(pending.size()).toBe(1);
  });
});
