import { describe, it, expect } from 'vitest';
import * as D from '../src/events/drafts.js';
import * as E from '../src/events/events.js';
import { signupFacts } from '../src/events/draftFacts.js';
import { ADMIN, NOW } from './eventFixture.js';
import { P, draftFixture, type DraftFixture } from './draftFixture.js';

const must = <T>(r: { ok: true; value: T } | { ok: false; error: string }): T => {
  if (!r.ok) throw new Error(`expected ok, got ${r.error}`);
  return r.value;
};
const err = (r: { ok: boolean; error?: string }) => (r.ok ? null : r.error);
const LATER = new Date(NOW.getTime() + 3_600_000);

/** All 21 players signed up a second apart, in P order, with signups closed. */
function closed(o: { close?: boolean } = {}): DraftFixture {
  const f = draftFixture();
  P.forEach((s, i) => must(D.signUp(f.db, { eventId: f.eventId, steamid: s, captainPref: i < 3 ? 'want' : 'willing', note: null, now: new Date(NOW.getTime() + i * 1000) })));
  if (o.close !== false) must(D.closeSignups(f.db, { eventId: f.eventId, actor: ADMIN, now: NOW }));
  return f;
}
const roles = (f: DraftFixture) => {
  const all = D.activeSignups(f.db, f.eventId);
  const of = (r: string) => all.filter((s) => s.role === r).map((s) => s.steamid);
  return { captain: of('captain'), pool: of('pool'), bench: of('bench'), manual: all.filter((s) => s.role_manual === 1).map((s) => s.steamid) };
};
const cap = (f: DraftFixture, s: string, captain = true) => D.setCaptain(f.db, { eventId: f.eventId, steamid: s, captain, actor: ADMIN, now: LATER });
const logs = (f: DraftFixture, action: string) =>
  (f.db.prepare('SELECT detail FROM event_log WHERE action = ? ORDER BY id').all(action) as { detail: string }[]).map((r) => JSON.parse(r.detail));
const without = (xs: string[], out: string[]) => xs.filter((x) => !out.includes(x));

describe('the default cut on close', () => {
  it('sets 5 teams and 15 pool / 6 bench with no captains, which needs captains to publish', () => {
    const f = closed();
    expect(E.getEvent(f.db, f.eventId)!.draft_teams).toBe(5);
    const r = roles(f);
    expect(r.captain).toEqual([]);
    expect(r.pool).toEqual(P.slice(0, 15));
    expect(r.bench).toEqual(P.slice(15));
    expect(D.cutState(f.db, f.eventId, LATER).problems).toEqual(['too_few_captains']);
  });
});

describe('setCaptain and setDraftTeams', () => {
  it('five captains leave 15 pool (the first 15 non-captains), 1 bench, and a publishable cut', () => {
    const f = closed();
    const captains = [P[2], P[5], P[8], P[11], P[20]];
    for (const s of captains) must(cap(f, s));
    const r = roles(f);
    expect(r.captain).toEqual(captains);
    const rest = without(P, captains);
    expect(r.pool).toEqual(rest.slice(0, 15));
    expect(r.bench).toEqual(rest.slice(15));
    expect(r.bench).toHaveLength(1);
    expect(D.cutState(f.db, f.eventId, LATER).problems).toEqual([]);
    expect(logs(f, 'draft_captain_set')).toHaveLength(5);
    expect(logs(f, 'draft_captain_set')[0]).toEqual({ steamid: P[2], captain: true });
    must(cap(f, P[20], false));
    expect(roles(f).captain).toEqual(captains.slice(0, 4));
    expect(err(cap(f, '76561199000000999'))).toBe('not_signed_up');
  });

  it('a swap moves both and marks them manual; a team-count change recomputes and clears it', () => {
    const f = closed();
    for (const s of [P[0], P[1], P[2], P[3], P[4]]) must(cap(f, s));
    expect(roles(f).bench).toEqual([P[20]]);
    must(D.swapPoolBench(f.db, { eventId: f.eventId, poolSteamid: P[5], benchSteamid: P[20], actor: ADMIN, now: LATER }));
    let r = roles(f);
    expect(r.pool).toContain(P[20]);
    expect(r.bench).toEqual([P[5]]);
    expect(r.manual.sort()).toEqual([P[5], P[20]].sort());
    expect(logs(f, 'draft_swap')).toEqual([{ toBench: P[5], toPool: P[20] }]);
    expect(err(D.swapPoolBench(f.db, { eventId: f.eventId, poolSteamid: P[5], benchSteamid: P[20], actor: ADMIN, now: LATER }))).toBe('bad_swap');
    expect(err(D.swapPoolBench(f.db, { eventId: f.eventId, poolSteamid: P[0], benchSteamid: P[5], actor: ADMIN, now: LATER }))).toBe('bad_swap');

    must(D.setDraftTeams(f.db, { eventId: f.eventId, teams: 4, actor: ADMIN, now: LATER }));
    expect(E.getEvent(f.db, f.eventId)!.draft_teams).toBe(4);
    r = roles(f);
    expect(r.captain).toEqual(P.slice(0, 5));
    expect(r.pool).toEqual(P.slice(5, 17));
    expect(r.bench).toEqual(P.slice(17));
    expect(r.manual).toEqual([]);
    expect(D.cutState(f.db, f.eventId, LATER).problems).toEqual(['too_many_captains']);
    expect(logs(f, 'draft_teams_set')).toEqual([{ teams: 4, from: 5 }]);
  });

  it('refuses more teams than one per four signups, and fewer than 2', () => {
    const f = closed();
    expect(err(D.setDraftTeams(f.db, { eventId: f.eventId, teams: 6, actor: ADMIN, now: LATER }))).toBe('bad_team_count');
    expect(err(D.setDraftTeams(f.db, { eventId: f.eventId, teams: 1, actor: ADMIN, now: LATER }))).toBe('bad_team_count');
    expect(err(D.setDraftTeams(f.db, { eventId: f.eventId, teams: 2.5, actor: ADMIN, now: LATER }))).toBe('bad_team_count');
    expect(E.getEvent(f.db, f.eventId)!.draft_teams).toBe(5);
  });

  it('refuses every cut mutation before close with not_closed', () => {
    const f = closed({ close: false });
    expect(err(D.setDraftTeams(f.db, { eventId: f.eventId, teams: 4, actor: ADMIN, now: LATER }))).toBe('not_closed');
    expect(err(cap(f, P[0]))).toBe('not_closed');
    expect(err(D.swapPoolBench(f.db, { eventId: f.eventId, poolSteamid: P[0], benchSteamid: P[20], actor: ADMIN, now: LATER }))).toBe('not_closed');
    expect(err(D.publishCut(f.db, { eventId: f.eventId, actor: ADMIN, now: LATER }))).toBe('not_closed');
  });
});

