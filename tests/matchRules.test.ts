import { describe, it, expect, afterEach } from 'vitest';
import * as R from '../src/events/room.js';
import { forfeitTook } from '../src/events/series.js';
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

const setStageRules = (over: Record<string, unknown>) => {
  const s = f.db.prepare('SELECT s.id, s.rules_json, r.rules_json AS base FROM event_stages s JOIN rulesets r ON r.id = s.ruleset_id WHERE s.id = ?')
    .get(f.match().stage_id) as { id: number; rules_json: string | null; base: string };
  f.db.prepare('UPDATE event_stages SET rules_json = ? WHERE id = ?').run(JSON.stringify({ ...JSON.parse(s.rules_json ?? s.base), ...over }), s.id);
};
const alertText = () => f.alerts.map((a) => ('text' in a ? String(a.text) : ''));

describe('technical pauses from the box (series.ts)', () => {
  it('orients the pug team to the room side, records each line, tells staff and pushes the room', async () => {
    const token = await playing();
    f.alerts.length = 0;
    f.pushes.length = 0;
    // Pug team b is Rats (entry a) on this game.
    await f.line(`PUG ${token} TECH event=start id=${T1} team=b cause=call by=${A[0]} used=0 budget=300 text=my router restarted`);
    expect(R.techPausesOf(f.db, f.match())[0]).toMatchObject({ side: 'a', cause: 'call', by: A[0], reason: 'my router restarted' });
    expect(alertText().some((t) => t.includes('Rats called a technical pause in game 1: "my router restarted" (5:00 of technical time left).'))).toBe(true);
    expect(f.pushes).toContain(f.matchId);
    await f.line(`PUG ${token} TECH event=flag id=${T1} team=b cause=call by=${BATS[0]} used=40 budget=300 text=looks fake`);
    await f.line(`PUG ${token} TECH event=over id=${T1} team=b cause=call by=${A[0]} used=300 budget=300 tactical=1 text=`);
    expect(alertText().some((t) => t.includes('Rats ran out of technical time; the pause now uses a tactical pause (1 left).'))).toBe(true);
    await f.line(`PUG ${token} TECH event=end id=${T1} team=b cause=call by=${A[0]} used=300 budget=300 text=`);
    expect(R.techPausesOf(f.db, f.match())[0]).toMatchObject({ flagged: { by: BATS[0], note: 'looks fake' }, overrun: { tactical: 1 }, used: 300 });
    expect(R.techPausesOf(f.db, f.match())[0]!.endedAt).not.toBeNull();
    // Pug team a is Bats (entry b): a disconnect pause on their reconnect time.
    await f.line(`PUG ${token} TECH event=start id=${T1 + 90} team=a cause=disconnect by=${BATS[2]} used=15 budget=600 text=disconnected`);
    expect(R.techPausesOf(f.db, f.match())[1]).toMatchObject({ side: 'b', cause: 'disconnect', by: BATS[2] });
    expect(alertText().some((t) => t.includes('Bats is paused for a disconnect') && t.includes('9:45 of reconnect time left'))).toBe(true);
    // A repeated line changes nothing and alerts nobody again.
    const n = f.alerts.length;
    await f.line(`PUG ${token} TECH event=start id=${T1 + 90} team=a cause=disconnect by=${BATS[2]} used=15 budget=600 text=disconnected`);
    expect(f.alerts.length).toBe(n);
    expect(R.techPausesOf(f.db, f.match())).toHaveLength(2);
  });

  it('words the three overrun outcomes apart: N left, none left and unpaused, and unlimited', async () => {
    const token = await playing();
    const over = async (id: number, tactical: string) => {
      await f.line(`PUG ${token} TECH event=start id=${id} team=b cause=call by=${A[0]} used=0 budget=300 text=lag`);
      await f.line(`PUG ${token} TECH event=over id=${id} team=b cause=call by=${A[0]} used=300 budget=300${tactical} text=`);
      await f.line(`PUG ${token} TECH event=end id=${id} team=b cause=call by=${A[0]} used=300 budget=300 text=`);
    };
    f.alerts.length = 0;
    await over(T1, ' tactical=0');
    expect(alertText().some((t) => t.includes('Rats ran out of technical time; the pause now uses a tactical pause (0 left).'))).toBe(true);
    await over(T1 + 100, ' tactical=-1');
    expect(alertText().some((t) => t.includes('Rats ran out of technical time with no tactical pause left; the game was unpaused.'))).toBe(true);
    await over(T1 + 200, '');
    expect(alertText().some((t) => t.includes('Rats ran out of technical time; the pause now uses a tactical pause (tactical pauses are unlimited).'))).toBe(true);
    expect(R.techPausesOf(f.db, f.match()).map((p) => p.overrun?.tactical)).toEqual([0, -1, null]);
  });

  it('takes an emergency sub as one of the match\'s subs, and refuses it when the stage turned them off (Ruling 10)', async () => {
    const token = await playing();
    f.sent.length = 0;
    await f.line(`PUG ${token} SUB by=${A[0]} out=${A[3]} in=${A[4]} map=0 emergency=1`);
    expect(f.sent).toContain(`sm_pug_sub ${token} ${A[3]} ${A[4]}`);
    expect(f.sent.some((c) => /^say \[Match\] .+ is in for .+ \(Rats, emergency sub 1 of 2\)\.$/.test(c))).toBe(true);
    expect(R.subsUsed(f.db, f.match(), 'a')).toBe(1);
    setStageRules({ subs: { perMatch: 2, emergency: false, emergencyChargeSeconds: 0 } });
    f.sent.length = 0;
    await f.line(`PUG ${token} SUB by=${A[0]} out=${A[4]} in=${A[3]} map=0 emergency=1`);
    expect(f.sent.some((c) => c.startsWith(`say [Match] Sub refused: ${EVENT_ERRORS.emergency_off.text}`))).toBe(true);
    expect(f.sent.some((c) => c.startsWith('sm_pug_sub '))).toBe(false);
    expect(R.subsUsed(f.db, f.match(), 'a')).toBe(1);
  });

  it('records a game the reconnect pool forfeited from the result path, and says why (Ruling 9)', async () => {
    await playing();
    const g1 = f.gameOf(1).match_id!;
    // Rats (pug team b) ran out while leading: the box names Bats (pug team a) the winner.
    f.db.prepare("UPDATE matches SET state = 'completed', team_a_score = 100, team_b_score = 400, winner = 'a', forfeit_team = 'b', forfeit_why = 'disconnect', ended_at = datetime('now') WHERE id = ?").run(g1);
    f.sent.length = 0;
    f.runner.onGameEnded(g1);
    expect(f.gameOf(1)).toMatchObject({ score_a: 400, score_b: 100, forfeit_side: 'a', forfeit_why: 'disconnect', winner: f.entryB });
    expect(f.match().status).toBe('confirming');
    // A games-won series counts a forfeited game as a loss like any other
    // (seriesRules); the total-score wording is pinned in tests/series.test.ts.
    expect(f.sent.some((c) => c.startsWith('say [Match] Series over: Bats beat Rats 1 game to 0.'))).toBe(true);
  });
});

