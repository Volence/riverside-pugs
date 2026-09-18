// ---------- leavers: auto pause, per-player reconnect allowance, abandon ----------
//
// The owner's rule (2026-09-17): when a rostered player really disconnects
// mid-match the game pauses, and they have a reconnect allowance to get back.
// The allowance is per player for the WHOLE match, not per disconnect, so
// dropping for four minutes, rejoining, and dropping again cannot be used to
// stall the game indefinitely. Run out, and the match is over: the plugin
// reports ABANDON and the backend aborts the match and bans the leaver.
//
// Only matches the backend set up (the web queue) are policed. A self-started
// or auto-tracked match is a friendly night, not a ranked queue pop.
//
// Detection uses the player_disconnect GAME EVENT, not OnClientDisconnect.
// SourceMod calls OnClientDisconnect for every client across a changelevel
// (they "reconnect" through the map load), but the engine only fires
// player_disconnect when a client actually leaves the server, crashes or
// times out included.

native bool IsInPause();   // rotoblin-az, optional

ConVar g_cvLeaveBudget;
ConVar g_cvLeaveAutoUnpause;

float g_fAbsentSince[MAX_ROSTER];   // engine time they left; 0.0 = present
float g_fAbsentUsed[MAX_ROSTER];    // seconds of allowance already spent
int g_iLeaveWarned[MAX_ROSTER];     // the last warning threshold announced
char g_sLeaveName[MAX_ROSTER][MAX_NAME_LENGTH];
bool g_bLeavePaused;                // this module paused the game
bool g_bLeaveUnpausing;
char g_sAbandoner[32];              // steamid64 once someone ran out, else ""

public APLRes AskPluginLoad2(Handle myself, bool late, char[] error, int err_max)
{
	MarkNativeAsOptional("IsInPause");
	return APLRes_Success;
}

void LeaveInit()
{
	g_cvLeaveBudget = CreateConVar("sm_pug_leave_budget", "300",
		"Seconds each rostered player may spend disconnected over a whole backend match before it ends as an abandon. 0 disables leave tracking.",
		FCVAR_NOTIFY, true, 0.0, true, 3600.0);
	g_cvLeaveAutoUnpause = CreateConVar("sm_pug_leave_autounpause", "1",
		"1 = unpause on a countdown once every disconnected player is back. 0 = both teams type !ready, as for any pause.",
		FCVAR_NOTIFY, true, 0.0, true, 1.0);
	HookEvent("player_disconnect", Event_LeaveDisconnect, EventHookMode_Pre);
	CreateTimer(1.0, Timer_LeaveClock, _, TIMER_REPEAT);
}

void LeaveReset()
{
	// A match that ends (abort after an abandon, or any other reset) must not
	// leave the server frozen.
	if (g_bLeavePaused) LeaveUnpauseNow();
	for (int i = 0; i < MAX_ROSTER; i++)
	{
		g_fAbsentSince[i] = 0.0;
		g_fAbsentUsed[i] = 0.0;
		g_iLeaveWarned[i] = 0;
		g_sLeaveName[i][0] = '\0';
	}
	g_bLeavePaused = false;
	g_bLeaveUnpausing = false;
	g_sAbandoner[0] = '\0';
}

bool LeaveTracking()
{
	return (g_State == MS_Pending || g_State == MS_Live)
		&& !g_bSelfStarted
		&& g_sAbandoner[0] == '\0'
		&& g_cvLeaveBudget.IntValue > 0;
}

int LeaveRemaining(int slot)
{
	float used = g_fAbsentUsed[slot];
	if (g_fAbsentSince[slot] > 0.0) used += GetEngineTime() - g_fAbsentSince[slot];
	int left = g_cvLeaveBudget.IntValue - RoundToFloor(used);
	return left < 0 ? 0 : left;
}

bool LeaveAnyAbsent()
{
	for (int i = 0; i < g_iRosterCount; i++)
	{
		if (g_fAbsentSince[i] > 0.0) return true;
	}
	return false;
}

