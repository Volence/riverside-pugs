// ---------- pause limits: a ceiling per pause, a budget per campaign ----------
//
// Rotoblin's pause module has exactly two knobs, on/off and a delay, and
// neither of them limits anything. A pause ends when both teams type !ready,
// so a team that simply never readies holds the game frozen for as long as it
// likes, and nothing counts how often a team has done it.
//
// Two rules, from the ranked rules rather than from anything technical:
//
//   * a pause lasts at most `sm_pug_pause_seconds`, then the game resumes
//   * each team gets `sm_pug_pause_limit` pauses per campaign
//
// Disconnect pauses are outside both. Those come from pug-leave.inc, which
// already governs them with its own per-player reconnect allowance, and
// charging a team for a pause it did not ask for (or unfreezing the game
// while someone is still trying to reconnect) would be wrong twice over.
//
// WHY THE COUNTING IS NOT DONE IN THE COMMAND LISTENER. The obvious
// implementation charges a pause when `sm_pause` is seen. But Rotoblin is the
// one that decides whether a pause actually happens: it refuses during
// ready-up, when already paused, and when `rotoblin_pause` is off. Charging on
// intent would bill a team for pauses that never occurred, and the error is
// silent and cumulative. So the listener only ever REFUSES, and the counting
// is driven by an observed transition into pause. What gets charged is what
// actually happened.

/** Set for the moment it takes pug-leave.inc to issue its own `sm_pause`, so
 *  the listener lets it through unbudgeted and the transition that follows is
 *  attributed to nobody. */
bool g_bPauseInternal;

/** Called by pug-leave.inc immediately before it issues its own `sm_pause`.
 *  A function rather than the flag itself because that file is included first,
 *  and SourcePawn resolves a call to a later function but not a reference to a
 *  later global. */
void PauseAllowInternal()
{
	g_bPauseInternal = true;
}

#define PAUSE_BY_WINDOW 5.0      // seconds a !pause request may take to become a pause and still be credited

ConVar g_cvPauseSeconds;
ConVar g_cvPauseLimit;

// ---------- technical pauses (plan T5, tournament boxes only) ----------
//
// !tech <reason> (pug-tourney.inc) lets a pause through that this file then
// treats as technical, the same "charge what happened" way as a tactical
// pause: only once the game is seen paused. Technical time runs once a
// second while the team's technical pause holds and nobody is away and the
// staff freeze is off. Past the team's technical time the pause becomes one
// of its tactical pauses, then another as each ceiling runs out, and with
// none left the game unpauses (Rulings 5 and 6). A disconnect pause on a
// tournament box with team reconnect time is recorded as technical too, but
// its time is the team's reconnect time, which pug-leave.inc spends (Ruling 7).

#define TECH_CAUSE_CALL 1
#define TECH_CAUSE_DC   2

ConVar g_cvTechLimit;
ConVar g_cvTechSeconds;

int g_iTechCount[3];          // technical pauses each pug team declared this game
float g_fTechUsed[3];         // technical seconds each pug team spent this game
int g_iTechOwner;             // pug team whose technical clock runs now; 0 = none
int g_iTechOpen;              // pug team of the TECH record open now (kept through an overrun); 0 = none
int g_iTechCause;             // TECH_CAUSE_CALL or TECH_CAUSE_DC of the open record
int g_iTechId;                // the open record's id=: the unix second it began
bool g_bTechFlagged;          // the other team flagged the open record
int g_iTechWarned;            // last technical-time warning announced, in seconds left
char g_sTechBy[24];           // who declared it, or who disconnected
char g_sTechReason[160];
int g_iTechPendingTeam;       // a !tech let through that has not been seen to pause yet
float g_fTechPendingAt;
char g_sTechPendingBy[24];
char g_sTechPendingReason[160];
bool g_bPauseConverted;       // technical time ran out: this pause is the owner's tactical pause(s) now

