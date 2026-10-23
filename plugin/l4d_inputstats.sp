/**
 * l4d_inputstats - input timing capture for macro detection.
 *
 * Design: docs/superpowers/specs/2026-09-21-input-macro-detection-design.md
 *
 * Captures the timing of button PRESS EDGES, and how long each press was held,
 * and ships one line per burst.
 * Since 0.4.0 it also keeps each survivor's last few hundred milliseconds of
 * view angles and ships one line per human SI kill (k=sikill), for the aim
 * rules (docs/superpowers/specs/2026-10-17-aimbot-rules-design.md).
 * It computes no verdicts: every statistic and
 * threshold lives on the web side, so a signature can be improved and re-run
 * over stored history without anything being redeployed to a game server. That
 * matters here because the cheats are frozen (nobody writes new ones for a 2008
 * game) while our tooling is not.
 *
 * THIS PLUGIN IS INCAPABLE OF CHANGING THE GAME: it hooks OnPlayerRunCmdPre,
 * whose parameters are read-only by signature. That is also why it sees the
 * player's real input rather than whatever a rate-clamping plugin left behind.
 */
#pragma semicolon 1
#pragma newdecls required
#include <sourcemod>
#include <sdktools>
#include "pug-logauth.inc"

#define PLUGIN_VERSION "0.5.0"

/** A burst closes after this much silence: 300 ms, which is 30 ticks at 100
 *  tick and 38 at 128 (g_iBurstGap, set from the tick interval; 0.4.0 and
 *  earlier had 30 fixed, so at 128 a burst closed after 234 ms). Measured, not
 *  guessed: a human sample containing one 31-second idle gap had its
 *  coefficient of variation dragged to 6.85, hiding everything. It is also the
 *  cap on an interval or a hold on the wire ("30 or more" at 100 tick), so
 *  src/inputStats.ts burstMaxTicks computes the same number the same way.
 *
 *  Counted in USERCMDS, like every interval here. A client sends one usercmd
 *  per tick, so for a healthy connection the two are the same number. They
 *  part company after a lag spike, when the server runs a backlog of usercmds
 *  inside one tick: timed by GetGameTickCount those presses were zero ticks
 *  apart and were silently dropped, which bent exactly the bursts of the
 *  players with the worst connections. cmdnum counts the commands the client
 *  actually generated, survives loss (it skips, the hook does not fire for a
 *  command that never arrived) and is the clock the button samples are on. */
int g_iBurstGap = 30;
/** The largest g_iBurstGap ever gets: 38, the value at 128 tick, encodes as
 *  'U'. Past it the alphabet would reach '[' and '\', so a server above 128
 *  tick (which the web refuses anyway) still never sends one. */
#define MAX_BURST_GAP 38

/** The server's tick rate, sent as `rate=` on burst and stall lines (0.5.0)
 *  so the web reads every tick count at the rate it was recorded at. */
int g_iTickRate = 100;

/** A stall shorter than this is ordinary choke and not worth a line; longer
 *  than g_iStallMax is a hitch, a load or a pause, not a cheat setting. 80 ms
 *  and one second: 8 and 100 ticks at 100 tick, 10 and 128 at 128. Same
 *  rounding as ticksAtLeast and ticksAtMost in src/inputStats.ts, so the
 *  lines start exactly where the web's fakelag window does. */
int g_iStallMin = 8;
int g_iStallMax = 100;
/** Stall lines per player per round, so a dying connection cannot flood. */
#define STALL_BUDGET 200

/** Must match the newest `v` src/logParse.ts accepts. 2: intervals in
 *  usercmds, `ct` really is the client tickcount, `sp` added. Still 2 with
 *  `rate=` added in 0.5.0: a parser that does not know the key ignores it, and
 *  at 100 tick nothing else on the line changed. */
#define WIRE_VERSION 2

/** Matches MAX_INTERVALS in src/inputStats.ts. A burst longer than this stops
 *  recording rather than wrapping, so one pathological or hostile player cannot
 *  flood the wire or the table. */
#define MAX_INTERVALS 256

/**
 * Bursts per player per round, PER KIND. Same reason.
 *
 * This was one budget of 64 shared by all three kinds, reset at round_start.
 * round_start fires BEFORE ready-up, and every bunnyhop is its own line, so a
 * player hopping around the saferoom while waiting to ready could spend the
 * whole budget before the round was live, and then nothing they did in the
 * round was captured, in silence. Now each kind has its own, so hopping cannot
 * starve fire or pounce; the budgets are refilled when the round actually goes
 * live (OnRoundIsLive, from l4dready); and the first burst a budget refuses
 * emits one `cap` marker so the web can say "capture truncated" instead of
 * showing a quiet player.
 *
 * Sized for a live round with room to spare: at most 320 lines per player per
 * round, and a player who reaches any of them is worth a look for that alone.
 */
#define KIND_FIRE 0
#define KIND_POUNCE 1
#define KIND_BHOP 2
#define KIND_COUNT 3
int g_iBudget[KIND_COUNT] = { 128, 96, 96 };
char g_sKind[KIND_COUNT][8] = { "fire", "pounce", "bhop" };

/** One hold per PRESS, and a burst of N intervals has N + 1 presses. Must match
 *  MAX_HOLDS in src/inputStats.ts. */
#define MAX_HOLDS (MAX_INTERVALS + 1)

/** Two presses is noise and most of the volume. */
#define MIN_BURST_PRESSES 3

/** Must match ENC_BASE in src/inputStats.ts. */
#define ENC_BASE 48

#define TEAM_INFECTED 3
#define TEAM_SURVIVOR 2
/** m_zombieClass of the SI a kill line names. The tank (5) is not counted. */
#define ZC_SMOKER 1
#define ZC_BOOMER 2
#define ZC_HUNTER 3

/** The sikill line's own wire version. NOT WIRE_VERSION: src/logParse.ts
 *  still requires v=2 on the stall and burst lines, and reads this new shape
 *  as v=3. */
#define SIKILL_WIRE 3

/** View angles of the last ANG_RING usercmds per survivor: 400 ms at 100
 *  tick, 312 ms at 128, either way enough for the 300 ms before a kill. */
#define ANG_RING 40
#define PRE_SECONDS 0.3
#define BACK_SECONDS 1.0
/** Kills per survivor waiting on their one second look back. Nobody kills
 *  four SI inside a second; a fifth is simply not recorded. */
