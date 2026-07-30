import { randomBytes } from 'node:crypto';

const TOKEN_RE = /^[0-9a-f]{32}$/;

/** A per-match secret: 16 random bytes as lowercase hex. */
export function newToken(): string {
  return randomBytes(16).toString('hex');
}

export function isValidTokenFormat(token: string): boolean {
  return TOKEN_RE.test(token);
}
