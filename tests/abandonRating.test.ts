import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { rating, rate } from 'openskill';
import type { FastifyInstance } from 'fastify';
import { openDb, type DB } from '../src/db.js';
import { upsertPlayer, activatePlayer } from '../src/players.js';
import { addServer } from '../src/serverPool.js';
import { handleAbandon, parseAbandonStatus, type AbandonConfirm, type AbandonDeps } from '../src/abandon.js';
import { completeMatch } from '../src/matchResult.js';
import { applyAbandonPenalty, quitterLoss, recomputeSeasonRatings } from '../src/rating.js';
import { restoreAbandonRating, voidMatch, abandonsOfPlayer } from '../src/admin/matches.js';
import { peopleBans } from '../src/admin/peopleBans.js';
import { subscribeAdminEvents, type AdminEvent } from '../src/adminFeed.js';
import { parseDump, type Dump } from '../src/dumpParse.js';
import { renderResult } from '../src/discord/presenter.js';
import { loadConfig } from '../src/config.js';
import { buildServer } from '../src/server.js';
import { authedCookie, stubOrchestrator } from './helpers.js';

const IDS = Array.from({ length: 8 }, (_, i) => `7656119900000000${i}`);
const TOKEN = 'b'.repeat(32);
const Q_A = IDS[1]; // a quitter on team a
const Q_B = IDS[6]; // a quitter on team b

let db: DB;
let serverId: number;
let released: number[];
let ended: { serverId: number; token: string; steamid: string }[];
let finished: number[];

function seedPlayers(d: DB): void {
  for (const p of IDS) { upsertPlayer(d, { steamid: p, name: `p${p.slice(-1)}`, avatar: null }, []); activatePlayer(d, p); }
}

function newMatch(state: 'live' | 'configuring' = 'live', token = TOKEN): number {
  const id = Number(db.prepare('INSERT INTO matches (season_id, state, campaign, server_id, token) VALUES (1, ?, \'dead_air\', ?, ?)')
    .run(state, serverId, token).lastInsertRowid);
  const ins = db.prepare('INSERT INTO match_players (match_id, player_id, team) VALUES (?, ?, ?)');
  IDS.forEach((p, i) => ins.run(id, p, i < 4 ? 'a' : 'b'));
  return id;
}

/** What sm_pug_status says: the line's player is an abandoner, plus `others`. */
const status = (decided: 'a' | 'b' | null, others: string[] = []): AbandonConfirm => ({
  abandoner: true, abandoners: others, gg: { decided, gap: decided ? 3000 : 100, ceiling: 1650, known: true },
});

function deps(confirm: boolean | AbandonConfirm, endAnswer: 'ok' | 'refused' | Error = 'ok'): AbandonDeps & { asked: () => number } {
  let asked = 0;
  return {
    db,
    releaser: { release: (id: number) => void released.push(id) } as never,
    confirm: async () => { asked++; return confirm; },
    endDecided: async (sid, token, steamid) => {
      ended.push({ serverId: sid, token, steamid });
      if (endAnswer instanceof Error) throw endAnswer;
      return endAnswer;
    },
    finish: (id) => void finished.push(id),
    asked: () => asked,
  };
}

/** The dump the plugin would hand back after sm_pug_abandon_end. */
function dumpFor(matchId: number, winner: 'a' | 'b'): Dump {
  return {
    matchId, maps: [{ map: 'm1', a: winner === 'a' ? 900 : 100, b: winner === 'b' ? 900 : 100 }, { map: 'm2', a: winner === 'a' ? 2900 : 100, b: winner === 'b' ? 2900 : 100 }],
    players: IDS.map((steamid, i) => ({ steamid, team: i < 4 ? 'a' as const : 'b' as const, joinedMap: 0, sidmg: 1, sikill: 1, ck: 1, ff: 0, rev: 0 })),
    skillDetect: false, skills: [], winner, totalA: winner === 'a' ? 3800 : 200, totalB: winner === 'b' ? 3800 : 200,
  };
}

const ratingOf = (id: string) => db.prepare('SELECT mu, sigma, wins, losses FROM player_ratings WHERE player_id = ? AND season_id = 1').get(id) as
  { mu: number; sigma: number; wins: number; losses: number } | undefined;
