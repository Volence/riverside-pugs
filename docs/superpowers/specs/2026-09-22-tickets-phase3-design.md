# Tickets phase 3: reporter chat and Discord-only people

Designed 2026-09-22 with the owner. Builds on `2026-09-21-tickets-design.md` (phases 1, 2a,
2b and the report button are live) and replaces its phase 3 section where the two differ.
Scope note that fed this: `2026-09-22-tickets-next-scope.md`.

## What changes and why

1. **Anyone in the Discord can be reported, and anyone in the Discord can report.** The
   owner's ruling: "Someone can not be a player but be in the discord and cause issues." Today
   both sides of a report must be a `players` row, which leaves roughly two dozen Discord
   members unreportable and unable to report.
2. **Reporters can open a chat with the moderators themselves**, not only wait for a mod's
   "Contact reporter". Someone who reported something upsetting needs a way to say "he has
   messaged me again".
3. **Mods can act on a Discord-only person**: a timeout, or for admins a Discord ban,
   carried out by the bot and recorded like a server ban.

Owner's rulings in this design session:

- A sanction on a Discord-only person is a Discord action run by the bot from the ticket.
  Mods may time out for up to 7 days; admins may time out for up to 28 days or ban.
- Discord-only people are reported from Discord surfaces only (the Report a player form and
  `/report`). The site's report form stays players-only.
- Discord-only members may file reports.
- When a reporter opens a chat, the claiming mod is added; if nobody has claimed the ticket,
  the mods with access are pinged.
- Reporter chat threads live under the same `#tickets` channel as the report widget. Private
  threads post no "started a thread" line and are invisible to non-members, so the channel
  stays clean for everyone else.
- Restricted tickets keep no staff discussion on Discord. A reporter's message on a
  restricted ticket goes to the site timeline, and the access list gets a DM with a link and
  no message content.
- Storage is two identity columns with a CHECK (approach A). Fake `players` rows and a
  general `subjects` table were rejected.

## 1. Identity and data

### People

Each side of a report is exactly one of:

- a **player**: a `players.steamid`, used whenever the Discord account is linked;
- a **Discord member**: a Discord snowflake id, used only when there is no linked player.

`src/tickets/person.ts` defines `Person = {kind:'player', steamid} | {kind:'discord',
discordId}` with helpers to read and write the column pair, a stable key
(`steamid` or `'d:' + discordId`) and a display name. The files that handle `target_id` today
work in `Person` so none of them special-cases the two columns.

### Schema

Rebuilt once in `ensureTicketSchema`:

- `tickets`: `target_id` becomes nullable. New `target_discord_id TEXT` and
  `target_name TEXT NOT NULL DEFAULT ''` (a display-name snapshot taken at filing, so a
  person who leaves or is banned still reads well). CHECK
  `(target_id IS NULL) <> (target_discord_id IS NULL)`.
- `tickets_one_open` becomes a unique index on
  `(COALESCE(target_id, 'd:' || target_discord_id), restricted) WHERE status = 'open'`.
- `ticket_reports`: `reporter_id` becomes nullable. New `reporter_discord_id TEXT` and
  `reporter_name TEXT NOT NULL DEFAULT ''`, with the same CHECK.
- `ticket_threads`: `ALTER TABLE ... ADD reporter_discord_id TEXT` (`reporter_id` is already
  nullable). A reporter thread has exactly one of the two set.
- `ticket_access`, `ticket_events` and `ticket_messages` do not change. Staff are always
  players.

New tables:

- `discord_sanctions (id, discord_id, kind 'timeout'|'ban', until, reason, ticket_id,
  created_by, created_at, lifted_by, lifted_at)`. `until` is NULL for a ban.
- `relay_messages (source_message_id PRIMARY KEY, relay_message_id, relay_thread_id)`, the
  link from a reporter's message to its copy on the staff post (section 3).
- `reporter_chat_pings (thread_id PRIMARY KEY, last_ping_at)`, for the once-an-hour cap.

### The rebuild

Detected by the absence of `tickets.target_discord_id`. With `foreign_keys = OFF` (it cannot
be changed inside a transaction), in one transaction: create `tickets_new` and
`ticket_reports_new`, copy every row, drop the old tables, rename, recreate every index,
then `PRAGMA foreign_key_check` must return nothing or the transaction rolls back. Turn
`foreign_keys` back on afterwards. Existing rows get empty name snapshots; readers fall back
to the players row, as today.

