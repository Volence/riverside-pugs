import { beforeEach, describe, expect, it } from 'vitest';
import { openDb } from '../src/db.js';
import { addServer } from '../src/serverPool.js';
import { KNOBS, LIVE, sight } from './balanceFixtures.js';
import {
  activeRollout, applyKnobs, confirmOnSighting, ensureServerRows, expectedPatchFor, listRollouts, markFailed, markWritten,
} from '../src/balanceRollouts.js';
import { previewKnobs } from '../src/balanceControl.js';
import { recordBalanceSighting } from '../src/balancePatches.js';
import { subscribeAdminEvents } from '../src/adminFeed.js';

type DB = ReturnType<typeof openDb>;
let db: DB;
let s1: number;
let s2: number;
const ADMIN = '76561198000000009';
beforeEach(() => {
  db = openDb(':memory:');
  s1 = addServer(db, { name: 'dallas', host: '10.0.0.1', port: 27015, rconPort: 27015, rconPassword: 'x' });
  s2 = addServer(db, { name: 'chicago', host: '10.0.0.2', port: 27015, rconPort: 27015, rconPassword: 'x' });
  sight(db, 1, s1, LIVE);
});

const apply = (values: unknown, name: unknown = 'Tank 7500', notes: unknown = 'testing lower tank HP') =>
  applyKnobs(db, KNOBS, { values, name, notes, adminId: ADMIN, now: '2026-09-24 10:00:00' });

describe('applyKnobs', () => {
  it('reusing a pending patch makes it balance; a folded one is refused', () => {
    const preview = previewKnobs(db, KNOBS, { z_tank_health: '7500' });
    db.prepare("INSERT INTO balance_patches (fingerprint, source, inputs_json, first_seen_at, triage) VALUES (?, 'detected', '{}', '2026-09-24 03:00:00', 'pending')").run(preview.fingerprint);
    expect(apply({ z_tank_health: '7500' })).toMatchObject({ ok: true, reused: true });
    expect(db.prepare('SELECT triage FROM balance_patches WHERE fingerprint = ?').get(preview.fingerprint)).toEqual({ triage: 'balance' });
    db.prepare("UPDATE balance_patches SET triage = 'folded', folded_into = 1 WHERE fingerprint = ?").run(preview.fingerprint);
    expect(apply({ z_tank_health: '7500' })).toMatchObject({ ok: false, status: 409, error: expect.stringMatching(/folded/) });
  });

  it('creates an announced patch with the predicted inventory, then a rollout with a row per enabled server', () => {
    db.prepare('UPDATE servers SET enabled = 0 WHERE id = ?').run(s2);
    const r = apply({ z_tank_health: 7500 });
    if (!r.ok) throw new Error(r.error);
    expect(r.reused).toBe(false);
    const p = db.prepare('SELECT source, name, notes, first_seen_at, fingerprint, inputs_json FROM balance_patches WHERE id = ?').get(r.patchId) as Record<string, string>;
    expect(p).toMatchObject({ source: 'announced', name: 'Tank 7500', notes: 'testing lower tank HP', first_seen_at: '2026-09-24 10:00:00' });
    expect(p.fingerprint).toBe(r.preview.fingerprint);
    expect(JSON.parse(p.inputs_json)['c:z_tank_health']).toBe('7500');
    const ro = activeRollout(db)!;
    expect(ro.content).toContain('sm_cvar z_tank_health "7500"');
    expect(ro.content).toContain('Patch #2 Tank 7500.');
    expect(db.prepare('SELECT server_id, state FROM balance_rollout_servers').all()).toEqual([{ server_id: s1, state: 'pending' }]);
  });

  it('requires a name and notes for a new patch', () => {
    expect(apply({ z_tank_health: 7500 }, '')).toMatchObject({ ok: false, status: 400 });
    expect(apply({ z_tank_health: 7500 }, 'x'.repeat(61))).toMatchObject({ ok: false, status: 400 });
    expect(apply({ z_tank_health: 7500 }, 'ok', '')).toMatchObject({ ok: false, status: 400 });
  });

  it('refuses invalid values, no base, missing knobs and a server that differs in more than knob values', () => {
    expect(apply({ z_tank_health: 1 })).toMatchObject({ ok: false, status: 400 });
    const empty = openDb(':memory:');
    expect(applyKnobs(empty, KNOBS, { values: {}, name: 'n', notes: 'n', adminId: ADMIN })).toMatchObject({ ok: false, status: 409 });
    sight(db, 2, s2, { ...LIVE, 'p:l4d_itemlimiter.smx': '1.1' }, 'in_game');
    expect(apply({ z_tank_health: 7500 })).toMatchObject({ ok: false, status: 409, error: expect.stringMatching(/chicago/) });
  });

  it('reuses an existing patch on a no-op, keeping its source, filling an empty name only', () => {
    const r = apply({}, 'Current config', 'baseline check');
    if (!r.ok) throw new Error(r.error);
    expect(r.reused).toBe(true);
    expect(r).toMatchObject({ name: 'Current config', notesSet: true });
    expect(db.prepare('SELECT source, name, notes, reviewed FROM balance_patches WHERE id = ?').get(r.patchId))
      .toEqual({ source: 'detected', name: 'Current config', notes: 'baseline check', reviewed: 1 });
    const again = apply({}, 'Other name', 'other notes');
    if (!again.ok) throw new Error(again.error);
    expect(again).toMatchObject({ name: 'Current config', notesSet: false });
    expect(db.prepare('SELECT name, notes FROM balance_patches WHERE id = ?').get(r.patchId)).toEqual({ name: 'Current config', notes: 'baseline check' });
  });

  it('a reused named patch needs no typed name', () => {
    expect(apply({}, 'Named', 'n').ok).toBe(true);
    expect(apply({}, '', '').ok).toBe(true);
  });

  it('a new rollout supersedes the previous one', () => {
    const a = apply({ z_tank_health: 7500 });
    const b = apply({ z_tank_health: 7750 }, 'Tank 7750', 'n');
    if (!a.ok || !b.ok) throw new Error('apply failed');
    expect(activeRollout(db)!.id).toBe(b.rolloutId);
    expect(db.prepare('SELECT superseded_at FROM balance_rollouts WHERE id = ?').get(a.rolloutId)).toEqual({ superseded_at: '2026-09-24 10:00:00' });
  });
});

