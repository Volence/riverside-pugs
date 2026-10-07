import { randomBytes } from 'node:crypto';
import type { DB } from '../db.js';
import { findSlurs } from '../slurs.js';
import { DEFAULT_IGNORABLE, hasUnsafeChars } from '../profileFields.js';
import { settingNumber } from '../settings.js';
import { inGoodStanding } from '../standing.js';
import { getPlayer } from '../players.js';
import { competitiveAccess } from './access.js';

/**
 * Every rule about teams (spec part 1, section 2). The routes and the Discord
 * buttons call these and nothing else writes the three team tables, so the
 * two surfaces cannot disagree about who may do what.
 *
 * Each write is one transaction that re-checks its rules inside, so two
 * requests racing (two invites accepted at once, a kick during an accept)
 * cannot get past a cap: better-sqlite3 runs a transaction to the end before
 * the next statement from anywhere.
 */

export type TeamRole = 'captain' | 'cocaptain' | 'member';
export const ROSTER_MAX = 8;
/** Players a team needs to enter an event (spec 2 reads this). */
export const ENTRY_MIN = 4;
export const NAME_MIN = 3;
export const NAME_MAX = 24;
/** Slugs the routes use as words of their own. */
const RESERVED_SLUGS = new Set(['mine', 'join', 'logos', 'invites', 'player-search']);

export interface TeamRow {
  id: number; name: string; name_key: string; tag: string; tag_key: string; slug: string;
  logo_key: string | null; region: string; captain_steamid: string; created_by: string;
  origin: 'site' | 'draft' | 'pickup'; origin_ref: string | null; join_link_token: string | null;
  created_at: string; disbanded_at: string | null;
}
export interface MemberRow {
  id: number; team_id: number; steamid: string; role: TeamRole; joined_at: string; left_at: string | null;
}

export const TEAM_ERRORS = {
  bad_name: { status: 400, text: `A team name is ${NAME_MIN} to ${NAME_MAX} characters of plain text.` },
  bad_tag: { status: 400, text: 'A tag is 2 to 5 letters or digits.' },
  name_not_allowed: { status: 400, text: 'That name is not allowed here.' },
  tag_not_allowed: { status: 400, text: 'That tag is not allowed here.' },
  name_taken: { status: 409, text: 'Another team already has that name.' },
  tag_taken: { status: 409, text: 'Another team already has that tag.' },
  your_cap: { status: 409, text: 'You are already on as many teams as allowed. Leave one first.' },
  their_cap: { status: 409, text: 'That player is already on as many teams as allowed.' },
  created_cap: { status: 409, text: 'You have created as many teams as allowed. Disband one first.' },
  roster_full: { status: 409, text: `The roster is full (${ROSTER_MAX} players).` },
  not_found: { status: 404, text: 'No such team.' },
  not_allowed: { status: 403, text: 'Only the captain can do that.' },
  not_manager: { status: 403, text: 'Only the captain or a co-captain can do that.' },
  not_player: { status: 400, text: 'That is not an active player.' },
  not_member: { status: 400, text: 'That player is not on this team.' },
  already_member: { status: 409, text: 'Already on this team.' },
  already_invited: { status: 409, text: 'Already invited.' },
  not_open: { status: 409, text: 'That player cannot use teams yet.' },
  invite_closed: { status: 410, text: 'That invite is no longer open.' },
  link_off: { status: 404, text: 'That join link is turned off or was replaced.' },
  kicked: { status: 403, text: 'You were removed from this team. Ask the captain for an invite.' },
  is_captain: { status: 400, text: 'Hand the captaincy over first.' },
  bad_role: { status: 400, text: 'A role is cocaptain or member.' },
} as const satisfies Record<string, { status: number; text: string }>;
export type TeamError = keyof typeof TEAM_ERRORS;

export type Result<T> = { ok: true; value: T } | { ok: false; error: TeamError };
export const ok = <T>(value: T): Result<T> => ({ ok: true, value });
export const fail = (error: TeamError): { ok: false; error: TeamError } => ({ ok: false, error });

export function membershipCap(db: DB): number {
  return settingNumber(db, 'team_membership_cap', 3, { integer: true, min: 1, max: 10 });
}

