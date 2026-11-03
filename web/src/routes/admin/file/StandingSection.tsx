import { useState } from 'preact/hooks';
import { adminApi, type FileAction, type PlayerFileData } from '../../../api';
import { Panel } from '../../../components/bits';
import { fmtTime, type Run } from '../useAction';
import { timeoutCause, timeoutOffenses } from '../../../format';
import { sanctionText } from '../AdminTicket';
import { RestoreRating, abandonOutcome, restoredText } from '../RestoreRating';
import { BAN_LENGTHS } from '../banLengths';


type Props = { d: PlayerFileData; busy: boolean; run: Run; can: (a: FileAction) => boolean };

/** The abandon an "Abandoned match #N" ban was filed for, if it has a record. */
function abandonOf(d: PlayerFileData, reason: string) {
  const m = /^Abandoned match #(\d+)$/.exec(reason);
  return m ? (d.sections.standing.abandons ?? []).find((a) => a.matchId === Number(m[1])) ?? null : null;
}

/** The duo queue block in force, one muted line under the standing. */
function DuoBlockLine({ d }: { d: PlayerFileData }) {
  const b = d.sections.standing.duoBlock;
  if (!b) return null;
  return (
    <p class="muted">
      Blocked from duo {b.expiresAt ? `until ${fmtTime(b.expiresAt)}` : 'permanently'}: <strong>{b.reason}</strong>
      {b.createdByName ? ` · by ${b.createdByName}` : ''}
    </p>
  );
}

/** Lift the duo block, beside Unban or Ban this player. */
function LiftDuoBlock({ d, busy, run }: Pick<Props, 'd' | 'busy' | 'run'>) {
  return (
    <button class="btn" type="button" disabled={busy}
      onClick={() => run(() => adminApi.duoUnblock(d.steamid), {
        title: `Lift ${d.header.name}'s duo block?`,
        body: 'They can send and accept duo invites again at once.',
        confirmLabel: 'Lift duo block',
      })}>Lift duo block</button>
  );
}

/**
 * Where this player stands, and the one control that changes it, at the top
 * of the file. Ban and Unban used to sit halfway down the page behind a
 * header chip that jumped there; the owner went looking for Unban twice
 * (2026-09-26, 2026-10-23). The ban form stays folded until asked for, so a
 * file opened to read is not one Enter away from a ban.
 *
 * A ban whose reason reads "Withheld" came from a restricted ticket the
 * viewer is not on: the server decides that, not this page.
 *
 * A block from the duo queue (owner 2026-11-03) folds the same way beside
 * the ban; they can still queue solo while it lasts.
 */