int g_iPauseUsed[3];          // [1] pug team a, [2] pug team b
int g_iPausePendingTeam;      // team whose sm_pause we allowed and have not yet seen take effect
int g_iPauseOwner;            // team charged for the pause in progress; 0 = none or not chargeable
char g_sPausePendingBy[24];   // SteamID64 of the rostered player whose sm_pause we let through
float g_fPausePendingAt;      // engine time g_sPausePendingBy was taken
char g_sPauseBy[24];          // who called the pause in progress; empty = unknown, a disconnect or an admin
bool g_bPauseSeen;            // whether the game was paused on the previous tick
float g_fPauseStarted;        // engine time the current pause began
float g_fPauseHeld;           // seconds the ceiling clock has been held while a player is absent
int g_iPauseWarned;           // last warning threshold announced, in seconds remaining
char g_sPhaseLast[320];       // last PHASE fields sent, so a line goes out on change only (see the phase section)

void PauseInit()
{
	g_cvPauseSeconds = CreateConVar("sm_pug_pause_seconds", "120",
		"A pause is force-unpaused after this many seconds. 0 disables the ceiling.",
		FCVAR_NOTIFY, true, 0.0, true, 1800.0);
	g_cvPauseLimit = CreateConVar("sm_pug_pause_limit", "3",
		"Pauses each team may call per campaign. Disconnect pauses do not count. 0 disables the budget.",
		FCVAR_NOTIFY, true, 0.0, true, 20.0);
	g_cvTechLimit = CreateConVar("sm_pug_tech_limit", "0",
		"Tournament box: technical pauses (!tech <reason>) each team may call per game. 0 turns !tech off.",
		FCVAR_NOTIFY, true, 0.0, true, 10.0);
	g_cvTechSeconds = CreateConVar("sm_pug_tech_seconds", "300",
		"Tournament box: technical time each team has per game, in seconds. Past it the pause uses the team's tactical pauses.",
		FCVAR_NOTIFY, true, 0.0, true, 3600.0);

	// Rotoblin registers sm_pause with RegConsoleCmd, so a listener here runs
	// before its callback and can refuse the pause without forking it.
	AddCommandListener(Listener_PugPause, "sm_pause");

	// No TIMER_FLAG_NO_MAPCHANGE: PauseInit runs once, at plugin start, so a
	// timer killed by the first changelevel never came back and neither the
	// budget nor the ceiling was enforced from map 2 onward. The phase tracker
	// below rides on this clock too and has to run on every map.
	CreateTimer(1.0, Timer_PauseClock, _, TIMER_REPEAT);
}

/** A new campaign. Called from the same match reset as LeaveReset, which is
 *  what makes the budget per campaign rather than per map: a map change does
 *  not come through here. */
void PauseReset()
{
	g_iPauseUsed[1] = 0;
	g_iPauseUsed[2] = 0;
	g_iPausePendingTeam = 0;
	g_iPauseOwner = 0;
	g_sPausePendingBy[0] = '\0';
	g_sPauseBy[0] = '\0';
	g_bPauseSeen = false;
	g_fPauseStarted = 0.0;
	g_fPauseHeld = 0.0;
	g_iPauseWarned = 0;
	for (int t = 0; t < 3; t++)
	{
		g_iTechCount[t] = 0;
		g_fTechUsed[t] = 0.0;
	}
	g_iTechOwner = 0;
	g_iTechOpen = 0;
	g_iTechCause = 0;
	g_iTechId = 0;
	g_bTechFlagged = false;
	g_iTechWarned = 0;
	g_sTechBy[0] = '\0';
	g_sTechReason[0] = '\0';
	g_iTechPendingTeam = 0;
	g_bPauseConverted = false;
	g_sPhaseLast[0] = '\0';
}

int PauseLimit()
{
	return g_cvPauseLimit.IntValue;
}

int PauseRemaining(int team)
{
	if (team != 1 && team != 2) return 0;
	int left = PauseLimit() - g_iPauseUsed[team];
	return left < 0 ? 0 : left;
}

