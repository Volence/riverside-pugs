import type { DB } from '../db.js';

/**
 * The community tables' queries, kept pure (a db in, rows out) so the routes
 * stay thin and the rules here can be tested without HTTP.
 *
 * Nothing that lists entries ever selects a HUD's payload: a design can be
 * 2 MB, and a page of 24 of them would be most of 50 MB for a gallery that
 * shows only previews. A crosshair's payload is its art, a few hundred bytes
 * (100 KB at the very most), and the gallery draws it live, so lists carry it.
 */

export type EntryKind = 'hud' | 'crosshair';
export const ENTRY_KINDS: readonly EntryKind[] = ['hud', 'crosshair'];
export const PAGE_SIZE = 24;
export const MAX_PAGE = 100;

export interface EntryAuthor { steamid: string; name: string; avatar: string | null }

export interface EntrySummary {
  id: number;
  kind: EntryKind;
  title: string;
  description: string;
  author: EntryAuthor;
  likes: number;
  likedByMe: boolean;
  createdAt: string;
  /** When its author last replaced it with a newer version; null if never. */
  updatedAt: string | null;
  /** Crosshairs only: the CrosshairArt, drawn live by the gallery. */
  art?: unknown;
  /** HUDs only. */
  preset?: string | null;
  aspect?: string | null;
  advanced?: boolean;
  importName?: string | null;
  previewUrl?: string | null;
  /** HUDs only: the infected side's preview; null on entries shared before there was one. */
  previewInfectedUrl?: string | null;
}

export interface EntryDetail extends EntrySummary {
  /** HUDs only: the stored design JSON, parsed. Null once purged. */
  design?: unknown;
  importId?: string | null;
  /** Staff only, on a tombstone. */
  removed?: { by: string | null; byName: string | null; reason: string | null; at: string };
  /** Staff only: the versions an update replaced, newest first, each a tombstone they can open. */
  versions?: { id: number; replacedAt: string }[];
  /** Staff only, on a replaced version: the live entry it was a version of. */
  versionOf?: number | null;
}

export interface MineEntry extends EntrySummary {
  /** The staff reason when staff removed it; null for a live entry. */
  removedByStaff: string | null;
}

interface Row {
  id: number; kind: EntryKind; author_id: string; title: string; description: string; payload: string;
  preset: string | null; aspect: string | null; advanced: number; import_id: string | null;
  import_name: string | null; preview: string | null; preview_infected: string | null; created_at: string; updated_at: string | null;
  deleted_at: string | null; version_of: number | null;
  deleted_by: string | null; delete_reason: string | null;
  name: string; avatar: string | null; likes: number; liked: number;
}

// Every read goes through these columns. The payload is selected only for
// crosshairs (CASE), so a list query never reads a design off disk pages.
const COLUMNS = (payload: 'crosshair-only' | 'all') => `
  e.id, e.kind, e.author_id, e.title, e.description,
  ${payload === 'all' ? 'e.payload' : "CASE WHEN e.kind = 'crosshair' THEN e.payload ELSE '' END AS payload"},
  e.preset, e.aspect, e.advanced, e.import_id, e.import_name, e.preview, e.preview_infected, e.created_at,
  e.updated_at, e.deleted_at, e.deleted_by, e.delete_reason, e.version_of,
  p.name, p.avatar,
  (SELECT COUNT(*) FROM community_likes l WHERE l.entry_id = e.id) AS likes,
  EXISTS (SELECT 1 FROM community_likes l WHERE l.entry_id = e.id AND l.player_id = @viewer) AS liked`;

/**
 * Whether the author (players p, of entry e) is banned, as src/standing.ts
 * answers it: status says so, or the bans table holds an active ban. The
 * table is the authority and status only its cached consequence, kept in
 * step by the reaper up to a minute late, so both are asked. The same WHERE
 * as hasActiveBan (banState.ts), against @now. Merged accounts need no
 * check: mergePlayers moves an alt's entries to the main.
 */
