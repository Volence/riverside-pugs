// scripts/seed-cast-studio.ts
// Fills a SCRATCH database for screenshots of the caster studio: one live
// PUG two chapters into Dead Air (scores, rounds, live stats, events), a
// finished PUG history for the prep sheet, and a caster. Never point this at
// data/pug.db.
//
//   DB_PATH=/tmp/x/pug.db LIVE_DIR=/tmp/x/live npx tsx scripts/seed-cast-studio.ts
//
// With LIVE_DIR set it then keeps appending one replay frame a second to the
// live match's round file (so the live round HUD has fresh data) until killed.
import { mkdirSync, writeFileSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { openDb } from '../src/db.js';
import { upsertPlayer, activatePlayer } from '../src/players.js';
import { encodeFrame, encodeHeader, STATE, VERSION, type PlayerSample } from '../src/replayFormat.js';

const DB_PATH = process.env.DB_PATH;
if (!DB_PATH || DB_PATH.includes('data/pug.db')) throw new Error('Set DB_PATH to a scratch database.');
const db = openDb(DB_PATH);

export const CASTER = '76561198000009001';
const NAMES = ['Volence', 'Psicodelica', 'Harry Potter', 'mayhem', 'gabe', 'wasd', 'mira', 'Visceral'];
const IDS = NAMES.map((_, i) => `7656119800000910${i}`);
const TOKEN = 'a1'.repeat(16);

for (const [i, id] of IDS.entries()) {
  upsertPlayer(db, { steamid: id, name: NAMES[i]!, avatar: null }, []);
  activatePlayer(db, id);
  db.prepare('INSERT OR REPLACE INTO player_ratings (player_id, season_id, mu, sigma, wins, losses) VALUES (?, 1, ?, ?, ?, ?)')
    .run(id, 25 + i * 1.3, 2.4, 20 + i * 3, 18 + (7 - i) * 2);
}
upsertPlayer(db, { steamid: CASTER, name: 'CasterOne', avatar: null }, []);
activatePlayer(db, CASTER);
db.prepare('UPDATE players SET is_caster = 1 WHERE steamid = ?').run(CASTER);

// History: twenty finished PUGs among the eight, for the prep sheet and cards.
const statKeys = ['skeets', 'dps_landed', 'tank_damage', 'deadstops', 'damage_as_si'];
for (let m = 0; m < 20; m++) {
  const id = Number(db.prepare(
    `INSERT INTO matches (season_id, state, campaign, token, origin, winner, team_a_score, team_b_score, created_at, ended_at)
     VALUES (1, 'completed', ?, ?, 'queue', ?, ?, ?, datetime('now', ?), datetime('now', ?))`,
  ).run(['dead_air', 'no_mercy', 'blood_harvest', 'death_toll'][m % 4], `h${String(m).padStart(31, '0')}`, m % 3 === 0 ? 'b' : 'a',
    1800 + m * 13, 1600 + m * 11, `-${m + 1} days`, `-${m + 1} days`).lastInsertRowid);
  const order = [...IDS].sort((x, y) => ((Number(x.slice(-1)) * 7 + m) % 8) - ((Number(y.slice(-1)) * 7 + m) % 8));
  order.forEach((p, i) => {
    db.prepare('INSERT INTO match_players (match_id, player_id, team, si_damage, si_kills, common_kills) VALUES (?, ?, ?, ?, ?, ?)')
      .run(id, p, i < 4 ? 'a' : 'b', 400 + ((i * 37 + m * 11) % 500), 6 + (i % 5), 90 + ((i * 13 + m) % 60));
    for (const [k, key] of statKeys.entries()) {
      db.prepare('INSERT INTO match_player_stats (match_id, player_id, stat, value) VALUES (?, ?, ?, ?)')
        .run(id, p, key, key === 'tank_damage' ? 800 + ((i * 97 + m * 31) % 1600) : (i + k + m) % 4);
    }
  });
}

// The live match: Dead Air, chapter 1 done, chapter 2 in progress.
const live = Number(db.prepare(
  "INSERT INTO matches (season_id, state, campaign, token, origin) VALUES (1, 'live', 'dead_air', ?, 'queue')",
).run(TOKEN).lastInsertRowid);
IDS.forEach((p, i) => db.prepare('INSERT INTO match_players (match_id, player_id, team) VALUES (?, ?, ?)').run(live, p, i < 4 ? 'a' : 'b'));
db.prepare("INSERT INTO match_live (match_id, current_map, last_seen, phase, phase_since) VALUES (?, 'l4d_vs_airport02_offices', datetime('now'), 'live', datetime('now', '-3 minutes'))").run(live);
db.prepare("INSERT INTO match_live_maps (match_id, map, ordinal, team_a_score, team_b_score) VALUES (?, 'l4d_vs_airport01_greenhouse', 0, 512, 448)").run(live);
db.prepare("INSERT INTO match_rounds (match_id, ordinal, half, surv_team, score, started_at, ended_at) VALUES (?, 0, 1, 'b', 448, datetime('now','-30 minutes'), datetime('now','-22 minutes'))").run(live);
db.prepare("INSERT INTO match_rounds (match_id, ordinal, half, surv_team, score, started_at, ended_at) VALUES (?, 0, 2, 'a', 512, datetime('now','-20 minutes'), datetime('now','-12 minutes'))").run(live);
db.prepare("INSERT INTO match_rounds (match_id, ordinal, half, surv_team, score, started_at) VALUES (?, 1, 1, 'a', 0, datetime('now','-3 minutes'))").run(live);
IDS.forEach((p, i) => db.prepare('INSERT INTO match_live_players (match_id, player_id, stats_json) VALUES (?, ?, ?)')
  .run(live, p, JSON.stringify({ sidmg: 300 + i * 41, sikill: 4 + (i % 4), ck: 70 + i * 6, skeets: i % 3, deadstops: (i + 1) % 3, dps_landed: i % 2, damage_as_si: 120 + i * 17, tank_damage: 400 + i * 50 })));
const ev = (seq: number, kind: string, actor: number, target: number | null, value = 0) =>
  db.prepare('INSERT INTO match_live_events (match_id, map_ordinal, seq, kind, actor, target, value) VALUES (?, 1, ?, ?, ?, ?, ?)')
    .run(live, seq, kind, IDS[actor], target === null ? null : IDS[target], value);
ev(1, 'tank_spawn', 5, null);
ev(2, 'skeet', 0, 6);
ev(3, 'dp', 7, 2, 25);
ev(4, 'incap', 3, 4);
ev(5, 'skeet', 1, 7);

console.log(JSON.stringify({ caster: CASTER, live }));

const LIVE_DIR = process.env.LIVE_DIR;
if (LIVE_DIR) {
  mkdirSync(LIVE_DIR, { recursive: true });
  const path = join(LIVE_DIR, `pug_${TOKEN}_1_1.rpl`);
  writeFileSync(path, encodeHeader({
    version: VERSION, token: TOKEN, ordinal: 1, half: 1, playerHz: 10, entityHz: 2, map: 'l4d_vs_airport02_offices',
    startedUnix: Math.floor(Date.now() / 1000) - 180, indexOffset: 0, indexCount: 0, frameCount: 0,
    slots: IDS, infectedMask: 0xf0, sidesKnown: true, losKnown: false,
  }));
  const s = (slot: number, p: Partial<PlayerSample>): PlayerSample => ({
    slot, x: 0, y: 0, z: 0, yaw: 0, pitch: 0, state: STATE.PRESENT | STATE.ALIVE, health: 100, temp: 1, cls: 0, weapon: 0, clip: 0, reserve: 0, ...p,
  });
  let t = 180_000;
  const tick = () => {
    t += 1000;
    const tank = 6000 - Math.min(5400, Math.floor((t - 180_000) / 1000) * 90);
    appendFileSync(path, encodeFrame({
      tMs: t, offset: 0,
      entities: [{ ref: 7, kind: 2, state: 1, x: 0, y: 0, z: 0, health: 1000 }],
      players: [
        s(0, { cls: 0, health: 71, temp: 1, weapon: 4 }),
        s(1, { cls: 1, health: 38, temp: 22, weapon: 5 }),
        s(2, { cls: 2, state: STATE.PRESENT | STATE.ALIVE | STATE.INCAP, health: 210, weapon: 1 }),
        s(3, { cls: 3, health: 100, temp: 1, weapon: 3 }),
        s(4, { cls: 3, health: 250 }),
        s(5, { cls: 5, health: tank }),
        s(6, { cls: 1, state: STATE.PRESENT | STATE.ALIVE | STATE.GHOST, health: 250 }),
        s(7, { cls: 0, state: STATE.PRESENT }),
      ],
    }));
  };
  tick();
  setInterval(tick, 1000);
}
