/**
 * l4d_lilac_report - put Little Anti-Cheat's detections on the PUG wire.
 *
 * LilAC writes its own addons/sourcemod/logs/lilac.log, which is no use to a
 * web app on another machine, and hopeless for Chicago which we reach only over
 * FTP. It does expose forwards, so this bridges them onto the logaddress stream
 * the site already listens to, in the same shape as the consistency drop line.
 *
 * Reporting only: it never bans, never kicks, and deliberately does NOT hook
 * lilac_allow_cheat_detection, which can veto a detection. Whether LilAC acts
 * is LilAC's own lilac_ban setting, and vetoing categories from here would hide
 * the very thing we are trying to collect evidence about.
 *
 * 0.2.0 adds two more sources of evidence to the same line, both read-only:
 *
 *   - LilAC's OWN reason for firing, from three fork-only forwards
 *     (lilac_aimbot_detected, lilac_bhop_detected, lilac_aimlock_detected).
 *     Each fires immediately BEFORE lilac_cheater_detected for the same
 *     detection, so it is simply cached here and read back a moment later
 *     from Report(). See lilac.inc in the fork for the exact fields.
 *
 *   - OUR OWN independent measurement of the player's aim and trigger input
 *     just before the detection, from a ring buffer fed by OnPlayerRunCmdPre
 *     (read-only signature, same hook and same reasoning as l4d_inputstats).
 *     This exists so a LilAC verdict is never the only evidence on record:
 *     if LilAC's own math is ever wrong or gamed, our measurement over the
 *     same window is independent of it.
 *
 * Build:
 *   ./spcomp l4d_lilac_report.sp -i <dir containing lilac.inc>
 *   with pug-logauth.inc and pug-hmac.inc beside it.
 */
#pragma semicolon 1
#pragma newdecls required
#include <sourcemod>
#include <sdktools>
#include <lilac>
#include "pug-logauth.inc"

#define PLUGIN_VERSION "0.2.0"

/** L4D team numbers, same convention as l4d_inputstats.sp. */
#define TEAM_SURVIVOR 2
#define TEAM_INFECTED 3

/**
 * How long a cached LilAC reason (aimbot flags/delta, bhop counts, aimlock
 * target) stays usable. The three reason forwards and lilac_cheater_detected
 * fire back to back in the same call chain for the same detection, so this
 * window exists only to guard against the pathological case where a plugin
 * order surprise, or LilAC itself, calls Report() without the matching
 * reason forward having fired first: better to say -1 (unknown) than to
 * attach a stale reason from an earlier, unrelated detection.
 */
#define REASON_FRESH_SECONDS 2.0

/**
 * How far back the ring buffer is read for OUR OWN aim measurement. Longer
 * than one usercmd so a single lucky tick cannot hide a sustained snap, and
 * short enough that it reflects the input right around the detection rather
 * than the whole life. Chosen to comfortably cover LilAC's own 0.5 s aimbot
 * lookback with margin either side of the detection call.
 */
#define AIM_WINDOW_SECONDS 1.5

/** Ring capacity. At 100 tick, 1.5 s of usercmds is ~150 entries; 256 gives
 *  headroom for a slower tickrate server without growing per-client memory
 *  much (float, float, int, int per slot). */
#define RING_SIZE 256

ConVar g_cvEnabled;

// --- OUR OWN aim/trigger ring, fed by OnPlayerRunCmdPre --------------------
// Circular buffers: g_ringHead is the NEXT write slot, g_ringCount is how
// many of the RING_SIZE slots hold real data (caps at RING_SIZE).
float g_ringAngle0[MAXPLAYERS + 1][RING_SIZE]; // angles[0], pitch
float g_ringAngle1[MAXPLAYERS + 1][RING_SIZE]; // angles[1], yaw
int   g_ringAttack[MAXPLAYERS + 1][RING_SIZE]; // buttons & IN_ATTACK, 0 or 1
int   g_ringTick[MAXPLAYERS + 1][RING_SIZE];   // GetGameTickCount() at capture
int   g_ringHead[MAXPLAYERS + 1];
int   g_ringCount[MAXPLAYERS + 1];

