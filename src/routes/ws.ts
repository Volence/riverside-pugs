import type { FastifyInstance } from 'fastify';
import type { Hub } from '../ws.js';

export async function wsRoutes(app: FastifyInstance, opts: { hub: Hub }): Promise<void> {
  app.get('/ws', { websocket: true }, (socket) => {
    opts.hub.add(socket);
    socket.on('close', () => opts.hub.remove(socket));
    socket.on('error', () => opts.hub.remove(socket));
  });
}
