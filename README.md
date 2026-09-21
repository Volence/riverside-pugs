# pug: L4D1 ranked PUG system

Web backend + (eventually) game-server plugin for ranked 4v4 Left 4 Dead 1
pick-up games. Design spec: `docs/superpowers/specs/2026-07-30-l4d1-pug-system-design.md`.

## Status

Sub-project 1 (backend core) complete. Sub-project 2a (backend orchestrator)
complete: Source RCON client, DB-backed server pool, UDP `logaddress` listener +
parser, per-match token, and a real orchestrator that configures a match over
RCON, receives a lossy live-view feed over UDP, and pulls the authoritative
final scores/stats over RCON (`sm_pug_dump`) to drive `configuring` → `live` →
`completed`. All exercised against a fake RCON server + synthetic UDP datagrams.
no live game server is contacted.

Sub-project 3 (ratings, stats, leaderboard, history, Discord) complete. Match
completion (`src/matchResult.ts::completeMatch`) is now the single write-path
used by both the real orchestrator and dev-mode simulation: in one transaction
it records the final score, per-map scores (`match_maps`), per-player stats,
and applies OpenSkill rating updates (`src/rating.ts::applyMatchRatings`).
Read-only stats endpoints and frontend pages (leaderboard, match history, match
detail, player profile with an SR-over-time graph) expose the result, and a
fire-and-forget Discord webhook posts queue-pop / match-live / match-final
notifications.

Sub-project 4a (frontend migration + redesign) complete: the placeholder
`public/` files are replaced by a Vite + Preact app in `web/`, on real URLs
instead of hash routes, with the "Safe Room" design language described in
`docs/superpowers/specs/2026-09-06-frontend-migration-4a-design.md`. No API
changed; the only backend edits were the static root and an SPA fallback route.

**Partly validated on the live box (2026-08-29):** the `pug-match` plugin (2b)
had a first staging pass, which produced the quoted-roster-arg fix, the
PUGOK/PUGERR contract, and a real `logaddress` wire capture now pinned in
`tests/logParse.test.ts`. The rest of the 2b checklist and the
second-srcds-instance infrastructure (2c) still need the box. Designed in
`docs/superpowers/specs/2026-07-30-sub-project-2-orchestrator-plugin-design.md`.

## Run

    npm install
    npm run dev        # dev mode: API on :8080 + Vite dev server on :5173
    npm test           # vitest (server + web projects)
    npm run typecheck  # tsc --noEmit, both tsconfigs
    npm run build      # vite build -> dist/public

In dev, open **http://localhost:5173**. The Vite server owns the browser and
proxies `/api`, `/auth`, and `/ws` to the API on :8080, so the frontend gets HMR
without the API moving. `npm run dev:api` and `npm run dev:web` run the halves
separately.

In production, `npm run build` must run before `npm start`: Fastify serves the
built frontend from `dist/public`, which is a build artifact and is gitignored.

## Environment

