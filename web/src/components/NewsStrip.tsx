import { useState } from 'preact/hooks';
import { newsApi } from '../api';
import { useFetch } from '../hooks/useFetch';
import { NEWS_KIND_LABEL } from '../routes/News';

/** Where the last post a viewer closed is remembered: its id. A newer post
 *  has a bigger id and shows again. */
export const NEWS_DISMISS_KEY = 'news-strip-dismissed';

function dismissedId(): number {
  try {
    return Number(localStorage.getItem(NEWS_DISMISS_KEY)) || 0;
  } catch {
    return 0;
  }
}

/**
 * One line on the Play page: the latest post's title, linking to it, with a
 * close button. Closing hides that post for this browser only; the next post
 * shows again. Shows nothing when there is no post, or the read fails: it is
 * never in the way of the queue.
 */
export function NewsStrip() {
  const { data } = useFetch((s) => newsApi.list(s, 1, 1).catch(() => null), []);
  const [closed, setClosed] = useState(dismissedId);
  const post = data?.posts?.[0];
  if (!post || post.id <= closed) return null;
  const close = () => {
    try {
      localStorage.setItem(NEWS_DISMISS_KEY, String(post.id));
    } catch {
      // Storage refused (private mode, blocked site data): it closes for this visit only.
    }
    setClosed(post.id);
  };
  return (
    <aside class="newsstrip" aria-label="Latest news">
      <span class={`news__kind news__kind--${post.kind}`}>{NEWS_KIND_LABEL[post.kind]}</span>
      <a class="newsstrip__title" href={`/news/${post.id}`}>{post.title}</a>
      <button type="button" class="newsstrip__close" aria-label="Hide this post" onClick={close}>×</button>
    </aside>
  );
}
