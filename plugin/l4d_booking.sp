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
 * Plan 4b grows this plugin (allowlist, captain commands).
 *
 * Build: ./build-booking.sh
 */
#pragma semicolon 1
#pragma newdecls required
#include <sourcemod>

#define PLUGIN_VERSION "1.0.0"

ConVar g_cvPassword;
ConVar g_cvTvPassword;
ConVar g_cvNotice;

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
	g_cvPassword.AddChangeHook(OnBookingCvarChanged);
	g_cvTvPassword.AddChangeHook(OnBookingCvarChanged);
	g_cvNotice.AddChangeHook(OnBookingCvarChanged);
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