export function normalizeName(raw: unknown): { ok: true; name: string; key: string } | { ok: false; error: TeamError } {
  if (typeof raw !== 'string') return fail('bad_name');
  const name = raw.normalize('NFC').trim().replace(/\s+/g, ' ');
  // At least one letter or digit: U+2800 (braille blank) and friends are not
  // default-ignorable, so a name of only those still looked blank.
  if (name.length < NAME_MIN || name.length > NAME_MAX || hasUnsafeChars(name) || DEFAULT_IGNORABLE.test(name) || !/[\p{L}\p{N}]/u.test(name)) {
    return fail('bad_name');
  }
  if (findSlurs(name).length > 0) return fail('name_not_allowed');
  // NFKC before lower-casing, so compatibility variants (full-width letters,
  // ligatures) key the same as their plain ascii form: "ＲＡＴＳ" and "rats"
  // must not be able to look like two different teams.
  return { ok: true, name, key: name.normalize('NFKC').toLowerCase() };
}

export function normalizeTag(raw: unknown): { ok: true; tag: string; key: string } | { ok: false; error: TeamError } {
  if (typeof raw !== 'string') return fail('bad_tag');
  const tag = raw.trim();
  if (!/^[A-Za-z0-9]{2,5}$/.test(tag)) return fail('bad_tag');
  if (findSlurs(tag).length > 0) return fail('tag_not_allowed');
  return { ok: true, tag, key: tag.toUpperCase() };
}

/** A URL slug from the name, unique over every team ever made, so a
 *  disbanded team's page keeps its address. Fixed at creation: a rename
 *  never breaks a link. */
function slugFor(db: DB, name: string): string {
  const base = name.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
    .slice(0, 32).replace(/-+$/, '') || 'team';
  const taken = db.prepare('SELECT 1 FROM teams WHERE slug = ?');
  if (!RESERVED_SLUGS.has(base) && !taken.get(base)) return base;
  for (let n = 2; ; n++) {
    const s = `${base}-${n}`;
    if (!taken.get(s)) return s;
  }
}

export function getTeam(db: DB, id: number): TeamRow | undefined {
  return db.prepare('SELECT * FROM teams WHERE id = ?').get(id) as TeamRow | undefined;
}

export function getTeamBySlug(db: DB, slug: string): TeamRow | undefined {
  return db.prepare('SELECT * FROM teams WHERE slug = ?').get(slug) as TeamRow | undefined;
}

export function liveTeams(db: DB): TeamRow[] {
  return db.prepare('SELECT * FROM teams WHERE disbanded_at IS NULL ORDER BY name_key').all() as TeamRow[];
}

/** Captain, then co-captains, then members; each oldest first. The first
 *  row after the captain is who takes over if the captain leaves. */
export function activeMembers(db: DB, teamId: number): MemberRow[] {
  return db.prepare(
    `SELECT * FROM team_members WHERE team_id = ? AND left_at IS NULL
     ORDER BY CASE role WHEN 'captain' THEN 0 WHEN 'cocaptain' THEN 1 ELSE 2 END, joined_at, id`,
  ).all(teamId) as MemberRow[];
}

/** Everyone who was on the team and is not now, with when they last left. */
export function formerMembers(db: DB, teamId: number): { steamid: string; left_at: string }[] {
  return db.prepare(
    `SELECT steamid, MAX(left_at) AS left_at FROM team_members
      WHERE team_id = ? AND left_at IS NOT NULL
        AND steamid NOT IN (SELECT steamid FROM team_members WHERE team_id = ? AND left_at IS NULL)
      GROUP BY steamid ORDER BY MAX(left_at) DESC`,
  ).all(teamId, teamId) as { steamid: string; left_at: string }[];
}

export function roleOf(db: DB, teamId: number, steamid: string): TeamRole | null {
  const r = db.prepare('SELECT role FROM team_members WHERE team_id = ? AND steamid = ? AND left_at IS NULL')
    .get(teamId, steamid) as { role: TeamRole } | undefined;
  return r?.role ?? null;
}

export function activeMembershipCount(db: DB, steamid: string): number {
  return (db.prepare(
    `SELECT COUNT(*) AS n FROM team_members m JOIN teams t ON t.id = m.team_id
      WHERE m.steamid = ? AND m.left_at IS NULL AND t.disbanded_at IS NULL`,
  ).get(steamid) as { n: number }).n;
}

export function rosterSize(db: DB, teamId: number): number {
  return (db.prepare('SELECT COUNT(*) AS n FROM team_members WHERE team_id = ? AND left_at IS NULL').get(teamId) as { n: number }).n;
}

function createdCount(db: DB, steamid: string): number {
  return (db.prepare('SELECT COUNT(*) AS n FROM teams WHERE created_by = ? AND disbanded_at IS NULL').get(steamid) as { n: number }).n;
}

