import type { DB } from '../db.js';

/** Which bot message is which, persisted so a restart edits the existing
 *  messages instead of posting a second panel and duplicate match cards.
 *
 *  kind: 'panel' (ref 'queue'), 'match' (ref a lobby id, then the match id
 *  once the lobby becomes a match), 'result' (ref the match id). */
export interface StoredMessage {
  kind: string;
  ref: string;
  channel_id: string;
  message_id: string;
  state: string;
}

export function getMessage(db: DB, kind: string, ref: string): StoredMessage | undefined {
  return db.prepare('SELECT kind, ref, channel_id, message_id, state FROM discord_messages WHERE kind = ? AND ref = ?')
    .get(kind, ref) as StoredMessage | undefined;
}

export function saveMessage(db: DB, m: { kind: string; ref: string; channelId: string; messageId: string; state?: string }): void {
  db.prepare(
    `INSERT INTO discord_messages (kind, ref, channel_id, message_id, state)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(kind, ref) DO UPDATE SET channel_id = excluded.channel_id, message_id = excluded.message_id,
       state = excluded.state, updated_at = datetime('now')`,
  ).run(m.kind, m.ref, m.channelId, m.messageId, m.state ?? 'open');
}

export function setMessageState(db: DB, kind: string, ref: string, state: string): void {
  db.prepare("UPDATE discord_messages SET state = ?, updated_at = datetime('now') WHERE kind = ? AND ref = ?")
    .run(state, kind, ref);
}

/** Move a message to a new ref (a lobby's card becoming the match's card). */
export function rekeyMessage(db: DB, kind: string, fromRef: string, toRef: string): void {
  db.prepare("UPDATE discord_messages SET ref = ?, updated_at = datetime('now') WHERE kind = ? AND ref = ?")
    .run(toRef, kind, fromRef);
}

export function messagesInState(db: DB, kind: string, state: string): StoredMessage[] {
  return db.prepare('SELECT kind, ref, channel_id, message_id, state FROM discord_messages WHERE kind = ? AND state = ?')
    .all(kind, state) as StoredMessage[];
}
