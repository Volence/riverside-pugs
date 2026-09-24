# Tickets Phase 3b1 Implementation Plan: staff tickets and site-only restricted tickets

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A report about a moderator or admin becomes an ordinary ticket the whole team works (only `unsafe` reports are restricted, for anyone), restricted tickets stop getting any Discord thread, and the accused never reads their own case on the site, in the admin feed or in the staff forum.

**Architecture:** The restriction rule shrinks to one line in `fileReport` (`category === 'unsafe'`). Everything that used to force restriction because the accused holds a staff flag either goes (`restrictOpenTicketAbout`, the `about_staff` surface, the "stays restricted" refusal) or turns into the narrower thing it was really protecting: `holdFeedAbout` keeps reports off the admin feed, `ticketIsQuiet` keeps audit rows off it, `forumAudience` keeps the accused out of the staff forum while a post about them can stand, and `forbiddenForumThreads` deletes a closed post about a member of staff so that they can be let back in. `surfaceFor` sends a restricted ticket nowhere on Discord; the access list is still DMed the site link. Two carried items ride along: `adoptDiscordPerson` stops losing what it used to drop, and a player's case view lists the Discord sanctions from before they linked Steam.

**Tech Stack:** TypeScript, better-sqlite3, fastify, vitest, Preact.

**Spec:** `docs/superpowers/specs/2026-09-22-tickets-phase3-design.md` (section 3's "Restricted tickets stop getting a staff thread", and the Auto-restrict paragraph of section 1, which the owner's 2026-09-22 ruling below replaces). Builds on phases 3a and 3c as deployed (master `694810c`). Phase 3b2 (`2026-09-22-tickets-phase3b2-reporter-chat.md`) is written against the interfaces this plan produces.

**The owner's ruling this plan implements (2026-09-22):** "If chew is being slow to ready up or rude we should know. But if it's serious allegations that's what I don't want them seeing." Confirmed reading: a report about staff for an ordinary category is a normal ticket (a forum post the whole team sees). Only `unsafe` ("Safety concern") reports are restricted, for staff and non-staff alike, and restricted cases are site-only. The owner accepted that the accused member of staff is taken out of the whole staff forum while an open forum post is about them (Discord permissions are per channel, not per thread). Discord Administrators can read every channel; the spec's known-limit note stays.

## Global Constraints

- **Run the FULL suite (`npx vitest run`) and `npm run typecheck` at the end of every task**, not only the task's own test file. `tests/db.test.ts` (exhaustive table list) and `tests/mergePlayers.test.ts` (foreign-key sweep) guard cross-cutting tables. This plan changes a rule that dozens of existing tests encode; every task lists the existing tests it is expected to break and what each must now say. If a test not listed fails, read it before touching it: if it asserted "a report about staff is restricted" as a means to test something else about restricted tickets, change its report to `category: 'unsafe'` with non-empty `text`; if it asserted the old staff rule itself, rewrite it to the new rule. **Never weaken a privacy assertion** (the accused gets a 404, is absent from a list, is not in a thread or the forum, hears nothing in the feed).
- **Known test noise:** ECONNREFUSED lines in the output are pre-existing and harmless. `tests/logAuthWiring.test.ts` is a known flake. A fresh worktree has no `dist/`, and `tests/server.test.ts`'s malformed-URL case fails until `npm run build` has run once. None of these are yours; do not stash, reset or "check" them.
- **Never use `git stash`.** Other sessions share the stash stack. Never reset, never touch master.
- **No em dashes** anywhere: code, comments, copy, commit messages. Use commas, colons, parentheses or separate sentences.
- **NULL safety.** `tickets.target_id`, `ticket_reports.reporter_id` and `ticket_threads.reporter_id` can be NULL (a Discord-only person). In SQL use `IS` / `IS NOT` for any comparison where either side can be NULL, and `LEFT JOIN players` wherever a target or reporter is joined. `hasStaffFlag(db, null)` is false.
- **Privacy, the rules this plan must keep true:** the accused never sees a ticket about themselves on the site (`canSeeTicket`, `VISIBLE` in `views.ts`, `recentActions`); never reads its forum post (`forumAudience`); never hears about it in the admin feed (`feed_held`, `ticketIsQuiet`); a restricted ticket is never detectable by someone off its list (404, never 403). Admin feed text names no ticket subject when the ticket is quiet.
- **Discord first, then the record** where a Discord action and a database write go together (not new in this plan, but `keepSubjectOut` in Task 2 follows it: the post is not made until Discord has confirmed the accused is out).
- Only `src/discord/djsTransport.ts` imports discord.js. This plan needs no new Discord call.

---

## File Structure

| File | Responsibility |
|---|---|
| `src/tickets/filing.ts` (modify) | `fileReport`: restricted only for `unsafe`; `feed_held` for staff and Discord administrators. `openStaffTicket`: restricted only when asked. |
| `src/tickets/actions.ts` (modify) | `setRestricted` no longer refuses to lift a restriction because the accused is staff. |
| `src/tickets/store.ts` (modify) | Drop `restrictOpenTicketAbout` and `RestrictOutcome`; add `holdFeedAbout`, `ticketIsQuiet`. |
| `src/routes/admin.ts`, `src/mergePlayers.ts`, `src/tickets/adopt.ts`, `src/players.ts` (modify) | Promotion, merge and adoption call `holdFeedAbout`; adoption backfills message authors and reports orphaned restricted tickets. |
| `src/routes/tickets.ts`, `src/discord/ticketButtons.ts`, `src/discord/ticketRemove.ts` (modify) | Audit rows quiet by `ticketIsQuiet`. |
| `src/tickets/threads.ts` (modify) | `surfaceFor` (no `about_staff`; restricted is site-only), `forbiddenForumThreads` (closed posts about staff), `forumAudience` (open ordinary tickets). |
| `src/discord/ticketSync.ts` (modify) | `keepSubjectOut` before a forum post is made; `announceInFeed` holds reports about staff. |
| `src/discord/ticketCard.ts` (modify) | `accessDm` copy: restricted tickets are site-only. |
| `src/tickets/views.ts` (modify) | `discussion.state` gains `'restricted'`, loses `'about_staff'`; `redactDiscordSanction` exported. |
| `src/tickets/discordSanctions.ts` (modify) | `sanctionsForPlayer`. |
| `src/tickets/caseFile.ts`, `src/admin/playerFile.ts` (modify) | Carry the player's Discord sanctions, redacted. |
| `web/src/api.ts`, `web/src/routes/admin/AdminTicket.tsx`, `web/src/routes/admin/file/StandingSection.tsx` (modify) | Discussion copy, restricted copy, sanctions on the case views. |

---

### Task 1: A report about staff is an ordinary ticket

**Files:**
- Modify: `src/tickets/store.ts`, `src/tickets/filing.ts`, `src/tickets/actions.ts`, `src/tickets/adopt.ts`, `src/players.ts`, `src/mergePlayers.ts`, `src/routes/admin.ts`, `src/routes/tickets.ts`, `src/discord/ticketButtons.ts`, `src/discord/ticketRemove.ts`, `src/discord/ticketSync.ts` (only `announceInFeed`)
- Test: `tests/ticketStaffTickets.test.ts` (create); existing tests listed in Step 6

**Interfaces:**
- Produces (in `src/tickets/store.ts`):
  - `holdFeedAbout(db: DB, steamid: string): number` (rows changed)
  - `ticketIsQuiet(db: DB, t: { restricted: number; target_id: string | null }): boolean`
- Removes: `restrictOpenTicketAbout`, `RestrictOutcome` (no caller may remain).
- Changes: `adoptDiscordPerson(...)` now returns `{ moved: number; stillEmpty: number }`.

Why `holdFeedAbout` and not nothing: `restrictOpenTicketAbout` did two jobs. Restricting is gone by the owner's ruling. Keeping the accused's own case out of the admin feed (every admin reads it, and the accused may be one) is still needed, and `feed_held` is already the one flag that decides it.

Why `ticketIsQuiet`: every ticket mutation logs `logAdmin(..., { quiet: restricted })`. A normal ticket about an admin was never normal before, so no call site ever had to think about it. An admin reading "X claimed ticket #12" in the feed for a ticket the site answers 404 for would learn a case about them exists.

- [ ] **Step 1: Write the failing tests** `tests/ticketStaffTickets.test.ts`

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { openDb, type DB } from '../src/db.js';
import { loadConfig } from '../src/config.js';
import { buildServer } from '../src/server.js';
import { linkDiscord } from '../src/players.js';
import { fileReport, openStaffTicket } from '../src/tickets/filing.js';
import { setRestricted } from '../src/tickets/actions.js';
import { canSeeTicket, getTicketRow, holdFeedAbout, ticketIsQuiet } from '../src/tickets/store.js';
import { listTickets } from '../src/tickets/views.js';
import { mergePlayers } from '../src/mergePlayers.js';
import { subscribeAdminEvents, type AdminEvent } from '../src/adminFeed.js';
import { authedCookie, stubOrchestrator } from './helpers.js';

const IDS = Array.from({ length: 8 }, (_, i) => `7656119900000030${i}`);
const [R1, R2, ACCUSED, MOD, MOD2, ADMIN, OWNER, NEWBIE] = IDS;
const deps = { adminSteamIds: [OWNER] };
let db: DB;
let app: FastifyInstance;
let events: AdminEvent[];
let off: () => void;
const cookie: Record<string, Record<string, string>> = {};

beforeEach(async () => {
  db = openDb(':memory:');
  app = await buildServer({ config: loadConfig({ ADMIN_STEAMIDS: OWNER }), db, orchestrator: stubOrchestrator(), serverCleaner: async () => {}, serverExec: async () => {} });
  for (const id of IDS) cookie[id] = authedCookie(app, db, id);
  db.prepare('UPDATE players SET is_mod = 1 WHERE steamid IN (?, ?)').run(MOD, MOD2);
  db.prepare('UPDATE players SET is_admin = 1 WHERE steamid IN (?, ?)').run(ADMIN, OWNER);
  events = [];
  off = subscribeAdminEvents((e) => events.push(e));
});
afterEach(async () => { off(); await app.close(); });

const post = (as: string, url: string, payload: object = {}) => app.inject({ method: 'POST', url, cookies: cookie[as], payload });
const get = (as: string, url: string) => app.inject({ method: 'GET', url, cookies: cookie[as] });
const fileAbout = (target: string, category = 'toxicity', text = 'rude in voice', by = R1) =>
  fileReport(db, by, { targetId: target, category, text }, deps) as { ok: true; ticketId: number; restricted: boolean };
const heldOf = (ticketId: number) => (db.prepare('SELECT feed_held FROM ticket_reports WHERE ticket_id = ? ORDER BY id').all(ticketId) as { feed_held: number }[]).map((r) => r.feed_held);

