import { useEffect, useState } from 'preact/hooks';
import { useLocation } from 'preact-iso';
import { ApiError, bookingsApi, teamsApi, type BookingOptions, type BookingSummary, type NotifyPref, type ScrimReliability } from '../api';
import { Empty, Panel } from '../components/bits';
import { PageHeader } from '../components/PageHeader';
import type { Session } from '../hooks/useLiveState';
import { estimateLine, estimateSlot, localLabel, toUtcIso } from '../bookingTime';
import { RecordLine } from '../components/ScrimRecord';

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
          <button class="btn btn--ghost btn--sm" disabled={busy} onClick={() => act(() => bookingsApi.act(b.id, 'decline'))}>Decline</button>
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
      const { id } = await bookingsApi.create({ teamId, opponent, startsAt, playlist, rulesetId });
      route(`/booking/${id}`);
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form class="bookform" onSubmit={submit}>
      <label class="teamfield">Your side
        <select aria-label="Your side" value={teamId === null ? '' : String(teamId)} onChange={(e) => { const v = (e.target as HTMLSelectElement).value; setTeamId(v ? Number(v) : null); }}>
          {options.myTeams.map((t) => <option key={t.id} value={String(t.id)}>[{t.tag}] {t.name}</option>)}
          <option value="">A pickup group (just me for now)</option>
        </select>
      </label>
      <fieldset class="bookform__fieldset">
        <legend class="teamsub">Against</legend>
        <label><input type="radio" checked={against === 'team'} onChange={() => setAgainst('team')} /> A team</label>
        <label><input type="radio" checked={against === 'player'} onChange={() => setAgainst('player')} /> A player and their group</label>
        {against === 'team'
          ? <select aria-label="Opponent team" value={oppTeam === null ? '' : String(oppTeam)} onChange={(e) => { const v = (e.target as HTMLSelectElement).value; setOppTeam(v ? Number(v) : null); }}>
              <option value="">Pick a team</option>
              {options.teams.filter((t) => t.id !== teamId).map((t) => <option key={t.id} value={String(t.id)}>[{t.tag}] {t.name}</option>)}
            </select>
          : <div class="bookform__search">
              {oppPlayer
                ? <span>{oppPlayer.name} <button type="button" class="btn btn--ghost btn--sm" onClick={() => setOppPlayer(null)}>Change</button></span>
                : <>
                    <input aria-label="Find a player" value={q} placeholder="Player name" onInput={(e) => setQ((e.target as HTMLInputElement).value)} />
                    <ul>{found.map((p) => <li key={p.steamid}><button type="button" class="btn btn--ghost btn--sm" onClick={() => { setOppPlayer(p); setQ(''); }}>{p.name}</button></li>)}</ul>
                  </>}
            </div>}
      </fieldset>
      <label class="teamfield">Start (your time)<input aria-label="Start" type="datetime-local" value={when} onInput={(e) => setWhen((e.target as HTMLInputElement).value)} /></label>
      <fieldset class="bookform__fieldset">
        <legend class="teamsub">Campaigns (up to {options.limits.playlistMax}, in play order)</legend>
        {options.campaigns.map((c) => (
          <label key={c.slug}>
            <input type="checkbox" aria-label={c.name} checked={playlist.includes(c.slug)} onChange={() => toggle(c.slug)} />
            {c.name}
            <span class="muted"> · about {c.minutes} min{playlist.includes(c.slug) ? ` · #${playlist.indexOf(c.slug) + 1}` : ''}</span>
          </label>
        ))}
        {playlist.length > 0 && <p class="muted">{estimateLine(estimate, playlist.length)}</p>}
      </fieldset>
      {options.rulesets.length > 1 && (
        <label class="teamfield">Rules
          <select aria-label="Rules" value={rulesetId === undefined ? '' : String(rulesetId)} onChange={(e) => setRulesetId(Number((e.target as HTMLSelectElement).value))}>
            {options.rulesets.map((r) => <option key={r.id} value={String(r.id)}>{r.name}</option>)}
          </select>
        </label>
      )}
      <button class="btn" type="submit" disabled={busy || playlist.length === 0}>Book the server</button>
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

  const load = () => {
    if (!signedIn) return;
    bookingsApi.mine().then(setMine, (e) => { if (e instanceof ApiError && e.status === 404) setClosed(true); });
    bookingsApi.options().then(setOptions, () => {});
  };
  useEffect(load, [signedIn]);

  const act = async (fn: () => Promise<unknown>) => {
    setError(null);
    setBusy(true);
    try { await fn(); load(); } catch (e) { setError(e instanceof Error ? e.message : String(e)); } finally { setBusy(false); }
  };

  if (!signedIn || closed) {
    return <main class="page page--profile bookingpage"><PageHeader title="Bookings" /><Empty>{closed ? 'Booked servers are not open yet.' : 'Sign in to book a server.'}</Empty></main>;
  }
  return (
    <main class="page page--profile bookingpage">
      <PageHeader eyebrow="Competitive" title="Bookings" />
      {error && <p class="error" role="alert">{error}</p>}
      <Panel>
        <h3>Your bookings</h3>
        {mine === null ? null : mine.open.length === 0
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