const historyRows = () => db.prepare('SELECT player_id, match_id, mu_before, sigma_before, mu_after, sigma_after FROM rating_history ORDER BY match_id, player_id').all();
const allRatings = () => db.prepare('SELECT player_id, mu, sigma, wins, losses FROM player_ratings ORDER BY player_id').all();

/** What a fresh 4v4 rates to, team by team, for a given rank. */
function fresh4v4(rank: number[]) {
  const t = () => [0, 1, 2, 3].map(() => rating());
  const [a, b] = rate([t(), t()], { rank });
  return { a: a[0], b: b[0] };
}

beforeEach(() => {
  db = openDb(':memory:');
  seedPlayers(db);
  serverId = addServer(db, { name: 's', host: '1.2.3.4', port: 27015, rconPort: 27015, rconPassword: 'x', status: 'live' });
  released = [];
  ended = [];
  finished = [];
});

describe('parseAbandonStatus', () => {
  const body = (gg: string) => `STATUS state=live match=1\nSTATUS leave abandoner=${Q_A} budget=300 autounpause=1 paused=1 holdmax=1800\n${gg}\nSTATUS end`;
  it('reads a decided judgement made at the abandon', () => {
    expect(parseAbandonStatus(body('STATUS gg decided=b gap=2400 ceiling=1650 known=1 at=abandon ended=0'), Q_A))
      .toEqual({ abandoner: true, abandoners: [Q_A], gg: { decided: 'b', gap: 2400, ceiling: 1650, known: true } });
  });
  it('lists every abandoner (0.3.31 STATUS abandon lines), the first included once', () => {
    const b = body(`STATUS abandon steamid=${Q_A}\nSTATUS abandon steamid=${Q_B}\nSTATUS gg decided=none gap=10 ceiling=1650 known=1 at=abandon ended=0`);
    expect(parseAbandonStatus(b, Q_B)).toMatchObject({ abandoner: true, abandoners: [Q_A, Q_B] });
    expect(parseAbandonStatus(b, IDS[0]).abandoner).toBe(false);
  });
  it('treats none, unknown, or a judgement not made at the abandon as not decided', () => {
    expect(parseAbandonStatus(body('STATUS gg decided=none gap=200 ceiling=1650 known=1 at=abandon ended=0'), Q_A).gg?.decided).toBeNull();
    expect(parseAbandonStatus(body('STATUS gg decided=b gap=-1 ceiling=-1 known=0 at=abandon ended=0'), Q_A).gg?.decided).toBeNull();
    expect(parseAbandonStatus(body('STATUS gg decided=b gap=2400 ceiling=1650 known=1 at=now ended=0'), Q_A).gg?.decided).toBeNull();
  });
  it('an older plugin with no gg line gives gg null; the abandoner must still match', () => {
    expect(parseAbandonStatus(body(''), Q_A)).toEqual({ abandoner: true, abandoners: [Q_A], gg: null });
    expect(parseAbandonStatus(body('STATUS gg decided=b gap=2400 ceiling=1650 known=1 at=abandon ended=0'), Q_B).abandoner).toBe(false);
  });
});