#define MAX_PENDING 4
#define PENDING_SLOTS ((MAXPLAYERS + 1) * MAX_PENDING)
/** g_fKillBack before any usercmd arrived after the kill: emitted as -1. */
#define BACK_NONE 999.0

ConVar g_cvEnabled;
ConVar g_cvBots;

int  g_iPrevButtons[MAXPLAYERS + 1];
bool g_bPrevGround[MAXPLAYERS + 1];
/** Whether the last usercmd was captured: alive and not a ghost. The edge of
 *  this is where a life ends, so it is where bursts in flight are emitted and
 *  the ground and air state is thrown away instead of leaking into the next. */
bool g_bCapturing[MAXPLAYERS + 1];
int  g_iBurstsThisRound[MAXPLAYERS + 1][KIND_COUNT];
bool g_bCapSent[MAXPLAYERS + 1][KIND_COUNT];

/** The client tickcount of the last usercmd seen, for a line emitted from an
 *  event rather than from inside the hook. */
int  g_iLastClientTick[MAXPLAYERS + 1];

// +attack burst, the `fire` anchor. Seq is the usercmd sequence (cmdnum), Tick
// is the server tick; intervals come from the first, the second rides along.
int g_iAtkTicks[MAXPLAYERS + 1][MAX_INTERVALS];
/**
 * How long each press was HELD, press edge to release edge, in usercmds. The
 * interval series says how often a button was pressed; this says what pressed
 * it. A mouse wheel has no held state, so every hold is one usercmd. A
 * scripted macro holds for a set time, so every hold is the same. A hand holds
 * for 5 to 12 ticks and never the same twice. Press rate cannot tell those
 * apart, and unlike a signature this cannot be backfilled: what was not
 * captured is gone, which is why it is captured now, before it is needed.
 *
 * 1..30 like an interval (1..38 at 128 tick), so it encodes the same way. The
 * cap means "that or more", and a press still down when its burst is emitted
 * records the time so far.
 */
int g_iAtkHolds[MAXPLAYERS + 1][MAX_HOLDS];
/** Where the press that is down right now goes when it is released: its index
 *  in the fire burst and in the air burst, or -1 when it belongs to neither. */
int g_iAtkHoldSlot[MAXPLAYERS + 1];
int g_iAirHoldSlot[MAXPLAYERS + 1];
int g_iAtkDownSeq[MAXPLAYERS + 1];
int g_iLastSeq[MAXPLAYERS + 1];
int g_iAtkCount[MAXPLAYERS + 1];
int g_iAtkPresses[MAXPLAYERS + 1];
int g_iAtkLastSeq[MAXPLAYERS + 1];
int g_iAtkFirstTick[MAXPLAYERS + 1];
int g_iAtkLastTick[MAXPLAYERS + 1];
/** The weapon in hand at the FIRST press of the burst. Read at emit time it
 *  was whatever the player had switched to by then, so a pistol burst followed
 *  by a swap to the shotgun was stored as a shotgun burst. */
char g_sAtkWeapon[MAXPLAYERS + 1][32];

// Airborne phase, the `pounce` anchor: presses between leaving the ground and
// landing again. A human issues one or two; a held button issues dozens.
int g_iAirTicks[MAXPLAYERS + 1][MAX_INTERVALS];
int g_iAirHolds[MAXPLAYERS + 1][MAX_HOLDS];
int g_iAirCount[MAXPLAYERS + 1];
int g_iAirPresses[MAXPLAYERS + 1];
int g_iAirLastSeq[MAXPLAYERS + 1];
int g_iAirStartSeq[MAXPLAYERS + 1];
int g_iAirFirstTick[MAXPLAYERS + 1];
int g_iAirLastTick[MAXPLAYERS + 1];
char g_sAirWeapon[MAXPLAYERS + 1][32];

// Stalls, the `stall` line (0.3.0): a stretch of server ticks in which a live
// player's usercmds stopped arriving, then arrived all at once. The server does
// not move a player it has no commands for, so they hang in place, even in the
// air, and the backlog runs in one tick: a warp nobody can shoot. A bad
// connection does it now and then on either team. Fakelag (Aimware's choke,
// confessed by the first confirmed cheater, match 631) does it on purpose, as
// infected, in the middle of a pounce: 29 of their stalls were mid-pounce,
// against at most 4 for anyone else on the fleet's l4d_cmd_budget logs.
// Only the shape is captured here; what counts as fakelag is the web's call.
int  g_iStTick[MAXPLAYERS + 1];		// server tick of the last usercmd, 0 = none this life
int  g_iStSeq[MAXPLAYERS + 1];		// its cmdnum
bool g_bStOpen[MAXPLAYERS + 1];		// a stall just ended; counting the backlog
int  g_iStGap[MAXPLAYERS + 1];		// ticks with no usercmd
int  g_iStMissed[MAXPLAYERS + 1];	// cmdnums skipped across it (lost, not held back)
int  g_iStCmds[MAXPLAYERS + 1];		// usercmds run in the tick it ended
int  g_iStTeam[MAXPLAYERS + 1];
int  g_iStClass[MAXPLAYERS + 1];
int  g_iStLunging[MAXPLAYERS + 1];
int  g_iStallsThisRound[MAXPLAYERS + 1];

// --- view angles and SI kills (0.4.0) ----------------------------------------
float g_fRingPitch[MAXPLAYERS + 1][ANG_RING];
float g_fRingYaw[MAXPLAYERS + 1][ANG_RING];
int   g_iRingTick[MAXPLAYERS + 1][ANG_RING];
int   g_iRingHead[MAXPLAYERS + 1];		// next slot to write
int   g_iRingLen[MAXPLAYERS + 1];		// entries written since the last reset

// One kill waiting on its look back, per slot. A client's slots are
// client * MAX_PENDING .. client * MAX_PENDING + MAX_PENDING - 1, flattened
// so no array needs a third dimension.
bool  g_bKillOpen[PENDING_SLOTS];
int   g_iKillSerial[PENDING_SLOTS];		// which timer owns the slot
float g_fKillRefPitch[PENDING_SLOTS];	// the view 300 ms before the kill
float g_fKillRefYaw[PENDING_SLOTS];
float g_fKillPre[PENDING_SLOTS];
float g_fKillBack[PENDING_SLOTS];		// closest to the reference since the kill
int   g_iKillHs[PENDING_SLOTS];
int   g_iKillDist[PENDING_SLOTS];
int   g_iKillClass[PENDING_SLOTS];
char  g_sKillWeapon[PENDING_SLOTS][32];
int   g_iKillSerialNext;

