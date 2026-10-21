import { describe, it, expect, beforeEach } from 'vitest';
import { openDb, type DB } from '../src/db.js';
import { Matchmaker } from '../src/matchmaker.js';
import { upsertPlayer, activatePlayer, linkDiscord } from '../src/players.js';
import { partnerOf } from '../src/duos.js';
import { handleDuoButton, DUO_BUTTON_PREFIX } from '../src/discord/duoButtons.js';

const [A, B, C] = ['76561198000000301', '76561198000000302', '76561198000000303'];
let db: DB;
let mm: Matchmaker;
let inviteId: number;

beforeEach(() => {
  db = openDb(':memory:');
  [A, B, C].forEach((id, i) => {
    upsertPlayer(db, { steamid: id, name: `p${i}`, avatar: null }, []);
    activatePlayer(db, id);
    linkDiscord(db, id, `80${i}`, `d${i}`);
  });
  db.prepare('UPDATE seasons SET ranks = 1').run();
  mm = new Matchmaker(db, { broadcast: () => {}, orchestrator: { setupMatch: async () => {}, finishMatch: async () => {} } });
  const r = mm.inviteDuo(A, B, 'discord');
  if (!r.ok) throw new Error(r.error);
  inviteId = r.inviteId;
});

const press = (userId: string, choice: 'a' | 'd') =>
  handleDuoButton({ db, matchmaker: mm }, { kind: 'button', customId: `${DUO_BUTTON_PREFIX}${inviteId}:${choice}`, userId, userName: 'u', presserTimedOutUntil: null });

describe('duo invite buttons', () => {
  it('the invitee accepts', async () => {
    const r = await press('801', 'a');
    expect(r.ephemeral).toBe(true);
    expect(partnerOf(db, A)).toBe(B);
  });

  it('anyone else is told it is not for them', async () => {
    expect(JSON.stringify((await press('802', 'a')).payload)).toMatch(/not for you/);
    expect(partnerOf(db, A)).toBeNull();
  });

  it('decline closes it', async () => {
    await press('801', 'd');
    expect(JSON.stringify((await press('801', 'a')).payload)).toMatch(/no longer open/);
  });
});
