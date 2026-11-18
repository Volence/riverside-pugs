// pug-altscore.inc: health-run scoring (rule hr1), shadow only.
//
// l4dscores computes each half under the alt rule and holds the result from its
// round_end Pre hook until the next round_start (Score_GetAltHalf). This file
// reads it once per finished half in pug-match's own round_end handler (the
// delayed score read runs 2 to 8 seconds later, possibly after round_start has
// cleared it), holds it as the pending record, and sends it as one ALT_ROUND
// line where the half is finished, keeping a copy for the dump's ALT lines, so
// a lost datagram is filled in when the backend collects the result. Nothing
// here feeds a real score: the native is optional and feature-checked, and when
// it is missing (today's l4dscores) or returns false (l4d_score_alt 0, or no
// finished half held) nothing is sent and nothing is stored.
//
// The health curve (0.3.47): when l4dscores also has Score_GetAltCurve (checked
// on its own, so a l4dscores with only Score_GetAltHalf still sends the rest),
// the same body ends with
//   curve=<21 comma separated ints, team health % at 0, 5, .., 100% of the map, -1 not reached>
//   tankat=<open>,<close>   (the covered figure 0..100 at the tank window, -1 none)
// Without the native the two fields are absent, as an older site expects.
//
// The line format is pinned by src/logParse.ts parseAltFields (UDP ALT_ROUND)
// and src/dumpParse.ts (dump ALT), which share the fields after the verb.

#define ALT_SLOTS 64
// The longest body is 504 characters: a 63 character map, every int at 11
// characters (-2147483648), every raw float at 14 (-2147483648.00, far beyond
// any real store), and curve and tankat at their widest (21 x "100", "100,100",
// 105 characters with their spaces). 640 leaves room; the UDP line is "ALT_ROUND "
// + body (at most 649 of EmitPug's 768) and the dump line "ALT " + body (at most
// 643 of DumpLine's 1024).
#define ALT_BODY_LEN 640
#define ALT_CURVE_POINTS 21

// One record per finished half for the whole match, in the order played: the
// line's fields after the verb, exactly as they were sent.
char g_sAltBody[ALT_SLOTS][ALT_BODY_LEN];
int g_iAltCount;

// The half read at round_end and not yet sent: its line body, and whether one
// is held.
char g_sAltPending[ALT_BODY_LEN];
bool g_bAltPending;

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

/** A curve point or tank position as sent: -1..100 (anything else is -1, so a
 *  bad value can never make the backend refuse the field). */
int AltCurveValue(int v)
{
	if (v < 0) return -1;
	return v > 100 ? 100 : v;
}

/** " curve=a,b,..,u tankat=o,c" for the held half, or "" when l4dscores has no
 *  Score_GetAltCurve or holds no half. */
void AltCurveFields(char[] out, int maxlen)
{
	out[0] = '\0';
	if (GetFeatureStatus(FeatureType_Native, "Score_GetAltCurve") != FeatureStatus_Available) return;
	int curve[ALT_CURVE_POINTS];
	int tankOpen, tankClose;
	if (!Score_GetAltCurve(curve, tankOpen, tankClose)) return;
	strcopy(out, maxlen, " curve=");
	char v[8];
	for (int i = 0; i < ALT_CURVE_POINTS; i++)
	{
		FormatEx(v, sizeof(v), i == 0 ? "%d" : ",%d", AltCurveValue(curve[i]));
		StrCat(out, maxlen, v);
	}
	FormatEx(v, sizeof(v), "%d", AltCurveValue(tankOpen));
	StrCat(out, maxlen, " tankat=");
	StrCat(out, maxlen, v);
	FormatEx(v, sizeof(v), ",%d", AltCurveValue(tankClose));
	StrCat(out, maxlen, v);
}

/** A half has ended: read its alt numbers now, while l4dscores still holds
 *  them, and keep them as the pending record. Called from Event_RoundEnd only,
 *  once per half. `half` and `surv` are the values captured there, as
 *  EmitRoundEnd takes them. Any older pending record (a half whose send never
 *  ran) is dropped first, so it can never go out under a later half. */
void AltScore_Capture(int half, const char[] surv)
{
	g_bAltPending = false;
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
	else if (tankPct < 0) tankPct = 0;
	else if (tankPct > 100) tankPct = 100;

	char curveFields[128];
	AltCurveFields(curveFields, sizeof(curveFields));

	char body[ALT_BODY_LEN];
	FormatEx(body, sizeof(body),
		"map=%s half=%d surv=%s rule=hr1 walk=%d tank=%d door=%d wm=%d dm=%d "
		... "ws=%.2f wt=%.2f wr=%.2f ts=%.2f tt=%.2f tr=%.2f ds=%.2f dt=%.2f dr=%.2f "
		... "tankpct=%d tankby=%s tanks=%d in=%d%s",
		g_sCurrentMap, half, surv, walk, tank, door, wmX100, dmX100,
		raw[0], raw[1], raw[2], raw[3], raw[4], raw[5], raw[6], raw[7], raw[8],
		tankPct, by, tanks, survivorsIn, curveFields);

	strcopy(g_sAltPending, sizeof(g_sAltPending), body);
	g_bAltPending = true;
}

/** The half has been scored: send the pending record and keep it for the
 *  dump. Called before FinishSecondHalf, which can end the match in the same
 *  frame (a line after MATCH_END is dropped by the backend). Sends nothing
 *  when no record is pending, and at most once per capture. */
void AltScore_SendPending()
{
	if (!g_bAltPending) return;
	g_bAltPending = false;
	EmitPug("ALT_ROUND %s", g_sAltPending);
	if (g_iAltCount < ALT_SLOTS)
	{
		strcopy(g_sAltBody[g_iAltCount], ALT_BODY_LEN, g_sAltPending);
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
	g_bAltPending = false;
}
