import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { DB } from './db.js';
import { publishAdminEvent } from './adminFeed.js';
import { getServer, markOffline, release as releaseServer, type ServerRow } from './serverPool.js';
import { restartOutcome, type RestartOutcome, type ServerRestarter } from './serverRestart.js';
import { treeWriterFor, type TreeWriter } from './fleetWrite.js';
import type { Op } from './releaseStage.js';

/**
 * Sends a staged release to the boxes, one box at a time: wait until idle,
 * hold, back up, write, verify, restart when empty. Any failure before the
 * restart puts the backups back and marks the box failed. A box whose restart
 * cannot be done safely (players on it, a match took it, quit never sent) is
 * left 'written' with the reason as its error and parked offline. See
 * docs/superpowers/specs/2026-09-24-release-deploy-design.md.
 */

type Result = { ok: true } | { ok: false; status: 400 | 404 | 409; error: string };
interface Row { id: number; kind: 'deploy' | 'undo'; undo_of: number | null; state: string; canary_server_id: number | null; deployed_at: string | null; backups_expired: number }
interface BoxRow { release_id: number; server_id: number; state: string; plan_json: string | null }

const sqlNow = () => new Date().toISOString().replace('T', ' ').slice(0, 19);
const sha256 = (b: Buffer) => createHash('sha256').update(b).digest('hex');
const DONE = new Set(['written', 'restarted', 'confirmed', 'failed', 'skipped', 'undone']);
const OK = new Set(['written', 'restarted', 'confirmed']);
/** 'written' with no error is a restart still to come; with one, it is parked. */
const boxDone = (b: { state: string; error: string | null }) => DONE.has(b.state) && !(b.state === 'written' && b.error === null);
const CANARY_OK = new Set(['restarted', 'confirmed']);
const LINK = { label: 'Deploy page', path: '/admin/setup/deploy' };
const BACKUP_DAYS = 30;
/** Per call on a box: a read, a write, a delete, or the verify hash. */
const OP_LIMIT_MS: Record<TreeWriter['kind'], number> = { local: 60_000, sftp: 120_000, ftp: 300_000 };
/** The release hook never holds the after-match restart longer than this. */
const HOOK_CAP_MS = 3 * 60_000;
/** How long a cancelled box call gets to die before the engine moves on. */
const ABORT_GRACE_MS = 10_000;

export class ReleaseEngine {
  private chain: Promise<void> = Promise.resolve();
  private restarts = new Set<Promise<void>>();
  /** Boxes this engine wrote inside the release hook, whose restart is the
   *  releaser's: 'writing' until the write settles, 'written' when the new
   *  files wait on that restart, 'park' when the box must stay offline after
   *  it, 'restarted' when the releaser restarted it before the write was done. */
  private hooked = new Map<number, { releaseId: number; stage: 'writing' | 'written' | 'park' | 'restarted' }>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private recovered = false;

  constructor(private d: {
    db: DB;
    blob: (id: string) => Promise<Buffer>;
    writer?: (s: ServerRow) => TreeWriter | null;
    restarter: ServerRestarter | null;
    humans?: (s: ServerRow) => Promise<number>;
    releasesDir: string;
    devMode: boolean;
    now?: () => string;
    sleep?: (ms: number) => Promise<void>;
    emptyWaitMs?: number;
    emptyPollMs?: number;
    tickMs?: number;
    hookCapMs?: number;
    opLimitMs?: number;
  }) {}

  private now() { return (this.d.now ?? sqlNow)(); }
  private rel(id: number) { return this.d.db.prepare('SELECT * FROM releases WHERE id = ?').get(id) as Row | undefined; }
  private boxes(id: number) {
    return this.d.db.prepare('SELECT release_id, server_id, state, plan_json FROM release_boxes WHERE release_id = ? ORDER BY server_id').all(id) as BoxRow[];
  }
  private setBox(id: number, sid: number, state: string, error: string | null = null) {
    this.d.db.prepare('UPDATE release_boxes SET state = ?, error = ?, updated_at = ? WHERE release_id = ? AND server_id = ?').run(state, error, this.now(), id, sid);
  }
  private setRel(id: number, state: string) { this.d.db.prepare('UPDATE releases SET state = ? WHERE id = ?').run(state, id); }

