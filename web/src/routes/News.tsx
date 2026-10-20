import { useLocation } from 'preact-iso';
import { newsApi, NEWS_BODY_MAX, ApiError, type NewsKind, type NewsPost } from '../api';
import { useFetch } from '../hooks/useFetch';
import { Empty, Panel } from '../components/bits';
import { PageHeader } from '../components/PageHeader';
import { RichText } from '../components/RichText';

export const NEWS_KIND_LABEL: Record<NewsKind, string> = { news: 'News', patch: 'Patch notes' };

/** "Oct 21, 2026" in the reader's own time zone. */
export function newsDate(iso: string): string {
  const t = Date.parse(iso);
  return Number.isNaN(t) ? iso : new Date(t).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function Meta({ post }: { post: Pick<NewsPost, 'kind' | 'publishedAt' | 'author'> }) {
  return (
    <p class="news__meta">
      <span class={`news__kind news__kind--${post.kind}`}>{NEWS_KIND_LABEL[post.kind]}</span>
      <time dateTime={post.publishedAt}>{newsDate(post.publishedAt)}</time>
      {post.author && <span class="muted">by <a href={`/player/${encodeURIComponent(post.author.steamid)}`}>{post.author.name}</a></span>}
    </p>
  );
}

/** /news: every published post, newest first, ten to a page (?page=2).
 *  With kind="patch" it is /patch-notes: only the hand-written patch notes,
 *  with a way to the full change log the balance tracker keeps (/balance). */
export function News({ kind }: { kind?: NewsKind } = {}) {
  const { query } = useLocation();
  const page = Math.max(1, Math.floor(Number(query.page) || 1));
  const { data, error } = useFetch((s) => newsApi.list(s, page, undefined, kind), [page, kind]);
  const base = kind === 'patch' ? '/patch-notes' : '/news';
  return (
    <div class="page page--news">
      {kind === 'patch' ? (
        <PageHeader eyebrow="Riverside" title="Patch notes">
          <p>What changed and why, in plain words. Every exact number the game tracks is in the <a href="/balance">full change log</a>.</p>
        </PageHeader>
      ) : <PageHeader eyebrow="Riverside" title="News" />}
      {error && <Panel><p class="error">Could not load the news.</p></Panel>}
      {!error && !data && <Panel><p class="muted">Loading...</p></Panel>}
      {data && data.posts.length === 0 && <Panel><Empty>Nothing posted yet.</Empty></Panel>}
      {data && data.posts.length > 0 && (
        <ol class="news__list">
          {data.posts.map((p) => (
            <li key={p.id}>
              <Panel class="news__item">
                <Meta post={p} />
                <h3 class="news__title"><a href={`/news/${p.id}`}>{p.title}</a></h3>
                {p.excerpt && <p class="news__excerpt">{p.excerpt}</p>}
              </Panel>
            </li>
          ))}
        </ol>
      )}
      {data && data.pages > 1 && (
        <nav class="news__pager" aria-label="Pages">
          {page > 1 && <a class="chip" href={page === 2 ? base : `${base}?page=${page - 1}`}>Newer</a>}
          <span class="muted">Page {page} of {data.pages}</span>
          {page < data.pages && <a class="chip" href={`${base}?page=${page + 1}`}>Older</a>}
        </nav>
      )}
    </div>
  );
}

/** /patch-notes: the hand-written patch notes only. */
export function PatchNotes() {
  return <News kind="patch" />;
}

/** /news/:id: one post in full. */
export function NewsPostPage({ id }: { id?: string }) {
  const n = Number(id);
  const { data, error } = useFetch((s) => newsApi.post(n, s), [n]);
  if (error) {
    const missing = error instanceof ApiError && error.status === 404;
    return (
      <div class="page page--news">
        <PageHeader eyebrow="News" title={missing ? 'Post not found' : 'Could not load this post'} />
        <Panel>
          <p class="muted">{missing ? 'That post does not exist, or it was taken down.' : 'Try again in a moment.'}</p>
          <a class="chip" href="/news">All news</a>
        </Panel>
      </div>
    );
  }
  if (!data) return <div class="page page--news"><Panel><p class="muted">Loading...</p></Panel></div>;
  const p = data.post;
  return (
    <div class="page page--news">
      <PageHeader eyebrow={NEWS_KIND_LABEL[p.kind]} title={p.title} />
      <article class="news__post">
        <Meta post={p} />
        <Panel>
          <RichText text={p.body} max={NEWS_BODY_MAX} class="news__body" />
        </Panel>
      </article>
      <p><a class="chip" href="/news">All news</a></p>
    </div>
  );
}

export default News;