describe('undecided abandon: aborted, the quitter alone loses', () => {
  it('aborts, and only the quitter gets a rating row: the team loss they walked out on', async () => {
    const id = newMatch();
    expect(await handleAbandon(deps(status(null)), TOKEN, Q_A)).toBe(id);
    expect(db.prepare('SELECT state, abort_cause FROM matches WHERE id = ?').get(id)).toEqual({ state: 'aborted', abort_cause: 'abandon' });
    expect(released).toEqual([serverId]);
    expect(ended).toEqual([]);
    expect(db.prepare('SELECT player_id, team, decided FROM match_abandons WHERE match_id = ?').get(id)).toEqual({ player_id: Q_A, team: 'a', decided: null });
    const h = historyRows() as { player_id: string }[];
    expect(h.map((r) => r.player_id)).toEqual([Q_A]);
    const r = ratingOf(Q_A)!;
    const expected = fresh4v4([2, 1]).a;
    expect(r.mu).toBeCloseTo(expected.mu, 10);
    expect(r.sigma).toBeCloseTo(expected.sigma, 10);
    expect(r).toMatchObject({ wins: 0, losses: 1 });
    for (const p of IDS.filter((x) => x !== Q_A)) expect(ratingOf(p)?.wins ?? 0).toBe(0);
    expect(db.prepare('SELECT COUNT(*) AS n FROM player_ratings WHERE player_id != ?').get(Q_A)).toEqual({ n: 7 });
  });

  it('an older plugin (no STATUS gg line) gets the abort, plus the loss', async () => {
    const id = newMatch();
    expect(await handleAbandon(deps(true), TOKEN, Q_B)).toBe(id);
    expect(db.prepare('SELECT state FROM matches WHERE id = ?').pluck().get(id)).toBe('aborted');
    expect(ended).toEqual([]);
    expect(ratingOf(Q_B)).toMatchObject({ losses: 1, wins: 0 });
  });

  it('a decided answer from a site without endDecided is never acted on', async () => {
    const id = newMatch();
    const d = deps(status('b'));
    delete d.endDecided;
    expect(await handleAbandon(d, TOKEN, Q_A)).toBe(id);
    expect(db.prepare('SELECT state FROM matches WHERE id = ?').pluck().get(id)).toBe('aborted');
  });

  it('an abandon before go-live (configuring, no maps): aborted, the quitter loses against the full lineup', async () => {
    const id = newMatch('configuring');
    expect(await handleAbandon(deps(status(null)), TOKEN, Q_B)).toBe(id);
    expect(db.prepare('SELECT state FROM matches WHERE id = ?').pluck().get(id)).toBe('aborted');
    const expected = fresh4v4([1, 2]).b;
    expect(ratingOf(Q_B)!.mu).toBeCloseTo(expected.mu, 10);
  });

  it('repeated ABANDON lines: one ban, one rating row', async () => {
    newMatch();
    await handleAbandon(deps(status(null)), TOKEN, Q_A);
    await handleAbandon(deps(status(null)), TOKEN, Q_A);
    expect(db.prepare('SELECT COUNT(*) AS n FROM bans').get()).toEqual({ n: 1 });
    expect(historyRows()).toHaveLength(1);
    expect(ratingOf(Q_A)!.losses).toBe(1);
  });

  it('booked games are still ignored: no abandon row, no loss', async () => {
    const id = newMatch();
    db.prepare("INSERT INTO bookings (id, purpose, region, starts_at, ends_at, password, tv_password, game_config, rules_json, playlist_json, games_allowed, created_by, created_at) VALUES (78, 'tournament', 'na', '2026-10-06T00:00:00Z', '2026-10-06T02:00:00Z', 'pw', 'tv', 'standard', '{}', '[\"dead_air\"]', 1, ?, '2026-10-06T00:00:00Z')").run(IDS[0]);
    db.prepare('UPDATE matches SET booking_id = 78 WHERE id = ?').run(id);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      expect(await handleAbandon(deps(status('b')), TOKEN, Q_A)).toBeNull();
    } finally { warn.mockRestore(); }
    expect(db.prepare('SELECT COUNT(*) AS n FROM match_abandons').get()).toEqual({ n: 0 });
    expect(historyRows()).toHaveLength(0);
  });
});

