import { api, type WeeklyAward, type WeeklyWinner } from '../api';
import { useFetch } from '../hooks/useFetch';
import { Empty, Panel, PlayerLink } from '../components/bits';

const GROUPS = [
  { group: 'survivor', title: 'Survivor' },
  { group: 'infected', title: 'Infected' },
  { group: 'overall', title: 'Overall' },
  { group: 'shame', title: 'Shame' },
] as const;
const DAMAGE = new Set(['si_damage', 'tank_damage', 'damage_as_si', 'pounce_damage', 'hunter_damage', 'smoker_damage', 'friendly_fire']);

const n0 = (v: number) => Math.round(v).toLocaleString('en-US');
const weekName = (w: string) =>
  `Week of ${new Date(`${w}T00:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' })}`;

/** Mirrors src/discord/weeklyCard.ts formatAwardValue so the site and the
 *  Discord post say the same thing, except the site spells out "per game"
 *  where Discord abbreviates it to "/g". */
function value(a: WeeklyAward, w: WeeklyWinner): string {
  if (a.kind === 'avg') return `${DAMAGE.has(a.key) ? n0(w.value) : (Math.round(w.value * 10) / 10).toFixed(1)} per game`;
  if (a.kind === 'total') return `${n0(w.value)} total`;
  switch (a.key) {
    case 'sr_climb': return `+${n0(w.value)} SR`;
    case 'wins': return `${n0(w.value)} wins`;
    case 'win_streak': return `${n0(w.value)} in a row`;
    case 'matches': return `${n0(w.value)} games`;
    case 'win_rate': return w.detail ?? `${Math.round(w.value * 100)}%`;
    case 'slow_ready': return `${n0(w.value)}s per ready-up`;
    default: return `${DAMAGE.has(a.key) ? n0(w.value) : (Math.round(w.value * 10) / 10).toFixed(1)} per game`;
  }
}

function Winners({ a }: { a: WeeklyAward }) {
  return (
    <div class="weekly__winner">
      <span class="weekly__kind">{a.kind === 'avg' ? 'Best average' : a.kind === 'total' ? 'Most total' : ''}</span>
      {a.winners.map((w) => <PlayerLink key={w.steamid} steamid={w.steamid} name={w.name} />)}
      <span class="weekly__value">{value(a, a.winners[0])}</span>
    </div>
  );
}

export function WeeklyBoard({ week, onWeek }: { week?: string; onWeek: (w: string | undefined) => void }) {
  const { data: list } = useFetch((s) => api.weeklyWeeks(s).catch(() => ({ current: '', weeks: [] as string[] })), []);
  // The Discord post and profile chips link `?week=<that week's Monday>`.
  // Once that week is the live one again (a new week started), the linked
  // Monday IS the current week, so treat it as no week at all (live) rather
  // than asking the API for a week id that no longer means anything special.
  const effectiveWeek = list && week && week === list.current ? undefined : week;
  const { data, error } = useFetch((s) => api.weekly(s, effectiveWeek), [effectiveWeek]);

  const picker = (
    <select
      class="season-picker" aria-label="Week" value={effectiveWeek ?? ''}
      onChange={(e) => onWeek((e.currentTarget as HTMLSelectElement).value || undefined)}
    >
      <option value="">This week</option>
      {(list?.weeks ?? []).map((w) => <option key={w} value={w}>{weekName(w)}</option>)}
    </select>
  );

  // Keep the picker on screen even when the week itself failed to load, so a
  // bad or stale week id does not strand the reader on a dead page: they can
  // still pick another week or fall back to "This week".
  if (error) {
    return (
      <div class="weekly">
        <div class="weekly__bar">{picker}</div>
        <Empty>Could not load this week.</Empty>
      </div>
    );
  }
  if (!data) return null;
  return (
    <div class="weekly">
      <div class="weekly__bar">
        {picker}
        {data.live && <span class="weekly__note">Live. Averages need {data.minGames}+ games; final Monday 00:00 UTC.</span>}
      </div>
      {data.awards.length === 0 && <Empty>No awards yet this week.</Empty>}
      {GROUPS.map(({ group, title }) => {
        const inGroup = data.awards.filter((a) => a.group === group);
        if (!inGroup.length) return null;
        const keys = [...new Set(inGroup.map((a) => a.key))];
        return (
          <Panel key={group}>
            <h3 class="weekly__group">{title}</h3>
            <div class="weekly__grid">
              {keys.map((k) => {
                const parts = inGroup.filter((a) => a.key === k);
                return (
                  <div class="weekly__card" key={k}>
                    <div class="weekly__label">{parts[0].label}</div>
                    {parts.map((a) => <Winners key={a.kind} a={a} />)}
                  </div>
                );
              })}
            </div>
          </Panel>
        );
      })}
    </div>
  );
}
