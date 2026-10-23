import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import { authedCookie } from './helpers.js';
import { adminEventRoutes } from '../src/routes/adminEvents.js';
import type { Notifier } from '../src/notify/notify.js';
import { upsertPlayer } from '../src/players.js';
import * as N from '../src/events/entries.js';
import { EVENT_ERRORS } from '../src/events/validate.js';
import { ADMIN, NOW } from './eventFixture.js';
import { cutDraft, type DraftFixture } from './draftFixture.js';

/**
 * Owner 2026-10-23: staff swap two starters between draft teams after the
 * teams are published and before the event goes live.
 */

const must = <T>(r: { ok: true; value: T } | { ok: false; error: string }): T => {
  if (!r.ok) throw new Error(`expected ok, got ${r.error}`);
  return r.value;
};
const LATER = new Date(NOW.getTime() + 3_600_000);

function published(o: { startsAt?: string; now?: Date } = {}): DraftFixture & { entries: number[] } {
  const f = cutDraft({ balance: true, ...o });
  const { entries } = must(N.createDraftEntries(f.db, { eventId: f.eventId, actor: ADMIN, now: o.now ?? NOW }));
  return { ...f, entries };
}
const starters = (f: { db: DraftFixture['db'] }, entryId: number) => N.rosterOf(f.db, entryId).starters;
const draftTeam = (f: DraftFixture, s: string) =>
  (f.db.prepare('SELECT draft_team FROM draft_signups WHERE event_id = ? AND steamid = ? AND withdrawn_at IS NULL').get(f.eventId, s) as { draft_team: number | null }).draft_team;
const snapshot = (f: { db: DraftFixture['db'] }) => JSON.stringify([
  f.db.prepare('SELECT * FROM event_entries ORDER BY id').all(),
  f.db.prepare('SELECT * FROM event_entry_players ORDER BY id').all(),
  f.db.prepare('SELECT * FROM draft_signups ORDER BY id').all(),
  f.db.prepare('SELECT COUNT(*) AS n FROM event_log').get(),
]);

describe('swapDraftPlayers', () => {
  it('moves each player to the other team, the working teams follow, with one log row', () => {
    const f = published();
    const [e1, e2] = f.entries as [number, number];
    const x = starters(f, e1)[1]!;
    const y = starters(f, e2)[2]!;
    const tx = draftTeam(f, x);
    const ty = draftTeam(f, y);
    const r = N.swapDraftPlayers(f.db, { eventId: f.eventId, a: { entryId: e1, steamid: x }, b: { entryId: e2, steamid: y }, actor: ADMIN, now: LATER });
    expect(r.ok).toBe(true);
    expect(starters(f, e1)).toContain(y);
    expect(starters(f, e1)).not.toContain(x);
    expect(starters(f, e2)).toContain(x);
    expect(starters(f, e2)).not.toContain(y);
    expect(starters(f, e1)).toHaveLength(4);
    expect(starters(f, e2)).toHaveLength(4);
    expect([draftTeam(f, x), draftTeam(f, y)]).toEqual([ty, tx]);
    const rows = f.db.prepare("SELECT actor, detail FROM event_log WHERE action = 'entry_players_swapped'").all() as { actor: string; detail: string }[];
    expect(rows.map((row) => ({ actor: row.actor, ...JSON.parse(row.detail) }))).toEqual([
      { actor: ADMIN, a: { entryId: e1, steamid: x }, b: { entryId: e2, steamid: y } },
    ]);
  });

  it('refuses a captain, the same team, a non-starter and a live event, writing nothing', () => {
    const f = published();
    const [e1, e2] = f.entries as [number, number];
    const before = snapshot(f);
    const swap = (a: [number, string], b: [number, string]) => {
      const r = N.swapDraftPlayers(f.db, { eventId: f.eventId, a: { entryId: a[0], steamid: a[1] }, b: { entryId: b[0], steamid: b[1] }, actor: ADMIN, now: LATER });
      return r.ok ? 'ok' : r.error;
    };
    expect(swap([e1, starters(f, e1)[0]!], [e2, starters(f, e2)[1]!])).toBe('swap_captain');
    expect(swap([e1, starters(f, e1)[1]!], [e1, starters(f, e1)[2]!])).toBe('swap_same_team');
    expect(swap([e1, starters(f, e2)[1]!], [e2, starters(f, e2)[2]!])).toBe('replace_not_starter');
    f.db.prepare("UPDATE events SET status = 'live' WHERE id = ?").run(f.eventId);
    expect(swap([e1, starters(f, e1)[1]!], [e2, starters(f, e2)[1]!])).toBe('swap_closed');
    expect(snapshot(f)).toBe(before);
  });

  it('refuses before the teams are published', () => {
    const f = published();
    f.db.prepare('UPDATE events SET teams_made_at = NULL WHERE id = ?').run(f.eventId);
    const [e1, e2] = f.entries as [number, number];
    const r = N.swapDraftPlayers(f.db, { eventId: f.eventId, a: { entryId: e1, steamid: starters(f, e1)[1]! }, b: { entryId: e2, steamid: starters(f, e2)[1]! }, actor: ADMIN, now: LATER });
    expect(r.ok ? null : r.error).toBe('swap_closed');
  });
});