describe('a report about staff', () => {
  it('is an ordinary ticket every other moderator works, the accused never sees, and the admin feed never hears', () => {
    const r = fileAbout(MOD);
    expect(r).toMatchObject({ ok: true, restricted: false });
    const t = getTicketRow(db, r.ticketId)!;
    expect(t.restricted).toBe(0);
    expect(heldOf(r.ticketId)).toEqual([1]);
    expect(db.prepare('SELECT COUNT(*) AS n FROM ticket_access WHERE ticket_id = ?').get(r.ticketId)).toEqual({ n: 0 });
    for (const who of [MOD2, ADMIN, OWNER]) expect(canSeeTicket(db, t, who)).toBe(true);
    expect(canSeeTicket(db, t, MOD)).toBe(false);
    expect(listTickets(db, MOD, 'open')).toEqual([]);
    expect(listTickets(db, MOD2, 'open').map((x) => x.id)).toEqual([r.ticketId]);
  });

  it('is restricted when it is a safety report, and the accused is never on the list', () => {
    const r = fileAbout(MOD, 'unsafe', 'threatened someone');
    expect(r).toMatchObject({ ok: true, restricted: true });
    const access = (db.prepare('SELECT steamid FROM ticket_access WHERE ticket_id = ?').all(r.ticketId) as { steamid: string }[]).map((a) => a.steamid);
    expect(access).toEqual([OWNER]);
  });

  it('about a Discord administrator with no player account is ordinary too, and held from the feed', () => {
    const r = fileReport(db, R1, { category: 'toxicity', text: '' }, {
      ...deps, targetDiscord: { discordId: '990000000000000077', name: 'Boss', bot: false, administrator: true },
    }) as { ok: true; ticketId: number; restricted: boolean };
    expect(r).toMatchObject({ ok: true, restricted: false });
    expect(heldOf(r.ticketId)).toEqual([1]);
  });

  it('opened by hand is restricted only when asked', () => {
    const plain = openStaffTicket(db, MOD2, { targetId: MOD, note: 'seen in voice' }, deps) as { ok: true; ticketId: number };
    expect(getTicketRow(db, plain.ticketId)!.restricted).toBe(0);
    const asked = openStaffTicket(db, OWNER, { targetId: ADMIN, restricted: true }, deps) as { ok: true; ticketId: number };
    expect(getTicketRow(db, asked.ticketId)!.restricted).toBe(1);
  });

  it('can have its restriction lifted unless it holds a safety report', () => {
    const r = fileAbout(MOD);
    expect(setRestricted(db, r.ticketId, OWNER, true, deps.adminSteamIds).ok).toBe(true);
    expect(setRestricted(db, r.ticketId, OWNER, false, deps.adminSteamIds)).toEqual({ ok: true });
    const unsafe = fileAbout(MOD, 'unsafe', 'threats', R2);
    expect(setRestricted(db, unsafe.ticketId, OWNER, false, deps.adminSteamIds)).toMatchObject({ ok: false, status: 400 });
  });
});

describe('quiet audit rows', () => {
  it('ticketIsQuiet: restricted, or about somebody with a staff flag', () => {
    expect(ticketIsQuiet(db, { restricted: 0, target_id: ACCUSED })).toBe(false);
    expect(ticketIsQuiet(db, { restricted: 1, target_id: ACCUSED })).toBe(true);
    expect(ticketIsQuiet(db, { restricted: 0, target_id: MOD })).toBe(true);
    expect(ticketIsQuiet(db, { restricted: 0, target_id: null })).toBe(false);
  });

  it('an action on an ordinary ticket about an admin is audited, and the admin feed hears nothing', async () => {
    const r = fileAbout(ADMIN);
    expect((await post(MOD, `/api/mod/tickets/${r.ticketId}/claim`, { claim: true })).statusCode).toBe(200);
    expect((await post(MOD, `/api/mod/tickets/${r.ticketId}/close`, { outcome: 'warned', note: '' })).statusCode).toBe(200);
    expect(events.filter((e) => e.kind === 'admin_action')).toEqual([]);
    const actions = (db.prepare("SELECT action FROM admin_actions WHERE target = ? ORDER BY id").all(String(r.ticketId)) as { action: string }[]).map((a) => a.action);
    expect(actions).toEqual(['ticket_claim', 'ticket_close']);
    // The accused admin reads the audit log and learns nothing.
    const rows = (await get(ADMIN, '/api/admin/audit')).json().actions.filter((a: { target: string }) => a.target === String(r.ticketId));
    expect(rows).toEqual([]);
    expect((await get(ADMIN, `/api/mod/tickets/${r.ticketId}`)).statusCode).toBe(404);
  });
});

describe('promotion, merge and adoption', () => {
  it('promoting the accused leaves the ticket ordinary, hides it from them, and holds what the feed has not said', async () => {
    const r = fileAbout(ACCUSED, 'griefing');
    expect(heldOf(r.ticketId)).toEqual([0]);
    expect((await post(OWNER, `/api/admin/players/${ACCUSED}/mod`, { isMod: true })).statusCode).toBe(200);
    expect(getTicketRow(db, r.ticketId)!.restricted).toBe(0);
    expect(heldOf(r.ticketId)).toEqual([1]);
    expect((await get(MOD2, `/api/mod/tickets/${r.ticketId}`)).statusCode).toBe(200);
    expect((await get(ACCUSED, `/api/mod/tickets/${r.ticketId}`)).statusCode).toBe(404);
    expect(events.filter((e) => e.kind === 'problem')).toEqual([]);
  });

  it('promoting someone with both flavours open leaves both tickets as they were', async () => {
    const normal = fileAbout(ACCUSED, 'griefing');
    const unsafe = fileAbout(ACCUSED, 'unsafe', 'threats', R2);
    expect((await post(OWNER, `/api/admin/players/${ACCUSED}/admin`, { isAdmin: true })).statusCode).toBe(200);
    expect(db.prepare('SELECT id, restricted FROM tickets ORDER BY id').all()).toEqual([
      { id: normal.ticketId, restricted: 0 }, { id: unsafe.ticketId, restricted: 1 },
    ]);
  });

  it('holdFeedAbout leaves announced reports alone and counts what it held', () => {
    const r = fileAbout(ACCUSED, 'griefing');
    fileAbout(ACCUSED, 'afk', '', R2);
    db.prepare("UPDATE ticket_reports SET announced_at = 'x' WHERE id = (SELECT MIN(id) FROM ticket_reports)").run();
    expect(holdFeedAbout(db, ACCUSED)).toBe(1);
    expect(heldOf(r.ticketId)).toEqual([0, 1]);
  });

  it('merging a player into a staff account keeps the ticket ordinary and the survivor off every list about themselves', () => {
    const r = fileAbout(R2, 'griefing', 'threw', R1);
    mergePlayers(db, { from: R2, into: MOD, by: OWNER, adminSteamIds: [OWNER] });
    const t = getTicketRow(db, r.ticketId)!;
    expect(t).toMatchObject({ target_id: MOD, restricted: 0 });
    expect(canSeeTicket(db, t, MOD)).toBe(false);
    expect(heldOf(r.ticketId)).toEqual([1]);
    expect(events.filter((e) => e.kind === 'problem')).toEqual([]);
  });

  it('adoption fills in who wrote the messages, keeps a staff case ordinary, and says when a restricted ticket is left with nobody', () => {
    db.prepare('UPDATE players SET is_mod = 1 WHERE steamid = ?').run(NEWBIE);
    const lurker = { discordId: '950', name: 'Lurky', bot: false, administrator: false };
    const normal = fileReport(db, R1, { category: 'toxicity', text: '' }, { ...deps, targetDiscord: lurker }) as { ticketId: number };
    // A message the lurker wrote in a ticket thread before they linked.
    db.prepare(
      `INSERT INTO ticket_messages (ticket_id, thread_id, channel, discord_message_id, author_discord_id, author_player_id, author_name, content, created_at)
       VALUES (?, '8001', 'reporter', '8002', '950', NULL, 'Lurky', 'hello', '2026-09-22T00:00:00Z')`,
    ).run(normal.ticketId);
    // A restricted ticket nobody can be given: no owners passed, and no admin is left.
    db.prepare('UPDATE players SET is_admin = 0').run();
    fileReport(db, R2, { category: 'unsafe', text: 'threats' }, { adminSteamIds: [], targetDiscord: lurker });
    expect(linkDiscord(db, NEWBIE, '950', 'Lurky', { adminSteamIds: [] })).toMatchObject({ ok: true });
    expect(db.prepare("SELECT author_player_id FROM ticket_messages WHERE discord_message_id = '8002'").get()).toEqual({ author_player_id: NEWBIE });
    expect(getTicketRow(db, normal.ticketId)).toMatchObject({ target_id: NEWBIE, restricted: 0 });
    expect(heldOf(normal.ticketId)).toEqual([1]);
    const problems = events.filter((e) => e.kind === 'problem').map((e) => (e as { text: string }).text);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/nobody on its access list/);
    expect(problems[0]).not.toContain(NEWBIE);
    expect(problems[0]).not.toContain('950');
  });
});
```

- [ ] **Step 2: Run the new file to see it fail**

Run: `npx vitest run tests/ticketStaffTickets.test.ts`
Expected: FAIL (`holdFeedAbout` and `ticketIsQuiet` are not exported; reports about staff come back `restricted: true`).

- [ ] **Step 3: `src/tickets/store.ts`**

Delete the whole `RestrictOutcome` type and the `restrictOpenTicketAbout` function (with its comment). In their place add:

```ts
/**
 * Keep everything about this player that the admin feed has not said yet out
 * of it for good. Called the moment somebody becomes staff (promotion, a
 * merge into a staff account, a Discord link that adopts a staff player's
 * old cases): every admin reads the feed, and they may be reading it now.
 *
 * Only reports not yet announced: one already said cannot be unsaid, and
 * marking it would change nothing. Runs inside the caller's transaction.
 *
 * This is what is left of restrictOpenTicketAbout. A ticket about staff is
 * no longer restricted for it (owner, 2026-09-22): the whole team works it,
 * and the accused is kept out by canSeeTicket on the site and by
 * forumAudience in Discord.
 */
export function holdFeedAbout(db: DB, steamid: string): number {
  return db.prepare(
    `UPDATE ticket_reports SET feed_held = 1
     WHERE feed_held = 0 AND announced_at IS NULL
       AND ticket_id IN (SELECT id FROM tickets WHERE target_id = ?)`,
  ).run(steamid).changes;
}

/**
 * Whether an audit row about this ticket must stay off the admin feed:
 * restricted, or about somebody with a staff flag. The feed line names only
 * the ticket number, but an accused admin who sees activity on a ticket the
 * site answers 404 for has learned that a case about them exists.
 */
export function ticketIsQuiet(db: DB, t: { restricted: number; target_id: string | null }): boolean {
  return t.restricted === 1 || hasStaffFlag(db, t.target_id);
}
```

Update the comment on `reseedOrphanedTickets` so it no longer says a list "starts empty when a report is filed about the only admin" as a staff case; replace that sentence with: "and starts empty when a safety report is filed while there is no admin to give it to."

- [ ] **Step 4: `src/tickets/filing.ts`**

Replace the block that starts `// Which ticket this report would land on` through the `const restricted = ...` statement with:

```ts
  // Which ticket this report would land on, which is also which ticket both
  // duplicate limits are counted against: a safety report belongs to the
  // restricted sibling and is not a duplicate of a normal one, with or
  // without a match.
  //
  // Restricted means a safety report, whoever it is about (owner,
  // 2026-09-22). A report that a moderator is slow to ready up or rude is an
  // ordinary ticket the whole team works; the accused is still kept out of it
  // everywhere, by canSeeTicket on the site and forumAudience in Discord.
  const restricted = category === 'unsafe';
  // Held from the admin feed for good when the accused may be reading it:
  // somebody with a staff flag, or a Discord member with the Administrator
  // permission, who can read every channel there is.
  const feedHeld = restricted
    || (target.kind === 'player' ? hasStaffFlag(db, target.steamid) : deps.targetDiscord!.administrator);
```

In the `INSERT INTO ticket_reports` call inside the transaction, change the last bound value from `restricted ? 1 : 0` to `feedHeld ? 1 : 0`, and change the comment above it to:

```ts
    // feed_held is set here, not decided later: whether this report may ever
    // reach the admin feed is fixed at the moment it lands, by whether its
    // ticket is restricted or its accused may be reading the feed.
```

In `openStaffTicket`, change `const restricted = body.restricted === true || hasStaffFlag(db, targetId);` to `const restricted = body.restricted === true;`.

Update the `PickedTarget`/`FilingDeps.targetDiscord` comment that says `bot`/`administrator` "decide whether the report is even allowed and whether it is restricted" to say "decide whether the report is even allowed and whether it may reach the admin feed".

- [ ] **Step 5: the other callers**

`src/tickets/actions.ts`, in `setRestricted`, delete the line `if (hasStaffFlag(db, t.target_id)) return fail(400, 'a ticket about staff stays restricted');`. `hasStaffFlag` is still used by `addAccess`, so the import stays.