public Action Event_LeaveDisconnect(Event event, const char[] name, bool dontBroadcast)
{
	if (!LeaveTracking()) return Plugin_Continue;
	int client = GetClientOfUserId(event.GetInt("userid"));
	if (client <= 0 || client > MaxClients || IsFakeClient(client)) return Plugin_Continue;
	int slot = g_iClientRoster[client];
	if (slot < 0 || g_fAbsentSince[slot] > 0.0) return Plugin_Continue;

	g_fAbsentSince[slot] = GetEngineTime();
	GetClientName(client, g_sLeaveName[slot], sizeof(g_sLeaveName[]));
	g_iLeaveWarned[slot] = 0;
	int left = LeaveRemaining(slot);
	PrintToChatAll("\x04[PUG]\x01 %s disconnected. They have \x05%d:%02d\x01 of reconnect time left for this match.",
		g_sLeaveName[slot], left / 60, left % 60);
	EmitPug("LEAVE steamid=%s remaining=%d", g_sRosterId[slot], left);
	g_bLeaveUnpausing = false;
	LeaveTryPause();
	return Plugin_Continue;
}

/** Called from OnClientPostAdminCheck once a rostered client is matched to its slot. */
void LeaveOnReturn(int slot)
{
	if (slot < 0 || g_fAbsentSince[slot] <= 0.0) return;
	g_fAbsentUsed[slot] += GetEngineTime() - g_fAbsentSince[slot];
	g_fAbsentSince[slot] = 0.0;
	int left = LeaveRemaining(slot);
	PrintToChatAll("\x04[PUG]\x01 %s is back (\x05%d:%02d\x01 of reconnect time left).",
		g_sLeaveName[slot], left / 60, left % 60);
	EmitPug("RETURN steamid=%s remaining=%d", g_sRosterId[slot], left);
	if (LeaveAnyAbsent() || !g_bLeavePaused) return;

	if (g_cvLeaveAutoUnpause.BoolValue)
	{
		PrintToChatAll("\x04[PUG]\x01 Everyone is back. Unpausing in 10 seconds.");
		g_bLeaveUnpausing = true;
		CreateTimer(10.0, Timer_LeaveUnpause, _, TIMER_FLAG_NO_MAPCHANGE);
	}
	else
	{
		PrintToChatAll("\x04[PUG]\x01 Everyone is back. Both teams type \x05!ready\x01 to unpause.");
		g_bLeavePaused = false;
	}
}

public Action Timer_LeaveUnpause(Handle timer)
{
	// Someone dropped again during the countdown: stay paused.
	if (!g_bLeaveUnpausing || LeaveAnyAbsent()) return Plugin_Stop;
	g_bLeaveUnpausing = false;
	LeaveUnpauseNow();
	return Plugin_Stop;
}

public Action Timer_LeaveClock(Handle timer)
{
	if (!LeaveTracking() || !LeaveAnyAbsent()) return Plugin_Continue;

	// A disconnect during ready-up or between rounds cannot pause (there is
	// nothing to pause), so keep trying until a round is live.
	if (!g_bLeavePaused) LeaveTryPause();

	for (int i = 0; i < g_iRosterCount; i++)
	{
		if (g_fAbsentSince[i] <= 0.0) continue;
		int left = LeaveRemaining(i);
		if (left <= 0)
		{
			LeaveAbandon(i);
			return Plugin_Continue;
		}
		int threshold = left <= 10 ? 10 : left <= 30 ? 30 : left <= 60 ? 60 : 0;
		if (threshold != 0 && g_iLeaveWarned[i] != threshold)
		{
			g_iLeaveWarned[i] = threshold;
			PrintToChatAll("\x04[PUG]\x01 %s has \x05%d seconds\x01 left to reconnect.", g_sLeaveName[i], left);
		}
	}
	return Plugin_Continue;
}

