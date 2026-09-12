import type { ComponentChildren } from 'preact';

/**
 * The versus scoreboard: Team A left, both scores centre in Anton at hero
 * size, Team B right. A faint teal wash on the left edge and red on the
 * right, the survivor and infected colors, over a hairline top and a red
 * rule beneath.
 *
 * Names are passed as strings so the same header serves the match page
 * (roster from match players) and the live page (roster from the live
 * payload) without knowing either shape.
 */
export function VersusHeader(
  { teamA, teamB, scoreA, scoreB, eyebrowA = 'Team A', eyebrowB = 'Team B', subline }: {
    teamA: string[];
    teamB: string[];
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
        <p class="versus__names">{teamA.join(' · ')}</p>
      </div>
      <div class="versus__scores num">
        <span class={`versus__score${lead(scoreA, scoreB)}`}>{scoreA}</span>
        <span class="versus__slash">/</span>
        <span class={`versus__score${lead(scoreB, scoreA)}`}>{scoreB}</span>
      </div>
      <div class="versus__side versus__side--b">
        <p class="eyebrow versus__eyebrow--b">{eyebrowB}</p>
        <p class="versus__names">{teamB.join(' · ')}</p>
      </div>
      {subline && <p class="versus__sub">{subline}</p>}
    </section>
  );
}