| Var | Default | Notes |
|---|---|---|
| PORT | 8080 | |
| PUBLIC_URL | http://localhost:8080 | must match what Steam redirects back to |
| DB_PATH | data/pug.db | SQLite; WAL mode |
| COOKIE_SECRET | dev-secret-change-me | **set in production** |
| ADMIN_STEAMIDS | (empty) | comma-separated SteamID64s, auto-active + admin |
| STEAM_API_KEY | (none) | optional; enables persona names/avatars and the admin-only Steam account signals |
| DEV_MODE | off | `1` enables /api/dev/* and the dev panel |
| LOG_LISTEN_PORT | 27500 | UDP port the backend binds for srcds logaddress traffic |
| LOG_PUBLIC_ADDRESS | 127.0.0.1:27500 | host:port handed to `logaddress_add` (the server's view of the backend) |

The invite code lives in the DB: `settings.invite_code` (default `change-me`).
Change it: `sqlite3 data/pug.db "UPDATE settings SET value='...' WHERE key='invite_code'"`.

Discord notifications are also DB-backed settings, updated the same way:

| Setting key | Default | Notes |
|---|---|---|
| `discord_webhook_url` | `''` (empty) | Discord webhook URL. Notifications are a no-op while empty; never throws, so a dead/unset webhook can't break matchmaking. |
| `discord_queue_thresholds` | `[4,6]` (JSON array) | Queue sizes (out of `QUEUE_SIZE` = 8) that trigger a "N/8 in queue" post. Parsed defensively, so a malformed value is treated as `[]`. |

Webhook posts also fire on lobby pop, match-live, and match-final (see
`src/discord.ts` and the `notify` hook wired through `src/server.ts`).

## Layout

- `src/`: Fastify app. `matchmaker.ts` (queue/lobby pipeline), `lobby.ts`
  (ready-check + vote state machine), `balance.ts` (OpenSkill team split),
  `orchestrator.ts` (`RealOrchestrator` + `DevOrchestrator` stub), `rcon.ts` /
  `rconPacket.ts` (Source RCON), `serverPool.ts`, `logListener.ts` /
  `logParse.ts` (UDP live-view), `dumpParse.ts` (authoritative RCON pull),
  `matchToken.ts`, `matchResult.ts` (`completeMatch`, the single "persist a
  finished match" transaction: result, `match_maps`, per-player stats, then
  ratings), `rating.ts` (`applyMatchRatings`, post-match OpenSkill updates +
  `rating_history`; `displaySr`, the cosmetic SR shown on site), `discord.ts`
  (`notifyDiscord`, a fire-and-forget webhook with injectable fetch), `routes/`
  (`api.ts` matchmaking, `auth.ts` Steam login, `stats.ts` leaderboard/player/
  match read routes, `dev.ts` dev-mode routes, `ws.ts`, `guards.ts`
  `requireActive`).
- `web/`: frontend source (Vite + Preact + TypeScript). `src/routes/` holds one
  component per page: Play (`/`), Leaderboard, Matches, MatchDetail
  (`/match/:id`), Profile (`/player/:steamid`), routed with `preact-iso` over
  real URLs, not hash routes. `src/api.ts` is the typed client, `src/format.ts`
  the pure display helpers, `src/hooks/` the data plumbing (`useLiveState` =
  websocket nudge + re-fetch; `useFetch` = per-route load with a stale-response
  guard), `src/styles/tokens.css` every design token.
- `dist/public/`: build output, gitignored. Fastify's static root.
- `tests/`: vitest (server). Frontend tests live beside their source in `web/`.

## Ratings

OpenSkill (`openskill` npm, `rate()`), one `player_ratings` row per
(player, season). Displayed SR is cosmetic: `displaySr(mu, sigma) =
max(0, round((mu - 2*sigma) * 100))`; the stored mu/sigma remain canonical.
`applyMatchRatings` (`src/rating.ts`) runs inside `completeMatch` for every
completed match: it's idempotent (guarded by a `rating_history` row already
existing for that match), keyed to the match's own `season_id` (not whichever
season is currently open), and treats a draw as a rank tie, so mu/sigma still
move but neither `wins` nor `losses` increments. Every player in a rated match
gets one `rating_history` row (mu/sigma before and after) per match, which
also backs the per-player SR graph.

## API

Read routes below all require an active session (`requireActive` in
`src/routes/guards.ts`): 401 if not logged in, 403 if logged in but not an
`active` player.

- `GET /api/leaderboard`: current season, players sorted by SR desc, with
  wins/losses/games.
- `GET /api/players/:steamid`: profile with current rating, lifetime stat totals
  (SI damage/kills, common kills, FF dealt, revives), the last 20 completed
  matches (with per-match SR delta), and the full season SR history used for
  the profile graph.
- `GET /api/matches`: last 50 completed matches.
- `GET /api/matches/:id`: one completed match, with per-map scores (`match_maps`)
  and per-player stats + SR delta.

Dev-mode-only (`DEV_MODE=1`), on top of the existing `/api/dev/*` routes:

- `POST /api/dev/finish-match`: completes the newest open match with
  fabricated scores/stats through the real `completeMatch` write path (so
  ratings update for real).
- `POST /api/dev/simulate-match`: one-click fill queue → ready-all →
  vote-all → finish, for exercising the whole pipeline without a live server.

## What's next

Sub-project 4 turns the one-way Discord webhook into a real bot, with the queue
working identically from the website and from Discord. Design and build order
(4a done, 4b-4f queued) in
`docs/superpowers/specs/2026-09-06-dual-surface-design.md`.

## SourcePawn plugin (`plugin/`)

`plugin/pug-match.sp` is the server-side counterpart of the orchestrator: it
runs on the L4D1 box, handles match intake / roster enforcement over RCON,
and reports back over the live UDP `logaddress` feed and the authoritative
`sm_pug_dump` RCON response. See `plugin/README.md` for the RCON command
set, both wire grammars, build instructions, the install path, and the
manual staging checklist.
