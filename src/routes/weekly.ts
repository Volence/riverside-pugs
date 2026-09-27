import type { FastifyInstance } from 'fastify';
import type { DB } from '../db.js';
import { computeWeek, weekStartOf, weeklyMinGames } from '../weeklyAwards.js';
import { computeRecap } from '../weeklyRecap.js';
import { frozenWeek, frozenWeeks } from '../weeklyStore.js';

/** Public, like the other stats reads: a weekly board is for sharing. The
 *  current week is computed live; past weeks only ever come from the frozen
 *  rows, so what the site shows matches what Discord announced. */
export async function weeklyRoutes(app: FastifyInstance, opts: { db: DB }): Promise<void> {
  const { db } = opts;

  app.get('/api/weekly', async (req, reply) => {
    const current = weekStartOf(new Date());
    const q = (req.query as { week?: string }).week;
    if (q !== undefined && (!/^\d{4}-\d{2}-\d{2}$/.test(q) || weekStartOf(new Date(`${q}T00:00:00Z`)) !== q)) {
      return reply.code(400).send({ error: 'bad week' });
    }
    const week = q ?? current;
    const minGames = weeklyMinGames(db);
    if (week === current) return { week, live: true, minGames, awards: computeWeek(db, week), recap: computeRecap(db, week) };
    const f = frozenWeek(db, week);
    if (!f) return reply.code(404).send({ error: 'no such week' });
    return { week, live: false, minGames, awards: f.awards, recap: f.recap };
  });

  app.get('/api/weekly/weeks', async () => ({ current: weekStartOf(new Date()), weeks: frozenWeeks(db) }));
}
