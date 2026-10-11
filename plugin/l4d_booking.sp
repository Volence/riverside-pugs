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
 * 1.3.0: a booking is a number of campaigns, and +1 campaign replaces
 * Extend. A captain's !addcampaign [name] goes out as cmd=addcampaign with
 * the name as arg= (sanitized like every other arg), for the site to add one
 * campaign and, when named, append it to the playlist. !extend still emits
 * cmd=extend, which the site treats as !addcampaign with no name.
 *
 * 1.4.0 adds l4d_booking_id, the boot marker the site's crash recovery reads.
 *
 * 1.5.0 (site plan 2026-10-11, scrims in game): the site pushes the booking's
 * clock as cvars (l4d_booking_title, _campaign, _ends, _next_at, _next_name,
 * _close_at; epochs in seconds, 0 for none), and from them this plugin:
 * answers !time for anyone; counts down to the next campaign and to the close
 * after the last one, in the center of the screen each second of the last
 * minute and in chat at 60, 30 and 10 seconds; and re-tells each player the
 * booking's state once they are in game (5 s after the admin check, once on a
 * team), after every map load, since lines said during a load are never seen.
 * A captain's !sub <name> lets someone play for their side (cmd=sub, the
 * site adds a ringer); !allow now lets someone watch. On a tournament box
 * !sub belongs to pug-match's pug-tourney.inc and is left alone here. The
 * epoch cvars are read as strings: a ConVar keeps its number as a float,
 * which is up to 64 s off at today's epochs.
 * A list commit also starts the grace for anyone connected who is not on the
 * new list, so someone removed or replaced on the site mid chapter is not left
 * playing until the next map.
 *
 * Build: ./build-booking.sh
 */
#pragma semicolon 1
#pragma newdecls required
#include <sourcemod>
#include "pug-logauth.inc"

#define PLUGIN_VERSION "1.5.0"

/** Longest arg= text on a PUGBOOK line, plus the null terminator. Matches
 *  the site parser's cap (Task 6). */
#define BOOKING_ARG_MAX 65

ConVar g_cvPassword;
ConVar g_cvTvPassword;
ConVar g_cvNotice;
ConVar g_cvCaptains;
ConVar g_cvGrace;
ConVar g_cvBlock;
ConVar g_cvTitle;
ConVar g_cvCampaign;
ConVar g_cvEnds;
ConVar g_cvNextAt;
ConVar g_cvNextName;
ConVar g_cvCloseAt;

/** No countdown mark said yet for the current next_at / close_at. */
#define MARK_NONE 1000
/** Seconds after the admin check before a player is told the booking's state. */
#define TELL_DELAY 5.0
/** Chat marks of the countdowns, largest first. */
static const int g_iMarks[] = { 60, 30, 10 };
int g_iNextSaid = MARK_NONE;
int g_iCloseSaid = MARK_NONE;
/** GetEngineTime() from which a client is told the state; 0.0 = nothing pending. */
float g_fTellAt[MAXPLAYERS + 1];

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

/** The captain chat commands, chat form (leading '!', as typed) and the
 *  bare cmd= word the PUGBOOK line uses. Parallel arrays, same order.
 *  !extend (1.1.0) is kept as the old name of !addcampaign (1.3.0). */
