import { useEffect, useState } from 'preact/hooks';
import { useLocation } from 'preact-iso';
import {
  ApiError, scrimsApi, type NewScrimPost, type ScrimBoardPost, type ScrimNightWindow, type ScrimOptions,
} from '../api';
import { Empty, Panel } from '../components/bits';
import { PageHeader } from '../components/PageHeader';
import type { Session } from '../hooks/useLiveState';
import { fitWarning, localLabel, nightRangeLabel, toUtcIso } from '../bookingTime';
import { campaignName } from '../format';
import { TeamBadge } from './Teams';
import { reliableBadge } from '../components/ScrimRecord';

/** The board's SR range select (spec part 4): open, or one of a few common
 *  widths. The server accepts any integer 50..1000 (scrim_sr_range), but the
 *  page only offers these, the same way the length select only offers
 *  step-aligned lengths rather than any minute count. */
const SR_RANGES: readonly { value: string; label: string }[] = [
  { value: '', label: 'Open (any SR)' },
  { value: '100', label: '± 100' },
  { value: '200', label: '± 200' },
  { value: '300', label: '± 300' },
  { value: '500', label: '± 500' },
];

const srRangeLabel = (range: number | null): string => range === null ? 'Open' : `± ${range}`;

/** Plan 2 Ruling 7: the board's banner for the weekly scrim night window,
 *  with "On now" while the viewer is inside it. */
function NightBanner({ night }: { night: ScrimNightWindow }) {
  const live = Date.now() >= Date.parse(night.startsAt) && Date.now() < Date.parse(night.endsAt);
  return (
    <p class="scrimnight">
      Scrim night: {nightRangeLabel(night.startsAt, night.endsAt)} (your time)
      {live && <span class="teamchip teamchip--captain scrimnight__live">On now</span>}
    </p>
  );
}

/** A side's badge and name, reused on the board and in "Your posts": the
 *  team look (TeamBadge, from Teams.tsx) for a team side, "Pickup" in its
 *  place for a pickup group. */
function SideLabel({ side }: { side: ScrimBoardPost['side'] }) {
  return side.kind === 'team'
    ? (
      <span class="scrimside">
        <TeamBadge tag={side.tag} logoKey={side.logoKey} size={32} />
        <span class="teamrow__name">{side.name}</span>
      </span>
    )
    : (
      <span class="scrimside">
        <span class="teambadge teambadge--tag" aria-hidden="true">Pickup</span>
        <span class="teamrow__name">{side.name}</span>
      </span>
    );
}

/** "Post a scrim": side, start, length, campaigns, SR range, note and an
 *  optional direct challenge. Mirrors Bookings.tsx's BookForm. */
