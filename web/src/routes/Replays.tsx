import { api } from '../api';
import { useFetch } from '../hooks/useFetch';
import { campaignName } from '../format';
import { Empty, Panel } from '../components/bits';
import { PageHeader, Figures, Figure } from '../components/PageHeader';

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
      <PageHeader title="Replays">
        {sessions.length > 0 && (
          <Figures>
            <Figure label="Sessions" value={sessions.length} />
            <Figure label="Rounds" value={files} />
          </Figures>
        )}
      </PageHeader>

      {sessions.length === 0 ? (
        <Panel>
          <Empty>
            No replays on disk. Recording is per round, so one appears as soon
            as a round goes live.
          </Empty>
        </Panel>
      ) : (
        <>
          <div class="stack">
            {sessions.map((s) => (
              <Panel class="panel--table" key={s.token}>
                {/* The token is the session identity but it is 32 hex
                    characters, so the campaign and the time are the heading
                    and the token is the subtitle. A map the site does not
                    know leaves just the time. */}
                <h3>{s.campaign ? `${campaignName(s.campaign)} · ${when(s.startedUnix)}` : when(s.startedUnix)}</h3>
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
