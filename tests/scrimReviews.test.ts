import { describe, it, expect, beforeEach } from 'vitest';
import { openDb, type DB } from '../src/db.js';
import { addServer } from '../src/serverPool.js';
import { setSetting } from '../src/settings.js';
import { createTeam, invitePlayer, respondInvite } from '../src/teams/teams.js';
import { bookingView, cancelBooking, confirmBooking, createBooking, getBooking, sideRow } from '../src/bookings/bookings.js';
import { reviewAskMessage } from '../src/bookings/messages.js';
import { NOTIFY_TYPES } from '../src/notify/notify.js';
import {
  REVIEW_TAGS, REVIEW_TAG_LABELS, reviewSummary, scrimReviewsOf, staffReviews, submitReview, toxicFlag,
} from '../src/scrims/reviews.js';

const P = Array.from({ length: 12 }, (_, i) => `765611990000018${String(i).padStart(2, '0')}`);
const STAFF = P[11];
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
let db: DB;

beforeEach(() => {
  db = openDb(':memory:');
  const ins = db.prepare("INSERT INTO players (steamid, name, status) VALUES (?, ?, 'active')");
  P.forEach((id, i) => ins.run(id, `p${i}`));
  db.prepare('UPDATE players SET is_mod = 1 WHERE steamid = ?').run(STAFF);
  setSetting(db, 'competitive_enabled', 'everyone');
  setSetting(db, 'map_pool', JSON.stringify(['no_mercy', 'death_toll']));
  for (const n of ['a', 'bb', 'ccc', 'dddd']) {
    const id = addServer(db, { name: n, host: 'h', port: 27000 + n.length, rconPort: 1, rconPassword: 'x' });
    db.prepare("UPDATE servers SET status = 'idle' WHERE id = ?").run(id);
  }
});

const team = (captain: string, name: string, tag: string, members: string[] = []) => {
  const t = createTeam(db, { creator: captain, name, tag, now: new Date('2026-08-01T00:00:00.000Z') });
  if (!t.ok) throw new Error(t.error);
  for (const m of members) {
    const inv = invitePlayer(db, { teamId: t.value.id, by: captain, target: m, now: new Date('2026-08-01T00:00:00.000Z') });
    if (!inv.ok) throw new Error(inv.error);
    respondInvite(db, { inviteId: inv.value.inviteId, steamid: m, accept: true, now: new Date('2026-08-01T00:00:00.000Z') });
  }
  return t.value.id;
};

/** A confirmed booking starting at `start`, made a day ahead. */
const booked = (start: number, o: { by?: string; opponent?: object; teamId?: number } = {}) => {
  const r = createBooking(db, {
    by: o.by ?? P[0], teamId: o.teamId, opponent: o.opponent ?? { steamid: P[1] }, startsAt: new Date(start).toISOString(),
    minutes: 60, playlist: ['no_mercy'], now: new Date(start - DAY),
  });
  if (!r.ok) throw new Error(r.error);
  const id = r.value.id;
  const s = sideRow(db, id, 'b')!;
  const confirmer = s.team_id !== null
    ? (db.prepare('SELECT captain_steamid AS c FROM teams WHERE id = ?').get(s.team_id) as { c: string }).c
    : s.captain_steamid;
  const c = confirmBooking(db, { bookingId: id, by: confirmer, now: new Date(start - DAY) });
  if (!c.ok) throw new Error(c.error);
  return id;
};
/** Closed 30 minutes after its start, as ended (or no_show), with the box back. */
const closed = (id: number, state: 'ended' | 'no_show' = 'ended') => {
  const end = new Date(Date.parse(getBooking(db, id)!.starts_at) + 30 * 60_000).toISOString();
  db.prepare('UPDATE bookings SET state = ?, end_reason = ?, ending_at = ?, ended_at = ? WHERE id = ?').run(state, state === 'ended' ? 'time' : 'no_show', end, end, id);
  return Date.parse(end);
};
const START = Date.parse('2026-10-02T20:00:00.000Z');

