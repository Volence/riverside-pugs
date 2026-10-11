# Booked Scrims In Game Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make a booked scrim's server explain and run itself: each booking side placed on its own team, `!time`, a visible countdown between campaigns and before the close, the state re-told to every player once they are actually in game, `!allow` for watchers and `!sub` for players, a "Start now" both captains can press, safe console text, and no passwords or allowlist in the srcds logs.

**Architecture:** The site keeps adopting booked games through auto-track (no new match flow). It adds, to the lines it already pushes at setup, every campaign load and every minute: the booking's people by side for pug-match (`sm_pug_book_*`, which turns the team lock on for an auto-tracked booking game and places people before go-live), and the booking's clock for l4d_booking (`l4d_booking_ends`, `_next_at`, `_close_at` and names), from which the plugin drives `!time`, the countdowns and the re-tell itself, so the site never rcon-spams. Precise timers replace "the next minute watch" for the campaign load and the close. Start now is two presses recorded on `booking_sides`, then a slot move and an immediate allocate.

**Tech Stack:** TypeScript (Fastify, better-sqlite3, vitest), Preact (web), SourcePawn 1.12 (pug-match.sp 0.3.33 with a new `pug-booking.inc`, l4d_booking.sp 1.5.0), compiled with wine spcomp through `plugin/build.sh` and `plugin/build-booking.sh`.

**Spec:** the owner's list after the first live scrim (2026-10-11, booking 2, matches 644 and 645), items 3, 4, 5, 7, 8, 9, 10, 14 and 16, restated with every decision under Rulings below. Background designs: `docs/superpowers/plans/2026-10-01-competitive-foundation-4b-booked-games.md`, `2026-10-01-competitive-foundation-4b2-allowlist.md`, `2026-10-01-bookings-by-campaign.md`, `2026-10-07-tournaments-3b-match-servers.md`.

## Global Constraints

- Work ONLY in the worktree `/home/volence/l4d/pug/.claude/worktrees/scrim-ingame` (branch `scrim-ingame`, deps installed). Never touch `/home/volence/l4d/pug` itself. Never `git commit -a`; stage only the files the task names. Never bare `git stash`. Do not push.
- Never use em dashes anywhere: code, comments, docs, commit messages, chat lines. Replace by meaning (a colon, a comma, "so", parentheses).
- Match surrounding code: comment density, naming, idioms. Commit messages are one plain sentence.
- Tests: `npx vitest run <path>` per file, `npm test` for everything, `npm run typecheck`.
- Plugin changes bump the plugin version (pug-match `0.3.32` to `0.3.33`, l4d_booking `1.4.0` to `1.5.0`) and compile with `plugin/build.sh` / `plugin/build-booking.sh` (wine + the Rotoblin tree's spcomp; they write only into the Rotoblin scripting tree and `plugin/`).
- Local plugin tests only on the shared local server `/home/volence/l4d1-ds`, the instance on rcon port 27055, in `rotoblin_cheats_4v4`. Other sessions and the owner use it: run `status` first and touch nothing while it shows a human; never restart or kill a srcds you did not start; kill only by PID. It is `sv_lan 1`, so real clients have no SteamID64 there and anything keyed on one is left for the owner's live test. rcon helper: `RPORT=27055 python3 /home/volence/l4d/nightmode/rcon.py '<cmd>' ['<cmd>' ...]` (each argument is one command; `/home/volence/l4d1-ds/rcon-local.py` is hardwired to 27015, a different server).
- Never ssh anywhere, never rcon, restart or stage a production box. Deploying is out of scope: the plan ends at a merge-ready branch and two compiled `.smx` files with bumped versions.
- Mixed fleet: during rollout some boxes run the old plugins with the new site and the reverse. Every new console line must be harmless to an old plugin (srcds answers `Unknown command`, which nothing on the site parses as a failure), and each plugin must behave as today when the site sends nothing new. Task 14 walks the matrix.

## Rulings (made in this plan; the owner did not decide these)

1. **Placement design: a booking roster pushed to pug-match, not site-started games.** The site pushes `sm_pug_book_begin`, `sm_pug_book_add <a|b|s> <id64...>`, `sm_pug_book_commit <a|b>` with every `gameLines` burst (setup, campaign load, minute re-push, recovery, replay) and before each campaign's changelevel. With a committed list pug-match (a) places each side before go-live on a campaign's first map, first half: the committed side on survivors, the other on infected; (b) keeps `TeamLockActive()` true for an auto-tracked match on that box (its go-live snapshot is the placement); (c) sends a booking player who is not on the match roster (a sub) to their side's team when it has room; (d) moves watch-only people and strangers (SourceMod admins excepted) to spectator. Why: the site-started model tournaments use would mean creating each game's row before the load, aborting the ones never played, an end-kick per game and a rewrite of how scrim games are counted; the plugin already adopts, rosters late joiners (`RosterLateJoiners`), tracks orientation and seeds later maps from the score. `matches.booking_side_a` keeps coming from `bookingSideForTeamA` at adoption, whose majority now always matches the placement. The roster is pushed only when the booking's ruleset has `teamLock: true` (Casual Scrim does; it was never honoured until now).
2. **Who survives first.** Campaign 1: `non_picker_chooses` gives side b survivors first (side a made or posted the booking and its campaigns, so b is the non-picker; the site cannot ask, so b gets the first-survivors slot); `higher_seed_chooses` gives side a (scrims have no seeds); `coin` goes by the booking id (odd: side a). Every later campaign alternates, counted by finished games (`gamesPlayed`), so a `!stay` replay flips too and a staff-aborted game does not.
3. **Nobody is pulled out of spectator** except once after they arrive (each map load), after their role changes (a `!sub`), or after this module moved them off the wrong team. A player who sits out stays out. A full team is never over-filled (`survivor_limit`, `z_max_player_zombies`).
4. **The gap stays 60 seconds, but becomes exact.** The load used to wait for the first minute watch after `next_at`, so the real gap was 60 to 120 s. A timer now loads at `next_at` (the watch stays as the fallback). Shorter than 60 s would mostly be spent in the finale's load screen (the game ends when the finale loads), leaving captains no time for `!nextmap`, `!stay`, `!end`.
5. **On-screen countdown uses center text** (`PrintCenterTextAll`, once a second in the last 60 s), with chat at 60, 30 and 10 s. The plugin skips its own 60 s chat line when the countdown starts above 50 s, because the site's scheduling line ("Next: X in 60 seconds") was just said. Hint text is not used (it can play a sound on this engine; unverified).
6. **Warnings at 30 and 10 minutes, during a game too.** Only the smallest mark crossed is said (a booking first seen 8 minutes from its end hears the 10 only). During a live game the line says the game will be finished. This replaces bookings-by-campaign Ruling 4 ("one warning, between games only"). When `ends_at` passes during a live game the box says once that the slot is over, the game will be finished, then the server closes (`warned_minutes = 0` marks it said; +1 campaign clears it), and when that game ends it says the server closes within a minute.
7. **Start now.** Scrims only; both sides confirmed; state `scheduled`, `held`, `setup` or `ready`; `starts_at` still ahead; no end started. One press per side, which its manager can take back. On the second press the site refuses (and does not keep that press) when no box could be held right now (the booking would otherwise wait for one and be cancelled as `no_server` after the grace counted from its new start), or when the earlier slot fails the normal capacity check. Otherwise `starts_at` becomes now, `ends_at` moves up by the same amount, both presses clear, reminders are marked sent, `warned_minutes` clears, and `allocate()` takes the box at once. No extra DM: the usual `booking_ready` DM with the password follows setup. `scrim_posts.starts_at` is left alone: once a post is booked nothing reads it (reliability and no-show timing read `bookings.starts_at`).
8. **Log hygiene covers** `bookingLines` (both passwords, the notice), `allowLines` (the allowlist) and the booking roster, each wrapped in `sv_rcon_log 0` / `sv_rcon_log 1` as `gameLines` already does for the log secret. Not wrapped: the one-id `sm_booking_allow_refuse <id>` line and the captains list (managers are public on the site).
9. **`!allow` watchers** are inserted as role `spectator` on the captain's side, capped at `PEOPLE_PER_SIDE` watchers per side, not counted against the side's players. They still count toward `peak_present` as every site-added spectator already does (changing no-show counting is out of scope). An open invite on the captain's side is still accepted with its role kept, and the line then names that role.
10. **`!sub`** adds a ringer on the captain's side; a watcher of either side becomes a ringer of the captain's side; an invite on the captain's side is accepted; someone who plays (or is invited to play) for the other side is refused. Players and ringers per side stay capped at `PEOPLE_PER_SIDE`. On a tournament box l4d_booking ignores `!sub` (pug-tourney.inc owns `!sub <out> <in>` there).
11. **The re-tell** goes to each player once per map load, 5 s after `OnClientPostAdminCheck` and only once they are on a team (any team, spectator included), as three short lines joined with ` | ` (consoleText would turn a `·` into `?`).
12. **`//` becomes `/ /`** in `consoleText`. `quoted()` is unchanged: inside quotes `//` is not a comment (practice leases push the site URL quoted).
13. **Tournament boxes get none of the new scrim lines** (no clock cvars, no roster), so the plugin's re-tell, `!time` and countdowns stay silent there.
14. **A list commit now starts the grace for anyone already connected who is not on it** (coordinator addition, from another session's audit). A player removed or replaced on the site mid chapter used to play on until the next map; now they get the usual `l4d_booking_grace` seconds (a captain can `!allow` or `!sub` them back) and are then kicked and blocked. This replaces 4b2 Ruling 4 ("people removed while connected are not kicked; the list is enforced on connect only"). A grace already running is kept, never restarted, so the minute re-push changes nothing for someone waiting; exempt clients (bots, SourceTV, SourceMod admins) and clients without a SteamID yet are skipped as on connect.
15. **The moved box's forced restart is persisted as a column** (`bookings.fresh_box`, coordinator addition), set by `reholdBox` in the same transaction that takes the box and cleared only once that restart came back. Inferring it from `box_moved` / `box_dropped` events was the alternative; the column is one read, cannot be confused by a later event, and also fixes a second gap: the in-memory set was emptied BEFORE the restart, so a recovery retry after a failed restart skipped it.

## Findings that contradict or sharpen the context

- `src/events/series.ts:396` puts raw tournament entry names into `say [Match] ...`. Team names may contain `;`, so a team named `x; quit` would run `quit` on the box. Fixed in Task 1 with the `//` fix.
- The between-campaign gap was 60 to 120 s, not 60 (load on the first minute watch at or after `next_at`).
- A game ends when the finale map loads (`EndMatchNow("finale loaded")`), so the site's game-end line always lands during the finale's load screen.
- Tournaments' "pug team a starts as survivors" is a seed, not a rule: `Timer_TeamLock` adopts the orientation where 3 or more rostered players already sit. This plan's scrim placement forces the side instead, by bouncing wrong-team players through spectator.
- The Casual Scrim ruleset already says `teamLock: true`; the site never acted on it for scrims.
- `sv_rcon_log 0/1` does work as a wrapper: every BoxRcon burst awaits each reply before sending the next line (`src/server.ts` `realServerRcon`), srcds executes an rcon command before answering, and the engine checks `sv_rcon_log` when it logs each received command (`engine.so` carries `sv_rcon_log` and `rcon from "%s": %s`). Task 2 proves it on the local box before relying on it.
- A ConVar holds its number as a float, so an epoch (about 1.79e9) read with `ConVar.IntValue` is off by up to 64 s. l4d_booking reads its epoch cvars as strings (Task 13).
- Locally the 27055 server is not always running, and `rcon-local.py` talks to 27015.

## Merge overlap with branch `compete-sweep` (another session)

`compete-sweep` has committed changes in `src/bookings/bookings.ts` (`cancelBooking` 'started' refusal, `addCampaign` counting from max(ends_at, now), `nowMs` passed into the `capacityProblem` calls of `createBooking` / `confirmBooking`), `src/bookings/rules.ts` (`capacityProblem` takes an optional `nowMs` and counts boxes held past their slot), `src/bookings/messages.ts` (connect lines), `src/routes/bookings.ts` (tournament bookings refuse player cancel, end, extend, next, stay and so on) and `web/src/routes/Booking.tsx` (ConnectPanel, confirm dialogs, tournament hides controls, near the state panel). To keep that merge easy:

- bookings.ts: every new function goes in its own block (`bookRoster` and `firstSurvivorSide` after `allowList`; Start now after `endBooking`); the only edits inside existing code are `allowInGame` (replaced whole), `SideRow`, `BookingRow` (Task 11), `reholdBox` (one SQL line), `BOOKING_ERRORS` (two added lines) and two view fields. Expect a textual conflict only if compete-sweep touched `allowInGame` or `reholdBox`.
- rules.ts and messages.ts: not touched here.
- `startBookingNow` calls `capacityProblem` with today's signature. After the merge, if compete-sweep's optional `nowMs` exists, pass `nowMs` there too (`capacityProblem(db, { ..., nowMs })` or however that branch named it), so a box held past its slot counts against an early start. Note this in the merge commit.
- routes/bookings.ts: the two Start now routes go right after `action('end', ...)` in one block. Start now already refuses tournament bookings in the domain (`startNowOpen`), so no route guard is needed.
- Booking.tsx: the Start now markup is one block placed right after the `{v.connect && (...)}` line, plus three `const` lines after `addCampaign`. compete-sweep replaces the connect line with a ConnectPanel: on merge, put the Start now block directly after that panel; it depends only on `v.canStartNow`, `playerManage`, `actingSide`, `act` and `busy`.

## Review Focus

1. A player or team name carrying `//`, `;` or `"` reaching any console line (`say`, `!allow` and `!sub` lines, tournament start lines): expected, the whole line arrives and no second command runs. Tests: Task 1 (consoleText, series start line), Task 7 (a `!sub` of `(S)VI // Square4 Bass`).
2. A box still on the old plugins answering `Unknown command` to `sm_pug_book_*` and the new `l4d_booking_*` cvars: expected, setup reaches ready and the minute watch carries on. Test: Task 6.
3. Start now pressed when no box is free or the earlier slot has no room: expected, a clear refusal, the second press not kept, the slot unchanged. Tests: Task 8 (domain), Task 9 (runner and route).
4. The next load or the close timer firing early, twice, or after a captain already moved things on: expected, nothing early, one changelevel, the close only when due. Test: Task 5.
5. The slot's end passing during a live game: expected, one "slot is over" line however many watches pass, no cut, then the box closes within a minute of the game's end. Test: Task 4.

Not coverable by unit tests, left for the owner's live test (Task 14 lists them): placement against Rotoblin's own team scripts at a campaign load, the countdown's on-screen look, and the re-tell's timing on a slow loader.

---

## File Structure

- `src/serverSetup.ts`: `consoleText` neutralizes `//`.
- `src/events/series.ts`: the game start line through `consoleText`.
- `src/bookings/bookings.ts`: `firstSurvivorSide`, `bookRoster`, `allowInGame` (watchers), `subInGame`, Start now (`pressStartNow`, `withdrawStartNow`, `startBookingNow`), view fields, two error texts.
- `src/db.ts`: `booking_sides.start_now_at`.
- `src/bookings/bookings.ts` and `src/db.ts` also: `bookings.fresh_box` and `markBoxRestarted` (Task 11).
- `src/bookings/runner.ts`: `quietLines`, the clock lines in `bookingLines`, `bookRosterLines` in `gameLines` and before each load, warnings, exact timers (`later` dep), `!sub`, `startNow`.
- `src/logParse.ts`: `sub` in `BOOKING_CMDS`.
- `src/routes/bookings.ts`: Start now routes.
- `web/src/api.ts`, `web/src/routes/Booking.tsx`: Start now UI.
- `plugin/pug-booking.inc` (new), `plugin/pug-match.sp`, `plugin/build.sh`: placement, 0.3.33.
- `plugin/l4d_booking.sp`: `!time`, countdowns, re-tell, `!sub`, 1.5.0.
- `plugin/TESTING.md`: the two local checklists.
- Tests: `tests/consoleText.test.ts` (new), `tests/series.test.ts`, `tests/bookingRunner.test.ts`, `tests/bookings.test.ts`, `tests/logParse.test.ts`, `tests/bookingRoutes.test.ts`, `web/src/routes/Booking.test.tsx`.

---

### Task 1: No console text can end a line early or start a second command

**Files:**
- Modify: `src/serverSetup.ts:55-59`
- Modify: `src/events/series.ts:396`
- Create: `tests/consoleText.test.ts`
- Test: `tests/series.test.ts`

**Interfaces:**
- Produces: `consoleText(v: string, max: number): string`, same signature, now also turning every `//` into `/ /`.

- [ ] **Step 1: Write the failing tests**

Create `tests/consoleText.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { consoleText, quoted } from '../src/serverSetup.js';

describe('consoleText', () => {
  it('breaks up // so the console never reads the rest of the line as a comment', () => {
    expect(consoleText('(S)VI // Square4 Bass', 60)).toBe('(S)VI / / Square4 Bass');
    expect(consoleText('a///b', 60)).toBe('a/ / /b');
    expect(consoleText('a/"/b', 60)).toBe('a/ /b');
    expect(consoleText('a/b', 60)).toBe('a/b');
  });

  it('still drops quotes, semicolons and line breaks, and replaces non-ASCII', () => {
    expect(consoleText('a"b;c\nd ü', 60)).toBe('abcd ?');
  });

  it('cuts after neutralizing, so a cut never leaves a // behind', () => {
    expect(consoleText('ab//', 3)).toBe('ab/');
  });

  it('quoted() still takes a URL: inside quotes // is not a comment', () => {
    expect(quoted('https://riversidepug.com')).toBe('"https://riversidepug.com"');
  });
});
```

In `tests/series.test.ts`, inside `describe('SeriesEngine: booking, the game burst and connect', ...)`, add:

```ts
  it('a team name with ; or // reaches the start line as plain text, never a second command or a comment', async () => {
    f = await seriesFixture();
    f.db.prepare("UPDATE event_entries SET name = 'Bats; quit // x' WHERE name = 'Bats'").run();
    await f.tick();
    const line = f.sent.find((c) => c.startsWith('say [Match] Game 1:'))!;
    expect(line).toBe('say [Match] Game 1: No Mercy. Bats quit / / x start as survivors. Ready up when both teams are in.');
  });
```

- [ ] **Step 2: Run them to see them fail**

Run: `npx vitest run tests/consoleText.test.ts tests/series.test.ts`
Expected: FAIL. consoleText keeps `//`; the series line carries `Bats; quit // x`.

- [ ] **Step 3: Implement**

In `src/serverSetup.ts` replace the consoleText block:

```ts
/** Free text (a team name, a player's name) made safe for a console line,
 *  quoted or not: printable ASCII only, no quote or semicolon (either would
 *  end the argument or start a second command), every `//` broken up (the
 *  console reads the rest of an unquoted line after it as a comment: a
 *  player named "(S)VI // Square4 Bass" cut a `say` short on 2026-10-11),
 *  at most `max` characters. */
export function consoleText(v: string, max: number): string {
  return v.replace(/["\r\n;]/g, '').replace(/[^\x20-\x7e]/g, '?').replace(/\/(?=\/)/g, '/ ').slice(0, max);
}
```

In `src/events/series.ts` line 396 replace

```ts
    return [...this.linesFor(m, due, g.matchId), `say [Match] ${this.startText(m, due, g.matchId)}`];
```

with

```ts
    // The entry names are team names (free text): consoleText, as every other line.
    return [...this.linesFor(m, due, g.matchId), `say [Match] ${consoleText(this.startText(m, due, g.matchId), 200)}`];
```

- [ ] **Step 4: Run them to see them pass**

Run: `npx vitest run tests/consoleText.test.ts tests/series.test.ts tests/bookingRunner.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/serverSetup.ts src/events/series.ts tests/consoleText.test.ts tests/series.test.ts
git commit -m "Console text breaks up // and tournament start lines go through consoleText."
```

---

### Task 2: Passwords and the allowlist stay out of the srcds log

**Files:**
- Modify: `src/bookings/runner.ts` (`bookingLines` around line 213, `allowLines` around line 263)
- Test: `tests/bookingRunner.test.ts`

**Interfaces:**
- Produces: `export const quietLines = (lines: string[]): string[]` in `src/bookings/runner.ts`, returning `['sv_rcon_log 0', ...lines, 'sv_rcon_log 1']`. Tasks 3 and 6 use it.

- [ ] **Step 1: Prove the wrapper on the local box (gate for the rest of the task)**

Only if the 27055 server shows no humans. Set `S` to your scratchpad directory.

```bash
export RPORT=27055
R() { python3 /home/volence/l4d/nightmode/rcon.py "$@"; }
pgrep -af 'srcds_linux.*-port 27055' || echo "27055 is not running"
R status | grep -E '^players'
```

If 27055 is not running, start it (and note that you did, so Task 14 stops it by PID):

```bash
cd /home/volence/l4d1-ds/server && nohup ./srcds_run -console -game left4dead -ip 0.0.0.0 -port 27055 +tv_port 27056 -tickrate 100 \
  -maxplayers 8 +log on +sv_lan 1 +map l4d_vs_hospital01_apartment >> "$S/srcds-27055.log" 2>&1 &
for _ in $(seq 1 40); do sleep 3; R status 2>/dev/null | grep -q '^map' && break; done
R 'exec rotoblin_cheats_4v4'; sleep 20
pgrep -f 'srcds_linux.*-port 27055'   # write this PID down
```

Probe:

```bash
P=rconlogprobe$(date +%s)
R 'sv_logflush 1'
R 'sv_rcon_log 0' "echo $P" 'sv_rcon_log 1'
R "echo ${P}control"
sleep 3
LOG=$(ls -t /home/volence/l4d1-ds/server/left4dead/logs/L*.log | head -1)
grep -c "echo $P\"" "$LOG"            # expected: 0
grep -c "echo ${P}control" "$LOG"      # expected: 1 (logging is back on)
grep -rl "$P\"" /home/volence/l4d1-ds/server/left4dead/addons/sourcemod/logs/ || echo "not in SourceMod logs"
R 'sv_logflush 0'
```

Expected: the wrapped probe is absent from the newest L log and from the SourceMod logs; the control line is present. If the wrapped probe IS in the log, stop here and report to the controller: do not invent another mechanism (`log off` would drop the plugin's own event lines for the moment it is off).

- [ ] **Step 2: Write the failing test**

In `tests/bookingRunner.test.ts`, after `describe('bookingLines', ...)`, add:

```ts
describe('rcon log hygiene (scrims in game, item 16)', () => {
  it('wraps the passwords, the notice and the allowlist in sv_rcon_log 0 and 1', () => {
    const id = book();
    const b = getBooking(db, id)!;
    const lines = bookingLines(db, b);
    const off = lines.indexOf('sv_rcon_log 0');
    const on = lines.indexOf('sv_rcon_log 1');
    expect(off).toBe(0);
    for (const secret of [
      `l4d_booking_tv_password "${b.tv_password}"`, `l4d_booking_password "${b.password}"`,
      `sm_cvar sv_password "${b.password}"`, `sm_cvar tv_password "${b.tv_password}"`,
    ]) {
      const i = lines.indexOf(secret);
      expect(i).toBeGreaterThan(off);
      expect(i).toBeLessThan(on);
    }
    const allow = allowLines(db, b);
    expect(allow[0]).toBe('sv_rcon_log 0');
    expect(allow.at(-1)).toBe('sv_rcon_log 1');
    expect(allow.slice(1, -1)).not.toContain('sv_rcon_log 1');
  });
});
```

In the existing `it('allowLines chunks the list at 10 ids a line ...')` replace

```ts
      expect(lines).toHaveLength(6);
      expect(lines[1].split(' ')).toHaveLength(11);
      expect(lines[2].split(' ')).toHaveLength(5);
```

with

```ts
      // The list inside sv_rcon_log 0 and 1 (item 16).
      expect(lines).toHaveLength(8);
      expect(lines[2].split(' ')).toHaveLength(11);
      expect(lines[3].split(' ')).toHaveLength(5);
```

- [ ] **Step 3: Run it to see it fail**

Run: `npx vitest run tests/bookingRunner.test.ts -t "log hygiene|allowLines chunks"`
Expected: FAIL (no `sv_rcon_log 0` in either).

- [ ] **Step 4: Implement**

In `src/bookings/runner.ts`, above `bookingLines`, add:

```ts
/** srcds writes every rcon command into its log (`rcon from "...": command
 *  "..."`), the file and the logaddress stream alike, so a password or the
 *  allowlist pushed in the clear sits in plain text there. Logging is off
 *  around such lines, the way gameLines sends the log secret: BoxRcon awaits
 *  each reply before sending the next line and srcds runs a command before it
 *  answers, so the lines in between are never logged (proved on the local
 *  box, plan 2026-10-11 Task 2). */
export const quietLines = (lines: string[]): string[] => ['sv_rcon_log 0', ...lines, 'sv_rcon_log 1'];
```

In `bookingLines` replace the `return [ ... ];` with:

```ts
  return quietLines([
    `l4d_booking_tv_password ${quoted(b.tv_password)}`,
    `l4d_booking_notice ${quoted(notice)}`,
    `l4d_booking_password ${quoted(b.password)}`,
    `sm_cvar sv_password ${quoted(b.password)}`,
    `sm_cvar tv_password ${quoted(b.tv_password)}`,
  ]);
```

In `allowLines` replace `return lines;` with `return quietLines(lines);`.

- [ ] **Step 5: Run the runner and recovery suites**

Run: `npx vitest run tests/bookingRunner.test.ts tests/bookingRecovery.test.ts tests/entryManagers.test.ts tests/series.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/bookings/runner.ts tests/bookingRunner.test.ts
git commit -m "Booking passwords and the allowlist are pushed with rcon logging turned off around them."
```

---

### Task 3: The box is told the booking's clock

**Files:**
- Modify: `src/bookings/runner.ts` (`bookingLines`, a new `stateLines`, `CLEAR_LINES`)
- Test: `tests/bookingRunner.test.ts`

**Interfaces:**
- Consumes: `quietLines` (Task 2).
- Produces: on a scrim, `bookingLines(db, b)` ends with six lines that l4d_booking 1.5.0 (Task 13) reads:
  `l4d_booking_title "<side a> vs <side b>"`, `l4d_booking_campaign "<name of the campaign on the box>"`, `l4d_booking_ends <epoch s>`, `l4d_booking_next_at <epoch s or 0>`, `l4d_booking_next_name "<name or empty>"`, `l4d_booking_close_at <epoch s or 0>`. A tournament booking gets none. `CLEAR_LINES` resets all six.

- [ ] **Step 1: Write the failing tests**

In `tests/bookingRunner.test.ts` add `advancePlaylist, markReady` to the import from `../src/bookings/bookings.js`, then add after the Task 2 describe:

```ts
describe('the plugin clock lines (scrims in game, items 4, 5 and 8)', () => {
  const epochOf = (iso: string) => Math.floor(Date.parse(iso) / 1000);
  const runningBooking = (playlist: string[]) => {
    const id = book({ playlist });
    holdBox(db, id, 3, new Date(now));
    markSetup(db, id, new Date(now));
    markReady(db, id, new Date(now));
    return id;
  };

  it('a scrim pushes the title, the campaign on the box, the slot end, and nothing due', () => {
    const id = book({ playlist: ['no_mercy', 'death_toll'] });
    expect(bookingLines(db, getBooking(db, id)!)).toEqual(expect.arrayContaining([
      `l4d_booking_title "p0's group vs p1's group"`,
      'l4d_booking_campaign "No Mercy"',
      `l4d_booking_ends ${epochOf('2026-10-02T23:00:00.000Z')}`,
      'l4d_booking_next_at 0', 'l4d_booking_next_name ""', 'l4d_booking_close_at 0',
    ]));
  });

  it('a due next campaign and a pending close go as epochs, and the campaign follows the last load', () => {
    const id = runningBooking(['no_mercy', 'death_toll']);
    const at = '2026-10-02T21:01:00.000Z';
    setNext(db, id, 'death_toll', at, new Date(now));
    let lines = bookingLines(db, getBooking(db, id)!);
    expect(lines).toContain(`l4d_booking_next_at ${epochOf(at)}`);
    expect(lines).toContain('l4d_booking_next_name "Death Toll"');
    advancePlaylist(db, id, 1, new Date(now));
    lines = bookingLines(db, getBooking(db, id)!);
    expect(lines).toContain('l4d_booking_campaign "Death Toll"');
    expect(lines).toContain('l4d_booking_next_at 0');
    db.prepare('UPDATE bookings SET close_at = ? WHERE id = ?').run('2026-10-02T23:05:00.000Z', id);
    expect(bookingLines(db, getBooking(db, id)!)).toContain(`l4d_booking_close_at ${epochOf('2026-10-02T23:05:00.000Z')}`);
  });

  it('a tournament booking pushes none of them', () => {
    const r = createTournamentBooking(db, {
      region: 'na', campaign: 'no_mercy', rulesJson: '{}', rulesetId: null, gameConfig: 'standard', createdBy: P[9],
      sides: [{ teamId: null, captain: P[2], players: P.slice(2, 6), spectators: [] }, { teamId: null, captain: P[6], players: P.slice(6, 10), spectators: [] }],
      now: new Date(now),
    });
    if (!r.ok) throw new Error(r.error);
    const lines = bookingLines(db, getBooking(db, r.value.id)!);
    expect(lines.some((l) => /^l4d_booking_(title|campaign|ends|next_at|next_name|close_at) /.test(l))).toBe(false);
  });
});
```

In `it('clears the booking cvars before the release, ...')` replace the `expect(CLEAR_LINES).toEqual([ ... ]);` array's last line

```ts
      'sm_pug_tech_limit 0', 'sm_pug_tech_seconds 300', 'sm_pug_dc_team_seconds 0', 'sm_pug_sub_emergency 0', 'sm_pug_sub_charge 0', 'sm_pug_admin_cooldown 180',
    ]);
```

with

```ts
      'sm_pug_tech_limit 0', 'sm_pug_tech_seconds 300', 'sm_pug_dc_team_seconds 0', 'sm_pug_sub_emergency 0', 'sm_pug_sub_charge 0', 'sm_pug_admin_cooldown 180',
      // Scrims in game: the plugin's clock, so a skipped restart cannot leave a countdown running.
      'l4d_booking_title ""', 'l4d_booking_campaign ""', 'l4d_booking_ends 0', 'l4d_booking_next_at 0', 'l4d_booking_next_name ""', 'l4d_booking_close_at 0',
    ]);
