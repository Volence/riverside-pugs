import { describe, it, expect } from 'vitest';
import { openDb } from '../src/db.js';
import { loadConfig } from '../src/config.js';
import { Matchmaker } from '../src/matchmaker.js';
import { Hub } from '../src/ws.js';
import { upsertPlayer, activatePlayer, linkDiscord } from '../src/players.js';
import { startBot, botEnabled } from '../src/discord/index.js';
import { FakeTransport } from './fakes/fakeTransport.js';

const ENV = {
  PUBLIC_URL: 'https://pug.test',
  DISCORD_CLIENT_ID: 'c', DISCORD_CLIENT_SECRET: 's', DISCORD_BOT_TOKEN: 't', DISCORD_GUILD_ID: 'g',
  DISCORD_LOBBY_CHANNEL_ID: 'queue',
};

function setup(env: Record<string, string>) {
  const db = openDb(':memory:');
  const hub = new Hub();
  const matchmaker = new Matchmaker(db, {
    broadcast: (e) => hub.broadcast(e), orchestrator: { setupMatch: async () => {}, finishMatch: async () => {} },
  });
  const t = new FakeTransport();
  return { db, hub, matchmaker, t, config: loadConfig(env) };
}

describe('startBot', () => {
  it('is off without a lobby channel, and in dev mode', async () => {
    const { config } = setup({ ...ENV, DISCORD_LOBBY_CHANNEL_ID: '' });
    expect(botEnabled(config)).toBe(false);
    expect(botEnabled(loadConfig({ ...ENV, DEV_MODE: '1' }))).toBe(false);
    const s = setup({});
    let connected = false;
    const bot = await startBot({ ...s, connect: async () => { connected = true; return s.t; } });
    expect(bot).toBeNull();
    expect(connected).toBe(false);
  });

  it('posts the panel and routes a button press to the queue', async () => {
    const s = setup(ENV);
    upsertPlayer(s.db, { steamid: '76561198000000001', name: 'alice', avatar: null }, []);
    activatePlayer(s.db, '76561198000000001');
    linkDiscord(s.db, '76561198000000001', '901', 'alice');
    const bot = await startBot({ ...s, connect: async () => s.t });
    expect(bot).not.toBeNull();
    expect(s.t.live()).toHaveLength(1);
    const reply = await s.t.handler!({ kind: 'button', customId: 'q:join', userId: '901', userName: 'alice' });
    expect(reply.ephemeral).toBe(true);
    expect(s.matchmaker.publicQueue().count).toBe(1);
    await bot!.stop();
  });

  it('registers slash commands and routes them', async () => {
    const s = setup(ENV);
    const bot = await startBot({
      ...s, connect: async () => s.t,
      commands: {
        defs: [{ name: 'queue', description: 'q' }],
        handle: async (i) => ({ ephemeral: true, payload: { content: `cmd ${i.name}`, embeds: [], components: [] } }),
      },
    });
    expect(s.t.commands.map((c) => c.name)).toEqual(['queue']);
    const r = await s.t.handler!({ kind: 'command', name: 'queue', userId: '1', userName: 'x', options: {} });
    expect(r.payload.content).toBe('cmd queue');
    await bot!.stop();
  });
});
