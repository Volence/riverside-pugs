#pragma semicolon 1
#pragma newdecls required

#include <sourcemod>
#include <sdktools>
#include <left4dhooks>
#undef REQUIRE_PLUGIN
#include <readyup>
#define REQUIRE_PLUGIN

#define PLUGIN_VERSION "0.1.0"

#define MAX_ROSTER 8
#define MAX_MAPS 8
#define TEAM_SPEC 1
#define TEAM_SURVIVOR 2
#define TEAM_INFECTED 3
#define ZC_TANK 5
#define LOCK_ATTEMPT_CAP 6

enum MatchState
{
	MS_None = 0,   // no match configured
	MS_Pending,    // sm_pug_match received, waiting for first round to go live
	MS_Live,       // match running
	MS_Ended       // finale reached; frozen, awaiting sm_pug_dump / sm_pug_abort
}

MatchState g_State = MS_None;
int g_iMatchId;
char g_sToken[65];
char g_sCampaign[64];

// Roster: fixed slots, parallel arrays, keyed by SteamID64.
char g_sRosterId[MAX_ROSTER][32];
int g_iRosterTeam[MAX_ROSTER];          // 1 = a, 2 = b
int g_iRosterCount;

// Per-player stats (parallel to roster slots) — survive reconnects and map changes.
int g_iStatSiDmg[MAX_ROSTER];
int g_iStatSiKill[MAX_ROSTER];
int g_iStatCk[MAX_ROSTER];
int g_iStatFf[MAX_ROSTER];
int g_iStatRev[MAX_ROSTER];

// Per-map results — survive map changes.
char g_sMapName[MAX_MAPS][64];
int g_iMapScoreA[MAX_MAPS];
int g_iMapScoreB[MAX_MAPS];
int g_iMapCount;

// Current-map bookkeeping (reset each OnMapStart).
char g_sCurrentMap[64];
int g_iHalfScoreA;
int g_iHalfScoreB;
int g_iRound1Logical;                    // logical team (1|2) that played survivors in half 1; 0 = unknown
bool g_bRoundEnded;                      // round_end latch (round_end can fire more than once)
bool g_bHalfWasLive;                     // set by OnRoundIsLive; guards ready-up restarts

// Enforcement.
int g_iPugSide[3];                       // [1] = game team of pug team a, [2] = of pug b (0 = unknown)
int g_iClientRoster[MAXPLAYERS + 1];     // client -> roster slot, -1 = not rostered
int g_iLockAttempts[MAXPLAYERS + 1];
int g_iLastHealth[MAXPLAYERS + 1];       // for SI overkill remainder

bool g_bReadyUpAvailable;

public Plugin myinfo =
{
	name = "PUG Match",
	author = "volence",
	description = "Ranked PUG match enforcement and reporting (counterpart of pug-web)",
	version = PLUGIN_VERSION,
	url = ""
};

public void OnPluginStart()
{
	RegServerCmd("sm_pug_match", Cmd_Match, "sm_pug_match <matchid> <token> <campaign>");
	RegServerCmd("sm_pug_roster", Cmd_Roster, "sm_pug_roster <steamid64>:<a|b>");
	RegServerCmd("sm_pug_abort", Cmd_Abort, "sm_pug_abort <token>");
	RegServerCmd("sm_pug_dump", Cmd_Dump, "sm_pug_dump <token>");

	HookEvent("round_start", Event_RoundStart);
	HookEvent("round_end", Event_RoundEnd);
	HookEvent("player_hurt", Event_PlayerHurt);
	HookEvent("player_death", Event_PlayerDeath);
	HookEvent("infected_death", Event_InfectedDeath);
	HookEvent("revive_success", Event_ReviveSuccess);
	HookEvent("player_spawn", Event_PlayerSpawn);

	// Persistent repeating timers (no TIMER_FLAG_NO_MAPCHANGE — they must survive changelevel).
	CreateTimer(30.0, Timer_Heartbeat, _, TIMER_REPEAT);
	CreateTimer(2.0, Timer_TeamLock, _, TIMER_REPEAT);

	g_bReadyUpAvailable = LibraryExists("readyup");
	for (int i = 0; i <= MAXPLAYERS; i++) g_iClientRoster[i] = -1;
}

