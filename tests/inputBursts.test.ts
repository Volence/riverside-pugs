import { describe, it, expect, beforeEach } from 'vitest';
import { ICY_WHEEL, BELLINGHAM_TAPS } from './fixtures/wheelSamples.js';
import { openDb, type DB } from '../src/db.js';
import {
  detectionsForPlayer, inputThresholds, recordInputBurst, rerunSignatures,
} from '../src/inputBursts.js';
import { DEFAULT_THRESHOLDS, POUNCE_REPEATS, decodeIntervals, isWheel } from '../src/inputStats.js';
import { setSetting } from '../src/settings.js';

const A = '76561198030413993';
const B = '76561198030413994';
let db: DB;
beforeEach(() => { db = openDb(':memory:'); });

const MACRO = [7, 8, 8, 7, 8, 8];
const burst = (over: Partial<Parameters<typeof recordInputBurst>[1]> = {}) => ({
  matchId: 7, serverId: 1, steamid: A, kind: 'pounce' as const, weapon: 'weapon_hunter_claw',
  airPresses: 2, groundTicks: 4, serverTick: 1000, clientTick: 999, intervals: [18, 21, 19, 20],
  ...over,
});
/** Enough fast pounces, in one match, to produce a detection. */
const macroMatch = (over: Partial<Parameters<typeof recordInputBurst>[1]> = {}): string[][] =>
  Array.from({ length: POUNCE_REPEATS }, () => recordInputBurst(db, burst({ intervals: MACRO, ...over })).detections);

describe('recordInputBurst', () => {
  it('stores the burst and fires nothing for a human pounce', () => {
    const r = recordInputBurst(db, burst());
    expect(r.detections).toEqual([]);
    const row = db.prepare('SELECT * FROM input_bursts WHERE id = ?').get(r.id) as { n: number; intervals: string };
    expect(row.n).toBe(4);
    expect(row.intervals).toHaveLength(4);
  });

  // One fast airborne phase is not a detection. A hand can land six quick
  // presses once; the signature has to repeat across separate pounces.
  it('fires nothing on a single fast pounce', () => {
    expect(recordInputBurst(db, burst({ intervals: MACRO })).detections).toEqual([]);
    expect(detectionsForPlayer(db, A)).toHaveLength(0);
  });

  it('fires pounce_spam once the signature has repeated, on the burst that completed it', () => {
    const fired = macroMatch();
    expect(fired.slice(0, -1).every((f) => f.length === 0)).toBe(true);
    expect(fired[fired.length - 1]).toEqual(['pounce_spam']);
    expect(detectionsForPlayer(db, A)).toHaveLength(1);
  });

  // Evidence for review, never an accusation. 'high' shipped first, on a
  // threshold a legit player could reach.
  it('records the detection as low severity', () => {
    macroMatch();
    expect(detectionsForPlayer(db, A)[0].severity).toBe('low');
  });

  it('keeps ONE row per player, match and signature, and counts later phases on it', () => {
    macroMatch();
    const more = recordInputBurst(db, burst({ intervals: MACRO }));
    expect(more.detections).toEqual([]);                 // already detected: not news
    const rows = detectionsForPlayer(db, A);
    expect(rows).toHaveLength(1);
    expect(rows[0].hits).toBe(POUNCE_REPEATS + 1);
    expect(rows[0].evidence).toHaveLength(POUNCE_REPEATS + 1);
  });

  it('does not add up phases from different matches or different players', () => {
    for (let i = 0; i < POUNCE_REPEATS; i++) {
      recordInputBurst(db, burst({ intervals: MACRO, matchId: 100 + i }));
      recordInputBurst(db, burst({ intervals: MACRO, steamid: i % 2 ? A : B, matchId: 50 }));
    }
    expect(detectionsForPlayer(db, A)).toHaveLength(0);
    expect(detectionsForPlayer(db, B)).toHaveLength(0);
  });

  it('never detects on a burst that belongs to no match', () => {
    macroMatch({ matchId: null });
    expect(detectionsForPlayer(db, A)).toHaveLength(0);
  });

  it('does not fire on a fire burst however many presses', () => {
    expect(macroMatch({ kind: 'fire' }).flat()).toEqual([]);
  });

  it('does not fire on a survivor who was merely airborne', () => {
    expect(macroMatch({ weapon: 'weapon_pistol' }).flat()).toEqual([]);
  });
});

