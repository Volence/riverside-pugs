/**
 * Re-arm a live match on a game server that has just been restarted.
 *
 * srcds only mounts addons/*.vpk at startup, so a custom campaign installed
 * while the server was running is invisible to the engine and the orchestrator's
 * changelevel fails with "No such map". Fixing that needs a restart, and a
 * restart throws away the pug-match plugin's in-memory state for the match that
 * is already marked live in the database.
 *
 * This replays exactly the rcon setup orchestrator.setupMatch does, for a match
 * that already has its server and token, so the same match id, token, roster and
 * Discord card carry on. It changes no database state: the match is already
 * live, the box is already claimed, and the log listener in pug-web never went
 * away.
 *
 * Only for a restart BEFORE the first map is played. The plugin keeps per-map
 * scores in memory and never writes them to disk, so after a restart between
 * maps this brings the match back at 0-0 and the final dump reports only the
 * maps played since: wrong result, wrong SR.
 *
 *   npx tsx scripts/rearm-match.ts <matchId>
 */
import { loadDotEnv } from './dotenv.js';
loadDotEnv();

import { openDb } from '../src/db.js';
import { loadConfig } from '../src/config.js';
import { RconClient } from '../src/rcon.js';
import { getServer } from '../src/serverPool.js';
import { getSetting } from '../src/settings.js';
import { serverPasswordFor } from '../src/matchToken.js';
import { stopAfterMap } from '../src/stopPoint.js';
import { campaignRegistry, firstMapOf, setMissionsDirs } from '../src/campaignRegistry.js';

const matchId = Number(process.argv[2]);
if (!Number.isInteger(matchId)) throw new Error('usage: rearm-match.ts <matchId>');

const config = loadConfig(process.env);
const db = openDb(config.dbPath);
setMissionsDirs([config.missionsDir, config.dlc4MissionsDir]);

const match = db.prepare('SELECT id, state, campaign, server_id, token FROM matches WHERE id = ?').get(matchId) as
  | { id: number; state: string; campaign: string; server_id: number; token: string }
  | undefined;
if (!match) throw new Error(`no match ${matchId}`);
if (match.state !== 'live') throw new Error(`match ${matchId} is ${match.state}, not live`);
if (!match.token || !match.server_id) throw new Error(`match ${matchId} has no server/token to re-arm`);

const server = getServer(db, match.server_id);
if (!server) throw new Error(`no server row ${match.server_id}`);

const roster = db
  .prepare('SELECT player_id, team FROM match_players WHERE match_id = ?')
  .all(matchId) as { player_id: string; team: 'a' | 'b' }[];

const entry = campaignRegistry(db).get(match.campaign);
if (!entry) throw new Error(`${match.campaign} is not a known campaign`);
const firstMap = firstMapOf(db, match.campaign);

function settingInt(key: string, fallback: number): number {
  const n = Number(getSetting(db, key));
  return Number.isInteger(n) && n >= 0 ? n : fallback;
}

async function expectPugOk(rcon: RconClient, cmd: string): Promise<string> {
  const res = await rcon.exec(cmd);
  if (!res.includes('PUGOK')) throw new Error(`${cmd.split(' ')[0]} rejected: ${res.trim() || '(no response)'}`);
  return res;
}

const rcon = new RconClient({ host: server.host, port: server.rcon_port, password: server.rcon_password });
await rcon.connect();
try {
  // The engine must actually have the campaign's first map, or we are about to
  // repeat the failure this script exists to undo. `maps *` lists the search
  // paths, which is the only thing that proves the VPK mounted; the install
  // table only proves the file was copied.
  const maps = await rcon.exec('maps *');
  if (!maps.toLowerCase().includes(firstMap.toLowerCase())) {
    throw new Error(`${server.name} still has no ${firstMap}: the addon did not mount, do not re-arm yet`);
  }
  console.log(`[rearm] ${server.name} has ${firstMap}`);

  await rcon.exec(`logaddress_add ${config.logPublicAddress}`);
  await rcon.exec('exec pug_match');
  await rcon.exec(`l4d_ready_league_notice "Riverside PUG #${matchId}"`);
  await rcon.exec(`sm_pug_leave_budget ${settingInt('leave_budget_seconds', 300)}`);
  await rcon.exec(`sm_pug_leave_autounpause ${getSetting(db, 'leave_auto_unpause') === '0' ? 0 : 1}`);
  await rcon.exec(`sv_password "${serverPasswordFor(match.token)}"`);

  const stopMap = stopAfterMap(db, match.campaign);
  const stopArg = stopMap ? ` "${stopMap}"` : '';
  await expectPugOk(rcon, `sm_pug_match ${matchId} ${match.token} ${match.campaign}${stopArg}`);
  for (const r of roster) await expectPugOk(rcon, `sm_pug_roster "${r.player_id}:${r.team}"`);
  console.log(`[rearm] match ${matchId} armed with ${roster.length} rostered players, stops after ${stopMap ?? '(plugin decides)'}`);

  await rcon.exec(`changelevel ${firstMap}`);
  console.log(`[rearm] changelevel ${firstMap} sent`);
} finally {
  rcon.close();
}
