# Admin Desks 2: Live Presence and the Abandon Hold Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give an admin a live board showing who is missing from every ongoing match, with a working Hold, Add 5 minutes and End now on a dropped player's abandon allowance, and one admin-feed warning when that allowance runs low.

**Architecture:** The plugin (pug-match 0.3.4) gains one token-checked server command, `sm_pug_leave`, that freezes, resumes, extends or ends one roster slot's allowance, answers `PUGOK leave ...` with the new state and echoes it as a LEAVE or RETURN log line. The backend keeps a `match_presence` row per rostered player, written from PLAYER connect, LEAVE, RETURN and the command's own RCON answer. It serves the board from that table, and one five-second sweep posts the low-allowance alert and expires holds. The frontend is one new `AdminLive.tsx` tab that ticks every countdown from a single shared clock and re-syncs on every hub `refresh`.

**Tech Stack:** SourcePawn 1.12 (wine + spcomp via `plugin/build.sh`), Fastify 5, better-sqlite3, Source RCON (`src/rcon.ts`), Preact 10 + preact-iso, vitest 4 (`server` project on node, `web` project on happy-dom).

**Spec:** `docs/superpowers/specs/2026-09-21-admin-desks-design.md`. This plan covers build order item 2 only, "Live, part one". The no-show clock control, cancel with a penalty choice and waive are part two and get their own plan. The People desk and Setup get their own plans.

## Global Constraints

- No em dashes anywhere: code, comments, commit messages, docs, UI copy.
- Match the surrounding code style and comment density. Comments say why, in the repo's voice.
- Commit messages are one plain imperative sentence with no prefix (see `git log --oneline -15`).
- Every mutation goes through `logAdmin`.
- Backward compatibility is mandatory because web deploys before plugins: the new backend must work against pug-match 0.3.3, and every old log line must still parse to exactly the object it parses to today.
- Never start or stop any srcds and never touch a live server. The shared local test server is off limits. The plugin must compile clean with `plugin/build.sh`; in-game verification is written into `plugin/TESTING.md` for the owner to run with a real client.
- All work happens in the worktree `/home/volence/l4d/pug/.claude/worktrees/admin-desks` on branch `worktree-admin-desks`. Never on master. Nothing is deployed: no rcon, no ssh, no `deploy-web.sh`.
- No `CHECK` constraint on any status-like column. New tables are `CREATE TABLE IF NOT EXISTS`; new columns go through `ensureColumn` in `src/db.ts`.
- Full `npx vitest run` and `npm run typecheck` are green at the end of every task.
- A sibling plan ("People") is being written in parallel and introduces the admin routing skeleton (`/admin` redirecting by role, `/admin/people/...`). This plan does not restructure routing. The Live board lands as a new first tab of the existing `web/src/routes/Admin.tsx`. **Whichever plan lands second moves `AdminLive` to `/admin/live`.** It also rewrites the one feed link this plan adds (`/admin?live=<matchId>`) to the new URL, and resolves the small overlap in `Admin.tsx` and `web/src/routes/admin.test.tsx`.

## Design decisions, settled from the code

1. **Two verbs for the echo.** A dropped player's new state goes out as `LEAVE steamid= remaining= held= hold_left= auto=`. A connected player (only `add` can target one) goes out as `RETURN steamid= remaining=`, because RETURN already means "connected, with this much left". The old `LEAVE steamid= remaining=` emit at disconnect is untouched, and `tests/abandon.test.ts:44` pins its parsed shape with `toEqual`, so the new keys are optional on the event type and absent when absent on the line.
2. **The hold has no timer of its own.** The ceiling is checked inside the existing `Timer_LeaveClock`, a plain `TIMER_REPEAT` created once in `LeaveInit` without `TIMER_FLAG_NO_MAPCHANGE`. There is no handle to null in `OnMapEnd`, which sidesteps the `g_hTeardown` trap entirely. A parity test pins the `CreateTimer` count of the file.
3. **Hold banks, release re-anchors.**
   - `hold` adds the span spent so far to `g_fAbsentUsed` and sets `g_fHoldSince`.
   - `LeaveRemaining` skips the running span while held.
   - `release` sets `g_fAbsentSince` to now.
   - `GetEngineTime` is monotonic across a changelevel, so a hold survives a map change with no extra code.
4. **RETURN while held** ends the hold and charges nothing for the held span. **Match end while held** is `LeaveReset`, which clears the new array. **hold or end on a connected player** is refused with `PUGERR not dropped`. **add** is allowed for any rostered player, so an admin can pre-grant time. **release** is idempotent and answers `PUGOK` with the current state, so a retried release is harmless.
5. **The plugin is the ceiling; the backend mirrors it.**
   - The orchestrator pushes `sm_pug_leave_hold_max <clock_hold_max_minutes * 60>` at match setup, next to `sm_pug_leave_budget`.
   - The plugin's answer to a hold carries `hold_left`, from which the backend computes `hold_until`.
   - The sweep flips an expired row locally at `hold_until` with no RCON dial.
   - The plugin's `auto=1` line does the same flip.
   - Whichever flips the row from held to not held publishes the feed line, so it posts once.
6. **Old plugin detection is free and also lazy.**
   - The reply to the `sm_pug_leave_hold_max` push at setup is `Unknown command` on 0.3.3, and that is recorded in `matches.leave_control` (NULL unknown, 0 old, 1 ok).
   - A match that never went through setup is `unknown`, which leaves the buttons enabled, and the first action's own answer records what the box really is.
   - A box updated mid-match is NOT corrected by "the first action's own answer": with `leave_control` 0 the board disables the buttons, so no first action is reachable from the UI at all. What actually guarantees this is that the probe fails in the SAFE direction. If srcds's wording ever fails the strict per-line `isUnknownCvar` match, `leave_control` becomes 1 on an old plugin, the buttons stay live, and the first Hold falls through to `parseLeaveReply`'s broad `isUnknownCommand`, which corrects the column to 0. Greying out Hold is the failure that costs a ranked match; enabling a button that then explains itself is not.
   - The board greys the buttons with the reason when it is 0.
7. **The RCON answer is what updates the board, not the UDP echo.** The route parses `PUGOK leave ...` and writes `match_presence` from it. The echo line arrives at the same state and is a no-op. A failure (no connection, `PUGERR`, unreadable answer) writes nothing and returns the error for the card.
8. **Countdowns carry no wall-clock timestamps to the browser.**
   - The API sends durations as of the response (`sinceS`, `remainingS`, `holdLeftS`, `sincePopS`, `elapsedS`).
   - The browser subtracts time elapsed since receipt, from one shared ticker.
   - A wrong clock on the admin's PC therefore cannot move the countdown.
   - The table itself stores ISO instants (`since`, `remaining_at`, `hold_until`), which is what survives a backend restart.
9. **`remaining_at` is a column the spec does not list.** `since` answers "when did they leave"; after a hold, release or add, `remaining_s` is as of a different instant. `updated_at` cannot be that anchor because writes that do not touch the clock (the alert stamp) also move it.
10. **PLAYER disconnect never changes presence.** The plugin pulses disconnect then connect for every client on every changelevel (`pug-match.sp:2677`), and LEAVE is already emitted from the real `player_disconnect` event. Treating the pulse as a drop would flash all eight players as dropped on every map load, on the board built to show who is really missing. PLAYER connect does write: it is how a never-connected player becomes "on the server", and how a lost RETURN line self-corrects.
11. **Reasons, never guessed.**
    - "rejected by the file check at HH:MM" comes from the newest `signon_drops` row since the pop with `entered_after_at IS NULL`.
    - "not in a voice channel" comes from `VoicePresence.inVoice(discord_id) === false`.
    - "Steam ID not verified" is NOT built: the plugin's `KickClient(client, "Could not verify Steam ID")` fires exactly when it has no SteamID, so there is no id to hang a reason on and no log line exists. The reason type has no such kind.
12. **Low-allowance alert lives in the sweep.** `sweepPresence` runs every 5 s, computes each dropped, unheld row's remaining time from `remaining_s` and `remaining_at`, and stamps `low_alert_at` with a guarded `UPDATE ... WHERE low_alert_at IS NULL`. It publishes only when that update changed a row. The stamp is in the table, so a restart neither re-posts nor forgets. It resets on the next drop, not on an add, so it fires once per drop as the spec says.
13. **Controls sit on the player row.** The abandon clock belongs to one player, and the row with the red countdown is where the admin is already looking. The card's clocks strip is a summary. Part two's match-level no-show clock gets its controls in the strip.
14. **The Matches tab stays** for this plan: Abort lives there until part two replaces it with Cancel. Its three lower panels are extracted into shared components, so Live and Matches render one implementation.

## File Structure

Created:
- `plugin/pug-match.smx`: build output, gitignored, never committed.
- `src/presence.ts`: the `match_presence` row type, `remainingNow`, `applyLeaveState`, `applyConnect`, `recordPresenceLine`, `sweepPresence`, and the two clock settings readers.
- `src/leaveControl.ts`: the `sm_pug_leave` command string, the `PUGOK leave` answer parser, the old-plugin test, the `ServerQuery` type.
- `src/admin/liveBoard.ts`: builds the `/api/admin/live` payload.
- `web/src/liveBoard.ts`: pure browser helpers (countdown arithmetic, reason wording, `?live=` reader, the old-plugin reason).
- `web/src/hooks/useHubEvent.ts`: a websocket listener that calls back on named hub events.
- `web/src/hooks/useElapsedSince.ts`: the one shared ticker.
- `web/src/routes/admin/AdminLive.tsx`: the board.
- `web/src/routes/admin/MatchPanels.tsx`: the Servers, Queue and Recent results panels, moved out of `AdminMatches.tsx`.
- Tests: `tests/leaveCommandParity.test.ts`, `tests/leaveLineParse.test.ts`, `tests/presenceSchema.test.ts`, `tests/presence.test.ts`, `tests/presenceWiring.test.ts`, `tests/leaveControl.test.ts`, `tests/adminLive.test.ts`, `tests/liveBoard.test.ts`, `tests/presenceSweep.test.ts`, `web/src/liveBoard.test.ts`, `web/src/routes/admin/AdminLive.test.tsx`.

Modified:
- `plugin/pug-leave.inc` (hold state, ceiling, command, status), `plugin/pug-match.sp` (version, `RegServerCmd`), `plugin/README.md`, `plugin/TESTING.md`.
- `src/logParse.ts` (optional LEAVE keys).
- `src/db.ts` (table, column, two settings), `src/settingsSchema.ts`, `src/mergePlayers.ts` (one `KEYED` line).
- `src/orchestrator.ts` (push the hold ceiling, record capability).
- `src/server.ts` (dispatch LEAVE, RETURN and connect to presence, the `serverQuery` dependency, the sweep timer).
- `src/routes/admin.ts` (two routes).
- `src/adminFeed.ts`, `src/discord/adminFeedPoster.ts` (the `clock` event and the `leave_clock` action wording).
- `web/src/api.ts`, `web/src/routes/Admin.tsx`, `web/src/routes/admin/AdminMatches.tsx`, `web/src/routes/admin.test.tsx`, `web/src/styles/app.css`.
- `tests/orchestrator.test.ts`, `tests/mergePlayers.test.ts`, `tests/discordAdminFeed.test.ts`.

---

### Task 1: The plugin command `sm_pug_leave` (pug-match 0.3.4)

**Files:**
- Create: `tests/leaveCommandParity.test.ts`
- Modify: `plugin/pug-match.sp:18` (version), `plugin/pug-match.sp:380-385` (the `RegServerCmd` block), `plugin/pug-leave.inc` (globals at 21-30, `LeaveInit` 38-48, `LeaveReset` 50-65, `LeaveRemaining` 75-81, `LeaveOnReturn` 113-135, `Timer_LeaveClock` 146-171, `LeaveStatus` 252-263, plus new functions before `LeaveStatus`)

**Interfaces:**
- Consumes (all real, in `pug-match.sp`): `bool TokenArgOk(int args)`, `int RosterIndexOfId(const char[] steamid64)`, `int ClientOfSlot(int slot)`, `void EmitPug(const char[] fmt, any ...)`, `void DumpLine(const char[] fmt, any ...)`, `g_sRosterId[][]`, `g_iRosterCount`.
- Produces:
  - Server command `sm_pug_leave <token> <steamid64> hold|release|add <seconds>|end`.
  - Answer `PUGOK leave steamid=<id64> absent=<0|1> remaining=<s> held=<0|1> hold_left=<s>`, or `PUGERR <reason>` with reasons `usage: ...`, `match already abandoned`, `leave tracking is off`, `not rostered`, `not dropped`, `bad seconds`, `allowance is already at its maximum`, `unknown action`, plus the three from `TokenArgOk`.
  - Log lines `LEAVE steamid=<id64> remaining=<s> held=<0|1> hold_left=<s> auto=<0|1>` (dropped player) and `RETURN steamid=<id64> remaining=<s>` (connected player).
  - Cvar `sm_pug_leave_hold_max` (default 1800, bounds 10 to 7200).
  - `STATUS leave` lines extended at the END with `holdmax=`, `held=`, `hold_left=`.

- [ ] **Step 1: Write the failing parity test**