  inFlight(): number | null {
    return (this.d.db.prepare("SELECT id FROM releases WHERE state IN ('deploying','canary_wait') ORDER BY id LIMIT 1").get() as { id: number } | undefined)?.id ?? null;
  }

  deploy(id: number, p: { targets: number[]; canary: number | null; balance: { decision: string; name?: unknown; notes?: unknown }; adminId: string }): Result {
    if (this.d.devMode) return { ok: false, status: 409, error: 'deploys are disabled in dev mode' };
    const r = this.rel(id);
    if (!r) return { ok: false, status: 404, error: 'no such release' };
    if (r.state !== 'staged') return { ok: false, status: 409, error: `this release is ${r.state}` };
    if (this.inFlight() !== null) return { ok: false, status: 409, error: 'another release is still deploying' };
    const rows = this.boxes(id);
    // A plan is a diff against the box as it was at staging. Another release
    // (or undo) reaching a target since then makes it stale: stage again.
    const created = (this.d.db.prepare('SELECT created_at FROM releases WHERE id = ?').get(id) as { created_at: string }).created_at;
    for (const t of p.targets) {
      const newer = this.d.db.prepare(`SELECT r.id FROM release_boxes rb JOIN releases r ON r.id = rb.release_id
        WHERE rb.server_id = ? AND r.id != ? AND r.deployed_at IS NOT NULL AND r.deployed_at > ?
          AND rb.state IN ('written','restarted','confirmed','undone') LIMIT 1`).get(t, id, created) as { id: number } | undefined;
      if (newer) return { ok: false, status: 409, error: `release ${newer.id} reached a target box after this one was staged: review this commit again` };
    }
    const deployable = new Set(rows.filter((b) => b.plan_json !== null).map((b) => b.server_id));
    if (p.targets.length === 0 || p.targets.some((t) => !deployable.has(t))) return { ok: false, status: 400, error: 'pick at least one box that has a plan' };
    if (p.canary !== null && !p.targets.includes(p.canary)) return { ok: false, status: 400, error: 'the canary must be one of the targets' };
    const decision = p.balance.decision;
    if (!['balance', 'not_balance', 'later'].includes(decision)) return { ok: false, status: 400, error: 'balance decision is balance, not_balance or later' };
    const name = typeof p.balance.name === 'string' ? p.balance.name.trim() : '';
    const notes = typeof p.balance.notes === 'string' ? p.balance.notes.trim() : '';
    if (decision === 'balance' && !name) return { ok: false, status: 400, error: 'a balance patch needs a name' };
    if (name.length > 60) return { ok: false, status: 400, error: 'a patch name is up to 60 characters' };
    if (notes.length > 2000) return { ok: false, status: 400, error: 'notes are up to 2000 characters' };
    this.d.db.transaction(() => {
      this.d.db.prepare(`UPDATE releases SET state = 'deploying', canary_server_id = ?, balance_decision = ?, balance_name = ?, balance_notes = ?,
        deployed_by = ?, deployed_at = ? WHERE id = ?`).run(p.canary, decision, decision === 'balance' ? name : null, decision === 'balance' ? notes : null, p.adminId, this.now(), id);
      for (const b of rows) this.setBox(id, b.server_id, p.targets.includes(b.server_id) ? 'pending' : 'skipped');
    })();
    return { ok: true };
  }

  continueRelease(id: number, _adminId: string): Result {
    const r = this.rel(id);
    if (!r) return { ok: false, status: 404, error: 'no such release' };
    if (r.state !== 'canary_wait') return { ok: false, status: 409, error: 'this release is not waiting on its canary' };
    this.setRel(id, 'deploying');
    return { ok: true };
  }

