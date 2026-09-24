import type { FastifyInstance } from 'fastify';
import type { DB } from '../db.js';
import { makeRequireAdmin } from './guards.js';
import { logAdmin } from '../admin/audit.js';
import { listServers } from '../serverPool.js';
import { compareFleet, loadManifest } from '../fleetCompare.js';
import { readingStates, readingsOf, type FleetReader } from '../fleetReader.js';

export interface FleetRouteOpts { db: DB; fleetDir: string; reader: FleetReader }

/** Admin > Setup > Fleet: read-only file view of every game server. */
export async function adminFleetRoutes(app: FastifyInstance, opts: FleetRouteOpts): Promise<void> {
  const { db, fleetDir, reader } = opts;
  const requireAdmin = makeRequireAdmin(db);

  app.get('/api/admin/fleet', async (req, reply) => {
    if (!requireAdmin(req, reply)) return reply;
    const repo = loadManifest(fleetDir, 'repo'), base = loadManifest(fleetDir, 'base');
    const servers = listServers(db);
    const readings = readingsOf(db);
    const states = new Map(readingStates(db).map((s) => [s.serverId, s]));
    return {
      repo: repo && { label: repo.label, at: repo.at },
      base: base && { label: base.label, at: base.at },
      boxes: servers.map((s) => ({
        serverId: s.id, name: s.name, enabled: s.enabled === 1,
        readAt: states.get(s.id)?.readAt ?? null, attemptAt: states.get(s.id)?.attemptAt ?? null,
        error: states.get(s.id)?.error ?? null, pending: reader.pending(s.id),
      })),
      rows: compareFleet(repo, base, servers.map((s) => ({ serverId: s.id, files: readings.get(s.id) ?? null }))),
    };
  });

  app.post('/api/admin/fleet/check', async (req, reply) => {
    const adminId = requireAdmin(req, reply);
    if (!adminId) return reply;
    const b = (req.body ?? {}) as { serverId?: unknown; all?: unknown };
    let ids: number[];
    if (b.all === true) ids = listServers(db).filter((s) => s.enabled === 1).map((s) => s.id);
    else if (typeof b.serverId === 'number' && Number.isInteger(b.serverId)) ids = [b.serverId];
    else return reply.code(400).send({ error: 'send { serverId } or { all: true }' });
    const states = reader.request(ids);
    logAdmin(db, adminId, 'fleet_check', b.all === true ? 'all' : ids[0], { states });
    return { states };
  });
}
