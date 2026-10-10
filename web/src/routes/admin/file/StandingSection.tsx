import { useState } from 'preact/hooks';
import { adminApi, type FileAction, type PlayerFileData } from '../../../api';
import { Panel } from '../../../components/bits';
import { fmtTime, type Run } from '../useAction';
import { timeoutOffenses } from '../../../format';
import { sanctionText } from '../AdminTicket';
import { RestoreRating, abandonOutcome, restoredText } from '../RestoreRating';

const LENGTHS: [value: string, label: string][] = [
  ['', 'Permanent'], ['60', '1 hour'], ['1440', '1 day'], ['10080', '1 week'], ['43200', '30 days'],
];

/** Bans, penalties and the queue timeout, each with what can be done about
 *  it. A ban whose reason reads "Withheld" came from a restricted ticket the
 *  viewer is not on: the server decides that, not this page. */
export function StandingSection(
  { d, busy, run, can }: { d: PlayerFileData; busy: boolean; run: Run; can: (a: FileAction) => boolean },
) {
  const s = d.sections.standing;
  const [reason, setReason] = useState('');
  const [minutes, setMinutes] = useState('');
  const abandons = s.abandons ?? [];
  // The abandon an "Abandoned match #N" ban was filed for, if it has a record.
  const abandonOfBan = (reason: string) => {
    const m = /^Abandoned match #(\d+)$/.exec(reason);
    return m ? abandons.find((a) => a.matchId === Number(m[1])) ?? null : null;
  };
  const activeAbandon = s.activeBan ? abandonOfBan(s.activeBan.reason) : null;

  return (
    <Panel class="file-section">
      <h3 id="standing">Standing</h3>
      {s.activeBan ? (
        <div class="admin-ban">
          <p>
            Banned {fmtTime(s.activeBan.createdAt)}
            {s.activeBan.createdByName ? ` by ${s.activeBan.createdByName}` : ''}: <strong>{s.activeBan.reason}</strong>
            {s.activeBan.expiresAt ? `, until ${fmtTime(s.activeBan.expiresAt)}` : ', permanently'}.
          </p>
          {can('ban') && (
            <button class="btn btn--ghost" type="button" disabled={busy}
              onClick={() => run(() => adminApi.unban(d.steamid), {
                title: `Unban ${d.header.name}?`,
                body: 'The ban is lifted here and on every game server.',
                confirmLabel: 'Unban',
              })}>Unban</button>
          )}
          {/* Lifting an abandon ban does not give the rating back; staff
              who decide it was not the player's fault do that here too. */}
          {can('ban') && activeAbandon && !activeAbandon.restoredAt && (
            <>{' '}<RestoreRating matchId={activeAbandon.matchId} steamid={activeAbandon.steamid} who={d.header.name} busy={busy} run={run} /></>
          )}
        </div>
      ) : can('ban') ? (
        <form class="admin-form" onSubmit={(e) => {
          e.preventDefault();
          void run(() => adminApi.ban(d.steamid, reason.trim(), minutes ? Number(minutes) : null), {
            title: `Ban ${d.header.name}?`,
            body: reason.trim()
              ? `They are banned here and kicked from every game server. They will be shown: "${reason.trim()}"`
              : 'They are banned here and kicked from every game server.',
            confirmLabel: 'Ban',
            danger: true,
          }).then(() => { setReason(''); setMinutes(''); });
        }}>
          <input value={reason} placeholder="Reason (shown to them)" aria-label="Ban reason"
            onInput={(e) => setReason((e.target as HTMLInputElement).value)} />
          <select value={minutes} aria-label="Ban length" onChange={(e) => setMinutes((e.target as HTMLSelectElement).value)}>
            {LENGTHS.map(([value, label]) => <option key={label} value={value}>{label}</option>)}
          </select>
          <button class="btn" type="submit" disabled={busy || !reason.trim()}>Ban</button>
        </form>
      ) : <p class="muted">Not banned.</p>}

      {s.bans.length > 0 && (
        <ul class="admin-list">
          {s.bans.map((b) => (
            <li key={b.id}>
              {fmtTime(b.createdAt)}: <strong>{b.reason}</strong> ({b.expiresAt ? `until ${fmtTime(b.expiresAt)}` : 'permanent'})
              {b.liftedAt && <span class="muted">, lifted {fmtTime(b.liftedAt)}{b.liftedByName ? ` by ${b.liftedByName}` : ''}</span>}
              {(() => { const a = abandonOfBan(b.reason); return a?.restoredAt ? <span class="muted">{restoredText(a)}</span> : null; })()}
            </li>
          ))}
        </ul>
      )}

      {abandons.length > 0 && (
        <>
          <h4>Abandons</h4>
          <p class="muted">Every abandon costs a rating loss. Restore it only when the abandon was not their fault.</p>
          <ul class="admin-list">
            {abandons.map((a) => (
              <li key={a.matchId}>
                <a href={`/match/${a.matchId}`}>#{a.matchId}</a>: {abandonOutcome(a)}
                {a.restoredAt ? <span class="muted">{restoredText(a)}</span>
                  : can('ban') ? <>{' '}<RestoreRating matchId={a.matchId} steamid={a.steamid} who={d.header.name} busy={busy} run={run} /></> : null}
              </li>
            ))}
          </ul>
        </>
      )}

      {(s.discordSanctions ?? []).length > 0 && (
        <>
          <h4>Discord</h4>
          <ul class="admin-list">
            {s.discordSanctions!.map((x) => <li key={x.id}>{sanctionText(x)}</li>)}
          </ul>
        </>
      )}

      <h4>
        Penalties
        {s.timeout && <span class="admin-warn"> on timeout until {fmtTime(s.timeout.until)} ({timeoutOffenses(s.timeout)})</span>}
      </h4>
      {s.penalties.length === 0 ? <p class="muted">None.</p> : (
        <ul class="admin-list">
          {s.penalties.map((p) => (
            <li key={p.id} class={p.clearedAt ? 'muted' : ''}>
              {fmtTime(p.createdAt)}: {p.kind === 'no_show' ? 'No-show' : 'Missed ready check'}
              {p.matchId && <> on <a href={`/match/${p.matchId}`}>#{p.matchId}</a></>}
              {p.clearedAt && `, cleared by ${p.clearedBy}`}
              {/* One row at a time, for the no-show our server caused, without
                  also wiping the ready checks they really did miss. */}
              {!p.clearedAt && can('timeout') && (
                <>{' '}<button class="chip" type="button" disabled={busy}
                  onClick={() => run(() => adminApi.clearPenalty(d.steamid, p.id))}>Clear</button></>
              )}
            </li>
          ))}
        </ul>
      )}
      {can('timeout') && s.penalties.some((p) => !p.clearedAt) && (
        <button class="chip" type="button" disabled={busy}
          onClick={() => run(() => adminApi.clearPenalties(d.steamid))}>Clear all penalties</button>
      )}
    </Panel>
  );
}
