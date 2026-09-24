# Admin desks: Live, People, Setup

Reorganise `/admin` around the three jobs admins actually do, put everything known about a
player in one file, and give the live-match job the controls it has been missing.

Designed with the owner 2026-09-21. Builds on the tickets work
(`2026-09-21-tickets-design.md`, phase 1 on master) and on the integrity, input-stats, LilAC,
connect-drop, network and Steam-signal features that each grew their own corner of the panel.

## Why

The tools are strong and scattered. To judge one player an admin opens Players for macro
flags, Integrity for LilAC flags and analyzer clips, Tickets for reports, and the Discord
admin feed for everything that scrolled past. Things get missed, which is how people get away
with things. Meanwhile the most common reason anyone opens the panel, a problem with an
ongoing match, has the thinnest screen: Void, Cancel, and nothing that shows who is missing
or stops a clock. The owner has lost a match to the abandon timer while scrambling to stop it
for a player who was seconds from reconnecting.

## Decisions taken by the owner, 2026-09-21

1. **Jobs, in order:** resolve something with an ongoing match; investigate a person; change
   settings. The landing page serves the first.
2. **The live-match problem that actually happens** is a player who cannot connect, dropped,
   or never showed. Stuck servers, disputes and intruders are rare so far.
3. **Wanted on the live board:** see the situation at a glance; control the clocks; cancel
   with a choice of who is penalised, and waive penalties afterwards.
4. **Not now:** a substitute system (not thought out yet) and pinging players from the board.
   Leave room for a sub action; build nothing.
5. **Mods see what admins see about a player,** shared-network data included. Only actions
   differ. (First ruling hid network data from mods; the owner reversed it the same day.)
6. **Bans live inside the panel,** not on a separate page.
7. **Layout:** three desks, Live, People, Setup (approach A). One merged evidence timeline
   per player rather than grouping by source.
8. **Clock controls:** Hold with a 30 minute ceiling, Add 5 minutes, End now.

## Approach

Three top-level areas replace the eight flat tabs.

| Desk | Who | Holds |
|---|---|---|
| Live (landing) | admins | match board, servers status, queue, recent results |
| People | admins and mods | player search, Player File, Needs a look, Bans, Tickets |
| Setup | admins | Settings, Servers, Campaigns, Seasons, Staff, Audit |

Rejected: keeping the tabs and adding cross-links (still eight places to look), and an
inbox-first panel (the main job is a live match, not triage).

Each desk is deployable alone. Old screens keep working until the step that replaces them
lands, and are deleted in that step, so there are never two versions of the truth.

## People

### Player File

Route `/admin/people/:steamid`. Today a player's admin view has no URL of its own; with one,
every admin-feed post, ticket, ban row and audit row links straight to the file.

Top to bottom:

1. **Header.** Name, avatar, SteamID, status (active, invited, banned, on timeout), role
   (admin, mod), SR, games. Actions: ban, timeout, note, sign out everywhere, merge, open a
   ticket. Each action renders only for a viewer allowed to take it.
2. **At a glance.** One row answering "is there anything here": open tickets, evidence items
   in the last 30 days per source, current ban, and the plain-worded Steam flags (new
   account, banned elsewhere, borrowed game, private profile, low hours).
3. **Evidence timeline.** One chronological list of everything: input detections, LilAC
   flags, analyzer clips, connect drops, tickets against the player, penalties, bans, notes,
   Steam alerts, Discord link changes. Each row: when, source badge, one-line summary, the
   match it happened in, and a link to the replay viewer at that moment when a replay exists.
   Filter chips per source. Wording keeps the existing "context, not a verdict" standard of
   the Integrity UI; severities are never coloured as accusations.
4. **Sections.** Identity (aliases, Discord link history, Steam account, shared-network
   sightings), Standing (bans, penalties, timeouts, each with lift or waive), Recent matches,
   Tickets.

### Timeline module

`src/admin/playerTimeline.ts` exports one function that returns
`TimelineItem[]` for a steamid (after alias resolution, so a merged alt's history is the
main's):

```ts
interface TimelineItem {
  at: string;                 // ISO
  source: 'input' | 'lilac' | 'analyzer' | 'drop' | 'ticket' | 'penalty' | 'ban'
        | 'note' | 'steam' | 'discord_link';
  kind: string;               // source-specific, e.g. 'pistol_rate', 'aimbot', 'clip'
  summary: string;            // one line, written server-side
  matchId: number | null;
  replay: { ordinal: number; half: number; tMs: number } | null;
  ref: { type: string; id: number | string } | null;   // what to open
}
```

Each source is one small adapter in that module's folder. A future source (per-tick aim
metrics) is one adapter, not a new screen. Adapters never throw: a failing source yields no
items and a logged error, and the file still renders.

