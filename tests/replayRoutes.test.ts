import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, utimesSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify from 'fastify';
import { replayRoutes } from '../src/routes/replays.js';
import { openDb, type DB } from '../src/db.js';
import { buildServer } from '../src/server.js';
import { loadConfig } from '../src/config.js';
import { stubOrchestrator } from './helpers.js';
import {
  encodeHeader, encodeFrame, decodeHeader, VERSION, HEADER_BYTES,
  PLAYER_SLOTS, frameBytes, type ReplayHeader, type Frame,
} from '../src/replayFormat.js';

const TOKEN = 'a'.repeat(32);

function header(over: Partial<ReplayHeader> = {}): ReplayHeader {
  return {
    version: VERSION, token: TOKEN, ordinal: 0, half: 1,
    playerHz: 10, entityHz: 10, map: 'l4d_vs_farm01_hilltop',
    startedUnix: Math.floor(Date.now() / 1000) - 600,
    indexOffset: 0, indexCount: 0, frameCount: 0,
    slots: ['', '', '', '', '', '', '', ''],
    ...over,
  };
}

function emptyFrame(tMs: number): Frame {
  return {
    tMs, offset: 0,
    players: Array.from({ length: PLAYER_SLOTS }, (_, slot) => ({
      slot, x: 0, y: 0, z: 0, yaw: 0, pitch: 0, state: 0,
      health: 0, temp: 0, cls: 0, weapon: 0, clip: 0, reserve: 0,
    })),
    entities: [],
  };
}

let dir: string;
let app: ReturnType<typeof Fastify>;
let db: DB;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'rplroutes-'));
  db = openDb(':memory:');
  app = Fastify();
  await app.register(replayRoutes, { db, replayDir: dir });
  await app.ready();
});
afterEach(async () => {
  await app.close();
  rmSync(dir, { recursive: true, force: true });
});

/** Write a file whose frames run from t=0 at `startedSecondsAgo` seconds ago,
 *  one frame per second, so the delay cutoff is easy to reason about. */
function writeRound(
  name: string, frames: number, startedSecondsAgo: number, closed: boolean,
  version = VERSION,
): void {
  const parts: Uint8Array[] = [
    encodeHeader(header({
      version,
      startedUnix: Math.floor(Date.now() / 1000) - startedSecondsAgo,
      frameCount: closed ? frames : 0,
    })),
  ];
  for (let i = 0; i < frames; i++) parts.push(encodeFrame(emptyFrame(i * 1000)));
  const path = join(dir, name);
  writeFileSync(path, Buffer.concat(parts));
  const secs = Date.now() / 1000;
  utimesSync(path, secs, secs);
}

/** Insert a `matches` row and a `match_replays` row pointing at `filename`.
 *  Returns the match id. Mirrors the pattern in tests/replayPrune.test.ts.
 *
 *  The match's token is taken from the filename rather than hardcoded to
 *  TOKEN, because in production the two are always the same thing: the plugin
 *  names every file `pug_<token>_<ordinal>_<half>.rpl` under the token the
 *  orchestrator handed it. A fixture that pairs one match token with another
 *  session's file describes a state that cannot occur. */
function seedMatchReplay(
  filename: string, ordinal: number, half: number, bytes: number, frames: number,
): number {
  const token = /^pug_([0-9a-f]{32})_/.exec(filename)?.[1] ?? TOKEN;
  db.prepare(
    `INSERT INTO matches (season_id, state, campaign, token) VALUES (1, 'live', 'no_mercy', ?)`,
  ).run(token);
  const id = (db.prepare('SELECT MAX(id) AS id FROM matches').get() as { id: number }).id;
  db.prepare(
    `INSERT INTO match_replays (match_id, ordinal, half, filename, bytes, frames, sample_hz)
     VALUES (?, ?, ?, ?, ?, ?, 10)`,
  ).run(id, ordinal, half, filename, bytes, frames);
  return id;
}

