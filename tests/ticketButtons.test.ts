import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openDb, type DB } from '../src/db.js';
import { upsertPlayer, activatePlayer, linkDiscord } from '../src/players.js';
import { setSetting } from '../src/settings.js';
import { fileReport } from '../src/tickets/filing.js';
import { subscribeAdminEvents, type AdminEvent } from '../src/adminFeed.js';
import { staffThread } from '../src/tickets/threads.js';
import { TicketSync } from '../src/discord/ticketSync.js';
import { handleTicketButton, handleTicketModal, opensTicketModal } from '../src/discord/ticketButtons.js';
import { FakeTransport } from './fakes/fakeTransport.js';

const IDS = Array.from({ length: 8 }, (_, i) => `7656119900000000${i}`);
const [R1, PLAYER, STAFF_ACCUSED, , ACCUSED, MOD2, MOD, ADMIN] = IDS;
const D = (steamid: string) => `90${IDS.indexOf(steamid)}`;
let db: DB;
let normal: number;
let restricted: number;
let aboutStaff: number;
let events: AdminEvent[];
let off: () => void;
const deps = () => ({ db, publicUrl: 'https://pug.test' });

const press = (steamid: string, customId: string, userId = D(steamid)) =>
  handleTicketButton(deps(), { kind: 'button', customId, userId, userName: 'x', presserTimedOutUntil: null });
const submit = (steamid: string, customId: string, fields: Record<string, string>) =>
  handleTicketModal(deps(), { kind: 'modal', customId, userId: D(steamid), userName: 'x', fields, picked: {}, presserTimedOutUntil: null });
const row = (id: number) => db.prepare('SELECT status, outcome, outcome_note, claimed_by FROM tickets WHERE id = ?').get(id);
const audit = () => (db.prepare('SELECT admin_id, action, target, detail FROM admin_actions ORDER BY id').all() as { admin_id: string; action: string; target: string; detail: string }[])
  .map((a) => ({ ...a, detail: JSON.parse(a.detail) }));

beforeEach(() => {
  db = openDb(':memory:');
  IDS.forEach((id, i) => {
    upsertPlayer(db, { steamid: id, name: `player${i}`, avatar: null }, []);
    activatePlayer(db, id);
    linkDiscord(db, id, `90${i}`, `d${i}`);
  });
  db.prepare('UPDATE players SET is_mod = 1 WHERE steamid IN (?, ?, ?)').run(MOD, MOD2, STAFF_ACCUSED);
  db.prepare('UPDATE players SET is_admin = 1 WHERE steamid = ?').run(ADMIN);
  const file = (targetId: string, category: string) =>
    (fileReport(db, R1, { targetId, category, text: 'x' }, { adminSteamIds: [ADMIN] }) as { ticketId: number }).ticketId;
  normal = file(ACCUSED, 'griefing');
  restricted = file(ACCUSED, 'unsafe');
  aboutStaff = file(STAFF_ACCUSED, 'toxicity');
  events = [];
  off = subscribeAdminEvents((e) => events.push(e));
});
afterEach(() => off());

const content = (r: { payload: { content?: string } }) => r.payload.content ?? '';

describe('who may press', () => {
  it('refuses a player, an unlinked Discord account and a banned moderator, and changes nothing', async () => {
    db.prepare("UPDATE players SET status = 'banned' WHERE steamid = ?").run(MOD2);
    for (const r of [await press(PLAYER, `t:${normal}:claim`), await press(MOD, `t:${normal}:claim`, '555'), await press(MOD2, `t:${normal}:claim`)]) {
      expect(r.ephemeral).toBe(true);
      expect(content(r)).toBe('Staff only.');
    }
    expect(row(normal)).toMatchObject({ claimed_by: null });
    expect(audit()).toEqual([]);
  });

  /** The site's guard is inGoodStanding, which asks the bans table and not
   *  only players.status: the reaper writes status some seconds later, and a
   *  merged alias never has it written at all. */
  it('refuses a moderator whose ban is only in the bans table, as the site does', async () => {
    db.prepare("INSERT INTO bans (player_id, reason, created_by, created_at) VALUES (?, 'x', 'system', ?)")
      .run(MOD, new Date().toISOString());
    expect(db.prepare('SELECT status FROM players WHERE steamid = ?').get(MOD)).toEqual({ status: 'active' });
    expect(content(await press(MOD, `t:${normal}:claim`))).toBe('Staff only.');
    expect(content(await submit(MOD, `t:${normal}:close`, { outcome: 'warned', note: '' }))).toBe('Staff only.');
    expect(row(normal)).toMatchObject({ status: 'open', claimed_by: null });
    expect(audit()).toEqual([]);
  });

  it('answers a ticket you cannot see exactly as it answers one that does not exist', async () => {
    const missing = await press(MOD, 't:9999:claim');
    expect(content(await press(MOD, `t:${restricted}:claim`))).toBe(content(missing));
    expect(content(await press(STAFF_ACCUSED, `t:${aboutStaff}:claim`))).toBe(content(missing));
    expect(content(await submit(MOD, `t:${restricted}:close`, { outcome: 'warned', note: '' }))).toBe(content(missing));
    const closeBtn = await press(MOD, `t:${restricted}:close`);
    expect(closeBtn.modal).toBeUndefined();
    expect(content(closeBtn)).toBe(content(missing));
    expect(row(restricted)).toMatchObject({ status: 'open', claimed_by: null });
    expect(audit()).toEqual([]);
  });
});

