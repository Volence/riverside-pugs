/**
 * l4d_cvarwatch - put client settings that matter for fairness on the PUG wire.
 *
 * `cpu_level 0` drops effect detail, which thins smoke, fire and the boomer
 * cloud enough to see infected through them. The Mathack Block plugin already
 * polls it (log-only, `l4d_texture_manager_block.cfg`), but it writes its own
 * log file on each box, which the site cannot read. This asks the client
 * itself and reports on the logaddress stream the site already listens to, in
 * the same shape as the LilAC reporter.
 *
 * Reporting: once per connection per setting, so a player sitting on
 * cpu_level 0 all night is one line, not one every poll.
 *
 * Ready gate (l4d_cvarwatch_gate): during ready-up, a player on a team with
 * cpu_level 0 cannot stay ready. That is the whole enforcement. Nobody is
 * moved or kicked, because pug-match's team lock puts the rostered eight on
 * their sides and a plugin that moved them back to spectator would fight it
 * forever. Blocking ready instead holds the round in ready-up, which costs
 * nothing, until they change the setting. Once the round is live it is report
 * only, since pulling a player out mid-round hands their slot to a bot.
 *
 * Build: ./spcomp l4d_cvarwatch.sp with pug-logauth.inc and pug-hmac.inc beside it.
 */
#pragma semicolon 1
#pragma newdecls required
#include <sourcemod>
#undef REQUIRE_PLUGIN
#include <readyup>
#define REQUIRE_PLUGIN
#include "pug-logauth.inc"

#define PLUGIN_VERSION "0.2.0"
/** Report cadence outside ready-up. */
#define POLL_SECONDS 15
/** Cache refresh cadence during ready-up, so a fix is seen within a couple of seconds. */
#define READY_POLL_SECONDS 2
/** Seconds between private reminders to one player. */
#define NAG_SECONDS 5.0

#define TEAM_SPECTATOR 1

ConVar g_cvEnabled;
ConVar g_cvGate;
bool g_bReadyUp;
/** Whether this connection has already been reported for cpu_level. */
bool g_bReported[MAXPLAYERS + 1];
/** userid the per-client state below belongs to, so a reused slot starts clean. */
int g_iUserId[MAXPLAYERS + 1];
/** Last cpu_level the client answered with, or -1.0 while unknown. */
float g_fCpuLevel[MAXPLAYERS + 1];
/** Whether the lobby has been told this player is holding ready-up, this ready-up. */
bool g_bAnnounced[MAXPLAYERS + 1];
float g_fLastNag[MAXPLAYERS + 1];
int g_iTicks;

public Plugin myinfo = {
	name = "L4D1 Cvar Watch",
	author = "Riverside",
	description = "Reports client settings that matter for fairness to the PUG site, and keeps cpu_level 0 from readying up.",
	version = PLUGIN_VERSION,
	url = "https://riversidepug.com",
};

public void OnPluginStart()
{
	CreateConVar("l4d_cvarwatch_version", PLUGIN_VERSION, "Cvar watch version",
		FCVAR_NOTIFY | FCVAR_DONTRECORD);
	g_cvEnabled = CreateConVar("l4d_cvarwatch_enabled", "1",
		"Report client cpu_level below 1 to the site.", FCVAR_NOTIFY, true, 0.0, true, 1.0);
	g_cvGate = CreateConVar("l4d_cvarwatch_gate", "1",
		"During ready-up, un-ready any player whose cpu_level (Effect Detail) is Low.",
		FCVAR_NOTIFY, true, 0.0, true, 1.0);
	PugLogAuth_Init();

	// Every way l4dready readies a player: the chat words (!r, !ready and
	// friends), the F1 vote key, and its three hidden commands. None of these
	// is blocked; the check runs on the next frame, after l4dready has acted,
	// and takes the ready back. Parsing the words here instead would copy
	// l4dready's matching and drift from it, and blocking "Vote" would also
	// block real in-game votes.
	AddCommandListener(OnReadyAttempt, "say");
	AddCommandListener(OnReadyAttempt, "say_team");
	AddCommandListener(OnReadyAttempt, "Vote");
	AddCommandListener(OnReadyAttempt, "sm_bonesaw");
	AddCommandListener(OnReadyAttempt, "sm_trophy");
	AddCommandListener(OnReadyAttempt, "sm_harrypotter");

	for (int c = 1; c <= MaxClients; c++) ResetClient(c, 0);
	CreateTimer(1.0, Timer_Poll, _, TIMER_REPEAT);
}

public void OnClientDisconnect(int client)
{
	ResetClient(client, 0);
}

void ResetClient(int client, int uid)
{
	g_iUserId[client] = uid;
	g_bReported[client] = false;
	g_fCpuLevel[client] = -1.0;
	g_bAnnounced[client] = false;
	g_fLastNag[client] = 0.0;
}