describe('submitReview', () => {
  it('a side manager submits, then edits the same row', () => {
    const id = booked(START);
    const end = closed(id);
    const r = submitReview(db, { bookingId: id, by: P[0], thumbs: 1, tags: ['on_time', 'good_comms'], now: new Date(end + HOUR) });
    expect(r).toEqual({ ok: true, value: { side: 'a' } });
    const r2 = submitReview(db, { bookingId: id, by: P[0], thumbs: -1, tags: ['left_early'], now: new Date(end + 2 * HOUR) });
    expect(r2).toEqual({ ok: true, value: { side: 'a' } });
    const rows = staffReviews(db, id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ side: 'a', reviewer: P[0], thumbs: -1, tags: ['left_early'] });
    expect(rows[0].createdAt).toBe(new Date(end + HOUR).toISOString());
    expect(rows[0].updatedAt).toBe(new Date(end + 2 * HOUR).toISOString());
  });

  it('a no_show booking can be reviewed too; the window closes 7 days after the close', () => {
    const id = booked(START);
    const end = closed(id, 'no_show');
    expect(submitReview(db, { bookingId: id, by: P[1], thumbs: 1, tags: [], now: new Date(end + 7 * DAY - 1) }).ok).toBe(true);
    expect(submitReview(db, { bookingId: id, by: P[1], thumbs: 1, tags: [], now: new Date(end + 7 * DAY) }))
      .toEqual({ ok: false, error: 'review_closed' });
  });

  it('refuses a non-manager, and a team member who is not a captain or co-captain', () => {
    const t = team(P[2], 'Rats', 'RR', [P[3]]);
    const id = booked(START, { by: P[2], teamId: t });
    const end = closed(id);
    expect(submitReview(db, { bookingId: id, by: P[5], thumbs: 1, tags: [], now: new Date(end + HOUR) })).toEqual({ ok: false, error: 'not_manager' });
    expect(submitReview(db, { bookingId: id, by: P[3], thumbs: 1, tags: [], now: new Date(end + HOUR) })).toEqual({ ok: false, error: 'not_manager' });
    expect(submitReview(db, { bookingId: id, by: STAFF, thumbs: 1, tags: [], now: new Date(end + HOUR) })).toEqual({ ok: false, error: 'not_manager' });
    expect(submitReview(db, { bookingId: id, by: P[2], thumbs: 1, tags: [], now: new Date(end + HOUR) })).toEqual({ ok: true, value: { side: 'a' } });
  });

  it('refuses someone who manages both sides: they cannot review either one', () => {
    const t = team(P[1], 'Rats', 'RR');
    const id = booked(START, { by: P[0], opponent: { teamId: t } });
    const end = closed(id);
    // P[0] captains pickup side a and later becomes a co-captain of side b's team.
    db.prepare("INSERT INTO team_members (team_id, steamid, role, joined_at) VALUES (?, ?, 'cocaptain', ?)").run(t, P[0], new Date(end).toISOString());
    expect(submitReview(db, { bookingId: id, by: P[0], thumbs: -1, tags: ['toxic'], now: new Date(end + HOUR) })).toEqual({ ok: false, error: 'not_manager' });
    expect(staffReviews(db, id)).toEqual([]);
    expect(bookingView(db, id, { steamid: P[0], staff: false })!.review).toBeUndefined();
    expect(submitReview(db, { bookingId: id, by: P[1], thumbs: 1, tags: [], now: new Date(end + HOUR) })).toEqual({ ok: true, value: { side: 'b' } });
  });

  it('refuses bad thumbs and bad tags', () => {
    const id = booked(START);
    const now = new Date(closed(id) + HOUR);
    for (const thumbs of [0, 2, '1', null, undefined, true]) {
      expect(submitReview(db, { bookingId: id, by: P[0], thumbs, tags: [], now }), String(thumbs)).toEqual({ ok: false, error: 'bad_review' });
    }
    for (const tags of ['on_time', ['nice'], ['on_time', 'on_time'], [1], null, { 0: 'toxic' }, [...REVIEW_TAGS, 'toxic']]) {
      expect(submitReview(db, { bookingId: id, by: P[0], thumbs: 1, tags, now }), JSON.stringify(tags)).toEqual({ ok: false, error: 'bad_review' });
    }
    expect(submitReview(db, { bookingId: id, by: P[0], thumbs: 1, tags: [...REVIEW_TAGS], now }).ok).toBe(true);
    expect(staffReviews(db, id)).toHaveLength(1);
  });

  it('a cancelled or still open booking is wrong_state, and an unknown one not_found', () => {
    const cancelled = booked(START);
    cancelBooking(db, { bookingId: cancelled, by: P[0], now: new Date(START - 5 * HOUR) });
    expect(submitReview(db, { bookingId: cancelled, by: P[1], thumbs: 1, tags: [], now: new Date(START) })).toEqual({ ok: false, error: 'wrong_state' });
    const open = booked(START + DAY);
    expect(submitReview(db, { bookingId: open, by: P[1], thumbs: 1, tags: [], now: new Date(START) })).toEqual({ ok: false, error: 'wrong_state' });
    expect(submitReview(db, { bookingId: 999, by: P[1], thumbs: 1, tags: [], now: new Date(START) })).toEqual({ ok: false, error: 'not_found' });
  });

  it('a tournament booking cannot be reviewed', () => {
    const id = booked(START);
    const end = closed(id);
    db.prepare("UPDATE bookings SET purpose = 'tournament' WHERE id = ?").run(id);
    expect(submitReview(db, { bookingId: id, by: P[0], thumbs: 1, tags: [], now: new Date(end + HOUR) })).toEqual({ ok: false, error: 'wrong_state' });
  });

  it('labels every tag', () => {
    expect(REVIEW_TAGS).toEqual(['on_time', 'good_comms', 'good_sport', 'left_early', 'toxic']);
    expect(REVIEW_TAGS.map((t) => REVIEW_TAG_LABELS[t])).toEqual(['On time', 'Good comms', 'Good sport', 'Left early', 'Toxic']);
  });
});

