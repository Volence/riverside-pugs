import type { FastifyInstance } from 'fastify';
import type { DB } from '../db.js';
import { makeRequireAdmin } from './guards.js';
import { logAdmin } from '../admin/audit.js';
import { adjustableKnobs, type BalanceKnobs } from '../balanceKnobs.js';
import { baseInventory, blockingServers, currentValues, missingKnobs, patchNumber, previewKnobs, restoreValues } from '../balanceControl.js';
import { applyKnobs, listRollouts } from '../balanceRollouts.js';

export interface KnobRouteOpts {
  db: DB;
  /** Null when balance/knobs.json failed to load: every route answers 503. */
  knobs: BalanceKnobs | null;
  /** Kicks a write pass after an apply. Absent in dev mode. */
  writer?: { sync(): Promise<unknown> };
}

/** The balance control panel (piece 4). Admin only; every apply audited. */
export async function adminBalanceKnobRoutes(app: FastifyInstance, opts: KnobRouteOpts): Promise<void> {
  const { db, knobs, writer } = opts;
  const requireAdmin = makeRequireAdmin(db);
  const unavailable = { error: 'balance/knobs.json failed to load; the knob panel is unavailable until it is fixed' };

  app.get('/api/admin/balance/knobs', async (req, reply) => {
    if (!requireAdmin(req, reply)) return reply;
    if (!knobs) return reply.code(503).send(unavailable);
    const base = baseInventory(db);
    const active = listRollouts(db, knobs, 1).filter((r) => r.supersededAt === null)[0] ?? null;
    const restorable = (db.prepare(`SELECT id, name, source FROM balance_patches WHERE inputs_json IS NOT NULL ORDER BY first_seen_at DESC, id DESC`)
      .all() as { id: number; name: string | null; source: string }[]).map((p) => ({ ...p, number: patchNumber(db, p.id) }));
    return {
      knobs: adjustableKnobs(knobs),
      current: currentValues(db, knobs),
      base: base ? { patchId: base.patchId, number: patchNumber(db, base.patchId) } : null,
      missing: base ? missingKnobs(base.inventory, knobs) : [],
      blocking: base ? blockingServers(db, base.inventory, knobs) : [],
      active,
      restorable,
    };
  });

  app.post('/api/admin/balance/knobs/preview', async (req, reply) => {
    if (!requireAdmin(req, reply)) return reply;
    if (!knobs) return reply.code(503).send(unavailable);
    return previewKnobs(db, knobs, (req.body as { values?: unknown } | undefined)?.values ?? {});
  });

  app.post('/api/admin/balance/knobs/apply', async (req, reply) => {
    const adminId = requireAdmin(req, reply);
    if (!adminId) return reply;
    if (!knobs) return reply.code(503).send(unavailable);
    const b = (req.body ?? {}) as { values?: unknown; name?: unknown; notes?: unknown };
    const r = applyKnobs(db, knobs, { values: b.values ?? {}, name: b.name, notes: b.notes, adminId });
    if (!r.ok) return reply.code(r.status).send({ error: r.error, preview: r.preview });
    logAdmin(db, adminId, 'balance_apply', r.rolloutId, {
      patchId: r.patchId, reused: r.reused, changes: r.preview.diff.map((d) => `${d.cvar} ${d.from} -> ${d.to}`),
    });
    void writer?.sync();
    return { ok: true, rolloutId: r.rolloutId, patchId: r.patchId, reused: r.reused };
  });

  app.get('/api/admin/balance/knobs/restore/:patchId', async (req, reply) => {
    if (!requireAdmin(req, reply)) return reply;
    if (!knobs) return reply.code(503).send(unavailable);
    const r = restoreValues(db, knobs, Number((req.params as { patchId: string }).patchId));
    if (!r.ok) return reply.code(400).send({ error: r.error });
    return { values: r.values, notes: r.notes };
  });

  app.get('/api/admin/balance/rollouts', async (req, reply) => {
    if (!requireAdmin(req, reply)) return reply;
    if (!knobs) return reply.code(503).send(unavailable);
    return { rollouts: listRollouts(db, knobs) };
  });
}