public void OnLibraryAdded(const char[] name)
{
	if (StrEqual(name, "readyup")) g_bReadyUpAvailable = true;
}

public void OnLibraryRemoved(const char[] name)
{
	if (StrEqual(name, "readyup")) g_bReadyUpAvailable = false;
}

bool InReadyUp()
{
	return g_bReadyUpAvailable && IsInReady();
}

// ---------- emission helpers: the wire grammar lives here and only here ----------

/** Live-view line over the logaddress UDP stream. LogToGame is the ONLY native
 *  that reaches logaddress — LogMessage/LogAction stay on the box. */
void EmitPug(const char[] fmt, any ...)
{
	if (g_State == MS_None) return;
	char body[480];
	VFormat(body, sizeof(body), fmt, 2);
	LogToGame("PUG %s %s", g_sToken, body);
}

/** Authoritative dump line into the RCON response body of the running server cmd. */
void DumpLine(const char[] fmt, any ...)
{
	char line[480];
	VFormat(line, sizeof(line), fmt, 2);
	PrintToServer("%s", line);
}

// ---------- RCON command intake ----------

public Action Cmd_Match(int args)
{
	if (args < 3)
	{
		PrintToServer("PUGERR usage: sm_pug_match <matchid> <token> <campaign>");
		return Plugin_Handled;
	}
	char buf[65];
	GetCmdArg(1, buf, sizeof(buf));
	int matchId = StringToInt(buf);
	if (matchId <= 0)
	{
		PrintToServer("PUGERR bad matchid");
		return Plugin_Handled;
	}
	ResetMatchState();
	g_iMatchId = matchId;
	GetCmdArg(2, g_sToken, sizeof(g_sToken));
	GetCmdArg(3, g_sCampaign, sizeof(g_sCampaign));
	g_State = MS_Pending;
	// Convention shared with the backend: pug team a starts as survivors on map 1.
	g_iPugSide[1] = TEAM_SURVIVOR;
	g_iPugSide[2] = TEAM_INFECTED;
	PrintToServer("PUGOK match=%d", g_iMatchId);
	return Plugin_Handled;
}

public Action Cmd_Roster(int args)
{
	if (g_State == MS_None || args < 1)
	{
		PrintToServer("PUGERR no match configured");
		return Plugin_Handled;
	}
	if (g_iRosterCount >= MAX_ROSTER)
	{
		PrintToServer("PUGERR roster full");
		return Plugin_Handled;
	}
	char arg[48];
	GetCmdArg(1, arg, sizeof(arg));
	int sep = FindCharInString(arg, ':');
	if (sep <= 0 || sep >= strlen(arg) - 1)
	{
		PrintToServer("PUGERR bad roster arg: %s", arg);
		return Plugin_Handled;
	}
	arg[sep] = '\0';
	char teamChar = arg[sep + 1];
	int team = (teamChar == 'a') ? 1 : (teamChar == 'b') ? 2 : 0;
	if (team == 0)
	{
		PrintToServer("PUGERR bad team letter");
		return Plugin_Handled;
	}
	strcopy(g_sRosterId[g_iRosterCount], 32, arg);
	g_iRosterTeam[g_iRosterCount] = team;
	g_iRosterCount++;
	PrintToServer("PUGOK roster=%d", g_iRosterCount);
	return Plugin_Handled;
}

public Action Cmd_Abort(int args)
{
	if (!TokenArgOk(args)) return Plugin_Handled;
	ResetMatchState();
	PrintToServer("PUGOK aborted");
	return Plugin_Handled;
}

public Action Cmd_Dump(int args)
{
	if (!TokenArgOk(args)) return Plugin_Handled;
	WriteDump();
	return Plugin_Handled;
}

