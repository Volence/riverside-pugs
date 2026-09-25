import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openDb, type DB } from '../src/db.js';
import { upsertPlayer, activatePlayer, linkDiscord } from '../src/players.js';
import { setSetting } from '../src/settings.js';
import { handleModCall, type ModCallEvent } from '../src/modCalls.js';
import { ModCallPoster } from '../src/discord/modCallPoster.js';
import { FakeTransport } from './fakes/fakeTransport.js';

const IDS = Array.from({ length: 8 }, (_, i) => `7656119900000000${i}`);
const ROLE = '1551114695010816040';
let db: DB; let t: FakeTransport; let poster: ModCallPoster; let matchId: number; let serverId: number;

const ev = (over: Partial<ModCallEvent> = {}): ModCallEvent => ({
  kind: 'call', steamid: IDS[0], target: IDS[5], callerTeam: 2, reason: 'cheating', map: null,
  matchId, ordinal: 1, half: 1, tMs: 5000, via: 'game', text: 'walls **bold** @everyone', ...over,
});
const call = (over: Partial<ModCallEvent> = {}) => handleModCall(db, ev(over), serverId, { adminSteamIds: [], map: 'l4d_hospital01_apartment' });
const inAdmin = () => t.live().filter((m) => m.channelId === 'admins');

beforeEach(() => {
  db = openDb(':memory:');
  IDS.forEach((id, i) => { upsertPlayer(db, { steamid: id, name: `player${i}`, avatar: null }, []); activatePlayer(db, id); linkDiscord(db, id, `90${i}`, `d${i}`); });
  db.prepare('UPDATE players SET is_mod = 1 WHERE steamid = ?').run(IDS[7]);
  setSetting(db, 'discord_admin_channel_id', 'admins');
  setSetting(db, 'mod_call_role_id', ROLE);
  serverId = Number(db.prepare("INSERT INTO servers (name, host, port, rcon_port, rcon_password, tv_port, tv_enabled) VALUES ('Dallas', '1.2.3.4', 27015, 27015, 'x', 27020, 1)").run().lastInsertRowid);
  matchId = Number(db.prepare("INSERT INTO matches (season_id, state, campaign) VALUES (1, 'live', 'no_mercy')").run().lastInsertRowid);
  const ins = db.prepare('INSERT INTO match_players (match_id, player_id, team) VALUES (?, ?, ?)');
  IDS.forEach((id, i) => ins.run(matchId, id, i < 4 ? 'a' : 'b'));
  t = new FakeTransport();
  poster = new ModCallPoster({ db, transport: t, publicUrl: 'https://pug.test', retryMs: 0 });
  poster.start();
});
afterEach(() => poster.stop());

