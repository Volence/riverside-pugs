import type { DB } from '../db.js';
import { resolveAlias } from '../aliases.js';
import { getPlayer } from '../players.js';
import { getTeam, myTeams, roleOf } from '../teams/teams.js';
import { canUse } from '../bookings/bookings.js';
import type { Party } from '../bookings/rules.js';

/**
 * Scrim blocks (scrim blocks plan). A party (a team, managed by its captain
 * and co-captains, or a pickup captain for themselves) blocks a team or a
 * player, and the pair never meet through the scrim system: blocked() is
 * asked at every place two sides meet (the board, a challenge, an accept, a
 * confirm, a booking) and answers in both directions.
 *
 * A player block (Ruling 2) matches a pickup side that player captains, or a
 * team in which they are captain or co-captain RIGHT NOW. A plain member is
 * never matched, or blocking one person would cut off every team they join.
 *
 * Silent (Ruling 4): nothing here is ever sent to the blocked side. The
 * meeting points refuse with the one generic not_available.
 *
 * This module must not import src/scrims/scrims.ts: scrims.ts and
 * bookings.ts both import blocked() from here, and scrims.ts spreads
 * BOOKING_ERRORS at load, so a cycle through it could read that before it
 * exists. The few lines it shares with scrims.ts (the manager rule, reopening
 * an idle post) are repeated below instead.
 */

/** Who blocks: the same shape as a booking party. */
export type BlockParty = Party;
export type BlockTarget = { teamId: number } | { steamid: string };
export type BlockTargetView = { kind: 'team'; id: number; name: string; tag: string } | { kind: 'player'; steamid: string; name: string };
export interface BlockEntry { target: BlockTargetView; createdAt: string }

/** Ruling 6: blocks one party may hold. */
export const BLOCK_MAX = 100;

export const BLOCK_ERRORS = {
  not_open: { status: 409, text: 'That player cannot use scrims yet.' },
  not_found: { status: 404, text: 'No such team or player.' },
  not_manager: { status: 403, text: 'Only a captain or co-captain of that side can do that.' },
  bad_target: { status: 400, text: 'Pick a team or a player.' },
  bad_block: { status: 400, text: 'A side cannot block itself or a team it belongs to.' },
  too_many_blocks: { status: 409, text: `A side can block at most ${BLOCK_MAX} teams and players. Unblock one first.` },
} as const satisfies Record<string, { status: number; text: string }>;
export type BlockError = keyof typeof BLOCK_ERRORS;
export type BlockResult<T> = { ok: true; value: T } | { ok: false; error: BlockError };
const ok = <T>(value: T): BlockResult<T> => ({ ok: true, value });
const fail = (error: BlockError): { ok: false; error: BlockError } => ({ ok: false, error });

interface BlockRow {
  id: number; blocker_team_id: number | null; blocker_steamid: string | null;
  target_team_id: number | null; target_steamid: string | null; created_by: string; created_at: string;
}
type SideRef = { team_id: number | null; captain_steamid: string };

const isManagerRole = (r: string | null): boolean => r === 'captain' || r === 'cocaptain';
const partyOf = (s: SideRef): BlockParty => (s.team_id !== null ? { teamId: s.team_id } : { captain: s.captain_steamid });

function blockerWhere(party: BlockParty): { sql: string; arg: number | string } {
  return 'teamId' in party ? { sql: 'blocker_team_id = ?', arg: party.teamId } : { sql: 'blocker_steamid = ?', arg: party.captain };
}
/** A post's or acceptance's side columns, as one party. */
function sideWhere(party: BlockParty, alias: string): { sql: string; arg: number | string } {
  return 'teamId' in party
    ? { sql: `${alias}.team_id = ?`, arg: party.teamId }
    : { sql: `${alias}.team_id IS NULL AND ${alias}.captain_steamid = ?`, arg: party.captain };
}

/** Whether `blocker` holds a block that matches party `other` (Ruling 2). */
function blocks(db: DB, blocker: BlockParty, other: BlockParty): boolean {
  const w = blockerWhere(blocker);
  const row = 'teamId' in other
    ? db.prepare(
      `SELECT 1 FROM scrim_blocks WHERE ${w.sql} AND (target_team_id = ? OR target_steamid IN (
         SELECT steamid FROM team_members WHERE team_id = ? AND left_at IS NULL AND role IN ('captain','cocaptain')))
       LIMIT 1`,
    ).get(w.arg, other.teamId, other.teamId)
    : db.prepare(`SELECT 1 FROM scrim_blocks WHERE ${w.sql} AND target_steamid = ? LIMIT 1`).get(w.arg, other.captain);
  return row !== undefined;
}

/** True if either party blocks the other. */
export function blocked(db: DB, a: BlockParty, b: BlockParty): boolean {
  return blocks(db, a, b) || blocks(db, b, a);
}

