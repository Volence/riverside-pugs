# Discord Bot + Admin Panel Design

**Date:** 2026-09-17
**Supersedes the build order of:** `2026-09-06-dual-surface-design.md` (4b to 4f).
Its decisions still stand: the bot runs in-process, calls the same `Matchmaker`
as the website, and Steam stays the canonical identity.
**Builds on:** `2026-09-06-discord-identity-4b-design.md`, implemented as written
except where this spec says otherwise.

## Goal

Discord becomes a second, complete surface for the PUG. It follows everything
the website shows, at the same time: join the queue, ready up when it pops,
vote the campaign, get the connect info, and see the result. Each match gets
its own team voice channels. Slash commands expose the important site data.
Admins get a web panel that replaces editing sqlite by hand, including
reports and automatic no-show penalties.

Prior art the owner pointed at: InHouseQueue's queue embed (slots, Join/Leave
buttons, a website link button).

## Decisions made with the owner (2026-09-17)

| Question | Decision |
|---|---|
| Bot scope | Link + queue + ready + vote + connect + result posts + voice channels. Slash commands for site data. |
| Gate | Linking a Discord account that is in the guild activates the player. The invite code stays as the fallback. |
| Admin | Players + bans + notes, matches + queue control (abort, server idle, remove from queue, void a match), settings editor, reports, no-show penalties. |
| Result edits | No hand-edited scores. A bad match is **voided** and the season's ratings are recomputed. |
| Leavers | Out of scope. Nothing detects a mid-match leave today. |
| Overnight autonomy | Build, test, commit to master. Deploy the web app only when no match is configuring or live and the queue is empty. No game server, plugin or rcon changes. |

Bot credentials are in `/home/pug/app/.env` on the box and were verified
2026-09-17: token, client secret, guild (Left 4 Dead Revival), lobby channel
(`#queue-here`), Server Members Intent on, redirect URI registered, bot is
private, bot role has Administrator.

## Sub-projects and build order

| | Piece | Depends on |
|---|---|---|
| **A** | Identity: Discord link (OAuth on the site, one-time code from Discord), membership gate | nothing |
| **B** | Bot core: queue panel, pop/ready/vote/match message, connect, result post | A |
| **C** | Team voice channels | B |
| **D** | Slash commands | A |
| **E** | Admin panel: players/bans/notes/audit, matches/queue/servers, void + recompute, settings | nothing |
| **F** | Reports + no-show penalties | E (admin views), B (ready-fail hook) |

Each piece is independently shippable and leaves the site working if Discord is
unconfigured.

---

## A. Identity

