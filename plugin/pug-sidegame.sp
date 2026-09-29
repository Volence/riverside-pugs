/**
 * pug-sidegame - queue side games: a 2v2 or 3v3 on a free box while the PUG
 * queue fills, driven entirely by rcon from the site (src/sideGames.ts).
 *
 * Separate from pug-match on purpose: nothing here may touch a ranked match,
 * and nothing about a side game is ever recorded after the fact (no
 * `matches` row, no SR, no replay, no stats, no Discord post, no site
 * history - the only bookkeeping is the site's own `side_games` table).
 *
 * Commands (all sm_side_* are RegServerCmd: rcon/server console only, never
 * a client). Every one prints exactly one PUGOK/PUGERR line via
 * PrintToServer, which the site's rcon caller reads back:
 *
 *   sm_side_start <token> <password>   arm a side game
 *   sm_side_roster <id64>:<A|B|S> ...  replace the whole seat list
 *   sm_side_popped                     queue popped: bench everyone, ready check
 *   sm_side_resume                     ready check failed: side game back on
 *   sm_side_vote "slug=Name" ...       show a campaign-vote menu to seated players
 *   sm_side_notice <id64> "text"       one line of chat to one player
 *   sm_side_stop <token>               disarm (token must match, once armed)
 *
 * Password handling (controller ruling, 2026-09-29): the backend sends
 * `sm_side_start <token> <password>` and expects `sv_password` to hold that
 * password for as long as the side game is armed, across map changes. A
 * plain `ServerCommand("sv_password ...")` here would not survive one:
 * server.cfg re-execs on every map change, local.cfg runs from it, and
 * local.cfg execs secrets.cfg, which restores this box's standing password a
 * moment later. pug-match hits exactly this (pug-match.sp, around its own
 * OnConfigsExecuted re-assertion of the match password) because
 * OnConfigsExecuted is the one hook that fires AFTER the file that clobbers
 * it; a re-assertion from the backend would be racing a map load it cannot
 * see the end of. So the password is re-asserted here too, every map, for as
 * long as g_bActive holds. sm_side_stop never touches sv_password itself:
 * closing a side game goes through the site's ServerReleaser (forceRestart),
 * which itself ends in `exec secrets.cfg`, and this plugin must never blank
 * a standing password in between.
 *
 * PUGSIDE log lines, signed through PugLog (pug-logauth.inc) exactly like
 * pug-match's own lines:
 *
 *   PUGSIDE event=join     token=<token> steamid=<id64>
 *   PUGSIDE event=part     token=<token> steamid=<id64>
 *   PUGSIDE event=ready    token=<token> steamid=<id64>
 *   PUGSIDE event=vote     token=<token> steamid=<id64> campaign=<slug>
 *   PUGSIDE event=mapstart token=<token> map=<map>
 *   PUGSIDE event=mapend   token=<token> map=<map>
 *
 * Team lock: seated players are walked onto the correct side every 2s
 * (Timer_Lock) via Rotoblin's own sm_sur/sm_inf, the same commands pug-match
 * drives. Orientation (which physical team "A" plays) is read back from
 * where seated players are actually standing, so it survives a mid-map
 * sm_sur/sm_inf-triggered swap. Non-seated humans are pushed to spectate.
 *
 * Ready check: readyup's ready command is sm_ready (registered by
 * Rotoblin's pause module, rotoblin.pause.sp, as an alias resolved through
 * SourceMod's own "!"/"/" chat-trigger handling - hence "!ready" reaching
 * it). AddCommandListener intercepts it while popped, for seated players
 * only, so pressing ready in-game reports back to the matchmaker instead of
 * doing whatever the pause plugin would otherwise do with it.
 *
 * Spec: docs/superpowers/specs/2026-09-28-queue-side-games-design.md
 * Build: ./build-sidegame.sh (mirrors build-tvwatch.sh).
 */
#pragma semicolon 1
#pragma newdecls required

#include <sourcemod>
#include <sdktools>
#include <readyup>
#include "pug-logauth.inc"

#define PLUGIN_VERSION "0.1.0"