static void PauseTeamName(int team, char[] out, int len)
{
	strcopy(out, len, team == 1 ? "Team A" : "Team B");
}

int Tech_Left(int team)
{
	if (team != 1 && team != 2) return 0;
	int left = g_cvTechSeconds.IntValue - RoundToFloor(g_fTechUsed[team]);
	return left < 0 ? 0 : left;
}

/** One signed TECH line for the open record. tactical -2 = leave the key out. */
void Tech_Emit(const char[] ev, int team, const char[] by, int used, int budget, int tactical, const char[] text)
{
	char tac[24];
	if (tactical == -2) tac[0] = '\0';
	else Format(tac, sizeof(tac), " tactical=%d", tactical);
	EmitPug("TECH event=%s id=%d team=%s cause=%s by=%s used=%d budget=%d%s text=%s",
		ev, g_iTechId, team == 1 ? "a" : "b", g_iTechCause == TECH_CAUSE_DC ? "disconnect" : "call",
		by[0] != '\0' ? by : "none", used, budget, tac, text);
}

/** A !tech pug-tourney.inc let through became this pause: within the retry
 *  gap (Rotoblin's pause delay plus a margin), on a tournament box, and not
 *  a disconnect or freeze pause. A stale request is dropped. */
static bool Tech_PendingLanded()
{
	if (g_iTechPendingTeam == 0) return false;
	bool landed = TourneyOn() && !g_bLeavePaused && !TourneyFrozen() && GetEngineTime() - g_fTechPendingAt <= Tourney_RetryGap();
	if (!landed) g_iTechPendingTeam = 0;
	return landed;
}

static void Tech_Begin()
{
	int team = g_iTechPendingTeam;
	g_iTechPendingTeam = 0;
	g_iTechOwner = team;
	g_iTechOpen = team;
	g_iTechCause = TECH_CAUSE_CALL;
	g_iTechId = GetTime();
	g_iTechCount[team]++;
	g_bTechFlagged = false;
	g_iTechWarned = 0;
	strcopy(g_sTechBy, sizeof(g_sTechBy), g_sTechPendingBy);
	strcopy(g_sTechReason, sizeof(g_sTechReason), g_sTechPendingReason);
	char name[16];
	PauseTeamName(team, name, sizeof(name));
	int left = Tech_Left(team);
	PrintToChatAll("\x04[Match]\x01 %s technical pause: \x05%s\x01 (%d:%02d of technical time left; the other team can !flag it for staff).",
		name, g_sTechReason, left / 60, left % 60);
	Tech_Emit("start", team, g_sTechBy, RoundToFloor(g_fTechUsed[team]), g_cvTechSeconds.IntValue, -2, g_sTechReason);
}

/** The leave module's disconnect pause on a tournament box with team
 *  reconnect time: a technical record of the dropped player's team whose
 *  clock is the reconnect pool (Ruling 7). */
static void Tech_BeginDisconnect()
{
	if (!LeaveTeamMode()) return;
	int slot = LeaveFirstAbsent();
	if (slot < 0) return;
	int team = g_iRosterTeam[slot];
	if (team != 1 && team != 2) return;
	g_iTechOwner = 0;
	g_iTechOpen = team;
	g_iTechCause = TECH_CAUSE_DC;
	g_iTechId = GetTime();
	g_bTechFlagged = false;
	strcopy(g_sTechBy, sizeof(g_sTechBy), g_sRosterId[slot]);
	strcopy(g_sTechReason, sizeof(g_sTechReason), "disconnected");
	Tech_Emit("start", team, g_sTechBy, LeaveTeamUsed(team), g_cvDcTeamSeconds.IntValue, -2, g_sTechReason);
}

