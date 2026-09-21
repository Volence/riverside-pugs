/**
 * l4d_skypounce: stops hunters chaining pounces off the map's sky brush.
 *
 * "Ceiling pouncing": a hunter pounces up into the sky brush that caps the
 * map and pounces again off it, over and over, crossing the level above
 * everything. The sky counts as a surface to re-pounce from, exactly as a
 * wall does.
 *
 * TWO RULES, chosen by l4d_skypounce_mode.
 *
 * Mode 1, the default since 0.4.0, is ZEN'S rule, copied from the
 * AntiCeilingPounce module inside their _zenserver.smx (read out of the
 * compiled plugin, identical in their 2023 and 2026 packs). It looks at no
 * surface at all. When a human hunter BEGINS a pounce while its view pitch is
 * strictly between 10 and 14 degrees (looking slightly down: the flat,
 * skimming angle a ceiling run is done at), that hunter cannot attack again in
 * the air for half a second. Landing, dying or the half second ends it. The
 * owner chose it on 2026-09-21 because it is the rule the community already
 * plays under on Zen and knows the feel of.
 *
 * Mode 2 is the surface rule built and tested here first:
 * the plugin tracks the LAST SURFACE an airborne hunter
 * touched. A pounce that begins in the air while that surface is sky is a
 * pounce off the sky. A hunter gets l4d_skypounce_allow of those per flight
 * (default 1); after that, attack is dropped for as long as sky is still the
 * last thing it touched. Touch a wall, a prop or the ground and the hunter is
 * an ordinary hunter again.
 *
 * So merely brushing the sky during a legitimate pounce costs nothing: a wall
 * kick afterwards is a wall kick. Only the pounce that actually pushes off the
 * sky is counted. That is the owner's rule from the first live test
 * (2026-09-21, Dallas, No Mercy 3), where the two earlier versions (block
 * from the touch; one pounce of any kind after the touch) both punished a
 * hunter for a graze.
 *
 * Why "last surface touched" and not "touching right now", measured with the
 * bot rig (skypounce/probe): when presses were dropped only during the
 * contact, the game still let the hunter pounce 134 units below the ceiling a
 * moment later. The game's permission outlives the contact, so the memory of
 * the contact has to as well. And m_isLunging is no help: the re-pounce fires
 * while it is still 1.
 *
 * Contact is found with short player-hull sweeps (up, four sides, and along
 * the velocity), world brushes and props, never players. TR_GetSurfaceFlags
 * only means something for world brush faces, which is fine: sky is always
 * world. Both sky bits are checked, because a map built with the 2D skybox
 * texture sets only SURF_SKY2D. SURF_NODRAW is deliberately NOT treated as
 * sky: it also covers clip brushes and hidden faces, and blocking on it would
 * break ordinary bounces off railings, ramps and invisible player clips.
 * Where a wall meets the sky and both are touched in one tick, sky wins.
 *
 * Sky means the CEILING: a sky face whose normal points down. Vertical sky
 * faces are the invisible walls at the map's edge and count as walls.
 */
#include <sourcemod>
#include <sdktools>

#pragma semicolon 1
#pragma newdecls required

#define PLUGIN_VERSION "0.4.0"

#define TEAM_INFECTED 3
#define ZC_HUNTER 3

ConVar g_cvEnable, g_cvReach, g_cvDebug, g_cvAllow, g_cvMode, g_cvPitchMin, g_cvPitchMax, g_cvCooldown, g_cvBots;
bool g_enable;
float g_reach;
int g_debug;
int g_allow;
int g_mode;
float g_pitchMin, g_pitchMax, g_cooldown;
bool g_bots;

// Mode 1 (Zen) state.
float g_pitch[MAXPLAYERS + 1];        // view pitch from the hunter's latest usercmd
float g_coolUntil[MAXPLAYERS + 1];    // game time the cooldown ends, 0 when none

bool g_latched[MAXPLAYERS + 1];        // sky is the last surface this airborne hunter touched
bool g_flight[MAXPLAYERS + 1];         // in the air with something to report when it lands
int g_stripped[MAXPLAYERS + 1];     // presses removed during the current latch
int g_used[MAXPLAYERS + 1];         // pounces off the sky this flight
float g_latchPos[MAXPLAYERS + 1][3];
char g_log[PLATFORM_MAX_PATH];

public Plugin myinfo =
{
	name = "L4D1 sky pounce block",
	author = "Riverside",
	description = "Stops hunters chaining pounces along the sky ceiling",
	version = PLUGIN_VERSION,
	url = "https://riversidepug.com"
};

