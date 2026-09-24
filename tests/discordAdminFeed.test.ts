import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openDb, type DB } from '../src/db.js';
import { upsertPlayer, activatePlayer, linkDiscord } from '../src/players.js';
import { setSetting } from '../src/settings.js';
import { fileReport } from '../src/tickets/filing.js';
import { recordPenalty } from '../src/penalties.js';
import { logAdmin } from '../src/admin/audit.js';
import { publishAdminEvent } from '../src/adminFeed.js';
import { AdminFeedPoster } from '../src/discord/adminFeedPoster.js';
import { TicketSync } from '../src/discord/ticketSync.js';
import { FakeTransport } from './fakes/fakeTransport.js';

const IDS = Array.from({ length: 8 }, (_, i) => `7656119900000000${i}`);
const ADMIN = IDS[7];
let db: DB;
let t: FakeTransport;
let feed: AdminFeedPoster;
let sync: TicketSync;
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
  sync = new TicketSync({ db, transport: t, publicUrl: 'https://pug.test', intervalMs: 0 });
  sync.start();
});
afterEach(() => { sync.stop(); feed.stop(); });

const text = (i: number) => JSON.stringify(t.live()[i]?.payload);
/** The reconciler publishes, then the poster delivers: wait for both, in that order. */
const settled = async () => { await sync.idle(); await feed.idle(); };
const inFeed = () => t.live().filter((m) => m.channelId === 'admins');