describe('decided abandon: completes, the leader wins, the quitter loses', () => {
  it('the quitter on the TRAILING team: ended through the plugin, rated normally, the quitter a plain loss', async () => {
    const id = newMatch();
    const events: AdminEvent[] = [];
    const off = subscribeAdminEvents((e) => events.push(e));
    expect(await handleAbandon(deps(status('b')), TOKEN, Q_A)).toBe(id);
    off();
    expect(ended).toEqual([{ serverId, token: TOKEN, steamid: Q_A }]);
    expect(finished).toEqual([id]);
    // Not aborted, not released: the collector completes it and frees the box.
    expect(db.prepare('SELECT state FROM matches WHERE id = ?').pluck().get(id)).toBe('live');
    expect(released).toEqual([]);
    expect(db.prepare('SELECT COUNT(*) AS n FROM match_abort_notices').get()).toEqual({ n: 0 });
    expect(db.prepare("SELECT COUNT(*) AS n FROM bans WHERE reason = ?").get(`Abandoned match #${id}`)).toEqual({ n: 1 });
    expect(events).toContainEqual(expect.objectContaining({ kind: 'abandon', steamid: Q_A, matchId: id, minutes: 1440, decided: 'b' }));

    expect(completeMatch(db, id, dumpFor(id, 'b'))).toBe(true);
    const normal = fresh4v4([2, 1]);
    for (const p of IDS) {
      const r = ratingOf(p)!;
      const exp = IDS.indexOf(p) < 4 ? normal.a : normal.b;
      expect(r.mu).toBeCloseTo(exp.mu, 10);
      expect(r.sigma).toBeCloseTo(exp.sigma, 10);
    }
    expect(ratingOf(Q_A)).toMatchObject({ wins: 0, losses: 1 });
    expect(historyRows()).toHaveLength(8);
  });

  it('the quitter on the LEADING team: their team wins, they are rated the loss instead', async () => {
    const id = newMatch();
    expect(await handleAbandon(deps(status('a')), TOKEN, Q_A)).toBe(id);
    expect(completeMatch(db, id, dumpFor(id, 'a'))).toBe(true);
    expect(db.prepare('SELECT state, winner FROM matches WHERE id = ?').get(id)).toEqual({ state: 'completed', winner: 'a' });
    const normal = fresh4v4([1, 2]);
    // Everyone else exactly as if nobody had quit.
    for (const p of IDS.filter((x) => x !== Q_A)) {
      const exp = IDS.indexOf(p) < 4 ? normal.a : normal.b;
      expect(ratingOf(p)!.mu).toBeCloseTo(exp.mu, 10);
    }
    expect(ratingOf(IDS[0])).toMatchObject({ wins: 1, losses: 0 });
    // The quitter: the loss their team would have taken.
    const lost = fresh4v4([2, 1]).a;
    const q = ratingOf(Q_A)!;
    expect(q.mu).toBeCloseTo(lost.mu, 10);
    expect(q.mu).toBeLessThan(rating().mu);
    expect(q).toMatchObject({ wins: 0, losses: 1 });
  });

  it('the plugin refusing the end falls back to the abort, with the loss', async () => {
    const id = newMatch();
    expect(await handleAbandon(deps(status('b'), 'refused'), TOKEN, Q_A)).toBe(id);
    expect(db.prepare('SELECT state FROM matches WHERE id = ?').pluck().get(id)).toBe('aborted');
    expect(db.prepare('SELECT decided FROM match_abandons WHERE match_id = ?').pluck().get(id)).toBeNull();
    expect(released).toEqual([serverId]);
    expect(finished).toEqual([]);
    expect(ratingOf(Q_A)!.losses).toBe(1);
  });

  it('an unreachable box: the row and ban stand, the next line retries the end without asking again', async () => {
    const id = newMatch();
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const first = deps(status('b'), new Error('rcon timeout'));
    try {
      expect(await handleAbandon(first, TOKEN, Q_A)).toBeNull();
    } finally { err.mockRestore(); }
    expect(db.prepare('SELECT state FROM matches WHERE id = ?').pluck().get(id)).toBe('live');
    expect(db.prepare('SELECT decided FROM match_abandons WHERE match_id = ?').pluck().get(id)).toBe('b');
    const second = deps(status(null));
    expect(await handleAbandon(second, TOKEN, Q_A)).toBe(id);
    expect(second.asked()).toBe(0);
    expect(ended).toHaveLength(2);
    expect(finished).toEqual([id]);
    expect(db.prepare('SELECT COUNT(*) AS n FROM bans').get()).toEqual({ n: 1 });
  });

  it('too few rated players to rate the result: still the quitter loses', async () => {
    const id = newMatch();
    await handleAbandon(deps(status('a')), TOKEN, Q_A);
    db.prepare('UPDATE match_players SET rated = 0 WHERE match_id = ? AND player_id IN (?, ?, ?)').run(id, IDS[0], IDS[2], IDS[3]);
    const d = dumpFor(id, 'a');
    completeMatch(db, id, d);
    expect((historyRows() as { player_id: string }[]).map((r) => r.player_id)).toEqual([Q_A]);
    expect(ratingOf(Q_A)!.losses).toBe(1);
  });
});

