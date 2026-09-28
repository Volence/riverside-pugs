import { useEffect, useState } from 'preact/hooks';
import { api, ApiError, type PracticeLease } from '../api';
import type { Session } from '../hooks/useLiveState';
import { mapName } from '../format';
import { Panel } from '../components/bits';
import { PageHeader } from '../components/PageHeader';
import { ConnectPanel } from '../components/ConnectPanel';
import { CopyRow } from '../components/CopyRow';
import { useSecondsLeft } from '../components/Countdown';
import { confirm } from '../components/Confirm';
import { IDLE_MINUTES, KIND_LABEL, endReasonText, leaseClock, leasePath, setupText } from '../practice';

/** Fast while something is about to change (setup, wind-down), slow once
 *  the server is just running. */
const POLL_FAST_MS = 4_000;
const POLL_SLOW_MS = 15_000;

/**
 * /practice/:id, the invite page of one practice server
 * (src/practiceLeases.ts).
 *
 * The link IS the invite: a drill owner shares it, and any logged-in player
 * who opens it gets the connect line and the lease's own password. That is
 * why the password is on the page at all, and why the page needs a login:
 * the park list on the Play page is public and carries neither.
 *
 * A drill server's owner, and admins, also get End. The Practice Park is
 * ownerless: only an admin ends it early, and the page says it closes
 * itself 5 minutes after everyone leaves. Everything else a lease does (the 10
 * minute idle end, the time limit, a PUG taking the box back) happens on the
 * server's minute tick, and this page just reports it as it polls.
 */
export function Practice({ id, session }: { id: string; session: Session }) {
  const leaseId = Number(id);
  const [lease, setLease] = useState<PracticeLease | null>(null);
  const [error, setError] = useState<{ status: number; message: string } | null>(null);
  const [nudge, setNudge] = useState(0);
  const signedIn = session.kind === 'active';

  useEffect(() => {
    if (!signedIn || !Number.isInteger(leaseId)) return;
    const ctl = new AbortController();
    api.practiceLease(leaseId, ctl.signal)
      .then((l) => { setLease(l); setError(null); })
      .catch((err) => {
        if (ctl.signal.aborted) return;
        setError(err instanceof ApiError ? { status: err.status, message: err.message } : { status: 0, message: 'Could not load it.' });
      });
    return () => ctl.abort();
  }, [leaseId, signedIn, nudge]);

  // The next poll, spaced by what the lease is doing; none once it has ended.
  useEffect(() => {
    if (!lease || lease.state === 'ended') return;
    const fast = lease.state === 'setting_up' || lease.state === 'ending' || lease.warnedAt !== null;
    const t = setTimeout(() => setNudge((n) => n + 1), fast ? POLL_FAST_MS : POLL_SLOW_MS);
    return () => clearTimeout(t);
  }, [lease]);

  if (session.kind === 'loading') return <div class="page page--play" />;
  if (!signedIn) {
    return (
      <div class="page page--play">
        <PageHeader eyebrow="Practice" title="Practice server" />
        <Panel>
          <p>Sign in to get the connect line and password for this practice server.</p>
          {/* target _top: /auth/steam is a backend route, see Play.tsx. */}
          <a class="btn" href={`/auth/steam?next=${encodeURIComponent(leasePath(leaseId))}`} target="_top" rel="noopener">
            Sign in through Steam
          </a>
        </Panel>
      </div>
    );
  }
  if (error) {
    return (
      <div class="page page--play">
        <PageHeader eyebrow="Practice" title="Practice server" />
        <Panel>
          <p class="error" role="alert">
            {error.status === 404 ? 'There is no practice server with that link.' : 'Could not load this practice server.'}
          </p>
          <a class="chip" href="/">Back to Play</a>
        </Panel>
      </div>
    );
  }
  if (!lease) return <div class="page page--play" />;
  return (
    <div class="page page--play">
      <PageHeader eyebrow="Practice" title={KIND_LABEL[lease.kind]} />
      <LeasePanel lease={lease} onChanged={setLease} />
    </div>
  );
}