`tests/leaveCommandParity.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

/** The plugin half of the abandon hold. Nothing here can run SourcePawn, so
 *  like the other parity tests this reads the source as text. It pins the
 *  properties the backend depends on and the ones that are easy to lose in an
 *  edit: the token check comes first, a hold on a connected player is refused
 *  while an add is not, nothing the caller typed is printed back, and the hold
 *  owns no timer (a TIMER_FLAG_NO_MAPCHANGE handle is freed at level shutdown,
 *  which is the trap OnMapEnd documents for g_hTeardown).
 *
 *  The first assertion of each block guards the extraction itself. */

const __dirname = dirname(fileURLToPath(import.meta.url));
const matchSrc = readFileSync(join(__dirname, '../plugin/pug-match.sp'), 'utf8');
const leaveSrc = readFileSync(join(__dirname, '../plugin/pug-leave.inc'), 'utf8');

/** The body of a top-level function, given its full signature line. */
function body(src: string, signature: string): string {
  const at = src.indexOf(`\n${signature}\n{\n`);
  if (at < 0) return '';
  const start = at + signature.length + 4;
  const end = src.indexOf('\n}\n', start);
  return end < 0 ? '' : src.slice(start, end);
}

/** The text of one verb's branch inside Cmd_Leave. */
function branch(cmd: string, verb: string, next: string | null): string {
  const from = cmd.indexOf(`StrEqual(verb, "${verb}")`);
  const to = next === null ? cmd.length : cmd.indexOf(`StrEqual(verb, "${next}")`);
  return from < 0 || to < 0 ? '' : cmd.slice(from, to);
}

describe('sm_pug_leave registration', () => {
  it('is a server command with the documented grammar', () => {
    expect(matchSrc).toContain(
      'RegServerCmd("sm_pug_leave", Cmd_Leave, "sm_pug_leave <token> <steamid64> hold|release|add <seconds>|end");',
    );
  });

  it('ships in 0.3.4', () => {
    expect(matchSrc).toContain('#define PLUGIN_VERSION "0.3.4"');
  });
});

describe('Cmd_Leave', () => {
  const cmd = body(leaveSrc, 'public Action Cmd_Leave(int args)');

  it('is found at all', () => {
    expect(cmd).toContain('GetCmdArg(3, verb, sizeof(verb));');
  });

  it('checks the token before anything else', () => {
    expect(cmd.trimStart().startsWith('if (!TokenArgOk(args)) return Plugin_Handled;')).toBe(true);
  });

  it('knows the four verbs', () => {
    for (const verb of ['hold', 'release', 'add', 'end']) expect(cmd).toContain(`StrEqual(verb, "${verb}")`);
  });

  it('refuses hold and end for a connected player, and allows add', () => {
    expect(branch(cmd, 'hold', 'release')).toContain('PUGERR not dropped');
    expect(branch(cmd, 'end', null)).toContain('PUGERR not dropped');
    expect(branch(cmd, 'add', 'end')).not.toContain('PUGERR not dropped');
  });

  it('never prints the caller\'s text back', () => {
    expect(cmd).not.toMatch(/PrintToServer\("PUGERR[^"]*%s/);
  });

  it('answers and echoes after every change', () => {
    expect(cmd).toContain('LeaveReply(slot);');
    expect(cmd).toContain('LeaveEmitState(slot, false);');
  });
});

describe('the hold itself', () => {
  it('spends nothing while held', () => {
    expect(body(leaveSrc, 'int LeaveRemaining(int slot)')).toContain('g_fHoldSince[slot] <= 0.0');
  });

  it('is cleared with the match, and by a return', () => {
    expect(body(leaveSrc, 'void LeaveReset()')).toContain('g_fHoldSince[i] = 0.0;');
    expect(body(leaveSrc, 'void LeaveOnReturn(int slot)')).toContain('g_fHoldSince[slot] = 0.0;');
  });

  it('has a ceiling that releases it and says so', () => {
    expect(leaveSrc).toContain('CreateConVar("sm_pug_leave_hold_max", "1800"');
    const clock = body(leaveSrc, 'public Action Timer_LeaveClock(Handle timer)');
    expect(clock).toContain('g_cvLeaveHoldMax.FloatValue');
    expect(clock).toContain('LeaveEmitState(i, true);');
  });

  it('owns no timer: the file still creates exactly the two it always did', () => {
    expect(leaveSrc.match(/CreateTimer\(/g)).toHaveLength(2);
  });

  it('keeps the STATUS line abandon.ts reads, and only appends to it', () => {
    expect(leaveSrc).toContain('DumpLine("STATUS leave abandoner=%s budget=%d autounpause=%d paused=%d holdmax=%d"');
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run tests/leaveCommandParity.test.ts`
Expected: FAIL. `is a server command with the documented grammar`, `ships in 0.3.4`, `is found at all` and every assertion after them fail, because `Cmd_Leave` does not exist. `owns no timer` passes already; it is there to keep passing.

- [ ] **Step 3: Bump the version and register the command**

`plugin/pug-match.sp:18`:

```sourcepawn
#define PLUGIN_VERSION "0.3.4"
```

`plugin/pug-match.sp`, in `OnPluginStart`, directly after the `sm_pug_setid` line (385):

```sourcepawn
	RegServerCmd("sm_pug_leave", Cmd_Leave, "sm_pug_leave <token> <steamid64> hold|release|add <seconds>|end");
```

- [ ] **Step 4: The hold state, the cvar and the reset**

`plugin/pug-leave.inc`, globals. After `ConVar g_cvLeaveAutoUnpause;`:

```sourcepawn
ConVar g_cvLeaveHoldMax;
```

After `float g_fAbsentUsed[MAX_ROSTER];`:

```sourcepawn
float g_fHoldSince[MAX_ROSTER];     // engine time an admin hold began; 0.0 = not held
```

In `LeaveInit`, after the `sm_pug_leave_autounpause` convar and before `HookEvent`:

```sourcepawn
	// An admin can freeze one player's allowance (sm_pug_leave ... hold) while
	// they sort out a reconnect. The ceiling is enforced here and not only by
	// the backend, so a release that never arrives cannot pin a server paused.
	g_cvLeaveHoldMax = CreateConVar("sm_pug_leave_hold_max", "1800",
		"Longest an admin hold may freeze one player's reconnect allowance, in seconds. The hold releases itself after this.",
		FCVAR_NOTIFY, true, 10.0, true, 7200.0);
```

In `LeaveReset`, inside the loop, after `g_fAbsentUsed[i] = 0.0;`:

```sourcepawn
		g_fHoldSince[i] = 0.0;
```

- [ ] **Step 5: `LeaveRemaining`, `LeaveOnReturn` and the clock timer**

Replace `LeaveRemaining`:

```sourcepawn
int LeaveRemaining(int slot)
{
	float used = g_fAbsentUsed[slot];
	// A held slot spends nothing: LeaveHold banked what had been used, and
	// LeaveRelease restarts the running span from the moment of the release.
	// used can be negative after an admin add, which is how the allowance
	// grows past the budget.
	if (g_fAbsentSince[slot] > 0.0 && g_fHoldSince[slot] <= 0.0) used += GetEngineTime() - g_fAbsentSince[slot];
	int left = g_cvLeaveBudget.IntValue - RoundToFloor(used);
	return left < 0 ? 0 : left;
}
```

In `LeaveOnReturn`, replace the two lines

```sourcepawn
	g_fAbsentUsed[slot] += GetEngineTime() - g_fAbsentSince[slot];
	g_fAbsentSince[slot] = 0.0;
```

with

```sourcepawn
	// Back while held: the hold ends with nothing left to hold, and the held
	// span is not charged, because LeaveHold already banked everything before it.
	if (g_fHoldSince[slot] <= 0.0) g_fAbsentUsed[slot] += GetEngineTime() - g_fAbsentSince[slot];
	g_fHoldSince[slot] = 0.0;
	g_fAbsentSince[slot] = 0.0;
```

In `Timer_LeaveClock`, inside the `for` loop, directly after `if (g_fAbsentSince[i] <= 0.0) continue;`:

```sourcepawn
		if (g_fHoldSince[i] > 0.0)
		{
			// Nothing is spent and nothing is warned about while held. The
			// ceiling is checked here, on the one repeating timer this module
			// already owns, so the hold has no handle of its own for a map
			// change to free (the g_hTeardown trap in OnMapEnd). GetEngineTime
			// does not reset across a changelevel, so a hold survives one.
			if (GetEngineTime() - g_fHoldSince[i] < g_cvLeaveHoldMax.FloatValue) continue;
			LeaveRelease(i);
			char held[MAX_NAME_LENGTH];
			LeaveNameOf(i, held, sizeof(held));
			PrintToChatAll("\x04[PUG]\x01 The hold on %s's reconnect time ran out. Their clock is running again.", held);
			LeaveEmitState(i, true);
		}
```

- [ ] **Step 6: The helpers and the command**

`plugin/pug-leave.inc`, directly before the `/** STATUS lines for sm_pug_status ... */` comment:

```sourcepawn
// ---------- admin control of one player's allowance ----------
//
// The owner lost a ranked match to this clock while trying to stop it for a
// player who was seconds from reconnecting (2026-09-21). These four verbs are
// what the website's live board sends over rcon.

void LeaveHold(int slot)
{
	// A second hold is a no-op and does NOT restart the ceiling.
	if (g_fHoldSince[slot] > 0.0) return;
	float now = GetEngineTime();
	g_fAbsentUsed[slot] += now - g_fAbsentSince[slot];
	g_fAbsentSince[slot] = now;
	g_fHoldSince[slot] = now;
}

void LeaveRelease(int slot)
{
	if (g_fHoldSince[slot] <= 0.0) return;
	g_fHoldSince[slot] = 0.0;
	if (g_fAbsentSince[slot] > 0.0) g_fAbsentSince[slot] = GetEngineTime();
	// So the 60, 30 and 10 second warnings are announced again if they had
	// already been before the hold.
	g_iLeaveWarned[slot] = 0;
}

/** Seconds until the ceiling releases this slot's hold, 0 when not held. */
int LeaveHoldLeft(int slot)
{
	if (g_fHoldSince[slot] <= 0.0) return 0;
	int left = RoundToCeil(g_cvLeaveHoldMax.FloatValue - (GetEngineTime() - g_fHoldSince[slot]));
	return left < 0 ? 0 : left;
}

/** A name for chat. g_sLeaveName is only set at a disconnect, and a backend
 *  match leaves g_sRosterName empty, so a connected player is asked directly. */
void LeaveNameOf(int slot, char[] out, int maxlen)
{
	int client = ClientOfSlot(slot);
	if (client != -1) GetClientName(client, out, maxlen);
	else if (g_sLeaveName[slot][0] != '\0') strcopy(out, maxlen, g_sLeaveName[slot]);
	else strcopy(out, maxlen, g_sRosterId[slot]);
}

/** The new state, on the log stream, so the website's board updates the same
 *  way it does for a real disconnect. LEAVE for someone who is gone, with the
 *  optional keys a parser older than 0.3.4 ignores; RETURN for someone who is
 *  here, because "connected, this much left" is exactly what RETURN says. */
void LeaveEmitState(int slot, bool autoRelease)
{
	int left = LeaveRemaining(slot);
	if (g_fAbsentSince[slot] <= 0.0)
	{
		EmitPug("RETURN steamid=%s remaining=%d", g_sRosterId[slot], left);
		return;
	}
	EmitPug("LEAVE steamid=%s remaining=%d held=%d hold_left=%d auto=%d",
		g_sRosterId[slot], left, g_fHoldSince[slot] > 0.0 ? 1 : 0, LeaveHoldLeft(slot), autoRelease ? 1 : 0);
}

/** The rcon answer. The backend writes its board from THIS, not from the log
 *  line above, which rides lossy UDP. */
void LeaveReply(int slot)
{
	PrintToServer("PUGOK leave steamid=%s absent=%d remaining=%d held=%d hold_left=%d",
		g_sRosterId[slot], g_fAbsentSince[slot] > 0.0 ? 1 : 0, LeaveRemaining(slot),
		g_fHoldSince[slot] > 0.0 ? 1 : 0, LeaveHoldLeft(slot));
}

/** sm_pug_leave <token> <steamid64> hold|release|add <seconds>|end
 *
 *  hold    freeze a dropped player's allowance until release, their return, or
 *          sm_pug_leave_hold_max. Refused for someone who is connected.
 *  release resume it. Idempotent: releasing nothing answers PUGOK with the
 *          state as it is, so a retried release is harmless.
 *  add     more allowance, for anyone rostered, connected or not, so an admin
 *          can grant time before a flaky player drops again. Capped so the
 *          allowance never exceeds an hour.
 *  end     the allowance is gone: Timer_LeaveClock sees zero on its next tick
 *          and the ordinary ABANDON path runs. Refused for someone connected;
 *          ending a match with everyone present is a cancel, not an abandon.
 *
 *  Nothing the caller typed is ever printed back. */
public Action Cmd_Leave(int args)
{
	if (!TokenArgOk(args)) return Plugin_Handled;
	if (args < 3)
	{
		PrintToServer("PUGERR usage: sm_pug_leave <token> <steamid64> hold|release|add <seconds>|end");
		return Plugin_Handled;
	}
	if (g_sAbandoner[0] != '\0')
	{
		PrintToServer("PUGERR match already abandoned");
		return Plugin_Handled;
	}
	if (!LeaveTracking())
	{
		PrintToServer("PUGERR leave tracking is off");
		return Plugin_Handled;
	}
	char id[32];
	char verb[16];
	GetCmdArg(2, id, sizeof(id));
	GetCmdArg(3, verb, sizeof(verb));
	int slot = RosterIndexOfId(id);
	if (slot == -1)
	{
		PrintToServer("PUGERR not rostered");
		return Plugin_Handled;
	}
	bool absent = g_fAbsentSince[slot] > 0.0;
	char name[MAX_NAME_LENGTH];
	LeaveNameOf(slot, name, sizeof(name));

	if (StrEqual(verb, "hold"))
	{
		if (!absent)
		{
			PrintToServer("PUGERR not dropped");
			return Plugin_Handled;
		}
		if (g_fHoldSince[slot] <= 0.0)
		{
			LeaveHold(slot);
			PrintToChatAll("\x04[PUG]\x01 An admin put %s's reconnect clock on hold.", name);
		}
	}
	else if (StrEqual(verb, "release"))
	{
		if (g_fHoldSince[slot] > 0.0)
		{
			LeaveRelease(slot);
			int left = LeaveRemaining(slot);
			PrintToChatAll("\x04[PUG]\x01 %s's reconnect clock is running again (\x05%d:%02d\x01 left).", name, left / 60, left % 60);
		}
	}
	else if (StrEqual(verb, "add"))
	{
		if (args < 4)
		{
			PrintToServer("PUGERR usage: sm_pug_leave <token> <steamid64> hold|release|add <seconds>|end");
			return Plugin_Handled;
		}
		char buf[16];
		GetCmdArg(4, buf, sizeof(buf));
		int secs = StringToInt(buf);
		if (secs < 1 || secs > 3600)
		{
			PrintToServer("PUGERR bad seconds");
			return Plugin_Handled;
		}
		int room = 3600 - LeaveRemaining(slot);
		if (room <= 0)
		{
			PrintToServer("PUGERR allowance is already at its maximum");
			return Plugin_Handled;
		}
		if (secs > room) secs = room;
		g_fAbsentUsed[slot] -= float(secs);
		g_iLeaveWarned[slot] = 0;
		int left = LeaveRemaining(slot);
		PrintToChatAll("\x04[PUG]\x01 An admin gave %s more reconnect time (\x05%d:%02d\x01 left).", name, left / 60, left % 60);
	}
	else if (StrEqual(verb, "end"))
	{
		if (!absent)
		{
			PrintToServer("PUGERR not dropped");
			return Plugin_Handled;
		}
		g_fHoldSince[slot] = 0.0;
		g_fAbsentUsed[slot] = float(g_cvLeaveBudget.IntValue);
		g_fAbsentSince[slot] = GetEngineTime();
		PrintToChatAll("\x04[PUG]\x01 An admin ended %s's reconnect time.", name);
	}
	else
	{
		PrintToServer("PUGERR unknown action");
		return Plugin_Handled;
	}

	LeaveReply(slot);
	LeaveEmitState(slot, false);
	return Plugin_Handled;
}
```

- [ ] **Step 7: `LeaveStatus`**

Replace the body of `LeaveStatus`. The first line keeps its existing prefix byte for byte, because `statusShowsAbandoner` in `src/abandon.ts:33` matches on `STATUS leave abandoner=<id> `. New keys go at the END of both lines.

```sourcepawn
void LeaveStatus()
{
	DumpLine("STATUS leave abandoner=%s budget=%d autounpause=%d paused=%d holdmax=%d",
		g_sAbandoner[0] == '\0' ? "none" : g_sAbandoner,
		g_cvLeaveBudget.IntValue, g_cvLeaveAutoUnpause.IntValue, g_bLeavePaused ? 1 : 0,
		g_cvLeaveHoldMax.IntValue);
	for (int i = 0; i < g_iRosterCount; i++)
	{
		// != rather than <=: an admin add takes used below zero, and that slot
		// is exactly one worth seeing here.
		if (g_fAbsentUsed[i] == 0.0 && g_fAbsentSince[i] <= 0.0) continue;
		DumpLine("STATUS leave slot=%d steamid=%s absent=%d remaining=%d held=%d hold_left=%d",
			i, g_sRosterId[i], g_fAbsentSince[i] > 0.0 ? 1 : 0, LeaveRemaining(i),
			g_fHoldSince[i] > 0.0 ? 1 : 0, LeaveHoldLeft(i));
	}
}
```

- [ ] **Step 8: Run the parity test and watch it pass**

Run: `npx vitest run tests/leaveCommandParity.test.ts tests/abandon.test.ts`
Expected: PASS, both files.

- [ ] **Step 9: Compile clean**

Run: `cd /home/volence/l4d/pug/.claude/worktrees/admin-desks/plugin && ./build.sh`
Expected: ends with `built: /home/volence/l4d/pug/.claude/worktrees/admin-desks/plugin/pug-match.smx`, with no `error` and no `warning` naming `pug-leave.inc` or `pug-match.sp`.

This only runs the compiler under wine. It does not start, stop or contact any game server. The `.smx` is gitignored; do not stage it anywhere.

- [ ] **Step 10: Full suite, typecheck, commit**

Run: `npx vitest run && npm run typecheck`
Expected: green.

```bash
git add plugin/pug-match.sp plugin/pug-leave.inc tests/leaveCommandParity.test.ts
git commit -m "Let an admin hold, extend or end one player's reconnect clock from the server console"
```

---

### Task 2: Plugin docs, and the test the owner runs with a real client

**Files:**
- Modify: `plugin/README.md` (command table near line 52, cvar table near line 68, the live-view grammar block near line 100), `plugin/TESTING.md` (new section directly before `## Teardown`, near line 659)

**Interfaces:**
- Consumes: Task 1's command grammar, answers, cvar and log lines, exactly as written there.
- Produces: documentation only.

- [ ] **Step 1: README command table**

Add after the `sm_pug_setid` row:

```markdown
| `sm_pug_leave` | `<token> <steamid64> hold\|release\|add <seconds>\|end` | 0.3.4 and later. Admin control of one rostered player's reconnect allowance, sent by the website's live board. `hold` freezes it (dropped players only) until `release`, their return, or `sm_pug_leave_hold_max`; `release` is idempotent; `add` grants 1 to 3600 more seconds to anyone rostered, connected or not, capped so the allowance never exceeds an hour; `end` zeroes it so the ordinary ABANDON path fires within a second (dropped players only). Answers `PUGOK leave steamid=<id64> absent=<0\|1> remaining=<s> held=<0\|1> hold_left=<s>` or `PUGERR <reason>`, then echoes the state on the log stream. Backend matches only: refused with `PUGERR leave tracking is off` for a self-started match. |
```

Change the sentence under the table that begins "`sm_pug_dump` and `sm_pug_abort` both check `<token>`" so it opens "`sm_pug_dump`, `sm_pug_abort` and `sm_pug_leave` all check `<token>`".

- [ ] **Step 2: README cvar table**

Add three rows after `sm_pug_record_demos`. The first two exist today and were never listed.

```markdown
| `sm_pug_leave_budget` | `300` | Seconds each rostered player may spend disconnected over a whole backend match before it ends as an abandon. `0` disables leave tracking. The backend sets it at match setup from the `leave_budget_seconds` setting. |
| `sm_pug_leave_autounpause` | `1` | `1` unpauses on a 10 second countdown once every disconnected player is back. `0` makes both teams type `!ready`. Set at match setup from `leave_auto_unpause`. |
| `sm_pug_leave_hold_max` | `1800` | 0.3.4 and later. Longest an admin hold (`sm_pug_leave ... hold`) may freeze one player's allowance. The hold releases itself after this and says so, so a release that never arrives cannot pin a server paused. Set at match setup from `clock_hold_max_minutes`. Bounds 10 to 7200; the low bound exists so the ceiling can be tested in under a minute. |
```

- [ ] **Step 3: README wire grammar**

In the first fenced block under `### Live view: UDP logaddress lines`, add after the `PLAYER` line:

```
PUG <token> LEAVE steamid=<id64> remaining=<s> [held=0|1 hold_left=<s> auto=0|1]
PUG <token> RETURN steamid=<id64> remaining=<s>
PUG <token> ABANDON steamid=<id64>
```

And add this paragraph after the block's two existing bullet points:

```markdown
`LEAVE` is sent when a rostered player really disconnects, and again (0.3.4 and
later, with the bracketed keys) whenever an admin changes that player's clock
with `sm_pug_leave` or the hold ceiling releases it (`auto=1`). The bracketed
keys are optional on purpose: a backend older than the plugin ignores them, and
a plugin older than the backend never sends them. `RETURN` is also what
`sm_pug_leave ... add` echoes for a player who is connected.
```

- [ ] **Step 4: TESTING.md section**

Insert directly before `## Teardown (`sm_pug_abort <token> teardown <map>`)`:

````markdown
## Reconnect clock control (`sm_pug_leave`, 0.3.4)

There is no unit harness for SourcePawn in this repo, so this is the test for
the admin hold in `pug-leave.inc`. It needs one real client, and that client
can be you: you are the player who drops, and the rcon shell keeps working while
you are disconnected.

`T` below is any throwaway 32 hex token and `ME` is your SteamID64:

    T=$(openssl rand -hex 16); ME=76561198030413993

### A. Empty server: the command exists and refuses correctly

No client needed. Only with the server empty (`R status` shows 0 humans).

    R "sm_pug_match 999999 $T NoMercy"
    R "sm_pug_leave"
    R "sm_pug_leave 00000000000000000000000000000000 $ME hold"
    R "sm_pug_leave $T"
    R "sm_pug_leave $T $ME hold"
    R "sm_pug_leave_hold_max"
    R "sm_pug_status"
    R "sm_pug_abort $T"

- [ ] `PUGOK match=999999`: ____
- [ ] no arguments answers `PUGERR token required`: ____
- [ ] the wrong token answers `PUGERR bad token`: ____
- [ ] the token alone answers `PUGERR usage: sm_pug_leave ...`: ____
- [ ] an unrostered id answers `PUGERR not rostered`: ____
- [ ] the cvar prints `1800`: ____
- [ ] status has `STATUS leave abandoner=none ... holdmax=1800`: ____
- [ ] `PUGOK aborted`: ____

Hold, release and end need a rostered player who has actually dropped, so they
cannot be checked on an empty server. That is part B.

### B. Real client

Shorten both clocks first so the whole thing takes five minutes, not forty:

    R "sm_pug_match 999 $T no_mercy"
    R "sm_pug_roster \"$ME:a\""
    R "sm_pug_leave_budget 180"
    R "sm_pug_leave_hold_max 20"

Join the server. `R sm_pug_status` must show your slot with `connected=1`.
To watch the log lines, use the `nc -ul 27500` recipe from section 4.

1. **Pre-grant.** While connected: `R "sm_pug_leave $T $ME add 60"`.
   - [ ] `PUGOK leave steamid=... absent=0 remaining=240 held=0 hold_left=0`: ____
   - [ ] a `RETURN steamid=... remaining=240` line, and a chat line about more reconnect time: ____
2. **Hold is refused while connected.** `R "sm_pug_leave $T $ME hold"`.
   - [ ] `PUGERR not dropped`: ____
3. **Drop.** Disconnect from the game. Wait ten seconds.
   - [ ] status shows `absent=1 remaining=` near 230 and falling: ____
4. **Hold.** `R "sm_pug_leave $T $ME hold"`, then status twice, ten seconds apart.
   - [ ] `PUGOK ... absent=1 remaining=N held=1 hold_left=20`: ____
   - [ ] `remaining` is the SAME in both status reads: ____
   - [ ] a `LEAVE ... held=1 hold_left=... auto=0` line: ____
5. **The ceiling.** Wait until 25 seconds after the hold.
   - [ ] a `LEAVE ... held=0 hold_left=0 auto=1` line: ____
   - [ ] status shows `held=0` and `remaining` falling again: ____
6. **Release is idempotent.** `R "sm_pug_leave $T $ME release"` twice.
   - [ ] both answer `PUGOK ... held=0`: ____
7. **Hold across a map change.** `R "sm_pug_leave_hold_max 600"`, hold again, note `remaining`, then
   `R "changelevel l4d_hospital02_subway"`. After the map loads:
   - [ ] status still shows `held=1` and the same `remaining`: ____
   - [ ] the SourceMod error log has no `Invalid timer handle` or `Invalid Handle` from pug-match: ____
8. **Return while held.** Still held, join the server again.
   - [ ] chat says you are back; status shows `absent=0 held=0`: ____
   - [ ] `remaining` is what it was at the hold, not less: ____
9. **Match end while held.** Disconnect, hold, then `R "sm_pug_abort $T"`. Set the same match up again
   (`sm_pug_match`, `sm_pug_roster`).
   - [ ] status shows no `STATUS leave slot=` line at all: ____
10. **End now.** Join, disconnect, then `R "sm_pug_leave $T $ME end"`.
    - [ ] `PUGOK ... absent=1 remaining=0 held=0`: ____
    - [ ] within two seconds: the "did not reconnect in time" chat line and a `PUG ... ABANDON steamid=...` line: ____
    - [ ] status shows `STATUS leave abandoner=<your id>`: ____
    - [ ] a further `R "sm_pug_leave $T $ME add 60"` answers `PUGERR match already abandoned`: ____

Put everything back:

    R "sm_pug_abort $T"
    R "sm_pug_leave_budget 300"
    R "sm_pug_leave_hold_max 1800"
````

- [ ] **Step 5: Full suite, typecheck, commit**

Run: `npx vitest run && npm run typecheck`
Expected: green (docs only, nothing moves).

```bash
git add plugin/README.md plugin/TESTING.md
git commit -m "Document sm_pug_leave and write the test the owner runs with a real client"
```

---

### Task 3: The parser reads the hold state, and old lines still parse

**Files:**
- Create: `tests/leaveLineParse.test.ts`
- Modify: `src/logParse.ts:34` (the `leave` member of `LogEvent`), `src/logParse.ts:395-400` (the `LEAVE` / `RETURN` case), `tests/leaveCommandParity.test.ts` (one appended block)

**Interfaces:**
- Consumes: `parseLogDatagram(buf: Buffer): LogEvent | null`.
- Produces: `{ kind: 'leave'; token: string; steamid: string; remaining: number; held?: boolean; holdLeft?: number; auto?: boolean }`. The three optional keys are present only when the line carried them. `return` is unchanged.

- [ ] **Step 1: Write the failing test**

`tests/leaveLineParse.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { parseLogDatagram } from '../src/logParse.js';

const TOKEN = 'a'.repeat(32);
const ID = '76561199000000002';
const f = (l: string) => Buffer.concat([
  Buffer.from([0xff, 0xff, 0xff, 0xff, 0x52]), Buffer.from(`L 09/21/2026 - 20:00:00: ${l}\n\0`),
]);

describe('LEAVE with the 0.3.4 keys', () => {
  it('a 0.3.3 line parses to exactly what it always did', () => {
    expect(parseLogDatagram(f(`PUG ${TOKEN} LEAVE steamid=${ID} remaining=254`)))
      .toEqual({ kind: 'leave', token: TOKEN, steamid: ID, remaining: 254 });
  });

  it('reads a hold', () => {
    expect(parseLogDatagram(f(`PUG ${TOKEN} LEAVE steamid=${ID} remaining=200 held=1 hold_left=1800 auto=0`)))
      .toEqual({ kind: 'leave', token: TOKEN, steamid: ID, remaining: 200, held: true, holdLeft: 1800 });
  });

  it('reads the ceiling releasing a hold', () => {
    expect(parseLogDatagram(f(`PUG ${TOKEN} LEAVE steamid=${ID} remaining=200 held=0 hold_left=0 auto=1`)))
      .toEqual({ kind: 'leave', token: TOKEN, steamid: ID, remaining: 200, held: false, holdLeft: 0, auto: true });
  });

  it('a nonsense optional key costs the key, never the line', () => {
    expect(parseLogDatagram(f(`PUG ${TOKEN} LEAVE steamid=${ID} remaining=200 held=banana hold_left=-4 auto=yes`)))
      .toEqual({ kind: 'leave', token: TOKEN, steamid: ID, remaining: 200 });
  });

  it('RETURN is unchanged, extra keys and all', () => {
    expect(parseLogDatagram(f(`PUG ${TOKEN} RETURN steamid=${ID} remaining=200 held=1`)))
      .toEqual({ kind: 'return', token: TOKEN, steamid: ID, remaining: 200 });
  });
});
```

Append to `tests/leaveCommandParity.test.ts` (add `import { parseLogDatagram } from '../src/logParse.js';` to its imports):

```ts
/** printf the way SourcePawn would, for the two conversions these lines use. */
const render = (fmt: string, args: (string | number)[]): string => {
  let i = 0;
  return fmt.replace(/%[sd]/g, () => String(args[i++]));
};

describe('the state echo is a line the parser reads', () => {
  const fmt = leaveSrc.match(/EmitPug\(\s*"(LEAVE steamid=%s remaining=%d held=[^"]*)"/)?.[1] ?? '';

  it('finds the emit at all', () => {
    expect(fmt).toMatch(/^LEAVE /);
  });

  it('carries every key the parser reads, under the names it reads them by', () => {
    for (const key of ['steamid', 'remaining', 'held', 'hold_left', 'auto']) expect(fmt).toContain(`${key}=`);
    const line = `PUG ${'b'.repeat(32)} ${render(fmt, ['76561199000000002', 120, 1, 1500, 0])}`;
    expect(parseLogDatagram(Buffer.from(line, 'utf8')))
      .toEqual({ kind: 'leave', token: 'b'.repeat(32), steamid: '76561199000000002', remaining: 120, held: true, holdLeft: 1500 });
  });
});
```

- [ ] **Step 2: Run them and watch them fail**

Run: `npx vitest run tests/leaveLineParse.test.ts tests/leaveCommandParity.test.ts`
Expected: FAIL. `reads a hold`, `reads the ceiling releasing a hold` and the parity `carries every key` fail because the parsed object has no `held`. The 0.3.3 case and the RETURN case pass already.

- [ ] **Step 3: The event type**

`src/logParse.ts:34`, replace the `leave` member:

```ts
  // held, holdLeft and auto are pug-match 0.3.4 and later, sent when an admin
  // changes a dropped player's clock (sm_pug_leave) or the hold ceiling
  // releases it. Present only when the line carried them, so a 0.3.3 line
  // parses to exactly the object it always did.
  | { kind: 'leave'; token: string; steamid: string; remaining: number; held?: boolean; holdLeft?: number; auto?: boolean }
```

- [ ] **Step 4: The case**

`src/logParse.ts`, replace the `case 'LEAVE': case 'RETURN':` block:

```ts
    case 'LEAVE':
    case 'RETURN': {
      const remaining = intOf(rest.remaining);
      if (!/^\d{17}$/.test(rest.steamid ?? '') || remaining === null) return null;
      if (verb === 'RETURN') return { kind: 'return', token, steamid: rest.steamid, remaining };
      const ev: Extract<LogEvent, { kind: 'leave' }> = { kind: 'leave', token, steamid: rest.steamid, remaining };
      // A LEAVE starts the clock that ends a match, so an optional key this
      // parser cannot read costs the key and never the line.
      if (rest.held === '0' || rest.held === '1') ev.held = rest.held === '1';
      const holdLeft = intOf(rest.hold_left);
      if (holdLeft !== null && holdLeft >= 0) ev.holdLeft = holdLeft;
      if (rest.auto === '1') ev.auto = true;
      return ev;
    }
```

- [ ] **Step 5: Run and watch them pass**

Run: `npx vitest run tests/leaveLineParse.test.ts tests/leaveCommandParity.test.ts tests/abandon.test.ts tests/aliases.test.ts tests/logParse.test.ts`
Expected: PASS, all five.

- [ ] **Step 6: Full suite, typecheck, commit**

Run: `npx vitest run && npm run typecheck`
Expected: green.

```bash
git add src/logParse.ts tests/leaveLineParse.test.ts tests/leaveCommandParity.test.ts
git commit -m "Read the hold state off a LEAVE line, and keep old lines parsing as they did"
```

---

### Task 4: The presence table, the capability column, the two settings

**Files:**
- Create: `tests/presenceSchema.test.ts`
- Modify: `src/db.ts` (`DEFAULT_SETTINGS` near line 774; `openDb` directly before `seed(db);` near line 1018), `src/settingsSchema.ts` (after the `leave_auto_unpause` entry, line 52), `src/mergePlayers.ts` (`KEYED`, lines 54-62), `tests/mergePlayers.test.ts` (one new `it`)

**Interfaces:**
- Produces:
  - Table `match_presence (match_id, steamid, state, since, remaining_s, remaining_at, held, hold_until, low_alert_at, updated_at)`, primary key `(match_id, steamid)`.
  - Column `matches.leave_control INTEGER` (NULL unknown, 0 old plugin, 1 ok).
  - Settings `clock_hold_max_minutes` = `30` and `abandon_low_alert_seconds` = `90`.

- [ ] **Step 1: Write the failing test**

`tests/presenceSchema.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { openDb, type DB } from '../src/db.js';
import { getSetting } from '../src/settings.js';
import { validateSetting } from '../src/settingsSchema.js';

let db: DB;
beforeEach(() => { db = openDb(':memory:'); });

describe('match_presence', () => {
  it('has the columns the spec names, plus the hold and the two anchors', () => {
    const cols = (db.prepare('PRAGMA table_info(match_presence)').all() as { name: string }[]).map((c) => c.name);
    expect(cols).toEqual([
      'match_id', 'steamid', 'state', 'since', 'remaining_s', 'remaining_at',
      'held', 'hold_until', 'low_alert_at', 'updated_at',
    ]);
  });

  it('is one row per player per match', () => {
    db.prepare("INSERT INTO matches (id, season_id, state, campaign) VALUES (1, 1, 'live', 'dead_air')").run();
    const ins = db.prepare(
      "INSERT INTO match_presence (match_id, steamid, state, since, updated_at) VALUES (1, '76561199000000001', 'connected', 'x', 'x')",
    );
    ins.run();
    expect(() => ins.run()).toThrow(/UNIQUE|PRIMARY/);
  });

  it('does not reference players, so the merge foreign key audit stays honest', () => {
    const fks = db.prepare('PRAGMA foreign_key_list(match_presence)').all() as { table: string }[];
    expect(fks.map((f) => f.table)).toEqual(['matches']);
  });
});

describe('what came with it', () => {
  it('a match starts with an unknown plugin capability', () => {
    db.prepare("INSERT INTO matches (id, season_id, state, campaign) VALUES (1, 1, 'live', 'dead_air')").run();
    expect(db.prepare('SELECT leave_control FROM matches WHERE id = 1').get()).toEqual({ leave_control: null });
  });

  it('seeds and validates the two clock settings', () => {
    expect(getSetting(db, 'clock_hold_max_minutes')).toBe('30');
    expect(getSetting(db, 'abandon_low_alert_seconds')).toBe('90');
    expect(validateSetting('clock_hold_max_minutes', '45')).toEqual({ ok: true, value: '45' });
    expect(validateSetting('clock_hold_max_minutes', '0').ok).toBe(false);
    expect(validateSetting('clock_hold_max_minutes', '121').ok).toBe(false);
    expect(validateSetting('abandon_low_alert_seconds', '0')).toEqual({ ok: true, value: '0' });
    expect(validateSetting('abandon_low_alert_seconds', '601').ok).toBe(false);
  });
});
```

Add to `tests/mergePlayers.test.ts`, directly after the `handles every foreign key that points at players` test, using that file's existing `match` and `rosters` helpers and `MAIN` / `ALT` constants:

```ts
  it('carries a live presence row over to the surviving account', () => {
    match(1, 'live');
    rosters(1, ALT, 'a');
    db.prepare(
      "INSERT INTO match_presence (match_id, steamid, state, since, updated_at) VALUES (1, ?, 'dropped', '2026-09-21T20:00:00.000Z', '2026-09-21T20:00:00.000Z')",
    ).run(ALT);

    mergePlayers(db, { from: ALT, into: MAIN });

    expect(db.prepare('SELECT steamid FROM match_presence WHERE match_id = 1').all()).toEqual([{ steamid: MAIN }]);
  });
```

- [ ] **Step 2: Run them and watch them fail**

Run: `npx vitest run tests/presenceSchema.test.ts tests/mergePlayers.test.ts`
Expected: FAIL. `no such table: match_presence`, `no such column: leave_control`, and the two settings are `undefined`.

- [ ] **Step 3: The table and the column**

`src/db.ts`, in `openDb`, immediately before `seed(db);`:

```ts
  // Who is on the game server right now, one row per rostered player, written
  // from PLAYER connect, LEAVE and RETURN and from the plugin's own answer to
  // an admin clock action (src/presence.ts). `since` is when the current state
  // began. `remaining_s` is the reconnect allowance as of `remaining_at`,
  // which is a different instant after a hold, a release or an add, so the two
  // cannot share a column. `low_alert_at` is what makes the admin feed warning
  // once per drop, and what stops a restart from posting it again.
  // No CHECK on state, and steamid is deliberately not a foreign key: the
  // roster check happens at write time, against match_players.
  db.exec(`CREATE TABLE IF NOT EXISTS match_presence (
    match_id INTEGER NOT NULL REFERENCES matches(id),
    steamid TEXT NOT NULL,
    state TEXT NOT NULL,
    since TEXT NOT NULL,
    remaining_s INTEGER,
    remaining_at TEXT,
    held INTEGER NOT NULL DEFAULT 0,
    hold_until TEXT,
    low_alert_at TEXT,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (match_id, steamid)
  )`);
  // Whether this match's server understands sm_pug_leave (pug-match 0.3.4).
  // NULL until something has asked: the setup path learns it for free from the
  // reply to the hold ceiling cvar, and an action learns it from its own answer.
  ensureColumn(db, 'matches', 'leave_control', 'INTEGER');
```

- [ ] **Step 4: The two settings**

`src/db.ts`, in `DEFAULT_SETTINGS`, directly after `leave_auto_unpause: '1',`:

```ts
  // The longest an admin may hold a clock from the live board, and how much
  // of a dropped player's allowance is left when the admin feed says so.
  clock_hold_max_minutes: '30',
  abandon_low_alert_seconds: '90',
```

`src/settingsSchema.ts`, directly after the `leave_auto_unpause` entry:

```ts
  { key: 'clock_hold_max_minutes', group: 'Match', label: 'Longest clock hold (minutes)', help: 'How long an admin can hold a clock from the live board before it releases itself and says so in the admin feed. The game server enforces the same ceiling on its own, so a lost release cannot leave a match paused for ever. Applies from the next match.', type: { kind: 'int', min: 1, max: 120 } },
  { key: 'abandon_low_alert_seconds', group: 'Match', label: 'Low reconnect time warning (seconds)', help: 'When a disconnected player has this much reconnect time left, the admin feed says so once, with a link to the live board. 0 turns the warning off.', type: { kind: 'int', min: 0, max: 600 } },
```

- [ ] **Step 5: The merge**

`src/mergePlayers.ts`, in `KEYED`, after the `match_readyup_players` line:

```ts
  // Live scratch, like the rows above: if both accounts somehow have a row in
  // one match, the survivor's is as good as the one dropped.
  ['match_presence', 'steamid'],
```

- [ ] **Step 6: Run and watch them pass**

Run: `npx vitest run tests/presenceSchema.test.ts tests/mergePlayers.test.ts tests/adminSettings.test.ts tests/db.test.ts`
Expected: PASS.

- [ ] **Step 7: Full suite, typecheck, commit**

Run: `npx vitest run && npm run typecheck`
Expected: green.

```bash
git add src/db.ts src/settingsSchema.ts src/mergePlayers.ts tests/presenceSchema.test.ts tests/mergePlayers.test.ts
git commit -m "Add the match presence table, the plugin capability column and the two clock settings"
```

---

### Task 5: Presence, written from the log stream

**Files:**
- Create: `src/presence.ts`, `tests/presence.test.ts`, `tests/presenceWiring.test.ts`
- Modify: `src/server.ts` (imports near line 68; a new branch directly after the `abandon` branch, lines 629-640; the `player` connect branch, line 708-709)

**Interfaces:**
- Consumes: `LogEvent` from `src/logParse.ts` (Task 3), `getSetting(db, key)` from `src/settings.ts`, `hub.broadcast(event)`.
- Produces, all in `src/presence.ts`:

```ts
export interface PresenceRow {
  match_id: number; steamid: string; state: 'connected' | 'dropped';
  since: string; remaining_s: number | null; remaining_at: string | null;
  held: number; hold_until: string | null; low_alert_at: string | null; updated_at: string;
}
export interface LeaveState { absent: boolean; remaining: number; held: boolean; holdLeft: number | null }
export interface PresenceChange { matchId: number; changed: boolean; holdReleased: boolean }
export function holdMaxSeconds(db: DB): number;
export function lowAlertSeconds(db: DB): number;
export function ongoingMatchIdOf(db: DB, token: string): number | null;
export function isRostered(db: DB, matchId: number, steamid: string): boolean;
export function getPresence(db: DB, matchId: number, steamid: string): PresenceRow | undefined;
export function remainingNow(row: Pick<PresenceRow, 'state' | 'remaining_s' | 'remaining_at' | 'held'>, now: Date): number | null;
export function applyLeaveState(db: DB, matchId: number, steamid: string, s: LeaveState, now?: Date): PresenceChange | null;
export function applyConnect(db: DB, matchId: number, steamid: string, now?: Date): PresenceChange | null;
export type PresenceLine = Extract<LogEvent, { kind: 'leave' | 'return' | 'player' }>;
export function recordPresenceLine(db: DB, ev: PresenceLine, now?: Date): PresenceChange | null;
```

`null` from any of the last three means "ignored": no such ongoing match, or the id is not on its roster.

- [ ] **Step 1: Write the failing unit test**

`tests/presence.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { openDb, type DB } from '../src/db.js';
import { upsertPlayer, activatePlayer } from '../src/players.js';
import { setSetting } from '../src/settings.js';
import { getPresence, recordPresenceLine, remainingNow } from '../src/presence.js';

const IDS = Array.from({ length: 8 }, (_, i) => `7656119900000000${i}`);
const STRANGER = '76561199000000099';
const TOKEN = 'a'.repeat(32);
const at = (s: number) => new Date(Date.UTC(2026, 8, 21, 20, 0, s));
let db: DB;
let matchId: number;

beforeEach(() => {
  db = openDb(':memory:');
  for (const p of [...IDS, STRANGER]) { upsertPlayer(db, { steamid: p, name: `p${p.slice(-2)}`, avatar: null }, []); activatePlayer(db, p); }
  matchId = Number(db.prepare("INSERT INTO matches (season_id, state, campaign, token) VALUES (1, 'live', 'dead_air', ?)").run(TOKEN).lastInsertRowid);
  const ins = db.prepare('INSERT INTO match_players (match_id, player_id, team) VALUES (?, ?, ?)');
  IDS.forEach((p, i) => ins.run(matchId, p, i < 4 ? 'a' : 'b'));
});

const leave = (remaining: number, extra: object = {}) => ({ kind: 'leave' as const, token: TOKEN, steamid: IDS[2], remaining, ...extra });
const back = (remaining: number) => ({ kind: 'return' as const, token: TOKEN, steamid: IDS[2], remaining });
const player = (event: 'connect' | 'disconnect', steamid = IDS[2]) => ({ kind: 'player' as const, token: TOKEN, steamid, event });
const row = () => getPresence(db, matchId, IDS[2])!;

describe('LEAVE, RETURN and connect', () => {
  it('a connect makes a connected row, and the map change pulse changes nothing', () => {
    expect(recordPresenceLine(db, player('connect'), at(0))).toMatchObject({ changed: true });
    expect(row()).toMatchObject({ state: 'connected', since: at(0).toISOString(), remaining_s: null, held: 0 });
    expect(recordPresenceLine(db, player('disconnect'), at(30))).toBeNull();
    expect(recordPresenceLine(db, player('connect'), at(60))).toMatchObject({ changed: false });
    expect(row().since).toBe(at(0).toISOString());
  });

  it('a LEAVE drops them with the allowance, and it counts down from there', () => {
    recordPresenceLine(db, player('connect'), at(0));
    recordPresenceLine(db, leave(300), at(10));
    expect(row()).toMatchObject({ state: 'dropped', since: at(10).toISOString(), remaining_s: 300, remaining_at: at(10).toISOString(), held: 0 });
    expect(remainingNow(row(), at(40))).toBe(270);
    expect(remainingNow(row(), at(999))).toBe(0);
  });

  it('a RETURN brings them back with what is left', () => {
    recordPresenceLine(db, leave(300), at(10));
    recordPresenceLine(db, back(254), at(56));
    expect(row()).toMatchObject({ state: 'connected', since: at(56).toISOString(), remaining_s: 254, held: 0, hold_until: null });
    expect(remainingNow(row(), at(500))).toBe(254);
  });

  it('a connect with the RETURN lost still brings them back, with the arithmetic done here', () => {
    recordPresenceLine(db, leave(300), at(10));
    recordPresenceLine(db, player('connect'), at(40));
    expect(row()).toMatchObject({ state: 'connected', remaining_s: 270 });
  });

  it('a duplicated datagram is not a change and does not move the anchor', () => {
    recordPresenceLine(db, leave(300), at(10));
    expect(recordPresenceLine(db, leave(300), at(13))).toMatchObject({ changed: false });
    expect(row().remaining_at).toBe(at(10).toISOString());
  });
});

describe('a hold', () => {
  it('stops the countdown, keeps when they left, and knows when it ends', () => {
    recordPresenceLine(db, leave(300), at(10));
    recordPresenceLine(db, leave(260, { held: true, holdLeft: 1800 }), at(50));
    expect(row()).toMatchObject({
      state: 'dropped', since: at(10).toISOString(), remaining_s: 260, held: 1,
      hold_until: new Date(at(50).getTime() + 1800_000).toISOString(),
    });
    expect(remainingNow(row(), at(59))).toBe(260);
  });

  it('falls back to the setting when the line gives no hold_left', () => {
    setSetting(db, 'clock_hold_max_minutes', '10');
    recordPresenceLine(db, leave(260, { held: true }), at(50));
    expect(row().hold_until).toBe(new Date(at(50).getTime() + 600_000).toISOString());
  });

  it('a release resumes from the moment of the release, and reports the transition', () => {
    recordPresenceLine(db, leave(260, { held: true, holdLeft: 1800 }), at(50));
    expect(recordPresenceLine(db, leave(260, { held: false, holdLeft: 0, auto: true }), at(59)))
      .toEqual({ matchId, changed: true, holdReleased: true });
    expect(row()).toMatchObject({ held: 0, hold_until: null, remaining_at: at(59).toISOString() });
    expect(remainingNow(row(), at(69))).toBe(250);
  });

  it('keeps the once per drop alert stamp across a hold, and clears it on the next drop', () => {
    recordPresenceLine(db, leave(80), at(10));
    db.prepare('UPDATE match_presence SET low_alert_at = ? WHERE match_id = ?').run(at(11).toISOString(), matchId);
    recordPresenceLine(db, leave(79, { held: true, holdLeft: 1800 }), at(12));
    expect(row().low_alert_at).toBe(at(11).toISOString());
    recordPresenceLine(db, back(79), at(20));
    recordPresenceLine(db, leave(79), at(30));
    expect(row().low_alert_at).toBeNull();
  });
});

describe('what is ignored', () => {
  it('an id that is not on the roster', () => {
    expect(recordPresenceLine(db, { ...leave(300), steamid: STRANGER }, at(10))).toBeNull();
    expect(getPresence(db, matchId, STRANGER)).toBeUndefined();
  });

  it('a token with no ongoing match', () => {
    db.prepare("UPDATE matches SET state = 'completed' WHERE id = ?").run(matchId);
    expect(recordPresenceLine(db, leave(300), at(10))).toBeNull();
  });

  it('a configuring match counts as ongoing', () => {
    db.prepare("UPDATE matches SET state = 'configuring' WHERE id = ?").run(matchId);
    expect(recordPresenceLine(db, player('connect'), at(0))).toMatchObject({ changed: true });
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run tests/presence.test.ts`
Expected: FAIL, cannot resolve `../src/presence.js`.

- [ ] **Step 3: Write `src/presence.ts`**

```ts
import type { DB } from './db.js';
import type { LogEvent } from './logParse.js';
import { getSetting } from './settings.js';

/**
 * Who is on the game server, per rostered player of an ongoing match.
 *
 * Three writers feed one table: PLAYER connect, the LEAVE and RETURN lines of
 * plugin/pug-leave.inc, and the plugin's own rcon answer to an admin clock
 * action (src/leaveControl.ts). The last one exists because the log stream is
 * lossy UDP and a Hold the admin just pressed must show as held whether or not
 * its echo arrives; when the echo does arrive it says the same thing and is a
 * no-op here.
 *
 * PLAYER disconnect is deliberately not a writer. The plugin pulses disconnect
 * then connect for every client on every changelevel, and a real departure
 * already has its own line (LEAVE, from the engine's player_disconnect event).
 * Believing the pulse would flash all eight players as dropped on every map
 * load, on the one screen that exists to show who is really missing.
 */

export interface PresenceRow {
  match_id: number;
  steamid: string;
  state: 'connected' | 'dropped';
  /** When the current state began, ISO. */
  since: string;
  /** The reconnect allowance as of remaining_at. Null until the plugin has
   *  said anything about this player's clock. */
  remaining_s: number | null;
  remaining_at: string | null;
  held: number;
  hold_until: string | null;
  low_alert_at: string | null;
  updated_at: string;
}

/** What the plugin says about one player's clock, from a line or an answer. */
export interface LeaveState {
  absent: boolean;
  remaining: number;
  held: boolean;
  /** Seconds until the plugin's own ceiling releases the hold. Null when the
   *  source did not say, and then the setting stands in. */
  holdLeft: number | null;
}

export interface PresenceChange {
  matchId: number;
  /** False for a repeat of what the table already says: no write happened. */
  changed: boolean;
  /** A dropped player's hold ended while they are still dropped. */
  holdReleased: boolean;
}

/** Same emptiness rule as noShow.ts: Number('') is 0, and a blank row must
 *  read as the default, not as zero. */
function num(db: DB, key: string, fallback: number): number {
  const value = getSetting(db, key);
  if (value === undefined || value.trim() === '') return fallback;
  const raw = Number(value);
  return Number.isFinite(raw) ? raw : fallback;
}

export const holdMaxSeconds = (db: DB): number => Math.max(60, num(db, 'clock_hold_max_minutes', 30) * 60);
export const lowAlertSeconds = (db: DB): number => Math.max(0, num(db, 'abandon_low_alert_seconds', 90));

export function ongoingMatchIdOf(db: DB, token: string): number | null {
  const row = db.prepare("SELECT id FROM matches WHERE token = ? AND state IN ('configuring', 'live')")
    .get(token) as { id: number } | undefined;
  return row?.id ?? null;
}

export function isRostered(db: DB, matchId: number, steamid: string): boolean {
  return db.prepare('SELECT 1 FROM match_players WHERE match_id = ? AND player_id = ?').get(matchId, steamid) !== undefined;
}

export function getPresence(db: DB, matchId: number, steamid: string): PresenceRow | undefined {
  return db.prepare('SELECT * FROM match_presence WHERE match_id = ? AND steamid = ?').get(matchId, steamid) as PresenceRow | undefined;
}

/** The allowance right now. It only runs down for someone who is dropped and
 *  not held; for anyone else the stored figure IS the figure. */
export function remainingNow(
  row: Pick<PresenceRow, 'state' | 'remaining_s' | 'remaining_at' | 'held'>, now: Date,
): number | null {
  if (row.remaining_s === null) return null;
  if (row.state !== 'dropped' || row.held === 1 || row.remaining_at === null) return row.remaining_s;
  const spent = Math.floor((now.getTime() - Date.parse(row.remaining_at)) / 1000);
  return Math.max(0, row.remaining_s - Math.max(0, spent));
}

function write(db: DB, r: PresenceRow): void {
  db.prepare(
    `INSERT INTO match_presence
       (match_id, steamid, state, since, remaining_s, remaining_at, held, hold_until, low_alert_at, updated_at)
     VALUES (@match_id, @steamid, @state, @since, @remaining_s, @remaining_at, @held, @hold_until, @low_alert_at, @updated_at)
     ON CONFLICT (match_id, steamid) DO UPDATE SET
       state = excluded.state, since = excluded.since, remaining_s = excluded.remaining_s,
       remaining_at = excluded.remaining_at, held = excluded.held, hold_until = excluded.hold_until,
       low_alert_at = excluded.low_alert_at, updated_at = excluded.updated_at`,
  ).run(r);
}

/** Take the plugin's word for one player's clock. Null when they are not on
 *  this match's roster, which writes nothing. */
export function applyLeaveState(
  db: DB, matchId: number, steamid: string, s: LeaveState, now = new Date(),
): PresenceChange | null {
  if (!isRostered(db, matchId, steamid)) return null;
  const prev = getPresence(db, matchId, steamid);
  const state = s.absent ? 'dropped' : 'connected';
  const held = s.absent && s.held ? 1 : 0;
  // A duplicated datagram, or the echo of an answer already applied. Skipped
  // outright rather than rewritten, because rewriting would move remaining_at
  // later and make the countdown lag by however late the repeat was.
  if (prev && prev.state === state && prev.remaining_s === s.remaining && prev.held === held) {
    return { matchId, changed: false, holdReleased: false };
  }
  const iso = now.toISOString();
  const sameState = prev !== undefined && prev.state === state;
  write(db, {
    match_id: matchId,
    steamid,
    state,
    since: sameState ? prev.since : iso,
    remaining_s: s.remaining,
    remaining_at: iso,
    held,
    hold_until: held ? new Date(now.getTime() + (s.holdLeft ?? holdMaxSeconds(db)) * 1000).toISOString() : null,
    // Once per drop: kept while the same drop goes on, whatever is held or
    // added, and cleared by the next drop or by coming back.
    low_alert_at: sameState && state === 'dropped' ? prev.low_alert_at : null,
    updated_at: iso,
  });
  return {
    matchId,
    changed: true,
    holdReleased: prev !== undefined && prev.state === 'dropped' && prev.held === 1 && state === 'dropped' && held === 0,
  };
}

/** PLAYER connect: they are in game. Carries no allowance figure, so when the
 *  RETURN that normally follows is lost, the arithmetic is done here. */
export function applyConnect(db: DB, matchId: number, steamid: string, now = new Date()): PresenceChange | null {
  if (!isRostered(db, matchId, steamid)) return null;
  const prev = getPresence(db, matchId, steamid);
  if (prev?.state === 'connected') return { matchId, changed: false, holdReleased: false };
  const iso = now.toISOString();
  const left = prev ? remainingNow(prev, now) : null;
  write(db, {
    match_id: matchId, steamid, state: 'connected', since: iso,
    remaining_s: left, remaining_at: left === null ? null : iso,
    held: 0, hold_until: null, low_alert_at: null, updated_at: iso,
  });
  return { matchId, changed: true, holdReleased: false };
}

export type PresenceLine = Extract<LogEvent, { kind: 'leave' | 'return' | 'player' }>;

/** One log line, already canonicalised. Null when it is ignored: no ongoing
 *  match for the token, an id off the roster, or a PLAYER disconnect. */
export function recordPresenceLine(db: DB, ev: PresenceLine, now = new Date()): PresenceChange | null {
  const matchId = ongoingMatchIdOf(db, ev.token);
  if (matchId === null) return null;
  if (ev.kind === 'player') return ev.event === 'connect' ? applyConnect(db, matchId, ev.steamid, now) : null;
  if (ev.kind === 'return') {
    return applyLeaveState(db, matchId, ev.steamid, { absent: false, remaining: ev.remaining, held: false, holdLeft: null }, now);
  }
  return applyLeaveState(db, matchId, ev.steamid, {
    absent: true, remaining: ev.remaining, held: ev.held === true, holdLeft: ev.holdLeft ?? null,
  }, now);
}
```

- [ ] **Step 4: Run and watch it pass**

Run: `npx vitest run tests/presence.test.ts`
Expected: PASS.

- [ ] **Step 5: Write the failing wiring test**

`tests/presenceWiring.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import dgram from 'node:dgram';
import type { AddressInfo } from 'node:net';
import type { FastifyInstance } from 'fastify';
import { openDb, type DB } from '../src/db.js';
import { loadConfig } from '../src/config.js';
import { buildServer } from '../src/server.js';
import { upsertPlayer } from '../src/players.js';
import { Hub } from '../src/ws.js';
import { getPresence } from '../src/presence.js';

const P1 = '76561198000000001';
const TOKEN = '0123456789abcdef0123456789abcdef';

function freeUdpPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = dgram.createSocket('udp4');
    s.on('error', reject);
    s.bind(0, '127.0.0.1', () => {
      const { port } = s.address() as AddressInfo;
      s.close(() => resolve(port));
    });
  });
}

function send(port: number, body: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const c = dgram.createSocket('udp4');
    const text = Buffer.from(`L 09/21/2026 - 20:00:00: ${body}\n`, 'utf8');
    const pkt = Buffer.concat([Buffer.from([0xff, 0xff, 0xff, 0xff, 0x52]), text]);
    c.send(pkt, port, '127.0.0.1', (err) => { c.close(); err ? reject(err) : resolve(); });
  });
}

const settle = () => new Promise((r) => setTimeout(r, 80));

let db: DB;
let app: FastifyInstance | null = null;
let heard: string[];
let port: number;

beforeEach(async () => {
  db = openDb(':memory:');
  upsertPlayer(db, { steamid: P1, name: 'alice', avatar: null }, []);
  // Before buildServer: the listener re-registers the tokens of matches that
  // are already live when it starts.
  db.prepare("INSERT INTO matches (id, season_id, state, campaign, token) VALUES (7, 1, 'live', 'dead_air', ?)").run(TOKEN);
  db.prepare("INSERT INTO match_players (match_id, player_id, team) VALUES (7, ?, 'a')").run(P1);
  heard = [];
  const hub = new Hub();
  hub.subscribe((e) => heard.push(e));
  port = await freeUdpPort();
  app = await buildServer({
    config: { ...loadConfig({}), devMode: false, logListenPort: port }, db, hub,
    serverExec: async () => {}, serverCleaner: async () => {},
  });
});
afterEach(async () => { await app?.close(); app = null; });

describe('presence, from the UDP socket to the table', () => {
  it('a LEAVE drops the player and tells every open board', async () => {
    await send(port, `PUG ${TOKEN} LEAVE steamid=${P1} remaining=300`);
    await settle();
    expect(getPresence(db, 7, P1)).toMatchObject({ state: 'dropped', remaining_s: 300, held: 0 });
    expect(heard).toContain('refresh');
  });

  it('a held LEAVE and then a RETURN', async () => {
    await send(port, `PUG ${TOKEN} LEAVE steamid=${P1} remaining=200 held=1 hold_left=1800 auto=0`);
    await settle();
    expect(getPresence(db, 7, P1)).toMatchObject({ state: 'dropped', held: 1 });
    await send(port, `PUG ${TOKEN} RETURN steamid=${P1} remaining=200`);
    await settle();
    expect(getPresence(db, 7, P1)).toMatchObject({ state: 'connected', remaining_s: 200, held: 0 });
  });

  it('a first connect makes them present and still stamps connected_at', async () => {
    await send(port, `PUG ${TOKEN} PLAYER steamid=${P1} event=connect`);
    await settle();
    expect(getPresence(db, 7, P1)).toMatchObject({ state: 'connected' });
    expect((db.prepare('SELECT connected_at FROM match_players WHERE match_id = 7').get() as { connected_at: string | null }).connected_at).not.toBeNull();
    expect(heard).toContain('refresh');
  });
});
```

- [ ] **Step 6: Run it and watch it fail**

Run: `npx vitest run tests/presenceWiring.test.ts`
Expected: FAIL. The rows are `undefined`, because nothing in `src/server.ts` consumes `leave` or `return`, and `heard` has no `refresh`.

- [ ] **Step 7: Wire it into the log dispatch**

`src/server.ts`, add to the imports beside `./noShow.js`:

```ts
import { recordPresenceLine } from './presence.js';
```

Directly after the closing `}` of the `if (ev.kind === 'abandon') { ... }` branch and before `if (ev.kind === 'problem') {`:

```ts
        if (ev.kind === 'leave' || ev.kind === 'return') {
          // The live board's view of who is missing. Guarded like everything
          // here that is not the result path: a database error must not take
          // down the listener that also carries match_end.
          try {
            const change = recordPresenceLine(deps.db, ev);
            if (change?.changed) hub.broadcast('refresh');
          } catch (err) {
            console.error('[presence] failed to record', ev.kind, err);
          }
          return;
        }
```

In the spectator feed block, in the `else if (ev.kind === 'player' && ev.event === 'connect') {` branch, directly after `recordPlayerConnect(deps.db, ev.token, ev.steamid);`:

```ts
            // A 'refresh' on top of the 'live' every feed line ends with: the
            // admin board listens for refresh only, because 'live' fires ten
            // times a second. Only a real change, so the connect pulse of a map
            // change wakes nobody.
            if (recordPresenceLine(deps.db, ev)?.changed) hub.broadcast('refresh');
```

- [ ] **Step 8: Run and watch it pass**

Run: `npx vitest run tests/presenceWiring.test.ts tests/presence.test.ts tests/steamSignalsWiring.test.ts`
Expected: PASS.

- [ ] **Step 9: Full suite, typecheck, commit**

Run: `npx vitest run && npm run typecheck`
Expected: green.

```bash
git add src/presence.ts src/server.ts tests/presence.test.ts tests/presenceWiring.test.ts
git commit -m "Record who is on the server from LEAVE, RETURN and PLAYER connect"
```

---

### Task 6: The clock action, over RCON, believing only the plugin's answer

**Files:**
- Create: `src/leaveControl.ts`, `tests/leaveControl.test.ts`, `tests/adminLive.test.ts`
- Modify: `src/orchestrator.ts:168-169` (push the ceiling, record capability), `src/server.ts` (`ServerDeps` near line 127; the `adminRoutes` registration near line 1077), `src/routes/admin.ts` (`AdminRouteOpts` lines 33-60; destructuring line 65; a new route directly after the `/api/admin/matches/:id/void` route, near line 310), `tests/orchestrator.test.ts` (the local `fakeServer`, lines 19-52; the first test; one new test), `tests/leaveCommandParity.test.ts` (one appended block), `src/discord/adminFeedPoster.ts` (`actionText`), `tests/discordAdminFeed.test.ts` (one new `it`)

**Interfaces:**
- Consumes: `applyLeaveState`, `isRostered`, `LeaveState` (Task 5); `getServer(db, id): ServerRow | undefined`; `logAdmin(db, adminId, action, target, detail)`; `RconClient` as `RealRcon`.
- Produces, in `src/leaveControl.ts`:

```ts
export type ServerQuery = (server: ServerRow, command: string) => Promise<string>;
export const LEAVE_ACTIONS = ['hold', 'release', 'add', 'end'] as const;
export type LeaveAction = typeof LEAVE_ACTIONS[number];
export const LEAVE_ADD_MAX_S = 3600;
export const OLD_PLUGIN_ERROR: string;
export function leaveCommand(token: string, steamid: string, action: LeaveAction, seconds?: number): string;
export type LeaveReply =
  | { ok: true; line: string; steamid: string; state: LeaveState }
  | { ok: false; oldPlugin: boolean; error: string };
export function parseLeaveReply(body: string): LeaveReply;
export function isUnknownCommand(body: string): boolean;
```

- Produces, HTTP:
  - `POST /api/admin/live/:matchId/players/:steamid/leave`, body `{ action: 'hold' | 'release' | 'add' | 'end', seconds?: number }`, admin only.
  - 200 `{ ok: true, reply: string, state: LeaveState }`.
  - Errors: 400 bad body; 403 not admin; 404 no such match or not on its roster; 409 `{ error, code: 'old_plugin' | 'refused' }` or the match is not ongoing or has no server; 502 the server could not be reached; 503 no `serverQuery`.
- Produces, deps: `ServerDeps.serverQuery?: ServerQuery` and `AdminRouteOpts.serverQuery?: ServerQuery`.
- Produces, audit: action `leave_clock`, target the player's steamid, detail `{ matchId, action, seconds?, ok, remaining?, held?, error? }`.

- [ ] **Step 1: Write the failing unit test**

`tests/leaveControl.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { isUnknownCommand, leaveCommand, parseLeaveReply, OLD_PLUGIN_ERROR } from '../src/leaveControl.js';

const TOKEN = 'a'.repeat(32);
const ID = '76561199000000002';

describe('leaveCommand', () => {
  it('builds the four console lines', () => {
    expect(leaveCommand(TOKEN, ID, 'hold')).toBe(`sm_pug_leave ${TOKEN} ${ID} hold`);
    expect(leaveCommand(TOKEN, ID, 'release')).toBe(`sm_pug_leave ${TOKEN} ${ID} release`);
    expect(leaveCommand(TOKEN, ID, 'add', 300)).toBe(`sm_pug_leave ${TOKEN} ${ID} add 300`);
    expect(leaveCommand(TOKEN, ID, 'end')).toBe(`sm_pug_leave ${TOKEN} ${ID} end`);
  });

  it('refuses anything that could end the command early', () => {
    expect(() => leaveCommand('nope', ID, 'hold')).toThrow(/token/);
    expect(() => leaveCommand(TOKEN, `${ID}; quit`, 'hold')).toThrow(/steamid/);
    expect(() => leaveCommand(TOKEN, ID, 'add')).toThrow(/seconds/);
    expect(() => leaveCommand(TOKEN, ID, 'add', 0)).toThrow(/seconds/);
    expect(() => leaveCommand(TOKEN, ID, 'add', 3601)).toThrow(/seconds/);
    expect(() => leaveCommand(TOKEN, ID, 'add', 1.5)).toThrow(/seconds/);
  });
});

describe('parseLeaveReply', () => {
  it('reads a held player', () => {
    expect(parseLeaveReply(`PUGOK leave steamid=${ID} absent=1 remaining=200 held=1 hold_left=1800\n`)).toEqual({
      ok: true, line: `PUGOK leave steamid=${ID} absent=1 remaining=200 held=1 hold_left=1800`, steamid: ID,
      state: { absent: true, remaining: 200, held: true, holdLeft: 1800 },
    });
  });

  it('reads a connected player who was given time, with other console text around it', () => {
    const body = `L 09/21/2026 - 20:00:00: rcon from "1.2.3.4"\nPUGOK leave steamid=${ID} absent=0 remaining=600 held=0 hold_left=0\njunk`;
    expect(parseLeaveReply(body)).toMatchObject({ ok: true, state: { absent: false, remaining: 600, held: false, holdLeft: null } });
  });

  it('passes a refusal through in the plugin\'s words', () => {
    expect(parseLeaveReply('PUGERR not dropped\n')).toEqual({ ok: false, oldPlugin: false, error: 'not dropped' });
    expect(parseLeaveReply('PUGERR bad token')).toEqual({ ok: false, oldPlugin: false, error: 'bad token' });
  });

  it('knows a plugin older than 0.3.4 when it sees one', () => {
    expect(parseLeaveReply('Unknown command "sm_pug_leave"\n')).toEqual({ ok: false, oldPlugin: true, error: OLD_PLUGIN_ERROR });
    expect(isUnknownCommand('Unknown command "sm_pug_leave_hold_max"')).toBe(true);
    expect(isUnknownCommand('')).toBe(false);
  });

  it('assumes nothing from silence or from a half line', () => {
    expect(parseLeaveReply('')).toEqual({ ok: false, oldPlugin: false, error: 'no answer' });
    expect(parseLeaveReply(`PUGOK leave steamid=${ID} absent=1`)).toMatchObject({ ok: false, oldPlugin: false });
  });
});
```

Append to `tests/leaveCommandParity.test.ts` (add `import { parseLeaveReply } from '../src/leaveControl.js';` to its imports; `render` exists from Task 3):

```ts
describe('the rcon answer is one the backend reads', () => {
  const fmt = leaveSrc.match(/PrintToServer\(\s*"(PUGOK leave [^"]*)"/)?.[1] ?? '';

  it('finds the answer at all', () => {
    expect(fmt).toMatch(/^PUGOK leave steamid=%s /);
  });

  it('round trips', () => {
    expect(parseLeaveReply(render(fmt, ['76561199000000002', 1, 142, 1, 900]))).toMatchObject({
      ok: true, steamid: '76561199000000002', state: { absent: true, remaining: 142, held: true, holdLeft: 900 },
    });
  });
});
```

- [ ] **Step 2: Run them and watch them fail**

Run: `npx vitest run tests/leaveControl.test.ts tests/leaveCommandParity.test.ts`
Expected: FAIL, cannot resolve `../src/leaveControl.js`.

- [ ] **Step 3: Write `src/leaveControl.ts`**

```ts
import type { ServerRow } from './serverPool.js';
import type { LeaveState } from './presence.js';

/**
 * The website's half of `sm_pug_leave` (plugin/pug-leave.inc, 0.3.4): the
 * console line it sends and the answer it is willing to believe.
 *
 * The answer is the ONLY thing that changes the board. A command the server
 * does not acknowledge leaves the old state up and an error on the card, and
 * nothing is assumed, because the thing being controlled ends a ranked match.
 */

/** Runs one console command on one server and resolves with its reply.
 *  Injected so a test never dials rcon. Must reject when the box cannot be
 *  reached; the caller does the logging. */
export type ServerQuery = (server: ServerRow, command: string) => Promise<string>;

export const LEAVE_ACTIONS = ['hold', 'release', 'add', 'end'] as const;
export type LeaveAction = typeof LEAVE_ACTIONS[number];

/** The plugin refuses more than this in one add, and caps the allowance at it. */
export const LEAVE_ADD_MAX_S = 3600;

export const OLD_PLUGIN_ERROR =
  'This server runs a pug-match older than 0.3.4, which has no clock control. Update the plugin on it to use these.';

export const isUnknownCommand = (body: string): boolean => /unknown command/i.test(body);

/** Asserted rather than trusted: this becomes a line on a game server's
 *  console, where a space or a semicolon is another argument or another
 *  command. Both values come from our own tables, and that is not a reason. */
export function leaveCommand(token: string, steamid: string, action: LeaveAction, seconds?: number): string {
  if (!/^[0-9a-f]{32}$/.test(token)) throw new Error('leaveCommand: not a match token');
  if (!/^\d{17}$/.test(steamid)) throw new Error('leaveCommand: not a steamid');
  if (action !== 'add') return `sm_pug_leave ${token} ${steamid} ${action}`;
  if (seconds === undefined || !Number.isInteger(seconds) || seconds < 1 || seconds > LEAVE_ADD_MAX_S) {
    throw new Error(`leaveCommand: add needs whole seconds between 1 and ${LEAVE_ADD_MAX_S}`);
  }
  return `sm_pug_leave ${token} ${steamid} add ${seconds}`;
}

export type LeaveReply =
  | { ok: true; line: string; steamid: string; state: LeaveState }
  | { ok: false; oldPlugin: boolean; error: string };

const uint = (s: string | undefined): number | null => (s !== undefined && /^\d+$/.test(s) ? Number(s) : null);

/** An rcon response carries whatever else reached the console while the
 *  command ran, so the answer is looked for by its opening words, line by line. */
export function parseLeaveReply(body: string): LeaveReply {
  const lines = body.split('\n').map((l) => l.trim());
  const okLine = lines.find((l) => l.startsWith('PUGOK leave '));
  if (okLine) {
    const f: Record<string, string> = {};
    for (const part of okLine.split(/\s+/).slice(2)) {
      const at = part.indexOf('=');
      if (at > 0) f[part.slice(0, at)] = part.slice(at + 1);
    }
    const remaining = uint(f.remaining);
    const flags = (f.absent === '0' || f.absent === '1') && (f.held === '0' || f.held === '1');
    if (/^\d{17}$/.test(f.steamid ?? '') && remaining !== null && flags) {
      const held = f.held === '1';
      return {
        ok: true, line: okLine, steamid: f.steamid,
        state: { absent: f.absent === '1', remaining, held, holdLeft: held ? uint(f.hold_left) : null },
      };
    }
    return { ok: false, oldPlugin: false, error: `unreadable answer: ${okLine.slice(0, 120)}` };
  }
  const errLine = lines.find((l) => l.startsWith('PUGERR'));
  if (errLine) return { ok: false, oldPlugin: false, error: errLine.slice('PUGERR'.length).trim() || 'refused' };
  if (isUnknownCommand(body)) return { ok: false, oldPlugin: true, error: OLD_PLUGIN_ERROR };
  const text = body.trim();
  return { ok: false, oldPlugin: false, error: text ? `unexpected answer: ${text.slice(0, 120)}` : 'no answer' };
}
```

- [ ] **Step 4: Run and watch them pass**

Run: `npx vitest run tests/leaveControl.test.ts tests/leaveCommandParity.test.ts`
Expected: PASS.

- [ ] **Step 5: Write the failing route test**

`tests/adminLive.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { openDb, type DB } from '../src/db.js';
import { loadConfig } from '../src/config.js';
import { buildServer } from '../src/server.js';
import { addServer } from '../src/serverPool.js';
import { getPresence, recordPresenceLine } from '../src/presence.js';
import { authedCookie, stubOrchestrator } from './helpers.js';

const IDS = Array.from({ length: 8 }, (_, i) => `7656119900000000${i}`);
const ADMIN = '76561199000000091';
const PLAYER = '76561199000000092';
const TOKEN = 'a'.repeat(32);
const DROPPED = IDS[2];

let db: DB;
let app: FastifyInstance;
let cookies: Record<string, Record<string, string>>;
let sent: string[];
let answer: string | Error;
let matchId: number;

beforeEach(async () => {
  db = openDb(':memory:');
  sent = [];
  answer = `PUGOK leave steamid=${DROPPED} absent=1 remaining=200 held=1 hold_left=1800`;
  app = await buildServer({
    config: loadConfig({}), db, orchestrator: stubOrchestrator(), serverCleaner: async () => {}, serverExec: async () => {},
    serverQuery: async (_server, command) => {
      sent.push(command);
      if (answer instanceof Error) throw answer;
      return answer;
    },
  });
  cookies = {};
  for (const id of [...IDS, ADMIN, PLAYER]) cookies[id] = authedCookie(app, db, id);
  db.prepare('UPDATE players SET is_admin = 1 WHERE steamid = ?').run(ADMIN);
  const serverId = addServer(db, { name: 'Dallas', host: '1.2.3.4', port: 27015, rconPort: 27015, rconPassword: 'x', status: 'live' });
  matchId = Number(db.prepare("INSERT INTO matches (season_id, state, campaign, server_id, token) VALUES (1, 'live', 'dead_air', ?, ?)").run(serverId, TOKEN).lastInsertRowid);
  const ins = db.prepare('INSERT INTO match_players (match_id, player_id, team) VALUES (?, ?, ?)');
  IDS.forEach((p, i) => ins.run(matchId, p, i < 4 ? 'a' : 'b'));
  recordPresenceLine(db, { kind: 'leave', token: TOKEN, steamid: DROPPED, remaining: 210 });
});
afterEach(async () => { await app.close(); });

const act = (payload: object, as = ADMIN, steamid = DROPPED, id = matchId) =>
  app.inject({ method: 'POST', url: `/api/admin/live/${id}/players/${steamid}/leave`, cookies: cookies[as], payload });
const audit = async () => (await app.inject({ method: 'GET', url: '/api/admin/audit', cookies: cookies[ADMIN] })).json().actions;

describe('POST /api/admin/live/:matchId/players/:steamid/leave', () => {
  it('is admin only, and refuses before it dials anything', async () => {
    expect((await act({ action: 'hold' }, PLAYER)).statusCode).toBe(403);
    expect(sent).toEqual([]);
  });

  it('validates the body', async () => {
    expect((await act({ action: 'pause' })).statusCode).toBe(400);
    expect((await act({ action: 'add' })).statusCode).toBe(400);
    expect((await act({ action: 'add', seconds: 3601 })).statusCode).toBe(400);
    expect(sent).toEqual([]);
  });

  it('404s for an id off the roster and for a match that does not exist', async () => {
    expect((await act({ action: 'hold' }, ADMIN, PLAYER)).statusCode).toBe(404);
    expect((await act({ action: 'hold' }, ADMIN, DROPPED, 9999)).statusCode).toBe(404);
  });

  it('409s for a match that is over', async () => {
    db.prepare("UPDATE matches SET state = 'completed' WHERE id = ?").run(matchId);
    expect((await act({ action: 'hold' })).statusCode).toBe(409);
  });

  it('holds: sends the command, believes the answer, logs it, remembers the plugin is new enough', async () => {
    const res = await act({ action: 'hold' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true, state: { absent: true, remaining: 200, held: true, holdLeft: 1800 } });
    expect(sent).toEqual([`sm_pug_leave ${TOKEN} ${DROPPED} hold`]);
    expect(getPresence(db, matchId, DROPPED)).toMatchObject({ state: 'dropped', remaining_s: 200, held: 1 });
    expect((db.prepare('SELECT leave_control FROM matches WHERE id = ?').get(matchId) as { leave_control: number }).leave_control).toBe(1);
    expect((await audit())[0]).toMatchObject({ action: 'leave_clock', target: DROPPED, detail: { matchId, action: 'hold', ok: true, remaining: 200, held: true } });
  });

  it('adds five minutes', async () => {
    answer = `PUGOK leave steamid=${DROPPED} absent=1 remaining=510 held=0 hold_left=0`;
    expect((await act({ action: 'add', seconds: 300 })).statusCode).toBe(200);
    expect(sent).toEqual([`sm_pug_leave ${TOKEN} ${DROPPED} add 300`]);
    expect(getPresence(db, matchId, DROPPED)).toMatchObject({ remaining_s: 510, held: 0 });
  });

  it('a refusal changes nothing and comes back in the plugin\'s words', async () => {
    answer = 'PUGERR not dropped';
    const res = await act({ action: 'hold' });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ code: 'refused' });
    expect(res.json().error).toContain('not dropped');
    expect(getPresence(db, matchId, DROPPED)).toMatchObject({ remaining_s: 210, held: 0 });
    expect((await audit())[0]).toMatchObject({ action: 'leave_clock', detail: { ok: false, error: 'not dropped' } });
  });

  it('an old plugin is recognised, remembered, and changes nothing', async () => {
    answer = 'Unknown command "sm_pug_leave"';
    const res = await act({ action: 'hold' });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ code: 'old_plugin' });
    expect(res.json().error).toMatch(/older than 0\.3\.4/);
    expect((db.prepare('SELECT leave_control FROM matches WHERE id = ?').get(matchId) as { leave_control: number }).leave_control).toBe(0);
    expect(getPresence(db, matchId, DROPPED)).toMatchObject({ held: 0 });
  });

  it('an unreachable server is a 502 that changes nothing', async () => {
    answer = new Error('rcon connect timeout');
    const res = await act({ action: 'hold' });
    expect(res.statusCode).toBe(502);
    expect(res.json().error).toMatch(/could not reach Dallas: rcon connect timeout/);
    expect(getPresence(db, matchId, DROPPED)).toMatchObject({ remaining_s: 210, held: 0 });
  });

  it('an answer about somebody else is not believed', async () => {
    answer = `PUGOK leave steamid=${IDS[5]} absent=1 remaining=1 held=1 hold_left=9`;
    expect((await act({ action: 'hold' })).statusCode).toBe(409);
    expect(getPresence(db, matchId, DROPPED)).toMatchObject({ remaining_s: 210, held: 0 });
  });
});
```

- [ ] **Step 6: Run it and watch it fail**

Run: `npx vitest run tests/adminLive.test.ts`
Expected: FAIL. TypeScript rejects `serverQuery` on `ServerDeps`, and every request answers 404 from the SPA fallback's JSON branch.

- [ ] **Step 7: The dependency**

`src/server.ts`, add to the imports:

```ts
import type { ServerQuery } from './leaveControl.js';
```

In `ServerDeps`, after `logSecretPusher`:

```ts
  /** Runs one console command on one server and returns the reply, for the
   *  live board's clock actions. Injected in tests so they never dial a box. */
  serverQuery?: ServerQuery;
```

In the `app.register(adminRoutes, { ... })` call, after the `logSecretPusher` property:

```ts
    serverQuery: deps.serverQuery ?? (async (server, command) => {
      const rcon = new RealRcon({ host: server.host, port: server.rcon_port, password: server.rcon_password });
      try {
        await rcon.connect();
        return await rcon.exec(command);
      } finally {
        rcon.close();
      }
    }),
```

- [ ] **Step 8: The route**

`src/routes/admin.ts`, add to the imports:

```ts
import { applyLeaveState, isRostered } from '../presence.js';
import { LEAVE_ACTIONS, LEAVE_ADD_MAX_S, leaveCommand, parseLeaveReply, type LeaveAction, type ServerQuery } from '../leaveControl.js';
```

In `AdminRouteOpts`, after `logSecretPusher`:

```ts
  /** Runs one console command on one server and returns its reply. Absent in
   *  tests that do not exercise it, where the route says so. */
  serverQuery?: ServerQuery;
```

Add `serverQuery` to the destructuring on the first line of `adminRoutes`.

Directly after the `/api/admin/matches/:id/void` route:

```ts
  /**
   * Hold, release, extend or end one dropped player's reconnect allowance.
   *
   * The allowance lives in the plugin, so this is an rcon command and its
   * answer. Only a PUGOK changes the board. A refusal, an old plugin, an
   * unreachable box and an unreadable answer all leave presence exactly as it
   * was and come back as the error the card shows. The attempt is audited
   * either way, the same way the log secret push is.
   */
  app.post('/api/admin/live/:matchId/players/:steamid/leave', async (req, reply) => {
    const adminId = requireAdmin(req, reply);
    if (!adminId) return reply;
    const { matchId: rawId, steamid } = req.params as { matchId: string; steamid: string };
    const matchId = Number(rawId);
    const { action, seconds } = (req.body ?? {}) as { action?: unknown; seconds?: unknown };
    if (typeof action !== 'string' || !(LEAVE_ACTIONS as readonly string[]).includes(action)) {
      return reply.code(400).send({ error: 'action must be hold, release, add or end' });
    }
    let secs: number | undefined;
    if (action === 'add') {
      secs = Number(seconds);
      if (!Number.isInteger(secs) || secs < 1 || secs > LEAVE_ADD_MAX_S) {
        return reply.code(400).send({ error: `seconds must be a whole number between 1 and ${LEAVE_ADD_MAX_S}` });
      }
    }
    const match = db.prepare('SELECT state, token, server_id FROM matches WHERE id = ?').get(matchId) as
      | { state: string; token: string | null; server_id: number | null } | undefined;
    if (!match) return reply.code(404).send({ error: 'no such match' });
    if (match.state !== 'configuring' && match.state !== 'live') return reply.code(409).send({ error: `match is ${match.state}` });
    if (!isRostered(db, matchId, steamid)) return reply.code(404).send({ error: 'not on that match\'s roster' });
    const server = match.server_id !== null ? getServer(db, match.server_id) : undefined;
    if (!match.token || !server) return reply.code(409).send({ error: 'that match has no server yet' });
    if (!serverQuery) return reply.code(503).send({ error: 'clock control is not available here' });

    const detail = { matchId, action, ...(secs === undefined ? {} : { seconds: secs }) };
    let body: string;
    try {
      body = await serverQuery(server, leaveCommand(match.token, steamid, action as LeaveAction, secs));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logAdmin(db, adminId, 'leave_clock', steamid, { ...detail, ok: false, error: message });
      return reply.code(502).send({ error: `could not reach ${server.name}: ${message}` });
    }
    let answer = parseLeaveReply(body);
    // An rcon response carries whatever else was on the console. An answer
    // about another player is somebody else's answer.
    if (answer.ok && answer.steamid !== steamid) answer = { ok: false, oldPlugin: false, error: 'the answer was about another player' };
    if (!answer.ok) {
      if (answer.oldPlugin) {
        db.prepare('UPDATE matches SET leave_control = 0 WHERE id = ?').run(matchId);
        broadcast('refresh');
      }
      logAdmin(db, adminId, 'leave_clock', steamid, { ...detail, ok: false, error: answer.error });
      return reply.code(409).send({
        error: answer.oldPlugin ? answer.error : `${server.name} refused: ${answer.error}`,
        code: answer.oldPlugin ? 'old_plugin' : 'refused',
      });
    }
    db.prepare('UPDATE matches SET leave_control = 1 WHERE id = ?').run(matchId);
    applyLeaveState(db, matchId, steamid, answer.state);
    logAdmin(db, adminId, 'leave_clock', steamid, { ...detail, ok: true, remaining: answer.state.remaining, held: answer.state.held });
    broadcast('refresh');
    return { ok: true, reply: answer.line, state: answer.state };
  });
```

- [ ] **Step 9: Run and watch it pass**

Run: `npx vitest run tests/adminLive.test.ts`
Expected: PASS.

- [ ] **Step 10: The orchestrator pushes the ceiling and learns the plugin's age, test first**

In `tests/orchestrator.test.ts`, give the file's local `fakeServer` a second parameter. Change its signature to:

```ts
function fakeServer(
  dumpBody: string | ((cmd: string) => string),
  overrides: Record<string, string> = {},
): Promise<{ port: number; cmds: string[]; close: () => Promise<void> }> {
```

and in its `SERVERDATA_EXECCOMMAND` branch replace the `sock.write(...)` line with:

```ts
            // Keyed by command name: how a test stands in for a plugin too old
            // to know a command, which srcds answers with "Unknown command".
            const canned = overrides[p.body.split(' ')[0]];
            sock.write(encodePacket(p.id, SERVERDATA_RESPONSE_VALUE, canned ?? pugReply(p.body, dumpBody)));
```

In the first test (`setupMatch reserves a server, configures it over RCON, marks match live`), after the `sm_pug_leave_autounpause 1` assertion:

```ts
    // The hold ceiling, from clock_hold_max_minutes (30), and what its reply
    // says about the plugin: anything but "Unknown command" is 0.3.4 or later.
    expect(srv.cmds).toContain('sm_pug_leave_hold_max 1800');
    expect(m.leave_control).toBe(1);
```

Note `m` is read before this line in that test; move the two new assertions below the `const m = ...` line if they are not already.

Add directly after that test:

```ts
  it('notices a plugin too old for clock control, and sets the match up anyway', async () => {
    const srv = await fakeServer('', { sm_pug_leave_hold_max: 'Unknown command "sm_pug_leave_hold_max"' });
    cleanup.push(srv.close);
    addServer(db, { name: 's', host: '127.0.0.1', port: 27015, rconPort: srv.port, rconPassword: 'secret' });
    const listener = new LogListener(() => {});
    await listener.listen(0);
    cleanup.push(() => listener.close());
    const orch = new RealOrchestrator({
      db, listener, logPublicAddress: '127.0.0.1:27500', releaser: new ServerReleaser(db, async () => {}), makeRcon: (o) => o,
    });
    const mid = seedMatch(db);
    await orch.setupMatch(mid);

    const m = db.prepare('SELECT state, leave_control FROM matches WHERE id = ?').get(mid) as { state: string; leave_control: number | null };
    expect(m).toEqual({ state: 'live', leave_control: 0 });
  });
```

Run: `npx vitest run tests/orchestrator.test.ts`
Expected: FAIL. `sm_pug_leave_hold_max 1800` is never sent and `leave_control` is `null`.

- [ ] **Step 11: The orchestrator change**

`src/orchestrator.ts`, add to the imports:

```ts
import { isUnknownCommand } from './leaveControl.js';
```

Directly after the `sm_pug_leave_autounpause` line (169):

```ts
      // The ceiling on an admin hold of one player's reconnect clock. The
      // plugin enforces it itself, so a release that never arrives cannot pin
      // a box paused. The reply doubles as a free capability probe: a
      // pug-match older than 0.3.4 has no such cvar and says so, and the live
      // board then greys its clock controls out with the reason. Never fatal.
      const holdMax = await rcon.exec(`sm_pug_leave_hold_max ${settingInt(this.db, 'clock_hold_max_minutes', 30) * 60}`);
      this.db.prepare('UPDATE matches SET leave_control = ? WHERE id = ?').run(isUnknownCommand(holdMax) ? 0 : 1, matchId);
```

Run: `npx vitest run tests/orchestrator.test.ts tests/orchestrator-e2e.test.ts`
Expected: PASS.

- [ ] **Step 12: The audit line reads as a sentence**

Add to `tests/discordAdminFeed.test.ts`, inside `describe('admin feed', ...)`:

```ts
  it('a clock action names the player, the match and what was done', async () => {
    logAdmin(db, ADMIN, 'leave_clock', IDS[2], { matchId, action: 'hold', ok: true, remaining: 200, held: true });
    logAdmin(db, ADMIN, 'leave_clock', IDS[2], { matchId, action: 'add', seconds: 300, ok: true, remaining: 500, held: false });
    logAdmin(db, ADMIN, 'leave_clock', IDS[2], { matchId, action: 'end', ok: false, error: 'not dropped' });
    await feed.idle();
    expect(text(0)).toMatch(/player7.*put .*player2.*reconnect clock on hold/);
    expect(text(0)).toContain(`https://pug.test/match/${matchId}`);
    expect(text(1)).toMatch(/gave .*player2.* 300 more seconds/);
    expect(text(2)).toMatch(/failed: not dropped/);
  });
