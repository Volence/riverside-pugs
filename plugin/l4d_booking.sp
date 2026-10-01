/**
 * l4d_booking - keep a booked server's own passwords across map changes.
 *
 * The site (src/bookings/runner.ts) books a pool server for two sides and
 * gives it a private sv_password, a private SourceTV tv_password and a line
 * for the ready-up panel. server.cfg re-runs on every map change, local.cfg
 * runs from it and puts the box's standing sv_password (secrets.cfg) and
 * tv_password back, so a value set over rcon lasts one map. This plugin holds
 * the booking's values in its own cvars, which no cfg touches, and applies
 * them from OnConfigsExecuted, the one hook that runs after those files (the
 * same reason pug-match.sp re-asserts its match password there).
 *
 * Empty l4d_booking_password means "not booked": nothing is touched. Every
 * booking ends with an srcds restart, which empties the cvars again.
 *
 * 1.1.0 adds the booking's captain commands. Players never get the rcon
 * password; instead the site lists the booking's captains (steamid64s of the
 * managers of a confirmed side) in l4d_booking_captains, and a captain's
 * !nextmap, !stay, !end and !extend go out as signed PUGBOOK log lines
 * (pug-logauth.inc, the same signing pug-match and l4d_tvwatch use) for the
 * site to act on. The plugin's captain list is only a courtesy filter; the
 * site re-checks every command against its own idea of who is a captain.
 * sm_booking_cmd emits the same line without the captain check, for testing
 * and staff.
 *
 * 1.1.1: the chat words match in any case (!NextMap), and a captain is told
 * "Sent to the site" only when the box has its log secret; without one the
 * site cannot verify the line, so the captain is pointed at the booking page.
 *
 * 1.2.0: a booked server lets in only its people and staff. The site pushes
 * the booking's allowlist (each side's players, ringers and approved
 * spectators, plus staff) as sm_booking_allow_begin, sm_booking_allow_add
 * <id64...> and sm_booking_allow_commit; the list is staged and swapped in
 * whole on commit, so a push cut short leaves the last committed list in
 * force. Anyone else who joins (not a bot, not SourceTV, not a SourceMod
 * admin) gets l4d_booking_grace seconds for a captain to type
 * !allow <name>, which adds them at once and tells the site (cmd=allow).
 * When the grace runs out they are kicked and blocked from this box for
 * l4d_booking_block minutes; a commit that carries their id lifts the block.
 * Grace and block are kept per SteamID64, so a reconnect or a map change
 * cannot reset them. Nothing is enforced until the box is booked and a list
 * has been committed.
 *
 * 1.2.1: when the site refuses an !allow it sends sm_booking_allow_refuse
 * <id64>, which takes the player back off the active list and, if they are
 * still here, starts their grace again (the notices of a fresh connect)
 * rather than kicking them outright. Without the log secret a captain's
 * !allow adds nobody, since the site would never hear of it. Emptying
 * l4d_booking_password forgets the list, graces and blocks, so nothing
 * carries into a later booking on the same srcds. l4d_booking_grace is at
 * least 15 seconds, the site's own minimum.
 *
 * Build: ./build-booking.sh
 */
#pragma semicolon 1
#pragma newdecls required
#include <sourcemod>
#include "pug-logauth.inc"

#define PLUGIN_VERSION "1.2.1"

/** Longest arg= text on a PUGBOOK line, plus the null terminator. Matches
 *  the site parser's cap (Task 6). */
#define BOOKING_ARG_MAX 65

ConVar g_cvPassword;
ConVar g_cvTvPassword;
ConVar g_cvNotice;
ConVar g_cvCaptains;
ConVar g_cvGrace;
ConVar g_cvBlock;

/** The committed allowlist (SteamID64 -> true) and whether one has ever been
 *  committed. Plugin globals survive map changes; an srcds restart (every
 *  booking ends with one) empties them. */
StringMap g_hAllowed;
bool g_bListLoaded;
/** The list being staged between begin and commit; null when none is. */
StringMap g_hStaged;
/** SteamID64 -> GetTime() deadline of a running grace. */
StringMap g_hGrace;
/** SteamID64 -> GetTime() a block ends. */
StringMap g_hBlocked;

/** The four captain chat commands, chat form (leading '!', as typed) and the
 *  bare cmd= word the PUGBOOK line uses. Parallel arrays, same order. */
