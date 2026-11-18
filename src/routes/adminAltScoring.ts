import type { FastifyInstance } from 'fastify';
import type { DB } from '../db.js';
import { makeRequireAdmin } from './guards.js';
import { buildAltReport } from '../altScoringReport.js';

/** Health-run scoring in shadow mode: the alt score beside the real one. */
export async function adminAltScoringRoutes(app: FastifyInstance, opts: { db: DB }): Promise<void> {
  const { db } = opts;
  const requireAdmin = makeRequireAdmin(db);

  app.get('/api/admin/balance/alt-scoring', async (req, reply) => {
    if (!requireAdmin(req, reply)) return reply;
    return buildAltReport(db);
  });
}
