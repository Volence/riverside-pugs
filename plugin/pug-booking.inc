// ---------- booked scrims: each booking side on its own team (site plan 2026-10-11-scrims-ingame) ----------
//
// A booked scrim's games are adopted by auto-track (sm_pug_auto_track 1), and
// an auto-tracked match has no authoritative roster, so TeamLockActive stood
// the lock down for it and nobody was ever placed (first live scrim,
// 2026-10-11). The site now pushes the booking's people with every game burst
// and its minute re-push:
//
//   sm_pug_book_begin
//   sm_pug_book_add <a|b|s> <steamid64> [steamid64...]   (s: may only watch)
//   sm_pug_book_commit <a|b>                              (survives first on this campaign's first map)
//
// staged and swapped in whole on commit, as l4d_booking's allowlist is. With a
// committed list:
//  - before a game is tracked (MS_None), on a campaign's first map in its
//    first half, each side is placed: the commit's side on survivors, the
//    other on infected. Someone on the other side's team goes to spectator
//    first (which frees the slot that side's player needs) and is placed from
//    there on the next pass;
//  - during a tracked game TeamLockActive holds for the auto-tracked match
//    (its go-live snapshot is the placement above), a rostered player is
//    Timer_TeamLock's, and a booking player not on the match roster (a sub)
//    goes to their side's team when it has room (RosterLateJoiners rosters
//    them at the next go-live);
//  - always, someone who may only watch, or who is not on the booking at all
//    (SourceMod admins excepted), is moved off survivor and infected.
// Nobody is pulled out of spectator except once after arriving (each map
// load), after a role change, or after this module moved them: a player who
// sits out stays out. A full team is never over-filled. sm_pug_book_clear
// (the site's CLEAR_LINES) forgets it all, and so does the end restart.
// The list only counts while l4d_booking_password is set: CLEAR_LINES and a
// restart clear it and a booked box always has one, so a list left over from
// a box the site took away (no CLEAR_LINES on that path) never acts on a
// later PUG or pub. A backend-rostered match is never touched (its roster is
// the authority), and sm_pug_team_lock 0 moves nobody, here as in the lock.

#define BOOK_SIDE_A 1
#define BOOK_SIDE_B 2
#define BOOK_WATCH 3
#define BOOK_UNKNOWN -1            // Book_RoleOf: no SteamID for the client yet, so its role is not known
#define BOOK_CHUNK_MAX 32          // ids one sm_pug_book_add line may carry (the site sends 10)
#define BOOK_PLACE_TRIES 8         // placement attempts after an arrival or a role change, one per lock tick (2 s)
#define BOOK_TELL_GAP 20.0         // seconds between two placement notices to one client

StringMap g_hBook;                 // committed: SteamID64 -> BOOK_SIDE_A | BOOK_SIDE_B | BOOK_WATCH
StringMap g_hBookStaged;           // between begin and commit; null otherwise
bool g_bBookLoaded;
int g_iBookFirst;                  // BOOK_SIDE_A or BOOK_SIDE_B; 0 before the first commit
bool g_bBookPlace[MAXPLAYERS + 1]; // place this client on their side (arrival, role change, a move made here)
int g_iBookTries[MAXPLAYERS + 1];
int g_iBookRole[MAXPLAYERS + 1];   // the role last seen for this client; a change re-arms the placement
float g_fBookToldAt[MAXPLAYERS + 1];

void Book_Init()
{
	g_hBook = new StringMap();
	RegServerCmd("sm_pug_book_begin", Cmd_BookBegin, "sm_pug_book_begin - start staging a booked scrim's people");
	RegServerCmd("sm_pug_book_add", Cmd_BookAdd, "sm_pug_book_add <a|b|s> <steamid64> [steamid64...] - stage people of side a, side b, or watchers");
	RegServerCmd("sm_pug_book_commit", Cmd_BookCommit, "sm_pug_book_commit <a|b> - make the staged people active; that side survives first on this campaign's first map");
	RegServerCmd("sm_pug_book_clear", Cmd_BookClear, "sm_pug_book_clear - forget the booked scrim's people (the booking ended)");
	RegServerCmd("sm_pug_book_status", Cmd_BookStatus, "sm_pug_book_status [steamid64] - counts, the first side, and one id's role");
}

