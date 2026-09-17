import { describe, it, expect, beforeEach } from 'vitest';
import { openDb, type DB } from '../src/db.js';
import { upsertPlayer, getPlayer, linkDiscord, activatePlayer } from '../src/players.js';
import { setSetting } from '../src/settings.js';
import { applyGate } from '../src/discord/gate.js';
import { fakeDiscordApi } from './fakes/fakeDiscordApi.js';
import { loadConfig } from '../src/config.js';

const P1 = '76561198000000001';

let db: DB;
beforeEach(() => {
  db = openDb(':memory:');
  upsertPlayer(db, { steamid: P1, name: 'alice', avatar: null }, []);
});

describe('applyGate', () => {
  it('activates an invited player whose linked account is in the guild', async () => {
    linkDiscord(db, P1, '111', 'alice');
    const api = fakeDiscordApi({ members: { '111': [] } });
    expect(await applyGate(db, api, P1)).toBe(true);
    expect(getPlayer(db, P1)?.status).toBe('active');
  });

  it('leaves a non-member invited', async () => {
    linkDiscord(db, P1, '111', 'alice');
    expect(await applyGate(db, fakeDiscordApi({}), P1)).toBe(false);
    expect(getPlayer(db, P1)?.status).toBe('invited');
  });

  it('requires the configured role when one is set', async () => {
    setSetting(db, 'discord_required_role_id', 'role-pug');
    linkDiscord(db, P1, '111', 'alice');
    expect(await applyGate(db, fakeDiscordApi({ members: { '111': ['other'] } }), P1)).toBe(false);
    expect(await applyGate(db, fakeDiscordApi({ members: { '111': ['role-pug'] } }), P1)).toBe(true);
  });

  it('never touches a banned player', async () => {
    linkDiscord(db, P1, '111', 'alice');
    db.prepare("UPDATE players SET status = 'banned' WHERE steamid = ?").run(P1);
    expect(await applyGate(db, fakeDiscordApi({ members: { '111': [] } }), P1)).toBe(false);
    expect(getPlayer(db, P1)?.status).toBe('banned');
  });

  it('an unlinked player is not activated, an already active one stays active', async () => {
    expect(await applyGate(db, fakeDiscordApi({ members: { '111': [] } }), P1)).toBe(false);
    activatePlayer(db, P1);
    expect(await applyGate(db, fakeDiscordApi({}), P1)).toBe(true);
    expect(getPlayer(db, P1)?.status).toBe('active');
  });

  it('a Discord API failure leaves the player as they were', async () => {
    linkDiscord(db, P1, '111', 'alice');
    const api = fakeDiscordApi({ failMembers: true });
    expect(await applyGate(db, api, P1)).toBe(false);
    expect(getPlayer(db, P1)?.status).toBe('invited');
  });
});

describe('discord config', () => {
  it('is null unless client, secret, token and guild are all set', () => {
    expect(loadConfig({}).discord).toBeNull();
    expect(loadConfig({ DISCORD_CLIENT_ID: 'a', DISCORD_CLIENT_SECRET: 'b', DISCORD_BOT_TOKEN: 'c' }).discord).toBeNull();
    const d = loadConfig({
      DISCORD_CLIENT_ID: 'a', DISCORD_CLIENT_SECRET: 'b', DISCORD_BOT_TOKEN: 'c', DISCORD_GUILD_ID: 'g',
      DISCORD_LOBBY_CHANNEL_ID: 'ch',
    }).discord;
    expect(d).toEqual({ clientId: 'a', clientSecret: 'b', botToken: 'c', guildId: 'g', lobbyChannelId: 'ch' });
  });
});
