import { describe, it, expect, beforeEach } from 'vitest';
import { openDb, type DB } from '../src/db.js';
import { upsertPlayer, activatePlayer } from '../src/players.js';
import { banPlayer, addNote } from '../src/admin/players.js';
import { recordPenalty } from '../src/penalties.js';
import { fileViewer } from '../src/admin/fileAccess.js';
import { playerFile } from '../src/admin/playerFile.js';
import { playerFileSummary } from '../src/admin/playerFileSummary.js';
import { peopleBans } from '../src/admin/peopleBans.js';
import { markLookedAt } from '../src/admin/reviews.js';
import { WITHHELD_REASON } from '../src/admin/banRedaction.js';
import { openStaffTicket } from '../src/tickets/filing.js';
import { banFromTicket, setRestricted } from '../src/tickets/actions.js';

const P = '76561199000000001';
const MOD = '76561199000000003';
const ADMIN = '76561199000000005';
const OTHER = '76561199000000006';
let db: DB;

beforeEach(() => {
  db = openDb(':memory:');
  for (const id of [P, MOD, ADMIN, OTHER]) {
    upsertPlayer(db, { steamid: id, name: `p${id.slice(-3)}`, avatar: null }, []);
    activatePlayer(db, id);
  }
  db.prepare('UPDATE players SET is_mod = 1 WHERE steamid = ?').run(MOD);
  db.prepare('UPDATE players SET is_admin = 1 WHERE steamid = ?').run(ADMIN);
});

const flag = (steamid: string, at: string) =>
  db.prepare(
    `INSERT INTO integrity_flags (match_id, server_id, steamid, source, kind, severity, detail, at)
     VALUES (NULL, 1, ?, 'lilac', 'aimbot', 'suspected', '', ?)`,
  ).run(steamid, at);

describe('the Player File', () => {
  it('is null for an unknown player and for a file the viewer may not open', () => {
    expect(playerFile(db, '76561199000000999', fileViewer(db, ADMIN))).toBeNull();
    expect(playerFile(db, MOD, fileViewer(db, MOD))).toBeNull();
    expect(playerFile(db, ADMIN, fileViewer(db, MOD))).toBeNull();
    expect(playerFile(db, P, fileViewer(db, OTHER))).toBeNull();
  });

  it('carries a header, a glance, a timeline and every section', () => {
    recordPenalty(db, P, 'no_show', null);
    addNote(db, P, ADMIN, 'spoke to them');
    flag(P, new Date().toISOString());
    const file = playerFile(db, P, fileViewer(db, ADMIN))!;

    expect(file.header).toMatchObject({ steamid: P, name: 'p001', status: 'active', isAdmin: false });
    expect(file.glance.evidence).toContainEqual({ source: 'lilac', count: 1 });
    expect(file.glance.fileUrl).toBe(`/admin/people/${P}`);
    expect(file.timeline.length).toBeGreaterThan(0);
    expect(Object.keys(file.sections).sort())
      .toEqual(['evidence', 'identity', 'matches', 'notes', 'standing', 'tickets']);
    expect(file.sections.notes[0].text).toBe('spoke to them');
    expect(file.sections.standing.penalties).toHaveLength(1);
    expect(file.lastReview).toBeNull();
    markLookedAt(db, P, ADMIN, 'fine');
    expect(playerFile(db, P, fileViewer(db, ADMIN))!.lastReview!.note).toBe('fine');
  });

  it('counts evidence only inside the window, so an old flag stops shouting', () => {
    const old = new Date(Date.now() - 40 * 86_400_000).toISOString();
    flag(P, old);
    const summary = playerFileSummary(db, P, fileViewer(db, ADMIN))!;
    expect(summary.evidence).toEqual([]);
  });

  it('gives a moderator every section and only the moderator actions', () => {
    const asMod = playerFile(db, P, fileViewer(db, MOD))!;
    expect(asMod.actions).toEqual(['note', 'looked_at', 'open_ticket']);
    // The owner reversed the first ruling: mods see network rows too.
    expect(asMod.sections.identity).toHaveProperty('sharesAddressWith');
    expect(asMod.sections.identity).toHaveProperty('networks');
    expect(playerFile(db, P, fileViewer(db, ADMIN))!.actions).toContain('ban');
  });

  // The board reads every integrity_rounds row at the current analyzer
  // version and JSON.parses each blob, synchronously, on the one thread that
  // also holds the game servers' heartbeats. Opening a file used to do it
  // twice: once for the evidence section and once for the glance.
  it('builds the analyzer board once, not once per reader of it', () => {
    const real = db.prepare.bind(db);
    let boards = 0;
    // The board's own query is the one that reaches for the round's map
    // through the aim prior; integrityPlayer reads the same table without it.
    db.prepare = ((sql: string) => {
      if (sql.includes('FROM integrity_rounds r') && sql.includes('pr.map')) boards++;
      return real(sql);
    }) as typeof db.prepare;

    const file = playerFile(db, P, fileViewer(db, ADMIN))!;
    db.prepare = real;
    expect(boards).toBe(1);
    expect(file.glance.analyzer).toEqual(file.sections.evidence.analyzer);
  });

  it('withholds a restricted ticket\'s ban reason in the standing section and on the ban list', () => {
    const t = openStaffTicket(db, ADMIN, { targetId: P, restricted: true }, { adminSteamIds: [ADMIN] }) as { ticketId: number };
    setRestricted(db, t.ticketId, ADMIN, true, [ADMIN]);
    banFromTicket(db, t.ticketId, ADMIN, 'cheating, see the case', 1440);

    const asMod = playerFile(db, P, fileViewer(db, MOD))!;
    expect(asMod.sections.standing.bans[0].reason).toBe(WITHHELD_REASON);
    expect(asMod.sections.standing.activeBan!.createdBy).toBe('');

    const [row] = peopleBans(db, fileViewer(db, MOD));
    expect(row.reason).toBe(WITHHELD_REASON);
    expect(row.withheld).toBe(true);
    expect(row.ticketId).toBeNull();
    expect(peopleBans(db, fileViewer(db, ADMIN))[0].reason).toBe('cheating, see the case');
  });
});

