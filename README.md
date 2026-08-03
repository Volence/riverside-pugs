# pug — L4D1 ranked PUG system

Web backend + (eventually) game-server plugin for ranked 4v4 Left 4 Dead 1
pick-up games. Design spec: `docs/superpowers/specs/2026-07-30-l4d1-pug-system-design.md`.

## Status

Sub-project 1 (backend core) complete. Sub-project 2a (backend orchestrator)
complete: Source RCON client, DB-backed server pool, UDP `logaddress` listener +
parser, per-match token, and a real orchestrator that configures a match over
RCON, receives a lossy live-view feed over UDP, and pulls the authoritative
final scores/stats over RCON (`sm_pug_dump`) to drive `configuring` → `live` →
`completed`. All exercised against a fake RCON server + synthetic UDP datagrams —
no live game server is contacted.

Sub-project 3 (ratings, stats, leaderboard, history, Discord) complete. Match
completion (`src/matchResult.ts::completeMatch`) is now the single write-path
used by both the real orchestrator and dev-mode simulation: in one transaction
it records the final score, per-map scores (`match_maps`), per-player stats,
and applies OpenSkill rating updates (`src/rating.ts::applyMatchRatings`).
Read-only stats endpoints and hash-routed frontend pages (leaderboard, match
history, match detail, player profile with an SR-over-time graph) expose the
result, and a fire-and-forget Discord webhook posts queue-pop / match-live /
match-final notifications.

**Not yet built (need the live box):** the `pug-match` SourcePawn plugin (2b) and
the second-srcds-instance infrastructure (2c). Designed in
`docs/superpowers/specs/2026-07-30-sub-project-2-orchestrator-plugin-design.md`.
The `logaddress` line format is pinned against synthetic samples until a real
capture from the L4D1 binary is taken during the 2b/2c dry-run.

## Run

    npm install
    npm run dev        # dev mode on :8080 (DEV_MODE=1, fake logins enabled)
    npm test           # vitest
    npm run typecheck  # tsc --noEmit

## Environment

| Var | Default | Notes |
|---|---|---|
| PORT | 8080 | |
| PUBLIC_URL | http://localhost:8080 | must match what Steam redirects back to |
| DB_PATH | data/pug.db | SQLite; WAL mode |
| COOKIE_SECRET | dev-secret-change-me | **set in production** |
| ADMIN_STEAMIDS | (empty) | comma-separated SteamID64s, auto-active + admin |
| STEAM_API_KEY | (none) | optional; enables persona names/avatars |
| DEV_MODE | off | `1` enables /api/dev/* and the dev panel |
| LOG_LISTEN_PORT | 27500 | UDP port the backend binds for srcds logaddress traffic |
| LOG_PUBLIC_ADDRESS | 127.0.0.1:27500 | host:port handed to `logaddress_add` (the server's view of the backend) |

The invite code lives in the DB: `settings.invite_code` (default `change-me`).
Change it: `sqlite3 data/pug.db "UPDATE settings SET value='...' WHERE key='invite_code'"`.

Discord notifications are also DB-backed settings, updated the same way:

| Setting key | Default | Notes |
|---|---|---|
| `discord_webhook_url` | `''` (empty) | Discord webhook URL. Notifications are a no-op while empty; never throws, so a dead/unset webhook can't break matchmaking. |
| `discord_queue_thresholds` | `[4,6]` (JSON array) | Queue sizes (out of `QUEUE_SIZE` = 8) that trigger a "N/8 in queue" post. Parsed defensively — a malformed value is treated as `[]`. |

Webhook posts also fire on lobby pop, match-live, and match-final (see
`src/discord.ts` and the `notify` hook wired through `src/server.ts`).

## Layout

- `src/` — Fastify app: `matchmaker.ts` (queue/lobby pipeline), `lobby.ts`
  (ready-check + vote state machine), `balance.ts` (OpenSkill team split),
  `orchestrator.ts` (`RealOrchestrator` + `DevOrchestrator` stub), `rcon.ts` /
  `rconPacket.ts` (Source RCON), `serverPool.ts`, `logListener.ts` /
  `logParse.ts` (UDP live-view), `dumpParse.ts` (authoritative RCON pull),
  `matchToken.ts`, `matchResult.ts` (`completeMatch` — the single "persist a
  finished match" transaction: result, `match_maps`, per-player stats, then
  ratings), `rating.ts` (`applyMatchRatings` — post-match OpenSkill updates +
  `rating_history`; `displaySr` — the cosmetic SR shown on site), `discord.ts`
  (`notifyDiscord` — fire-and-forget webhook, injectable fetch), `routes/`
  (`api.ts` matchmaking, `auth.ts` Steam login, `stats.ts` leaderboard/player/
  match read routes, `dev.ts` dev-mode routes, `ws.ts`, `guards.ts`
  `requireActive`).
- `public/` — static frontend, no build step. `app.js` hash-routes between the
  live queue/lobby/match view (`#/`), `#/leaderboard`, `#/matches`,
  `#/match/:id`, and `#/player/:steamid` (SR-over-time sparkline via inline
  SVG).
- `tests/` — vitest.

## Ratings

OpenSkill (`openskill` npm, `rate()`), one `player_ratings` row per
(player, season). Displayed SR is cosmetic: `displaySr(mu, sigma) =
max(0, round((mu - 2*sigma) * 100))`; the stored mu/sigma remain canonical.
`applyMatchRatings` (`src/rating.ts`) runs inside `completeMatch` for every
completed match: it's idempotent (guarded by a `rating_history` row already
existing for that match), keyed to the match's own `season_id` (not whichever
season is currently open), and treats a draw as a rank tie — mu/sigma still
move but neither `wins` nor `losses` increments. Every player in a rated match
gets one `rating_history` row (mu/sigma before and after) per match, which
also backs the per-player SR graph.

## API

Read routes below all require an active session (`requireActive` in
`src/routes/guards.ts`): 401 if not logged in, 403 if logged in but not an
`active` player.

- `GET /api/leaderboard` — current season, players sorted by SR desc, with
  wins/losses/games.
- `GET /api/players/:steamid` — profile: current rating, lifetime stat totals
  (SI damage/kills, common kills, FF dealt, revives), the last 20 completed
  matches (with per-match SR delta), and the full season SR history used for
  the profile graph.
- `GET /api/matches` — last 50 completed matches.
- `GET /api/matches/:id` — one completed match: per-map scores (`match_maps`)
  and per-player stats + SR delta.

Dev-mode-only (`DEV_MODE=1`), on top of the existing `/api/dev/*` routes:

- `POST /api/dev/finish-match` — completes the newest open match with
  fabricated scores/stats through the real `completeMatch` write path (so
  ratings update for real).
- `POST /api/dev/simulate-match` — one-click fill queue → ready-all →
  vote-all → finish, for exercising the whole pipeline without a live server.

## SourcePawn plugin (`plugin/`)

`plugin/pug-match.sp` is the server-side counterpart of the orchestrator: it
runs on the L4D1 box, handles match intake / roster enforcement over RCON,
and reports back over the live UDP `logaddress` feed and the authoritative
`sm_pug_dump` RCON response. See `plugin/README.md` for the RCON command
set, both wire grammars, build instructions, the install path, and the
manual staging checklist.