static const char g_sChatWords[][] = { "!nextmap", "!stay", "!end", "!extend", "!addcampaign" };
static const char g_sCmdWords[][] = { "nextmap", "stay", "end", "extend", "addcampaign" };

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
	// Crash recovery (site plan 5): the booking id, written only by the
	// site's setup and recovery, never by its minute re-push. A fresh srcds
	// starts with it empty, which is how the site tells a restart.
	CreateConVar("l4d_booking_id", "", "The booking this box was set up for; empty after a server start.", FCVAR_DONTRECORD);
	// Scrims in game (1.5.0): the booking's clock, pushed by the site with
	// every booking burst. Epochs in whole seconds; 0 (or empty) for none.
	g_cvTitle = CreateConVar("l4d_booking_title", "", "The scrim's sides, \"A vs B\"; empty on a tournament box.", FCVAR_DONTRECORD);
	g_cvCampaign = CreateConVar("l4d_booking_campaign", "", "The name of the campaign on the box.", FCVAR_DONTRECORD);
	g_cvEnds = CreateConVar("l4d_booking_ends", "0", "Epoch seconds the booked slot ends; 0 when unknown.", FCVAR_DONTRECORD);
	g_cvNextAt = CreateConVar("l4d_booking_next_at", "0", "Epoch seconds the next campaign loads; 0 for none.", FCVAR_DONTRECORD);
	g_cvNextName = CreateConVar("l4d_booking_next_name", "", "The next campaign's name.", FCVAR_DONTRECORD);
	g_cvCloseAt = CreateConVar("l4d_booking_close_at", "0", "Epoch seconds the server closes after the last booked campaign; 0 for none.", FCVAR_DONTRECORD);
	g_cvNextAt.AddChangeHook(OnClockCvarChanged);
	g_cvCloseAt.AddChangeHook(OnClockCvarChanged);
	RegServerCmd("sm_booking_tell", Cmd_Tell, "sm_booking_tell - print the state a player is told on arrival, to the server console");
	RegServerCmd("sm_booking_time", Cmd_Time, "sm_booking_time - print the !time answer to the server console");
	CreateTimer(1.0, Timer_Clock, _, TIMER_REPEAT);
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

	if (strcmp(chatWord, "!time", false) == 0)
	{
		// Next frame, so the answer lands below the player's own !time line.
		if (client >= 1 && client <= MaxClients && IsClientInGame(client) && !IsFakeClient(client) && !TourneyBox())
			RequestFrame(Frame_TimeReply, GetClientUserId(client));
		return Plugin_Continue;
	}

	if (strcmp(chatWord, "!sub", false) == 0)
	{
		// A tournament box's !sub <out> <in> is pug-tourney.inc's.
		if (TourneyBox()) return Plugin_Continue;
		char rest[256];
		if (pos == -1) rest[0] = '\0';
		else strcopy(rest, sizeof(rest), text[pos]);
		CaptainLetIn(client, rest, "sub", false);
		return Plugin_Continue;
	}

	if (strcmp(chatWord, "!allow", false) == 0)
	{
		char rest[256];
		if (pos == -1) rest[0] = '\0';
		else strcopy(rest, sizeof(rest), text[pos]);
		CaptainLetIn(client, rest, "allow", true);
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
		PrintToServer("usage: sm_booking_cmd <steamid64> <cmd> [arg...] - cmd is nextmap, stay, end, extend or addcampaign");
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
	// 1.5.0: someone already here who is not on the new list (removed or
	// replaced on the site mid chapter) gets the grace a fresh connect gets,
	// rather than playing on until the next map. A grace already running is
	// kept, so the site's minute re-push restarts nobody's.
	int graced = 0;
	if (Enforcing())
	{
		char id[32];
		int until;
		for (int c = 1; c <= MaxClients; c++)
		{
			if (!IsClientInGame(c) || IsExempt(c)) continue;
			if (!GetClientAuthId(c, AuthId_SteamID64, id, sizeof(id)) || !IsSteamId64(id)) continue;
			if (IsAllowed(id) || g_hGrace.GetValue(id, until)) continue;
			StartGrace(c, id, true);
			graced++;
		}
	}
	PrintToServer("PUGOK booking allow commit ids=%d lifted=%d graced=%d", g_hAllowed.Size, lifted, graced);
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
 *  that CaptainLetIn had already let through. Off the active list again, and if
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

public void OnClientDisconnect(int client)
{
	g_fTellAt[client] = 0.0;
}

/** Runs on every connect, map changes included (clients re-run admin checks
 *  on each map), which is why a grace already running is kept, not restarted. */
public void OnClientPostAdminCheck(int client)
{
	// Scrims in game: told the booking's state once they are in (Timer_Clock),
	// on every connect and every map load.
	if (!IsFakeClient(client) && Booked()) g_fTellAt[client] = GetEngineTime() + TELL_DELAY;

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

/** A fresh grace for this player, told to every captain here and to them.
 *  removed: they were here already and a list commit no longer carries them. */
void StartGrace(int client, const char[] id, bool removed = false)
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
		PrintToChat(i, "[Booking] %s %s on the booking. Within %d seconds type !allow %s to let them watch, or !sub %s to let them play for your side.", name, removed ? "is no longer" : "joined and is not", grace, name, name);
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

/** A captain's !allow <name> (waitingOnly: one player in a grace, to watch)
 *  or !sub <name> (any connected human, to play for the captain's side; the
 *  site makes them a ringer and pug-match places them), matched
 *  case-insensitively by substring. The match is let onto the box at once
 *  and the site is told (cmd=allow or cmd=sub). Someone already on the list
 *  is left as they are: the site may refuse the !sub, and the refusal must
 *  not take a properly booked player off the list (the site sends no
 *  sm_booking_allow_refuse for them either). */
void CaptainLetIn(int client, const char[] rawQuery, const char[] cmdWord, bool waitingOnly)
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
			if (!IsClientConnected(i) || IsFakeClient(i) || IsClientSourceTV(i)) continue;
			if (!GetClientAuthId(i, AuthId_SteamID64, id, sizeof(id))) continue;
			if (waitingOnly && !g_hGrace.GetValue(id, until)) continue;
			GetClientName(i, name, sizeof(name));
			if (StrContains(name, query, false) == -1) continue;
			match = i;
			found++;
		}
	}
	if (found == 0)
	{
		PrintToChat(client, waitingOnly ? "[Booking] No one waiting matches that name." : "[Booking] No one here matches that name.");
		return;
	}
	if (found > 1)
	{
		PrintToChat(client, "[Booking] More than one player matches; type more of the name.");
		return;
	}

	GetClientAuthId(match, AuthId_SteamID64, id, sizeof(id));
	GetClientName(match, name, sizeof(name));
	if (!IsAllowed(id))
	{
		g_hAllowed.SetValue(id, true);
		g_hGrace.Remove(id);
		g_hBlocked.Remove(id);
	}

	char arg[256];
	Format(arg, sizeof(arg), "%s %s", id, name);
	EmitBookingCmd(by, cmdWord, arg);
	// !allow's answer is the site's own "can watch" line; !sub says it went.
	if (!waitingOnly) PrintToChat(client, "[Booking] Sent to the site.");
}

