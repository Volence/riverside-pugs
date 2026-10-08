import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config.js';
import { buildServer } from '../src/server.js';
import { adminEventRoutes } from '../src/routes/adminEvents.js';
import type { Notifier } from '../src/notify/notify.js';
import { authedCookie, stubOrchestrator } from './helpers.js';
import * as D from '../src/events/drafts.js';
import * as E from '../src/events/events.js';
import * as N from '../src/events/entries.js';
import { balanceAroundCaptains } from '../src/events/draftBalance.js';
import { draftFairness } from '../src/events/draftFairness.js';
import { eventView } from '../src/events/views.js';
import { EVENT_ERRORS } from '../src/events/validate.js';
import { ADMIN, NOW } from './eventFixture.js';
import { P, cutDraft, type DraftFixture } from './draftFixture.js';

const must = <T>(r: { ok: true; value: T } | { ok: false; error: string }): T => {
  if (!r.ok) throw new Error(`expected ok, got ${r.error}`);
  return r.value;
};
const err = (r: { ok: boolean; error?: string }) => (r.ok ? null : r.error);
const LATER = new Date(NOW.getTime() + 3_600_000);

const cutFixture = (o: { publish?: boolean; startsAt?: string; now?: Date } = {}): DraftFixture => cutDraft(o);
const CAPTAINS = P.slice(16, 21);
const POOL = P.slice(0, 15);
const BENCH = P[15]!;

const teamOf = (f: DraftFixture) => {
  const rows = f.db.prepare('SELECT steamid, draft_team FROM draft_signups WHERE event_id = ? AND withdrawn_at IS NULL').all(f.eventId) as { steamid: string; draft_team: number | null }[];
  return new Map(rows.map((r) => [r.steamid, r.draft_team]));
};
const signupId = (f: DraftFixture, s: string) => D.signupOf(f.db, f.eventId, s)!.id;
const mode = (f: DraftFixture, m: 'auto' | 'live' | null) => D.chooseTeamMode(f.db, { eventId: f.eventId, mode: m, actor: ADMIN, now: LATER });
const balance = (f: DraftFixture) => D.autoBalance(f.db, { eventId: f.eventId, actor: ADMIN, now: LATER });
const move = (f: DraftFixture, a: string, b: string) => D.moveDraftPlayers(f.db, { eventId: f.eventId, a, b, actor: ADMIN, now: LATER });
const logs = (f: DraftFixture, action: string) =>
  (f.db.prepare('SELECT actor, detail FROM event_log WHERE action = ? ORDER BY id').all(action) as { actor: string; detail: string }[])
    .map((r) => ({ actor: r.actor, ...JSON.parse(r.detail) }));

