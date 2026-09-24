# Next tickets phase: scope decisions

Notes, 2026-09-22. Two decisions the owner took after the report button went
live. Nothing here is built. Both are spec changes rather than tweaks, and
they belong in one brainstorm because they share the private thread
machinery that phase 3 builds.

## 1. A reporter-initiated "chat with mods about this" button

Phase 3 as specced only lets moderators open a private thread with a
"Contact reporter" button. The owner asked for the reporter to have one too,
and that is the right call. The current asymmetry means someone files a
report about something upsetting and then has no way to add "he has messaged
me again since" except hoping a moderator reaches out first. Making the
reporter wait passively is the wrong default for a safety tool.

Agreed shape:

- The button sits on the reporter's own receipt after filing, and on their
  reports page on the site.
- It opens the same private thread a moderator's "Contact reporter" opens.
  One thread per ticket, so pressing twice reopens rather than spawning a
  second.
- Staff see it appear on the ticket as an event, like anything else.

Marginal cost is small, because phase 3 builds that thread machinery anyway.

**One condition, and it is a real one.** A button that says "chat with mods"
promises somebody is listening. If nobody watches the thread, it is worse
than not offering it at all, because the reporter concludes they were ignored
rather than that the feature is quiet. The copy must promise only what the
moderator team can keep, along the lines of "a moderator will reply here when
they can", and the moderators have to know these threads exist.

## 2. Reports must cover any Discord member, not only players

This reverses the players-only decision taken earlier the same day when the
report button was specced. It came from the owner's own feedback that
reporting has to cover behaviour outside the game: someone can be in the
Discord, never play, and still cause harm.

Measured gap: 165 player records, 145 with Discord linked, against 172
Discord members the bot tracks. Roughly a couple of dozen people cannot be
reported today, and a lurker who never plays is arguably the more likely
profile for this behaviour, not the less.

**Cost, measured rather than guessed.** `tickets.target_id` is referenced
across twelve source files: `db.ts`, `mergePlayers.ts`, `tickets/schema.ts`,
`filing.ts`, `store.ts`, `threads.ts`, `views.ts`, `actions.ts`,
`migrate.ts`, `routes/tickets.ts`, `discord/ticketSync.ts` and
`discord/ticketCard.ts`. The model leans on it in ways that are not obvious
from the column: `tickets_one_open` is a unique index on
`(target_id, restricted)`, auto-restriction reads the target's staff flag
through `hasStaffFlag`, and the merge tool repoints it.

**The framing that makes this cleaner than it first looked.** The earlier
proposal was to record an "unidentified person" as a heads-up rather than a
ticket, because the mental model was a typed name. That was wrong. A Discord
member is not unidentified: they have a stable snowflake id, and the bot can
offer a real member picker instead of a text box. So this is a second
identity namespace rather than a vague-subject feature. One open case per
target still holds, the ambiguous typed-name path is skipped entirely for
these, and if that person later links Steam their ticket can follow them
through the merge tool that already exists.

A sketch worth checking during design, not a decision: `target_discord_id`
beside a nullable `target_id`, with a CHECK that exactly one is set, and the
unique index taken over a COALESCE of the two.

**The open question that blocks the design.** What does a ban mean for
someone who is only in the Discord? They have no Steam account to ban from
the game servers, so it is either a Discord-side action (kick, ban, role) or
it is nothing and the ticket is a record only. That answer shapes the design
more than anything else here, so it is the first thing to settle.

## Unrelated items still open

- `discord_tickets_channel_id` is still set. The owner prefers restricted
  cases to get no Discord thread; clearing that field is the whole change,
  and there are still zero private threads to orphan.
- `/report`'s success copy still reads "they will not be told who reported
  them", where "they" binds to the moderators rather than the person
  reported. The same wording was fixed on the report button, so the two
  surfaces now differ. One line in `src/discord/commands.ts`.
- Production has an open ticket with a real forum post, the first time the
  ticket system's discord.js paths have run outside the fake transport.
  Worth checking the card, its tags and its Claim and Close buttons
  rendered correctly, since that validates a chunk of the phase 2a checklist.
