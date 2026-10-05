# Mod channel: splitting the admin feed

Date: 2026-10-04. Owner approved in chat. Companion to `2026-10-04-ban-appeals-design.md`.

## Problem

Every staff line the bot posts goes to one channel, `discord_admin_channel_id`
(`#inhouse-admin-logs`), seen by all staff. Lines a moderator must act on (a slur, a `/staff`
message, an in-game mod call) are buried among automatic lines nobody acts on (no-shows,
Discord links, setting changes, LilAC flags). The split is about noise, not access: mods
already see the admin channel.

## Design

New setting `discord_mod_channel_id` (group Discord, "Mod channel id": "Channel for lines a
moderator should act on. Empty sends them to the admin channel as today."). Empty means no
behaviour change, so it ships dark.

`src/adminFeed.ts` gains `FEED_DESTINATION: Record<AdminEvent['kind'], 'mod' | 'admin'>`
next to `FEED_SETTING`, and admin actions are routed by `action` through
`MOD_ACTIONS: Set<string>`. One function, `feedChannel(db, event)`, returns the channel id:
the mod channel when the destination is `mod` and the mod channel is set, else the admin
channel. `AdminFeedPoster.channel` calls it; the per-kind on/off toggles keep working
unchanged.

| Mod channel | Admin log |
|---|---|
| `conduct_flag` (slurs in chat and names) | `penalty`, `abandon` |
| `staff_message` (`/staff` from game) | `account` |
| In-game mod call cards (`modCallPoster`) | `problem`, `clock`, `signon_drop` |
| `alt` (holds) | `lilac_flag`, `input_flag`, `cvar_flag` (frequent; reviewed on Needs a look) |
| `spray_exploit`, `sourcetv_watch` (rare, need action) | `steam_signal` |
| `report` (only when no tickets forum is set, as today) | `rename_digest` |
| Appeal lines (only when no tickets forum is set; see the appeals spec) | Failed/cancelled lobby and match cards (`sync.ts`) |
| `admin_action` in `MOD_ACTIONS`: `ban`, `unban`, `alt_lift`, `alt_ban`, `note`, `clear_penalty`, `clear_penalties`, `queue_remove`, `practice_kick`, `leave_clock`, appeal decisions | every other `admin_action`: settings, servers, seasons, voids, aborts, promotions, team edits, no-show changes, pops |

Owner rulings: LilAC, input and cvar flags stay in the admin log because they are frequent;
spray crash and SourceTV watch go to mods because they are rare and need someone to act.
`steam_signal` was placed with the noisy flags by Claude, owner may move it.

## Traps

- **Edits must follow the post.** Mod call cards are edited later (`modCallPoster` re-renders
  the parent). Today the edit re-reads `discord_admin_channel_id`. After the split the
  channel a card was posted in must be stored on the row (`mod_calls.discord_channel_id`,
  backfilled to the admin channel for existing rows) and edits use it, or a setting change
  sends edits to a channel that does not hold the message. Same check for any other
  feed line that is edited later.
- `routes/modCalls.ts:94`'s "is Discord ready" check must accept either channel.
- Unknown event kinds or actions (a new one added later without a destination) default to the
  admin log; a test enumerates every `AdminEvent['kind']` so a new kind cannot be forgotten
  silently (TypeScript `Record` already forces the kind table; the action set gets a test
  listing every action string `actionText` handles).

## Open, not in scope

Mods can already read lines about staff members in the admin channel (a staff member's ban,
a slur alert about staff), although the site hides staff bans from moderators. Unchanged by
this split. If that should be fixed, the admin log becomes admin-only and lines about staff
are routed there; owner to decide later.

## Testing

- `feedChannel` for every kind and every `MOD_ACTIONS` member, mod channel set and empty.
- Mod call: posted to the mod channel, setting changed, edit still goes to the original
  channel.
- Existing feed tests pass unchanged with the mod channel empty.

## Rollout

Web only. Owner creates the mod channel, pastes its id. Nothing moves until then.
