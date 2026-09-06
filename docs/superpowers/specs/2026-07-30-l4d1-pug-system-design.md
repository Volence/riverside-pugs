# L4D1 Ranked PUG System: Design

**Date:** 2026-07-30
**Status:** Approved design, pre-implementation
**Working name:** `pug` (rename later is a find-and-replace; not a blocker)

## What this is

A ranked pick-up-game (PUG) system for Left 4 Dead 1 versus, modeled on the L4D2
ranked hub sites: a website where players log in with Steam, queue up, vote on a
campaign when 8 are ready, get SR-balanced teams, and receive a connect string to
a freshly configured server. The server enforces the roster, runs the match on
the existing Rotoblin-AZMod 4v4 "harry potter" config, and reports results and
stats back. Ratings update after each match.

## Decisions made during brainstorming

| Topic | Decision |
|---|---|
| Concurrency | Pool of 2-3 fixed servers, picked per match. No dynamic provisioning. |
| Server topology | Start with one new srcds instance on the existing Dallas box (alongside the casual server, separate port). Second box added later by inserting a `servers` row. |
| Audience | Friends-only at launch (invite/vouch). Registration gates (hours, versus games) built but toggled off until opening to the public. |
| Rating system | OpenSkill (Weng-Lin/Plackett-Luce), TrueSkill-family with native team support. Not Glicko-2 (1v1-only model, needs ad-hoc team hacks; rating periods don't fit per-match updates). |
| Match format | Full campaign **minus finale**, winner by total score. Finale inclusion becomes a toggle later. |
| Stats | Results + core per-player stats at launch, schema designed for expansion. |
| Stack | TypeScript monolith. Chosen by Claude per "you pick." |
| Backend↔server transport | RCON (backend→server) + `logaddress_add` UDP log stream (server→backend). **No SourceMod extensions**, nothing that risks not loading on the 2009 L4D1 engine. HTTP-extension approach (SteamWorks/ripext) deliberately rejected as foundation; possible later upgrade. |
| Discord | Webhook notifications only (queue status, match found, results). No bot. |
| Seasons | Not a launch feature, but the schema is season-aware from day one (all ratings/matches keyed by season) so a future leaderboard reset is an insert, not a migration. |

## Architecture

Two deployables plus existing infrastructure:

### 1. `pug-web`: TypeScript monolith

One Node.js process on the Dallas box behind Caddy (TLS + domain). Contains:

- **Frontend:** queue UI, ready check, map vote, live match page, player
  profiles, match history, SR leaderboard, admin panel.
- **API + websockets:** live queue counts, ready-check prompts, vote state,
  match status pushed to connected clients.
- **Matchmaker:** queue → ready check → map vote → team balance state machine.
- **Orchestrator:** server pool management, RCON client, match setup/teardown.
- **UDP log listener:** receives srcds `logaddress` streams, parses structured
  plugin lines, drives live match state.
- **Rating engine:** OpenSkill via the `openskill` npm package.
- **Discord notifier:** webhook POSTs.
- **Storage:** SQLite (friend-group scale; zero-ops; easy backup).

### 2. `pug-match`: SourcePawn plugin

Pure SourcePawn, no extensions. Installed on PUG server instances through the
existing `deploy/overrides/` + `deploy.sh` mechanism. Sits on top of the
Rotoblin-AZMod config and match flow. Responsibilities:

- Accept a match definition pushed via RCON (match ID, 8 SteamIDs with team
  assignments, campaign map list, per-match secret token).
- Kick non-rostered SteamIDs; lock rostered players to their assigned team.
- Run the campaign minus finale; detect map/match completion.
- Emit structured log lines (see Transport) for match start, per-map scores,
  per-player stats, player connect/disconnect, heartbeat, match end.
- Keep business logic out: the plugin enforces and reports; the backend decides.

### 3. Server pool

`servers` table: name, host, game port, RCON port + password, status
(`idle` / `reserved` / `live` / `offline`). Day one: one row, a second srcds
instance on the Dallas box (e.g. `:27016`), leaving the casual server untouched.

**Risk noted:** the Dallas box is 2 vCPU; casual server + live 100-tick PUG
match simultaneously may be tight. Measure during staging; the fallback is the
planned second box.

## Match lifecycle

1. **Register/login:** Steam OpenID. Friends phase: new accounts require an
   invite code or admin approval.
2. **Queue:** join via website. Websocket broadcasts count; Discord webhook
   pings at thresholds and on pop.
3. **Ready check:** at 8 queued, 60s to confirm. No-shows are dropped; the rest
   keep queue position.
4. **Map vote:** plurality vote, ~30s, over a configurable campaign pool
   (default: No Mercy, Death Toll, Dead Air, Blood Harvest). Ties broken randomly.
5. **Team assignment:** evaluate all 35 unique 4/4 splits with OpenSkill
   `predictWin`; choose the split closest to 50/50.
6. **Server setup:** orchestrator claims an idle server (`reserved`), then via
   RCON: exec PUG config, set server password, push match definition + secret
   token, changelevel to map 1. On success → match `live`, connect info shown on
   site + Discord.
7. **Play:** plugin enforces roster/teams, streams events as log lines.
   Backend updates the live match page from the stream.
8. **Match end:** after final non-finale map, higher total score wins (draws
   possible; OpenSkill supports them). Backend persists scores/stats, updates
   ratings, writes rating history, posts Discord results, resets server via
   RCON → `idle`.

## Transport protocol

**Backend → server (RCON):** commands exposed by the plugin, e.g.
`sm_pug_match <matchid> <token> <campaign>`, `sm_pug_roster <steamid>:<team> ×8`,
`sm_pug_abort`. Also stock commands (`exec`, `changelevel`, `sv_password`).

**Server → backend (logaddress UDP):** backend adds itself via
`logaddress_add ip:port` at setup. Plugin writes lines like:

```
PUG <token> MATCH_START map=l4d_hospital01_apartment
PUG <token> MAP_RESULT map=... a=245 b=310
PUG <token> STAT steamid=STEAM_1:0:123 map=... sidmg=1240 sikill=8 ck=312 ff=45 rev=3
PUG <token> HEARTBEAT
PUG <token> MATCH_END a=812 b=1044 winner=b
```

Stats are key=value pairs: the backend stores known keys in real columns and the
full raw set in a JSON column, so future plugin versions can add stats with no
schema migration.

**Security:** `logaddress` is unauthenticated UDP. Backend accepts lines only
from known server IPs **and** requires the per-match secret token (delivered
over RCON, which is authenticated) in every line. Lines without a valid token
for an active match are dropped.

## Data model (SQLite)

- **players**: steamid (key), name, avatar, status (`invited`/`active`/`banned`),
  admin flag, created_at. (No rating columns here, see player_ratings.)
- **seasons**: id, name, started_at, ended_at (null = current). Season 1 is
  seeded at first launch; exactly one season is current at any time.
- **player_ratings**: (player_id, season_id) → mu, sigma, wins, losses. The
  leaderboard and all rating updates operate on the current season's row; a new
  row with fresh priors is created on a player's first match of a season.
- **matches**: id, season_id, state (`ready_check`→`map_vote`→`configuring`→
  `live`→`completed`/`aborted`), campaign, server_id, team scores, winner,
  timestamps.
- **match_players**: match_id, player_id, team; per-map core stats (SI damage,
  SI kills, common kills, FF dealt, revives) as columns + raw stats JSON.
- **rating_history**: player_id, match_id, mu/sigma before and after.
- **servers**: the pool (above).
- **settings**: config keys: gate toggles/thresholds, map pool, finale toggle,
  reconnect grace, Discord webhook URL.

Queue, ready-check, and vote state live **in memory only**, ephemeral by
design; a backend restart just means players re-queue.

## Ratings

- OpenSkill Plackett-Luce, default priors (high sigma for new players =
  placement behavior for free).
- Displayed SR = `round((mu − 2·sigma) × 100)`, floored at 0 (new players start
  around 830 with default priors). Cosmetic; the stored mu/sigma are canonical.
- One rating update per match, at `completed`. Aborted matches never touch
  ratings.
- `rating_history` enables SR graphs and manual corrections.

## Seasons (schema-ready now, feature later)

Launch runs entirely within an auto-created "Season 1"; there is no season UI.
Starting a new season later = admin inserts a `seasons` row (closing the old
one); players get fresh rating rows on their next match. Past-season
leaderboards remain queryable since matches, ratings, and history all carry
`season_id`. Whether a reset is hard (fresh priors) or soft (carry mu, inflate
sigma) is decided per season when the feature is built; the schema supports
either.

## Eligibility gates (pluggable checks)

Evaluated at registration; each toggleable in settings:

- `invite_or_approval`: **on at launch.** Invite code or admin approval.
- `min_l4d1_hours`: off at launch. Steam Web API `GetOwnedGames` (appid 500).
  Private profiles hide playtime → escape hatch: admin vouch.
- `min_versus_games`: off at launch. Tracked internally by our own match
  history (Steam's public L4D1 stats are not assumed to expose versus counts,
  verify during implementation; internal tracking is the fallback and default).

## Failure handling

- **Setup failure** (RCON unreachable/error): try next idle server; none →
  abort, requeue all 8, Discord alert.
- **Mid-match server death:** plugin heartbeat every 30s; on silence backend
  probes via RCON; if dead → match `aborted`, no SR change, players notified.
- **Abandons:** plugin reports disconnects; reconnect grace window (default
  5 min, in settings). Beyond that: admin cancel/void, or finish short-handed.
  Launch admin tooling is one button: cancel match + void SR. Leaver penalties,
  substitutes, vote-cancel are post-launch.
- **Backend restart mid-match:** match state is in SQLite; UDP listener
  re-binds and the log stream resumes. Only in-memory queue/vote state is lost.
- **Draws:** possible on total score tie; recorded as draw, OpenSkill handles it.

## Testing

- **Backend unit tests:** rating updates, team balancer, log-line parser (fed
  captured real srcds log samples), match state machine, eligibility checks.
- **Backend integration test:** fake RCON server + scripted UDP log source
  driving one full match lifecycle.
- **Plugin:** kept thin (enforce + report only); tested on a staging srcds
  instance on the Dallas box against a written manual checklist.
- **Dev mode:** seeded fake players + simulated log stream for frontend work
  without a game server.
- **Launch gate:** one real dry-run match with friends on staging.

## Build order (each sub-project gets its own implementation plan)

1. **Backend core:** schema, Steam login, queue → ready → vote → teams state
   machine, websockets, dev mode. *(No game server needed yet.)*
2. **Orchestrator + plugin:** server pool, RCON setup, roster enforcement, log
   reporting, first real end-to-end match.
3. **Ratings + stats:** OpenSkill integration, profiles, leaderboard, match
   history pages, Discord webhooks.
4. **Opening up:** eligibility gates on, admin tooling, ban handling.

## Research items (resolve during implementation, none block the design)

1. Confirm `logaddress_add` line format/behavior on the L4D1 dedicated server
   binary (capture real samples early in sub-project 2).
2. Confirm `GetOwnedGames` returns playtime for appid 500 for a public profile
   (only matters for sub-project 4).
3. Measure CPU headroom: casual + PUG instance both live at 100 tick on the
   2 vCPU box.
4. Verify Rotoblin-AZMod's map-flow hooks give the plugin a clean "campaign
   ended before finale" signal, or whether the plugin drives changelevels itself.