/** Shared token check for abort/dump: arg 1 must equal the active match token. */
bool TokenArgOk(int args)
{
	if (g_State == MS_None)
	{
		PrintToServer("PUGERR no match configured");
		return false;
	}
	if (args < 1)
	{
		PrintToServer("PUGERR token required");
		return false;
	}
	char token[65];
	GetCmdArg(1, token, sizeof(token));
	if (!StrEqual(token, g_sToken))
	{
		PrintToServer("PUGERR bad token");
		return false;
	}
	return true;
}

void ResetMatchState()
{
	g_State = MS_None;
	g_iMatchId = 0;
	g_sToken[0] = '\0';
	g_sCampaign[0] = '\0';
	g_iRosterCount = 0;
	g_iMapCount = 0;
	g_iHalfScoreA = 0;
	g_iHalfScoreB = 0;
	g_iRound1Logical = 0;
	g_bRoundEnded = false;
	g_bHalfWasLive = false;
	g_iPugSide[1] = 0;
	g_iPugSide[2] = 0;
	for (int i = 0; i < MAX_ROSTER; i++)
	{
		g_sRosterId[i][0] = '\0';
		g_iRosterTeam[i] = 0;
		g_iStatSiDmg[i] = 0;
		g_iStatSiKill[i] = 0;
		g_iStatCk[i] = 0;
		g_iStatFf[i] = 0;
		g_iStatRev[i] = 0;
	}
	for (int i = 0; i <= MAXPLAYERS; i++)
	{
		g_iClientRoster[i] = -1;
		g_iLockAttempts[i] = 0;
	}
}

public Action Timer_Heartbeat(Handle timer)
{
	if (g_State != MS_None) EmitPug("HEARTBEAT");
	return Plugin_Continue;
}

// ---------- roster / enforcement ----------

int RosterIndexOfId(const char[] steamid64)
{
	for (int i = 0; i < g_iRosterCount; i++)
	{
		if (StrEqual(g_sRosterId[i], steamid64)) return i;
	}
	return -1;
}

public void OnClientPostAdminCheck(int client)
{
	g_iClientRoster[client] = -1;
	g_iLockAttempts[client] = 0;
	if (g_State == MS_None || IsFakeClient(client)) return;
	char id[32];
	if (!GetClientAuthId(client, AuthId_SteamID64, id, sizeof(id)))
	{
		KickClient(client, "Could not verify Steam ID");
		return;
	}
	int slot = RosterIndexOfId(id);
	if (slot == -1)
	{
		KickClient(client, "You are not on this match's roster");
		return;
	}
	g_iClientRoster[client] = slot;
	EmitPug("PLAYER steamid=%s event=connect", id);
}

public void OnClientDisconnect(int client)
{
	int slot = g_iClientRoster[client];
	g_iClientRoster[client] = -1;
	g_iLockAttempts[client] = 0;
	if (slot != -1 && g_State != MS_None)
	{
		EmitPug("PLAYER steamid=%s event=disconnect", g_sRosterId[slot]);
	}
}

/** Observation-based cohesion lock. Every tick:
 *  1. Adopt the pug-team<->side mapping from where rostered players actually sit
 *     (strict majority of a pug team on one side updates the mapping; the other
 *     team gets the opposite side). Seeded a=survivors/b=infected at match set.
 *  2. Move any rostered player not on their team's side via Rotoblin's own
 *     sm_sur / sm_inf (the l4d_team_unscramble pattern), with a per-client
 *     attempt cap so we never fight the engine forever. */
