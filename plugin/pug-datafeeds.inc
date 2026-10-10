// Data feeds for the site (docs/data-feeds-2026-10-10.md). Three of them, none
// of which changes gameplay or shows anything in game:
//
//   A. Connection funnel: CONN and MAPLOAD lines, per rostered player, so the
//      site can tell "still loading the map" from "in game, not ready", and
//      can mark a player who drops while loading an L4D2-port map.
//   B. Flow and cause: every EVENT line gains flow= (the survivor's own flow
//      %), prog= (the furthest survivor's) and, on incap/death/tank_death,
//      cause=. A DOWN line goes out for every incap and death of a rostered
//      survivor, including the attacker-less deaths the EVENT feed has never
//      carried (bleed-out, fall, commons, the witch). ROUND_FLOW closes a
//      round with every survivor's flow, which is where a wipe happened.
//   C. SI lives: one record per infected life of a rostered player (ghost,
//      materialize, first hit, damage, end and why, respawn timer), batched
//      at round end into a few SILIFE lines and closed by SILIFE_END.
//
// Every line goes through EmitPug, so nothing leaves the box without a
// tracked match, and every new key or verb is one an older site ignores:
// logParse.ts returns null for an unknown verb and kv() skips unknown keys.
//
// Hooks. Game events where one exists (player_connect, player_activate,
// player_team, player_disconnect, tank_frustrated, ghost_spawn_time,
// revive_success, tank_spawn, player_spawn), each with its own callback so
// the order against pug-match's own callbacks never matters. One left4dhooks
// forward, L4D_OnEnterGhostState, whose detour is already active on every
// server (l4d_QuadCaps and l4d_versus_GhostWarp listen to it). Materialize
// is read from player_spawn, which fires inside MaterializeFromGhost, so no
// new detour is enabled by this file.
//
// pug-match.sp calls in at eight places, one line each; the rest is here.

#define DF_MAX_LIVES 192
/** Longest SILIFE / ROUND_FLOW body before a new line starts. EmitPug's
 *  buffer is 768 and the signature trailer needs room after it. */
#define DF_LINE_MAX 560

// Damage type bits (sdkhooks has them, this plugin does not include it).
#define DF_DMG_CRUSH (1 << 0)
#define DF_DMG_BURN  (1 << 3)
#define DF_DMG_FALL  (1 << 5)
#define DF_DMG_BLAST (1 << 6)
#define DF_DMG_CLUB  (1 << 7)

// How an SI life ended.
enum
{
	DFE_OPEN = 0,     // still alive (or a ghost) when the round ended
	DFE_SKEET,        // a hunter shot out of a pounce
	DFE_SHOT,         // any other survivor gunfire
	DFE_SHOVE,        // a shove (DMG_CLUB) killed it
	DFE_MELEE,        // an L4D2 melee weapon; cannot happen on L4D1
	DFE_FIRE,         // burned (molotov, gas can)
	DFE_BLAST,        // pipe bomb or propane
	DFE_OTHER,        // the world, a fall, a suicide, nobody
	DFE_PASS,         // a tank whose control passed to someone else
	DFE_TANK,         // the player became the tank, which starts a new life
	DFE_DISC,         // disconnected
	DFE_TEAM,         // left the infected team
	DFE_MAX
}

int g_iDfLifeSlot[DF_MAX_LIVES];
int g_iDfLifeZc[DF_MAX_LIVES];
int g_iDfLifeGhostT[DF_MAX_LIVES];      // round ms the ghost began; 0 = already a ghost at go-live; -1 = none
int g_iDfLifeSpawnT[DF_MAX_LIVES];      // round ms it materialized (or spawned as tank); -1 = never
int g_iDfLifeSpawnFlow[DF_MAX_LIVES];   // its own flow % there; -1 = unknown
int g_iDfLifeSpawnProg[DF_MAX_LIVES];   // the furthest survivor's flow % then
int g_iDfLifeHitT[DF_MAX_LIVES];        // round ms of its first damage to a survivor; -1 = none
int g_iDfLifeDmg[DF_MAX_LIVES];         // damage to standing survivors
int g_iDfLifeDmgInc[DF_MAX_LIVES];      // damage to incapped survivors (bleed pool)
int g_iDfLifeEndT[DF_MAX_LIVES];        // round ms it ended; -1 = open
int g_iDfLifeEnd[DF_MAX_LIVES];         // DFE_*
int g_iDfLifeKiller[DF_MAX_LIVES];      // roster slot of the killer; -1 = none or unrostered
int g_iDfLifeResp[DF_MAX_LIVES];        // ghost_spawn_time seconds given at its death; -1 = none
float g_fDfLifeEndAt[DF_MAX_LIVES];     // GetGameTime() at the end, for late skeet/respawn notes
int g_iDfLives;
int g_iDfLivesDropped;
int g_iDfOpen[MAXPLAYERS + 1];          // open life index per client; -1 = none
int g_iDfLast[MAXPLAYERS + 1];          // last closed life index per client; -1 = none

