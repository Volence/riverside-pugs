import { useEffect, useState } from 'preact/hooks';
import { ApiError, castApi, type CastMatch } from '../api';
import { campaignName, mapName } from '../format';
import { Empty, Panel } from '../components/bits';
import { ConnectPanel } from '../components/ConnectPanel';
import { SpectatePanel } from '../components/SpectatePanel';
import { PageHeader } from '../components/PageHeader';

/** A new match appears here once it goes live, so poll rather than make a
 *  caster reload. Slow on purpose: nothing on the card changes mid-match. */
const POLL_MS = 15000;

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
        <p class="muted">
          Join the game server and stay on Spectators. Do not pick a team: anyone on a
          side when the match goes live is put on the roster and scored as a player.
          Each match has its own password, and the site records who looked at it.
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
  return (
    <Panel class="cast">
      <h3>
        <a href={`/match/${m.id}`}>#{m.id}</a> {campaignName(m.campaign)}
        {m.currentMap && <span class="muted"> · {mapName(m.currentMap)}</span>}
        {m.serverName && <span class="muted"> · {m.serverName}</span>}
      </h3>
      <p class="muted">{m.teamA.join(', ')} <strong>vs</strong> {m.teamB.join(', ')}</p>
      {m.connect
        ? <ConnectPanel connect={m.connect} />
        : <p class="muted">Started in game, so the site does not know this server's password. Ask an admin for it.</p>}
      {m.spectate && <SpectatePanel spectate={m.spectate} />}
    </Panel>
  );
}
