/**
 * pistolrig: measures how fast dual pistols really fire on this server, with
 * Rotoblin's l4d2_pistol_delay at several settings and with it unloaded.
 * NEVER for a live server. A survivor bot's buttons are overridden so it
 * presses attack on every other tick (50 presses a second, far past any
 * macro), and weapon_fire events are timed. Results: logs/pistolrig.log.
 */
#include <sourcemod>
#include <sdktools>

#pragma semicolon 1
#pragma newdecls required

#define TEAM_SURVIVOR 2
#define SHOTS_WANTED 25

char g_log[PLATFORM_MAX_PATH];
int g_frames;
int g_bot;
int g_phase = -1;          // index into the plan, -1 before the start
float g_phaseSince;
bool g_firing;
int g_shots;
float g_firstShot, g_lastShot;

// delay to set, or a marker: -1 leave the cvar as found, -2 unload the plugin first
float g_plan[] = { -1.0, 0.075, 0.1, 0.125, 0.2, -2.0 };

public Plugin myinfo = { name = "pistolrig (test rig)", author = "Riverside", description = "dual pistol fire rate rig", version = "0", url = "" };

public void OnPluginStart()
{
	BuildPath(Path_SM, g_log, sizeof g_log, "logs/pistolrig.log");
	HookEvent("weapon_fire", Event_WeaponFire);
	CreateTimer(0.2, Timer_Tick, _, TIMER_REPEAT);
}

void Say(const char[] fmt, any ...)
{
	char buf[512];
	VFormat(buf, sizeof buf, fmt, 2);
	LogToFile(g_log, "%s", buf);
}

public void OnMapStart()
{
	g_phase = -1;
	g_bot = 0;
	g_firing = false;
	g_phaseSince = GetGameTime();
}

public void OnGameFrame()
{
	g_frames++;
	// An empty L4D1 server freezes game time until somebody joins.
	if (g_phase == -1 && (g_frames % 300) == 0 && GetClientCount(false) == 0)
	{
		int fake = CreateFakeClient("pistolrig_anchor");
		if (fake > 0) ChangeClientTeam(fake, TEAM_SURVIVOR);
	}
}

int FindBot()
{
	for (int i = 1; i <= MaxClients; i++)
	{
		if (!IsClientInGame(i) || !IsFakeClient(i) || GetClientTeam(i) != TEAM_SURVIVOR || !IsPlayerAlive(i)) continue;
		char name[64];
		GetClientName(i, name, sizeof name);
		if (StrContains(name, "anchor") == -1) return i;
	}
	return 0;
}

int PistolOf(int client)
{
	int w = GetPlayerWeaponSlot(client, 1);
	return (w > 0 && IsValidEntity(w)) ? w : -1;
}

void StartPhase()
{
	float want = g_plan[g_phase];
	ConVar cv = FindConVar("l4d_pistol_delay_dualies");
	if (want == -2.0)
	{
		ServerCommand("sm plugins unload l4d2_pistol_delay");
		ServerExecute();
	}
	else if (want >= 0.0 && cv != null) cv.SetFloat(want);

	int w = PistolOf(g_bot);
	if (w != -1) SetEntProp(w, Prop_Send, "m_iClip1", 30);
	g_shots = 0;
	g_firing = true;
	g_phaseSince = GetGameTime();
}

void EndPhase()
{
	g_firing = false;
	float want = g_plan[g_phase];
	ConVar cv = FindConVar("l4d_pistol_delay_dualies");
	char label[64];
	if (want == -2.0) strcopy(label, sizeof label, "plugin UNLOADED (stock game)");
	else if (cv == null) strcopy(label, sizeof label, "cvar NOT FOUND (plugin not running)");
	else Format(label, sizeof label, "l4d_pistol_delay_dualies=%.3f%s", cv.FloatValue, want == -1.0 ? " (as found)" : "");

	int w = PistolOf(g_bot);
	int dual = (w != -1 && HasEntProp(w, Prop_Send, "m_hasDualWeapons")) ? GetEntProp(w, Prop_Send, "m_hasDualWeapons") : -1;
	if (g_shots >= 2)
	{
		float rate = float(g_shots - 1) / (g_lastShot - g_firstShot);
		Say("RESULT %s: %d shots, %.2f per second (%.0f ms apart), dual=%d", label, g_shots, rate, 1000.0 / rate, dual);
	}
	else Say("RESULT %s: only %d shots fired, dual=%d", label, g_shots, dual);
}

public Action Timer_Tick(Handle timer)
{
	float held = GetGameTime() - g_phaseSince;
	if (g_phase == -1)
	{
		if (held < 20.0) return Plugin_Continue;
		g_bot = FindBot();
		if (g_bot == 0)
		{
			// The game does not always refill the survivor team with AI bots
			// once the anchor has joined, so ask for one.
			ServerCommand("sv_cheats 1; sb_add");
			if (held > 90.0) { Say("GIVING UP: no survivor bot"); ServerCommand("quit"); }
			return Plugin_Continue;
		}
		ServerCommand("sv_cheats 1; sb_stop 1; god 1; director_stop; director_no_specials 1; z_common_limit 0; nb_delete_all");
		ServerExecute();
		SetConVarInt(FindConVar("sv_cheats"), 1);
		FakeClientCommand(g_bot, "give pistol");
		FakeClientCommand(g_bot, "give pistol");
		FakeClientCommand(g_bot, "use weapon_pistol");
		Say("bot %N, pistol delay plugin cvar %s", g_bot, FindConVar("l4d_pistol_delay_dualies") == null ? "NOT FOUND" : "found");
		g_phase = 0;
		g_phaseSince = GetGameTime();
		CreateTimer(2.0, Timer_Begin);
		return Plugin_Continue;
	}
	if (g_firing && (g_shots >= SHOTS_WANTED || held > 8.0))
	{
		EndPhase();
		g_phase++;
		if (g_phase >= sizeof g_plan) { Say("done"); CreateTimer(1.0, Timer_Quit); return Plugin_Stop; }
		CreateTimer(1.5, Timer_Begin);
	}
	return Plugin_Continue;
}

public Action Timer_Begin(Handle timer)
{
	if (g_bot > 0 && IsClientInGame(g_bot)) StartPhase();
	return Plugin_Stop;
}

public Action Timer_Quit(Handle timer)
{
	ServerCommand("quit");
	return Plugin_Stop;
}

public void Event_WeaponFire(Event event, const char[] name, bool dontBroadcast)
{
	if (!g_firing || GetClientOfUserId(event.GetInt("userid")) != g_bot) return;
	g_shots++;
	if (g_shots == 1) g_firstShot = GetGameTime();
	g_lastShot = GetGameTime();
}

public Action OnPlayerRunCmd(int client, int &buttons, int &impulse, float vel[3], float angles[3],
	int &weapon, int &subtype, int &cmdnum, int &tickcount, int &seed, int mouse[2])
{
	if (client != g_bot || g_phase < 0) return Plugin_Continue;
	vel[0] = 0.0; vel[1] = 0.0; vel[2] = 0.0;
	buttons = 0;
	if (g_firing && (g_frames % 2) == 0) buttons |= IN_ATTACK;
	int w = PistolOf(client);
	if (w != -1) weapon = w;
	return Plugin_Changed;
}
