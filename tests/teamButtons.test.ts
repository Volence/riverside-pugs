import { describe, it, expect, beforeEach } from 'vitest';
import { openDb, type DB } from '../src/db.js';
import { createTeam, invitePlayer, roleOf } from '../src/teams/teams.js';
import { handleTeamButton, teamInviteDm, TEAM_BUTTON_PREFIX } from '../src/discord/teamButtons.js';

const CAP = '76561199000000301';
const INV = '76561199000000302';
let db: DB;
let teamId: number;
let inviteId: number;

beforeEach(() => {
  db = openDb(':memory:');
  db.prepare("INSERT INTO players (steamid, name, status, discord_id) VALUES (?, 'cap', 'active', 'd-cap'), (?, 'inv', 'active', 'd-inv')").run(CAP, INV);
  db.prepare("UPDATE settings SET value = 'everyone' WHERE key = 'competitive_enabled'").run();
  const t = createTeam(db, { creator: CAP, name: 'Rats', tag: 'RR' });
  if (!t.ok) throw new Error(t.error);
  teamId = t.value.id;
  const i = invitePlayer(db, { teamId, by: CAP, target: INV });
  if (!i.ok) throw new Error(i.error);
  inviteId = i.value.inviteId;
});

const press = (userId: string, choice: 'a' | 'd') =>
  handleTeamButton({ db, publicUrl: 'https://example.test' }, { kind: 'button', customId: `${TEAM_BUTTON_PREFIX}${inviteId}:${choice}`, userId } as never);

describe('team invite DM', () => {
  it('carries Accept and Decline buttons for this invite and a link to the team', () => {
    const p = teamInviteDm({ inviteId, teamName: 'Rats', tag: 'RR', invitedByName: 'cap', url: 'https://example.test/team/rats' });
    const ids = p.components.flat().map((b) => ('customId' in b ? b.customId : b.url));
    expect(ids).toEqual([`tm:${inviteId}:a`, `tm:${inviteId}:d`, 'https://example.test/team/rats']);
  });
});

describe('handleTeamButton', () => {
  it('accepts for the linked invitee', async () => {
    const r = await press('d-inv', 'a');
    expect(r.payload.content).toMatch(/joined Rats/);
    expect(roleOf(db, teamId, INV)).toBe('member');
  });

  it('refuses a Discord user who is not the invitee, and leaves the invite open', async () => {
    const r = await press('d-cap', 'a');
    expect(r.payload.content).toMatch(/not for you|no longer open/i);
    expect(roleOf(db, teamId, INV)).toBeNull();
    expect((await press('d-inv', 'a')).payload.content).toMatch(/joined/);
  });

  it('refuses an unlinked Discord user and a closed switch', async () => {
    expect((await press('d-nobody', 'a')).payload.content).toMatch(/link/i);
    db.prepare("UPDATE settings SET value = 'off' WHERE key = 'competitive_enabled'").run();
    expect((await press('d-inv', 'a')).payload.content).toMatch(/not open/i);
  });

  it('declines', async () => {
    expect((await press('d-inv', 'd')).payload.content).toMatch(/declined/i);
    expect((await press('d-inv', 'a')).payload.content).toMatch(/no longer open/i);
  });
});