float g_fDfSkeetAt[MAXPLAYERS + 1];     // skill_detect called this client's death a skeet, before the death arrived
float g_fDfFrustratedAt[MAXPLAYERS + 1];
bool g_bDfIncapped[MAXPLAYERS + 1];     // down and not yet revived, so a death after it is a bleed-out
int g_iDfLastFlow[MAXPLAYERS + 1];      // last flow % read for this survivor; -1 = none

// The cause for the EVENT line about to be emitted. Set by DataFeeds_OnIncap
// and DataFeeds_OnDeath immediately before pug-match emits, and honoured only
// for the same kind, actor and game tick, so a cause whose EVENT was dropped
// (StatsActive, an unrostered actor) can never attach to a later one.
char g_sDfCauseKind[16];
char g_sDfCause[16];
int g_iDfCauseActor;
int g_iDfCauseTick = -1;

// Connection funnel, per client index (client indexes survive a changelevel).
int g_iDfConnSlot[MAXPLAYERS + 1];      // roster slot named by player_connect / activate; -1 = not rostered
bool g_bDfInGame[MAXPLAYERS + 1];       // player_activate seen on this map
bool g_bDfTeamSent[MAXPLAYERS + 1];
bool g_bDfReadySent[MAXPLAYERS + 1];

/** From OnPluginStart. Every hook is Ex: a missing event costs its feed,
 *  never the plugin. */
void DataFeeds_Init()
{
	for (int i = 0; i <= MAXPLAYERS; i++)
	{
		g_iDfOpen[i] = -1;
		g_iDfLast[i] = -1;
		g_iDfConnSlot[i] = -1;
		g_iDfLastFlow[i] = -1;
	}
	if (!HookEventEx("player_connect", DataFeeds_PlayerConnect))
		LogMessage("[pug] player_connect not on this engine; no CONN connect stage");
	if (!HookEventEx("player_activate", DataFeeds_PlayerActivate))
		LogMessage("[pug] player_activate not on this engine; no CONN ingame stage");
	if (!HookEventEx("player_team", DataFeeds_PlayerTeam))
		LogMessage("[pug] player_team not on this engine; no CONN team stage");
	// Pre, like l4d_consistency and pug-leave: the slot can still be asked.
	if (!HookEventEx("player_disconnect", DataFeeds_PlayerDisconnect, EventHookMode_Pre))
		LogMessage("[pug] player_disconnect not on this engine; no CONN drop stage");
	if (!HookEventEx("tank_frustrated", DataFeeds_TankFrustrated))
		LogMessage("[pug] tank_frustrated not on this engine; tank passes read from health only");
	if (!HookEventEx("ghost_spawn_time", DataFeeds_GhostSpawnTime))
		LogMessage("[pug] ghost_spawn_time not on this engine; SI lives carry no respawn timer");
	HookEventEx("revive_success", DataFeeds_Revive);
	HookEventEx("tank_spawn", DataFeeds_TankSpawn);
	HookEventEx("player_spawn", DataFeeds_PlayerSpawn);
	CreateTimer(1.0, Timer_DataFeeds, _, TIMER_REPEAT);
	RegServerCmd("sm_pug_df_status", Cmd_DfStatus, "sm_pug_df_status - data feed state (SI lives this round, funnel), for debugging");
}

/** From ResetMatchState. */
void DataFeeds_Reset()
{
	DfResetLives();
	for (int i = 0; i <= MAXPLAYERS; i++)
	{
		g_iDfConnSlot[i] = -1;
		g_bDfInGame[i] = false;
		g_bDfTeamSent[i] = false;
		g_bDfReadySent[i] = false;
		g_bDfIncapped[i] = false;
		g_iDfLastFlow[i] = -1;
	}
	g_iDfCauseTick = -1;
}

static void DfResetLives()
{
	g_iDfLives = 0;
	g_iDfLivesDropped = 0;
	for (int i = 0; i <= MAXPLAYERS; i++)
	{
		g_iDfOpen[i] = -1;
		g_iDfLast[i] = -1;
		g_fDfSkeetAt[i] = 0.0;
	}
}

// ---------- shared helpers ----------

/** The roster slot of a client for these feeds, or -1. Test builds (spcomp
 *  ... DF_TEST=1) also give bots a slot, so the cfgfp rig can drive every
 *  feed without a human; see Timer_DataFeeds. */
static int DfSlot(int client)
{
	if (client < 1 || client > MaxClients || !IsClientInGame(client)) return -1;
	return g_iClientRoster[client];
}

/** A client's flow through the map in whole percent, the same reading !cur
 *  and LIVEHUD use, or -1. No alive check: a survivor's last known area is
 *  where they went down, which is the number wanted for a death. Falls back
 *  to the last value read for them. */
int DfFlow(int client)
{
	if (client < 1 || client > MaxClients || !IsClientInGame(client)) return -1;
	float maxFlow = L4D2Direct_GetMapMaxFlowDistance();
	if (maxFlow <= 0.0) return g_iDfLastFlow[client];
	Address area = L4D_GetLastKnownArea(client);
	if (area == Address_Null) return g_iDfLastFlow[client];
	int pct = RoundToNearest(L4D2Direct_GetTerrorNavAreaFlow(area) / maxFlow * 100.0);
	pct = pct < 0 ? 0 : (pct > 100 ? 100 : pct);
	if (GetClientTeam(client) == TEAM_SURVIVOR) g_iDfLastFlow[client] = pct;
	return pct;
}

