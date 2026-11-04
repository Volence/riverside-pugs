// ---------- net settings gate: rostered players need our rates to be on a team ----------
//
// The bug this exists for (match 199, 2026-09-26): lerptracker moved a player
// with 100 ms lerp to spectator, and Timer_TeamLock put him straight back on
// his side two seconds later, over and over, until one of the lock's moves
// landed in lerptracker's one-second re-check gap and he played the map at
// 100 ms. Two plugins that each thought they owned the player's team.
//
// This module makes pug-match the one authority for rostered players: the lock
// never places a player whose settings fail, and during ready-up a failing
// player on a team is moved to spectator here. l4dready will not go live with
// a slot empty, so the match cannot start until the settings are fixed; once
// they pass, the lock places the player on the next tick. Mid-round nothing is
// moved by this module (a sudden 3v4 is the wrong answer to a changed cvar);
// the player just cannot come back from spectator until fixed.
//
// Defaults are today's limits, so nobody's experience changes: the lerp cap
// is lerptracker's sm_max_lerp (0.067) and the rate and Effect Detail checks
// are off. Keep sm_pug_rates_max_lerp at or below sm_max_lerp, or the two
// plugins fight over a player between the two values again. The owner's
// stricter limits (2026-09-27: what riversidepug.com's autoexec.cfg sets,
// lerp 0.01, cmd/upd 100, rate 100000, cpu_level 1) are a separate,
// announced rule change. Every limit is a cvar and can be turned off on its
// own, and sm_pug_rates_enforce 0 turns the whole gate off.
//
// Effect Detail (cpu_level) is held the same way, at the owner's ask ("they
// should at least behave similarly"). Low thins smoke and the boomer cloud
// enough to see through. l4d_cvarwatch's ready gate did this by taking back
// the player's ready, which only worked because nothing could move them;
// with the lock waiting here, one rule and one message cover both. The value
// is not userinfo, so it is asked of the client (QueryClientConVar) on each
// lock tick and cached. Like cvarwatch, only a known Low counts: an
// unanswered query never holds anyone.

ConVar g_cvRatesEnforce;
ConVar g_cvRatesMaxLerp;
ConVar g_cvRatesMinCmd;
ConVar g_cvRatesMinUpd;
ConVar g_cvRatesMinRate;
ConVar g_cvRatesMinCpu;
ConVar g_cvRatesSvMinUpd;
ConVar g_cvRatesSvMinRatio;
ConVar g_cvRatesSvMaxRatio;

// Net settings, as bits, for what a live-play report covers.
#define RATES_LERP 1
#define RATES_CMD  2
#define RATES_UPD  4
#define RATES_RATE 8
#define RATES_CPU_TOLD 16   // Effect Detail Low, told in chat; l4d_cvarwatch files its own report

float g_fRatesWarnedAt[MAXPLAYERS + 1];
int g_iRatesLiveTold[MAXPLAYERS + 1];  // net settings reported failing during live play, not yet fixed
bool g_bRatesHeld[MAXPLAYERS + 1];   // last lock tick found this client failing
float g_fRatesCpu[MAXPLAYERS + 1] = {-1.0, ...};   // last cpu_level answer, -1 unknown
int g_iRatesCpuUid[MAXPLAYERS + 1];  // userid that answer belongs to

