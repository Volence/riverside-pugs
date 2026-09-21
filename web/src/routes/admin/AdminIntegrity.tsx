import { useEffect, useState } from 'preact/hooks';
import { adminApi, type IntegrityClip } from '../../api';
import { useFetch } from '../../hooks/useFetch';
import { Empty, Panel } from '../../components/bits';
import { fmtTime, useAction } from './useAction';

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
/**
 * Run the analysis from here.
 *
 * Until this existed the only caller of the integrity analysis anywhere was a
 * script someone had to SSH in and run, so the board was empty until somebody
 * remembered and stale again after the next match. The automatic per-match
 * pass fixes the staleness, priors included; this button is for the other
 * case, re-measuring everything after a changed threshold.
 *
 * The run happens in its own process (see src/integrity/job.ts) and this polls
 * its state while it goes, showing the script's own output, which already
 * reports per-map prior coverage and what it skipped.
 */
function BackfillControl() {
  const { data, reload } = useFetch((s) => adminApi.integrityJob(s), []);
  const { busy, error, run } = useAction(reload);
  const running = data?.available === true && data.job.status === 'running';

  // Only while a run is going: an idle panel has nothing to poll for.
  useEffect(() => {
    if (!running) return undefined;
    const timer = setInterval(reload, 2000);
    return () => clearInterval(timer);
  }, [running]);

  if (!data) return null;
  if (!data.available) {
    return (
      <Panel>
        <h3>Analysis</h3>
        <p class="muted">No replay directory is configured on this server, so there is nothing to analyse.</p>
      </Panel>
    );
  }

  const { job, pending, matchInFlight } = data;
  return (
    <Panel>
      <h3>Analysis</h3>
      <p class="muted">
        Rounds are measured automatically once a match finishes.
        {pending > 0
          ? ` ${pending} round${pending === 1 ? '' : 's'} waiting to be measured; the next pass picks ${pending === 1 ? 'it' : 'them'} up within a minute.`
          : ' Everything on disk has been measured.'}
        {' '}Each pass also adds what it measured to that map's baseline, so a map starts being
        scored for occupancy by itself once it has enough rounds. Re-analysing everything is
        for after a threshold change.
      </p>
      <div class="admin-row">
        <button
          class="btn"
          disabled={busy || running || matchInFlight}
          onClick={() => run(() => adminApi.integrityRun('full', false))}
        >
          {running ? 'Analysing…' : 'Re-analyse all replays'}
        </button>
        {matchInFlight && !running && (
          <button
            class="chip"
            disabled={busy}
            onClick={() => run(
              () => adminApi.integrityRun('full', true),
              'A match is in flight. This decodes every replay on disk and competes with the game server for CPU. Run it anyway?',
            )}
          >
            Force
          </button>
        )}
      </div>
      {matchInFlight && (
        <p class="muted">
          A match is in flight. This reads every replay on disk on the same two cores holding
          100 tick, so it is blocked until the box is quiet. Force it only if you know it is.
        </p>
      )}
      {error && <p class="error">{error}</p>}
      {job.status !== 'idle' && (
        <p class="muted">
          Last run: {job.mode === 'pending' ? 'new rounds' : 'everything'}, {job.status}
          {job.startedAt && `, started ${fmtTime(job.startedAt)}`}
          {job.finishedAt && `, finished ${fmtTime(job.finishedAt)}`}
          {job.status === 'failed' && job.exitCode !== null && ` (exit ${job.exitCode})`}
        </p>
      )}
      {job.output.length > 0 && <pre class="admin-log">{job.output.join('\n')}</pre>}
    </Panel>
  );
}

