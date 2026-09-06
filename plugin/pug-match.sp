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

// Per-player stats (parallel to roster slots). These survive reconnects and map changes.
int g_iStatSiDmg[MAX_ROSTER];
int g_iStatSiKill[MAX_ROSTER];
int g_iStatCk[MAX_ROSTER];
int g_iStatFf[MAX_ROSTER];
int g_iStatRev[MAX_ROSTER];

// Per-map results. These survive map changes.
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
bool g_bPendingFinalize;                 // set when 2nd-half round_end fires; cleared by FinalizeMap.
                                          // OnMapStart failsafe: if still set at changelevel, finalize
                                          // with whatever half scores were accumulated so far so the
                                          // map can never silently vanish from the record.

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

	// Persistent repeating timers (no TIMER_FLAG_NO_MAPCHANGE, since they must survive changelevel).
	CreateTimer(30.0, Timer_Heartbeat, _, TIMER_REPEAT);
	CreateTimer(2.0, Timer_TeamLock, _, TIMER_REPEAT);

	g_bReadyUpAvailable = LibraryExists("readyup");
	for (int i = 0; i <= MAXPLAYERS; i++) g_iClientRoster[i] = -1;

	// So MATCH_START can never emit an empty map= on a late plugin load/reload
	// mid-map (OnMapStart won't fire again until the next changelevel).
	GetCurrentMap(g_sCurrentMap, sizeof(g_sCurrentMap));
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
 *  that reaches logaddress. LogMessage/LogAction stay on the box. */
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
	g_bPendingFinalize = false;
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

/** NOTE: SourceMod re-fires OnClientPostAdminCheck/OnClientDisconnect for every
 *  client across a map transition (clients "reconnect" through the changelevel),
 *  so PLAYER connect/disconnect lines pulse once per changelevel for players who
 *  never actually left. The backend must not treat these as abandons. */
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
 *  1. Adopt the pug-team<->side mapping from where rostered players actually sit,
 *     via a single JOINT orientation vote (not two independent per-team votes, because
 *     independent votes can transiently contradict each other, e.g. both pug
 *     teams momentarily showing players on the survivor side during join-in,
 *     causing a last-writer-wins flip that inverts the map-1 seed). Only a clear
 *     combined majority moves the mapping; otherwise the current mapping (seed:
 *     a=survivors/b=infected at match set) stands.
 *  2. Move any rostered player not on their team's side via Rotoblin's own
 *     sm_sur / sm_inf (the l4d_team_unscramble pattern), with a per-client
 *     attempt cap so we never fight the engine forever. Infected -> survivor
 *     moves bounce through spectate first (l4d_team_unscramble.sp:441-455), so
 *     a direct sm_sur from the infected side can silently fail to stick. */
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

	int straight = onSide[1][TEAM_SURVIVOR] + onSide[2][TEAM_INFECTED]; // a=surv, b=inf
	int inverted = onSide[1][TEAM_INFECTED] + onSide[2][TEAM_SURVIVOR]; // a=inf, b=surv
	if (straight > inverted && straight >= 3)
	{
		g_iPugSide[1] = TEAM_SURVIVOR;
		g_iPugSide[2] = TEAM_INFECTED;
	}
	else if (inverted > straight && inverted >= 3)
	{
		g_iPugSide[1] = TEAM_INFECTED;
		g_iPugSide[2] = TEAM_SURVIVOR;
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
		if (want == TEAM_SURVIVOR)
		{
			if (have == TEAM_INFECTED) ChangeClientTeam(c, TEAM_SPEC);
			FakeClientCommand(c, "sm_sur");
		}
		else FakeClientCommand(c, "sm_inf");
	}
	return Plugin_Continue;
}

// ---------- match flow ----------

