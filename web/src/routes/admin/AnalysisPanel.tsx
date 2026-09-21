import { useEffect } from 'preact/hooks';
import { adminApi } from '../../api';
import { useFetch } from '../../hooks/useFetch';
import { Panel } from '../../components/bits';
import { fmtTime, useAction } from './useAction';

/**
 * Run the replay analysis, and say what pressing the button would achieve.
 *
 * TEMPORARY HOME. The spec puts this on Setup, Servers, next to analyzer
 * coverage; that section does not exist until the Setup plan lands, and
 * leaving the only way to start an analysis on a screen that is being
 * deleted would lose it. It sits under Needs a look, which is the screen its
 * output feeds, until Setup takes it.
 */
export function AnalysisPanel() {
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
  const lost = data.unanalysable ?? { missing: 0, unreadable: 0 };
  const lostTotal = lost.missing + lost.unreadable;
  return (
    <Panel>
      <h3>Analysis</h3>
      <p class="muted">
        Rounds are measured automatically once a match finishes.
        {pending > 0
          ? ` ${pending} round${pending === 1 ? '' : 's'} waiting to be measured; the next pass picks ${pending === 1 ? 'it' : 'them'} up within a minute.`
          : ' Everything on disk has been measured.'}
        {' '}Re-analysing everything is for after a threshold change. This panel moves to Setup,
        Servers when that desk is built.
      </p>
      {lostTotal > 0 && (
        <p class="muted">
          {lostTotal} round{lostTotal === 1 ? '' : 's'} could not be analysed and {lostTotal === 1 ? 'is' : 'are'} not
          counted as waiting: {lost.missing} with no replay on disk, {lost.unreadable} that would not
          decode. Re-analysing everything tries any whose file is there again.
        </p>
      )}
      <div class="admin-row">
        <button class="btn" disabled={busy || running || matchInFlight}
          onClick={() => run(() => adminApi.integrityRun('full', false))}>
          {running ? 'Analysing...' : 'Re-analyse all replays'}
        </button>
        {matchInFlight && !running && (
          <button class="chip" disabled={busy}
            onClick={() => run(
              () => adminApi.integrityRun('full', true),
              'A match is in flight. This decodes every replay on disk and competes with the game server for CPU. Run it anyway?',
            )}>
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