#define TEAM_SPEC 1
#define TEAM_SURVIVOR 2
#define TEAM_INFECTED 3
#define MAX_SEATS 8
#define LOCK_ATTEMPT_CAP 5

public Plugin myinfo = {
	name = "PUG Side Game",
	author = "Riverside",
	description = "Queue side games (2v2/3v3) on a free box while the PUG queue fills",
	version = PLUGIN_VERSION,
	url = "",
};

char g_sToken[65];
char g_sPassword[65];
bool g_bActive;
bool g_bPopped;
char g_sSeatId[MAX_SEATS][32];
char g_cSeatTeam[MAX_SEATS];      // 'A', 'B' or 'S'
int g_iSeats;
int g_iSideOfA;                   // TEAM_SURVIVOR or TEAM_INFECTED, 0 = unknown
int g_iAttempts[MAXPLAYERS + 1];
bool g_bReadied[MAXPLAYERS + 1];
bool g_bRoundEnded;
/** Set by the readyup forward OnRoundIsLive; cleared on round_start and map
 *  start. A round_end without this true is not a real end of play (e.g. the
 *  sm_restartmap a shrink's `exec` ends in), and must never log mapend. */
bool g_bHalfWasLive;
int g_iSavedAutoTrack = -1;
char g_sVoteSlug[16][64];
char g_sVoteName[16][64];
int g_iVoteCount;

public void OnPluginStart()
{
	CreateConVar("pug_sidegame_version", PLUGIN_VERSION, "PUG Side Game version",
		FCVAR_NOTIFY | FCVAR_DONTRECORD);
	PugLogAuth_Init();
	RegServerCmd("sm_side_start", Cmd_Start, "sm_side_start <token> <password>");
	RegServerCmd("sm_side_roster", Cmd_Roster, "sm_side_roster <id64>:<A|B|S> ...");
	RegServerCmd("sm_side_popped", Cmd_Popped, "sm_side_popped");
	RegServerCmd("sm_side_resume", Cmd_Resume, "sm_side_resume");
	RegServerCmd("sm_side_vote", Cmd_Vote, "sm_side_vote \"slug=Name\" ...");
	RegServerCmd("sm_side_notice", Cmd_Notice, "sm_side_notice <id64> \"text\"");
	RegServerCmd("sm_side_stop", Cmd_Stop, "sm_side_stop <token>");
	AddCommandListener(Listen_Ready, "sm_ready");
	HookEvent("round_start", Event_RoundStart, EventHookMode_PostNoCopy);
	HookEvent("round_end", Event_RoundEnd, EventHookMode_PostNoCopy);
	CreateTimer(2.0, Timer_Lock, _, TIMER_REPEAT);
	CreateTimer(15.0, Timer_Remind, _, TIMER_REPEAT);
}

// ---------- commands ----------

public Action Cmd_Start(int args)
{
	if (args < 2) { PrintToServer("PUGERR usage: sm_side_start <token> <password>"); return Plugin_Handled; }
	char tok[65], pass[65];
	GetCmdArg(1, tok, sizeof(tok));
	GetCmdArg(2, pass, sizeof(pass));
	if (strlen(tok) < 8) { PrintToServer("PUGERR bad token"); return Plugin_Handled; }
	if (pass[0] == '\0') { PrintToServer("PUGERR bad password"); return Plugin_Handled; }
	strcopy(g_sToken, sizeof(g_sToken), tok);
	strcopy(g_sPassword, sizeof(g_sPassword), pass);
	ConVar at = FindConVar("sm_pug_auto_track");
	if (at != null && g_iSavedAutoTrack < 0) { g_iSavedAutoTrack = at.IntValue; at.IntValue = 0; }
	g_bActive = true;
	g_bPopped = false;
	g_iSeats = 0;
	g_iSideOfA = 0;
	g_iVoteCount = 0;
	// Asserted now, and again every map in OnConfigsExecuted: see the file
	// header note on why the second assertion is required.
	ServerCommand("sv_password \"%s\"", g_sPassword);
	PrintToServer("PUGOK side start");
	return Plugin_Handled;
}