static const char g_sChatWords[][] = { "!nextmap", "!stay", "!end", "!extend" };
static const char g_sCmdWords[][] = { "nextmap", "stay", "end", "extend" };

public Plugin myinfo = {
	name = "L4D1 Booked Server",
	author = "Riverside",
	description = "Holds a booked server's private passwords across map changes.",
	version = PLUGIN_VERSION,
	url = "https://riversidepug.com",
};

public void OnPluginStart()
{
	// SetString: a cvar left by an earlier load keeps its old value otherwise.
	CreateConVar("l4d_booking_version", PLUGIN_VERSION, "L4D1 Booked Server version", FCVAR_NOTIFY | FCVAR_DONTRECORD).SetString(PLUGIN_VERSION);
	g_cvPassword = CreateConVar("l4d_booking_password", "", "The booking's sv_password; empty when the box is not booked.", FCVAR_PROTECTED | FCVAR_DONTRECORD);
	g_cvTvPassword = CreateConVar("l4d_booking_tv_password", "", "The booking's SourceTV password.", FCVAR_PROTECTED | FCVAR_DONTRECORD);
	g_cvNotice = CreateConVar("l4d_booking_notice", "", "Ready-up panel line for the booking.", FCVAR_DONTRECORD);
	g_cvCaptains = CreateConVar("l4d_booking_captains", "", "Comma-separated SteamID64s of this booking's captains.", FCVAR_DONTRECORD);
	g_cvGrace = CreateConVar("l4d_booking_grace", "60", "Seconds a captain has to !allow someone who is not on the booking.", FCVAR_DONTRECORD, true, 15.0);
	g_cvBlock = CreateConVar("l4d_booking_block", "30", "Minutes someone kicked for not being on the booking stays out; 0 for no block.", FCVAR_DONTRECORD, true, 0.0);
	g_cvPassword.AddChangeHook(OnBookingCvarChanged);
	g_cvTvPassword.AddChangeHook(OnBookingCvarChanged);
	g_cvNotice.AddChangeHook(OnBookingCvarChanged);

	PugLogAuth_Init();
	RegServerCmd("sm_booking_cmd", Cmd_BookingCmd, "sm_booking_cmd <steamid64> <cmd> [arg...] - emit a PUGBOOK line without the captain check, for testing and staff");

	g_hAllowed = new StringMap();
	g_hGrace = new StringMap();
	g_hBlocked = new StringMap();
	RegServerCmd("sm_booking_allow_begin", Cmd_AllowBegin, "sm_booking_allow_begin - start staging a new allowlist");
	RegServerCmd("sm_booking_allow_add", Cmd_AllowAdd, "sm_booking_allow_add <steamid64> [steamid64...] - add ids to the staged allowlist");
	RegServerCmd("sm_booking_allow_commit", Cmd_AllowCommit, "sm_booking_allow_commit - make the staged allowlist the active one");
	RegServerCmd("sm_booking_allow_refuse", Cmd_AllowRefuse, "sm_booking_allow_refuse <steamid64> - the site refused an !allow: take them off the active list and start their grace again");
	RegServerCmd("sm_booking_status", Cmd_BookingStatus, "sm_booking_status - whether a list is loaded, its size, running graces and blocks");
	// No TIMER_FLAG_NO_MAPCHANGE: graces keep running through a map change.
	CreateTimer(1.0, Timer_Graces, _, TIMER_REPEAT);
}

public void OnConfigsExecuted()
{
	Apply();
}

public void OnBookingCvarChanged(ConVar cv, const char[] oldValue, const char[] newValue)
{
	// Not booked any more: forget this booking's people, so nothing it left
	// behind can carry into a later booking on the same srcds.
	if (cv == g_cvPassword && newValue[0] == '\0') ResetAllowlist();
	Apply();
}

void ResetAllowlist()
{
	g_hAllowed.Clear();
	g_bListLoaded = false;
	g_hGrace.Clear();
	g_hBlocked.Clear();
}

void Apply()
{
	char pw[64];
	g_cvPassword.GetString(pw, sizeof(pw));
	if (pw[0] == '\0') return;
	ConVar sv = FindConVar("sv_password");
	if (sv != null) sv.SetString(pw);

	char tv[64];
	g_cvTvPassword.GetString(tv, sizeof(tv));
	ConVar tvp = FindConVar("tv_password");
	if (tvp != null && tv[0] != '\0') tvp.SetString(tv);

	char notice[128];
	g_cvNotice.GetString(notice, sizeof(notice));
	ConVar league = FindConVar("l4d_ready_league_notice");
	if (league != null && notice[0] != '\0') league.SetString(notice);
}

