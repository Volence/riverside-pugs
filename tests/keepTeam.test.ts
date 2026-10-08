import { describe, it, expect } from 'vitest';
import * as K from '../src/events/keepTeam.js';
import * as N from '../src/events/entries.js';
import * as T from '../src/teams/teams.js';
import { BENCH, FINISHED, capped, finishedDraft, standinFixture, type StandinFixture } from './standinFixture.js';

const H = 3_600_000;
const at = (h: number) => new Date(FINISHED.getTime() + h * H);
const must = <X>(r: { ok: true; value: X } | { ok: false; error: string }): X => {
  if (!r.ok) throw new Error(`expected ok, got ${r.error}`);
  return r.value;
};
const err = (r: { ok: boolean; error?: string }) => (r.ok ? null : r.error);
/** The first team's keep offered at FINISHED + 1 h, with its four, captain first. */
function offered(f: StandinFixture) {
  const entry = N.getEntry(f.db, f.entries[0]!)!;
  const { keepId } = must(K.offerKeep(f.db, { entryId: entry.id, now: at(1) }));
  const four = K.playersOf(K.keepOf(f.db, keepId)!);
  return { entry, keepId, captain: four[0]!, p: four.slice(1) as [string, string, string] };
}
type X = ReturnType<typeof offered>;
const start = (f: StandinFixture, x: X, over: Partial<Parameters<typeof K.startKeep>[1]> = {}) =>
  K.startKeep(f.db, { entryId: x.entry.id, steamid: x.captain, name: 'Night Owls', tag: 'OWL', now: at(2), ...over });
const answer = (f: StandinFixture, x: X, steamid: string, accept: boolean, h = 3) => K.answerKeep(f.db, { keepId: x.keepId, steamid, accept, now: at(h) });
const settle = (f: StandinFixture, x: X, h = 3) => K.settleKeep(f.db, { keepId: x.keepId, now: at(h) });
/** A settle that made the team. */
const madeOf = (r: ReturnType<typeof settle>) => {
  const v = must(r);
  if (!v.made) throw new Error(`expected a team, got ${v.closed}`);
  return v;
};

describe('offerKeep (Rulings 1 and 2)', () => {
  it('offers a finished draft team\'s captain, once, with its four, until 7 days after the finish', () => {
    const f = finishedDraft();
    const x = offered(f);
    expect(x.captain).toBe(x.entry.captain_steamid);
    expect([x.captain, ...x.p].sort()).toEqual([...N.rosterOf(f.db, x.entry.id).starters].sort());
    expect(K.keepOf(f.db, x.keepId)).toMatchObject({ status: 'offered', expires_at: at(7 * 24).toISOString(), name: null, team_id: null });
    expect(err(K.offerKeep(f.db, { entryId: x.entry.id, now: at(1) }))).toBe('keep_started');
    expect(err(K.offerKeep(f.db, { entryId: f.entries[1]!, now: at(7 * 24) }))).toBe('keep_closed');
    const g = standinFixture();
    expect(err(K.offerKeep(g.db, { entryId: g.entries[0]!, now: at(1) }))).toBe('keep_not_open');
  });
});

describe('startKeep (Ruling 4)', () => {
  it('only the captain, with a valid name and tag that are free, under the cap', () => {
    const f = finishedDraft();
    const x = offered(f);
    expect(err(start(f, x, { steamid: x.p[0] }))).toBe('not_captain');
    expect(err(start(f, x, { tag: '' }))).toBe('bad_tag');
    expect(err(start(f, x, { name: 'x' }))).toBe('bad_entry_name');
    must(T.createTeam(f.db, { creator: BENCH[0]!, name: 'Night Owls', tag: 'NOWL', now: at(0) }));
    expect(err(start(f, x))).toBe('keep_name_taken');
    expect(err(start(f, x, { name: 'Day Owls', tag: 'NOWL' }))).toBe('keep_tag_taken');
    capped(f, x.captain, 'CP');
    expect(err(start(f, x, { name: 'Day Owls' }))).toBe('keep_cap');
    expect(K.keepOf(f.db, x.keepId)?.status).toBe('offered');
  });

  it('opens 48 hours of voting with the captain counted as an accept', () => {
    const f = finishedDraft();
    const x = offered(f);
    must(start(f, x));
    expect(K.keepOf(f.db, x.keepId)).toMatchObject({ status: 'voting', name: 'Night Owls', tag: 'OWL', expires_at: at(50).toISOString() });
    expect(K.answersOf(f.db, x.keepId).map((a) => [a.steamid, a.answer])).toEqual([[x.captain, 'accept']]);
    expect(err(start(f, x))).toBe('keep_started');
  });
});

