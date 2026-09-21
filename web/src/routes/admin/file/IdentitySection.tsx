import { useState } from 'preact/hooks';
import { adminApi, type FileAction, type MergePlan, type PlayerFileData } from '../../../api';
import { Panel } from '../../../components/bits';
import { fmtTime, type Run } from '../useAction';
import { fileUrl } from '../adminRoutes';
import { SteamAccountPanel } from '../SteamAccountPanel';

/** Aliases, Discord history, the Steam account and shared connections, then
 *  the merge tool that all of it is evidence for. Moderators see every row
 *  here, network sightings included: the owner ruled on that the same day.
 *  Only the merge form (and, inside SteamAccountPanel, the Steam refresh) is
 *  admin-only.
 *
 *  The Steam account block reuses SteamAccountPanel rather than a second copy
 *  of it: the controller ruled that if that panel is ever retired, every fact
 *  it shows (and "Check now") has to survive here, and the surest way to keep
 *  that true is one component, not two that can drift. */
export function IdentitySection(
  { d, busy, run, can }: { d: PlayerFileData; busy: boolean; run: Run; can: (a: FileAction) => boolean },
) {
  const id = d.sections.identity;
  const [into, setInto] = useState('');
  const [plan, setPlan] = useState<MergePlan | null>(null);
  const [planError, setPlanError] = useState('');
  const countries = [...new Set(id.networks.map((n) => n.country).filter(Boolean))];

  const preview = async () => {
    setPlan(null);
    setPlanError('');
    try {
      const res = await adminApi.mergePlayer(d.steamid, into.trim(), true);
      setPlan(res.plan);
    } catch (err) {
      setPlanError(err instanceof Error ? err.message : 'Could not read that account.');
    }
  };

  return (
    <Panel class="file-section">
      <h3 id="identity">Identity</h3>

      {id.discordHistory.length > 0 && (
        <ul class="admin-list">
          {id.discordHistory.map((h) => (
            <li key={`${h.discordId}-${h.linkedAt}`}>
              {h.discordName || 'unknown'} <code>{h.discordId}</code>{' '}
              <span class="muted">
                {h.linkedBy === 'backfill' ? 'linked before history was kept' : `linked ${fmtTime(h.linkedAt)}`}
                {h.unlinkedAt ? `, unlinked ${fmtTime(h.unlinkedAt)}${h.unlinkedBy === 'merge' ? ' by a merge' : ''}` : ', current'}
              </span>
              {h.others.map((o) => (
                <div key={`${o.steamid}-${o.linkedAt}`} class="muted">
                  This Discord was {o.unlinkedAt ? 'previously' : 'also'} linked to{' '}
                  <a href={fileUrl(o.steamid)}>{o.name ?? o.steamid}</a>
                </div>
              ))}
            </li>
          ))}
        </ul>
      )}

      {countries.length > 0 && (
        <p class="muted">Connects from {countries.join(', ')} · {id.networks.length} connection{id.networks.length === 1 ? '' : 's'} seen</p>
      )}
      {id.sharesAddressWith.length > 0 && (
        <>
          <p><strong>Seen on the same connection as:</strong></p>
          <ul class="admin-list">
            {id.sharesAddressWith.map((o) => (
              <li key={o.steamid}>
                <a href={fileUrl(o.steamid)}>{o.name}</a> <code>{o.steamid}</code>{' '}
                <span class="muted">
                  {o.seenCount} {o.seenCount === 1 ? 'connect' : 'connects'}
                  {o.country ? `, ${o.country}` : ''}, last {fmtTime(o.lastSeen)}
                </span>
              </li>
            ))}
          </ul>
          <p class="muted">
            A shared connection is not proof. A VPN, a household, a LAN cafe and two siblings all
            look like this. Check it against how they play before merging.
          </p>
        </>
      )}

      <SteamAccountPanel
        d={{ steamid: d.steamid, steamAccount: id.steamAccount }}
        busy={busy}
        run={run}
        canRefresh={can('merge')}
        onSelect={(steamid) => { location.href = fileUrl(steamid); }}
      />

      {id.aliases.length > 0 && (
        <ul class="admin-list">
          {id.aliases.map((a) => (
            <li key={a.steamid}>
              Merged in: <code>{a.steamid}</code> <span class="muted">since {fmtTime(a.created_at)}</span>{' '}
              {can('merge') && (
                <button class="chip" type="button" disabled={busy}
                  onClick={() => run(
                    () => adminApi.unaliasPlayer(a.steamid),
                    `Stop treating ${a.steamid} as ${d.header.name}? Their past matches stay merged; the account is just free to be its own identity again.`,
                  )}>Separate</button>
              )}
            </li>
          ))}
        </ul>
      )}

      {can('merge') && (
        <>
          <p class="muted">
            Merge this account into another, for one person playing on two Steam accounts.
            <strong> {d.header.name} disappears</strong> and everything they did moves to the account you name.
          </p>
          <form class="admin-merge" onSubmit={(e) => { e.preventDefault(); void preview(); }}>
            <input value={into} placeholder="SteamID64 to keep" aria-label="Merge into"
              onInput={(e) => { setInto((e.target as HTMLInputElement).value); setPlan(null); }} />
            <button class="btn" type="submit" disabled={busy || !/^\d{17}$/.test(into.trim())}>Preview</button>
          </form>
          {planError && <p class="error">{planError}</p>}
          {plan && (
            <div class="admin-merge__plan">
              <p><strong>{plan.matchesMoved}</strong> matches move, <strong>{plan.matchesCollapsed}</strong> of them had both accounts rostered.</p>
              <p class="muted">
                Season {plan.seasons.join(', ')} will be recomputed, which changes the rating of
                everyone who played in those matches, not only these two accounts. There is no undo.
              </p>
              <button class="btn" type="button" disabled={busy}
                onClick={() => run(
                  () => adminApi.mergePlayer(d.steamid, into.trim()),
                  `Merge ${d.header.name} into ${into.trim()} and recompute season ${plan.seasons.join(', ')}? This cannot be undone.`,
                )}>Merge and recompute</button>
            </div>
          )}
        </>
      )}
    </Panel>
  );
}
