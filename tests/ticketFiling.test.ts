import { describe, it, expect, beforeEach } from 'vitest';
import { openDb, type DB } from '../src/db.js';
import { upsertPlayer, activatePlayer } from '../src/players.js';
import { setSetting } from '../src/settings.js';
import { fileReport, matchReportTargets, myReports, openStaffTicket } from '../src/tickets/filing.js';

const IDS = Array.from({ length: 8 }, (_, i) => `7656119900000000${i}`);
const [R1, R2, R3, ACCUSED, MOD, ADMIN, OWNER] = IDS;
const deps = { adminSteamIds: [OWNER] };
let db: DB;
let matchId: number;

beforeEach(() => {
  db = openDb(':memory:');
  for (const id of IDS) {
    upsertPlayer(db, { steamid: id, name: `p${id.slice(-1)}`, avatar: null }, []);
    activatePlayer(db, id);
  }
  db.prepare('UPDATE players SET is_mod = 1 WHERE steamid = ?').run(MOD);
  db.prepare('UPDATE players SET is_admin = 1 WHERE steamid IN (?, ?)').run(ADMIN, OWNER);
  matchId = Number(db.prepare("INSERT INTO matches (season_id, state, campaign) VALUES (1, 'completed', 'dead_air')").run().lastInsertRowid);
  const ins = db.prepare('INSERT INTO match_players (match_id, player_id, team) VALUES (?, ?, ?)');
  [R1, R2, ACCUSED].forEach((id, i) => ins.run(matchId, id, i < 2 ? 'a' : 'b'));
});

const tickets = () => db.prepare('SELECT * FROM tickets ORDER BY id').all() as { id: number; target_id: string; restricted: number; status: string }[];

describe('fileReport', () => {
  it('the first report opens a ticket and later ones attach to it', () => {
    const a = fileReport(db, R1, { targetId: ACCUSED, category: 'cheating', text: 'walls', matchId }, deps);
    const b = fileReport(db, R2, { targetId: ACCUSED, category: 'griefing', text: '' }, deps);
    expect(a).toMatchObject({ ok: true, created: true, restricted: false });
    expect(b).toMatchObject({ ok: true, created: false });
    expect(tickets()).toHaveLength(1);
    expect((a as { ticketId: number }).ticketId).toBe((b as { ticketId: number }).ticketId);
    const kinds = (db.prepare('SELECT kind FROM ticket_events ORDER BY id').all() as { kind: string }[]).map((e) => e.kind);
    expect(kinds).toEqual(['opened', 'report_attached']);
  });

  it('a closed ticket does not take new reports: a new one opens', () => {
    fileReport(db, R1, { targetId: ACCUSED, category: 'afk', text: '' }, deps);
    db.prepare("UPDATE tickets SET status = 'closed'").run();
    fileReport(db, R2, { targetId: ACCUSED, category: 'afk', text: '' }, deps);
    expect(tickets().map((t) => t.status)).toEqual(['closed', 'open']);
  });

  it('an unsafe report opens a restricted sibling, seeded with the owner, and needs text', () => {
    fileReport(db, R1, { targetId: ACCUSED, category: 'toxicity', text: '' }, deps);
    expect(fileReport(db, R2, { targetId: ACCUSED, category: 'unsafe', text: '  ' }, deps)).toMatchObject({ ok: false, status: 400 });
    const r = fileReport(db, R2, { targetId: ACCUSED, category: 'unsafe', text: 'details' }, deps);
    expect(r).toMatchObject({ ok: true, created: true, restricted: true });
    expect(tickets().map((t) => t.restricted)).toEqual([0, 1]);
    const access = db.prepare('SELECT steamid FROM ticket_access').all() as { steamid: string }[];
    expect(access.map((a) => a.steamid)).toEqual([OWNER]);
  });

  it('a report about staff is restricted, and the accused is never on the access list', () => {
    expect(fileReport(db, R1, { targetId: MOD, category: 'toxicity', text: '' }, deps)).toMatchObject({ restricted: true });
    fileReport(db, R1, { targetId: OWNER, category: 'toxicity', text: '' }, deps);
    const t = tickets().find((x) => x.target_id === OWNER)!;
    const access = (db.prepare('SELECT steamid FROM ticket_access WHERE ticket_id = ?').all(t.id) as { steamid: string }[]).map((a) => a.steamid);
    expect(access).toEqual([ADMIN]);
  });

  it('refuses self, unknown players, inactive reporters, bad categories, long text', () => {
    const bad = (body: object, as = R1) => fileReport(db, as, body, deps);
    expect(bad({ targetId: R1, category: 'afk' })).toMatchObject({ ok: false, status: 400 });
    expect(bad({ targetId: '76561199999999999', category: 'afk' })).toMatchObject({ ok: false, status: 404 });
    expect(bad({ targetId: ACCUSED, category: 'rude' })).toMatchObject({ ok: false, status: 400 });
    expect(bad({ targetId: ACCUSED, category: 'other', text: 'x'.repeat(1001) })).toMatchObject({ ok: false, status: 400 });
    db.prepare("UPDATE players SET status = 'banned' WHERE steamid = ?").run(R3);
    expect(bad({ targetId: ACCUSED, category: 'afk' }, R3)).toMatchObject({ ok: false, status: 403 });
  });

  it('checks the match and the moment', () => {
    expect(fileReport(db, R1, { targetId: ACCUSED, category: 'afk', matchId: 999 }, deps)).toMatchObject({ ok: false, status: 404 });
    expect(fileReport(db, R1, { targetId: R3, category: 'afk', matchId }, deps)).toMatchObject({ ok: false, status: 400 });
    expect(fileReport(db, R1, { targetId: ACCUSED, category: 'afk', moment: { ordinal: 1, half: 0, tMs: 5 } }, deps)).toMatchObject({ ok: false, status: 400 });
    const ok = fileReport(db, R1, { targetId: ACCUSED, category: 'afk', matchId, moment: { ordinal: 2, half: 1, tMs: 61500 } }, deps);
    expect(ok.ok).toBe(true);
    expect(db.prepare('SELECT match_id, map_ordinal, half, t_ms FROM ticket_reports').get()).toEqual({ match_id: matchId, map_ordinal: 2, half: 1, t_ms: 61500 });
  });

  it('one report per reporter, target and match; one match-less report per open ticket', () => {
    const body = { targetId: ACCUSED, category: 'afk', matchId };
    expect(fileReport(db, R1, body, deps).ok).toBe(true);
    expect(fileReport(db, R1, body, deps)).toMatchObject({ ok: false, status: 409 });
    expect(fileReport(db, R1, { targetId: ACCUSED, category: 'afk' }, deps).ok).toBe(true);
    expect(fileReport(db, R1, { targetId: ACCUSED, category: 'other' }, deps)).toMatchObject({ ok: false, status: 409 });
  });

  it('rate limits per reporter over 24 hours', () => {
    setSetting(db, 'ticket_reports_per_day', '2');
    const now = new Date('2026-09-21T12:00:00.000Z');
    expect(fileReport(db, R1, { targetId: ACCUSED, category: 'afk' }, { ...deps, now }).ok).toBe(true);
    expect(fileReport(db, R1, { targetId: R2, category: 'afk' }, { ...deps, now }).ok).toBe(true);
    expect(fileReport(db, R1, { targetId: R3, category: 'afk' }, { ...deps, now })).toMatchObject({ ok: false, status: 429 });
    const later = new Date('2026-09-22T12:00:01.000Z');
    expect(fileReport(db, R1, { targetId: R3, category: 'afk' }, { ...deps, now: later }).ok).toBe(true);
  });
});

