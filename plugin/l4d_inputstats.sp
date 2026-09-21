/**
 * l4d_inputstats - input timing capture for macro detection.
 *
 * Design: docs/superpowers/specs/2026-09-21-input-macro-detection-design.md
 *
 * Captures the timing of button PRESS EDGES and ships one line per burst. It
 * computes no verdicts: every statistic and threshold lives on the web side, so
 * a signature can be improved and re-run over stored history without anything
 * being redeployed to a game server. That matters here because the cheats are
 * frozen (nobody writes new ones for a 2008 game) while our tooling is not.
 *
 * THIS PLUGIN MUST BE INCAPABLE OF CHANGING THE GAME. OnPlayerRunCmd always
 * returns Plugin_Continue and never writes `buttons`. If that ever stops being
 * true, this belongs nowhere near a ranked match.
 */
#pragma semicolon 1
#pragma newdecls required
#include <sourcemod>
#include <sdktools>

#define PLUGIN_VERSION "0.1.0"

/** A burst closes after this much silence. 30 ticks at 100 tick = 300ms.
 *  Measured, not guessed: a human sample containing one 31-second idle gap had
 *  its coefficient of variation dragged to 6.85, hiding everything. */
#define BURST_GAP_TICKS 30

/** Matches MAX_INTERVALS in src/inputStats.ts. A burst longer than this stops
 *  recording rather than wrapping, so one pathological or hostile player cannot
 *  flood the wire or the table. */
#define MAX_INTERVALS 256

/** Bursts per player per round. Same reason. */
#define MAX_BURSTS_PER_ROUND 64

/** Two presses is noise and most of the volume. */
#define MIN_BURST_PRESSES 3

/** Must match ENC_BASE in src/inputStats.ts. */
#define ENC_BASE 48

ConVar g_cvEnabled;
ConVar g_cvBots;

int  g_iPrevButtons[MAXPLAYERS + 1];
bool g_bPrevGround[MAXPLAYERS + 1];
int  g_iBurstsThisRound[MAXPLAYERS + 1];

// +attack burst, the `fire` anchor.
int g_iAtkTicks[MAXPLAYERS + 1][MAX_INTERVALS];
int g_iAtkCount[MAXPLAYERS + 1];
int g_iAtkLastTick[MAXPLAYERS + 1];

// Airborne phase, the `pounce` anchor: presses between leaving the ground and
// landing again. A human issues one or two; a held button issues dozens.
int g_iAirTicks[MAXPLAYERS + 1][MAX_INTERVALS];
int g_iAirCount[MAXPLAYERS + 1];
int g_iAirLastTick[MAXPLAYERS + 1];
int g_iAirStartTick[MAXPLAYERS + 1];

// Ground phase, the `bhop` anchor: how long a player stays on the ground before
// jumping again. A script jumps on the exact tick of landing, every time.
int g_iGroundStartTick[MAXPLAYERS + 1];

public Plugin myinfo = {
	name = "L4D1 Input Stats",
	author = "Riverside",
	description = "Ships input burst timing for macro detection. Captures only; never alters input.",
	version = PLUGIN_VERSION,
	url = "https://riversidepug.com",
};

public void OnPluginStart()
{
	CreateConVar("l4d_inputstats_version", PLUGIN_VERSION, "Input stats version",
		FCVAR_NOTIFY | FCVAR_DONTRECORD);
	g_cvEnabled = CreateConVar("l4d_inputstats_enabled", "1",
		"Capture and ship input burst timing.", FCVAR_NOTIFY, true, 0.0, true, 1.0);
	// TEST ONLY. Bots press buttons, which makes them the only way to exercise
	// this end to end without a human at a keyboard. Never enable it on a real
	// server: bot input is not evidence of anything and would pollute the data.
	g_cvBots = CreateConVar("l4d_inputstats_bots", "0",
		"TEST ONLY: also capture bots, so the pipeline can be exercised without a player.",
		FCVAR_NOTIFY, true, 0.0, true, 1.0);
	HookEvent("round_start", Event_RoundStart, EventHookMode_PostNoCopy);
	RegAdminCmd("sm_inputstats_emit", Cmd_Emit, ADMFLAG_ROOT,
		"TEST: sm_inputstats_emit <fire|pounce|bhop> <presses> - ship a synthetic burst through the real encode and emit path.");
}

/** Exercises the real Encode and EmitBurst path with known values, so the wire
 *  format can be verified against the parser without a player at a keyboard. */
