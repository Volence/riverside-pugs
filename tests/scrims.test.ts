import { describe, it, expect, beforeEach } from 'vitest';
import { openDb, type DB } from '../src/db.js';
import { addServer } from '../src/serverPool.js';
import { setSetting } from '../src/settings.js';
import { createTeam, disbandTeam, invitePlayer, respondInvite, setRole } from '../src/teams/teams.js';
import { BOOKING_ERRORS, confirmBooking, createBooking, getBooking, sideRow, peopleOf } from '../src/bookings/bookings.js';
import {
  acceptPost, board, confirmAccept, createPost, declineAccept, expire, withdrawAccept, withdrawPost,
  type ScrimResult,
} from '../src/scrims/scrims.js';

const P = Array.from({ length: 14 }, (_, i) => `765611990000008${String(i).padStart(2, '0')}`);
const MIN = 60_000;
const NOW = new Date('2026-10-01T12:00:00.000Z');
const START = '2026-10-02T20:00:00.000Z';
const at = (iso: string, plusMin = 0): Date => new Date(Date.parse(iso) + plusMin * MIN);
let db: DB;
let seasonId: number;

beforeEach(() => {
  db = openDb(':memory:');
  const ins = db.prepare("INSERT INTO players (steamid, name, status) VALUES (?, ?, 'active')");
  P.forEach((id, i) => ins.run(id, `p${i}`));
  setSetting(db, 'competitive_enabled', 'everyone');
  setSetting(db, 'map_pool', JSON.stringify(['no_mercy', 'death_toll', 'dead_air', 'blood_harvest', 'crash_course']));
  for (const n of ['a', 'bb', 'ccc', 'dddd']) {
    const id = addServer(db, { name: n, host: 'h', port: 27000 + n.length, rconPort: 1, rconPassword: 'x' });
    db.prepare("UPDATE servers SET status = 'idle' WHERE id = ?").run(id);
  } // 4 enabled, reserve 2: room for 2 bookings at once
  seasonId = (db.prepare('SELECT id FROM seasons LIMIT 1').get() as { id: number }).id;
});

const value = <T>(r: ScrimResult<T>): T => {
  if (!r.ok) throw new Error(r.error);
  return r.value;
};
const err = <T>(r: ScrimResult<T>): string => (r.ok ? 'ok' : r.error);

const team = (captain: string, name: string, tag: string, members: string[] = []): number => {
  const t = createTeam(db, { creator: captain, name, tag, now: NOW });
  if (!t.ok) throw new Error(t.error);
  for (const m of members) {
    const inv = invitePlayer(db, { teamId: t.value.id, by: captain, target: m, now: NOW });
    if (!inv.ok) throw new Error(inv.error);
    respondInvite(db, { inviteId: inv.value.inviteId, steamid: m, accept: true, now: NOW });
  }
  return t.value.id;
};
/** A current-season rating with sigma 5: displaySr is then (mu - 10) * 100, so mu 30 is 2000 and mu 20 is 1000. */
const rate = (steamid: string, mu: number): void => {
  db.prepare('INSERT INTO player_ratings (player_id, season_id, mu, sigma) VALUES (?, ?, ?, 5)').run(steamid, seasonId, mu);
};

type PostIn = Parameters<typeof createPost>[1];
const postInput = (over: Partial<PostIn> = {}): PostIn => ({
  by: P[0], startsAt: START, minutes: 120, campaigns: ['no_mercy', 'death_toll'], srRange: null, note: '', now: NOW, ...over,
});
const post = (over: Partial<PostIn> = {}): number => value(createPost(db, postInput(over))).id;
const accept = (postId: number, by: string, over: Partial<Parameters<typeof acceptPost>[1]> = {}): number =>
  value(acceptPost(db, { postId, by, now: NOW, ...over })).id;

const postRow = (id: number) => db.prepare('SELECT * FROM scrim_posts WHERE id = ?').get(id) as Record<string, unknown>;
const acceptRow = (id: number) => db.prepare('SELECT * FROM scrim_accepts WHERE id = ?').get(id) as Record<string, unknown>;
const bookingCount = (): number => (db.prepare('SELECT COUNT(*) AS n FROM bookings').get() as { n: number }).n;
/** Two other bookings over a start (START by default): with room for 2, the slot is then full. */
const fillSlotAt = (startsAt: string): void => {
  for (const [a, b] of [[P[10], P[11]], [P[12], P[13]]]) {
    const r = createBooking(db, { by: a, opponent: { steamid: b }, startsAt, minutes: 120, playlist: ['no_mercy'], now: NOW });
    if (!r.ok) throw new Error(r.error);
  }
};
const fillSlot = (): void => fillSlotAt(START);

