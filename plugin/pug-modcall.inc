// ---------- /mod: call a moderator from in game ----------
//
// Spec: docs/superpowers/specs/2026-09-24-mod-call-design.md, Part 1
// ("Player experience" and "The log line").
//
// A player types /mod (or /calladmin, or the ! forms), picks a reason and who
// it is about from two menus, optionally types details, and the plugin writes
// one signed PUGCALL line. The web side (src/logParse.ts) turns that into a
// card in the mod channel. The plugin knows only SteamIDs; names and Discord
// ids are resolved on the web.
//
// WHY THE ! FORMS ARE CAUGHT IN OnClientSayCommand. SourceMod runs sm_mod for
// "!mod" too, but it lets the chat line through first, so the report text
// would be shown to everyone and logged by the conduct logger as PUGSAY.
// Returning Plugin_Stop from the say forward drops the line before either
// happens. The / forms are already silent through SourceMod's own triggers.
//
// WHY THE 0.5 s GUARD. Whether SourceMod still runs sm_mod for a "!mod" that
// the forward stopped is not something the API documents. If it does, the
// flow would open twice; the second open inside MODCALL_REOPEN_GUARD is
// dropped.
//
// Nothing is sent unless the player gets all the way through: a menu cancel
// or a disconnect mid-flow clears the pending call. The detail wait ending on
// its own (30 s) is not a cancel; the call goes out without details.

#define MODCALL_COOLDOWN 180          // seconds between two sent calls from one SteamID
#define MODCALL_DETAILS_WAIT 30.0     // seconds the next chat line is taken as details
#define MODCALL_REOPEN_GUARD 0.5      // seconds a second open of the flow is ignored

/** SteamID64 to GetTime() of that player's last SENT call. Keyed by SteamID,
 *  not by client, so leaving and rejoining does not reset it. */
StringMap g_smCooldown;

bool g_bAwaitDetails[MAXPLAYERS + 1];            // the next say is this client's details
Handle g_hDetailsTimer[MAXPLAYERS + 1];          // the 30 s detail wait, while it runs
float g_fLastOpen[MAXPLAYERS + 1];               // engine time the flow was last opened
Menu g_hCallMenu[MAXPLAYERS + 1];                // the menu of the flow in progress, if one is up
char g_sCallReason[MAXPLAYERS + 1][16];          // reason key, set by the reason menu
char g_sCallTarget[MAXPLAYERS + 1][24];          // SteamID64, team, general or none
char g_sCallDetails[MAXPLAYERS + 1][CHAT_MAX_BYTES + 1];
bool g_bCallHasDetails[MAXPLAYERS + 1];          // details were typed with the command

void ModCall_Init()
{
	g_smCooldown = new StringMap();
	RegConsoleCmd("sm_mod", Cmd_Mod, "Call a moderator. Only mods see it.");
	RegConsoleCmd("sm_calladmin", Cmd_Mod, "Call a moderator. Only mods see it.");
}

/** Forget any call in progress. Sends nothing. The menu itself is left to
 *  SourceMod: it is cancelled on disconnect, and a stale one that is still
 *  shown no longer matches g_hCallMenu, so picking from it does nothing. */
void ModCall_Clear(int client)
{
	g_bAwaitDetails[client] = false;
	if (g_hDetailsTimer[client] != null)
	{
		delete g_hDetailsTimer[client];
	}
	g_hCallMenu[client] = null;
	g_sCallReason[client][0] = '\0';
	g_sCallTarget[client][0] = '\0';
	g_sCallDetails[client][0] = '\0';
	g_bCallHasDetails[client] = false;
}

void ModCall_OnDisconnect(int client)
{
	ModCall_Clear(client);
	g_fLastOpen[client] = 0.0;
}

/** Belt and braces: OnClientDisconnect already runs for every client across a
 *  changelevel, so this should find nothing to clear. */
void ModCall_OnMapStart()
{
	for (int c = 1; c <= MaxClients; c++)
	{
		ModCall_OnDisconnect(c);
	}
}

public Action Cmd_Mod(int client, int args)
{
	if (client < 1 || client > MaxClients || !IsClientInGame(client) || IsFakeClient(client))
	{
		ReplyToCommand(client, "[PUG] /mod is for players in game.");
		return Plugin_Handled;
	}
	char details[256];
	GetCmdArgString(details, sizeof(details));
	ModCall_Open(client, details);
	return Plugin_Handled;
}