// Ground phase, the `bhop` anchor: how long a player stays on the ground before
// jumping again. A script jumps on the exact tick of landing, every time.
bool g_bGroundTimed[MAXPLAYERS + 1];
int  g_iGroundStartSeq[MAXPLAYERS + 1];
// A hop is one line, and its line waits for the jump button to come back up so
// it can carry how long the jump was held: a wheel-bound jump is one usercmd.
bool g_bHopPending[MAXPLAYERS + 1];
int  g_iHopGround[MAXPLAYERS + 1];
int  g_iHopDownSeq[MAXPLAYERS + 1];

public Plugin myinfo = {
	name = "L4D1 Input Stats",
	author = "Malevolence",
	description = "Ships input burst timing for macro detection. Captures only; never alters input.",
	version = PLUGIN_VERSION,
	url = "https://riversidepug.com",
};

public void OnPluginStart()
{
	CreateConVar("l4d_inputstats_version", PLUGIN_VERSION, "Input stats version",
		FCVAR_NOTIFY | FCVAR_DONTRECORD);
	// Signs the L4DM lines once the backend has pushed a secret; see the include.
	PugLogAuth_Init();
	g_cvEnabled = CreateConVar("l4d_inputstats_enabled", "1",
		"Capture and ship input burst timing.", FCVAR_NOTIFY, true, 0.0, true, 1.0);
	// TEST ONLY. Bots press buttons, which makes them the only way to exercise
	// this end to end without a human at a keyboard. Never enable it on a real
	// server: bot input is not evidence of anything and would pollute the data.
	g_cvBots = CreateConVar("l4d_inputstats_bots", "0",
		"TEST ONLY: also capture bots, so the pipeline can be exercised without a player.",
		FCVAR_NOTIFY, true, 0.0, true, 1.0);
	ReadTickRate();
	HookEvent("round_start", Event_RoundStart, EventHookMode_PostNoCopy);
	HookEvent("round_end", Event_RoundEnd, EventHookMode_PostNoCopy);
	HookEvent("player_death", Event_PlayerDeath);
	HookEvent("player_spawn", Event_PlayerSpawn);
	HookEvent("player_team", Event_PlayerTeam);
#if defined DEBUG
	RegAdminCmd("sm_inputstats_emit", Cmd_Emit, ADMFLAG_ROOT,
		"DEBUG BUILD: sm_inputstats_emit <fire|pounce|bhop> <intervals> | sikill | sikill_left - ship a synthetic line through the real encode and emit path.");
#endif
}

/** The rate is fixed for the life of the process (-tickrate), but reading it
 *  again on each map costs nothing and survives a late load. */
public void OnMapStart()
{
	ReadTickRate();
}

/**
 * Every tick count this plugin sends is at the server's rate, and the
 * thresholds that are really times scale with it. Integer arithmetic, the
 * same as the web's, so both sides land on the same tick:
 *   burst gap  300 ms  (rate * 3 + 5) / 10          30 at 100, 38 at 128
 *   stall min   80 ms  (75 * rate + 1000) / 1000      8 at 100, 10 at 128
 *   stall max    1 s   1005 * rate / 1000           100 at 100, 128 at 128
 */
void ReadTickRate()
{
	g_iTickRate = RoundToNearest(1.0 / GetTickInterval());
	g_iBurstGap = (g_iTickRate * 3 + 5) / 10;
	if (g_iBurstGap > MAX_BURST_GAP) g_iBurstGap = MAX_BURST_GAP;
	if (g_iBurstGap < 1) g_iBurstGap = 1;
	g_iStallMin = (75 * g_iTickRate + 1000) / 1000;
	g_iStallMax = 1005 * g_iTickRate / 1000;
}

#if defined DEBUG
/**
 * Exercises the real Encode and EmitLine path with known values, so the wire
 * format can be checked against the parser without a player at a keyboard.
 *
 * NOT IN THE SHIPPED PLUGIN. It was, as a ROOT command, and it attributed its
 * synthetic burst to the first human on the server: one mistyped command on a
 * live box and a real player has a fabricated 12/s burst against their name
 * in a table whose whole purpose is evidence. It now compiles only with
 * `spcomp l4d_inputstats.sp DEBUG=1`, and even then it only ever emits for a
 * fixed test steamid, never for a connected player.
 */
public Action Cmd_Emit(int client, int args)
{
	char kind[16], sn[8];
	GetCmdArg(1, kind, sizeof(kind));
	GetCmdArg(2, sn, sizeof(sn));
	// The sikill line, with angles run through the real AngleBetween: a
	// 180 degree turn for pre and a 10 degree pitch for back, so the wire
	// should read pre=180.0 back=10.0 (or back=-1.0 for the left case).
	if (StrEqual(kind, "sikill") || StrEqual(kind, "sikill_left")) {
		float pre = AngleBetween(0.0, 0.0, 0.0, 180.0);
		float back = StrEqual(kind, "sikill") ? AngleBetween(10.0, 0.0, 0.0, 0.0) : -1.0;
		EmitSiKillLine("76561197960287930", "test_weapon", 1, 512, pre, back, "hunter");
		ReplyToCommand(client, "[inputstats] emitted a synthetic %s line for the test steamid", kind);
		return Plugin_Handled;
	}
	int n = StringToInt(sn);
	bool hop = StrEqual(kind, "bhop");
	if (hop) n = 1;
	if ((!hop && !StrEqual(kind, "fire") && !StrEqual(kind, "pounce")) || n < 1 || n > MAX_INTERVALS) {
		ReplyToCommand(client, "usage: sm_inputstats_emit <fire|pounce|bhop> <intervals 1..%d> | sikill | sikill_left", MAX_INTERVALS);
		return Plugin_Handled;
	}
	int ticks[MAX_INTERVALS], holds[MAX_HOLDS];
	for (int i = 0; i < n; i++) ticks[i] = 7 + (i % 3);    // 7,8,9 repeating
	for (int i = 0; i <= n; i++) holds[i] = 3 + (i % 2);   // 3,4 repeating
	char d[MAX_INTERVALS + 1], h[MAX_HOLDS + 1];
	Encode(ticks, n, d, sizeof(d));
	Encode(holds, hop ? 1 : n + 1, h, sizeof(h));
	EmitLine("76561197960287930", kind, "test_weapon", n, 4, hop ? 0 : n + 1, GetGameTickCount(), 0, 0, d, h);
	ReplyToCommand(client, "[inputstats] emitted a synthetic %s burst of %d intervals for the test steamid", kind, n);
	return Plugin_Handled;
}
#endif