describe('admin feed', () => {
  it('a note shows its text, quoted and escaped, but not when the note is about staff', async () => {
    logAdmin(db, ADMIN, 'note', IDS[2], { text: 'went afk twice\nsaid sorry after **no ping** @everyone' });
    await settled();
    const line = JSON.stringify(inFeed()[0]?.payload);
    expect(line).toContain('added a note on');
    expect(line).toContain('went afk twice');
    expect(line).toContain('said sorry after');
    expect(line).not.toContain('**no ping**');
    db.prepare('UPDATE players SET is_mod = 1 WHERE steamid = ?').run(IDS[3]);
    logAdmin(db, ADMIN, 'note', IDS[3], { text: 'secret about a mod' });
    await settled();
    const staff = JSON.stringify(inFeed()[1]?.payload);
    expect(staff).toContain('added a note on');
    expect(staff).not.toContain('secret about a mod');
  });

  it('with no forum set, posts one plain line for a new ticket and another for a further report, never naming the reporter', async () => {
    const a = fileReport(db, IDS[0], { targetId: IDS[5], category: 'griefing', text: 'kept killing us', matchId }, { adminSteamIds: [] }) as { ticketId: number };
    fileReport(db, IDS[1], { targetId: IDS[5], category: 'cheating', text: '' }, { adminSteamIds: [] });
    await settled();
    expect(inFeed()).toHaveLength(2);
    expect(text(0)).toContain(`https://pug.test/admin/people/tickets/${a.ticketId}`);
    expect(text(0)).toContain('player5');
    expect(text(0)).toContain('griefing');
    expect(text(0)).toMatch(/new ticket/i);
    expect(text(1)).toMatch(/another report/i);
    expect(text(0) + text(1)).not.toContain('player0');
    expect(text(0) + text(1)).not.toContain('player1');
    expect(text(0)).not.toContain('kept killing us');
    expect(t.live()[0].payload.components).toEqual([]);
    // Said once: a later pass finds nothing left to say.
    await sync.reconcile();
    await feed.idle();
    expect(inFeed()).toHaveLength(2);
  });

  it('with the forum set, the post is the announcement and the feed hears nothing', async () => {
    setSetting(db, 'discord_tickets_forum_id', 'forum1');
    fileReport(db, IDS[0], { targetId: IDS[5], category: 'griefing', text: '' }, { adminSteamIds: [] });
    fileReport(db, IDS[1], { targetId: IDS[5], category: 'cheating', text: '' }, { adminSteamIds: [] });
    await settled();
    expect(t.threadsIn('forum1')).toHaveLength(1);
    expect(inFeed()).toEqual([]);
  });

  it('a report filed while the bot was down is said when it comes back', async () => {
    sync.stop();
    fileReport(db, IDS[0], { targetId: IDS[5], category: 'afk', text: '' }, { adminSteamIds: [] });
    await settled();
    expect(inFeed()).toEqual([]);
    sync = new TicketSync({ db, transport: t, publicUrl: 'https://pug.test', intervalMs: 0 });
    sync.start();
    await settled();
    expect(inFeed()).toHaveLength(1);
  });

  it('a restricted ticket posts nothing, with or without a forum', async () => {
    fileReport(db, IDS[0], { targetId: IDS[5], category: 'unsafe', text: 'details' }, { adminSteamIds: [] });
    fileReport(db, IDS[0], { targetId: ADMIN, category: 'toxicity', text: '' }, { adminSteamIds: [] });
    await settled();
    setSetting(db, 'discord_tickets_forum_id', 'forum1');
    fileReport(db, IDS[1], { targetId: IDS[5], category: 'unsafe', text: 'more' }, { adminSteamIds: [] });
    await settled();
    // No tickets channel is set, so there is no private thread either.
    expect(t.live()).toHaveLength(0);
  });

  it('a normal ticket about someone who has since been made staff posts nothing', async () => {
    sync.stop();
    fileReport(db, IDS[1], { targetId: IDS[3], category: 'afk', text: '' }, { adminSteamIds: [] });
    // Promoted by hand, with no promotion route to hold the feed:
    // announceInFeed holds it itself. The accused reads the feed.
    db.prepare('UPDATE players SET is_mod = 1 WHERE steamid = ?').run(IDS[3]);
    sync = new TicketSync({ db, transport: t, publicUrl: 'https://pug.test', intervalMs: 0 });
    sync.start();
    await settled();
    expect(inFeed()).toEqual([]);
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
    const r = await feed.handleButton({ kind: 'button', customId: 'r:12:resolve', userId: '907', userName: 'd7', presserTimedOutUntil: null });
    expect(r.ephemeral).toBe(true);
    expect(JSON.stringify(r.payload)).toMatch(/tickets/i);
  });

  it('ticket actions read as sentences with a link', async () => {
    logAdmin(db, ADMIN, 'ticket_close', 12, { outcome: 'warned' });
    logAdmin(db, ADMIN, 'ticket_ban', 12, { reason: 'walls', minutes: 1440 });
    await feed.idle();
    expect(text(0)).toContain('closed ticket [#12](https://pug.test/admin/people/tickets/12)');
    expect(text(0)).toContain('warned');
    expect(text(1)).toContain('banned from ticket [#12]');
    expect(text(1)).toContain('1 day');
  });

  /** No reason and no Discord id, same as ticket_ban leaves the ban reason
   *  out and ticket_remove leaves out what was removed: only the ticket link
   *  and the kind/length, which is all the audit detail carries. */
  it('a Discord sanction from a ticket reads as a sentence, with no reason and no Discord id', async () => {
    logAdmin(db, ADMIN, 'ticket_discord_sanction', 12, { kind: 'timeout', minutes: 1440 });
    logAdmin(db, ADMIN, 'ticket_discord_sanction', 13, { kind: 'ban', minutes: null });
    logAdmin(db, ADMIN, 'ticket_discord_sanction_lift', 12, { kind: 'timeout', sanctionId: 1 });
    await feed.idle();
    expect(text(0)).toContain('timed out the Discord member on ticket [#12](https://pug.test/admin/people/tickets/12)');
    expect(text(0)).toContain('1 day');
    expect(text(1)).toContain('banned the Discord member on ticket [#13]');
    expect(text(1)).not.toContain('1 day');
    expect(text(2)).toContain('lifted a Discord timeout on ticket [#12]');
    expect(text(0) + text(1) + text(2)).not.toContain('990');
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

  it('a problem with a link renders it against the public URL', async () => {
    publishAdminEvent({ kind: 'problem', text: 'Balance config changed.', link: { label: 'Triage it', path: '/admin/balance/patches' } });
    await feed.idle();
    expect(text(0)).toContain('Balance config changed. [Triage it](https://pug.test/admin/balance/patches)');
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
    expect(line).not.toContain('/admin/people/');
  });

  it('a connect drop by a known player links the steamid to their profile', async () => {
    publishAdminEvent({ kind: 'signon_drop', steamid: IDS[4], name: 'in game name', count: 2, total: 2 });
    await feed.idle();
    expect(t.live()[0].payload.embeds[0].description).toContain(`[${IDS[4]}](https://pug.test/admin/people/${IDS[4]})`);
  });

  it('connect drops ride the problems toggle', async () => {
    setSetting(db, 'admin_feed_problems', '0');
    publishAdminEvent({ kind: 'signon_drop', steamid: IDS[4], name: 'x', count: 2, total: 2 });
    await feed.idle();
    expect(t.live()).toHaveLength(0);
  });

  it('a SourceTV spectator on the same connection as a rostered player names both, links the match, and never claims the spectator IS the player', async () => {
    publishAdminEvent({
      kind: 'sourcetv_watch', matchId, serverId: 1, spectatorName: 'Watcher', steamids: [IDS[2]],
    });
    await feed.idle();
    const line = t.live()[0].payload.embeds[0].description ?? '';
    expect(line).toContain('**Watcher**');
    expect(line).toContain('**player2**');
    expect(line).toContain('same connection');
    expect(line).toContain('evidence, not proof');
    expect(line).toContain(`https://pug.test/match/${matchId}`);
    expect(line).not.toMatch(/is player2/i);
  });

  it('names every matched player in one line when several share the connection', async () => {
    publishAdminEvent({
      kind: 'sourcetv_watch', matchId, serverId: 1, spectatorName: 'Watcher', steamids: [IDS[2], IDS[3]],
    });
    await feed.idle();
    const line = t.live()[0].payload.embeds[0].description ?? '';
    expect(line).toContain('**player2**');
    expect(line).toContain('**player3**');
    expect(line).toContain('and **player3**');
    expect(line).toContain('who are playing');
    expect(t.live()).toHaveLength(1);
  });

  it('SourceTV watch alerts ride the problems toggle', async () => {
    setSetting(db, 'admin_feed_problems', '0');
    publishAdminEvent({
      kind: 'sourcetv_watch', matchId, serverId: 1, spectatorName: 'Watcher', steamids: [IDS[2]],
    });
    await feed.idle();
    expect(t.live()).toHaveLength(0);
  });

  it('escapes a SourceTV spectator name, which the engine hands over unauthenticated', async () => {
    publishAdminEvent({
      kind: 'sourcetv_watch', matchId, serverId: 1, spectatorName: '*evil*', steamids: [IDS[2]],
    });
    await feed.idle();
    const line = t.live()[0].payload.embeds[0].description ?? '';
    expect(line).toContain('\\*evil\\*');
  });

  it('a secret setting change never shows its value', async () => {
    logAdmin(db, ADMIN, 'setting', 'invite_code', { changed: true });
    await feed.idle();
    expect(text(0)).toMatch(/changed the invite_code setting/i);
  });

  it('cpu_level is worded by what the server did, not as someone playing on it', async () => {
    const line = (i: number) => t.live()[i].payload.embeds[0].description ?? '';
    publishAdminEvent({ kind: 'cvar_flag', steamid: IDS[2], matchId, cvar: 'cpu_level', value: 0, act: 'held' });
    publishAdminEvent({ kind: 'cvar_flag', steamid: IDS[2], matchId, cvar: 'cpu_level', value: 2, act: 'fixed' });
    publishAdminEvent({ kind: 'cvar_flag', steamid: IDS[3], matchId, cvar: 'cpu_level', value: 0, act: 'live' });
    await feed.idle();
    expect(line(0)).toContain('**player2**');
    expect(line(0)).toContain('tried to ready up');
    expect(line(0)).toContain('holding ready-up until they change it');
    expect(line(0)).not.toContain('is playing');
    expect(line(1)).toContain('changed Effect Detail off Low');
    expect(line(1)).toContain('`cpu_level 2`');
    expect(line(2)).toContain('during live play');
    expect(line(2)).toContain('switched after the round went live');
    for (const i of [0, 1, 2]) expect(line(i)).toContain(`[#${matchId}](https://pug.test/match/${matchId})`);
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
    expect(text(0)).toContain(`https://pug.test/admin/live?live=${matchId}`);
    expect(text(0)).toContain(`https://pug.test/match/${matchId}`);
    expect(text(1)).toMatch(/hold on .*player2.* released itself/);
    expect(text(1)).toContain('197 s');
    // name() bolds the player itself, so a line that wraps it in its own
    // asterisks renders four of them and no bold at all.
    expect(text(0)).not.toContain('****');
    expect(text(1)).not.toContain('****');
  });
});