public Action OnClientSayCommand(int client, const char[] command, const char[] sArgs)
{
	if (client < 1 || client > MaxClients || !IsClientInGame(client) || IsFakeClient(client))
		return Plugin_Continue;

	char text[256];
	strcopy(text, sizeof(text), sArgs);
	StripQuotes(text);
	TrimString(text);

	if (g_bAwaitDetails[client])
	{
		if (StrEqual(text, "/skip", false) || StrEqual(text, "!skip", false))
		{
			ModCall_Send(client, "");
		}
		else
		{
			ModCall_Send(client, text);
		}
		return Plugin_Stop;
	}

	int rest = ModCall_TriggerEnd(text, "!mod");
	if (rest < 0) rest = ModCall_TriggerEnd(text, "!calladmin");
	if (rest < 0) return Plugin_Continue;

	ModCall_Open(client, text[rest]);
	return Plugin_Stop;
}

/** Where the details start if `text` is `trigger` (any case) on its own or
 *  followed by a space, else -1. "!moderator" is not "!mod". */
int ModCall_TriggerEnd(const char[] text, const char[] trigger)
{
	int n = strlen(trigger);
	if (strncmp(text, trigger, n, false) != 0) return -1;
	if (text[n] == '\0') return n;
	if (text[n] == ' ') return n + 1;
	return -1;
}

void ModCall_Open(int client, const char[] upfront)
{
	float now = GetEngineTime();
	if (g_fLastOpen[client] > 0.0 && now - g_fLastOpen[client] < MODCALL_REOPEN_GUARD) return;
	g_fLastOpen[client] = now;

	char id[24];
	if (!GetClientAuthId(client, AuthId_SteamID64, id, sizeof(id)))
	{
		PrintToChat(client, "[PUG] Your Steam ID is not verified yet, try again in a moment.");
		return;
	}
	int last;
	if (g_smCooldown.GetValue(id, last))
	{
		int left = MODCALL_COOLDOWN - (GetTime() - last);
		if (left > 0)
		{
			PrintToChat(client, "[PUG] You can call a mod again in %d:%02d.", left / 60, left % 60);
			return;
		}
	}

	// A flow already in progress (a menu up, or waiting for details) is
	// abandoned, unsent, in favour of this one.
	ModCall_Clear(client);

	Menu menu = new Menu(MenuHandler_ModCallReason);
	menu.SetTitle("Call a mod: why?");
	menu.AddItem("cheating", "Cheating");
	menu.AddItem("toxicity", "Toxic / team fighting");
	menu.AddItem("griefing", "Griefing / throwing");
	menu.AddItem("afk", "AFK / no comms");
	menu.AddItem("english", "Not speaking English");
	menu.AddItem("broke", "Something broke (stuck tank, bug, lag)");
	menu.AddItem("other", "Other");

	PrintToChat(client, "[PUG] Safety concern? Report it on the website instead, it is handled privately.");
	// Current before Display: showing it interrupts any older menu, and that
	// menu's cancel must see it is no longer the current one.
	g_hCallMenu[client] = menu;
	menu.Display(client, MENU_TIME_FOREVER);

	// Stored only now so the interrupt above cannot have wiped it.
	char details[256];
	strcopy(details, sizeof(details), upfront);
	TrimString(details);
	if (details[0] != '\0')
	{
		strcopy(g_sCallDetails[client], sizeof(g_sCallDetails[]), details);
		g_bCallHasDetails[client] = true;
	}
}

/** Shared by both menus: a cancel of the CURRENT menu drops the call, and a
 *  menu that has ended is freed. Returns true when the action was handled. */
bool ModCall_MenuHousekeeping(Menu menu, MenuAction action, int param1)
{
	if (action == MenuAction_End)
	{
		delete menu;
		return true;
	}
	if (action == MenuAction_Cancel)
	{
		if (param1 >= 1 && param1 <= MaxClients && g_hCallMenu[param1] == menu)
		{
			ModCall_Clear(param1);
		}
		return true;
	}
	return false;
}

