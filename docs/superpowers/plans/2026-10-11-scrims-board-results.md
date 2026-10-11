# Scrim board fixes, reviews and series results Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix what the first live scrim (booking 2, 2026-10-11) showed: one side holding two slots at once, a silent post form, slot estimates far below real campaign lengths, endorsements offered on scrims, review tags the other team cannot judge, and no series result.

**Architecture:**
- One rule, "a side never holds two slots at once", is enforced at two layers. The booking layer (`createBooking`, `confirmBooking`) refuses a booking either party is already booked over. The scrim board (`createPost`, `acceptPost`) refuses up front with scrim wording, and `confirmAccept` withdraws both sides' other overlapping posts and acceptances once a booking is made.
- `confirmAccept` now says whose side a refusal is about, and declines an acceptance that can never be booked.
- Campaign length estimates (`typicalCampaignMinutes`) use measured whole-campaign games of any kind once a campaign has 5 of them, and fall back to today's PUG-only figure.
- `endorsements.gate()` refuses any match that is not a PUG.
- Reviews offer a new tag set (stored old tags stay readable) and a staff-only note that goes through the conduct alert path chat uses.
- A new pure module, `src/bookings/series.ts`, tallies a booking's games into a series result. The booking page, the team Scrims panel and a new private DM to both sides use it.

**Tech Stack:** TypeScript, Fastify 5, better-sqlite3, vitest, Preact.

**Spec:** the owner's items 1, 2, 6, 11, 12 and 15 from the first live scrim, plus four audit findings handed over on 2026-10-11 (see "Context" below). Background: `docs/superpowers/specs/2026-09-30-competitive-scrims-design.md`, `docs/superpowers/plans/2026-10-01-scrim-board-1-posts-and-accepts.md` and `docs/superpowers/plans/2026-10-01-scrim-board-2-reliability-reviews.md`.

## Context

The first live scrim was booking 2: big BAD boys (team 3, booking side a) against Test (team 1, side b). They played Dark Wood (match 644, Test won 347-250) and then Blood Harvest (match 645, big BAD boys won 893-328). `matches.booking_side_a` is `'b'` for both games.

The owner's items:
1. **No open post while holding a booked slot.** Big BAD boys posted the same scrim twice, 6 seconds apart (posts 3 and 4). Post 3 was booked; post 4 stayed open.
2. **The post form gives no feedback.** It neither resets nor confirms after a successful post.
6. **Real campaign lengths.** The board said "about 2 h 30" for Dark Wood plus Blood Harvest, but Dark Wood alone took 90 minutes.
11. **No endorsements for scrims.**
12. **Scrim reviews:**
    - Drop Good comms, since the other team never hears a side's voice.
    - Add the tags Easy to schedule and Flexible.
    - Add a staff-only note of at most 300 characters, checked for slurs.
15. **Series result.** Show it on the booking page and the team Scrims panel, and DM both sides privately.

Audit findings handed over on 2026-10-11:
- **(a)** One side can be booked twice over the same time through overlapping acceptances or direct bookings.
- **(b)** A side can re-accept right after a decline, and there is no cap on its pending acceptances.
- **(c)** Refusals from the accepting side's confirm step reach the poster in wording that reads as the poster's own side. Refusals that can never clear should decline the acceptance.
- **(d)** Re-post can be clicked repeatedly, and is offered after the start.

## Global Constraints

- Never use em dashes anywhere: code, comments, docs, UI copy, test names, commit messages. Replace by meaning (a colon, a comma, a full stop, "to").
- Match the surrounding code: its comment density, naming and idioms. Use `Result`/`fail`/`ok` with `{ status, text }` error maps, and keep the block comments that say why.
- Commit messages are plain one-sentence descriptions. Stage only the files the task names, and never run `git commit -a`: other sessions leave edits in shared checkouts.
- Migrations are additive and idempotent: use `ensureColumn` for new columns on existing tables, as `src/db.ts` already does. Add no settings rows; every new number in this plan is a module constant, as `SCRIM_MAX_OPEN_POSTS` is.
- Scrims stay private. Nothing in this plan posts to a public Discord channel, and no individual review, note or series result reaches anyone outside the two sides and staff.
- Do not ssh, deploy, restart, rcon or touch production. Run tests with `npx vitest run <path>` and types with `npm run typecheck` in this worktree only.
- **Merge overlap, compete-nav branch:** it adds a tab strip header to `web/src/routes/Scrims.tsx` and `web/src/routes/Bookings.tsx`, and edits `Nav.tsx`. Keep the `Scrims.tsx` changes inside `PostForm` and inside the `post` and `confirm` handlers of `Scrims()`. Do not touch the page header, imports order beyond what is needed, or `Bookings.tsx`.
- **Merge overlap, compete-sweep branch:** it edits `expire()` in `src/scrims/scrims.ts` and omits SR server-side when `scrim_show_sr` is off (in `board()` and the messages). Do not change `expire()`, `board()` or any SR code. This plan adds code next to them in the same file, and both branches add entries to `SCRIM_ERRORS`, so expect a textual merge there.

## Rulings made while writing (owner to confirm)

1. **"Holds a booked slot" means a confirmed side of an open booking.** An open booking is one in state scheduled, held, setup, ready or active, with no end started. An invite the side has not confirmed yet does not count. Bookings of every purpose count, tournaments included: a team in a tournament match cannot scrim at the same time. A creator's side is confirmed at creation, so a booking the side made that is still waiting on the other side counts for it.
2. **Overlap** is half-open, as with server capacity: a post ending exactly when a booking starts, or starting exactly when it ends, is fine.
3. **Sides are counted separately.** A team and its captain's pickup group are different sides. A team's booking does not stop its captain posting as a pickup, and the reverse holds too, as with the existing open-post limit.
4. **An acceptance is checked against the post's block** (`block_minutes`), not the longer slot the merged playlist might make. The confirm checks the real slot through the booking layer.
5. **Exact duplicate** means the same side, the same `starts_at`, and an open or pending post, whether it is public or a challenge.
6. **Cooldown after a decline:** 60 minutes (`ACCEPT_COOLDOWN_MS`). It applies to the same side on the same post after the poster declined it, or after a confirm declined it automatically (ruling 9). A side withdrawing its own acceptance has no cooldown.
7. **Pending acceptance cap:** 3 per side across all posts (`SCRIM_MAX_PENDING_ACCEPTS`). This mirrors the existing 3 open posts per side.
8. **Auto-withdraw notices:**
   - The withdrawn post's side gets a new `scrim_withdrawn` DM saying why.
   - Third parties whose acceptances went with that post get the ordinary `scrim_declined` DM, with the reason "the posting side booked another scrim at that time".
   - The booked side's own withdrawn acceptances get `scrim_withdrawn`.
   - The poster of the post such an acceptance was on is not DMed, the same as when a side withdraws an acceptance by hand. Their post shows open again on the board.
9. **Refusals that never clear:** `not_open`, `not_player`, `bad_opponent` and `not_available` decline the acceptance right after the rolled-back confirm. The accepting side gets `scrim_declined` with the reason "it could not be booked". `not_available` keeps its existing text ("This scrim is not available to you."), which never says why.
10. **Re-post** is refused `too_late` once the start is 30 minutes away or past, and the button is hidden from that point. A second re-post for the same side and start is refused `duplicate_post`, and the button is hidden once that side already has an open post at that start.
11. **Measured campaign length:**
    - The median of the last 20 completed games of any kind that played the whole campaign, used once there are at least 5 of them. Below that, today's PUG-only median applies.
    - "Whole campaign" means all of these: completed (never aborted, and so never voided, since a voided game is stored as aborted); not a `!gg` forfeit; not replayed from a later map after a restart (`restored_at_map`); and a `match_maps` row for every map the campaign has, or at least one when the registry does not list its maps.
    - Going live is `went_live_at` when the site set the match up. Otherwise it is `created_at`, because an adopted match (an in-game PUG, every booking game) never stamps `went_live_at` and its row is created at go-live.
    - The 10 minute to 4 hour sanity window is kept.
12. **Endorsements on a non-PUG:** refused with a new error `not_pug`, checked right after `no_match`, so a scrim reads "Endorsements are for PUGs only" rather than any later reason.
13. **Review tags:**
    - Offered, in order: On time, Easy to schedule, Flexible, Good sport, Left early, Toxic.
    - Good comms is retired: never offered, refused on submit, but still read from stored rows and labelled for staff and the aggregate.
    - On an edit, the form drops a stored retired tag rather than sending it, so the save is not refused.
    - Flexible shows the hint "OK with map, side or sub changes" as its tooltip.
14. **Review note visibility:**
    - Staff see it on the booking page's staff review list.
    - The reviewing side's own managers get their own note back in the edit form, since they wrote it and the form would otherwise blank it on every edit.
    - Nobody else ever sees it: not the reviewed side, not plain members, not the aggregate.
    - An empty or missing note clears it.
15. **Slur in a review note:**
    - The note is saved as written, since only staff read it.
    - It is stored as a conduct flag (source `conduct`, kind `review`) on the reviewer's player file, and posted to the mod channel, the way a chat line is.
    - Posting is rationed once per player per exact text, as names are, so re-saving the same review posts nothing new.
16. **Series result:**
    - A game counts once it completed. Aborted and voided games never count. A live game does not count yet.
    - Each game's winner comes from `matches.winner` through that game's own `booking_side_a` (null reads as side a, as everywhere else), falling back to the scores.
    - The line is "<first> W - L <second>", with ", 1 draw" or ", N draws" added when a game was a draw.
    - On the booking page, the viewer's own side comes first (side a for staff and outsiders), and the game rows follow the same order. On the team panel, the team comes first.
17. **Series result DM:**
    - A new notify type, `scrim_result`, labelled "A scrim I played in finished, with the series result".
    - It goes to each side's managers and accepted people, oriented to that side, once the scrim's box is back, when at least one game counted.
    - It goes out once per booking (event `result_sent`), for every close state, and never for a tournament booking, which has its own result notices.
18. **Booking-layer overlap wording:** `busy_us` reads "Your side already has a booking at that time." and `busy_them` reads "The other side already has a booking at that time." Tournament bookings made by the series engine are not refused by this check, but they do count as busy for everyone else.
19. **+1 campaign** (`addCampaign`) is not checked for overlap with the side's next booking. Capacity still applies, and this is left for a later plan.

## Review Focus

- **Back-to-back slots:** a post or booking that ends exactly when another of the same side starts must be allowed. Pinned in Task 1 (booking layer) and Task 2 (posts).
- **Team and pickup are different sides:** a team's booking must not stop its captain posting as a pickup. Pinned in Task 2.
- **Two posters confirming one side:** after one confirm books side X, a second poster confirming X's other overlapping acceptance must fail cleanly, with nothing kept. Pinned in Task 3.
- **A stored retired tag on edit:** a reviewer whose stored review holds Good comms must be able to edit and save from the form. Pinned in Task 10 (web drops it) and Task 8 (server refuses it on submit).
- **No counted games:** a booking whose games were all aborted shows no series line and sends no result DM, and a drawn game reads sensibly. Pinned in Tasks 11 and 13.

---

### Task 1: The booking layer refuses a side that is already booked over the slot

**Files:**
- Modify: `src/bookings/rules.ts` (add `bookedDuring` after `upcomingCount`)
- Modify: `src/bookings/bookings.ts` (`BOOKING_ERRORS`, `createBooking`, `confirmBooking`, and the `./rules.js` import)
- Modify: `tests/bookingRunner.test.ts`, `tests/bookingVoice.test.ts` (their fixtures booked the same pair twice over one slot)
- Test: `tests/bookings.test.ts`

**Interfaces:**
- Produces: `bookedDuring(db: DB, party: Party, startMs: number, endMs: number, exceptId?: number): boolean` in `src/bookings/rules.ts`.
- Produces: `BookingError` codes `busy_us` and `busy_them`.

- [ ] **Step 1: Write the failing tests**

Append to `tests/bookings.test.ts`:

```ts
describe('one side, one slot (owner, 2026-10-11)', () => {
  // ['no_mercy', 'death_toll'] at the 60 minute fallback is a 180 minute slot.
  it('createBooking refuses a side already booked over the slot, by whose side it is', () => {
    const first = create();
    confirmBooking(db, { bookingId: first, by: P[1], now: NOW });
    expect(createBooking(db, base({ startsAt: at(START, 60).toISOString(), opponent: { steamid: P[2] } }) as Parameters<typeof createBooking>[1]))
      .toEqual({ ok: false, error: 'busy_us' });
    expect(createBooking(db, base({ by: P[3], startsAt: at(START, 60).toISOString(), opponent: { steamid: P[1] } }) as Parameters<typeof createBooking>[1]))
      .toEqual({ ok: false, error: 'busy_them' });
    expect(BOOKING_ERRORS.busy_us.text).toBe('Your side already has a booking at that time.');
    expect(BOOKING_ERRORS.busy_them.text).toBe('The other side already has a booking at that time.');
  });

  it('back to back is fine, and a cancelled booking frees the slot', () => {
    const first = create(); // 20:00 to 23:00
    confirmBooking(db, { bookingId: first, by: P[1], now: NOW });
    expect(create({ startsAt: at(START, 180).toISOString(), opponent: { steamid: P[2] } })).toBeGreaterThan(0); // 23:00
    expect(create({ startsAt: at(START, -180).toISOString(), opponent: { steamid: P[3] } })).toBeGreaterThan(0); // ends 20:00
    cancelBooking(db, { bookingId: first, by: P[0], now: NOW });
    // Exactly the freed slot: P[0] is booked right before and right after it.
    expect(create({ opponent: { steamid: P[4] } })).toBeGreaterThan(0);
  });

  it('an invite the other side has not confirmed does not make that side busy', () => {
    create(); // P[1] invited, not confirmed
    expect(create({ by: P[1], startsAt: at(START, 60).toISOString(), opponent: { steamid: P[2] } })).toBeGreaterThan(0);
  });

  it('confirmBooking says busy_us when the confirming side was booked over the slot since the invite', () => {
    const invite = create(); // P[0] invites P[1]
    const other = create({ by: P[2], startsAt: at(START, 60).toISOString(), opponent: { steamid: P[1] } });
    confirmBooking(db, { bookingId: other, by: P[1], now: NOW });
    expect(confirmBooking(db, { bookingId: invite, by: P[1], now: NOW })).toEqual({ ok: false, error: 'busy_us' });
    // A second invite from a side already booked over that time is refused at once.
    const mine = create({ by: P[4], startsAt: '2026-10-05T21:00:00.000Z', opponent: { steamid: P[6] } });
    expect(mine).toBeGreaterThan(0);
    expect(createBooking(db, base({ by: P[4], startsAt: '2026-10-05T20:00:00.000Z', opponent: { steamid: P[5] } }) as Parameters<typeof createBooking>[1]))
      .toEqual({ ok: false, error: 'busy_us' });
  });

  it('confirmBooking says busy_them when the inviting side was booked over the slot since the invite', () => {
    const invite = create(); // P[0] invites P[1]
    // P[0] cannot be booked over its own open invite (side a is confirmed at
    // creation), so set the invite aside while P[0] accepts another booking.
    db.prepare("UPDATE bookings SET state = 'cancelled', ending_at = ? WHERE id = ?").run(NOW.toISOString(), invite);
    const theirs = create({ by: P[7], startsAt: at(START, 60).toISOString(), opponent: { steamid: P[0] } });
    confirmBooking(db, { bookingId: theirs, by: P[0], now: NOW });
    db.prepare("UPDATE bookings SET state = 'scheduled', ending_at = NULL WHERE id = ?").run(invite);
    expect(confirmBooking(db, { bookingId: invite, by: P[1], now: NOW })).toEqual({ ok: false, error: 'busy_them' });
  });
});
```

`cancelBooking` is already imported at the top of the file. The second `create` in the invite test would refuse `busy_us` if an unconfirmed invite counted against the invited side.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/bookings.test.ts -t "one side, one slot"`
Expected: FAIL. The bookings succeed (`toEqual` sees `ok: true`), and `BOOKING_ERRORS.busy_us` is undefined.

- [ ] **Step 3: Implement**

In `src/bookings/rules.ts`, after `upcomingCount`:

```ts
/** Whether the party is a confirmed side of an open booking (any purpose)
 *  whose slot overlaps [startMs, endMs), leaving out booking `exceptId`.
 *  Half-open, as capacityProblem: back to back is not an overlap. One side
 *  never holds two slots at once (owner, 2026-10-11); an invite the side has
 *  not confirmed yet does not count against it. */
export function bookedDuring(db: DB, party: Party, startMs: number, endMs: number, exceptId = 0): boolean {
  const w = partyWhere(party);
  return db.prepare(
    `SELECT 1 FROM bookings b JOIN booking_sides s ON s.booking_id = b.id
      WHERE ${w.sql} AND s.confirmed_at IS NOT NULL AND b.state IN ${OPEN_STATES_SQL} AND b.ending_at IS NULL
        AND b.id != ? AND b.starts_at < ? AND b.ends_at > ? LIMIT 1`,
  ).get(w.arg, exceptId, iso(endMs), iso(startMs)) !== undefined;
}
```

In `src/bookings/bookings.ts`:

1. Add `bookedDuring,` to the import list from `./rules.js`.
2. In `BOOKING_ERRORS`, after `allowance`:

```ts
  // One side, one slot (owner, 2026-10-11): worded for the side asking.
  busy_us: { status: 409, text: 'Your side already has a booking at that time.' },
  busy_them: { status: 409, text: 'The other side already has a booking at that time.' },
