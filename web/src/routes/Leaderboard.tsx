import { api } from '../api';
import { useFetch } from '../hooks/useFetch';
import { Empty, Panel, PlayerLink } from '../components/bits';

export function Leaderboard({ me }: { me: string | null }) {
  const { data, error } = useFetch((s) => api.leaderboard(s), []);

  return (
    <div class="page page--list">
      <div class="page__head">
        <h2>Leaderboard</h2>
        {data && <span class="eyebrow">{data.season.name}</span>}
      </div>
      <Panel class="panel--table">
        {error ? (
          <Empty>Couldn't load the leaderboard.</Empty>
        ) : !data ? (
          <Empty>Loading…</Empty>
        ) : data.rows.length === 0 ? (
          <Empty>No rated players yet.</Empty>
        ) : (
          <div class="table-wrap">
            <table>
              <thead>
                <tr>
                  <th class="rank">#</th>
                  <th>Player</th>
                  <th class="num">SR</th>
                  <th class="num">W</th>
                  <th class="num">L</th>
                  <th class="num">Games</th>
                </tr>
              </thead>
              <tbody>
                {data.rows.map((r, i) => (
                  <tr key={r.steamid} class={r.steamid === me ? 'is-me' : ''}>
                    <td class={`rank ${i < 3 ? 'rank--top' : ''}`}>{i + 1}</td>
                    <td><PlayerLink steamid={r.steamid} name={r.name} /></td>
                    <td class="num sr">{r.sr}</td>
                    <td class="num">{r.wins}</td>
                    <td class="num">{r.losses}</td>
                    <td class="num muted">{r.games}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>
    </div>
  );
}
