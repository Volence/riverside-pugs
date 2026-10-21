import { Fragment, type ComponentChildren } from 'preact';
import type { GamePhase } from '../api';
import { SrDelta } from './bits';

/**
 * The versus scoreboard: Team A left, both scores centre in Anton at hero
 * size, Team B right. A faint teal wash on the left edge and red on the
 * right, the survivor and infected colors, over a hairline top and a red
 * rule beneath.
 *
 * Names are passed as plain values so the same header serves the match page
 * (roster from match players, with each player's SR change once it is over)
 * and the live page (roster from the live payload) without knowing either
 * shape.
 */
/** A plain name, or a name with the SR it moved in this match. A null delta
 *  means the rating never touched them, and shows nothing rather than "+0". */
export type VersusName = string | {
  name: string; srDelta: number | null; placement?: GamePhase | null; placedRank?: string | null;
  /** Queued as a duo with someone on this roster: a small Duo tag. */
  duo?: boolean;
};

function names(team: VersusName[]) {
  return team.map((n, i) => {
    const name = typeof n === 'string' ? n : n.name;
    const delta = typeof n === 'string' ? null : n.srDelta;
    const placement = typeof n === 'string' ? null : n.placement ?? null;
    const placedRank = typeof n === 'string' ? null : n.placedRank ?? null;
    const duo = typeof n !== 'string' && n.duo === true;
    return (
      <Fragment key={i}>
        {i > 0 && ' · '}
        {name}
        {duo && <span class="titletag duotag">Duo</span>}
        {(delta !== null || placement) && <> <SrDelta value={delta} placement={placement} placedRank={placedRank} /></>}
      </Fragment>
    );
  });
}

export function VersusHeader(
  { teamA, teamB, scoreA, scoreB, eyebrowA = 'Team A', eyebrowB = 'Team B', subline }: {
    teamA: VersusName[];
    teamB: VersusName[];
    scoreA: number;
    scoreB: number;
    eyebrowA?: string;
    eyebrowB?: string;
    subline?: ComponentChildren;
  },
) {
  const lead = (mine: number, theirs: number) => (mine > theirs ? ' versus__score--lead' : '');
  return (
    <section class="versus">
      <div class="versus__side">
        <p class="eyebrow versus__eyebrow--a">{eyebrowA}</p>
        <p class="versus__names">{names(teamA)}</p>
      </div>
      <div class="versus__scores num">
        <span class={`versus__score${lead(scoreA, scoreB)}`}>{scoreA}</span>
        <span class="versus__slash">/</span>
        <span class={`versus__score${lead(scoreB, scoreA)}`}>{scoreB}</span>
      </div>
      <div class="versus__side versus__side--b">
        <p class="eyebrow versus__eyebrow--b">{eyebrowB}</p>
        <p class="versus__names">{names(teamB)}</p>
      </div>
      {subline && <p class="versus__sub">{subline}</p>}
    </section>
  );
}
