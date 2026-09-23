import { describe, it, expect, beforeEach } from 'vitest';
import { openDb, type DB } from '../src/db.js';
import { upsertPlayer, activatePlayer, linkDiscord } from '../src/players.js';
import { setSetting } from '../src/settings.js';
import { fileReport } from '../src/tickets/filing.js';
import { reporterThreadsOf, CHAT_CLOSED } from '../src/tickets/reporterChat.js';
import { ReporterChats } from '../src/discord/reporterChats.js';
import { ReportButton, handleReportButton, handleReportModal } from '../src/discord/reportButton.js';
import { handleTicketButton, handleTicketModal } from '../src/discord/ticketButtons.js';
import { closeModal, ticketCard } from '../src/discord/ticketCard.js';
import { FakeTransport } from './fakes/fakeTransport.js';

const IDS = Array.from({ length: 8 }, (_, i) => `7656119900000044${i}`);
const [R1, R2, ACCUSED, , , , MOD, ADMIN] = IDS;
const D = (id: string) => `98${IDS.indexOf(id)}`;
let db: DB;
let t: FakeTransport;
let chats: ReporterChats;

beforeEach(() => {
  db = openDb(':memory:');
  IDS.forEach((id, i) => {
    upsertPlayer(db, { steamid: id, name: `player${i}`, avatar: null }, []);
    activatePlayer(db, id);
    linkDiscord(db, id, `98${i}`, `d${i}`);
  });
  db.prepare('UPDATE players SET is_mod = 1 WHERE steamid = ?').run(MOD);
  db.prepare('UPDATE players SET is_admin = 1 WHERE steamid = ?').run(ADMIN);
  setSetting(db, 'discord_tickets_channel_id', 'chan1');
  setSetting(db, 'discord_report_channel_id', 'reports');
  t = new FakeTransport();
  chats = new ReporterChats({ db, transport: t, publicUrl: 'https://pug.test', guildId: 'g1' });
});

const reportDeps = () => ({ db, adminSteamIds: [ADMIN], chats: () => chats });
const ticketDeps = () => ({ db, publicUrl: 'https://pug.test', chats: () => chats });
const press = (userId: string, customId: string, presserTimedOutUntil: string | null = null) =>
  handleReportButton(reportDeps(), { kind: 'button', customId, userId, userName: 'x', presserTimedOutUntil });
const staffPress = (steamid: string, customId: string) =>
  handleTicketButton(ticketDeps(), { kind: 'button', customId, userId: D(steamid), userName: 'x', presserTimedOutUntil: null });
const file = (by: string, target: string, category = 'griefing') =>
  fileReport(db, by, { targetId: target, category, text: 'x' }, { adminSteamIds: [ADMIN] }) as { reportId: number; ticketId: number };
const buttonIds = (r: { payload: { components: unknown[][] } }) =>
  r.payload.components.flat().map((b) => (b as { customId?: string; url?: string }).customId ?? (b as { url: string }).url);

