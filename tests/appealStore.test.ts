import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openDb, type DB } from '../src/db.js';
import { setSetting } from '../src/settings.js';
import { linkDiscord, upsertPlayer } from '../src/players.js';
import { insertBan } from '../src/admin/players.js';
import { appellantFromSteam } from '../src/appeals/rules.js';
import {
  answerQuestion, askQuestion, fileAppeal, getAppeal, recordDecision, sweepAppeals,
} from '../src/appeals/store.js';
import { subscribeAppealSignals } from '../src/appeals/signals.js';
import { subscribeAdminEvents, type AdminEvent } from '../src/adminFeed.js';
import { fileViewer } from '../src/admin/fileAccess.js';
import { canSeeAppeal, decideCheck } from '../src/appeals/access.js';

const P = '76561198000000001';
const MOD = '76561198000000008';
const ADMIN = '76561198000000009';
const NOW = new Date('2026-10-04T12:00:00.000Z');
let db: DB;
let signals: number[];
let events: AdminEvent[];
let offs: (() => void)[];

beforeEach(() => {
  db = openDb(':memory:');
  setSetting(db, 'appeals_enabled', '1');
  for (const [id, name] of [[P, 'p'], [MOD, 'mod'], [ADMIN, 'admin']]) upsertPlayer(db, { steamid: id, name, avatar: null }, []);
  db.prepare('UPDATE players SET is_mod = 1 WHERE steamid = ?').run(MOD);
  db.prepare('UPDATE players SET is_admin = 1 WHERE steamid = ?').run(ADMIN);
  signals = []; events = [];
  offs = [subscribeAppealSignals((id) => signals.push(id)), subscribeAdminEvents((e) => { if (e.kind === 'appeal') events.push(e); })];
});
afterEach(() => { for (const off of offs) off(); });

const file = (banId: number, what = 'I lagged out', why = 'It was my router') =>
  fileAppeal(db, appellantFromSteam(db, P), { ref: { kind: 'ban', id: banId }, whatHappened: what, whyLift: why, source: 'site' }, NOW);

describe('fileAppeal', () => {
  it('files an open appeal, signals it and announces it to the feed', () => {
    const ban = insertBan(db, P, 'system', 'abandon', 48 * 60, NOW);
    const r = file(ban);
    expect(r).toMatchObject({ ok: true, state: 'open' });
    const row = getAppeal(db, (r as { id: number }).id)!;
    expect(row).toMatchObject({ ban_id: ban, steamid: P, appellant_name: 'p', state: 'open', source: 'site' });
    expect(signals).toEqual([row.id]);
    expect(events).toEqual([{ kind: 'appeal', appealId: row.id, what: 'filed', name: 'p', slurs: [] }]);
  });

  it('refuses empty or overlong text, and a second open appeal', () => {
    const ban = insertBan(db, P, 'system', 'abandon', 48 * 60, NOW);
    expect(file(ban, '   ')).toMatchObject({ ok: false, status: 400 });
    expect(file(ban, 'x'.repeat(1501))).toMatchObject({ ok: false, status: 400 });
    expect(file(ban).ok).toBe(true);
    expect(file(ban)).toEqual({ ok: false, status: 409, error: 'You already have an appeal open for this. Staff will get to it.' });
  });

  it('a slur denies it at once, counts it, and says so in the feed', () => {
    const ban = insertBan(db, P, 'admin', 'toxic', null, NOW);
    const r = file(ban, 'you are all retards');
    expect(r).toMatchObject({ ok: true, state: 'auto_denied' });
    const row = getAppeal(db, (r as { id: number }).id)!;
    expect(row.decided_by).toBe('system');
    expect(JSON.parse(row.slurs!)).toEqual(['r-word']);
    expect(events[0]).toMatchObject({ what: 'auto_denied', slurs: ['r-word'] });
  });

  it('an appeal by staff is quiet: nothing to the feed', () => {
    db.prepare('UPDATE players SET is_mod = 1 WHERE steamid = ?').run(P);
    const ban = insertBan(db, P, 'admin', 'toxic', null, NOW);
    expect(file(ban).ok).toBe(true);
    expect(events).toEqual([]);
  });
});

describe('question and answer', () => {
  it('one question, only from open; one answer, only from asked and in time', () => {
    const ban = insertBan(db, P, 'admin', 'toxic', null, NOW);
    const id = (file(ban) as { id: number }).id;
    expect(askQuestion(db, id, MOD, 'Which match?', NOW)).toEqual({ ok: true });
    expect(askQuestion(db, id, MOD, 'And another?', NOW)).toMatchObject({ ok: false, status: 409 });
    const me = appellantFromSteam(db, P);
    const late = new Date(NOW.getTime() + 73 * 3600_000);
    expect(answerQuestion(db, me, id, 'Match 400', late)).toMatchObject({ ok: false, status: 409 });
    expect(answerQuestion(db, me, id, 'Match 400', NOW)).toEqual({ ok: true, state: 'answered' });
    expect(answerQuestion(db, me, id, 'again', NOW)).toMatchObject({ ok: false, status: 409 });
    expect(getAppeal(db, id)).toMatchObject({ state: 'answered', question: 'Which match?', answer: 'Match 400', asked_by: MOD });
  });

  it('someone else cannot answer (404, not 403)', () => {
    const ban = insertBan(db, P, 'admin', 'toxic', null, NOW);
    const id = (file(ban) as { id: number }).id;
    askQuestion(db, id, MOD, 'Which match?', NOW);
    expect(answerQuestion(db, appellantFromSteam(db, MOD), id, 'me', NOW)).toMatchObject({ ok: false, status: 404 });
  });
});

