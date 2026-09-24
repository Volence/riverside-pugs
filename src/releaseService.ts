import type { DB } from './db.js';
import type { BalanceKnobs } from './balanceKnobs.js';
import type { DeployRepo, RepoFile } from './deployRepo.js';
import { listServers } from './serverPool.js';
import { readingStates, readingsOf } from './fleetReader.js';
import { treeReaderFor } from './fleetTree.js';
import { cvarDiff, deploySlug, describeOps, planBox, suggestBalance, validateTree, wantedFor, type Op, type WantedFile } from './releaseStage.js';

const sqlNow = () => new Date().toISOString().replace('T', ' ').slice(0, 19);
const DAY_MS = 86_400_000;

export interface ReleaseSummary {
  id: number; kind: 'deploy' | 'undo'; undoOf: number | null; commit: string; short: string; state: string;
  createdBy: string; createdAt: string; deployedBy: string | null; deployedAt: string | null; canaryServerId: number | null;
  balance: { decision: string; name: string | null; notes: string | null } | null; backupsExpired: boolean;
  boxes: { serverId: number; name: string; state: string; error: string | null; updatedAt: string }[];
}
export interface ReleaseReview extends ReleaseSummary {
  subject: string | null; github: string | null; invalid: string[]; suggestion: 'not_balance' | 'possibly_balance';
  perBox: { serverId: number; name: string; lines: string[]; warnings: string[]; deployable: boolean }[];
  groups: { servers: string[]; lines: string[] }[];
}

export class ReleaseService {
  constructor(private d: { db: DB; repo: DeployRepo; knobs: BalanceKnobs | null; now?: () => string }) {}
  private now() { return (this.d.now ?? sqlNow)(); }

  /** What the last release that reached this box (and was not undone there) shipped to it. */
  lastShipped(serverId: number): { releaseId: number; files: Map<string, { sha256: string; blob: string }> } | null {
    const row = this.d.db.prepare(`SELECT rb.release_id, rb.shipped_json FROM release_boxes rb JOIN releases r ON r.id = rb.release_id
      WHERE rb.server_id = ? AND r.kind = 'deploy' AND rb.state IN ('written','restarted','confirmed')
      ORDER BY rb.release_id DESC LIMIT 1`).get(serverId) as { release_id: number; shipped_json: string } | undefined;
    if (!row) return null;
    return { releaseId: row.release_id, files: new Map(Object.entries(JSON.parse(row.shipped_json) as Record<string, { sha256: string; blob: string }>)) };
  }

  async stage(commit: string, adminId: string): Promise<{ ok: true; id: number } | { ok: false; status: 400 | 404; error: string }> {
    const { db, repo } = this.d;
    await repo.fetch();
    let hash: string;
    try { hash = await repo.resolve(commit); } catch { return { ok: false, status: 404, error: 'no such commit' }; }
    const files = await repo.tree(hash);
    const invalid = validateTree(files);
    const parent = await repo.parent(hash);
    const parentFiles: RepoFile[] = parent ? await repo.tree(parent) : [];
    const readings = readingsOf(db);
    const sources = [{ id: 'deploy', repo: 'Volence/l4d-deploy', commit: hash, layers: 'overrides+boxes', visibility: 'full' }];
    return db.transaction(() => {
      // Re-staging a commit replaces its earlier, never-deployed staging.
      for (const old of db.prepare("SELECT id FROM releases WHERE kind = 'deploy' AND state IN ('staged','invalid') AND json_extract(sources_json, '$[0].commit') = ?").all(hash) as { id: number }[]) {
        db.prepare('DELETE FROM release_boxes WHERE release_id = ?').run(old.id);
        db.prepare('DELETE FROM releases WHERE id = ?').run(old.id);
      }
      const id = Number(db.prepare(`INSERT INTO releases (kind, sources_json, state, invalid_json, created_by, created_at)
        VALUES ('deploy', ?, ?, ?, ?, ?)`).run(JSON.stringify(sources), invalid.length ? 'invalid' : 'staged', invalid.length ? JSON.stringify(invalid) : null, adminId, this.now()).lastInsertRowid);
      for (const s of listServers(db).filter((x) => x.enabled === 1)) {
        const slug = deploySlug(s.name);
        const wanted = wantedFor(files, slug);
        const shipped = this.lastShipped(s.id)?.files
          ?? new Map([...wantedFor(parentFiles, slug).values()].map((w) => [w.path, { sha256: w.sha256, blob: w.blob }]));
        const onBox = readings.get(s.id) ?? null;
        const ops = onBox && treeReaderFor(s) ? planBox(wanted, onBox, shipped) : null;
        const shippedJson = Object.fromEntries([...wanted.values()].map((w: WantedFile) => [w.path, { sha256: w.sha256, blob: w.blob }]));
        db.prepare("INSERT INTO release_boxes (release_id, server_id, state, plan_json, shipped_json, updated_at) VALUES (?, ?, 'staged', ?, ?, ?)")
          .run(id, s.id, ops ? JSON.stringify(ops) : null, JSON.stringify(shippedJson), this.now());
      }
      return { ok: true as const, id };
    })();
  }

  list(limit = 20): ReleaseSummary[] {
    const ids = (this.d.db.prepare('SELECT id FROM releases ORDER BY id DESC LIMIT ?').all(limit) as { id: number }[]).map((r) => r.id);
    return ids.map((id) => this.summary(id)!);
  }

