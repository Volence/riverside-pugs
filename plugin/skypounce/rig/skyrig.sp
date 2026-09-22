/**
 * skyrig: bot-driven test rig for l4d_skypounce. NEVER for a live server.
 *
 * Nobody here can ceiling pounce by hand, so a bot does it. The rig spawns an
 * AI hunter, overrides its buttons every tick, makes it pounce, moves it
 * mid-lunge to just under a sky face (or next to a plain wall, the control),
 * spams attack, and counts the lunges that begin in the air.
 *
 * It contains NO blocking logic. The plugin under test does that, and the rig
 * only flips l4d_skypounce_enable between cells:
 *   sky off, sky on, wall off, wall on.
 * Expected: sky off > 0, sky on = 0, wall off > 0, wall on > 0.
 *
 * The rig loads l4d_skypounce itself, AFTER its own start, from
 * plugins/disabled/. OnPlayerRunCmd forwards run in load order and the rig
 * REPLACES the bot's buttons, so the plugin under test has to see the input
 * after the rig wrote it, the way it would see a human's.
 *
 * An empty L4D1 server freezes game time until somebody joins, hence the fake
 * client. Results: addons/sourcemod/logs/skyrig.log. The server quits itself.
 */
#include <sourcemod>
#include <sdktools>

#pragma semicolon 1
#pragma newdecls required

#define TEAM_SURVIVOR 2
#define TEAM_INFECTED 3
#define ZC_HUNTER 3

#define MODE_SKY 0
#define MODE_WALL 1

#define TRIALS_PER_CELL 3
#define MEASURE_SECONDS 6.0

enum
{
	S_WAIT = 0,
	S_SPAWN,
	S_CROUCH,
	S_LAUNCH,
	S_MEASURE,
	S_DONE
};

char g_log[PLATFORM_MAX_PATH];
int g_state = S_WAIT;
float g_stateSince;
int g_frames;

int g_hunter;          // client index of the hunter under test, 0 for none
int g_trial;           // 0 .. 4 * TRIALS_PER_CELL - 1
int g_mode;
bool g_fix;

bool g_haveSky, g_haveWall;
float g_ground[3];     // where the hunter is put to start its first pounce
float g_skyPos[3], g_skyYaw;
float g_wallPos[3], g_wallNormal[3];
char g_skySurf[64], g_wallSurf[64];
int g_skyFlags, g_wallFlags;

// per trial
int g_lunges;
float g_startPos[3];
float g_maxZ;
float g_maxDist;
int g_spawnTries;
int g_airLunges;       // lunges that began while airborne: the real re-pounces
int g_placeFrames;     // frames left in which the placement velocity is re-applied
float g_placeVel[3];

public Plugin myinfo =
{
	name = "skyrig (test rig)", author = "Riverside", description = "bot-driven test rig for l4d_skypounce",
	version = "0", url = ""
};

public void OnPluginStart()
{
	BuildPath(Path_SM, g_log, sizeof g_log, "logs/skyrig.log");
	HookEvent("ability_use", Event_AbilityUse);
	CreateTimer(0.2, Timer_Tick, _, TIMER_REPEAT);
	ServerCommand("sm plugins load disabled/l4d_skypounce");
	CreateConVar("skyrig_allow", "1", "What the rig sets l4d_skypounce_allow to");
	CreateConVar("skyrig_mode", "1", "What the rig sets l4d_skypounce_mode to");
	CreateConVar("skyrig_pitch", "12.0", "View pitch the bot holds while re-pouncing under the sky");
}

public void OnMapStart()
{
	g_state = S_WAIT;
	g_stateSince = GetGameTime();
	g_trial = 0;
	g_hunter = 0;
	Say("map start");
	// An empty L4D1 server hibernates: no frames, no timers, and any bot is
	// punted. The probe has no human, so hibernation has to be off.
	ConVar hib = FindConVar("sv_hibernate_when_empty");
	if (hib == null) Say("sv_hibernate_when_empty: NOT FOUND");
	else
	{
		Say("sv_hibernate_when_empty was %d flags=0x%x", hib.IntValue, hib.Flags);
		hib.Flags = hib.Flags & ~(FCVAR_CHEAT | FCVAR_DEVELOPMENTONLY | FCVAR_HIDDEN);
		hib.SetInt(0);
		Say("sv_hibernate_when_empty now %d", hib.IntValue);
	}
}

