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
// Thresholds are the owner's (2026-09-27): what riversidepug.com's autoexec.cfg
// sets. Every one is a cvar and can be turned off on its own, and
// sm_pug_rates_enforce 0 turns the whole gate off.

ConVar g_cvRatesEnforce;
ConVar g_cvRatesMaxLerp;
ConVar g_cvRatesMinCmd;
ConVar g_cvRatesMinUpd;
ConVar g_cvRatesMinRate;
ConVar g_cvRatesSvMinUpd;
ConVar g_cvRatesSvMinRatio;
ConVar g_cvRatesSvMaxRatio;

float g_fRatesWarnedAt[MAXPLAYERS + 1];
bool g_bRatesHeld[MAXPLAYERS + 1];   // last lock tick found this client failing

void RatesInit()
{
	g_cvRatesEnforce = CreateConVar("sm_pug_rates_enforce", "1",
		"1 = rostered players whose net settings fail the sm_pug_rates_* limits are kept off their team (moved to spectator during ready-up). 0 = no check.",
		FCVAR_NOTIFY, true, 0.0, true, 1.0);
	g_cvRatesMaxLerp = CreateConVar("sm_pug_rates_max_lerp", "0.01",
		"Highest lerp allowed on a team, in seconds (0.01 = 10 ms). -1 = no lerp check.",
		FCVAR_NOTIFY, true, -1.0, true, 1.0);
	g_cvRatesMinCmd = CreateConVar("sm_pug_rates_min_cmdrate", "100",
		"Lowest cl_cmdrate allowed on a team. 0 = no check.", FCVAR_NOTIFY, true, 0.0, true, 1000.0);
	g_cvRatesMinUpd = CreateConVar("sm_pug_rates_min_updaterate", "100",
		"Lowest cl_updaterate allowed on a team. 0 = no check.", FCVAR_NOTIFY, true, 0.0, true, 1000.0);
	g_cvRatesMinRate = CreateConVar("sm_pug_rates_min_rate", "100000",
		"Lowest rate allowed on a team. 0 = no check.", FCVAR_NOTIFY, true, 0.0, true, 10000000.0);
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

/** Whether a client's settings pass. On failure `why` holds what to type, one
 *  console command per problem, ready to paste. */
bool RatesOk(int client, char[] why, int maxlen)
{
	why[0] = '\0';
	if (!RatesEnforced() || IsFakeClient(client)) return true;

	float maxLerp = g_cvRatesMaxLerp.FloatValue;
	// A thousandth of a millisecond of slack: the client stores cl_interp as a
	// float, so "0.01" can read back as 0.0100000007.
	if (maxLerp >= 0.0 && RatesLerp(client) > maxLerp + 0.000001)
	{
		Format(why, maxlen, "%s cl_interp 0; cl_interp_ratio 0;", why);
	}
	int minCmd = g_cvRatesMinCmd.IntValue;
	if (minCmd > 0 && RatesInfoInt(client, "cl_cmdrate") < minCmd)
	{
		Format(why, maxlen, "%s cl_cmdrate %d;", why, minCmd);
	}
	int minUpd = g_cvRatesMinUpd.IntValue;
	if (minUpd > 0 && RatesInfoInt(client, "cl_updaterate") < minUpd)
	{
		Format(why, maxlen, "%s cl_updaterate %d;", why, minUpd);
	}
	int minRate = g_cvRatesMinRate.IntValue;
	if (minRate > 0 && RatesInfoInt(client, "rate") < minRate)
	{
		Format(why, maxlen, "%s rate %d;", why, minRate);
	}
	return why[0] == '\0';
}

/** Tell a failing player what is wrong and how to fix it, at most every 15 s.
 *  `playing` is a player still on a team mid-round, who is not held yet. */
void RatesWarn(int client, const char[] why, bool now_, bool playing)
{
	float now = GetEngineTime();
	if (!now_ && now - g_fRatesWarnedAt[client] < 15.0) return;
	g_fRatesWarnedAt[client] = now;
	if (playing)
	{
		PrintToChat(client, "\x04[PUG]\x01 Your net settings are off. Fix them now or you will be held in spectator at the next ready-up. Open the console and paste:");
	}
	else
	{
		PrintToChat(client, "\x04[PUG]\x01 Your net settings are off, so you are held in spectator. Open the console and paste:");
	}
	PrintToChat(client, "\x05%s", why);
	PrintToChat(client, "\x01Or get the autoexec from \x05riversidepug.com/how-to-play\x01 so it is set every time. You go back on your team as soon as it is fixed.");
	if (!playing) PrintHintText(client, "Net settings off: you are held in spectator.\nSee chat for what to type.");
}

/** Called by Timer_TeamLock for each rostered client, before it places them.
 *  True means leave this client alone this tick. */
bool RatesHold(int client, int have)
{
	char why[160];
	if (RatesOk(client, why, sizeof(why)))
	{
		if (g_bRatesHeld[client])
		{
			g_bRatesHeld[client] = false;
			PrintToChat(client, "\x04[PUG]\x01 Net settings fixed, thanks.");
			char name[MAX_NAME_LENGTH];
			GetClientName(client, name, sizeof(name));
			PrintToChatAll("\x04[PUG]\x01 %s fixed their net settings.", name);
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
	if ((first && !playing) || moved)
	{
		char name[MAX_NAME_LENGTH];
		GetClientName(client, name, sizeof(name));
		PrintToChatAll("\x04[PUG]\x01 %s is held in spectator until their net settings are fixed (%s).", name, why);
	}
	if (first || moved) PugDebug("rates hold %N (team %d, moved %d):%s", client, have, moved, why);
	RatesWarn(client, why, first || moved, playing);
	// Mid-round on a team: nothing moves, but the lock must not treat them as
	// placed either way, so the answer is the same.
	return true;
}

void RatesClientReset(int client)
{
	g_fRatesWarnedAt[client] = 0.0;
	g_bRatesHeld[client] = false;
}

public Action Cmd_MyRates(int client, int args)
{
	if (client <= 0 || !IsClientInGame(client)) return Plugin_Handled;
	char why[160];
	bool ok = RatesOk(client, why, sizeof(why));
	ReplyToCommand(client, "[PUG] lerp %.1f ms (max %.1f), cl_cmdrate %d (min %d), cl_updaterate %d (min %d), rate %d (min %d)%s",
		RatesLerp(client) * 1000.0, g_cvRatesMaxLerp.FloatValue * 1000.0,
		RatesInfoInt(client, "cl_cmdrate"), g_cvRatesMinCmd.IntValue,
		RatesInfoInt(client, "cl_updaterate"), g_cvRatesMinUpd.IntValue,
		RatesInfoInt(client, "rate"), g_cvRatesMinRate.IntValue,
		!RatesEnforced() ? ": not enforced" : ok ? ": all good" : ": fix with");
	if (!ok) ReplyToCommand(client, "%s", why);
	return Plugin_Handled;
}
