# Ban appeals: design

Date: 2026-10-04. Owner approved the design in chat, section by section.

## Problem

Banned players do not know what to do. The site's Banned panel says "To appeal, message an
admin in the Discord" without naming anyone, the On hold panel says the same about
moderators, the bot's refusal ("You are banned from the PUG: reason.") and the in-game kick
say nothing, and people timed out or banned from Discord by the bot (tickets phase 3c) get
no pointer at all. Appeals arrive as stray DMs to whichever staff member the player finds.

Many of these players are toxic and will abuse any open form, so the system must give them
as little surface as possible: no free intake, no conversation, no free text from staff.

## Owner rulings

1. **One shot.** The player submits once. Staff may ask at most one follow-up question, which
   the player answers once. Staff then decide; the player hears a fixed template.
2. **Who decides:** anyone at the issuer's rank or above, the issuer included (a mod's ban:
   any mod or admin; an admin's ban: admins only). Every decision is audited with its decider.
3. **Limits** (all in Settings, tunable without a deploy): see "Rules" below.
4. **Discord-banned people** appeal through a public page, `/appeal`, signed in with Discord.
5. The appeal channel is a plain text channel with one standing bot message, not a forum.
6. The owner has no Discord-banned test account; the `/appeal` Discord-only path is proven on
   a local site with a seeded `discord_sanctions` row instead.

## What can be appealed

An appeal is about exactly one of:

- a `bans` row that is active: a website ban (game servers + site + bot) or an alt hold
  (`kind='alt_hold'`);
- a `discord_sanctions` row that is active: a bot-run Discord timeout or ban.

Nothing else. There is no general contact form.

## Rules (`canAppeal`)

One function, `canAppeal(db, who, ref, now)` in `src/appeals/rules.ts`, answers
`{ ok: true }` or `{ ok: false, reason }`. Every entry point calls it and shows its answer
verbatim, and every submit calls it again inside the insert transaction.

| Rule | Setting | Default |
|---|---|---|
| Feature on | `appeals_enabled` | `false` |
| Shortest appealable ban (holds exempt) | `appeal_min_ban_hours` | 24 |
| Open appeals per ban | (fixed) | 1 |
| Wait after a denial | `appeal_cooldown_days` | 7 |
| Appeals per ban, all outcomes but `moot` | `appeal_max_per_ban` | 2 |
| Appeal text cap (per field) | `appeal_text_max` | 1500 |
| Follow-up answer cap | `appeal_answer_max` | 800 |
| Follow-up answer deadline | `appeal_answer_hours` | 72 |

Refusal reasons, each with its own player-facing line: `disabled`, `nothing_to_appeal`,
`too_short`, `already_open`, `cooldown` (with the date it opens), `limit_reached`,
`marked_final`.

"Ban length" is `expires_at - created_at`; a permanent ban is always long enough. The
cooldown runs from the latest `decided_at` among `denied`, `auto_denied` and `lapsed` appeals
on that ban.

A new `no_appeal INTEGER NOT NULL DEFAULT 0` column on both `bans` and `discord_sanctions`
gives `marked_final`. Only admins set or clear it (ban page and sanctions list).

## Data

New table `appeals` (boot migration in `src/appeals/migration.ts`, called from `openDb`):

```
id               INTEGER PRIMARY KEY AUTOINCREMENT
ban_id           INTEGER REFERENCES bans(id)
sanction_id      INTEGER REFERENCES discord_sanctions(id)
steamid          TEXT REFERENCES players(steamid)   -- appellant, when a player
discord_id       TEXT                               -- appellant, when Discord-only
what_happened    TEXT NOT NULL
why_lift         TEXT NOT NULL
state            TEXT NOT NULL CHECK (state IN
                   ('open','asked','answered','accepted','shortened','denied',
                    'auto_denied','lapsed','moot'))
question         TEXT, asked_by TEXT, asked_at TEXT
answer           TEXT, answered_at TEXT
decided_by       TEXT, decided_at TEXT
new_expires_at   TEXT                               -- when shortened
forum_thread_id  TEXT
created_at       TEXT NOT NULL
source           TEXT NOT NULL CHECK (source IN ('site','discord_button','appeal_page'))
CHECK ((ban_id IS NULL) != (sanction_id IS NULL))
CHECK (steamid IS NOT NULL OR discord_id IS NOT NULL)
```

