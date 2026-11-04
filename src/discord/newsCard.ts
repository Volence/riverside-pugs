import type { NewsKind } from '../news.js';
import type { MessagePayload } from './transport.js';

/** Discord's limit on a bot message's content. The post goes up as plain
 *  messages rather than an embed: an embed is a narrow card that shows
 *  headings as bold lines, a message gets the full width and real headings,
 *  the same as a post staff write in the channel by hand. */
export const NEWS_MESSAGE_MAX = 2000;
/** A long post is split over several messages in a row, up to this many;
 *  past that the last one points to the rest on the site. */
export const NEWS_MESSAGES_MAX = 5;

const LABEL: Record<NewsKind, string> = { news: 'News', patch: 'Patch notes' };
const MORE = '*Read the rest on the site.*';

/** http and https links only, as on the site. */
function safeHref(raw: string): string | null {
  const url = raw.trim();
  if (!/^https?:\/\/\S+$/i.test(url)) return null;
  try {
    const u = new URL(url);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.href : null;
  } catch {
    return null;
  }
}

/**
 * The body as Discord markdown: the site's subset is nearly Discord's own,
 * headings included, so this only drops any link whose target is not http or
 * https, keeping its text, and puts every link target in <> so Discord shows
 * no preview card under the post. Mentions cannot ping: the payload allows
 * none. Cut at a line break near `max` with a pointer to the rest on the site.
 */
export function discordBody(body: string, max = NEWS_MESSAGE_MAX): string {
  const lines = body.replace(/\r\n?/g, '\n').split('\n').map((line) =>
    line
      .replace(/\[([^\]\n]*)\]\(([^)\s]*)\)/g, (all, label: string, href: string) => {
        const ok = safeHref(href);
        return ok ? `[${label}](<${ok}>)` : label;
      })
      .replace(/(?<![(<\w])https?:\/\/[^\s<>]*[^\s<>.,;:!?)]/gi, '<$&>'));
  return cutWithMore(lines.join('\n').replace(/\n{3,}/g, '\n\n').trim(), max);
}

/** Text cut at a line break or space to fit `max`, ending with a pointer to
 *  the rest on the site. Text that fits comes back as it is. */
function cutWithMore(text: string, max: number): string {
  if (text.length <= max) return text;
  const room = max - MORE.length - 2;
  const cut = text.slice(0, room);
  const at = Math.max(cut.lastIndexOf('\n'), cut.lastIndexOf(' '));
  return `${(at > room / 2 ? cut.slice(0, at) : cut).trimEnd()}\n\n${MORE}`;
}

/**
 * Split text into pieces of at most `max` characters. Each cut goes before a
 * heading (or a run of headings with nothing between them) where one is in
 * the back half of the piece, else at a blank line,
 * a line break or a space, so a section starts a new message where it can.
 */
export function splitMessages(text: string, max = NEWS_MESSAGE_MAX): string[] {
  const out: string[] = [];
  let rest = text.trim();
  while (rest.length > max) {
    const win = rest.slice(0, max + 1);
    const half = max / 2;
    const headingAt = (text: string) => Math.max(...['\n# ', '\n## ', '\n### '].map((h) => text.lastIndexOf(h)));
    let heading = headingAt(win);
    // Headings with nothing between them stay together: the cut moves up
    // to the first of them.
    while (heading > half) {
      const before = win.slice(0, heading).trimEnd();
      const prev = headingAt(before);
      if (prev <= half || before.slice(prev + 1).includes('\n')) break;
      heading = prev;
    }
    const at = [heading, win.lastIndexOf('\n\n'), win.lastIndexOf('\n'), win.lastIndexOf(' ')].find((i) => i > half) ?? max;
    out.push(rest.slice(0, at).trimEnd());
    rest = rest.slice(at).trim();
  }
  if (rest) out.push(rest);
  return out;
}

/** The news channel's messages for one post, in order: the title as a
 *  heading with the kind in small text under it, then the body, split over
 *  as many messages as it needs (up to NEWS_MESSAGES_MAX). The last one
 *  carries the link button to the post on the site. No embeds, no mentions. */
export function newsPayloads(
  post: { id: number; kind: NewsKind; title: string; body: string }, publicUrl: string,
): MessagePayload[] {
  const url = `${publicUrl}/news/${post.id}`;
  const head = `# ${post.title.replace(/\s+/g, ' ').trim()}\n-# ${LABEL[post.kind]}`;
  const body = discordBody(post.body, Infinity);
  let parts = splitMessages(body ? `${head}\n\n${body}` : head);
  if (parts.length > NEWS_MESSAGES_MAX) {
    parts = parts.slice(0, NEWS_MESSAGES_MAX);
    parts[parts.length - 1] = cutWithMore(`${parts[parts.length - 1]}\n\n${MORE}`, NEWS_MESSAGE_MAX);
  }
  return parts.map((content, i) => ({
    content,
    embeds: [],
    components: i === parts.length - 1 ? [[{ kind: 'link', url, label: 'Read on the site' }]] : [],
    mentionUserIds: [],
    mentionRoleIds: [],
  }));
}
