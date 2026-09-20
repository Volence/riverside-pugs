/** The SteamID64 of account 0 in the individual-account universe. */
const STEAM64_BASE = 76561197960265728n;

/**
 * SteamID64 to the classic `STEAM_1:Y:Z` form.
 *
 * This is the only form the L4D1 engine's `banid` parses: `strings engine.so`
 * shows `STEAM_%u:%u:%u` and no SteamID3 parser at all. SourceMod's
 * `sm_addban` also accepts `[U:1:N]`, but it hands the string straight to the
 * engine, so that form would be accepted and then silently match nobody. The
 * universe digit is 1 because that is what the engine prints in its own logs.
 *
 * Verified pair: 76561198030413993 is logged by the Dallas box as
 * STEAM_1:1:35074132, and 35074132 * 2 + 1 == 70148265 == id64 - base.
 */
export function steam64ToSteam2(id64: string): string {
  if (!/^\d{17}$/.test(id64)) throw new Error(`not a SteamID64: ${id64}`);
  const acc = BigInt(id64) - STEAM64_BASE;
  if (acc < 0n) throw new Error(`not a SteamID64: ${id64}`);
  return `STEAM_1:${acc % 2n}:${acc / 2n}`;
}
