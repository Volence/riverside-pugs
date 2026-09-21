# Tickets Phase 2a Implementation Plan: the staff thread in Discord

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give every ticket a staff discussion thread in Discord that the bot creates, keeps current, locks and removes on its own, with Claim and Close on the post, and with a private thread for restricted tickets whose members are exactly the access list.

**Architecture:** A new `ThreadOps` group on `BotTransport` (forum post, private thread, members, lock, archive, tags, delete, channel member access) with an in-memory fake; `djsTransport.ts` stays the only file importing discord.js. One reconciler, `TicketSync`, owns everything Discord-side: it is told "ticket N changed" or "staff changed" over a small in-process bus after the database commit, runs on bot ready and every five minutes, and derives what Discord should look like from the database alone, so nothing in a request path ever waits on Discord. The site side gains a `ticket_threads` table and tells the ticket page whether a discussion exists.

**Tech Stack:** Fastify 5, better-sqlite3, discord.js 14.27 behind `BotTransport`, Preact 10 + preact-iso, vitest 4 (`server` and `web` projects).

**Spec:** `docs/superpowers/specs/2026-09-21-tickets-design.md`. This plan is the first half of build order item 2: "Staff forum post, overwrite sync, mirror with backfill, attachments, removal." It covers the staff forum post, the overwrite sync, restricted private threads, the reconciler and the interim admin feed line, which from here on is posted only while no forum is set. The mirror, attachments, Remove, the live nudge and the replay moment control are in `docs/superpowers/plans/2026-09-22-tickets-phase2b.md`, which is written against the code this plan produces. Phase 3 (reporter threads and relay, End reporter chat, Remove everything from this person, the close DM) is not planned here.

## Global Constraints

- Work only in the worktree `/home/volence/l4d/pug/.claude/worktrees/tickets` on branch `worktree-tickets`. Never write to the main checkout, never `git stash`, never push, never check out another branch; other sessions are committing to master.
- Nothing is deployed. No rcon, no ssh, no `deploy-web.sh`.
- Never use em dashes or en dashes in code, comments, docs, commit messages or UI copy.
- No `CHECK` constraint on any status-like column. New tables are `CREATE TABLE IF NOT EXISTS` in `src/tickets/schema.ts`; new columns on existing tables go through `ensureColumn` in `src/db.ts`.
- discord.js is imported by exactly one file, `src/discord/djsTransport.ts`. No test imports it. Everything with logic in it is tested against `tests/fakes/fakeTransport.ts`.
- The website never waits on Discord and never fails because of it. No thread is created, edited, locked or deleted inside a request. With `discord_tickets_forum_id` and `discord_tickets_channel_id` empty, nothing Discord-side is attempted for tickets and the ticket page says so.
- Anything published to a subscriber that dials Discord or rcon is published AFTER the database transaction commits, never inside it.
- A restricted ticket must not be detectable by anyone off its access list, above all the accused. Nothing about it reaches the staff forum, the admin feed, any broadcast payload or any response. Every read path goes through `canSeeTicket` (`src/tickets/store.ts`) or its SQL twin `VISIBLE` (`src/tickets/views.ts`). Missing and invisible are the same answer: 404, never 403.
- A forum post must never be readable by the player it is about. A ticket that is restricted, or whose accused holds `is_mod` or `is_admin`, has no forum post; one that exists is deleted, and the accused is granted no access to the forum until it is gone.
- Bans stay site-only. The staff post's buttons in this phase are Claim or Release, and Close. "Contact reporter" is phase 3; the button row leaves room for it.
- Discord buttons re-check that the presser is active staff who can see the ticket, run the same action functions the site runs (`src/tickets/actions.ts`), and are audited through `logAdmin` with `via: 'discord'` in the detail and `quiet` for a restricted ticket.
- Setting defaults, exact: `discord_tickets_forum_id` = `''`, `discord_tickets_channel_id` = `''`.
- Categories, exact: `griefing`, `cheating`, `toxicity`, `afk`, `unsafe`, `other`. Outcomes, exact: `action_taken`, `warned`, `no_action`, `invalid`.
- Anyone with the Discord Administrator permission can read every channel and thread in the server, private threads included. The ticket page says this in plain words on every restricted ticket; no code can change it.
- Commit messages follow the repo style: one plain sentence saying what changed, no prefix.
- Test commands: `npx vitest run <file>` for one file, `npm test` for everything, `npm run typecheck` for types.
- Line numbers in this plan were right when it was written. Where a step quotes code, locate the place by the quoted code, not the number.

## File Structure

Created:
- `src/tickets/signals.ts`: the in-process bus that says "this ticket changed" and "the set of staff changed".
- `src/tickets/threads.ts`: the `ticket_threads` row type and its queries.
- `src/discord/ticketCard.ts`: the case card, its tags, the line for a further report, the Close modal. Pure functions.
- `src/discord/ticketSync.ts`: `TicketSync`, the reconciler.
- `src/discord/ticketButtons.ts`: Claim, Release, Close and the modal submit.
- Tests: `tests/ticketLeftovers.test.ts`, `tests/ticketThreads.test.ts`, `tests/fakeThreads.test.ts`, `tests/ticketSync.test.ts`, `tests/ticketSyncRestricted.test.ts`, `tests/ticketSyncAccess.test.ts`, `tests/ticketButtons.test.ts`.

Modified:
- `src/tickets/store.ts` (`accessSeed`, `foldTicket`, `reseedOrphanedTickets`, `restrictOpenTicketAbout` returns an outcome), `src/tickets/schema.ts` (`ticket_threads`), `src/tickets/views.ts` (`ticketCounts`, `discussion` on the detail), `src/tickets/actions.ts` and `src/tickets/filing.ts` (signals), `src/mergePlayers.ts`, `src/routes/admin.ts`, `src/routes/discordAuth.ts`, `src/routes/tickets.ts`, `src/db.ts`, `src/settingsSchema.ts`, `src/adminFeed.ts`, `src/discord/adminFeedPoster.ts`, `src/discord/transport.ts`, `src/discord/index.ts`, `src/discord/djsTransport.ts`, `src/server.ts`, `scripts/merge-players.ts`, `tests/fakes/fakeTransport.ts`, `tests/discordAdminFeed.test.ts`, `tests/discordBot.test.ts`, `tests/ticketRoutes.test.ts`.
- `web/src/api.ts`, `web/src/routes/admin/AdminTickets.tsx`, `web/src/routes/admin/AdminTicket.tsx`, `web/src/routes/tickets.test.tsx`.

---

### Task 1: Phase 1 leftovers: nobody-left access lists, audit rows that follow a fold, counts on the list

Three small things the phase 1 review left open. They come first because Task 2 builds on `foldTicket`.

1. `restrictOpenTicketAbout` and the merge path can leave a restricted ticket with an empty access list: the merge passes no owners, and the one admin it falls back to can be the account being merged away, whose access row is then rewritten onto the accused and deleted. Nobody can open such a ticket, so nobody can fix it.
2. When two open tickets are folded, `admin_actions` rows whose target is the emptied ticket are orphaned, and `recentActions` drops them because the ticket no longer exists.
3. The list filters have no counts.

**Files:**
- Create: `tests/ticketLeftovers.test.ts`
- Modify: `src/tickets/store.ts` (`seedAccess`, `restrictOpenTicketAbout`; new `accessSeed`, `foldTicket`, `reseedOrphanedTickets`), `src/mergePlayers.ts` (options, the ticket block, the tail), `src/routes/admin.ts` (the `/admin`, `/mod` and `/merge` routes), `scripts/merge-players.ts:63`, `src/tickets/views.ts` (`ticketCounts`), `src/routes/tickets.ts` (the list route), `web/src/api.ts` (`modApi.tickets`), `web/src/routes/admin/AdminTickets.tsx`, `web/src/routes/admin/AdminTicket.tsx` (`eventText`), `web/src/routes/tickets.test.tsx`

**Interfaces:**
- Consumes: `seedAccess`, `addTicketEvent`, `restrictOpenTicketAbout` from `src/tickets/store.ts`; `mergePlayers(db, { from, into, dryRun?, by? })`; `publishAdminEvent` from `src/adminFeed.ts`; `VISIBLE` in `src/tickets/views.ts`.
- Produces:
  - `accessSeed(db: DB, targetId: string, adminSteamIds: string[], exclude?: string[]): string[]`
  - `seedAccess(db, ticketId, targetId, adminSteamIds, extra?, now?, exclude?: string[]): void` (one new trailing parameter)
  - `type RestrictOutcome = 'none' | 'restricted' | 'folded' | 'nobody'`
  - `restrictOpenTicketAbout(db, targetId, adminSteamIds, now?, exclude?: string[]): RestrictOutcome`
  - `foldTicket(db: DB, gone: number, keep: number, access: 'merge' | 'drop', now?: Date): void`
  - `reseedOrphanedTickets(db: DB, adminSteamIds: string[], exclude?: string[], now?: Date): { seeded: number; stillEmpty: number }`
  - `mergePlayers` option `adminSteamIds?: string[]`
  - `ticketCounts(db: DB, viewer: string): { open: number; mine: number; closed: number }`
  - `GET /api/mod/tickets` answers `{ tickets, counts }`; web type `TicketCounts`.
  - A new ticket event kind, `folded`, with detail `{ from: number }`.

- [ ] **Step 1: Write the failing test**

`tests/ticketLeftovers.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { openDb, type DB } from '../src/db.js';
import { loadConfig } from '../src/config.js';
import { buildServer } from '../src/server.js';
import { upsertPlayer, activatePlayer } from '../src/players.js';
import { fileReport } from '../src/tickets/filing.js';
import { claimTicket } from '../src/tickets/actions.js';
import { reseedOrphanedTickets, restrictOpenTicketAbout } from '../src/tickets/store.js';
import { mergePlayers } from '../src/mergePlayers.js';
import { logAdmin, recentActions } from '../src/admin/audit.js';
import { subscribeAdminEvents, type AdminEvent } from '../src/adminFeed.js';
import { authedCookie, stubOrchestrator } from './helpers.js';

const IDS = Array.from({ length: 8 }, (_, i) => `7656119900000000${i}`);
const [R1, R2, PLAYER, MAIN, ALT, ADMIN, OWNER, MOD] = IDS;
let db: DB;
let events: AdminEvent[];
let off: () => void;

const flag = (column: 'is_admin' | 'is_mod', ...ids: string[]) => {
  for (const id of ids) db.prepare(`UPDATE players SET ${column} = 1 WHERE steamid = ?`).run(id);
};
const accessOf = (ticketId: number) =>
  (db.prepare('SELECT steamid FROM ticket_access WHERE ticket_id = ? ORDER BY steamid').all(ticketId) as { steamid: string }[]).map((r) => r.steamid);
const file = (reporter: string, targetId: string, category = 'griefing', text = 'x') =>
  (fileReport(db, reporter, { targetId, category, text }, { adminSteamIds: [] }) as { ticketId: number }).ticketId;

beforeEach(() => {
  db = openDb(':memory:');
  for (const id of IDS) {
    upsertPlayer(db, { steamid: id, name: `p${id.slice(-1)}`, avatar: null }, []);
    activatePlayer(db, id);
  }
  events = [];
  off = subscribeAdminEvents((e) => events.push(e));
});
afterEach(() => off());

describe('a restricted ticket always has somebody on it', () => {
  it('does not restrict when nobody could be given access, and says so', () => {
    const id = file(R1, PLAYER);
    expect(restrictOpenTicketAbout(db, PLAYER, [])).toBe('nobody');
    expect(db.prepare('SELECT restricted FROM tickets WHERE id = ?').get(id)).toEqual({ restricted: 0 });
    expect(accessOf(id)).toEqual([]);
  });

  it('a merge into the only admin leaves the ticket normal and reports a problem that names nobody', () => {
    flag('is_admin', MAIN);
    const id = file(R1, ALT);
    mergePlayers(db, { from: ALT, into: MAIN, by: MAIN, adminSteamIds: [] });
    expect(db.prepare('SELECT target_id, restricted FROM tickets WHERE id = ?').get(id)).toEqual({ target_id: MAIN, restricted: 0 });
    const problems = events.filter((e) => e.kind === 'problem');
    expect(problems).toHaveLength(1);
    expect(JSON.stringify(problems[0])).toMatch(/could not be restricted/);
    expect(JSON.stringify(problems[0])).not.toContain(MAIN);
    expect(JSON.stringify(problems[0])).not.toContain(String(id));
  });

  it('a merge takes its owners from the caller', () => {
    flag('is_mod', MAIN);
    flag('is_admin', ADMIN, OWNER);
    const id = file(R1, PLAYER);
    // PLAYER becomes MAIN, a moderator. With no owner list the fallback would
    // be every admin, ADMIN included.
    mergePlayers(db, { from: PLAYER, into: MAIN, by: OWNER, adminSteamIds: [OWNER] });
    expect(db.prepare('SELECT restricted FROM tickets WHERE id = ?').get(id)).toEqual({ restricted: 1 });
    expect(accessOf(id)).toEqual([OWNER]);
  });

  it('never seeds the account that is being merged away', () => {
    flag('is_mod', MAIN);
    const id = file(R1, ALT);
    // Made an admin by hand after the report, so the ticket is still normal
    // and ALT is the only admin there is. Seeding ALT would restrict the
    // ticket and then empty its list in the same transaction.
    flag('is_admin', ALT);
    mergePlayers(db, { from: ALT, into: MAIN, by: OWNER, adminSteamIds: [] });
    expect(db.prepare('SELECT restricted FROM tickets WHERE id = ?').get(id)).toEqual({ restricted: 0 });
    expect(accessOf(id)).toEqual([]);
    expect(events.filter((e) => e.kind === 'problem')).toHaveLength(1);
  });

  it('a list emptied by the merge itself is filled again from the owners', () => {
    flag('is_mod', MAIN);
    flag('is_admin', ALT, OWNER);
    const id = file(R1, MAIN, 'toxicity');
    db.prepare('DELETE FROM ticket_access WHERE ticket_id = ? AND steamid != ?').run(id, ALT);
    expect(accessOf(id)).toEqual([ALT]);
    mergePlayers(db, { from: ALT, into: MAIN, by: OWNER, adminSteamIds: [OWNER] });
    expect(accessOf(id)).toEqual([OWNER]);
    expect(events.filter((e) => e.kind === 'problem')).toHaveLength(0);
  });

  it('an orphaned ticket is handed to whoever can take it, and counts what is left', () => {
    flag('is_mod', MAIN);
    const id = file(R1, MAIN, 'toxicity');
    expect(accessOf(id)).toEqual([]);
    expect(reseedOrphanedTickets(db, [])).toEqual({ seeded: 0, stillEmpty: 1 });
    flag('is_admin', ADMIN);
    expect(reseedOrphanedTickets(db, [])).toEqual({ seeded: 1, stillEmpty: 0 });
    expect(accessOf(id)).toEqual([ADMIN]);
  });
});

describe('folding two tickets', () => {
  it('moves the audit rows onto the survivor and leaves a line in its timeline', () => {
    flag('is_admin', ADMIN);
    const main = file(R1, MAIN);
    const alt = file(R2, ALT, 'cheating');
    claimTicket(db, alt, ADMIN, true);
    logAdmin(db, ADMIN, 'ticket_claim', alt, { claim: true });
    logAdmin(db, ADMIN, 'ban', ALT, { reason: 'unrelated' });
    mergePlayers(db, { from: ALT, into: MAIN, by: ADMIN, adminSteamIds: [] });
    expect(db.prepare('SELECT id FROM tickets').all()).toEqual([{ id: main }]);
    const rows = recentActions(db, ADMIN).filter((a) => a.action === 'ticket_claim');
    expect(rows.map((a) => a.target)).toEqual([String(main)]);
    const folded = db.prepare("SELECT detail FROM ticket_events WHERE ticket_id = ? AND kind = 'folded'").get(main) as { detail: string };
    expect(JSON.parse(folded.detail)).toEqual({ from: alt });
    expect(db.pragma('foreign_key_check')).toEqual([]);
  });
});

describe('counts on the list', () => {
  let app: FastifyInstance;
  afterEach(async () => { await app.close(); });

  it('counts what this viewer may see, per filter', async () => {
    app = await buildServer({ config: loadConfig({ ADMIN_STEAMIDS: OWNER }), db, orchestrator: stubOrchestrator(), serverCleaner: async () => {}, serverExec: async () => {} });
    const cookie = (id: string) => authedCookie(app, db, id);
    flag('is_mod', MOD);
    flag('is_admin', OWNER);
    const a = file(R1, PLAYER);
    file(R1, ALT);
    file(R2, PLAYER, 'unsafe', 'restricted, so the moderator never counts it');
    claimTicket(db, a, MOD, true);
    db.prepare("UPDATE tickets SET status = 'closed' WHERE target_id = ?").run(ALT);
    const asMod = (await app.inject({ method: 'GET', url: '/api/mod/tickets?filter=open', cookies: cookie(MOD) })).json();
    expect(asMod.counts).toEqual({ open: 1, mine: 1, closed: 1 });
    expect(asMod.tickets).toHaveLength(1);
    const asOwner = (await app.inject({ method: 'GET', url: '/api/mod/tickets?filter=closed', cookies: cookie(OWNER) })).json();
    expect(asOwner.counts).toEqual({ open: 2, mine: 0, closed: 1 });
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run tests/ticketLeftovers.test.ts`
Expected: FAIL. `reseedOrphanedTickets` is not exported from `src/tickets/store.ts`, so the file does not load.

- [ ] **Step 3: `accessSeed`, `seedAccess`, `foldTicket`, `reseedOrphanedTickets` and the outcome in `src/tickets/store.ts`**

Replace `seedAccess` and `restrictOpenTicketAbout` (everything from the comment `/** Who may see a newly restricted ticket.` to the end of the file) with:

```ts
/** Who would be let into a restricted ticket about this player. The
 *  configured owners first; if that leaves nobody (none configured, or the
 *  owner is the accused), every admin. Never the accused, and never anyone in
 *  `exclude`: a merge passes the account that is about to stop existing, whose
 *  row would otherwise be rewritten onto the accused and thrown away. */
export function accessSeed(db: DB, targetId: string, adminSteamIds: string[], exclude: string[] = []): string[] {
  const out = new Set([targetId, ...exclude]);
  const exists = (id: string) => !!db.prepare('SELECT 1 FROM players WHERE steamid = ?').get(id);
  const owners = adminSteamIds.filter((id) => !out.has(id) && exists(id));
  if (owners.length > 0) return owners;
  return (db.prepare('SELECT steamid FROM players WHERE is_admin = 1').all() as { steamid: string }[])
    .map((r) => r.steamid).filter((id) => !out.has(id));
}

/** Put the seed, and anyone in `extra` who is not the accused, on the list. */
export function seedAccess(
  db: DB, ticketId: number, targetId: string, adminSteamIds: string[], extra: string[] = [], now = new Date(), exclude: string[] = [],
): void {
  const out = new Set([targetId, ...exclude]);
  const ins = db.prepare('INSERT OR IGNORE INTO ticket_access (ticket_id, steamid, added_by, created_at) VALUES (?, ?, ?, ?)');
  for (const id of new Set([...accessSeed(db, targetId, adminSteamIds, exclude), ...extra.filter((e) => !out.has(e))])) {
    ins.run(ticketId, id, 'system', now.toISOString());
  }
}

/**
 * Move everything hanging off `gone` onto `keep`, then delete `gone`. Both
 * are open tickets about one player in one flavour, which tickets_one_open
 * does not allow to coexist. Runs inside the caller's transaction.
 *
 * `access`: 'merge' carries the list across (two restricted tickets become
 * one), 'drop' discards it (a normal ticket folded into its restricted
 * sibling, which has a list of its own).
 *
 * The audit rows move too. recentActions drops a ticket row whose ticket it
 * cannot find, so without this the Audit tab would lose every action ever
 * taken on the emptied ticket.
 */
export function foldTicket(db: DB, gone: number, keep: number, access: 'merge' | 'drop', now = new Date()): void {
  db.prepare('UPDATE ticket_reports SET ticket_id = ? WHERE ticket_id = ?').run(keep, gone);
  db.prepare('UPDATE ticket_events SET ticket_id = ? WHERE ticket_id = ?').run(keep, gone);
  db.prepare('UPDATE bans SET ticket_id = ? WHERE ticket_id = ?').run(keep, gone);
  if (access === 'merge') db.prepare('UPDATE OR IGNORE ticket_access SET ticket_id = ? WHERE ticket_id = ?').run(keep, gone);
  db.prepare('DELETE FROM ticket_access WHERE ticket_id = ?').run(gone);
  db.prepare("UPDATE admin_actions SET target = ? WHERE target = ? AND action LIKE 'ticket\\_%' ESCAPE '\\'")
    .run(String(keep), String(gone));
  db.prepare('DELETE FROM tickets WHERE id = ?').run(gone);
  addTicketEvent(db, keep, null, 'folded', { from: gone }, now);
}

export type RestrictOutcome = 'none' | 'restricted' | 'folded' | 'nobody';

/**
 * Close the gap between "this player is now staff" and "the case about them
 * is readable by every moderator". Called when a player is promoted and when
 * one is merged into a staff account.
 *
 * tickets_one_open allows one open ticket of each flavour, so where the
 * player already has an open restricted ticket the normal one is folded into
 * it rather than restricted.
 *
 * 'nobody' means there is no one to give the ticket to. It is then left as it
 * was: a normal ticket is still hidden from the accused by canSeeTicket, and
 * a restricted ticket nobody can open is a ticket nobody can work or repair.
 * The caller reports it once its transaction has committed. Runs inside the
 * caller's transaction.
 */
export function restrictOpenTicketAbout(
  db: DB, targetId: string, adminSteamIds: string[], now = new Date(), exclude: string[] = [],
): RestrictOutcome {
  const open = (restricted: number) => db.prepare("SELECT id FROM tickets WHERE target_id = ? AND restricted = ? AND status = 'open'")
    .get(targetId, restricted) as { id: number } | undefined;
  const normal = open(0);
  if (!normal) return 'none';
  const sibling = open(1);
  if (sibling) {
    foldTicket(db, normal.id, sibling.id, 'drop', now);
    return 'folded';
  }
  if (accessSeed(db, targetId, adminSteamIds, exclude).length === 0) return 'nobody';
  db.prepare('UPDATE tickets SET restricted = 1 WHERE id = ?').run(normal.id);
  seedAccess(db, normal.id, targetId, adminSteamIds, [], now, exclude);
  addTicketEvent(db, normal.id, null, 'restricted', {}, now);
  return 'restricted';
}

/**
 * Open restricted tickets with nobody on their list, given to whoever can
 * take them now. A list empties when the only person on it is merged into
 * the accused, and starts empty when a report is filed about the only admin.
 * Called at the end of a merge and whenever an admin is created, so such a
 * ticket surfaces the moment there is somebody to show it to.
 */
export function reseedOrphanedTickets(
  db: DB, adminSteamIds: string[], exclude: string[] = [], now = new Date(),
): { seeded: number; stillEmpty: number } {
  const orphans = db.prepare(
    `SELECT t.id, t.target_id FROM tickets t WHERE t.restricted = 1 AND t.status = 'open'
       AND NOT EXISTS (SELECT 1 FROM ticket_access a WHERE a.ticket_id = t.id)`,
  ).all() as { id: number; target_id: string }[];
  let seeded = 0;
  for (const t of orphans) {
    seedAccess(db, t.id, t.target_id, adminSteamIds, [], now, exclude);
    if (db.prepare('SELECT 1 FROM ticket_access WHERE ticket_id = ?').get(t.id)) seeded++;
  }
  return { seeded, stillEmpty: orphans.length - seeded };
}
```

- [ ] **Step 4: The merge passes owners, folds through `foldTicket`, and reports after it commits**

`src/mergePlayers.ts`. Change the two imports at the top:

```ts
import { publishAdminEvent } from './adminFeed.js';
import { foldTicket, hasStaffFlag, reseedOrphanedTickets, restrictOpenTicketAbout, type RestrictOutcome } from './tickets/store.js';
```

Widen the options (locate by `opts: { from: string; into: string; dryRun?: boolean; by?: string }`):

```ts
export function mergePlayers(
  db: DB,
  opts: {
    from: string; into: string; dryRun?: boolean; by?: string;
    /** config.adminSteamIds: who a ticket that becomes restricted is given to. */
    adminSteamIds?: string[];
  },
): MergePlan {
```

Just above `db.transaction(() => {` add:

```ts
  const owners = opts.adminSteamIds ?? [];
  // `as`, not a type annotation: TypeScript does not see the assignment made
  // inside the transaction closure, and would narrow this to 'none' for good.
  let restrictOutcome = 'none' as RestrictOutcome;
  let orphaned = 0;
```