public void OnMapStart()
{
	// Failsafe for the score-read/changelevel race: a 2nd-half round_end set
	// g_bPendingFinalize, but the map changed before FinalizeMap ran (e.g. the
	// delayed score-read retry chain (up to ~8s) was still in flight and got
	// silently dropped by TIMER_FLAG_NO_MAPCHANGE). Finalize now with whatever
	// half scores were accumulated so this map can never vanish from the record.
	// Must run before the per-map resets below and before the finale check, so
	// a finale-triggering MATCH_END totals include this map.
	if (g_bPendingFinalize) FinalizeMap();

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

/** End-of-half scoring.
 *
 *  Primary path: read the score SYNCHRONOUSLY, right here in the round_end
 *  handler. l4dscores.sp reads GetTeamRoundScore synchronously in its own
 *  round_end handler, and our Post hook runs after its Pre-hook recompute, so
 *  the score is normally already final by the time we get here. This avoids
 *  racing a changelevel against the delayed retry chain below (that chain used
 *  TIMER_FLAG_NO_MAPCHANGE, so a race could silently drop the last map's score
 *  before the finale. See g_bPendingFinalize / the OnMapStart failsafe for the
 *  backstop if this synchronous read genuinely isn't ready yet).
 *
 *  Fallback path: only if the sync read returns -1, fall back to the delayed
 *  0.0s+2.0s retry chain (versus map transitions take ~10s; safe) with up to 3
 *  retries while the score reads -1.
 *
 *  Self-calibration (avoids the logical-team relabeling trap, see plan header):
 *  at half-1 end exactly one logical team has played, so its score != -1.
 *  that index IS the half-1 survivor team. Half 2's survivors are the other. */
public void Event_RoundEnd(Event event, const char[] name, bool dontBroadcast)
{
	if (g_State != MS_Live || g_bRoundEnded || !g_bHalfWasLive) return;
	g_bRoundEnded = true;
	bool second = view_as<bool>(GameRules_GetProp("m_bInSecondHalfOfRound"));
	int survPug = ObserveSurvivorPugTeam();
	if (second) g_bPendingFinalize = true;

	int score = TryReadRoundScore(second);
	if (score >= 0)
	{
		AttributeScore(survPug, score);
		if (second) FinalizeMap();
		return;
	}

	DataPack pack;
	CreateDataTimer(2.0, Timer_ReadScore, pack, TIMER_FLAG_NO_MAPCHANGE);
	pack.WriteCell(second ? 1 : 0);
	pack.WriteCell(survPug);
	pack.WriteCell(0); // retry counter
}

/** One read attempt of the current half's survivor round score. Returns the
 *  score (>=0), or -1 if the engine hasn't written it yet. Shared by the
 *  synchronous primary path (Event_RoundEnd) and the delayed retry chain
 *  (Timer_ReadScore) so the calibration logic lives in exactly one place. */
int TryReadRoundScore(bool second)
{
	int survLogical;
	if (!second)
	{
		int s1 = L4D_GetTeamScore(1, false);
		int s2 = L4D_GetTeamScore(2, false);
		if (s1 != -1 && s2 != -1)
		{
			// Should be impossible per the plan's self-calibration design (exactly
			// one logical team has played by half-1 end), so surface it on staging.
			LogError("[pug] half-1 calibration: both logical teams have scores (s1=%d s2=%d)", s1, s2);
		}
		survLogical = (s1 != -1) ? 1 : (s2 != -1) ? 2 : 0;
		if (survLogical != 0) g_iRound1Logical = survLogical;
	}
	else
	{
		survLogical = (g_iRound1Logical != 0) ? (3 - g_iRound1Logical) : 0;
	}
	return (survLogical != 0) ? L4D_GetTeamScore(survLogical, false) : -1;
}

/** Credit a read round score to the observed pug team's half accumulator. */
void AttributeScore(int survPug, int score)
{
	if (survPug == 1) g_iHalfScoreA += score;
	else if (survPug == 2) g_iHalfScoreB += score;
	else LogError("[pug] round score %d unattributable: no rostered survivors observed", score);
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

	int score = TryReadRoundScore(second);
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
			LogError("[pug] could not read round score after retries (half %d)", second ? 2 : 1);
			// Finalize now (prompt MAP_RESULT) if the map hasn't changed yet.
			// If it HAS already changed, this TIMER_FLAG_NO_MAPCHANGE timer never
			// runs at all. g_bPendingFinalize is still set in that case, so the
			// OnMapStart failsafe finalizes with whatever was accumulated,
			// guaranteeing the map is recorded either way.
			if (second) FinalizeMap();
		}
		return Plugin_Stop;
	}

	AttributeScore(survPug, score);
	if (second) FinalizeMap();
	return Plugin_Stop;
}

void FinalizeMap()
{
	g_bPendingFinalize = false;
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
	if (attacker <= 0 || attacker > MaxClients || !IsSurvivorClient(attacker)) return;
	int damage = event.GetInt("dmg_health");
	if (damage <= 0) return;

	// SI damage: player-controlled smoker/boomer/hunter. Tank excluded
	// (compstats convention). Overkill remainder is granted on player_death.
	bool siVictim = IsInfectedClient(victim) && !IsFakeClient(victim)
		&& GetEntProp(victim, Prop_Send, "m_zombieClass") != ZC_TANK;
	int remaining = siVictim ? event.GetInt("health") : 0;
	if (siVictim && remaining > 0)
	{
		// Track remaining health for the death-time overkill-remainder credit for
		// ANY survivor attacker (rostered or not), not just the one we're about
		// to credit stats to below. If un-rostered/bot damage were skipped here,
		// g_iLastHealth would go stale (too high) and inflate the remainder later
		// credited to whichever rostered player actually lands the kill.
		g_iLastHealth[victim] = remaining;
	}

	int slot = g_iClientRoster[attacker];
	if (slot == -1) return;

	if (IsSurvivorClient(victim))
	{
		g_iStatFf[slot] += damage;      // friendly fire dealt (includes self-damage, matching l4dcompstats)
	}
	else if (siVictim && remaining > 0)
	{
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
	if (client <= 0 || client > MaxClients) return;
	g_iLastHealth[client] = 0;
	// A fresh one-shot SI (e.g. a hunter that gets skeeted before ever taking
	// non-lethal damage through player_hurt) needs its full spawn health latched
	// as the "remainder" up front, per l4dcompstats.sp's Event_PlayerSpawn. Otherwise
	// such kills would credit sidmg += 0 despite a full-health SI going down.
	if (IsInfectedClient(client) && !IsFakeClient(client)
		&& GetEntProp(client, Prop_Send, "m_zombieClass") != ZC_TANK)
	{
		g_iLastHealth[client] = GetClientHealth(client);
	}
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
