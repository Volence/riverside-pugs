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
#define ZC_SMOKER 1
#define ZC_BOOMER 2
#define ZC_HUNTER 3
#define ZC_TANK 5
#define LOCK_ATTEMPT_CAP 6

/** Longest chat message emitted. Long enough for anything anyone types in a
 *  PUG, short enough that a message cannot push a log line into truncation. */
#define CHAT_MAX_BYTES 128

// Replay file layout. Every number here also exists in src/replayFormat.ts.
// Changing one without changing the other produces a file that parses into
// plausible nonsense rather than an error, which is why the in-game
// verification at the end of this plan reads a real file back.
#define RPL_VERSION        2
#define RPL_HEADER_BYTES   160
#define RPL_SLOTS          8
#define RPL_PLAYER_RECORD  20
#define RPL_PLAYER_BLOCK   160
#define RPL_FRAME_HEADER   8
#define RPL_ENTITY_RECORD  12
#define RPL_INDEX_RECORD   8
// A keyframe every 10 seconds, so a 6 minute round indexes in 36 entries.
#define RPL_KEYFRAME_MS    10000
// Hard ceiling on entities in one frame. Commons run 20 to 30 in a versus
// round; this is headroom, and overflow drops the excess rather than writing
// past the buffer.
#define RPL_MAX_ENTITIES   128
#define RPL_FRAME_MAX      (RPL_FRAME_HEADER + RPL_PLAYER_BLOCK + RPL_MAX_ENTITIES * RPL_ENTITY_RECORD)

// Entity kinds. Everything that is not one of the eight rostered players.
#define RPL_K_COMMON       1
#define RPL_K_WITCH        2
#define RPL_K_TANK_ROCK    3
#define RPL_K_TANK_AI      4
#define RPL_K_SURVIVOR_BOT 5
#define RPL_K_SMOKER_AI    6
#define RPL_K_BOOMER_AI    7
#define RPL_K_HUNTER_AI    8

// State bits, shared by player and entity records.
#define RPL_S_PRESENT      (1 << 0)
#define RPL_S_ALIVE        (1 << 1)
#define RPL_S_INCAP        (1 << 2)
#define RPL_S_LEDGED       (1 << 3)
#define RPL_S_PINNED       (1 << 4)
#define RPL_S_BILED        (1 << 5)
#define RPL_S_BURNING      (1 << 6)
#define RPL_S_GHOST        (1 << 7)

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
int g_iHalf;                             // 1 or 2 within the current map, DERIVED from
                                          // m_bInSecondHalfOfRound at go-live, never counted;
                                          // 0 only before the first half of a match goes live
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

/** Friendly fire damage accumulated per attacker/victim pair, not yet emitted
 *  as an event. See FlushFriendlyFire. The g_iStatFf counter is credited per
 *  hit exactly as before and is unaffected by any of this; only the EVENT is
 *  coalesced. */
int g_iFfPending[MAXPLAYERS + 1][MAXPLAYERS + 1];

/** How often pending friendly fire is swept out as events. One second is long
 *  enough that a whole SMG burst or shotgun blast lands inside a single flush,
 *  and short enough that the live feed still reads as live. */
#define FF_FLUSH_INTERVAL 1.0

/** Emit immediately once a pair reaches this much pending damage, so a burst
 *  big enough to matter is not held back for up to a second. Roughly a
 *  quarter of a survivor's health. */
#define FF_FLUSH_DAMAGE 50

// Who currently has each survivor pinned, as a client index; 0 = free.
// Needed because a "cleared" event has to name the survivor who did the
// clearing, which is not carried by any release event.
int g_iPinnedBy[MAXPLAYERS + 1];

// The smoker a survivor was released from, and when, in game time.
//
// tongue_release fires BEFORE player_death when a smoker is shot off someone:
// measured at 0 to 1 seconds ahead of it on this engine, 2026-09-11. Hard
// zeroing the link there meant the death handler always found nothing to credit
// and every smoker clear was silently lost, which is why the match on
// 2026-09-11 recorded skill_detect clears=5 against 2 captured events.
//
// So the release records rather than erases, and the death handler accepts a
// link released within the grace window below. A release with no death after it
// simply expires. tongue_pull_stopped would have been the clean signal (it
// names who stopped the pull) but it does not fire at all on L4D1: verified
// across a whole session of grabs, chokes, kills and incaps.
int g_iPinReleasedFrom[MAXPLAYERS + 1];
float g_fPinReleasedAt[MAXPLAYERS + 1];

// Generous against the 0-1s gap observed, but far shorter than the time needed
// to find and kill a smoker that genuinely let go on its own.
#define PIN_RELEASE_GRACE 2.0

// Which kind of pin a survivor is in, and whether the smoker has started
// choking them yet. Together these define a tongue clear: freeing someone from
// a tongue BEFORE choke_start, so they never got strung up at all.
//
// choke_start is the right boundary rather than a time threshold because drag
// time scales with how far away the smoker was, so a fixed "cleared within N
// seconds" would punish handling a long-range grab well. Measured 1 to 2
// seconds after the grab on this engine, 2026-09-11.
bool g_bPinIsTongue[MAXPLAYERS + 1];
bool g_bChokeStarted[MAXPLAYERS + 1];

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

// ---------- replay recording ----------
ConVar g_cvReplayHz;                     // 0 = off. Instant rcon kill switch, no reload.
ConVar g_cvReplayEntityHz;               // world entity sample rate; <= player rate
ConVar g_cvReplayDir;                    // directory, relative to the game dir
ConVar g_cvReplayMaxMb;                  // per-round byte cap, a runaway bound
ConVar g_cvReplayAfterEnd;               // 1 = keep recording after the finale ends the match
ConVar g_cvReplayStandalone;             // 1 = record rounds with no tracked match at all (!mix nights)
/** Whether the last standalone round we recorded was on a campaign's first map.
 *  Used to notice the transition INTO a new campaign exactly once, rather than
 *  on both halves of that campaign's opening map. */
bool g_bRplFirstMapSeen;

File g_hReplay;                          // null when not recording
Handle g_hReplayTimer;
int g_iReplayFrames;
int g_iReplayBytes;
/** Latched for the rest of the MATCH on any write failure. A replay problem
 *  must never turn into a match problem, so the recorder gives up completely
 *  rather than retrying every round. */
bool g_bReplayFailed;
/** Entity refs for world entities only: commons, the witch, the rock. Players
 *  are iterated instead, because MaxClients is small and because bots and AI
 *  specials are not visible any other way. */
ArrayList g_hRplEnts;
ArrayList g_hRplIndexT;                  // keyframe t_ms
ArrayList g_hRplIndexOff;                // keyframe byte offset
int g_iRplLastKeyMs;
/** Re-entry latch for the sampler. Set for the duration of one Timer_RplFrame
 *  body and cleared at every exit from it, so finding it still set on entry
 *  means the previous invocation was unwound by a native error. SourcePawn
 *  cannot catch one, and the timer repeats, so without this a single bad
 *  netprop read would fill the log ten times a second for the whole match. */
bool g_bRplSampling;
/** Whether m_survivorCharacter exists on this build's send table, resolved
 *  once against a real client rather than assumed.
 *
 *  Netprop names are runtime strings, so compiling proves nothing about them.
 *  An absent prop makes GetEntProp throw, which unwinds the sampler, trips
 *  the latch above and calls RplFail, and replay recording is then off for
 *  the whole match. A wrong guess about this prop should cost one wrong
 *  portrait, not a match's recording, so it is checked with HasEntProp and
 *  falls back to writing 0, which is exactly what version 1 files carry. */
bool g_bRplHasSurvChar;
bool g_bRplSurvCharChecked;              // false until a REAL client was available to ask
int g_iRplEntityEveryN;                  // sample world entities 1 frame in N
int g_iRplFrameNo;
/** Map counter used ONLY for replay filenames. g_iMapCount stops at MAX_MAPS,
 *  which is correct for the score table but would make every map after the 8th
 *  reuse ordinal 8 and silently overwrite that map's replay files. This one
 *  never stops, so an all-night session keeps every file. Below the cap it
 *  tracks g_iMapCount exactly, so a replay still lines up with the map the
 *  backend recorded. */
int g_iRplMapSeq;
int g_iRplBuf[RPL_FRAME_MAX];            // one byte per cell, written in one call

