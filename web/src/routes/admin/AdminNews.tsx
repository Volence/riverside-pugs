import { useState } from 'preact/hooks';
import { ApiError, newsApi, NEWS_BODY_MAX, type NewsAdminPost, type NewsEditorState, type NewsInput, type NewsKind } from '../../api';
import { useFetch } from '../../hooks/useFetch';
import { Panel } from '../../components/bits';
import { RichText } from '../../components/RichText';
import { confirm } from '../../components/Confirm';
import { NEWS_KIND_LABEL, newsDate } from '../News';
import { fmtTime } from './useAction';

/** "Patch notes Oct 21", dated today in the writer's time zone. */
export function patchTitle(now = new Date()): string {
  return `Patch notes ${now.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`;
}

export const PATCH_TEMPLATE = '## Changes\n- \n\n## Fixes\n- \n';

const BLANK: NewsInput = { kind: 'news', title: '', body: '' };

const DISCORD_LINE: Record<NewsAdminPost['discord'], string> = {
  none: 'Not on Discord',
  posted: 'Posted to Discord',
  pending: 'Waiting to reach Discord',
  removing: 'Being taken off Discord',
  skipped: 'Not posted to Discord (no news channel was set)',
};

/**
 * Setup > News: write a news post or patch notes, preview it as the site
 * shows it, save it as a draft, publish it, take it down, delete it. Publishing
 * also posts to the news channel on Discord (src/discord/newsPoster.ts); a
 * Discord problem never stops a publish, and the state line says what
 * happened there.
 */
