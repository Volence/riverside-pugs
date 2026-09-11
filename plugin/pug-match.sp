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
#define ZC_BOOMER 2
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

// In-game names, captured at roster time. Only populated for self-started
// matches (!load_4v4p): the backend needs a display name for SteamID64s the
// site has never seen, and taking it from the game avoids depending on a Steam
// Web API key. Backend-driven matches leave these empty; the site already knows
// those players.
char g_sRosterName[MAX_ROSTER][64];

/** True when this match was started in-game by !load_4v4p rather than by the
 *  backend over rcon. Two behavioural differences, both deliberate:
 *    - the match id is 0 until the backend assigns one via sm_pug_setid
 *    - OnClientPostAdminCheck does NOT kick non-rostered players
 *  The kick exists to enforce a backend-issued roster for a real ranked PUG.
 *  A match started from inside a running game has no such authority, and
 *  kicking a friend who happened to be spectating would be a nasty surprise. */
bool g_bSelfStarted;

/** Monotonic per-match counter stamped on every EVENT line. UDP can deliver
 *  the same datagram twice, and an event feed that double-counts a deadly
 *  pounce is worse than no feed, so the backend keys on (match, seq) and an
 *  arriving duplicate is simply an upsert over itself. */
int g_iEventSeq;

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
int g_iRound1SurvPug;                    // pug team (1|2) that played survivors in half 1; 0 = unknown
int g_iHalf;                             // 1 or 2 within the current map; 0 = not live
float g_fRoundLiveAt;                    // GetGameTime() when this half went live; 0 = not live
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

// Who currently has each survivor pinned, as a client index; 0 = free.
// Needed because a "cleared" event has to name the survivor who did the
// clearing, which is not carried by any release event.
int g_iPinnedBy[MAXPLAYERS + 1];

bool g_bReadyUpAvailable;

/** Boomer attribution, mirroring l4dcompstats.sp so the numbers on the site
 *  match the ones already printed in console and nobody has to reconcile two
 *  slightly different definitions of "boomer success".
 *
 *  g_iBoomerClient is the HUMAN who spawned the current boomer, kept even if
 *  that boomer later goes AI, because the boom is their doing. g_bHasBoomLanded
 *  makes a success once-per-life rather than once-per-survivor, which is what
 *  makes successes/attempts a meaningful ratio. */
int g_iBoomerClient;
bool g_bHasBoomLanded;

// Included here, after MAX_ROSTER and the roster globals above are declared:
// pug-stats.inc consumes them directly (array sizes and global-variable
// references are resolved by textual/declaration order, unlike function
// calls), so the include must sit below them.
#include "pug-stats.inc"

// Staging knobs. Both default to production behaviour; they exist so the plugin
// can be exercised on a test instance without eight people in the server.
ConVar g_cvMinOrient;                    // rostered players needed to move the orientation mapping
ConVar g_cvDebug;                        // 1 = verbose state logging to the SourceMod log
ConVar g_cvPugConfig;                    // config !load_4v4p execs
ConVar g_cvRecordDemos;                  // 1 = record a named demo per map during a match

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
	RegServerCmd("sm_pug_status", Cmd_Status, "sm_pug_status - current plugin state, for debugging");
	RegServerCmd("sm_pug_setid", Cmd_SetId, "sm_pug_setid <token> <matchid> - backend assigns the match id for a self-started match");

	// The in-game entry point. RegAdminCmd, not RegServerCmd: this one is meant
	// to be typed as !load_4v4p in chat, which server commands cannot be.
	RegAdminCmd("sm_load_4v4p", Cmd_LoadPug, ADMFLAG_CHANGEMAP,
		"Start a PUG match from in-game: snapshot whoever is connected, load the pug ruleset, record a demo.");
	RegAdminCmd("sm_endpug", Cmd_EndPug, ADMFLAG_CHANGEMAP,
		"End the running match now and report it, without playing the finale.");

	g_cvMinOrient = CreateConVar("sm_pug_min_orient", "3",
		"Rostered players that must agree before the pug-team<->side mapping moves. \
Production value is 3. Set to 1 on a test instance to drive a match solo.",
		FCVAR_NOTIFY, true, 1.0, true, 8.0);
	g_cvDebug = CreateConVar("sm_pug_debug", "0",
		"1 = log orientation flips, team-lock moves, score reads and state changes to the SourceMod log.",
		FCVAR_NOTIFY, true, 0.0, true, 1.0);
	g_cvPugConfig = CreateConVar("sm_pug_config", "pug_match.cfg",
		"Config !load_4v4p execs. pug_match.cfg is the full ranked setup: it execs the pinned \
ruleset (rotoblin_pug_4v4.cfg), loads skill_detect as a data source, and restores the production \
orientation threshold. Changing this changes the rules under every rating earned from here on.",
		FCVAR_NOTIFY);
	g_cvRecordDemos = CreateConVar("sm_pug_record_demos", "1",
		"1 = stop autorecord and record a named pug_<token>_<ordinal>_<map> demo for each map of a match.",
		FCVAR_NOTIFY, true, 0.0, true, 1.0);

	HookEvent("round_start", Event_RoundStart);
	HookEvent("round_end", Event_RoundEnd);
	HookEvent("player_hurt", Event_PlayerHurt);
	HookEvent("player_death", Event_PlayerDeath);
	HookEvent("infected_death", Event_InfectedDeath);
	HookEvent("revive_success", Event_ReviveSuccess);
	HookEvent("player_spawn", Event_PlayerSpawn);
	HookEvent("player_now_it", Event_PlayerBoomed);

	// Names verified against l4d2_skill_detect.sp and the Rotoblin-AZMod
	// plugins, both proven running on L4D1 in this deployment. Note
	// player_incapacitated_START: the bare player_incapacitated does not
	// fire on this engine.
	//
	// These use HookEventEx, not HookEvent, on purpose. L4D1 defines some
	// events partly inside VPK archives, so we cannot fully confirm from the
	// filesystem alone that every name below exists on this engine (see, for
	// example, triggered_car_alarm, which l4d2_skill_detect.sp itself only
	// hooks behind an L4D2 version check). HookEvent raises a native error
	// for an unknown event, and inside OnPluginStart that error aborts the
	// whole plugin load, taking roster enforcement, scoring and reporting
	// down with it for one missing telemetry stream. HookEventEx instead
	// returns false, so a missing event costs only that one capture feed.
	// The block above this one hooks events already proven live in
	// production and stays on plain HookEvent; do not move those down here.
	if (!HookEventEx("lunge_pounce", Event_Pounce))
		LogMessage("pug-match: event 'lunge_pounce' does not exist on this engine; pinned/cleared capture for pounces will be silently absent.");
	if (!HookEventEx("tongue_grab", Event_TongueGrab))
		LogMessage("pug-match: event 'tongue_grab' does not exist on this engine; pinned capture for tongue grabs will be silently absent.");
	if (!HookEventEx("tongue_release", Event_TongueRelease))
		LogMessage("pug-match: event 'tongue_release' does not exist on this engine; pin-clear capture for tongue releases will be silently absent.");
	if (!HookEventEx("player_incapacitated_start", Event_Incap))
		LogMessage("pug-match: event 'player_incapacitated_start' does not exist on this engine; incap capture will be silently absent.");
	if (!HookEventEx("witch_harasser_set", Event_WitchAggro))
		LogMessage("pug-match: event 'witch_harasser_set' does not exist on this engine; witch_aggro capture will be silently absent.");
	if (!HookEventEx("witch_killed", Event_WitchKilled))
		LogMessage("pug-match: event 'witch_killed' does not exist on this engine; witch_killed capture will be silently absent.");
	if (!HookEventEx("triggered_car_alarm", Event_CarAlarm))
		LogMessage("pug-match: event 'triggered_car_alarm' does not exist on this engine; car_alarm capture will be silently absent.");
	if (!HookEventEx("tank_spawn", Event_TankSpawn))
		LogMessage("pug-match: event 'tank_spawn' does not exist on this engine; tank_spawn capture will be silently absent.");
	// Tank control passing goes through a bot swap on this engine: a human
	// losing the tank fires player_bot_replace, a human taking over a bot
	// tank fires bot_player_replace. Verified against l4d_tank_pass.sp and
	// l4dscores.sp; there is no bare "player_replace" event on this engine.
	if (!HookEventEx("player_bot_replace", Event_PlayerBotReplace))
		LogMessage("pug-match: event 'player_bot_replace' does not exist on this engine; tank_pass capture (human giving up tank) will be silently absent.");
	if (!HookEventEx("bot_player_replace", Event_BotPlayerReplace))
		LogMessage("pug-match: event 'bot_player_replace' does not exist on this engine; tank_pass capture (human taking tank) will be silently absent.");

	// Persistent repeating timers (no TIMER_FLAG_NO_MAPCHANGE, since they must survive changelevel).
	CreateTimer(30.0, Timer_Heartbeat, _, TIMER_REPEAT);
	CreateTimer(2.0, Timer_TeamLock, _, TIMER_REPEAT);
	// Faster than the heartbeat on purpose: the heartbeat is a liveness signal
	// whose 30s period defines the backend's staleness window, while this is a
	// spectator refresh where 30s feels dead. Separate timers so neither
	// constrains the other.
	CreateTimer(10.0, Timer_LiveStats, _, TIMER_REPEAT);

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
	// 768, not 480: the LIVESTAT line carries ~20 keys and grew past the old
	// buffer's comfort margin. Truncation here is SILENT and would drop
	// trailing stats, which is the same failure WriteSkillLines was bitten by.
	char body[768];
	VFormat(body, sizeof(body), fmt, 2);
	LogToGame("PUG %s %s", g_sToken, body);
}

