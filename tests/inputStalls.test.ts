import { describe, it, expect, beforeEach } from 'vitest';
import { openDb, type DB } from '../src/db.js';
import { parseLogDatagram } from '../src/logParse.js';
import { evaluateStalls, fakelag, recordInputStall, FAKELAG_MIN_LUNGING } from '../src/inputStalls.js';
import { detectionsForPlayer, rerunSignatures } from '../src/inputBursts.js';
import { BELLA_631, DANIEL_BAD_LINE } from './fixtures/stallSamples.js';

const A = '76561198030413993';
const parseLogLine = (s: string) => parseLogDatagram(Buffer.from(s, 'utf8'));
const rows = (seq: readonly (readonly number[])[]) =>
  seq.map(([gap, missed, , team, cls, lunging], i) => ({ id: i + 1, gap, missed, team, cls, lunging, at: `2026-10-10T21:00:${String(i % 60).padStart(2, '0')}.000Z` }));

describe('fakelag', () => {
  it('catches the confirmed fakelag on its real stalls', () => {
    const r = fakelag(rows(BELLA_631));
    expect(r).not.toBeNull();
    expect(r!.lunging).toBe(29);
  });

  // 262 stalls, many as a hunter, but at random moments.
  it('leaves the worst honest connection alone', () => {
    expect(fakelag(rows(DANIEL_BAD_LINE))).toBeNull();
  });

  it('ignores lost commands, survivors and other classes', () => {
    const mid = (over: Partial<Record<string, number>>) => ({ id: 1, gap: 11, missed: 0, team: 3, cls: 3, lunging: 1, at: '', ...over });
    const n = FAKELAG_MIN_LUNGING;
    expect(fakelag(Array.from({ length: n }, () => mid({})))).not.toBeNull();
    expect(fakelag(Array.from({ length: n }, () => mid({ missed: 2 })))).toBeNull();
    expect(fakelag(Array.from({ length: n }, () => mid({ team: 2 })))).toBeNull();
    expect(fakelag(Array.from({ length: n }, () => mid({ cls: 1 })))).toBeNull();
    expect(fakelag(Array.from({ length: n }, () => mid({ gap: 40 })))).toBeNull();
  });

  // A hunter who stalls all the time on a bad line will hit some pounces.
  it('wants a share, not just a count', () => {
    const many = [
      ...Array.from({ length: FAKELAG_MIN_LUNGING }, (_, i) => ({ id: i, gap: 9, missed: 0, team: 3, cls: 3, lunging: 1, at: '' })),
      ...Array.from({ length: 60 }, (_, i) => ({ id: 100 + i, gap: 9, missed: 0, team: 3, cls: 3, lunging: 0, at: '' })),
    ];
    expect(fakelag(many)).toBeNull();
  });
});

describe('the stall line', () => {
  const line = (body: string) => `L 10/10/2026 - 21:01:05: ${body}`;
  it('parses what the plugin sends', () => {
    expect(parseLogLine(line(`L4DM id=${A} k=stall st=52304 gap=11 miss=0 cmds=12 team=3 cls=3 lunge=1 v=2`))).toEqual({
      kind: 'input_stall', steamid: A, serverTick: 52304, gap: 11, missed: 0, cmds: 12, team: 3, cls: 3, lunging: 1,
    });
    expect(parseLogLine(line(`L4DM id=${A} k=stall st=1 gap=9 miss=0 cmds=10 team=2 cls=0 lunge=-1 v=2`))).toMatchObject({ lunging: -1 });
  });

  it('refuses a stall forged through chat', () => {
    expect(parseLogLine(line(`"x<2><STEAM_1:0:5><Infected>" say "L4DM id=${A} k=stall st=1 gap=9 miss=0 cmds=10 team=3 cls=3 lunge=1 v=2"`)))
      .not.toMatchObject({ kind: 'input_stall' });
  });

  it('refuses anything the plugin could not have sent', () => {
    for (const bad of ['gap=0', 'gap=101', 'lunge=2', 'team=4', 'cmds=x', 'v=1']) {
      const body = `L4DM id=${A} k=stall st=1 gap=9 miss=0 cmds=10 team=3 cls=3 lunge=1 v=2`.replace(new RegExp(`${bad.split('=')[0]}=\\S+`), bad);
      expect(parseLogLine(line(body))).toBeNull();
    }
  });
});

describe('stalls through storage', () => {
  let db: DB;
  beforeEach(() => { db = openDb(':memory:'); });
  const store = (seq: readonly (readonly number[])[]) => seq.map(([gap, missed, cmds, team, cls, lunging], i) =>
    recordInputStall(db, { matchId: 631, serverId: 1, steamid: A, serverTick: 1000 + i * 100, gap, missed, cmds, team, cls, lunging }));

  it('creates one low-severity row and posts once', () => {
    const created = store(BELLA_631).filter((r) => r.created);
    expect(created).toHaveLength(1);
    // Posted the moment the tenth mid-pounce stall lands, not at match end.
    expect(created[0].created).toMatch(/^10 of \d+ hunter input stalls hung mid-pounce$/);
    const [d] = detectionsForPlayer(db, A);
    expect(d).toMatchObject({ signature: 'fakelag', kind: 'stall', severity: 'low', hits: 29, evidence: [], note: '29 of 59 hunter input stalls hung mid-pounce' });
  });

  it('survives a rerun of the input signatures', () => {
    store(BELLA_631);
    rerunSignatures(db);
    expect(detectionsForPlayer(db, A).map((d) => d.signature)).toEqual(['fakelag']);
  });

  it('drops the row when the match stops qualifying, as a rerun would', () => {
    store(BELLA_631);
    // A long run of hunter stalls that were not mid-pounce pulls the share
    // under a quarter.
    store(Array.from({ length: 80 }, () => [9, 0, 10, 3, 3, 0]));
    expect(detectionsForPlayer(db, A)).toHaveLength(0);
  });

  it('stores stalls outside a match without evaluating them', () => {
    expect(recordInputStall(db, { matchId: null, serverId: 1, steamid: A, serverTick: 1, gap: 11, missed: 0, cmds: 12, team: 3, cls: 3, lunging: 1 }).created).toBeNull();
    expect(evaluateStalls(db, 631, A)).toBeNull();
  });
});