export function AdminIntegrity() {
  const [steamid, setSteamid] = useState<string | null>(null);
  const { data, reload } = useFetch((s) => adminApi.integrity('', s), []);
  const detail = useFetch((s) => (steamid ? adminApi.integrityPlayer(steamid, s) : Promise.resolve(null)), [steamid]);
  const { busy, error, run } = useAction(() => { reload(); detail.reload(); });
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [filter, setFilter] = useState('');

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
        <section class="integrity-flags">
          <h4>Live anti-cheat flags</h4>
          {(detail.data.flags?.length ?? 0) === 0 ? (
            <p class="muted">Nothing flagged for this player by the live anti-cheat.</p>
          ) : (
          <>
            <p class="muted">
              Raised by Little Anti-Cheat during play, not by replay analysis, so there is no clip to
              watch. Its own documentation says few and rare suspicions are usually false positives;
              a pattern is what matters.
            </p>
            <ul class="admin-list">
              {detail.data.flags.map((f) => (
                <li key={f.id}>
                  {fmtTime(f.at)}: <code>{f.kind}</code>
                  {f.severity === 'banned'
                    ? <strong class="admin-warn"> · banned by LilAC</strong>
                    : <span class="muted"> · suspected</span>}
                  {f.matchId ? <> · <a href={`/match/${f.matchId}`}>#{f.matchId}</a></> : null}
                </li>
              ))}
            </ul>
          </>
          )}
        </section>
        {detail.data.clips.length === 0 && (
          <Empty>No flagged moments from replay analysis for this player.</Empty>
        )}
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
  // Rank is the player's place in the WHOLE board. Taking it from the filtered
  // array index would renumber everyone the moment you typed in the search box,
  // turning a search into a different-looking ranking.
  const ranked = players.map((p, i) => ({ ...p, rank: i + 1 }));
  const needle = filter.trim().toLowerCase();
  const shown = needle
    ? ranked.filter((p) => p.name.toLowerCase().includes(needle) || p.steamid.includes(needle))
    : ranked;

  return (
    <>
      <BackfillControl />
      <Panel>
        <details class="colkey">
          <summary>What these columns mean</summary>
          <dl class="colkey__list">
            <dt>Tracking</dt>
            <dd>
              Did the crosshair <strong>move with</strong> an invisible infected. 1 is exactly the
              motion needed to follow it, 0 is none of it. This is the backbone: sitting still
              aimed at a known spawn spot scores <strong>zero</strong> however good the spot was,
              because a held angle produces none of the motion. Shown as a player's single
              highest round, not an average, since one round of following something you cannot
              see is the thing worth looking at and twenty clean rounds should not average it away.
            </dd>
            <dt>Occupancy</dt>
            <dd>
              How much more often they were aimed at a ghost than <em>this map's own looking
              habits</em> predict. The baseline is built from everyone's rounds on that map, so a
              player whose whole edge is knowing where infected spawn scores zero by
              construction: that knowledge is already in the baseline. Only the excess counts.
              It is in standard deviations, averaged over their rounds: a stare counts once per
              two seconds rather than once per frame, and the level is set by what the players
              on this board actually do on that map, so an ordinary round reads about 0 and
              roughly one honest round in twenty reads beyond 2 either way. One round at 2 is
              therefore nothing. An average that stays there is.
            </dd>
            <dt>Team gap</dt>
            <dd>
              Their occupancy minus their own teammates' average, which controls for the round
              itself. A round where everyone was staring at the same doorway lifts all four
              players, and this is what cancels that out.
            </dd>
            <dt>The percentage after each</dt>
            <dd>
              Where that number sits among the players on this board. Not a probability of
              anything.
            </dd>
            <dt>Rank</dt>
            <dd>
              Position by the composite, which is the mean of whichever percentiles a player has.
              It is a <strong>sort key, not a claim</strong>, and it only ranks within the
              population listed here.
            </dd>
            <dt>Clips</dt>
            <dd>
              Moments that crossed the review threshold and can be watched. Clips are the
              evidence; the columns are only a way of deciding what to watch first.
            </dd>
            <dt>n/a</dt>
            <dd>
              Occupancy and team gap need a baseline for that map, and a map needs enough
              recorded rounds before it has one. Maps below that threshold are measured but not
              scored, so their rows read n/a rather than 0.
            </dd>
          </dl>
        </details>
      </Panel>
    <Panel>
      <h3>Live anti-cheat</h3>
      {data?.health && (
        // Rendered even when everything is zero. An empty panel that shows
        // nothing cannot tell "capturing, nobody flagged" apart from "silently
        // broken", and on a new detector that is the only thing worth knowing.
        <p class="muted">
          {data!.health.bursts === 0
            ? 'No input bursts captured yet. Bursts are only recorded during a live match, so this stays empty until a PUG runs.'
            : `${data!.health.bursts.toLocaleString()} input bursts across ${data!.health.matchesWithBursts} match${data!.health.matchesWithBursts === 1 ? '' : 'es'}, most recent ${fmtTime(data!.health.lastBurstAt!)}.`}
          {' '}
          {data!.health.detections === 0 && data!.health.lilacFlags === 0
            ? 'Nothing flagged.'
            : `${data!.health.detections} input detection${data!.health.detections === 1 ? '' : 's'}, ${data!.health.lilacFlags} Little Anti-Cheat flag${data!.health.lilacFlags === 1 ? '' : 's'}.`}
        </p>
      )}
      {(data?.flags?.length ?? 0) === 0
        ? <Empty>Nothing flagged by the live anti-cheat. This is the normal, healthy state.</Empty>
        : (
          <ul class="admin-list">
            {data!.flags.map((f) => (
              <li key={`${f.source}-${f.id}`}>
                {fmtTime(f.at)}: <button class="linklike" onClick={() => setSteamid(f.steamid)}>{f.name}</button>
                {' '}<code>{f.kind}</code>
                <span class="muted"> · {f.source === 'lilac' ? 'Little Anti-Cheat' : 'input timing'}</span>
                {f.severity === 'banned' && <strong class="admin-warn"> · banned</strong>}
                {f.matchId ? <> · <a href={`/match/${f.matchId}`}>#{f.matchId}</a></> : null}
              </li>
            ))}
          </ul>
        )}
    </Panel>

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
      {players.length > 8 && (
        <div class="admin-row">
          <input
            class="admin-search"
            type="search"
            placeholder={`Search ${players.length} players`}
            aria-label="Search players"
            value={filter}
            onInput={(e) => setFilter((e.target as HTMLInputElement).value)}
          />
          {filter && <span class="muted">{shown.length} of {players.length}</span>}
        </div>
      )}
      {players.length > 0 && shown.length === 0 && (
        <Empty>No player on this board matches "{filter}".</Empty>
      )}
      {shown.length > 0 && (
        <div class={noClips ? 'table-wrap muted' : 'table-wrap'}>
          <table class="admin-table">
            <thead>
              <tr>
                <th>Player</th><th>Rounds</th><th>Clips</th><th>Rank</th>
                <th>Tracking</th><th>Occupancy</th><th>Team gap</th>
              </tr>
            </thead>
            <tbody>
              {shown.map((p) => (
                <tr key={p.steamid} class="is-clickable" onClick={() => setSteamid(p.steamid)}>
                  <td>{p.name}</td>
                  <td>{p.rounds}</td>
                  <td>{p.clips}</td>
                  <td>{`${p.rank} of ${players.length}`}</td>
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
    </>
  );
}