/** Which pug team is on the survivor side right now, as "a"/"b", or "" when
 *  the orientation mapping has not settled. g_iPugSide[1] is the GAME team of
 *  pug team a; TEAM_SURVIVOR is 2. */
void SurvPugTeam(char[] out, int maxlen)
{
	if (g_iPugSide[1] == TEAM_SURVIVOR) strcopy(out, maxlen, "a");
	else if (g_iPugSide[2] == TEAM_SURVIVOR) strcopy(out, maxlen, "b");
	else out[0] = '\0';
}

/** Milliseconds since this half went live. -1 before it does, which the
 *  parser treats as "no round timing", distinct from 0. */
int RoundMs()
{
	if (g_fRoundLiveAt <= 0.0) return -1;
	return RoundToNearest((GetGameTime() - g_fRoundLiveAt) * 1000.0);
}

/** Close out a half: emit ROUND_END (if a side was resolved) and mark the
 *  half no longer live. This is the single exit point for all three
 *  terminal paths of Event_RoundEnd's score read: the synchronous success,
 *  the delayed retry's success, and the retries-exhausted branch. Missing
 *  any one of the three used to leave that half without its authoritative
 *  surv/score/ended_at AND leave g_fRoundLiveAt stuck, which corrupts
 *  RoundMs() for every event of the NEXT half.
 *
 *  `surv` may be empty when the orientation mapping never settled; the
 *  parser only accepts surv=a or surv=b, so an empty side is skipped rather
 *  than emitted malformed. `half` and `surv` must be values CAPTURED at
 *  round_end time, not read fresh from g_iHalf/g_iPugSide here: this is
 *  called from a timer up to 6-8s after the round ended, and by then
 *  FinalizeMap may have reset g_iHalf to 0 for the next half, or the team
 *  lock timer may have flipped g_iPugSide. */
void EmitRoundEnd(int half, const char[] surv, int score)
{
	if (surv[0] != '\0')
	{
		EmitPug("ROUND_END half=%d surv=%s score=%d", half, surv, score);
	}
	g_fRoundLiveAt = 0.0;
}

/** One discrete thing that happened, for the live feed and the timeline.
 *
 *  Deliberately generic (kind/actor/target/value) rather than a line type per
 *  event: the backend stores it opaquely and the page renders by kind, so
 *  adding another kind later is a plugin-only change. Cosmetic like the rest
 *  of the UDP stream; the authoritative per-player totals still come from the
 *  dump. target may be 0 for events with no second party. half/t ride along
 *  so the viewer can align events against replay frames without a clock.
 *
 *  `kind` MUST exist in src/eventKinds.ts. tests/eventKindsParity.test.ts
 *  enforces that. */
void EmitEvent(const char[] kind, int actor, int target, int value)
{
	if (g_State != MS_Live) return;
	if (actor < 1 || actor > MaxClients || g_iClientRoster[actor] == -1) return;

	char actorId[32], targetId[32];
	strcopy(actorId, sizeof(actorId), g_sRosterId[g_iClientRoster[actor]]);
	targetId[0] = '\0';
	if (target >= 1 && target <= MaxClients && g_iClientRoster[target] != -1)
		strcopy(targetId, sizeof(targetId), g_sRosterId[g_iClientRoster[target]]);

	g_iEventSeq++;
	EmitPug("EVENT seq=%d kind=%s actor=%s target=%s value=%d half=%d t=%d",
		g_iEventSeq, kind, actorId, targetId[0] == '\0' ? "0" : targetId, value, g_iHalf, RoundMs());
}