void RatesInit()
{
	g_cvRatesEnforce = CreateConVar("sm_pug_rates_enforce", "1",
		"1 = rostered players whose net settings fail the sm_pug_rates_* limits are kept off their team (moved to spectator during ready-up). 0 = no check.",
		FCVAR_NOTIFY, true, 0.0, true, 1.0);
	g_cvRatesMaxLerp = CreateConVar("sm_pug_rates_max_lerp", "0.067",
		"Highest lerp allowed on a team, in seconds (0.067 = 67 ms, same as sm_max_lerp). -1 = no lerp check.",
		FCVAR_NOTIFY, true, -1.0, true, 1.0);
	g_cvRatesMinCmd = CreateConVar("sm_pug_rates_min_cmdrate", "0",
		"Lowest cl_cmdrate allowed on a team. 0 = no check.", FCVAR_NOTIFY, true, 0.0, true, 1000.0);
	g_cvRatesMinUpd = CreateConVar("sm_pug_rates_min_updaterate", "0",
		"Lowest cl_updaterate allowed on a team. 0 = no check.", FCVAR_NOTIFY, true, 0.0, true, 1000.0);
	g_cvRatesMinRate = CreateConVar("sm_pug_rates_min_rate", "0",
		"Lowest rate allowed on a team. 0 = no check.", FCVAR_NOTIFY, true, 0.0, true, 10000000.0);
	g_cvRatesMinCpu = CreateConVar("sm_pug_rates_min_cpu_level", "0",
		"Lowest cpu_level (Effect Detail: 0 Low, 1 Medium, 2 High) allowed on a team. 0 = no check.",
		FCVAR_NOTIFY, true, 0.0, true, 2.0);
	// For the lerp the engine will actually use, the same way lerptracker
	// works it out. L4D1 has no sv_maxupdaterate, so that one is not read.
	g_cvRatesSvMinUpd = FindConVar("sv_minupdaterate");
	g_cvRatesSvMinRatio = FindConVar("sv_client_min_interp_ratio");
	g_cvRatesSvMaxRatio = FindConVar("sv_client_max_interp_ratio");
	RegConsoleCmd("sm_myrates", Cmd_MyRates, "Show your net settings against the server's limits");
}

bool RatesEnforced()
{
	return g_cvRatesEnforce.BoolValue;
}

int RatesInfoInt(int client, const char[] name)
{
	char buf[32];
	if (!GetClientInfo(client, name, buf, sizeof(buf))) return 0;
	return StringToInt(buf);
}

float RatesInfoFloat(int client, const char[] name)
{
	char buf[32];
	if (!GetClientInfo(client, name, buf, sizeof(buf))) return 0.0;
	return StringToFloat(buf);
}

/** The lerp the engine uses for this client, in seconds: cl_interp, or the
 *  interp ratio over the update rate when that is larger. The server clamps the
 *  ratio (both limits are 0 here, which makes lerp just cl_interp). */
float RatesLerp(int client)
{
	float upd = float(RatesInfoInt(client, "cl_updaterate"));
	if (g_cvRatesSvMinUpd != null && upd < g_cvRatesSvMinUpd.FloatValue) upd = g_cvRatesSvMinUpd.FloatValue;
	if (upd > 100.0) upd = 100.0;   // L4D1's engine cap
	if (upd < 1.0) upd = 1.0;
	float ratio = RatesInfoFloat(client, "cl_interp_ratio");
	if (g_cvRatesSvMinRatio != null && g_cvRatesSvMaxRatio != null && g_cvRatesSvMinRatio.FloatValue != -1.0)
	{
		float lo = g_cvRatesSvMinRatio.FloatValue, hi = g_cvRatesSvMaxRatio.FloatValue;
		if (ratio < lo) ratio = lo;
		if (ratio > hi) ratio = hi;
	}
	float interp = RatesInfoFloat(client, "cl_interp");
	float byRatio = ratio / upd;
	return interp > byRatio ? interp : byRatio;
}

/** Ask the client for cpu_level; the answer lands in the cache a moment later. */
void RatesQueryCpu(int client)
{
	if (g_cvRatesMinCpu.IntValue <= 0 || IsFakeClient(client)) return;
	QueryClientConVar(client, "cpu_level", OnRatesCpu, GetClientUserId(client));
}

public void OnRatesCpu(QueryCookie cookie, int client, ConVarQueryResult result,
	const char[] name, const char[] value, any uid)
{
	if (result != ConVarQuery_Okay) return;
	if (!IsClientInGame(client) || GetClientUserId(client) != uid) return;
	g_fRatesCpu[client] = StringToFloat(value);
	g_iRatesCpuUid[client] = uid;
}

