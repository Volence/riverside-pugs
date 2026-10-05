// ---------- !gg: a team that cannot come back can forfeit ----------
//
// A player on the trailing team types !gg (or !ff). The vote only opens when
// the match is decided in practice: even a near-record round on every survivor
// half the team has left would not close the gap. Every rostered teammate in
// game must agree within GG_VOTE_TIME; then the match ends here like !endpug,
// with the score as it stands and forfeit=<team> on MATCH_END and on the dump's
// END line so the site can tag it.
//
// THE CEILING. An L4D1 versus round scores
//     (distance + health bonus + pills/kits) x survivors alive x VersusModifier
// which is 1,840 x modifier at most with four survivors. Kits are converted to
// pills in this config, and full real health at the saferoom almost never
// happens, so real rounds stop far short of that: across ~2,500 recorded rounds
// the best on every stock map is about 1,200 with the modifier divided out
// (2026-10-04), and only 5 ever went over 1,100. pug_gg_ceiling is that
// per-round number before the modifier; the owner chose 1,100.
//
// THE MODIFIER. Read from the mission file the engine loaded, through the game
// filesystem (loose files and VPKs alike), every map start. Never a copied
// table: change a VersusModifier in a mission file and this follows it. If the
// current map cannot be found in any mission file the vote stays closed.
//
// THE MAPS LEFT. The current map's versus list from that mission file, up to
// the backend's stop map, or up to the map before the finale when there is
// none (the same rule FinishSecondHalf/NextMapIsFinale apply). So a campaign
// whose finale is never played, or a 4-map one played to 3, counts only the
// maps the match will actually play.

#define GG_MAX_MISSION_MAPS 16
#define GG_VOTE_TIME 30.0
#define GG_COOLDOWN 60          // seconds before a team that failed a vote can start another

ConVar g_cvGgEnable;
ConVar g_cvGgCeiling;

// The current map's versus chapter list, loaded at map start.
char g_sGgMaps[GG_MAX_MISSION_MAPS][64];
float g_fGgMod[GG_MAX_MISSION_MAPS];
int g_iGgMapCount;               // 0 = the current map was found in no mission file
int g_iGgCurIdx = -1;            // index of the current map in g_sGgMaps
char g_sGgMission[PLATFORM_MAX_PATH];

int g_iGgTeam;                   // pug team (1 = a, 2 = b) running a vote; 0 = none
bool g_bGgYes[MAXPLAYERS + 1];
Handle g_hGgTimer;
int g_iGgFailedAt[3];            // GetTime() a team's last vote failed
int g_iForfeitTeam;              // pug team that forfeited; 0 = none

void Gg_Init()
{
	g_cvGgEnable = CreateConVar("pug_gg_enable", "1", "1 = the trailing team can forfeit with !gg once it cannot realistically come back.");
	g_cvGgCeiling = CreateConVar("pug_gg_ceiling", "1100",
		"Best survivor round a team is assumed able to score, before the map's VersusModifier. !gg opens when even this on every survivor half left cannot close the gap.",
		_, true, 1.0);
	RegConsoleCmd("sm_gg", Cmd_Gg, "Vote to forfeit the match (trailing team, once a comeback is out of reach).");
	RegConsoleCmd("sm_ff", Cmd_Gg, "Vote to forfeit the match (trailing team, once a comeback is out of reach).");
	RegServerCmd("sm_pug_ggcheck", Cmd_GgCheck, "Print the numbers !gg is judged on: totals, maps left and each team's ceiling.");
}

/** Server console: what !gg would see right now, for staff asking why a team
 *  can or cannot forfeit. Works with no match too, to check the mission read. */
public Action Cmd_GgCheck(int args)
{
	int last = Gg_LastScoredIdx();
	PrintToServer("GGCHECK map=%s mission=%s chapter=%d/%d lastScored=%s ceiling=%.0f state=%s",
		g_sCurrentMap, g_sGgMission[0] == '\0' ? "(none)" : g_sGgMission, g_iGgCurIdx + 1, g_iGgMapCount,
		last >= 0 ? g_sGgMaps[last] : "(unknown)", g_cvGgCeiling.FloatValue, StateName(g_State));
	int a, b;
	Gg_Totals(a, b);
	for (int team = 1; team <= 2; team++)
	{
		int best;
		char why[128];
		bool ok = Gg_TeamCeiling(team, best, why, sizeof(why));
		int mine = (team == 1) ? a : b, theirs = (team == 1) ? b : a;
		char msg[192];
		bool allowed = Gg_Allowed(team, msg, sizeof(msg));
		PrintToServer("GGCHECK team=%s score=%d opp=%d best=%d%s%s gg=%s%s%s", team == 1 ? "a" : "b", mine, theirs,
			ok ? best : -1, ok ? "" : " why=", ok ? "" : why, allowed ? "open" : "closed", allowed ? "" : " ", allowed ? "" : msg);
	}
	return Plugin_Handled;
}

