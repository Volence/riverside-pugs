import { describe, it, expect, beforeEach } from 'vitest';
import { openDb, type DB } from '../src/db.js';
import { Matchmaker } from '../src/matchmaker.js';
import { upsertPlayer, activatePlayer, linkDiscord } from '../src/players.js';
import { Hub } from '../src/ws.js';
import { DiscordSync } from '../src/discord/sync.js';
import { getMessage, saveMessage } from '../src/discord/messageStore.js';
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
