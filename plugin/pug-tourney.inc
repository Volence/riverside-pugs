// ---------- tournament boxes: !sub, !admin, !lift and the staff freeze (plan T3c) ----------
//
// Spec: docs/superpowers/specs/2026-09-30-competitive-tournaments-design.md,
// section 4 (Subs during a match; In-game help); plan T3c Rulings 2 to 9.
//
// Everything here is gated on sm_pug_tournament, which the site's booking
// runner sets to 1 with the booking lines of a tournament booking and back to
// 0 when the booking ends (CLEAR_LINES). A PUG box never sees any of it.
//
// !sub <out> <in>: a captain swaps one of the four between chapters. This
// module judges the moment (it knows the round state to the tick) and
// resolves the two names; the site decides who may sub whom and the limit,
// and answers with sm_pug_sub <token> <out> <in>. Nothing changes here until
// that answer arrives.
//
// !admin [why]: a player calls staff. One signed PUGCALL line with
// reason=admin (the mod-call card on the web), no menus, and the game is
// frozen: a Rotoblin pause from a rostered client, unbudgeted like the leave
// module's, that only staff lift (!lift in game, or the site's
// sm_pug_adminpause <token> off). Every change of the freeze goes out as a
// signed ADMINPAUSE line so the site's desk and room page agree with the box.
//
// WHY THE PAUSE IS ROTOBLIN'S OWN sm_pause AND NOT forcepause. Rotoblin's
// forcepause and forceunpause refuse client 0 (the server) and demand admin
// flags on the client that types them, so neither the site nor a fake client
// command on a player's behalf can drive them. sm_pause from a rostered
// client is the path the leave module already proved (LeaveTryPause), and
// the "staff only" part is this module's own listener on the unpause
// commands, which Rotoblin registers with RegConsoleCmd so a listener runs
// first (the same trick pug-pause.inc plays on sm_pause).
//
// A FREEZE IS RETRIED UNTIL IT HOLDS. Rotoblin refuses sm_pause during its
// unpause countdown, a pause may be deferred, and there may be nobody on a
// side to borrow at the moment of the call. So the pause clock (pug-pause.inc,
// once a second) calls Tourney_Tick, which re-applies a freeze that is set
// but not paused during a live round, at most once per TOURNEY_RETRY_GAP.
//
// AN ADMIN'S !forceunpause LIFTS THE FREEZE. Rotoblin's forceunpause is staff
// only and cannot be refused from here (its own listener), so instead of
// fighting it the module treats it as staff lifting the freeze: the site gets
// ADMINPAUSE state=off cause=forced and Rotoblin's countdown resumes the game.

#define TOURNEY_FREEZE_DELAY 1.0   // seconds after a go-live before a deferred freeze is applied
#define TOURNEY_REOPEN_GUARD 0.5   // seconds a second !admin from the same client is ignored (the say forward and the sm_admin listener can both fire)
#define TOURNEY_RETRY_GAP 5.0      // seconds between two sm_pause attempts for one freeze (a pause Rotoblin delays or defers is still pending)

bool g_bTourneyFrozen;                 // the staff freeze holds (applied, or waiting for the next go-live)
bool g_bTourneySlotOut[MAX_ROSTER];    // the slot was subbed out: no lock, no leave clock, no !gg vote
float g_fTourneyLastAdmin[MAXPLAYERS + 1];
float g_fTourneyApplyAt;               // engine time of the last sm_pause issued for the freeze; 0.0 = none pending