describe('pistol_rate', () => {
  const held = Array.from({ length: 50 }, (_, i) => (i % 3 === 0 ? 7 : 8));    // ~13/s for 3.8 s
  const fire = (over: Partial<Parameters<typeof recordInputBurst>[1]> = {}) =>
    burst({ kind: 'fire', weapon: 'weapon_pistol', airPresses: 0, groundTicks: 0, intervals: held, ...over });

  it('fires on the second sustained pistol burst in a match, at low severity', () => {
    expect(recordInputBurst(db, fire()).detections).toEqual([]);
    expect(recordInputBurst(db, fire()).detections).toEqual(['pistol_rate']);
    const rows = detectionsForPlayer(db, A);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ signature: 'pistol_rate', kind: 'fire', severity: 'low', hits: 2 });
  });

  it('keeps its own row beside pounce_spam for the same player and match', () => {
    macroMatch();
    recordInputBurst(db, fire());
    recordInputBurst(db, fire());
    expect(detectionsForPlayer(db, A).map((d) => d.signature).sort()).toEqual(['pistol_rate', 'pounce_spam']);
  });

  it('is found by a re-run over bursts stored before the signature existed', () => {
    const never = { ...DEFAULT_THRESHOLDS, pistolMinRate: 30 };
    recordInputBurst(db, fire(), never);
    recordInputBurst(db, fire(), never);
    expect(detectionsForPlayer(db, A)).toHaveLength(0);
    expect(rerunSignatures(db).detections).toBe(1);
    expect(detectionsForPlayer(db, A)[0].signature).toBe('pistol_rate');
  });

  it('reads its rate from its own setting', () => {
    setSetting(db, 'input_pistol_min_rate', '15');
    expect(inputThresholds(db).pistolMinRate).toBe(15);
  });
});