`src/routes/admin.ts`:
- import `holdFeedAbout, reseedOrphanedTickets` from `'../tickets/store.js'` (drop `restrictOpenTicketAbout` and `RestrictOutcome`);
- delete the `NOBODY_TO_RESTRICT` constant;
- in `POST /api/admin/players/:steamid/admin` delete `let outcome = ...` and its comment, replace `outcome = restrictOpenTicketAbout(db, t.steamid, adminSteamIds);` with `holdFeedAbout(db, t.steamid);`, and delete the `if (outcome === 'nobody') ...` line;
- in `POST /api/admin/players/:steamid/mod` the same: delete `outcome` and its comment, `if (isMod) holdFeedAbout(db, t.steamid);`, delete the `if (outcome === 'nobody')` line. If `publishAdminEvent` is now unused in the file, remove its import (typecheck will say).

`src/mergePlayers.ts`:
- import `{ foldTicket, hasStaffFlag, holdFeedAbout, reseedOrphanedTickets }` from `'./tickets/store.js'`;
- delete `let restrictOutcome = ...` and its two comment lines;
- replace the paragraph starting `// Merging a player into a staff account makes an ordinary ticket` and its `if (hasStaffFlag(db, into)) restrictOutcome = ...` line with:

```ts
    // Merging a player into a staff account makes a ticket about the alt a
    // ticket about staff. It stays ordinary (owner, 2026-09-22); what it must
    // not do any more is reach the admin feed, which the survivor may read.
    if (hasStaffFlag(db, into)) holdFeedAbout(db, into);
```

- delete the `if (restrictOutcome === 'nobody') { ... }` block after the commit, and change the comment above `publishTicketSignal({ kind: 'staff' })` to "Tickets may have been folded, and a Discord link may have moved: let the reconciler look at everything."

`src/tickets/adopt.ts`, whole file:

```ts
import type { DB } from '../db.js';
import { foldTicket, hasStaffFlag, holdFeedAbout, reseedOrphanedTickets } from './store.js';

/**
 * Someone who was only in the Discord has linked Steam: everything recorded
 * under their Discord id becomes the player's, the way mergePlayers moves an
 * alt onto a main. Runs inside the caller's transaction.
 *
 * discord_sanctions rows stay keyed by Discord id on purpose: Discord acts on
 * that id, and lifting a timeout later has to name it. The player's case view
 * finds them through discord_link_history (sanctionsForPlayer).
 *
 * `stillEmpty` is how many open restricted tickets have nobody on their list
 * afterwards, for the caller to report once its transaction has committed.
 */
export function adoptDiscordPerson(
  db: DB, discordId: string, steamid: string, adminSteamIds: string[], now = new Date(),
): { moved: number; stillEmpty: number } {
  // tickets_one_open allows one open case per person per flavour. Where both
  // identities have one, the Discord one folds into the player's.
  for (const restricted of [0, 1]) {
    const gone = db.prepare("SELECT id FROM tickets WHERE target_discord_id = ? AND restricted = ? AND status = 'open'")
      .get(discordId, restricted) as { id: number } | undefined;
    const keep = db.prepare("SELECT id FROM tickets WHERE target_id = ? AND restricted = ? AND status = 'open'")
      .get(steamid, restricted) as { id: number } | undefined;
    if (gone && keep) foldTicket(db, gone.id, keep.id, 'merge', now);
  }
  const moved = db.prepare('UPDATE tickets SET target_id = ?, target_discord_id = NULL WHERE target_discord_id = ?').run(steamid, discordId).changes;
  db.prepare("UPDATE ticket_reports SET reporter_id = ?, reporter_discord_id = NULL, reporter_name = '' WHERE reporter_discord_id = ?").run(steamid, discordId);
  db.prepare('UPDATE pending_reports SET reporter_id = ?, reporter_discord_id = NULL WHERE reporter_discord_id = ?').run(steamid, discordId);
  db.prepare('UPDATE ticket_threads SET reporter_id = ?, reporter_discord_id = NULL WHERE reporter_discord_id = ?').run(steamid, discordId);
  // What they wrote in a ticket thread before they linked: the mirror stored
  // it with no player, because there was none. Only the unset ones: a message
  // written while this Discord account belonged to somebody else keeps them.
  db.prepare('UPDATE ticket_messages SET author_player_id = ? WHERE author_discord_id = ? AND author_player_id IS NULL').run(steamid, discordId);
  if (hasStaffFlag(db, steamid)) holdFeedAbout(db, steamid);
  // The accused never sits on a list of a case about themselves.
  db.prepare('DELETE FROM ticket_access WHERE steamid = ? AND ticket_id IN (SELECT id FROM tickets WHERE target_id = ?)').run(steamid, steamid);
  const { stillEmpty } = reseedOrphanedTickets(db, adminSteamIds, [], now);
  return { moved, stillEmpty };
}
```

`src/players.ts`: add `import { publishAdminEvent } from './adminFeed.js';`. In `linkDiscord`, declare `let orphaned = 0;` just before `db.transaction(() => {`, change the adopt call to `orphaned = adoptDiscordPerson(db, discordId, steamid, opts.adminSteamIds ?? [], now).stillEmpty;`, and after the commit, before `publishTicketSignal({ kind: 'staff' });`, add:

```ts
  // Names nothing: every admin reads the feed, and the ticket may be about one.
  if (orphaned > 0) {
    publishAdminEvent({ kind: 'problem', text: `${orphaned} restricted ticket${orphaned === 1 ? ' has' : 's have'} nobody on its access list after a Discord account was linked. It is handed to the next admin that is created.` });
  }
```

(The test matches `/nobody on its access list/`; keep that phrase in both the singular and the plural.)

`src/routes/tickets.ts`: import `ticketIsQuiet` beside `canSeeTicket, getTicketRow`. Inside `ticketRoutes`, after `const filing = { adminSteamIds };`, add:

```ts
  /** Whether a ticket action's audit row stays off the admin feed. A ticket
   *  that has gone by the time the row is written (folded away mid-request)
   *  counts as quiet: this fails closed. */
  const quiet = (id: number): boolean => {
    const t = getTicketRow(db, id);
    return !t || ticketIsQuiet(db, t);
  };
```

and replace the three `getTicketRow(db, ...)?.restricted === 1` expressions with `quiet(r.auditId)` (ticket_open), `quiet(Number(id))` (ticket_remove) and `quiet(id)` (inside `act`). Change the file's header comment "quiet when the ticket is restricted" to "quiet when the ticket is restricted or about staff (ticketIsQuiet)". The two Discord sanction routes keep `plan.restricted`: their tickets are about Discord-only people, for whom `hasStaffFlag` is always false.

`src/discord/ticketButtons.ts`: import `ticketIsQuiet` from `'../tickets/store.js'`; `{ quiet: ticket.restricted === 1 }` becomes `{ quiet: ticketIsQuiet(deps.db, ticket) }` and `{ quiet: who.ticket.restricted === 1 }` becomes `{ quiet: ticketIsQuiet(deps.db, who.ticket) }`. Change "quietly for a restricted ticket" in the doc comment to "quietly for a restricted ticket or one about staff".

`src/discord/ticketRemove.ts`: import `ticketIsQuiet`; `const quiet = ticket.restricted === 1;` becomes `const quiet = ticketIsQuiet(db, ticket);`.

`src/discord/ticketSync.ts`, `announceInFeed`: import `hasStaffFlag, holdFeedAbout` from `'../tickets/store.js'`, and as the first line after `const { db } = this.deps;` add:

```ts
    // Promoted by some path that did not hold the feed (a flag set by hand in
    // the database): held here, before anything is said, so a report about
    // somebody who reads the feed is never said. Its own write, because this
    // runs outside any request.
    if (hasStaffFlag(db, t.target_id)) holdFeedAbout(db, t.target_id!);
```

