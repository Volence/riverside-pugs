import type { FastifyInstance } from 'fastify';
import type { DB } from '../db.js';
import { makeRequireAdmin } from './guards.js';
import { logAdmin } from '../admin/audit.js';
import { loadBalanceKnobs, type BalanceKnobs } from '../balanceKnobs.js';
import { listPublished, publicEntry, publishPatch, type KnobLabels } from '../balancePublic.js';
import { withEffectiveIgnored } from '../balanceIgnore.js';
import { loadCatalogue, type Catalogue } from '../balanceCatalogue.js';
import { gameValues } from '../balanceValues.js';

export interface BalancePublicRouteOpts { db: DB; knobsPath?: string; cataloguePath?: string }

const idOf = (req: { params: unknown }): number | null => {
  const raw = (req.params as { id: string }).id;
  return /^\d{1,9}$/.test(raw) ? Number(raw) : null;
};

/** The public patch notes page (balance analytics piece 5) and its admin
 *  preview and publish controls. Public routes are unauthenticated and only
 *  ever answer fixed query shapes over published patches; the heavy part is
 *  the admin comparison's own cache. */
export async function balancePublicRoutes(app: FastifyInstance, opts: BalancePublicRouteOpts): Promise<void> {
  const { db } = opts;
  const requireAdmin = makeRequireAdmin(db);
  // Labels only: a missing or broken knobs.json degrades to raw cvar names.
  let knobs: BalanceKnobs | null = null;
  try { knobs = loadBalanceKnobs(opts.knobsPath); } catch (err) {
    console.error('[balance] public page: knobs.json failed to load, showing raw names:', err);
  }

  // Per request: the site ignore list can change while the process runs.
  const labels = (): KnobLabels => withEffectiveIgnored(db, knobs ?? { cvars: [], files: [], dirs: [], versionless: [] });

  // The Game values page (sub-project 4). A broken catalogue disables it (503).
  let catalogue: Catalogue | null = null;
  try { catalogue = loadCatalogue(opts.cataloguePath); } catch (err) {
    console.error('[balance] values page disabled, balance/catalogue.json failed to load:', err);
  }
  const noCatalogue = { error: 'balance/catalogue.json failed to load' };
  // Public and unauthenticated: cached until any patch changes (name,
  // publish, triage, a new sighting) or a minute passes.
  let cached: { stamp: string; at: number; value: ReturnType<typeof gameValues> } | null = null;
  const valuesStamp = () => JSON.stringify(db.prepare(`SELECT COUNT(*) AS n, MAX(id) AS m,
    GROUP_CONCAT(COALESCE(triage,'') || COALESCE(folded_into,'') || COALESCE(published_at,'') || COALESCE(name,''), '|') AS s
    FROM balance_patches`).get());
  app.get('/api/balance/values', async (_req, reply) => {
    if (!catalogue) return reply.code(503).send(noCatalogue);
    const stamp = valuesStamp();
    if (!cached || cached.stamp !== stamp || Date.now() - cached.at > 60_000) {
      cached = { stamp, at: Date.now(), value: gameValues(db, catalogue, { admin: false }) };
    }
    return cached.value;
  });
  app.get('/api/admin/balance/values', async (req, reply) => {
    if (!requireAdmin(req, reply)) return reply;
    return catalogue ? gameValues(db, catalogue, { admin: true }) : reply.code(503).send(noCatalogue);
  });

  app.get('/api/balance/patches', async () => ({ patches: listPublished(db) }));

  app.get('/api/balance/patches/:id', async (req, reply) => {
    const id = idOf(req);
    const e = id === null ? null : publicEntry(db, id, { knobs: labels() });
    return e ?? reply.code(404).send({ error: 'no such patch' });
  });

  app.get('/api/admin/balance/patches/:id/public', async (req, reply) => {
    if (!requireAdmin(req, reply)) return reply;
    const id = idOf(req);
    const e = id === null ? null : publicEntry(db, id, { knobs: labels(), preview: true });
    return e ?? reply.code(404).send({ error: 'no such patch' });
  });

  app.post('/api/admin/balance/patches/:id/publish', async (req, reply) => {
    const adminId = requireAdmin(req, reply);
    if (!adminId) return reply;
    const id = idOf(req);
    if (id === null) return reply.code(404).send({ error: 'no such patch' });
    const published = (req.body as { published?: unknown } | undefined)?.published;
    if (typeof published !== 'boolean') return reply.code(400).send({ error: 'published is true or false' });
    const r = publishPatch(db, id, published);
    if (!r.ok) return reply.code(r.status).send({ error: r.error });
    logAdmin(db, adminId, published ? 'publish_patch' : 'unpublish_patch', id);
    return { ok: true };
  });
}
