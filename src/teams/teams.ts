import type { DB } from '../db.js';
import { findSlurs } from '../slurs.js';
import { hasUnsafeChars } from '../profileFields.js';
import { settingNumber } from '../settings.js';

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
  invite_closed: { status: 410, text: 'That invite is no longer open.' },
  link_off: { status: 404, text: 'That join link is turned off or was replaced.' },
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
  if (name.length < NAME_MIN || name.length > NAME_MAX || hasUnsafeChars(name)) return fail('bad_name');
  if (findSlurs(name).length > 0) return fail('name_not_allowed');
  return { ok: true, name, key: name.toLowerCase() };
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