void Tourney_Init()
{
	g_cvTournament = CreateConVar("sm_pug_tournament", "0",
		"1 = a tournament box (the site's booking runner sets it): !sub, !admin, !lift and the staff freeze are on.",
		FCVAR_NOTIFY, true, 0.0, true, 1.0);
	RegServerCmd("sm_pug_sub", Cmd_PugSub, "sm_pug_sub <token> <out64> <in64> - the site approved a substitution");
	RegServerCmd("sm_pug_adminpause", Cmd_AdminPause, "sm_pug_adminpause <token> on|off [\"by\"] - the staff freeze, from the site");
	RegAdminCmd("sm_pug_lift", Cmd_Lift, ADMFLAG_GENERIC, "Lift the staff freeze (chat: !lift)");
	// Rotoblin registers these with RegConsoleCmd: a listener runs first and
	// can refuse them while the freeze holds (pug-pause.inc does the same for sm_pause).
	AddCommandListener(Listener_TourneyUnpause, "sm_ready");
	AddCommandListener(Listener_TourneyUnpause, "sm_r");
	AddCommandListener(Listener_TourneyUnpause, "sm_unpause");
	// SourceMod's own admin menu: on a tournament box a player's !admin is a staff call.
	AddCommandListener(Listener_TourneyAdmin, "sm_admin");
	// Rotoblin's !forceunpause (chat is turned into this command by its cmdmanager).
	AddCommandListener(Listener_TourneyForceUnpause, "rotoblin_forceunpause");
}

bool TourneyOn()
{
	return g_cvTournament != null && g_cvTournament.BoolValue && g_State != MS_None;
}

/** Read by pug-leave.inc (LeaveUnpauseNow) and pug-pause.inc (the PHASE line, the pause owner, the ceiling). */
bool TourneyFrozen()
{
	return g_bTourneyFrozen;
}

/** Staff on the box: one check for !admin (not caught), !lift and the
 *  unpause listener, the same access sm_pug_lift itself needs. */
bool Tourney_IsStaff(int client)
{
	return CheckCommandAccess(client, "sm_pug_lift", ADMFLAG_GENERIC);
}

/** Read by the team lock, the leave module, !gg and the roster watchdog. */
bool Tourney_SlotOut(int slot)
{
	return slot >= 0 && slot < MAX_ROSTER && g_bTourneySlotOut[slot];
}

/** From ResetMatchState, first thing: a new, resumed or aborted match lifts
 *  the freeze (the line goes out while the token still stands) and forgets
 *  who was subbed out. */
void Tourney_Reset()
{
	if (g_bTourneyFrozen) Tourney_Lift("site", "reset", "");
	g_fTourneyApplyAt = 0.0;
	for (int i = 0; i < MAX_ROSTER; i++) g_bTourneySlotOut[i] = false;
}

void Tourney_OnDisconnect(int client)
{
	g_fTourneyLastAdmin[client] = 0.0;
}

/** STATUS line for sm_pug_status. */
void Tourney_Status()
{
	PrintToServer("tourney on=%d frozen=%d", TourneyOn() ? 1 : 0, g_bTourneyFrozen ? 1 : 0);
}

// ---------- between chapters ----------

/** Before the first round of the match, before the current map's first half
 *  has gone live (its ready-up), or after its second half ended (the map is
 *  about to change). Never during a live half, a pause, half time or the
 *  second half's ready-up: Event_RoundStart clears g_bHalfWasLive for every
 *  half, so a ready-up is the first half's only when the game says so (the
 *  same property OnRoundIsLive reads for g_iHalf). */
bool Tourney_BetweenChapters()
{
	if (g_State == MS_Pending) return true;
	if (g_State != MS_Live) return false;
	if (!g_bHalfWasLive) return !view_as<bool>(GameRules_GetProp("m_bInSecondHalfOfRound"));
	return g_bRoundEnded && g_iHalf == 2;
}

// ---------- the say hook ----------

/** From OnClientSayCommand (pug-modcall.inc), after /staff: true when the
 *  line was a tournament command and has been handled (the caller drops it). */
bool Tourney_OnSay(int client, const char[] text)
{
	if (!TourneyOn()) return false;
	int rest = ModCall_TriggerEnd(text, "!sub");
	if (rest < 0) rest = ModCall_TriggerEnd(text, "/sub");
	if (rest >= 0)
	{
		Tourney_Sub(client, text[rest]);
		return true;
	}
	rest = ModCall_TriggerEnd(text, "!admin");
	if (rest < 0) rest = ModCall_TriggerEnd(text, "/admin");
	if (rest >= 0)
	{
		// Staff keep SourceMod's own !admin (the menu): nothing to drop here.
		if (Tourney_IsStaff(client)) return false;
		Tourney_AdminCall(client, text[rest]);
		return true;
	}
	rest = ModCall_TriggerEnd(text, "!lift");
	if (rest < 0) rest = ModCall_TriggerEnd(text, "/lift");
	if (rest >= 0)
	{
		Tourney_LiftFromGame(client);
		return true;
	}
	return false;
}