function PostForm({ options, busy, onSubmit }: { options: ScrimOptions; busy: boolean; onSubmit: (b: NewScrimPost) => Promise<boolean> }) {
  const [teamId, setTeamId] = useState<number | null>(options.myTeams[0]?.id ?? null);
  const [when, setWhen] = useState('');
  const [minutes, setMinutes] = useState(options.limits.minMinutes * 2 <= options.limits.maxMinutes ? options.limits.minMinutes * 2 : options.limits.minMinutes);
  const [campaigns, setCampaigns] = useState<string[]>([]);
  const [srRange, setSrRange] = useState('');
  const [note, setNote] = useState('');
  const [targetTeamId, setTargetTeamId] = useState('');

  const lengths: number[] = [];
  for (let m = options.limits.minMinutes; m <= options.limits.maxMinutes; m += options.limits.stepMinutes) lengths.push(m);
  const playMinutes = campaigns.reduce((s, slug) => s + (options.campaigns.find((c) => c.slug === slug)?.minutes ?? 60), 0);
  const warning = campaigns.length > 0 ? fitWarning(minutes, playMinutes) : null;
  const toggle = (slug: string) => setCampaigns((p) => p.includes(slug) ? p.filter((s) => s !== slug) : p.length < options.limits.playlistMax ? [...p, slug] : p);

  const submit = async (ev: Event) => {
    ev.preventDefault();
    const startsAt = toUtcIso(when);
    if (!startsAt) return;
    await onSubmit({
      teamId, startsAt, minutes, campaigns, srRange: srRange === '' ? null : Number(srRange), note,
      targetTeamId: targetTeamId === '' ? undefined : Number(targetTeamId),
    });
  };

  return (
    <form class="bookform" onSubmit={submit}>
      <label class="teamfield">Your side
        <select aria-label="Your side" value={teamId === null ? '' : String(teamId)} onChange={(e) => { const v = (e.target as HTMLSelectElement).value; setTeamId(v ? Number(v) : null); }}>
          {options.myTeams.map((t) => <option key={t.id} value={String(t.id)}>[{t.tag}] {t.name}</option>)}
          <option value="">A pickup group (just me for now)</option>
        </select>
      </label>
      <label class="teamfield">Start (your time)<input aria-label="Start" type="datetime-local" value={when} onInput={(e) => setWhen((e.target as HTMLInputElement).value)} /></label>
      <label class="teamfield">Length
        <select aria-label="Length" value={String(minutes)} onChange={(e) => setMinutes(Number((e.target as HTMLSelectElement).value))}>
          {lengths.map((m) => <option key={m} value={String(m)}>{m / 60} h</option>)}
        </select>
      </label>
      <label class="teamfield">SR range
        <select aria-label="SR range" value={srRange} onChange={(e) => setSrRange((e.target as HTMLSelectElement).value)}>
          {SR_RANGES.map((r) => <option key={r.value} value={r.value}>{r.label}</option>)}
        </select>
      </label>
      <fieldset class="bookform__fieldset">
        <legend class="teamsub">Campaigns (up to {options.limits.playlistMax}, in play order)</legend>
        {options.campaigns.map((c) => (
          <label key={c.slug}>
            <input type="checkbox" aria-label={c.name} checked={campaigns.includes(c.slug)} onChange={() => toggle(c.slug)} />
            {c.name}
            <span class="muted"> · about {c.minutes} min{campaigns.includes(c.slug) ? ` · #${campaigns.indexOf(c.slug) + 1}` : ''}</span>
          </label>
        ))}
        {warning && <p class="warning">{warning}</p>}
      </fieldset>
      <label class="teamfield">Note<input aria-label="Note" value={note} maxLength={options.limits.noteMax} onInput={(e) => setNote((e.target as HTMLInputElement).value)} /></label>
      {options.teams.length > 0 && (
        <label class="teamfield">Challenge a team (optional)
          <select aria-label="Challenge a team" value={targetTeamId} onChange={(e) => setTargetTeamId((e.target as HTMLSelectElement).value)}>
            <option value="">Public post, any side may accept</option>
            {options.teams.filter((t) => t.id !== teamId).map((t) => <option key={t.id} value={String(t.id)}>[{t.tag}] {t.name}</option>)}
          </select>
        </label>
      )}
      <button class="btn" type="submit" disabled={busy || campaigns.length === 0 || !when}>Post the scrim</button>
    </form>
  );
}

/** The inline Accept form a board row opens: pick your side, add up to the
 *  setting's campaigns, post it. A direct challenge only offers the target
 *  team, since accepting it as anything else is refused server-side. */
function AcceptForm({
  post, options, busy, onSubmit, onCancel,
}: {
  post: ScrimBoardPost; options: ScrimOptions; busy: boolean;
  onSubmit: (teamId: number | null, campaigns: string[]) => Promise<boolean>; onCancel: () => void;
}) {
  const choices = post.challenge ? options.myTeams.filter((t) => t.id === post.challenge!.teamId) : options.myTeams;
  const [teamId, setTeamId] = useState<number | null>(choices[0]?.id ?? null);
  const [campaigns, setCampaigns] = useState<string[]>([]);
  const max = options.limits.acceptCampaignsMax;
  const toggle = (slug: string) => setCampaigns((p) => p.includes(slug) ? p.filter((s) => s !== slug) : p.length < max ? [...p, slug] : p);

  return (
    <form
      class="scrimaccept"
      onSubmit={(ev) => { ev.preventDefault(); onSubmit(teamId, campaigns); }}
    >
      <label class="teamfield">Accept as
        <select aria-label={`Accept as (post ${post.id})`} value={teamId === null ? '' : String(teamId)} onChange={(e) => { const v = (e.target as HTMLSelectElement).value; setTeamId(v ? Number(v) : null); }}>
          {choices.map((t) => <option key={t.id} value={String(t.id)}>[{t.tag}] {t.name}</option>)}
          {!post.challenge && <option value="">A pickup group (just me for now)</option>}
        </select>
      </label>
      {max > 0 && (
        <fieldset class="bookform__fieldset">
          <legend class="teamsub">Add up to {max} campaign{max === 1 ? '' : 's'} of your own</legend>
          {options.campaigns.map((c) => (
            <label key={c.slug}>
              <input type="checkbox" aria-label={`${c.name} (post ${post.id})`} checked={campaigns.includes(c.slug)} onChange={() => toggle(c.slug)} />
              {c.name}
            </label>
          ))}
        </fieldset>
      )}
      <p class="scrimaccept__actions">
        <button class="btn btn--sm" type="submit" disabled={busy}>Send acceptance</button>
        <button class="btn btn--ghost btn--sm" type="button" disabled={busy} onClick={onCancel}>Cancel</button>
      </p>
    </form>
  );
}