### Visibility

One function, `src/admin/fileAccess.ts`, decides what a viewer may open and do. Rules:

- Admins open any file. Mods open any file except their own and the files of other staff
  (mods or admins). Anyone else gets 404.
- Mods see every section admins see, network sightings included.
- Actions: mods may add a note, mark "looked at", and open a ticket. Ban, timeout, merge,
  sign out everywhere, waive, staff flags are admin-only. A mod bans only from a ticket, up to
  `ticket_mod_ban_max_minutes`, exactly as the tickets spec says.
- Ticket rows in the timeline obey the tickets rules: a restricted ticket is absent for
  anyone off its access list, and nobody sees a ticket about themselves.

The API enforces every rule; the UI merely hides what would be refused. Tests assert that a
mod's requests for admin-only actions are refused and that staff files 404 for a mod.

### Fit with tickets

- The ticket page's "accused's case file" section becomes a compact summary rendered from
  the same builder (`playerFileSummary`), with an "Open full file" link. One builder, so a new
  source appears in both places.
- This spec does not touch ticket tables, the Discord mirror, attachments or removal.
- The one shared file is the ticket page's case-file section. Whichever work lands second
  rebases onto the shared summary component.
- A ticket appears in the timeline as one row (opened, closed, outcome). The discussion stays
  on the ticket page.
- "Open a ticket" on a file or a Needs-a-look row uses the tickets spec's staff-opened ticket
  (no reporter), so discussion happens in its Discord thread and the outcome is recorded.

### Needs a look

Players with evidence nobody has reviewed, newest first. Replaces the Integrity tab's board.

- New table `player_reviews` (`steamid`, `reviewed_by`, `reviewed_at`, `note`).
- A player is listed when their newest timeline item from an evidence source (`input`,
  `lilac`, `analyzer`, `steam` alerts, and `drop` only when the existing repeat rule fired:
  a second connect drop inside ten minutes with no clean entry between) is newer than their
  newest review. A single connect drop is retry noise and never lists anyone.
- "Looked at" writes a review row (optional note) and the player leaves the list until
  something new arrives. Reviews show in the timeline as notes.
- The analyzer's board columns (tracking, occupancy, control ranks) move into the file's
  analyzer rows and a sortable column set on this list, keeping the rounds gate and wording
  from analyzer version 4.
- The "Run analysis" and coverage panel of the Integrity tab moves to Setup, Servers.

### Bans

The `/bans` page moves in as a list: active and expired filter, reason, length, who, linked
ticket, and each row opens the Player File. Mods see it read-only. The standalone `/bans`
route redirects here.

### Tickets

The existing Tickets list and ticket page, moved under People unchanged.

## Live

Landing page for admins. One card per ongoing match (configuring, waiting, live, paused).

### Card

- Match line: server, campaign and map, state, score, elapsed. Links: match page, spectate.
- Eight players in their teams. Status per player, exactly one of: **on the server**,
  **never connected** (with time since the pop), **dropped** (time since they left and the
  allowance remaining, counting down).
- Reason under the status when known, never guessed: "rejected by the file check at 14:02"
  (from `signon_drops`), "not in a voice channel" (voice presence), "Steam ID not verified"
  (plugin kick reason). Unknown stays blank.
- Clocks running for this match, each as a countdown with its controls.
- Reserved slot for a future "Bring in a sub" action. Nothing is built.

### Player presence

The plugin already emits `LEAVE steamid= remaining=` and `RETURN steamid= remaining=` and
`PLAYER event=connect`; the parser reads them and nothing consumes LEAVE or RETURN. New
`match_presence` table (`match_id`, `steamid`, `state` `connected|dropped`, `since`,
`remaining_s`, `updated_at`), written from those three events. `connected_at` on
`match_players` keeps its meaning. Countdowns tick in the browser from `since` and
`remaining_s` and re-sync on every `refresh` broadcast.

### Clock control

Two clocks exist.

- **No-show** runs on the website (`noshow_minutes`, default 10, in `src/noShow.ts`).
- **Abandon allowance** runs in the plugin: `sm_pug_leave_budget`, 300 seconds per player in
  total, in `plugin/pug-leave.inc`. When it runs out the plugin emits ABANDON, the site
  confirms over RCON, aborts and bans.

Controls, identical for both: **Hold** (stops the clock until released, ceiling
`clock_hold_max_minutes`, default 30, after which it releases itself and says so in the
admin feed), **Add 5 minutes**, **End now**.

