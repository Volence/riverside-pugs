# pug — L4D1 ranked PUG system

Web backend + (eventually) game-server plugin for ranked 4v4 Left 4 Dead 1
pick-up games. Design spec: `docs/superpowers/specs/2026-07-30-l4d1-pug-system-design.md`.

## Status

Sub-project 1 (backend core) complete: Steam login, invite gate, queue →
ready-check → map-vote → SR-balanced teams, websocket live updates, dev mode.
Matches stop at state `configuring` — real server orchestration (RCON +
logaddress) is sub-project 2.

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

The invite code lives in the DB: `settings.invite_code` (default `change-me`).
Change it: `sqlite3 data/pug.db "UPDATE settings SET value='...' WHERE key='invite_code'"`.

## Layout

- `src/` — Fastify app: `matchmaker.ts` (queue/lobby pipeline), `lobby.ts`
  (ready-check + vote state machine), `balance.ts` (OpenSkill team split),
  `orchestrator.ts` (stub until sub-project 2), `routes/`.
- `public/` — static frontend, no build step.
- `tests/` — vitest.