/**
 * Captain chat commands. Only live while the box is booked
 * (l4d_booking_password non-empty); a plain PUG or an idle pool box ignores
 * '!nextmap' etc. entirely, leaving them for whatever else might bind them.
 *
 * The chat line itself is never hidden (always Plugin_Continue): this is a
 * courtesy forward onto the site, not a command the game should swallow.
 */
public Action OnClientSayCommand(int client, const char[] command, const char[] sArgs)
{
	char pw[64];
	g_cvPassword.GetString(pw, sizeof(pw));
	if (pw[0] == '\0') return Plugin_Continue;

	char text[256];
	strcopy(text, sizeof(text), sArgs);
	StripQuotes(text);
	TrimString(text);
	if (text[0] != '!') return Plugin_Continue;

	char chatWord[16];
	int pos = BreakString(text, chatWord, sizeof(chatWord));

	if (strcmp(chatWord, "!allow", false) == 0)
	{
		char rest[256];
		if (pos == -1) rest[0] = '\0';
		else strcopy(rest, sizeof(rest), text[pos]);
		ChatAllow(client, rest);
		return Plugin_Continue;
	}

	int idx = -1;
	for (int i = 0; i < sizeof(g_sChatWords); i++)
	{
		if (strcmp(chatWord, g_sChatWords[i], false) == 0) { idx = i; break; }
	}
	if (idx == -1) return Plugin_Continue;

	if (client < 1 || client > MaxClients || !IsClientInGame(client) || IsFakeClient(client)) return Plugin_Continue;
	char id[32];
	if (!GetClientAuthId(client, AuthId_SteamID64, id, sizeof(id))) return Plugin_Continue;

	if (!IsCaptain(id))
	{
		PrintToChat(client, "[Booking] Only a captain can do that.");
		return Plugin_Continue;
	}

	char rawArg[256];
	if (pos == -1) rawArg[0] = '\0';
	else strcopy(rawArg, sizeof(rawArg), text[pos]);

	EmitBookingCmd(id, g_sCmdWords[idx], rawArg);
	// Without the log secret the site drops the line as unsigned: say so
	// rather than claim it arrived.
	if (HasLogSecret()) PrintToChat(client, "[Booking] Sent to the site.");
	else PrintToChat(client, "[Booking] The site cannot hear this server right now; use the booking page.");
	return Plugin_Continue;
}

/** sm_booking_cmd <steamid64> <cmd> [arg...]: the same PUGBOOK line, no
 *  captain check. For testing (sm_booking_cmd on the console) and staff. */
public Action Cmd_BookingCmd(int args)
{
	char full[256];
	GetCmdArgString(full, sizeof(full));

	char id[32];
	int pos = BreakString(full, id, sizeof(id));
	if (pos == -1)
	{
		PrintToServer("usage: sm_booking_cmd <steamid64> <cmd> [arg...]");
		return Plugin_Handled;
	}
	if (!IsSteamId64(id))
	{
		PrintToServer("usage: sm_booking_cmd <steamid64> <cmd> [arg...] - steamid64 is 17 digits");
		return Plugin_Handled;
	}

	char cmdWord[16];
	int pos2 = BreakString(full[pos], cmdWord, sizeof(cmdWord));

	int idx = -1;
	for (int i = 0; i < sizeof(g_sCmdWords); i++)
	{
		if (strcmp(cmdWord, g_sCmdWords[i], false) == 0) { idx = i; break; }
	}
	if (idx == -1)
	{
		PrintToServer("usage: sm_booking_cmd <steamid64> <cmd> [arg...] - cmd is nextmap, stay, end or extend");
		return Plugin_Handled;
	}

	char rawArg[256];
	if (pos2 == -1) rawArg[0] = '\0';
	else strcopy(rawArg, sizeof(rawArg), full[pos + pos2]);

	EmitBookingCmd(id, g_sCmdWords[idx], rawArg);
	PrintToServer("PUGOK booking cmd=%s steamid=%s", g_sCmdWords[idx], id);
	return Plugin_Handled;
}

/** Whether the site has pushed this box its log secret (sm_pug_log_secret,
 *  from pug-logauth.inc): without it a PUGBOOK line is never accepted. */
