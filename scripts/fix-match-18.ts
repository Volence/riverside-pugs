// One-off correction for match 18 (Blood Harvest, 2026-09-14).
//
//   sudo -u pug bash -c 'set -a; . .env; set +a; node_modules/.bin/tsx scripts/fix-match-18.ts [--apply]'
//
// Without --apply it prints what it would change and touches nothing.
//
// What went wrong: !load_4v4p ran with sm_pug_roster_at_live 0 and 7 players on
// teams, so the roster was snapshotted BEFORE the !mix that set the real teams.
// Bone Breaker and Dust were recorded on the wrong sides and mayhem (who joined
// after the snapshot) was never rostered. With the roster wrong, two survivor
// rounds ended in a 1:1 rostered-survivor tie and were dropped as
// "unattributable": map 3 half 1 (1244) and map 4 half 1 (726), both team b.
//
// This script reverts the ratings the wrong result applied, fixes the roster,
// credits the two rounds, flips the winner, and re-applies ratings through the
// same applyMatchRatings the orchestrator uses.
import { loadConfig } from '../src/config.js';
import { openDb } from '../src/db.js';
import { applyMatchRatings } from '../src/rating.js';

const MATCH = 18;
const APPLY = process.argv.includes('--apply');
const DB_PATH = process.env.FIX_DB_PATH ?? loadConfig().dbPath;

const BONE_BREAKER = '76561197972484944';
const DUST = '76561199187058410';
const MAYHEM = '76561198005192652'; // STEAM_1:0:22463462
// Half 1 of maps 3 and 4 (ordinals 2 and 3) were team b survivor rounds.
const MISSING: { ordinal: number; half: number; score: number }[] = [
  { ordinal: 2, half: 1, score: 1244 },
  { ordinal: 3, half: 1, score: 726 },
];

const db = openDb(DB_PATH);
const match = db.prepare('SELECT id, state, season_id, team_a_score, team_b_score, winner FROM matches WHERE id = ?')
  .get(MATCH) as { id: number; state: string; season_id: number; team_a_score: number; team_b_score: number; winner: string | null } | undefined;
if (!match) { console.error(`no match ${MATCH}`); process.exit(1); }
if (match.state !== 'completed') { console.error(`match ${MATCH} is ${match.state}, expected completed`); process.exit(1); }
if (match.winner !== 'a' || match.team_b_score !== 607) {
  console.error(`match ${MATCH} does not look like the uncorrected result (winner=${match.winner} b=${match.team_b_score}); refusing`);
  process.exit(1);
}
const later = db.prepare('SELECT count(*) AS n FROM rating_history WHERE match_id > ?').get(MATCH) as { n: number };
if (later.n > 0) { console.error(`${later.n} rating_history rows after match ${MATCH}; a plain revert is not safe`); process.exit(1); }

const hist = db.prepare('SELECT player_id, mu_before, sigma_before FROM rating_history WHERE match_id = ?')
  .all(MATCH) as { player_id: string; mu_before: number; sigma_before: number }[];
const roster = db.prepare('SELECT player_id, team FROM match_players WHERE match_id = ?')
  .all(MATCH) as { player_id: string; team: 'a' | 'b' }[];
const teamOf = new Map(roster.map((r) => [r.player_id, r.team]));

console.log(`db: ${DB_PATH}`);
console.log(`before: a=${match.team_a_score} b=${match.team_b_score} winner=${match.winner}, ${roster.length} rostered, ${hist.length} rating rows`);
const addB = MISSING.reduce((t, m) => t + m.score, 0);
console.log(`plan: ${BONE_BREAKER} a->b, ${DUST} b->a, add ${MAYHEM} to b; b += ${addB} -> ${match.team_b_score + addB}; winner b; revert ${hist.length} ratings and re-rate`);
if (!APPLY) { console.log('dry run, nothing written (pass --apply)'); process.exit(0); }

db.transaction(() => {
  // 1. Revert the ratings the wrong result applied. Winner was a: team a rows
  //    took a win, team b rows a loss.
  const undo = db.prepare(
    'UPDATE player_ratings SET mu = ?, sigma = ?, wins = wins - ?, losses = losses - ? WHERE player_id = ? AND season_id = ?',
  );
  for (const h of hist) {
    const won = teamOf.get(h.player_id) === 'a';
    undo.run(h.mu_before, h.sigma_before, won ? 1 : 0, won ? 0 : 1, h.player_id, match.season_id);
  }
  db.prepare('DELETE FROM rating_history WHERE match_id = ?').run(MATCH);

  // 2. Roster.
  const setTeam = db.prepare('UPDATE match_players SET team = ? WHERE match_id = ? AND player_id = ?');
  setTeam.run('b', MATCH, BONE_BREAKER);
  setTeam.run('a', MATCH, DUST);
  db.prepare("INSERT OR IGNORE INTO players (steamid, name, status) VALUES (?, 'mayhem', 'active')").run(MAYHEM);
  db.prepare("INSERT OR IGNORE INTO match_players (match_id, player_id, team) VALUES (?, ?, 'b')").run(MATCH, MAYHEM);

  // 3. The two dropped rounds, in the per-round and per-map tables and the total.
  for (const m of MISSING) {
    db.prepare("UPDATE match_rounds SET score = ? WHERE match_id = ? AND ordinal = ? AND half = ? AND surv_team = 'b'")
      .run(m.score, MATCH, m.ordinal, m.half);
    db.prepare('UPDATE match_maps SET team_b_score = team_b_score + ? WHERE match_id = ? AND ordinal = ?')
      .run(m.score, MATCH, m.ordinal);
  }
  db.prepare("UPDATE matches SET team_b_score = team_b_score + ?, winner = 'b' WHERE id = ?").run(addB, MATCH);

  // 4. Ratings again, from the corrected roster and winner.
  applyMatchRatings(db, MATCH);
})();

const after = db.prepare('SELECT team_a_score, team_b_score, winner FROM matches WHERE id = ?').get(MATCH) as { team_a_score: number; team_b_score: number; winner: string };
const rows = db.prepare('SELECT mp.player_id, p.name, mp.team, pr.mu, pr.sigma, pr.wins, pr.losses FROM match_players mp JOIN players p ON p.steamid = mp.player_id JOIN player_ratings pr ON pr.player_id = mp.player_id AND pr.season_id = ? WHERE mp.match_id = ? ORDER BY mp.team, p.name')
  .all(match.season_id, MATCH) as { player_id: string; name: string; team: string; mu: number; sigma: number; wins: number; losses: number }[];
console.log(`after: a=${after.team_a_score} b=${after.team_b_score} winner=${after.winner}`);
for (const r of rows) console.log(`  ${r.team} ${r.name.padEnd(24)} mu=${r.mu.toFixed(3)} sigma=${r.sigma.toFixed(3)} ${r.wins}-${r.losses}`);
console.log(`rating rows: ${(db.prepare('SELECT count(*) AS n FROM rating_history WHERE match_id = ?').get(MATCH) as { n: number }).n}`);