// A burst used to be emitted only by the NEXT press after it, or by a landing.
// The last burst of a life, a round or a session has no next press, so it was
// never emitted at all, and the last thing a player did before dying is not
// the burst to lose. Each of these ends emits what is in flight first.
public void OnClientDisconnect(int client)
{
	FlushAll(client);
	// The killer left before the look back: those kills go out as unknown.
	CloseKills(client);
	ResetClient(client);
}

public void Event_PlayerDeath(Event e, const char[] n, bool b)
{
	int client = GetClientOfUserId(e.GetInt("userid"));
	if (client < 1) return;
	// First, while the victim is still what they were: the record reads the
	// ATTACKER's ring and the victim's class, never the victim's capture.
	TakeSiKill(e, client);
	// A survivor who dies with kills still waiting never looks back.
	CloseKills(client);
	FlushAll(client);
	ResetCapture(client);
}

public void Event_PlayerSpawn(Event e, const char[] n, bool b)
{
	int client = GetClientOfUserId(e.GetInt("userid"));
	if (client > 0) ResetRing(client);
}

public void Event_PlayerTeam(Event e, const char[] n, bool b)
{
	int client = GetClientOfUserId(e.GetInt("userid"));
	if (client < 1) return;
	// Leaving the survivors is leaving: the look back is unknown.
	CloseKills(client);
	ResetRing(client);
}

/** Timers die with the map (TIMER_FLAG_NO_MAPCHANGE), so anything still
 *  waiting goes out now as unknown rather than never. */
public void OnMapEnd()
{
	for (int i = 1; i <= MaxClients; i++) CloseKills(i);
}

public void Event_RoundEnd(Event e, const char[] n, bool b)
{
	for (int i = 1; i <= MaxClients; i++) {
		FlushAll(i);
		ResetCapture(i);
	}
}

public void Event_RoundStart(Event e, const char[] n, bool b)
{
	for (int i = 1; i <= MaxClients; i++) ResetClient(i);
}

/**
 * l4dready's global forward, fired when the ready-up countdown ends and the
 * round is really live. A forward is only a public function with the right
 * name, so this needs no include and no dependency: on a server without
 * l4dready it is never called, and round_start above is the only refill.
 *
 * Budgets only. Bursts in flight are left alone.
 */
public void OnRoundIsLive()
{
	for (int i = 1; i <= MaxClients; i++) ResetBudget(i);
}

void ResetBudget(int c)
{
	for (int k = 0; k < KIND_COUNT; k++) {
		g_iBurstsThisRound[c][k] = 0;
		g_bCapSent[c][k] = false;
	}
	g_iStallsThisRound[c] = 0;
}

/** Emit whatever this client has in flight. Safe on anyone: a client with
 *  nothing buffered, or who is no longer in game, emits nothing. */
void FlushAll(int client)
{
	if (!g_bCapturing[client] || !IsClientInGame(client)) return;
	FlushFire(client);
	if (!g_bPrevGround[client]) FlushAir(client, g_iAirLastSeq[client]);
	FlushHop(client);
	// A stall that ended on the last tick of a life still goes out.
	if (g_bStOpen[client]) EmitStall(client);
}

void ResetClient(int c)
{
	g_iPrevButtons[c] = 0;
	ResetCapture(c);
	ResetBudget(c);
	ResetRing(c);
}

void ResetRing(int c)
{
	g_iRingHead[c] = 0;
	g_iRingLen[c] = 0;
}

/** Forget every burst in flight without emitting it, and nothing else: the
 *  round's burst budget and the previous button state both outlive this. */
void ResetCapture(int c)
{
	g_bCapturing[c] = false;
	g_bPrevGround[c] = true;
	g_iAtkCount[c] = 0; g_iAtkPresses[c] = 0;
	g_iAirCount[c] = 0; g_iAirPresses[c] = 0; g_iAirStartSeq[c] = 0;
	g_iAtkHoldSlot[c] = -1; g_iAirHoldSlot[c] = -1;
	g_bGroundTimed[c] = false;
	g_bHopPending[c] = false;
	// A stall is measured inside one life: the gap across a death or a ghost
	// phase is not a stall.
	g_iStTick[c] = 0;
	g_bStOpen[c] = false;
}

/**
 * Called once per usercmd. The first command of a new server tick closes the
 * previous one: if a stall ended there, its backlog is now counted and the
 * line goes out. A tick that runs backwards is a new map, never a stall.
 */
void TrackStall(int client, int tick, int seq)
{
	if (tick != g_iStTick[client]) {
		if (g_bStOpen[client]) EmitStall(client);
		int gap = tick - g_iStTick[client] - 1;
		if (g_iStTick[client] > 0 && gap >= g_iStallMin && gap <= g_iStallMax && seq > g_iStSeq[client]) {
			g_bStOpen[client] = true;
			g_iStGap[client] = gap;
			g_iStMissed[client] = seq - g_iStSeq[client] - 1;
			g_iStCmds[client] = 0;
			g_iStTeam[client] = GetClientTeam(client);
			// Read before the backlog runs: this is the state they hung in.
			g_iStClass[client] = g_iStTeam[client] == TEAM_INFECTED ? GetEntProp(client, Prop_Send, "m_zombieClass") : 0;
			g_iStLunging[client] = g_iStClass[client] == 3 ? Lunging(client) : -1;
		}
		g_iStTick[client] = tick;
	}
	g_iStSeq[client] = seq;
	if (g_bStOpen[client]) g_iStCmds[client]++;
}

/** 1 mid-pounce, 0 not, -1 unknown (not a hunter, or no ability entity). */
int Lunging(int client)
{
	int ability = GetEntPropEnt(client, Prop_Send, "m_customAbility");
	if (ability <= MaxClients || !IsValidEntity(ability) || !HasEntProp(ability, Prop_Send, "m_isLunging")) return -1;
	return GetEntProp(ability, Prop_Send, "m_isLunging");
}

/** Push this usercmd's view onto the ring, and bring every kill waiting on
 *  its look back closer if this view is nearer where the flick started. */