export function canCreate(db: DB, steamid: string): boolean {
  const cap = membershipCap(db);
  return activeMembershipCount(db, steamid) < cap && createdCount(db, steamid) < cap;
}

export function myTeams(db: DB, steamid: string): (TeamRow & { role: TeamRole })[] {
  return db.prepare(
    `SELECT t.*, m.role FROM team_members m JOIN teams t ON t.id = m.team_id
      WHERE m.steamid = ? AND m.left_at IS NULL AND t.disbanded_at IS NULL ORDER BY m.joined_at, m.id`,
  ).all(steamid) as (TeamRow & { role: TeamRole })[];
}

/** A live name or tag held by a team other than `except`. */
export function nameTaken(db: DB, key: string, except = 0): boolean {
  return db.prepare('SELECT 1 FROM teams WHERE name_key = ? AND disbanded_at IS NULL AND id != ?').get(key, except) !== undefined;
}
export function tagTaken(db: DB, key: string, except = 0): boolean {
  return db.prepare('SELECT 1 FROM teams WHERE tag_key = ? AND disbanded_at IS NULL AND id != ?').get(key, except) !== undefined;
}

export function createTeam(
  db: DB, o: { creator: string; name: unknown; tag: unknown; now?: Date },
): Result<{ id: number; slug: string }> {
  const n = normalizeName(o.name);
  if (!n.ok) return n;
  const t = normalizeTag(o.tag);
  if (!t.ok) return t;
  const now = (o.now ?? new Date()).toISOString();
  return db.transaction((): Result<{ id: number; slug: string }> => {
    const cap = membershipCap(db);
    if (activeMembershipCount(db, o.creator) >= cap) return fail('your_cap');
    if (createdCount(db, o.creator) >= cap) return fail('created_cap');
    if (nameTaken(db, n.key)) return fail('name_taken');
    if (tagTaken(db, t.key)) return fail('tag_taken');
    const slug = slugFor(db, n.name);
    const id = Number(db.prepare(
      `INSERT INTO teams (name, name_key, tag, tag_key, slug, captain_steamid, created_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(n.name, n.key, t.tag, t.key, slug, o.creator, o.creator, now).lastInsertRowid);
    db.prepare("INSERT INTO team_members (team_id, steamid, role, joined_at) VALUES (?, ?, 'captain', ?)").run(id, o.creator, now);
    return ok({ id, slug });
  })();
}

export interface InviteRow {
  id: number; team_id: number; steamid: string; invited_by: string; created_at: string;
  responded_at: string | null; response: 'accepted' | 'declined' | 'cancelled' | null;
}

const isManager = (role: TeamRole | null): boolean => role === 'captain' || role === 'cocaptain';

function liveTeam(db: DB, teamId: number): TeamRow | null {
  const t = getTeam(db, teamId);
  return t && !t.disbanded_at ? t : null;
}

export function getInvite(db: DB, id: number): InviteRow | undefined {
  return db.prepare('SELECT * FROM team_invites WHERE id = ?').get(id) as InviteRow | undefined;
}

export function openInvitesOf(db: DB, teamId: number): InviteRow[] {
  return db.prepare('SELECT * FROM team_invites WHERE team_id = ? AND responded_at IS NULL ORDER BY id').all(teamId) as InviteRow[];
}

export function pendingInvitesFor(db: DB, steamid: string): (InviteRow & { slug: string; name: string; tag: string })[] {
  return db.prepare(
    `SELECT i.*, t.slug, t.name, t.tag FROM team_invites i JOIN teams t ON t.id = i.team_id
      WHERE i.steamid = ? AND i.responded_at IS NULL AND t.disbanded_at IS NULL ORDER BY i.id`,
  ).all(steamid) as (InviteRow & { slug: string; name: string; tag: string })[];
}

/** Add a player to a live team as a member, with every joining rule. Also
 *  closes any open invite they had to this team. Call inside a transaction. */
function addMember(db: DB, team: TeamRow, steamid: string, now: string): Result<null> {
  if (roleOf(db, team.id, steamid)) return fail('already_member');
  if (!getPlayer(db, steamid) || !inGoodStanding(db, steamid)) return fail('not_player');
  if (rosterSize(db, team.id) >= ROSTER_MAX) return fail('roster_full');
  if (activeMembershipCount(db, steamid) >= membershipCap(db)) return fail('your_cap');
  db.prepare("INSERT INTO team_members (team_id, steamid, role, joined_at) VALUES (?, ?, 'member', ?)").run(team.id, steamid, now);
  db.prepare("UPDATE team_invites SET responded_at = ?, response = 'accepted' WHERE team_id = ? AND steamid = ? AND responded_at IS NULL")
    .run(now, team.id, steamid);
  return ok(null);
}

export function invitePlayer(
  db: DB, o: { teamId: number; by: string; target: string; now?: Date },
): Result<{ inviteId: number }> {
  const now = (o.now ?? new Date()).toISOString();
  return db.transaction((): Result<{ inviteId: number }> => {
    const team = liveTeam(db, o.teamId);
    if (!team) return fail('not_found');
    if (!isManager(roleOf(db, team.id, o.by))) return fail('not_manager');
    if (!getPlayer(db, o.target) || !inGoodStanding(db, o.target)) return fail('not_player');
    // Admin-only mode is for trying the feature out before anyone else sees
    // it; an admin captain inviting an ordinary player must not pull them in
    // (or DM them) while the switch still keeps them out everywhere else.
    if (!competitiveAccess(db, o.target)) return fail('not_open');
    if (roleOf(db, team.id, o.target)) return fail('already_member');
    if (db.prepare('SELECT 1 FROM team_invites WHERE team_id = ? AND steamid = ? AND responded_at IS NULL').get(team.id, o.target)) {
      return fail('already_invited');
    }
    if (rosterSize(db, team.id) >= ROSTER_MAX) return fail('roster_full');
    if (activeMembershipCount(db, o.target) >= membershipCap(db)) return fail('their_cap');
    const inviteId = Number(db.prepare('INSERT INTO team_invites (team_id, steamid, invited_by, created_at) VALUES (?, ?, ?, ?)')
      .run(team.id, o.target, o.by, now).lastInsertRowid);
    return ok({ inviteId });
  })();
}

/** Accept or decline. A refusal at accept time (cap, roster) leaves the
 *  invite open, so the player can make room and accept later. */
export function respondInvite(
  db: DB, o: { inviteId: number; steamid: string; accept: boolean; now?: Date },
): Result<{ teamId: number; slug: string }> {
  const now = (o.now ?? new Date()).toISOString();
  return db.transaction((): Result<{ teamId: number; slug: string }> => {
    const inv = getInvite(db, o.inviteId);
    if (!inv || inv.steamid !== o.steamid) return fail('not_found');
    if (inv.responded_at) return fail('invite_closed');
    const team = liveTeam(db, inv.team_id);
    if (!team) {
      db.prepare("UPDATE team_invites SET responded_at = ?, response = 'cancelled' WHERE id = ?").run(now, inv.id);
      return fail('invite_closed');
    }
    if (!o.accept) {
      db.prepare("UPDATE team_invites SET responded_at = ?, response = 'declined' WHERE id = ?").run(now, inv.id);
      return ok({ teamId: team.id, slug: team.slug });
    }
    const added = addMember(db, team, o.steamid, now);
    if (!added.ok) return added;
    return ok({ teamId: team.id, slug: team.slug });
  })();
}

/** Whether this team already invited `steamid` within the 24 hours before
 *  `before` (an ISO timestamp), counting any row but `exceptId`: declared,
 *  responded or cancelled all still count as an invite that was sent. Used to
 *  cap the Discord DM, not the invite itself: a captain can still invite,
 *  cancel and invite again on the site as often as the rules otherwise allow,
 *  this only decides whether that invite also pings the target's DMs. */
export function invitedRecently(db: DB, teamId: number, steamid: string, before: string, exceptId: number): boolean {
  const cutoff = new Date(new Date(before).getTime() - 24 * 60 * 60 * 1000).toISOString();
  return db.prepare(
    'SELECT 1 FROM team_invites WHERE team_id = ? AND steamid = ? AND id != ? AND created_at >= ? AND created_at <= ?',
  ).get(teamId, steamid, exceptId, cutoff, before) !== undefined;
}

export function cancelInvite(db: DB, o: { inviteId: number; by: string; now?: Date }): Result<null> {
  const now = (o.now ?? new Date()).toISOString();
  return db.transaction((): Result<null> => {
    const inv = getInvite(db, o.inviteId);
    if (!inv || inv.responded_at) return fail('invite_closed');
    if (!isManager(roleOf(db, inv.team_id, o.by))) return fail('not_manager');
    db.prepare("UPDATE team_invites SET responded_at = ?, response = 'cancelled' WHERE id = ?").run(now, inv.id);
    return ok(null);
  })();
}

/** On: a fresh random token (replacing any old one). Off: none. Captain only. */
export function setJoinLink(db: DB, o: { teamId: number; by: string; on: boolean }): Result<{ token: string | null }> {
  return db.transaction((): Result<{ token: string | null }> => {
    const team = liveTeam(db, o.teamId);
    if (!team) return fail('not_found');
    if (roleOf(db, team.id, o.by) !== 'captain') return fail('not_allowed');
    const token = o.on ? randomBytes(16).toString('base64url') : null;
    db.prepare('UPDATE teams SET join_link_token = ? WHERE id = ?').run(token, team.id);
    return ok({ token });
  })();
}

export function teamByJoinToken(db: DB, token: string): TeamRow | undefined {
  return db.prepare('SELECT * FROM teams WHERE join_link_token = ? AND disbanded_at IS NULL').get(token) as TeamRow | undefined;
}

export function joinByLink(db: DB, o: { token: string; steamid: string; now?: Date }): Result<{ slug: string }> {
  const now = (o.now ?? new Date()).toISOString();
  return db.transaction((): Result<{ slug: string }> => {
    const team = teamByJoinToken(db, o.token);
    if (!team) return fail('link_off');
    // A link shared in Discord stays on after a kick; the kicked player must
    // not be able to walk straight back in. Only their latest exit counts, so
    // someone re-invited after a kick who later leaves on their own may.
    const last = db.prepare('SELECT left_reason FROM team_members WHERE team_id = ? AND steamid = ? ORDER BY id DESC LIMIT 1')
      .get(team.id, o.steamid) as { left_reason: string | null } | undefined;
    if (last?.left_reason === 'kicked') return fail('kicked');
    const added = addMember(db, team, o.steamid, now);
    if (!added.ok) return added;
    return ok({ slug: team.slug });
  })();
}

/** Close a team: every membership, open invite and the join link. Call
 *  inside a transaction. */
function closeTeam(db: DB, teamId: number, now: string): void {
  db.prepare('UPDATE teams SET disbanded_at = ?, join_link_token = NULL WHERE id = ?').run(now, teamId);
  db.prepare('UPDATE team_members SET left_at = ? WHERE team_id = ? AND left_at IS NULL').run(now, teamId);
  db.prepare("UPDATE team_invites SET responded_at = ?, response = 'cancelled' WHERE team_id = ? AND responded_at IS NULL").run(now, teamId);
}

/** After someone left: disband an empty team, or give a captainless one to
 *  the first in activeMembers order (earliest co-captain, else earliest
 *  member). Call inside a transaction. */
function settleCaptaincy(db: DB, teamId: number, now: string): { disbanded: boolean; captain: string | null } {
  const members = activeMembers(db, teamId);
  if (members.length === 0) {
    closeTeam(db, teamId, now);
    return { disbanded: true, captain: null };
  }
  const current = members.find((m) => m.role === 'captain');
  if (current) return { disbanded: false, captain: current.steamid };
  const next = members[0];
  db.prepare("UPDATE team_members SET role = 'captain' WHERE id = ?").run(next.id);
  db.prepare('UPDATE teams SET captain_steamid = ? WHERE id = ?').run(next.steamid, teamId);
  return { disbanded: false, captain: next.steamid };
}

export function leaveTeam(
  db: DB, o: { teamId: number; steamid: string; now?: Date },
): Result<{ disbanded: boolean; captain: string | null }> {
  const now = (o.now ?? new Date()).toISOString();
  return db.transaction((): Result<{ disbanded: boolean; captain: string | null }> => {
    const team = liveTeam(db, o.teamId);
    if (!team) return fail('not_found');
    if (!roleOf(db, team.id, o.steamid)) return fail('not_member');
    db.prepare('UPDATE team_members SET left_at = ? WHERE team_id = ? AND steamid = ? AND left_at IS NULL').run(now, team.id, o.steamid);
    return ok(settleCaptaincy(db, team.id, now));
  })();
}

export function kickMember(
  db: DB, o: { teamId: number; by: string; target: string; now?: Date },
): Result<{ disbanded: boolean; captain: string | null }> {
  const now = (o.now ?? new Date()).toISOString();
  return db.transaction((): Result<{ disbanded: boolean; captain: string | null }> => {
    const team = liveTeam(db, o.teamId);
    if (!team) return fail('not_found');
    const mine = roleOf(db, team.id, o.by);
    if (!isManager(mine)) return fail('not_manager');
    const theirs = roleOf(db, team.id, o.target);
    if (!theirs) return fail('not_member');
    if (theirs === 'captain') return fail(o.target === o.by ? 'is_captain' : 'not_allowed');
    if (mine === 'cocaptain' && theirs !== 'member') return fail('not_allowed');
    db.prepare("UPDATE team_members SET left_at = ?, left_reason = 'kicked' WHERE team_id = ? AND steamid = ? AND left_at IS NULL").run(now, team.id, o.target);
    return ok(settleCaptaincy(db, team.id, now));
  })();
}

export function setRole(db: DB, o: { teamId: number; by: string; target: string; role: unknown }): Result<null> {
  if (o.role !== 'cocaptain' && o.role !== 'member') return fail('bad_role');
  const role = o.role;
  return db.transaction((): Result<null> => {
    const team = liveTeam(db, o.teamId);
    if (!team) return fail('not_found');
    if (roleOf(db, team.id, o.by) !== 'captain') return fail('not_allowed');
    const theirs = roleOf(db, team.id, o.target);
    if (!theirs) return fail('not_member');
    if (theirs === 'captain') return fail('is_captain');
    db.prepare('UPDATE team_members SET role = ? WHERE team_id = ? AND steamid = ? AND left_at IS NULL').run(role, team.id, o.target);
    return ok(null);
  })();
}

export function transferCaptain(db: DB, o: { teamId: number; by: string; target: string; staff?: boolean }): Result<null> {
  return db.transaction((): Result<null> => {
    const team = liveTeam(db, o.teamId);
    if (!team) return fail('not_found');
    if (!o.staff && roleOf(db, team.id, o.by) !== 'captain') return fail('not_allowed');
    const theirs = roleOf(db, team.id, o.target);
    if (!theirs) return fail('not_member');
    if (theirs === 'captain') return ok(null);
    db.prepare("UPDATE team_members SET role = 'cocaptain' WHERE team_id = ? AND role = 'captain' AND left_at IS NULL").run(team.id);
    db.prepare("UPDATE team_members SET role = 'captain' WHERE team_id = ? AND steamid = ? AND left_at IS NULL").run(team.id, o.target);
    db.prepare('UPDATE teams SET captain_steamid = ? WHERE id = ?').run(o.target, team.id);
    return ok(null);
  })();
}

export function renameTeam(
  db: DB, o: { teamId: number; by: string; staff?: boolean; name?: unknown; tag?: unknown },
): Result<{ name: string; tag: string }> {
  return db.transaction((): Result<{ name: string; tag: string }> => {
    const team = liveTeam(db, o.teamId);
    if (!team) return fail('not_found');
    if (!o.staff && roleOf(db, team.id, o.by) !== 'captain') return fail('not_allowed');
    let name = team.name, nameKey = team.name_key, tag = team.tag, tagKey = team.tag_key;
    if (o.name !== undefined) {
      const n = normalizeName(o.name);
      if (!n.ok) return n;
      if (nameTaken(db, n.key, team.id)) return fail('name_taken');
      name = n.name; nameKey = n.key;
    }
    if (o.tag !== undefined) {
      const t = normalizeTag(o.tag);
      if (!t.ok) return t;
      if (tagTaken(db, t.key, team.id)) return fail('tag_taken');
      tag = t.tag; tagKey = t.key;
    }
    db.prepare('UPDATE teams SET name = ?, name_key = ?, tag = ?, tag_key = ? WHERE id = ?').run(name, nameKey, tag, tagKey, team.id);
    return ok({ name, tag });
  })();
}

export function disbandTeam(db: DB, o: { teamId: number; by: string; staff?: boolean; now?: Date }): Result<null> {
  const now = (o.now ?? new Date()).toISOString();
  return db.transaction((): Result<null> => {
    const team = liveTeam(db, o.teamId);
    if (!team) return fail('not_found');
    if (!o.staff && roleOf(db, team.id, o.by) !== 'captain') return fail('not_allowed');
    closeTeam(db, team.id, now);
    return ok(null);
  })();
}

export function setLogoKey(db: DB, o: { teamId: number; by: string; staff?: boolean; logoKey: string | null }): Result<null> {
  return db.transaction((): Result<null> => {
    const team = liveTeam(db, o.teamId);
    if (!team) return fail('not_found');
    if (!o.staff && !isManager(roleOf(db, team.id, o.by))) return fail('not_manager');
    db.prepare('UPDATE teams SET logo_key = ? WHERE id = ?').run(o.logoKey, team.id);
    return ok(null);
  })();
}