/** Whether one target matches a party (Ruling 2), in code, for the
 *  withdrawals a new block makes. The same rule as blocks()' SQL. */
function targetMatches(db: DB, t: BlockTarget, party: BlockParty): boolean {
  if ('teamId' in t) return 'teamId' in party && party.teamId === t.teamId;
  return 'teamId' in party ? isManagerRole(roleOf(db, party.teamId, t.steamid)) : party.captain === t.steamid;
}

/** The party's own check, the same rule managesScrimSide applies to a post:
 *  a live team's current captain or co-captain, or the pickup captain. */
function checkParty(db: DB, party: unknown, by: string): BlockResult<BlockParty> {
  if (typeof party !== 'object' || party === null) return fail('not_found');
  const p = party as Record<string, unknown>;
  if ('teamId' in p) {
    if (!Number.isInteger(p.teamId)) return fail('not_found');
    const team = getTeam(db, p.teamId as number);
    if (!team || team.disbanded_at) return fail('not_found');
    if (!isManagerRole(roleOf(db, team.id, by))) return fail('not_manager');
    return ok({ teamId: team.id });
  }
  if (typeof p.captain !== 'string') return fail('not_found');
  if (p.captain !== by) return fail('not_manager');
  return ok({ captain: by });
}

/** Whether `by` manages this party, for the list route's 404. */
export function managesBlockParty(db: DB, party: BlockParty, by: string): boolean {
  return checkParty(db, party, by).ok;
}

function parseTarget(raw: unknown): BlockTarget | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Record<string, unknown>;
  if (Number.isInteger(r.teamId)) return { teamId: r.teamId as number };
  if (typeof r.steamid === 'string' && /^\d{17}$/.test(r.steamid)) return { steamid: r.steamid };
  return null;
}

function targetCols(t: BlockTarget): [number | null, string | null] {
  return 'teamId' in t ? [t.teamId, null] : [null, t.steamid];
}
function findBlock(db: DB, party: BlockParty, t: BlockTarget): BlockRow | undefined {
  const w = blockerWhere(party);
  const [team, steamid] = targetCols(t);
  return db.prepare(
    `SELECT * FROM scrim_blocks WHERE ${w.sql} AND target_team_id IS ? AND target_steamid IS ?`,
  ).get(w.arg, team, steamid) as BlockRow | undefined;
}

/** As scrims.ts: once nothing is left pending on a pending post, it is open again. */
function reopenIfIdle(db: DB, postId: number): void {
  db.prepare(
    `UPDATE scrim_posts SET status = 'open' WHERE id = ? AND status = 'pending'
       AND NOT EXISTS (SELECT 1 FROM scrim_accepts WHERE post_id = scrim_posts.id AND status = 'pending')`,
  ).run(postId);
}

/**
 * Ruling 5, inside blockTarget's transaction: on the blocker's open or
 * pending posts, every pending acceptance by a side the target matches is
 * declined (its id comes back, for the usual scrim_declined DM, which names
 * no block); the blocker's own pending acceptances of posts by a side the
 * target matches are withdrawn, with no notice. Bookings are not touched.
 */
function closePending(db: DB, party: BlockParty, t: BlockTarget, now: Date): number[] {
  const at = now.toISOString();
  const touched = new Set<number>();
  const declined: number[] = [];
  const own = sideWhere(party, 'p');
  const onMine = db.prepare(
    `SELECT a.id, a.post_id, a.team_id, a.captain_steamid FROM scrim_accepts a JOIN scrim_posts p ON p.id = a.post_id
      WHERE a.status = 'pending' AND p.status IN ('open','pending') AND ${own.sql} ORDER BY a.id`,
  ).all(own.arg) as (SideRef & { id: number; post_id: number })[];
  for (const a of onMine) {
    if (!targetMatches(db, t, partyOf(a))) continue;
    db.prepare("UPDATE scrim_accepts SET status = 'declined', responded_at = ? WHERE id = ?").run(at, a.id);
    declined.push(a.id);
    touched.add(a.post_id);
  }
  const mine = sideWhere(party, 'a');
  const onTheirs = db.prepare(
    `SELECT a.id, a.post_id, p.team_id, p.captain_steamid FROM scrim_accepts a JOIN scrim_posts p ON p.id = a.post_id
      WHERE a.status = 'pending' AND ${mine.sql} ORDER BY a.id`,
  ).all(mine.arg) as (SideRef & { id: number; post_id: number })[];
  for (const a of onTheirs) {
    if (!targetMatches(db, t, partyOf(a))) continue;
    db.prepare("UPDATE scrim_accepts SET status = 'withdrawn', responded_at = ? WHERE id = ?").run(at, a.id);
    touched.add(a.post_id);
  }
  for (const id of touched) reopenIfIdle(db, id);
  return declined;
}

