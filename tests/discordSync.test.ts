import { describe, it, expect, beforeEach } from 'vitest';
import { openDb, type DB } from '../src/db.js';
import { Matchmaker } from '../src/matchmaker.js';
import { upsertPlayer, activatePlayer, linkDiscord } from '../src/players.js';
import { Hub } from '../src/ws.js';
import { DiscordSync } from '../src/discord/sync.js';
import { getMessage, saveMessage } from '../src/discord/messageStore.js';
import { setSetting } from '../src/settings.js';
import { FakeTransport } from './fakes/fakeTransport.js';
import type { Scheduler } from '../src/lobby.js';

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

describe('queue-filling alert', () => {
  const ROLE = '55501';
  const setRole = (id = ROLE) => setSetting(db, 'discord_pug_role_id', id);
  /** Messages that ping the alert role. */
  const alerts = () => t.live().filter((m) => (m.payload.mentionRoleIds ?? []).includes(ROLE));
  const fill = async (n: number) => {
    for (let i = 0; i < n; i++) mm.join(IDS[i]);
    await sync.pass();
  };

  beforeEach(() => { setSetting(db, 'discord_queue_thresholds', JSON.stringify([4, 6])); });

  it('says nothing at all when no role is configured', async () => {
    await build().start();
    await fill(6);
    expect(alerts()).toHaveLength(0);
    // And the panel offers no toggle that would do nothing.
    const panel = t.live().find((m) => m.payload.components.length > 0)!;
    const ids = panel.payload.components.flat().map((b) => ('customId' in b ? b.customId : ''));
    expect(ids).not.toContain('q:notify');
  });

  it('pings the role once the queue reaches a threshold', async () => {
    setRole();
    await build().start();
    await fill(4);

    expect(alerts()).toHaveLength(1);
    const a = alerts()[0];
    expect(a.payload.content).toContain(`<@&${ROLE}>`);
    expect(a.payload.content).toContain('4/8');
    // Only the role. A queue alert must never mass-ping people by name.
    expect(a.payload.mentionUserIds).toEqual([]);
  });

  it('does not re-announce the same threshold while the queue hovers there', async () => {
    setRole();
    await build().start();
    await fill(4);
    expect(alerts()).toHaveLength(1);

    // Somebody leaves and comes back: the classic way a useful ping becomes a
    // muted channel.
    mm.leave(IDS[3]);
    await sync.pass();
    mm.join(IDS[3]);
    await sync.pass();

    expect(alerts()).toHaveLength(1);
  });

  it('announces the highest threshold reached, even if a pass skips one', async () => {
    setRole();
    await build().start();
    // The sync loop is periodic and does not see every join, so a pass can go
    // straight from empty to 6.
    await fill(6);
    expect(alerts()).toHaveLength(1);
    expect(alerts()[0].payload.content).toContain('6/8');
  });

  it('drops a second threshold inside the cooldown rather than firing twice', async () => {
    setRole();
    await build().start();
    await fill(4);
    expect(alerts()).toHaveLength(1);

    for (let i = 4; i < 6; i++) mm.join(IDS[i]);
    await sync.pass();
    expect(alerts()).toHaveLength(1);
  });

  it('announces a higher threshold once the cooldown has passed', async () => {
    setRole();
    await build().start();
    await fill(4);
    clock += 11 * 60 * 1000;
    for (let i = 4; i < 6; i++) mm.join(IDS[i]);
    await sync.pass();

    expect(alerts()).toHaveLength(2);
    expect(alerts()[1].payload.content).toContain('6/8');
  });

  it('re-arms only once the queue has actually emptied', async () => {
    setRole();
    await build().start();
    await fill(4);
    clock += 11 * 60 * 1000;

    // Down to 1, which is churn, not a new fill.
    for (let i = 1; i < 4; i++) mm.leave(IDS[i]);
    await sync.pass();
    for (let i = 1; i < 4; i++) mm.join(IDS[i]);
    await sync.pass();
    expect(alerts()).toHaveLength(1);

    // Empty: the next fill is a new one and may announce again.
    for (let i = 0; i < 4; i++) mm.leave(IDS[i]);
    await sync.pass();
    await fill(4);
    expect(alerts()).toHaveLength(2);
  });

  it('never announces a full queue, which pops on its own', async () => {
    setRole();
    setSetting(db, 'discord_queue_thresholds', JSON.stringify([4, 8]));
    await build().start();
    await fill(4);
    const before = alerts().length;
    clock += 11 * 60 * 1000;
    for (let i = 4; i < 8; i++) mm.join(IDS[i]);
    await sync.pass();
    // 8 is the queue size: it pops into a lobby and everyone gets a real ping.
    expect(alerts()).toHaveLength(before);
  });

  it('keeps the panel as the last message after an alert', async () => {
    setRole();
    await build().start();
    await fill(4);
    const live = t.live();
    expect(live[live.length - 1].id).toBe(panelId());
  });

  it('a Discord failure does not retry on every pass for the rest of the evening', async () => {
    setRole();
    await build().start();
    t.failSends = 1;
    await fill(4);
    // The send threw; the threshold is still marked done.
    await sync.pass();
    await sync.pass();
    expect(alerts()).toHaveLength(0);
  });
});
