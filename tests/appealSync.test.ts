import { describe, it, expect, beforeEach } from 'vitest';
import { openDb, type DB } from '../src/db.js';
import { setSetting } from '../src/settings.js';
import { upsertPlayer, linkDiscord } from '../src/players.js';
import { insertBan } from '../src/admin/players.js';
import { appellantFromSteam } from '../src/appeals/rules.js';
import { askQuestion, fileAppeal, getAppeal, recordDecision } from '../src/appeals/store.js';
import { AppealSync } from '../src/discord/appealSync.js';
import { FakeTransport } from './fakes/fakeTransport.js';

const P = '76561198000000001';
const MOD = '76561198000000008';
const FORUM = '5000';
let db: DB;
let t: FakeTransport;
let sync: AppealSync;

beforeEach(() => {
  db = openDb(':memory:');
  t = new FakeTransport();
  setSetting(db, 'appeals_enabled', '1');
  setSetting(db, 'discord_tickets_forum_id', FORUM);
  upsertPlayer(db, { steamid: P, name: 'telltale', avatar: null }, []);
  upsertPlayer(db, { steamid: MOD, name: 'mod', avatar: null }, []);
  db.prepare('UPDATE players SET is_mod = 1 WHERE steamid = ?').run(MOD);
  linkDiscord(db, P, '700', 'telltale');
  sync = new AppealSync({ db, transport: t, publicUrl: 'https://pug.test', intervalMs: 0 });
});

const file = () => {
  const ban = insertBan(db, P, MOD, 'griefing', null);
  return (fileAppeal(db, appellantFromSteam(db, P), { ref: { kind: 'ban', id: ban }, whatHappened: 'lag', whyLift: 'router', source: 'site' }) as { id: number }).id;
};

describe('AppealSync', () => {
  it('posts one forum post per appeal, tagged Appeal, and remembers it', async () => {
    const id = file();
    await sync.reconcile();
    await sync.reconcile();
    const posts = t.threadsIn(FORUM);
    expect(posts).toHaveLength(1);
    expect(posts[0].tags).toEqual(['Appeal']);
    expect(getAppeal(db, id)!.forum_thread_id).toBe(posts[0].id);
  });

  it('DMs the question once, and the outcome once; never the filing itself', async () => {
    const id = file();
    await sync.reconcile();
    expect(t.dms).toEqual([]);
    askQuestion(db, id, MOD, 'Which map?');
    await sync.reconcile();
    await sync.reconcile();
    expect(t.dms).toHaveLength(1);
    expect(t.dms[0].userId).toBe('700');
    expect(t.dms[0].payload.content).toContain('Which map?');
    recordDecision(db, id, MOD, 'denied', null);
    await sync.reconcile();
    expect(t.dms).toHaveLength(2);
    expect(t.dms[1].payload.content).toContain('the ban stands');
  });

  it('closes the post when the appeal is settled', async () => {
    const id = file();
    await sync.reconcile();
    recordDecision(db, id, MOD, 'denied', null);
    await sync.reconcile();
    const post = t.threadsIn(FORUM)[0];
    expect(post.locked).toBe(true);
    expect(post.archived).toBe(true);
  });

  it('a quiet appeal (by staff) gets no forum post', async () => {
    db.prepare('UPDATE players SET is_mod = 1 WHERE steamid = ?').run(P);
    file();
    await sync.reconcile();
    expect(t.threadsIn(FORUM)).toHaveLength(0);
  });

  it('a refused DM is not retried', async () => {
    t.dmsClosed.add('700');
    const id = file();
    askQuestion(db, id, MOD, 'Which map?');
    await sync.reconcile();
    t.dmsClosed.delete('700');
    await sync.reconcile();
    expect(t.dms).toEqual([]);
  });
});