void TrackView(int client, const float angles[3], int tick)
{
	int h = g_iRingHead[client];
	g_fRingPitch[client][h] = angles[0];
	g_fRingYaw[client][h] = angles[1];
	g_iRingTick[client][h] = tick;
	g_iRingHead[client] = (h + 1) % ANG_RING;
	if (g_iRingLen[client] < ANG_RING) g_iRingLen[client]++;

	int first = client * MAX_PENDING;
	for (int s = first; s < first + MAX_PENDING; s++) {
		if (!g_bKillOpen[s]) continue;
		float d = AngleBetween(angles[0], angles[1], g_fKillRefPitch[s], g_fKillRefYaw[s]);
		if (d < g_fKillBack[s]) g_fKillBack[s] = d;
	}
}

/** The great-circle angle between two views (pitch, yaw; roll ignored), in
 *  degrees: a roll-free 180 degree turn reads as 180. */
float AngleBetween(float p1, float y1, float p2, float y2)
{
	float a[3], b[3], va[3], vb[3];
	a[0] = p1; a[1] = y1; a[2] = 0.0;
	b[0] = p2; b[1] = y2; b[2] = 0.0;
	GetAngleVectors(a, va, NULL_VECTOR, NULL_VECTOR);
	GetAngleVectors(b, vb, NULL_VECTOR, NULL_VECTOR);
	float dot = GetVectorDotProduct(va, vb);
	if (dot > 1.0) dot = 1.0;
	else if (dot < -1.0) dot = -1.0;
	return RadToDeg(ArcCosine(dot));
}

/**
 * A human survivor killed a human SI (not a ghost, not a bot, not a common,
 * not the tank): record what the attacker's view did in the 300 ms before,
 * and start the one second look back. Bots on either side only with the
 * TEST ONLY l4d_inputstats_bots, so the local rig can kill a bot hunter.
 */
void TakeSiKill(Event e, int victim)
{
	if (!g_cvEnabled.BoolValue || !IsClientInGame(victim) || GetClientTeam(victim) != TEAM_INFECTED) return;
	bool bots = g_cvBots.BoolValue;
	if (IsFakeClient(victim) && !bots) return;
	// A ghost cannot be shot, but a ghost death (a slay, a team swap) is no kill.
	if (GetEntProp(victim, Prop_Send, "m_isGhost") != 0) return;
	int cls = GetEntProp(victim, Prop_Send, "m_zombieClass");
	if (cls < ZC_SMOKER || cls > ZC_HUNTER) return;
	int attacker = GetClientOfUserId(e.GetInt("attacker"));
	if (attacker < 1 || attacker == victim || !IsClientInGame(attacker) || GetClientTeam(attacker) != TEAM_SURVIVOR) return;
	if (IsFakeClient(attacker) && !bots) return;

	int slot = -1;
	int first = attacker * MAX_PENDING;
	for (int s = first; s < first + MAX_PENDING; s++) {
		if (!g_bKillOpen[s]) { slot = s; break; }
	}
	if (slot < 0) return;

	// The kill-tick view is the newest usercmd's. pre is the largest distance
	// from it to any view in the 300 ms before; the reference for the look
	// back is the oldest view inside that window ("the view 300 ms before").
	float killP, killY;
	int len = g_iRingLen[attacker];
	if (len == 0) {
		float eye[3];
		GetClientEyeAngles(attacker, eye);
		killP = eye[0]; killY = eye[1];
	} else {
		int newest = (g_iRingHead[attacker] + ANG_RING - 1) % ANG_RING;
		killP = g_fRingPitch[attacker][newest];
		killY = g_fRingYaw[attacker][newest];
	}
	float pre = 0.0, refP = killP, refY = killY;
	if (len > 1) {
		int newest = (g_iRingHead[attacker] + ANG_RING - 1) % ANG_RING;
		int oldest = g_iRingTick[attacker][newest] - RoundToCeil(PRE_SECONDS / GetTickInterval());
		for (int i = 1; i < len; i++) {
			int s = (newest + ANG_RING - i) % ANG_RING;
			if (g_iRingTick[attacker][s] < oldest) break;
			float d = AngleBetween(killP, killY, g_fRingPitch[attacker][s], g_fRingYaw[attacker][s]);
			if (d > pre) pre = d;
			refP = g_fRingPitch[attacker][s];
			refY = g_fRingYaw[attacker][s];
		}
	}

	float from[3], to[3];
	GetClientAbsOrigin(attacker, from);
	GetClientAbsOrigin(victim, to);
	char weapon[32];
	e.GetString("weapon", weapon, sizeof(weapon));
	// The wire refuses anything outside [a-z0-9_]; normalise rather than
	// ship a line the parser drops.
	for (int i = 0; weapon[i] != '\0'; i++) {
		if (!IsCharLower(weapon[i]) && !IsCharNumeric(weapon[i]) && weapon[i] != '_') weapon[i] = '_';
	}
	if (weapon[0] == '\0') strcopy(weapon, sizeof(weapon), "unknown");

	g_bKillOpen[slot] = true;
	g_iKillSerial[slot] = ++g_iKillSerialNext;
	g_fKillRefPitch[slot] = refP;
	g_fKillRefYaw[slot] = refY;
	g_fKillPre[slot] = pre;
	g_fKillBack[slot] = BACK_NONE;
	g_iKillHs[slot] = e.GetBool("headshot") ? 1 : 0;
	g_iKillDist[slot] = RoundToNearest(GetVectorDistance(from, to));
	g_iKillClass[slot] = cls;
	strcopy(g_sKillWeapon[slot], sizeof(g_sKillWeapon[]), weapon);

	DataPack pack;
	CreateDataTimer(BACK_SECONDS, Timer_KillBack, pack, TIMER_FLAG_NO_MAPCHANGE);
	pack.WriteCell(slot);
	pack.WriteCell(g_iKillSerial[slot]);
}

public Action Timer_KillBack(Handle timer, DataPack pack)
{
	pack.Reset();
	int slot = pack.ReadCell();
	int serial = pack.ReadCell();
	// Not ours any more: the killer left, died or changed team, and the
	// line already went out as unknown.
	if (g_bKillOpen[slot] && g_iKillSerial[slot] == serial) EmitSiKill(slot / MAX_PENDING, slot, false);
	return Plugin_Stop;
}

/** Everything this client has waiting goes out now, with back unknown. */
void CloseKills(int client)
{
	if (client < 1 || client > MaxClients) return;
	int first = client * MAX_PENDING;
	for (int s = first; s < first + MAX_PENDING; s++) {
		if (g_bKillOpen[s]) EmitSiKill(client, s, true);
	}
}