describe('createPost', () => {
  it('stores a pickup post, open, with the poster as captain and the note trimmed', () => {
    const id = post({ note: '  gl hf  ', srRange: 200 });
    expect(postRow(id)).toMatchObject({
      side_kind: 'pickup', team_id: null, captain_steamid: P[0], region: 'na', starts_at: START, block_minutes: 120,
      sr_range: 200, note: 'gl hf', status: 'open', target_team_id: null, booking_id: null, created_at: NOW.toISOString(),
    });
    expect(JSON.parse(postRow(id).campaigns_json as string)).toEqual(['no_mercy', 'death_toll']);
  });

  it('a team post needs a captain or co-captain of a live team', () => {
    const rats = team(P[0], 'Rats', 'RR', [P[1], P[2]]);
    expect(err(createPost(db, postInput({ by: P[1], teamId: rats })))).toBe('not_manager');
    setRole(db, { teamId: rats, by: P[0], target: P[1], role: 'cocaptain' });
    const id = post({ by: P[1], teamId: rats });
    expect(postRow(id)).toMatchObject({ side_kind: 'team', team_id: rats, captain_steamid: P[0] });
    expect(err(createPost(db, postInput({ teamId: 999 })))).toBe('not_found');
    disbandTeam(db, { teamId: rats, by: P[0], now: NOW });
    expect(err(createPost(db, postInput({ teamId: rats })))).toBe('not_found');
  });

  it('uses the booking limits for time, length and campaigns', () => {
    const r = (over: Partial<PostIn>) => err(createPost(db, postInput(over)));
    expect(r({ startsAt: '2026-10-01T11:00:00.000Z' })).toBe('bad_time');
    expect(r({ startsAt: '2026-10-20T11:00:00.000Z' })).toBe('bad_time');
    expect(r({ startsAt: 'tomorrow' })).toBe('bad_time');
    expect(r({ minutes: 45 })).toBe('bad_length');
    expect(r({ minutes: 240 })).toBe('bad_length');
    expect(r({ campaigns: [] })).toBe('bad_playlist');
    expect(r({ campaigns: ['no_mercy', 'no_mercy'] })).toBe('bad_playlist');
    expect(r({ campaigns: ['the_sacrifice'] })).toBe('bad_playlist');
    expect(r({ campaigns: ['no_mercy', 'death_toll', 'dead_air', 'blood_harvest', 'crash_course'] })).toBe('bad_playlist');
    expect(r({ campaigns: ['no_mercy', 'death_toll', 'dead_air', 'blood_harvest'] })).toBe('ok');
  });

  it('refuses a start less than the 30 minute acceptance cutoff away', () => {
    const r = (startsAt: string) => err(createPost(db, postInput({ startsAt })));
    expect(r(new Date(NOW.getTime() + 29 * MIN).toISOString())).toBe('too_late');
    expect(r(new Date(NOW.getTime() + 30 * MIN).toISOString())).toBe('too_late');
    expect(r(new Date(NOW.getTime() + 31 * MIN).toISOString())).toBe('ok');
  });

  it('an SR range is open (null) or a whole number from 50 to 1000', () => {
    const r = (srRange: unknown) => err(createPost(db, postInput({ srRange } as Partial<PostIn>)));
    expect(r(49)).toBe('bad_sr_range');
    expect(r(1001)).toBe('bad_sr_range');
    expect(r(100.5)).toBe('bad_sr_range');
    expect(r('100')).toBe('bad_sr_range');
    expect(r(50)).toBe('ok');
    expect(r(1000)).toBe('ok');
    expect(r(null)).toBe('ok');
  });

  it('a note is at most 200 characters after trimming and has no slurs', () => {
    const r = (note: unknown) => err(createPost(db, postInput({ note } as Partial<PostIn>)));
    expect(r('x'.repeat(201))).toBe('bad_note');
    expect(r(`  ${'x'.repeat(200)}  `)).toBe('ok');
    expect(r(42)).toBe('bad_note');
    expect(r('come play you f a g g o t s')).toBe('note_slur');
    expect(r(undefined)).toBe('ok');
  });

  it('a challenge target must be a live team that is not the poster\'s own', () => {
    const rats = team(P[0], 'Rats', 'RR');
    const mice = team(P[1], 'Mice', 'MM', [P[2]]);
    expect(err(createPost(db, postInput({ teamId: rats, targetTeamId: rats })))).toBe('bad_target');
    expect(err(createPost(db, postInput({ targetTeamId: 999 })))).toBe('bad_target');
    // A pickup poster who runs the target team is challenging their own team.
    expect(err(createPost(db, postInput({ by: P[1], targetTeamId: mice })))).toBe('bad_target');
    const id = post({ teamId: rats, targetTeamId: mice });
    expect(postRow(id).target_team_id).toBe(mice);
    disbandTeam(db, { teamId: mice, by: P[1], now: NOW });
    expect(err(createPost(db, postInput({ teamId: rats, targetTeamId: mice })))).toBe('bad_target');
  });

  it('checks capacity and the side\'s allowance up front', () => {
    fillSlot();
    expect(err(createPost(db, postInput()))).toBe('no_capacity');
    setSetting(db, 'booking_max_upcoming', '1');
    const b = createBooking(db, { by: P[0], opponent: { steamid: P[1] }, startsAt: '2026-10-04T20:00:00.000Z', minutes: 60, playlist: ['no_mercy'], now: NOW });
    expect(b.ok).toBe(true);
    expect(err(createPost(db, postInput({ startsAt: '2026-10-05T20:00:00.000Z' })))).toBe('allowance');
  });

  it('refuses someone who cannot use competitive play', () => {
    setSetting(db, 'competitive_enabled', 'admins');
    expect(err(createPost(db, postInput()))).toBe('not_open');
  });
});

