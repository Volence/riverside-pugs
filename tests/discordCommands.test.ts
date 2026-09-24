import { describe, it, expect, beforeEach } from 'vitest';
import { openDb, type DB } from '../src/db.js';
import { upsertPlayer, activatePlayer, linkDiscord } from '../src/players.js';
import { completeMatch } from '../src/matchResult.js';
import { Matchmaker } from '../src/matchmaker.js';
import { COMMAND_DEFS, handleCommand } from '../src/discord/commands.js';
import type { Dump } from '../src/dumpParse.js';
import type { PickedMember } from '../src/discord/transport.js';

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

const run = (
  name: string, options: Record<string, string> = {}, userId = '900',
  picked: Record<string, PickedMember> = {}, presserTimedOutUntil: string | null = null,
) =>
  handleCommand({ db, matchmaker: mm, publicUrl: URL_ }, {
    kind: 'command', name, userId, userName: 'u', options,
    // '/report''s `player` option is a Discord user picker: Discord itself
    // supplies the PickedMember (name, bot, administrator) alongside the raw
    // id in `options.player`. Every other command here ignores `picked`, so
    // synthesizing it from `options.player` when a test does not pass one
    // explicitly keeps every existing call site unchanged.
    picked: options.player && !picked.player ? { ...picked, player: { id: options.player, name: 'target', bot: false, administrator: false } } : picked,
    presserTimedOutUntil,
  });
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

  // Embed titles render a subset of markdown, masked links included, and both
  // the Steam name and the linked Discord display name are attacker text.
  it('/profile and /matches escape a hostile steam or discord name in the title', async () => {
    upsertPlayer(db, { steamid: IDS[6], name: '[Free Nitro](http://evil.tk)', avatar: null }, []);
    activatePlayer(db, IDS[6]);
    linkDiscord(db, IDS[6], '906', '[Click here](http://evil.tk)');
    const profile = text(await run('profile', { user: '906' }));
    expect(profile).not.toMatch(/\]\(http:\/\/evil\.tk\)/);
    const matches = text(await run('matches', { user: '906' }));
    expect(matches).not.toMatch(/\]\(http:\/\/evil\.tk\)/);
  });

  it('/leaderboard lists ranked players only, best first', async () => {
    play('a'); play('a');
    expect(text(await run('leaderboard'))).toMatch(/nobody is ranked yet/i);
    play('a');
    const t = text(await run('leaderboard'));
    expect(t).toContain('player0');
    expect(t.indexOf('player0')).toBeLessThan(t.indexOf('player4'));
    // IDS[0]'s linked discord name ("p0") differs from its steam name
    // ("player0"), so the row says both.
    expect(t).toContain('player0 (Discord: p0)');
  });

  it('/leaderboard escapes a hostile steam or discord name', async () => {
    upsertPlayer(db, { steamid: IDS[6], name: '[Nitro](http://evil.tk)', avatar: null }, []);
    activatePlayer(db, IDS[6]);
    linkDiscord(db, IDS[6], '906', '[click](http://evil.tk)');
    play('a'); play('a'); play('a');
    const t = text(await run('leaderboard'));
    expect(t).not.toMatch(/\]\(http:\/\/evil\.tk\)/);
  });

  it('stays under the 4096-char embed description limit with realistic long names for every ranked row', async () => {
    // Every one of the 8 rostered players gets a 32-char steam name and a
    // differing 32-char linked discord name (an 18-digit snowflake for the
    // id), so every row shows both names at once, the worst case for length.
    IDS.forEach((id, i) => {
      db.prepare('UPDATE players SET name = ?, discord_id = ?, discord_name = ? WHERE steamid = ?')
        .run('s'.repeat(30) + String(i).padStart(2, '0'), `10000000000000000${i}`, 'd'.repeat(30) + String(i).padStart(2, '0'), id);
    });
    play('a'); play('a'); play('a');
    const t = text(await run('leaderboard'));
    const description = JSON.parse(t).embeds[0].description as string;
    expect(description.length).toBeLessThanOrEqual(4096);
  });

  it('/matches lists recent matches overall, or for a user', async () => {
    const id = play('a');
    expect(text(await run('matches'))).toContain(`${URL_}/match/${id}`);
    expect(text(await run('matches', { user: '905' }))).toContain(`${URL_}/match/${id}`);
  });

  it('/queue shows the queue privately, both names when the queued player has them and they differ', async () => {
    mm.join(IDS[1]);
    mm.join(IDS[0]);
    const r = await run('queue');
    expect(r.ephemeral).toBe(true);
    expect(text(r)).toContain('2/8');
    expect(text(r)).toContain('player1');
    expect(text(r)).toContain('player0 (Discord: p0)');
  });

  it('/queue escapes a hostile steam or discord name', async () => {
    upsertPlayer(db, { steamid: IDS[6], name: '[Nitro](http://evil.tk)', avatar: null }, []);
    activatePlayer(db, IDS[6]);
    linkDiscord(db, IDS[6], '906', '[click](http://evil.tk)');
    mm.join(IDS[6]);
    const t = text(await run('queue'));
    expect(t).not.toMatch(/\]\(http:\/\/evil\.tk\)/);
  });

  it('/link says who you are linked to, or hands out a link', async () => {
    expect(text(await run('link'))).toContain('player0');
    expect(text(await run('link', {}, '777'))).toContain('/link/discord?code=');
  });
});