  summary(id: number): ReleaseSummary | null {
    const r = this.d.db.prepare('SELECT * FROM releases WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    if (!r) return null;
    const commit = (JSON.parse(r.sources_json as string) as { commit: string }[])[0]?.commit ?? '';
    const boxes = this.d.db.prepare(`SELECT rb.server_id AS serverId, s.name, rb.state, rb.error, rb.updated_at AS updatedAt
      FROM release_boxes rb JOIN servers s ON s.id = rb.server_id WHERE rb.release_id = ? ORDER BY rb.server_id`).all(id) as ReleaseSummary['boxes'];
    return {
      id, kind: r.kind as 'deploy' | 'undo', undoOf: r.undo_of as number | null, commit, short: commit.slice(0, 7), state: r.state as string,
      createdBy: r.created_by as string, createdAt: r.created_at as string, deployedBy: r.deployed_by as string | null, deployedAt: r.deployed_at as string | null,
      canaryServerId: r.canary_server_id as number | null,
      balance: r.balance_decision ? { decision: r.balance_decision as string, name: r.balance_name as string | null, notes: r.balance_notes as string | null } : null,
      backupsExpired: r.backups_expired === 1, boxes,
    };
  }

  async review(id: number): Promise<ReleaseReview | null> {
    const sum = this.summary(id);
    if (!sum) return null;
    const { db, repo } = this.d;
    const rows = db.prepare(`SELECT rb.server_id, rb.plan_json FROM release_boxes rb WHERE rb.release_id = ? ORDER BY rb.server_id`).all(id) as { server_id: number; plan_json: string | null }[];
    const readings = readingsOf(db);
    const states = new Map(readingStates(db).map((s) => [s.serverId, s]));
    const servers = new Map(listServers(db).map((s) => [s.id, s]));
    const changedCvars: string[] = [];
    const perBox: ReleaseReview['perBox'] = [];
    // Before any release reached a box, what it had "from the repo" is the
    // staged commit's parent, the same fallback staging used for deletions.
    const parent = sum.commit ? await repo.parent(sum.commit) : null;
    const parentFiles = parent ? await repo.tree(parent) : [];
    const shippedBefore = (serverId: number, slug: string) => this.lastShipped(serverId)?.files
      ?? new Map([...wantedFor(parentFiles, slug).values()].map((w) => [w.path, { sha256: w.sha256, blob: w.blob }]));
    for (const row of rows) {
      const s = servers.get(row.server_id)!;
      const warnings: string[] = [];
      const st = states.get(s.id);
      if (!st?.readAt) warnings.push('never read: check it on the Fleet page first');
      else if (Date.now() - Date.parse(`${st.readAt.replace(' ', 'T')}Z`) > DAY_MS) warnings.push('reading is over 24 hours old: check it now first');
      if (!treeReaderFor(s)) warnings.push('no transport configured');
      if (row.plan_json === null) { perBox.push({ serverId: s.id, name: s.name, lines: [], warnings, deployable: false }); continue; }
      const ops = JSON.parse(row.plan_json) as Op[];
      const prev = shippedBefore(s.id, deploySlug(s.name));
      const onBox = readings.get(s.id);
      const lines: string[] = [];
      const words = describeOps(ops);
      for (let i = 0; i < ops.length; i++) {
        lines.push(words[i]);
        const o = ops[i];
        const shipped = prev?.get(o.path);
        const have = onBox?.get(o.path);
        if (shipped && have && have.sha256 !== shipped.sha256) warnings.push(`changed on the box since the last release: ${o.path.replace(/^left4dead\//, '')}`);
        if (o.op === 'write' && o.kind === 'update' && o.path.endsWith('.cfg') && o.blob) {
          const neu = (await repo.blob(o.blob)).toString('utf8');
          let old: string | null = null;
          if (shipped && have?.sha256 === shipped.sha256) old = (await repo.blob(shipped.blob)).toString('utf8');
          if (old === null) lines.push('  (changed on the box since; line diff unavailable)');
          else for (const d of cvarDiff(old, neu)) { lines.push(`  ${d}`); changedCvars.push(d.split(' ')[0]); }
        }
      }
      perBox.push({ serverId: s.id, name: s.name, lines: lines.length ? lines : ['no changes'], warnings, deployable: true });
    }
    const groups = new Map<string, { servers: string[]; lines: string[] }>();
    for (const b of perBox) {
      const key = JSON.stringify(b.lines);
      const g = groups.get(key) ?? { servers: [], lines: b.lines };
      g.servers.push(b.name);
      groups.set(key, g);
    }
    const commits = await repo.commits(100).catch(() => []);
    return {
      ...sum,
      subject: commits.find((c) => c.hash === sum.commit)?.subject ?? null,
      github: repo.githubCommitUrl(sum.commit),
      invalid: (db.prepare('SELECT invalid_json FROM releases WHERE id = ?').get(id) as { invalid_json: string | null }).invalid_json
        ? JSON.parse((db.prepare('SELECT invalid_json FROM releases WHERE id = ?').get(id) as { invalid_json: string }).invalid_json) : [],
      suggestion: suggestBalance(rows.filter((r) => r.plan_json).map((r) => JSON.parse(r.plan_json!) as Op[]), changedCvars, this.d.knobs),
      perBox, groups: [...groups.values()],
    };
  }
}
