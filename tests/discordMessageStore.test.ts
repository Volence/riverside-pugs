import { describe, it, expect } from 'vitest';
import { openDb } from '../src/db.js';
import { getMessage, saveMessage, setMessageState, rekeyMessage, messagesInState } from '../src/discord/messageStore.js';

describe('discord message store', () => {
  it('round trips, upserts, changes state and rekeys', () => {
    const db = openDb(':memory:');
    saveMessage(db, { kind: 'panel', ref: 'queue', channelId: 'c', messageId: 'm1' });
    expect(getMessage(db, 'panel', 'queue')).toMatchObject({ message_id: 'm1', state: 'open' });
    saveMessage(db, { kind: 'panel', ref: 'queue', channelId: 'c', messageId: 'm2' });
    expect(getMessage(db, 'panel', 'queue')?.message_id).toBe('m2');

    saveMessage(db, { kind: 'match', ref: 'lob_x_1', channelId: 'c', messageId: 'm3' });
    rekeyMessage(db, 'match', 'lob_x_1', '42');
    expect(getMessage(db, 'match', 'lob_x_1')).toBeUndefined();
    expect(getMessage(db, 'match', '42')?.message_id).toBe('m3');

    expect(messagesInState(db, 'match', 'open').map((m) => m.ref)).toEqual(['42']);
    setMessageState(db, 'match', '42', 'done');
    expect(messagesInState(db, 'match', 'open')).toEqual([]);
  });
});