/** One row on the board: a public or direct-challenge post, open to accept
 *  unless it is the viewer's own, or the viewer's side already offered on
 *  it. */
function BoardRow({
  post, options, highlighted, busy, onAccept, onWithdrawAccept,
}: {
  post: ScrimBoardPost; options: ScrimOptions; highlighted: boolean; busy: boolean;
  onAccept: (teamId: number | null, campaigns: string[]) => Promise<boolean>; onWithdrawAccept: (acceptId: number) => Promise<boolean>;
}) {
  const [open, setOpen] = useState(false);
  return (
    <li id={`scrim-${post.id}`} class={`scrimrow${highlighted ? ' scrimrow--highlight' : ''}${post.night ? ' scrimrow--night' : ''}`}>
      <div class="scrimrow__main">
        <SideLabel side={post.side} />
        <span class="teamroster__meta">
          {localLabel(post.startsAt)} · {post.minutes / 60} h · SR {post.sr} ({srRangeLabel(post.srRange)})
          {post.challenge && ' · direct challenge'}
        </span>
        <span class="teamroster__meta">{post.campaigns.map((c) => campaignName(c)).join(', ')}</span>
        {post.note && <span class="teamroster__meta">{post.note}</span>}
        {post.record && <span class="teamchip scrimbadge">{reliableBadge(post.record)}</span>}
        {post.night && <span class="teamchip scrimnighttag">Scrim night</span>}
      </div>
      {post.mine
        ? <span class="teamchip teamchip--captain">Your post</span>
        : post.myAcceptId !== null
          ? (
            <span class="scrimaccept__actions">
              <span class="teamchip">Pending your offer</span>
              <button class="btn btn--ghost btn--sm" disabled={busy} onClick={() => onWithdrawAccept(post.myAcceptId!)}>Withdraw</button>
            </span>
          )
          : open
            ? <AcceptForm post={post} options={options} busy={busy} onSubmit={async (t, c) => { const ok = await onAccept(t, c); if (ok) setOpen(false); return ok; }} onCancel={() => setOpen(false)} />
            : <button class="btn btn--sm" onClick={() => setOpen(true)}>Accept</button>}
    </li>
  );
}

/** "Your posts": each of the viewer's own open or pending posts, with its
 *  pending acceptances (the proposed playlist and SR fit) and Confirm /
 *  Decline, plus Withdraw for the post itself. */
function MyPostPanel({
  post, busy, onConfirm, onDecline, onWithdraw, confirmError,
}: {
  post: ScrimBoardPost; busy: boolean; confirmError: { acceptId: number; message: string } | null;
  onConfirm: (acceptId: number) => Promise<void>; onDecline: (acceptId: number) => Promise<boolean>; onWithdraw: (postId: number) => Promise<boolean>;
}) {
  return (
    <li class="scrimmine">
      <div class="scrimrow__main">
        <SideLabel side={post.side} />
        <span class="teamroster__meta">
          {localLabel(post.startsAt)} · {post.minutes / 60} h · SR {post.sr} ({srRangeLabel(post.srRange)})
          {post.challenge && ` · challenged ${post.challenge.name}`}
        </span>
        <span class="teamroster__meta">{post.campaigns.map((c) => campaignName(c)).join(', ')}</span>
      </div>
      <button class="btn btn--ghost btn--sm" disabled={busy} onClick={() => onWithdraw(post.id)}>Withdraw</button>
      {post.accepts && post.accepts.length > 0 && (
        <ul class="scrimaccepts">
          {post.accepts.map((a) => (
            <li key={a.id}>
              <SideLabel side={a.side} />
              <span class={`teamchip${a.fits ? ' teamchip--captain' : ''}`}>SR {a.sr} · {a.fits ? 'fits' : 'outside your range'}</span>
              <span class="teamroster__meta">
                Proposed: {a.proposed.playlist.map((c) => campaignName(c)).join(', ')} ({a.proposed.minutes} min)
              </span>
              {!a.proposed.fits && <p class="warning">{fitWarning(post.minutes, a.proposed.minutes)}</p>}
              <span class="teamconfirm">
                <button class="btn btn--sm" disabled={busy} onClick={() => onConfirm(a.id)}>Confirm</button>
                <button class="btn btn--ghost btn--sm" disabled={busy} onClick={() => onDecline(a.id)}>Decline</button>
              </span>
              {confirmError && confirmError.acceptId === a.id && <p class="error" role="alert">{confirmError.message}</p>}
            </li>
          ))}
        </ul>
      )}
    </li>
  );
}