public void OnPluginStart()
{
	CreateConVar("l4d_skypounce_version", PLUGIN_VERSION, "l4d_skypounce version", FCVAR_NOTIFY | FCVAR_DONTRECORD);
	g_cvEnable = CreateConVar("l4d_skypounce_enable", "1", "Limit hunter pounces off the sky brush. 0 turns the plugin off.", FCVAR_NOTIFY, true, 0.0, true, 1.0);
	// Not "l4d_skypounce_reach": a live reload keeps an existing cvar's value and
	// bounds, and up to 0.2 that name meant a 72 unit look-ahead, min 16.
	g_cvReach = CreateConVar("l4d_skypounce_touch", "8.0", "How far (units) the player hull is swept to decide it is touching a surface.", FCVAR_NOTIFY, true, 2.0, true, 64.0);
	g_cvAllow = CreateConVar("l4d_skypounce_allow", "1", "Pounces off the sky a hunter gets per flight. 0 allows none.", FCVAR_NOTIFY, true, 0.0, true, 10.0);
	g_cvMode = CreateConVar("l4d_skypounce_mode", "1", "1: Zen's rule, a pounce begun at the ceiling-skimming view pitch buys a short no-attack cooldown in the air. 2: surface rule, only a pounce that pushes off the sky ceiling is limited.", FCVAR_NOTIFY, true, 1.0, true, 2.0);
	g_cvPitchMin = CreateConVar("l4d_skypounce_pitch_min", "10.0", "Mode 1: the pounce must begin with view pitch above this (degrees, positive is down). Zen uses 10.", FCVAR_NOTIFY, true, -90.0, true, 90.0);
	g_cvPitchMax = CreateConVar("l4d_skypounce_pitch_max", "14.0", "Mode 1: and below this. Zen uses 14.", FCVAR_NOTIFY, true, -90.0, true, 90.0);
	g_cvCooldown = CreateConVar("l4d_skypounce_cooldown", "0.5", "Mode 1: seconds without attack in the air after such a pounce. Zen uses 0.5.", FCVAR_NOTIFY, true, 0.0, true, 5.0);
	g_cvBots = CreateConVar("l4d_skypounce_bots", "0", "Apply to AI hunters too. Zen does not; the test rig needs it.", 0, true, 0.0, true, 1.0);
	g_cvDebug = CreateConVar("l4d_skypounce_debug", "0", "1: tell the player in chat when a sky pounce is counted or blocked. For testing, not for matches.", 0, true, 0.0, true, 1.0);
	g_cvEnable.AddChangeHook(OnCvarChanged);
	g_cvReach.AddChangeHook(OnCvarChanged);
	g_cvDebug.AddChangeHook(OnCvarChanged);
	g_cvAllow.AddChangeHook(OnCvarChanged);
	g_cvMode.AddChangeHook(OnCvarChanged);
	g_cvPitchMin.AddChangeHook(OnCvarChanged);
	g_cvPitchMax.AddChangeHook(OnCvarChanged);
	g_cvCooldown.AddChangeHook(OnCvarChanged);
	g_cvBots.AddChangeHook(OnCvarChanged);
	ReadCvars();

	BuildPath(Path_SM, g_log, sizeof g_log, "logs/skypounce.log");
	HookEvent("player_spawn", Event_Reset);
	HookEvent("player_death", Event_Reset);
	HookEvent("ability_use", Event_AbilityUse);
}

void OnCvarChanged(ConVar convar, const char[] oldValue, const char[] newValue)
{
	ReadCvars();
}

void ReadCvars()
{
	g_enable = g_cvEnable.BoolValue;
	g_reach = g_cvReach.FloatValue;
	g_debug = g_cvDebug.IntValue;
	g_allow = g_cvAllow.IntValue;
	g_mode = g_cvMode.IntValue;
	g_pitchMin = g_cvPitchMin.FloatValue;
	g_pitchMax = g_cvPitchMax.FloatValue;
	g_cooldown = g_cvCooldown.FloatValue;
	g_bots = g_cvBots.BoolValue;
	if (!g_enable)
	{
		for (int i = 1; i <= MaxClients; i++) { g_latched[i] = false; g_flight[i] = false; }
	}
}

public void OnClientDisconnect(int client)
{
	g_latched[client] = false;
	g_flight[client] = false;
	g_stripped[client] = 0;
	g_used[client] = 0;
	g_coolUntil[client] = 0.0;
	g_pitch[client] = 0.0;
}