// Staging knobs. Both default to production behaviour; they exist so the plugin
// can be exercised on a test instance without eight people in the server.
ConVar g_cvMinOrient;                    // rostered players needed to move the orientation mapping
ConVar g_cvDebug;                        // 1 = verbose state logging to the SourceMod log
ConVar g_cvPugConfig;                    // config !load_4v4p execs
ConVar g_cvTeamLock;                     // 0 = Timer_TeamLock never moves anyone (testing)
ConVar g_cvRosterAtLive;                 // 1 = !load_4v4p records the roster at first go-live, not at the command
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
	g_cvTeamLock = CreateConVar("sm_pug_team_lock", "1",
		"1 = move rostered players back to their team's side every two seconds. 0 lets people \
swap sides freely; the orientation vote still runs so scoring attribution keeps working. Testing only.",
		FCVAR_NOTIFY, true, 0.0, true, 1.0);
	g_cvRosterAtLive = CreateConVar("sm_pug_roster_at_live", "0",
		"!load_4v4p roster timing. 0 = record whoever is on a side the moment the command runs. \
1 = create the match now but record whoever is on a side when the first round goes live, so a \
!mix after the load still lands in the roster.",
		FCVAR_NOTIFY, true, 0.0, true, 1.0);

	g_cvReplayHz = CreateConVar("sm_pug_replay_hz", "10",
		"Replay sample rate in Hz. 0 disables recording. Takes effect at the next round.",
		FCVAR_NOTIFY, true, 0.0, true, 20.0);
	g_cvReplayEntityHz = CreateConVar("sm_pug_replay_entity_hz", "10",
		"World entity sample rate in Hz. Clamped to the player rate.",
		FCVAR_NOTIFY, true, 0.0, true, 20.0);
	g_cvReplayDir = CreateConVar("sm_pug_replay_dir", "replays",
		"Directory for replay files, relative to the game dir. Empty disables recording.",
		FCVAR_NOTIFY);
	g_cvReplayStandalone = CreateConVar("sm_pug_replay_standalone", "1",
		"1 = record any round that goes live even with no tracked PUG match, e.g. a !mix night. Recording only; emits nothing to the backend.",
		FCVAR_NOTIFY, true, 0.0, true, 1.0);
	g_cvReplayAfterEnd = CreateConVar("sm_pug_replay_after_end", "1",
		"1 = keep recording replays after the finale has ended the match. Recording only; no ROUND_START, no scoring.",
		FCVAR_NOTIFY, true, 0.0, true, 1.0);
	g_cvReplayMaxMb = CreateConVar("sm_pug_replay_max_mb", "64",
		"Per-round replay size cap in MB. A runaway bound, not a budget: a full round is 10 to 15 MB.",
		FCVAR_NOTIFY, true, 1.0, true, 512.0);

	g_hRplEnts = new ArrayList();
	g_hRplIndexT = new ArrayList();
	g_hRplIndexOff = new ArrayList();

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
		LogMessage("pug-match: event 'player_bot_replace' does not exist on this engine; tank_give capture (human giving up tank) will be silently absent.");
	if (!HookEventEx("bot_player_replace", Event_BotPlayerReplace))
		LogMessage("pug-match: event 'bot_player_replace' does not exist on this engine; tank_take capture (human taking tank) will be silently absent.");

	// pounce_stopped names the survivor who ended a pounce, and fires for a
	// shove clear as well as a kill, so it is the only signal that catches both.
	// Measured 2026-09-11: it fires once per real pin end, carrying the stopper
	// and the victim, with our link still intact.
	//
	// Its neighbours are deliberately NOT hooked. pounce_end fires on every
	// pounce that merely ends, dozens of times a round with victim=0, so
	// crediting from it would invent clears for pounces that never landed.
	// tongue_pull_stopped does not fire at all on this engine, verified across a
	// session of grabs, chokes, kills and incaps, which is why the smoker case
	// has to go through the release grace window instead.
	if (!HookEventEx("pounce_stopped", Event_PounceStopped))
		LogMessage("pug-match: event 'pounce_stopped' does not exist on this engine; shove clears will not be captured.");
	if (!HookEventEx("choke_start", Event_ChokeStart))
		LogMessage("pug-match: event 'choke_start' does not exist on this engine; tongue_clears cannot be distinguished and will not be counted.");
	if (!HookEventEx("player_say", Event_PlayerSay))
		LogError("pug: player_say not hooked; chat will not be captured");

	// Persistent repeating timers (no TIMER_FLAG_NO_MAPCHANGE, since they must survive changelevel).
	CreateTimer(30.0, Timer_Heartbeat, _, TIMER_REPEAT);
	CreateTimer(2.0, Timer_TeamLock, _, TIMER_REPEAT);
	// Faster than the heartbeat on purpose: the heartbeat is a liveness signal
	// whose 30s period defines the backend's staleness window, while this is a
	// spectator refresh where 30s feels dead. Separate timers so neither
	// constrains the other.
	CreateTimer(10.0, Timer_LiveStats, _, TIMER_REPEAT);
	// Coalesces the per-bullet friendly fire events. See AccumulateFriendlyFire.
	CreateTimer(FF_FLUSH_INTERVAL, Timer_FlushFf, _, TIMER_REPEAT);

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

/** Plugin unload/reload: close whatever replay is open rather than leaving it
 *  headerless-index and orphaned mid-round. */
