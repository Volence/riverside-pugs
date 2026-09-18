#pragma semicolon 1
#pragma newdecls required

#include <sourcemod>
#include <sdktools>
#include <l4d_consistency>

#define PLUGIN_VERSION "0.1.0"

/**
 * Phase 1 of the file-consistency probe: force ONE file, and find out whether
 * the L4D1 client actually enforces it.
 *
 * The whole question this plugin exists to answer is binary. L4D1's engine has
 * sv_consistency, CDownloadListGenerator::ForceExactFile and the client-side
 * CClientState::ConsistencyCheck, but bin/server.so never asks for a single file
 * to be checked, so out of the box the enforced list is empty and the feature
 * looks dead. The extension supplies the missing call. What nobody knows is
 * whether the CLIENT honours it and disconnects on a mismatch.
 *
 * Deliberately one file, chosen by a cvar rather than a list in a config. A list
 * would let a failure hide: with forty paths forced and no disconnect, you
 * cannot tell whether the client ignored consistency or whether one path was
 * wrong. One path, changed by cvar, answers one question at a time, and lets the
 * same build test a model, a material and a sound without a recompile.
 *
 * Nothing here bans, kicks or reports. The engine either disconnects the client
 * or it does not.
 */

ConVar g_cvEnabled;
ConVar g_cvFile;

public Plugin myinfo =
{
	name = "L4D1 File Consistency (probe)",
	author = "Riverside",
	description = "Forces one file for consistency checking, to find out whether L4D1 clients enforce it",
	version = PLUGIN_VERSION,
	url = "https://riversidepug.com",
};

public void OnPluginStart()
{
	CreateConVar("l4d_consistency_version", PLUGIN_VERSION, "L4D1 file consistency version",
		FCVAR_NOTIFY | FCVAR_DONTRECORD);

	// Two independent off switches on purpose, this one and sv_consistency.
	// The failure mode of this feature is disconnecting legitimate players, and
	// the recovery path must not require a plugin reload, a rebuild, or anyone
	// who knows C++.
	g_cvEnabled = CreateConVar("l4d_consistency_enabled", "1",
		"Force the configured file for consistency checking on map start.", FCVAR_NOTIFY, true, 0.0, true, 1.0);

	g_cvFile = CreateConVar("l4d_consistency_file", "models/infected/hunter.mdl",
		"The single file to force. Change it to test a material or a sound.", FCVAR_NOTIFY);

	RegAdminCmd("sm_consistency_status", Cmd_Status, ADMFLAG_ROOT,
		"Report what this plugin forced on the current map.");
	RegAdminCmd("sm_consistency_force", Cmd_Force, ADMFLAG_ROOT,
		"Force one path right now, without waiting for a map change.");
}

static char g_sLastForced[PLATFORM_MAX_PATH];
static bool g_bForcedThisMap;

public void OnMapStart()
{
	g_bForcedThisMap = false;
	g_sLastForced[0] = '\0';

	if (!g_cvEnabled.BoolValue) {
		LogMessage("[consistency] disabled by l4d_consistency_enabled, forcing nothing");
		return;
	}

	char path[PLATFORM_MAX_PATH];
	g_cvFile.GetString(path, sizeof(path));
	if (path[0] == '\0') {
		LogError("[consistency] l4d_consistency_file is empty, forcing nothing");
		return;
	}

	// Existence is checked HERE, against the game's own file system, rather than
	// in the extension. The engine's search paths cover VPKs, the dlc
	// directories and addons, so a plain filesystem test in C++ would reject
	// paths that are perfectly valid to the engine.
	if (!FileExists(path, true)) {
		LogError("[consistency] '%s' is not in the game's file system. Forcing it anyway, but a path the engine cannot resolve is the most likely reason a probe sees nothing happen.", path);
	}

	// After precache, which OnMapStart is. The interface's own comment requires
	// it, and a path forced before precache may be silently ignored.
	int ok = ForceExactFile(path);
	if (ok == 1) {
		g_bForcedThisMap = true;
		strcopy(g_sLastForced, sizeof(g_sLastForced), path);
		// Logged loudly and with a count, because "it forced nothing" and "it
		// forced the file and the client did not care" are very different
		// problems and the probe has to tell them apart.
		LogMessage("[consistency] forced 1 file for consistency checking: %s", path);
		LogMessage("[consistency] sv_consistency is %s", GetConVarBool(FindConVar("sv_consistency")) ? "ON" : "OFF -- the engine will not enforce this");
	} else {
		LogError("[consistency] ForceExactFile refused '%s'", path);
	}
}

public Action Cmd_Status(int client, int args)
{
	ConVar svc = FindConVar("sv_consistency");
	ReplyToCommand(client, "[consistency] enabled: %s", g_cvEnabled.BoolValue ? "yes" : "no");
	ReplyToCommand(client, "[consistency] sv_consistency: %s", (svc != null && svc.BoolValue) ? "1" : "0");
	if (g_bForcedThisMap) {
		ReplyToCommand(client, "[consistency] forced this map: %s", g_sLastForced);
	} else {
		ReplyToCommand(client, "[consistency] forced this map: nothing");
	}
	return Plugin_Handled;
}

public Action Cmd_Force(int client, int args)
{
	if (args < 1) {
		ReplyToCommand(client, "Usage: sm_consistency_force <path>");
		return Plugin_Handled;
	}
	char path[PLATFORM_MAX_PATH];
	GetCmdArg(1, path, sizeof(path));
	int ok = ForceExactFile(path);
	ReplyToCommand(client, "[consistency] ForceExactFile(\"%s\") returned %d%s", path, ok,
		FileExists(path, true) ? "" : " (note: not found in the game file system)");
	return Plugin_Handled;
}