public Action Cmd_Roster(int args)
{
	if (!g_bActive) { PrintToServer("PUGERR not active"); return Plugin_Handled; }
	g_iSeats = 0;
	char arg[48];
	for (int i = 1; i <= args && g_iSeats < MAX_SEATS; i++)
	{
		GetCmdArg(i, arg, sizeof(arg));
		int sep = FindCharInString(arg, ':');
		if (sep < 1) continue;
		char t = arg[sep + 1];
		if (t != 'A' && t != 'B' && t != 'S') continue;
		arg[sep] = '\0';
		strcopy(g_sSeatId[g_iSeats], 32, arg);
		g_cSeatTeam[g_iSeats] = t;
		g_iSeats++;
	}
	for (int c = 1; c <= MaxClients; c++) g_iAttempts[c] = 0;
	PrintToServer("PUGOK roster=%d", g_iSeats);
	return Plugin_Handled;
}

public Action Cmd_Popped(int args)
{
	if (!g_bActive) { PrintToServer("PUGERR not active"); return Plugin_Handled; }
	g_bPopped = true;
	for (int c = 1; c <= MaxClients; c++)
	{
		g_bReadied[c] = false;
		if (IsClientInGame(c) && !IsFakeClient(c) && GetClientTeam(c) != TEAM_SPEC) ChangeClientTeam(c, TEAM_SPEC);
	}
	RemindAll();
	PrintToServer("PUGOK popped");
	return Plugin_Handled;
}

public Action Cmd_Resume(int args)
{
	g_bPopped = false;
	g_iVoteCount = 0;
	PrintToChatAll("\x04[Side]\x01 The ready check failed. Side game back on.");
	PrintToServer("PUGOK resume");
	return Plugin_Handled;
}

public Action Cmd_Vote(int args)
{
	if (!g_bActive || !g_bPopped) { PrintToServer("PUGERR not popped"); return Plugin_Handled; }
	g_iVoteCount = 0;
	char arg[140];
	for (int i = 1; i <= args && g_iVoteCount < 16; i++)
	{
		GetCmdArg(i, arg, sizeof(arg));
		int eq = FindCharInString(arg, '=');
		if (eq < 1) continue;
		strcopy(g_sVoteName[g_iVoteCount], 64, arg[eq + 1]);
		arg[eq] = '\0';
		strcopy(g_sVoteSlug[g_iVoteCount], 64, arg);
		g_iVoteCount++;
	}
	for (int c = 1; c <= MaxClients; c++) if (SeatOf(c) >= 0) ShowVote(c);
	PrintToServer("PUGOK vote=%d", g_iVoteCount);
	return Plugin_Handled;
}

public Action Cmd_Notice(int args)
{
	if (args < 2) { PrintToServer("PUGERR usage: sm_side_notice <id64> \"text\""); return Plugin_Handled; }
	char id[32], text[192];
	GetCmdArg(1, id, sizeof(id));
	GetCmdArg(2, text, sizeof(text));
	int c = ClientOfId(id);
	if (c > 0) PrintToChat(c, "\x04[Side]\x01 %s", text);
	PrintToServer("PUGOK notice");
	return Plugin_Handled;
}

public Action Cmd_Stop(int args)
{
	char tok[65];
	GetCmdArg(1, tok, sizeof(tok));
	if (g_bActive && !StrEqual(tok, g_sToken)) { PrintToServer("PUGERR token"); return Plugin_Handled; }
	g_bActive = false;
	g_bPopped = false;
	g_iSeats = 0;
	g_iVoteCount = 0;
	g_sToken[0] = '\0';
	g_sPassword[0] = '\0';
	// sv_password itself is deliberately left alone: the caller's own
	// forced-restart release ends in `exec secrets.cfg`, which restores the
	// standing password. Blanking it here would leave the box unprotected
	// in between.
	ConVar at = FindConVar("sm_pug_auto_track");
	if (at != null && g_iSavedAutoTrack >= 0) at.IntValue = g_iSavedAutoTrack;
	g_iSavedAutoTrack = -1;
	PrintToServer("PUGOK side stop");
	return Plugin_Handled;
}

// ---------- ready and vote ----------