Inside the transaction, replace the body of the `for (const restricted of [0, 1])` loop after `if (!gone || !keep) continue;` (the six statements from `db.prepare('UPDATE ticket_reports SET ticket_id = ?` down to `db.prepare('DELETE FROM tickets WHERE id = ?').run(gone.id);`) with:

```ts
      foldTicket(db, gone.id, keep.id, 'merge');
```

Replace the comment and line `if (hasStaffFlag(db, into)) restrictOpenTicketAbout(db, into, []);` with:

```ts
    // Merging a player into a staff account makes an ordinary ticket a ticket
    // about staff. `from` is excluded from the seed: it still has a player
    // row here, and an access row naming it would be rewritten onto `into`
    // by the tidy-up below and then deleted as the accused's own.
    if (hasStaffFlag(db, into)) restrictOutcome = restrictOpenTicketAbout(db, into, owners, new Date(), [from]);
```

Directly after the three `ticket_access` tidy-up statements (the last is `db.prepare('DELETE FROM ticket_access WHERE steamid = ? AND ticket_id IN (SELECT id FROM tickets WHERE target_id = ?)').run(into, into);`) add:

```ts
    // The tidy-up can take the last person off a list. Fill it again now,
    // while it is still one transaction.
    orphaned = reseedOrphanedTickets(db, owners, [from]).stillEmpty;
```

Directly after the transaction's closing `})();` and before `// Outside the transaction above because it opens its own.` add:

```ts
  // After the commit: a subscriber posts to Discord. Neither line names the
  // player or the ticket, because every admin reads the feed and one of them
  // may be who the ticket is about.
  if (restrictOutcome === 'nobody') {
    publishAdminEvent({ kind: 'problem', text: 'A ticket about a player who is now staff could not be restricted: there is nobody else to give it to. Add another admin or set ADMIN_STEAMIDS, then restrict it from the ticket page.' });
  }
  if (orphaned > 0) {
    publishAdminEvent({ kind: 'problem', text: `${orphaned} restricted ticket${orphaned === 1 ? ' has' : 's have'} nobody on the access list after a merge. It is handed to the next admin that is created.` });
  }
```

`src/routes/admin.ts`, the merge route: add `adminSteamIds` to the call (locate by `from: t.steamid, into, dryRun: dryRun === true, by: t.adminId,`):

```ts
        from: t.steamid, into, dryRun: dryRun === true, by: t.adminId, adminSteamIds,
```

`scripts/merge-players.ts`, the real merge (locate by `const done = mergePlayers(db, { from, into });`):

```ts
const done = mergePlayers(db, { from, into, adminSteamIds: config.adminSteamIds });
```

- [ ] **Step 5: Promotion reports 'nobody', and a new admin picks up orphans**

`src/routes/admin.ts`. Add `reseedOrphanedTickets` and `type RestrictOutcome` to the import from `'../tickets/store.js'`. Replace the transaction and `logAdmin` line of the `/api/admin/players/:steamid/admin` route with:

```ts
    // `as`, not an annotation: the assignment inside the closure is invisible
    // to TypeScript's narrowing, which would pin this to 'none'.
    let outcome = 'none' as RestrictOutcome;
    db.transaction(() => {
      db.prepare('UPDATE players SET is_admin = ? WHERE steamid = ?').run(isAdmin ? 1 : 0, t.steamid);
      if (isAdmin) {
        outcome = restrictOpenTicketAbout(db, t.steamid, adminSteamIds);
        // A restricted ticket nobody could be given is given to the first
        // admin who could take it, which may be this one.
        reseedOrphanedTickets(db, adminSteamIds);
      }
    })();
    logAdmin(db, t.adminId, 'set_admin', t.steamid, { isAdmin });
    if (outcome === 'nobody') publishAdminEvent({ kind: 'problem', text: NOBODY_TO_RESTRICT });
```

and of the `/mod` route with:

```ts
    // `as`, not an annotation: the assignment inside the closure is invisible
    // to TypeScript's narrowing, which would pin this to 'none'.
    let outcome = 'none' as RestrictOutcome;
    db.transaction(() => {
      db.prepare('UPDATE players SET is_mod = ? WHERE steamid = ?').run(isMod ? 1 : 0, t.steamid);
      if (isMod) outcome = restrictOpenTicketAbout(db, t.steamid, adminSteamIds);
    })();
    logAdmin(db, t.adminId, 'set_mod', t.steamid, { isMod });
    if (outcome === 'nobody') publishAdminEvent({ kind: 'problem', text: NOBODY_TO_RESTRICT });
```

Above `export async function adminRoutes` add:

```ts
const NOBODY_TO_RESTRICT = 'A ticket about a player who is now staff could not be restricted: there is nobody else to give it to. Add another admin or set ADMIN_STEAMIDS, then restrict it from the ticket page.';
```

- [ ] **Step 6: Counts**

`src/tickets/views.ts`, after `listTickets`:

```ts
/** How many tickets sit behind each filter, for this viewer. Counted with
 *  the same VISIBLE clause as the list, so a count can never give away a
 *  restricted ticket the list would not show. */
export function ticketCounts(db: DB, viewer: string): { open: number; mine: number; closed: number } {
  return db.prepare(
    `SELECT COALESCE(SUM(t.status = 'open'), 0) AS open,
            COALESCE(SUM(t.status = 'open' AND t.claimed_by = @viewer), 0) AS mine,
            COALESCE(SUM(t.status = 'closed'), 0) AS closed
     FROM tickets t WHERE ${VISIBLE}`,
  ).get({ viewer }) as { open: number; mine: number; closed: number };
}
```

`src/routes/tickets.ts`: import `ticketCounts` beside `listTickets`, and change the list route's return to:

```ts
    return { tickets: listTickets(db, me, filter as TicketFilter), counts: ticketCounts(db, me) };
```

`web/src/api.ts`, above `export const modApi`:

```ts
export interface TicketCounts { open: number; mine: number; closed: number }
```

and change `modApi.tickets` to:

```ts
  tickets: (filter: 'open' | 'mine' | 'closed', signal?: AbortSignal) =>
    get<{ tickets: TicketSummary[]; counts: TicketCounts }>(`/api/mod/tickets?filter=${filter}`, signal),
```

`web/src/routes/admin/AdminTickets.tsx`: type the filter list and feed the counts to `Tabs`, which already renders a `count`:

```tsx
const FILTERS: { key: 'open' | 'mine' | 'closed'; label: string }[] = [
  { key: 'open', label: 'Open' }, { key: 'mine', label: 'Mine' }, { key: 'closed', label: 'Closed' },
];
```

```tsx
      <Tabs active={filter} onSelect={(k) => setFilter(k as typeof filter)}
        tabs={FILTERS.map((f) => ({ ...f, count: data?.counts[f.key] }))} />
```

`web/src/routes/admin/AdminTicket.tsx`, in `eventText`, above `default:`:

```tsx
    case 'folded': return `Ticket #${String(e.detail.from ?? '')} about the same player was folded into this one`;
```

- [ ] **Step 7: The web test**

`web/src/routes/tickets.test.tsx`: in `beforeEach` change the list mock to

```tsx
  mockMod.tickets.mockResolvedValue({ tickets: [summary], counts: { open: 3, mine: 1, closed: 12 } });
```

and add to `describe('the Tickets tab', ...)`:

```tsx
  it('shows a count on each filter', async () => {
    render(<Admin session={{ kind: 'active', me: mod }} />);
    await screen.findByText('Walls');
    expect(screen.getByRole('tab', { name: /Open/ }).textContent).toBe('Open3');
    expect(screen.getByRole('tab', { name: /Mine/ }).textContent).toBe('Mine1');
    expect(screen.getByRole('tab', { name: /Closed/ }).textContent).toBe('Closed12');
  });
```

- [ ] **Step 8: Run everything this touched**

Run: `npx vitest run tests/ticketLeftovers.test.ts tests/ticketMigrate.test.ts tests/ticketActions.test.ts tests/ticketRoutes.test.ts tests/mergePlayers.test.ts web/src/routes/tickets.test.tsx && npm run typecheck`
Expected: PASS, typecheck clean. `tests/ticketMigrate.test.ts` still passes unchanged: its "restricts an open ticket that the merge turns into a ticket about staff" case has an `ADMIN` who is neither account, so the seed is `[ADMIN]` as before.

- [ ] **Step 9: Commit**

```bash
git add tests/ticketLeftovers.test.ts src/tickets/store.ts src/tickets/views.ts src/mergePlayers.ts src/routes/admin.ts src/routes/tickets.ts scripts/merge-players.ts web/src/api.ts web/src/routes/admin/AdminTickets.tsx web/src/routes/admin/AdminTicket.tsx web/src/routes/tickets.test.tsx
git commit -m "Never leave a restricted ticket with nobody on it, keep audit rows through a fold, and count the ticket filters"
```

---

### Task 2: `ticket_threads`, the two channel settings, and the signal bus

Nothing here talks to Discord. It lays down what the reconciler reads: a table saying which Discord thread belongs to which ticket, two columns that make announcements and DMs happen exactly once, the two channel ids, and a bus the site uses to say "look at this ticket again" after it has committed.

**Files:**
- Create: `src/tickets/signals.ts`, `src/tickets/threads.ts`, `tests/ticketThreads.test.ts`
- Modify: `src/tickets/schema.ts` (append one table), `src/db.ts` (inside `openDb` around `ensureTicketSchema(db);`, and `DEFAULT_SETTINGS`), `src/settingsSchema.ts`, `src/tickets/store.ts` (`foldTicket`), `src/tickets/actions.ts`, `src/tickets/filing.ts`, `src/players.ts` (`linkDiscord`, `unlinkDiscord`), `src/routes/admin.ts` (the `/admin`, `/mod` and `/merge` routes), `src/mergePlayers.ts` (`PLAIN`)

**Interfaces:**
- Consumes: `foldTicket` from Task 1; `ensureColumn` in `src/db.ts` (private to that file, which is why the column additions live there).
- Produces:
  - Table `ticket_threads (id, ticket_id, kind, reporter_id, channel_id, thread_id UNIQUE, state, created_at, surface, card_message_id, card_hash, locked)`. `kind` is `staff` or `reporter` (phase 3). `state` is `open`, `ended` (locked and archived, no longer the ticket's thread), `folded` (belongs to a ticket that was folded into this one; waiting for the reconciler to retire it) or `deleted` (removed from Discord). `surface` is `forum` or `private`.
  - Columns `ticket_reports.announced_at TEXT`, `ticket_access.notified_at TEXT`.
  - Settings `discord_tickets_forum_id`, `discord_tickets_channel_id`, both `''`.
  - `src/tickets/signals.ts`: `type TicketSignal = { kind: 'ticket'; ticketId: number } | { kind: 'staff' }`, `publishTicketSignal(s: TicketSignal): void`, `subscribeTicketSignals(fn: (s: TicketSignal) => void): () => void`.
  - `src/tickets/threads.ts`: `type ThreadSurface = 'forum' | 'private'`, `interface ThreadRow`, `staffThread(db, ticketId): ThreadRow | undefined`, `threadByDiscordId(db, threadId): ThreadRow | undefined`, `insertThread(db, t): ThreadRow`, `setThreadState(db, id, state): void`, `setThreadCard(db, id, messageId, hash): void`, `setThreadLocked(db, id, locked): void`, `threadsInState(db, state, ticketId?): ThreadRow[]`, `forbiddenForumThreads(db, ticketId?): ThreadRow[]`.
  - Every successful ticket mutation and every filing publishes `{ kind: 'ticket', ticketId }` after its commit. A flag change, a merge, and a Discord link or unlink publish `{ kind: 'staff' }`.

- [ ] **Step 1: Write the failing test**

`tests/ticketThreads.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { openDb, type DB } from '../src/db.js';
import { loadConfig } from '../src/config.js';
import { buildServer } from '../src/server.js';
import { upsertPlayer, activatePlayer, linkDiscord, unlinkDiscord } from '../src/players.js';
import { getSetting } from '../src/settings.js';
import { ensureTicketSchema } from '../src/tickets/schema.js';
import { fileReport, openStaffTicket } from '../src/tickets/filing.js';
import { claimTicket, closeTicket } from '../src/tickets/actions.js';
import { foldTicket } from '../src/tickets/store.js';
import { forbiddenForumThreads, insertThread, staffThread, threadByDiscordId, threadsInState } from '../src/tickets/threads.js';
import { subscribeTicketSignals, type TicketSignal } from '../src/tickets/signals.js';
import { mergePlayers } from '../src/mergePlayers.js';
import { authedCookie, stubOrchestrator } from './helpers.js';

const IDS = Array.from({ length: 7 }, (_, i) => `7656119900000000${i}`);
const [R1, R2, ACCUSED, ALT, MOD, ADMIN, OWNER] = IDS;
const deps = { adminSteamIds: [OWNER] };
let db: DB;
let signals: TicketSignal[];
let off: () => void;

const seed = (d: DB) => {
  for (const id of IDS) {
    upsertPlayer(d, { steamid: id, name: `p${id.slice(-1)}`, avatar: null }, []);
    activatePlayer(d, id);
  }
  d.prepare('UPDATE players SET is_mod = 1 WHERE steamid = ?').run(MOD);
  d.prepare('UPDATE players SET is_admin = 1 WHERE steamid IN (?, ?)').run(ADMIN, OWNER);
};
const file = (reporter: string, targetId: string, category = 'griefing') =>
  (fileReport(db, reporter, { targetId, category, text: 'x' }, deps) as { ticketId: number }).ticketId;
const thread = (ticketId: number, threadId: string, surface: 'forum' | 'private' = 'forum') =>
  insertThread(db, { ticketId, kind: 'staff', surface, channelId: surface === 'forum' ? 'forum1' : 'chan1', threadId, cardMessageId: threadId, cardHash: 'h' });

beforeEach(() => {
  db = openDb(':memory:');
  seed(db);
  signals = [];
  off = subscribeTicketSignals((s) => signals.push(s));
});
afterEach(() => off());

