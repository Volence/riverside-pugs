import { describe, it, expect, beforeEach } from 'vitest';
import { openDb, type DB } from '../src/db.js';
import { upsertPlayer, activatePlayer, linkDiscord } from '../src/players.js';
import { fileReport } from '../src/tickets/filing.js';

const P1 = '76561199000000601';
const NEWBIE = '76561199000000602';
const OWNER = '76561199000000603';
const deps = { adminSteamIds: [OWNER] };
const lurker = { discordId: '950', name: 'Lurky', bot: false, administrator: false };
let db: DB;

beforeEach(() => {
  db = openDb(':memory:');
  for (const id of [P1, NEWBIE, OWNER]) {
    upsertPlayer(db, { steamid: id, name: id.slice(-3), avatar: null }, []);
    activatePlayer(db, id);
  }
  db.prepare('UPDATE players SET is_admin = 1 WHERE steamid = ?').run(OWNER);
});

describe('adoptDiscordPerson through linkDiscord', () => {
  it('moves tickets about them and reports by them onto the player', () => {
    fileReport(db, P1, { category: 'toxicity', text: '' }, { ...deps, targetDiscord: lurker });
    fileReport(db, { kind: 'discord', discordId: '950', name: 'Lurky', timedOutUntil: null }, { targetId: OWNER, category: 'afk', text: '' }, deps);
    expect(linkDiscord(db, NEWBIE, '950', 'Lurky', { adminSteamIds: [OWNER] })).toMatchObject({ ok: true });
    expect(db.prepare('SELECT COUNT(*) AS n FROM tickets WHERE target_discord_id IS NOT NULL').get()).toEqual({ n: 0 });
    expect(db.prepare('SELECT target_id FROM tickets WHERE target_id = ?').get(NEWBIE)).toEqual({ target_id: NEWBIE });
    expect(db.prepare('SELECT reporter_id FROM ticket_reports WHERE reporter_discord_id IS NULL AND reporter_id = ?').get(NEWBIE)).toEqual({ reporter_id: NEWBIE });
  });

  it('folds two open cases into one when the player already had one', () => {
    fileReport(db, P1, { category: 'toxicity', text: '' }, { ...deps, targetDiscord: lurker });
    fileReport(db, OWNER, { targetId: NEWBIE, category: 'afk', text: '' }, deps);
    linkDiscord(db, NEWBIE, '950', 'Lurky', { adminSteamIds: [OWNER] });
    const open = db.prepare("SELECT id FROM tickets WHERE status = 'open'").all();
    expect(open).toHaveLength(1);
    expect(db.prepare('SELECT COUNT(*) AS n FROM ticket_reports').get()).toEqual({ n: 2 });
    expect(db.pragma('foreign_key_check')).toEqual([]);
  });

  it('restricts the adopted case when the player is staff', () => {
    db.prepare('UPDATE players SET is_mod = 1 WHERE steamid = ?').run(NEWBIE);
    fileReport(db, P1, { category: 'toxicity', text: '' }, { ...deps, targetDiscord: lurker });
    linkDiscord(db, NEWBIE, '950', 'Lurky', { adminSteamIds: [OWNER] });
    expect(db.prepare('SELECT restricted FROM tickets').get()).toEqual({ restricted: 1 });
  });
});
