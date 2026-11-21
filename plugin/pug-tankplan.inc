/**
 * Tank order (owner, 2026-11-15; Discord "everyone plays tank" thread).
 *
 * Every player tanks once, and the same SR rank on both teams tanks the same
 * map. The site ranks each pug team by season SR at match start (slot 1 =
 * highest) and shuffles which slot tanks which map; both teams share the
 * shuffle. It sends the slot as a 4th roster field ("<sid>:<team>:<joined>:<slot>")
 * and the shuffle as sm_pug_tankorder "<digits>", e.g. "3142": map ordinal k
 * (g_iMapCount) is tanked by slot order[k % len]. A campaign with fewer maps
 * than slots leaves the last slots of the order out, so who sits out is random.
 *
 * l4d_tank_control (Riverside fork) asks PUG_PlannedTank() whenever it picks a
 * map's first tank, and falls back to its own "everyone once, random order"
 * pick on 0. 0 means: no plan (self-started, booking, older site), no live
 * match, or nobody on the infected side can take this map's slot.
 *
 * A sub inherits the slot of the player who is gone: when the slot's owner is
 * not on the infected side, a present unslotted player (a sub or late joiner)
 * on that side is picked at random.
 *
 * Globals g_iRosterTankSlot / g_sTankOrder are declared beside the roster in
 * pug-match.sp so Cmd_Roster and ResetMatchState can reach them.
 */

void TankPlanInit()
{
	RegServerCmd("sm_pug_tankorder", Cmd_TankOrder,
		"sm_pug_tankorder <digits> - tank slot per map ordinal for the configured match, e.g. 3142");
	RegConsoleCmd("sm_tanks", Cmd_Tanks, "Show who tanks each map of this match");
}

// 0.3.48: the tank list was printed to everyone at this match's first go-live.
bool g_bTankListShown;

void TankPlanRegisterNatives()
{
	CreateNative("PUG_PlannedTank", Native_PlannedTank);
}

void TankPlanReset()
{
	g_sTankOrder[0] = '\0';
	g_bTankListShown = false;
	for (int i = 0; i < MAX_ROSTER; i++) g_iRosterTankSlot[i] = 0;
}

/** The roster arg after "<sid>:<team>": ":<joined>[:<slot>]". Called with the
 *  text from the first ':' after the team letter (or an empty string). */
void TankPlanParseRosterTail(int slot, const char[] tail)
{
	if (tail[0] != ':') return;
	int sep = FindCharInString(tail[1], ':');
	if (sep == -1) return;
	int v = StringToInt(tail[sep + 2]);
	g_iRosterTankSlot[slot] = (v >= 1 && v <= 9) ? v : 0;
}

public Action Cmd_TankOrder(int args)
{
	if (g_State == MS_None || args < 1)
	{
		PrintToServer("PUGERR no match configured");
		return Plugin_Handled;
	}
	char buf[sizeof(g_sTankOrder)];
	GetCmdArg(1, buf, sizeof(buf));
	int n = strlen(buf);
	if (n == 0)
	{
		PrintToServer("PUGERR empty tank order");
		return Plugin_Handled;
	}
	for (int i = 0; i < n; i++)
	{
		if (buf[i] < '1' || buf[i] > '9')
		{
			PrintToServer("PUGERR bad tank order: %s", buf);
			return Plugin_Handled;
		}
	}
	strcopy(g_sTankOrder, sizeof(g_sTankOrder), buf);
	PrintToServer("PUGOK tankorder=%s", g_sTankOrder);
	LogMessage("[pug] match %d tank order %s", g_iMatchId, g_sTankOrder);
	return Plugin_Handled;
}

/** The tank slot for the map being played, or 0 when there is no plan. */
int TankPlanSlotNow()
{
	int n = strlen(g_sTankOrder);
	if (n == 0) return 0;
	return g_sTankOrder[g_iMapCount % n] - '0';
}