/** The furthest survivor's flow %, bots included, the dead excluded; -1 when
 *  none can be read. The team's progress, which is what a tank spawn, a witch
 *  or a wipe is measured against. */
int DfProg()
{
	int best = -1;
	for (int c = 1; c <= MaxClients; c++)
	{
		if (!IsClientInGame(c) || GetClientTeam(c) != TEAM_SURVIVOR || !IsPlayerAlive(c)) continue;
		int f = DfFlow(c);
		if (f > best) best = f;
	}
	return best;
}

static bool DfIsSurvivor(int c)
{
	return c >= 1 && c <= MaxClients && IsClientInGame(c) && GetClientTeam(c) == TEAM_SURVIVOR;
}

static bool DfIsInfected(int c)
{
	return c >= 1 && c <= MaxClients && IsClientInGame(c) && GetClientTeam(c) == TEAM_INFECTED;
}

static int DfZc(int c)
{
	return DfIsInfected(c) ? GetEntProp(c, Prop_Send, "m_zombieClass") : 0;
}

static void DfEndName(int code, char[] out, int len)
{
	switch (code)
	{
		case DFE_OPEN:  strcopy(out, len, "open");
		case DFE_SKEET: strcopy(out, len, "skeet");
		case DFE_SHOT:  strcopy(out, len, "shot");
		case DFE_SHOVE: strcopy(out, len, "shove");
		case DFE_MELEE: strcopy(out, len, "melee");
		case DFE_FIRE:  strcopy(out, len, "fire");
		case DFE_BLAST: strcopy(out, len, "blast");
		case DFE_PASS:  strcopy(out, len, "pass");
		case DFE_TANK:  strcopy(out, len, "tank");
		case DFE_DISC:  strcopy(out, len, "disc");
		case DFE_TEAM:  strcopy(out, len, "team");
		default:        strcopy(out, len, "other");
	}
}

// ---------- B: flow and cause ----------

/** Appended to every EVENT line by EmitEvent:
 *    " flow=<survivor's own %> prog=<team %>[ cause=<code>]"
 *  flow is the survivor the event is about: the actor when they are a
 *  survivor (incap, death, cleared, skeet, ff, witch_aggro), else the target
 *  (pinned, boom). -1 when there is none (tank_spawn) or it cannot be read. */
void DataFeeds_EventTail(const char[] kind, int actor, int target, char[] out, int len)
{
	int who = DfIsSurvivor(actor) ? actor : (DfIsSurvivor(target) ? target : 0);
	int flow = who > 0 ? DfFlow(who) : -1;
	Format(out, len, " flow=%d prog=%d", flow, DfProg());
	if (g_iDfCauseTick == GetGameTickCount() && g_iDfCauseActor == actor && StrEqual(g_sDfCauseKind, kind))
	{
		Format(out, len, "%s cause=%s", out, g_sDfCause);
		g_iDfCauseTick = -1;
	}
}

static void DfSetCause(const char[] kind, int actor, const char[] cause)
{
	strcopy(g_sDfCauseKind, sizeof(g_sDfCauseKind), kind);
	strcopy(g_sDfCause, sizeof(g_sDfCause), cause);
	g_iDfCauseActor = actor;
	g_iDfCauseTick = GetGameTickCount();
}

/** What put a survivor down (incap) or finished them (death):
 *  punch, rock, hittable, tank, hunter, smoker, boomer, common, witch, fall,
 *  bleed, ff, other. Read from the event's own attacker, attackerentid,
 *  weapon and damage type, so it needs no extra hook. */
static void DfSurvivorCause(Event event, int victim, int attacker, bool death, char[] out, int len)
{
	int type = event.GetInt("type");
	char wpn[32];
	event.GetString("weapon", wpn, sizeof(wpn));
	bool bleeding = death && g_bDfIncapped[victim];

	if (attacker >= 1 && attacker <= MaxClients && IsClientInGame(attacker) && attacker != victim)
	{
		int team = GetClientTeam(attacker);
		if (team == TEAM_SURVIVOR) { strcopy(out, len, "ff"); return; }
		if (team == TEAM_INFECTED)
		{
			switch (GetEntProp(attacker, Prop_Send, "m_zombieClass"))
			{
				case ZC_HUNTER: { strcopy(out, len, "hunter"); return; }
				case ZC_SMOKER: { strcopy(out, len, "smoker"); return; }
				case ZC_BOOMER: { strcopy(out, len, "boomer"); return; }
				case ZC_TANK:
				{
					if (StrEqual(wpn, "tank_claw")) strcopy(out, len, "punch");
					else if (StrEqual(wpn, "tank_rock")) strcopy(out, len, "rock");
					else if (StrContains(wpn, "prop_") == 0 || (type & DF_DMG_CRUSH)) strcopy(out, len, "hittable");
					else if (type & DF_DMG_FALL) strcopy(out, len, "fall");
					else strcopy(out, len, "tank");
					return;
				}
			}
		}
	}
	if (type & DF_DMG_FALL) { strcopy(out, len, "fall"); return; }
	int ent = event.GetInt("attackerentid");
	if (ent > MaxClients && IsValidEntity(ent))
	{
		char cls[32];
		GetEntityClassname(ent, cls, sizeof(cls));
		if (StrEqual(cls, "witch")) { strcopy(out, len, "witch"); return; }
		if (StrEqual(cls, "infected")) { strcopy(out, len, "common"); return; }
		if (StrEqual(cls, "tank_rock")) { strcopy(out, len, "rock"); return; }
		if (StrContains(cls, "prop_") == 0) { strcopy(out, len, "hittable"); return; }
	}
	if (StrEqual(wpn, "tank_rock")) { strcopy(out, len, "rock"); return; }
	if (bleeding) { strcopy(out, len, "bleed"); return; }
	strcopy(out, len, "other");
}

