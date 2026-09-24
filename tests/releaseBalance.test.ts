import { beforeEach, describe, expect, it } from 'vitest';
import { openDb } from '../src/db.js';
import { addServer } from '../src/serverPool.js';
import { linkReleaseSighting } from '../src/releaseBalance.js';

type DB = ReturnType<typeof openDb>;
describe('linkReleaseSighting', () => {
  let db: DB, s1: number, rel: number, prev: number, next: number;
  const release = (decision: string, name: string | null = null) => {
    rel = Number(db.prepare(`INSERT INTO releases (kind, sources_json, state, created_by, created_at, balance_decision, balance_name, balance_notes)
      VALUES ('deploy', '[]', 'done', '1', 'x', ?, ?, 'why')`).run(decision, name).lastInsertRowid);
    db.prepare("INSERT INTO release_boxes (release_id, server_id, state, plan_json, shipped_json, updated_at) VALUES (?, ?, 'restarted', '[]', '{}', 'x')").run(rel, s1);
  };
  beforeEach(() => {
    db = openDb(':memory:');
    s1 = addServer(db, { name: 'dallas', host: '10.0.0.1', port: 27015, rconPort: 27015, rconPassword: 'x' });
    prev = Number(db.prepare("INSERT INTO balance_patches (fingerprint, source, inputs_json, first_seen_at, triage, name) VALUES ('p', 'detected', '{}', 'a', 'balance', 'Base')").run().lastInsertRowid);
    next = Number(db.prepare("INSERT INTO balance_patches (fingerprint, source, inputs_json, first_seen_at, triage) VALUES ('n', 'detected', '{}', 'b', 'pending')").run().lastInsertRowid);
  });
  const patch = (id: number) => db.prepare('SELECT name, triage, folded_into, release_id FROM balance_patches WHERE id = ?').get(id);
  const boxState = () => (db.prepare('SELECT state FROM release_boxes WHERE release_id = ?').get(rel) as { state: string }).state;

  it('balance names the new patch and confirms the box', () => {
    release('balance', 'Tank 7500');
    linkReleaseSighting(db, { serverId: s1, patchId: next, previousPatchId: prev });
    expect(patch(next)).toEqual({ name: 'Tank 7500', triage: 'balance', folded_into: null, release_id: rel });
    expect(boxState()).toBe('confirmed');
  });
  it('not balance folds it into the previous patch', () => {
    release('not_balance');
    linkReleaseSighting(db, { serverId: s1, patchId: next, previousPatchId: prev });
    expect(patch(next)).toMatchObject({ triage: 'folded', folded_into: prev, release_id: rel });
  });
  it('later leaves it pending but tagged', () => {
    release('later');
    linkReleaseSighting(db, { serverId: s1, patchId: next, previousPatchId: prev });
    expect(patch(next)).toMatchObject({ triage: 'pending', release_id: rel });
  });
  it('same fingerprint as before confirms the box and touches no patch', () => {
    release('balance', 'X');
    linkReleaseSighting(db, { serverId: s1, patchId: prev, previousPatchId: prev });
    expect(boxState()).toBe('confirmed');
    expect(patch(prev)).toMatchObject({ name: 'Base', release_id: null });
  });
  it('nothing to do without a written release on the box', () => {
    linkReleaseSighting(db, { serverId: s1, patchId: next, previousPatchId: prev });
    expect(patch(next)).toMatchObject({ triage: 'pending', release_id: null });
  });
});
