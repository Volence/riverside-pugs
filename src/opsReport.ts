import { createHmac, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { publishAdminEvent } from './adminFeed.js';

/**
 * Reports from the game boxes' own ops scripts, posted to the admin feed.
 *
 * The first (and so far only) sender is the SourceMod error-log watcher in
 * the deploy repo (ops/l4d-logwatch.py): a new error signature, or an error
 * flood, on one of the pool servers. Before it, floods (275 lines/s on
 * 2026-09-28) were found by hand days later.
 *
 * Not a game log line: those come over UDP from srcds and are signed by a
 * plugin, which a shell-side script on the box cannot do. This is HTTPS (or
 * localhost on Dallas), with one shared secret, OPS_REPORT_SECRET, in the
 * site's .env and in /etc/l4d-logwatch.env on each box. The request is
 *
 *     { "ts": <unix seconds>, "payload": "<JSON text>", "mac": "<hex>" }
 *
 * where mac is HMAC-SHA256(secret, `${ts}.${payload}`). The payload travels
 * as text so the MAC covers exactly the bytes the box signed. A request older
 * or newer than five minutes, or one whose MAC was already taken, is refused.
 *
 * The site builds the message itself from a few bounded fields. A broken
 * watcher can cost at most RATE_PER_HOUR posts an hour.
 */

export const MAX_SKEW_S = 300;
export const RATE_PER_HOUR = 30;
const MAX_ITEMS = 5;

export interface ErrorItem { plugin?: string; text: string; where?: string; count?: number }
export interface OpsPayload {
  server: string;
  kind: 'sm_errors';
  file?: string;
  flood?: { lines: number; seconds: number } | null;
  fresh?: ErrorItem[];
  top?: ErrorItem[];
}

export function opsMac(secret: string, ts: number, payload: string): string {
  return createHmac('sha256', secret).update(`${ts}.${payload}`).digest('hex');
}

/** Text a Discord embed shows close to as typed: no markdown links, code
 *  spans, emphasis or spoilers, no control characters, bounded length.
 *  Underscores stay (plugin names are full of them; Discord does not
 *  emphasise inside a word), and mentions never ping: the transport sends
 *  every post with allowedMentions parse []. */
export function clean(s: unknown, max: number): string {
  const t = String(s ?? '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/[[<]/g, '(').replace(/[\]>]/g, ')')
    .replace(/[`*~|]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return t.length > max ? `${t.slice(0, max - 3)}...` : t;
}

export function parsePayload(text: string): OpsPayload | null {
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    return null;
  }
  if (!v || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  if (o.kind !== 'sm_errors') return null;
  if (typeof o.server !== 'string' || !/^[A-Za-z0-9 #._-]{1,40}$/.test(o.server)) return null;
  const items = (x: unknown): ErrorItem[] => (Array.isArray(x) ? x : [])
    .filter((i): i is Record<string, unknown> => !!i && typeof i === 'object' && typeof (i as { text?: unknown }).text === 'string')
    .slice(0, MAX_ITEMS)
    .map((i) => ({
      plugin: typeof i.plugin === 'string' ? i.plugin : undefined,
      text: i.text as string,
      where: typeof i.where === 'string' ? i.where : undefined,
      count: Number.isFinite(i.count) ? Math.max(0, Math.floor(i.count as number)) : undefined,
    }));
  const f = o.flood as { lines?: unknown; seconds?: unknown } | null | undefined;
  const flood = f && Number.isFinite(f.lines) && Number.isFinite(f.seconds) && (f.seconds as number) > 0
    ? { lines: Math.floor(f.lines as number), seconds: Math.floor(f.seconds as number) } : null;
  const fresh = items(o.fresh);
  const top = items(o.top);
  if (!flood && fresh.length === 0) return null;
  return { server: o.server, kind: 'sm_errors', file: typeof o.file === 'string' ? o.file : undefined, flood, fresh, top };
}

function itemLine(i: ErrorItem): string {
  const plugin = i.plugin ? `${clean(i.plugin, 60)}: ` : '';
  const where = i.where ? ` (${clean(i.where, 80)})` : '';
  const count = i.count && i.count > 1 ? ` x${i.count.toLocaleString('en-US')}` : '';
  return `${plugin}${clean(i.text, 160)}${where}${count}`;
}

export function opsReportText(p: OpsPayload): string {
  const file = p.file ? ` (${clean(p.file, 40)})` : '';
  const parts: string[] = [];
  if (p.flood) {
    const mins = Math.max(1, Math.round(p.flood.seconds / 60));
    parts.push(`${p.server}: SourceMod error flood, ${p.flood.lines.toLocaleString('en-US')} error log lines in ${mins} min${file}.`);
    const top = p.top ?? [];
    if (top.length) parts.push(`Top: ${top.map(itemLine).join('; ')}.`);
  }
  const fresh = p.fresh ?? [];
  if (fresh.length) {
    const head = p.flood ? 'New' : `${p.server}: new SourceMod error${fresh.length === 1 ? '' : 's'}${file}:`;
    parts.push(`${head} ${fresh.map(itemLine).join('; ')}.`);
  }
  const text = parts.join(' ');
  return text.length > 1500 ? `${text.slice(0, 1497)}...` : text;
}

export async function opsReportRoutes(
  app: FastifyInstance,
  opts: { secret: string | null; now?: () => number },
): Promise<void> {
  const now = opts.now ?? Date.now;
  const seen = new Map<string, number>();
  const accepted: number[] = [];
  let lastRateWarn = 0;

  app.post('/api/ops/report', { bodyLimit: 64 * 1024 }, async (req, reply) => {
    if (!opts.secret) return reply.code(404).send({ error: 'not configured' });
    const b = req.body as { ts?: unknown; payload?: unknown; mac?: unknown } | null;
    if (!b || typeof b.ts !== 'number' || typeof b.payload !== 'string' || typeof b.mac !== 'string' || !/^[0-9a-f]{64}$/.test(b.mac)) {
      return reply.code(400).send({ error: 'bad request' });
    }
    const nowMs = now();
    if (Math.abs(nowMs / 1000 - b.ts) > MAX_SKEW_S) return reply.code(401).send({ error: 'stale' });
    const want = Buffer.from(opsMac(opts.secret, b.ts, b.payload), 'hex');
    if (!timingSafeEqual(want, Buffer.from(b.mac, 'hex'))) return reply.code(401).send({ error: 'bad mac' });
    for (const [mac, at] of seen) if (nowMs - at > MAX_SKEW_S * 2000) seen.delete(mac);
    if (seen.has(b.mac)) return reply.code(409).send({ error: 'replay' });
    seen.set(b.mac, nowMs);
    const p = parsePayload(b.payload);
    if (!p) return reply.code(400).send({ error: 'bad payload' });
    while (accepted.length && nowMs - accepted[0] > 3_600_000) accepted.shift();
    if (accepted.length >= RATE_PER_HOUR) {
      if (nowMs - lastRateWarn > 3_600_000) {
        lastRateWarn = nowMs;
        console.warn(`[opsReport] over ${RATE_PER_HOUR} reports in an hour; dropping until it slows (last from ${p.server})`);
      }
      return reply.code(429).send({ error: 'rate' });
    }
    accepted.push(nowMs);
    console.log(`[opsReport] ${p.server}: ${p.flood ? 'flood' : ''}${p.flood && p.fresh?.length ? ' + ' : ''}${p.fresh?.length ? `${p.fresh.length} new` : ''}`);
    publishAdminEvent({ kind: 'problem', text: opsReportText(p) });
    return reply.send({ ok: true });
  });
}
