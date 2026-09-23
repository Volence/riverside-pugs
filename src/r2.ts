import { createHash, createHmac } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';

/**
 * A minimal S3 client for Cloudflare R2: PUT, HEAD, DELETE, and nothing else.
 *
 * Hand-rolled rather than `@aws-sdk/client-s3` for the same reason rconPacket.ts
 * is hand-rolled: the protocol surface actually used here is three verbs and one
 * signature algorithm, against a service that is never going to be swapped for
 * real AWS, and the SDK is tens of megabytes of transitive dependency to reach
 * it. SigV4 is about sixty lines and is exercised by its own tests.
 *
 * Why R2 at all: demo files are the bulk of the game server's disk (4.3 GB and
 * climbing at ~1 GB/day on a box with under 10 GB free), they are written once,
 * closed, downloaded whole, and never touched by the backend again. That is the
 * exact shape object storage is for. R2 specifically because its egress is
 * unmetered, so serving them costs storage only.
 *
 * Every function here throws on failure and none of them are allowed to be
 * fatal to a match: callers treat an upload failure as "leave it on disk and
 * try again later", never as a reason a result fails to record.
 */

export interface R2Config {
  endpoint: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** Public base URL the browser is redirected to. No trailing slash. */
  publicUrl: string;
}

/** Read R2 settings from the environment, or null when it is not configured.
 *
 *  All five must be present. A half-configured R2 is more dangerous than none:
 *  an upload that silently no-ops while the caller deletes the local file would
 *  lose demos, so the absence of any one variable turns the whole feature off
 *  rather than leaving it half on. */
export function r2FromEnv(env: NodeJS.ProcessEnv = process.env): R2Config | null {
  const endpoint = env.R2_ENDPOINT?.trim().replace(/\/+$/, '');
  const bucket = env.R2_BUCKET?.trim();
  const accessKeyId = env.R2_ACCESS_KEY_ID?.trim();
  const secretAccessKey = env.R2_SECRET_ACCESS_KEY?.trim();
  const publicUrl = env.R2_PUBLIC_URL?.trim().replace(/\/+$/, '');
  if (!endpoint || !bucket || !accessKeyId || !secretAccessKey || !publicUrl) return null;
  return { endpoint, bucket, accessKeyId, secretAccessKey, publicUrl };
}

const sha256 = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');
const hmac = (key: Buffer | string, msg: string) => createHmac('sha256', key).update(msg).digest();

/** The empty-payload hash, which is what an unsigned-payload request signs. */
export const EMPTY_SHA256 = sha256('');

/** R2 ignores the region but SigV4 does not: it is part of the signing scope,
 *  and Cloudflare's documented value is the literal string "auto". */
const REGION = 'auto';
const SERVICE = 's3';

/**
 * AWS Signature Version 4, for one request.
 *
 * Split out from the request itself so the signing can be tested against known
 * inputs without a network. `payloadHash` is the caller's problem because a
 * streamed upload cannot hash its own body cheaply: see `put`, which uses the
 * UNSIGNED-PAYLOAD form for exactly that reason.
 */