describe('choosing the method and auto-balance', () => {
  it('writes every pool player the team balanceAroundCaptains gives, and nothing for captains or bench', () => {
    const f = cutFixture();
    must(mode(f, 'auto'));
    expect(E.getEvent(f.db, f.eventId)!.team_mode).toBe('auto');
    expect(must(balance(f))).toEqual({ teams: 5 });
    const sr = (s: string) => 1000 + 25 * P.indexOf(s);
    const want = balanceAroundCaptains(
      CAPTAINS.map((s) => ({ steamid: s, sr: sr(s), order: P.indexOf(s) })),
      POOL.map((s) => ({ steamid: s, sr: sr(s), order: P.indexOf(s) })),
    );
    const teams = teamOf(f);
    for (const t of want) for (const p of t.players) expect(teams.get(p), p).toBe(signupId(f, t.captain));
    for (const c of CAPTAINS) expect(teams.get(c)).toBeNull();
    expect(teams.get(BENCH)).toBeNull();
    const made = D.draftTeamsOf(f.db, f.eventId)!;
    expect(made.map((t) => t.captain.steamid)).toEqual(CAPTAINS);
    for (const t of made) {
      expect(t.players).toHaveLength(3);
      expect(t.players.map((p) => p.steamid).sort()).toEqual([...want.find((w) => w.captain === t.captain.steamid)!.players].sort());
    }
    expect(logs(f, 'draft_teams_balanced')).toEqual([{ actor: ADMIN, teams: 5 }]);
    expect(logs(f, 'draft_team_mode')).toEqual([{ actor: ADMIN, mode: 'auto', from: null }]);
  });

  it('balances again from scratch, dropping hand moves', () => {
    const f = cutFixture();
    must(mode(f, 'auto'));
    must(balance(f));
    const first = teamOf(f);
    const [t0, t1] = D.draftTeamsOf(f.db, f.eventId)!;
    must(move(f, t0!.players[0]!.steamid, t1!.players[0]!.steamid));
    expect(teamOf(f)).not.toEqual(first);
    must(balance(f));
    expect(teamOf(f)).toEqual(first);
  });

  it('refuses auto-balance before Auto-balance is chosen', () => {
    const f = cutFixture();
    expect(err(balance(f))).toBe('not_auto_mode');
    expect(D.draftTeamsOf(f.db, f.eventId)).toBeNull();
  });

  it('accepts the live method (plan D2b1) and still refuses an unknown one', () => {
    const f = cutFixture();
    must(mode(f, 'live'));
    expect(E.getEvent(f.db, f.eventId)!.team_mode).toBe('live');
    expect(err(D.chooseTeamMode(f.db, { eventId: f.eventId, mode: 'snake' as 'auto', actor: ADMIN, now: LATER }))).toBe('bad_team_mode');
  });

  it('resets the method and clears the assignment', () => {
    const f = cutFixture();
    must(mode(f, 'auto'));
    must(balance(f));
    must(mode(f, null));
    expect(E.getEvent(f.db, f.eventId)!.team_mode).toBeNull();
    expect([...teamOf(f).values()].every((t) => t === null)).toBe(true);
    expect(D.draftTeamsOf(f.db, f.eventId)).toBeNull();
    expect(draftFairness(f.db, f.eventId)).toBeNull();
  });

  it('refuses every step before the cut is published', () => {
    const f = cutFixture({ publish: false });
    expect(err(mode(f, 'auto'))).toBe('cut_not_published');
    f.db.prepare("UPDATE events SET team_mode = 'auto' WHERE id = ?").run(f.eventId);
    expect(err(balance(f))).toBe('cut_not_published');
    expect(err(move(f, P[0]!, P[1]!))).toBe('cut_not_published');
  });

  it('refuses every step once teams are published, and outside registration and checkin', () => {
    const f = cutFixture();
    must(mode(f, 'auto'));
    must(balance(f));
    const [t0, t1] = D.draftTeamsOf(f.db, f.eventId)!;
    f.db.prepare('UPDATE events SET teams_made_at = ? WHERE id = ?').run(LATER.toISOString(), f.eventId);
    expect(err(mode(f, null))).toBe('teams_made');
    expect(err(balance(f))).toBe('teams_made');
    expect(err(move(f, t0!.players[0]!.steamid, t1!.players[0]!.steamid))).toBe('teams_made');
    f.db.prepare("UPDATE events SET teams_made_at = NULL, status = 'cancelled' WHERE id = ?").run(f.eventId);
    expect(err(mode(f, null))).toBe('wrong_status');
    expect(err(balance(f))).toBe('wrong_status');
  });

  it('refuses a team event', () => {
    const f = cutFixture();
    f.db.prepare("UPDATE events SET entry_kind = 'team' WHERE id = ?").run(f.eventId);
    expect(err(mode(f, 'auto'))).toBe('not_draft');
  });
});

