// ---------- pause limits: a ceiling per pause, a budget per campaign ----------
//
// Rotoblin's pause module has exactly two knobs, on/off and a delay, and
// neither of them limits anything. A pause ends when both teams type !ready,
// so a team that simply never readies holds the game frozen for as long as it
// likes, and nothing counts how often a team has done it.
//
// Two rules, from the ranked rules rather than from anything technical:
//
//   * a pause lasts at most `sm_pug_pause_seconds`, then the game resumes
//   * each team gets `sm_pug_pause_limit` pauses per campaign
//
// Disconnect pauses are outside both. Those come from pug-leave.inc, which
// already governs them with its own per-player reconnect allowance, and
// charging a team for a pause it did not ask for (or unfreezing the game
// while someone is still trying to reconnect) would be wrong twice over.
//
// WHY THE COUNTING IS NOT DONE IN THE COMMAND LISTENER. The obvious
// implementation charges a pause when `sm_pause` is seen. But Rotoblin is the
// one that decides whether a pause actually happens: it refuses during
// ready-up, when already paused, and when `rotoblin_pause` is off. Charging on
// intent would bill a team for pauses that never occurred, and the error is
// silent and cumulative. So the listener only ever REFUSES, and the counting
// is driven by an observed transition into pause. What gets charged is what
// actually happened.

/** Set for the moment it takes pug-leave.inc to issue its own `sm_pause`, so
 *  the listener lets it through unbudgeted and the transition that follows is
 *  attributed to nobody. */
bool g_bPauseInternal;

/** Called by pug-leave.inc immediately before it issues its own `sm_pause`.
 *  A function rather than the flag itself because that file is included first,
 *  and SourcePawn resolves a call to a later function but not a reference to a
 *  later global. */
void PauseAllowInternal()
{
	g_bPauseInternal = true;
}

ConVar g_cvPauseSeconds;
ConVar g_cvPauseLimit;

int g_iPauseUsed[3];          // [1] pug team a, [2] pug team b
int g_iPausePendingTeam;      // team whose sm_pause we allowed and have not yet seen take effect
int g_iPauseOwner;            // team charged for the pause in progress; 0 = none or not chargeable
bool g_bPauseSeen;            // whether the game was paused on the previous tick
float g_fPauseStarted;        // engine time the current pause began
float g_fPauseHeld;           // seconds the ceiling clock has been held while a player is absent
int g_iPauseWarned;           // last warning threshold announced, in seconds remaining

void PauseInit()
{
	g_cvPauseSeconds = CreateConVar("sm_pug_pause_seconds", "120",
		"A pause is force-unpaused after this many seconds. 0 disables the ceiling.",
		FCVAR_NOTIFY, true, 0.0, true, 1800.0);
	g_cvPauseLimit = CreateConVar("sm_pug_pause_limit", "3",
		"Pauses each team may call per campaign. Disconnect pauses do not count. 0 disables the budget.",
		FCVAR_NOTIFY, true, 0.0, true, 20.0);

	// Rotoblin registers sm_pause with RegConsoleCmd, so a listener here runs
	// before its callback and can refuse the pause without forking it.
	AddCommandListener(Listener_PugPause, "sm_pause");

	CreateTimer(1.0, Timer_PauseClock, _, TIMER_REPEAT | TIMER_FLAG_NO_MAPCHANGE);
}

/** A new campaign. Called from the same match reset as LeaveReset, which is
 *  what makes the budget per campaign rather than per map: a map change does
 *  not come through here. */
void PauseReset()
{
	g_iPauseUsed[1] = 0;
	g_iPauseUsed[2] = 0;
	g_iPausePendingTeam = 0;
	g_iPauseOwner = 0;
	g_bPauseSeen = false;
	g_fPauseStarted = 0.0;
	g_fPauseHeld = 0.0;
	g_iPauseWarned = 0;
}

int PauseLimit()
{
	return g_cvPauseLimit.IntValue;
}

int PauseRemaining(int team)
{
	if (team != 1 && team != 2) return 0;
	int left = PauseLimit() - g_iPauseUsed[team];
	return left < 0 ? 0 : left;
}

static void PauseTeamName(int team, char[] out, int len)
{
	strcopy(out, len, team == 1 ? "Team A" : "Team B");
}

/**
 * Refuse a pause a team has no budget left for. Never charges anything: see
 * the note at the top of this file.
 */
public Action Listener_PugPause(int client, const char[] command, int argc)
{
	// pug-leave.inc pausing for a disconnect. Unbudgeted, uncapped, and not
	// attributed to the client it borrowed to issue the command.
	if (g_bPauseInternal)
	{
		g_bPauseInternal = false;
		return Plugin_Continue;
	}

	// Outside a live match there is nothing to budget, and during ready-up
	// Rotoblin refuses anyway. Leave both to it.
	if (g_State != MS_Live || InReadyUp()) return Plugin_Continue;
	if (PauseLimit() <= 0) return Plugin_Continue;

	if (client <= 0 || client > MaxClients || !IsClientInGame(client)) return Plugin_Continue;
	int slot = g_iClientRoster[client];
	// Not on the roster: an admin or a spectator. Rotoblin has its own rules
	// about who may pause and this module does not add to them.
	if (slot < 0) return Plugin_Continue;
	int team = g_iRosterTeam[slot];
	if (team != 1 && team != 2) return Plugin_Continue;

	// Already paused. Rotoblin will tell them so, and no new pause begins, so
	// nothing should be charged or refused here.
	if (LeaveRotoblinPaused()) return Plugin_Continue;

	if (PauseRemaining(team) <= 0)
	{
		char name[16];
		PauseTeamName(team, name, sizeof(name));
		PrintToChatAll("\x04[PUG]\x01 %s has used all \x05%d\x01 pauses for this campaign. Ask an admin if something has actually gone wrong.",
			name, PauseLimit());
		EmitPug("PAUSE_REFUSED team=%d used=%d limit=%d", team, g_iPauseUsed[team], PauseLimit());
		return Plugin_Handled;
	}

	// Allowed, not yet charged. The clock tick that sees the game actually
	// paused is what bills it.
	g_iPausePendingTeam = team;
	return Plugin_Continue;
}

