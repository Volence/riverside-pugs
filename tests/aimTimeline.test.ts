import { describe, it, expect, beforeEach } from 'vitest';
import { openDb, type DB } from '../src/db.js';
import { upsertPlayer } from '../src/players.js';
import { setSetting } from '../src/settings.js';
import { playerTimeline } from '../src/admin/playerTimeline.js';
import { needsALook } from '../src/admin/needsALook.js';
import { fileViewer } from '../src/admin/fileAccess.js';
import { arrivedSince } from '../src/admin/arrived.js';
import { isEvidence } from '../src/admin/timeline/types.js';

const P = '76561198129925325';
const STAFF = '76561198000000009';
let db: DB;
beforeEach(() => {
  db = openDb(':memory:');
  upsertPlayer(db, { steamid: P, name: 'nepmir', avatar: null }, []);
  upsertPlayer(db, { steamid: STAFF, name: 'boss', avatar: null }, []);
  db.prepare('UPDATE players SET is_admin = 1 WHERE steamid = ?').run(STAFF);
  db.prepare(
    `INSERT INTO integrity_flags (match_id, server_id, steamid, source, kind, severity, detail, at)
     VALUES (722, 1, ?, 'aim', 'aimbot_multi', 'high', 'hs_share + flick_return. hs_share: auto weapons: 14 of 16', '2026-10-17T21:50:00.000Z')`,
  ).run(P);
});

describe('aim flags on the file', () => {
  it('read as the rule, with the numbers', () => {
    const [item] = playerTimeline(db, P, STAFF).filter((i) => i.source === 'aim');
    expect(item).toMatchObject({ source: 'aim', kind: 'aimbot_multi', matchId: 722, ref: { type: 'integrity_flag' } });
    expect(item.summary).toMatch(/^Two or more aim rules fired in one match \(hs_share \+ flick_return\./);
  });

  it('are on file but not evidence while the rules are in log mode', () => {
    const [item] = playerTimeline(db, P, STAFF).filter((i) => i.source === 'aim');
    expect(item.allowed).toBe(true);
    expect(isEvidence(item)).toBe(false);
    expect(needsALook(db, fileViewer(db, STAFF)).some((r) => r.steamid === P)).toBe(false);
  });

  it('count once the rules are on', () => {
    setSetting(db, 'aim_rules', 'on');
    const items = playerTimeline(db, P, STAFF);
    const [item] = items.filter((i) => i.source === 'aim');
    expect(isEvidence(item)).toBe(true);
    expect(needsALook(db, fileViewer(db, STAFF)).some((r) => r.steamid === P)).toBe(true);
    expect(arrivedSince(items, null)).toContain('aim rules: aimbot_multi');
  });
});