describe('staff moves', () => {
  it('swaps two pool players on different teams', () => {
    const f = cutFixture();
    must(mode(f, 'auto'));
    must(balance(f));
    const [t0, t1] = D.draftTeamsOf(f.db, f.eventId)!;
    const a = t0!.players[0]!.steamid, b = t1!.players[0]!.steamid;
    must(move(f, a, b));
    const teams = teamOf(f);
    expect(teams.get(a)).toBe(t1!.captain.id);
    expect(teams.get(b)).toBe(t0!.captain.id);
    const after = D.draftTeamsOf(f.db, f.eventId)!;
    expect(after.every((t) => t.players.length === 3)).toBe(true);
    expect(logs(f, 'draft_teams_swapped')).toEqual([{ actor: ADMIN, a, b }]);
  });

  it('refuses two players on one team, a captain, a bench player and a stranger', () => {
    const f = cutFixture();
    must(mode(f, 'auto'));
    must(balance(f));
    const [t0, t1] = D.draftTeamsOf(f.db, f.eventId)!;
    const before = teamOf(f);
    expect(err(move(f, t0!.players[0]!.steamid, t0!.players[1]!.steamid))).toBe('bad_move');
    expect(err(move(f, t0!.players[0]!.steamid, t1!.captain.steamid))).toBe('bad_move');
    expect(err(move(f, t0!.captain.steamid, t1!.players[0]!.steamid))).toBe('bad_move');
    expect(err(move(f, t0!.players[0]!.steamid, BENCH))).toBe('bad_move');
    expect(err(move(f, t0!.players[0]!.steamid, ADMIN))).toBe('bad_move');
    expect(teamOf(f)).toEqual(before);
  });

  it('refuses a move before any team is made', () => {
    const f = cutFixture();
    must(mode(f, 'auto'));
    expect(err(move(f, P[0]!, P[1]!))).toBe('bad_move');
  });
});

describe('the fairness readout', () => {
  it('gives each team its SR, the spread and one forecast per pair', () => {
    const f = cutFixture();
    expect(draftFairness(f.db, f.eventId)).toBeNull();
    must(mode(f, 'auto'));
    must(balance(f));
    const fair = draftFairness(f.db, f.eventId)!;
    expect(fair.teams.map((t) => t.captain)).toEqual(CAPTAINS);
    const made = D.draftTeamsOf(f.db, f.eventId)!;
    fair.teams.forEach((t, i) => {
      const four = [made[i]!.captain, ...made[i]!.players].map((s) => s.steamid);
      const total = four.reduce((n, s) => n + 1000 + 25 * P.indexOf(s), 0);
      expect(t.totalSr).toBe(total);
      expect(t.avgSr).toBe(total / 4);
      expect(t.names).toEqual(four.map((s) => `d${P.indexOf(s)}`));
      expect(t.captainName).toBe(`d${P.indexOf(t.captain)}`);
    });
    const avgs = fair.teams.map((t) => t.avgSr);
    expect(fair.spread).toBe(Math.max(...avgs) - Math.min(...avgs));
    expect(fair.forecasts).toHaveLength(10);
    expect(fair.forecasts.map((x) => [x.a, x.b])).toEqual([[0, 1], [0, 2], [0, 3], [0, 4], [1, 2], [1, 3], [1, 4], [2, 3], [2, 4], [3, 4]]);
    for (const x of fair.forecasts) {
      expect(x.winA).toBeGreaterThan(0);
      expect(x.winA).toBeLessThan(1);
    }
  });

  it('forecasts an unrated player at the defaults, the stronger side ahead', () => {
    const f = cutFixture();
    must(mode(f, 'auto'));
    must(balance(f));
    const before = draftFairness(f.db, f.eventId)!;
    const made = D.draftTeamsOf(f.db, f.eventId)!;
    // Unrated: openskill's mu 25 is far above every fixture player's (12 to 14).
    f.db.prepare('DELETE FROM player_ratings WHERE player_id = ?').run(made[0]!.players[0]!.steamid);
    const after = draftFairness(f.db, f.eventId)!;
    expect(after.forecasts[0]!.winA).toBeGreaterThan(before.forecasts[0]!.winA);
    expect(f.db.prepare('SELECT COUNT(*) AS n FROM player_ratings WHERE player_id = ?').get(made[0]!.players[0]!.steamid)).toEqual({ n: 0 });
  });
});