Before deploy: dry-run with the real `openDb` against a production backup, using the recipe
in the tickets memory. Row counts identical, `integrity_check` ok, `foreign_key_check` empty,
and a second open is a no-op.

### Linking folds a Discord person into a player

`adoptDiscordPerson(db, discordId, steamid)` in `src/tickets/adopt.ts` moves every
`tickets.target_discord_id`, `ticket_reports.reporter_discord_id`,
and `ticket_threads.reporter_discord_id` reference over to the steamid.
`discord_sanctions` rows stay keyed by Discord id, because Discord acts on that id; the People
desk shows them on the player's case view through the link. If that leaves two open
tickets about the same person with the same `restricted` flag, they fold the way
`mergePlayers` folds them. `linkDiscord` in `src/players.ts` calls it inside its
transaction. `MERGE_HANDLED_PLAYER_COLUMNS` gains the new nullable steamid columns.

### Auto-restrict

Today's rules stay: the accused is staff, or the category is `unsafe`. One is added: the
accused is a Discord-only member who holds the Discord Administrator permission, since they
can read every thread.

## 2. Filing from Discord

### Report a player form

Five fields, the modal maximum: co-player dropdown, **Discord member** (native user select,
new), typed name, reason, details. The accused is resolved in order:

1. the dropdown, when it is set to anything other than the `__other` sentinel;
2. otherwise the member picker. A picked member with a linked player goes against the
   player; otherwise against the Discord id, with the display name snapshotted;
3. otherwise the typed name, exactly as today, including `pending_reports` disambiguation.
   It stays for players who never linked Discord.

If the dropdown and the picker name two different people, the form is refused with "you
picked two different people", and the reply includes the typed details so nothing is lost.

Discord-only reporters see the same form. Their dropdown holds only the sentinel.

### `/report`

Gains an optional `member` user option beside the existing player option, with the same
resolution and the same two-people refusal.

### `fileReport`

Takes `Person` for both reporter and accused. It enforces every refusal, so no surface
re-implements one:

- self-report, compared by steamid and by Discord id (a linked reporter picking their own
  member);
