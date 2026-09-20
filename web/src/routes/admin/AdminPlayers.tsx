import { useState } from 'preact/hooks';
import { adminApi, type AdminPlayerDetail, type MergePlan } from '../../api';
import { useFetch } from '../../hooks/useFetch';
import { campaignName } from '../../format';
import { Empty, Panel } from '../../components/bits';
import { fmtTime, useAction } from './useAction';

export function AdminPlayers({ me }: { me: string }) {
  const [q, setQ] = useState('');
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<string | null>(null);
  const list = useFetch((s) => adminApi.players(query, s), [query]);

  return (
    <div class="admin-split">
      <Panel class="panel--table">
        <form class="admin-search" onSubmit={(e) => { e.preventDefault(); setQuery(q.trim()); }}>
          <input value={q} placeholder="Name, SteamID or Discord" aria-label="Search players"
            onInput={(e) => setQ((e.target as HTMLInputElement).value)} />
          <button class="btn" type="submit">Search</button>
        </form>
        {list.data && list.data.players.length === 0 && <Empty>No players match.</Empty>}
        {list.data && list.data.players.length > 0 && (
          <div class="table-wrap">
            <table class="admin-table">
              <thead>
                <tr><th>Player</th><th>Status</th><th class="num">SR</th><th class="num">Games</th><th>Discord</th><th class="num">Offenses</th></tr>
              </thead>
              <tbody>
                {list.data.players.map((p) => (
                  <tr key={p.steamid} class={`is-clickable${selected === p.steamid ? ' is-me' : ''}`} onClick={() => setSelected(p.steamid)}>
                    <td>{p.name}{p.isAdmin && <span class="admin-tag">admin</span>}</td>
                    <td><span class={`admin-status admin-status--${p.status}`}>{p.status}</span></td>
                    <td class="num">{p.sr ?? <span class="muted">n/a</span>}</td>
                    <td class="num">{p.games}</td>
                    <td>{p.discordName ?? <span class="muted">not linked</span>}</td>
                    <td class={`num${p.offenses ? ' admin-warn' : ' muted'}`}>{p.offenses}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>
      {selected ? <PlayerDetail steamid={selected} me={me} onChanged={list.reload} /> : (
        <Panel><Empty>Pick a player to see their history and act on them.</Empty></Panel>
      )}
    </div>
  );
}

function PlayerDetail({ steamid, me, onChanged }: { steamid: string; me: string; onChanged: () => void }) {
  const { data, reload } = useFetch((s) => adminApi.player(steamid, s), [steamid]);
  const { busy, error, run } = useAction(() => { reload(); onChanged(); });
  const [reason, setReason] = useState('');
  const [minutes, setMinutes] = useState('');
  const [note, setNote] = useState('');

  if (!data) return <Panel><p class="muted">Loading...</p></Panel>;
  const d: AdminPlayerDetail = data;
  const self = d.steamid === me;

  return (
    <Panel class="admin-detail">
      <div class="admin-detail__head">
        <div>
          <h3><a href={`/player/${d.steamid}`}>{d.name}</a></h3>
          <p class="muted mono">{d.steamid}</p>
          <p class="muted">
            {d.status}{d.isAdmin ? ' · admin' : ''} · SR {d.sr ?? 'n/a'} · {d.games} games · joined {fmtTime(d.createdAt)}
            <br />Discord: {d.discordName ?? 'not linked'}
            <br />Connect drops:{' '}
            {d.signonDrops.count === 0 ? 'none' : (
              <a href="#connect-drops" class="admin-warn">
                {d.signonDrops.count}, last {fmtTime(d.signonDrops.lastAt)}
              </a>
            )}
          </p>
        </div>
      </div>

      {error && <p class="error">{error}</p>}

      <div class="admin-actions">
        {d.status === 'invited' && <button class="chip" disabled={busy} onClick={() => run(() => adminApi.activate(d.steamid))}>Activate</button>}
        {!self && (
          <button class="chip" disabled={busy}
            onClick={() => run(() => adminApi.setAdmin(d.steamid, !d.isAdmin), d.isAdmin ? `Remove admin from ${d.name}?` : `Make ${d.name} an admin?`)}>
            {d.isAdmin ? 'Remove admin' : 'Make admin'}
          </button>
        )}
        {d.discordName && <button class="chip" disabled={busy} onClick={() => run(() => adminApi.unlinkDiscord(d.steamid), `Unlink ${d.name}'s Discord?`)}>Unlink Discord</button>}
        {d.timeout && <button class="chip" disabled={busy} onClick={() => run(() => adminApi.clearPenalties(d.steamid))}>Clear penalties</button>}
      </div>

      <MergeSection d={d} busy={busy} run={run} />

      <section>
        <h4>Ban</h4>
        {d.activeBan ? (
          <div class="admin-ban">
            <p>
              Banned by {d.activeBan.createdByName ?? d.activeBan.createdBy} on {fmtTime(d.activeBan.createdAt)}: <strong>{d.activeBan.reason}</strong>
              {d.activeBan.expiresAt ? `, until ${fmtTime(d.activeBan.expiresAt)}` : ', permanently'}.
            </p>
            <button class="btn btn--ghost" disabled={busy} onClick={() => run(() => adminApi.unban(d.steamid), `Unban ${d.name}?`)}>Unban</button>
          </div>
        ) : self ? <p class="muted">You cannot ban yourself.</p> : (
          <form class="admin-form" onSubmit={(e) => {
            e.preventDefault();
            void run(() => adminApi.ban(d.steamid, reason, minutes ? Number(minutes) : null), `Ban ${d.name}?`).then(() => { setReason(''); setMinutes(''); });
          }}>
            <input value={reason} placeholder="Reason (shown to them)" aria-label="Ban reason" onInput={(e) => setReason((e.target as HTMLInputElement).value)} />
            <select value={minutes} aria-label="Ban length" onChange={(e) => setMinutes((e.target as HTMLSelectElement).value)}>
              <option value="">Permanent</option>
              <option value="60">1 hour</option>
              <option value="1440">1 day</option>
              <option value="10080">1 week</option>
              <option value="43200">30 days</option>
            </select>
            <button class="btn" type="submit" disabled={busy || !reason.trim()}>Ban</button>
          </form>
        )}
        {d.bans.length > 0 && (
          <ul class="admin-list">
            {d.bans.map((b) => (
              <li key={b.id}>
                {fmtTime(b.createdAt)}: {b.reason} ({b.expiresAt ? `until ${fmtTime(b.expiresAt)}` : 'permanent'})
                {b.liftedAt && <span class="muted">, lifted by {b.liftedByName ?? b.liftedBy} {fmtTime(b.liftedAt)}</span>}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section>
        <h4>Penalties {d.timeout && <span class="admin-warn">on timeout until {fmtTime(d.timeout.until)}</span>}</h4>
        {d.penalties.length === 0 ? <p class="muted">None.</p> : (
          <ul class="admin-list">
            {d.penalties.map((p) => (
              <li key={p.id} class={p.clearedAt ? 'muted' : ''}>
                {fmtTime(p.createdAt)}: {p.kind === 'no_show' ? 'No-show' : 'Missed ready check'}
                {p.matchId && <> on <a href={`/match/${p.matchId}`}>#{p.matchId}</a></>}
                {p.clearedAt && `, cleared by ${p.clearedBy}`}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section>
        <h4>Reports against</h4>
        {d.reportsAgainst.length === 0 ? <p class="muted">None.</p> : (
          <ul class="admin-list">
            {d.reportsAgainst.map((r) => (
              <li key={r.id}>
                {fmtTime(r.createdAt)} · {r.category} by {r.reporterName ?? r.reporterId} in <a href={`/match/${r.matchId}`}>#{r.matchId}</a> · {r.status}
                {r.text && <div class="muted">{r.text}</div>}
              </li>
            ))}
          </ul>
        )}
      </section>

      {d.signonDrops.count > 0 && (
        <section id="connect-drops">
          <h4>Connect drops</h4>
          <p class="muted">
            Left while still loading in, on a map that was enforcing file consistency. Usually a rejected
            modified file (the player saw its name on their screen; the server never does), sometimes
            just a cancelled loading screen. <a href="/help/consistency">What players are told</a>.
          </p>
          <ul class="admin-list">
            {d.signonDrops.rows.map((r) => (
              <li key={r.id}>
                {fmtTime(r.at)}: as {r.name}, {r.secsConnected < 0 ? 'time unknown' : `after ${r.secsConnected} s`}, {r.forcedCount} files enforced
                {r.enteredAfterAt
                  ? <span class="muted"> · got in {fmtTime(r.enteredAfterAt)}</span>
                  : <span class="admin-warn"> · has not got in since</span>}
              </li>
            ))}
          </ul>
        </section>
      )}

      <section>
        <h4>Notes</h4>
        <form class="admin-form" onSubmit={(e) => { e.preventDefault(); void run(() => adminApi.note(d.steamid, note)).then(() => setNote('')); }}>
          <input value={note} placeholder="Private admin note" aria-label="Note" onInput={(e) => setNote((e.target as HTMLInputElement).value)} />
          <button class="btn" type="submit" disabled={busy || !note.trim()}>Add</button>
        </form>
        <ul class="admin-list">
          {d.notes.map((n) => <li key={n.id}><span class="muted">{n.authorName ?? n.authorId}, {fmtTime(n.createdAt)}:</span> {n.text}</li>)}
        </ul>
      </section>

      <section>
        <h4>Recent matches</h4>
        {d.matches.length === 0 ? <p class="muted">None.</p> : (
          <ul class="admin-list">
            {d.matches.map((m) => (
              <li key={m.id}>
                <a href={`/match/${m.id}`}>#{m.id}</a> {campaignName(m.campaign)} · {m.state} · team {m.team.toUpperCase()}
                {m.state === 'aborted' && !m.connectedAt && <span class="admin-warn"> · never connected</span>}
              </li>
            ))}
          </ul>
        )}
      </section>
    </Panel>
  );
}


/**
 * Fold this account into another one, and undo a fold.
 *
 * Preview first, always. A merge rewrites rating history for everyone who
 * played in the affected matches, not just these two accounts, because
 * ratings are sequential: correcting a roster four matches back changes every
 * rating computed since. The plan is shown before the commit button appears,
 * so nobody finds that out afterwards.
 */
function MergeSection(
  { d, busy, run }: {
    d: AdminPlayerDetail;
    busy: boolean;
    run: (fn: () => Promise<unknown>, confirmText?: string) => Promise<void>;
  },
) {
  const [into, setInto] = useState('');
  const [plan, setPlan] = useState<MergePlan | null>(null);
  const [planError, setPlanError] = useState('');

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

  const aliases = d.aliases ?? [];
  const shared = d.sharesAddressWith ?? [];
  const networks = d.networks ?? [];
  const countries = [...new Set(networks.map((n) => n.country).filter(Boolean))];

  return (
    <section>
      <h4>Identity</h4>

      {(shared.length > 0 || countries.length > 0) && (
        <div class="admin-shared">
          {countries.length > 0 && (
            <p class="muted">
              Connects from {countries.join(', ')}
              {networks.length > 1 ? ` · ${networks.length} connections seen` : ''}
            </p>
          )}
          {shared.length > 0 && (
            <>
              <p>
                <strong>Seen on the same connection as:</strong>
              </p>
              <ul>
                {shared.map((o) => (
                  <li key={o.steamid}>
                    <a href={`/player/${o.steamid}`}>{o.name}</a>{' '}
                    <code>{o.steamid}</code>{' '}
                    <span class="muted">
                      {o.seenCount} {o.seenCount === 1 ? 'connect' : 'connects'}
                      {o.country ? `, ${o.country}` : ''}, last {fmtTime(o.lastSeen)}
                    </span>
                  </li>
                ))}
              </ul>
              {/* Said plainly, because the merge button is right below it and
                  the cost of acting on a false match is a season recompute. */}
              <p class="muted">
                A shared connection is not proof. A VPN, a household, a LAN cafe and two
                siblings all look like this. Check it against how they play before merging.
              </p>
            </>
          )}
        </div>
      )}
      {aliases.length > 0 && (
        <div class="admin-aliases">
          <p class="muted">Accounts merged into this one:</p>
          <ul>
            {aliases.map((a) => (
              <li key={a.steamid}>
                <code>{a.steamid}</code> <span class="muted">since {fmtTime(a.created_at)}</span>{' '}
                <button
                  class="chip" type="button" disabled={busy}
                  onClick={() => run(
                    () => adminApi.unaliasPlayer(a.steamid),
                    `Stop treating ${a.steamid} as ${d.name}? Their past matches stay merged; the account is just free to be its own identity again.`,
                  )}
                >Separate</button>
              </li>
            ))}
          </ul>
        </div>
      )}

      <p class="muted">
        Merge this account into another, for one person playing on two Steam accounts.
        <strong> {d.name} disappears</strong> and everything they did moves to the account you name.
      </p>
      <form class="admin-merge" onSubmit={(e) => { e.preventDefault(); void preview(); }}>
        <input
          value={into} placeholder="SteamID64 to keep"
          onInput={(e) => { setInto((e.target as HTMLInputElement).value); setPlan(null); }}
        />
        <button class="btn" type="submit" disabled={busy || !/^\d{17}$/.test(into.trim())}>Preview</button>
      </form>

      {planError && <p class="error">{planError}</p>}
      {plan && (
        <div class="admin-merge__plan">
          <p>
            <strong>{plan.matchesMoved}</strong> matches move, <strong>{plan.matchesCollapsed}</strong> of
            them had both accounts rostered and will be added together.
          </p>
          <p class="muted">
            Season {plan.seasons.join(', ')} will be recomputed, which changes the rating of
            everyone who played in those matches, not only these two accounts. There is no undo.
          </p>
          <ul class="muted">
            {Object.entries(plan.rowsByTable).sort().map(([t, n]) => <li key={t}><code>{t}</code> {n}</li>)}
          </ul>
          <button
            class="btn" type="button" disabled={busy}
            onClick={() => run(
              () => adminApi.mergePlayer(d.steamid, into.trim()),
              `Merge ${d.name} into ${into.trim()} and recompute season ${plan.seasons.join(', ')}? This cannot be undone.`,
            )}
          >Merge and recompute</button>
        </div>
      )}
    </section>
  );
}
