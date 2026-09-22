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
ConVar g_cvLeaveHoldMax;

float g_fAbsentSince[MAX_ROSTER];   // engine time they left; 0.0 = present
float g_fAbsentUsed[MAX_ROSTER];    // seconds of allowance already spent
float g_fHoldSince[MAX_ROSTER];     // engine time an admin hold began; 0.0 = not held
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
	// An admin can freeze one player's allowance (sm_pug_leave ... hold) while
	// they sort out a reconnect. The ceiling is enforced here and not only by
	// the backend, so a release that never arrives cannot pin a server paused.
	g_cvLeaveHoldMax = CreateConVar("sm_pug_leave_hold_max", "1800",
		"Longest an admin hold may freeze one player's reconnect allowance, in seconds. The hold releases itself after this.",
		FCVAR_NOTIFY, true, 10.0, true, 7200.0);
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
		g_fHoldSince[i] = 0.0;
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
	// A held slot spends nothing: LeaveHold banked what had been used, and
	// LeaveRelease restarts the running span from the moment of the release.
	// used can be negative after an admin add, which is how the allowance
	// grows past the budget.
	if (g_fAbsentSince[slot] > 0.0 && g_fHoldSince[slot] <= 0.0) used += GetEngineTime() - g_fAbsentSince[slot];
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
	// Back while held: the hold ends with nothing left to hold, and the held
	// span is not charged, because LeaveHold already banked everything before it.
	if (g_fHoldSince[slot] <= 0.0) g_fAbsentUsed[slot] += GetEngineTime() - g_fAbsentSince[slot];
	g_fHoldSince[slot] = 0.0;
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

/** Whether this match ended because someone ran out of reconnect time. Read by
 *  the teardown to word its announcement; a function because the .sp includes
 *  this file last and never reads its globals directly. */
bool LeaveHasAbandoner()
{
	return g_sAbandoner[0] != '\0';
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

/** STATUS lines for sm_pug_status, which the backend reads to confirm an abandon. */
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