describe('the summary\'s own access gate', () => {
  it('is null for any non-staff viewer, however it got there', () => {
    expect(playerFileSummary(db, P, fileViewer(db, OTHER))).toBeNull();
    banPlayer(db, OTHER, ADMIN, 'throwing', null);
    expect(playerFileSummary(db, P, fileViewer(db, OTHER))).toBeNull();
  });

  it('answers for a moderator even when the target is staff, but with no fileUrl', () => {
    // canOpenFile refuses a moderator a colleague's file; the summary is not
    // gated on canOpenFile, only on the viewer being staff at all, since the
    // ticket case file shows this to a moderator an admin deliberately added
    // to a restricted ticket about a staff member.
    const summary = playerFileSummary(db, ADMIN, fileViewer(db, MOD))!;
    expect(summary).not.toBeNull();
    expect(summary.fileUrl).toBeNull();
  });

  it('gives a moderator a real fileUrl for an ordinary player', () => {
    const summary = playerFileSummary(db, P, fileViewer(db, MOD))!;
    expect(summary.fileUrl).toBe(`/admin/people/${P}`);
  });
});

describe('the ban list inside the panel', () => {
  it('filters, searches, says how long each ran, and says which rows open a file', () => {
    banPlayer(db, P, ADMIN, 'throwing', 1440);
    banPlayer(db, MOD, ADMIN, 'left a match', null);
    const admin = fileViewer(db, ADMIN);

    expect(peopleBans(db, admin).map((b) => b.steamid).sort()).toEqual([MOD, P].sort());
    expect(peopleBans(db, admin, { filter: 'active' })).toHaveLength(2);
    expect(peopleBans(db, admin, { filter: 'expired' })).toHaveLength(0);
    expect(peopleBans(db, admin, { q: 'p001' }).map((b) => b.steamid)).toEqual([P]);
    expect(peopleBans(db, admin).find((b) => b.steamid === P)!.length).toBe('1 day');
    expect(peopleBans(db, admin).find((b) => b.steamid === MOD)!.length).toBe('permanent');

    // A moderator sees the staff row and is told they cannot open that file.
    const asMod = peopleBans(db, fileViewer(db, MOD));
    expect(asMod.find((b) => b.steamid === MOD)!.canOpen).toBe(false);
    expect(asMod.find((b) => b.steamid === P)!.canOpen).toBe(true);
  });

  it('counts an expired ban as expired without hiding it', () => {
    banPlayer(db, P, ADMIN, 'short', 1, new Date(Date.now() - 3 * 60_000));
    const rows = peopleBans(db, fileViewer(db, ADMIN), { filter: 'expired' });
    expect(rows).toHaveLength(1);
    expect(rows[0].active).toBe(false);
    expect(peopleBans(db, fileViewer(db, ADMIN), { filter: 'active' })).toHaveLength(0);
  });
});
