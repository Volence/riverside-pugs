import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { openDb, type DB } from '../src/db.js';
import { EndWatch, statusSaysEnded } from '../src/endWatch.js';

const TOKEN = '0123456789abcdef0123456789abcdef';
const status = (state: string, match: number, token = TOKEN) =>
  `STATUS state=${state} match=${match} token=${token} campaign=no_mercy map=l4d_vs_hospital01_apartment stopAfterMap=(none)\nSTATUS half a=0 b=0\n`;

let db: DB;
let mid: number;
beforeEach(() => {
  db = openDb(':memory:');
  db.prepare("INSERT INTO servers (name, host, port, rcon_port, rcon_password, status) VALUES ('t','127.0.0.1',27015,27015,'x','live')").run();
  mid = Number(db.prepare(
    "INSERT INTO matches (season_id, state, campaign, server_id, token) VALUES (1, 'live', 'no_mercy', 1, ?)",
  ).run(TOKEN).lastInsertRowid);
});
afterEach(() => { vi.useRealTimers(); });

function watch(body: () => string | Promise<string>, opts: { now?: () => number } = {}) {
  const collected: number[] = [];
  const probes: number[] = [];
  const w = new EndWatch({
    db,
    status: async (server) => { probes.push(server.id); return body(); },
    collect: (id) => { collected.push(id); },
    delayMs: 10,
    sweepEveryMs: 1000,
    ...opts,
  });
  return { w, collected, probes };
}

describe('statusSaysEnded', () => {
  it('needs state ended, this match id and this token', () => {
    expect(statusSaysEnded(status('ended', 7), 7, TOKEN)).toBe(true);
    expect(statusSaysEnded(status('live', 7), 7, TOKEN)).toBe(false);
    expect(statusSaysEnded(status('ended', 8), 7, TOKEN)).toBe(false);
    expect(statusSaysEnded(status('ended', 7, 'f'.repeat(32)), 7, TOKEN)).toBe(false);
    expect(statusSaysEnded('', 7, TOKEN)).toBe(false);
    expect(statusSaysEnded('Unknown command "sm_pug_status"', 7, TOKEN)).toBe(false);
  });
});

describe('EndWatch', () => {
  // Match 1143: the game ended, MATCH_END was lost, the plugin sat in
  // state ended with the result, and the site never asked.
  it('collects a live match its server says has ended', async () => {
    const { w, collected } = watch(() => status('ended', mid));
    expect(await w.check(mid)).toBe(true);
    expect(collected).toEqual([mid]);
  });

  it('leaves a match alone while its server says it is live', async () => {
    const { w, collected } = watch(() => status('live', mid));
    expect(await w.check(mid)).toBe(false);
    expect(collected).toEqual([]);
  });

  it('does not collect when the server holds a different match or token', async () => {
    const other = watch(() => status('ended', mid + 1));
    expect(await other.w.check(mid)).toBe(false);
    const forged = watch(() => status('ended', mid, 'f'.repeat(32)));
    expect(await forged.w.check(mid)).toBe(false);
    expect([...other.collected, ...forged.collected]).toEqual([]);
  });

  it('does nothing for a match that is no longer live', async () => {
    db.prepare("UPDATE matches SET state = 'completed' WHERE id = ?").run(mid);
    const { w, collected, probes } = watch(() => status('ended', mid));
    expect(await w.check(mid)).toBe(false);
    expect(probes).toEqual([]);
    expect(collected).toEqual([]);
  });

  // A MATCH_END that lands during the rcon round trip starts the collection
  // itself; the watch must not start a second one.
  it('stands down when the match stopped being live during the probe', async () => {
    const { w, collected } = watch(() => {
      db.prepare("UPDATE matches SET state = 'completed' WHERE id = ?").run(mid);
      return status('ended', mid);
    });
    expect(await w.check(mid)).toBe(false);
    expect(collected).toEqual([]);
  });

  it('survives an rcon failure', async () => {
    const { w, collected } = watch(() => { throw new Error('rcon connect timeout'); });
    expect(await w.check(mid)).toBe(false);
    expect(collected).toEqual([]);
  });

  it('checks once, a little after a nudge, however many nudges arrive', async () => {
    vi.useFakeTimers();
    const { w, collected, probes } = watch(() => status('ended', mid));
    w.nudge(TOKEN);
    w.nudge(TOKEN);
    w.nudge(TOKEN);
    expect(probes).toEqual([]);
    await vi.advanceTimersByTimeAsync(20);
    expect(probes).toEqual([1]);
    expect(collected).toEqual([mid]);
  });

  it('ignores a nudge for a token with no live match', async () => {
    vi.useFakeTimers();
    const { w, probes } = watch(() => status('ended', mid));
    w.nudge('f'.repeat(32));
    await vi.advanceTimersByTimeAsync(20);
    expect(probes).toEqual([]);
  });

  it('sweeps each live match once per interval, starting the clock on first sight', async () => {
    let t = 0;
    const { w, probes } = watch(() => status('live', mid), { now: () => t });
    await w.sweep();
    expect(probes).toEqual([]);          // first sight: clock started, nobody dialled
    t = 500;
    await w.sweep();
    expect(probes).toEqual([]);          // not due yet
    t = 1000;
    await w.sweep();
    expect(probes).toEqual([1]);         // due
    t = 1500;
    await w.sweep();
    expect(probes).toEqual([1]);
  });
});
