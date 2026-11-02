import type { FastifyInstance } from 'fastify';
import type { DB } from '../db.js';
import { computeWeek, isWeekStart, weekStartOf, weeklyMinGames } from '../weeklyAwards.js';
import { computeRecap } from '../weeklyRecap.js';
import { frozenWeek, frozenWeeks } from '../weeklyStore.js';
import { avatarsOf } from '../avatars.js';
import { playerWeek, playerWeekHistory } from '../weeklyPlayer.js';

/** Public, like the other stats reads: a weekly board is for sharing. The
 *  current week is computed live; past weeks only ever come from the frozen
 *  rows, so what the site shows matches what Discord announced. */
export async function weeklyRoutes(app: FastifyInstance, opts: { db: DB }): Promise<void> {
  const { db } = opts;

  /** Adds each winner's avatar at read time, so frozen weeks get faces too. */
  const withFaces = <A extends { winners: { steamid: string }[] }>(awards: A[]): A[] => {
    const faces = avatarsOf(db, awards.flatMap((a) => a.winners.map((w) => w.steamid)));
    return awards.map((a) => ({ ...a, winners: a.winners.map((w) => ({ ...w, avatar: faces.get(w.steamid) ?? null })) }));
  };

  app.get('/api/weekly', async (req, reply) => {
    const current = weekStartOf(new Date());
    const q = (req.query as { week?: string }).week;
    if (q !== undefined && !isWeekStart(q)) {
      return reply.code(400).send({ error: 'bad week' });
    }
    const week = q ?? current;
    const minGames = weeklyMinGames(db);
    if (week === current) return { week, live: true, minGames, awards: withFaces(computeWeek(db, week)), recap: computeRecap(db, week) };
    const f = frozenWeek(db, week);
    if (!f) return reply.code(404).send({ error: 'no such week' });
    return { week, live: false, minGames, awards: withFaces(f.awards), recap: f.recap };
  });

  /** One player's standing on every stat board for a week (the current one
   *  by default), so they can see how close they are. Public like the board. */
  app.get('/api/weekly/player/:steamid', async (req, reply) => {
    const { steamid } = req.params as { steamid: string };
    const q = (req.query as { week?: string }).week;
    if (!/^\d{17}$/.test(steamid)) return reply.code(400).send({ error: 'bad steamid' });
    if (q !== undefined && !isWeekStart(q)) return reply.code(400).send({ error: 'bad week' });
    return playerWeek(db, q ?? weekStartOf(new Date()), steamid);
  });

  /** The weeks a player played, newest first, with awards won in each. */
  app.get('/api/weekly/player/:steamid/history', async (req, reply) => {
    const { steamid } = req.params as { steamid: string };
    if (!/^\d{17}$/.test(steamid)) return reply.code(400).send({ error: 'bad steamid' });
    return { weeks: playerWeekHistory(db, steamid) };
  });

  app.get('/api/weekly/weeks', async () => ({ current: weekStartOf(new Date()), weeks: frozenWeeks(db) }));
}
