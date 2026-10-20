import { useState } from 'preact/hooks';
import { api, adminApi, SEASON_THEMES, type SeasonThemeId } from '../../api';
import { useFetch } from '../../hooks/useFetch';
import { Panel } from '../../components/bits';
import { fmtTime, useAction } from './useAction';
import { RankBadge } from '../../components/SeasonRank';

export function AdminSeasons() {
  const { data, reload } = useFetch((s) => api.seasons(s), []);
  const { busy, error, run } = useAction(reload);
  const [rename, setRename] = useState('');
  const [next, setNext] = useState('');
  const [nextTheme, setNextTheme] = useState<SeasonThemeId | ''>('wrong-way');
  const [nextEnds, setNextEnds] = useState('');

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
          <SeasonLookForm key={current.id} id={current.id} theme={current.theme} endsAt={current.endsAt} busy={busy}
            save={(look) => run(() => adminApi.seasonLook(current.id, look))} />
        </Panel>
      )}
      <Panel>
        <h3>Start a new season</h3>
        <p class="muted">
          Ends {current ? current.name : 'the current season'} now and freezes its final standings. Everyone who
          played starts the new season from a soft reset (skill pulled 30% toward the middle, uncertainty at least 6)
          with a 0-0 record, and places again: SR and rank show after 5 games. SR becomes skill minus one uncertainty,
          with ranks from Bronze to Master. The old season's leaderboard, matches and stats stay viewable. Not
          possible while a match is being set up or played.
        </p>
        <form class="admin-form" onSubmit={(e) => {
          e.preventDefault();
          void run(
            () => adminApi.newSeason(next, { theme: nextTheme || null, endsAt: nextEnds || null }),
            `End ${current?.name ?? 'the current season'} and start "${next}"? Its standings freeze and every rating soft-resets for the new season.`,
          ).then(() => setNext(''));
        }}>
          <input value={next} placeholder="e.g. Season 1: Wrong Way" aria-label="New season name" onInput={(e) => setNext((e.target as HTMLInputElement).value)} />
          <ThemeSelect id="next-theme" value={nextTheme} onChange={setNextTheme} />
          <label class="muted" for="next-ends">Ends</label>
          <input id="next-ends" type="date" value={nextEnds} aria-label="Planned end date" onInput={(e) => setNextEnds((e.target as HTMLInputElement).value)} />
          <button class="btn" type="submit" disabled={busy || !next.trim()}>Start season</button>
        </form>
      </Panel>
      <ResetPreview />
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

/** Everyone's standing now beside where the soft reset would start them:
 *  staff look at this before pressing Start season. The start SR and rank
 *  are hidden from the player until they place. */
function ResetPreview() {
  const { data, error } = useFetch((s) => adminApi.seasonPreview(s), []);
  const [all, setAll] = useState(false);
  if (error) return <Panel><p class="error">Couldn't load the preview.</p></Panel>;
  if (!data) return <Panel><p class="muted">Loading preview...</p></Panel>;
  const rows = all ? data.rows : data.rows.slice(0, 40);
  const tally = new Map<string, number>();
  for (const r of data.rows) {
    if (r.games < 5) continue;
    const tier = r.startRank.split(' ')[0];
    tally.set(tier, (tally.get(tier) ?? 0) + 1);
  }
  return (
    <Panel class="panel--table">
      <h3>New season preview</h3>
      <p class="muted">
        {`${data.rows.length} players would carry a soft-reset rating. Day-one ranks for players with 5+ games: `}
        {['Master', 'Diamond', 'Platinum', 'Gold', 'Silver', 'Bronze'].map((t) => `${t} ${tally.get(t) ?? 0}`).join(' · ')}
      </p>
      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Player</th>
              <th class="num">Games</th>
              <th class="num">Final place</th>
              <th class="num">SR now</th>
              <th class="num">Start SR</th>
              <th>Start rank</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.steamid}>
                <td><a href={`/player/${r.steamid}`}>{r.name}</a></td>
                <td class="num muted">{r.games}</td>
                <td class="num">{r.finalRank !== null ? `#${r.finalRank}` : <span class="muted">n/a</span>}</td>
                <td class="num">{r.oldSr}</td>
                <td class="num">{r.startSr}</td>
                <td><RankBadge name={r.startRank} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {!all && data.rows.length > rows.length && (
        <button class="btn btn--ghost" type="button" onClick={() => setAll(true)}>{`Show all ${data.rows.length}`}</button>
      )}
    </Panel>
  );
}

function ThemeSelect({ id, value, onChange }: { id: string; value: SeasonThemeId | ''; onChange: (v: SeasonThemeId | '') => void }) {
  return (
    <select id={id} value={value} aria-label="Site theme" onChange={(e) => onChange((e.target as HTMLSelectElement).value as SeasonThemeId | '')}>
      <option value="">Standard look</option>
      {SEASON_THEMES.map((t) => <option key={t.id} value={t.id}>{t.label}</option>)}
    </select>
  );
}

/** The current season's theme and planned end. The end date only feeds the
 *  banner's countdown; the season still ends when a new one is started. Add
 *  ?theme=wrong-way to any page URL to preview a theme without setting it. */
function SeasonLookForm({ id, theme, endsAt, busy, save }: {
  id: number; theme: SeasonThemeId | null; endsAt: string | null; busy: boolean;
  save: (look: { theme: SeasonThemeId | null; endsAt: string | null }) => Promise<unknown>;
}) {
  const [t, setT] = useState<SeasonThemeId | ''>(theme ?? '');
  const [e, setE] = useState(endsAt ?? '');
  const dirty = (t || null) !== theme || (e || null) !== endsAt;
  return (
    <form class="admin-form" onSubmit={(ev) => { ev.preventDefault(); void save({ theme: t || null, endsAt: e || null }); }}>
      <ThemeSelect id={`theme-${id}`} value={t} onChange={setT} />
      <label class="muted" for={`ends-${id}`}>Ends</label>
      <input id={`ends-${id}`} type="date" value={e} aria-label="Planned end date" onInput={(ev) => setE((ev.target as HTMLInputElement).value)} />
      <button class="btn" type="submit" disabled={busy || !dirty}>Save look</button>
      <span class="muted">Preview any theme first with <code>?theme=wrong-way</code> on a page URL (<code>?theme=off</code> to stop).</span>
    </form>
  );
}
