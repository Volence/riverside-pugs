import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { rename, rm, stat, statfs } from 'node:fs/promises';
import { join } from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { FastifyInstance } from 'fastify';
import multipart from '@fastify/multipart';
import type { DB } from '../db.js';
import { makeRequireAdmin } from './guards.js';
import { logAdmin } from '../admin/audit.js';
import { CAMPAIGNS } from '../campaigns.js';
import { invalidateCampaignCache } from '../campaignRegistry.js';
import { transportFor } from '../addonsTransport.js';
import { installCampaign, uninstallCampaign, type InstallTarget } from '../campaignInstall.js';
import {
  chaptersOf, deleteCampaign, getCampaign, insertDraft, installsOf,
  listCampaigns, publishCampaign, setEnabled,
} from '../customCampaigns.js';
import { missionFromVpk } from '../vpk.js';
import type { ServerRow } from '../serverPool.js';

/** Headroom the box must keep after an upload lands. A game server that fills
 *  its partition stops serving; a refused upload is a message, a full disk is
 *  an outage. */
const DISK_FLOOR_BYTES = 2 * 1024 * 1024 * 1024;

export interface CampaignRouteOpts {
  db: DB;
  addonsDir: string;
  /** Injectable for tests. Defaults to a real statfs on the addons directory,
   *  which would otherwise make the disk-floor test pass or fail depending on
   *  how full the machine running it happens to be. */
  freeBytes?: () => Promise<number>;
}