// ---------- scrims in game (1.5.0) ----------

/** The box is booked (the site set its password). */
bool Booked()
{
	char pw[64];
	g_cvPassword.GetString(pw, sizeof(pw));
	return pw[0] != '\0';
}

/** sm_pug_tournament 1 (pug-match): a tournament box, where the series engine speaks. */
bool TourneyBox()
{
	ConVar cv = FindConVar("sm_pug_tournament");
	return cv != null && cv.IntValue == 1;
}

/** An epoch cvar, read as text: GetInt goes through a float and loses up to 64 s. */
int CvarEpoch(ConVar cv)
{
	char s[16];
	cv.GetString(s, sizeof(s));
	return StringToInt(s);
}

/** Client 0 is the server console (the test commands). */
void Say(int client, const char[] text)
{
	if (client == 0) PrintToServer("%s", text);
	else PrintToChat(client, "%s", text);
}

/** Seconds as whole minutes, rounded up, as the site words it: "29 min", "1 h 52 min", "2 h". */
void LeftText(int seconds, char[] out, int maxlen)
{
	int mins = (seconds + 59) / 60;
	if (mins < 1) mins = 1;
	if (mins < 60) Format(out, maxlen, "%d min", mins);
	else if (mins % 60 == 0) Format(out, maxlen, "%d h", mins / 60);
	else Format(out, maxlen, "%d h %d min", mins / 60, mins % 60);
}

/** The next load or the close, when one is pending. */
bool PendingLine(char[] out, int maxlen)
{
	int now = GetTime();
	int next = CvarEpoch(g_cvNextAt);
	if (next > now)
	{
		char name[64];
		g_cvNextName.GetString(name, sizeof(name));
		Format(out, maxlen, "[Booking] Next: %s in %d s.", name, next - now);
		return true;
	}
	int close = CvarEpoch(g_cvCloseAt);
	if (close > now)
	{
		char left[32];
		LeftText(close - now, left, sizeof(left));
		Format(out, maxlen, "[Booking] Every booked campaign is played. The server closes in %s unless a captain types !addcampaign.", left);
		return true;
	}
	return false;
}

/** !time: the slot's end in UTC, then anything pending. */
void TimeReply(int client)
{
	int ends = CvarEpoch(g_cvEnds);
	if (ends <= 0)
	{
		Say(client, "[Booking] This server has not been told when the booked slot ends.");
		return;
	}
	int now = GetTime();
	int day = ends % 86400;
	char line[192];
	if (ends > now)
	{
		char left[32];
		LeftText(ends - now, left, sizeof(left));
		Format(line, sizeof(line), "[Booking] %s left in the booked slot (ends %02d:%02d UTC).", left, day / 3600, (day % 3600) / 60);
	}
	else
	{
		Format(line, sizeof(line), "[Booking] The booked slot ended at %02d:%02d UTC. A game in progress is finished, then the server closes.", day / 3600, (day % 3600) / 60);
	}
	Say(client, line);
	if (PendingLine(line, sizeof(line))) Say(client, line);
}

