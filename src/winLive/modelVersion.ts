import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

/**
 * The version stored with a finished match's in-half points
 * (match_win_points.model_version, src/winLive/finishedLine.ts): a hash of
 * what made them, the fitted half model and the trusted progress maps, plus
 * POINTS_FORMAT for the way they are computed. Refitting either file, or a
 * change to the computation that bumps POINTS_FORMAT, makes every stored row
 * stale: matchWinLine ignores it and the points are computed again (the
 * metrics reaper for recent matches, scripts/win-backfill.ts for the rest).
 *
 * The base model (the score history every line is priced from) is not in
 * it: it changes after every match, so it would make every row stale every
 * time. A stored point keeps the base as it stood when the match ended.
 *
 * Its own module, reading the two files as bytes, so src/winProb.ts can
 * check the version without importing the replay reader behind the points.
 */

/** Bump when the computation of the points changes with the files unchanged. */
const POINTS_FORMAT = 'finished-points 1';

const file = (name: string) => readFileSync(new URL(name, import.meta.url));

export const WIN_POINTS_VERSION: string = createHash('sha256')
  .update(POINTS_FORMAT)
  .update('\0')
  .update(file('./halfModel.fitted.json'))
  .update('\0')
  .update(file('./progressMaps.json'))
  .digest('hex')
  .slice(0, 16);
