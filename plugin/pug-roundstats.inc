// Per-round data for the balance metrics engine. Match totals already exist;
// what is new is (1) the same counters as per-round deltas, (2) damage and
// kills split by weapon, and (3) panic/finale markers for the event phase.

enum { WS_SiDmg = 0, WS_TankDmg, WS_SiKill, WS_CiKill, WS_MAX }
// Plain char arrays, not `static const`: a const 2D global char array fails
// to parse under this spcomp (see build lessons), and `static` would scope
// the symbol to this physical file only, which is fine here since both
// tables are used only inside this include.
char g_sWsKey[WS_MAX][8] = { "sidmg", "tankdmg", "sikill", "cikill" };

#define WPN_COUNT 9
char g_sWpnKey[WPN_COUNT][16] = {
	"pistol", "smg", "pumpshotgun", "autoshotgun", "rifle",
	"hunting_rifle", "molotov", "pipe_bomb", "other"
};

char g_sRoundCoreKey[5][8] = { "ck", "sidmg", "sikill", "ff", "rev" };

int g_iSkillAtLive[MAX_ROSTER][PS_MAX];
int g_iCoreAtLive[MAX_ROSTER][5];      // ck, sidmg, sikill, ff, rev
int g_iRoundWpn[MAX_ROSTER][WPN_COUNT][WS_MAX];

static int WpnIndex(const char[] raw)
{
	char w[32];
	strcopy(w, sizeof(w), raw);
	ReplaceString(w, sizeof(w), "weapon_", "", false);
	if (StrEqual(w, "inferno") || StrEqual(w, "entityflame") || StrEqual(w, "molotov")) return 6;
	for (int i = 0; i < WPN_COUNT - 1; i++) if (StrEqual(w, g_sWpnKey[i])) return i;
	return WPN_COUNT - 1;
}

/** Go-live: snapshot the match counters so round end can send deltas. */
void RoundStatsBegin()
{
	for (int r = 0; r < MAX_ROSTER; r++)
	{
		for (int s = 0; s < view_as<int>(PS_MAX); s++) g_iSkillAtLive[r][s] = g_iSkill[r][s];
		g_iCoreAtLive[r][0] = g_iStatCk[r];
		g_iCoreAtLive[r][1] = g_iStatSiDmg[r];
		g_iCoreAtLive[r][2] = g_iStatSiKill[r];
		g_iCoreAtLive[r][3] = g_iStatFf[r];
		g_iCoreAtLive[r][4] = g_iStatRev[r];
		for (int w = 0; w < WPN_COUNT; w++) for (int k = 0; k < WS_MAX; k++) g_iRoundWpn[r][w][k] = 0;
	}
}

void RoundWpnAdd(int attacker, const char[] weapon, int stat, int amount)
{
	if (!StatsActive() || attacker < 1 || attacker > MaxClients) return;
	int slot = g_iClientRoster[attacker];
	if (slot == -1) return;
	g_iRoundWpn[slot][WpnIndex(weapon)][stat] += amount;
}

/** For events that carry no weapon (infected_death): the attacker's held gun. */
void RoundWpnAddActive(int attacker, int stat, int amount)
{
	if (attacker < 1 || attacker > MaxClients || !IsClientInGame(attacker)) return;
	char w[32];
	GetClientWeapon(attacker, w, sizeof(w));
	RoundWpnAdd(attacker, w, stat, amount);
}

static void RsAppend(char[] line, int maxlen, const char[] prefix, const char[] kv)
{
	if (strlen(line) + strlen(kv) > 600)
	{
		EmitPug("%s", line);
		strcopy(line, maxlen, prefix);
	}
	StrCat(line, maxlen, kv);
}

/** Round end, called synchronously right after g_bRoundEnded latches, so the
 *  counters are frozen and the round's half is still current. Only nonzero
 *  values go out; ROUND_STATS_END carries sd= so the backend can tell
 *  "skill_detect absent" from "zero". */
void EmitRoundStats(int half)
{
	// A plain global, not a local `static const`: a local static array of this
	// shape may not parse under this spcomp (per the build lessons), so it is
	// hoisted out as an ordinary global instead of risking it.
	int players = 0;
	for (int r = 0; r < g_iRosterCount; r++)
	{
		char prefix[64], line[768], kv[48];
		Format(prefix, sizeof(prefix), "ROUND_STAT half=%d steamid=%s", half, g_sRosterId[r]);
		strcopy(line, sizeof(line), prefix);
		int core[5];
		core[0] = g_iStatCk[r]; core[1] = g_iStatSiDmg[r]; core[2] = g_iStatSiKill[r];
		core[3] = g_iStatFf[r]; core[4] = g_iStatRev[r];
		for (int c = 0; c < 5; c++)
		{
			int d = core[c] - g_iCoreAtLive[r][c];
			if (d == 0) continue;
			Format(kv, sizeof(kv), " %s=%d", g_sRoundCoreKey[c], d);
			RsAppend(line, sizeof(line), prefix, kv);
		}
		for (int s = 0; s < view_as<int>(PS_MAX); s++)
		{
			if (!g_bSkillDetect && StatNeedsSkillDetect(view_as<PugStat>(s))) continue;
			int d = g_iSkill[r][s] - g_iSkillAtLive[r][s];
			if (d == 0) continue;
			Format(kv, sizeof(kv), " %s=%d", g_sStatKey[s], d);
			RsAppend(line, sizeof(line), prefix, kv);
		}
		for (int w = 0; w < WPN_COUNT; w++)
		{
			for (int k = 0; k < WS_MAX; k++)
			{
				if (g_iRoundWpn[r][w][k] == 0) continue;
				Format(kv, sizeof(kv), " w_%s_%s=%d", g_sWpnKey[w], g_sWsKey[k], g_iRoundWpn[r][w][k]);
				RsAppend(line, sizeof(line), prefix, kv);
			}
		}
		if (strlen(line) > strlen(prefix)) EmitPug("%s", line);
		players++;
	}
	EmitPug("ROUND_STATS_END half=%d players=%d sd=%d", half, players, g_bSkillDetect ? 1 : 0);
}

static void EmitRoundMark(const char[] kind)
{
	if (g_State != MS_Live || g_bRoundEnded || g_fRoundLiveAt <= 0.0) return;
	EmitPug("ROUND_MARK half=%d kind=%s t=%d", g_iHalf, kind, RoundMs());
}

public void Event_PanicMark(Event event, const char[] name, bool dontBroadcast) { EmitRoundMark("panic"); }
public void Event_FinaleStartMark(Event event, const char[] name, bool dontBroadcast) { EmitRoundMark("finale_start"); }
public void Event_FinaleRadioMark(Event event, const char[] name, bool dontBroadcast) { EmitRoundMark("finale_radio"); }
