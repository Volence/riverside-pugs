import { useState } from 'preact/hooks';
import { peopleApi, type AltCluster, type AltHold, type AltSignal } from '../../api';
import { countryName } from '../../countries';
import { useFetch } from '../../hooks/useFetch';
import { Empty, Panel } from '../../components/bits';
import { fmtTime, useAction } from './useAction';
import { fmtAgo } from '../../format';
import { fileUrl } from './adminRoutes';
import { KnownEvaders } from './KnownEvaders';
import { SIGN_TEXT, type SecondSign } from '../../../../src/fingerprint';

const SIGNAL_LABEL: Record<AltSignal, string> = {
  discord: 'Discord moved',
  merged: 'merged',
  lender: 'Family Sharing',
  connection: 'same connection',
};

const RESOLUTION_LABEL = { cleared: 'lifted', banned: 'banned', merged: 'merged' } as const;

const signText = (s: string): string => SIGN_TEXT[s as SecondSign] ?? s;

/**
 * Alts: every second account the site knows about, in one place.
 *
 * Open holds sit on top. A hold is placed by itself when a Discord account
 * arrives from a different Steam account, and the held account cannot queue
 * or play until someone here lifts it (owner ruling 2026-10-03: the player
 * appeals, a moderator lets them back in). Below that, every group of
 * accounts tied together by anything: a Discord moving, a merge, a borrowed
 * copy of the game, or a shared connection. A shared connection on its own
 * is a household as often as it is an alt, so those groups are marked weak.
 */