/** The game unpaused: the open record ends. */
static void Tech_End()
{
	if (g_iTechOpen == 0) return;
	int team = g_iTechOpen;
	bool dc = g_iTechCause == TECH_CAUSE_DC;
	Tech_Emit("end", team, g_sTechBy, dc ? LeaveTeamUsed(team) : RoundToFloor(g_fTechUsed[team]),
		dc ? g_cvDcTeamSeconds.IntValue : g_cvTechSeconds.IntValue, -2, "");
	g_iTechOpen = 0;
	g_iTechOwner = 0;
	g_iTechCause = 0;
	g_bTechFlagged = false;
	g_sTechBy[0] = '\0';
	g_sTechReason[0] = '\0';
}

/** Set while Tech_OwnerReady forces the unpause: LeaveUnpauseNow issues
 *  sm_ready from a client of each side, which comes back through the ready
 *  listener and must not be taken for the owner readying again. */
bool g_bTechForcing;

/** Fix round 1 ruling: the team that called a technical pause owns its end.
 *  `team` (a pug team) readied while its technical pause still runs (not a
 *  disconnect record, not yet converted to tactical): both sides are readied
 *  the way Tech_Overrun's out-of-pauses branch does, so the other team cannot
 *  hold the game and drain the caller's technical and tactical time. True when
 *  it forced the unpause. The clock keeps running until the game is seen
 *  unpaused, so a countdown that is cancelled leaves the pause on its budget. */
bool Tech_OwnerReady(int team)
{
	if (g_bTechForcing || !TourneyOn() || TourneyFrozen()) return false;
	if (g_iTechOwner == 0 || g_iTechOwner != team || g_bPauseConverted) return false;
	if (!LeaveRotoblinPaused()) return false;
	char name[16];
	PauseTeamName(team, name, sizeof(name));
	PrintToChatAll("\x04[Match]\x01 %s called the technical pause and is ready, so play resumes.", name);
	g_bTechForcing = true;
	LeaveUnpauseNow();
	g_bTechForcing = false;
	return true;
}

/** Once a second while a !tech pause holds (Ruling 6). */
static void Tech_Tick()
{
	if (LeaveAnyAbsent() || TourneyFrozen()) return;
	int team = g_iTechOwner;
	g_fTechUsed[team] += 1.0;
	int left = Tech_Left(team);
	if (left <= 0)
	{
		Tech_Overrun();
		return;
	}
	int threshold = left <= 10 ? 10 : left <= 30 ? 30 : left <= 60 ? 60 : 0;
	if (threshold != 0 && g_iTechWarned != threshold)
	{
		g_iTechWarned = threshold;
		char name[16];
		PauseTeamName(team, name, sizeof(name));
		PrintToChatAll("\x04[Match]\x01 %s has \x05%d seconds\x01 of technical time left. Past it the pause uses a tactical pause.", name, left);
	}
}

/** Technical time ran out: charge a tactical pause and run its ceiling, or
 *  unpause when the team has none left (Ruling 6). */
static void Tech_Overrun()
{
	int team = g_iTechOwner;
	g_iTechOwner = 0;
	char name[16];
	PauseTeamName(team, name, sizeof(name));
	int used = RoundToFloor(g_fTechUsed[team]);
	if (PauseLimit() > 0 && PauseRemaining(team) <= 0)
	{
		PrintToChatAll("\x04[Match]\x01 %s is out of technical time and has no tactical pause left. Unpausing.", name);
		Tech_Emit("over", team, g_sTechBy, used, g_cvTechSeconds.IntValue, -1, "");
		LeaveUnpauseNow();
		return;
	}
	if (PauseLimit() > 0) g_iPauseUsed[team]++;
	g_iPauseOwner = team;
	g_bPauseConverted = true;
	g_fPauseStarted = GetEngineTime();
	g_fPauseHeld = 0.0;
	g_iPauseWarned = 0;
	int left = PauseLimit() > 0 ? PauseRemaining(team) : -1;
	if (left >= 0) PrintToChatAll("\x04[Match]\x01 %s is out of technical time: this pause now uses one of their tactical pauses (\x05%d\x01 left).", name, left);
	else PrintToChatAll("\x04[Match]\x01 %s is out of technical time: this pause is now a tactical pause.", name);
	// tactical=-1 also when the budget is off (unlimited tactical pauses).
	Tech_Emit("over", team, g_sTechBy, used, g_cvTechSeconds.IntValue, left, "");
	EmitPug("PAUSE team=%d used=%d limit=%d", team, g_iPauseUsed[team], PauseLimit());
}

