import type { FastifyInstance } from 'fastify';
import type { DB } from '../db.js';
import { parseReplay } from '../replayFormat.js';
import { buildDrill } from '../drillSpec.js';
import { createDrill, drillForMoment, drillsCreatedSince, fetchDrill, normalizeCode, DRILLS_PER_HOUR } from '../practiceDrills.js';
import {
  adminLeaseRows, getLease, leaseView, openOwnedLeaseOf, parkListings, practiceAccess, practiceClosedMessage, type LeaseKind, type PracticeLeases,
} from '../practiceLeases.js';
import { getPlayer } from '../players.js';
import { logAdmin } from '../admin/audit.js';
import { kickReason, knownOnSite } from '../practicePlayers.js';
import { getSetting } from '../settings.js';
import { campaignRegistry, resolveCampaignForMap } from '../campaignRegistry.js';
import { finishedReplayBytes, type ReplaySources } from './replays.js';
import { makeOptionalViewer, makeRequireActive, makeRequireMod } from './guards.js';

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
  opts: { db: DB; leases?: PracticeLeases | null } & ReplaySources,
): Promise<void> {
  const { db } = opts;
  const requireActive = makeRequireActive(db);
  // The three admin-practice routes below (players, kick, leases) are open
  // to moderators too (owner ruling 2026-09-28): practice servers are part
  // of the Live desk they may run.
  const requireStaff = makeRequireMod(db);
  const optionalViewer = makeOptionalViewer(db);
  const leases = opts.leases ?? null;
  // Players with a drill being built right now. The hourly count below is
  // read before an await (the replay read), so without this a script firing
  // requests in parallel would pass the count on every one of them, and each
  // would pull a whole round (up to 15 MB) into memory at once.
  const building = new Set<string>();

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

    if (building.has(steamid)) {
      return reply.code(429).send({ error: 'Your last drill is still being made; try again in a moment.' });
    }
    building.add(steamid);
    try {
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
    } finally {
      building.delete(steamid);
    }
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

  // ---- Practice server leases (src/practiceLeases.ts) ----

  /**
   * Start a practice server, or join the Practice Park.
   *
   * `{ kind: 'park' }` answers with the park that has room when there is
   * one (`joined: true`) and only leases a box when there is not.
   * `{ kind: 'drill', drillCode? }` always leases a private box; the code, if
   * given, must be a stored drill, and the server loads it once set up.
   *
   * Every refusal carries a sentence a player can act on: the manager's
   * PICK_ERRORS for "no server can be spared", a 409 naming the lease they
   * already have, a 429 for the hourly limit.
   */
  app.post('/api/practice/leases', async (req, reply) => {
    const steamid = requireActive(req, reply);
    if (!steamid) return reply;
    if (!practiceAccess(db, steamid)) return reply.code(403).send({ error: practiceClosedMessage(db) });
    if (!leases) return reply.code(503).send({ error: 'Practice servers are not available on this site.' });
    const body = (req.body ?? {}) as { kind?: unknown; drillCode?: unknown };
    const kind = body.kind;
    if (kind !== 'park' && kind !== 'drill') return reply.code(400).send({ error: 'kind must be park or drill' });
    let code: string | null = null;
    if (body.drillCode !== undefined && body.drillCode !== null && body.drillCode !== '') {
      if (kind !== 'drill') return reply.code(400).send({ error: 'only a drill server takes a drill code' });
      code = typeof body.drillCode === 'string' ? normalizeCode(body.drillCode) : null;
      const known = code !== null
        && db.prepare('SELECT 1 FROM practice_drills WHERE code = ?').get(code) !== undefined;
      if (!known) return reply.code(404).send({ error: 'No drill has that code.' });
    }
    const r = await leases.create(steamid, kind as LeaseKind, code);
    if (!r.ok) {
      return reply.code(r.status).send({ error: r.error, ...(r.leaseId !== undefined ? { leaseId: r.leaseId } : {}) });
    }
    return { joined: r.joined, lease: leaseView(db, r.lease, steamid, getPlayer(db, steamid)?.is_admin === 1) };
  });

  /**
   * The Practice Park, publicly: which parks are open, how full, on what
   * map. No host and no password; those are behind a login on the lease page.
   * A logged-in viewer also learns the id of their own open drill server,
   * so the Play page and the Drill this panel can link back to it (parks
   * are ownerless and never count as anyone's).
   */
  app.get('/api/practice/park', async (req) => {
    const viewer = optionalViewer(req);
    const mine = viewer ? openOwnedLeaseOf(db, viewer) : undefined;
    // The staged rollout switch hides all of it, list included, from anyone
    // it keeps out: a park they cannot join is not worth advertising.
    // Open to everyone, a signed-out visitor sees the list too (and is asked
    // to sign in to join), as the Play page's landing block intends.
    const visible = getSetting(db, 'practice_leasing') === 'everyone' || practiceAccess(db, viewer);
    if (leases === null || !visible) return { available: false, parks: [], mine: null };
    return {
      available: true,
      parks: parkListings(db),
      mine: mine ? { id: mine.id, kind: mine.kind } : null,
    };
  });

  /** One lease, for its invite page. Any active player may see the connect
   *  line and password: sharing the link is how a drill owner invites. */
  app.get('/api/practice/leases/:id', async (req, reply) => {
    const steamid = requireActive(req, reply);
    if (!steamid) return reply;
    if (!practiceAccess(db, steamid)) return reply.code(403).send({ error: practiceClosedMessage(db) });
    const id = Number((req.params as { id: string }).id);
    const lease = Number.isInteger(id) ? getLease(db, id) : undefined;
    if (!lease) return reply.code(404).send({ error: 'No such practice server.' });
    reply.header('Cache-Control', 'no-store');
    return leaseView(db, lease, steamid, getPlayer(db, steamid)?.is_admin === 1);
  });

  // Drill loads per owner in the last minute, for the rate limit below.
  const loads = new Map<string, number[]>();
  const LOADS_PER_MINUTE = 6;

  /**
   * Load a drill on the viewer's own drill server (the replay panel's
   * "Load this drill on your server"). Owner only: the lease's password is
   * shared with everyone the owner invited, but only the owner drives the
   * drills, in game and from here. Rate limited per owner, because each
   * call is an rcon round trip to a pool server and a map change there.
   */
  app.post('/api/practice/leases/:id/drill', async (req, reply) => {
    const steamid = requireActive(req, reply);
    if (!steamid) return reply;
    if (!practiceAccess(db, steamid)) return reply.code(403).send({ error: practiceClosedMessage(db) });
    if (!leases) return reply.code(503).send({ error: 'Practice servers are not available on this site.' });
    const id = Number((req.params as { id: string }).id);
    const lease = Number.isInteger(id) ? getLease(db, id) : undefined;
    if (!lease) return reply.code(404).send({ error: 'No such practice server.' });
    if (lease.owner_player_id !== steamid) {
      return reply.code(403).send({ error: 'Only whoever started this server can load drills on it.' });
    }
    const body = (req.body ?? {}) as { code?: unknown };
    const code = typeof body.code === 'string' ? normalizeCode(body.code) : null;
    if (!code || db.prepare('SELECT 1 FROM practice_drills WHERE code = ?').get(code) === undefined) {
      return reply.code(404).send({ error: 'No drill has that code.' });
    }
    const now = Date.now();
    const recent = (loads.get(steamid) ?? []).filter((t) => now - t < 60_000);
    if (recent.length >= LOADS_PER_MINUTE) {
      return reply.code(429).send({ error: 'That is a lot of drills in a minute. Give the last one a moment.' });
    }
    recent.push(now);
    loads.set(steamid, recent);
    const r = await leases.loadDrill(lease.id, code);
    if (!r.ok) return reply.code(r.status).send({ error: r.error });
    return leaseView(db, getLease(db, lease.id)!, steamid, getPlayer(db, steamid)?.is_admin === 1);
  });

  /** End a lease: its owner, or any staff member (owner ruling 2026-09-28). */
  app.post('/api/practice/leases/:id/end', async (req, reply) => {
    const steamid = requireActive(req, reply);
    if (!steamid) return reply;
    if (!leases) return reply.code(503).send({ error: 'Practice servers are not available on this site.' });
    const id = Number((req.params as { id: string }).id);
    const lease = Number.isInteger(id) ? getLease(db, id) : undefined;
    if (!lease) return reply.code(404).send({ error: 'No such practice server.' });
    const me = getPlayer(db, steamid);
    const isStaff = me?.is_admin === 1 || me?.is_mod === 1;
    // A park is ownerless: only staff ends one early, and otherwise it
    // closes itself 5 minutes after the last person leaves.
    const byOwner = lease.kind === 'drill' && lease.owner_player_id === steamid;
    if (!byOwner && !isStaff) {
      return reply.code(403).send({
        error: lease.kind === 'park'
          ? 'Only staff can close the Practice Park. It closes on its own 5 minutes after everyone leaves.'
          : 'Only whoever started this drill server, or staff, can close it.',
      });
    }
    if (!leases.end(lease.id, byOwner ? 'owner' : 'admin')) {
      return reply.code(409).send({ error: 'That practice server is already closing.' });
    }
    if (!byOwner) logAdmin(db, steamid, 'practice_end', lease.id, { owner: lease.owner_player_id, kind: lease.kind });
    return leaseView(db, getLease(db, lease.id)!, steamid, isStaff);
  });

  /**
   * Who is on a practice server, for the admin live board: the humans from
   * the box's `status` (no bots, no SourceTV) with team and trainer from the
   * practice plugin when it says, and whether each is known to the site.
   */
  app.get('/api/admin/practice/:leaseId/players', async (req, reply) => {
    if (!requireStaff(req, reply)) return reply;
    if (!leases) return reply.code(503).send({ error: 'Practice servers are not available on this site.' });
    const id = Number((req.params as { leaseId: string }).leaseId);
    if (!Number.isInteger(id) || !getLease(db, id)) return reply.code(404).send({ error: 'No such practice server.' });
    const r = await leases.players(id);
    if (!r.ok) return reply.code(r.status).send({ error: r.error });
    const known = knownOnSite(db, r.players.map((p) => p.steamid64).filter((x): x is string => x !== null));
    reply.header('Cache-Control', 'no-store');
    return {
      players: r.players.map((p) => ({
        userid: p.userid, name: p.name, steamid64: p.steamid64, connectedFor: p.connectedFor, ping: p.ping,
        team: p.team, trainer: p.trainer, onSite: p.steamid64 !== null && known.has(p.steamid64),
      })),
    };
  });

  /**
   * Kick someone off a practice server. The reason is cleaned for the
   * console (kickReason) and defaults to "Removed by an admin"; the kick is
   * refused when the lease is not open or that userid is not on the box,
   * and logged to the admin feed like any other admin action.
   */
  app.post('/api/admin/practice/:leaseId/kick', async (req, reply) => {
    const adminId = requireStaff(req, reply);
    if (!adminId) return reply;
    if (!leases) return reply.code(503).send({ error: 'Practice servers are not available on this site.' });
    const id = Number((req.params as { leaseId: string }).leaseId);
    if (!Number.isInteger(id) || !getLease(db, id)) return reply.code(404).send({ error: 'No such practice server.' });
    const body = (req.body ?? {}) as { userid?: unknown; reason?: unknown };
    const userid = typeof body.userid === 'number' && Number.isInteger(body.userid) && body.userid > 0 ? body.userid : null;
    if (userid === null) return reply.code(400).send({ error: 'userid must be a positive whole number' });
    const reason = kickReason(body.reason);
    const r = await leases.kick(id, userid, reason);
    if (!r.ok) return reply.code(r.status).send({ error: r.error });
    logAdmin(db, adminId, 'practice_kick', r.player.steamid64 ?? `lease ${id}`, {
      name: r.player.name, server: r.server, kind: r.kind, reason, leaseId: id,
    });
    return { ok: true };
  });

  /** Every open lease, for the admin live board. */
  app.get('/api/admin/practice/leases', async (req, reply) => {
    if (!requireStaff(req, reply)) return reply;
    return { leases: adminLeaseRows(db) };
  });
}