(The existing early return for `why !== 'unconfigured'` stays; `'about_staff'` is removed from `surfaceFor` in Task 2, and this line is what keeps `tests/discordAdminFeed.test.ts`'s "a normal ticket about someone who has since been made staff posts nothing" true once it is.)

- [ ] **Step 6: Update the existing tests that encode the old rule**

Replace these tests' bodies exactly as shown; everything else in their files stays.

`tests/ticketFiling.test.ts`, the test `'a report about staff is restricted, and the accused is never on the access list'` becomes:

```ts
  it('a report about staff is ordinary unless it is a safety report, and the accused is never on a list', () => {
    expect(fileReport(db, R1, { targetId: MOD, category: 'toxicity', text: '' }, deps)).toMatchObject({ restricted: false });
    fileReport(db, R1, { targetId: OWNER, category: 'unsafe', text: 'threats' }, deps);
    const t = tickets().find((x) => x.target_id === OWNER)!;
    expect(t.restricted).toBe(1);
    const access = (db.prepare('SELECT steamid FROM ticket_access WHERE ticket_id = ?').all(t.id) as { steamid: string }[]).map((a) => a.steamid);
    expect(access).toEqual([ADMIN]);
  });
```

`tests/ticketActions.test.ts`:
- in `'a ticket the actor cannot see is a 404 for every action'`, change the report to `{ targetId: MOD, category: 'unsafe', text: 'threats' }` (the test is about a restricted ticket; MOD is the accused and MOD2 and ADMIN are off its list, so every expectation holds as written);
- `'un-restricting is refused while the accused is staff or a report is unsafe'` becomes:

```ts
  it('un-restricting is refused while a report is unsafe, and allowed for a ticket about staff', () => {
    const staff = (fileReport(db, R1, { targetId: MOD, category: 'toxicity', text: '' }, deps) as { ticketId: number }).ticketId;
    expect(setRestricted(db, staff, OWNER, true, deps.adminSteamIds)).toEqual({ ok: true });
    expect(setRestricted(db, staff, OWNER, false, deps.adminSteamIds)).toEqual({ ok: true });
    const unsafe = (fileReport(db, R2, { targetId: ACCUSED, category: 'unsafe', text: 'details' }, deps) as { ticketId: number }).ticketId;
    expect(setRestricted(db, unsafe, OWNER, false, deps.adminSteamIds)).toMatchObject({ ok: false, status: 400 });
  });
```

`tests/ticketFilingDiscord.test.ts`, `'restricts a report about a Discord administrator, and an unsafe one'` becomes:

```ts
  it('restricts an unsafe report, and never one only because the accused is a Discord administrator', () => {
    expect(fileReport(db, P1, { category: 'toxicity', text: '' }, withTarget({ administrator: true }))).toMatchObject({ ok: true, restricted: false });
    expect(fileReport(db, P1, { category: 'unsafe', text: 'x' }, withTarget({ discordId: '903' }))).toMatchObject({ ok: true, restricted: true });
  });
```

`tests/ticketAdopt.test.ts`, `'restricts the adopted case when the player is staff'` becomes:

```ts
  it('keeps the adopted case ordinary when the player is staff, and holds it from the feed', () => {
    db.prepare('UPDATE players SET is_mod = 1 WHERE steamid = ?').run(NEWBIE);
    fileReport(db, P1, { category: 'toxicity', text: '' }, { ...deps, targetDiscord: lurker });
    linkDiscord(db, NEWBIE, '950', 'Lurky', { adminSteamIds: [OWNER] });
    expect(db.prepare('SELECT restricted FROM tickets').get()).toEqual({ restricted: 0 });
    expect(db.prepare('SELECT feed_held FROM ticket_reports').get()).toEqual({ feed_held: 1 });
  });
```

`tests/ticketRoutes.test.ts`:
- `'a ticket about a mod is invisible to that mod and to everyone off the list, and its audit rows stay off the feed'`: change its report to `{ targetId: MOD, category: 'unsafe', text: 'abusive' }` and rename it `'a restricted ticket about a mod is invisible ...'` (rest unchanged);
- `'audit rows about a restricted ticket reach only its access list'`: the same category change;
- `'promoting a player restricts the open ticket about them'` becomes:

```ts
  it('promoting a player leaves the open ticket about them ordinary and hides it from them', async () => {
    await file(R1, { targetId: R2, category: 'griefing', text: 'threw' });
    const id = (db.prepare('SELECT id FROM tickets').get() as { id: number }).id;
    expect((await post(OWNER, `/api/admin/players/${R2}/mod`, { isMod: true })).statusCode).toBe(200);
    expect(db.prepare('SELECT restricted FROM tickets WHERE id = ?').get(id)).toEqual({ restricted: 0 });
    expect((await get(MOD, `/api/mod/tickets/${id}`)).statusCode).toBe(200);
    expect((await get(R2, `/api/mod/tickets/${id}`)).statusCode).toBe(404);
    expect((await get(OWNER, `/api/mod/tickets/${id}`)).json().events.map((e: { kind: string }) => e.kind)).toEqual(['opened']);
  });
```

- `'promoting a player with both flavours open leaves one restricted ticket holding both reports'` becomes:

```ts
  it('promoting a player with both flavours open leaves both tickets as they were', async () => {
    await file(R1, { targetId: R2, category: 'griefing', text: 'threw' });
    await file(R1, { targetId: R2, category: 'unsafe', text: 'threats' });
    const before = db.prepare('SELECT id, restricted FROM tickets ORDER BY id').all();
    expect((await post(OWNER, `/api/admin/players/${R2}/admin`, { isAdmin: true })).statusCode).toBe(200);
    expect(db.prepare('SELECT id, restricted FROM tickets ORDER BY id').all()).toEqual(before);
    expect(db.pragma('foreign_key_check')).toEqual([]);
  });
```

`tests/ticketNudge.test.ts`: the block commented `// A ticket about a member of staff: restricted, and never the accused.` becomes:

```ts
    // A ticket about a member of staff: every other member of staff, never the accused.
    reset();
    nudge(file(STAFF_ACCUSED));
    expect(heard()).toEqual([MOD, ADMIN, OWNER]);
```

`tests/ticketSummary.test.ts`, `'gives no file link to a viewer who may not open the file'`: add `restricted: true` to the `POST /api/mod/tickets` payload (`{ targetId: MOD, restricted: true }`) and change the first comment line to "A restricted ticket about a member of staff." so the test keeps exercising the access-list path it was written for.

`tests/ticketLeftovers.test.ts`: change the import to `import { reseedOrphanedTickets, holdFeedAbout } from '../src/tickets/store.js';` and replace the tests `'does not restrict when nobody could be given access, and says so'`, `'a merge into the only admin leaves the ticket normal and reports a problem that names nobody'`, `'a merge takes its owners from the caller'` and `'never seeds the account that is being merged away'` with:

```ts
  it('a promotion never restricts an ordinary ticket, it only holds it from the feed', () => {
    const id = file(R1, PLAYER);
    flag('is_mod', PLAYER);
    expect(holdFeedAbout(db, PLAYER)).toBe(1);
    expect(db.prepare('SELECT restricted FROM tickets WHERE id = ?').get(id)).toEqual({ restricted: 0 });
    expect(accessOf(id)).toEqual([]);
    expect(events.filter((e) => e.kind === 'problem')).toEqual([]);
  });

  it('a merge into a staff account leaves the ticket ordinary and reports nothing', () => {
    flag('is_admin', MAIN);
    const id = file(R1, ALT);
    mergePlayers(db, { from: ALT, into: MAIN, by: MAIN, adminSteamIds: [] });
    expect(db.prepare('SELECT target_id, restricted FROM tickets WHERE id = ?').get(id)).toEqual({ target_id: MAIN, restricted: 0 });
    expect(events.filter((e) => e.kind === 'problem')).toEqual([]);
  });

  it('never seeds the account that is being merged away', () => {
    flag('is_mod', MAIN);
    flag('is_admin', ALT);
    const id = file(R1, MAIN, 'unsafe', 'threats');
    // ALT was the only admin, so it was seeded; the merge empties the list
    // and must not seed ALT again, because ALT is about to stop existing.
    expect(accessOf(id)).toEqual([ALT]);
    mergePlayers(db, { from: ALT, into: MAIN, by: OWNER, adminSteamIds: [] });
    expect(accessOf(id)).toEqual([]);
    expect(events.filter((e) => e.kind === 'problem')).toHaveLength(1);
  });
```

In the remaining two tests of that describe, `'a list emptied by the merge itself is filled again from the owners'` and `'an orphaned ticket is handed to whoever can take it, and counts what is left'`, change `file(R1, MAIN, 'toxicity')` to `file(R1, MAIN, 'unsafe', 'threats')` (both relied on a report about staff being restricted).

`tests/ticketFeedHeld.test.ts`: import `holdFeedAbout` instead of `restrictOpenTicketAbout`, and T3 becomes:

```ts
  it('T3: promoting the accused then demoting them never announces a report pending across it', async () => {
    sync.stop();
    fileReport(db, IDS[1], { targetId: IDS[3], category: 'afk', text: '' }, { adminSteamIds: [ADMIN] });
    db.transaction(() => {
      db.prepare('UPDATE players SET is_mod = 1 WHERE steamid = ?').run(IDS[3]);
      expect(holdFeedAbout(db, IDS[3])).toBe(1);
    })();
    db.prepare('UPDATE players SET is_mod = 0 WHERE steamid = ?').run(IDS[3]);
    sync = new TicketSync({ db, transport: t, publicUrl: 'https://pug.test', intervalMs: 0 });
    sync.start();
    await settled();
    expect(inFeed()).toEqual([]);
  });
```

`tests/ticketMessages.test.ts`: import `foldTicket` only (drop `restrictOpenTicketAbout`), and `'so does the fold into a restricted sibling when the accused becomes staff'` becomes:

```ts
  it('so does a fold into a restricted sibling', () => {
    const normal = file(R1, ACCUSED);
    const sibling = file(R2, ACCUSED, 'unsafe');
    const m = say(normal, '100001');
    db.transaction(() => foldTicket(db, normal, sibling, 'drop'))();
    expect(messageById(db, m.id)!.ticket_id).toBe(sibling);
    expect(db.pragma('foreign_key_check')).toEqual([]);
  });
```

`tests/ticketSyncRestricted.test.ts` uses `restrictOpenTicketAbout` in five places, each to FOLD a normal ticket into its restricted sibling. Import `holdFeedAbout` beside `foldTicket` and drop `restrictOpenTicketAbout`, then:
- `'making the accused staff deletes every forum post about them, closed tickets included'`: replace `restrictOpenTicketAbout(db, IDS[5], [ADMIN]);` with `holdFeedAbout(db, IDS[5]);`, and replace `expect(staffThread(db, open)!.surface).toBe('private');` with `expect(staffThread(db, open)).toBeUndefined();` (in this task a ticket about staff still has no Discord thread, so both posts still go; Task 2 rewrites this test to its final form).
- `'a normal ticket about staff that could not be restricted has no Discord thread at all'`: replace the transaction with `db.transaction(() => { db.prepare('UPDATE players SET is_admin = 1 WHERE steamid = ?').run(IDS[5]); holdFeedAbout(db, IDS[5]); })();` and rename it `'a normal ticket about staff has no Discord thread yet'` (Task 2 replaces it).
- `'deletes the forum post instead of retiring it, and never mentions it anywhere'`: replace `db.transaction(() => { expect(restrictOpenTicketAbout(db, IDS[5], [ADMIN])).toBe('folded'); })();` with `db.transaction(() => foldTicket(db, normal, restricted, 'drop'))();`.
- in `foldWhileCreating`, replace `expect(restrictOpenTicketAbout(db, IDS[5], [ADMIN])).toBe('folded');` with:

```ts
        const normal = (db.prepare("SELECT id FROM tickets WHERE restricted = 0 AND status = 'open'").get() as { id: number }).id;
        const sibling = (db.prepare("SELECT id FROM tickets WHERE restricted = 1 AND status = 'open'").get() as { id: number }).id;
        foldTicket(db, normal, sibling, 'drop');
```

- `'a thread the ejection cannot clean still loses its forbidden forum post in the same pass'`: replace `expect(restrictOpenTicketAbout(db, IDS[5], [ADMIN])).toBe('folded');` with `foldTicket(db, normal, restricted, 'drop');`.

`tests/discordAdminFeed.test.ts`, `'a normal ticket about someone who has since been made staff posts nothing'`: change the two comment lines under the promotion to "Promoted by hand, with no promotion route to hold the feed: announceInFeed holds it itself. The accused reads the feed." The test body stays.

- [ ] **Step 7: Run the new file, then the full suite and typecheck**

Run: `npx vitest run tests/ticketStaffTickets.test.ts` then `npx vitest run` and `npm run typecheck`
Expected: all pass (apart from the known noise). `grep -rn restrictOpenTicketAbout src tests` prints nothing.

- [ ] **Step 8: Commit**

```bash
git add src tests
git commit -m "Tickets about staff are ordinary tickets; only safety reports are restricted"
```

---

### Task 2: A forum post about staff, and the accused kept out of the forum

**Files:**
- Modify: `src/tickets/threads.ts`, `src/discord/ticketSync.ts`, `src/tickets/views.ts`, `web/src/api.ts`, `web/src/routes/admin/AdminTicket.tsx`
- Test: `tests/ticketStaffForum.test.ts` (create); `tests/ticketThreads.test.ts`, `tests/ticketSyncAccess.test.ts`, `tests/ticketSyncRestricted.test.ts` (update)

**Interfaces:**
- Consumes: `holdFeedAbout` (Task 1).
- Produces: `surfaceFor(db, t)` returns `{ surface: ThreadSurface | null; why: 'ok' | 'unconfigured' }` in this task (Task 3 adds `'restricted'`); `TicketDiscussion['state']` is `'ready' | 'pending' | 'unconfigured' | 'none'` in this task.

The rule, and why each piece is needed:

1. `surfaceFor` stops refusing a ticket about staff: it gets a forum post like any other.
2. `forumAudience` already leaves out anyone a live forum post is about. It now also leaves out anyone an OPEN ordinary ticket is about, whether or not its post exists yet. Without this there is a window, on every new ticket about a member of staff and on every reopen and un-restrict of one, in which the post exists in Discord and its subject still holds the forum overwrite.
3. `keepSubjectOut` closes that window from the other side: before a post is made, the forum's overwrites are synced revoke-only, and if Discord will not take the subject out, the post is not made (the pass throws, the problem line says so without a name, and the next pass tries again). Discord first, then the post.
4. `forbiddenForumThreads` now lists a CLOSED ticket's post about somebody with a staff flag, open or not. Leaving it would keep that person out of the forum for as long as the post exists, which is for ever: an archived post is still readable. Deleting it (after `saveBeforeDelete` copies it to the site) lets them back in on the next full pass. A reopen makes a new post; the old discussion is on the site. A restricted ticket's post is still forbidden whatever its state, exactly as before.

Promotion mid-case needs nothing new: the promoted person's open ticket keeps them out through rule 2, and a closed ticket's post about them becomes forbidden through rule 4 and is deleted by the first full pass, which runs before `syncAccess` in `reconcile()`. A merge or an adoption repoints `target_id`, after which the same two rules apply to the survivor. Un-restricting a ticket about staff makes an open ordinary ticket, so rule 2 applies before its post is made, and rule 3 checks it.

- [ ] **Step 1: Write the failing tests** `tests/ticketStaffForum.test.ts`

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openDb, type DB } from '../src/db.js';
import { upsertPlayer, activatePlayer, linkDiscord } from '../src/players.js';
import { setSetting } from '../src/settings.js';
import { fileReport } from '../src/tickets/filing.js';
import { closeTicket, reopenTicket, setRestricted } from '../src/tickets/actions.js';
import { publishTicketSignal } from '../src/tickets/signals.js';
import { forbiddenForumThreads, forumAudience, staffThread, surfaceFor } from '../src/tickets/threads.js';
import { getTicketRow } from '../src/tickets/store.js';
import { subscribeAdminEvents, type AdminEvent } from '../src/adminFeed.js';
import { TicketSync } from '../src/discord/ticketSync.js';
import { FakeTransport } from './fakes/fakeTransport.js';

const IDS = Array.from({ length: 8 }, (_, i) => `7656119900000031${i}`);
const [R1, R2, , , , STAFFER, MOD, ADMIN] = IDS;
const D = (id: string) => `91${IDS.indexOf(id)}`;
let db: DB;
let t: FakeTransport;
let sync: TicketSync;
let events: AdminEvent[];
let off: () => void;