describe('recompute, void and restore', () => {
  /** An undecided abandon, a decided one won by the quitter's team, and an
   *  ordinary match after both, so order matters. */
  async function season(): Promise<{ undecided: number; decided: number; later: number }> {
    const undecided = newMatch('live', 'c'.repeat(32));
    await handleAbandon(deps(status(null)), 'c'.repeat(32), Q_A);
    const decided = newMatch('live', 'd'.repeat(32));
    await handleAbandon(deps(status('a')), 'd'.repeat(32), Q_A);
    completeMatch(db, decided, dumpFor(decided, 'a'));
    const later = newMatch('live', 'e'.repeat(32));
    completeMatch(db, later, dumpFor(later, 'b'));
    return { undecided, decided, later };
  }

  it('a season recompute reproduces every abandon loss exactly, never twice', async () => {
    await season();
    const r = allRatings();
    const h = historyRows();
    recomputeSeasonRatings(db, 1);
    expect(allRatings()).toEqual(r);
    expect(historyRows()).toEqual(h);
    recomputeSeasonRatings(db, 1);
    expect(allRatings()).toEqual(r);
    expect(ratingOf(Q_A)).toMatchObject({ wins: 0, losses: 3 });
  });

  it('applyAbandonPenalty is idempotent', async () => {
    const { undecided } = await season();
    expect(applyAbandonPenalty(db, undecided)).toBe(false);
    expect((historyRows() as { match_id: number; player_id: string }[]).filter((x) => x.match_id === undecided)).toHaveLength(1);
  });

  it('voiding a decided-abandon match drops the result but keeps the quitter\'s loss', async () => {
    const { decided } = await season();
    expect(voidMatch(db, decided, 'test').ok).toBe(true);
    const rows = (historyRows() as { match_id: number; player_id: string }[]).filter((x) => x.match_id === decided);
    expect(rows.map((x) => x.player_id)).toEqual([Q_A]);
    expect(ratingOf(IDS[0])).toMatchObject({ wins: 0, losses: 1 }); // the decided win is gone, the later loss stays
    expect(ratingOf(Q_A)).toMatchObject({ wins: 0, losses: 3 });
  });

  it('restore takes the loss out and a recompute keeps it out', async () => {
    const { undecided, decided } = await season();
    // The ratings a season with no abandon losses would have.
    const control = openDb(':memory:');
    seedPlayers(control);
    const outer = db;
    db = control;
    const cs = addServer(db, { name: 's', host: '1.2.3.4', port: 27015, rconPort: 27015, rconPassword: 'x', status: 'live' });
    serverId = cs;
    const cDecided = newMatch('live', 'd'.repeat(32));
    completeMatch(db, cDecided, dumpFor(cDecided, 'a'));
    const cLater = newMatch('live', 'e'.repeat(32));
    completeMatch(db, cLater, dumpFor(cLater, 'b'));
    const want = allRatings();
    db = outer;

    expect(restoreAbandonRating(db, undecided, Q_A, IDS[0], 'server crashed').ok).toBe(true);
    expect(restoreAbandonRating(db, decided, null, IDS[0], 'server crashed').ok).toBe(true);
    expect(allRatings()).toEqual(want);
    recomputeSeasonRatings(db, 1);
    expect(allRatings()).toEqual(want);
    expect(ratingOf(Q_A)).toMatchObject({ wins: 1, losses: 1 });
    expect(restoreAbandonRating(db, decided, Q_A, IDS[0], 'again')).toMatchObject({ ok: false, status: 409 });
    expect(restoreAbandonRating(db, 99999, null, IDS[0], 'x')).toMatchObject({ ok: false, status: 404 });
    expect(restoreAbandonRating(db, decided, Q_B, IDS[0], 'x')).toMatchObject({ ok: false, status: 404 });
    expect(abandonsOfPlayer(db, Q_A).map((a) => [a.matchId, a.decided, a.restoreReason])).toEqual([
      [decided, 'a', 'server crashed'], [undecided, null, 'server crashed'],
    ]);
  });

  it('the People desk ban list shows a restored abandon loss', async () => {
    const { undecided } = await season();
    restoreAbandonRating(db, undecided, Q_A, IDS[0], 'our crash');
    const rows = peopleBans(db, { steamid: IDS[0], isAdmin: true, isMod: false } as never);
    const row = rows.find((b) => b.reason === `Abandoned match #${undecided}`)!;
    expect(row.abandon).toMatchObject({ matchId: undecided, restoreReason: 'our crash' });
    expect(row.abandon!.restoredAt).toBeTruthy();
  });
});

