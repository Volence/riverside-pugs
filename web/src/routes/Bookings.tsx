import { useEffect, useState } from 'preact/hooks';
import { useLocation } from 'preact-iso';
import { ApiError, bookingsApi, teamsApi, type BookingOptions, type BookingSummary, type NotifyPref, type ScrimReliability } from '../api';
import { Empty, Panel } from '../components/bits';
import { PageHeader } from '../components/PageHeader';
import { GatePanel } from '../components/GatePanel';
import { CompeteTabs } from '../components/CompeteTabs';
import type { Session } from '../hooks/useLiveState';
import { estimateLine, estimateSlot, localLabel, playMinutes, toUtcIso } from '../bookingTime';
import { RecordLine } from '../components/ScrimRecord';
import { confirm } from '../components/Confirm';

const STATE_LABEL: Record<BookingSummary['state'], string> = {
  scheduled: 'Booked', held: 'Server taken', setup: 'Setting up', ready: 'Ready', active: 'Playing',
  ended: 'Over', cancelled: 'Cancelled', no_show: 'No-show',
};

/** One row in "Your bookings" or "Recent", in the teamrow look: a name line,
 *  a muted meta line, a state chip, and whatever the viewer still owes it. */
function Row({ b, busy, act }: { b: BookingSummary; busy: boolean; act: (fn: () => Promise<unknown>) => void }) {
  const closing = b.ending && b.state !== 'cancelled';
  const chipKind = closing ? 'closing' : b.state;
  return (
    <li class="bookingrow">
      <a class="teamrow__who" href={`/booking/${b.id}`}>
        <span class="teamrow__name">{b.aName} vs {b.bName}</span>
        <span class="teamroster__meta">{localLabel(b.startsAt)}</span>
      </a>
      <span class={`teamchip teamchip--${chipKind}`}>{closing ? 'Closing' : STATE_LABEL[b.state]}</span>
      {b.needs === 'confirm' && (
        <span class="teamconfirm">
          <button class="btn btn--sm" disabled={busy} onClick={() => act(() => bookingsApi.act(b.id, 'confirm'))}>Confirm</button>
          <button class="btn btn--ghost btn--sm" disabled={busy} onClick={async () => {
            if (await confirm({ title: `Decline ${b.aName} vs ${b.bName}?`, body: 'The booking is cancelled and the other side is told.', confirmLabel: 'Decline', cancelLabel: 'Go back', danger: true })) {
              act(() => bookingsApi.act(b.id, 'decline'));
            }
          }}>Decline</button>
        </span>
      )}
      {b.needs === 'accept' && (
        <span class="teamconfirm">
          <button class="btn btn--sm" disabled={busy} onClick={() => act(() => bookingsApi.act(b.id, 'accept'))}>Accept</button>
          <button class="btn btn--ghost btn--sm" disabled={busy} onClick={() => act(() => bookingsApi.act(b.id, 'leave'))}>Decline</button>
        </span>
      )}
    </li>
  );
}