describe('rollout state', () => {
  it('ensureServerRows adds a pending row for a server enabled later', () => {
    db.prepare('UPDATE servers SET enabled = 0 WHERE id = ?').run(s2);
    const r = apply({ z_tank_health: 7500 });
    if (!r.ok) throw new Error(r.error);
    db.prepare('UPDATE servers SET enabled = 1 WHERE id = ?').run(s2);
    ensureServerRows(db, r.rolloutId);
    expect(db.prepare('SELECT server_id, state FROM balance_rollout_servers ORDER BY server_id').all())
      .toEqual([{ server_id: s1, state: 'pending' }, { server_id: s2, state: 'pending' }]);
  });

  it('confirms a written server on a sighting of the expected patch, records a mismatch otherwise', () => {
    const r = apply({ z_tank_health: 7500 });
    if (!r.ok) throw new Error(r.error);
    expect(expectedPatchFor(db, s1)).toBe(r.patchId);
    confirmOnSighting(db, { serverId: s1, matchId: 1, patchId: r.patchId, now: '2026-09-24 10:01:00' });
    expect(db.prepare('SELECT state FROM balance_rollout_servers WHERE server_id = ?').get(s1)).toEqual({ state: 'pending' });
    markWritten(db, r.rolloutId, s1, '2026-09-24 10:02:00');
    const other = sight(db, 3, s1, { ...LIVE, 'c:z_tank_health': '7000' }, 'queue', '2026-09-24 10:03:00');
    confirmOnSighting(db, { serverId: s1, matchId: 3, patchId: other.patchId, now: '2026-09-24 10:03:00' });
    let row = listRollouts(db, KNOBS)[0].servers.find((s) => s.serverId === s1)!;
    expect(row.state).toBe('written');
    expect(row.mismatch).toBe('c:z_tank_health 7500 -> 7000');
    confirmOnSighting(db, { serverId: s1, matchId: 3, patchId: r.patchId, now: '2026-09-24 10:04:00' });
    row = listRollouts(db, KNOBS)[0].servers.find((s) => s.serverId === s1)!;
    expect(row).toMatchObject({ state: 'confirmed', confirmedAt: '2026-09-24 10:04:00', mismatch: null });
  });

  it('markFailed reports only the first failure since the last success', () => {
    const r = apply({ z_tank_health: 7500 });
    if (!r.ok) throw new Error(r.error);
    expect(markFailed(db, r.rolloutId, s1, 'refused')).toBe(true);
    expect(markFailed(db, r.rolloutId, s1, 'refused')).toBe(false);
    expect(listRollouts(db, KNOBS)[0].servers.find((s) => s.serverId === s1)).toMatchObject({ state: 'failed', lastError: 'refused' });
  });

  it('no rollout means no expectation', () => {
    expect(expectedPatchFor(db, s1)).toBeNull();
  });
});