// --- LilAC's own reason, cached from the fork's forwards --------------------
int   g_iAimbotFlags[MAXPLAYERS + 1];
float g_fAimbotDelta[MAXPLAYERS + 1];
float g_fAimbotTotalDelta[MAXPLAYERS + 1];
float g_fAimbotStoredAt[MAXPLAYERS + 1] = { -1.0, ... };

int   g_iBhopPerfect[MAXPLAYERS + 1];
int   g_iBhopJumpTicks[MAXPLAYERS + 1];
float g_fBhopStoredAt[MAXPLAYERS + 1] = { -1.0, ... };

int   g_iAimlockTargetTeam[MAXPLAYERS + 1];
int   g_iAimlockTargetClass[MAXPLAYERS + 1];
int   g_iAimlockTargetGhost[MAXPLAYERS + 1];
float g_fAimlockStoredAt[MAXPLAYERS + 1] = { -1.0, ... };

public Plugin myinfo = {
	name = "L4D1 LilAC Reporter",
	author = "Riverside",
	description = "Reports Little Anti-Cheat detections to the PUG site. Never acts on a player.",
	version = PLUGIN_VERSION,
	url = "https://riversidepug.com",
};

public void OnPluginStart()
{
	CreateConVar("l4d_lilac_report_version", PLUGIN_VERSION, "LilAC reporter version",
		FCVAR_NOTIFY | FCVAR_DONTRECORD);
	g_cvEnabled = CreateConVar("l4d_lilac_report_enabled", "1",
		"Report Little Anti-Cheat detections to the site.", FCVAR_NOTIFY, true, 0.0, true, 1.0);
	PugLogAuth_Init();
}

public void OnClientPutInServer(int client)
{
	ResetRing(client);
}

public void OnClientDisconnect(int client)
{
	ResetRing(client);
}

void ResetRing(int client)
{
	g_ringHead[client] = 0;
	g_ringCount[client] = 0;
}

public void lilac_cheater_detected(int client, int cheat)
{
	Report(client, cheat, false);
}

public void lilac_cheater_banned(int client, int cheat)
{
	Report(client, cheat, true);
}

/** Riverside fork forward: why the aimbot check fired. Cached, not reported
 *  directly, because it arrives one call before lilac_cheater_detected. */
public void lilac_aimbot_detected(int client, int flags, float delta, float total_delta)
{
	if (client <= 0 || client > MaxClients) return;
	g_iAimbotFlags[client] = flags;
	g_fAimbotDelta[client] = delta;
	g_fAimbotTotalDelta[client] = total_delta;
	g_fAimbotStoredAt[client] = GetGameTime();
}

/** Riverside fork forward: why the bhop check fired. */
public void lilac_bhop_detected(int client, int perfect_bhops, int jump_ticks)
{
	if (client <= 0 || client > MaxClients) return;
	g_iBhopPerfect[client] = perfect_bhops;
	g_iBhopJumpTicks[client] = jump_ticks;
	g_fBhopStoredAt[client] = GetGameTime();
}

/**
 * Riverside fork forward: why the aimlock check fired, including the target
 * that was locked onto. The target's team/class/ghost state is resolved
 * right here rather than later in Report(), so it never depends on the
 * target entity still existing whenever Report() actually runs.
 */
public void lilac_aimlock_detected(int client, int target, int suspicions)
{
	if (client <= 0 || client > MaxClients) return;

	int team = -1, zclass = -1, ghost = -1;
	if (target > 0 && target <= MaxClients && IsClientInGame(target)) {
		team = GetClientTeam(target);
		zclass = (team == TEAM_INFECTED) ? GetEntProp(target, Prop_Send, "m_zombieClass") : 0;
		ghost = GetEntProp(target, Prop_Send, "m_isGhost");
	}
	g_iAimlockTargetTeam[client] = team;
	g_iAimlockTargetClass[client] = zclass;
	g_iAimlockTargetGhost[client] = ghost;
	g_fAimlockStoredAt[client] = GetGameTime();
}