describe('answers and the team (Rulings 3, 5 to 8)', () => {
  it('makes the team at the third accept: the captain and two accepters, the draft name, tag and logo, origin draft', () => {
    const f = finishedDraft();
    f.db.prepare('UPDATE event_entries SET logo_key = ? WHERE id = ?').run('b'.repeat(64), f.entries[0]);
    const x = offered(f);
    must(start(f, x));
    must(answer(f, x, x.p[0], true));
    expect(err(settle(f, x))).toBe('keep_waiting');
    must(answer(f, x, x.p[1], false));
    expect(err(answer(f, x, x.p[1], true))).toBe('keep_answered');
    must(answer(f, x, x.p[2], true, 4));
    const made = madeOf(settle(f, x, 4));
    expect(made).toMatchObject({ joined: [x.captain, x.p[0], x.p[2]], left: [] });
    expect(T.getTeam(f.db, made.teamId)).toMatchObject({ name: 'Night Owls', tag: 'OWL', origin: 'draft', origin_ref: String(f.eventId), logo_key: 'b'.repeat(64), captain_steamid: x.captain });
    expect(K.keepOf(f.db, x.keepId)).toMatchObject({ status: 'made', team_id: made.teamId });
    expect(K.answersOf(f.db, x.keepId).filter((a) => a.joined === 1).map((a) => a.steamid).sort()).toEqual([x.captain, x.p[0], x.p[2]].sort());
    expect(K.keptFrom(f.db, made.teamId)).toEqual({ eventSlug: f.slug, eventName: 'Draft Night', placement: null });
    // Review Focus 4: a second settle makes nothing.
    expect(err(settle(f, x))).toBe('keep_closed');
    expect(f.db.prepare("SELECT COUNT(*) AS n FROM teams WHERE origin = 'draft'").get()).toEqual({ n: 1 });
  });

  it('Review Focus 1: the fourth player accepts after the team is made and joins it', () => {
    const f = finishedDraft();
    const x = offered(f);
    must(start(f, x));
    must(answer(f, x, x.p[0], true));
    must(answer(f, x, x.p[1], true));
    const made = madeOf(settle(f, x));
    expect(must(answer(f, x, x.p[2], true, 10))).toEqual({ joined: true });
    expect(T.roleOf(f.db, made.teamId, x.p[2])).toBe('member');
    expect(err(answer(f, x, x.p[2], true, 11))).toBe('keep_answered');
  });

  it('an accept at the cap is refused with nothing recorded; a decline is fine', () => {
    const f = finishedDraft();
    const x = offered(f);
    must(start(f, x));
    capped(f, x.p[0], 'AA');
    expect(err(answer(f, x, x.p[0], true))).toBe('keep_cap');
    expect(K.answersOf(f.db, x.keepId)).toHaveLength(1);
    must(answer(f, x, x.p[0], false));
  });

  it('Review Focus 2: an accepter who reached the cap since is left out, and the team waits for a third who can join', () => {
    const f = finishedDraft();
    const x = offered(f);
    must(start(f, x));
    must(answer(f, x, x.p[0], true));
    capped(f, x.p[0], 'AA');
    must(answer(f, x, x.p[1], true));
    expect(err(settle(f, x))).toBe('keep_waiting');
    must(answer(f, x, x.p[2], true, 4));
    const made = madeOf(settle(f, x, 4));
    expect(made).toMatchObject({ joined: [x.captain, x.p[1], x.p[2]], left: [x.p[0]] });
    expect(T.roleOf(f.db, made.teamId, x.p[0])).toBeNull();
  });

  it('Review Focus 3: a name taken after Keep makes the team as "Name 2"', () => {
    const f = finishedDraft();
    const x = offered(f);
    must(start(f, x));
    must(T.createTeam(f.db, { creator: BENCH[0]!, name: 'Night Owls', tag: 'OWL', now: at(2) }));
    must(answer(f, x, x.p[0], true));
    must(answer(f, x, x.p[1], true));
    expect(T.getTeam(f.db, madeOf(settle(f, x)).teamId)).toMatchObject({ name: 'Night Owls 2', tag: 'OWL2' });
  });
});

