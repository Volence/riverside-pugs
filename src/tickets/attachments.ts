import { createHash, randomBytes } from 'node:crypto';
import { createWriteStream, mkdirSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { DB } from '../db.js';
import { publishAdminEvent } from '../adminFeed.js';
import { getSetting } from '../settings.js';
import type { InboundAttachment } from '../discord/transport.js';
import { storedBytes, type SkipReason } from './messages.js';

/**
 * The only files a ticket keeps, by extension. `mime` is what the serving
 * route answers with, whatever Discord or the uploader claimed; `inline` is
 * whether a browser may show it in place. Everything else is recorded (name,
 * type, size) and not stored. No svg and no html: both can carry script.
 */
export const ALLOWED_TYPES: Record<string, { mime: string; inline: boolean }> = {
  png: { mime: 'image/png', inline: true },
  jpg: { mime: 'image/jpeg', inline: true },
  gif: { mime: 'image/gif', inline: true },
  webp: { mime: 'image/webp', inline: true },
  mp4: { mime: 'video/mp4', inline: true },
  webm: { mime: 'video/webm', inline: true },
  mov: { mime: 'video/quicktime', inline: true },
  txt: { mime: 'text/plain; charset=utf-8', inline: false },
};

/** By the LAST extension, so `trick.png.exe` is an exe. */
export function allowedType(filename: string): { ext: string; mime: string; inline: boolean } | null {
  const m = /\.([A-Za-z0-9]+)$/.exec(filename);
  const raw = m ? m[1].toLowerCase() : '';
  const ext = raw === 'jpeg' ? 'jpg' : raw;
  const t = ALLOWED_TYPES[ext];
  return t ? { ext, ...t } : null;
}

/** Fetch a URL's bytes. Injected, so tests never touch the network. */
export type AttachmentFetcher = (url: string) => Promise<{ ok: boolean; body: AsyncIterable<Uint8Array> | null }>;

export interface SaveResult {
  /** Bytes written when stored; otherwise what Discord said the size was. */
  size: number;
  sha256: string | null;
  storedName: string | null;
  skipReason: SkipReason | null;
}

/** Where a stored file is, or null for a name this module did not make. The
 *  name comes out of the database, and this is what stands between a bad row
 *  and a path outside the directory. */
export function attachmentPath(dir: string, storedName: string): string | null {
  return /^[0-9a-f]{32}$/.test(storedName) ? join(dir, storedName) : null;
}

class TooLarge extends Error {}

const mb = (db: DB, key: string, fallback: number): number => Number(getSetting(db, key) ?? fallback) * 1024 * 1024;

export class AttachmentStore {
  /** The overall cap is reported once, not once per refused file. It is
   *  reported again if space was freed and then ran out again. */
  private capReported = false;

  constructor(private deps: { db: DB; dir: string; fetcher: AttachmentFetcher }) {}

  get dir(): string {
    return this.deps.dir;
  }

  /** Decide, download, hash and store one file. Never throws: every way this
   *  can go wrong is a skip reason the ticket page shows. */
  async save(ticketId: number, a: InboundAttachment): Promise<SaveResult> {
    const { db, dir, fetcher } = this.deps;
    const skip = (skipReason: SkipReason): SaveResult => ({ size: a.size, sha256: null, storedName: null, skipReason });

    // Everything that can be decided from metadata, before a byte is fetched.
    if (getSetting(db, 'ticket_store_attachments') === '0') return skip('disabled');
    if (!allowedType(a.name)) return skip('type');
    const maxBytes = mb(db, 'ticket_attachment_max_mb', 25);
    if (a.size > maxBytes) return skip('too_large');
    if (storedBytes(db, ticketId) + a.size > mb(db, 'ticket_attachments_ticket_mb', 200)) return skip('quota');
    if (storedBytes(db) + a.size > mb(db, 'ticket_attachments_total_mb', 2048)) {
      if (!this.capReported) {
        this.capReported = true;
        // Names no ticket and no file: every admin reads the feed.
        publishAdminEvent({ kind: 'problem', text: 'Ticket attachment storage is full, so new files posted in ticket threads are recorded but not stored. Raise "Attachment space overall" in Settings, or remove messages that no longer matter.' });
      }
      return skip('quota');
    }
    this.capReported = false;

    const storedName = randomBytes(16).toString('hex');
    const final = join(dir, storedName);
    const part = `${final}.part`;
    const hash = createHash('sha256');
    let size = 0;
    try {
      const res = await fetcher(a.url);
      if (!res.ok || !res.body) return skip('fetch_failed');
      const body = res.body;
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      // The cap again, on the bytes themselves: the size above is what
      // Discord said, and this is what actually arrived.
      const capped = async function* (): AsyncGenerator<Uint8Array> {
        for await (const chunk of body) {
          size += chunk.byteLength;
          if (size > maxBytes) throw new TooLarge();
          hash.update(chunk);
          yield chunk;
        }
      };
      await pipeline(Readable.from(capped()), createWriteStream(part, { mode: 0o600 }));
      renameSync(part, final);
      return { size, sha256: hash.digest('hex'), storedName, skipReason: null };
    } catch (err) {
      rmSync(part, { force: true });
      if (err instanceof TooLarge) return skip('too_large');
      // The message only: the URL carries a signature and stays out of logs.
      console.error('[tickets] an attachment download failed:', err instanceof Error ? err.message : err);
      return skip('fetch_failed');
    }
  }
}

const CDN_HOSTS = new Set(['cdn.discordapp.com', 'media.discordapp.net']);

/** The real fetcher. It will only ever dial Discord's CDN over https, and
 *  follows no redirect: the URL comes out of a Discord payload, and this is
 *  what keeps a surprise in one from becoming a request to somewhere else. */
export const httpFetcher: AttachmentFetcher = async (url) => {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return { ok: false, body: null };
  }
  if (u.protocol !== 'https:' || !CDN_HOSTS.has(u.hostname)) return { ok: false, body: null };
  const res = await fetch(u, { redirect: 'error', signal: AbortSignal.timeout(120_000) });
  return { ok: res.ok, body: res.body as unknown as AsyncIterable<Uint8Array> | null };
};
