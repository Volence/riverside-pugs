import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DB } from './db.js';
import { listServers, type ServerRow } from './serverPool.js';
import { transportFor } from './addonsTransport.js';
import { steam64ToSteam2 } from './steamId.js';
import { getSetting } from './settings.js';
import { publishAdminEvent, subscribeAdminEvents, type AdminEvent } from './adminFeed.js';
import type { ServerExec } from './serverBans.js';
import { subscribeBanChanges } from './banEvents.js';

/**
 * Gives every website admin the same admin rights on every enabled game box.
 *
 * The same replica model as ServerBanSync next door: the website is the source
 * of truth, the boxes converge, and a sweep re-pushes unconditionally so a box
 * that was offline or rebuilt heals by itself. What differs is the mechanism.
 * Bans have a console command (`sm_addban`); admins do not. SourceMod's
 * flatfile backend reads its admin list from disk at load and on
 * `sm_reloadadmins`, so this writes a file and then asks for the reload.
 *
 * It writes `admins.cfg` and NEVER `admins_simple.ini`, which is the whole
 * trick. `admin-flatfile.smx` reads BOTH, so owning one of them leaves the
 * other alone: the hand-maintained entries in admins_simple.ini (on Dallas, 5
 * people, 3 of whom are not website admins) keep working untouched, and this
 * file is ours to overwrite wholesale with no merge logic to get wrong. Before
 * this existed admins.cfg held nothing but its shipped comments and an empty
 * `Admins { }`.
 *
 * The file goes over the same per-box transport that installs campaign VPKs
 * (local copy on Dallas, FTP to Chicago, scp to the two Riverside instances),
 * pointed at `<addons>/sourcemod/configs` instead of `<addons>`. That is why
 * there is no new way to reach a box here, and why a box with no configured
 * transport is reported rather than silently skipped.
 */

/** How often the unconditional repair pass runs. Slower than the ban sweep:
 *  admin changes are rare, and each pass is a file transfer rather than a
 *  console command. */
export const SWEEP_MS = 15 * 60 * 1000;
const REPORT_EVERY_MS = 60 * 60 * 1000;

/** SourceMod flag letters granted to a website admin. `z` is root, which is
 *  what the hand-maintained entries on the box already carry, so a website
 *  admin and a legacy admin are the same thing rather than two tiers nobody
 *  can keep straight (owner, 2026-09-21). A setting, not a constant, so it can
 *  be narrowed without a deploy. */
export const DEFAULT_ADMIN_FLAGS = 'z';
const FLAGS_RE = /^[a-z]{1,26}$/;

export function adminFlags(db: DB): string {
  const v = (getSetting(db, 'server_admin_flags') ?? '').trim();
  return FLAGS_RE.test(v) ? v : DEFAULT_ADMIN_FLAGS;
}

/** KeyValues has no escape for a quote, so a name carrying one would end the
 *  string and shift every key after it. Names are Steam personas, which is to
 *  say arbitrary. Only the display name is affected; identity and flags are
 *  ours. */
