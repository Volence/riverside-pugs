import type { FastifyReply, FastifyRequest } from 'fastify';

/**
 * The /appeal page's sign-in for someone who cannot sign in through Steam,
 * typically a person banned from the Discord. It proves one Discord account
 * and nothing else: no route but the appeal routes ever reads it, and it is
 * not a session in the src/session.ts sense. An hour is enough to write an
 * appeal; there is nothing to revoke, so nothing is stored server side.
 */
export const APPEAL_COOKIE = 'pug_appeal';
export const APPEAL_SESSION_MS = 60 * 60 * 1000;

export function setAppealSession(reply: FastifyReply, discordId: string, name: string, secure: boolean, now = Date.now()): void {
  const value = `${discordId}.${now}.${Buffer.from(name.slice(0, 100), 'utf8').toString('base64url')}`;
  reply.setCookie(APPEAL_COOKIE, value, {
    path: '/', httpOnly: true, signed: true, sameSite: 'lax', secure, maxAge: APPEAL_SESSION_MS / 1000,
  });
}

export function readAppealSession(req: FastifyRequest, now = Date.now()): { discordId: string; name: string } | null {
  const raw = req.cookies[APPEAL_COOKIE];
  if (!raw) return null;
  const u = req.unsignCookie(raw);
  if (!u.valid || !u.value) return null;
  const m = /^(\d{1,22})\.(\d{1,15})\.([A-Za-z0-9_-]*)$/.exec(u.value);
  if (!m) return null;
  const issued = Number(m[2]);
  if (now - issued > APPEAL_SESSION_MS || issued > now + 5 * 60_000) return null;
  return { discordId: m[1], name: Buffer.from(m[3], 'base64url').toString('utf8') };
}

export function clearAppealSession(reply: FastifyReply): void {
  reply.clearCookie(APPEAL_COOKIE, { path: '/' });
}
