import { describe, it, expect } from 'vitest';
import { openDb } from '../src/db.js';
import { onGuildMemberAdd, voiceJoinWakes } from '../src/server.js';
import { upsertPlayer } from '../src/players.js';

describe('voiceJoinWakes', () => {
  it('wakes browsers only for a linked player who is in a lobby', () => {
    const db = openDb(':memory:');
    const A = '76561198000000001';
    const B = '76561198000000002';
    upsertPlayer(db, { steamid: A, name: 'a', avatar: null }, []);
    upsertPlayer(db, { steamid: B, name: 'b', avatar: null }, []);
    db.prepare("UPDATE players SET discord_id = 'd-a' WHERE steamid = ?").run(A);
    db.prepare("UPDATE players SET discord_id = 'd-b' WHERE steamid = ?").run(B);
    expect(voiceJoinWakes(db, [A], 'd-a')).toBe(true);
    expect(voiceJoinWakes(db, [A], 'd-b')).toBe(false);   // linked, not in a lobby
    expect(voiceJoinWakes(db, [A], 'd-nobody')).toBe(false); // not linked at all
  });
});

describe('onGuildMemberAdd', () => {
  const setup = () => {
    const db = openDb(':memory:');
    const A = '76561198000000001';
    upsertPlayer(db, { steamid: A, name: 'a', avatar: null }, []);
    db.prepare("UPDATE players SET discord_id = 'd-a', status = 'invited' WHERE steamid = ?").run(A);
    return { db, A };
  };

  it('gates an invited linked player, then broadcasts', async () => {
    const { db, A } = setup();
    const order: string[] = [];
    await onGuildMemberAdd(db, 'd-a', async (s) => { order.push(`gate ${s}`); }, () => order.push('refresh'));
    expect(order).toEqual([`gate ${A}`, 'refresh']);
  });

  it('broadcasts for an active linked player without gating, and not at all for a stranger', async () => {
    const { db, A } = setup();
    db.prepare("UPDATE players SET status = 'active' WHERE steamid = ?").run(A);
    const order: string[] = [];
    await onGuildMemberAdd(db, 'd-a', async () => { order.push('gate'); }, () => order.push('refresh'));
    await onGuildMemberAdd(db, 'd-nobody', async () => { order.push('gate'); }, () => order.push('refresh'));
    expect(order).toEqual(['refresh']);
  });
});