bool InReadyUp()
{
	return LibraryExists("readyup") && IsInReady();
}

bool IsHumanPlayer(int client)
{
	return IsClientInGame(client) && !IsFakeClient(client) && !IsClientSourceTV(client);
}

/** Known Low. An unanswered or unknown query never counts against anyone. */
bool IsLow(int client)
{
	return g_fCpuLevel[client] >= 0.0 && g_fCpuLevel[client] < 1.0;
}

public Action Timer_Poll(Handle timer)
{
	bool ready = InReadyUp();
	if (ready != g_bReadyUp)
	{
		g_bReadyUp = ready;
		for (int c = 1; c <= MaxClients; c++) g_bAnnounced[c] = false;
	}

	g_iTicks++;
	bool gating = ready && g_cvGate.BoolValue;
	bool reportTick = g_iTicks % POLL_SECONDS == 0;
	bool gateTick = gating && g_iTicks % READY_POLL_SECONDS == 0;
	if (!reportTick && !gateTick) return Plugin_Continue;

	for (int c = 1; c <= MaxClients; c++)
	{
		if (!IsHumanPlayer(c)) continue;
		int uid = GetClientUserId(c);
		if (g_iUserId[c] != uid) ResetClient(c, uid);
		bool wantReport = reportTick && g_cvEnabled.BoolValue && !g_bReported[c];
		bool wantGate = gateTick && GetClientTeam(c) > TEAM_SPECTATOR;
		if (wantReport || wantGate) QueryClientConVar(c, "cpu_level", OnCpuLevel, uid);
	}
	return Plugin_Continue;
}

public void OnCpuLevel(QueryCookie cookie, int client, ConVarQueryResult result,
	const char[] name, const char[] value, any uid)
{
	if (result != ConVarQuery_Okay) return;
	if (!IsClientInGame(client) || GetClientUserId(client) != uid) return;
	g_fCpuLevel[client] = StringToFloat(value);
	if (!IsLow(client)) return;

	if (g_cvEnabled.BoolValue && !g_bReported[client])
	{
		Report(client, "cpu_level", value);
		g_bReported[client] = true;
	}
	// Catches a player who readied on Medium and then switched to Low.
	Gate(client);
}

public Action OnReadyAttempt(int client, const char[] command, int argc)
{
	if (client < 1 || client > MaxClients || !g_cvGate.BoolValue || !IsLow(client)) return Plugin_Continue;
	if (!InReadyUp()) return Plugin_Continue;
	// l4dready goes live one second after the last ready with no countdown,
	// so this has to act on the cached value now rather than wait on a fresh
	// query. The cache is at most READY_POLL_SECONDS old during ready-up.
	RequestFrame(Frame_Gate, GetClientUserId(client));
	return Plugin_Continue;
}

public void Frame_Gate(int uid)
{
	int client = GetClientOfUserId(uid);
	if (client) Gate(client);
}

/** Take the ready back from a Low player on a team, and say why. Silent for
 *  one who is not ready, so ordinary chat during ready-up draws no reminder. */
void Gate(int client)
{
	if (!g_cvGate.BoolValue || !InReadyUp() || !IsLow(client)) return;
	if (!IsHumanPlayer(client) || GetClientTeam(client) <= TEAM_SPECTATOR) return;
	if (!IsReady(client)) return;

	FakeClientCommand(client, "sm_unready");

	float now = GetGameTime();
	if (g_fLastNag[client] == 0.0 || now - g_fLastNag[client] >= NAG_SECONDS)
	{
		g_fLastNag[client] = now;
		PrintHintText(client, "You can't ready up with Effect Detail on Low.\nOptions > Video > Advanced > Effect Detail: Medium or High");
		PrintToChat(client, "\x04[PUG]\x01 Effect Detail is on \x04Low\x01, which lets you see through smoke. Set Options > Video > Advanced > Effect Detail to Medium or High, then ready up.");
	}
	if (!g_bAnnounced[client])
	{
		g_bAnnounced[client] = true;
		PrintToChatAll("\x04[PUG]\x01 %N can't ready up until their Effect Detail is Medium or High.", client);
	}
}

/**
 * `L4DV` must be the first thing after the engine's timestamp, like L4DL: the
 * same stream carries chat, so an unanchored marker could be typed by a
 * player. The value is the client's own string, but the backend accepts only
 * a plain number, so nothing free-text reaches it.
 */
void Report(int client, const char[] cvar, const char[] value)
{
	char id[32];
	if (!GetClientAuthId(client, AuthId_SteamID64, id, sizeof(id))) {
		if (!GetClientAuthId(client, AuthId_Steam2, id, sizeof(id))) return;
	}
	PugLog("L4DV id=%s cvar=%s value=%s", id, cvar, value);
}