describe('openStaffTicket', () => {
  it('opens a ticket with no report, and reuses the open one', () => {
    const a = openStaffTicket(db, MOD, { targetId: ACCUSED, note: 'seen in discord' }, deps);
    const b = openStaffTicket(db, ADMIN, { targetId: ACCUSED }, deps);
    expect(a).toMatchObject({ ok: true });
    expect(b).toEqual(a);
    expect(db.prepare('SELECT COUNT(*) AS n FROM ticket_reports').get()).toEqual({ n: 0 });
    expect(openStaffTicket(db, MOD, { targetId: MOD }, deps)).toMatchObject({ ok: false, status: 400 });
  });

  it('a hand-restricted ticket lets its opener in', () => {
    const r = openStaffTicket(db, MOD, { targetId: ACCUSED, restricted: true }, deps) as { ticketId: number };
    const access = (db.prepare('SELECT steamid FROM ticket_access WHERE ticket_id = ? ORDER BY steamid').all(r.ticketId) as { steamid: string }[]).map((a) => a.steamid);
    expect(access).toEqual([MOD, OWNER].sort());
  });
});

describe('matchReportTargets and myReports', () => {
  it('lists the roster minus the viewer, marking who is already reported', () => {
    fileReport(db, R1, { targetId: ACCUSED, category: 'afk', matchId }, deps);
    const t = matchReportTargets(db, matchId, R1);
    expect(t).toEqual({ canReport: true, targets: [{ steamid: R2, name: 'p1', alreadyReported: false }, { steamid: ACCUSED, name: 'p3', alreadyReported: true }] });
    expect(matchReportTargets(db, 999, R1)).toMatchObject({ canReport: false, status: 404 });
  });

  it('shows a reporter their own reports with open or closed and nothing else', () => {
    fileReport(db, R1, { targetId: ACCUSED, category: 'cheating', text: 'x', matchId }, deps);
    db.prepare("UPDATE tickets SET status = 'closed', outcome = 'action_taken', outcome_note = 'banned'").run();
    const mine = myReports(db, R1);
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({ targetId: ACCUSED, targetName: 'p3', category: 'cheating', matchId, status: 'closed' });
    expect(Object.keys(mine[0]).sort()).toEqual(['category', 'createdAt', 'id', 'matchId', 'status', 'targetId', 'targetName']);
  });
});
