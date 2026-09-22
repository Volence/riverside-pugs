import { describe, it, expect, beforeEach } from 'vitest';
import { openDb, type DB } from '../src/db.js';
import { finishWithRetry } from '../src/server.js';
import type { RealOrchestrator, FinishOutcome } from '../src/orchestrator.js';
import { ServerReleaser } from '../src/serverRelease.js';

let db: DB;
let mid: number;
beforeEach(() => {
  db = openDb(':memory:');
  db.prepare("INSERT INTO servers (name, host, port, rcon_port, rcon_password, status) VALUES ('t','127.0.0.1',27015,27015,'x','live')").run();
  mid = Number(db.prepare(
    "INSERT INTO matches (season_id, state, campaign, server_id, token) VALUES (1, 'live', 'no_mercy', 1, '0123456789abcdef0123456789abcdef')",
  ).run().lastInsertRowid);
});

function orchestratorAnswering(outcome: FinishOutcome): { orch: RealOrchestrator; calls: { finish: number; pull: number } } {
  const calls = { finish: 0, pull: 0 };
  const orch = {
    finishMatch: async () => { calls.finish++; return outcome; },
    pullDump: async () => { calls.pull++; return ''; },
  } as unknown as RealOrchestrator;
  return { orch, calls };
}

describe('finishWithRetry', () => {
  it('retries a failed collection and gives the box up when the retries run out', async () => {
    const { orch, calls } = orchestratorAnswering('retry');
    const released: number[] = [];
    const releaser = new ServerReleaser(db, async (server) => { released.push(server.id); });
    await finishWithRetry(db, orch, mid, releaser, { delays: [1, 1], sleep: async () => {} });
    expect(calls.finish).toBe(3);
    expect((db.prepare('SELECT state FROM matches WHERE id = ?').get(mid) as any).state).toBe('aborted');
  });

  // The retries end in an abort and a release, and the release sends
  // sm_pug_abort. If a forged MATCH_END could reach that, refusing to rate the
  // match would only have turned "rate it early" into "kill it".
  it('walks away from a match the plugin says has not ended: no retry, no abort, no release', async () => {
    const { orch, calls } = orchestratorAnswering('not_ended');
    const released: number[] = [];
    const releaser = new ServerReleaser(db, async (server) => { released.push(server.id); });
    await finishWithRetry(db, orch, mid, releaser, { delays: [1, 1], sleep: async () => {} });
    expect(calls.finish).toBe(1);
    expect(calls.pull).toBe(0);
    expect(released).toEqual([]);
    expect((db.prepare('SELECT state FROM matches WHERE id = ?').get(mid) as any).state).toBe('live');
    expect((db.prepare('SELECT status FROM servers WHERE id = 1').get() as any).status).toBe('live');
  });
});
