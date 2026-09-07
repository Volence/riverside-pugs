/** Skill stat capture for pug-match.
 *
 *  Included by pug-match.sp rather than living in its own plugin: every counter
 *  here has to be keyed to a roster slot that survives reconnects and map
 *  changes, and has to be emitted inside sm_pug_dump. pug-match owns the roster
 *  and the dump; a separate plugin would need natives just to reach them.
 *
 *  All l4d2_skill_detect forwards are GLOBAL forwards, so no dependency is
 *  required: if the plugin is absent these handlers simply never fire. That
 *  creates a silent-failure mode (zero skeets for everyone looks exactly like a
 *  match where nobody skeeted), so g_bSkillDetect is sampled at MATCH_START and
 *  stamped on the dump. */

// The include MUST be wrapped. l4d2_skill_detect.inc:427 declares
//
//     public SharedPlugin __pl_l4d2_skill_detect = {
//         name = "skill_detect", file = "l4d2_skill_detect.smx",
//     #if defined REQUIRE_PLUGIN
//         required = 1,
//     #else
//         required = 0,
//     #endif
//     };
//
// REQUIRE_PLUGIN is defined by default, so a bare `#include <l4d2_skill_detect>`
// makes skill_detect a HARD dependency and SourceMod refuses to load pug-match
// on any server without it. That would break the skilldetect=0 design, break the
// casual server, and break Task 9's verification step, which unloads
// skill_detect on purpose. pug-match already uses this exact idiom for
// readyup.inc at pug-match.sp:7-9; match it.
#undef REQUIRE_PLUGIN
#include <l4d2_skill_detect>
#define REQUIRE_PLUGIN

enum PugStat
{
	PS_Skeets = 0, PS_TeamSkeets, PS_SkeetsHurt, PS_SkeetAssists,
	PS_SkeetsShotgun, PS_SkeetsSniper, PS_SkeetsMelee,
	PS_Deadstops, PS_BoomerPops, PS_Crowns, PS_DrawCrowns,
	PS_TongueCuts, PS_SelfClears, PS_RockSkeets, PS_Clears, PS_InstaClears,
	PS_DpsLanded, PS_PounceDamageHigh, PS_BilesLanded, PS_SurvivorsBiled,
	PS_TankRocksLanded, PS_TimesSkeeted, PS_TimesDeadstopped,
	PS_TankDamage, PS_DamageAsSi, PS_TankPunches,
	PS_MAX
};

/** Wire keys. MUST match src/statKeys.ts exactly; tests/statKeys.test.ts is the
 *  backstop on the TypeScript side and a mismatch here is a silently missing
 *  stat, not an error. */
static const char g_sStatKey[PS_MAX][24] = {
	"skeets", "team_skeets", "skeets_hurt", "skeet_assists",
	"skeets_shotgun", "skeets_sniper", "skeets_melee",
	"deadstops", "boomer_pops", "crowns", "draw_crowns",
	"tongue_cuts", "self_clears", "rock_skeets", "clears", "insta_clears",
	"dps_landed", "pounce_damage_high", "biles_landed", "survivors_biled",
	"tank_rocks_landed", "times_skeeted", "times_deadstopped",
	"tank_damage", "damage_as_si", "tank_punches"
};

/** True for stats that come from skill_detect and must be omitted (not zeroed)
 *  from the dump when it was not loaded. The last three are captured by
 *  pug-match's own hooks and are always available. */
static bool StatNeedsSkillDetect(PugStat s)
{
	return s != PS_TankDamage && s != PS_DamageAsSi && s != PS_TankPunches;
}

int g_iSkill[MAX_ROSTER][PS_MAX];
bool g_bSkillDetect;                     // sampled at MATCH_START, not at dump time

void ResetSkillStats()
{
	for (int i = 0; i < MAX_ROSTER; i++)
		for (int s = 0; s < view_as<int>(PS_MAX); s++)
			g_iSkill[i][s] = 0;
	g_bSkillDetect = false;
}

/** Sampled once when the match goes live. Deliberately not read at dump time:
 *  a mid-match unload would otherwise make a partial capture look complete. */
void SampleSkillDetect()
{
	g_bSkillDetect = LibraryExists("skill_detect");
	PugDebug("skill_detect present=%d", g_bSkillDetect ? 1 : 0);
}

void AddStat(int client, PugStat stat, int amount = 1)
{
	if (client < 1 || client > MaxClients) return;
	int slot = g_iClientRoster[client];
	if (slot == -1) return;
	g_iSkill[slot][stat] += amount;
}

void WriteSkillLines()
{
	for (int i = 0; i < g_iRosterCount; i++)
	{
		// MUST stay >= DumpLine's own buffer (pug-match.sp, 1024): if this buffer
		// were smaller, IT would become the truncation point instead, silently
		// dropping trailing stat keys before the line ever reaches DumpLine.
		char line[1024];
		Format(line, sizeof(line), "SKILL steamid=%s", g_sRosterId[i]);
		for (int s = 0; s < view_as<int>(PS_MAX); s++)
		{
			if (!g_bSkillDetect && StatNeedsSkillDetect(view_as<PugStat>(s))) continue;
			Format(line, sizeof(line), "%s %s=%d", line, g_sStatKey[s], g_iSkill[i][s]);
		}
		// DumpLine is `DumpLine(const char[] fmt, any ...)` (pug-match.sp:164) and
		// VFormats its first argument, so a runtime-built string must never be
		// passed as the format. Current keys and steamids cannot contain '%', but
		// a non-literal format string is a latent defect regardless.
		DumpLine("%s", line);
	}
}

