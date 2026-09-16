import type { DB } from './db.js';
import type { RconClient, RconOpts } from './rcon.js';
import { RconClient as RealRcon } from './rcon.js';
import type { LogListener } from './logListener.js';
import { newToken } from './matchToken.js';
import { parseDump, type Dump } from './dumpParse.js';
import { claimIdle, markLive, getServer, type ServerRow } from './serverPool.js';
import type { ServerReleaser } from './serverRelease.js';
import { completeMatch } from './matchResult.js';
import { recordMatchDemos } from './demos.js';
import { recordMatchReplays } from './replays.js';
import { clearLive } from './liveView.js';
import { CAMPAIGNS } from './campaigns.js';

/** Sub-project 2b's SourcePawn plugin is the server-side counterpart. */
export interface Orchestrator {
  setupMatch(matchId: number): Promise<void>;
  finishMatch(matchId: number): Promise<void>;
}

/** Stub used in dev mode. Makes no real server contact. */
export class DevOrchestrator implements Orchestrator {
  async setupMatch(matchId: number): Promise<void> {
    console.log(`[orchestrator-stub] match ${matchId} created; real orchestration is sub-project 2`);
  }
  async finishMatch(matchId: number): Promise<void> {
    console.log(`[orchestrator-stub] finishMatch ${matchId} no-op`);
  }
}

export interface RealOrchestratorDeps {
  db: DB;
  listener: LogListener;
  logPublicAddress: string;
  /** The single chokepoint for freeing a server, so sv_password always gets
   *  cleared. Required, not optional: an optional dep would silently skip
   *  the clear, which is the bug this exists to fix. */
  releaser: ServerReleaser;
  /** Injectable opts transform so tests can redirect the connection; production leaves opts untouched. */
  makeRcon?: (opts: RconOpts) => RconOpts;
  notify?: (msg: string) => void;
  /** Where srcds writes demos. Empty disables demo recording on the site. */
  demoDir?: string;
  /** Where the plugin writes replay files. Empty disables replay recording on
   *  the site, the same convention as demoDir. */
  replayDir?: string;
}

interface MatchRow {
  id: number;
  state: string;
  campaign: string;
  server_id: number | null;
  token: string | null;
}

export class RealOrchestrator implements Orchestrator {
  private db: DB;
  private listener: LogListener;
  private logPublicAddress: string;
  private releaser: ServerReleaser;
  private makeRcon: (opts: RconOpts) => RconOpts;
  private notify: (msg: string) => void;
  private demoDir: string;
  private replayDir: string;

  constructor(deps: RealOrchestratorDeps) {
    this.db = deps.db;
    this.listener = deps.listener;
    this.logPublicAddress = deps.logPublicAddress;
    this.releaser = deps.releaser;
    this.makeRcon = deps.makeRcon ?? ((o) => o);
    this.notify = deps.notify ?? (() => {});
    this.demoDir = deps.demoDir ?? '';
    this.replayDir = deps.replayDir ?? '';
  }

  private async connectRcon(server: ServerRow): Promise<RconClient> {
    const opts = this.makeRcon({ host: server.host, port: server.rcon_port, password: server.rcon_password });
    const client = new RealRcon(opts);
    await client.connect();
    return client;
  }

  async setupMatch(matchId: number): Promise<void> {
    const server = claimIdle(this.db);
    if (!server) {
      this.db.prepare("UPDATE matches SET state = 'aborted' WHERE id = ?").run(matchId);
      console.error(`[orchestrator] no idle server for match ${matchId}; aborted`);
      return;
    }

    const match = this.db.prepare('SELECT id, campaign FROM matches WHERE id = ?').get(matchId) as
      | { id: number; campaign: string }
      | undefined;
    if (!match) {
      this.releaser.release(server.id);
      return;
    }
    const roster = this.db
      .prepare('SELECT player_id, team FROM match_players WHERE match_id = ?')
      .all(matchId) as { player_id: string; team: 'a' | 'b' }[];

    const token = newToken();
    this.db.prepare('UPDATE matches SET server_id = ?, token = ? WHERE id = ?').run(server.id, token, matchId);
    this.listener.register(token);

    let rcon: RconClient | null = null;
    let live = false;
    try {
      rcon = await this.connectRcon(server);
      await rcon.exec(`logaddress_add ${this.logPublicAddress}`);
      await rcon.exec('exec pug_match');
      await rcon.exec(`sv_password "pug_${token.slice(0, 8)}"`);
      await expectPugOk(rcon, `sm_pug_match ${matchId} ${token} ${match.campaign}`);
      // The steamid:team arg MUST be quoted: Source's console tokenizer splits
      // unquoted args on ':', so the plugin would receive a bare steamid, reject
      // the line, and then kick every player as non-rostered. Verified on the
      // live box 2026-08-29. The fake RCON server in tests does not tokenize.
      for (const r of roster) await expectPugOk(rcon, `sm_pug_roster "${r.player_id}:${r.team}"`);
      await rcon.exec(`changelevel ${firstMapOf(match.campaign)}`);
      markLive(this.db, server.id);
      this.db.prepare("UPDATE matches SET state = 'live', went_live_at = datetime('now') WHERE id = ?")
        .run(matchId);
      live = true;
    } catch (err) {
      console.error(`[orchestrator] setup failed for match ${matchId}:`, err);
      this.listener.unregister(token);
      this.releaser.release(server.id);
      this.db.prepare("UPDATE matches SET state = 'aborted' WHERE id = ?").run(matchId);
    } finally {
      rcon?.close();
    }

    if (live) {
      this.notify(`🎮 Match #${matchId} is live: ${CAMPAIGNS[match.campaign]?.name ?? match.campaign} on ${server.name}`);
    }
  }

