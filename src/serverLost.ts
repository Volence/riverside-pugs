import type { DB } from './db.js';
import { publishAdminEvent } from './adminFeed.js';
import { getServer, type ServerRow } from './serverPool.js';
import { campaignDisplayName } from './campaignRegistry.js';
import { ORPHAN_AFTER_MS, STALE_AFTER_MS } from './liveView.js';

/**
 * Tells staff, early and once, that a live match has lost its game server.
 *
 * Before this the only signal was the orphan reaper (liveView.ts), which
 * aborts a match ten minutes after its last heartbeat and posts one line
 * saying so. Match 554 (2026-10-07) shows the gap: srcds died with a
 * Sys_Error at 04:15:56, nobody on staff knew until players said so, and an
 * admin aborted it by hand at 04:23. Staff need to hear about it while there
 * is still a choice to make, and to hear what kind of loss it is.
 *
 * Once a live match (not a booking: bookings have their own crash recovery,
 * plan 5) has gone STALE_AFTER_MS without a heartbeat, its box is asked once:
 *
 *   restarted   rcon answers and pug-match does not hold this match: srcds
 *               crashed and systemd started it again, or someone restarted it.
 *               The match cannot come back by itself.
 *   logs_quiet  rcon answers and pug-match still holds this match live: the
 *               game is fine and its log lines are not reaching the site. The
 *               reaper will still abort it, so staff want to know now.
 *   no_rcon     rcon does not answer, the server browser does: the box is up
 *               but not talking to the site.
 *   down        neither answers: the box or srcds is down.
 *
 * Nothing is changed: no abort, no release, no restart. One admin 'problem'
 * event goes out (the bot posts it to the Discord admin channel). The alert is
 * remembered on the match row (matches.server_lost_alerted_at), so a web
 * restart never posts it twice. If heartbeats come back afterwards, one
 * "reporting again" line goes out and the match is armed again.
 */

export type LostVerdict =
  | { kind: 'restarted'; state: string | null }
  | { kind: 'logs_quiet' }
  | { kind: 'no_rcon'; players: number }
  | { kind: 'down' };

/** Reads pug-match's status block. Throws when rcon fails. */
export type StatusProbe = (server: ServerRow) => Promise<string>;
export type A2sProbe = (host: string, port: number) => Promise<{ players: number } | null>;

/**
 * What a `sm_pug_status` body says about match `matchId`. The first line is
 * `STATUS state=<none|pending|live|ended> match=<id> token=...`. The token is
 * on that line, so the body is parsed here and never logged.
 *
 * A body without a STATUS line (pug-match not loaded yet, or the console
 * buffer of a box that has only just booted) reads as restarted: a box whose
 * plugin is not answering does not hold the match either.
 */
export function classifyStatus(body: string, matchId: number): LostVerdict {
  const m = /^STATUS state=(\w+) match=(-?\d+)/m.exec(body);
  if (!m) return { kind: 'restarted', state: null };
  if (Number(m[2]) === matchId && m[1] === 'live') return { kind: 'logs_quiet' };
  return { kind: 'restarted', state: m[1] };
}

const sqlMs = (t: string): number => Date.parse(`${t.replace(' ', 'T')}Z`);

interface StaleRow {
  id: number;
  server_id: number;
  campaign: string;
  current_map: string | null;
  last_seen: string;
  maps_done: number;
}

export function lostText(o: {
  matchId: number; serverName: string; campaign: string; mapNo: number; mapName: string | null;
  silentS: number; reaperInS: number; verdict: LostVerdict;
}): string {
  const where = `Match #${o.matchId} (${o.campaign}, map ${o.mapNo}${o.mapName ? ` ${o.mapName}` : ''}) on ${o.serverName}`;
  const silent = `${Math.round(o.silentS / 60)} min`;
  const reaper = o.reaperInS > 0
    ? `If nobody acts, it is aborted as server lost in about ${Math.max(1, Math.round(o.reaperInS / 60))} min.`
    : 'It is due to be aborted as server lost now.';
  let what: string;
  switch (o.verdict.kind) {
    case 'restarted':
      what = `lost its server: no heartbeat for ${silent} and the server no longer holds the match`
        + `${o.verdict.state ? ` (pug-match state ${o.verdict.state})` : ' (pug-match not answering yet)'}, so srcds crashed or was restarted. The match cannot resume by itself.`;
      break;
    case 'logs_quiet':
      what = `has sent no heartbeat for ${silent}, but the server still holds it live: the game is probably fine and its log lines are not reaching the site.`;
      break;
    case 'no_rcon':
      what = `has sent no heartbeat for ${silent}; rcon does not answer but the server browser does (${o.verdict.players} players). The box is up but not talking to the site.`;
      break;
    case 'down':
      what = `lost its server: no heartbeat for ${silent}, and neither rcon nor the server browser answers. The box or srcds is down.`;
      break;
  }
  return `${where} ${what} Nothing was changed. ${reaper}`;
}

export class ServerLostWatch {
  private running = false;

