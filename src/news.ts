import type { DB } from './db.js';
import { getSetting } from './settings.js';

/**
 * News posts: announcements and quick patch notes staff write on the site,
 * which the bot also posts to the news channel (src/discord/newsPoster.ts).
 *
 * The body is plain text in the site's safe markdown subset
 * (web/src/richText.ts): it is stored as written and never turned into HTML
 * on the server. The site renders it as elements, Discord renders its own
 * markdown from the copy src/discord/newsCard.ts makes.
 *
 * Discord state, in discord_state:
 *   NULL       nothing to do: either never meant for Discord (a draft), or
 *              the message (discord_message_id) matches the post.
 *   'pending'  send the post, or edit its message, on the next pass.
 *   'remove'   take the message down (unpublished, or deleted when
 *              deleted_at is set, and then the row goes too).
 *   'skipped'  published while no news channel was set: never posted. An
 *              edit leaves it that way; unpublishing and publishing again
 *              posts it if a channel is set by then.
 * The database is the queue, as for the other posters: a Discord outage or
 * a restart between a publish and its post loses nothing.
 */

export type NewsKind = 'news' | 'patch';
export const NEWS_KINDS: readonly NewsKind[] = ['news', 'patch'];
export const NEWS_TITLE_MAX = 120;
export const NEWS_BODY_MAX = 20_000;
export const NEWS_PAGE_SIZE = 10;
export const NEWS_CHANNEL_SETTING = 'discord_news_channel_id';

export type DiscordState = 'pending' | 'remove' | 'skipped';

export interface NewsRow {
  id: number;
  kind: NewsKind;
  title: string;
  body: string;
  author_id: string;
  created_at: string;
  updated_at: string;
  published_at: string | null;
  discord_message_id: string | null;
  /** JSON array of the follow-up message ids when the post is split over
   *  several messages, after discord_message_id. */
  discord_extra_ids: string | null;
  discord_channel_id: string | null;
  discord_state: DiscordState | null;
  discord_error: string | null;
  deleted_at: string | null;
}

export interface NewsPublic {
  id: number;
  kind: NewsKind;
  title: string;
  body: string;
  excerpt: string;
  publishedAt: string;
  updatedAt: string;
  author: { steamid: string; name: string } | null;
}

export interface NewsAdmin extends Omit<NewsPublic, 'publishedAt'> {
  publishedAt: string | null;
  createdAt: string;
  /** Where the post stands on Discord, in the editor's words. */
  discord: 'none' | 'posted' | 'pending' | 'removing' | 'skipped';
  discordError: string | null;
}

/** The text with its markup taken out, cut to about `max` characters at a
 *  word, for the list page and the Play strip. Plain text: the site shows it
 *  as a text child, never as markup. */