/**    DOWN half=<h> t=<ms> steamid=<victim> kind=<incap|death> cause=<code> by=<steamid|0> flow=<%> prog=<%> pinned=<0|1>
 *  One per rostered survivor going down or dying, attacker or not. */
static void DfEmitDown(const char[] kind, int victim, int attacker, const char[] cause)
{
	int slot = DfSlot(victim);
	if (slot < 0) return;
	char by[32] = "0";
	int aslot = (attacker != victim) ? DfSlot(attacker) : -1;
	if (aslot >= 0) strcopy(by, sizeof(by), g_sRosterId[aslot]);
	EmitPug("DOWN half=%d t=%d steamid=%s kind=%s cause=%s by=%s flow=%d prog=%d pinned=%d",
		g_iHalf, RoundMs(), g_sRosterId[slot], kind, cause, by, DfFlow(victim), DfProg(),
		g_iPinnedBy[victim] > 0 ? 1 : 0);
}

/** From Event_Incap, before its EmitClientEvent("incap", ...). */
void DataFeeds_OnIncap(Event event, int victim, int attacker)
{
	if (!StatsActive() || !DfIsSurvivor(victim)) return;
	char cause[16];
	DfSurvivorCause(event, victim, attacker, false, cause, sizeof(cause));
	DfSetCause("incap", victim, cause);
	DfEmitDown("incap", victim, attacker, cause);
	g_bDfIncapped[victim] = true;
}

/** A tank's player_death: killed, or control passed (the frustration pass
 *  kills the old tank player with themselves or nobody as the attacker, which
 *  is why tank_death has always fired on a pass). */
static bool DfTankPassed(int victim, int attacker)
{
	if (DfIsSurvivor(attacker)) return false;
	if (g_fDfFrustratedAt[victim] > 0.0 && GetGameTime() - g_fDfFrustratedAt[victim] < 5.0) return true;
	if (attacker == victim) return true;
	if (DfIsInfected(attacker)) return true;
	return GetClientHealth(victim) > 0;
}

/** How an infected player's life ended, for player_death. */
static int DfSiEnd(Event event, int victim, int attacker)
{
	int zc = DfZc(victim);
	if (zc == ZC_TANK && DfTankPassed(victim, attacker)) return DFE_PASS;
	if (g_fDfSkeetAt[victim] > 0.0 && GetGameTime() - g_fDfSkeetAt[victim] < 1.0) return DFE_SKEET;
	if (!DfIsSurvivor(attacker)) return DFE_OTHER;
	int type = event.GetInt("type");
	char wpn[32];
	event.GetString("weapon", wpn, sizeof(wpn));
	if (zc == ZC_HUNTER && HasEntProp(victim, Prop_Send, "m_isAttemptingToPounce")
		&& GetEntProp(victim, Prop_Send, "m_isAttemptingToPounce") != 0) return DFE_SKEET;
	if (StrEqual(wpn, "melee")) return DFE_MELEE;
	if (type & DF_DMG_CLUB) return DFE_SHOVE;
	if ((type & DF_DMG_BURN) || StrEqual(wpn, "inferno") || StrEqual(wpn, "entityflame")) return DFE_FIRE;
	if ((type & DF_DMG_BLAST) || StrEqual(wpn, "pipe_bomb")) return DFE_BLAST;
	return DFE_SHOT;
}

/** From Event_PlayerDeath, after its StatsActive gate and before any of its
 *  emissions. Survivors: the DOWN line and the cause for the "death" EVENT.
 *  Infected: closes the SI life, and the cause (kill or pass) for the
 *  "tank_death" EVENT. */
void DataFeeds_OnDeath(Event event, int victim, int attacker)
{
	if (victim < 1 || victim > MaxClients || !IsClientInGame(victim)) return;
	if (GetClientTeam(victim) == TEAM_SURVIVOR)
	{
		char cause[16];
		DfSurvivorCause(event, victim, attacker, true, cause, sizeof(cause));
		DfSetCause("death", victim, cause);
		DfEmitDown("death", victim, attacker, cause);
		g_bDfIncapped[victim] = false;
		return;
	}
	if (GetClientTeam(victim) != TEAM_INFECTED) return;
	int end = DfSiEnd(event, victim, attacker);
	if (DfZc(victim) == ZC_TANK) DfSetCause("tank_death", attacker, end == DFE_PASS ? "pass" : "kill");
	DfCloseLife(victim, end, DfIsSurvivor(attacker) ? DfSlot(attacker) : -1);
}