  constructor(private deps: {
    db: DB;
    status: StatusProbe;
    a2s: A2sProbe;
    now?: () => number;
    staleMs?: number;
  }) {}

  private now(): number { return (this.deps.now ?? Date.now)(); }

  /** One pass: alert on newly stale matches, clear ones reporting again.
   *  Returns the match ids alerted on. Never throws. */
  async tick(): Promise<number[]> {
    if (this.running) return [];
    this.running = true;
    try {
      this.clearRecovered();
      const alerted: number[] = [];
      for (const r of this.stale()) {
        try {
          if (await this.check(r)) alerted.push(r.id);
        } catch (err) {
          console.error(`[serverLost] check of match ${r.id} failed:`, err instanceof Error ? err.message : err);
        }
      }
      return alerted;
    } catch (err) {
      console.error('[serverLost] pass failed:', err instanceof Error ? err.message : err);
      return [];
    } finally {
      this.running = false;
    }
  }

  private stale(): StaleRow[] {
    const cutoff = new Date(this.now() - (this.deps.staleMs ?? STALE_AFTER_MS)).toISOString().replace('T', ' ').slice(0, 19);
    // Same rows the orphan reaper will later take (a heartbeat row, gone
    // quiet), less bookings (their own recovery) and matches already alerted.
    return this.deps.db.prepare(
      `SELECT m.id, m.server_id, m.campaign, l.current_map, l.last_seen,
              (SELECT COUNT(*) FROM match_live_maps x WHERE x.match_id = m.id) AS maps_done
         FROM matches m JOIN match_live l ON l.match_id = m.id
        WHERE m.state = 'live' AND m.booking_id IS NULL AND m.server_id IS NOT NULL
          AND m.server_lost_alerted_at IS NULL AND l.last_seen < ?
        ORDER BY m.id`,
    ).all(cutoff) as StaleRow[];
  }

  private async probe(server: ServerRow, matchId: number): Promise<LostVerdict> {
    let body: string | null = null;
    try {
      body = await this.deps.status(server);
    } catch {
      body = null;
    }
    if (body !== null) return classifyStatus(body, matchId);
    let a2s: { players: number } | null = null;
    try {
      a2s = await this.deps.a2s(server.host, server.port);
    } catch {
      a2s = null;
    }
    return a2s ? { kind: 'no_rcon', players: a2s.players } : { kind: 'down' };
  }

  private async check(r: StaleRow): Promise<boolean> {
    const db = this.deps.db;
    const server = getServer(db, r.server_id);
    if (!server) return false;
    const verdict = await this.probe(server, r.id);
    // Claimed after the probe, and only while the match is still live and
    // still quiet: a heartbeat or an abort that landed during the probe
    // means there is nothing to say.
    const nowIso = new Date(this.now()).toISOString().replace('T', ' ').slice(0, 19);
    const claimed = db.prepare(
      `UPDATE matches SET server_lost_alerted_at = ?
        WHERE id = ? AND state = 'live' AND server_lost_alerted_at IS NULL
          AND (SELECT last_seen FROM match_live WHERE match_id = ?) = ?`,
    ).run(nowIso, r.id, r.id, r.last_seen).changes > 0;
    if (!claimed) return false;
    const lastMs = sqlMs(r.last_seen);
    const silentS = (this.now() - lastMs) / 1000;
    const reaperInS = (lastMs + ORPHAN_AFTER_MS - this.now()) / 1000;
    const text = lostText({
      matchId: r.id, serverName: server.name, campaign: campaignDisplayName(db, r.campaign),
      mapNo: r.maps_done + 1, mapName: r.current_map, silentS, reaperInS, verdict,
    });
    console.warn(`[serverLost] match ${r.id} on ${server.name}: ${verdict.kind}`);
    publishAdminEvent({ kind: 'problem', matchId: r.id, text, link: { label: 'Live board', path: `/admin/live?live=${r.id}` } });
    return true;
  }

  /** Heartbeats came back after an alert: say so once and arm the match again. */
  private clearRecovered(): void {
    const db = this.deps.db;
    const rows = db.prepare(
      `SELECT m.id, s.name AS server_name FROM matches m JOIN match_live l ON l.match_id = m.id
         LEFT JOIN servers s ON s.id = m.server_id
        WHERE m.state = 'live' AND m.server_lost_alerted_at IS NOT NULL AND l.last_seen > m.server_lost_alerted_at`,
    ).all() as { id: number; server_name: string | null }[];
    for (const r of rows) {
      const done = db.prepare('UPDATE matches SET server_lost_alerted_at = NULL WHERE id = ? AND server_lost_alerted_at IS NOT NULL').run(r.id).changes > 0;
      if (!done) continue;
      publishAdminEvent({
        kind: 'problem', matchId: r.id,
        text: `Match #${r.id}${r.server_name ? ` on ${r.server_name}` : ''} is reporting again (heartbeats are back). Ignore the earlier server-lost alert.`,
        link: { label: 'Live board', path: `/admin/live?live=${r.id}` },
      });
    }
  }
}