/**
 * Refuse a pause a team has no budget left for. Never charges anything: see
 * the note at the top of this file.
 */
public Action Listener_PugPause(int client, const char[] command, int argc)
{
	// pug-leave.inc pausing for a disconnect. Unbudgeted, uncapped, and not
	// attributed to the client it borrowed to issue the command.
	if (g_bPauseInternal)
	{
		g_bPauseInternal = false;
		return Plugin_Continue;
	}

	// Outside a live match there is nothing to budget, and during ready-up
	// Rotoblin refuses anyway. Leave both to it.
	if (g_State != MS_Live || InReadyUp()) return Plugin_Continue;

	if (client <= 0 || client > MaxClients || !IsClientInGame(client)) return Plugin_Continue;
	int slot = g_iClientRoster[client];
	// Not on the roster: an admin or a spectator. Rotoblin has its own rules
	// about who may pause and this module does not add to them.
	if (slot < 0) return Plugin_Continue;
	int team = g_iRosterTeam[slot];
	if (team != 1 && team != 2) return Plugin_Continue;

	// Already paused. Rotoblin will tell them so, and no new pause begins, so
	// nothing should be charged or refused here.
	if (LeaveRotoblinPaused()) return Plugin_Continue;

	// Who asked, for the pause ledger. Taken before the budget check so it is
	// known with the budget off too; a refused pause below never begins, so
	// a stale value here is overwritten by the next request or cleared when a
	// pause starts.
	if (!GetClientAuthId(client, AuthId_SteamID64, g_sPausePendingBy, sizeof(g_sPausePendingBy)))
		g_sPausePendingBy[0] = '\0';
	g_fPausePendingAt = GetEngineTime();

	if (PauseLimit() <= 0) return Plugin_Continue;

	if (PauseRemaining(team) <= 0)
	{
		char name[16];
		PauseTeamName(team, name, sizeof(name));
		PrintToChatAll("\x04[PUG]\x01 %s has used all \x05%d\x01 pauses for this campaign. Ask an admin if something has actually gone wrong.",
			name, PauseLimit());
		EmitPug("PAUSE_REFUSED team=%d used=%d limit=%d", team, g_iPauseUsed[team], PauseLimit());
		// No pause is coming from this request, so nothing may be credited to
		// it: an admin's forcepause a moment later is not this player's.
		g_sPausePendingBy[0] = '\0';
		return Plugin_Handled;
	}

	// Allowed, not yet charged. The clock tick that sees the game actually
	// paused is what bills it.
	g_iPausePendingTeam = team;
	return Plugin_Continue;
}

/**
 * Watch for the game entering and leaving pause, charge the budget, and
 * enforce the ceiling.
 *
 * Polling rather than an event because Rotoblin raises none: the pause state
 * is only observable through its `IsInPause` native, which this plugin already
 * reads for the leaver logic.
 */
public Action Timer_PauseClock(Handle timer)
{
	PauseClockTick();
	// A staff freeze that did not land is tried again (pug-tourney.inc).
	Tourney_Tick();
	// Rides the same clock: finds pauses by game time standing still, so it
	// covers every kind of pause, not only the ones this file charges.
	DemoShiftTick();
	// After the bookkeeping on purpose: the tick that first sees the game
	// paused is the one that decides who owns the pause, and the PHASE line
	// that announces it has to carry that owner.
	PhaseTick();
	return Plugin_Continue;
}