describe('the swap route', () => {
  let desk: FastifyInstance;
  let send: ReturnType<typeof vi.fn>;
  let f: DraftFixture & { entries: number[] };
  const MOD = '76561199000000990';
  beforeEach(async () => {
    const now = new Date();
    f = published({ startsAt: new Date(Date.now() + 9 * 86_400_000).toISOString(), now });
    upsertPlayer(f.db, { steamid: MOD, name: 'mod', avatar: null }, []);
    f.db.prepare('UPDATE players SET is_mod = 1 WHERE steamid = ?').run(MOD);
    send = vi.fn(() => 1);
    desk = Fastify();
    await desk.register(cookie, { secret: 'x'.repeat(32) });
    await desk.register(adminEventRoutes, { db: f.db, store: () => { throw new Error('no store'); }, notifier: { send } as unknown as Notifier, publicUrl: 'https://x' });
    await desk.ready();
  });
  afterEach(async () => { await desk.close(); });
  const post = (as: string, body: object) => desk.inject({
    method: 'POST', url: `/api/admin/events/${f.eventId}/draft/swap-players`, cookies: authedCookie(desk, f.db, as), payload: body,
  });

  it('refuses a mod; an admin swaps with an audit row and DMs both players and both captains', async () => {
    const [e1, e2] = f.entries as [number, number];
    const x = starters(f, e1)[1]!;
    const y = starters(f, e2)[1]!;
    const body = { a: { entryId: e1, steamid: x }, b: { entryId: e2, steamid: y } };
    expect((await post(MOD, body)).statusCode).toBe(403);
    const res = await post(ADMIN, body);
    expect(res.statusCode).toBe(200);
    const audit = f.db.prepare("SELECT admin_id, detail FROM admin_actions WHERE action = 'event_draft_swap_players'").all() as { admin_id: string; detail: string }[];
    expect(audit.map((a) => ({ admin: a.admin_id, ...JSON.parse(a.detail) }))).toEqual([{ admin: ADMIN, ...body }]);
    const calls = send.mock.calls.map(([to, type]) => ({ to: [...(to as string[])], type }));
    const c1 = N.getEntry(f.db, e1)!.captain_steamid!;
    const c2 = N.getEntry(f.db, e2)!.captain_steamid!;
    expect(calls).toEqual([
      { to: [x], type: 'draft_player_added' }, { to: [y], type: 'draft_player_added' },
      { to: [c1], type: 'draft_roster_changed' }, { to: [c2], type: 'draft_roster_changed' },
    ]);
    // Each moved player hears the team they are on now.
    const xMsg = (send.mock.calls[0]![2] as { content: string }).content;
    expect(xMsg).toContain(N.getEntry(f.db, e2)!.name);
  });

  it('refuses a captain with the sentence and a bad body, sending nothing', async () => {
    const [e1, e2] = f.entries as [number, number];
    const res = await post(ADMIN, { a: { entryId: e1, steamid: starters(f, e1)[0] }, b: { entryId: e2, steamid: starters(f, e2)[1] } });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe(EVENT_ERRORS.swap_captain.text);
    expect((await post(ADMIN, { a: { entryId: e1 } })).statusCode).toBe(400);
    expect(send).not.toHaveBeenCalled();
  });
});