void Gg_Reset()
{
	Gg_CancelVote();
	g_iGgFailedAt[1] = 0;
	g_iGgFailedAt[2] = 0;
	g_iForfeitTeam = 0;
}

void Gg_OnMapStart()
{
	// The vote timer is not NO_MAPCHANGE, but a vote across a changelevel would
	// be judged against the wrong map: drop it.
	Gg_CancelVote();
	Gg_LoadMission();
}

void Gg_OnDisconnect(int client)
{
	if (g_iGgTeam == 0) return;
	g_bGgYes[client] = false;
	// The one holdout leaving can complete the vote.
	RequestFrame(Gg_RecheckFrame);
}

public void Gg_RecheckFrame(any unused)
{
	if (g_iGgTeam != 0) Gg_TryPass();
}

// ---------- mission file ----------

/** Fill g_sGgMaps/g_fGgMod with the versus chapters of the mission that holds
 *  the current map. When more than one does (a mission chain repeats chapters
 *  from another campaign), the one that also holds the stop map wins. */
void Gg_LoadMission()
{
	g_iGgMapCount = 0;
	g_iGgCurIdx = -1;
	g_sGgMission[0] = '\0';

	char cur[64];
	GetCurrentMap(cur, sizeof(cur));

	DirectoryListing dir = OpenDirectory("missions", true);
	if (dir == null)
	{
		LogError("[pug] gg: cannot list missions/ through the game filesystem; !gg stays closed");
		return;
	}

	char file[PLATFORM_MAX_PATH], path[PLATFORM_MAX_PATH];
	FileType type;
	bool haveStopMatch = false;
	while (dir.GetNext(file, sizeof(file), type))
	{
		if (type != FileType_File) continue;
		int len = strlen(file);
		if (len < 5 || !StrEqual(file[len - 4], ".txt", false)) continue;
		if (StrEqual(file, "credits.txt", false)) continue;
		Format(path, sizeof(path), "missions/%s", file);

		char maps[GG_MAX_MISSION_MAPS][64];
		float mods[GG_MAX_MISSION_MAPS];
		int n = Gg_ReadVersusChapters(path, maps, mods);
		int curIdx = -1;
		bool hasStop = false;
		for (int i = 0; i < n; i++)
		{
			if (StrEqual(maps[i], cur, false)) curIdx = i;
			if (g_sStopAfterMap[0] != '\0' && StrEqual(maps[i], g_sStopAfterMap, false)) hasStop = true;
		}
		if (curIdx == -1) continue;
		// First match wins, unless a later one also holds the stop map and the
		// kept one does not.
		if (g_iGgMapCount > 0 && (haveStopMatch || !hasStop)) continue;

		for (int i = 0; i < n; i++)
		{
			strcopy(g_sGgMaps[i], sizeof(g_sGgMaps[]), maps[i]);
			g_fGgMod[i] = mods[i];
		}
		g_iGgMapCount = n;
		g_iGgCurIdx = curIdx;
		haveStopMatch = hasStop;
		strcopy(g_sGgMission, sizeof(g_sGgMission), path);
	}
	delete dir;

	if (g_iGgMapCount == 0)
	{
		LogMessage("[pug] gg: %s is in no mission file's versus list; !gg stays closed on this map", cur);
		return;
	}
	char list[512];
	list[0] = '\0';
	for (int i = 0; i < g_iGgMapCount; i++)
		// +0.0005: SourcePawn truncates, and 1.4 is stored as 1.3999...
		Format(list, sizeof(list), "%s%s%s=%.2f", list, i == 0 ? "" : " ", g_sGgMaps[i], g_fGgMod[i] + 0.0005);
	LogMessage("[pug] gg: %s from %s, chapter %d of %d: %s", cur, g_sGgMission, g_iGgCurIdx + 1, g_iGgMapCount, list);
}

/** The "modes" > "versus" chapters of one mission file, in chapter order.
 *  A chapter with no VersusModifier gets 1.0, the engine's default. */
int Gg_ReadVersusChapters(const char[] path, char maps[GG_MAX_MISSION_MAPS][64], float mods[GG_MAX_MISSION_MAPS])
{
	KeyValues kv = new KeyValues("mission");
	if (!kv.ImportFromFile(path) || !kv.JumpToKey("modes") || !kv.JumpToKey("versus"))
	{
		delete kv;
		return 0;
	}
	int n = 0;
	char key[8];
	for (int ch = 1; ch <= GG_MAX_MISSION_MAPS; ch++)
	{
		IntToString(ch, key, sizeof(key));
		if (!kv.JumpToKey(key)) break;
		kv.GetString("Map", maps[n], sizeof(maps[]));
		mods[n] = kv.GetFloat("VersusModifier", 1.0);
		kv.GoBack();
		if (maps[n][0] == '\0') break;
		n++;
	}
	delete kv;
	return n;
}

