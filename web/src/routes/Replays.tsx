import { api } from '../api';
import { useFetch } from '../hooks/useFetch';
import { Empty, Panel, Tile, Tiles } from '../components/bits';

function when(startedUnix: number): string {
  return new Date(startedUnix * 1000).toLocaleString();
}

export function Replays() {
  const { data, error } = useFetch((s) => api.replaySessions(s), []);

  if (error) {
    return (
      <div class="page page--list">
        <Panel><Empty>Couldn't load replays.</Empty></Panel>
      </div>
    );
  }
  if (!data) return <div class="page page--list" />;

  const sessions = data.sessions;
  const files = sessions.reduce((n, s) => n + s.files.length, 0);

  return (
    <div class="page page--list">
      <div class="page__head"><h2>Replays</h2></div>

      {sessions.length === 0 ? (
        <Panel>
          <Empty>
            No replays on disk. Recording is per round, so one appears as soon
            as a round goes live.
          </Empty>
        </Panel>
      ) : (
        <>
          <Tiles>
            <Tile label="Sessions" value={sessions.length} />
            <Tile label="Rounds" value={files} />
          </Tiles>

          <div class="stack">
            {sessions.map((s) => (
              <Panel class="panel--table" key={s.token}>
                {/* The token is the session identity but it is 32 hex
                    characters, so the time is the heading and the token is
                    the subtitle. */}
                <h3>{when(s.startedUnix)}</h3>
                <p class="muted mono">{s.token}</p>
                <div class="table-wrap">
                  <table>
                    <thead>
                      <tr>
                        <th>Map</th>
                        <th class="num">Round</th>
                        <th class="num">Half</th>
                        <th class="num">Size</th>
                        <th>State</th>
                      </tr>
                    </thead>
                    <tbody>
                      {s.files.map((f) => (
                        <tr key={f.filename}>
                          <td>
                            <a href={`/replay/file/${encodeURIComponent(f.filename)}`}>{f.map}</a>
                          </td>
                          <td class="num">{f.ordinal}</td>
                          <td class="num">{f.half}</td>
                          <td class="num">{(f.bytes / 1_048_576).toFixed(1)} MB</td>
                          <td>{f.closed ? 'finished' : 'recording'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </Panel>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