public void OnGameFrame()
{
	g_frames++;
	// With nobody connected the simulation is frozen (game time stays at 1.0
	// and no survivor bots exist); a fake client on the survivor team starts
	// it. Re-created whenever the server is empty again, because with the full
	// plugin set loaded the map restarts once after boot and takes it away.
	if (g_state == S_WAIT && (g_frames % 300) == 0 && GetClientCount(false) == 0)
	{
		int fake = CreateFakeClient("skyrig_anchor");
		Say("anchor bot created: %d", fake);
		if (fake > 0) ChangeClientTeam(fake, TEAM_SURVIVOR);
	}
	if (g_frames == 1 || g_frames == 100 || g_frames % 1000 == 0)
	{
		int inGame = 0, surv = 0;
		for (int i = 1; i <= MaxClients; i++)
		{
			if (!IsClientInGame(i)) continue;
			inGame++;
			if (GetClientTeam(i) == TEAM_SURVIVOR) surv++;
		}
		Say("game frame %d gametime=%.2f enginetime=%.2f clients=%d survivors=%d state=%d",
			g_frames, GetGameTime(), GetEngineTime(), inGame, surv, g_state);
	}
}

void Say(const char[] fmt, any ...)
{
	char buf[512];
	VFormat(buf, sizeof buf, fmt, 2);
	LogToFile(g_log, "%s", buf);
	PrintToServer("[skyrig] %s", buf);
}

void Enter(int state)
{
	g_state = state;
	g_stateSince = GetGameTime();
}

bool IsSky(int flags)
{
	return (flags & (SURF_SKY | SURF_SKY2D)) != 0;
}

public bool Filter_World(int entity, int mask)
{
	// World brushes only: entity 0. Players and props are not what a ceiling
	// pounce chains off, and TR_GetSurfaceFlags is 0 for them anyway.
	return entity == 0;
}

int AnySurvivor()
{
	for (int i = 1; i <= MaxClients; i++)
	{
		if (IsClientInGame(i) && GetClientTeam(i) == TEAM_SURVIVOR && IsPlayerAlive(i)) return i;
	}
	return 0;
}

int FindHunter()
{
	for (int i = 1; i <= MaxClients; i++)
	{
		if (!IsClientInGame(i) || GetClientTeam(i) != TEAM_INFECTED || !IsPlayerAlive(i)) continue;
		if (GetEntProp(i, Prop_Send, "m_zombieClass") == ZC_HUNTER) return i;
	}
	return 0;
}

/** Look around the survivor start for (a) open sky with room under it and
 *  (b) a plain vertical world wall. Both are found by tracing, so the probe
 *  needs no knowledge of the map. */