/** A booked scrim's people are loaded and the box is booked right now (l4d_booking's
 *  password is set): the placement runs and the lock holds for an auto-tracked match. */
bool Book_Active()
{
	if (!g_bBookLoaded || g_hBook.Size == 0) return false;
	ConVar cv = FindConVar("l4d_booking_password");
	if (cv == null) return false;
	char pass[8];
	cv.GetString(pass, sizeof(pass));
	return pass[0] != '\0';
}

static bool Book_IsId64(const char[] id)
{
	if (strlen(id) != 17) return false;
	for (int i = 0; i < 17; i++)
	{
		if (id[i] < '0' || id[i] > '9') return false;
	}
	return true;
}

public Action Cmd_BookBegin(int args)
{
	delete g_hBookStaged;
	g_hBookStaged = new StringMap();
	PrintToServer("PUGOK book begin");
	return Plugin_Handled;
}

public Action Cmd_BookAdd(int args)
{
	if (g_hBookStaged == null)
	{
		PrintToServer("PUGERR book add without begin");
		return Plugin_Handled;
	}
	char role[4];
	GetCmdArg(1, role, sizeof(role));
	int code = StrEqual(role, "a") ? BOOK_SIDE_A : StrEqual(role, "b") ? BOOK_SIDE_B : StrEqual(role, "s") ? BOOK_WATCH : 0;
	if (code == 0 || args < 2)
	{
		PrintToServer("PUGERR usage: sm_pug_book_add <a|b|s> <steamid64> [steamid64...]");
		return Plugin_Handled;
	}
	int added = 0, skipped = 0;
	char id[32];
	for (int i = 2; i <= args && i <= BOOK_CHUNK_MAX + 1; i++)
	{
		GetCmdArg(i, id, sizeof(id));
		if (!Book_IsId64(id)) { skipped++; continue; }
		g_hBookStaged.SetValue(id, code);
		added++;
	}
	PrintToServer("PUGOK book add role=%s added=%d skipped=%d", role, added, skipped);
	return Plugin_Handled;
}

public Action Cmd_BookCommit(int args)
{
	char first[4];
	GetCmdArg(1, first, sizeof(first));
	int side = StrEqual(first, "a") ? BOOK_SIDE_A : StrEqual(first, "b") ? BOOK_SIDE_B : 0;
	if (g_hBookStaged == null || side == 0)
	{
		// The staged list (if any) is kept, and the committed one stays in force.
		PrintToServer("PUGERR usage: sm_pug_book_commit <a|b>, after sm_pug_book_begin");
		return Plugin_Handled;
	}
	delete g_hBook;
	g_hBook = g_hBookStaged;
	g_hBookStaged = null;
	g_bBookLoaded = true;
	g_iBookFirst = side;
	// A role that changed (a watcher made a sub, someone added) is placed again.
	for (int c = 1; c <= MaxClients; c++)
	{
		if (!IsClientInGame(c) || IsFakeClient(c)) continue;
		int role = Book_RoleOf(c);
		if (role != BOOK_UNKNOWN && role != g_iBookRole[c])
		{
			g_iBookRole[c] = role;
			g_bBookPlace[c] = true;
			g_iBookTries[c] = 0;
		}
	}
	PrintToServer("PUGOK book commit ids=%d first=%s", g_hBook.Size, first);
	return Plugin_Handled;
}

public Action Cmd_BookClear(int args)
{
	delete g_hBookStaged;
	g_hBook.Clear();
	g_bBookLoaded = false;
	g_iBookFirst = 0;
	for (int c = 0; c <= MaxClients; c++)
	{
		g_bBookPlace[c] = false;
		g_iBookTries[c] = 0;
		g_iBookRole[c] = 0;
		g_fBookToldAt[c] = 0.0;
	}
	PrintToServer("PUGOK book clear");
	return Plugin_Handled;
}