```

Run: `npx vitest run tests/discordAdminFeed.test.ts`
Expected: FAIL, the default wording (`leave clock 7656...`) matches none of these.

`src/discord/adminFeedPoster.ts`, in `actionText`, before the `case 'ticket_open':` group:

```ts
      case 'leave_clock': {
        const where = `match [#${String(d.matchId)}](${this.deps.publicUrl}/match/${String(d.matchId)})`;
        if (d.ok === false) {
          return `${who} tried to ${String(d.action)} ${target}'s reconnect clock in ${where}, and it failed: ${escapeName(String(d.error ?? ''))}`;
        }
        switch (d.action) {
          case 'hold': return `${who} put ${target}'s reconnect clock on hold in ${where}`;
          case 'release': return `${who} released the hold on ${target}'s reconnect clock in ${where}`;
          case 'add': return `${who} gave ${target} ${String(d.seconds)} more seconds to reconnect in ${where}`;
          default: return `${who} ended ${target}'s reconnect time in ${where}`;
        }
      }
```

Run: `npx vitest run tests/discordAdminFeed.test.ts`
Expected: PASS.

- [ ] **Step 13: Full suite, typecheck, commit**

Run: `npx vitest run && npm run typecheck`
Expected: green.

```bash
git add src/leaveControl.ts src/orchestrator.ts src/server.ts src/routes/admin.ts src/discord/adminFeedPoster.ts \
  tests/leaveControl.test.ts tests/adminLive.test.ts tests/orchestrator.test.ts tests/leaveCommandParity.test.ts tests/discordAdminFeed.test.ts
