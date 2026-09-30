# Competitive platform, part 1: foundation (match kinds, rulesets, teams, server booking)

Date: 2026-09-30. Status: design approved in conversation, awaiting written-spec review.

## Program context

The owner wants scrims, tournaments and draft tournaments that feel premier, "something L4D has
never had". This is the first of four specs:

1. **Foundation** (this document): match kinds, rulesets, privacy, teams, server booking, crash
   recovery, notifications.
2. **Tournament engine**: registration, check-in, Swiss (in-house) and single/double elimination
   (brackets-manager.js), veto room, fixed-time rounds for short cups, results from our servers,
   forfeits, event page, trophies.
3. **Draft layer**: individual signups, captain selection, live draft room, player cards with
   chemistry, fairness score, sub ladder, "Keep this team".
4. **Scrim board**: looking-for-scrim posts, reliability score, private reviews.

Later, not specified anywhere yet: multi-week leagues with reschedule proposals, auction drafts, a
team rating, caster overlays, Pick'Em, standing (recurring) scrims, one-click rebook.

The first thing players will actually play is a draft cup (specs 1-3). Research behind every
decision here is in `~/l4d/research/competitive-2026-09-30/` (codebase-map, scrims, tournaments,
draft-tournaments, l4d-history).

### Owner decisions this spec rests on

- Nothing outside our own site. Brackets, drafts, bookings all live on riversidepug.com.
- No teams exist today (answer C); the system has to create team culture.
- Tournaments are created by staff only for now, but the model carries an organizer and permission
  checks so community hosting can open later.
- Both short (one-night) and long events; long ones run Swiss into single or double elimination.
- Tournament and scrim matches never touch PUG SR. A team rating may come later.
- Region-aware from the start; every existing server is NA.
- A player may be on at most 3 teams, and plays for one team per event. Draft events are entered
  as an individual, so team membership never blocks them.
- Scrims can be played by a team or by a pickup group of friends, who can post or accept scrims
  exactly like a team.
- One standard game config everywhere by default; match rules (pauses etc.) vary per event.

## 1. Match kinds, rulesets, privacy

### Kind

`matches.kind` is `pug`, `scrim` or `tournament` (default `pug`, backfilled for every existing row).
`origin` (queue / in_game) stays as it is and only means where a PUG came from.

About 24 modules select completed matches with their own `state = 'completed'` filter (ratings,
playerStats, standings, weeklyAwards, chemistry, endorsements, metrics, Discord commands and more).
They all move to one shared definition:

- `src/matchKinds.ts` exports `COMPLETED_PUG_SQL` (completed, not voided, kind pug) and a
  `completedPugs` helper for the common joins.
- A test scans `src/` and fails on any raw `state = 'completed'` or `state='completed'` outside
  `matchKinds.ts` and an explicit allowlist (the result writer itself, admin tools that must see
  every kind). The next feature cannot quietly count scrims toward SR.

`applyMatchRatings` is only ever called for kind pug; the rules snapshot (below) also carries
`rated: false` for every scrim and tournament ruleset as a second guard.

### Rulesets: game config plus match rules

Two layers:

- **Game config (balance).** Table `game_configs` (key, label, cfg name, enabled). Staff approve
  entries; organizers and bookers can only pick an enabled one. Default is the standard competitive
  config (`pug_match` today, which execs rotoblin_pug_4v4). The config is the same everywhere unless
  someone deliberately picks another approved one.