describe('several quitters (owner ruling 2026-10-10: every quitter loses)', () => {
  it('two quitters on the SAME team, undecided: both caught by one confirm, both banned, both lose, nobody else moves', async () => {
    const id = newMatch();
    const d = deps(status(null, [Q_A, IDS[2]]));
    expect(await handleAbandon(d, TOKEN, Q_A)).toBe(id);
    expect(db.prepare('SELECT player_id FROM match_abandons WHERE match_id = ? ORDER BY player_id').pluck().all(id)).toEqual([Q_A, IDS[2]]);
    expect(db.prepare('SELECT player_id FROM bans ORDER BY player_id').pluck().all()).toEqual([Q_A, IDS[2]]);
    expect((historyRows() as { player_id: string }[]).map((r) => r.player_id)).toEqual([Q_A, IDS[2]]);
    const lost = fresh4v4([2, 1]).a;
    for (const q of [Q_A, IDS[2]]) {
      expect(ratingOf(q)!.mu).toBeCloseTo(lost.mu, 10);
      expect(ratingOf(q)).toMatchObject({ wins: 0, losses: 1 });
    }
    // The second quitter's own line afterwards changes nothing.
    expect(await handleAbandon(deps(status(null, [Q_A, IDS[2]])), TOKEN, IDS[2])).toBeNull();
    expect(historyRows()).toHaveLength(2);
    expect(db.prepare("SELECT COUNT(*) AS n FROM match_abort_notices WHERE match_id = ? AND role = 'culprit'").get(id)).toEqual({ n: 2 });
  });

  it('two quitters on OPPOSITE teams, undecided: each loses against the other side', async () => {
    const id = newMatch();
    expect(await handleAbandon(deps(status(null, [Q_B])), TOKEN, Q_A)).toBe(id);
    expect(ratingOf(Q_A)!.mu).toBeCloseTo(fresh4v4([2, 1]).a.mu, 10);
    expect(ratingOf(Q_B)!.mu).toBeCloseTo(fresh4v4([1, 2]).b.mu, 10);
    expect(ratingOf(Q_A)!.losses).toBe(1);
    expect(ratingOf(Q_B)!.losses).toBe(1);
    const r = allRatings();
    recomputeSeasonRatings(db, 1);
    expect(allRatings()).toEqual(r);
  });

  it('decided, quitters on both teams: the leader wins, the rest rated normally, BOTH quitters lose', async () => {
    const id = newMatch();
    // Q_A on the leading team a, Q_B on the trailing team b.
    expect(await handleAbandon(deps(status('a', [Q_B])), TOKEN, Q_A)).toBe(id);
    expect(completeMatch(db, id, dumpFor(id, 'a'))).toBe(true);
    const normal = fresh4v4([1, 2]);
    for (const p of IDS.filter((x) => x !== Q_A && x !== Q_B)) {
      expect(ratingOf(p)!.mu).toBeCloseTo((IDS.indexOf(p) < 4 ? normal.a : normal.b).mu, 10);
    }
    expect(ratingOf(Q_A)!.mu).toBeCloseTo(fresh4v4([2, 1]).a.mu, 10);
    expect(ratingOf(Q_B)!.mu).toBeCloseTo(normal.b.mu, 10);
    expect(ratingOf(Q_A)).toMatchObject({ wins: 0, losses: 1 });
    expect(ratingOf(Q_B)).toMatchObject({ wins: 0, losses: 1 });
  });

  it('one quits a decided match, a second is only named by the dump after it ended: both lose, both banned', async () => {
    const id = newMatch();
    const events: AdminEvent[] = [];
    const off = subscribeAdminEvents((e) => events.push(e));
    expect(await handleAbandon(deps(status('a')), TOKEN, Q_A)).toBe(id);
    // The plugin ended the match; its dump names a second quitter (their
    // ABANDON line raced the end and never reached the site).
    const dump = { ...dumpFor(id, 'a'), abandoners: [Q_A, IDS[3]] };
    expect(completeMatch(db, id, dump)).toBe(true);
    off();
    expect(db.prepare('SELECT player_id, decided FROM match_abandons WHERE match_id = ? ORDER BY player_id').all(id))
      .toEqual([{ player_id: Q_A, decided: 'a' }, { player_id: IDS[3], decided: 'a' }]);
    expect(db.prepare('SELECT COUNT(*) AS n FROM bans WHERE reason = ?').get(`Abandoned match #${id}`)).toEqual({ n: 2 });
    expect(events.filter((e) => e.kind === 'abandon').map((e) => (e as { steamid: string }).steamid)).toEqual([Q_A, IDS[3]]);
    const lost = fresh4v4([2, 1]).a;
    for (const q of [Q_A, IDS[3]]) {
      expect(ratingOf(q)!.mu).toBeCloseTo(lost.mu, 10);
      expect(ratingOf(q)).toMatchObject({ wins: 0, losses: 1 });
    }
    expect(ratingOf(IDS[0])).toMatchObject({ wins: 1, losses: 0 });
    // A late line for either quitter after completion does nothing.
    expect(await handleAbandon(deps(status('a', [IDS[3]])), TOKEN, IDS[3])).toBeNull();
    const r = allRatings();
    recomputeSeasonRatings(db, 1);
    expect(allRatings()).toEqual(r);
  });

  it('a second quitter whose line arrives while a decided match is still being collected is added and the end retried', async () => {
    const id = newMatch();
    await handleAbandon(deps(status('b')), TOKEN, Q_A);
    expect(await handleAbandon(deps(status(null, [Q_A])), TOKEN, IDS[2])).toBe(id);
    expect(db.prepare('SELECT player_id, decided FROM match_abandons WHERE match_id = ? ORDER BY player_id').all(id))
      .toEqual([{ player_id: Q_A, decided: 'b' }, { player_id: IDS[2], decided: 'b' }]);
    expect(ended.map((e) => e.steamid)).toEqual([Q_A, IDS[2]]);
  });

  it('a dump naming quitters on a match nobody abandoned (or an undecided one) adds nothing', () => {
    const id = newMatch();
    completeMatch(db, id, { ...dumpFor(id, 'a'), abandoners: [Q_A] });
    expect(db.prepare('SELECT COUNT(*) AS n FROM match_abandons').get()).toEqual({ n: 0 });
    expect(ratingOf(Q_A)).toMatchObject({ wins: 1, losses: 0 });
  });

  it('restore is per quitter: restoring one leaves the other\'s loss, and a recompute keeps it that way', async () => {
    const id = newMatch();
    await handleAbandon(deps(status(null, [IDS[2]])), TOKEN, Q_A);
    expect(restoreAbandonRating(db, id, null, IDS[0], 'x')).toMatchObject({ ok: false, status: 400 });
    expect(restoreAbandonRating(db, id, Q_A, IDS[0], 'crash').ok).toBe(true);
    expect(ratingOf(Q_A)).toMatchObject({ wins: 0, losses: 0 });
    expect(ratingOf(Q_A)!.mu).toBeCloseTo(rating().mu, 10);
    expect(ratingOf(IDS[2])!.losses).toBe(1);
    // IDS[2]'s loss is unchanged by the restore: both were judged from the
    // same pre-match ratings.
    expect(ratingOf(IDS[2])!.mu).toBeCloseTo(fresh4v4([2, 1]).a.mu, 10);
    recomputeSeasonRatings(db, 1);
    expect(ratingOf(Q_A)!.losses).toBe(0);
    expect(ratingOf(IDS[2])!.losses).toBe(1);
  });
});