/** SourceMod maps a player's !admin and /admin to sm_admin (the admin menu).
 *  On a tournament box a non-staff player's is a staff call; the say forward
 *  usually got there first, and the reopen guard drops this second open. */
public Action Listener_TourneyAdmin(int client, const char[] command, int argc)
{
	if (!TourneyOn() || client < 1 || client > MaxClients || !IsClientInGame(client) || IsFakeClient(client)) return Plugin_Continue;
	if (Tourney_IsStaff(client)) return Plugin_Continue;
	char details[256];
	GetCmdArgString(details, sizeof(details));
	Tourney_AdminCall(client, details);
	return Plugin_Handled;
}

// ---------- !sub ----------

void Tourney_Sub(int client, const char[] args)
{
	if (client < 1 || client > MaxClients || !IsClientInGame(client) || IsFakeClient(client)) return;
	char outName[MAX_NAME_LENGTH], inName[MAX_NAME_LENGTH];
	int pos = BreakString(args, outName, sizeof(outName));
	if (pos != -1) strcopy(inName, sizeof(inName), args[pos]);
	TrimString(outName);
	TrimString(inName);
	if (outName[0] == '\0' || inName[0] == '\0')
	{
		PrintToChat(client, "[Match] Usage: !sub <player out> <player in>. Between chapters only; the sub connects first.");
		return;
	}
	if (!Tourney_BetweenChapters())
	{
		PrintToChat(client, "[Match] Subs are made between chapters, not during one. Try again at the next ready-up.");
		return;
	}
	char by[24];
	if (!ModCall_AuthId(client, by, sizeof(by)))
	{
		PrintToChat(client, "[PUG] Your Steam ID is not verified yet, try again in a moment.");
		return;
	}
	char outId[24], inId[24];
	int outSlot = Tourney_FindRostered(outName, outId, sizeof(outId));
	if (outSlot == -2)
	{
		PrintToChat(client, "[Match] More than one rostered player matches \"%s\"; type more of the name.", outName);
		return;
	}
	if (outSlot < 0)
	{
		PrintToChat(client, "[Match] No rostered player matches \"%s\".", outName);
		return;
	}
	int inClient = Tourney_FindConnected(inName, inId, sizeof(inId));
	if (inClient == -2)
	{
		PrintToChat(client, "[Match] More than one player on the server matches \"%s\"; type more of the name.", inName);
		return;
	}
	if (inClient < 0)
	{
		PrintToChat(client, "[Match] \"%s\" is not on the server. The sub connects (as a spectator) first, then you !sub.", inName);
		return;
	}
	if (StrEqual(outId, inId))
	{
		PrintToChat(client, "[Match] That is the same player.");
		return;
	}
	EmitPug("SUB by=%s out=%s in=%s map=%d", by, outId, inId, g_iMapCount);
	PrintToChat(client, "[Match] Asking the site to put %N in. It answers in chat.", inClient);
}

/** A rostered player, not already subbed out, by a unique substring of the
 *  name they have now (connected) or had when they left (LeaveNameOf: a
 *  connected client's name, else the leave module's, else the SteamID64, so
 *  a captain may also type digits of the id). The slot, -1 for none, -2 for
 *  more than one; `id` gets the SteamID64 on a hit. */
int Tourney_FindRostered(const char[] query, char[] id, int maxlen)
{
	int found = -1, count = 0;
	char name[MAX_NAME_LENGTH];
	for (int slot = 0; slot < g_iRosterCount; slot++)
	{
		if (g_bTourneySlotOut[slot]) continue;
		LeaveNameOf(slot, name, sizeof(name));
		if (StrContains(name, query, false) == -1) continue;
		found = slot;
		count++;
	}
	if (count > 1) return -2;
	if (count == 0) return -1;
	strcopy(id, maxlen, g_sRosterId[found]);
	return found;
}

