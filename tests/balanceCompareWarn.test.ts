import { beforeEach, describe, expect, it, vi } from 'vitest';
import { openDb } from '../src/db.js';
import { buildServer } from '../src/server.js';
import { loadConfig } from '../src/config.js';
import { authedCookie, stubOrchestrator } from './helpers.js';
import type { CompareResult } from '../src/metrics/compare/types.js';

const slow = vi.hoisted(() => {
  const result: CompareResult = {
    a: { matches: 0, rounds: 0, meanMu: null, meanGap: null, olderEngineRounds: 0, historical: false },
    b: { matches: 0, rounds: 0, meanMu: null, meanGap: null, olderEngineRounds: 0, historical: false },
    rows: [],
    counts: { real: 0, too_early: 0, noise: 0, no_data: 0 },
    banners: { skill: null, approximate: false },
    ms: 2500,
  };
  return { result, compareSides: vi.fn(() => result) };
});

vi.mock('../src/metrics/compare/compare.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/metrics/compare/compare.js')>();
  return { ...actual, compareSides: slow.compareSides };
});

const ADMIN = '76561198000000009';

describe('balance compare route slow-query warning', () => {
  let db: ReturnType<typeof openDb>;
  beforeEach(() => {
    db = openDb(':memory:');
    db.prepare("INSERT INTO seasons (name) VALUES ('t')").run();
    db.prepare("INSERT INTO balance_patches (id, name, source, first_seen_at) VALUES (1, 'Old', 'detected', '2026-09-01 00:00:00'), (2, 'New', 'detected', '2026-09-10 00:00:00')").run();
    slow.compareSides.mockClear();
  });

  it('logs once for two identical requests, not once per cache hit', async () => {
    const a = await buildServer({ config: loadConfig({}), db, orchestrator: stubOrchestrator(), serverCleaner: async () => {}, serverExec: async () => {} });
    const cookies = await authedCookie(a, db, ADMIN);
    db.prepare('UPDATE players SET is_admin = 1 WHERE steamid = ?').run(ADMIN);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const url = '/api/admin/balance/compare?a=1&b=2';
      const first = await a.inject({ method: 'GET', url, cookies });
      const second = await a.inject({ method: 'GET', url, cookies });
      expect(first.statusCode).toBe(200);
      expect(second.statusCode).toBe(200);
      // Cache hit on the second call: compareSides (and the warn check inside
      // its memo callback) runs only once, so the warning fires only once too.
      expect(slow.compareSides).toHaveBeenCalledTimes(1);
      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      warn.mockRestore();
    }
  });
});
