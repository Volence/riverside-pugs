// tests/keepFlow.test.ts
import { describe, it, expect, vi } from 'vitest';
import { EventRunner } from '../src/events/runner.js';
import * as K from '../src/events/keepTeam.js';
import { answerKeepFlow, startKeepFlow } from '../src/events/keepFlow.js';
import { handleKeepButton } from '../src/discord/keepButtons.js';
import * as T from '../src/teams/teams.js';
import { EVENT_ERRORS } from '../src/events/validate.js';
import type { Notifier } from '../src/notify/notify.js';
import type { MessagePayload } from '../src/discord/transport.js';
import { P } from './draftFixture.js';
import { BENCH, FINISHED, capped as cappedIn, finishedDraft, type StandinFixture } from './standinFixture.js';

const H = 3_600_000;
const at = (h: number) => new Date(FINISHED.getTime() + h * H);
const must = <X>(r: { ok: true; value: X } | { ok: false; error: string }): X => {
  if (!r.ok) throw new Error(`expected ok, got ${r.error}`);
  return r.value;
};
function harness(f: StandinFixture) {
  const dms: { to: string[]; type: string; payload: MessagePayload }[] = [];
  const send = vi.fn((to: Iterable<string>, type: string, payload: MessagePayload) => { dms.push({ to: [...to], type, payload }); return 1; });
  const notifier = { send } as unknown as Notifier;
  return {
    dms, deps: { db: f.db, notifier, publicUrl: 'https://x' },
    runner: new EventRunner({ db: f.db, notifier, publicUrl: 'https://x' }),
    of: (type: string) => dms.filter((d) => d.type === type),
  };
}
const ids = (p: MessagePayload) => p.components.flat().map((b) => ('customId' in b ? b.customId : b.url));
const capped = (f: StandinFixture, steamid: string, prefix: string) => cappedIn(f, steamid, prefix);
/** draftFixture links P[i] to Discord id dd<i>. */
const discordOf = (steamid: string) => `dd${P.indexOf(steamid)}`;

describe('the minute tick (Rulings 1 and 2)', () => {
  it('offers every finished draft team\'s captain a Keep button, once', () => {
    const f = finishedDraft();
    const h = harness(f);
    h.runner.step(at(1));
    expect(h.of('draft_keep_offer')).toHaveLength(4);
    const k = K.keepsOf(f.db, f.eventId)[0]!;
    const dm = h.of('draft_keep_offer').find((d) => d.to[0] === k.captain_steamid)!;
    expect(ids(dm.payload)).toEqual([`dk:k:${k.id}`, `https://x/event/${f.slug}`]);
    h.runner.step(at(2));
    expect(h.of('draft_keep_offer')).toHaveLength(4);
  });

  it('Review Focus 5: no offer for an event finished 7 days ago or more, and an untouched keep lapses at its window', () => {
    const f = finishedDraft();
    const h = harness(f);
    h.runner.step(at(7 * 24));
    expect(K.keepsOf(f.db, f.eventId)).toEqual([]);
    const g = finishedDraft();
    const hg = harness(g);
    hg.runner.step(at(1));
    hg.runner.step(at(7 * 24));
    expect(K.keepsOf(g.db, g.eventId).map((k) => [k.status, k.closed_at])).toEqual(Array(4).fill(['lapsed', at(7 * 24).toISOString()]));
  });
});