git commit -m "Send a reconnect clock action to the match's server and believe only its answer"
```

---

### Task 7: The board API

**Files:**
- Create: `src/admin/liveBoard.ts`, `tests/liveBoard.test.ts`
- Modify: `src/routes/admin.ts` (`AdminRouteOpts`; a new route directly before the POST from Task 6), `src/server.ts` (the `adminRoutes` registration), `tests/adminLive.test.ts` (one appended `describe`)

**Interfaces:**
- Consumes: `remainingNow`, `holdMaxSeconds`, `PresenceRow` (Task 5); `phaseFor(db, matchId): LivePhase | null` from `src/liveView.ts`; `spectateFor(db, serverId): SpectateInfo | null` from `src/spectate.ts`; `VoicePresence.inVoice(userId): boolean | null`.
- Produces, in `src/admin/liveBoard.ts`:

```ts
export interface VoiceLookup { inVoice(discordId: string): boolean | null }
export type BoardReason = { kind: 'signon_drop'; at: string } | { kind: 'not_in_voice' };
export type BoardStatus =
  | { kind: 'connected'; remainingS: number | null }
  | { kind: 'never_connected'; sincePopS: number }
  | { kind: 'dropped'; sinceS: number; remainingS: number | null; held: boolean; holdLeftS: number | null };