void Scan(int survivor)
{
	float origin[3];
	GetClientAbsOrigin(survivor, origin);
	g_ground = origin;
	g_haveSky = false;
	g_haveWall = false;
	float bestSky = 999999.0, bestWall = 999999.0;

	for (int gx = -12; gx <= 12; gx++)
	{
		for (int gy = -12; gy <= 12; gy++)
		{
			float p[3];
			p[0] = origin[0] + gx * 96.0;
			p[1] = origin[1] + gy * 96.0;
			p[2] = origin[2] + 48.0;
			if (TR_PointOutsideWorld(p)) continue;

			// Sky straight above, with at least 320 units of air under it.
			float up[3];
			up = p;
			up[2] += 6000.0;
			Handle tr = TR_TraceRayFilterEx(p, up, MASK_PLAYERSOLID, RayType_EndPoint, Filter_World);
			if (TR_DidHit(tr) && IsSky(TR_GetSurfaceFlags(tr)))
			{
				float hit[3];
				TR_GetEndPosition(hit, tr);
				float room = hit[2] - p[2];
				float d = SquareRoot(float(gx * gx + gy * gy));
				if (room >= 320.0 && d < bestSky)
				{
					bestSky = d;
					g_haveSky = true;
					g_skyPos = hit;
					g_skyFlags = TR_GetSurfaceFlags(tr);
					TR_GetSurfaceName(tr, g_skySurf, sizeof g_skySurf);
				}
			}
			delete tr;

			// A vertical, non-sky world face within 900 units, at 160 above p.
			for (int a = 0; a < 8; a++)
			{
				float from[3], to[3];
				from = p;
				from[2] += 160.0;
				if (TR_PointOutsideWorld(from)) break;
				float rad = a * 0.7853981;
				to[0] = from[0] + Cosine(rad) * 900.0;
				to[1] = from[1] + Sine(rad) * 900.0;
				to[2] = from[2];
				Handle tw = TR_TraceRayFilterEx(from, to, MASK_PLAYERSOLID, RayType_EndPoint, Filter_World);
				if (TR_DidHit(tw) && !IsSky(TR_GetSurfaceFlags(tw)))
				{
					float n[3], hit[3];
					TR_GetPlaneNormal(tw, n);
					TR_GetEndPosition(hit, tw);
					float dist = GetVectorDistance(from, hit);
					float d = SquareRoot(float(gx * gx + gy * gy)) + dist / 96.0;
					if (FloatAbs(n[2]) < 0.05 && dist > 200.0 && d < bestWall)
					{
						bestWall = d;
						g_haveWall = true;
						g_wallPos = hit;
						g_wallNormal = n;
						g_wallFlags = TR_GetSurfaceFlags(tw);
						TR_GetSurfaceName(tw, g_wallSurf, sizeof g_wallSurf);
					}
				}
				delete tw;
			}
		}
	}

	// Which way is clear under the sky point, so the chain has somewhere to go.
	if (g_haveSky)
	{
		float from[3];
		from = g_skyPos;
		from[2] -= 140.0;
		float best = -1.0;
		for (int a = 0; a < 8; a++)
		{
			float to[3];
			float rad = a * 0.7853981;
			to[0] = from[0] + Cosine(rad) * 3000.0;
			to[1] = from[1] + Sine(rad) * 3000.0;
			to[2] = from[2];
			Handle tr = TR_TraceRayFilterEx(from, to, MASK_PLAYERSOLID, RayType_EndPoint, Filter_World);
			float hit[3];
			TR_GetEndPosition(hit, tr);
			float dist = GetVectorDistance(from, hit);
			if (dist > best)
			{
				best = dist;
				g_skyYaw = a * 45.0;
			}
			delete tr;
		}
		Say("sky at %.0f %.0f %.0f surf=%s flags=0x%x, %.0f above the start, clear run %.0f at yaw %.0f",
			g_skyPos[0], g_skyPos[1], g_skyPos[2], g_skySurf, g_skyFlags, g_skyPos[2] - origin[2], best, g_skyYaw);
	}
	else Say("NO sky surface found near the start");

	if (g_haveWall)
	{
		Say("wall at %.0f %.0f %.0f surf=%s flags=0x%x normal %.2f %.2f",
			g_wallPos[0], g_wallPos[1], g_wallPos[2], g_wallSurf, g_wallFlags, g_wallNormal[0], g_wallNormal[1]);
	}
	else Say("NO plain wall found near the start");
}

