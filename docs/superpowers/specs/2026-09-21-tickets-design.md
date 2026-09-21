# Tickets: player reports as cases, with a mirrored Discord discussion

Status: design approved in conversation 2026-09-21, spec written the same day. Nothing built.

Scope: web app and the in-process Discord bot. No plugin change, no game server change, no
cfg change. Work happens on the `worktree-tickets` worktree and nothing is deployed until the
owner says so.

Related: `2026-09-17-discord-bot-and-admin-design.md` (the existing report feature, the admin
feed, `BotTransport`), `2026-09-17-integrity-design.md` and
`2026-09-21-input-macro-detection-design.md` (evidence a ticket shows), the 2026-09 security
audit (why every free text field and every stored file here is constrained).

## Why

People are already being called cheaters, and at least one person has been reported as unsafe
for the community. Today a report is one text field tied to one match with Resolve and
Dismiss buttons. There is nowhere for mods to talk about it, no way to ask the reporter for
more, no link between a report and the ban it led to, and the only people who can see any of
it are full admins, who also hold root on four game servers.

## Decisions taken by the owner, 2026-09-21

1. **Participants:** mods and the reporter. Mods discuss privately; they can reach the
   reporter through the ticket. The accused is never part of a ticket. Appeals are out of
   scope.
2. **Discussion surface:** Discord, mirrored to the site. The site is read-only for chat.
   The ticket record, the actions and the case file live on the site.
3. **Reporter chat:** a private Discord thread, opened on demand by a mod, not for every
   report.
4. **Grouping:** one open case per accused player. Further reports attach to it.
5. **Sensitive cases:** auto-restrict when the accused is staff. Any ticket can be restricted
   by hand.
6. **Moderator tier:** a new `is_mod` flag on the site. Mods get tickets and nothing else: no
   settings, no server root. Access to the staff forum is granted by the bot from the flag.
7. **Filing:** any active player can report any other player at any time; a match is
   optional. New `unsafe` category that auto-restricts. Staff can open a ticket with no
   reporter.
8. **Ban power:** mods up to a cap (default 7 days), admins any length. The ban links to the
   ticket.
9. **Close message:** neutral and plain, "Thank you for your report. The ticket is now
   closed." The outcome is never told to the reporter.
10. **Attachments are downloaded and stored on the box**, and there must be a fast way to
    remove anything horrible that someone sends in. See "Removal" below; it is a first class
    feature, not an afterthought.

## Approach

Tickets are a new layer beside the old `reports` table, not a rewrite of it. Growing `reports`
in place would need a SQLite table rebuild (`match_id NOT NULL`, the `UNIQUE`, and the status
`CHECK` all have to change) and one row per report cannot express one case with many reports.
An off the shelf ticket bot was rejected because it leaves no case file on the site and
cannot tie into bans, replays, or the integrity data.

The standing rule from the bot spec holds: the website never waits on Discord and never fails
because of it. With Discord unconfigured or down, tickets work on the site alone.

## Data

All new tables are `CREATE TABLE IF NOT EXISTS` in `src/db.ts`, new columns via
`ensureColumn`. No `CHECK` on any status-like column, because those sets will grow.

- `players.is_mod INTEGER NOT NULL DEFAULT 0`.
- `tickets`: `id`, `target_id` (players.steamid), `status` (`open` | `closed`), `outcome`
  (`action_taken` | `warned` | `no_action` | `invalid` | null), `outcome_note`, `restricted`
  (0/1), `claimed_by`, `opened_by` (null when opened by a player report), `created_at`,
  `closed_at`, `closed_by`.
  Partial unique index on `(target_id, restricted) WHERE status = 'open'`. A restricted
  report never attaches to a ticket the whole team can read; it opens a restricted sibling.
- `ticket_reports`: `id`, `ticket_id`, `reporter_id`, `category`, `text`, `match_id` (null
  allowed), `map_ordinal`, `half`, `t_ms` (the optional replay moment, all null or all set),
  `created_at`, `legacy_report_id` (unique, null for new rows).
- `ticket_threads`: `id`, `ticket_id`, `kind` (`staff` | `reporter`), `reporter_id` (set for
  `reporter`), `channel_id`, `thread_id` (unique), `state` (`open` | `ended`), `created_at`.
- `ticket_messages`: `id`, `ticket_id`, `thread_id`, `channel` (`staff` | `reporter`),
  `discord_message_id` (unique), `author_discord_id`, `author_player_id` (null when
  unlinked), `author_name`, `content`, `history` (JSON array of earlier contents),
  `created_at`, `edited_at`, `deleted_at`, `removed_at`, `removed_by`, `removed_reason`.