export interface BoardPlayer { steamid: string; name: string; team: 'a' | 'b'; status: BoardStatus; reason: BoardReason | null }
export interface BoardClock { kind: 'abandon'; steamid: string; name: string; remainingS: number; held: boolean; holdLeftS: number | null }
export interface BoardMatch {
  id: number; campaign: string; map: string | null;
  state: 'waiting' | 'configuring' | 'live' | 'paused';
  phase: PhaseState | null;
  server: { id: number; name: string } | null;
  teamAScore: number; teamBScore: number; elapsedS: number;
  spectate: SpectateInfo | null;
  leaveControl: 'ok' | 'old_plugin' | 'unknown';
  teamA: BoardPlayer[]; teamB: BoardPlayer[];
  clocks: BoardClock[];
}
export interface LiveBoard { now: string; holdMaxMinutes: number; matches: BoardMatch[] }
export function buildLiveBoard(db: DB, opts: { voice: VoiceLookup | null; now?: Date }): LiveBoard;
```

Every `...S` field is whole seconds as of `now`. The browser subtracts the time since it received the payload; nothing in the payload is compared against the browser's wall clock.

- Produces, HTTP: `GET /api/admin/live`, admin only, returning `LiveBoard`.
- Produces, deps: `AdminRouteOpts.voice?: VoiceLookup | null`.

- [ ] **Step 1: Write the failing test**

`tests/liveBoard.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { openDb, type DB } from '../src/db.js';
import { upsertPlayer, activatePlayer, linkDiscord } from '../src/players.js';
import { addServer } from '../src/serverPool.js';
import { recordPhase } from '../src/liveView.js';
import { recordSignonDrop, markEntered } from '../src/signonDrops.js';
import { recordPresenceLine } from '../src/presence.js';
import { buildLiveBoard, type BoardPlayer } from '../src/admin/liveBoard.js';

const IDS = Array.from({ length: 8 }, (_, i) => `7656119900000000${i}`);
const TOKEN = 'a'.repeat(32);
const at = (min: number, s = 0) => new Date(Date.UTC(2026, 8, 21, 20, min, s));
const NOW = at(10);
let db: DB;
let matchId: number;

beforeEach(() => {
  db = openDb(':memory:');
  IDS.forEach((p, i) => {
    upsertPlayer(db, { steamid: p, name: `p${i}`, avatar: null }, []);
    activatePlayer(db, p);
    linkDiscord(db, p, `90${i}`, `d${i}`);
  });
  const serverId = addServer(db, { name: 'Dallas', host: '1.2.3.4', port: 27015, rconPort: 27015, rconPassword: 'x', status: 'live' });
  matchId = Number(db.prepare(
    `INSERT INTO matches (season_id, state, campaign, server_id, token, created_at, went_live_at)
     VALUES (1, 'live', 'dead_air', ?, ?, '2026-09-21 20:00:00', '2026-09-21 20:02:00')`,
  ).run(serverId, TOKEN).lastInsertRowid);
  const ins = db.prepare('INSERT INTO match_players (match_id, player_id, team) VALUES (?, ?, ?)');
  IDS.forEach((p, i) => ins.run(matchId, p, i < 4 ? 'a' : 'b'));
});

const board = (voice: { inVoice(id: string): boolean | null } | null = null) => buildLiveBoard(db, { voice, now: NOW });
const find = (steamid: string): BoardPlayer => {
  const m = board().matches[0];
  return [...m.teamA, ...m.teamB].find((p) => p.steamid === steamid)!;
};

describe('the match line', () => {
  it('names the server, the campaign, the state, the score and how long it has run', () => {
    db.prepare("INSERT INTO match_live (match_id, current_map, last_seen) VALUES (?, 'l4d_airport02_offices', datetime('now'))").run(matchId);
    db.prepare("INSERT INTO match_live_maps (match_id, map, ordinal, team_a_score, team_b_score) VALUES (?, 'l4d_airport01_greenhouse', 0, 412, 380)").run(matchId);
    const b = board();
    expect(b.now).toBe(NOW.toISOString());
    expect(b.holdMaxMinutes).toBe(30);
    expect(b.matches[0]).toMatchObject({
      id: matchId, campaign: 'dead_air', map: 'l4d_airport02_offices', state: 'live', phase: null,
      server: { name: 'Dallas' }, teamAScore: 412, teamBScore: 380, elapsedS: 480, leaveControl: 'unknown',
    });
    expect(b.matches[0].teamA).toHaveLength(4);
    expect(b.matches[0].teamB).toHaveLength(4);
  });

  it('says paused when the game is, and waiting when there is no server', () => {
    recordPhase(db, TOKEN, { state: 'paused', team: null, limit: 0, leave: true, unready: [] });
    expect(board().matches[0]).toMatchObject({ state: 'paused', phase: 'paused' });
    db.prepare("UPDATE matches SET state = 'configuring', server_id = NULL WHERE id = ?").run(matchId);
    expect(board().matches[0]).toMatchObject({ state: 'waiting', server: null });
  });

  it('reports what is known about the plugin', () => {
    db.prepare('UPDATE matches SET leave_control = 0 WHERE id = ?').run(matchId);
    expect(board().matches[0].leaveControl).toBe('old_plugin');
    db.prepare('UPDATE matches SET leave_control = 1 WHERE id = ?').run(matchId);
    expect(board().matches[0].leaveControl).toBe('ok');
  });

  it('lists nothing that is over', () => {
    db.prepare("UPDATE matches SET state = 'completed' WHERE id = ?").run(matchId);
    expect(board().matches).toEqual([]);
  });
});

describe('exactly one status per player', () => {
  it('never connected, with how long since the pop', () => {
    expect(find(IDS[0]).status).toEqual({ kind: 'never_connected', sincePopS: 600 });
  });

  it('on the server, from a presence row or from connected_at alone', () => {
    recordPresenceLine(db, { kind: 'player', token: TOKEN, steamid: IDS[0], event: 'connect' }, at(3));
    expect(find(IDS[0]).status).toEqual({ kind: 'connected', remainingS: null });
    db.prepare("UPDATE match_players SET connected_at = '2026-09-21 20:03:00' WHERE player_id = ?").run(IDS[1]);
    expect(find(IDS[1]).status).toEqual({ kind: 'connected', remainingS: null });
  });

  it('dropped, with how long ago and what is left now', () => {
    recordPresenceLine(db, { kind: 'leave', token: TOKEN, steamid: IDS[2], remaining: 300 }, at(9, 18));
    expect(find(IDS[2]).status).toEqual({ kind: 'dropped', sinceS: 42, remainingS: 258, held: false, holdLeftS: null });
    expect(board().matches[0].clocks).toEqual([
      { kind: 'abandon', steamid: IDS[2], name: 'p2', remainingS: 258, held: false, holdLeftS: null },
    ]);
  });

  it('dropped and held: the figure stands still and the ceiling counts down', () => {
    recordPresenceLine(db, { kind: 'leave', token: TOKEN, steamid: IDS[2], remaining: 300 }, at(9, 0));
    recordPresenceLine(db, { kind: 'leave', token: TOKEN, steamid: IDS[2], remaining: 270, held: true, holdLeft: 1800 }, at(9, 30));
    expect(find(IDS[2]).status).toEqual({ kind: 'dropped', sinceS: 60, remainingS: 270, held: true, holdLeftS: 1770 });
  });

  it('back, with a used allowance worth showing', () => {
    recordPresenceLine(db, { kind: 'leave', token: TOKEN, steamid: IDS[2], remaining: 300 }, at(8));
    recordPresenceLine(db, { kind: 'return', token: TOKEN, steamid: IDS[2], remaining: 240 }, at(9));
    expect(find(IDS[2]).status).toEqual({ kind: 'connected', remainingS: 240 });
    expect(board().matches[0].clocks).toEqual([]);
  });
});

describe('a reason, when known and never guessed', () => {
  it('rejected by the file check, from a connect drop since the pop with no entry after it', () => {
    recordSignonDrop(db, { steamid: IDS[0], name: 'p0', secs: 14, forced: 651 }, at(4));
    expect(find(IDS[0]).reason).toEqual({ kind: 'signon_drop', at: at(4).toISOString() });
    markEntered(db, IDS[0], at(5));
    expect(find(IDS[0]).reason).toBeNull();
  });

  it('ignores a connect drop from before this match popped', () => {
    recordSignonDrop(db, { steamid: IDS[0], name: 'p0', secs: 14, forced: 651 }, new Date(Date.UTC(2026, 8, 21, 19, 0, 0)));
    expect(find(IDS[0]).reason).toBeNull();
  });

  it('not in a voice channel, only when Discord says so', () => {
    const where: Record<string, boolean | null> = { '900': false, '901': true, '902': null };
    const voice = { inVoice: (id: string) => where[id] ?? null };
    const m = buildLiveBoard(db, { voice, now: NOW }).matches[0];
    expect(m.teamA.find((p) => p.steamid === IDS[0])!.reason).toEqual({ kind: 'not_in_voice' });
    expect(m.teamA.find((p) => p.steamid === IDS[1])!.reason).toBeNull();
    expect(m.teamA.find((p) => p.steamid === IDS[2])!.reason).toBeNull();
  });

  it('gives no reason for someone who is on the server', () => {
    recordPresenceLine(db, { kind: 'player', token: TOKEN, steamid: IDS[0], event: 'connect' }, at(3));
    const voice = { inVoice: () => false };
    expect(buildLiveBoard(db, { voice, now: NOW }).matches[0].teamA.find((p) => p.steamid === IDS[0])!.reason).toBeNull();
  });
});
```

Append to `tests/adminLive.test.ts`:

```ts
describe('GET /api/admin/live', () => {
  it('is admin only', async () => {
    expect((await app.inject({ method: 'GET', url: '/api/admin/live', cookies: cookies[PLAYER] })).statusCode).toBe(403);
  });

  it('shows the dropped player, and shows the hold the moment the plugin confirms it', async () => {
    const get = async () => (await app.inject({ method: 'GET', url: '/api/admin/live', cookies: cookies[ADMIN] })).json();
    const before = await get();
    expect(before.matches).toHaveLength(1);
    expect(before.matches[0].teamA.find((p: { steamid: string }) => p.steamid === DROPPED).status).toMatchObject({ kind: 'dropped', held: false });
    await act({ action: 'hold' });
    const after = await get();
    expect(after.matches[0].teamA.find((p: { steamid: string }) => p.steamid === DROPPED).status).toMatchObject({ kind: 'dropped', held: true, remainingS: 200 });
    expect(after.matches[0].leaveControl).toBe('ok');
  });
});
```

- [ ] **Step 2: Run them and watch them fail**

Run: `npx vitest run tests/liveBoard.test.ts tests/adminLive.test.ts`
Expected: FAIL, cannot resolve `../src/admin/liveBoard.js`, and `GET /api/admin/live` answers 404.

- [ ] **Step 3: Write `src/admin/liveBoard.ts`**

```ts
import type { DB } from '../db.js';
import type { PhaseState } from '../logParse.js';
import { phaseFor } from '../liveView.js';
import { spectateFor, type SpectateInfo } from '../spectate.js';
import { holdMaxSeconds, remainingNow, type PresenceRow } from '../presence.js';

/**
 * The admin live board: every ongoing match, who is missing from it, and the
 * clocks running against it.
 *
 * Every duration here is whole seconds AS OF `now`, and the payload says what
 * `now` was. The browser counts on from the moment it received the payload,
 * so a wrong clock on an admin's PC cannot move a countdown that decides
 * whether someone gets banned.
 */

/** The slice of discord/voicePresence.ts this needs. Null answer = unknown. */
export interface VoiceLookup { inVoice(discordId: string): boolean | null }

/** Why someone is not on the server, when something on record says so. There
 *  is deliberately no "Steam ID not verified" kind: the plugin kicks for that
 *  exactly when it could not read a SteamID, so there is nobody to pin it on
 *  and no line is sent. */
export type BoardReason = { kind: 'signon_drop'; at: string } | { kind: 'not_in_voice' };

export type BoardStatus =
  | { kind: 'connected'; remainingS: number | null }
  | { kind: 'never_connected'; sincePopS: number }
  | { kind: 'dropped'; sinceS: number; remainingS: number | null; held: boolean; holdLeftS: number | null };

export interface BoardPlayer { steamid: string; name: string; team: 'a' | 'b'; status: BoardStatus; reason: BoardReason | null }

/** One running clock. Part one has only the abandon allowance; the no-show
 *  clock joins this union in part two. */
export interface BoardClock { kind: 'abandon'; steamid: string; name: string; remainingS: number; held: boolean; holdLeftS: number | null }

export interface BoardMatch {
  id: number;
  campaign: string;
  map: string | null;
  /** waiting = configuring with no server yet; paused = live and the game is paused. */
  state: 'waiting' | 'configuring' | 'live' | 'paused';
  phase: PhaseState | null;
  server: { id: number; name: string } | null;
  teamAScore: number;
  teamBScore: number;
  /** Since it went live, or since the pop while it has not. */
  elapsedS: number;
  spectate: SpectateInfo | null;
  leaveControl: 'ok' | 'old_plugin' | 'unknown';
  teamA: BoardPlayer[];
  teamB: BoardPlayer[];
  clocks: BoardClock[];
}

export interface LiveBoard { now: string; holdMaxMinutes: number; matches: BoardMatch[] }

/** sqlite's datetime('now') or an ISO string, as epoch milliseconds. */
const toMs = (t: string): number => Date.parse(t.includes('T') ? t : `${t.replace(' ', 'T')}Z`);
const secondsSince = (ms: number, now: Date): number => Math.max(0, Math.floor((now.getTime() - ms) / 1000));

interface MatchRow {
  id: number; campaign: string; state: 'configuring' | 'live'; serverId: number | null; serverName: string | null;
  createdAt: string; wentLiveAt: string | null; leaveControl: number | null; currentMap: string | null;
}

interface PlayerRow extends Partial<Pick<PresenceRow, 'state' | 'since' | 'remaining_s' | 'remaining_at' | 'held' | 'hold_until'>> {
  steamid: string; name: string; team: 'a' | 'b'; discordId: string | null; connectedAt: string | null;
}

