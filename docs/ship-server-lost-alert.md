# Ship notes: server-lost alert + ops report endpoint (branch server-lost-alert)

Two small additions in one commit. Not deployed.

## 1. Server-lost alert for live PUGs (audit G9, match 554)

### What the site did before this branch

- The plugin heartbeats every 30 s. The Live board shows a match **stale**
  after 2 min without one (liveView.ts STALE_AFTER_MS). Nobody is told.
- The **orphan reaper** (liveView.ts reapOrphanedMatches, every 60 s) aborts a
  live match 10 min after its last heartbeat (ORPHAN_AFTER_MS) with cause
  `server_lost`, releases the box, requeues everyone, and posts one admin line:
  "Match #N aborted: the game server stopped reporting it." That is the first
  and only staff signal, and it comes after the abort.
- Nothing polls rcon or A2S for a live ranked match. The restart-after-match
  path (serverRestart.ts) only runs after a match ends. **Bookings** have real
  crash recovery (plan 5: bookings/recovery.ts classifyBox with a boot marker
  cvar, A2S fallback, restore.ts rebuilds the game); queue PUGs do not.
- Match 554: srcds hit a Sys_Error at 04:15:56, an admin aborted by hand at
  04:23:01 (`abort_cause` admin). The reaper would have done it at about 04:25.
  Prod has never recorded an `abort_cause = 'server_lost'` (68 aborted rows
  have no cause, most from before the column).

### What this adds (src/serverLost.ts, wired into the 60 s reaper loop)

Once a live, non-booking match has had no heartbeat for 2 min, the site asks
its box once (`sm_pug_status` over rcon, then A2S if rcon fails) and posts one
admin `problem` event (the bot sends it to the Discord admin channel), with a
Live board link:

| Verdict | Means |
|---|---|
| restarted | rcon answers, pug-match does not hold this match: srcds crashed or was restarted. Cannot resume by itself. |
| logs_quiet | the box still holds the match live: the game is fine, log lines are not reaching the site. (Today the reaper would still abort it at 10 min, so staff should look.) |
| no_rcon | rcon silent, server browser answers (player count given) |
| down | neither answers |

The text names the match, campaign, map number and map, server, minutes
silent, and minutes until the reaper aborts it. Example:

> Match #554 (No Mercy, map 4 l4d_vs_hospital04_interior) on Riverside #3 lost
> its server: no heartbeat for 2 min and the server no longer holds the match
> (pug-match state none), so srcds crashed or was restarted. The match cannot
> resume by itself. Nothing was changed. If nobody acts, it is aborted as server
> lost in about 8 min.

- **Deduped** by a new column `matches.server_lost_alerted_at` (ensureColumn,
  NULL for every existing row), claimed with a guarded UPDATE, so a web restart
  never re-posts. If heartbeats come back, one "is reporting again" line goes
  out and the match is armed again.
- **Changes nothing**: no abort, release or restart. The reaper is untouched.
- Each stale match costs one `sm_pug_status` (through RealRcon's per-server
  turn) and at most one A2S query. The status reply carries the match token; it
  is parsed and never logged.
- Skips bookings (their own recovery), matches with no heartbeat row yet,
  and dev mode.

### Automatic crash recovery for PUGs (NOT built; what it would take)

Most of the machinery exists for bookings and could be reused:
1. Detection: `restarted` above is already the signal (bookings use a boot
   marker cvar; for PUGs, pug-match not holding the token is equivalent).
2. Rebuild: bookings/restore.ts already rebuilds a game from site records
   (finished maps from match_rounds, roster from match_players, survivor-first
   order, stop map) and replays the interrupted map from its start, stamping
   `restored_at_map`. PUGs would need the same burst path from the orchestrator
   (sm_pug_match + roster + seeded map scores) instead of the booking runner.
3. Rulings the owner must make: replay the interrupted map from the start or
   void it; how stats/SR treat a restored match (bookings: stats only from the
   restored map on); hold the abandon clock while everyone reconnects; what if
   the box does not come back (move to another server like plan 5, or abort).
4. The plugin keeps per-map scores only in memory (`g_iMapScoreA/B`), so the
   final dump after a restore covers only maps since it; the result must merge
   site-side records, as bookings do.
Estimate: M (a few days with tests), mostly wiring and the rulings.

## 2. `POST /api/ops/report` (src/opsReport.ts), for the deploy repo's log watcher

The game boxes' SourceMod error watcher (deploy branch `log-retention`,
ops/l4d-logwatch.py) reports new error signatures and error floods here; the
site posts them to the admin feed as a `problem`. Game log lines could not be
used: they are signed by a plugin inside srcds, which a script cannot do.

- Off (404) unless `OPS_REPORT_SECRET` is set in .env.
- Body `{ts, payload, mac}`, mac = HMAC-SHA256(secret, `${ts}.${payload}`);
  refused when more than 5 min off, on a bad MAC, or on a replayed MAC.
- The site builds the text from bounded fields (server name pattern, at most 5
  items, lengths capped, markdown links/code spans stripped; the bot already
  sends with no mentions). At most 30 posts an hour in total, then 429.

## Tests and checks (2026-10-10, in this worktree after a real `npm ci`)

- New: tests/serverLost.test.ts (13) and tests/opsReport.test.ts (9).
- `npx vitest run`: 739 files, 11,282 tests, all passed.
- `npm run typecheck`: clean.
- The Python watcher's MAC was checked byte-equal against `opsMac`.

## To ship (needs the owner's go)

1. Merge `server-lost-alert` to master, `deploy-web.sh` (web only; no plugin
   change, no box change). Allowed during live matches per the deploy rules.
2. Optional, for the log watcher: add `OPS_REPORT_SECRET=$(openssl rand -hex 32)`
   to /home/pug/app/.env before the deploy (the endpoint stays 404 without it),
   then install the watcher per the deploy repo's docs/ship-log-retention.md.
3. Verify: `select count(*) from pragma_table_info('matches') where
   name='server_lost_alerted_at'` is 1; `curl -s -XPOST
   localhost:8080/api/ops/report` answers 404 without a secret, 400 with one.
   The alert itself is seen only when a live match loses its server; the
   journal line is `[serverLost] match N on <server>: <verdict>`.