- `ticket_attachments`: `id`, `message_id`, `filename`, `content_type`, `size`, `sha256`,
  `stored_name` (null when not stored), `skip_reason` (`too_large` | `type` | `quota` |
  `disabled` | `fetch_failed` | null), `removed_at`.
- `ticket_events`: `id`, `ticket_id`, `actor_id`, `kind`, `detail` (JSON), `created_at`.
  Kinds: `opened`, `report_attached`, `note`, `claimed`, `unclaimed`, `restricted`,
  `unrestricted`, `access_added`, `reporter_contacted`, `reporter_chat_ended`, `banned`,
  `removed`, `closed`, `reopened`.
- `ticket_access`: `ticket_id`, `steamid`, `added_by`, `created_at`. Only read for restricted
  tickets.
- `bans.ticket_id INTEGER` via `ensureColumn`.

### Migrating the old reports

Runs once inside `openDb`, idempotent through `legacy_report_id`. Open reports are grouped by
target into one open ticket each. Each resolved or dismissed report becomes its own closed
ticket (`resolved` to `action_taken`, `dismissed` to `invalid`), carrying `resolution_note`,
`resolved_by` and `resolved_at`. The `reports` table is left in place and no longer written.
`listReports` callers (`playerDetail.reportsAgainst`) move to the ticket queries.

## Permissions

`makeRequireMod` in `src/routes/guards.ts`: active and (`is_mod` or `is_admin`). Returns the
steamid like `requireAdmin` does.

| | player | mod | admin |
|---|---|---|---|
| file a report, see own reports | yes | yes | yes |
| see and work normal tickets | no | yes | yes |
| see a restricted ticket | no | only if on its access list | only if on its access list |
| ban from a ticket | no | up to `ticket_mod_ban_max_minutes` | any |
| remove a message or attachment | no | yes | yes |
| toggle `is_mod` | no | no | yes |

The accused can never see a ticket about themselves, restricted or not: every ticket query
excludes rows where `target_id` is the viewer. A restricted ticket is absent from lists and
returns 404, not 403, to anyone off its list.

`is_mod` does not feed `serverAdmins.ts`. Mods get nothing on the game servers.

## Filing

`POST /api/reports` with `targetId`, `category`, `text`, optional `matchId`, optional moment.
The existing match page routes and `/report` become thin callers of the same function.

- Categories: `griefing`, `cheating`, `toxicity`, `afk`, `unsafe`, `other`. `unsafe` requires
  text and makes the report restricted.
- Reporter must be active and not the target. No match roster requirement and no 48 hour
  window any more. If a match is given it must exist and the target must be on its roster.
- One report per reporter, target and match (and one match-less report per reporter and
  target per open ticket).
- Rate limit: `ticket_reports_per_day` (default 5) per reporter, counted from
  `ticket_reports`, so it survives restarts.
- Text capped at 1000 characters as today.
- Filing finds the open ticket for `(target, restricted)` or creates one. A report is
  restricted when its category is `unsafe` or the target is staff (`is_mod` or `is_admin`).
- A new restricted ticket seeds `ticket_access` from `config.adminSteamIds`, minus the
  accused. If that leaves nobody, it falls back to every admin minus the accused.
- Staff open a ticket with `POST /api/mod/tickets` (target, optional note, optional
  restricted). No reporter, no `ticket_reports` row.
- The accused is never told a report exists or who filed it.

Surfaces: a Report button on the player profile, the existing chip on the match page (which
pre-fills the match), and `/report` with `match` now truly optional (it still picks the
latest shared match from the last 48 hours when one exists, and says which in its reply).

## Discord

Two channels, both created by the owner and named in Settings:

- `discord_tickets_forum_id`: a forum channel hidden from everyone. The bot owns its
  permission overwrites: one per linked staff member, synced from `is_mod` / `is_admin` on
  bot start, on flag change, and on Discord link or unlink. Overwrites on one channel, not a
  role, so a bug here cannot hand anyone anything elsewhere.
- `discord_tickets_channel_id`: a text channel everyone can see and nobody can post in. It
  exists only to parent private threads. Staff get no Manage Threads here; membership of
  each private thread is explicit and bot-managed.

### Staff post

