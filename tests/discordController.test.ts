import { describe, it, expect, beforeEach } from 'vitest';
import { openDb, type DB } from '../src/db.js';
import { Matchmaker } from '../src/matchmaker.js';
import { upsertPlayer, activatePlayer, linkDiscord, consumeLinkCode } from '../src/players.js';
import { addServer } from '../src/serverPool.js';
import { handleButton } from '../src/discord/controller.js';
import type { Scheduler } from '../src/lobby.js';
import type { InteractionReply } from '../src/discord/transport.js';

const IDS = Array.from({ length: 8 }, (_, i) => `7656119800000000${i + 1}`);
const did = (i: number) => `90${i}`;
const URL_ = 'https://pug.test';

class FakeScheduler implements Scheduler {
  timers = new Map<number, () => void>();
  private n = 1;
  set(fn: () => void): number { const id = this.n++; this.timers.set(id, fn); return id; }
  clear(id: number): void { this.timers.delete(id); }
  fireAll(): void { const f = [...this.timers.values()]; this.timers.clear(); f.forEach((x) => x()); }
}

let db: DB;
let mm: Matchmaker;
let sched: FakeScheduler;

beforeEach(() => {
  db = openDb(':memory:');
  IDS.forEach((id, i) => {
    upsertPlayer(db, { steamid: id, name: `n${i}`, avatar: null }, []);
    activatePlayer(db, id);
    linkDiscord(db, id, did(i), `d${i}`);
  });
  sched = new FakeScheduler();
  mm = new Matchmaker(db, {
    broadcast: () => {}, orchestrator: { setupMatch: async () => {}, finishMatch: async () => {} },
    scheduler: sched, rng: () => 0,
  });
});

const press = (i: number, customId: string, userName = `d${i}`) =>
  handleButton({ db, matchmaker: mm, publicUrl: URL_ }, { kind: 'button', customId, userId: did(i), userName });
const body = (r: InteractionReply) => JSON.stringify(r.payload);

describe('discord buttons', () => {
  it('every reply is ephemeral', async () => {
    expect((await press(0, 'q:join')).ephemeral).toBe(true);
  });

  it('an unlinked user gets a one-time link to connect Steam', async () => {
    const r = await handleButton(
      { db, matchmaker: mm, publicUrl: URL_ },
      { kind: 'button', customId: 'q:join', userId: 'stranger', userName: 'Stranger' },
    );
    const btn = r.payload.components.flat().find((b) => b.kind === 'link');
    expect(btn && btn.kind === 'link' && btn.url.startsWith(`${URL_}/link/discord?code=`)).toBe(true);
    const code = btn!.kind === 'link' ? new URL(btn!.url).searchParams.get('code')! : '';
    expect(consumeLinkCode(db, code)).toEqual({ discordId: 'stranger', discordName: 'Stranger' });
    expect(mm.publicQueue().count).toBe(0);
  });

  it('join and leave move the same queue the website uses', async () => {
    expect(body(await press(0, 'q:join'))).toContain('1/8');
    expect(mm.stateFor(IDS[0]).queue.joined).toBe(true);
    expect(body(await press(0, 'q:join'))).toMatch(/already/i);
    await press(0, 'q:leave');
    expect(mm.stateFor(IDS[0]).queue.joined).toBe(false);
    expect(body(await press(0, 'q:leave'))).toMatch(/not in the queue/i);
  });

  it('a banned player is refused', async () => {
    db.prepare("UPDATE players SET status = 'banned' WHERE steamid = ?").run(IDS[0]);
    expect(body(await press(0, 'q:join'))).toMatch(/banned/i);
    expect(mm.publicQueue().count).toBe(0);
  });

  it('an invited player is told how to get in', async () => {
    db.prepare("UPDATE players SET status = 'invited' WHERE steamid = ?").run(IDS[0]);
    expect(body(await press(0, 'q:join'))).toMatch(/not active/i);
  });

  it('ready and vote only act on your own lobby', async () => {
    for (let i = 0; i < 8; i++) await press(i, 'q:join');
    const lobbyId = mm.lobbies()[0].id;
    expect(body(await press(0, `l:${lobbyId}:ready`))).toMatch(/ready/i);
    expect(mm.lobbies()[0].snapshot.ready).toEqual([IDS[0]]);
    expect(body(await press(0, 'l:lob_old_1:ready'))).toMatch(/over/i);
    for (let i = 1; i < 8; i++) await press(i, `l:${lobbyId}:ready`);
    expect(mm.lobbies()[0].snapshot.phase).toBe('map_vote');
    expect(body(await press(0, `l:${lobbyId}:vote:dead_air`))).toContain('Dead Air');
    expect(body(await press(0, `l:${lobbyId}:vote:not_a_campaign`))).toMatch(/not an option/i);
  });

  it('ready pressed during the vote says you are already ready', async () => {
    for (let i = 0; i < 8; i++) await press(i, 'q:join');
    const lobbyId = mm.lobbies()[0].id;
    for (let i = 0; i < 8; i++) await press(i, `l:${lobbyId}:ready`);
    expect(body(await press(0, `l:${lobbyId}:ready`))).toMatch(/vote/i);
  });

  it('connect answers only the roster of a live match, with the password', async () => {
    const serverId = addServer(db, { name: 's', host: '1.2.3.4', port: 27015, rconPort: 27015, rconPassword: 'x', status: 'live' });
    const matchId = Number(db.prepare(
      "INSERT INTO matches (season_id, state, campaign, server_id, token) VALUES (1, 'live', 'dead_air', ?, 'abcdef1234567890')",
    ).run(serverId).lastInsertRowid);
    const ins = db.prepare('INSERT INTO match_players (match_id, player_id, team) VALUES (?, ?, ?)');
    IDS.slice(0, 7).forEach((id, i) => ins.run(matchId, id, i < 4 ? 'a' : 'b'));
    const r = body(await press(0, `m:${matchId}:connect`));
    expect(r).toContain('password pug_abcdef12; connect 1.2.3.4:27015');
    expect(body(await press(7, `m:${matchId}:connect`))).toMatch(/not on this match/i);
  });

  it('an unknown button is answered, not ignored', async () => {
    expect(body(await press(0, 'zz:nope'))).toMatch(/no longer/i);
  });
});

describe('discord queue timeout', () => {
  it('a timed-out player is refused with when they can queue again', async () => {
    const { recordPenalty } = await import('../src/penalties.js');
    const { activeTimeout } = await import('../src/penalties.js');
    recordPenalty(db, IDS[0], 'no_show', null);
    const r = await handleButton(
      { db, matchmaker: mm, publicUrl: URL_, queueBlock: (s) => activeTimeout(db, s) ? 'timeout <t:1:R>' : null },
      { kind: 'button', customId: 'q:join', userId: did(0), userName: 'd0' },
    );
    expect(JSON.stringify(r.payload)).toContain('timeout');
    expect(mm.publicQueue().count).toBe(0);
  });
});
