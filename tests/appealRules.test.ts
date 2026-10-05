import { describe, it, expect, beforeEach } from 'vitest';
import { openDb, type DB } from '../src/db.js';
import { setSetting } from '../src/settings.js';
import { upsertPlayer, linkDiscord, unlinkDiscord } from '../src/players.js';
import { insertBan } from '../src/admin/players.js';
import {
  activeTargets, appellantFromDiscord, appellantFromSteam, canAppeal, nextAppealAt, parseRefKey, refKey, refusalText,
} from '../src/appeals/rules.js';

const P = '76561198000000001';
const Q = '76561198000000002';
const NOW = new Date('2026-10-04T12:00:00.000Z');
const H = 60; // minutes in an hour
let db: DB;

const appeal = (banId: number, state: string, decidedAt: string | null = null) =>
  db.prepare(`INSERT INTO appeals (ban_id, steamid, appellant_name, what_happened, why_lift, state, source, created_at, decided_at)
              VALUES (?, ?, 'p', 'a', 'b', ?, 'site', ?, ?)`).run(banId, P, state, NOW.toISOString(), decidedAt);
const sanction = (discordId: string, kind: 'timeout' | 'ban', until: string | null) =>
  Number(db.prepare(`INSERT INTO discord_sanctions (discord_id, kind, until, reason, ticket_id, created_by, created_at)
              VALUES (?, ?, ?, 'spam', NULL, ?, ?)`).run(discordId, kind, until, Q, NOW.toISOString()).lastInsertRowid);

beforeEach(() => {
  db = openDb(':memory:');
  setSetting(db, 'appeals_enabled', '1');
  upsertPlayer(db, { steamid: P, name: 'p', avatar: null }, []);
  upsertPlayer(db, { steamid: Q, name: 'q', avatar: null }, []);
});

