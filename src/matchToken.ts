import { randomBytes } from 'node:crypto';

const TOKEN_RE = /^[0-9a-f]{32}$/;

/** A per-match secret: 16 random bytes as lowercase hex. */
export function newToken(): string {
  return randomBytes(16).toString('hex');
}

export function isValidTokenFormat(token: string): boolean {
  return TOKEN_RE.test(token);
}

/**
 * The game server's `sv_password` for a match, derived from its token.
 *
 * Derived, never stored. Three call sites need this string: the orchestrator
 * that sets it over rcon, the live state a player's Connect button reads, and
 * the admin view that lets an admin join a match they are not in. Two of them
 * used to spell the expression out, with a comment on one of them saying the
 * two must not drift, which is the comment you write just before extracting a
 * function.
 */
export function serverPasswordFor(token: string): string {
  return `pug_${token.slice(0, 8)}`;
}
