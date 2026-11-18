// pug-altscore.inc: health-run scoring (rule hr1), shadow only.
//
// l4dscores computes each half under the alt rule and holds the result from its
// round_end Pre hook until the next round_start (Score_GetAltHalf). This file
// reads it once per finished half, sends it as one ALT_ROUND line and keeps a
// copy for the dump's ALT lines, so a lost datagram is filled in when the
// backend collects the result. Nothing here feeds a real score: the native is
// optional and feature-checked, and when it is missing (today's l4dscores) or
// returns false (l4d_score_alt 0, or no finished half held) nothing is sent and
// nothing is stored.
//
// The line format is pinned by src/logParse.ts parseAltFields (UDP ALT_ROUND)
// and src/dumpParse.ts (dump ALT), which share the fields after the verb.

#define ALT_SLOTS 64
// The longest body is about 310 characters (a 63 character map, every number
// at its widest); 512 leaves room.
#define ALT_BODY_LEN 512

// One record per finished half for the whole match, in the order played: the
// line's fields after the verb, exactly as they were sent.
char g_sAltBody[ALT_SLOTS][ALT_BODY_LEN];
int g_iAltCount;

/** The words parseAltFields accepts for Score_GetAltHalf's tankBy. */
void AltTankByName(int by, char[] out, int maxlen)
{
	switch (by)
	{
		case 1: strcopy(out, maxlen, "surv");
		case 2: strcopy(out, maxlen, "other");
		case 3: strcopy(out, maxlen, "gone");
		default: strcopy(out, maxlen, "none");
	}
}

/** A half has ended and been scored: send its alt numbers and keep them for
 *  the dump. Called before FinishSecondHalf, which can end the match in the
 *  same frame (a line after MATCH_END is dropped by the backend). `half` and
 *  `surv` are the values captured at round_end, as EmitRoundEnd takes them. */
void AltScore_OnRoundEnd(int half, const char[] surv)
{
	if (surv[0] == '\0') return;
	if (GetFeatureStatus(FeatureType_Native, "Score_GetAltHalf") != FeatureStatus_Available) return;

	int walk, tank, door, wmX100, dmX100, tankPct, tankBy, tanks, survivorsIn;
	float raw[9];
	if (!Score_GetAltHalf(walk, tank, door, raw, wmX100, dmX100, tankPct, tankBy, tanks, survivorsIn)) return;

	char by[8];
	AltTankByName(tankBy, by, sizeof(by));
	// The backend refuses tankby=none with any tankpct but -1, and the others
	// outside 0..100: keep the pair consistent with the word sent.
	if (tankBy < 1 || tankBy > 3) tankPct = -1;

	char body[ALT_BODY_LEN];
	FormatEx(body, sizeof(body),
		"map=%s half=%d surv=%s rule=hr1 walk=%d tank=%d door=%d wm=%d dm=%d "
		... "ws=%.2f wt=%.2f wr=%.2f ts=%.2f tt=%.2f tr=%.2f ds=%.2f dt=%.2f dr=%.2f "
		... "tankpct=%d tankby=%s tanks=%d in=%d",
		g_sCurrentMap, half, surv, walk, tank, door, wmX100, dmX100,
		raw[0], raw[1], raw[2], raw[3], raw[4], raw[5], raw[6], raw[7], raw[8],
		tankPct, by, tanks, survivorsIn);

	EmitPug("ALT_ROUND %s", body);
	if (g_iAltCount < ALT_SLOTS)
	{
		strcopy(g_sAltBody[g_iAltCount], ALT_BODY_LEN, body);
		g_iAltCount++;
	}
}

/** The dump's ALT lines, one per stored half. Called by WriteDump before END. */
void AltScore_WriteDump()
{
	for (int i = 0; i < g_iAltCount; i++)
		DumpLine("ALT %s", g_sAltBody[i]);
}

/** A new match: forget the last one's halves. Never called from EndMatchNow,
 *  since sm_pug_dump is read after the match has ended. */
void AltScore_Reset()
{
	g_iAltCount = 0;
}
