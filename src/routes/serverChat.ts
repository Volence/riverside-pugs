import type { FastifyInstance } from 'fastify';
import type { DB } from '../db.js';
import type { LeaseRcon } from '../practiceLeases.js';
import { getPlayer } from '../players.js';
import { parseStatusPlayers } from '../practicePlayers.js';
import { getServer, isLeased, listServers } from '../serverPool.js';
import { listLines, liveMatchOn, type ChatLineRow } from '../serverChat.js';
import { SendLimiter, cleanChatText, sendStaffChat, MESSAGE_MAX, MESSAGE_MAX_BYTES, NAME_MAX, NAME_MAX_BYTES, type SendTarget } from '../staffChatSend.js';
import { makeRequireMod } from './guards.js';

export interface ChatServerView { id: number; name: string; state: 'match' | 'practice' | 'idle' | 'offline'; lastAt: number | null }
export interface ChatLineView {
  id: number; at: number; kind: ChatLineRow['kind']; steamid: string | null; name: string | null;
  team: number | null; scope: 'all' | 'team' | null; message: string; matchId: number | null;
  to: { kind: 'all' | 'team' | 'player'; value: string | null; name: string | null } | null;
  delivered: number | null;
}

/**
 * People, Server chat: every server's chat for mods and admins alike, and the
 * one way the site talks into a game. Staff see team chat too (owner ruling
 * 2026-09-28: teams are on voice, typed team chat hides nothing).
 */
export async function serverChatRoutes(
  app: FastifyInstance,
  opts: { db: DB; rcon: LeaseRcon; notify?: () => void },
): Promise<void> {
  const { db, rcon } = opts;
  // The same staff-only hub event the log ingest sends, so every open drawer
  // (not just the sender's) shows the new row and, on failure, its -1.
  const notify = opts.notify ?? (() => {});
  const requireMod = makeRequireMod(db);
  const limiter = new SendLimiter();
  const lastAt = db.prepare('SELECT MAX(at) AS at FROM server_chat WHERE server_id = ?');

  const serverId = (raw: unknown): number | null => {
    const n = Number(raw);
    return Number.isInteger(n) && n > 0 && getServer(db, n) ? n : null;
  };

  app.get('/api/mod/chat/servers', async (req, reply) => {
    if (!requireMod(req, reply)) return;
    const servers: ChatServerView[] = listServers(db)
      .filter((s) => s.enabled === 1 || isLeased(db, s.id))
      .map((s) => ({
        id: s.id, name: s.name,
        state: isLeased(db, s.id) ? 'practice' : liveMatchOn(db, s.id) !== null ? 'match' : s.status === 'offline' ? 'offline' : 'idle',
        lastAt: (lastAt.get(s.id) as { at: number | null }).at,
      }));
    return { servers };
  });

  app.get('/api/mod/chat/:serverId', async (req, reply) => {
    if (!requireMod(req, reply)) return;
    const id = serverId((req.params as { serverId: string }).serverId);
    if (id === null) return reply.code(404).send({ error: 'no such server' });
    const q = req.query as { after?: string; limit?: string };
    const after = Math.max(0, Number.parseInt(q.after ?? '0', 10) || 0);
    const limit = Math.min(500, Math.max(1, Number.parseInt(q.limit ?? '200', 10) || 200));
    const server = getServer(db, id)!;
    const lines: ChatLineView[] = listLines(db, id, after, limit).map((r) => ({
      id: r.id, at: r.at, kind: r.kind, steamid: r.steamid, name: r.name, team: r.team, scope: r.scope,
      message: r.message, matchId: r.match_id, delivered: r.delivered,
      to: r.to_kind === null ? null : {
        kind: r.to_kind, value: r.to_value,
        name: r.to_kind === 'player' && r.to_value ? getPlayer(db, r.to_value)?.name ?? null : null,
      },
    }));
    return { server: { id: server.id, name: server.name }, lines };
  });

  // Who is on the server right now, for the drawer's Whisper picker: a /mod
  // caller, a reported player or someone only on voice has no chat line to
  // click. Humans with a SteamID64 only, since a whisper needs one.
  app.get('/api/mod/chat/:serverId/players', async (req, reply) => {
    if (!requireMod(req, reply)) return;
    const id = serverId((req.params as { serverId: string }).serverId);
    if (id === null) return reply.code(404).send({ error: 'no such server' });
    let status: string;
    try {
      [status = ''] = await rcon(getServer(db, id)!, ['status']);
    } catch (err) {
      console.error(`[serverchat] status on server ${id} failed:`, err);
      return reply.code(502).send({ error: 'Could not reach the server.' });
    }
    const players = parseStatusPlayers(status)
      .filter((p): p is typeof p & { steamid64: string } => p.steamid64 !== null)
      .map((p) => ({ steamid: p.steamid64, name: p.name }));
    return { players };
  });

  app.post('/api/mod/chat/:serverId', async (req, reply) => {
    const me = requireMod(req, reply);
    if (!me) return;
    const id = serverId((req.params as { serverId: string }).serverId);
    if (id === null) return reply.code(404).send({ error: 'no such server' });
    const body = (req.body ?? {}) as { to?: unknown; team?: unknown; steamid?: unknown; message?: unknown };
    const message = cleanChatText(body.message, MESSAGE_MAX, MESSAGE_MAX_BYTES);
    if (!message) return reply.code(400).send({ error: 'Type a message.' });
    let target: SendTarget;
    if (body.to === 'all') target = { to: 'all' };
    else if (body.to === 'team' && (body.team === 1 || body.team === 2 || body.team === 3)) target = { to: 'team', team: body.team };
    else if (body.to === 'player' && typeof body.steamid === 'string' && /^\d{17}$/.test(body.steamid)) target = { to: 'player', steamid: body.steamid };
    else return reply.code(400).send({ error: 'Pick who the message is for.' });
    if (!limiter.allow(me)) return reply.code(429).send({ error: 'Slow down: 5 messages per 10 seconds.' });
    const name = cleanChatText(getPlayer(db, me)?.name ?? '', NAME_MAX, NAME_MAX_BYTES) || 'Staff';
    const r = await sendStaffChat(db, rcon, { serverId: id, sentBy: me, name, target, message });
    try { notify(); } catch (err) { console.error('[serverchat] notify failed:', err); }
    if (!r.ok) return reply.code(502).send({ error: r.error, id: r.id });
    return { ok: true, id: r.id };
  });
}