/** Known Low (below the minimum). Unknown never counts. */
bool RatesCpuLow(int client)
{
	int minCpu = g_cvRatesMinCpu.IntValue;
	if (minCpu <= 0 || g_iRatesCpuUid[client] != GetClientUserId(client)) return false;
	return g_fRatesCpu[client] >= 0.0 && g_fRatesCpu[client] < float(minCpu);
}

/** Which net settings fail the limits, as RATES_* bits. Effect Detail is
 *  separate (RatesCpuLow). */
int RatesFails(int client)
{
	int fails = 0;
	float maxLerp = g_cvRatesMaxLerp.FloatValue;
	// A thousandth of a millisecond of slack: the client stores cl_interp as a
	// float, so "0.01" can read back as 0.0100000007.
	if (maxLerp >= 0.0 && RatesLerp(client) > maxLerp + 0.000001) fails |= RATES_LERP;
	int minCmd = g_cvRatesMinCmd.IntValue;
	if (minCmd > 0 && RatesInfoInt(client, "cl_cmdrate") < minCmd) fails |= RATES_CMD;
	int minUpd = g_cvRatesMinUpd.IntValue;
	if (minUpd > 0 && RatesInfoInt(client, "cl_updaterate") < minUpd) fails |= RATES_UPD;
	int minRate = g_cvRatesMinRate.IntValue;
	if (minRate > 0 && RatesInfoInt(client, "rate") < minRate) fails |= RATES_RATE;
	return fails;
}

/** Whether a client's settings pass. On failure `why` holds what to type, one
 *  console command per problem, ready to paste, and `cpuLow` says Effect
 *  Detail is too low (a menu setting, so it gets its own line). */
bool RatesOk(int client, char[] why, int maxlen, bool &cpuLow)
{
	why[0] = '\0';
	cpuLow = false;
	if (!RatesEnforced() || IsFakeClient(client)) return true;
	cpuLow = RatesCpuLow(client);
	int fails = RatesFails(client);
	if (fails & RATES_LERP) Format(why, maxlen, "%s cl_interp 0; cl_interp_ratio 0;", why);
	if (fails & RATES_CMD) Format(why, maxlen, "%s cl_cmdrate %d;", why, g_cvRatesMinCmd.IntValue);
	if (fails & RATES_UPD) Format(why, maxlen, "%s cl_updaterate %d;", why, g_cvRatesMinUpd.IntValue);
	if (fails & RATES_RATE) Format(why, maxlen, "%s rate %d;", why, g_cvRatesMinRate.IntValue);
	return why[0] == '\0' && !cpuLow;
}

/** Tell a failing player what is wrong and how to fix it, at most every 15 s.
 *  `playing` is a player still on a team mid-round, who is not held yet. */
void RatesWarn(int client, const char[] why, bool cpuLow, bool now_, bool playing)
{
	float now = GetEngineTime();
	if (!now_ && now - g_fRatesWarnedAt[client] < 15.0) return;
	g_fRatesWarnedAt[client] = now;
	if (playing)
	{
		PrintToChat(client, "\x04[PUG]\x01 Your game settings are off. Fix them now or you will be held in spectator at the next ready-up.");
	}
	else
	{
		PrintToChat(client, "\x04[PUG]\x01 Your game settings are off, so you are held in spectator until they are fixed.");
	}
	if (why[0] != '\0')
	{
		PrintToChat(client, "\x01Open the console and paste:\x05%s", why);
		PrintToChat(client, "\x01Or get the autoexec from \x05riversidepug.com/how-to-play\x01 so your rates are set every time.");
	}
	if (cpuLow)
	{
		PrintToChat(client, "\x01Effect Detail is on \x04Low\x01, which lets you see through smoke. Options > Video > Advanced > Effect Detail: \x05Medium or High\x01.");
	}
	PrintToChat(client, "\x01You go back on your team as soon as it is fixed. Type \x05!myrates\x01 to check.");
	if (!playing) PrintHintText(client, "Held in spectator: game settings off.\nSee chat for what to change.");
}

