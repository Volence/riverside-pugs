import type { NewsKind } from '../news.js';
import type { MessagePayload } from './transport.js';

/** Discord's limit on a bot message's content. The post goes up as a plain
 *  message rather than an embed: an embed is a narrow card that shows
 *  headings as bold lines, a message gets the full width and real headings,
 *  the same as a post staff write in the channel by hand. */
export const NEWS_MESSAGE_MAX = 2000;

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
  const out = lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  if (out.length <= max) return out;
  const room = max - MORE.length - 2;
  const cut = out.slice(0, room);
  const at = Math.max(cut.lastIndexOf('\n'), cut.lastIndexOf(' '));
  return `${(at > room / 2 ? cut.slice(0, at) : cut).trimEnd()}\n\n${MORE}`;
}

/** The news channel's message for one post: the title as a heading, the kind
 *  in small text under it, the body trimmed to fit, and a link button to the
 *  post on the site. No embed and no mentions. */
export function newsPayload(
  post: { id: number; kind: NewsKind; title: string; body: string }, publicUrl: string,
): MessagePayload {
  const url = `${publicUrl}/news/${post.id}`;
  const head = `# ${post.title.replace(/\s+/g, ' ').trim()}\n-# ${LABEL[post.kind]}`;
  const body = discordBody(post.body, NEWS_MESSAGE_MAX - head.length - 2);
  return {
    content: body ? `${head}\n\n${body}` : head,
    embeds: [],
    components: [[{ kind: 'link', url, label: 'Read on the site' }]],
    mentionUserIds: [],
    mentionRoleIds: [],
  };
}
