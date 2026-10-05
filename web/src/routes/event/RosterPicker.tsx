import type { EntryRole, EntryRoster, MemberOptionView } from '../../api';

const ROLE_LABEL: Record<EntryRole | 'out', string> = { starter: 'Starter', sub: 'Sub', coach: 'Coach', out: 'Not playing' };

/** A role per player: starter, sub, coach or not playing. The counts live
 *  under the list; the server checks the rest and names who fails. */
export function RosterPicker({ members, roster, maxSubs, onChange }: {
  members: MemberOptionView[]; roster: EntryRoster; maxSubs: number; onChange: (r: EntryRoster) => void;
}) {
  const roleOf = (s: string): EntryRole | 'out' =>
    roster.starters.includes(s) ? 'starter' : roster.subs.includes(s) ? 'sub' : roster.coach === s ? 'coach' : 'out';
  const set = (s: string, role: EntryRole | 'out') => {
    const next: EntryRoster = {
      starters: roster.starters.filter((x) => x !== s), subs: roster.subs.filter((x) => x !== s), coach: roster.coach === s ? null : roster.coach,
    };
    if (role === 'starter') next.starters.push(s);
    if (role === 'sub') next.subs.push(s);
    if (role === 'coach') next.coach = s;
    onChange(next);
  };
  return (
    <div class="rosterpick">
      <ul class="rosterpick__list">
        {members.map((m) => (
          <li key={m.steamid} class={`rosterpick__row${m.problems.length || m.elsewhere ? ' rosterpick__row--warn' : ''}`}>
            <span class="rosterpick__name">{m.name}</span>
            <select aria-label={`Role for ${m.name}`} value={roleOf(m.steamid)} onChange={(e) => set(m.steamid, (e.target as HTMLSelectElement).value as EntryRole | 'out')}>
              {(['starter', 'sub', 'coach', 'out'] as const).map((r) => <option key={r} value={r}>{ROLE_LABEL[r]}</option>)}
            </select>
            {m.elsewhere && <span class="rosterpick__why">Already on {m.elsewhere}'s roster</span>}
            {m.problems.map((p) => <span key={p} class="rosterpick__why">{p}</span>)}
          </li>
        ))}
      </ul>
      <p class="muted">{roster.starters.length} of 4 starters · {roster.subs.length} of {maxSubs} subs · {roster.coach ? '1 coach' : 'no coach'}</p>
    </div>
  );
}

/** The first four members start, the rest sit out until picked. */
export function defaultRoster(members: MemberOptionView[]): EntryRoster {
  return { starters: members.slice(0, 4).map((m) => m.steamid), subs: [], coach: null };
}