export async function campaignRoutes(
  app: FastifyInstance, opts: CampaignRouteOpts,
): Promise<void> {
  const { db, addonsDir } = opts;
  const requireAdmin = makeRequireAdmin(db);
  const freeBytes = opts.freeBytes
    ?? (async () => { const s = await statfs(addonsDir); return s.bsize * s.bavail; });

  await app.register(multipart, { limits: { fileSize: 2 * 1024 * 1024 * 1024, files: 1 } });

  const targets = (): InstallTarget[] =>
    (db.prepare('SELECT * FROM servers WHERE enabled = 1').all() as ServerRow[])
      .map((s) => ({ id: s.id, transport: transportFor(s) }));

  app.get('/api/campaigns/custom', async () => ({
    campaigns: listCampaigns(db, { state: 'published', enabledOnly: true }).map((c) => ({
      slug: c.slug, name: c.name, sizeBytes: c.size_bytes, sha256: c.sha256,
      filename: c.vpk_filename, notes: c.notes,
      chapters: chaptersOf(db, c.slug).map((ch) => ({
        map: ch.map, display: ch.display, included: ch.included === 1,
      })),
    })),
  }));

  app.get('/download/campaign/:slug', async (req, reply) => {
    const { slug } = req.params as { slug: string };
    const c = getCampaign(db, slug);
    if (!c || c.state !== 'published') return reply.code(404).send({ error: 'no such campaign' });
    // The path comes from the row, never from the URL. The slug only indexes
    // into the database; it never gets joined to addonsDir directly.
    const path = join(addonsDir, c.vpk_filename);
    let onDisk: Awaited<ReturnType<typeof stat>>;
    try {
      onDisk = await stat(path);
    } catch {
      return reply.code(404).send({ error: 'file missing' });
    }
    if (onDisk.size !== c.size_bytes) {
      req.log.error({ slug, expected: c.size_bytes, actual: onDisk.size },
        'campaign VPK on disk no longer matches its recorded size, refusing to serve');
      return reply.code(404).send({ error: 'file changed' });
    }
    return reply
      .header('content-type', 'application/octet-stream')
      .header('content-disposition', `attachment; filename="${c.vpk_filename}"`)
      .header('content-length', String(c.size_bytes))
      .send(createReadStream(path));
  });

  app.get('/api/admin/campaigns', async (req, reply) => {
    if (!requireAdmin(req, reply)) return reply;
    return {
      free: await freeBytes(),
      campaigns: listCampaigns(db).map((c) => ({
        ...c, chapters: chaptersOf(db, c.slug), installs: installsOf(db, c.slug),
      })),
    };
  });

  app.post('/api/admin/campaigns', async (req, reply) => {
    const adminId = requireAdmin(req, reply);
    if (!adminId) return reply;
    if (!addonsDir) return reply.code(503).send({ error: 'no addons directory configured' });

    const part = await req.file();
    if (!part) return reply.code(400).send({ error: 'no file' });

    const free = await freeBytes();
    if (free < DISK_FLOOR_BYTES) {
      return reply.code(507).send({ error: 'not enough free disk space on the server' });
    }

    // Streamed to a temp name in the addons directory itself, so the final
    // move below is a same-filesystem rename rather than a copy, and cleaned
    // up in the finally below so a failed upload never leaves a .part file
    // behind.
    const tmp = join(addonsDir, `.upload-${randomUUID()}.part`);
    try {
      const hash = createHash('sha256');
      let size = 0;
      // A Transform between the source and the file is the one and only
      // consumer of part.file. Attaching a separate 'data' listener would put
      // the stream into flowing mode and race the pipeline also reading it,
      // risking a hash that does not match what pipeline actually wrote.
      const meter = new Transform({
        transform(chunk: Buffer, _enc, cb) {
          hash.update(chunk);
          size += chunk.length;
          cb(null, chunk);
        },
      });
      await pipeline(part.file, meter, createWriteStream(tmp));
      if (part.file.truncated) throw new Error('file too large');

      const mission = missionFromVpk(tmp);
      if (!mission) {
        return reply.code(400).send({ error: 'no versus mission found in that VPK' });
      }

      const slug = mission.name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
      if (!slug) return reply.code(400).send({ error: 'mission has no usable name' });
      if (CAMPAIGNS[slug] || getCampaign(db, slug)) {
        return reply.code(409).send({ error: `a campaign named ${slug} already exists` });
      }

      const sha256 = hash.digest('hex');
      const filename = `${slug}.vpk`;
      await rename(tmp, join(addonsDir, filename));
      insertDraft(db, {
        slug, name: mission.displayTitle, vpkFilename: filename,
        sizeBytes: size, sha256, uploadedBy: adminId,
      }, mission.chapters.map((c) => ({ map: c.map, display: c.display, isFinale: false })));
      logAdmin(db, adminId, 'campaign_upload', slug, { name: mission.displayTitle, sizeBytes: size });
      invalidateCampaignCache();

      return {
        slug, name: mission.displayTitle, sizeBytes: size, sha256,
        chapters: chaptersOf(db, slug),
      };
    } finally {
      await rm(tmp, { force: true });
    }
  });

  app.post('/api/admin/campaigns/:slug/publish', async (req, reply) => {
    const adminId = requireAdmin(req, reply);
    if (!adminId) return reply;
    const { slug } = req.params as { slug: string };
    const c = getCampaign(db, slug);
    if (!c) return reply.code(404).send({ error: 'no such campaign' });
    const name = String((req.body as { name?: string } | undefined)?.name ?? c.name).trim().slice(0, 80);
    if (!name) return reply.code(400).send({ error: 'name cannot be empty' });
    publishCampaign(db, slug, name);
    invalidateCampaignCache();
    logAdmin(db, adminId, 'campaign_publish', slug, { from: c.name, to: name });
    // Not awaited: a 300 MB FTP upload must not hold the request open, and
    // every result is recorded per server (setInstall) for the panel to show.
    // installCampaign never throws, so this never fails the match or the
    // request that kicked it off.
    void installCampaign(db, slug, {
      sourcePath: join(addonsDir, c.vpk_filename), servers: targets(),
    });
    return { ok: true };
  });

  app.post('/api/admin/campaigns/:slug/enabled', async (req, reply) => {
    const adminId = requireAdmin(req, reply);
    if (!adminId) return reply;
    const { slug } = req.params as { slug: string };
    const c = getCampaign(db, slug);
    if (!c) return reply.code(404).send({ error: 'no such campaign' });
    const enabled = (req.body as { enabled?: boolean } | undefined)?.enabled === true;
    setEnabled(db, slug, enabled);
    invalidateCampaignCache();
    logAdmin(db, adminId, 'campaign_enabled', slug, { enabled });
    return { ok: true };
  });

  app.post('/api/admin/campaigns/:slug/reinstall', async (req, reply) => {
    const adminId = requireAdmin(req, reply);
    if (!adminId) return reply;
    const { slug } = req.params as { slug: string };
    const c = getCampaign(db, slug);
    if (!c) return reply.code(404).send({ error: 'no such campaign' });
    logAdmin(db, adminId, 'campaign_reinstall', slug);
    void installCampaign(db, slug, {
      sourcePath: join(addonsDir, c.vpk_filename), servers: targets(),
    });
    return { ok: true };
  });

  app.delete('/api/admin/campaigns/:slug', async (req, reply) => {
    const adminId = requireAdmin(req, reply);
    if (!adminId) return reply;
    const { slug } = req.params as { slug: string };
    const c = getCampaign(db, slug);
    if (!c) return reply.code(404).send({ error: 'no such campaign' });
    await uninstallCampaign(db, slug, { servers: targets() });
    await rm(join(addonsDir, c.vpk_filename), { force: true });
    deleteCampaign(db, slug);
    invalidateCampaignCache();
    logAdmin(db, adminId, 'campaign_delete', slug, { name: c.name });
    return { ok: true };
  });
}
