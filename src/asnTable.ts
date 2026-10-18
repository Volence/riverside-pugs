import { existsSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';

/**
 * Which network (autonomous system) an address belongs to, offline.
 *
 * For the evader fingerprint's first second sign: a connection from a VPN or
 * hosting provider (src/networkKinds.ts). The table is iptoasn.com's free
 * ip2asn-v4 file, public domain, one line per routed range:
 *
 *   range_start  range_end  AS_number  country_code  AS_description
 *
 * It is held in memory as sorted typed arrays and looked up by binary search,
 * so a connect costs a few dozen comparisons and no network call. The address
 * itself is never kept: the lookup happens on the way into player_networks,
 * next to the salted hash, and only the AS number and provider name are
 * stored. An AS number names a provider, not a person.
 *
 * No dependency: fetch and node:zlib do the download. A download that fails
 * or looks truncated never replaces the file that works.
 */

export const IP2ASN_URL = 'https://iptoasn.com/data/ip2asn-v4.tsv.gz';
export const ASN_MAX_AGE_MS = 7 * 86_400_000;
/** A real file has several hundred thousand ranges. Fewer than this is an
 *  error page or a cut-off download. */
export const MIN_RANGES = 1000;

export interface AsnHit { asn: number; org: string }
export interface AsnLookup { lookup(ip: string): AsnHit | null }

export function ipToU32(ip: string): number | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip);
  if (!m) return null;
  const o = m.slice(1).map(Number);
  if (o.some((n) => n > 255)) return null;
  return o[0] * 16777216 + o[1] * 65536 + o[2] * 256 + o[3];
}

export class AsnTable implements AsnLookup {
  constructor(
    private readonly starts: Uint32Array,
    private readonly ends: Uint32Array,
    private readonly asns: Uint32Array,
    private readonly orgIndex: Uint32Array,
    private readonly orgs: readonly string[],
  ) {}

  get size(): number {
    return this.starts.length;
  }

  lookup(ip: string): AsnHit | null {
    const n = ipToU32(ip);
    if (n === null) return null;
    let lo = 0;
    let hi = this.starts.length - 1;
    let found = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (this.starts[mid] <= n) { found = mid; lo = mid + 1; } else { hi = mid - 1; }
    }
    if (found < 0 || n > this.ends[found]) return null;
    return { asn: this.asns[found], org: this.orgs[this.orgIndex[found]] };
  }
}

/** Unroutable ranges (AS 0) and malformed lines are dropped, not guessed at. */
export function parseIp2AsnTsv(text: string): AsnTable {
  const rows: [number, number, number, string][] = [];
  for (const line of text.split('\n')) {
    const f = line.split('\t');
    if (f.length < 5) continue;
    const start = ipToU32(f[0]);
    const end = ipToU32(f[1]);
    const asn = Number(f[2]);
    if (start === null || end === null || end < start || !Number.isInteger(asn) || asn <= 0) continue;
    rows.push([start, end, asn, f[4].trim()]);
  }
  rows.sort((a, b) => a[0] - b[0]);
  const orgs: string[] = [];
  const orgId = new Map<string, number>();
  const starts = new Uint32Array(rows.length);
  const ends = new Uint32Array(rows.length);
  const asns = new Uint32Array(rows.length);
  const orgIndex = new Uint32Array(rows.length);
  rows.forEach(([s, e, a, org], i) => {
    let id = orgId.get(org);
    if (id === undefined) { id = orgs.length; orgs.push(org); orgId.set(org, id); }
    starts[i] = s; ends[i] = e; asns[i] = a; orgIndex[i] = id;
  });
  return new AsnTable(starts, ends, asns, orgIndex, orgs);
}

export function loadAsnFile(path: string): AsnTable {
  const buf = readFileSync(path);
  return parseIp2AsnTsv((path.endsWith('.gz') ? gunzipSync(buf) : buf).toString('utf8'));
}

let current: AsnTable | null = null;

/** The table connects are tagged with, or null before one has loaded. */
export function currentAsnTable(): AsnTable | null {
  return current;
}

export function setAsnTable(t: AsnTable | null): void {
  current = t;
}

/**
 * Download a new table when the file on disk is missing or a week old.
 * 'fresh': nothing to do (the file is loaded if nothing is yet). 'failed':
 * the old file and the table in memory are kept.
 */
export async function refreshAsnTable(opts: {
  path: string; url?: string; fetchFn?: typeof fetch; now?: Date; maxAgeMs?: number; minRanges?: number;
}): Promise<'fresh' | 'downloaded' | 'failed'> {
  if (inflight) return inflight;
  inflight = refreshOnce(opts).finally(() => { inflight = null; });
  return inflight;
}

let inflight: Promise<'fresh' | 'downloaded' | 'failed'> | null = null;
/** A download that hangs is cut off, so it cannot hold the refresh guard forever. */
const FETCH_TIMEOUT_MS = 120_000;

async function refreshOnce(opts: {
  path: string; url?: string; fetchFn?: typeof fetch; now?: Date; maxAgeMs?: number; minRanges?: number;
}): Promise<'fresh' | 'downloaded' | 'failed'> {
  const now = opts.now ?? new Date();
  const maxAge = opts.maxAgeMs ?? ASN_MAX_AGE_MS;
  // A fresh file that does not load (zero bytes, bad gzip after a crash) is
  // not fresh: fall through to the download, which replaces it only if valid.
  try {
    if (existsSync(opts.path) && Math.max(0, now.getTime() - statSync(opts.path).mtimeMs) < maxAge) {
      if (!current) current = loadAsnFile(opts.path);
      return 'fresh';
    }
  } catch (err) {
    console.error('[asn] the table on disk is unusable, downloading a new one:', err);
  }
  try {
    const res = await (opts.fetchFn ?? fetch)(opts.url ?? IP2ASN_URL, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const gz = Buffer.from(await res.arrayBuffer());
    const table = parseIp2AsnTsv(gunzipSync(gz).toString('utf8'));
    if (table.size < (opts.minRanges ?? MIN_RANGES)) throw new Error(`only ${table.size} ranges`);
    const tmp = `${opts.path}.tmp`;
    writeFileSync(tmp, gz);
    renameSync(tmp, opts.path);
    current = table;
    return 'downloaded';
  } catch (err) {
    console.error('[asn] table refresh failed, keeping the one we have:', err);
    if (!current && existsSync(opts.path)) {
      try { current = loadAsnFile(opts.path); } catch (e) { console.error('[asn] the table on disk does not load either:', e); }
    }
    return 'failed';
  }
}

/**
 * Load the file on disk now, then (when `download`) refresh it at once and
 * check once a day, downloading when it is a week old. Returns a stop
 * function. The web process calls this from src/index.ts only, never from
 * buildServer, so tests never reach the network.
 */
export function startAsnRefresh(opts: { path: string; download: boolean }): () => void {
  if (existsSync(opts.path)) {
    try { current = loadAsnFile(opts.path); } catch (err) { console.error('[asn] could not load the table on disk:', err); }
  }
  if (!opts.download) return () => {};
  const tick = () => {
    refreshAsnTable({ path: opts.path }).catch((err) => console.error('[asn] refresh crashed:', err));
  };
  tick();
  const timer = setInterval(tick, 86_400_000);
  timer.unref();
  return () => clearInterval(timer);
}