const AUTHOR_BANNED = `(p.status = 'banned' OR EXISTS (SELECT 1 FROM bans b WHERE b.player_id = e.author_id
  AND b.lifted_at IS NULL AND (b.expires_at IS NULL OR b.expires_at > @now)))`;
/** What anyone but staff may see: a live entry by an author who is not banned. */
const VISIBLE = `e.deleted_at IS NULL AND NOT ${AUTHOR_BANNED}`;

function parse(json: string): unknown {
  if (!json) return null;
  try { return JSON.parse(json); } catch { return null; }
}

export function previewUrl(sha: string | null): string | null {
  return sha ? `/api/community/files/previews/${sha}.png` : null;
}

function summary(r: Row): EntrySummary {
  const base: EntrySummary = {
    id: r.id, kind: r.kind, title: r.title, description: r.description,
    author: { steamid: r.author_id, name: r.name, avatar: r.avatar },
    likes: r.likes, likedByMe: r.liked === 1, createdAt: r.created_at, updatedAt: r.updated_at,
  };
  if (r.kind === 'crosshair') return { ...base, art: parse(r.payload) };
  return {
    ...base, preset: r.preset, aspect: r.aspect, advanced: r.advanced === 1,
    importName: r.import_name, previewUrl: previewUrl(r.preview),
    previewInfectedUrl: previewUrl(r.preview_infected),
  };
}

export interface ListOpts {
  kind: EntryKind;
  sort: 'new' | 'top';
  page: number;
  author?: string | null;
  /** Only the entries the viewer liked (needs a viewer). */
  liked?: boolean;
  viewer: string | null;
  now?: Date;
}

/** A page of live entries by authors who are not banned. Top is by likes,
 *  newest first on a tie. */
export function listEntries(db: DB, o: ListOpts): { entries: EntrySummary[]; page: number; pageSize: number; total: number } {
  const page = Math.min(MAX_PAGE, Math.max(0, Math.floor(o.page) || 0));
  const where = `e.kind = @kind AND ${VISIBLE}
    ${o.author ? 'AND e.author_id = @author' : ''}
    ${o.liked ? 'AND EXISTS (SELECT 1 FROM community_likes l WHERE l.entry_id = e.id AND l.player_id = @viewer)' : ''}`;
  const now = (o.now ?? new Date()).toISOString();
  const params = { kind: o.kind, author: o.author ?? null, viewer: o.viewer ?? '', now };
  const order = o.sort === 'top' ? 'likes DESC, e.id DESC' : 'e.id DESC';
  const rows = db.prepare(
    `SELECT ${COLUMNS('crosshair-only')} FROM community_entries e JOIN players p ON p.steamid = e.author_id
      WHERE ${where} ORDER BY ${order} LIMIT @limit OFFSET @offset`,
  ).all({ ...params, limit: PAGE_SIZE, offset: page * PAGE_SIZE }) as Row[];
  const { n } = db.prepare(
    `SELECT COUNT(*) AS n FROM community_entries e JOIN players p ON p.steamid = e.author_id WHERE ${where}`,
  ).get({ kind: params.kind, author: params.author, viewer: params.viewer, now }) as { n: number };
  return { entries: rows.map(summary), page, pageSize: PAGE_SIZE, total: n };
}

/**
 * One entry with its payload. A tombstone, or an entry by a banned author,
 * comes back only when `staff` is set, and a tombstone then says who removed
 * it and why.
 */
export function getEntry(db: DB, id: number, o: { viewer: string | null; staff: boolean; now?: Date }): EntryDetail | null {
  const r = db.prepare(
    `SELECT ${COLUMNS('all')}, ${VISIBLE} AS visible
       FROM community_entries e JOIN players p ON p.steamid = e.author_id WHERE e.id = @id`,
  ).get({ id, viewer: o.viewer ?? '', now: (o.now ?? new Date()).toISOString() }) as (Row & { visible: number }) | undefined;
  if (!r) return null;
  if (!o.staff && r.visible !== 1) return null;
  const out: EntryDetail = summary(r);
  if (r.kind === 'hud') {
    out.design = parse(r.payload);
    out.importId = r.import_id;
  }
  if (r.deleted_at !== null) {
    const who = r.deleted_by
      ? (db.prepare('SELECT name FROM players WHERE steamid = ?').get(r.deleted_by) as { name: string } | undefined)
      : undefined;
    out.removed = { by: r.deleted_by, byName: who?.name ?? null, reason: r.delete_reason, at: r.deleted_at };
  }
  if (o.staff) {
    out.versions = (db.prepare('SELECT id, deleted_at AS replacedAt FROM community_entries WHERE version_of = ? ORDER BY id DESC')
      .all(r.id) as { id: number; replacedAt: string }[]);
    out.versionOf = r.version_of;
  }
  return out;
}