/** From pug-stats.inc's CountSkeet: skill_detect says this hunter was
 *  skeeted. It may arrive before or after player_death, so it marks the
 *  client for a death still to come and corrects a life closed a moment ago. */
void DataFeeds_MarkSkeet(int victim)
{
	if (victim < 1 || victim > MaxClients) return;
	g_fDfSkeetAt[victim] = GetGameTime();
	int i = g_iDfLast[victim];
	if (i >= 0 && g_iDfOpen[victim] == -1 && GetGameTime() - g_fDfLifeEndAt[i] < 1.0
		&& g_iDfLifeEnd[i] != DFE_PASS) g_iDfLifeEnd[i] = DFE_SKEET;
}

public void DataFeeds_Revive(Event event, const char[] name, bool dontBroadcast)
{
	int subject = GetClientOfUserId(event.GetInt("subject"));
	if (subject >= 1 && subject <= MaxClients) g_bDfIncapped[subject] = false;
}

public void DataFeeds_TankFrustrated(Event event, const char[] name, bool dontBroadcast)
{
	int client = GetClientOfUserId(event.GetInt("userid"));
	if (client >= 1 && client <= MaxClients) g_fDfFrustratedAt[client] = GetGameTime();
}

// ---------- C: SI lives ----------

static int DfOpenLife(int client, int zc)
{
	int slot = DfSlot(client);
	if (slot < 0) return -1;
	if (g_iDfOpen[client] != -1) DfCloseLife(client, DFE_OTHER, -1);
	if (g_iDfLives >= DF_MAX_LIVES) { g_iDfLivesDropped++; return -1; }
	int i = g_iDfLives++;
	g_iDfLifeSlot[i] = slot;
	g_iDfLifeZc[i] = zc;
	g_iDfLifeGhostT[i] = -1;
	g_iDfLifeSpawnT[i] = -1;
	g_iDfLifeSpawnFlow[i] = -1;
	g_iDfLifeSpawnProg[i] = -1;
	g_iDfLifeHitT[i] = -1;
	g_iDfLifeDmg[i] = 0;
	g_iDfLifeDmgInc[i] = 0;
	g_iDfLifeEndT[i] = -1;
	g_iDfLifeEnd[i] = DFE_OPEN;
	g_iDfLifeKiller[i] = -1;
	g_iDfLifeResp[i] = -1;
	g_fDfLifeEndAt[i] = 0.0;
	g_iDfOpen[client] = i;
	g_fDfSkeetAt[client] = 0.0;
	return i;
}

static void DfMarkSpawn(int client, int i)
{
	if (i < 0 || g_iDfLifeSpawnT[i] != -1) return;
	int t = RoundMs();
	g_iDfLifeSpawnT[i] = t < 0 ? 0 : t;
	g_iDfLifeZc[i] = DfZc(client);
	g_iDfLifeSpawnFlow[i] = DfFlow(client);
	g_iDfLifeSpawnProg[i] = DfProg();
}

static void DfCloseLife(int client, int end, int killerSlot)
{
	int i = g_iDfOpen[client];
	if (i < 0) return;
	g_iDfOpen[client] = -1;
	g_iDfLast[client] = i;
	int t = RoundMs();
	g_iDfLifeEndT[i] = t < 0 ? 0 : t;
	g_iDfLifeEnd[i] = end;
	g_iDfLifeKiller[i] = killerSlot;
	g_fDfLifeEndAt[i] = GetGameTime();
}

public void L4D_OnEnterGhostState(int client)
{
	if (!StatsActive() || !DfIsInfected(client) || DfSlot(client) < 0) return;
	int i = DfOpenLife(client, DfZc(client));
	if (i >= 0)
	{
		int t = RoundMs();
		g_iDfLifeGhostT[i] = t < 0 ? 0 : t;
	}
}

/** Materialize, and the spawn of anything that never ghosted (bots in test
 *  builds, a life that began before tracking). player_spawn fires INSIDE
 *  CTerrorPlayer::MaterializeFromGhost while m_isGhost is still 1 (seen on
 *  the rig, 2026-10-09: the event, then the left4dhooks forward), so the
 *  ghost flag is read one frame later. No detour needed for this. A player
 *  who is still a ghost next frame was entering ghost state, which
 *  L4D_OnEnterGhostState records. */
public void DataFeeds_PlayerSpawn(Event event, const char[] name, bool dontBroadcast)
{
	if (!StatsActive()) return;
#if defined DF_TEST
	DfTestBindBots();
#endif
	int client = GetClientOfUserId(event.GetInt("userid"));
	if (!DfIsInfected(client) || DfSlot(client) < 0) return;
	RequestFrame(DfSpawnFrame, event.GetInt("userid"));
}

public void DfSpawnFrame(any userid)
{
	int client = GetClientOfUserId(userid);
	if (!StatsActive() || !DfIsInfected(client) || !IsPlayerAlive(client) || DfSlot(client) < 0) return;
	if (GetEntProp(client, Prop_Send, "m_isGhost") != 0) return;
	int zc = DfZc(client);
	if (zc == ZC_TANK) return;            // tank_spawn owns tank lives
	int i = g_iDfOpen[client];
	if (i < 0) i = DfOpenLife(client, zc);
	DfMarkSpawn(client, i);
}