describe('withdrawPost', () => {
  it('the poster withdraws; pending acceptances are withdrawn with it', () => {
    const id = post();
    const a1 = accept(id, P[1]);
    expect(err(withdrawPost(db, { postId: id, by: P[1], now: NOW }))).toBe('not_manager');
    expect(value(withdrawPost(db, { postId: id, by: P[0], now: NOW }))).toEqual({ acceptIds: [a1] });
    expect(postRow(id).status).toBe('withdrawn');
    expect(acceptRow(a1)).toMatchObject({ status: 'withdrawn', responded_at: NOW.toISOString() });
    expect(err(withdrawPost(db, { postId: id, by: P[0], now: NOW }))).toBe('wrong_state');
    expect(err(withdrawPost(db, { postId: 999, by: P[0], now: NOW }))).toBe('not_found');
  });

  it('a team post is withdrawn by any current manager of the team, not a plain member', () => {
    const rats = team(P[0], 'Rats', 'RR', [P[2], P[3]]);
    setRole(db, { teamId: rats, by: P[0], target: P[2], role: 'cocaptain' });
    const id = post({ teamId: rats });
    expect(err(withdrawPost(db, { postId: id, by: P[3], now: NOW }))).toBe('not_manager');
    expect(withdrawPost(db, { postId: id, by: P[2], now: NOW }).ok).toBe(true);
  });

  it('a booked post cannot be withdrawn', () => {
    const id = post();
    const a = accept(id, P[1]);
    value(confirmAccept(db, { acceptId: a, by: P[0], now: NOW }));
    expect(err(withdrawPost(db, { postId: id, by: P[0], now: NOW }))).toBe('wrong_state');
  });
});

describe('acceptPost', () => {
  it('a pickup accept makes the post pending and says whether the accepter fits', () => {
    rate(P[0], 25); // 1500
    rate(P[1], 26); // 1600
    rate(P[2], 30); // 2000
    const id = post({ srRange: 200 });
    const r = value(acceptPost(db, { postId: id, by: P[1], campaigns: ['dead_air'], now: NOW }));
    expect(r.fits).toBe(true);
    expect(postRow(id).status).toBe('pending');
    expect(acceptRow(r.id)).toMatchObject({ post_id: id, side_kind: 'pickup', team_id: null, captain_steamid: P[1], status: 'pending' });
    expect(JSON.parse(acceptRow(r.id).campaigns_json as string)).toEqual(['dead_air']);
    // Outside the range is allowed; the poster is just told it does not fit.
    const r2 = value(acceptPost(db, { postId: id, by: P[2], now: NOW }));
    expect(r2.fits).toBe(false);
    expect(JSON.parse(acceptRow(r2.id).campaigns_json as string)).toEqual([]);
  });

  it('a team accept needs a manager of that team', () => {
    const id = post();
    const mice = team(P[1], 'Mice', 'MM', [P[2]]);
    expect(err(acceptPost(db, { postId: id, by: P[2], teamId: mice, now: NOW }))).toBe('not_manager');
    const a = accept(id, P[1], { teamId: mice });
    expect(acceptRow(a)).toMatchObject({ side_kind: 'team', team_id: mice, captain_steamid: P[1] });
  });

  it('refuses the poster\'s own side, in every shape', () => {
    const rats = team(P[0], 'Rats', 'RR', [P[2]]);
    const teamPost = post({ teamId: rats });
    expect(err(acceptPost(db, { postId: teamPost, by: P[0], teamId: rats, now: NOW }))).toBe('own_post');
    expect(err(acceptPost(db, { postId: teamPost, by: P[0], now: NOW }))).toBe('own_post'); // its captain as a pickup
    expect(err(acceptPost(db, { postId: teamPost, by: P[2], now: NOW }))).toBe('own_post'); // a member as a pickup
    const pickupPost = post({ by: P[5], startsAt: '2026-10-03T20:00:00.000Z' });
    expect(err(acceptPost(db, { postId: pickupPost, by: P[5], now: NOW }))).toBe('own_post');
  });

  it('refuses a side already accepting it', () => {
    const id = post();
    const mice = team(P[1], 'Mice', 'MM', [P[2]]);
    setRole(db, { teamId: mice, by: P[1], target: P[2], role: 'cocaptain' });
    accept(id, P[1], { teamId: mice });
    expect(err(acceptPost(db, { postId: id, by: P[2], teamId: mice, now: NOW }))).toBe('already_accepted');
    accept(id, P[3]);
    expect(err(acceptPost(db, { postId: id, by: P[3], now: NOW }))).toBe('already_accepted');
  });

  it('a side whose acceptance is gone may accept again', () => {
    const id = post();
    const a = accept(id, P[3]);
    value(withdrawAccept(db, { acceptId: a, by: P[3], now: NOW }));
    expect(acceptPost(db, { postId: id, by: P[3], now: NOW }).ok).toBe(true);
  });

  it('the post must be open or pending and not yet started', () => {
    const id = post();
    expect(err(acceptPost(db, { postId: id, by: P[1], now: at(START) }))).toBe('wrong_state');
    value(withdrawPost(db, { postId: id, by: P[0], now: NOW }));
    expect(err(acceptPost(db, { postId: id, by: P[1], now: NOW }))).toBe('wrong_state');
    expect(err(acceptPost(db, { postId: 999, by: P[1], now: NOW }))).toBe('not_found');
  });

  it('campaigns are up to scrim_accept_campaigns_max pool slugs', () => {
    const id = post();
    const r = (campaigns: unknown) => err(acceptPost(db, { postId: id, by: P[1], campaigns, now: NOW } as Parameters<typeof acceptPost>[1]));
    expect(r(['dead_air', 'blood_harvest', 'crash_course'])).toBe('bad_campaigns');
    expect(r(['the_sacrifice'])).toBe('bad_campaigns');
    expect(r(['dead_air', 'dead_air'])).toBe('bad_campaigns');
    expect(r('dead_air')).toBe('bad_campaigns');
    setSetting(db, 'scrim_accept_campaigns_max', '0');
    expect(r(['dead_air'])).toBe('bad_campaigns');
    expect(r([])).toBe('ok');
  });

  it('a direct challenge is accepted only by a manager of the target team, as that team', () => {
    const rats = team(P[0], 'Rats', 'RR');
    const mice = team(P[1], 'Mice', 'MM', [P[2]]);
    const owls = team(P[3], 'Owls', 'OW');
    const id = post({ teamId: rats, targetTeamId: mice });
    expect(err(acceptPost(db, { postId: id, by: P[5], now: NOW }))).toBe('not_found'); // a stranger
    expect(err(acceptPost(db, { postId: id, by: P[2], teamId: mice, now: NOW }))).toBe('not_found'); // a plain member of the target
    expect(err(acceptPost(db, { postId: id, by: P[3], teamId: owls, now: NOW }))).toBe('not_found'); // another team
    expect(err(acceptPost(db, { postId: id, by: P[1], now: NOW }))).toBe('challenge_side'); // the target captain as pickup
    expect(acceptPost(db, { postId: id, by: P[1], teamId: mice, now: NOW }).ok).toBe(true);
  });

  it('refuses an accepter who cannot use competitive play, or is out of allowance', () => {
    const id = post();
    db.prepare("UPDATE players SET status = 'banned' WHERE steamid = ?").run(P[1]);
    expect(err(acceptPost(db, { postId: id, by: P[1], now: NOW }))).toBe('not_open');
    setSetting(db, 'booking_max_upcoming', '1');
    const b = createBooking(db, { by: P[2], opponent: { steamid: P[3] }, startsAt: '2026-10-04T20:00:00.000Z', minutes: 60, playlist: ['no_mercy'], now: NOW });
    expect(b.ok).toBe(true);
    expect(err(acceptPost(db, { postId: id, by: P[2], now: NOW }))).toBe('allowance');
  });
});

