import { describe, it, expect, beforeEach } from 'vitest';
import { openDb, type DB } from '../src/db.js';
import { upsertPlayer, activatePlayer, linkDiscord } from '../src/players.js';
import { setSetting } from '../src/settings.js';
import { Matchmaker } from '../src/matchmaker.js';
import { VoicePresence } from '../src/discord/voicePresence.js';
import { makeReadyGate } from '../src/readyGate.js';
import type { Scheduler } from '../src/lobby.js';

const IDS = Array.from({ length: 8 }, (_, i) => `7656119800000000${i + 1}`);
const did = (i: number) => `90${i}`;

class FakeScheduler implements Scheduler {
  timers = new Map<number, () => void>();
  private n = 1;
  set(fn: () => void): number { const id = this.n++; this.timers.set(id, fn); return id; }
  clear(id: number): void { this.timers.delete(id); }
  fireAll(): void { const f = [...this.timers.values()]; this.timers.clear(); f.forEach((x) => x()); }
}

let db: DB;
let voice: VoicePresence;
let mm: Matchmaker;
let sched: FakeScheduler;

/** Everyone except the eighth player has Discord linked. */
beforeEach(() => {
  db = openDb(':memory:');
  IDS.forEach((id, i) => {
    upsertPlayer(db, { steamid: id, name: `n${i}`, avatar: null }, []);
    activatePlayer(db, id);
    if (i < 7) linkDiscord(db, id, did(i), `d${i}`);
  });
  voice = new VoicePresence();
  sched = new FakeScheduler();
  mm = new Matchmaker(db, {
    broadcast: () => {}, orchestrator: { setupMatch: async () => {}, finishMatch: async () => {} },
    scheduler: sched,
    readyGate: makeReadyGate(db, true, voice),
  });
});

const pop = () => { for (const id of IDS) mm.join(id); };

describe('ready gate', () => {
  it('the setting is on by default', () => {
    expect(db.prepare("SELECT value FROM settings WHERE key = 'require_voice_to_ready'").get()).toEqual({ value: '1' });
  });

  it('a player not in a voice channel cannot ready, and the state says why', () => {
    voice.setAll([]);
    pop();
    expect(mm.ready(IDS[0])).toEqual({ ok: false, error: 'join a voice channel in the Riverside Discord first' });
    expect(mm.stateFor(IDS[0]).readyBlock).toBe('join_voice');
    expect(mm.lobbies()[0].snapshot.ready).toEqual([]);
  });

  it('a player in any voice channel readies', () => {
    voice.setAll([[did(0), 'lobby-chan']]);
    pop();
    expect(mm.ready(IDS[0])).toEqual({ ok: true });
    expect(mm.stateFor(IDS[0]).readyBlock).toBeNull();
    expect(mm.lobbies()[0].snapshot.ready).toEqual([IDS[0]]);
  });

  it('a player with no Discord linked is told to link first', () => {
    voice.setAll([]);
    pop();
    expect(mm.ready(IDS[7]).error).toBe('link your Discord account first');
    expect(mm.stateFor(IDS[7]).readyBlock).toBe('link_discord');
  });

  it('unknown presence (bot not connected) allows a linked player', () => {
    pop();
    expect(mm.ready(IDS[0]).ok).toBe(true);
    expect(mm.stateFor(IDS[0]).readyBlock).toBeNull();
  });

  it('is off when the setting is off or Discord is unconfigured', () => {
    voice.setAll([]);
    setSetting(db, 'require_voice_to_ready', '0');
    expect(makeReadyGate(db, true, voice)(IDS[0])).toBeNull();
    setSetting(db, 'require_voice_to_ready', '1');
    expect(makeReadyGate(db, false, voice)(IDS[0])).toBeNull();
    expect(makeReadyGate(db, true, voice)(IDS[0])).toBe('join_voice');
  });

  it('with no gate wired at all, ready is unconditional', () => {
    const plain = new Matchmaker(db, {
      broadcast: () => {}, orchestrator: { setupMatch: async () => {}, finishMatch: async () => {} }, scheduler: sched,
    });
    for (const id of IDS) plain.join(id);
    expect(plain.ready(IDS[7])).toEqual({ ok: true });
    expect(plain.stateFor(IDS[7]).readyBlock).toBeNull();
  });

  it('ready outside a ready check still says so', () => {
    expect(mm.ready(IDS[0])).toEqual({ ok: false, error: 'no ready check active' });
  });

  it('the lobby roster carries each player\'s block so teammates see who is missing from voice', () => {
    voice.setAll([[did(0), 'a']]);
    pop();
    const players = mm.stateFor(IDS[0]).lobby!.players;
    expect(players.find((p) => p.steamid === IDS[0])!.readyBlock).toBeNull();
    expect(players.find((p) => p.steamid === IDS[1])!.readyBlock).toBe('join_voice');
    expect(players.find((p) => p.steamid === IDS[7])!.readyBlock).toBe('link_discord');
  });
});

describe('leaving voice during the ready check', () => {
  it('un-readies the player, who has to press Ready again', () => {
    voice.setAll([[did(0), 'a'], [did(1), 'a']]);
    pop();
    mm.ready(IDS[0]);
    mm.ready(IDS[1]);
    expect(mm.unready(IDS[0])).toBe(true);
    expect(mm.lobbies()[0].snapshot.ready).toEqual([IDS[1]]);
    voice.update(did(0), 'a');
    expect(mm.ready(IDS[0]).ok).toBe(true);
    expect(mm.lobbies()[0].snapshot.ready).toEqual([IDS[1], IDS[0]]);
  });

  it('does nothing once the vote has started, or for someone not in a lobby', () => {
    linkDiscord(db, IDS[7], did(7), 'd7');
    voice.setAll(IDS.map((_, i) => [did(i), 'a'] as [string, string]));
    pop();
    for (const id of IDS) mm.ready(id);
    expect(mm.lobbies()[0].snapshot.phase).toBe('map_vote');
    expect(mm.unready(IDS[0])).toBe(false);
    expect(mm.lobbies()[0].snapshot.ready).toHaveLength(8);
    expect(mm.unready('nobody')).toBe(false);
  });
});