```

- [ ] **Step 2: Run them to see them fail**

Run: `npx vitest run tests/bookingRunner.test.ts -t "clock lines|clears the booking cvars"`
Expected: FAIL.

- [ ] **Step 3: Implement**

In `src/bookings/runner.ts`, below `quietLines`, add:

```ts
/** An ISO time (or null) as whole epoch seconds for a plugin cvar; 0 for none. */
const epochOf = (t: string | null): number => (t === null ? 0 : Math.floor(Date.parse(t) / 1000));

/** The campaign the box is on: the last one the runner loaded
 *  (campaign_loaded), else the playlist's current one (setup loads
 *  playlist[playlist_pos] without that event). */
function currentCampaign(db: DB, b: BookingRow): string | null {
  const row = db.prepare("SELECT detail FROM booking_events WHERE booking_id = ? AND event = 'campaign_loaded' ORDER BY id DESC LIMIT 1")
    .get(b.id) as { detail: string } | undefined;
  const loaded = row ? (JSON.parse(row.detail) as { campaign?: string | null }).campaign ?? null : null;
  return loaded ?? (JSON.parse(b.playlist_json) as string[])[b.playlist_pos] ?? null;
}

/** The booking's clock for l4d_booking 1.5.0 (scrims in game): its `!time`,
 *  the countdowns before the next campaign and the close, and the state it
 *  re-tells each player once they are in game all come from these, so the
 *  site never repeats chat over rcon. Epochs in whole seconds, 0 for none.
 *  An older plugin answers "Unknown command" to each, which nothing reads. */
function stateLines(db: DB, b: BookingRow): string[] {
  const [a, bs] = sidesOf(db, b.id);
  const registry = campaignRegistry(db);
  const nameOf = (slug: string | null) => consoleText(slug === null ? '' : registry.get(slug)?.name ?? slug, 60);
  return [
    `l4d_booking_title ${quoted(consoleText(`${sideName(db, a)} vs ${sideName(db, bs)}`, 100))}`,
    `l4d_booking_campaign ${quoted(nameOf(currentCampaign(db, b)))}`,
    `l4d_booking_ends ${epochOf(b.ends_at)}`,
    `l4d_booking_next_at ${epochOf(b.next_at)}`,
    `l4d_booking_next_name ${quoted(nameOf(b.next_campaign))}`,
    `l4d_booking_close_at ${epochOf(b.close_at)}`,
  ];
}
```

In `bookingLines` replace the `return quietLines([ ... ]);` from Task 2 with:

```ts
  return [
    ...quietLines([
      `l4d_booking_tv_password ${quoted(b.tv_password)}`,
      `l4d_booking_notice ${quoted(notice)}`,
      `l4d_booking_password ${quoted(b.password)}`,
      `sm_cvar sv_password ${quoted(b.password)}`,
      `sm_cvar tv_password ${quoted(b.tv_password)}`,
    ]),
    // T3b Ruling 10: the series engine speaks on a tournament box; the plugin's clock stays empty there.
    ...(b.purpose === 'tournament' ? [] : stateLines(db, b)),
  ];
```

Update the doc comment above `bookingLines` to end with: `On a scrim, the booking's clock for l4d_booking 1.5.0 (stateLines).`

In `CLEAR_LINES`, after `...TOURNAMENT_RULE_CLEAR,` add:

```ts
  // Scrims in game: l4d_booking's clock, so a skipped restart cannot leave a countdown running.
  'l4d_booking_title ""', 'l4d_booking_campaign ""', 'l4d_booking_ends 0', 'l4d_booking_next_at 0', 'l4d_booking_next_name ""', 'l4d_booking_close_at 0',
```

- [ ] **Step 4: Run them to see them pass**

Run: `npx vitest run tests/bookingRunner.test.ts tests/bookingRecovery.test.ts tests/series.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/bookings/runner.ts tests/bookingRunner.test.ts
git commit -m "Scrim boxes are told the booking's title, campaign, slot end, next load and close as plugin cvars."
```

---

### Task 4: Warnings at 30 and 10 minutes, and the slot ending during a game

**Files:**
- Modify: `src/bookings/runner.ts` (`WARN_MINUTES`, the warning block at the end of `watch`, the past-end branch of `onGameEnded`)
- Test: `tests/bookingRunner.test.ts`

