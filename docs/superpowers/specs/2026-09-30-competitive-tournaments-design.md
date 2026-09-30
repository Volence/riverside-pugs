# Competitive platform, part 2: tournament engine

Date: 2026-09-30. Status: design approved in conversation, awaiting written-spec review.
Depends on part 1, `2026-09-30-competitive-foundation-design.md` (match kinds, rulesets, teams,
bookings, crash recovery, notifications, live delay, side-locked spectating).
Research: `~/l4d/research/competitive-2026-09-30/tournaments.md`, `l4d-history.md`,
`elemental-overlay.md` (ideas only).

## Goal

Tournaments that run themselves on our own servers, from registration to trophies, with results
taken straight from the game and staff tools for when something goes wrong. Nothing like it has
existed in L4D: past leagues ran on outside platforms, spreadsheets and hand-reported demos, and
died when organizers burned out or sites disappeared.

### Owner decisions

- Staff create events for now; events carry an organizer and an `official` flag so community
  hosting can open later without a redesign.
- Short events (one night, players expected to be present) and long ones (multi-week, with
  rescheduling). Long ones run Swiss or a League season, then single or double elimination.
- Every stage plays standard competitive campaigns (every chapter except the finale, the PUG stop
  point) unless the organizer changes chapters for that stage.
- Short events: rolling matches with a "not before" time per round.
- Bo1 veto: alternate bans down to one; home/away aggregate available for finals.
- A tied match replays the last chapter.
- Check-in and roster lock are per-event settings.
- Match flow: veto, booking, lineup lock, connect.
- No public SourceTV; the public watches casters' streams or the live viewer delayed 90 s.
- Prize pools are recorded on the site; money moves off-site, handled by staff.
- Caster overlays via a caster studio built into the site (v1.1); Elemental stays Overwatch-only.
- Tournament matches never touch PUG SR.

## 1. Events and stages

### Event

`events`: id, slug, name, banner_key, region, organizer_steamid, official, entry_kind (`team` |
`draft`), status, starts_at, description (markdown), eligibility_json, team_cap, checkin_json,
roster_json, created_at, finished_at.

Status: `draft` (staff only) → `announced` → `registration` → `checkin` (only when check-in is on)
→ `live` → `finished`, or `cancelled`.

- **Eligibility** (JSON): minimum completed PUGs (default 5), account active and not banned,
  Discord linked, optional SR floor and ceiling. Checked at registration and again at check-in.
- **Check-in** (JSON): on or off; opens N minutes before start (default 60), closes M minutes
  before (default 15). Teams not checked in are dropped when it closes and the first stage is
  generated.
- **Roster rules** (JSON): starters 4, max subs (default 2), roster lock `none` / `at` a date /
  `after_round` N of a stage, and max roster additions before the lock (for season-style events).
  After the lock only registered subs can play; adding anyone needs staff approval.
- `entry_kind = draft`: registration is replaced by individual signups and the draft (part 3),
  which creates the entries.

### Stages