describe('quitterLoss', () => {
  it('equals the normal update when the quitter\'s team lost anyway', () => {
    const before = new Map(IDS.map((id) => [id, { mu: 25, sigma: 25 / 3 }]));
    const a = IDS.slice(0, 4), b = IDS.slice(4);
    const [na] = rate([a.map((id) => rating(before.get(id)!)), b.map((id) => rating(before.get(id)!))], { rank: [2, 1] });
    expect(quitterLoss(a, b, before, Q_A, 'a').mu).toBeCloseTo(na[1].mu, 10);
  });
});

describe('wording', () => {
  it('the Discord result card says decided and who abandoned', () => {
    const p = renderResult({
      matchId: 9, campaignName: 'Dead Air', publicUrl: 'https://x', scoreA: 3800, scoreB: 200, winner: 'a',
      abandonedBy: 'Quitter', teamA: [], teamB: [],
    });
    expect(p.embeds[0]!.description).toContain('Team A wins (decided, Quitter abandoned)');
  });

  it('the dump parser reads past abandon= on END and collects ABANDON lines', () => {
    const body = 'DUMP match=5 skilldetect=0\nMAP map=m1 a=900 b=100\nABANDON steamid=76561199000000001\nABANDON steamid=76561199000000006\nEND winner=a a=900 b=100 abandon=76561199000000001';
    expect(parseDump(body)).toMatchObject({ matchId: 5, winner: 'a', forfeit: null, abandoners: [Q_A, Q_B] });
    expect(parseDump('DUMP match=5 skilldetect=0\nABANDON steamid=nope\nEND winner=a a=1 b=0')).toBeNull();
  });
  it('the Discord card names every quitter', () => {
    const p = renderResult({
      matchId: 9, campaignName: 'Dead Air', publicUrl: 'https://x', scoreA: 3800, scoreB: 200, winner: 'a',
      abandonedBy: 'p1 and p6', teamA: [], teamB: [],
    });
    expect(p.embeds[0]!.description).toContain('Team A wins (decided, p1 and p6 abandoned)');
  });
});