describe('withdrawAccept and declineAccept', () => {
  it('the accepter withdraws; the post goes back to open when nothing is left pending', () => {
    const id = post();
    const a1 = accept(id, P[1]);
    const a2 = accept(id, P[2]);
    expect(err(withdrawAccept(db, { acceptId: a1, by: P[0], now: NOW }))).toBe('not_manager');
    value(withdrawAccept(db, { acceptId: a1, by: P[1], now: NOW }));
    expect(acceptRow(a1)).toMatchObject({ status: 'withdrawn', responded_at: NOW.toISOString() });
    expect(postRow(id).status).toBe('pending');
    value(withdrawAccept(db, { acceptId: a2, by: P[2], now: NOW }));
    expect(postRow(id).status).toBe('open');
    expect(err(withdrawAccept(db, { acceptId: a2, by: P[2], now: NOW }))).toBe('wrong_state');
    expect(err(withdrawAccept(db, { acceptId: 999, by: P[2], now: NOW }))).toBe('not_found');
  });

  it('a team acceptance is withdrawn by a current manager of that team', () => {
    const id = post();
    const mice = team(P[1], 'Mice', 'MM', [P[2]]);
    const a = accept(id, P[1], { teamId: mice });
    expect(err(withdrawAccept(db, { acceptId: a, by: P[2], now: NOW }))).toBe('not_manager');
    setRole(db, { teamId: mice, by: P[1], target: P[2], role: 'cocaptain' });
    expect(withdrawAccept(db, { acceptId: a, by: P[2], now: NOW }).ok).toBe(true);
  });

  it('the poster declines; the post goes back to open when nothing is left pending', () => {
    const id = post();
    const a1 = accept(id, P[1]);
    const a2 = accept(id, P[2]);
    expect(err(declineAccept(db, { acceptId: a1, by: P[1], now: NOW }))).toBe('not_manager');
    value(declineAccept(db, { acceptId: a1, by: P[0], now: NOW }));
    expect(acceptRow(a1)).toMatchObject({ status: 'declined', responded_at: NOW.toISOString() });
    expect(postRow(id).status).toBe('pending');
    value(declineAccept(db, { acceptId: a2, by: P[0], now: NOW }));
    expect(postRow(id).status).toBe('open');
    expect(err(declineAccept(db, { acceptId: a2, by: P[0], now: NOW }))).toBe('wrong_state');
  });
});