export function buildLiveBoard(db: DB, opts: { voice: VoiceLookup | null; now?: Date }): LiveBoard {
  const now = opts.now ?? new Date();
  const matches = db.prepare(
    `SELECT m.id, m.campaign, m.state, m.server_id AS serverId, s.name AS serverName,
            m.created_at AS createdAt, m.went_live_at AS wentLiveAt, m.leave_control AS leaveControl,
            l.current_map AS currentMap
     FROM matches m
     LEFT JOIN servers s ON s.id = m.server_id
     LEFT JOIN match_live l ON l.match_id = m.id
     WHERE m.state IN ('configuring', 'live') ORDER BY m.id DESC`,
  ).all() as MatchRow[];

  const playersOf = db.prepare(
    `SELECT mp.player_id AS steamid, p.name, mp.team, p.discord_id AS discordId, mp.connected_at AS connectedAt,
            pr.state, pr.since, pr.remaining_s, pr.remaining_at, pr.held, pr.hold_until
     FROM match_players mp
     JOIN players p ON p.steamid = mp.player_id
     LEFT JOIN match_presence pr ON pr.match_id = mp.match_id AND pr.steamid = mp.player_id
     WHERE mp.match_id = ? ORDER BY mp.team, p.name`,
  );
  const scoreOf = db.prepare(
    'SELECT COALESCE(SUM(team_a_score), 0) AS a, COALESCE(SUM(team_b_score), 0) AS b FROM match_live_maps WHERE match_id = ?',
  );
  // Since the pop, and with no entry after it: markEntered stamps every open
  // drop the moment the same steamid gets in, so this is "still not in".
  const dropOf = db.prepare(
    'SELECT at FROM signon_drops WHERE steamid = ? AND at >= ? AND entered_after_at IS NULL ORDER BY id DESC LIMIT 1',
  );

  return {
    now: now.toISOString(),
    holdMaxMinutes: Math.round(holdMaxSeconds(db) / 60),
    matches: matches.map((m) => {
      const poppedMs = toMs(m.createdAt);
      const poppedIso = new Date(poppedMs).toISOString();
      const phase = m.state === 'live' ? phaseFor(db, m.id) : null;
      const score = scoreOf.get(m.id) as { a: number; b: number };

      const players = (playersOf.all(m.id) as PlayerRow[]).map((p): BoardPlayer => {
        let status: BoardStatus;
        if (p.state === 'dropped' && p.since) {
          const held = p.held === 1;
          status = {
            kind: 'dropped',
            sinceS: secondsSince(Date.parse(p.since), now),
            remainingS: remainingNow({ state: 'dropped', remaining_s: p.remaining_s ?? null, remaining_at: p.remaining_at ?? null, held: p.held ?? 0 }, now),
            held,
            holdLeftS: held && p.hold_until ? Math.max(0, Math.ceil((Date.parse(p.hold_until) - now.getTime()) / 1000)) : null,
          };
        } else if (p.state === 'connected' || p.connectedAt !== null) {
          // connected_at alone covers a match that was already running when
          // this table arrived, and a box whose first connect line was lost.
          status = { kind: 'connected', remainingS: p.remaining_s ?? null };
        } else {
          status = { kind: 'never_connected', sincePopS: secondsSince(poppedMs, now) };
        }

        let reason: BoardReason | null = null;
        if (status.kind !== 'connected') {
          const drop = dropOf.get(p.steamid, poppedIso) as { at: string } | undefined;
          if (drop) reason = { kind: 'signon_drop', at: drop.at };
          else if (opts.voice && p.discordId && opts.voice.inVoice(p.discordId) === false) reason = { kind: 'not_in_voice' };
        }
        return { steamid: p.steamid, name: p.name, team: p.team, status, reason };
      });

      const clocks: BoardClock[] = [];
      for (const p of players) {
        if (p.status.kind === 'dropped' && p.status.remainingS !== null) {
          clocks.push({ kind: 'abandon', steamid: p.steamid, name: p.name, remainingS: p.status.remainingS, held: p.status.held, holdLeftS: p.status.holdLeftS });
        }
      }

      return {
        id: m.id,
        campaign: m.campaign,
        map: m.currentMap,
        state: m.state === 'configuring'
          ? (m.serverId === null ? 'waiting' : 'configuring')
          : (phase?.state === 'paused' ? 'paused' : 'live'),
        phase: phase?.state ?? null,
        server: m.serverId !== null && m.serverName !== null ? { id: m.serverId, name: m.serverName } : null,
        teamAScore: score.a,
        teamBScore: score.b,
        elapsedS: secondsSince(m.wentLiveAt ? toMs(m.wentLiveAt) : poppedMs, now),
        spectate: spectateFor(db, m.serverId),
        leaveControl: m.leaveControl === null ? 'unknown' : m.leaveControl === 1 ? 'ok' : 'old_plugin',
        teamA: players.filter((p) => p.team === 'a'),
        teamB: players.filter((p) => p.team === 'b'),
        clocks,
      };
    }),
  };
}
```

- [ ] **Step 4: The route and its dependency**

`src/routes/admin.ts`, add to the imports:

```ts
import { buildLiveBoard, type VoiceLookup } from '../admin/liveBoard.js';
```

In `AdminRouteOpts`, after `serverQuery`:

```ts
  /** Who is in a Discord voice channel, for the live board's "not in a voice
   *  channel" reason. Null or absent when Discord is not configured, and then
   *  the board simply never gives that reason. */
  voice?: VoiceLookup | null;
```

Directly before the `POST /api/admin/live/...` route from Task 6:

```ts
  app.get('/api/admin/live', async (req, reply) => {
    if (!requireAdmin(req, reply)) return reply;
    return buildLiveBoard(db, { voice: opts.voice ?? null });
  });
```

`src/server.ts`, in the `app.register(adminRoutes, { ... })` call, after `serverQuery`:

```ts
    voice: deps.config.discord !== null ? presence : null,
```

- [ ] **Step 5: Run and watch them pass**

Run: `npx vitest run tests/liveBoard.test.ts tests/adminLive.test.ts`
Expected: PASS.

- [ ] **Step 6: Full suite, typecheck, commit**

Run: `npx vitest run && npm run typecheck`
Expected: green.

```bash
git add src/admin/liveBoard.ts src/routes/admin.ts src/server.ts tests/liveBoard.test.ts tests/adminLive.test.ts
git commit -m "Serve the live match board to admins"
```

---

### Task 8: The sweep: one low-allowance warning per drop, and holds that expire

**Files:**
- Create: `tests/presenceSweep.test.ts`
- Modify: `src/presence.ts` (append `sweepPresence`), `src/adminFeed.ts:11-57` (the `clock` event and its setting), `src/discord/adminFeedPoster.ts` (`line`, one case), `src/server.ts` (the `leave` branch from Task 5; a timer beside `reaper` near line 945; `onClose` near line 1057), `tests/discordAdminFeed.test.ts` (one new `it`)

**Interfaces:**
- Consumes: `PresenceRow`, `remainingNow`, `lowAlertSeconds` (Task 5), `publishAdminEvent`.
- Produces:

```ts
// src/presence.ts
export interface SweepEvent { what: 'low_allowance' | 'hold_expired'; matchId: number; steamid: string; remainingS: number }
export function sweepPresence(db: DB, now?: Date): SweepEvent[];

// src/adminFeed.ts, added to AdminEvent
| { kind: 'clock'; what: 'low_allowance' | 'hold_expired'; steamid: string; matchId: number; remainingS: number }
```

Feed link, until the routing plan moves it: `${publicUrl}/admin?live=${matchId}`.

- [ ] **Step 1: Write the failing test**

`tests/presenceSweep.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { openDb, type DB } from '../src/db.js';
import { upsertPlayer, activatePlayer } from '../src/players.js';
import { setSetting } from '../src/settings.js';
import { getPresence, recordPresenceLine, sweepPresence } from '../src/presence.js';

const ID = '76561199000000002';
const TOKEN = 'a'.repeat(32);
const at = (s: number) => new Date(Date.UTC(2026, 8, 21, 20, 0, 0) + s * 1000);
let db: DB;
let matchId: number;

beforeEach(() => {
  db = openDb(':memory:');
  upsertPlayer(db, { steamid: ID, name: 'bob', avatar: null }, []);
  activatePlayer(db, ID);
  matchId = Number(db.prepare("INSERT INTO matches (season_id, state, campaign, token) VALUES (1, 'live', 'dead_air', ?)").run(TOKEN).lastInsertRowid);
  db.prepare("INSERT INTO match_players (match_id, player_id, team) VALUES (?, ?, 'a')").run(matchId, ID);
});

const leave = (remaining: number, extra: object = {}) => ({ kind: 'leave' as const, token: TOKEN, steamid: ID, remaining, ...extra });

describe('the low allowance warning', () => {
  it('fires when the allowance crosses the line, and only once for that drop', () => {
    recordPresenceLine(db, leave(300), at(0));
    expect(sweepPresence(db, at(200))).toEqual([]);
    expect(sweepPresence(db, at(215))).toEqual([{ what: 'low_allowance', matchId, steamid: ID, remainingS: 85 }]);
    expect(sweepPresence(db, at(220))).toEqual([]);
  });

  it('survives a restart: the stamp is in the table, not in memory', () => {
    recordPresenceLine(db, leave(300), at(0));
    sweepPresence(db, at(215));
    expect(getPresence(db, matchId, ID)!.low_alert_at).toBe(at(215).toISOString());
    // Nothing but the database carries over a restart, and the next sweep
    // after one reads the same row.
    expect(sweepPresence(db, at(216))).toEqual([]);
  });

  it('fires late rather than never, when the crossing happened while the backend was down', () => {
    recordPresenceLine(db, leave(300), at(0));
    expect(sweepPresence(db, at(280))).toEqual([{ what: 'low_allowance', matchId, steamid: ID, remainingS: 20 }]);
  });

  it('fires straight away for a second drop that starts under the line, and again for a later drop', () => {
    recordPresenceLine(db, leave(40), at(0));
    expect(sweepPresence(db, at(1))).toHaveLength(1);
    recordPresenceLine(db, { kind: 'return', token: TOKEN, steamid: ID, remaining: 30 }, at(10));
    recordPresenceLine(db, leave(30), at(60));
    expect(sweepPresence(db, at(61))).toEqual([{ what: 'low_allowance', matchId, steamid: ID, remainingS: 29 }]);
  });

  it('says nothing while held, at zero, when turned off, or once the match is over', () => {
    recordPresenceLine(db, leave(80, { held: true, holdLeft: 1800 }), at(0));
    expect(sweepPresence(db, at(5))).toEqual([]);

    recordPresenceLine(db, leave(80, { held: false, holdLeft: 0 }), at(10));
    expect(sweepPresence(db, at(500))).toEqual([]);

    setSetting(db, 'abandon_low_alert_seconds', '0');
    expect(sweepPresence(db, at(20))).toEqual([]);

    setSetting(db, 'abandon_low_alert_seconds', '90');
    db.prepare("UPDATE matches SET state = 'aborted' WHERE id = ?").run(matchId);
    expect(sweepPresence(db, at(20))).toEqual([]);
  });
});

describe('a hold that reaches its ceiling', () => {
  it('is released here when the plugin\'s own line about it never arrives, and the clock resumes from the ceiling', () => {
    recordPresenceLine(db, leave(200, { held: true, holdLeft: 60 }), at(0));
    expect(sweepPresence(db, at(61))).toEqual([]);
    expect(sweepPresence(db, at(63))).toEqual([{ what: 'hold_expired', matchId, steamid: ID, remainingS: 197 }]);
    expect(getPresence(db, matchId, ID)).toMatchObject({ held: 0, hold_until: null, remaining_at: at(60).toISOString() });
    expect(sweepPresence(db, at(70))).toEqual([]);
  });

  it('is not announced twice when the plugin\'s line got here first', () => {
    recordPresenceLine(db, leave(200, { held: true, holdLeft: 60 }), at(0));
    expect(recordPresenceLine(db, leave(200, { held: false, holdLeft: 0, auto: true }), at(60))).toMatchObject({ holdReleased: true });
    expect(sweepPresence(db, at(63))).toEqual([]);
  });

  it('can release and warn in the same pass', () => {
    recordPresenceLine(db, leave(50, { held: true, holdLeft: 60 }), at(0));
    expect(sweepPresence(db, at(65)).map((e) => e.what)).toEqual(['hold_expired', 'low_allowance']);
  });
});
```

Add to `tests/discordAdminFeed.test.ts` (it already imports `publishAdminEvent`):

```ts
  it('warns once that a dropped player is nearly out of time, with a link to the board', async () => {
    publishAdminEvent({ kind: 'clock', what: 'low_allowance', steamid: IDS[2], matchId, remainingS: 85 });
    publishAdminEvent({ kind: 'clock', what: 'hold_expired', steamid: IDS[2], matchId, remainingS: 197 });
    await feed.idle();
    expect(text(0)).toMatch(/player2.* has 85 s left/);
    expect(text(0)).toContain(`https://pug.test/admin?live=${matchId}`);
    expect(text(0)).toContain(`https://pug.test/match/${matchId}`);
    expect(text(1)).toMatch(/hold on .*player2.* released itself/);
    expect(text(1)).toContain('197 s');
  });
```

- [ ] **Step 2: Run them and watch them fail**

Run: `npx vitest run tests/presenceSweep.test.ts tests/discordAdminFeed.test.ts`
Expected: FAIL. `sweepPresence` is not exported, and `kind: 'clock'` is not assignable to `AdminEvent`.

- [ ] **Step 3: The sweep**

Append to `src/presence.ts`:

```ts
export interface SweepEvent {
  what: 'low_allowance' | 'hold_expired';
  matchId: number;
  steamid: string;
  remainingS: number;
}

/** The plugin releases at its ceiling and says so; this only acts when that
 *  line has not arrived a couple of seconds after it was due. */
const HOLD_GRACE_MS = 2000;

/**
 * What the plugin cannot tell us, because it only speaks at a LEAVE or a
 * RETURN: that a dropped player's allowance has run low, and that a hold has
 * reached its ceiling when the line saying so was lost.
 *
 * Stateless on purpose. Everything it decides from is in match_presence, so a
 * backend restart neither posts a warning twice (low_alert_at is already set)
 * nor loses one (the next pass computes the same figure from the same row).
 * Each stamp is a guarded UPDATE, and an event is returned only when that
 * update changed the row.
 */
export function sweepPresence(db: DB, now = new Date()): SweepEvent[] {
  const rows = db.prepare(
    `SELECT pr.* FROM match_presence pr JOIN matches m ON m.id = pr.match_id
     WHERE m.state IN ('configuring', 'live') AND pr.state = 'dropped'
     ORDER BY pr.match_id, pr.steamid`,
  ).all() as PresenceRow[];
  const threshold = lowAlertSeconds(db);
  const iso = now.toISOString();
  const out: SweepEvent[] = [];

  for (const row of rows) {
    let r = row;
    if (r.held === 1 && r.hold_until !== null && Date.parse(r.hold_until) + HOLD_GRACE_MS <= now.getTime()) {
      // The clock resumed AT the ceiling, not now, so that is the new anchor.
      const n = db.prepare(
        `UPDATE match_presence SET held = 0, remaining_at = hold_until, hold_until = NULL, updated_at = ?
         WHERE match_id = ? AND steamid = ? AND held = 1`,
      ).run(iso, r.match_id, r.steamid).changes;
      if (n === 1) {
        r = { ...r, held: 0, remaining_at: r.hold_until, hold_until: null };
        out.push({ what: 'hold_expired', matchId: r.match_id, steamid: r.steamid, remainingS: remainingNow(r, now) ?? 0 });
      }
    }
    if (threshold <= 0 || r.held === 1 || r.low_alert_at !== null) continue;
    const left = remainingNow(r, now);
    // At zero the plugin has already called the abandon, and that has its own line.
    if (left === null || left <= 0 || left > threshold) continue;
    const n = db.prepare(
      'UPDATE match_presence SET low_alert_at = ?, updated_at = ? WHERE match_id = ? AND steamid = ? AND low_alert_at IS NULL',
    ).run(iso, iso, r.match_id, r.steamid).changes;
    if (n === 1) out.push({ what: 'low_allowance', matchId: r.match_id, steamid: r.steamid, remainingS: left });
  }
  return out;
}
```

- [ ] **Step 4: The feed event and its wording**

`src/adminFeed.ts`, add to the `AdminEvent` union after the `abandon` member:

```ts
  // The live board's clocks. low_allowance: a dropped player is nearly out of
  // reconnect time, once per drop, so an admin can hold the clock before it
  // ends the match. hold_expired: a hold reached its ceiling and released
  // itself. Both link to the board, where the buttons are.
  | { kind: 'clock'; what: 'low_allowance' | 'hold_expired'; steamid: string; matchId: number; remainingS: number }
```

In `FEED_SETTING`, after `abandon`:

```ts
  clock: 'admin_feed_problems',
```

`src/discord/adminFeedPoster.ts`, in `line`, after the `abandon` case:

```ts
      case 'clock': {
        // /admin?live=N today. The admin routing plan moves the board to
        // /admin/live, and whichever of the two lands second changes this.
        const board = `[live board](${this.deps.publicUrl}/admin?live=${e.matchId})`;
        const match = `match [#${e.matchId}](${this.deps.publicUrl}/match/${e.matchId})`;
        return {
          text: e.what === 'low_allowance'
            ? `**${this.name(e.steamid)}** has ${e.remainingS} s left to reconnect in ${match}. Hold the clock or add time on the ${board}.`
            : `The hold on **${this.name(e.steamid)}**'s reconnect clock in ${match} released itself at the ceiling: ${e.remainingS} s left and counting. ${board}`,
          color: COLOR.problem,
        };
      }
```

- [ ] **Step 5: Run and watch them pass**

Run: `npx vitest run tests/presenceSweep.test.ts tests/discordAdminFeed.test.ts`
Expected: PASS.

- [ ] **Step 6: Wire the sweep and the plugin's own release line**

`src/server.ts`, change the import from Task 5 to:

```ts
import { recordPresenceLine, sweepPresence } from './presence.js';
```

In the `leave` / `return` branch from Task 5, directly after `if (change?.changed) hub.broadcast('refresh');`:

```ts
            // The plugin released a hold at its ceiling. Announced only on the
            // held to not held transition, so whichever of this line and the
            // sweep below gets there first is the one that speaks.
            if (change?.holdReleased && ev.kind === 'leave' && ev.auto) {
              publishAdminEvent({ kind: 'clock', what: 'hold_expired', steamid: ev.steamid, matchId: change.matchId, remainingS: ev.remaining });
            }
```

Directly after `reaper.unref();`:

```ts
  // The live board's clocks. Five seconds because the warning it posts is
  // about a countdown measured in tens of seconds; the pass is one indexed
  // read when nobody is dropped, which is nearly always.
  const presenceSweep = setInterval(() => {
    try {
      const events = sweepPresence(deps.db);
      for (const e of events) publishAdminEvent({ kind: 'clock', ...e });
      if (events.length > 0) hub.broadcast('refresh');
    } catch (err) {
      console.error('[presence] sweep failed:', err);
    }
  }, 5_000);
  presenceSweep.unref();
```

In the `onClose` hook, after `clearInterval(reaper);`:

```ts
    clearInterval(presenceSweep);
```

- [ ] **Step 7: Full suite, typecheck, commit**

Run: `npx vitest run && npm run typecheck`
Expected: green. `tests/presenceWiring.test.ts` still passes: the sweep finds nothing to say in its 80 ms.

```bash
git add src/presence.ts src/adminFeed.ts src/discord/adminFeedPoster.ts src/server.ts tests/presenceSweep.test.ts tests/discordAdminFeed.test.ts
git commit -m "Warn the admin feed once when a dropped player is nearly out of time"
```

---

### Task 9: Move the Servers, Queue and Recent results panels out of `AdminMatches.tsx`

A pure move, so both the Matches tab and the Live board render one implementation. No behaviour changes and no test changes: the existing Matches tab tests in `web/src/routes/admin.test.tsx` (lines 366-575) are the safety net and must pass untouched.

**Files:**
- Create: `web/src/routes/admin/MatchPanels.tsx`
- Modify: `web/src/routes/admin/AdminMatches.tsx` (whole file)

**Interfaces:**
- Consumes: `AdminOverview`, `Forecast`, `LogAuthMode`, `ServerLogAuth`, `MatchPause`, `MatchReadyup`, `adminApi` from `web/src/api.ts`; `Run`, `useAction`, `fmtTime` from `./useAction`.
- Produces, from `web/src/routes/admin/MatchPanels.tsx`:

```ts
export function Odds(props: { f: Forecast | null; winner?: string | null }): JSX.Element;
export function AdminServersPanel(props: { servers: AdminOverview['servers']; busy: boolean; run: Run }): JSX.Element;
export function AdminQueuePanel(props: { queue: AdminOverview['queue']; busy: boolean; run: Run }): JSX.Element;
export function RecentResultsPanel(props: { data: AdminOverview; busy: boolean; run: Run }): JSX.Element;
export function pauseText(p: MatchPause): string;
export function readyupText(r: MatchReadyup): string;
```

The queue panel is `AdminQueuePanel`, not `QueuePanel`: `web/src/routes/Play.tsx` already exports a `QueuePanel` and `admin.test.tsx` imports it.

- [ ] **Step 1: Confirm the net is green before moving anything**

Run: `npx vitest run web/src/routes/admin.test.tsx`
Expected: PASS. If it is not, stop: this task has nothing to stand on.

- [ ] **Step 2: Create `MatchPanels.tsx` by moving, not rewriting**

Create `web/src/routes/admin/MatchPanels.tsx` with this header:

```tsx
import { useState } from 'preact/hooks';
import { adminApi, type AdminOverview, type Forecast, type LogAuthMode, type ServerLogAuth } from '../../api';
import { campaignName } from '../../format';
import { Empty, Panel } from '../../components/bits';
import { fmtTime, useAction, type Run } from './useAction';
import { formatTime } from '../../replay/ReplayControls';
import type { MatchPause, MatchReadyup } from '../../api';

/**
 * The three panels that sit under whatever is showing the open matches: the
 * servers, the queue and the recent results. They lived inline in
 * AdminMatches until the live board needed the same three underneath it, and
 * two copies of the void form is how one of them stops working unnoticed.
 */
```

Then move these out of `AdminMatches.tsx`, body and doc comment unchanged:

| From `AdminMatches.tsx` | Into `MatchPanels.tsx` as |
|---|---|
| `function Odds` (lines 10-36, with its comment) | `export function Odds` |
| `function RestartCell` (264-300) | unchanged, not exported |
| `function LogAuthCell` (302-362) | unchanged, not exported |
| `function AdminSyncButton` (364-398) | unchanged, not exported |
| `export function pauseText` (400-408), `export function readyupText` (410-415) | unchanged, still exported |
| `function SourceTvCell` (417-447) | unchanged, not exported |

Then add the three panel components. Each wraps JSX moved verbatim from `AdminMatches`'s `return`, with `data.servers` becoming `servers`, `data.queue` becoming `queue`, and the `voiding` / `reason` state moving into `RecentResultsPanel`:

```tsx
export function AdminServersPanel({ servers, busy, run }: { servers: AdminOverview['servers']; busy: boolean; run: Run }) {
  return (
    <Panel class="panel--table">
      {/* lines 87-136 of the old AdminMatches.tsx, verbatim, with `data.servers` read as `servers` */}
    </Panel>
  );
}

export function AdminQueuePanel({ queue, busy, run }: { queue: AdminOverview['queue']; busy: boolean; run: Run }) {
  return (
    <Panel class="panel--table">
      {/* lines 139-153, verbatim, with `data.queue` read as `queue` */}
    </Panel>
  );
}

export function RecentResultsPanel({ data, busy, run }: { data: AdminOverview; busy: boolean; run: Run }) {
  const [voiding, setVoiding] = useState<number | null>(null);
  const [reason, setReason] = useState('');
  return (
    <Panel class="panel--table">
      {/* lines 158-258, verbatim */}
    </Panel>
  );
}
```

The three JSX comments above are instructions for this move, not code to keep: when the step is done each `<Panel>` contains the real JSX and those three comment lines are gone.

- [ ] **Step 3: `AdminMatches.tsx` is what is left**

After the move the file is:

```tsx
import { adminApi } from '../../api';
import { useFetch } from '../../hooks/useFetch';
import { campaignName } from '../../format';
import { Empty, Panel } from '../../components/bits';
import { fmtTime, useAction } from './useAction';
import { AdminQueuePanel, AdminServersPanel, Odds, RecentResultsPanel } from './MatchPanels';