/**
 * Watch for the game entering and leaving pause, charge the budget, and
 * enforce the ceiling.
 *
 * Polling rather than an event because Rotoblin raises none: the pause state
 * is only observable through its `IsInPause` native, which this plugin already
 * reads for the leaver logic.
 */
public Action Timer_PauseClock(Handle timer)
{
	bool paused = LeaveRotoblinPaused();

	if (paused && !g_bPauseSeen)
	{
		g_bPauseSeen = true;
		g_fPauseStarted = GetEngineTime();
		g_fPauseHeld = 0.0;
		g_iPauseWarned = 0;
		// A pause the leave module caused is nobody's: not charged, and not
		// subject to the ceiling either, because the player it is waiting for
		// has a reconnect allowance that is allowed to outlast it.
		g_iPauseOwner = g_bLeavePaused ? 0 : g_iPausePendingTeam;
		g_iPausePendingTeam = 0;
		if (g_iPauseOwner == 1 || g_iPauseOwner == 2)
		{
			g_iPauseUsed[g_iPauseOwner]++;
			char name[16];
			PauseTeamName(g_iPauseOwner, name, sizeof(name));
			int left = PauseRemaining(g_iPauseOwner);
			int ceiling = g_cvPauseSeconds.IntValue;
			if (ceiling > 0)
			{
				PrintToChatAll("\x04[PUG]\x01 %s pause \x05%d:%02d\x01 max. \x05%d\x01 pause%s left this campaign.",
					name, ceiling / 60, ceiling % 60, left, left == 1 ? "" : "s");
			}
			else
			{
				PrintToChatAll("\x04[PUG]\x01 %s pause. \x05%d\x01 pause%s left this campaign.",
					name, left, left == 1 ? "" : "s");
			}
			EmitPug("PAUSE team=%d used=%d limit=%d", g_iPauseOwner, g_iPauseUsed[g_iPauseOwner], PauseLimit());
		}
		return Plugin_Continue;
	}

	if (!paused)
	{
		if (g_bPauseSeen)
		{
			g_bPauseSeen = false;
			g_iPauseOwner = 0;
			g_iPausePendingTeam = 0;
		}
		return Plugin_Continue;
	}

	// Paused, and we have seen it before: run the ceiling.
	int ceiling = g_cvPauseSeconds.IntValue;
	if (ceiling <= 0 || g_iPauseOwner == 0) return Plugin_Continue;

	// The clock does not run while a rostered player is actually away. A
	// player pause that a disconnect lands in the middle of must not expire
	// under someone who is still loading back in.
	if (LeaveAnyAbsent())
	{
		g_fPauseHeld += 1.0;
		return Plugin_Continue;
	}

	int left = ceiling - RoundToFloor(GetEngineTime() - g_fPauseStarted - g_fPauseHeld);

	if (left <= 0)
	{
		char name[16];
		PauseTeamName(g_iPauseOwner, name, sizeof(name));
		PrintToChatAll("\x04[PUG]\x01 %s's pause has run out. Unpausing.", name);
		EmitPug("PAUSE_EXPIRED team=%d seconds=%d", g_iPauseOwner, ceiling);
		// The same both-teams-ready path a player unpause takes, so
		// Rotoblin's own countdown and its frozen-smoker-victim fix apply.
		LeaveUnpauseNow();
		g_bPauseSeen = false;
		g_iPauseOwner = 0;
		return Plugin_Continue;
	}

	// Announced once each, so nobody is surprised by the game unfreezing.
	for (int mark = 30; mark >= 10; mark -= 20)
	{
		if (left <= mark && g_iPauseWarned != mark && (g_iPauseWarned == 0 || g_iPauseWarned > mark))
		{
			g_iPauseWarned = mark;
			PrintToChatAll("\x04[PUG]\x01 Unpausing in \x05%d\x01 seconds. Type \x05!ready\x01 to go now.", mark);
			break;
		}
	}
	return Plugin_Continue;
}

/** STATUS lines for sm_pug_status. */
void PauseStatus()
{
	PrintToServer("pause limit=%d seconds=%d used_a=%d used_b=%d",
		PauseLimit(), g_cvPauseSeconds.IntValue, g_iPauseUsed[1], g_iPauseUsed[2]);
	if (g_bPauseSeen)
	{
		PrintToServer("pause active owner=%d elapsed=%.0f held=%.0f",
			g_iPauseOwner, GetEngineTime() - g_fPauseStarted, g_fPauseHeld);
	}
}