An event is a chain of stages. `event_stages`: id, event_id, ordinal, type, config_json,
ruleset snapshot (from the foundation's rulesets, copied when the stage starts), campaign_pool_json,
veto_type, chapters (`standard` or a number), scheduling (`rolling` | `window`), advance_count,
status.

Types:

| Type | Engine | Notes |
|---|---|---|
| `single_elim` | brackets-manager.js | optional third-place match |
| `double_elim` | brackets-manager.js | grand final reset on or off |
| `round_robin` | brackets-manager.js | groups supported |
| `swiss` | in-house | fixed number of rounds, top N advance |
| `league` | in-house | N weeks, X matches per week, standings, top N advance |

Examples: "League (6 weeks, 2 a week) → top 4 double elim"; "Swiss 4 rounds → top 8 single elim";
"one-night single elim".

Between stages, the next stage is seeded from the previous stage's final standings.

## 2. Entries and seeding

- `event_entries`: id, event_id, team_id (null for a pickup roster or a draft team), name, tag,
  logo_key (snapshots, so renaming a team later does not rewrite the archive), seed, status
  (`registered`, `checked_in`, `dropped`, `disqualified`, `eliminated`, `placed`), placement,
  registered_by, created_at.
- `event_entry_players`: entry_id, steamid, role (`starter`, `sub`, `coach`), added_at, removed_at.
- One entry per player per event, checked at registration, at every roster change and at check-in.
  The foundation's 3-team cap is untouched: an entry is not a team membership.
- **Seeding**: average SR of the four starters (current season), highest first. Staff can reorder
  seeds until the stage starts, and correct them afterwards through the admin tools (audited).

## 3. Pairing and brackets

### Elimination and round robin: brackets-manager.js

brackets-manager.js (MIT) owns the structure and result propagation for single elim, double elim
and round robin. It needs a storage adapter; we write one over SQLite with its own `bm_*` tables
(stage, group, round, match, match_game, participant). Our `event_matches` row links to its
`bm_match_id` and holds everything operational (booking, veto, lineups, results). On a final
result we call the manager's match update, and it advances the bracket. brackets-viewer.js renders
it, restyled to the site's poster look.

### Swiss (in-house, pure module `src/events/swiss.ts`)

- Points: win 1, loss 0 (no draws; ties are replayed).
- Round 1: top half of seeds against bottom half (1 v N/2+1, ...).
- Later rounds: group by points; pair inside a group from the top, never repeating an opponent;
  backtrack across groups when a group cannot be paired.
- Odd number of entries: a bye (counts as a win) to the lowest-ranked entry that has not had one.
- Standings order: points, Buchholz (sum of opponents' points; median Buchholz once there are 5 or
  more rounds), campaign score difference, head-to-head, seed.
- The pure module takes entries, results and history and returns pairings; it is unit tested
  against known tables and edge cases (odd counts, forced repeats, late drops).

### League (in-house, `src/events/league.ts`)

- N weeks, X matches per entry per week. Pairing per week is Swiss by record (the same module) or a
  full round robin spread over the weeks when the entry count is small (organizer's choice).
- Standings: wins, head-to-head, campaign score difference, Buchholz.
- Top N (advance_count) go to the playoff stage.
- A drop-out mid-season: its remaining matches are forfeits; results already played stand.

## 4. Match flow

`event_matches`: id, stage_id, round, slot, bm_match_id, entry_a, entry_b, status, best_of,
not_before, scheduled_at, window_start, window_end, booking_id, winner_entry, result_source
(`auto` | `admin` | `forfeit`), created_at, finished_at.
`event_games`: event_match_id, ordinal, campaign, chapters, side_choice_by, first_survivors,
match_id (the `matches` row of kind tournament), tiebreak_of (null or the game it breaks).

States: `pending` (an opponent not yet known) → `waiting` (both known, before the start time) →
`veto` → `lineup` → `booking` → `connect` → `live` → `confirming` → `done`; or `forfeit`, `bye`,
`admin_hold`.

### Start time

- Rolling (short events): the match starts as soon as both entries are free and the round's
  "not before" time has passed.
- Window (long events): the agreed time from section 5. The flow starts 20 minutes before it.

### Veto room (on the site, live over the websocket)

- Bo1 `ban_to_one`: the higher seed chooses to ban first or second; teams alternate bans until one
  campaign is left. The team that did not make the last ban chooses sides (who is survivors first).
- `home_away` (finals, Bo2 aggregate): each team picks one campaign; both are played; total score
  across both decides.
- `pick_ban` for Bo3 is supported by the same step engine (ban, ban, pick, pick, ban, ban,
  decider) for organizers who want it.
- Each step has a timer (default 60 s). Captains can save a preference order for the pool before
  the match; on timeout the room acts from that list (the least preferred campaign is banned),
  and the action is marked as automatic in the log.
- Captain or co-captain may act. The finished veto is public on the match page.
- `event_vetoes`: event_match_id, step, entry_id, action, campaign, at, auto.

### Lineup lock

Each captain picks the 4 who play from the entry's roster. Lineups stay hidden until both are
locked, then are revealed together. Timeout (5 min) uses the captain's default four (set on the
entry page) or the last four who played. `event_lineups`: event_match_id, game ordinal, entry_id,
steamids, locked_at, auto.

### Booking and connect

A tournament booking (foundation section 3) is made for the match. For window-scheduled matches the
booking is made when the time is agreed; for rolling matches at veto time, taking the next free box
in the region. Connect info goes to the 8 players on the site and by DM.

Who may be on the server: the 8 locked players, each entry's other roster members and its coach as
side-locked spectators, staff and casters. Everyone else is kicked (foundation allowlist). No public
SourceTV relay; the live viewer serves the public with the 90 s delay.

### Subs during a match

The captain can `!sub <out> <in>` between chapters, never mid-chapter. The incoming player must be
a registered member of the entry; the swap is logged and limited by the stage rules
(`subs.perMatch`, default 2).

### No-show and forfeit

- Grace from the rules (`noShowGraceMinutes`, default 15) starting when the server is ready.
- At the end of the grace, a side with fewer than `minPlayers` (default 4) connected loses by
  forfeit; if both are short, it goes to `admin_hold` and staff decide (double forfeit, delay, or
  play short-handed if both agree).
- Forfeits are recorded as such in standings and the archive (no fake scores).

### Result

- The game result comes from our servers through the existing capture (`completeMatch`); total
  campaign score decides.
- **Tie**: the last chapter is replayed as a tiebreaker game (`tiebreak_of` set); its score alone
  decides. Sides for the tiebreaker: the team that was survivors second in the original chapter
  starts as survivors.
- After the last game, the match sits in `confirming` for 15 minutes. Either captain can dispute,
  which opens a ticket (existing tickets system) with the replay and demo attached and moves the
  match to `admin_hold`. With no dispute it becomes `done` and the bracket or standings advance.
- Crash mid-game: the foundation's crash recovery restores the game; the match does not change
  state.

### In-game help

- `!admin`: posts a call to the staff desk (existing mod call path) and puts the game in an admin
  pause that only staff can lift.
- Staff can join any tournament server and freeze or unfreeze it.

## 5. Scheduling for long events

- Each round of a window stage has a default time and a window (for example "week 2: default
  Wednesday 21:00 UTC, play by Sunday 23:59").
- Either captain proposes another time inside the window; the other accepts or counters. An
  unanswered proposal auto-accepts after `reschedule_autoaccept_hours` (setting, default 24) if it
  was made at least 48 hours before the proposed time.
- The bot pings captains when a proposal arrives, 24 hours before auto-accept, and when a time is
  locked.
- Not played by the window end: if one side never answered and never showed, it forfeits; otherwise
  staff decide from the proposal log (`admin_hold`).
- `event_reschedules`: event_match_id, proposed_by, proposed_time, created_at, status, responded_at.
- All times are stored in UTC and shown in the viewer's time zone.

## 6. Admin tools (event desk)

A new Events desk in the admin area:

- Create and edit events, stages, rules, pools, prizes; publish.
- Seeds: reorder before start; correct afterwards.
- Per match: force a result, replay a chapter or half, move to another server (crash recovery path),
  swap a player, extend grace, reopen the veto, put on or release `admin_hold`.
- Per stage: rebuild a Swiss round (before any of its matches start), edit the bracket, disqualify
  an entry (its future matches become forfeits).
- Every action writes `admin_actions` and notifies both entries.

## 7. Presentation

### Event page `/event/:slug`

Banner, status and countdown to the next milestone; a format strip showing the stages; published
rules and campaign pool; prize pool and (opt-in) donor list; entries with logos, rosters and
average SR; live standings and brackets (websocket updates); schedule in the viewer's time zone; a
strip of live matches linking to the caster's stream when there is one, otherwise to the delayed
live viewer.

### Tournament match page

Today's match page plus team logos, the veto log, lineups, per-chapter and per-half scores, replays
and stats, and a match MVP from stats.

### Discord

Announcement, registration open, check-in pings, round pairings, match cards with team names and
logos, results, champion post with the trophy. Uses the foundation's notification module and the
existing card reconcile (`DiscordSync`).

### Trophies and archive

- `event_awards`: event_id, entry_id, steamid (null for team awards), kind (`champion`,
  `runner_up`, `top4`, `mvp`), created_at.
- Trophies show on player and team profiles.
- `/events` lists every event, past and upcoming. Finished event pages are permanent: entry names,
  logos and rosters are snapshots, so later renames and disbands never change history.

### Prize pool (off-site money)

- `event_prizes`: event_id, place, amount, currency, note, paid_at, paid_note. Staff mark payouts.
- `event_donors`: event_id, display_name, amount, show_publicly, note. Staff enter them.
- The site never moves money.

## 8. Caster studio (v1.1)

Designed now so the data model supports it; built after the first cup. It lives entirely on
riversidepug.com. The owner's Elemental Production tool (Overwatch) is not touched or linked: the
games and communities are separate. We reuse its ideas, not its code.

- **Overlay pages** `/overlay/<scene>?match=<id>`: scorebug (names, tags, logos, colours, current
  side, campaign score), chapter x half score table, veto result, lineups and player cards (L4D
  stats), bracket and standings, starting soon with countdown, BRB, lower third, series winner,
  live round HUD (survivor health and state, infected lineup and classes, progress, tank HP and
  control, tank and witch %), live 2D map. Added to OBS as browser sources.
- **Which matches**: any PUG, any tournament match, and a scrim only when both captains invited
  that caster (foundation, visibility).
- **Producer panel** `/cast/studio` (caster role): pick the match, switch scenes, edit the lower
  third, countdown and theme, and override any field. Overrides survive data updates (Elemental's
  override idea) until cleared.
- **OBS control from the browser**: the panel connects to the caster's local obs-websocket
  (`ws://localhost:4455`) with obs-websocket-js, so scene switches happen from the page with
  nothing installed. Optional; the overlays work without it.
- **Data**: everything comes from the event and live data we already hold; casters type nothing
  but their own names. Studio state (current scene, overrides, theme) is per caster session in the
  database so a panel reload loses nothing.
- **One connection for many sources**: OBS runs out of connections with 13+ browser sources each
  holding a live socket (learned in Elemental). The overlay pages share one connection through a
  SharedWorker; if that is unavailable they fall back to one socket per page for the live HUD and
  2D map only, and polling for the static scenes.
- **Auth and delay**: overlay URLs carry a per-caster signed token (revocable by staff); casters get
  no delay. Without a caster token the overlays refuse live data.
- **Theming**: event colours and fonts become CSS variables; an event can set its own palette and
  banner art.

v1.1 also adds the event MVP. A public API for third-party tools, and Pick'Em predictions, are
later.

## Error handling

- Every event and match state change is one transaction with an audit row. On web restart, matches
  resume from their state; open veto and lineup timers are re-armed from their stored deadlines.
- A veto or lineup step never waits forever: timeouts act from preferences or defaults.
- A booking that cannot get a server shows "waiting for a server" on the match and the event page,
  and alerts staff after 10 minutes.
- brackets-manager errors on update leave the match in `confirming` and alert staff; the bracket
  is never left half-advanced (the update and our state change share one transaction through the
  adapter).

## Testing

- Pure unit tests: Swiss pairing (seeded round 1, no rematches, backtracking, byes, drops,
  Buchholz and median Buchholz), league standings and tiebreaks, veto step engine for all three
  types with timeouts, reschedule auto-accept rules, tiebreaker game selection.
- brackets-manager adapter: round-trip of single elim, double elim with reset, round robin; result
  propagation through our transaction.
- Integration with the fake rcon and `DevOrchestrator`: an 8-entry one-night event from check-in
  to champion, including one forfeit, one tie with a tiebreaker, one dispute, one crash recovery.
- Visibility and delay: public viewers never get tournament live data newer than the delay.

## Rollout

Behind `competitive_enabled`. Plans in order, after foundation plans 1-4:

1. Events, stages, entries data model; staff event editor; event page (read-only); registration
   and check-in.
2. Swiss and league module; brackets-manager adapter and viewer.
3. Match flow: veto room, lineup lock, booking, connect, results, forfeits, disputes, `!sub`,
   `!admin`.
4. Window scheduling and reschedules.
5. Discord flow, trophies, archive, prizes.
6. v1.1: caster studio and event MVP.

## Out of scope here

Draft signups and the draft room (part 3); scrim board (part 4); Pick'Em; team rating; community
hosting (the `official` flag and organizer field keep it possible).
