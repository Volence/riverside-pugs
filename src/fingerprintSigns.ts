import type { DB } from './db.js';
import { personOf } from './evaderPeople.js';
import { resolveAlias } from './aliases.js';
import { isVpnNetwork } from './networkKinds.js';
import { SIGN_ORDER, type SecondSign } from './fingerprint.js';
import { completedPug } from './matchKinds.js';

/**
 * Who the fingerprint check looks at, and the independent second signs that
 * lift a fingerprint alert to a hold.
 *
 * Design: docs/superpowers/specs/2026-10-17-evader-fingerprints-design.md
 *
 * Only NEW accounts are checked: at about 3% honest overlap per person, an
 * established regular would be a steady stream of false alerts, and evaders
 * arrive as new accounts. A fingerprint says "could be them"; a hold needs
 * one more thing seen on the account that a fingerprint cannot produce.
 *
 * Every function takes the moment to answer for, so the history replay
 * (src/fingerprintReplay.ts) asks "as of that match end" with this same code.
 * Columns come in two formats here, so every comparison uses the column's
 * own: matches.ended_at and players.created_at are SQLite datetimes
 * ('YYYY-MM-DD HH:MM:SS'), bans, flags, networks and bursts are ISO.
 */

const DAY = 86_400_000;
export const NEW_RATED_MATCHES = 15;
export const NEW_SITE_ACCOUNT_MS = 30 * DAY;
export const YOUNG_STEAM_MS = 365 * DAY;
export const YOUNG_DISCORD_MS = 90 * DAY;
export const YOUNG_SITE_MS = 7 * DAY;
const DISCORD_EPOCH = 1420070400000n;

/** The aimbot and wallhack kinds in integrity_flags. hs_share, flick_return
 *  and aimbot_multi come from the aimbot rules
 *  (docs/superpowers/specs/2026-10-17-aimbot-rules-design.md); listing them
 *  before they exist matches nothing and costs nothing. */
export const CHEAT_FLAG_KINDS = ['aimbot', 'aimlock', 'newcomer_esp', 'hs_share', 'flick_return', 'aimbot_multi'] as const;

export function dbTimeMs(s: string | null): number | null {
  if (!s) return null;
  const t = Date.parse(s.includes('T') ? s : `${s.replace(' ', 'T')}Z`);
  return Number.isNaN(t) ? null : t;
}

export const sqlTime = (at: Date): string => at.toISOString().replace('T', ' ').slice(0, 19);

/** A Discord id is a snowflake: its top bits are milliseconds since 2015. */
export function discordCreatedMs(id: string): number | null {
  if (!/^\d{17,20}$/.test(id)) return null;
  return Number((BigInt(id) >> 22n) + DISCORD_EPOCH);
}

/** hasActiveBan, at a moment: placed by then and not yet lifted or expired. */
export function activeBanAt(db: DB, steamid: string, at: Date): boolean {
  const iso = at.toISOString();
  return db.prepare(
    `SELECT 1 FROM bans WHERE player_id = ? AND created_at <= ?
       AND (lifted_at IS NULL OR lifted_at > ?) AND (expires_at IS NULL OR expires_at > ?) LIMIT 1`,
  ).get(steamid, iso, iso, iso) !== undefined;
}

/** Rated PUGs only (completedPug, as tests/matchKindGuard.test.ts requires):
 *  a scrim or a tournament match does not make an account established. */
export function ratedMatchesAt(db: DB, steamid: string, at: Date): number {
  return (db.prepare(
    `SELECT COUNT(*) AS n FROM match_players mp JOIN matches m ON m.id = mp.match_id
      WHERE mp.player_id = ? AND mp.rated = 1 AND ${completedPug('m')} AND m.voided_at IS NULL
        AND COALESCE(m.ended_at, m.created_at) <= ?`,
  ).get(steamid, sqlTime(at)) as { n: number }).n;
}

export function isNewAccount(db: DB, steamid: string, at: Date): boolean {
  if (ratedMatchesAt(db, steamid, at) < NEW_RATED_MATCHES) return true;
  const row = db.prepare('SELECT created_at FROM players WHERE steamid = ?').get(steamid) as { created_at: string } | undefined;
  const created = dbTimeMs(row?.created_at ?? null);
  return created !== null && at.getTime() - created < NEW_SITE_ACCOUNT_MS;
}

/** The players of this match the check looks at: no member of any person
 *  (open or closed, or an alias of one), no ban or hold, and new. */
