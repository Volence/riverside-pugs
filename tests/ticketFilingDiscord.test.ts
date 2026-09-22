import { describe, it, expect, beforeEach } from 'vitest';
import { openDb, type DB } from '../src/db.js';
import { upsertPlayer, activatePlayer, unlinkDiscord } from '../src/players.js';
import { fileReport, DISCORD_REPORT_GAP_MS, type DiscordReporter, type PickedTarget } from '../src/tickets/filing.js';

const P1 = '76561199000000501';
const LINKED = '76561199000000502';
const OWNER = '76561199000000503';
const deps = { adminSteamIds: [OWNER] };
let db: DB;
const lurker = (over: Partial<PickedTarget> = {}): PickedTarget => ({ discordId: '901', name: 'Lurky', bot: false, administrator: false, ...over });
const dReporter = (over: Partial<DiscordReporter> = {}): DiscordReporter => ({ kind: 'discord', discordId: '902', name: 'Newbie', timedOutUntil: null, ...over });
// deps with a picked Discord target set, the way a Discord surface builds them: never from the request body.
const withTarget = (over: Partial<PickedTarget> = {}) => ({ ...deps, targetDiscord: lurker(over) });

beforeEach(() => {
  db = openDb(':memory:');
  for (const id of [P1, LINKED, OWNER]) {
    upsertPlayer(db, { steamid: id, name: id.slice(-3), avatar: null }, []);
    activatePlayer(db, id);
  }
  db.prepare("UPDATE players SET discord_id = '700' WHERE steamid = ?").run(LINKED);
  db.prepare('UPDATE players SET is_admin = 1 WHERE steamid = ?').run(OWNER);
});

const ticket = () => db.prepare('SELECT target_id, target_discord_id, target_name, restricted FROM tickets').get();