public Action Timer_TeamLock(Handle timer)
{
	if (g_State == MS_None || g_State == MS_Ended) return Plugin_Continue;

	int onSide[3][4]; // [pugTeam][gameTeam] counts; gameTeam index 2|3 used
	for (int c = 1; c <= MaxClients; c++)
	{
		int slot = g_iClientRoster[c];
		if (slot == -1 || !IsClientInGame(c)) continue;
		int gt = GetClientTeam(c);
		if (gt == TEAM_SURVIVOR || gt == TEAM_INFECTED) onSide[g_iRosterTeam[slot]][gt]++;
	}
	for (int pug = 1; pug <= 2; pug++)
	{
		if (onSide[pug][TEAM_SURVIVOR] > onSide[pug][TEAM_INFECTED] && onSide[pug][TEAM_SURVIVOR] >= 2)
		{
			g_iPugSide[pug] = TEAM_SURVIVOR;
			g_iPugSide[3 - pug] = TEAM_INFECTED;
		}
		else if (onSide[pug][TEAM_INFECTED] > onSide[pug][TEAM_SURVIVOR] && onSide[pug][TEAM_INFECTED] >= 2)
		{
			g_iPugSide[pug] = TEAM_INFECTED;
			g_iPugSide[3 - pug] = TEAM_SURVIVOR;
		}
	}

	for (int c = 1; c <= MaxClients; c++)
	{
		int slot = g_iClientRoster[c];
		if (slot == -1 || !IsClientInGame(c)) continue;
		int want = g_iPugSide[g_iRosterTeam[slot]];
		if (want == 0) continue;
		int have = GetClientTeam(c);
		if (have == want) { g_iLockAttempts[c] = 0; continue; }
		if (g_iLockAttempts[c] >= LOCK_ATTEMPT_CAP) continue;
		g_iLockAttempts[c]++;
		if (want == TEAM_SURVIVOR) FakeClientCommand(c, "sm_sur");
		else FakeClientCommand(c, "sm_inf");
	}
	return Plugin_Continue;
}

// ---------- match flow ----------

public void OnMapStart()
{
	GetCurrentMap(g_sCurrentMap, sizeof(g_sCurrentMap));
	g_iHalfScoreA = 0;
	g_iHalfScoreB = 0;
	g_iRound1Logical = 0;
	g_bRoundEnded = false;
	g_bHalfWasLive = false;

	if (g_State == MS_Live && L4D_IsMissionFinalMap(true))
	{
		// Campaign-minus-finale complete: freeze and report. Backend follows with
		// sm_pug_dump (authoritative) + sm_pug_abort.
		g_State = MS_Ended;
		int a, b;
		TotalScores(a, b);
		char winner[8];
		WinnerOf(a, b, winner, sizeof(winner));
		EmitPug("MATCH_END a=%d b=%d winner=%s", a, b, winner);
	}
}

/** Rotoblin ready-up go-live signal (global forward; fires even if we never call
 *  the readyup natives). First live round flips Pending -> Live. */
public void OnRoundIsLive()
{
	g_bHalfWasLive = true;
	if (g_State == MS_Pending)
	{
		g_State = MS_Live;
		EmitPug("MATCH_START map=%s", g_sCurrentMap);
	}
}

public void Event_RoundStart(Event event, const char[] name, bool dontBroadcast)
{
	g_bRoundEnded = false;
	g_bHalfWasLive = false;
	for (int i = 0; i <= MAXPLAYERS; i++)
	{
		g_iLockAttempts[i] = 0;
		g_iLastHealth[i] = 0;
	}
}

/** End-of-half scoring. Scores may be written by the engine marginally after
 *  round_end, so the actual read happens on a 2.0s one-shot timer (versus map
 *  transitions take ~10s; safe) with up to 3 retries while the score reads -1.
 *
 *  Self-calibration (avoids the logical-team relabeling trap, see plan header):
 *  at half-1 end exactly one logical team has played, so its score != -1 —
 *  that index IS the half-1 survivor team. Half 2's survivors are the other. */
public void Event_RoundEnd(Event event, const char[] name, bool dontBroadcast)
{
	if (g_State != MS_Live || g_bRoundEnded || !g_bHalfWasLive) return;
	g_bRoundEnded = true;
	bool second = view_as<bool>(GameRules_GetProp("m_bInSecondHalfOfRound"));
	int survPug = ObserveSurvivorPugTeam();
	DataPack pack;
	CreateDataTimer(2.0, Timer_ReadScore, pack, TIMER_FLAG_NO_MAPCHANGE);
	pack.WriteCell(second ? 1 : 0);
	pack.WriteCell(survPug);
	pack.WriteCell(0); // retry counter
}