static void PauseClockTick()
{
	bool paused = LeaveRotoblinPaused();

	if (paused && !g_bPauseSeen)
	{
		g_bPauseSeen = true;
		g_fPauseStarted = GetEngineTime();
		g_fPauseHeld = 0.0;
		g_iPauseWarned = 0;
		g_bPauseConverted = false;
		// Plan T5: a !tech pause is nobody's tactical pause; it has its own clock.
		bool tech = Tech_PendingLanded();
		// A pause the leave module caused is nobody's: not charged, and not
		// subject to the ceiling either, because the player it is waiting for
		// has a reconnect allowance that is allowed to outlast it.
		// A pause the staff freeze caused is nobody's either (plan T3c);
		// g_iPausePendingTeam may hold a stale request Rotoblin refused, which
		// must not be charged for it.
		g_iPauseOwner = (g_bLeavePaused || TourneyFrozen() || tech) ? 0 : g_iPausePendingTeam;
		g_iPausePendingTeam = 0;
		// Only a request from the last few seconds: one Rotoblin refused
		// without pausing must not be pinned on a later, unrelated pause.
		if (g_bLeavePaused || GetEngineTime() - g_fPausePendingAt > PAUSE_BY_WINDOW || TourneyFrozen() || tech) g_sPauseBy[0] = '\0';
		else strcopy(g_sPauseBy, sizeof(g_sPauseBy), g_sPausePendingBy);
		g_sPausePendingBy[0] = '\0';
		if (tech) Tech_Begin();
		else if (g_bLeavePaused) Tech_BeginDisconnect();
		if (g_iPauseOwner == 1 || g_iPauseOwner == 2)
		{
			g_iPauseUsed[g_iPauseOwner]++;
			char name[16];
			PauseTeamName(g_iPauseOwner, name, sizeof(name));
			int left = PauseRemaining(g_iPauseOwner);
			int ceiling = g_cvPauseSeconds.IntValue;
			if (ceiling > 0)
			{
				PrintToChatAll("\x04[PUG]\x01 %s pause \x05%d:%02d\x01 max. \x05%d\x01 pause%s left this campaign.",
					name, ceiling / 60, ceiling % 60, left, left == 1 ? "" : "s");
			}
			else
			{
				PrintToChatAll("\x04[PUG]\x01 %s pause. \x05%d\x01 pause%s left this campaign.",
					name, left, left == 1 ? "" : "s");
			}
			EmitPug("PAUSE team=%d used=%d limit=%d", g_iPauseOwner, g_iPauseUsed[g_iPauseOwner], PauseLimit());
		}
		return;
	}

	if (!paused)
	{
		if (g_bPauseSeen)
		{
			// Plan T5: the open technical record ends with the pause.
			Tech_End();
			g_bPauseSeen = false;
			g_iPauseOwner = 0;
			g_iPausePendingTeam = 0;
			g_sPauseBy[0] = '\0';
			g_bPauseConverted = false;
		}
		return;
	}

	// Plan T5: a technical pause spends its team's technical time instead of
	// running a ceiling.
	if (g_iTechOwner != 0)
	{
		Tech_Tick();
		return;
	}

	// Paused, and we have seen it before: run the ceiling.
	int ceiling = g_cvPauseSeconds.IntValue;
	if (ceiling <= 0 || g_iPauseOwner == 0) return;

	// The clock does not run while a rostered player is actually away. A
	// player pause that a disconnect lands in the middle of must not expire
	// under someone who is still loading back in.
	// Nor while the staff freeze holds a team's pause (plan T3c): the expiry
	// path would call LeaveUnpauseNow, which the freeze refuses, say
	// "Unpausing." and emit PAUSE_EXPIRED for nothing. The frozen seconds are
	// held like an absence, so the team's clock picks up where it was once the
	// freeze is lifted instead of expiring the moment it is.
	if (LeaveAnyAbsent() || TourneyFrozen())
	{
		g_fPauseHeld += 1.0;
		return;
	}

	int left = ceiling - RoundToFloor(GetEngineTime() - g_fPauseStarted - g_fPauseHeld);

	if (left <= 0)
	{
		char name[16];
		PauseTeamName(g_iPauseOwner, name, sizeof(name));
		// Plan T5 Ruling 6: technical time past its budget takes the team's
		// tactical pauses one at a time while it has any.
		if (g_bPauseConverted && PauseLimit() > 0 && PauseRemaining(g_iPauseOwner) > 0)
		{
			g_iPauseUsed[g_iPauseOwner]++;
			g_fPauseStarted = GetEngineTime();
			g_fPauseHeld = 0.0;
			g_iPauseWarned = 0;
			int more = PauseRemaining(g_iPauseOwner);
			PrintToChatAll("\x04[Match]\x01 %s's pause runs on into another tactical pause (\x05%d\x01 left).", name, more);
			EmitPug("PAUSE team=%d used=%d limit=%d", g_iPauseOwner, g_iPauseUsed[g_iPauseOwner], PauseLimit());
			return;
		}
		PrintToChatAll("\x04[PUG]\x01 %s's pause has run out. Unpausing.", name);
		EmitPug("PAUSE_EXPIRED team=%d seconds=%d", g_iPauseOwner, ceiling);
		// Plan T5: g_bPauseSeen is cleared below, so the unpause transition
		// will not end a converted pause's technical record: end it here.
		Tech_End();
		// The same both-teams-ready path a player unpause takes, so
		// Rotoblin's own countdown and its frozen-smoker-victim fix apply.
		LeaveUnpauseNow();
		g_bPauseSeen = false;
		g_iPauseOwner = 0;
		g_sPauseBy[0] = '\0';
		return;
	}

	// Plan T5: a converted pause whose ceiling rolls into another tactical
	// pause does not unpause there, so it must not say it will.
	bool rollsOn = g_bPauseConverted && PauseLimit() > 0 && PauseRemaining(g_iPauseOwner) > 0;
	// Announced once each, so nobody is surprised by the game unfreezing.
	for (int mark = 30; mark >= 10; mark -= 20)
	{
		if (left <= mark && g_iPauseWarned != mark && (g_iPauseWarned == 0 || g_iPauseWarned > mark))
		{
			g_iPauseWarned = mark;
			if (rollsOn) PrintToChatAll("\x04[Match]\x01 \x05%d\x01 seconds left of this tactical pause, then it uses another one. Type \x05!ready\x01 to go now.", mark);
			else PrintToChatAll("\x04[PUG]\x01 Unpausing in \x05%d\x01 seconds. Type \x05!ready\x01 to go now.", mark);
			break;
		}
	}
	return;
}