/** A connected human by a unique substring of their name. The client, -1
 *  for none, -2 for more than one; `id` gets the SteamID64 on a hit. */
int Tourney_FindConnected(const char[] query, char[] id, int maxlen)
{
	int found = -1, count = 0;
	char name[MAX_NAME_LENGTH], sid[24];
	for (int c = 1; c <= MaxClients; c++)
	{
		if (!IsClientInGame(c) || IsFakeClient(c) || IsClientSourceTV(c)) continue;
		GetClientName(c, name, sizeof(name));
		if (StrContains(name, query, false) == -1) continue;
		if (!ModCall_AuthId(c, sid, sizeof(sid))) continue;
		found = c;
		count++;
	}
	if (count > 1) return -2;
	if (count == 0) return -1;
	ModCall_AuthId(found, id, maxlen);
	return found;
}

/** sm_pug_sub <token> <out64> <in64>: the site approved it (plan T3c
 *  Ruling 5). The outgoing slot keeps its stats and is marked out; the
 *  incoming player gets a new slot (or their old one back) on the same
 *  team, rostered from the maps finished so far, and the team lock places
 *  them within two seconds. Idempotent: a sub already in place answers
 *  PUGOK again. */
public Action Cmd_PugSub(int args)
{
	if (!TokenArgOk(args)) return Plugin_Handled;
	if (args < 3)
	{
		PrintToServer("PUGERR usage: sm_pug_sub <token> <out64> <in64>");
		return Plugin_Handled;
	}
	char outId[32], inId[32];
	GetCmdArg(2, outId, sizeof(outId));
	GetCmdArg(3, inId, sizeof(inId));
	if (StrEqual(outId, inId))
	{
		PrintToServer("PUGERR same player");
		return Plugin_Handled;
	}
	int outSlot = RosterIndexOfId(outId);
	int inSlot = RosterIndexOfId(inId);
	if (outSlot == -1)
	{
		PrintToServer("PUGERR not rostered");
		return Plugin_Handled;
	}
	int team = g_iRosterTeam[outSlot];
	if (g_bTourneySlotOut[outSlot])
	{
		// The sub already stands (a re-sent command, Review Focus 2): say so and change nothing.
		if (inSlot != -1 && !g_bTourneySlotOut[inSlot] && g_iRosterTeam[inSlot] == team)
		{
			PrintToServer("PUGOK sub already");
			return Plugin_Handled;
		}
		PrintToServer("PUGERR already out");
		return Plugin_Handled;
	}
	// The site checked the moment when the captain asked; the game may have
	// gone live since (a slow answer, or a re-sent one).
	if (!Tourney_BetweenChapters())
	{
		PrintToServer("PUGERR not between chapters");
		return Plugin_Handled;
	}
	// An active rostered player (either team) is never moved by a sub: the
	// site only ever names a member of the entry who is not in the four.
	if (inSlot != -1 && !g_bTourneySlotOut[inSlot])
	{
		PrintToServer("PUGERR already rostered");
		return Plugin_Handled;
	}
	if (inSlot == -1)
	{
		if (g_iRosterCount >= MAX_ROSTER)
		{
			PrintToServer("PUGERR roster full");
			return Plugin_Handled;
		}
		inSlot = g_iRosterCount++;
		strcopy(g_sRosterId[inSlot], 32, inId);
		g_iRosterJoinedMap[inSlot] = g_iMapCount;
	}
	g_bTourneySlotOut[inSlot] = false;
	g_iRosterTeam[inSlot] = team;
	g_bTourneySlotOut[outSlot] = true;
	LeaveForget(outSlot);
	int outClient = -1, inClient = -1;
	char sid[24];
	for (int c = 1; c <= MaxClients; c++)
	{
		if (!IsClientInGame(c) || IsFakeClient(c)) continue;
		if (g_iClientRoster[c] == outSlot) outClient = c;
		if (g_iClientRoster[c] == inSlot) inClient = c;
		else if (inClient == -1 && ModCall_AuthId(c, sid, sizeof(sid)) && StrEqual(sid, inId))
		{
			g_iClientRoster[c] = inSlot;
			g_iLockAttempts[c] = 0;
			inClient = c;
		}
	}
	char outName[MAX_NAME_LENGTH];
	if (outClient != -1)
	{
		GetClientName(outClient, outName, sizeof(outName));
		int t = GetClientTeam(outClient);
		if (t == TEAM_SURVIVOR || t == TEAM_INFECTED) ChangeClientTeam(outClient, TEAM_SPEC);
	}
	else
	{
		LeaveNameOf(outSlot, outName, sizeof(outName));
	}
	if (inClient != -1) PrintToChatAll("\x04[Match]\x01 %N replaces %s for Team %s.", inClient, outName, team == 1 ? "A" : "B");
	else PrintToChatAll("\x04[Match]\x01 A sub replaces %s for Team %s; they are placed when they connect.", outName, team == 1 ? "A" : "B");
	LogMessage("[tourney] sub: %s out, %s in (team %s, slot %d, map %d)", outId, inId, team == 1 ? "a" : "b", inSlot, g_iMapCount);
	PrintToServer("PUGOK sub out=%s in=%s slot=%d", outId, inId, inSlot);
	return Plugin_Handled;
}