describe('staff penalties (series.ts)', () => {
  const paused = async () => {
    const token = await playing();
    await f.line(`PUG ${token} TECH event=start id=${T1} team=b cause=call by=${A[0]} used=0 budget=300 text=router`);
    return { token, id: R.techPausesOf(f.db, f.match())[0]!.id };
  };

  it('warns once, with a DM to both rosters', async () => {
    const { id } = await paused();
    expect((await f.series.techPenalty(f.matchId, ADMIN, id, 'warning', 'last warning')).ok).toBe(true);
    expect(f.send).toHaveBeenCalledWith(expect.arrayContaining([A[0], BATS[0]]), 'event_match_staff',
      expect.objectContaining({ content: expect.stringContaining('staff gave a warning for a technical pause (Rats, game 1: "router")') }));
    expect(await f.series.techPenalty(f.matchId, ADMIN, id, 'forfeit', null)).toEqual({ ok: false, error: 'already_penalized' });
  });

  it('forfeits the live game on the box for the pausing team\'s pug team, then records it (Ruling 12)', async () => {
    const { token, id } = await paused();
    f.sent.length = 0;
    expect((await f.series.techPenalty(f.matchId, ADMIN, id, 'forfeit', 'fake pause')).ok).toBe(true);
    // Rats (entry a) are pug team b on this game.
    expect(f.sent).toContain(`sm_pug_forfeit ${token} b`);
    expect(R.techPausesOf(f.db, f.match())[0]!.penalty).toMatchObject({ kind: 'forfeit', by: ADMIN, note: 'fake pause' });
    expect(f.send).toHaveBeenCalledWith(expect.anything(), 'event_match_staff',
      expect.objectContaining({ content: expect.stringContaining('ruled that a team forfeits the game over a technical pause') }));
    expect(forfeitTook('PUGOK forfeit team=b', 'b')).toBe(true);
    expect(forfeitTook('PUGOK forfeit team=b already', 'b')).toBe(true);
    expect(forfeitTook('PUGOK forfeit team=a', 'b')).toBe(false);
    expect(forfeitTook('PUGERR already forfeited', 'b')).toBe(false);
  });

  it('keeps the ruling when the forfeit ends the game and the series before the box\'s answer is read', async () => {
    const { id } = await paused();
    const g1 = f.gameOf(1).match_id!;
    let open!: () => void;
    f.box.gate = new Promise<void>((r) => { open = r; });
    const ruling = f.series.techPenalty(f.matchId, ADMIN, id, 'forfeit', 'fake pause');
    // The box ends the game with Rats' forfeit (pug team b, a staff ruling) and the series is over and resolved before the reply lands.
    f.db.prepare("UPDATE matches SET state = 'completed', team_a_score = 400, team_b_score = 100, winner = 'a', forfeit_team = 'b', forfeit_why = 'staff', ended_at = datetime('now') WHERE id = ?").run(g1);
    f.db.prepare('DELETE FROM match_live WHERE match_id = ?').run(g1);
    f.series.gameEnded(f.match().booking_id!, g1);
    expect(f.gameOf(1)).toMatchObject({ forfeit_side: 'a', forfeit_why: 'staff', winner: f.entryB });
    f.db.prepare("UPDATE event_matches SET status = 'done' WHERE id = ?").run(f.matchId);
    f.box.gate = null;
    open();
    expect((await ruling).ok).toBe(true);
    expect(R.techPausesOf(f.db, f.match())[0]!.penalty).toMatchObject({ kind: 'forfeit', by: ADMIN, note: 'fake pause' });
  });

  it('refuses a forfeit the box does not take or whose game is over, writing nothing, and a penalty it does not know', async () => {
    const { id } = await paused();
    f.box.forfeitOk = false;
    expect(await f.series.techPenalty(f.matchId, ADMIN, id, 'forfeit', null)).toEqual({ ok: false, error: 'no_box' });
    expect(R.techPausesOf(f.db, f.match())[0]!.penalty).toBeNull();
    f.box.forfeitOk = true;
    f.endGame(f.gameOf(1).match_id!, [{ map: 'm1', a: 100, b: 900 }]);
    expect(await f.series.techPenalty(f.matchId, ADMIN, id, 'forfeit', null)).toEqual({ ok: false, error: 'no_live_game' });
    expect(await f.series.techPenalty(f.matchId, ADMIN, id, 'forfeit-ish', null)).toEqual({ ok: false, error: 'bad_penalty' });
    // A warning is still possible in the confirm window.
    expect((await f.series.techPenalty(f.matchId, ADMIN, id, 'warning', null)).ok).toBe(true);
  });
});