/** Emit with actor/target as client indices, gated on StatsActive() so
 *  nothing fires between rounds or during ready-up (the same gate the "dp"
 *  emission in pug-stats.inc already uses). EmitEvent itself resolves
 *  actor/target to roster ids and silently drops anything whose actor is not
 *  rostered, so an unrostered spectator or admin can never appear in the
 *  feed. */
void EmitClientEvent(const char[] kind, int actor, int target, int value)
{
	if (!StatsActive()) return;
	EmitEvent(kind, actor, target, value);
}

/** Verbose diagnostic, off by default. Goes to the SourceMod log rather than
 *  the logaddress stream on purpose: the UDP grammar is parsed by the backend
 *  (src/logParse.ts) and free-text debug lines there would be noise at best and
 *  mis-parses at worst. Read these with
 *  `tail -f addons/sourcemod/logs/L<date>.log` on the box. */
void PugDebug(const char[] fmt, any ...)
{
	if (!g_cvDebug.BoolValue) return;
	char line[480];
	VFormat(line, sizeof(line), fmt, 2);
	LogMessage("[pug] %s", line);
}

/** Authoritative dump line into the RCON response body of the running server cmd.
 *
 *  1024, not 480: a full 26-key SKILL line (pug-stats.inc's WriteSkillLines) can
 *  run past 480 once several stats hit multi-digit values, and the backend
 *  parser ignores unknown/missing keys by design, so a line truncated here
 *  would silently drop stats rather than error anywhere. */