```

3. In `createBooking`, replace

```ts
    // A blocked pair never books each other, whichever side blocked.
    if (blocked(db, aParty, bTeam !== null ? { teamId: bTeam } : { captain: bCaptain })) return fail('not_available');

    const endMs = startMs + minutes * 60_000;
```

with

```ts
    const bParty: Party = bTeam !== null ? { teamId: bTeam } : { captain: bCaptain };
    // A blocked pair never books each other, whichever side blocked.
    if (blocked(db, aParty, bParty)) return fail('not_available');

    const endMs = startMs + minutes * 60_000;
    if (bookedDuring(db, aParty, startMs, endMs)) return fail('busy_us');
    if (bookedDuring(db, bParty, startMs, endMs)) return fail('busy_them');
```

4. In `confirmBooking`, right after the `allowance` line:

```ts
    // Either side may have been booked over this slot since the invite.
    const slot = [Date.parse(b.starts_at), Date.parse(b.ends_at)] as const;
    if (bookedDuring(db, party, slot[0], slot[1], b.id)) return fail('busy_us');
    if (bookedDuring(db, partyOf(sideRow(db, b.id, 'a')!), slot[0], slot[1], b.id)) return fail('busy_them');
```

- [ ] **Step 4: Run the new tests**

Run: `npx vitest run tests/bookings.test.ts`
Expected: PASS.

- [ ] **Step 5: Fix the fixtures that booked one pair twice over one slot**

Run: `npx vitest run tests/bookingRunner.test.ts tests/bookingVoice.test.ts`

Expected: 12 failures, each `Error: busy_us` thrown from the `book()` helper. Ten are in `bookingRunner.test.ts`:
- allocation > waits for an unconfirmed booking...
- resume after a web restart > reruns setup...
- booked games > setup turns on auto-track...
- booked games > setup sends logaddress_add...
- by campaign > a +1 made while an earlier booking is being watched...
- server priority > bumps one scrim per waiting match...
- server priority > one waiting match bumps at most one boxless scrim...
- server priority > one scrim per waiting match: two scrims past their start...
- final review fixes > a second scrim bumped for the same match...
- final review fixes > two waiting matches, one held scrim...

Two are in `bookingVoice.test.ts`: "does nothing with voice off..." and "closeEnded closes what an offline wind-down left behind...". All of them book P[0] against P[1] more than once over one slot, which is now refused, rightly.

In `tests/bookingRunner.test.ts`, give `book` a pair:

```ts
const book = (o: { playlist?: string[]; confirm?: boolean; pair?: [string, string] } = {}) => {
  const [a, b] = o.pair ?? [P[0], P[1]];
  const r = createBooking(db, {
    by: a, opponent: { steamid: b }, startsAt: new Date(START).toISOString(),
    playlist: o.playlist ?? ['no_mercy'], now: new Date(now),
  });
  if (!r.ok) throw new Error(r.error);
  if (o.confirm !== false) confirmBooking(db, { bookingId: r.value.id, by: b, now: new Date(now) });
  return r.value.id;
};
```

In `tests/bookingVoice.test.ts`:

```ts
const book = (confirm = true, pair: [string, string] = [P[0], P[1]]) => {
  const r = createBooking(db, {
    by: pair[0], opponent: { steamid: pair[1] }, startsAt: new Date(START).toISOString(), minutes: 120, playlist: ['no_mercy'], now: new Date(NOW),
  });
  if (!r.ok) throw new Error(r.error);
  if (confirm) confirmBooking(db, { bookingId: r.value.id, by: pair[1], now: new Date(NOW) });
  return r.value.id;
};

const accept = (id: number, side: 'a' | 'b', steamid: string) => {
  addPerson(db, { bookingId: id, by: sideRow(db, id, side)!.captain_steamid, side, steamid, role: 'player', now: new Date(NOW) });
  respondPerson(db, { bookingId: id, steamid, accept: true, now: new Date(NOW) });
};
```

Add `sideRow` to that file's `bookings.js` import if it is not there.

In each failing test, the first booking keeps the default pair. Each later booking passes the next pair: `{ pair: [P[2], P[3]] }`, then `[P[4], P[5]]`, then `[P[6], P[7]]` in call order (in the voice file, `book(true, [P[2], P[3]])`). The `running(...)` helper in the runner file calls `book({ playlist })`. A test that calls `running` and then `book()` passes the pair to `book()`.

Where an assertion in one of these tests names `d0` or `d1` (the Discord ids of P[0] and P[1]) for a later booking, change it to that pair's ids (`d2`/`d3`, `d4`/`d5`). Do not change anything else in these tests.

Run: `npx vitest run tests/bookingRunner.test.ts tests/bookingVoice.test.ts`
Expected: PASS.

- [ ] **Step 6: Run the booking and scrim suites and typecheck**

Run: `npx vitest run tests/booking tests/scrim tests/notify.test.ts tests/teamRoutes.test.ts tests/tournamentNotScrim.test.ts && npm run typecheck`
Expected: PASS. If another test now throws `busy_us` or `busy_them` from a fixture, fix it the same way: give the later booking its own pair.

- [ ] **Step 7: Commit**

```bash
git add src/bookings/rules.ts src/bookings/bookings.ts tests/bookings.test.ts tests/bookingRunner.test.ts tests/bookingVoice.test.ts
git commit -m "Refuse a booking either side is already booked over."
```

---

### Task 2: The scrim board refuses overlap, duplicates, quick re-accepts and too many pending acceptances

**Files:**
- Modify: `src/scrims/scrims.ts` (`SCRIM_ERRORS`, constants, helpers, `createPost`, `acceptPost`)
- Test: `tests/scrims.test.ts`

**Interfaces:**
- Consumes: `bookedDuring` (Task 1).
- Produces:
  - `openPostAt(db, s: { team_id: number | null; captain_steamid: string }, startsAt: string): boolean` (Task 4 uses it).
  - The constants `SCRIM_MAX_PENDING_ACCEPTS = 3` and `ACCEPT_COOLDOWN_MS = 3_600_000`.
  - `ScrimError` codes `booked_then`, `duplicate_post`, `accept_cooldown` and `too_many_accepts`.

- [ ] **Step 1: Write the failing tests**

Append to `tests/scrims.test.ts`:

```ts
describe('one side, one slot on the board (owner, 2026-10-11)', () => {
  /** P[0] against P[1] at START with one campaign: a 90 minute slot, 20:00 to 21:30. */
  const bookPair = (a = P[0], b = P[1], startsAt = START): number => {
    const r = createBooking(db, { by: a, opponent: { steamid: b }, startsAt, playlist: ['no_mercy'], now: NOW });
    if (!r.ok) throw new Error(r.error);
    value(confirmBooking(db, { bookingId: r.value.id, by: b, now: NOW }) as ScrimResult<null>);
    return r.value.id;
  };
  // A default post (no_mercy, death_toll) is a 180 minute block.

  it('a side holding a booking cannot post a block that overlaps it; back to back is fine', () => {
    bookPair();
    expect(err(createPost(db, postInput({ startsAt: '2026-10-02T18:00:00.000Z' })))).toBe('booked_then');
    expect(err(createPost(db, postInput({ by: P[1], startsAt: '2026-10-02T21:00:00.000Z' })))).toBe('booked_then');
    expect(err(createPost(db, postInput({ startsAt: '2026-10-02T17:00:00.000Z' })))).toBe('ok'); // ends at 20:00
    expect(err(createPost(db, postInput({ startsAt: '2026-10-02T21:30:00.000Z' })))).toBe('ok'); // starts at 21:30
  });

  it('a cancelled booking frees the slot', () => {
    const id = bookPair();
    cancelBooking(db, { bookingId: id, by: P[0], now: NOW });
    expect(err(createPost(db, postInput({ startsAt: '2026-10-02T21:00:00.000Z' })))).toBe('ok');
  });

  it("a team's booking does not stop its captain posting as a pickup, and the reverse", () => {
    const rats = team(P[0], 'Rats', 'RR');
    const r = createBooking(db, { by: P[0], teamId: rats, opponent: { steamid: P[1] }, startsAt: START, playlist: ['no_mercy'], now: NOW });
    if (!r.ok) throw new Error(r.error);
    confirmBooking(db, { bookingId: r.value.id, by: P[1], now: NOW });
    expect(err(createPost(db, postInput({ teamId: rats, startsAt: '2026-10-02T21:00:00.000Z' })))).toBe('booked_then');
    expect(err(createPost(db, postInput({ startsAt: '2026-10-02T21:00:00.000Z' })))).toBe('ok'); // P[0] as a pickup
  });

  it("refuses an acceptance whose post block overlaps the accepter's booking", () => {
    bookPair();
    const id = post({ by: P[2], startsAt: '2026-10-02T20:30:00.000Z' });
    expect(err(acceptPost(db, { postId: id, by: P[1], now: NOW }))).toBe('booked_then');
    expect(err(acceptPost(db, { postId: id, by: P[3], now: NOW }))).toBe('ok');
  });

  it('refuses an exact duplicate by the same side, but not another side at that time, nor a fresh post once the first is gone', () => {
    const first = post();
    expect(err(createPost(db, postInput()))).toBe('duplicate_post');
    expect(err(createPost(db, postInput({ by: P[1] })))).toBe('ok');
    value(withdrawPost(db, { postId: first, by: P[0], now: NOW }));
    expect(err(createPost(db, postInput()))).toBe('ok');
    expect(SCRIM_ERRORS.duplicate_post.text).toBe('That side already has an open post starting at that time.');
    expect(SCRIM_ERRORS.booked_then.text).toBe('That side already has a booked scrim at that time.');
  });

  it('a side the poster declined waits an hour before accepting the same post again; withdrawing your own has no wait', () => {
    const id = post();
    const a = accept(id, P[3]);
    value(declineAccept(db, { acceptId: a, by: P[0], now: NOW }));
    expect(err(acceptPost(db, { postId: id, by: P[3], now: at(NOW.toISOString(), 59) }))).toBe('accept_cooldown');
    expect(err(acceptPost(db, { postId: id, by: P[3], now: at(NOW.toISOString(), 60) }))).toBe('ok');
    const other = post({ by: P[2] });
    expect(err(acceptPost(db, { postId: other, by: P[3], now: at(NOW.toISOString(), 1) }))).toBe('ok'); // another post: no wait
  });

  it('a side holds at most 3 pending acceptances', () => {
    const posts = [P[0], P[1], P[2], P[4]].map((by, i) => post({ by, startsAt: `2026-10-0${2 + i}T20:00:00.000Z` }));
    for (const id of posts.slice(0, 3)) accept(id, P[3]);
    expect(err(acceptPost(db, { postId: posts[3], by: P[3], now: NOW }))).toBe('too_many_accepts');
    expect(SCRIM_ERRORS.too_many_accepts.text).toBe('That side already has 3 pending acceptances. Withdraw one first.');
  });
});
```

Add `SCRIM_ERRORS` to the file's import from `../src/scrims/scrims.js`. The `value(confirmBooking(...) as ScrimResult<null>)` cast is only for the helper's type: `confirmBooking` returns `Result<null>`, which has the same shape.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/scrims.test.ts -t "one side, one slot on the board"`
Expected: FAIL. Posts and accepts come back `ok`, and `SCRIM_ERRORS.duplicate_post` is undefined.

- [ ] **Step 3: Implement**

In `src/scrims/scrims.ts`:

1. Add `bookedDuring` to the import from `../bookings/rules.js`.
2. In `SCRIM_ERRORS`, after `too_many_posts`:

```ts
  // One side, one slot (owner, 2026-10-11), and the acceptance limits that came with it.
  booked_then: { status: 409, text: 'That side already has a booked scrim at that time.' },
  duplicate_post: { status: 409, text: 'That side already has an open post starting at that time.' },
  accept_cooldown: { status: 409, text: 'The poster declined that side less than an hour ago. Try again later, or accept another post.' },
  too_many_accepts: { status: 409, text: 'That side already has 3 pending acceptances. Withdraw one first.' },
```

3. After `SCRIM_MAX_OPEN_POSTS`:

```ts
/** Pending acceptances one side may hold at once, across all posts (owner
 *  ruling 2026-10-11, mirroring the open-posts limit). Each acceptance DMs
 *  every manager of the post, so this also caps what one side can send. */
export const SCRIM_MAX_PENDING_ACCEPTS = 3;
/** After a side's acceptance of a post is declined (by the poster, or by a
 *  confirm that could never book it), that side waits this long before
 *  accepting the same post again. Withdrawing your own has no wait. */
export const ACCEPT_COOLDOWN_MS = 60 * 60_000;
```

4. After `openPostCount`:

```ts
/** Whether the side already has an open or pending post starting exactly at
 *  `startsAt`: a second one is an exact duplicate (owner, 2026-10-11), as
 *  posts 3 and 4 of the first live scrim were, 6 seconds apart. */
export function openPostAt(db: DB, s: SideRef, startsAt: string): boolean {
  const row = s.team_id !== null
    ? db.prepare("SELECT 1 FROM scrim_posts WHERE status IN ('open','pending') AND starts_at = ? AND team_id = ?").get(startsAt, s.team_id)
    : db.prepare("SELECT 1 FROM scrim_posts WHERE status IN ('open','pending') AND starts_at = ? AND team_id IS NULL AND captain_steamid = ?").get(startsAt, s.captain_steamid);
  return row !== undefined;
}
function pendingAcceptCount(db: DB, s: SideRef): number {
  const row = s.team_id !== null
    ? db.prepare("SELECT COUNT(*) AS n FROM scrim_accepts WHERE status = 'pending' AND team_id = ?").get(s.team_id)
    : db.prepare("SELECT COUNT(*) AS n FROM scrim_accepts WHERE status = 'pending' AND team_id IS NULL AND captain_steamid = ?").get(s.captain_steamid);
  return (row as { n: number }).n;
}
/** This side's acceptance of this post was declined inside ACCEPT_COOLDOWN_MS. */
function declinedLately(db: DB, postId: number, s: SideRef, nowMs: number): boolean {
  const row = (s.team_id !== null
    ? db.prepare("SELECT MAX(responded_at) AS at FROM scrim_accepts WHERE post_id = ? AND status = 'declined' AND team_id = ?").get(postId, s.team_id)
    : db.prepare("SELECT MAX(responded_at) AS at FROM scrim_accepts WHERE post_id = ? AND status = 'declined' AND team_id IS NULL AND captain_steamid = ?").get(postId, s.captain_steamid)) as { at: string | null };
  return row.at !== null && Date.parse(row.at) + ACCEPT_COOLDOWN_MS > nowMs;
}
```

5. In `createPost`, replace

```ts
    if (openPostCount(db, side) >= SCRIM_MAX_OPEN_POSTS) return fail('too_many_posts');
```

with

```ts
    if (openPostAt(db, side, iso(startMs))) return fail('duplicate_post');
    // A side holding a booked slot posts nothing that overlaps it (owner, 2026-10-11).
    if (bookedDuring(db, partyOf(side), startMs, startMs + minutes * 60_000)) return fail('booked_then');
    if (openPostCount(db, side) >= SCRIM_MAX_OPEN_POSTS) return fail('too_many_posts');
```

6. In `acceptPost`, replace

```ts
    if (already) return fail('already_accepted');
    if (outOfAllowance(db, partyOf(side), nowMs)) return fail('allowance');
```

with

```ts
    if (already) return fail('already_accepted');
    if (declinedLately(db, p.id, side, nowMs)) return fail('accept_cooldown');
    if (pendingAcceptCount(db, side) >= SCRIM_MAX_PENDING_ACCEPTS) return fail('too_many_accepts');
    // Checked against the post's block; the confirm checks the merged
    // playlist's real slot through the booking domain (bookedDuring there).
    const postStart = Date.parse(p.starts_at);
    if (bookedDuring(db, partyOf(side), postStart, postStart + p.block_minutes * 60_000)) return fail('booked_then');
    if (outOfAllowance(db, partyOf(side), nowMs)) return fail('allowance');
```

- [ ] **Step 4: Run the scrim tests**

Run: `npx vitest run tests/scrims.test.ts tests/scrimRoutes.test.ts tests/scrimBlocks.test.ts tests/scrimBoard.test.ts tests/scrimPoster.test.ts tests/bookings.test.ts`
Expected: PASS. If an existing test makes a second post for the same side at the same start, give that post its own `startsAt` (for example `'2026-10-03T20:00:00.000Z'`). A scan found none.

- [ ] **Step 5: Commit**

```bash
git add src/scrims/scrims.ts tests/scrims.test.ts
git commit -m "Refuse scrim posts and acceptances over a booked slot, exact duplicates, quick re-accepts and a fourth pending acceptance."
```

---

### Task 3: Confirm words refusals per side, declines dead acceptances, and withdraws overlaps

