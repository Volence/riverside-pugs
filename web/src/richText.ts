/**
 * A small, safe markdown subset for text staff write and everyone reads (an
 * event's description, tournaments plan T1a Ruling 1). Pure: it turns text
 * into a tree of blocks and inlines, and web/src/components/RichText.tsx
 * turns the tree into Preact elements. Nothing here ever produces an HTML
 * string, so whatever the text holds (tags, entities, script) is shown as the
 * characters it is.
 *
 * Supported: # ## ### headings; paragraphs, a single line break kept as a
 * break; **bold**, *italic*; "- " / "* " / "+ " and "1. " / "1) " lists (flat);
 * [text](url) and bare URLs, both only for http:// and https://; "> "
 * quote lines; Discord timestamps (<t:1794700800:F>), shown in the reader's
 * own time zone, since a news post goes to Discord as it is written (owner
 * 2026-11-09). Anything else, including a link to any other scheme, is plain
 * text.
 */

export type Inline =
  | { kind: 'text'; text: string }
  | { kind: 'strong'; children: Inline[] }
  | { kind: 'em'; children: Inline[] }
  | { kind: 'link'; href: string; children: Inline[] }
  | { kind: 'time'; unix: number; style: TimeStyle }
  | { kind: 'br' };

/** Discord's timestamp styles; f is Discord's default. */
export type TimeStyle = 't' | 'T' | 'd' | 'D' | 'f' | 'F' | 'R';

export type Block =
  | { kind: 'heading'; level: 1 | 2 | 3; children: Inline[] }
  | { kind: 'paragraph'; children: Inline[] }
  | { kind: 'quote'; children: Inline[] }
  | { kind: 'list'; ordered: boolean; items: Inline[][] };

/** The server caps a description at 4000 characters; the parser holds to the
 *  same, so nothing longer is ever worked through on a page. */
export const RICH_TEXT_MAX = 4000;
/** How deep **bold** and *italic* may nest before the rest is plain text. */
const MAX_DEPTH = 4;

/** An http or https URL as the browser would resolve it, or null. */
export function safeHref(raw: string): string | null {
  const url = raw.trim();
  if (!/^https?:\/\/\S+$/i.test(url)) return null;
  try {
    const u = new URL(url);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.href : null;
  } catch {
    return null;
  }
}

/** A Discord timestamp, as Discord takes it: whole seconds and an optional
 *  style letter. Sticky, like BARE_URL. */
const DISCORD_TIME = /<t:(-?\d{1,13})(?::([tTdDfFR]))?>/y;