bool HasLogSecret()
{
	ConVar cv = FindConVar("sm_pug_log_secret");
	if (cv == null) return false;
	char secret[8];
	cv.GetString(secret, sizeof(secret));
	return secret[0] != '\0';
}

/** A SteamID64 is always exactly 17 decimal digits. Catches a typo or a
 *  Steam2/Steam3 id typed into sm_booking_cmd by accident before it ever
 *  reaches PugLog or IsCaptain's comma-wrapped match. */
bool IsSteamId64(const char[] id)
{
	if (strlen(id) != 17) return false;
	for (int i = 0; i < 17; i++)
	{
		if (id[i] < '0' || id[i] > '9') return false;
	}
	return true;
}

/** Exact comma-separated membership: both sides wrapped in commas so a
 *  substring of one id can never match a different, longer id. */
bool IsCaptain(const char[] id64)
{
	char list[256];
	g_cvCaptains.GetString(list, sizeof(list));
	if (list[0] == '\0') return false;

	char wrapped[258];
	Format(wrapped, sizeof(wrapped), ",%s,", list);
	char needle[34];
	Format(needle, sizeof(needle), ",%s,", id64);
	return StrContains(wrapped, needle) != -1;
}

void EmitBookingCmd(const char[] id64, const char[] cmdWord, const char[] rawArg)
{
	char arg[BOOKING_ARG_MAX];
	SanitizeBookingArg(rawArg, arg, sizeof(arg));
	PugLog("PUGBOOK event=cmd cmd=%s steamid=%s arg=%s", cmdWord, id64, arg);
}

/** `"`, `;` and line breaks are stripped (they could otherwise forge a field
 *  boundary or a second log line on the site's parser); everything else in
 *  the free text is kept as typed. Capped at maxlen - 1 (BOOKING_ARG_MAX - 1
 *  = 64) characters. Empty is fine; the caller still emits arg=. */
void SanitizeBookingArg(const char[] raw, char[] out, int maxlen)
{
	char trimmed[256];
	strcopy(trimmed, sizeof(trimmed), raw);
	TrimString(trimmed);

	int w = 0;
	for (int i = 0; trimmed[i] != '\0' && w < maxlen - 1; i++)
	{
		char c = trimmed[i];
		if (c == '"' || c == ';' || c == '\n' || c == '\r') continue;
		out[w++] = c;
	}
	out[w] = '\0';
}

// ---------- allowlist (1.2.0) ----------

/** Enforcement is live only on a booked box with a committed list. */
bool Enforcing()
{
	if (!g_bListLoaded) return false;
	char pw[64];
	g_cvPassword.GetString(pw, sizeof(pw));
	return pw[0] != '\0';
}

bool IsAllowed(const char[] id64)
{
	bool v;
	return g_hAllowed.GetValue(id64, v);
}

public Action Cmd_AllowBegin(int args)
{
	delete g_hStaged;
	g_hStaged = new StringMap();
	PrintToServer("PUGOK booking allow begin");
	return Plugin_Handled;
}

public Action Cmd_AllowAdd(int args)
{
	if (g_hStaged == null)
	{
		PrintToServer("PUGERR booking allow add without begin");
		return Plugin_Handled;
	}
	int added = 0, skipped = 0;
	char id[32];
	for (int i = 1; i <= args; i++)
	{
		GetCmdArg(i, id, sizeof(id));
		if (!IsSteamId64(id)) { skipped++; continue; }
		g_hStaged.SetValue(id, true);
		added++;
	}
	PrintToServer("PUGOK booking allow add added=%d skipped=%d", added, skipped);
	return Plugin_Handled;
}

public Action Cmd_AllowCommit(int args)
{
	if (g_hStaged == null)
	{
		PrintToServer("PUGERR booking allow commit without begin");
		return Plugin_Handled;
	}
	delete g_hAllowed;
	g_hAllowed = g_hStaged;
	g_hStaged = null;
	g_bListLoaded = true;

	// Someone now on the list is neither blocked nor waiting.
	int lifted = DropListed(g_hBlocked);
	DropListed(g_hGrace);
	PrintToServer("PUGOK booking allow commit ids=%d lifted=%d", g_hAllowed.Size, lifted);
	return Plugin_Handled;
}