export function AdminMatches() {
  const { data, reload } = useFetch((s) => adminApi.overview(s), []);
  const { busy, error, run } = useAction(reload);

  if (!data) return <Panel><p class="muted">Loading...</p></Panel>;

  return (
    <div class="stack">
      {error && <p class="error">{error}</p>}
      <Panel class="panel--table">
        {/* the Open matches panel, lines 50-82 of the old file, verbatim */}
      </Panel>

      <div class="admin-split admin-split--even">
        <AdminServersPanel servers={data.servers} busy={busy} run={run} />
        <AdminQueuePanel queue={data.queue} busy={busy} run={run} />
      </div>

      <RecentResultsPanel data={data} busy={busy} run={run} />
    </div>
  );
}
```

As in Step 2, the JSX comment marks where the unchanged Open matches JSX stays; it is not left in the file.

- [ ] **Step 4: Nothing else imported what moved**

Run: `grep -rn "pauseText\|readyupText\|from './admin/AdminMatches'\|from './AdminMatches'" web/src`
Expected: the only hits are `web/src/routes/Admin.tsx` importing `AdminMatches`, and `MatchPanels.tsx` itself. If anything else imports `pauseText` or `readyupText` from `AdminMatches`, point it at `./MatchPanels`.

- [ ] **Step 5: The net is still green**

Run: `npx vitest run web/src/routes/admin.test.tsx && npm run typecheck`
Expected: PASS, with `admin.test.tsx` unmodified (`git diff --stat web/src/routes/admin.test.tsx` prints nothing).

- [ ] **Step 6: Full suite, commit**

Run: `npx vitest run && npm run typecheck`
Expected: green.

```bash
git add web/src/routes/admin/MatchPanels.tsx web/src/routes/admin/AdminMatches.tsx
git commit -m "Move the servers, queue and recent results panels out of AdminMatches"
```

---

### Task 10: The Live board

**Files:**
- Create: `web/src/liveBoard.ts`, `web/src/liveBoard.test.ts`, `web/src/hooks/useHubEvent.ts`, `web/src/hooks/useElapsedSince.ts`, `web/src/routes/admin/AdminLive.tsx`, `web/src/routes/admin/AdminLive.test.tsx`
- Modify: `web/src/api.ts` (types after `AdminOverview` near line 760; two entries in `adminApi` near line 1026), `web/src/routes/Admin.tsx` (whole file is 60 lines), `web/src/routes/admin.test.tsx` (mock table lines 17-27, `beforeEach` lines 38-48, nine tests between lines 60 and 295), `web/src/styles/app.css` (append to the admin block near line 1545)

**Interfaces:**
- Consumes: `GET /api/admin/live` and `POST /api/admin/live/:matchId/players/:steamid/leave` (Tasks 6 and 7); `AdminServersPanel`, `AdminQueuePanel`, `RecentResultsPanel` (Task 9); `useAction`, `confirm` via `useAction`'s `ask` argument; `SpectatePanel`; `fmtClock`, `campaignName`, `mapName` from `web/src/format.ts`.
- Produces:

```ts
// web/src/api.ts
export type LiveBoardReason = { kind: 'signon_drop'; at: string } | { kind: 'not_in_voice' };
export type LiveBoardStatus =
  | { kind: 'connected'; remainingS: number | null }
  | { kind: 'never_connected'; sincePopS: number }
  | { kind: 'dropped'; sinceS: number; remainingS: number | null; held: boolean; holdLeftS: number | null };
export interface LiveBoardPlayer { steamid: string; name: string; team: 'a' | 'b'; status: LiveBoardStatus; reason: LiveBoardReason | null }
export interface LiveBoardClock { kind: 'abandon'; steamid: string; name: string; remainingS: number; held: boolean; holdLeftS: number | null }
export interface LiveBoardMatch { /* mirrors BoardMatch in src/admin/liveBoard.ts, field for field */ }
export interface LiveBoard { now: string; holdMaxMinutes: number; matches: LiveBoardMatch[] }
export type LeaveClockAction = 'hold' | 'release' | 'add' | 'end';
adminApi.live(signal?: AbortSignal): Promise<LiveBoard>;
adminApi.leaveClock(matchId: number, steamid: string, action: LeaveClockAction, seconds?: number): Promise<{ ok: true; reply: string }>;

// web/src/liveBoard.ts
export const OLD_PLUGIN_REASON: string;
export function countdown(startS: number | null, running: boolean, elapsedS: number): number | null;
export function countUp(startS: number, elapsedS: number): number;
export function reasonText(r: LiveBoardReason | null): string;
export const liveFromUrl: () => number | null;

// web/src/hooks/useHubEvent.ts
export function useHubEvent(names: string[], fn: () => void): void;
// web/src/hooks/useElapsedSince.ts
export function useElapsedSince(at: number | null): number;
// web/src/routes/admin/AdminLive.tsx
export function AdminLive(): JSX.Element;
```

#### Part A: types, API calls and the pure helpers

- [ ] **Step 1: Write the failing helper test**

`web/src/liveBoard.test.ts`:

```ts
import { describe, it, expect, afterEach } from 'vitest';
import { countdown, countUp, liveFromUrl, reasonText, OLD_PLUGIN_REASON } from './liveBoard';

describe('countdown', () => {
  it('runs down from what the server said, by whole seconds since it said it', () => {
    expect(countdown(258, true, 0)).toBe(258);
    expect(countdown(258, true, 0.9)).toBe(258);
    expect(countdown(258, true, 12.4)).toBe(246);
  });

  it('stops at zero', () => {
    expect(countdown(5, true, 60)).toBe(0);
  });

  it('stands still while it is held', () => {
    expect(countdown(258, false, 40)).toBe(258);
  });

  it('is unknown when the server did not know', () => {
    expect(countdown(null, true, 10)).toBeNull();
  });
});

describe('countUp', () => {
  it('adds the seconds since the payload arrived', () => {
    expect(countUp(42, 0)).toBe(42);
    expect(countUp(42, 18.7)).toBe(60);
  });
});

describe('reasonText', () => {
  it('words a connect drop with the time it happened', () => {
    expect(reasonText({ kind: 'signon_drop', at: '2026-09-21T14:02:00.000Z' })).toMatch(/^rejected by the file check at \d/);
  });

  it('words voice, and says nothing when nothing is known', () => {
    expect(reasonText({ kind: 'not_in_voice' })).toBe('not in a voice channel');
    expect(reasonText(null)).toBe('');
  });
});

describe('liveFromUrl', () => {
  afterEach(() => history.replaceState(null, '', '/admin'));

  it('reads the match the admin feed linked to', () => {
    history.replaceState(null, '', '/admin?live=81');
    expect(liveFromUrl()).toBe(81);
  });

  it('is null for anything that is not a match id', () => {
    history.replaceState(null, '', '/admin?live=abc');
    expect(liveFromUrl()).toBeNull();
    history.replaceState(null, '', '/admin');
    expect(liveFromUrl()).toBeNull();
  });
});

describe('the old plugin reason', () => {
  it('names the version, so the fix is obvious', () => {
    expect(OLD_PLUGIN_REASON).toContain('0.3.4');
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run web/src/liveBoard.test.ts`
Expected: FAIL, cannot resolve `./liveBoard`.

- [ ] **Step 3: The API types and calls**

`web/src/api.ts`, directly after the `AdminOverview` interface:

```ts
/** The admin live board. Mirrors src/admin/liveBoard.ts field for field.
 *  Every `...S` figure is whole seconds as of the moment the server answered;
 *  the page counts on from when the payload arrived and never compares
 *  anything here against its own wall clock. */
export type LiveBoardReason = { kind: 'signon_drop'; at: string } | { kind: 'not_in_voice' };
export type LiveBoardStatus =
  | { kind: 'connected'; remainingS: number | null }
  | { kind: 'never_connected'; sincePopS: number }
  | { kind: 'dropped'; sinceS: number; remainingS: number | null; held: boolean; holdLeftS: number | null };
export interface LiveBoardPlayer {
  steamid: string; name: string; team: 'a' | 'b'; status: LiveBoardStatus; reason: LiveBoardReason | null;
}
export interface LiveBoardClock {
  kind: 'abandon'; steamid: string; name: string; remainingS: number; held: boolean; holdLeftS: number | null;
}
export interface LiveBoardMatch {
  id: number;
  campaign: string;
  map: string | null;
  state: 'waiting' | 'configuring' | 'live' | 'paused';
  phase: 'live' | 'paused' | 'readyup' | 'roundover' | 'loading' | null;
  server: { id: number; name: string } | null;
  teamAScore: number;
  teamBScore: number;
  elapsedS: number;
  spectate: SpectateInfo | null;
  /** old_plugin: the server's pug-match predates 0.3.4 and has no clock control. */
  leaveControl: 'ok' | 'old_plugin' | 'unknown';
  teamA: LiveBoardPlayer[];
  teamB: LiveBoardPlayer[];
  clocks: LiveBoardClock[];
}
export interface LiveBoard { now: string; holdMaxMinutes: number; matches: LiveBoardMatch[] }
export type LeaveClockAction = 'hold' | 'release' | 'add' | 'end';
```

In `adminApi`, directly after `abortMatch`:

```ts
  live: (signal?: AbortSignal) => get<LiveBoard>('/api/admin/live', signal),
  leaveClock: (matchId: number, steamid: string, action: LeaveClockAction, seconds?: number) =>
    post<{ ok: true; reply: string }>(`/api/admin/live/${matchId}/players/${steamid}/leave`, { action, seconds }),
```

- [ ] **Step 4: Write `web/src/liveBoard.ts`**

```ts
import type { LiveBoardReason } from './api';

/** Shown on a disabled clock button, and as its title, when the match's
 *  server cannot do what the button asks. */
export const OLD_PLUGIN_REASON =
  'This server runs a pug-match older than 0.3.4, which cannot hold the clock. Update the plugin on it to use these.';

/** A figure the server gave in seconds, counted down by the whole seconds
 *  since the payload arrived. `running` false is a held clock, which stands
 *  still. Null in, null out: an allowance the server did not know is not 0. */
export function countdown(startS: number | null, running: boolean, elapsedS: number): number | null {
  if (startS === null) return null;
  if (!running) return startS;
  return Math.max(0, startS - Math.floor(elapsedS));
}

/** The same, upward: "dropped 0:42 ago", "1:30 since the pop". */
export function countUp(startS: number, elapsedS: number): number {
  return startS + Math.floor(elapsedS);
}

/** Why someone is missing, in the spec's words. Empty when nothing on record
 *  says: the board never guesses. */
export function reasonText(r: LiveBoardReason | null): string {
  if (!r) return '';
  if (r.kind === 'not_in_voice') return 'not in a voice channel';
  const at = new Date(r.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  return `rejected by the file check at ${at}`;
}

/** The match id in /admin?live=81, which is what the admin feed's low
 *  allowance warning links to. Moves to /admin/live with the routing plan. */
export const liveFromUrl = (): number | null => {
  const raw = new URLSearchParams(location.search).get('live');
  const id = raw === null ? NaN : Number(raw);
  return Number.isInteger(id) && id > 0 ? id : null;
};
```

- [ ] **Step 5: Run and watch it pass**

Run: `npx vitest run web/src/liveBoard.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 6: Commit part A**

```bash
git add web/src/api.ts web/src/liveBoard.ts web/src/liveBoard.test.ts
git commit -m "Add the live board types and the countdown arithmetic the page does itself"
```

#### Part B: the two hooks and the board component

- [ ] **Step 7: Write the failing component test**

`web/src/routes/admin/AdminLive.test.tsx`:

```tsx
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/preact';
import type { LiveBoard, LiveBoardPlayer, LiveBoardStatus, LiveBoardReason } from '../../api';
import { ConfirmHost } from '../../components/Confirm';

const { mockAdmin } = vi.hoisted(() => ({
  mockAdmin: { live: vi.fn(), overview: vi.fn(), leaveClock: vi.fn() },
}));

vi.mock('../../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../api')>();
  return { ...actual, adminApi: { ...actual.adminApi, ...mockAdmin } };
});

const { AdminLive } = await import('./AdminLive');
const { ApiError } = await import('../../api');

/** Stands in for the browser's WebSocket so a test can say "the hub just
 *  broadcast refresh" without a server. */
class FakeSocket {
  static all: FakeSocket[] = [];
  onmessage: ((m: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  constructor(public url: string) { FakeSocket.all.push(this); }
  close(): void {}
}

const player = (steamid: string, name: string, team: 'a' | 'b', status: LiveBoardStatus, reason: LiveBoardReason | null = null): LiveBoardPlayer =>
  ({ steamid, name, team, status, reason });

const board = (over: Partial<LiveBoard['matches'][number]> = {}): LiveBoard => ({
  now: '2026-09-21T20:10:00.000Z',
  holdMaxMinutes: 30,
  matches: [{
    id: 81, campaign: 'no_mercy', map: 'l4d_hospital02_subway', state: 'paused', phase: 'paused',
    server: { id: 1, name: 'Dallas' }, teamAScore: 412, teamBScore: 380, elapsedS: 1325,
    spectate: null, leaveControl: 'ok',
    teamA: [
      player('1', 'alice', 'a', { kind: 'connected', remainingS: null }),
      player('2', 'bob', 'a', { kind: 'dropped', sinceS: 42, remainingS: 258, held: false, holdLeftS: null }, { kind: 'signon_drop', at: '2026-09-21T20:09:00.000Z' }),
    ],
    teamB: [
      player('5', 'eve', 'b', { kind: 'never_connected', sincePopS: 200 }, { kind: 'not_in_voice' }),
      player('6', 'frank', 'b', { kind: 'connected', remainingS: 140 }),
    ],
    clocks: [{ kind: 'abandon', steamid: '2', name: 'bob', remainingS: 258, held: false, holdLeftS: null }],
    ...over,
  }],
});

const emptyOverview = { open: [], servers: [], recent: [], aborted: [], voided: [], queue: [], slowToReady: [] };

beforeEach(() => {
  for (const fn of Object.values(mockAdmin)) fn.mockReset();
  mockAdmin.live.mockResolvedValue(board());
  mockAdmin.overview.mockResolvedValue(emptyOverview);
  mockAdmin.leaveClock.mockResolvedValue({ ok: true, reply: 'PUGOK leave' });
  FakeSocket.all = [];
  vi.stubGlobal('WebSocket', FakeSocket);
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); history.replaceState(null, '', '/admin'); });

const row = async (name: string) => (await screen.findByText(name)).closest('li') as HTMLElement;

describe('the live board', () => {
  it('says so when nothing is running', async () => {
    mockAdmin.live.mockResolvedValue({ ...board(), matches: [] });
    render(<AdminLive />);
    expect(await screen.findByText('No match is running.')).toBeTruthy();
  });

  it('shows the match line and one status per player', async () => {
    render(<AdminLive />);
    const card = (await screen.findByText(/#81/)).closest('section') as HTMLElement;
    expect(card.textContent).toContain('Dallas');
    expect(card.textContent).toContain('412 - 380');
    expect(card.textContent).toContain('paused');
    expect((within(card).getByRole('link', { name: '#81' }) as HTMLAnchorElement).getAttribute('href')).toBe('/match/81');

    expect((await row('alice')).textContent).toContain('On the server');
    expect((await row('bob')).textContent).toContain('Dropped 0:42 ago');
    expect((await row('bob')).textContent).toContain('4:18 left');
    expect((await row('bob')).textContent).toMatch(/rejected by the file check at \d/);
    expect((await row('eve')).textContent).toContain('Never connected, 3:20 since the pop');
    expect((await row('eve')).textContent).toContain('not in a voice channel');
    expect((await row('frank')).textContent).toContain('2:20 of reconnect time left');
  });

  it('holds a dropped player\'s clock in one click, with no dialog in the way', async () => {
    render(<><AdminLive /><ConfirmHost /></>);
    fireEvent.click(within(await row('bob')).getByRole('button', { name: 'Hold' }));
    await waitFor(() => expect(mockAdmin.leaveClock).toHaveBeenCalledWith(81, '2', 'hold'));
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });

  it('adds five minutes', async () => {
    render(<AdminLive />);
    fireEvent.click(within(await row('bob')).getByRole('button', { name: '+5 min' }));
    await waitFor(() => expect(mockAdmin.leaveClock).toHaveBeenCalledWith(81, '2', 'add', 300));
  });

  it('offers Release, and the ceiling, for a held clock', async () => {
    mockAdmin.live.mockResolvedValue(board({
      teamA: [player('2', 'bob', 'a', { kind: 'dropped', sinceS: 90, remainingS: 250, held: true, holdLeftS: 1700 })],
    }));
    render(<AdminLive />);
    const bob = await row('bob');
    expect(bob.textContent).toContain('on hold');
    expect(bob.textContent).toContain('releases itself in 28:20');
    expect(within(bob).queryByRole('button', { name: 'Hold' })).toBeNull();
    fireEvent.click(within(bob).getByRole('button', { name: 'Release' }));
    await waitFor(() => expect(mockAdmin.leaveClock).toHaveBeenCalledWith(81, '2', 'release'));
  });

  it('asks, in the site\'s own dialog, before ending someone\'s time', async () => {
    render(<><AdminLive /><ConfirmHost /></>);
    fireEvent.click(within(await row('bob')).getByRole('button', { name: 'End now' }));
    const dialog = await waitFor(() => screen.getByRole('alertdialog'));
    expect(dialog.textContent).toContain('End bob\'s reconnect time now?');
    expect(dialog.textContent).toContain('banned');
    expect(mockAdmin.leaveClock).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole('button', { name: 'End now' }));
    await waitFor(() => expect(mockAdmin.leaveClock).toHaveBeenCalledWith(81, '2', 'end'));
  });

  it('lets an admin grant time to someone who is connected but has used some', async () => {
    render(<AdminLive />);
    fireEvent.click(within(await row('frank')).getByRole('button', { name: '+5 min' }));
    await waitFor(() => expect(mockAdmin.leaveClock).toHaveBeenCalledWith(81, '6', 'add', 300));
    expect(within(await row('alice')).queryByRole('button')).toBeNull();
  });

  it('disables the controls, and says why, on a server with an old plugin', async () => {
    mockAdmin.live.mockResolvedValue(board({ leaveControl: 'old_plugin' }));
    render(<AdminLive />);
    const bob = await row('bob');
    for (const name of ['Hold', '+5 min', 'End now']) {
      expect((within(bob).getByRole('button', { name }) as HTMLButtonElement).disabled).toBe(true);
    }
    expect(screen.getByText(/older than 0\.3\.4/)).toBeTruthy();
    fireEvent.click(within(bob).getByRole('button', { name: 'Hold' }));
    expect(mockAdmin.leaveClock).not.toHaveBeenCalled();
  });

  it('puts a failure on the card it happened on', async () => {
    mockAdmin.leaveClock.mockRejectedValue(new ApiError(502, 'could not reach Dallas: rcon connect timeout'));
    render(<AdminLive />);
    fireEvent.click(within(await row('bob')).getByRole('button', { name: 'Hold' }));
    const card = (await screen.findByText(/#81/)).closest('section') as HTMLElement;
    await waitFor(() => expect(within(card).getByText('could not reach Dallas: rcon connect timeout')).toBeTruthy());
  });

  it('keeps room for a sub action and builds nothing in it', async () => {
    render(<AdminLive />);
    const bob = await row('bob');
    const slot = bob.querySelector('.live-row__sub') as HTMLElement;
    expect(slot).toBeTruthy();
    expect(slot.children).toHaveLength(0);
  });

  it('fetches again when the hub says refresh, and not for the spectator feed', async () => {
    render(<AdminLive />);
    await screen.findByText(/#81/);
    expect(mockAdmin.live).toHaveBeenCalledTimes(1);
    FakeSocket.all[0].onmessage?.({ data: JSON.stringify({ event: 'live' }) });
    FakeSocket.all[0].onmessage?.({ data: JSON.stringify({ event: 'refresh' }) });
    await waitFor(() => expect(mockAdmin.live).toHaveBeenCalledTimes(2));
  });

  it('marks the card the admin feed linked to', async () => {
    history.replaceState(null, '', '/admin?live=81');
    render(<AdminLive />);
    const card = (await screen.findByText(/#81/)).closest('section') as HTMLElement;
    expect(card.className).toContain('is-target');
  });

  it('renders the servers, queue and recent results underneath', async () => {
    mockAdmin.overview.mockResolvedValue({
      ...emptyOverview,
      servers: [{ id: 1, name: 'Dallas', host: '1.2.3.4', port: 27015, status: 'live', enabled: 1, tvEnabled: 0, tvPort: null, tvPassword: null }],
      queue: [{ steamid: '9', name: 'queued', avatar: null }],
    });
    render(<AdminLive />);
    expect(await screen.findByRole('heading', { name: 'Servers' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Queue' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Recent results' })).toBeTruthy();
    expect(screen.getByText('queued')).toBeTruthy();
  });
});
```

- [ ] **Step 8: Run it and watch it fail**

Run: `npx vitest run web/src/routes/admin/AdminLive.test.tsx`
Expected: FAIL, cannot resolve `./AdminLive`.

- [ ] **Step 9: `useHubEvent`**

`web/src/hooks/useHubEvent.ts`:

```ts
import { useEffect, useRef } from 'preact/hooks';

/**
 * Call `fn` when the server's hub broadcasts one of `names`.
 *
 * The app's own socket lives in useLiveState at the root and re-fetches the
 * player state on EVERY message, whatever it is called. The admin board cannot
 * ride that: the spectator feed broadcasts 'live' several times a second
 * during a match, and the board wants 'refresh' only. So it listens for
 * itself, by name. One extra socket per open admin board is nothing.
 *
 * Same reconnect as useLiveState. Does nothing where there is no WebSocket.
 */
export function useHubEvent(names: string[], fn: () => void): void {
  const latest = useRef(fn);
  latest.current = fn;
  const key = names.join(',');

  useEffect(() => {
    if (typeof WebSocket === 'undefined') return undefined;
    const wanted = new Set(key.split(','));
    let ws: WebSocket | null = null;
    let retry: ReturnType<typeof setTimeout> | null = null;
    let closed = false;

    const connect = () => {
      if (closed) return;
      const proto = location.protocol === 'https:' ? 'wss' : 'ws';
      ws = new WebSocket(`${proto}://${location.host}/ws`);
      ws.onmessage = (m) => {
        try {
          const { event } = JSON.parse(String(m.data)) as { event?: string };
          if (event && wanted.has(event)) latest.current();
        } catch {
          /* not one of ours */
        }
      };
      ws.onclose = () => {
        if (!closed) retry = setTimeout(connect, 2000);
      };
    };
    connect();

    return () => {
      closed = true;
      if (retry) clearTimeout(retry);
      ws?.close();
    };
  }, [key]);
}
```

- [ ] **Step 10: `useElapsedSince`**

`web/src/hooks/useElapsedSince.ts`:

```ts
import { useEffect, useState } from 'preact/hooks';

/**
 * Seconds since `at` (an epoch millisecond from Date.now()), re-rendered as
 * it grows.
 *
 * THE ticker for the live board: called once, at the top, and the number is
 * handed down. Every countdown on the page is the server's figure minus this,
 * so they all flip on the same frame and a board with two matches and three
 * dropped players still runs one interval, not one per row. 250 ms for the
 * same reason Countdown.tsx polls at that rate: the displayed second flips
 * close to when it really changes.
 *
 * Only ever compares Date.now() with an earlier Date.now() from the same
 * browser, so a wrong clock on the admin's machine cancels out.
 */
export function useElapsedSince(at: number | null): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(id);
  }, []);
  return at === null ? 0 : Math.max(0, (now - at) / 1000);
}
```

- [ ] **Step 11: Write `AdminLive.tsx`**

`web/src/routes/admin/AdminLive.tsx`:

```tsx
import { useEffect, useRef, useState } from 'preact/hooks';
import { adminApi, type LiveBoard, type LiveBoardMatch, type LiveBoardPlayer } from '../../api';
import { useFetch } from '../../hooks/useFetch';
import { useHubEvent } from '../../hooks/useHubEvent';
import { useElapsedSince } from '../../hooks/useElapsedSince';
import { campaignName, fmtClock, mapName } from '../../format';
import { Empty, Panel } from '../../components/bits';
import { SpectatePanel } from '../../components/SpectatePanel';
import { useAction, type Run } from './useAction';
import { AdminQueuePanel, AdminServersPanel, RecentResultsPanel } from './MatchPanels';
import { OLD_PLUGIN_REASON, countdown, countUp, liveFromUrl, reasonText } from '../../liveBoard';

/** A safety net under the websocket, not the mechanism: a nudge lost while
 *  the socket was reconnecting must not leave a countdown wrong for long. */
const FALLBACK_POLL_MS = 15_000;
const ADD_SECONDS = 300;

/**
 * The admin landing page: every ongoing match, who is missing from it, and
 * the clock that is about to end it.
 *
 * Built for one moment. A player has dropped, the abandon timer is running,
 * and an admin has seconds to stop it (the owner lost a ranked match to
 * exactly that, 2026-09-21). So Hold is one click with no dialog, it sits on
 * the row with the red countdown, and the only thing that asks first is the
 * one that cannot be taken back.
 *
 * The page does no clock arithmetic against the server's time. The payload
 * gives every figure in seconds as of its own `now`; this counts on from the
 * moment the payload arrived, with one ticker for the whole board.
 */
