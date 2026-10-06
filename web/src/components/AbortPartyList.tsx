import type { AbortParty } from '../api';

/** Who an aborted match was about, one per line: name, side, what it cost.
 *  Staff only: the admin Aborted list and the match page's staff view. */
export function AbortPartyList({ parties }: { parties: AbortParty[] }) {
  if (parties.length === 0) return null;
  return (
    <ul class="abort-parties">
      {parties.map((p) => (
        <li key={p.steamid}>
          <a href={`/player/${p.steamid}`}>{p.name}</a>
          {p.team ? ` (Team ${p.team.toUpperCase()})` : ''} {p.what}: <span class="muted">{p.outcome}</span>
        </li>
      ))}
    </ul>
  );
}
