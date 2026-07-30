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

## Layout

- `src/` — Fastify app: `matchmaker.ts` (queue/lobby pipeline), `lobby.ts`
  (ready-check + vote state machine), `balance.ts` (OpenSkill team split),
  `orchestrator.ts` (`RealOrchestrator` + `DevOrchestrator` stub), `rcon.ts` /
  `rconPacket.ts` (Source RCON), `serverPool.ts`, `logListener.ts` /
  `logParse.ts` (UDP live-view), `dumpParse.ts` (authoritative RCON pull),
  `matchToken.ts`, `routes/`.
- `public/` — static frontend, no build step.
- `tests/` — vitest.
