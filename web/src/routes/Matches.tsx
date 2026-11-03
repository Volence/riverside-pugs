import { Fragment } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import { useLocation } from 'preact-iso';
import { api, ApiError, type MatchList, type MatchListPlayer, type MatchSummary } from '../api';
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
  // A PUG side goes by its lead player ("alice's team": Team A / Team B are
  // dealt afresh every match), then everyone on it.
  const lead = team === 'a' ? m.teamALead : m.teamBLead;
  const names = players.map((p) => p.name).join(', ');
  const label = named ? named.name : lead ? (names ? `${lead}'s team: ${names}` : `${lead}'s team`) : names;
  return (
    <span class={`mlist__side mlist__side--${team}${won ? ' is-won' : ''}`} title={label || undefined}>
      {named ? <span class="mlist__team">{named.tag ? <b>{named.tag}</b> : null}{named.name}</span> : <Faces players={players} />}
      {won && <span class="mlist__won">Won</span>}
    </span>
  );
}

/** A PUG side's name in words: its lead player's team, else the letter. */
function sideName(m: MatchSummary, team: 'a' | 'b'): string {
  const lead = team === 'a' ? m.teamALead : m.teamBLead;
  return lead ? `${lead}'s team` : `Team ${team.toUpperCase()}`;
}

/** What else a row needs saying: a forfeit, a decided abandon, a scrim or
 *  tournament game (which only staff and the players see here). */