describe('Claim and Release', () => {
  it('claims, audits it as coming from Discord, and releases on the next press', async () => {
    expect(content(await press(MOD, `t:${normal}:claim`))).toMatch(/claimed ticket/);
    expect(row(normal)).toMatchObject({ claimed_by: MOD });
    expect(audit()).toEqual([{ admin_id: MOD, action: 'ticket_claim', target: String(normal), detail: { claim: true, via: 'discord' } }]);
    expect(events.filter((e) => e.kind === 'admin_action')).toHaveLength(1);
    // As on the site: a claimed ticket's button releases it, whoever presses.
    expect(content(await press(MOD2, `t:${normal}:claim`))).toMatch(/released ticket/);
    expect(row(normal)).toMatchObject({ claimed_by: null });
  });

  it('on a restricted ticket the audit row is written and the admin feed hears nothing', async () => {
    await press(ADMIN, `t:${restricted}:claim`);
    expect(row(restricted)).toMatchObject({ claimed_by: ADMIN });
    expect(audit()).toHaveLength(1);
    expect(events).toEqual([]);
  });
});

describe('Close', () => {
  it('the button opens a modal and changes nothing; only that button is said to open one', async () => {
    const r = await press(MOD, `t:${normal}:close`);
    expect(r.modal).toMatchObject({ customId: `t:${normal}:close`, title: `Close ticket #${normal}` });
    expect(r.modal!.fields.map((f) => [f.kind, f.id])).toEqual([['select', 'outcome'], ['text', 'note'], ['select', 'tell']]);
    expect(row(normal)).toMatchObject({ status: 'open' });
    expect(opensTicketModal(`t:${normal}:close`)).toBe(true);
    expect(opensTicketModal(`t:${normal}:claim`)).toBe(false);
    expect(opensTicketModal('r:1:close')).toBe(false);
  });

  it('the modal closes the ticket with its outcome and note, audited without the note', async () => {
    expect(content(await submit(MOD, `t:${normal}:close`, { outcome: 'nonsense', note: '' }))).toMatch(/pick an outcome/i);
    expect(row(normal)).toMatchObject({ status: 'open' });
    expect(content(await submit(MOD, `t:${normal}:close`, { outcome: 'warned', note: 'first time' }))).toMatch(/is closed/);
    expect(row(normal)).toMatchObject({ status: 'closed', outcome: 'warned', outcome_note: 'first time' });
    expect(audit()).toEqual([{ admin_id: MOD, action: 'ticket_close', target: String(normal), detail: { outcome: 'warned', via: 'discord' } }]);
    const again = await press(MOD, `t:${normal}:close`);
    expect(again.modal).toBeUndefined();
    expect(content(again)).toMatch(/already closed/);
  });

  it('says the post locks for an ordinary ticket, and that it is removed for one about staff', async () => {
    const normalReply = content(await submit(MOD, `t:${normal}:close`, { outcome: 'warned', note: '' }));
    expect(normalReply).toBe(`Ticket #${normal} is closed. The post locks in a moment.`);
    const staffReply = content(await submit(MOD2, `t:${aboutStaff}:close`, { outcome: 'warned', note: '' }));
    expect(staffReply).toBe(`Ticket #${aboutStaff} is closed. The post is removed in a moment; the discussion is kept on the site.`);
  });

  it('end to end: a close from Discord locks and archives the post', async () => {
    setSetting(db, 'discord_tickets_forum_id', 'forum1');
    const t = new FakeTransport();
    const sync = new TicketSync({ db, transport: t, publicUrl: 'https://pug.test', intervalMs: 0 });
    sync.start();
    await sync.idle();
    const threadId = staffThread(db, normal)!.thread_id;
    await submit(MOD, `t:${normal}:close`, { outcome: 'no_action', note: '' });
    await sync.idle();
    expect(t.threadsById.get(threadId)).toMatchObject({ locked: true, archived: true });
    sync.stop();
  });
});