// ---------- the decision ----------

/** Index of the last map this match scores, in g_sGgMaps; -1 if unknown. */
int Gg_LastScoredIdx()
{
	if (g_sStopAfterMap[0] != '\0')
	{
		for (int i = 0; i < g_iGgMapCount; i++)
			if (StrEqual(g_sGgMaps[i], g_sStopAfterMap, false)) return i;
		return -1;
	}
	// No stop map: the match ends after the map before the finale.
	return g_iGgMapCount >= 2 ? g_iGgMapCount - 2 : -1;
}

/** True when the current map has already been recorded by FinalizeMap. */
bool Gg_CurrentMapFinalized()
{
	return g_iMapCount > 0 && StrEqual(g_sMapName[g_iMapCount - 1], g_sCurrentMap, false);
}

/** Totals including the halves already scored on the current map. */
void Gg_Totals(int &a, int &b)
{
	TotalScores(a, b);
	if (!Gg_CurrentMapFinalized())
	{
		a += g_iHalfScoreA;
		b += g_iHalfScoreB;
	}
}

/** Most points `team` can still be expected to score: ceiling x modifier for
 *  every survivor half it has left. Returns false, with why filled in, when
 *  that cannot be worked out; the caller must then refuse. */
bool Gg_TeamCeiling(int team, int &best, char[] why, int whyLen)
{
	best = 0;
	if (g_iGgMapCount == 0 || g_iGgCurIdx < 0)
	{
		strcopy(why, whyLen, "this map is not in a mission file the server can read");
		return false;
	}
	int last = Gg_LastScoredIdx();
	if (last < 0)
	{
		strcopy(why, whyLen, "the match's last map is not in this campaign's mission file");
		return false;
	}
	if (g_bScoreReadPending)
	{
		strcopy(why, whyLen, "the last round's score is still being read, try again in a few seconds");
		return false;
	}

	float ceiling = g_cvGgCeiling.FloatValue;
	float total = 0.0;

	// The current map: does this team still have its survivor half here?
	if (g_iGgCurIdx <= last && !Gg_CurrentMapFinalized() && !g_bPendingFinalize)
	{
		bool second = view_as<bool>(GameRules_GetProp("m_bInSecondHalfOfRound"));
		bool remaining;
		if (g_iRound1SurvPug != 0) remaining = (g_iRound1SurvPug != team);   // half 1 scored
		else if (second || (g_bRoundEnded && g_bHalfWasLive))
		{
			// A half has ended but nobody knows who played it.
			strcopy(why, whyLen, "this map's first half has no recorded survivor team");
			return false;
		}
		else remaining = true;                                                  // half 1 not over
		if (remaining) total += ceiling * g_fGgMod[g_iGgCurIdx];
	}

	for (int i = g_iGgCurIdx + 1; i <= last; i++)
		total += ceiling * g_fGgMod[i];

	best = RoundToCeil(total);
	return true;
}

/** Whether `team` may forfeit now. On false, msg says why for the player. */
bool Gg_Allowed(int team, char[] msg, int msgLen)
{
	if (!g_cvGgEnable.BoolValue)
	{
		strcopy(msg, msgLen, "Forfeiting is turned off on this server.");
		return false;
	}
	if (g_State != MS_Live)
	{
		strcopy(msg, msgLen, "There is no live match to forfeit.");
		return false;
	}
	int a, b;
	Gg_Totals(a, b);
	int mine = (team == 1) ? a : b;
	int theirs = (team == 1) ? b : a;
	if (mine >= theirs)
	{
		Format(msg, msgLen, "Your team is not behind (%d to %d).", mine, theirs);
		return false;
	}
	int best;
	char why[128];
	if (!Gg_TeamCeiling(team, best, why, sizeof(why)))
	{
		Format(msg, msgLen, "Can't check the score right now: %s.", why);
		return false;
	}
	int gap = theirs - mine;
	if (gap <= best)
	{
		Format(msg, msgLen, "Still winnable: you are down %d and can score up to about %d. !gg opens when you are down more than that.", gap, best);
		return false;
	}
	return true;
}

// ---------- the vote ----------

