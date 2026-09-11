/** Single source of truth for skill stat keys.
 *
 *  Storage is a narrow key/value table (`match_player_stats`) rather than one
 *  column per stat, so adding a stat needs no migration. The cost of that choice
 *  is that a typo'd key is not a DB error, it is a silently empty leaderboard.
 *  This registry plus tests/statKeys.test.ts is the mitigation: the plugin, the
 *  parser and the API all resolve keys through here. */

export type StatSide = 'survivor' | 'infected';

/** `self` stats are shown only to the player they describe and are never
 *  eligible for a leaderboard. Used for stats where a high number is bad. */
export type StatVisibility = 'public' | 'self';

/** Whether a high value is good, bad, or neither.
 *
 *  Needed by the match page's outlier marking, which cannot know which end of
 *  a column to praise without it. `neutral` covers two distinct cases and both
 *  must stay unmarked: denominators (boomer_spawns is how many boomers you
 *  drew, not an achievement) and breakdowns of another stat (the weapon
 *  specific skeet counters are subsets of `skeets`, so marking both would
 *  count one good play several times). */
export type StatDirection = 'high_good' | 'high_bad' | 'neutral';

export interface StatDef {
  key: string;
  side: StatSide;
  visibility: StatVisibility;
  label: string;
  /** True when the value comes from an l4d2_skill_detect forward, and is
   *  therefore absent (not zero) from a dump whose header says skilldetect=0. */
  needsSkillDetect: boolean;
  direction: StatDirection;
}

const def = (
  key: string, side: StatSide, label: string, direction: StatDirection,
  needsSkillDetect = true, visibility: StatVisibility = 'public',
): StatDef => ({ key, side, label, needsSkillDetect, visibility, direction });

export const STAT_DEFS: readonly StatDef[] = [
  // Survivor, from skill_detect. A team skeet is not also a skeet.
  //
  // Invariant, intended, not a bug: skeets_shotgun + skeets_sniper + skeets_melee
  // can exceed skeets. A team skeet credits team_skeets and the weapon key but
  // NOT skeets, so summing the weapon columns counts team skeets that the
  // skeets column itself excludes.
  def('skeets', 'survivor', 'Skeets', 'high_good'),
  def('team_skeets', 'survivor', 'Team skeets', 'high_good'),
  // A chip skeet only means something as a ratio against clean skeets; on its
  // own it says nothing, so it stays neutral rather than good.
  def('skeets_hurt', 'survivor', 'Hurt skeets', 'neutral'),
  def('skeet_assists', 'survivor', 'Skeet assists', 'high_good'),
  // Subsets of `skeets`, not independent achievements. Marking the total and
  // its parts would count one good play several times over.
  def('skeets_shotgun', 'survivor', 'Shotgun skeets', 'neutral'),
  def('skeets_sniper', 'survivor', 'Sniper skeets', 'neutral'),
  def('skeets_melee', 'survivor', 'Melee skeets', 'neutral'),
  def('deadstops', 'survivor', 'Deadstops', 'high_good'),
  def('boomer_pops', 'survivor', 'Boomer pops', 'high_good'),
  def('crowns', 'survivor', 'Crowns', 'high_good'),
  def('draw_crowns', 'survivor', 'Draw crowns', 'high_good'),
  def('tongue_cuts', 'survivor', 'Tongue cuts', 'high_good'),
  def('self_clears', 'survivor', 'Self clears', 'high_good'),
  def('rock_skeets', 'survivor', 'Rock skeets', 'high_good'),
  def('clears', 'survivor', 'Clears', 'high_good'),
  def('insta_clears', 'survivor', 'Insta clears', 'high_good'),

  // Infected, from skill_detect.
  def('dps_landed', 'infected', 'DPs landed', 'high_good'),
  def('pounce_damage_high', 'infected', 'High pounce damage', 'high_good'),
  def('biles_landed', 'infected', 'Biles landed', 'high_good'),
  def('survivors_biled', 'infected', 'Survivors biled', 'high_good'),
  def('tank_rocks_landed', 'infected', 'Tank rocks landed', 'high_good'),

  // Infected, private. High is bad, so shown only to the player themselves and
  // never rankable. See the spec's "Stat visibility" section.
  def('times_skeeted', 'infected', 'Times skeeted', 'high_bad', true, 'self'),
  def('times_deadstopped', 'infected', 'Times deadstopped', 'high_bad', true, 'self'),

  // Captured by pug-match's own hooks, so always available even with no
  // skill_detect on the server.
  def('tank_damage', 'survivor', 'Tank damage', 'high_good', false),
  def('damage_as_si', 'infected', 'Damage as SI', 'high_good', false),
  def('tank_punches', 'infected', 'Tank punches', 'high_good', false),
  // Denominator for boomer success rate. Counted from player_spawn by
  // pug-match itself, so it needs no skill_detect. The rate is derived at
  // display time rather than stored: storing a ratio would go stale the moment
  // either side of it changed. Drawing more boomers is not an achievement, so
  // this stays neutral.
  def('boomer_spawns', 'infected', 'Boomer spawns', 'neutral', false),
  // Mirrors l4dcompstats.sp's BoomSuccesses/BoomedSurvivorsBy* so the site
  // agrees with the numbers already printed in console. A success is
  // once per boomer LIFE, not per survivor caught, which is what makes
  // successes/attempts a meaningful ratio; the two survivor counters below
  // are per survivor. Proxy is the death explosion, vomit is a direct hit.
  def('boom_successes', 'infected', 'Booms landed', 'high_good', false),
  def('boomed_vomit', 'infected', 'Boomed by vomit', 'high_good', false),
  def('boomed_proxy', 'infected', 'Boomed by proxy', 'high_good', false),
];

const BY_KEY = new Map(STAT_DEFS.map((d) => [d.key, d]));

export function statDef(key: string): StatDef | undefined {
  return BY_KEY.get(key);
}

export function isKnownStat(key: string): boolean {
  return BY_KEY.has(key);
}

export function publicStatKeys(): string[] {
  return STAT_DEFS.filter((d) => d.visibility === 'public').map((d) => d.key);
}

export function skillDetectStatKeys(): string[] {
  return STAT_DEFS.filter((d) => d.needsSkillDetect).map((d) => d.key);
}