function kvSafe(name: string): string {
  return name.replace(/["\r\n{}]/g, ' ').trim().slice(0, 60) || 'admin';
}

export interface AdminRow { steamid: string; name: string | null }

/**
 * Who gets admin on the boxes: website admins who are not banned.
 *
 * It was every row with is_admin = 1, so a banned admin kept SourceMod root
 * on all four servers until somebody remembered to take the flag off by hand.
 * The bans table is asked as well as the cached status, because status is
 * only a consequence of it (see src/banState.ts). The ban itself is pushed to
 * the boxes by ServerBanSync; this is about the rights, which would otherwise
 * be waiting for them the moment the ban ended or was worked around.
 */
export function websiteAdmins(db: DB, now = new Date()): AdminRow[] {
  return db.prepare(
    `SELECT p.steamid, p.name FROM players p
     WHERE p.is_admin = 1 AND p.status != 'banned'
       AND NOT EXISTS (SELECT 1 FROM bans b WHERE b.player_id = p.steamid
                       AND b.lifted_at IS NULL AND (b.expires_at IS NULL OR b.expires_at > ?))
     ORDER BY p.steamid`,
  ).all(now.toISOString()) as AdminRow[];
}

/**
 * The whole `admins.cfg`, rendered from the website's admin list.
 *
 * ONE block per admin, and the universe digit in the identity does not
 * matter. The hand-maintained admins_simple.ini on the box lists every admin
 * twice, once as STEAM_0 and once as STEAM_1, which looks like it is hedging
 * against SourceMod comparing the identity literally against whatever
 * GetClientAuthId returns. It is not needed: verified on the local test
 * server 2026-09-21 by rendering this file, running sm_reloadadmins and
 * dumping the parsed cache with sm_dump_admcache, which stores every identity
 * with the `STEAM_X:` prefix stripped ("1:35074132") and collapses the two
 * spellings into a single admin. Matching normalises the same way on both
 * sides, so one block is enough and two would only be the same entry twice.
 */
export function renderAdminsCfg(db: DB): string {
  const flags = adminFlags(db);
  const lines: string[] = [
    '// Generated by the Riverside PUG website. Do not edit by hand:',
    '// every sync overwrites this file in full.',
    '//',
    '// Hand-maintained admins belong in admins_simple.ini, which SourceMod',
    '// also reads and which this never touches.',
    '',
    'Admins',
    '{',
  ];
  for (const a of websiteAdmins(db)) {
    lines.push(
      `\t"${kvSafe(a.name ?? a.steamid)}"`,
      '\t{',
      '\t\t"auth"\t\t"steam"',
      `\t\t"identity"\t"${steam64ToSteam2(a.steamid)}"`,
      `\t\t"flags"\t\t"${flags}"`,
      '\t}',
    );
  }
  lines.push('}', '');
  return lines.join('\n');
}

export interface SyncResult {
  serverId: number;
  server: string;
  ok: boolean;
  error?: string;
}

/** Where admins.cfg lives on a box, or null when the box has no addons
 *  directory configured and so cannot be reached at all. */
function configsDir(server: ServerRow): string | null {
  const dir = (server as ServerRow & { addons_dir?: string | null }).addons_dir;
  return dir ? `${dir.replace(/\/+$/, '')}/sourcemod/configs` : null;
}

export class ServerAdminSync {
  private timer: ReturnType<typeof setInterval> | null = null;
  private unsubscribe: (() => void) | null = null;
  private unsubscribeBans: (() => void) | null = null;
  private lastReported = new Map<number, number>();
  /** One sync at a time. The sweep, a boot push and an admin toggle can all
   *  land together, and two transports writing admins.cfg at once on the same
   *  box is the one way to leave a half-written file behind. */
  private chain: Promise<SyncResult[]> = Promise.resolve([]);

  constructor(private deps: {
    db: DB;
    exec: ServerExec;
    /** Injected so tests never touch a filesystem or a network. */
    transport?: typeof transportFor;
    now?: () => number;
  }) {}

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  /** Push the current admin list to every enabled box. Never rejects: a dead
   *  box is out of date until the next sweep, and that must not stop the
   *  others or fail the admin action that triggered this. */
  sync(): Promise<SyncResult[]> {
    this.chain = this.chain.then(() => this.run()).catch((err) => {
      console.error('[serverAdmins] sync failed:', err);
      return [];
    });
    return this.chain;
  }

  private async run(): Promise<SyncResult[]> {
    const body = renderAdminsCfg(this.deps.db);
    const servers = listServers(this.deps.db).filter((s) => s.enabled === 1);
    if (servers.length === 0) return [];
    // One temp file for the whole pass: every box gets identical bytes, and
    // the transports all take a local path.
    const dir = await mkdtemp(join(tmpdir(), 'pug-admins-'));
    const local = join(dir, 'admins.cfg');
    try {
      await writeFile(local, body, 'utf8');
      return await Promise.all(servers.map((s) => this.pushOne(s, local)));
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  }

  private async pushOne(server: ServerRow, local: string): Promise<SyncResult> {
    const base = { serverId: server.id, server: server.name };
    const dir = configsDir(server);
    const transport = dir ? (this.deps.transport ?? transportFor)(server, dir) : null;
    if (!transport) {
      const error = 'no addons transport configured, so its admin list cannot be written';
      this.report(server, error);
      return { ...base, ok: false, error };
    }
    try {
      await transport.put(local, 'admins.cfg');
      // The file on disk changes nothing until SourceMod re-reads it.
      await this.deps.exec(server, ['sm_reloadadmins']);
      return { ...base, ok: true };
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      console.error(`[serverAdmins] push to ${server.name} failed:`, err);
      this.report(server, error);
      return { ...base, ok: false, error };
    }
  }

  private report(server: ServerRow, error: string): void {
    const last = this.lastReported.get(server.id) ?? 0;
    if (this.now() - last < REPORT_EVERY_MS) return;
    this.lastReported.set(server.id, this.now());
    publishAdminEvent({
      kind: 'problem',
      text: `Could not update the admin list on ${server.name}: ${error}. `
        + `Website admins may not have admin there; it is retried every ${SWEEP_MS / 60_000} minutes.`,
    });
  }

  /** Whether an admin-feed event means the admin list just changed. */
  static affects(e: AdminEvent): boolean {
    return e.kind === 'admin_action' && e.action === 'set_admin';
  }

  start(): void {
    if (this.timer) return;
    // Reuses the existing admin-action bus rather than adding a third
    // publisher: logAdmin already announces set_admin to it.
    this.unsubscribe = subscribeAdminEvents((e) => {
      if (ServerAdminSync.affects(e)) void this.sync();
    });
    // A ban or an unban of an admin changes the list too, and waiting for the
    // sweep would leave a banned admin with root for up to fifteen minutes.
    // Only for an admin: most bans are abandon bans on ordinary players, and
    // each sync is a file transfer to every box.
    this.unsubscribeBans = subscribeBanChanges((e) => {
      const row = this.deps.db.prepare('SELECT is_admin FROM players WHERE steamid = ?')
        .get(e.steamid) as { is_admin: number } | undefined;
      if (row?.is_admin === 1) void this.sync();
    });
    this.timer = setInterval(() => void this.sync(), SWEEP_MS);
    this.timer.unref();
  }

  stop(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.unsubscribeBans?.();
    this.unsubscribeBans = null;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