void SetupTrial()
{
	// Order: sky fix-off, sky fix-on, wall fix-off, wall fix-on.
	int cell = g_trial / TRIALS_PER_CELL;
	g_mode = (cell < 2) ? MODE_SKY : MODE_WALL;
	g_fix = (cell % 2) == 1;
	ConVar en = FindConVar("l4d_skypounce_enable");
	if (en == null) Say("l4d_skypounce_enable NOT FOUND: the plugin under test is not loaded");
	else en.SetBool(g_fix);
	ConVar al = FindConVar("l4d_skypounce_allow");
	if (al != null) al.SetInt(FindConVar("skyrig_allow").IntValue);
	ConVar md = FindConVar("l4d_skypounce_mode");
	if (md != null) md.SetInt(FindConVar("skyrig_mode").IntValue);
	ConVar bt = FindConVar("l4d_skypounce_bots");
	if (bt != null) bt.SetBool(true);
	g_lunges = 0;
	g_airLunges = 0;
	g_maxZ = -999999.0;
	g_maxDist = 0.0;
	g_spawnTries = 0;
}

public Action Timer_Tick(Handle timer)
{
	float now = GetGameTime();
	float held = now - g_stateSince;

	switch (g_state)
	{
		case S_WAIT:
		{
			int s = AnySurvivor();
			if (held > 15.0 && s > 0)
			{
				Say("frames so far %d, survivor %N, configuring", g_frames, s);
				ServerCommand("sv_cheats 1; sb_stop 1; god 1; director_stop; director_no_specials 1; z_common_limit 0; nb_delete_all");
				ServerExecute();
				SetConVarInt(FindConVar("sv_cheats"), 1);
				Scan(s);
				SetupTrial();
				Enter(S_SPAWN);
			}
			else if (held > 90.0)
			{
				Say("GIVING UP: no survivor after 90 s (frames %d). The server may be hibernating.", g_frames);
				Finish();
			}
		}
		case S_SPAWN:
		{
			if ((g_mode == MODE_SKY && !g_haveSky) || (g_mode == MODE_WALL && !g_haveWall))
			{
				Say("trial %d skipped: no surface for this mode", g_trial);
				NextTrial();
				return Plugin_Continue;
			}
			g_hunter = FindHunter();
			if (g_hunter == 0)
			{
				int s = AnySurvivor();
				if (s > 0 && (g_spawnTries++ % 10) == 0) FakeClientCommand(s, "z_spawn hunter");
				if (held > 20.0) { Say("GIVING UP: hunter never spawned"); Finish(); }
				return Plugin_Continue;
			}
			float zero[3];
			TeleportEntity(g_hunter, g_ground, NULL_VECTOR, zero);
			Enter(S_CROUCH);
		}
		case S_CROUCH:
		{
			if (!Alive()) { Enter(S_SPAWN); return Plugin_Continue; }
			if (held > 2.0) Enter(S_LAUNCH);
		}
		case S_LAUNCH:
		{
			if (!Alive()) { Enter(S_SPAWN); return Plugin_Continue; }
			if (held > 8.0)
			{
				Say("trial %d: the first pounce never fired (lunging=%d). Bot input override is not working.", g_trial, IsLunging());
				Finish();
			}
		}
		case S_MEASURE:
		{
			if (Alive())
			{
				float pos[3];
				GetClientAbsOrigin(g_hunter, pos);
				if (pos[2] > g_maxZ) g_maxZ = pos[2];
				float flat[3];
				flat = pos;
				flat[2] = g_startPos[2];
				float d = GetVectorDistance(flat, g_startPos);
				if (d > g_maxDist) g_maxDist = d;
			}
			if (Alive() && (g_trial % TRIALS_PER_CELL) == 0)
			{
				float tp[3], tv[3];
				GetClientAbsOrigin(g_hunter, tp);
				GetEntPropVector(g_hunter, Prop_Data, "m_vecVelocity", tv);
				Say("    t=%.1f dz=%.0f flat=%.0f vel=(%.0f %.0f %.0f) ground=%d lunging=%d skyreach=%d",
					held, tp[2] - g_startPos[2], g_maxDist, tv[0], tv[1], tv[2],
					(GetEntityFlags(g_hunter) & FL_ONGROUND) ? 1 : 0, IsLunging(), SkyInReach(g_hunter));
			}
			if (held > MEASURE_SECONDS || !Alive())
			{
				Say("RESULT trial=%d mode=%s fix=%d AIR_REPOUNCES=%d all_lunges=%d max_rise=%.0f max_flat_dist=%.0f alive=%d",
					g_trial, g_mode == MODE_SKY ? "sky" : "wall", g_fix, g_airLunges, g_lunges,
					g_maxZ - g_startPos[2], g_maxDist, Alive());
				if (Alive()) ForcePlayerSuicide(g_hunter);
				g_hunter = 0;
				NextTrial();
			}
		}
	}
	return Plugin_Continue;
}