void Event_Reset(Event event, const char[] name, bool dontBroadcast)
{
	int client = GetClientOfUserId(event.GetInt("userid"));
	if (client > 0) Release(client);
}

/** A pounce that begins in the air while sky is the last surface touched is a
 *  pounce off the sky. The first pounce, off the ground, never qualifies. */
void Event_AbilityUse(Event event, const char[] name, bool dontBroadcast)
{
	int client = GetClientOfUserId(event.GetInt("userid"));
	if (client == 0 || !g_enable) return;
	char ability[32];
	event.GetString("ability", ability, sizeof ability);
	if (!StrEqual(ability, "ability_lunge")) return;

	if (g_mode == 1)
	{
		// Zen: every pounce counts, the first one off the ground included, and
		// the only question is the pitch it was launched at.
		if (IsFakeClient(client) && !g_bots) return;
		if (g_pitch[client] > g_pitchMin && g_pitch[client] < g_pitchMax)
		{
			g_coolUntil[client] = GetGameTime() + g_cooldown;
			g_stripped[client] = 0;
			GetClientAbsOrigin(client, g_latchPos[client]);
			if (g_debug) PrintToChat(client, "[skypounce] pounce at pitch %.1f: no attack in the air for %.1f s", g_pitch[client], g_cooldown);
		}
		return;
	}

	if (!g_latched[client]) return;
	g_used[client]++;
	// It has left the sky now. If it comes back to it, the latch comes back too.
	g_latched[client] = false;
	if (g_debug) PrintToChat(client, "[skypounce] pounce off the sky, %d of %d this flight", g_used[client], g_allow);
}

/** Back on a surface that is not sky: the flight is over. One log line, and
 *  only when something was actually stopped. */
void EndCooldown(int client)
{
	if (g_coolUntil[client] == 0.0) return;
	g_coolUntil[client] = 0.0;
	if (g_stripped[client] > 0 && IsClientInGame(client))
	{
		char auth[32], map[64];
		if (!GetClientAuthId(client, AuthId_Steam2, auth, sizeof auth)) strcopy(auth, sizeof auth, "unknown");
		GetCurrentMap(map, sizeof map);
		LogToFile(g_log, "blocked \"%N\" <%s> on %s at %.0f %.0f %.0f: %d attack presses removed in the air after a pounce at the skim pitch",
			client, auth, map, g_latchPos[client][0], g_latchPos[client][1], g_latchPos[client][2], g_stripped[client]);
	}
	g_stripped[client] = 0;
}

void Release(int client)
{
	EndCooldown(client);
	g_latched[client] = false;
	if (!g_flight[client]) return;
	g_flight[client] = false;
	if (g_stripped[client] > 0 && IsClientInGame(client))
	{
		char auth[32], map[64];
		if (!GetClientAuthId(client, AuthId_Steam2, auth, sizeof auth)) strcopy(auth, sizeof auth, "unknown");
		GetCurrentMap(map, sizeof map);
		LogToFile(g_log, "blocked \"%N\" <%s> on %s at %.0f %.0f %.0f: %d attack presses removed against the sky, after %d allowed pounce(s) off it",
			client, auth, map, g_latchPos[client][0], g_latchPos[client][1], g_latchPos[client][2], g_stripped[client], g_used[client]);
	}
	g_stripped[client] = 0;
	g_used[client] = 0;
}

int g_sweeper;

public bool Filter_NotPlayers(int entity, int mask)
{
	// World and props, never players: a hunter brushing a survivor or another
	// infected has not touched a surface.
	return entity != g_sweeper && (entity == 0 || entity > MaxClients);
}

#define TOUCH_NONE 0
#define TOUCH_OTHER 1
#define TOUCH_SKY 2

int SweepOnce(const float from[3], const float to[3], const float mins[3], const float maxs[3])
{
	Handle tr = TR_TraceHullFilterEx(from, to, mins, maxs, MASK_PLAYERSOLID, Filter_NotPlayers);
	int result = TOUCH_NONE;
	if (TR_DidHit(tr))
	{
		bool world = TR_GetEntityIndex(tr) == 0;
		bool sky = world && (TR_GetSurfaceFlags(tr) & (SURF_SKY | SURF_SKY2D)) != 0;
		// Only a sky face that looks DOWN is the ceiling. The same texture also
		// stands as the invisible walls round the edge of a map, and kicking off
		// one of those is an ordinary wall kick (first live test, No Mercy 3:
		// 0.3.1 stopped a wall kick off a sky wall after one). 0.7 is about 45
		// degrees, so a sloped sky roof still counts and a wall never does.
		if (sky)
		{
			float normal[3];
			TR_GetPlaneNormal(tr, normal);
			if (normal[2] > -0.7) sky = false;
		}
		result = sky ? TOUCH_SKY : TOUCH_OTHER;
	}
	delete tr;
	return result;
}

