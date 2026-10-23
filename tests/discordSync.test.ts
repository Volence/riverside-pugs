import { describe, it, expect, beforeEach, vi } from 'vitest';
import { openDb, type DB } from '../src/db.js';
import { Matchmaker } from '../src/matchmaker.js';
import { upsertPlayer, activatePlayer, linkDiscord } from '../src/players.js';
import { Hub } from '../src/ws.js';
import { DiscordSync } from '../src/discord/sync.js';
import { getMessage, saveMessage } from '../src/discord/messageStore.js';
import { setSetting } from '../src/settings.js';
import { FakeTransport } from './fakes/fakeTransport.js';
import type { MessagePayload } from '../src/discord/transport.js';
import type { Scheduler } from '../src/lobby.js';
import { noteMatchAborted } from '../src/matchAborts.js';
import { recordPenalty } from '../src/penalties.js';

const IDS = Array.from({ length: 8 }, (_, i) => `7656119800000000${i + 1}`);
const CH = 'queue-here';

class FakeScheduler implements Scheduler {
  timers = new Map<number, () => void>();
  private n = 1;
  set(fn: () => void): number { const id = this.n++; this.timers.set(id, fn); return id; }
  clear(id: number): void { this.timers.delete(id); }
  fireAll(): void { const f = [...this.timers.values()]; this.timers.clear(); f.forEach((x) => x()); }
}

let db: DB;
let mm: Matchmaker;
let hub: Hub;
let t: FakeTransport;
let clock: number;
let sync: DiscordSync;
let sched: FakeScheduler;

function build() {
  sync = new DiscordSync({
    db, matchmaker: mm, hub, transport: t, publicUrl: 'https://pug.test', channelId: CH,
    now: () => clock, autoSchedule: false,
  });
  return sync;
}

beforeEach(() => {
  db = openDb(':memory:');
  IDS.forEach((id, i) => {
    upsertPlayer(db, { steamid: id, name: `n${i}`, avatar: null }, []);
    activatePlayer(db, id);
    if (i < 6) linkDiscord(db, id, `90${i}`, `d${i}`);
  });
  hub = new Hub();
  sched = new FakeScheduler();
  mm = new Matchmaker(db, {
    broadcast: (e) => hub.broadcast(e),
    orchestrator: { setupMatch: async () => {}, finishMatch: async () => {} },
    scheduler: sched, rng: () => 0,
  });
  t = new FakeTransport();
  clock = 1_000_000;
});

const panelId = () => getMessage(db, 'panel', 'queue')!.message_id;
const lastLive = () => t.live()[t.live().length - 1];