/** A live entry by an author who is not banned, as getEntry shows it to
 *  anyone but staff, without the payload: for the like route. */
export function visibleEntryRow(db: DB, id: number, now = new Date()): { id: number; author_id: string } | null {
  return (db.prepare(
    `SELECT e.id, e.author_id FROM community_entries e JOIN players p ON p.steamid = e.author_id
      WHERE e.id = @id AND ${VISIBLE}`,
  ).get({ id, now: now.toISOString() }) as { id: number; author_id: string } | undefined) ?? null;
}

/** The raw row, for the routes' ownership checks. */
export function entryRow(db: DB, id: number): { id: number; kind: EntryKind; author_id: string; title: string; deleted_at: string | null } | null {
  return (db.prepare('SELECT id, kind, author_id, title, deleted_at FROM community_entries WHERE id = ?').get(id) as
    { id: number; kind: EntryKind; author_id: string; title: string; deleted_at: string | null } | undefined) ?? null;
}

/**
 * A player's own entries: every live one, plus those staff removed, with the
 * reason, so the author learns why one went. Their own deletes are left out:
 * they know. Not filtered on ban status, so the author always sees their own.
 */
export function mineEntries(db: DB, steamid: string): MineEntry[] {
  const rows = db.prepare(
    `SELECT ${COLUMNS('crosshair-only')} FROM community_entries e JOIN players p ON p.steamid = e.author_id
      WHERE e.author_id = @me AND (e.deleted_at IS NULL OR e.deleted_by IS NOT e.author_id)
      ORDER BY e.id DESC`,
  ).all({ me: steamid, viewer: steamid }) as Row[];
  return rows.map((r) => ({ ...summary(r), removedByStaff: r.deleted_at !== null ? (r.delete_reason ?? '') : null }));
}

export function countLive(db: DB, author: string, kind: EntryKind): number {
  return (db.prepare('SELECT COUNT(*) AS n FROM community_entries WHERE author_id = ? AND kind = ? AND deleted_at IS NULL')
    .get(author, kind) as { n: number }).n;
}

/** Shares since `since`, deleted ones included, so delete-and-reshare still counts. */
export function sharesSince(db: DB, author: string, since: Date): number {
  return (db.prepare('SELECT COUNT(*) AS n FROM community_entries WHERE author_id = ? AND created_at > ?')
    .get(author, since.toISOString()) as { n: number }).n;
}

export interface NewEntry {
  kind: EntryKind;
  authorId: string;
  title: string;
  description: string;
  payload: string;
  preset?: string | null;
  aspect?: string | null;
  advanced?: boolean;
  importId?: string | null;
  importName?: string | null;
  preview?: string | null;
  previewInfected?: string | null;
  bytes: number;
  createdAt: Date;
}

