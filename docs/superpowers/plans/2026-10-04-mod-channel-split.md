# Mod Channel Split Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Lines a moderator should act on go to a new mod channel; automatic lines stay in `#inhouse-admin-logs`. Nothing moves until the owner pastes the new channel's id.

**Architecture:** One routing function, `feedChannel(db, event)`, in a new `src/discord/feedRouting.ts`, decides admin or mod channel per event kind (and per `action` for admin actions). `AdminFeedPoster` asks it instead of reading `discord_admin_channel_id` itself. In-game mod call cards also post to the mod channel, and because they are edited later, each row remembers the channel its card was posted in.

**Tech Stack:** TypeScript, better-sqlite3, `BotTransport` with `tests/fakes/fakeTransport.ts`, Vitest.

**Spec:** `docs/superpowers/specs/2026-10-04-mod-channel-split-design.md`

**Order:** build after `docs/superpowers/plans/2026-10-04-ban-appeals.md` is merged on this branch: it routes the `appeal` event kind and the `appeal_*` audit actions that plan adds. If built first, leave those two entries out and add them when appeals lands.

## Global Constraints

- Empty `discord_mod_channel_id` (the default) means every line goes where it goes today. Existing tests run with it empty and must pass unchanged.
- Per-kind on/off toggles (`admin_feed_*`) keep working exactly as now, whichever channel a line goes to.
- An event kind or action nobody routed goes to the admin log (fail toward the place everyone already reads).
- No em dashes anywhere. Full suite every task (`npm test`); known pre-existing failures are scrimRoutes/bookingRecovery and ECONNREFUSED noise.

## Planning calls (beyond the spec's table)

1. **Ticket actions go to the mod channel** (`ticket_open`, `ticket_claim`, `ticket_close`, `ticket_ban`, the Discord sanction lines and the rest of `ticket_*`), and so does `looked_at`. The spec table's "bans, unbans, notes, penalty clears" is moderators' work; ticket work is the same kind of thing, and a restricted ticket's actions are already logged quiet, so nothing new leaks.
2. **Failed/cancelled lobby and match cards** (`src/discord/sync.ts`) keep using `discord_admin_channel_id` directly: unchanged, nothing to do.

## Review Focus

