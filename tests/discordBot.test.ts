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

describe('startBot extras', () => {
  it('loads the member list and routes prefixed buttons', async () => {
    const { GuildMembership } = await import('../src/discord/membership.js');
    const s = setup(ENV);
    s.t.guildMembers = ['1', '2'];
    const membership = new GuildMembership();
    let connected = false;
    const bot = await startBot({
      ...s, connect: async () => s.t, membership,
      onConnected: () => { connected = true; },
      extraButtons: { 'r:': async () => ({ ephemeral: true, payload: { content: 'report button', embeds: [], components: [] } }) },
    });
    expect(connected).toBe(true);
    expect(membership.isMember('2')).toBe(true);
    const r = await s.t.handler!({ kind: 'button', customId: 'r:1:resolve', userId: '1', userName: 'x' });
    expect(r.payload.content).toBe('report button');
    await bot!.stop();
    expect(membership.isMember('2')).toBeNull();
  });

  it('loads voice states, follows updates, and forgets them on stop', async () => {
    const { VoicePresence } = await import('../src/discord/voicePresence.js');
    const s = setup(ENV);
    s.t.voiceOf.set('1', 'chan-a');
    const presence = new VoicePresence();
    const left: string[] = [];
    presence.onLeave((id) => left.push(id));
    const bot = await startBot({ ...s, connect: async () => s.t, presence });
    expect(presence.inVoice('1')).toBe(true);
    expect(presence.inVoice('2')).toBe(false);
    s.t.voiceHandlers!.update('2', 'chan-a');
    expect(presence.inVoice('2')).toBe(true);
    s.t.voiceHandlers!.update('1', null);
    expect(presence.inVoice('1')).toBe(false);
    expect(left).toEqual(['1']);
    await bot!.stop();
    expect(presence.inVoice('2')).toBeNull();
  });

  it('routes a modal submit by prefix and tells the transport which buttons open a modal', async () => {
    const s = setup(ENV);
    const bot = await startBot({
      ...s, connect: async () => s.t,
      opensModal: (customId) => customId.endsWith(':close'),
      extraModals: { 't:': async (i) => ({ ephemeral: true, payload: { content: `closed with ${i.fields.outcome}`, embeds: [], components: [] } }) },
    });
    expect(s.t.opensModal?.('t:1:close')).toBe(true);
    expect(s.t.opensModal?.('t:1:claim')).toBe(false);
    const r = await s.t.handler!({ kind: 'modal', customId: 't:1:close', userId: '1', userName: 'x', fields: { outcome: 'warned' } });
    expect(r.payload.content).toBe('closed with warned');
    const stray = await s.t.handler!({ kind: 'modal', customId: 'zz:1', userId: '1', userName: 'x', fields: {} });
    expect(stray.ephemeral).toBe(true);
    await bot!.stop();
  });
});
