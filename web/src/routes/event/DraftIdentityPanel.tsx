import { useState } from 'preact/hooks';
import { ApiError, eventsApi, entryLogoUrl, type MyEventView } from '../../api';
import { Panel } from '../../components/bits';
import { toLogoPng } from '../../teamLogo';

type Mine = NonNullable<MyEventView['captainOf']>;

/** A draft captain's own team identity (drafts plan D2a Ruling 7): name, tag
 *  and logo until the event goes live. Shows nothing once it is not editable. */
export function DraftIdentityPanel({ slug, mine, onChange }: { slug: string; mine: Mine; onChange: () => void }) {
  const [name, setName] = useState(mine.name);
  const [tag, setTag] = useState(mine.tag);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  if (!mine.editable) return null;
  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError('');
    try {
      await fn();
      onChange();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Something went wrong.');
    } finally {
      setBusy(false);
    }
  };
  return (
    <Panel class="entrypanel draftidentity">
      <h3>Your team</h3>
      {mine.logoKey && <img class="evententry__logo" src={entryLogoUrl(mine.logoKey)} alt="" width={28} height={28} />}
      <form class="teamform" onSubmit={(e) => {
        e.preventDefault();
        const body: { name?: string; tag?: string } = {};
        if (name !== mine.name) body.name = name;
        if (tag !== mine.tag) body.tag = tag;
        if (body.name !== undefined || body.tag !== undefined) void run(() => eventsApi.setIdentity(slug, mine.entryId, body));
      }}>
        <label>Team name <input type="text" aria-label="Team name" maxLength={24} value={name} onInput={(e) => setName((e.target as HTMLInputElement).value)} /></label>
        <label>Tag (optional) <input type="text" aria-label="Tag (optional)" maxLength={5} value={tag} onInput={(e) => setTag((e.target as HTMLInputElement).value)} /></label>
        <button class="btn" type="submit" disabled={busy}>Save</button>
      </form>
      <label class="btn btn--ghost btn--sm">
        {mine.logoKey ? 'Replace logo' : 'Upload logo'}
        <input class="sr-only" type="file" accept="image/*" aria-label="Logo" disabled={busy} onChange={(e) => {
          const f = (e.target as HTMLInputElement).files?.[0];
          if (f) void run(async () => eventsApi.setLogo(slug, mine.entryId, await toLogoPng(f)));
        }} />
      </label>
      {error && <p class="error" role="alert">{error}</p>}
    </Panel>
  );
}
