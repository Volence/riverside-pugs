import type { DB } from '../db.js';
import { ANALYZER_VERSION } from './store.js';

/**
 * Running the integrity analysis as a background job.
 *
 * WHY A CHILD PROCESS. `backfillAll` is entirely synchronous: readFileSync
 * plus a decode loop over every replay on disk, which on the live box is a
 * quarter of a gigabyte. Called inside a request it would block Node's event
 * loop for minutes, and that one loop is also serving HTTP, running the
 * Discord bot, taking the live UDP feed off the game server and driving match
 * orchestration. So the work goes to its own process and this class only
 * watches it.
 *
 * State is deliberately in memory. After a restart no job is running, which is
 * exactly what an empty state says, and persisting it would only create the
 * possibility of claiming a job is running when it is not.
 */

export type JobStatus = 'idle' | 'running' | 'done' | 'failed';

/** What mode the analysis ran in. `full` re-measures everything against
 *  rebuilt priors; `pending` pools and measures only rounds nothing has looked
 *  at. */
export type JobMode = 'full' | 'pending';

export interface JobState {
  status: JobStatus;
  mode: JobMode | null;
  startedAt: string | null;
  finishedAt: string | null;
  exitCode: number | null;
  /** Tail of the child's combined output, oldest first. */
  output: string[];
}

/** Enough of a ChildProcess for this class, so a test can pass a fake. */
export interface JobChild {
  stdout: { on(event: 'data', fn: (chunk: unknown) => void): void } | null;
  stderr: { on(event: 'data', fn: (chunk: unknown) => void): void } | null;
  on(event: 'exit', fn: (code: number | null) => void): void;
  on(event: 'error', fn: (err: Error) => void): void;
}

export type JobSpawner = (mode: JobMode) => JobChild;

/** Output lines kept. The script prints a line per map plus a summary, so a
 *  couple of hundred covers a full run with room to spare; the cap exists so a
 *  runaway child cannot grow this without bound. */
const MAX_LINES = 400;

export const BUSY_STATES = ['live', 'configuring', 'waiting'] as const;

/** Whether a match is in flight, which is when the box can least afford this. */
export function matchInFlight(db: DB): boolean {
  const row = db.prepare(
    `SELECT COUNT(*) AS n FROM matches WHERE state IN ('live', 'configuring', 'waiting')`,
  ).get() as { n: number };
  return row.n > 0;
}

/**
 * Indexed rounds that no current-version analysis has measured.
 *
 * Drives the automatic pass: the board used to go stale after every match
 * because nothing in the running server ever analysed anything, and asking
 * this once a minute is cheaper than a readdir, let alone a decode.
 *
 * Counts a round measured by an older analyzer as pending, matching
 * `analyzePending`, so bumping ANALYZER_VERSION re-measures history on its own.
 */
export function pendingRoundCount(db: DB): number {
  const row = db.prepare(
    `SELECT COUNT(*) AS n FROM match_replays r
     WHERE NOT EXISTS (
       SELECT 1 FROM integrity_rounds i
       WHERE i.match_id = r.match_id AND i.ordinal = r.ordinal AND i.half = r.half
         AND i.analyzer_version = ?
     )`,
  ).get(ANALYZER_VERSION) as { n: number };
  return row.n;
}

export class IntegrityJobs {
  private state: JobState = {
    status: 'idle', mode: null, startedAt: null, finishedAt: null, exitCode: null, output: [],
  };

  constructor(private deps: {
    spawn: JobSpawner;
    /** True when a match is in flight. Injected so the guard is testable and
     *  so this class needs no opinion about how "in flight" is defined. */
    busy: () => boolean;
    now?: () => Date;
  }) {}

  private now(): string {
    return (this.deps.now?.() ?? new Date()).toISOString();
  }

  snapshot(): JobState {
    return { ...this.state, output: [...this.state.output] };
  }

  /**
   * Start a run, or say why not.
   *
   * `force` overrides the in-flight refusal only. It cannot start a second
   * concurrent run: two processes writing the same measurements is not a
   * judgement call an operator should be able to make by accident.
   */
  start(mode: JobMode, opts: { force?: boolean } = {}): { ok: true } | { ok: false; reason: string } {
    if (this.state.status === 'running') {
      return { ok: false, reason: 'A run is already in progress.' };
    }
    if (this.deps.busy() && !opts.force) {
      return {
        ok: false,
        reason: 'A match is in flight. This decodes every replay on disk and competes with the game server for CPU. Run it when the box is quiet, or force it if you know it is.',
      };
    }

    this.state = {
      status: 'running', mode, startedAt: this.now(), finishedAt: null, exitCode: null, output: [],
    };

    let child: JobChild;
    try {
      child = this.deps.spawn(mode);
    } catch (err) {
      this.finish(null, `failed to start: ${err instanceof Error ? err.message : String(err)}`);
      return { ok: false, reason: 'Could not start the analysis process.' };
    }

    const take = (chunk: unknown) => this.append(String(chunk));
    child.stdout?.on('data', take);
    child.stderr?.on('data', take);
    // An 'error' from spawn (a missing binary, say) is not followed by 'exit',
    // so it has to end the job itself or the status would stay 'running'
    // forever and every later start would be refused.
    child.on('error', (err) => {
      if (this.state.status === 'running') this.finish(null, `process error: ${err.message}`);
    });
    child.on('exit', (code) => {
      if (this.state.status === 'running') this.finish(code);
    });
    return { ok: true };
  }

  private append(text: string): void {
    for (const line of text.split('\n')) {
      if (line.trim() === '') continue;
      this.state.output.push(line);
    }
    if (this.state.output.length > MAX_LINES) {
      this.state.output = this.state.output.slice(-MAX_LINES);
    }
  }

  private finish(code: number | null, note?: string): void {
    if (note) this.append(note);
    this.state.status = code === 0 ? 'done' : 'failed';
    this.state.exitCode = code;
    this.state.finishedAt = this.now();
  }
}
