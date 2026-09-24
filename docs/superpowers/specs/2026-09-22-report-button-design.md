# Report button: a form in Discord for filing a report

Design, 2026-09-22. Status: approved by the owner, not built.

## The problem

Nobody can tell where to file a report. The `#tickets` channel is empty and
nobody can post in it, so members read it as "the place you go to open a
ticket" and find nothing to do there. The owner read it that way himself.

The two real entry points are both easy to miss. On the site the report
control sits on a player's profile or a match page. In Discord `/report`
exists, but Discord only shows an option once it is required, so the command
looks finished after `player` and `reason` and most people submit without ever
seeing the `details` box. Its description, "When, which map, what they did",
leads with the map, so the people who do find it read it as a question about
maps. Reports are not map-specific.

This builds the thing everyone already assumes exists: a button in the channel
that opens a form.

## What this builds

A standing message in the renamed `#tickets` channel carrying one button,
**Report a player**. Pressing it opens a Discord modal with four fields: who,
a name box, a reason, and details. Submitting files a report through the same
`fileReport` the site and `/report` already call, so a report filed this way
is indistinguishable from any other once it lands.

It also fixes the `details` wording everywhere it appears.

## Decisions taken

Settled with the owner before this was written:

- **Players only.** A report is about someone with a `players` row.
  `tickets.target_id` is `NOT NULL REFERENCES players(steamid)`, and the one
  open case per accused rule, auto-restriction and merging all key on that
  column. Reports about an unlinked Discord member or someone outside the
  community are out of scope, and nothing here loosens the model to allow them.
- **One form, not two steps.** A dropdown of recent co-players plus a free
  text name box in the same modal, rather than a separate "who" step.
- **The button lives in the repurposed `#tickets`**, renamed. This is
  compatible with the owner blanking `discord_tickets_channel_id`, because
  that setting governs restricted tickets' private threads and nothing else.
  A blanked setting and a button in the same channel do not interact.
- **An ambiguous name holds the draft in a table**, not in memory, so a deploy
  cannot lose what someone typed.

## Out of scope

- Reports about people with no player record.
- Any change to the site's own report control, beyond the `details` copy.
- Removing or changing `/report`, which keeps working unchanged apart from
  that same copy.
- Phase 3's reporter threads. They will want this channel too, which is a
  reason to rename it rather than delete it, but nothing here builds them.

## The standing message

One message in the channel named by a new setting. Content explains that a
report is private and that the person reported is never told who reported
them. One button, `report:open`, primary style, label "Report a player".

Kept alive the way the ticket forum card already is. On bot ready and on every
reconcile tick, the module checks that the recorded message still exists and
matches the current content hash: missing gets re-sent, changed gets edited,
and an edit that returns false is treated as missing and re-sent. That last
rule matters because a failed edit reported as success is exactly what froze a
match card in place before (`safeEdit`, fixed in 32118ab).

The message id and content hash are kept in a singleton table, not in
settings. Every one of the 53 `DEFAULT_SETTINGS` keys has a matching entry in
`settingsSchema.ts`, so there is no such thing as a hidden setting here and
adding one would either invent that concept or put bot bookkeeping in front of
an admin. `matchmaker_state` is the existing pattern for singleton state.

```sql
CREATE TABLE IF NOT EXISTS report_message (
  id         INTEGER PRIMARY KEY CHECK (id = 1),
  channel_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  hash       TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
```

`channel_id` is stored so that changing `discord_report_channel_id` to a
different channel is handled rather than orphaning a button: the reconcile
sees the stored channel no longer matches the setting, removes the old message
if it can still reach it, and posts a fresh one in the new channel. A removal
that fails is not retried, because a stale button in an abandoned channel is
harmless once the row points elsewhere: pressing it opens the form and files a
report exactly as it should.

## The form

Modal `report:new`, title "Report a player", four of Discord's five allowed
fields:

1. `who`, a select, "Who are you reporting?". Its first option is always
   `Someone else (I'll type the name below)` with value `__other`, followed by
   up to 24 players from the reporter's recent matches, most recent first,
   deduplicated, excluding the reporter. A modal select has no optional flag,
   so the sentinel option is what removes the "filled both, filled neither"
   problem rather than a required/optional rule.
2. `name`, short text, `required: false`, "Or type their name".
3. `reason`, a select over `REPORT_CATEGORIES` using the existing
   `REPORT_LABELS` map. That map is currently module-private in
   `src/discord/commands.ts` and has to be exported for the modal to share it.
   Sharing it rather than copying it is the point: two lists of category
   labels would drift, and the one in `/report` is already the wording members
   have seen.
4. `details`, paragraph text, `required: false`, `maxLength: 1000` to match
   `MAX_TEXT` in `src/tickets/filing.ts`.

If the reporter has no recent matches the select still exists, carrying the
sentinel option alone: a select with zero options is not a valid modal.

The dropdown is built per press, so it reflects who that person actually
played with.

## Resolving who is being reported

1. `who` is a steamid: that is the target, done.
2. `who` is `__other` and `name` is blank: refuse, "Pick someone from the list
   or type their name."
3. Otherwise match the trimmed `name` against `players.name`, case
   insensitive: exact matches first, and only if there are none, substring
   matches.
   - Exactly one: file it.
   - None: refuse, "No player here by that name. They may never have played on
     these servers."
   - Two to five: hold the draft, reply privately with one button per
     candidate, file when the reporter presses one.
   - More than five: refuse, "Several players share that name. Type more of
     it, or pick them from the list if you played together recently."

