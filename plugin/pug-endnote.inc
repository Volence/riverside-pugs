// ---------- End-of-match notes and !rq ----------
//
// Two owner asks from 2026-10-20, both about the eight seconds between a
// match ending and the end kick (END_KICK_DELAY):
//
// sm_pug_endnote <token> <steamid64> <text>
//   The site rates the match within a second or two of MATCH_END and sends
//   each player their own line: SR change, rank when it moved, placement
//   progress, whether !rq put them back in the queue (src/endNotes.ts). It
//   goes to that player's chat at once and replaces the shared result in
//   THEIR disconnect dialog. Nobody else sees it, so no one's rank is read
//   out to the lobby. Sent before sm_pug_abort, while the token is still
//   good; refused in any state but MS_Ended.
//
// !rq / !requeue (and !rq off)
//   Queue again when this match ends, without going back to the site or
//   Discord. The plugin only says so to the site in a signed PUGRQ line; the
//   site keeps the list, checks the player is on this match, and does the
//   requeue at completion (src/matchRequeue.ts). A self-started match or a
//   series box (no end kick) has no queue to go back to, so it is refused
//   here. Idempotent rather than a toggle, so the site's own toggle and this
//   command can never disagree about which way a press flips it.

#define ENDNOTE_MAX 128

/** SteamID64 -> this player's note, for the match that just ended. */
StringMap g_smEndNote;

/** The site turns !rq on per match (orchestrator setupMatch). Off by
 *  default: the feature launches with Season 1, and until the site says so
 *  !rq does nothing at all, not even a reply. */
ConVar g_cvRequeue;

void EndNote_Init()
{
	g_smEndNote = new StringMap();
	g_cvRequeue = CreateConVar("sm_pug_requeue", "0", "1 = !rq works (the site sets this per match once Season 1 is live).", FCVAR_DONTRECORD, true, 0.0, true, 1.0);
	RegServerCmd("sm_pug_endnote", Cmd_EndNote, "sm_pug_endnote <token> <steamid64> <text> - one player's own end-of-match line");
	RegConsoleCmd("sm_rq", Cmd_Requeue, "Queue again when this match ends. !rq off cancels.");
	RegConsoleCmd("sm_requeue", Cmd_Requeue, "Queue again when this match ends. !rq off cancels.");
}

/** Forget every note. From CancelEndKick (a new match) and once the end kick
 *  has emptied the box. */
void EndNote_Clear()
{
	if (g_smEndNote != null) g_smEndNote.Clear();
}

public Action Cmd_EndNote(int args)
{
	if (!TokenArgOk(args)) return Plugin_Handled;
	if (g_State != MS_Ended || args < 3)
	{
		PrintToServer("PUGERR endnote needs an ended match and <token> <steamid64> <text>");
		return Plugin_Handled;
	}
	char id[32], text[ENDNOTE_MAX];
	GetCmdArg(2, id, sizeof(id));
	GetCmdArg(3, text, sizeof(text));
	TrimString(text);
	if (text[0] == '\0' || RosterIndexOfId(id) < 0)
	{
		PrintToServer("PUGERR endnote for a player not on the roster");
		return Plugin_Handled;
	}
	g_smEndNote.SetString(id, text);
	int client = EndNote_ClientOf(id);
	if (client > 0) PrintToChat(client, "\x04[PUG]\x01 Your result: \x05%s", text);
	PrintToServer("PUGOK endnote");
	return Plugin_Handled;
}

int EndNote_ClientOf(const char[] steamid64)
{
	char id[32];
	for (int c = 1; c <= MaxClients; c++)
	{
		if (!IsClientInGame(c) || IsFakeClient(c)) continue;
		if (GetClientAuthId(c, AuthId_SteamID64, id, sizeof(id)) && StrEqual(id, steamid64)) return c;
	}
	return 0;
}

/** The end kick, with each player's own note after the shared result. */
void EndNote_KickHumans(const char[] reason)
{
	char id[32], note[ENDNOTE_MAX], line[320];
	for (int c = 1; c <= MaxClients; c++)
	{
		if (!IsClientInGame(c) || !IsEndKickTarget(c)) continue;
		if (GetClientAuthId(c, AuthId_SteamID64, id, sizeof(id)) && g_smEndNote.GetString(id, note, sizeof(note)))
		{
			Format(line, sizeof(line), "%s. %s", reason, note);
			KickClient(c, "%s", line);
		}
		else
		{
			KickClient(c, "%s", reason);
		}
	}
}

public Action Cmd_Requeue(int client, int args)
{
	if (client < 1 || client > MaxClients || !IsClientInGame(client) || IsFakeClient(client))
	{
		ReplyToCommand(client, "[PUG] !rq is for players in game.");
		return Plugin_Handled;
	}
	if (!g_cvRequeue.BoolValue) return Plugin_Handled;
	if ((g_State != MS_Live && g_State != MS_Ended) || g_iMatchId <= 0 || g_bSelfStarted || !g_cvEndKick.BoolValue)
	{
		PrintToChat(client, "\x04[PUG]\x01 !rq works during a queue match: it puts you back in the queue when the match ends.");
		return Plugin_Handled;
	}
	char id[32];
	if (!GetClientAuthId(client, AuthId_SteamID64, id, sizeof(id)) || RosterIndexOfId(id) < 0)
	{
		PrintToChat(client, "\x04[PUG]\x01 Only players on this match can use !rq.");
		return Plugin_Handled;
	}
	char arg[16];
	if (args >= 1) GetCmdArg(1, arg, sizeof(arg));
	bool on = !(StrEqual(arg, "off", false) || StrEqual(arg, "cancel", false) || StrEqual(arg, "no", false));
	PugLog("PUGRQ steamid=%s match=%d on=%d", id, g_iMatchId, on ? 1 : 0);
	if (on) PrintToChat(client, "\x04[PUG]\x01 You will be put back in the queue when this match ends. \x05!rq off\x01 cancels.");
	else PrintToChat(client, "\x04[PUG]\x01 Cancelled: you will not be requeued when this match ends.");
	return Plugin_Handled;
}