/**
 * OUR OWN measurement, fed independently of LilAC. Read-only signature
 * (`const float angles[3]`, `int buttons` not `int &buttons`): this plugin
 * cannot alter input even by accident, which is a property of the hook, not
 * a promise in a comment. Same hook and same reasoning as l4d_inputstats.sp:
 * OnPlayerRunCmdPre runs before any plugin's OnPlayerRunCmd, so it sees the
 * player's real angles and buttons rather than whatever another plugin
 * (e.g. a rate clamp) left behind.
 *
 * Hot path: up to ~800 calls/s with eight players at 100 tick. Integer/float
 * bookkeeping only; nothing here formats a string or walks the ring. The
 * ring is only ever read later, from Report(), on an actual detection.
 */
public void OnPlayerRunCmdPre(int client, int buttons, int impulse, const float vel[3],
	const float angles[3], int weapon, int subtype, int cmdnum, int tickcount, int seed,
	const int mouse[2])
{
	if (!IsClientInGame(client) || IsFakeClient(client)) return;

	int slot = g_ringHead[client];
	g_ringAngle0[client][slot] = angles[0];
	g_ringAngle1[client][slot] = angles[1];
	g_ringAttack[client][slot] = (buttons & IN_ATTACK) ? 1 : 0;
	g_ringTick[client][slot] = GetGameTickCount();
	g_ringHead[client] = (slot + 1) % RING_SIZE;
	if (g_ringCount[client] < RING_SIZE) g_ringCount[client]++;
}

/** Wrap a view-angle difference to [-180, 180]. Bounded to at most one
 *  wraparound because the ring samples every usercmd, so consecutive
 *  entries are one tick apart and never differ by more than a lap. */
float WrapDelta(float d)
{
	if (d > 180.0) d -= 360.0;
	else if (d < -180.0) d += 360.0;
	return d;
}

/**
 * OUR OWN aim/trigger measurement over the last AIM_WINDOW_SECONDS of ring
 * entries, walked oldest to newest so attack press/release edges come out
 * in the right order:
 *
 *   maxd  - largest single-usercmd view change (yaw+pitch combined).
 *   totd  - sum of every usercmd's view change in the window.
 *   taps  - +attack press edges (0->1 transitions).
 *   taps1 - of those, the ones released on the very next usercmd (held for
 *           exactly one usercmd: a mouse-wheel or scripted single-tick tap
 *           looks like this; a human trigger pull almost never does).
 */
void ComputeAimMetrics(int client, float &maxd, float &totd, int &taps, int &taps1)
{
	maxd = 0.0;
	totd = 0.0;
	taps = 0;
	taps1 = 0;

	int count = g_ringCount[client];
	if (count < 2) return;

	int windowTicks = RoundToCeil(AIM_WINDOW_SECONDS / GetTickInterval());
	int nowTick = GetGameTickCount();

	// Oldest stored entry is `count` slots behind the next write slot.
	int oldest = (g_ringHead[client] - count + RING_SIZE * 4) % RING_SIZE;

	bool havePrev = false;
	float prevA0 = 0.0, prevA1 = 0.0;
	int prevAtk = 0;
	// Pending press edge waiting to see the NEXT usercmd, to know if it was
	// released within one usercmd. -1 means nothing pending.
	int pendingTapIndex = -1;
	int seen = 0;

	for (int i = 0; i < count; i++) {
		int pos = (oldest + i) % RING_SIZE;
		int tick = g_ringTick[client][pos];
		if (nowTick - tick > windowTicks) continue; // outside the window, older entry

		float a0 = g_ringAngle0[client][pos];
		float a1 = g_ringAngle1[client][pos];
		int atk = g_ringAttack[client][pos];

		if (havePrev) {
			float dy = WrapDelta(a1 - prevA1);
			float dp = a0 - prevA0;
			float d = SquareRoot(dy * dy + dp * dp);
			totd += d;
			if (d > maxd) maxd = d;

			if (pendingTapIndex >= 0) {
				// This is the usercmd right after a press edge: settle it.
				if (atk == 0) taps1++;
				pendingTapIndex = -1;
			}
			if (atk == 1 && prevAtk == 0) {
				taps++;
				pendingTapIndex = seen; // wait for the next entry to settle it
			}
		}

		prevA0 = a0;
		prevA1 = a1;
		prevAtk = atk;
		havePrev = true;
		seen++;
	}
	// A press pending at the end of the window (still held, or the ring ran
	// out) never got to see its next usercmd, so it is deliberately NOT
	// counted as a one-usercmd tap: taps1 only counts presses we actually
	// watched get released.
}