**Files:**
- Modify: `src/scrims/scrims.ts` (`Refused`, `ScrimResult`, `withdrawPost`, `confirmAccept`, new helpers)
- Modify: `src/scrims/messages.ts` (`ScrimNotifyType`, the `scrim_withdrawn` wording)
- Modify: `src/notify/notify.ts` (`NotifyType`, `NOTIFY_TYPES`)
- Modify: `src/routes/scrims.ts` (`refuse`, the confirm route's notices)
- Test: `tests/scrims.test.ts`, `tests/scrimRoutes.test.ts`

**Interfaces:**
- Consumes: `bookedDuring` through `createBooking`/`confirmBooking` (Task 1), and the codes `busy_us`/`busy_them`.
- Produces: `export interface Withdrawn { posts: number[]; postAccepts: number[]; accepts: number[] }`.
- Produces: `confirmAccept(...)` returns `ScrimResult<{ bookingId: number; takenAcceptIds: number[]; withdrawn: Withdrawn }>`.
- Produces: `ScrimResult`'s failure arm gains `declined?: boolean`.
- Produces: the notify type `'scrim_withdrawn'`.

- [ ] **Step 1: Write the failing domain tests**

In `tests/scrims.test.ts`, update the two existing tests whose expectations change:
- **"a refusal from confirming side b rolls back the booking side a created":** change the expectation to
  `expect(r).toEqual({ ok: false, error: 'allowance', text: 'The accepting side already has as many upcoming bookings as allowed.' });`
- **"an accepter who lost access is refused and nothing is kept":** rename it to "an accepter who lost access is refused, nothing is kept, and the acceptance is declined". Replace its last two expectations with:

```ts
    const r = confirmAccept(db, { acceptId: a, by: P[0], now: NOW });
    expect(r).toEqual({
      ok: false, error: 'not_player', declined: true,
      text: 'The accepting side can no longer play this scrim, so its acceptance was declined.',
    });
    expect(bookingCount()).toBe(0);
    expect(acceptRow(a)).toMatchObject({ status: 'declined', responded_at: NOW.toISOString() });
    expect(postRow(id).status).toBe('open');
```

  (Delete the old `expect(err(confirmAccept(...))).toBe('not_player')` line, since the confirm runs once now.)
- **"a booking refusal from a confirm keeps the booking's own text":** the first expectation becomes

```ts
    expect(confirmAccept(db, { acceptId: a, by: P[0], now: NOW })).toEqual({
      ok: false, error: 'not_player', declined: true,
      text: 'The accepting side can no longer play this scrim, so its acceptance was declined.',
    });
```

  Rename that test to "a confirm refusal says whose side it is about".

Append:

```ts
describe('a confirm withdraws what overlaps the booked slot (owner, 2026-10-11)', () => {
  it("withdraws both sides' other overlapping posts and pending acceptances, and leaves the rest", () => {
    const rats = team(P[0], 'Rats', 'RR');
    const mice = team(P[1], 'Mice', 'MM');
    const a = post({ teamId: rats }); // 20:00, booked below as 20:00 to 23:00
    const b = post({ teamId: rats, startsAt: '2026-10-02T21:00:00.000Z' });
    const d = post({ teamId: rats, startsAt: '2026-10-04T20:00:00.000Z' });
    const e = post({ by: P[1], teamId: mice, startsAt: '2026-10-02T19:00:00.000Z' });
    const c = post({ by: P[5], startsAt: '2026-10-02T22:00:00.000Z' });
    const onB = accept(b, P[6]);
    const ratsOnC = accept(c, P[0], { teamId: rats });
    const chosen = accept(a, P[1], { teamId: mice });
    const r = value(confirmAccept(db, { acceptId: chosen, by: P[0], now: NOW }));
    expect(r.withdrawn).toEqual({ posts: [b, e], postAccepts: [onB], accepts: [ratsOnC] });
    expect(postRow(b).status).toBe('withdrawn');
    expect(postRow(e).status).toBe('withdrawn');
    expect(acceptRow(onB)).toMatchObject({ status: 'withdrawn', responded_at: NOW.toISOString() });
    expect(acceptRow(ratsOnC)).toMatchObject({ status: 'withdrawn', responded_at: NOW.toISOString() });
    expect(postRow(c).status).toBe('open'); // nothing else pending on it
    expect(postRow(d).status).toBe('open'); // another day
    expect(postRow(a).status).toBe('booked');
  });

  it('a second poster cannot then book the same side over that time', () => {
    const one = post({ by: P[0] });
    const two = post({ by: P[2], startsAt: '2026-10-02T21:00:00.000Z' });
    const toOne = accept(one, P[1]);
    const toTwo = accept(two, P[1]);
    value(confirmAccept(db, { acceptId: toOne, by: P[0], now: NOW }));
    expect(acceptRow(toTwo).status).toBe('withdrawn');
    const before = bookingCount();
    expect(err(confirmAccept(db, { acceptId: toTwo, by: P[2], now: NOW }))).toBe('wrong_state');
    expect(bookingCount()).toBe(before);
  });

  it('a direct booking made after the accept makes the confirm refuse, worded for the accepting side, and keeps the acceptance', () => {
    const id = post();
    const a = accept(id, P[1]);
    const direct = createBooking(db, { by: P[4], opponent: { steamid: P[1] }, startsAt: '2026-10-02T21:00:00.000Z', playlist: ['no_mercy'], now: NOW });
    if (!direct.ok) throw new Error(direct.error);
    value(confirmBooking(db, { bookingId: direct.value.id, by: P[1], now: NOW }) as ScrimResult<null>);
    const before = bookingCount();
    expect(confirmAccept(db, { acceptId: a, by: P[0], now: NOW }))
      .toEqual({ ok: false, error: 'busy_them', text: 'The accepting side already has a booking at that time.' });
    expect(bookingCount()).toBe(before);
    expect(acceptRow(a).status).toBe('pending');
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/scrims.test.ts -t "confirm"`
Expected: FAIL. `r.withdrawn` is undefined, the not_player refusal has no `declined`, and the texts are the booking domain's.

- [ ] **Step 3: Implement the domain**

In `src/scrims/scrims.ts`:

1. Change `ScrimResult`'s failure arm:

```ts
  | { ok: false; error: ScrimError; text?: string; nearestSlot?: string | null; declined?: boolean };
```

and extend its doc comment with: "`declined` is set when a confirm declined the acceptance because the booking domain refused it in a way that can never clear (NEVER_CLEARS)."

2. Replace the `Refused` class:

```ts
/** A booking refusal inside confirmAccept's transaction. Thrown, not
 *  returned, so better-sqlite3 rolls back what createBooking already wrote.
 *  `step` is whose call refused: createBooking speaks for the poster's side,
 *  confirmBooking for the accepting side. */
class Refused extends Error {
  constructor(readonly code: BookingError, readonly step: 'poster' | 'accepter') {
    super(code);
  }
}

/** Booking refusals about the accepting side that waiting never clears
 *  (owner, 2026-10-11): the acceptance is declined at once. */
const NEVER_CLEARS: ReadonlySet<BookingError> = new Set<BookingError>(['not_open', 'not_player', 'bad_opponent', 'not_available']);
const ACCEPTER_GONE = 'The accepting side can no longer play this scrim, so its acceptance was declined.';
const ACCEPTER_BUSY = 'The accepting side already has a booking at that time.';
const OWN_BUSY = 'Your side already has a booking at that time.';
/** The poster reads every confirm refusal, but the booking domain words each
 *  one for the side that made the call. These say whose side it is about.
 *  A code not listed keeps the booking domain's text (not_available's never
 *  says why, on purpose). The poster's own not_open is checked before
 *  createBooking runs, so a not_open from it is the accepting side's. */
const REFUSAL_TEXT: Record<Refused['step'], Partial<Record<BookingError, string>>> = {
  poster: {
    allowance: 'Your side already has as many upcoming bookings as allowed.',
    busy_us: OWN_BUSY, busy_them: ACCEPTER_BUSY,
    not_open: ACCEPTER_GONE, not_player: ACCEPTER_GONE, bad_opponent: ACCEPTER_GONE,
  },
  accepter: {
    allowance: 'The accepting side already has as many upcoming bookings as allowed.',
    busy_us: ACCEPTER_BUSY, busy_them: OWN_BUSY,
    not_open: ACCEPTER_GONE,
  },
};
```

3. Add, after `reopenIfIdle`:

```ts
/** Withdraw a post and its pending acceptances, as a withdraw by hand does. */
function closePost(db: DB, postId: number, t: string): void {
  db.prepare("UPDATE scrim_posts SET status = 'withdrawn' WHERE id = ?").run(postId);
  db.prepare("UPDATE scrim_accepts SET status = 'withdrawn', responded_at = ? WHERE post_id = ? AND status = 'pending'").run(t, postId);
}

/** What a confirm withdrew because the sides are now booked over it. */
export interface Withdrawn {
  /** Either side's own open or pending posts. */
  posts: number[];
  /** Other sides' pending acceptances of those posts, withdrawn with them. */
  postAccepts: number[];
  /** Either side's own pending acceptances of other posts. */
  accepts: number[];
}

/**
 * Owner ruling 2026-10-11: once both sides are booked, each side's other open
 * or pending posts and its pending acceptances whose block overlaps the
 * booked slot are withdrawn, exactly as by hand: a post takes its pending
 * acceptances with it, and a post left with nothing pending is open again.
 * Runs inside confirmAccept's transaction after the chosen post is booked and
 * its acceptances answered, so neither is touched here.
 */
function withdrawOverlaps(db: DB, sides: SideRef[], startMs: number, endMs: number, t: string): Withdrawn {
  const out: Withdrawn = { posts: [], postAccepts: [], accepts: [] };
  const overlaps = (startsAt: string, minutes: number): boolean => {
    const s = Date.parse(startsAt);
    return s < endMs && s + minutes * 60_000 > startMs;
  };
  for (const s of sides) {
    const where = (x: string) => (s.team_id !== null ? `${x}team_id = ?` : `${x}team_id IS NULL AND ${x}captain_steamid = ?`);
    const arg = s.team_id ?? s.captain_steamid;
    const posts = db.prepare(`SELECT * FROM scrim_posts WHERE status IN ('open','pending') AND ${where('')} ORDER BY id`).all(arg) as PostRow[];
    for (const p of posts.filter((x) => overlaps(x.starts_at, x.block_minutes))) {
      out.posts.push(p.id);
      out.postAccepts.push(...pendingAccepts(db, p.id).map((a) => a.id));
      closePost(db, p.id, t);
    }
    const accepts = db.prepare(
      `SELECT a.id, a.post_id, p.starts_at, p.block_minutes FROM scrim_accepts a JOIN scrim_posts p ON p.id = a.post_id
        WHERE a.status = 'pending' AND ${where('a.')} ORDER BY a.id`,
    ).all(arg) as { id: number; post_id: number; starts_at: string; block_minutes: number }[];
    for (const a of accepts.filter((x) => overlaps(x.starts_at, x.block_minutes))) {
      out.accepts.push(a.id);
      db.prepare("UPDATE scrim_accepts SET status = 'withdrawn', responded_at = ? WHERE id = ?").run(t, a.id);
      reopenIfIdle(db, a.post_id);
    }
  }
  for (const k of ['posts', 'postAccepts', 'accepts'] as const) out[k].sort((x, y) => x - y);
  return out;
}

/** Decline an acceptance a confirm can never book (NEVER_CLEARS), after the
 *  confirm's own transaction rolled back. True when it was still pending. */
function declineRefused(db: DB, acceptId: number, now: Date): boolean {
  return db.transaction(() => {
    const changed = db.prepare("UPDATE scrim_accepts SET status = 'declined', responded_at = ? WHERE id = ? AND status = 'pending'")
      .run(now.toISOString(), acceptId).changes > 0;
    if (changed) reopenIfIdle(db, getAccept(db, acceptId)!.post_id);
    return changed;
  })();
}
```

4. In `withdrawPost`, replace its two UPDATE lines with `closePost(db, p.id, now.toISOString());`. Leave `expire()` alone, since it belongs to the compete-sweep branch.

5. Replace `confirmAccept` (and append to its doc comment: "Refusals say whose side they are about (REFUSAL_TEXT); one that can never clear also declines the acceptance (NEVER_CLEARS). Both sides' other overlapping posts and acceptances are withdrawn (withdrawOverlaps)."):

```ts
export function confirmAccept(db: DB, o: { acceptId: number; by: string; now?: Date }): ScrimResult<{ bookingId: number; takenAcceptIds: number[]; withdrawn: Withdrawn }> {
  const now = o.now ?? new Date();
  type Out = ScrimResult<{ bookingId: number; takenAcceptIds: number[]; withdrawn: Withdrawn }>;
  try {
    return db.transaction((): Out => {
      const a = getAccept(db, o.acceptId);
      if (!a) return fail('not_found');
      const p = getPost(db, a.post_id)!;
      if (hiddenFrom(db, p, o.by)) return fail('not_found');
      if (p.status !== 'pending' || a.status !== 'pending') return fail('wrong_state');
      if (!managesScrimSide(db, p, o.by)) return fail('not_manager');
      // The poster's own access, here, so a not_open from createBooking below
      // can only be the accepting side's.
      if (!canUse(db, o.by)) return fail('not_open');
      // The tick may not have written it yet; a timed-out acceptance is never booked.
      if (acceptTimedOut(a.created_at, p.starts_at, now.getTime())) return fail('wrong_state');
      // Blocking declines what is pending between the pair, but a player
      // block can start to match after the accept (they are made a
      // co-captain), so a confirm asks again; it never clears by waiting.
      if (blocked(db, partyOf(p), partyOf(a))) throw new Refused('not_available', 'poster');

      const { playlist } = proposedPlaylist(db, campaignsOf(p), campaignsOf(a));
      const created = createBooking(db, {
        by: o.by, teamId: p.team_id, opponent: a.team_id !== null ? { teamId: a.team_id } : { steamid: a.captain_steamid },
        startsAt: p.starts_at, playlist, now,
      });
      if (!created.ok) throw new Refused(created.error, 'poster');
      const bookingId = created.value.id;
      // A team side confirms through its captain now (transferCaptain may
      // have moved it since the acceptance was made).
      const accepter = a.team_id !== null ? (getTeam(db, a.team_id)?.captain_steamid ?? a.captain_steamid) : a.captain_steamid;
      const confirmed = confirmBooking(db, { bookingId, by: accepter, now });
      if (!confirmed.ok) throw new Refused(confirmed.error, 'accepter');

      const t = now.toISOString();
      const takenAcceptIds = pendingAccepts(db, p.id).filter((x) => x.id !== a.id).map((x) => x.id);
      db.prepare("UPDATE scrim_posts SET status = 'booked', booking_id = ? WHERE id = ?").run(bookingId, p.id);
      db.prepare("UPDATE scrim_accepts SET status = 'chosen', responded_at = ? WHERE id = ?").run(t, a.id);
      db.prepare("UPDATE scrim_accepts SET status = 'declined', responded_at = ? WHERE post_id = ? AND status = 'pending'").run(t, p.id);
      const booked = getBooking(db, bookingId)!;
      const withdrawn = withdrawOverlaps(db, [p, a], Date.parse(booked.starts_at), Date.parse(booked.ends_at), t);
      return ok({ bookingId, takenAcceptIds, withdrawn });
    })();
  } catch (e) {
    if (!(e instanceof Refused)) throw e;
    const text = REFUSAL_TEXT[e.step][e.code] ?? BOOKING_ERRORS[e.code].text;
    if (NEVER_CLEARS.has(e.code)) {
      return { ok: false, error: e.code, text, ...(declineRefused(db, o.acceptId, now) ? { declined: true } : {}) };
    }
    if (e.code !== 'no_capacity') return { ok: false, error: e.code, text };
    const a = getAccept(db, o.acceptId)!;
    const p = getPost(db, a.post_id)!;
    const { minutes } = proposedPlaylist(db, campaignsOf(p), campaignsOf(a));
    return { ok: false, error: 'no_capacity', text, nearestSlot: nearestFreeSlot(db, p.region, Date.parse(p.starts_at), minutes, now.getTime()) };
  }
}
```

- [ ] **Step 4: Run the domain tests**

Run: `npx vitest run tests/scrims.test.ts`
Expected: PASS. The existing "no_capacity" test still gets `BOOKING_ERRORS.no_capacity.text`, since `no_capacity` is not in `REFUSAL_TEXT`.

- [ ] **Step 5: Write the failing route test**

Append to `tests/scrimRoutes.test.ts`, inside the describe that holds the confirm tests (next to "accept tells the poster's managers..."):

```ts
  it('a confirm DMs why: the booked side\'s withdrawn post and accept (scrim_withdrawn), and a third party on that post (scrim_declined)', async () => {
    const a = await post(P[0]);
    const b = await post(P[0], { startsAt: new Date(START_MS + 30 * 60_000).toISOString() });
    const c = await post(P[3], { startsAt: new Date(START_MS + 60 * 60_000).toISOString() });
    await accept(b, P[2]);
    await accept(c, P[0]);
    const chosen = await accept(a, P[1]);
    dms = [];
    expect((await call('POST', `/api/scrims/accepts/${chosen}/confirm`, P[0])).statusCode).toBe(200);
    const to = (s: string) => dms.filter((d) => d.to === discordOf(s)).map((d) => d.content);
    expect(to(P[0]).filter((t) => t.startsWith('Your scrim post for') && t.endsWith('was withdrawn: your side booked another scrim at that time.'))).toHaveLength(1);
    expect(to(P[0]).filter((t) => t.startsWith('Your accept of') && t.endsWith('was withdrawn: your side booked another scrim at that time.'))).toHaveLength(1);
    expect(to(P[2]).filter((t) => t.endsWith('is closed: the posting side booked another scrim at that time.'))).toHaveLength(1);
    expect(to(P[3])).toEqual([]); // the poster of the post P[0] had accepted is not DMed
  });

  it('a confirm that can never book declines the acceptance, says so, and DMs the accepter', async () => {
    const a = await post(P[0]);
    const acc = await accept(a, P[1]);
    db.prepare("UPDATE players SET status = 'banned' WHERE steamid = ?").run(P[1]);
    dms = [];
    const r = await call('POST', `/api/scrims/accepts/${acc}/confirm`, P[0]);
    expect(r.statusCode).toBe(400);
    expect(r.json()).toEqual({ error: 'The accepting side can no longer play this scrim, so its acceptance was declined.', declined: true });
    expect(dms.filter((d) => d.to === discordOf(P[1]) && d.content.endsWith('is closed: it could not be booked.'))).toHaveLength(1);
  });
```

`not_player` has status 400 in `BOOKING_ERRORS`. A banned player's DM is still sent if they want it: `Notifier.send` does not check status.

- [ ] **Step 6: Run the route test to verify it fails**

Run: `npx vitest run tests/scrimRoutes.test.ts -t "a confirm"`
Expected: FAIL. There are no withdrawn or declined DMs, and the response has no `declined`.

- [ ] **Step 7: Implement the notices**

`src/notify/notify.ts`:
- Add `| 'scrim_withdrawn'` after `'scrim_declined'` in the `NotifyType` union.
- In `NOTIFY_TYPES`, after the `scrim_declined` row, add `{ type: 'scrim_withdrawn', label: 'My scrim post or accept is withdrawn because my side booked another scrim at that time' },`.

`src/scrims/messages.ts`:
- Change the type to `export type ScrimNotifyType = 'scrim_challenge' | 'scrim_accepted' | 'scrim_booked' | 'scrim_taken' | 'scrim_declined' | 'scrim_withdrawn';`, and update its doc comment to "The six scrim board notice types".
- Add a case before the closing brace of the switch:

```ts
    case 'scrim_withdrawn': {
      // Owner ruling 2026-10-11: the side was booked over this time.
      const why = escapeName(extra.reason ?? 'your side booked another scrim at that time');
      content = extra.acceptId !== undefined
        ? `Your accept of ${posterLabel}'s scrim post (${when}) was withdrawn: ${why}.`
        : `Your scrim post for ${when} was withdrawn: ${why}.`;
      break;
    }