Partial unique index: one row per `ban_id` / per `sanction_id` with
`state IN ('open','asked','answered')`, so a double submit cannot make two open appeals even
if it races `canAppeal`.

`appeals` must be registered in `mergePlayers` (rows move with the bans) and added to
`tests/db.test.ts`'s table list and `tests/mergePlayers.test.ts`'s FK sweep.

## State machine

```
open ──ask──▶ asked ──answer──▶ answered
 │              │                  │
 │              └─72 h, no answer─▶ lapsed
 ├──────────────┴──────────────────┴─▶ accepted | shortened | denied
 └─ slur in text ─▶ auto_denied (at submit; or at answer, from asked)
any open state ─▶ moot  (ban ended, lifted, replaced or extended some other way)
```

Every transition is one guarded `UPDATE ... WHERE id = ? AND state IN (...)`; zero rows
changed means "already decided" (409). This avoids the check-then-await race still open in
tickets 3c. Asking is allowed only from `open`, so there is never a second question.

`lapsed` and `auto_denied` count as denials for the cooldown and the per-ban limit. `moot`
counts for neither.

Moot detection: `liftExpiredBans`, `unbanPlayer`, `liftAltHold`, `banFromHold`, the Discord
lift route and any new ban/sanction that supersedes an old one each call
`mootAppealsFor(db, ref)`. A minute sweep (on the `liftExpiredBans` timer) also closes
`asked` appeals past their deadline as `lapsed`.

## Entry points