describe('confirmAccept', () => {
  it('books the server with both sides confirmed, the playlist alternated, and the other accepts taken', () => {
    const id = post({ campaigns: ['no_mercy', 'death_toll'], minutes: 180 });
    const a1 = accept(id, P[1], { campaigns: ['dead_air'] });
    const a2 = accept(id, P[2]);
    const a3 = accept(id, P[3]);
    value(withdrawAccept(db, { acceptId: a3, by: P[3], now: NOW }));
    const r = value(confirmAccept(db, { acceptId: a1, by: P[0], now: NOW }));
    expect(r.takenAcceptIds).toEqual([a2]);
    const b = getBooking(db, r.bookingId)!;
    expect(b).toMatchObject({ purpose: 'scrim', state: 'scheduled', starts_at: START, ends_at: '2026-10-02T23:00:00.000Z', created_by: P[0] });
    expect(JSON.parse(b.playlist_json)).toEqual(['no_mercy', 'dead_air', 'death_toll']);
    expect(sideRow(db, b.id, 'a')).toMatchObject({ team_id: null, captain_steamid: P[0] });
    expect(sideRow(db, b.id, 'b')).toMatchObject({ team_id: null, captain_steamid: P[1] });
    expect(sideRow(db, b.id, 'a')!.confirmed_at).not.toBeNull();
    expect(sideRow(db, b.id, 'b')!.confirmed_at).not.toBeNull();
    expect(postRow(id)).toMatchObject({ status: 'booked', booking_id: b.id });
    expect(acceptRow(a1)).toMatchObject({ status: 'chosen', responded_at: NOW.toISOString() });
    expect(acceptRow(a2)).toMatchObject({ status: 'declined', responded_at: NOW.toISOString() });
    expect(acceptRow(a3).status).toBe('withdrawn');
  });

  it('trims the playlist to the block', () => {
    const id = post({ campaigns: ['no_mercy', 'death_toll'], minutes: 120 });
    const a = accept(id, P[1], { campaigns: ['dead_air'] });
    const r = value(confirmAccept(db, { acceptId: a, by: P[0], now: NOW }));
    expect(JSON.parse(getBooking(db, r.bookingId)!.playlist_json)).toEqual(['no_mercy', 'dead_air']);
  });

  it('team against team: the booking carries both teams and their rosters', () => {
    const rats = team(P[0], 'Rats', 'RR', [P[2]]);
    const mice = team(P[1], 'Mice', 'MM', [P[3]]);
    setRole(db, { teamId: rats, by: P[0], target: P[2], role: 'cocaptain' });
    const id = post({ teamId: rats });
    const a = accept(id, P[1], { teamId: mice });
    const r = value(confirmAccept(db, { acceptId: a, by: P[2], now: NOW }));
    expect(sideRow(db, r.bookingId, 'a')).toMatchObject({ team_id: rats });
    expect(sideRow(db, r.bookingId, 'b')).toMatchObject({ team_id: mice });
    expect(sideRow(db, r.bookingId, 'b')!.confirmed_at).not.toBeNull();
    expect(peopleOf(db, r.bookingId).filter((p) => p.side === 'b').map((p) => p.steamid).sort()).toEqual([P[1], P[3]].sort());
  });

  it('only a manager of the poster\'s side confirms, and only a pending acceptance of a pending post', () => {
    const id = post();
    const a = accept(id, P[1]);
    expect(err(confirmAccept(db, { acceptId: a, by: P[1], now: NOW }))).toBe('not_manager');
    expect(err(confirmAccept(db, { acceptId: 999, by: P[0], now: NOW }))).toBe('not_found');
    value(withdrawAccept(db, { acceptId: a, by: P[1], now: NOW }));
    expect(err(confirmAccept(db, { acceptId: a, by: P[0], now: NOW }))).toBe('wrong_state');
    expect(bookingCount()).toBe(0);
  });

  it('a co-captain demoted after posting can no longer confirm', () => {
    const rats = team(P[0], 'Rats', 'RR', [P[2]]);
    setRole(db, { teamId: rats, by: P[0], target: P[2], role: 'cocaptain' });
    const id = post({ by: P[2], teamId: rats });
    const a = accept(id, P[1]);
    setRole(db, { teamId: rats, by: P[0], target: P[2], role: 'member' });
    expect(err(confirmAccept(db, { acceptId: a, by: P[2], now: NOW }))).toBe('not_manager');
  });

  it('race: a post expired at its start cannot then be confirmed', () => {
    const id = post();
    const a = accept(id, P[1]);
    expect(expire(db, at(START))).toEqual({ posts: [id], accepts: [a], withdrawn: { posts: [], accepts: [] } });
    expect(err(confirmAccept(db, { acceptId: a, by: P[0], now: at(START) }))).toBe('wrong_state');
    expect(postRow(id).status).toBe('expired');
    expect(bookingCount()).toBe(0);
  });

  it('no_capacity: nothing changes, and the nearest free slot is offered', () => {
    const id = post();
    const a = accept(id, P[1]);
    fillSlot(); // two bookings 20:00-22:00 fill the slot after the post was made
    const before = bookingCount();
    const r = confirmAccept(db, { acceptId: a, by: P[0], now: NOW });
    expect(r).toEqual({ ok: false, error: 'no_capacity', text: BOOKING_ERRORS.no_capacity.text, nearestSlot: '2026-10-02T22:00:00.000Z' });
    expect(bookingCount()).toBe(before);
    expect(postRow(id)).toMatchObject({ status: 'pending', booking_id: null });
    expect(acceptRow(a)).toMatchObject({ status: 'pending', responded_at: null });
  });

  it('a refusal from confirming side b rolls back the booking side a created', () => {
    const id = post();
    const a = accept(id, P[1]);
    // The accepter now holds as many bookings as allowed.
    setSetting(db, 'booking_max_upcoming', '1');
    const other = createBooking(db, { by: P[1], opponent: { steamid: P[5] }, startsAt: '2026-10-04T20:00:00.000Z', minutes: 60, playlist: ['no_mercy'], now: NOW });
    if (!other.ok) throw new Error(other.error);
    const before = bookingCount();
    const r = confirmAccept(db, { acceptId: a, by: P[0], now: NOW });
    expect(r).toEqual({ ok: false, error: 'allowance', text: BOOKING_ERRORS.allowance.text });
    expect(bookingCount()).toBe(before);
    expect(db.prepare('SELECT COUNT(*) AS n FROM booking_sides').get()).toEqual({ n: 2 });
    expect(postRow(id).status).toBe('pending');
    expect(acceptRow(a).status).toBe('pending');
    // The other booking is untouched by the rollback.
    expect(confirmBooking(db, { bookingId: other.value.id, by: P[5], now: NOW }).ok).toBe(true);
  });

  it('an accepter who lost access is refused and nothing is kept', () => {
    const id = post();
    const a = accept(id, P[1]);
    db.prepare("UPDATE players SET status = 'banned' WHERE steamid = ?").run(P[1]);
    // createBooking refuses a pickup opponent who is no longer an active player.
    expect(err(confirmAccept(db, { acceptId: a, by: P[0], now: NOW }))).toBe('not_player');
    expect(bookingCount()).toBe(0);
    expect(postRow(id).status).toBe('pending');
  });
});