/** Removes every key of `map` that is on the active list; returns how many. */
int DropListed(StringMap map)
{
	StringMapSnapshot snap = map.Snapshot();
	int dropped = 0;
	char id[32];
	for (int i = 0; i < snap.Length; i++)
	{
		snap.GetKey(i, id, sizeof(id));
		if (IsAllowed(id)) { map.Remove(id); dropped++; }
	}
	delete snap;
	return dropped;
}

/** Counts and times only, never the ids. */
public Action Cmd_BookingStatus(int args)
{
	char pw[64];
	g_cvPassword.GetString(pw, sizeof(pw));
	PrintToServer("PUGOK booking status booked=%d loaded=%d ids=%d staged=%d graces=%d blocks=%d",
		pw[0] != '\0', g_bListLoaded, g_hAllowed.Size, g_hStaged == null ? -1 : g_hStaged.Size, g_hGrace.Size, g_hBlocked.Size);

	int now = GetTime();
	char id[32], name[MAX_NAME_LENGTH];
	int until;
	StringMapSnapshot snap = g_hGrace.Snapshot();
	for (int i = 0; i < snap.Length; i++)
	{
		snap.GetKey(i, id, sizeof(id));
		g_hGrace.GetValue(id, until);
		int client = FindClientById(id);
		if (client > 0) GetClientName(client, name, sizeof(name));
		else strcopy(name, sizeof(name), "(not connected)");
		PrintToServer("grace: %s %ds left", name, until - now);
	}
	delete snap;
	snap = g_hBlocked.Snapshot();
	for (int i = 0; i < snap.Length; i++)
	{
		snap.GetKey(i, id, sizeof(id));
		g_hBlocked.GetValue(id, until);
		PrintToServer("block: %ds left", until - now);
	}
	delete snap;
	return Plugin_Handled;
}

/** Never held to the list: bots, SourceTV, replay and SourceMod admins. */
bool IsExempt(int client)
{
	return IsFakeClient(client) || IsClientSourceTV(client) || IsClientReplay(client) || GetUserAdmin(client) != INVALID_ADMIN_ID;
}

/** sm_booking_allow_refuse <steamid64>: the site refused a captain's !allow
 *  that ChatAllow had already let through. Off the active list again, and if
 *  they are still here (and not exempt) their grace starts over, with the
 *  notices of a fresh connect, rather than an outright kick. */
public Action Cmd_AllowRefuse(int args)
{
	char id[32];
	GetCmdArg(1, id, sizeof(id));
	if (args != 1 || !IsSteamId64(id))
	{
		PrintToServer("usage: sm_booking_allow_refuse <steamid64> - steamid64 is 17 digits");
		return Plugin_Handled;
	}
	g_hAllowed.Remove(id);
	g_hGrace.Remove(id);
	int client = FindClientById(id);
	bool restarted = false;
	if (client > 0 && IsClientInGame(client) && !IsExempt(client) && Enforcing())
	{
		StartGrace(client, id);
		restarted = true;
	}
	PrintToServer("PUGOK booking allow refuse grace=%d", restarted);
	return Plugin_Handled;
}

/** Runs on every connect, map changes included (clients re-run admin checks
 *  on each map), which is why a grace already running is kept, not restarted. */
public void OnClientPostAdminCheck(int client)
{
	if (!Enforcing()) return;
	if (IsExempt(client)) return;

	char id[32];
	// No SteamID yet (Steam auth not back): deliberately let through, since
	// sv_password still keeps out anyone the booking did not give it to.
	if (!GetClientAuthId(client, AuthId_SteamID64, id, sizeof(id)) || !IsSteamId64(id)) return;
	if (IsAllowed(id)) return;

	int now = GetTime();
	int until;
	if (g_hBlocked.GetValue(id, until))
	{
		if (until > now)
		{
			KickClient(client, "This server is booked. You were not let in a few minutes ago; ask a captain to add you on the site.");
			return;
		}
		g_hBlocked.Remove(id);
	}

	if (g_hGrace.GetValue(id, until))
	{
		// Back from a reconnect or a map change: the same grace runs on.
		PrintToChat(client, "[Booking] This server is booked. A captain has %d seconds to let you in.", until - now > 0 ? until - now : 0);
		return;
	}

	StartGrace(client, id);
}