// ---------- !admin and the freeze ----------

void Tourney_AdminCall(int client, const char[] details)
{
	if (client < 1 || client > MaxClients || !IsClientInGame(client) || IsFakeClient(client)) return;
	float now = GetEngineTime();
	if (g_fTourneyLastAdmin[client] > 0.0 && now - g_fTourneyLastAdmin[client] < TOURNEY_REOPEN_GUARD) return;
	g_fTourneyLastAdmin[client] = now;
	char id[24];
	if (!ModCall_AuthId(client, id, sizeof(id)))
	{
		PrintToChat(client, "[PUG] Your Steam ID is not verified yet, try again in a moment.");
		return;
	}
	// The same cooldown as /mod, in the same map, so the two cannot be used in turn.
	int last;
	if (g_smCooldown.GetValue(id, last))
	{
		int left = MODCALL_COOLDOWN - (GetTime() - last);
		if (left > 0)
		{
			PrintToChat(client, "[Match] You can call staff again in %d:%02d.%s", left / 60, left % 60, g_bTourneyFrozen ? " The game is already frozen." : "");
			return;
		}
	}
	char text[256];
	strcopy(text, sizeof(text), details);
	StripQuotes(text);
	TrimString(text);
	SanitizeChat(text, sizeof(text));
	// The map rides on the line so the card says where; before text=, which must stay last.
	char map[64];
	GetCurrentMap(map, sizeof(map));
	char line[512];
	Format(line, sizeof(line), "PUGCALL steamid=%s target=none tteam=%d reason=admin match=%d ord=%d half=%d tms=%d via=game map=%s text=%s",
		id, GetClientTeam(client), g_iMatchId, g_iRplMapSeq, g_iHalf, RoundMs(), map, text);
	PugLog("%s", line);
	LogMessage("[tourney] %s", line);
	g_smCooldown.SetValue(id, GetTime());
	PrintToChatAll("\x04[Match]\x01 %N called staff. The game is frozen until staff lift it.", client);
	Tourney_Freeze(id, "call");
}

/** Set the freeze (and tell the site once); pause now if a round is live,
 *  else at the next go-live (Tourney_OnRoundLive). */
void Tourney_Freeze(const char[] by, const char[] cause)
{
	bool was = g_bTourneyFrozen;
	g_bTourneyFrozen = true;
	if (!was) Tourney_Emit(true, by, cause);
	Tourney_Apply();
}

/** Pause for the freeze when a round is live and nothing is paused yet. A
 *  pause already in place (a team's, the leave module's, or Rotoblin's
 *  countdown before it unpauses) is held as it is. One attempt per
 *  TOURNEY_RETRY_GAP: Rotoblin may delay (rotoblin_pausedelay) or defer a
 *  pause, and a second sm_pause meanwhile would only say "paused" again.
 *  Rotoblin announces the pause in the borrowed player's name. */
