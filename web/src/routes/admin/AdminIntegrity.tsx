import { useState } from 'preact/hooks';
import { adminApi } from '../../api';
import { useFetch } from '../../hooks/useFetch';
import { Empty, Panel } from '../../components/bits';
import { useAction } from './useAction';

const pct = (v: number | null): string => (v == null ? 'n/a' : `${Math.round(v * 100)}%`);
const num = (v: number | null): string => (v == null ? 'n/a' : v.toFixed(2));

/**
 * Admin-only integrity board.
 *
 * The composite is a SORT KEY, not an accusation, and the copy says so. What it
 * opens is evidence: each clip links into the match page at the moment that
 * flagged it, because the unit of review is a clip and not a player. There is
 * no standalone deep link into the replay viewer yet, so the clip links to the
 * real match page and states the timestamp as plain text beside it rather than
 * inventing a URL that does not exist.
 */
export function AdminIntegrity() {
  const [steamid, setSteamid] = useState<string | null>(null);
  const { data, reload } = useFetch((s) => adminApi.integrity('', s), []);
  const detail = useFetch((s) => (steamid ? adminApi.integrityPlayer(steamid, s) : Promise.resolve(null)), [steamid]);
  const { busy, error, run } = useAction(() => { reload(); detail.reload(); });
  const [notes, setNotes] = useState<Record<string, string>>({});

  if (steamid && detail.data) {
    // Review state is keyed by player-round (matchId/ordinal/half/slot), and each
    // clip carries those same four fields, so a clip's triage state is a lookup
    // into `rounds`, not something the clip row carries itself.
    const roundsByKey = new Map(
      detail.data.rounds.map((r) => [`${r.matchId}/${r.ordinal}/${r.half}/${r.slot}`, r]),
    );
    return (
      <Panel>
        <button class="chip" onClick={() => setSteamid(null)}>Back to board</button>
        {error && <p class="error">{error}</p>}
        {detail.data.clips.length === 0 && <Empty>No flagged moments for this player.</Empty>}
        <ul class="admin-list">
          {detail.data.clips.map((c) => {
            const key = `${c.matchId}/${c.ordinal}/${c.half}/${c.slot}`;
            const round = roundsByKey.get(key);
            const reviewed = round && round.reviewState !== 'new';
            return (
              <li key={c.id} class={reviewed ? 'muted' : ''}>
                <p>
                  <a href={`/match/${c.matchId}`}>Match #{c.matchId}</a>
                  {' '}map {c.ordinal} round {c.half}
                  {' '}at <strong>{(c.startMs / 1000).toFixed(1)}s</strong>
                  <span class="muted"> · fidelity {c.score.toFixed(2)} · {((c.endMs - c.startMs) / 1000).toFixed(1)}s</span>
                </p>
                {reviewed && round && (
                  <p class="muted">
                    {round.reviewState}{round.reviewNote ? `: ${round.reviewNote}` : ''}
                  </p>
                )}
                <div class="admin-form">
                  <input value={notes[key] ?? ''} placeholder="Review note" aria-label="Review note"
                    onInput={(e) => setNotes({ ...notes, [key]: (e.target as HTMLInputElement).value })} />
                  <button class="btn" disabled={busy}
                    onClick={() => run(() => adminApi.integrityReview(c.matchId, c.ordinal, c.half, c.slot, 'reviewed', notes[key] ?? ''))}>
                    Reviewed
                  </button>
                  <button class="chip" disabled={busy}
                    onClick={() => run(() => adminApi.integrityReview(c.matchId, c.ordinal, c.half, c.slot, 'dismissed', notes[key] ?? ''))}>
                    Dismiss
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      </Panel>
    );
  }

  return (
    <Panel>
      <p class="muted">
        Theoretical only. These numbers rank who is worth watching a clip of; they are not
        evidence of anything on their own, and nothing here is visible outside this panel.
      </p>
      {data && data.players.length === 0 && <Empty>Nothing analysed yet. Run the backfill.</Empty>}
      {data && data.players.length > 0 && (
        <div class="table-wrap">
          <table class="admin-table">
            <thead>
              <tr>
                <th>Player</th><th>Rounds</th><th>Composite</th>
                <th>Tracking</th><th>Occupancy</th><th>Team gap</th>
              </tr>
            </thead>
            <tbody>
              {data.players.map((p) => (
                <tr key={p.steamid} class="is-clickable" onClick={() => setSteamid(p.steamid)}>
                  <td>{p.steamid}</td>
                  <td>{p.rounds}</td>
                  <td>{pct(p.composite)}</td>
                  <td>{num(p.fidMax)} <span class="muted">({pct(p.pFid)})</span></td>
                  <td>{num(p.occZ)} <span class="muted">({pct(p.pOcc)})</span></td>
                  <td>{num(p.teamGap)} <span class="muted">({pct(p.pGap)})</span></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Panel>
  );
}
