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
 * Reporting only: it never kicks and never changes a client setting. Once per
 * connection per setting, so a player sitting on cpu_level 0 all night is one
 * line, not one every poll.
 *
 * Build: ./spcomp l4d_cvarwatch.sp with pug-logauth.inc and pug-hmac.inc beside it.
 */
#pragma semicolon 1
#pragma newdecls required
#include <sourcemod>
#include "pug-logauth.inc"

#define PLUGIN_VERSION "0.1.0"
#define POLL_SECONDS 15.0

ConVar g_cvEnabled;
/** Whether this connection has already been reported for cpu_level. */
bool g_bReported[MAXPLAYERS + 1];
/** userid the flag above belongs to, so a reused slot starts clean. */
int g_iUserId[MAXPLAYERS + 1];

public Plugin myinfo = {
	name = "L4D1 Cvar Watch",
	author = "Riverside",
	description = "Reports client settings that matter for fairness to the PUG site. Never acts on a player.",
	version = PLUGIN_VERSION,
	url = "https://riversidepug.com",
};

public void OnPluginStart()
{
	CreateConVar("l4d_cvarwatch_version", PLUGIN_VERSION, "Cvar watch version",
		FCVAR_NOTIFY | FCVAR_DONTRECORD);
	g_cvEnabled = CreateConVar("l4d_cvarwatch_enabled", "1",
		"Report client cpu_level below 1 to the site.", FCVAR_NOTIFY, true, 0.0, true, 1.0);
	PugLogAuth_Init();
	CreateTimer(POLL_SECONDS, Timer_Poll, _, TIMER_REPEAT);
}

public void OnClientDisconnect(int client)
{
	g_bReported[client] = false;
	g_iUserId[client] = 0;
}

public Action Timer_Poll(Handle timer)
{
	if (!g_cvEnabled.BoolValue) return Plugin_Continue;
	for (int c = 1; c <= MaxClients; c++)
	{
		if (!IsClientInGame(c) || IsFakeClient(c) || IsClientSourceTV(c)) continue;
		int uid = GetClientUserId(c);
		if (g_iUserId[c] != uid) { g_iUserId[c] = uid; g_bReported[c] = false; }
		if (g_bReported[c]) continue;
		QueryClientConVar(c, "cpu_level", OnCpuLevel, uid);
	}
	return Plugin_Continue;
}

public void OnCpuLevel(QueryCookie cookie, int client, ConVarQueryResult result,
	const char[] name, const char[] value, any uid)
{
	if (result != ConVarQuery_Okay) return;
	if (!IsClientInGame(client) || GetClientUserId(client) != uid) return;
	if (g_bReported[client]) return;
	if (StringToFloat(value) >= 1.0) return;
	Report(client, "cpu_level", value);
	g_bReported[client] = true;
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
