import { useState } from 'preact/hooks';
import { adminApi, type IntegrityClip } from '../../api';
import { useFetch } from '../../hooks/useFetch';
import { Empty, Panel } from '../../components/bits';
import { useAction } from './useAction';

const pct = (v: number | null): string => (v == null ? 'n/a' : `${Math.round(v * 100)}%`);
const num = (v: number | null): string => (v == null ? 'n/a' : v.toFixed(2));

/** Clips sharing one player-round, in the order the server ranked them.
 *
 *  Review state is keyed by the player-round, correctly and by design: a
 *  re-analysis rewrites every clip, so an admin's judgement cannot live on one.
 *  The consequence is that the review CONTROL belongs to the round too. A
 *  control per clip made reviewing one six-second moment silently mark up to
 *  CLIPS_PER_ROUND of them, and typing in one note box updated the other four
 *  as you typed. */
export function groupByRound(clips: IntegrityClip[]): { key: string; clips: IntegrityClip[] }[] {
  const out: { key: string; clips: IntegrityClip[] }[] = [];
  const at = new Map<string, { key: string; clips: IntegrityClip[] }>();
  for (const c of clips) {
    const key = `${c.matchId}/${c.ordinal}/${c.half}/${c.slot}`;
    let g = at.get(key);
    if (!g) { g = { key, clips: [] }; at.set(key, g); out.push(g); }
    g.clips.push(c);
  }
  return out;
}

/**
 * Admin-only integrity board.
 *
 * The composite is a SORT KEY, not an accusation, and the copy says so. It
 * renders as a rank within a named population rather than a percentage,
 * because a percentile over n-1 makes the top row read 100% by construction
 * and no disclaimer survives a reader's eye landing on that next to a real
 * person's name.
 *
 * What it opens is evidence: each clip links into the match page at the moment
 * that flagged it, because the unit of review is a clip and not a player. The
 * link carries ordinal, half and a start-time query param that MatchDetail
 * reads to pick the round and seek the viewer there once its frames arrive, so
 * a reviewer lands on the moment instead of scrubbing to it by hand.
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
          {groupByRound(detail.data.clips).map((g) => {
            const first = g.clips[0];
            const round = roundsByKey.get(g.key);
            const reviewed = round && round.reviewState !== 'new';
            const n = g.clips.length;
            return (
              <li key={g.key} class={reviewed ? 'muted' : ''}>
                <ul class="integrity-clips">
                  {g.clips.map((c) => (
                    <li key={c.id}>
                      <a href={`/match/${c.matchId}?ordinal=${c.ordinal}&half=${c.half}&t=${c.startMs}`}>
                        Match #{c.matchId}
                      </a>
                      <span class="muted"> · fidelity {c.score.toFixed(2)} · {((c.endMs - c.startMs) / 1000).toFixed(1)}s</span>
                    </li>
                  ))}
                </ul>
                {reviewed && round && (
                  <p class="muted">
                    {round.reviewState}{round.reviewNote ? `: ${round.reviewNote}` : ''}
                  </p>
                )}
                <div class="admin-form">
                  <input value={notes[g.key] ?? ''} placeholder="Review note" aria-label="Review note"
                    onInput={(e) => setNotes({ ...notes, [g.key]: (e.target as HTMLInputElement).value })} />
                  {/* Labelled with the count because the state is per ROUND: one
                      click settles every clip listed above it, and an admin who
                      watched one of them should be told that before clicking. */}
                  <button class="btn" disabled={busy}
                    onClick={() => run(() => adminApi.integrityReview(first.matchId, first.ordinal, first.half, first.slot, 'reviewed', notes[g.key] ?? ''))}>
                    Mark this round reviewed ({n} {n === 1 ? 'clip' : 'clips'})
                  </button>
                  <button class="chip" disabled={busy}
                    onClick={() => run(() => adminApi.integrityReview(first.matchId, first.ordinal, first.half, first.slot, 'dismissed', notes[g.key] ?? ''))}>
                    Dismiss this round ({n} {n === 1 ? 'clip' : 'clips'})
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      </Panel>
    );
  }

  const players = data?.players ?? [];
  const noClips = players.length > 0 && players.every((p) => p.clips === 0);

  return (
    <Panel>
      <p class="muted">
        Theoretical only. These numbers rank who is worth watching a clip of; they are not
        evidence of anything on their own, and nothing here is visible outside this panel.
        Ranks are within the {players.length} players on this board, so the top row is top
        of this list and nothing more.
      </p>
      {data && players.length === 0 && <Empty>Nothing analysed yet. Run the backfill.</Empty>}
      {noClips && (
        // Decision 5 in the design names the failure to avoid: a list sorted by
        // a measure of skill is a list of your best players. With nothing
        // flagged anywhere there is no evidence behind any of these rows, so the
        // board is dimmed and says so rather than presenting an order that
        // looks like a finding.
        <p class="error">
          No clips have been flagged for anyone, at any threshold. This ordering is a sort
          over clean measurements, not a suspicion list, and nobody on it has been flagged.
        </p>
      )}
      {players.length > 0 && (
        <div class={noClips ? 'table-wrap muted' : 'table-wrap'}>
          <table class="admin-table">
            <thead>
              <tr>
                <th>Player</th><th>Rounds</th><th>Clips</th><th>Rank</th>
                <th>Tracking</th><th>Occupancy</th><th>Team gap</th>
              </tr>
            </thead>
            <tbody>
              {players.map((p, i) => (
                <tr key={p.steamid} class="is-clickable" onClick={() => setSteamid(p.steamid)}>
                  <td>{p.name}</td>
                  <td>{p.rounds}</td>
                  <td>{p.clips}</td>
                  <td>{`${i + 1} of ${players.length}`}</td>
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
