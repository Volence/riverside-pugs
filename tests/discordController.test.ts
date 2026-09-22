import { describe, it, expect, beforeEach } from 'vitest';
import { openDb, type DB } from '../src/db.js';
import { Matchmaker } from '../src/matchmaker.js';
import { upsertPlayer, activatePlayer, linkDiscord, consumeLinkCode } from '../src/players.js';
import { addServer } from '../src/serverPool.js';
import { handleButton } from '../src/discord/controller.js';
import type { Scheduler } from '../src/lobby.js';
import type { InteractionReply } from '../src/discord/transport.js';
import { setSetting } from '../src/settings.js';
import { FakeTransport } from './fakes/fakeTransport.js';

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
  handleButton({ db, matchmaker: mm, publicUrl: URL_ }, { kind: 'button', customId, userId: did(i), userName, presserTimedOutUntil: null });
const body = (r: InteractionReply) => JSON.stringify(r.payload);

describe('discord buttons', () => {
  it('every reply is ephemeral', async () => {
    expect((await press(0, 'q:join')).ephemeral).toBe(true);
  });

  it('an unlinked user gets a one-time link to connect Steam', async () => {
    const r = await handleButton(
      { db, matchmaker: mm, publicUrl: URL_ },
      { kind: 'button', customId: 'q:join', userId: 'stranger', userName: 'Stranger', presserTimedOutUntil: null },
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

  it('an account that has been merged into another cannot queue from Discord, even with a row left over', async () => {
    const { addAlias } = await import('../src/aliases.js');
    addAlias(db, { steamid: IDS[0], canonical: IDS[1], by: 'test' });
    expect(body(await press(0, 'q:join'))).toMatch(/merged into another/i);
    expect(mm.publicQueue().count).toBe(0);
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

  it('ready is refused with the reason when the ready gate blocks, and nothing is marked', async () => {
    const { VoicePresence } = await import('../src/discord/voicePresence.js');
    const { makeReadyGate } = await import('../src/readyGate.js');
    const voice = new VoicePresence();
    voice.setAll([[did(1), 'chan']]);
    mm = new Matchmaker(db, {
      broadcast: () => {}, orchestrator: { setupMatch: async () => {}, finishMatch: async () => {} },
      scheduler: sched, rng: () => 0, readyGate: makeReadyGate(db, true, voice),
    });
    for (const id of IDS) mm.join(id);
    const lobbyId = mm.lobbies()[0].id;
    expect(body(await press(0, `l:${lobbyId}:ready`))).toMatch(/join a voice channel in the Riverside Discord first/);
    expect(mm.lobbies()[0].snapshot.ready).toEqual([]);
    expect(body(await press(1, `l:${lobbyId}:ready`))).toMatch(/You are ready/);
    expect(mm.lobbies()[0].snapshot.ready).toEqual([IDS[1]]);
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
      { kind: 'button', customId: 'q:join', userId: did(0), userName: 'd0', presserTimedOutUntil: null },
    );
    expect(JSON.stringify(r.payload)).toContain('timeout');
    expect(mm.publicQueue().count).toBe(0);
  });
});

describe('spectate button', () => {
  it('is public and gives the SourceTV line for a live match', async () => {
    const serverId = addServer(db, { name: 's', host: '1.2.3.4', port: 27015, rconPort: 27015, rconPassword: 'x', status: 'live' });
    db.prepare("UPDATE servers SET tv_enabled = 1, tv_port = 27020, tv_password = 'dunged' WHERE id = ?").run(serverId);
    const matchId = Number(db.prepare(
      "INSERT INTO matches (season_id, state, campaign, server_id, token) VALUES (1, 'live', 'dead_air', ?, 'abcdef1234567890')",
    ).run(serverId).lastInsertRowid);
    // Nobody from the roster: anyone may watch.
    const r = await press(7, `m:${matchId}:spectate`);
    expect(JSON.stringify(r.payload)).toContain('connect 1.2.3.4:27020');
    expect(JSON.stringify(r.payload)).toContain('30 seconds behind');
    db.prepare('UPDATE servers SET tv_enabled = 0 WHERE id = ?').run(serverId);
    expect(JSON.stringify(await press(7, `m:${matchId}:spectate`))).toMatch(/no SourceTV/);
  });
});

describe('queue alert opt-in toggle', () => {
  const ROLE = '55501';
  let roles: FakeTransport['roles'];
  let t: FakeTransport;

  const toggle = (userId: string) => handleButton(
    { db, matchmaker: mm, publicUrl: URL_, roles },
    { kind: 'button', customId: 'q:notify', userId, userName: 'someone', presserTimedOutUntil: null },
  );

  beforeEach(() => {
    t = new FakeTransport();
    roles = t.roles;
    setSetting(db, 'discord_pug_role_id', ROLE);
  });

  it('adds the role, then removes it on a second press', async () => {
    const on = await toggle(did(0));
    expect(on.ephemeral).toBe(true);
    expect(body(on)).toMatch(/will be pinged/i);
    expect(t.rolesOf.get(did(0))?.has(ROLE)).toBe(true);

    const off = await toggle(did(0));
    expect(body(off)).toMatch(/no longer be pinged/i);
    expect(t.rolesOf.get(did(0))?.has(ROLE)).toBe(false);
  });

  it('works for someone who has not linked a Steam account', async () => {
    // Wanting to know when games are filling is not the same as being ready to
    // play one, and an unlinked person is exactly who the nudge is for.
    const r = await toggle('never-seen-before');
    expect(body(r)).toMatch(/will be pinged/i);
    expect(t.rolesOf.get('never-seen-before')?.has(ROLE)).toBe(true);
  });

  it('says so instead of failing when no role is configured', async () => {
    setSetting(db, 'discord_pug_role_id', '');
    const r = await toggle(did(0));
    expect(body(r)).toMatch(/not set up/i);
  });

  it('does not guess when it cannot read the member', async () => {
    // "Could not tell" and "does not have it" lead to opposite replies, and
    // guessing tells someone they were removed from a role they still hold.
    t.rolesUnreadable.add(did(1));
    const r = await toggle(did(1));
    expect(body(r)).toMatch(/could not read your roles/i);
    expect(t.rolesOf.get(did(1))?.has(ROLE)).toBeFalsy();
  });

  it('points at the real cause when Discord refuses the change', async () => {
    const failing = {
      has: async () => false,
      add: async () => { throw new Error('Missing Permissions'); },
      remove: async () => {},
    };
    const r = await handleButton(
      { db, matchmaker: mm, publicUrl: URL_, roles: failing },
      { kind: 'button', customId: 'q:notify', userId: did(2), userName: 'x', presserTimedOutUntil: null },
    );
    // Nearly always the bot's role sitting below the target role, which no
    // amount of retrying fixes.
    expect(body(r)).toMatch(/role above the alert role/i);
  });
});

describe('endorse buttons', () => {
  const STRANGER_SID = '76561198000000099';

  function seedCompleted(id: number, hoursAgo = 0): void {
    db.prepare(
      `INSERT INTO matches (id, season_id, state, campaign, winner, ended_at)
       VALUES (?, 1, 'completed', 'no_mercy', 'a', datetime('now', ?))`,
    ).run(id, `-${hoursAgo} hours`);
    IDS.forEach((p, i) => {
      db.prepare('INSERT INTO match_players (match_id, player_id, team) VALUES (?, ?, ?)').run(id, p, i < 4 ? 'a' : 'b');
    });
  }
  const given = () => db.prepare('SELECT match_id, from_id, to_id, kind FROM endorsements ORDER BY to_id').all();
  const ids = (r: InteractionReply) => r.payload.components.flat().map((b) => (b.kind === 'button' ? b.customId : ''));

  it('opens a private picker of the seven other players', async () => {
    seedCompleted(5);
    const r = await press(0, 'm:5:endorse');
    expect(r.ephemeral).toBe(true);
    expect(ids(r)).toHaveLength(7);
    expect(ids(r)).not.toContain(`e:5:p:${IDS[0]}`);
  });

  it('pick a player, pick a kind, and it is recorded against the LINKED player', async () => {
    seedCompleted(5);
    const kinds = await press(0, `e:5:p:${IDS[5]}`);
    expect(ids(kinds)).toContain(`e:5:k:${IDS[5]}:clutch`);
    const after = await press(0, `e:5:k:${IDS[5]}:clutch`);
    expect(given()).toEqual([{ match_id: 5, from_id: IDS[0], to_id: IDS[5], kind: 'clutch' }]);
    // Back on the picker, in place, showing what remains.
    expect(body(after)).toContain('1 of 2');
    expect(body(after)).toContain('Clutch');
  });

  it('tells somebody who was not on the roster so, and changes nothing', async () => {
    seedCompleted(5);
    upsertPlayer(db, { steamid: STRANGER_SID, name: 'stranger', avatar: null }, []);
    activatePlayer(db, STRANGER_SID);
    linkDiscord(db, STRANGER_SID, 'd-stranger', 'stranger');
    const hit = (customId: string) => handleButton(
      { db, matchmaker: mm, publicUrl: URL_ }, { kind: 'button', customId, userId: 'd-stranger', userName: 'stranger', presserTimedOutUntil: null },
    );
    expect(body(await hit('m:5:endorse'))).toMatch(/not in this match/i);
    expect(body(await hit(`e:5:k:${IDS[5]}:clutch`))).toMatch(/not in this match/i);
    expect(given()).toEqual([]);
  });

  it('an unlinked Discord user is asked to link, and nothing is written', async () => {
    seedCompleted(5);
    const r = await handleButton(
      { db, matchmaker: mm, publicUrl: URL_ },
      { kind: 'button', customId: `e:5:k:${IDS[5]}:clutch`, userId: 'nobody', userName: 'Nobody', presserTimedOutUntil: null },
    );
    expect(r.payload.components.flat().some((b) => b.kind === 'link' && b.url.includes('/link/discord'))).toBe(true);
    expect(given()).toEqual([]);
  });

  it('a third click cannot overspend the budget', async () => {
    seedCompleted(5);
    await press(0, `e:5:k:${IDS[1]}:caller`);
    await press(0, `e:5:k:${IDS[2]}:caller`);
    const third = await press(0, `e:5:k:${IDS[3]}:caller`);
    expect(given()).toHaveLength(2);
    expect(body(third)).toMatch(/no endorsements left/i);
  });

  it('says so when the window has closed', async () => {
    seedCompleted(5, 30);
    expect(body(await press(0, 'm:5:endorse'))).toMatch(/closed/i);
  });

  it('cannot be aimed at oneself through a crafted custom id', async () => {
    seedCompleted(5);
    await press(0, `e:5:k:${IDS[0]}:caller`);
    expect(given()).toEqual([]);
  });
});
