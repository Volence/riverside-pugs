import type { Chemistry, ChemistryLine } from '../api';
import { Panel, PlayerLink } from './bits';

const games = (n: number) => `${n} game${n === 1 ? '' : 's'}`;
const rate = (l: ChemistryLine) => `${Math.round(l.winRate * 100)}% over ${l.games}`;

/**
 * Who this player wins with and loses to. Three lines and no more.
 *
 * The whole panel is absent when there is nothing to say, and so is each
 * gated line: a heading over an empty row reads as a bug, and "Best with:
 * nobody yet" is a worse thing to show a new player than nothing.
 */
export function ChemistryPanel({ chemistry }: { chemistry?: Chemistry | null }) {
  if (!chemistry) return null;
  const { mostPlayedWith, bestWith, worstAgainst } = chemistry;
  if (!mostPlayedWith && !bestWith && !worstAgainst) return null;
  return (
    <Panel>
      <h3>Chemistry</h3>
      <dl class="totals chemistry">
        {mostPlayedWith && (
          <div>
            <dt>Most played with</dt>
            <dd><PlayerLink steamid={mostPlayedWith.steamid} name={mostPlayedWith.name} /> <span class="muted num">{games(mostPlayedWith.games)}</span></dd>
          </div>
        )}
        {bestWith && (
          <div>
            <dt>Best with</dt>
            <dd><PlayerLink steamid={bestWith.steamid} name={bestWith.name} /> <span class="muted num">{rate(bestWith)}</span></dd>
          </div>
        )}
        {worstAgainst && (
          <div>
            <dt>Worst against</dt>
            <dd><PlayerLink steamid={worstAgainst.steamid} name={worstAgainst.name} /> <span class="muted num">{rate(worstAgainst)}</span></dd>
          </div>
        )}
      </dl>
    </Panel>
  );
}