describe('Keep, the answers and the DMs', () => {
  it('Keep asks the other three with Accept and Decline; the team is made once three can join, telling who joined and who was left out', () => {
    const f = finishedDraft();
    const h = harness(f);
    h.runner.step(at(1));
    const k = K.keepsOf(f.db, f.eventId)[0]!;
    const four = K.playersOf(k);
    must(startKeepFlow(h.deps, { entryId: k.entry_id, steamid: four[0]!, name: 'Night Owls', tag: 'OWL', now: at(2) }));
    const asks = h.of('draft_keep_ask');
    expect(asks.flatMap((d) => d.to).sort()).toEqual(four.slice(1).sort());
    expect(ids(asks[0]!.payload)).toEqual([`dk:a:${k.id}`, `dk:d:${k.id}`, `https://x/event/${f.slug}`]);
    expect(must(answerKeepFlow(h.deps, { keepId: k.id, steamid: four[1]!, accept: true, now: at(3) }))).toEqual({ joined: false, teamSlug: null });
    capped(f, four[1]!, 'AA');
    must(answerKeepFlow(h.deps, { keepId: k.id, steamid: four[2]!, accept: true, now: at(3) }));
    expect(h.of('draft_keep_made')).toEqual([]);
    expect(must(answerKeepFlow(h.deps, { keepId: k.id, steamid: four[3]!, accept: true, now: at(4) }))).toEqual({ joined: true, teamSlug: 'night-owls' });
    expect(h.of('draft_keep_made').flatMap((d) => d.to).sort()).toEqual([four[0], four[2], four[3]].sort());
    expect(h.of('draft_keep_left_out').flatMap((d) => d.to)).toEqual([four[1]]);
    expect(h.of('draft_keep_made')[0]!.payload.content).toContain('https://x/team/night-owls');
  });

  it('the tick makes the team when a capped accepter has since left a team', () => {
    const f = finishedDraft();
    const h = harness(f);
    h.runner.step(at(1));
    const k = K.keepsOf(f.db, f.eventId)[0]!;
    const four = K.playersOf(k);
    must(startKeepFlow(h.deps, { entryId: k.entry_id, steamid: four[0]!, name: 'Night Owls', tag: 'OWL', now: at(2) }));
    must(answerKeepFlow(h.deps, { keepId: k.id, steamid: four[1]!, accept: true, now: at(3) }));
    capped(f, four[1]!, 'AA');
    must(answerKeepFlow(h.deps, { keepId: k.id, steamid: four[2]!, accept: true, now: at(3) }));
    expect(K.keepOf(f.db, k.id)?.status).toBe('voting');
    const squad = T.myTeams(f.db, four[1]!)[0]!;
    must(T.disbandTeam(f.db, { teamId: squad.id, by: four[1]!, staff: false }));
    h.runner.step(at(5));
    expect(K.keepOf(f.db, k.id)?.status).toBe('made');
    expect(h.of('draft_keep_made').flatMap((d) => d.to).sort()).toEqual([four[0], four[1], four[2]].sort());
  });
});

describe('handleKeepButton', () => {
  it('the captain keeps the team from Discord when the entry has a tag, and the others answer there', async () => {
    const f = finishedDraft();
    const h = harness(f);
    h.runner.step(at(1));
    const k = K.keepsOf(f.db, f.eventId)[0]!;
    const four = K.playersOf(k);
    const press = (customId: string, userId: string) =>
      handleKeepButton({ db: f.db, publicUrl: 'https://x', notifier: h.deps.notifier, now: () => at(2).getTime() }, { kind: 'button', customId, userId } as never);
    expect((await press(`dk:k:${k.id}`, discordOf(four[0]!))).payload.content).toContain('Choose a team name and a tag on the event page first');
    // Test setup only: the captain had set a tag on the event page.
    f.db.prepare("UPDATE event_entries SET tag = 'OWL' WHERE id = ?").run(k.entry_id);
    expect((await press(`dk:k:${k.id}`, discordOf(four[1]!))).payload.content).toBe(EVENT_ERRORS.not_captain.text);
    expect((await press(`dk:k:${k.id}`, discordOf(four[0]!))).payload.content).toContain('Your three were asked');
    expect((await press(`dk:d:${k.id}`, discordOf(four[1]!))).payload.content).toBe('You declined.');
    expect((await press(`dk:a:${k.id}`, discordOf(four[2]!))).payload.content).toBe('You accepted. The team is made when 3 of the 4 of you accept.');
    expect((await press(`dk:a:${k.id}`, discordOf(four[3]!))).payload.content).toMatch(/^You are on the team: https:\/\/x\/team\//);
    expect((await press(`dk:a:${k.id}`, discordOf(BENCH[0]!))).payload.content).toBe(EVENT_ERRORS.keep_not_player.text);
  });
});

describe('a keep closed by its captain\'s standing', () => {
  it('tells all four plainly that no team was made, with no team link, and names who was left out neutrally', () => {
    const f = finishedDraft();
    const h = harness(f);
    h.runner.step(at(1));
    const k = K.keepsOf(f.db, f.eventId)[0]!;
    const four = K.playersOf(k);
    must(startKeepFlow(h.deps, { entryId: k.entry_id, steamid: four[0]!, name: 'Night Owls', tag: 'OWL', now: at(2) }));
    must(answerKeepFlow(h.deps, { keepId: k.id, steamid: four[1]!, accept: true, now: at(3) }));
    f.db.prepare("UPDATE players SET status = 'banned' WHERE steamid = ?").run(four[0]);
    must(answerKeepFlow(h.deps, { keepId: k.id, steamid: four[2]!, accept: true, now: at(4) }));
    expect(K.keepOf(f.db, k.id)?.status).toBe('lapsed');
    expect(h.of('draft_keep_made')).toEqual([]);
    const closed = h.of('draft_keep_closed');
    expect(closed.flatMap((d) => d.to).sort()).toEqual([...four].sort());
    expect(closed[0]!.payload.content).not.toContain('/team/');
  });
});