- the accused is a bot;
- a player reporter not `inGoodStanding` (unchanged);
- a Discord-only reporter with an active `discord_sanctions` row, or currently timed out in
  Discord (the surface passes the member's `communicationDisabledUntil` in);
- a Discord-only reporter who filed within the last 10 minutes.

A Discord-only reporter cannot attach a match. `latestSharedMatch` runs only when both sides
are players.

### Transport

`transport.ts` gains a `userSelect` modal field and a `user` slash option type, implemented in
`djsTransport.ts`. They are on the live checklist, since the fake cannot prove them.

### Receipt

It stays ephemeral and neutral, and gains a **Chat with the moderators** button (section 3).

## 3. Reporter chat

### Entry points

One action, `openReporterChat(ticketId, reporter: Person)`, in `src/tickets/reporterChat.ts`,
behind:

- **Chat with the moderators** on the filing receipt;
- **My reports**, a new button on the standing widget message. It shows an ephemeral list of
  the presser's open reports, each with a Chat button. This is the lasting entry point for
  Discord-only reporters, who have no site login, since ephemeral receipts vanish on reload;
- **Chat** on the site's My reports page, for players. It needs a linked Discord, and says so
  when there is none;
- the staff **Contact reporter** button (site and staff post), which opens the same thread.

### Rules

- It works only on an open ticket, and only for someone who is a reporter on it. Otherwise:
  "This report is closed. File a new one if something has happened since."
- One thread per (ticket, reporter). Pressing again links to it; if the chat has ended, it
  unarchives, unlocks and adds the reporter back.
- A reporter may reopen a chat that staff ended. Staff are notified again, at most once an
  hour per thread (`reporter_chat_pings`).
- If the reporter is not in the server, the action says so and does nothing.

### Thread

A private thread under `discord_tickets_channel_id`, registered in `ticket_threads` with
`kind = 'reporter'`, so the 2b mirror reads it. Members: the reporter and the bot, plus the
claimer if the ticket is claimed. Opening message:

> This is a private chat with the moderators about your report. A moderator will reply here
> when they can.

Membership goes through a `reporterThreadAudience` function (the 2b handoff asked for one
separate from the staff audience). It holds the reporter plus staff who joined and still
have access. `ejectOutsiders` applies to it, so a demoted mod is removed.

### Notifications

- **Normal ticket:** a bot line on the staff forum post, "The reporter opened a chat",
  mentioning the claimer, or every mod with access when unclaimed. A **Join reporter chat**
  button on the staff post adds the presser.
- **Restricted ticket:** each person on the access list gets a DM: "The reporter wrote on
  ticket #N" and the site link, with no content. A **Join reporter chat** button on the
  site ticket page adds that mod to the thread.

### Restricted tickets stop getting a staff thread

The owner's ruling: restricted cases keep no staff discussion on Discord. From this phase a
restricted ticket creates no private staff thread; the access list is still DMed the site
link when the ticket opens, and discussion happens on the site. Production has no restricted
staff threads today, so nothing needs moving. `discord_tickets_channel_id` stays set, because
reporter threads need it as their parent.

### Relay and mirror

- Every message in a reporter thread is mirrored to the site timeline by the existing mirror.
- On a normal ticket, each reporter message (not staff replies, which they wrote in the
  thread themselves) is also relayed into the staff post as a bot message headed with the
  reporter's name. The relay hangs off `TicketMirror` and runs through its `serialise`, per
  the 2b handoff. Attachments relay as a site link, never re-uploaded.
- `relay_messages` links each original to its copy. Editing the original edits the copy;
  deleting or Removing the original deletes the copy. `removeMessage` gains a batch entry
  point so "Remove everything from this person" clears the copies in one pass.
- Restricted tickets have no relay target: timeline and DM only.

### Ending

- **End reporter chat** (staff, site and staff post) locks and archives the thread and
  removes the reporter.
- Closing the ticket ends every reporter chat on it, then sends the neutral close DM from
  the original spec: "Thank you for your report. The ticket is now closed."
- Remove and Remove everything from this person work on reporter-thread messages as on staff
  messages.

## 4. Discord sanctions

### Controls

On the ticket page, when the accused has no player record, the server-ban control is
replaced by:

- **Mods:** a Discord timeout of up to 7 days;
- **Admins:** a timeout of up to 28 days (Discord's maximum), or a Discord ban, which lasts
  until an admin lifts it on the site.

The caps are enforced in one server-side function, as bans are today. Players keep the
existing server ban; a combined server-and-Discord ban is out of scope.

### Order of operations

The bot calls Discord first. If Discord refuses (most often role hierarchy: the bot cannot
act on anyone whose top role is above its own, and Administrator members cannot be timed
out), nothing is written and the page shows the refusal in plain words. On success, one
transaction writes the `discord_sanctions` row, a ticket event and an `admin_actions` row.
The record never claims something Discord did not do.

### Lifting

The same rules as lifting a server ban. The bot removes the timeout or unbans, then the row
gets `lifted_by` and `lifted_at`.

### Where it shows

The ticket timeline, the admin audit log, and the People desk's case view for that Discord
id.

### Known limit, shown on the page

A timeout or ban lifted by hand in Discord is not noticed. The row stays active until an
admin lifts it on the site too.

### Transport

`timeoutMember`, `removeTimeout`, `banMember` and `unbanMember` in `djsTransport.ts`, on the
live checklist. The bot already has Administrator.

## Testing

- Fake-transport tests for every surface: form resolution order and the two-people refusal,
  `/report` member option, every `fileReport` refusal for both identity kinds, chat open,
  reopen, ping cap, relay, relay removal, end, close, sanctions caps and refusal ordering.
- A file-backed migration test: build the pre-phase-3 schema with rows in every ticket
  table, run `openDb`, and prove the rows survive, the foreign keys hold, the new CHECKs
  reject a row with both or neither identity set, and a second open is a no-op.
- `adoptDiscordPerson` tests, including the fold when both identities have an open ticket.
- The full suite on every task (`tests/db.test.ts` and `tests/mergePlayers.test.ts` guard
  cross-cutting tables).
- A dry run on a production backup before deploy.

### Live checklist (the fake cannot prove these)

- The member picker in the modal and the `/report` user option.
- Timeout, remove timeout, ban, unban, and each refusal message on a member above the bot.
- A reporter thread: created, reporter added, claimer added, reopened after archive.
- The relay onto the staff post and its deletion after Remove.
- The restricted-ticket DM.

## Out of scope

- Reporting Discord-only people from the site.
- A server ban for players that also bans them from Discord.
- Noticing sanctions changed by hand in Discord.
