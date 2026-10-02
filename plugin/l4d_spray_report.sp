/**
 * l4d_spray_report - put crash spray attempts on the PUG wire.
 *
 * spray_exploit_fixer (Silvers, our fork 2.28-riverside1) checks every uploaded
 * spray's VTF header and blocks a malformed one before anybody else can see
 * it: the file is never sent on and the decal goes back to the sprayer only.
 * It writes its own logs/spray_downloads.log on each box, which the site
 * cannot read. It also fires the OnSprayExploit forward, so this bridges that
 * onto the logaddress stream the site already listens to, in the same shape
 * as the LilAC reporter. The site stores the attempt on the player's file and
 * tells staff, because a blocked crash spray is still somebody trying.
 *
 * Reporting only. Blocking and kicking are the fixer's own cvars.
 *
 * Line: `L4DS id=<steamid> crc=<8 hex> off=<n> val=<n>`. `crc` is the spray's
 * file name, `off` the header byte that failed (-2: the size did not match
 * the header) and `val` the byte found there (-2 again for a size mismatch).
 * `L4DS` must be the first thing after the timestamp: the game relays chat on
 * this same stream, so an unanchored marker could be typed by a player. There
 * is no free text on the line, only a steamid, a hex name and two numbers.
 *
 * Build: ./build-sprayreport.sh (pug-logauth.inc and pug-hmac.inc beside it).
 */
#pragma semicolon 1
#pragma newdecls required
#include <sourcemod>
#include <sdktools>
#include "pug-logauth.inc"

#define PLUGIN_VERSION "0.1.0"

ConVar g_cvEnabled;

public Plugin myinfo =
{
	name = "L4D Spray Report",
	author = "Riverside",
	description = "Reports crash spray attempts caught by spray_exploit_fixer to the PUG site",
	version = PLUGIN_VERSION,
	url = ""
};

public void OnPluginStart()
{
	PugLogAuth_Init();
	g_cvEnabled = CreateConVar("l4d_spray_report_enabled", "1",
		"1 = report crash spray attempts on the log stream.", FCVAR_NONE, true, 0.0, true, 1.0);
}

/**
 * From spray_exploit_fixer, once per check that failed. `client` is 0 when the
 * fixer could not tell whose file it was; that file is still blocked, there is
 * just nobody to name. `index` is the failing header byte, or -2 for a size
 * mismatch, and `value` the byte read there (or -2).
 */
public void OnSprayExploit(int client, int index, int value)
{
	if (!g_cvEnabled.BoolValue) return;
	if (client <= 0 || client > MaxClients || !IsClientConnected(client) || IsFakeClient(client)) return;

	char id[32];
	if (!GetClientAuthId(client, AuthId_SteamID64, id, sizeof(id))) {
		// Under sv_lan 1 the 64-bit form is unavailable; the site normalises
		// the STEAM_ form too, same as the LilAC line.
		if (!GetClientAuthId(client, AuthId_Steam2, id, sizeof(id), false)) return;
	}

	// The file name is the CRC the client announced. The fixer only names a
	// client whose spray (or jingle) matches the bad file, so for a spray
	// this is that file.
	char crc[16];
	if (!GetPlayerDecalFile(client, crc, sizeof(crc)) || strlen(crc) != 8) {
		if (!GetPlayerJingleFile(client, crc, sizeof(crc)) || strlen(crc) != 8) return;
	}

	if (index < -2 || index > 63) index = -2;
	if (value < -2 || value > 255) value = -2;
	PugLog("L4DS id=%s crc=%s off=%d val=%d", id, crc, index, value);
}