One forum post per normal ticket, titled `#<id> <name> (<category>)`. The starter message is
the case card: accused, report count and categories, links to the ticket page, the match and
the replay moment. Buttons: Claim, Contact reporter, Close (a modal taking outcome and note).
Tags for status and category, managed by the bot. A new report on an open ticket posts into
the thread, which bumps it. Closing locks and archives the post; reopening reverses that.
Bans are issued on the site only, so the cap logic lives in one place.

The old admin feed report card and its `r:` buttons are removed in phase 1. Until the forum
post exists (phase 2), a new normal ticket posts one plain line with a link to the admin
feed, so nothing arrives unannounced between phases. Phase 2 removes that line and the
`report` feed event. A restricted ticket never posts to the feed.

### Reporter thread

"Contact reporter" (site or Discord) opens a private thread in the tickets channel containing
that reporter and the mod who pressed it, with a short opening message. Other staff can join
with a button on the staff post. Every message the reporter sends is relayed by the bot into
the staff post, so the team reads everything in one place without joining. If the reporter
has no linked Discord or has left the server, the action says so and does nothing.

"End reporter chat" locks and archives the thread and removes the reporter from it.

### Restricted tickets

No forum post. The staff thread is a private thread in the tickets channel whose members are
the access list. People on the list get a DM with the site link when the ticket opens.
Reporter threads for a restricted ticket are relayed into that private thread.

Known limit, shown on the ticket page: anyone with the Discord Administrator permission can
read every channel and thread in the server. A restricted case about such a person is
private on the site but not on Discord. The page says this in plain words so the handler can
choose to keep the discussion off Discord.

### Mirror

`BotTransport` gains `ThreadOps` (create forum post, create private thread, add and remove
member, lock, archive, set tags, delete message, fetch messages after an id) and an inbound
hook for message create, update and delete. `djsTransport.ts` stays the only file importing
discord.js. Intents added: `GuildMessages`, `MessageContent`.

- Only messages in a thread listed in `ticket_threads` are read. Everything else is dropped
  before its content is looked at.
- Bot-authored messages are not mirrored; the timeline already has the events they describe.
- Edit: the previous content is pushed onto `history`.
- Delete in Discord: `deleted_at` is set and the content and files are kept. The case file
  survives someone tidying up after themselves.
- Backfill: on every bot start, and when a thread is reopened, the bot fetches messages
  after the last stored id for each open thread. Deploys restart the bot often, so this is
  what makes the mirror complete rather than best effort.

### Attachments

Discord CDN links are signed and expire in about a day, so the bot downloads each attachment
when it mirrors the message.

- Stored under `TICKET_ATTACHMENTS_DIR` (default: a `ticket-attachments` directory beside the
  database), outside the web root, under random names. Never in the database.
- Allowed types: png, jpg, gif, webp, mp4, webm, mov, txt. Anything else is recorded
  (name, type, size) and not stored.
- Caps: `ticket_attachment_max_mb` (default 25) per file, `ticket_attachments_ticket_mb`
  (default 200) per ticket, `ticket_attachments_total_mb` (default 2048) overall. Past the
  overall cap new files are not stored and a `problem` event goes to the admin feed.
- `ticket_store_attachments` (default on) is the kill switch: off means metadata only.
- Served only by `GET /api/mod/tickets/:id/attachments/:aid`, behind the same visibility
  check as the ticket. `X-Content-Type-Options: nosniff`, `Content-Security-Policy: sandbox;
  default-src 'none'`, inline only for the allowed image and video types, otherwise
  `Content-Disposition: attachment`.
- On the ticket page, files from the reporter channel are never shown until a mod clicks to
  reveal them. Files from the staff channel show as thumbnails.
- The attachments directory is deliberately not part of the 6 hourly database backup, so
  removing a file removes every copy the system holds.

## Removal

The threat: someone opens a ticket, gets a reporter thread, and posts something horrible.
The bot has by then copied it to the box. Getting rid of it must be one action, from
wherever the mod happens to be, and must leave nothing behind.

- **Remove**, on any mirrored message, from the ticket page or from Discord (a message
  context menu command, Apps > Remove from ticket, available to staff). It:
  1. deletes the stored files from disk,
  2. blanks `content` and `history`,
  3. deletes the message in Discord if it is still there,
  4. keeps a tombstone: who removed it, when, an optional short reason, and for each file its
     name, size and sha256, so there is a record that something was removed without keeping
     the thing itself.
  It cannot be undone. The site asks once through the app's confirm dialog. The Discord
  command acts immediately and replies ephemerally.
- **Remove everything from this person**, on a reporter thread: the same, for every message
  that author sent in the ticket, plus End reporter chat. One click for the worst case.