public int MenuHandler_ModCallReason(Menu menu, MenuAction action, int client, int item)
{
	if (ModCall_MenuHousekeeping(menu, action, client)) return 0;
	if (action != MenuAction_Select || g_hCallMenu[client] != menu) return 0;

	menu.GetItem(item, g_sCallReason[client], sizeof(g_sCallReason[]));
	if (StrEqual(g_sCallReason[client], "broke"))
	{
		strcopy(g_sCallTarget[client], sizeof(g_sCallTarget[]), "none");
		ModCall_AfterMenus(client);
		return 0;
	}

	Menu who = new Menu(MenuHandler_ModCallWho);
	who.SetTitle("Who is it about?");
	char id[24];
	char name[MAX_NAME_LENGTH];
	char label[MAX_NAME_LENGTH + 8];
	for (int c = 1; c <= MaxClients; c++)
	{
		if (c == client || !IsClientInGame(c) || IsFakeClient(c) || IsClientSourceTV(c)) continue;
		// The id is taken now, so the call names the player who was in that
		// slot when the menu was drawn even if they leave before the pick.
		if (!GetClientAuthId(c, AuthId_SteamID64, id, sizeof(id))) continue;
		GetClientName(c, name, sizeof(name));
		int team = GetClientTeam(c);
		Format(label, sizeof(label), "%s %s",
			team == TEAM_SURVIVOR ? "[S]" : (team == TEAM_INFECTED ? "[I]" : "[Spec]"), name);
		who.AddItem(id, label);
	}
	who.AddItem("team", "My team");
	who.AddItem("general", "General (the whole server)");
	g_hCallMenu[client] = who;
	who.Display(client, MENU_TIME_FOREVER);
	return 0;
}

public int MenuHandler_ModCallWho(Menu menu, MenuAction action, int client, int item)
{
	if (ModCall_MenuHousekeeping(menu, action, client)) return 0;
	if (action != MenuAction_Select || g_hCallMenu[client] != menu) return 0;

	menu.GetItem(item, g_sCallTarget[client], sizeof(g_sCallTarget[]));
	ModCall_AfterMenus(client);
	return 0;
}

/** Both menus are done: send now if details came with the command, else wait
 *  for the next chat line. */
void ModCall_AfterMenus(int client)
{
	g_hCallMenu[client] = null;
	if (g_bCallHasDetails[client])
	{
		char details[CHAT_MAX_BYTES + 1];
		strcopy(details, sizeof(details), g_sCallDetails[client]);
		ModCall_Send(client, details);
		return;
	}
	g_bAwaitDetails[client] = true;
	PrintToChat(client, "[PUG] Type details in chat now, only mods see it (30 s), or /skip.");
	g_hDetailsTimer[client] = CreateTimer(MODCALL_DETAILS_WAIT, Timer_ModCallDetails, GetClientUserId(client));
}

public Action Timer_ModCallDetails(Handle timer, int userid)
{
	int client = GetClientOfUserId(userid);
	if (client < 1 || g_hDetailsTimer[client] != timer) return Plugin_Stop;
	// Ours, and ending: forget the handle so ModCall_Send's clear does not
	// delete the timer from inside its own callback.
	g_hDetailsTimer[client] = null;
	if (g_bAwaitDetails[client]) ModCall_Send(client, "");
	return Plugin_Stop;
}

void ModCall_Send(int client, const char[] rawDetails)
{
	char caller[24];
	if (g_sCallReason[client][0] == '\0' || g_sCallTarget[client][0] == '\0'
		|| !GetClientAuthId(client, AuthId_SteamID64, caller, sizeof(caller)))
	{
		ModCall_Clear(client);
		return;
	}
	char details[256];
	strcopy(details, sizeof(details), rawDetails);
	SanitizeChat(details, sizeof(details));

	char line[512];
	Format(line, sizeof(line), "PUGCALL steamid=%s target=%s tteam=%d reason=%s match=%d ord=%d half=%d tms=%d via=game text=%s",
		caller, g_sCallTarget[client], GetClientTeam(client), g_sCallReason[client],
		g_iMatchId, g_iRplMapSeq, g_iHalf, RoundMs(), details);
	PugLog("%s", line);
	LogMessage("[modcall] %s", line);

	g_smCooldown.SetValue(caller, GetTime());
	ModCall_Clear(client);
	PrintToChat(client, "[PUG] Mods have been called. Thanks.");
}
