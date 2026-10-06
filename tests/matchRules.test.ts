import { describe, it, expect, afterEach } from 'vitest';
import * as R from '../src/events/room.js';
import { EVENT_ERRORS } from '../src/events/validate.js';
import { ADMIN } from './eventFixture.js';
import { A, B as BATS } from './entryFixture.js';
import { seriesFixture, type SeriesFixture } from './seriesFixture.js';

/** Tournaments plan T5: the match rules on the site. In the fixture's game
 *  1, booking_side_a is 'b': pug team a is Bats (entry b), pug team b is
 *  Rats (entry a). */
let f: SeriesFixture;
afterEach(() => f?.close());
const T1 = 1_791_000_000;

const playing = async () => {
  f = await seriesFixture();
  await f.tick();
  f.box.humans = [...A.slice(0, 4), ...BATS.slice(0, 4), A[4]!];
  f.goLive(f.gameOf(1).match_id!);
  return f.liveGameToken();
};
const start = (over: Partial<Parameters<typeof R.noteTech>[1]> = {}) => R.noteTech(f.db, {
  matchId: f.matchId, gameMatchId: f.gameOf(1).match_id!, event: 'start', techId: T1, side: 'a', cause: 'call', by: A[0]!,
  used: 0, budget: 300, tactical: null, text: '  my   router restarted  ', now: new Date(f.t.t), ...over,
});