describe('expire', () => {
  it('posts at or past their start expire with their pending acceptances', () => {
    const open = post();
    const pending = post({ by: P[2], startsAt: '2026-10-02T21:00:00.000Z' });
    // Made an hour before START, so neither its 2 hours nor the 30 minute cutoff is up by START.
    const a = value(acceptPost(db, { postId: pending, by: P[3], now: at(START, -60) })).id;
    expect(expire(db, at(START, -1))).toEqual({ posts: [], accepts: [], withdrawn: { posts: [], accepts: [] } });
    expect(expire(db, at(START))).toEqual({ posts: [open], accepts: [], withdrawn: { posts: [], accepts: [] } });
    expect(expire(db, at('2026-10-02T21:00:00.000Z'))).toEqual({ posts: [pending], accepts: [a], withdrawn: { posts: [], accepts: [] } });
    expect(postRow(pending).status).toBe('expired');
    expect(acceptRow(a)).toMatchObject({ status: 'expired', responded_at: '2026-10-02T21:00:00.000Z' });
  });

  it('a pending acceptance expires after 2 hours unanswered, and the post goes back to open', () => {
    const id = post();
    const a1 = accept(id, P[1]);
    const a2 = value(acceptPost(db, { postId: id, by: P[2], now: at(NOW.toISOString(), 60) })).id;
    expect(expire(db, at(NOW.toISOString(), 119))).toEqual({ posts: [], accepts: [], withdrawn: { posts: [], accepts: [] } });
    expect(expire(db, at(NOW.toISOString(), 120))).toEqual({ posts: [], accepts: [a1], withdrawn: { posts: [], accepts: [] } });
    expect(postRow(id).status).toBe('pending');
    expect(expire(db, at(NOW.toISOString(), 180))).toEqual({ posts: [], accepts: [a2], withdrawn: { posts: [], accepts: [] } });
    expect(postRow(id).status).toBe('open');
  });

  it('a pending acceptance expiring within 30 minutes of the start closes the post, not reopens it', () => {
    const id = post();
    const a = value(acceptPost(db, { postId: id, by: P[1], now: at(START, -60) })).id;
    expect(expire(db, at(START, -31))).toEqual({ posts: [], accepts: [], withdrawn: { posts: [], accepts: [] } });
    // A new acceptance made now would itself be too_late, so the post is
    // closed (expired) instead of going back to Open with a dead Accept
    // button.
    expect(expire(db, at(START, -30))).toEqual({ posts: [id], accepts: [a], withdrawn: { posts: [], accepts: [] } });
    expect(postRow(id).status).toBe('expired');
  });

  it('leaves booked posts and answered acceptances alone', () => {
    const id = post();
    const a = accept(id, P[1]);
    value(confirmAccept(db, { acceptId: a, by: P[0], now: NOW }));
    expect(expire(db, at(START, 10))).toEqual({ posts: [], accepts: [], withdrawn: { posts: [], accepts: [] } });
    expect(postRow(id).status).toBe('booked');
    expect(acceptRow(a).status).toBe('chosen');
  });
});