beforeEach(async () => {
  db = openDb(':memory:');
  IDS.forEach((id, i) => {
    upsertPlayer(db, { steamid: id, name: `player${i}`, avatar: null }, []);
    activatePlayer(db, id);
    linkDiscord(db, id, `91${i}`, `d${i}`);
  });
  db.prepare('UPDATE players SET is_mod = 1 WHERE steamid IN (?, ?)').run(MOD, STAFFER);
  db.prepare('UPDATE players SET is_admin = 1 WHERE steamid = ?').run(ADMIN);
  setSetting(db, 'discord_tickets_forum_id', 'forum1');
  t = new FakeTransport();
  sync = new TicketSync({ db, transport: t, publicUrl: 'https://pug.test', intervalMs: 0 });
  sync.start();
  await sync.idle();
  events = [];
  off = subscribeAdminEvents((e) => events.push(e));
});
afterEach(() => { sync.stop(); off(); });

const access = () => [...(t.channelAccess.get('forum1') ?? [])].sort();
const file = (target: string, category = 'toxicity', by = R1) =>
  (fileReport(db, by, { targetId: target, category, text: 'x' }, { adminSteamIds: [ADMIN] }) as { ticketId: number }).ticketId;

describe('a ticket about a member of staff in Discord', () => {
  it('starts with the whole staff forum, the accused included', () => {
    expect(access()).toEqual([D(STAFFER), D(MOD), D(ADMIN)].sort());
  });

  it('gets a forum post, made only after the accused is out of the forum', async () => {
    const create = t.threads.createForumPost;
    let atCreate: string[] | null = null;
    t.threads.createForumPost = async (forumId, p) => { atCreate = access(); return create(forumId, p); };
    const id = file(STAFFER);
    await sync.idle();
    t.threads.createForumPost = create;
    expect(staffThread(db, id)).toMatchObject({ surface: 'forum' });
    expect(atCreate).toEqual([D(MOD), D(ADMIN)].sort());
    expect(access()).toEqual([D(MOD), D(ADMIN)].sort());
    await sync.reconcile();
    expect(access()).toEqual([D(MOD), D(ADMIN)].sort());
  });

  it('makes no post while Discord will not take the accused out, and says so without naming anyone', async () => {
    t.accessRemovalsRefused.add(D(STAFFER));
    const id = file(STAFFER);
    await sync.idle();
    expect(staffThread(db, id)).toBeUndefined();
    expect(t.threadsIn('forum1')).toEqual([]);
    const problems = events.filter((e) => e.kind === 'problem').map((e) => (e as { text: string }).text);
    expect(problems.length).toBeGreaterThan(0);
    for (const p of problems) {
      expect(p).not.toContain(STAFFER);
      expect(p).not.toContain(D(STAFFER));
      expect(p).not.toContain('player5');
    }
    t.accessRemovalsRefused.clear();
    await sync.reconcile();
    expect(staffThread(db, id)).toMatchObject({ surface: 'forum' });
    expect(access()).not.toContain(D(STAFFER));
  });

  it('deletes the post when the ticket closes, and lets the accused back in on the next full pass', async () => {
    const id = file(STAFFER);
    await sync.idle();
    const post = staffThread(db, id)!.thread_id;
    closeTicket(db, id, MOD, 'warned', '');
    await sync.idle();
    expect(t.threadsById.get(post)!.deleted).toBe(true);
    await sync.reconcile();
    expect(access()).toContain(D(STAFFER));
  });

  it('a reopen takes the accused out again before a new post is made', async () => {
    const id = file(STAFFER);
    await sync.idle();
    closeTicket(db, id, MOD, 'warned', '');
    await sync.idle();
    await sync.reconcile();
    expect(access()).toContain(D(STAFFER));
    expect(reopenTicket(db, id, MOD).ok).toBe(true);
    await sync.idle();
    const now = staffThread(db, id)!;
    expect(now.surface).toBe('forum');
    expect(t.threadsById.get(now.thread_id)!.deleted).toBe(false);
    expect(access()).not.toContain(D(STAFFER));
  });

  it('promotion mid-case: the open post stays, a closed one goes, and the new moderator waits outside', async () => {
    const closed = file(R2, 'griefing');
    await sync.idle();
    closeTicket(db, closed, MOD, 'no_action', '');
    await sync.idle();
    const open = file(R2, 'cheating', R1);
    await sync.idle();
    const closedPost = db.prepare('SELECT thread_id FROM ticket_threads WHERE ticket_id = ?').get(closed) as { thread_id: string };
    const openPost = staffThread(db, open)!.thread_id;
    db.prepare('UPDATE players SET is_mod = 1 WHERE steamid = ?').run(R2);
    publishTicketSignal({ kind: 'staff' });
    await sync.idle();
    expect(t.threadsById.get(closedPost.thread_id)!.deleted).toBe(true);
    expect(t.threadsById.get(openPost)!.deleted).toBe(false);
    expect(access()).not.toContain(D(R2));
  });

  it('un-restricting a ticket about staff posts it to the forum with the accused kept out', async () => {
    const id = file(STAFFER);
    setRestricted(db, id, ADMIN, true, [ADMIN]);
    await sync.idle();
    expect(t.threadsIn('forum1').filter((th) => !th.deleted)).toEqual([]);
    setRestricted(db, id, ADMIN, false, [ADMIN]);
    await sync.idle();
    expect(staffThread(db, id)).toMatchObject({ surface: 'forum' });
    expect(access()).not.toContain(D(STAFFER));
  });
});

