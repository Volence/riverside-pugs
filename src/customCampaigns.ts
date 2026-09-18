import type { DB } from './db.js';

export type CampaignState = 'draft' | 'published';
export type InstallState = 'pending' | 'installed' | 'failed';

export interface CustomCampaignRow {
  slug: string;
  name: string;
  vpk_filename: string;
  size_bytes: number;
  sha256: string;
  state: CampaignState;
  enabled: number;
  uploaded_by: string | null;
  uploaded_at: number;
  notes: string | null;
}

export interface ChapterRow {
  slug: string;
  ordinal: number;
  map: string;
  display: string | null;
  is_finale: number;
  included: number;
  /** Position in the generated mission. NULL when excluded. Always agrees with
   *  `included`: the two are written together and never independently. */
  play_order: number | null;
}

export interface InstallRow {
  slug: string;
  server_id: number;
  state: InstallState;
  sha256: string | null;
  error: string | null;
  updated_at: number;
}

/**
 * Write a freshly parsed upload as a draft, with its chapters in file order.
 *
 * Every chapter starts included and in file order, so a campaign nobody edits
 * on the confirm screen plays exactly as its author shipped it. The last
 * chapter is marked the finale: L4D1 mission files do not reliably say which
 * one is, and the last one always is in practice. The admin can correct it.
 */
export function insertDraft(
  db: DB,
  c: {
    slug: string; name: string; vpkFilename: string;
    sizeBytes: number; sha256: string; uploadedBy: string | null;
  },
  chapters: { map: string; display: string | null; isFinale: boolean }[],
): void {
  db.transaction(() => {
    db.prepare(
      `INSERT INTO custom_campaigns
         (slug, name, vpk_filename, size_bytes, sha256, state, enabled, uploaded_by, uploaded_at)
       VALUES (?, ?, ?, ?, ?, 'draft', 0, ?, ?)`,
    ).run(c.slug, c.name, c.vpkFilename, c.sizeBytes, c.sha256, c.uploadedBy, Date.now());

    const ins = db.prepare(
      `INSERT INTO custom_campaign_chapters
         (slug, ordinal, map, display, is_finale, included, play_order)
       VALUES (?, ?, ?, ?, ?, 1, ?)`,
    );
    chapters.forEach((ch, i) => {
      const ordinal = i + 1;
      const isFinale = ch.isFinale || i === chapters.length - 1;
      ins.run(c.slug, ordinal, ch.map, ch.display, isFinale ? 1 : 0, ordinal);
    });
  })();
}

export function getCampaign(db: DB, slug: string): CustomCampaignRow | undefined {
  return db.prepare('SELECT * FROM custom_campaigns WHERE slug = ?').get(slug) as
    CustomCampaignRow | undefined;
}

export function listCampaigns(
  db: DB, opts: { state?: CampaignState; enabledOnly?: boolean } = {},
): CustomCampaignRow[] {
  const where: string[] = [];
  const args: unknown[] = [];
  if (opts.state) { where.push('state = ?'); args.push(opts.state); }
  if (opts.enabledOnly) where.push('enabled = 1');
  const sql = `SELECT * FROM custom_campaigns${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY name`;
  return db.prepare(sql).all(...args) as CustomCampaignRow[];
}

export function chaptersOf(db: DB, slug: string): ChapterRow[] {
  return db.prepare(
    'SELECT * FROM custom_campaign_chapters WHERE slug = ? ORDER BY ordinal',
  ).all(slug) as ChapterRow[];
}

export function publishCampaign(db: DB, slug: string, name: string): void {
  db.prepare("UPDATE custom_campaigns SET state = 'published', name = ? WHERE slug = ?")
    .run(name, slug);
}

export function setEnabled(db: DB, slug: string, enabled: boolean): void {
  db.prepare('UPDATE custom_campaigns SET enabled = ? WHERE slug = ?').run(enabled ? 1 : 0, slug);
}

export function deleteCampaign(db: DB, slug: string): void {
  // Explicit child deletes rather than relying on ON DELETE CASCADE: the
  // pragma is on in openDb, but this module is also exercised against
  // databases opened elsewhere and the cost of being explicit is two lines.
  db.transaction(() => {
    db.prepare('DELETE FROM custom_campaign_installs WHERE slug = ?').run(slug);
    db.prepare('DELETE FROM custom_campaign_chapters WHERE slug = ?').run(slug);
    db.prepare('DELETE FROM custom_campaigns WHERE slug = ?').run(slug);
  })();
}

export function installsOf(db: DB, slug: string): InstallRow[] {
  return db.prepare(
    'SELECT * FROM custom_campaign_installs WHERE slug = ? ORDER BY server_id',
  ).all(slug) as InstallRow[];
}

/** Upsert, because this is called on every retry of a failing install. */
export function setInstall(
  db: DB, slug: string, serverId: number, state: InstallState,
  extra: { sha256?: string | null; error?: string | null } = {},
): void {
  db.prepare(
    `INSERT INTO custom_campaign_installs (slug, server_id, state, sha256, error, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(slug, server_id) DO UPDATE SET
       state = excluded.state, sha256 = excluded.sha256,
       error = excluded.error, updated_at = excluded.updated_at`,
  ).run(slug, serverId, state, extra.sha256 ?? null, extra.error ?? null, Date.now());
}