export function AdminLive() {
  const [nudge, setNudge] = useState(0);
  useHubEvent(['refresh'], () => setNudge((n) => n + 1));
  useEffect(() => {
    const t = setInterval(() => setNudge((n) => n + 1), FALLBACK_POLL_MS);
    return () => clearInterval(t);
  }, []);

  const live = useFetch((s) => adminApi.live(s), [nudge]);
  const overview = useFetch((s) => adminApi.overview(s), [nudge]);

  // The last board that loaded, with when it arrived. A failed re-fetch keeps
  // the old one up rather than blanking the screen mid-emergency, and the
  // arrival time is what every countdown on the page is measured from.
  const [board, setBoard] = useState<{ data: LiveBoard; at: number } | null>(null);
  useEffect(() => {
    if (live.data) setBoard({ data: live.data, at: Date.now() });
  }, [live.data]);
  const elapsedS = useElapsedSince(board?.at ?? null);

  const panels = useAction(() => overview.reload());
  const target = useRef(liveFromUrl()).current;

  if (!board) return <Panel><p class="muted">Loading...</p></Panel>;

  return (
    <div class="stack">
      {live.error && <p class="error">Could not refresh the board. Showing the last one that loaded.</p>}
      {board.data.matches.length === 0 ? (
        <Panel><Empty>No match is running.</Empty></Panel>
      ) : board.data.matches.map((m) => (
        <MatchCard key={m.id} match={m} elapsedS={elapsedS} holdMaxMinutes={board.data.holdMaxMinutes}
          reload={live.reload} isTarget={m.id === target} />
      ))}

      {overview.data && (
        <>
          {panels.error && <p class="error">{panels.error}</p>}
          <div class="admin-split admin-split--even">
            <AdminServersPanel servers={overview.data.servers} busy={panels.busy} run={panels.run} />
            <AdminQueuePanel queue={overview.data.queue} busy={panels.busy} run={panels.run} />
          </div>
          <RecentResultsPanel data={overview.data} busy={panels.busy} run={panels.run} />
        </>
      )}
    </div>
  );
}

function MatchCard({ match: m, elapsedS, holdMaxMinutes, reload, isTarget }: {
  match: LiveBoardMatch; elapsedS: number; holdMaxMinutes: number; reload: () => void; isTarget: boolean;
}) {
  // Per card, so a failure shows on the match it happened to and a busy
  // button on one match does not freeze the Hold on another.
  const { busy, error, run } = useAction(reload);
  const el = useRef<HTMLElement>(null);
  useEffect(() => {
    if (isTarget) el.current?.scrollIntoView?.({ block: 'start' });
  }, [isTarget]);
  const blocked = m.leaveControl === 'old_plugin' ? OLD_PLUGIN_REASON : null;

  return (
    <section class={`panel live-card${isTarget ? ' is-target' : ''}`} ref={el}>
      <header class="live-card__line">
        <h3><a href={`/match/${m.id}`}>#{m.id}</a> {campaignName(m.campaign)}</h3>
        <span class="muted">{m.map ? mapName(m.map) : 'no map yet'}</span>
        <span class={`admin-status admin-status--${m.state === 'live' ? 'idle' : 'reserved'}`}>
          {m.state === 'waiting' ? 'waiting for a server' : m.state}
        </span>
        <span class="mono">{m.teamAScore} - {m.teamBScore}</span>
        <span class="muted">{m.server ? m.server.name : 'no server'}</span>
        <span class="muted mono" title="Since it went live, or since the pop while it has not">{fmtClock(countUp(m.elapsedS, elapsedS))}</span>
        {m.spectate && <SpectatePanel spectate={m.spectate} />}
      </header>

      <p class="live-card__clocks">
        {m.clocks.length === 0 ? <span class="muted">No clocks running.</span> : m.clocks.map((c) => {
          const left = countdown(c.remainingS, !c.held, elapsedS) ?? 0;
          return (
            <span key={c.steamid} class={`live-clock${c.held ? ' is-held' : left <= 90 ? ' is-low' : ''}`}>
              {c.name} <span class="mono">{fmtClock(left)}</span> {c.held ? 'on hold' : 'to reconnect'}
            </span>
          );
        })}
      </p>

      {blocked && <p class="error">{blocked}</p>}
      {error && <p class="error">{error}</p>}

      <div class="live-card__teams">
        {([['Team A', m.teamA], ['Team B', m.teamB]] as const).map(([label, team]) => (
          <div key={label}>
            <h4>{label}</h4>
            <ul class="live-roster">
              {team.map((p) => (
                <PlayerRow key={p.steamid} match={m} player={p} elapsedS={elapsedS}
                  holdMaxMinutes={holdMaxMinutes} busy={busy} run={run} blocked={blocked} />
              ))}
            </ul>
          </div>
        ))}
      </div>
    </section>
  );
}

function PlayerRow({ match: m, player: p, elapsedS, holdMaxMinutes, busy, run, blocked }: {
  match: LiveBoardMatch; player: LiveBoardPlayer; elapsedS: number; holdMaxMinutes: number;
  busy: boolean; run: Run; blocked: string | null;
}) {
  const s = p.status;
  const off = busy || blocked !== null;
  const why = blocked ?? undefined;
  const add = (
    <button class="chip" type="button" disabled={off} title={why ?? 'Five more minutes of reconnect time'}
      onClick={() => run(() => adminApi.leaveClock(m.id, p.steamid, 'add', ADD_SECONDS))}>+5 min</button>
  );

  return (
    <li class={`live-row live-row--${s.kind}`}>
      <a class="live-row__name" href={`/player/${p.steamid}`}>{p.name}</a>

      <span class="live-row__status">
        {s.kind === 'connected' && (
          <>On the server{s.remainingS !== null && <span class="muted">, {fmtClock(s.remainingS)} of reconnect time left</span>}</>
        )}
        {s.kind === 'never_connected' && <>Never connected, {fmtClock(countUp(s.sincePopS, elapsedS))} since the pop</>}
        {s.kind === 'dropped' && (() => {
          const left = countdown(s.remainingS, !s.held, elapsedS);
          const holdLeft = countdown(s.holdLeftS, s.held, elapsedS);
          return (
            <>
              Dropped {fmtClock(countUp(s.sinceS, elapsedS))} ago
              {left !== null && (
                <span class={`live-row__left mono${s.held ? ' is-held' : left <= 90 ? ' is-low' : ''}`}> {fmtClock(left)} left</span>
              )}
              {s.held && (
                <span class="admin-tag"> on hold{holdLeft !== null ? `, releases itself in ${fmtClock(holdLeft)}` : ''}</span>
              )}
            </>
          );
        })()}
        {p.reason && <span class="live-row__reason muted">{reasonText(p.reason)}</span>}
      </span>

      <span class="live-row__actions">
        {s.kind === 'dropped' && (
          <>
            {s.held ? (
              <button class="btn" type="button" disabled={off} title={why}
                onClick={() => run(() => adminApi.leaveClock(m.id, p.steamid, 'release'))}>Release</button>
            ) : (
              // No dialog, on purpose. This is the button that has to beat a
              // countdown, and it is undone by the one next to it.
              <button class="btn" type="button" disabled={off}
                title={why ?? `Stops this clock until you release it, for up to ${holdMaxMinutes} minutes`}
                onClick={() => run(() => adminApi.leaveClock(m.id, p.steamid, 'hold'))}>Hold</button>
            )}
            {add}
            <button class="chip" type="button" disabled={off} title={why}
              onClick={() => run(() => adminApi.leaveClock(m.id, p.steamid, 'end'), {
                title: `End ${p.name}'s reconnect time now?`,
                body: `Match #${m.id} ends as an abandon within a second. Nobody's rating changes and ${p.name} is banned `
                  + 'on the usual ladder. This cannot be taken back from here.',
                confirmLabel: 'End now',
                danger: true,
              })}>End now</button>
          </>
        )}
        {/* Someone who is back but has already spent allowance: the player
            whose connection keeps dropping, given time before the next one. */}
        {s.kind === 'connected' && s.remainingS !== null && add}
      </span>

      {/* Reserved: "Bring in a sub". The owner has not designed substitutes
          yet (spec, decision 4: leave room, build nothing). The empty cell
          holds the row's last column so adding the button later moves
          nothing. Do not put anything in here until that design exists. */}
      <span class="live-row__sub" aria-hidden="true" />
    </li>
  );
}
```

- [ ] **Step 12: The styles**

Append to `web/src/styles/app.css`, at the end of the `/* ---------- admin ---------- */` block (after the `.admin-status--*` rules near line 1545):

```css
/* ---------- admin: live board ---------- */

.live-card { padding: var(--sp-4); }
/* The card the admin feed linked to. */
.live-card.is-target { border-color: var(--accent); }
.live-card__line { display: flex; flex-wrap: wrap; gap: var(--sp-3); align-items: baseline; }
.live-card__line h3 { margin: 0; }
.live-card__clocks { display: flex; flex-wrap: wrap; gap: var(--sp-3); margin: var(--sp-2) 0 var(--sp-3); font-size: var(--fs-dense); }
.live-clock.is-low { color: var(--loss); }
.live-clock.is-held { color: var(--rating); }
.live-card__teams { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: var(--sp-5); }
@media (max-width: 900px) { .live-card__teams { grid-template-columns: minmax(0, 1fr); } }

.live-roster { list-style: none; margin: 0; padding: 0; }
/* name | status | actions | the reserved sub slot. The last column has a
 * fixed width and nothing in it, so the day a sub button arrives the other
 * three do not move. */
.live-row {
  display: grid; grid-template-columns: minmax(6rem, 10rem) minmax(0, 1fr) auto 6rem;
  gap: var(--sp-2); align-items: center; padding: var(--sp-2) 0; border-bottom: 1px solid var(--border);
}
.live-row--connected .live-row__status { color: var(--win); }
.live-row--never_connected .live-row__status, .live-row--dropped .live-row__status { color: var(--text); }
.live-row__left { font-size: 1.15em; }
.live-row__left.is-low { color: var(--loss); }
.live-row__left.is-held { color: var(--rating); }
.live-row__reason { display: block; font-size: var(--fs-dense); }
.live-row__actions { display: flex; flex-wrap: wrap; gap: var(--sp-2); justify-content: flex-end; }
@media (max-width: 640px) {
  .live-row { grid-template-columns: minmax(0, 1fr); }
  .live-row__actions { justify-content: flex-start; }
  .live-row__sub { display: none; }
}
```

- [ ] **Step 13: Run and watch it pass**

Run: `npx vitest run web/src/routes/admin/AdminLive.test.tsx web/src/liveBoard.test.ts && npm run typecheck`
Expected: PASS.

If `marks the card the admin feed linked to` fails on `scrollIntoView` not being a function under happy-dom, that is what the `?.` after `scrollIntoView` in `MatchCard` is for; confirm it is there rather than mocking it.

- [ ] **Step 14: Commit part B**

```bash
git add web/src/hooks/useHubEvent.ts web/src/hooks/useElapsedSince.ts web/src/routes/admin/AdminLive.tsx \
  web/src/routes/admin/AdminLive.test.tsx web/src/styles/app.css
git commit -m "Build the live board: who is missing, the countdown, and Hold in one click"
```

#### Part C: make it the first tab, and the default for admins

- [ ] **Step 15: Change the existing tests first, and add the two new ones**

In `web/src/routes/admin.test.tsx`:

1. In the hoisted `mockAdmin` table (line 18), add `live: vi.fn(), leaveClock: vi.fn(),` beside `overview: vi.fn()`.

2. In `beforeEach`, after the `for` loop that resets the mocks, add:

```ts
  // Live is the admin's landing tab now, so every render of <Admin> asks for
  // the board and the overview before any test has clicked anything. These
  // are the empty answers; a test that cares overrides them after this runs.
  mockAdmin.live.mockResolvedValue({ now: '2026-09-21T20:00:00.000Z', holdMaxMinutes: 30, matches: [] });
  mockAdmin.overview.mockResolvedValue({ open: [], servers: [], recent: [], aborted: [], voided: [], queue: [], slowToReady: [] });
  // Node has a global WebSocket and happy-dom does not replace it, so without
  // this the board's hub listener would dial ws://localhost from every test.
  vi.stubGlobal('WebSocket', undefined);
```

3. Below the `me` constant (line 51), add:

```ts
/** Players was the default tab until Live became the landing page. */
const openPlayers = () => fireEvent.click(screen.getByRole('tab', { name: 'Players' }));
```

4. In each of these nine tests, add `openPlayers();` on the line directly after the `render(...)` call. They are the ones that render `<Admin>` and then wait for a player's name without clicking a tab:
   - `lists players, opens a detail and bans with a reason` (line 60)
   - `shows a connect drops line that links to the rows` (84)
   - `says which other Steam account a player's Discord used to be on` (116)
   - `signs a player out everywhere, after asking` (136)
   - `says none, with no section, for a player with no connect drops` (155)
   - `shows the Steam account as context: age, bans, hours, level and the lender` (183)
   - `says hidden rather than zero for a private profile, and unknown lenders by id` (227)
   - `says Steam has not been asked yet, and asks on request` (252)
   - `shows what an input flag rests on, what its holds look like, and any truncated capture` (266)

5. Add to `describe('Admin page', ...)`, directly after `refuses a non-admin without calling the admin API`:

```ts
  it('lands an admin on the live board, which is the first tab', async () => {
    render(<Admin session={{ kind: 'active', me }} />);
    const tabs = screen.getAllByRole('tab');
    expect(tabs[0].textContent).toBe('Live');
    expect(tabs[0].getAttribute('aria-selected')).toBe('true');
    expect(await screen.findByText('No match is running.')).toBeTruthy();
    expect(mockAdmin.players).not.toHaveBeenCalled();
  });

  it('does not offer the live board to a moderator', () => {
    render(<Admin session={{ kind: 'active', me: { ...me, isAdmin: false, isMod: true } }} />);
    expect(screen.queryByRole('tab', { name: 'Live' })).toBeNull();
    expect(mockAdmin.live).not.toHaveBeenCalled();
  });
```

Run: `npx vitest run web/src/routes/admin.test.tsx`
Expected: FAIL. The nine edited tests fail on `Unable to find an accessible element with the role "tab" and name "Players"`? No: that tab exists today, so they still pass. What fails is the two new tests: there is no `Live` tab, and `No match is running.` never appears.

- [ ] **Step 16: `Admin.tsx`**

Add the import beside the other tab imports:

```tsx
import { AdminLive } from './admin/AdminLive';
```

Replace the head of `TABS`:

```tsx
const TABS = [
  // First, and where an admin lands: the commonest reason anyone opens this
  // panel is a problem with a match that is running right now. A tab for the
  // moment, not a route: the admin routing plan (/admin/live, /admin/people)
  // is separate work, and whichever of the two lands second moves this there.
  { key: 'live', label: 'Live' },
  { key: 'players', label: 'Players' },
```

(the remaining seven entries are unchanged.)

Replace the `useState` line:

```tsx
  const [tab, setTab] = useState(() => (ticketFromUrl() !== null ? 'tickets' : 'live'));
```

Add as the first line inside `<div class="admin-body">`:

```tsx
        {active === 'live' && <AdminLive />}
```

Update the component's doc comment so its last sentence reads: `A moderator gets the Tickets tab and nothing else; an admin lands on Live.`

A moderator is unaffected: `tabs` is still filtered to `tickets` and `active` is still forced to `'tickets'`, so `AdminLive` never mounts for them and `/api/admin/live` is never asked for.

- [ ] **Step 17: Run and watch them pass**

Run: `npx vitest run web/src/routes/admin.test.tsx web/src/routes/tickets.test.tsx web/src/routes/routes.test.tsx`
Expected: PASS.

If any other web test renders `<Admin>` as an admin with no `?ticket=` in the URL and then expects the Players tab's content, it needs the same one-line `openPlayers()` treatment. `tickets.test.tsx` does not: its one admin render (line 107) sets `/admin?ticket=12` first, which still opens Tickets.

- [ ] **Step 18: Full suite, typecheck, commit**

Run: `npx vitest run && npm run typecheck`
Expected: green.

```bash
git add web/src/routes/Admin.tsx web/src/routes/admin.test.tsx
git commit -m "Put the live board on the admin panel as its first tab"
```

---

### Task 11: Verify the whole thing, and hand the owner the two tests only he can run

Nothing in this task starts, stops or contacts a game server. The agent's part ends at a clean compile; both server tests are written out for the owner, to run on his go-ahead.

**Files:**
- Modify: none, unless a step below turns up a fault. A fix gets its own commit with a plain sentence saying what was wrong.

**Interfaces:**
- Consumes: everything above.
- Produces: a verified branch and a handoff note.

- [ ] **Step 1: The full suite**

Run: `npx vitest run`
Expected: every file in both projects passes. New in this plan: `tests/leaveCommandParity.test.ts`, `tests/leaveLineParse.test.ts`, `tests/presenceSchema.test.ts`, `tests/presence.test.ts`, `tests/presenceWiring.test.ts`, `tests/leaveControl.test.ts`, `tests/adminLive.test.ts`, `tests/liveBoard.test.ts`, `tests/presenceSweep.test.ts`, `web/src/liveBoard.test.ts`, `web/src/routes/admin/AdminLive.test.tsx`.

- [ ] **Step 2: Types**

Run: `npm run typecheck`
Expected: no output from either `tsc` run.

Pay attention to one thing `tsc` enforces for free: `FEED_SETTING` in `src/adminFeed.ts` is a `Record<AdminEvent['kind'], string>` and the `switch` in `AdminFeedPoster.line` is exhaustive, so a `clock` event without its setting or its wording is a compile error, not a silent gap.

- [ ] **Step 3: The plugin compiles clean, from a clean tree**

Run: `cd /home/volence/l4d/pug/.claude/worktrees/admin-desks/plugin && rm -f pug-match.smx && ./build.sh`
Expected: `built: /home/volence/l4d/pug/.claude/worktrees/admin-desks/plugin/pug-match.smx`, no `error`, no `warning`.

Then: `git status --short plugin/`
Expected: nothing. The `.smx` is gitignored, and `build.sh`'s trap has removed everything it copied into the Rotoblin scripting tree.

- [ ] **Step 4: No em dashes, anywhere this plan touched**

Run: `git diff master --name-only | xargs grep -n $'\u2014' ; echo "exit $?"`
Expected: no matches, `exit 1` (or `exit 123` from xargs, which also means grep found nothing).

- [ ] **Step 5: Backward compatibility, read back from the tests**

Confirm each of these is asserted by a test that passed in Step 1. This is the "web deploys before plugins" constraint, and it is the one that fails in production rather than in CI if it is wrong.

| The new backend, against pug-match 0.3.3 | Pinned by |
|---|---|
| `LEAVE steamid= remaining=` parses to the exact old object | `tests/abandon.test.ts:44`, `tests/leaveLineParse.test.ts` first case |
| Match setup succeeds when `sm_pug_leave_hold_max` is an unknown command | `tests/orchestrator.test.ts`, `notices a plugin too old ...` |
| A clock action answers 409 `old_plugin`, writes nothing, and the board greys out | `tests/adminLive.test.ts`, `an old plugin is recognised ...`; `AdminLive.test.tsx`, `disables the controls ...` |
| Presence still works: LEAVE, RETURN and connect need nothing from 0.3.4 | `tests/presence.test.ts`, every case that sends no `held` |
| `sm_pug_status`'s abandon confirmation still matches | `tests/leaveCommandParity.test.ts`, `keeps the STATUS line abandon.ts reads` |

- [ ] **Step 6: Hand the owner the empty-server smoke test**

Do not run this. Put it in the handoff message, word for word. It is part A of the new `plugin/TESTING.md` section, and it is limited on purpose: hold, release and end need a rostered player who has really dropped, so an empty server can only prove that the command exists, that the token check works, and that an unknown player is refused.

````markdown
**Smoke test, on your go-ahead, on an EMPTY server only.** Stage pug-match 0.3.4 the way you
normally do (`plugin/stage.sh`), check `R status` shows 0 humans, then:

    T=$(openssl rand -hex 16)
    R "sm plugins info pug-match"                                        # Version: 0.3.4
    R "sm_pug_match 999999 $T NoMercy"                                   # PUGOK match=999999
    R "sm_pug_leave"                                                     # PUGERR token required
    R "sm_pug_leave 00000000000000000000000000000000 76561198000000002 hold"   # PUGERR bad token
    R "sm_pug_leave $T"                                                  # PUGERR usage: sm_pug_leave ...
    R "sm_pug_leave $T 76561198000000002 hold"                           # PUGERR not rostered
    R "sm_pug_leave_hold_max"                                            # 1800
    R "sm_pug_status"                                                    # STATUS leave abandoner=none ... holdmax=1800
    R "sm_pug_abort $T"                                                  # PUGOK aborted

`sm_pug_match` puts the plugin into a pending state with a throwaway token and nobody
rostered; `sm_pug_abort` takes it straight back out. Nothing is kicked, no map changes, and
the box is exactly as it was afterwards. If `sm_pug_leave` answers `Unknown command`, the
new `.smx` is not the one that is loaded.
````

- [ ] **Step 7: Hand the owner the real-client checklist**

Also for the handoff message. The full steps, with their expected output, are part B of `## Reconnect clock control` in `plugin/TESTING.md`; this is the list of what they prove, so he can see what is and is not yet verified.

```markdown
**With a real client (you can be the player who drops; rcon keeps working while you are out):**

- [ ] add for a connected player answers `absent=0` and echoes a RETURN line
- [ ] hold for a connected player is refused: `PUGERR not dropped`
- [ ] hold freezes `remaining` (two status reads ten seconds apart agree) and echoes `LEAVE ... held=1`
- [ ] the ceiling (`sm_pug_leave_hold_max 20`) releases it and echoes `LEAVE ... held=0 auto=1`
- [ ] release twice is harmless
- [ ] a hold survives a changelevel, with nothing about timer handles in the SourceMod error log
- [ ] rejoining while held ends the hold and charges nothing for the held time
- [ ] aborting while held leaves no leave state behind for the next match
- [ ] end produces ABANDON within two seconds, and further commands answer `PUGERR match already abandoned`

**Then, once the web side is deployed, one pass through the board itself on a real match:**
drop, watch the row go red and count down, press Hold, watch it stop, press Release,
press +5 min, rejoin. And the feed: with `abandon_low_alert_seconds` at its default 90,
one warning in the admin channel as the countdown passes 1:30, linking to `/admin?live=<id>`.
```

- [ ] **Step 8: State what is not done**

Put this in the handoff too, so nothing is assumed:

- Not deployed, and not merged to master.
- The `.smx` is built locally and staged nowhere.
- Steps 6 and 7 have not been run by anyone.
- The "Steam ID not verified" reason is not built, because the plugin has no SteamID to report at the moment it kicks for that.
- The no-show clock control, cancel with a penalty choice and waive are part two.
- If the People plan has landed first, `AdminLive` still has to move to `/admin/live`, and the link in `AdminFeedPoster`'s `clock` case has to move with it.

---

## Spec ambiguities resolved

1. **How the countdown is anchored.** The spec says countdowns tick "from `since` and `remaining_s`", which stops being true after the first hold or add. `since` stays "when they left". A new column, `remaining_at`, anchors the figure. The API sends durations as of its own `now`, so the admin's PC clock never enters the arithmetic.
2. **Which verb echoes a command's result.** The spec says "echoes the new state as a LEAVE line", but `add` is allowed for a connected player and LEAVE would mark them dropped. A dropped player echoes LEAVE with optional `held=`, `hold_left=` and `auto=`. A connected one echoes RETURN, which already means "here, with this much left".
3. **Which side enforces the hold ceiling.** The spec names both the website and the plugin. The website pushes `clock_hold_max_minutes` to `sm_pug_leave_hold_max` at setup, so the plugin is the one enforcer. The backend mirrors `hold_until` from the plugin's `hold_left`, flips the row locally if the `auto=1` line is lost, and posts the feed line only on the held to not held transition.
4. **What PLAYER disconnect does.** The spec lists three writers (LEAVE, RETURN, connect). PLAYER disconnect is ignored on purpose: it pulses for every client on every changelevel and would flash the whole roster as dropped. A real departure already has LEAVE.
5. **Once per drop, old plugins, and the reasons.** The low-allowance alert stamps `low_alert_at` in the table; it survives a restart and resets on the next drop, not on an add. Old plugins are detected for free from the setup reply and again lazily from an action's answer, both into `matches.leave_control`. "Steam ID not verified" is left out rather than guessed, since the plugin kicks for it exactly when it has no id to report.