function BookForm({ options, onError }: { options: BookingOptions; onError: (e: string | null) => void }) {
  const { route } = useLocation();
  const [teamId, setTeamId] = useState<number | null>(options.myTeams[0]?.id ?? null);
  const [against, setAgainst] = useState<'team' | 'player'>('team');
  const [oppTeam, setOppTeam] = useState<number | null>(null);
  const [q, setQ] = useState('');
  const [found, setFound] = useState<{ steamid: string; name: string }[]>([]);
  const [oppPlayer, setOppPlayer] = useState<{ steamid: string; name: string } | null>(null);
  const [when, setWhen] = useState('');
  const [playlist, setPlaylist] = useState<string[]>([]);
  const [rulesetId, setRulesetId] = useState<number | undefined>(options.rulesets.find((r) => r.name === 'Casual Scrim')?.id);
  const [gameConfig, setGameConfig] = useState<string>(options.gameConfigs.find((g) => g.key === 'standard')?.key ?? options.gameConfigs[0]?.key ?? 'standard');
  const summary = options.rulesets.find((r) => r.id === rulesetId)?.summary ?? '';
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (q.trim().length < 2) { setFound([]); return; }
    const ctl = new AbortController();
    teamsApi.search(q.trim(), ctl.signal).then((r) => setFound(r.players), () => {});
    return () => ctl.abort();
  }, [q]);

  // No length picker: the slot is estimated from the campaigns, the way the
  // server will compute it. The campaign cap (playlistMax) is the only limit.
  const estimate = estimateSlot(options.estimate, playlist);
  const toggle = (slug: string) => setPlaylist((p) => p.includes(slug) ? p.filter((s) => s !== slug) : p.length < options.limits.playlistMax ? [...p, slug] : p);

  const submit = async (ev: Event) => {
    ev.preventDefault();
    onError(null);
    const startsAt = toUtcIso(when);
    if (!startsAt) { onError('Pick a start time.'); return; }
    const opponent = against === 'team' ? (oppTeam !== null ? { teamId: oppTeam } : null) : (oppPlayer ? { steamid: oppPlayer.steamid } : null);
    if (!opponent) { onError('Pick who you are playing against.'); return; }
    setBusy(true);
    try {
      const { id } = await bookingsApi.create({ teamId, opponent, startsAt, playlist, rulesetId, gameConfig });
      route(`/booking/${id}`);
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form class="bookform bkform" onSubmit={submit}>
      <div class="bkform__fields">
        <label class="teamfield">Your side
          <select aria-label="Your side" value={teamId === null ? '' : String(teamId)} onChange={(e) => { const v = (e.target as HTMLSelectElement).value; setTeamId(v ? Number(v) : null); }}>
            {options.myTeams.map((t) => <option key={t.id} value={String(t.id)}>[{t.tag}] {t.name}</option>)}
            <option value="">A pickup group (just me for now)</option>
          </select>
        </label>
        <fieldset class="bookform__fieldset">
          <legend class="teamsub">Against</legend>
          <label><input type="radio" name="against" checked={against === 'team'} onChange={() => setAgainst('team')} /> A team</label>
          <label><input type="radio" name="against" checked={against === 'player'} onChange={() => setAgainst('player')} /> A player and their group</label>
          {against === 'team'
            ? <select aria-label="Opponent team" value={oppTeam === null ? '' : String(oppTeam)} onChange={(e) => { const v = (e.target as HTMLSelectElement).value; setOppTeam(v ? Number(v) : null); }}>
                <option value="">Pick a team</option>
                {options.teams.filter((t) => t.id !== teamId).map((t) => <option key={t.id} value={String(t.id)}>[{t.tag}] {t.name}</option>)}
              </select>
            : <div class="bookform__search">
                {oppPlayer
                  ? <span class="inlinerow">{oppPlayer.name}<button type="button" class="btn btn--ghost btn--sm" onClick={() => setOppPlayer(null)}>Change</button></span>
                  : <>
                      <input aria-label="Find a player" value={q} placeholder="Player name" onInput={(e) => setQ((e.target as HTMLInputElement).value)} />
                      <ul>{found.map((p) => <li key={p.steamid}><button type="button" class="btn btn--ghost btn--sm" onClick={() => { setOppPlayer(p); setQ(''); }}>{p.name}</button></li>)}</ul>
                    </>}
              </div>}
        </fieldset>
        <label class="teamfield">Start (your time)<input aria-label="Start" type="datetime-local" value={when} onInput={(e) => setWhen((e.target as HTMLInputElement).value)} /></label>
        {options.rulesets.length > 1 && (
          <div class="bookform__pick">
            <label class="teamfield">Rules
              <select aria-label="Rules" value={rulesetId === undefined ? '' : String(rulesetId)} onChange={(e) => setRulesetId(Number((e.target as HTMLSelectElement).value))}>
                {options.rulesets.map((r) => <option key={r.id} value={String(r.id)}>{r.name}</option>)}
              </select>
            </label>
            <p class="muted">Match rules: pauses, side choice, no-show grace.</p>
            {summary && <p class="muted">{summary}</p>}
          </div>
        )}
        {options.gameConfigs.length > 1 && (
          <div class="bookform__pick">
            <label class="teamfield">Game config
              <select aria-label="Game config" value={gameConfig} onChange={(e) => setGameConfig((e.target as HTMLSelectElement).value)}>
                {options.gameConfigs.map((g) => <option key={g.key} value={g.key}>{g.label}</option>)}
              </select>
            </label>
            <p class="muted">What the server runs (the cfg it loads).</p>
          </div>
        )}
        <button class="btn" type="submit" disabled={busy || playlist.length === 0}>Book the server</button>
      </div>
      <fieldset class="bookform__fieldset bkform__camps">
        <legend class="teamsub">Campaigns (up to {options.limits.playlistMax}, in play order)</legend>
        {options.campaigns.map((c) => (
          <label key={c.slug} class={`bkcamp${playlist.includes(c.slug) ? ' bkcamp--on' : ''}`}>
            <input type="checkbox" aria-label={c.name} checked={playlist.includes(c.slug)} disabled={!playlist.includes(c.slug) && playlist.length >= options.limits.playlistMax} onChange={() => toggle(c.slug)} />
            <span class="bkcamp__name">{c.name}</span>
            <span class="bkcamp__min muted">about {c.minutes} min</span>
            {playlist.includes(c.slug) && <span class="bkcamp__order" aria-label={`number ${playlist.indexOf(c.slug) + 1} in play order`}>#{playlist.indexOf(c.slug) + 1}</span>}
          </label>
        ))}
        {playlist.length > 0 && <p class="muted">{estimateLine(playMinutes(options.estimate, playlist), estimate, playlist.length)}</p>}
      </fieldset>
    </form>
  );
}

export function Bookings({ session }: { session: Session }) {
  const signedIn = session.kind === 'active';
  const [mine, setMine] = useState<{ open: BookingSummary[]; recent: BookingSummary[]; prefs: NotifyPref[]; record?: ScrimReliability; recordPublic?: boolean } | null>(null);
  const [options, setOptions] = useState<BookingOptions | null>(null);
  const [closed, setClosed] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [loadFailed, setLoadFailed] = useState(false);

  const load = () => {
    if (!signedIn) return;
    setLoadFailed(false);
    const failed = (e: unknown) => { if (e instanceof ApiError && e.status === 404) setClosed(true); else setLoadFailed(true); };
    bookingsApi.mine().then(setMine, failed);
    bookingsApi.options().then(setOptions, failed);
  };
  useEffect(load, [signedIn]);

  const act = async (fn: () => Promise<unknown>) => {
    setError(null);
    setBusy(true);
    try { await fn(); load(); } catch (e) { setError(e instanceof Error ? e.message : String(e)); } finally { setBusy(false); }
  };

  if (!signedIn || closed) {
    return (
      <main class="page page--profile bookingpage">
        <PageHeader eyebrow="Competitive" title="Bookings" />
        {closed
          ? <GatePanel title="Not open yet" lead="Booked servers are not open yet." links={[{ href: '/events', label: 'See events' }]} />
          : (
            <GatePanel
              title="Book a Riverside server"
              lead="Sign in to book a server for your team or a pickup group."
              points={[
                'Pick a time and the campaigns, and the server is set up for you with the match config.',
                'Your players get the connect line and password in Discord.',
                'Scrims you arrange on the board are booked here too.',
              ]}
              signInNext="/bookings"
              links={[{ href: '/events', label: 'See events' }]}
            />
          )}
      </main>
    );
  }
  return (
    <main class="page page--profile bookingpage">
      <CompeteTabs active="bookings" session={session} />
      <PageHeader eyebrow="Competitive" title="Bookings" />
      {error && <p class="error" role="alert">{error}</p>}
      {loadFailed && <p class="error" role="alert">Could not load your bookings. <button class="btn btn--ghost btn--sm" onClick={load}>Try again</button></p>}
      <Panel>
        <h3>Your bookings</h3>
        {mine === null ? (loadFailed ? null : <Empty>Loading…</Empty>) : mine.open.length === 0
          ? <Empty>Nothing booked.</Empty>
          : <ul class="bookinglist">{mine.open.map((b) => <Row key={b.id} b={b} busy={busy} act={act} />)}</ul>}
      </Panel>
      {mine?.record && (
        <Panel>
          <h3>Your pickup record</h3>
          <p class="muted">Bookings you captained as a pickup group. {mine.recordPublic
            ? 'Records are public, so everyone sees it as a badge on your board posts.'
            : 'Only you and staff see it.'}</p>
          <RecordLine record={mine.record} />
        </Panel>
      )}
      {options && (
        <Panel>
          <h3>Book a server</h3>
          <BookForm options={options} onError={setError} />
        </Panel>
      )}
      {mine && mine.recent.length > 0 && (
        <Panel>
          <h3>Recent</h3>
          <ul class="bookinglist">{mine.recent.map((b) => <Row key={b.id} b={b} busy={busy} act={act} />)}</ul>
        </Panel>
      )}
      {mine && (
        <Panel>
          <h3>Discord messages</h3>
          {mine.prefs.map((p) => (
            <label key={p.type} class="bookingpref">
              <input type="checkbox" aria-label={p.label} checked={p.enabled} disabled={busy}
                onChange={() => act(() => bookingsApi.setPref(p.type, !p.enabled))} />
              {p.label}
            </label>
          ))}
        </Panel>
      )}
    </main>
  );
}

export default Bookings;