- Removal is different from a Discord delete on purpose: a delete is soft and keeps the
  evidence, a removal is hard and keeps only the tombstone.
- Any mod who can see the ticket can remove. Every removal writes a `removed` ticket event
  and an audit row that never contains the removed content.
- Banning the sender is the ordinary ban action on the ticket page; a banned player is not
  active and so cannot file again.

## Site

Mods see `/admin` with one tab, Tickets. Admins see it beside the existing tabs. The Reports
tab is replaced by it.

- List: Open, Mine, Closed, with counts; restricted tickets the viewer may see carry a mark.
- Ticket page:
  - header: accused, status, claimed by, restricted mark, Discord thread links;
  - the reports: reporter, category, text, match link, replay moment link;
  - the accused's case file, read from the pieces `playerDetail` already gathers: earlier
    tickets, bans, penalties, integrity and macro flags, aliases, shared networks;
  - one timeline interleaving `ticket_events` with mirrored messages, each labelled staff or
    reporter;
  - actions: claim, contact reporter, restrict, manage access, ban, remove, close, reopen.
- Live updates ride the existing `hub.broadcast('refresh')`.
- Closing takes an outcome and a note, both internal, and a "tell the reporters" tick (on by
  default) that DMs each reporter: "Thank you for your report. The ticket is now closed."
  A DM that Discord refuses is dropped silently, as with every other DM here.
- "My reports" on the player's own profile: what they filed, about whom, and open or closed.
  Nothing else. This is the fallback for people with DMs closed.
- Every mutation goes through `logAdmin`. For a restricted ticket the audit row is written
  but the admin feed event is suppressed, since the feed channel is readable by all admins.

Settings added (`DEFAULT_SETTINGS` plus `SETTINGS_SCHEMA`, so the UI is generated):
`discord_tickets_forum_id`, `discord_tickets_channel_id`, `ticket_mod_ban_max_minutes`
(10080), `ticket_reports_per_day` (5), `ticket_store_attachments` (1),
`ticket_attachment_max_mb` (25), `ticket_attachments_ticket_mb` (200),
`ticket_attachments_total_mb` (2048).

## Failure handling

- Thread creation is never in the request path. Filing commits the ticket, then publishes an
  event; the bot side creates the post. A reconciler on bot ready and every five minutes
  creates anything missing for open tickets and re-syncs forum overwrites.
- A failed attachment fetch records `fetch_failed` and is retried by the next backfill while
  the Discord link is still alive.
- Channel ids unset: no Discord work is attempted and the ticket page says discussion is not
  configured.
- Unknown Discord author on a mirrored message: stored with the Discord name and no player
  link. Never rejected.

## Testing

- Server: `openDb(':memory:')` and `app.inject`, as `tests/reports.test.ts` does. Grouping,
  the restricted sibling rule, rate limit, the permission matrix (player, mod, admin, accused
  staff, off-list admin), ban cap, migration of old reports run twice.
- Bot: `tests/fakes/fakeTransport.ts` gains threads, thread members, tags and inbound
  messages. Mirror create, edit, delete; backfill after a gap; reporter relay; overwrite
  sync; reconciler creating a missing post; nothing read from a thread that is not a ticket.
- Attachments: a fake fetcher. Type and size refusal, quota, kill switch, headers on the
  serving route, visibility on the serving route.
- Removal: files gone from disk, content and history blank, tombstone present, Discord
  delete requested, audit row free of content, "remove everything" covers every message by
  that author and ends the chat.
- Web: the ticket list and page with mocked `api`, click to reveal, the confirm dialog on
  remove.

## Build order

One spec, three phases, each shippable alone.

1. Tables, `is_mod`, filing, the site ticket list and page, restriction, bans from a ticket,
   migration of old reports. Useful with no Discord at all.
2. Staff forum post, overwrite sync, mirror with backfill, attachments, removal.
3. Reporter threads and relay, end chat, remove everything, the close DM, My reports.

## What the owner has to do

1. Discord developer portal: turn on the Message Content intent for the bot. A toggle; bots
   in fewer than 100 servers need no approval.
2. Create the forum channel and the tickets text channel (everyone can view, nobody can post,
   private threads allowed).
3. Paste both ids into Settings.
4. Mark the mods in the admin Players tab.

## Out of scope

Appeals and any contact with the accused. An in-game report command. Site-side commenting.
Blocking re-uploads by hash (the hash is recorded so this can be added). Automatic expiry of
old attachments.
