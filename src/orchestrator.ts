import { randomBytes } from 'node:crypto';
import { statusShowsAbandoner } from './abandon.js';
import { publishAdminEvent } from './adminFeed.js';
import { getSetting } from './settings.js';
import type { DB } from './db.js';
import type { RconClient, RconOpts } from './rcon.js';
import { RconClient as RealRcon } from './rcon.js';
import type { LogListener } from './logListener.js';
import { newToken, serverPasswordFor } from './matchToken.js';
import { parseDump, type Dump } from './dumpParse.js';
import { claimIdle, markLive, getServer, type ServerRow } from './serverPool.js';
import type { ServerReleaser } from './serverRelease.js';
import { completeMatch } from './matchResult.js';
import { recordMatchDemos } from './demos.js';
import { recordMatchReplays } from './replays.js';
import { clearLive } from './matchArchive.js';
import { CAMPAIGNS, isMapName } from './campaigns.js';
import { campaignDisplayName, campaignRegistry, firstMapOf } from './campaignRegistry.js';
import { isInstalledEverywhere } from './campaignInstall.js';
import { stopAfterMap } from './stopPoint.js';

/** What one attempt to collect a match came to.
 *   completed  persisted, rated and released.
 *   retry      nothing usable came back (rcon down, mangled or foreign dump);
 *              the match is still live and worth asking again.
 *   not_ended  the plugin answered, authenticated, and says the match is NOT
 *              over. Asking again will not change that, and the give-up path
 *              behind the retries aborts the match and releases its box, so
 *              the caller must stop here rather than count this as a failure.
 *   skipped    nothing to do: no such match, or it is not live. */
export type FinishOutcome = 'completed' | 'retry' | 'not_ended' | 'skipped';

/** Sub-project 2b's SourcePawn plugin is the server-side counterpart. */
export interface Orchestrator {
  setupMatch(matchId: number): Promise<void>;
  finishMatch(matchId: number): Promise<FinishOutcome | void>;
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
  /** Called when setupMatch finds no idle server. The match stays 'configuring'
   *  rather than aborting; the pending list is what retries it once one frees. */
  onNoServer?: (matchId: number) => void;
  /** Run on the setup connection once the match is configured and before the
   *  changelevel: anything the box must have before players can join. Today
   *  that is the ban list (ServerBanSync.pushAll). Wrapped by the caller; a
   *  failure here is logged and never costs the match its server. */
  beforeLive?: (rcon: RconClient) => Promise<void>;
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
  onNoServer?: (matchId: number) => void;
  private beforeLive?: (rcon: RconClient) => Promise<void>;