describe('ModCallPoster', () => {
  it('posts one card that pings only the role', async () => {
    call(); await poster.idle();
    expect(inAdmin()).toHaveLength(1);
    const p = inAdmin()[0].payload;
    expect(p.content).toBe(`<@&${ROLE}>`);
    expect(p.mentionRoleIds).toEqual([ROLE]);
    expect(p.mentionUserIds).toEqual([]);
    const body = JSON.stringify(p);
    expect(body).toContain('In-game call: Cheating');
    expect(body).toContain('<@900>');           // caller's Discord, shown but not pinged
    expect(body).toContain('<@905>');           // target's Discord
    expect(body).toContain('\\\\*\\\\*bold\\\\*\\\\*'); // details escaped
    expect(body).toContain('\\\\@everyone');
    expect(body).toContain('https://pug.test/match/' + matchId + '?ordinal=1&half=1&t=5000');
    expect(body).toContain('connect 1.2.3.4:27020');
  });

  it('does not ping when the role is not set', async () => {
    setSetting(db, 'mod_call_role_id', '');
    call(); await poster.idle();
    expect(inAdmin()[0].payload.content ?? '').not.toContain('<@&');
    expect(inAdmin()[0].payload.mentionRoleIds ?? []).toEqual([]);
  });

  it('folds a second call into the first card without a second post', async () => {
    call(); await poster.idle();
    call({ steamid: IDS[1], text: 'yeah' }); await poster.idle();
    expect(inAdmin()).toHaveLength(1);
    const body = JSON.stringify(inAdmin()[0].payload);
    expect(body).toContain('(2 calls)');
    expect(body).toContain('yeah');
  });

  it('never posts a skipped call', async () => {
    setSetting(db, 'mod_calls_enabled', '0');
    call(); await poster.idle();
    expect(inAdmin()).toHaveLength(0);
  });

  it('marks a call handled from the button, staff only', async () => {
    const row = call(); await poster.idle();
    const press = (userId: string) => poster.handleButton({ kind: 'button', customId: `mc:${row.id}:handle`, userId, userName: 'x', presserTimedOutUntil: null });
    expect((await press('901')).payload.content).toBe('Staff only.');
    expect((await press('907')).payload.content).toBe('Marked as yours.');
    await poster.idle();
    const body = JSON.stringify(inAdmin()[0].payload);
    expect(body).toContain('Handled by <@907>');
    expect((await press('907')).payload.content).toContain('Already handled');
  });

  it('retries a call that could not be sent', async () => {
    setSetting(db, 'discord_admin_channel_id', '');
    call(); await poster.idle();
    expect(inAdmin()).toHaveLength(0);
    setSetting(db, 'discord_admin_channel_id', 'admins');
    await poster.retryNow(); await poster.idle();
    expect(inAdmin()).toHaveLength(1);
  });

  it('disables the button once handled and refuses a banned or unknown presser', async () => {
    const row = call(); await poster.idle();
    const press = (userId: string) => poster.handleButton({ kind: 'button', customId: `mc:${row.id}:handle`, userId, userName: 'x', presserTimedOutUntil: null });
    expect((await press('999')).payload.content).toBe('Staff only.');
    expect((await press('907')).payload.mentionUserIds).toEqual([]);
    await poster.idle();
    const button = inAdmin()[0].payload.components[0][0];
    expect(button).toMatchObject({ kind: 'button', label: 'Handled', disabled: true });
  });

  it('leaves out the replay link without a full moment and the watch line without SourceTV', async () => {
    db.prepare('UPDATE servers SET tv_enabled = 0').run();
    call({ tMs: null }); await poster.idle();
    const p = inAdmin()[0].payload;
    expect(p.components[0].map((b) => b.label)).not.toContain('Replay moment');
    expect(JSON.stringify(p)).not.toContain('Watch:');
    // The Join line still shows: it points at the game server, not SourceTV.
    expect(JSON.stringify(p)).toContain('Join: `connect 1.2.3.4:27015`');
  });

  it('keeps a call pending when the send fails and posts it on the next pass', async () => {
    t.failSends = 1;
    const row = call(); await poster.idle();
    expect(inAdmin()).toHaveLength(0);
    expect(db.prepare('SELECT post_state FROM mod_calls WHERE id = ?').get(row.id)).toEqual({ post_state: 'pending' });
    await poster.retryNow();
    expect(inAdmin()).toHaveLength(1);
    expect(db.prepare('SELECT post_state, discord_message_id FROM mod_calls WHERE id = ?').get(row.id))
      .toEqual({ post_state: 'posted', discord_message_id: inAdmin()[0].id });
  });

  it('shows a targetless call about the team, with the note, and no ticket link', async () => {
    call({ target: 'team', reason: 'toxicity', text: '' }); await poster.idle();
    const p = inAdmin()[0].payload;
    expect(p.embeds[0].description).toContain('About: their own team');
    expect(p.embeds[0].description).not.toContain('> ');
    expect(p.components[0].map((b) => b.label)).not.toContain('Ticket');
  });

  it('skips a pending call instead of posting it once calls are turned off', async () => {
    setSetting(db, 'discord_admin_channel_id', '');
    const row = call(); await poster.idle();
    setSetting(db, 'mod_calls_enabled', '0');
    setSetting(db, 'discord_admin_channel_id', 'admins');
    await poster.retryNow();
    expect(inAdmin()).toHaveLength(0);
    const after = db.prepare('SELECT post_state, note FROM mod_calls WHERE id = ?').get(row.id) as { post_state: string; note: string };
    expect(after.post_state).toBe('skipped');
    expect(after.note).toMatch(/Calls are turned off$/);
  });

  it('keeps the caller, details and ticket off the card when the call is about staff', async () => {
    const first = call({ target: IDS[7], text: 'secret details' }); await poster.idle();
    // A ticket was filed, so leaving its link off the card is the rule at work.
    expect(first.ticket_id).not.toBeNull();
    call({ steamid: IDS[1], target: IDS[7], text: 'second secret' }); await poster.idle();
    expect(inAdmin()).toHaveLength(1);
    const p = inAdmin()[0].payload;
    const body = JSON.stringify(p);
    expect(body).toContain('About a staff member: details are on the site.');
    expect(body).toContain('https://pug.test/admin/people/calls');
    expect(body).not.toContain('<@900>');
    expect(body).not.toContain('<@901>');
    expect(body).not.toContain('secret');
    expect(body).not.toContain('/admin/people/tickets/');
    expect(p.components[0].map((b) => b.label)).not.toContain('Ticket');
    // What happened and where still show, and the role is still pinged.
    expect(body).toContain('In-game call: Cheating (2 calls)');
    expect(body).toContain('Dallas');
    expect(body).toContain('Replay moment');
    expect(body).toContain('connect 1.2.3.4:27020');
    expect(p.content).toBe(`<@&${ROLE}>`);
  });

  it('refuses the Handling it button to the staff member the call is about', async () => {
    db.prepare('UPDATE players SET is_mod = 1 WHERE steamid = ?').run(IDS[6]);
    const row = call({ target: IDS[7] }); await poster.idle();
    const press = (userId: string) => poster.handleButton({ kind: 'button', customId: `mc:${row.id}:handle`, userId, userName: 'x', presserTimedOutUntil: null });
    expect((await press('907')).payload.content).toBe('Staff only.');
    expect((await press('906')).payload.content).toBe('Marked as yours.');
  });

  it('shows a Join line for the game server, above Watch, using the derived password when a queue match is live there', async () => {
    const token = 'abcdef0123456789abcdef0123456789';
    db.prepare("UPDATE matches SET server_id = ?, origin = 'queue', token = ? WHERE id = ?").run(serverId, token, matchId);
    call(); await poster.idle();
    const desc = inAdmin()[0].payload.embeds[0].description ?? '';
    expect(desc).toContain('Join: `password pug_abcdef01; connect 1.2.3.4:27015`');
    expect(desc.indexOf('Join:')).toBeLessThan(desc.indexOf('Watch:'));
  });

  it('shows a plain Join line when the server has no live queue match', async () => {
    call(); await poster.idle();
    const desc = inAdmin()[0].payload.embeds[0].description ?? '';
    expect(desc).toContain('Join: `connect 1.2.3.4:27015`');
  });

  it('shows a plain Join line for a live in_game match (no sv_password from a token)', async () => {
    const token = 'abcdef0123456789abcdef0123456789';
    db.prepare("UPDATE matches SET server_id = ?, origin = 'in_game', token = ? WHERE id = ?").run(serverId, token, matchId);
    call(); await poster.idle();
    const desc = inAdmin()[0].payload.embeds[0].description ?? '';
    expect(desc).toContain('Join: `connect 1.2.3.4:27015`');
    expect(desc).not.toContain('password pug_');
  });

  it('leaves out the Join line when the call has no server', async () => {
    handleModCall(db, ev(), null, { adminSteamIds: [], map: 'l4d_hospital01_apartment' });
    await poster.idle();
    expect(inAdmin()).toHaveLength(1);
    const desc = inAdmin()[0].payload.embeds[0].description ?? '';
    expect(desc).not.toContain('Join:');
  });

  it('links the Steam profile of a caller or target with no Discord linked', async () => {
    db.prepare('UPDATE players SET discord_id = NULL WHERE steamid IN (?, ?)').run(IDS[0], IDS[5]);
    call(); await poster.idle();
    const desc = inAdmin()[0].payload.embeds[0].description ?? '';
    expect(desc).not.toContain('no Discord linked');
    expect(desc).toContain(`**player0** ([Steam](https://steamcommunity.com/profiles/${IDS[0]}))`);
    expect(desc).toContain(`**player5** ([Steam](https://steamcommunity.com/profiles/${IDS[5]}))`);
  });
});
