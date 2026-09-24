import type { FastifyInstance } from 'fastify';
import type { DB } from '../db.js';
import type { Hub } from '../ws.js';
import { getSession } from '../session.js';

export async function wsRoutes(app: FastifyInstance, opts: { hub: Hub; db: DB }): Promise<void> {
  app.get('/ws', { websocket: true }, (socket, req) => {
    // The same signed cookie every route reads. Null for a browser that is
    // not signed in, which still gets every broadcast and no targeted event.
    opts.hub.add(socket, getSession(req, opts.db));
    socket.on('close', () => opts.hub.remove(socket));
    socket.on('error', () => opts.hub.remove(socket));
  });
}