describe('/report', () => {
  const rows = () => db.prepare('SELECT r.match_id, r.reporter_id, t.target_id, r.category, r.text FROM ticket_reports r JOIN tickets t ON t.id = r.ticket_id ORDER BY r.id').all();

  it('files against your latest match together, privately', async () => {
    play('a');
    const latest = play('b');
    const r = await run('report', { player: '905', reason: 'afk', details: 'gone all of map 2' });
    expect(r.ephemeral).toBe(true);
    expect(text(r)).toContain(`match #${latest}`);
    expect(rows()).toEqual([{ match_id: latest, reporter_id: IDS[0], target_id: IDS[5], category: 'afk', text: 'gone all of map 2' }]);
  });

  it('files with no match at all when you have none together', async () => {
    const r = await run('report', { player: '905', reason: 'toxicity', details: 'in voice' });
    expect(text(r)).toMatch(/reported player5/i);
    expect(text(r)).not.toMatch(/match #/);
    expect(rows()).toEqual([{ match_id: null, reporter_id: IDS[0], target_id: IDS[5], category: 'toxicity', text: 'in voice' }]);
  });

  it('takes an explicit match, and refuses a repeat and yourself', async () => {
    const first = play('a');
    play('b');
    expect(text(await run('report', { player: '905', reason: 'cheating', match: String(first) }))).toContain(`match #${first}`);
    expect(text(await run('report', { player: '905', reason: 'cheating', match: String(first) }))).toMatch(/already reported/);
    expect(text(await run('report', { player: '900', reason: 'afk' }))).toMatch(/yourself/);
  });

  // A member who has not linked Steam used to be refused outright ("has not
  // linked Discord"). Phase 3a lets the report name them instead: fileReport
  // turns the pick into a Discord-only target, and the reply uses the name
  // Discord supplied, not a player row.
  it('reports a Discord-only member picked in the player option', async () => {
    const r = await run('report', { player: '990', reason: 'toxicity' }, '900', { player: { id: '990', name: 'Lurky', bot: false, administrator: false } });
    expect(r.payload.content).toMatch(/^Reported Lurky/);
    expect(r.payload.content).toContain('The person you reported is never told who filed it.');
    expect(r.payload.content).not.toContain('match #');
  });

  it('takes a report from someone who has not linked Steam', async () => {
    const r = await run('report', { player: '999', reason: 'afk' }, 'd-new', { player: { id: '999', name: 'Ghosty', bot: false, administrator: false } });
    expect(r.payload.content).toMatch(/^Reported Ghosty/);
  });

  it('offers the safety category and insists on details for it', async () => {
    const def = COMMAND_DEFS.find((d) => d.name === 'report')!;
    expect(JSON.stringify(def)).toContain('unsafe');
    expect(text(await run('report', { player: '905', reason: 'unsafe' }))).toMatch(/say what happened/i);
  });
  // The web route has always required an active player. The command checked
  // nothing, so a banned player could keep filing reports from Discord.
  it('refuses a reporter who is banned, not yet active, or merged away, and files nothing', async () => {
    const { banPlayer, unbanPlayer } = await import('../src/admin/players.js');
    const { addAlias, removeAlias } = await import('../src/aliases.js');
    play('a');
    const filed = () => (db.prepare('SELECT COUNT(*) AS n FROM ticket_reports').get() as { n: number }).n;

    banPlayer(db, IDS[0], IDS[1], 'toxic', 60);
    expect(text(await run('report', { player: '905', reason: 'afk' }))).toMatch(/banned/i);
    unbanPlayer(db, IDS[0], IDS[1]);

    db.prepare("UPDATE players SET status = 'invited' WHERE steamid = ?").run(IDS[0]);
    expect(text(await run('report', { player: '905', reason: 'afk' }))).toMatch(/not active/i);
    db.prepare("UPDATE players SET status = 'active' WHERE steamid = ?").run(IDS[0]);

    addAlias(db, { steamid: IDS[0], canonical: IDS[1], by: 'test' });
    expect(text(await run('report', { player: '905', reason: 'afk' }))).toMatch(/merged into another/i);

    expect(filed()).toBe(0);
    // And it was the standing that refused each time: the same command from
    // the same player goes through once nothing is wrong with them.
    removeAlias(db, IDS[0]);
    expect(text(await run('report', { player: '905', reason: 'afk' }))).toMatch(/reported player5/i);
    expect(filed()).toBe(1);
  });
});