/** STATUS lines for sm_pug_status. */
void PauseStatus()
{
	PrintToServer("pause limit=%d seconds=%d used_a=%d used_b=%d",
		PauseLimit(), g_cvPauseSeconds.IntValue, g_iPauseUsed[1], g_iPauseUsed[2]);
	if (g_bPauseSeen)
	{
		PrintToServer("pause active owner=%d elapsed=%.0f held=%.0f",
			g_iPauseOwner, GetEngineTime() - g_fPauseStarted, g_fPauseHeld);
	}
	PrintToServer("tech limit=%d seconds=%d count_a=%d count_b=%d used_a=%d used_b=%d open=%d",
		g_cvTechLimit.IntValue, g_cvTechSeconds.IntValue, g_iTechCount[1], g_iTechCount[2],
		RoundToFloor(g_fTechUsed[1]), RoundToFloor(g_fTechUsed[2]), g_iTechOpen);
}

// ---------- phase: what the game is doing, for the live page ----------
//
// The live page draws frames, and there are none during a pause, a ready-up,
// a scoreboard or a map load: it sat on the last frame and read as frozen.
// This names the gap. One word, recomputed every second on the clock above,
// sent as a PHASE line on every change and repeated on every HEARTBEAT so a
// lost datagram is corrected within thirty seconds. Cosmetic on the wire, but
// the backend also builds its pause ledger from the paused transitions, which
// is what an admin reads when one team complains about the other's pausing.


/** Paused is checked first because Rotoblin's unpause flow raises the ready
 *  panel, so IsInReady is true during a pause as well. */
