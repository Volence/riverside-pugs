import { useState } from 'preact/hooks';
import { byeSpread, leagueWeeks, perWeekFor, weekDates } from '../../../../../src/events/league';
import { weekRangeText } from '../../../eventFormat';

/**
 * The season calculator under a league stage's settings (plan T2 Ruling 20).
 * It only reads the form's values and suggests; it stores nothing. The
 * expected team count and the end date are its own inputs, used for the
 * bye line and the matches-a-week suggestion.
 */
export function SeasonCalc({ matches, perWeek, seasonStart, teamCap, onUsePerWeek }: {
  matches: number | null; perWeek: number | null; seasonStart: string | null; teamCap: number | null | undefined;
  onUsePerWeek: (n: number) => void;
}) {
  const [teams, setTeams] = useState(String(teamCap ?? 8));
  const [endBy, setEndBy] = useState('');
  if (matches === null || perWeek === null || matches < 1 || perWeek < 1) return null;
  const weeks = leagueWeeks(matches, perWeek);
  const span = seasonStart
    ? `, ${weekRangeText(seasonStart, weekDates(seasonStart, weeks).to)}.`
    : ' from the day the stage starts.';
  const n = Number(teams);
  const byes = Number.isInteger(n) && n >= 2 ? byeSpread(matches, n) : null;
  const fit = seasonStart && /^\d{4}-\d{2}-\d{2}$/.test(endBy) ? perWeekFor(matches, seasonStart, endBy) : undefined;
  return (
    <div class="seasoncalc">
      <p class="seasoncalc__line">{`${matches} matches at ${perWeek} a week: ${weeks} week${weeks === 1 ? '' : 's'}${span}`}</p>
      <div class="inlinerow">
        <label>Expected teams <input type="number" min={2} aria-label="Expected teams" value={teams} onInput={(e) => setTeams((e.target as HTMLInputElement).value)} /></label>
        {seasonStart && (
          <label>Season ends by <input type="date" aria-label="Season ends by" value={endBy} onInput={(e) => setEndBy((e.target as HTMLInputElement).value)} /></label>
        )}
      </div>
      {byes && (
        <p class="seasoncalc__line muted">
          {`With ${n} teams each team gets ${byes.min === byes.max ? byes.min : `${byes.min} or ${byes.max}`} bye${byes.max === 1 ? '' : 's'} (a bye is a win).`}
          {byes.min !== byes.max && byes.even.length > 0 ? ` ${byes.even.join(' or ')} matches gives everyone the same.` : ''}
        </p>
      )}
      {fit === null && <p class="seasoncalc__line warning">{`${matches} matches do not fit by then, even at 3 a week.`}</p>}
      {typeof fit === 'number' && fit !== perWeek && (
        <button type="button" class="btn btn--ghost" onClick={() => onUsePerWeek(fit)}>{`Use ${fit} a week`}</button>
      )}
    </div>
  );
}