describe('publishCut', () => {
  const ready = () => {
    const f = closed();
    for (const s of [P[0], P[1], P[2], P[3], P[4]]) must(cap(f, s));
    return f;
  };

  it('stamps cut_at, returns the three lists, logs once, and freezes the cut', () => {
    const f = ready();
    f.db.prepare('UPDATE events SET offers_on = 1 WHERE id = ?').run(f.eventId);
    f.db.prepare("INSERT INTO draft_captain_offers (event_id, steamid, offered_at, expires_at) VALUES (?, ?, ?, ?)").run(f.eventId, P[9], NOW.toISOString(), LATER.toISOString());
    const before = (f.db.prepare('SELECT COUNT(*) AS n FROM event_log').get() as { n: number }).n;
    const cut = must(D.publishCut(f.db, { eventId: f.eventId, actor: ADMIN, now: LATER }));
    expect(cut).toEqual({ captains: P.slice(0, 5), pool: P.slice(5, 20), bench: [P[20]] });
    const ev = E.getEvent(f.db, f.eventId)!;
    expect(ev.cut_at).toBe(LATER.toISOString());
    expect(ev.offers_on).toBe(0);
    expect(f.db.prepare('SELECT answer, answered_at FROM draft_captain_offers').get()).toEqual({ answer: 'stopped', answered_at: LATER.toISOString() });
    expect((f.db.prepare('SELECT COUNT(*) AS n FROM event_log').get() as { n: number }).n).toBe(before + 1);
    expect(logs(f, 'draft_cut_published')).toEqual([{ captains: 5, pool: 15, bench: 1 }]);
    expect(err(D.publishCut(f.db, { eventId: f.eventId, actor: ADMIN, now: LATER }))).toBe('cut_published');
    expect(err(D.setDraftTeams(f.db, { eventId: f.eventId, teams: 4, actor: ADMIN, now: LATER }))).toBe('cut_published');
    expect(err(cap(f, P[5]))).toBe('cut_published');
    expect(err(D.swapPoolBench(f.db, { eventId: f.eventId, poolSteamid: P[5], benchSteamid: P[20], actor: ADMIN, now: LATER }))).toBe('cut_published');
    expect(err(D.removeSignup(f.db, { eventId: f.eventId, steamid: P[5], reason: 'removed', actor: ADMIN, now: LATER }))).toBe('cut_published');
  });

  it('refuses a stale cut: a pool player removed just before publish gives cut_changed with pool_size', () => {
    const f = ready();
    must(D.removeSignup(f.db, { eventId: f.eventId, steamid: P[7], reason: 'removed', actor: ADMIN, now: LATER }));
    const r = D.publishCut(f.db, { eventId: f.eventId, actor: ADMIN, now: LATER });
    expect(r.ok).toBe(false);
    expect(r.ok ? null : r.error).toBe('cut_changed');
    if (r.ok || !('cut' in r)) throw new Error('expected the cut detail');
    expect(r.cut).toEqual({ problems: ['pool_size'], teams: 5, maxTeams: 5, active: 20, captains: 5, pool: 14, poolNeeded: 15, bench: 1, unassigned: 0, ineligible: [] });
    expect(E.getEvent(f.db, f.eventId)!.cut_at).toBeNull();
    expect(logs(f, 'draft_cut_published')).toEqual([]);
  });

  it('refuses while a signup became ineligible, naming them', () => {
    const f = ready();
    f.db.prepare('UPDATE matches SET voided_at = ? WHERE id IN (SELECT match_id FROM match_players WHERE player_id = ?)').run(NOW.toISOString(), P[6]);
    const r = D.publishCut(f.db, { eventId: f.eventId, actor: ADMIN, now: LATER });
    expect(r.ok).toBe(false);
    expect(r.ok ? null : r.error).toBe('cut_changed');
    if (r.ok || !('cut' in r)) throw new Error('expected the cut detail');
    expect(r.cut.problems).toEqual(['ineligible']);
    expect(r.cut.ineligible).toEqual([{ steamid: P[6], problems: ['0 of 5 completed PUGs'] }]);
    expect(E.getEvent(f.db, f.eventId)!.cut_at).toBeNull();
  });
});