  /** Tell the plugin the match id we allocated for a match it started itself
   *  with !load_4v4p. Public because SelfStartedMatches needs rcon and this
   *  class already owns how to reach a server. Throws on failure; the caller
   *  decides whether that is fatal (it is not: the match row still exists). */
  async assignMatchId(serverId: number, token: string, matchId: number): Promise<void> {
    const server = getServer(this.db, serverId);
    if (!server) throw new Error(`assignMatchId: no server row ${serverId}`);
    let rcon: RconClient | null = null;
    try {
      rcon = await this.connectRcon(server);
      await expectPugOk(rcon, `sm_pug_setid ${token} ${matchId}`);
    } finally {
      rcon?.close();
    }
  }

  async finishMatch(matchId: number): Promise<void> {
    const match = this.db
      .prepare('SELECT id, state, campaign, server_id, token FROM matches WHERE id = ?')
      .get(matchId) as MatchRow | undefined;
    if (!match || match.state !== 'live' || match.server_id === null || match.token === null) return;
    const server = getServer(this.db, match.server_id);
    if (!server) return;

    let rcon: RconClient | null = null;
    let persisted = false;
    let dump: Dump | null = null;
    try {
      rcon = await this.connectRcon(server);
      const body = await rcon.exec(`sm_pug_dump ${match.token}`);
      dump = parseDump(body);
      if (!dump) {
        console.error(`[orchestrator] unparseable dump for match ${matchId}; leaving live for retry`);
        return;
      }
      if (dump.matchId !== matchId) {
        console.error(`[orchestrator] dump match id ${dump.matchId} != expected ${matchId}; leaving live for retry`);
        return;
      }
      persisted = completeMatch(this.db, matchId, dump);
      if (!persisted) {
        console.error(`[orchestrator] match ${matchId} was not completable (state changed?); skipping`);
        return;
      }
      try {
        await rcon.exec(`sm_pug_abort ${match.token}`);
      } catch (abortErr) {
        console.error(`[orchestrator] sm_pug_abort failed for match ${matchId} (non-fatal):`, abortErr);
      }
    } catch (err) {
      console.error(`[orchestrator] finish failed for match ${matchId}:`, err);
    } finally {
      rcon?.close();
    }

    if (persisted) {
      // After completion, never before: the demo for the last map is still
      // being written until the match ends. Wrapped because a match result is
      // not allowed to fail over a download link.
      try {
        const n = recordMatchDemos(this.db, matchId, match.token, this.demoDir);
        if (n > 0) console.log(`[orchestrator] recorded ${n} demo(s) for match ${matchId}`);
      } catch (err) {
        console.error(`[orchestrator] demo scan failed for match ${matchId} (non-fatal):`, err);
      }
      // Same discipline as the demo scan above: after completion, never
      // before, and wrapped because a match result is not allowed to fail over
      // a replay link. excludeOpen is off here: every round has ended, so a
      // file still showing no frame count is a crash worth recording rather
      // than an unfinished write.
      try {
        const rn = recordMatchReplays(this.db, matchId, match.token, this.replayDir);
        if (rn > 0) console.log(`[orchestrator] recorded ${rn} replay(s) for match ${matchId}`);
      } catch (err) {
        console.error(`[orchestrator] replay scan failed for match ${matchId} (non-fatal):`, err);
      }
      // The match is no longer live, so the spectator scratch rows are done.
      // The authoritative match_maps rows were just written by completeMatch.
      clearLive(this.db, matchId);
      this.listener.unregister(match.token);
      this.releaser.release(match.server_id);
      if (dump) {
        const winnerText = dump.winner === 'draw' ? 'Draw' : dump.winner === 'a' ? 'Team A wins' : 'Team B wins';
        this.notify(`🏁 Match #${matchId} final: Team A ${dump.totalA}, Team B ${dump.totalB}. ${winnerText}!`);
      }
    }
  }
}

/** Run a pug-match server command and require it to answer PUGOK. The plugin
 *  reports refusals as `PUGERR ...` on stdout rather than failing the RCON call,
 *  so without this check a malformed match/roster setup looks like success and
 *  only surfaces in-game as every player being kicked. */
async function expectPugOk(rcon: RconClient, cmd: string): Promise<string> {
  const res = await rcon.exec(cmd);
  if (!res.includes('PUGOK')) throw new Error(`${cmd.split(' ')[0]} rejected: ${res.trim() || '(no response)'}`);
  return res;
}

/** First playable map of a campaign. Full per-campaign map lists live in the plugin;
 *  the backend only needs the entry map to changelevel into. */
function firstMapOf(campaign: string): string {
  const FIRST: Record<string, string> = {
    no_mercy: 'l4d_hospital01_apartment',
    death_toll: 'l4d_smalltown01_caves',
    dead_air: 'l4d_airport01_greenhouse',
    blood_harvest: 'l4d_farm01_hilltop',
  };
  return FIRST[campaign] ?? 'l4d_hospital01_apartment';
}
