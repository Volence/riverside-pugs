import { useEffect, useState } from 'preact/hooks';
import { useLocation } from 'preact-iso';
import type { ComponentChildren } from 'preact';
import {
  ApiError, scrimsApi, teamsApi, type BlockEntry, type BlockTargetInput, type NewScrimPost, type ScrimBoardPost,
  type ScrimNightWindow, type ScrimOptions,
} from '../api';
import { Empty, Panel } from '../components/bits';
import { PageHeader } from '../components/PageHeader';
import type { Session } from '../hooks/useLiveState';
import { estimateLine, estimateSlot, localLabel, mergedPlaylist, nightRangeLabel, playMinutes, slotSummary, toUtcIso } from '../bookingTime';
import { campaignName } from '../format';
import { TeamBadge } from './Teams';
import { reliableBadge } from '../components/ScrimRecord';

/** The board's SR range select (spec part 4): open, or one of a few common
 *  widths. The server accepts any integer 50..1000 (scrim_sr_range), but the
 *  page only offers these. Shown only while scrim_show_sr is on. */
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

/** The shared body of a post or an offer: the side and the start time on one
 *  line (the time drops under the name on a phone), the campaigns as a
 *  numbered list in play order, then a muted count and estimate. `meta`
 *  leads that last line (an offer's "Proposed"), `extra` trails it (the SR
 *  while scrim_show_sr is on, a challenge). */
function ScrimCard({
  side, startsAt, campaigns, minutes, label, meta, extra, children,
}: {
  side: ScrimBoardPost['side']; startsAt: string; campaigns: string[]; minutes: number; label: string;
  meta?: string; extra?: (string | null | undefined)[]; children?: ComponentChildren;
}) {
  return (
    <div class="scrimcard">
      <div class="scrimcard__head">
        <SideLabel side={side} />
        <time class="scrimcard__when" dateTime={startsAt}>{localLabel(startsAt)}</time>
      </div>
      <ol class="scrimcard__list" aria-label={label}>
        {campaigns.map((c) => <li key={c}>{campaignName(c)}</li>)}
      </ol>
      <p class="scrimcard__meta">
        {[meta, slotSummary(campaigns.length, minutes), ...(extra ?? [])].filter(Boolean).join(' · ')}
      </p>
      {children}
    </div>
  );
}

/** "Post a scrim": side, start, campaigns (the block is estimated from
 *  them), SR range (only while scrim_show_sr is on; otherwise none is sent
 *  and the post is open), note and an optional direct challenge. Mirrors
 *  Bookings.tsx's BookForm. */