public Action Listen_Ready(int client, const char[] command, int argc)
{
	if (!g_bActive || !g_bPopped || client <= 0 || SeatOf(client) < 0) return Plugin_Continue;
	char id[32];
	if (!GetClientAuthId(client, AuthId_SteamID64, id, sizeof(id))) return Plugin_Handled;
	g_bReadied[client] = true;
	PugLog("PUGSIDE event=ready token=%s steamid=%s", g_sToken, id);
	return Plugin_Handled;
}

void ShowVote(int client)
{
	if (g_iVoteCount == 0) return;
	Menu menu = new Menu(MenuHandler_Vote);
	menu.SetTitle("Queue popped: campaign vote");
	for (int i = 0; i < g_iVoteCount; i++) menu.AddItem(g_sVoteSlug[i], g_sVoteName[i]);
	menu.Display(client, 30);
}

public int MenuHandler_Vote(Menu menu, MenuAction action, int client, int item)
{
	if (action == MenuAction_End) { delete menu; return 0; }
	if (action != MenuAction_Select || !g_bActive || !g_bPopped) return 0;
	char slug[64], id[32];
	menu.GetItem(item, slug, sizeof(slug));
	if (!GetClientAuthId(client, AuthId_SteamID64, id, sizeof(id))) return 0;
	PugLog("PUGSIDE event=vote token=%s steamid=%s campaign=%s", g_sToken, id, slug);
	PrintToChat(client, "\x04[Side]\x01 Vote sent.");
	return 0;
}

public Action Timer_Remind(Handle t)
{
	if (g_bActive && g_bPopped) RemindAll();
	return Plugin_Continue;
}

void RemindAll()
{
	for (int c = 1; c <= MaxClients; c++)
	{
		if (!IsClientInGame(c) || IsFakeClient(c) || g_bReadied[c] || SeatOf(c) < 0) continue;
		PrintCenterText(c, "QUEUE POPPED: type !ready");
		PrintToChat(c, "\x04[Side]\x01 The queue popped. Type \x05!ready\x01 now (or press Ready on the site).");
	}
}

// ---------- team lock ----------

int SeatOf(int client)
{
	if (!IsClientInGame(client) || IsFakeClient(client)) return -1;
	char id[32];
	if (!GetClientAuthId(client, AuthId_SteamID64, id, sizeof(id))) return -1;
	for (int i = 0; i < g_iSeats; i++) if (StrEqual(g_sSeatId[i], id)) return i;
	return -1;
}

int ClientOfId(const char[] id)
{
	char cid[32];
	for (int c = 1; c <= MaxClients; c++)
	{
		if (!IsClientInGame(c) || IsFakeClient(c)) continue;
		if (GetClientAuthId(c, AuthId_SteamID64, cid, sizeof(cid)) && StrEqual(cid, id)) return c;
	}
	return 0;
}

/** Which game team team A is on, read from where seated players stand. */
void UpdateOrientation()
{
	int aSurv = 0, aInf = 0, bSurv = 0, bInf = 0;
	for (int c = 1; c <= MaxClients; c++)
	{
		int s = SeatOf(c);
		if (s < 0) continue;
		int team = GetClientTeam(c);
		if (g_cSeatTeam[s] == 'A') { if (team == TEAM_SURVIVOR) aSurv++; else if (team == TEAM_INFECTED) aInf++; }
		else if (g_cSeatTeam[s] == 'B') { if (team == TEAM_SURVIVOR) bSurv++; else if (team == TEAM_INFECTED) bInf++; }
	}
	int straight = aSurv + bInf, inverted = aInf + bSurv;
	if (straight > inverted) g_iSideOfA = TEAM_SURVIVOR;
	else if (inverted > straight) g_iSideOfA = TEAM_INFECTED;
	else if (g_iSideOfA == 0) g_iSideOfA = TEAM_SURVIVOR;
}