/**
 * `L4DL` must be the first thing after the engine's timestamp. The game server
 * relays every chat line on this same stream, so an unanchored marker could be
 * forged by a player typing it. There is no name field: the only identity on
 * the line is a steamid, so a crafted name has nothing to impersonate.
 *
 * Longest realistic extra suffix (aimbot/aimlock, all-fields worst case) is
 * well under 100 bytes; the base line is well under 60. Both are far inside
 * PugLog's budget: PugLog formats into a 1024 byte buffer, reserving
 * PUGLOG_TRAILER_ROOM (48 bytes, see pug-logauth.inc) for its own
 * " lseq=.." / " mac=.." trailer, so this line has ~976 usable bytes and
 * uses a small fraction of that.
 */
void Report(int client, int cheat, bool banned)
{
	if (!g_cvEnabled.BoolValue) return;
	if (client <= 0 || client > MaxClients || !IsClientConnected(client)) return;
	if (IsFakeClient(client)) return;

	char id[32];
	if (!GetClientAuthId(client, AuthId_SteamID64, id, sizeof(id))) {
		// Under sv_lan 1 the 64-bit form is unavailable; the web normalises the
		// STEAM_ form too, same as the consistency drop line.
		if (!GetClientAuthId(client, AuthId_Steam2, id, sizeof(id))) return;
	}

	float now = GetGameTime();
	char extra[256];
	extra[0] = '\0';

	if (cheat == CHEAT_AIMBOT || cheat == CHEAT_AIMLOCK) {
		float maxd, totd;
		int taps, taps1;
		ComputeAimMetrics(client, maxd, totd, taps, taps1);

		if (cheat == CHEAT_AIMBOT) {
			// Unknown/stale (stock LilAC without the fork, or a reason that
			// somehow did not arrive before this call) reports as -1, never
			// a guess.
			int lflags = -1;
			float ldelta = -1.0, ltd = -1.0;
			if (g_fAimbotStoredAt[client] >= 0.0
				&& now - g_fAimbotStoredAt[client] <= REASON_FRESH_SECONDS) {
				lflags = g_iAimbotFlags[client];
				ldelta = g_fAimbotDelta[client];
				ltd = g_fAimbotTotalDelta[client];
			}
			FormatEx(extra, sizeof(extra),
				" lflags=%d ldelta=%.1f ltd=%.1f maxd=%.1f totd=%.1f taps=%d taps1=%d",
				lflags, ldelta, ltd, maxd, totd, taps, taps1);
		} else {
			int ttTeam = -1, ttClass = -1, ttGhost = -1;
			if (g_fAimlockStoredAt[client] >= 0.0
				&& now - g_fAimlockStoredAt[client] <= REASON_FRESH_SECONDS) {
				ttTeam = g_iAimlockTargetTeam[client];
				ttClass = g_iAimlockTargetClass[client];
				ttGhost = g_iAimlockTargetGhost[client];
			}
			FormatEx(extra, sizeof(extra),
				" maxd=%.1f totd=%.1f taps=%d taps1=%d ltarget_team=%d ltarget_class=%d ltarget_ghost=%d",
				maxd, totd, taps, taps1, ttTeam, ttClass, ttGhost);
		}
	} else if (cheat == CHEAT_BHOP) {
		int bhops = -1, jumpTicks = -1;
		if (g_fBhopStoredAt[client] >= 0.0
			&& now - g_fBhopStoredAt[client] <= REASON_FRESH_SECONDS) {
			bhops = g_iBhopPerfect[client];
			jumpTicks = g_iBhopJumpTicks[client];
		}
		FormatEx(extra, sizeof(extra), " lbhops=%d ljump=%d", bhops, jumpTicks);
	}
	// Other cheats: extra stays empty and the line is exactly as before 0.2.0.

	PugLog("L4DL id=%s cheat=%d banned=%d%s", id, cheat, banned ? 1 : 0, extra);
}
