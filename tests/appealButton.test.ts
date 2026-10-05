import { describe, it, expect, beforeEach } from 'vitest';
import { openDb, type DB } from '../src/db.js';
import { setSetting } from '../src/settings.js';
import { upsertPlayer, linkDiscord } from '../src/players.js';
import { insertBan } from '../src/admin/players.js';
import { AppealButton, handleAppealButton, handleAppealModal, opensAppealModal } from '../src/discord/appealButton.js';
import { FakeTransport } from './fakes/fakeTransport.js';

const P = '76561198000000001';
const CH = '6000';
let db: DB;
let t: FakeTransport;
const deps = () => ({ db, publicUrl: 'https://pug.test' });
const press = (userId: string) => ({ kind: 'button' as const, customId: 'ap:open', userId, userName: 'telltale', presserTimedOutUntil: null });
const submit = (customId: string, fields: Record<string, string>, userId = '700') =>
  ({ kind: 'modal' as const, customId, userId, userName: 'telltale', fields, picked: {}, presserTimedOutUntil: null });

beforeEach(() => {
  db = openDb(':memory:');
  t = new FakeTransport();
  setSetting(db, 'discord_report_channel_id', CH);
  upsertPlayer(db, { steamid: P, name: 'telltale', avatar: null }, []);
  linkDiscord(db, P, '700', 'telltale');
});

describe('the standing message', () => {
  it('posts only while appeals are on, and takes itself down when they go off', async () => {
    const b = new AppealButton({ db, transport: t, publicUrl: 'https://pug.test', intervalMs: 0 });
    await b.tick();
    expect(t.messages.filter((m) => !m.deleted)).toHaveLength(0);
    setSetting(db, 'appeals_enabled', '1');
    await b.tick();
    const live = t.messages.filter((m) => !m.deleted);
    expect(live).toHaveLength(1);
    expect(JSON.stringify(live[0].payload)).toContain('ap:open');
    setSetting(db, 'appeals_enabled', '0');
    await b.tick();
    expect(t.messages.filter((m) => !m.deleted)).toHaveLength(0);
  });
});

describe('pressing Appeal', () => {
  beforeEach(() => setSetting(db, 'appeals_enabled', '1'));

  it('opens a form for a banned member, with the ban in its id', async () => {
    const ban = insertBan(db, P, 'system', 'abandon', null);
    expect(opensAppealModal('ap:open')).toBe(true);
    const r = await handleAppealButton(deps(), press('700'));
    expect(r.modal?.customId).toBe(`ap:new:ban:${ban}`);
    expect(r.modal?.fields.map((f) => f.id)).toEqual(['what', 'why']);
  });

  it('says "nothing to appeal" without a form for someone who is not banned', async () => {
    const r = await handleAppealButton(deps(), press('999'));
    expect(r.modal).toBeUndefined();
    expect(r.payload.content).toBe('You have nothing to appeal.');
  });

  it('a submitted form files the appeal; a forged id is refused', async () => {
    const ban = insertBan(db, P, 'system', 'abandon', null);
    const ok = await handleAppealModal(deps(), submit(`ap:new:ban:${ban}`, { what: 'lag', why: 'router' }));
    expect(ok.payload.content).toMatch(/Your appeal was sent/);
    expect(db.prepare('SELECT source FROM appeals').get()).toEqual({ source: 'discord_button' });
    const forged = await handleAppealModal(deps(), submit(`ap:new:ban:${ban + 50}`, { what: 'a', why: 'b' }));
    expect(forged.payload.content).toBe('You have nothing to appeal.');
  });

  it('several bans: one select, and the pick decides which', async () => {
    const a = insertBan(db, P, 'system', 'abandon', null);
    const b = insertBan(db, P, 'system', 'griefing', null);
    const r = await handleAppealButton(deps(), press('700'));
    expect(r.modal?.customId).toBe('ap:new');
    expect(r.modal?.fields[0]).toMatchObject({ kind: 'select', id: 'which' });
    await handleAppealModal(deps(), submit('ap:new', { which: `ban:${a}`, what: 'x', why: 'y' }));
    expect(db.prepare('SELECT ban_id FROM appeals').get()).toEqual({ ban_id: a });
    expect(b).toBeGreaterThan(a);
  });
});
