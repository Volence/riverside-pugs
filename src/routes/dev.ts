import type { FastifyInstance } from 'fastify';
import type { DB } from '../db.js';
import type { Matchmaker } from '../matchmaker.js';
import type { Config } from '../config.js';
import { upsertPlayer, activatePlayer } from '../players.js';
import { setSession } from '../session.js';
import { QUEUE_SIZE } from '../queue.js';
import type { Hub } from '../ws.js';
import { completeMatch } from '../matchResult.js';
import type { Dump } from '../dumpParse.js';

export interface DevRouteOpts {
  config: Config;
  db: DB;
  matchmaker: Matchmaker;
  hub: Hub;
}

let fakeSeq = 0;

export async function devRoutes(app: FastifyInstance, opts: DevRouteOpts): Promise<void> {
  const { db, matchmaker } = opts;

  app.get('/api/dev/enabled', async () => ({ ok: true }));

  /** Log in as any steamid without Steam. */
  app.post('/api/dev/login', async (req, reply) => {
    const { steamid } = (req.body ?? {}) as { steamid?: string };
    if (!steamid || !/^\d{17}$/.test(steamid)) {
      return reply.code(400).send({ error: 'steamid must be 17 digits' });
    }
    upsertPlayer(db, { steamid, name: `dev_${steamid.slice(-4)}`, avatar: null }, []);
    activatePlayer(db, steamid);
    setSession(reply, steamid, opts.config.publicUrl.startsWith('https://'));
    return { ok: true, steamid };
  });

  /** Create fake active players and queue them until the queue would pop. */
  app.post('/api/dev/fill', async () => {
    const added: string[] = [];
    while (added.length < QUEUE_SIZE) {
      const steamid = `76561199000000${String(++fakeSeq).padStart(3, '0')}`;
      upsertPlayer(db, { steamid, name: `fake_${fakeSeq}`, avatar: null }, []);
      activatePlayer(db, steamid);
      const res = matchmaker.join(steamid);
      if (!res.ok) break;
      added.push(steamid);
      if (matchmaker.stateFor(steamid).lobby) break; // lobby popped, stop filling
    }
    return { ok: true, added };
  });

  /** Ready-up every player currently in any lobby. */
  app.post('/api/dev/ready-all', async () => {
    for (const steamid of matchmaker.lobbyMembers()) matchmaker.ready(steamid);
    return { ok: true };
  });

  /** Vote for every player in any lobby (default: first campaign in the pool). */
  app.post('/api/dev/vote-all', async (req) => {
    const { campaign } = (req.body ?? {}) as { campaign?: string };
    for (const steamid of matchmaker.lobbyMembers()) {
      matchmaker.vote(steamid, campaign ?? 'no_mercy');
    }
    return { ok: true };
  });

  /** Abort all open matches so the pipeline can be exercised repeatedly.
      (Until sub-project 2, matches otherwise sit in 'configuring' forever.) */
  app.post('/api/dev/clear-matches', async () => {
    db.prepare("UPDATE matches SET state = 'aborted' WHERE state IN ('configuring','live')").run();
    opts.hub.broadcast('refresh');
    return { ok: true };
  });

  function fakeDump(matchId: number, campaign: string, players: { player_id: string; team: 'a' | 'b' }[]): Dump {
    const rnd = (n: number) => Math.floor(Math.random() * n);
    const maps = Array.from({ length: 4 }, (_, i) => ({ map: `${campaign}_m${i + 1}`, a: rnd(400), b: rnd(400) }));
    const totalA = maps.reduce((s, m) => s + m.a, 0);
    const totalB = maps.reduce((s, m) => s + m.b, 0);
    return {
      matchId, maps,
      players: players.map((p) => ({
        steamid: p.player_id, team: p.team,
        sidmg: rnd(2500), sikill: rnd(40), ck: rnd(600), ff: rnd(120), rev: rnd(8),
      })),
      skillDetect: false,
      skills: [],
      winner: totalA === totalB ? 'draw' : totalA > totalB ? 'a' : 'b',
      totalA, totalB,
    };
  }

  function finishOpenMatch(): number | null {
    const row = db.prepare("SELECT id, campaign FROM matches WHERE state IN ('configuring','live') ORDER BY id DESC LIMIT 1")
      .get() as { id: number; campaign: string } | undefined;
    if (!row) return null;
    const players = db.prepare('SELECT player_id, team FROM match_players WHERE match_id = ?')
      .all(row.id) as { player_id: string; team: 'a' | 'b' }[];
    completeMatch(db, row.id, fakeDump(row.id, row.campaign, players));
    opts.hub.broadcast('refresh');
    return row.id;
  }

  /** Complete the newest open match with fabricated scores/stats + real rating updates. */
  app.post('/api/dev/finish-match', async (_req, reply) => {
    const matchId = finishOpenMatch();
    if (matchId === null) return reply.code(409).send({ error: 'no open match' });
    return { ok: true, matchId };
  });

  /** One-click full fake match: fill queue → ready → vote → finish. */
  app.post('/api/dev/simulate-match', async (_req, reply) => {
    await app.inject({ method: 'POST', url: '/api/dev/fill' });
    await app.inject({ method: 'POST', url: '/api/dev/ready-all' });
    await app.inject({ method: 'POST', url: '/api/dev/vote-all' });
    const matchId = finishOpenMatch();
    if (matchId === null) return reply.code(409).send({ error: 'simulation did not produce an open match' });
    return { ok: true, matchId };
  });
}
