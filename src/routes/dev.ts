import type { FastifyInstance } from 'fastify';
import type { DB } from '../db.js';
import type { Matchmaker } from '../matchmaker.js';
import type { Config } from '../config.js';
import { upsertPlayer, activatePlayer } from '../players.js';
import { setSession } from '../session.js';
import { QUEUE_SIZE } from '../queue.js';
import type { Hub } from '../ws.js';

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
}