void DumpLine(const char[] fmt, any ...)
{
	char line[1024];
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

// ---------- in-game entry point ----------

/** !load_4v4p: start a match from inside the game.
 *
 *  The backend cannot do this for us. comp_loader's sm_match/sm_load bail on
 *  `client == 0` so they are unreachable from rcon, and a match started from
 *  the website needs eight people who have already signed up there. This is the
 *  path for "we are all here already, let's play a ranked one".
 *
 *  Teams come from where people are standing right now: survivors become pug
 *  team a, infected become pug team b, which matches the backend's convention
 *  that team a starts as survivors on map 1. */
public Action Cmd_LoadPug(int client, int args)
{
	if (g_State != MS_None)
	{
		ReplyToCommand(client, "[PUG] A match is already configured (state %s). Run sm_pug_abort first.",
			StateName(g_State));
		return Plugin_Handled;
	}

	// Count before touching any state, so an over-full server fails cleanly
	// rather than half-rostering and then bailing.
	int onTeams = 0, spectating = 0;
	for (int i = 1; i <= MaxClients; i++)
	{
		if (!IsClientInGame(i) || IsFakeClient(i)) continue;
		int team = GetClientTeam(i);
		if (team == TEAM_SURVIVOR || team == TEAM_INFECTED) onTeams++;
		else spectating++;
	}
	if (onTeams == 0)
	{
		ReplyToCommand(client, "[PUG] Nobody is on a team. Join survivors or infected first.");
		return Plugin_Handled;
	}
	if (onTeams > MAX_ROSTER)
	{
		ReplyToCommand(client, "[PUG] %d players on teams, max is %d. Move the extras to spectator.",
			onTeams, MAX_ROSTER);
		return Plugin_Handled;
	}

	ResetMatchState();
	g_bSelfStarted = true;
	g_iMatchId = 0;                  // the backend owns match ids; assigned later via sm_pug_setid
	GenerateToken(g_sToken, sizeof(g_sToken));
	GetCurrentMap(g_sCurrentMap, sizeof(g_sCurrentMap));
	// The backend derives the campaign from the map name; the plugin has no
	// campaign table and does not need one.
	strcopy(g_sCampaign, sizeof(g_sCampaign), g_sCurrentMap);

	for (int i = 1; i <= MaxClients; i++)
	{
		if (!IsClientInGame(i) || IsFakeClient(i)) continue;
		int team = GetClientTeam(i);
		if (team != TEAM_SURVIVOR && team != TEAM_INFECTED) continue;
		char id[32];
		if (!GetClientAuthId(i, AuthId_SteamID64, id, sizeof(id)))
		{
			// No kick here: an unauthenticated client just goes unscored.
			PugDebug("load: could not auth %N, leaving unrostered", i);
			continue;
		}
		int slot = g_iRosterCount++;
		strcopy(g_sRosterId[slot], 32, id);
		g_iRosterTeam[slot] = (team == TEAM_SURVIVOR) ? 1 : 2;
		SanitizeName(i, g_sRosterName[slot], 64);
		g_iClientRoster[i] = slot;
	}

	g_State = MS_Pending;
	g_iPugSide[1] = TEAM_SURVIVOR;
	g_iPugSide[2] = TEAM_INFECTED;

	// Announce before the exec: the config ends in sm_restartmap, so clients are
	// about to cycle. The backend needs the roster in hand before that happens.
	EmitPug("MATCH_CREATE map=%s players=%d", g_sCurrentMap, g_iRosterCount);
	for (int i = 0; i < g_iRosterCount; i++)
	{
		// name= is deliberately LAST on the line: in-game names contain spaces,
		// so the backend parser takes the entire remainder as the name.
		EmitPug("MATCH_ROSTER steamid=%s team=%s name=%s",
			g_sRosterId[i], g_iRosterTeam[i] == 1 ? "a" : "b", g_sRosterName[i]);
	}
	EmitPug("MATCH_CREATE_END players=%d", g_iRosterCount);

	StartMatchDemo();

	char cfg[64];
	g_cvPugConfig.GetString(cfg, sizeof(cfg));
	PugDebug("self-started match token=%s roster=%d cfg=%s", g_sToken, g_iRosterCount, cfg);
	ServerCommand("exec %s", cfg);

	PrintToChatAll("[PUG] Match starting: %d players. Ready up.", g_iRosterCount);
	if (spectating > 0)
	{
		ReplyToCommand(client, "[PUG] %d spectator(s) were not rostered and will not be scored.", spectating);
	}
	return Plugin_Handled;
}

/** !endpug: finish the match here, without loading the finale.
 *
 *  The normal trigger is OnMapStart seeing the finale map load, because a
 *  match is defined as a campaign minus its finale. But in practice nobody
 *  plays the finale: people finish the last normal map and change level, and
 *  that path fires nothing at all, leaving the match live until the backend
 *  reaps it as orphaned ten minutes later with no result recorded.
 *
 *  Mirrors the finale branch exactly, including the pending-finalize failsafe,
 *  so a match ended this way is indistinguishable from one that ran into the
 *  finale. */
public Action Cmd_EndPug(int client, int args)
{
	if (g_State != MS_Live)
	{
		ReplyToCommand(client, "[PUG] No live match to end (state %s).", StateName(g_State));
		return Plugin_Handled;
	}

	// Same failsafe as OnMapStart: a 2nd-half round_end may have set this and
	// the delayed score read may still be in flight. Finalize first so the map
	// being played cannot vanish from the totals.
	if (g_bPendingFinalize) FinalizeMap();

	g_State = MS_Ended;
	int a, b;
	TotalScores(a, b);
	char winner[8];
	WinnerOf(a, b, winner, sizeof(winner));
	EmitPug("MATCH_END a=%d b=%d winner=%s", a, b, winner);
	PugDebug("ended by !endpug: a=%d b=%d winner=%s", a, b, winner);
	PrintToChatAll("[PUG] Match ended: %d - %d. Reporting to the site.", a, b);
	return Plugin_Handled;
}

/** Backend hands back the match id it allocated for a self-started match.
 *  Keyed by token, because the id is precisely what the plugin does not know
 *  yet and so cannot be asked for. */
public Action Cmd_SetId(int args)
{
	if (args < 2)
	{
		PrintToServer("PUGERR usage: sm_pug_setid <token> <matchid>");
		return Plugin_Handled;
	}
	char tok[65];
	GetCmdArg(1, tok, sizeof(tok));
	if (g_State == MS_None || !StrEqual(tok, g_sToken))
	{
		PrintToServer("PUGERR bad token");
		return Plugin_Handled;
	}
	char buf[32];
	GetCmdArg(2, buf, sizeof(buf));
	int id = StringToInt(buf);
	if (id <= 0)
	{
		PrintToServer("PUGERR bad matchid");
		return Plugin_Handled;
	}
	g_iMatchId = id;
	PrintToServer("PUGOK match=%d", g_iMatchId);
	return Plugin_Handled;
}

/** 32 lowercase hex chars. The length is NOT arbitrary: the backend's parser
 *  pins tokens to /^[0-9a-f]{32}$/ (src/logParse.ts), so a shorter token would
 *  make every line we emit silently unparseable. Unguessability is secondary
 *  here, since the backend also pins the source address. */
void GenerateToken(char[] out, int maxlen)
{
	char hex[17] = "0123456789abcdef";
	int n = 32;
	if (n > maxlen - 1) n = maxlen - 1;
	for (int i = 0; i < n; i++) out[i] = hex[GetRandomInt(0, 15)];
	out[n] = '\0';
}

/** In-game name, with anything that would corrupt a log line removed. Names are
 *  emitted last on their line so spaces are safe, but control characters are
 *  not, and an over-long name would push the line past the LogToGame buffer. */
void SanitizeName(int client, char[] out, int maxlen)
{
	char raw[128];
	if (!GetClientName(client, raw, sizeof(raw)))
	{
		strcopy(out, maxlen, "unknown");
		return;
	}
	int w = 0;
	for (int i = 0; raw[i] != '\0' && w < maxlen - 1; i++)
	{
		if (raw[i] >= 32 && raw[i] != 127) out[w++] = raw[i];
	}
	out[w] = '\0';
	if (w == 0) strcopy(out, maxlen, "unknown");
}

/** Record this map of the match to a demo named after the match.
 *
 *  tv_autorecord almost certainly already has a file open for this map, and a
 *  second tv_record would simply be refused, so stop first. tv_stoprecord is
 *  harmless when nothing is recording. The resulting pug_* name is what links
 *  the demo to its match, rather than guessing from timestamps, and is also
 *  what the prune cron keys on to retain match demos longer than autorecords. */
void StartMatchDemo()
{
	if (!g_cvRecordDemos.BoolValue || g_State == MS_None) return;
	ServerCommand("tv_stoprecord");
	ServerCommand("tv_record pug_%s_%d_%s", g_sToken, g_iMapCount, g_sCurrentMap);
	PugDebug("demo: pug_%s_%d_%s", g_sToken, g_iMapCount, g_sCurrentMap);
}

public Action Cmd_Abort(int args)
{
	if (!TokenArgOk(args)) return Plugin_Handled;
	if (g_cvRecordDemos.BoolValue && g_State != MS_None) ServerCommand("tv_stoprecord");
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

/** Full current state over the RCON response body. Takes no token, because the
 *  moment you most want it is when the match did NOT set up the way you expected
 *  and you do not trust your own idea of what the token is.
 *
 *  This is the "what does the plugin actually think right now" command: state,
 *  roster with live connection and side, the orientation mapping and the vote
 *  that produced it, per-map results so far, and the pending-finalize flag. */
public Action Cmd_Status(int args)
{
	DumpLine("STATUS state=%s match=%d token=%s campaign=%s map=%s",
		StateName(g_State), g_iMatchId,
		g_sToken[0] == '\0' ? "(none)" : g_sToken,
		g_sCampaign[0] == '\0' ? "(none)" : g_sCampaign,
		g_sCurrentMap);
	DumpLine("STATUS orient a=%s b=%s round1Logical=%d round1SurvPug=%d minOrient=%d debug=%d",
		SideName(g_iPugSide[1]), SideName(g_iPugSide[2]),
		g_iRound1Logical, g_iRound1SurvPug, g_cvMinOrient.IntValue, g_cvDebug.IntValue);
	DumpLine("STATUS half a=%d b=%d pendingFinalize=%d readyup=%d",
		g_iHalfScoreA, g_iHalfScoreB, g_bPendingFinalize ? 1 : 0, g_bReadyUpAvailable ? 1 : 0);
	DumpLine("STATUS selfStarted=%d enforceRoster=%d recordDemos=%d",
		g_bSelfStarted ? 1 : 0, g_bSelfStarted ? 0 : 1, g_cvRecordDemos.BoolValue ? 1 : 0);

	int straight, inverted;
	OrientationVote(straight, inverted);
	DumpLine("STATUS vote straight=%d inverted=%d", straight, inverted);

	for (int i = 0; i < g_iRosterCount; i++)
	{
		int client = ClientOfSlot(i);
		DumpLine("STATUS roster slot=%d steamid=%s team=%s connected=%d side=%s name=%s",
			i, g_sRosterId[i], g_iRosterTeam[i] == 1 ? "a" : "b",
			client != -1 ? 1 : 0,
			client != -1 ? SideName(GetClientTeam(client)) : "-",
			client != -1 ? NameOf(client) : "-");
	}
	for (int i = 0; i < g_iMapCount; i++)
	{
		DumpLine("STATUS map ordinal=%d map=%s a=%d b=%d", i, g_sMapName[i], g_iMapScoreA[i], g_iMapScoreB[i]);
	}
	DumpLine("STATUS end");
	return Plugin_Handled;
}

char[] NameOf(int client)
{
	char n[MAX_NAME_LENGTH];
	GetClientName(client, n, sizeof(n));
	return n;
}

/** Roster slot -> in-game client, or -1 if that player is not connected. */
int ClientOfSlot(int slot)
{
	for (int c = 1; c <= MaxClients; c++)
	{
		if (IsClientInGame(c) && g_iClientRoster[c] == slot) return c;
	}
	return -1;
}

char[] StateName(MatchState st)
{
	char out[16];
	switch (st)
	{
		case MS_None:    strcopy(out, sizeof(out), "none");
		case MS_Pending: strcopy(out, sizeof(out), "pending");
		case MS_Live:    strcopy(out, sizeof(out), "live");
		case MS_Ended:   strcopy(out, sizeof(out), "ended");
		default:         strcopy(out, sizeof(out), "?");
	}
	return out;
}

char[] SideName(int gameTeam)
{
	char out[16];
	switch (gameTeam)
	{
		case TEAM_SURVIVOR: strcopy(out, sizeof(out), "survivor");
		case TEAM_INFECTED: strcopy(out, sizeof(out), "infected");
		case TEAM_SPEC:     strcopy(out, sizeof(out), "spectator");
		default:            strcopy(out, sizeof(out), "unknown");
	}
	return out;
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
	g_bSelfStarted = false;
	g_iEventSeq = 0;
	g_iBoomerClient = 0;
	g_bHasBoomLanded = false;
	g_iMapCount = 0;
	g_iHalfScoreA = 0;
	g_iHalfScoreB = 0;
	g_iRound1Logical = 0;
	g_iRound1SurvPug = 0;
	g_iHalf = 0;
	g_fRoundLiveAt = 0.0;
	g_bRoundEnded = false;
	g_bHalfWasLive = false;
	g_bPendingFinalize = false;
	g_iPugSide[1] = 0;
	g_iPugSide[2] = 0;
	for (int i = 0; i < MAX_ROSTER; i++)
	{
		g_sRosterId[i][0] = '\0';
		g_sRosterName[i][0] = '\0';
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
		g_iPinnedBy[i] = 0;
	}
	ResetSkillStats();
}

public Action Timer_Heartbeat(Handle timer)
{
	if (g_State != MS_None) EmitPug("HEARTBEAT");
	return Plugin_Continue;
}

/** Per-player counters for the spectator view, emitted while a match is live.
 *
 *  Cosmetic ONLY. These ride the lossy UDP feed and are never read back when a
 *  result is computed: the authoritative numbers are the identical counters
 *  pulled over rcon by sm_pug_dump at the end. A dropped datagram therefore
 *  costs a stale web page for a few seconds and nothing else.
 *
 *  A curated subset, not the whole 26-key skill array. EmitPug's buffer is 480
 *  and LogToGame has its own ceiling, so dumping every key here would risk
 *  silent truncation of the kind that already bit WriteSkillLines (see the
 *  1024-byte note in pug-stats.inc). The full set still goes out in the dump. */
public Action Timer_LiveStats(Handle timer)
{
	if (g_State != MS_Live) return Plugin_Continue;

	for (int i = 0; i < g_iRosterCount; i++)
	{
		int client = ClientOfSlot(i);
		// hp is live entity state rather than a counter, so it is read at emit
		// time. -1 means "not applicable": disconnected, or not a survivor.
		int hp = -1;
		if (client != -1 && GetClientTeam(client) == TEAM_SURVIVOR)
			hp = IsPlayerAlive(client) ? GetClientHealth(client) : 0;

		char line[768];
		Format(line, sizeof(line),
			"LIVESTAT steamid=%s hp=%d ck=%d sidmg=%d sikill=%d ff=%d rev=%d",
			g_sRosterId[i], hp,
			g_iStatCk[i], g_iStatSiDmg[i], g_iStatSiKill[i], g_iStatFf[i], g_iStatRev[i]);

		// tank_damage / damage_as_si / tank_punches / boomer_spawns ride
		// pug-match's own hooks,
		// so they are present whether or not skill_detect is loaded. The rest
		// are omitted entirely when it is absent, so "not measured" never
		// reaches the page as a zero.
		Format(line, sizeof(line), "%s tank_damage=%d damage_as_si=%d tank_punches=%d boomer_spawns=%d \
boom_successes=%d boomed_vomit=%d boomed_proxy=%d",
			line, g_iSkill[i][PS_TankDamage], g_iSkill[i][PS_DamageAsSi], g_iSkill[i][PS_TankPunches],
			g_iSkill[i][PS_BoomerSpawns], g_iSkill[i][PS_BoomSuccesses],
			g_iSkill[i][PS_BoomedVomit], g_iSkill[i][PS_BoomedProxy]);

		if (g_bSkillDetect)
		{
			// PS_Skeets is already the solo-skeet total: CountSkeet credits it
			// alongside the weapon-specific key, so summing the weapon columns
			// here would double count.
			// deadstops and tongue_cuts are deliberately NOT sent live: they do
			// not occur in L4D1 play here, so they were fifteen columns of
			// permanent zeros. They are still captured and still go out in the
			// full dump, in case that ever changes.
			Format(line, sizeof(line),
				"%s skeets=%d team_skeets=%d skeets_hurt=%d skeet_assists=%d boomer_pops=%d crowns=%d \
rock_skeets=%d dps_landed=%d biles_landed=%d survivors_biled=%d",
				line, g_iSkill[i][PS_Skeets], g_iSkill[i][PS_TeamSkeets], g_iSkill[i][PS_SkeetsHurt],
				g_iSkill[i][PS_SkeetAssists], g_iSkill[i][PS_BoomerPops], g_iSkill[i][PS_Crowns],
				g_iSkill[i][PS_RockSkeets], g_iSkill[i][PS_DpsLanded],
				g_iSkill[i][PS_BilesLanded], g_iSkill[i][PS_SurvivorsBiled]);
		}

		// Never pass a runtime-built string as a format (same reason as
		// WriteSkillLines): a '%' in it would be read as a conversion.
		EmitPug("%s", line);
	}
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
		// Roster enforcement only applies to a backend-issued roster. A match
		// started in-game with !load_4v4p has no authority to kick anyone, and
		// the config's sm_restartmap cycles every client through here moments
		// after the snapshot, so kicking would eject the spectators who were
		// simply not on a team at snapshot time. They stay, unscored.
		if (g_bSelfStarted) return;
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

/** Count the joint orientation vote from where rostered players actually sit.
 *  `straight` = pug a on survivors, `inverted` = pug a on infected. Shared by the
 *  lock timer and sm_pug_status so the number you read while debugging is the
 *  same number the lock is acting on. */
void OrientationVote(int &straight, int &inverted)
{
	int onSide[3][4]; // [pugTeam][gameTeam] counts; gameTeam index 2|3 used
	for (int c = 1; c <= MaxClients; c++)
	{
		int slot = g_iClientRoster[c];
		if (slot == -1 || !IsClientInGame(c)) continue;
		int gt = GetClientTeam(c);
		if (gt == TEAM_SURVIVOR || gt == TEAM_INFECTED) onSide[g_iRosterTeam[slot]][gt]++;
	}
	straight = onSide[1][TEAM_SURVIVOR] + onSide[2][TEAM_INFECTED];
	inverted = onSide[1][TEAM_INFECTED] + onSide[2][TEAM_SURVIVOR];
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

	int straight, inverted;
	OrientationVote(straight, inverted);
	int need = g_cvMinOrient.IntValue;
	int wasA = g_iPugSide[1];
	if (straight > inverted && straight >= need)
	{
		g_iPugSide[1] = TEAM_SURVIVOR;
		g_iPugSide[2] = TEAM_INFECTED;
	}
	else if (inverted > straight && inverted >= need)
	{
		g_iPugSide[1] = TEAM_INFECTED;
		g_iPugSide[2] = TEAM_SURVIVOR;
	}
	if (g_iPugSide[1] != wasA)
	{
		PugDebug("orientation -> a=%s (straight=%d inverted=%d need=%d)",
			g_iPugSide[1] == TEAM_SURVIVOR ? "survivor" : "infected", straight, inverted, need);
	}

	// Blind vote: no rostered player is on survivor OR infected right now. That is
	// the map-transition window, where clients have reconnected and passed the
	// admin check (so the loop below sees them as rostered and in game) but the
	// engine has not yet put them on a side. g_iPugSide still holds the PREVIOUS
	// half's mapping, which is inverted for the new map, so enforcing it here
	// drags people to the wrong side until the next tick corrects it. Observed
	// 2026-09-06 19:48:41, one tick after the reconnect at 19:48:41.
	//
	// Declining is safe rather than deadlocky: a player on no team is exactly the
	// one we must not move, and once the engine assigns anyone the vote sees them
	// and enforcement resumes. Deliberately narrower than "wait for the vote to
	// reach need": with all rostered players auto-assigned to one side the joint
	// vote ties at straight == inverted, so gating on confirmation would stall
	// enforcement forever.
	if (straight == 0 && inverted == 0) return Plugin_Continue;

	for (int c = 1; c <= MaxClients; c++)
	{
		int slot = g_iClientRoster[c];
		if (slot == -1 || !IsClientInGame(c)) continue;
		int want = g_iPugSide[g_iRosterTeam[slot]];
		if (want == 0) continue;
		int have = GetClientTeam(c);
		if (have == want) { g_iLockAttempts[c] = 0; continue; }
		if (g_iLockAttempts[c] >= LOCK_ATTEMPT_CAP)
		{
			PugDebug("lock giving up on %N after %d attempts (want %d, have %d)",
				c, LOCK_ATTEMPT_CAP, want, have);
			continue;
		}
		g_iLockAttempts[c]++;
		PugDebug("lock moving %N to %s (attempt %d)",
			c, want == TEAM_SURVIVOR ? "survivor" : "infected", g_iLockAttempts[c]);
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
	g_iRound1SurvPug = 0;
	g_bRoundEnded = false;
	g_bHalfWasLive = false;

	// New map of a running match: autorecord has just opened its own file for
	// this map, so replace it with a match-named one. Ordinal is g_iMapCount,
	// which FinalizeMap has already advanced for every completed map, so the
	// demo ordinal lines up with the map ordinal in the dump.
	if (g_State == MS_Pending || g_State == MS_Live) StartMatchDemo();

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
		SampleSkillDetect();
		EmitPug("MATCH_START map=%s", g_sCurrentMap);
	}

	// readyup's go-live forward fires for every round on the box, PUG match or
	// not, so gate the half counter on an actually-tracked match. Otherwise an
	// idle server would burn through g_iHalf on ordinary rounds between matches.
	if (g_State == MS_Live)
	{
		g_iHalf++;
		g_fRoundLiveAt = GetGameTime();
		char surv[2];
		SurvPugTeam(surv, sizeof(surv));
		// An empty side means the orientation mapping has not settled. Emit
		// anyway with the best guess of "a": the backend trusts ROUND_END, and a
		// missing ROUND_START would leave the round with no started_at at all.
		if (surv[0] == '\0') strcopy(surv, sizeof(surv), "a");
		EmitPug("ROUND_START map=%s half=%d surv=%s", g_sCurrentMap, g_iHalf, surv);
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
		g_iPinnedBy[i] = 0;
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

	// Captured now, not re-derived in the timer: g_iHalf can be reset to 0 by
	// FinalizeMap and g_iPugSide can be flipped by the team lock timer before
	// Timer_ReadScore's retry chain (2-8s out) ever fires. See EmitRoundEnd.
	int half = g_iHalf;
	char survEnd[2];
	SurvPugTeam(survEnd, sizeof(survEnd));

	int score = TryReadRoundScore(second);
	if (score >= 0)
	{
		AttributeScore(survPug, score, second);

		// The survivor team's own score for this half. g_iHalfScoreA/B are
		// already the per-half accumulators.
		int mine = (survEnd[0] != '\0') ? (StrEqual(survEnd, "a") ? g_iHalfScoreA : g_iHalfScoreB) : 0;
		EmitRoundEnd(half, survEnd, mine);

		if (second) FinalizeMap();
		return;
	}

	DataPack pack;
	CreateDataTimer(2.0, Timer_ReadScore, pack, TIMER_FLAG_NO_MAPCHANGE);
	pack.WriteCell(second ? 1 : 0);
	pack.WriteCell(survPug);
	pack.WriteCell(0); // retry counter
	pack.WriteCell(half);
	pack.WriteString(survEnd);
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
	int score = (survLogical != 0) ? L4D_GetTeamScore(survLogical, false) : -1;
	PugDebug("score read half=%d logical=%d score=%d (round1Logical=%d)",
		second ? 2 : 1, survLogical, score, g_iRound1Logical);
	return score;
}

/** Credit a read round score to the observed pug team's half accumulator.
 *
 *  Observation stays primary; that is the locked design decision (plan 2b,
 *  decision 1): credit whoever is actually standing on the survivor side, never
 *  a predicted flip. But ObserveSurvivorPugTeam() returns 0 whenever it cannot
 *  see, which happens two ways: nobody rostered is on survivors (short-handed,
 *  or solo testing), or the count is tied because the team-lock timer is
 *  mid-move at round_end. Both silently discarded the round. A half-2 score of
 *  50 vanished exactly this way on 2026-09-06.
 *
 *  Last-resort fallback, half 2 only: in versus the teams swap sides between
 *  the halves of one map, so half 2's survivors are whichever pug team was NOT
 *  survivors in half 1 of this same map. That is a rule of the game mode rather
 *  than a guess, and it is scoped inside one map (reset in OnMapStart next to
 *  g_iRound1Logical), so it never re-opens the cross-map logical-team
 *  relabeling problem decision 1 was defending against.
 *
 *  Deliberately LogError, not PugDebug: in a real 4v4 the observation path
 *  should always see four survivors, so this firing means something is wrong
 *  and it should be loud even with sm_pug_debug 0. */
void AttributeScore(int survPug, int score, bool second)
{
	if (!second && survPug != 0) g_iRound1SurvPug = survPug;
	else if (second && survPug == 0 && g_iRound1SurvPug != 0)
	{
		survPug = 3 - g_iRound1SurvPug;
		LogError("[pug] half-2 score %d unobserved, attributing to pug team %s by half-1 inversion",
			score, survPug == 1 ? "a" : "b");
	}

	if (survPug == 1) { g_iHalfScoreA += score; PugDebug("credit %d to pug team a (half total %d)", score, g_iHalfScoreA); }
	else if (survPug == 2) { g_iHalfScoreB += score; PugDebug("credit %d to pug team b (half total %d)", score, g_iHalfScoreB); }
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
	int half = pack.ReadCell();
	char survEnd[2];
	pack.ReadString(survEnd, sizeof(survEnd));
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
			retry.WriteCell(half);
			retry.WriteString(survEnd);
		}
		else
		{
			LogError("[pug] could not read round score after retries (half %d)", second ? 2 : 1);
			// Finalize now (prompt MAP_RESULT) if the map hasn't changed yet.
			// If it HAS already changed, this TIMER_FLAG_NO_MAPCHANGE timer never
			// runs at all. g_bPendingFinalize is still set in that case, so the
			// OnMapStart failsafe finalizes with whatever was accumulated,
			// guaranteeing the map is recorded either way.
			//
			// Emit ROUND_END anyway with whatever score accumulated before the
			// reads gave up: a round with a wrong score is still recoverable,
			// a round with no side recorded at all is not.
			int mine = (survEnd[0] != '\0') ? (StrEqual(survEnd, "a") ? g_iHalfScoreA : g_iHalfScoreB) : 0;
			EmitRoundEnd(half, survEnd, mine);
			if (second) FinalizeMap();
		}
		return Plugin_Stop;
	}

	AttributeScore(survPug, score, second);
	int mine = (survEnd[0] != '\0') ? (StrEqual(survEnd, "a") ? g_iHalfScoreA : g_iHalfScoreB) : 0;
	EmitRoundEnd(half, survEnd, mine);
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
	g_iHalf = 0;
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

bool IsTankClient(int client)
{
	return IsInfectedClient(client) && GetEntProp(client, Prop_Send, "m_zombieClass") == ZC_TANK;
}

public void Event_PlayerHurt(Event event, const char[] name, bool dontBroadcast)
{
	if (!StatsActive()) return;
	int victim = GetClientOfUserId(event.GetInt("userid"));
	int attacker = GetClientOfUserId(event.GetInt("attacker"));
	if (attacker <= 0 || attacker > MaxClients) return;
	int damage = event.GetInt("dmg_health");
	if (damage <= 0) return;

	// Infected-side capture MUST sit above the survivor-only guard: this handler
	// used to return at line 810 for any non-survivor attacker, which is why
	// nothing has ever recorded the infected half of a match. An infected
	// attacker contributes nothing to the survivor stats below, so return here.
	if (IsInfectedClient(attacker) && !IsFakeClient(attacker) && IsSurvivorClient(victim))
	{
		AddStat(attacker, PS_DamageAsSi, damage);
		if (GetEntProp(attacker, Prop_Send, "m_zombieClass") == ZC_TANK)
		{
			char wpn[32];
			event.GetString("weapon", wpn, sizeof(wpn));
			if (StrEqual(wpn, "tank_claw")) AddStat(attacker, PS_TankPunches);
		}
		return;
	}

	// Restores the behaviour the original line-810 guard had for every path below.
	if (!IsSurvivorClient(attacker)) return;

	// Tank damage stays out of sidmg on purpose: the compstats convention exists so
	// tank damage does not distort survivor damage totals. But the hook already runs
	// for tanks and the existing siVictim check just discards it, so route it to its
	// own key instead of dropping it.
	if (IsInfectedClient(victim) && GetEntProp(victim, Prop_Send, "m_zombieClass") == ZC_TANK)
	{
		AddStat(attacker, PS_TankDamage, damage);
	}

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
		// Emitted beside the counter above, never instead of it: the counter
		// stays authoritative for totals, this carries only when and to whom.
		EmitClientEvent("ff", attacker, victim, damage);
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

	// Timeline emissions live here, ahead of the SI-kill stat guards below,
	// because those guards return early for exactly the cases (a survivor
	// dying, a fake-client tank dying) that "death" and "tank_death" need to
	// see. Nothing below this block is reordered or altered.
	//
	// Free anyone this player was pinning, and credit whoever killed them.
	for (int i = 1; i <= MaxClients; i++)
	{
		if (g_iPinnedBy[i] != victim) continue;
		g_iPinnedBy[i] = 0;
		EmitClientEvent("cleared", attacker, i, 0);
	}
	if (GetClientTeam(victim) == TEAM_SURVIVOR) EmitClientEvent("death", victim, attacker, 0);
	else if (IsTankClient(victim)) EmitClientEvent("tank_death", attacker, 0, 0);

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
	// "subject" is the revived survivor (verified against l4d_dynamic_light.sp's
	// own revive_success handler); "userid" above is the reviver.
	EmitClientEvent("revive", reviver, GetClientOfUserId(event.GetInt("subject")), 0);
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

	// Boomer bookkeeping, mirroring l4dcompstats.sp's Event_PlayerSpawn.
	// An AI boomer spawning while g_iBoomerClient is set means a human's
	// boomer went AI, and the human keeps the credit, so the pointer is only
	// reassigned for a human spawn (or when nothing is tracked yet).
	if (IsInfectedClient(client)
		&& GetEntProp(client, Prop_Send, "m_zombieClass") == ZC_BOOMER)
	{
		if (!IsFakeClient(client) || !g_iBoomerClient)
		{
			g_bHasBoomLanded = false;
			g_iBoomerClient = client;
		}
		// Denominator for the success rate: every boomer life a human played,
		// including the ones that died to a shot at range having landed
		// nothing. Deriving this from pops instead would miss those.
		if (!IsFakeClient(client) && StatsActive()) AddStat(client, PS_BoomerSpawns);
	}

	if (GetClientTeam(client) == TEAM_INFECTED)
		EmitClientEvent("si_spawn", client, 0, GetEntProp(client, Prop_Send, "m_zombieClass"));
}

/** player_now_it: a survivor just became "it". Fires once per survivor caught,
 *  so the per-life success is latched while the per-survivor counters are not.
 *  `exploded` distinguishes the death explosion (proxy) from a direct vomit. */
public void Event_PlayerBoomed(Event event, const char[] name, bool dontBroadcast)
{
	// Only when the plugin was loaded mid-map with a boomer already alive.
	if (!g_iBoomerClient) g_iBoomerClient = GetClientOfUserId(event.GetInt("attacker"));
	if (g_iBoomerClient < 1 || g_iBoomerClient > MaxClients) return;

	if (!g_bHasBoomLanded)
	{
		AddStat(g_iBoomerClient, PS_BoomSuccesses);
		g_bHasBoomLanded = true;
	}
	AddStat(g_iBoomerClient, event.GetBool("exploded") ? PS_BoomedProxy : PS_BoomedVomit);
}

// ---------- live timeline: pin cycle, tank cycle, map hazards ----------

/** lunge_pounce: a hunter pins a survivor. */
public void Event_Pounce(Event event, const char[] name, bool dontBroadcast)
{
	int hunter = GetClientOfUserId(event.GetInt("userid"));
	int victim = GetClientOfUserId(event.GetInt("victim"));
	if (victim > 0 && victim <= MaxClients) g_iPinnedBy[victim] = hunter;
	EmitClientEvent("pinned", hunter, victim, 0);
}

/** tongue_grab: a smoker pins a survivor. */
public void Event_TongueGrab(Event event, const char[] name, bool dontBroadcast)
{
	int smoker = GetClientOfUserId(event.GetInt("userid"));
	int victim = GetClientOfUserId(event.GetInt("victim"));
	if (victim > 0 && victim <= MaxClients) g_iPinnedBy[victim] = smoker;
	EmitClientEvent("pinned", smoker, victim, 0);
}

/** tongue_release: the pull ends without anyone dying, so just clear the pin.
 *  "cleared" is a survivor credit for killing the infected that was pinning
 *  someone (see Event_PlayerDeath); a smoker letting go on its own earns no
 *  such credit. */
public void Event_TongueRelease(Event event, const char[] name, bool dontBroadcast)
{
	int victim = GetClientOfUserId(event.GetInt("victim"));
	if (victim > 0 && victim <= MaxClients) g_iPinnedBy[victim] = 0;
}

/** player_incapacitated_start: the bare player_incapacitated does not fire on
 *  this engine. */
public void Event_Incap(Event event, const char[] name, bool dontBroadcast)
{
	int victim = GetClientOfUserId(event.GetInt("userid"));
	int attacker = GetClientOfUserId(event.GetInt("attacker"));
	if (victim > 0 && victim <= MaxClients) g_iPinnedBy[victim] = 0;
	// Actor is the survivor it happened to, so the feed reads
	// "<name> was incapped by <attacker>".
	EmitClientEvent("incap", victim, attacker, 0);
}

public void Event_WitchAggro(Event event, const char[] name, bool dontBroadcast)
{
	EmitClientEvent("witch_aggro", GetClientOfUserId(event.GetInt("userid")), 0, 0);
}

public void Event_WitchKilled(Event event, const char[] name, bool dontBroadcast)
{
	EmitClientEvent("witch_killed", GetClientOfUserId(event.GetInt("userid")), 0, 0);
}

/** triggered_car_alarm: userid may be absent or 0 when the director trips an
 *  alarm with nobody responsible. EmitClientEvent (via EmitEvent) drops an
 *  unrostered/invalid actor, which is correct: an unattributed alarm is not
 *  a blame stat. */
public void Event_CarAlarm(Event event, const char[] name, bool dontBroadcast)
{
	EmitClientEvent("car_alarm", GetClientOfUserId(event.GetInt("userid")), 0, 0);
}

public void Event_TankSpawn(Event event, const char[] name, bool dontBroadcast)
{
	EmitClientEvent("tank_spawn", GetClientOfUserId(event.GetInt("userid")), 0, 0);
}

/** bot_player_replace: a human takes over a bot. When the bot being taken
 *  over was the tank, this is a tank pass. */
public void Event_BotPlayerReplace(Event event, const char[] name, bool dontBroadcast)
{
	int player = GetClientOfUserId(event.GetInt("player"));
	if (IsTankClient(player)) EmitClientEvent("tank_pass", player, 0, 0);
}

/** player_bot_replace: a human is replaced by a bot, handing the tank back
 *  to the AI. Same "tank_pass" kind as the reverse direction; the feed cares
 *  that control changed hands, not which way. */
public void Event_PlayerBotReplace(Event event, const char[] name, bool dontBroadcast)
{
	int player = GetClientOfUserId(event.GetInt("player"));
	if (IsTankClient(player)) EmitClientEvent("tank_pass", player, 0, 0);
}

/** Authoritative match record over the RCON response body. Idempotent:
 *  the backend may call sm_pug_dump repeatedly. */
void WriteDump()
{
	DumpLine("DUMP match=%d skilldetect=%d", g_iMatchId, g_bSkillDetect ? 1 : 0);
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
	WriteSkillLines();
	int a, b;
	TotalScores(a, b);
	char winner[8];
	WinnerOf(a, b, winner, sizeof(winner));
	DumpLine("END winner=%s a=%d b=%d", winner, a, b);
}
