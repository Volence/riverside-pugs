import { api, type MatchPlayerStats, type Team } from '../api';
import { useFetch } from '../hooks/useFetch';
import { campaignName, fmtDate, labelFor, winnerLabel } from '../format';
import { Empty, Panel, PlayerLink, SrDelta } from '../components/bits';

export function MatchDetail({ id, me }: { id: string; me: string | null }) {
  const { data, error } = useFetch((s) => api.match(id, s), [id]);

  if (error) {
    return (
      <div class="page page--match">
        <Panel><Empty>Match not found.</Empty></Panel>
      </div>
    );
  }
  if (!data) return <div class="page page--match" />;

  const { match, maps, players } = data;
  // Columns are derived from the data actually present, so a match played on
  // a server without skill_detect shows no empty columns rather than zeros.
  const skillCols = Array.from(
    new Set(players.flatMap((p) => Object.keys(p.stats ?? {}))),
  ).sort();

  return (
    <div class="page page--match">
      <div class="page__head">
        <div>
          <p class="eyebrow">Match #{match.id}</p>
          <h2>{campaignName(match.campaign)}</h2>
        </div>
        <div class="scoreline">
          <span class="scoreline__score num">{match.teamAScore} - {match.teamBScore}</span>
          <span class="muted">{winnerLabel(match.winner)} · {fmtDate(match.endedAt)}</span>
        </div>
      </div>

      <div class="stack">
        <Panel class="panel--table">
          <h3>Maps</h3>
          <div class="table-wrap">
            <table>
              <thead>
                <tr><th class="num">#</th><th>Map</th><th class="num">A</th><th class="num">B</th></tr>
              </thead>
              <tbody>
                {maps.map((m) => (
                  <tr key={m.ordinal}>
                    {/* `ordinal` is a 0-based array index in match_maps; humans
                        count maps from one. */}
                    <td class="num muted">{m.ordinal + 1}</td>
                    <td>{m.map}</td>
                    <td class="num">{m.teamAScore}</td>
                    <td class="num">{m.teamBScore}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Panel>

        <div class="teams">
          {(['a', 'b'] as Team[]).map((team) => (
            <TeamStats
              key={team}
              team={team}
              players={players.filter((p) => p.team === team)}
              me={me}
              skillCols={skillCols}
            />
          ))}
        </div>
      </div>
    </div>
  );
}

function TeamStats(
  { team, players, me, skillCols }:
    { team: Team; players: MatchPlayerStats[]; me: string | null; skillCols: string[] },
) {
  return (
    <Panel class="panel--table">
      <h3>Team {team.toUpperCase()}</h3>
      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Player</th>
              <th class="num">SI dmg</th>
              <th class="num">SI</th>
              <th class="num">Commons</th>
              <th class="num">FF</th>
              <th class="num">Revives</th>
              {skillCols.map((k) => <th class="num" key={k}>{labelFor(k)}</th>)}
              <th class="num">SR</th>
            </tr>
          </thead>
          <tbody>
            {players.map((p) => (
              <tr key={p.steamid} class={p.steamid === me ? 'is-me' : ''}>
                <td><PlayerLink steamid={p.steamid} name={p.name} /></td>
                <td class="num">{p.siDamage}</td>
                <td class="num">{p.siKills}</td>
                <td class="num">{p.commonKills}</td>
                <td class="num">{p.ffDealt}</td>
                <td class="num">{p.revives}</td>
                {skillCols.map((k) => <td class="num" key={k}>{p.stats?.[k] ?? 0}</td>)}
                <td class="num"><SrDelta value={p.srDelta} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Panel>
  );
}