public void Frame_TimeReply(int userid)
{
	int client = GetClientOfUserId(userid);
	if (client > 0 && IsClientInGame(client)) TimeReply(client);
}

/** What a player is told once they are in: who plays, the campaign, the time
 *  left, anything pending, and the commands. Nothing on a tournament box. */
void TellState(int client)
{
	char title[128];
	g_cvTitle.GetString(title, sizeof(title));
	if (title[0] == '\0') return;
	char campaign[64], line[256];
	g_cvCampaign.GetString(campaign, sizeof(campaign));
	Format(line, sizeof(line), "[Booking] Scrim: %s", title);
	if (campaign[0] != '\0') Format(line, sizeof(line), "%s | %s", line, campaign);
	int ends = CvarEpoch(g_cvEnds), now = GetTime();
	if (ends > now)
	{
		char left[32];
		LeftText(ends - now, left, sizeof(left));
		Format(line, sizeof(line), "%s | %s left", line, left);
	}
	else if (ends > 0) Format(line, sizeof(line), "%s | the booked slot is over", line);
	Say(client, line);
	if (PendingLine(line, sizeof(line))) Say(client, line);
	Say(client, "[Booking] Type !time for the time left. Captains: !nextmap !stay !end !addcampaign !allow !sub");
}

public void OnClockCvarChanged(ConVar cv, const char[] oldValue, const char[] newValue)
{
	// A new time is a new countdown; the same value re-pushed every minute changes nothing.
	if (cv == g_cvNextAt) g_iNextSaid = MARK_NONE;
	else g_iCloseSaid = MARK_NONE;
}

/** One second of a countdown: center text through the last minute, a chat
 *  line at each mark (the smallest one crossed, once). The site's own line
 *  when it scheduled the load said "in 60 seconds", so a countdown first seen
 *  above 50 s starts with that mark already said. Also to the server console,
 *  for testing. */
void Countdown(int left, int &said, const char[] name, bool closing)
{
	if (left <= 0 || left > g_iMarks[0]) return;
	if (said == MARK_NONE && !closing && left > 50) said = g_iMarks[0];
	if (closing) PrintCenterTextAll("Server closes in %d s (!addcampaign for one more)", left);
	else PrintCenterTextAll("Next campaign: %s in %d s", name, left);
	int mark = 0;
	for (int i = 0; i < sizeof(g_iMarks); i++)
	{
		if (left <= g_iMarks[i] && said > g_iMarks[i]) mark = g_iMarks[i];
	}
	if (mark == 0) return;
	said = mark;
	char line[192];
	if (closing) Format(line, sizeof(line), "[Booking] The server closes in %d s. A captain can type !addcampaign to play one more.", left);
	else Format(line, sizeof(line), "[Booking] Next: %s in %d s. Captains: !nextmap to pick another, !stay to replay, !end to finish.", name, left);
	PrintToChatAll("%s", line);
	PrintToServer("%s", line);
}

/** Once a second: the arrival tells due, then the two countdowns. */
public Action Timer_Clock(Handle timer)
{
	if (!Booked() || TourneyBox()) return Plugin_Continue;
	float eng = GetEngineTime();
	for (int c = 1; c <= MaxClients; c++)
	{
		if (g_fTellAt[c] == 0.0 || eng < g_fTellAt[c]) continue;
		if (!IsClientInGame(c) || IsFakeClient(c)) { g_fTellAt[c] = 0.0; continue; }
		if (GetClientTeam(c) == 0) continue; // on no team yet: still loading in
		g_fTellAt[c] = 0.0;
		TellState(c);
	}
	int now = GetTime();
	int next = CvarEpoch(g_cvNextAt);
	if (next > 0)
	{
		char name[64];
		g_cvNextName.GetString(name, sizeof(name));
		Countdown(next - now, g_iNextSaid, name, false);
	}
	int close = CvarEpoch(g_cvCloseAt);
	if (close > 0 && next <= now) Countdown(close - now, g_iCloseSaid, "", true);
	return Plugin_Continue;
}

public Action Cmd_Tell(int args)
{
	TellState(0);
	return Plugin_Handled;
}

public Action Cmd_Time(int args)
{
	TimeReply(0);
	return Plugin_Handled;
}