function PostForm({ options, busy, onSubmit }: { options: ScrimOptions; busy: boolean; onSubmit: (b: NewScrimPost) => Promise<boolean> }) {
  const [teamId, setTeamId] = useState<number | null>(options.myTeams[0]?.id ?? null);
  const [when, setWhen] = useState('');
  const [campaigns, setCampaigns] = useState<string[]>([]);
  const [srRange, setSrRange] = useState('');
  const [note, setNote] = useState('');
  const [targetTeamId, setTargetTeamId] = useState('');

  const estimate = estimateSlot(options.estimate, campaigns);
  const toggle = (slug: string) => setCampaigns((p) => p.includes(slug) ? p.filter((s) => s !== slug) : p.length < options.limits.playlistMax ? [...p, slug] : p);

  const submit = async (ev: Event) => {
    ev.preventDefault();
    const startsAt = toUtcIso(when);
    if (!startsAt) return;
    await onSubmit({
      teamId, startsAt, campaigns, note,
      ...(options.showSr ? { srRange: srRange === '' ? null : Number(srRange) } : {}),
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
      {options.showSr && (
        <label class="teamfield">SR range
          <select aria-label="SR range" value={srRange} onChange={(e) => setSrRange((e.target as HTMLSelectElement).value)}>
            {SR_RANGES.map((r) => <option key={r.value} value={r.value}>{r.label}</option>)}
          </select>
        </label>
      )}
      <fieldset class="bookform__fieldset">
        <legend class="teamsub">Campaigns (up to {options.limits.playlistMax}, in play order)</legend>
        {options.campaigns.map((c) => (
          <label key={c.slug}>
            <input type="checkbox" aria-label={c.name} checked={campaigns.includes(c.slug)} disabled={!campaigns.includes(c.slug) && campaigns.length >= options.limits.playlistMax} onChange={() => toggle(c.slug)} />
            {c.name}
            <span class="muted"> · about {c.minutes} min{campaigns.includes(c.slug) ? ` · #${campaigns.indexOf(c.slug) + 1}` : ''}</span>
          </label>
        ))}
        {campaigns.length > 0 && <p class="muted">{estimateLine(playMinutes(options.estimate, campaigns), estimate, campaigns.length)}</p>}
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
  // The playlist this acceptance would propose, merged as the server merges
  // it, and its slot: never trimmed to the post's block, whatever that comes
  // out to (the campaign count is the only limit).
  const merged = mergedPlaylist(post.campaigns, campaigns, options.limits.playlistMax);
  const estimate = estimateSlot(options.estimate, merged);

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
              <input type="checkbox" aria-label={`${c.name} (post ${post.id})`} checked={campaigns.includes(c.slug)} disabled={!campaigns.includes(c.slug) && campaigns.length >= max} onChange={() => toggle(c.slug)} />
              {c.name}
            </label>
          ))}
        </fieldset>
      )}
      <p class="muted">{estimateLine(playMinutes(options.estimate, merged), estimate, merged.length)}</p>
      <p class="inlinerow">
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
  post, options, showSr, highlighted, busy, onAccept, onWithdrawAccept,
}: {
  post: ScrimBoardPost; options: ScrimOptions; showSr: boolean; highlighted: boolean; busy: boolean;
  onAccept: (teamId: number | null, campaigns: string[]) => Promise<boolean>; onWithdrawAccept: (acceptId: number) => Promise<boolean>;
}) {
  const [open, setOpen] = useState(false);
  return (
    <li id={`scrim-${post.id}`} class={`scrimrow${highlighted ? ' scrimrow--highlight' : ''}${post.night ? ' scrimrow--night' : ''}`}>
      <ScrimCard
        side={post.side} startsAt={post.startsAt} campaigns={post.campaigns} minutes={post.minutes}
        label={`Campaigns (post ${post.id})`}
        extra={[showSr ? `SR ${post.sr} (${srRangeLabel(post.srRange)})` : null, post.challenge ? 'direct challenge' : null]}
      >
        {post.note && <p class="scrimcard__note">{post.note}</p>}
        {(post.record || post.night) && (
          <p class="scrimcard__tags">
            {post.record && <span class="teamchip scrimbadge">{reliableBadge(post.record)}</span>}
            {post.night && <span class="teamchip scrimnighttag">Scrim night</span>}
          </p>
        )}
      </ScrimCard>
      {post.mine
        ? <p class="inlinerow"><span class="teamchip teamchip--captain">Your post</span></p>
        : post.myAcceptId !== null
          ? (
            <p class="inlinerow">
              <span class="teamchip">Pending your offer</span>
              <button class="btn btn--ghost btn--sm" disabled={busy} onClick={() => onWithdrawAccept(post.myAcceptId!)}>Withdraw</button>
            </p>
          )
          : open
            ? <AcceptForm post={post} options={options} busy={busy} onSubmit={async (t, c) => { const ok = await onAccept(t, c); if (ok) setOpen(false); return ok; }} onCancel={() => setOpen(false)} />
            : <p class="inlinerow"><button class="btn btn--sm" onClick={() => setOpen(true)}>Accept</button></p>}
    </li>
  );
}

/** "Your posts": each of the viewer's own open or pending posts, with its
 *  pending acceptances (the proposed playlist, laid out like the post, and
 *  the SR fit while scrim_show_sr is on) and Confirm /
 *  Decline, plus Withdraw for the post itself. */