export function AdminNews() {
  const { data: loaded, error: loadError } = useFetch((s) => newsApi.editor(s), []);
  // Every action answers with the whole editor state; it replaces what loaded.
  const [fresh, setFresh] = useState<NewsEditorState | null>(null);
  const data = fresh ?? loaded;
  const [id, setId] = useState<number | null>(null);
  const [form, setForm] = useState<NewsInput>(BLANK);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  if (loadError) return <Panel><p class="error">Could not load the news posts.</p></Panel>;
  if (!data) return <Panel><p class="muted">Loading...</p></Panel>;

  const current = id === null ? null : data.posts.find((p) => p.id === id) ?? null;
  const dirty = current
    ? current.kind !== form.kind || current.title !== form.title || current.body !== form.body
    : form.title !== '' || form.body !== '';

  const open = (p: NewsAdminPost | null) => {
    setError('');
    setId(p?.id ?? null);
    setForm(p ? { kind: p.kind, title: p.title, body: p.body } : BLANK);
  };

  const pickKind = (kind: NewsKind) => {
    // A new, untouched post switched to patch notes gets the dated title and
    // the bullet template; anything already written is left alone.
    if (kind === 'patch' && id === null && !form.title.trim() && !form.body.trim()) {
      setForm({ kind, title: patchTitle(), body: PATCH_TEMPLATE });
    } else {
      setForm({ ...form, kind });
    }
  };

  /** Run one call; adopt the state it answers with. */
  const act = async (fn: () => Promise<NewsEditorState>): Promise<NewsEditorState | null> => {
    setBusy(true);
    setError('');
    try {
      const next = await fn();
      setFresh(next);
      return next;
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Something went wrong.');
      return null;
    } finally {
      setBusy(false);
    }
  };

  /** Save what is in the form (a new draft, or an edit), and return its id. */
  const save = async (): Promise<number | null> => {
    if (id !== null && !dirty) return id;
    const next = await act(() => (id === null ? newsApi.create(form) : newsApi.update(id, form)));
    const saved = next?.post ?? null;
    if (saved) setId(saved.id);
    return saved?.id ?? null;
  };

  const publish = async () => {
    const ok = await confirm({
      title: `Publish "${form.title.trim()}"?`,
      body: data.channelSet
        ? 'It goes up on the site and is posted to the news channel on Discord.'
        : 'It goes up on the site. No news channel is set, so it is not posted to Discord, now or later.',
      confirmLabel: 'Publish',
    });
    if (!ok) return;
    const saved = await save();
    if (saved !== null) await act(() => newsApi.publish(saved));
  };

  const unpublish = async () => {
    if (id === null) return;
    const ok = await confirm({
      title: 'Unpublish this post?',
      body: 'It comes off the site and its Discord message is deleted. It stays here as a draft.',
      confirmLabel: 'Unpublish',
    });
    if (ok) await act(() => newsApi.unpublish(id));
  };

  const remove = async () => {
    if (id === null) return;
    const ok = await confirm({
      title: 'Delete this post?',
      body: 'It is gone for good, from the site and from Discord.',
      confirmLabel: 'Delete',
      danger: true,
    });
    if (!ok) return;
    if (await act(() => newsApi.remove(id))) open(null);
  };

  const published = current?.publishedAt != null;
  const canSave = !busy && form.title.trim() !== '' && dirty;
  const canPublish = !busy && form.title.trim() !== '' && form.body.trim() !== '' && !published;

  return (
    <div class="stack">
      {!data.channelSet && (
        <p class="newsadmin__notice">
          No news channel is set, so publishing puts a post on the site only and Discord is skipped. Set one under
          {' '}<a href="/admin/setup/settings">Settings</a>, Discord, News channel id.
        </p>
      )}
      {data.channelSet && !data.botConnected && (
        <p class="newsadmin__notice">The Discord bot is not connected. A post published now goes to Discord once it is.</p>
      )}
      <Panel>
        <div class="newsadmin__head">
          <h3>{current ? `Editing: ${current.title}` : 'New post'}</h3>
          {current && <button type="button" class="btn--ghost" onClick={() => open(null)} disabled={busy}>New post</button>}
        </div>
        {current && (
          <p class="muted newsadmin__state">
            {published ? `Published ${fmtTime(current.publishedAt)}` : 'Draft'}
            {' · '}{DISCORD_LINE[current.discord]}
            {current.discordError && <span class="error">{` · Discord said: ${current.discordError}`}</span>}
          </p>
        )}
        {error && <p class="error">{error}</p>}
        <div class="newsadmin__kinds" role="radiogroup" aria-label="Kind">
          {(['news', 'patch'] as const).map((k) => (
            <button key={k} type="button" role="radio" aria-checked={form.kind === k}
                    class={`chip${form.kind === k ? ' is-on' : ''}`} onClick={() => pickKind(k)}>
              {NEWS_KIND_LABEL[k]}
            </button>
          ))}
        </div>
        <label class="newsadmin__label" for="news-title">Title</label>
        <input id="news-title" class="newsadmin__title" value={form.title} maxLength={120}
               onInput={(e) => setForm({ ...form, title: (e.target as HTMLInputElement).value })} />
        <div class="newsadmin__write">
          <div>
            <label class="newsadmin__label" for="news-body">Body</label>
            <textarea id="news-body" class="newsadmin__body" value={form.body} maxLength={NEWS_BODY_MAX} rows={16}
                      onInput={(e) => setForm({ ...form, body: (e.target as HTMLTextAreaElement).value })} />
            <p class="muted newsadmin__help">
              A blank line starts a paragraph. <code>## Heading</code>, <code>**bold**</code>, <code>*italic*</code>,
              {' '}<code>- </code> for a bullet, <code>[text](https://...)</code> for a link. No HTML.
            </p>
          </div>
          <div>
            <p class="newsadmin__label" id="news-preview">Preview</p>
            <div class="newsadmin__preview" aria-labelledby="news-preview">
              {form.body.trim()
                ? <RichText text={form.body} max={NEWS_BODY_MAX} class="news__body" />
                : <p class="muted">The post shows here as the site will show it.</p>}
            </div>
          </div>
        </div>
        <div class="newsadmin__actions">
          <button type="button" class="btn--ghost" disabled={!canSave} onClick={() => void save()}>
            {published ? 'Save changes' : 'Save draft'}
          </button>
          {!published && <button type="button" class="btn" disabled={!canPublish} onClick={() => void publish()}>Publish</button>}
          {published && <button type="button" class="btn--ghost" disabled={busy} onClick={() => void unpublish()}>Unpublish</button>}
          {current && <button type="button" class="btn--ghost newsadmin__delete" disabled={busy} onClick={() => void remove()}>Delete</button>}
          {published && current && <a class="chip" href={`/news/${current.id}`}>View on the site</a>}
        </div>
      </Panel>
      <Panel class="panel--table">
        <h3>All posts</h3>
        {data.posts.length === 0 ? <p class="muted">Nothing written yet.</p> : (
          <div class="table-wrap">
            <table>
              <thead>
                <tr><th>Title</th><th>Kind</th><th>State</th><th>Discord</th></tr>
              </thead>
              <tbody>
                {data.posts.map((p) => (
                  <tr key={p.id} class={p.id === id ? 'is-selected' : undefined}>
                    <td><button type="button" class="linklike" onClick={() => open(p)}>{p.title}</button></td>
                    <td>{NEWS_KIND_LABEL[p.kind]}</td>
                    <td>{p.publishedAt ? `Published ${newsDate(p.publishedAt)}` : 'Draft'}</td>
                    <td class={p.discordError ? 'error' : 'muted'}>{DISCORD_LINE[p.discord]}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>
    </div>
  );
}