void Tourney_Apply()
{
	if (!g_bTourneyFrozen) return;
	if (g_State != MS_Live || InReadyUp() || g_bRoundEnded || g_fRoundLiveAt <= 0.0) return;
	if (LeaveRotoblinPaused())
	{
		g_fTourneyApplyAt = 0.0;
		return;
	}
	float now = GetEngineTime();
	if (g_fTourneyApplyAt > 0.0 && now - g_fTourneyApplyAt < Tourney_RetryGap()) return;
	int c = LeaveAnyTeamClient(0);
	if (c == -1) return;
	g_fTourneyApplyAt = now;
	// Unbudgeted and without a ceiling, as the leave module's pause (pug-pause.inc).
	PauseAllowInternal();
	FakeClientCommand(c, "sm_pause");
}

/** TOURNEY_RETRY_GAP, or longer than Rotoblin's pause delay when one is set. */
float Tourney_RetryGap()
{
	static ConVar delay = null;
	if (delay == null) delay = FindConVar("rotoblin_pausedelay");
	float gap = TOURNEY_RETRY_GAP;
	if (delay != null && delay.FloatValue + 2.0 > gap) gap = delay.FloatValue + 2.0;
	return gap;
}

/** From the pause clock (pug-pause.inc Timer_PauseClock), once a second: a
 *  freeze that did not land (Rotoblin's unpause countdown was running, nobody
 *  was on a side, the pause was refused) is tried again, a second or more
 *  after the round went live. */
void Tourney_Tick()
{
	if (!g_bTourneyFrozen) return;
	if (g_fRoundLiveAt > 0.0 && GetGameTime() - g_fRoundLiveAt < TOURNEY_FREEZE_DELAY) return;
	Tourney_Apply();
}

/** From OnRoundIsLive: a freeze that waited through a ready-up lands now. */
void Tourney_OnRoundLive()
{
	g_fTourneyApplyAt = 0.0;
	if (g_bTourneyFrozen) CreateTimer(TOURNEY_FREEZE_DELAY, Timer_TourneyApply, _, TIMER_FLAG_NO_MAPCHANGE);
}

public Action Timer_TourneyApply(Handle timer)
{
	Tourney_Apply();
	return Plugin_Stop;
}

/** Clear the freeze (and tell the site), say who did it when `who` is not
 *  empty, and unpause unless the leave module is still waiting for someone:
 *  it unpauses on its own when they are back. `unpause` false leaves the
 *  unpause to whoever is already doing it (an admin's !forceunpause). */
void Tourney_Lift(const char[] by, const char[] cause, const char[] who, bool unpause = true)
{
	if (!g_bTourneyFrozen) return;
	g_bTourneyFrozen = false;
	g_fTourneyApplyAt = 0.0;
	Tourney_Emit(false, by, cause);
	if (!unpause)
	{
		if (who[0] != '\0') PrintToChatAll("\x04[Match]\x01 %s lifted the freeze with !forceunpause.", who);
		return;
	}
	bool waiting = LeaveAnyAbsent();
	if (who[0] != '\0')
	{
		PrintToChatAll("\x04[Match]\x01 %s lifted the freeze.%s", who,
			!LeaveRotoblinPaused() ? "" : waiting ? " The game stays paused until the dropped player is back." : " Unpausing.");
	}
	if (LeaveRotoblinPaused() && !waiting) LeaveUnpauseNow();
}

void Tourney_Emit(bool on, const char[] by, const char[] cause)
{
	EmitPug("ADMINPAUSE state=%s by=%s cause=%s", on ? "on" : "off", by, cause);
}