describe('the Make teams desk over HTTP', () => {
  let app: FastifyInstance;
  let f: DraftFixture;
  const MOD = P[15]!;
  const cookies: Record<string, Record<string, string>> = {};
  beforeEach(async () => {
    f = cutFixture({ startsAt: new Date(Date.now() + 9 * 86_400_000).toISOString(), now: new Date() });
    f.db.prepare('UPDATE players SET is_mod = 1 WHERE steamid = ?').run(MOD);
    app = await buildServer({
      config: { ...loadConfig({}), communityDir: mkdtempSync(join(tmpdir(), 'draft-teams-')) },
      db: f.db, orchestrator: stubOrchestrator(), serverCleaner: async () => {}, serverExec: async () => {},
    });
    for (const s of [P[0]!, MOD, ADMIN]) cookies[s] = authedCookie(app, f.db, s);
  });
  afterEach(async () => { await app.close(); });
  const get = (url: string, as?: string) => app.inject({ method: 'GET', url, cookies: as ? cookies[as] : undefined });
  const post = (url: string, as: string, body: object = {}) => app.inject({ method: 'POST', url, cookies: cookies[as], payload: body });
  const base = () => `/api/admin/events/${f.eventId}/draft`;
  const audits = (action: string) => (f.db.prepare('SELECT COUNT(*) AS n FROM admin_actions WHERE action = ?').get(action) as { n: number }).n;

  it('lets a mod read the teams and refuses a mod every write', async () => {
    const res = await get(`${base()}/teams`, MOD);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ mode: null, teamsMadeAt: null, teams: null, fairness: null });
    expect((await get(`${base()}/teams`, P[0])).statusCode).toBe(403);
    for (const [path, b] of [['mode', { mode: 'auto' }], ['balance', {}], ['move', { a: P[0], b: P[1] }]] as const) {
      expect((await post(`${base()}/${path}`, MOD, b)).statusCode, path).toBe(403);
    }
    expect(E.getEvent(f.db, f.eventId)!.team_mode).toBeNull();
  });

  it('runs Make teams as an admin, audited, and keeps it off the public page', async () => {
    expect((await post(`${base()}/mode`, ADMIN, { mode: 'nope' })).statusCode).toBe(400);
    expect((await post(`${base()}/mode`, ADMIN, { mode: 'live' })).statusCode).toBe(200);
    expect((await post(`${base()}/mode`, ADMIN, { mode: 'auto' })).statusCode).toBe(200);
    expect((await post(`${base()}/balance`, ADMIN)).statusCode).toBe(200);
    const body = (await get(`${base()}/teams`, MOD)).json();
    expect(body.mode).toBe('auto');
    expect(body.teamsMadeAt).toBeNull();
    expect(body.teams).toHaveLength(5);
    expect(body.teams[0].captain).toEqual({ steamid: P[16], name: 'd16' });
    expect(body.teams[0].players).toHaveLength(3);
    expect(Object.keys(body.teams[0].players[0]).sort()).toEqual(['name', 'sr', 'steamid']);
    expect(body.fairness.forecasts).toHaveLength(10);
    const [t0, t1] = body.teams;
    expect((await post(`${base()}/move`, ADMIN, { a: t0.players[0].steamid })).statusCode).toBe(400);
    expect((await post(`${base()}/move`, ADMIN, { a: t0.players[0].steamid, b: t0.players[1].steamid })).statusCode).toBe(409);
    expect((await post(`${base()}/move`, ADMIN, { a: t0.players[0].steamid, b: t1.players[0].steamid })).statusCode).toBe(200);
    const moved = (await get(`${base()}/teams`, ADMIN)).json();
    expect(moved.teams[1].players.map((p: { steamid: string }) => p.steamid)).toContain(t0.players[0].steamid);
    expect([audits('event_draft_mode'), audits('event_draft_balance'), audits('event_draft_move')]).toEqual([2, 1, 1]);
    for (const as of [P[0], undefined]) {
      const pub = await get(`/api/events/${f.slug}`, as);
      expect(pub.statusCode).toBe(200);
      for (const key of ['avgSr', 'totalSr', 'spread', 'winA', 'forecasts', 'draft_team', 'draftTeam']) expect(pub.body).not.toContain(key);
    }
    expect((await post(`${base()}/mode`, ADMIN, { mode: null })).statusCode).toBe(200);
    expect((await get(`${base()}/teams`, ADMIN)).json()).toMatchObject({ mode: null, teams: null, fairness: null });
  });
});

