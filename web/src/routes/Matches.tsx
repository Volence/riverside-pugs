import { api, type MatchListPlayer, type MatchSummary } from '../api';
import { useFetch } from '../hooks/useFetch';
import { campaignName, campaignTint, fmtAgo, fmtDate } from '../format';
import { Empty, Panel } from '../components/bits';
import { PageHeader, Figures, Figure } from '../components/PageHeader';

/** Up to four faces for one side of a row, best SI damage first (the server's
 *  order). A missing avatar is the name's first letter on a plain square. */
function Faces({ players }: { players: MatchListPlayer[] }) {
  return (
    <span class="mlist__faces" aria-hidden="true">
      {players.slice(0, 4).map((p) => (p.avatar
        ? <img key={p.steamid} src={p.avatar} alt="" width={24} height={24} loading="lazy" />
        : <span key={p.steamid} class="mlist__face--none">{p.name.slice(0, 1).toUpperCase()}</span>))}
    </span>
  );
}

/** One side of a row: the team's name for a scrim or tournament game, the
 *  faces of who played for a PUG, whose Team A / Team B mean nothing. */
function Side({ m, team }: { m: MatchSummary; team: 'a' | 'b' }) {
  const won = m.winner === team;
  const players = m.players?.[team] ?? [];
  const named = m.booked?.[team];
  const label = named ? named.name : players.map((p) => p.name).join(', ');
  return (
    <span class={`mlist__side mlist__side--${team}${won ? ' is-won' : ''}`} title={label || undefined}>
      {named ? <span class="mlist__team">{named.tag ? <b>{named.tag}</b> : null}{named.name}</span> : <Faces players={players} />}
      {won && <span class="mlist__won">Won</span>}
    </span>
  );
}

/** What else a row needs saying: a forfeit, a decided abandon, a scrim or
 *  tournament game (which only staff and the players see here). */
function Notes({ m }: { m: MatchSummary }) {
  const notes: string[] = [];
  if (m.booked) notes.push(m.booked.kind === 'tournament' ? (m.booked.event?.name ?? 'Tournament') : 'Scrim');
  if (m.forfeitTeam) notes.push(`${m.booked?.[m.forfeitTeam].name ?? `Team ${m.forfeitTeam.toUpperCase()}`} forfeited`);
  if (m.abandonedBy) notes.push(`decided, ${m.abandonedBy} abandoned`);
  if (m.winner === 'draw') notes.push('draw');
  return notes.length > 0 ? <span class="mlist__notes">{notes.join(' · ')}</span> : null;
}

function Row({ m, now }: { m: MatchSummary; now: number }) {
  return (
    <li class="mlist__row" style={{ '--campaign': campaignTint(m.campaign) } as Record<string, string>}>
      <a class="mlist__link" href={`/match/${m.id}`}>
        <span class="mlist__what">
          <span class="mlist__campaign">{campaignName(m.campaign)}</span>
          <span class="mlist__meta">
            <span class="muted">#{m.id}</span>
            <Notes m={m} />
          </span>
        </span>
        <span class="mlist__result">
          <Side m={m} team="a" />
          <span class="mlist__score num">
            <span class={m.winner === 'a' ? 'is-won' : undefined}>{m.teamAScore}</span>
            <span class="mlist__dash">-</span>
            <span class={m.winner === 'b' ? 'is-won' : undefined}>{m.teamBScore}</span>
          </span>
          <Side m={m} team="b" />
        </span>
        <time class="mlist__when" dateTime={m.endedAt ?? undefined} title={fmtDate(m.endedAt)}>{fmtAgo(m.endedAt, now)}</time>
      </a>
    </li>
  );
}

export function Matches() {
  const { data, error } = useFetch((s) => api.matches(s), []);
  const now = Date.now();

  return (
    <div class="page page--list">
      <PageHeader eyebrow="The latest results" title="Recent matches">
        {data && data.matches.length > 0 && (() => {
          const n = data.matches.length;
          const campaigns = new Set(data.matches.map((m) => m.campaign));
          // Deliberately not "Team A wins". a and b are labels reassigned every
          // match, so a win rate under them aggregates different people each time
          // and describes nobody. Margin is a property of the match itself, so it
          // stays true however the sides were labelled.
          const margin = (m: typeof data.matches[number]) => Math.abs(m.teamAScore - m.teamBScore);
          const avgMargin = Math.round(data.matches.reduce((sum, m) => sum + margin(m), 0) / n);
          const closest = data.matches.reduce((best, m) => (margin(m) < margin(best) ? m : best));
          const widest = data.matches.reduce((best, m) => (margin(m) > margin(best) ? m : best));
          return (
            <Figures>
              <Figure label="Matches" value={n} />
              <Figure label="Campaigns" value={campaigns.size} />
              <Figure label="Avg margin" value={avgMargin} />
              <Figure label="Closest" value={`${closest.teamAScore} - ${closest.teamBScore}`} sub={campaignName(closest.campaign)} />
              <Figure label="Widest" value={`${widest.teamAScore} - ${widest.teamBScore}`} sub={campaignName(widest.campaign)} />
            </Figures>
          );
        })()}
      </PageHeader>

      {error ? (
        <Panel><Empty>Couldn't load matches.</Empty></Panel>
      ) : !data ? (
        <Panel><Empty>Loading…</Empty></Panel>
      ) : data.matches.length === 0 ? (
        <Panel><Empty>No completed matches yet.</Empty></Panel>
      ) : (
        <ol class="mlist">
          {data.matches.map((m) => <Row key={m.id} m={m} now={now} />)}
        </ol>
      )}
    </div>
  );
}
