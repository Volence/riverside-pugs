import { describe, it, expect, beforeEach } from 'vitest';
import { openDb, type DB } from '../src/db.js';
import { upsertPlayer, activatePlayer, linkDiscord } from '../src/players.js';
import { completeMatch } from '../src/matchResult.js';
import { Matchmaker } from '../src/matchmaker.js';
import { COMMAND_DEFS, handleCommand } from '../src/discord/commands.js';
import type { Dump } from '../src/dumpParse.js';

const IDS = Array.from({ length: 8 }, (_, i) => `7656119900000000${i}`);
const URL_ = 'https://pug.test';

let db: DB;
let mm: Matchmaker;

function play(winner: 'a' | 'b'): number {
  const matchId = Number(db.prepare("INSERT INTO matches (season_id, state, campaign) VALUES (1, 'live', 'dead_air')").run().lastInsertRowid);
  const ins = db.prepare('INSERT INTO match_players (match_id, player_id, team) VALUES (?, ?, ?)');
  IDS.forEach((id, i) => ins.run(matchId, id, i < 4 ? 'a' : 'b'));
  const dump: Dump = {
    matchId, maps: [{ map: 'm1', a: winner === 'a' ? 300 : 200, b: winner === 'b' ? 300 : 200 }],
    players: IDS.map((steamid, i) => ({ steamid, team: i < 4 ? 'a' : 'b', sidmg: 500, sikill: 5, ck: 100, ff: 20, rev: 1 })),
    skillDetect: false, skills: [], winner, totalA: winner === 'a' ? 300 : 200, totalB: winner === 'b' ? 300 : 200,
  };
  completeMatch(db, matchId, dump);
  return matchId;
}

beforeEach(() => {
  db = openDb(':memory:');
  IDS.forEach((id, i) => {
    upsertPlayer(db, { steamid: id, name: `player${i}`, avatar: null }, []);
    activatePlayer(db, id);
  });
  linkDiscord(db, IDS[0], '900', 'p0');
  linkDiscord(db, IDS[5], '905', 'p5');
  mm = new Matchmaker(db, { broadcast: () => {}, orchestrator: { setupMatch: async () => {}, finishMatch: async () => {} } });
});

const run = (name: string, options: Record<string, string> = {}, userId = '900') =>
  handleCommand({ db, matchmaker: mm, publicUrl: URL_ }, { kind: 'command', name, userId, userName: 'u', options });
const text = (r: Awaited<ReturnType<typeof run>>) => JSON.stringify(r.payload);

describe('slash commands', () => {
  it('defines profile, leaderboard, matches, queue and link', () => {
    expect(COMMAND_DEFS.map((d) => d.name).sort()).toEqual(['leaderboard', 'link', 'matches', 'profile', 'queue', 'report']);
  });

  it('/profile shows your SR, record and recent matches as links, publicly', async () => {
    const ids = [play('a'), play('a'), play('b')];
    const r = await run('profile');
    expect(r.ephemeral).toBe(false);
    const t = text(r);
    expect(t).toContain('player0');
    expect(t).toMatch(/2W 1L/);
    for (const id of ids) expect(t).toContain(`${URL_}/match/${id}`);
    expect(t).toContain(`${URL_}/player/${IDS[0]}`);
  });

  it('/profile for another linked user, and a clear answer for an unlinked one', async () => {
    play('b');
    expect(text(await run('profile', { user: '905' }))).toContain('player5');
    const r = await run('profile', { user: '999' });
    expect(r.ephemeral).toBe(true);
    expect(text(r)).toMatch(/not linked/i);
  });

  it('/profile when you are not linked offers the link', async () => {
    const r = await run('profile', {}, '12345');
    expect(r.ephemeral).toBe(true);
    expect(text(r)).toContain('/link/discord?code=');
  });

  it('/leaderboard lists ranked players only, best first', async () => {
    play('a'); play('a');
    expect(text(await run('leaderboard'))).toMatch(/nobody is ranked yet/i);
    play('a');
    const t = text(await run('leaderboard'));
    expect(t).toContain('player0');
    expect(t.indexOf('player0')).toBeLessThan(t.indexOf('player4'));
  });

  it('/matches lists recent matches overall, or for a user', async () => {
    const id = play('a');
    expect(text(await run('matches'))).toContain(`${URL_}/match/${id}`);
    expect(text(await run('matches', { user: '905' }))).toContain(`${URL_}/match/${id}`);
  });

  it('/queue shows the queue privately', async () => {
    mm.join(IDS[1]);
    const r = await run('queue');
    expect(r.ephemeral).toBe(true);
    expect(text(r)).toContain('1/8');
    expect(text(r)).toContain('player1');
  });

  it('/link says who you are linked to, or hands out a link', async () => {
    expect(text(await run('link'))).toContain('player0');
    expect(text(await run('link', {}, '777'))).toContain('/link/discord?code=');
  });
});

describe('/report', () => {
  it('files against your latest match together, privately', async () => {
    play('a');
    const latest = play('b');
    const r = await run('report', { player: '905', reason: 'afk', details: 'gone all of map 2' });
    expect(r.ephemeral).toBe(true);
    expect(text(r)).toContain(`match #${latest}`);
    const row = db.prepare('SELECT match_id, reporter_id, target_id, category, text FROM reports').get();
    expect(row).toEqual({ match_id: latest, reporter_id: IDS[0], target_id: IDS[5], category: 'afk', text: 'gone all of map 2' });
  });

  it('takes an explicit match, refuses a repeat, yourself, and unlinked targets', async () => {
    const first = play('a');
    play('b');
    expect(text(await run('report', { player: '905', reason: 'cheating', match: String(first) }))).toContain(`match #${first}`);
    expect(text(await run('report', { player: '905', reason: 'cheating', match: String(first) }))).toMatch(/already reported/);
    expect(text(await run('report', { player: '900', reason: 'afk' }))).toMatch(/yourself/);
    expect(text(await run('report', { player: '999', reason: 'afk' }))).toMatch(/not linked/);
  });

  it('says so when you have no recent match together', async () => {
    expect(text(await run('report', { player: '905', reason: 'afk' }))).toMatch(/last 48 hours/);
  });
  // The web route has always required an active player. The command checked
  // nothing, so a banned player could keep filing reports from Discord.
  it('refuses a reporter who is banned, not yet active, or merged away, and files nothing', async () => {
    const { banPlayer, unbanPlayer } = await import('../src/admin/players.js');
    const { addAlias } = await import('../src/aliases.js');
    play('a');
    const filed = () => (db.prepare('SELECT COUNT(*) AS n FROM reports').get() as { n: number }).n;

    banPlayer(db, IDS[0], IDS[1], 'toxic', 60);
    expect(text(await run('report', { player: '905', reason: 'afk' }))).toMatch(/banned/i);
    unbanPlayer(db, IDS[0], IDS[1]);

    db.prepare("UPDATE players SET status = 'invited' WHERE steamid = ?").run(IDS[0]);
    expect(text(await run('report', { player: '905', reason: 'afk' }))).toMatch(/not active/i);
    db.prepare("UPDATE players SET status = 'active' WHERE steamid = ?").run(IDS[0]);

    addAlias(db, { steamid: IDS[0], canonical: IDS[1], by: 'test' });
    expect(text(await run('report', { player: '905', reason: 'afk' }))).toMatch(/merged into another/i);

    expect(filed()).toBe(0);
  });
});