public Action Cmd_Emit(int client, int args)
{
	char kind[16], sn[8];
	GetCmdArg(1, kind, sizeof(kind));
	GetCmdArg(2, sn, sizeof(sn));
	int n = StringToInt(sn);
	if (kind[0] == '\0' || n < 1 || n > MAX_INTERVALS) {
		ReplyToCommand(client, "usage: sm_inputstats_emit <fire|pounce|bhop> <presses 1..%d>", MAX_INTERVALS);
		return Plugin_Handled;
	}
	int ticks[MAX_INTERVALS];
	for (int i = 0; i < n; i++) ticks[i] = 7 + (i % 3);   // 7,8,9 repeating
	char d[MAX_INTERVALS + 1];
	Encode(ticks, n, d, sizeof(d));
	int target = client > 0 ? client : FirstHuman();
	if (target > 0) {
		EmitBurst(target, kind, "test_weapon", n, 4, n + 1, GetGameTickCount(), 0, d);
		ReplyToCommand(client, "[inputstats] emitted a synthetic %s burst of %d for %N", kind, n, target);
	} else {
		// Nobody connected: still exercise the real format, with a literal id.
		EmitLine("76561197960287930", kind, "test_weapon", n, 4, n + 1, GetGameTickCount(), 0, d);
		ReplyToCommand(client, "[inputstats] emitted a synthetic %s burst of %d for a test steamid", kind, n);
	}
	return Plugin_Handled;
}

int FirstHuman()
{
	for (int i = 1; i <= MaxClients; i++) if (IsClientConnected(i) && !IsFakeClient(i)) return i;
	return -1;
}

public void OnClientDisconnect(int client) { ResetClient(client); }
public void Event_RoundStart(Event e, const char[] n, bool b)
{
	for (int i = 1; i <= MaxClients; i++) ResetClient(i);
}

void ResetClient(int c)
{
	g_iPrevButtons[c] = 0;
	g_bPrevGround[c] = true;
	g_iAtkCount[c] = 0; g_iAtkLastTick[c] = 0;
	g_iAirCount[c] = 0; g_iAirLastTick[c] = 0; g_iAirStartTick[c] = 0;
	g_iGroundStartTick[c] = 0;
	g_iBurstsThisRound[c] = 0;
}

public Action OnPlayerRunCmd(int client, int &buttons, int &impulse, float vel[3], float angles[3],
	int &weapon, int &subtype, int &cmdnum, int &tickcount, int &seed, int mouse[2])
{
	// Hot path: ~800 calls a second with eight players at 100 tick. Integer work
	// only; nothing here formats a string. Formatting happens at burst close.
	if (!g_cvEnabled.BoolValue || !IsPlayerAlive(client)
	    || (IsFakeClient(client) && !g_cvBots.BoolValue)) {
		return Plugin_Continue;
	}

	int tick = GetGameTickCount();
	int prev = g_iPrevButtons[client];
	bool ground = (GetEntityFlags(client) & FL_ONGROUND) != 0;

	// --- ground and air transitions ----------------------------------------
	if (ground && !g_bPrevGround[client]) {
		// Landed. The airborne phase just ended, so that pounce attempt is
		// complete and its press count is final.
		FlushAir(client, tick);
		g_iGroundStartTick[client] = tick;
	} else if (!ground && g_bPrevGround[client]) {
		// Left the ground. Anything pressed from here until landing belongs to
		// this airborne phase.
		g_iAirCount[client] = 0;
		g_iAirLastTick[client] = 0;
		g_iAirStartTick[client] = tick;
	}
	g_bPrevGround[client] = ground;

	// --- +attack press edges ------------------------------------------------
	if ((buttons & IN_ATTACK) && !(prev & IN_ATTACK)) {
		Record(client, tick, g_iAtkTicks[client], g_iAtkCount[client], g_iAtkLastTick[client], cmdnum);
		if (!ground) {
			// Same press also belongs to the airborne phase, counted separately
			// because it is the signature that needs no tuning.
			if (g_iAirCount[client] < MAX_INTERVALS) {
				if (g_iAirLastTick[client] > 0) {
					int d = tick - g_iAirLastTick[client];
					if (d >= 1 && d <= BURST_GAP_TICKS) g_iAirTicks[client][g_iAirCount[client]++] = d;
				}
			}
			g_iAirLastTick[client] = tick;
		}
	}

	// --- +jump press edges, the bhop anchor ---------------------------------
	if ((buttons & IN_JUMP) && !(prev & IN_JUMP) && g_iGroundStartTick[client] > 0 && ground) {
		int onGround = tick - g_iGroundStartTick[client];
		if (onGround >= 0 && onGround <= BURST_GAP_TICKS) {
			EmitBurst(client, "bhop", "", 1, onGround, 0, tick, cmdnum, "!");
		}
		g_iGroundStartTick[client] = 0;
	}

	g_iPrevButtons[client] = buttons;
	return Plugin_Continue;
}