/** What the hunter's hull is against this tick: sky, something else, or
 *  nothing. Up, the four sides, and along the velocity far enough to cover the
 *  next two ticks, so a fast approach is seen before the bounce. */
int Touching(int client)
{
	float origin[3], mins[3], maxs[3], vel[3], to[3];
	GetClientAbsOrigin(client, origin);
	GetClientMins(client, mins);
	GetClientMaxs(client, maxs);
	g_sweeper = client;

	int best = TOUCH_NONE;
	float dirs[5][3] = { { 0.0, 0.0, 1.0 }, { 1.0, 0.0, 0.0 }, { -1.0, 0.0, 0.0 }, { 0.0, 1.0, 0.0 }, { 0.0, -1.0, 0.0 } };
	for (int d = 0; d < 5; d++)
	{
		to[0] = origin[0] + dirs[d][0] * g_reach;
		to[1] = origin[1] + dirs[d][1] * g_reach;
		to[2] = origin[2] + dirs[d][2] * g_reach;
		int t = SweepOnce(origin, to, mins, maxs);
		if (t > best) best = t;
		if (best == TOUCH_SKY) return best;
	}

	GetEntPropVector(client, Prop_Data, "m_vecVelocity", vel);
	float ahead = GetVectorLength(vel) * GetTickInterval() * 2.0;
	if (ahead > 1.0)
	{
		NormalizeVector(vel, vel);
		to[0] = origin[0] + vel[0] * ahead;
		to[1] = origin[1] + vel[1] * ahead;
		to[2] = origin[2] + vel[2] * ahead;
		int t = SweepOnce(origin, to, mins, maxs);
		if (t > best) best = t;
	}
	return best;
}

public Action OnPlayerRunCmd(int client, int &buttons, int &impulse, float vel[3], float angles[3],
	int &weapon, int &subtype, int &cmdnum, int &tickcount, int &seed, int mouse[2])
{
	if (!g_enable) return Plugin_Continue;
	if (GetClientTeam(client) != TEAM_INFECTED || !IsPlayerAlive(client)) return Plugin_Continue;
	if (GetEntProp(client, Prop_Send, "m_zombieClass") != ZC_HUNTER) return Plugin_Continue;
	// A ghost is not in the world yet and cannot pounce.
	if (GetEntProp(client, Prop_Send, "m_isGhost") != 0) return Plugin_Continue;

	if (g_mode == 1)
	{
		g_pitch[client] = angles[0];
		if (g_coolUntil[client] == 0.0) return Plugin_Continue;
		if ((GetEntityFlags(client) & FL_ONGROUND) || GetGameTime() >= g_coolUntil[client])
		{
			EndCooldown(client);
			return Plugin_Continue;
		}
		if (buttons & IN_ATTACK)
		{
			buttons &= ~IN_ATTACK;
			g_stripped[client]++;
			return Plugin_Changed;
		}
		return Plugin_Continue;
	}

	// Landed, or climbing: the flight is over. A ladder is not FL_ONGROUND, and
	// a hunter on one is plainly not running the ceiling.
	if ((GetEntityFlags(client) & FL_ONGROUND) || GetEntityMoveType(client) == MOVETYPE_LADDER)
	{
		Release(client);
		return Plugin_Continue;
	}

	int touch = Touching(client);
	if (touch == TOUCH_SKY)
	{
		if (!g_latched[client])
		{
			g_latched[client] = true;
			g_flight[client] = true;
			GetClientAbsOrigin(client, g_latchPos[client]);
		}
	}
	else if (touch == TOUCH_OTHER)
	{
		// A wall, a prop, a ledge: whatever it does next, it does off that.
		g_latched[client] = false;
	}

	if (!g_latched[client] || g_used[client] < g_allow) return Plugin_Continue;

	if (buttons & IN_ATTACK)
	{
		buttons &= ~IN_ATTACK;
		if (g_stripped[client] == 0 && g_debug) PrintToChat(client, "[skypounce] blocked: you already pounced off the sky this flight (%d allowed)", g_allow);
		g_stripped[client]++;
		return Plugin_Changed;
	}
	return Plugin_Continue;
}
