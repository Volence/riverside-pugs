import { useEffect, useRef, useState } from 'preact/hooks';
import { ApiError, castApi, type CastMatch } from '../api';
import { campaignTint, mapName } from '../format';
import { Empty } from '../components/bits';
import { PageHeader } from '../components/PageHeader';

/** A new match appears here once it goes live, so poll rather than make a
 *  caster reload. The score only moves at a map's end, so no need to rush. */
const POLL_MS = 15000;

const PHASE_LABEL: Record<NonNullable<CastMatch['phase']>, string> = {
  live: 'Live', paused: 'Paused', readyup: 'Ready-up', roundover: 'Between rounds', loading: 'Loading',
};

/**
 * Casters (and admins): the game server connect line for every live match, so
 * they can join as an in-game spectator. SourceTV has no first-person arms,
 * which is why casters want the real server. Guarded again by /api/cast; the
 * nav only offers the link to those it would let in.
 */
export function Cast() {
  const [matches, setMatches] = useState<CastMatch[] | null>(null);
  const [denied, setDenied] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const res = await castApi.list();
        if (!cancelled) { setMatches(res.matches); setDenied(false); }
      } catch (err) {
        if (cancelled) return;
        if (err instanceof ApiError && (err.status === 401 || err.status === 403)) setDenied(true);
        // Anything else: keep the last good render rather than blank on a blip.
      }
    };
    void load();
    const t = setInterval(load, POLL_MS);
    return () => { cancelled = true; clearInterval(t); };
  }, []);

  if (denied) {
    return (
      <div class="page page--list">
        <PageHeader eyebrow="Casting" title="Cast a match" />
        <Empty>This page is for casters. Ask an admin if you should have it.</Empty>
      </div>
    );
  }
  if (matches === null) return <div class="page page--list" />;

  return (
    <div class="page page--list">
      <PageHeader eyebrow="Casting" title="Cast a match">
        <p class="cast__studio"><a class="btn btn--sm" href="/cast/studio">Open the caster studio</a> overlays and scenes for OBS</p>
        <p class="muted cast__rules">
          Join and stay on Spectators. Do not pick a team: anyone on a side when the match goes
          live is rostered and scored. Each match has its own password, and the site records who
          looked at it.
        </p>
      </PageHeader>
      {matches.length === 0 ? (
        <Empty>No match is live right now. This page refreshes on its own.</Empty>
      ) : (
        <div class="stack">
          {matches.map((m) => <CastCard key={m.id} m={m} />)}
        </div>
      )}
    </div>
  );
}

function CastCard({ m }: { m: CastMatch }) {
  const phase = m.phase ? PHASE_LABEL[m.phase] : null;
  const status = phase && m.half && (m.phase === 'live' || m.phase === 'paused')
    ? `${phase} · Round ${m.half}` : phase;
  const lead = (mine: number, theirs: number) => (mine > theirs ? ' cast__score--lead' : '');
  const tvLine = m.spectate && (m.spectate.password
    ? `password ${m.spectate.password}; connect ${m.spectate.host}:${m.spectate.port}`
    : `connect ${m.spectate.host}:${m.spectate.port}`);
  return (
    <section class="panel cast" style={{ '--cast-tint': campaignTint(m.campaign) }}>
      <div class="cast__top">
        <p class="eyebrow">
          <a href={`/match/${m.id}`}>#{m.id}</a>
          {m.serverName && <> · {m.serverName}</>}
        </p>
        {status && <span class={`cast__status cast__status--${m.phase}`}>{status}</span>}
      </div>
      <h3 class="cast__title">
        {m.campaignName}
        <span class="cast__map">
          Map {m.mapNumber}{m.mapCount !== null && <> of {m.mapCount}</>}
          {m.currentMap && <> · {mapName(m.currentMap)}</>}
        </span>
      </h3>
      <div class="cast__teams">
        <div class="cast__side">
          <p class="eyebrow versus__eyebrow--a">Team A</p>
          <p>{m.teamA.join(', ')}</p>
        </div>
        <p class="cast__scores num" aria-label={`Score ${m.teamAScore} to ${m.teamBScore}`}>
          <span class={`cast__score${lead(m.teamAScore, m.teamBScore)}`}>{m.teamAScore}</span>
          <span class="cast__slash">/</span>
          <span class={`cast__score${lead(m.teamBScore, m.teamAScore)}`}>{m.teamBScore}</span>
        </p>
        <div class="cast__side cast__side--b">
          <p class="eyebrow versus__eyebrow--b">Team B</p>
          <p>{m.teamB.join(', ')}</p>
        </div>
      </div>
      {m.connect ? (
        <>
          <div class="cast__connect">
            {/* Password FIRST: see ConnectPanel for why the order matters. */}
            <code>password {m.connect.password}; connect {m.connect.host}:{m.connect.port}</code>
            <CopyChip label="Copy" text={`password ${m.connect.password}; connect ${m.connect.host}:${m.connect.port}`} />
            <a class="chip" href={`steam://connect/${m.connect.host}:${m.connect.port}/${m.connect.password}`}>Steam</a>
            {tvLine && <CopyChip label="SourceTV" title="Copy the SourceTV connect line" text={tvLine} />}
          </div>
          <p class="muted cast__hint">Paste it into the console. Through Steam, press Enter on the password prompt.</p>
        </>
      ) : m.booked ? (
        tvLine ? (
          <>
            <div class="cast__connect">
              <code>{tvLine}</code>
              <CopyChip label="Copy" text={tvLine} />
            </div>
            <p class="muted cast__hint">A booked scrim: watch it through SourceTV. The game server is only for the two sides.</p>
          </>
        ) : (
          <p class="muted cast__hint">SourceTV is off on this server.</p>
        )
      ) : (
        <p class="muted cast__hint">Started in game, so the site does not know this server's password. Ask an admin for it.</p>
      )}
    </section>
  );
}

function CopyChip({ label, text, title }: { label: string; text: string; title?: string }) {
  const [copied, setCopied] = useState(false);
  const reset = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (reset.current !== null) clearTimeout(reset.current); }, []);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      reset.current = setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard denied. The line is on screen to select by hand.
    }
  };
  return (
    <button class={`chip${copied ? ' is-on' : ''}`} type="button" title={title} onClick={copy}>
      {copied ? 'Copied' : label}
    </button>
  );
}