export function PeopleAlts({ isAdmin }: { isAdmin: boolean }) {
  const { data, error: loadError, reload } = useFetch((s) => peopleApi.alts(s), []);
  const { busy, error, run } = useAction(reload);
  const [showWeak, setShowWeak] = useState(false);

  const clusters = data?.clusters ?? [];
  const weak = clusters.filter((c) => !c.strong).length;
  const shown = showWeak ? clusters : clusters.filter((c) => c.strong);

  const lift = (h: AltHold) => run(() => peopleApi.liftHold(h.id), {
    title: `Lift the hold on ${h.name}?`,
    body: 'They can queue and play again straight away, and this pair of accounts is never held again.',
    confirmLabel: 'Lift hold',
  });
  const ban = (h: AltHold) => run(() => peopleApi.banFromHold(h.id, ''), {
    title: `Ban ${h.name} as an alt of ${h.otherName}?`,
    body: 'A permanent ban, shown on the public ban list with the reason "Alt account of '
      + `${h.otherName}". The hold is closed.`,
    confirmLabel: 'Ban',
    danger: true,
  });

  const banSame = (h: AltHold) => run(() => peopleApi.banHoldSamePerson(h.id), {
    title: `Ban ${h.name} as ${h.personLabel ?? 'the known evader'}?`,
    body: `A permanent ban, shown on the public ban list as ban evasion. ${h.name} and their Discord join `
      + `${h.personLabel ?? 'that person'}'s record, so their connections are watched and their presses join the fingerprint. The hold is closed.`,
    confirmLabel: 'Ban as same person',
    danger: true,
  });

  return (
    <>
      {/* What needs a decision first; the standing records under it. */}
      <Panel class={`panel--table alts-hold${data && data.open.length > 0 ? ' has-holds' : ''}`}>
        <h3>On hold{data && <span class="alts-count">{data.open.length}</span>}</h3>
        <p class="muted">
          Held because their Discord account came from another Steam account, or because they hold infected
          buttons like a known evader and a second sign fired (marked fingerprint). They cannot queue or play, and
          the hold is not on the public ban list. Lift it once they have explained, or ban it if it is an alt.
        </p>
        {error && <p class="error">{error}</p>}
        {loadError && <Empty>Could not load the alts.</Empty>}
        {data && data.open.length === 0 && <Empty>Nobody is on hold.</Empty>}
        {data && data.open.length > 0 && (
          <div class="table-wrap">
            <table class="admin-table">
              <thead>
                <tr><th>Held account</th><th>Why</th><th>Discord</th><th>Held</th><th /></tr>
              </thead>
              <tbody>
                {data.open.map((h) => (
                  <tr key={h.id}>
                    <td><a href={fileUrl(h.steamid)}>{h.name}</a><div class="mono muted">{h.steamid}</div></td>
                    <td>
                      {h.source === 'fingerprint' ? (
                        <>
                          <span class="chip">fingerprint</span> plays like <strong>{h.personLabel ?? 'a known evader'}</strong>,
                          nearest account <a href={fileUrl(h.otherSteamid)}>{h.otherName}</a>
                          {h.otherBanned && <> <span class="admin-status admin-status--banned">banned</span></>}
                          {h.fingerprint && (
                            <div class="muted">
                              #{h.fingerprint.rank} nearest, distance {h.fingerprint.distance.toFixed(3)} (limit {h.fingerprint.threshold.toFixed(3)})
                              {h.fingerprint.signs.length > 0 ? `; ${h.fingerprint.signs.map(signText).join(', ')}` : ''}
                            </div>
                          )}
                        </>
                      ) : (
                        <>
                          Discord came from <a href={fileUrl(h.otherSteamid)}>{h.otherName}</a>
                          {h.otherBanned && <> <span class="admin-status admin-status--banned">banned</span></>}
                          <div class="mono muted">{h.otherSteamid}</div>
                        </>
                      )}
                    </td>
                    <td>{h.discordName || h.discordId}</td>
                    <td class="muted" title={fmtTime(h.createdAt)}>{fmtAgo(h.createdAt)}</td>
                    <td>
                      <div class="alts-acts">
                        <button class="btn" disabled={busy} onClick={() => lift(h)}>Lift hold</button>
                        {isAdmin && (h.source === 'fingerprint'
                          ? <button class="btn btn--danger" disabled={busy} onClick={() => banSame(h)}>Ban as same person</button>
                          : <button class="btn btn--danger" disabled={busy} onClick={() => ban(h)}>Ban</button>)}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {data && data.settled.length > 0 && (
          <details>
            <summary>Settled holds ({data.settled.length})</summary>
            <ul class="admin-list">
              {data.settled.map((h) => (
                <li key={h.id}>
                  <a href={fileUrl(h.steamid)}>{h.name}</a> (from <a href={fileUrl(h.otherSteamid)}>{h.otherName}</a>){' '}
                  <span class="muted">
                    {h.resolution ? RESOLUTION_LABEL[h.resolution] : 'settled'} {fmtTime(h.resolvedAt)}
                    {h.resolvedByName ? ` by ${h.resolvedByName}` : ''}
                  </span>
                </li>
              ))}
            </ul>
          </details>
        )}
      </Panel>

      <KnownEvaders isAdmin={isAdmin} />

      <Panel>
        <h3>Related accounts{data && <span class="alts-count">{shown.length}</span>}</h3>
        <p class="muted">
          Accounts tied together by a Discord moving between them, a merge, or a copy of the game lent through
          Family Sharing. A shared connection alone is evidence, not proof: households, siblings and VPNs look
          the same.
        </p>
        {weak > 0 && (
          <label class="admin-check">
            <input type="checkbox" checked={showWeak} onChange={(e) => setShowWeak((e.target as HTMLInputElement).checked)} />
            {' '}Also show {weak} group{weak === 1 ? '' : 's'} tied only by a shared connection
          </label>
        )}
        {data && shown.length === 0 && <Empty>No related accounts.</Empty>}
        {shown.length > 0 && (
          <div class="alts-clusters">
            {shown.map((c) => <ClusterCard key={c.members.map((m) => m.steamid).join()} c={c} />)}
          </div>
        )}
      </Panel>

      <IpWatchPanel />
    </>
  );
}

function ClusterCard({ c }: { c: AltCluster }) {
  const name = new Map(c.members.map((m) => [m.steamid, m.name]));
  return (
    <div class={`admin-cluster${c.strong ? '' : ' is-weak'}`}>
      <p class="admin-cluster__members">
        {c.members.map((m, i) => (
          <span key={m.steamid}>
            <a href={fileUrl(m.steamid)}>{m.name}</a>
            {m.held && <> <span class="chip">on hold</span></>}
            {m.banned && <> <span class="admin-status admin-status--banned">banned</span></>}
          </span>
        ))}
        {!c.strong && <span class="muted">shared connection only</span>}
      </p>
      <ul class="admin-list muted">
        {c.edges.map((e, i) => (
          <li key={i}>
            <span class={`alts-signal alts-signal--${e.signal}`}>{SIGNAL_LABEL[e.signal]}</span>{' '}
            {name.get(e.a)} and {name.get(e.b)}
            {e.detail && e.detail !== SIGNAL_LABEL[e.signal] ? ` (${e.detail})` : ''}
            {e.at ? `, ${fmtTime(e.at)}` : ''}
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * The IP watch list (src/ipWatch.ts). A known evader's connections are
 * watched, and any other account turning up on one pings the mod call role.
 * Staff can also watch an address by hand; it is hashed on arrival and never
 * kept, so the list shows a short fingerprint, not the address.
 */
function IpWatchPanel() {
  const { data, error: loadError, reload } = useFetch((s) => peopleApi.ipWatch(s), []);
  const { busy, error, run } = useAction(reload);
  const [ip, setIp] = useState('');
  const [note, setNote] = useState('');

  const add = () => run(async () => {
    await peopleApi.watchIp(ip.trim(), note.trim());
    setIp('');
    setNote('');
  });

  return (
    <Panel class="panel--table">
      <h3>IP watch list</h3>
      <p class="muted">
        Every connection a known evader's account uses is watched, including new ones (add an account to a person
        from the Identity section of its file, or on the Known evaders card). Any other account connecting from a
        watched connection pings the mod role in the mod channel. Separately, any account sharing a connection with
        a banned account gets a plain alert. Nothing here bans or holds anyone.
      </p>
      {error && <p class="error">{error}</p>}
      {loadError && <Empty>Could not load the watch list.</Empty>}

      {data && data.entries.length === 0 && <Empty>No connections are being watched.</Empty>}
      {data && data.entries.length > 0 && (
        <div class="table-wrap">
          <table class="admin-table">
            <thead>
              <tr><th>Connection</th><th>Watched for</th><th>Accounts seen there</th><th /></tr>
            </thead>
            <tbody>
              {data.entries.map((w) => (
                <tr key={w.ipHash}>
                  <td>
                    <span class="mono">{w.ipHash.slice(0, 10)}</span>
                    {w.country && <div class="muted">{countryName(w.country)}</div>}
                  </td>
                  <td>
                    {w.steamid ? <>Evader <a href={fileUrl(w.steamid)}>{w.name ?? w.steamid}</a></> : 'Added by hand'}
                    {w.note && <div>{w.note}</div>}
                    <div class="muted">{fmtTime(w.createdAt)}{w.createdByName ? ` by ${w.createdByName}` : ''}</div>
                  </td>
                  <td>
                    {w.accounts.length === 0 && <span class="muted">nobody yet</span>}
                    {w.accounts.map((a, i) => (
                      <span key={a.steamid}>
                        {i > 0 && ' · '}
                        <a href={fileUrl(a.steamid)}>{a.name}</a>
                        {a.banned && <> <span class="admin-status admin-status--banned">banned</span></>}
                        {a.flagged && <> <span class="chip">flagged</span></>}
                      </span>
                    ))}
                  </td>
                  <td>
                    <button class="chip" type="button" disabled={busy}
                      onClick={() => run(() => peopleApi.unwatchIp(w.ipHash), 'Stop watching this connection?')}>Remove</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <h4>Watch an address by hand</h4>
      <form class="admin-merge" onSubmit={(e) => { e.preventDefault(); void add(); }}>
        <input value={ip} placeholder="IPv4 address" aria-label="Address to watch"
          onInput={(e) => setIp((e.target as HTMLInputElement).value)} />
        <input value={note} placeholder="Note (who, why)" aria-label="Note" maxLength={200}
          onInput={(e) => setNote((e.target as HTMLInputElement).value)} />
        <button class="btn" type="submit" disabled={busy || !/^\d{1,3}(\.\d{1,3}){3}$/.test(ip.trim())}>Watch</button>
      </form>
    </Panel>
  );
}