describe('the captain\'s standing (Task 1 review ruling)', () => {
  const ban = (f: StandinFixture, steamid: string) => f.db.prepare("UPDATE players SET status = 'banned' WHERE steamid = ?").run(steamid);
  it('startKeep refuses a captain not in good standing with not_player and writes nothing', () => {
    const f = finishedDraft();
    const x = offered(f);
    ban(f, x.captain);
    expect(err(start(f, x))).toBe('not_player');
    expect(K.keepOf(f.db, x.keepId)?.status).toBe('offered');
    expect(K.answersOf(f.db, x.keepId)).toHaveLength(0);
  });

  it('a settle after the captain lost standing closes the keep with no team, one log row, and a made:false outcome', () => {
    const f = finishedDraft();
    const x = offered(f);
    must(start(f, x));
    must(answer(f, x, x.p[0], true));
    must(answer(f, x, x.p[1], true));
    ban(f, x.captain);
    const logs = () => (f.db.prepare('SELECT COUNT(*) AS n FROM event_log').get() as { n: number }).n;
    const before = logs();
    expect(must(settle(f, x))).toEqual({ made: false, closed: 'captain_standing' });
    expect(logs()).toBe(before + 1);
    expect(f.db.prepare('SELECT action FROM event_log ORDER BY id DESC LIMIT 1').get()).toEqual({ action: 'keep_closed' });
    expect(K.keepOf(f.db, x.keepId)).toMatchObject({ status: 'lapsed', team_id: null });
    expect(K.keepOf(f.db, x.keepId)?.closed_at).not.toBeNull();
    expect(f.db.prepare("SELECT COUNT(*) AS n FROM teams WHERE origin = 'draft'").get()).toEqual({ n: 0 });
    expect(err(settle(f, x))).toBe('keep_closed');
  });
});

describe('refusals that name the real problem', () => {
  it('a settle with a captain at the team cap says keep_captain_cap and writes nothing', () => {
    const f = finishedDraft();
    const x = offered(f);
    must(start(f, x));
    must(answer(f, x, x.p[0], true));
    must(answer(f, x, x.p[1], true));
    capped(f, x.captain, 'CP');
    expect(err(settle(f, x))).toBe('keep_captain_cap');
    expect(K.keepOf(f.db, x.keepId)?.status).toBe('voting');
  });

  it('a late accept by a player who lost standing is not_player, and onto a full roster is roster_full', () => {
    const f = finishedDraft();
    const x = offered(f);
    must(start(f, x));
    must(answer(f, x, x.p[0], true));
    must(answer(f, x, x.p[1], true));
    const made = madeOf(settle(f, x));
    f.db.prepare("UPDATE players SET status = 'banned' WHERE steamid = ?").run(x.p[2]);
    expect(err(answer(f, x, x.p[2], true, 4))).toBe('not_player');
    f.db.prepare("UPDATE players SET status = 'active' WHERE steamid = ?").run(x.p[2]);
    for (const b of BENCH) f.db.prepare("INSERT INTO team_members (team_id, steamid, role, joined_at) VALUES (?, ?, 'member', ?)").run(made.teamId, b, at(3).toISOString());
    expect(err(answer(f, x, x.p[2], true, 5))).toBe('roster_full');
    expect(K.answersOf(f.db, x.keepId).some((a) => a.steamid === x.p[2])).toBe(false);
  });
});

