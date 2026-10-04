export const CAMPAIGNS: Record<string, { name: string }> = {
  no_mercy: { name: 'No Mercy' },
  death_toll: { name: 'Death Toll' },
  dead_air: { name: 'Dead Air' },
  blood_harvest: { name: 'Blood Harvest' },
  dead_center: { name: 'Dead Center' },
  dark_carnival: { name: 'Dark Carnival' },
  swamp_fever: { name: 'Swamp Fever' },
  hard_rain: { name: 'Hard Rain' },
  the_parish: { name: 'The Parish' },
  the_passing: { name: 'Passifice' },
  cold_stream: { name: 'Cold Stream' },
  the_last_stand: { name: 'The Last Stand' },
};

/**
 * Names shown ONLY in the campaign vote (site tiles and Discord buttons), for
 * easter eggs. Everywhere else, match pages, history, stats, keeps the plain
 * name. The Parish plays with the l4d_nightmode plugin on (owner, 2026-10-01),
 * so its vote tile hints that something is off; Dead Center, Dark Carnival and
 * Hard Rain joined it on 2026-10-02 when they went into the pool at night.
 * Mirrored in web/src/format.ts.
 */
export const VOTE_NAMES: Record<string, string> = {
  // "The Parish???" in glitch (Zalgo) text: combining marks stacked on the
  // letters, 42 UTF-16 units so a Discord button label (80 max) still fits
  // with its vote count.
  // Same treatment, 44 UTF-16 units each.
  dead_center: 'D\u0351\u0355\u036ee\u036b\u0348\u0351a\u0363\u0359\u0308d\u0307\u034e\u0357 C\u0367\u0326e\u0304\u0347n\u0311\u0324t\u0302\u0354e\u036c\u0318r\u0366\u033b?\u0351\u0325?\u0366\u0316?\u036d\u0353',
  dark_carnival: 'D\u0357\u032ea\u0368\u0353r\u0368\u0333k\u0306\u033a C\u0300\u0339a\u0357\u032er\u0367\u0348n\u0369\u035ai\u030c\u0355v\u0300\u0324a\u0351\u0339l\u0307\u0332?\u036f\u032a?\u0301?\u0365',
  hard_rain: 'H\u0310\u032f\u0368a\u0368\u0326\u0367r\u030c\u0324\u036ed\u030c\u0326\u0306 R\u0302\u0354\u036ea\u0308\u032f\u0300i\u0350\u0320\u036dn\u0368\u035a\u0300?\u0310\u0324\u0302?\u036e\u032d\u036d?\u0351\u0345',
  the_parish: 'T\u036e\u0356h\u0304\u0331\u0350e\u036a\u032e P\u0301\u0348\u0305a\u0314\u0326\u0307r\u0308\u0356i\u0367\u0318s\u0346\u032ah\u0369\u0332\u0351?\u0363\u031e?\u0314\u0359?\u030c\u0333\u0367',
  swamp_fever: 'S\u0300\u0346\u0308w\u0369\u0333\u0310a\u0363\u0302\u030cm\u0308\u0350\u031ep\u0366\u0369 F\u030c\u0310e\u0368\u0302v\u035a\u0304e\u030c\u031er\u0350\u0367?\u033b\u034e?\u0339\u0318?\u0354\u0306',
  the_passing: 'P\u0308\u0301\u036aa\u0333\u032e\u0316s\u0318\u032e\u0333s\u0331\u0355\u0320i\u0318\u0367\u0318f\u0339\u0354\u035ai\u0351\u0304\u0304c\u036e\u0314\u032fe\u030c\u0318?\u0310\u036e?\u036b\u0332?\u0301\u0306',
};

/**
 * What a map name may look like. A chapter's map name reaches an rcon command
 * line (`changelevel <map>`), and for a community campaign it comes out of a
 * file inside an uploaded VPK. Unquoted, a ';' in it starts a second command.
 * Quoting does not settle it either: the engine's command buffer honours
 * quotes for ';' but breaks on a newline wherever it finds one, and a mission
 * file can put a newline between quotes. So the name is refused where it
 * enters (parseMission) and asserted again where it leaves (the
 * orchestrator). Every stock and dlc4 map passes.
 */
const MAP_NAME_RE = /^[A-Za-z0-9_]{1,63}$/;
export const isMapName = (s: string): boolean => MAP_NAME_RE.test(s);

/**
 * The campaigns that live in `left4dead_dlc4` rather than in the base game.
 *
 * A const set rather than something derived from which missions directory the
 * campaign was read from. Deriving it would make the pool gate collapse to
 * "allowed" whenever MISSIONS_DIR is unconfigured, which is failing open on the
 * one check that stops a match landing on a server with no maps. This fails
 * closed and does not depend on config at all.
 */
export const DLC4_CAMPAIGNS: ReadonlySet<string> = new Set([
  'dead_center', 'dark_carnival', 'swamp_fever', 'hard_rain',
  'the_parish', 'the_passing', 'cold_stream', 'the_last_stand',
]);

/**
 * L4D1 map names embed their campaign as a fixed word after the `l4d_` or
 * `l4d_vs_` prefix: `l4d_vs_airport01_greenhouse` is Dead Air. Matching on that
 * word is stable across all five chapters and across the coop/versus variants.
 *
 * Needed because a match started in-game with `!load_4v4p` reports the map it
 * is standing on: the plugin has no campaign table and should not grow one.
 *
 * Returns null rather than a default for anything unrecognised. Guessing would
 * silently file a custom map under a real campaign.
 */
const CAMPAIGN_BY_MAP_WORD: Record<string, string> = {
  hospital: 'no_mercy',
  smalltown: 'death_toll',
  airport: 'dead_air',
  farm: 'blood_harvest',
  // The Sacrifice's maps, filed under Passifice on purpose.
  //
  // `the_passing` on this server is not stock The Passing: the dlc4 mission
  // file is overridden to chain c6m1 and c6m2 into the three river maps as one
  // five-chapter campaign, so the versus score carries across both. Chapters 3
  // to 5 are therefore river maps, and without this they resolve to null and
  // three fifths of the campaign goes unattributed in stats and in any match
  // started from in-game.
  //
  // The trade is that a standalone Sacrifice game would also read as Passifice.
  // That is the right way round here: the river maps are only reachable through
  // Passifice in this rotation, and losing attribution on the common case to
  // stay literal about the rare one would be the worse bargain.
  river: 'the_passing',
};

/**
 * The dlc4 ports keep L4D2's own naming, `c<campaign>m<chapter>_<place>`, which
 * shares no structure with the L4D1 scheme above and so needs its own table.
 *
 * Note the numbers are not contiguous: Cold Stream is 13 and The Last Stand is
 * 14, matching L4D2's own campaign ids. A range check would be wrong.
 */
const CAMPAIGN_BY_DLC4_NUMBER: Record<string, string> = {
  1: 'dead_center',
  2: 'dark_carnival',
  3: 'swamp_fever',
  4: 'hard_rain',
  5: 'the_parish',
  6: 'the_passing',
  13: 'cold_stream',
  14: 'the_last_stand',
};

export function campaignForMap(map: string): string | null {
  const lower = map.toLowerCase();

  const dlc4 = /^c(\d+)m\d+/.exec(lower);
  if (dlc4) return CAMPAIGN_BY_DLC4_NUMBER[dlc4[1]] ?? null;

  const m = /^l4d_(?:vs_)?([a-z]+)\d*/.exec(lower);
  if (!m) return null;
  return CAMPAIGN_BY_MAP_WORD[m[1]] ?? null;
}