void LeaveAbandon(int slot)
{
	strcopy(g_sAbandoner, sizeof(g_sAbandoner), g_sRosterId[slot]);
	g_fAbsentUsed[slot] = float(g_cvLeaveBudget.IntValue);
	g_fAbsentSince[slot] = 0.0;
	PrintToChatAll("\x04[PUG]\x01 %s did not reconnect in time. The match is over and counts as an abandon. Nobody else is penalised and no ratings change.",
		g_sLeaveName[slot]);
	LogMessage("pug-match: %s (%s) abandoned match %d", g_sLeaveName[slot], g_sAbandoner, g_iMatchId);
	// Repeated from the heartbeat until the backend aborts the match: the UDP
	// log stream is lossy, and this line ends a match.
	EmitPug("ABANDON steamid=%s", g_sAbandoner);
}

/** For Timer_Heartbeat. */
void LeaveHeartbeat()
{
	if (g_sAbandoner[0] != '\0') EmitPug("ABANDON steamid=%s", g_sAbandoner);
}

bool LeaveRotoblinPaused()
{
	return GetFeatureStatus(FeatureType_Native, "IsInPause") == FeatureStatus_Available && IsInPause();
}

/** Pause through Rotoblin's own !pause, so its pause panel, !ready flow and
 *  frozen-smoker-victim fix all apply. Rotoblin blocks a raw setpause from
 *  anyone else. */
void LeaveTryPause()
{
	if (g_bLeavePaused) return;
	if (g_State != MS_Live || g_bRoundEnded || InReadyUp()) return;
	if (LeaveRotoblinPaused())
	{
		// Already paused by a player: count it as ours so the return logic
		// still unpauses (or asks for !ready) when everyone is back.
		g_bLeavePaused = true;
		return;
	}
	int c = LeaveAnyTeamClient(0);
	if (c == -1) return;
	// Exempt from the pause budget and the pause ceiling: this is a disconnect,
	// not a team spending one of its pauses. See pug-pause.inc.
	PauseAllowInternal();
	FakeClientCommand(c, "sm_pause");
	g_bLeavePaused = true;
}

void LeaveUnpauseNow()
{
	g_bLeavePaused = false;
	if (!LeaveRotoblinPaused()) return;
	// Rotoblin unpauses on a short countdown once both teams are ready.
	int surv = LeaveAnyTeamClient(TEAM_SURVIVOR);
	int inf = LeaveAnyTeamClient(TEAM_INFECTED);
	if (surv != -1) FakeClientCommand(surv, "sm_ready");
	if (inf != -1) FakeClientCommand(inf, "sm_ready");
}

/** A connected human on `team`, or on either side when team is 0. */
int LeaveAnyTeamClient(int team)
{
	for (int c = 1; c <= MaxClients; c++)
	{
		if (!IsClientInGame(c) || IsFakeClient(c)) continue;
		int t = GetClientTeam(c);
		if (team == 0 ? (t == TEAM_SURVIVOR || t == TEAM_INFECTED) : t == team) return c;
	}
	return -1;
}

/** STATUS lines for sm_pug_status, which the backend reads to confirm an abandon. */
void LeaveStatus()
{
	DumpLine("STATUS leave abandoner=%s budget=%d autounpause=%d paused=%d",
		g_sAbandoner[0] == '\0' ? "none" : g_sAbandoner,
		g_cvLeaveBudget.IntValue, g_cvLeaveAutoUnpause.IntValue, g_bLeavePaused ? 1 : 0);
	for (int i = 0; i < g_iRosterCount; i++)
	{
		if (g_fAbsentUsed[i] <= 0.0 && g_fAbsentSince[i] <= 0.0) continue;
		DumpLine("STATUS leave slot=%d steamid=%s absent=%d remaining=%d",
			i, g_sRosterId[i], g_fAbsentSince[i] > 0.0 ? 1 : 0, LeaveRemaining(i));
	}
}