export function plainExcerpt(body: string, max = 240): string {
  const text = body
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((l) => l.replace(/^\s*#{1,3}\s+/, '').replace(/^\s*(?:[-*+]|\d{1,9}[.)])\s+/, ''))
    .join(' ')
    .replace(/\[([^\]\n]*)\]\([^)\s]*\)/g, '$1')
    .replace(/\*\*([^*]*)\*\*/g, '$1')
    .replace(/\*([^*\s][^*]*)\*/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const at = cut.lastIndexOf(' ');
  return `${(at > max / 2 ? cut.slice(0, at) : cut).replace(/[\s.,;:]+$/, '')}...`;
}

const now = () => new Date().toISOString();

function authorOf(db: DB, steamid: string): { steamid: string; name: string } | null {
  const p = db.prepare('SELECT steamid, name FROM players WHERE steamid = ?').get(steamid) as { steamid: string; name: string } | undefined;
  return p ?? null;
}

export function toPublic(db: DB, r: NewsRow): NewsPublic {
  return {
    id: r.id, kind: r.kind, title: r.title, body: r.body, excerpt: plainExcerpt(r.body),
    publishedAt: r.published_at!, updatedAt: r.updated_at, author: authorOf(db, r.author_id),
  };
}

function discordView(r: NewsRow): NewsAdmin['discord'] {
  if (r.discord_state === 'pending') return 'pending';
  if (r.discord_state === 'remove') return 'removing';
  if (r.discord_state === 'skipped') return 'skipped';
  return r.discord_message_id ? 'posted' : 'none';
}

export function toAdmin(db: DB, r: NewsRow): NewsAdmin {
  return {
    id: r.id, kind: r.kind, title: r.title, body: r.body, excerpt: plainExcerpt(r.body),
    publishedAt: r.published_at, updatedAt: r.updated_at, createdAt: r.created_at, author: authorOf(db, r.author_id),
    discord: discordView(r), discordError: r.discord_error,
  };
}

export function getNewsRow(db: DB, id: number): NewsRow | undefined {
  return db.prepare('SELECT * FROM news_posts WHERE id = ? AND deleted_at IS NULL').get(id) as NewsRow | undefined;
}

/** Published posts, newest first, one page at a time (pages count from 1). */
export function listPublished(db: DB, page: number, pageSize = NEWS_PAGE_SIZE, kind: NewsKind | null = null): { posts: NewsRow[]; total: number } {
  // `kind` narrows to one kind: /patch-notes lists only the patch posts.
  const where = `published_at IS NOT NULL AND deleted_at IS NULL${kind ? ' AND kind = ?' : ''}`;
  const args = kind ? [kind] : [];
  const total = (db.prepare(`SELECT COUNT(*) AS n FROM news_posts WHERE ${where}`).get(...args) as { n: number }).n;
  const posts = db.prepare(
    `SELECT * FROM news_posts WHERE ${where}
     ORDER BY published_at DESC, id DESC LIMIT ? OFFSET ?`,
  ).all(...args, pageSize, (page - 1) * pageSize) as NewsRow[];
  return { posts, total };
}

/** Every post for the editor: drafts first, then published newest first. */
export function listAll(db: DB): NewsRow[] {
  return db.prepare(
    `SELECT * FROM news_posts WHERE deleted_at IS NULL
     ORDER BY published_at IS NOT NULL, COALESCE(published_at, updated_at) DESC, id DESC`,
  ).all() as NewsRow[];
}

export type NewsInput = { kind: NewsKind; title: string; body: string };

/** The editor's fields, checked, or what is wrong with them. */
export function validateNews(raw: unknown): { ok: true; value: NewsInput } | { ok: false; error: string } {
  const b = (raw ?? {}) as { kind?: unknown; title?: unknown; body?: unknown };
  if (typeof b.kind !== 'string' || !(NEWS_KINDS as readonly string[]).includes(b.kind)) {
    return { ok: false, error: 'kind must be news or patch' };
  }
  if (typeof b.title !== 'string' || !b.title.trim()) return { ok: false, error: 'a title is required' };
  const title = b.title.trim().replace(/\s+/g, ' ');
  if (title.length > NEWS_TITLE_MAX) return { ok: false, error: `the title is longer than ${NEWS_TITLE_MAX} characters` };
  if (typeof b.body !== 'string') return { ok: false, error: 'a body is required' };
  const body = b.body.replace(/\r\n?/g, '\n').replace(/\s+$/, '');
  if (body.length > NEWS_BODY_MAX) return { ok: false, error: `the body is longer than ${NEWS_BODY_MAX} characters` };
  return { ok: true, value: { kind: b.kind as NewsKind, title, body } };
}

export function createNews(db: DB, by: string, input: NewsInput): NewsRow {
  const at = now();
  const id = Number(db.prepare(
    'INSERT INTO news_posts (kind, title, body, author_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
  ).run(input.kind, input.title, input.body, by, at, at).lastInsertRowid);
  return getNewsRow(db, id)!;
}

/** Edit a post. A published post's Discord message is queued for an edit
 *  when it has one (or is still waiting for its first send). */
export function updateNews(db: DB, id: number, input: NewsInput): NewsRow {
  const row = getNewsRow(db, id)!;
  const resync = row.published_at !== null && (row.discord_message_id !== null || row.discord_state === 'pending');
  db.prepare(
    `UPDATE news_posts SET kind = ?, title = ?, body = ?, updated_at = ?,
       discord_state = CASE WHEN ? THEN 'pending' ELSE discord_state END
     WHERE id = ?`,
  ).run(input.kind, input.title, input.body, now(), resync ? 1 : 0, id);
  return getNewsRow(db, id)!;
}

/** Publish now. Queued for Discord when a news channel is set, or marked
 *  skipped when none is, so turning the channel on later never floods it
 *  with old posts. */
export function publishNews(db: DB, id: number): NewsRow {
  const channel = (getSetting(db, NEWS_CHANNEL_SETTING) ?? '').trim();
  const row = getNewsRow(db, id)!;
  // A message still up from before an unpublish is edited back into shape,
  // so it needs no channel lookup.
  const state: DiscordState = channel || row.discord_message_id ? 'pending' : 'skipped';
  db.prepare('UPDATE news_posts SET published_at = ?, discord_state = ?, discord_error = NULL WHERE id = ?').run(now(), state, id);
  return getNewsRow(db, id)!;
}

export function unpublishNews(db: DB, id: number): NewsRow {
  db.prepare(
    `UPDATE news_posts SET published_at = NULL, discord_error = NULL,
       discord_state = CASE WHEN discord_message_id IS NOT NULL THEN 'remove' ELSE NULL END
     WHERE id = ?`,
  ).run(id);
  return getNewsRow(db, id)!;
}

/** Delete a post. One with a Discord message (or a send that may be in
 *  flight) is hidden at once and kept until the poster has taken the message
 *  down; one without goes now. */
export function deleteNews(db: DB, id: number): void {
  const row = getNewsRow(db, id);
  if (!row) return;
  if (row.discord_message_id || row.discord_state === 'pending') {
    db.prepare("UPDATE news_posts SET deleted_at = ?, published_at = NULL, discord_state = 'remove', discord_error = NULL WHERE id = ?")
      .run(now(), id);
  } else {
    db.prepare('DELETE FROM news_posts WHERE id = ?').run(id);
  }
}