void NextTrial()
{
	g_trial++;
	if (g_trial >= 4 * TRIALS_PER_CELL) { Finish(); return; }
	SetupTrial();
	Enter(S_SPAWN);
}

void Finish()
{
	if (g_state == S_DONE) return;
	Enter(S_DONE);
	Say("done, quitting");
	CreateTimer(2.0, Timer_Quit);
}

public Action Timer_Quit(Handle timer)
{
	ServerCommand("quit");
	return Plugin_Stop;
}

bool Alive()
{
	return g_hunter > 0 && IsClientInGame(g_hunter) && IsPlayerAlive(g_hunter)
		&& GetClientTeam(g_hunter) == TEAM_INFECTED;
}

int IsLunging()
{
	if (!Alive()) return -1;
	int ability = GetEntPropEnt(g_hunter, Prop_Send, "m_customAbility");
	if (ability <= 0 || !IsValidEntity(ability)) return -1;
	if (!HasEntProp(ability, Prop_Send, "m_isLunging")) return -2;
	return GetEntProp(ability, Prop_Send, "m_isLunging");
}

public void Event_AbilityUse(Event event, const char[] name, bool dontBroadcast)
{
	int client = GetClientOfUserId(event.GetInt("userid"));
	if (client == 0 || client != g_hunter) return;
	char ability[32];
	event.GetString("ability", ability, sizeof ability);
	if (!StrEqual(ability, "ability_lunge")) return;

	if (g_state == S_LAUNCH)
	{
		// The first pounce, off the ground. Move it mid-lunge to the surface
		// under test on the next frame, once the lunge has really begun.
		RequestFrame(Frame_Place, GetClientUserId(client));
	}
	else if (g_state == S_MEASURE)
	{
		g_lunges++;
		bool air = !(GetEntityFlags(client) & FL_ONGROUND);
		if (air) g_airLunges++;
		float pos[3];
		GetClientAbsOrigin(client, pos);
		Say("  trial %d lunge #%d %s at %.0f %.0f %.0f (%.0f under the sky)", g_trial, g_lunges,
			air ? "AIRBORNE" : "from the ground", pos[0], pos[1], pos[2], g_skyPos[2] - pos[2]);
	}
}

public void Frame_Place(int userid)
{
	int client = GetClientOfUserId(userid);
	if (client == 0 || client != g_hunter || g_state != S_LAUNCH) return;

	float pos[3], vel[3], ang[3];
	if (g_mode == MODE_SKY)
	{
		// Feet 110 under the sky face, flying up and along the clear heading.
		pos = g_skyPos;
		pos[2] -= 100.0;
		float rad = DegToRad(g_skyYaw);
		vel[0] = Cosine(rad) * 250.0;
		vel[1] = Sine(rad) * 250.0;
		vel[2] = 700.0;
	}
	else
	{
		// 70 off the wall, flying straight into it.
		pos[0] = g_wallPos[0] + g_wallNormal[0] * 70.0;
		pos[1] = g_wallPos[1] + g_wallNormal[1] * 70.0;
		pos[2] = g_wallPos[2] - 30.0;
		vel[0] = -g_wallNormal[0] * 600.0;
		vel[1] = -g_wallNormal[1] * 600.0;
		vel[2] = 150.0;
	}
	g_placeVel = vel;
	g_placeFrames = 4;
	AimFor(ang);
	TeleportEntity(client, pos, ang, vel);
	g_startPos = pos;
	g_maxZ = pos[2];
	Say("trial %d placed mode=%s fix=%d lunging=%d", g_trial, g_mode == MODE_SKY ? "sky" : "wall", g_fix, IsLunging());
	Enter(S_MEASURE);
}