function MyPostPanel({
  post, showSr, busy, onConfirm, onDecline, onWithdraw, confirmError,
}: {
  post: ScrimBoardPost; showSr: boolean; busy: boolean; confirmError: { acceptId: number; message: string } | null;
  onConfirm: (acceptId: number) => Promise<void>; onDecline: (acceptId: number) => Promise<boolean>; onWithdraw: (postId: number) => Promise<boolean>;
}) {
  return (
    <li class="scrimrow">
      <ScrimCard
        side={post.side} startsAt={post.startsAt} campaigns={post.campaigns} minutes={post.minutes}
        label={`Campaigns (post ${post.id})`}
        extra={[showSr ? `SR ${post.sr} (${srRangeLabel(post.srRange)})` : null, post.challenge ? `challenged ${post.challenge.name}` : null]}
      />
      <p class="inlinerow">
        <button class="btn btn--ghost btn--sm" disabled={busy} onClick={() => onWithdraw(post.id)}>Withdraw</button>
      </p>
      {post.accepts && post.accepts.length > 0 && (
        <ul class="scrimaccepts">
          {post.accepts.map((a) => (
            <li key={a.id}>
              <ScrimCard
                side={a.side} startsAt={post.startsAt} campaigns={a.proposed.playlist} minutes={a.proposed.minutes}
                label={`Proposed playlist (offer ${a.id})`} meta="Proposed"
              >
                {showSr && (
                  <p class="scrimcard__tags">
                    <span class={`teamchip${a.fits ? ' teamchip--captain' : ''}`}>SR {a.sr} · {a.fits ? 'fits' : 'outside your range'}</span>
                  </p>
                )}
              </ScrimCard>
              <p class="inlinerow">
                <button class="btn btn--sm" disabled={busy} onClick={() => onConfirm(a.id)}>Confirm</button>
                <button class="btn btn--ghost btn--sm" disabled={busy} onClick={() => onDecline(a.id)}>Decline</button>
              </p>
              {confirmError && confirmError.acceptId === a.id && <p class="error" role="alert">{confirmError.message}</p>}
            </li>
          ))}
        </ul>
      )}
    </li>
  );
}

/** A block's target, as a single short line: a team's badge-free "[TAG]
 *  Name" the way the challenge select writes it, or a player's name alone. */
function blockTargetLabel(entry: BlockEntry): string {
  return entry.target.kind === 'team' ? `[${entry.target.tag}] ${entry.target.name}` : entry.target.name;
}

/** "Blocked": the side picker (the same "Your side" choices as Post a
 *  scrim), its block list with an Unblock button each, and an add row that
 *  blocks a live team from a select or a player found by search (the same
 *  pattern Team.tsx's invite search uses). Shown below "Your posts", for
 *  anyone who can post. Silent on both ends (Ruling 4): nothing here tells a
 *  blocked side it was blocked. */
