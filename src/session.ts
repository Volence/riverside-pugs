import type { FastifyReply, FastifyRequest } from 'fastify';

export const SESSION_COOKIE = 'pug_session';

export function setSession(reply: FastifyReply, steamid: string, secure: boolean): void {
  reply.setCookie(SESSION_COOKIE, steamid, {
    path: '/',
    httpOnly: true,
    signed: true,
    sameSite: 'lax',
    secure,
    maxAge: 60 * 60 * 24 * 30,
  });
}

export function getSession(req: FastifyRequest): string | null {
  const raw = req.cookies[SESSION_COOKIE];
  if (!raw) return null;
  const unsigned = req.unsignCookie(raw);
  return unsigned.valid && unsigned.value ? unsigned.value : null;
}
