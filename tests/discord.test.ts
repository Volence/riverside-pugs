import { describe, it, expect, beforeEach, vi } from 'vitest';
import { openDb, type DB } from '../src/db.js';
import { setSetting } from '../src/settings.js';
import { notifyDiscord } from '../src/discord.js';

describe('notifyDiscord', () => {
  let db: DB;
  beforeEach(() => { db = openDb(':memory:'); });

  it('no-ops when webhook url is unset/empty', () => {
    const fetchFn = vi.fn();
    notifyDiscord(db, 'hello', fetchFn);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('POSTs {content} to the configured webhook', () => {
    setSetting(db, 'discord_webhook_url', 'https://discord.test/hook');
    const fetchFn = vi.fn().mockResolvedValue({ ok: true });
    notifyDiscord(db, 'match live', fetchFn);
    expect(fetchFn).toHaveBeenCalledWith('https://discord.test/hook', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: 'match live' }),
    });
  });

  it('swallows fetch failures', async () => {
    setSetting(db, 'discord_webhook_url', 'https://discord.test/hook');
    const fetchFn = vi.fn().mockRejectedValue(new Error('down'));
    expect(() => notifyDiscord(db, 'x', fetchFn)).not.toThrow();
    await new Promise((r) => setImmediate(r)); // let the rejection settle
  });

  it('swallows a synchronously-throwing fetchFn', () => {
    setSetting(db, 'discord_webhook_url', 'https://discord.test/hook');
    const fetchFn = vi.fn(() => { throw new Error('boom'); });
    expect(() => notifyDiscord(db, 'x', fetchFn)).not.toThrow();
  });
});
