import type { DB } from './db.js';
import { resolveAlias } from './aliases.js';
import { getPlayer } from './players.js';

/**
 * Who a player is, in both worlds at once.
 *
 * Steam name and Discord name drift apart constantly ("mira" is "br1" on
 * Discord, "pedrito21" is "matedown"), and half of this site's audience
 * reads one and half reads the other. Everywhere a player gets named, this is
 * the one place that decides what "named" means, so a feed line or a card
 * never has to reinvent the rule.
 */
export interface Identity {
  steamid: string;
  steamName: string;
  discordId: string | null;
  discordName: string | null;
}

const MARKDOWN = /([\\*_~`|>[\]()@<])/g;

/** A plain name with Discord markdown neutralised, so "b*o_b" is not italic,
 *  "[x](http://evil)" is not a link, and "@everyone" or "<@123>" is not a
 *  mention: `\@` and `\<` both render as the literal character in Discord.
 *  Today's only backstop against a name like that is the transport sending
 *  allowedMentions: { parse: [] }, and a name is shown in places that never
 *  touch the transport (embed titles, button labels), so this escapes it at
 *  the source instead of relying on that alone. */
export function escapeName(name: string): string {
  return stripBidi(name).replace(MARKDOWN, '\\$1');
}

/** A name with its bidi controls removed. A Steam name holding U+202E (right
 *  to left override) flips the rest of the line it lands in: in the queue
 *  card the row's number jumped to the right and the SR to the left. Nothing
 *  a caller appends can close the override, so the control goes at the
 *  source. Written as a code point scan for the reason given on
 *  hasUnsafeChars in profileFields.ts. Zero width joiner (U+200D) stays,
 *  because emoji sequences are built from it. */
export function stripBidi(name: string): string {
  let out = '';
  for (const ch of name) {
    const c = ch.codePointAt(0)!;
    if (c === 0x061c) continue;                   // Arabic letter mark
    if (c === 0x200e || c === 0x200f) continue;   // LTR/RTL marks
    if (c >= 0x202a && c <= 0x202e) continue;     // bidi embedding and overrides
    if (c >= 0x2066 && c <= 0x2069) continue;     // bidi isolates
    out += ch;
  }
  return out;
}

/** The account this steamid really is, resolved through the alias table, with
 *  whatever the site knows about it. A steamid with no player row (most
 *  connect-drop steamids have never signed in) falls back to itself as the
 *  display name: there is nothing else to show. */
export function identityOf(db: DB, steamid: string): Identity {
  const canonical = resolveAlias(db, steamid);
  const player = getPlayer(db, canonical);
  return {
    steamid: canonical,
    steamName: player?.name ?? canonical,
    discordId: player?.discord_id ?? null,
    discordName: player?.discord_name ?? null,
  };
}

/** Case-insensitive name equality, for deciding whether showing both names
 *  would just say the same thing twice. */
export function sameName(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

/** Whether an identity is linked AND its Discord name says something the
 *  Steam name does not, which is the one condition under which plainLabel
 *  and plainLabelEscaped both show both names. */
function hasDistinctDiscordName(id: Identity): boolean {
  return Boolean(id.discordId && id.discordName && !sameName(id.steamName, id.discordName));
}

/**
 * For Discord message text and embed descriptions/fields, where mentions
 * render as the member's server nickname. Always names the steam identity in
 * bold and points at the linked Discord account beside it (or says there is
 * none), so a reader who only recognises one of the two names still knows who
 * this is.
 */
export function discordLabel(id: Identity): string {
  const name = `**${escapeName(id.steamName)}**`;
  return id.discordId ? `${name} (<@${id.discordId}>)` : `${name} (no Discord linked)`;
}

/**
 * For places Discord does NOT render mentions (embed titles, footers, button
 * labels, select options) and for the website. Just the steam name unless a
 * linked Discord name says something different, in which case both ride
 * together. Not escaped: callers escape for their own medium.
 */
export function plainLabel(id: Identity): string {
  if (hasDistinctDiscordName(id)) return `${stripBidi(id.steamName)} (Discord: ${stripBidi(id.discordName!)})`;
  return stripBidi(id.steamName);
}

/** plainLabel, markdown-escaped for a Discord surface that does not render
 *  mentions. */
export function plainLabelEscaped(id: Identity): string {
  if (hasDistinctDiscordName(id)) return `${escapeName(id.steamName)} (Discord: ${escapeName(id.discordName!)})`;
  return escapeName(id.steamName);
}
