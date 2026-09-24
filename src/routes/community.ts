import { createHash } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import multipart from '@fastify/multipart';
import type { DB } from '../db.js';
import { makeOptionalViewer, makeRequireActive, makeRequireMod } from './guards.js';
import { logAdmin } from '../admin/audit.js';
import { getSetting, settingNumber } from '../settings.js';
import { getPlayer } from '../players.js';
import type { CommunityStore } from '../community/store.js';
import {
  checkCrosshairArt, checkDescription, checkHudDesign, checkImport, checkPreview, checkTitle,
  COMMUNITY_XHAIR_CAPS, IMPORT_MAX_BYTES, PREVIEW_MAX_BYTES,
} from '../community/validate.js';
import {
  countLive, ENTRY_KINDS, entryRow, fileLive, fileReferenced, getEntry, insertEntry, like, likeCount,
  listEntries, mineEntries, sharesSince, tombstone, unlike, visibleEntryRow, type EntryKind,
} from '../community/entries.js';

/**
 * The community page's API. See "Routes" in
 * docs/superpowers/specs/2026-09-24-hud-community-design.md.
 *
 * Crosshair shares are a small JSON body and touch no disk. The HUD upload and
 * the file routes, which do, need the store; it comes in as a getter so that
 * building the server never creates the community folder until something
 * actually writes to or reads from it.
 */
export interface CommunityRouteOpts {
  db: DB;
  store: () => CommunityStore;
  /** Injected in tests; the wall clock otherwise. */
  now?: () => Date;
  /** How long a HUD share may take to upload; UPLOAD_TIMEOUT_MS otherwise. */
  uploadTimeoutMs?: number;
}

const DAY_MS = 86_400_000;
const PERMISSION_ERROR = 'Tick the box to confirm you may share this.';
const SHELF_FULL = 'The community shelf is full right now.';
const REMOVE_REASON_MAX = 200;
const MB = 2 ** 20;
/** The meta field holds the design (2 MB at most) plus the short text fields. */
const META_MAX_BYTES = 2.5 * MB;

/** HUD uploads the server takes at once, across every player. */
const HUD_UPLOADS_AT_ONCE = 2;
/**
 * How long one may take. Fastify has no request timeout by default, so
 * without this two players sending their bodies a byte at a time would hold
 * both slots for ever. Two minutes carries the 20 MB cap at about 1.4 Mbit/s;
 * a real HUD is a few megabytes at most.
 */
const UPLOAD_TIMEOUT_MS = 120_000;
const TOO_SLOW = 'The share took too long to upload; try again.';
const PREVIEW_TOO_BIG = 'The preview is over 2.5 MB.';
const INFECTED_TOO_BIG = 'The infected preview is over 2.5 MB.';

/**
 * A file part's bytes, or null once they pass `cap`: from there the rest is
 * read and dropped, so the parser moves on without the part ever being held.
 */
async function readCapped(stream: AsyncIterable<Buffer>, cap: number): Promise<Buffer | null> {
  const chunks: Buffer[] = [];
  let size = 0;
  let over = false;
  for await (const chunk of stream) {
    if (over) continue;
    size += chunk.length;
    if (size > cap) { over = true; chunks.length = 0; } else chunks.push(chunk);
  }
  return over ? null : Buffer.concat(chunks);
}

/** @fastify/busboy's messages for a multipart body that is truncated or not multipart. */
const BUSBOY_MALFORMED = /^(Unexpected end of multipart data|Multipart: Boundary not found|Boundary required|Malformed)/;

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