  undo(id: number, serverIds: number[] | null, adminId: string): { ok: true; id: number } | { ok: false; status: 400 | 404 | 409; error: string } {
    if (this.d.devMode) return { ok: false, status: 409, error: 'undo is disabled in dev mode' };
    const r = this.rel(id);
    if (!r || r.kind !== 'deploy') return { ok: false, status: 404, error: 'no such release' };
    if (r.backups_expired) return { ok: false, status: 409, error: 'backups expired' };
    if (this.inFlight() !== null) return { ok: false, status: 409, error: 'another release is still deploying' };
    const reached = this.boxes(id).filter((b) => OK.has(b.state) && (serverIds === null || serverIds.includes(b.server_id)));
    if (reached.length === 0) return { ok: false, status: 400, error: 'none of those boxes has this release on it' };
    // Undo puts back what was there before THIS release: after a newer one
    // reached the box, that would wipe the newer one's changes too.
    for (const b of reached) {
      const newer = this.d.db.prepare(`SELECT rb.release_id FROM release_boxes rb JOIN releases r ON r.id = rb.release_id
        WHERE rb.server_id = ? AND r.kind = 'deploy' AND r.id > ? AND rb.state IN ('written','restarted','confirmed') LIMIT 1`).get(b.server_id, id) as { release_id: number } | undefined;
      if (newer) return { ok: false, status: 409, error: `release ${newer.release_id} reached that box after this one: undo it first` };
    }
    const uid = this.d.db.transaction(() => {
      const src = this.d.db.prepare('SELECT sources_json FROM releases WHERE id = ?').get(id) as { sources_json: string };
      const newId = Number(this.d.db.prepare(`INSERT INTO releases (kind, undo_of, sources_json, state, created_by, created_at, deployed_by, deployed_at)
        VALUES ('undo', ?, ?, 'deploying', ?, ?, ?, ?)`).run(id, src.sources_json, adminId, this.now(), adminId, this.now()).lastInsertRowid);
      for (const b of reached) {
        const manifest = JSON.parse(readFileSync(join(this.d.releasesDir, String(id), String(b.server_id), 'backup.json'), 'utf8')) as { path: string; existed: boolean }[];
        const ops: Op[] = manifest.map((m) => {
          if (!m.existed) return { path: m.path, op: 'remove' as const };
          const bytes = readFileSync(join(this.d.releasesDir, String(id), String(b.server_id), 'files', m.path));
          return { path: m.path, op: 'write' as const, kind: 'update' as const, size: bytes.length, sha256: sha256(bytes), backupFrom: { releaseId: id, serverId: b.server_id } };
        });
        this.d.db.prepare("INSERT INTO release_boxes (release_id, server_id, state, plan_json, shipped_json, updated_at) VALUES (?, ?, 'pending', ?, '{}', ?)")
          .run(newId, b.server_id, JSON.stringify(ops), this.now());
      }
      return newId;
    })();
    return { ok: true, id: uid };
  }

  tick(): Promise<void> {
    this.chain = this.chain.then(() => this.drive(null)).catch((err) => console.error('[releases] tick failed:', err));
    return this.chain;
  }

  /** The ServerReleaser's before-restart hook: this box has just finished a
   *  match; give it its turn now, before the releaser restarts it. */
  forRelease(serverId: number): Promise<void> {
    const hook = { live: true };
    this.chain = this.chain.then(() => this.drive(serverId, hook)).catch((err) => console.error('[releases] release hook failed:', err));
    // Capped: behind a slow write on another box, the releaser must still get
    // this box back. When the cap fires the hook's turn is spent: the queued
    // turn still runs later, but may no longer treat the box's 'offline' as
    // the releaser's (it may be booting, or parked), so it waits for an idle
    // moment like any other. A write already under way when the cap fires is
    // judged by afterReleaserRestart.
    let t: ReturnType<typeof setTimeout> | undefined;
    const cap = new Promise<void>((resolve) => { t = setTimeout(resolve, this.d.hookCapMs ?? HOOK_CAP_MS); t.unref?.(); });
    return Promise.race([this.chain, cap]).finally(() => { clearTimeout(t); hook.live = false; });
  }

