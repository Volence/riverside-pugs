import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { CALIBRATION } from '../winProb.js';

/**
 * The version stored with a finished match's in-half points
 * (match_win_points.model_version, src/winLive/finishedLine.ts): a hash of
 * what made them, the fitted half model, the trusted progress maps, the
 * fitted team form (p_a_form is priced with it) and the plain line's
 * CALIBRATION, plus POINTS_FORMAT for the way they are computed. Refitting
 * any of these, or a change to the computation that bumps POINTS_FORMAT,
 * makes every stored row stale: matchWinLine ignores it and the points are
 * computed again (the reaper for recent matches, scripts/win-backfill.ts for
 * the rest).
 *
 * The base model (the score history every line is priced from) is not in
 * it: it changes after every match, so it would make every row stale every
 * time. A stored point keeps the base as it stood when the match ended.
 *
 * Its own module, reading the files as bytes, so src/winProb.ts can check
 * the version without importing the replay reader behind the points.
 */

/** Bump when the computation of the points changes with the inputs unchanged. */
const POINTS_FORMAT = 'finished-points 1';

/** What a version is made of: each file's text, and the calibration. */
export interface VersionInputs {
  halfModel: string | Buffer;
  progressMaps: string | Buffer;
  form: string | Buffer;
  calibration: number;
}

/** The version for these inputs (16 hex characters of a sha256). */
export function pointsVersion(v: VersionInputs): string {
  return createHash('sha256')
    .update(`${POINTS_FORMAT} calibration=${v.calibration}`)
    .update('\0').update(v.halfModel)
    .update('\0').update(v.progressMaps)
    .update('\0').update(v.form)
    .digest('hex')
    .slice(0, 16);
}

const file = (url: URL) => readFileSync(url);

let version: string | null = null;

/** The current version, from the shipped files. Computed on first use rather
 *  than at load, since src/winProb.ts (which owns CALIBRATION) imports this
 *  module. */
export function winPointsVersion(): string {
  version ??= pointsVersion({
    halfModel: file(new URL('./halfModel.fitted.json', import.meta.url)),
    progressMaps: file(new URL('./progressMaps.json', import.meta.url)),
    form: file(new URL('../winForm.fitted.json', import.meta.url)),
    calibration: CALIBRATION,
  });
  return version;
}