describe('the pause ledger (room.ts)', () => {
  it('records a technical pause, its end, overrun and flag once each, in one log row apiece', async () => {
    await playing();
    const r = start();
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.pause).toMatchObject({ techId: T1, side: 'a', cause: 'call', by: A[0], reason: 'my router restarted', used: 0, budget: 300, endedAt: null, overrun: null, flagged: null, penalty: null, ordinal: 1 });
    expect(start()).toEqual({ ok: false, error: 'changed' });
    const base = { matchId: f.matchId, gameMatchId: f.gameOf(1).match_id!, techId: T1, side: 'a' as const, cause: 'call' as const, budget: 300, now: new Date(f.t.t) };
    expect(R.noteTech(f.db, { ...base, event: 'flag', by: BATS[0]!, used: 40, tactical: null, text: 'looks fake' }).ok).toBe(true);
    expect(R.noteTech(f.db, { ...base, event: 'flag', by: BATS[1]!, used: 41, tactical: null, text: 'again' })).toEqual({ ok: false, error: 'changed' });
    expect(R.noteTech(f.db, { ...base, event: 'over', by: A[0]!, used: 300, tactical: 1, text: '' }).ok).toBe(true);
    expect(R.noteTech(f.db, { ...base, event: 'end', by: A[0]!, used: 300, tactical: null, text: '' }).ok).toBe(true);
    expect(R.noteTech(f.db, { ...base, event: 'end', by: A[0]!, used: 300, tactical: null, text: '' })).toEqual({ ok: false, error: 'changed' });
    expect(R.noteTech(f.db, { ...base, techId: T1 + 5, event: 'end', by: null, used: 0, tactical: null, text: '' })).toEqual({ ok: false, error: 'pause_not_found' });
    expect(R.noteTech(f.db, { ...base, gameMatchId: 999_999, event: 'start', by: null, used: 0, tactical: null, text: 'x' })).toEqual({ ok: false, error: 'game_not_found' });
    const [p] = R.techPausesOf(f.db, f.match());
    expect(p).toMatchObject({ used: 300, overrun: { tactical: 1 }, flagged: { by: BATS[0], note: 'looks fake' } });
    expect(p!.endedAt).not.toBeNull();
    const actions = (f.db.prepare("SELECT action, actor FROM event_log WHERE action LIKE 'tech_%' ORDER BY id").all() as { action: string; actor: string | null }[]);
    expect(actions).toEqual([
      { action: 'tech_pause', actor: A[0] }, { action: 'tech_flagged', actor: BATS[0] }, { action: 'tech_overrun', actor: null }, { action: 'tech_pause_ended', actor: null },
    ]);
  });

  it('keeps the three overrun outcomes apart and charges a disconnect to nobody', async () => {
    await playing();
    const g = f.gameOf(1).match_id!;
    const base = { matchId: f.matchId, gameMatchId: g, side: 'b' as const, budget: 300, now: new Date(f.t.t), text: '' };
    for (const [i, tactical] of [-1, 0, null].entries()) {
      const techId = T1 + 100 * (i + 1);
      expect(R.noteTech(f.db, { ...base, techId, event: 'start', cause: 'call', by: BATS[0]!, used: 0, tactical: null }).ok).toBe(true);
      expect(R.noteTech(f.db, { ...base, techId, event: 'over', cause: 'call', by: BATS[0]!, used: 300, tactical }).ok).toBe(true);
    }
    expect(R.techPausesOf(f.db, f.match()).map((p) => p.overrun?.tactical)).toEqual([-1, 0, null]);
    const d = R.noteTech(f.db, { ...base, techId: T1 + 900, event: 'start', cause: 'disconnect', by: BATS[2]!, used: 0, tactical: null, text: 'disconnect' });
    expect(d.ok && d.value.pause).toMatchObject({ cause: 'disconnect', by: BATS[2] });
    expect((f.db.prepare("SELECT actor FROM event_log WHERE action = 'tech_pause' ORDER BY id DESC LIMIT 1").get() as { actor: string | null }).actor).toBeNull();
  });

  it('takes one penalty per pause, refuses a bad one or a resolved match, and keeps the note', async () => {
    await playing();
    const r = start();
    if (!r.ok) throw new Error(r.error);
    const id = r.value.pause.id;
    const now = new Date(f.t.t);
    expect(R.techPenalty(f.db, { matchId: f.matchId, pauseId: id, by: ADMIN, penalty: 'ban', note: null, now })).toEqual({ ok: false, error: 'bad_penalty' });
    expect(R.techPenalty(f.db, { matchId: f.matchId, pauseId: 123_456, by: ADMIN, penalty: 'warning', note: null, now })).toEqual({ ok: false, error: 'pause_not_found' });
    const w = R.techPenalty(f.db, { matchId: f.matchId, pauseId: id, by: ADMIN, penalty: 'warning', note: 'first and last', now });
    expect(w.ok && w.value.pause.penalty).toMatchObject({ kind: 'warning', by: ADMIN, note: 'first and last' });
    expect(R.techPenalty(f.db, { matchId: f.matchId, pauseId: id, by: ADMIN, penalty: 'forfeit', note: null, now })).toEqual({ ok: false, error: 'already_penalized' });
    const second = start({ techId: T1 + 60, text: 'mouse died' });
    if (!second.ok) throw new Error(second.error);
    f.db.prepare("UPDATE event_matches SET status = 'done' WHERE id = ?").run(f.matchId);
    expect(R.techPenalty(f.db, { matchId: f.matchId, pauseId: second.value.pause.id, by: ADMIN, penalty: 'warning', note: null, now })).toEqual({ ok: false, error: 'wrong_status' });
    expect(R.techPausesOf(f.db, f.match())).toHaveLength(2);
    expect(EVENT_ERRORS.already_penalized.status).toBe(409);
  });

  it('records why a game was forfeited and an emergency sub', async () => {
    await playing();
    const g1 = f.gameOf(1);
    const s = R.subPlayer(f.db, { matchId: f.matchId, by: A[0]!, outId: A[3]!, inId: A[4]!, limit: 2, gameId: g1.id, emergency: true, now: new Date(f.t.t) });
    expect(s.ok).toBe(true);
    expect(JSON.parse((f.db.prepare("SELECT detail FROM event_log WHERE action = 'player_subbed'").get() as { detail: string }).detail)).toMatchObject({ emergency: true, used: 1 });
    const rec = R.recordGame(f.db, { matchId: f.matchId, gameId: g1.id, scoreA: 500, scoreB: 100, forfeit: 'a', forfeitWhy: 'disconnect', now: new Date(f.t.t) });
    expect(rec.ok).toBe(true);
    expect(f.gameOf(1)).toMatchObject({ forfeit_side: 'a', forfeit_why: 'disconnect', winner: f.entryB });
  });
});
