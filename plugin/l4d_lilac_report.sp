/**
 * l4d_lilac_report - put Little Anti-Cheat's detections on the PUG wire.
 *
 * LilAC writes its own addons/sourcemod/logs/lilac.log, which is no use to a
 * web app on another machine, and hopeless for Chicago which we reach only over
 * FTP. It does expose forwards, so this bridges them onto the logaddress stream
 * the site already listens to, in the same shape as the consistency drop line.
 *
 * Reporting only: it never bans, never kicks, and deliberately does NOT hook
 * lilac_allow_cheat_detection, which can veto a detection. Whether LilAC acts
 * is LilAC's own lilac_ban setting, and vetoing categories from here would hide
 * the very thing we are trying to collect evidence about.
 *
 * Build:
 *   ./spcomp l4d_lilac_report.sp -i <dir containing lilac.inc>
 *   with pug-logauth.inc and pug-hmac.inc beside it.
 */
#pragma semicolon 1
#pragma newdecls required
#include <sourcemod>
#include <lilac>
#include "pug-logauth.inc"

#define PLUGIN_VERSION "0.1.1"

ConVar g_cvEnabled;

public Plugin myinfo = {
	name = "L4D1 LilAC Reporter",
	author = "Riverside",
	description = "Reports Little Anti-Cheat detections to the PUG site. Never acts on a player.",
	version = PLUGIN_VERSION,
	url = "https://riversidepug.com",
};

public void OnPluginStart()
{
	CreateConVar("l4d_lilac_report_version", PLUGIN_VERSION, "LilAC reporter version",
		FCVAR_NOTIFY | FCVAR_DONTRECORD);
	g_cvEnabled = CreateConVar("l4d_lilac_report_enabled", "1",
		"Report Little Anti-Cheat detections to the site.", FCVAR_NOTIFY, true, 0.0, true, 1.0);
	PugLogAuth_Init();
}

public void lilac_cheater_detected(int client, int cheat)
{
	Report(client, cheat, false);
}

public void lilac_cheater_banned(int client, int cheat)
{
	Report(client, cheat, true);
}

/**
 * `L4DL` must be the first thing after the engine's timestamp. The game server
 * relays every chat line on this same stream, so an unanchored marker could be
 * forged by a player typing it. There is no name field: the only identity on
 * the line is a steamid, so a crafted name has nothing to impersonate.
 */
void Report(int client, int cheat, bool banned)
{
	if (!g_cvEnabled.BoolValue) return;
	if (client <= 0 || client > MaxClients || !IsClientConnected(client)) return;
	if (IsFakeClient(client)) return;

	char id[32];
	if (!GetClientAuthId(client, AuthId_SteamID64, id, sizeof(id))) {
		// Under sv_lan 1 the 64-bit form is unavailable; the web normalises the
		// STEAM_ form too, same as the consistency drop line.
		if (!GetClientAuthId(client, AuthId_Steam2, id, sizeof(id))) return;
	}
	PugLog("L4DL id=%s cheat=%d banned=%d", id, cheat, banned ? 1 : 0);
}