/** Which pug team currently holds the survivor side, by majority of rostered
 *  in-game players. 0 if unknown (no rostered survivors visible). */
int ObserveSurvivorPugTeam()
{
	int count[3];
	for (int c = 1; c <= MaxClients; c++)
	{
		int slot = g_iClientRoster[c];
		if (slot == -1 || !IsClientInGame(c)) continue;
		if (GetClientTeam(c) == TEAM_SURVIVOR) count[g_iRosterTeam[slot]]++;
	}
	if (count[1] > count[2]) return 1;
	if (count[2] > count[1]) return 2;
	return 0;
}

public Action Timer_ReadScore(Handle timer, DataPack pack)
{
	pack.Reset();
	bool second = pack.ReadCell() != 0;
	int survPug = pack.ReadCell();
	int attempt = pack.ReadCell();
	if (g_State != MS_Live) return Plugin_Stop;

	int survLogical;
	if (!second)
	{
		int s1 = L4D_GetTeamScore(1, false);
		int s2 = L4D_GetTeamScore(2, false);
		survLogical = (s1 != -1) ? 1 : (s2 != -1) ? 2 : 0;
		if (survLogical != 0) g_iRound1Logical = survLogical;
	}
	else
	{
		survLogical = (g_iRound1Logical != 0) ? (3 - g_iRound1Logical) : 0;
	}

	int score = (survLogical != 0) ? L4D_GetTeamScore(survLogical, false) : -1;
	if (score < 0)
	{
		if (attempt < 3)
		{
			DataPack retry;
			CreateDataTimer(2.0, Timer_ReadScore, retry, TIMER_FLAG_NO_MAPCHANGE);
			retry.WriteCell(second ? 1 : 0);
			retry.WriteCell(survPug);
			retry.WriteCell(attempt + 1);
		}
		else
		{
			LogError("[pug] could not read round score (half %d, logical %d)", second ? 2 : 1, survLogical);
			if (second) FinalizeMap();
		}
		return Plugin_Stop;
	}

	if (survPug == 1) g_iHalfScoreA += score;
	else if (survPug == 2) g_iHalfScoreB += score;
	else LogError("[pug] round score %d unattributable: no rostered survivors observed", score);

	if (second) FinalizeMap();
	return Plugin_Stop;
}

void FinalizeMap()
{
	if (g_iMapCount >= MAX_MAPS) return;
	strcopy(g_sMapName[g_iMapCount], 64, g_sCurrentMap);
	g_iMapScoreA[g_iMapCount] = g_iHalfScoreA;
	g_iMapScoreB[g_iMapCount] = g_iHalfScoreB;
	g_iMapCount++;
	EmitPug("MAP_RESULT map=%s a=%d b=%d", g_sCurrentMap, g_iHalfScoreA, g_iHalfScoreB);
}

void TotalScores(int &a, int &b)
{
	a = 0;
	b = 0;
	for (int i = 0; i < g_iMapCount; i++)
	{
		a += g_iMapScoreA[i];
		b += g_iMapScoreB[i];
	}
}

void WinnerOf(int a, int b, char[] out, int maxlen)
{
	if (a > b) strcopy(out, maxlen, "a");
	else if (b > a) strcopy(out, maxlen, "b");
	else strcopy(out, maxlen, "draw");
}

// ---------- stats (l4dcompstats.sp port, core five, keyed by roster slot) ----------

bool StatsActive()
{
	return g_State == MS_Live && !g_bRoundEnded && !InReadyUp();
}

bool IsSurvivorClient(int client)
{
	return client > 0 && client <= MaxClients && IsClientInGame(client) && GetClientTeam(client) == TEAM_SURVIVOR;
}

bool IsInfectedClient(int client)
{
	return client > 0 && client <= MaxClients && IsClientInGame(client) && GetClientTeam(client) == TEAM_INFECTED;
}