All three render the same two fields ("What happened", "Why should it be lifted or
shortened") and post to the same filing function, `fileAppeal`, in `src/appeals/filing.ts`.
The appellant identity always comes from the session or the Discord interaction, never from
the request body.

1. **Site, Steam session.** `Play.tsx`'s Banned and On hold panels gain an "Appeal this ban"
   button, or the `canAppeal` refusal line, or the state of the current appeal ("Under
   review", the one question with an answer box, or the outcome template). Data comes from
   `/api/me` (`ban.appeal`).
2. **Discord button.** Setting `discord_appeal_channel_id` (empty = off). The bot keeps one
   standing message with an **Appeal** button in that text channel, stored in an
   `appeal_message` singleton table (the `report_message` pattern). Pressing it runs
   `canAppeal` for the presser's linked Steam account (and their Discord id), then opens a
   modal or replies ephemerally with the refusal. If one Discord account owns several
   appealable bans, the modal carries a select of them. Timed-out members may be unable to use
   components, so the bot's timeout and ban DMs link to `/appeal` rather than to this button.
3. **`/appeal` page.** Public. Sign in with Discord (scope `identify`) into a short-lived
   appeal-only session (`appeal_sessions` table, 1 h TTL, no site privileges). It reuses
   `/auth/discord/callback` with an `appeal:`-prefixed signed state so no new redirect URI
   has to be registered. After sign-in it lists every appealable ban or sanction for that
   Discord id: its own sanctions, plus bans on any Steam account currently or previously
   linked to it. A Steam-signed-in visitor sees their own bans directly. Nothing to appeal
   means the page says so and shows no form.

Pointers added so people find it:

- `Play.tsx` copy changes from "message an admin" to the button.
- `banMessage` (`src/admin/players.ts`) appends "Appeal at riversidepug.com/appeal".
- `banCommand` (`src/serverBans.ts`) appends the same line to the `sm_addban` reason, so the
  in-game kick shows it. The five-minute sweep re-sends `sm_addban` for every open ban;
  planning must confirm a re-send with a new reason updates the reason on the box, or accept
  that only new bans carry it.
- The bot's Discord timeout/ban DM links to `/appeal`.

## Abuse controls

- No intake without an appealable ban (above). A throwaway Discord account gets "You have
  nothing to appeal".
- Rate limits per IP and per identity on `/appeal` sign-in and on every submit/answer route
  (Fastify rate-limit, same as other public routes).
- `findSlurs` (`src/slurs.ts`) runs on both fields and the follow-up answer. A hit means
  `auto_denied`, a conduct alert through the existing conduct-alert path, and the forum post
  is still made (marked "auto-denied") so staff see what was written.
- Text is stored plain, length-capped server side, shown as text on the site and through
  `escapeName` on Discord. No links or mentions render. Discord posts use
  `allowedMentions: none`.
- Outcome messages are fixed templates. Staff cannot attach free text to an outcome; the only
  free text staff send the player is the single question.

## Staff side

- **Forum post** per appeal in the existing staff forum, tagged "Appeal": the ban's reason,
  issuer, dates, linked ticket, link to the player's file, then both fields. The answer to the
  question is appended when it arrives. The post's audience follows the ban: a ban that came
  from a restricted ticket gets that ticket's restricted audience (`forumAudience`), and the
  appellant is never in it even if they are staff.
- **Site:** appeals appear on the tickets desk as an Appeal kind of case at
  `/admin/people/appeals/<id>`, with the case file and the redaction of `banIsWithheld` for
  viewers who cannot see the source ticket.
- **Decision controls**, shown to anyone at the issuer's rank or above (`canDecideAppeal`):
  Accept (lift), Shorten (pick a new end, must be earlier than the current one and in the
  future), Deny, Ask one question (only from `open`). Accept and Shorten go through the
  existing paths (`unbanPlayer` / `liftAltHold` / Discord lift route / an `expires_at`
  update), so `sm_unban` and Discord lifts happen exactly as today.
- Admin-only: mark a ban or sanction "no appeals".
- Staff guide gets an "Appeals" entry: the limits, the buttons, what auto-denied and lapsed
  mean.

## What the player hears

Fixed templates, shown on their site panel / `/appeal` page, and sent as a Discord DM when a
Discord id is known (DM failure is logged, never retried in a loop):

- received: "Your appeal was received. Staff will review it."
- asked: "Staff have one question about your appeal: <question>. You have 72 hours to answer."
- accepted: "Your appeal was accepted. The ban has been lifted."
- shortened: "Your appeal was reviewed. The ban now ends <date>."
- denied / auto_denied / lapsed: "Your appeal was reviewed and the ban stands." plus, when
  another appeal is allowed, "You can appeal again after <date>."
- moot: no message.

## Edge cases

- Ban ends, is lifted, extended or replaced while an appeal is open: `moot`, forum post notes
  why. A replacing ban starts its own count.
- Merge of two players: appeals move with their bans in `mergePlayers`.
- One Discord id, several banned Steam accounts: the entry point lists each; the player picks.
- Alt holds: Accept = `liftAltHold` (mods may); `banFromHold` from the Alts tab moots the
  appeal and the new ban can be appealed on its own terms.
- Two staff deciding at once: guarded UPDATE, second gets 409.
- Staff member appealing their own ban: they are excluded from the forum audience and from
  deciding.

## Testing

- `canAppeal`: every refusal and every rule boundary (min length, cooldown edge, limit, holds
  exempt, permanent bans, `moot` not counted).
- State machine: every allowed transition, every refused one, the guarded double decision,
  the lapse sweep, moot hooks on every lift path.
- Routes: site submit, answer, decisions with rank checks; `/appeal` with an appeal-only
  session; a body carrying another steamid/discord id is ignored; rate limits; appeal-only
  session cannot reach any other route.
- Discord button and modal on the fake transport (no `djsTransport.ts` change expected).
- Slur path: auto-deny, conduct alert, forum post still made.
- Full suite every task (the `db.test.ts` and `mergePlayers.test.ts` sweeps).
- Migration dry-run on a production DB copy, `PRAGMA foreign_key_check`, idempotent re-run.
- Local proof of the Discord-only path: local site, owner's Discord account, a seeded active
  `discord_sanctions` row; sign in at `/appeal`, file, decide, see the template.

## Rollout

- Web only; no plugin change.
- Everything off until `appeals_enabled` is turned on; the Discord button stays off until
  `discord_appeal_channel_id` is set.
- Web deploys may go out during live matches (2026-09-26 rule).
- Owner live checklist (only what the fake cannot prove): the standing message posts in the
  channel; the modal opens; the outcome DM arrives. The Discord-banned path is covered by the
  local proof above.

## Out of scope

- Conversation with staff, attachments, appeal of tickets or reports, appeals for kicks or
  queue timeouts, public listing of appeals.
