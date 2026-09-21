import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openDb, type DB } from '../src/db.js';
import { upsertPlayer, activatePlayer, linkDiscord } from '../src/players.js';
import { setSetting } from '../src/settings.js';
import { fileReport } from '../src/tickets/filing.js';
import { recordPenalty } from '../src/penalties.js';
import { logAdmin } from '../src/admin/audit.js';
import { publishAdminEvent } from '../src/adminFeed.js';
import { AdminFeedPoster } from '../src/discord/adminFeedPoster.js';
import { FakeTransport } from './fakes/fakeTransport.js';

const IDS = Array.from({ length: 8 }, (_, i) => `7656119900000000${i}`);
const ADMIN = IDS[7];
let db: DB;
let t: FakeTransport;
let feed: AdminFeedPoster;
let matchId: number;

beforeEach(() => {
  db = openDb(':memory:');
  IDS.forEach((id, i) => {
    upsertPlayer(db, { steamid: id, name: `player${i}`, avatar: null }, []);
    activatePlayer(db, id);
    linkDiscord(db, id, `90${i}`, `d${i}`);
  });
  db.prepare('UPDATE players SET is_admin = 1 WHERE steamid = ?').run(ADMIN);
  setSetting(db, 'discord_admin_channel_id', 'admins');
  matchId = Number(db.prepare("INSERT INTO matches (season_id, state, campaign, ended_at) VALUES (1, 'completed', 'dead_air', datetime('now'))").run().lastInsertRowid);
  const ins = db.prepare('INSERT INTO match_players (match_id, player_id, team) VALUES (?, ?, ?)');
  IDS.forEach((id, i) => ins.run(matchId, id, i < 4 ? 'a' : 'b'));
  t = new FakeTransport();
  feed = new AdminFeedPoster({ db, transport: t, publicUrl: 'https://pug.test' });
  feed.start();
});
afterEach(() => feed.stop());

const text = (i: number) => JSON.stringify(t.live()[i]?.payload);