describe('schema and settings', () => {
  it('is idempotent, keeps thread ids unique, and seeds both channel ids empty', () => {
    expect(() => ensureTicketSchema(db)).not.toThrow();
    const id = file(R1, ACCUSED);
    thread(id, '9001');
    expect(() => thread(id, '9001')).toThrow(/UNIQUE/);
    expect(getSetting(db, 'discord_tickets_forum_id')).toBe('');
    expect(getSetting(db, 'discord_tickets_channel_id')).toBe('');
    expect(threadByDiscordId(db, '9001')).toMatchObject({ ticket_id: id, kind: 'staff', surface: 'forum', state: 'open', locked: 0 });
  });

  it('marks every report that predates the column as already announced, and no later one', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pug-threads-'));
    try {
      const path = join(dir, 'pug.db');
      let fileDb = openDb(path);
      seed(fileDb);
      fileReport(fileDb, R1, { targetId: ACCUSED, category: 'afk', text: '' }, deps);
      fileDb.exec('ALTER TABLE ticket_reports DROP COLUMN announced_at');
      fileDb.close();

      fileDb = openDb(path);
      const old = fileDb.prepare('SELECT announced_at, created_at FROM ticket_reports').get() as { announced_at: string | null; created_at: string };
      expect(old.announced_at).toBe(old.created_at);
      fileReport(fileDb, R2, { targetId: ACCUSED, category: 'afk', text: '' }, deps);
      fileDb.close();

      fileDb = openDb(path);
      expect(fileDb.prepare('SELECT COUNT(*) AS n FROM ticket_reports WHERE announced_at IS NULL').get()).toEqual({ n: 1 });
      fileDb.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('signals', () => {
  it('says which ticket changed, after the commit, for normal and restricted tickets alike', () => {
    const a = file(R1, ACCUSED);
    const b = file(R1, ACCUSED, 'unsafe');
    expect(signals).toEqual([{ kind: 'ticket', ticketId: a }, { kind: 'ticket', ticketId: b }]);
    signals.length = 0;
    expect(claimTicket(db, a, MOD, true).ok).toBe(true);
    expect(claimTicket(db, b, MOD, true).ok).toBe(false);
    expect(closeTicket(db, a, MOD, 'warned', '').ok).toBe(true);
    const opened = openStaffTicket(db, MOD, { targetId: ALT, note: 'seen in voice' }, deps) as { auditId: number };
    expect(signals).toEqual([
      { kind: 'ticket', ticketId: a }, { kind: 'ticket', ticketId: a }, { kind: 'ticket', ticketId: opened.auditId },
    ]);
  });

  it('says the staff changed on a Discord link or unlink and on a merge', () => {
    expect(linkDiscord(db, MOD, '904', 'mod').ok).toBe(true);
    unlinkDiscord(db, MOD);
    mergePlayers(db, { from: ALT, into: ACCUSED, by: ADMIN, adminSteamIds: [OWNER] });
    expect(signals).toEqual([{ kind: 'staff' }, { kind: 'staff' }, { kind: 'staff' }]);
  });
});

describe('signals from the admin routes', () => {
  let app: FastifyInstance;
  afterEach(async () => { await app.close(); });

  it('a flag change says the staff changed', async () => {
    app = await buildServer({ config: loadConfig({ ADMIN_STEAMIDS: OWNER }), db, orchestrator: stubOrchestrator(), serverCleaner: async () => {}, serverExec: async () => {} });
    const cookies = authedCookie(app, db, OWNER);
    signals.length = 0;
    await app.inject({ method: 'POST', url: `/api/admin/players/${R1}/mod`, cookies, payload: { isMod: true } });
    await app.inject({ method: 'POST', url: `/api/admin/players/${R2}/admin`, cookies, payload: { isAdmin: true } });
    expect(signals).toEqual([{ kind: 'staff' }, { kind: 'staff' }]);
  });
});

describe('threads follow a fold', () => {
  it('the emptied ticket\'s thread is marked folded when the survivor has one of its own', () => {
    const keep = file(R1, ACCUSED);
    const gone = file(R2, ALT);
    thread(keep, '9001');
    thread(gone, '9002');
    db.transaction(() => foldTicket(db, gone, keep, 'merge'))();
    expect(staffThread(db, keep)?.thread_id).toBe('9001');
    expect(threadsInState(db, 'folded').map((t) => [t.ticket_id, t.thread_id])).toEqual([[keep, '9002']]);
    expect(db.pragma('foreign_key_check')).toEqual([]);
  });

  it('and simply becomes the survivor\'s thread when the survivor has none', () => {
    const keep = file(R1, ACCUSED);
    const gone = file(R2, ALT);
    thread(gone, '9002');
    db.transaction(() => foldTicket(db, gone, keep, 'merge'))();
    expect(staffThread(db, keep)?.thread_id).toBe('9002');
    expect(threadsInState(db, 'folded')).toEqual([]);
  });
});

describe('forum posts that must not exist', () => {
  it('lists the forum thread of a restricted ticket and of a ticket about staff, open or closed, and nothing else', () => {
    const normal = file(R1, ACCUSED);
    const aboutStaff = file(R1, ALT);
    // About someone else: tickets_one_open would refuse a second open
    // restricted ticket about ACCUSED once the normal one is restricted below.
    const restricted = file(R2, R1, 'unsafe');
    thread(normal, '9001');
    thread(aboutStaff, '9002');
    thread(restricted, '9003', 'private');
    expect(forbiddenForumThreads(db)).toEqual([]);
    // ALT is promoted after the post went up, and the ticket was closed.
    db.prepare("UPDATE tickets SET status = 'closed' WHERE id = ?").run(aboutStaff);
    db.prepare('UPDATE players SET is_mod = 1 WHERE steamid = ?').run(ALT);
    // The normal ticket is restricted by hand.
    db.prepare('UPDATE tickets SET restricted = 1 WHERE id = ?').run(normal);
    expect(forbiddenForumThreads(db).map((t) => t.thread_id).sort()).toEqual(['9001', '9002']);
    expect(forbiddenForumThreads(db, normal).map((t) => t.thread_id)).toEqual(['9001']);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run tests/ticketThreads.test.ts`
Expected: FAIL, cannot resolve `../src/tickets/threads.js`.

- [ ] **Step 3: The table**

`src/tickets/schema.ts`: append inside the `db.exec` template, after the `ticket_access` table:

```sql

    CREATE TABLE IF NOT EXISTS ticket_threads (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ticket_id INTEGER NOT NULL REFERENCES tickets(id),
      kind TEXT NOT NULL,
      reporter_id TEXT REFERENCES players(steamid),
      channel_id TEXT NOT NULL,
      thread_id TEXT NOT NULL UNIQUE,
      state TEXT NOT NULL DEFAULT 'open',
      created_at TEXT NOT NULL,
      surface TEXT NOT NULL,
      card_message_id TEXT,
      card_hash TEXT NOT NULL DEFAULT '',
      locked INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_ticket_threads_ticket ON ticket_threads (ticket_id);
```

and add to the comment above `ensureTicketSchema`:

```ts
 *
 * ticket_threads says which Discord thread belongs to which ticket. `surface`
 * is where it lives ('forum' for the staff forum, 'private' for a private
 * thread in the tickets channel) and is stored rather than worked out from
 * channel_id, so changing the forum setting cannot change what an old row
 * means. `locked` is what the bot last did in Discord, which is how the
 * reconciler knows a closed ticket's post still needs locking. `card_hash`
 * is written only after Discord accepted the edit it stands for.
```

`reporter_id` is a foreign key on purpose: `tests/mergePlayers.test.ts` checks every foreign key to `players` against `MERGE_HANDLED_PLAYER_COLUMNS`, so phase 3 cannot start writing it without the merge knowing. In `src/mergePlayers.ts` add to `PLAIN`, after `['tickets', 'closed_by'],`:

```ts
  ['ticket_threads', 'reporter_id'],
```

- [ ] **Step 4: The two columns and the two settings in `src/db.ts`**

Replace the two lines `ensureTicketSchema(db);` and `migrateLegacyReports(db);` in `openDb` with:

```ts
  ensureTicketSchema(db);
  // When a report was said in Discord: in its ticket's thread, or as a line
  // in the admin channel while no forum is set. NULL means "not yet", which
  // is what lets a report filed while the bot was down be announced when it
  // comes back. Every report older than the column is marked announced, or
  // the first start after this deploy would replay the whole history.
  const announcedIsNew = !(db.prepare('PRAGMA table_info(ticket_reports)').all() as { name: string }[])
    .some((c) => c.name === 'announced_at');
  ensureColumn(db, 'ticket_reports', 'announced_at', 'TEXT');
  // When this person was sent the DM saying they are on a restricted
  // ticket's access list. Charged before the send, so a refused DM is never
  // retried.
  ensureColumn(db, 'ticket_access', 'notified_at', 'TEXT');
  migrateLegacyReports(db);
  // After the migration, so reports it has just created are covered too.
  if (announcedIsNew) db.exec('UPDATE ticket_reports SET announced_at = created_at WHERE announced_at IS NULL');
```

In `DEFAULT_SETTINGS`, after `discord_results_channel_id: '',`:

```ts
  discord_tickets_forum_id: '',
  discord_tickets_channel_id: '',
```

`src/settingsSchema.ts`, after the `discord_results_channel_id` entry:

```ts
  { key: 'discord_tickets_forum_id', group: 'Discord', label: 'Tickets forum channel id', help: 'A forum channel hidden from everyone. The bot posts one thread per ticket and lets each linked moderator and admin in, one person at a time. Empty: tickets are worked on the site alone, and a new one is announced with a line in the admin channel.', type: { kind: 'string', maxLength: 32, allowEmpty: true } },
  { key: 'discord_tickets_channel_id', group: 'Discord', label: 'Tickets text channel id', help: 'A text channel everyone can see and nobody can post in. It only parents private threads: one per restricted ticket, whose members are that ticket\'s access list. Anyone with the Discord Administrator permission can still read them. Empty: restricted tickets get no Discord thread.', type: { kind: 'string', maxLength: 32, allowEmpty: true } },
```

- [ ] **Step 5: The bus**

`src/tickets/signals.ts`:

```ts
/**
 * "Look at this again", from the site to whatever keeps Discord in step with
 * it (TicketSync, when the bot is running).
 *
 * A process-wide bus for the reason adminFeed.ts and banEvents.ts are: the
 * publishers are ticket actions and admin routes that know nothing about
 * Discord, and a missing subscriber must cost nothing. Publishing never
 * throws, and is always done AFTER the transaction that made the change has
 * committed: the subscriber dials Discord.
 *
 * This is latency only. TicketSync also runs on a timer and works everything
 * out from the database, so a lost signal delays a thread by a few minutes
 * and loses nothing.
 *
 * A signal carries an id and nothing else, and never leaves the process, so
 * it is safe to publish for a restricted ticket.
 */
export type TicketSignal =
  // Something about this ticket changed: a report, a claim, a close, access.
  | { kind: 'ticket'; ticketId: number }
  // Who is staff, or who has Discord linked, changed: a flag, a merge, a link.
  | { kind: 'staff' };

type Listener = (s: TicketSignal) => void;
const listeners = new Set<Listener>();

export function publishTicketSignal(s: TicketSignal): void {
  for (const fn of listeners) {
    try {
      fn(s);
    } catch (err) {
      console.error('[tickets] signal listener failed:', err);
    }
  }
}

export function subscribeTicketSignals(fn: Listener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
```

- [ ] **Step 6: The thread queries**

`src/tickets/threads.ts`:

```ts
import type { DB } from '../db.js';

export type ThreadSurface = 'forum' | 'private';
export type ThreadState = 'open' | 'ended' | 'folded' | 'deleted';

export interface ThreadRow {
  id: number;
  ticket_id: number;
  kind: 'staff' | 'reporter';
  reporter_id: string | null;
  channel_id: string;
  thread_id: string;
  state: ThreadState;
  created_at: string;
  surface: ThreadSurface;
  card_message_id: string | null;
  card_hash: string;
  locked: number;
}

/** The ticket's current staff thread, if it has one. */
export function staffThread(db: DB, ticketId: number): ThreadRow | undefined {
  return db.prepare("SELECT * FROM ticket_threads WHERE ticket_id = ? AND kind = 'staff' AND state = 'open' ORDER BY id DESC LIMIT 1")
    .get(ticketId) as ThreadRow | undefined;
}

export function threadByDiscordId(db: DB, threadId: string): ThreadRow | undefined {
  return db.prepare('SELECT * FROM ticket_threads WHERE thread_id = ?').get(threadId) as ThreadRow | undefined;
}

export function insertThread(db: DB, t: {
  ticketId: number; kind: 'staff' | 'reporter'; surface: ThreadSurface; channelId: string; threadId: string;
  reporterId?: string | null; cardMessageId?: string | null; cardHash?: string;
}, now = new Date()): ThreadRow {
  db.prepare(
    `INSERT INTO ticket_threads (ticket_id, kind, reporter_id, channel_id, thread_id, created_at, surface, card_message_id, card_hash)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(t.ticketId, t.kind, t.reporterId ?? null, t.channelId, t.threadId, now.toISOString(), t.surface, t.cardMessageId ?? null, t.cardHash ?? '');
  return threadByDiscordId(db, t.threadId)!;
}

export function setThreadState(db: DB, id: number, state: ThreadState): void {
  db.prepare('UPDATE ticket_threads SET state = ? WHERE id = ?').run(state, id);
}

/** Only ever called after Discord accepted the message this hash stands for. */
export function setThreadCard(db: DB, id: number, messageId: string, hash: string): void {
  db.prepare('UPDATE ticket_threads SET card_message_id = ?, card_hash = ? WHERE id = ?').run(messageId, hash, id);
}

export function setThreadLocked(db: DB, id: number, locked: boolean): void {
  db.prepare('UPDATE ticket_threads SET locked = ? WHERE id = ?').run(locked ? 1 : 0, id);
}

export function threadsInState(db: DB, state: ThreadState, ticketId?: number): ThreadRow[] {
  return ticketId === undefined
    ? db.prepare('SELECT * FROM ticket_threads WHERE state = ? ORDER BY id').all(state) as ThreadRow[]
    : db.prepare('SELECT * FROM ticket_threads WHERE state = ? AND ticket_id = ? ORDER BY id').all(state, ticketId) as ThreadRow[];
}

/**
 * Forum threads that must not exist: the forum is readable by every
 * moderator and admin, so a thread there about a restricted ticket, or about
 * someone who now holds a staff flag, is readable by people who must not see
 * it, in the worst case by the accused. Open or closed makes no difference:
 * an archived post is still a post anyone in the forum can open.
 */
export function forbiddenForumThreads(db: DB, ticketId?: number): ThreadRow[] {
  const rows = db.prepare(
    `SELECT th.* FROM ticket_threads th
       JOIN tickets t ON t.id = th.ticket_id JOIN players p ON p.steamid = t.target_id
     WHERE th.surface = 'forum' AND th.state != 'deleted'
       AND (t.restricted = 1 OR p.is_admin = 1 OR p.is_mod = 1)
     ORDER BY th.id`,
  ).all() as ThreadRow[];
  return ticketId === undefined ? rows : rows.filter((r) => r.ticket_id === ticketId);
}
```

- [ ] **Step 7: Threads follow a fold**

`src/tickets/store.ts`, in `foldTicket`, directly above `db.prepare('DELETE FROM tickets WHERE id = ?').run(gone);`:

```ts
  // Discord threads follow the ticket. Where the survivor already has a staff
  // thread, the other is marked 'folded': TicketSync posts one line in the
  // survivor naming it, then locks and archives it. Where it has none, the
  // moved thread simply becomes the survivor's. A forum thread that lands on
  // a restricted ticket this way is deleted by the reconciler, whatever its
  // state: see forbiddenForumThreads.
  const keepHasThread = db.prepare("SELECT 1 FROM ticket_threads WHERE ticket_id = ? AND kind = 'staff' AND state = 'open'").get(keep) ? 1 : 0;
  db.prepare(
    `UPDATE ticket_threads SET ticket_id = ?,
       state = CASE WHEN kind = 'staff' AND state = 'open' AND ? = 1 THEN 'folded' ELSE state END
     WHERE ticket_id = ?`,
  ).run(keep, keepHasThread, gone);
```

- [ ] **Step 8: Publish the signals**

`src/tickets/actions.ts`: add `import { publishTicketSignal } from './signals.js';` and, below `const OK`:

```ts
/** Tell the Discord side, after the commit and only when something changed. */
const told = (id: number, r: ActionResult): ActionResult => {
  if (r.ok) publishTicketSignal({ kind: 'ticket', ticketId: id });
  return r;
};
```

Then wrap the success return of all six actions. In `claimTicket`, `addAccess`, `closeTicket` and `banFromTicket` change the final `return OK;` to `return told(id, OK);`. In `setRestricted` change `return guardUnique(() => db.transaction(() => {` to `return told(id, guardUnique(() => db.transaction(() => {` and close the extra parenthesis after the error string, so the statement ends `... about this player`));`. Do the same in `reopenTicket`, which ends `... work that one'));`. The early `if ((t.restricted === 1) === restricted) return OK;` in `setRestricted` stays as it is: nothing changed.

`src/tickets/filing.ts`: add the import below, and replace the tail of `fileReport` (from the comment `// After the commit, and only for a ticket the whole team may read.` to `return result;`). The admin event stays for now (Task 8 moves it into the reconciler); the signal goes beside it:

```ts
import { publishTicketSignal } from './signals.js';
```

```ts
  // After the commit. The signal goes out for a restricted ticket too: it
  // carries an id, stays in this process, and is how the private thread gets
  // made. The admin feed line does not.
  if (result.ok) publishTicketSignal({ kind: 'ticket', ticketId: result.ticketId });
  if (result.ok && !result.restricted) {
    publishAdminEvent({ kind: 'report', ticketId: result.ticketId, targetId: target.steamid, category, created: result.created });
  }
  return result;
```

In `openStaffTicket` change `return db.transaction(() => {` to `const opened = db.transaction(() => {` and after its closing `})();` add:

```ts
  publishTicketSignal({ kind: 'ticket', ticketId: opened.auditId });
  return opened;
```

`src/players.ts`: add `import { publishTicketSignal } from './tickets/signals.js';` (that module imports nothing, so there is no cycle). In `linkDiscord`, above `return { ok: true };`:

```ts
  // Forum access and private thread membership are keyed on the Discord id.
  publishTicketSignal({ kind: 'staff' });
```

and at the end of `unlinkDiscord`:

```ts
  publishTicketSignal({ kind: 'staff' });
```

Neither is called inside a transaction (check with `grep -rn "linkDiscord(\|unlinkDiscord(" src`: the callers are `src/routes/discordAuth.ts` and `src/routes/admin.ts`, all at route level).

`src/routes/admin.ts`: add `import { publishTicketSignal } from '../tickets/signals.js';`. In the `/admin` and `/mod` routes add, directly after the `logAdmin(...)` line:

```ts
    publishTicketSignal({ kind: 'staff' });
```

`src/mergePlayers.ts`: add `import { publishTicketSignal } from './tickets/signals.js';` and, directly after the two `publishAdminEvent` blocks Task 1 put after the transaction:

```ts
  // Tickets may have been folded or restricted, and a Discord link may have
  // moved: let the reconciler look at everything.
  publishTicketSignal({ kind: 'staff' });
```

- [ ] **Step 9: Run**

Run: `npx vitest run tests/ticketThreads.test.ts tests/ticketLeftovers.test.ts tests/ticketActions.test.ts tests/ticketFiling.test.ts tests/ticketSchema.test.ts tests/adminSettings.test.ts tests/mergePlayers.test.ts && npm run typecheck`
Expected: PASS, typecheck clean. `tests/adminSettings.test.ts` proves both new schema keys have a seeded default; `tests/mergePlayers.test.ts` proves `ticket_threads.reporter_id` is known to the merge.

- [ ] **Step 10: Commit**

```bash
git add src/tickets/signals.ts src/tickets/threads.ts src/tickets/schema.ts src/tickets/store.ts src/tickets/actions.ts src/tickets/filing.ts src/db.ts src/settingsSchema.ts src/players.ts src/routes/admin.ts src/mergePlayers.ts tests/ticketThreads.test.ts
git commit -m "Add ticket threads, the two tickets channel settings and the signal that a ticket changed"
```

---

### Task 3: `ThreadOps` and modals on the transport: the interface, the fake, and discord.js

The seam first, in all three places at once: the interface in `transport.ts`, the in-memory version every later test runs against, and the real one in `djsTransport.ts`. They go together because `djsTransport.ts` implements `BotTransport`, so the typecheck is red from the moment the interface grows until the real implementation exists.

The discord.js half has no automated test, by the file's own standing rule (it is "verified live rather than unit tested": discord.js is never imported in a test). Its gate is `npm run typecheck`, which checks every call below against the installed typings, plus the owner's manual checklist at the end of this plan. Every discord.js name used here was checked against `node_modules/discord.js/typings/index.d.ts` for the installed version, 14.27.0 (`package.json` asks for `^14.27.0`); the line is cited beside each. Locate by the quoted name if the numbers have moved.

**Files:**
- Create: `tests/fakeThreads.test.ts`
- Modify: `src/discord/transport.ts`, `tests/fakes/fakeTransport.ts`, `src/discord/index.ts` (`BotDeps`, the `onInteraction` handler), `src/discord/djsTransport.ts`, `tests/discordBot.test.ts` (one new case)

**Interfaces:**
- Consumes: `BotTransport`, `MessagePayload`, `BotInteraction`, `InteractionReply` from `src/discord/transport.ts`; `BotDeps.extraButtons` in `src/discord/index.ts`.
- Produces, in `src/discord/transport.ts`:

```ts
export type ModalField =
  | { kind: 'text'; id: string; label: string; style: 'short' | 'paragraph'; required?: boolean; maxLength?: number }
  | { kind: 'select'; id: string; label: string; options: { label: string; value: string }[] };
export interface ModalDef { customId: string; title: string; fields: ModalField[] }

// BotInteraction gains:
//   | { kind: 'modal'; customId: string; userId: string; userName: string; fields: Record<string, string> }
// InteractionReply gains:  modal?: ModalDef

export interface ThreadOps {
  createForumPost(forumId: string, post: { name: string; message: MessagePayload; tags: string[] }): Promise<{ threadId: string; messageId: string }>;
  createPrivateThread(channelId: string, thread: { name: string }): Promise<{ threadId: string }>;
  exists(threadId: string): Promise<boolean>;
  addMember(threadId: string, userId: string): Promise<void>;
  removeMember(threadId: string, userId: string): Promise<void>;
  memberIds(threadId: string): Promise<string[] | null>;
  setLocked(threadId: string, locked: boolean): Promise<void>;
  setArchived(threadId: string, archived: boolean): Promise<void>;
  setTags(threadId: string, tags: string[]): Promise<void>;
  deleteThread(threadId: string): Promise<void>;
  syncMemberAccess(channelId: string, userIds: string[]): Promise<{ added: string[]; removed: string[]; failed: string[] }>;
}

// BotTransport gains:  threads: ThreadOps;
// BotTransport.onInteraction becomes:
//   onInteraction(handler: (i: BotInteraction) => Promise<InteractionReply>, opts?: { opensModal?: (customId: string) => boolean }): void;
```

- Produces, in `src/discord/index.ts`: `BotDeps.extraModals?: Record<string, (i: Extract<BotInteraction, { kind: 'modal' }>) => Promise<InteractionReply>>` and `BotDeps.opensModal?: (customId: string) => boolean`.
- Produces, on `FakeTransport`: `threadsById: Map<string, FakeThread>`, `channelAccess: Map<string, Set<string>>`, `notInGuild: Set<string>`, `failThreadOps: number`, `opensModal`, and `threadsIn(parentId): FakeThread[]`.

Phase 2b adds `fetchAfter`, `fetchMessage`, the inbound message hook (`watchMessages`) and the message context menu command to this same seam, with their own fake and discord.js halves. Deleting a message needs nothing new: `BotTransport.remove(channelId, messageId)` already does it, and a thread id is a channel id. They are left out here so that this plan can ship without the Message Content intent.

- [ ] **Step 1: Write the failing test**

`tests/fakeThreads.test.ts`. A test of a fake is only worth having for the behaviour later tests lean on, so that is all this covers:

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { FakeTransport } from './fakes/fakeTransport.js';

const card = (content: string) => ({ content, embeds: [], components: [] });
let t: FakeTransport;
beforeEach(() => { t = new FakeTransport(); });

describe('FakeTransport threads', () => {
  it('a forum post starts with a message whose id is the thread id, and that message can be edited', async () => {
    const made = await t.threads.createForumPost('forum1', { name: '#1 Walls (cheating)', message: card('card v1'), tags: ['open', 'cheating'] });
    expect(made.messageId).toBe(made.threadId);
    expect(/^\d+$/.test(made.threadId)).toBe(true);
    expect(t.threadsIn('forum1').map((th) => [th.name, th.tags])).toEqual([['#1 Walls (cheating)', ['open', 'cheating']]]);
    expect(await t.edit(made.threadId, made.messageId, card('card v2'))).toBe(true);
    expect(t.byId(made.messageId)?.payload.content).toBe('card v2');
  });

  it('an archived thread refuses a send and an edit until it is unarchived', async () => {
    const { threadId } = await t.threads.createPrivateThread('chan1', { name: 'Ticket #2' });
    await t.threads.setLocked(threadId, true);
    await t.threads.setArchived(threadId, true);
    await expect(t.send(threadId, card('late'))).rejects.toThrow(/archived/i);
    await t.threads.setArchived(threadId, false);
    await expect(t.send(threadId, card('now'))).resolves.toBeTruthy();
    expect(t.threadsById.get(threadId)).toMatchObject({ locked: true, archived: false, surface: 'private' });
  });

  it('members are explicit, and someone outside the server cannot be added', async () => {
    const { threadId } = await t.threads.createPrivateThread('chan1', { name: 'Ticket #3' });
    t.notInGuild.add('999');
    await t.threads.addMember(threadId, '901');
    await expect(t.threads.addMember(threadId, '999')).rejects.toThrow();
    await t.threads.addMember(threadId, '902');
    await t.threads.removeMember(threadId, '901');
    expect(await t.threads.memberIds(threadId)).toEqual(['902']);
  });

  it('a deleted thread is gone for every question asked of it', async () => {
    const { threadId } = await t.threads.createPrivateThread('chan1', { name: 'Ticket #4' });
    expect(await t.threads.exists(threadId)).toBe(true);
    await t.threads.deleteThread(threadId);
    await t.threads.deleteThread(threadId);
    expect(await t.threads.exists(threadId)).toBe(false);
    expect(await t.threads.memberIds(threadId)).toBeNull();
    await expect(t.send(threadId, card('x'))).rejects.toThrow();
  });

  it('channel access converges on the wanted set and reports who could not be added', async () => {
    t.notInGuild.add('999');
    expect(await t.threads.syncMemberAccess('forum1', ['901', '902', '999'])).toEqual({ added: ['901', '902'], removed: [], failed: ['999'] });
    expect(await t.threads.syncMemberAccess('forum1', ['902', '903'])).toEqual({ added: ['903'], removed: ['901'], failed: [] });
    expect([...t.channelAccess.get('forum1')!].sort()).toEqual(['902', '903']);
  });

  it('failThreadOps makes the next thread calls throw, as an outage would', async () => {
    t.failThreadOps = 1;
    await expect(t.threads.createForumPost('forum1', { name: 'x', message: card('x'), tags: [] })).rejects.toThrow(/discord down/);
    await expect(t.threads.createForumPost('forum1', { name: 'x', message: card('x'), tags: [] })).resolves.toBeTruthy();
  });
});
```

And one case in `tests/discordBot.test.ts`, inside `describe('startBot extras', ...)`:

```ts
  it('routes a modal submit by prefix and tells the transport which buttons open a modal', async () => {
    const s = setup(ENV);
    const bot = await startBot({
      ...s, connect: async () => s.t,
      opensModal: (customId) => customId.endsWith(':close'),
      extraModals: { 't:': async (i) => ({ ephemeral: true, payload: { content: `closed with ${i.fields.outcome}`, embeds: [], components: [] } }) },
    });
    expect(s.t.opensModal?.('t:1:close')).toBe(true);
    expect(s.t.opensModal?.('t:1:claim')).toBe(false);
    const r = await s.t.handler!({ kind: 'modal', customId: 't:1:close', userId: '1', userName: 'x', fields: { outcome: 'warned' } });
    expect(r.payload.content).toBe('closed with warned');
    const stray = await s.t.handler!({ kind: 'modal', customId: 'zz:1', userId: '1', userName: 'x', fields: {} });
    expect(stray.ephemeral).toBe(true);
    await bot!.stop();
  });
```

- [ ] **Step 2: Run them and watch them fail**

Run: `npx vitest run tests/fakeThreads.test.ts tests/discordBot.test.ts`
Expected: FAIL. `t.threads` is undefined in the first file; `opensModal` is not a known property in the second.

- [ ] **Step 3: The interface**

`src/discord/transport.ts`. Replace the `BotInteraction` and `InteractionReply` declarations with:

```ts
/** One field of a modal. Discord allows five per modal. */
export type ModalField =
  | { kind: 'text'; id: string; label: string; style: 'short' | 'paragraph'; required?: boolean; maxLength?: number }
  | { kind: 'select'; id: string; label: string; options: { label: string; value: string }[] };

export interface ModalDef {
  customId: string;
  title: string;
  fields: ModalField[];
}

export type BotInteraction =
  | { kind: 'button'; customId: string; userId: string; userName: string }
  | {
      kind: 'command';
      name: string;
      userId: string;
      userName: string;
      /** String options by name. A user option carries the user id. */
      options: Record<string, string>;
    }
  /** A submitted modal. `fields` is each field's value by id; a select
   *  carries the one value picked. */
  | { kind: 'modal'; customId: string; userId: string; userName: string; fields: Record<string, string> };

export interface InteractionReply {
  ephemeral: boolean;
  payload: MessagePayload;
  /** Answer a button with a form instead of a message. Only honoured for a
   *  button the transport was told opens one (see onInteraction's opensModal):
   *  a modal has to be Discord's FIRST response to a press, and every other
   *  button is deferred before the handler runs. `payload` is what is said
   *  when the modal cannot be shown. */
  modal?: ModalDef;
}
```

Above `export interface BotTransport` add:

```ts
/**
 * Threads, for tickets. Ids are Discord snowflakes.
 *
 * Narrow on purpose, like RoleOps. A forum post is addressed by its thread
 * id; its first message (the case card) has the same id as the thread, which
 * is how Discord numbers forum posts, so `send` and `edit` with the thread id
 * as the channel reach the inside of a thread with no new method.
 *
 * Tags are passed by NAME. The implementation creates any the forum lacks and
 * translates: tag ids are per forum and the bot's logic should not hold them.
 */
export interface ThreadOps {
  createForumPost(
    forumId: string, post: { name: string; message: MessagePayload; tags: string[] },
  ): Promise<{ threadId: string; messageId: string }>;
  /** A private thread nobody can invite to. It starts with the bot alone. */
  createPrivateThread(channelId: string, thread: { name: string }): Promise<{ threadId: string }>;
  /** False once the thread has been deleted, by the bot or by hand. */
  exists(threadId: string): Promise<boolean>;
  /** Rejects for someone who is not in the server. */
  addMember(threadId: string, userId: string): Promise<void>;
  removeMember(threadId: string, userId: string): Promise<void>;
  /** Everyone in the thread but the bot; null when the thread is gone. */
  memberIds(threadId: string): Promise<string[] | null>;
  setLocked(threadId: string, locked: boolean): Promise<void>;
  /** An archived thread accepts no send and no edit until it is unarchived. */
  setArchived(threadId: string, archived: boolean): Promise<void>;
  setTags(threadId: string, tags: string[]): Promise<void>;
  /** Deleting a thread that is already gone is not an error. */
  deleteThread(threadId: string): Promise<void>;
  /**
   * Make the channel's per-member permission overwrites exactly this set:
   * view, read history, talk inside threads, attach files. Overwrites on one
   * channel and never a role, so a bug here cannot hand anyone anything
   * anywhere else. The bot's own overwrite and every role overwrite are left
   * alone. `failed` is who could not be added, which is ordinary: they have
   * left the server.
   */
  syncMemberAccess(channelId: string, userIds: string[]): Promise<{ added: string[]; removed: string[]; failed: string[] }>;
}
```

In `BotTransport`, replace the `onInteraction` line and add `threads`:

```ts
  onInteraction(
    handler: (i: BotInteraction) => Promise<InteractionReply>,
    /** `opensModal`: which buttons answer with a modal, asked BEFORE the
     *  handler runs. Such a button is not deferred, so its handler must be a
     *  quick database read. */
    opts?: { opensModal?: (customId: string) => boolean },
  ): void;
```

```ts
  threads: ThreadOps;
```

- [ ] **Step 4: The fake**

`tests/fakes/fakeTransport.ts`. Add `ThreadOps` to the type import. Add above the class:

```ts
export interface FakeThread {
  id: string;
  parentId: string;
  surface: 'forum' | 'private';
  name: string;
  tags: string[];
  members: Set<string>;
  locked: boolean;
  archived: boolean;
  deleted: boolean;
}
```

Inside the class, below `failEdits`:

```ts
  // Thread world.
  threadsById = new Map<string, FakeThread>();
  /** channelId -> the members holding a permission overwrite on it. */
  channelAccess = new Map<string, Set<string>>();
  /** User ids that are not in the server: adding them to a thread or to a
   *  channel's overwrites is refused, as Discord refuses it. */
  notInGuild = new Set<string>();
  /** Make the next N thread operations throw. */
  failThreadOps = 0;
  opensModal: ((customId: string) => boolean) | null = null;

  threadsIn(parentId: string): FakeThread[] {
    return [...this.threadsById.values()].filter((th) => th.parentId === parentId && !th.deleted);
  }

  /** What Discord says about writing into this channel, when it is a thread. */
  private guardThread(channelId: string): void {
    const th = this.threadsById.get(channelId);
    if (!th) return;
    if (th.deleted) throw new Error('Unknown Channel');
    if (th.archived) throw new Error('Thread is archived');
  }

  private threadOp(): void {
    if (this.failThreadOps > 0) { this.failThreadOps--; throw new Error('discord down'); }
  }

  private liveThread(threadId: string): FakeThread {
    const th = this.threadsById.get(threadId);
    if (!th || th.deleted) throw new Error('Unknown Channel');
    return th;
  }

  /** Snowflake-shaped on purpose: phase 2b orders messages by id. */
  private snowflake(): string {
    return String(100000 + ++this.seq);
  }

  threads: ThreadOps = {
    createForumPost: async (forumId, post) => {
      this.threadOp();
      const id = this.snowflake();
      this.threadsById.set(id, { id, parentId: forumId, surface: 'forum', name: post.name, tags: [...post.tags], members: new Set(), locked: false, archived: false, deleted: false });
      // Discord gives a forum post's first message the thread's own id.
      this.messages.push({ channelId: id, id, payload: post.message, deleted: false });
      return { threadId: id, messageId: id };
    },
    createPrivateThread: async (channelId, thread) => {
      this.threadOp();
      const id = this.snowflake();
      this.threadsById.set(id, { id, parentId: channelId, surface: 'private', name: thread.name, tags: [], members: new Set(), locked: false, archived: false, deleted: false });
      return { threadId: id };
    },
    exists: async (threadId) => {
      const th = this.threadsById.get(threadId);
      return !!th && !th.deleted;
    },
    addMember: async (threadId, userId) => {
      this.threadOp();
      if (this.notInGuild.has(userId)) throw new Error('Unknown Member');
      this.liveThread(threadId).members.add(userId);
    },
    removeMember: async (threadId, userId) => {
      this.threadOp();
      this.liveThread(threadId).members.delete(userId);
    },
    memberIds: async (threadId) => {
      const th = this.threadsById.get(threadId);
      return !th || th.deleted ? null : [...th.members];
    },
    setLocked: async (threadId, locked) => { this.threadOp(); this.liveThread(threadId).locked = locked; },
    setArchived: async (threadId, archived) => { this.threadOp(); this.liveThread(threadId).archived = archived; },
    setTags: async (threadId, tags) => { this.threadOp(); this.liveThread(threadId).tags = [...tags]; },
    deleteThread: async (threadId) => {
      this.threadOp();
      const th = this.threadsById.get(threadId);
      if (th) th.deleted = true;
    },
    syncMemberAccess: async (channelId, userIds) => {
      this.threadOp();
      const have = this.channelAccess.get(channelId) ?? new Set<string>();
      const want = new Set(userIds);
      const added: string[] = [];
      const failed: string[] = [];
      for (const id of want) {
        if (have.has(id)) continue;
        if (this.notInGuild.has(id)) failed.push(id);
        else { have.add(id); added.push(id); }
      }
      const removed = [...have].filter((id) => !want.has(id));
      for (const id of removed) have.delete(id);
      this.channelAccess.set(channelId, have);
      return { added, removed, failed };
    },
  };
```

Make `send` and `edit` respect a thread. `send` gains one line after the `failSends` check, and `edit` uses its channel id (rename the parameter from `_channelId` to `channelId`):

```ts
  async send(channelId: string, payload: MessagePayload): Promise<string> {
    if (this.failSends > 0) { this.failSends--; throw new Error('discord down'); }
    this.guardThread(channelId);
    const id = `m${++this.seq}`;
    this.sends++;
    this.messages.push({ channelId, id, payload, deleted: false });
    return id;
  }

  async edit(channelId: string, messageId: string, payload: MessagePayload): Promise<boolean> {
    if (this.failEdits > 0) { this.failEdits--; throw new Error('discord down'); }
    this.guardThread(channelId);
    const m = this.messages.find((x) => x.id === messageId && !x.deleted);
    if (!m) return false;
    this.edits++;
    m.payload = payload;
    return true;
  }
```

And `onInteraction` remembers the option:

```ts
  onInteraction(handler: (i: BotInteraction) => Promise<InteractionReply>, opts?: { opensModal?: (customId: string) => boolean }): void {
    this.handler = handler;
    this.opensModal = opts?.opensModal ?? null;
  }
```

- [ ] **Step 5: Route modals in `src/discord/index.ts`**

In `BotDeps`, below `extraButtons`:

```ts
  /** Modal submits outside the queue flow, by custom_id prefix, the same way. */
  extraModals?: Record<string, (i: Extract<BotInteraction, { kind: 'modal' }>) => Promise<InteractionReply>>;
  /** Which buttons answer with a modal. Handed to the transport, which has to
   *  know before it runs the handler: see BotTransport.onInteraction. */
  opensModal?: (customId: string) => boolean;
```

Replace the `transport.onInteraction(async (i) => { ... });` statement with:

```ts
  transport.onInteraction(async (i) => {
    if (i.kind === 'button') {
      const prefix = Object.keys(deps.extraButtons ?? {}).find((p) => i.customId.startsWith(p));
      if (prefix) return deps.extraButtons![prefix](i);
      return handleButton(controllerDeps, i);
    }
    if (i.kind === 'modal') {
      const prefix = Object.keys(deps.extraModals ?? {}).find((p) => i.customId.startsWith(p));
      if (prefix) return deps.extraModals![prefix](i);
      return { ephemeral: true, payload: { content: 'That form no longer does anything.', embeds: [], components: [] } };
    }
    if (deps.commands) return deps.commands.handle(i);
    return { ephemeral: true, payload: { content: 'Unknown command.', embeds: [], components: [] } };
  }, { opensModal: deps.opensModal });
```

- [ ] **Step 6: Run the two test files**

Run: `npx vitest run tests/fakeThreads.test.ts tests/discordBot.test.ts`
Expected: PASS. `npm run typecheck` is still red at this point: `createDjsTransport` does not return `threads` yet. The next step fixes that.

- [ ] **Step 7: discord.js: imports, modals, and the interaction handler**

`src/discord/djsTransport.ts`. Widen the two imports:

```ts
import {
  ApplicationCommandOptionType, ApplicationCommandType, ChannelType, Client, ComponentType, Events, GatewayIntentBits, MessageFlags,
  OverwriteType, PermissionFlagsBits, ThreadAutoArchiveDuration,
  type AnyThreadChannel, type ForumChannel, type Guild, type Interaction, type TextBasedChannel,
} from 'discord.js';
import type { DiscordConfig } from '../config.js';
import type {
  BotInteraction, BotTransport, Button, InteractionReply, MessagePayload, ModalDef, RoleOps, SlashCommandDef, ThreadOps, VoiceOps,
} from './transport.js';
```

Below `toMessage` add:

```ts
/**
 * A modal as raw API JSON, like toButton. Every field is wrapped in a Label
 * (component type 18), the only way a select can sit in a modal. A text input
 * inside a Label must NOT carry its own `label`: discord-api-types says so at
 * payloads/v10/message.d.ts:1463 ("Cannot be used in a label component").
 * Verified: LabelComponentData typings/index.d.ts:401, ModalComponentData
 * :2846, StringSelectMenuComponentData :7483, TextInputComponentData :7532.
 */
function toModal(m: ModalDef) {
  return {
    custom_id: m.customId,
    title: m.title.slice(0, 45),
    components: m.fields.map((f) => ({
      type: 18,
      label: f.label.slice(0, 45),
      component: f.kind === 'select'
        ? { type: 3, custom_id: f.id, required: true, options: f.options.map((o) => ({ label: o.label, value: o.value })) }
        : { type: 4, custom_id: f.id, style: f.style === 'paragraph' ? 2 : 1, required: f.required ?? false, max_length: f.maxLength },
    })),
  };
}
```

Add `const UNKNOWN_MEMBER = 10007;` beside `UNKNOWN_CHANNEL`.

Below `let handler: ... = null;` add:

```ts
  let opensModal: ((customId: string) => boolean) | null = null;
```

Inside the `InteractionCreate` listener, at the very top of the `if (i.isButton()) {` branch, before the comment that starts `// Every button reply is private`:

```ts
        if (opensModal?.(i.customId)) {
          // showModal has to be the first response to the press, so this one
          // button is not deferred (showModal: typings/index.d.ts:684). Its
          // handler is a database read and answers well inside three seconds.
          const reply = await handler({
            kind: 'button', customId: i.customId, userId: i.user.id, userName: i.user.globalName ?? i.user.username,
          });
          if (reply.modal) {
            await i.showModal(toModal(reply.modal) as never);
          } else {
            const m = toMessage(reply.payload);
            await i.reply({
              content: m.content || undefined, embeds: m.embeds, components: m.components as never,
              allowedMentions: m.allowedMentions, flags: MessageFlags.Ephemeral,
            });
          }
          return;
        }
```

After the closing brace of the `else if (i.isChatInputCommand()) { ... }` branch add a third branch:

```ts
      } else if (i.isModalSubmit()) {
        // isModalSubmit: typings/index.d.ts:2215. Deferred like a button: the
        // handler writes to the database and the reply is always private.
        await i.deferReply({ flags: MessageFlags.Ephemeral });
        const fields: Record<string, string> = {};
        // ModalSubmitFields.fields :2936, getStringSelectValues :2946.
        for (const [id, f] of i.fields.fields) {
          fields[id] = f.type === ComponentType.TextInput ? f.value
            : f.type === ComponentType.StringSelect ? (i.fields.getStringSelectValues(id)[0] ?? '') : '';
        }
        const reply = await handler({
          kind: 'modal', customId: i.customId, userId: i.user.id, userName: i.user.globalName ?? i.user.username, fields,
        });
        const m = toMessage(reply.payload);
        await i.editReply({ content: m.content || undefined, embeds: m.embeds, components: m.components as never, allowedMentions: m.allowedMentions });
      }
```

(The existing `}` that closed the `isChatInputCommand` branch becomes the `} else if` above; the `catch` that follows is unchanged and already answers a modal submit, because `isRepliable()` is true for one.)

Replace the returned `onInteraction` with:

```ts
    onInteraction(h, opts) {
      handler = h;
      opensModal = opts?.opensModal ?? null;
    },
```

- [ ] **Step 8: discord.js: `ThreadOps`**

Still in `createDjsTransport`, below the `roles` object and above `return {`:

```ts
  const threadById = async (id: string): Promise<AnyThreadChannel | null> => {
    // guild.channels holds threads too (GuildBasedChannel :7965, fetch :5040).
    // An archived thread is not cached, so this falls through to a fetch.
    const ch = await channelById(id);
    return ch && ch.isThread() ? ch : null;                                   // isThread :1108
  };
  const needThread = async (id: string): Promise<AnyThreadChannel> => {
    const th = await threadById(id);
    if (!th) throw new Error(`thread ${id} does not exist`);
    return th;
  };

  /** Tag names to this forum's tag ids, creating what is missing. Moderated,
   *  so only the bot (Manage Threads) can put them on a post. A post carries
   *  at most five. availableTags :3147, setAvailableTags :3155,
   *  GuildForumTagData :3122. */
  const tagIds = async (forum: ForumChannel, names: string[]): Promise<string[]> => {
    const missing = names.filter((n) => !forum.availableTags.some((t) => t.name === n));
    const current = missing.length === 0 ? forum
      : await forum.setAvailableTags([...forum.availableTags, ...missing.map((name) => ({ name, moderated: true }))]);
    return names.map((n) => current.availableTags.find((t) => t.name === n)?.id).filter((id): id is string => !!id).slice(0, 5);
  };

  const threads: ThreadOps = {
    async createForumPost(forumId, post) {
      const forum = await channelById(forumId);
      if (!forum || forum.type !== ChannelType.GuildForum) throw new Error(`channel ${forumId} is not a forum`);
      const m = toMessage(post.message);
      // GuildForumThreadManager.create :5406, GuildForumThreadCreateOptions
      // :7987 ({ name, message, appliedTags }), StartThreadOptions :7865.
      const thread = await forum.threads.create({
        name: post.name.slice(0, 100),
        autoArchiveDuration: ThreadAutoArchiveDuration.OneWeek,
        message: { content: m.content || undefined, embeds: m.embeds, components: m.components as never, allowedMentions: m.allowedMentions },
        appliedTags: await tagIds(forum, post.tags),
      });
      // A forum post's first message has the id of the thread itself.
      return { threadId: thread.id, messageId: thread.id };
    },
    async createPrivateThread(channelId, thread) {
      const ch = await channelById(channelId);
      if (!ch || ch.type !== ChannelType.GuildText) throw new Error(`channel ${channelId} is not a text channel`);
      // GuildTextThreadManager.create :5400, GuildTextThreadCreateOptions
      // :7981 ({ type, invitable }). invitable false: only the bot adds people.
      const made = await ch.threads.create({
        name: thread.name.slice(0, 100),
        type: ChannelType.PrivateThread,
        invitable: false,
        autoArchiveDuration: ThreadAutoArchiveDuration.OneWeek,
      });
      return { threadId: made.id };
    },
    async exists(threadId) {
      return (await threadById(threadId)) !== null;
    },
    async addMember(threadId, userId) {
      await (await needThread(threadId)).members.add(userId);                 // ThreadMemberManager.add :5416
    },
    async removeMember(threadId, userId) {
      try {
        await (await needThread(threadId)).members.remove(userId);            // ThreadMemberManager.remove :5435
      } catch (err) {
        if (codeOf(err) !== UNKNOWN_MEMBER) throw err;
      }
    },
    async memberIds(threadId) {
      const th = await threadById(threadId);
      if (!th) return null;
      const members = await th.members.fetch();                               // ThreadMemberManager.fetch :5431
      return [...members.keys()].filter((id) => id !== client.user!.id);
    },
    async setLocked(threadId, locked) {
      await (await needThread(threadId)).setLocked(locked);                   // ThreadChannel.setLocked :3980
    },
    async setArchived(threadId, archived) {
      await (await needThread(threadId)).setArchived(archived);               // ThreadChannel.setArchived :3977
    },
    async setTags(threadId, tags) {
      const th = await needThread(threadId);
      const forum = th.parent;
      if (!forum || forum.type !== ChannelType.GuildForum) return;
      await th.setAppliedTags(await tagIds(forum, tags));                     // ThreadChannel.setAppliedTags :3983
    },
    async deleteThread(threadId) {
      const th = await threadById(threadId);
      await th?.delete().catch((err: unknown) => {                            // ThreadChannel.delete :3966
        if (codeOf(err) !== UNKNOWN_CHANNEL) throw err;
      });
    },
    async syncMemberAccess(channelId, userIds) {
      const ch = await channelById(channelId);
      if (!ch || !('permissionOverwrites' in ch)) throw new Error(`channel ${channelId} cannot hold permission overwrites`);
      const me = client.user!.id;
      // Member overwrites only, and never the bot's own: the owner's role
      // overwrites (everyone denied, the bot's role allowed) are not ours.
      const have = [...ch.permissionOverwrites.cache.values()]                // permissionOverwrites :1827
        .filter((o) => o.type === OverwriteType.Member && o.id !== me).map((o) => o.id);
      const want = new Set(userIds);
      const added: string[] = [];
      const failed: string[] = [];
      for (const id of want) {
        if (have.includes(id)) continue;
        try {
          // An overwrite for someone who is not in the guild is rejected.
          await guild.members.fetch(id);
          await ch.permissionOverwrites.create(id, {                          // PermissionOverwriteManager.create :5320
            ViewChannel: true, ReadMessageHistory: true, SendMessagesInThreads: true,
            AttachFiles: true, EmbedLinks: true, AddReactions: true,
          });
          added.push(id);
        } catch (err) {
          console.error(`[discord] could not give ${id} access to ${channelId}:`, err);
          failed.push(id);
        }
      }
      const removed = have.filter((id) => !want.has(id));
      for (const id of removed) await ch.permissionOverwrites.delete(id);     // PermissionOverwriteManager.delete :5330
      return { added, removed, failed };
    },
  };
```

`forum.threads.create` is typed on `ForumChannel`; if the compiler does not narrow `forum` from `forum.type !== ChannelType.GuildForum`, narrow it with `const f = forum as ForumChannel;` after the check and use `f`. Do the same with `ch.threads` for the text channel (`import type { TextChannel }` and `const text = ch as TextChannel;`). Do not reach for `as never`: the point of this task's gate is that the typings check the call.

Add `threads,` to the returned object, beside `voice,`.

Staff are deliberately NOT given `SendMessages` on the forum: in a forum that permission is what creates a post, and posts are the bot's. `SendMessagesInThreads` is what lets them talk inside one.

- [ ] **Step 9: The gate**

Run: `npm run typecheck && npx vitest run tests/fakeThreads.test.ts tests/discordBot.test.ts tests/discordAdminFeed.test.ts tests/discordSync.test.ts tests/discordVoice.test.ts tests/discordController.test.ts`
Expected: typecheck clean, tests PASS. Every existing bot test still passes against the widened fake.

- [ ] **Step 10: Commit**

```bash
git add src/discord/transport.ts src/discord/index.ts src/discord/djsTransport.ts tests/fakes/fakeTransport.ts tests/fakeThreads.test.ts tests/discordBot.test.ts
git commit -m "Give the bot transport forum posts, private threads, channel access and modals"
```

---

### Task 4: The staff forum post: case card, tags, further reports, close and reopen

`TicketSync` is the reconciler. It never takes an instruction like "create a post"; it is told which ticket to look at, reads the database, and makes Discord match. That is what lets the same code serve a report filed a second ago, one filed while Discord was down, and a post somebody deleted by hand. This task builds it for normal tickets. Task 5 adds restricted ones, Task 6 adds forum access and wires it into the server.

**Files:**
- Create: `src/discord/ticketCard.ts`, `src/discord/ticketSync.ts`, `tests/ticketSync.test.ts`

**Interfaces:**
- Consumes: `ThreadOps`, `send`, `edit` on `BotTransport` (Task 3); `staffThread`, `insertThread`, `setThreadState`, `setThreadCard`, `setThreadLocked`, `ThreadRow`, `ThreadSurface` (Task 2); `subscribeTicketSignals` (Task 2); `getTicketRow`, `hasStaffFlag`, `TicketRow` from `src/tickets/store.ts`; `escapeName` from `src/discord/presenter.ts`; `TICKET_OUTCOMES` from `src/tickets/actions.ts`; `publishAdminEvent`.
- Produces:
  - `src/discord/ticketCard.ts`: `interface TicketCard { name: string; payload: MessagePayload; tags: string[]; hash: string }`, `ticketCard(db: DB, ticketId: number, publicUrl: string): TicketCard | null`, `reportLine(db: DB, reportId: number, publicUrl: string): MessagePayload`, `closeModal(ticketId: number): ModalDef`. Button custom ids: `t:<ticketId>:claim`, `t:<ticketId>:close`. The modal's custom id is `t:<ticketId>:close`, its fields are `outcome` and `note`.
  - `src/discord/ticketSync.ts`: `interface TicketSyncDeps { db: DB; transport: BotTransport; publicUrl: string; intervalMs?: number }`, `class TicketSync` with `start(): void`, `stop(): void`, `idle(): Promise<void>`, `reconcile(): Promise<void>` (never throws) and `reconcileTicket(id: number): Promise<void>` (throws what Discord throws).

Rules this task fixes in code:
- The post's title is `#<id> <name> (<categories>)`, or `#<id> <name> (opened by staff)`. It is set once and not renamed; later categories arrive as tags.
- Tags are the status (`open`, `claimed` or `closed`) and up to four categories. Discord allows five on a post.
- Nothing in Discord names a reporter or quotes a report. The card links to the ticket page, where that is one click away and behind `canSeeTicket`.
- `card_hash` is written only after Discord accepted the edit. A hash stored ahead of a failed edit is how match 82's card froze at "Setting up the server..." for good.

- [ ] **Step 1: Write the failing test**

`tests/ticketSync.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openDb, type DB } from '../src/db.js';
import { upsertPlayer, activatePlayer, linkDiscord } from '../src/players.js';
import { setSetting } from '../src/settings.js';
import { fileReport } from '../src/tickets/filing.js';
import { claimTicket, closeTicket, reopenTicket } from '../src/tickets/actions.js';
import { staffThread, threadsInState } from '../src/tickets/threads.js';
import { subscribeAdminEvents, type AdminEvent } from '../src/adminFeed.js';
import { TicketSync } from '../src/discord/ticketSync.js';
import { FakeTransport } from './fakes/fakeTransport.js';

const IDS = Array.from({ length: 8 }, (_, i) => `7656119900000000${i}`);
const MOD = IDS[6];
const ADMIN = IDS[7];
const deps = { adminSteamIds: [ADMIN] };
let db: DB;
let t: FakeTransport;
let sync: TicketSync;
let matchId: number;
let events: AdminEvent[];
let off: () => void;

beforeEach(() => {
  db = openDb(':memory:');
  IDS.forEach((id, i) => {
    upsertPlayer(db, { steamid: id, name: `player${i}`, avatar: null }, []);
    activatePlayer(db, id);
    linkDiscord(db, id, `90${i}`, `d${i}`);
  });
  db.prepare('UPDATE players SET is_mod = 1 WHERE steamid = ?').run(MOD);
  db.prepare('UPDATE players SET is_admin = 1 WHERE steamid = ?').run(ADMIN);
  setSetting(db, 'discord_tickets_forum_id', 'forum1');
  matchId = Number(db.prepare("INSERT INTO matches (season_id, state, campaign) VALUES (1, 'completed', 'dead_air')").run().lastInsertRowid);
  const ins = db.prepare('INSERT INTO match_players (match_id, player_id, team) VALUES (?, ?, ?)');
  IDS.forEach((id, i) => ins.run(matchId, id, i < 4 ? 'a' : 'b'));
  t = new FakeTransport();
  sync = new TicketSync({ db, transport: t, publicUrl: 'https://pug.test', intervalMs: 0 });
  events = [];
  off = subscribeAdminEvents((e) => events.push(e));
});
afterEach(() => { sync.stop(); off(); });

const file = (reporter: string, body: object) => (fileReport(db, reporter, body, deps) as { ticketId: number }).ticketId;
const cardOf = (threadId: string) => t.byId(threadId)!.payload;
const buttons = (threadId: string) => cardOf(threadId).components.flat().map((b) => (b.kind === 'button' ? `${b.customId}=${b.label}` : `link=${b.url}`));

describe('the staff forum post', () => {
  it('makes one post for a new ticket: titled, tagged, a case card, and nobody who reported it', async () => {
    sync.start();
    const id = file(IDS[0], { targetId: IDS[5], category: 'griefing', text: 'kept killing us', matchId, moment: { ordinal: 2, half: 1, tMs: 61500 } });
    await sync.idle();
    const posts = t.threadsIn('forum1');
    expect(posts).toHaveLength(1);
    expect(posts[0].name).toBe(`#${id} player5 (griefing)`);
    expect(posts[0].tags).toEqual(['open', 'griefing']);
    const row = staffThread(db, id)!;
    expect(row).toMatchObject({ thread_id: posts[0].id, surface: 'forum', channel_id: 'forum1', card_message_id: posts[0].id, locked: 0 });
    const text = JSON.stringify(cardOf(row.thread_id));
    expect(text).toContain(`https://pug.test/admin?ticket=${id}`);
    expect(text).toContain('player5');
    expect(text).toContain(`https://pug.test/match/${matchId}?ordinal=2&half=1&t=61500`);
    expect(text).not.toContain('player0');
    expect(text).not.toContain('kept killing us');
    expect(buttons(row.thread_id)).toEqual([`t:${id}:claim=Claim`, `t:${id}:close=Close`, `link=https://pug.test/admin?ticket=${id}`]);
    expect(db.prepare('SELECT COUNT(*) AS n FROM ticket_reports WHERE announced_at IS NULL').get()).toEqual({ n: 0 });
  });

  it('a further report posts one line in the thread, which bumps it, and refreshes the card and tags', async () => {
    sync.start();
    const id = file(IDS[0], { targetId: IDS[5], category: 'griefing', text: '' });
    await sync.idle();
    file(IDS[1], { targetId: IDS[5], category: 'cheating', text: 'walls', matchId });
    await sync.idle();
    const threadId = staffThread(db, id)!.thread_id;
    expect(t.threadsIn('forum1')).toHaveLength(1);
    const inThread = t.live().filter((m) => m.channelId === threadId);
    expect(inThread).toHaveLength(2);
    expect(JSON.stringify(inThread[1].payload)).toMatch(/another report/i);
    expect(JSON.stringify(inThread[1].payload)).toContain('cheating');
    expect(JSON.stringify(inThread[1].payload)).not.toContain('player1');
    expect(JSON.stringify(inThread[1].payload)).not.toContain('walls');
    expect(JSON.stringify(cardOf(threadId))).toContain('2 from 2 people');
    expect(t.threadsById.get(threadId)!.tags).toEqual(['open', 'griefing', 'cheating']);
  });

  it('attempts nothing at all while the forum is not configured', async () => {
    setSetting(db, 'discord_tickets_forum_id', '');
    sync.start();
    file(IDS[0], { targetId: IDS[5], category: 'griefing', text: '' });
    await sync.idle();
    expect(t.threadsById.size).toBe(0);
    expect(t.sends).toBe(0);
  });

  it('a ticket filed before the bot was up gets its post when it starts', async () => {
    const id = file(IDS[0], { targetId: IDS[5], category: 'afk', text: '' });
    sync.start();
    await sync.idle();
    expect(staffThread(db, id)).toBeTruthy();
  });

  it('a failure is reported once, and the next pass makes the post', async () => {
    sync.start();
    await sync.idle();
    t.failThreadOps = 1;
    const id = file(IDS[0], { targetId: IDS[5], category: 'afk', text: '' });
    await sync.idle();
    expect(staffThread(db, id)).toBeUndefined();
    const problems = events.filter((e) => e.kind === 'problem');
    expect(problems).toHaveLength(1);
    expect(JSON.stringify(problems[0])).not.toContain('player5');
    await sync.reconcile();
    expect(staffThread(db, id)).toBeTruthy();
    expect(db.prepare('SELECT COUNT(*) AS n FROM ticket_threads').get()).toEqual({ n: 1 });
  });

  it('a claim changes the card, the tag and the button', async () => {
    sync.start();
    const id = file(IDS[0], { targetId: IDS[5], category: 'afk', text: '' });
    await sync.idle();
    claimTicket(db, id, MOD, true);
    await sync.idle();
    const threadId = staffThread(db, id)!.thread_id;
    expect(t.threadsById.get(threadId)!.tags).toEqual(['claimed', 'afk']);
    expect(JSON.stringify(cardOf(threadId))).toContain('claimed by player6');
    expect(buttons(threadId)[0]).toBe(`t:${id}:claim=Release`);
  });

  it('a failed card edit is retried, never remembered as done', async () => {
    sync.start();
    const id = file(IDS[0], { targetId: IDS[5], category: 'afk', text: '' });
    await sync.idle();
    const before = staffThread(db, id)!.card_hash;
    t.failEdits = 1;
    claimTicket(db, id, MOD, true);
    await sync.idle();
    expect(staffThread(db, id)!.card_hash).toBe(before);
    await sync.reconcile();
    expect(staffThread(db, id)!.card_hash).not.toBe(before);
    expect(buttons(staffThread(db, id)!.thread_id)[0]).toBe(`t:${id}:claim=Release`);
  });

  it('closing refreshes the card and then locks and archives; reopening reverses it', async () => {
    sync.start();
    const id = file(IDS[0], { targetId: IDS[5], category: 'afk', text: '' });
    await sync.idle();
    const threadId = staffThread(db, id)!.thread_id;
    closeTicket(db, id, MOD, 'warned', 'first time');
    await sync.idle();
    expect(t.threadsById.get(threadId)).toMatchObject({ locked: true, archived: true, tags: ['closed', 'afk'] });
    expect(JSON.stringify(cardOf(threadId))).toContain('closed: warned');
    expect(JSON.stringify(cardOf(threadId))).not.toContain('first time');
    expect(buttons(threadId)).toEqual([`link=https://pug.test/admin?ticket=${id}`]);
    expect(staffThread(db, id)!.locked).toBe(1);
    // A closed and locked ticket costs nothing on later passes.
    const edits = t.edits;
    await sync.reconcile();
    expect(t.edits).toBe(edits);

    reopenTicket(db, id, MOD);
    await sync.idle();
    expect(t.threadsById.get(threadId)).toMatchObject({ locked: false, archived: false, tags: ['open', 'afk'] });
    expect(buttons(threadId)[0]).toBe(`t:${id}:claim=Claim`);
  });

  it('a post deleted by hand is made again', async () => {
    sync.start();
    const id = file(IDS[0], { targetId: IDS[5], category: 'afk', text: '' });
    await sync.idle();
    const first = staffThread(db, id)!.thread_id;
    await t.threads.deleteThread(first);
    await sync.reconcile();
    const second = staffThread(db, id)!.thread_id;
    expect(second).not.toBe(first);
    expect(threadsInState(db, 'deleted').map((r) => r.thread_id)).toEqual([first]);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run tests/ticketSync.test.ts`
Expected: FAIL, cannot resolve `../src/discord/ticketSync.js`.

- [ ] **Step 3: The card**

`src/discord/ticketCard.ts`:

```ts
import { createHash } from 'node:crypto';
import type { DB } from '../db.js';
import { getPlayer } from '../players.js';
import { getTicketRow } from '../tickets/store.js';
import { TICKET_OUTCOMES } from '../tickets/actions.js';
import { escapeName } from './presenter.js';
import type { ActionRow, EmbedField, MessagePayload, ModalDef } from './transport.js';

const COLOR = { open: 0xde4e40, claimed: 0xc9a45c, closed: 0x8a7f73 };
const OUTCOME_LABEL: Record<(typeof TICKET_OUTCOMES)[number], string> = {
  action_taken: 'Action taken', warned: 'Warned', no_action: 'No action', invalid: 'Invalid report',
};

export interface TicketCard {
  /** The thread's title. Used when the thread is made and never again. */
  name: string;
  payload: MessagePayload;
  /** Tag NAMES: the status, then up to four categories. */
  tags: string[];
  /** Of the payload and the tags: what decides whether Discord needs telling. */
  hash: string;
}

interface ReportBit { id: number; category: string; match_id: number | null; map_ordinal: number | null; half: number | null; t_ms: number | null }

const people = (n: number) => `${n} ${n === 1 ? 'person' : 'people'}`;

function matchLinks(r: ReportBit, publicUrl: string): string {
  const match = `[match #${r.match_id}](${publicUrl}/match/${r.match_id})`;
  if (r.map_ordinal === null || r.half === null || r.t_ms === null) return match;
  return `${match} · [replay moment](${publicUrl}/match/${r.match_id}?ordinal=${r.map_ordinal}&half=${r.half}&t=${r.t_ms})`;
}

/**
 * The case card: the first message of a ticket's staff thread.
 *
 * It names the accused and nobody else. Who reported, and what they wrote,
 * stay on the ticket page behind canSeeTicket; the card links there.
 */
export function ticketCard(db: DB, ticketId: number, publicUrl: string): TicketCard | null {
  const t = getTicketRow(db, ticketId);
  if (!t) return null;
  const reports = db.prepare(
    'SELECT id, category, match_id, map_ordinal, half, t_ms FROM ticket_reports WHERE ticket_id = ? ORDER BY id',
  ).all(ticketId) as ReportBit[];
  const reporters = (db.prepare('SELECT COUNT(DISTINCT reporter_id) AS n FROM ticket_reports WHERE ticket_id = ?').get(ticketId) as { n: number }).n;
  const categories = [...new Set(reports.map((r) => r.category))];
  const accused = getPlayer(db, t.target_id)?.name ?? t.target_id;
  const url = `${publicUrl}/admin?ticket=${t.id}`;
  const status = t.status === 'closed' ? 'closed' : t.claimed_by ? 'claimed' : 'open';
  const claimedBy = t.claimed_by ? escapeName(getPlayer(db, t.claimed_by)?.name ?? t.claimed_by) : '';

  const fields: EmbedField[] = [
    { name: 'Accused', value: `[${escapeName(accused)}](${publicUrl}/player/${t.target_id})`, inline: true },
    {
      name: 'Status', inline: true,
      value: status === 'closed' ? `closed: ${(t.outcome ?? '').replace(/_/g, ' ')}` : status === 'claimed' ? `claimed by ${claimedBy}` : 'open, unclaimed',
    },
    { name: 'Reports', value: reports.length === 0 ? 'None. Opened by staff.' : `${reports.length} from ${people(reporters)}: ${categories.join(', ')}` },
  ];
  const withMatch = reports.filter((r) => r.match_id !== null).slice(-5);
  if (withMatch.length > 0) fields.push({ name: 'Matches', value: withMatch.map((r) => matchLinks(r, publicUrl)).join('\n') });

  // Claim, [Contact reporter: phase 3 puts it here], Close, then the link.
  const row: ActionRow = t.status === 'open'
    ? [
      { kind: 'button', customId: `t:${t.id}:claim`, label: t.claimed_by ? 'Release' : 'Claim', style: t.claimed_by ? 'secondary' : 'primary' },
      { kind: 'button', customId: `t:${t.id}:close`, label: 'Close', style: 'danger' },
      { kind: 'link', url, label: 'Open on the site' },
    ]
    : [{ kind: 'link', url, label: 'Open on the site' }];

  const payload: MessagePayload = {
    embeds: [{
      title: `Ticket #${t.id}`,
      url,
      description: 'Who reported and what they wrote is on the ticket page. Bans are issued there too.',
      color: COLOR[status],
      fields,
      footer: t.restricted === 1
        ? 'Restricted. Anyone with the Discord Administrator permission can read this thread.'
        : undefined,
    }],
    components: [row],
    mentionUserIds: [],
  };
  const tags = [status, ...categories.slice(0, 4)];
  const what = categories.length > 0 ? categories.join(', ') : 'opened by staff';
  return {
    // A restricted thread's title says nothing: titles surface in places
    // (search, audit log, notifications) that the thread's content does not.
    name: (t.restricted === 1 ? `Ticket #${t.id}` : `#${t.id} ${accused} (${what})`).slice(0, 100),
    payload,
    tags,
    hash: createHash('sha1').update(JSON.stringify([payload, tags])).digest('hex'),
  };
}

/** The line a further report posts into the thread. The category and where to
 *  look, never who filed it or what they wrote. */
export function reportLine(db: DB, reportId: number, publicUrl: string): MessagePayload {
  const r = db.prepare(
    'SELECT id, category, match_id, map_ordinal, half, t_ms FROM ticket_reports WHERE id = ?',
  ).get(reportId) as ReportBit;
  const where = r.match_id === null ? '' : ` · ${matchLinks(r, publicUrl)}`;
  return {
    embeds: [{ description: `Another report: **${r.category}**${where}`, color: COLOR.open }],
    components: [],
    mentionUserIds: [],
  };
}

/** What the Close button opens. The outcome is a pick, the note is free. */
export function closeModal(ticketId: number): ModalDef {
  return {
    customId: `t:${ticketId}:close`,
    title: `Close ticket #${ticketId}`,
    fields: [
      { kind: 'select', id: 'outcome', label: 'Outcome', options: TICKET_OUTCOMES.map((o) => ({ label: OUTCOME_LABEL[o], value: o })) },
      { kind: 'text', id: 'note', label: 'Note (staff only)', style: 'paragraph', required: false, maxLength: 1000 },
    ],
  };
}
```

- [ ] **Step 4: The reconciler**

`src/discord/ticketSync.ts`:

```ts
import type { DB } from '../db.js';
import { publishAdminEvent } from '../adminFeed.js';
import { getSetting } from '../settings.js';
import { subscribeTicketSignals } from '../tickets/signals.js';
import { getTicketRow, hasStaffFlag, type TicketRow } from '../tickets/store.js';
import {
  insertThread, setThreadCard, setThreadLocked, setThreadState, staffThread, type ThreadRow, type ThreadSurface,
} from '../tickets/threads.js';
import { reportLine, ticketCard } from './ticketCard.js';
import type { BotTransport } from './transport.js';

/** The spec's figure: "A reconciler on bot ready and every five minutes". */
const RECONCILE_MS = 5 * 60_000;

export interface TicketSyncDeps {
  db: DB;
  transport: BotTransport;
  publicUrl: string;
  /** Milliseconds between full passes. 0 means no timer (tests). */
  intervalMs?: number;
}

/**
 * Keeps Discord in step with the tickets table.
 *
 * It is never told WHAT to do, only where to look: "ticket 12 changed". It
 * then reads the database and makes Discord match, which is what makes it
 * safe to call again, from a signal, from the timer, or after a restart. The
 * website never calls into it and never waits for it; a signal is published
 * after the commit and the work happens here, one ticket at a time, on a
 * chain of promises so Discord sees things in order (as AdminFeedPoster does).
 *
 * Signals are latency. The timer is correctness: whatever was missed while
 * the bot was down, or failed because Discord was, is made on the next pass.
 */
export class TicketSync {
  private chain: Promise<void> = Promise.resolve();
  private offs: (() => void)[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;
  /** Problems already told to the admin feed by this process. A permissions
   *  fault would otherwise post the same line every five minutes. */
  private reported = new Set<string>();

  constructor(private deps: TicketSyncDeps) {}

  start(): void {
    this.offs.push(subscribeTicketSignals((s) => {
      this.enqueue(() => (s.kind === 'ticket' ? this.one(s.ticketId) : this.reconcile()));
    }));
    const every = this.deps.intervalMs ?? RECONCILE_MS;
    if (every > 0) {
      this.timer = setInterval(() => this.enqueue(() => this.reconcile()), every);
      this.timer.unref();
    }
    // "On bot ready": this is constructed once the transport is connected.
    this.enqueue(() => this.reconcile());
  }

  stop(): void {
    for (const off of this.offs) off();
    this.offs = [];
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Resolves once everything asked for so far has been done (tests). */
  idle(): Promise<void> {
    return this.chain;
  }

  private enqueue(fn: () => Promise<void>): void {
    this.chain = this.chain.then(fn).catch((err) => console.error('[discord] ticket sync failed:', err));
  }

  private problem(text: string): void {
    if (this.reported.has(text)) return;
    this.reported.add(text);
    publishAdminEvent({ kind: 'problem', text });
  }

  /** One ticket, never throwing, so one broken ticket cannot starve the rest.
   *  The line for the admin feed names no ticket and no player: the ticket
   *  may be restricted, and every admin reads the feed. */
  private async one(id: number): Promise<void> {
    try {
      await this.reconcileTicket(id);
    } catch (err) {
      console.error(`[discord] syncing ticket ${id} failed:`, err);
      this.problem(`Could not update a ticket's Discord thread: ${err instanceof Error ? err.message : String(err)}. It is tried again every few minutes. If it keeps failing, check the bot's permissions on the tickets forum and the tickets channel.`);
    }
  }

  /** A full pass: every open ticket, and every closed one whose thread the
   *  bot has not locked yet. A closed and locked ticket costs nothing. */
  async reconcile(): Promise<void> {
    const ids = (this.deps.db.prepare(
      `SELECT id FROM tickets WHERE status = 'open'
       UNION
       SELECT th.ticket_id FROM ticket_threads th JOIN tickets t ON t.id = th.ticket_id
        WHERE th.kind = 'staff' AND th.state = 'open' AND th.locked = 0 AND t.status = 'closed'
       ORDER BY 1`,
    ).all() as { id: number }[]).map((r) => r.id);
    for (const id of ids) await this.one(id);
  }

  /** Where this ticket's staff thread belongs, or null for nowhere. */
  private surfaceFor(t: TicketRow): ThreadSurface | null {
    const { db } = this.deps;
    // Task 5 gives a restricted ticket its private thread.
    if (t.restricted === 1) return null;
    // A normal ticket about staff has no Discord thread at all: the forum is
    // readable by the accused, and with no access list there is nobody to put
    // in a private one. It is worked on the site.
    if (hasStaffFlag(db, t.target_id)) return null;
    return (getSetting(db, 'discord_tickets_forum_id') ?? '') ? 'forum' : null;
  }

  async reconcileTicket(id: number): Promise<void> {
    const { db, transport } = this.deps;
    const t = getTicketRow(db, id);
    if (!t) return;
    const surface = this.surfaceFor(t);
    let thread = staffThread(db, id);
    if (thread && !(await transport.threads.exists(thread.thread_id))) {
      // Deleted by hand in Discord. Remember that, and make another.
      setThreadState(db, thread.id, 'deleted');
      thread = undefined;
    }
    if (!thread && t.status === 'open' && surface) thread = await this.createThread(t, surface);
    if (!thread) return;
    // A reopened ticket is unarchived BEFORE anything is written into it:
    // Discord refuses a send or an edit in an archived thread.
    if (t.status === 'open') await this.syncLock(t, thread);
    if (thread.locked === 0) {
      await this.announceReports(t, thread);
      await this.refreshCard(t, thread);
    }
    // A closed ticket is locked AFTER its card said so, for the same reason.
    await this.syncLock(t, thread);
  }

  private async createThread(t: TicketRow, surface: ThreadSurface): Promise<ThreadRow> {
    const { db, transport, publicUrl } = this.deps;
    const card = ticketCard(db, t.id, publicUrl)!;
    const forumId = getSetting(db, 'discord_tickets_forum_id') ?? '';
    const made = await transport.threads.createForumPost(forumId, { name: card.name, message: card.payload, tags: card.tags });
    const row = insertThread(db, {
      ticketId: t.id, kind: 'staff', surface, channelId: forumId, threadId: made.threadId,
      cardMessageId: made.messageId, cardHash: card.hash,
    });
    // The card counts every report there is, so none of them needs a line.
    db.prepare('UPDATE ticket_reports SET announced_at = ? WHERE ticket_id = ? AND announced_at IS NULL')
      .run(new Date().toISOString(), t.id);
    return row;
  }

  /** One line per report the thread has not heard about, oldest first. Marked
   *  after the send, so a failed send is retried on the next pass. */
  private async announceReports(t: TicketRow, thread: ThreadRow): Promise<void> {
    const { db, transport, publicUrl } = this.deps;
    const rows = db.prepare('SELECT id FROM ticket_reports WHERE ticket_id = ? AND announced_at IS NULL ORDER BY id').all(t.id) as { id: number }[];
    for (const r of rows) {
      await transport.send(thread.thread_id, reportLine(db, r.id, publicUrl));
      db.prepare('UPDATE ticket_reports SET announced_at = ? WHERE id = ?').run(new Date().toISOString(), r.id);
    }
  }

  private async refreshCard(t: TicketRow, thread: ThreadRow): Promise<void> {
    const { db, transport, publicUrl } = this.deps;
    const card = ticketCard(db, t.id, publicUrl);
    if (!card || card.hash === thread.card_hash) return;
    let messageId = thread.card_message_id;
    const edited = messageId ? await transport.edit(thread.thread_id, messageId, card.payload) : false;
    // False means the card is gone (deleted by hand): say it again.
    if (!edited) messageId = await transport.send(thread.thread_id, card.payload);
    if (thread.surface === 'forum') await transport.threads.setTags(thread.thread_id, card.tags);
    // Only now. Everything above throws on failure, and a hash stored ahead
    // of a failed edit would make this method return early for ever after.
    setThreadCard(db, thread.id, messageId!, card.hash);
    thread.card_message_id = messageId;
    thread.card_hash = card.hash;
  }

  /** Closed means locked and archived; open means neither. `locked` on the
   *  row is what the bot last did, so this is a no-op on almost every pass. */
  private async syncLock(t: TicketRow, thread: ThreadRow): Promise<void> {
    const { db, transport } = this.deps;
    const want = t.status === 'closed';
    if ((thread.locked === 1) === want) return;
    if (want) {
      await transport.threads.setLocked(thread.thread_id, true);
      await transport.threads.setArchived(thread.thread_id, true);
    } else {
      await transport.threads.setArchived(thread.thread_id, false);
      await transport.threads.setLocked(thread.thread_id, false);
    }
    setThreadLocked(db, thread.id, want);
    thread.locked = want ? 1 : 0;
  }
}
```

- [ ] **Step 5: Run**

Run: `npx vitest run tests/ticketSync.test.ts && npm run typecheck`
Expected: PASS, typecheck clean.

- [ ] **Step 6: Commit**

```bash
git add src/discord/ticketCard.ts src/discord/ticketSync.ts tests/ticketSync.test.ts
git commit -m "Post a staff forum thread for each ticket and keep its card, tags and lock in step"
```

---

### Task 5: Restricted tickets: a private thread, the posts that must not exist, and folded threads

Three rules, all about who can read what in Discord:

1. **A restricted ticket has no forum post.** Its staff thread is a private thread in the tickets text channel whose members are exactly the ticket's access list, kept in step on every pass. Each person on the list gets one DM with the site link. A refused DM is dropped silently and never retried.
2. **A forum post that must not exist is deleted, not locked.** The forum is readable by every moderator and admin, so a post about a ticket that has since been restricted, or about a player who has since been made staff, is readable by people who must not see it, and in the second case by the accused. A locked and archived post is still readable, so it is deleted. Closed tickets are covered too. Task 6 withholds forum access from a member of staff until every post about them is gone, which is why this runs first in every pass.
3. **When two tickets are folded and both had a thread, the survivor keeps its own.** One line in it names the other thread, and the other is locked and archived. The spec did not settle this; it is the smallest thing that loses nothing. (A forum thread that a fold lands on a restricted ticket falls under rule 2 instead.)

What no code can fix, and what the card's footer and the ticket page both say in plain words: anyone with the Discord Administrator permission can read every thread in the server, private ones included.

**Files:**
- Create: `tests/ticketSyncRestricted.test.ts`
- Modify: `src/discord/ticketSync.ts`, `src/discord/ticketCard.ts` (one new function)

**Interfaces:**
- Consumes: `forbiddenForumThreads`, `threadsInState`, `setThreadState`, `setThreadLocked` (Task 2); `createPrivateThread`, `addMember`, `removeMember`, `memberIds`, `deleteThread` on `ThreadOps` and `dm` on `BotTransport` (Task 3); `ticket_access.notified_at` (Task 2).
- Produces: `accessDm(ticketId: number, publicUrl: string): MessagePayload` in `src/discord/ticketCard.ts`. `TicketSync` gains private methods only; its public surface is unchanged.

- [ ] **Step 1: Write the failing test**

`tests/ticketSyncRestricted.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openDb, type DB } from '../src/db.js';
import { upsertPlayer, activatePlayer, linkDiscord, unlinkDiscord } from '../src/players.js';
import { setSetting } from '../src/settings.js';
import { fileReport } from '../src/tickets/filing.js';
import { addAccess, closeTicket, setRestricted } from '../src/tickets/actions.js';
import { restrictOpenTicketAbout } from '../src/tickets/store.js';
import { publishTicketSignal } from '../src/tickets/signals.js';
import { staffThread, threadByDiscordId } from '../src/tickets/threads.js';
import { mergePlayers } from '../src/mergePlayers.js';
import { subscribeAdminEvents, type AdminEvent } from '../src/adminFeed.js';
import { TicketSync } from '../src/discord/ticketSync.js';
import { FakeTransport } from './fakes/fakeTransport.js';

const IDS = Array.from({ length: 8 }, (_, i) => `7656119900000000${i}`);
const MOD = IDS[6];
const ADMIN = IDS[7];
const deps = { adminSteamIds: [ADMIN] };
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
    linkDiscord(db, id, `90${i}`, `d${i}`);
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

const file = (reporter: string, targetId: string, category = 'griefing') =>
  (fileReport(db, reporter, { targetId, category, text: 'details' }, deps) as { ticketId: number }).ticketId;
const members = async (threadId: string) => ((await t.threads.memberIds(threadId)) ?? []).sort();

describe('a restricted ticket in Discord', () => {
  it('gets a private thread whose members are its access list, one DM each, and nothing in the forum', async () => {
    const id = file(IDS[0], IDS[5], 'unsafe');
    await sync.idle();
    expect(t.threadsIn('forum1')).toEqual([]);
    const [thread] = t.threadsIn('chan1');
    expect(thread).toMatchObject({ surface: 'private', name: `Ticket #${id}` });
    expect(await members(thread.id)).toEqual(['907']);
    const inThread = t.live().filter((m) => m.channelId === thread.id);
    expect(inThread).toHaveLength(1);
    expect(JSON.stringify(inThread[0].payload)).toContain('Discord Administrator permission');
    expect(staffThread(db, id)).toMatchObject({ surface: 'private', channel_id: 'chan1', card_message_id: inThread[0].id });
    expect(t.dms.map((d) => d.userId)).toEqual(['907']);
    expect(JSON.stringify(t.dms[0].payload)).toContain(`https://pug.test/admin?ticket=${id}`);
    expect(JSON.stringify(t.dms[0].payload)).not.toContain('player5');
    expect(events).toEqual([]);
  });

  it('giving access adds the person to the thread and DMs them, once', async () => {
    const id = file(IDS[0], IDS[5], 'unsafe');
    await sync.idle();
    expect(addAccess(db, id, ADMIN, MOD).ok).toBe(true);
    await sync.idle();
    expect(await members(staffThread(db, id)!.thread_id)).toEqual(['906', '907']);
    expect(t.dms.map((d) => d.userId)).toEqual(['907', '906']);
    await sync.reconcile();
    expect(t.dms).toHaveLength(2);
  });

  it('someone who is no longer on the list, or no longer linked, is taken out of the thread', async () => {
    const id = file(IDS[0], IDS[5], 'unsafe');
    addAccess(db, id, ADMIN, MOD);
    await sync.idle();
    const threadId = staffThread(db, id)!.thread_id;
    // A stranger added by hand in Discord goes too: the list is the membership.
    await t.threads.addMember(threadId, '555');
    unlinkDiscord(db, MOD);
    await sync.idle();
    expect(await members(threadId)).toEqual(['907']);
  });

  it('a refused DM is dropped silently and never sent again', async () => {
    t.dmsClosed.add('907');
    const id = file(IDS[0], IDS[5], 'unsafe');
    await sync.idle();
    expect(t.dms).toEqual([]);
    expect((db.prepare('SELECT notified_at FROM ticket_access WHERE ticket_id = ?').get(id) as { notified_at: string | null }).notified_at).not.toBeNull();
    t.dmsClosed.clear();
    await sync.reconcile();
    expect(t.dms).toEqual([]);
    expect(events).toEqual([]);
  });

  it('with no tickets channel there is no thread, and the access list is still told', async () => {
    setSetting(db, 'discord_tickets_channel_id', '');
    file(IDS[0], IDS[5], 'unsafe');
    await sync.idle();
    expect(t.threadsById.size).toBe(0);
    expect(t.dms.map((d) => d.userId)).toEqual(['907']);
  });
});

describe('forum posts that must not exist', () => {
  it('restricting by hand deletes the forum post and opens a private thread', async () => {
    const id = file(IDS[0], IDS[5]);
    await sync.idle();
    const post = staffThread(db, id)!.thread_id;
    expect(setRestricted(db, id, MOD, true, [ADMIN]).ok).toBe(true);
    await sync.idle();
    expect(t.threadsById.get(post)!.deleted).toBe(true);
    expect(threadByDiscordId(db, post)!.state).toBe('deleted');
    const now = staffThread(db, id)!;
    expect(now.surface).toBe('private');
    expect(await members(now.thread_id)).toEqual(['906', '907']);
  });

  it('lifting the restriction ends the private thread and posts to the forum', async () => {
    const id = file(IDS[0], IDS[5]);
    setRestricted(db, id, MOD, true, [ADMIN]);
    await sync.idle();
    const priv = staffThread(db, id)!.thread_id;
    expect(setRestricted(db, id, MOD, false, [ADMIN]).ok).toBe(true);
    await sync.idle();
    expect(t.threadsById.get(priv)).toMatchObject({ locked: true, archived: true, deleted: false });
    expect(threadByDiscordId(db, priv)!.state).toBe('ended');
    expect(staffThread(db, id)!.surface).toBe('forum');
    expect(t.threadsIn('forum1')).toHaveLength(1);
  });

  it('blanking a channel setting ends nothing: the thread that exists is kept', async () => {
    const id = file(IDS[0], IDS[5]);
    await sync.idle();
    const post = staffThread(db, id)!.thread_id;
    setSetting(db, 'discord_tickets_forum_id', '');
    await sync.reconcile();
    expect(threadByDiscordId(db, post)!.state).toBe('open');
    expect(t.threadsById.get(post)).toMatchObject({ locked: false, archived: false, deleted: false });
    expect(t.live().filter((m) => m.channelId === post)).toHaveLength(1);
  });

  it('making the accused staff deletes every forum post about them, closed tickets included', async () => {
    const closed = file(IDS[0], IDS[5]);
    await sync.idle();
    closeTicket(db, closed, MOD, 'no_action', '');
    await sync.idle();
    const open = file(IDS[0], IDS[5], 'cheating');
    await sync.idle();
    const posts = [staffThread(db, closed)!.thread_id, staffThread(db, open)!.thread_id];
    // What POST /api/admin/players/:id/mod does.
    db.transaction(() => {
      db.prepare('UPDATE players SET is_mod = 1 WHERE steamid = ?').run(IDS[5]);
      restrictOpenTicketAbout(db, IDS[5], [ADMIN]);
    })();
    publishTicketSignal({ kind: 'staff' });
    await sync.idle();
    expect(posts.map((p) => t.threadsById.get(p)!.deleted)).toEqual([true, true]);
    expect(t.threadsIn('forum1')).toEqual([]);
    expect(staffThread(db, open)!.surface).toBe('private');
    expect(staffThread(db, closed)).toBeUndefined();
  });

  it('a normal ticket about staff that could not be restricted has no Discord thread at all', async () => {
    // Nobody to give it to: the only admin is the accused.
    const id = file(IDS[0], IDS[5]);
    await sync.idle();
    const post = staffThread(db, id)!.thread_id;
    db.prepare('UPDATE players SET is_admin = 0 WHERE steamid = ?').run(ADMIN);
    db.transaction(() => {
      db.prepare('UPDATE players SET is_admin = 1 WHERE steamid = ?').run(IDS[5]);
      expect(restrictOpenTicketAbout(db, IDS[5], [])).toBe('nobody');
    })();
    publishTicketSignal({ kind: 'staff' });
    await sync.idle();
    expect(t.threadsById.get(post)!.deleted).toBe(true);
    expect(staffThread(db, id)).toBeUndefined();
    expect(t.threadsIn('forum1')).toEqual([]);
    expect(t.threadsIn('chan1')).toEqual([]);
  });
});

describe('two tickets folded into one', () => {
  it('the survivor keeps its post and says where the other was; the other is locked and archived', async () => {
    const keep = file(IDS[0], IDS[5]);
    const gone = file(IDS[1], IDS[4], 'cheating');
    await sync.idle();
    const keepThread = staffThread(db, keep)!.thread_id;
    const goneThread = staffThread(db, gone)!.thread_id;
    mergePlayers(db, { from: IDS[4], into: IDS[5], by: ADMIN, adminSteamIds: [ADMIN] });
    await sync.idle();
    expect(staffThread(db, keep)!.thread_id).toBe(keepThread);
    expect(threadByDiscordId(db, goneThread)).toMatchObject({ ticket_id: keep, state: 'ended', locked: 1 });
    expect(t.threadsById.get(goneThread)).toMatchObject({ locked: true, archived: true, deleted: false });
    const said = t.live().filter((m) => m.channelId === keepThread).map((m) => JSON.stringify(m.payload)).join('\n');
    expect(said).toContain(`<#${goneThread}>`);
    expect(JSON.stringify(t.byId(keepThread)!.payload)).toContain('2 from 2 people');
    await sync.reconcile();
    expect(t.live().filter((m) => m.channelId === keepThread && JSON.stringify(m.payload).includes(`<#${goneThread}>`))).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run tests/ticketSyncRestricted.test.ts`
Expected: FAIL. The first case finds no thread in `chan1`: `surfaceFor` still answers null for a restricted ticket.

- [ ] **Step 3: The DM**

`src/discord/ticketCard.ts`, at the end:

```ts
/** Sent once to each person on a restricted ticket's access list. It names
 *  nobody: the link does the telling, behind the site's own access check. */
export function accessDm(ticketId: number, publicUrl: string): MessagePayload {
  const url = `${publicUrl}/admin?ticket=${ticketId}`;
  return {
    content: [
      'You have been given access to a restricted ticket. Only the people on its access list can see it.',
      'Anyone with the Discord Administrator permission can read every thread on the Discord server, so if the ticket involves such a person, keep the discussion on the site.',
    ].join('\n'),
    embeds: [],
    components: [[{ kind: 'link', url, label: `Open ticket #${ticketId}` }]],
    mentionUserIds: [],
  };
}
```

- [ ] **Step 4: Teach `TicketSync` the three rules**

`src/discord/ticketSync.ts`. Widen two imports:

```ts
import {
  forbiddenForumThreads, insertThread, setThreadCard, setThreadLocked, setThreadState, staffThread, threadsInState,
  type ThreadRow, type ThreadSurface,
} from '../tickets/threads.js';
import { accessDm, reportLine, ticketCard } from './ticketCard.js';
```

Replace `reconcile`, `surfaceFor`, `reconcileTicket` and `createThread` with:

```ts
  /**
   * A full pass. The order is the point:
   *   1. delete forum posts that must not exist, BEFORE anything can widen
   *      who reads the forum (Task 6 runs the access sync after this);
   *   2. retire threads left behind by a fold;
   *   3. every open ticket, and every closed one not yet locked.
   */
  async reconcile(): Promise<void> {
    await this.step(() => this.removeForbiddenPosts());
    await this.step(() => this.retireFolded());
    const ids = (this.deps.db.prepare(
      `SELECT id FROM tickets WHERE status = 'open'
       UNION
       SELECT th.ticket_id FROM ticket_threads th JOIN tickets t ON t.id = th.ticket_id
        WHERE th.kind = 'staff' AND th.state = 'open' AND th.locked = 0 AND t.status = 'closed'
       ORDER BY 1`,
    ).all() as { id: number }[]).map((r) => r.id);
    for (const id of ids) await this.one(id);
  }

  /** One stage of a pass, never throwing, so a failure in it cannot stop the
   *  stages after it. */
  private async step(fn: () => Promise<void>): Promise<void> {
    try {
      await fn();
    } catch (err) {
      console.error('[discord] ticket sync step failed:', err);
      this.problem(`Could not tidy the ticket threads in Discord: ${err instanceof Error ? err.message : String(err)}. It is tried again every few minutes.`);
    }
  }

  /** Where this ticket's staff thread belongs, or null for nowhere. */
  private surfaceFor(t: TicketRow): ThreadSurface | null {
    const { db } = this.deps;
    if (t.restricted === 1) return (getSetting(db, 'discord_tickets_channel_id') ?? '') ? 'private' : null;
    // A normal ticket about staff has no Discord thread at all: the forum is
    // readable by the accused, and with no access list there is nobody to put
    // in a private one. It is worked on the site. This is the ticket that
    // restrictOpenTicketAbout answered 'nobody' for.
    if (hasStaffFlag(db, t.target_id)) return null;
    return (getSetting(db, 'discord_tickets_forum_id') ?? '') ? 'forum' : null;
  }

  async reconcileTicket(id: number): Promise<void> {
    const { db, transport } = this.deps;
    const t = getTicketRow(db, id);
    if (!t) return;
    await this.removeForbiddenPosts(id);
    await this.retireFolded(id);
    await this.notifyAccess(t);
    const surface = this.surfaceFor(t);
    let thread = staffThread(db, id);
    if (thread && !(await transport.threads.exists(thread.thread_id))) {
      // Deleted by hand in Discord. Remember that, and make another.
      setThreadState(db, thread.id, 'deleted');
      thread = undefined;
    }
    // Only a private thread can be on the wrong surface here: a forum thread
    // on a restricted ticket was deleted above. The restriction was lifted,
    // so the thread's members are no longer the audience. `surface &&`: a
    // null surface means a channel id was blanked in Settings, and a blanked
    // setting ends nothing. The thread that exists is simply kept up.
    if (thread && surface && thread.surface !== surface) {
      await this.endThread(thread, 'This ticket is no longer restricted. Its discussion continues in the staff forum.');
      thread = undefined;
    }
    if (!thread && t.status === 'open' && surface) thread = await this.createThread(t, surface);
    if (!thread) return;
    // A reopened ticket is unarchived BEFORE anything is written into it:
    // Discord refuses a send or an edit in an archived thread.
    if (t.status === 'open') await this.syncLock(t, thread);
    if (thread.locked === 0) {
      // Members before the card, so the card arrives as a new message for
      // the people it is meant for.
      if (thread.surface === 'private') await this.syncMembers(t, thread);
      await this.announceReports(t, thread);
      await this.refreshCard(t, thread);
    }
    // A closed ticket is locked AFTER its card said so, for the same reason.
    await this.syncLock(t, thread);
  }

  private async createThread(t: TicketRow, surface: ThreadSurface): Promise<ThreadRow> {
    const { db, transport, publicUrl } = this.deps;
    const card = ticketCard(db, t.id, publicUrl)!;
    let row: ThreadRow;
    if (surface === 'forum') {
      const forumId = getSetting(db, 'discord_tickets_forum_id') ?? '';
      const made = await transport.threads.createForumPost(forumId, { name: card.name, message: card.payload, tags: card.tags });
      row = insertThread(db, {
        ticketId: t.id, kind: 'staff', surface, channelId: forumId, threadId: made.threadId,
        cardMessageId: made.messageId, cardHash: card.hash,
      });
    } else {
      const channelId = getSetting(db, 'discord_tickets_channel_id') ?? '';
      const made = await transport.threads.createPrivateThread(channelId, { name: card.name });
      // The row goes in with no card: refreshCard sends it, after the members
      // are in. If that send fails, the next pass finds this row and sends
      // the card then, instead of making a second thread.
      row = insertThread(db, { ticketId: t.id, kind: 'staff', surface, channelId, threadId: made.threadId });
    }
    // The card counts every report there is, so none of them needs a line.
    db.prepare('UPDATE ticket_reports SET announced_at = ? WHERE ticket_id = ? AND announced_at IS NULL')
      .run(new Date().toISOString(), t.id);
    return row;
  }
```

Add these methods to the class:

```ts
  /** Rule 2. Marked 'deleted' only after Discord deleted it, so a failure is
   *  retried, and Task 6 keeps the accused out of the forum until it works. */
  private async removeForbiddenPosts(ticketId?: number): Promise<void> {
    const { db, transport } = this.deps;
    for (const th of forbiddenForumThreads(db, ticketId)) {
      await transport.threads.deleteThread(th.thread_id);
      setThreadState(db, th.id, 'deleted');
    }
  }

  /** Rule 3. foldTicket marked these; say where the other discussion was,
   *  then lock and archive it. */
  private async retireFolded(ticketId?: number): Promise<void> {
    const { db, transport } = this.deps;
    for (const th of threadsInState(db, 'folded', ticketId)) {
      const survivor = staffThread(db, th.ticket_id);
      if (survivor && survivor.locked === 0) {
        await transport.send(survivor.thread_id, {
          embeds: [{ description: `Another ticket about this player was folded into this one. Its discussion was in <#${th.thread_id}>, which is now locked.` }],
          components: [], mentionUserIds: [],
        });
      }
      await this.endThread(th, null);
    }
  }

  /** Lock and archive a thread that is no longer the ticket's, saying why
   *  first when there is something to say. */
  private async endThread(th: ThreadRow, farewell: string | null): Promise<void> {
    const { db, transport } = this.deps;
    if (await transport.threads.exists(th.thread_id)) {
      // Unarchive first: Discord may have auto-archived it after a quiet
      // week, and an archived thread takes no message and no lock.
      await transport.threads.setArchived(th.thread_id, false);
      if (farewell) await transport.send(th.thread_id, { embeds: [{ description: farewell }], components: [], mentionUserIds: [] });
      await transport.threads.setLocked(th.thread_id, true);
      await transport.threads.setArchived(th.thread_id, true);
    }
    setThreadState(db, th.id, 'ended');
    setThreadLocked(db, th.id, true);
  }

  /** Rule 1: the thread's members are the access list, no more and no fewer.
   *  Someone on the list with no Discord linked simply is not in the thread;
   *  the next pass after they link adds them. */
  private async syncMembers(t: TicketRow, thread: ThreadRow): Promise<void> {
    const { db, transport } = this.deps;
    const have = await transport.threads.memberIds(thread.thread_id);
    if (have === null) return;
    const want = (db.prepare(
      `SELECT p.discord_id FROM ticket_access a JOIN players p ON p.steamid = a.steamid
       WHERE a.ticket_id = ? AND p.discord_id IS NOT NULL`,
    ).all(t.id) as { discord_id: string }[]).map((r) => r.discord_id);
    for (const id of want) {
      if (have.includes(id)) continue;
      try {
        await transport.threads.addMember(thread.thread_id, id);
      } catch (err) {
        // Ordinary: they have left the server. They still have the site.
        console.warn('[discord] could not add someone to a restricted ticket thread:', err instanceof Error ? err.message : err);
      }
    }
    for (const id of have) {
      if (!want.includes(id)) await transport.threads.removeMember(thread.thread_id, id);
    }
  }

  /** One DM per person per ticket, with the site link. Charged before the
   *  send, as signonDropNotify charges its hour: a DM Discord refuses (closed
   *  DMs, left the server) is dropped silently and never tried again. Sent
   *  whether or not a tickets channel is set: the link is to the site. */
  private async notifyAccess(t: TicketRow): Promise<void> {
    if (t.restricted !== 1 || t.status !== 'open') return;
    const { db, transport, publicUrl } = this.deps;
    const rows = db.prepare(
      `SELECT a.steamid, p.discord_id FROM ticket_access a JOIN players p ON p.steamid = a.steamid
       WHERE a.ticket_id = ? AND a.notified_at IS NULL AND p.discord_id IS NOT NULL`,
    ).all(t.id) as { steamid: string; discord_id: string }[];
    for (const r of rows) {
      db.prepare('UPDATE ticket_access SET notified_at = ? WHERE ticket_id = ? AND steamid = ?')
        .run(new Date().toISOString(), t.id, r.steamid);
      try {
        await transport.dm(r.discord_id, accessDm(t.id, publicUrl));
      } catch { /* refused: dropped, like every other DM this bot sends */ }
    }
  }
```

The DM goes through the transport this object already holds, not through a `dm: () => DmFn | null` getter as `SignonDropNotifier` does. The getter exists there because that object is built before the bot connects and outlives it; `TicketSync` is built in `onConnected` and stopped with the bot, so "the bot is not running" is simply "there is no `TicketSync`", and the rows wait with `notified_at` NULL.

- [ ] **Step 5: Run**

Run: `npx vitest run tests/ticketSyncRestricted.test.ts tests/ticketSync.test.ts && npm run typecheck`
Expected: PASS, typecheck clean.

- [ ] **Step 6: Commit**

```bash
git add src/discord/ticketSync.ts src/discord/ticketCard.ts tests/ticketSyncRestricted.test.ts
git commit -m "Give restricted tickets a private thread, delete forum posts that must not exist, and retire folded threads"
```

---

### Task 6: Forum access, the server wiring, and a ticket page that says what is going on

The bot owns the forum's per-member permission overwrites: one per linked, active moderator or admin, and nobody else. It is access to one channel and never a role, so a bug here cannot hand anyone anything elsewhere. It is re-synced on bot ready, every five minutes, on a flag change, on a Discord link or unlink, on a merge (all the `staff` signal) and on a ban or unban.

One person is deliberately left out: a member of staff about whom a forum post still exists. Task 5 deletes such posts; until Discord has confirmed the deletion, they get no overwrite. The order inside a pass (delete first, grant last) makes this hold in the ordinary case, and the query makes it hold when the deletion fails.

This task also starts `TicketSync` with the bot, and makes the ticket page say in plain words whether there is a Discord discussion and why not when there is none.

**Files:**
- Create: `tests/ticketSyncAccess.test.ts`
- Modify: `src/tickets/threads.ts` (`surfaceFor`, `forumAudience`), `src/discord/ticketSync.ts`, `src/tickets/views.ts` (`ticketDetail`), `src/routes/tickets.ts`, `src/server.ts`, `web/src/api.ts`, `web/src/routes/admin/AdminTicket.tsx`, `web/src/routes/tickets.test.tsx`, `tests/ticketRoutes.test.ts`

**Interfaces:**
- Consumes: `syncMemberAccess` on `ThreadOps` (Task 3); `subscribeBanChanges` from `src/banEvents.ts`; `TicketSync` (Tasks 4 and 5); `startBot`'s `onConnected` in `src/server.ts`.
- Produces:
  - `src/tickets/threads.ts`: `surfaceFor(db: DB, t: { restricted: number; target_id: string }): { surface: ThreadSurface | null; why: 'ok' | 'unconfigured' | 'about_staff' }` and `forumAudience(db: DB): string[]` (Discord ids).
  - `ticketDetail(db, id, viewer, opts?: { guildId?: string | null })` gains `discussion: { state: 'ready' | 'pending' | 'unconfigured' | 'about_staff' | 'none'; surface: 'forum' | 'private' | null; url: string | null }`.
  - `TicketRouteOpts.guildId: string | null`.
  - Web type `TicketDiscussion`, and `TicketDetail.discussion`.

- [ ] **Step 1: Write the failing tests**

`tests/ticketSyncAccess.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openDb, type DB } from '../src/db.js';
import { upsertPlayer, activatePlayer, linkDiscord, unlinkDiscord } from '../src/players.js';
import { setSetting } from '../src/settings.js';
import { fileReport } from '../src/tickets/filing.js';
import { publishTicketSignal } from '../src/tickets/signals.js';
import { publishBanChange } from '../src/banEvents.js';
import { staffThread } from '../src/tickets/threads.js';
import { ticketDetail } from '../src/tickets/views.js';
import { TicketSync } from '../src/discord/ticketSync.js';
import { FakeTransport } from './fakes/fakeTransport.js';

const IDS = Array.from({ length: 8 }, (_, i) => `7656119900000000${i}`);
const MOD = IDS[6];
const ADMIN = IDS[7];
let db: DB;
let t: FakeTransport;
let sync: TicketSync;

beforeEach(() => {
  db = openDb(':memory:');
  IDS.forEach((id, i) => {
    upsertPlayer(db, { steamid: id, name: `player${i}`, avatar: null }, []);
    activatePlayer(db, id);
    if (i !== 4) linkDiscord(db, id, `90${i}`, `d${i}`);
  });
  db.prepare('UPDATE players SET is_mod = 1 WHERE steamid IN (?, ?)').run(MOD, IDS[4]);
  db.prepare('UPDATE players SET is_admin = 1 WHERE steamid = ?').run(ADMIN);
  setSetting(db, 'discord_tickets_forum_id', 'forum1');
  t = new FakeTransport();
  sync = new TicketSync({ db, transport: t, publicUrl: 'https://pug.test', intervalMs: 0 });
});
afterEach(() => sync.stop());

const access = () => [...(t.channelAccess.get('forum1') ?? [])].sort();

describe('forum access', () => {
  it('on start: every linked, active moderator and admin, and nobody else', async () => {
    sync.start();
    await sync.idle();
    // IDS[4] is a moderator with no Discord linked.
    expect(access()).toEqual(['906', '907']);
  });

  it('follows a flag change, a link, an unlink and a ban', async () => {
    sync.start();
    await sync.idle();
    db.prepare('UPDATE players SET is_mod = 1 WHERE steamid = ?').run(IDS[1]);
    publishTicketSignal({ kind: 'staff' });
    linkDiscord(db, IDS[4], '904', 'd4');
    await sync.idle();
    expect(access()).toEqual(['901', '904', '906', '907']);
    unlinkDiscord(db, IDS[1]);
    db.prepare("UPDATE players SET status = 'banned' WHERE steamid = ?").run(MOD);
    publishBanChange({ kind: 'ban', steamid: MOD, reason: 'x' });
    await sync.idle();
    expect(access()).toEqual(['904', '907']);
  });

  it('keeps a new member of staff out until every post about them is really gone', async () => {
    sync.start();
    const id = (fileReport(db, IDS[0], { targetId: IDS[5], category: 'griefing', text: '' }, { adminSteamIds: [ADMIN] }) as { ticketId: number }).ticketId;
    await sync.idle();
    const post = staffThread(db, id)!.thread_id;
    db.prepare('UPDATE players SET is_mod = 1 WHERE steamid = ?').run(IDS[5]);
    // Discord refuses the deletion twice: once in the sweep, once for the ticket.
    t.failThreadOps = 2;
    publishTicketSignal({ kind: 'staff' });
    await sync.idle();
    expect(t.threadsById.get(post)!.deleted).toBe(false);
    expect(access()).not.toContain('905');
    await sync.reconcile();
    expect(t.threadsById.get(post)!.deleted).toBe(true);
    expect(access()).toContain('905');
  });

  it('touches nothing while the forum is not configured', async () => {
    setSetting(db, 'discord_tickets_forum_id', '');
    sync.start();
    await sync.idle();
    expect(t.channelAccess.size).toBe(0);
  });
});

describe('what the ticket page is told about the discussion', () => {
  const file = (targetId: string, category = 'griefing') =>
    (fileReport(db, IDS[0], { targetId, category, text: 'x' }, { adminSteamIds: [ADMIN] }) as { ticketId: number }).ticketId;

  it('ready with a link, pending, unconfigured, and about staff', async () => {
    const id = file(IDS[5]);
    expect(ticketDetail(db, id, MOD, { guildId: 'g1' })!.discussion).toEqual({ state: 'pending', surface: 'forum', url: null });
    sync.start();
    await sync.idle();
    const threadId = staffThread(db, id)!.thread_id;
    expect(ticketDetail(db, id, MOD, { guildId: 'g1' })!.discussion).toEqual({ state: 'ready', surface: 'forum', url: `https://discord.com/channels/g1/${threadId}` });
    expect(ticketDetail(db, id, MOD)!.discussion.url).toBeNull();

    const restricted = file(IDS[3], 'unsafe');
    expect(ticketDetail(db, restricted, ADMIN, { guildId: 'g1' })!.discussion).toEqual({ state: 'unconfigured', surface: null, url: null });

    setSetting(db, 'discord_tickets_forum_id', '');
    const other = file(IDS[2]);
    expect(ticketDetail(db, other, MOD)!.discussion.state).toBe('unconfigured');
  });
});
```

Add to `tests/ticketRoutes.test.ts`, inside `describe('working tickets over HTTP', ...)`:

```ts
  it('says the Discord discussion is not configured when it is not', async () => {
    const d = (await get(MOD, `/api/mod/tickets/${id}`)).json();
    expect(d.discussion).toEqual({ state: 'unconfigured', surface: null, url: null });
  });
```

Add to `web/src/routes/tickets.test.tsx`. First give the `detail` helper a default, beside `bans: [], access: [], accessCandidates: [],`:

```tsx
  discussion: { state: 'unconfigured', surface: null, url: null },
```

then, inside `describe('the Tickets tab', ...)`:

```tsx
  it('says when the Discord discussion is not configured, and links to it when it exists', async () => {
    history.replaceState(null, '', '/admin?ticket=12');
    const first = render(<Admin session={{ kind: 'active', me: mod }} />);
    await screen.findByText(/Discord discussion is not configured/);
    first.unmount();
    mockMod.ticket.mockResolvedValue(detail({ discussion: { state: 'ready', surface: 'forum', url: 'https://discord.com/channels/g1/555' } }));
    render(<Admin session={{ kind: 'active', me: mod }} />);
    const link = await screen.findByRole('link', { name: /staff thread in Discord/i }) as HTMLAnchorElement;
    expect(link.getAttribute('href')).toBe('https://discord.com/channels/g1/555');
  });
```

- [ ] **Step 2: Run them and watch them fail**

Run: `npx vitest run tests/ticketSyncAccess.test.ts tests/ticketRoutes.test.ts web/src/routes/tickets.test.tsx`
Expected: FAIL. `channelAccess` stays empty, and `discussion` is undefined on the detail.

- [ ] **Step 3: One rule for where a thread belongs, and who reads the forum**

`src/tickets/threads.ts`. Add the imports and two functions:

```ts
import { getSetting } from '../settings.js';
import { hasStaffFlag } from './store.js';
```

```ts
/**
 * Where a ticket's staff thread belongs, and why nowhere when it is nowhere.
 * One function, used by the reconciler to act and by the ticket page to
 * explain, so the two cannot disagree.
 */
export function surfaceFor(
  db: DB, t: { restricted: number; target_id: string },
): { surface: ThreadSurface | null; why: 'ok' | 'unconfigured' | 'about_staff' } {
  if (t.restricted === 1) {
    return (getSetting(db, 'discord_tickets_channel_id') ?? '') ? { surface: 'private', why: 'ok' } : { surface: null, why: 'unconfigured' };
  }
  // A normal ticket about staff has no Discord thread at all: the forum is
  // readable by the accused, and with no access list there is nobody to put
  // in a private one. This is the ticket restrictOpenTicketAbout answered
  // 'nobody' for. It is worked on the site.
  if (hasStaffFlag(db, t.target_id)) return { surface: null, why: 'about_staff' };
  return (getSetting(db, 'discord_tickets_forum_id') ?? '') ? { surface: 'forum', why: 'ok' } : { surface: null, why: 'unconfigured' };
}

/**
 * The Discord ids that may read the staff forum: linked, active moderators
 * and admins. Minus anyone a forum post is still about: forbiddenForumThreads
 * lists such posts for deletion, and until Discord has confirmed it (state
 * 'deleted') that person is kept out, so a failed deletion can never become
 * the accused reading their own case.
 */
export function forumAudience(db: DB): string[] {
  return (db.prepare(
    `SELECT p.discord_id FROM players p
     WHERE p.status = 'active' AND (p.is_admin = 1 OR p.is_mod = 1) AND p.discord_id IS NOT NULL
       AND NOT EXISTS (
         SELECT 1 FROM ticket_threads th JOIN tickets t ON t.id = th.ticket_id
         WHERE t.target_id = p.steamid AND th.surface = 'forum' AND th.state != 'deleted')
     ORDER BY p.discord_id`,
  ).all() as { discord_id: string }[]).map((r) => r.discord_id);
}
```

- [ ] **Step 4: The access sync in `TicketSync`**

`src/discord/ticketSync.ts`. Add `import { subscribeBanChanges } from '../banEvents.js';`, add `forumAudience` and `surfaceFor` to the import from `'../tickets/threads.js'`, and drop `hasStaffFlag` from the `'../tickets/store.js'` import.

Delete the private `surfaceFor` method, and in `reconcileTicket` replace `const surface = this.surfaceFor(t);` with:

```ts
    const { surface } = surfaceFor(db, t);
```

In `start()`, after the `subscribeTicketSignals` block:

```ts
    // A banned moderator stops being active staff at once, not in five minutes.
    this.offs.push(subscribeBanChanges(() => this.enqueue(() => this.step(() => this.syncAccess()))));
```

At the end of `reconcile()`, after the `for` loop:

```ts
    // Last, on purpose: by now every post that must not exist is gone, or
    // forumAudience is still leaving its subject out.
    await this.step(() => this.syncAccess());
```

And the method:

```ts
  /** The forum's member overwrites are exactly forumAudience. */
  private async syncAccess(): Promise<void> {
    const { db, transport } = this.deps;
    const forumId = getSetting(db, 'discord_tickets_forum_id') ?? '';
    if (!forumId) return;
    const r = await transport.threads.syncMemberAccess(forumId, forumAudience(db));
    if (r.added.length || r.removed.length || r.failed.length) {
      console.log(`[discord] tickets forum access: +${r.added.length} -${r.removed.length}, ${r.failed.length} not in the server`);
    }
  }
```

- [ ] **Step 5: `discussion` on the ticket detail**

`src/tickets/views.ts`. Add `import { staffThread, surfaceFor } from './threads.js';`. Change the signature:

```ts
export function ticketDetail(db: DB, id: number, viewer: string, opts: { guildId?: string | null } = {}) {
```

Above the `return {`, add:

```ts
  // What the page says about Discord. 'pending' is an open ticket whose
  // thread the bot has not made yet; a closed ticket that never had one
  // (every ticket migrated from the old reports) is simply 'none'.
  const thread = staffThread(db, id);
  const where = surfaceFor(db, row);
  const discussion = {
    state: thread ? 'ready' as const
      : where.why === 'unconfigured' ? 'unconfigured' as const
        : where.why === 'about_staff' ? 'about_staff' as const
          : row.status === 'open' ? 'pending' as const : 'none' as const,
    surface: thread?.surface ?? where.surface,
    url: thread && opts.guildId ? `https://discord.com/channels/${opts.guildId}/${thread.thread_id}` : null,
  };
```

and add `discussion,` to the returned object, after `accessCandidates,`.

`src/routes/tickets.ts`: add to `TicketRouteOpts`

```ts
  /** The Discord server, for links to threads. Null when Discord is not configured. */
  guildId: string | null;
```

destructure it (`const { db, matchmaker, broadcast, adminSteamIds, guildId } = opts;`) and pass it in the detail route:

```ts
    const d = ticketDetail(db, Number((req.params as { id: string }).id), me, { guildId });
```

`src/server.ts`, the `ticketRoutes` registration:

```ts
  await app.register(ticketRoutes, {
    db: deps.db, matchmaker, broadcast: (e) => hub.broadcast(e), adminSteamIds: deps.config.adminSteamIds,
    guildId: deps.config.discord?.guildId ?? null,
  });
```

- [ ] **Step 6: Start it with the bot**

`src/server.ts`. Add `import { TicketSync } from './discord/ticketSync.js';`. Beside `let adminFeed: AdminFeedPoster | null = null;`:

```ts
  let ticketSync: TicketSync | null = null;
```

In `startBot`'s `onConnected`, after `adminFeed.start();`:

```ts
        // After the feed: a problem found on the first pass has somewhere to go.
        ticketSync = new TicketSync({ db: deps.db, transport: t, publicUrl: deps.config.publicUrl });
        ticketSync.start();
```

In the `onClose` hook, before `adminFeed?.stop();`:

```ts
    ticketSync?.stop();
```

`DEV_MODE=1` keeps the bot off (`botEnabled`), so none of this runs in development or in any `buildServer` test.

- [ ] **Step 7: The page**

`web/src/api.ts`, above `export interface TicketDetail`:

```ts
export interface TicketDiscussion {
  state: 'ready' | 'pending' | 'unconfigured' | 'about_staff' | 'none';
  surface: 'forum' | 'private' | null;
  url: string | null;
}
```

and in `TicketDetail`, after `accessCandidates`:

```ts
  discussion: TicketDiscussion;
```

`web/src/routes/admin/AdminTicket.tsx`. Import the type (`import { modApi, type TicketDetail, type TicketDiscussion, type TicketEvent } from '../../api';`) and add above `export function AdminTicket`:

```tsx
/** What to say about Discord, in plain words, for each state. */
function Discussion({ d }: { d: TicketDiscussion }) {
  if (d.state === 'ready') {
    return (
      <p class="muted">
        The discussion is in Discord{d.surface === 'private' ? ', in a private thread' : ''}.{' '}
        {d.url ? <a href={d.url} target="_blank" rel="noreferrer">Open the staff thread in Discord</a> : null}
      </p>
    );
  }
  const text = d.state === 'unconfigured' ? 'Discord discussion is not configured. An admin can set the tickets forum and the tickets channel in Settings; until then this ticket is worked here.'
    : d.state === 'pending' ? 'The Discord thread for this ticket has not been made yet. The bot makes it within a few minutes of being online.'
      : d.state === 'about_staff' ? 'This ticket is about a member of staff and is not restricted, so it has no Discord thread. Work it here.'
        : 'This ticket has no Discord thread.';
  return <p class="muted">{text}</p>;
}
```

Replace the line `<p class="muted">The moderators' discussion will appear here once the Discord forum is connected.</p>` with:

```tsx
        <Discussion d={data.discussion} />
```

Replace the restricted notice's paragraph (locate by `Only the people listed here can see this ticket.`) with:

```tsx
          <p>Only the people listed here can see this ticket, and its Discord thread is private to the same people. Anyone with the Discord Administrator permission can read every channel and thread on the Discord server all the same, so if that includes the accused, keep the discussion here and out of Discord.</p>
```

- [ ] **Step 8: Run**

Run: `npx vitest run tests/ticketSyncAccess.test.ts tests/ticketSync.test.ts tests/ticketSyncRestricted.test.ts tests/ticketRoutes.test.ts web/src/routes/tickets.test.tsx && npm run typecheck`
Expected: PASS, typecheck clean.

- [ ] **Step 9: Commit**

```bash
git add src/tickets/threads.ts src/tickets/views.ts src/discord/ticketSync.ts src/routes/tickets.ts src/server.ts web/src/api.ts web/src/routes/admin/AdminTicket.tsx web/src/routes/tickets.test.tsx tests/ticketSyncAccess.test.ts tests/ticketRoutes.test.ts
git commit -m "Sync forum access from the staff flags, start the ticket reconciler with the bot, and say on the ticket page where the discussion is"
```

---

### Task 7: Claim, Release and Close from the staff post

The buttons on the case card. Each one re-checks the presser from scratch (a Discord account linked to an active moderator or admin who can see this ticket), runs the same function the site's route runs, and writes the same audit row with `via: 'discord'` added. A press by anyone else, and a press on a ticket the presser cannot see, get the same answer a missing ticket gets.

Bans are not here: they are issued on the site only, so the moderator cap lives in one place. Reopen is not here either: a closed post is locked and archived, and its card carries no buttons.

**Files:**
- Create: `src/discord/ticketButtons.ts`, `tests/ticketButtons.test.ts`
- Modify: `src/server.ts` (the `startBot` call), `src/discord/adminFeedPoster.ts` (`actionText`, the ticket cases), `src/discord/controller.ts` (the custom id comment only)

**Interfaces:**
- Consumes: `claimTicket`, `closeTicket` from `src/tickets/actions.ts`; `canSeeTicket`, `getTicketRow` from `src/tickets/store.ts`; `playerByDiscordId` from `src/players.ts`; `logAdmin(db, adminId, action, target, detail, { quiet })`; `closeModal` (Task 4); `BotDeps.extraButtons`, `extraModals`, `opensModal` (Task 3).
- Produces, in `src/discord/ticketButtons.ts`:
  - `interface TicketButtonDeps { db: DB; publicUrl: string }`
  - `opensTicketModal(customId: string): boolean`
  - `handleTicketButton(deps: TicketButtonDeps, i: Extract<BotInteraction, { kind: 'button' }>): Promise<InteractionReply>`
  - `handleTicketModal(deps: TicketButtonDeps, i: Extract<BotInteraction, { kind: 'modal' }>): Promise<InteractionReply>`
  - Custom ids handled: `t:<ticketId>:claim`, `t:<ticketId>:close` (button and modal). Phase 3 adds `t:<ticketId>:contact` and `t:<ticketId>:join` under the same prefix.

- [ ] **Step 1: Write the failing test**

`tests/ticketButtons.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openDb, type DB } from '../src/db.js';
import { upsertPlayer, activatePlayer, linkDiscord } from '../src/players.js';
import { setSetting } from '../src/settings.js';
import { fileReport } from '../src/tickets/filing.js';
import { subscribeAdminEvents, type AdminEvent } from '../src/adminFeed.js';
import { staffThread } from '../src/tickets/threads.js';
import { TicketSync } from '../src/discord/ticketSync.js';
import { handleTicketButton, handleTicketModal, opensTicketModal } from '../src/discord/ticketButtons.js';
import { FakeTransport } from './fakes/fakeTransport.js';

const IDS = Array.from({ length: 8 }, (_, i) => `7656119900000000${i}`);
const [R1, PLAYER, STAFF_ACCUSED, , ACCUSED, MOD2, MOD, ADMIN] = IDS;
const D = (steamid: string) => `90${IDS.indexOf(steamid)}`;
let db: DB;
let normal: number;
let restricted: number;
let aboutStaff: number;
let events: AdminEvent[];
let off: () => void;
const deps = () => ({ db, publicUrl: 'https://pug.test' });

const press = (steamid: string, customId: string, userId = D(steamid)) =>
  handleTicketButton(deps(), { kind: 'button', customId, userId, userName: 'x' });
const submit = (steamid: string, customId: string, fields: Record<string, string>) =>
  handleTicketModal(deps(), { kind: 'modal', customId, userId: D(steamid), userName: 'x', fields });
const row = (id: number) => db.prepare('SELECT status, outcome, outcome_note, claimed_by FROM tickets WHERE id = ?').get(id);
const audit = () => (db.prepare('SELECT admin_id, action, target, detail FROM admin_actions ORDER BY id').all() as { admin_id: string; action: string; target: string; detail: string }[])
  .map((a) => ({ ...a, detail: JSON.parse(a.detail) }));

beforeEach(() => {
  db = openDb(':memory:');
  IDS.forEach((id, i) => {
    upsertPlayer(db, { steamid: id, name: `player${i}`, avatar: null }, []);
    activatePlayer(db, id);
    linkDiscord(db, id, `90${i}`, `d${i}`);
  });
  db.prepare('UPDATE players SET is_mod = 1 WHERE steamid IN (?, ?, ?)').run(MOD, MOD2, STAFF_ACCUSED);
  db.prepare('UPDATE players SET is_admin = 1 WHERE steamid = ?').run(ADMIN);
  const file = (targetId: string, category: string) =>
    (fileReport(db, R1, { targetId, category, text: 'x' }, { adminSteamIds: [ADMIN] }) as { ticketId: number }).ticketId;
  normal = file(ACCUSED, 'griefing');
  restricted = file(ACCUSED, 'unsafe');
  aboutStaff = file(STAFF_ACCUSED, 'toxicity');
  events = [];
  off = subscribeAdminEvents((e) => events.push(e));
});
afterEach(() => off());

const content = (r: { payload: { content?: string } }) => r.payload.content ?? '';

describe('who may press', () => {
  it('refuses a player, an unlinked Discord account and a banned moderator, and changes nothing', async () => {
    db.prepare("UPDATE players SET status = 'banned' WHERE steamid = ?").run(MOD2);
    for (const r of [await press(PLAYER, `t:${normal}:claim`), await press(MOD, `t:${normal}:claim`, '555'), await press(MOD2, `t:${normal}:claim`)]) {
      expect(r.ephemeral).toBe(true);
      expect(content(r)).toBe('Staff only.');
    }
    expect(row(normal)).toMatchObject({ claimed_by: null });
    expect(audit()).toEqual([]);
  });

  it('answers a ticket you cannot see exactly as it answers one that does not exist', async () => {
    const missing = await press(MOD, 't:9999:claim');
    expect(content(await press(MOD, `t:${restricted}:claim`))).toBe(content(missing));
    expect(content(await press(STAFF_ACCUSED, `t:${aboutStaff}:claim`))).toBe(content(missing));
    expect(content(await submit(MOD, `t:${restricted}:close`, { outcome: 'warned', note: '' }))).toBe(content(missing));
    const closeBtn = await press(MOD, `t:${restricted}:close`);
    expect(closeBtn.modal).toBeUndefined();
    expect(content(closeBtn)).toBe(content(missing));
    expect(row(restricted)).toMatchObject({ status: 'open', claimed_by: null });
    expect(audit()).toEqual([]);
  });
});

describe('Claim and Release', () => {
  it('claims, audits it as coming from Discord, and releases on the next press', async () => {
    expect(content(await press(MOD, `t:${normal}:claim`))).toMatch(/claimed ticket/);
    expect(row(normal)).toMatchObject({ claimed_by: MOD });
    expect(audit()).toEqual([{ admin_id: MOD, action: 'ticket_claim', target: String(normal), detail: { claim: true, via: 'discord' } }]);
    expect(events.filter((e) => e.kind === 'admin_action')).toHaveLength(1);
    // As on the site: a claimed ticket's button releases it, whoever presses.
    expect(content(await press(MOD2, `t:${normal}:claim`))).toMatch(/released ticket/);
    expect(row(normal)).toMatchObject({ claimed_by: null });
  });

  it('on a restricted ticket the audit row is written and the admin feed hears nothing', async () => {
    await press(ADMIN, `t:${restricted}:claim`);
    expect(row(restricted)).toMatchObject({ claimed_by: ADMIN });
    expect(audit()).toHaveLength(1);
    expect(events).toEqual([]);
  });
});

describe('Close', () => {
  it('the button opens a modal and changes nothing; only that button is said to open one', async () => {
    const r = await press(MOD, `t:${normal}:close`);
    expect(r.modal).toMatchObject({ customId: `t:${normal}:close`, title: `Close ticket #${normal}` });
    expect(r.modal!.fields.map((f) => [f.kind, f.id])).toEqual([['select', 'outcome'], ['text', 'note']]);
    expect(row(normal)).toMatchObject({ status: 'open' });
    expect(opensTicketModal(`t:${normal}:close`)).toBe(true);
    expect(opensTicketModal(`t:${normal}:claim`)).toBe(false);
    expect(opensTicketModal('r:1:close')).toBe(false);
  });

  it('the modal closes the ticket with its outcome and note, audited without the note', async () => {
    expect(content(await submit(MOD, `t:${normal}:close`, { outcome: 'nonsense', note: '' }))).toMatch(/pick an outcome/i);
    expect(row(normal)).toMatchObject({ status: 'open' });
    expect(content(await submit(MOD, `t:${normal}:close`, { outcome: 'warned', note: 'first time' }))).toMatch(/is closed/);
    expect(row(normal)).toMatchObject({ status: 'closed', outcome: 'warned', outcome_note: 'first time' });
    expect(audit()).toEqual([{ admin_id: MOD, action: 'ticket_close', target: String(normal), detail: { outcome: 'warned', via: 'discord' } }]);
    const again = await press(MOD, `t:${normal}:close`);
    expect(again.modal).toBeUndefined();
    expect(content(again)).toMatch(/already closed/);
  });

  it('end to end: a close from Discord locks and archives the post', async () => {
    setSetting(db, 'discord_tickets_forum_id', 'forum1');
    const t = new FakeTransport();
    const sync = new TicketSync({ db, transport: t, publicUrl: 'https://pug.test', intervalMs: 0 });
    sync.start();
    await sync.idle();
    const threadId = staffThread(db, normal)!.thread_id;
    await submit(MOD, `t:${normal}:close`, { outcome: 'no_action', note: '' });
    await sync.idle();
    expect(t.threadsById.get(threadId)).toMatchObject({ locked: true, archived: true });
    sync.stop();
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run tests/ticketButtons.test.ts`
Expected: FAIL, cannot resolve `../src/discord/ticketButtons.js`.

- [ ] **Step 3: The handlers**

`src/discord/ticketButtons.ts`:

```ts
import type { DB } from '../db.js';
import { logAdmin } from '../admin/audit.js';
import { playerByDiscordId } from '../players.js';
import { claimTicket, closeTicket } from '../tickets/actions.js';
import { canSeeTicket, getTicketRow, type TicketRow } from '../tickets/store.js';
import { closeModal } from './ticketCard.js';
import type { BotInteraction, InteractionReply } from './transport.js';

export interface TicketButtonDeps {
  db: DB;
  publicUrl: string;
}

const say = (content: string): InteractionReply => ({
  ephemeral: true,
  payload: { content, embeds: [], components: [], mentionUserIds: [] },
});
const capitalise = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

const STAFF_ONLY = 'Staff only.';
/** One answer for "no such ticket" and "not one you may see", on purpose. */
const NO_TICKET = 'No such ticket.';

/** Buttons that answer with a modal. The transport has to know before it
 *  runs the handler, because a modal must be the first response to a press. */
export const opensTicketModal = (customId: string): boolean => /^t:\d+:close$/.test(customId);

/**
 * Who is pressing, and may they touch this ticket. Checked from scratch on
 * every press: a button sits in Discord for months, and the person pressing
 * it may have been demoted, banned or unlinked since the card was posted.
 * Being able to see the thread proves nothing here.
 */
function resolve(
  deps: TicketButtonDeps, userId: string, ticketId: number,
): { me: string; ticket: TicketRow } | { reply: InteractionReply } {
  const p = playerByDiscordId(deps.db, userId);
  if (!p || p.status !== 'active' || (p.is_admin !== 1 && p.is_mod !== 1)) return { reply: say(STAFF_ONLY) };
  const ticket = getTicketRow(deps.db, ticketId);
  if (!ticket || !canSeeTicket(deps.db, ticket, p.steamid)) return { reply: say(NO_TICKET) };
  return { me: p.steamid, ticket };
}

/**
 * custom_id scheme: t:<ticketId>:claim, t:<ticketId>:close. Each calls
 * exactly what the site's route calls, so the two surfaces cannot disagree
 * about who may do what, and each is audited like the route, with
 * `via: 'discord'`, quietly for a restricted ticket.
 */
export async function handleTicketButton(
  deps: TicketButtonDeps, i: Extract<BotInteraction, { kind: 'button' }>,
): Promise<InteractionReply> {
  const m = /^t:(\d+):(claim|close)$/.exec(i.customId);
  if (!m) return say('That button no longer does anything.');
  const id = Number(m[1]);
  const who = resolve(deps, i.userId, id);
  if ('reply' in who) return who.reply;
  const { me, ticket } = who;

  if (m[2] === 'close') {
    if (ticket.status !== 'open') return say('This ticket is already closed.');
    // The payload is what is said if the modal cannot be shown.
    return { ...say(`Close it on the site: ${deps.publicUrl}/admin?ticket=${id}`), modal: closeModal(id) };
  }

  // As the site's button does: an unclaimed ticket is claimed, a claimed one
  // is released, whoever holds it.
  const claim = ticket.claimed_by === null;
  const r = claimTicket(deps.db, id, me, claim);
  if (!r.ok) return say(capitalise(r.error));
  logAdmin(deps.db, me, 'ticket_claim', id, { claim, via: 'discord' }, { quiet: ticket.restricted === 1 });
  return say(claim ? `You claimed ticket #${id}.` : `You released ticket #${id}.`);
}

export async function handleTicketModal(
  deps: TicketButtonDeps, i: Extract<BotInteraction, { kind: 'modal' }>,
): Promise<InteractionReply> {
  const m = /^t:(\d+):close$/.exec(i.customId);
  if (!m) return say('That form no longer does anything.');
  const id = Number(m[1]);
  const who = resolve(deps, i.userId, id);
  if ('reply' in who) return who.reply;
  const r = closeTicket(deps.db, id, who.me, i.fields.outcome, i.fields.note ?? '');
  if (!r.ok) return say(capitalise(r.error));
  // The note is internal and stays out of the audit detail, as on the site.
  logAdmin(deps.db, who.me, 'ticket_close', id, { outcome: i.fields.outcome, via: 'discord' }, { quiet: who.ticket.restricted === 1 });
  return say(`Ticket #${id} is closed. The post locks in a moment.`);
}
```

Nothing here touches Discord: `claimTicket` and `closeTicket` publish the ticket signal (Task 2), and `TicketSync` refreshes the card, the tags and the lock.

- [ ] **Step 4: Wire the prefix**

`src/server.ts`. Add `import { handleTicketButton, handleTicketModal, opensTicketModal } from './discord/ticketButtons.js';` and, in the `startBot({ ... })` call, replace the `extraButtons` entry with:

```ts
      extraButtons: {
        'r:': (i) => adminFeed!.handleButton(i),
        't:': (i) => handleTicketButton({ db: deps.db, publicUrl: deps.config.publicUrl }, i),
      },
      extraModals: {
        't:': (i) => handleTicketModal({ db: deps.db, publicUrl: deps.config.publicUrl }, i),
      },
      opensModal: opensTicketModal,
```

`src/discord/controller.ts`: in the comment above `handleButton` that lists the custom id scheme, add one line so the next reader knows the prefix is taken:

```ts
 * Ticket buttons (t:<ticketId>:...) are routed to ticketButtons.ts before
 * they reach this function.
```

- [ ] **Step 5: Say where it came from in the admin feed**

`src/discord/adminFeedPoster.ts`, in `actionText`, inside the `case 'ticket_open': ... case 'ticket_ban': {` block, change the two lines for claim and close to:

```ts
          case 'ticket_claim': return `${who} ${d.claim === false ? 'released' : 'claimed'} ${ticket}${d.via === 'discord' ? ' from Discord' : ''}`;
          case 'ticket_close': return `${who} closed ${ticket}: ${String(d.outcome ?? '').replace(/_/g, ' ')}${d.via === 'discord' ? ' from Discord' : ''}`;
```

`tests/discordAdminFeed.test.ts` has `expect(text(0)).toContain('closed ticket [#12](https://pug.test/admin?ticket=12)')` and `toContain('warned')`, which still hold.

- [ ] **Step 6: Run**

Run: `npx vitest run tests/ticketButtons.test.ts tests/discordAdminFeed.test.ts tests/discordBot.test.ts && npm run typecheck`
Expected: PASS, typecheck clean.

- [ ] **Step 7: Commit**

```bash
git add src/discord/ticketButtons.ts src/discord/adminFeedPoster.ts src/discord/controller.ts src/server.ts tests/ticketButtons.test.ts
git commit -m "Let staff claim, release and close a ticket from its Discord post"
```

---

### Task 8: The interim admin feed line, only while no forum is set

Phase 1 posts one plain line in the admin channel for every report on a normal ticket, so nothing arrived unannounced while there was no forum. The spec says phase 2 removes that line. The owner's rule is narrower, and it is the one built here:

- **The forum IS configured:** no feed line. The forum post and its "Another report" line are the announcement.
- **The forum is NOT configured:** the plain line stays, so the owner still hears about new tickets.
- **A restricted ticket, and a normal ticket about staff, never post either way.** Every admin reads the feed, and one of them may be who the ticket is about.

The line moves out of `fileReport` and into `TicketSync`, which is the only place that knows whether a thread was made. It rides `ticket_reports.announced_at` (Task 2), so a report is said exactly once: in its thread, or in the feed, never both, and a report filed while the bot was down is said when it comes back. With the bot not running at all there is no line, as there was none before: the feed poster does not run without the bot either.

**Files:**
- Modify: `src/tickets/filing.ts` (the tail of `fileReport`), `src/discord/ticketSync.ts` (`reconcileTicket`, new `announceInFeed`), `src/adminFeed.ts` (the comment on the `report` event), `src/discord/adminFeedPoster.ts` (the class comment), `src/settingsSchema.ts` (the help text of `admin_feed_reports`), `tests/discordAdminFeed.test.ts`

**Interfaces:**
- Consumes: `surfaceFor(db, t): { surface; why }` (Task 6); `ticket_reports.announced_at` (Task 2); `publishAdminEvent({ kind: 'report', ticketId, targetId, category, created })` from `src/adminFeed.ts`; `TicketSync` (Tasks 4 to 6).
- Produces: nothing new. `fileReport` no longer publishes an admin event. The `report` member of `AdminEvent` and the `admin_feed_reports` toggle stay exactly as they are.

- [ ] **Step 1: Rewrite the two report tests and add two**

`tests/discordAdminFeed.test.ts`. Add to the imports:

```ts
import { TicketSync } from '../src/discord/ticketSync.js';
```

Beside `let feed: AdminFeedPoster;` add `let sync: TicketSync;`. At the end of `beforeEach`, after `feed.start();`:

```ts
  sync = new TicketSync({ db, transport: t, publicUrl: 'https://pug.test', intervalMs: 0 });
  sync.start();
```

Change `afterEach(() => feed.stop());` to:

```ts
afterEach(() => { sync.stop(); feed.stop(); });
```

Add below `const text = ...`:

```ts
/** The reconciler publishes, then the poster delivers: wait for both, in that order. */
const settled = async () => { await sync.idle(); await feed.idle(); };
const inFeed = () => t.live().filter((m) => m.channelId === 'admins');
```

Replace the first two tests (`posts one plain line for a new ticket ...` and `a restricted ticket posts nothing`) with:

```ts
  it('with no forum set, posts one plain line for a new ticket and another for a further report, never naming the reporter', async () => {
    const a = fileReport(db, IDS[0], { targetId: IDS[5], category: 'griefing', text: 'kept killing us', matchId }, { adminSteamIds: [] }) as { ticketId: number };
    fileReport(db, IDS[1], { targetId: IDS[5], category: 'cheating', text: '' }, { adminSteamIds: [] });
    await settled();
    expect(inFeed()).toHaveLength(2);
    expect(text(0)).toContain(`https://pug.test/admin?ticket=${a.ticketId}`);
    expect(text(0)).toContain('player5');
    expect(text(0)).toContain('griefing');
    expect(text(0)).toMatch(/new ticket/i);
    expect(text(1)).toMatch(/another report/i);
    expect(text(0) + text(1)).not.toContain('player0');
    expect(text(0) + text(1)).not.toContain('player1');
    expect(text(0)).not.toContain('kept killing us');
    expect(t.live()[0].payload.components).toEqual([]);
    // Said once: a later pass finds nothing left to say.
    await sync.reconcile();
    await feed.idle();
    expect(inFeed()).toHaveLength(2);
  });

  it('with the forum set, the post is the announcement and the feed hears nothing', async () => {
    setSetting(db, 'discord_tickets_forum_id', 'forum1');
    fileReport(db, IDS[0], { targetId: IDS[5], category: 'griefing', text: '' }, { adminSteamIds: [] });
    fileReport(db, IDS[1], { targetId: IDS[5], category: 'cheating', text: '' }, { adminSteamIds: [] });
    await settled();
    expect(t.threadsIn('forum1')).toHaveLength(1);
    expect(inFeed()).toEqual([]);
  });

  it('a report filed while the bot was down is said when it comes back', async () => {
    sync.stop();
    fileReport(db, IDS[0], { targetId: IDS[5], category: 'afk', text: '' }, { adminSteamIds: [] });
    await settled();
    expect(inFeed()).toEqual([]);
    sync = new TicketSync({ db, transport: t, publicUrl: 'https://pug.test', intervalMs: 0 });
    sync.start();
    await settled();
    expect(inFeed()).toHaveLength(1);
  });

  it('a restricted ticket posts nothing, with or without a forum', async () => {
    fileReport(db, IDS[0], { targetId: IDS[5], category: 'unsafe', text: 'details' }, { adminSteamIds: [] });
    fileReport(db, IDS[0], { targetId: ADMIN, category: 'toxicity', text: '' }, { adminSteamIds: [] });
    await settled();
    setSetting(db, 'discord_tickets_forum_id', 'forum1');
    fileReport(db, IDS[1], { targetId: IDS[5], category: 'unsafe', text: 'more' }, { adminSteamIds: [] });
    await settled();
    // No tickets channel is set, so there is no private thread either.
    expect(t.live()).toHaveLength(0);
  });

  it('a normal ticket about someone who has since been made staff posts nothing', async () => {
    sync.stop();
    fileReport(db, IDS[1], { targetId: IDS[3], category: 'afk', text: '' }, { adminSteamIds: [] });
    // Promoted by hand, with nobody to restrict the ticket to: the case
    // restrictOpenTicketAbout answers 'nobody' for. The accused reads the feed.
    db.prepare('UPDATE players SET is_mod = 1 WHERE steamid = ?').run(IDS[3]);
    sync = new TicketSync({ db, transport: t, publicUrl: 'https://pug.test', intervalMs: 0 });
    sync.start();
    await settled();
    expect(inFeed()).toEqual([]);
  });
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run tests/discordAdminFeed.test.ts`
Expected: FAIL. With the forum set the feed still gets two lines, because `fileReport` still publishes them.

- [ ] **Step 3: `fileReport` stops publishing**

`src/tickets/filing.ts`. Delete `import { publishAdminEvent } from '../adminFeed.js';` and replace the tail of `fileReport` (from the comment `// After the commit.` that Task 2 wrote, to `return result;`) with:

```ts
  // After the commit. The signal goes out for a restricted ticket too: it
  // carries an id and stays in this process. Whether anything is SAID about
  // the report, and where, is TicketSync's decision: in the ticket's thread,
  // or as a line in the admin channel while no forum is set.
  if (result.ok) publishTicketSignal({ kind: 'ticket', ticketId: result.ticketId });
  return result;
```

`category` and `target` are still used above, so nothing else in the function changes.

- [ ] **Step 4: `TicketSync` says it, when there is no thread to say it in**

`src/discord/ticketSync.ts`. In `reconcileTicket`, replace

```ts
    const { surface } = surfaceFor(db, t);
```

with

```ts
    const where = surfaceFor(db, t);
    const { surface } = where;
```

and replace the line `if (!thread) return;` with:

```ts
    if (!thread) {
      this.announceInFeed(t, where.why);
      return;
    }
```

Add the method to the class:

```ts
  /**
   * The interim line in the admin channel, for a ticket that has no thread
   * because no forum is set. Once a forum is set the post is the
   * announcement and this says nothing.
   *
   * Never for a restricted ticket and never for a ticket about staff
   * (`why` is then 'about_staff'): every admin reads the feed, and one of
   * them may be who the ticket is about. The event carries no reporter.
   *
   * Marked before it is published: publishing cannot fail, and a report must
   * never be said twice.
   */
  private announceInFeed(t: TicketRow, why: 'ok' | 'unconfigured' | 'about_staff'): void {
    if (t.restricted === 1 || why !== 'unconfigured' || t.status !== 'open') return;
    const { db } = this.deps;
    const rows = db.prepare(
      'SELECT id, category FROM ticket_reports WHERE ticket_id = ? AND announced_at IS NULL ORDER BY id',
    ).all(t.id) as { id: number; category: string }[];
    for (const r of rows) {
      db.prepare('UPDATE ticket_reports SET announced_at = ? WHERE id = ?').run(new Date().toISOString(), r.id);
      // "New ticket" for the report that opened it, "Another report" after.
      const first = t.opened_by === null
        && !db.prepare('SELECT 1 FROM ticket_reports WHERE ticket_id = ? AND id < ?').get(t.id, r.id);
      publishAdminEvent({ kind: 'report', ticketId: t.id, targetId: t.target_id, category: r.category, created: first });
    }
  }
```

- [ ] **Step 5: Say so where the next reader will look**

`src/adminFeed.ts`, replace the three comment lines above the `report` member with:

```ts
  // A report landed on a normal ticket that has no Discord thread because no
  // tickets forum is set. Published by TicketSync, never by filing, and never
  // for a restricted ticket or a ticket about staff. It carries no reporter:
  // the feed channel is wider than the ticket. `created` is whether the
  // report opened the ticket or joined one.
```

`src/discord/adminFeedPoster.ts`, in the class comment, replace the sentence that begins `A report is one plain line` (through `not from Discord.`) with:

```ts
 * A report is one plain line, and only while no tickets forum is set: once
 * there is a forum the ticket's own post is the announcement (TicketSync
 * decides which). There is no card and nothing to edit.
```

`src/settingsSchema.ts`, the `admin_feed_reports` entry, change its `help` to:

```ts
help: 'Post a line when a ticket opens or gets another report. Only while no tickets forum is set: with a forum, the ticket\'s own post is the announcement. Restricted tickets never post.',
```

- [ ] **Step 6: Run**

Run: `npx vitest run tests/discordAdminFeed.test.ts tests/ticketSync.test.ts tests/ticketSyncRestricted.test.ts tests/ticketSyncAccess.test.ts tests/ticketFiling.test.ts tests/ticketRoutes.test.ts tests/discordCommands.test.ts && npm run typecheck`
Expected: PASS, typecheck clean. If the typecheck reports `publishAdminEvent` unused in `src/tickets/filing.ts`, the import was not deleted in Step 3.

- [ ] **Step 7: Commit**

```bash
git add src/tickets/filing.ts src/discord/ticketSync.ts src/adminFeed.ts src/discord/adminFeedPoster.ts src/settingsSchema.ts tests/discordAdminFeed.test.ts
git commit -m "Post the new ticket line in the admin channel only while no tickets forum is set"
```

---

### Task 9: Prove what can be proved, and say what cannot

Tests mock the API on the web side, inject on the server side, and stand a fake in for Discord. Nothing so far has run the site and a browser together, and nothing in this plan can run against Discord itself: `DEV_MODE=1` keeps the bot off (`botEnabled` in `src/discord/index.ts`), and the implementer has no bot token and must not use the owner's. This task proves the site half for real and writes down, without softening it, which paths are proven only against `FakeTransport` and which only by the typecheck.

**Files:** none changed unless a defect is found, then `docs/superpowers/plans/2026-09-22-tickets-phase2a.md` (a Verification section appended in Step 6).

**Interfaces:**
- Consumes: everything Tasks 1 to 8 produced; `POST /api/dev/login` (`src/routes/dev.ts`, body `{ steamid }`, 17 digits); `scripts/shoot-pages.mjs` as the model for a CDP script.
- Produces: a Verification section in this file.

- [ ] **Step 1: Full suite, types and build**

Run: `npm test && npm run typecheck && npm run build`
Expected: every test passes (ECONNREFUSED and AbortError lines in the output are noise from network-mocked tests, not failures), typecheck clean, `dist/public` produced.

- [ ] **Step 2: Start a server on a scratch database, outside the repo**

```bash
SCRATCH="$(mktemp -d /tmp/tickets-2a-XXXXXX)"
mkdir -p "$SCRATCH/replays"
DEV_MODE=1 PORT=8099 DB_PATH="$SCRATCH/tickets.sqlite" REPLAY_DIR="$SCRATCH/replays" \
  ADMIN_STEAMIDS=76561199000000001 npx tsx src/index.ts &
sleep 3
sqlite3 "$SCRATCH/tickets.sqlite" 'SELECT COUNT(*) FROM servers'
```

Expected: `0`. Do not click anything until it says `0`: a dev server over a database with `servers` rows can dial rcon at the live boxes. Never point `DB_PATH` at the repo's `data/` directory or at a copy of production.

- [ ] **Step 3: Build the cast and the tickets over HTTP**

`/api/dev/login` creates and activates a player but grants no flags, so set those with `sqlite3`:

```bash
B=http://localhost:8099
login() { curl -s -c "$SCRATCH/$1.jar" -H 'content-type: application/json' -d "{\"steamid\":\"$1\"}" $B/api/dev/login >/dev/null; }
as() { curl -s -b "$SCRATCH/$1.jar" -H 'content-type: application/json' "${@:2}"; }
for id in 76561199000000001 76561199000000002 76561199000000003 76561199000000004 76561199000000005 76561199000000006 76561199000000007; do login $id; done
sqlite3 "$SCRATCH/tickets.sqlite" "UPDATE players SET is_admin = 1 WHERE steamid IN ('76561199000000001','76561199000000002'); UPDATE players SET is_mod = 1 WHERE steamid = '76561199000000003';"
# 4 and 5 report 6; 4 files a safety report about 6; 5 reports 7.
as 76561199000000004 -d '{"targetId":"76561199000000006","category":"griefing","text":"threw the finale"}' $B/api/reports
as 76561199000000005 -d '{"targetId":"76561199000000006","category":"toxicity","text":""}' $B/api/reports
as 76561199000000004 -d '{"targetId":"76561199000000006","category":"unsafe","text":"details"}' $B/api/reports
as 76561199000000005 -d '{"targetId":"76561199000000007","category":"cheating","text":"walls"}' $B/api/reports
```

Then check, and write down what came back:

1. `as 76561199000000003 "$B/api/mod/tickets?filter=open"` (the moderator): `counts` is `{ open: 2, mine: 0, closed: 0 }` and the restricted ticket is absent. As `...001` (the owner): `counts.open` is `3`.
2. Claim ticket 1 as the moderator (`-d '{"claim":true}' $B/api/mod/tickets/1/claim`), then list again: `mine` is `1`.
3. `as 76561199000000003 $B/api/mod/tickets/1`: `discussion` is `{ "state": "unconfigured", "surface": null, "url": null }`.
4. As the owner, set the forum id through the settings route the panel uses: `as 76561199000000001 -X PUT -d '{"value":"1551668183906394204"}' $B/api/admin/settings/discord_tickets_forum_id` (`PUT /api/admin/settings/:key` in `src/routes/admin.ts`; if the body shape has moved, read it there). Fetch ticket 1 again: `discussion.state` is `pending` and `surface` is `forum`. It stays `pending`, which is the honest answer with the bot off. Blank the setting again afterwards.
5. Merge `...007` into `...006` as the owner: `-d '{"into":"76561199000000006"}' $B/api/admin/players/76561199000000007/merge`. Then `as 76561199000000003 $B/api/mod/tickets/1`: three reports, and an event of kind `folded` with `detail.from` naming the ticket that was about `...007`. `sqlite3 "$SCRATCH/tickets.sqlite" 'PRAGMA foreign_key_check'` prints nothing.
6. `as 76561199000000001 $B/api/admin/audit`: no row points at the ticket id that no longer exists.
7. `sqlite3 "$SCRATCH/tickets.sqlite" "SELECT COUNT(*) FROM ticket_threads"` is `0`, and `SELECT COUNT(*) FROM ticket_reports WHERE announced_at IS NULL` equals the number of reports filed: nothing has been said anywhere, because nothing that says it is running.

- [ ] **Step 4: Look at it in a browser**

Layout and frame-driven bugs in this app are checked with headless Chrome over CDP, never an in-app pane. Copy `scripts/shoot-pages.mjs` to `$SCRATCH/shoot.mjs` (outside the repo), point `BASE` at `http://localhost:8099`, make it log in first with an in-page `fetch('/api/dev/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ steamid }) })` so the real signed cookie is set, and capture at 1280 and 400 wide:

- `/admin` as the moderator: the three filter tabs each carry a count.
- `/admin?ticket=1` as the moderator: the line "Discord discussion is not configured..." under the timeline, and the "Ticket #N about the same player was folded into this one" line in it.
- `/admin?ticket=<the restricted id>` as the owner: the restricted notice with its new wording about the private Discord thread and the Administrator permission.
- `/admin` as the owner, Settings tab: "Tickets forum channel id" and "Tickets text channel id" are there, under Discord, with their help text.

Open every image and look at it. Check `document.documentElement.scrollWidth <= clientWidth` on each 400 px capture; fix any overflow before going on.

- [ ] **Step 5: Stop the server and clean up**

```bash
kill %1; sleep 1; ss -ltn | grep -c ':8099 ' || true
rm -rf "$SCRATCH"
```

Expected: `0` listeners on 8099.

- [ ] **Step 6: Record what was and was not verified**

Append a `## Verification (<date>)` section to this file in the style of the one in `docs/superpowers/plans/2026-09-21-tickets-phase1.md`: what was run, what was seen, and then this list, edited to match what actually happened. Do not shorten it and do not soften it.

**Not verified, and why.** Nothing in this plan was run against Discord. The implementer has no bot and `DEV_MODE=1` keeps the bot off.

- Proven against `tests/fakes/fakeTransport.ts` only: creating a forum post and its case card; tags; the "Another report" line; the card refresh and its hash; lock and archive on close, and the reverse on reopen; remaking a post deleted by hand; deleting a forum post that must not exist; retiring a folded thread; a restricted ticket's private thread and its membership; the access list DM; the forum's permission overwrites; the admin feed line and the rule that silences it.
- Proven as plain functions only, with no Discord interaction behind them: Claim, Release, Close and the Close modal's submit (`src/discord/ticketButtons.ts`). That a press on the real button reaches them, that the modal opens, and that its select comes back as `fields.outcome`, is proven by nothing.
- Proven by `npm run typecheck` only: every line of `src/discord/djsTransport.ts` added in Task 3. It compiles against discord.js 14.27.0. It has never run.
- Not exercised at all: a ticket about staff that could not be restricted (`about_staff` on the page); the reconciler's five minute timer; two processes; a real forum's five tag limit and twenty tag ceiling; Discord rate limits on a first start with many open tickets.

Commit:

```bash
git add docs/superpowers/plans/2026-09-22-tickets-phase2a.md
git commit -m "Record what the tickets phase 2a verification covered"
```

Do not merge to master and do not deploy. Hand back to the owner with the branch name, the verification notes and the owner checklist below.

---

## Deliberately left for the later phases

In the spec, not in this plan. Listed so nobody takes them for oversights.

- **The mirror, attachments, Remove, the staff-scoped live nudge, thumbnails, and the replay moment control:** `docs/superpowers/plans/2026-09-22-tickets-phase2b.md`. This plan ships without the Message Content intent being used: the two new gateway intents are added there, with the inbound message hook.
- **"Contact reporter", reporter threads and their relay, "End reporter chat", "Remove everything from this person", the close DM to reporters:** phase 3. The card's button row leaves the second slot for Contact reporter, `ticket_threads.kind` already takes `reporter`, `ticket_threads.reporter_id` is already a foreign key the merge knows about, and the `t:` custom id prefix is reserved for `t:<id>:contact` and `t:<id>:join`.
- **Reopen from Discord.** A closed post is locked and archived and its card has no buttons. Reopen on the site; the post unlocks within moments.
- **A Discord thread for a normal ticket about staff.** Such a ticket exists only when there was nobody to restrict it to. It is worked on the site, and the page says so.
- **Renaming a post when its categories change.** The title is set once; categories arrive as tags.

## What this plan decided that the spec did not

- A forum post that must not exist (the ticket was restricted, or its accused became staff) is **deleted**, not locked: a locked post is still readable by everyone in the forum. The discussion in it is lost from Discord. From phase 2b on, the mirror has already copied it to the site.
- A new member of staff is kept out of the forum until every post about them is confirmed deleted.
- The case card names the accused and nobody else. Reporters and report text stay on the site, behind `canSeeTicket`.
- A restricted thread is titled `Ticket #<id>` and nothing more: thread titles surface in places the thread's content does not.
- When two folded tickets both had a thread, the survivor keeps its own, one line in it names the other, and the other is locked and archived.
- The access DM is charged before it is sent, so a refused DM is never retried, and it is sent whether or not a tickets channel is set, because the link is to the site.
- The admin feed `report` line and the `admin_feed_reports` toggle are kept, not removed as the spec says, and are posted only while no forum is set. This is the owner's rule, given after the spec was written.

## Owner checklist

Nothing here is done by the implementer, and none of it is in code or tests.

Already done: the Message Content intent is on in the developer portal (not used until phase 2b). Both channels exist in guild `1539966341543633117`: the tickets text channel `1551668103199461497` and the hidden moderator forum `1551668183906394204`.

Before the ids go into Settings:

1. The forum denies View Channel to `@everyone`. Open it as an ordinary member (or use "View server as role") and confirm it is not in the channel list.
2. The tickets text channel lets everyone view it and nobody send in it, and has private threads allowed. Nobody but the bot needs Manage Threads there, and staff should not have it: membership of each private thread is the access list.
3. The bot's role, in BOTH channels: View Channel, Send Messages, Send Messages in Threads, Create Public Threads (the forum), Create Private Threads (the text channel), Manage Threads, Manage Messages, Manage Channels and Manage Permissions (the forum: it writes the per-member overwrites and creates the tags), Read Message History, Embed Links.
4. Moderators are marked in the admin Players tab, and each has Discord linked on the site. A moderator with no linked Discord gets no forum access, and the ticket page still works for them.

After the deploy, in this order:

5. Settings, Discord group: paste the forum id into "Tickets forum channel id" and the text channel id into "Tickets text channel id".
6. Within five minutes, or at once on the next bot start, every open normal ticket gets a forum post and every linked moderator and admin can see the forum. Check one moderator who should see it and one ordinary member who should not.

The manual checks that stand in for the tests `djsTransport.ts` cannot have. Do them once, on a quiet evening, with a second account to be the accused:

7. File a report about the second account. A post titled `#<id> <name> (<category>)` appears, tagged `open` and the category, with Claim, Close and "Open on the site".
8. Press Claim. The reply is private, the card says who claimed it, the tag turns to `claimed`, the button reads Release, and the ticket page agrees. Press Release.
9. File a second report from another account. One "Another report" line lands in the thread, the thread bumps, and the card's count goes up.
10. Press Close. A form opens with an Outcome picker and a Note box. Submit it. The card says closed, the buttons are gone, the post is locked and archived. Reopen on the site: the post unlocks and the buttons come back.
11. Press Claim from an account that is not staff (give it View Channel on the forum by hand for a minute, then take it away). The answer is "Staff only." and nothing changes.
12. Restrict the ticket on the site. The forum post is deleted, and a private thread `Ticket #<id>` appears in the tickets channel whose members are exactly the access list. Each of them got one DM with the link. Give a moderator access on the site: they are added to the thread and DMed. Confirm an ordinary member cannot see the thread.
13. Make the second account a moderator while an ordinary open ticket about it has a post. The post is deleted before the account can see the forum. Then remove the flag.
14. Delete a ticket's post by hand in Discord. Within five minutes a new one is made.
15. Blank the forum id in Settings and file a report: one plain line arrives in the admin channel, and nothing else happens in Discord. Put the id back.
16. Read the restricted ticket's page and the DM once more for the sentence about the Discord Administrator permission. If the accused in a real restricted case holds that permission, keep the discussion on the site.