/** A queue (or other) match on `serverId` whose round saw `inv`, recorded the
 *  way server.ts does it: with the rollout's expectation, then the confirm. */
function sightLive(matchId: number, serverId: number, inv: Record<string, string>, origin = 'queue', at = '2026-09-24 11:00:00') {
  db.prepare("INSERT INTO matches (id, season_id, state, campaign, server_id, token, origin) VALUES (?, 1, 'live', 'x', ?, ?, ?)")
    .run(matchId, serverId, String(matchId).padStart(32, '0'), origin);
  db.prepare("INSERT INTO match_rounds (match_id, ordinal, half, surv_team, started_at) VALUES (?, 0, 1, 'a', ?)").run(matchId, at);
  const r = recordBalanceSighting(db, { matchId, serverId, half: 1, inventory: inv, versionless: KNOBS.versionless, ignored: KNOBS.ignored, now: at,
    expectedPatchId: expectedPatchFor(db, serverId) });
  confirmOnSighting(db, { serverId, matchId, patchId: r.patchId, now: at });
  return r;
}
const rowOf = (sid: number) => listRollouts(db, KNOBS)[0].servers.find((s) => s.serverId === sid)!;

describe('confirming a rollout when something else changed in the same gap', () => {
  it('a watch list that grew: confirmed, no alert, and the new config is folded into the rollout patch', () => {
    const r = apply({ z_tank_health: 7500 });
    if (!r.ok) throw new Error(r.error);
    markWritten(db, r.rolloutId, s1);
    const alerts: string[] = [];
    const off = subscribeAdminEvents((e) => { if (e.kind === 'problem') alerts.push(e.text); });
    const seen = sightLive(10, s1, { ...LIVE, 'c:z_tank_health': '7500', 'c:z_new_watch': '5' });
    off();
    expect(alerts).toEqual([]);
    expect(seen.patchId).not.toBe(r.patchId);
    expect(seen.effectivePatchId).toBe(r.patchId);
    expect(rowOf(s1)).toMatchObject({ state: 'confirmed', mismatch: null });
  });

  it('a release that changed a plugin in the same gap: the rollout is still confirmed by its knob values', () => {
    const r = apply({ z_tank_health: 7500 });
    if (!r.ok) throw new Error(r.error);
    markWritten(db, r.rolloutId, s1);
    sightLive(10, s1, { ...LIVE, 'c:z_tank_health': '7500', 'p:l4d_skypounce.smx': '3.cccc' });
    expect(rowOf(s1)).toMatchObject({ state: 'confirmed', mismatch: null });
  });

  it('a knob value that is not the rollout\'s is still a mismatch, and does not confirm', () => {
    const r = apply({ z_tank_health: 7500 });
    if (!r.ok) throw new Error(r.error);
    markWritten(db, r.rolloutId, s1);
    sightLive(10, s1, { ...LIVE, 'c:z_tank_health': '7000', 'c:z_new_watch': '5' });
    expect(rowOf(s1).state).toBe('written');
    expect(rowOf(s1).mismatch).toMatch(/z_tank_health 7500 -> 7000/);
  });

  it('only a queue match confirms or records a sighting: a casual or 2v2 config never flips a confirmed box', () => {
    const r = apply({ z_tank_health: 7500 });
    if (!r.ok) throw new Error(r.error);
    markWritten(db, r.rolloutId, s1);
    sightLive(10, s1, { ...LIVE, 'c:z_tank_health': '7500' }, 'in_game');
    expect(rowOf(s1)).toMatchObject({ state: 'written', seen: null });
    sightLive(11, s1, { ...LIVE, 'c:z_tank_health': '7500' });
    expect(rowOf(s1)).toMatchObject({ state: 'confirmed', mismatch: null });
    sightLive(12, s1, { ...LIVE, 'c:z_tank_health': '4000' }, 'in_game', '2026-09-24 12:00:00');
    expect(rowOf(s1)).toMatchObject({ state: 'confirmed', mismatch: null, seen: { at: '2026-09-24 11:00:00' } });
  });

  it('the preview warns while a release is still rolling out', () => {
    expect(previewKnobs(db, KNOBS, {}).warnings).toEqual([]);
    db.prepare(`INSERT INTO releases (id, kind, sources_json, state, created_by, created_at) VALUES (4, 'deploy', '[]', 'deploying', 'a', 'now')`).run();
    expect(previewKnobs(db, KNOBS, {}).warnings.join(' ')).toMatch(/release 4/i);
  });
});