void EmitSiKill(int client, int slot, bool unknown)
{
	g_bKillOpen[slot] = false;
	if (!IsClientConnected(client)) return;
	char id[32];
	if (!GetClientAuthId(client, AuthId_SteamID64, id, sizeof(id))) {
		// Under sv_lan 1 the 64-bit form is unavailable; the web normalises the
		// STEAM_ form, same as every other L4DM line.
		if (!GetClientAuthId(client, AuthId_Steam2, id, sizeof(id))) return;
	}
	float back = (unknown || g_fKillBack[slot] >= BACK_NONE) ? -1.0 : g_fKillBack[slot];
	char cls[8];
	switch (g_iKillClass[slot]) {
		case ZC_SMOKER: strcopy(cls, sizeof(cls), "smoker");
		case ZC_BOOMER: strcopy(cls, sizeof(cls), "boomer");
		default: strcopy(cls, sizeof(cls), "hunter");
	}
	EmitSiKillLine(id, g_sKillWeapon[slot], g_iKillHs[slot], g_iKillDist[slot], g_fKillPre[slot], back, cls);
}

/**
 * The ONE place the sikill format exists, so the self-test cannot drift from
 * the real path. Same anchoring as every L4DM line: the marker opens the
 * line and the only identity on it is a steamid. About 130 bytes signed.
 */
void EmitSiKillLine(const char[] id, const char[] weapon, int hs, int dist, float pre, float back, const char[] cls)
{
	PugLog("L4DM id=%s k=sikill w=%s hs=%d dist=%d pre=%.1f back=%.1f cls=%s v=%d",
		id, weapon, hs, dist, pre, back, cls, SIKILL_WIRE);
}

void EmitStall(int client)
{
	g_bStOpen[client] = false;
	if (g_iStallsThisRound[client] >= STALL_BUDGET) return;
	char id[32];
	if (!GetClientAuthId(client, AuthId_SteamID64, id, sizeof(id))) {
		if (!GetClientAuthId(client, AuthId_Steam2, id, sizeof(id))) return;
	}
	g_iStallsThisRound[client]++;
	PugLog("L4DM id=%s k=stall st=%d gap=%d miss=%d cmds=%d team=%d cls=%d lunge=%d rate=%d v=%d",
		id, g_iStTick[client], g_iStGap[client], g_iStMissed[client], g_iStCmds[client],
		g_iStTeam[client], g_iStClass[client], g_iStLunging[client], g_iTickRate, WIRE_VERSION);
}

/**
 * OnPlayerRunCmdPre, NOT OnPlayerRunCmd, for two reasons.
 *
 * It runs before any plugin's OnPlayerRunCmd, so it sees the player's real
 * input. Measured with OnPlayerRunCmd on 2026-09-21, a macro driven at 13/s was
 * recorded at 6.1/s, statistically indistinguishable from a hand: another
 * plugin (l4d2_pistol_delay) clamps the attack button before that hook runs, so
 * we were measuring post-clamp input and would have called a cheat a human.
 *
 * Its signature is also read-only: `int buttons`, not `int &buttons`. That makes
 * "this plugin cannot change the game" a property of the hook rather than a
 * promise in a comment.
 */