export async function communityRoutes(app: FastifyInstance, opts: CommunityRouteOpts): Promise<void> {
  const { db } = opts;

  // Registered inside this plugin, so the limits apply to these routes only.
  // throwFileSizeLimit: false leaves an oversized file as part.file.truncated,
  // turned into a 413 below, as campaignRoutes does. One field (meta) and
  // three files (preview, previewInfected, import) are all a share ever holds;
  // anything past that fails in the parser before it is buffered.
  await app.register(multipart, {
    throwFileSizeLimit: false,
    limits: { fileSize: IMPORT_MAX_BYTES, files: 3, fields: 1, fieldSize: META_MAX_BYTES, parts: 4 },
  });

  const now = opts.now ?? (() => new Date());
  const optionalViewer = makeOptionalViewer(db);
  const requireActive = makeRequireActive(db);
  const requireMod = makeRequireMod(db);

  const isStaff = (steamid: string | null): boolean => {
    if (!steamid) return false;
    const p = getPlayer(db, steamid);
    return !!p && (p.is_admin === 1 || p.is_mod === 1);
  };

  // Read on every request, so an admin's settings change applies at once.
  // The fallbacks are the schema defaults, and settingNumber turns a blank
  // or out-of-range hand edit into them rather than into 0.
  const caps = () => ({
    huds: settingNumber(db, 'community_huds_per_player', 2, { min: 0, max: 5, integer: true }),
    crosshairs: settingNumber(db, 'community_crosshairs_per_player', 2, { min: 0, max: 5, integer: true }),
    perDay: settingNumber(db, 'community_shares_per_day', 6, { min: 1, max: 50, integer: true }),
  });
  // Off only on an explicit '0', as penalties_enabled: the kill switch is a
  // deliberate act, and a missing row is the seeded default (on).
  const uploadsOn = () => getSetting(db, 'community_uploads') !== '0';

  /**
   * The share caps for one more entry of `kind`, or the refusal. Called inside
   * the insert's transaction, so two shares racing each other cannot both
   * pass the count.
   */
  const capProblem = (author: string, kind: EntryKind): { status: 403 | 409 | 429; error: string } | null => {
    const c = caps();
    const cap = kind === 'hud' ? c.huds : c.crosshairs;
    const noun = kind === 'hud' ? 'HUD' : 'crosshair';
    if (cap === 0) return { status: 403, error: `Sharing ${noun}s is switched off right now.` };
    if (countLive(db, author, kind) >= cap) {
      return { status: 409, error: `You are sharing ${cap} ${noun}${cap === 1 ? '' : 's'} already. Delete one to share another.` };
    }
    if (sharesSince(db, author, new Date(now().getTime() - DAY_MS)) >= c.perDay) {
      return { status: 429, error: `You can share ${c.perDay} times a day; try again tomorrow.` };
    }
    return null;
  };

  /** Players with a HUD upload in flight. */
  const hudUploads = new Set<string>();

  const idOf = (raw: string): number | null => (/^[1-9][0-9]{0,15}$/.test(raw) ? Number(raw) : null);
  const notFound = (reply: FastifyReply) => reply.code(404).send({ error: 'no such entry' });

  app.get<{ Querystring: { kind?: string; sort?: string; page?: string; author?: string } }>(
    '/api/community', async (req, reply) => {
      const kind = req.query.kind as EntryKind;
      if (!ENTRY_KINDS.includes(kind)) return reply.code(400).send({ error: 'kind must be hud or crosshair' });
      return listEntries(db, {
        kind,
        sort: req.query.sort === 'top' ? 'top' : 'new',
        page: Number(req.query.page ?? 0),
        author: req.query.author || null,
        viewer: optionalViewer(req),
        now: now(),
      });
    },
  );

  app.get('/api/community/mine', async (req, reply) => {
    const me = requireActive(req, reply);
    if (!me) return reply;
    const c = caps();
    return {
      entries: mineEntries(db, me),
      caps: { ...c, sharedToday: sharesSince(db, me, new Date(now().getTime() - DAY_MS)) },
    };
  });

  app.get<{ Params: { id: string } }>('/api/community/:id', async (req, reply) => {
    const id = idOf(req.params.id);
    if (id === null) return notFound(reply);
    const viewer = optionalViewer(req);
    const entry = getEntry(db, id, { viewer, staff: isStaff(viewer), now: now() });
    return entry ?? notFound(reply);
  });

  app.post<{ Body: { title?: unknown; description?: unknown; art?: unknown; permission?: unknown } }>(
    '/api/community/crosshairs', { bodyLimit: 256 * 1024 }, async (req, reply) => {
      const me = requireActive(req, reply);
      if (!me) return reply;
      if (!uploadsOn()) return reply.code(403).send({ error: 'Sharing is switched off right now.' });
      const b = (req.body ?? {}) as Record<string, unknown>;
      const title = checkTitle(b.title);
      if (!title.ok) return reply.code(title.status).send({ error: title.error });
      const description = checkDescription(b.description);
      if (!description.ok) return reply.code(description.status).send({ error: description.error });
      const art = checkCrosshairArt(b.art, COMMUNITY_XHAIR_CAPS);
      if (!art.ok) return reply.code(art.status).send({ error: art.error });
      if (b.permission !== true) return reply.code(400).send({ error: PERMISSION_ERROR });

      // Stored re-serialized from the checked value, never the raw body, so
      // nothing the checks did not look at is kept.
      const payload = JSON.stringify(art.value);
      const result = db.transaction(() => {
        const problem = capProblem(me, 'crosshair');
        if (problem) return problem;
        return {
          id: insertEntry(db, {
            kind: 'crosshair', authorId: me, title: title.value, description: description.value,
            payload, bytes: Buffer.byteLength(payload), createdAt: now(),
          }),
        };
      })();
      if ('error' in result) return reply.code(result.status).send({ error: result.error });
      return { id: result.id };
    },
  );

  /**
   * A HUD share: multipart with `meta` (a JSON string of { title,
   * description, permission, design, importId? }, where design is itself the
   * design's JSON string, as the editor saves it), `preview` (the survivor
   * side's PNG), `previewInfected` (the infected side's PNG; optional, so a
   * page loaded before it existed can still share), and `import` (the VPK,
   * only for a design on an imported HUD).
   *
   * Everything is checked before the disk is touched. checkImport is the whole
   * check on the VPK (the allowlist, the canonical layout, the ids); nothing
   * here second-guesses it or keeps anything it did not return.
   */
  app.post('/api/community/huds', async (req, reply) => {
    const me = requireActive(req, reply);
    if (!me) return reply;
    if (!uploadsOn()) return reply.code(403).send({ error: 'Sharing is switched off right now.' });
    // The caps before a byte of the body is read, so a player who cannot
    // share costs the server no upload; the insert checks them again inside
    // its transaction.
    const early = capProblem(me, 'hud');
    if (early) return reply.code(early.status).send({ error: early.error });
    // One upload in flight per player, and a few across the site: each can
    // hold up to 27.5 MB in memory while it is checked (the 2.5 MB meta, two
    // 2.5 MB previews and the 20 MB import).
    if (hudUploads.has(me)) {
      return reply.code(409).send({ error: 'Your last HUD share is still uploading; wait for it to finish.' });
    }
    if (hudUploads.size >= HUD_UPLOADS_AT_ONCE) {
      return reply.code(429).send({ error: 'Other HUD shares are uploading right now; try again in a moment.' });
    }
    hudUploads.add(me);
    // A stalled body's connection is dropped, which ends the parts loop with
    // an error and frees the slot. The 408 is for the log: nobody is left to
    // read it.
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      req.raw.destroy();
    }, opts.uploadTimeoutMs ?? UPLOAD_TIMEOUT_MS);
    try {
      return await shareHud(me, req, reply);
    } catch (err) {
      if (timedOut) return reply.code(408).send({ error: TOO_SLOW });
      throw err;
    } finally {
      clearTimeout(timer);
      hudUploads.delete(me);
    }
  });

  const shareHud = async (me: string, req: FastifyRequest, reply: FastifyReply) => {
    // Every part is read to its end before anything is refused, so a refusal
    // never leaves a file stream half consumed under the parser.
    let meta: string | null = null;
    let preview: Buffer | null = null;
    let infected: Buffer | null = null;
    let vpk: Buffer | null = null;
    let odd = false;
    let truncated = false;
    let previewTooBig = false;
    let infectedTooBig = false;
    try {
      for await (const part of req.parts()) {
        if (part.type === 'field') {
          if (part.fieldname !== 'meta' || meta !== null) odd = true;
          else if (part.valueTruncated) truncated = true;
          else meta = String(part.value);
          continue;
        }
        if (part.fieldname === 'preview' && preview === null && !previewTooBig) {
          // Streamed under its own cap, far below the 20 MB the parser allows an import.
          const buf = await readCapped(part.file, PREVIEW_MAX_BYTES);
          if (buf === null) previewTooBig = true;
          else preview = buf;
        } else if (part.fieldname === 'previewInfected' && infected === null && !infectedTooBig) {
          const buf = await readCapped(part.file, PREVIEW_MAX_BYTES);
          if (buf === null) infectedTooBig = true;
          else infected = buf;
        } else if (part.fieldname === 'import' && vpk === null) {
          const buf = await part.toBuffer();
          if (part.file.truncated) truncated = true;
          else vpk = buf;
        } else {
          odd = true;
          await readCapped(part.file, 0);
        }
      }
    } catch (err) {
      // The parser's own limits (a third file, a second field) and malformed
      // bodies. Its messages are not the house's one-liners, so say it here.
      const status = (err as { statusCode?: number }).statusCode;
      if (status === 413) return reply.code(413).send({ error: 'The share is over its size limits.' });
      // Busboy's own errors on a body cut short or broken (a dropped
      // connection, a hand-made request) carry no status at all, and would
      // otherwise be a 500 for what is the sender's fault.
      const malformed = !status && BUSBOY_MALFORMED.test((err as Error).message ?? '');
      if (malformed || (typeof status === 'number' && status >= 400 && status < 500)) {
        return reply.code(400).send({ error: 'The share is not in the form the site sends.' });
      }
      throw err;
    }
    if (previewTooBig) return reply.code(413).send({ error: PREVIEW_TOO_BIG });
    if (infectedTooBig) return reply.code(413).send({ error: INFECTED_TOO_BIG });
    if (truncated) return reply.code(413).send({ error: 'The share is over its size limits.' });
    if (odd || meta === null) return reply.code(400).send({ error: 'The share is not in the form the site sends.' });

    let m: unknown;
    try { m = JSON.parse(meta); } catch { m = null; }
    if (!isObj(m)) return reply.code(400).send({ error: 'The share details are not readable.' });
    const title = checkTitle(m.title);
    if (!title.ok) return reply.code(title.status).send({ error: title.error });
    const description = checkDescription(m.description);
    if (!description.ok) return reply.code(description.status).send({ error: description.error });
    if (m.permission !== true) return reply.code(400).send({ error: PERMISSION_ERROR });
    if (vpk === null && m.importId !== undefined) {
      return reply.code(400).send({ error: 'The share names an imported HUD but does not include it.' });
    }
    if (vpk !== null && typeof m.importId !== 'string') {
      return reply.code(400).send({ error: 'The imported HUD was sent without its id.' });
    }
    const importId = vpk === null ? undefined : (m.importId as string);
    const design = checkHudDesign(m.design, { title: title.value, importId });
    if (!design.ok) return reply.code(design.status).send({ error: design.error });
    if (preview === null) return reply.code(400).send({ error: 'The preview is missing.' });
    const shot = checkPreview(preview, design.value.aspect);
    if (!shot.ok) return reply.code(shot.status).send({ error: shot.error });
    if (infected !== null) {
      const inf = checkPreview(infected, design.value.aspect, 'The infected preview');
      if (!inf.ok) return reply.code(inf.status).send({ error: inf.error });
    }
    let imported: { id: string } | null = null;
    if (vpk !== null) {
      // checkHudDesign has already tied the design's imported.id to importId.
      const imp = await checkImport(vpk, importId, importId);
      if (!imp.ok) return reply.code(imp.status).send({ error: imp.error });
      imported = { id: imp.value.id };
    }

    const store = opts.store();
    const previewSha = createHash('sha256').update(preview).digest('hex');
    const newPreview = !store.has('preview', previewSha);
    const infectedSha = infected === null ? null : createHash('sha256').update(infected).digest('hex');
    const newInfected = infected !== null && infectedSha !== previewSha && !store.has('preview', infectedSha!);
    const newImport = imported !== null && !store.has('import', imported.id);
    const incoming = (newPreview ? preview.length : 0) + (newInfected ? infected!.length : 0)
      + (newImport && vpk ? vpk.length : 0);
    // A share that reuses files already stored adds nothing, so no budget
    // or disk floor can refuse it.
    if (incoming > 0 && !(await store.canTake(incoming))) return reply.code(507).send({ error: SHELF_FULL });

    // Only what this request itself wrote is undone on a failure, and even
    // that only when no row has come to use it meanwhile (a second share of
    // the same import racing this one).
    const wrote: { kind: 'preview' | 'import'; name: string }[] = [];
    const undo = () => {
      for (const w of wrote) {
        if (!fileReferenced(db, w.kind, w.name)) store.remove(w.kind, w.name);
      }
    };
    try {
      const p = store.putPreview(preview);
      if (p.wrote) wrote.push({ kind: 'preview', name: p.name });
      const q = infected === null ? null : store.putPreview(infected);
      if (q?.wrote) wrote.push({ kind: 'preview', name: q.name });
      let blobBytes = 0;
      if (imported && vpk) {
        const w = store.putImport(imported.id, vpk);
        if (w.wrote) { wrote.push({ kind: 'import', name: imported.id }); blobBytes = vpk.length; }
      }
      const payload = design.value.json;
      const result = db.transaction(() => {
        const problem = capProblem(me, 'hud');
        if (problem) return problem;
        return {
          id: insertEntry(db, {
            kind: 'hud', authorId: me, title: title.value, description: description.value, payload,
            preset: design.value.preset, aspect: design.value.aspect, advanced: design.value.advanced,
            importId: imported?.id ?? null, importName: design.value.importName, preview: p.name,
            previewInfected: q?.name ?? null,
            bytes: Buffer.byteLength(payload) + preview.length + (infected?.length ?? 0) + blobBytes, createdAt: now(),
          }),
        };
      })();
      if ('error' in result) {
        undo();
        return reply.code(result.status).send({ error: result.error });
      }
      return { id: result.id };
    } catch (err) {
      undo();
      throw err;
    }
  };

  /**
   * The stored files. Anyone may fetch one a live entry uses; staff may fetch
   * any, so a report about a removed entry can still be looked at. The name
   * is checked against 64 hex before it goes near a path, and the headers
   * make sure a PNG that is also something else never renders as a page.
   */
  const serveFile = (kind: 'preview' | 'import') =>
    async (req: FastifyRequest<{ Params: { file: string } }>, reply: FastifyReply) => {
      const ext = kind === 'preview' ? 'png' : 'vpk';
      const match = /^([0-9a-f]{64})\.([a-z]+)$/.exec(req.params.file);
      const gone = () => reply.code(404).send({ error: 'no such file' });
      if (!match || match[2] !== ext) return gone();
      const name = match[1]!;
      const live = fileLive(db, kind, name, now());
      if (!live && !isStaff(optionalViewer(req))) return gone();
      const store = opts.store();
      const bytes = kind === 'preview' ? store.readPreview(name) : store.readImport(name);
      if (!bytes) return gone();
      reply
        .header('X-Content-Type-Options', 'nosniff')
        .header('Content-Security-Policy', "default-src 'none'; sandbox")
        // Content addressed, so a live file never changes, but it can stop
        // being live (a delete or a staff removal): an hour's cache lets a
        // removal take effect. A staff view of a removed one must not linger
        // in any cache.
        .header('Cache-Control', live ? 'public, max-age=3600' : 'no-store');
      if (kind === 'preview') return reply.type('image/png').send(bytes);
      return reply
        .type('application/octet-stream')
        .header('Content-Disposition', `attachment; filename="${name}.vpk"`)
        .send(bytes);
    };
  app.get('/api/community/files/previews/:file', serveFile('preview'));
  app.get('/api/community/files/imports/:file', serveFile('import'));

  app.delete<{ Params: { id: string } }>('/api/community/:id', async (req, reply) => {
    const me = requireActive(req, reply);
    if (!me) return reply;
    const id = idOf(req.params.id);
    const row = id === null ? null : entryRow(db, id);
    if (!row || row.deleted_at !== null) return notFound(reply);
    // Staff take an entry down through /remove, which asks for a reason and
    // writes the audit log. This one is the author's own delete.
    if (row.author_id !== me) return reply.code(403).send({ error: 'only the author can delete this' });
    if (!tombstone(db, row.id, { by: me, reason: null, now: now() })) return notFound(reply);
    return { ok: true };
  });

  /**
   * Staff take an entry down, with a reason the author is shown in their own
   * list. The tombstone and the audit row are one step, so a removal is
   * never missing from the log.
   */
  app.post<{ Params: { id: string }; Body: { reason?: unknown } }>('/api/community/:id/remove', async (req, reply) => {
    const staff = requireMod(req, reply);
    if (!staff) return reply;
    const id = idOf(req.params.id);
    const row = id === null ? null : entryRow(db, id);
    if (!row || row.deleted_at !== null) return notFound(reply);
    const raw = (req.body as { reason?: unknown } | undefined)?.reason;
    const reason = typeof raw === 'string' ? raw.trim() : '';
    if (!reason || [...reason].length > REMOVE_REASON_MAX) {
      return reply.code(400).send({ error: `Give a reason, in at most ${REMOVE_REASON_MAX} characters.` });
    }
    const removed = db.transaction(() => {
      if (!tombstone(db, row.id, { by: staff, reason, now: now() })) return false;
      logAdmin(db, staff, 'community_remove', row.author_id, { entryId: row.id, kind: row.kind, title: row.title, reason });
      return true;
    })();
    if (!removed) return notFound(reply);
    return { ok: true };
  });

  const likeRoute = async (on: boolean, req: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
    const me = requireActive(req, reply);
    if (!me) return reply;
    const id = idOf(req.params.id);
    // Only an entry the viewer could open: not removed, and not by a banned author.
    const row = id === null ? null : visibleEntryRow(db, id, now());
    if (!row) return notFound(reply);
    if (row.author_id === me) return reply.code(400).send({ error: 'You cannot like your own entry.' });
    if (on) like(db, row.id, me, now());
    else unlike(db, row.id, me);
    return { likes: likeCount(db, row.id), likedByMe: on };
  };
  app.put<{ Params: { id: string } }>('/api/community/:id/like', (req, reply) => likeRoute(true, req, reply));
  app.delete<{ Params: { id: string } }>('/api/community/:id/like', (req, reply) => likeRoute(false, req, reply));
}