describe('removeSignup and the event status', () => {
  it('refuses a removal from a cancelled or finished draft with wrong_status, and DMs nobody', () => {
    const f = closed();
    must(E.cancelEvent(f.db, { eventId: f.eventId, by: ADMIN, reason: 'Not enough people', now: LATER }));
    expect(err(D.removeSignup(f.db, { eventId: f.eventId, steamid: P[0], reason: 'removed', actor: ADMIN, now: LATER }))).toBe('wrong_status');
    expect(err(D.setDraftTeams(f.db, { eventId: f.eventId, teams: 4, actor: ADMIN, now: LATER }))).toBe('wrong_status');
    const g = closed();
    g.db.prepare("UPDATE events SET status = 'finished' WHERE id = ?").run(g.eventId);
    expect(err(D.removeSignup(g.db, { eventId: g.eventId, steamid: P[0], reason: 'removed', actor: ADMIN, now: LATER }))).toBe('wrong_status');
    g.db.prepare("UPDATE events SET status = 'checkin' WHERE id = ?").run(g.eventId);
    must(D.removeSignup(g.db, { eventId: g.eventId, steamid: P[0], reason: 'removed', actor: ADMIN, now: LATER }));
  });
});

describe('signupFacts', () => {
  it('gives SR, preference, role and 30-day abandons and no-shows beside each signup', () => {
    const f = closed();
    const day = 86_400_000;
    const ago = (d: number) => new Date(LATER.getTime() - d * day).toISOString();
    const ban = f.db.prepare('INSERT INTO bans (player_id, reason, created_by, created_at, expires_at, lifted_by, lifted_at) VALUES (?, ?, ?, ?, ?, ?, ?)');
    ban.run(P[1], 'Abandoned match #12', 'system', ago(3), ago(2), 'system', ago(2));
    ban.run(P[1], 'Abandoned match #13', 'system', ago(10), ago(9), ADMIN, ago(8));
    ban.run(P[1], 'Abandoned match #9', 'system', ago(40), ago(39), 'system', ago(39));
    ban.run(P[1], 'Abandoned match #14', 'system', ago(5), ago(1), ADMIN, ago(4));
    ban.run(P[1], 'Cheating', ADMIN, ago(5), ago(4), 'system', ago(4));
    const pen = f.db.prepare('INSERT INTO penalties (player_id, kind, match_id, created_at, cleared_by, cleared_at) VALUES (?, ?, NULL, ?, ?, ?)');
    pen.run(P[2], 'no_show', ago(1), null, null);
    pen.run(P[2], 'no_show', ago(29), null, null);
    pen.run(P[2], 'no_show', ago(31), null, null);
    pen.run(P[2], 'no_show', ago(2), ADMIN, ago(1));
    pen.run(P[2], 'ready_fail', ago(2), null, null);
    const facts = signupFacts(f.db, f.eventId, LATER);
    expect(facts.map((x) => x.steamid)).toEqual(P);
    expect(facts[1]).toMatchObject({ steamid: P[1], name: 'd1', sr: 1025, captainPref: 'want', note: null, role: 'pool', manual: false, abandons30d: 2, noShows30d: 0, problems: [] });
    expect(facts[2]).toMatchObject({ abandons30d: 0, noShows30d: 2 });
    expect(facts[20]).toMatchObject({ sr: 1500, role: 'bench', captainPref: 'willing' });
    expect(facts[0]!.signedUpAt).toBe(NOW.toISOString());
  });
});