```

`src/routes/scrims.ts`:

1. In `refuse`, after the `no_capacity` line, add `if (r.declined) out.declined = true;`, and widen its parameter type to `{ error: S.ScrimError; text?: string; nearestSlot?: string | null; declined?: boolean }`.
2. In the confirm route, replace the failure branch with:

```ts
    if (!r.ok) {
      // The slot was taken from under this acceptance, or a side is booked
      // elsewhere: the poster sees the refusal (and any nearestSlot) right
      // here, and the acceptance stays pending, so the accepter is not DMed
      // (that DM would read as final and repeat on every Confirm click).
      // One that can never clear was declined (NEVER_CLEARS): that one is final.
      if (r.declined && accept) tell(scrimSideManagers(db, accept), 'scrim_declined', accept.post_id, { reason: 'it could not be booked' });
      return refuse(reply, r);
    }
```

3. Change `const { bookingId, takenAcceptIds } = r.value;` to `const { bookingId, takenAcceptIds, withdrawn } = r.value;`. After the `takenAcceptIds` loop, add:

```ts
    // Owner ruling 2026-10-11: both sides are booked now, so their other
    // overlapping posts and acceptances were withdrawn; each side is told why.
    const BOOKED_ELSEWHERE = 'your side booked another scrim at that time';
    for (const postId of withdrawn.posts) {
      const wp = S.getPost(db, postId);
      if (wp) tell(scrimSideManagers(db, wp), 'scrim_withdrawn', postId, { reason: BOOKED_ELSEWHERE });
    }
    for (const acceptId of withdrawn.postAccepts) {
      const wa = S.getAccept(db, acceptId);
      if (wa) tell(scrimSideManagers(db, wa), 'scrim_declined', wa.post_id, { reason: 'the posting side booked another scrim at that time' });
    }
    for (const acceptId of withdrawn.accepts) {
      const wa = S.getAccept(db, acceptId);
      if (wa) tell(scrimSideManagers(db, wa), 'scrim_withdrawn', wa.post_id, { acceptId, reason: BOOKED_ELSEWHERE });
    }
```

- [ ] **Step 8: Run the tests and typecheck**

Run: `npx vitest run tests/scrims.test.ts tests/scrimRoutes.test.ts tests/notify.test.ts tests/scrimsSchema.test.ts tests/bookings.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add src/scrims/scrims.ts src/scrims/messages.ts src/notify/notify.ts src/routes/scrims.ts tests/scrims.test.ts tests/scrimRoutes.test.ts
git commit -m "Word confirm refusals per side, decline acceptances that can never be booked, and withdraw both sides' overlapping posts and acceptances on a confirm."
```

---

### Task 4: Re-post refuses a duplicate and is gone once the start is near

**Files:**
- Modify: `src/scrims/scrims.ts` (`repostFromBooking`)
- Modify: `src/bookings/bookings.ts` (`bookingView`'s `repost`)
- Test: `tests/scrims.test.ts`, `tests/bookings.test.ts`

**Interfaces:**
- Consumes: `openPostAt` (Task 2) and `ACCEPT_CUTOFF_MS` (already exported from `src/scrims/scrims.ts`).

- [ ] **Step 1: Write the failing tests**

In `tests/scrims.test.ts`, inside `describe('repostFromBooking', ...)`, add:

```ts
  it('a second re-post of the same booking by the same side is a duplicate', () => {
    const bookingId = booked();
    value(cancelBooking(db, { bookingId, by: P[0], now: NOW }));
    value(repostFromBooking(db, { bookingId, by: P[0], now: NOW }));
    expect(err(repostFromBooking(db, { bookingId, by: P[0], now: NOW }))).toBe('duplicate_post');
    expect(err(repostFromBooking(db, { bookingId, by: P[1], now: NOW }))).toBe('ok'); // the other side is its own side
  });

  it('past the start it is too_late, not bad_time', () => {
    const bookingId = booked();
    value(cancelBooking(db, { bookingId, by: P[0], now: NOW }));
    expect(err(repostFromBooking(db, { bookingId, by: P[0], now: at(START, 5) }))).toBe('too_late');
  });
```

In `tests/bookings.test.ts`, inside `describe('repost (plan 2)', ...)`, pass `NOW.getTime()` as the fourth argument to every `bookingView` call there (the real clock is past START). Then add:

```ts
  it('is not offered once the start is 30 minutes away, nor once that side already re-posted it', () => {
    const id = bookFromPost();
    cancelBooking(db, { bookingId: id, by: P[0], now: NOW });
    expect(bookingView(db, id, { steamid: P[0], staff: false }, at(START, -31).getTime())!.repost).toEqual({ allowed: true });
    expect(bookingView(db, id, { steamid: P[0], staff: false }, at(START, -30).getTime())!.repost).toEqual({ allowed: false });
    const r = repostFromBooking(db, { bookingId: id, by: P[0], now: NOW });
    expect(r.ok).toBe(true);
    expect(bookingView(db, id, { steamid: P[0], staff: false }, NOW.getTime())!.repost).toEqual({ allowed: false });
    expect(bookingView(db, id, { steamid: P[1], staff: false }, NOW.getTime())!.repost).toEqual({ allowed: true });
  });
```

Add `repostFromBooking` to that file's import from `../src/scrims/scrims.js`.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/scrims.test.ts tests/bookings.test.ts -t "repost"`
Expected: FAIL. "past the start" gets `bad_time`, and `allowed` stays true in the new bookings test. The duplicate test already passes from Task 2; keep it as the pin.

- [ ] **Step 3: Implement**

In `repostFromBooking`, after `const s = sideRow(db, b.id, side)!;`:

```ts
  // Only while a post could still be accepted (plan 2 Ruling 4, with the
  // owner's 2026-10-11 fix): later, the click is refused in plain words
  // rather than as createPost's bad_time.
  if (Date.parse(b.starts_at) - ACCEPT_CUTOFF_MS <= now.getTime()) return fail('too_late');
```

In `src/bookings/bookings.ts`, import `ACCEPT_CUTOFF_MS, openPostAt` from `../scrims/scrims.js`. This file already has an import cycle with `scrims/rules.js` and `reviews.js`, and both names are only read inside functions. Replace the `repost` field of `bookingView`:

```ts
    repost: {
      // Also not once the start is inside the acceptance cutoff, nor once
      // the viewer's side already has an open post at that start (owner,
      // 2026-10-11): either click would only be refused.
      allowed: b.state === 'cancelled' && b.purpose === 'scrim' && manages.length > 0
        && Date.parse(b.starts_at) - ACCEPT_CUTOFF_MS > nowMs
        && !!db.prepare('SELECT 1 FROM scrim_posts WHERE booking_id = ?').get(b.id)
        && !openPostAt(db, sideRow(db, b.id, manages[0])!, b.starts_at),
    },
```

Update the `repost` doc comment in `BookingView` to add: "nor once the start is inside the 30 minute acceptance cutoff, nor once the viewer's side already has an open post at that start".

- [ ] **Step 4: Run the tests**

Run: `npx vitest run tests/scrims.test.ts tests/bookings.test.ts tests/scrimRoutes.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/scrims/scrims.ts src/bookings/bookings.ts tests/scrims.test.ts tests/bookings.test.ts
git commit -m "Refuse a duplicate re-post and stop offering re-post once the start is near."
```

---

### Task 5: The post form confirms success and the board reloads after a declined confirm

**Files:**
- Modify: `web/src/routes/Scrims.tsx` (`PostForm`, and `post` and `confirm` in `Scrims()` only)
- Test: `web/src/routes/Scrims.test.tsx`

**Interfaces:**
- Consumes: `POST /api/scrims` already answers `201 { id }`; `scrimsApi.create` returns `{ id: number }`. No API change is needed.
- Produces: `PostForm`'s `onSubmit` becomes `(b: NewScrimPost) => Promise<number | null>`, the new post's id or null on a refusal.

- [ ] **Step 1: Write the failing tests**

Append inside `describe('Scrims page', ...)` in `web/src/routes/Scrims.test.tsx`:

```tsx
  it('after a post goes through, the form clears and says Posted with a link to the new card', async () => {
    mockScrims.create.mockResolvedValue({ id: 77 });
    renderScrims();
    await screen.findByRole('heading', { name: 'Post a scrim' });
    fireEvent.input(screen.getByLabelText('Start'), { target: { value: '2026-10-02T20:00' } });
    fireEvent.click(screen.getByLabelText('No Mercy'));
    fireEvent.input(screen.getByLabelText('Note'), { target: { value: 'gl hf' } });
    fireEvent.click(screen.getByRole('button', { name: 'Post the scrim' }));
    const done = await screen.findByText(/^Posted\./);
    expect(done.textContent).toBe('Posted. See it on the board');
    expect(screen.getByRole('link', { name: 'See it on the board' }).getAttribute('href')).toBe('/scrims?post=77');
    expect((screen.getByLabelText('Start') as HTMLInputElement).value).toBe('');
    expect((screen.getByLabelText('No Mercy') as HTMLInputElement).checked).toBe(false);
    expect((screen.getByLabelText('Note') as HTMLInputElement).value).toBe('');
    expect((screen.getByRole('button', { name: 'Post the scrim' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('a refused post keeps the form as it was and shows no Posted line', async () => {
    mockScrims.create.mockRejectedValue(new Error('That side already has an open post starting at that time.'));
    renderScrims();
    await screen.findByRole('heading', { name: 'Post a scrim' });
    fireEvent.input(screen.getByLabelText('Start'), { target: { value: '2026-10-02T20:00' } });
    fireEvent.click(screen.getByLabelText('No Mercy'));
    fireEvent.click(screen.getByRole('button', { name: 'Post the scrim' }));
    expect(await screen.findByText('That side already has an open post starting at that time.')).toBeTruthy();
    expect(screen.queryByText(/^Posted\./)).toBeNull();
    expect((screen.getByLabelText('Start') as HTMLInputElement).value).toBe('2026-10-02T20:00');
    expect((screen.getByLabelText('No Mercy') as HTMLInputElement).checked).toBe(true);
  });

  it('a confirm refused for good reloads the board, since the acceptance is gone', async () => {
    mockScrims.confirm.mockRejectedValue(new ApiError(400, 'The accepting side can no longer play this scrim, so its acceptance was declined.'));
    renderScrims();
    fireEvent.click(await screen.findByRole('button', { name: 'Confirm' }));
    expect(await screen.findByText('The accepting side can no longer play this scrim, so its acceptance was declined.')).toBeTruthy();
    await waitFor(() => expect(mockScrims.board).toHaveBeenCalledTimes(2));
  });
```

Check `ApiError`'s constructor in `web/src/api.ts` before writing the third test. If it is not `(status, message)`, construct it the way the existing nearestSlot test in this file does.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run web/src/routes/Scrims.test.tsx`
Expected: FAIL. There is no "Posted." line, the fields keep their values, and the board is loaded once.

- [ ] **Step 3: Implement**

In `PostForm`, change the prop type to `onSubmit: (b: NewScrimPost) => Promise<number | null>`. Add the state and reset, and replace `submit`:

```tsx
  // Owner, 2026-10-11: the form used to sit unchanged after a post, so a
  // captain clicked again and made a duplicate. It now clears and says so.
  const [postedId, setPostedId] = useState<number | null>(null);

  const submit = async (ev: Event) => {
    ev.preventDefault();
    const startsAt = toUtcIso(when);
    if (!startsAt) return;
    setPostedId(null);
    const id = await onSubmit({
      teamId, startsAt, campaigns, note,
      ...(options.showSr ? { srRange: srRange === '' ? null : Number(srRange) } : {}),
      targetTeamId: targetTeamId === '' ? undefined : Number(targetTeamId),
    });
    if (id === null) return;
    // The side stays as picked: a captain posting twice posts for the same side.
    setWhen(''); setCampaigns([]); setSrRange(''); setNote(''); setTargetTeamId('');
    setPostedId(id);
  };
```

Under the submit button, inside the `<form>`:

```tsx
      {postedId !== null && (
        <p class="muted">Posted. <a href={`/scrims?post=${postedId}`}>See it on the board</a></p>
      )}
```

In `Scrims()`, replace `const post = (b: NewScrimPost) => act(() => scrimsApi.create(b));` with:

```tsx
  // The new post's id, for the form's "See it on the board" link (?post=
  // highlights it), or null when the post was refused.
  const post = async (b: NewScrimPost): Promise<number | null> => {
    const made: { id: number | null } = { id: null };
    const done = await act(async () => { made.id = (await scrimsApi.create(b)).id; });
    return done ? made.id : null;
  };
```

In `confirm`'s `catch`, add `load();` as the first line. A refusal may have declined the acceptance, or withdrawn other rows, so the board re-reads either way.

- [ ] **Step 4: Run the tests**

Run: `npx vitest run web/src/routes/Scrims.test.tsx && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add web/src/routes/Scrims.tsx web/src/routes/Scrims.test.tsx
git commit -m "Clear the scrim post form and link to the new card after a post, and reload the board after a refused confirm."
```

---

### Task 6: Campaign lengths come from measured whole-campaign games

**Files:**
- Modify: `src/bookings/rules.ts` (`typicalCampaignMinutes`, plus new constants and `measuredCampaignMinutes`)
- Modify: `tests/matchKindGuard.test.ts` (allowlist `src/bookings/rules.ts`)
- Test: `tests/bookingRules.test.ts`

**Interfaces:**
- Produces:
  - `MEASURED_MIN_GAMES = 5`, `MEASURED_LAST_GAMES = 20`.
  - `measuredCampaignMinutes(db, campaign): number | null`.
  - `typicalCampaignMinutes` keeps its signature.
- Every estimate already goes through `typicalCampaignMinutes`, so no caller changes: `estimateMinutes`, `estimateOptions` (which feeds the forms' live estimate and the board's "about 2 h 30"), `addCampaignMinutes`, `playlistMinutes`, and the options routes.

- [ ] **Step 1: Write the failing tests**

Append to `describe('campaign timing', ...)` in `tests/bookingRules.test.ts`:

```ts
  /** A game of any kind, `minutes` long, with `maps` match_maps rows. */
  const game = (campaign: string, minutes: number, o: {
    kind?: string; state?: string; maps?: number; wentLive?: boolean; forfeit?: string | null; restored?: number | null;
  } = {}) => {
    const id = Number(db.prepare(
      `INSERT INTO matches (season_id, state, campaign, kind, went_live_at, created_at, ended_at, forfeit_team, restored_at_map)
       VALUES ((SELECT id FROM seasons LIMIT 1), ?, ?, ?, ?, '2026-09-01 20:00:00', datetime('2026-09-01 20:00:00', ?), ?, ?)`,
    ).run(o.state ?? 'completed', campaign, o.kind ?? 'scrim', o.wentLive ? '2026-09-01 20:00:00' : null, `+${minutes} minutes`,
      o.forfeit ?? null, o.restored ?? null).lastInsertRowid);
    for (let i = 0; i < (o.maps ?? 4); i++) {
      db.prepare('INSERT INTO match_maps (match_id, ordinal, map) VALUES (?, ?, ?)').run(id, i, `m${i}`);
    }
  };

  it('uses the median of whole-campaign games of any kind once there are 5, else the PUG figure', () => {
    match('dark_wood', 50); match('dark_wood', 60); match('dark_wood', 70); // PUG history, no maps rows
    for (const m of [90, 95, 100, 85]) game('dark_wood', m);
    expect(measuredCampaignMinutes(db, 'dark_wood')).toBeNull();
    expect(typicalCampaignMinutes(db, 'dark_wood')).toBe(60);
    game('dark_wood', 92, { kind: 'pug', wentLive: true });
    expect(measuredCampaignMinutes(db, 'dark_wood')).toBe(92);
    expect(typicalCampaignMinutes(db, 'dark_wood')).toBe(92);
  });

  it('leaves out aborted, forfeited, restored, map-less and out-of-window games', () => {
    for (const m of [80, 82, 84, 86, 88]) game('blood_harvest', m);
    game('blood_harvest', 30, { state: 'aborted' });
    game('blood_harvest', 30, { forfeit: 'a' });
    game('blood_harvest', 30, { restored: 2 });
    game('blood_harvest', 30, { maps: 0 });
    game('blood_harvest', 5);
    game('blood_harvest', 300);
    expect(measuredCampaignMinutes(db, 'blood_harvest')).toBe(84);
  });

  it('takes only the last 20', () => {
    for (let i = 0; i < 20; i++) game('no_mercy', 200);
    for (let i = 0; i < 20; i++) game('no_mercy', 60);
    expect(measuredCampaignMinutes(db, 'no_mercy')).toBe(60);
  });

  it('a self-started game (no went_live_at) is timed from its row, created at go-live', () => {
    for (let i = 0; i < 5; i++) game('death_toll', 75, { kind: 'pug', wentLive: false });
    expect(measuredCampaignMinutes(db, 'death_toll')).toBe(75);
  });
```