/** A fresh grace for this player, told to every captain here and to them. */
void StartGrace(int client, const char[] id)
{
	int grace = g_cvGrace.IntValue;
	g_hGrace.SetValue(id, GetTime() + grace);
	char name[MAX_NAME_LENGTH];
	GetClientName(client, name, sizeof(name));
	for (int i = 1; i <= MaxClients; i++)
	{
		if (!IsClientInGame(i) || IsFakeClient(i)) continue;
		char cid[32];
		if (!GetClientAuthId(i, AuthId_SteamID64, cid, sizeof(cid)) || !IsCaptain(cid)) continue;
		PrintToChat(i, "[Booking] %s joined and is not on the booking. Type !allow %s within %d seconds to let them play as a ringer.", name, name, grace);
	}
	PrintToChat(client, "[Booking] This server is booked. A captain has %d seconds to let you in.", grace);
}

/** Once a second: an expired grace ends in a kick and a block. A grace whose
 *  owner has left still ends in a block, so leaving and rejoining after the
 *  window cannot buy a fresh one. */
public Action Timer_Graces(Handle timer)
{
	if (g_hGrace.Size == 0) return Plugin_Continue;
	if (!Enforcing())
	{
		g_hGrace.Clear();
		return Plugin_Continue;
	}
	int now = GetTime();
	int until;
	char id[32];
	StringMapSnapshot snap = g_hGrace.Snapshot();
	for (int i = 0; i < snap.Length; i++)
	{
		snap.GetKey(i, id, sizeof(id));
		if (!g_hGrace.GetValue(id, until) || until > now) continue;
		g_hGrace.Remove(id);
		if (IsAllowed(id)) continue;
		int minutes = g_cvBlock.IntValue;
		if (minutes > 0) g_hBlocked.SetValue(id, now + minutes * 60);
		int client = FindClientById(id);
		if (client > 0) KickClient(client, "This server is booked. Ask a captain to add you to the booking on the site.");
	}
	delete snap;
	return Plugin_Continue;
}

/** The connected human with this SteamID64, or 0. */
int FindClientById(const char[] id64)
{
	char id[32];
	for (int i = 1; i <= MaxClients; i++)
	{
		if (!IsClientConnected(i) || IsFakeClient(i)) continue;
		if (!GetClientAuthId(i, AuthId_SteamID64, id, sizeof(id))) continue;
		if (strcmp(id, id64) == 0) return i;
	}
	return 0;
}

/** !allow <name> from chat: one waiting player, matched case-insensitively
 *  by substring, is added to the active list at once and the site is told. */
void ChatAllow(int client, const char[] rawQuery)
{
	if (client < 1 || client > MaxClients || !IsClientInGame(client) || IsFakeClient(client)) return;
	char by[32];
	if (!GetClientAuthId(client, AuthId_SteamID64, by, sizeof(by))) return;
	if (!IsCaptain(by))
	{
		PrintToChat(client, "[Booking] Only a captain can do that.");
		return;
	}
	// The site would never hear of it, so it would never land on the
	// booking: add nobody and leave the grace running.
	if (!HasLogSecret())
	{
		PrintToChat(client, "[Booking] The site cannot hear this server right now; use the booking page.");
		return;
	}

	char query[MAX_NAME_LENGTH];
	strcopy(query, sizeof(query), rawQuery);
	TrimString(query);

	int match = 0, found = 0;
	char id[32], name[MAX_NAME_LENGTH];
	int until;
	if (query[0] != '\0')
	{
		for (int i = 1; i <= MaxClients; i++)
		{
			if (!IsClientConnected(i) || IsFakeClient(i)) continue;
			if (!GetClientAuthId(i, AuthId_SteamID64, id, sizeof(id)) || !g_hGrace.GetValue(id, until)) continue;
			GetClientName(i, name, sizeof(name));
			if (StrContains(name, query, false) == -1) continue;
			match = i;
			found++;
		}
	}
	if (found == 0)
	{
		PrintToChat(client, "[Booking] No one waiting matches that name.");
		return;
	}
	if (found > 1)
	{
		PrintToChat(client, "[Booking] More than one player matches; type more of the name.");
		return;
	}

	GetClientAuthId(match, AuthId_SteamID64, id, sizeof(id));
	GetClientName(match, name, sizeof(name));
	g_hAllowed.SetValue(id, true);
	g_hGrace.Remove(id);
	g_hBlocked.Remove(id);

	char arg[256];
	Format(arg, sizeof(arg), "%s %s", id, name);
	EmitBookingCmd(by, "allow", arg);
}