Reporting yourself is refused wherever it is attempted: the reporter is
excluded from the dropdown, and a typed name that resolves to the reporter
gets "You cannot report yourself."

## Holding an ambiguous draft

```sql
CREATE TABLE IF NOT EXISTS pending_reports (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  reporter_id TEXT NOT NULL REFERENCES players(steamid),
  category    TEXT NOT NULL,
  text        TEXT NOT NULL DEFAULT '',
  typed_name  TEXT NOT NULL,
  candidates  TEXT NOT NULL,
  created_at  TEXT NOT NULL
);
```

`candidates` is a JSON array of the steamids offered. Rows older than an hour
are deleted on the reconcile tick, alongside the standing message check.

Each candidate button is `report:pick:<pendingId>:<steamid>`, comfortably
inside Discord's 100 character custom id limit. Pressing one checks that the
presser is the row's reporter before anything else, so a leaked id cannot be
used by someone else, then calls `fileReport` and deletes the row. A press
against a reaped row answers "That draft has expired, please file it again."

## Failure paths

Every reply is private. Nothing this feature does is ever visible in the
channel.

- Not linked to Steam: "Link your Steam account first with `/link`, then you
  can file a report."
- Anything `fileReport` refuses is surfaced as it is today, in the form
  `Could not file the report: <error>.` That covers the daily limit, duplicate
  rules, and a safety report with no details, which `fileReport` already
  rejects with "say what happened, so the right people can look into it".

The last one is the real fix for the confusion that prompted this work. The
details box is visible in the form, so a safety report cannot be attempted
without it and then refused for a reason the reporter never saw coming.

## The details rewording

The current copy leads with the map and reads as a question about maps.
Reports are not map-specific. Three places change to the same idea, "what
happened, in your own words":

- `src/discord/commands.ts`, the `/report` `details` option description.
  Discord caps an option description at 100 characters.
- `web/src/components/ReportPlayer.tsx`, the optional placeholder. The
  separate required placeholder used for `unsafe` stays as it is.
- The new modal's `details` field.

## What gets inherited rather than rebuilt

Because everything goes through `fileReport`, this feature does not implement
and cannot diverge on: reporter anonymity, one open case per accused,
automatic restriction when the target is staff or the reason is `unsafe`, the
`ticket_reports_per_day` limit, the duplicate rules, attaching the reporter's
latest shared match, or the forum post moderators work from.

## Code touched

- New: `src/discord/reportButton.ts`, holding the standing message, its
  reconcile, the modal definition, target resolution and the pending table's
  handlers.
- New settings key `discord_report_channel_id` in `src/settingsSchema.ts` and
  `src/db.ts` `DEFAULT_SETTINGS`, Discord group, empty allowed. Empty means no
  standing message and no button.
- `src/tickets/schema.ts`: the `pending_reports` and `report_message` tables,
  created the same way every other ticket table is.
- `src/discord/index.ts`: register the new prefixes through the existing
  `BotDeps.extraButtons` and `extraModals` seams and the `opensModal`
  predicate, which is what already lets a button answer with a modal.
- `src/discord/commands.ts`: export `REPORT_LABELS` so the modal shares it,
  and reword the `details` option description.
- `web/src/components/ReportPlayer.tsx`: reword the optional placeholder.

**No change to `src/discord/djsTransport.ts`.** Every primitive this needs
already exists and is in use: `send`, `edit`, buttons in a message, modals
carrying selects, and `opensModal`. This is the one part of the ticket system
that arrives with no unproven discord.js code, so it can be fully covered by
tests rather than by the owner's manual checklist.

## Testing

Against `tests/fakes/fakeTransport.ts`, as every other Discord path in this
repo:

- The standing message is created when the setting is set, re-sent when it has
  been deleted, edited when the content hash changes, and re-sent when the
  edit returns false.
- Blanking the setting stops the message being maintained.
- Pointing the setting at a different channel removes the old message and
  posts a new one there, and a removal that fails still leaves the row
  pointing at the new channel.
- The button opens the modal, and the dropdown holds the reporter's recent
  co-players, never the reporter.
- A dropdown pick files. An exact typed name files. A substring name that is
  unique files.
- An ambiguous name writes one `pending_reports` row and replies with one
  button per candidate; pressing one files and deletes the row.
- A candidate button pressed by anyone but the reporter is refused and files
  nothing.
- A pending row older than an hour is reaped, and pressing its button answers
  that the draft expired.
- An unlinked presser, a self-report, a name matching nothing, and a name
  matching more than five are each refused with the stated copy.
- A `fileReport` refusal is surfaced verbatim, with the daily limit and the
  empty safety report both covered.

## Risks

- **The dropdown is capped at 25 options by Discord**, one of which is the
  sentinel, so 24 co-players. Someone who plays constantly will not find an
  older opponent in the list and has to type the name. That is the designed
  fallback, not a failure.
- **Name matching is only as good as the names.** Players who share a name,
  or who have changed theirs, will land in the ambiguous path more often. The
  five candidate cap keeps that bounded but does not solve it. An alias table
  exists elsewhere in this project and is not deployed; wiring it in here is
  deliberately left out of scope.
- **The standing message is another thing the reconciler must keep alive.**
  It is one message in one channel, checked on the same tick as everything
  else, so the added cost is one API call per five minutes when nothing has
  changed.