/** sm_pug_adminpause <token> on|off ["by"]: the desk's Freeze and Unfreeze. */
public Action Cmd_AdminPause(int args)
{
	if (!TokenArgOk(args)) return Plugin_Handled;
	if (args < 2)
	{
		PrintToServer("PUGERR usage: sm_pug_adminpause <token> on|off [\"by\"]");
		return Plugin_Handled;
	}
	char state[8], who[64];
	GetCmdArg(2, state, sizeof(state));
	if (args >= 3) GetCmdArg(3, who, sizeof(who));
	SanitizeChat(who, sizeof(who));
	TrimString(who);
	if (who[0] == '\0') strcopy(who, sizeof(who), "Staff");
	if (StrEqual(state, "on"))
	{
		if (!g_bTourneyFrozen) PrintToChatAll("\x04[Match]\x01 %s froze the game from the site. Only staff can lift it.", who);
		Tourney_Freeze("site", "staff");
	}
	else if (StrEqual(state, "off"))
	{
		Tourney_Lift("site", "staff", who);
	}
	else
	{
		PrintToServer("PUGERR adminpause state is on or off");
		return Plugin_Handled;
	}
	PrintToServer("PUGOK adminpause=%s frozen=%d", state, g_bTourneyFrozen ? 1 : 0);
	return Plugin_Handled;
}

/** sm_pug_lift / !lift from a staff member in game. */
public Action Cmd_Lift(int client, int args)
{
	if (client == 0)
	{
		PrintToServer("PUGERR sm_pug_lift is for staff in game; from the console use sm_pug_adminpause <token> off");
		return Plugin_Handled;
	}
	Tourney_LiftFromGame(client);
	return Plugin_Handled;
}

void Tourney_LiftFromGame(int client)
{
	if (client < 1 || client > MaxClients || !IsClientInGame(client)) return;
	if (!Tourney_IsStaff(client))
	{
		PrintToChat(client, "[Match] Only staff can lift the freeze.");
		return;
	}
	if (!g_bTourneyFrozen)
	{
		PrintToChat(client, "[Match] The game is not frozen.");
		return;
	}
	char id[24], name[MAX_NAME_LENGTH];
	if (!ModCall_AuthId(client, id, sizeof(id))) strcopy(id, sizeof(id), "site");
	GetClientName(client, name, sizeof(name));
	Tourney_Lift(id, "staff", name);
}

/** Rotoblin's unpause commands (sm_ready, sm_r, sm_unpause): refused from
 *  non-staff while the freeze holds a real pause. During a ready-up nothing
 *  is paused and sm_ready is readyup's own, so it passes. The module's own
 *  fake sm_ready (LeaveUnpauseNow from Tourney_Lift) needs no exemption: the
 *  freeze is already cleared when it is sent. */
public Action Listener_TourneyUnpause(int client, const char[] command, int argc)
{
	if (!g_bTourneyFrozen) return Plugin_Continue;
	if (client < 1 || client > MaxClients || !IsClientInGame(client)) return Plugin_Continue;
	if (!LeaveRotoblinPaused()) return Plugin_Continue;
	if (Tourney_IsStaff(client)) return Plugin_Continue;
	PrintToChat(client, "[Match] Staff froze the game. Only staff can lift it: !lift in game, or the Events desk.");
	return Plugin_Handled;
}

/** An admin's !forceunpause while the freeze holds a pause: Rotoblin runs its
 *  countdown and this module cannot stop it, so the freeze is lifted with
 *  cause=forced and the site's desk follows. The same flags Rotoblin demands
 *  (root or generic); anyone else is refused by Rotoblin and changes nothing. */
public Action Listener_TourneyForceUnpause(int client, const char[] command, int argc)
{
	if (!g_bTourneyFrozen) return Plugin_Continue;
	if (client < 1 || client > MaxClients || !IsClientInGame(client)) return Plugin_Continue;
	int flags = GetUserFlagBits(client);
	if (!(flags & ADMFLAG_ROOT) && !(flags & ADMFLAG_GENERIC)) return Plugin_Continue;
	if (!LeaveRotoblinPaused()) return Plugin_Continue;
	char id[24], name[MAX_NAME_LENGTH];
	if (!ModCall_AuthId(client, id, sizeof(id))) strcopy(id, sizeof(id), "site");
	GetClientName(client, name, sizeof(name));
	Tourney_Lift(id, "forced", name, false);
	return Plugin_Continue;
}
