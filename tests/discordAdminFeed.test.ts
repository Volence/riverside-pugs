import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openDb, type DB } from '../src/db.js';
import { upsertPlayer, activatePlayer, linkDiscord } from '../src/players.js';
import { setSetting } from '../src/settings.js';
import { fileReport } from '../src/reports.js';
import { recordPenalty } from '../src/penalties.js';
import { logAdmin } from '../src/admin/audit.js';
import { publishAdminEvent } from '../src/adminFeed.js';
import { AdminFeedPoster } from '../src/discord/adminFeedPoster.js';
import { getMessage } from '../src/discord/messageStore.js';
import { FakeTransport } from './fakes/fakeTransport.js';

const IDS = Array.from({ length: 8 }, (_, i) => `7656119900000000${i}`);
const ADMIN = IDS[7];
let db: DB;
let t: FakeTransport;
let feed: AdminFeedPoster;
let matchId: number;

beforeEach(() => {
  db = openDb(':memory:');
  IDS.forEach((id, i) => {
    upsertPlayer(db, { steamid: id, name: `player${i}`, avatar: null }, []);
    activatePlayer(db, id);
    linkDiscord(db, id, `90${i}`, `d${i}`);
  });
  db.prepare('UPDATE players SET is_admin = 1 WHERE steamid = ?').run(ADMIN);
  setSetting(db, 'discord_admin_channel_id', 'admins');
  matchId = Number(db.prepare("INSERT INTO matches (season_id, state, campaign, ended_at) VALUES (1, 'completed', 'dead_air', datetime('now'))").run().lastInsertRowid);
  const ins = db.prepare('INSERT INTO match_players (match_id, player_id, team) VALUES (?, ?, ?)');
  IDS.forEach((id, i) => ins.run(matchId, id, i < 4 ? 'a' : 'b'));
  t = new FakeTransport();
  feed = new AdminFeedPoster({ db, transport: t, publicUrl: 'https://pug.test' });
  feed.start();
});
afterEach(() => feed.stop());

const text = (i: number) => JSON.stringify(t.live()[i]?.payload);

describe('admin feed', () => {
  it('posts a new report with resolve and dismiss buttons to the admin channel', async () => {
    const r = fileReport(db, matchId, IDS[0], { targetId: IDS[5], category: 'griefing', text: 'kept killing us' });
    await feed.idle();
    expect(t.live()).toHaveLength(1);
    expect(t.live()[0].channelId).toBe('admins');
    expect(text(0)).toContain('player5');
    expect(text(0)).toContain('griefing');
    expect(text(0)).toContain('kept killing us');
    const ids = t.live()[0].payload.components.flat().map((b) => (b.kind === 'button' ? b.customId : ''));
    expect(ids).toEqual(expect.arrayContaining([`r:${(r as { id: number }).id}:resolve`, `r:${(r as { id: number }).id}:dismiss`]));
  });

  it('a resolve button needs an admin, resolves, and updates the post without a second message', async () => {
    const r = fileReport(db, matchId, IDS[0], { targetId: IDS[5], category: 'afk', text: '' }) as { id: number };
    await feed.idle();
    const denied = await feed.handleButton({ kind: 'button', customId: `r:${r.id}:resolve`, userId: '901', userName: 'd1' });
    expect(JSON.stringify(denied.payload)).toMatch(/admins only/i);
    const ok = await feed.handleButton({ kind: 'button', customId: `r:${r.id}:resolve`, userId: '907', userName: 'd7' });
    expect(ok.ephemeral).toBe(true);
    await feed.idle();
    expect(t.live()).toHaveLength(1);
    expect(text(0)).toMatch(/Resolved\*\* by player7/);
    expect(t.live()[0].payload.components).toEqual([]);
    expect((db.prepare('SELECT status FROM reports WHERE id = ?').get(r.id) as { status: string }).status).toBe('resolved');
  });

  it('a report resolved on the website also updates the post', async () => {
    const r = fileReport(db, matchId, IDS[0], { targetId: IDS[5], category: 'afk', text: '' }) as { id: number };
    await feed.idle();
    db.prepare("UPDATE reports SET status = 'dismissed', resolved_by = ? WHERE id = ?").run(ADMIN, r.id);
    logAdmin(db, ADMIN, 'resolve_report', r.id, { status: 'dismissed', note: 'not afk' });
    await feed.idle();
    expect(t.live()).toHaveLength(1);
    expect(text(0)).toMatch(/dismissed/i);
    expect(getMessage(db, 'report', String(r.id))).toBeTruthy();
  });

  it('admin actions, penalties, accounts and problems post one line each, with names', async () => {
    logAdmin(db, ADMIN, 'ban', IDS[3], { reason: 'throwing', minutes: 1440 });
    recordPenalty(db, IDS[2], 'ready_fail', null);
    publishAdminEvent({ kind: 'account', steamid: IDS[1], what: 'linked', discordName: 'd1' });
    publishAdminEvent({ kind: 'problem', text: 'Match #9 aborted for no-shows.', matchId: 9 });
    await feed.idle();
    expect(t.live()).toHaveLength(4);
    expect(text(0)).toMatch(/player7.*banned.*player3.*throwing/);
    expect(text(1)).toMatch(/player2.*missed a ready check/);
    expect(text(1)).toMatch(/5 min/);
    expect(text(2)).toMatch(/player1.*linked Discord/);
    expect(text(3)).toContain('Match #9 aborted for no-shows.');
  });

  it('each kind can be switched off, and no channel means no feed', async () => {
    setSetting(db, 'admin_feed_penalties', '0');
    recordPenalty(db, IDS[2], 'ready_fail', null);
    await feed.idle();
    expect(t.live()).toHaveLength(0);
    setSetting(db, 'discord_admin_channel_id', '');
    publishAdminEvent({ kind: 'problem', text: 'x' });
    await feed.idle();
    expect(t.live()).toHaveLength(0);
  });

  it('a secret setting change never shows its value', async () => {
    logAdmin(db, ADMIN, 'setting', 'invite_code', { changed: true });
    await feed.idle();
    expect(text(0)).toMatch(/changed the invite_code setting/i);
  });
});