describe('publishing the teams (createDraftEntries)', () => {
  const publish = (f: DraftFixture) => N.createDraftEntries(f.db, { eventId: f.eventId, actor: ADMIN, now: LATER });
  const sr = (s: string) => 1000 + 25 * P.indexOf(s);
  /** Every row publishing could touch, to prove a refusal writes nothing. */
  const snap = (f: DraftFixture) => JSON.stringify([
    f.db.prepare('SELECT * FROM event_entries ORDER BY id').all(),
    f.db.prepare('SELECT * FROM event_entry_players ORDER BY id').all(),
    f.db.prepare('SELECT * FROM events ORDER BY id').all(),
    f.db.prepare('SELECT * FROM event_log ORDER BY id').all(),
  ]);

  it('creates one entry per captain with its four starters, seeded by average SR, and stamps teams_made_at', () => {
    const f = cutDraft({ balance: true });
    const made = D.draftTeamsOf(f.db, f.eventId)!;
    const { entries } = must(publish(f));
    expect(entries).toHaveLength(5);
    const rows = N.entriesOf(f.db, f.eventId);
    expect(rows.map((e) => e.id)).toEqual(entries);
    expect(rows.map((e) => e.captain_steamid)).toEqual(CAPTAINS);
    for (const [i, e] of rows.entries()) {
      const t = made[i]!;
      expect(e).toMatchObject({
        team_id: null, name: `Team d${P.indexOf(t.captain.steamid)}`, tag: '', logo_key: null, registered_by: ADMIN,
        created_at: LATER.toISOString(), status: 'checked_in', checked_in_at: LATER.toISOString(), checked_in_by: ADMIN,
      });
      expect(N.rosterOf(f.db, e.id)).toEqual({ starters: [t.captain.steamid, ...t.players.map((p) => p.steamid)], subs: [], coach: null });
    }
    // Seeds 1 to 5 by average starter SR, highest first, ties in captain order.
    const avg = (e: N.EntryRow) => N.rosterOf(f.db, e.id).starters.reduce((n, s) => n + sr(s), 0) / 4;
    const want = [...rows].sort((a, b) => avg(b) - avg(a) || a.id - b.id).map((e) => e.id);
    expect([...rows].sort((a, b) => a.seed! - b.seed!).map((e) => e.id)).toEqual(want);
    expect(rows.map((e) => e.seed).sort()).toEqual([1, 2, 3, 4, 5]);
    expect(E.getEvent(f.db, f.eventId)!.teams_made_at).toBe(LATER.toISOString());
    expect(logs(f, 'draft_teams_published')).toEqual([{ actor: ADMIN, entries }]);
    // The bench stays a draft_signups bench, on no entry.
    expect(N.entryOfPlayer(f.db, f.eventId, BENCH)).toBeUndefined();
    expect(D.signupOf(f.db, f.eventId, BENCH)!.role).toBe('bench');
  });

  it("gives a team event's final status: registered when check-in is off", () => {
    const f = cutDraft({ balance: true });
    f.db.prepare('UPDATE events SET checkin_json = ? WHERE id = ?').run(JSON.stringify({ enabled: false, opensMinutes: 60, closesMinutes: 15 }), f.eventId);
    must(publish(f));
    for (const e of N.entriesOf(f.db, f.eventId)) expect(e).toMatchObject({ status: 'registered', checked_in_at: null, checked_in_by: null });
  });

  it('cuts a long captain name to 24 characters, with no trailing space', () => {
    const f = cutDraft({ balance: true });
    f.db.prepare('UPDATE players SET name = ? WHERE steamid = ?').run('Abcdefghijklmnopqr stuv', CAPTAINS[0]);
    f.db.prepare('UPDATE players SET name = ? WHERE steamid = ?').run('Abcdefghijklmnopqrstuvwxyz', CAPTAINS[1]);
    must(publish(f));
    expect(N.entriesOf(f.db, f.eventId).slice(0, 2).map((e) => e.name)).toEqual(['Team Abcdefghijklmnopqr', 'Team Abcdefghijklmnopqrs']);
  });

  it('keeps default names unique in the event by their team-name key, suffixing a clash within 24 characters', () => {
    const f = cutDraft({ balance: true });
    const name = f.db.prepare('UPDATE players SET name = ? WHERE steamid = ?');
    name.run('Same', CAPTAINS[0]);
    name.run('Same', CAPTAINS[1]);
    name.run('SAME', CAPTAINS[2]);
    name.run('Abcdefghijklmnopqrstuvwxyz', CAPTAINS[3]);
    name.run('Abcdefghijklmnopqrstuvwxyz', CAPTAINS[4]);
    must(publish(f));
    expect(N.entriesOf(f.db, f.eventId).map((e) => e.name))
      .toEqual(['Team Same', 'Team Same 2', 'Team SAME 3', 'Team Abcdefghijklmnopqrs', 'Team Abcdefghijklmnopq 2']);
  });

  it('falls back to "Team <seed>" when the default name fails the team name rules (slur filter)', () => {
    const f = cutDraft({ balance: true });
    f.db.prepare('UPDATE players SET name = ? WHERE steamid = ?').run('faggot', CAPTAINS[1]);
    must(publish(f));
    const e = N.entriesOf(f.db, f.eventId)[1]!;
    expect(e.captain_steamid).toBe(CAPTAINS[1]);
    expect(e.name).toBe(`Team ${e.seed}`);
  });

  it('refuses a pool short of a player, or a captain gone, with teams_changed, writing nothing', () => {
    const f = cutDraft({ balance: true });
    const made = D.draftTeamsOf(f.db, f.eventId)!;
    f.db.prepare("UPDATE draft_signups SET withdrawn_at = ?, withdraw_reason = 'removed' WHERE event_id = ? AND steamid = ?")
      .run(LATER.toISOString(), f.eventId, made[0]!.players[0]!.steamid);
    const before = snap(f);
    expect(err(publish(f))).toBe('teams_changed');
    expect(snap(f)).toBe(before);
    const g = cutDraft({ balance: true });
    g.db.prepare("UPDATE draft_signups SET withdrawn_at = ?, withdraw_reason = 'removed' WHERE event_id = ? AND steamid = ?")
      .run(LATER.toISOString(), g.eventId, CAPTAINS[0]);
    const gBefore = snap(g);
    expect(err(publish(g))).toBe('teams_changed');
    expect(snap(g)).toBe(gBefore);
    // A merge-withdrawn pool player cannot be fixed by rebalancing, so the
    // sentence does not promise that it can.
    expect(EVENT_ERRORS.teams_changed.text).toBe('The teams no longer match the published cut (a team is short or a player is missing). Rebalance if a pool player is unassigned; a missing player needs staff help.');
  });

  it('refuses before teams are made, twice, outside registration and checkin, and on a team event', () => {
    const f = cutDraft();
    expect(err(publish(f))).toBe('teams_changed');
    expect(err(publish(cutDraft({ publish: false })))).toBe('cut_not_published');
    must(mode(f, 'auto'));
    must(balance(f));
    must(publish(f));
    const before = snap(f);
    expect(err(publish(f))).toBe('teams_made');
    expect(snap(f)).toBe(before);
    const g = cutDraft({ balance: true });
    g.db.prepare("UPDATE events SET status = 'cancelled' WHERE id = ?").run(g.eventId);
    expect(err(publish(g))).toBe('wrong_status');
    const h = cutDraft({ balance: true });
    h.db.prepare("UPDATE events SET entry_kind = 'team' WHERE id = ?").run(h.eventId);
    expect(err(publish(h))).toBe('not_draft');
    expect(N.entriesOf(g.db, g.eventId).length + N.entriesOf(h.db, h.eventId).length).toBe(0);
  });

  it('no team cap applies to a draft: an edit with a cap stores none, and five teams are all placed even over a stored cap', () => {
    const f = cutDraft({ balance: true });
    must(E.updateEvent(f.db, { eventId: f.eventId, by: ADMIN, fields: { teamCap: 4 }, now: LATER }));
    expect(E.getEvent(f.db, f.eventId)!.team_cap).toBeNull();
    must(publish(f));
    // A cap stored before the rule changed is ignored too.
    f.db.prepare('UPDATE events SET team_cap = 4 WHERE id = ?').run(f.eventId);
    const ev = E.getEvent(f.db, f.eventId)!;
    const place = N.placementOf(f.db, ev);
    expect(place.placed).toHaveLength(5);
    expect(place.waitlist).toEqual([]);
    const pub = eventView(f.db, ev);
    expect(pub.teamCap).toBeNull();
    expect(pub.entries).toHaveLength(5);
    expect(pub.entries.every((e) => e.waitlist === null)).toBe(true);
  });
});