export function candidatesOf(db: DB, matchId: number, at: Date): string[] {
  const ids = (db.prepare('SELECT DISTINCT steamid FROM input_bursts WHERE match_id = ? ORDER BY steamid').all(matchId) as { steamid: string }[])
    .map((r) => r.steamid);
  return ids.filter((id) =>
    !personOf(db, 'steam', id) && !personOf(db, 'steam', resolveAlias(db, id))
    && !activeBanAt(db, id, at) && isNewAccount(db, id, at));
}

export interface SignContext {
  /** The person's Steam members. */
  members: readonly string[];
  /** From matchPersons: member accounts among the candidate's 10 nearest. */
  membersInTop10: number;
  /** False when no ASN table is loaded: then sign 1 is not counted at all.
   *  Sign 5 reads the stored tags either way. */
  asnLoaded: boolean;
  extraVpn: ReadonlySet<number>;
}

function freshIdentity(db: DB, steamid: string, atMs: number): boolean {
  const s = db.prepare('SELECT time_created, visibility FROM player_steam_signals WHERE steamid = ?').get(steamid) as
    | { time_created: number | null; visibility: number | null } | undefined;
  if (s && s.time_created !== null && atMs - s.time_created * 1000 < YOUNG_STEAM_MS) return true;
  // Weak on its own (many honest players are private): it only ever counts
  // next to a fingerprint match, which is the point of the design.
  if (s && s.visibility !== null && s.visibility !== 3) return true;
  const p = db.prepare('SELECT discord_id, created_at FROM players WHERE steamid = ?').get(steamid) as
    | { discord_id: string | null; created_at: string } | undefined;
  if (!p?.discord_id) return false;
  const born = discordCreatedMs(p.discord_id);
  if (born !== null && atMs - born < YOUNG_DISCORD_MS) return true;
  const elsewhere = db.prepare('SELECT 1 FROM discord_link_history WHERE discord_id = ? AND steamid <> ? LIMIT 1')
    .get(p.discord_id, steamid);
  const joined = dbTimeMs(p.created_at);
  return !elsewhere && joined !== null && atMs - joined < YOUNG_SITE_MS;
}

/** The second signs seen on `steamid` by `at`, in SIGN_ORDER. */
export function secondSigns(db: DB, steamid: string, ctx: SignContext, at: Date): SecondSign[] {
  const iso = at.toISOString();
  const found = new Set<SecondSign>();
  if (ctx.asnLoaded) {
    const nets = db.prepare('SELECT asn, as_org FROM player_networks WHERE player_id = ? AND first_seen <= ?')
      .all(steamid, iso) as { asn: number | null; as_org: string | null }[];
    if (nets.some((n) => isVpnNetwork(n.asn, n.as_org, ctx.extraVpn))) found.add('vpn');
  }
  if (freshIdentity(db, steamid, at.getTime())) found.add('fresh_identity');
  const cheat = db.prepare(
    `SELECT 1 FROM integrity_flags WHERE steamid = ? AND match_id IS NOT NULL AND at <= ?
       AND kind IN (${CHEAT_FLAG_KINDS.map(() => '?').join(', ')}) LIMIT 1`,
  ).get(steamid, iso, ...CHEAT_FLAG_KINDS);
  if (cheat) found.add('cheat_flag');
  if (ctx.membersInTop10 >= 2) found.add('two_members');
  if (ctx.members.length > 0) {
    // A commercial VPN exit is shared by strangers, so a hash tagged VPN or
    // hosting on any of its rows does not count (sign 1 covers it). This
    // reads the tags stored on the rows, so it holds with no ASN table
    // loaded: an untagged row (NULL asn) is "unknown", never a VPN, and
    // still counts as a shared connection.
    const hashes = (db.prepare(
      `SELECT DISTINCT a.ip_hash AS h FROM player_networks a JOIN player_networks b ON b.ip_hash = a.ip_hash
        WHERE a.player_id = ? AND a.first_seen <= ?
          AND b.player_id IN (${ctx.members.map(() => '?').join(', ')}) AND b.first_seen <= ?`,
    ).all(steamid, iso, ...ctx.members, iso) as { h: string }[]).map((r) => r.h);
    const tags = db.prepare('SELECT asn, as_org FROM player_networks WHERE ip_hash = ?');
    const vpnHash = (h: string): boolean => (tags.all(h) as { asn: number | null; as_org: string | null }[])
      .some((n) => isVpnNetwork(n.asn, n.as_org, ctx.extraVpn));
    if (hashes.some((h) => !vpnHash(h))) found.add('shared_connection');
  }
  return SIGN_ORDER.filter((s) => found.has(s));
}
