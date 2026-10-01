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
 * [text](url) and bare URLs, both only for http:// and https://. Anything
 * else, including a link to any other scheme, is plain text.
 */

export type Inline =
  | { kind: 'text'; text: string }
  | { kind: 'strong'; children: Inline[] }
  | { kind: 'em'; children: Inline[] }
  | { kind: 'link'; href: string; children: Inline[] }
  | { kind: 'br' };

export type Block =
  | { kind: 'heading'; level: 1 | 2 | 3; children: Inline[] }
  | { kind: 'paragraph'; children: Inline[] }
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
    while (j < src.length && !'*[h'.includes(src[j]!)) j++;
    pushText(out, src.slice(i, j));
    i = j;
  }
  return out;
}

const HEADING = /^(#{1,3})\s+(.+)$/;
const BULLET = /^\s*[-*+]\s+(.*)$/;
const NUMBERED = /^\s*\d{1,9}[.)]\s+(.*)$/;

/** The whole text as blocks. Lines are joined into paragraphs, a single line
 *  break kept as a break; a blank line, a heading or a list ends one. */
export function parseRichText(text: string): Block[] {
  const lines = text.slice(0, RICH_TEXT_MAX).replace(/\r\n?/g, '\n').split('\n');
  const blocks: Block[] = [];
  let para: string[] = [];
  let list: { ordered: boolean; items: Inline[][] } | null = null;
  const flush = () => {
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