describe('board', () => {
  const viewer = (steamid: string | null, staff = false) => ({ steamid, staff });

  it('lists open and pending public posts, soonest first, never closed ones', () => {
    const late = post({ startsAt: '2026-10-03T20:00:00.000Z' });
    const early = post({ by: P[1] });
    accept(early, P[2]);
    const gone = post({ by: P[3] });
    value(withdrawPost(db, { postId: gone, by: P[3], now: NOW }));
    expect(board(db, viewer(P[5]), { now: NOW }).map((p) => [p.id, p.status])).toEqual([[early, 'pending'], [late, 'open']]);
    expect(board(db, viewer(null), { now: NOW }).map((p) => p.id)).toEqual([early, late]);
    expect(board(db, viewer(null), { now: at('2026-10-03T00:00:00.000Z') }).map((p) => p.id)).toEqual([late]);
  });

  it('shows the side, average SR, time, length, campaigns, note and acceptance count', () => {
    rate(P[0], 30); // 2000
    rate(P[2], 20); // 1000
    const rats = team(P[0], 'Rats', 'RR', [P[2]]);
    const id = post({ teamId: rats, note: 'bring snacks', srRange: 300, campaigns: ['dead_air'] });
    accept(id, P[1]);
    rate(P[5], 25);
    const pickup = post({ by: P[5], startsAt: '2026-10-03T20:00:00.000Z' });
    const [teamEntry, pickupEntry] = board(db, viewer(P[7]), { now: NOW });
    expect(teamEntry).toMatchObject({
      id, side: { kind: 'team', teamId: rats, name: 'Rats', tag: 'RR', slug: expect.any(String), logoKey: null },
      sr: 1500, srRange: 300, startsAt: START, minutes: 120, campaigns: ['dead_air'], note: 'bring snacks',
      acceptCount: 1, mine: false, accepts: null, challenge: null, myAcceptId: null,
    });
    expect(pickupEntry).toMatchObject({ id: pickup, side: { kind: 'pickup', steamid: P[5], name: 'p5' }, sr: 1500, srRange: null });
  });

  it('the poster gets each pending acceptance with its playlist and fit; the accepter sees its own acceptance id', () => {
    rate(P[0], 25); // 1500
    rate(P[1], 30); // 2000
    const id = post({ srRange: 100, campaigns: ['no_mercy', 'death_toll'], minutes: 120 });
    const a = accept(id, P[1], { campaigns: ['dead_air'] });
    const mine = board(db, viewer(P[0]), { now: NOW })[0];
    expect(mine.mine).toBe(true);
    expect(mine.accepts).toEqual([{
      id: a, side: { kind: 'pickup', steamid: P[1], name: 'p1' }, sr: 2000, fits: false, campaigns: ['dead_air'],
      createdAt: NOW.toISOString(), proposed: { playlist: ['no_mercy', 'dead_air'], minutes: 120, fits: true },
    }]);
    const theirs = board(db, viewer(P[1]), { now: NOW })[0];
    expect(theirs).toMatchObject({ mine: false, accepts: null, myAcceptId: a });
  });

  it('a direct challenge is seen by the poster and the target team\'s managers only', () => {
    const rats = team(P[0], 'Rats', 'RR', [P[4]]);
    const mice = team(P[1], 'Mice', 'MM', [P[2], P[3]]);
    setRole(db, { teamId: mice, by: P[1], target: P[2], role: 'cocaptain' });
    db.prepare('UPDATE players SET is_admin = 1 WHERE steamid = ?').run(P[6]);
    const id = post({ teamId: rats, targetTeamId: mice });
    const sees = (who: string | null, staff = false) => board(db, viewer(who, staff), { now: NOW }).some((p) => p.id === id);
    expect(sees(P[0])).toBe(true); // poster
    expect(sees(P[4])).toBe(false); // a plain member of the posting team
    expect(sees(P[1])).toBe(true); // target captain
    expect(sees(P[2])).toBe(true); // target co-captain
    expect(sees(P[3])).toBe(false); // target plain member
    expect(sees(P[5])).toBe(false); // stranger
    expect(sees(P[6], true)).toBe(false); // staff
    expect(sees(null)).toBe(false);
    expect(board(db, viewer(P[1]), { now: NOW })[0].challenge).toEqual({ teamId: mice, name: 'Mice' });
  });

  it('a team post is "mine" for every current manager of the team', () => {
    const rats = team(P[0], 'Rats', 'RR', [P[2]]);
    setRole(db, { teamId: rats, by: P[0], target: P[2], role: 'cocaptain' });
    post({ teamId: rats });
    expect(board(db, viewer(P[2]), { now: NOW })[0].mine).toBe(true);
  });

  it('fitsOnly uses the first team the viewer captains, else their own SR, and keeps their own posts', () => {
    rate(P[0], 25); // 1500
    rate(P[1], 20); // 1000
    rate(P[2], 30); // 2000
    rate(P[3], 26); // 1600
    rate(P[4], 22); // 1200
    const narrow = post({ srRange: 200 }); // 1300..1700
    const open = post({ by: P[1], srRange: null, startsAt: '2026-10-03T20:00:00.000Z' });
    const ids = (who: string, fitsOnly = true) => board(db, viewer(who), { now: NOW, fitsOnly }).map((p) => p.id);
    expect(ids(P[3])).toEqual([narrow, open]); // 1600 fits
    expect(ids(P[2])).toEqual([open]); // 2000 alone does not
    expect(ids(P[2], false)).toEqual([narrow, open]); // the filter off
    // Captaining a team averaging (2000 + 1200) / 2 = 1600, P[2] is judged as the team.
    team(P[2], 'Hawks', 'HK', [P[4]]);
    expect(ids(P[2])).toEqual([narrow, open]);
    // A member who captains nothing is judged alone: P[4] at 1200.
    expect(ids(P[4])).toEqual([open]);
    // The viewer's own post stays even when their side would not fit it.
    const own = post({ by: P[3], srRange: 50, startsAt: '2026-10-04T20:00:00.000Z' }); // 1550..1650
    db.prepare('UPDATE player_ratings SET mu = 40 WHERE player_id = ?').run(P[3]); // now 3000
    expect(ids(P[3])).toContain(own);
    expect(ids(P[0])).not.toContain(own);
  });
});

