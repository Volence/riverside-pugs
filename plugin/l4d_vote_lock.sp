#pragma semicolon 1
#pragma newdecls required

#include <sourcemod>

#define PLUGIN_VERSION "1.0"

/**
 * l4d_vote_lock - the config, map and score votes are admin only.
 *
 * comp_loader registers !load, !match, !mode, !changemap and !cm, and
 * l4dscores registers !setscores, all with RegConsoleCmd, so any player can
 * start them. In a ranked PUG a passed !load swaps the pinned ruleset mid
 * match, !changemap leaves the campaign pug-match is tracking, and !setscores
 * rewrites the scores pug-match reads for the result.
 *
 * admin_overrides.cfg cannot fix this. SourceMod only attaches admin info to
 * commands registered with RegAdminCmd, and ConCmdManager::UpdateAdminCmdFlags
 * skips every hook without it, so an override on a RegConsoleCmd command is
 * silently ignored. A command listener runs before the plugin's own callback
 * and can refuse it, for typed commands and chat triggers alike.
 *
 * Admin means the "l4d_vote_lock" override, ADMFLAG_GENERIC by default.
 * Website admins get root through the generated admins.cfg, so they pass.
 * The server console (client 0) always passes.
 */

static const char g_sLocked[][] =
{
	"sm_load", "sm_match", "sm_mode",   // comp_loader: config votes
	"sm_changemap", "sm_cm",            // comp_loader: campaign votes
	"sm_setscores",                     // l4dscores: campaign score vote
};

ConVar g_cvEnabled;

public Plugin myinfo =
{
	name = "Vote Lock",
	author = "Riverside",
	description = "Config, map and score votes are admin only",
	version = PLUGIN_VERSION,
	url = "https://riversidepug.com"
};

public void OnPluginStart()
{
	g_cvEnabled = CreateConVar("l4d_vote_lock", "1", "1 = only admins can use !load, !match, !mode, !changemap, !cm and !setscores.", FCVAR_NOTIFY, true, 0.0, true, 1.0);
	for (int i = 0; i < sizeof(g_sLocked); i++)
		AddCommandListener(OnLockedCommand, g_sLocked[i]);
}

public Action OnLockedCommand(int client, const char[] command, int argc)
{
	if (client == 0 || !g_cvEnabled.BoolValue)
		return Plugin_Continue;
	if (!IsClientInGame(client) || CheckCommandAccess(client, "l4d_vote_lock", ADMFLAG_GENERIC, true))
		return Plugin_Continue;

	char args[128];
	GetCmdArgString(args, sizeof(args));
	LogMessage("refused %s %s from %L", command, args, client);
	PrintToChat(client, "[PUG] Only admins can change the config, the campaign or the scores here.");
	return Plugin_Handled;
}