public void Event_PlayerHurt(Event event, const char[] name, bool dontBroadcast)
{
	if (!StatsActive()) return;
	int victim = GetClientOfUserId(event.GetInt("userid"));
	int attacker = GetClientOfUserId(event.GetInt("attacker"));
	if (attacker <= 0) return;
	int damage = event.GetInt("dmg_health");
	if (damage <= 0) return;
	int slot = (attacker <= MaxClients) ? g_iClientRoster[attacker] : -1;
	if (slot == -1 || !IsSurvivorClient(attacker)) return;

	if (IsSurvivorClient(victim))
	{
		g_iStatFf[slot] += damage;      // friendly fire dealt
	}
	else if (IsInfectedClient(victim) && !IsFakeClient(victim))
	{
		// SI damage: player-controlled smoker/boomer/hunter. Tank excluded
		// (compstats convention). Overkill remainder is granted on player_death.
		if (GetEntProp(victim, Prop_Send, "m_zombieClass") == ZC_TANK) return;
		int remaining = event.GetInt("health");
		if (remaining <= 0) return;
		g_iLastHealth[victim] = remaining;
		g_iStatSiDmg[slot] += damage;
	}
}

public void Event_PlayerDeath(Event event, const char[] name, bool dontBroadcast)
{
	if (!StatsActive()) return;
	int victim = GetClientOfUserId(event.GetInt("userid"));
	int attacker = GetClientOfUserId(event.GetInt("attacker"));
	if (attacker <= 0 || victim <= 0) return;
	int slot = (attacker <= MaxClients) ? g_iClientRoster[attacker] : -1;
	if (slot == -1 || !IsSurvivorClient(attacker) || !IsInfectedClient(victim) || IsFakeClient(victim)) return;
	if (GetEntProp(victim, Prop_Send, "m_zombieClass") == ZC_TANK) return;
	g_iStatSiKill[slot]++;
	g_iStatSiDmg[slot] += g_iLastHealth[victim]; // overkill remainder
	g_iLastHealth[victim] = 0;
}

public void Event_InfectedDeath(Event event, const char[] name, bool dontBroadcast)
{
	if (!StatsActive()) return;
	int attacker = GetClientOfUserId(event.GetInt("attacker"));
	if (attacker <= 0 || attacker > MaxClients) return;
	int slot = g_iClientRoster[attacker];
	if (slot == -1 || !IsSurvivorClient(attacker)) return;
	g_iStatCk[slot]++;
}

public void Event_ReviveSuccess(Event event, const char[] name, bool dontBroadcast)
{
	if (!StatsActive()) return;
	int reviver = GetClientOfUserId(event.GetInt("userid"));
	if (reviver <= 0 || reviver > MaxClients) return;
	int slot = g_iClientRoster[reviver];
	if (slot == -1) return;
	g_iStatRev[slot]++;
}

public void Event_PlayerSpawn(Event event, const char[] name, bool dontBroadcast)
{
	int client = GetClientOfUserId(event.GetInt("userid"));
	if (client > 0 && client <= MaxClients) g_iLastHealth[client] = 0;
}

/** Authoritative match record over the RCON response body. Idempotent:
 *  the backend may call sm_pug_dump repeatedly. */
void WriteDump()
{
	DumpLine("DUMP match=%d", g_iMatchId);
	for (int i = 0; i < g_iMapCount; i++)
	{
		DumpLine("MAP map=%s a=%d b=%d", g_sMapName[i], g_iMapScoreA[i], g_iMapScoreB[i]);
	}
	for (int i = 0; i < g_iRosterCount; i++)
	{
		DumpLine("STAT steamid=%s team=%s sidmg=%d sikill=%d ck=%d ff=%d rev=%d",
			g_sRosterId[i], g_iRosterTeam[i] == 1 ? "a" : "b",
			g_iStatSiDmg[i], g_iStatSiKill[i], g_iStatCk[i], g_iStatFf[i], g_iStatRev[i]);
	}
	int a, b;
	TotalScores(a, b);
	char winner[8];
	WinnerOf(a, b, winner, sizeof(winner));
	DumpLine("END winner=%s a=%d b=%d", winner, a, b);
}
