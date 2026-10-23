import { describe, it, expect } from 'vitest';
import { openDb } from '../src/db.js';
import { voiceJoinWakes } from '../src/server.js';
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