export function Scrims({ session }: { session: Session }) {
  const { query, route } = useLocation();
  const signedIn = session.kind === 'active';
  const [options, setOptions] = useState<ScrimOptions | null>(null);
  const [posts, setPosts] = useState<ScrimBoardPost[] | null>(null);
  const [night, setNight] = useState<ScrimNightWindow | null>(null);
  const [closed, setClosed] = useState(false);
  const [fitsOnly, setFitsOnly] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmError, setConfirmError] = useState<{ acceptId: number; message: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const load = () => {
    if (!signedIn) return;
    scrimsApi.board(fitsOnly).then((r) => { setPosts(r.posts); setNight(r.night); }, (e) => { if (e instanceof ApiError && e.status === 404) setClosed(true); });
  };
  useEffect(load, [signedIn, fitsOnly]);
  useEffect(() => { if (signedIn) scrimsApi.options().then(setOptions, () => {}); }, [signedIn]);

  const highlightId = (() => {
    const raw = (query as Record<string, string> | undefined)?.post;
    const n = raw !== undefined ? Number(raw) : NaN;
    return Number.isInteger(n) ? n : null;
  })();
  useEffect(() => {
    if (highlightId === null || !posts) return;
    document.getElementById(`scrim-${highlightId}`)?.scrollIntoView?.({ behavior: 'smooth', block: 'start' });
  }, [highlightId, posts !== null]);

  // Returns whether it succeeded, so a caller that holds its own open/closed
  // state (the inline accept form) only tears itself down once the post
  // actually went through, rather than on every settle.
  const act = async (fn: () => Promise<unknown>): Promise<boolean> => {
    setError(null);
    setBusy(true);
    try { await fn(); load(); return true; } catch (e) { setError(e instanceof Error ? e.message : String(e)); return false; } finally { setBusy(false); }
  };

  const post = (b: NewScrimPost) => act(() => scrimsApi.create(b));
  const accept = (postId: number, teamId: number | null, campaigns: string[]) => act(() => scrimsApi.accept(postId, teamId, campaigns));
  const withdrawAccept = (acceptId: number) => act(() => scrimsApi.withdrawAccept(acceptId));
  const decline = (acceptId: number) => act(() => scrimsApi.decline(acceptId));
  const withdraw = (postId: number) => act(() => scrimsApi.withdraw(postId));
  const confirm = async (acceptId: number) => {
    setError(null);
    setConfirmError(null);
    setBusy(true);
    try {
      const { bookingId } = await scrimsApi.confirm(acceptId);
      route(`/booking/${bookingId}`);
    } catch (e) {
      if (e instanceof ApiError && e.nearestSlot !== undefined) {
        const message = e.nearestSlot ? `${e.message} Nearest free slot: ${localLabel(e.nearestSlot)}.` : e.message;
        setConfirmError({ acceptId, message });
      } else {
        setError(e instanceof Error ? e.message : String(e));
      }
    } finally {
      setBusy(false);
    }
  };

  if (!signedIn || closed) {
    return <main class="page page--profile bookingpage"><PageHeader title="Scrims" /><Empty>{closed ? 'The scrim board is not open yet.' : 'Sign in to use the scrim board.'}</Empty></main>;
  }

  const mine = posts?.filter((p) => p.mine) ?? [];

  return (
    <main class="page page--profile bookingpage">
      <PageHeader eyebrow="Competitive" title="Scrims" />
      {error && <p class="error" role="alert">{error}</p>}

      {options && (
        <Panel>
          <h3>Post a scrim</h3>
          <PostForm options={options} busy={busy} onSubmit={post} />
        </Panel>
      )}

      <Panel>
        <h3>Board</h3>
        {night && <NightBanner night={night} />}
        <label class="scrimfit">
          <input type="checkbox" aria-label="Fits my SR" checked={fitsOnly} onChange={() => setFitsOnly((v) => !v)} />
          Fits my SR
        </label>
        {posts === null || options === null ? null : posts.length === 0
          ? <Empty>No open scrims right now.</Empty>
          : (
            <ul class="scrimrows">
              {posts.map((p) => (
                <BoardRow
                  key={p.id} post={p} options={options} highlighted={highlightId === p.id} busy={busy}
                  onAccept={(teamId, campaigns) => accept(p.id, teamId, campaigns)}
                  onWithdrawAccept={withdrawAccept}
                />
              ))}
            </ul>
          )}
      </Panel>

      {mine.length > 0 && (
        <Panel>
          <h3>Your posts</h3>
          <ul class="scrimrows">
            {mine.map((p) => (
              <MyPostPanel key={p.id} post={p} busy={busy} confirmError={confirmError} onConfirm={confirm} onDecline={decline} onWithdraw={withdraw} />
            ))}
          </ul>
        </Panel>
      )}
    </main>
  );
}

export default Scrims;