describe('GET /api/replays/sessions', () => {
  it('lists sessions grouped by token', async () => {
    writeRound(`pug_${TOKEN}_0_1.rpl`, 5, 600, true);
    const res = await app.inject({ url: '/api/replays/sessions' });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { sessions: { token: string; files: unknown[] }[] };
    expect(body.sessions).toHaveLength(1);
    expect(body.sessions[0].token).toBe(TOKEN);
  });

  // This page exists for the standalone `!mix` files, which have no match
  // page to be reached through. A ranked session is reachable through its
  // match page and its token is the seed for the game server's sv_password,
  // so listing it here would publish a way into a private match.
  it('omits a session whose token belongs to a match', async () => {
    writeRound(`pug_${TOKEN}_0_1.rpl`, 5, 600, true);
    seedMatchReplay(`pug_${TOKEN}_0_1.rpl`, 0, 1, 0, 5);
    const res = await app.inject({ url: '/api/replays/sessions' });
    expect((res.json() as { sessions: unknown[] }).sessions).toEqual([]);
    expect(res.payload).not.toContain(TOKEN);
  });

  it('omits a match session even when only a later map was claimed', async () => {
    writeRound(`pug_${TOKEN}_0_1.rpl`, 5, 600, true);
    writeRound(`pug_${TOKEN}_1_1.rpl`, 5, 600, true);
    seedMatchReplay(`pug_${TOKEN}_1_1.rpl`, 1, 1, 0, 5);
    const res = await app.inject({ url: '/api/replays/sessions' });
    expect((res.json() as { sessions: unknown[] }).sessions).toEqual([]);
  });

  it('keeps a standalone session when an unrelated match has replays', async () => {
    const other = 'd'.repeat(32);
    writeRound(`pug_${TOKEN}_0_1.rpl`, 5, 600, true);
    seedMatchReplay(`pug_${other}_0_1.rpl`, 0, 1, 0, 5);
    const body = (await app.inject({ url: '/api/replays/sessions' }))
      .json() as { sessions: { token: string }[] };
    expect(body.sessions.map((s) => s.token)).toEqual([TOKEN]);
  });

  // The round-one window. match_replays rows are only written at round_end,
  // so for the whole of a ranked match's first round there is no row to
  // filter on, and a listing keyed on those rows published the token of a
  // match that was in progress: precisely when the sv_password it seeds
  // matters most. The matches row exists from the moment the orchestrator
  // takes a server, so filtering on matches.token has no window.
  it('omits a ranked session in its first round, before any match_replays row', async () => {
    writeRound(`pug_${TOKEN}_0_1.rpl`, 5, 30, false);
    db.prepare(
      `INSERT INTO matches (season_id, state, campaign, token) VALUES (1, 'live', 'no_mercy', ?)`,
    ).run(TOKEN);
    expect(db.prepare('SELECT COUNT(*) AS n FROM match_replays').get())
      .toEqual({ n: 0 });
    const res = await app.inject({ url: '/api/replays/sessions' });
    expect((res.json() as { sessions: unknown[] }).sessions).toEqual([]);
    expect(res.payload).not.toContain(TOKEN);
  });
});

describe('GET /api/replays/live/match/:id', () => {
  // BEHAVIOUR REVERSAL. This route used to answer with the filename, which is
  // `pug_<token>_<ordinal>_<half>.rpl`: the token was therefore in the
  // response, and the client then put it in a public URL. It now answers with
  // the (ordinal, half) pair, which the client turns into bytes through
  // /api/replays/match/:id/:ordinal/:half. Nothing derived from the token
  // crosses the wire.
  it('identifies the newest round by ordinal and half, never by filename', async () => {
    writeRound(`pug_${TOKEN}_0_1.rpl`, 5, 600, true);
    writeRound(`pug_${TOKEN}_1_1.rpl`, 5, 60, false);
    const id = seedMatchReplay(`pug_${TOKEN}_0_1.rpl`, 0, 1, 0, 5);
    const res = await app.inject({ url: `/api/replays/live/match/${id}` });
    expect(res.json()).toEqual({ ordinal: 1, half: 1, closed: false });
    expect(res.payload).not.toContain(TOKEN);
    expect(res.payload).not.toContain('.rpl');
  });

  it('404s an unknown match id', async () => {
    writeRound(`pug_${TOKEN}_0_1.rpl`, 5, 600, true);
    const res = await app.inject({ url: '/api/replays/live/match/9999' });
    expect(res.statusCode).toBe(404);
  });

  it('404s a non-numeric match id rather than 500ing', async () => {
    const res = await app.inject({ url: '/api/replays/live/match/abc' });
    expect(res.statusCode).toBe(404);
  });

  it('404s a match with no replay on disk', async () => {
    const id = seedMatchReplay(`pug_${TOKEN}_0_1.rpl`, 0, 1, 0, 5);
    const res = await app.inject({ url: `/api/replays/live/match/${id}` });
    expect(res.statusCode).toBe(404);
  });
});

