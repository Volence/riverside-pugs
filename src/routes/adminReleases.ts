import type { FastifyInstance } from 'fastify';
import type { DB } from '../db.js';
import { makeRequireAdmin } from './guards.js';
import { logAdmin } from '../admin/audit.js';
import type { DeployRepo } from '../deployRepo.js';
import type { ReleaseEngine } from '../releaseEngine.js';
import type { ReleaseService } from '../releaseService.js';

export interface ReleaseRouteOpts { db: DB; repo: DeployRepo; service: ReleaseService; engine: ReleaseEngine; devMode: boolean }

const idOf = (req: { params: unknown }): number | null => {
  const raw = (req.params as { id: string }).id;
  return /^\d{1,9}$/.test(raw) ? Number(raw) : null;
};

/** Admin > Setup > Deploy. Admin only; every change audited. */
export async function adminReleaseRoutes(app: FastifyInstance, o: ReleaseRouteOpts): Promise<void> {
  const requireAdmin = makeRequireAdmin(o.db);

  const overview = async (force: boolean) => {
    let fetchError: string | null = null;
    try { await o.repo.fetch(force); } catch (err) { fetchError = err instanceof Error ? err.message : String(err); }
    const releases = o.service.list();
    const byCommit = new Map(releases.filter((r) => r.kind === 'deploy').map((r) => [r.commit, r.id]));
    const commits = fetchError && o.repo.lastFetchAt() === null ? [] : await o.repo.commits().catch(() => []);
    return {
      commits: commits.map((c) => ({ ...c, releaseId: byCommit.get(c.hash) ?? null })),
      releases, inFlight: o.engine.inFlight(), devMode: o.devMode, fetchError,
    };
  };

  app.get('/api/admin/releases', async (req, reply) => {
    if (!requireAdmin(req, reply)) return reply;
    return overview(false);
  });
  app.post('/api/admin/releases/refresh', async (req, reply) => {
    if (!requireAdmin(req, reply)) return reply;
    return overview(true);
  });
  app.post('/api/admin/releases/stage', async (req, reply) => {
    const adminId = requireAdmin(req, reply);
    if (!adminId) return reply;
    const commit = (req.body as { commit?: unknown } | undefined)?.commit;
    if (typeof commit !== 'string') return reply.code(400).send({ error: 'commit is required' });
    const r = await o.service.stage(commit, adminId);
    if (!r.ok) return reply.code(r.status).send({ error: r.error });
    logAdmin(o.db, adminId, 'release_stage', r.id, { commit });
    return { id: r.id };
  });
  app.get('/api/admin/releases/:id', async (req, reply) => {
    if (!requireAdmin(req, reply)) return reply;
    const id = idOf(req);
    const r = id === null ? null : await o.service.review(id);
    return r ?? reply.code(404).send({ error: 'no such release' });
  });
  app.post('/api/admin/releases/:id/deploy', async (req, reply) => {
    const adminId = requireAdmin(req, reply);
    if (!adminId) return reply;
    const id = idOf(req);
    if (id === null) return reply.code(404).send({ error: 'no such release' });
    const b = (req.body ?? {}) as { targets?: unknown; canary?: unknown; balance?: { decision?: unknown; name?: unknown; notes?: unknown } };
    const targets = Array.isArray(b.targets) && b.targets.every((t) => Number.isInteger(t)) ? b.targets as number[] : [];
    const canary = Number.isInteger(b.canary) ? b.canary as number : null;
    const r = o.engine.deploy(id, { targets, canary, balance: { decision: String(b.balance?.decision ?? ''), name: b.balance?.name, notes: b.balance?.notes }, adminId });
    if (!r.ok) return reply.code(r.status).send({ error: r.error });
    logAdmin(o.db, adminId, 'release_deploy', id, { targets, canary, balance: b.balance?.decision });
    void o.engine.tick();
    return { ok: true };
  });
  app.post('/api/admin/releases/:id/continue', async (req, reply) => {
    const adminId = requireAdmin(req, reply);
    if (!adminId) return reply;
    const id = idOf(req);
    if (id === null) return reply.code(404).send({ error: 'no such release' });
    const r = o.engine.continueRelease(id, adminId);
    if (!r.ok) return reply.code(r.status).send({ error: r.error });
    logAdmin(o.db, adminId, 'release_continue', id);
    void o.engine.tick();
    return { ok: true };
  });
  app.post('/api/admin/releases/:id/undo', async (req, reply) => {
    const adminId = requireAdmin(req, reply);
    if (!adminId) return reply;
    const id = idOf(req);
    if (id === null) return reply.code(404).send({ error: 'no such release' });
    const servers = (req.body as { servers?: unknown } | undefined)?.servers;
    const list = Array.isArray(servers) && servers.every((s) => Number.isInteger(s)) ? servers as number[] : null;
    const r = o.engine.undo(id, list, adminId);
    if (!r.ok) return reply.code(r.status).send({ error: r.error });
    logAdmin(o.db, adminId, 'release_undo', id, { servers: list ?? 'all', undoId: r.id });
    void o.engine.tick();
    return { id: r.id };
  });
}