export function LeasePanel({ lease, onChanged }: { lease: PracticeLease; onChanged: (l: PracticeLease) => void }) {
  const [ending, setEnding] = useState(false);
  const [error, setError] = useState('');
  const left = useSecondsLeft(Date.parse(lease.endsAt));

  const end = async () => {
    const ok = await confirm({
      title: `Close this ${KIND_LABEL[lease.kind].toLowerCase()}?`,
      body: 'Everyone on it is kicked, and the server restarts and goes back to the PUG pool.',
      confirmLabel: 'Close it',
      danger: true,
    });
    if (!ok) return;
    setEnding(true);
    setError('');
    try {
      onChanged(await api.endPractice(lease.id));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not close it.');
    } finally {
      setEnding(false);
    }
  };

  const open = lease.state === 'setting_up' || lease.state === 'ready';
  return (
    <Panel class="practice">
      <p class="eyebrow">
        {lease.state === 'setting_up' ? (lease.setupPhase === 'loading' ? 'Loading' : 'Resetting')
          : lease.state === 'ready' ? 'Ready'
          : lease.state === 'ending' ? 'Closing'
          : 'Closed'}
        {' · '}{lease.server}
      </p>

      {lease.kind === 'park' && open && (
        <p class="practice__note">Practice Park, closes 5 minutes after everyone leaves.</p>
      )}
      {lease.state === 'setting_up' && (
        <p class="practice__note" role="status">{setupText(lease)}</p>
      )}
      {open && lease.warnedAt && (
        <p class="practice__warn" role="alert">A PUG needs this server. It closes within a minute: ranked matches always come first.</p>
      )}
      {lease.state === 'ending' && (
        <p class="practice__note">Closing because {endReasonText(lease.endReason, lease.kind)}. The server restarts and goes back to the PUG pool.</p>
      )}
      {lease.state === 'ended' && (
        <p class="practice__note">This practice server closed because {endReasonText(lease.endReason, lease.kind)}.</p>
      )}

      {open && lease.connect && (
        <>
          <ConnectPanel connect={lease.connect} />
          <CopyRow label="Password" value={lease.connect.password} />
        </>
      )}

      {open && (
        <dl class="practice__facts">
          <div><dt>Players</dt><dd class="num">{lease.humans}{lease.capacity !== null ? ` / ${lease.capacity}` : ''}</dd></div>
          <div><dt>Map</dt><dd>{lease.map ? mapName(lease.map) : 'loading'}</dd></div>
          {/* A park has no time limit anyone needs to watch: it runs while
              people are on it (see the note above). */}
          {lease.kind === 'drill' && (
            <div>
              <dt>Time left</dt>
              <dd class="num" title={`Extended while people are on it. Closes after ${IDLE_MINUTES[lease.kind]} minutes with nobody on.`}>{leaseClock(left)}</dd>
            </div>
          )}
          <div><dt>Started by</dt><dd><a href={`/player/${lease.owner.steamid}`}>{lease.owner.name}</a></dd></div>
        </dl>
      )}

      {lease.drillCode && open && (
        <p class="practice__drill">
          Drill <strong class="mono">{lease.drillCode}</strong> loads once the server is ready.
          {' '}Type <code>!drill {lease.drillCode}</code> to load it again.
        </p>
      )}

      {open && lease.isOwner && lease.kind === 'drill' && (
        <CopyRow label="Invite link" value={`${location.origin}${leasePath(lease.id)}`}
          hint="Anyone logged in who opens it gets the connect line. Only you can run the drill." />
      )}

      {lease.canEnd && (
        <button class="btn btn--ghost practice__end" type="button" disabled={ending} onClick={end}>
          {ending ? 'Closing...' : 'Close this server'}
        </button>
      )}
      {error && <p class="error" role="alert">{error}</p>}
    </Panel>
  );
}