function BlockedPanel({ options }: { options: ScrimOptions }) {
  const [side, setSide] = useState<number | null>(options.myTeams[0]?.id ?? null);
  const [blocks, setBlocks] = useState<BlockEntry[] | null>(null);
  const [mode, setMode] = useState<'team' | 'player'>('team');
  const [addTeamId, setAddTeamId] = useState('');
  const [q, setQ] = useState('');
  const [found, setFound] = useState<{ steamid: string; name: string }[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = (signal?: AbortSignal) => {
    scrimsApi.blocks(side, signal).then((r) => { if (!signal || !signal.aborted) setBlocks(r.blocks); }, () => {});
  };
  // A side switch clears the list right away and cancels the request for the
  // side just left, so a slow response for it can never land after the
  // viewer has moved on to the new side.
  useEffect(() => {
    setBlocks(null);
    setError(null);
    const ctl = new AbortController();
    load(ctl.signal);
    return () => ctl.abort();
  }, [side]);

  useEffect(() => {
    if (q.trim().length < 2) { setFound([]); return; }
    const ctl = new AbortController();
    teamsApi.search(q.trim(), ctl.signal).then((r) => setFound(r.players), () => {});
    return () => ctl.abort();
  }, [q]);

  const act = async (fn: () => Promise<unknown>, after?: () => void) => {
    setError(null);
    setBusy(true);
    try { await fn(); after?.(); load(); } catch (e) { setError(e instanceof Error ? e.message : String(e)); } finally { setBusy(false); }
  };
  const block = (target: BlockTargetInput) => act(() => scrimsApi.block(side, target), () => { setAddTeamId(''); setQ(''); setFound([]); });
  const unblock = (target: BlockTargetInput) => act(() => scrimsApi.unblock(side, target));

  return (
    <Panel>
      <h3>Blocked</h3>
      <p class="muted">
        Blocked sides never see your scrim posts and you never see theirs; neither can accept, challenge or book the other. They are not told.
      </p>
      {error && <p class="error" role="alert">{error}</p>}
      <label class="teamfield">Your side
        <select aria-label="Your side for blocks" value={side === null ? '' : String(side)} onChange={(e) => { const v = (e.target as HTMLSelectElement).value; setSide(v ? Number(v) : null); }}>
          {options.myTeams.map((t) => <option key={t.id} value={String(t.id)}>[{t.tag}] {t.name}</option>)}
          <option value="">A pickup group (just me for now)</option>
        </select>
      </label>
      {blocks === null ? null : blocks.length === 0
        ? <Empty>No blocks.</Empty>
        : (
          <ul class="teamlist">
            {blocks.map((b) => (
              <li key={b.target.kind === 'team' ? `team-${b.target.id}` : `player-${b.target.steamid}`}>
                <span>{blockTargetLabel(b)}</span>
                <button
                  class="btn btn--ghost btn--sm" disabled={busy}
                  aria-label={`Unblock ${b.target.name}`}
                  onClick={() => unblock(b.target.kind === 'team' ? { teamId: b.target.id } : { steamid: b.target.steamid })}
                >
                  Unblock
                </button>
              </li>
            ))}
          </ul>
        )}
      <p class="inlinerow">
        <button class={`btn btn--sm${mode === 'team' ? '' : ' btn--ghost'}`} type="button" onClick={() => setMode('team')}>Team</button>
        <button class={`btn btn--sm${mode === 'player' ? '' : ' btn--ghost'}`} type="button" onClick={() => setMode('player')}>Player</button>
      </p>
      {mode === 'team'
        ? (
          <>
            <p class="inlinerow">
              <select aria-label="Team to block" value={addTeamId} onChange={(e) => setAddTeamId((e.target as HTMLSelectElement).value)}>
                <option value="">Pick a team</option>
                {options.teams.map((t) => <option key={t.id} value={String(t.id)}>[{t.tag}] {t.name}</option>)}
              </select>
              <button class="btn btn--sm" disabled={busy || addTeamId === ''} onClick={() => block({ teamId: Number(addTeamId) })}>Block team</button>
            </p>
          </>
        )
        : (
          <>
            <label class="teamfield">Find a player to block
              <input value={q} placeholder="Type at least two letters" onInput={(e) => setQ((e.target as HTMLInputElement).value)} />
            </label>
            {found.length > 0 && (
              <ul class="teamlist">
                {found.map((p) => (
                  <li key={p.steamid}>
                    <span>{p.name}</span>
                    <button class="btn btn--sm" disabled={busy} aria-label={`Block ${p.name}`} onClick={() => block({ steamid: p.steamid })}>Block</button>
                  </li>
                ))}
              </ul>
            )}
          </>
        )}
    </Panel>
  );
}

export function Scrims({ session }: { session: Session }) {
  const { query, route } = useLocation();
  const signedIn = session.kind === 'active';
  const [options, setOptions] = useState<ScrimOptions | null>(null);
  const [posts, setPosts] = useState<ScrimBoardPost[] | null>(null);
  const [night, setNight] = useState<ScrimNightWindow | null>(null);
  const [closed, setClosed] = useState(false);
  // scrim_show_sr, as the board last reported it. Off, the fit filter is
  // hidden and never sent, whatever it was left at.
  const [showSr, setShowSr] = useState(false);
  const [fitsOnly, setFitsOnly] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmError, setConfirmError] = useState<{ acceptId: number; message: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const load = () => {
    if (!signedIn) return;
    scrimsApi.board(showSr && fitsOnly).then((r) => { setPosts(r.posts); setNight(r.night); setShowSr(r.showSr); }, (e) => { if (e instanceof ApiError && e.status === 404) setClosed(true); });
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
        {showSr && (
          <label class="scrimfit">
            <input type="checkbox" aria-label="Fits my SR" checked={fitsOnly} onChange={() => setFitsOnly((v) => !v)} />
            Fits my SR
          </label>
        )}
        {posts === null || options === null ? null : posts.length === 0
          ? <Empty>No open scrims right now.</Empty>
          : (
            <ul class="scrimrows">
              {posts.map((p) => (
                <BoardRow
                  key={p.id} post={p} options={options} showSr={showSr} highlighted={highlightId === p.id} busy={busy}
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
              <MyPostPanel key={p.id} post={p} showSr={showSr} busy={busy} confirmError={confirmError} onConfirm={confirm} onDecline={decline} onWithdraw={withdraw} />
            ))}
          </ul>
        </Panel>
      )}

      {options && <BlockedPanel options={options} />}
    </main>
  );
}

export default Scrims;