public Action Timer_Lock(Handle t)
{
	if (!g_bActive || g_bPopped || g_iSeats == 0) return Plugin_Continue;
	UpdateOrientation();
	for (int c = 1; c <= MaxClients; c++)
	{
		if (!IsClientInGame(c) || IsFakeClient(c)) continue;
		int s = SeatOf(c);
		int have = GetClientTeam(c);
		int want = TEAM_SPEC;
		if (s >= 0 && g_cSeatTeam[s] == 'A') want = g_iSideOfA;
		else if (s >= 0 && g_cSeatTeam[s] == 'B') want = (g_iSideOfA == TEAM_SURVIVOR) ? TEAM_INFECTED : TEAM_SURVIVOR;
		if (have == want) { g_iAttempts[c] = 0; continue; }
		if (g_iAttempts[c]++ >= LOCK_ATTEMPT_CAP) continue;
		if (want == TEAM_SPEC) ChangeClientTeam(c, TEAM_SPEC);
		else if (want == TEAM_SURVIVOR)
		{
			if (have == TEAM_INFECTED) ChangeClientTeam(c, TEAM_SPEC);
			FakeClientCommand(c, "sm_sur");
		}
		else FakeClientCommand(c, "sm_inf");
	}
	return Plugin_Continue;
}

// ---------- presence and map events ----------

public void OnClientPostAdminCheck(int client)
{
	if (!g_bActive || IsFakeClient(client)) return;
	char id[32];
	if (!GetClientAuthId(client, AuthId_SteamID64, id, sizeof(id))) return;
	g_iAttempts[client] = 0;
	g_bReadied[client] = false;
	PugLog("PUGSIDE event=join token=%s steamid=%s", g_sToken, id);
	if (g_bPopped && g_iVoteCount > 0 && SeatOf(client) >= 0) ShowVote(client);
}

public void OnClientDisconnect(int client)
{
	// No IsClientInGame guard: someone who quits while still loading (most
	// commonly during a changelevel) is exactly when a part needs to be
	// reported, so the site's 90s reconnect grace actually starts.
	// IsFakeClient only needs a connected client, and GetClientAuthId below
	// already refuses anyone who was never authorized.
	if (!g_bActive || IsFakeClient(client)) return;
	char id[32];
	if (!GetClientAuthId(client, AuthId_SteamID64, id, sizeof(id))) return;
	PugLog("PUGSIDE event=part token=%s steamid=%s", g_sToken, id);
}

public void OnConfigsExecuted()
{
	if (!g_bActive) return;
	g_bRoundEnded = false;
	g_bHalfWasLive = false;
	// Re-assert every map: server.cfg re-execs on every map change, local.cfg
	// runs from it, and local.cfg execs secrets.cfg, which would otherwise
	// silently put the box's standing password back about a second after
	// this side game's players were handed the side password. See the file
	// header note; this mirrors pug-match's own re-assertion.
	if (g_sPassword[0] != '\0') ServerCommand("sv_password \"%s\"", g_sPassword);
	char map[64];
	GetCurrentMap(map, sizeof(map));
	PugLog("PUGSIDE event=mapstart token=%s map=%s", g_sToken, map);
}

public void Event_RoundStart(Event e, const char[] n, bool d)
{
	g_bRoundEnded = false;
	g_bHalfWasLive = false;
	for (int c = 0; c <= MAXPLAYERS; c++) g_iAttempts[c] = 0;
}

/** Rotoblin ready-up go-live signal (global forward; fires even though we
 *  never call any readyup native). A half that never went live (e.g. a
 *  shrink's `exec ...` ending in sm_restartmap mid-map) must never be read
 *  as a real end of play by Event_RoundEnd below. */
public void OnRoundIsLive()
{
	g_bHalfWasLive = true;
}

public void Event_RoundEnd(Event e, const char[] n, bool d)
{
	// round_end can fire twice, and can fire for a round that never actually
	// went live; only a genuine second half's first live round_end ends the map.
	if (!g_bActive || g_bRoundEnded || !g_bHalfWasLive) return;
	g_bRoundEnded = true;
	if (!view_as<bool>(GameRules_GetProp("m_bInSecondHalfOfRound"))) return;
	char map[64];
	GetCurrentMap(map, sizeof(map));
	PugLog("PUGSIDE event=mapend token=%s map=%s", g_sToken, map);
}