**Interfaces:**
- Produces: `export const WARN_AT_MINUTES: readonly number[]`, `export function warnMark(leftMs: number, warned: number | null): number | null`, `export function leftText(ms: number): string` (ceil minutes: `"29 min"`, `"1 h 52 min"`, `"2 h"`; the plugin's `!time` uses the same rule). `WARN_MINUTES` is removed.

- [ ] **Step 1: Write the failing tests**

Add to the import from `../src/bookings/runner.js`: `leftText, warnMark`. Add a describe:

```ts
describe('slot warnings (scrims in game, items 4 and 7)', () => {
  it('leftText rounds up to whole minutes, hours past 60', () => {
    expect(leftText(29 * MIN)).toBe('29 min');
    expect(leftText(29 * MIN - 1)).toBe('29 min');
    expect(leftText(10_000)).toBe('1 min');
    expect(leftText(112 * MIN)).toBe('1 h 52 min');
    expect(leftText(120 * MIN)).toBe('2 h');
  });

  it('warnMark says the smallest mark crossed, once', () => {
    expect(warnMark(31 * MIN, null)).toBeNull();
    expect(warnMark(29 * MIN, null)).toBe(30);
    expect(warnMark(25 * MIN, 30)).toBeNull();
    expect(warnMark(9 * MIN, 30)).toBe(10);
    expect(warnMark(8 * MIN, null)).toBe(10);
    expect(warnMark(5 * MIN, 10)).toBeNull();
  });
});
```

Replace the whole test `it('warns once, about 10 minutes before the slot ends, then an idle booking ends on time', ...)` (and its two comment lines above it) with:

```ts
  // Scrims in game Ruling 6: a warning at 30 and at 10 minutes left.
  it('warns at 30 and at 10 minutes before the slot ends, once each, then an idle booking ends on time', async () => {
    const id = await ready();
    box.ccc.humans = [P[0]];
    const says = () => sent.flatMap((s) => s.cmds).filter((c) => c.includes('left in the booked slot'));
    const W29 = 'say [Booking] 29 min left in the booked slot (ends 21:30 UTC). No new campaign starts after the end.';
    const W10 = 'say [Booking] 10 min left in the booked slot (ends 21:30 UTC). No new campaign starts after the end.';
    now = START + 59 * MIN; await runner.tick();
    expect(says()).toEqual([]);
    now = START + 61 * MIN; await runner.tick();
    now = START + 62 * MIN; await runner.tick();
    expect(says()).toEqual([W29]);
    now = START + 80 * MIN; await runner.tick();
    now = START + 81 * MIN; await runner.tick();
    now = START + 85 * MIN; await runner.tick();
    expect(says()).toEqual([W29, W10]);
    now = START + 90 * MIN; await runner.tick();
    await runner.idle();
    expect(getBooking(db, id)).toMatchObject({ state: 'ended', end_reason: 'time' });
  });
```

Replace the test `it('the 10 minute warning is said only between games, never during the grace', ...)` with:

```ts
    it('a warning during a game says the game will be finished, and is not said again after it', async () => {
      const id = await running(); // until 23:00
      box.ccc.humans = [P[0], P[1]];
      const says = () => cmds().filter((c) => c.includes('left in the booked slot'));
      const live = insertGame(id, { state: 'live' });
      now = START + 170 * MIN;
      await runner.tick();
      now = START + 171 * MIN;
      await runner.tick();
      expect(says()).toEqual(['say [Booking] 10 min left in the booked slot (ends 23:00 UTC). This game will be finished even if it runs past the end.']);
      db.prepare("UPDATE matches SET state = 'completed', ended_at = ? WHERE id = ?").run(sqlTime(now), live);
      runner.onGameEnded(live);
      now = START + 172 * MIN;
      await runner.tick();
      await runner.idle();
      expect(says()).toHaveLength(1);
    });
```

In `it('no 10 minute warning during the closing grace: ...')` replace `c.includes('of the booked slot left')` with `c.includes('left in the booked slot')`.

In `it('a live game at the slot end keeps the booking open; it ends after the game', ...)`, after the second `await runner.idle();` (the one following `now = START + 200 * MIN;`), add:

```ts
      // Ruling 6: said once, however many watches pass.
      expect(cmds().filter((c) => c.includes('The booked slot is over'))).toEqual([
        'say [Booking] The booked slot is over (23:00 UTC). This game will be finished, then the server closes.',
      ]);
```

and after its `expect(cmds().some((c) => c.startsWith('say [Booking] Next:'))).toBe(false);` add:

```ts
      expect(cmds()).toContain('say [Booking] The booked slot is over, so that was the last game. The server closes within a minute.');
```

- [ ] **Step 2: Run them to see them fail**

Run: `npx vitest run tests/bookingRunner.test.ts -t "slot warnings|warns at 30|warning during a game|live game at the slot end|closing grace: the close line"`
Expected: FAIL.

- [ ] **Step 3: Implement**

In `src/bookings/runner.ts` replace

```ts
/** Minutes left on the slot at which the box says so in chat, once, and
 *  only between games (bookings by campaign, Ruling 4). */
export const WARN_MINUTES = 10;
```

with

```ts
/** Minutes left on the slot at which the box says so in chat (scrims in game
 *  Ruling 6; was one warning at 10, between games only). */
export const WARN_AT_MINUTES: readonly number[] = [10, 30];

/** The mark to say now: the smallest one the time left has crossed that is
 *  below the last one said (warned_minutes), or null. A booking first seen
 *  8 minutes from its end hears the 10 only. */
export function warnMark(leftMs: number, warned: number | null): number | null {
  for (const m of [...WARN_AT_MINUTES].sort((x, y) => x - y)) {
    if (leftMs <= m * 60_000 && (warned === null || warned > m)) return m;
  }
  return null;
}

/** Time left in whole minutes, rounded up: "29 min", "1 h 52 min", "2 h".
 *  l4d_booking's !time words it the same way. */
export function leftText(ms: number): string {
  const min = Math.max(1, Math.ceil(ms / 60_000));
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  return min % 60 === 0 ? `${h} h` : `${h} h ${min % 60} min`;
}
```

At the end of `watch`, replace the whole block that starts with `// Ruling 4: one warning, only between games,` through its closing `}` (the `try { await this.deps.rcon(... About ...) } catch { // Best effort. }` and the `if`'s closing brace) with:

```ts
    // Scrims in game Ruling 6: a warning at 30 and at 10 minutes left (the
    // smallest mark crossed), during a game too since the slot's end never
    // cuts one, and not during a closing grace (the close line has said what
    // happens next). Past the end with a game live, the box says once that
    // the slot is over (warned_minutes 0). +1 campaign clears warned_minutes,
    // so a moved end is warned about again.
    if (fresh.purpose !== 'tournament' && fresh.close_at === null) {
      const live = liveBookingGame(this.db, b.id) !== null;
      const leftMs = endsMs - nowMs;
      const ends = fresh.ends_at.slice(11, 16);
      const mark = leftMs > 0 ? warnMark(leftMs, fresh.warned_minutes) : null;
      let line: string | null = null;
      if (mark !== null) {
        setWarned(this.db, b.id, mark);
        line = `say [Booking] ${leftText(leftMs)} left in the booked slot (ends ${ends} UTC). ${live ? 'This game will be finished even if it runs past the end.' : 'No new campaign starts after the end.'}`;
      } else if (leftMs <= 0 && live && fresh.warned_minutes !== 0) {
        setWarned(this.db, b.id, 0);
        line = `say [Booking] The booked slot is over (${ends} UTC). This game will be finished, then the server closes.`;
      }
      if (line !== null) {
        try {
          await this.deps.rcon(server, [line]);
        } catch {
          // Best effort.
        }
      }
    }
```

In `onGameEnded` replace

```ts
    } else if (nowMs >= Date.parse(b.ends_at)) {
      return;
    } else {
```

with

```ts
    } else if (nowMs >= Date.parse(b.ends_at)) {
      // Ruling 4 still: nothing more loads; the next watch ends the booking on time.
      line = 'say [Booking] The booked slot is over, so that was the last game. The server closes within a minute.';
    } else {
```

Update the `onGameEnded` doc comment sentence "A game that finished past the slot's end announces nothing: the next watch ends the booking on time (Ruling 4)." to "A game that finished past the slot's end schedules nothing and says the server closes within a minute: the next watch ends the booking on time (Ruling 4)."

- [ ] **Step 4: Run the suite**

Run: `npx vitest run tests/bookingRunner.test.ts`
Expected: PASS. Any other assertion on the old `About N minutes of the booked slot left` text is in the tests replaced above; `grep -n "of the booked slot left" tests/` must print nothing.

- [ ] **Step 5: Commit**

```bash
git add src/bookings/runner.ts tests/bookingRunner.test.ts
git commit -m "Scrim boxes warn at 30 and 10 minutes left, during a game too, and say once when the slot ends mid game."
```

---

### Task 5: The next campaign and the close happen on time, and the box knows when

**Files:**
- Modify: `src/bookings/runner.ts` (deps, constructor, `onGameEnded`, `scheduleNext`, a new `sayWithState`, `wakeAt`, `closeIfDue`, `onExtended`)
- Test: `tests/bookingRunner.test.ts`

**Interfaces:**
- Produces: `BookingRunnerDeps.later?: (ms: number, fn: () => void) => void` (default `setTimeout`, unref'd); `export const WAKE_SLACK_MS = 250`; the scheduling line is now `say [Booking] Next: <name> in 60 seconds. !nextmap to pick another, !stay to replay this one, !end to finish.`

- [ ] **Step 1: Wire the timer recorder into the test helpers**

In `tests/bookingRunner.test.ts`: add `let timers: { ms: number; fn: () => void }[];` next to the other `let`s; in `beforeEach` add `timers = [];` to the reset line; in `build()` add `later: (ms, fn) => { timers.push({ ms, fn }); },` before `...over`. Add `WAKE_SLACK_MS` to the runner import.

Replace the constant

```ts
  const NEXT_DT = 'say [Booking] Next: Death Toll in about a minute. !nextmap to pick another, !stay to replay this one, !end to finish.';
```

with

```ts
  const NEXT_DT = 'say [Booking] Next: Death Toll in 60 seconds. !nextmap to pick another, !stay to replay this one, !end to finish.';
```

and in the test around line 1330 replace `'say [Booking] Next: No Mercy in about a minute. !nextmap to pick another, !stay to replay this one, !end to finish.'` with `'say [Booking] Next: No Mercy in 60 seconds. !nextmap to pick another, !stay to replay this one, !end to finish.'`.

- [ ] **Step 2: Write the failing tests**

Inside `describe('booked games (plan 4b)', ...)` add:

```ts
  it('after a game the box is told the next load as an epoch, and a timer loads it on time, once, never early', async () => {
    const id = await running();
    box.ccc.humans = [P[0], P[1]];
    now = START + 89 * MIN;
    const game = insertGame(id, { state: 'completed', endedAt: now });
    timers = [];
    runner.onGameEnded(game);
    await flush();
    const at = now + MIN;
    expect(cmds()).toEqual(expect.arrayContaining([`l4d_booking_next_at ${Math.floor(at / 1000)}`, 'l4d_booking_next_name "Death Toll"', NEXT_DT]));
    expect(timers.map((t) => t.ms)).toEqual([MIN + WAKE_SLACK_MS]);
    // Fired early: nothing loads.
    timers[0]!.fn();
    await runner.idle();
    expect(cmds().some((c) => c.startsWith('changelevel'))).toBe(false);
    sent = [];
    now = at;
    timers[0]!.fn();
    await runner.idle();
    // Fired twice: the second finds nothing due.
    timers[0]!.fn();
    await runner.idle();
    expect(cmds().filter((c) => c.startsWith('changelevel'))).toEqual(['changelevel l4d_vs_smalltown01_caves']);
    expect(cmds()).toContain('l4d_booking_next_at 0');
    expect(getBooking(db, id)).toMatchObject({ playlist_pos: 1, next_campaign: null });
  });

  it('the closing grace ends on a timer at close_at, and the box was told the close as an epoch', async () => {
    const id = await running(['no_mercy']);
    now = START + 60 * MIN;
    timers = [];
    runner.onGameEnded(insertGame(id, { state: 'completed', endedAt: now }));
    await flush();
    const closeAt = now + 5 * MIN;
    expect(cmds()).toContain(`l4d_booking_close_at ${Math.floor(closeAt / 1000)}`);
    expect(cmds()).toContain(CLOSE_1);
    expect(timers.map((t) => t.ms)).toEqual([5 * MIN + WAKE_SLACK_MS]);
    timers[0]!.fn();
    expect(getBooking(db, id)!.ending_at).toBeNull();
    now = closeAt;
    timers[0]!.fn();
    await runner.idle();
    expect(getBooking(db, id)).toMatchObject({ state: 'ended', end_reason: 'done' });
  });

  it('+1 campaign during the close tells the box the close is off', async () => {
    const id = await running(['no_mercy']);
    now = START + 60 * MIN;
    runner.onGameEnded(insertGame(id, { state: 'completed', endedAt: now }));
    await flush();
    sent = [];
    expect(addCampaign(db, { bookingId: id, by: P[0], campaign: 'death_toll', now: new Date(now) }).ok).toBe(true);
    runner.onExtended(id);
    await flush();
    expect(cmds()).toContain('l4d_booking_close_at 0');
    expect(cmds()).toContain('l4d_booking_next_name "Death Toll"');
  });
```

- [ ] **Step 3: Run them to see them fail**

Run: `npx vitest run tests/bookingRunner.test.ts -t "on time, once|on a timer at close_at|close is off|announced, then loaded"`
Expected: FAIL (no `later` dep, old text, no clock lines in the game-end burst).

- [ ] **Step 4: Implement**

In `BookingRunnerDeps`, after `sleep?`, add:

```ts
  /** Run `fn` once after `ms` (the next campaign's load and the close at
   *  their exact times, scrims in game Ruling 4). Default setTimeout,
   *  unref'd; the minute watch stays the fallback after a web restart. */
  later?: (ms: number, fn: () => void) => void;
```

Below `NEXT_DELAY_MS` add:

```ts
/** A timer fires this long after the time it waits for, so the runner's own
 *  "is it due yet" check (next_at <= now) is already true when it runs. */
export const WAKE_SLACK_MS = 250;
```

Add a field `private readonly later: (ms: number, fn: () => void) => void;` beside `sleep`, and in the constructor:

```ts
    this.later = deps.later ?? ((ms, fn) => { const t = setTimeout(fn, ms); t.unref?.(); });
```

Replace `scheduleNext` with:

```ts
  /** The next campaign by the count (playlist[played], or the last one again
   *  once the playlist is shorter than the count), due NEXT_DELAY_MS from
   *  now, with a timer to load it then. Returns the line that says so. */
  private scheduleNext(b: BookingRow, played: number, nowMs: number): string {
    const playlist = JSON.parse(b.playlist_json) as string[];
    const next = playlist[played] ?? playlist[playlist.length - 1];
    const at = nowMs + NEXT_DELAY_MS;
    setNext(this.db, b.id, next, new Date(at).toISOString(), new Date(nowMs));
    this.wakeAt(b.id, at, 'load');
    const name = consoleText(campaignRegistry(this.db).get(next)?.name ?? next, 60);
    return `say [Booking] Next: ${name} in ${NEXT_DELAY_MS / 1000} seconds. !nextmap to pick another, !stay to replay this one, !end to finish.`;
  }

  /** Load the due campaign, or end a due close, at `atMs`. A timer that
   *  fires early, twice, or after a captain moved things on finds nothing due
   *  (loadNext and dueEnd check) and does nothing. Never throws. */
  private wakeAt(id: number, atMs: number, what: 'load' | 'close'): void {
    this.later(Math.max(0, atMs - this.now()) + WAKE_SLACK_MS, () => {
      try {
        if (what === 'load') this.track(id, () => this.loadNext(id));
        else this.closeIfDue(id);
      } catch (err) {
        console.error(`[booking] ${id}: the ${what} timer failed:`, err);
      }
    });
  }

  /** The close timer: end the booking now if its end is due. */
  private closeIfDue(id: number): void {
    const b = this.running(id);
    if (!b) return;
    const nowMs = this.now();
    const due = this.dueEnd(b, nowMs);
    if (due) this.endNow(id, due, new Date(nowMs));
  }

  /** A chat line together with the booking lines, so l4d_booking's clock
   *  (next load, close) changes in the same burst that says it. Best effort. */
  private sayWithState(id: number, line: string, what: string): void {
    const b = getBooking(this.db, id);
    const server = b && b.server_id !== null ? getServer(this.db, b.server_id) : undefined;
    if (!b || !server) return;
    void this.push(id, server, () => [...bookingLines(this.db, b), line], what);
  }
```

In `onGameEnded`, inside the `played >= b.games_allowed` branch, replace

```ts
      if (!setCloseAt(this.db, b.id, played, new Date(nowMs + graceMin * 60_000).toISOString(), new Date(nowMs))) return;
```

with

```ts
      const closeMs = nowMs + graceMin * 60_000;
      if (!setCloseAt(this.db, b.id, played, new Date(closeMs).toISOString(), new Date(nowMs))) return;
      this.wakeAt(b.id, closeMs, 'close');
```

and replace the last line `this.say(b.id, line, 'next campaign line');` with `this.sayWithState(b.id, line, 'next campaign line');`. Update the doc comment's "on the first minute watch at least 60 s later (so 60 to 120 s: "in about a minute")" to "60 s later by a timer (the minute watch is the fallback)".

`onExtended` already pushes `bookingLines` first, so its burst carries the cleared close and any new next; no change there beyond what `scheduleNext` now does.

- [ ] **Step 5: Run the runner suites**

Run: `npx vitest run tests/bookingRunner.test.ts tests/bookingRecovery.test.ts tests/series.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/bookings/runner.ts tests/bookingRunner.test.ts
git commit -m "The next campaign loads and the closing grace ends on timers, and the box is told both in the same burst."
```

---

### Task 6: The booking's people go to pug-match with every game burst

**Files:**
- Modify: `src/bookings/bookings.ts` (new `firstSurvivorSide`, `bookRoster`)
- Modify: `src/bookings/runner.ts` (new `bookRosterLines`, `BOOK_CHUNK`; `gameLines`; `hideAllowIds`; `loadNext`; `CLEAR_LINES`)
- Test: `tests/bookings.test.ts`, `tests/bookingRunner.test.ts`

**Interfaces:**
- Consumes: `quietLines` (Task 2).
- Produces:
  - `export function firstSurvivorSide(b: BookingRow, played: number): Side` (bookings.ts)
  - `export function bookRoster(db: DB, bookingId: number): { a: string[]; b: string[]; watch: string[] }` (bookings.ts)
  - `export const BOOK_CHUNK = 10`, `export function bookRosterLines(db: DB, b: BookingRow): string[]` (runner.ts): `quietLines(['sm_pug_book_begin', 'sm_pug_book_add a <ids>', ..., 'sm_pug_book_add b <ids>', ..., 'sm_pug_book_add s <ids>', ..., 'sm_pug_book_commit <a|b>'])`, or `[]` for a tournament booking or a ruleset without `teamLock`. pug-match 0.3.33 (Task 12) reads these commands.
  - `CLEAR_LINES` gains `'sm_pug_book_clear'`.

- [ ] **Step 1: Write the failing domain tests**

In `tests/bookings.test.ts` add `bookRoster, firstSurvivorSide, type BookingRow` to the import from `../src/bookings/bookings.js` and `import { TEMPLATES } from '../src/rulesets.js';`. Add a top-level describe:

```ts
describe('firstSurvivorSide (scrims in game Ruling 2)', () => {
  const withRule = (sideRule: string, id = 7) =>
    ({ id, purpose: 'scrim', rules_json: JSON.stringify({ ...TEMPLATES['Casual Scrim'], sideRule }) }) as unknown as BookingRow;

  it('non_picker_chooses: side b survives first in campaign 1, then the sides alternate', () => {
    expect([0, 1, 2, 3].map((n) => firstSurvivorSide(withRule('non_picker_chooses'), n))).toEqual(['b', 'a', 'b', 'a']);
  });

  it('higher_seed_chooses starts with side a; coin goes by the booking id', () => {
    expect(firstSurvivorSide(withRule('higher_seed_chooses'), 0)).toBe('a');
    expect(firstSurvivorSide(withRule('coin', 7), 0)).toBe('a');
    expect(firstSurvivorSide(withRule('coin', 8), 0)).toBe('b');
    expect(firstSurvivorSide(withRule('coin', 8), 1)).toBe('a');
  });

  it('unreadable rules start with side a', () => {
    expect(firstSurvivorSide({ id: 1, purpose: 'scrim', rules_json: '{' } as unknown as BookingRow, 0)).toBe('a');
  });
});
```

Inside `describe('who may be on the box (plan 4b2)', ...)` add:

```ts
  it('bookRoster splits the accepted people by side, watchers apart, never the barred or the invited', () => {
    const id = running();
    const accept = (side: 'a' | 'b', by: string, steamid: string, role: string) => {
      addPerson(db, { bookingId: id, by, side, steamid, role, now: NOW });
      respondPerson(db, { bookingId: id, steamid, accept: true, now: NOW });
    };
    accept('a', P[0], P[5], 'spectator');
    accept('b', P[1], P[6], 'ringer');
    accept('a', P[0], P[7], 'player');
    addPerson(db, { bookingId: id, by: P[0], side: 'a', steamid: P[8], role: 'player', now: NOW }); // invited only
    ban(P[7]);
    expect(bookRoster(db, id)).toEqual({ a: [P[0]], b: [P[1], P[6]], watch: [P[5]] });
  });
```

- [ ] **Step 2: Write the failing runner tests**

In `tests/bookingRunner.test.ts` add `bookRosterLines, hideAllowIds, gameLines` to the runner import (`gameLines` is already exported) and add inside `describe('booked games (plan 4b)', ...)`:

```ts
  describe('the booking roster for pug-match (scrims in game Ruling 1)', () => {
    const rosterPart = (c: string[]) => c.filter((x) => x.startsWith('sm_pug_book_'));

    it('every game burst carries the sides and who survives first, inside sv_rcon_log 0 and 1', async () => {
      const id = await running();
      const b = getBooking(db, id)!;
      const lines = gameLines(db, b, getServer(db, 3)!);
      expect(rosterPart(lines)).toEqual(['sm_pug_book_begin', `sm_pug_book_add a ${P[0]}`, `sm_pug_book_add b ${P[1]}`, 'sm_pug_book_commit b']);
      const begin = lines.indexOf('sm_pug_book_begin');
      expect(lines[begin - 1]).toBe('sv_rcon_log 0');
      expect(lines[lines.indexOf('sm_pug_book_commit b') + 1]).toBe('sv_rcon_log 1');
      // The minute watch re-sends it.
      box.ccc.humans = [P[0]];
      now = START + 5 * MIN;
      await runner.tick();
      expect(rosterPart(cmds())).toContain('sm_pug_book_commit b');
    });

    it('after a finished game the other side survives first, sent before the next changelevel', async () => {
      const id = await running();
      box.ccc.humans = [P[0], P[1]];
      now = START + 89 * MIN;
      runner.onGameEnded(insertGame(id, { state: 'completed', endedAt: now }));
      await flush();
      sent = [];
      now += MIN;
      timers.at(-1)!.fn();
      await runner.idle();
      const c = cmds();
      expect(c.indexOf('sm_pug_book_commit a')).toBeGreaterThan(-1);
      expect(c.indexOf('sm_pug_book_commit a')).toBeLessThan(c.indexOf('changelevel l4d_vs_smalltown01_caves'));
    });

    it('nothing for a ruleset without the team lock, nor for a tournament booking', async () => {
      const id = await running();
      db.prepare('UPDATE bookings SET rules_json = ? WHERE id = ?').run(JSON.stringify({ ...TEMPLATES['Casual Scrim'], teamLock: false }), id);
      expect(bookRosterLines(db, getBooking(db, id)!)).toEqual([]);
      db.prepare("UPDATE bookings SET purpose = 'tournament', rules_json = ? WHERE id = ?").run(JSON.stringify(TEMPLATES['Casual Scrim']), id);
      expect(bookRosterLines(db, getBooking(db, id)!)).toEqual([]);
    });

    it('an rcon error naming a roster line hides its ids', () => {
      expect(hideAllowIds(`rcon exec timeout: sm_pug_book_add a ${P[0]} ${P[1]}`)).toBe('rcon exec timeout: sm_pug_book_add a (2 ids)');
    });

    it('a box on the old plugins answers Unknown command to the new lines, and setup and the watch carry on', async () => {
      const old = build({
        rcon: async (server, c) => {
          const replies = await fakeRcon(server, c);
          return c.map((x, i) => (/^(sm_pug_book_|l4d_booking_(title|campaign|ends|next_at|next_name|close_at) )/.test(x) ? `Unknown command "${x.split(' ')[0]}"` : replies[i]!));
        },
      });
      const id = book();
      now = START - 15 * MIN;
      old.allocate();
      await old.idle();
      expect(getBooking(db, id)!.state).toBe('ready');
      box.ccc.humans = [P[0]];
      now = START + 5 * MIN;
      await old.tick();
      expect(getBooking(db, id)!.state).toBe('active');
    });
  });
```

Add `import { getServer } from '../src/serverPool.js';` (extend the existing serverPool import) and `import { TEMPLATES } from '../src/rulesets.js';` at the top of the file. In the `CLEAR_LINES` exact array (Task 3) append `'sm_pug_book_clear',` after the clock line, with the comment `// Scrims in game: pug-match forgets the booking's people.`

- [ ] **Step 3: Run them to see them fail**

Run: `npx vitest run tests/bookings.test.ts tests/bookingRunner.test.ts -t "firstSurvivorSide|bookRoster|booking roster|clears the booking cvars"`
Expected: FAIL (functions missing).

- [ ] **Step 4: Implement the domain half**

In `src/bookings/bookings.ts`, after `allowList`, add:

```ts
/** Who plays for each side and who may only watch, for pug-match's
 *  placement (scrims in game Ruling 1): accepted players and ringers by
 *  side, accepted spectators of either side as watchers, never anyone
 *  barredFromBox. Each list sorted, so a re-push sends the same lines. */
export function bookRoster(db: DB, bookingId: number): { a: string[]; b: string[]; watch: string[] } {
  const now = new Date();
  const out = { a: [] as string[], b: [] as string[], watch: [] as string[] };
  for (const p of acceptedPeople(db, bookingId)) {
    if (!/^\d{17}$/.test(p.steamid) || barredFromBox(db, p.steamid, now)) continue;
    (p.role === 'spectator' ? out.watch : out[p.side]).push(p.steamid);
  }
  out.a.sort();
  out.b.sort();
  out.watch.sort();
  return out;
}

/** The booking side that starts as survivors on the first map of the next
 *  campaign, after `played` finished games (scrims in game Ruling 2): the
 *  ruleset's sideRule picks campaign 1 (non_picker_chooses: side b, since
 *  side a made the booking and its campaigns and the site cannot ask;
 *  higher_seed_chooses: side a, scrims have no seeds; coin: the booking id,
 *  odd for side a), then the sides alternate. Unreadable rules: side a. */
export function firstSurvivorSide(b: BookingRow, played: number): Side {
  const rule = bookingRules(b)?.sideRule;
  const base: Side = rule === 'non_picker_chooses' ? 'b' : rule === 'coin' ? (b.id % 2 === 1 ? 'a' : 'b') : 'a';
  return played % 2 === 0 ? base : base === 'a' ? 'b' : 'a';
}
```

- [ ] **Step 5: Implement the runner half**

In `src/bookings/runner.ts` add `bookRoster, firstSurvivorSide` to the import from `./bookings.js`. After `allowLines` add:

```ts
/** Steamids per `sm_pug_book_add` line, as ALLOW_CHUNK. */
export const BOOK_CHUNK = 10;

/** The booking's people for pug-match 0.3.33 (scrims in game Ruling 1):
 *  side a, side b and watchers, staged and committed whole, the commit naming
 *  the side that survives first on this campaign's first map. With it the
 *  plugin places each side before go-live, keeps the team lock on for the
 *  auto-tracked game and keeps watchers and strangers off both teams. Only
 *  for a scrim whose ruleset has the team lock; a tournament box has its own
 *  roster (T3b). The ids never reach a log line: quietLines here, and
 *  hideAllowIds for an rcon error. */
export function bookRosterLines(db: DB, b: BookingRow): string[] {
  if (b.purpose === 'tournament' || bookingRules(b)?.teamLock !== true) return [];
  const r = bookRoster(db, b.id);
  const lines = ['sm_pug_book_begin'];
  for (const [code, ids] of [['a', r.a], ['b', r.b], ['s', r.watch]] as const) {
    for (let i = 0; i < ids.length; i += BOOK_CHUNK) lines.push(`sm_pug_book_add ${code} ${ids.slice(i, i + BOOK_CHUNK).join(' ')}`);
  }
  lines.push(`sm_pug_book_commit ${firstSurvivorSide(b, gamesPlayed(db, b.id))}`);
  return quietLines(lines);
}
```

In `gameLines` replace `lines.push(...allowLines(db, b));` with:

```ts
  lines.push(...allowLines(db, b), ...bookRosterLines(db, b));
```

and add to its doc comment: `Last, on a scrim, the booking's people for pug-match's placement (bookRosterLines).`

Replace `hideAllowIds` with:

```ts
/** An rcon error names the command it was on: an allowlist line (add or
 *  refuse) or a booking roster line becomes a count. */
export function hideAllowIds(message: string): string {
  const count = (ids: string) => (ids.trim() === '' ? 0 : ids.trim().split(/\s+/).length);
  return message
    .replace(/sm_booking_allow_(add|refuse)((?:\s+\d+)*)/g, (_, what: string, ids: string) => `sm_booking_allow_${what} (${count(ids)} ids)`)
    .replace(/sm_pug_book_add ([abs])((?:\s+\d+)*)/g, (_, code: string, ids: string) => `sm_pug_book_add ${code} (${count(ids)} ids)`);
}
```

In `loadNext` replace

```ts
    if (game.length > 0) await this.push(id, server, () => game, 'the game burst');
```

with

```ts
    // A scrim's roster goes before the changelevel too, so the plugin places
    // the sides of THIS campaign from the first second of its first map.
    const before = [...game, ...bookRosterLines(this.db, b)];
    if (before.length > 0) await this.push(id, server, () => before, 'the game burst');
```

In `CLEAR_LINES`, after the clock line from Task 3, add:

```ts
  // Scrims in game: pug-match forgets the booking's people (an older plugin: Unknown command).
  'sm_pug_book_clear',
```

- [ ] **Step 6: Run the suites**

Run: `npx vitest run tests/bookings.test.ts tests/bookingRunner.test.ts tests/bookingRecovery.test.ts tests/series.test.ts`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/bookings/bookings.ts src/bookings/runner.ts tests/bookings.test.ts tests/bookingRunner.test.ts
git commit -m "Scrim game bursts carry the booking's sides and who survives first for pug-match's placement."
```

---

### Task 7: `!allow` lets someone watch, `!sub` lets someone play

**Files:**
- Modify: `src/bookings/bookings.ts` (`BOOKING_ERRORS`, `allowInGame`, new `subInGame`)
- Modify: `src/logParse.ts:33` (`BOOKING_CMDS`)
- Modify: `src/bookings/runner.ts` (`onCommand`, `allowFromGame`, new `subFromGame`, import `getPlayer`)
- Test: `tests/bookings.test.ts`, `tests/bookingRunner.test.ts`, `tests/logParse.test.ts`

**Interfaces:**
- Consumes: `bookRosterLines` (Task 6).
- Produces:
  - `allowInGame(...)`: `Result<{ side: Side; added: boolean; role: PersonRole }>`; a new person is role `spectator`.
  - `export function subInGame(db: DB, o: { bookingId: number; by: string; steamid: unknown; name: unknown; now?: Date }): Result<{ side: Side; change: 'added' | 'upgraded' | 'accepted' | 'already' }>`
  - `BOOKING_ERRORS.plays_other_side` = `{ status: 409, text: 'They already play for the other side.' }`.
  - `BOOKING_CMDS` includes `'sub'`; the PUGBOOK line `cmd=sub arg=<id64> <name>` (l4d_booking 1.5.0, Task 13).

- [ ] **Step 1: Write the failing domain tests**

In `tests/bookings.test.ts` add `subInGame` to the bookings import. In `describe('who may be on the box (plan 4b2)', ...)`:

Replace the first assertions of the test using `'  Some Name  '`:

```ts
    expect(r).toEqual({ ok: true, value: { side: 'b', added: true } });
```

with

```ts
    expect(r).toEqual({ ok: true, value: { side: 'b', added: true, role: 'spectator' } });
```

and in that same test replace `toMatchObject({ side: 'b', role: 'ringer', status: 'accepted', added_by: P[1] })` with `toMatchObject({ side: 'b', role: 'spectator', status: 'accepted', added_by: P[1] })`.

In the next test replace `.toEqual({ ok: true, value: { side: 'a', added: true } });` with `.toEqual({ ok: true, value: { side: 'a', added: true, role: 'spectator' } });`.

In `it('someone already accepted is added: false and nothing changes', ...)` replace the two `toEqual` lines with:

```ts
    expect(allowInGame(db, { bookingId: id, by: P[1], steamid: P[6], name: 'n', now: NOW })).toEqual({ ok: true, value: { side: 'b', added: false, role: 'spectator' } });
    expect(allowInGame(db, { bookingId: id, by: P[1], steamid: P[0], name: 'n', now: NOW })).toEqual({ ok: true, value: { side: 'b', added: false, role: 'player' } });
```

In `it("an open invite on the captain's side is accepted (role kept) ...")` replace `.toEqual({ ok: true, value: { side: 'a', added: true } });` with `.toEqual({ ok: true, value: { side: 'a', added: true, role: 'spectator' } });`.

Then add:

```ts
  it("watchers do not count against the side's players, and are capped apart", () => {
    const id = running();
    const ins = db.prepare("INSERT INTO booking_people (booking_id, side, steamid, role, status, added_by, added_at) VALUES (?, 'a', ?, ?, 'accepted', ?, '2026-09-01T00:00:00.000Z')");
    const add = (sid: string, role: string) => { db.prepare("INSERT INTO players (steamid, name, status) VALUES (?, 'x', 'active')").run(sid); ins.run(id, sid, role, P[0]); };
    for (let i = 0; i < 12; i++) add(`765611994444444${String(i).padStart(2, '0')}`, 'player');
    expect(allowInGame(db, { bookingId: id, by: P[0], steamid: '76561199555555500', name: 'w', now: NOW }).ok).toBe(true);
    for (let i = 1; i < 12; i++) add(`765611995555555${String(i).padStart(2, '0')}`, 'spectator');
    expect(allowInGame(db, { bookingId: id, by: P[0], steamid: '76561199555555599', name: 'w', now: NOW })).toEqual({ ok: false, error: 'side_full' });
  });

  it("subInGame adds a ringer to the captain's side, turns a watcher of either side into one, accepts an invite, and refuses the other side's players", () => {
    const id = running();
    expect(subInGame(db, { bookingId: id, by: P[0], steamid: P[6], name: 'n', now: NOW })).toEqual({ ok: true, value: { side: 'a', change: 'added' } });
    expect(peopleOf(db, id).find((p) => p.steamid === P[6])).toMatchObject({ side: 'a', role: 'ringer', status: 'accepted' });
    allowInGame(db, { bookingId: id, by: P[1], steamid: P[7], name: 'n', now: NOW }); // a watcher of side b
    expect(subInGame(db, { bookingId: id, by: P[0], steamid: P[7], name: 'n', now: NOW })).toEqual({ ok: true, value: { side: 'a', change: 'upgraded' } });
    expect(peopleOf(db, id).find((p) => p.steamid === P[7])).toMatchObject({ side: 'a', role: 'ringer', status: 'accepted' });
    addPerson(db, { bookingId: id, by: P[0], side: 'a', steamid: P[8], role: 'player', now: NOW }); // invited on a
    expect(subInGame(db, { bookingId: id, by: P[0], steamid: P[8], name: 'n', now: NOW })).toEqual({ ok: true, value: { side: 'a', change: 'accepted' } });
    expect(subInGame(db, { bookingId: id, by: P[0], steamid: P[6], name: 'n', now: NOW })).toEqual({ ok: true, value: { side: 'a', change: 'already' } });
    expect(subInGame(db, { bookingId: id, by: P[1], steamid: P[6], name: 'n', now: NOW })).toEqual({ ok: false, error: 'plays_other_side' });
    addPerson(db, { bookingId: id, by: P[0], side: 'a', steamid: P[9], role: 'player', now: NOW }); // invited on a
    expect(subInGame(db, { bookingId: id, by: P[1], steamid: P[9], name: 'n', now: NOW })).toEqual({ ok: false, error: 'invited_elsewhere' });
    expect(db.prepare("SELECT COUNT(*) AS n FROM booking_events WHERE event = 'person_subbed_in_game'").get()).toEqual({ n: 3 });
  });

  it('subInGame refuses a non-captain, a banned id and a booking that is not running, like allowInGame', () => {
    const id = create();
    expect(subInGame(db, { bookingId: id, by: P[0], steamid: P[7], name: 'n', now: NOW })).toEqual({ ok: false, error: 'wrong_state' });
    confirmBooking(db, { bookingId: id, by: P[1], now: NOW });
    holdBox(db, id, servers[1], NOW);
    markSetup(db, id, NOW);
    markReady(db, id, NOW);
    expect(subInGame(db, { bookingId: id, by: P[7], steamid: P[8], name: 'n', now: NOW })).toEqual({ ok: false, error: 'not_manager' });
    ban(P[7]);
    expect(subInGame(db, { bookingId: id, by: P[0], steamid: P[7], name: 'n', now: NOW })).toEqual({ ok: false, error: 'not_player' });
  });
```

- [ ] **Step 2: Write the failing parser and runner tests**

In `tests/logParse.test.ts`, in `describe('PUGBOOK parsing', ...)`, add:

```ts
  it('parses a sub line, the steamid and name in arg (l4d_booking 1.5.0)', () => {
    const ev = parseLogDatagram(framed('PUGBOOK event=cmd cmd=sub steamid=76561198000000001 arg=76561199000000002 Some Name'));
    expect(ev).toEqual({ kind: 'booking_cmd', steamid: '76561198000000001', cmd: 'sub', arg: '76561199000000002 Some Name' });
  });
```

In `tests/bookingRunner.test.ts`, in `describe('the allowlist (plan 4b2)', ...)`, replace the test `it("a captain's !allow adds the ringer, re-pushes the list at once and says so", ...)` with:

```ts
    it("a captain's !allow lets someone watch: a spectator of the captain's side, both lists re-pushed at once, the captain named", async () => {
      const id = await running();
      const watcher = '76561199222222222';
      runner.onCommand(3, P[1], 'allow', `${watcher} Some Name`);
      await flush();
      expect(db.prepare('SELECT side, role, status, added_by FROM booking_people WHERE booking_id = ? AND steamid = ?').get(id, watcher))
        .toEqual({ side: 'b', role: 'spectator', status: 'accepted', added_by: P[1] });
      const c = cmds();
      expectList(c, [P[0], P[1], watcher]);
      expect(c).toContain(`sm_pug_book_add s ${watcher}`);
      expect(c.at(-1)).toBe('say [Booking] Some Name can watch (allowed by p1).');
    });

    it("a captain's !sub makes a watcher a ringer of the captain's side; a name with // arrives whole; a second !sub says they already play", async () => {
      const id = await running();
      const sub = '76561199222222222';
      runner.onCommand(3, P[1], 'allow', `${sub} (S)VI // Square4 Bass`);
      await flush();
      sent = [];
      runner.onCommand(3, P[0], 'sub', `${sub} (S)VI // Square4 Bass`);
      await flush();
      expect(db.prepare('SELECT side, role, status FROM booking_people WHERE booking_id = ? AND steamid = ?').get(id, sub))
        .toEqual({ side: 'a', role: 'ringer', status: 'accepted' });
      const c = cmds();
      expect(c).toContain(`sm_pug_book_add a ${[P[0], sub].sort().join(' ')}`);
      expect(c.at(-1)).toBe("say [Booking] (S)VI / / Square4 Bass is in as a sub for p0's group (by p0).");
      sent = [];
      runner.onCommand(3, P[0], 'sub', `${sub} (S)VI // Square4 Bass`);
      await flush();
      expect(cmds().at(-1)).toBe("say [Booking] (S)VI / / Square4 Bass already plays for p0's group.");
    });
```

Replace `it('a refusal from the booking rules (a full side) also takes the player back off', ...)`'s command and expectation lines

```ts
      runner.onCommand(3, P[0], 'allow', '76561199222222222 x');
      await flush();
      expect(cmds()).toEqual(['say [Booking] That side is full.', 'sm_booking_allow_refuse 76561199222222222']);
```

with

```ts
      runner.onCommand(3, P[0], 'sub', '76561199222222222 x');
      await flush();
      expect(cmds()).toEqual(['say [Booking] That side is full.', 'sm_booking_allow_refuse 76561199222222222']);
      // A watcher does not count against the players: !allow still lets them in.
      sent = [];
      runner.onCommand(3, P[0], 'allow', '76561199222222222 x');
      await flush();
      expect(cmds().at(-1)).toBe('say [Booking] x can watch (allowed by p0).');
```

Add after `it('a non-captain cannot !allow anyone, ...')`:

```ts
    it('a non-captain cannot !sub anyone either, and the box takes back what its plugin let in', async () => {
      await running();
      const log = vi.spyOn(console, 'log').mockImplementation(() => {});
      runner.onCommand(3, P[5], 'sub', '76561199222222222 x');
      await flush();
      log.mockRestore();
      expect(cmds()).toEqual(['say [Booking] Only a captain or co-captain of that side can do that.', 'sm_booking_allow_refuse 76561199222222222']);
    });
```

- [ ] **Step 3: Run them to see them fail**

Run: `npx vitest run tests/bookings.test.ts tests/logParse.test.ts tests/bookingRunner.test.ts -t "box \\(plan 4b2\\)|subInGame|watchers|PUGBOOK|allowlist"`
Expected: FAIL.

- [ ] **Step 4: Implement the domain**

In `src/bookings/bookings.ts`, in `BOOKING_ERRORS` after `invited_elsewhere`, add:

```ts
  plays_other_side: { status: 409, text: 'They already play for the other side.' },
```

Replace `allowInGame` (doc comment included) with:

```ts
/** A captain's in-game `!allow` (plan 4b2; scrims in game Ruling 9): the
 *  person connecting may WATCH: they join the captain's side as an accepted
 *  spectator, not counted against its players (watchers are capped apart, at
 *  PEOPLE_PER_SIDE). Holding an open invite to a side this captain runs, the
 *  invite is accepted with its role kept. Already accepted is `added: false`.
 *  Only a manager of a confirmed side of an open booking that is ready or
 *  active, and only through the runner's signed PUGBOOK line. It touches
 *  nothing but `players` (a row inserted if absent, status invited, never an
 *  admin) and `booking_people`. The name comes from the game and is
 *  untrusted (gameName). */
export function allowInGame(db: DB, o: { bookingId: number; by: string; steamid: unknown; name: unknown; now?: Date }): Result<{ side: Side; added: boolean; role: PersonRole }> {
  const now = o.now ?? new Date();
  if (typeof o.steamid !== 'string' || !/^\d{17}$/.test(o.steamid)) return fail('not_player');
  const steamid = o.steamid;
  const name = gameName(steamid, o.name);
  return db.transaction((): Result<{ side: Side; added: boolean; role: PersonRole }> => {
    const b = getBooking(db, o.bookingId);
    if (!b) return fail('not_found');
    if (!isOpen(b) || (b.state !== 'ready' && b.state !== 'active')) return fail('wrong_state');
    const side = actingSides(db, b.id, o.by)[0];
    if (!side) return fail('not_manager');
    if (barredFromBox(db, steamid, now)) return fail('not_player');
    const row = db.prepare('SELECT * FROM booking_people WHERE booking_id = ? AND steamid = ?').get(b.id, steamid) as PersonRow | undefined;
    if (row?.status === 'accepted') return ok({ side, added: false, role: row.role });
    if (row) {
      // An open invite: a captain of that side letting them in accepts it
      // for them (role kept); the other side's invite is theirs to answer.
      if (!actingSides(db, b.id, o.by).includes(row.side)) return fail('invited_elsewhere');
      db.prepare("UPDATE booking_people SET status = 'accepted' WHERE booking_id = ? AND steamid = ?").run(b.id, steamid);
      logEvent(db, b.id, o.by, 'person_allowed_in_game', { steamid, side: row.side, accepted: true }, now);
      return ok({ side: row.side, added: true, role: row.role });
    }
    const watchers = (db.prepare("SELECT COUNT(*) AS n FROM booking_people WHERE booking_id = ? AND side = ? AND role = 'spectator'").get(b.id, side) as { n: number }).n;
    if (watchers >= PEOPLE_PER_SIDE) return fail('side_full');
    db.prepare("INSERT OR IGNORE INTO players (steamid, name, status) VALUES (?, ?, 'invited')").run(steamid, name);
    insertPerson(db, b.id, side, steamid, 'spectator', 'accepted', o.by, now);
    logEvent(db, b.id, o.by, 'person_allowed_in_game', { steamid, side }, now);
    return ok({ side, added: true, role: 'spectator' });
  })();
}

/** A captain's in-game `!sub` (scrims in game Ruling 10): the person plays
 *  for the captain's side, as a ringer. A watcher of either side becomes a
 *  ringer of this side; an invite to this side is accepted (role kept);
 *  someone who plays for, or is invited to play for, the other side is
 *  refused. Players and ringers per side stay within PEOPLE_PER_SIDE. Same
 *  gates and untrusted name as allowInGame. */
export function subInGame(db: DB, o: { bookingId: number; by: string; steamid: unknown; name: unknown; now?: Date }): Result<{ side: Side; change: 'added' | 'upgraded' | 'accepted' | 'already' }> {
  type Out = Result<{ side: Side; change: 'added' | 'upgraded' | 'accepted' | 'already' }>;
  const now = o.now ?? new Date();
  if (typeof o.steamid !== 'string' || !/^\d{17}$/.test(o.steamid)) return fail('not_player');
  const steamid = o.steamid;
  const name = gameName(steamid, o.name);
  return db.transaction((): Out => {
    const b = getBooking(db, o.bookingId);
    if (!b) return fail('not_found');
    if (!isOpen(b) || (b.state !== 'ready' && b.state !== 'active')) return fail('wrong_state');
    const side = actingSides(db, b.id, o.by)[0];
    if (!side) return fail('not_manager');
    if (barredFromBox(db, steamid, now)) return fail('not_player');
    const row = db.prepare('SELECT * FROM booking_people WHERE booking_id = ? AND steamid = ?').get(b.id, steamid) as PersonRow | undefined;
    if (row && row.role !== 'spectator') {
      if (row.side !== side) return fail(row.status === 'invited' ? 'invited_elsewhere' : 'plays_other_side');
      if (row.status === 'accepted') return ok({ side, change: 'already' });
      db.prepare("UPDATE booking_people SET status = 'accepted' WHERE booking_id = ? AND steamid = ?").run(b.id, steamid);
      logEvent(db, b.id, o.by, 'person_subbed_in_game', { steamid, side, change: 'accepted' }, now);
      return ok({ side, change: 'accepted' });
    }
    const playing = (db.prepare("SELECT COUNT(*) AS n FROM booking_people WHERE booking_id = ? AND side = ? AND role <> 'spectator'").get(b.id, side) as { n: number }).n;
    if (playing >= PEOPLE_PER_SIDE) return fail('side_full');
    if (row) {
      db.prepare("UPDATE booking_people SET side = ?, role = 'ringer', status = 'accepted' WHERE booking_id = ? AND steamid = ?").run(side, b.id, steamid);
      logEvent(db, b.id, o.by, 'person_subbed_in_game', { steamid, side, change: 'upgraded', from: row.side }, now);
      return ok({ side, change: 'upgraded' });
    }
    db.prepare("INSERT OR IGNORE INTO players (steamid, name, status) VALUES (?, ?, 'invited')").run(steamid, name);
    insertPerson(db, b.id, side, steamid, 'ringer', 'accepted', o.by, now);
    logEvent(db, b.id, o.by, 'person_subbed_in_game', { steamid, side, change: 'added' }, now);
    return ok({ side, change: 'added' });
  })();
}
```

In `src/logParse.ts:33` replace the array with `['nextmap', 'stay', 'end', 'extend', 'addcampaign', 'allow', 'sub'] as const`.

- [ ] **Step 5: Implement the runner**

In `src/bookings/runner.ts`: add `import { getPlayer } from '../players.js';`, add `subInGame` to the bookings import. Above `allowTarget` add:

```ts
/** The in-game commands that let someone onto the box (plan 4b2, scrims in
 *  game): the plugin adds the person before the site hears of it, so a
 *  refusal must take them back (refuseAllow), and their log lines carry no
 *  steamid. */
const LETS_IN: ReadonlySet<BookingCmd> = new Set<BookingCmd>(['allow', 'sub']);
```

In `onCommand` replace:
- `const who = cmd === 'allow' ? 'the sender' : steamid;` with `const who = LETS_IN.has(cmd) ? 'the sender' : steamid;`
- `${cmd === 'allow' ? 'no steamid logged' : \`steamid ${steamid}\`}` with `${LETS_IN.has(cmd) ? 'no steamid logged' : \`steamid ${steamid}\`}`
- `if (cmd === 'allow' && hold?.kind === 'booking')` with `if (LETS_IN.has(cmd) && hold?.kind === 'booking')`
- `if (cmd === 'allow') this.refuseAllow(b.id, serverId, arg, BOOKING_ERRORS.not_manager.text);` with `if (LETS_IN.has(cmd)) this.refuseAllow(b.id, serverId, arg, BOOKING_ERRORS.not_manager.text);`
- the tournament block with:

```ts
    if (b.purpose === 'tournament' && cmd !== 'allow') {
      // T3b Ruling 10: the series engine picks the campaigns and closes the box.
      // A !sub there is pug-tourney's; l4d_booking 1.5.0 never sends one, but
      // whatever an older plugin let in is taken back.
      if (cmd === 'sub') this.refuseAllow(b.id, serverId, arg, 'The site runs this tournament match.');
      this.say(b.id, 'say [Match] The site runs this tournament match: it picks the campaigns and closes the server.', 'the tournament refusal');
      return;
    }
```

and add to the `switch`:

```ts
      case 'sub': {
        error = this.subFromGame(b.id, serverId, steamid, arg);
        break;
      }
```

Replace the tail of `allowFromGame`, from `const b = getBooking(this.db, id);` to the end of the method, with:

```ts
    const b = getBooking(this.db, id);
    const server = getServer(this.db, serverId);
    const side = sidesOf(this.db, id).find((s) => s.side === r.value.side);
    if (!b || !server || !side) return null;
    const who = consoleText(gameName(steamid, m?.[2]), 40);
    const captain = consoleText(getPlayer(this.db, by)?.name ?? 'a captain', 40);
    const said = !r.value.added
      ? `say [Booking] ${who} is already in this booking.`
      : r.value.role === 'spectator'
        ? `say [Booking] ${who} can watch (allowed by ${captain}).`
        : `say [Booking] ${who} is in, as a ${r.value.role} for ${consoleText(sideName(this.db, side), 60)} (allowed by ${captain}).`;
    console.log(`[booking] ${id}: !allow ${r.value.added ? 'added' : 'already in'}; the list has ${allowList(this.db, id).length} ids`);
    void this.push(id, server, () => [...allowLines(this.db, b), ...bookRosterLines(this.db, b), said], 'the allowlist');
    return null;
  }

  /** `!sub` (scrims in game Ruling 10): `arg` is `<steamid64> <name...>`
   *  from the plugin. On success the allowlist and the booking roster go to
   *  the box at once, so pug-match places the sub on the captain's side; a
   *  refusal is said and taken back on the box (refuseAllow). Always null. */
  private subFromGame(id: number, serverId: number, by: string, arg: string): string | null {
    const m = /^(\S+)\s*([\s\S]*)$/.exec(arg.trim());
    const steamid = m?.[1] ?? '';
    const r = subInGame(this.db, { bookingId: id, by, steamid, name: m?.[2] ?? '', now: new Date(this.now()) });
    if (!r.ok) {
      console.log(`[booking] ${id}: !sub refused (${r.error})`);
      this.refuseAllow(id, serverId, arg, BOOKING_ERRORS[r.error].text);
      return null;
    }
    const b = getBooking(this.db, id);
    const server = getServer(this.db, serverId);
    const side = sidesOf(this.db, id).find((s) => s.side === r.value.side);
    if (!b || !server || !side) return null;
    const who = consoleText(gameName(steamid, m?.[2]), 40);
    const captain = consoleText(getPlayer(this.db, by)?.name ?? 'a captain', 40);
    const sideText = consoleText(sideName(this.db, side), 60);
    const said = r.value.change === 'already'
      ? `say [Booking] ${who} already plays for ${sideText}.`
      : `say [Booking] ${who} is in as a sub for ${sideText} (by ${captain}).`;
    console.log(`[booking] ${id}: !sub ${r.value.change}`);
    void this.push(id, server, () => [...allowLines(this.db, b), ...bookRosterLines(this.db, b), said], 'the allowlist');
    return null;
  }
```

Update the `onCommand` doc comment's "allowFromGame's who-is-in line" to "allowFromGame's or subFromGame's who-is-in line".

- [ ] **Step 6: Run the suites**

Run: `npx vitest run tests/bookings.test.ts tests/logParse.test.ts tests/bookingRunner.test.ts tests/bookingCommandServerId.test.ts`
Expected: PASS. The `'!allow log lines name the booking and the outcome, never a steamid'` test keeps passing (the new log lines carry no id).

- [ ] **Step 7: Commit**

```bash
git add src/bookings/bookings.ts src/bookings/runner.ts src/logParse.ts tests/bookings.test.ts tests/bookingRunner.test.ts tests/logParse.test.ts
git commit -m "In game, !allow lets someone watch and the new !sub adds a ringer to the captain's side."
```

---

### Task 8: Start now, the booking rules

**Files:**
- Modify: `src/db.ts` (after line 2609)
- Modify: `src/bookings/bookings.ts` (`SideRow`, `BOOKING_ERRORS`, new `pressStartNow`, `withdrawStartNow`, `startBookingNow`, `startNowOpen`; `BookingSideView`, `BookingView`, `bookingView`)
- Test: `tests/bookings.test.ts`

**Interfaces:**
- Produces:
  - `booking_sides.start_now_at TEXT` (null), `SideRow.start_now_at: string | null`.
  - `export function pressStartNow(db, o: { bookingId: number; by: string; now?: Date }): Result<{ both: boolean; side: Side }>`
  - `export function withdrawStartNow(db, o: { bookingId: number; by: string; now?: Date }): Result<null>`
  - `export function startBookingNow(db, o: { bookingId: number; now?: Date }): Result<{ startsAt: string; endsAt: string; minutes: number }>`
  - `BOOKING_ERRORS.no_box_now` = `{ status: 409, text: 'No server is free right now. Try again in a minute.' }`
  - `BookingSideView.startNow: boolean`, `BookingView.canStartNow: boolean`.

- [ ] **Step 1: Write the failing tests**

In `tests/bookings.test.ts` add `pressStartNow, startBookingNow, withdrawStartNow, sidesOf` to the bookings import (`sidesOf` if not already there) and add a top-level describe:

```ts
describe('start now (scrims in game Ruling 7)', () => {
  const confirmed = () => { const id = create(); confirmBooking(db, { bookingId: id, by: P[1], now: NOW }); return id; };

  it('one press waits for the other side; the second lets the slot move up to now, its length kept, both presses cleared', () => {
    const id = confirmed();
    const before = getBooking(db, id)!;
    const len = Date.parse(before.ends_at) - Date.parse(before.starts_at);
    expect(pressStartNow(db, { bookingId: id, by: P[0], now: NOW })).toEqual({ ok: true, value: { both: false, side: 'a' } });
    const view = bookingView(db, id, { steamid: P[0], staff: false })!;
    expect(view.sides.map((s) => s.startNow)).toEqual([true, false]);
    expect(view.canStartNow).toBe(true);
    expect(startBookingNow(db, { bookingId: id, now: NOW })).toEqual({ ok: false, error: 'wrong_state' });
    expect(pressStartNow(db, { bookingId: id, by: P[1], now: NOW })).toEqual({ ok: true, value: { both: true, side: 'b' } });
    const r = startBookingNow(db, { bookingId: id, now: NOW });
    expect(r.ok).toBe(true);
    const after = getBooking(db, id)!;
    expect(after.starts_at).toBe(NOW.toISOString());
    expect(Date.parse(after.ends_at) - Date.parse(after.starts_at)).toBe(len);
    expect(after.warned_minutes).toBeNull();
    expect(after.reminded_15_at).not.toBeNull();
    expect(after.reminded_60_at).not.toBeNull();
    expect(sidesOf(db, id).map((s) => s.start_now_at)).toEqual([null, null]);
    expect(db.prepare("SELECT COUNT(*) AS n FROM booking_events WHERE booking_id = ? AND event = 'started_early'").get(id)).toEqual({ n: 1 });
    expect(bookingView(db, id, { steamid: P[0], staff: false })!.canStartNow).toBe(false);
  });

  it('a press can be taken back', () => {
    const id = confirmed();
    pressStartNow(db, { bookingId: id, by: P[0], now: NOW });
    expect(withdrawStartNow(db, { bookingId: id, by: P[0], now: NOW })).toEqual({ ok: true, value: null });
    expect(sidesOf(db, id).map((s) => s.start_now_at)).toEqual([null, null]);
    expect(pressStartNow(db, { bookingId: id, by: P[1], now: NOW })).toEqual({ ok: true, value: { both: false, side: 'b' } });
  });

  it('refuses a non-manager, an unconfirmed side, a started, ending or tournament booking', () => {
    const plain = create();
    expect(pressStartNow(db, { bookingId: plain, by: P[0], now: NOW })).toEqual({ ok: false, error: 'wrong_state' });
    const id = confirmed();
    expect(pressStartNow(db, { bookingId: id, by: P[5], now: NOW })).toEqual({ ok: false, error: 'not_manager' });
    db.prepare("UPDATE bookings SET purpose = 'tournament' WHERE id = ?").run(id);
    expect(pressStartNow(db, { bookingId: id, by: P[0], now: NOW })).toEqual({ ok: false, error: 'wrong_state' });
    db.prepare("UPDATE bookings SET purpose = 'scrim', starts_at = ? WHERE id = ?").run(new Date(NOW.getTime() - MIN).toISOString(), id);
    expect(pressStartNow(db, { bookingId: id, by: P[0], now: NOW })).toEqual({ ok: false, error: 'wrong_state' });
    const other = confirmed();
    cancelBooking(db, { bookingId: other, by: P[0], now: NOW });
    expect(pressStartNow(db, { bookingId: other, by: P[0], now: NOW })).toEqual({ ok: false, error: 'wrong_state' });
  });

  it('refuses when the earlier slot has no room, keeping the slot', () => {
    const id = confirmed();
    pressStartNow(db, { bookingId: id, by: P[0], now: NOW });
    pressStartNow(db, { bookingId: id, by: P[1], now: NOW });
    setSetting(db, 'pug_reserve_servers', '10');
    const before = getBooking(db, id)!.starts_at;
    expect(startBookingNow(db, { bookingId: id, now: NOW })).toEqual({ ok: false, error: 'no_capacity' });
    expect(getBooking(db, id)!.starts_at).toBe(before);
  });
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `npx vitest run tests/bookings.test.ts -t "start now"`
Expected: FAIL (functions missing).

- [ ] **Step 3: Implement**

In `src/db.ts`, after `ensureColumn(db, 'booking_sides', 'logo_key', 'TEXT');` add:

```ts
  // Scrims in game (2026-10-11): when this side's manager pressed Start now; null when not pressed.
  ensureColumn(db, 'booking_sides', 'start_now_at', 'TEXT');
```

In `src/bookings/bookings.ts`:
- `SideRow`: after `tag: string | null; logo_key: string | null;` add `/** Start now (scrims in game Ruling 7): when this side pressed it; null when not. */ start_now_at: string | null;`
- `BOOKING_ERRORS`: after `no_campaign_room` add `no_box_now: { status: 409, text: 'No server is free right now. Try again in a minute.' },`
- After `endBooking` add:

```ts
// ---------- start now (scrims in game Ruling 7) ----------

/** Whether a booking may still start early: a scrim, not ending, not yet
 *  started (starts_at ahead), in a state before any game. */
function startNowOpen(b: BookingRow, nowMs: number): boolean {
  return b.purpose === 'scrim' && b.ending_at === null && ['scheduled', 'held', 'setup', 'ready'].includes(b.state) && Date.parse(b.starts_at) > nowMs;
}

/** A manager of a confirmed side presses Start now. `both` once the other
 *  side has pressed too; the runner then moves the slot (startBookingNow). */
export function pressStartNow(db: DB, o: { bookingId: number; by: string; now?: Date }): Result<{ both: boolean; side: Side }> {
  const now = o.now ?? new Date();
  return db.transaction((): Result<{ both: boolean; side: Side }> => {
    const b = getBooking(db, o.bookingId);
    if (!b) return fail('not_found');
    if (!startNowOpen(b, now.getTime()) || sidesOf(db, b.id).some((s) => s.confirmed_at === null)) return fail('wrong_state');
    const side = actingSides(db, b.id, o.by)[0];
    if (!side) return fail('not_manager');
    db.prepare('UPDATE booking_sides SET start_now_at = COALESCE(start_now_at, ?) WHERE booking_id = ? AND side = ?').run(now.toISOString(), b.id, side);
    logEvent(db, b.id, o.by, 'start_now_pressed', { side }, now);
    const other = sideRow(db, b.id, side === 'a' ? 'b' : 'a')!;
    return ok({ both: other.start_now_at !== null, side });
  })();
}

/** The manager takes their side's press back (or the runner does, when the
 *  start it would complete is refused). */
export function withdrawStartNow(db: DB, o: { bookingId: number; by: string; now?: Date }): Result<null> {
  const now = o.now ?? new Date();
  return db.transaction((): Result<null> => {
    const b = getBooking(db, o.bookingId);
    if (!b) return fail('not_found');
    const side = actingSides(db, b.id, o.by)[0];
    if (!side) return fail('not_manager');
    if (db.prepare('UPDATE booking_sides SET start_now_at = NULL WHERE booking_id = ? AND side = ? AND start_now_at IS NOT NULL').run(b.id, side).changes > 0) {
      logEvent(db, b.id, o.by, 'start_now_withdrawn', { side }, now);
    }
    return ok(null);
  })();
}

/** Both sides pressed: the slot moves up to now with its length kept, the
 *  same capacity check as a new booking for the earlier window, both
 *  presses cleared, the reminders marked sent (the start is now) and the
 *  slot warnings re-armed. The runner checks a box can be held first. */
export function startBookingNow(db: DB, o: { bookingId: number; now?: Date }): Result<{ startsAt: string; endsAt: string; minutes: number }> {
  const now = o.now ?? new Date();
  return db.transaction((): Result<{ startsAt: string; endsAt: string; minutes: number }> => {
    const b = getBooking(db, o.bookingId);
    if (!b) return fail('not_found');
    const nowMs = now.getTime();
    if (!startNowOpen(b, nowMs) || sidesOf(db, b.id).some((s) => s.start_now_at === null)) return fail('wrong_state');
    const shift = Date.parse(b.starts_at) - nowMs;
    const endMs = Date.parse(b.ends_at) - shift;
    if (capacityProblem(db, { region: b.region, startMs: nowMs, endMs, exceptId: b.id, purpose: b.purpose }) !== null) return fail('no_capacity');
    const startsAt = iso(nowMs);
    const endsAt = iso(endMs);
    db.prepare(
      `UPDATE bookings SET starts_at = ?, ends_at = ?, warned_minutes = NULL,
         reminded_60_at = COALESCE(reminded_60_at, ?), reminded_15_at = COALESCE(reminded_15_at, ?) WHERE id = ?`,
    ).run(startsAt, endsAt, now.toISOString(), now.toISOString(), b.id);
    db.prepare('UPDATE booking_sides SET start_now_at = NULL WHERE booking_id = ?').run(b.id);
    const minutes = Math.round(shift / 60_000);
    logEvent(db, b.id, null, 'started_early', { from: b.starts_at, to: startsAt, minutes }, now);
    return ok({ startsAt, endsAt, minutes });
  })();
}
```

- `BookingSideView`: add `/** Start now: this side pressed it (scrims in game Ruling 7). */ startNow: boolean;`
- `BookingView`: add `/** Start now may be pressed: a scrim, both sides confirmed, before its start, no end started. */ canStartNow: boolean;`
- In `bookingView`, in the side object after `short: shortSide(b, s),` add `startNow: s.start_now_at !== null,`; in the returned object after `noShowFrom: ...,` add:

```ts
    canStartNow: startNowOpen(b, nowMs) && sidesOf(db, id).every((s) => s.confirmed_at !== null),
```

- [ ] **Step 4: Run them to see them pass**

Run: `npx vitest run tests/bookings.test.ts tests/bookingGamesSchema.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/db.ts src/bookings/bookings.ts tests/bookings.test.ts
git commit -m "Both captains can press Start now to move a scrim's slot up to now, its length kept."
```

---

### Task 9: Start now takes a box at once, through the API

**Files:**
- Modify: `src/bookings/runner.ts` (new `startNow`)
- Modify: `src/routes/bookings.ts` (two routes)
- Test: `tests/bookingRunner.test.ts`, `tests/bookingRoutes.test.ts`

**Interfaces:**
- Consumes: Task 8's functions and errors.
- Produces: `BookingRunner.startNow(id: number, by: string): Result<{ started: boolean }>`; `POST /api/bookings/:id/start-now` (answers the fresh view, or the refusal with its status) and `POST /api/bookings/:id/start-now/withdraw`.

- [ ] **Step 1: Write the failing tests**

In `tests/bookingRunner.test.ts` add a top-level describe:

```ts
describe('start now (scrims in game Ruling 7)', () => {
  it('both presses move the slot up and take a box at once; it is set up like any booking', async () => {
    const id = book();
    expect(runner.startNow(id, P[0])).toEqual({ ok: true, value: { started: false } });
    expect(getBooking(db, id)!.server_id).toBeNull();
    expect(runner.startNow(id, P[1])).toEqual({ ok: true, value: { started: true } });
    expect(getBooking(db, id)!.starts_at).toBe(new Date(now).toISOString());
    await runner.idle();
    expect(getBooking(db, id)).toMatchObject({ state: 'ready', server_id: 3 });
  });

  it('the second press is refused and not kept when no box can be held right now', () => {
    const id = book();
    db.prepare("UPDATE servers SET status = 'offline'").run();
    runner.startNow(id, P[0]);
    expect(runner.startNow(id, P[1])).toEqual({ ok: false, error: 'no_box_now' });
    expect(sideRow(db, id, 'b')!.start_now_at).toBeNull();
    expect(sideRow(db, id, 'a')!.start_now_at).not.toBeNull();
    expect(getBooking(db, id)!.starts_at).toBe(new Date(START).toISOString());
  });
});
```

In `tests/bookingRoutes.test.ts` add:

```ts
describe('start now (scrims in game Ruling 7)', () => {
  it('a captain presses it and takes it back; the view says who pressed', async () => {
    const id = await create();
    confirmBooking(db, { bookingId: id, by: P[1] });
    const first = await call('POST', `/api/bookings/${id}/start-now`, P[0]);
    expect(first.statusCode).toBe(200);
    expect(first.json().canStartNow).toBe(true);
    expect(first.json().sides.map((s: { startNow: boolean }) => s.startNow)).toEqual([true, false]);
    const back = await call('POST', `/api/bookings/${id}/start-now/withdraw`, P[0]);
    expect(back.statusCode).toBe(200);
    expect(back.json().sides.map((s: { startNow: boolean }) => s.startNow)).toEqual([false, false]);
  });

  it('with no free box the second press answers 409 with the reason', async () => {
    const id = await create();
    confirmBooking(db, { bookingId: id, by: P[1] });
    db.prepare("UPDATE servers SET status = 'offline'").run();
    await call('POST', `/api/bookings/${id}/start-now`, P[0]);
    const r = await call('POST', `/api/bookings/${id}/start-now`, P[1]);
    expect(r.statusCode).toBe(409);
    expect(r.json().error).toBe('No server is free right now. Try again in a minute.');
  });

  it('someone the booking is not shown to gets a 404', async () => {
    const id = await create();
    expect((await call('POST', `/api/bookings/${id}/start-now`, P[2])).statusCode).toBe(404);
  });
});
```

(The successful second press is covered by the runner test: in the route harness the booking runner's rcon throws, and a real allocate would start a setup in the background.)

- [ ] **Step 2: Run them to see them fail**

Run: `npx vitest run tests/bookingRunner.test.ts tests/bookingRoutes.test.ts -t "start now"`
Expected: FAIL.

- [ ] **Step 3: Implement the runner method**

In `src/bookings/runner.ts` add `pressStartNow, startBookingNow, withdrawStartNow, type Result` to the bookings import. After `endFromGame` add:

```ts
  /** Start now (scrims in game Ruling 7): a manager presses it; once both
   *  sides have, the slot moves up to now and allocate takes a box at once.
   *  The completing press is refused, and taken back, when no box could be
   *  held right now (the booking would otherwise wait for one and be closed
   *  as no_server after the grace from its new start) or when the earlier
   *  slot has no room. */
  startNow(id: number, by: string): Result<{ started: boolean }> {
    const nowDate = new Date(this.now());
    const r = pressStartNow(this.db, { bookingId: id, by, now: nowDate });
    if (!r.ok) return r;
    if (!r.value.both) return { ok: true, value: { started: false } };
    const b = getBooking(this.db, id)!;
    if (b.server_id === null && !this.pickBox(b)) {
      withdrawStartNow(this.db, { bookingId: id, by, now: nowDate });
      return { ok: false, error: 'no_box_now' };
    }
    const moved = startBookingNow(this.db, { bookingId: id, now: nowDate });
    if (!moved.ok) {
      withdrawStartNow(this.db, { bookingId: id, by, now: nowDate });
      return moved;
    }
    console.log(`[booking] ${id} starts now, ${moved.value.minutes} minutes early`);
    try {
      this.allocate();
    } catch (err) {
      console.error(`[booking] ${id}: allocate() after Start now failed:`, err instanceof Error ? err.message : err);
    }
    return { ok: true, value: { started: true } };
  }
```

- [ ] **Step 4: Implement the routes**

In `src/routes/bookings.ts`, after `action('end', ...)` add:

```ts
  // Start now (scrims in game Ruling 7): each confirmed side's manager presses
  // it; the runner moves the slot and takes a box once both have.
  app.post('/api/bookings/:id/start-now', async (req, reply) => {
    const v = visible(req, reply);
    if (!v) return;
    if (!runner) return reply.code(503).send(NO_RUNNER);
    const r = runner.startNow(v.id, v.me);
    if (!r.ok) return refuse(reply, r.error);
    return view(v.me, v.id);
  });
  action('start-now/withdraw', (me, id) => B.withdrawStartNow(db, { bookingId: id, by: me }));
```

- [ ] **Step 5: Run the suites**

Run: `npx vitest run tests/bookingRunner.test.ts tests/bookingRoutes.test.ts tests/bookings.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/bookings/runner.ts src/routes/bookings.ts tests/bookingRunner.test.ts tests/bookingRoutes.test.ts
git commit -m "Start now takes a server at once once both captains press it, and refuses when none is free."
```

---

### Task 10: Start now on the booking page

**Files:**
- Modify: `web/src/api.ts` (`BookingSideView`, `BookingView`, `bookingsApi`)
- Modify: `web/src/routes/Booking.tsx`
- Test: `web/src/routes/Booking.test.tsx`

**Interfaces:**
- Consumes: Task 9's routes and view fields.
- Produces: `bookingsApi.startNow(id: number): Promise<BookingView>`, `bookingsApi.withdrawStartNow(id: number): Promise<BookingView>`.

- [ ] **Step 1: Write the failing tests**

In `web/src/routes/Booking.test.tsx` add `startNow: vi.fn(), withdrawStartNow: vi.fn(),` to `mockBookings`. Add inside `describe('Booking page', ...)`:

```tsx
  it('a manager presses Start now before the start, sees the wait, and can take it back', async () => {
    const pre = { state: 'scheduled', connect: null, server: null, canStartNow: true };
    mockBookings.get.mockResolvedValue(VIEW(pre));
    mockBookings.startNow.mockResolvedValue(VIEW({ ...pre, sides: VIEW().sides.map((s) => ({ ...s, startNow: s.side === 'a' })) }));
    mockBookings.withdrawStartNow.mockResolvedValue(VIEW(pre));
    render(<Booking id="7" session={session} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Start now' }));
    await waitFor(() => expect(mockBookings.startNow).toHaveBeenCalledWith(7));
    expect(await screen.findByText('Waiting for the other captain to press Start now.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Take it back' }));
    await waitFor(() => expect(mockBookings.withdrawStartNow).toHaveBeenCalledWith(7));
    expect(await screen.findByRole('button', { name: 'Start now' })).toBeTruthy();
  });

  it('says when the other side pressed Start now', async () => {
    mockBookings.get.mockResolvedValue(VIEW({ state: 'scheduled', connect: null, server: null, canStartNow: true,
      sides: VIEW().sides.map((s) => ({ ...s, startNow: s.side === 'b' })) }));
    render(<Booking id="7" session={session} />);
    expect(await screen.findByText(/Mice pressed Start now/)).toBeTruthy();
  });

  it('no Start now once the booking cannot start early', async () => {
    mockBookings.get.mockResolvedValue(VIEW({ canStartNow: false }));
    render(<Booking id="7" session={session} />);
    expect(await screen.findByText('connect 1.2.3.4:27015; password abcd2345')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Start now' })).toBeNull();
  });

  it('a refused Start now shows the reason', async () => {
    mockBookings.get.mockResolvedValue(VIEW({ state: 'scheduled', connect: null, server: null, canStartNow: true }));
    mockBookings.startNow.mockRejectedValue(new Error('No server is free right now. Try again in a minute.'));
    render(<Booking id="7" session={session} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Start now' }));
    expect(await screen.findByText('No server is free right now. Try again in a minute.')).toBeTruthy();
  });
```

- [ ] **Step 2: Run them to see them fail**

Run: `npx vitest run web/src/routes/Booking.test.tsx`
Expected: FAIL (no button).

- [ ] **Step 3: Implement**

In `web/src/api.ts`:
- `BookingSideView`: add `/** Start now: this side pressed it. */ startNow?: boolean;`
- `BookingView`: add `/** Start now may be pressed (a scrim, both sides confirmed, before its start). */ canStartNow?: boolean;`
- `bookingsApi`: after `stay: ...` add

```ts
  /** Start now (both captains press it; the second press moves the slot up to now). */
  startNow: (id: number) => post<BookingView>(`/api/bookings/${id}/start-now`),
  withdrawStartNow: (id: number) => post<BookingView>(`/api/bookings/${id}/start-now/withdraw`),
```

In `web/src/routes/Booking.tsx`, after `const addCampaign = () => { ... };` add:

```tsx
  // Start now (scrims in game): both captains press it before the start; the
  // slot moves up to now and keeps its length, so it ends early too.
  const mySide = actingSide ? v.sides.find((s) => s.side === actingSide) ?? null : null;
  const theirSide = actingSide ? v.sides.find((s) => s.side !== actingSide) ?? null : null;
  const showStartNow = !!v.canStartNow && playerManage && mySide !== null && theirSide !== null;
```

and in the first `<Panel>`, right after the `{v.connect && (...)}` block, add:

```tsx
        {showStartNow && (
          <p class="inlinerow">
            {mySide!.startNow ? (
              <>
                <span>Waiting for the other captain to press Start now.</span>
                <button class="btn btn--ghost" disabled={busy} onClick={() => act(() => bookingsApi.withdrawStartNow(v.id))}>Take it back</button>
              </>
            ) : (
              <>
                <button class="btn" disabled={busy} onClick={() => act(() => bookingsApi.startNow(v.id))}>Start now</button>
                <span class="muted">
                  {theirSide!.startNow
                    ? `${theirSide!.name} pressed Start now. Press it too and the server is set up right away.`
                    : 'Everyone here early? Both captains press Start now. The slot keeps its length, so it ends early too.'}
                </span>
              </>
            )}
          </p>
        )}
```

- [ ] **Step 4: Run the web tests and typecheck**

Run: `npx vitest run web/src/routes/Booking.test.tsx && npm run typecheck`
Expected: PASS, no type errors.

- [ ] **Step 5: Commit**

```bash
git add web/src/api.ts web/src/routes/Booking.tsx web/src/routes/Booking.test.tsx
git commit -m "The booking page has a Start now button with a wait line and a take-back."
```

---

### Task 11: A moved box gets its forced restart even across a web restart

**Files:**
- Modify: `src/db.ts` (after the last `ensureColumn(db, 'bookings', ...)`)
- Modify: `src/bookings/bookings.ts` (`BookingRow`, `reholdBox`, new `markBoxRestarted`)
- Modify: `src/bookings/runner.ts` (remove `freshBox`; `relocate`; `recoverOnce`)
- Test: `tests/bookingRecovery.test.ts`

**Interfaces:**
- Produces: `bookings.fresh_box INTEGER NOT NULL DEFAULT 0` (1 from `reholdBox` until the restart came back), `BookingRow.fresh_box: number`, `export function markBoxRestarted(db: DB, id: number): void`.

- [ ] **Step 1: Write the failing tests**

In `tests/bookingRecovery.test.ts` add `beginRecovery, dropBox, reholdBox` to the import from `../src/bookings/bookings.js` (whichever are missing). Inside `describe('box gone', ...)` add:

```ts
  it('a web restart between taking the new box and restarting it still restarts it first', async () => {
    const id = await running();
    // The old process got this far (relocate's reholdBox) and died.
    beginRecovery(db, id, 'gone', new Date(now));
    dropBox(db, id, new Date(now));
    expect(reholdBox(db, id, 2, new Date(now))).toBe(true);
    expect(getBooking(db, id)!.fresh_box).toBe(1);
    restarted = [];
    const fresh = build();
    fresh.resume();
    await fresh.idle();
    expect(restarted).toEqual(['bb']);
    expect(getBooking(db, id)).toMatchObject({ server_id: 2, recovering_at: null, fresh_box: 0 });
  });

  it('a restart that does not come back keeps the flag, so the retry restarts again', async () => {
    const id = await running();
    beginRecovery(db, id, 'gone', new Date(now));
    dropBox(db, id, new Date(now));
    reholdBox(db, id, 2, new Date(now));
    let first = true;
    const r = build({ restart: async (server) => { restarted.push(server.name); if (first) { first = false; return false; } box[server.name].type = PUB; box[server.name].map = 'l4d_vs_hospital01_apartment'; box[server.name].marker = ''; return true; } });
    restarted = [];
    r.resume();
    await r.idle();
    expect(restarted).toEqual(['bb', 'bb']);
    expect(getBooking(db, id)!.fresh_box).toBe(0);
  });
```

(`running`, `box`, `PUB`, `restarted` and `build` are the file's own helpers; if `PUB` is not defined there, use the same game type string the file's `build()` restart sets.)

- [ ] **Step 2: Run them to see them fail**

Run: `npx vitest run tests/bookingRecovery.test.ts -t "web restart between taking|keeps the flag"`
Expected: FAIL (`fresh_box` undefined; the first test sees no restart).

- [ ] **Step 3: Implement**

In `src/db.ts`, after the last `ensureColumn(db, 'bookings', ...)` line, add:

```ts
  // A box relocate took for a booking (reholdBox) that has not had its forced
  // restart yet; persisted so a web restart in between cannot skip it (2026-10-11).
  ensureColumn(db, 'bookings', 'fresh_box', 'INTEGER NOT NULL DEFAULT 0');
```

In `src/bookings/bookings.ts`: in `BookingRow`, after `waiting_since: string | null;` add `/** 1 from reholdBox until the new box's forced restart came back (markBoxRestarted). */ fresh_box: number;`. In `reholdBox` change `SET server_id = ?, waiting_since = NULL` to `SET server_id = ?, waiting_since = NULL, fresh_box = 1`. After `reholdBox` add:

```ts
/** The box reholdBox took has had its forced restart: recovery goes on without another. */
export function markBoxRestarted(db: DB, id: number): void {
  db.prepare('UPDATE bookings SET fresh_box = 0 WHERE id = ?').run(id);
}
```

In `src/bookings/runner.ts`: add `markBoxRestarted` to the bookings import; delete the `freshBox` field and its doc comment; in `relocate` delete the line `this.freshBox.add(b.id);`; in `recoverOnce` replace

```ts
    // A box just taken by a move gets the forced restart setup gives a fresh box.
    if (this.freshBox.delete(b.id) && !(await this.deps.restart(server))) throw new Error('the new box did not come back from its restart');
```

with

```ts
    // A box just taken by a move gets the forced restart setup gives a fresh
    // box. The flag is a column (reholdBox sets it), so a web restart in
    // between cannot lose it, and it clears only once the restart came back,
    // so a retry after a failed restart restarts again.
    if (b.fresh_box === 1) {
      if (!(await this.deps.restart(server))) throw new Error('the new box did not come back from its restart');
      markBoxRestarted(this.db, b.id);
    }
```

Update the `relocate` comment if it mentions `freshBox`, and `grep -n freshBox src tests` must print nothing.

- [ ] **Step 4: Run the recovery and runner suites**

Run: `npx vitest run tests/bookingRecovery.test.ts tests/bookingRunner.test.ts tests/series.test.ts`
Expected: PASS (the existing move tests still see `restarted` contain the new box).

- [ ] **Step 5: Commit**

```bash
git add src/db.ts src/bookings/bookings.ts src/bookings/runner.ts tests/bookingRecovery.test.ts
git commit -m "A booking's moved box keeps its pending forced restart in the database, so a web restart cannot skip it."
```

---

### Task 12: pug-match 0.3.33 places each booking side on its own team

**Files:**
- Create: `plugin/pug-booking.inc`
- Modify: `plugin/pug-match.sp` (version line 30; `OnPluginStart` after `Tourney_Init();`; `OnClientPostAdminCheck` after its `IsFakeClient` return; `OnClientDisconnect` after `Tourney_OnDisconnect(client);`; `TeamLockActive`; `Timer_TeamLock` top; the include list after `pug-tourney.inc`)
- Modify: `plugin/build.sh` (copy and clean up `pug-booking.inc`)
- Modify: `plugin/TESTING.md` (a section)

**Interfaces:**
- Consumes: the site's `sm_pug_book_begin`, `sm_pug_book_add <a|b|s> <id64...>`, `sm_pug_book_commit <a|b>`, `sm_pug_book_clear` (Tasks 3 and 6).
- Produces: `bool Book_Active()`, `void Book_Pass()`, `Book_Init()`, `Book_OnClientPostAdminCheck(int)`, `Book_OnDisconnect(int)`; server command `sm_pug_book_status [steamid64]` answering `PUGOK book loaded=%d ids=%d staged=%d first=%s firstmap=%d active=%d teamlock=%d role=%d`.

- [ ] **Step 1: Write the include**

Create `plugin/pug-booking.inc`:

```sourcepawn
// ---------- booked scrims: each booking side on its own team (site plan 2026-10-11-scrims-ingame) ----------
//
// A booked scrim's games are adopted by auto-track (sm_pug_auto_track 1), and
// an auto-tracked match has no authoritative roster, so TeamLockActive stood
// the lock down for it and nobody was ever placed (first live scrim,
// 2026-10-11). The site now pushes the booking's people with every game burst
// and its minute re-push:
//
//   sm_pug_book_begin
//   sm_pug_book_add <a|b|s> <steamid64> [steamid64...]   (s: may only watch)
//   sm_pug_book_commit <a|b>                              (survives first on this campaign's first map)
//
// staged and swapped in whole on commit, as l4d_booking's allowlist is. With a
// committed list:
//  - before a game is tracked (MS_None), on a campaign's first map in its
//    first half, each side is placed: the commit's side on survivors, the
//    other on infected. Someone on the other side's team goes to spectator
//    first (which frees the slot that side's player needs) and is placed from
//    there on the next pass;
//  - during a tracked game TeamLockActive holds for the auto-tracked match
//    (its go-live snapshot is the placement above), a rostered player is
//    Timer_TeamLock's, and a booking player not on the match roster (a sub)
//    goes to their side's team when it has room (RosterLateJoiners rosters
//    them at the next go-live);
//  - always, someone who may only watch, or who is not on the booking at all
//    (SourceMod admins excepted), is moved off survivor and infected.
// Nobody is pulled out of spectator except once after arriving (each map
// load), after a role change, or after this module moved them: a player who
// sits out stays out. A full team is never over-filled. sm_pug_book_clear
// (the site's CLEAR_LINES) forgets it all, and so does the end restart.

#define BOOK_SIDE_A 1
#define BOOK_SIDE_B 2
#define BOOK_WATCH 3
#define BOOK_CHUNK_MAX 32          // ids one sm_pug_book_add line may carry (the site sends 10)
#define BOOK_PLACE_TRIES 8         // placement attempts after an arrival or a role change, one per lock tick (2 s)
#define BOOK_TELL_GAP 20.0         // seconds between two placement notices to one client

StringMap g_hBook;                 // committed: SteamID64 -> BOOK_SIDE_A | BOOK_SIDE_B | BOOK_WATCH
StringMap g_hBookStaged;           // between begin and commit; null otherwise
bool g_bBookLoaded;
int g_iBookFirst;                  // BOOK_SIDE_A or BOOK_SIDE_B; 0 before the first commit
bool g_bBookPlace[MAXPLAYERS + 1]; // place this client on their side (arrival, role change, a move made here)
int g_iBookTries[MAXPLAYERS + 1];
int g_iBookRole[MAXPLAYERS + 1];   // the role last seen for this client; a change re-arms the placement
float g_fBookToldAt[MAXPLAYERS + 1];

void Book_Init()
{
	g_hBook = new StringMap();
	RegServerCmd("sm_pug_book_begin", Cmd_BookBegin, "sm_pug_book_begin - start staging a booked scrim's people");
	RegServerCmd("sm_pug_book_add", Cmd_BookAdd, "sm_pug_book_add <a|b|s> <steamid64> [steamid64...] - stage people of side a, side b, or watchers");
	RegServerCmd("sm_pug_book_commit", Cmd_BookCommit, "sm_pug_book_commit <a|b> - make the staged people active; that side survives first on this campaign's first map");
	RegServerCmd("sm_pug_book_clear", Cmd_BookClear, "sm_pug_book_clear - forget the booked scrim's people (the booking ended)");
	RegServerCmd("sm_pug_book_status", Cmd_BookStatus, "sm_pug_book_status [steamid64] - counts, the first side, and one id's role");
}

/** A booked scrim's people are loaded: the placement runs and the lock holds for an auto-tracked match. */
bool Book_Active()
{
	return g_bBookLoaded && g_hBook.Size > 0;
}

static bool Book_IsId64(const char[] id)
{
	if (strlen(id) != 17) return false;
	for (int i = 0; i < 17; i++)
	{
		if (id[i] < '0' || id[i] > '9') return false;
	}
	return true;
}

public Action Cmd_BookBegin(int args)
{
	delete g_hBookStaged;
	g_hBookStaged = new StringMap();
	PrintToServer("PUGOK book begin");
	return Plugin_Handled;
}

public Action Cmd_BookAdd(int args)
{
	if (g_hBookStaged == null)
	{
		PrintToServer("PUGERR book add without begin");
		return Plugin_Handled;
	}
	char role[4];
	GetCmdArg(1, role, sizeof(role));
	int code = StrEqual(role, "a") ? BOOK_SIDE_A : StrEqual(role, "b") ? BOOK_SIDE_B : StrEqual(role, "s") ? BOOK_WATCH : 0;
	if (code == 0 || args < 2)
	{
		PrintToServer("PUGERR usage: sm_pug_book_add <a|b|s> <steamid64> [steamid64...]");
		return Plugin_Handled;
	}
	int added = 0, skipped = 0;
	char id[32];
	for (int i = 2; i <= args && i <= BOOK_CHUNK_MAX + 1; i++)
	{
		GetCmdArg(i, id, sizeof(id));
		if (!Book_IsId64(id)) { skipped++; continue; }
		g_hBookStaged.SetValue(id, code);
		added++;
	}
	PrintToServer("PUGOK book add role=%s added=%d skipped=%d", role, added, skipped);
	return Plugin_Handled;
}

public Action Cmd_BookCommit(int args)
{
	char first[4];
	GetCmdArg(1, first, sizeof(first));
	int side = StrEqual(first, "a") ? BOOK_SIDE_A : StrEqual(first, "b") ? BOOK_SIDE_B : 0;
	if (g_hBookStaged == null || side == 0)
	{
		// The staged list (if any) is kept, and the committed one stays in force.
		PrintToServer("PUGERR usage: sm_pug_book_commit <a|b>, after sm_pug_book_begin");
		return Plugin_Handled;
	}
	delete g_hBook;
	g_hBook = g_hBookStaged;
	g_hBookStaged = null;
	g_bBookLoaded = true;
	g_iBookFirst = side;
	// A role that changed (a watcher made a sub, someone added) is placed again.
	for (int c = 1; c <= MaxClients; c++)
	{
		if (!IsClientInGame(c) || IsFakeClient(c)) continue;
		int role = Book_RoleOf(c);
		if (role != g_iBookRole[c])
		{
			g_iBookRole[c] = role;
			g_bBookPlace[c] = true;
			g_iBookTries[c] = 0;
		}
	}
	PrintToServer("PUGOK book commit ids=%d first=%s", g_hBook.Size, first);
	return Plugin_Handled;
}

public Action Cmd_BookClear(int args)
{
	delete g_hBookStaged;
	g_hBook.Clear();
	g_bBookLoaded = false;
	g_iBookFirst = 0;
	for (int c = 0; c <= MaxClients; c++)
	{
		g_bBookPlace[c] = false;
		g_iBookTries[c] = 0;
		g_iBookRole[c] = 0;
		g_fBookToldAt[c] = 0.0;
	}
	PrintToServer("PUGOK book clear");
	return Plugin_Handled;
}

/** Counts, never the ids; with an id, that id's role (0 none, 1 a, 2 b, 3 watch). */
public Action Cmd_BookStatus(int args)
{
	int role = -1;
	if (args >= 1)
	{
		char id[32];
		GetCmdArg(1, id, sizeof(id));
		if (!g_hBook.GetValue(id, role)) role = 0;
	}
	PrintToServer("PUGOK book loaded=%d ids=%d staged=%d first=%s firstmap=%d active=%d teamlock=%d role=%d",
		g_bBookLoaded ? 1 : 0, g_hBook.Size, g_hBookStaged == null ? -1 : g_hBookStaged.Size,
		g_iBookFirst == BOOK_SIDE_A ? "a" : g_iBookFirst == BOOK_SIDE_B ? "b" : "none",
		Book_FirstHalfOfFirstMap() ? 1 : 0, Book_Active() ? 1 : 0, TeamLockActive() ? 1 : 0, role);
	return Plugin_Handled;
}

/** The client's booking role, or 0 (not on the booking, or no SteamID yet). */
int Book_RoleOf(int client)
{
	char id[32];
	if (!GetClientAuthId(client, AuthId_SteamID64, id, sizeof(id))) return 0;
	int role;
	return g_hBook.GetValue(id, role) ? role : 0;
}

/** The first half of a campaign's first map. L4D_IsFirstMapInScenario is
 *  optional in left4dhooks and an unbound native throws, so it is
 *  feature-checked (as the standalone replay does); absent, never. */
bool Book_FirstHalfOfFirstMap()
{
	if (GetFeatureStatus(FeatureType_Native, "L4D_IsFirstMapInScenario") != FeatureStatus_Available) return false;
	if (!L4D_IsFirstMapInScenario()) return false;
	return !view_as<bool>(GameRules_GetProp("m_bInSecondHalfOfRound"));
}

/** The pug team the booking side plays as in the tracked match: the majority
 *  of that side's people on the roster; 0 when none are rostered. */
int Book_PugOfSide(int side)
{
	int n[3];
	int role;
	for (int i = 0; i < g_iRosterCount; i++)
	{
		if (!g_hBook.GetValue(g_sRosterId[i], role) || role != side) continue;
		n[g_iRosterTeam[i]]++;
	}
	return n[1] > n[2] ? 1 : n[2] > n[1] ? 2 : 0;
}

/** The game team a booking side belongs on right now, or 0 when this module
 *  does not know (between games away from a first map, or after the finale). */
int Book_TeamOfSide(int side)
{
	if (g_State == MS_Pending || g_State == MS_Live)
	{
		int pug = Book_PugOfSide(side);
		return pug == 0 ? 0 : g_iPugSide[pug];
	}
	if (g_State == MS_None && Book_FirstHalfOfFirstMap())
		return side == g_iBookFirst ? TEAM_SURVIVOR : TEAM_INFECTED;
	return 0;
}

/** A human slot is open on this team (survivor_limit / z_max_player_zombies; 4 without them). */
bool Book_HasRoom(int team)
{
	ConVar cv = FindConVar(team == TEAM_SURVIVOR ? "survivor_limit" : "z_max_player_zombies");
	int limit = cv != null ? cv.IntValue : 4;
	int n = 0;
	for (int c = 1; c <= MaxClients; c++)
	{
		if (IsClientInGame(c) && !IsFakeClient(c) && GetClientTeam(c) == team) n++;
	}
	return n < limit;
}

void Book_Tell(int client, const char[] text)
{
	float now = GetEngineTime();
	if (now - g_fBookToldAt[client] < BOOK_TELL_GAP) return;
	g_fBookToldAt[client] = now;
	PrintToChat(client, "%s", text);
}

/** Every lock tick (Timer_TeamLock calls it first, in every match state). */
void Book_Pass()
{
	if (!Book_Active()) return;
	bool tracked = g_State == MS_Pending || g_State == MS_Live;
	for (int c = 1; c <= MaxClients; c++)
	{
		if (!IsClientInGame(c) || IsFakeClient(c) || IsClientSourceTV(c)) continue;
		int have = GetClientTeam(c);
		if (have == 0) continue; // still loading in
		// A rostered player of a tracked match is Timer_TeamLock's, watcher or not:
		// the roster is the authority until that game ends.
		if (tracked && g_iClientRoster[c] != -1) { g_bBookPlace[c] = false; continue; }
		int role = Book_RoleOf(c);
		if (role != g_iBookRole[c])
		{
			g_iBookRole[c] = role;
			g_bBookPlace[c] = true;
			g_iBookTries[c] = 0;
		}
		bool onSide = have == TEAM_SURVIVOR || have == TEAM_INFECTED;
		if (role == 0 || role == BOOK_WATCH)
		{
			// Staff (SourceMod admins) play or test as they like.
			if (role == 0 && GetUserAdmin(c) != INVALID_ADMIN_ID) continue;
			if (!onSide) continue;
			ChangeClientTeam(c, TEAM_SPEC);
			if (role == BOOK_WATCH) Book_Tell(c, "[Booking] You can watch this scrim. To play, ask a captain to type !sub with your name.");
			else Book_Tell(c, "[Booking] You are not on this booking. A captain can type !allow with your name to let you watch, or !sub to let you play.");
			continue;
		}
		int want = Book_TeamOfSide(role);
		if (want == 0) continue;
		if (have == want) { g_bBookPlace[c] = false; g_iBookTries[c] = 0; continue; }
		if (onSide)
		{
			ChangeClientTeam(c, TEAM_SPEC);
			g_bBookPlace[c] = true;
			g_iBookTries[c] = 0;
			Book_Tell(c, "[Booking] That is the other side's team. Moving you to your own.");
			continue;
		}
		if (!g_bBookPlace[c]) continue; // sitting out by choice
		if (g_iBookTries[c] >= BOOK_PLACE_TRIES)
		{
			g_bBookPlace[c] = false;
			Book_Tell(c, "[Booking] Your side's team is full, so you stay in spectator. Join it when a slot opens.");
			continue;
		}
		g_iBookTries[c]++;
		if (!Book_HasRoom(want)) continue;
		PugDebug("book: placing %N on %s (try %d)", c, want == TEAM_SURVIVOR ? "survivor" : "infected", g_iBookTries[c]);
		FakeClientCommand(c, want == TEAM_SURVIVOR ? "sm_sur" : "sm_inf");
	}
}

/** Every connect, map changes included: placed once more after arriving. */
void Book_OnClientPostAdminCheck(int client)
{
	g_bBookPlace[client] = true;
	g_iBookTries[client] = 0;
	g_iBookRole[client] = Book_Active() ? Book_RoleOf(client) : 0;
	g_fBookToldAt[client] = 0.0;
}

void Book_OnDisconnect(int client)
{
	g_bBookPlace[client] = false;
	g_iBookTries[client] = 0;
	g_iBookRole[client] = 0;
	g_fBookToldAt[client] = 0.0;
}
```

- [ ] **Step 2: Wire it into pug-match.sp**

- Line 30: `#define PLUGIN_VERSION "0.3.33"`.
- In `OnPluginStart`, after `Tourney_Init();` add `Book_Init();`.
- In `OnClientPostAdminCheck`, right after `if (IsFakeClient(client)) return;` add `Book_OnClientPostAdminCheck(client);`.
- In `OnClientDisconnect`, after `Tourney_OnDisconnect(client);` add `Book_OnDisconnect(client);`.
- In `TeamLockActive`, replace

```sourcepawn
	// Auto-track implies no team lock only for the matches auto-track itself
	// starts, which have no authority: their "roster" is just whoever happened
	// to be on each side. A backend-issued roster is authoritative and must be
	// enforced even while auto_track is on, which it always is on the live box.
	if (g_cvAutoTrack.BoolValue && g_bSelfStarted) return false;
```

with

```sourcepawn
	// Auto-track implies no team lock only for the matches auto-track itself
	// starts, which have no authority: their "roster" is just whoever happened
	// to be on each side. A backend-issued roster is authoritative and must be
	// enforced even while auto_track is on, which it always is on the live box.
	// So is an auto-tracked game on a booked scrim's box (pug-booking.inc):
	// the booking placed each side before go-live, so the snapshot is right.
	if (g_cvAutoTrack.BoolValue && g_bSelfStarted && !Book_Active()) return false;
```

- In `Timer_TeamLock`, make the first statement (before `if (g_State == MS_None || g_State == MS_Ended) return Plugin_Continue;`):

```sourcepawn
	// A booked scrim's placement (pug-booking.inc) runs in every state,
	// before a game is tracked too.
	Book_Pass();
```

- After `#include "pug-tourney.inc"` add:

```sourcepawn
// Booked scrims: each booking side on its own team (reads the roster and g_iPugSide).
#include "pug-booking.inc"
```

- [ ] **Step 3: Add the include to the build**

In `plugin/build.sh`, after `cp pug-tourney.inc "$SCRIPTING/pug-tourney.inc"` add `cp pug-booking.inc "$SCRIPTING/pug-booking.inc"`, and in the `CLEANUP=` line add ` $SCRIPTING/pug-booking.inc` after ` $SCRIPTING/pug-tourney.inc`.

- [ ] **Step 4: Compile**

Run: `cd /home/volence/l4d/pug/.claude/worktrees/scrim-ingame/plugin && ./build.sh 2>&1 | tail -20`
Expected: `built: .../plugin/pug-match.smx`, no errors (warnings that existed before are fine; any new warning in pug-booking.inc is fixed before going on).

- [ ] **Step 5: Local check on 27055**

Only with `R status` showing 0 humans (see Global Constraints and Task 2 Step 1 for `R`).

```bash
export RPORT=27055
R() { python3 /home/volence/l4d/nightmode/rcon.py "$@"; }
R status | grep -E '^(players|map)'
SM=/home/volence/l4d1-ds/server/left4dead/addons/sourcemod/plugins
cp plugin/pug-match.smx "$SM/disabled/pug-match-scrim.smx"
R 'sm plugins load_unlock' 'sm plugins unload pug-match' 'sm plugins load disabled/pug-match-scrim' 'sm plugins load_lock'
R 'sm plugins list' | grep -i 'PUG Match'                 # 0.3.33
R 'sm_pug_book_status'                                    # loaded=0 ids=0 staged=-1 first=none active=0 role=-1
R 'sm_pug_book_begin' 'sm_pug_book_add a 76561199000000001 76561199000000002' 'sm_pug_book_add b 76561199000000003 123' \
  'sm_pug_book_add s 76561199000000004' 'sm_pug_book_add x 76561199000000005' 'sm_pug_book_commit b'
#   PUGOK book begin / added=2 skipped=0 / role=b added=1 skipped=1 / role=s added=1 / PUGERR usage / PUGOK book commit ids=4 first=b
R 'sm_pug_book_status 76561199000000004'                  # loaded=1 ids=4 first=b firstmap=1 (on a first map) active=1 role=3
R 'sm_pug_book_begin' 'sm_pug_book_commit q' 'sm_pug_book_status'   # PUGERR usage; still ids=4 first=b
R 'sm_pug_book_clear' 'sm_pug_book_status'                # loaded=0 ids=0 active=0
R 'sm_pug_status' | head -3                               # the plugin still answers normally
```

Also add a bot or two (`sb_add` under cheats) with a list committed and confirm with `R status` over 10 s that bots are never moved. Restore:

```bash
R 'sm_pug_book_clear' 'sm plugins load_unlock' 'sm plugins unload pug-match-scrim' 'sm plugins load pug-match' 'sm plugins load_lock'
rm "$SM/disabled/pug-match-scrim.smx"
R 'sm plugins list' | grep -i 'PUG Match'                 # back to 0.3.32
```

- [ ] **Step 6: Record the checklist**

Append to `plugin/TESTING.md` a section `## Booked scrim placement (pug-match 0.3.33)` holding: the commands of Step 5 with what each printed (ticked with today's date), and an unticked owner list for a live booked scrim (placement needs real SteamID64s, which `sv_lan 1` does not give):
1. Two sides join a booked box on campaign 1: the non-picker side (side b under Casual Scrim) ends up on survivors within a few seconds, side a on infected; nobody is dragged out of spectator after they chose it.
2. A player who joins the other side's team is moved back with "That is the other side's team".
3. A `!allow`ed watcher who joins a team goes back to spectator with the "ask a captain to type !sub" line; after `!sub` they land on their side's team when it has a slot.
4. Rotoblin's own team handling at a campaign load (`l4d_team_unscramble`, `l4d2_spec_stays_spec`) does not fight the placement for more than a few seconds.
5. Campaign 2 starts with side a on survivors; `matches.booking_side_a` of game 2 is `a` (game 1 `b`).

- [ ] **Step 7: Commit**

```bash
git add plugin/pug-booking.inc plugin/pug-match.sp plugin/build.sh plugin/TESTING.md plugin/pug-match.smx
git commit -m "pug-match 0.3.33 places each booked scrim side on its own team and keeps the lock on for its games."
```

(Commit the `.smx` only if `git ls-files plugin/pug-match.smx` shows it is tracked; otherwise leave it out of `git add`.)

---

### Task 13: l4d_booking 1.5.0: `!time`, countdowns, the re-tell and `!sub`

**Files:**
- Modify: `plugin/l4d_booking.sp`
- Modify: `plugin/TESTING.md`

**Interfaces:**
- Consumes: `l4d_booking_title`, `_campaign`, `_ends`, `_next_at`, `_next_name`, `_close_at` (Task 3); the site's `cmd=sub` handling (Task 7).
- Produces: chat `!time` (anyone, booked scrim box), captain `!sub <name>` emitting `PUGBOOK event=cmd cmd=sub steamid=<captain> arg=<id64> <name>`; server commands `sm_booking_tell` and `sm_booking_time` (print to the server console, for testing).

- [ ] **Step 1: Header and version**

Change `#define PLUGIN_VERSION "1.4.0"` to `"1.5.0"`. Before ` * Build: ./build-booking.sh` add:

```
 * 1.4.0 adds l4d_booking_id, the boot marker the site's crash recovery reads.
 *
 * 1.5.0 (site plan 2026-10-11, scrims in game): the site pushes the booking's
 * clock as cvars (l4d_booking_title, _campaign, _ends, _next_at, _next_name,
 * _close_at; epochs in seconds, 0 for none), and from them this plugin:
 * answers !time for anyone; counts down to the next campaign and to the close
 * after the last one, in the center of the screen each second of the last
 * minute and in chat at 60, 30 and 10 seconds; and re-tells each player the
 * booking's state once they are in game (5 s after the admin check, once on a
 * team), after every map load, since lines said during a load are never seen.
 * A captain's !sub <name> lets someone play for their side (cmd=sub, the
 * site adds a ringer); !allow now lets someone watch. On a tournament box
 * !sub belongs to pug-match's pug-tourney.inc and is left alone here. The
 * epoch cvars are read as strings: a ConVar keeps its number as a float,
 * which is up to 64 s off at today's epochs.
```

- [ ] **Step 2: Cvars, globals, start**

After `ConVar g_cvBlock;` add:

```sourcepawn
ConVar g_cvTitle;
ConVar g_cvCampaign;
ConVar g_cvEnds;
ConVar g_cvNextAt;
ConVar g_cvNextName;
ConVar g_cvCloseAt;

/** No countdown mark said yet for the current next_at / close_at. */
#define MARK_NONE 1000
/** Seconds after the admin check before a player is told the booking's state. */
#define TELL_DELAY 5.0
/** Chat marks of the countdowns, largest first. */
static const int g_iMarks[] = { 60, 30, 10 };
int g_iNextSaid = MARK_NONE;
int g_iCloseSaid = MARK_NONE;
/** GetEngineTime() from which a client is told the state; 0.0 = nothing pending. */
float g_fTellAt[MAXPLAYERS + 1];
```

In `OnPluginStart`, after the `l4d_booking_id` CreateConVar, add:

```sourcepawn
	// Scrims in game (1.5.0): the booking's clock, pushed by the site with
	// every booking burst. Epochs in whole seconds; 0 (or empty) for none.
	g_cvTitle = CreateConVar("l4d_booking_title", "", "The scrim's sides, \"A vs B\"; empty on a tournament box.", FCVAR_DONTRECORD);
	g_cvCampaign = CreateConVar("l4d_booking_campaign", "", "The name of the campaign on the box.", FCVAR_DONTRECORD);
	g_cvEnds = CreateConVar("l4d_booking_ends", "0", "Epoch seconds the booked slot ends; 0 when unknown.", FCVAR_DONTRECORD);
	g_cvNextAt = CreateConVar("l4d_booking_next_at", "0", "Epoch seconds the next campaign loads; 0 for none.", FCVAR_DONTRECORD);
	g_cvNextName = CreateConVar("l4d_booking_next_name", "", "The next campaign's name.", FCVAR_DONTRECORD);
	g_cvCloseAt = CreateConVar("l4d_booking_close_at", "0", "Epoch seconds the server closes after the last booked campaign; 0 for none.", FCVAR_DONTRECORD);
	g_cvNextAt.AddChangeHook(OnClockCvarChanged);
	g_cvCloseAt.AddChangeHook(OnClockCvarChanged);
	RegServerCmd("sm_booking_tell", Cmd_Tell, "sm_booking_tell - print the state a player is told on arrival, to the server console");
	RegServerCmd("sm_booking_time", Cmd_Time, "sm_booking_time - print the !time answer to the server console");
	CreateTimer(1.0, Timer_Clock, _, TIMER_REPEAT);
```

- [ ] **Step 3: Chat words**

In `OnClientSayCommand`, right after `int pos = BreakString(text, chatWord, sizeof(chatWord));`, add:

```sourcepawn
	if (strcmp(chatWord, "!time", false) == 0)
	{
		// Next frame, so the answer lands below the player's own !time line.
		if (client >= 1 && client <= MaxClients && IsClientInGame(client) && !IsFakeClient(client) && !TourneyBox())
			RequestFrame(Frame_TimeReply, GetClientUserId(client));
		return Plugin_Continue;
	}

	if (strcmp(chatWord, "!sub", false) == 0)
	{
		// A tournament box's !sub <out> <in> is pug-tourney.inc's.
		if (TourneyBox()) return Plugin_Continue;
		char rest[256];
		if (pos == -1) rest[0] = '\0';
		else strcopy(rest, sizeof(rest), text[pos]);
		ChatSub(client, rest);
		return Plugin_Continue;
	}
```

In `StartGrace` replace the captain line with:

```sourcepawn
		PrintToChat(i, "[Booking] %s joined and is not on the booking. Within %d seconds type !allow %s to let them watch, or !sub %s to let them play for your side.", name, grace, name, name);
```

- [ ] **Step 4: Arrival tell scheduling**

At the very top of `OnClientPostAdminCheck` add:

```sourcepawn
	// Scrims in game: told the booking's state once they are in (Timer_Clock),
	// on every connect and every map load.
	if (!IsFakeClient(client) && Booked()) g_fTellAt[client] = GetEngineTime() + TELL_DELAY;
```

and add a new forward:

```sourcepawn
public void OnClientDisconnect(int client)
{
	g_fTellAt[client] = 0.0;
}
```

- [ ] **Step 5: The new functions**

Append to the end of the file:

```sourcepawn
// ---------- scrims in game (1.5.0) ----------

/** The box is booked (the site set its password). */
bool Booked()
{
	char pw[64];
	g_cvPassword.GetString(pw, sizeof(pw));
	return pw[0] != '\0';
}

/** sm_pug_tournament 1 (pug-match): a tournament box, where the series engine speaks. */
bool TourneyBox()
{
	ConVar cv = FindConVar("sm_pug_tournament");
	return cv != null && cv.IntValue == 1;
}

/** An epoch cvar, read as text: GetInt goes through a float and loses up to 64 s. */
int CvarEpoch(ConVar cv)
{
	char s[16];
	cv.GetString(s, sizeof(s));
	return StringToInt(s);
}

/** Client 0 is the server console (the test commands). */
void Say(int client, const char[] text)
{
	if (client == 0) PrintToServer("%s", text);
	else PrintToChat(client, "%s", text);
}

/** Seconds as whole minutes, rounded up, as the site words it: "29 min", "1 h 52 min", "2 h". */
void LeftText(int seconds, char[] out, int maxlen)
{
	int mins = (seconds + 59) / 60;
	if (mins < 1) mins = 1;
	if (mins < 60) Format(out, maxlen, "%d min", mins);
	else if (mins % 60 == 0) Format(out, maxlen, "%d h", mins / 60);
	else Format(out, maxlen, "%d h %d min", mins / 60, mins % 60);
}

/** The next load or the close, when one is pending. */
bool PendingLine(char[] out, int maxlen)
{
	int now = GetTime();
	int next = CvarEpoch(g_cvNextAt);
	if (next > now)
	{
		char name[64];
		g_cvNextName.GetString(name, sizeof(name));
		Format(out, maxlen, "[Booking] Next: %s in %d s.", name, next - now);
		return true;
	}
	int close = CvarEpoch(g_cvCloseAt);
	if (close > now)
	{
		char left[32];
		LeftText(close - now, left, sizeof(left));
		Format(out, maxlen, "[Booking] Every booked campaign is played. The server closes in %s unless a captain types !addcampaign.", left);
		return true;
	}
	return false;
}

/** !time: the slot's end in UTC, then anything pending. */
void TimeReply(int client)
{
	int ends = CvarEpoch(g_cvEnds);
	if (ends <= 0)
	{
		Say(client, "[Booking] This server has not been told when the booked slot ends.");
		return;
	}
	int now = GetTime();
	int day = ends % 86400;
	char line[192];
	if (ends > now)
	{
		char left[32];
		LeftText(ends - now, left, sizeof(left));
		Format(line, sizeof(line), "[Booking] %s left in the booked slot (ends %02d:%02d UTC).", left, day / 3600, (day % 3600) / 60);
	}
	else
	{
		Format(line, sizeof(line), "[Booking] The booked slot ended at %02d:%02d UTC. A game in progress is finished, then the server closes.", day / 3600, (day % 3600) / 60);
	}
	Say(client, line);
	if (PendingLine(line, sizeof(line))) Say(client, line);
}

public void Frame_TimeReply(int userid)
{
	int client = GetClientOfUserId(userid);
	if (client > 0 && IsClientInGame(client)) TimeReply(client);
}

/** What a player is told once they are in: who plays, the campaign, the time
 *  left, anything pending, and the commands. Nothing on a tournament box. */
void TellState(int client)
{
	char title[128];
	g_cvTitle.GetString(title, sizeof(title));
	if (title[0] == '\0') return;
	char campaign[64], line[256];
	g_cvCampaign.GetString(campaign, sizeof(campaign));
	Format(line, sizeof(line), "[Booking] Scrim: %s", title);
	if (campaign[0] != '\0') Format(line, sizeof(line), "%s | %s", line, campaign);
	int ends = CvarEpoch(g_cvEnds), now = GetTime();
	if (ends > now)
	{
		char left[32];
		LeftText(ends - now, left, sizeof(left));
		Format(line, sizeof(line), "%s | %s left", line, left);
	}
	else if (ends > 0) Format(line, sizeof(line), "%s | the booked slot is over", line);
	Say(client, line);
	if (PendingLine(line, sizeof(line))) Say(client, line);
	Say(client, "[Booking] Type !time for the time left. Captains: !nextmap !stay !end !addcampaign !allow !sub");
}

public void OnClockCvarChanged(ConVar cv, const char[] oldValue, const char[] newValue)
{
	// A new time is a new countdown; the same value re-pushed every minute changes nothing.
	if (cv == g_cvNextAt) g_iNextSaid = MARK_NONE;
	else g_iCloseSaid = MARK_NONE;
}

/** One second of a countdown: center text through the last minute, a chat
 *  line at each mark (the smallest one crossed, once). The site's own line
 *  when it scheduled the load said "in 60 seconds", so a countdown first seen
 *  above 50 s starts with that mark already said. Also to the server console,
 *  for testing. */
void Countdown(int left, int &said, const char[] name, bool closing)
{
	if (left <= 0 || left > g_iMarks[0]) return;
	if (said == MARK_NONE && !closing && left > 50) said = g_iMarks[0];
	if (closing) PrintCenterTextAll("Server closes in %d s (!addcampaign for one more)", left);
	else PrintCenterTextAll("Next campaign: %s in %d s", name, left);
	int mark = 0;
	for (int i = 0; i < sizeof(g_iMarks); i++)
	{
		if (left <= g_iMarks[i] && said > g_iMarks[i]) mark = g_iMarks[i];
	}
	if (mark == 0) return;
	said = mark;
	char line[192];
	if (closing) Format(line, sizeof(line), "[Booking] The server closes in %d s. A captain can type !addcampaign to play one more.", left);
	else Format(line, sizeof(line), "[Booking] Next: %s in %d s. Captains: !nextmap to pick another, !stay to replay, !end to finish.", name, left);
	PrintToChatAll("%s", line);
	PrintToServer("%s", line);
}

/** Once a second: the arrival tells due, then the two countdowns. */
public Action Timer_Clock(Handle timer)
{
	if (!Booked() || TourneyBox()) return Plugin_Continue;
	float eng = GetEngineTime();
	for (int c = 1; c <= MaxClients; c++)
	{
		if (g_fTellAt[c] == 0.0 || eng < g_fTellAt[c]) continue;
		if (!IsClientInGame(c) || IsFakeClient(c)) { g_fTellAt[c] = 0.0; continue; }
		if (GetClientTeam(c) == 0) continue; // on no team yet: still loading in
		g_fTellAt[c] = 0.0;
		TellState(c);
	}
	int now = GetTime();
	int next = CvarEpoch(g_cvNextAt);
	if (next > 0)
	{
		char name[64];
		g_cvNextName.GetString(name, sizeof(name));
		Countdown(next - now, g_iNextSaid, name, false);
	}
	int close = CvarEpoch(g_cvCloseAt);
	if (close > 0 && next <= now) Countdown(close - now, g_iCloseSaid, "", true);
	return Plugin_Continue;
}

public Action Cmd_Tell(int args)
{
	TellState(0);
	return Plugin_Handled;
}

public Action Cmd_Time(int args)
{
	TimeReply(0);
	return Plugin_Handled;
}

/** !sub <name> from a captain: one connected human whose name contains the
 *  text (case-insensitive) is let onto the box at once, as !allow does, and
 *  the site is told (cmd=sub); the site makes them a ringer of the captain's
 *  side and pug-match places them. Any connected human may match, a watcher
 *  already on the list included. */
void ChatSub(int client, const char[] rawQuery)
{
	if (client < 1 || client > MaxClients || !IsClientInGame(client) || IsFakeClient(client)) return;
	char by[32];
	if (!GetClientAuthId(client, AuthId_SteamID64, by, sizeof(by))) return;
	if (!IsCaptain(by))
	{
		PrintToChat(client, "[Booking] Only a captain can do that.");
		return;
	}
	if (!HasLogSecret())
	{
		PrintToChat(client, "[Booking] The site cannot hear this server right now; use the booking page.");
		return;
	}
	char query[MAX_NAME_LENGTH];
	strcopy(query, sizeof(query), rawQuery);
	TrimString(query);
	int match = 0, found = 0;
	char id[32], name[MAX_NAME_LENGTH];
	if (query[0] != '\0')
	{
		for (int i = 1; i <= MaxClients; i++)
		{
			if (!IsClientConnected(i) || IsFakeClient(i) || IsClientSourceTV(i)) continue;
			if (!GetClientAuthId(i, AuthId_SteamID64, id, sizeof(id))) continue;
			GetClientName(i, name, sizeof(name));
			if (StrContains(name, query, false) == -1) continue;
			match = i;
			found++;
		}
	}
	if (found == 0)
	{
		PrintToChat(client, "[Booking] No one here matches that name.");
		return;
	}
	if (found > 1)
	{
		PrintToChat(client, "[Booking] More than one player matches; type more of the name.");
		return;
	}
	GetClientAuthId(match, AuthId_SteamID64, id, sizeof(id));
	GetClientName(match, name, sizeof(name));
	g_hAllowed.SetValue(id, true);
	g_hGrace.Remove(id);
	g_hBlocked.Remove(id);
	char arg[256];
	Format(arg, sizeof(arg), "%s %s", id, name);
	EmitBookingCmd(by, "sub", arg);
	PrintToChat(client, "[Booking] Sent to the site.");
}
```

- [ ] **Step 6: A commit starts the grace for anyone connected who is not on the new list (Ruling 14)**

In `Cmd_AllowCommit`, replace

```sourcepawn
	// Someone now on the list is neither blocked nor waiting.
	int lifted = DropListed(g_hBlocked);
	DropListed(g_hGrace);
	PrintToServer("PUGOK booking allow commit ids=%d lifted=%d", g_hAllowed.Size, lifted);
	return Plugin_Handled;
```

with

```sourcepawn
	// Someone now on the list is neither blocked nor waiting.
	int lifted = DropListed(g_hBlocked);
	DropListed(g_hGrace);
	// 1.5.0: someone already here who is not on the new list (removed or
	// replaced on the site mid chapter) gets the grace a fresh connect gets,
	// rather than playing on until the next map. A grace already running is
	// kept, so the site's minute re-push restarts nobody's.
	int graced = 0;
	if (Enforcing())
	{
		char id[32];
		int until;
		for (int c = 1; c <= MaxClients; c++)
		{
			if (!IsClientInGame(c) || IsExempt(c)) continue;
			if (!GetClientAuthId(c, AuthId_SteamID64, id, sizeof(id)) || !IsSteamId64(id)) continue;
			if (IsAllowed(id) || g_hGrace.GetValue(id, until)) continue;
			StartGrace(c, id);
			graced++;
		}
	}
	PrintToServer("PUGOK booking allow commit ids=%d lifted=%d graced=%d", g_hAllowed.Size, lifted, graced);
	return Plugin_Handled;
```

Add to the 1.5.0 header paragraph: `A list commit also starts the grace for anyone connected who is not on the new list, so someone removed or replaced on the site mid chapter is not left playing until the next map.`

Site check: `grep -rn "allow commit" src tests` must show nothing that parses the commit's reply (the site never reads it), so the added `graced=` field is safe for every site version.

- [ ] **Step 6b: Compile**

Run: `cd /home/volence/l4d/pug/.claude/worktrees/scrim-ingame/plugin && ./build-booking.sh 2>&1 | tail -20`
Expected: `built: .../plugin/l4d_booking.smx`, no errors or new warnings.

- [ ] **Step 7: Local check on 27055**

Only with 0 humans.

```bash
export RPORT=27055
R() { python3 /home/volence/l4d/nightmode/rcon.py "$@"; }
R status | grep -E '^players'
SM=/home/volence/l4d1-ds/server/left4dead/addons/sourcemod/plugins
cp plugin/l4d_booking.smx "$SM/disabled/l4d_booking-scrim.smx"
R 'sm plugins load_unlock' 'sm plugins unload l4d_booking' 'sm plugins load disabled/l4d_booking-scrim' 'sm plugins load_lock'
R 'l4d_booking_version'                                   # 1.5.0
R 'con_logfile logs/scrim-console.log'
END=$(( $(date +%s) + 6720 ))
R 'l4d_booking_password "localtest"' 'l4d_booking_title "big BAD boys vs Test"' 'l4d_booking_campaign "Blood Harvest"' "l4d_booking_ends $END"
R 'sm_booking_tell'
#   [Booking] Scrim: big BAD boys vs Test | Blood Harvest | 1 h 52 min left
#   [Booking] Type !time for the time left. Captains: !nextmap !stay !end !addcampaign !allow !sub
R 'sm_booking_time'          # [Booking] 1 h 52 min left in the booked slot (ends HH:MM UTC).
date -u -d "@$END" +%H:%M    # the same HH:MM
R "l4d_booking_next_at $(( $(date +%s) + 45 ))" 'l4d_booking_next_name "Death Toll"'
sleep 40
grep '\[Booking\] Next: Death Toll' /home/volence/l4d1-ds/server/left4dead/logs/scrim-console.log
#   three lines: "in 45 s" (the 60 mark, first seen at 45), "in 30 s", "in 10 s"
R "l4d_booking_next_at 0" "l4d_booking_close_at $(( $(date +%s) + 35 ))"
sleep 30
grep '\[Booking\] The server closes in' /home/volence/l4d1-ds/server/left4dead/logs/scrim-console.log   # "in 35 s" (the 60 mark), then "in 30 s"
R "l4d_booking_ends $(( $(date +%s) - 60 ))" 'sm_booking_time'   # the "ended at" line
R 'sm_booking_status'        # the allowlist commands still answer
R 'sm_booking_allow_begin' 'sm_booking_allow_add 76561199000000001' 'sm_booking_allow_commit'   # PUGOK booking allow commit ids=1 lifted=0 graced=0 (nobody connected)
```

Expected for the close: chat lines at the 60 mark (said at 35 s, the first second seen), then at 30 s, then at 10 s if you wait that long. Restore:

```bash
R 'l4d_booking_password ""' 'l4d_booking_title ""' 'l4d_booking_campaign ""' 'l4d_booking_ends 0' 'l4d_booking_next_at 0' 'l4d_booking_next_name ""' 'l4d_booking_close_at 0' 'con_logfile ""'
R 'sm plugins load_unlock' 'sm plugins unload l4d_booking-scrim' 'sm plugins load l4d_booking' 'sm plugins load_lock'
rm "$SM/disabled/l4d_booking-scrim.smx"
R 'l4d_booking_version'      # back to 1.4.0
```

- [ ] **Step 8: Record the checklist**

Append to `plugin/TESTING.md` a section `## Booked scrim clock (l4d_booking 1.5.0)` with Step 7's commands and results (ticked, dated), plus an unticked owner list for a live booked scrim: `!time` from a non-captain; the center countdown readable during the finale and not hiding the ready panel; the chat marks at 60 (only when the countdown starts below 50 s), 30 and 10 s; the re-tell arriving after a slow load and after each map change; `!sub` on a watcher landing them on their side; `!allow` saying "can watch (allowed by ...)". Ruling 14: a player removed from the booking on the site while connected gets the "captain has N seconds" notice at the next minute re-push and is kicked after the grace unless a captain types `!allow` or `!sub`.

- [ ] **Step 9: Commit**

```bash
git add plugin/l4d_booking.sp plugin/TESTING.md
git commit -m "l4d_booking 1.5.0 answers !time, counts down to the next campaign and the close, re-tells the booking on arrival and adds !sub."
```

(Add `plugin/l4d_booking.smx` to that `git add` only if `git ls-files plugin/l4d_booking.smx` shows it is tracked.)

---

### Task 14: Whole-branch verification and the mixed-fleet walk

**Files:** none new (fix only what this task finds, in the file that owns it).

- [ ] **Step 1: Run everything**

Run: `npm test 2>&1 | tail -15 && npm run typecheck`
Expected: all server and web projects pass, no type errors.

- [ ] **Step 2: Scan for leftovers**

Run each and read the output:

```bash
grep -rn $'\u2014' src web/src plugin docs/superpowers/plans/2026-10-11-scrims-ingame.md tests | head   # expected: nothing (no em dashes)
grep -rn "WARN_MINUTES\|in about a minute\|of the booked slot left" src tests web/src | head             # expected: nothing
grep -n "PLUGIN_VERSION" plugin/pug-match.sp plugin/l4d_booking.sp                                        # 0.3.33 and 1.5.0
ls -la plugin/pug-match.smx plugin/l4d_booking.smx                                                        # both built in this branch
```

- [ ] **Step 3: Walk the mixed fleet against the code**

Confirm each line by reading the code paths named; fix and re-test any that does not hold:

| Site | pug-match | l4d_booking | Expected |
|---|---|---|---|
| new | 0.3.32 | 1.4.0 | `sm_pug_book_*` and the clock cvars answer `Unknown command`; nothing on the site parses those replies (`warnCarryRefused` reads only `sm_pug_carry`; setup reads only `l4d_game_type_name`, `l4d_booking_version`, `l4d_booking_id`, `status`; recovery reads the resume replies, which come first in its burst). No placement, no clock; `!allow` watchers are not enforced off teams; old grace text says "as a ringer". Task 6's Unknown-command test covers setup and the watch. |
| new | 0.3.33 | 1.4.0 | Placement works; no `!time`, no countdown, no `!sub` (the site waits for `cmd=sub`, which never comes). |
| new | 0.3.32 | 1.5.0 | Clock, `!time`, re-tell and `!sub` work; `!sub` lands in the site's roster but no placement. |
| old | 0.3.33 | any | Nothing commits a booking roster, so `Book_Active()` is false and `TeamLockActive()` is exactly 0.3.32's. |
| old | any | 1.5.0 | No clock cvars: no re-tell (empty title), `!time` says it has not been told, no countdown. A captain's `!sub` emits `cmd=sub`, which the old site's `BOOKING_CMDS` rejects, so nothing is added on the site although the plugin let the person past the allowlist until the next commit. Hence the rollout note below: web first. |

- [ ] **Step 4: Stop what you started**

If Task 2 Step 1 started the 27055 server, check `R status` shows no humans and no foreign recent `rcon from` lines in the newest L log, then stop it by the PID you wrote down: `kill <pid>` (never `pkill -f`).

- [ ] **Step 5: Hand-off notes for the owner (in the final report, not a file)**

- Rollout (not done here): web first (`deploy-web.sh`), then both plugins staged on restart to the five pool boxes. Old plugins keep working with the new web; a new l4d_booking before the new web would make `!sub` silently do nothing.
- Owner live test on the first booked scrim after rollout: the two TESTING.md lists from Tasks 12 and 13.
- Rulings 2, 4, 6, 7 and 9 are the ones most worth a yes or no.

- [ ] **Step 6: Final commit (only if Steps 1 to 4 changed anything)**

```bash
git add <only the files you fixed>
git commit -m "Fix what the whole-branch check of the scrims in game work found."
```

Then `git log --oneline master..HEAD`: one commit per task 1 to 13, each a plain sentence, plus the plan commit (and Task 14's fix commit if it made one). Do not push.

---

## Self-Review

**Spec coverage.** Item 3 placement: Tasks 6 and 12 (sides by `firstSurvivorSide`, the ruleset's `teamLock`, watchers kept off, subs placed, `booking_side_a` still from adoption). Item 4 `!time` with the end pushed in the minute re-push and the 30 minute warning: Tasks 3, 4, 13. Item 5 visible gap, plugin-driven at 60/30/10 s, delay decision: Tasks 3, 5, 13, Ruling 4. Item 7 slot end during the last game: Task 4. Item 8 re-tell after load and after each map load, and the closing countdown: Tasks 3, 5, 13. Item 9 `//` and other untrusted console text (`;` and `"` already dropped, the series line fixed): Task 1, Task 7's test. Item 10 `!allow` watchers, `!sub`, placement of subs and watchers: Tasks 7, 12, 13; a removed or replaced player losing the box mid chapter: Task 13 Step 6. Added by the coordinator: the moved box's forced restart surviving a web restart: Task 11. Item 14 Start now (web, API, wait line, take-back, box check, `scrim_posts` checked): Tasks 8, 9, 10, Ruling 7. Item 16 log hygiene with the pattern verified: Task 2.

**Placeholder scan.** Every code step carries its code; every test step its test; the local checks carry their commands and expected output.

**Type consistency.** `quietLines` (Task 2) used in Tasks 3 and 6. `bookRosterLines(db, b)` (Task 6) used in Task 7. `allowInGame` returns `{ side, added, role }` in Task 7's code and tests. `subInGame` change values `'added' | 'upgraded' | 'accepted' | 'already'` match the runner's messages. `pressStartNow` returns `{ both, side }`, used by `startNow` (Task 9). `startNow`/`canStartNow` names match across bookings.ts, the route test, api.ts and Booking.tsx. `WAKE_SLACK_MS`, `later`, `warnMark`, `leftText` are exported where the tests import them. `fresh_box` / `markBoxRestarted` (Task 11) replace every use of the removed `freshBox` set. Plugin: `Book_Active`, `Book_Pass`, `Book_Init`, `Book_OnClientPostAdminCheck`, `Book_OnDisconnect` are defined in pug-booking.inc and called by the names Task 12 Step 2 wires.

**Review Focus.** Each of the five lines has its test in the owning task (1, 6, 8 and 9, 5, 4); the three things only a live scrim can show are in the owner lists of Tasks 12 and 13.