/** Counts, never the ids; with an id, that id's role (0 none, 1 a, 2 b, 3 watch). */
public Action Cmd_BookStatus(int args)
{
	int role = -1;
	if (args >= 1)
	{
		char id[32];
		GetCmdArg(1, id, sizeof(id));
		if (!g_hBook.GetValue(id, role)) role = 0;
	}
	PrintToServer("PUGOK book loaded=%d ids=%d staged=%d first=%s firstmap=%d active=%d teamlock=%d role=%d",
		g_bBookLoaded ? 1 : 0, g_hBook.Size, g_hBookStaged == null ? -1 : g_hBookStaged.Size,
		g_iBookFirst == BOOK_SIDE_A ? "a" : g_iBookFirst == BOOK_SIDE_B ? "b" : "none",
		Book_FirstHalfOfFirstMap() ? 1 : 0, Book_Active() ? 1 : 0, TeamLockActive() ? 1 : 0, role);
	return Plugin_Handled;
}

/** The client's booking role, 0 when not on the booking, or BOOK_UNKNOWN
 *  while the client has no SteamID yet (never read as a stranger). */
int Book_RoleOf(int client)
{
	char id[32];
	if (!GetClientAuthId(client, AuthId_SteamID64, id, sizeof(id))) return BOOK_UNKNOWN;
	int role;
	return g_hBook.GetValue(id, role) ? role : 0;
}

/** The first half of a campaign's first map. L4D_IsFirstMapInScenario is
 *  optional in left4dhooks and an unbound native throws, so it is
 *  feature-checked (as the standalone replay does); absent, never. */
bool Book_FirstHalfOfFirstMap()
{
	if (GetFeatureStatus(FeatureType_Native, "L4D_IsFirstMapInScenario") != FeatureStatus_Available) return false;
	if (!L4D_IsFirstMapInScenario()) return false;
	return !view_as<bool>(GameRules_GetProp("m_bInSecondHalfOfRound"));
}

/** The pug team the booking side plays as in the tracked match: the majority
 *  of that side's people on the roster; 0 when none are rostered. */
int Book_PugOfSide(int side)
{
	int n[3];
	int role;
	for (int i = 0; i < g_iRosterCount; i++)
	{
		if (!g_hBook.GetValue(g_sRosterId[i], role) || role != side) continue;
		n[g_iRosterTeam[i]]++;
	}
	return n[1] > n[2] ? 1 : n[2] > n[1] ? 2 : 0;
}

/** The game team a booking side belongs on right now, or 0 when this module
 *  does not know (between games away from a first map, after the finale, or
 *  while a tracked match's mapping is not settled: Timer_TeamLock's seed hold
 *  and its blind vote, the changelevel window where g_iPugSide is still the
 *  previous half's). */
int Book_TeamOfSide(int side)
{
	if (g_State == MS_Pending || g_State == MS_Live)
	{
		if (g_bSeedHold) return 0;
		int straight, inverted;
		OrientationVote(straight, inverted);
		if (straight == 0 && inverted == 0) return 0;
		int pug = Book_PugOfSide(side);
		return pug == 0 ? 0 : g_iPugSide[pug];
	}
	if (g_State == MS_None && Book_FirstHalfOfFirstMap())
		return side == g_iBookFirst ? TEAM_SURVIVOR : TEAM_INFECTED;
	return 0;
}

/** A human slot is open on this team (survivor_limit / z_max_player_zombies; 4 without them). */
bool Book_HasRoom(int team)
{
	ConVar cv = FindConVar(team == TEAM_SURVIVOR ? "survivor_limit" : "z_max_player_zombies");
	int limit = cv != null ? cv.IntValue : 4;
	int n = 0;
	for (int c = 1; c <= MaxClients; c++)
	{
		if (IsClientInGame(c) && !IsFakeClient(c) && GetClientTeam(c) == team) n++;
	}
	return n < limit;
}

