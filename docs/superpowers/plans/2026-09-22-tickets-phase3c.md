# Tickets Phase 3c Implementation Plan: Discord sanctions

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** On a ticket about someone who is only in the Discord, let moderators time them out in Discord for up to the moderator ban cap, let admins time out for up to 28 days or ban from the Discord, and let admins lift either, with the bot doing the Discord action and the site recording it.

**Architecture:** The rules live in `src/tickets/discordSanctions.ts` as pure database functions: `checkDiscordSanction` decides whether an action is allowed and returns what to do, `recordDiscordSanction` and `recordLift` write it. The routes in `src/routes/tickets.ts` run check, then the Discord call through a new `ModerationOps` on the transport, then record. Discord first, then the record, so the record never claims something Discord did not do. The ticket page swaps its server-ban form for Discord controls when the accused has no player account.

**Tech Stack:** TypeScript, better-sqlite3, fastify, vitest, discord.js 14.27, Preact.

**Spec:** `docs/superpowers/specs/2026-09-22-tickets-phase3-design.md`, section 4. Builds on phase 3a (deployed 2026-09-22, master `9956d7c`).

## Global Constraints

- **Discord first, then the record.** If Discord refuses, nothing is written and the refusal is shown in plain words. If Discord accepts and the write then fails, an admin `problem` event says so (the action happened and is not recorded).
- **Caps:** a moderator may only time out, for at most `min(ticket_mod_ban_max_minutes, 40320)` minutes. An admin may time out for at most 40320 minutes (Discord's 28-day maximum) or ban. A ban has no expiry and lasts until an admin lifts it. Only admins lift. The caps are enforced in `checkDiscordSanction` alone.
- **Who is a Discord-only person:** a ticket with `target_discord_id` set and `target_id` NULL. These controls never apply to a player; players keep the server ban unchanged.
- **Reason:** required, trimmed, at most 500 characters. It goes to Discord's audit log as the action's reason and into the row.
- **Privacy:** audit rows for a restricted ticket are written `quiet`, exactly as every other ticket action (`logAdmin(..., { quiet: restricted })`). Missing and invisible tickets answer the same 404.
- **Run the FULL suite (`npx vitest run`) and `npm run typecheck` at the end of every task.** Known noise: ECONNREFUSED lines, the `tests/logAuthWiring.test.ts` flake, and `tests/server.test.ts`'s malformed-URL case in a worktree without `dist/` (run `npm run build` once). None are yours.
- **Never use `git stash`.** No em dashes anywhere. Only `src/discord/djsTransport.ts` imports discord.js.

---

## File Structure

| File | Responsibility |
|---|---|
| `src/tickets/discordSanctions.ts` (modify) | `checkDiscordSanction`, `recordDiscordSanction`, `checkLift`, `recordLift`, `sanctionsFor`, alongside the existing `activeDiscordSanction`. |
| `src/discord/transport.ts` (modify) | `ModerationOps` and `ModerationResult`; `BotTransport.moderation`. |
| `src/discord/djsTransport.ts` (modify) | The discord.js implementation and the refusal translation. |
| `tests/fakes/fakeTransport.ts` (modify) | A fake `moderation` that records calls and can be told to refuse. |
| `src/routes/tickets.ts` (modify) | `POST /api/mod/tickets/:id/discord-sanction`, `POST /api/mod/discord-sanctions/:sid/lift`. |
| `src/server.ts` (modify) | Pass `moderation: () => ...` to the ticket routes; `ServerDeps.discordModeration?` test seam. |
| `src/tickets/views.ts` (modify) | Ticket detail carries `discordSanctions` for the accused's Discord id. |
| `web/src/api.ts`, `web/src/routes/admin/AdminTicket.tsx`, `web/src/routes/admin/TicketTimeline.tsx` (modify) | Controls, the sanctions list with Lift, the known-limit note, timeline wording. |

---

### Task 1: The rules

**Files:**
- Modify: `src/tickets/discordSanctions.ts`
- Test: `tests/discordSanctions.test.ts` (create)

**Interfaces:**
- Produces:

```ts
export const DISCORD_TIMEOUT_MAX_MINUTES = 40320;
export type SanctionKind = 'timeout' | 'ban';
export interface SanctionPlan { ticketId: number; discordId: string; kind: SanctionKind; minutes: number | null; reason: string; restricted: boolean }
export type Checked<T> = { ok: true; plan: T } | { ok: false; status: number; error: string };
export function checkDiscordSanction(db: DB, ticketId: number, by: string, body: { kind?: unknown; minutes?: unknown; reason?: unknown }): Checked<SanctionPlan>;
export function recordDiscordSanction(db: DB, plan: SanctionPlan, by: string, now?: Date): number; // the row id
export interface LiftPlan { sanctionId: number; discordId: string; kind: SanctionKind; ticketId: number | null; restricted: boolean }
export function checkLift(db: DB, sanctionId: number, by: string, now?: Date): Checked<LiftPlan>;
export function recordLift(db: DB, plan: LiftPlan, by: string, now?: Date): void;
export interface SanctionRow { id: number; kind: SanctionKind; until: string | null; reason: string; ticketId: number | null; createdBy: string; createdByName: string | null; createdAt: string; liftedBy: string | null; liftedAt: string | null; active: boolean }
export function sanctionsFor(db: DB, discordId: string, now?: Date): SanctionRow[];
```

Rules in `checkDiscordSanction`, in this order:

1. The ticket is visible to `by` (`getTicketRow` + `canSeeTicket`), else 404 `'no such ticket'`.
2. Open, else 409 `'reopen the ticket first'`.
3. `target_discord_id` set, else 400 `'this ticket is about a player; use the server ban'`.
4. `reason`: a string, trimmed non-empty, at most 500, else 400 `'a reason is required (up to 500 characters)'`.
5. `kind` is `'timeout'` or `'ban'`, else 400 `'pick a timeout or a ban'`.
6. Actor: `is_admin = 1` on their players row makes them an admin. A non-admin asking for `'ban'` gets 403 `'only an admin can ban from the Discord'`.
7. Timeout minutes: a whole number from 1 up to the cap, else 400 `'a timeout needs a length in minutes'` (not a whole positive number) or 403 `` `moderators can time out for up to ${cap} minutes; ask an admin for longer` `` (over a moderator's cap) or 400 `` `Discord allows at most ${DISCORD_TIMEOUT_MAX_MINUTES} minutes` `` (over 40320 for anyone). A moderator's cap is `min(Number(getSetting(db, 'ticket_mod_ban_max_minutes') ?? '10080'), DISCORD_TIMEOUT_MAX_MINUTES)`. For a ban, `minutes` is ignored and set to null.

`checkLift`: the row exists and is active (`lifted_at IS NULL` and, for a timeout, `until > now`), else 404 `'no such sanction'` / 409 `'that sanction is no longer in force'`; `by` is an admin, else 403 `'only an admin can lift a Discord sanction'`; if the row has a ticket, `canSeeTicket` must hold for `by`, else 404 `'no such sanction'`.

`recordDiscordSanction`, one transaction: insert the row (`until` = now + minutes for a timeout, NULL for a ban), `addTicketEvent(db, ticketId, by, 'discord_sanction', { kind, minutes, reason })`, `publishTicketSignal({ kind: 'ticket', ticketId })` after the commit. `recordLift`: set `lifted_by`, `lifted_at`; if the row has a ticket, event `'discord_sanction_lifted'` with `{ kind }`.

`sanctionsFor`: every row for that Discord id, newest first, with the issuer's name from a LEFT JOIN on players and `active` computed as above.

- [ ] **Step 1: Write the failing tests** `tests/discordSanctions.test.ts`

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { openDb, type DB } from '../src/db.js';
import { upsertPlayer, activatePlayer } from '../src/players.js';
import { setSetting } from '../src/settings.js';
import {
  checkDiscordSanction, recordDiscordSanction, checkLift, recordLift, sanctionsFor, activeDiscordSanction,
  DISCORD_TIMEOUT_MAX_MINUTES,
} from '../src/tickets/discordSanctions.js';

const MOD = '76561199000000701';
const ADMIN = '76561199000000702';
const PLAYER = '76561199000000703';
const LURKER = '990';
let db: DB;
let ticketId: number;
const now = new Date('2026-09-23T12:00:00Z');

beforeEach(() => {
  db = openDb(':memory:');
  for (const id of [MOD, ADMIN, PLAYER]) {
    upsertPlayer(db, { steamid: id, name: id.slice(-3), avatar: null }, []);
    activatePlayer(db, id);
  }
  db.prepare('UPDATE players SET is_mod = 1 WHERE steamid = ?').run(MOD);
  db.prepare('UPDATE players SET is_admin = 1 WHERE steamid = ?').run(ADMIN);
  ticketId = Number(db.prepare("INSERT INTO tickets (target_discord_id, target_name, created_at) VALUES (?, 'Lurky', 'x')").run(LURKER).lastInsertRowid);
});

const ask = (by: string, body: object, id = ticketId) => checkDiscordSanction(db, id, by, body);

describe('checkDiscordSanction', () => {
  it('lets a moderator time out up to the moderator cap', () => {
    expect(ask(MOD, { kind: 'timeout', minutes: 60, reason: ' spam ' })).toEqual({
      ok: true, plan: { ticketId, discordId: LURKER, kind: 'timeout', minutes: 60, reason: 'spam', restricted: false },
    });
    expect(ask(MOD, { kind: 'timeout', minutes: 10081, reason: 'x' })).toMatchObject({ ok: false, status: 403 });
    setSetting(db, 'ticket_mod_ban_max_minutes', '525600');
    // The setting can be higher than Discord allows; Discord's limit still wins.
    expect(ask(MOD, { kind: 'timeout', minutes: DISCORD_TIMEOUT_MAX_MINUTES + 1, reason: 'x' })).toMatchObject({ ok: false });
    expect(ask(MOD, { kind: 'timeout', minutes: DISCORD_TIMEOUT_MAX_MINUTES, reason: 'x' })).toMatchObject({ ok: true });
  });

  it('keeps bans for admins, and admins to Discord\'s 28 days for a timeout', () => {
    expect(ask(MOD, { kind: 'ban', reason: 'x' })).toMatchObject({ ok: false, status: 403 });
    expect(ask(ADMIN, { kind: 'ban', minutes: 5, reason: 'x' })).toMatchObject({ ok: true, plan: { kind: 'ban', minutes: null } });
    expect(ask(ADMIN, { kind: 'timeout', minutes: DISCORD_TIMEOUT_MAX_MINUTES + 1, reason: 'x' })).toMatchObject({ ok: false, status: 400 });
  });

  it('refuses a player ticket, a closed ticket, no reason, a bad kind or length', () => {
    const playerTicket = Number(db.prepare("INSERT INTO tickets (target_id, created_at) VALUES (?, 'x')").run(PLAYER).lastInsertRowid);
    expect(ask(ADMIN, { kind: 'ban', reason: 'x' }, playerTicket)).toMatchObject({ ok: false, status: 400 });
    expect(ask(ADMIN, { kind: 'ban', reason: '  ' })).toMatchObject({ ok: false, status: 400 });
    expect(ask(ADMIN, { kind: 'kick', reason: 'x' })).toMatchObject({ ok: false, status: 400 });
    expect(ask(MOD, { kind: 'timeout', minutes: 0, reason: 'x' })).toMatchObject({ ok: false, status: 400 });
    expect(ask(MOD, { kind: 'timeout', minutes: 1.5, reason: 'x' })).toMatchObject({ ok: false, status: 400 });
    db.prepare("UPDATE tickets SET status = 'closed' WHERE id = ?").run(ticketId);
    expect(ask(ADMIN, { kind: 'ban', reason: 'x' })).toMatchObject({ ok: false, status: 409 });
  });

  it('answers 404 for a restricted ticket the actor is not on, as for a missing one', () => {
    db.prepare('UPDATE tickets SET restricted = 1 WHERE id = ?').run(ticketId);
    expect(ask(MOD, { kind: 'timeout', minutes: 5, reason: 'x' })).toEqual({ ok: false, status: 404, error: 'no such ticket' });
    expect(ask(MOD, { kind: 'timeout', minutes: 5, reason: 'x' }, 999)).toEqual({ ok: false, status: 404, error: 'no such ticket' });
  });
});

describe('recording and lifting', () => {
  it('records a timeout with its end, an event, and makes the person unable to report', () => {
    const c = ask(MOD, { kind: 'timeout', minutes: 60, reason: 'spam' });
    if (!c.ok) throw new Error('check failed');
    const id = recordDiscordSanction(db, c.plan, MOD, now);
    expect(db.prepare('SELECT discord_id, kind, until, ticket_id, created_by FROM discord_sanctions WHERE id = ?').get(id))
      .toEqual({ discord_id: LURKER, kind: 'timeout', until: '2026-09-23T13:00:00.000Z', ticket_id: ticketId, created_by: MOD });
    expect(db.prepare("SELECT kind FROM ticket_events WHERE kind = 'discord_sanction'").get()).toEqual({ kind: 'discord_sanction' });
    expect(activeDiscordSanction(db, LURKER, now)).toMatchObject({ kind: 'timeout' });
    expect(activeDiscordSanction(db, LURKER, new Date('2026-09-23T13:00:01Z'))).toBeNull();
  });

  it('lets only an admin lift an active sanction, once', () => {
    const c = ask(ADMIN, { kind: 'ban', reason: 'x' });
    if (!c.ok) throw new Error('check failed');
    const id = recordDiscordSanction(db, c.plan, ADMIN, now);
    expect(checkLift(db, id, MOD, now)).toMatchObject({ ok: false, status: 403 });
    const l = checkLift(db, id, ADMIN, now);
    expect(l).toMatchObject({ ok: true, plan: { sanctionId: id, discordId: LURKER, kind: 'ban' } });
    if (!l.ok) throw new Error('lift check failed');
    recordLift(db, l.plan, ADMIN, now);
    expect(checkLift(db, id, ADMIN, now)).toMatchObject({ ok: false, status: 409 });
    expect(checkLift(db, 999, ADMIN, now)).toMatchObject({ ok: false, status: 404 });
    expect(sanctionsFor(db, LURKER, now)).toMatchObject([{ id, kind: 'ban', active: false, liftedBy: ADMIN }]);
  });

  it('an expired timeout cannot be lifted', () => {
    const c = ask(MOD, { kind: 'timeout', minutes: 1, reason: 'x' });
    if (!c.ok) throw new Error('check failed');
    const id = recordDiscordSanction(db, c.plan, MOD, now);
    expect(checkLift(db, id, ADMIN, new Date('2026-09-23T12:02:00Z'))).toMatchObject({ ok: false, status: 409 });
  });
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `npx vitest run tests/discordSanctions.test.ts`
Expected: FAIL (`checkDiscordSanction` is not exported).

- [ ] **Step 3: Implement** in `src/tickets/discordSanctions.ts`, keeping `activeDiscordSanction` as it is. Imports: `getSetting` from `../settings.js`; `addTicketEvent`, `canSeeTicket`, `getTicketRow` from `./store.js`; `publishTicketSignal` from `./signals.js`.

```ts
export const DISCORD_TIMEOUT_MAX_MINUTES = 40320;
export type SanctionKind = 'timeout' | 'ban';
export interface SanctionPlan { ticketId: number; discordId: string; kind: SanctionKind; minutes: number | null; reason: string; restricted: boolean }
export type Checked<T> = { ok: true; plan: T } | { ok: false; status: number; error: string };

const no = (status: number, error: string) => ({ ok: false as const, status, error });
const isAdmin = (db: DB, steamid: string) =>
  (db.prepare('SELECT is_admin FROM players WHERE steamid = ?').get(steamid) as { is_admin: number } | undefined)?.is_admin === 1;

/**
 * Whether `by` may do this to the Discord-only person a ticket is about, and
 * exactly what. The one place the caps live: the route calls Discord only
 * with a plan this returned.
 */
export function checkDiscordSanction(
  db: DB, ticketId: number, by: string, body: { kind?: unknown; minutes?: unknown; reason?: unknown },
): Checked<SanctionPlan> {
  const t = getTicketRow(db, ticketId);
  if (!t || !canSeeTicket(db, t, by)) return no(404, 'no such ticket');
  if (t.status !== 'open') return no(409, 'reopen the ticket first');
  if (t.target_discord_id === null) return no(400, 'this ticket is about a player; use the server ban');
  const reason = typeof body.reason === 'string' ? body.reason.trim() : '';
  if (!reason || reason.length > 500) return no(400, 'a reason is required (up to 500 characters)');
  if (body.kind !== 'timeout' && body.kind !== 'ban') return no(400, 'pick a timeout or a ban');
  const admin = isAdmin(db, by);
  if (body.kind === 'ban') {
    if (!admin) return no(403, 'only an admin can ban from the Discord');
    return { ok: true, plan: { ticketId, discordId: t.target_discord_id, kind: 'ban', minutes: null, reason, restricted: t.restricted === 1 } };
  }
  const minutes = Number(body.minutes);
  if (!Number.isInteger(minutes) || minutes <= 0) return no(400, 'a timeout needs a length in minutes');
  if (minutes > DISCORD_TIMEOUT_MAX_MINUTES) return no(400, `Discord allows at most ${DISCORD_TIMEOUT_MAX_MINUTES} minutes`);
  if (!admin) {
    const cap = Math.min(Number(getSetting(db, 'ticket_mod_ban_max_minutes') ?? '10080'), DISCORD_TIMEOUT_MAX_MINUTES);
    if (minutes > cap) return no(403, `moderators can time out for up to ${cap} minutes; ask an admin for longer`);
  }
  return { ok: true, plan: { ticketId, discordId: t.target_discord_id, kind: 'timeout', minutes, reason, restricted: t.restricted === 1 } };
}
```

Note the order differs slightly from the list above in one place: Discord's own maximum is checked before the moderator cap, so that an admin and a moderator asking for 50000 minutes get the same answer. The test above relies on this order.

Write `recordDiscordSanction`, `checkLift`, `recordLift` and `sanctionsFor` to the rules above. `active` in `sanctionsFor` is `lifted_at === null && (until === null || until > now.toISOString())`, the same test `activeDiscordSanction` makes in SQL.

- [ ] **Step 4: Run the test file, the full suite and typecheck.** Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add src/tickets/discordSanctions.ts tests/discordSanctions.test.ts
git commit -m "Decide who may time out or ban a Discord-only member from a ticket"
```

---

### Task 2: The bot's moderation calls

**Files:**
- Modify: `src/discord/transport.ts`, `src/discord/djsTransport.ts`, `tests/fakes/fakeTransport.ts`

**Interfaces:**
- Produces, in `transport.ts`:

```ts
/** Why Discord said no, in the words the site shows. 'hierarchy': the
 *  member's top role is above the bot's, or they are an Administrator or the
 *  owner (a timeout cannot touch them). 'not_member': they are not in the
 *  server, so there is nothing to time out (a ban still works by id).
 *  'unknown_user': no such Discord account. 'other': anything else. */
export type ModerationResult = { ok: true } | { ok: false; why: 'hierarchy' | 'not_member' | 'unknown_user' | 'other'; detail: string };

/** Discord-side sanctions on one member, for tickets about people with no
 *  player account. Narrow on purpose, like RoleOps. `reason` goes to
 *  Discord's audit log. Never throws: a refusal is an answer, not an error. */
export interface ModerationOps {
  timeout(userId: string, minutes: number, reason: string): Promise<ModerationResult>;
  removeTimeout(userId: string, reason: string): Promise<ModerationResult>;
  ban(userId: string, reason: string): Promise<ModerationResult>;
  unban(userId: string, reason: string): Promise<ModerationResult>;
}
```

and `BotTransport` gains `moderation: ModerationOps;`.

- [ ] **Step 1: Types.** Add the above. `npm run typecheck` now fails in `djsTransport.ts` and the fake: that is the checklist for Steps 2 and 3.

- [ ] **Step 2: The fake** in `tests/fakes/fakeTransport.ts`:

```ts
  /** Every moderation call, in order. */
  moderationCalls: { op: 'timeout' | 'removeTimeout' | 'ban' | 'unban'; userId: string; minutes?: number; reason: string }[] = [];
  /** userId -> the refusal Discord would give. */
  moderationRefusals = new Map<string, Extract<ModerationResult, { ok: false }>>();
  moderation: ModerationOps = {
    timeout: async (userId, minutes, reason) => this.moderate({ op: 'timeout', userId, minutes, reason }),
    removeTimeout: async (userId, reason) => this.moderate({ op: 'removeTimeout', userId, reason }),
    ban: async (userId, reason) => this.moderate({ op: 'ban', userId, reason }),
    unban: async (userId, reason) => this.moderate({ op: 'unban', userId, reason }),
  };
  private moderate(call: FakeTransport['moderationCalls'][number]): ModerationResult {
    this.moderationCalls.push(call);
    return this.moderationRefusals.get(call.userId) ?? { ok: true };
  }
```

(Place `moderate` wherever the class keeps its private helpers; a refused call is still recorded, so a test can prove Discord was asked.)

- [ ] **Step 3: discord.js** in `djsTransport.ts`, next to `roles`. Verify each API in `node_modules/discord.js/typings/index.d.ts` and cite the line as the file already does: `GuildMember.timeout(timeout: number | null, reason?)` (~:1912), `GuildMemberManager.ban(user, options?)` (~:5119), `GuildMemberManager.unban(user, reason?)` (~:5136), and `BanOptions` for how the reason is passed. Discord API error codes, from `DiscordAPIError.code`: 50013 Missing Permissions and 50001 Missing Access mean `'hierarchy'` for our purposes; 10007 Unknown Member means `'not_member'`; 10013 Unknown User means `'unknown_user'`; 10026 Unknown Ban on unban means the ban is already gone, which is success for us.

```ts
  /** Discord's refusals, in the words the site shows. See ModerationResult. */
  const refusal = (err: unknown): ModerationResult => {
    const code = codeOf(err);
    const detail = err instanceof Error ? err.message : String(err);
    if (code === 50013 || code === 50001) return { ok: false, why: 'hierarchy', detail };
    if (code === 10007) return { ok: false, why: 'not_member', detail };
    if (code === 10013) return { ok: false, why: 'unknown_user', detail };
    console.error('[discord] moderation call failed:', err);
    return { ok: false, why: 'other', detail };
  };
  const moderation: ModerationOps = {
    async timeout(userId, minutes, reason) {
      try {
        const member = await guild.members.fetch(userId);
        // discord.js checks moderatable before calling Discord and throws its
        // own error, not a DiscordAPIError, for an Administrator or a member
        // above the bot. Ask first so that reads as the hierarchy refusal.
        if (!member.moderatable) return { ok: false, why: 'hierarchy', detail: 'not moderatable' };
        await member.timeout(minutes * 60_000, reason);
        return { ok: true };
      } catch (err) { return refusal(err); }
    },
    async removeTimeout(userId, reason) {
      try {
        const member = await guild.members.fetch(userId);
        await member.timeout(null, reason);
        return { ok: true };
      } catch (err) {
        // Someone who left the server has no timeout to remove.
        if (codeOf(err) === 10007) return { ok: true };
        return refusal(err);
      }
    },
    async ban(userId, reason) {
      try {
        await guild.members.ban(userId, { reason });
        return { ok: true };
      } catch (err) { return refusal(err); }
    },
    async unban(userId, reason) {
      try {
        await guild.members.unban(userId, reason);
        return { ok: true };
      } catch (err) {
        if (codeOf(err) === 10026) return { ok: true };
        return refusal(err);
      }
    },
  };
```

Check in the typings whether `GuildMember.moderatable` exists (it does in 14.x; cite its line) and whether `guild.members.ban` returns before or after Discord confirms. Include `moderation` in the object the function returns. `codeOf` already exists in this file.

- [ ] **Step 4: Full suite and typecheck.** Expected: all pass; no new tests here, the fake is exercised by Task 3.

- [ ] **Step 5: Commit**

```bash
git add src/discord/transport.ts src/discord/djsTransport.ts tests/fakes/fakeTransport.ts
git commit -m "Give the bot Discord timeouts and bans, answering refusals instead of throwing"
```

---

### Task 3: The routes

**Files:**
- Modify: `src/routes/tickets.ts`, `src/server.ts`
- Test: `tests/ticketDiscordSanctionRoutes.test.ts` (create)

**Interfaces:**
- Consumes: Task 1's functions; Task 2's `ModerationOps`, `ModerationResult`.
- Produces: `TicketRouteOpts.moderation: () => ModerationOps | null`; `ServerDeps.discordModeration?: ModerationOps` (a test seam; when set it wins over the running bot); `POST /api/mod/tickets/:id/discord-sanction` body `{ kind, minutes?, reason }`; `POST /api/mod/discord-sanctions/:sid/lift` body `{}`. Both answer `{ ok: true }` or `{ error }` with the status.

Route flow for a sanction: `requireMod`; `checkDiscordSanction`; no moderation (bot not running) gives 503 `'the Discord bot is not running'`; call Discord (`timeout` or `ban`); a refusal gives 409 with `refusalText(why)`; then `recordDiscordSanction` inside a try. If that throws, `publishAdminEvent({ kind: 'problem', text: ... })` naming the ticket and the action, and answer 500 `'Discord applied it, but recording it failed; an admin has been told'`. Then `logAdmin(db, me, 'ticket_discord_sanction', ticketId, { kind, minutes }, { quiet: plan.restricted })` and `broadcast('refresh')`. The reason is not in the audit detail, as with removals: it is on the ticket.

Lift flow: `requireMod`; `checkLift` (admins only, enforced there); call `removeTimeout` or `unban`; refusal gives 409; `recordLift`; `logAdmin(db, me, 'ticket_discord_sanction_lift', plan.ticketId ?? 0, { kind, sanctionId }, { quiet: plan.restricted })`; `broadcast('refresh')`.

`refusalText`:

```ts
const refusalText = (why: 'hierarchy' | 'not_member' | 'unknown_user' | 'other'): string => ({
  hierarchy: 'Discord refused: their role is above the bot\'s, or they are an administrator',
  not_member: 'they are no longer in the Discord server, so there is nothing to time out; an admin can still ban them',
  unknown_user: 'Discord has no account with that id',
  other: 'Discord refused the action; try again, or do it by hand in Discord',
})[why];
```

`checkLift` needs `restricted` for the quiet flag: it is in `LiftPlan`.

- [ ] **Step 1: Write the failing tests** `tests/ticketDiscordSanctionRoutes.test.ts`, on the harness `tests/ticketRoutes.test.ts` uses (`buildServer`, `authedCookie`, `stubOrchestrator` from `./helpers.js`), with `discordModeration: fake.moderation` in the deps, where `fake = new FakeTransport()`.

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { openDb, type DB } from '../src/db.js';
import { loadConfig } from '../src/config.js';
import { buildServer } from '../src/server.js';
import { subscribeAdminEvents, type AdminEvent } from '../src/adminFeed.js';
import { authedCookie, stubOrchestrator } from './helpers.js';
import { FakeTransport } from './fakes/fakeTransport.js';

const [MOD, ADMIN, OWNER] = ['76561199000000801', '76561199000000802', '76561199000000803'];
let db: DB;
let app: FastifyInstance;
let fake: FakeTransport;
let ticketId: number;
const cookie: Record<string, Record<string, string>> = {};

beforeEach(async () => {
  db = openDb(':memory:');
  fake = new FakeTransport();
  app = await buildServer({
    config: loadConfig({ ADMIN_STEAMIDS: OWNER }), db, orchestrator: stubOrchestrator(),
    serverCleaner: async () => {}, serverExec: async () => {}, discordModeration: fake.moderation,
  });
  for (const id of [MOD, ADMIN, OWNER]) cookie[id] = authedCookie(app, db, id);
  db.prepare('UPDATE players SET is_mod = 1 WHERE steamid = ?').run(MOD);
  db.prepare('UPDATE players SET is_admin = 1 WHERE steamid IN (?, ?)').run(ADMIN, OWNER);
  ticketId = Number(db.prepare("INSERT INTO tickets (target_discord_id, target_name, created_at) VALUES ('990', 'Lurky', 'x')").run().lastInsertRowid);
});
afterEach(async () => { await app.close(); });

const post = (as: string, url: string, payload: object = {}) => app.inject({ method: 'POST', url, cookies: cookie[as], payload });
const rows = () => db.prepare('SELECT kind, until IS NOT NULL AS timed, lifted_at IS NOT NULL AS lifted FROM discord_sanctions').all();

describe('Discord sanctions over HTTP', () => {
  it('a moderator times out: Discord is called, then it is recorded and audited', async () => {
    const r = await post(MOD, `/api/mod/tickets/${ticketId}/discord-sanction`, { kind: 'timeout', minutes: 60, reason: 'spam' });
    expect(r.statusCode).toBe(200);
    expect(fake.moderationCalls).toEqual([{ op: 'timeout', userId: '990', minutes: 60, reason: 'spam' }]);
    expect(rows()).toEqual([{ kind: 'timeout', timed: 1, lifted: 0 }]);
    expect(db.prepare("SELECT action FROM admin_actions WHERE action = 'ticket_discord_sanction'").get()).toBeTruthy();
  });

  it('a refusal writes nothing and says why', async () => {
    fake.moderationRefusals.set('990', { ok: false, why: 'hierarchy', detail: 'x' });
    const r = await post(ADMIN, `/api/mod/tickets/${ticketId}/discord-sanction`, { kind: 'ban', reason: 'x' });
    expect(r.statusCode).toBe(409);
    expect(r.json().error).toMatch(/above the bot/);
    expect(rows()).toEqual([]);
    expect(fake.moderationCalls).toHaveLength(1);
  });

  it('a refused check never reaches Discord', async () => {
    const r = await post(MOD, `/api/mod/tickets/${ticketId}/discord-sanction`, { kind: 'ban', reason: 'x' });
    expect(r.statusCode).toBe(403);
    expect(fake.moderationCalls).toEqual([]);
  });

  it('an admin lifts a ban: Discord unbans, then the row is lifted; a moderator cannot', async () => {
    await post(ADMIN, `/api/mod/tickets/${ticketId}/discord-sanction`, { kind: 'ban', reason: 'x' });
    const sid = (db.prepare('SELECT id FROM discord_sanctions').get() as { id: number }).id;
    expect((await post(MOD, `/api/mod/discord-sanctions/${sid}/lift`)).statusCode).toBe(403);
    expect((await post(ADMIN, `/api/mod/discord-sanctions/${sid}/lift`)).statusCode).toBe(200);
    expect(fake.moderationCalls.map((c) => c.op)).toEqual(['ban', 'unban']);
    expect(rows()).toEqual([{ kind: 'ban', timed: 0, lifted: 1 }]);
  });

  it('a restricted ticket audits quietly and hides from a moderator not on its list', async () => {
    db.prepare('UPDATE tickets SET restricted = 1 WHERE id = ?').run(ticketId);
    expect((await post(MOD, `/api/mod/tickets/${ticketId}/discord-sanction`, { kind: 'timeout', minutes: 5, reason: 'x' })).statusCode).toBe(404);
    db.prepare("INSERT INTO ticket_access (ticket_id, steamid, added_by, created_at) VALUES (?, ?, 'system', 'x')").run(ticketId, ADMIN);
    const seen: AdminEvent[] = [];
    const off = subscribeAdminEvents((e) => seen.push(e));
    expect((await post(ADMIN, `/api/mod/tickets/${ticketId}/discord-sanction`, { kind: 'ban', reason: 'x' })).statusCode).toBe(200);
    off();
    expect(seen.filter((e) => JSON.stringify(e).includes('ticket_discord_sanction'))).toEqual([]);
  });
});
```

Check `subscribeAdminEvents`'s real return value and how `logAdmin` with `quiet` avoids publishing, by reading `tests/ticketRoutes.test.ts`'s existing restricted-audit test; mirror what it asserts rather than the guess above.

- [ ] **Step 2: Run it to see it fail**

- [ ] **Step 3: Implement.**

`src/server.ts`: add `discordModeration?: ModerationOps` to `ServerDeps` with a comment that it is a test seam; register the ticket routes with `moderation: () => deps.discordModeration ?? bot?.transport.moderation ?? null`. `bot` is declared before the route registration (see `let bot: RunningBot | null` near line 1143); if it is not in scope at that point, say so in your report and pass a getter that is.

`src/routes/tickets.ts`: add `moderation` to `TicketRouteOpts`, and the two routes as described. They are async and do not go through `act()`, which is synchronous; follow the shape of the existing `messages/:mid/remove` route, which also bypasses `act()`.

- [ ] **Step 4: Run the new test file, `tests/ticketRoutes.test.ts`, the full suite and typecheck.**

- [ ] **Step 5: Commit**

```bash
git add src/routes/tickets.ts src/server.ts tests/ticketDiscordSanctionRoutes.test.ts
git commit -m "Time out or ban a Discord-only member from their ticket, Discord first"
```

---

### Task 4: The ticket page

**Files:**
- Modify: `src/tickets/views.ts`, `web/src/api.ts`, `web/src/routes/admin/AdminTicket.tsx`, `web/src/routes/admin/TicketTimeline.tsx`
- Test: `web/src/routes/admin/AdminTicket.test.tsx` (add cases), `tests/ticketDiscordTargets.test.ts` (add one case for the detail)

**Interfaces:**
- Consumes: `sanctionsFor` (Task 1), the two routes (Task 3).
- Produces: the ticket detail gains `discordSanctions: SanctionRow[]` (empty for a player ticket); `modApi.discordSanction(id, kind, minutes, reason)` and `modApi.liftDiscordSanction(sid)`.

- [ ] **Step 1: Detail.** In `views.ts`, where the detail object is built (it already returns `bans`), add `discordSanctions: row.target_discord_id !== null ? sanctionsFor(db, row.target_discord_id) : []`. Add a test in `tests/ticketDiscordTargets.test.ts`: after inserting a `discord_sanctions` row for the Discord-only ticket's target, the detail carries it with `active: true`.

- [ ] **Step 2: Client.** In `web/src/api.ts`: a `DiscordSanction` interface matching `SanctionRow`, `discordSanctions: DiscordSanction[]` on the ticket detail type, and in `modApi`:

```ts
  discordSanction: (id: number, kind: 'timeout' | 'ban', minutes: number | null, reason: string) =>
    post(`/api/mod/tickets/${id}/discord-sanction`, { kind, minutes, reason }),
  liftDiscordSanction: (sid: number) => post(`/api/mod/discord-sanctions/${sid}/lift`),
```

- [ ] **Step 3: Timeline wording** in `TicketTimeline.tsx`'s `eventText`:

```ts
    case 'discord_sanction': return e.detail.kind === 'ban'
      ? `${who} banned them from the Discord: ${String(e.detail.reason ?? '')}`
      : `${who} timed them out in Discord for ${fmtMinutes(Number(e.detail.minutes))}: ${String(e.detail.reason ?? '')}`;
    case 'discord_sanction_lifted': return `${who} lifted the Discord ${e.detail.kind === 'ban' ? 'ban' : 'timeout'}`;
```

`fmtMinutes`: reuse whatever the ban length labels use (look for `LENGTHS` in `AdminTicket.tsx` and any minutes formatter in `web/src/format.ts`); if none exists, write a small local one ("1 hour", "3 days").

- [ ] **Step 4: Controls** in `AdminTicket.tsx`, in the `open` block beside the existing `{t.targetId && ( ...server ban form... )}`:

```tsx
            {!t.targetId && t.targetDiscordId && (
              <>
                <div class="admin-form">
                  <input value={reason} maxLength={500} placeholder="Reason (goes to Discord's audit log)" aria-label="Discord sanction reason"
                    onInput={(e) => setReason((e.target as HTMLInputElement).value)} />
                  <select value={minutes} aria-label="Timeout length" onChange={(e) => setMinutes((e.target as HTMLSelectElement).value)}>
                    {timeoutLengths.map(([m, label]) => <option key={label} value={String(m)}>{label}</option>)}
                  </select>
                  <button class="btn" type="button" disabled={busy || !reason.trim()}
                    onClick={() => run(() => modApi.discordSanction(t.id, 'timeout', Number(minutes), reason.trim()), {
                      title: `Time out ${t.targetName ?? 'this person'} in Discord?`,
                      body: 'The bot times them out in the Discord server. They cannot talk until it ends or an admin lifts it.',
                      confirmLabel: 'Time out',
                      danger: true,
                    }).then(() => setReason(''))}>
                    Time out
                  </button>
                  {data.viewer.isAdmin && (
                    <button class="btn" type="button" disabled={busy || !reason.trim()}
                      onClick={() => run(() => modApi.discordSanction(t.id, 'ban', null, reason.trim()), {
                        title: `Ban ${t.targetName ?? 'this person'} from the Discord?`,
                        body: 'The bot bans them from the Discord server. It lasts until an admin lifts it here.',
                        confirmLabel: 'Ban from Discord',
                        danger: true,
                      }).then(() => setReason(''))}>
                      Ban from Discord
                    </button>
                  )}
                </div>
                <p class="muted">A timeout or ban lifted by hand in Discord is not noticed here: lift it on this page too.</p>
              </>
            )}
```

`timeoutLengths`: the existing `LENGTHS` list filtered to entries with a number `m` where `m <= (data.viewer.banCapMinutes ?? 40320)` and `m <= 40320` (no permanent option for a timeout). If `minutes` state's default ('1440') is not in that list, it still works because one day is under every cap; keep it.

The sanctions list, visible whenever `data.discordSanctions.length > 0`, open or closed ticket, placed next to where the page shows the ticket's `bans`:

```tsx
        {data.discordSanctions.length > 0 && (
          <section>
            <h4>Discord sanctions</h4>
            <ul class="plain">
              {data.discordSanctions.map((s) => (
                <li key={s.id}>
                  {s.kind === 'ban' ? 'Banned from the Discord' : `Timed out until ${fmtTime(s.until!)}`} by {s.createdByName ?? s.createdBy}: {s.reason}
                  {s.liftedAt ? ` (lifted ${fmtTime(s.liftedAt)})` : s.active ? '' : ' (ended)'}
                  {s.active && data.viewer.isAdmin && (
                    <button class="chip" type="button" disabled={busy} onClick={() => run(() => modApi.liftDiscordSanction(s.id), {
                      title: `Lift this Discord ${s.kind}?`, body: 'The bot lifts it in Discord.', confirmLabel: 'Lift',
                    })}>Lift</button>
                  )}
                </li>
              ))}
            </ul>
          </section>
        )}
```

Match the file's real names (`fmtTime` is imported from `./useAction` in `TicketTimeline.tsx`; check what `AdminTicket.tsx` imports) and its class names; the snippets show intent and structure.

- [ ] **Step 5: Web tests** in `web/src/routes/admin/AdminTicket.test.tsx`, following its existing fixtures: a Discord-only ticket shows Time out and no server Ban; Ban from Discord shows only when `viewer.isAdmin`; a sanctions list with an active row shows Lift only to an admin; a player ticket shows no Discord controls.

- [ ] **Step 6: Full suite and typecheck.**

- [ ] **Step 7: Commit**

```bash
git add src/tickets/views.ts web/src tests/ticketDiscordTargets.test.ts
git commit -m "Show Discord timeout and ban controls on a Discord-only ticket, with the sanctions list"
```

---

## After the last task

- [ ] Deploy per the owner's standing rule (no players in game; back up the DB; verify tree hash, service, bot login).
- [ ] Live checklist for the owner (the fake cannot prove these): a timeout on a test account appears in Discord with the reason in the audit log; lifting removes it; a ban and an unban; a timeout on a member above the bot shows the hierarchy refusal; a timeout on someone who left shows the not-a-member refusal.
- [ ] Spec deviation to record: the spec says sanctions show on "the People desk's case view for that Discord id". A Discord-only person has no case view (the People desk is keyed by steamid), so the ticket page's sanctions list is that view. Once the person links Steam, their player case view does not yet list these rows; that is follow-up work, not 3c.