  constructor(deps: RealOrchestratorDeps) {
    this.db = deps.db;
    this.listener = deps.listener;
    this.logPublicAddress = deps.logPublicAddress;
    this.releaser = deps.releaser;
    this.makeRcon = deps.makeRcon ?? ((o) => o);
    this.notify = deps.notify ?? (() => {});
    this.demoDir = deps.demoDir ?? '';
    this.replayDir = deps.replayDir ?? '';
    this.onNoServer = deps.onNoServer;
    this.beforeLive = deps.beforeLive;
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
      // Wait, do not abort. The match stays 'configuring' and the pending list
      // retries it when a box frees. Only the no-server case pends: an rcon
      // failure below still aborts, because retrying a broken setup forever
      // would pin the queue on a server that is not going to work.
      console.warn(`[orchestrator] no idle server for match ${matchId}; waiting`);
      this.onNoServer?.(matchId);
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
      // The first line of the in-game ready-up panel. After pug_match, whose
      // rotoblin_pug_4v4.cfg sets the generic "Riverside PUG"; nothing on the
      // per-map config path resets it, so the number holds for the whole match.
      await rcon.exec(`l4d_ready_league_notice "Riverside PUG #${matchId}"`);
      // The leaver rules for this match, from the admin settings.
      await rcon.exec(`sm_pug_leave_budget ${settingInt(this.db, 'leave_budget_seconds', 300)}`);
      await rcon.exec(`sm_pug_leave_autounpause ${getSetting(this.db, 'leave_auto_unpause') === '0' ? 0 : 1}`);
      await rcon.exec(`sv_password "${serverPasswordFor(token)}"`);
      // The map to stop after, when we know the campaign's chapters. Omitted
      // rather than guessed when we do not: the plugin then keeps using its own
      // NextMapIsFinale(), which is what every self-started match relies on and
      // what every match did before this argument existed.
      // Quoted for the same reason the roster line below is, and asserted as
      // well: the name of a community campaign's map came out of an uploaded
      // file. parseMission refuses a bad one at upload, but a row can predate
      // that, and quotes alone do not stop a newline ending the command.
      const stopMap = stopAfterMap(this.db, match.campaign);
      if (stopMap && !isMapName(stopMap)) {
        throw new Error(`${match.campaign} stops after ${JSON.stringify(stopMap)}, which is not a valid map name`);
      }
      const stopArg = stopMap ? ` "${stopMap}"` : '';
      await expectPugOk(rcon, `sm_pug_match ${matchId} ${token} ${match.campaign}${stopArg}`);
      // The steamid:team arg MUST be quoted: Source's console tokenizer splits
      // unquoted args on ':', so the plugin would receive a bare steamid, reject
      // the line, and then kick every player as non-rostered. Verified on the
      // live box 2026-08-29. The fake RCON server in tests does not tokenize.
      for (const r of roster) await expectPugOk(rcon, `sm_pug_roster "${r.player_id}:${r.team}"`);
      // A custom campaign lives in a VPK that must actually be on this box.
      // The pool gate already checks this when the campaign is enabled, but
      // that answer can be stale: a server rebuilt or re-imaged between the
      // vote and now has no addon, and changelevel into a map it does not have
      // strands the match on a black screen with no error anyone sees.
      //
      // A campaign missing from the registry entirely is refused outright,
      // not just an uninstalled custom one: the stock four are always in the
      // registry, so this only ever catches a campaign that was deleted (map
      // pool pruning is supposed to prevent that being voted for at all, but
      // this guard does not get to assume that held). Without this, a
      // deleted campaign's entry?.custom read is undefined, which is falsy,
      // and the check below would be skipped entirely, letting
      // firstMapOf fall back to No Mercy under the deleted campaign's name.
      const entry = campaignRegistry(this.db).get(match.campaign);
      if (!entry) {
        throw new Error(`${match.campaign} is not a known campaign`);
      }
      if (entry.custom && !isInstalledEverywhere(this.db, match.campaign, [server.id])) {
        throw new Error(`${entry.name} is not installed on ${server.name}`);
      }
      // Same staleness argument as the custom-campaign check above, applied to
      // the dlc4 mappack: a server added or re-enabled after the vote defaults
      // to has_dlc4 = 0, and map_pool is never pruned to drop it back out, so
      // the pool answer can be wrong by the time we get here. changelevel into
      // a c1m1_hotel-style map with no left4dead_dlc4 on the box strands the
      // match the same way, with no error anyone sees.
      if (entry.requiresDlc4 && !server.has_dlc4) {
        throw new Error(`${entry.name} requires the dlc4 mappack, which ${server.name} does not have`);
      }
      if (this.beforeLive) {
        try {
          await this.beforeLive(rcon);
        } catch (err) {
          console.error(`[orchestrator] beforeLive hook failed for match ${matchId} (non-fatal):`, err);
        }
      }
      // Same assertion as the stop map above, and here there are no quotes
      // at all: ';' in the name would be a second command.
      const firstMap = firstMapOf(this.db, match.campaign);
      if (!isMapName(firstMap)) {
        throw new Error(`${entry.name} starts on ${JSON.stringify(firstMap)}, which is not a valid map name`);
      }
      await rcon.exec(`changelevel ${firstMap}`);
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
      this.notify(`🎮 Match #${matchId} is live: ${campaignDisplayName(this.db, match.campaign)} on ${server.name}`);
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

  /** Fetch the plugin's dump for a token, raw: no parse, no completion, no
   *  abort.
   *
   *  For the give-up path in finishWithRetry, which is about to release the
   *  box and so is about to send sm_pug_abort for this same token, and the
   *  plugin discards its result on that. Pulling the body one last time is the
   *  only chance to preserve it, and it goes to the log rather than through
   *  parseDump because parsing is precisely what has already failed; a human
   *  with scripts/recover-match.ts can still do something with the text.
   *
   *  Keyed on serverId and token rather than a match id because the caller has
   *  already flipped that match out of 'live'. Throws on failure; the caller
   *  must not let that stop the release. */
  /** Whether the plugin itself records `steamid` as having abandoned the match. */
  async confirmAbandon(serverId: number, steamid: string): Promise<boolean> {
    const server = getServer(this.db, serverId);
    if (!server) return false;
    let rcon: RconClient | null = null;
    try {
      rcon = await this.connectRcon(server);
      const body = await rcon.exec('sm_pug_status');
      return statusShowsAbandoner(body, steamid);
    } finally {
      rcon?.close();
    }
  }

  async pullDump(serverId: number, token: string): Promise<string> {
    const server = getServer(this.db, serverId);
    if (!server) throw new Error(`pullDump: no server row ${serverId}`);
    let rcon: RconClient | null = null;
    try {
      rcon = await this.connectRcon(server);
      return await rcon.exec(`sm_pug_dump ${token}`);
    } finally {
      rcon?.close();
    }
  }

  async finishMatch(matchId: number): Promise<FinishOutcome> {
    const match = this.db
      .prepare('SELECT id, state, campaign, server_id, token FROM matches WHERE id = ?')
      .get(matchId) as MatchRow | undefined;
    if (!match || match.state !== 'live' || match.server_id === null || match.token === null) return 'skipped';
    const server = getServer(this.db, match.server_id);
    if (!server) return 'skipped';

    let rcon: RconClient | null = null;
    let persisted = false;
    let dump: Dump | null = null;
    try {
      rcon = await this.connectRcon(server);
      // A fresh nonce per pull, as a second argument. pug-match 0.3.3 echoes it
      // (and its match state) on the DUMP and END lines, which is what ties
      // the block we parse to THIS request. Older plugins read argument 1
      // only (TokenArgOk) and ignore the rest, so this costs them nothing, and
      // parseDump reads their nonce-less answer exactly as before.
      const nonce = randomBytes(8).toString('hex');
      const body = await rcon.exec(`sm_pug_dump ${match.token} ${nonce}`);
      dump = parseDump(body, { nonce });
      if (!dump) {
        console.error(`[orchestrator] unparseable dump for match ${matchId}; leaving live for retry`);
        return 'retry';
      }
      if (dump.matchId !== matchId) {
        console.error(`[orchestrator] dump match id ${dump.matchId} != expected ${matchId}; leaving live for retry`);
        return 'retry';
      }
      // WriteDump answers in ANY match state, and we only get here because a
      // MATCH_END line arrived over UDP. That line needs the token, but the
      // token crosses the same cleartext stream, so a forged one used to
      // complete and rate a match at whatever the score was at that moment.
      // A plugin that echoes our nonce also says what state it is in, and only
      // `ended` is a result. Nothing is persisted, nothing is aborted, and the
      // box is not released: the match carries on, and the real MATCH_END
      // collects it. An older plugin says nothing and is believed as before.
      if (dump.nonce && dump.state !== 'ended') {
        console.error(`[orchestrator] match ${matchId}: MATCH_END arrived but the plugin says state=${dump.state}; NOT completing`);
        publishAdminEvent({
          kind: 'problem', matchId,
          text: `Match #${matchId}: a MATCH_END line arrived, but ${server.name} itself says the match is ${dump.state}, not ended. Nothing was completed or rated and the match carries on. A real end cannot look like this, so treat that line as forged and the match token as known to someone.`,
        });
        return 'not_ended';
      }
      persisted = completeMatch(this.db, matchId, dump);
      if (!persisted) {
        console.error(`[orchestrator] match ${matchId} was not completable (state changed?); skipping`);
        return 'skipped';
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
      // restart: the match is over, the plugin has already kicked everyone
      // with the result, and the demo and replay scans above have run. A box
      // set to restart cycles here, before it can be claimed again.
      this.releaser.release(match.server_id, { restart: true });
      if (dump) {
        const winnerText = dump.winner === 'draw' ? 'Draw' : dump.winner === 'a' ? 'Team A wins' : 'Team B wins';
        this.notify(`🏁 Match #${matchId} final: Team A ${dump.totalA}, Team B ${dump.totalB}. ${winnerText}!`);
      }
      return 'completed';
    }
    return 'retry';
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

function settingInt(db: DB, key: string, fallback: number): number {
  const n = Number(getSetting(db, key));
  return Number.isInteger(n) && n >= 0 ? n : fallback;
}