describe('a forfeit ruling on a match its own forfeit resolved (room.ts)', () => {
  it('records the ruling only when the pause\'s game was forfeited by that side on a staff ruling', async () => {
    await playing();
    const r = start();
    if (!r.ok) throw new Error(r.error);
    const id = r.value.pause.id;
    const now = new Date(f.t.t);
    const g1 = f.gameOf(1);
    // A !gg by the pausing side is not the staff forfeit: the resolved match refuses.
    expect(R.recordGame(f.db, { matchId: f.matchId, gameId: g1.id, scoreA: 100, scoreB: 400, forfeit: 'a', forfeitWhy: 'gg', now }).ok).toBe(true);
    f.db.prepare("UPDATE event_matches SET status = 'done' WHERE id = ?").run(f.matchId);
    const rows = () => (f.db.prepare("SELECT COUNT(*) FROM event_log WHERE action = 'tech_penalty'").pluck().get() as number);
    expect(R.techPenalty(f.db, { matchId: f.matchId, pauseId: id, by: ADMIN, penalty: 'forfeit', note: null, now })).toEqual({ ok: false, error: 'wrong_status' });
    f.db.prepare("UPDATE event_games SET forfeit_why = 'staff' WHERE id = ?").run(g1.id);
    expect(R.techPenalty(f.db, { matchId: f.matchId, pauseId: id, by: ADMIN, penalty: 'warning', note: null, now })).toEqual({ ok: false, error: 'wrong_status' });
    expect(rows()).toBe(0);
    const ok = R.techPenalty(f.db, { matchId: f.matchId, pauseId: id, by: ADMIN, penalty: 'forfeit', note: 'fake', now });
    expect(ok.ok && ok.value.pause.penalty).toMatchObject({ kind: 'forfeit', by: ADMIN, note: 'fake' });
    expect(rows()).toBe(1);
    expect(R.techPenalty(f.db, { matchId: f.matchId, pauseId: id, by: ADMIN, penalty: 'forfeit', note: null, now })).toEqual({ ok: false, error: 'already_penalized' });
    expect(rows()).toBe(1);
  });
});