export function StandingBanner({ d, busy, run, can }: Props) {
  const s = d.sections.standing;
  // Which form is unfolded: the ban's or the duo block's.
  const [open, setOpen] = useState<'ban' | 'duo' | null>(null);
  const [reason, setReason] = useState('');
  const [minutes, setMinutes] = useState('');
  const live = s.penalties.filter((p) => !p.clearedAt).length;

  if (s.activeBan) {
    const b = s.activeBan;
    const abandon = abandonOf(d, b.reason);
    return (
      <div class="file-standing file-standing--banned">
        <div class="file-standing__state">
          <span class="file-standing__label">{b.expiresAt ? 'Banned' : 'Banned permanently'}</span>
          <p>
            <strong>{b.reason}</strong>
            {b.expiresAt && <> · until {fmtTime(b.expiresAt)}</>}
          </p>
          <p class="muted">
            Since {fmtTime(b.createdAt)}{b.createdByName ? ` by ${b.createdByName}` : ''}
            {s.timeout && ` · also on queue timeout until ${fmtTime(s.timeout.until)}`}
          </p>
          <DuoBlockLine d={d} />
        </div>
        {can('ban') && (
          <div class="file-standing__acts">
            <button class="btn" type="button" disabled={busy}
              onClick={() => run(() => adminApi.unban(d.steamid), {
                title: `Unban ${d.header.name}?`,
                body: 'The ban is lifted here and on every game server.',
                confirmLabel: 'Unban',
              })}>Unban</button>
            {s.duoBlock && <LiftDuoBlock d={d} busy={busy} run={run} />}
            {/* Lifting an abandon ban does not give the rating back; staff
                who decide it was not the player's fault do that here too. */}
            {abandon && !abandon.restoredAt && (
              <RestoreRating matchId={abandon.matchId} steamid={abandon.steamid} who={d.header.name} busy={busy} run={run} />
            )}
          </div>
        )}
      </div>
    );
  }

  return (
    <div class={`file-standing${s.timeout ? ' file-standing--timeout' : ''}`}>
      <div class="file-standing__state">
        <span class="file-standing__label">{s.timeout ? 'On queue timeout' : 'Not banned'}</span>
        <p class="muted">
          {s.timeout && <>Until {fmtTime(s.timeout.until)}, {timeoutOffenses(s.timeout)} · </>}
          {s.bans.length === 0 ? 'No bans before' : `${s.bans.length} past ban${s.bans.length === 1 ? '' : 's'}`}
          {' · '}{live === 0 ? 'no open penalties' : `${live} open penalt${live === 1 ? 'y' : 'ies'}`}
        </p>
        <DuoBlockLine d={d} />
      </div>
      {can('ban') && (open ? (
        <form class="file-standing__ban" onSubmit={(e) => {
          e.preventDefault();
          const why = reason.trim();
          const mins = minutes ? Number(minutes) : null;
          void (open === 'ban'
            ? run(() => adminApi.ban(d.steamid, why, mins), {
              title: `Ban ${d.header.name}?`,
              body: why
                ? `They are banned here and kicked from every game server. They will be shown: "${why}"`
                : 'They are banned here and kicked from every game server.',
              confirmLabel: 'Ban',
              danger: true,
            })
            : run(() => adminApi.duoBlock(d.steamid, why, mins), {
              title: `Block ${d.header.name} from duo queue?`,
              body: 'They cannot send or accept duo invites, and a duo they are in ends now. They can still queue solo.',
              confirmLabel: 'Block from duo',
              danger: true,
            })).then(() => { setReason(''); setMinutes(''); setOpen(null); });
        }}>
          <input value={reason} placeholder={open === 'ban' ? 'Reason (shown to them)' : 'Reason (staff only)'}
            aria-label={open === 'ban' ? 'Ban reason' : 'Duo block reason'} autoFocus
            onInput={(e) => setReason((e.target as HTMLInputElement).value)} />
          <select value={minutes} aria-label={open === 'ban' ? 'Ban length' : 'Duo block length'}
            onChange={(e) => setMinutes((e.target as HTMLSelectElement).value)}>
            {BAN_LENGTHS.map(([m, label]) => <option key={label} value={m === null ? '' : String(m)}>{label}</option>)}
          </select>
          <button class="btn" type="submit" disabled={busy || !reason.trim()}>{open === 'ban' ? 'Ban' : 'Block from duo'}</button>
          <button class="chip" type="button" onClick={() => setOpen(null)}>Cancel</button>
        </form>
      ) : (
        <div class="file-standing__acts">
          {/* The timeout's own control sits beside it, as Unban does for a
              ban: the owner went looking for it on 2026-10-28 and found only
              the Penalties list further down. It clears what is keeping
              them out right now; the per-row Clear below is for one offense. */}
          {s.timeout && can('timeout') && (
            <button class="btn" type="button" disabled={busy}
              onClick={() => run(() => adminApi.liftTimeout(d.steamid), {
                title: `Lift ${d.header.name}'s queue timeout?`,
                body: `They can queue again at once. The ${timeoutOffenses(s.timeout!)} for ${timeoutCause(s.timeout!.kind)} behind it are cleared; anything outside the penalty window stays on the record.`,
                confirmLabel: 'Lift timeout',
              })}>Lift timeout</button>
          )}
          <button class="btn btn--ghost file-standing__open" type="button" onClick={() => setOpen('ban')}>Ban this player</button>
          {s.duoBlock
            ? <LiftDuoBlock d={d} busy={busy} run={run} />
            : <button class="btn btn--ghost" type="button" onClick={() => setOpen('duo')}>Block from duo</button>}
        </div>
      ))}
    </div>
  );
}

/** A ban's state in one word, for its pill. */
function banState(b: { liftedAt: string | null; expiresAt: string | null }): 'lifted' | 'expired' | 'active' {
  if (b.liftedAt) return 'lifted';
  if (b.expiresAt && Date.parse(b.expiresAt) < Date.now()) return 'expired';
  return 'active';
}