/**
 * Block a team or a player for a party. Blocking the same target twice is a
 * no-op success (added false, nothing withdrawn); a party never blocks
 * itself, a team it belongs to, or (for a team) one of its own members,
 * which would block the team through them; at most BLOCK_MAX per party.
 * declinedAcceptIds are the acceptances Ruling 5 declined, for the route's
 * scrim_declined DMs.
 */
export function blockTarget(db: DB, o: {
  by: string; party: BlockParty; target: unknown; now?: Date;
}): BlockResult<{ added: boolean; declinedAcceptIds: number[] }> {
  const now = o.now ?? new Date();
  if (!canUse(db, o.by)) return fail('not_open');
  const parsed = parseTarget(o.target);
  if (!parsed) return fail('bad_target');
  return db.transaction((): BlockResult<{ added: boolean; declinedAcceptIds: number[] }> => {
    const party = checkParty(db, o.party, o.by);
    if (!party.ok) return party;
    const p = party.value;
    let t: BlockTarget;
    if ('teamId' in parsed) {
      const team = getTeam(db, parsed.teamId);
      if (!team || team.disbanded_at) return fail('not_found');
      t = { teamId: team.id };
      if ('teamId' in p ? p.teamId === team.id : roleOf(db, team.id, p.captain) !== null) return fail('bad_block');
    } else {
      const steamid = resolveAlias(db, parsed.steamid);
      if (!getPlayer(db, steamid)) return fail('not_found');
      t = { steamid };
      if ('teamId' in p ? roleOf(db, p.teamId, steamid) !== null : p.captain === steamid) return fail('bad_block');
    }
    if (findBlock(db, p, t)) return ok({ added: false, declinedAcceptIds: [] });
    const w = blockerWhere(p);
    const count = (db.prepare(`SELECT COUNT(*) AS n FROM scrim_blocks WHERE ${w.sql}`).get(w.arg) as { n: number }).n;
    if (count >= BLOCK_MAX) return fail('too_many_blocks');
    const [team, steamid] = targetCols(t);
    db.prepare(
      `INSERT INTO scrim_blocks (blocker_team_id, blocker_steamid, target_team_id, target_steamid, created_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run('teamId' in p ? p.teamId : null, 'captain' in p ? p.captain : null, team, steamid, o.by, now.toISOString());
    return ok({ added: true, declinedAcceptIds: closePending(db, p, t, now) });
  })();
}

/** Remove a block. A target that is not blocked (or no longer exists) is
 *  removed false, not an error. */
export function unblock(db: DB, o: { by: string; party: BlockParty; target: unknown }): BlockResult<{ removed: boolean }> {
  const parsed = parseTarget(o.target);
  if (!parsed) return fail('bad_target');
  return db.transaction((): BlockResult<{ removed: boolean }> => {
    const party = checkParty(db, o.party, o.by);
    if (!party.ok) return party;
    const t = 'steamid' in parsed ? { steamid: resolveAlias(db, parsed.steamid) } : parsed;
    const row = findBlock(db, party.value, t);
    if (!row) return ok({ removed: false });
    db.prepare('DELETE FROM scrim_blocks WHERE id = ?').run(row.id);
    return ok({ removed: true });
  })();
}

/** A party's blocks, newest first, for its managers and for staff. */
export function blocksOf(db: DB, party: BlockParty): BlockEntry[] {
  const w = blockerWhere(party);
  const rows = db.prepare(`SELECT * FROM scrim_blocks WHERE ${w.sql} ORDER BY created_at DESC, id DESC`).all(w.arg) as BlockRow[];
  return rows.map((r) => {
    if (r.target_team_id !== null) {
      const team = getTeam(db, r.target_team_id);
      return { target: { kind: 'team', id: r.target_team_id, name: team?.name ?? 'A team', tag: team?.tag ?? '' }, createdAt: r.created_at };
    }
    const steamid = r.target_steamid!;
    return { target: { kind: 'player', steamid, name: getPlayer(db, steamid)?.name ?? 'Someone' }, createdAt: r.created_at };
  });
}

/** A player's blocks for the staff People desk: theirs as a pickup captain,
 *  and each current team's. Staff only; read-only. */
export interface ScrimBlocks {
  pickup: BlockEntry[];
  teams: { teamId: number; slug: string; name: string; tag: string; blocks: BlockEntry[] }[];
}

export function scrimBlocksOf(db: DB, steamid: string): ScrimBlocks {
  return {
    pickup: blocksOf(db, { captain: steamid }),
    teams: myTeams(db, steamid).map((t) => ({ teamId: t.id, slug: t.slug, name: t.name, tag: t.tag, blocks: blocksOf(db, { teamId: t.id }) })),
  };
}
