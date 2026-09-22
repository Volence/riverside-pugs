import { useState } from 'preact/hooks';
import { adminApi, type FileAction, type PlayerFileData } from '../../../api';
import { Panel } from '../../../components/bits';
import { fmtTime, type Run } from '../useAction';
import { sanctionText } from '../AdminTicket';

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
            </li>
          ))}
        </ul>
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
        {s.timeout && <span class="admin-warn"> on timeout until {fmtTime(s.timeout.until)}</span>}
      </h4>
      {s.penalties.length === 0 ? <p class="muted">None.</p> : (
        <ul class="admin-list">
          {s.penalties.map((p) => (
            <li key={p.id} class={p.clearedAt ? 'muted' : ''}>
              {fmtTime(p.createdAt)}: {p.kind === 'no_show' ? 'No-show' : 'Missed ready check'}
              {p.matchId && <> on <a href={`/match/${p.matchId}`}>#{p.matchId}</a></>}
              {p.clearedAt && `, cleared by ${p.clearedBy}`}
            </li>
          ))}
        </ul>
      )}
      {can('timeout') && s.penalties.some((p) => !p.clearedAt) && (
        <button class="chip" type="button" disabled={busy}
          onClick={() => run(() => adminApi.clearPenalties(d.steamid))}>Clear penalties</button>
      )}
    </Panel>
  );
}