describe('DiscordSync', () => {
  it('posts the panel once and reuses it after a restart', async () => {
    await build().start();
    expect(t.live()).toHaveLength(1);
    const first = panelId();
    sync.stop();
    await build().start();
    expect(t.live()).toHaveLength(1);
    expect(panelId()).toBe(first);
  });

  it('a queue change edits the panel and nothing else; an unchanged pass edits nothing', async () => {
    await build().start();
    mm.join(IDS[0]);
    await sync.pass();
    expect(t.edits).toBe(1);
    expect(JSON.stringify(t.byId(panelId())!.payload)).toContain('1/8');
    await sync.pass();
    expect(t.edits).toBe(1);
    expect(t.sends).toBe(1);
  });

  it('a panel deleted by hand is posted again', async () => {
    await build().start();
    await t.remove(CH, panelId());
    mm.join(IDS[0]);
    await sync.pass();
    expect(t.live()).toHaveLength(1);
    expect(JSON.stringify(t.live()[0].payload)).toContain('1/8');
  });

  it('a queue pop posts a pinging lobby card and moves the panel below it', async () => {
    await build().start();
    for (const id of IDS) mm.join(id);
    await sync.pass();
    const live = t.live();
    expect(live).toHaveLength(2);
    expect(live[0].payload.embeds[0].title).toMatch(/ready/i);
    expect(live[0].payload.mentionUserIds).toHaveLength(6);
    expect(live[1].id).toBe(panelId());
  });

  it('the lobby card follows ready, then vote, then becomes the match card', async () => {
    await build().start();
    for (const id of IDS) mm.join(id);
    await sync.pass();
    const card = t.live()[0].id;
    for (const id of IDS) mm.ready(id);
    await sync.pass();
    expect(t.byId(card)!.payload.embeds[0].title).toMatch(/vote/i);
    for (const id of IDS) mm.vote(id, 'dead_air');
    await sync.pass();
    const match = db.prepare('SELECT id FROM matches').get() as { id: number };
    expect(getMessage(db, 'match', String(match.id))?.message_id).toBe(card);
    expect(JSON.stringify(t.byId(card)!.payload)).toContain(`PUG #${match.id}`);
  });

  // Without an admin channel configured there is nowhere else for the outcome
  // to go, so it stays on the card. This is the pre-2026-09-20 behaviour and
  // the fallback for a server that has not set the channel.
  it('a failed ready check edits the card to name who missed it', async () => {
    await build().start();
    for (const id of IDS) mm.join(id);
    await sync.pass();
    const card = t.live()[0].id;
    mm.ready(IDS[0]);
    sched.fireAll();
    await sync.pass();
    const p = t.byId(card)!.payload;
    expect(p.embeds[0].title).toMatch(/failed/i);
    expect(p.components).toEqual([]);
  });

  // Owner, 2026-09-20: "only thing in queue-here should be the queues, keeps
  // it clean". A dead ready check is an admin's problem, not eight people's
  // scrollback, and the players who were in it are told on the site instead.
  describe('with an admin channel configured', () => {
    const ADMIN = 'admin-chan';
    beforeEach(() => setSetting(db, 'discord_admin_channel_id', ADMIN));

    it('takes a failed ready check out of the queue channel and into admin', async () => {
      await build().start();
      for (const id of IDS) mm.join(id);
      await sync.pass();
      const card = t.live()[0].id;
      mm.ready(IDS[0]);
      sched.fireAll();
      await sync.pass();

      expect(t.byId(card)!.deleted).toBe(true);
      expect(getMessage(db, 'match', 'lob_1')?.state ?? 'failed').toBe('failed');
      const posted = t.messages.filter((m) => m.channelId === ADMIN && !m.deleted);
      expect(posted).toHaveLength(1);
      expect(posted[0].payload.embeds[0].title).toMatch(/failed/i);
      // Who missed it is the whole reason an admin is reading this.
      expect(JSON.stringify(posted[0].payload)).toMatch(/not ready/i);
    });

    it('takes a cancelled lobby out of the queue channel too', async () => {
      const stale = await t.send(CH, { embeds: [{ title: 'Queue popped! Ready up' }], components: [] });
      saveMessage(db, { kind: 'match', ref: 'lob_old_1', channelId: CH, messageId: stale });
      await build().start();

      expect(t.byId(stale)!.deleted).toBe(true);
      expect(getMessage(db, 'match', 'lob_old_1')?.state).toBe('cancelled');
      expect(t.messages.filter((m) => m.channelId === ADMIN && !m.deleted)).toHaveLength(1);
    });

    it('leaves the queue panel alone', async () => {
      await build().start();
      for (const id of IDS) mm.join(id);
      await sync.pass();
      mm.ready(IDS[0]);
      sched.fireAll();
      await sync.pass();
      // The panel is the one thing that belongs in the channel.
      expect(t.live().filter((m) => m.channelId === CH)).toHaveLength(1);
      expect(getMessage(db, 'panel', 'queue')).toBeTruthy();
    });
  });

  it('retries a card edit that Discord rejected, instead of freezing it forever', async () => {
    await build().start();
    for (const id of IDS) mm.join(id);
    for (const id of IDS) mm.ready(id);
    for (const id of IDS) mm.vote(id, 'dead_air');
    await sync.pass();
    const match = db.prepare('SELECT id FROM matches').get() as { id: number };
    const cardId = getMessage(db, 'match', String(match.id))!.message_id;
    db.prepare("INSERT INTO servers (name, host, port, rcon_port, rcon_password, status) VALUES ('s','1.2.3.4',27015,27015,'x','live')").run();
    db.prepare("UPDATE matches SET state = 'live', server_id = 1, token = 'abcdef1234567890' WHERE id = ?").run(match.id);

    // The pass that first sees 'live' loses its edit to a transient failure.
    t.failEdits = 1;
    await sync.pass();
    expect(JSON.stringify(t.byId(cardId)!.payload)).not.toContain('Server is ready');

    // The next pass must put the live card up. It used to skip it: the hash of
    // the payload Discord never got was cached as if it had landed.
    await sync.pass();
    expect(JSON.stringify(t.byId(cardId)!.payload)).toContain('Server is ready');
  });

  it('pings the roster once when the server goes live, and posts one result on completion', async () => {
    await build().start();
    for (const id of IDS) mm.join(id);
    for (const id of IDS) mm.ready(id);
    for (const id of IDS) mm.vote(id, 'dead_air');
    await sync.pass();
    const match = db.prepare('SELECT id FROM matches').get() as { id: number };
    db.prepare("INSERT INTO servers (name, host, port, rcon_port, rcon_password, status) VALUES ('s','1.2.3.4',27015,27015,'x','live')").run();
    db.prepare("UPDATE matches SET state = 'live', server_id = 1, token = 'abcdef1234567890' WHERE id = ?").run(match.id);
    await sync.pass();
    await sync.pass();
    const pings = t.live().filter((m) => JSON.stringify(m.payload).includes('server is ready'));
    expect(pings).toHaveLength(1);
    expect(pings[0].payload.mentionUserIds).toHaveLength(6);

    db.prepare("UPDATE matches SET state = 'completed', winner = 'a', team_a_score = 900, team_b_score = 700, ended_at = datetime('now') WHERE id = ?").run(match.id);
    await sync.pass();
    await sync.pass();
    const results = t.live().filter((m) => m.payload.embeds[0]?.title?.includes('result'));
    expect(results).toHaveLength(1);
    expect(JSON.stringify(results[0].payload)).toContain('Team A wins');
    expect(lastLive().id).toBe(panelId());
  });

  /** Drive a queue through to a live match and return its id. */
  const toLive = async () => {
    for (const id of IDS) mm.join(id);
    for (const id of IDS) mm.ready(id);
    for (const id of IDS) mm.vote(id, 'dead_air');
    await sync.pass();
    const match = db.prepare('SELECT id FROM matches').get() as { id: number };
    db.prepare("INSERT INTO servers (name, host, port, rcon_port, rcon_password, status) VALUES ('s','1.2.3.4',27015,27015,'x','live')").run();
    db.prepare("UPDATE matches SET state = 'live', server_id = 1, token = 'abcdef1234567890' WHERE id = ?").run(match.id);
    await sync.pass();
    await sync.pass();
    return match.id;
  };

  const finish = async (matchId: number) => {
    db.prepare("UPDATE matches SET state = 'completed', winner = 'a', team_a_score = 900, team_b_score = 700, ended_at = datetime('now') WHERE id = ?").run(matchId);
    await sync.pass();
    await sync.pass();
  };

  const resultMsg = () => t.live().find((m) => m.payload.embeds[0]?.title?.includes('result'));

  it('the live ping carries no button of its own, since the match card has Connect', async () => {
    await build().start();
    await toLive();
    const ping = t.live().find((m) => JSON.stringify(m.payload).includes('server is ready'))!;
    expect(ping.payload.components).toEqual([]);
  });

  it('sends the result to the results channel and clears the match card and ping from the queue channel', async () => {
    setSetting(db, 'discord_results_channel_id', 'results');
    await build().start();
    const matchId = await toLive();
    const card = getMessage(db, 'match', String(matchId))!.message_id;
    const ping = getMessage(db, 'live', String(matchId))!.message_id;

    await finish(matchId);

    expect(resultMsg()!.channelId).toBe('results');
    expect(t.byId(card)!.deleted).toBe(true);
    expect(t.byId(ping)!.deleted).toBe(true);
    // Nothing of the finished match is left where people queue.
    expect(t.live().filter((m) => m.channelId === CH).map((m) => m.id)).toEqual([panelId()]);
  });

  it('with no results channel configured the result stays in the queue channel, and the card still goes', async () => {
    await build().start();
    const matchId = await toLive();
    const card = getMessage(db, 'match', String(matchId))!.message_id;

    await finish(matchId);

    expect(resultMsg()!.channelId).toBe(CH);
    expect(t.byId(card)!.deleted).toBe(true);
  });

  // With nowhere else to put it the card stays and is edited, the same
  // fallback closeLobbyCard takes. Deleting it would erase the only trace the
  // match happened.
  it('with no admin channel an aborted match keeps its card, but still drops the ping', async () => {
    setSetting(db, 'discord_results_channel_id', 'results');
    await build().start();
    const matchId = await toLive();
    const card = getMessage(db, 'match', String(matchId))!.message_id;
    const ping = getMessage(db, 'live', String(matchId))!.message_id;

    db.prepare("UPDATE matches SET state = 'aborted' WHERE id = ?").run(matchId);
    await sync.pass();
    await sync.pass();

    expect(t.byId(card)!.deleted).toBe(false);
    expect(JSON.stringify(t.byId(card)!.payload)).toContain('aborted');
    expect(t.byId(ping)!.deleted).toBe(true);
  });

  it('an aborted match marks its card aborted and posts no result', async () => {
    await build().start();
    for (const id of IDS) mm.join(id);
    for (const id of IDS) mm.ready(id);
    for (const id of IDS) mm.vote(id, 'dead_air');
    await sync.pass();
    const match = db.prepare('SELECT id FROM matches').get() as { id: number };
    db.prepare("UPDATE matches SET state = 'aborted' WHERE id = ?").run(match.id);
    await sync.pass();
    const card = getMessage(db, 'match', String(match.id))!;
    expect(JSON.stringify(t.byId(card.message_id)!.payload)).toContain('aborted');
    expect(t.live().some((m) => m.payload.embeds[0]?.title?.includes('result'))).toBe(false);
  });

  // Owner, 2026-09-20, after three abandons in a row: the dead rosters piled
  // up in #queue-here where the queue panel is meant to be.
  it('takes an aborted match out of the queue channel and into admin', async () => {
    setSetting(db, 'discord_admin_channel_id', 'admin-chan');
    await build().start();
    const matchId = await toLive();
    const card = getMessage(db, 'match', String(matchId))!.message_id;
    const ping = getMessage(db, 'live', String(matchId))!.message_id;

    db.prepare("UPDATE matches SET state = 'aborted' WHERE id = ?").run(matchId);
    await sync.pass();
    await sync.pass();

    expect(t.byId(card)!.deleted).toBe(true);
    expect(t.byId(ping)!.deleted).toBe(true);
    expect(getMessage(db, 'match', String(matchId))?.state).toBe('done');
    const posted = t.messages.filter((m) => m.channelId === 'admin-chan' && !m.deleted);
    expect(posted).toHaveLength(1);
    // The roster is the whole reason an admin opens this.
    expect(JSON.stringify(posted[0].payload)).toContain('aborted');
    expect(JSON.stringify(posted[0].payload)).toContain(`/match/${matchId}`);
    // A second pass must not post a duplicate.
    await sync.pass();
    expect(t.messages.filter((m) => m.channelId === 'admin-chan' && !m.deleted)).toHaveLength(1);
  });

  // Owner, 2026-10-05: "6 connected" alone sent staff to the match page to
  // find out who was missing and whether they were penalised.
  it('the admin copy of a no-show abort says why, who never got in, their side and what it cost', async () => {
    setSetting(db, 'discord_admin_channel_id', 'admin-chan');
    await build().start();
    const matchId = await toLive();
    const roster = db.prepare('SELECT player_id, team FROM match_players WHERE match_id = ? ORDER BY rowid').all(matchId) as
      { player_id: string; team: string }[];
    const [noShow, turnedAway] = roster;
    db.prepare("UPDATE matches SET state = 'aborted', abort_cause = 'no_show' WHERE id = ?").run(matchId);
    noteMatchAborted(db, { matchId, cause: 'no_show', culprits: [noShow.player_id], fileCheck: [turnedAway.player_id], requeue: false });
    recordPenalty(db, noShow.player_id, 'no_show', matchId);
    await sync.pass();
    await sync.pass();

    const text = JSON.stringify(t.messages.filter((m) => m.channelId === 'admin-chan' && !m.deleted)[0].payload);
    expect(text).toContain('Why: not enough players connected in time.');
    const nameOf = (id: string) => (db.prepare('SELECT name FROM players WHERE steamid = ?').get(id) as { name: string }).name;
    expect(text).toContain(`**${nameOf(noShow.player_id)}** (Team ${noShow.team.toUpperCase()}) never connected: 1 h queue timeout (1st no-show in 7 days)`);
    expect(text).toContain(`**${nameOf(turnedAway.player_id)}** (Team ${turnedAway.team.toUpperCase()}) never got in: rejected by the file check, so no penalty`);
  });

  it('with no admin channel an aborted card stays public and names nobody at fault', async () => {
    await build().start();
    const matchId = await toLive();
    const [noShow] = db.prepare('SELECT player_id FROM match_players WHERE match_id = ? ORDER BY rowid').all(matchId) as { player_id: string }[];
    db.prepare("UPDATE matches SET state = 'aborted', abort_cause = 'no_show' WHERE id = ?").run(matchId);
    noteMatchAborted(db, { matchId, cause: 'no_show', culprits: [noShow.player_id], requeue: false });
    await sync.pass();
    const card = getMessage(db, 'match', String(matchId))!.message_id;
    expect(JSON.stringify(t.byId(card)!.payload)).not.toContain('never connected');
  });

  it('an aborted match with a cause gets one neutral line in the queue channel, naming nobody and pinging nobody', async () => {
    setSetting(db, 'discord_admin_channel_id', 'admin-chan');
    await build().start();
    const matchId = await toLive();
    db.prepare("UPDATE matches SET state = 'aborted', abort_cause = 'abandon' WHERE id = ?").run(matchId);
    db.prepare("INSERT INTO match_abort_notices (match_id, player_id, role, requeued, created_at) VALUES (?, ?, 'innocent', 1, datetime('now'))")
      .run(matchId, IDS[0]);
    await sync.pass();
    await sync.pass();
    const lines = t.messages.filter((m) => m.channelId === CH && !m.deleted && JSON.stringify(m.payload).includes('was aborted'));
    expect(lines).toHaveLength(1);
    const text = JSON.stringify(lines[0].payload);
    expect(text).toContain(`PUG #${matchId} was aborted: a player ran out of reconnect time.`);
    expect(text).toContain('back at the front of the queue');
    expect(lines[0].payload.mentionUserIds ?? []).toEqual([]);
    // The panel is still the channel's last message.
    const live = t.live().filter((m) => m.channelId === CH);
    expect(live[live.length - 1].id).toBe(panelId());
    // It stays a few minutes, then goes.
    db.prepare("UPDATE discord_messages SET created_at = datetime('now', '-4 minutes') WHERE kind = 'aborted'").run();
    await sync.pass();
    expect(t.byId(lines[0].id)!.deleted).toBeFalsy();
    db.prepare("UPDATE discord_messages SET created_at = datetime('now', '-6 minutes') WHERE kind = 'aborted'").run();
    await sync.pass();
    expect(t.byId(lines[0].id)!.deleted).toBe(true);
  });

  it('on start, a lobby card left open by the previous process is cancelled', async () => {
    const stale = await t.send(CH, { embeds: [{ title: 'Queue popped! Ready up' }], components: [[{ kind: 'button', customId: 'l:lob_old_1:ready', label: 'Ready', style: 'success' }]] });
    saveMessage(db, { kind: 'match', ref: 'lob_old_1', channelId: CH, messageId: stale });
    await build().start();
    expect(t.byId(stale)!.payload.embeds[0].title).toMatch(/cancelled/i);
    expect(getMessage(db, 'match', 'lob_old_1')?.state).toBe('cancelled');
  });

  it('a lobby restored after a restart keeps its card', async () => {
    await build().start();
    for (const id of IDS) mm.join(id);
    await sync.pass();
    const card = t.live()[0].id;
    sync.stop();
    const mm2 = new Matchmaker(db, {
      broadcast: (e) => hub.broadcast(e),
      orchestrator: { setupMatch: async () => {}, finishMatch: async () => {} },
      scheduler: new FakeScheduler(), rng: () => 0,
    });
    mm2.restore();
    mm = mm2;
    await build().start();
    expect(t.byId(card)!.payload.embeds[0].title).toMatch(/ready/i);
    expect(t.live().filter((m) => m.payload.embeds[0]?.title?.match(/cancelled/i))).toHaveLength(0);
  });

  it('hub broadcasts schedule a pass when auto scheduling is on', async () => {
    sync = new DiscordSync({ db, matchmaker: mm, hub, transport: t, publicUrl: 'https://pug.test', channelId: CH, debounceMs: 5 });
    await sync.start();
    mm.join(IDS[0]);
    await new Promise((r) => setTimeout(r, 40));
    expect(JSON.stringify(t.byId(panelId())!.payload)).toContain('1/8');
    sync.stop();
  });
});