/** The record behind the banner: past bans, abandons, Discord sanctions and
 *  penalties, each row with what can still be done about it. */
export function StandingSection({ d, busy, run, can }: Props) {
  const s = d.sections.standing;
  const abandons = s.abandons ?? [];
  const discord = s.discordSanctions ?? [];
  const live = s.penalties.filter((p) => !p.clearedAt).length;

  return (
    <Panel class="file-section">
      <h3 id="standing">Bans and penalties</h3>

      <h4>Bans <span class="file-count">{s.bans.length}</span></h4>
      {s.bans.length === 0 ? <p class="muted">None.</p> : (
        <ul class="file-rows">
          {s.bans.map((b) => {
            const state = banState(b);
            const a = abandonOf(d, b.reason);
            return (
              <li key={b.id} class={`file-row${state === 'active' ? '' : ' is-past'}`}>
                <div class="file-row__main">
                  <strong>{b.reason}</strong>
                  <span class={`file-pill file-pill--${state}`}>{state}</span>
                </div>
                <div class="file-row__meta">
                  {fmtTime(b.createdAt)} · {b.expiresAt ? `until ${fmtTime(b.expiresAt)}` : 'permanent'}
                  {b.liftedAt && `, lifted ${fmtTime(b.liftedAt)}${b.liftedByName ? ` by ${b.liftedByName}` : ''}`}
                  {a?.restoredAt ? restoredText(a) : ''}
                </div>
              </li>
            );
          })}
        </ul>
      )}

      {abandons.length > 0 && (
        <>
          <h4>Abandons <span class="file-count">{abandons.length}</span></h4>
          <p class="file-help">Every abandon costs a rating loss. Restore it only when the abandon was not their fault.</p>
          <ul class="file-rows">
            {abandons.map((a) => (
              <li key={a.matchId} class="file-row file-row--split">
                <div>
                  <span><a href={`/match/${a.matchId}`}>#{a.matchId}</a>: {abandonOutcome(a)}</span>
                  {a.restoredAt && <div class="file-row__meta">{restoredText(a).replace(/^ · /, '')}</div>}
                </div>
                {!a.restoredAt && can('ban') && (
                  <RestoreRating matchId={a.matchId} steamid={a.steamid} who={d.header.name} busy={busy} run={run} />
                )}
              </li>
            ))}
          </ul>
        </>
      )}

      {discord.length > 0 && (
        <>
          <h4>Discord <span class="file-count">{discord.length}</span></h4>
          <ul class="file-rows">
            {discord.map((x) => <li key={x.id} class="file-row">{sanctionText(x)}</li>)}
          </ul>
        </>
      )}

      <h4>
        Penalties <span class="file-count">{live === s.penalties.length ? live : `${live} of ${s.penalties.length}`}</span>
        {s.timeout && <span class="file-pill file-pill--active">timeout until {fmtTime(s.timeout.until)} ({timeoutOffenses(s.timeout)})</span>}
      </h4>
      {s.penalties.length === 0 ? <p class="muted">None.</p> : (
        <ul class="file-rows">
          {s.penalties.map((p) => (
            <li key={p.id} class={`file-row file-row--split${p.clearedAt ? ' is-past' : ''}`}>
              <div>
                <span>
                  {p.kind === 'no_show' ? 'No-show' : 'Missed ready check'}
                  {p.matchId && <> on <a href={`/match/${p.matchId}`}>#{p.matchId}</a></>}
                </span>
                <div class="file-row__meta">
                  {fmtTime(p.createdAt)}{p.clearedAt && `, cleared by ${p.clearedBy}`}
                </div>
              </div>
              {/* One row at a time, for the no-show our server caused, without
                  also wiping the ready checks they really did miss. */}
              {!p.clearedAt && can('timeout') && (
                <button class="chip" type="button" disabled={busy}
                  onClick={() => run(() => adminApi.clearPenalty(d.steamid, p.id))}>Clear</button>
              )}
            </li>
          ))}
        </ul>
      )}
      {can('timeout') && live > 1 && (
        <div class="file-foot">
          <button class="chip" type="button" disabled={busy}
            onClick={() => run(() => adminApi.clearPenalties(d.steamid))}>Clear all penalties</button>
        </div>
      )}
    </Panel>
  );
}