describe('hold annotation', () => {
  const held = Array.from({ length: 50 }, (_, i) => (i % 3 === 0 ? 7 : 8));
  const fire = (holds: number[] | null, intervals: number[] = held) =>
    burst({ kind: 'fire', weapon: 'weapon_pistol', airPresses: 0, groundTicks: 0, intervals, holds, wire: 2 });
  /** One-tick holds on a real wheel spin: what a legal wheel bind sends. */
  const wheelSpin = () => fire(Array.from({ length: ICY_WHEEL.length + 1 }, () => 1), ICY_WHEEL);

  it('stores the holds and gives them back decoded, with their stats', () => {
    const holds = Array.from({ length: 51 }, () => 1);
    recordInputBurst(db, fire(holds));
    recordInputBurst(db, fire(holds));
    const d = detectionsForPlayer(db, A)[0];
    expect(d.bursts).toHaveLength(2);
    expect(d.bursts[0].hold).toMatchObject({ n: 51, medianTicks: 1, oneTickFrac: 1 });
    expect(d.bursts[0].annotation).toBe('wheel-like');
    expect(d.bursts[0].ratePerSec).toBeGreaterThan(12);
  });

  // The annotation rides on the detection. It is NOT a detection of its own
  // and changes neither whether one exists nor its severity: whether a wheel
  // bind is legal is a league ruling, not something a threshold decides.
  it('annotates the detection without changing it', () => {
    recordInputBurst(db, wheelSpin());
    const second = recordInputBurst(db, wheelSpin());
    expect(second.detections).toEqual(['pistol_rate']);
    expect(second.created).toEqual([{ signature: 'pistol_rate', note: 'wheel-like' }]);
    expect(detectionsForPlayer(db, A)[0]).toMatchObject({ severity: 'low', note: 'wheel-like', hits: 2 });
  });

  // Wheel binds are legal, so a wheel-like detection is not announced. If
  // later bursts stop looking like a wheel, it becomes news for the first time.
  it('reports a detection again once it stops looking like a scroll wheel', () => {
    recordInputBurst(db, wheelSpin());
    recordInputBurst(db, wheelSpin());
    const fixed = Array.from({ length: 51 }, (_, i) => 3 + (i % 2));
    const more = [recordInputBurst(db, fire(fixed)), recordInputBurst(db, fire(fixed)), recordInputBurst(db, fire(fixed))];
    const note = detectionsForPlayer(db, A)[0].note;
    expect(note).not.toMatch(/^wheel-like/);
    expect(more.flatMap((r) => r.created)).toEqual([{ signature: 'pistol_rate', note: more.find((r) => r.created.length)!.created[0].note }]);
    // Once only: the row is no longer wheel-like, so a further burst is quiet.
    expect(recordInputBurst(db, fire(fixed)).created).toEqual([]);
  });

  // A wheel bind is legal; one-tick taps at a rate no hand-spun wheel holds
  // are not. Same holds, different rhythm, opposite answers.
  it('calls one-tick taps at a fixed rate steady-taps, which stays a flag', () => {
    const taps = fire(Array.from({ length: BELLINGHAM_TAPS.length + 1 }, () => 1), BELLINGHAM_TAPS);
    recordInputBurst(db, taps);
    const second = recordInputBurst(db, taps);
    expect(second.created).toEqual([{ signature: 'pistol_rate', note: 'steady-taps' }]);
    expect(isWheel(detectionsForPlayer(db, A)[0].note)).toBe(false);
  });

  it('tells a scripted fixed hold from a hand', () => {
    recordInputBurst(db, fire(Array.from({ length: 51 }, (_, i) => 3 + (i % 2))));
    recordInputBurst(db, fire(Array.from({ length: 51 }, (_, i) => 3 + (i % 2))));
    expect(detectionsForPlayer(db, A)[0].note).toBe('fixed-hold');
    const hand = { ...fire(Array.from({ length: 51 }, (_, i) => 4 + ((i * 7) % 9))), steamid: B };
    recordInputBurst(db, hand);
    recordInputBurst(db, hand);
    expect(detectionsForPlayer(db, B)[0].note).toBe('variable-hold');
  });

  // Plugin 0.1.0 sent no holds, timed by server tick, and captured ghosts.
  // A detection resting on its bursts has to say so.
  it('says when the evidence came from plugin 0.1.0', () => {
    for (let i = 0; i < 2; i++) recordInputBurst(db, { ...fire(null), wire: 1 });
    expect(detectionsForPlayer(db, A)[0].note).toBe('no-hold-data, plugin 0.1.0 capture');
  });
});

describe('inputThresholds', () => {
  it('falls back to the defaults for an absent or nonsense setting', () => {
    expect(inputThresholds(db)).toEqual(DEFAULT_THRESHOLDS);
    setSetting(db, 'input_pounce_min_rate', 'fast');
    expect(inputThresholds(db).pounceMinRate).toBe(DEFAULT_THRESHOLDS.pounceMinRate);
  });

  // The floor matters: a rate inside human reach turns the signature back
  // into the false positive machine it was.
  it('refuses a rate a hand can reach', () => {
    setSetting(db, 'input_pounce_min_rate', '8');
    expect(inputThresholds(db).pounceMinRate).toBe(DEFAULT_THRESHOLDS.pounceMinRate);
    setSetting(db, 'input_pounce_min_rate', '14');
    expect(inputThresholds(db).pounceMinRate).toBe(14);
  });

  // Production seeded input_pounce_spam_threshold = 12 (TICKS) on the day the
  // first signature shipped. That row outlives this change, and 12 read as a
  // RATE would be a coincidence, not a setting. The new key must not read it.
  it('ignores the legacy tick threshold row', () => {
    setSetting(db, 'input_pounce_spam_threshold', '30');
    expect(inputThresholds(db)).toEqual(DEFAULT_THRESHOLDS);
  });
});