/** Where the hunter looks while pulsing attack, which is where a re-pounce
 *  would send it. */
void AimFor(float ang[3])
{
	if (g_mode == MODE_SKY)
	{
		ang[0] = FindConVar("skyrig_pitch").FloatValue;   // what a ceiling runner holds; 12 is inside Zen's 10 to 14 band
		ang[1] = g_skyYaw;
	}
	else
	{
		float v[3];
		GetVectorAngles(g_wallNormal, v);
		ang[0] = -35.0;      // up and away from the wall
		ang[1] = v[1];
	}
	ang[2] = 0.0;
}

/** Telemetry only: whether sky is near. The plugin under test has its own. */
bool SkyInReach(int client)
{
	float eye[3], vel[3], to[3];
	GetClientEyePosition(client, eye);

	to = eye;
	to[2] += 72.0;
	Handle tr = TR_TraceRayFilterEx(eye, to, MASK_PLAYERSOLID, RayType_EndPoint, Filter_World);
	bool sky = TR_DidHit(tr) && IsSky(TR_GetSurfaceFlags(tr));
	delete tr;
	if (sky) return true;

	GetEntPropVector(client, Prop_Data, "m_vecVelocity", vel);
	if (GetVectorLength(vel) < 1.0) return false;
	NormalizeVector(vel, vel);
	to[0] = eye[0] + vel[0] * 72.0;
	to[1] = eye[1] + vel[1] * 72.0;
	to[2] = eye[2] + vel[2] * 72.0;
	tr = TR_TraceRayFilterEx(eye, to, MASK_PLAYERSOLID, RayType_EndPoint, Filter_World);
	sky = TR_DidHit(tr) && IsSky(TR_GetSurfaceFlags(tr));
	delete tr;
	return sky;
}

public Action OnPlayerRunCmd(int client, int &buttons, int &impulse, float vel[3], float angles[3],
	int &weapon, int &subtype, int &cmdnum, int &tickcount, int &seed, int mouse[2])
{
	if (client != g_hunter || !Alive()) return Plugin_Continue;
	if (g_state != S_CROUCH && g_state != S_LAUNCH && g_state != S_MEASURE) return Plugin_Continue;

	// 1. The harness: replace whatever the bot's AI wanted.
	vel[0] = 0.0; vel[1] = 0.0; vel[2] = 0.0;
	buttons = IN_DUCK;
	// 5 ticks down, 5 up: a press edge ten times a second at 100 tick.
	// Off the ground: 5 ticks down, 5 up. In the air: a fresh press edge every
	// other tick, because the moment of contact lasts only a tick or two and a
	// slow rhythm hits or misses it by luck. Someone exploiting this spams the
	// button (or binds it to the wheel), so this is the honest worst case.
	bool airNow = !(GetEntityFlags(client) & FL_ONGROUND);
	if (g_state == S_MEASURE && airNow) { if ((g_frames % 2) == 0) buttons |= IN_ATTACK; }
	else if (g_state != S_CROUCH && (g_frames % 10) < 5) buttons |= IN_ATTACK;
	if (g_state == S_MEASURE) AimFor(angles);
	else { angles[0] = -45.0; angles[2] = 0.0; }

	if (g_state != S_MEASURE) return Plugin_Changed;

	// The lunge writes its own velocity for the first ticks, so the placement
	// velocity is repeated briefly to make sure the hunter really arrives.
	if (g_placeFrames > 0)
	{
		g_placeFrames--;
		TeleportEntity(client, NULL_VECTOR, NULL_VECTOR, g_placeVel);
	}

	return Plugin_Changed;
}