/** One L4DV line per net setting in `bits`, with the client's current value
 *  (lerp in ms), for the site's admin feed. Same line l4d_cvarwatch sends for
 *  Effect Detail, which it already reports during live play itself. */
void RatesReport(int client, int bits, const char[] act)
{
	char id[32];
	if (!GetClientAuthId(client, AuthId_SteamID64, id, sizeof(id))) return;
	if (bits & RATES_LERP) PugLog("L4DV id=%s cvar=lerp value=%.1f act=%s", id, RatesLerp(client) * 1000.0, act);
	if (bits & RATES_CMD) PugLog("L4DV id=%s cvar=cl_cmdrate value=%d act=%s", id, RatesInfoInt(client, "cl_cmdrate"), act);
	if (bits & RATES_UPD) PugLog("L4DV id=%s cvar=cl_updaterate value=%d act=%s", id, RatesInfoInt(client, "cl_updaterate"), act);
	if (bits & RATES_RATE) PugLog("L4DV id=%s cvar=rate value=%d act=%s", id, RatesInfoInt(client, "rate"), act);
}

/** Append `item` to a comma-separated list. */
void RatesListAdd(char[] list, int maxlen, const char[] item)
{
	if (list[0] != '\0') StrCat(list, maxlen, ", ");
	StrCat(list, maxlen, item);
}

/** A player on a team during live play whose net settings just went out of
 *  bounds: nothing moves them mid-round (owner 2026-11-04: notice first, act
 *  only if reports show it is common), so everyone is told in chat and the
 *  site's admin feed gets it. Once per spell; fixing it re-arms. */
void RatesLiveNotice(int client, int fails, bool cpuLow)
{
	int now = fails | (cpuLow ? RATES_CPU_TOLD : 0);
	int fresh = now & ~g_iRatesLiveTold[client];
	if (fresh == 0) return;
	bool first = g_iRatesLiveTold[client] == 0;
	g_iRatesLiveTold[client] |= now;
	RatesReport(client, fresh & ~RATES_CPU_TOLD, "live");
	if (!first) return;
	char what[96], item[32];
	if (fails & RATES_LERP)
	{
		Format(item, sizeof(item), "lerp %.1f ms (max %.1f)", RatesLerp(client) * 1000.0, g_cvRatesMaxLerp.FloatValue * 1000.0);
		RatesListAdd(what, sizeof(what), item);
	}
	if (fails & RATES_CMD) { Format(item, sizeof(item), "cl_cmdrate %d", RatesInfoInt(client, "cl_cmdrate")); RatesListAdd(what, sizeof(what), item); }
	if (fails & RATES_UPD) { Format(item, sizeof(item), "cl_updaterate %d", RatesInfoInt(client, "cl_updaterate")); RatesListAdd(what, sizeof(what), item); }
	if (fails & RATES_RATE) { Format(item, sizeof(item), "rate %d", RatesInfoInt(client, "rate")); RatesListAdd(what, sizeof(what), item); }
	if (cpuLow) RatesListAdd(what, sizeof(what), "Effect Detail Low");
	char name[MAX_NAME_LENGTH];
	GetClientName(client, name, sizeof(name));
	PrintToChatAll("\x04[PUG]\x01 %s changed their game settings during live play (%s). Staff have been told; they will be held in spectator at the next ready-up unless they fix it.", name, what);
}

/** Called by Timer_TeamLock for each rostered client, before it places them.
 *  True means leave this client alone this tick. */