describe('storage round trip', () => {
  // Wire 1 intervals are server ticks and wire 2 are usercmds. They are close
  // but not the same clock, so a stored burst has to say which it is.
  it('keeps the wire version and the server tick span beside the intervals', () => {
    const two = recordInputBurst(db, burst({ wire: 2, serverSpan: 77 }));
    const one = recordInputBurst(db, burst());
    const get = (id: number) => db.prepare('SELECT wire, server_span AS serverSpan FROM input_bursts WHERE id = ?').get(id);
    expect(get(two.id)).toEqual({ wire: 2, serverSpan: 77 });
    expect(get(one.id)).toEqual({ wire: 1, serverSpan: null });
  });

  // This exists because recordInputBurst once carried its own inlined copy of
  // the encoder. When the alphabet changed, storage wrote one base and the
  // decoder read another, every stored burst decoded to nothing, and re-run
  // silently found zero detections. Encode-only and decode-only tests both
  // passed throughout. Assert on what comes back OUT of the database.
  it('decodes every stored burst back to exactly what went in', () => {
    const ticks = [1, 30, 7, 15, 2];
    recordInputBurst(db, burst({ intervals: ticks }));
    const row = db.prepare('SELECT intervals FROM input_bursts ORDER BY id DESC LIMIT 1').get() as { intervals: string };
    expect(decodeIntervals(row.intervals)).toEqual(ticks);
  });
});

describe('rerunSignatures', () => {
  // The whole reason raw ordered intervals are stored: a signature written
  // later applies to everything recorded before it existed.
  it('finds detections a stricter earlier threshold missed', () => {
    const strict = { ...DEFAULT_THRESHOLDS, pounceMinRate: 25 };
    for (let i = 0; i < POUNCE_REPEATS; i++) recordInputBurst(db, burst({ intervals: MACRO }), strict);
    expect(detectionsForPlayer(db, A)).toHaveLength(0);
    expect(rerunSignatures(db).detections).toBe(1);
    expect(detectionsForPlayer(db, A)).toHaveLength(1);
  });

  it('is idempotent, so re-running twice does not double count', () => {
    macroMatch();
    const first = rerunSignatures(db);
    const second = rerunSignatures(db);
    expect(second).toEqual(first);
    expect(detectionsForPlayer(db, A)).toHaveLength(1);
    expect(detectionsForPlayer(db, A)[0].hits).toBe(POUNCE_REPEATS);
  });

  // Detections are a function of the stored bursts and the current signatures.
  // The rows the first signature wrote (one per burst, severity high, on a
  // threshold a legit player could reach) must not survive a recalibration.
  it('replaces detections an older signature wrote', () => {
    const r = recordInputBurst(db, burst({ intervals: [11, 12, 11, 12] }));
    db.prepare(
      `INSERT INTO input_detections (burst_id, match_id, steamid, kind, signature, severity, at)
       VALUES (?, 7, ?, 'pounce', 'pounce_spam', 'high', '2026-09-21T10:00:00.000Z')`,
    ).run(r.id, A);
    expect(detectionsForPlayer(db, A)).toHaveLength(1);
    expect(rerunSignatures(db).detections).toBe(0);
    expect(detectionsForPlayer(db, A)).toHaveLength(0);
  });

  it('dates a rebuilt detection from the burst that completed it, not from now', () => {
    const at = new Date('2026-09-21T09:00:00.000Z');
    for (let i = 0; i < POUNCE_REPEATS; i++) {
      recordInputBurst(db, burst({ intervals: MACRO }), DEFAULT_THRESHOLDS, new Date(at.getTime() + i * 1000));
    }
    rerunSignatures(db);
    expect(detectionsForPlayer(db, A)[0].at).toBe('2026-09-21T09:00:03.000Z');
  });

  it('can report what it would do without writing anything', () => {
    const strict = { ...DEFAULT_THRESHOLDS, pounceMinRate: 25 };
    for (let i = 0; i < POUNCE_REPEATS; i++) recordInputBurst(db, burst({ intervals: MACRO }), strict);
    expect(rerunSignatures(db, DEFAULT_THRESHOLDS, { dryRun: true }).detections).toBe(1);
    expect(detectionsForPlayer(db, A)).toHaveLength(0);
  });
});
