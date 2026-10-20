import type { NewsKind } from '../news.js';
import type { MessagePayload } from './transport.js';

/** How much of the body the embed carries. Discord allows 4096 in a
 *  description; a news post in a channel reads better short, with the rest a
 *  click away. */
export const NEWS_EMBED_BODY_MAX = 1500;

const COLOR: Record<NewsKind, number> = { news: 0xc8102e, patch: 0x2bb3a3 };
const LABEL: Record<NewsKind, string> = { news: 'News', patch: 'Patch notes' };

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
 * The body as Discord markdown: the site's subset is nearly Discord's own, so
 * this only turns headings into bold lines (an embed shows # literally on
 * some clients) and drops any link whose target is not http or https, keeping
 * its text. Mentions cannot ping from an embed, and the payload allows none.
 * Cut at a line break near `max` with a pointer to the rest on the site.
 */
export function discordBody(body: string, max = NEWS_EMBED_BODY_MAX): string {
  const lines = body.replace(/\r\n?/g, '\n').split('\n').map((line) => {
    const h = /^\s*#{1,3}\s+(.+)$/.exec(line);
    const text = h ? `**${h[1]!.trim()}**` : line;
    return text.replace(/\[([^\]\n]*)\]\(([^)\s]*)\)/g, (all, label: string, href: string) => {
      const ok = safeHref(href);
      return ok ? `[${label}](${ok})` : label;
    });
  });
  const out = lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  if (out.length <= max) return out;
  const room = max - 40;
  const cut = out.slice(0, room);
  const at = Math.max(cut.lastIndexOf('\n'), cut.lastIndexOf(' '));
  return `${(at > room / 2 ? cut.slice(0, at) : cut).trimEnd()}\n\n*Read the rest on the site.*`;
}

/** The news channel's message for one post: an embed titled and linked to
 *  the post on the site, the trimmed body, the kind as the footer, and a
 *  link button. No content line and no mentions. */
export function newsPayload(
  post: { id: number; kind: NewsKind; title: string; body: string }, publicUrl: string,
): MessagePayload {
  const url = `${publicUrl}/news/${post.id}`;
  return {
    embeds: [{
      title: post.title.slice(0, 256),
      url,
      description: discordBody(post.body) || undefined,
      color: COLOR[post.kind],
      footer: LABEL[post.kind],
    }],
    components: [[{ kind: 'link', url, label: 'Read on the site' }]],
    mentionUserIds: [],
    mentionRoleIds: [],
  };
}
