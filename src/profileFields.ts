import { isCountryCode } from './countries.js';

export type Validated =
  | { ok: true; value: string | null }
  | { ok: false; error: string };

const ok = (value: string | null): Validated => ({ ok: true, value });
const bad = (error: string): Validated => ({ ok: false, error });

export interface LinkPlatform {
  key: string;
  label: string;
  placeholder: string;
  /** The shape a handle must have on this platform, after the @ is stripped. */
  pattern: RegExp;
  url(handle: string): string;
}

/**
 * The closed set of off-site platforms, and how to turn a handle into a link.
 *
 * This is the only place a profile URL is ever constructed. Nothing stores or
 * renders a URL a player typed, which is what makes it structurally impossible
 * to hang a phishing link off a public profile rather than a rule somebody has
 * to remember to enforce.
 *
 * Every pattern excludes '/', ':', '?', '#', '%', '@' and whitespace, and
 * excludes '.' where the platform does not need it, so a handle can never
 * carry the template into another path or another host. A test walks every
 * platform with every probe handle and asserts the resulting origin is
 * unchanged, so this claim is checked rather than merely stated.
 */
export const LINK_PLATFORMS: readonly LinkPlatform[] = Object.freeze([
  {
    key: 'youtube',
    label: 'YouTube',
    placeholder: '@handle',
    pattern: /^[A-Za-z0-9._-]{3,30}$/,
    url: (h) => `https://www.youtube.com/@${h}`,
  },
  {
    key: 'x',
    label: 'X',
    placeholder: '@handle',
    pattern: /^[A-Za-z0-9_]{1,15}$/,
    url: (h) => `https://x.com/${h}`,
  },
  {
    // The only platform where dots are part of the handle, because a Bluesky
    // handle is a domain name. The pattern still forbids everything that could
    // leave the path segment.
    key: 'bluesky',
    label: 'Bluesky',
    placeholder: 'name.bsky.social',
    pattern: /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)+$/,
    url: (h) => `https://bsky.app/profile/${h}`,
  },
  {
    key: 'tiktok',
    label: 'TikTok',
    placeholder: '@handle',
    pattern: /^[A-Za-z0-9._]{2,24}$/,
    url: (h) => `https://www.tiktok.com/@${h}`,
  },
]);

export const PLATFORM_KEYS: readonly string[] =
  Object.freeze(LINK_PLATFORMS.map((p) => p.key));

// A Map rather than an object literal, so a key like '__proto__' or
// 'constructor' is a miss rather than something inherited from Object.
const BY_KEY = new Map(LINK_PLATFORMS.map((p) => [p.key, p]));

export function isPlatform(key: string): boolean {
  return BY_KEY.has(key);
}

export function linkUrl(platform: string, handle: string): string | null {
  return BY_KEY.get(platform)?.url(handle) ?? null;
}

/**
 * Text a player may not put anywhere: control characters, and the invisible
 * formatting and bidi overrides that let a string render as something other
 * than what it is.
 *
 * Written as a code point scan rather than a regex character class on purpose.
 * A class of \u escapes is easy to corrupt silently when this file is edited,
 * and a corrupted one still compiles and still matches something, just not
 * what it says. The ranges are legible here and a test pins them.
 */
function hasUnsafeChars(s: string): boolean {
  for (const ch of s) {
    const c = ch.codePointAt(0)!;
    if (c <= 0x1f || c === 0x7f) return true;              // C0 controls, DEL
    if (c >= 0x80 && c <= 0x9f) return true;               // C1 controls
    if (c >= 0x200b && c <= 0x200f) return true;           // zero width, LTR/RTL marks
    if (c === 0x2028 || c === 0x2029) return true;         // line, paragraph separator
    if (c >= 0x202a && c <= 0x202e) return true;           // bidi embedding and overrides
    if (c >= 0x2066 && c <= 0x2069) return true;           // bidi isolates
    if (c === 0xfeff) return true;                         // zero width no-break space
  }
  return false;
}

/** Anything link-shaped. Deliberately broad, because the bio is prose and a
 *  false positive costs somebody one rephrase, while a false negative puts a
 *  clickable-looking domain on a public page. */
const LINKISH = /(?:[a-z][a-z0-9+.-]*:)|(?:\bwww\.)|(?:[a-z0-9-]+\.(?:com|net|org|gg|io|tv|co|me|xyz|link|ru|cn|info|biz|top|site|live|app|dev|gl|ly))\b/i;

function asString(raw: unknown): string | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  return trimmed === '' ? null : trimmed;
}

export function validateBio(raw: unknown): Validated {
  if (raw !== null && raw !== undefined && typeof raw !== 'string') return bad('bio must be text');
  const v = asString(raw);
  if (v === null) return ok(null);
  if (v.length > 200) return bad('bio is limited to 200 characters');
  if (hasUnsafeChars(v)) return bad('bio must be a single line of plain text');
  if (LINKISH.test(v)) return bad('bio cannot contain links. Use the social fields instead.');
  return ok(v);
}

export function validatePronouns(raw: unknown): Validated {
  if (raw !== null && raw !== undefined && typeof raw !== 'string') return bad('pronouns must be text');
  const v = asString(raw);
  if (v === null) return ok(null);
  if (v.length > 24) return bad('pronouns are limited to 24 characters');
  if (!/^[A-Za-z][A-Za-z/ '-]*$/.test(v)) return bad('pronouns may only use letters, spaces and slashes');
  return ok(v);
}

export function validateCountry(raw: unknown): Validated {
  if (raw !== null && raw !== undefined && typeof raw !== 'string') return bad('country must be text');
  const v = asString(raw);
  if (v === null) return ok(null);
  if (!isCountryCode(v)) return bad('country must be a two letter country code');
  return ok(v.toUpperCase());
}

export function validateHandle(platform: string, raw: unknown): Validated {
  const p = BY_KEY.get(platform);
  if (!p) return bad('unknown platform');
  if (raw !== null && raw !== undefined && typeof raw !== 'string') return bad('handle must be text');
  const trimmed = asString(raw);
  if (trimmed === null) return ok(null);
  // One leading @ is how people write these, everywhere. Anything past that is
  // not a handle, and the pattern rejects a second one.
  const v = trimmed.startsWith('@') ? trimmed.slice(1) : trimmed;
  if (v === '') return ok(null);
  if (hasUnsafeChars(v)) return bad(`that is not a ${p.label} handle`);
  if (!p.pattern.test(v)) return bad(`that is not a ${p.label} handle`);
  return ok(v);
}