export function insertEntry(db: DB, e: NewEntry): number {
  return Number(db.prepare(
    `INSERT INTO community_entries
       (kind, author_id, title, description, payload, preset, aspect, advanced, import_id, import_name, preview,
        preview_infected, bytes, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    e.kind, e.authorId, e.title, e.description, e.payload, e.preset ?? null, e.aspect ?? null,
    e.advanced ? 1 : 0, e.importId ?? null, e.importName ?? null, e.preview ?? null, e.previewInfected ?? null, e.bytes,
    e.createdAt.toISOString(),
  ).lastInsertRowid);
}

/** What an update replaces: everything a share sets but its kind, author and first date. */
export type Replacement = Omit<NewEntry, 'kind' | 'authorId' | 'createdAt'>;

export const REPLACED_REASON = 'Replaced by its author with a newer version.';

/**
 * An author's update of their live entry `id`, in place, so its link and
 * likes stay. The version it replaces is first copied into a tombstone
 * (deleted by the author, version_of = id, created now so it counts toward
 * the day's shares, as a delete-and-reshare would), which keeps it, and its
 * files, for a report made before the update. Run inside the caller's
 * transaction. False when the entry is not live.
 */
export function replaceEntry(db: DB, id: number, e: Replacement, now: Date): boolean {
  const at = now.toISOString();
  const archived = db.prepare(
    `INSERT INTO community_entries
       (kind, author_id, title, description, payload, preset, aspect, advanced, import_id, import_name, preview,
        preview_infected, bytes, created_at, deleted_at, deleted_by, delete_reason, version_of)
     SELECT kind, author_id, title, description, payload, preset, aspect, advanced, import_id, import_name, preview,
        preview_infected, bytes, @at, @at, author_id, @reason, id
       FROM community_entries WHERE id = @id AND deleted_at IS NULL`,
  ).run({ id, at, reason: REPLACED_REASON }).changes;
  if (!archived) return false;
  db.prepare(
    `UPDATE community_entries SET title = ?, description = ?, payload = ?, preset = ?, aspect = ?, advanced = ?,
       import_id = ?, import_name = ?, preview = ?, preview_infected = ?, bytes = ?, updated_at = ?
     WHERE id = ?`,
  ).run(
    e.title, e.description, e.payload, e.preset ?? null, e.aspect ?? null, e.advanced ? 1 : 0, e.importId ?? null,
    e.importName ?? null, e.preview ?? null, e.previewInfected ?? null, e.bytes, at, id,
  );
  return true;
}

/** Marks a live entry deleted. False when it was already gone. */
export function tombstone(db: DB, id: number, o: { by: string; reason: string | null; now: Date }): boolean {
  return db.prepare(
    'UPDATE community_entries SET deleted_at = ?, deleted_by = ?, delete_reason = ? WHERE id = ? AND deleted_at IS NULL',
  ).run(o.now.toISOString(), o.by, o.reason, id).changes > 0;
}

export function likeCount(db: DB, id: number): number {
  return (db.prepare('SELECT COUNT(*) AS n FROM community_likes WHERE entry_id = ?').get(id) as { n: number }).n;
}

/** Idempotent: a second like is a no-op. */
export function like(db: DB, id: number, player: string, now: Date): void {
  db.prepare('INSERT OR IGNORE INTO community_likes (entry_id, player_id, created_at) VALUES (?, ?, ?)')
    .run(id, player, now.toISOString());
}

export function unlike(db: DB, id: number, player: string): void {
  db.prepare('DELETE FROM community_likes WHERE entry_id = ? AND player_id = ?').run(id, player);
}

/** The columns naming a file of each kind: a preview is either side's. */
const FILE_MATCH = {
  preview: (alias: string, param: string) => `(${alias}preview = ${param} OR ${alias}preview_infected = ${param})`,
  import: (alias: string, param: string) => `${alias}import_id = ${param}`,
} as const;

/**
 * Whether a live entry by an author who is not banned uses this file: the
 * test for serving it to anyone. Matches what GET /api/community/:id shows.
 */
export function fileLive(db: DB, kind: 'preview' | 'import', name: string, now = new Date()): boolean {
  return !!db.prepare(
    `SELECT 1 FROM community_entries e JOIN players p ON p.steamid = e.author_id
      WHERE ${FILE_MATCH[kind]('e.', '@name')} AND ${VISIBLE} LIMIT 1`,
  ).get({ name, now: now.toISOString() });
}

/** Whether any row that is not purged names this file, tombstones included. */
export function fileReferenced(db: DB, kind: 'preview' | 'import', name: string): boolean {
  return !!db.prepare(
    `SELECT 1 FROM community_entries WHERE ${FILE_MATCH[kind]('', '@name')} AND purged_at IS NULL LIMIT 1`,
  ).get({ name });
}