bool RatesHold(int client, int have)
{
	// Refresh Effect Detail for the next tick; this one uses the cached answer.
	RatesQueryCpu(client);
	char why[160];
	bool cpuLow;
	if (RatesOk(client, why, sizeof(why), cpuLow))
	{
		if (g_iRatesLiveTold[client] & ~RATES_CPU_TOLD)
		{
			RatesReport(client, g_iRatesLiveTold[client] & ~RATES_CPU_TOLD, "fixed");
		}
		g_iRatesLiveTold[client] = 0;
		if (g_bRatesHeld[client])
		{
			g_bRatesHeld[client] = false;
			PrintToChat(client, "\x04[PUG]\x01 Settings fixed, thanks.");
			char name[MAX_NAME_LENGTH];
			GetClientName(client, name, sizeof(name));
			PrintToChatAll("\x04[PUG]\x01 %s fixed their game settings.", name);
		}
		return false;
	}

	bool first = !g_bRatesHeld[client];
	g_bRatesHeld[client] = true;
	bool onTeam = have == TEAM_SURVIVOR || have == TEAM_INFECTED;
	bool moved = false;
	// Only during ready-up: a mid-round move would hand the other team a 3v4
	// for a cvar. l4dready itself cannot go live with this slot empty.
	if (onTeam && InReadyUp())
	{
		ChangeClientTeam(client, TEAM_SPEC);
		moved = true;
	}
	bool playing = onTeam && !moved;
	if (playing && g_State == MS_Live) RatesLiveNotice(client, RatesFails(client), cpuLow);
	if ((first && !playing) || moved)
	{
		char name[MAX_NAME_LENGTH];
		GetClientName(client, name, sizeof(name));
		PrintToChatAll("\x04[PUG]\x01 %s is held in spectator until their game settings are fixed (%s%s).",
			name, cpuLow ? " Effect Detail Low;" : "", why);
	}
	if (first || moved) PugDebug("rates hold %N (team %d, moved %d, cpuLow %d):%s", client, have, moved, cpuLow, why);
	RatesWarn(client, why, cpuLow, first || moved, playing);
	// Mid-round on a team: nothing moves, but the lock must not treat them as
	// placed either way, so the answer is the same.
	return true;
}

void RatesClientReset(int client)
{
	g_fRatesWarnedAt[client] = 0.0;
	g_bRatesHeld[client] = false;
	g_iRatesLiveTold[client] = 0;
	g_fRatesCpu[client] = -1.0;
	g_iRatesCpuUid[client] = 0;
}

public Action Cmd_MyRates(int client, int args)
{
	if (client <= 0 || !IsClientInGame(client)) return Plugin_Handled;
	char why[160];
	bool cpuLow;
	bool ok = RatesOk(client, why, sizeof(why), cpuLow);
	RatesQueryCpu(client);
	ReplyToCommand(client, "[PUG] lerp %.1f ms (max %.1f), cl_cmdrate %d (min %d), cl_updaterate %d (min %d), rate %d (min %d), cpu_level %s (min %d)%s",
		RatesLerp(client) * 1000.0, g_cvRatesMaxLerp.FloatValue * 1000.0,
		RatesInfoInt(client, "cl_cmdrate"), g_cvRatesMinCmd.IntValue,
		RatesInfoInt(client, "cl_updaterate"), g_cvRatesMinUpd.IntValue,
		RatesInfoInt(client, "rate"), g_cvRatesMinRate.IntValue,
		g_iRatesCpuUid[client] != GetClientUserId(client) ? "unknown" : g_fRatesCpu[client] >= 2.0 ? "High" : g_fRatesCpu[client] >= 1.0 ? "Medium" : "Low",
		g_cvRatesMinCpu.IntValue,
		!RatesEnforced() ? ": not enforced" : ok ? ": all good" : ": needs fixing");
	if (!ok && why[0] != '\0') ReplyToCommand(client, "Paste in console:%s", why);
	if (!ok && cpuLow) ReplyToCommand(client, "Options > Video > Advanced > Effect Detail: Medium or High");
	return Plugin_Handled;
}