static void PhaseCurrent(char[] out, int len)
{
	if (LeaveRotoblinPaused()) { strcopy(out, len, "paused"); return; }
	if (InReadyUp()) { strcopy(out, len, "readyup"); return; }
	if (g_fRoundLiveAt > 0.0 && !g_bRoundEnded) { strcopy(out, len, "live"); return; }
	if (g_bRoundEnded) { strcopy(out, len, "roundover"); return; }
	// A new map before its ready-up has engaged: players still loading in.
	strcopy(out, len, "loading");
}

/** The phase fields under `key` (PHASE uses state=, HEARTBEAT uses phase=).
 *  A pause also says who is charged (1 = a, 2 = b, 0 = nobody: a disconnect
 *  pause or an admin), the ceiling in seconds (0 = none), whether the leave
 *  module called it, and, when known, the SteamID64 of who typed !pause. */
void PhaseFields(const char[] key, char[] out, int len)
{
	char state[16];
	PhaseCurrent(state, sizeof(state));
	if (StrEqual(state, "paused"))
	{
		Format(out, len, "%s=%s team=%d limit=%d leave=%d",
			key, state, g_iPauseOwner, g_cvPauseSeconds.IntValue, g_bLeavePaused ? 1 : 0);
		// The staff freeze (plan T3c), so the site's pause ledger and live page know.
		if (TourneyFrozen()) Format(out, len, "%s admin=1", out);
		// Who typed !pause, only when known: the backend never guesses one
		// from the team, so an absent field is the honest "unknown".
		if (g_sPauseBy[0] != '\0') Format(out, len, "%s by=%s", out, g_sPauseBy);
	}
	else if (StrEqual(state, "readyup"))
	{
		// Who everyone is waiting on: rostered, in game, not readied. The
		// backend charges the seconds between reports to these players and
		// remembers the last roster that named anyone as who readied last.
		char ids[MAX_ROSTER * 19];
		PhaseUnready(ids, sizeof(ids));
		Format(out, len, "%s=%s unready=%s", key, state, ids);
	}
	else
	{
		Format(out, len, "%s=%s", key, state);
	}
}

/** Comma-separated steamids of rostered, connected players who have not
 *  readied. Empty when readyup's per-player native is not there. */
static void PhaseUnready(char[] out, int len)
{
	out[0] = '\0';
	if (!g_bReadyUpAvailable) return;
	if (GetFeatureStatus(FeatureType_Native, "IsReady") != FeatureStatus_Available) return;
	for (int c = 1; c <= MaxClients; c++)
	{
		if (!IsClientInGame(c) || IsFakeClient(c)) continue;
		int slot = g_iClientRoster[c];
		if (slot < 0 || g_sRosterId[slot][0] == '\0') continue;
		// A subbed-out player (pug-tourney.inc) watches from spectators and is never waited on.
		if (Tourney_SlotOut(slot)) continue;
		if (IsReady(c)) continue;
		if (out[0] != '\0') StrCat(out, len, ",");
		StrCat(out, len, g_sRosterId[slot]);
	}
}

/** Once a second from Timer_PauseClock. Emits only when the fields change,
 *  which during a ready-up means every time someone readies. */
void PhaseTick()
{
	if (g_State == MS_None)
	{
		g_sPhaseLast[0] = '\0';
		return;
	}
	char fields[320];
	PhaseFields("state", fields, sizeof(fields));
	if (StrEqual(fields, g_sPhaseLast)) return;
	strcopy(g_sPhaseLast, sizeof(g_sPhaseLast), fields);
	EmitPug("PHASE %s", fields);
}

/** From OnMapEnd. The next PhaseTick is a map load away, and until then the
 *  page would keep saying "round over" about a map that is gone. */
void PhaseMapEnd()
{
	if (g_State == MS_None) return;
	strcopy(g_sPhaseLast, sizeof(g_sPhaseLast), "state=loading");
	EmitPug("PHASE state=loading");
}
