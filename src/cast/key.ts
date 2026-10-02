import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Overlay keys (caster studio ruling 1). OBS browser sources carry no
 * session cookie, so an overlay URL carries a key instead:
 *
 *   <steamid>.<generation>.<signature>
 *
 * The signature is an HMAC of the first two parts under the cookie secret, so
 * nothing secret is stored and the panel can show the same URLs again at any
 * time. Bumping the caster's generation (cast_studios.key_gen) is the revoke:
 * every URL signed for an older generation stops verifying at once.
 *
 * A key proves only who handed it out. Whether that person may still see
 * anything is asked again on every read (src/cast/access.ts).
 */

const SIG_CHARS = 24;

function sign(secret: string, steamid: string, gen: number): string {
  return createHmac('sha256', secret).update(`cast-overlay:${steamid}:${gen}`).digest('base64url').slice(0, SIG_CHARS);
}

export function overlayKey(secret: string, steamid: string, gen: number): string {
  return `${steamid}.${gen}.${sign(secret, steamid, gen)}`;
}

/** The steamid and generation a well-signed key names, or null. The caller
 *  still compares the generation with the stored one. */
export function readOverlayKey(secret: string, key: unknown): { steamid: string; gen: number } | null {
  if (typeof key !== 'string' || key.length > 80) return null;
  const m = /^(\d{17})\.(\d{1,9})\.([A-Za-z0-9_-]+)$/.exec(key);
  if (!m) return null;
  const steamid = m[1]!;
  const gen = Number(m[2]);
  const want = Buffer.from(sign(secret, steamid, gen));
  const got = Buffer.from(m[3]!);
  if (want.length !== got.length || !timingSafeEqual(want, got)) return null;
  return { steamid, gen };
}