describe('reviewSummary', () => {
  /** One booking per review against side b's party, reviewed by side a. */
  const review = (day: number, thumbs: 1 | -1, tags: string[], o: { teamId?: number; by?: string; opponent?: object } = {}) => {
    const id = booked(START + day * DAY, { by: o.by, opponent: o.opponent, teamId: o.teamId });
    const end = closed(id);
    const r = submitReview(db, { bookingId: id, by: o.by ?? P[0], thumbs, tags, now: new Date(end + HOUR) });
    if (!r.ok) throw new Error(r.error);
    return id;
  };

  it('has no percentage or top tag under 3 reviews', () => {
    expect(reviewSummary(db, { captain: P[1] }, { staff: true })).toEqual({ count: 0, positivePct: null, topTag: null });
    review(0, 1, ['on_time']);
    review(1, -1, ['on_time']);
    expect(reviewSummary(db, { captain: P[1] }, { staff: true })).toEqual({ count: 2, positivePct: null, topTag: null });
  });

  it('at 3 and above: the rounded percentage positive and the most common tag, counting only reviews received', () => {
    review(0, 1, ['on_time', 'good_sport']);
    review(1, 1, ['good_sport']);
    review(2, -1, ['left_early']);
    // P[1] reviewing P[0] is not a review P[1] received.
    const back = booked(START + 3 * DAY);
    const end = closed(back);
    submitReview(db, { bookingId: back, by: P[1], thumbs: -1, tags: ['toxic'], now: new Date(end + HOUR) });
    expect(reviewSummary(db, { captain: P[1] }, { staff: true })).toEqual({ count: 3, positivePct: 67, topTag: 'good_sport' });
    expect(reviewSummary(db, { captain: P[0] }, { staff: true })).toEqual({ count: 1, positivePct: null, topTag: null });
  });

  it('a non-staff viewer gets no count under 3, only "not enough yet"; at 3 the count comes back', () => {
    const member = { staff: false };
    expect(reviewSummary(db, { captain: P[1] }, member)).toEqual({ positivePct: null, topTag: null });
    review(0, 1, ['on_time']);
    review(1, -1, ['on_time']);
    const two = reviewSummary(db, { captain: P[1] }, member);
    expect(two).toEqual({ positivePct: null, topTag: null });
    expect('count' in two).toBe(false);
    review(2, 1, ['on_time']);
    expect(reviewSummary(db, { captain: P[1] }, member)).toEqual({ count: 3, positivePct: 67, topTag: 'on_time' });
  });

  it('a team party collects reviews of its team sides, not its captain\'s pickup sides', () => {
    const t = team(P[1], 'Rats', 'RR');
    review(0, 1, ['good_comms'], { opponent: { teamId: t } });
    review(1, 1, ['good_comms'], { opponent: { teamId: t } });
    review(2, -1, [], { opponent: { teamId: t } });
    review(3, -1, ['toxic']);
    expect(reviewSummary(db, { teamId: t }, { staff: true })).toEqual({ count: 3, positivePct: 67, topTag: 'good_comms' });
    expect(reviewSummary(db, { captain: P[1] }, { staff: true })).toEqual({ count: 1, positivePct: null, topTag: null });
  });
});

