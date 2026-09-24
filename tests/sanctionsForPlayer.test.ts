import { describe, it, expect, beforeEach } from 'vitest';
import { openDb, type DB } from '../src/db.js';
import { upsertPlayer, activatePlayer, linkDiscord, unlinkDiscord } from '../src/players.js';
import { fileReport } from '../src/tickets/filing.js';
import { sanctionsForPlayer } from '../src/tickets/discordSanctions.js';
import { caseFile } from '../src/tickets/caseFile.js';
import { playerFile } from '../src/admin/playerFile.js';
import { fileViewer } from '../src/admin/fileAccess.js';

const [NEWBIE, MOD, ADMIN, OWNER, R1] = ['76561199000000901', '76561199000000902', '76561199000000903', '76561199000000904', '76561199000000905'];
let db: DB;

beforeEach(() => {
  db = openDb(':memory:');
  for (const id of [NEWBIE, MOD, ADMIN, OWNER, R1]) {
    upsertPlayer(db, { steamid: id, name: id.slice(-3), avatar: null }, []);
    activatePlayer(db, id);
  }
  db.prepare('UPDATE players SET is_mod = 1 WHERE steamid = ?').run(MOD);
  db.prepare('UPDATE players SET is_admin = 1 WHERE steamid IN (?, ?)').run(ADMIN, OWNER);
});

const sanction = (discordId: string, ticketId: number | null, reason: string, at: string) =>
  db.prepare(
    "INSERT INTO discord_sanctions (discord_id, kind, until, reason, ticket_id, created_by, created_at) VALUES (?, 'timeout', '2099-01-01T00:00:00Z', ?, ?, ?, ?)",
  ).run(discordId, reason, ticketId, MOD, at);

describe('sanctionsForPlayer', () => {
  it('lists the sanctions on every Discord id the player has linked, newest first, and none of anyone else\'s', () => {
    sanction('950', null, 'spam before linking', '2026-09-20T00:00:00Z');
    sanction('951', null, 'on the old account', '2026-09-21T00:00:00Z');
    sanction('999', null, 'somebody else', '2026-09-22T00:00:00Z');
    linkDiscord(db, NEWBIE, '951', 'old');
    unlinkDiscord(db, NEWBIE);
    linkDiscord(db, NEWBIE, '950', 'now');
    expect(sanctionsForPlayer(db, NEWBIE).map((s) => s.reason)).toEqual(['on the old account', 'spam before linking']);
    expect(sanctionsForPlayer(db, R1)).toEqual([]);
  });

  it('shows on the case file and the Player File, redacted where the ticket is restricted and the viewer is off its list', () => {
    const lurker = { discordId: '950', name: 'Lurky', bot: false, administrator: false };
    const restricted = (fileReport(db, R1, { category: 'unsafe', text: 'threats' }, { adminSteamIds: [OWNER], targetDiscord: lurker }) as { ticketId: number }).ticketId;
    sanction('950', restricted, 'the private reason', '2026-09-22T00:00:00Z');
    linkDiscord(db, NEWBIE, '950', 'Lurky', { adminSteamIds: [OWNER] });
    const forOwner = caseFile(db, NEWBIE, OWNER)!.discordSanctions;
    expect(forOwner.map((s) => s.reason)).toEqual(['the private reason']);
    const forMod = caseFile(db, NEWBIE, MOD)!.discordSanctions;
    expect(forMod).toHaveLength(1);
    expect(forMod[0]).toMatchObject({ reason: 'Withheld (restricted ticket)', ticketId: null, createdBy: '', createdByName: null });
    const file = playerFile(db, NEWBIE, fileViewer(db, ADMIN))!;
    expect(file.sections.standing.discordSanctions[0]).toMatchObject({ reason: 'Withheld (restricted ticket)' });
  });
});