/** Append one interval to a burst, closing and emitting the previous one when
 *  the gap is too long to belong to it. */
void Record(int client, int tick, int[] ticks, int &count, int &lastTick, int cmdnum)
{
	if (lastTick > 0) {
		int d = tick - lastTick;
		if (d > BURST_GAP_TICKS) {
			FlushFire(client, tick, cmdnum);
		} else if (d >= 1 && count < MAX_INTERVALS) {
			ticks[count++] = d;
		}
	}
	lastTick = tick;
}

void FlushFire(int client, int tick, int cmdnum)
{
	if (g_iAtkCount[client] >= MIN_BURST_PRESSES) {
		char d[MAX_INTERVALS + 1];
		Encode(g_iAtkTicks[client], g_iAtkCount[client], d, sizeof(d));
		char weapon[32];
		GetActiveWeapon(client, weapon, sizeof(weapon));
		EmitBurst(client, "fire", weapon, g_iAtkCount[client], 0, 0, tick, cmdnum, d);
	}
	g_iAtkCount[client] = 0;
}

void FlushAir(int client, int tick)
{
	// An airborne phase with three or more presses is the interesting case: a
	// human pounces with one press, so anything past a couple means the button
	// was being held or spammed through the air.
	if (g_iAirCount[client] >= MIN_BURST_PRESSES - 1) {
		char d[MAX_INTERVALS + 1];
		Encode(g_iAirTicks[client], g_iAirCount[client], d, sizeof(d));
		if (d[0] == '\0') { d = "!"; }
		char weapon[32];
		GetActiveWeapon(client, weapon, sizeof(weapon));
		int airTicks = g_iAirStartTick[client] > 0 ? tick - g_iAirStartTick[client] : 0;
		// air presses is count+1: intervals are the gaps BETWEEN presses.
		EmitBurst(client, "pounce", weapon, g_iAirCount[client], airTicks,
			g_iAirCount[client] + 1, tick, 0, d);
	}
	g_iAirCount[client] = 0;
	g_iAirLastTick[client] = 0;
}

/** One printable character per interval. A burst closes at BURST_GAP_TICKS, so
 *  every interval is 1..30 by construction and the encoding is total: there is
 *  no value it cannot represent, and nothing it produces can contain a space or
 *  a quote: base 48 gives '0'..'M', digits and letters only. Mirrors
 *  encodeIntervals in src/inputStats.ts, which documents why not base 33. */
void Encode(const int[] ticks, int n, char[] out, int maxlen)
{
	int w = 0;
	for (int i = 0; i < n && w < maxlen - 1; i++) {
		int t = ticks[i];
		if (t < 1 || t > BURST_GAP_TICKS) continue;
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
void EmitBurst(int client, const char[] kind, const char[] weapon, int n, int groundTicks,
	int airPresses, int serverTick, int clientTick, const char[] d)
{
	if (g_iBurstsThisRound[client] >= MAX_BURSTS_PER_ROUND) return;
	g_iBurstsThisRound[client]++;

	char id[32];
	if (!GetClientAuthId(client, AuthId_SteamID64, id, sizeof(id))) {
		// Under sv_lan 1 the 64-bit form is unavailable. The web accepts the
		// STEAM_ form too and normalises it, same as the consistency drop line.
		if (!GetClientAuthId(client, AuthId_Steam2, id, sizeof(id))) return;
	}
	EmitLine(id, kind, weapon, n, groundTicks, airPresses, serverTick, clientTick, d);
}

/** The ONE place the wire format exists, so the test path cannot drift from the
 *  real one. */
void EmitLine(const char[] id, const char[] kind, const char[] weapon, int n, int groundTicks,
	int airPresses, int serverTick, int clientTick, const char[] d)
{
	LogToGame("L4DM id=%s k=%s w=%s n=%d g=%d a=%d st=%d ct=%d d=%s",
		id, kind, weapon, n, groundTicks, airPresses, serverTick, clientTick, d);
}