public void OnPlayerRunCmdPre(int client, int buttons, int impulse, const float vel[3],
	const float angles[3], int weapon, int subtype, int cmdnum, int tickcount, int seed,
	const int mouse[2])
{
	// Hot path: ~800 calls a second with eight players at 100 tick. Integer work
	// only; nothing here formats a string. Formatting happens at burst close.
	if (!g_cvEnabled.BoolValue || !IsClientInGame(client)
	    || (IsFakeClient(client) && !g_cvBots.BoolValue)) {
		return;
	}

	// A ghost (an infected player who has not spawned yet) passes IsPlayerAlive,
	// holds weapon_hunter_claw, and EVERYONE mashes M1 as a ghost because that
	// is how you spawn. Captured, that mashing dominated the pounce bursts. A
	// ghost cannot attack, pounce or hop, so nothing it presses is evidence.
	//
	// Dead or ghost, the button state is still kept current, so the press that
	// spawns the player is not read as an edge on their first live tick.
	if (!IsPlayerAlive(client)
	    || (GetClientTeam(client) == TEAM_INFECTED && GetEntProp(client, Prop_Send, "m_isGhost") != 0)) {
		if (g_bCapturing[client]) {
			// The life just ended (player_death normally got here first).
			FlushAll(client);
			ResetCapture(client);
		}
		g_iPrevButtons[client] = buttons;
		return;
	}

	int tick = GetGameTickCount();
	int prev = g_iPrevButtons[client];
	// The usercmd's own sequence number times every interval. A bot's usercmds
	// are made by the server and carry no sequence, so the TEST ONLY bot path
	// falls back to the server tick, which for a bot is the same thing.
	int seq = IsFakeClient(client) ? tick : cmdnum;
	g_iLastClientTick[client] = tickcount;
	g_iLastSeq[client] = seq;
	if (!g_bCapturing[client]) {
		// First captured usercmd of a life. Nothing carries over from the last
		// one: air presses from before a death used to merge into the first
		// pounce after the respawn.
		ResetCapture(client);
		g_bCapturing[client] = true;
	}
	TrackStall(client, tick, seq);
	// Survivors only: the ring is read for a survivor's SI kill. Float stores
	// and, only while a kill waits on its look back, one AngleBetween per
	// waiting kill. Still nothing formatted here.
	if (GetClientTeam(client) == TEAM_SURVIVOR) TrackView(client, angles, tick);

	// Release edges first, so a press let go on this usercmd has its hold
	// written before anything below decides to emit the burst it belongs to.
	if (!(buttons & IN_ATTACK) && (prev & IN_ATTACK)) CloseAttackHold(client);
	if (g_bHopPending[client] && (!(buttons & IN_JUMP) || seq - g_iHopDownSeq[client] >= g_iBurstGap)) {
		FlushHop(client);
	}

	// A fire burst is over once the gap has passed, whether or not another
	// press ever comes. Waiting for that next press is what labelled bursts
	// with the wrong weapon and dropped the last one of every life.
	if (g_iAtkPresses[client] > 0 && GapPassed(seq, g_iAtkLastSeq[client])) FlushFire(client);

	// FL_ONGROUND is clear on a ladder, so a climb used to read as one long
	// airborne phase and every press on it as a pounce press, and stepping off
	// at the top as a landing for the bhop anchor. A ladder is not the air.
	bool onLadder = GetEntityMoveType(client) == MOVETYPE_LADDER;
	bool ground = onLadder || (GetEntityFlags(client) & FL_ONGROUND) != 0;

	// --- ground and air transitions ----------------------------------------
	if (ground && !g_bPrevGround[client]) {
		// Landed. The airborne phase just ended, so that pounce attempt is
		// complete and its press count is final.
		FlushAir(client, seq);
		// Grabbing a ladder ends the airborne phase but is not a landing: a
		// jump off a ladder is not a bunnyhop.
		g_bGroundTimed[client] = !onLadder;
		g_iGroundStartSeq[client] = seq;
	} else if (!ground && g_bPrevGround[client]) {
		// Left the ground. Anything pressed from here until landing belongs to
		// this airborne phase.
		g_iAirCount[client] = 0;
		g_iAirPresses[client] = 0;
		g_iAirHoldSlot[client] = -1;
		g_iAirStartSeq[client] = seq;
	}
	g_bPrevGround[client] = ground;

	// --- +attack press edges ------------------------------------------------
	if ((buttons & IN_ATTACK) && !(prev & IN_ATTACK)) {
		if (g_iAtkPresses[client] == 0) {
			GetActiveWeapon(client, g_sAtkWeapon[client], sizeof(g_sAtkWeapon[]));
			g_iAtkFirstTick[client] = tick;
		}
		g_iAtkDownSeq[client] = seq;
		g_iAtkHoldSlot[client] = Record(seq, g_iAtkTicks[client], g_iAtkHolds[client],
			g_iAtkCount[client], g_iAtkPresses[client], g_iAtkLastSeq[client]);
		g_iAtkLastTick[client] = tick;
		g_iAirHoldSlot[client] = -1;
		if (!ground) {
			// Same press also belongs to the airborne phase, counted separately.
			if (g_iAirPresses[client] == 0) {
				GetActiveWeapon(client, g_sAirWeapon[client], sizeof(g_sAirWeapon[]));
				g_iAirFirstTick[client] = tick;
			}
			g_iAirHoldSlot[client] = Record(seq, g_iAirTicks[client], g_iAirHolds[client],
				g_iAirCount[client], g_iAirPresses[client], g_iAirLastSeq[client]);
			g_iAirLastTick[client] = tick;
		}
	}

	// --- +jump press edges, the bhop anchor ---------------------------------
	if ((buttons & IN_JUMP) && !(prev & IN_JUMP) && g_bGroundTimed[client] && ground && !onLadder) {
		int onGround = seq - g_iGroundStartSeq[client];
		if (onGround >= 0 && onGround <= g_iBurstGap) {
			// Emitted when the jump button comes back up: see FlushHop.
			g_bHopPending[client] = true;
			g_iHopGround[client] = onGround;
			g_iHopDownSeq[client] = seq;
		}
		g_bGroundTimed[client] = false;
	}

	g_iPrevButtons[client] = buttons;
}

/** Whether the burst whose last press was at `last` is over. A sequence that
 *  runs BACKWARDS is a new connection's numbering, never the same burst. */
bool GapPassed(int seq, int last)
{
	return seq - last > g_iBurstGap || seq < last;
}

/** A usercmd count as a wire value: 1..g_iBurstGap, where the cap means "that
 *  or more" (30 at 100 tick, 38 at 128). */
int Clamp(int v)
{
	return v < 1 ? 1 : (v > g_iBurstGap ? g_iBurstGap : v);
}

/**
 * Count one press and the interval since the previous one in the same burst,
 * and return the slot its hold belongs in, or -1 once the burst is full. Past
 * the cap a burst stops recording rather than wrapping, but stays open.
 *
 * Presses and intervals move together, always presses == count + 1, because
 * the hold series is per press and has to line up with the interval series
 * for either to mean anything. That is why a gap is clamped rather than
 * dropped. It only matters in the air: a fire burst is closed by its gap
 * before a press can be that far from the last, but an airborne phase runs
 * until the landing, and a pounce interval of 30 means "30 or more".
 */
int Record(int seq, int[] ticks, int[] holds, int &count, int &presses, int &lastSeq)
{
	int slot = -1;
	if (presses == 0) {
		slot = 0;
		presses = 1;
	} else if (count < MAX_INTERVALS) {
		ticks[count++] = Clamp(seq - lastSeq);
		slot = presses++;
	}
	// Until the release edge says otherwise, a press was down for one usercmd.
	if (slot >= 0) holds[slot] = 1;
	lastSeq = seq;
	return slot;
}

/** The attack button came up, or the burst it was pressed in is being emitted
 *  with it still down: write how long it has been held so far. */
void CloseAttackHold(int client)
{
	int held = Clamp(g_iLastSeq[client] - g_iAtkDownSeq[client]);
	if (g_iAtkHoldSlot[client] >= 0) g_iAtkHolds[client][g_iAtkHoldSlot[client]] = held;
	if (g_iAirHoldSlot[client] >= 0) g_iAirHolds[client][g_iAirHoldSlot[client]] = held;
	g_iAtkHoldSlot[client] = -1;
	g_iAirHoldSlot[client] = -1;
}

void FlushFire(int client)
{
	if (g_iAtkHoldSlot[client] >= 0) {
		// Still down as the burst closes. Record the time so far, and stop
		// tracking it for this burst only: the air burst may still want it.
		g_iAtkHolds[client][g_iAtkHoldSlot[client]] = Clamp(g_iLastSeq[client] - g_iAtkDownSeq[client]);
		g_iAtkHoldSlot[client] = -1;
	}
	if (g_iAtkPresses[client] >= MIN_BURST_PRESSES) {
		char d[MAX_INTERVALS + 1], h[MAX_HOLDS + 1];
		Encode(g_iAtkTicks[client], g_iAtkCount[client], d, sizeof(d));
		Encode(g_iAtkHolds[client], g_iAtkPresses[client], h, sizeof(h));
		EmitBurst(client, KIND_FIRE, g_sAtkWeapon[client], g_iAtkCount[client], 0, 0,
			g_iAtkLastTick[client] - g_iAtkFirstTick[client], d, h);
	}
	g_iAtkCount[client] = 0;
	g_iAtkPresses[client] = 0;
}