describe('closeKeep (Ruling 2)', () => {
  it('lapses an offer or a vote past its window, closes a made team to late accepts, and refuses one still open', () => {
    const f = finishedDraft();
    const a = offered(f);
    expect(err(K.closeKeep(f.db, { keepId: a.keepId, now: at(5) }))).toBe('keep_open');
    expect(must(K.closeKeep(f.db, { keepId: a.keepId, now: at(7 * 24) }))).toEqual({ status: 'lapsed', from: 'offered' });
    expect(err(start(f, a, { now: at(7 * 24 + 1) }))).toBe('keep_closed');
    const entry = N.getEntry(f.db, f.entries[1]!)!;
    const { keepId } = must(K.offerKeep(f.db, { entryId: entry.id, now: at(1) }));
    const four = K.playersOf(K.keepOf(f.db, keepId)!);
    must(K.startKeep(f.db, { entryId: entry.id, steamid: four[0]!, name: 'Late Owls', tag: 'LATE', now: at(2) }));
    must(K.answerKeep(f.db, { keepId, steamid: four[1]!, accept: true, now: at(3) }));
    must(K.answerKeep(f.db, { keepId, steamid: four[2]!, accept: true, now: at(3) }));
    must(K.settleKeep(f.db, { keepId, now: at(3) }));
    expect(must(K.closeKeep(f.db, { keepId, now: at(50) }))).toEqual({ status: 'made', from: 'made' });
    expect(err(K.answerKeep(f.db, { keepId, steamid: four[3]!, accept: true, now: at(51) }))).toBe('keep_closed');
  });
});

describe('myKeepView', () => {
  it('shows the four their keep and its answers, and nobody else anything', () => {
    const f = finishedDraft();
    const x = offered(f);
    must(start(f, x));
    must(answer(f, x, x.p[1], false));
    const v = K.myKeepView(f.db, f.eventId, x.p[0], at(3))!;
    expect(v).toMatchObject({ keepId: x.keepId, status: 'voting', captain: false, name: 'Night Owls', tag: 'OWL', myAnswer: null, closed: false, made: null });
    expect(v.players.map((p) => p.answer)).toEqual(['accept', null, 'decline', null]);
    expect(K.myKeepView(f.db, f.eventId, x.captain, at(3))).toMatchObject({ captain: true, myAnswer: 'accept', defaults: { name: x.entry.name, tag: x.entry.tag } });
    expect(K.myKeepView(f.db, f.eventId, BENCH[0]!, at(3))).toBeNull();
  });
});

describe('myKeepView once the team is made (final review)', () => {
  it('names the made team as it was really made, with its slug, and lists the four by steamid', () => {
    const f = finishedDraft();
    const x = offered(f);
    must(start(f, x));
    must(T.createTeam(f.db, { creator: BENCH[0]!, name: 'Night Owls', tag: 'OWL', now: at(2) }));
    must(answer(f, x, x.p[0], true));
    must(answer(f, x, x.p[1], true));
    madeOf(settle(f, x));
    const v = K.myKeepView(f.db, f.eventId, x.p[2], at(4))!;
    expect(v).toMatchObject({ status: 'made', myAnswer: null, closed: false, made: { name: 'Night Owls 2', tag: 'OWL2', slug: 'night-owls-2' } });
    expect(v.players.map((p) => p.steamid)).toEqual([x.captain, ...x.p]);
  });
});

describe('noteKeepCaptainCap (final review)', () => {
  it('notes a captain-cap stall once per keep, and only on a vote', () => {
    const f = finishedDraft();
    const x = offered(f);
    expect(err(K.noteKeepCaptainCap(f.db, { keepId: x.keepId, now: at(2) }))).toBe('keep_not_open');
    must(start(f, x));
    must(K.noteKeepCaptainCap(f.db, { keepId: x.keepId, now: at(3) }));
    expect(err(K.noteKeepCaptainCap(f.db, { keepId: x.keepId, now: at(4) }))).toBe('keep_cap_told');
    expect(f.db.prepare("SELECT COUNT(*) AS n FROM event_log WHERE action = 'keep_captain_capped'").get()).toEqual({ n: 1 });
  });
});