  /** Whether the releaser's coming restart of this box is one a release
   *  wrote for (so it must say how the restart went). */
  ownsRestart(serverId: number): boolean {
    return this.hooked.has(serverId);
  }

  /** The releaser restarted a box this engine wrote inside the hook. True
   *  means keep it offline: the new files are not loaded, or not all there. */
  afterReleaserRestart(serverId: number, res: RestartOutcome): boolean {
    const h = this.hooked.get(serverId);
    if (!h) return false;
    if (h.stage === 'writing') { h.stage = 'restarted'; return true; }
    this.hooked.delete(serverId);
    if (h.stage === 'park') return true;
    if (res.back && res.quitSent) {
      this.setBox(h.releaseId, serverId, 'restarted');
    } else {
      this.park(h.releaseId, serverId, res.quitSent ? 'the box did not come back after the restart' : 'quit could not be sent over rcon, so the box is still running the old files');
    }
    if (!this.canaryOutcome(h.releaseId)) this.settle(h.releaseId);
    return !(res.back && res.quitSent);
  }

  private async drive(onlyServer: number | null, hook: { live: boolean } | null = null): Promise<void> {
    const id = this.inFlight();
    if (id === null) return;
    const r = this.rel(id)!;
    if (r.state !== 'deploying') return;
    const rows = this.boxes(id);
    const canary = r.canary_server_id;
    const order = [...rows].sort((a, b) => Number(b.server_id === canary) - Number(a.server_id === canary) || a.server_id - b.server_id);
    const canaryRow = canary === null ? null : rows.find((b) => b.server_id === canary)!;
    for (const b of order) {
      // The rest wait until the canary has restarted, not merely been written.
      if (canaryRow && b.server_id !== canary && !CANARY_OK.has(this.boxState(id, canary!))) break;
      if (onlyServer !== null && b.server_id !== onlyServer) continue;
      const st = this.boxState(id, b.server_id);
      if (st !== 'pending' && st !== 'waiting') continue;
      await this.runBox(r, b, hook);
      if (b.server_id === canary && this.canaryOutcome(id)) return;
    }
    this.settle(id);
  }

  /** After the canary's state changed: halt on a failed or parked canary, wait
   *  for Continue once it has restarted. True when the release stopped here. */
  private canaryOutcome(id: number): boolean {
    const r = this.rel(id)!;
    const canary = r.canary_server_id;
    if (canary === null || r.state !== 'deploying') return false;
    const c = this.d.db.prepare('SELECT state, error FROM release_boxes WHERE release_id = ? AND server_id = ?').get(id, canary) as { state: string; error: string | null };
    const rest = this.boxes(id).filter((o) => o.server_id !== canary && ['pending', 'waiting'].includes(o.state));
    if (c.state === 'failed' || (c.state === 'written' && c.error !== null)) {
      for (const o of rest) this.setBox(id, o.server_id, 'skipped');
      this.setRel(id, 'halted');
      publishAdminEvent({ kind: 'problem', text: `Release ${id}: the canary ${c.state === 'failed' ? 'failed' : 'was not restarted'}, so no other box got it.`, link: LINK });
      return true;
    }
    if (CANARY_OK.has(c.state) && rest.length > 0) {
      this.setRel(id, 'canary_wait');
      publishAdminEvent({ kind: 'problem', text: `Release ${id}: the canary box has it. Check it, then press Continue for the rest.`, link: LINK });
      return true;
    }
    return false;
  }

  private boxState(id: number, sid: number): string {
    return (this.d.db.prepare('SELECT state FROM release_boxes WHERE release_id = ? AND server_id = ?').get(id, sid) as { state: string }).state;
  }