Add `measuredCampaignMinutes` to the import from `../src/bookings/rules.js`. Tests run with no missions directory, so the registry lists no maps for stock campaigns, and the rule falls back to "at least one `match_maps` row".

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/bookingRules.test.ts -t "campaign timing"`
Expected: FAIL with "measuredCampaignMinutes is not a function".

- [ ] **Step 3: Implement**

In `src/bookings/rules.ts`, add `import { campaignRegistry } from '../campaignRegistry.js';`. Replace `typicalCampaignMinutes` with:

```ts
/** Whole-campaign games needed before measured lengths replace the PUG-only
 *  figure, and how many of the latest are used (owner, 2026-10-11: the
 *  board said "about 2 h 30" for Dark Wood plus Blood Harvest, and Dark Wood
 *  alone took 90 minutes). */
export const MEASURED_MIN_GAMES = 5;
export const MEASURED_LAST_GAMES = 20;

function median(sorted: number[]): number {
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * How long this campaign really takes, in minutes: the median of the last
 * MEASURED_LAST_GAMES games of any kind (PUG, scrim or tournament) that played
 * the whole campaign, or null with fewer than MEASURED_MIN_GAMES of them.
 *
 * Whole campaign: completed (never aborted, so never voided either, since a
 * voided game is stored as aborted), not a !gg forfeit, not replayed from a
 * later map after a restart (restored_at_map), and a match_maps row for every
 * map the campaign has (at least one when the registry does not list its
 * maps). Going live is went_live_at for a match the site set up, and
 * created_at for one adopted live from the box (an in-game PUG, every booking
 * game), which never stamps went_live_at and is created at go-live. The same
 * 10 minute to 4 hour window as below keeps out a box left running.
 *
 * Every kind on purpose: this is how long the campaign holds a server, and
 * the raw filter is allowlisted in tests/matchKindGuard.test.ts.
 */
export function measuredCampaignMinutes(db: DB, campaign: string): number | null {
  const want = Math.max(1, campaignRegistry(db).get(campaign)?.maps.length ?? 0);
  const rows = db.prepare(
    `SELECT (julianday(m.ended_at) - julianday(COALESCE(m.went_live_at, m.created_at))) * 1440 AS mins,
            (SELECT COUNT(*) FROM match_maps mm WHERE mm.match_id = m.id) AS maps
       FROM matches m
      WHERE m.state = 'completed' AND m.campaign = ? AND m.ended_at IS NOT NULL
        AND m.forfeit_team IS NULL AND m.restored_at_map IS NULL
      ORDER BY m.id DESC LIMIT 200`,
  ).all(campaign) as { mins: number; maps: number }[];
  const mins = rows.filter((r) => r.maps >= want && r.mins >= 10 && r.mins <= 240)
    .slice(0, MEASURED_LAST_GAMES).map((r) => r.mins).sort((a, b) => a - b);
  return mins.length < MEASURED_MIN_GAMES ? null : Math.round(median(mins));
}

/**
 * How long this campaign usually takes, in minutes: measuredCampaignMinutes
 * once there are enough whole-campaign games. Before that, the median of its
 * last 30 completed PUGs from going live to the end, ignoring anything under
 * 10 minutes or over 4 hours (aborts, a box left running); with fewer than 3
 * such games, DEFAULT_CAMPAIGN_MINUTES.
 */
export function typicalCampaignMinutes(db: DB, campaign: string): number {
  const measured = measuredCampaignMinutes(db, campaign);
  if (measured !== null) return measured;
  const mins = (db.prepare(
    `SELECT (julianday(ended_at) - julianday(went_live_at)) * 1440 AS m FROM matches
      WHERE ${completedPug()} AND campaign = ? AND went_live_at IS NOT NULL AND ended_at IS NOT NULL
      ORDER BY id DESC LIMIT 30`,
  ).all(campaign) as { m: number }[]).map((r) => r.m).filter((m) => m >= 10 && m <= 240).sort((a, b) => a - b);
  if (mins.length < 3) return DEFAULT_CAMPAIGN_MINUTES;
  return Math.round(median(mins));
}
```

The `LIMIT 200` is a scan bound: rows that fail the JavaScript filter (missing maps, out of window) must not shrink the 20 we keep.

In `tests/matchKindGuard.test.ts`, add to `ALLOWED`:

```ts
  'src/bookings/rules.ts': 1,       // campaign length estimate: every kind holds a server as long
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run tests/bookingRules.test.ts tests/matchKindGuard.test.ts tests/scrimRules.test.ts tests/bookings.test.ts tests/scrims.test.ts && npm run typecheck`
Expected: PASS. The existing timing tests insert PUG rows with no `match_maps`, so they still take the PUG path.

- [ ] **Step 5: Commit**

```bash
git add src/bookings/rules.ts tests/bookingRules.test.ts tests/matchKindGuard.test.ts
git commit -m "Estimate campaign lengths from measured whole-campaign games of any kind once a campaign has five."
```

After deploy (owner, read-only on the box, not part of this plan), this query shows what a campaign's measured length now is:

```sql
SELECT campaign, kind, COUNT(*) FROM matches WHERE state = 'completed' AND forfeit_team IS NULL AND restored_at_map IS NULL GROUP BY campaign, kind;
```

---

### Task 7: Endorsements are for PUGs only

**Files:**
- Modify: `src/endorsements.ts` (`EndorseError`, `ENDORSE_ERROR_TEXT`, `gate`)
- Modify: `src/routes/stats.ts` (`/api/matches/:id` sends `kind`)
- Modify: `web/src/api.ts` (`MatchDetail.match.kind`), `web/src/endorse.ts` (`endorsable`), `web/src/routes/MatchDetail.tsx` (the guard)
- Test: `tests/endorsements.test.ts`, `tests/stats.test.ts`, new `web/src/endorse.test.ts`

**Interfaces:**
- Produces: `EndorseError` gains `'not_pug'`; `endorsable(m: { state: string; kind?: string }): boolean` in `web/src/endorse.ts`.

- [ ] **Step 1: Write the failing tests**

In `tests/endorsements.test.ts`, inside `describe('giveEndorsement', ...)`:

```ts
  it('refuses a scrim or tournament match with its own reason, and the panel state says so', () => {
    seedMatch(1);
    db.prepare("UPDATE matches SET kind = 'scrim' WHERE id = 1").run();
    seedMatch(2);
    db.prepare("UPDATE matches SET kind = 'tournament' WHERE id = 2").run();
    expect(giveEndorsement(db, { matchId: 1, from: IDS[0], to: IDS[5], kind: 'caller' })).toEqual({ ok: false, error: 'not_pug' });
    expect(giveEndorsement(db, { matchId: 2, from: IDS[0], to: IDS[5], kind: 'caller' })).toEqual({ ok: false, error: 'not_pug' });
    expect(endorseState(db, 1, IDS[0])).toMatchObject({ eligible: false, reason: 'not_pug', closesAt: null, candidates: [] });
    expect(ENDORSE_ERROR_TEXT.not_pug).toBe('Endorsements are for PUGs only. Scrims and tournament matches have none.');
    expect(rowCount()).toBe(0);
  });
```

In `tests/stats.test.ts`, in 'match list and detail', after `expect(body.match.id).toBe(matchId);` add `expect(body.match.kind).toBe('pug');`.

Create `web/src/endorse.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { endorsable } from './endorse';

describe('endorsable', () => {
  it('is a completed PUG only; an older server with no kind reads as a PUG', () => {
    expect(endorsable({ state: 'completed', kind: 'pug' })).toBe(true);
    expect(endorsable({ state: 'completed' })).toBe(true);
    expect(endorsable({ state: 'completed', kind: 'scrim' })).toBe(false);
    expect(endorsable({ state: 'completed', kind: 'tournament' })).toBe(false);
    expect(endorsable({ state: 'aborted', kind: 'pug' })).toBe(false);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/endorsements.test.ts tests/stats.test.ts web/src/endorse.test.ts`
Expected: FAIL. `giveEndorsement` returns ok, `kind` is undefined, and `endorsable` is not exported.

- [ ] **Step 3: Implement**

`src/endorsements.ts`:
- Add `| 'not_pug'` to `EndorseError`.
- In `ENDORSE_ERROR_TEXT`, after `no_match`, add `not_pug: 'Endorsements are for PUGs only. Scrims and tournament matches have none.',`.
- In `gate`, select `kind` too (`SELECT state, kind, ...`), widen the row type with `kind: string`, and add right after the `no_match` line:

```ts
  // Scrims and tournament matches never take endorsements (owner, 2026-10-11):
  // every read already counts completedPug() only, so one given there would
  // be invisible everywhere and still spend a budget.
  if (m.kind !== 'pug') return { ok: false, error: 'not_pug', closesAt: null };
```

`src/routes/stats.ts`: in the `/api/matches/:id` SELECT, add `kind,` after `forfeit_team AS forfeitTeam,`.

`web/src/api.ts`: in `MatchDetail`'s `match` intersection, add

```ts
    /** Optional for an older server, which is read as a PUG. */
    kind?: 'pug' | 'scrim' | 'tournament';
```

`web/src/endorse.ts`:

```ts
/** Whether the match page asks for the endorse panel at all: a completed PUG
 *  only, since a scrim or tournament match never takes endorsements (the
 *  server's gate refuses them too). An older server sends no kind: a PUG. */
export const endorsable = (m: { state: string; kind?: string }): boolean => m.state === 'completed' && (m.kind ?? 'pug') === 'pug';
```

`web/src/routes/MatchDetail.tsx`: import `endorsable` from `'../endorse'`. Change the panel line to `{endorsable(match) && me && <EndorsePanel matchId={match.id} />}`, and its comment to "Completed PUGs only, and only for a signed-in viewer: ...".

- [ ] **Step 4: Run the tests**

Run: `npx vitest run tests/endorsements.test.ts tests/endorseApi.test.ts tests/stats.test.ts tests/discordController.test.ts web/src/endorse.test.ts web/src/components/EndorsePanel.test.tsx && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/endorsements.ts src/routes/stats.ts web/src/api.ts web/src/endorse.ts web/src/endorse.test.ts web/src/routes/MatchDetail.tsx tests/endorsements.test.ts tests/stats.test.ts
git commit -m "Refuse endorsements on any match that is not a PUG and hide the panel there."
```

---

### Task 8: Review tags change and reviews take a staff-only note

**Files:**
- Modify: `src/scrims/reviews.ts` (tags, `REVIEW_NOTE_MAX`, `submitReview`, `ownReview`, `staffReviews`, `reviewSummary`)
- Modify: `src/db.ts` (`scrim_reviews.note`)
- Modify: `src/bookings/bookings.ts` (`BOOKING_ERRORS.bad_review_note`, the `BookingView.review` type)
- Modify: `src/routes/bookings.ts` (pass `note`)
- Test: `tests/scrimReviews.test.ts`

**Interfaces:**
- Produces:
  - `REVIEW_TAGS` (offered, 6 tags), `RETIRED_REVIEW_TAGS = ['good_comms']`, `KNOWN_REVIEW_TAGS` (both), and `ReviewTag` (any known tag).
  - `REVIEW_TAG_LABELS: Record<ReviewTag, string>` and `REVIEW_NOTE_MAX = 300`.
  - `submitReview(db, { bookingId, by, thumbs, tags, note?: unknown, now? })`.
  - `ownReview(...)` returns `{ thumbs, tags, note } | null`, and `StaffReview` gains `note: string`.

- [ ] **Step 1: Write the failing tests**

In `tests/scrimReviews.test.ts`, update:
- The first test: change `tags: ['on_time', 'good_comms']` to `tags: ['on_time', 'flexible']`.
- **'labels every tag':**

```ts
  it('offers the 2026-10-11 tags and still labels the retired one', () => {
    expect(REVIEW_TAGS).toEqual(['on_time', 'easy_to_schedule', 'flexible', 'good_sport', 'left_early', 'toxic']);
    expect(REVIEW_TAGS.map((t) => REVIEW_TAG_LABELS[t])).toEqual(['On time', 'Easy to schedule', 'Flexible', 'Good sport', 'Left early', 'Toxic']);
    expect(RETIRED_REVIEW_TAGS).toEqual(['good_comms']);
    expect(REVIEW_TAG_LABELS.good_comms).toBe('Good comms');
  });
```

- **'refuses bad thumbs and bad tags':** add `['good_comms']` to the list of bad `tags` values.
- **'a team party collects reviews...':** it submits `good_comms`, which is now refused. Seed those two reviews straight into the table instead:

```ts
  it('a team party collects reviews of its team sides, not its captain\'s pickup sides; a retired tag still counts', () => {
    const t = team(P[1], 'Rats', 'RR');
    const stored = (day: number, thumbs: 1 | -1, tags: string[]) => {
      const id = booked(START + day * DAY, { opponent: { teamId: t } });
      const end = closed(id);
      db.prepare("INSERT INTO scrim_reviews (booking_id, by_side, reviewer, thumbs, tags_json, created_at, updated_at) VALUES (?, 'a', ?, ?, ?, ?, ?)")
        .run(id, P[0], thumbs, JSON.stringify(tags), new Date(end).toISOString(), new Date(end).toISOString());
    };
    stored(0, 1, ['good_comms']);
    stored(1, 1, ['good_comms']);
    stored(2, -1, []);
    review(3, -1, ['toxic']);
    expect(reviewSummary(db, { teamId: t }, { staff: true })).toEqual({ count: 3, positivePct: 67, topTag: 'good_comms' });
    expect(reviewSummary(db, { captain: P[1] }, { staff: true })).toEqual({ count: 1, positivePct: null, topTag: null });
  });
```

- **'bookingView privacy':** every `mine: { thumbs: ..., tags: [...] }` gains `note: ''`.

Append:

```ts
describe('the staff-only note (owner, 2026-10-11)', () => {
  it('is trimmed, at most 300 characters, and stored; staff read it and the reviewer\'s own side reads its own', () => {
    const t = team(P[1], 'Rats', 'RR', [P[2]]);
    const id = booked(START, { opponent: { teamId: t } });
    const now = closed(id) + HOUR;
    expect(submitReview(db, { bookingId: id, by: P[0], thumbs: -1, tags: [], note: 'x'.repeat(301), now: new Date(now) }))
      .toEqual({ ok: false, error: 'bad_review_note' });
    expect(submitReview(db, { bookingId: id, by: P[0], thumbs: -1, tags: [], note: 7, now: new Date(now) }))
      .toEqual({ ok: false, error: 'bad_review_note' });
    expect(submitReview(db, { bookingId: id, by: P[0], thumbs: -1, tags: [], note: `  ${'y'.repeat(300)}  `, now: new Date(now) }).ok).toBe(true);
    expect(staffReviews(db, id)[0].note).toBe('y'.repeat(300));
    expect(bookingView(db, id, { steamid: P[0], staff: false }, now)!.review!.mine!.note).toBe('y'.repeat(300));
    // The reviewed side, its plain member, and the aggregate never carry it.
    expect(JSON.stringify(bookingView(db, id, { steamid: P[1], staff: false }, now))).not.toContain('yyyy');
    expect(bookingView(db, id, { steamid: P[2], staff: false }, now)).toBeNull();
    expect(JSON.stringify(reviewSummary(db, { teamId: t }, { staff: false }))).not.toContain('yyyy');
    // An edit without a note clears it.
    submitReview(db, { bookingId: id, by: P[0], thumbs: 1, tags: [], now: new Date(now) });
    expect(staffReviews(db, id)[0].note).toBe('');
  });
});
```

Add `RETIRED_REVIEW_TAGS` to the import from `../src/scrims/reviews.js`.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/scrimReviews.test.ts`
Expected: FAIL. The tag lists differ, `RETIRED_REVIEW_TAGS` is undefined, and there is no `note`.

- [ ] **Step 3: Implement**

`src/db.ts`: after `ensureColumn(db, 'matches', 'forfeit_team', 'TEXT');` add:

```ts
  // Scrim reviews (owner, 2026-10-11): an optional note for staff only, at
  // most 300 characters (src/scrims/reviews.ts REVIEW_NOTE_MAX). Never shown
  // to the reviewed side; '' when none.
  ensureColumn(db, 'scrim_reviews', 'note', "TEXT NOT NULL DEFAULT ''");
```

`src/scrims/reviews.ts`: replace the tag block at the top with:

```ts
/** The tags the review form offers (owner, 2026-10-11): Good comms is gone,
 *  since the other team never hears a side's voice; Easy to schedule and
 *  Flexible (OK with a map, side or sub change) are new. */
export const REVIEW_TAGS = ['on_time', 'easy_to_schedule', 'flexible', 'good_sport', 'left_early', 'toxic'] as const;
/** No longer offered or accepted, but still on stored reviews: read and
 *  labelled for staff history and the aggregate. */
export const RETIRED_REVIEW_TAGS = ['good_comms'] as const;
export const KNOWN_REVIEW_TAGS = [...REVIEW_TAGS, ...RETIRED_REVIEW_TAGS] as const;
export type ReviewTag = (typeof KNOWN_REVIEW_TAGS)[number];
export const REVIEW_TAG_LABELS: Record<ReviewTag, string> = {
  on_time: 'On time', easy_to_schedule: 'Easy to schedule', flexible: 'Flexible', good_sport: 'Good sport',
  left_early: 'Left early', toxic: 'Toxic', good_comms: 'Good comms',
};
/** A review's optional note for staff, in characters after trimming. */
export const REVIEW_NOTE_MAX = 300;
```

Then make these changes in the same file:
- `ReviewRow` gains `note: string`.
- `parseTags` keeps checking against `REVIEW_TAGS` (offered only).
- `parseTagsJson` filters against `KNOWN_REVIEW_TAGS` instead of `REVIEW_TAGS`.
- In `reviewSummary`, iterate `KNOWN_REVIEW_TAGS` instead of `REVIEW_TAGS`, and change its doc to "Tied tags go to the first in KNOWN_REVIEW_TAGS order."
- Update the module doc comment's privacy paragraph to add: "A review's note goes only to staff (staffReviews) and back to the reviewing side's own managers (ownReview), who wrote it."

Add:

```ts
/** '' for none; null for anything that is not a string of at most REVIEW_NOTE_MAX characters after trimming. */
function parseReviewNote(raw: unknown): string | null {
  if (raw === undefined || raw === null) return '';
  if (typeof raw !== 'string') return null;
  const note = raw.trim();
  return [...note].length > REVIEW_NOTE_MAX ? null : note;
}
```

In `submitReview`:
- Add `note?: unknown` to `o`.
- After the `bad_review` check, add `const note = parseReviewNote(o.note); if (note === null) return { ok: false, error: 'bad_review_note' };`.
- In the INSERT, add the `note` column and value, and add `note = excluded.note` to the `ON CONFLICT ... DO UPDATE SET` list.

`ownReview` returns `{ thumbs: r.thumbs as 1 | -1, tags: parseTagsJson(r.tags_json), note: r.note }`, and its return type gains `note: string`. `StaffReview` gains `note: string`, and `staffReviews` maps `note: r.note`.

`src/bookings/bookings.ts`:
- In `BOOKING_ERRORS`, after `bad_review`, add `bad_review_note: { status: 400, text: 'A review note is at most 300 characters.' },`.
- In `BookingView`, change `review?` to `review?: { open: boolean; mine: { thumbs: 1 | -1; tags: ReviewTag[]; note: string } | null };`, and add to its doc: "mine.note is this side's own note, which only it and staff ever see."

`src/routes/bookings.ts`: the review action becomes

```ts
  action('review', (me, id, req) => submitReview(db, { bookingId: id, by: me, thumbs: body(req).thumbs, tags: body(req).tags, note: body(req).note }));
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run tests/scrimReviews.test.ts tests/bookingRoutes.test.ts tests/teamRoutes.test.ts tests/db.test.ts tests/mergePlayers.test.ts && npm run typecheck`
Expected: PASS. The web build mirrors `ReviewTag` rather than importing it, so it is unaffected until Task 10.

- [ ] **Step 5: Commit**

```bash
git add src/scrims/reviews.ts src/db.ts src/bookings/bookings.ts src/routes/bookings.ts tests/scrimReviews.test.ts
git commit -m "Offer the new scrim review tags, keep Good comms readable, and add a staff-only review note."
```

---

### Task 9: A slur in a review note raises the conduct alert chat uses

**Files:**
- Modify: `src/conductFlags.ts` (new `flagWrittenConduct`)
- Modify: `src/adminFeed.ts` (`conduct_flag.where` gains `'review'`, plus optional `bookingId`)
- Modify: `src/discord/adminFeedPoster.ts` (the review wording)
- Modify: `src/admin/timeline/conduct.ts` (summary), `src/admin/arrived.ts` (count review notes apart from names)
- Modify: `src/scrims/reviews.ts` (`submitReview` calls it)
- Test: `tests/conductFlags.test.ts`, `tests/discordAdminFeed.test.ts`, `tests/arrived.test.ts`, `tests/scrimReviews.test.ts`

**Interfaces:**
- Produces: `flagWrittenConduct(db, o: { steamid: string; where: 'review'; text: string; bookingId: number; now?: Date }): boolean`.

- [ ] **Step 1: Write the failing tests**

`tests/conductFlags.test.ts`: add `flagWrittenConduct` to the import from `../src/conductFlags.js`, add `import { conductAdapter } from '../src/admin/timeline/conduct.js';`, and inside `describe('handleConduct', ...)` (it has `db`, `posted` and `flags`) add:

```ts
  it('a slur in a scrim review note is stored on the file and posted once per exact text', () => {
    expect(flagWrittenConduct(db, { steamid: P, where: 'review', text: 'they were fine', bookingId: 4, now: t0 })).toBe(false);
    expect(flagWrittenConduct(db, { steamid: P, where: 'review', text: 'kys lol', bookingId: 4, now: t0 })).toBe(true);
    expect(flagWrittenConduct(db, { steamid: P, where: 'review', text: 'kys lol', bookingId: 4, now: at(60) })).toBe(false);
    expect(posted).toEqual([{
      kind: 'conduct_flag', steamid: P, where: 'review', text: 'kys lol', slurs: ['kys'], matchId: null, serverId: null, bookingId: 4,
    }]);
    expect(flags()).toEqual([{ kind: 'review', detail: 'kys lol' }]);
    const items = conductAdapter.items({ db, ids: [P] } as Parameters<typeof conductAdapter.items>[0]);
    expect(items[0].summary).toBe('Wrote "kys lol" in a scrim review note (kys).');
  });
```

If `TimelineCtx` needs more fields than `db` and `ids`, fill them the way `tests/playerTimeline.test.ts` builds a context.

`tests/discordAdminFeed.test.ts`, inside `describe('admin feed', ...)`:

```ts
  it('a slur in a scrim review note is quoted, with the booking and the file linked', async () => {
    publishAdminEvent({ kind: 'conduct_flag', steamid: IDS[1], where: 'review', text: 'kys', slurs: ['kys'], matchId: null, serverId: null, bookingId: 12 });
    await settled();
    const line = JSON.stringify(inFeed().at(-1)?.payload);
    expect(line).toContain('wrote `kys` in a private scrim review on [booking #12](https://pug.test/booking/12) (kys).');
    expect(line).toContain(`https://pug.test/admin/people/${IDS[1]}`);
  });
```

`tests/arrived.test.ts`:

```ts
  it('counts review notes apart from chat and names', () => {
    const text = arrivedSince([
      item({ source: 'conduct', kind: 'chat' }),
      item({ source: 'conduct', kind: 'review' }),
      item({ source: 'conduct', kind: 'name' }),
    ], null);
    expect(text).toBe('slurs: 1 chat line, 1 name, 1 review note');
  });
```

`tests/scrimReviews.test.ts`, appended to `describe('the staff-only note ...')`:

```ts
  it('a slur in the note saves the review and raises the conduct alert; a clean note raises nothing', () => {
    const posted: AdminEvent[] = [];
    const off = subscribeAdminEvents((e) => posted.push(e));
    try {
      const id = booked(START);
      const now = new Date(closed(id) + HOUR);
      expect(submitReview(db, { bookingId: id, by: P[0], thumbs: 1, tags: [], note: 'great games', now }).ok).toBe(true);
      expect(submitReview(db, { bookingId: id, by: P[0], thumbs: -1, tags: ['toxic'], note: 'kys', now }).ok).toBe(true);
      expect(staffReviews(db, id)[0].note).toBe('kys');
      expect(posted.filter((e) => e.kind === 'conduct_flag')).toEqual([expect.objectContaining({ where: 'review', steamid: P[0], bookingId: id })]);
    } finally {
      off();
    }
  });
```

Add `import { subscribeAdminEvents, type AdminEvent } from '../src/adminFeed.js';` to that file.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/conductFlags.test.ts tests/discordAdminFeed.test.ts tests/arrived.test.ts tests/scrimReviews.test.ts`
Expected: FAIL. `flagWrittenConduct` is not exported, there is no review wording, the review note counts as a name, and nothing is posted.

- [ ] **Step 3: Implement**

`src/adminFeed.ts`: change the `conduct_flag` member to

```ts
  | {
    kind: 'conduct_flag'; steamid: string; where: 'chat' | 'name' | 'review'; text: string;
    slurs: string[]; matchId: number | null; serverId: number | null;
    /** 'review' only: the booking whose scrim review note held it. */
    bookingId?: number;
  }
```

and extend the comment above it with: "'review' is a scrim review's staff-only note (src/scrims/reviews.ts), posted once per player per exact text."

`src/conductFlags.ts`, at the end:

```ts
/**
 * A slur in text a player wrote on the site for staff only: a scrim review's
 * note (owner, 2026-10-11). The note is kept as written, since only staff
 * read it, and goes the way a chat line does: stored as a conduct flag on the
 * writer's file (kind 'review', the exact text as the detail) and posted to
 * the staff channel. Posted once per player per exact text, as names are, so
 * saving the same review again posts nothing new. True when it posted.
 */
export function flagWrittenConduct(db: DB, o: { steamid: string; where: 'review'; text: string; bookingId: number; now?: Date }): boolean {
  const slurs = findSlurs(o.text);
  if (slurs.length === 0) return false;
  const seen = db.prepare(
    "SELECT 1 FROM integrity_flags WHERE source = 'conduct' AND kind = ? AND steamid = ? AND detail = ? LIMIT 1",
  ).get(o.where, o.steamid, o.text);
  if (seen) return false;
  db.prepare(
    `INSERT INTO integrity_flags (match_id, server_id, steamid, source, kind, severity, detail, at)
     VALUES (NULL, NULL, ?, 'conduct', ?, 'suspected', ?, ?)`,
  ).run(o.steamid, o.where, o.text, (o.now ?? new Date()).toISOString());
  publishAdminEvent({ kind: 'conduct_flag', steamid: o.steamid, where: o.where, text: o.text, slurs, matchId: null, serverId: null, bookingId: o.bookingId });
  return true;
}
```

`src/discord/adminFeedPoster.ts`: in `case 'conduct_flag'`, before the existing `return`, add:

```ts
        if (e.where === 'review') {
          const booking = e.bookingId !== undefined ? ` on [booking #${e.bookingId}](${this.deps.publicUrl}/booking/${e.bookingId})` : '';
          return {
            text: `📝 ${this.name(e.steamid)} wrote ${quoted} in a private scrim review${booking} (${what}). [File](${this.file(e.steamid)})`,
            color: COLOR.problem,
          };
        }
```

Move the `const what = e.slurs.join(', ');` line above this block.

`src/admin/timeline/conduct.ts`: replace the `summary:` expression with

```ts
        summary: r.kind === 'name'
          ? `Used the name "${r.detail}" (${what}).`
          : r.kind === 'review'
            ? `Wrote "${r.detail}" in a scrim review note (${what}).`
            : `Typed "${r.detail}" in chat (${what}).`,
```

`src/admin/arrived.ts`: replace the conduct block body with

```ts
    const chat = conduct.filter((i) => i.kind === 'chat').length;
    const reviews = conduct.filter((i) => i.kind === 'review').length;
    const names = conduct.length - chat - reviews;
    const what = [
      chat ? plural(chat, 'chat line') : '', names ? plural(names, 'name') : '', reviews ? plural(reviews, 'review note') : '',
    ].filter(Boolean);
    parts.push(`slurs: ${what.join(', ')}`);
```

`src/scrims/reviews.ts`: import `flagWrittenConduct` from `'../conductFlags.js'`. In `submitReview`:
- Move `const note = parseReviewNote(o.note);` (from Task 8) above the transaction. Keep the refusal inside the transaction, right after the `bad_review` check: `if (note === null) return { ok: false, error: 'bad_review_note' };`.
- Assign the transaction's result to `const r = db.transaction(...)();` instead of returning it.
- End the function with:

```ts
  // After the commit: the note is saved either way, and a failure to flag
  // it must not undo the review (owner, 2026-10-11: through the same conduct
  // path chat uses).
  if (r.ok && note) {
    try {
      flagWrittenConduct(db, { steamid: o.by, where: 'review', text: note, bookingId: o.bookingId, now });
    } catch (err) {
      console.warn(`[scrims] review note check for booking ${o.bookingId} failed:`, err instanceof Error ? err.message : err);
    }
  }
  return r;
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run tests/conductFlags.test.ts tests/discordAdminFeed.test.ts tests/arrived.test.ts tests/scrimReviews.test.ts tests/feedRouting.test.ts tests/playerTimeline.test.ts tests/timelineEvidence.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/conductFlags.ts src/adminFeed.ts src/discord/adminFeedPoster.ts src/admin/timeline/conduct.ts src/admin/arrived.ts src/scrims/reviews.ts tests/conductFlags.test.ts tests/discordAdminFeed.test.ts tests/arrived.test.ts tests/scrimReviews.test.ts
git commit -m "Flag slurs in scrim review notes through the conduct alert path chat uses."
```

---

### Task 10: The booking page offers the new tags and the note, and staff see notes

**Files:**
- Modify: `web/src/api.ts` (`ReviewTag`, `StaffReview.note`, `BookingView.review.mine.note`, `bookingsApi.review`)
- Modify: `web/src/components/ReviewSummary.tsx` (`REVIEW_TAGS`, `REVIEW_TAG_LABELS`, `REVIEW_TAG_HINTS`, `REVIEW_NOTE_MAX`)
- Modify: `web/src/routes/Booking.tsx` (`ReviewCard`, `StaffReviews`)
- Test: `web/src/routes/Booking.test.tsx`, `web/src/components/ReviewSummary.test.tsx`

**Interfaces:**
- Produces: `bookingsApi.review(id: number, thumbs: 1 | -1, tags: ReviewTag[], note: string)`.

- [ ] **Step 1: Write the failing tests**

In `web/src/routes/Booking.test.tsx`, update 'shows the review card when open, pre-filled from mine, and posts thumbs and tags':
- Click `'Flexible'` instead of `'Good comms'`.
- Make the `review` mock return tags `['on_time', 'flexible']`.
- Expect `toHaveBeenCalledWith(7, 1, ['on_time', 'flexible'], '')`.

Then add inside `describe('private reviews ...')`:

```tsx
    it('offers no Good comms; a stored Good comms is dropped from the form, not sent; the note is sent', async () => {
      mockBookings.get.mockResolvedValue(VIEW({
        state: 'ended', connect: null, review: { open: true, mine: { thumbs: 1, tags: ['on_time', 'good_comms'], note: 'old note' } },
      }));
      mockBookings.review.mockResolvedValue(VIEW({ state: 'ended', connect: null, review: { open: true, mine: { thumbs: 1, tags: ['on_time'], note: 'they subbed late' } } }));
      render(<Booking id="7" session={session} />);
      await screen.findByText('Review Mice');
      expect(screen.queryByRole('button', { name: 'Good comms' })).toBeNull();
      expect(screen.getByRole('button', { name: 'Easy to schedule' })).toBeTruthy();
      expect(screen.getByRole('button', { name: 'Flexible' }).getAttribute('title')).toBe('OK with map, side or sub changes');
      const note = screen.getByLabelText('Note for staff (optional)') as HTMLTextAreaElement;
      expect(note.value).toBe('old note');
      expect(note.maxLength).toBe(300);
      expect(screen.getByText('Only staff ever see this note.')).toBeTruthy();
      fireEvent.input(note, { target: { value: 'they subbed late' } });
      fireEvent.click(screen.getByRole('button', { name: 'Save' }));
      await waitFor(() => expect(mockBookings.review).toHaveBeenCalledWith(7, 1, ['on_time'], 'they subbed late'));
    });

    it('the staff block shows each note and labels a retired tag', async () => {
      mockBookings.get.mockResolvedValue(VIEW({
        state: 'ended', connect: null, viewer: { side: null, manages: [], staff: true, invited: false },
        reviews: [
          { side: 'a', reviewer: 'x1', reviewerName: 'p1', thumbs: -1, tags: ['good_comms'], note: 'no voice at all', createdAt: '2026-10-02T22:00:00.000Z', updatedAt: '2026-10-02T22:00:00.000Z' },
        ],
      }));
      render(<Booking id="7" session={session} />);
      expect(await screen.findByText('Reviews (staff only)')).toBeTruthy();
      expect(screen.getByText('Good comms')).toBeTruthy();
      expect(screen.getByText('Note: no voice at all')).toBeTruthy();
    });
```

In 'the staff block shows only when reviews is present', add `note: ''` to the review object.

In `web/src/components/ReviewSummary.test.tsx`, change the `topTag` union in the helper `s` to `ReviewTag | null`, importing `type ReviewTag` from `'../api'`, and add:

```tsx
  it('labels a retired tag in the aggregate', () => {
    expect(reviewSummaryText(s(80, 'good_comms'))).toBe('80% positive, top tag: Good comms');
    expect(reviewSummaryText(s(80, 'easy_to_schedule'))).toBe('80% positive, top tag: Easy to schedule');
  });
```

Import `reviewSummaryText` there if the file does not already.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run web/src/routes/Booking.test.tsx web/src/components/ReviewSummary.test.tsx`
Expected: FAIL. There is no Flexible button and no note field, and review is called with 3 arguments.

- [ ] **Step 3: Implement**

`web/src/api.ts`:
- `ReviewTag`:

```ts
/** Mirrors src/scrims/reviews.ts's KNOWN_REVIEW_TAGS: the six offered since
 *  2026-10-11 and the retired good_comms, still on stored reviews. */
export type ReviewTag = 'on_time' | 'easy_to_schedule' | 'flexible' | 'good_sport' | 'left_early' | 'toxic' | 'good_comms';
```

- `StaffReview` gains `/** Staff only; '' when none. */ note: string;`.
- `BookingView.review` becomes `review?: { open: boolean; mine: { thumbs: 1 | -1; tags: ReviewTag[]; note?: string } | null };`.
- `bookingsApi.review`:

```ts
  review: (id: number, thumbs: 1 | -1, tags: ReviewTag[], note: string) => post<BookingView>(`/api/bookings/${id}/review`, { thumbs, tags, note }),
```

`web/src/components/ReviewSummary.tsx`: replace the two exports at the top with

```tsx
/** Mirrors src/scrims/reviews.ts: REVIEW_TAGS is what the form offers;
 *  REVIEW_TAG_LABELS also names the retired good_comms for stored reviews. */
export const REVIEW_TAGS: ReviewTag[] = ['on_time', 'easy_to_schedule', 'flexible', 'good_sport', 'left_early', 'toxic'];
export const REVIEW_TAG_LABELS: Record<ReviewTag, string> = {
  on_time: 'On time', easy_to_schedule: 'Easy to schedule', flexible: 'Flexible', good_sport: 'Good sport',
  left_early: 'Left early', toxic: 'Toxic', good_comms: 'Good comms',
};
/** A tag's tooltip, where the label alone could be misread. */
export const REVIEW_TAG_HINTS: Partial<Record<ReviewTag, string>> = { flexible: 'OK with map, side or sub changes' };
/** Mirrors src/scrims/reviews.ts's REVIEW_NOTE_MAX. */
export const REVIEW_NOTE_MAX = 300;
```

`web/src/routes/Booking.tsx`: import `REVIEW_TAG_HINTS, REVIEW_NOTE_MAX` alongside the existing two. In `ReviewCard`:
- The tags state starts as `(mine?.tags ?? []).filter((t) => REVIEW_TAGS.includes(t))`, with a comment: "A retired tag (Good comms) is dropped rather than sent: the server refuses it now."
- Add `const [note, setNote] = useState(mine?.note ?? '');`.
- The tag buttons gain `title={REVIEW_TAG_HINTS[t]}`.
- `save` calls `bookingsApi.review(v.id, thumbs, tags, note)`.
- Before the Save paragraph, add:

```tsx
      <label class="teamfield">Note for staff (optional)
        <textarea aria-label="Note for staff (optional)" value={note} maxLength={REVIEW_NOTE_MAX} rows={3}
          onInput={(e) => { setSaved(false); setNote((e.target as HTMLTextAreaElement).value); }} />
      </label>
      <p class="muted">Only staff ever see this note.</p>
```

Update `ReviewCard`'s doc comment to add: "plus an optional note only staff (and this side) ever see".

In `StaffReviews`, after the tags span, add `{r.note && <span class="muted">Note: {r.note}</span>}`.

- [ ] **Step 4: Run the tests**

Run: `npx vitest run web/src/routes/Booking.test.tsx web/src/components/ReviewSummary.test.tsx web/src/routes/Team.test.tsx && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add web/src/api.ts web/src/components/ReviewSummary.tsx web/src/components/ReviewSummary.test.tsx web/src/routes/Booking.tsx web/src/routes/Booking.test.tsx
git commit -m "Offer the new review tags and a staff-only note on the booking page, and show notes to staff."
```

---

### Task 11: A booking's series result

**Files:**
- Create: `src/bookings/series.ts`
- Modify: `src/bookings/games.ts` (`BookingGameView.winner`, `.voided`, and `TeamScrim.series` with `counted`/`voided` per game)
- Modify: `src/bookings/bookings.ts` (`BookingView.series`)
- Test: create `tests/bookingSeries.test.ts`; update `tests/bookings.test.ts` and `tests/bookingGames.test.ts`

**Interfaces:**
- Produces, in `src/bookings/series.ts`:
  - `interface SeriesTally { wins: Record<Side, number>; draws: number; counted: number }`
  - `countsInSeries(g: Pick<BookingGameView, 'state' | 'voided'>): boolean`
  - `gameWinner(g: BookingGameView): Side | 'draw' | null`
  - `seriesTally(games: BookingGameView[]): SeriesTally`
  - `sideScores(g: BookingGameView): Record<Side, number>`
  - `seriesLine(first: string, firstWins: number, secondWins: number, second: string, draws: number): string`
  - `gameLine(g: BookingGameView, campaignName: string, first: Side): string`
  - `claimResultNotice(db: DB, bookingId: number, now: Date): boolean`
- Produces: `BookingGameView` gains `winner: 'a' | 'b' | 'draw' | null` (match teams) and `voided: boolean`.
- Produces: `BookingView` gains `series: SeriesTally | null` (null when the viewer does not see the games).
- Produces: `TeamScrim` gains `series: { us: number; them: number; draws: number; counted: number }`, and each game gains `counted: boolean; voided: boolean`.

- [ ] **Step 1: Write the failing tests**

Create `tests/bookingSeries.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import type { BookingGameView } from '../src/bookings/games.js';
import { countsInSeries, gameLine, gameWinner, seriesLine, seriesTally, sideScores } from '../src/bookings/series.js';

const g = (over: Partial<BookingGameView>): BookingGameView => ({
  matchId: 1, campaign: 'dark_wood', state: 'completed', scoreA: 0, scoreB: 0, sideA: 'a', winner: null, voided: false,
  startedAt: '2026-10-11 20:00:00', endedAt: null, restoredAtMap: null, ...over,
});

describe('the series result (owner, 2026-10-11)', () => {
  // Booking 2: big BAD boys side a, Test side b; both games had booking_side_a 'b'.
  const darkWood = g({ matchId: 644, campaign: 'dark_wood', sideA: 'b', scoreA: 347, scoreB: 250, winner: 'a' });
  const bloodHarvest = g({ matchId: 645, campaign: 'blood_harvest', sideA: 'b', scoreA: 328, scoreB: 893, winner: 'b' });

  it('orients each game to the booking sides through its own booking_side_a', () => {
    expect(gameWinner(darkWood)).toBe('b'); // Test
    expect(gameWinner(bloodHarvest)).toBe('a'); // big BAD boys
    expect(sideScores(darkWood)).toEqual({ a: 250, b: 347 });
    expect(seriesTally([darkWood, bloodHarvest])).toEqual({ wins: { a: 1, b: 1 }, draws: 0, counted: 2 });
    expect(seriesLine('Test', 1, 1, 'big BAD boys', 0)).toBe('Test 1 - 1 big BAD boys');
    expect(gameLine(darkWood, 'Dark Wood', 'b')).toBe('Dark Wood: 347 - 250');
    expect(gameLine(bloodHarvest, 'Blood Harvest', 'b')).toBe('Blood Harvest: 328 - 893');
  });

  it('aborted, voided and live games never count, and say so', () => {
    const aborted = g({ state: 'aborted', scoreA: 100, scoreB: 0 });
    const voided = g({ state: 'aborted', voided: true, winner: 'a', scoreA: 500, scoreB: 100 });
    const live = g({ state: 'live', scoreA: 50, scoreB: 0 });
    for (const x of [aborted, voided, live]) expect(countsInSeries(x)).toBe(false);
    expect(seriesTally([aborted, voided, live])).toEqual({ wins: { a: 0, b: 0 }, draws: 0, counted: 0 });
    expect(gameLine(aborted, 'No Mercy', 'a')).toBe('No Mercy: not finished, not counted');
    expect(gameLine(voided, 'No Mercy', 'a')).toBe('No Mercy: voided, not counted');
  });

  it('a draw reads as one, a single game reads sensibly, and a missing winner falls back to the scores', () => {
    const draw = g({ winner: 'draw', scoreA: 400, scoreB: 400 });
    expect(seriesTally([draw])).toEqual({ wins: { a: 0, b: 0 }, draws: 1, counted: 1 });
    expect(seriesLine('Rats', 0, 0, 'Mice', 1)).toBe('Rats 0 - 0 Mice, 1 draw');
    expect(seriesLine('Rats', 1, 1, 'Mice', 2)).toBe('Rats 1 - 1 Mice, 2 draws');
    expect(gameLine(draw, 'No Mercy', 'a')).toBe('No Mercy: 400 - 400 (draw)');
    expect(seriesLine('Rats', 1, 0, 'Mice', 0)).toBe('Rats 1 - 0 Mice');
    expect(gameWinner(g({ winner: null, sideA: null, scoreA: 10, scoreB: 20 }))).toBe('b');
  });
});
```

In `tests/bookings.test.ts`, "bookingView lists the booking's games oldest first": give the helper's INSERT a `winner` column (`'a'` for the completed game, `null` for the live one), and replace the final `toEqual` with:

```ts
    expect(v.games).toEqual([
      { matchId: first, campaign: 'no_mercy', state: 'completed', scoreA: 300, scoreB: 200, sideA: 'a', winner: 'a', voided: false, startedAt: expect.any(String), endedAt: null, restoredAtMap: null },
      { matchId: second, campaign: 'no_mercy', state: 'live', scoreA: 10, scoreB: 5, sideA: 'a', winner: null, voided: false, startedAt: expect.any(String), endedAt: null, restoredAtMap: null },
    ]);
    expect(v.series).toEqual({ wins: { a: 1, b: 0 }, draws: 0, counted: 1 });
```

In `tests/bookingGames.test.ts`, inside `describe('teamScrims', ...)`, add:

```ts
  it('tallies each booking from the team\'s own side, counting only completed games', () => {
    const alpha = createTeam(db, { creator: P[0], name: 'Team Alpha', tag: 'ALF' });
    if (!alpha.ok) throw new Error(alpha.error);
    const id = teamBooking({ by: P[5], opponent: { teamId: alpha.value.id }, startsAt: START }); // Alpha is side b
    const won = insertGame(id, 'completed', 'b', 30, 10, 't1');
    db.prepare("UPDATE matches SET winner = 'a' WHERE id = ?").run(won); // match team a = booking side b = Alpha
    insertGame(id, 'aborted', 'a', 0, 99, 't2');
    const s = teamScrims(db, alpha.value.id)[0];
    expect(s.series).toEqual({ us: 1, them: 0, draws: 0, counted: 1 });
    expect(s.games.map((x) => [x.state, x.counted, x.voided])).toEqual([['completed', true, false], ['aborted', false, false]]);
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/bookingSeries.test.ts tests/bookings.test.ts tests/bookingGames.test.ts`
Expected: FAIL. The series module does not exist, and `winner`, `voided` and `series` are missing.

- [ ] **Step 3: Implement**

`src/bookings/games.ts`: `BookingGameView` gains

```ts
  /** matches.winner, by MATCH team ('a' is whichever booking side sideA
   *  names); null until the game has a result. */
  winner: 'a' | 'b' | 'draw' | null;
  /** A completed game staff voided afterwards (stored as aborted with voided_at). */
  voided: boolean;
```

`bookingGames` selects `winner, voided_at` too, widens the row type with `winner: 'a' | 'b' | 'draw' | null; voided_at: string | null`, and maps `winner: r.winner, voided: r.voided_at !== null`.

`TeamScrim` gains `series: { us: number; them: number; draws: number; counted: number }`. Each of its games gains `counted: boolean; voided: boolean`. In `teamScrims`, build `const games = bookingGames(db, r.id);` once and return:

```ts
      games: games.map((g) => ({
        matchId: g.matchId, campaign: g.campaign, state: g.state,
        us: g.sideA === r.side ? g.scoreA : g.scoreB,
        them: g.sideA === r.side ? g.scoreB : g.scoreA,
        counted: countsInSeries(g), voided: g.voided,
      })),
      series: (() => {
        const t = seriesTally(games);
        return { us: t.wins[r.side], them: t.wins[r.side === 'a' ? 'b' : 'a'], draws: t.draws, counted: t.counted };
      })(),
```

Import `countsInSeries, seriesTally` from `'./series.js'`.

Note: the existing `us`/`them` expressions compare `g.sideA === r.side`, which reads a null `sideA` as "not my side". Leave them as they are; `series.ts` reads null as side a, matching `bookingSideForTeamA`'s default and the booking page.

Create `src/bookings/series.ts`:

```ts
import type { DB } from '../db.js';
import { logBookingEvent, type Side } from './bookings.js';
import type { BookingGameView } from './games.js';

/**
 * A booking's series result (owner, 2026-10-11): how many games each booking
 * side won, read from the booking's own games. Shown on the booking page, on
 * each team's Scrims panel from its own side, and sent privately to both
 * sides when the box comes back (runner announceResult). Never posted
 * anywhere public: scrims are participants-only.
 *
 * A game counts once it completed. An aborted game (stopped, its box lost,
 * the booking ended under it) and a voided one (stored as aborted with
 * voided_at) never count; a live one does not count yet. Which booking side
 * won follows that game's own booking_side_a (null reads as side a, as
 * bookingSideForTeamA's default does) and matches.winner, falling back to the
 * scores for a completed row with no winner.
 */
export interface SeriesTally { wins: Record<Side, number>; draws: number; counted: number }

const other = (s: Side): Side => (s === 'a' ? 'b' : 'a');

export function countsInSeries(g: Pick<BookingGameView, 'state' | 'voided'>): boolean {
  return g.state === 'completed' && !g.voided;
}

/** The booking side that won this game, 'draw', or null when it does not count. */
export function gameWinner(g: BookingGameView): Side | 'draw' | null {
  if (!countsInSeries(g)) return null;
  const teamA: Side = g.sideA ?? 'a';
  const w = g.winner ?? (g.scoreA > g.scoreB ? 'a' : g.scoreB > g.scoreA ? 'b' : 'draw');
  return w === 'draw' ? 'draw' : w === 'a' ? teamA : other(teamA);
}

export function seriesTally(games: BookingGameView[]): SeriesTally {
  const t: SeriesTally = { wins: { a: 0, b: 0 }, draws: 0, counted: 0 };
  for (const g of games) {
    const w = gameWinner(g);
    if (w === null) continue;
    t.counted++;
    if (w === 'draw') t.draws++;
    else t.wins[w]++;
  }
  return t;
}

/** A game's score for booking side a and side b. */
export function sideScores(g: BookingGameView): Record<Side, number> {
  return (g.sideA ?? 'a') === 'a' ? { a: g.scoreA, b: g.scoreB } : { a: g.scoreB, b: g.scoreA };
}

/** "Test 1 - 1 big BAD boys", with ", 1 draw" or ", 2 draws" after it.
 *  Mirrored by web/src/series.ts. */
export function seriesLine(first: string, firstWins: number, secondWins: number, second: string, draws: number): string {
  const tail = draws === 0 ? '' : draws === 1 ? ', 1 draw' : `, ${draws} draws`;
  return `${first} ${firstWins} - ${secondWins} ${second}${tail}`;
}

/** One game for the result DM, `first`'s score first. */
export function gameLine(g: BookingGameView, campaignName: string, first: Side): string {
  if (g.voided) return `${campaignName}: voided, not counted`;
  if (g.state !== 'completed') return `${campaignName}: not finished, not counted`;
  const s = sideScores(g);
  return `${campaignName}: ${s[first]} - ${s[other(first)]}${gameWinner(g) === 'draw' ? ' (draw)' : ''}`;
}

/** Claim the one result notice for this booking: true the first time only,
 *  when it also writes the result_sent event, as claimReviewAsk does. */
export function claimResultNotice(db: DB, bookingId: number, now: Date): boolean {
  return db.transaction(() => {
    if (db.prepare("SELECT 1 FROM booking_events WHERE booking_id = ? AND event = 'result_sent'").get(bookingId)) return false;
    logBookingEvent(db, bookingId, null, 'result_sent', {}, now);
    return true;
  })();
}
```

`src/bookings/bookings.ts`: import `seriesTally, type SeriesTally` from `'./series.js'`. In `BookingView`, after `games`:

```ts
  /** The series so far from the games above (src/bookings/series.ts); null
   *  for a viewer who does not see the games. */
  series: SeriesTally | null;
```

In `bookingView`, compute `const games = seesGames ? bookingGames(db, id) : [];` once, and return `games,` and `series: seesGames ? seriesTally(games) : null,`.

- [ ] **Step 4: Run the tests**

Run: `npx vitest run tests/bookingSeries.test.ts tests/bookings.test.ts tests/bookingGames.test.ts tests/teamRoutes.test.ts tests/bookingRoutes.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/bookings/series.ts src/bookings/games.ts src/bookings/bookings.ts tests/bookingSeries.test.ts tests/bookings.test.ts tests/bookingGames.test.ts
git commit -m "Tally each booking's games into a series result for the booking page and team panels."
```

---

### Task 12: The series result on the booking page and the team Scrims panel

**Files:**
- Create: `web/src/series.ts`, `web/src/series.test.ts`
- Modify: `web/src/api.ts` (`BookingView.series`, `BookingGameView.winner`/`voided`, `TeamScrim.series` and game `counted`/`voided`)
- Modify: `web/src/routes/Booking.tsx` (the Games panel), `web/src/routes/Team.tsx` (the Scrims panel)
- Test: `web/src/routes/Booking.test.tsx`, `web/src/routes/Team.test.tsx`

**Interfaces:**
- Produces, in `web/src/series.ts`: `seriesLine(first, firstWins, secondWins, second, draws): string` and `notCountedLabel(g: { state: string; voided?: boolean }): string | null`.

- [ ] **Step 1: Write the failing tests**

Create `web/src/series.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { notCountedLabel, seriesLine } from './series';

describe('series text', () => {
  it('mirrors the server line', () => {
    expect(seriesLine('Test', 1, 1, 'big BAD boys', 0)).toBe('Test 1 - 1 big BAD boys');
    expect(seriesLine('Rats', 0, 0, 'Mice', 1)).toBe('Rats 0 - 0 Mice, 1 draw');
    expect(seriesLine('Rats', 2, 1, 'Mice', 2)).toBe('Rats 2 - 1 Mice, 2 draws');
  });
  it('says which games do not count', () => {
    expect(notCountedLabel({ state: 'completed' })).toBeNull();
    expect(notCountedLabel({ state: 'live' })).toBeNull();
    expect(notCountedLabel({ state: 'aborted' })).toBe('Not finished, not counted');
    expect(notCountedLabel({ state: 'aborted', voided: true })).toBe('Voided, not counted');
  });
});
```

In `web/src/routes/Booking.test.tsx`, inside `describe('games ...')`:

```tsx
    it('shows the series from the viewer\'s own side first, rows in the same order, and marks games that do not count', async () => {
      mockBookings.get.mockResolvedValue(VIEW({
        viewer: { side: 'b', manages: ['b'], staff: false, invited: false },
        state: 'ended', connect: null,
        games: [
          { ...GAME, matchId: 644, campaign: 'no_mercy', sideA: 'b', scoreA: 347, scoreB: 250, winner: 'a', voided: false },
          { ...GAME, matchId: 645, campaign: 'death_toll', sideA: 'b', scoreA: 328, scoreB: 893, winner: 'b', voided: false },
          { ...GAME, matchId: 646, campaign: 'no_mercy', state: 'aborted', sideA: 'a', scoreA: 10, scoreB: 0, winner: null, voided: false },
        ],
        series: { wins: { a: 1, b: 1 }, draws: 0, counted: 2 },
      }));
      render(<Booking id="7" session={session} />);
      expect(await screen.findByText("Mice 1 - 1 p0's group")).toBeTruthy();
      expect(screen.getByText("Mice 347 : 250 p0's group")).toBeTruthy();
      expect(screen.getByText('Not finished, not counted')).toBeTruthy();
    });

    it('shows no series line while no game counts', async () => {
      mockBookings.get.mockResolvedValue(VIEW({ games: [{ ...GAME, state: 'live' }], series: { wins: { a: 0, b: 0 }, draws: 0, counted: 0 } }));
      render(<Booking id="7" session={session} />);
      await screen.findByText("p0's group 5 : 3 Mice");
      expect(screen.queryByText(/ - .* p0's group|p0's group \d - \d/)).toBeNull();
    });
```

The first test has viewer side b, so rows read side b (Mice) first: for match 644 (sideA 'b', 347 to 250), Mice has 347. The rendering code must therefore order each row by the viewer's side.

In `web/src/routes/Team.test.tsx`, add:

```tsx
  it('shows each scrim\'s series from the team\'s own side, and marks a game that does not count', async () => {
    mockTeams.get.mockResolvedValue(view({ viewer: { role: 'member', staff: false } }));
    mockTeams.scrims.mockResolvedValue({ scrims: [scrim({
      games: [
        { matchId: 7, campaign: 'no_mercy', state: 'completed', us: 2, them: 1, counted: true, voided: false },
        { matchId: 8, campaign: 'no_mercy', state: 'aborted', us: 0, them: 0, counted: false, voided: true },
      ],
      series: { us: 1, them: 0, draws: 0, counted: 1 },
    })] });
    render(<Team slug="rats" session={session('2')} />);
    expect(await screen.findByText('Riverside Rats 1 - 0 Other Crew')).toBeTruthy();
    expect(screen.getByText('Voided, not counted')).toBeTruthy();
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run web/src/series.test.ts web/src/routes/Booking.test.tsx web/src/routes/Team.test.tsx`
Expected: FAIL. The module does not exist, and the series lines are absent.

- [ ] **Step 3: Implement**

Create `web/src/series.ts`:

```ts
/** Mirrors src/bookings/series.ts's seriesLine and its rule for which games
 *  count: completed and not voided; a live game is simply not over yet. */
export function seriesLine(first: string, firstWins: number, secondWins: number, second: string, draws: number): string {
  const tail = draws === 0 ? '' : draws === 1 ? ', 1 draw' : `, ${draws} draws`;
  return `${first} ${firstWins} - ${secondWins} ${second}${tail}`;
}

export function notCountedLabel(g: { state: string; voided?: boolean }): string | null {
  if (g.voided) return 'Voided, not counted';
  if (g.state === 'completed' || g.state === 'live') return null;
  return 'Not finished, not counted';
}
```

`web/src/api.ts`:
- `BookingGameView` gains `winner?: 'a' | 'b' | 'draw' | null; voided?: boolean;` with the comment "Optional for an older server."
- `BookingView` gains `/** Optional for an older server; null when the viewer does not see the games. */ series?: { wins: { a: number; b: number }; draws: number; counted: number } | null;`.
- `TeamScrim` gains `series?: { us: number; them: number; draws: number; counted: number };`, and its games gain `counted?: boolean; voided?: boolean;`.

`web/src/routes/Booking.tsx`: import `seriesLine, notCountedLabel` from `'../series'`. Replace the Games panel body with:

```tsx
      {v.games.length > 0 && (() => {
        // The viewer's own side first (side a for staff and outsiders), in
        // the series line and every row (owner, 2026-10-11).
        const first: BookingSide = v.viewer.side ?? 'a';
        const second: BookingSide = first === 'a' ? 'b' : 'a';
        const nameOf = (s: BookingSide) => v.sides.find((x) => x.side === s)!.name;
        return (
          <Panel>
            <h3>Games</h3>
            {v.series && v.series.counted > 0 && (
              <p><strong>{seriesLine(nameOf(first), v.series.wins[first], v.series.wins[second], nameOf(second), v.series.draws)}</strong></p>
            )}
            <ul class="bookinggames">
              {v.games.map((g) => {
                const scores = g.sideA === 'b' ? { a: g.scoreB, b: g.scoreA } : { a: g.scoreA, b: g.scoreB };
                const notCounted = notCountedLabel(g);
                return (
                  <li key={g.matchId}>
                    <span>{campaignName(g.campaign)}</span>
                    <span>{nameOf(first)} {scores[first]} : {scores[second]} {nameOf(second)}</span>
                    <span class="muted">{g.state}</span>
                    {notCounted && <span class="muted">{notCounted}</span>}
                    {g.restoredAtMap !== null && (
                      <span class="muted">Stats from map {g.restoredAtMap + 1} on: the server restarted</span>
                    )}
                    <a href={`/match/${g.matchId}`}>View</a>
                  </li>
                );
              })}
            </ul>
          </Panel>
        );
      })()}
```

`BookingSide` is already imported. The existing games tests use viewer side a, so their row text is unchanged.

`web/src/routes/Team.tsx`: import `seriesLine, notCountedLabel` from `'../series'`. Inside each scrim `<li>`, right after the `bookingrow` div:

```tsx
                  {s.series && s.series.counted > 0 && (
                    <p class="scrimrecord">{seriesLine(team.name, s.series.us, s.series.them, s.opponent, s.series.draws)}</p>
                  )}
```

In each game row, after `<span class="muted">{g.state}</span>`, add `{notCountedLabel(g) && <span class="muted">{notCountedLabel(g)}</span>}`.

- [ ] **Step 4: Run the tests**

Run: `npx vitest run web/src/series.test.ts web/src/routes/Booking.test.tsx web/src/routes/Team.test.tsx && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add web/src/series.ts web/src/series.test.ts web/src/api.ts web/src/routes/Booking.tsx web/src/routes/Booking.test.tsx web/src/routes/Team.tsx web/src/routes/Team.test.tsx
git commit -m "Show each scrim's series result on the booking page and the team Scrims panel, own side first."
```

---

### Task 13: Both sides get the series result privately when the scrim ends

**Files:**
- Modify: `src/notify/notify.ts` (`'scrim_result'`)
- Modify: `src/bookings/messages.ts` (`resultMessage`)
- Modify: `src/bookings/runner.ts` (`announceResult`, called after each `markReleased` in `windDown`)
- Test: `tests/bookingRunner.test.ts`

**Interfaces:**
- Consumes: `seriesTally`, `seriesLine`, `gameLine`, `claimResultNotice` (Task 11), and `bookingGames` (with `winner`/`voided`).
- Produces: `resultMessage(db: DB, publicUrl: string, bookingId: number, side: Side): MessagePayload | null`.

- [ ] **Step 1: Write the failing tests**

In `tests/bookingRunner.test.ts`, inside `describe('booked games (plan 4b)', ...)` (it has `running`, `events` and `sqlTime`), add:

```ts
  // Owner, 2026-10-11: the series result goes privately to both sides, each
  // oriented to its own side, once the box is back; once per booking.
  const scored = (bookingId: number, o: { campaign: string; state: string; sideA: 'a' | 'b'; a: number; b: number; winner: 'a' | 'b' | 'draw' | null }) =>
    db.prepare(
      `INSERT INTO matches (season_id, state, campaign, server_id, token, origin, kind, visibility, booking_id, booking_side_a, team_a_score, team_b_score, winner, ended_at)
       VALUES (?, ?, ?, 3, ?, 'in_game', 'scrim', 'participants', ?, ?, ?, ?, ?, ?)`,
    ).run(currentSeasonId(db), o.state, o.campaign, `t${Math.random()}`, bookingId, o.sideA, o.a, o.b, o.winner, sqlTime(now));

  it('sends each side the series result once its box is back, oriented to that side, and never twice', async () => {
    const id = await running(['no_mercy', 'death_toll']);
    scored(id, { campaign: 'no_mercy', state: 'completed', sideA: 'a', a: 400, b: 300, winner: 'a' });
    scored(id, { campaign: 'death_toll', state: 'completed', sideA: 'b', a: 500, b: 450, winner: 'a' });
    scored(id, { campaign: 'no_mercy', state: 'aborted', sideA: 'a', a: 10, b: 0, winner: null });
    expect(runner.endFromGame(id, P[0])).toEqual({ ok: true });
    await runner.idle();
    const results = dms.filter((d) => d.content.startsWith('Scrim result:'));
    expect(results.map((d) => [d.to, d.content]).sort()).toEqual([
      ['d0', "Scrim result: **p0's group** 1 - 1 **p1's group**\nNo Mercy: 400 - 300\nDeath Toll: 450 - 500\nNo Mercy: not finished, not counted"],
      ['d1', "Scrim result: **p1's group** 1 - 1 **p0's group**\nNo Mercy: 300 - 400\nDeath Toll: 500 - 450\nNo Mercy: not finished, not counted"],
    ]);
    expect(events(id, 'result_sent')).toHaveLength(1);
    runner.settle(id);
    await runner.tick();
    await runner.idle();
    expect(dms.filter((d) => d.content.startsWith('Scrim result:'))).toHaveLength(2);
  });

  it('sends no result when no game counted, nor for a tournament booking', async () => {
    const id = await running(['no_mercy']);
    scored(id, { campaign: 'no_mercy', state: 'aborted', sideA: 'a', a: 10, b: 0, winner: null });
    runner.endFromGame(id, P[0]);
    await runner.idle();
    expect(dms.some((d) => d.content.startsWith('Scrim result:'))).toBe(false);
    expect(events(id, 'result_sent')).toHaveLength(0);
    const cup = book({ pair: [P[2], P[3]] });
    db.prepare("UPDATE bookings SET purpose = 'tournament' WHERE id = ?").run(cup);
    scored(cup, { campaign: 'no_mercy', state: 'completed', sideA: 'a', a: 400, b: 300, winner: 'a' });
    db.prepare("UPDATE bookings SET state = 'ended', end_reason = 'staff', ending_at = ? WHERE id = ?").run(new Date(now).toISOString(), cup);
    runner.settle(cup);
    await runner.idle();
    expect(dms.some((d) => d.content.startsWith('Scrim result:'))).toBe(false);
  });
```

`book({ pair })` comes from Task 1.

If `escapeName` turns the apostrophe in "p0's group" into an escape sequence, use the exact escaped form. The existing review test shows the apostrophe passes through unescaped. `campaignDisplayName` gives "No Mercy" and "Death Toll" for these stock slugs.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/bookingRunner.test.ts -t "series result|sends no result"`
Expected: FAIL, because no "Scrim result:" DM is sent.

- [ ] **Step 3: Implement**

`src/notify/notify.ts`:
- Add `| 'scrim_result'` after `'scrim_review'` in `NotifyType`.
- In `NOTIFY_TYPES`, after the `scrim_review` row, add `{ type: 'scrim_result', label: 'A scrim I played in finished, with the series result' },`.

`src/bookings/messages.ts`: import `campaignDisplayName` from `'../campaignRegistry.js'`, `bookingGames` from `'./games.js'`, and `gameLine, seriesLine, seriesTally` from `'./series.js'`. Add at the end:

```ts
/** The private series result (owner, 2026-10-11) for one side's people and
 *  managers, that side first; null for a booking that is gone or has no
 *  counted game. Sent once per booking by the runner's announceResult. Never
 *  to a channel: scrims are participants-only. */
export function resultMessage(db: DB, publicUrl: string, bookingId: number, side: Side): MessagePayload | null {
  const b = getBooking(db, bookingId);
  if (!b) return null;
  const sides = sidesOf(db, b.id);
  const mine = sides.find((s) => s.side === side);
  const theirs = sides.find((s) => s.side !== side);
  if (!mine || !theirs) return null;
  const games = bookingGames(db, b.id).filter((g) => g.state !== 'live');
  const t = seriesTally(games);
  if (t.counted === 0) return null;
  const head = `Scrim result: ${seriesLine(`**${escapeName(sideName(db, mine))}**`, t.wins[side], t.wins[theirs.side], `**${escapeName(sideName(db, theirs))}**`, t.draws)}`;
  return {
    content: [head, ...games.map((g) => gameLine(g, campaignDisplayName(db, g.campaign), side))].join('\n'),
    embeds: [],
    components: [[{ kind: 'link', url: `${publicUrl}/booking/${b.id}`, label: 'Open the booking' }]],
    mentionUserIds: [],
  };
}
```

`src/bookings/runner.ts`:
- Import `resultMessage` alongside `reviewAskMessage` from `'./messages.js'`.
- Import `claimResultNotice, seriesTally` from `'./series.js'`.
- Make sure `acceptedPeople` and `sidesOf` are imported from `'./bookings.js'` (both are already used in this file).
- Add after `askReview`:

```ts
  /** Owner, 2026-10-11: once a scrim's box is back, each side's managers and
   *  accepted people get the series result, oriented to their own side, when
   *  at least one game counted. Private to the two sides (scrims are
   *  participants-only), never a channel post; a tournament booking has its
   *  own result notices. Once per booking: claimResultNotice writes the
   *  result_sent event. Never throws, like tell(). */
  private announceResult(id: number): void {
    const b = getBooking(this.db, id);
    if (!b || b.purpose !== 'scrim') return;
    try {
      if (seriesTally(bookingGames(this.db, id)).counted === 0) return;
      if (!claimResultNotice(this.db, id, new Date(this.now()))) return;
      const people = acceptedPeople(this.db, id);
      for (const s of sidesOf(this.db, id)) {
        const payload = resultMessage(this.db, this.deps.publicUrl, id, s.side);
        if (!payload) continue;
        const to = [...sideManagers(this.db, s), ...people.filter((p) => p.side === s.side).map((p) => p.steamid)];
        this.deps.notifier.send(to, 'scrim_result', payload);
      }
    } catch (err) {
      console.warn(`[booking] ${id}: scrim_result notice failed:`, err instanceof Error ? err.message : err);
    }
  }
```

In `windDown`, change `if (b.server_id === null) { markReleased(this.db, id, new Date(this.now())); return; }` to `if (b.server_id === null) { markReleased(this.db, id, new Date(this.now())); this.announceResult(id); return; }`. After the later `markReleased(this.db, id, new Date(this.now()));` line, add `this.announceResult(id);`. By then `windDown` has aborted any live game, so the tally is final.

For the tournament case in the test: `settle` on a tournament booking runs `windDown`, which calls `announceResult`, which returns at the purpose check.

- [ ] **Step 4: Run the tests**

Run: `npx vitest run tests/bookingRunner.test.ts tests/notify.test.ts tests/scrimReviews.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/notify/notify.ts src/bookings/messages.ts src/bookings/runner.ts tests/bookingRunner.test.ts
git commit -m "DM both sides the scrim's series result privately once its server is released."
```

---

## After the last task

- [ ] Run the whole suite and typecheck: `npx vitest run && npm run typecheck`. Expected: PASS.
- [ ] Scan the diff for em dashes: `git diff master --name-only | xargs grep -nP "\x{2014}"`. Expected: no output.
- [ ] Leave deploying to the owner. `deploy-web.sh` covers every change here: there is no plugin change, and the `note` column is added by `ensureColumn` at start.

## Self-review notes

- **Coverage:**
  - Item 1: Tasks 1 to 3.
  - Item 2: Task 5 (the API already returned the id).
  - Item 6: Task 6.
  - Item 11: Task 7.
  - Item 12: Tasks 8 to 10.
  - Item 15: Tasks 11 to 13.
  - Audit (a): Tasks 1 and 3. (b): Task 2. (c): Task 3. (d): Task 4.
- **Not touched, on purpose:** `expire()`, `board()` and all SR code (compete-sweep branch); the Scrims page header (compete-nav branch).
- **Merge overlap to expect:**
  - `SCRIM_ERRORS` and the area around `openPostCount` in `src/scrims/scrims.ts`, against compete-sweep.
  - `web/src/routes/Scrims.tsx`'s `Scrims()` body, against compete-nav's header work, at most a few lines apart.