describe('canAppeal', () => {
  it('is refused while appeals are off', () => {
    setSetting(db, 'appeals_enabled', '0');
    const ban = insertBan(db, P, 'system', 'abandon', 48 * H, NOW);
    const v = canAppeal(db, appellantFromSteam(db, P), { kind: 'ban', id: ban }, NOW);
    expect(v).toEqual({ ok: false, reason: 'disabled' });
  });

  it('allows a 48 hour ban and refuses a 2 hour one', () => {
    const long = insertBan(db, P, 'system', 'abandon', 48 * H, NOW);
    const short = insertBan(db, P, 'system', 'abandon', 2 * H, NOW);
    const me = appellantFromSteam(db, P);
    expect(canAppeal(db, me, { kind: 'ban', id: long }, NOW).ok).toBe(true);
    expect(canAppeal(db, me, { kind: 'ban', id: short }, NOW)).toEqual({ ok: false, reason: 'too_short' });
  });

  it('always allows a permanent ban and an alt hold, however short', () => {
    const perm = insertBan(db, P, 'admin', 'toxic', null, NOW);
    const hold = insertBan(db, Q, 'system', 'On hold', null, NOW, 'alt_hold');
    expect(canAppeal(db, appellantFromSteam(db, P), { kind: 'ban', id: perm }, NOW).ok).toBe(true);
    expect(canAppeal(db, appellantFromSteam(db, Q), { kind: 'ban', id: hold }, NOW).ok).toBe(true);
  });

  it('refuses someone else\'s ban as nothing to appeal (a forged ref)', () => {
    const theirs = insertBan(db, Q, 'admin', 'toxic', null, NOW);
    expect(canAppeal(db, appellantFromSteam(db, P), { kind: 'ban', id: theirs }, NOW))
      .toEqual({ ok: false, reason: 'nothing_to_appeal' });
  });

  it('refuses a second open appeal, then counts settled ones toward the limit', () => {
    const ban = insertBan(db, P, 'admin', 'toxic', null, NOW);
    const me = appellantFromSteam(db, P);
    appeal(ban, 'open');
    expect(canAppeal(db, me, { kind: 'ban', id: ban }, NOW)).toEqual({ ok: false, reason: 'already_open' });
    db.prepare("UPDATE appeals SET state = 'denied', decided_at = ?").run('2026-09-01T00:00:00.000Z');
    expect(canAppeal(db, me, { kind: 'ban', id: ban }, NOW).ok).toBe(true);
    appeal(ban, 'lapsed', '2026-09-02T00:00:00.000Z');
    expect(canAppeal(db, me, { kind: 'ban', id: ban }, NOW)).toEqual({ ok: false, reason: 'limit_reached' });
  });

  it('a moot appeal counts for nothing', () => {
    const ban = insertBan(db, P, 'admin', 'toxic', null, NOW);
    appeal(ban, 'moot', '2026-10-01T00:00:00.000Z');
    appeal(ban, 'moot', '2026-10-02T00:00:00.000Z');
    expect(canAppeal(db, appellantFromSteam(db, P), { kind: 'ban', id: ban }, NOW).ok).toBe(true);
  });

  it('waits out the cooldown after a denial and says when it opens', () => {
    const ban = insertBan(db, P, 'admin', 'toxic', null, NOW);
    appeal(ban, 'denied', '2026-10-01T12:00:00.000Z');
    const v = canAppeal(db, appellantFromSteam(db, P), { kind: 'ban', id: ban }, NOW);
    expect(v).toEqual({ ok: false, reason: 'cooldown', opensAt: '2026-10-08T12:00:00.000Z' });
    if (!v.ok) expect(refusalText(v)).toMatch(/You can appeal again after/);
    expect(nextAppealAt(db, { kind: 'ban', id: ban }, NOW)).toBe('2026-10-08T12:00:00.000Z');
  });

  it('refuses a ban an admin marked final', () => {
    const ban = insertBan(db, P, 'admin', 'toxic', null, NOW);
    db.prepare('UPDATE bans SET no_appeal = 1 WHERE id = ?').run(ban);
    expect(canAppeal(db, appellantFromSteam(db, P), { kind: 'ban', id: ban }, NOW))
      .toEqual({ ok: false, reason: 'marked_final' });
  });

  it('refuses a lifted or expired ban as nothing to appeal', () => {
    const ban = insertBan(db, P, 'system', 'abandon', 48 * H, new Date('2026-09-01T00:00:00.000Z'));
    expect(canAppeal(db, appellantFromSteam(db, P), { kind: 'ban', id: ban }, NOW))
      .toEqual({ ok: false, reason: 'nothing_to_appeal' });
  });
});

describe('appellants and targets', () => {
  it('a Discord identity speaks for every account it is or was linked to, and for its own sanctions', () => {
    linkDiscord(db, P, '900', 'dethisa');
    unlinkDiscord(db, P);
    linkDiscord(db, Q, '900', 'dethisa');
    insertBan(db, P, 'admin', 'old account', null, NOW);
    insertBan(db, Q, 'system', 'On hold', null, NOW, 'alt_hold');
    sanction('900', 'timeout', '2026-10-20T00:00:00.000Z');
    const who = appellantFromDiscord(db, '900', 'dethisa');
    expect(new Set(who.steamids)).toEqual(new Set([P, Q]));
    const kinds = activeTargets(db, who, NOW).map((t) => `${t.ref.kind}:${t.hold ? 'hold' : t.sanctionKind ?? 'ban'}`);
    expect(kinds.sort()).toEqual(['ban:ban', 'ban:hold', 'sanction:timeout']);
  });

  it('a Discord-only person with no player row still sees their sanction', () => {
    sanction('901', 'ban', null);
    const who = appellantFromDiscord(db, '901', 'stranger');
    expect(who.steamids).toEqual([]);
    const [t] = activeTargets(db, who, NOW);
    expect(t.sanctionKind).toBe('ban');
    expect(canAppeal(db, who, t.ref, NOW).ok).toBe(true);
  });

  it('refKey round-trips and rejects junk', () => {
    expect(parseRefKey(refKey({ kind: 'sanction', id: 7 }))).toEqual({ kind: 'sanction', id: 7 });
    expect(parseRefKey('ban:x')).toBeNull();
    expect(parseRefKey('other:1')).toBeNull();
  });
});
