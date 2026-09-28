import type { FastifyInstance } from 'fastify';
import type { DB } from '../db.js';
import { parseReplay } from '../replayFormat.js';
import { buildDrill } from '../drillSpec.js';
import { createDrill, drillForMoment, drillsCreatedSince, fetchDrill, DRILLS_PER_HOUR } from '../practiceDrills.js';
import { campaignRegistry, resolveCampaignForMap } from '../campaignRegistry.js';
import { finishedReplayBytes, type ReplaySources } from './replays.js';
import { makeRequireActive } from './guards.js';

const HOUR_MS = 60 * 60 * 1000;

/**
 * How the map reads in a drill title: the campaign's display name and the
 * chapter's place in it ("No Mercy 3"), or the raw map name when the
 * registry does not know the map. The raw name is ugly but never wrong,
 * which matters more for a title a player reads in game to check they got
 * the drill they meant.
 */
export function drillMapLabel(db: DB, map: string): string {
  const slug = resolveCampaignForMap(db, map);
  const entry = slug ? campaignRegistry(db).get(slug) : undefined;
  if (!entry) return map;
  const i = entry.maps.findIndex((m) => m.toLowerCase() === map.toLowerCase());
  const n = i >= 0 ? i + 1 : chapterFromName(map);
  return n === null ? entry.name : `${entry.name} ${n}`;
}

/**
 * The chapter number a map name carries, for when the registry has no map
 * list (a stock campaign's list comes from the mission files, which only
 * exist where MISSIONS_DIR is set). A server-side port of chapterOrdinal in
 * web/src/format.ts, trimmed to what a replay's map can be: dlc4's
 * `c1m3_mall`, L4D1's `l4d_vs_hospital03_sewers`, and a custom map ending in
 * `_<digits>`. The trailing form goes before the middle one for the reason
 * given there (`l4d_vs_city17_04` is chapter 4, not 17).
 */
export function chapterFromName(map: string): number | null {
  const lower = map.toLowerCase();
  const dlc4 = /^c\d+m(\d+)/.exec(lower);
  if (dlc4) return Number(dlc4[1]);
  const trailing = /^l4d_(?:vs_)?[a-z0-9]+_(\d+)$/.exec(lower);
  if (trailing) return Number(trailing[1]);
  const l4d1 = /^l4d_(?:vs_)?[a-z]+(\d+)_/.exec(lower);
  return l4d1 ? Number(l4d1[1]) : null;
}

/** Persona names for the SteamIDs in a replay's roster, as the site knows them. */
function rosterNames(db: DB, slots: string[]): Record<string, string> {
  const ids = slots.filter(Boolean);
  if (ids.length === 0) return {};
  const rows = db.prepare(
    `SELECT steamid, name FROM players WHERE steamid IN (${ids.map(() => '?').join(',')})`,
  ).all(...ids) as { steamid: string; name: string }[];
  return Object.fromEntries(rows.map((r) => [r.steamid, r.name]));
}

const isCount = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0;

/**
 * Replay drills (l4d/practice/DESIGN.md).
 *
 * POST turns a moment of a finished match into a stored drill and answers
 * with its code; GET is what the practice plugin calls when a player types
 * `!drill <code>`, and answers with the spec and nothing else.
 */
export async function practiceRoutes(
  app: FastifyInstance,
  opts: { db: DB } & ReplaySources,
): Promise<void> {
  const { db } = opts;
  const requireActive = makeRequireActive(db);

  /**
   * Make a drill from one moment of a finished match.
   *
   * Finished means completed or aborted, and it is enforced here rather than
   * trusted to the viewer that only offers the button on finished matches:
   * a frame carries ghost infected positions, which is the whole reason the
   * live viewer runs behind, so a drill of a live match would be a way to
   * read the infected team's ghosts in real time.
   *
   * The same moment asked twice answers with the drill it already has, so a
   * double click or two friends drilling the same wipe share one code, and a
   * reuse does not count against the hourly limit.
   */
  app.post('/api/practice/drills', async (req, reply) => {
    const steamid = requireActive(req, reply);
    if (!steamid) return reply;

    const body = (req.body ?? {}) as { matchId?: unknown; ordinal?: unknown; half?: unknown; tMs?: unknown };
    const { matchId, ordinal, half } = body;
    // A playback clock is a float; the moment is a whole millisecond.
    const tMs = typeof body.tMs === 'number' && Number.isFinite(body.tMs) ? Math.round(body.tMs) : NaN;
    if (!isCount(matchId) || !isCount(ordinal) || (half !== 1 && half !== 2) || !isCount(tMs)) {
      return reply.code(400).send({ error: 'a drill needs a match, a map, a half (1 or 2) and a time' });
    }

    const match = db.prepare('SELECT state FROM matches WHERE id = ?').get(matchId) as { state: string } | undefined;
    if (!match) return reply.code(404).send({ error: 'no such match' });
    if (match.state !== 'completed' && match.state !== 'aborted') {
      return reply.code(403).send({ error: 'Drills can only be made from finished matches.' });
    }

    const moment = { matchId, ordinal, half, tMs };
    const existing = drillForMoment(db, moment);
    if (existing) return { code: existing.code, spec: existing };

    const since = new Date(Date.now() - HOUR_MS).toISOString();
    if (drillsCreatedSince(db, steamid, since) >= DRILLS_PER_HOUR) {
      return reply.code(429).send({ error: `You can make ${DRILLS_PER_HOUR} drills an hour; try again later.` });
    }

    const bytes = await finishedReplayBytes(db, opts, matchId, ordinal, half);
    const replay = bytes ? parseReplay(bytes) : null;
    if (!replay || replay.frames.length === 0) {
      return reply.code(404).send({ error: 'There is no replay of that round to make a drill from.' });
    }

    const built = buildDrill(replay, tMs, {
      names: rosterNames(db, replay.header.slots),
      matchId,
      mapLabel: drillMapLabel(db, replay.header.map),
      ordinal,
      half,
    });
    if (!built) return reply.code(404).send({ error: 'There is no replay of that round to make a drill from.' });

    const { spec } = createDrill(db, built, moment, steamid);
    return { code: spec.code, spec };
  });

  /**
   * One drill's spec, by code, for the practice plugin.
   *
   * Public: the plugin has no session, and a spec only ever describes a
   * finished match. The code is case-insensitive because it is typed in
   * game chat. The body is the stored JSON as filed, the DESIGN.md shape
   * and nothing around it, since REST in Pawn hands the plugin the raw body
   * and every wrapper field is one more thing to parse on a game server.
   * Errors are plain `{ error }` objects with a 404, which the plugin reports
   * as "no such drill".
   */
  app.get('/api/practice/drills/:code', async (req, reply) => {
    const { code } = req.params as { code: string };
    const json = fetchDrill(db, code);
    if (json === null) return reply.code(404).send({ error: 'no such drill' });
    reply.header('Cache-Control', 'no-store');
    return reply.type('application/json').send(json);
  });
}