function Notes({ m }: { m: MatchSummary }) {
  const notes: string[] = [];
  if (m.booked) notes.push(m.booked.kind === 'tournament' ? (m.booked.event?.name ?? 'Tournament') : 'Scrim');
  if (m.forfeitTeam) notes.push(`${m.booked?.[m.forfeitTeam].name ?? sideName(m, m.forfeitTeam)} forfeited`);
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

/** Which matches the page lists: a season id, every season, or (undefined)
 *  the current season. */
type MatchScope = number | 'all' | undefined;

/** The scope from the URL: `?season=all`, `?season=N`, or the current season. */
function parseScope(raw: string | null | undefined): MatchScope {
  if (raw === 'all') return 'all';
  const id = Number(raw);
  return raw && Number.isInteger(id) && id > 0 ? id : undefined;
}

/** ?season= straight off the address bar, for a render outside a router. */
function readSearchSeason(): string | null {
  return typeof location === 'undefined' ? null : new URLSearchParams(location.search).get('season');
}

/** This page's URL showing `scope`; the current season is the bare URL. */
function scopedUrl(scope: MatchScope): string | null {
  if (typeof location === 'undefined') return null;
  const url = new URL(location.href);
  if (scope === undefined) url.searchParams.delete('season');
  else url.searchParams.set('season', String(scope));
  return `${url.pathname}${url.search}${url.hash}`;
}

/** The pages loaded past the first, tied to the first page they continue so
 *  a change of season drops them without an effect to reset them. */
interface Older { base: MatchList; rows: MatchList['matches']; more: boolean }

export function Matches() {
  // Same shape as the profile's season switch: the URL is the only state
  // (?season=N|all), the current season is the bare URL, and a pick replaces
  // the entry rather than adding one for Back to walk through.
  const loc = useLocation();
  const [, rerender] = useState(0);
  const scope = parseScope(loc.query ? loc.query.season : readSearchSeason());
  const setScope = (next: MatchScope) => {
    const url = scopedUrl(next);
    if (!url) return;
    if (loc.route) loc.route(url, true);
    else { window.history.replaceState(window.history.state, '', url); rerender((n) => n + 1); }
  };
  const scopeOpts = scope === undefined ? {} : { season: scope };
  const { data, error } = useFetch((s) => api.matches(s, scopeOpts), [scope]);
  const { data: seasonList } = useFetch((s) => api.seasons(s).catch(() => ({ seasons: [] })), []);
  const seasons = seasonList?.seasons ?? [];
  const [older, setOlder] = useState<Older | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [moreFailed, setMoreFailed] = useState(false);
  const now = Date.now();

  // A season id the server does not know: back to the current season, so the
  // URL says what is shown rather than leaving a dead link on an error.
  useEffect(() => {
    if (error instanceof ApiError && error.status === 404 && typeof scope === 'number') setScope(undefined);
  }, [error]);

  const extra = data && older?.base === data ? older : null;
  const rows = data ? [...data.matches, ...(extra?.rows ?? [])] : [];
  const more = extra ? extra.more : !!data?.more;

  const showMore = async () => {
    if (!data || rows.length === 0) return;
    const base = data;
    setLoadingMore(true);
    setMoreFailed(false);
    try {
      const next = await api.matches(undefined, { ...scopeOpts, before: rows[rows.length - 1].id });
      setOlder((o) => ({ base, rows: [...(o?.base === base ? o.rows : []), ...next.matches], more: !!next.more }));
    } catch {
      setMoreFailed(true);
    } finally {
      setLoadingMore(false);
    }
  };

  const seasonName = (id: number) => seasons.find((x) => x.id === id)?.name ?? null;
  const summary = data?.summary ?? null;
  const eyebrow = scope === 'all' ? 'All seasons' : data?.season?.name ?? 'The latest results';

  return (
    <div class="page page--list">
      <PageHeader
        eyebrow={eyebrow}
        title="Recent matches"
        aside={seasons.length > 1 ? (
          <select
            class="season-picker" aria-label="Season"
            value={scope === 'all' ? 'all' : String(scope ?? seasons.find((x) => x.current)?.id ?? '')}
            onChange={(e) => {
              const v = (e.target as HTMLSelectElement).value;
              if (v === 'all') return setScope('all');
              const picked = seasons.find((x) => String(x.id) === v);
              setScope(!picked || picked.current ? undefined : picked.id);
            }}
          >
            {seasons.map((x) => <option key={x.id} value={String(x.id)}>{x.current ? `${x.name} (current)` : x.name}</option>)}
            <option value="all">All seasons</option>
          </select>
        ) : undefined}
      >
        {/* The server's figures over the whole season (or every season), not
            the page in hand. Deliberately no "Team A wins": a and b are
            labels dealt afresh every match, so a margin is what stays true. */}
        {summary && (
          <Figures>
            <Figure label="Matches" value={summary.matches.toLocaleString()} />
            <Figure label="Campaigns" value={summary.campaigns} />
            <Figure label="Avg margin" value={summary.avgMargin} />
            <Figure
              label="Closest" value={`${summary.closest.teamAScore} - ${summary.closest.teamBScore}`}
              sub={`${campaignName(summary.closest.campaign)} #${summary.closest.id}`}
            />
            <Figure
              label="Widest" value={`${summary.widest.teamAScore} - ${summary.widest.teamBScore}`}
              sub={`${campaignName(summary.widest.campaign)} #${summary.widest.id}`}
            />
          </Figures>
        )}
      </PageHeader>

      {error ? (
        <Panel><Empty>Couldn't load matches.</Empty></Panel>
      ) : !data ? (
        <Panel><Empty>Loading…</Empty></Panel>
      ) : rows.length === 0 ? (
        <Panel><Empty>{scope === 'all' ? 'No completed matches yet.' : 'No completed matches this season yet.'}</Empty></Panel>
      ) : (
        <>
          <ol class="mlist">
            {rows.map((m, n) => {
              // Across every season, a line where one season gives way to the
              // next (newest first, so it sits under the newer season's first
              // match), so the two do not read as one run.
              const prev = n > 0 ? rows[n - 1] : null;
              const turn = scope === 'all' && prev && prev.seasonId !== undefined && m.seasonId !== undefined && prev.seasonId !== m.seasonId;
              return (
                <Fragment key={m.id}>
                  {turn && (
                    <li class="mlist__season eyebrow">{seasonName(prev.seasonId!) ?? 'A new season'} starts</li>
                  )}
                  <Row m={m} now={now} />
                </Fragment>
              );
            })}
          </ol>
          {more && (
            <div class="mlist__more">
              <button type="button" class="chip" disabled={loadingMore} onClick={() => void showMore()}>
                {loadingMore ? 'Loading…' : 'Show more'}
              </button>
              {moreFailed && <span class="muted">Couldn't load more.</span>}
            </div>
          )}
        </>
      )}
    </div>
  );
}
