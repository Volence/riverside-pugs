import { describe, it, expect } from 'vitest';
import { handleStandinButton } from '../src/discord/standinButtons.js';
import * as N from '../src/events/entries.js';
import * as ST from '../src/events/standins.js';
import { Standins } from '../src/events/standinFlow.js';
import { eventMessage } from '../src/events/messages.js';
import { EVENT_ERRORS } from '../src/events/validate.js';
import { ADMIN, NOW } from './eventFixture.js';
import { P } from './draftFixture.js';
import { BENCH, entryOf, liveStandins, standinFixture, type StandinFixture } from './standinFixture.js';

const must = <T>(r: { ok: true; value: T } | { ok: false; error: string }): T => {
  if (!r.ok) throw new Error(`expected ok, got ${r.error}`);
  return r.value;
};
/** draftFixture links P[i] to Discord id dd<i>. */
const discordOf = (steamid: string) => `dd${P.indexOf(steamid)}`;
const flow = (f: StandinFixture) => new Standins({ db: f.db, now: () => NOW.getTime() });
const press = (f: StandinFixture, s: Standins | null, customId: string, userId: string) =>
  handleStandinButton({ db: f.db, publicUrl: 'https://x', standins: () => s }, { kind: 'button', customId, userId } as never);
const opened = (f: StandinFixture, s: Standins) => {
  const e = entryOf(f, P[11]!);
  const { requestId } = must(s.request({ eventId: f.eventId, entryId: e.id, out: P[11]!, scope: 'event', by: e.captain_steamid!, staff: false }));
  return ST.openOfferOf(f.db, requestId)!;
};

describe('the captain\'s team DM', () => {
  it('carries a stand-in button for each of their three, then the event link', () => {
    const f = standinFixture();
    const entry = N.getEntry(f.db, f.entries[0]!)!;
    const p = eventMessage(f.db, 'https://x', f.eventId, 'draft_team_made', { entryId: entry.id, captain: true })!;
    const others = N.rosterOf(f.db, entry.id).starters.filter((s) => s !== entry.captain_steamid);
    expect(p.components[0]!.map((b) => ('customId' in b ? b.customId : null))).toEqual(others.map((s) => `ds:r:${entry.id}:${s}`));
    expect(p.components.at(-1)).toEqual([{ kind: 'link', url: `https://x/event/${f.slug}`, label: 'Open the event' }]);
    expect(eventMessage(f.db, 'https://x', f.eventId, 'draft_team_made', { entryId: entry.id })!.components).toHaveLength(1);
  });
});

describe('handleStandinButton', () => {
  it('Accept places the linked offeree; anyone else, or an unlinked account, is refused and the offer stays', async () => {
    const f = standinFixture();
    const s = flow(f);
    const offer = opened(f, s);
    expect((await press(f, s, `ds:a:${offer.id}`, discordOf(P[13]!))).payload.content).toBe(EVENT_ERRORS.standin_offer_gone.text);
    expect((await press(f, s, `ds:a:${offer.id}`, 'd-nobody')).payload.content).toMatch(/Link this Discord account/);
    expect(ST.offerOf(f.db, offer.id)?.answer).toBeNull();
    const ok = await press(f, s, `ds:a:${offer.id}`, discordOf(offer.steamid));
    expect(ok.payload.content).toContain('for the rest of the event');
    expect(ST.offerOf(f.db, offer.id)?.answer).toBe('accept');
  });

  it('Decline moves the offer on', async () => {
    const f = standinFixture();
    const s = flow(f);
    const offer = opened(f, s);
    expect((await press(f, s, `ds:d:${offer.id}`, discordOf(offer.steamid))).payload.content).toBe('You declined. The next bench player is asked.');
    expect(ST.openOfferOf(f.db, offer.request_id)?.steamid).toBe(P[13]);
  });

  it('Ruling 12: Accept on a request that no longer stands says so plainly and places nothing', async () => {
    const f = standinFixture();
    const s = flow(f);
    const offer = opened(f, s);
    must(N.replaceDraftPlayer(f.db, { eventId: f.eventId, entryId: entryOf(f, P[11]!).id, out: P[11]!, in: BENCH[4]!, reason: 'left', note: null, actor: ADMIN, now: NOW }));
    expect((await press(f, s, `ds:a:${offer.id}`, discordOf(offer.steamid))).payload.content).toBe(EVENT_ERRORS.standin_closed.text);
    expect(N.entryOfPlayer(f.db, f.eventId, offer.steamid)).toBeUndefined();
  });

  it('the captain\'s button asks the bench for the next match; anyone else is refused', async () => {
    const f = await liveStandins();
    const s = flow(f);
    const e = entryOf(f, P[11]!);
    expect((await press(f, s, `ds:r:${e.id}:${P[11]}`, discordOf(P[11]!))).payload.content).toBe(EVENT_ERRORS.not_manager.text);
    const r = await press(f, s, `ds:r:${e.id}:${P[11]}`, discordOf(e.captain_steamid!));
    expect(r.payload.content).toContain('The bench is being asked');
    expect(ST.requestsOf(f.db, f.eventId)).toMatchObject([{ scope: 'match', out_steamid: P[11] }]);
  });

  it('says so when the switch is closed or the flow is not running', async () => {
    const f = standinFixture();
    expect((await press(f, null, 'ds:a:1', discordOf(P[12]!))).payload.content).toMatch(/starting up/);
    f.db.prepare("UPDATE settings SET value = 'off' WHERE key = 'competitive_enabled'").run();
    expect((await press(f, flow(f), 'ds:a:1', discordOf(P[12]!))).payload.content).toBe('Events are not open yet.');
  });
});