1. A mod call card posted to the mod channel, then the setting changed (or cleared): the "handled" edit must still land on the original message, not fail against a channel that never held it.
2. Mod channel set, admin channel empty: mod lines post, admin lines post nowhere (today's "empty admin channel turns the feed off" holds for the admin half).
3. A per-kind toggle off (`admin_feed_conduct = 0`) with the mod channel set: still nothing posts.
4. The site's "calls are not reaching Discord" banner when only the mod channel is set: calls DO reach Discord, so no banner.
5. Existing rows from before the column: a card already posted in the admin channel can still be edited after deploy (backfill).

---

### Task 1: `feedChannel` and the setting

**Files:**
- Create: `src/discord/feedRouting.ts`
- Modify: `src/discord/adminFeedPoster.ts:50-54` (`channel`) and `:74` (its caller), `src/db.ts` (DEFAULT_SETTINGS), `src/settingsSchema.ts` (after `discord_admin_channel_id`)
- Test: `tests/feedRouting.test.ts`

**Interfaces:**
- Produces: `FEED_DESTINATION: Record<AdminEvent['kind'], 'mod' | 'admin'>`; `MOD_ACTIONS: ReadonlySet<string>`; `destinationOf(e: AdminEvent): 'mod' | 'admin'`; `feedChannel(db: DB, e: AdminEvent): string | null`; `modChannelOrAdmin(db: DB): string` (the mod channel when set, else the admin channel, else `''`; Task 2 uses it).

- [ ] **Step 1: Write the failing test** `tests/feedRouting.test.ts`

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { openDb, type DB } from '../src/db.js';
import { setSetting } from '../src/settings.js';
import { FEED_DESTINATION, MOD_ACTIONS, feedChannel, modChannelOrAdmin } from '../src/discord/feedRouting.js';
import type { AdminEvent } from '../src/adminFeed.js';

let db: DB;
beforeEach(() => {
  db = openDb(':memory:');
  setSetting(db, 'discord_admin_channel_id', 'admins');
});

const slur: AdminEvent = { kind: 'conduct_flag', steamid: '1', where: 'chat', text: 'x', slurs: ['r-word'], matchId: null, serverId: null };
const lilac: AdminEvent = { kind: 'lilac_flag', steamid: '1', cheat: 'aimbot', banned: false, matchId: null };
const action = (a: string): AdminEvent => ({ kind: 'admin_action', adminId: '9', action: a, target: '1', detail: {} });

describe('feedChannel', () => {
  it('with no mod channel, everything goes where it always went', () => {
    expect(feedChannel(db, slur)).toBe('admins');
    expect(feedChannel(db, lilac)).toBe('admins');
    expect(feedChannel(db, action('ban'))).toBe('admins');
  });

  it('with a mod channel, moderator lines move and automatic ones stay', () => {
    setSetting(db, 'discord_mod_channel_id', 'mods');
    expect(feedChannel(db, slur)).toBe('mods');
    expect(feedChannel(db, { kind: 'sourcetv_watch' } as AdminEvent)).toBe('mods');
    expect(feedChannel(db, lilac)).toBe('admins');
    expect(feedChannel(db, { kind: 'penalty', steamid: '1', penalty: 'no_show', matchId: null })).toBe('admins');
    expect(feedChannel(db, action('ban'))).toBe('mods');
    expect(feedChannel(db, action('ticket_claim'))).toBe('mods');
    expect(feedChannel(db, action('setting'))).toBe('admins');
    expect(feedChannel(db, action('something_new'))).toBe('admins');
  });

  it('every moderator action goes to the mod channel', () => {
    setSetting(db, 'discord_mod_channel_id', 'mods');
    for (const a of MOD_ACTIONS) expect(feedChannel(db, action(a)), a).toBe('mods');
  });

  it('a kind switched off posts nowhere, whichever channel it would use', () => {
    setSetting(db, 'discord_mod_channel_id', 'mods');
    setSetting(db, 'admin_feed_conduct', '0');
    expect(feedChannel(db, slur)).toBeNull();
  });

  it('mod channel set, admin channel empty: mod lines post, admin lines do not', () => {
    setSetting(db, 'discord_admin_channel_id', '');
    setSetting(db, 'discord_mod_channel_id', 'mods');
    expect(feedChannel(db, slur)).toBe('mods');
    expect(feedChannel(db, lilac)).toBeNull();
    expect(modChannelOrAdmin(db)).toBe('mods');
  });

  it('the spec\'s table, kind by kind', () => {
    const mod = Object.entries(FEED_DESTINATION).filter(([, d]) => d === 'mod').map(([k]) => k).sort();
    expect(mod).toEqual(['alt', 'appeal', 'conduct_flag', 'report', 'sourcetv_watch', 'spray_exploit', 'staff_message']);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/feedRouting.test.ts`
Expected: FAIL, missing module.

- [ ] **Step 3: Write `src/discord/feedRouting.ts`**

```ts
import type { DB } from '../db.js';
import { getSetting } from '../settings.js';
import { FEED_SETTING, type AdminEvent } from '../adminFeed.js';

/**
 * Which staff channel each feed line belongs in (owner, 2026-10-04): the mod
 * channel for lines a moderator should act on, the admin log for automatic
 * ones. Mods can read both; the split is about noise, not access.
 *
 * A Record, so a new event kind does not compile until somebody decides
 * where it goes. LilAC, input and cvar flags stay in the admin log because
 * they are frequent and reviewed in batches on Needs a look; spray crashes
 * and SourceTV watch are rare and need someone to act.
 */
export const FEED_DESTINATION: Record<AdminEvent['kind'], 'mod' | 'admin'> = {
  report: 'mod',
  appeal: 'mod',
  admin_action: 'admin', // per action, see MOD_ACTIONS
  penalty: 'admin',
  account: 'admin',
  problem: 'admin',
  abandon: 'admin',
  clock: 'admin',
  signon_drop: 'admin',
  input_flag: 'admin',
  cvar_flag: 'admin',
  conduct_flag: 'mod',
  lilac_flag: 'admin',
  spray_exploit: 'mod',
  steam_signal: 'admin',
  sourcetv_watch: 'mod',
  staff_message: 'mod',
  rename_digest: 'admin',
  alt: 'mod',
};

/** Audit actions that are moderation. Anything not listed is the admin log. */
export const MOD_ACTIONS: ReadonlySet<string> = new Set([
  'ban', 'unban', 'alt_lift', 'alt_ban', 'note', 'looked_at',
  'clear_penalty', 'clear_penalties', 'queue_remove', 'practice_kick', 'leave_clock',
  'ticket_open', 'ticket_claim', 'ticket_restrict', 'ticket_access', 'ticket_close', 'ticket_reopen', 'ticket_ban',
  'ticket_remove', 'ticket_discord_sanction', 'ticket_discord_sanction_lift', 'ticket_contact', 'ticket_chat_join', 'ticket_chat_end',
  'appeal_ask', 'appeal_accept', 'appeal_shorten', 'appeal_deny', 'appeal_final', 'appeal_unfinal',
]);

export function destinationOf(e: AdminEvent): 'mod' | 'admin' {
  if (e.kind === 'admin_action') return MOD_ACTIONS.has(e.action) ? 'mod' : 'admin';
  return FEED_DESTINATION[e.kind];
}

/** The mod channel when one is set, else the admin channel, else ''. */
export function modChannelOrAdmin(db: DB): string {
  return (getSetting(db, 'discord_mod_channel_id') ?? '') || (getSetting(db, 'discord_admin_channel_id') ?? '');
}

/** Where this line posts, or null for nowhere (its kind is switched off, or
 *  its channel is not set). An empty mod channel sends mod lines to the
 *  admin channel, as before the split. */
export function feedChannel(db: DB, e: AdminEvent): string | null {
  if (getSetting(db, FEED_SETTING[e.kind]) === '0') return null;
  const id = destinationOf(e) === 'mod' ? modChannelOrAdmin(db) : (getSetting(db, 'discord_admin_channel_id') ?? '');
  return id || null;
}
```

- [ ] **Step 4: Use it in `AdminFeedPoster`.** Replace the private `channel(kind)` method with nothing, import `feedChannel` from `./feedRouting.js`, and in `deliver` change `const channelId = this.channel(e.kind);` to `const channelId = feedChannel(this.deps.db, e);`. Remove the now-unused `FEED_SETTING` import if nothing else in the file uses it.

- [ ] **Step 5: Add the setting.** `src/db.ts` DEFAULT_SETTINGS beside `discord_admin_channel_id: ''`: `discord_mod_channel_id: '',`. `src/settingsSchema.ts` right after the `discord_admin_channel_id` entry:

```ts
  { key: 'discord_mod_channel_id', group: 'Discord', label: 'Mod channel id', help: 'Channel for lines a moderator should act on: slurs, /staff messages, in-game calls, alt holds, spray crashes, SourceTV watch, reports and appeals (when there is no tickets forum), and bans, notes and ticket work. Empty sends them to the admin channel as before.', type: { kind: 'string', maxLength: 32, allowEmpty: true } },
```

Also update the admin channel's help text to: `'Private channel for the admin feed. Empty turns the feed off, except lines that go to the mod channel when one is set.'`

- [ ] **Step 6: Run the test, then the full suite**

Run: `npx vitest run tests/feedRouting.test.ts tests/discordAdminFeed.test.ts` then `npm test`
Expected: PASS; `discordAdminFeed.test.ts` unchanged and green (mod channel empty there).

- [ ] **Step 7: Commit**

```bash
git add src/discord/feedRouting.ts src/discord/adminFeedPoster.ts src/db.ts src/settingsSchema.ts tests/feedRouting.test.ts
git commit -m "Admin feed: a Mod channel id setting; lines a moderator acts on go there, automatic ones stay in the admin log"
```

---

### Task 2: Mod call cards follow their channel

**Files:**
- Modify: `src/db.ts` (after `ensureColumn(db, 'mod_calls', 'handled_by_steamid', 'TEXT')` ~line 2026), `src/discord/modCallPoster.ts:108-127`, `src/routes/modCalls.ts:94`
- Test: `tests/modCallPoster.test.ts` (append), `tests/modCallRoutes.test.ts` (append)

**Interfaces:**
- Consumes: `modChannelOrAdmin(db)` from Task 1.
- Produces: column `mod_calls.discord_channel_id TEXT`.

- [ ] **Step 1: Write the failing tests.** Append to `tests/modCallPoster.test.ts` inside `describe('ModCallPoster', ...)`:

```ts
  it('posts to the mod channel when one is set', async () => {
    setSetting(db, 'discord_mod_channel_id', 'mods');
    call(); await poster.idle();
    expect(t.live().filter((m) => m.channelId === 'mods')).toHaveLength(1);
    expect(inAdmin()).toHaveLength(0);
  });

  it('a later edit goes to the channel the card was posted in, even after the setting changes', async () => {
    setSetting(db, 'discord_mod_channel_id', 'mods');
    const row = call(); await poster.idle();
    setSetting(db, 'discord_mod_channel_id', 'elsewhere');
    markModCallHandled(db, row.id, { steamid: IDS[7], discordId: '907' });
    await poster.idle();
    const card = t.live().find((m) => m.channelId === 'mods')!;
    expect(card.payload.embeds[0].description).toContain('Handled by <@907>');
    expect(getModCall(db, row.id)!.discord_channel_id).toBe('mods');
  });
```

Append to `tests/modCallRoutes.test.ts` a case in the style of its existing `discordReady` test: with `mod_calls_enabled = 1`, `discord_admin_channel_id = ''` and `discord_mod_channel_id = 'mods'`, `GET` the calls list as staff and expect `discordReady: true`.

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run tests/modCallPoster.test.ts tests/modCallRoutes.test.ts`
Expected: the new cases FAIL (card lands in `admins`; `discord_channel_id` undefined; `discordReady` false).

- [ ] **Step 3: Add the column, with a backfill.** In `src/db.ts` after the `handled_by_steamid` line:

```ts
  // The channel a call's card was posted in. Cards are edited later (folds,
  // Mark handled), and since the mod channel split the setting can point
  // somewhere else by then. Cards posted before this column were all in the
  // admin channel, so that is what they get.
  const modCallChannelIsNew = !(db.prepare('PRAGMA table_info(mod_calls)').all() as { name: string }[])
    .some((c) => c.name === 'discord_channel_id');
  ensureColumn(db, 'mod_calls', 'discord_channel_id', 'TEXT');
  if (modCallChannelIsNew) {
    db.exec(`UPDATE mod_calls SET discord_channel_id = (SELECT value FROM settings WHERE key = 'discord_admin_channel_id')
             WHERE discord_message_id IS NOT NULL`);
  }
```

Add `discord_channel_id: string | null;` to `ModCallRow` in `src/modCalls.ts`.

- [ ] **Step 4: Post to, and edit in, the right channel.** In `src/discord/modCallPoster.ts` import `modChannelOrAdmin` from `./feedRouting.js`. In `deliver`:

```ts
    // Blank channel: left pending. The site's banner says calls are not
    // reaching Discord, and the retry pass posts it once a channel is set.
    const channelId = modChannelOrAdmin(db);
    if (!channelId) return;
    try {
      const messageId = await transport.send(channelId, renderModCallCard(db, row, publicUrl));
      db.prepare("UPDATE mod_calls SET discord_message_id = ?, discord_channel_id = ?, post_state = 'posted' WHERE id = ?")
        .run(messageId, channelId, id);
```

In `refresh`:

```ts
    // Where the card IS, not where the setting points now.
    const channelId = parent.discord_channel_id ?? '';
    if (!channelId) return;
```

- [ ] **Step 5: The site banner.** In `src/routes/modCalls.ts` replace the `discordReady` expression's first line with `modChannelOrAdmin(db) !== ''` (import it from `../discord/feedRouting.js`).

- [ ] **Step 6: Run the tests, then the full suite**

Run: `npx vitest run tests/modCallPoster.test.ts tests/modCallRoutes.test.ts tests/modCallSchema.test.ts` then `npm test`
Expected: PASS. If `tests/modCallSchema.test.ts` lists `mod_calls` columns exhaustively, add `discord_channel_id`.

- [ ] **Step 7: Commit**

```bash
git add src/db.ts src/modCalls.ts src/discord/modCallPoster.ts src/routes/modCalls.ts tests/modCallPoster.test.ts tests/modCallRoutes.test.ts tests/modCallSchema.test.ts
git commit -m "In-game call cards post to the mod channel and remember where, so a later edit finds the card after the setting changes"
```

---

### Task 3: Verification

- [ ] **Step 1:** `npm run build && npm run typecheck && npm test`: green apart from known pre-existing failures.
- [ ] **Step 2:** Migration dry-run on a copy of the newest production backup (scratchpad only): open it twice with `openDb`; `mod_calls.discord_channel_id` is filled for every posted card with the old admin channel id; `PRAGMA foreign_key_check` empty.
- [ ] **Step 3:** Whole-branch review, then report. No deploy without the owner's go-ahead.

## Owner's live checklist (after deploy)

1. Create the mod channel (staff can read it, the bot can send and embed there), paste its id into Settings > Discord > Mod channel id.
2. The next `/staff` message or slur alert lands there; the next no-show stays in `#inhouse-admin-logs`.
3. An in-game call card lands in the mod channel and Mark handled edits it.