describe('Side games button', () => {
  const panelButtons = () => (t.byId(panelId())!.payload.components.flat() as { customId?: string }[]).map((b) => b.customId ?? '');

  it('is offered at 4 queued only while side games are on', async () => {
    await build().start();
    for (let i = 0; i < 4; i++) mm.join(IDS[i]);
    await sync.pass();
    expect(panelButtons()).not.toContain('q:side');
    setSetting(db, 'sidegames_enabled', '1');
    await sync.pass();
    expect(panelButtons()).toContain('q:side');
  });
});

describe('queue-filling alert', () => {
  const ROLE = '555000000000000001';
  const ALERT_CH = '555000000000000099';
  const setRole = (id = ROLE) => setSetting(db, 'discord_pug_role_id', id);
  /** Every message sent that pings the role, as it was when sent (an edit
   *  replaces a fake message's payload, so the live list cannot tell). */
  let pings: { channelId: string; id: string; payload: MessagePayload }[];
  const alertMsg = () => t.byId(pings[pings.length - 1].id)!;
  const alertRows = () => db.prepare("SELECT ref, state, channel_id FROM discord_messages WHERE kind = 'alert' ORDER BY id")
    .all() as { ref: string; state: string; channel_id: string }[];
  const queueTo = async (n: number) => {
    for (let i = 0; i < IDS.length; i++) {
      if (i < n) mm.join(IDS[i]);
      else mm.leave(IDS[i]);
    }
    await sync.pass();
  };
  const MIN = 60 * 1000;

  beforeEach(() => {
    pings = [];
    const send = t.send.bind(t);
    t.send = async (channelId, payload) => {
      const id = await send(channelId, payload);
      if ((payload.mentionRoleIds ?? []).length) pings.push({ channelId, id, payload: structuredClone(payload) });
      return id;
    };
  });

  it('says nothing at all when no role is configured', async () => {
    await build().start();
    await queueTo(7);
    expect(pings).toHaveLength(0);
    expect(alertRows()).toHaveLength(0);
    // And the panel offers no toggle that would do nothing.
    const panel = t.byId(panelId())!;
    const ids = panel.payload.components.flat().map((b) => ('customId' in b ? b.customId : ''));
    expect(ids).not.toContain('q:notify');
  });

  it('labels the panel toggle as a standing on/off switch once a role is set', async () => {
    setRole();
    await build().start();
    const b = t.byId(panelId())!.payload.components.flat().find((x) => x.kind === 'button' && x.customId === 'q:notify');
    expect(b && b.label).toBe('Queue alerts (on/off)');
  });

  it('treats a role id that is not a Discord id as off, button included', async () => {
    setSetting(db, 'discord_pug_role_id', 'Queue Alerts');
    await build().start();
    await queueTo(6);
    expect(pings).toHaveLength(0);
    const ids = t.byId(panelId())!.payload.components.flat().map((b) => ('customId' in b ? b.customId : ''));
    expect(ids).not.toContain('q:notify');
  });

  it('pings only the role at 6 of 8, with the count, what is needed and a way in', async () => {
    setRole();
    await build().start();
    await queueTo(5);
    expect(pings).toHaveLength(0);
    await queueTo(6);

    expect(pings).toHaveLength(1);
    const a = pings[0].payload;
    expect(a.content).toContain(`<@&${ROLE}>`);
    expect(a.content).toContain('6/8');
    expect(a.content).toContain('2 more needed');
    // Only the role. A queue alert must never mass-ping people by name.
    expect(a.mentionRoleIds).toEqual([ROLE]);
    expect(a.mentionUserIds).toEqual([]);
    const buttons = a.components.flat();
    expect(buttons.some((b) => b.kind === 'button' && b.customId === 'q:join')).toBe(true);
    expect(buttons.some((b) => b.kind === 'link' && b.url === 'https://pug.test/')).toBe(true);
    expect(pings[0].channelId).toBe(CH);
    expect(alertRows().map((r) => r.state)).toEqual(['open']);
  });

  it('follows the threshold setting', async () => {
    setRole();
    setSetting(db, 'queue_alert_threshold', '4');
    await build().start();
    await queueTo(4);
    expect(pings).toHaveLength(1);
  });

  it('keeps one alert while the queue hovers, edited to the current count without pinging', async () => {
    setRole();
    await build().start();
    await queueTo(6);
    await queueTo(5);
    await queueTo(6);
    await queueTo(7);
    expect(pings).toHaveLength(1);
    const now = alertMsg().payload;
    expect(now.content).toContain('7/8');
    expect(now.content).toContain('one more and it pops');
    // An edit never pings anyway; the allowlist says so too.
    expect(now.mentionRoleIds).toEqual([]);
  });

  it('leaves the alert alone during the ready check and closes it as "Match started" once the pop is a match', async () => {
    setRole();
    await build().start();
    await queueTo(6);
    const before = structuredClone(alertMsg().payload);
    await queueTo(8);
    expect(mm.lobbies()).toHaveLength(1);
    // The ready check could still fail: nothing is closed or edited yet.
    expect(alertMsg().payload).toEqual(before);
    expect(alertRows().map((r) => r.state)).toEqual(['open']);

    for (const id of IDS) mm.ready(id);
    await sync.pass();
    expect(alertRows().map((r) => r.state)).toEqual(['open']);
    for (const id of IDS) mm.vote(id, 'dead_air');
    await sync.pass();
    expect(mm.lobbies()).toHaveLength(0);

    expect(pings).toHaveLength(1);
    const closed = alertMsg().payload;
    expect(closed.content).toMatch(/Queue popped: match started/);
    expect(closed.content).not.toContain(`<@&${ROLE}>`);
    expect(closed.components).toEqual([]);
    expect(alertRows().map((r) => r.state)).toEqual(['popped']);
  });

  it('a failed ready check keeps the alert open, edited back to the live count, with no new ping', async () => {
    setRole();
    await build().start();
    await queueTo(6);
    await queueTo(8);
    // Seven ready, one does not: the seven go back to the front of the queue.
    for (const id of IDS.slice(0, 7)) mm.ready(id);
    sched.fireAll();
    expect(mm.lobbies()).toHaveLength(0);
    expect(mm.publicQueue().count).toBe(7);
    await sync.pass();

    expect(pings).toHaveLength(1);
    expect(alertRows().map((r) => r.state)).toEqual(['open']);
    const now = alertMsg().payload;
    expect(now.content).toContain('7/8');
    expect(now.content).toContain(`<@&${ROLE}>`);
    expect(now.mentionRoleIds).toEqual([]);
  });

  it('does not ping while a ready check is running, even past the threshold and the cooldown', async () => {
    setRole();
    await build().start();
    await queueTo(8);
    expect(mm.lobbies()).toHaveLength(1);
    // Six more people queue behind the pop.
    const more = Array.from({ length: 6 }, (_, i) => `7656119800000010${i}`);
    more.forEach((id, i) => {
      upsertPlayer(db, { steamid: id, name: `x${i}`, avatar: null }, []);
      activatePlayer(db, id);
      mm.join(id);
    });
    clock += 120 * MIN;
    await sync.pass();
    expect(mm.publicQueue().count).toBe(6);
    expect(pings).toHaveLength(0);
  });

  it('closes as popped when the whole lobby became a match between two passes', async () => {
    setRole();
    await build().start();
    await queueTo(6);
    for (let i = 6; i < 8; i++) mm.join(IDS[i]);
    for (const id of IDS) mm.ready(id);
    for (const id of IDS) mm.vote(id, 'dead_air');
    expect(mm.lobbies()).toHaveLength(0);
    await sync.pass();
    expect(alertMsg().payload.content).toMatch(/Queue popped/);
  });

  it('a pop that failed between two passes is not a match', async () => {
    setRole();
    await build().start();
    await queueTo(6);
    for (let i = 6; i < 8; i++) mm.join(IDS[i]);
    for (const id of IDS.slice(0, 6)) mm.ready(id);
    sched.fireAll();
    await sync.pass();
    expect(alertRows().map((r) => r.state)).toEqual(['open']);
    expect(alertMsg().payload.content).toContain('6/8');
  });

  it('closes the alert as "Queue emptied" when everyone leaves', async () => {
    setRole();
    await build().start();
    await queueTo(6);
    await queueTo(0);
    expect(alertMsg().payload.content).toMatch(/Queue emptied/);
    expect(alertRows().map((r) => r.state)).toEqual(['emptied']);
  });

  it('leaves the alert open through ordinary churn and closes it once the queue falls well back', async () => {
    setRole();
    await build().start();
    await queueTo(6);
    await queueTo(4);
    expect(alertRows().map((r) => r.state)).toEqual(['open']);
    await queueTo(3);
    expect(alertMsg().payload.content).toMatch(/Queue dropped to 3\/8/);
    expect(alertRows().map((r) => r.state)).toEqual(['dropped']);
  });

  it('waits out the cooldown before pinging for the next fill', async () => {
    setRole();
    await build().start();
    await queueTo(6);
    await queueTo(0);
    clock += 30 * MIN;
    await queueTo(6);
    expect(pings).toHaveLength(1);
    await queueTo(0);
    clock += 16 * MIN;
    await queueTo(6);
    expect(pings).toHaveLength(2);
  });

  it('follows the cooldown setting', async () => {
    setRole();
    setSetting(db, 'queue_alert_cooldown_minutes', '5');
    await build().start();
    await queueTo(6);
    await queueTo(0);
    clock += 6 * MIN;
    await queueTo(6);
    expect(pings).toHaveLength(2);
  });

  it('remembers the cooldown and the open alert across a restart', async () => {
    setRole();
    await build().start();
    await queueTo(6);
    await queueTo(0);
    sync.stop();

    clock += 10 * MIN;
    await build().start();
    await queueTo(6);
    expect(pings).toHaveLength(1);

    // An alert left open by the old process is still closed by the new one.
    await queueTo(0);
    clock += 60 * MIN;
    await queueTo(6);
    expect(pings).toHaveLength(2);
    sync.stop();
    await build().start();
    await queueTo(8);
    for (const id of IDS) mm.ready(id);
    for (const id of IDS) mm.vote(id, 'dead_air');
    await sync.pass();
    expect(alertMsg().payload.content).toMatch(/Queue popped/);
  });

  it('posts in the alert channel when one is set, and leaves the panel where it is', async () => {
    setRole();
    setSetting(db, 'discord_queue_alert_channel_id', ALERT_CH);
    await build().start();
    const panel = panelId();
    await queueTo(6);
    expect(pings[0].channelId).toBe(ALERT_CH);
    expect(panelId()).toBe(panel);
  });

  it('keeps the panel as the last message after an alert in the queue channel', async () => {
    setRole();
    await build().start();
    await queueTo(6);
    const live = t.live().filter((m) => m.channelId === CH);
    expect(live[live.length - 1].id).toBe(panelId());
  });

  it('closes a standing alert when alerts are turned off', async () => {
    setRole();
    await build().start();
    await queueTo(6);
    setSetting(db, 'discord_pug_role_id', '');
    await sync.pass();
    expect(alertRows().map((r) => r.state)).toEqual(['off']);
    const closed = alertMsg().payload.content!;
    expect(closed).toMatch(/Queue alerts turned off/);
    // Neutral: the queue itself did nothing.
    expect(closed).not.toMatch(/dropped|emptied|popped/i);
    expect(closed).not.toContain(`<@&${ROLE}>`);
  });

  it('a Discord failure does not retry on every pass for the rest of the evening', async () => {
    setRole();
    await build().start();
    t.failSends = 1;
    await queueTo(6);
    await sync.pass();
    await queueTo(7);
    expect(pings).toHaveLength(0);
    expect(alertRows().map((r) => r.state)).toEqual(['failed']);
  });

  it('a post whose first save throws is still recorded open, with its id, and closed later', async () => {
    setRole();
    await build().start();
    const prepare = db.prepare.bind(db);
    let throwOnce = true;
    db.prepare = ((sql: string) => {
      if (throwOnce && sql.includes('INSERT INTO discord_messages')) {
        throwOnce = false;
        throw new Error('database is locked');
      }
      return prepare(sql);
    }) as typeof db.prepare;
    await queueTo(6);
    db.prepare = prepare as typeof db.prepare;

    expect(pings).toHaveLength(1);
    const row = db.prepare("SELECT message_id, state FROM discord_messages WHERE kind = 'alert'").get() as { message_id: string; state: string };
    expect(row).toEqual({ message_id: pings[0].id, state: 'open' });
    await queueTo(0);
    expect(alertMsg().payload.content).toMatch(/Queue emptied/);
  });

  it('a save that keeps failing after a post is logged, and the pass carries on to the panel', async () => {
    setRole();
    await build().start();
    const errors: string[] = [];
    const spy = vi.spyOn(console, 'error').mockImplementation((msg: unknown) => { errors.push(String(msg)); });
    const prepare = db.prepare.bind(db);
    let failures = 2; // the alert's save, then the fallback save
    db.prepare = ((sql: string) => {
      if (failures > 0 && pings.length > 0 && sql.includes('INSERT INTO discord_messages')) {
        failures--;
        throw new Error('database is locked');
      }
      return prepare(sql);
    }) as typeof db.prepare;
    await queueTo(6);
    db.prepare = prepare as typeof db.prepare;
    spy.mockRestore();

    expect(failures).toBe(0);
    expect(errors).toContain('[discord] recording the queue alert failed:');
    expect(errors).not.toContain('[discord] sync pass failed:');
    // The panel still went up below the alert.
    expect(JSON.stringify(t.byId(panelId())!.payload)).toContain('6/8');
  });

  it('a hand-deleted alert is not re-posted (that would ping again)', async () => {
    setRole();
    await build().start();
    await queueTo(6);
    alertMsg().deleted = true;
    await queueTo(7);
    expect(pings).toHaveLength(1);
    expect(alertRows().map((r) => r.state)).toEqual(['removed']);
  });
});
