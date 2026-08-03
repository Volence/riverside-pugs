import type { DB } from './db.js';
import { getSetting } from './settings.js';

export type FetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string },
) => Promise<unknown>;

/** Fire-and-forget Discord webhook message. No-op when discord_webhook_url is
 *  unset or empty; never throws (a dead webhook must not break matchmaking). */
export function notifyDiscord(db: DB, content: string, fetchFn: FetchLike = fetch as unknown as FetchLike): void {
  try {
    const url = getSetting(db, 'discord_webhook_url');
    if (!url) return;
    Promise.resolve(
      fetchFn(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ content }),
      }),
    ).catch((err) => console.error('[discord] webhook post failed:', err));
  } catch (err) {
    console.error('[discord] webhook post failed:', err);
  }
}
