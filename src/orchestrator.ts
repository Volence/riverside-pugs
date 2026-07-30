import type { DB } from './db.js';
import type { RconClient, RconOpts } from './rcon.js';
import { RconClient as RealRcon } from './rcon.js';
import type { LogListener } from './logListener.js';
import { newToken } from './matchToken.js';
import { parseDump, type Dump } from './dumpParse.js';
import { claimIdle, release, markLive, getServer, type ServerRow } from './serverPool.js';

/** Sub-project 2b's SourcePawn plugin is the server-side counterpart. */
export interface Orchestrator {
  setupMatch(matchId: number): Promise<void>;
  finishMatch(matchId: number): Promise<void>;
}

/** Stub used in dev mode — no real server contact. */
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
  /** Injectable opts transform so tests can redirect the connection; production leaves opts untouched. */
  makeRcon?: (opts: RconOpts) => RconOpts;
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
  private makeRcon: (opts: RconOpts) => RconOpts;

  constructor(deps: RealOrchestratorDeps) {
    this.db = deps.db;
    this.listener = deps.listener;
    this.logPublicAddress = deps.logPublicAddress;
    this.makeRcon = deps.makeRcon ?? ((o) => o);
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
      release(this.db, server.id);
      return;
    }
    const roster = this.db
      .prepare('SELECT player_id, team FROM match_players WHERE match_id = ?')
      .all(matchId) as { player_id: string; team: 'a' | 'b' }[];

    const token = newToken();
    this.db.prepare('UPDATE matches SET server_id = ?, token = ? WHERE id = ?').run(server.id, token, matchId);
    this.listener.register(token);

    let rcon: RconClient | null = null;
    try {
      rcon = await this.connectRcon(server);
      await rcon.exec(`logaddress_add ${this.logPublicAddress}`);
      await rcon.exec('exec pug_match');
      await rcon.exec(`sv_password "pug_${token.slice(0, 8)}"`);
      await rcon.exec(`sm_pug_match ${matchId} ${token} ${match.campaign}`);
      for (const r of roster) await rcon.exec(`sm_pug_roster ${r.player_id}:${r.team}`);
      await rcon.exec(`changelevel ${firstMapOf(match.campaign)}`);
      markLive(this.db, server.id);
      this.db.prepare("UPDATE matches SET state = 'live' WHERE id = ?").run(matchId);
    } catch (err) {
      console.error(`[orchestrator] setup failed for match ${matchId}:`, err);
      this.listener.unregister(token);
      release(this.db, server.id);
      this.db.prepare("UPDATE matches SET state = 'aborted' WHERE id = ?").run(matchId);
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
    try {
      rcon = await this.connectRcon(server);
      const body = await rcon.exec(`sm_pug_dump ${match.token}`);
      const dump = parseDump(body);
      if (!dump) {
        console.error(`[orchestrator] unparseable dump for match ${matchId}; leaving live for retry`);
        return;
      }
      if (dump.matchId !== matchId) {
        console.error(`[orchestrator] dump match id ${dump.matchId} != expected ${matchId}; leaving live for retry`);
        return;
      }
      this.persist(matchId, dump);
      persisted = true;
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
      this.listener.unregister(match.token);
      release(this.db, match.server_id);
    }
  }

  private persist(matchId: number, d: Dump): void {
    this.db.transaction(() => {
      this.db
        .prepare("UPDATE matches SET state = 'completed', team_a_score = ?, team_b_score = ?, winner = ?, ended_at = datetime('now') WHERE id = ?")
        .run(d.totalA, d.totalB, d.winner, matchId);
      const upd = this.db.prepare(
        `UPDATE match_players SET si_damage = ?, si_kills = ?, common_kills = ?, ff_dealt = ?, revives = ?, stats_json = ?
         WHERE match_id = ? AND player_id = ?`,
      );
      for (const p of d.players) {
        upd.run(p.sidmg, p.sikill, p.ck, p.ff, p.rev,
          JSON.stringify({ sidmg: String(p.sidmg), sikill: String(p.sikill), ck: String(p.ck), ff: String(p.ff), rev: String(p.rev) }),
          matchId, p.steamid);
      }
    })();
  }
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