describe('decisions and the sweep', () => {
  it('only the first decision lands', () => {
    const ban = insertBan(db, P, 'admin', 'toxic', null, NOW);
    const id = (file(ban) as { id: number }).id;
    expect(recordDecision(db, id, ADMIN, 'denied', null, NOW)).toBe(true);
    expect(recordDecision(db, id, MOD, 'accepted', null, NOW)).toBe(false);
    expect(getAppeal(db, id)).toMatchObject({ state: 'denied', decided_by: ADMIN });
  });

  it('lapses an unanswered question and moots an appeal whose ban ended', () => {
    const a = insertBan(db, P, 'admin', 'toxic', null, NOW);
    const asked = (file(a) as { id: number }).id;
    askQuestion(db, asked, MOD, 'Which match?', NOW);
    const b = insertBan(db, P, 'system', 'abandon', 48 * 60, NOW);
    const waiting = (file(b) as { id: number }).id;
    const later = new Date(NOW.getTime() + 73 * 3600_000);
    expect(sweepAppeals(db, later)).toEqual({ lapsed: [asked], moot: [waiting] });
    expect(getAppeal(db, asked)!.state).toBe('lapsed');
    expect(getAppeal(db, waiting)!.state).toBe('moot');
  });

  // Ruling: a player cannot see their own appeal with the feature off, so
  // they cannot know a question was asked, let alone answer it in time.
  // Turning appeals off must not be a way to cost them a strike they never
  // saw; moot keeps running, since a ban ending has nothing to do with
  // whether the feature is on.
  it('skips the lapse while appeals are off, but moot still runs', () => {
    const a = insertBan(db, P, 'admin', 'toxic', null, NOW);
    const asked = (file(a) as { id: number }).id;
    askQuestion(db, asked, MOD, 'Which match?', NOW);
    const b = insertBan(db, P, 'system', 'abandon', 48 * 60, NOW);
    const waiting = (file(b) as { id: number }).id;
    setSetting(db, 'appeals_enabled', '0');
    const later = new Date(NOW.getTime() + 73 * 3600_000);
    expect(sweepAppeals(db, later)).toEqual({ lapsed: [], moot: [waiting] });
    expect(getAppeal(db, asked)!.state).toBe('asked');
    expect(getAppeal(db, waiting)!.state).toBe('moot');
  });
});

describe('access', () => {
  it('a moderator cannot see or decide an appeal about staff; the rank rule follows the issuer', () => {
    const ban = insertBan(db, P, ADMIN, 'toxic', null, NOW);
    const id = (file(ban) as { id: number }).id;
    const row = getAppeal(db, id)!;
    expect(canSeeAppeal(db, fileViewer(db, MOD), row)).toBe(true);
    expect(decideCheck(db, fileViewer(db, MOD), row)).toMatchObject({ ok: false, status: 403 });
    expect(decideCheck(db, fileViewer(db, ADMIN), row)).toEqual({ ok: true });
    db.prepare('UPDATE players SET is_mod = 1 WHERE steamid = ?').run(P);
    expect(canSeeAppeal(db, fileViewer(db, MOD), row)).toBe(false);
  });

  // Owner ruling: the appellant through a linked identity, not just the
  // same steamid, is still the appellant. An admin whose own Discord
  // happens to be the one a sanction appeal is about must not decide it.
  it('an admin whose Discord id matches the appeal cannot decide it, even though they can see it', () => {
    linkDiscord(db, ADMIN, '700', 'admin-discord');
    const sid = Number(db.prepare(`INSERT INTO discord_sanctions (discord_id, kind, until, reason, created_by, created_at)
      VALUES ('700', 'timeout', ?, 'spam', ?, ?)`).run(new Date(NOW.getTime() + 7 * 86400_000).toISOString(), MOD, NOW.toISOString()).lastInsertRowid);
    const r = fileAppeal(db, { steamids: [], discordId: '700', name: 'stranger' }, { ref: { kind: 'sanction', id: sid }, whatHappened: 'a', whyLift: 'b', source: 'appeal_page' }, NOW);
    const row = getAppeal(db, (r as { id: number }).id)!;
    expect(canSeeAppeal(db, fileViewer(db, ADMIN), row)).toBe(true);
    expect(decideCheck(db, fileViewer(db, ADMIN), row)).toEqual({ ok: false, status: 404, error: 'no such appeal' });
    // A different admin, unaffected, may still decide it.
    const other = '76561198000000099';
    upsertPlayer(db, { steamid: other, name: 'other', avatar: null }, []);
    db.prepare('UPDATE players SET is_admin = 1 WHERE steamid = ?').run(other);
    expect(decideCheck(db, fileViewer(db, other), row)).toEqual({ ok: true });
  });
});