describe('review fix round 1', () => {
  it('refuses an accept within 30 minutes of the start', () => {
    const id = post();
    expect(err(acceptPost(db, { postId: id, by: P[1], now: at(START, -30) }))).toBe('too_late');
    expect(err(acceptPost(db, { postId: id, by: P[1], now: at(START, -1) }))).toBe('too_late');
    expect(err(acceptPost(db, { postId: id, by: P[1], now: at(START, -31) }))).toBe('ok');
  });

  it('a side holds at most 3 open or pending posts', () => {
    const days = ['2026-10-02T20:00:00.000Z', '2026-10-03T20:00:00.000Z', '2026-10-04T20:00:00.000Z', '2026-10-05T20:00:00.000Z'];
    const first = post({ startsAt: days[0] });
    accept(first, P[5]); // pending still counts
    post({ startsAt: days[1] });
    post({ startsAt: days[2] });
    expect(err(createPost(db, postInput({ startsAt: days[3] })))).toBe('too_many_posts');
    value(withdrawPost(db, { postId: first, by: P[0], now: NOW }));
    expect(err(createPost(db, postInput({ startsAt: days[3] })))).toBe('ok');
  });

  it('the post limit counts a team by team, apart from its captain\'s pickup posts', () => {
    const rats = team(P[0], 'Rats', 'RR', [P[2]]);
    setRole(db, { teamId: rats, by: P[0], target: P[2], role: 'cocaptain' });
    for (const d of ['2026-10-02T20:00:00.000Z', '2026-10-03T20:00:00.000Z', '2026-10-04T20:00:00.000Z']) post({ teamId: rats, startsAt: d });
    expect(err(createPost(db, postInput({ by: P[2], teamId: rats, startsAt: '2026-10-05T20:00:00.000Z' })))).toBe('too_many_posts');
    expect(err(createPost(db, postInput({ startsAt: '2026-10-05T20:00:00.000Z' })))).toBe('ok'); // P[0] as a pickup
  });

  it('confirm refuses an acceptance past its 2 hours, before any tick has run', () => {
    const id = post();
    const a = accept(id, P[1]);
    expect(err(confirmAccept(db, { acceptId: a, by: P[0], now: at(NOW.toISOString(), 120) }))).toBe('wrong_state');
    expect(bookingCount()).toBe(0);
    expect(acceptRow(a).status).toBe('pending');
    expect(confirmAccept(db, { acceptId: a, by: P[0], now: at(NOW.toISOString(), 119) }).ok).toBe(true);
  });

  it('confirm refuses an acceptance past the 30 minute cutoff, before any tick has run', () => {
    const id = post();
    const a = value(acceptPost(db, { postId: id, by: P[1], now: at(START, -60) })).id;
    expect(err(confirmAccept(db, { acceptId: a, by: P[0], now: at(START, -30) }))).toBe('wrong_state');
    expect(bookingCount()).toBe(0);
    expect(confirmAccept(db, { acceptId: a, by: P[0], now: at(START, -31) }).ok).toBe(true);
  });

  it('a hidden challenge answers not_found to anyone managing neither side', () => {
    const rats = team(P[0], 'Rats', 'RR', [P[4]]);
    const mice = team(P[1], 'Mice', 'MM', [P[3]]);
    const id = post({ teamId: rats, targetTeamId: mice });
    const a = accept(id, P[1], { teamId: mice });
    for (const who of [P[5], P[4], P[3]]) {
      expect(err(withdrawPost(db, { postId: id, by: who, now: NOW }))).toBe('not_found');
      expect(err(withdrawAccept(db, { acceptId: a, by: who, now: NOW }))).toBe('not_found');
      expect(err(declineAccept(db, { acceptId: a, by: who, now: NOW }))).toBe('not_found');
      expect(err(confirmAccept(db, { acceptId: a, by: who, now: NOW }))).toBe('not_found');
    }
    // Each side's managers can see it, so they get the ordinary answer.
    expect(err(withdrawPost(db, { postId: id, by: P[1], now: NOW }))).toBe('not_manager');
    expect(err(withdrawAccept(db, { acceptId: a, by: P[0], now: NOW }))).toBe('not_manager');
    expect(err(confirmAccept(db, { acceptId: a, by: P[1], now: NOW }))).toBe('not_manager');
    // A public post still says not_manager to a stranger.
    const pub = post({ by: P[6] });
    expect(err(withdrawPost(db, { postId: pub, by: P[5], now: NOW }))).toBe('not_manager');
  });

  it('a public post of a disbanded team leaves the board, cannot be accepted, and is withdrawn by expire', () => {
    const rats = team(P[0], 'Rats', 'RR');
    const id = post({ teamId: rats });
    const a = accept(id, P[1]);
    disbandTeam(db, { teamId: rats, by: P[0], now: NOW });
    expect(board(db, { steamid: P[5], staff: false }, { now: NOW }).map((p) => p.id)).not.toContain(id);
    expect(err(acceptPost(db, { postId: id, by: P[5], now: NOW }))).toBe('not_found');
    expect(expire(db, NOW)).toEqual({ posts: [], accepts: [], withdrawn: { posts: [id], accepts: [a] } });
    expect(postRow(id).status).toBe('withdrawn');
    expect(acceptRow(a)).toMatchObject({ status: 'withdrawn', responded_at: NOW.toISOString() });
    expect(expire(db, NOW)).toEqual({ posts: [], accepts: [], withdrawn: { posts: [], accepts: [] } });
  });

  it('a challenge to a disbanded team leaves the board, cannot be accepted, and is withdrawn by expire', () => {
    const rats = team(P[0], 'Rats', 'RR');
    const mice = team(P[1], 'Mice', 'MM');
    const id = post({ teamId: rats, targetTeamId: mice });
    disbandTeam(db, { teamId: mice, by: P[1], now: NOW });
    expect(board(db, { steamid: P[0], staff: false }, { now: NOW }).map((p) => p.id)).not.toContain(id);
    expect(err(acceptPost(db, { postId: id, by: P[1], teamId: mice, now: NOW }))).toBe('not_found');
    expect(expire(db, NOW)).toEqual({ posts: [], accepts: [], withdrawn: { posts: [id], accepts: [] } });
    expect(postRow(id).status).toBe('withdrawn');
  });

  it('a booking refusal from a confirm keeps the booking\'s own text', () => {
    const id = post();
    const a = accept(id, P[1]);
    db.prepare("UPDATE players SET status = 'banned' WHERE steamid = ?").run(P[1]);
    expect(confirmAccept(db, { acceptId: a, by: P[0], now: NOW }))
      .toEqual({ ok: false, error: 'not_player', text: BOOKING_ERRORS.not_player.text });
    const id2 = post({ by: P[2], startsAt: '2026-10-03T20:00:00.000Z' });
    const a2 = accept(id2, P[3]);
    fillSlotAt('2026-10-03T20:00:00.000Z');
    const r = confirmAccept(db, { acceptId: a2, by: P[2], now: NOW });
    expect(r).toMatchObject({ ok: false, error: 'no_capacity', text: BOOKING_ERRORS.no_capacity.text });
    // A refusal of the scrim's own carries no booking text.
    expect(confirmAccept(db, { acceptId: a2, by: P[3], now: NOW })).toEqual({ ok: false, error: 'not_manager' });
  });
});