export function signRequest(
  cfg: R2Config,
  opts: {
    method: string;
    /** Path portion, already encoded, starting with a slash. */
    path: string;
    headers: Record<string, string>;
    payloadHash: string;
    now?: Date;
  },
): Record<string, string> {
  const now = opts.now ?? new Date();
  const amzDate = now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const dateStamp = amzDate.slice(0, 8);

  const headers: Record<string, string> = {
    ...opts.headers,
    host: new URL(cfg.endpoint).host,
    'x-amz-content-sha256': opts.payloadHash,
    'x-amz-date': amzDate,
  };

  // Canonical headers are lower-cased, sorted, and the signed list must match
  // exactly what is sent. Any header added after signing breaks the signature.
  const lower: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) lower[k.toLowerCase()] = String(v).trim();
  const signedHeaders = Object.keys(lower).sort().join(';');
  const canonicalHeaders = Object.keys(lower).sort().map((k) => `${k}:${lower[k]}\n`).join('');

  const canonicalRequest = [
    opts.method,
    opts.path,
    '', // no query string is ever used here
    canonicalHeaders,
    signedHeaders,
    opts.payloadHash,
  ].join('\n');

  const scope = `${dateStamp}/${REGION}/${SERVICE}/aws4_request`;
  const toSign = [
    'AWS4-HMAC-SHA256',
    amzDate,
    scope,
    sha256(canonicalRequest),
  ].join('\n');

  const kDate = hmac(`AWS4${cfg.secretAccessKey}`, dateStamp);
  const kRegion = hmac(kDate, REGION);
  const kService = hmac(kRegion, SERVICE);
  const kSigning = hmac(kService, 'aws4_request');
  const signature = createHmac('sha256', kSigning).update(toSign).digest('hex');

  return {
    ...headers,
    Authorization:
      `AWS4-HMAC-SHA256 Credential=${cfg.accessKeyId}/${scope}, `
      + `SignedHeaders=${signedHeaders}, Signature=${signature}`,
  };
}

/** Percent-encode an object key for the request path, leaving the separators.
 *
 *  encodeURIComponent is right for each segment but would eat the slashes that
 *  give the key its folders, so segments are encoded and rejoined. */
export function encodeKey(key: string): string {
  return key.split('/').map(encodeURIComponent).join('/');
}

function pathFor(cfg: R2Config, key: string): string {
  return `/${encodeURIComponent(cfg.bucket)}/${encodeKey(key)}`;
}

/**
 * Upload a file, streamed from disk.
 *
 * UNSIGNED-PAYLOAD rather than a content hash: a 90 MB demo would otherwise
 * have to be read once to hash and once to send. The request is still fully
 * authenticated and TLS still protects it in transit; what is given up is
 * S3-side detection of a body altered between signing and arrival, which is not
 * a threat model that applies to a file this process is streaming to itself.
 *
 * `contentDisposition` is stored ON THE OBJECT, which is the whole reason a
 * redirect works: the browser sees the friendly `pug37-1.dem` name from R2's
 * response, so `playdemo` still takes a short name rather than the 60-character
 * token the file is stored under. See the note in routes/stats.ts.
 */
export async function put(
  cfg: R2Config,
  key: string,
  filePath: string,
  opts: { contentType?: string; contentDisposition?: string; cacheControl?: string } = {},
): Promise<{ bytes: number }> {
  const { size } = await stat(filePath);
  const headers: Record<string, string> = {
    'content-length': String(size),
    'content-type': opts.contentType ?? 'application/octet-stream',
  };
  if (opts.contentDisposition) headers['content-disposition'] = opts.contentDisposition;
  if (opts.cacheControl) headers['cache-control'] = opts.cacheControl;

  const signed = signRequest(cfg, {
    method: 'PUT', path: pathFor(cfg, key), headers, payloadHash: 'UNSIGNED-PAYLOAD',
  });

  const res = await fetch(`${cfg.endpoint}${pathFor(cfg, key)}`, {
    method: 'PUT',
    headers: signed,
    body: createReadStream(filePath) as unknown as ReadableStream,
    // Node needs this to stream a body rather than buffer it whole.
    duplex: 'half',
  } as RequestInit & { duplex: 'half' });

  if (!res.ok) throw new Error(`R2 PUT ${key} failed: ${res.status} ${await res.text().catch(() => '')}`);
  return { bytes: size };
}

/** Size of an object, or null when it is not there. Used to verify an upload
 *  landed before the local copy is deleted; a PUT that returned 200 but stored
 *  the wrong number of bytes must not cost us the only copy. */
export async function head(cfg: R2Config, key: string): Promise<{ bytes: number } | null> {
  const signed = signRequest(cfg, {
    method: 'HEAD', path: pathFor(cfg, key), headers: {}, payloadHash: EMPTY_SHA256,
  });
  const res = await fetch(`${cfg.endpoint}${pathFor(cfg, key)}`, { method: 'HEAD', headers: signed });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`R2 HEAD ${key} failed: ${res.status}`);
  return { bytes: Number(res.headers.get('content-length') ?? 0) };
}

