import { describe, it, expect, beforeEach } from 'vitest';
import { openDb, type DB } from '../src/db.js';
import { upsertPlayer, activatePlayer, linkDiscord } from '../src/players.js';
import { setSetting } from '../src/settings.js';
import { Matchmaker } from '../src/matchmaker.js';
import { GuildMembership } from '../src/discord/membership.js';
import { makeQueueGate } from '../src/queueGate.js';

const P = '76561198000000001';
let db: DB;
let members: GuildMembership;
let mm: Matchmaker;

beforeEach(() => {
  db = openDb(':memory:');
  upsertPlayer(db, { steamid: P, name: 'alice', avatar: null }, []);
  activatePlayer(db, P);
  members = new GuildMembership();
  mm = new Matchmaker(db, {
    broadcast: () => {}, orchestrator: { setupMatch: async () => {}, finishMatch: async () => {} },
    queueGate: makeQueueGate(db, true, members),
  });
});

describe('queue gate', () => {
  it('an unlinked player cannot queue, and the site state says why', () => {
    members.setAll([]);
    const r = mm.join(P);
    expect(r).toEqual({ ok: false, error: 'link your Discord account first' });
    expect(mm.stateFor(P).queueBlock).toBe('link_discord');
    expect(mm.publicQueue().count).toBe(0);
  });

  it('a linked player not in the server cannot queue', () => {
    linkDiscord(db, P, '111', 'alice');
    members.setAll(['222']);
    expect(mm.join(P).error).toBe('join the Riverside Discord server first');
    expect(mm.stateFor(P).queueBlock).toBe('join_discord');
  });

  it('a linked member queues; leaving the server blocks, rejoining unblocks', () => {
    linkDiscord(db, P, '111', 'alice');
    members.setAll(['111']);
    expect(mm.stateFor(P).queueBlock).toBeNull();
    expect(mm.join(P).ok).toBe(true);
    mm.leave(P);
    members.remove('111');
    expect(mm.join(P).ok).toBe(false);
    members.add('111');
    expect(mm.join(P).ok).toBe(true);
  });

  it('unknown membership (bot not ready) allows a linked player', () => {
    linkDiscord(db, P, '111', 'alice');
    expect(mm.join(P).ok).toBe(true);
  });

  it('is off when the setting is off or Discord is unconfigured', () => {
    setSetting(db, 'require_discord_to_queue', '0');
    expect(makeQueueGate(db, true, members)(P)).toBeNull();
    setSetting(db, 'require_discord_to_queue', '1');
    expect(makeQueueGate(db, false, members)(P)).toBeNull();
  });

  it('onAdd listeners hear joins', () => {
    const seen: string[] = [];
    members.onAdd((id) => seen.push(id));
    members.setAll([]);
    members.add('9');
    expect(seen).toEqual(['9']);
    expect(members.isMember('9')).toBe(true);
  });
});
