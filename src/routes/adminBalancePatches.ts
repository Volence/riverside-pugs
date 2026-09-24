import type { FastifyInstance } from 'fastify';
import type { DB } from '../db.js';
import { makeRequireAdmin } from './guards.js';
import { logAdmin } from '../admin/audit.js';
import type { BalanceKnobs } from '../balanceKnobs.js';
import { editPatch, listPatches, patchDetail, refingerprintPatches, serverDrift } from '../balancePatches.js';
import { effectiveIgnored, listIgnored, PLUGIN_FILE_RE, removeIgnored } from '../balanceIgnore.js';
import { triageBalance, triageFold, triageIgnore, triageUnfold, type Lists } from '../balanceTriage.js';

export interface PatchRouteOpts {
  db: DB;
  /** Null when balance/knobs.json failed to load: the list still works (with
   *  the site ignore list only); ignoring plugins answers 503. */
  knobs: BalanceKnobs | null;
}

const idOf = (req: { params: unknown }): number | null => {
  const raw = (req.params as { id: string }).id;
  return /^\d{1,9}$/.test(raw) ? Number(raw) : null;
};

/** The Patches tab: list, detail, edit, drift, triage and the site ignore
 *  list. Moved out of routes/admin.ts because triage needs the knobs. */
export async function adminBalancePatchRoutes(app: FastifyInstance, opts: PatchRouteOpts): Promise<void> {
  const { db, knobs } = opts;
  const requireAdmin = makeRequireAdmin(db);
  const lists = (): Lists => ({ versionless: knobs?.versionless ?? [], ignored: effectiveIgnored(db, knobs?.ignored) });
  const unavailable = { error: 'balance/knobs.json failed to load; ignoring plugins is unavailable until it is fixed' };

  app.get('/api/admin/balance/patches', async (req, reply) => {
    if (!requireAdmin(req, reply)) return reply;
    return { patches: listPatches(db, lists()) };
  });

  app.get('/api/admin/balance/patches/:id', async (req, reply) => {
    if (!requireAdmin(req, reply)) return reply;
    const id = idOf(req);
    const d = id === null ? null : patchDetail(db, id, lists());
    return d ?? reply.code(404).send({ error: 'no such patch' });
  });

  app.get('/api/admin/balance/drift', async (req, reply) => {
    if (!requireAdmin(req, reply)) return reply;
    return { servers: serverDrift(db, lists().ignored) };
  });

  app.post('/api/admin/balance/patches/:id', async (req, reply) => {
    const adminId = requireAdmin(req, reply);
    if (!adminId) return reply;
    const id = Number((req.params as { id: string }).id);
    const b = (req.body ?? {}) as { name?: unknown; notes?: unknown; reviewed?: unknown };
    const edit: { name?: string | null; notes?: string; reviewed?: boolean } = {};
    if (b.name !== undefined) {
      if (b.name !== null && (typeof b.name !== 'string' || b.name.trim().length > 60)) {
        return reply.code(400).send({ error: 'a patch name is up to 60 characters' });
      }
      edit.name = b.name === null || b.name.trim() === '' ? null : b.name.trim();
    }
    if (b.notes !== undefined) {
      if (typeof b.notes !== 'string' || b.notes.length > 2000) return reply.code(400).send({ error: 'notes are up to 2000 characters' });
      edit.notes = b.notes;
    }
    if (b.reviewed !== undefined) {
      if (typeof b.reviewed !== 'boolean') return reply.code(400).send({ error: 'reviewed is true or false' });
      edit.reviewed = b.reviewed;
    }
    if (!editPatch(db, id, edit)) return reply.code(404).send({ error: 'no such patch' });
    logAdmin(db, adminId, 'edit_patch', id, edit);
    return { ok: true };
  });

  app.post('/api/admin/balance/patches/:id/triage', async (req, reply) => {
    const adminId = requireAdmin(req, reply);
    if (!adminId) return reply;
    const id = idOf(req);
    if (id === null) return reply.code(404).send({ error: 'no such patch' });
    const b = (req.body ?? {}) as { decision?: unknown; name?: unknown; notes?: unknown; into?: unknown; plugins?: unknown };
    let r;
    if (b.decision === 'balance') r = triageBalance(db, id, { name: b.name, notes: b.notes });
    else if (b.decision === 'fold') r = triageFold(db, id, b.into);
    else if (b.decision === 'ignore') {
      if (!knobs) return reply.code(503).send(unavailable);
      r = triageIgnore(db, id, { into: b.into, plugins: b.plugins, versionless: knobs.versionless, knobsIgnored: knobs.ignored ?? [], adminId });
    } else return reply.code(400).send({ error: 'decision is balance, fold or ignore' });
    if (!r.ok) return reply.code(r.status).send({ error: r.error });
    logAdmin(db, adminId, 'triage_patch', id, {
      decision: b.decision,
      ...(b.decision === 'balance' ? { name: typeof b.name === 'string' ? b.name.trim() : '' } : { into: r.target }),
      ...(b.decision === 'ignore' ? { plugins: b.plugins } : {}),
    });
    return r.target === undefined ? { ok: true } : { ok: true, target: r.target };
  });

  app.post('/api/admin/balance/patches/:id/unfold', async (req, reply) => {
    const adminId = requireAdmin(req, reply);
    if (!adminId) return reply;
    const id = idOf(req);
    if (id === null) return reply.code(404).send({ error: 'no such patch' });
    const r = triageUnfold(db, id);
    if (!r.ok) return reply.code(r.status).send({ error: r.error });
    logAdmin(db, adminId, 'unfold_patch', id);
    return { ok: true };
  });

  app.get('/api/admin/balance/ignored-plugins', async (req, reply) => {
    if (!requireAdmin(req, reply)) return reply;
    return { plugins: listIgnored(db, knobs?.ignored ?? []) };
  });

  app.delete('/api/admin/balance/ignored-plugins/:file', async (req, reply) => {
    const adminId = requireAdmin(req, reply);
    if (!adminId) return reply;
    if (!knobs) return reply.code(503).send(unavailable);
    const file = (req.params as { file: string }).file;
    if (!PLUGIN_FILE_RE.test(file)) return reply.code(400).send({ error: 'not a plugin file name' });
    if (!removeIgnored(db, file)) {
      return (knobs.ignored ?? []).includes(file)
        ? reply.code(409).send({ error: 'this plugin is ignored by balance/knobs.json; remove it there' })
        : reply.code(404).send({ error: 'not on the ignored list' });
    }
    // Past folds stay; the next sighting that includes the plugin opens a new pending patch.
    refingerprintPatches(db, knobs.versionless, effectiveIgnored(db, knobs.ignored), (e) => console.warn(`[balance] ${e.text}`));
    logAdmin(db, adminId, 'unignore_plugin', file);
    return { ok: true };
  });
}
