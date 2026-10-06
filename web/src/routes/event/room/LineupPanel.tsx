import { useState } from 'preact/hooks';
import type { MatchRoomView, RoomPlayer } from '../../../api';
import { confirm } from '../../../components/Confirm';

function Four({ name, players, locked }: { name: string; players: RoomPlayer[] | null; locked: boolean }) {
  if (players) return <div class="lineup"><strong>{name}</strong><ul>{players.map((p) => <li key={p.steamid}>{p.name}</li>)}</ul></div>;
  return <p class="lineup lineup--hidden">{`${name}: ${locked ? 'locked' : 'picking'}`}</p>;
}

/** A manager whose team has not locked picks exactly four; everyone else
 *  sees each team's four once shown, or locked / picking. */
export function LineupPanel({ v, busy, onLock }: { v: MatchRoomView; busy: boolean; onLock: (steamids: string[]) => Promise<void> }) {
  const me = v.me;
  const myLocked = me ? (me.side === 'a' ? v.lineups.aLocked : v.lineups.bLocked) : true;
  const picking = v.phase === 'lineup' && me?.manager === true && !myLocked;
  // The saved default four counts only for players still on the roster.
  const [chosen, setChosen] = useState<string[]>(() => (me?.defaultFour ?? []).filter((s) => me!.playable.some((p) => p.steamid === s)));
  const toggle = (s: string) => setChosen((c) => (c.includes(s) ? c.filter((x) => x !== s) : [...c, s]));
  const myName = (me?.side === 'b' ? v.b?.name : v.a?.name) ?? 'TBD';
  // Sent in roster order, not click order, so locking the same four always
  // sends the same steamids regardless of which boxes were toggled last.
  const ordered = () => (me?.playable ?? []).filter((p) => chosen.includes(p.steamid)).map((p) => p.steamid);
  const lock = async () => {
    if (!await confirm({ title: `Lock ${myName}' lineup?`, body: 'You cannot change it for this match.', confirmLabel: 'Lock lineup' })) return;
    await onLock(ordered());
  };
  return (
    <section class="lineups" aria-label="Lineups">
      {picking && me && (
        <div class="lineup lineup--pick">
          <p>{`Pick your four (${chosen.length} of 4)`}</p>
          {me.playable.map((p) => (
            <label key={p.steamid}>
              <input type="checkbox" aria-label={p.name} checked={chosen.includes(p.steamid)} onChange={() => toggle(p.steamid)} /> {p.name}
            </label>
          ))}
          <button class="btn" type="button" disabled={busy || chosen.length !== 4} onClick={() => { void lock(); }}>Lock lineup</button>
        </div>
      )}
      <Four name={v.a?.name ?? 'TBD'} players={v.lineups.a} locked={v.lineups.aLocked} />
      <Four name={v.b?.name ?? 'TBD'} players={v.lineups.b} locked={v.lineups.bLocked} />
    </section>
  );
}
