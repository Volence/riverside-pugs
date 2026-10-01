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
 * Build: ./build-booking.sh
 */
#pragma semicolon 1
#pragma newdecls required
#include <sourcemod>
#include "pug-logauth.inc"

#define PLUGIN_VERSION "1.1.1"

/** Longest arg= text on a PUGBOOK line, plus the null terminator. Matches
 *  the site parser's cap (Task 6). */
#define BOOKING_ARG_MAX 65

ConVar g_cvPassword;
ConVar g_cvTvPassword;
ConVar g_cvNotice;
ConVar g_cvCaptains;

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
	CreateConVar("l4d_booking_version", PLUGIN_VERSION, "L4D1 Booked Server version", FCVAR_NOTIFY | FCVAR_DONTRECORD);
	g_cvPassword = CreateConVar("l4d_booking_password", "", "The booking's sv_password; empty when the box is not booked.", FCVAR_PROTECTED | FCVAR_DONTRECORD);
	g_cvTvPassword = CreateConVar("l4d_booking_tv_password", "", "The booking's SourceTV password.", FCVAR_PROTECTED | FCVAR_DONTRECORD);
	g_cvNotice = CreateConVar("l4d_booking_notice", "", "Ready-up panel line for the booking.", FCVAR_DONTRECORD);
	g_cvCaptains = CreateConVar("l4d_booking_captains", "", "Comma-separated SteamID64s of this booking's captains.", FCVAR_DONTRECORD);
	g_cvPassword.AddChangeHook(OnBookingCvarChanged);
	g_cvTvPassword.AddChangeHook(OnBookingCvarChanged);
	g_cvNotice.AddChangeHook(OnBookingCvarChanged);

	PugLogAuth_Init();
	RegServerCmd("sm_booking_cmd", Cmd_BookingCmd, "sm_booking_cmd <steamid64> <cmd> [arg...] - emit a PUGBOOK line without the captain check, for testing and staff");
}

public void OnConfigsExecuted()
{
	Apply();
}

public void OnBookingCvarChanged(ConVar cv, const char[] oldValue, const char[] newValue)
{
	Apply();
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