/** `seq` is the usercmd that ended the phase: the landing, or the last press
 *  when the phase is cut short by a death. */
void FlushAir(int client, int seq)
{
	if (g_iAirHoldSlot[client] >= 0) {
		g_iAirHolds[client][g_iAirHoldSlot[client]] = Clamp(g_iLastSeq[client] - g_iAtkDownSeq[client]);
		g_iAirHoldSlot[client] = -1;
	}
	// An airborne phase with three or more presses is the interesting case: a
	// human pounces with one press, so anything past a couple means the button
	// was being held or spammed through the air.
	if (g_iAirPresses[client] >= MIN_BURST_PRESSES) {
		char d[MAX_INTERVALS + 1], h[MAX_HOLDS + 1];
		Encode(g_iAirTicks[client], g_iAirCount[client], d, sizeof(d));
		Encode(g_iAirHolds[client], g_iAirPresses[client], h, sizeof(h));
		int airCmds = seq - g_iAirStartSeq[client];
		if (airCmds < 0) airCmds = 0;
		EmitBurst(client, KIND_POUNCE, g_sAirWeapon[client], g_iAirCount[client], airCmds,
			g_iAirPresses[client], g_iAirLastTick[client] - g_iAirFirstTick[client], d, h);
	}
	g_iAirCount[client] = 0;
	g_iAirPresses[client] = 0;
}

/** One hop, one line: a placeholder interval, because a hop has none, and the
 *  one real hold. */
void FlushHop(int client)
{
	if (!g_bHopPending[client]) return;
	g_bHopPending[client] = false;
	int one[1], held[1];
	one[0] = 1;
	held[0] = Clamp(g_iLastSeq[client] - g_iHopDownSeq[client]);
	char d[2], h[2];
	Encode(one, 1, d, sizeof(d));
	Encode(held, 1, h, sizeof(h));
	EmitBurst(client, KIND_BHOP, "", 1, g_iHopGround[client], 0, 0, d, h);
}

/** One printable character per interval. A burst closes at g_iBurstGap, so
 *  every interval is 1..g_iBurstGap by construction and the encoding is total:
 *  there is no value it cannot represent, and nothing it produces can contain
 *  a space or a quote: base 48 gives '0'..'M' at 100 tick and '0'..'U' at 128,
 *  digits, letters and :;<=>?@ only. Mirrors
 *  encodeIntervals in src/inputStats.ts, which documents why not base 33. */
void Encode(const int[] ticks, int n, char[] out, int maxlen)
{
	int w = 0;
	for (int i = 0; i < n && w < maxlen - 1; i++) {
		int t = ticks[i];
		if (t < 1 || t > g_iBurstGap) continue;
		out[w++] = view_as<char>(ENC_BASE + t - 1);
	}
	out[w] = '\0';
}

void GetActiveWeapon(int client, char[] buf, int maxlen)
{
	buf[0] = '\0';
	int w = GetEntPropEnt(client, Prop_Send, "m_hActiveWeapon");
	if (w > 0 && IsValidEntity(w)) {
		GetEntityClassname(w, buf, maxlen);
		// The wire refuses anything outside [a-z0-9_], so normalise here rather
		// than shipping a line the parser will drop.
		for (int i = 0; buf[i] != '\0'; i++) {
			if (!IsCharLower(buf[i]) && !IsCharNumeric(buf[i]) && buf[i] != '_') buf[i] = '_';
		}
	}
}

/**
 * One line per burst. `L4DM` must be the first thing after the engine's stamp:
 * the game server relays every chat line on this same stream, so an unanchored
 * marker is forgeable by a player typing it. LogToGame is what puts it there.
 * There is no name field at all, so there is nothing for a crafted name to
 * impersonate; the only identity on the line is a steamid.
 */
void EmitBurst(int client, int kind, const char[] weapon, int n, int groundTicks,
	int airPresses, int serverSpan, const char[] d, const char[] h)
{
	char id[32];
	if (!GetClientAuthId(client, AuthId_SteamID64, id, sizeof(id))) {
		// Under sv_lan 1 the 64-bit form is unavailable. The web accepts the
		// STEAM_ form too and normalises it, same as the consistency drop line.
		if (!GetClientAuthId(client, AuthId_Steam2, id, sizeof(id))) return;
	}
	if (g_iBurstsThisRound[client][kind] >= g_iBudget[kind]) {
		// Out of budget for this kind. Say so ONCE, then go quiet: the marker is
		// what lets the web tell a truncated capture from an uneventful round.
		if (!g_bCapSent[client][kind]) {
			g_bCapSent[client][kind] = true;
			PugLog("L4DM id=%s k=cap c=%s st=%d v=%d", id, g_sKind[kind], GetGameTickCount(), WIRE_VERSION);
		}
		return;
	}
	g_iBurstsThisRound[client][kind]++;
	// Both clocks, read at the same moment for every kind: the server tick now
	// and the tickcount of the usercmd being run. `ct` used to carry cmdnum on
	// two kinds and a literal 0 on the third. The client value is attacker
	// controlled and times nothing; its drift against `st` is its own signal.
	EmitLine(id, g_sKind[kind], weapon, n, groundTicks, airPresses, GetGameTickCount(),
		g_iLastClientTick[client], serverSpan, d, h);
}

/**
 * The ONE place the wire format exists, so the test path cannot drift from the
 * real one. The two long series go last.
 *
 * Longest possible line: about 130 bytes of fixed keys (rate= added 9) with
 * every counter at its widest and a 31 character weapon, plus 256 for d and
 * 257 for h, is under
 * 650, and under 680 with the engine's stamp in front, or 720 signed (PugLog
 * adds at most 40). That is inside PugLog's 976 usable bytes, LogToGame's 1024
 * byte buffer and one UDP log datagram, with room. If
 * MAX_INTERVALS is ever raised, this is the sum to redo.
 */
void EmitLine(const char[] id, const char[] kind, const char[] weapon, int n, int groundTicks,
	int airPresses, int serverTick, int clientTick, int serverSpan, const char[] d, const char[] h)
{
	PugLog("L4DM id=%s k=%s w=%s n=%d g=%d a=%d st=%d ct=%d sp=%d rate=%d v=%d d=%s h=%s",
		id, kind, weapon, n, groundTicks, airPresses, serverTick, clientTick, serverSpan,
		g_iTickRate, WIRE_VERSION, d, h);
}