public Action Cmd_Gg(int client, int args)
{
	if (client <= 0 || !IsClientInGame(client)) return Plugin_Handled;
	int slot = g_iClientRoster[client];
	int gt = GetClientTeam(client);
	if (slot == -1 || (gt != TEAM_SURVIVOR && gt != TEAM_INFECTED))
	{
		ReplyToCommand(client, "[PUG] Only players in the match can forfeit.");
		return Plugin_Handled;
	}
	int team = g_iRosterTeam[slot];

	if (g_iGgTeam != 0 && g_iGgTeam != team)
	{
		ReplyToCommand(client, "[PUG] The other team is voting to forfeit.");
		return Plugin_Handled;
	}

	char msg[192];
	if (!Gg_Allowed(team, msg, sizeof(msg)))
	{
		if (g_iGgTeam == team) Gg_CancelVote();
		ReplyToCommand(client, "[PUG] %s", msg);
		return Plugin_Handled;
	}

	if (g_iGgTeam == 0)
	{
		int wait = g_iGgFailedAt[team] + GG_COOLDOWN - GetTime();
		if (wait > 0)
		{
			ReplyToCommand(client, "[PUG] Your team's last forfeit vote failed. Try again in %d s.", wait);
			return Plugin_Handled;
		}
		g_iGgTeam = team;
		for (int i = 1; i <= MaxClients; i++) g_bGgYes[i] = false;
		g_hGgTimer = CreateTimer(GG_VOTE_TIME, Timer_GgExpire);
	}

	if (g_bGgYes[client])
	{
		ReplyToCommand(client, "[PUG] You already voted to forfeit.");
		return Plugin_Handled;
	}
	g_bGgYes[client] = true;

	int yes, need;
	Gg_Count(yes, need);
	PrintToChatAll("[PUG] %N votes to forfeit for Team %s (%d/%d). Team %s: type !gg within %.0f s to agree.",
		client, team == 1 ? "A" : "B", yes, need, team == 1 ? "A" : "B", GG_VOTE_TIME);
	Gg_TryPass();
	return Plugin_Handled;
}

/** Voters: rostered players of the voting team in game on a playing side. */
void Gg_Count(int &yes, int &need)
{
	yes = 0;
	need = 0;
	for (int c = 1; c <= MaxClients; c++)
	{
		if (!IsClientInGame(c) || IsFakeClient(c)) continue;
		int slot = g_iClientRoster[c];
		if (slot == -1 || g_iRosterTeam[slot] != g_iGgTeam) continue;
		int gt = GetClientTeam(c);
		if (gt != TEAM_SURVIVOR && gt != TEAM_INFECTED) continue;
		need++;
		if (g_bGgYes[c]) yes++;
	}
}

void Gg_TryPass()
{
	int yes, need;
	Gg_Count(yes, need);
	if (need == 0 || yes < need) return;

	int team = g_iGgTeam;
	char msg[192];
	// Judged again at the moment it passes: a round may have been scored
	// since the first !gg.
	if (!Gg_Allowed(team, msg, sizeof(msg)))
	{
		Gg_CancelVote();
		PrintToChatAll("[PUG] Forfeit vote dropped: %s", msg);
		return;
	}
	Gg_CancelVote();
	Gg_Forfeit(team);
}

public Action Timer_GgExpire(Handle timer)
{
	g_hGgTimer = null;
	if (g_iGgTeam == 0) return Plugin_Stop;
	int yes, need;
	Gg_Count(yes, need);
	PrintToChatAll("[PUG] Forfeit vote failed (%d/%d agreed). The match goes on.", yes, need);
	g_iGgFailedAt[g_iGgTeam] = GetTime();
	g_iGgTeam = 0;
	return Plugin_Stop;
}

void Gg_CancelVote()
{
	if (g_hGgTimer != null)
	{
		KillTimer(g_hGgTimer);
		g_hGgTimer = null;
	}
	g_iGgTeam = 0;
	for (int i = 1; i <= MaxClients; i++) g_bGgYes[i] = false;
}

/** End the match with `team` forfeiting. A half already scored on this map is
 *  recorded as a (partial) map first, so the points it earned are kept. */
void Gg_Forfeit(int team)
{
	int a, b;
	Gg_Totals(a, b);
	LogMessage("[pug] match %d: team %s forfeits at a=%d b=%d on %s", g_iMatchId, team == 1 ? "a" : "b", a, b, g_sCurrentMap);
	PrintToChatAll("[PUG] Team %s forfeits. GG.", team == 1 ? "A" : "B");
	if (!g_bPendingFinalize && !Gg_CurrentMapFinalized() && g_iRound1SurvPug != 0) FinalizeMap();
	g_iForfeitTeam = team;
	EndMatchNow("forfeit");
}

/** " forfeit=a" / " forfeit=b" for MATCH_END and the dump's END line; empty
 *  when nobody forfeited, so older backends see the line they always did. */
void Gg_ForfeitTail(char[] out, int maxlen)
{
	if (g_iForfeitTeam == 0) out[0] = '\0';
	else Format(out, maxlen, " forfeit=%s", g_iForfeitTeam == 1 ? "a" : "b");
}

/** The pug team that forfeited (1 = a, 2 = b), 0 if none. */
int Gg_ForfeitTeam()
{
	return g_iForfeitTeam;
}