describe('toxicFlag', () => {
  const toxicFrom = (start: number, by: string) => {
    const id = booked(start, { by });
    const end = closed(id);
    const r = submitReview(db, { bookingId: id, by, thumbs: -1, tags: ['toxic'], now: new Date(end + HOUR) });
    if (!r.ok) throw new Error(r.error);
    // The other side's review of the same booking never adds a second booking.
    return id;
  };
  const NOW = START + 30 * DAY;

  it('flags at 3 toxic tags from distinct bookings inside 60 days', () => {
    toxicFrom(START, P[0]);
    toxicFrom(START + DAY, P[2]);
    expect(toxicFlag(db, { captain: P[1] }, NOW)).toBe(false);
    toxicFrom(START + 2 * DAY, P[3]);
    expect(toxicFlag(db, { captain: P[1] }, NOW)).toBe(true);
    expect(toxicFlag(db, { captain: P[0] }, NOW)).toBe(false);
  });

  it('old tags age out after 60 days', () => {
    toxicFrom(START, P[0]);
    toxicFrom(START + DAY, P[2]);
    toxicFrom(START + 2 * DAY, P[3]);
    // The first was given an hour and a half after START; 60 days later it is out.
    expect(toxicFlag(db, { captain: P[1] }, START + 60 * DAY)).toBe(true);
    expect(toxicFlag(db, { captain: P[1] }, START + 61 * DAY)).toBe(false);
  });

  it('a toxic tag without a thumbs-down still counts; other tags do not', () => {
    for (const [i, by] of [P[0], P[2], P[3]].entries()) {
      const id = booked(START + i * DAY, { by });
      const end = closed(id);
      submitReview(db, { bookingId: id, by, thumbs: 1, tags: i === 2 ? ['left_early'] : ['toxic'], now: new Date(end + HOUR) });
    }
    expect(toxicFlag(db, { captain: P[1] }, NOW)).toBe(false);
  });
});

describe('scrimReviewsOf (staff People desk)', () => {
  it('summaries and toxic flags for the pickup captain and each current team', () => {
    const t = team(P[1], 'Rats', 'RR');
    const out = scrimReviewsOf(db, P[1], START);
    expect(out).toEqual({
      pickup: { summary: { count: 0, positivePct: null, topTag: null }, toxic: false },
      teams: [{ teamId: t, slug: 'rats', name: 'Rats', tag: 'RR', summary: { count: 0, positivePct: null, topTag: null }, toxic: false }],
    });
  });
});

describe('bookingView privacy', () => {
  it('a manager sees only their own side\'s review; nobody but staff gets reviews', () => {
    const id = booked(START);
    const now = closed(id) + HOUR;
    submitReview(db, { bookingId: id, by: P[0], thumbs: -1, tags: ['toxic'], now: new Date(now) });
    const a = bookingView(db, id, { steamid: P[0], staff: false }, now)!;
    expect(a.review).toEqual({ open: true, mine: { thumbs: -1, tags: ['toxic'] } });
    expect(a).not.toHaveProperty('reviews');
    const b = bookingView(db, id, { steamid: P[1], staff: false }, now)!;
    expect(b.review).toEqual({ open: true, mine: null });
    expect(b).not.toHaveProperty('reviews');
    expect(JSON.stringify(b)).not.toContain('toxic');
    const s = bookingView(db, id, { steamid: STAFF, staff: true }, now)!;
    expect(s).not.toHaveProperty('review');
    expect(s.reviews).toEqual([expect.objectContaining({ side: 'a', reviewer: P[0], reviewerName: 'p0', thumbs: -1, tags: ['toxic'] })]);
  });

  it('no review block before the close or on a cancelled booking; closed once the window is over', () => {
    const id = booked(START);
    expect(bookingView(db, id, { steamid: P[0], staff: false }, START)).not.toHaveProperty('review');
    const old = booked(START + DAY);
    const end = closed(old);
    submitReview(db, { bookingId: old, by: P[0], thumbs: 1, tags: [], now: new Date(end) });
    expect(bookingView(db, old, { steamid: P[0], staff: false }, end + 7 * DAY)!.review).toEqual({ open: false, mine: { thumbs: 1, tags: [] } });
    const cancelled = booked(START + 2 * DAY);
    cancelBooking(db, { bookingId: cancelled, by: P[0], now: new Date(START) });
    expect(bookingView(db, cancelled, { steamid: P[0], staff: false }, START + 3 * DAY)).not.toHaveProperty('review');
  });
});

describe('the review DM', () => {
  it('names the other side, links the booking, and has its own notify type', () => {
    const t = team(P[1], 'Rats', 'RR');
    const id = booked(START, { opponent: { teamId: t } });
    const toA = reviewAskMessage(db, 'https://x.test', id, 'a')!;
    expect(toA.content).toBe('How was Rats? Leave a quick private review on the booking page. Only staff see single reviews.');
    expect(toA.components).toEqual([[{ kind: 'link', url: `https://x.test/booking/${id}`, label: 'Open the booking' }]]);
    expect(reviewAskMessage(db, 'https://x.test', id, 'b')!.content).toBe("How was p0's group? Leave a quick private review on the booking page. Only staff see single reviews.");
    expect(NOTIFY_TYPES.find((n) => n.type === 'scrim_review')?.label).toBe('Review my scrim opponent after a booked scrim');
  });
});