/** A tank life starts at tank_spawn, which L4D1 also fires for every new
 *  controller after a pass. Whatever the player was before (a ghost, a
 *  spawned SI) ends as "tank". */
public void DataFeeds_TankSpawn(Event event, const char[] name, bool dontBroadcast)
{
	if (!StatsActive()) return;
#if defined DF_TEST
	DfTestBindBots();
#endif
	int client = GetClientOfUserId(event.GetInt("userid"));
	if (!DfIsInfected(client) || DfSlot(client) < 0) return;
	if (g_iDfOpen[client] != -1) DfCloseLife(client, DFE_TANK, -1);
	int i = DfOpenLife(client, ZC_TANK);
	DfMarkSpawn(client, i);
	if (i >= 0) g_iDfLifeZc[i] = ZC_TANK;
}

/** The respawn timer the game gave a dead infected player. Fires at (or just
 *  after) the death, so it belongs to the life that just closed. */
public void DataFeeds_GhostSpawnTime(Event event, const char[] name, bool dontBroadcast)
{
	int client = GetClientOfUserId(event.GetInt("userid"));
	if (client < 1 || client > MaxClients) return;
	int i = g_iDfLast[client];
	if (i < 0 || g_iDfOpen[client] != -1 || GetGameTime() - g_fDfLifeEndAt[i] > 3.0) return;
	g_iDfLifeResp[i] = event.GetInt("spawntime");
}

/** From Event_PlayerHurt's infected branch (rostered human SI hurt a
 *  survivor, StatsActive already checked). */
void DataFeeds_SiHit(int attacker, int victim, int damage)
{
	int i = g_iDfOpen[attacker];
	if (i < 0) return;
	if (g_iDfLifeHitT[i] == -1)
	{
		int t = RoundMs();
		g_iDfLifeHitT[i] = t < 0 ? 0 : t;
	}
	if (GetEntProp(victim, Prop_Send, "m_isIncapacitated") != 0) g_iDfLifeDmgInc[i] += damage;
	else g_iDfLifeDmg[i] += damage;
}

// ---------- round boundaries ----------

/** From OnRoundIsLive, inside the tracked-match branch. Infected already
 *  ghosting (or spawned) through the ready-up get a life from t=0. */
void DataFeeds_RoundLive()
{
	DfResetLives();
	g_iDfCauseTick = -1;
	for (int c = 1; c <= MaxClients; c++)
	{
		g_bDfIncapped[c] = false;
		g_fDfFrustratedAt[c] = 0.0;
		if (!DfIsInfected(c) || !IsPlayerAlive(c) || DfSlot(c) < 0) continue;
		int i = DfOpenLife(c, DfZc(c));
		if (i < 0) continue;
		if (GetEntProp(c, Prop_Send, "m_isGhost") != 0) g_iDfLifeGhostT[i] = 0;
		else DfMarkSpawn(c, i);
	}
}

/** From Event_RoundEnd, right after EmitRoundStats, so the half and the round
 *  clock are still this round's.
 *
 *    ROUND_FLOW half=<h> prog=<%> p=<steamid>:<flow %>,...
 *    SILIFE half=<h> i=<index of the first record> l=<record>,<record>,...
 *    SILIFE_END half=<h> lives=<n> dropped=<n>
 *
 *  A record is id:zc:ghost:spawn:sflow:sprog:hit:dmg:dmginc:end_t:end:killer:resp
 *  (times in round ms, -1 for none; killer a steamid or 0). Each line starts
 *  at its own index, so a duplicated datagram upserts over itself and a lost
 *  one leaves a gap SILIFE_END's count shows. */
void DataFeeds_RoundEnd(int half)
{
	// Who was where when it ended, the dead included (their last reading).
	char flows[DF_LINE_MAX];
	flows[0] = '\0';
	int prog = -1;
	for (int c = 1; c <= MaxClients; c++)
	{
		if (!IsClientInGame(c) || GetClientTeam(c) != TEAM_SURVIVOR) continue;
		int f = DfFlow(c);
		if (f > prog) prog = f;
		int slot = DfSlot(c);
		if (slot < 0) continue;
		Format(flows, sizeof(flows), "%s%s%s:%d", flows, flows[0] == '\0' ? "" : ",", g_sRosterId[slot], f);
	}
	EmitPug("ROUND_FLOW half=%d prog=%d p=%s", half, prog, flows);

	for (int c = 1; c <= MaxClients; c++) if (g_iDfOpen[c] != -1) DfCloseLife(c, DFE_OPEN, -1);

	char line[DF_LINE_MAX + 128], rec[160], endName[8], killer[32];
	int first = 0;
	line[0] = '\0';
	for (int i = 0; i < g_iDfLives; i++)
	{
		DfEndName(g_iDfLifeEnd[i], endName, sizeof(endName));
		if (g_iDfLifeKiller[i] >= 0) strcopy(killer, sizeof(killer), g_sRosterId[g_iDfLifeKiller[i]]);
		else strcopy(killer, sizeof(killer), "0");
		Format(rec, sizeof(rec), "%s:%d:%d:%d:%d:%d:%d:%d:%d:%d:%s:%s:%d",
			g_sRosterId[g_iDfLifeSlot[i]], g_iDfLifeZc[i], g_iDfLifeGhostT[i], g_iDfLifeSpawnT[i],
			g_iDfLifeSpawnFlow[i], g_iDfLifeSpawnProg[i], g_iDfLifeHitT[i], g_iDfLifeDmg[i],
			g_iDfLifeDmgInc[i], g_iDfLifeEndT[i], endName, killer, g_iDfLifeResp[i]);
		if (line[0] != '\0' && strlen(line) + strlen(rec) + 1 > DF_LINE_MAX)
		{
			EmitPug("SILIFE half=%d i=%d l=%s", half, first, line);
			line[0] = '\0';
		}
		if (line[0] == '\0') first = i;
		else StrCat(line, sizeof(line), ",");
		StrCat(line, sizeof(line), rec);
	}
	if (line[0] != '\0') EmitPug("SILIFE half=%d i=%d l=%s", half, first, line);
	EmitPug("SILIFE_END half=%d lives=%d dropped=%d", half, g_iDfLives, g_iDfLivesDropped);
}

