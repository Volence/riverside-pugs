import type { FastifyReply, FastifyRequest } from 'fastify';
import type { DB } from './db.js';

export const SESSION_COOKIE = 'pug_session';

/** A session lasts this long from when it was issued. Enforced here, from the
 *  signed value, and not left to the cookie's own Max-Age: that is a request
 *  to the browser, and a copied cookie does not honour it. */
export const SESSION_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

/** A session older than this is reissued on its next request, so somebody who
 *  keeps using the site is never signed out, and somebody who stops is signed
 *  out 30 days after they stopped. A day, not every request: one Set-Cookie a
 *  day per player is enough to slide the window. */
const RENEW_AFTER_MS = 24 * 60 * 60 * 1000;

/** Tolerance for a cookie dated ahead of this clock. It was issued by this
 *  process, so anything past a little drift across a restart is not ours. */
const FUTURE_SKEW_MS = 5 * 60 * 1000;

/**
 * The signed cookie value: `steamid.issuedAt.epoch`.
 *
 * It used to be the bare SteamID, which made a session for ever: no expiry
 * the server could enforce, and no way to take one back short of rotating the
 * cookie secret for everybody. `issuedAt` (epoch ms) gives it an age.
 * `epoch` is players.session_epoch as it stood at issue; bumping that column
 * ends every cookie the player holds at once, which is what a ban, a change
 * of admin flag and "sign out everywhere" do. A counter rather than a
 * timestamp, so a bump and a login in the same millisecond cannot be confused.
 *
 * A cookie in the old format has no dots in it, fails to parse, and is
 * treated as no session: everyone signs in once more after the deploy.
 */
export function sessionValue(steamid: string, epoch: number, issuedAt: number = Date.now()): string {
  return `${steamid}.${issuedAt}.${epoch}`;
}

function epochOf(db: DB, steamid: string): number | null {
  const row = db.prepare('SELECT session_epoch FROM players WHERE steamid = ?').get(steamid) as
    | { session_epoch: number } | undefined;
  return row ? row.session_epoch : null;
}

function writeCookie(reply: FastifyReply, value: string, secure: boolean): void {
  reply.setCookie(SESSION_COOKIE, value, {
    path: '/',
    httpOnly: true,
    signed: true,
    sameSite: 'lax',
    secure,
    maxAge: SESSION_MAX_AGE_MS / 1000,
  });
}

/** Sign a player in. The player row must exist: the epoch is read from it. */
export function setSession(reply: FastifyReply, db: DB, steamid: string, secure: boolean): void {
  writeCookie(reply, sessionValue(steamid, epochOf(db, steamid) ?? 0), secure);
}

export function clearSession(reply: FastifyReply): void {
  reply.clearCookie(SESSION_COOKIE, { path: '/' });
}

/** The session on this request, or null: unsigned, malformed, in the old
 *  format, too old, dated in the future, for a player who no longer exists,
 *  or issued before that player's sessions were last ended. */
function readSession(req: FastifyRequest, db: DB, now: number): { steamid: string; issuedAt: number } | null {
  const raw = req.cookies[SESSION_COOKIE];
  if (!raw) return null;
  const unsigned = req.unsignCookie(raw);
  if (!unsigned.valid || !unsigned.value) return null;
  const m = /^(\d{17})\.(\d{1,15})\.(\d{1,9})$/.exec(unsigned.value);
  if (!m) return null;
  const [, steamid, issuedRaw, epochRaw] = m;
  const issuedAt = Number(issuedRaw);
  if (now - issuedAt > SESSION_MAX_AGE_MS || issuedAt > now + FUTURE_SKEW_MS) return null;
  if (epochOf(db, steamid) !== Number(epochRaw)) return null;
  return { steamid, issuedAt };
}

export function getSession(req: FastifyRequest, db: DB): string | null {
  return readSession(req, db, Date.now())?.steamid ?? null;
}

/** Sliding renewal, run on every request. Only ever reissues a session that
 *  is valid right now, so it cannot bring an expired or revoked one back. */
export function renewSession(req: FastifyRequest, reply: FastifyReply, db: DB, secure: boolean): void {
  const now = Date.now();
  const s = readSession(req, db, now);
  if (s && now - s.issuedAt > RENEW_AFTER_MS) setSession(reply, db, s.steamid, secure);
}

/** End every session this player holds, on every device. */
export function endSessions(db: DB, steamid: string): void {
  db.prepare('UPDATE players SET session_epoch = session_epoch + 1 WHERE steamid = ?').run(steamid);
}
