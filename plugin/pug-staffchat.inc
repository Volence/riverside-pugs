// ---------- staff chat: the site talking into the game, and /staff back ----------
//
// Spec: docs/superpowers/specs/2026-09-28-staff-server-chat-design.md.
//
// sm_pug_staffsay is sent over rcon by the site (src/staffChatSend.ts) and
// prints a staff message to everyone, one team, or one player. It answers
// with a signed PUGSTAFFSENT line saying how many players it reached, so the
// page can say "delivered to 4" or "not on the server".
//
// /staff <message> is a player's private line to staff. The say is dropped
// (OnClientSayCommand in pug-modcall.inc calls StaffChat_OnSay first), so
// nobody in game sees it, and it goes out as a signed PUGSTAFF line.

#define STAFFCHAT_COOLDOWN 5.0
// Played to each player a staff message reaches. L4D1 chat has only white,
// green and orange, and every plugin already uses all three, so a staff line
// cannot stand out by colour; the beep is what makes it noticed (owner's
// pick after an in-game test, 2026-09-28). Stock game sound, nothing to ship.
#define STAFFCHAT_SOUND "ui/beepclear.wav"

// g_fStaffLast and g_bSayTeam are declared in pug-match.sp, ahead of
// EmitConductSay and of pug-modcall.inc's OnClientSayCommand: see the comment
// there.

void StaffChat_Init()
{
	RegServerCmd("sm_pug_staffsay", Cmd_StaffSay, "sm_pug_staffsay <all|survivors|infected|spectators|steamid64> \"<name>\" \"<message>\" <send id>");
	RegConsoleCmd("sm_staff", Cmd_Staff, "Message the staff privately. Only staff see it.");
}

void StaffChat_OnMapStart()
{
	PrecacheSound(STAFFCHAT_SOUND, true);
}

void StaffChat_OnDisconnect(int client)
{
	g_fStaffLast[client] = 0.0;
	g_bSayTeam[client] = false;
}

public Action Cmd_StaffSay(int args)
{
	if (args < 4)
	{
		PrintToServer("usage: sm_pug_staffsay <to> \"<name>\" \"<message>\" <send id>");
		return Plugin_Handled;
	}
	char to[24], name[64], message[256], idArg[16];
	GetCmdArg(1, to, sizeof(to));
	GetCmdArg(2, name, sizeof(name));
	GetCmdArg(3, message, sizeof(message));
	GetCmdArg(4, idArg, sizeof(idArg));
	int sendId = StringToInt(idArg);

	int team = 0;       // 0 = everyone
	bool whisper = false;
	if (StrEqual(to, "survivors")) team = 2;
	else if (StrEqual(to, "infected")) team = 3;
	else if (StrEqual(to, "spectators")) team = 1;
	else if (!StrEqual(to, "all")) whisper = true;

	char label[32];
	if (whisper) strcopy(label, sizeof(label), "Staff → you");
	else if (team == 2) strcopy(label, sizeof(label), "Staff → Survivors");
	else if (team == 3) strcopy(label, sizeof(label), "Staff → Infected");
	else if (team == 1) strcopy(label, sizeof(label), "Staff → Spectators");
	else strcopy(label, sizeof(label), "Staff");

	int delivered = 0;
	char id[24];
	for (int c = 1; c <= MaxClients; c++)
	{
		if (!IsClientInGame(c) || IsFakeClient(c)) continue;
		if (whisper)
		{
			if (!ModCall_AuthId(c, id, sizeof(id)) || !StrEqual(id, to)) continue;
		}
		else if (team != 0 && GetClientTeam(c) != team)
		{
			continue;
		}
		PrintToChat(c, "\x04[%s]\x01 %s: %s", label, name, message);
		if (whisper) PrintToChat(c, "\x05Reply privately with /staff <message>");
		EmitSoundToClient(c, STAFFCHAT_SOUND);
		delivered++;
	}
	PugLog("PUGSTAFFSENT id=%d delivered=%d", sendId, delivered);
	PrintToServer("staffsay delivered=%d", delivered);
	return Plugin_Handled;
}

public Action Cmd_Staff(int client, int args)
{
	if (client < 1 || client > MaxClients || !IsClientInGame(client) || IsFakeClient(client))
	{
		ReplyToCommand(client, "[PUG] /staff is for players in game.");
		return Plugin_Handled;
	}
	char text[256];
	GetCmdArgString(text, sizeof(text));
	StaffChat_Send(client, text);
	return Plugin_Handled;
}

/** True when the say was a !staff and has been handled (the caller drops it).
 *  g_bSayTeam is set by the caller (OnClientSayCommand in pug-modcall.inc),
 *  not here, because that assignment must happen even when a /mod detail
 *  line is pending and this function is never called. */
bool StaffChat_OnSay(int client, const char[] text)
{
	int rest = ModCall_TriggerEnd(text, "!staff");
	if (rest < 0) return false;
	StaffChat_Send(client, text[rest]);
	return true;
}

void StaffChat_Send(int client, const char[] raw)
{
	char text[256];
	strcopy(text, sizeof(text), raw);
	StripQuotes(text);
	TrimString(text);
	SanitizeChat(text, sizeof(text));
	if (text[0] == '\0')
	{
		PrintToChat(client, "[PUG] Usage: /staff <message>. Only staff see it.");
		return;
	}
	float now = GetEngineTime();
	if (g_fStaffLast[client] > 0.0 && now - g_fStaffLast[client] < STAFFCHAT_COOLDOWN)
	{
		PrintToChat(client, "[PUG] Wait a few seconds before your next /staff message.");
		return;
	}
	char id[24];
	if (!ModCall_AuthId(client, id, sizeof(id)))
	{
		PrintToChat(client, "[PUG] Your Steam ID is not verified yet, try again in a moment.");
		return;
	}
	g_fStaffLast[client] = now;
	PugLog("PUGSTAFF steamid=%s team=%d msg=%s", id, GetClientTeam(client), text);
	PrintToChat(client, "[PUG] Sent to staff.");
}
