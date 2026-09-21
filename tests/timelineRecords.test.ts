import { describe, it, expect, beforeEach } from 'vitest';
import { openDb, type DB } from '../src/db.js';
import { upsertPlayer, activatePlayer, linkDiscord, unlinkDiscord } from '../src/players.js';
import { recordPenalty } from '../src/penalties.js';
import { banPlayer } from '../src/admin/players.js';
import { addNote } from '../src/admin/players.js';
import { playerTimeline } from '../src/admin/playerTimeline.js';
import { WITHHELD_REASON, banRedactor } from '../src/admin/banRedaction.js';
import { fmtBanLength } from '../src/admin/timeline/bans.js';
import { openStaffTicket } from '../src/tickets/filing.js';
import { banFromTicket, setRestricted } from '../src/tickets/actions.js';

const P = '76561199000000001';
const OWNER = '76561199000000009';
const MOD = '76561199000000008';
let db: DB;

beforeEach(() => {
  db = openDb(':memory:');
  for (const id of [P, OWNER, MOD]) {
    upsertPlayer(db, { steamid: id, name: `p${id.slice(-3)}`, avatar: null }, []);
    activatePlayer(db, id);
  }
  db.prepare('UPDATE players SET is_admin = 1 WHERE steamid = ?').run(OWNER);
  db.prepare('UPDATE players SET is_mod = 1 WHERE steamid = ?').run(MOD);
});

const sources = (viewer: string) => playerTimeline(db, P, viewer).map((i) => i.source);

describe('the record sources', () => {
  it('puts a ticket, a penalty, a ban, a note and a Discord link on one list', () => {
    openStaffTicket(db, OWNER, { targetId: P, note: 'keep an eye' }, { adminSteamIds: [OWNER] });
    recordPenalty(db, P, 'no_show', 7);
    banPlayer(db, P, OWNER, 'throwing', 1440);
    addNote(db, P, OWNER, 'spoke to them');
    linkDiscord(db, P, '900', 'name');
    unlinkDiscord(db, P, OWNER);

    const items = playerTimeline(db, P, OWNER);
    expect(new Set(items.map((i) => i.source)))
      .toEqual(new Set(['ticket', 'penalty', 'ban', 'note', 'discord_link']));
    const ban = items.find((i) => i.source === 'ban')!;
    expect(ban.summary).toContain('throwing');
    expect(ban.summary).toContain('1 day');
    const penalty = items.find((i) => i.source === 'penalty')!;
    expect(penalty.matchId).toBe(7);
    expect(penalty.summary).toMatch(/did not connect/i);
    expect(items.filter((i) => i.source === 'discord_link')).toHaveLength(2);
  });

  it('says how long a ban ran in the words the panel already uses', () => {
    expect(fmtBanLength('2026-09-21T00:00:00.000Z', null)).toBe('permanent');
    expect(fmtBanLength('2026-09-21T00:00:00.000Z', '2026-09-22T00:00:00.000Z')).toBe('1 day');
    expect(fmtBanLength('2026-09-21T00:00:00.000Z', '2026-09-21T01:00:00.000Z')).toBe('1 h');
    expect(fmtBanLength('2026-09-21T00:00:00.000Z', '2026-09-21T00:05:00.000Z')).toBe('5 min');
  });

  it('withholds a ban issued from a ticket the viewer cannot see, and says a ban exists all the same', () => {
    const t = openStaffTicket(db, OWNER, { targetId: P, restricted: true }, { adminSteamIds: [OWNER] }) as { ticketId: number };
    setRestricted(db, t.ticketId, OWNER, true, [OWNER]);
    banFromTicket(db, t.ticketId, OWNER, 'cheating, see the case', 1440);

    const asMod = playerTimeline(db, P, MOD).filter((i) => i.source === 'ban');
    expect(asMod).toHaveLength(1);
    expect(asMod[0].summary).toContain(WITHHELD_REASON);
    expect(asMod[0].summary).not.toContain('see the case');
    expect(playerTimeline(db, P, OWNER).find((i) => i.source === 'ban')!.summary).toContain('see the case');

    const redact = banRedactor(db, P, MOD);
    const raw = { id: 1, reason: 'cheating, see the case', createdBy: OWNER, createdAt: 'x', expiresAt: null, liftedBy: null, liftedAt: null };
    expect(redact(raw).reason).toBe(WITHHELD_REASON);
    expect(redact(raw).createdBy).toBe('');
  });

  it('never shows a moderator a ticket about themselves, or a restricted one they are off', () => {
    openStaffTicket(db, OWNER, { targetId: MOD, restricted: true }, { adminSteamIds: [OWNER] });
    expect(playerTimeline(db, MOD, MOD).filter((i) => i.source === 'ticket')).toHaveLength(0);
    expect(playerTimeline(db, MOD, OWNER).filter((i) => i.source === 'ticket')).toHaveLength(1);
    expect(sources(MOD)).not.toContain('ticket');
  });
});
