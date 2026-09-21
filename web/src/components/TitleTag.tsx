import type { EndorseKind, EndorsementSummary } from '../api';
import { ENDORSE_KINDS, ENDORSE_LABEL } from '../endorse';
import { Panel } from './bits';

/**
 * The word a player has earned from endorsements, beside their name.
 *
 * The payoff is a word, not a number: "Caller" under somebody's name is worth
 * more to them than a count, and it lets a newer player read a roster. The
 * counts stay on the profile; this is the part that travels.
 */
export function TitleTag({ kind }: { kind?: EndorseKind | null }) {
  if (!kind) return null;
  return <span class={`titletag titletag--${kind}`}>{ENDORSE_LABEL[kind]}</span>;
}

/** Received endorsements on a profile. Counts and a rate, never who gave
 *  them. Absent until there is something to count. */
export function EndorsementCounts({ endorsements }: { endorsements?: EndorsementSummary | null }) {
  if (!endorsements || endorsements.total === 0) return null;
  return (
    <Panel>
      <h3>Endorsements</h3>
      <dl class="totals">
        {ENDORSE_KINDS.map((k) => (
          <div key={k}><dt>{ENDORSE_LABEL[k]}</dt><dd class="num">{endorsements.counts[k]}</dd></div>
        ))}
        <div><dt>Per match</dt><dd class="num">{endorsements.perMatch.toFixed(2)}</dd></div>
      </dl>
    </Panel>
  );
}