describe('fileReport with Discord people', () => {
  it('a player reports a Discord-only member', () => {
    expect(fileReport(db, P1, { category: 'toxicity', text: 'dms' }, withTarget())).toMatchObject({ ok: true, created: true, restricted: false });
    expect(ticket()).toEqual({ target_id: null, target_discord_id: '901', target_name: 'Lurky', restricted: 0 });
  });

  it('a picked member who has linked Steam is reported as the player', () => {
    fileReport(db, P1, { category: 'afk', text: '' }, withTarget({ discordId: '700', name: 'whatever' }));
    expect(ticket()).toMatchObject({ target_id: LINKED, target_discord_id: null });
  });

  it('a Discord-only member files a report, stored under their Discord id', () => {
    expect(fileReport(db, dReporter(), { targetId: P1, category: 'toxicity', text: '' }, deps)).toMatchObject({ ok: true });
    expect(db.prepare('SELECT reporter_id, reporter_discord_id, reporter_name FROM ticket_reports').get())
      .toEqual({ reporter_id: null, reporter_discord_id: '902', reporter_name: 'Newbie' });
  });

  it('a Discord reporter who has linked Steam files as the player, standing checks and all', () => {
    db.prepare("UPDATE players SET status = 'banned' WHERE steamid = ?").run(LINKED);
    expect(fileReport(db, dReporter({ discordId: '700' }), { targetId: P1, category: 'afk', text: '' }, deps)).toMatchObject({ ok: false, status: 403 });
  });

  it('refuses bots, yourself, and yourself through your own Discord account', () => {
    expect(fileReport(db, P1, { category: 'afk', text: '' }, withTarget({ bot: true }))).toMatchObject({ ok: false, status: 400 });
    expect(fileReport(db, dReporter({ discordId: '901' }), { category: 'afk', text: '' }, withTarget())).toMatchObject({ ok: false, status: 400 });
    expect(fileReport(db, LINKED, { category: 'afk', text: '' }, withTarget({ discordId: '700' }))).toMatchObject({ ok: false, status: 400 });
  });

  it('refuses a Discord id whose most recently linked account is banned, even after it was unlinked', () => {
    // LINKED was linked to discord id '700' in beforeEach. Unlink it (an
    // admin unlink, or the player unlinking before the ban), ban the
    // account, and file as the now Discord-only '700': linkDiscord already
    // refuses the opposite direction (a banned account's Discord cannot
    // attach to a NEW steamid) via discord_link_history; this is the same
    // rule read the other way.
    unlinkDiscord(db, LINKED);
    db.prepare("INSERT INTO bans (player_id, reason, created_by, created_at) VALUES (?, 'x', 'system', datetime('now'))").run(LINKED);
    expect(fileReport(db, dReporter({ discordId: '700' }), { targetId: P1, category: 'afk', text: '' }, deps)).toMatchObject({ ok: false, status: 403 });
  });

  it('does not block a Discord id whose previous owner was unlinked but never banned', () => {
    unlinkDiscord(db, LINKED);
    expect(fileReport(db, dReporter({ discordId: '700' }), { targetId: P1, category: 'afk', text: '' }, deps)).toMatchObject({ ok: true });
  });

  it('refuses a timed-out or sanctioned Discord reporter', () => {
    const later = new Date(Date.now() + 60_000).toISOString();
    expect(fileReport(db, dReporter({ timedOutUntil: later }), { targetId: P1, category: 'afk', text: '' }, deps)).toMatchObject({ ok: false, status: 403 });
    db.prepare("INSERT INTO discord_sanctions (discord_id, kind, until, reason, created_by, created_at) VALUES ('902', 'ban', NULL, 'x', ?, 'x')").run(OWNER);
    expect(fileReport(db, dReporter(), { targetId: P1, category: 'afk', text: '' }, deps)).toMatchObject({ ok: false, status: 403 });
  });

  it('holds a Discord reporter to one report per ten minutes', () => {
    const now = new Date('2026-09-22T12:00:00Z');
    expect(fileReport(db, dReporter(), { targetId: P1, category: 'afk', text: '' }, { ...deps, now })).toMatchObject({ ok: true });
    expect(fileReport(db, dReporter(), { targetId: LINKED, category: 'afk', text: '' }, { ...deps, now: new Date(now.getTime() + 60_000) })).toMatchObject({ ok: false, status: 429 });
    expect(fileReport(db, dReporter(), { targetId: LINKED, category: 'afk', text: '' }, { ...deps, now: new Date(now.getTime() + DISCORD_REPORT_GAP_MS + 1) })).toMatchObject({ ok: true });
  });

  it('refuses a match when either side is Discord-only', () => {
    expect(fileReport(db, P1, { category: 'afk', text: '', matchId: 1 }, withTarget())).toMatchObject({ ok: false, status: 400 });
  });

  it('restricts a report about a Discord administrator, and an unsafe one', () => {
    expect(fileReport(db, P1, { category: 'toxicity', text: '' }, withTarget({ administrator: true }))).toMatchObject({ ok: true, restricted: true });
    expect(fileReport(db, P1, { category: 'unsafe', text: 'x' }, withTarget({ discordId: '903' }))).toMatchObject({ ok: true, restricted: true });
  });

  it('keeps one open case per Discord person, and the duplicate rule', () => {
    const a = fileReport(db, P1, { category: 'afk', text: '' }, withTarget());
    const b = fileReport(db, LINKED, { category: 'afk', text: '' }, withTarget({ name: 'Renamed' }));
    expect((a as { ticketId: number }).ticketId).toBe((b as { ticketId: number }).ticketId);
    expect(fileReport(db, P1, { category: 'afk', text: '' }, withTarget())).toMatchObject({ ok: false, status: 409 });
  });

  it('ignores a targetDiscord smuggled in the request body: a site surface cannot pick a Discord target this way', () => {
    const forged = { targetDiscord: lurker({ administrator: true, name: 'Forged' }) } as unknown as { targetId?: unknown };
    expect(fileReport(db, P1, { ...forged, category: 'toxicity', text: '' }, deps)).toMatchObject({ ok: false, status: 400, error: 'pick a player' });
    expect(db.prepare('SELECT COUNT(*) AS n FROM tickets').get()).toEqual({ n: 0 });
    expect(db.prepare('SELECT COUNT(*) AS n FROM ticket_reports').get()).toEqual({ n: 0 });
  });
});