/** Client on the infected side who should take this map's tank, or 0. */
int TankPlanPick()
{
	if (g_State != MS_Pending && g_State != MS_Live) return 0;
	int want = TankPlanSlotNow();
	if (want == 0) return 0;
	int subs[MAXPLAYERS + 1];
	int nSubs = 0;
	for (int c = 1; c <= MaxClients; c++)
	{
		if (!IsClientInGame(c) || IsFakeClient(c) || GetClientTeam(c) != TEAM_INFECTED) continue;
		int r = g_iClientRoster[c];
		if (r >= 0 && Tourney_SlotOut(r)) continue;
		int s = (r >= 0) ? g_iRosterTankSlot[r] : 0;
		if (s == want) return c;
		if (s == 0) subs[nSubs++] = c;
	}
	if (nSubs == 0) return 0;
	return subs[GetRandomInt(0, nSubs - 1)];
}

public int Native_PlannedTank(Handle plugin, int numParams)
{
	int c = TankPlanPick();
	int r = (c > 0) ? g_iClientRoster[c] : -1;
	LogMessage("[pug] tank plan: map %d order %s slot %d -> %s%L", g_iMapCount,
		g_sTankOrder[0] ? g_sTankOrder : "-", TankPlanSlotNow(),
		c <= 0 ? "none (fallback) " : (r >= 0 && g_iRosterTankSlot[r] != 0) ? "" : "sub ", c > 0 ? c : 0);
	return c;
}

/**
 * 0.3.48 (Traps, Discord tank thread 2026-11-17; owner 11-21): !tanks lists who
 * tanks each map, like l4d2center. One line per map ordinal: pug team A's
 * player for that map's slot, then team B's. A campaign shorter than the order
 * simply ends early, so the last lines may never be played.
 */
static void TankPlanName(int team, int slot, char[] out, int len)
{
	for (int i = 0; i < g_iRosterCount; i++)
	{
		if (g_iRosterTeam[i] != team || g_iRosterTankSlot[i] != slot) continue;
		if (Tourney_SlotOut(i)) continue;
		int c = ClientOfSlot(i);
		if (c != -1) GetClientName(c, out, len);
		else if (g_sRosterName[i][0]) FormatEx(out, len, "%s (away)", g_sRosterName[i]);
		else strcopy(out, len, "(away)");
		return;
	}
	strcopy(out, len, "a sub");
}

void TankPlanPrint(int client)
{
	int n = strlen(g_sTankOrder);
	if ((g_State != MS_Pending && g_State != MS_Live) || n == 0)
	{
		if (client > 0) PrintToChat(client, "[Tank] No tank order for this match: everyone tanks once, in random order.");
		return;
	}
	int last = (g_iMapCount >= n) ? g_iMapCount : n - 1;
	char a[MAX_NAME_LENGTH + 8], b[MAX_NAME_LENGTH + 8], line[192];
	for (int k = 0; k <= last; k++)
	{
		int slot = g_sTankOrder[k % n] - '0';
		TankPlanName(1, slot, a, sizeof(a));
		TankPlanName(2, slot, b, sizeof(b));
		FormatEx(line, sizeof(line), "[Tank] Map %d%s: %s vs %s", k + 1,
			k == g_iMapCount ? " (this map)" : (k < g_iMapCount ? " (done)" : ""), a, b);
		if (client > 0) PrintToChat(client, "%s", line);
		else PrintToChatAll("%s", line);
	}
}

public Action Cmd_Tanks(int client, int args)
{
	if (client == 0)
	{
		PrintToServer("[pug] tank order %s map %d", g_sTankOrder[0] ? g_sTankOrder : "-", g_iMapCount);
		return Plugin_Handled;
	}
	TankPlanPrint(client);
	return Plugin_Handled;
}

/** OnRoundIsLive, match live: show everyone the list once, at the match's first go-live. */
void TankPlanGoLive()
{
	if (g_bTankListShown || g_sTankOrder[0] == '\0') return;
	g_bTankListShown = true;
	TankPlanPrint(0);
	PrintToChatAll("[Tank] Type !tanks to see this again.");
}
