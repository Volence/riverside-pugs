import { useState } from 'preact/hooks';
import { api, adminApi } from '../../api';
import { useFetch } from '../../hooks/useFetch';
import { Panel } from '../../components/bits';
import { fmtTime, useAction } from './useAction';

export function AdminSeasons() {
  const { data, reload } = useFetch((s) => api.seasons(s), []);
  const { busy, error, run } = useAction(reload);
  const [rename, setRename] = useState('');
  const [next, setNext] = useState('');

  if (!data) return <Panel><p class="muted">Loading...</p></Panel>;
  const current = data.seasons.find((s) => s.current);

  return (
    <div class="stack">
      {error && <p class="error">{error}</p>}
      {current && (
        <Panel>
          <h3>Current season</h3>
          <p><strong>{current.name}</strong> <span class="muted">· started {fmtTime(current.startedAt)} · {current.matches} matches</span></p>
          <form class="admin-form" onSubmit={(e) => { e.preventDefault(); void run(() => adminApi.renameSeason(current.id, rename)).then(() => setRename('')); }}>
            <input value={rename} placeholder="New name" aria-label="Rename season" onInput={(e) => setRename((e.target as HTMLInputElement).value)} />
            <button class="btn" type="submit" disabled={busy || !rename.trim()}>Rename</button>
          </form>
        </Panel>
      )}
      <Panel>
        <h3>Start a new season</h3>
        <p class="muted">
          Ends {current ? current.name : 'the current season'} now. Everyone starts the new season with a fresh
          rating and no record. The old season's leaderboard, matches and stats stay viewable. Not possible
          while a match is being set up or played.
        </p>
        <form class="admin-form" onSubmit={(e) => {
          e.preventDefault();
          void run(
            () => adminApi.newSeason(next),
            `End ${current?.name ?? 'the current season'} and start "${next}"? Every rating resets for the new season.`,
          ).then(() => setNext(''));
        }}>
          <input value={next} placeholder="e.g. Season 1" aria-label="New season name" onInput={(e) => setNext((e.target as HTMLInputElement).value)} />
          <button class="btn" type="submit" disabled={busy || !next.trim()}>Start season</button>
        </form>
      </Panel>
      <Panel>
        <h3>All seasons</h3>
        <ul class="admin-list">
          {data.seasons.map((s) => (
            <li key={s.id}>
              <strong>{s.name}</strong> <span class="muted">· {fmtTime(s.startedAt)} to {s.endedAt ? fmtTime(s.endedAt) : 'now'} · {s.matches} matches</span>
            </li>
          ))}
        </ul>
      </Panel>
    </div>
  );
}
