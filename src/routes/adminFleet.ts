import type { FastifyInstance } from 'fastify';
import type { DB } from '../db.js';
import { makeRequireAdmin } from './guards.js';
import { logAdmin } from '../admin/audit.js';
import { listServers } from '../serverPool.js';
import { compareFleet, loadManifest, type CompareOpts, type FileSig, type Manifest } from '../fleetCompare.js';
import type { DeployRepo } from '../deployRepo.js';
import type { ReleaseService } from '../releaseService.js';
import { deploySlug, wantedFor } from '../releaseStage.js';
import { readingStates, readingsOf, type FleetReader } from '../fleetReader.js';

export interface FleetRouteOpts {
  db: DB; fleetDir: string; reader: FleetReader;
  /** When present, the repo column comes from the site's clone of the deploy
   *  repo (at the newest deployed release, else master) instead of repo.json,
   *  each box also compares against its own layer, and cells name the
   *  release that shipped them. */
  releases?: { repo: DeployRepo; service: ReleaseService };
}

/** Admin > Setup > Fleet: read-only file view of every game server. */
export async function adminFleetRoutes(app: FastifyInstance, opts: FleetRouteOpts): Promise<void> {
  const { db, fleetDir, reader } = opts;
  const requireAdmin = makeRequireAdmin(db);

  /** The repo reference from the clone, or null to fall back to repo.json. */
  async function fromClone(servers: ReturnType<typeof listServers>): Promise<{ repo: Manifest; compare: CompareOpts } | null> {
    const rel = opts.releases;
    if (!rel) return null;
    try {
      await rel.repo.fetch();
      const deployed = db.prepare(`SELECT sources_json FROM releases WHERE kind = 'deploy'
        AND state IN ('deploying','canary_wait','done','halted') ORDER BY id DESC LIMIT 1`).get() as { sources_json: string } | undefined;
      const commit = deployed ? (JSON.parse(deployed.sources_json) as { commit: string }[])[0].commit : await rel.repo.resolve('master');
      const tree = await rel.repo.tree(commit);
      const shared: Record<string, FileSig> = {};
      for (const f of tree) if (f.path.startsWith('overrides/')) shared[f.path.slice('overrides/'.length)] = { size: f.size, sha256: f.sha256 };
      const at = (await rel.repo.commits(100)).find((c) => c.hash === commit)?.at ?? '';
      const boxRefs = new Map<number, Map<string, FileSig>>();
      const origins = new Map<number, Map<string, { releaseId: number; sha256: string }>>();
      for (const s of servers) {
        const own = new Map<string, FileSig>();
        for (const w of wantedFor(tree, deploySlug(s.name)).values()) if (w.layer === 'box') own.set(w.path, { size: w.size, sha256: w.sha256 });
        boxRefs.set(s.id, own);
        const last = rel.service.lastShipped(s.id);
        if (last) origins.set(s.id, new Map([...last.files].map(([p, f]) => [p, { releaseId: last.releaseId, sha256: f.sha256 }])));
      }
      return { repo: { kind: 'repo', label: commit.slice(0, 7), at, files: shared }, compare: { boxRefs, origins } };
    } catch (err) {
      console.error('[fleet] could not read the deploy repo clone, using repo.json:', err);
      return null;
    }
  }

  app.get('/api/admin/fleet', async (req, reply) => {
    if (!requireAdmin(req, reply)) return reply;
    const servers = listServers(db);
    const clone = await fromClone(servers);
    const repo = clone?.repo ?? loadManifest(fleetDir, 'repo'), base = loadManifest(fleetDir, 'base');
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
      rows: compareFleet(repo, base, servers.map((s) => ({ serverId: s.id, files: readings.get(s.id) ?? null })), clone?.compare),
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
