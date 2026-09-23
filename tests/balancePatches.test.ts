import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDb } from '../src/db.js';
import { addServer } from '../src/serverPool.js';
import { subscribeAdminEvents } from '../src/adminFeed.js';
import { diffInventories, fingerprintOf, formatDiff, recordBalanceSighting } from '../src/balancePatches.js';

const INV = { 'c:z_tank_health': '4000', 'p:l4d_skypounce.smx': '100.aaaa0001', 'p:pug-match.smx': '200.bbbb0001' };

describe('fingerprintOf', () => {
  it('ignores key order', () => {
    const b = { 'p:pug-match.smx': '200.bbbb0001', 'p:l4d_skypounce.smx': '100.aaaa0001', 'c:z_tank_health': '4000' };
    expect(fingerprintOf(INV, [])).toBe(fingerprintOf(b, []));
    expect(fingerprintOf(INV, [])).toMatch(/^[0-9a-f]{16}$/);
  });
  it('changes on any value change', () => {
    expect(fingerprintOf({ ...INV, 'c:z_tank_health': '3750' }, [])).not.toBe(fingerprintOf(INV, []));
  });
  it('ignores the version but not the presence of a versionless plugin', () => {
    const v = ['pug-match.smx'];
    expect(fingerprintOf({ ...INV, 'p:pug-match.smx': '999.ffff0000' }, v)).toBe(fingerprintOf(INV, v));
    const { ['p:pug-match.smx']: _gone, ...without } = INV;
    expect(fingerprintOf(without, v)).not.toBe(fingerprintOf(INV, v));
  });
});

describe('diffInventories', () => {
  it('reports added, removed and changed keys', () => {
    const d = diffInventories({ a: '1', b: '2' }, { b: '3', c: '4' });
    expect(d).toEqual({ added: ['c'], removed: ['a'], changed: [{ key: 'b', from: '2', to: '3' }] });
    expect(formatDiff(d)).toBe('added c; removed a; b 2 -> 3');
  });
});

describe('recordBalanceSighting', () => {
  let db: ReturnType<typeof openDb>;
  let problems: string[];
  let unsub: () => void;
  beforeEach(() => {
    db = openDb(':memory:');
    db.prepare("INSERT INTO seasons (name) VALUES ('t')").run();
    db.prepare("INSERT INTO matches (id, season_id, state, campaign, token) VALUES (1, 1, 'live', 'x', ?)").run('b'.repeat(32));
    db.prepare("INSERT INTO match_rounds (match_id, ordinal, half, surv_team) VALUES (1, 0, 1, 'a')").run();
    addServer(db, { name: 'dallas', host: '10.0.0.1', port: 27015, rconPort: 27015, rconPassword: 'x' });
    addServer(db, { name: 'chicago', host: '10.0.0.2', port: 27015, rconPort: 27015, rconPassword: 'x' });
    problems = [];
    unsub = subscribeAdminEvents((e) => { if (e.kind === 'problem') problems.push(e.text); });
  });
  afterEach(() => unsub());

  it('creates a detected patch, tags the round and alerts once', () => {
    const r = recordBalanceSighting(db, { matchId: 1, serverId: 1, half: 1, inventory: INV, versionless: [] });
    expect(r).toMatchObject({ newPatch: true, serverChanged: true });
    const round = db.prepare('SELECT patch_id FROM match_rounds WHERE match_id = 1').get() as { patch_id: number };
    expect(round.patch_id).toBe(r.patchId);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/dallas/);

    const again = recordBalanceSighting(db, { matchId: 1, serverId: 1, half: 1, inventory: INV, versionless: [] });
    expect(again).toMatchObject({ patchId: r.patchId, newPatch: false, serverChanged: false });
    expect(problems).toHaveLength(1);
  });

  it('reports what changed and which servers now differ', () => {
    recordBalanceSighting(db, { matchId: 1, serverId: 1, half: 1, inventory: INV, versionless: [] });
    recordBalanceSighting(db, { matchId: 1, serverId: 2, half: 1, inventory: INV, versionless: [] });
    problems.length = 0;
    const changed = { ...INV, 'p:l4d_itemlimiter.smx': '50.cccc0001' };
    const r = recordBalanceSighting(db, { matchId: 1, serverId: 2, half: 1, inventory: changed, versionless: [] });
    expect(r.newPatch).toBe(true);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/chicago/);
    expect(problems[0]).toMatch(/added p:l4d_itemlimiter\.smx/);
    expect(problems[0]).toMatch(/differs from dallas/);
  });

  it('alerts with the time-ordered patch number, not the row id', () => {
    // First sighting gets row id 1 but a LATER first_seen_at than the one below.
    recordBalanceSighting(db, {
      matchId: 1, serverId: 1, half: 1, inventory: INV, versionless: [], now: '2026-06-01 00:00:00',
    });
    problems.length = 0;

    // Second sighting is a different inventory (a new patch), so it gets row
    // id 2, but its first_seen_at is EARLIER, so it ranks #1 on the admin
    // page (ROW_NUMBER OVER (ORDER BY first_seen_at, id)). The alert must
    // name it #1, not #2.
    const changed = { ...INV, 'p:l4d_itemlimiter.smx': '50.cccc0001' };
    const r = recordBalanceSighting(db, {
      matchId: 1, serverId: 2, half: 1, inventory: changed, versionless: [], now: '2020-01-01 00:00:00',
    });
    expect(r.patchId).toBe(2);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/new patch \(#1,/);
    expect(problems[0]).not.toMatch(/#2/);
  });

  it('alerts on a versionless plugin update without making a new patch', () => {
    const v = ['pug-match.smx'];
    const first = recordBalanceSighting(db, { matchId: 1, serverId: 1, half: 1, inventory: INV, versionless: v });
    problems.length = 0;
    const bumped = { ...INV, 'p:pug-match.smx': '201.bbbb0002' };
    const r = recordBalanceSighting(db, { matchId: 1, serverId: 1, half: 1, inventory: bumped, versionless: v });
    expect(r).toMatchObject({ patchId: first.patchId, newPatch: false, serverChanged: true });
    expect(problems[0]).toMatch(/pug-match\.smx/);
  });
});