describe('publishing the teams over HTTP', () => {
  let desk: FastifyInstance;
  let send: ReturnType<typeof vi.fn>;
  let f: DraftFixture;
  const MOD = P[15]!;
  beforeEach(async () => {
    f = cutDraft({ balance: true, startsAt: new Date(Date.now() + 9 * 86_400_000).toISOString(), now: new Date() });
    f.db.prepare('UPDATE players SET is_mod = 1 WHERE steamid = ?').run(MOD);
    send = vi.fn(() => 1);
    desk = Fastify();
    await desk.register(cookie, { secret: 'x'.repeat(32) });
    await desk.register(adminEventRoutes, { db: f.db, store: () => { throw new Error('no store'); }, notifier: { send } as unknown as Notifier, publicUrl: 'https://x' });
    await desk.ready();
  });
  afterEach(async () => { await desk.close(); });
  const post = (url: string, as: string) => desk.inject({ method: 'POST', url, cookies: authedCookie(desk, f.db, as), payload: {} });
  const get = (url: string, as: string) => desk.inject({ method: 'GET', url, cookies: authedCookie(desk, f.db, as) });
  const url = () => `/api/admin/events/${f.eventId}/draft/publish-teams`;

  it('refuses a mod, publishes as an admin with an audit row, and DMs all 20 starters', async () => {
    expect((await post(url(), MOD)).statusCode).toBe(403);
    expect(send).not.toHaveBeenCalled();
    const made = D.draftTeamsOf(f.db, f.eventId)!;
    const res = await post(url(), ADMIN);
    expect(res.statusCode).toBe(200);
    const entries = N.entriesOf(f.db, f.eventId).map((e) => e.id);
    expect(res.json()).toEqual({ entries });
    expect((f.db.prepare("SELECT COUNT(*) AS n FROM admin_actions WHERE action = 'event_draft_publish_teams'").get() as { n: number }).n).toBe(1);
    const link = `https://x/event/${f.slug}`;
    const name = (s: string) => `d${P.indexOf(s)}`;
    const calls = send.mock.calls.map(([to, type, payload]) => ({ to: [...(to as string[])], type, content: (payload as { content: string }).content }));
    expect(calls).toEqual(made.flatMap((t) => {
      const others = t.players.map((p) => name(p.steamid));
      const team = `Team ${name(t.captain.steamid)}`;
      return [
        { to: [t.captain.steamid], type: 'draft_team_made', content: `Your team in Draft Night is set: ${others[0]}, ${others[1]} and ${others[2]}. Name your team and upload a logo before the event starts: ${link}` },
        { to: t.players.map((p) => p.steamid), type: 'draft_team_made', content: `You are on ${team} in Draft Night, captained by ${name(t.captain.steamid)}. Your captain can rename the team before the event starts: ${link}` },
      ];
    }));
    expect(calls.flatMap((c) => c.to).sort()).toEqual([...CAPTAINS, ...POOL].sort());
    expect((await get(`/api/admin/events/${f.eventId}/draft/teams`, MOD)).json().teamsMadeAt).not.toBeNull();
  });

  it('DMs nobody when publishing is refused', async () => {
    f.db.prepare('UPDATE draft_signups SET withdrawn_at = ? WHERE event_id = ? AND steamid = ?').run(new Date().toISOString(), f.eventId, POOL[0]);
    expect((await post(url(), ADMIN)).statusCode).toBe(409);
    expect(send).not.toHaveBeenCalled();
    expect(N.entriesOf(f.db, f.eventId)).toEqual([]);
  });

  it('marks a team short of a player on the desk, so staff see why publish refuses', async () => {
    const before = (await get(`/api/admin/events/${f.eventId}/draft/teams`, MOD)).json();
    expect(before.teams.map((t: { short: boolean }) => t.short)).toEqual([false, false, false, false, false]);
    const made = D.draftTeamsOf(f.db, f.eventId)!;
    f.db.prepare('UPDATE draft_signups SET withdrawn_at = ? WHERE event_id = ? AND steamid = ?').run(new Date().toISOString(), f.eventId, made[2]!.players[0]!.steamid);
    const after = (await get(`/api/admin/events/${f.eventId}/draft/teams`, MOD)).json();
    expect(after.teams.map((t: { short: boolean }) => t.short)).toEqual([false, false, true, false, false]);
    expect(after.teams[2].players).toHaveLength(2);
  });
});
