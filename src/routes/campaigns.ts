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
import { getCampaignPool, setSetting } from '../settings.js';

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
  /** Servers to push a published campaign to, or pull a deleted one from.
   *  Injectable for tests, so a background install's per-server results can
   *  be asserted against a fake transport instead of a real servers table and
   *  transportFor (which would mean touching a real filesystem or FTP config
   *  per test). Defaults to every enabled server, resolved through
   *  transportFor exactly as production does. */
  installTargets?: () => InstallTarget[];
  /** Overrides the multipart file-size limit. Production leaves this at 2 GB;
   *  tests inject a small number to exercise the truncation path without
   *  uploading gigabytes of data. */
  maxUploadBytes?: number;
}

export async function campaignRoutes(
  app: FastifyInstance, opts: CampaignRouteOpts,
): Promise<void> {
  const { db, addonsDir } = opts;
  const requireAdmin = makeRequireAdmin(db);
  const freeBytes = opts.freeBytes
    ?? (async () => { const s = await statfs(addonsDir); return s.bsize * s.bavail; });
  const maxUploadBytes = opts.maxUploadBytes ?? 2 * 1024 * 1024 * 1024;

  // throwFileSizeLimit: false keeps a too-large upload as a plain
  // part.file.truncated flag once the pipeline below settles, rather than an
  // exception thrown mid-stream that would otherwise have to be caught around
  // the pipeline call and turned back into the same 413.
  await app.register(multipart, {
    throwFileSizeLimit: false,
    limits: { fileSize: maxUploadBytes, files: 1 },
  });

  const defaultTargets = (): InstallTarget[] =>
    (db.prepare('SELECT * FROM servers WHERE enabled = 1').all() as ServerRow[])
      .map((s) => ({ id: s.id, transport: transportFor(s) }));
  const targets = opts.installTargets ?? defaultTargets;

  app.get('/api/campaigns/custom', async () => {
    // Whether a campaign can actually come up in a vote is the thing a player
    // needs to know: it turns "here is a list of files" into "download this one
    // or you will not be able to play". Read once rather than per campaign.
    const pool = new Set(getCampaignPool(db));
    return {
      campaigns: listCampaigns(db, { state: 'published', enabledOnly: true }).map((c) => ({
        slug: c.slug, name: c.name, sizeBytes: c.size_bytes, sha256: c.sha256,
        filename: c.vpk_filename, notes: c.notes, inPool: pool.has(c.slug),
        chapters: chaptersOf(db, c.slug).map((ch) => ({
          map: ch.map, display: ch.display, included: ch.included === 1,
        })),
      })),
    };
  });

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
    // statfs('') throws when addonsDir is unconfigured, and a real directory
    // can also vanish or become unreadable. The list itself doesn't depend on
    // any of that, so degrade to "can't report free space" rather than 500ing
    // the whole panel over a number nobody strictly needs to see it.
    let free: number | null = null;
    try {
      free = await freeBytes();
    } catch (err) {
      req.log.error({ err }, 'could not read free disk space for the campaigns panel');
    }
    return {
      free,
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

    // part.file has no length up front (multipart doesn't declare one per
    // part), but the whole request's content-length is a fair upper bound on
    // the file it carries, boundary overhead included. Without it, a 1.9 GB
    // upload onto a disk with 2.1 GB free would clear a flat 2 GB floor and
    // then nearly fill the partition that srcds also runs on. When the
    // header is missing, fall back to the flat floor rather than guessing.
    const declaredSize = Number(req.headers['content-length']);
    const floor = DISK_FLOOR_BYTES + (Number.isFinite(declaredSize) ? declaredSize : 0);
    const free = await freeBytes();
    if (free < floor) {
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
      // throwFileSizeLimit: false above means this is a flag to check, not an
      // exception the pipeline would have thrown. 413 is the honest status
      // for "your file exceeded the limit", not a 500.
      if (part.file.truncated) {
        return reply.code(413).send({ error: 'file exceeded the upload size limit' });
      }

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
    // installCampaign is contracted not to throw, but this process also runs
    // the matchmaker queue and match orchestration, and Node exits on an
    // unhandled rejection: the .catch is a backstop against that contract
    // ever being violated, not an expectation that it will be.
    void installCampaign(db, slug, {
      sourcePath: join(addonsDir, c.vpk_filename), servers: targets(),
    }).catch((err) => req.log.error({ err, slug }, 'installCampaign rejected unexpectedly'));
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
    // Reinstall changes no row the registry reads (only install state, which
    // the registry doesn't cache), but every admin mutation here invalidates
    // unconditionally rather than each one reasoning about whether it needs to.
    invalidateCampaignCache();
    logAdmin(db, adminId, 'campaign_reinstall', slug);
    // See the .catch note on the publish route above: same backstop, same
    // reason.
    void installCampaign(db, slug, {
      sourcePath: join(addonsDir, c.vpk_filename), servers: targets(),
    }).catch((err) => req.log.error({ err, slug }, 'installCampaign rejected unexpectedly'));
    return { ok: true };
  });

  app.delete('/api/admin/campaigns/:slug', async (req, reply) => {
    const adminId = requireAdmin(req, reply);
    if (!adminId) return reply;
    const { slug } = req.params as { slug: string };
    const c = getCampaign(db, slug);
    if (!c) return reply.code(404).send({ error: 'no such campaign' });

    // map_pool is a persisted setting nothing else prunes. Left alone, a
    // deleted campaign stays a vote option: the orchestrator's own guard
    // (src/orchestrator.ts) now refuses to changelevel into a campaign the
    // registry has lost, but that guard is a last resort at match start, not
    // a substitute for keeping the pool itself honest. Refusing the delete
    // outright when this is the only pooled campaign, rather than silently
    // falling back to the stock four: an admin who narrowed the pool on
    // purpose (a custom-only event, say) did not ask for four campaigns they
    // did not pick to reappear the moment they delete one file.
    const pool = getCampaignPool(db);
    if (pool.includes(slug)) {
      const pruned = pool.filter((s) => s !== slug);
      if (pruned.length === 0) {
        return reply.code(409).send({
          error: `${c.name} is the only campaign in the pool; add another to the pool before deleting it`,
        });
      }
      setSetting(db, 'map_pool', JSON.stringify(pruned));
    }

    await uninstallCampaign(db, slug, { servers: targets() });
    await rm(join(addonsDir, c.vpk_filename), { force: true });
    deleteCampaign(db, slug);
    invalidateCampaignCache();
    logAdmin(db, adminId, 'campaign_delete', slug, { name: c.name });
    return { ok: true };
  });
}
