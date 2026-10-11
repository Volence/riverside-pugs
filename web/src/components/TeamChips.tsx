import type { ProfileTeam } from '../api';
import { TeamBadge } from './TeamBadge';

/** Captains and co-captains are named on their chip; a plain member shows just the team. */
const ROLE_SHOWN = { captain: 'Captain', cocaptain: 'Co-captain' } as const;

/** The teams a player is on, one chip each, linking to the team page. The
 *  server sends none to a viewer the competitive switch keeps out. */
export function TeamChips({ teams }: { teams: readonly ProfileTeam[] }) {
  if (teams.length === 0) return null;
  return (
    <ul class="teamchips" aria-label="Teams">
      {teams.map((t) => (
        <li key={t.slug}>
          <a class="teamchips__chip" href={`/team/${t.slug}`}>
            <TeamBadge tag={t.tag} logoKey={t.logoKey} size={28} />
            <span class="teamchips__name">{t.name}</span>
            {t.role !== 'member' && <span class="teamchips__role">{ROLE_SHOWN[t.role]}</span>}
          </a>
        </li>
      ))}
    </ul>
  );
}