Implemented per the 4b spec (`players.discord_id`, `discord_name`, partial unique
index, `/auth/discord` + callback with a signed session-bound `state`,
`DiscordApi` interface with a fetch implementation, gate via
`GET /guilds/{guild}/members/{user}`, optional `settings.discord_required_role_id`).
Revocation answer (4b's open question): the milder rule. Leaving the guild does
not touch an already active player. The gate only ever activates.

Added here: **the Discord-first link path.** A Discord user who presses any bot
button while unlinked gets an ephemeral reply: "Link your Steam account first"
with a link button to `PUBLIC_URL/link/discord?code=<code>`.

- `discord_link_codes(code TEXT PK, discord_id, discord_name, created_at, used_at)`.
  Code is 24 random url-safe bytes, valid 15 minutes, single use.
- `/link/discord` (web page): if not signed in, sends the user through Steam
  login and back to the same URL. Signed in, it POSTs `/api/discord/link-code`.
- `POST /api/discord/link-code {code}`: validates code (exists, unused, fresh),
  links using the same `linkDiscord` path as OAuth (so the "already linked to
  another player" rejection is shared), marks it used, runs the gate.
- Profile page: "Connect Discord" (OAuth) or the linked name with "Disconnect",
  only on your own profile.

Banned players are never activated by the gate.

## B. Bot core

### Shape

```
src/discord/
  api.ts         DiscordApi (REST, from A)
  transport.ts   BotTransport interface + discord.js adapter (the only file importing discord.js)
  presenter.ts   pure: state -> message payloads (embeds + components)
  controller.ts  interaction handling: custom_id -> player -> Matchmaker / DB
  sync.ts        keeps posted messages in step with state; owns discord_messages
  voice.ts       (C)
  commands.ts    (D) slash command definitions + handlers
  index.ts       startBot(deps): wires the above; no-op when unconfigured
```

`BotTransport` is the seam for tests: `send(channelId, payload) -> messageId`,
`edit(channelId, messageId, payload)`, `delete(...)`, `onInteraction(handler)`,
plus the voice operations C needs. Tests use an in-memory fake. The discord.js
adapter is thin and verified live, not unit tested.

The bot starts when `DISCORD_BOT_TOKEN`, `DISCORD_GUILD_ID` and
`DISCORD_LOBBY_CHANNEL_ID` are all set and `DEV_MODE` is off. A login failure is
logged and the site keeps running. While the bot runs, the webhook
`notifyDiscord` messages are suppressed (they would duplicate the bot).

### Reacting to state

`Hub` gains `subscribe(fn)`, so the bot hears every `broadcast(event)` the
website hears. `Matchmaker` gains a small listener list with two events the
broadcast cannot carry: `lobbyCompleted(lobbyId, matchId)` and
`lobbyFailed(lobbyId, ready, notReady)`, plus a public `lobbies()` returning
each lobby's id and snapshot.

`sync.ts` re-renders on any broadcast, **debounced to one pass per second**, and
also every 15 s as a backstop (the reapers change match state without
broadcasting). A pass reads `publicQueue()`, `lobbies()` and the open and
recently finished matches from the DB, renders payloads, and edits only messages
whose payload changed (compare a hash stored in memory).

Countdowns use Discord timestamps (`<t:unix:R>`), so nothing re-renders just to
tick a clock.

### Messages

Persisted in `discord_messages(id PK, kind, ref TEXT, channel_id, message_id, state, created_at, updated_at)`,
so a restart edits existing messages instead of posting duplicates.

1. **Queue panel** (`kind='panel'`, one row). Title "Riverside PUG Queue",
   "N/8 in queue", eight slot lines (mention if linked, else Steam name, with SR),
   buttons **Join Queue** (green), **Leave Queue** (red), **Website** (link to
   `/play`), **Leaderboard** (link). It is kept as the **last message** in the
   channel: whenever the bot posts a new message there, the panel is deleted and
   reposted (at most once per 5 s). Recreated if deleted by hand.
2. **Match message** (`kind='match'`, `ref` = lobby id, then re-keyed to the match
   id on `lobbyCompleted`). Posted when a lobby appears; content mentions the
   eight players so they get pinged.
   - *Ready check:* "Queue popped!" with the deadline, each player with a ready
     tick, button **Ready**.
   - *Vote:* one button per campaign in the pool with live counts, the voter's
     current pick shown in the ephemeral ack.
   - *Failed:* "Ready check failed. Not ready: ...", ready players went back to
     the front of the queue. Components removed.
   - *Teams set / waiting for server / live:* both teams with SR, campaign,
     state line, buttons **Connect** and **Match page**, plus the voice channel
     mentions from C.
   - *Finished:* components removed, one line "Finished, see result below".
3. **Result post** (`kind='result'`, `ref` = match id). New message on
   completion: campaign, final score, winner, every player's SR change
   (`displaySr` before/after from `rating_history`), link to `/match/<id>`.
   An aborted match edits the match message to "Match aborted" instead and posts
   nothing.

On boot, match messages still `state='open'` for a lobby id (lobbies are memory
only and died with the process) are edited to "Lobby cancelled (site
restarted)".

### Interactions

`custom_id` scheme: `q:join`, `q:leave`, `l:<lobbyId>:ready`,
`l:<lobbyId>:vote:<campaign>`, `m:<matchId>:connect`.

Every handler first resolves the Discord user to a player
(`playerByDiscordId`). Unlinked: the A link prompt. Then the same checks the HTTP
routes make, by calling the same functions:

- banned: "You are banned" (+ reason and expiry when set)
- not active: link/invite prompt
- timed out (F): "You can queue again <t:..:R>"
- `Matchmaker.join/leave/ready/vote` result mapped to a short ephemeral ack

`connect` answers only rostered players, ephemerally:
`connect host:port; password pug_xxxxxxxx` in a code block plus a link button to
`/play`. Never public, since the password is the only thing keeping randoms out.

All acks are ephemeral. Every interaction is acknowledged within Discord's 3 s
window (defer when a handler might be slow).

## C. Team voice channels

On `lobbyCompleted` (teams exist), when `settings.discord_voice_enabled` is `1`
(default):

- Create category `PUG #<matchId>` with voice channels `Team A` and `Team B`.
- Overwrites: `@everyone` View allow, Connect deny; each linked player of that
  team Connect + Speak allow; the bot all.
- Move each linked rostered player **who is already in a voice channel in the
  guild** into their team channel. Nobody is pulled in who is not in voice.
- The match message lists unlinked players so an admin can move them.
- `discord_voice(match_id PK, category_id, team_a_id, team_b_id, ended_at, deleted_at)`.

Cleanup: once the match is completed or aborted, `ended_at` is stamped; each sync
pass deletes the channels when both are empty, or unconditionally 10 minutes
after `ended_at`. Missing channels (deleted by hand) count as deleted.

Failures (permissions, rate limits) are logged and never block the match.

## D. Slash commands

Registered as guild commands on bot start (instant, no global propagation).
Public replies unless noted.

- `/profile [user]`: default self. SR, record, win rate, per-match SI dmg/commons,
  boomer %, top-5 badges from `playerStandings`, last 5 matches as links.
- `/leaderboard`: top 10 ranked by SR, with games and win rate, link to the page.
- `/matches [user]`: last 5 matches for a player, or the 5 most recent overall.
- `/queue`: current queue (ephemeral).
- `/link`: ephemeral link code (A) or "already linked to <steam name>".

A Discord user with no linked player gets "not linked" plus the link prompt.
Data comes from the same functions the HTTP routes use, extracted where they are
currently inline in `routes/stats.ts`.

## E. Admin panel

`/admin` in the web app, visible in the nav only to admins. Every `/api/admin/*`
route uses a new `requireAdmin` guard (active and `is_admin = 1`). Every mutation
writes `admin_actions(id, admin_id, action, target, detail JSON, created_at)`, and
the panel has an Audit tab listing them.

**Players.** Search by name, SteamID or Discord name. Row: avatar, name, status,
SR, games, Discord, no-show count (7 days). Detail:
- **Ban:** reason (required) + optional duration. `bans(id, player_id, reason, created_by, created_at, expires_at, lifted_by, lifted_at)`;
  sets `status='banned'` and removes them from the queue. The 60 s reaper
  interval lifts expired bans (status back to `active`).
- **Unban**, **Activate**, **Grant / remove admin** (cannot remove your own),
  **Unlink Discord**, **Clear penalties** (F).
- **Notes:** `player_notes(id, player_id, author_id, text, created_at)`, admins only.

**Matches, queue and servers.**
- Open matches (configuring/live): **Abort** sets `aborted`, `ended_at`, clears
  live scratch (`clearLive`), releases the server, broadcasts.
- Servers: status per row, **Set idle** (the releaser path the runbook uses).
- Queue: list, **Remove** per player (`Matchmaker.leave`).
- Recent completed matches: **Void** with a required reason. Adds
  `matches.voided_at`, `void_reason`; sets `state='aborted'` so every stat and
  leaderboard query drops it, then `recomputeSeasonRatings(db, seasonId)`.

`recomputeSeasonRatings`: in one transaction, delete the season's
`rating_history`, reset its `player_ratings` to openskill defaults and zero
wins/losses, then `applyMatchRatings` for every completed match of the season
ordered by `ended_at, id`. Tested: on an unchanged history it reproduces the
incremental result exactly.

**Settings.** A typed registry `src/settingsSchema.ts`: key, label, help,
type (`int` with min/max, `string`, `campaigns` = subset of known campaigns,
`bool`, `int list`). The panel only shows registered keys; `PUT /api/admin/settings/:key`
validates and returns a field error. `discord_webhook_url` and `invite_code` are
shown but masked until clicked.

## F. Reports and no-show penalties

**Reports.** `reports(id, match_id, reporter_id, target_id, category, text, status, resolved_by, resolution_note, created_at, resolved_at)`.
Category: `griefing | cheating | toxicity | afk | other`. Text up to 1000 chars.
- Filed from the match page: a "Report a player" button shown to roster members
  of that match within 48 h of `ended_at` (or during the match). Target must be
  on the roster and not yourself. One report per (reporter, target, match).
- Admin Reports tab: open first; resolve or dismiss with a note; links to the
  target's admin detail and the match.
- The reported player is never told who reported them.

**Penalties.** `penalties(id, player_id, kind, match_id, created_at, cleared_by, cleared_at)`,
kind `ready_fail | no_show`.
- `ready_fail`: every `notReady` player from `lobbyFailed`.
- `no_show`: when `reapNoShowMatches` aborts by rule 1 (not enough connected),
  every rostered player with `connected_at IS NULL`. Rule 2 (nobody readied in
  game) penalises nobody.
- Timeout: count uncleared offenses in the last `penalty_window_days` (7),
  pick from `penalty_minutes` (`[5, 15, 60, 1440]`, last value repeats), measured
  from the most recent offense. `penalties_enabled` (default `1`).
- `Matchmaker.join` refuses a timed-out player on both surfaces, and
  `stateFor` carries `timeoutUntil` so `/play` can show "You can queue again in
  12:04" with the button disabled.
- Admin detail shows history; **Clear** stamps `cleared_*`, logged.

---

## Testing

Test first, vitest, no network:

- A: the 4b test list, plus link-code expiry, reuse, and the shared
  already-linked rejection.
- B: presenter snapshots for every message state; controller with a fake
  transport and a real `Matchmaker` (join/leave/ready/vote parity with the HTTP
  routes, banned/unlinked/timed-out paths, connect only for the roster); sync
  edits only changed messages, reposts the panel last, cancels stale lobby
  messages on boot.
- C: overwrites per team, moves only players in voice, cleanup rules.
- D: each command's payload from seeded data.
- E: `requireAdmin` on every route, each action and its audit row, void +
  recompute equivalence, settings validation.
- F: timeout ladder and window, both penalty sources, join refusal on both
  surfaces, report eligibility rules.

The discord.js adapter is verified live after deploy with a checklist in the
plan (panel appears, join from Discord shows on the site and back, a real pop).

## Deployment and safety

- Migrations are additive (`addColumn` / `CREATE TABLE IF NOT EXISTS`), as today.
- Deploy only with no configuring or live match and an empty queue: a restart
  drops in-memory lobbies and the queue.
- The bot posting in `#queue-here` is expected once deployed with credentials.
- Anything decided without the owner overnight goes in
  `docs/superpowers/notes/2026-09-18-overnight.md`.