void Book_Tell(int client, const char[] text)
{
	float now = GetEngineTime();
	if (now - g_fBookToldAt[client] < BOOK_TELL_GAP) return;
	g_fBookToldAt[client] = now;
	PrintToChat(client, "%s", text);
}

/** Every lock tick (Timer_TeamLock calls it first, in every match state). */
void Book_Pass()
{
	if (!Book_Active()) return;
	// sm_pug_team_lock 0 is the testing switch: nobody is moved.
	if (!g_cvTeamLock.BoolValue) return;
	// A backend-rostered match (a site PUG or tournament game, not
	// self-started): its roster is the authority, not a booking list.
	if (g_State != MS_None && !g_bSelfStarted) return;
	bool tracked = g_State == MS_Pending || g_State == MS_Live;
	for (int c = 1; c <= MaxClients; c++)
	{
		if (!IsClientInGame(c) || IsFakeClient(c) || IsClientSourceTV(c)) continue;
		int have = GetClientTeam(c);
		if (have == 0) continue; // still loading in
		// A rostered player of a tracked match is Timer_TeamLock's, watcher or not:
		// the roster is the authority until that game ends.
		if (tracked && g_iClientRoster[c] != -1) { g_bBookPlace[c] = false; continue; }
		int role = Book_RoleOf(c);
		if (role == BOOK_UNKNOWN) continue; // no SteamID yet: not a stranger, just not known
		if (role != g_iBookRole[c])
		{
			g_iBookRole[c] = role;
			g_bBookPlace[c] = true;
			g_iBookTries[c] = 0;
		}
		bool onSide = have == TEAM_SURVIVOR || have == TEAM_INFECTED;
		if (role == 0 || role == BOOK_WATCH)
		{
			// Staff (SourceMod admins) play or test as they like.
			if (role == 0 && GetUserAdmin(c) != INVALID_ADMIN_ID) continue;
			if (!onSide) continue;
			ChangeClientTeam(c, TEAM_SPEC);
			if (role == BOOK_WATCH) Book_Tell(c, "[Booking] You can watch this scrim. To play, ask a captain to type !sub with your name.");
			else Book_Tell(c, "[Booking] You are not on this booking. A captain can type !allow with your name to let you watch, or !sub to let you play.");
			continue;
		}
		int want = Book_TeamOfSide(role);
		if (want == 0) continue;
		if (have == want) { g_bBookPlace[c] = false; g_iBookTries[c] = 0; continue; }
		if (onSide)
		{
			ChangeClientTeam(c, TEAM_SPEC);
			g_bBookPlace[c] = true;
			g_iBookTries[c] = 0;
			Book_Tell(c, "[Booking] That is the other side's team. Moving you to your own.");
			continue;
		}
		if (!g_bBookPlace[c]) continue; // sitting out by choice
		if (g_iBookTries[c] >= BOOK_PLACE_TRIES)
		{
			g_bBookPlace[c] = false;
			Book_Tell(c, "[Booking] Your side's team is full, so you stay in spectator. Join it when a slot opens.");
			continue;
		}
		g_iBookTries[c]++;
		if (!Book_HasRoom(want)) continue;
		PugDebug("book: placing %N on %s (try %d)", c, want == TEAM_SURVIVOR ? "survivor" : "infected", g_iBookTries[c]);
		FakeClientCommand(c, want == TEAM_SURVIVOR ? "sm_sur" : "sm_inf");
	}
}

/** Every connect, map changes included: placed once more after arriving. */
void Book_OnClientPostAdminCheck(int client)
{
	g_bBookPlace[client] = true;
	g_iBookTries[client] = 0;
	g_iBookRole[client] = Book_Active() ? Book_RoleOf(client) : 0;
	g_fBookToldAt[client] = 0.0;
}

void Book_OnDisconnect(int client)
{
	g_bBookPlace[client] = false;
	g_iBookTries[client] = 0;
	g_iBookRole[client] = 0;
	g_fBookToldAt[client] = 0.0;
}