describe('the rules as functions', () => {
  it('surfaceFor sends a ticket about staff to the forum', () => {
    const id = file(STAFFER);
    expect(surfaceFor(db, getTicketRow(db, id)!)).toEqual({ surface: 'forum', why: 'ok' });
  });

  it('forumAudience leaves out whoever an open ordinary ticket is about, post or no post', () => {
    setSetting(db, 'discord_tickets_forum_id', '');
    const id = file(STAFFER);
    expect(forumAudience(db)).not.toContain(D(STAFFER));
    db.prepare("UPDATE tickets SET status = 'closed' WHERE id = ?").run(id);
    expect(forumAudience(db)).toContain(D(STAFFER));
    // A restricted one has no post and never will: it keeps nobody out.
    file(STAFFER, 'unsafe');
    expect(forumAudience(db)).toContain(D(STAFFER));
  });

  it('forbiddenForumThreads lists a closed ticket\'s post about staff, and never an open one\'s', async () => {
    const id = file(STAFFER);
    await sync.idle();
    expect(forbiddenForumThreads(db)).toEqual([]);
    db.prepare("UPDATE tickets SET status = 'closed' WHERE id = ?").run(id);
    expect(forbiddenForumThreads(db).map((th) => th.ticket_id)).toEqual([id]);
    db.prepare('UPDATE players SET is_mod = 0 WHERE steamid = ?').run(STAFFER);
    expect(forbiddenForumThreads(db)).toEqual([]);
  });
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `npx vitest run tests/ticketStaffForum.test.ts`
Expected: FAIL (no forum post is made for a ticket about staff; `surfaceFor` answers `about_staff`).

- [ ] **Step 3: `src/tickets/threads.ts`**

Remove the `hasStaffFlag` import. Replace `forbiddenForumThreads` with:

```ts
/**
 * Forum threads that must not exist, and are deleted (after the mirror has
 * copied them onto the site).
 *
 * A restricted ticket's post, whatever its state: the forum is readable by
 * every moderator and admin, and an archived post is still a post anyone in
 * the forum can open.
 *
 * A CLOSED ticket's post about somebody with a staff flag. While it stands,
 * forumAudience keeps that person out of the whole forum, and an archived
 * post stands for ever. Deleted, it lets them back in; the discussion is on
 * the site, and a reopen makes a new post. An OPEN ticket's post about staff
 * is allowed (owner, 2026-09-22): the whole team works it, and its subject
 * is kept out of the forum until it closes.
 */
export function forbiddenForumThreads(db: DB, ticketId?: number): ThreadRow[] {
  const rows = db.prepare(
    `SELECT th.* FROM ticket_threads th
       JOIN tickets t ON t.id = th.ticket_id LEFT JOIN players p ON p.steamid = t.target_id
     WHERE th.surface = 'forum' AND th.state != 'deleted'
       AND (t.restricted = 1 OR (t.status = 'closed' AND (p.is_admin = 1 OR p.is_mod = 1)))
     ORDER BY th.id`,
  ).all() as ThreadRow[];
  return ticketId === undefined ? rows : rows.filter((r) => r.ticket_id === ticketId);
}
```

Replace `surfaceFor` with (Task 3 changes the restricted branch):

```ts
/**
 * Where a ticket's staff thread belongs, and why nowhere when it is nowhere.
 * One function, used by the reconciler to act and by the ticket page to
 * explain, so the two cannot disagree. A ticket about staff goes to the forum
 * like any other: forumAudience keeps its subject out of it.
 */
export function surfaceFor(
  db: DB, t: { restricted: number; target_id: string | null },
): { surface: ThreadSurface | null; why: 'ok' | 'unconfigured' } {
  if (t.restricted === 1) {
    return (getSetting(db, 'discord_tickets_channel_id') ?? '') ? { surface: 'private', why: 'ok' } : { surface: null, why: 'unconfigured' };
  }
  return (getSetting(db, 'discord_tickets_forum_id') ?? '') ? { surface: 'forum', why: 'ok' } : { surface: null, why: 'unconfigured' };
}
```

Replace `forumAudience` with:

```ts
/**
 * The Discord ids that may read the staff forum: linked, active moderators
 * and admins, minus anyone a forum post is, or is about to be, about.
 *
 * "Is": a forum thread about them not yet confirmed deleted by Discord (state
 * 'deleted'), so a failed deletion can never become the accused reading their
 * own case. "About to be": an open ordinary ticket about them, whether or not
 * its post exists yet. The post is made after this list has been applied
 * (TicketSync.keepSubjectOut), so there is no moment when the post exists
 * and its subject can open it. A restricted ticket keeps nobody out: it never
 * has a forum post.
 */
export function forumAudience(db: DB): string[] {
  return (db.prepare(
    `SELECT p.discord_id FROM players p
     WHERE p.status = 'active' AND (p.is_admin = 1 OR p.is_mod = 1) AND p.discord_id IS NOT NULL
       AND NOT EXISTS (
         SELECT 1 FROM ticket_threads th JOIN tickets t ON t.id = th.ticket_id
         WHERE t.target_id = p.steamid AND th.surface = 'forum' AND th.state != 'deleted')
       AND NOT EXISTS (
         SELECT 1 FROM tickets t WHERE t.target_id = p.steamid AND t.status = 'open' AND t.restricted = 0)
     ORDER BY p.discord_id`,
  ).all() as { discord_id: string }[]).map((r) => r.discord_id);
}
```

- [ ] **Step 4: `src/discord/ticketSync.ts`**

`announceInFeed(t: TicketRow, why: 'ok' | 'unconfigured'): void` (drop `'about_staff'` from its type), and in its doc comment replace "and never for a ticket about staff (`why` is then 'about_staff')" with "and never about somebody with a staff flag (held above)".

In `createThread`, in the `surface === 'forum'` branch, after `const forumId = ...` and before `createForumPost`, add `await this.keepSubjectOut(t, forumId);`. Add the method beside `syncAccess`:

```ts
  /**
   * Before a forum post about a player is made: the forum's overwrites,
   * revoke-only, so that whoever forumAudience now leaves out (the subject of
   * this open ticket among them) is out BEFORE the post exists. If Discord
   * will not take the subject out, no post is made: this throws, the ticket's
   * problem line says so without naming anyone, and the next pass tries
   * again. A post that went up regardless would be the accused reading their
   * own case.
   *
   * Only a player can hold the forum overwrite. A Discord-only subject has
   * none; if they hold the Discord Administrator permission they can read
   * every channel whatever this does, which is the known limit the ticket
   * page states.
   */
  private async keepSubjectOut(t: TicketRow, forumId: string): Promise<void> {
    const { db, transport } = this.deps;
    if (t.target_id === null) return;
    const subject = (db.prepare('SELECT discord_id FROM players WHERE steamid = ?').get(t.target_id) as { discord_id: string | null } | undefined)?.discord_id ?? null;
    if (subject === null) return;
    const r = await transport.threads.syncMemberAccess(forumId, forumAudience(db), { revokeOnly: true });
    if (r.failed.includes(subject)) {
      throw new Error('Discord would not take the person this ticket is about out of the tickets forum, so its post was not made');
    }
  }
```

- [ ] **Step 5: `src/tickets/views.ts`, the web copy**

In `ticketDetail`, the `discussion.state` expression becomes:

```ts
    state: thread ? 'ready' as const
      : where.why === 'unconfigured' ? 'unconfigured' as const
        : row.status === 'open' ? 'pending' as const : 'none' as const,
```

`web/src/api.ts`: `TicketDiscussion.state` becomes `'ready' | 'pending' | 'unconfigured' | 'none'`.

`web/src/routes/admin/AdminTicket.tsx`, in `Discussion`, delete the `: d.state === 'about_staff' ? ...` line, so the chain reads `unconfigured`, then `pending`, then the fallback.

- [ ] **Step 6: Update the existing tests**

`tests/ticketThreads.test.ts`, `'lists the forum thread of a restricted ticket and of a ticket about staff, open or closed, and nothing else'` becomes:

```ts
  it('lists the forum thread of a restricted ticket, and of a closed ticket about staff, and nothing else', () => {
    const normal = file(R1, ACCUSED);
    const aboutStaff = file(R1, ALT);
    const restricted = file(R2, R1, 'unsafe');
    thread(normal, '9001');
    thread(aboutStaff, '9002');
    thread(restricted, '9003', 'private');
    expect(forbiddenForumThreads(db)).toEqual([]);
    // ALT is promoted while the ticket is open: its post may stand.
    db.prepare('UPDATE players SET is_mod = 1 WHERE steamid = ?').run(ALT);
    expect(forbiddenForumThreads(db)).toEqual([]);
    // Closed, it may not.
    db.prepare("UPDATE tickets SET status = 'closed' WHERE id = ?").run(aboutStaff);
    // The normal ticket is restricted by hand.
    db.prepare('UPDATE tickets SET restricted = 1 WHERE id = ?').run(normal);
    expect(forbiddenForumThreads(db).map((t) => t.thread_id).sort()).toEqual(['9001', '9002']);
    expect(forbiddenForumThreads(db, normal).map((t) => t.thread_id)).toEqual(['9001']);
  });
```

`tests/ticketSyncAccess.test.ts`, `'keeps a new member of staff out until every post about them is really gone'` becomes:

```ts
  it('keeps a member of staff out while a ticket about them is open, and until its post is really gone', async () => {
    sync.start();
    const id = (fileReport(db, IDS[0], { targetId: IDS[5], category: 'griefing', text: '' }, { adminSteamIds: [ADMIN] }) as { ticketId: number }).ticketId;
    await sync.idle();
    const post = staffThread(db, id)!.thread_id;
    // Two promotions in one signal: the accused of an open ticket, and
    // somebody with no ticket about them.
    db.prepare('UPDATE players SET is_mod = 1 WHERE steamid IN (?, ?)').run(IDS[5], IDS[1]);
    publishTicketSignal({ kind: 'staff' });
    await sync.idle();
    expect(t.threadsById.get(post)!.deleted).toBe(false);
    expect(access()).toEqual(['901', '906', '907']);
    db.prepare("UPDATE tickets SET status = 'closed' WHERE id = ?").run(id);
    // Discord refuses the deletion twice: once in the sweep, once for the ticket.
    t.failThreadOps = 2;
    await sync.reconcile();
    expect(t.threadsById.get(post)!.deleted).toBe(false);
    expect(access()).toEqual(['901', '906', '907']);
    await sync.reconcile();
    expect(t.threadsById.get(post)!.deleted).toBe(true);
    expect(access()).toEqual(['901', '905', '906', '907']);
  });
```

`tests/ticketSyncRestricted.test.ts`:
- `'making the accused staff deletes every forum post about them, closed tickets included'` becomes:

```ts
  it('making the accused staff deletes the post of their closed ticket and keeps the open one', async () => {
    const closed = file(IDS[0], IDS[5]);
    await sync.idle();
    closeTicket(db, closed, MOD, 'no_action', '');
    await sync.idle();
    const open = file(IDS[0], IDS[5], 'cheating');
    await sync.idle();
    const closedPost = staffThread(db, closed)!.thread_id;
    const openPost = staffThread(db, open)!.thread_id;
    db.transaction(() => {
      db.prepare('UPDATE players SET is_mod = 1 WHERE steamid = ?').run(IDS[5]);
      holdFeedAbout(db, IDS[5]);
    })();
    publishTicketSignal({ kind: 'staff' });
    await sync.idle();
    expect(t.threadsById.get(closedPost)!.deleted).toBe(true);
    expect(t.threadsById.get(openPost)!.deleted).toBe(false);
    expect(staffThread(db, open)!.surface).toBe('forum');
    expect([...(t.channelAccess.get('forum1') ?? [])].sort()).toEqual(['906', '907']);
  });
```

- `'a normal ticket about staff has no Discord thread yet'` (renamed in Task 1): delete it. `tests/ticketStaffForum.test.ts` covers the case.

- [ ] **Step 7: Run the new file, then the full suite and typecheck**

Run: `npx vitest run tests/ticketStaffForum.test.ts`, then `npx vitest run`, then `npm run typecheck`
Expected: all pass. `grep -rn about_staff src web/src tests` prints nothing.

- [ ] **Step 8: Commit**

```bash
git add src web/src tests
git commit -m "Post tickets about staff to the forum with their subject kept out of it"
```

---

### Task 3: Restricted tickets are worked on the site only

**Files:**
- Modify: `src/tickets/threads.ts`, `src/discord/ticketSync.ts` (only the `announceInFeed` type), `src/discord/ticketCard.ts` (`accessDm`), `src/tickets/views.ts`, `web/src/api.ts`, `web/src/routes/admin/AdminTicket.tsx`
- Test: `tests/ticketSiteOnly.test.ts` (create); `tests/ticketSyncRestricted.test.ts`, `tests/ticketSyncAccess.test.ts`, `tests/ticketFeedHeld.test.ts`, `web/src/routes/admin/AdminTicket.test.tsx` (update)

**Interfaces:**
- Produces: `surfaceFor(db, t): { surface: ThreadSurface | null; why: 'ok' | 'unconfigured' | 'restricted' }`, where a restricted ticket always answers `{ surface: null, why: 'restricted' }`. `TicketDiscussion['state']` gains `'restricted'`. Phase 3b2 relies on "a restricted ticket has no staff thread to relay into".

What happens to a private staff thread that already exists (production has none, and the spec says so; this is for the general case): nothing new. The reconciler still keeps it exactly as it did (members from `privateThreadAudience`, the ejection sweep, the card, the lock), because `reconcileTicket` only replaces a thread whose surface differs from a NON-null `surfaceFor` answer. Only creation stops. Un-restricting such a ticket still ends the private thread and makes a forum post, as today.

- [ ] **Step 1: Write the failing tests** `tests/ticketSiteOnly.test.ts`

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openDb, type DB } from '../src/db.js';
import { upsertPlayer, activatePlayer, linkDiscord } from '../src/players.js';
import { setSetting } from '../src/settings.js';
import { fileReport } from '../src/tickets/filing.js';
import { addAccess } from '../src/tickets/actions.js';
import { staffThread, surfaceFor } from '../src/tickets/threads.js';
import { getTicketRow } from '../src/tickets/store.js';
import { ticketDetail } from '../src/tickets/views.js';
import { subscribeAdminEvents, type AdminEvent } from '../src/adminFeed.js';
import { TicketSync } from '../src/discord/ticketSync.js';
import { FakeTransport } from './fakes/fakeTransport.js';

const IDS = Array.from({ length: 8 }, (_, i) => `7656119900000032${i}`);
const [R1, , , ACCUSED, , , MOD, ADMIN] = IDS;
let db: DB;
let t: FakeTransport;
let sync: TicketSync;
let events: AdminEvent[];
let off: () => void;

beforeEach(() => {
  db = openDb(':memory:');
  IDS.forEach((id, i) => {
    upsertPlayer(db, { steamid: id, name: `player${i}`, avatar: null }, []);
    activatePlayer(db, id);
    linkDiscord(db, id, `92${i}`, `d${i}`);
  });
  db.prepare('UPDATE players SET is_mod = 1 WHERE steamid = ?').run(MOD);
  db.prepare('UPDATE players SET is_admin = 1 WHERE steamid = ?').run(ADMIN);
  setSetting(db, 'discord_tickets_forum_id', 'forum1');
  setSetting(db, 'discord_tickets_channel_id', 'chan1');
  t = new FakeTransport();
  sync = new TicketSync({ db, transport: t, publicUrl: 'https://pug.test', intervalMs: 0 });
  sync.start();
  events = [];
  off = subscribeAdminEvents((e) => events.push(e));
});
afterEach(() => { sync.stop(); off(); });

describe('a restricted ticket', () => {
  it('gets no Discord thread anywhere; its list is DMed the site link and nothing else', async () => {
    const id = (fileReport(db, R1, { targetId: ACCUSED, category: 'unsafe', text: 'threats' }, { adminSteamIds: [ADMIN] }) as { ticketId: number }).ticketId;
    addAccess(db, id, ADMIN, MOD);
    await sync.idle();
    expect(t.threadsById.size).toBe(0);
    expect(staffThread(db, id)).toBeUndefined();
    expect(t.dms.map((d) => d.userId).sort()).toEqual(['926', '927']);
    for (const dm of t.dms) {
      const said = JSON.stringify(dm.payload);
      expect(said).toContain(`https://pug.test/admin/people/tickets/${id}`);
      expect(said).toContain('on the site only');
      expect(said).not.toContain('player3');
    }
    await sync.reconcile();
    expect(t.dms).toHaveLength(2);
    expect(events).toEqual([]);
  });

  it('surfaceFor and the ticket page say so', () => {
    const id = (fileReport(db, R1, { targetId: ACCUSED, category: 'unsafe', text: 'threats' }, { adminSteamIds: [ADMIN] }) as { ticketId: number }).ticketId;
    expect(surfaceFor(db, getTicketRow(db, id)!)).toEqual({ surface: null, why: 'restricted' });
    expect(ticketDetail(db, id, ADMIN, { guildId: 'g1' })!.discussion).toEqual({ state: 'restricted', surface: null, url: null });
  });
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `npx vitest run tests/ticketSiteOnly.test.ts`
Expected: FAIL (a private thread is made in `chan1`; `why` is `'ok'`).

- [ ] **Step 3: `src/tickets/threads.ts`, `surfaceFor`**

```ts
/**
 * Where a ticket's staff thread belongs, and why nowhere when it is nowhere.
 * One function, used by the reconciler to act and by the ticket page to
 * explain, so the two cannot disagree.
 *
 * A restricted ticket has no staff thread at all (owner, 2026-09-22): its
 * discussion is on the site, where the access list is enforced, and the
 * people on the list are DMed the link. Discord's own Administrator
 * permission reads every thread there is, so a private thread was never as
 * private as the ticket. A private thread made before this rule is left as
 * it is: reconcileTicket replaces a thread only for a surface that is not
 * null.
 *
 * A ticket about staff goes to the forum like any other: forumAudience keeps
 * its subject out of it.
 */
export function surfaceFor(
  db: DB, t: { restricted: number; target_id: string | null },
): { surface: ThreadSurface | null; why: 'ok' | 'unconfigured' | 'restricted' } {
  if (t.restricted === 1) return { surface: null, why: 'restricted' };
  return (getSetting(db, 'discord_tickets_forum_id') ?? '') ? { surface: 'forum', why: 'ok' } : { surface: null, why: 'unconfigured' };
}
```

Update the `privateThreadAudience` doc comment's first line to: "Who may be in a restricted ticket's private staff thread, where one survives from before restricted tickets went site-only, and who is DMed the link to a restricted ticket: on its access list, ..." (rest unchanged).

- [ ] **Step 4: `src/discord/ticketSync.ts`**

`announceInFeed(t: TicketRow, why: 'ok' | 'unconfigured' | 'restricted'): void`. Its body already returns for a restricted ticket first. In `reconcileTicket`, change the comment above `if (thread && surface && thread.surface !== surface)` to:

```ts
    // A thread on the wrong surface for a NON-null answer is replaced: a
    // private thread from before restricted tickets went site-only, on a
    // ticket that has since been un-restricted, ends and the forum takes over.
    // A null answer ends nothing: a blanked setting, and a restricted
    // ticket's surviving private thread, are simply kept up.
```

`src/discord/ticketCard.ts`, `accessDm` body:

```ts
export function accessDm(ticketId: number, publicUrl: string): MessagePayload {
  const url = `${publicUrl}/admin/people/tickets/${ticketId}`;
  return {
    content: [
      'You have been given access to a restricted ticket. Only the people on its access list can see it.',
      'Restricted tickets are worked on the site only, with no Discord thread, so keep the discussion there.',
    ].join('\n'),
    embeds: [],
    components: [[{ kind: 'link', url, label: `Open ticket #${ticketId}` }]],
    mentionUserIds: [],
  };
}
```

(The Step 1 test matches `'on the site only'`; the wording "worked on the site only" contains it.)

- [ ] **Step 5: `src/tickets/views.ts` and the web**

`discussion.state`:

```ts
    state: thread ? 'ready' as const
      : where.why === 'unconfigured' ? 'unconfigured' as const
        : where.why === 'restricted' ? 'restricted' as const
          : row.status === 'open' ? 'pending' as const : 'none' as const,
```

`web/src/api.ts`: `state: 'ready' | 'pending' | 'unconfigured' | 'restricted' | 'none';`

`web/src/routes/admin/AdminTicket.tsx`, `Discussion`:

```tsx
  const text = d.state === 'unconfigured' ? 'Discord discussion is not configured. An admin can set the tickets forum and the tickets channel in Settings; until then this ticket is worked here.'
    : d.state === 'pending' ? 'The Discord thread for this ticket has not been made yet. The bot makes it within a few minutes of being online.'
      : d.state === 'restricted' ? 'Restricted tickets have no Discord thread. Work it here: the people on its access list were sent a link to this page.'
        : 'This ticket has no Discord thread.';
```

and the restricted section's paragraph becomes:

```tsx
          <p>Only the people listed here can see this ticket. It has no Discord thread, so keep the discussion on this page.</p>
```

- [ ] **Step 6: Update the existing tests**

`web/src/routes/admin/AdminTicket.test.tsx`: add one test in the `describe('AdminTicket', ...)` block:

```tsx
  it('says a restricted ticket is worked here, with no Discord thread', async () => {
    mockMod.ticket.mockResolvedValue(detail({
      ticket: { ...detail().ticket, restricted: true },
      discussion: { state: 'restricted', surface: null, url: null },
    }));
    render(<AdminTicket id={1} onBack={() => {}} onOpen={() => {}} />);
    expect(await screen.findByText(/Restricted tickets have no Discord thread/)).toBeTruthy();
    expect(screen.getByText(/It has no Discord thread, so keep the discussion on this page/)).toBeTruthy();
  });
```

`tests/ticketSyncAccess.test.ts`, in `'ready with a link, pending, unconfigured, and about staff'`: rename it `'ready with a link, pending, unconfigured, and restricted'` and change the restricted expectation to `.toEqual({ state: 'restricted', surface: null, url: null })`.

`tests/ticketFeedHeld.test.ts`, T7 becomes:

```ts
  it('T7: a restricted ticket with the tickets channel configured says nothing anywhere in Discord', async () => {
    setSetting(db, 'discord_tickets_channel_id', 'chan1');
    fileReport(db, IDS[0], { targetId: IDS[5], category: 'unsafe', text: 'first' }, { adminSteamIds: [ADMIN] });
    await settled();
    fileReport(db, IDS[1], { targetId: IDS[5], category: 'unsafe', text: 'second' }, { adminSteamIds: [ADMIN] });
    await settled();
    expect(t.threadsIn('chan1')).toEqual([]);
    expect(t.live().filter((m) => /another report/i.test(JSON.stringify(m.payload)))).toEqual([]);
    expect(inFeed()).toEqual([]);
  });
```

`tests/ticketSyncRestricted.test.ts`: the private-thread machinery is still exercised, through a thread that exists from before this rule. Add `insertThread` to the threads import, and add this helper under `members`:

```ts
/** A private staff thread made before restricted tickets went site-only
 *  (phase 3b1). None exist in production; the reconciler still keeps one:
 *  its members, its card, its lock, the ejection sweep. */
async function legacyThread(ticketId: number): Promise<string> {
  const made = await t.threads.createPrivateThread('chan1', { name: `Ticket #${ticketId}` });
  insertThread(db, { ticketId, kind: 'staff', surface: 'private', channelId: 'chan1', threadId: made.threadId });
  // As createThread does: the card counts the reports already filed, so none
  // of them gets an "another report" line.
  db.prepare('UPDATE ticket_reports SET announced_at = ? WHERE ticket_id = ? AND announced_at IS NULL').run(new Date().toISOString(), ticketId);
  await sync.reconcileTicket(ticketId);
  return made.threadId;
}
```

Then:
- `'gets a private thread whose members are its access list, one DM each, and nothing in the forum'` becomes:

```ts
  it('gets no thread, one DM each with the site link, and nothing in the forum', async () => {
    const id = file(IDS[0], IDS[5], 'unsafe');
    await sync.idle();
    expect(t.threadsIn('forum1')).toEqual([]);
    expect(t.threadsIn('chan1')).toEqual([]);
    expect(staffThread(db, id)).toBeUndefined();
    expect(t.dms.map((d) => d.userId)).toEqual(['907']);
    expect(JSON.stringify(t.dms[0].payload)).toContain(`https://pug.test/admin/people/tickets/${id}`);
    expect(JSON.stringify(t.dms[0].payload)).not.toContain('player5');
    expect(events).toEqual([]);
  });

  it('keeps a private thread from before, whose members are its access list', async () => {
    const id = file(IDS[0], IDS[5], 'unsafe');
    await sync.idle();
    const threadId = await legacyThread(id);
    expect(await members(threadId)).toEqual(['907']);
    const inThread = t.live().filter((m) => m.channelId === threadId);
    expect(inThread).toHaveLength(1);
    expect(staffThread(db, id)).toMatchObject({ surface: 'private', channel_id: 'chan1', card_message_id: inThread[0].id });
  });
```

- In each of these tests, add `await legacyThread(<ticket>);` right after the FIRST `await sync.idle();` of the test (for `<ticket>` use the test's own variable): `'giving access adds the person to the thread and DMs them, once'` (`id`), `'someone who is no longer on the list, or no longer linked, is taken out of the thread'` (`id`), `'a removeMember Discord refuses is warned about, not thrown, so the rest of the ticket still syncs'` (`id`), `'leaves a live private thread unlocked and unarchived, with members and card still syncing'` (`id`), `'goes from an open thread and from a closed, locked one, which ends locked and archived'` (both: `await legacyThread(open); await legacyThread(closed);`), `'is never added and never DMed when the demotion came first'` (`id`), `'a merge that repoints a locked, archived thread onto one of its own members ejects them and keeps it locked'` (`id`), `'is ejected from a thread Discord archived on its own, which stays open for business'` (`id`), `'one thread Discord refuses does not stop the next thread in the same pass'` (`await legacyThread(a); await legacyThread(b);`), `'a thread the ejection cannot clean still loses its forbidden forum post in the same pass'` (`restricted`).
- `'restricting by hand deletes the forum post and opens a private thread'` becomes `'restricting by hand deletes the forum post and opens nothing'`, with its last three lines replaced by `expect(staffThread(db, id)).toBeUndefined();` and `expect(t.threadsIn('chan1')).toEqual([]);`.
- `'lifting the restriction ends the private thread and posts to the forum'`: after `await sync.idle();` (the one following `setRestricted(..., true, ...)`), replace `const priv = staffThread(db, id)!.thread_id;` with `const priv = await legacyThread(id);`.
- `'deletes the forum post instead of retiring it, and never mentions it anywhere'`: its last line becomes `expect(staffThread(db, restricted)).toBeUndefined();` (the restricted survivor has no thread of its own now).

If the `'a removeMember Discord refuses ...'` test's comment about "three removals ... in one pass" no longer matches the op count after `legacyThread`, recount: `legacyThread` runs before `failThreadOps` is set, so the count is unchanged.

- [ ] **Step 7: Run the new file, then the full suite and typecheck**

Run: `npx vitest run tests/ticketSiteOnly.test.ts`, then `npx vitest run`, then `npm run typecheck`
Expected: all pass.

- [ ] **Step 8: Commit**

```bash
git add src web/src tests
git commit -m "Work restricted tickets on the site only, with no Discord thread"
```

---

### Task 4: A player's case view lists their Discord sanctions

**Files:**
- Modify: `src/tickets/discordSanctions.ts`, `src/tickets/views.ts`, `src/tickets/caseFile.ts`, `src/admin/playerFile.ts`, `web/src/api.ts`, `web/src/routes/admin/AdminTicket.tsx`, `web/src/routes/admin/file/StandingSection.tsx`
- Test: `tests/sanctionsForPlayer.test.ts` (create), `web/src/routes/admin/AdminTicket.test.tsx`, `web/src/routes/playerFile.test.tsx` (add one test each)

**Interfaces:**
- Produces: `sanctionsForPlayer(db: DB, steamid: string, now?: Date): SanctionRow[]` in `discordSanctions.ts`; `export function redactDiscordSanction(db: DB, s: SanctionRow, viewer: string): SanctionRow` from `views.ts` (was private); `caseFile(...).discordSanctions: SanctionRow[]`; `PlayerFile.sections.standing.discordSanctions: SanctionRow[]`.

Why through `discord_link_history`: the 3c plan left this as follow-up. Once a Discord-only person links Steam, `adoptDiscordPerson` moves their tickets onto the player and clears `target_discord_id`, so the ticket page's sanctions list (keyed on `target_discord_id`) goes blank, and the rows stay keyed by Discord id on purpose. Every Discord id the player has ever linked is in `discord_link_history` (a merge moves those rows to the survivor), so that table is the link.

- [ ] **Step 1: Write the failing test** `tests/sanctionsForPlayer.test.ts`

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { openDb, type DB } from '../src/db.js';
import { upsertPlayer, activatePlayer, linkDiscord, unlinkDiscord } from '../src/players.js';
import { fileReport } from '../src/tickets/filing.js';
import { sanctionsForPlayer } from '../src/tickets/discordSanctions.js';
import { caseFile } from '../src/tickets/caseFile.js';
import { playerFile } from '../src/admin/playerFile.js';
import { fileViewer } from '../src/admin/fileAccess.js';

const [NEWBIE, MOD, ADMIN, OWNER, R1] = ['76561199000000901', '76561199000000902', '76561199000000903', '76561199000000904', '76561199000000905'];
let db: DB;

beforeEach(() => {
  db = openDb(':memory:');
  for (const id of [NEWBIE, MOD, ADMIN, OWNER, R1]) {
    upsertPlayer(db, { steamid: id, name: id.slice(-3), avatar: null }, []);
    activatePlayer(db, id);
  }
  db.prepare('UPDATE players SET is_mod = 1 WHERE steamid = ?').run(MOD);
  db.prepare('UPDATE players SET is_admin = 1 WHERE steamid IN (?, ?)').run(ADMIN, OWNER);
});

const sanction = (discordId: string, ticketId: number | null, reason: string, at: string) =>
  db.prepare(
    "INSERT INTO discord_sanctions (discord_id, kind, until, reason, ticket_id, created_by, created_at) VALUES (?, 'timeout', '2099-01-01T00:00:00Z', ?, ?, ?, ?)",
  ).run(discordId, reason, ticketId, MOD, at);

describe('sanctionsForPlayer', () => {
  it('lists the sanctions on every Discord id the player has linked, newest first, and none of anyone else\'s', () => {
    sanction('950', null, 'spam before linking', '2026-09-20T00:00:00Z');
    sanction('951', null, 'on the old account', '2026-09-21T00:00:00Z');
    sanction('999', null, 'somebody else', '2026-09-22T00:00:00Z');
    linkDiscord(db, NEWBIE, '951', 'old');
    unlinkDiscord(db, NEWBIE);
    linkDiscord(db, NEWBIE, '950', 'now');
    expect(sanctionsForPlayer(db, NEWBIE).map((s) => s.reason)).toEqual(['on the old account', 'spam before linking']);
    expect(sanctionsForPlayer(db, R1)).toEqual([]);
  });

  it('shows on the case file and the Player File, redacted where the ticket is restricted and the viewer is off its list', () => {
    const lurker = { discordId: '950', name: 'Lurky', bot: false, administrator: false };
    const restricted = (fileReport(db, R1, { category: 'unsafe', text: 'threats' }, { adminSteamIds: [OWNER], targetDiscord: lurker }) as { ticketId: number }).ticketId;
    sanction('950', restricted, 'the private reason', '2026-09-22T00:00:00Z');
    linkDiscord(db, NEWBIE, '950', 'Lurky', { adminSteamIds: [OWNER] });
    const forOwner = caseFile(db, NEWBIE, OWNER)!.discordSanctions;
    expect(forOwner.map((s) => s.reason)).toEqual(['the private reason']);
    const forMod = caseFile(db, NEWBIE, MOD)!.discordSanctions;
    expect(forMod).toHaveLength(1);
    expect(forMod[0]).toMatchObject({ reason: 'Withheld (restricted ticket)', ticketId: null, createdBy: '', createdByName: null });
    const file = playerFile(db, NEWBIE, fileViewer(db, ADMIN))!;
    expect(file.sections.standing.discordSanctions[0]).toMatchObject({ reason: 'Withheld (restricted ticket)' });
  });
});
```

`playerFile(db, steamid, viewer: FileViewer, now?)` is the real export of `src/admin/playerFile.ts` and returns `PlayerFile | null` (null for a file the viewer may not open; an admin opens any file).

- [ ] **Step 2: Run it to see it fail**

Run: `npx vitest run tests/sanctionsForPlayer.test.ts`
Expected: FAIL (`sanctionsForPlayer` is not exported).

- [ ] **Step 3: The server side**

`src/tickets/discordSanctions.ts`, after `sanctionsFor`:

```ts
/**
 * Every sanction on any Discord id this player has ever linked, newest first.
 * The rows stay keyed by Discord id (Discord acts on that id), so once a
 * Discord-only person links Steam, this is how their player case view still
 * finds what was done to them before. discord_link_history keeps every link,
 * and a merge moves those rows onto the survivor. Not redacted: callers pass
 * each row through redactDiscordSanction for their viewer.
 */
export function sanctionsForPlayer(db: DB, steamid: string, now = new Date()): SanctionRow[] {
  const ids = (db.prepare(
    `SELECT discord_id FROM discord_link_history WHERE steamid = ?
     UNION SELECT discord_id FROM players WHERE steamid = ? AND discord_id IS NOT NULL`,
  ).all(steamid, steamid) as { discord_id: string }[]).map((r) => r.discord_id);
  return ids.flatMap((id) => sanctionsFor(db, id, now))
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : b.id - a.id));
}
```

`src/tickets/views.ts`: change `function redactDiscordSanction(` to `export function redactDiscordSanction(` (body unchanged).

`src/tickets/caseFile.ts`: import `sanctionsForPlayer` from `'./discordSanctions.js'` and `redactDiscordSanction` beside `ticketsAbout` from `'./views.js'`, and add to the returned object after `tickets`:

```ts
    // Timeouts and bans the bot carried out in Discord, on any Discord id
    // this player has linked: most were placed before they had a player
    // account at all. Redacted per viewer like a ban from a restricted ticket.
    discordSanctions: sanctionsForPlayer(db, steamid).map((s) => redactDiscordSanction(db, s, viewer)),
```

`src/admin/playerFile.ts`: import `sanctionsForPlayer` from `'../tickets/discordSanctions.js'` and `redactDiscordSanction` from `'../tickets/views.js'` (beside `ticketsAbout`); add `discordSanctions: SanctionRow[];` to the `standing` type in `PlayerFile` (import `type SanctionRow` from `'../tickets/discordSanctions.js'`), and in the builder's `standing: { ... }` add after `timeout`:

```ts
        discordSanctions: sanctionsForPlayer(db, canonical).map((s) => redactDiscordSanction(db, s, viewer.steamid)),
```

- [ ] **Step 4: The web**

`web/src/api.ts`: add `discordSanctions?: DiscordSanction[];` as the last field of `CaseFile` (optional: a browser holding new JS against an older server), and `discordSanctions?: DiscordSanction[];` after `timeout` in `PlayerFileData.sections.standing`. `DiscordSanction` is declared after `CaseFile` in the file; a TypeScript interface may refer to one declared later, so no move is needed.

`web/src/routes/admin/AdminTicket.tsx`: import `type DiscordSanction` beside `TicketDiscussion`, and add above `function Discussion`:

```tsx
/** One Discord sanction as a line. A redacted row (a restricted ticket this
 *  viewer is off) has no issuer: no "by" clause rather than a dangling one. */
export function sanctionText(s: DiscordSanction): string {
  const by = s.createdByName || s.createdBy || '';
  const what = s.kind === 'ban' ? 'Banned from the Discord' : `Timed out until ${fmtTime(s.until!)}`;
  const state = s.liftedAt ? ` (lifted ${fmtTime(s.liftedAt)})` : s.active ? '' : ' (ended)';
  return `${what}${by ? ` by ${by}` : ''}: ${s.reason}${state}`;
}
```

In the existing Discord sanctions list, replace the two lines that build `by` and the text before the Lift button with `{sanctionText(s)}` (the Lift button stays). In the case file `<ul class="admin-list">`, after the aliases line, add:

```tsx
            {(c.discordSanctions ?? []).map((s) => <li key={`ds${s.id}`}>{sanctionText(s)}</li>)}
```

`web/src/routes/admin/file/StandingSection.tsx`: import `{ sanctionText }` from `'../AdminTicket'`, and after the bans `<ul>` block add:

```tsx
      {(s.discordSanctions ?? []).length > 0 && (
        <>
          <h4>Discord</h4>
          <ul class="admin-list">
            {s.discordSanctions!.map((x) => <li key={x.id}>{sanctionText(x)}</li>)}
          </ul>
        </>
      )}
```

- [ ] **Step 5: Web tests**

`web/src/routes/admin/AdminTicket.test.tsx`, a new test:

```tsx
  it('lists the accused\'s Discord sanctions in the case file', async () => {
    mockMod.ticket.mockResolvedValue(detail({ caseFile: { ...caseFile, discordSanctions: [redactedSanctionRow] } }));
    render(<AdminTicket id={1} onBack={() => {}} onOpen={() => {}} />);
    expect(await screen.findByText('Banned from the Discord: Withheld (restricted ticket)')).toBeTruthy();
  });
```

`web/src/routes/playerFile.test.tsx`, a new test in `describe('the Player File', ...)`:

```tsx
  it('lists Discord sanctions from before the player linked Steam', async () => {
    const base = file();
    mockPeople.file.mockResolvedValue(file({
      sections: { ...base.sections, standing: { ...base.sections.standing, discordSanctions: [{
        id: 3, kind: 'ban', until: null, reason: 'spam raid', ticketId: 4, createdBy: '9', createdByName: 'boss',
        createdAt: '2026-09-01T00:00:00.000Z', liftedBy: null, liftedAt: null, active: true,
      }] } },
    }));
    render(<PlayerFile steamid={P} me="76561199000000009" />);
    expect(await screen.findByText('Banned from the Discord by boss: spam raid')).toBeTruthy();
  });
```

- [ ] **Step 6: Full suite and typecheck**

Run: `npx vitest run tests/sanctionsForPlayer.test.ts`, then `npx vitest run`, then `npm run typecheck`
Expected: all pass.

- [ ] **Step 7: Commit**

```bash
git add src web/src tests
git commit -m "List a player's Discord sanctions from before they linked Steam on their case views"
```

---

## After the last task

- [ ] Deploy per the owner's standing rule (no players in game; back up the database; verify the tree hash, the service, and the bot login). No schema change in this plan, so no migration dry run is needed.
- [ ] Production data: 2 tickets. Ticket 1 is closed, restricted, about an admin, one `toxicity` report (read from the 2026-09-22 00:17 backup). Ticket 2 is open and normal. Nothing is migrated (see decision 3). After deploy, check on the box: `SELECT id, status, restricted, target_id FROM tickets` shows the same two rows unchanged, and `SELECT COUNT(*) FROM ticket_threads WHERE surface = 'private' AND kind = 'staff'` is 0.
- [ ] Live checklist for the owner (the fake cannot prove these):
  - File a test report (ordinary category) about a test moderator account. The post appears in the staff forum; the moderator's Discord account cannot see the forum at all while the ticket is open (check from that account); every other moderator can.
  - Close it: the post disappears from the forum, and within five minutes the moderator can see the forum again.
  - No role grants the tickets forum: the forum's access is member overwrites only. If a Moderator role has View Channel on the forum, the accused keeps reading their own case and nothing here can stop it. Check the forum's permission page.
  - File a Safety concern report: no thread appears anywhere in Discord; the owner receives the DM with the site link.
  - The admin feed channel shows nothing when a test ticket about an admin is claimed or closed.

## Decisions and deviations

1. **The Discord-administrator auto-restrict rule for Discord-only targets is dropped** (spec section 1, "Auto-restrict"). The owner's ruling is "only unsafe reports are restricted, for staff and non-staff alike", and restriction now means "site-only", which this plan applies uniformly. The picked member's `administrator` flag still holds the report from the admin feed. The spec's known-limit note stays: a Discord Administrator reads the forum post about themselves, and nothing the bot does can change that.
2. **A closed ticket's forum post about a member of staff is deleted** (after the mirror copies it to the site). The owner accepted that the accused is out of the forum "while an open forum post is about them"; an archived post is still a post, so without deletion they would be out for ever after one ticket. A reopen makes a new post.
3. **Existing restricted tickets about staff with no unsafe report are left restricted.** Restriction is a promise made to the people who worked the case under it; lifting it automatically would widen who can read what they wrote. `setRestricted` now lets anyone on the list lift it by hand. Production has exactly one such ticket (id 1, closed), so the general rule costs nothing.
4. **Existing private staff threads are kept, not ended**, and still maintained (members, card, lock, ejection). Production has none; ending them would add code and tests for nothing, and keeping them is the smaller change.
5. **`forumAudience` also leaves out whoever an open ordinary ticket is about, post or no post**, and `keepSubjectOut` revokes before a post is made. This goes beyond "forumAudience already does this" in the brief: without it, every new ticket, reopen and un-restrict about a member of staff had a window where the post existed and its subject still held the forum overwrite.
6. **Every moderator now sees a colleague's case file and summary on an ordinary ticket about them** (bans, penalty counts, input flags, aliases, shared connections). That follows from the ruling (the team works the ticket). The full Player File stays admin-only for a colleague (`canOpenFile` is unchanged).
7. **Audit rows about a ticket about staff are quiet** (`ticketIsQuiet`), the same as a restricted ticket's. Not asked for, but without it the admin feed tells an accused admin that a ticket they cannot open has activity.
8. **`holdFeedAbout` runs on promotion, merge and adoption**, and `announceInFeed` holds a report about a staff member itself, for a flag set by hand in the database.
9. **The legacy report migration (`src/tickets/migrate.ts`) still restricts by staff flag.** It is a one-time backfill of the pre-tickets `reports` table that has already run in production; changing it would change nothing live and churn its test.
10. **`sanctionsForPlayer` uses every Discord id the player has ever linked**, not only the current one. A sanction on an id they linked and later unlinked is still about the same person, which is what the People desk is for.
11. **Carried item B, placement:** the `author_player_id` backfill, the dropped `stillEmpty` count (now published by `linkDiscord`) and the 3c sanctions follow-up are all in this plan. The dropped `'nobody'` outcome disappears with `restrictOpenTicketAbout` itself.