describe('admin feed', () => {
  it('posts one plain line for a new ticket and another for a further report, never naming the reporter', async () => {
    const a = fileReport(db, IDS[0], { targetId: IDS[5], category: 'griefing', text: 'kept killing us', matchId }, { adminSteamIds: [] }) as { ticketId: number };
    fileReport(db, IDS[1], { targetId: IDS[5], category: 'cheating', text: '' }, { adminSteamIds: [] });
    await feed.idle();
    expect(t.live()).toHaveLength(2);
    expect(t.live()[0].channelId).toBe('admins');
    expect(text(0)).toContain(`https://pug.test/admin?ticket=${a.ticketId}`);
    expect(text(0)).toContain('player5');
    expect(text(0)).toContain('griefing');
    expect(text(0)).toMatch(/new ticket/i);
    expect(text(1)).toMatch(/another report/i);
    expect(text(0) + text(1)).not.toContain('player0');
    expect(text(0) + text(1)).not.toContain('player1');
    expect(text(0)).not.toContain('kept killing us');
    expect(t.live()[0].payload.components).toEqual([]);
  });

  it('a restricted ticket posts nothing', async () => {
    fileReport(db, IDS[0], { targetId: IDS[5], category: 'unsafe', text: 'details' }, { adminSteamIds: [] });
    fileReport(db, IDS[0], { targetId: ADMIN, category: 'toxicity', text: '' }, { adminSteamIds: [] });
    await feed.idle();
    expect(t.live()).toHaveLength(0);
  });

  it('a clock action names the player, the match and what was done', async () => {
    logAdmin(db, ADMIN, 'leave_clock', IDS[2], { matchId, action: 'hold', ok: true, remaining: 200, held: true });
    logAdmin(db, ADMIN, 'leave_clock', IDS[2], { matchId, action: 'add', seconds: 300, ok: true, remaining: 500, held: false });
    logAdmin(db, ADMIN, 'leave_clock', IDS[2], { matchId, action: 'end', ok: false, error: 'not dropped' });
    await feed.idle();
    expect(text(0)).toMatch(/player7.*put .*player2.*reconnect clock on hold/);
    expect(text(0)).toContain(`https://pug.test/match/${matchId}`);
    expect(text(1)).toMatch(/gave .*player2.* 300 more seconds/);
    expect(text(2)).toMatch(/failed: not dropped/);
  });

  it('a button on an old report card answers instead of failing', async () => {
    const r = await feed.handleButton({ kind: 'button', customId: 'r:12:resolve', userId: '907', userName: 'd7' });
    expect(r.ephemeral).toBe(true);
    expect(JSON.stringify(r.payload)).toMatch(/tickets/i);
  });

  it('ticket actions read as sentences with a link', async () => {
    logAdmin(db, ADMIN, 'ticket_close', 12, { outcome: 'warned' });
    logAdmin(db, ADMIN, 'ticket_ban', 12, { reason: 'walls', minutes: 1440 });
    await feed.idle();
    expect(text(0)).toContain('closed ticket [#12](https://pug.test/admin?ticket=12)');
    expect(text(0)).toContain('warned');
    expect(text(1)).toContain('banned from ticket [#12]');
    expect(text(1)).toContain('1 day');
  });

  it('admin actions, penalties, accounts and problems post one line each, with names', async () => {
    logAdmin(db, ADMIN, 'ban', IDS[3], { reason: 'throwing', minutes: 1440 });
    recordPenalty(db, IDS[2], 'ready_fail', null);
    publishAdminEvent({ kind: 'account', steamid: IDS[1], what: 'linked', discordName: 'd1' });
    publishAdminEvent({ kind: 'problem', text: 'Match #9 aborted for no-shows.', matchId: 9 });
    await feed.idle();
    expect(t.live()).toHaveLength(4);
    expect(text(0)).toMatch(/player7.*banned.*player3.*throwing/);
    expect(text(1)).toMatch(/player2.*missed a ready check/);
    expect(text(1)).toMatch(/5 min/);
    expect(text(2)).toMatch(/player1.*linked Discord/);
    expect(text(3)).toContain('Match #9 aborted for no-shows.');
  });

  it('names both the steam identity and the linked discord account, and never pings', async () => {
    logAdmin(db, ADMIN, 'ban', IDS[3], { reason: 'throwing', minutes: 1440 });
    await feed.idle();
    // Every player linked in beforeEach: steam name plus a discord mention.
    expect(text(0)).toContain('**player7** (<@907>)');
    expect(text(0)).toContain('**player3** (<@903>)');
    // The bot's transport pings only ids listed in mentionUserIds; the admin
    // feed lists none, so the mention above renders but never notifies.
    expect(t.live()[0].payload.mentionUserIds).toEqual([]);
  });

  it('a steamid with no player row shows no Discord linked', async () => {
    publishAdminEvent({ kind: 'penalty', steamid: '76561198009999999', penalty: 'ready_fail', matchId: null });
    await feed.idle();
    expect(text(0)).toContain('(no Discord linked)');
  });

  it('each kind can be switched off, and no channel means no feed', async () => {
    setSetting(db, 'admin_feed_penalties', '0');
    recordPenalty(db, IDS[2], 'ready_fail', null);
    await feed.idle();
    expect(t.live()).toHaveLength(0);
    setSetting(db, 'discord_admin_channel_id', '');
    publishAdminEvent({ kind: 'problem', text: 'x' });
    await feed.idle();
    expect(t.live()).toHaveLength(0);
  });

  it('a repeated connect drop posts one line: name, steamid, count and the wording', async () => {
    // Not one of IDS: most dropped steamids have never signed in to the site.
    const stranger = '76561198005192651';
    publishAdminEvent({ kind: 'signon_drop', steamid: stranger, name: 'may*hem', count: 2, total: 5 });
    await feed.idle();
    expect(t.live()).toHaveLength(1);
    expect(t.live()[0].channelId).toBe('admins');
    const line = t.live()[0].payload.embeds[0].description ?? '';
    // The in-game name, markdown-escaped: it is attacker-controlled text.
    expect(line).toContain('**may\\*hem**');
    expect(line).toContain(`\`${stranger}\``);
    expect(line).toContain('2 times in ten minutes');
    expect(line).toContain('5 on record');
    expect(line).toContain('likely rejected for a modified game file; the file name was shown on their screen');
    expect(line).not.toContain('/player/');
  });

  it('a connect drop by a known player links the steamid to their profile', async () => {
    publishAdminEvent({ kind: 'signon_drop', steamid: IDS[4], name: 'in game name', count: 2, total: 2 });
    await feed.idle();
    expect(t.live()[0].payload.embeds[0].description).toContain(`[${IDS[4]}](https://pug.test/player/${IDS[4]})`);
  });

  it('connect drops ride the problems toggle', async () => {
    setSetting(db, 'admin_feed_problems', '0');
    publishAdminEvent({ kind: 'signon_drop', steamid: IDS[4], name: 'x', count: 2, total: 2 });
    await feed.idle();
    expect(t.live()).toHaveLength(0);
  });

  it('a secret setting change never shows its value', async () => {
    logAdmin(db, ADMIN, 'setting', 'invite_code', { changed: true });
    await feed.idle();
    expect(text(0)).toMatch(/changed the invite_code setting/i);
  });

  it('a recent ban elsewhere is worded as context and links the match', async () => {
    publishAdminEvent({
      kind: 'steam_signal', steamid: IDS[2], matchId,
      signal: { what: 'recent_ban', vacBans: 1, gameBans: 2, daysSinceLastBan: 40 },
    });
    await feed.idle();
    const line = t.live()[0].payload.embeds[0].description ?? '';
    expect(line).toContain('**player2**');
    expect(line).toContain('1 VAC ban and 2 game bans');
    expect(line).toContain('40 days ago');
    expect(line).toContain(`[#${matchId}](https://pug.test/match/${matchId})`);
    expect(line).toContain('Steam does not say which game');
  });

  it('a game borrowed from a banned account names the lender', async () => {
    db.prepare("UPDATE players SET status = 'banned' WHERE steamid = ?").run(IDS[6]);
    publishAdminEvent({ kind: 'steam_signal', steamid: IDS[2], matchId, signal: { what: 'banned_lender', lenderId: IDS[6] } });
    await feed.idle();
    const line = t.live()[0].payload.embeds[0].description ?? '';
    expect(line).toContain('**player2**');
    expect(line).toContain('**player6**');
    expect(line).toContain('Family Sharing');
    expect(line).toContain('banned here');
  });

  it('steam signals ride the problems toggle', async () => {
    setSetting(db, 'admin_feed_problems', '0');
    publishAdminEvent({ kind: 'steam_signal', steamid: IDS[2], matchId, signal: { what: 'banned_lender', lenderId: IDS[6] } });
    await feed.idle();
    expect(t.live()).toHaveLength(0);
  });

  it('warns once that a dropped player is nearly out of time, with a link to the board', async () => {
    publishAdminEvent({ kind: 'clock', what: 'low_allowance', steamid: IDS[2], matchId, remainingS: 85 });
    publishAdminEvent({ kind: 'clock', what: 'hold_expired', steamid: IDS[2], matchId, remainingS: 197 });
    await feed.idle();
    expect(text(0)).toMatch(/player2.* has 85 s left/);
    expect(text(0)).toContain(`https://pug.test/admin?live=${matchId}`);
    expect(text(0)).toContain(`https://pug.test/match/${matchId}`);
    expect(text(1)).toMatch(/hold on .*player2.* released itself/);
    expect(text(1)).toContain('197 s');
  });
});