- **Match rules.** Table `rulesets` (id, name, rules JSON, created_by, archived_at). Templates ship
  as "PUG" (today's behaviour exactly), "Standard Cup" (strict, admin override) and "Casual Scrim".
  An organizer copies a template and edits it for an event; an event may use different rules per
  stage (spec 2).

Rules JSON fields (all optional, template supplies defaults):

| Field | Meaning |
|---|---|
| `rated` | always false outside kind pug |
| `pause.limit`, `pause.seconds` | per side; null = unlimited |
| `pause.mutualUnpause` | unpause needs both sides to type `!unpause` |
| `pause.techPauses` | separate tech pause allowance |
| `teamLock` | keep rostered players on their side |
| `playerMapControl` | players may use `!nextmap`, `!stay`, change campaign |
| `restartHalf` | mutual `!restart` of the current half allowed; `lockAfterDamage` option |
| `noShowGraceMinutes` | default 15 |
| `penalties` | whether PUG no-show/abandon penalties apply (false for scrims) |
| `bosses` | `random_published` / `fixed` / `voteboss` |
| `sideRule` | `higher_seed_chooses` / `non_picker_chooses` / `coin` |

Every match stores `matches.rules_json` and `matches.game_config` as a **copy** made at creation.
Editing a ruleset later never rewrites history, and the match page can show the exact rules a game
was played under.

Enforcement: the orchestrator pushes the rules over rcon per match, the way it already pushes
`sm_pug_leave_budget` and friends. The plugin gains per-match versions of the settings that are
box-global today:

- `sm_pug_pause_seconds`, `sm_pug_pause_limit` (exist; now pushed per match), new
  `sm_pug_pause_mutual`, `sm_pug_tech_pauses`
- `sm_pug_team_lock` (exists; pushed per match)
- vote lock: `l4d_vote_lock` becomes pushable per match (scrims open `!load`/`!changemap` style
  control through our own commands, not the raw votes)
- `sm_pug_restart_half` mode

For kind pug the orchestrator pushes the PUG template values, which equal today's cfg values, so
PUG behaviour does not change.

### Visibility

`matches.visibility` is `public`, `participants` or `staff`.

- One access function `canViewMatch(viewer, match)` and one SQL fragment for lists
  (`visibleMatchesSql(viewer)`) in `src/matchVisibility.ts`.
- Every place a match can leak goes through it: `/api/matches`, `/api/matches/:id`, match page,
  replay endpoints (`/api/replays/match/...`), `/api/live`, SourceTV session lists and the
  Riverside News watch, the cast page, Discord result/live cards, profile history, the
  "replay ready" websocket push, weekly awards and skeet posts (already PUG-only by kind).
- Participants = the players, ringers and approved spectators of either side of that match.
  Staff and the anti-cheat analyzers (LOS, macro, LilAC, integrity) always see everything.
- Scrims default to `participants`. A scrim becomes public only if both captains tick "make public".
  Tournament matches are public.
- A test walks every route that returns match data with a non-participant viewer and a private
  match, and asserts nothing leaks.

### Profiles

The player page keeps PUG stats as the headline. It gains a Tournament tab (public) and a Scrim tab
(visible only to the player and staff; each scrim row inside it follows `canViewMatch`). PUG and
event numbers are never mixed.

## 2. Teams

### Tables

- `teams`: id, name, tag (2-5 chars), slug, logo_key, region, captain_steamid, origin
  (`site` | `draft` | `pickup`), origin_ref (event id or booking id), created_at, disbanded_at,
  join_link_token (null when off).
- `team_members`: team_id, steamid, role (`captain` | `cocaptain` | `member`), joined_at, left_at.
  Rows are never deleted; leaving sets `left_at`.
- `team_invites`: team_id, steamid, invited_by, created_at, responded_at, response.

### Rules

- Roster up to 8 (4 starters plus subs); 4 needed to enter an event.
- A player may hold at most **3 active memberships** (setting `team_membership_cap`, default 3),
  and may have created at most 3 teams that are not disbanded.
- Names and tags pass the existing conduct slur filter; unique case-insensitively; staff can rename
  or disband any team (audited via `admin_actions`).
- Joining: site invite, Discord DM with Accept/Decline buttons, or a join link the captain can turn
  off.
- Captaincy can be handed over. If the captain leaves: co-captain, else longest-serving member.
  A team with no members is disbanded automatically.
- Logos reuse the HUD community upload path (size and type limits, R2 storage).

### Events and teams

Entering an event snapshots the roster for that event (spec 2 owns the table). One team per event
per player is checked at registration and at check-in. Mid-event changes follow the event's sub
rules, not the team roster.

### Ways a team is born

- **Created on the site.**
- **From a draft**: after the event the draft captain gets "Keep this team"; if a majority of the
  drafted players accept, the team is created with origin `draft` and the event (with any trophy) as
  its first entry. The draft spec owns the flow; this spec owns the columns.
- **From a pickup group**: after a scrim, "Make this a team" creates a team with origin `pickup`
  and re-labels that side's scrim history to the new team.

### Team page `/team/:slug`

Public: logo, tag, roster, former players, trophies, event history and results. Members and staff
additionally see the Scrims tab (scrim history, replays, stats); for anyone else the tab does not
exist. Match cards and per-match Discord voice channels use team names and logos instead of
"Team A/B".

## 3. Server booking

### Model

- `bookings`: id, purpose (`scrim` | `tournament`), region, starts_at, ends_at, state, server_id
  (null until allocation), password, tv_password, game_config, rules_json, playlist_json,
  extended_minutes, created_by, created_at, held_at, ready_at, ended_at, end_reason.
- States: `scheduled` → `held` → `setup` → `ready` → `active` → `ended`, or `cancelled` /
  `no_show`.
- `booking_sides`: booking_id, side (a/b), team_id (null for a pickup group), captain_steamid,
  confirmed_at.
- `booking_people`: booking_id, side, steamid, role (`player` | `ringer` | `spectator`), status
  (`invited` | `accepted`), added_by. A pickup group is simply a side with no team_id; it never
  counts toward anyone's team cap.

Tournament bookings are created by the event scheduler (spec 2). This spec covers scrim bookings
between two known sides created by invite: side A books, invites side B (a team captain or a
player who then forms a group), side B confirms. The public looking-for-scrim board is spec 4.

### Limits (settings)

- Length 1 to 3 hours, in 30-minute steps; booked up to 14 days ahead.
- Up to 4 upcoming bookings per team or pickup captain. Each no-show in the last 30 days lowers
  that by one (minimum 1).
- No cap on evening (peak-hour) booking for now; the PUG reserve already protects the queue. Add a
  weekly peak-hours cap only if one team starts taking every evening slot.
- Playlist: up to 4 campaigns. The form suggests about 1 campaign per hour and warns when the
  playlist will not fit.

### Capacity, not a box

A booking reserves capacity in a region, not a specific server. The acceptance rule: at every
moment the booking covers, `enabled servers in region - overlapping bookings >= pug_reserve_servers`
(setting, default 2). Staff can lower the reserve for a tournament night; the site then shows
"Tournament night: PUG queue on N servers".

### Allocation and hand-over

- At T-15 minutes the booking picks a concrete box: idle, enabled, in region, prefer boxes with no
  lease. It becomes `held`; `claimIdle` stops giving it to new PUGs.
- A running PUG is never interrupted. If no box is free at T-15, the booking retries every minute
  and takes the first box released.
- Practice leases on the chosen box are warned and preempted exactly as ranked preemption works
  today.
- Setup copies the practice lease flow: forced restart, `exec` the booking's game config, push the
  rules and allowlist, set password, identity lines ("Booked by X vs Y until 23:00 UTC"), then
  `ready`. Connect info goes to both sides on the site and by DM.

### One holds module

Practice leases and side games each hide their box from the queue with their own SQL
(`NOT_LEASED_SQL`). Bookings would be a third copy, so all three move onto `src/serverHolds.ts`:
one `NOT_HELD_SQL` and one `holdFor(serverId)` answer, used by `claimIdle`, the balance writer and
the release engine. This is the only refactor of existing code in this spec, and it gets its own
tests before bookings land.

### Who may be on a booked server

The allowlist is each side's players, ringers and approved spectators, plus staff. The plugin kicks
anyone else on connect with a reason, so a leaked password is not enough to scout.

- Approved spectators are added by a side's captain on the site (Steam account). They can
  spectate in game and join that side's voice channel only.
- A captain can also `!allow <name>` in game during a 60-second grace window after someone
  connects; that adds a ringer or spectator for this booking. Otherwise the grace ends in a kick,
  and that player cannot rejoin this booking's server for 30 minutes (setting). A captain adding
  them on the site lifts the block at once.
- Ringers are always marked as ringers on the scrim record.

### Player control

Players never get the rcon password (it would expose the log secret, ban sync and our plugins).
Our plugin gives the booking's captains commands instead, each gated by the rules:
`!nextmap`, `!stay`, `!end`, `!extend`, `!restart` (both sides confirm), `!pause` / `!unpause`
(mutual if the rules say so), `!allow`, `!config <approved key>`.

### Games inside a block

Each game in a block is its own `matches` row: kind from the booking's purpose, visibility
`participants` for scrims, `booking_id` set, sides linked to `booking_sides`. Each gets its own
replay and stats. Nobody is kicked between games; the password stays; players reconnect freely with
no abandon penalty and no ready-check timers. A game starts when both sides ready up.

### Playlist flow

When a campaign reaches its stop point (the same `campaign_play_rules` stop the PUGs use), the
server announces: "Next: Blood Harvest in 60 s. `!nextmap` to pick another, `!stay` to replay this
one, `!end` to finish." The command reminder also shows at the start of every campaign. With no
objection the backend finalizes the finished game, opens the next match row and loads the next
campaign.

At the start of each campaign, if the typical duration (from our match history for that campaign)
exceeds the time left, players get: "About 45 min left, this campaign usually takes 70. `!extend`
now while the slot after is free." Reminders at 30, 10 and 5 minutes left.

### Lifecycle

- **No-show**: if a side is not on the server 15 minutes after the start, the other side may end
  the booking; the absent side gets a no-show on its reliability record (spec 4 turns that into a
  score).
- **Extend**: `!extend` adds 30 minutes if the capacity rule still holds for the extra time.
- **Idle end**: empty for 10 minutes ends the booking; everyone leaving after a finished game ends
  it at once.
- **End**: goodbye message, kick, release through `ServerReleaser` with a restart.
- **Admin**: a calendar of bookings on the admin Live desk with cancel and extend.

### SourceTV

SourceTV records every booked game (demos stay available to the participants, like replays), but
there is no public relay: `tv_password` is random per booking and never shown to players, and
booked servers are left out of the Riverside News watch, `/cast`, and every public server list.

### Voice

Each side gets a temporary Discord voice channel for the whole block (extending `voice.ts`),
visible only to that side's players, ringers, approved spectators and staff. It is deleted when the
booking ends.

## 4. Region, crash recovery, notifications

### Region

`servers.region`, `teams.region`, `bookings.region` and (spec 2) `events.region`, text, default
`na`. Capacity is counted per region. Nothing region-related is shown while only one region exists.

### Crash recovery (shared by scrims and tournaments)

rcon alone is never the signal: rcon to our boxes drops out regularly (the ban and admins pushes
log timeouts) while the game runs fine. Detection uses the same heartbeat as the orphan reaper
(`reapOrphanedMatches`): the plugin reports over the UDP log feed every 30 seconds.

- **srcds restarted** (the box answers again but the plugin reports no match, or the log shows a
  fresh server start): restore on the **same box**. This is the common case, since systemd brings
  srcds back in under a minute.
- **Box gone**: no heartbeat for 3 minutes AND no answer to an A2S query (a separate UDP path from
  rcon) for the same period. Only then does the booking move to another box. If A2S still shows
  players on the box, nothing moves; staff get an alert instead.

Recovery:

1. If the box is gone, the booking moves to another free box in the region (setup replayed, same
   password). Otherwise setup is replayed on the same box.
2. The match is restored to the map it was on, with scores from our own `match_rounds`.
   `!setscores` never writes the engine score, so the restore uses the seed-and-hold approach from
   pug-match 0.3.18 and gets its own test on the local server.
3. Staff get an admin feed alert; both sides get a notification with the new connect line.
4. If no box is free, the booking waits and takes the next box released, ahead of new PUGs. This is
   the only case where a booking outranks the PUG queue.

### Notifications

`src/notify/` decides who gets told what, over DM, channel post or site notice. Types include team
invite, booking invite, booking confirmed, starting in 60 and 15 minutes, no-show, moved after a
crash, results ready. Players can turn off each type (table `notification_prefs`). Specs 2-4 add
their own types through the same module.

## Error handling

- Every state change of a booking is a single transaction with an audit row; a restart of the web
  process resumes bookings from their state (as `PracticeLeases.resume` does today).
- A booking that fails setup twice goes to `cancelled` with `end_reason = setup_failed`, both sides
  notified, staff alerted. It does not count as a no-show.
- rcon calls follow the existing one-connection-per-turn rule (`src/rcon.ts`); nothing new opens
  parallel rcon sessions to a box.
- Allowlist changes are pushed immediately and re-pushed after every map load (the plugin loses
  per-match state on reload, see the setup reload race).

## Testing

- Unit: capacity rule (overlaps, reserve, staff override), allocation retry, playlist timing
  warnings, team caps and captain succession, rules snapshot, `canViewMatch`.
- Guard tests: no raw completed-match filters outside `matchKinds.ts`; every match route checked
  for leaks with a private match; PUG template pushes values equal to today's cfg.
- Integration with the fake rcon and `DevOrchestrator`: full booking lifecycle, preemption of a
  lease, no-show path, crash move to a second box.
- Plugin: allowlist kick and `!allow` grace, mutual unpause, `!nextmap` / `!stay` / `!end`, crash
  restore with seed-and-hold, on the local server in cheats mode.

## Rollout

Everything sits behind setting `competitive_enabled` (off). Implementation is split into plans in
this order, each shippable on its own:

1. Match kind, visibility, rules snapshot and the shared completed-PUG filter (no behaviour change
   for PUGs; proves the guard tests).
2. Server holds refactor.
3. Teams and team pages.
4. Bookings, plugin allowlist and commands, voice, SourceTV lockdown, notifications.
5. Crash recovery.

Plugin changes stage through the normal restart staging on all pool boxes; nothing deploys without
the owner's go-ahead.

## Out of scope here

Looking-for-scrim board, reliability score and reviews (spec 4); events, brackets, veto, check-in
(spec 2); drafts (spec 3); standing scrims, one-click rebook, team rating, leagues.
