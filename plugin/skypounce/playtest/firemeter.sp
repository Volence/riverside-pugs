/**
 * firemeter: tells a player in chat how fast they are really firing, measured
 * from weapon_fire over the last ten shots. Playtest helper, NEVER for a live
 * server. Used to see whether l4d_pistol_delay_dualies actually caps dual
 * pistols: bind the mouse wheel to +attack, spin it, and read the peak.
 */
#include <sourcemod>
#include <sdktools>

#pragma semicolon 1
#pragma newdecls required

#define WINDOW 10

float g_times[MAXPLAYERS + 1][WINDOW];
int g_count[MAXPLAYERS + 1];
float g_peak[MAXPLAYERS + 1];
float g_lastSaid[MAXPLAYERS + 1];

// Server-driven trigger finger, so nobody needs a bind or a macro of their own.
bool g_auto[MAXPLAYERS + 1];
int g_autoCmds[MAXPLAYERS + 1];
int g_autoShots[MAXPLAYERS + 1];
float g_autoFirst[MAXPLAYERS + 1], g_autoLast[MAXPLAYERS + 1];

public Plugin myinfo = { name = "firemeter (playtest)", author = "Riverside", description = "reports real shots per second", version = "0", url = "" };

public void OnPluginStart()
{
	HookEvent("weapon_fire", Event_WeaponFire);
	RegConsoleCmd("sm_peak", Cmd_Peak, "Show and reset your peak fire rate");
	RegConsoleCmd("sm_autofire", Cmd_AutoFire, "Fire every human survivor's weapon as fast as the server allows for 4 seconds and report the rate");
	RegConsoleCmd("sm_pistols", Cmd_Pistols, "Give dual pistols to every human survivor (or to you)");
}

public void OnClientPutInServer(int client)
{
	g_count[client] = 0;
	g_peak[client] = 0.0;
	g_auto[client] = false;
}

/** Presses attack FOR the player, on every other usercmd (50 presses a second
 *  at cmdrate 100, far past any macro), for four seconds. Whatever rate comes
 *  out is the server's real cap. */
Action Cmd_AutoFire(int client, int args)
{
	int n = 0;
	for (int i = 1; i <= MaxClients; i++)
	{
		if (!IsClientInGame(i) || IsFakeClient(i) || GetClientTeam(i) != 2 || !IsPlayerAlive(i)) continue;
		int w = GetPlayerWeaponSlot(i, 1);
		if (w > 0 && IsValidEntity(w)) SetEntProp(w, Prop_Send, "m_iClip1", 30);
		FakeClientCommand(i, "use weapon_pistol");
		g_auto[i] = true;
		g_autoCmds[i] = 0;
		g_autoShots[i] = 0;
		PrintToChat(i, "[firemeter] firing for you for 4 seconds, hands off");
		CreateTimer(4.0, Timer_AutoDone, GetClientUserId(i));
		n++;
	}
	ReplyToCommand(client, "[firemeter] autofire started for %d human survivor(s)", n);
	return Plugin_Handled;
}

Action Timer_AutoDone(Handle timer, int userid)
{
	int i = GetClientOfUserId(userid);
	if (i == 0) return Plugin_Stop;
	g_auto[i] = false;
	char msg[192];
	if (g_autoShots[i] >= 2)
	{
		float rate = float(g_autoShots[i] - 1) / (g_autoLast[i] - g_autoFirst[i]);
		Format(msg, sizeof msg, "AUTOFIRE %N: %d shots, %.2f per second (%.0f ms apart), %d usercmds in 4 s", i, g_autoShots[i], rate, 1000.0 / rate, g_autoCmds[i]);
	}
	else Format(msg, sizeof msg, "AUTOFIRE %N: only %d shots (holding a pistol? alive?), %d usercmds", i, g_autoShots[i], g_autoCmds[i]);
	PrintToChat(i, "[firemeter] %s", msg);
	PrintToServer("[firemeter] %s", msg);
	// The console pipe is buffered; a file is what the tester can actually read.
	char path[PLATFORM_MAX_PATH];
	BuildPath(Path_SM, path, sizeof path, "logs/firemeter.log");
	ConVar cv = FindConVar("l4d_pistol_delay_dualies");
	LogToFile(path, "dualies=%.3f  %s", cv == null ? -1.0 : cv.FloatValue, msg);
	return Plugin_Stop;
}

public Action OnPlayerRunCmd(int client, int &buttons, int &impulse, float vel[3], float angles[3],
	int &weapon, int &subtype, int &cmdnum, int &tickcount, int &seed, int mouse[2])
{
	if (!g_auto[client]) return Plugin_Continue;
	g_autoCmds[client]++;
	if (g_autoCmds[client] % 2 == 0) buttons |= IN_ATTACK;
	else buttons &= ~IN_ATTACK;
	return Plugin_Changed;
}

/** Dual pistols for every human survivor. Callable from the server console,
 *  which is how it gets used over rcon. Needs sv_cheats 1, as the playtest has. */
Action Cmd_Pistols(int client, int args)
{
	int given = 0;
	for (int i = 1; i <= MaxClients; i++)
	{
		if (!IsClientInGame(i) || IsFakeClient(i) || GetClientTeam(i) != 2 || !IsPlayerAlive(i)) continue;
		FakeClientCommand(i, "give pistol");
		FakeClientCommand(i, "give pistol");
		PrintToChat(i, "[firemeter] dual pistols given");
		given++;
	}
	ReplyToCommand(client, "[firemeter] gave dual pistols to %d human survivor(s)", given);
	return Plugin_Handled;
}

Action Cmd_Peak(int client, int args)
{
	if (client == 0) return Plugin_Handled;
	ReplyToCommand(client, "[firemeter] peak %.1f shots per second. Reset.", g_peak[client]);
	g_peak[client] = 0.0;
	g_count[client] = 0;
	return Plugin_Handled;
}

void Event_WeaponFire(Event event, const char[] name, bool dontBroadcast)
{
	int client = GetClientOfUserId(event.GetInt("userid"));
	if (client == 0 || IsFakeClient(client)) return;
	float now = GetGameTime();
	if (g_auto[client])
	{
		g_autoShots[client]++;
		if (g_autoShots[client] == 1) g_autoFirst[client] = now;
		g_autoLast[client] = now;
	}
	int n = g_count[client];
	// A pause ends the burst: the rate is only meaningful within one.
	if (n > 0 && now - g_times[client][(n - 1) % WINDOW] > 0.5) n = 0;
	g_times[client][n % WINDOW] = now;
	n++;
	g_count[client] = n;
	if (n < WINDOW) return;
	float oldest = g_times[client][n % WINDOW];
	float rate = float(WINDOW - 1) / (now - oldest);
	if (rate > g_peak[client]) g_peak[client] = rate;
	if (now - g_lastSaid[client] > 1.0)
	{
		g_lastSaid[client] = now;
		char weapon[32];
		event.GetString("weapon", weapon, sizeof weapon);
		PrintToChat(client, "[firemeter] %s: %.1f shots per second now, peak %.1f (say !peak to reset)", weapon, rate, g_peak[client]);
	}
}
