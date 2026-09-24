import { describe, it, expect, beforeEach } from 'vitest';
import { openDb, type DB } from '../src/db.js';
import { upsertPlayer } from '../src/players.js';
import { addAlias } from '../src/aliases.js';
import { ADAPTERS, playerTimeline } from '../src/admin/playerTimeline.js';
import { isWheel } from '../src/inputStats.js';
import { isEvidence, toIso, type TimelineAdapter, type TimelineItem } from '../src/admin/timeline/types.js';

const MAIN = '76561199000000001';
const ALT = '76561199000000002';
const STAFF = '76561199000000009';
let db: DB;

beforeEach(() => {
  db = openDb(':memory:');
  for (const id of [MAIN, ALT, STAFF]) upsertPlayer(db, { steamid: id, name: `p${id.slice(-3)}`, avatar: null }, []);
});

const detection = (steamid: string, at: string, burstId: number, signature = 'pistol_rate', note = 'variable-hold') =>
  db.prepare(
    `INSERT INTO input_detections (burst_id, match_id, steamid, kind, signature, severity, at, hits, evidence, note)
     VALUES (?, 7, ?, 'attack', ?, 'low', ?, 3, '[]', ?)`,
  ).run(burstId, steamid, signature, at, note);

const lilac = (steamid: string, at: string, kind = 'aimbot', severity = 'suspected') =>
  db.prepare(
    `INSERT INTO integrity_flags (match_id, server_id, steamid, source, kind, severity, detail, at)
     VALUES (7, 1, ?, 'lilac', ?, ?, '', ?)`,
  ).run(steamid, kind, severity, at);

const item = (over: Partial<TimelineItem>): TimelineItem => ({
  at: '2026-09-21T10:00:00.000Z', source: 'input', kind: 'x', summary: 'x',
  matchId: null, replay: null, ref: null, ...over,
});

describe('the timeline', () => {
  it('merges its sources newest first and follows a merged account', () => {
    detection(ALT, '2026-09-20T10:00:00.000Z', 1);
    lilac(MAIN, '2026-09-21T10:00:00.000Z');
    addAlias(db, { steamid: ALT, canonical: MAIN, by: 'test' });

    const items = playerTimeline(db, MAIN, STAFF);
    expect(items.map((i) => i.source)).toEqual(['lilac', 'input']);
    expect(items[0].summary).toMatch(/Little Anti-Cheat/);
    expect(items[1].summary).toMatch(/pistol_rate/);
    expect(items[1].matchId).toBe(7);
    expect(items[1].ref).toEqual({ type: 'input_detection', id: 1 });
    // Asking under the alt's own id answers about the person, not the id.
    expect(playerTimeline(db, ALT, STAFF)).toHaveLength(2);
  });

  // Owner's ruling, 2026-09-22: a scroll wheel bound to +attack or +jump is
  // legal. Its flag stays on the file, labelled, but is nobody's evidence.
  it('keeps a scroll-wheel input flag on the file but does not count it as evidence', () => {
    detection(MAIN, '2026-09-21T10:00:00.000Z', 1, 'pounce_spam', 'wheel-like');
    detection(ALT, '2026-09-21T11:00:00.000Z', 2, 'pounce_spam', 'no-hold-data, plugin 0.1.0 capture');
    const [wheel] = playerTimeline(db, MAIN, STAFF);
    expect(wheel.summary).toMatch(/scroll wheel/i);
    expect(isEvidence(wheel)).toBe(false);
    const inputs = ADAPTERS.find((a) => a.source === 'input')!;
    expect(inputs.evidence!(db).map((r) => r.steamid)).toEqual([ALT]);
    expect(isEvidence(playerTimeline(db, ALT, STAFF)[0])).toBe(true);
    // The same test decides whether the admin channel hears about it.
    expect(isWheel('wheel-like')).toBe(true);
    expect(isWheel('no-hold-data, plugin 0.1.0 capture')).toBe(false);
  });

  it('a banned flag reads differently from a suspicion, and neither is a verdict', () => {
    lilac(MAIN, '2026-09-21T10:00:00.000Z', 'bhop', 'banned');
    const [one] = playerTimeline(db, MAIN, STAFF);
    expect(one.kind).toBe('bhop');
    expect(one.summary).toMatch(/banned/i);
    lilac(MAIN, '2026-09-21T11:00:00.000Z', 'macro');
    expect(playerTimeline(db, MAIN, STAFF)[0].summary).toMatch(/false positives/);
  });

  it('an adapter that throws yields nothing and the file still renders', () => {
    detection(MAIN, '2026-09-20T10:00:00.000Z', 1);
    const broken: TimelineAdapter = { source: 'note', items: () => { throw new Error('boom'); } };
    expect(playerTimeline(db, MAIN, STAFF, [broken, ...ADAPTERS])).toHaveLength(1);
  });

  it('knows which items are evidence, and that one connect drop is not', () => {
    expect(isEvidence(item({ source: 'input' }))).toBe(true);
    expect(isEvidence(item({ source: 'lilac' }))).toBe(true);
    expect(isEvidence(item({ source: 'analyzer' }))).toBe(true);
    expect(isEvidence(item({ source: 'steam' }))).toBe(true);
    expect(isEvidence(item({ source: 'drop', kind: 'drop' }))).toBe(false);
    expect(isEvidence(item({ source: 'drop', kind: 'repeat' }))).toBe(true);
    expect(isEvidence(item({ source: 'ban' }))).toBe(false);
  });

  it('reads both time formats this database writes', () => {
    expect(toIso('2026-09-21 10:00:00')).toBe('2026-09-21T10:00:00.000Z');
    expect(toIso('2026-09-21T10:00:00.000Z')).toBe('2026-09-21T10:00:00.000Z');
  });

  it('each adapter that offers evidence answers with one row per steamid', () => {
    detection(MAIN, '2026-09-20T10:00:00.000Z', 1);
    detection(MAIN, '2026-09-21T10:00:00.000Z', 2, 'wheel');
    const input = ADAPTERS.find((a) => a.source === 'input')!;
    expect(input.evidence!(db)).toEqual([{ steamid: MAIN, at: '2026-09-21T10:00:00.000Z' }]);
  });
});