describe('GET /api/replays/file/:name', () => {
  it('serves a closed file whole', async () => {
    writeRound(`pug_${TOKEN}_0_1.rpl`, 5, 600, true);
    const res = await app.inject({ url: `/api/replays/file/pug_${TOKEN}_0_1.rpl` });
    expect(res.statusCode).toBe(200);
    expect(res.rawPayload.length).toBe(HEADER_BYTES + frameBytes(0) * 5);
    expect(res.headers['x-replay-closed']).toBe('1');
  });

  it('serves only the bytes after `since`', async () => {
    writeRound(`pug_${TOKEN}_0_1.rpl`, 5, 600, true);
    const since = HEADER_BYTES + frameBytes(0) * 2;
    const res = await app.inject({ url: `/api/replays/file/pug_${TOKEN}_0_1.rpl?since=${since}` });
    expect(res.rawPayload.length).toBe(frameBytes(0) * 3);
    expect(res.headers['x-replay-next']).toBe(String(HEADER_BYTES + frameBytes(0) * 5));
  });

  it('floors a fractional `since` instead of erroring', async () => {
    writeRound(`pug_${TOKEN}_0_1.rpl`, 5, 600, true);
    const floored = HEADER_BYTES + frameBytes(0) * 2;
    const fractional = floored + 0.5;
    const res = await app.inject({ url: `/api/replays/file/pug_${TOKEN}_0_1.rpl?since=${fractional}` });
    expect(res.statusCode).toBe(200);
    const expected = await app.inject({ url: `/api/replays/file/pug_${TOKEN}_0_1.rpl?since=${floored}` });
    expect(res.rawPayload.equals(expected.rawPayload)).toBe(true);
  });

  it('does not 500 on a non-numeric `since`', async () => {
    writeRound(`pug_${TOKEN}_0_1.rpl`, 5, 600, true);
    const res = await app.inject({ url: `/api/replays/file/pug_${TOKEN}_0_1.rpl?since=abc` });
    expect(res.statusCode).toBe(200);
  });

  // THE test. Everything else in this file is plumbing; this is the security
  // model of a public live page. The round started 15 seconds ago and has 15
  // frames at one per second, so frames t=0..4 are older than the 10 second
  // delay and frames t=5..14 are not.
  it('never serves a byte past the cutoff for an open file', async () => {
    writeRound(`pug_${TOKEN}_0_1.rpl`, 15, 15, false);
    const res = await app.inject({ url: `/api/replays/file/pug_${TOKEN}_0_1.rpl` });
    expect(res.statusCode).toBe(200);
    expect(res.headers['x-replay-closed']).toBe('0');

    const served = res.rawPayload.length;
    const whole = HEADER_BYTES + frameBytes(0) * 15;
    expect(served).toBeLessThan(whole);
    // At most six frames: the five certainly outside the window, plus one for
    // the second that may have ticked over between writing and serving.
    const frames = (served - HEADER_BYTES) / frameBytes(0);
    expect(frames).toBeGreaterThanOrEqual(4);
    expect(frames).toBeLessThanOrEqual(6);
  });

  // The same model under a tech pause, which is routine in ranked play. A
  // genuine engine pause stops game time while wall time runs on, so a round
  // that went live 60 seconds ago can hold only 30 seconds of frames. The
  // delay has to be measured against the game clock the frames are stamped
  // on, or every frame in the file looks 30 seconds older than it is and the
  // newest one, carrying live ghost positions, goes straight out.
  it('holds back the newest frames when the round has been paused', async () => {
    writeRound(`pug_${TOKEN}_0_1.rpl`, 30, 60, false);
    const res = await app.inject({ url: `/api/replays/file/pug_${TOKEN}_0_1.rpl` });
    expect(res.statusCode).toBe(200);

    const frames = (res.rawPayload.length - HEADER_BYTES) / frameBytes(0);
    // Newest is t=29000, so nothing past t=19000 may go out: 20 frames, plus
    // at most one for a second ticking over mid-test.
    expect(frames).toBeGreaterThanOrEqual(19);
    expect(frames).toBeLessThanOrEqual(21);
  });

  // The ceiling parseReplay already applies, on the path that actually
  // serves bytes. A newer writer may change a record's size, and the cutoff
  // is computed from the tMs this decoder reads, so a version this reader
  // does not understand could release bytes it should not.
  it('releases nothing from an open file written by a newer version', async () => {
    writeRound(`pug_${TOKEN}_0_1.rpl`, 15, 600, false, VERSION + 1);
    const res = await app.inject({ url: `/api/replays/file/pug_${TOKEN}_0_1.rpl` });
    expect(res.statusCode).toBe(200);
    expect(res.rawPayload.length).toBe(0);
    expect(res.headers['x-replay-next']).toBe('0');
  });

  // The adversarial half of the cutoff test above. A client that asks for a
  // `since` past the whole file must not be handed anything, and the offset
  // it is told to come back with must be the cutoff, never the file size: a
  // `since` of the file size would otherwise walk it straight past the delay
  // on its next poll.
  it('answers a `since` beyond the file with nothing, and the cutoff as next', async () => {
    writeRound(`pug_${TOKEN}_0_1.rpl`, 15, 15, false);
    const whole = HEADER_BYTES + frameBytes(0) * 15;
    const res = await app.inject({
      url: `/api/replays/file/pug_${TOKEN}_0_1.rpl?since=${whole + 10_000}`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.rawPayload.length).toBe(0);

    const next = Number(res.headers['x-replay-next']);
    expect(next).toBeLessThan(whole);
    const cutoff = Number(
      (await app.inject({ url: `/api/replays/file/pug_${TOKEN}_0_1.rpl` }))
        .headers['x-replay-next'],
    );
    expect(next).toBe(cutoff);
  });

  // BEHAVIOUR REVERSAL. This used to assert the served header carries the
  // token. It does not any more: the header goes out from the first second of
  // a round on a public route, and for a ranked match those 32 bytes seed the
  // game server's sv_password. The header is still served whole and still
  // decodes; only the token field is blanked. Everything else the client
  // actually reads (map, slots, hz, version) is untouched.
  it('serves the header alone when no frame is old enough yet, with the token blanked', async () => {
    writeRound(`pug_${TOKEN}_0_1.rpl`, 3, 2, false);
    const res = await app.inject({ url: `/api/replays/file/pug_${TOKEN}_0_1.rpl` });
    expect(res.rawPayload.length).toBe(HEADER_BYTES);
    const h = decodeHeader(res.rawPayload);
    expect(h?.token).toBe('');
    expect(h?.map).toBe('l4d_vs_farm01_hilltop');
    expect(h?.version).toBe(VERSION);
    expect(res.rawPayload.includes(TOKEN)).toBe(false);
  });

  it('blanks the token in a whole closed file too, without moving any other byte', async () => {
    writeRound(`pug_${TOKEN}_0_1.rpl`, 5, 600, true);
    const res = await app.inject({ url: `/api/replays/file/pug_${TOKEN}_0_1.rpl` });
    expect(res.rawPayload.length).toBe(HEADER_BYTES + frameBytes(0) * 5);
    expect(res.headers['content-length']).toBe(String(HEADER_BYTES + frameBytes(0) * 5));
    expect(res.rawPayload.includes(TOKEN)).toBe(false);
    const h = decodeHeader(res.rawPayload);
    expect(h?.token).toBe('');
    expect(h?.frameCount).toBe(5);
    // The frames after the header must be byte-identical to what is on disk,
    // which is what proves the token was overwritten in place rather than
    // removed.
    const onDisk = readFileSync(join(dir, `pug_${TOKEN}_0_1.rpl`));
    expect(res.rawPayload.subarray(HEADER_BYTES).equals(onDisk.subarray(HEADER_BYTES))).toBe(true);
  });

  it('blanks the token on a partial slice that starts inside the token field', async () => {
    writeRound(`pug_${TOKEN}_0_1.rpl`, 5, 600, true);
    // A `since` this server would never hand out, but the route must not
    // leak the tail of the token to a client that asks for it by hand.
    const res = await app.inject({ url: `/api/replays/file/pug_${TOKEN}_0_1.rpl?since=20` });
    expect(res.statusCode).toBe(200);
    expect(res.rawPayload.includes('a'.repeat(8))).toBe(false);
  });

  it('serves nothing but the token blanked when the slice stops short of the frames', async () => {
    writeRound(`pug_${TOKEN}_0_1.rpl`, 5, 600, true);
    const res = await app.inject({ url: `/api/replays/file/pug_${TOKEN}_0_1.rpl?since=0` });
    // The head buffer is 44 bytes and the rest is streamed; the join must not
    // duplicate or drop a byte.
    expect(res.rawPayload.length).toBe(HEADER_BYTES + frameBytes(0) * 5);
  });

  it('404s a traversal attempt', async () => {
    const res = await app.inject({ url: '/api/replays/file/..%2F..%2Fetc%2Fpasswd' });
    expect(res.statusCode).toBe(404);
  });

  it('404s an unknown file', async () => {
    const res = await app.inject({ url: `/api/replays/file/pug_${'b'.repeat(32)}_0_1.rpl` });
    expect(res.statusCode).toBe(404);
  });
});

describe('GET /api/replays/live/:token', () => {
  it('names the newest file for the token', async () => {
    writeRound(`pug_${TOKEN}_0_1.rpl`, 5, 600, true);
    writeRound(`pug_${TOKEN}_1_1.rpl`, 5, 60, false);
    const res = await app.inject({ url: `/api/replays/live/${TOKEN}` });
    expect(res.json()).toEqual({ filename: `pug_${TOKEN}_1_1.rpl`, closed: false });
  });

  it('404s an unknown token', async () => {
    const res = await app.inject({ url: `/api/replays/live/${'c'.repeat(32)}` });
    expect(res.statusCode).toBe(404);
  });
});

describe('GET /api/replays/match/:id/:ordinal/:half', () => {
  it('serves a closed file whole via a match_replays row', async () => {
    writeRound(`pug_${TOKEN}_0_1.rpl`, 5, 600, true);
    const id = seedMatchReplay(`pug_${TOKEN}_0_1.rpl`, 0, 1, 0, 5);
    const res = await app.inject({ url: `/api/replays/match/${id}/0/1` });
    expect(res.statusCode).toBe(200);
    expect(res.rawPayload.length).toBe(HEADER_BYTES + frameBytes(0) * 5);
    expect(res.headers['x-replay-closed']).toBe('1');
  });

  it('404s an unknown match id', async () => {
    const id = seedMatchReplay(`pug_${TOKEN}_0_1.rpl`, 0, 1, 0, 5);
    writeRound(`pug_${TOKEN}_0_1.rpl`, 5, 600, true);
    const res = await app.inject({ url: `/api/replays/match/${id + 999}/0/1` });
    expect(res.statusCode).toBe(404);
  });

  it('404s an unknown ordinal', async () => {
    const id = seedMatchReplay(`pug_${TOKEN}_0_1.rpl`, 0, 1, 0, 5);
    writeRound(`pug_${TOKEN}_0_1.rpl`, 5, 600, true);
    const res = await app.inject({ url: `/api/replays/match/${id}/9/1` });
    expect(res.statusCode).toBe(404);
  });

  it('404s an unknown half', async () => {
    const id = seedMatchReplay(`pug_${TOKEN}_0_1.rpl`, 0, 1, 0, 5);
    writeRound(`pug_${TOKEN}_0_1.rpl`, 5, 600, true);
    const res = await app.inject({ url: `/api/replays/match/${id}/0/2` });
    expect(res.statusCode).toBe(404);
  });

  it('404s a row whose file is missing from disk', async () => {
    // No writeRound call: the row exists but nothing was ever written for it,
    // which is exactly what a pruned or never-flushed file looks like.
    const id = seedMatchReplay(`pug_${TOKEN}_0_1.rpl`, 0, 1, 0, 5);
    const res = await app.inject({ url: `/api/replays/match/${id}/0/1` });
    expect(res.statusCode).toBe(404);
  });

  // The live viewer's only route to bytes now that it is given an
  // (ordinal, half) pair instead of a filename. match_replays rows are
  // written at round_end, so the round the live page actually wants has no
  // row at all: without the fallback to the match's own token this 404s for
  // the entire round, which would be the live viewer broken outright.
  it('serves the round in progress, which has no match_replays row yet', async () => {
    writeRound(`pug_${TOKEN}_0_1.rpl`, 15, 15, false);
    db.prepare(
      `INSERT INTO matches (season_id, state, campaign, token) VALUES (1, 'live', 'no_mercy', ?)`,
    ).run(TOKEN);
    const id = (db.prepare('SELECT MAX(id) AS id FROM matches').get() as { id: number }).id;
    const res = await app.inject({ url: `/api/replays/match/${id}/0/1` });
    expect(res.statusCode).toBe(200);
    expect(res.headers['x-replay-closed']).toBe('0');
    expect(res.rawPayload.length).toBeGreaterThanOrEqual(HEADER_BYTES);
    // Still the cutoff, not the whole file, and still no token.
    expect(res.rawPayload.length).toBeLessThan(HEADER_BYTES + frameBytes(0) * 15);
    expect(res.rawPayload.includes(TOKEN)).toBe(false);
  });

  it('404s a rowless round whose match has no token', async () => {
    writeRound(`pug_${TOKEN}_0_1.rpl`, 5, 600, true);
    db.prepare(
      `INSERT INTO matches (season_id, state, campaign) VALUES (1, 'configuring', 'no_mercy')`,
    ).run();
    const id = (db.prepare('SELECT MAX(id) AS id FROM matches').get() as { id: number }).id;
    const res = await app.inject({ url: `/api/replays/match/${id}/0/1` });
    expect(res.statusCode).toBe(404);
  });

  // The row says nothing about liveness; only re-resolving by name against
  // the file on disk can. A match's current map is live too, so a row
  // pointing at a file still being written must still get the cutoff.
  it('applies the cutoff, not the whole file, when the row points at an open file', async () => {
    writeRound(`pug_${TOKEN}_0_1.rpl`, 15, 15, false);
    const id = seedMatchReplay(`pug_${TOKEN}_0_1.rpl`, 0, 1, 0, 0);
    const res = await app.inject({ url: `/api/replays/match/${id}/0/1` });
    expect(res.statusCode).toBe(200);
    expect(res.headers['x-replay-closed']).toBe('0');
    const whole = HEADER_BYTES + frameBytes(0) * 15;
    expect(res.rawPayload.length).toBeLessThan(whole);
  });
});

describe('non-numeric route parameters', () => {
  it('404s, not 500s, a non-numeric match id/ordinal/half', async () => {
    const res = await app.inject({ url: '/api/replays/match/abc/0/1' });
    expect(res.statusCode).toBe(404);
  });
});

describe('GET /api/replays/timeline/:matchId/:ordinal/:half', () => {
  it('returns events and chat for that map and half, in sequence order', async () => {
    // Build an app with a db you can seed. Follow the same buildApp pattern
    // the rest of this file uses, keeping a handle on the db.
    const db = openDb(':memory:');
    // season_id and campaign are NOT NULL and state is CHECK-constrained, none
    // of which the brief's original one-liner satisfied; season_id 1 comes
    // from openDb's own seed(), and 'completed' is a real state a finished
    // match's timeline would be read back under.
    db.prepare(
      'INSERT INTO matches (id, season_id, campaign, token, state) VALUES (1, 1, ?, ?, ?)',
    ).run('no_mercy', 't'.repeat(32), 'completed');
    db.prepare(
      `INSERT INTO match_live_events (match_id, seq, kind, actor, target, value, map_ordinal, half, t_ms)
       VALUES (1, 1, 'pounce', 'A', 'B', 20, 0, 1, 5000)`,
    ).run();
    db.prepare(
      `INSERT INTO match_chat (match_id, seq, map_ordinal, half, t_ms, steamid, team, message)
       VALUES (1, 2, 0, 1, 6000, 'A', 'survivor', 'nice')`,
    ).run();
    // Another map: must not appear.
    db.prepare(
      `INSERT INTO match_live_events (match_id, seq, kind, actor, target, value, map_ordinal, half, t_ms)
       VALUES (1, 3, 'pounce', 'A', 'B', 20, 1, 1, 7000)`,
    ).run();
    // Untimed, from before the t_ms column existed: must not appear, because
    // it cannot be placed on the timeline at all.
    db.prepare(
      `INSERT INTO match_live_events (match_id, seq, kind, actor, target, value, map_ordinal, half, t_ms)
       VALUES (1, 4, 'pounce', 'A', 'B', 20, 0, 1, -1)`,
    ).run();

    const app2 = Fastify();
    await app2.register(replayRoutes, { db, replayDir: dir });
    await app2.ready();

    const res = await app2.inject({ url: '/api/replays/timeline/1/0/1' });
    const body = res.json() as { entries: { seq: number; kind: string }[] };
    expect(body.entries.map((e) => [e.seq, e.kind])).toEqual([[1, 'event'], [2, 'chat']]);
    await app2.close();
  });

  // match_chat is fed from player_say, which does not distinguish team chat
  // from all chat. Serving it for a match in progress would let a survivor
  // poll the infected team's chat verbatim and in real time, on a public
  // endpoint, while the frames on the same page are held ten seconds back.
  it('404s a match that is not completed, so live chat is never served', async () => {
    const db = openDb(':memory:');
    db.prepare(
      'INSERT INTO matches (id, season_id, campaign, token, state) VALUES (1, 1, ?, ?, ?)',
    ).run('no_mercy', 't'.repeat(32), 'live');
    db.prepare(
      `INSERT INTO match_chat (match_id, seq, map_ordinal, half, t_ms, steamid, team, message)
       VALUES (1, 1, 0, 1, 6000, 'A', 'infected', 'rushing left')`,
    ).run();

    const app2 = Fastify();
    await app2.register(replayRoutes, { db, replayDir: dir });
    await app2.ready();

    const res = await app2.inject({ url: '/api/replays/timeline/1/0/1' });
    expect(res.statusCode).toBe(404);
    expect(res.payload).not.toContain('rushing left');
    await app2.close();
  });

  it('404s an unknown match id', async () => {
    const res = await app.inject({ url: '/api/replays/timeline/9999/0/1' });
    expect(res.statusCode).toBe(404);
  });
});

describe('replayRoutes registration on the real server', () => {
  it('is registered on the real server', async () => {
    // Every other test in this file registers replayRoutes directly onto a bare
    // Fastify instance, which is the right harness for exercising the cutoff but
    // proves nothing about src/server.ts. This one test exists so that deleting
    // the register line there fails something.
    writeRound(`pug_${TOKEN}_0_1.rpl`, 5, 600, true);
    const real = await buildServer({
      config: loadConfig({ REPLAY_DIR: dir }),
      db: openDb(':memory:'),
      orchestrator: stubOrchestrator(),
    });
    const res = await real.inject({ url: '/api/replays/sessions' });
    expect(res.statusCode).toBe(200);
    await real.close();
  });
});