describe('the reporter\'s side', () => {
  it('the receipt carries a Chat button keyed by the report, never the ticket', async () => {
    const r = await handleReportModal(reportDeps(), {
      kind: 'modal', customId: 'rp:new', userId: D(R1), userName: 'x', presserTimedOutUntil: null,
      fields: { who: ACCUSED, reason: 'griefing', details: 'threw' }, picked: {},
    });
    const reportId = (db.prepare('SELECT id FROM ticket_reports').get() as { id: number }).id;
    expect(buttonIds(r)).toEqual([`rp:chat:${reportId}`]);
  });

  it('the report message has My reports beside Report a player', async () => {
    const button = new ReportButton({ db, transport: t, intervalMs: 0 });
    await button.tick();
    const [msg] = t.live().filter((m) => m.channelId === 'reports');
    expect(buttonIds({ payload: msg.payload })).toEqual(['rp:open', 'rp:mine']);
  });

  it('My reports lists the presser\'s open reports with a Chat button each', async () => {
    const a = file(R1, ACCUSED);
    const b = file(R1, R2, 'afk');
    const r = await press(D(R1), 'rp:mine');
    expect(r.ephemeral).toBe(true);
    expect(buttonIds(r)).toEqual([`rp:chat:${b.reportId}`, `rp:chat:${a.reportId}`]);
    expect(JSON.stringify(r.payload)).toContain('player1 (afk)');
    expect((await press('4242', 'rp:mine')).payload.content).toMatch(/no open reports/);
  });

  it('Chat opens the chat and links it; somebody else pressing it gets the closed answer', async () => {
    const a = file(R1, ACCUSED);
    const r = await press(D(R1), `rp:chat:${a.reportId}`);
    const [th] = reporterThreadsOf(db, a.ticketId);
    expect(buttonIds(r)).toEqual([`https://discord.com/channels/g1/${th.thread_id}`]);
    expect((await press(D(R2), `rp:chat:${a.reportId}`)).payload.content).toBe(CHAT_CLOSED);
  });

  it('a Discord-only member can chat about their report', async () => {
    const f = fileReport(db, { kind: 'discord', discordId: '4242', name: 'Lurky', timedOutUntil: null },
      { targetId: ACCUSED, category: 'toxicity', text: '' }, { adminSteamIds: [ADMIN] }) as { reportId: number };
    const r = await press('4242', `rp:chat:${f.reportId}`);
    expect(r.payload.content).toMatch(/open/);
  });

  it('with the bot not ready, it says so', async () => {
    const a = file(R1, ACCUSED);
    const r = await handleReportButton({ db, adminSteamIds: [ADMIN], chats: () => null }, {
      kind: 'button', customId: `rp:chat:${a.reportId}`, userId: D(R1), userName: 'x', presserTimedOutUntil: null,
    });
    expect(r.payload.content).toMatch(/not available right now/);
  });

  it('a Discord member whose reports were adopted after linking Steam still sees them in My reports and can chat', async () => {
    // A brand-new Discord id, not yet linked to any player, files a report.
    const discordId = '424242';
    const f = fileReport(db, { kind: 'discord', discordId, name: 'Newbie', timedOutUntil: null },
      { targetId: ACCUSED, category: 'toxicity', text: '' }, { adminSteamIds: [ADMIN] }) as { reportId: number };
    expect((db.prepare('SELECT reporter_id, reporter_discord_id FROM ticket_reports WHERE id = ?').get(f.reportId)))
      .toEqual({ reporter_id: null, reporter_discord_id: discordId });

    // They sign in and link Steam: adoption moves the report onto reporter_id
    // and clears reporter_discord_id (adoptDiscordPerson).
    const newSteamid = '76561199000000099';
    upsertPlayer(db, { steamid: newSteamid, name: 'newbie', avatar: null }, []);
    activatePlayer(db, newSteamid);
    linkDiscord(db, newSteamid, discordId, 'Newbie');
    expect((db.prepare('SELECT reporter_id, reporter_discord_id FROM ticket_reports WHERE id = ?').get(f.reportId)))
      .toEqual({ reporter_id: newSteamid, reporter_discord_id: null });

    // A naive lookup by reporter_discord_id (their raw Discord identity) would
    // now find nothing: whoIsPressing resolves the link first, so My reports
    // and Chat still find it through reporter_id.
    const mine = await press(discordId, 'rp:mine');
    expect(buttonIds(mine)).toEqual([`rp:chat:${f.reportId}`]);
    const chat = await press(discordId, `rp:chat:${f.reportId}`);
    expect(buttonIds(chat)[0]).toMatch(/^https:\/\/discord.com\/channels\/g1\//);
  });

  it('a Discord-only presser under a Discord timeout is refused a chat, as filing refuses them', async () => {
    const f = fileReport(db, { kind: 'discord', discordId: '5150', name: 'Timedout', timedOutUntil: null },
      { targetId: ACCUSED, category: 'toxicity', text: '' }, { adminSteamIds: [ADMIN] }) as { reportId: number };
    const future = new Date(Date.now() + 60_000).toISOString();
    const r = await press('5150', `rp:chat:${f.reportId}`, future);
    expect(r.payload.content).toBe('You cannot open a chat right now.');
  });
});

describe('the staff post', () => {
  it('shows Contact reporter while there are reports, and Join and End while a chat is open', async () => {
    const a = file(R1, ACCUSED);
    expect(buttonIds({ payload: ticketCard(db, a.ticketId, 'https://pug.test')!.payload })).toContain(`t:${a.ticketId}:contact`);
    expect(buttonIds({ payload: ticketCard(db, a.ticketId, 'https://pug.test')!.payload })).not.toContain(`t:${a.ticketId}:join`);
    await chats.openForReporter(a.reportId, { kind: 'player', steamid: R1 });
    const ids = buttonIds({ payload: ticketCard(db, a.ticketId, 'https://pug.test')!.payload });
    expect(ids).toEqual(expect.arrayContaining([`t:${a.ticketId}:join`, `t:${a.ticketId}:endchat`]));
  });

  it('Contact with one reporter opens it straight away; with two it asks which', async () => {
    const a = file(R1, ACCUSED);
    const one = await staffPress(MOD, `t:${a.ticketId}:contact`);
    expect(buttonIds(one)[0]).toMatch(/^https:\/\/discord.com\/channels\/g1\//);
    file(R2, ACCUSED, 'afk');
    const which = await staffPress(MOD, `t:${a.ticketId}:contact`);
    expect(buttonIds(which).every((id) => id.startsWith(`t:${a.ticketId}:contact:`))).toBe(true);
    expect(buttonIds(which)).toHaveLength(2);
  });

  it('Join and End from the post, audited quietly on a ticket about staff', async () => {
    db.prepare('UPDATE players SET is_mod = 1 WHERE steamid = ?').run(ACCUSED);
    const a = file(R1, ACCUSED);
    await chats.openForReporter(a.reportId, { kind: 'player', steamid: R1 });
    expect(buttonIds(await staffPress(ADMIN, `t:${a.ticketId}:join`))[0]).toMatch(/^https:/);
    expect((await staffPress(ADMIN, `t:${a.ticketId}:endchat`)).payload.content).toMatch(/ended/);
    expect(reporterThreadsOf(db, a.ticketId, 'ended')).toHaveLength(1);
    const actions = (db.prepare('SELECT action FROM admin_actions ORDER BY id').all() as { action: string }[]).map((x) => x.action);
    expect(actions).toEqual(['ticket_chat_join', 'ticket_chat_end']);
    // The accused cannot press them at all.
    expect((await staffPress(ACCUSED, `t:${a.ticketId}:join`)).payload.content).toBe('No such ticket.');
  });

  it('the close form asks whether to tell the reporters, and No means nobody is told', async () => {
    expect(closeModal(1).fields.map((f) => f.id)).toEqual(['outcome', 'note', 'tell']);
    const a = file(R1, ACCUSED);
    await handleTicketModal(ticketDeps(), {
      kind: 'modal', customId: `t:${a.ticketId}:close`, userId: D(MOD), userName: 'x', presserTimedOutUntil: null,
      fields: { outcome: 'warned', note: '', tell: 'no' }, picked: {},
    });
    expect(db.prepare('SELECT COUNT(*) AS n FROM ticket_notices').get()).toEqual({ n: 0 });
  });
});