- No-show: new columns `matches.noshow_hold_until`, `matches.noshow_extra_s`. `noShow.ts`
  reads them. Web only.
- Abandon: new server command `sm_pug_leave <token> <steamid64> hold|release|add <seconds>|end`,
  `RegServerCmd` like every other backend command, token-checked with `TokenArgOk`. Hold
  freezes that player's allowance; release resumes it; the plugin enforces the same ceiling
  itself so a lost release cannot pin a server. It echoes the new state as a `LEAVE` line so
  the board updates through the normal path. Ships in the next pug-match release; against an
  older plugin the button is disabled with the reason shown.
- **The abandon control ships first.** It is the one that has already cost a match.
- **Low-allowance alert.** When a dropped player's remaining allowance crosses 90 seconds the
  admin feed posts "X has 85 s left in match #N" with a link to that card. Once per drop.
  A Hold button on the Discord message itself is a follow-up, not built here.

Every clock action goes through `logAdmin`.

### Cancel with a penalty choice, and waive

- Cancel opens a dialog listing who the automatic rules would penalise and why ("never
  connected", "abandon allowance ran out"). Per player: **as usual**, **no penalty**. One
  extra row lets the admin pick a different rostered player to penalise instead. Default is
  what the rules would do, so the fast path is one click as today.
- `matchTeardown` takes the chosen list instead of deciding alone; with no list it behaves as
  now.
- **Waive.** Every automatic penalty and abandon ban gets a Waive action (reason required):
  on the board's recent list and in the file's Standing section. A waive clears the penalty
  or lifts the ban, publishes on `banEvents` so the game servers follow, and restores
  `status_before_ban`. Logged.

### Below the board

Servers (status only), the queue, recent results with aborted and voided. All exist today and
move here.

## Setup

- **Settings.** The generated settings screen, unchanged.
- **Servers.** Configuration moves here from Matches: enabled, restart between matches,
  campaign install status, log signing mode and counters, analyzer coverage and "Run
  analysis". The Live desk keeps status only.
- **Campaigns**, **Seasons.** Unchanged.
- **Staff.** One list of admins and mods with their flags, replacing the admin toggle buried
  in a player's detail. Changing either flag ends that person's sessions.
- **Audit.** The existing log; each row links to the Player File or match it concerns.

## Routing

`/admin` redirects to `/admin/live` for admins and `/admin/people` for mods. Sub-routes
`/admin/people/:steamid`, `/admin/people/bans`, `/admin/people/tickets`,
`/admin/people/tickets/:id`, `/admin/people/review`, `/admin/setup/:section`. Existing ticket
URLs redirect. The tab state that lives in component memory today becomes the URL, so the
back button and shared links work.

## Failure handling

- A timeline adapter that throws yields nothing and logs; the file renders the rest.
- A clock command that the game server does not acknowledge leaves the board showing the old
  state and an error on the card; nothing is assumed. The plugin's own ceiling bounds a hold
  whose release was lost.
- A presence line for a player not on the roster is ignored.
- A waive whose ban lift fails to reach a game server is retried by the existing five-minute
  ban sweep.

## Testing

- Timeline: each adapter's items appear, sorted, alias-resolved; a throwing adapter does not
  break the file.
- Access: mod cannot open own file or staff files (404), cannot take admin actions (refused
  by the API, not only hidden), restricted tickets absent from a mod's timeline.
- Needs a look: appears on new evidence, leaves on review, returns on newer evidence.
- Presence: LEAVE, RETURN, connect sequences produce the right state and remaining seconds;
  unrostered ids ignored.
- Clocks: hold, release, add, end for no-show (time injected); ceiling auto-release; the RCON
  command strings for the abandon control; disabled against an old plugin.
- Cancel dialog: default equals today's behaviour exactly; overrides change who is penalised.
- Waive: penalty cleared, ban lifted, `banEvents` published, status restored, audit row.
- Routing: redirects, role landing pages, deep links.
- Plugin: `sm_pug_leave` compiles; `plugin/TESTING.md` gains hold, release, add, end and the
  ceiling, to be run with a real client on the local server.

## Build order

1. **People.** Timeline module and adapters, Player File, access rules, Needs a look, Bans
   moved in, shared summary on the ticket page, routes. Retire the Players detail and the
   Integrity tab at the end of this step.
2. **Live, part one.** Presence table and board, abandon-allowance control (plugin command),
   low-allowance alert.
3. **Live, part two.** No-show control, cancel with a penalty choice, waive.
4. **Setup.** Regroup, Staff list, Audit links, Servers section.

## Out of scope

A substitute system; pinging or DMing players from the board; a Hold button on the Discord
alert; any change to ticket internals; new detection sources.