// ---------- A: connection funnel ----------
//
//   CONN steamid=<id64> stage=connect|ingame|team|ready|drop t=<unix s> map=<map> [team=<2|3>] [pre=<0|1> secs=<n>] [reason=<rest of line>]
//   MAPLOAD map=<map> t=<unix s>
//
// connect is the network connect (once per real connection, not per map);
// ingame, team and ready are once per map; drop is a real disconnect, with
// pre=1 when the player never got in game on this map (dropped while
// loading) and the engine's reason string LAST, because a client can write
// its own disconnect reason. The site decides what a reason means, and which
// maps are L4D2 ports; this only reports.

/** OnMapStart, after g_sCurrentMap is set. */
void DataFeeds_MapStart()
{
	for (int c = 0; c <= MAXPLAYERS; c++)
	{
		g_bDfInGame[c] = false;
		g_bDfTeamSent[c] = false;
		g_bDfReadySent[c] = false;
	}
	EmitPug("MAPLOAD map=%s t=%d", g_sCurrentMap, GetTime());
}

/** Roster slot for a SteamID64 or STEAM_X:Y:Z string, or -1. */
static int DfSlotOfNetworkId(const char[] networkid)
{
	char id[32];
	if (StrContains(networkid, "STEAM_") == 0)
	{
		if (!ModCall_Steam2To64(networkid, id, sizeof(id))) return -1;
	}
	else strcopy(id, sizeof(id), networkid);
	if (strlen(id) != 17) return -1;
	return RosterIndexOfId(id);
}

/** The funnel's slot for a client: the one player_connect named, else asked
 *  now (unvalidated is fine for a timestamp). */
static int DfConnSlot(int client)
{
	if (client < 1 || client > MaxClients) return -1;
	if (g_iDfConnSlot[client] >= 0) return g_iDfConnSlot[client];
	if (!IsClientConnected(client) || IsFakeClient(client)) return -1;
	char id[32];
	if (!ModCall_AuthId(client, id, sizeof(id)) && !GetClientAuthId(client, AuthId_SteamID64, id, sizeof(id), false)) return -1;
	int slot = RosterIndexOfId(id);
	g_iDfConnSlot[client] = slot;
	return slot;
}

public void DataFeeds_PlayerConnect(Event event, const char[] name, bool dontBroadcast)
{
	if (g_State == MS_None || event.GetBool("bot")) return;
	int client = event.GetInt("index") + 1;
	char networkid[64];
	event.GetString("networkid", networkid, sizeof(networkid));
	int slot = DfSlotOfNetworkId(networkid);
	if (client >= 1 && client <= MaxClients)
	{
		g_iDfConnSlot[client] = slot;
		g_bDfInGame[client] = false;
		g_bDfTeamSent[client] = false;
		g_bDfReadySent[client] = false;
	}
	if (slot < 0) return;
	EmitPug("CONN steamid=%s stage=connect t=%d map=%s", g_sRosterId[slot], GetTime(), g_sCurrentMap);
}

public void DataFeeds_PlayerActivate(Event event, const char[] name, bool dontBroadcast)
{
	if (g_State == MS_None) return;
	int client = GetClientOfUserId(event.GetInt("userid"));
	if (client < 1 || client > MaxClients || IsFakeClient(client) || g_bDfInGame[client]) return;
	g_bDfInGame[client] = true;
	int slot = DfConnSlot(client);
	if (slot < 0) return;
	EmitPug("CONN steamid=%s stage=ingame t=%d map=%s", g_sRosterId[slot], GetTime(), g_sCurrentMap);
}