export async function del(cfg: R2Config, key: string): Promise<void> {
  const signed = signRequest(cfg, {
    method: 'DELETE', path: pathFor(cfg, key), headers: {}, payloadHash: EMPTY_SHA256,
  });
  const res = await fetch(`${cfg.endpoint}${pathFor(cfg, key)}`, { method: 'DELETE', headers: signed });
  // 204 is the success case; 404 means someone already removed it, which is
  // the state we wanted anyway.
  if (!res.ok && res.status !== 404) throw new Error(`R2 DELETE ${key} failed: ${res.status}`);
}

/** Bytes of an object from `from` to its end, plus the object's total size.
 *  Null when the object is not there. An offset at or past the end is not an
 *  error: it answers an empty body and the total, which is what a viewer that
 *  already has the whole file asks for. */
export async function getRange(
  cfg: R2Config, key: string, from: number,
): Promise<{ body: Buffer; total: number } | null> {
  const headers = { range: `bytes=${from}-` };
  const signed = signRequest(cfg, { method: 'GET', path: pathFor(cfg, key), headers, payloadHash: EMPTY_SHA256 });
  const res = await fetch(`${cfg.endpoint}${pathFor(cfg, key)}`, { method: 'GET', headers: signed });
  if (res.status === 404) return null;
  const range = res.headers.get('content-range');
  if (res.status === 416) {
    return { body: Buffer.alloc(0), total: Number(/\/(\d+)$/.exec(range ?? '')?.[1] ?? 0) };
  }
  if (!res.ok) throw new Error(`R2 GET ${key} failed: ${res.status}`);
  const body = Buffer.from(await res.arrayBuffer());
  const total = res.status === 206
    ? Number(/\/(\d+)$/.exec(range ?? '')?.[1] ?? from + body.length)
    : Number(res.headers.get('content-length') ?? body.length);
  return { body, total };
}

/** Where a stored demo lives, for the redirect. */
export function publicUrlFor(cfg: R2Config, key: string): string {
  return `${cfg.publicUrl}/${encodeKey(key)}`;
}

/** The object key for one match demo.
 *
 *  Grouped by match so the bucket is browsable and a whole match can be removed
 *  with one prefix listing. The stored name keeps the token, because the key is
 *  never what a human reads: the download name comes from Content-Disposition. */
export function demoKey(matchId: number, filename: string): string {
  return `demos/${matchId}/${filename}`;
}

/** The object key for one replay round.
 *
 *  Unlike `demoKey`, NOT derived from the filename: replay filenames carry the
 *  match token, which seeds that match's server password, and the bucket is
 *  public by URL. Match id, ordinal and half identify the round completely. */
export function replayKey(matchId: number, ordinal: number, half: number): string {
  return `replays/${matchId}/${ordinal}_${half}.rpl`;
}

/** The object key for one map overview layer.
 *
 *  Sits beside `demos/` under its own prefix, so the two never interleave and
 *  a prefix listing shows the whole art set. The file name already carries the
 *  map and the cut height and is unique across campaigns, so it needs no
 *  further grouping; it is also content-addressed in practice, because a
 *  recapture of the same cut writes the same name and replaces the object. */
export function overviewKey(file: string): string {
  return `overviews/${file}`;
}

/** Overviews never change under a given name, so they may be cached hard.
 *
 *  A recapture of the same cut height overwrites the object rather than
 *  producing a new name, which is the one case this gets wrong: after a
 *  recapture a viewer holding the old copy keeps it until the year is out.
 *  That is the right trade while the set is stable and recaptures are rare
 *  events we control; if recaptures become routine, put a hash in the name. */
export const OVERVIEW_CACHE_CONTROL = 'public, max-age=31536000, immutable';