// ---------- skill_detect forwards ----------
//
// NOTE: OnSkeet does NOT fire for weapon-specific skeets. The dispatch in
// l4d2_skill_detect.sp:3461-3523 is an if/else-if chain, so a shotgun skeet
// fires OnSkeetShotgun ONLY. Implementing OnSkeet alone would miss nearly every
// skeet on L4D1. They are mutually exclusive, so summing them cannot double
// count. OnSkeetMagnum and OnSkeetGL can never fire on L4D1 (no such weapons)
// and are implemented only so the totals stay right if pointed at L4D2.

static void CountSkeet(int survivor, int victim, bool isTeamSkeet, PugStat weaponStat)
{
	AddStat(survivor, isTeamSkeet ? PS_TeamSkeets : PS_Skeets);
	if (weaponStat != PS_MAX) AddStat(survivor, weaponStat);
	AddStat(victim, PS_TimesSkeeted);
}

public void OnSkeet(int survivor, int victim, bool isTeamSkeet, bool isHunter, bool headshot, int shots)
{ CountSkeet(survivor, victim, isTeamSkeet, PS_MAX); }

public void OnSkeetShotgun(int survivor, int victim, bool isTeamSkeet, bool isHunter, bool headshot, int shots)
{ CountSkeet(survivor, victim, isTeamSkeet, PS_SkeetsShotgun); }

public void OnSkeetSniper(int survivor, int victim, bool isTeamSkeet, bool isHunter, bool headshot, int shots)
{ CountSkeet(survivor, victim, isTeamSkeet, PS_SkeetsSniper); }

public void OnSkeetMelee(int survivor, int victim, bool isTeamSkeet, bool isHunter, bool headshot)
{ CountSkeet(survivor, victim, isTeamSkeet, PS_SkeetsMelee); }

public void OnSkeetMagnum(int survivor, int victim, bool isTeamSkeet, bool isHunter, bool headshot, int shots)
{ CountSkeet(survivor, victim, isTeamSkeet, PS_MAX); }

public void OnSkeetGL(int survivor, int victim, bool isTeamSkeet, bool isHunter, bool headshot)
{ CountSkeet(survivor, victim, isTeamSkeet, PS_MAX); }

public void OnSkeetHurt(int survivor, int victim, int damage, bool isOverkill, bool isTeamSkeet, bool isHunter, bool headshot, int shots)
{ AddStat(survivor, PS_SkeetsHurt); }

public void OnSkeetShotgunHurt(int survivor, int victim, int damage, bool isOverkill, bool isTeamSkeet, bool isHunter, bool headshot, int shots)
{ AddStat(survivor, PS_SkeetsHurt); }

public void OnSkeetSniperHurt(int survivor, int victim, int damage, bool isOverkill, bool isTeamSkeet, bool isHunter, bool headshot, int shots)
{ AddStat(survivor, PS_SkeetsHurt); }

public void OnSkeetMeleeHurt(int survivor, int victim, int damage, bool isOverkill, bool isTeamSkeet, bool isHunter, bool headshot)
{ AddStat(survivor, PS_SkeetsHurt); }

public void OnTeamSkeetAssist(int victim, int assist, bool isHunter, int damage, int shots)
{ AddStat(assist, PS_SkeetAssists); }

public void OnHunterDeadstop(int survivor, int hunter)
{ AddStat(survivor, PS_Deadstops); AddStat(hunter, PS_TimesDeadstopped); }

public void OnBoomerPop(int survivor, int boomer, int shoveCount, float timeAlive)
{ AddStat(survivor, PS_BoomerPops); }

public void OnWitchCrown(int survivor, int damage)
{ AddStat(survivor, PS_Crowns); }

public void OnWitchCrownHurt(int survivor, int damage, int chipdamage)
{ AddStat(survivor, PS_DrawCrowns); }

public void OnTongueCut(int survivor, int smoker)
{ AddStat(survivor, PS_TongueCuts); }

public void OnSmokerSelfClear(int survivor, int smoker, bool withShove, bool headshot)
{ AddStat(survivor, PS_SelfClears); }

public void OnTankRockSkeeted(int survivor, int tank)
{ AddStat(survivor, PS_RockSkeets); }

public void OnTankRockEaten(int tank, int survivor)
{ AddStat(tank, PS_TankRocksLanded); }

public void OnHunterHighPounce(int hunter, int victim, int actualDamage, float calculatedDamage, float height, bool bReportedHigh)
{
	if (bReportedHigh) AddStat(hunter, PS_DpsLanded);
	AddStat(hunter, PS_PounceDamageHigh, actualDamage);
}

public void OnBoomerVomitLanded(int boomer, int amount)
{ AddStat(boomer, PS_BilesLanded); AddStat(boomer, PS_SurvivorsBiled, amount); }

/** insta_clears is a SUBSET of clears, not additional to it. */
public void OnSpecialClear(int clearer, int pinner, int pinvictim, int zombieClass, float timeA, float timeB, bool withShove, bool headshot)
{
	AddStat(clearer, PS_Clears);
	if (timeA > 0.0 && timeA <= 0.75) AddStat(clearer, PS_InstaClears);
}