describe('restore route', () => {
  let app: FastifyInstance;
  beforeEach(async () => {
    app = await buildServer({ config: loadConfig({}), db, orchestrator: stubOrchestrator(), serverCleaner: async () => {}, serverExec: async () => {} });
    db.prepare('UPDATE players SET is_admin = 1 WHERE steamid = ?').run(IDS[0]);
  });
  afterEach(async () => { await app.close(); });

  it('is admin only, needs a reason, restores, audits against the player, and the match page names the quitter', async () => {
    const id = newMatch();
    await handleAbandon(deps(status('a')), TOKEN, Q_A);
    completeMatch(db, id, dumpFor(id, 'a'));
    const url = `/api/admin/matches/${id}/restore-abandon-rating`;
    db.prepare('UPDATE players SET is_mod = 1 WHERE steamid = ?').run(IDS[7]);
    expect((await app.inject({ method: 'POST', url, cookies: authedCookie(app, db, IDS[7]), payload: { reason: 'x' } })).statusCode).toBe(403);
    const admin = authedCookie(app, db, IDS[0]);
    expect((await app.inject({ method: 'POST', url, cookies: admin, payload: {} })).statusCode).toBe(400);
    expect((await app.inject({ method: 'POST', url, cookies: admin, payload: { reason: 'crash' } })).statusCode).toBe(200);
    expect(ratingOf(Q_A)).toMatchObject({ wins: 1, losses: 0 });
    expect(db.prepare("SELECT admin_id, target, detail FROM admin_actions WHERE action = 'restore_abandon_rating'").get())
      .toEqual({ admin_id: IDS[0], target: Q_A, detail: JSON.stringify({ matchId: id, reason: 'crash' }) });
    expect((await app.inject({ method: 'POST', url, cookies: admin, payload: { reason: 'crash' } })).statusCode).toBe(409);

    const page = (await app.inject({ method: 'GET', url: `/api/matches/${id}` })).json();
    expect(page.match.abandonedBy).toBe('p1');
    const list = (await app.inject({ method: 'GET', url: '/api/matches' })).json();
    expect(list.matches[0]).toMatchObject({ id, abandonedBy: 'p1' });
    const overview = (await app.inject({ method: 'GET', url: '/api/admin/overview', cookies: admin })).json();
    expect(overview.recent[0].abandons).toEqual([expect.objectContaining({ matchId: id, steamid: Q_A, name: 'p1', decided: 'a', restoreReason: 'crash' })]);
  });
});