public void OnPluginEnd()
{
	RplClose();
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

/** The side to RECORD for a round, given the pug team observed holding
 *  survivor at round_end (1 = a, 2 = b, 0 = could not see).
 *
 *  The recorded side and the recorded score must come from ONE observer. They
 *  used to come from two: the score was credited by AttributeScore using
 *  ObserveSurvivorPugTeam() (plain majority of rostered players standing on
 *  survivors), while the side was read from SurvPugTeam() (the enforcement
 *  mapping, which only moves on a clear joint majority and otherwise keeps its
 *  previous value). When those two disagreed the round recorded one team's
 *  letter against the other team's score, marked reliable, and contradicted
 *  the match_maps row the same round produced.
 *
 *  So the observation wins, and SurvPugTeam() is consulted only when there was
 *  no observation to have. */
void SurvSideOf(int survPug, char[] out, int maxlen)
{
	if (survPug == 1) strcopy(out, maxlen, "a");
	else if (survPug == 2) strcopy(out, maxlen, "b");
	else SurvPugTeam(out, maxlen);
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
 *  round_end time, not read fresh from g_iHalf/g_iPugSide here. The half is
 *  derived from m_bInSecondHalfOfRound at the time the round goes live, and
 *  the team lock timer may have flipped g_iPugSide by the time this is called. */
void EmitRoundEnd(int half, const char[] surv, int score)
{
	if (surv[0] != '\0')
	{
		// map= rides along for the same reason ROUND_START carries it: the
		// backend otherwise derives this round's map ordinal from how many
		// maps have finished at ARRIVAL time, and the half-2 ROUND_END is
		// emitted immediately before FinalizeMap's MAP_RESULT. Those two
		// datagrams reordering in flight would file the round on the next map.
		// g_sCurrentMap is safe to read here even from the retry chain: that
		// chain is TIMER_FLAG_NO_MAPCHANGE, so it cannot outlive this map.
		EmitPug("ROUND_END map=%s half=%d surv=%s score=%d", g_sCurrentMap, half, surv, score);
	}
	// Match-critical work first, replay second. RplClose can in principle
	// throw (see the stale-handle note on it), and an unwind here would skip
	// the zeroing below, which corrupts RoundMs() for every event of the next
	// half, and would also skip the caller's FinalizeMap. Nothing between the
	// zeroing and the close can produce another frame, so the close loses
	// nothing by going last.
	g_fRoundLiveAt = 0.0;
	RplClose();
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

/** Strip anything that would break the log line, and cap the length.
 *
 *  A newline inside a log line IS a second log line as far as the reader is
 *  concerned, so an unstripped one lets a player inject a whole datagram.
 *  Everything else is left alone: the parser takes the remainder of the line
 *  after ' msg=', so spaces and '=' are already safe. */
void SanitizeChat(char[] text, int maxlen)
{
	int w = 0;
	int limit = maxlen - 1 < CHAT_MAX_BYTES ? maxlen - 1 : CHAT_MAX_BYTES;
	for (int r = 0; text[r] != '\0' && w < limit; r++)
	{
		if (text[r] == '\n' || text[r] == '\r') continue;
		text[w++] = text[r];
	}
	text[w] = '\0';
}

/** Chat is captured for any tracked match, NOT gated on StatsActive().
 *
 *  That gate exists to keep counters from moving between rounds and during
 *  ready-up. Chat has no counter to protect and those moments are exactly when
 *  the talking happens, so gating it there would throw away most of the value.
 *  RoundMs() returns -1 outside a live round, which the parser already treats
 *  as "no round timing".
 *
 *  Unrostered speakers are dropped, the same discipline EmitEvent follows: a
 *  spectator or admin must never appear in the match record. */
public void Event_PlayerSay(Event event, const char[] name, bool dontBroadcast)
{
	if (g_State == MS_None) return;
	int client = GetClientOfUserId(event.GetInt("userid"));
	if (client < 1 || client > MaxClients) return;
	int slot = g_iClientRoster[client];
	if (slot < 0) return;

	char text[256];
	event.GetString("text", text, sizeof(text));
	SanitizeChat(text, sizeof(text));
	if (text[0] == '\0') return;

	g_iEventSeq++;
	// msg= is LAST on the line, deliberately. The parser takes everything
	// after the first ' msg=' as the message, so any field emitted after it
	// could be forged by typing it into chat.
	EmitPug("CHAT seq=%d half=%d t=%d steamid=%s team=%s msg=%s",
		g_iEventSeq, g_iHalf, RoundMs(), g_sRosterId[slot],
		g_iRosterTeam[slot] == 1 ? "a" : "b", text);
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

// ---------- replay byte packing ----------
// Explicit little-endian, one byte per cell, so the file never depends on how
// this machine lays out a native word. The whole buffer goes out in a single
// WriteFile at size = 1.

int RplU8(int pos, int v)
{
	g_iRplBuf[pos] = v & 0xFF;
	return pos + 1;
}

int RplU16(int pos, int v)
{
	g_iRplBuf[pos]     = v & 0xFF;
	g_iRplBuf[pos + 1] = (v >> 8) & 0xFF;
	return pos + 2;
}

int RplU32(int pos, int v)
{
	g_iRplBuf[pos]     = v & 0xFF;
	g_iRplBuf[pos + 1] = (v >> 8) & 0xFF;
	g_iRplBuf[pos + 2] = (v >> 16) & 0xFF;
	g_iRplBuf[pos + 3] = (v >> 24) & 0xFF;
	return pos + 4;
}

/** Clamp before packing. Source world bounds are +/- 16384 so a real position
 *  always fits an int16, but a detached or uninitialised entity can report
 *  something absurd, and wrapping it would draw a player on the far side of
 *  the map rather than at the edge. */
int RplClampI16(int v)
{
	if (v >  32767) return  32767;
	if (v < -32768) return -32768;
	return v;
}

/** Clamp before packing an unsigned field. GetClientHealth returns a negative
 *  value for a dead player and m_iClip1 is -1 for a weapon with no clip; both
 *  would wrap through RplU16 to roughly 65535 and reach the reader as a
 *  plausible wrong number rather than as an error, which is exactly the kind
 *  of silent divergence from src/replayFormat.ts this format guards against. */
int RplClampU16(int v)
{
	if (v > 65535) return 65535;
	if (v < 0) return 0;
	return v;
}

int RplI16(int pos, int v)
{
	// Two's complement, so the byte pattern of a negative int16 is the low 16
	// bits of the negative int32. No separate path needed.
	return RplU16(pos, RplClampI16(v));
}

/** Fixed-width ASCII, nul padded. */
int RplStr(int pos, const char[] s, int len)
{
	// strlen hoisted out of the loop: inside it, this is quadratic.
	int n = strlen(s);
	if (n > len) n = len;
	// A ternary mixing a char branch with an int branch does not typecheck
	// under newdecls (error 450, even between two char-typed values), so this
	// is spelled as if/else instead. Same bytes either way.
	for (int i = 0; i < len; i++)
	{
		if (i < n) g_iRplBuf[pos + i] = s[i];
		else g_iRplBuf[pos + i] = 0;
	}
	return pos + len;
}

// ---------- replay world entity tracking ----------

/** Which replay entity kind a world entity classname maps to, or 0 for one we
 *  do not record.
 *
 *  These three classnames are all in use by this deployment's own plugins:
 *  "infected" in l4dready.sp, "witch" in l4d1_random_witch_model.sp,
 *  "tank_rock" in l4d_ssi_teleport_fix.sp. Anything else is ignored. */
int RplWorldKind(const char[] classname)
{
	if (StrEqual(classname, "infected"))  return RPL_K_COMMON;
	if (StrEqual(classname, "witch"))     return RPL_K_WITCH;
	if (StrEqual(classname, "tank_rock")) return RPL_K_TANK_ROCK;
	return 0;
}

/** The whole reason the recorder is affordable.
 *
 *  The obvious implementation finds these with FindEntityByClassname on every
 *  frame, which walks the entity table once per classname, ten times a second,
 *  on a box that already overruns about 1% of its frames. Creation and
 *  destruction are events the engine raises anyway, so the work moves off the
 *  sampling path entirely and the per-frame cost becomes walking about thirty
 *  tracked references.
 *
 *  References, not indices: the engine recycles indices, and a stale index
 *  would silently start reporting a different entity's position. */
public void OnEntityCreated(int entity, const char[] classname)
{
	if (g_hRplEnts == null) return;
	if (RplWorldKind(classname) == 0) return;
	g_hRplEnts.Push(EntIndexToEntRef(entity));
}

public void OnEntityDestroyed(int entity)
{
	if (g_hRplEnts == null || entity < 0) return;
	int ref = EntIndexToEntRef(entity);
	int at = g_hRplEnts.FindValue(ref);
	if (at != -1) g_hRplEnts.Erase(at);
}

// ---------- replay file lifecycle ----------

/** Open this round's replay file and write its header.
 *
 *  Every failure path here is silent to the match: replay recording simply
 *  does not happen. Nothing in this function may throw into the round going
 *  live. */
void RplOpen()
{
	RplClose();               // paranoia: a previous round that never closed
	if (g_bReplayFailed) return;
	// MS_Ended is allowed so an all-night session keeps recording after a
	// finale has closed the match. Nothing else about MS_Ended changes: the
	// result was already reported and no further ROUND_START is ever emitted.
	if (g_State != MS_Live
		&& !(g_State == MS_Ended && g_cvReplayAfterEnd.BoolValue)
		&& !(g_State == MS_None && g_cvReplayStandalone.BoolValue)) return;

	int hz = g_cvReplayHz.IntValue;
	if (hz <= 0) return;

	char dir[PLATFORM_MAX_PATH];
	g_cvReplayDir.GetString(dir, sizeof(dir));
	if (dir[0] == '\0') return;
	if (!DirExists(dir) && !CreateDirectory(dir, 511))
	{
		LogError("pug: cannot create replay dir '%s'; recording disabled for this match", dir);
		g_bReplayFailed = true;
		return;
	}

	char path[PLATFORM_MAX_PATH];
	// Same naming convention as the demos, and for the same reason: the link
	// between a file and its match is a property of the filename, so it
	// survives a backend restart. There is no datagram announcing this file.
	Format(path, sizeof(path), "%s/pug_%s_%d_%d.rpl", dir, g_sToken, g_iRplMapSeq, g_iHalf);
	g_hReplay = OpenFile(path, "wb");
	if (g_hReplay == null)
	{
		LogError("pug: cannot open '%s'; replay recording disabled for this match", path);
		g_bReplayFailed = true;
		return;
	}

	int entHz = g_cvReplayEntityHz.IntValue;
	if (entHz > hz) entHz = hz;
	g_iRplEntityEveryN = (entHz <= 0) ? 0 : (hz / entHz);
	if (g_iRplEntityEveryN < 1 && entHz > 0) g_iRplEntityEveryN = 1;

	int p = 0;
	p = RplStr(p, "L4RP", 4);
	p = RplU16(p, RPL_VERSION);
	p = RplU8(p, g_iMapCount);
	p = RplU8(p, g_iHalf);
	p = RplU8(p, hz);
	p = RplU8(p, entHz);
	p = RplU16(p, 0);                          // reserved, pads token to 12
	p = RplStr(p, g_sToken, 32);
	p = RplStr(p, g_sCurrentMap, 32);
	p = RplU32(p, GetTime());
	p = RplU32(p, 0);                          // indexOffset, patched at close
	p = RplU32(p, 0);                          // indexCount, patched at close
	for (int slot = 0; slot < RPL_SLOTS; slot++)
	{
		int id64[2];
		// An empty slot writes 0, which the reader decodes as "nobody", never
		// as a SteamID that happens to be small.
		if (slot < g_iRosterCount && g_sRosterId[slot][0] != '\0') StringToInt64(g_sRosterId[slot], id64);
		else { id64[0] = 0; id64[1] = 0; }
		p = RplU32(p, id64[0]);
		p = RplU32(p, id64[1]);
	}
	while (p < 152) p = RplU8(p, 0);
	p = RplU32(p, 0);                          // frameCount, patched at close
	while (p < RPL_HEADER_BYTES) p = RplU8(p, 0);

	// Reset BEFORE the write, not after: a failed header write goes straight to
	// RplFail -> RplClose, which would otherwise append the PREVIOUS round's
	// keyframes to this broken file and patch it with a stale indexOffset and
	// frameCount.
	g_iReplayFrames = 0;
	g_iReplayBytes = RPL_HEADER_BYTES;
	g_iRplLastKeyMs = -RPL_KEYFRAME_MS;        // forces a keyframe on frame one
	g_iRplFrameNo = 0;
	g_bRplSampling = false;                    // a previous round's abort is not this round's
	g_hRplIndexT.Clear();
	g_hRplIndexOff.Clear();

	if (!WriteFile(g_hReplay, g_iRplBuf, RPL_HEADER_BYTES, 1))
	{
		LogError("pug: replay header write failed; recording disabled for this match");
		RplFail();
		return;
	}

	RplResolveSurvivorCharProp();

	float interval = 1.0 / float(hz);
	g_hReplayTimer = CreateTimer(interval, Timer_RplFrame, _, TIMER_REPEAT | TIMER_FLAG_NO_MAPCHANGE);
	PugDebug("replay: recording %s at %dHz (entities %dHz)", path, hz, entHz);
}

/** Resolve m_survivorCharacter against a real client, once.
 *
 *  FAKE CLIENTS ARE SKIPPED, and that is the whole point of this loop rather
 *  than a bare IsClientInGame check. SourceTV is a fake client, it is live on
 *  this server, it connects at server start so it usually holds a low index,
 *  and its edict is not a CTerrorPlayer. Asking it would answer "absent",
 *  latch that answer for the lifetime of the plugin load, log an error
 *  blaming the game build, and make every survivor in every replay record
 *  character 0. Survivor bots would answer correctly, being CTerrorPlayer,
 *  but they are fake clients too, so skipping all of them is the rule with no
 *  exceptions to get wrong.
 *
 *  An unresolved state is NOT cached: the checked flag is set only when a real
 *  client actually answered. Caching "nobody had joined yet" as a permanent
 *  miss would be the same bug in a different coat, so RplOpen retries every
 *  round until the question can be answered, and the sampler writes 0 in the
 *  meantime. */
void RplResolveSurvivorCharProp()
{
	if (g_bRplSurvCharChecked) return;
	for (int i = 1; i <= MaxClients; i++)
	{
		if (!IsClientInGame(i) || IsFakeClient(i)) continue;
		g_bRplHasSurvChar = HasEntProp(i, Prop_Send, "m_survivorCharacter");
		g_bRplSurvCharChecked = true;
		if (!g_bRplHasSurvChar)
			LogError("pug: m_survivorCharacter is absent; replays will record survivor character 0");
		return;
	}
}

/** Give up on replays for the rest of the match. */
void RplFail()
{
	g_bReplayFailed = true;
	RplClose();
}

/** Close the file, appending the keyframe index and patching the header.
 *
 *  The index and the frame count cannot be known until now, which is why the
 *  header reserves space for them rather than carrying them up front. A file
 *  that was never closed therefore reads as indexless and frameless, which is
 *  exactly the truth about it, instead of carrying a plausible wrong offset. */
void RplClose()
{
	// Diagnostic for a sampler invocation that was unwound by a native error.
	// Timer_RplFrame clears this flag at every normal exit, so finding it set
	// here means the last invocation never finished, and without this line
	// that failure is swallowed entirely: Timer_RplFrame's own latch only
	// notices on its NEXT tick, which never comes once the timer is killed.
	// Nothing is corrupted when it happens, because the single WriteFile is
	// the last step of a frame, so a partial frame is never written. Cleared
	// as it is logged, so one unwind reports once.
	if (g_bRplSampling)
	{
		g_bRplSampling = false;
		LogError("pug: replay sampler was unwound during frame %d; the failure is diagnostic only, no frame was partially written", g_iReplayFrames);
	}

	// The handle is taken and the global nulled BEFORE anything can throw, and
	// the kill itself is deferred to the very end of this function.
	//
	// SourceMod frees a TIMER_FLAG_NO_MAPCHANGE timer at level shutdown, so a
	// KillTimer on a handle left over from a previous map raises a native error
	// that unwinds whoever called RplClose. One of those callers is OnMapStart,
	// whose next statement is the g_bPendingFinalize failsafe, i.e. a replay
	// problem would cost a map its result. OnMapEnd below closes while the
	// handle is still valid so this cannot normally arise; nulling first and
	// killing last means that even if it somehow did, the file is already
	// finished and the bad handle is gone after one attempt.
	Handle timer = g_hReplayTimer;
	g_hReplayTimer = null;
	if (g_hReplay == null)
	{
		if (timer != null) KillTimer(timer);
		return;
	}

	int count = g_hRplIndexT.Length;
	int indexOffset = g_iReplayBytes;
	bool ok = true;

	if (count > 0)
	{
		int p = 0;
		for (int i = 0; i < count; i++)
		{
			// The buffer holds RPL_FRAME_MAX bytes, far more than any index
			// this loop writes for a round of sane length, but flush in
			// chunks anyway so a very long round cannot overrun it.
			if (p + RPL_INDEX_RECORD > RPL_FRAME_MAX)
			{
				if (!WriteFile(g_hReplay, g_iRplBuf, p, 1)) { ok = false; break; }
				p = 0;
			}
			p = RplU32(p, g_hRplIndexT.Get(i));
			p = RplU32(p, g_hRplIndexOff.Get(i));
		}
		if (ok && p > 0 && !WriteFile(g_hReplay, g_iRplBuf, p, 1)) ok = false;
	}

	if (ok)
	{
		// Patch indexOffset and indexCount at byte 80, then frameCount at 152.
		int p = 0;
		p = RplU32(p, count > 0 ? indexOffset : 0);
		p = RplU32(p, count);
		if (!FileSeek(g_hReplay, 80, SEEK_SET) || !WriteFile(g_hReplay, g_iRplBuf, 8, 1)) ok = false;
		if (ok)
		{
			RplU32(0, g_iReplayFrames);
			if (!FileSeek(g_hReplay, 152, SEEK_SET) || !WriteFile(g_hReplay, g_iRplBuf, 4, 1)) ok = false;
		}
	}
	if (!ok) LogError("pug: replay close incomplete; the file is still playable, seeking will be slow");

	delete g_hReplay;
	g_hReplay = null;
	PugDebug("replay: closed after %d frames, %d bytes", g_iReplayFrames, g_iReplayBytes);

	// Last, so that nothing above it is skipped if this handle is stale.
	if (timer != null) KillTimer(timer);
}

// ---------- replay sampler ----------

/** How long a boomer biling keeps a survivor marked.
 *
 *  m_vomitStart is the game time the biling started, not a boolean, so the
 *  bit is derived from how long ago it was. This duration is the one number
 *  in the sampler that was not read off a netprop dump, so confirm it in game:
 *  a wrong value here shows the bile overlay for the wrong length of time and
 *  nothing else. */
#define RPL_BILE_SECONDS 20.0

/** State bits for one in-game client. */
int RplClientState(int client, bool ghost)
{
	int state = RPL_S_PRESENT;
	if (IsPlayerAlive(client)) state |= RPL_S_ALIVE;
	if (GetEntPropFloat(client, Prop_Send, "m_burnPercent") > 0.0) state |= RPL_S_BURNING;
	float vomit = GetEntPropFloat(client, Prop_Send, "m_vomitStart");
	if (vomit > 0.0 && GetGameTime() - vomit < RPL_BILE_SECONDS) state |= RPL_S_BILED;
	if (GetClientTeam(client) == TEAM_SURVIVOR)
	{
		if (GetEntProp(client, Prop_Send, "m_isIncapacitated")) state |= RPL_S_INCAP;
		if (GetEntProp(client, Prop_Send, "m_isHangingFromLedge")) state |= RPL_S_LEDGED;
		if (g_iPinnedBy[client] > 0) state |= RPL_S_PINNED;
	}
	else if (ghost) state |= RPL_S_GHOST;
	return state;
}

bool RplIsGhost(int client)
{
	return GetClientTeam(client) == TEAM_INFECTED
		&& GetEntProp(client, Prop_Send, "m_isGhost") != 0;
}

/** Which entity kind a non-rostered in-game client is. */
int RplBotKind(int client)
{
	if (GetClientTeam(client) == TEAM_SURVIVOR) return RPL_K_SURVIVOR_BOT;
	if (GetClientTeam(client) != TEAM_INFECTED) return 0;
	switch (GetEntProp(client, Prop_Send, "m_zombieClass"))
	{
		case ZC_SMOKER: return RPL_K_SMOKER_AI;
		case ZC_BOOMER: return RPL_K_BOOMER_AI;
		case ZC_HUNTER: return RPL_K_HUNTER_AI;
		case ZC_TANK:   return RPL_K_TANK_AI;
	}
	return 0;
}

/** Weapon classname to a small id. The viewer renders a label per id, so the
 *  numbers only have to be stable, not meaningful. 0 is "none or unknown",
 *  which is also what an infected player records. */
int RplWeaponId(const char[] cls)
{
	if (StrEqual(cls, "weapon_pistol"))          return 1;
	if (StrEqual(cls, "weapon_smg"))             return 2;
	if (StrEqual(cls, "weapon_pumpshotgun"))     return 3;
	if (StrEqual(cls, "weapon_autoshotgun"))     return 4;
	if (StrEqual(cls, "weapon_rifle"))           return 5;
	if (StrEqual(cls, "weapon_hunting_rifle"))   return 6;
	if (StrEqual(cls, "weapon_pipe_bomb"))       return 7;
	if (StrEqual(cls, "weapon_molotov"))         return 8;
	if (StrEqual(cls, "weapon_first_aid_kit"))   return 9;
	if (StrEqual(cls, "weapon_pain_pills"))      return 10;
	return 0;
}

public Action Timer_RplFrame(Handle timer)
{
	// Re-entry latch. Only WriteFile failures below report themselves; a native
	// error anywhere else in this callback (a netprop absent on some entity,
	// say) just unwinds it, and the repeating timer then retries ten times a
	// second for the rest of the match. SourcePawn cannot catch that, but it
	// can notice it: the flag is set at the top and cleared at every normal
	// exit, so finding it set on entry means the last invocation did not
	// finish. Log once, then give up on replays.
	if (g_bRplSampling)
	{
		g_bRplSampling = false;
		LogError("pug: replay sampler aborted mid-frame at frame %d; recording disabled for this match", g_iReplayFrames);
		RplFail();
		return Plugin_Stop;
	}
	g_bRplSampling = true;

	if (g_hReplay == null)
	{
		g_bRplSampling = false;
		g_hReplayTimer = null;
		return Plugin_Stop;
	}

	int tMs = RoundMs();
	// -1 means the round is not live. Nothing to time a frame against, so
	// skip rather than write a frame the viewer cannot place.
	if (tMs < 0)
	{
		g_bRplSampling = false;
		return Plugin_Continue;
	}

	// Keyframe BEFORE the frame is written, so the recorded offset is where
	// this frame actually begins.
	if (tMs - g_iRplLastKeyMs >= RPL_KEYFRAME_MS)
	{
		g_hRplIndexT.Push(tMs);
		g_hRplIndexOff.Push(g_iReplayBytes);
		g_iRplLastKeyMs = tMs;
	}

	bool sampleEntities = g_iRplEntityEveryN > 0 && (g_iRplFrameNo % g_iRplEntityEveryN) == 0;
	g_iRplFrameNo++;

	// One pass over clients, building both the slot lookup and the list of
	// non-rostered clients. The naive version loops MaxClients once per slot,
	// which is eight times the work for no benefit.
	int slotClient[RPL_SLOTS];
	int bots[MAXPLAYERS + 1];
	int botCount = 0;
	for (int c = 1; c <= MaxClients; c++)
	{
		if (!IsClientInGame(c)) continue;
		int slot = g_iClientRoster[c];
		if (slot >= 0 && slot < RPL_SLOTS) slotClient[slot] = c;
		else if (IsPlayerAlive(c)) bots[botCount++] = c;
	}

	// Player block first, at a fixed offset, then entities appended after it.
	// The entity count is not known until they are gathered, so the frame
	// header is patched once the whole frame is packed.
	int p = RPL_FRAME_HEADER;
	float pos[3], ang[3];

	for (int slot = 0; slot < RPL_SLOTS; slot++)
	{
		int client = slotClient[slot];
		if (client == 0)
		{
			// Empty slot: an all-zero record, which decodes as state 0, which
			// is "not present". Distinct from a dead player, who is PRESENT
			// with ALIVE clear.
			for (int i = 0; i < RPL_PLAYER_RECORD; i++) p = RplU8(p, 0);
			continue;
		}
		GetClientAbsOrigin(client, pos);
		GetClientEyeAngles(client, ang);

		bool survivor = GetClientTeam(client) == TEAM_SURVIVOR;
		int temp = 0, weaponId = 0, clip = 0, reserve = 0;
		if (survivor)
		{
			// Temporary health decays continuously, so it is a float on the
			// entity and has to be floored rather than read as an int. It is
			// carried separately from permanent health because the viewer
			// draws a two-tone bar, and because a temp health jump is the
			// signal the deferred pills detection will need.
			float tempF = GetEntPropFloat(client, Prop_Send, "m_healthBuffer");
			if (tempF > 0.0) temp = RoundToFloor(tempF);

			int wep = GetEntPropEnt(client, Prop_Send, "m_hActiveWeapon");
			if (wep > 0 && IsValidEntity(wep))
			{
				char wcls[64];
				GetEntityClassname(wep, wcls, sizeof(wcls));
				weaponId = RplWeaponId(wcls);
				clip = GetEntProp(wep, Prop_Send, "m_iClip1");
				int ammoType = GetEntProp(wep, Prop_Send, "m_iPrimaryAmmoType");
				if (ammoType >= 0) reserve = GetEntProp(client, Prop_Send, "m_iAmmo", _, ammoType);
			}
		}

		p = RplI16(p, RoundToNearest(pos[0]));
		p = RplI16(p, RoundToNearest(pos[1]));
		p = RplI16(p, RoundToNearest(pos[2]));
		p = RplI16(p, RoundToNearest(ang[1] * 100.0));    // yaw, 0.01 degree
		// Pitch is -89..89 degrees, so its low byte IS its int8 two's
		// complement representation. The mask is what makes that explicit.
		p = RplU8(p, RoundToNearest(ang[0]) & 0xFF);
		p = RplU8(p, RplClientState(client, RplIsGhost(client)));
		// Clamped, not packed raw: health is negative on a dead player and clip
		// is -1 for a clipless weapon, and either would wrap to about 65535.
		p = RplU16(p, RplClampU16(GetClientHealth(client)));
		p = RplU16(p, RplClampU16(temp));
		// Version 2: this byte is the survivor character for a survivor and
		// the zombie class for an infected. It was always 0 for survivors
		// before, so this fills a field rather than growing the record, which
		// is why no offset below this line moves.
		//
		// Guarded, not read blind: an absent netprop throws, and a throw here
		// takes the whole match's recording down through the latch and
		// RplFail. Falling back to 0 costs a neutral portrait for the round.
		//
		// Only m_survivorCharacter is guarded. m_zombieClass beside it is read
		// blind on purpose: it has shipped in production on this exact engine
		// build since long before version 2 (see the reads in the tank and
		// boomer paths below), so its presence is established by the plugin
		// having run, not assumed. m_survivorCharacter arrived with this
		// change and has never run anywhere.
		p = RplU8(p, survivor
			? (g_bRplHasSurvChar ? GetEntProp(client, Prop_Send, "m_survivorCharacter") : 0)
			: GetEntProp(client, Prop_Send, "m_zombieClass"));
		p = RplU8(p, weaponId);
		p = RplU16(p, RplClampU16(clip));
		p = RplU16(p, RplClampU16(reserve));
	}

	int entCount = 0;

	// Non-rostered clients: survivor bots, AI specials, the AI tank. Iterated
	// rather than tracked, because MaxClients is under twenty and because
	// OnEntityCreated does not usefully report a bot taking a slot.
	for (int i = 0; i < botCount && entCount < RPL_MAX_ENTITIES; i++)
	{
		int c = bots[i];
		int kind = RplBotKind(c);
		if (kind == 0) continue;
		GetClientAbsOrigin(c, pos);
		p = RplU16(p, c);
		p = RplU8(p, kind);
		p = RplU8(p, RplClientState(c, RplIsGhost(c)));
		p = RplI16(p, RoundToNearest(pos[0]));
		p = RplI16(p, RoundToNearest(pos[1]));
		p = RplI16(p, RoundToNearest(pos[2]));
		p = RplU16(p, RplClampU16(GetClientHealth(c)));
		entCount++;
	}

	// World entities, from the incrementally maintained set. Walked backwards
	// so erasing a stale ref does not skip the next element.
	if (sampleEntities)
	{
		for (int i = g_hRplEnts.Length - 1; i >= 0; i--)
		{
			int ref = g_hRplEnts.Get(i);
			int ent = EntRefToEntIndex(ref);
			if (ent == INVALID_ENT_REFERENCE || !IsValidEntity(ent))
			{
				// OnEntityDestroyed is the normal removal path; this catches
				// anything that slipped past it, e.g. across a map change.
				g_hRplEnts.Erase(i);
				continue;
			}
			if (entCount >= RPL_MAX_ENTITIES) break;
			char cls[64];
			GetEntityClassname(ent, cls, sizeof(cls));
			int kind = RplWorldKind(cls);
			if (kind == 0) continue;
			GetEntPropVector(ent, Prop_Send, "m_vecOrigin", pos);
			p = RplU16(p, ent);
			p = RplU8(p, kind);
			p = RplU8(p, RPL_S_ALIVE);
			p = RplI16(p, RoundToNearest(pos[0]));
			p = RplI16(p, RoundToNearest(pos[1]));
			p = RplI16(p, RoundToNearest(pos[2]));
			// A rock has no meaningful health. A witch's is what makes a crown
			// visible in the timeline, so it is worth the two bytes.
			p = RplU16(p, RplClampU16(kind == RPL_K_TANK_ROCK ? 0 : GetEntProp(ent, Prop_Data, "m_iHealth")));
			entCount++;
		}
	}

	// Patch the frame header now that the count is known.
	RplU32(0, tMs);
	RplU16(4, entCount);
	RplU16(6, 0);

	// One call for the whole frame. No FlushFile, ever: the page cache serves
	// a tailing reader on this box, and a 10Hz flush is the most direct way to
	// turn an estimated cost into a measured stall.
	if (!WriteFile(g_hReplay, g_iRplBuf, p, 1))
	{
		g_bRplSampling = false;
		LogError("pug: replay frame write failed at frame %d; recording disabled for this match", g_iReplayFrames);
		RplFail();
		return Plugin_Stop;
	}
	g_iReplayFrames++;
	g_iReplayBytes += p;

	// The plugin's half of the disk protection. SourceMod exposes no
	// disk-free-space native, so the backend owns the real free-space floor
	// and this is a runaway bound: a full round is 10 to 15 MB, the default
	// cap is 64. Hitting it closes cleanly, keeping every frame so far.
	if (g_iReplayBytes >= g_cvReplayMaxMb.IntValue * 1024 * 1024)
	{
		g_bRplSampling = false;
		LogError("pug: replay hit the %d MB cap after %d frames; closing this round's file",
			g_cvReplayMaxMb.IntValue, g_iReplayFrames);
		RplClose();
		return Plugin_Stop;
	}
	g_bRplSampling = false;
	return Plugin_Continue;
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
/** Roster everyone on a side right now: survivors -> pug team a, infected -> b.
 *  Capped at MAX_ROSTER; extras are left unrostered and unscored rather than
 *  failing, because at go-live there is nobody to hand an error to. */
int SnapshotRoster()
{
	for (int i = 1; i <= MaxClients; i++)
	{
		if (!IsClientInGame(i) || IsFakeClient(i)) continue;
		int team = GetClientTeam(i);
		if (team != TEAM_SURVIVOR && team != TEAM_INFECTED) continue;
		if (g_iRosterCount >= MAX_ROSTER)
		{
			PugDebug("snapshot: roster full, leaving %N unrostered", i);
			continue;
		}
		char id[32];
		if (!GetClientAuthId(i, AuthId_SteamID64, id, sizeof(id)))
		{
			// No kick here: an unauthenticated client just goes unscored.
			PugDebug("snapshot: could not auth %N, leaving unrostered", i);
			continue;
		}
		int slot = g_iRosterCount++;
		strcopy(g_sRosterId[slot], 32, id);
		g_iRosterTeam[slot] = (team == TEAM_SURVIVOR) ? 1 : 2;
		SanitizeName(i, g_sRosterName[slot], 64);
		g_iClientRoster[i] = slot;
	}
	g_iPugSide[1] = TEAM_SURVIVOR;
	g_iPugSide[2] = TEAM_INFECTED;
	return g_iRosterCount;
}

/** The MATCH_CREATE / MATCH_ROSTER xN / MATCH_CREATE_END burst the backend
 *  adopts a self-started match from. */
void EmitRosterBurst()
{
	EmitPug("MATCH_CREATE map=%s players=%d", g_sCurrentMap, g_iRosterCount);
	for (int i = 0; i < g_iRosterCount; i++)
	{
		// name= is deliberately LAST on the line: in-game names contain spaces,
		// so the backend parser takes the entire remainder as the name.
		EmitPug("MATCH_ROSTER steamid=%s team=%s name=%s",
			g_sRosterId[i], g_iRosterTeam[i] == 1 ? "a" : "b", g_sRosterName[i]);
	}
	EmitPug("MATCH_CREATE_END players=%d", g_iRosterCount);
}

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

	g_State = MS_Pending;
	if (g_cvRosterAtLive.BoolValue)
	{
		// Deferred roster: nothing is recorded yet, so a !mix between now and
		// the first go-live still lands in the roster. OnRoundIsLive takes the
		// snapshot and emits the burst; the backend adopts the match then.
		PugDebug("self-started match token=%s, roster deferred to first go-live", g_sToken);
	}
	else
	{
		SnapshotRoster();
		// Announce before the exec: the config ends in sm_restartmap, so clients are
		// about to cycle. The backend needs the roster in hand before that happens.
		EmitRosterBurst();
	}
	StartMatchDemo();

	char cfg[64];
	g_cvPugConfig.GetString(cfg, sizeof(cfg));
	PugDebug("self-started match token=%s roster=%d cfg=%s", g_sToken, g_iRosterCount, cfg);
	ServerCommand("exec %s", cfg);

	if (g_cvRosterAtLive.BoolValue)
		PrintToChatAll("[PUG] Match created. Teams are recorded when the first round goes live. Ready up.");
	else
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
	g_bReplayFailed = false;
	g_iRplMapSeq = 0;
	g_bRplFirstMapSeen = false;
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
		ClearPinRelease(i);
	}
	ClearFriendlyFire();
	ResetSkillStats();

	// Last, after every field above has been cleared. RplClose can in
	// principle throw, and an unwind partway through this function would
	// leave g_State, g_sToken and g_bPendingFinalize describing a match that
	// no longer exists. Closing a leftover file matters far less than that,
	// so it goes at the end where a throw can only cost the caller its reply.
	RplClose();
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
	// Testing switch: the vote above still tracks orientation for scoring, but
	// nobody is moved. Never leave this off for a real ranked match.
	if (!g_cvTeamLock.BoolValue) return Plugin_Continue;

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

/** Close the replay at level shutdown, which is the only moment the recorder
 *  can still shut down cleanly across a changelevel.
 *
 *  This forward runs before SourceMod frees the map's TIMER_FLAG_NO_MAPCHANGE
 *  timers, so g_hReplayTimer is still a live handle here and the file still
 *  gets its keyframe index and frame count. Doing it in OnMapStart instead
 *  would mean killing an already-freed timer, which throws; that is why
 *  OnMapStart's own belt-and-braces RplClose is ordered AFTER its
 *  g_bPendingFinalize failsafe rather than before it. */
public void OnMapEnd()
{
	RplClose();
}

public void OnMapStart()
{
	// Past the finale, FinalizeMap never runs (it lives behind the MS_Live
	// guard in Event_RoundEnd), so nothing else would advance the replay map
	// sequence and every post-finale map would reuse one ordinal and overwrite
	// the map before it. Advance it here instead. Deliberately MS_Ended only:
	// during a live match FinalizeMap owns this counter, and incrementing it
	// in both places would skip an ordinal on every map.
	// MS_None (standalone) and MS_Ended (past a finale) only. NOT MS_Pending:
	// a self-started match sits in Pending across the config's sm_restartmap,
	// and incrementing there would put the first map at ordinal 1 while
	// FinalizeMap still counts it as 0, so every replay would be off by one
	// against the map the backend recorded.
	if ((g_State == MS_None || g_State == MS_Ended) && g_sToken[0] != '\0') g_iRplMapSeq++;

	// Failsafe for the score-read/changelevel race: a 2nd-half round_end set
	// g_bPendingFinalize, but the map changed before FinalizeMap ran (e.g. the
	// delayed score-read retry chain (up to ~8s) was still in flight and got
	// silently dropped by TIMER_FLAG_NO_MAPCHANGE). Finalize now with whatever
	// half scores were accumulated so this map can never vanish from the record.
	// Must run before the per-map resets below and before the finale check, so
	// a finale-triggering MATCH_END totals include this map.
	//
	// This is the FIRST statement of the forward on purpose. RplClose below
	// can in principle throw, and an unwind before this line costs a map its
	// result: no replay problem is ever allowed to do that.
	if (g_bPendingFinalize) FinalizeMap();

	// Belt and braces to OnMapEnd: a changelevel is not a round_end, and a
	// replay left open across one (e.g. the plugin was loaded mid-map, so no
	// OnMapEnd ran for it) would otherwise keep writing into a file whose
	// round is gone. Safe to call unconditionally; RplClose is a no-op when
	// nothing is open.
	RplClose();

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

/** Fill the roster arrays from whoever is on a team right now, WITHOUT starting
 *  a match.
 *
 *  This is what lets standalone recording reuse the sampler unchanged: the frame
 *  writer already resolves players through g_iClientRoster and names the header's
 *  slot table from g_sRosterId, so populating those is the whole job.
 *
 *  Safe to do at MS_None because nothing else in this plugin acts on a roster
 *  while there is no tracked match. Roster kick enforcement, the team lock, the
 *  stat counters, EmitEvent and chat are each gated on match state, so none of
 *  them can observe what this writes. A real match overwrites all of it:
 *  Cmd_LoadPug calls ResetMatchState first, and Cmd_Match rebuilds the roster. */
void RplFillStandaloneRoster()
{
	for (int i = 0; i <= MAXPLAYERS; i++) g_iClientRoster[i] = -1;
	g_iRosterCount = 0;
	for (int i = 1; i <= MaxClients && g_iRosterCount < MAX_ROSTER; i++)
	{
		if (!IsClientInGame(i) || IsFakeClient(i)) continue;
		int team = GetClientTeam(i);
		if (team != TEAM_SURVIVOR && team != TEAM_INFECTED) continue;
		char id[32];
		// Unauthenticated clients simply go unrecorded, exactly as they go
		// unscored in a real match. Never a kick, never an error.
		if (!GetClientAuthId(i, AuthId_SteamID64, id, sizeof(id))) continue;
		int slot = g_iRosterCount++;
		strcopy(g_sRosterId[slot], 32, id);
		g_iRosterTeam[slot] = (team == TEAM_SURVIVOR) ? 1 : 2;
		g_iClientRoster[i] = slot;
	}
}

/** Rotoblin ready-up go-live signal (global forward; fires even if we never call
 *  the readyup natives). First live round flips Pending -> Live. */
public void OnRoundIsLive()
{
	g_bHalfWasLive = true;
	if (g_State == MS_Pending && g_bSelfStarted && g_iRosterCount == 0)
	{
		// sm_pug_roster_at_live: the roster is whoever is on a side at this
		// moment, after any !mix that happened during ready-up.
		int n = SnapshotRoster();
		if (n == 0)
		{
			PrintToChatAll("[PUG] Nobody was on a team at go-live; the match is not tracked.");
			ResetMatchState();
			return;
		}
		EmitRosterBurst();
		PrintToChatAll("[PUG] Teams recorded: %d players.", n);
	}
	if (g_State == MS_Pending)
	{
		g_State = MS_Live;
		SampleSkillDetect();
		EmitPug("MATCH_START map=%s", g_sCurrentMap);
	}

	// readyup's go-live forward fires for every round on the box, PUG match or
	// not, so gate this on an actually-tracked match.
	if (g_State == MS_Live)
	{
		// Derived from the engine, never counted. This used to be g_iHalf++,
		// which walked past 2 whenever the go-live forward re-fired (an admin
		// restarting a live round mid-half is enough). The backend accepts
		// only half 1 or 2, so from that point on the map's ROUND_START and
		// ROUND_END were dropped AND every EVENT carried half=-1, the sentinel
		// for "no round timing", silently poisoning the rest of the timeline.
		// m_bInSecondHalfOfRound is the same property Event_RoundEnd already
		// trusts for the `second` flag that drives FinalizeMap, so reading it
		// here makes the round row's half agree with it by construction.
		g_iHalf = view_as<bool>(GameRules_GetProp("m_bInSecondHalfOfRound")) ? 2 : 1;
		g_fRoundLiveAt = GetGameTime();
		char surv[2];
		SurvPugTeam(surv, sizeof(surv));
		// An empty side means the orientation mapping has not settled. Emit
		// the line WITHOUT surv= rather than guessing "a": ROUND_END is one UDP
		// datagram with no retransmit, so a guess here survives as a fabricated
		// side marked reliable whenever that datagram is lost. The backend
		// accepts a sideless ROUND_START, records the round unreliable, and
		// promotes it when ROUND_END supplies the real side. The line still
		// goes out so the round keeps a started_at, which every event's t is
		// measured against.
		if (surv[0] == '\0') EmitPug("ROUND_START map=%s half=%d", g_sCurrentMap, g_iHalf);
		else EmitPug("ROUND_START map=%s half=%d surv=%s", g_sCurrentMap, g_iHalf, surv);

		RplOpen();
	}
	else if (g_State == MS_None && g_cvReplayStandalone.BoolValue)
	{
		// A round went live with no tracked match: a !mix night, a scrim,
		// anything that readyup drives without this plugin being told about
		// it. Record it anyway. Nothing here emits to the backend, creates a
		// match, or changes g_State, so the plugin stays exactly as inert as
		// it was; the only product is a file on disk.
		//
		// A fresh session token per CAMPAIGN, so a night's files group into
		// campaign-sized units instead of accumulating under one token for
		// thirty maps. g_iRplMapSeq restarts with it, so ordinals read as
		// chapter numbers within the campaign.
		//
		// L4D_IsFirstMapInScenario is registered optional by left4dhooks, and
		// calling an unbound native throws. A throw here would unwind the
		// go-live forward, which is the one place in this plugin that must
		// never fail, so it is feature-checked rather than trusted. Absent, the
		// session simply keeps its existing token, which is the old behaviour.
		GetCurrentMap(g_sCurrentMap, sizeof(g_sCurrentMap));
		bool firstMap = GetFeatureStatus(FeatureType_Native, "L4D_IsFirstMapInScenario") == FeatureStatus_Available
			&& L4D_IsFirstMapInScenario();
		if (g_sToken[0] == '\0' || (firstMap && !g_bRplFirstMapSeen))
		{
			GenerateToken(g_sToken, sizeof(g_sToken));
			g_iRplMapSeq = 0;
			PugDebug("replay: new standalone session %s on %s", g_sToken, g_sCurrentMap);
		}
		g_bRplFirstMapSeen = firstMap;
		RplFillStandaloneRoster();
		g_iHalf = view_as<bool>(GameRules_GetProp("m_bInSecondHalfOfRound")) ? 2 : 1;
		g_fRoundLiveAt = GetGameTime();
		RplOpen();
	}
	else if (g_State == MS_Ended && g_cvReplayAfterEnd.BoolValue)
	{
		// Recording only, past the finale. Deliberately emits NO ROUND_START
		// and touches no score, side or roster state: the match result has
		// already been reported and a late round row would corrupt a record
		// the backend considers final. The only things set are the two values
		// the recorder itself needs, the half and the round's time origin that
		// every frame's t_ms is measured from.
		g_iHalf = view_as<bool>(GameRules_GetProp("m_bInSecondHalfOfRound")) ? 2 : 1;
		g_fRoundLiveAt = GetGameTime();
		RplOpen();
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
		ClearPinRelease(i);
	}
	// Anything still pending belongs to the round that just finished and has
	// already been flushed by Event_RoundEnd. Dropping it here rather than
	// carrying it forward keeps a stale pair from being stamped with the new
	// round's clock.
	ClearFriendlyFire();
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
	if (g_State != MS_Live || g_bRoundEnded || !g_bHalfWasLive)
	{
		// Recording past the finale: no scoring happens here, but the file
		// still has to be closed so it gets its keyframe index and frame
		// count rather than being left in the never-closed state.
		if (g_State != MS_Live && g_hReplay != null)
		{
			g_fRoundLiveAt = 0.0;
			RplClose();
		}
		return;
	}
	g_bRoundEnded = true;
	bool second = view_as<bool>(GameRules_GetProp("m_bInSecondHalfOfRound"));
	int survPug = ObserveSurvivorPugTeam();
	if (second) g_bPendingFinalize = true;

	// Captured now, not re-derived in the timer: the next half's go-live
	// rewrites g_iHalf and the team lock timer can flip g_iPugSide before
	// Timer_ReadScore's retry chain (2-8s out) ever fires. See EmitRoundEnd.
	int half = g_iHalf;
	char survEnd[2];
	SurvSideOf(survPug, survEnd, sizeof(survEnd));

	// Flush here, while this round's clock is still valid: g_iHalf still names
	// this half and EmitRoundEnd has not yet zeroed g_fRoundLiveAt. Left to
	// the periodic sweep, the last burst of a round would be stamped t=-1.
	FlushFriendlyFire();

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
	// Advanced BEFORE the MAX_MAPS guard below, and never capped, so replay
	// filenames keep getting fresh ordinals after the score table stops
	// growing. Below the cap this stays equal to g_iMapCount.
	g_iRplMapSeq++;
	if (g_iMapCount >= MAX_MAPS) return;
	strcopy(g_sMapName[g_iMapCount], 64, g_sCurrentMap);
	g_iMapScoreA[g_iMapCount] = g_iHalfScoreA;
	g_iMapScoreB[g_iMapCount] = g_iHalfScoreB;
	g_iMapCount++;
	// No g_iHalf reset here any more. It was needed while the half was a
	// counter that had to restart at each map; it is now read from
	// m_bInSecondHalfOfRound every time a half goes live, so zeroing it would
	// only create a window where events carry half=0.
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

		int zc = GetEntProp(attacker, Prop_Send, "m_zombieClass");

		// The same damage, split by what it actually ate. Damage to a survivor
		// already down only drains a bleedout pool, runs into the thousands and
		// says nothing about the play; damage to one still standing is the real
		// output. Both are recorded rather than the first being discarded, so
		// that the parts sum to damage_as_si exactly:
		//
		//   dmg_as_hunter + dmg_as_smoker + dmg_as_boomer + dmg_as_tank
		//     + dmg_to_incapped == damage_as_si
		//
		// That invariant is the point of keeping boomer, whose direct damage is
		// otherwise negligible: a drifting total means a class going
		// unaccounted, which is checkable rather than merely hoped for.
		if (GetEntProp(victim, Prop_Send, "m_isIncapacitated") != 0)
		{
			AddStat(attacker, PS_DmgToIncapped, damage);
		}
		else
		{
			switch (zc)
			{
				case ZC_HUNTER: AddStat(attacker, PS_DmgAsHunter, damage);
				case ZC_SMOKER: AddStat(attacker, PS_DmgAsSmoker, damage);
				case ZC_BOOMER: AddStat(attacker, PS_DmgAsBoomer, damage);
				case ZC_TANK:   AddStat(attacker, PS_DmgAsTank, damage);
			}
		}

		if (zc == ZC_TANK)
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
		// Accumulated, not emitted here. player_hurt fires once per bullet and
		// once per shotgun pellet, and every recorded event makes the backend
		// broadcast 'live', which makes every connected spectator refetch the
		// whole /api/live payload. Emptying an SMG into a teammate used to
		// mean ~20 log lines on the game thread, 20 upserts and 20 full
		// refetches per viewer. One burst now produces one event carrying the
		// total. The counter above still moves per hit and stays
		// authoritative; only the EVENT is coalesced.
		AccumulateFriendlyFire(attacker, victim, damage);
	}
	else if (siVictim && remaining > 0)
	{
		g_iStatSiDmg[slot] += damage;
	}
}

/** Add one friendly fire hit to its attacker/victim pair, emitting early if
 *  the pair has already piled up enough damage to be worth reporting now.
 *  Called only from the StatsActive-gated part of Event_PlayerHurt. */
void AccumulateFriendlyFire(int attacker, int victim, int damage)
{
	if (attacker < 1 || attacker > MaxClients || victim < 1 || victim > MaxClients) return;
	g_iFfPending[attacker][victim] += damage;
	if (g_iFfPending[attacker][victim] >= FF_FLUSH_DAMAGE) EmitPendingFf(attacker, victim);
}

/** Emit one pair's accumulated friendly fire as a single event and clear it.
 *
 *  EmitEvent rather than EmitClientEvent on purpose: the damage was accrued
 *  under the StatsActive gate at the time it happened, and this may run from
 *  the sweep or from Event_RoundEnd, by which point that gate reads false. Its
 *  roster and MS_Live checks still apply, so an unrostered attacker is still
 *  dropped. */
void EmitPendingFf(int attacker, int victim)
{
	int total = g_iFfPending[attacker][victim];
	if (total <= 0) return;
	g_iFfPending[attacker][victim] = 0;
	EmitEvent("ff", attacker, victim, total);
}

/** Sweep every pending pair out as events. Bounded by MaxClients squared,
 *  which on this box is a few hundred integer reads. */
void FlushFriendlyFire()
{
	for (int a = 1; a <= MaxClients; a++)
	{
		for (int v = 1; v <= MaxClients; v++)
		{
			if (g_iFfPending[a][v] > 0) EmitPendingFf(a, v);
		}
	}
}

void ClearFriendlyFire()
{
	for (int a = 0; a <= MAXPLAYERS; a++)
		for (int v = 0; v <= MAXPLAYERS; v++)
			g_iFfPending[a][v] = 0;
}

public Action Timer_FlushFf(Handle timer)
{
	if (g_State == MS_Live) FlushFriendlyFire();
	return Plugin_Continue;
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
	// PinCreditable also accepts a link released a moment ago, which is the
	// whole smoker case: tongue_release reaches the link before this handler.
	int freed = 0;
	for (int i = 1; i <= MaxClients; i++)
	{
		if (!PinCreditable(i, victim)) continue;
		g_iPinnedBy[i] = 0;
		ClearPinRelease(i);
		// A pinned survivor killing their own pinner is a self-clear, which
		// skill_detect counts under its own key. Emitting "cleared" for it
		// would read as clearing a teammate with actor and target identical.
		if (attacker == i) continue;
		freed++;
		EmitClientEvent("cleared", attacker, i, 0);
		// Freed from a tongue before the choking began, so they were never
		// dragged in. Hunters are excluded by construction: they do not choke,
		// so g_bChokeStarted would be false for every pounce clear too.
		if (g_bPinIsTongue[i] && !g_bChokeStarted[i]) AddStat(attacker, PS_TongueClears);
	}

	if (g_cvDebug.BoolValue && IsInfectedClient(victim))
	{
		PugDebug("SI death: victim=%d attacker=%d attackerSlot=%d freed=%d",
			victim, attacker, (attacker <= MaxClients) ? g_iClientRoster[attacker] : -1, freed);
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

	// The feed's "boom". Emitted from here rather than from skill_detect's
	// OnBoomerVomitLanded for two reasons: player_now_it is one of pug-match's
	// own hooks, so this kind is present even on a server with no skill_detect
	// loaded (which is the current state of the box), and it names the
	// survivor caught, which the forward's (boomer, amount) signature cannot.
	// One line per survivor caught, bounded by the four survivors and latched
	// by boomer life, so this cannot become a per-hit stream.
	EmitClientEvent("boom", g_iBoomerClient, GetClientOfUserId(event.GetInt("userid")), 0);
}

// ---------- live timeline: pin cycle, tank cycle, map hazards ----------

/** lunge_pounce: a hunter pins a survivor. */
public void Event_Pounce(Event event, const char[] name, bool dontBroadcast)
{
	int hunter = GetClientOfUserId(event.GetInt("userid"));
	int victim = GetClientOfUserId(event.GetInt("victim"));
	if (victim > 0 && victim <= MaxClients)
	{
		g_iPinnedBy[victim] = hunter;
		g_bPinIsTongue[victim] = false;
		g_bChokeStarted[victim] = false;
	}
	PugDebug("pin set (pounce): victim=%d pinner=%d", victim, hunter);
	EmitClientEvent("pinned", hunter, victim, 0);
}

/** tongue_grab: a smoker pins a survivor. */
public void Event_TongueGrab(Event event, const char[] name, bool dontBroadcast)
{
	int smoker = GetClientOfUserId(event.GetInt("userid"));
	int victim = GetClientOfUserId(event.GetInt("victim"));
	if (victim > 0 && victim <= MaxClients)
	{
		g_iPinnedBy[victim] = smoker;
		g_bPinIsTongue[victim] = true;
		g_bChokeStarted[victim] = false;
	}
	PugDebug("pin set (tongue): victim=%d pinner=%d", victim, smoker);
	EmitClientEvent("pinned", smoker, victim, 0);
}

/** Forget both the live link and any pending release for one client. */
void ClearPinRelease(int client)
{
	g_iPinReleasedFrom[client] = 0;
	g_fPinReleasedAt[client] = 0.0;
}

/** True when `victim` was being held by `pinner` recently enough that a kill
 *  landing now is what ended it. Covers the smoker case, where tongue_release
 *  beats player_death to the link by up to a second. */
bool PinCreditable(int victim, int pinner)
{
	if (victim < 1 || victim > MaxClients) return false;
	if (g_iPinnedBy[victim] == pinner) return true;
	return g_iPinReleasedFrom[victim] == pinner
		&& (GetGameTime() - g_fPinReleasedAt[victim]) <= PIN_RELEASE_GRACE;
}

/** tongue_release: the pull ended, for any reason including the smoker being
 *  shot off. The event carries no cause (userid, victim, distance only), so it
 *  cannot say which, and it arrives BEFORE the death that caused it. Record the
 *  release instead of erasing it and let Event_PlayerDeath decide; see
 *  g_iPinReleasedFrom. A release nobody kills for simply ages out. */
public void Event_TongueRelease(Event event, const char[] name, bool dontBroadcast)
{
	int victim = GetClientOfUserId(event.GetInt("victim"));
	if (victim > 0 && victim <= MaxClients)
	{
		if (g_iPinnedBy[victim] != 0)
		{
			g_iPinReleasedFrom[victim] = g_iPinnedBy[victim];
			g_fPinReleasedAt[victim] = GetGameTime();
		}
		g_iPinnedBy[victim] = 0;
	}
}

/** player_incapacitated_start: the bare player_incapacitated does not fire on
 *  this engine. */
public void Event_Incap(Event event, const char[] name, bool dontBroadcast)
{
	int victim = GetClientOfUserId(event.GetInt("userid"));
	int attacker = GetClientOfUserId(event.GetInt("attacker"));
	if (victim > 0 && victim <= MaxClients)
	{
		// A hard forget, not a recorded release: someone who has gone down was
		// not cleared, so a kill on their pinner afterwards earns no credit.
		g_iPinnedBy[victim] = 0;
		ClearPinRelease(victim);
	}
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
 *  over was the tank, this human has just TAKEN the tank.
 *
 *  No target: the party on the other side of the swap is the bot, which is
 *  never rostered and has no name worth putting in the feed. */
public void Event_BotPlayerReplace(Event event, const char[] name, bool dontBroadcast)
{
	int player = GetClientOfUserId(event.GetInt("player"));
	if (IsTankClient(player)) EmitClientEvent("tank_take", player, 0, 0);
}

/** player_bot_replace: a human is replaced by a bot, handing the tank back to
 *  the AI. The opposite direction from the above, and a different kind: one
 *  verb cannot honestly describe both taking and giving up control. */
public void Event_PlayerBotReplace(Event event, const char[] name, bool dontBroadcast)
{
	int player = GetClientOfUserId(event.GetInt("player"));
	if (IsTankClient(player)) EmitClientEvent("tank_give", player, 0, 0);
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

/** choke_start: the smoker has stopped dragging and started choking. The
 *  boundary a tongue clear is measured against; see g_bChokeStarted. */
public void Event_ChokeStart(Event event, const char[] name, bool dontBroadcast)
{
	int victim = GetClientOfUserId(event.GetInt("victim"));
	if (victim >= 1 && victim <= MaxClients) g_bChokeStarted[victim] = true;
}

/** pounce_stopped: a hunter's pounce ended and the event names who ended it.
 *
 *  This is the credit path for BOTH shove clears and kill clears on hunters.
 *  For a kill it fires just ahead of player_death, and because it clears the
 *  link here, the death handler then finds nothing and cannot double count.
 *
 *  Guarded three ways: the victim must actually have been pinned by this
 *  hunter (the event also fires with victim=0), a survivor already incapped was
 *  not cleared but lost, and freeing yourself is a self-clear that
 *  skill_detect counts under its own key. */
public void Event_PounceStopped(Event event, const char[] name, bool dontBroadcast)
{
	int stopper = GetClientOfUserId(event.GetInt("userid"));
	int victim = GetClientOfUserId(event.GetInt("victim"));
	if (victim < 1 || victim > MaxClients || stopper < 1 || stopper > MaxClients) return;
	if (g_iPinnedBy[victim] == 0) return;

	g_iPinnedBy[victim] = 0;
	ClearPinRelease(victim);

	if (stopper == victim) return;
	if (GetEntProp(victim, Prop_Send, "m_isIncapacitated") != 0) return;
	EmitClientEvent("cleared", stopper, victim, 0);
}