  private settle(id: number): void {
    if (this.rel(id)?.state !== 'deploying') return;
    const rows = this.d.db.prepare('SELECT state, error FROM release_boxes WHERE release_id = ?').all(id) as { state: string; error: string | null }[];
    if (!rows.every(boxDone)) return;
    this.setRel(id, 'done');
    const r = this.rel(id)!;
    if (r.kind === 'undo' && r.undo_of !== null) {
      for (const b of this.boxes(id)) if (OK.has(b.state)) this.setBox(r.undo_of, b.server_id, 'undone');
    }
  }

  private async runBox(r: Row, b: BoxRow, hook: { live: boolean } | null): Promise<void> {
    const db = this.d.db;
    const s = getServer(db, b.server_id);
    if (!s || s.enabled !== 1) { this.setBox(r.id, b.server_id, 'failed', 'the box is disabled'); return; }
    // 'offline' is only ours to use inside the release hook, where the
    // releaser itself took the box offline to restart it. Anywhere else it
    // means parked or unverified (see reconcileServers), and must never be
    // written, restarted or turned idle from here.
    const releaserRestarting = hook?.live === true && s.status === 'offline';
    if (!releaserRestarting && s.status !== 'idle') { this.setBox(r.id, b.server_id, 'waiting'); return; }
    const writer = (this.d.writer ?? treeWriterFor)(s);
    if (!writer) { this.setBox(r.id, b.server_id, 'failed', 'no transport configured'); return; }
    const held = s.status === 'idle';
    if (held) db.prepare("UPDATE servers SET status = 'reserved' WHERE id = ?").run(s.id);
    const unhold = () => { if (held) releaseServer(db, s.id); };
    const hooked = { releaseId: r.id, stage: 'writing' as 'writing' | 'written' | 'park' | 'restarted' };
    if (releaserRestarting) this.hooked.set(s.id, hooked);
    this.setBox(r.id, b.server_id, 'writing');

    // Every box call is bounded: a hung ssh or FTP call must not hold the
    // engine (and, through the release hook, the releaser) forever. A call
    // that runs out of time is cancelled (the ssh child killed, the FTP client
    // closed) and given a moment to die before anything else touches the box,
    // so it cannot finish after the backup has gone back.
    const bounded = <T>(call: (signal: AbortSignal) => Promise<T>, what: string) => this.bounded(writer, call, what);
    const ops = JSON.parse(b.plan_json!) as Op[];
    const dir = join(this.d.releasesDir, String(r.id), String(s.id));
    const backup: { path: string; existed: boolean }[] = [];
    try {
      for (const o of ops) {
        const bytes = await bounded((sig) => writer.read(o.path, sig), `reading ${o.path}`);
        if (bytes) { mkdirSync(dirname(join(dir, 'files', o.path)), { recursive: true }); writeFileSync(join(dir, 'files', o.path), bytes); }
        backup.push({ path: o.path, existed: bytes !== null });
      }
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'backup.json'), JSON.stringify(backup));
      for (const o of ops) {
        if (o.op === 'remove') { await bounded((sig) => writer.remove(o.path, sig), `removing ${o.path}`); continue; }
        const bytes = o.blob ? await this.d.blob(o.blob)
          : readFileSync(join(this.d.releasesDir, String(o.backupFrom!.releaseId), String(o.backupFrom!.serverId), 'files', o.path));
        if (sha256(bytes) !== o.sha256) throw new Error(`content for ${o.path} does not match its hash`);
        await bounded((sig) => writer.write(o.path, bytes, sig), `writing ${o.path}`);
      }
      const h = await bounded((sig) => writer.hash(ops.map((o) => o.path), sig), 'verifying');
      for (const o of ops) {
        const got = h.get(o.path) ?? null;
        if (o.op === 'remove' ? got !== null : got !== o.sha256) throw new Error(`verify failed for ${o.path}`);
      }
    } catch (err) {
      let error = err instanceof Error ? err.message : String(err);
      // Every file is tried: one that will not go back must not leave the
      // others as the release wrote them.
      const unrestored: string[] = [];
      for (const e of backup) {
        try {
          if (e.existed) await bounded((sig) => writer.write(e.path, readFileSync(join(dir, 'files', e.path)), sig), 'the restore');
          else await bounded((sig) => writer.remove(e.path, sig), 'the restore');
        } catch (e2) {
          unrestored.push(`restoring ${e.path}: ${e2 instanceof Error ? e2.message : String(e2)}`);
        }
      }
      if (unrestored.length) error += `; restoring the backup also failed: ${unrestored.join('; ')}`;
      this.setBox(r.id, s.id, 'failed', error);
      if (unrestored.length) {
        // Half the release and half the backup: never back in the pool. Inside
        // the hook the releaser's restart must leave it offline too.
        if (releaserRestarting && hooked.stage === 'writing') hooked.stage = 'park';
        else if (releaserRestarting) this.hooked.delete(s.id);
        markOffline(db, s.id);
        publishAdminEvent({ kind: 'problem', text: `Release ${r.id} failed on ${s.name} and its files could not all be put back: ${error}. It is offline; fix it by hand, then Set idle.`, link: LINK });
        return;
      }
      // Files back as they were: the releaser's restart and idle are fine. A
      // box it already restarted under the write stays offline where it is.
      if (releaserRestarting) this.hooked.delete(s.id);
      unhold();
      publishAdminEvent({ kind: 'problem', text: `Release ${r.id} failed on ${s.name}: ${error}. Its files were put back; it was not restarted.`, link: LINK });
      return;
    }
    this.setBox(r.id, s.id, 'written');
    if (releaserRestarting) {
      // The releaser restarts it once the hook returns; afterReleaserRestart
      // records how that went. Restarted under the write: parked.
      if (hooked.stage === 'restarted') { this.hooked.delete(s.id); this.park(r.id, s.id, 'the releaser restarted it before the write finished'); }
      else hooked.stage = 'written';
      return;
    }
    if (!this.d.restarter) { unhold(); return; }
    this.queueRestart(r.id, s.id);
  }

  /**
   * Waiting for the box to empty can take minutes: done off the engine's
   * chain, so the next box and the release hook are never stuck behind it.
   * The box stays held (reserved) until its restart, goes offline for it, and
   * is idle again only once it is back. Restarts only when the box has exactly
   * no players, is still held by us, and no match is on it; anything else
   * parks it (see park).
   */
  private queueRestart(releaseId: number, serverId: number): void {
    const db = this.d.db;
    const restart = (async () => {
      const why = await this.waitEmpty(serverId);
      if (why !== null) { this.park(releaseId, serverId, why); return; }
      const s = getServer(db, serverId)!;
      markOffline(db, serverId);
      const res = await restartOutcome(this.d.restarter!, s);
      if (!res.quitSent) { this.park(releaseId, serverId, 'quit could not be sent over rcon, so the box is still running the old files'); return; }
      if (!res.back) {
        // The restarter has already reported it and the box stays offline.
        this.setBox(releaseId, serverId, 'written', 'written, but the box did not come back after the restart');
        return;
      }
      this.freeIfOurs(serverId);
      this.setBox(releaseId, serverId, 'restarted');
    })().catch((err) => {
      console.error(`[releases] restart of server ${serverId} failed:`, err);
      this.park(releaseId, serverId, err instanceof Error ? err.message : String(err));
    }).finally(() => {
      this.restarts.delete(restart);
      if (!this.canaryOutcome(releaseId)) this.settle(releaseId);
    });
    this.restarts.add(restart);
  }

  /** Written but not restarted: never back to idle, since srcds has not loaded
   *  what is on its disk. Offline while we still hold it; a box a match took
   *  meanwhile is left to that match. An admin restarts it and sets it idle. */
  private park(releaseId: number, serverId: number, why: string): void {
    const db = this.d.db;
    db.prepare("UPDATE servers SET status = 'offline' WHERE id = ? AND status = 'reserved'").run(serverId);
    this.setBox(releaseId, serverId, 'written', `written, restart pending: ${why}`);
    const name = getServer(db, serverId)?.name ?? `server ${serverId}`;
    publishAdminEvent({ kind: 'problem', text: `Release ${releaseId} is written to ${name} but it was not restarted: ${why}. Restart it when empty, then Set idle.`, link: LINK });
  }

  /** Idle again after its restart, unless something else has the box now. */
  private freeIfOurs(serverId: number): void {
    this.d.db.prepare(`UPDATE servers SET status = 'idle' WHERE id = ? AND status = 'offline'
      AND NOT EXISTS (SELECT 1 FROM matches WHERE server_id = ? AND state IN ('configuring','live'))`).run(serverId, serverId);
  }

  /** Our hold on the box: still reserved and no match on it. */
  private stillOurs(serverId: number): boolean {
    return getServer(this.d.db, serverId)?.status === 'reserved'
      && !this.d.db.prepare("SELECT 1 FROM matches WHERE server_id = ? AND state IN ('configuring','live')").get(serverId);
  }

  private async bounded<T>(writer: TreeWriter, call: (signal: AbortSignal) => Promise<T>, what: string): Promise<T> {
    const limit = this.d.opLimitMs ?? OP_LIMIT_MS[writer.kind];
    const ac = new AbortController();
    const p = call(ac.signal);
    let t: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<'timeout'>((resolve) => { t = setTimeout(() => resolve('timeout'), limit); });
    try {
      const won = await Promise.race([p.then((v) => ({ v })), timeout]);
      if (won !== 'timeout') return won.v;
    } finally { clearTimeout(t); }
    ac.abort();
    let g: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([p.catch(() => {}), new Promise<void>((resolve) => { g = setTimeout(resolve, ABORT_GRACE_MS); })]).finally(() => clearTimeout(g));
    throw new Error(`${what} timed out after ${limit / 1000} s`);
  }

  /** Resolves once every restart started so far has finished (tests, shutdown). */
  async settled(): Promise<void> {
    await this.chain;
    await Promise.all([...this.restarts]);
  }

  /** Null once the box is safe to restart, or why it is not. Never guesses:
   *  a count that cannot be read, or a box a match took, is a no. */
  private async waitEmpty(serverId: number): Promise<string | null> {
    if (!this.d.humans) return 'no way to count the players on it';
    const sleep = this.d.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
    const limit = this.d.emptyWaitMs ?? 10 * 60_000, poll = this.d.emptyPollMs ?? 60_000;
    for (let waited = 0; waited < limit; waited += poll) {
      if (!this.stillOurs(serverId)) return 'a match took the box while it waited to empty';
      let n: number;
      try { n = await this.d.humans(getServer(this.d.db, serverId)!); } catch (err) {
        return `could not count the players on it (${err instanceof Error ? err.message : String(err)})`;
      }
      if (!this.stillOurs(serverId)) return 'a match took the box while it waited to empty';
      if (n === 0) return null;
      await sleep(poll);
    }
    return `players were still on it after ${Math.round(limit / 60_000)} minutes`;
  }

  /**
   * After a site restart. Synchronous first, so that server.ts can run it
   * before the boot reconcile, which would otherwise hand a held box out as
   * idle: a box caught mid-write is parked offline, and a box whose restart
   * was lost is held again. Then, off the chain, the first is put back from
   * its backup on disk (idle again only if it was ours from idle, never if the
   * releaser had it) and the second gets its restart through the normal
   * empty-box path. Runs once.
   */
  recover(): void {
    if (this.recovered) return;
    this.recovered = true;
    const db = this.d.db;
    const matchOn = (sid: number) => !!db.prepare("SELECT 1 FROM matches WHERE server_id = ? AND state IN ('configuring','live')").get(sid);
    const stuck = db.prepare("SELECT release_id, server_id FROM release_boxes WHERE state = 'writing'").all() as { release_id: number; server_id: number }[];
    for (const b of stuck) {
      const was = getServer(db, b.server_id)?.status;
      markOffline(db, b.server_id);
      const restore = this.restoreInterrupted(b.release_id, b.server_id, was === 'reserved')
        .catch((err) => {
          this.setBox(b.release_id, b.server_id, 'failed', `interrupted by a site restart; putting the backup back failed: ${err instanceof Error ? err.message : String(err)}`);
        })
        .finally(() => { this.restarts.delete(restore); this.settle(b.release_id); });
      this.restarts.add(restore);
    }
    const lost = db.prepare("SELECT release_id, server_id FROM release_boxes WHERE state = 'written' AND error IS NULL").all() as { release_id: number; server_id: number }[];
    for (const b of lost) {
      const st = getServer(db, b.server_id)?.status;
      if (!this.d.restarter || matchOn(b.server_id) || (st !== 'reserved' && st !== 'offline')) {
        this.park(b.release_id, b.server_id, 'its restart was lost to a site restart');
        continue;
      }
      db.prepare("UPDATE servers SET status = 'reserved' WHERE id = ?").run(b.server_id);
      this.queueRestart(b.release_id, b.server_id);
    }
  }

  private async restoreInterrupted(releaseId: number, serverId: number, freeAfter: boolean): Promise<void> {
    const dir = join(this.d.releasesDir, String(releaseId), String(serverId));
    let backup: { path: string; existed: boolean }[];
    try { backup = JSON.parse(readFileSync(join(dir, 'backup.json'), 'utf8')) as typeof backup; } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      // backup.json is written before the first write: nothing on the box changed.
      this.setBox(releaseId, serverId, 'failed', 'interrupted by a site restart before any file was written');
      if (freeAfter) this.freeIfOurs(serverId);
      return;
    }
    const s = getServer(this.d.db, serverId);
    const writer = s ? (this.d.writer ?? treeWriterFor)(s) : null;
    if (!writer) throw new Error('no transport configured');
    const failed: string[] = [];
    for (const e of backup) {
      try {
        if (e.existed) await this.bounded(writer, (sig) => writer.write(e.path, readFileSync(join(dir, 'files', e.path)), sig), 'the restore');
        else await this.bounded(writer, (sig) => writer.remove(e.path, sig), 'the restore');
      } catch (err) {
        failed.push(`restoring ${e.path}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    if (failed.length) {
      this.setBox(releaseId, serverId, 'failed', `interrupted by a site restart; putting the backup back failed: ${failed.join('; ')}`);
      publishAdminEvent({ kind: 'problem', text: `Release ${releaseId} was interrupted on ${s!.name} and its files could not all be put back. It is offline; fix it by hand, then Set idle.`, link: LINK });
      return;
    }
    this.setBox(releaseId, serverId, 'failed', 'interrupted by a site restart; its files were put back');
    if (freeAfter) this.freeIfOurs(serverId);
    else publishAdminEvent({ kind: 'problem', text: `Release ${releaseId} was interrupted on ${s!.name}; its files were put back. It is offline; check it, then Set idle.`, link: LINK });
  }

  expireBackups(nowMs: number = Date.now()): number {
    const cutoff = new Date(nowMs - BACKUP_DAYS * 86_400_000).toISOString().replace('T', ' ').slice(0, 19);
    const old = this.d.db.prepare("SELECT id FROM releases WHERE backups_expired = 0 AND deployed_at IS NOT NULL AND deployed_at < ? AND state NOT IN ('deploying','canary_wait')").all(cutoff) as { id: number }[];
    for (const r of old) {
      rmSync(join(this.d.releasesDir, String(r.id)), { recursive: true, force: true });
      this.d.db.prepare('UPDATE releases SET backups_expired = 1 WHERE id = ?').run(r.id);
    }
    return old.length;
  }

  start(): void {
    if (this.timer) return;
    this.recover();
    this.timer = setInterval(() => { void this.tick(); this.expireBackups(); }, this.d.tickMs ?? 30_000);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