public void DataFeeds_PlayerTeam(Event event, const char[] name, bool dontBroadcast)
{
	if (g_State == MS_None || event.GetBool("disconnect")) return;
	int team = event.GetInt("team");
	if (team != TEAM_SURVIVOR && team != TEAM_INFECTED) return;
	int client = GetClientOfUserId(event.GetInt("userid"));
	if (client < 1 || client > MaxClients || IsFakeClient(client) || g_bDfTeamSent[client]) return;
	int slot = DfConnSlot(client);
	if (slot < 0) return;
	g_bDfTeamSent[client] = true;
	EmitPug("CONN steamid=%s stage=team t=%d map=%s team=%d", g_sRosterId[slot], GetTime(), g_sCurrentMap, team);
}

public Action DataFeeds_PlayerDisconnect(Event event, const char[] name, bool dontBroadcast)
{
	if (g_State == MS_None || event.GetBool("bot")) return Plugin_Continue;
	int client = GetClientOfUserId(event.GetInt("userid"));
	int slot = -1;
	if (client >= 1 && client <= MaxClients) slot = DfConnSlot(client);
	if (slot < 0)
	{
		char networkid[64];
		event.GetString("networkid", networkid, sizeof(networkid));
		slot = DfSlotOfNetworkId(networkid);
	}
	bool inGame = client >= 1 && client <= MaxClients && g_bDfInGame[client];
	int secs = (client >= 1 && client <= MaxClients && IsClientConnected(client)) ? RoundToFloor(GetClientTime(client)) : -1;
	if (client >= 1 && client <= MaxClients)
	{
		g_iDfConnSlot[client] = -1;
		g_bDfInGame[client] = false;
		g_bDfTeamSent[client] = false;
		g_bDfReadySent[client] = false;
		// An SI life cannot outlive its player.
		if (g_iDfOpen[client] != -1 && StatsActive()) DfCloseLife(client, DFE_DISC, -1);
	}
	if (slot < 0) return Plugin_Continue;
	char reason[128];
	event.GetString("reason", reason, sizeof(reason));
	SanitizeChat(reason, sizeof(reason));
	EmitPug("CONN steamid=%s stage=drop t=%d map=%s pre=%d secs=%d reason=%s",
		g_sRosterId[slot], GetTime(), g_sCurrentMap, inGame ? 0 : 1, secs, reason);
	return Plugin_Continue;
}

/** Once a second: the first ready of each rostered player per map, an SI
 *  life whose player left the infected team, and survivor flow readings so a
 *  death has a last known value. */
public Action Timer_DataFeeds(Handle timer)
{
	if (g_State == MS_None) return Plugin_Continue;
#if defined DF_TEST
	DfTestBindBots();
#endif
	bool canReady = InReadyUp() && GetFeatureStatus(FeatureType_Native, "IsReady") == FeatureStatus_Available;
	for (int c = 1; c <= MaxClients; c++)
	{
		if (!IsClientInGame(c)) continue;
		int team = GetClientTeam(c);
		if (team == TEAM_SURVIVOR && IsPlayerAlive(c) && g_State == MS_Live) DfFlow(c);
		if (g_iDfOpen[c] != -1 && team != TEAM_INFECTED && StatsActive()) DfCloseLife(c, DFE_TEAM, -1);
		if (!canReady || IsFakeClient(c) || g_bDfReadySent[c]) continue;
		if (team != TEAM_SURVIVOR && team != TEAM_INFECTED) continue;
		int slot = DfConnSlot(c);
		if (slot < 0 || !IsReady(c)) continue;
		g_bDfReadySent[c] = true;
		EmitPug("CONN steamid=%s stage=ready t=%d map=%s", g_sRosterId[slot], GetTime(), g_sCurrentMap);
	}
	return Plugin_Continue;
}

public Action Cmd_DfStatus(int args)
{
	PrintToServer("datafeeds: state=%s half=%d t=%d lives=%d dropped=%d prog=%d", StateName(g_State), g_iHalf, RoundMs(), g_iDfLives, g_iDfLivesDropped, DfProg());
	for (int c = 1; c <= MaxClients; c++)
	{
		if (!IsClientInGame(c)) continue;
		PrintToServer("  client %d %N team=%d slot=%d conn=%d ingame=%d team_sent=%d ready_sent=%d open=%d last=%d flow=%d incap=%d",
			c, c, GetClientTeam(c), DfSlot(c), g_iDfConnSlot[c], g_bDfInGame[c], g_bDfTeamSent[c], g_bDfReadySent[c],
			g_iDfOpen[c], g_iDfLast[c], DfFlow(c), g_bDfIncapped[c]);
	}
	return Plugin_Handled;
}

#if defined DF_TEST
/** Test builds only (./build.sh with DF_TEST=1): give every bot on a team a
 *  free roster slot, so the rig can drive EVENT, DOWN and SILIFE with bots.
 *  Never in a production build: bots are not players. */
static void DfTestBindBots()
{
	for (int c = 1; c <= MaxClients; c++)
	{
		if (!IsClientInGame(c) || !IsFakeClient(c) || g_iClientRoster[c] != -1) continue;
		int team = GetClientTeam(c);
		if (team != TEAM_SURVIVOR && team != TEAM_INFECTED) continue;
		for (int s = 0; s < g_iRosterCount; s++)
		{
			if (ClientOfSlot(s) != -1) continue;
			g_iClientRoster[c] = s;
			break;
		}
	}
}
#endif