const TIME_FORMATS: Record<Exclude<TimeStyle, 'R'>, Intl.DateTimeFormatOptions> = {
  t: { hour: 'numeric', minute: '2-digit' },
  T: { hour: 'numeric', minute: '2-digit', second: '2-digit' },
  d: { year: 'numeric', month: '2-digit', day: '2-digit' },
  D: { year: 'numeric', month: 'long', day: 'numeric' },
  f: { year: 'numeric', month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit' },
  F: { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit' },
};
const RELATIVE: [Intl.RelativeTimeFormatUnit, number][] = [
  ['year', 31_536_000], ['month', 2_592_000], ['day', 86_400], ['hour', 3_600], ['minute', 60], ['second', 1],
];

/** A Discord timestamp as Discord shows it, in the reader's locale and time
 *  zone (or the ones given, for tests). R is relative to `now`. */
export function formatDiscordTime(unix: number, style: TimeStyle, now = Date.now(), locale?: string, timeZone?: string): string {
  if (style === 'R') {
    const diff = unix - Math.round(now / 1000);
    const [unit, secs] = RELATIVE.find(([, s]) => Math.abs(diff) >= s) ?? RELATIVE[RELATIVE.length - 1]!;
    return new Intl.RelativeTimeFormat(locale, { numeric: 'auto' }).format(Math.round(diff / secs), unit);
  }
  return new Date(unix * 1000).toLocaleString(locale, { ...TIME_FORMATS[style], timeZone });
}

/** Plain text with every Discord timestamp written out, for places that show
 *  text without markup (a news excerpt). */
export function localizeDiscordTimes(text: string, now = Date.now()): string {
  return text.replace(/<t:(-?\d{1,13})(?::([tTdDfFR]))?>/g, (m, unix: string, style?: string) =>
    (validUnix(Number(unix)) ? formatDiscordTime(Number(unix), (style ?? 'f') as TimeStyle, now) : m));
}

/** Within the range a JavaScript Date holds. */
const validUnix = (unix: number) => Math.abs(unix) <= 8_640_000_000_000;

/** Sticky: tried at one position, never searched for. */
const BARE_URL = /https?:\/\/[^\s<>"]+/iy;
/** Punctuation that ends a sentence rather than the URL it follows. */
const TRAILING = /[.,;:!?)\]'"]+$/;

function pushText(out: Inline[], text: string): void {
  if (!text) return;
  const last = out[out.length - 1];
  if (last && last.kind === 'text') last.text += text;
  else out.push({ kind: 'text', text });
}

/** Inline markup in one line or one list item. `inLink` keeps link text from
 *  holding another link. */
export function parseInline(src: string, depth = 0, inLink = false): Inline[] {
  const out: Inline[] = [];
  if (depth > MAX_DEPTH) {
    pushText(out, src);
    return out;
  }
  let i = 0;
  while (i < src.length) {
    if (src.startsWith('**', i)) {
      const end = src.indexOf('**', i + 2);
      if (end > i + 2) {
        out.push({ kind: 'strong', children: parseInline(src.slice(i + 2, end), depth + 1, inLink) });
        i = end + 2;
        continue;
      }
      pushText(out, '**');
      i += 2;
      continue;
    }
    if (src[i] === '*') {
      const end = src.indexOf('*', i + 1);
      if (end > i + 1 && src[i + 1] !== ' ') {
        out.push({ kind: 'em', children: parseInline(src.slice(i + 1, end), depth + 1, inLink) });
        i = end + 1;
        continue;
      }
      pushText(out, '*');
      i += 1;
      continue;
    }
    if (!inLink && src[i] === '[') {
      const mid = src.indexOf('](', i + 1);
      const end = mid < 0 ? -1 : src.indexOf(')', mid + 2);
      if (mid > i + 1 && end > mid + 2 && !src.slice(i + 1, mid).includes('\n')) {
        const href = safeHref(src.slice(mid + 2, end));
        if (href) {
          out.push({ kind: 'link', href, children: parseInline(src.slice(i + 1, mid), depth + 1, true) });
        } else {
          pushText(out, src.slice(i, end + 1));
        }
        i = end + 1;
        continue;
      }
    }
    if (src[i] === '<') {
      DISCORD_TIME.lastIndex = i;
      const m = DISCORD_TIME.exec(src);
      if (m && validUnix(Number(m[1]))) {
        out.push({ kind: 'time', unix: Number(m[1]), style: (m[2] ?? 'f') as TimeStyle });
        i += m[0].length;
        continue;
      }
    }
    if (!inLink) {
      BARE_URL.lastIndex = i;
      const m = BARE_URL.exec(src);
      if (m) {
        const url = m[0].replace(TRAILING, '');
        const href = safeHref(url);
        if (href) {
          out.push({ kind: 'link', href, children: [{ kind: 'text', text: url }] });
          i += url.length;
          continue;
        }
      }
    }
    // Plain text up to the next character that could start markup.
    let j = i + 1;
    while (j < src.length && !'*[h<'.includes(src[j]!)) j++;
    pushText(out, src.slice(i, j));
    i = j;
  }
  return out;
}

const HEADING = /^(#{1,3})\s+(.+)$/;
const BULLET = /^\s*[-*+]\s+(.*)$/;
const NUMBERED = /^\s*\d{1,9}[.)]\s+(.*)$/;
/** Discord's one-line quote: "> " at the start of the line (or a lone ">"). */
const QUOTE = /^\s*>(?:\s(.*))?$/;

/** The whole text as blocks. Lines are joined into paragraphs, a single line
 *  break kept as a break; a blank line, a heading or a list ends one. `max`
 *  is where the text is cut: an event description's cap by default, a news
 *  post's (src/news.ts NEWS_BODY_MAX) when one is shown. */
export function parseRichText(text: string, max = RICH_TEXT_MAX): Block[] {
  const lines = text.slice(0, max).replace(/\r\n?/g, '\n').split('\n');
  const blocks: Block[] = [];
  let para: string[] = [];
  let list: { ordered: boolean; items: Inline[][] } | null = null;
  let quote: string[] = [];
  const flush = () => {
    if (quote.length > 0) {
      const children: Inline[] = [];
      quote.forEach((line, n) => {
        if (n > 0) children.push({ kind: 'br' });
        children.push(...parseInline(line));
      });
      blocks.push({ kind: 'quote', children });
      quote = [];
    }
    if (para.length > 0) {
      const children: Inline[] = [];
      para.forEach((line, n) => {
        if (n > 0) children.push({ kind: 'br' });
        children.push(...parseInline(line));
      });
      blocks.push({ kind: 'paragraph', children });
      para = [];
    }
    if (list) {
      blocks.push({ kind: 'list', ordered: list.ordered, items: list.items });
      list = null;
    }
  };
  for (const line of lines) {
    if (line.trim() === '') { flush(); continue; }
    const h = HEADING.exec(line);
    if (h) {
      flush();
      blocks.push({ kind: 'heading', level: h[1]!.length as 1 | 2 | 3, children: parseInline(h[2]!.trim()) });
      continue;
    }
    const q = QUOTE.exec(line);
    if (q) {
      if (quote.length === 0) flush();
      quote.push((q[1] ?? '').trim());
      continue;
    }
    if (quote.length > 0) flush();
    const bullet = BULLET.exec(line);
    const numbered = bullet ? null : NUMBERED.exec(line);
    const item = bullet ?? numbered;
    if (item) {
      const ordered = numbered !== null;
      if (para.length > 0 || (list && list.ordered !== ordered)) flush();
      if (!list) list = { ordered, items: [] };
      list.items.push(parseInline(item[1]!));
      continue;
    }
    if (list) flush();
    para.push(line.trim());
  }
  flush();
  return blocks;
}
