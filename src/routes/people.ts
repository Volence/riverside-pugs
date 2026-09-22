import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { DB } from '../db.js';
import { makeRequireMod } from './guards.js';
import { logAdmin } from '../admin/audit.js';
import { addNote, searchPlayers } from '../admin/players.js';
import { captureHealth } from '../integrityFlags.js';
import { canDo, canOpenFile, fileViewer, type FileAction } from '../admin/fileAccess.js';
import { everyoneMeasured, needsALook } from '../admin/needsALook.js';
import { analyzerRanks } from '../admin/analyzerRanks.js';
import { peopleBans } from '../admin/peopleBans.js';
import { playerFile } from '../admin/playerFile.js';
import { markLookedAt } from '../admin/reviews.js';
import { getPlayer } from '../players.js';
import { resolveAlias } from '../aliases.js';

export interface PeopleRouteOpts {
  db: DB;
}

/**
 * The People desk: search, the Player File, Needs a look and the ban list.
 *
 * Every route is behind makeRequireMod, and every one then asks fileAccess
 * whether this particular file is open to this particular viewer. A refusal
 * is a 404 with the same body as a genuinely missing player: telling a
 * moderator that a file exists but is not theirs to read is telling them who
 * is staff and who has a case open.
 *
 * The admin-only mutations are NOT here. Ban, timeout, merge, sign out and
 * the staff flags stay on /api/admin/players behind requireAdmin, and the
 * Player File page calls them there, so this file cannot become a second,
 * looser door onto them.
 */
export async function peopleRoutes(app: FastifyInstance, opts: PeopleRouteOpts): Promise<void> {
  const { db } = opts;
  const requireMod = makeRequireMod(db);

  /** Staff, then a target whose file this viewer may act on with `action`.
   *
   *  The id is resolved first, so a merged second account names the file it
   *  was merged into, exactly as every GET here does: a note written against
   *  an alt would otherwise land on a record nobody opens. canDo resolves
   *  aliases too, so an alt of a colleague or of the viewer is still a 404. */
  const onFile = (req: FastifyRequest, reply: FastifyReply, action: FileAction) => {
    const me = requireMod(req, reply);
    if (!me) return null;
    const viewer = fileViewer(db, me);
    const steamid = resolveAlias(db, (req.params as { steamid: string }).steamid);
    if (!getPlayer(db, steamid) || !canDo(db, viewer, steamid, action)) {
      reply.code(404).send({ error: 'no such player' });
      return null;
    }
    return { me, viewer, steamid };
  };

  app.get('/api/admin/people', async (req, reply) => {
    const me = requireMod(req, reply);
    if (!me) return reply;
    const viewer = fileViewer(db, me);
    const q = String((req.query as { q?: string }).q ?? '').trim().slice(0, 100);
    return { players: searchPlayers(db, q).filter((p) => canOpenFile(db, viewer, p.steamid)) };
  });

  /**
   * Every chat line of a finished or cancelled match, for staff.
   *
   * The public replay timeline drops lines with no round clock (t_ms -1),
   * which is everything said in a ready-up, a pause or between rounds: about
   * a quarter of all chat, and where most arguments happen. A report about
   * what someone said needs all of it.
   *
   * Never a match in progress: a moderator can be playing in it, and
   * match_chat does not tell team chat from all chat.
   */
  app.get('/api/admin/people/chat/:matchId', async (req, reply) => {
    const me = requireMod(req, reply);
    if (!me) return reply;
    const id = Number((req.params as { matchId: string }).matchId);
    const match = db
      .prepare("SELECT id FROM matches WHERE id = ? AND state IN ('completed', 'aborted')")
      .get(id);
    if (!Number.isInteger(id) || !match) return reply.code(404).send({ error: 'no such match' });
    // `player` is the merged identity, so a Player File link highlights the
    // lines an alt typed as well as the main account's.
    const lines = db.prepare(
      `SELECT c.seq, c.map_ordinal AS mapOrdinal, c.half, c.t_ms AS tMs, c.steamid,
              COALESCE(a.canonical_id, c.steamid) AS player,
              COALESCE(p.name, c.steamid) AS name, c.team, c.message
       FROM match_chat c
       LEFT JOIN players p ON p.steamid = c.steamid
       LEFT JOIN player_aliases a ON a.steamid = c.steamid
       WHERE c.match_id = ? ORDER BY c.seq`,
    ).all(id);
    return { lines };
  });

  app.get('/api/admin/people/review', async (req, reply) => {
    const me = requireMod(req, reply);
    if (!me) return reply;
    const viewer = fileViewer(db, me);
    // Scored once and handed to both lists: the board reads and parses every
    // round row at the current analyzer version, and the two lists want the
    // same numbers.
    const ranks = analyzerRanks(db);
    // Capture health rides along for the same reason it rides along with the
    // board today: an empty list cannot otherwise tell "nobody flagged"
    // apart from "the pipeline is silently broken".
    return {
      players: needsALook(db, viewer, { ranks }),
      // Being measured is not evidence, so nobody here is in the queue for
      // that reason alone; this is the population the retired board listed.
      measured: everyoneMeasured(db, viewer, ranks),
      health: captureHealth(db),
    };
  });

  app.get('/api/admin/people/bans', async (req, reply) => {
    const me = requireMod(req, reply);
    if (!me) return reply;
    const { filter, q } = req.query as { filter?: string; q?: string };
    const chosen = filter === 'active' || filter === 'expired' ? filter : 'all';
    return { bans: peopleBans(db, fileViewer(db, me), { filter: chosen, q: String(q ?? '').slice(0, 64) }) };
  });

  app.get('/api/admin/people/:steamid', async (req, reply) => {
    const me = requireMod(req, reply);
    if (!me) return reply;
    const { steamid } = req.params as { steamid: string };
    const file = playerFile(db, steamid, fileViewer(db, me));
    if (!file) return reply.code(404).send({ error: 'no such player' });
    return file;
  });

  app.post('/api/admin/people/:steamid/notes', async (req, reply) => {
    const t = onFile(req, reply, 'note');
    if (!t) return reply;
    const { text } = (req.body ?? {}) as { text?: unknown };
    if (typeof text !== 'string' || !text.trim() || text.length > 2000) {
      return reply.code(400).send({ error: 'a note needs text (up to 2000 characters)' });
    }
    addNote(db, t.steamid, t.me, text.trim());
    logAdmin(db, t.me, 'note', t.steamid);
    return { ok: true };
  });

  app.post('/api/admin/people/:steamid/looked-at', async (req, reply) => {
    const t = onFile(req, reply, 'looked_at');
    if (!t) return reply;
    const { note } = (req.body ?? {}) as { note?: unknown };
    if (note !== undefined && typeof note !== 'string') {
      return reply.code(400).send({ error: 'a note must be text' });
    }
    const review = markLookedAt(db, t.steamid, t.me, (note ?? '').toString().trim());
    logAdmin(db, t.me, 'looked_at', t.steamid, { note: review.note });
    return { ok: true, review };
  });
}
