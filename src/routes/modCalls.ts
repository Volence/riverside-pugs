import type { FastifyInstance } from 'fastify';
import { resolveAlias } from '../aliases.js';
import type { DB } from '../db.js';
import { identityOf, plainLabel } from '../identity.js';
import { foldedCalls, REASON_LABELS, type ModCallRow } from '../modCalls.js';
import { getSetting } from '../settings.js';
import { canSeeTicket, getTicketRow } from '../tickets/store.js';
import { makeRequireMod } from './guards.js';

export interface ModCallView {
  id: number; createdAt: string; serverName: string | null; map: string | null; matchId: number | null;
  moment: { ordinal: number; half: number; tMs: number } | null;
  reason: string; reasonLabel: string; via: 'game' | 'tv';
  caller: { steamid: string; name: string };
  target: { kind: ModCallRow['target_kind']; steamid: string | null; name: string | null };
  text: string; ticketId: number | null; note: string; postState: string; pinged: boolean;
  handledBy: string | null; handledAt: string | null; folded: ModCallView[];
}

/** How many parents either tab lists, newest first. Open is capped too: a
 *  call leaves it only through the Discord button, so while Discord is not
 *  set up it grows without end. The page is a desk, not an archive. */
export const CALLS_LIMIT = 200;

/**
 * The In-game calls desk: every stored /mod call, for mods and admins alike
 * (the same guard as tickets). A call folded into another's card is listed
 * under that parent and never on its own, as on the Discord card. Open means
 * nobody has pressed Handling it yet, and leaves out a call that was skipped
 * because calls were off: nobody is going to press anything for it.
 *
 * The ticket system's rule holds here too: the accused never sees a case
 * about themselves. A call about the viewer is left out, parent or folded,
 * and a ticket the viewer may not open (about them, or restricted without
 * them on its list) is not even linked, as the ticket routes answer 404.
 */
export async function modCallRoutes(app: FastifyInstance, opts: { db: DB }): Promise<void> {
  const { db } = opts;
  const requireMod = makeRequireMod(db);
  const serverName = db.prepare('SELECT name FROM servers WHERE id = ?');
  // A Discord id is linked to at most one player; an id nobody has linked
  // (a staff member who never signed in on the site) is shown raw.
  const byDiscord = db.prepare('SELECT steamid FROM players WHERE discord_id = ? LIMIT 1');

  const aboutViewer = (me: string, c: ModCallRow) =>
    c.target_steamid !== null && resolveAlias(db, c.target_steamid) === me;
  const ticketFor = (me: string, id: number | null): number | null => {
    if (id === null) return null;
    const t = getTicketRow(db, id);
    return t && canSeeTicket(db, t, me) ? id : null;
  };

  const view = (me: string, c: ModCallRow, folded: ModCallView[]): ModCallView => {
    let handledBy: string | null = null;
    if (c.handled_by_discord_id !== null) {
      const p = byDiscord.get(c.handled_by_discord_id) as { steamid: string } | undefined;
      handledBy = p ? plainLabel(identityOf(db, p.steamid)) : c.handled_by_discord_id;
    }
    const server = c.server_id !== null ? serverName.get(c.server_id) as { name: string } | undefined : undefined;
    return {
      id: c.id, createdAt: c.created_at, serverName: server?.name ?? null, map: c.map, matchId: c.match_id,
      moment: c.map_ordinal === null || c.half === null || c.t_ms === null
        ? null : { ordinal: c.map_ordinal, half: c.half, tMs: c.t_ms },
      reason: c.reason, reasonLabel: REASON_LABELS[c.reason] ?? c.reason, via: c.via,
      caller: { steamid: c.caller_steamid, name: plainLabel(identityOf(db, c.caller_steamid)) },
      target: {
        kind: c.target_kind, steamid: c.target_steamid,
        name: c.target_steamid !== null ? plainLabel(identityOf(db, c.target_steamid)) : null,
      },
      text: c.text, ticketId: ticketFor(me, c.ticket_id), note: c.note, postState: c.post_state, pinged: c.pinged === 1,
      handledBy, handledAt: c.handled_at, folded,
    };
  };

  app.get('/api/mod/calls', async (req, reply) => {
    const viewer = requireMod(req, reply);
    if (!viewer) return reply;
    const me = resolveAlias(db, viewer);
    const filter = (req.query as { filter?: string }).filter === 'all' ? 'all' : 'open';
    const parents = db.prepare(
      `SELECT * FROM mod_calls WHERE folded_into IS NULL
         ${filter === 'open' ? "AND handled_at IS NULL AND post_state != 'skipped'" : ''}
        ORDER BY id DESC LIMIT ${CALLS_LIMIT}`,
    ).all() as ModCallRow[];
    const shown = (c: ModCallRow) => !aboutViewer(me, c);
    const calls = parents.filter(shown)
      .map((p) => view(me, p, foldedCalls(db, p.id).filter(shown).map((c) => view(me, c, []))));
    const discordReady = (getSetting(db, 'discord_admin_channel_id') ?? '') !== ''
      && getSetting(db, 'mod_calls_enabled') === '1';
    return { calls, discordReady };
  });
}
