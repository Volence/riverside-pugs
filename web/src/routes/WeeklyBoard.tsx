import { api, type WeeklyAward, type WeeklyPlayerStat, type WeeklyPlayerWeek, type WeeklyStanding, type WeeklyWinner } from '../api';
import { useFetch } from '../hooks/useFetch';
import { Empty, Panel, PlayerLink } from '../components/bits';

const GROUPS = [
  { group: 'survivor', title: 'Survivor' },
  { group: 'infected', title: 'Infected' },
  { group: 'overall', title: 'Overall' },
  { group: 'endorsed', title: 'Endorsements' },
  { group: 'shame', title: 'Shame' },
] as const;
const DAMAGE = new Set(['si_damage', 'tank_damage', 'damage_as_si', 'pounce_damage', 'hunter_damage', 'smoker_damage', 'friendly_fire']);

/** Only the awards whose name does not already say what they are. One array
 *  so a new or renamed award's meaning is easy to add or edit in one place.
 *  "{minGames}" in the text is filled in with the live weekly minimum. */
const GLOSSARY: { label: string; text: string }[] = [
  { label: 'Best average / Most total', text: 'Best average is the most per game, among players with at least {minGames}+ games that week. Most total is the biggest sum for the week, with no minimum.' },
  { label: 'Skeets', text: 'Killing a hunter in mid-air while it pounces.' },
  { label: 'Skeet assists', text: 'Helping teammates kill a pouncing hunter in mid-air.' },
  { label: 'Rock skeets', text: "Shooting a tank's rock out of the air." },
  { label: 'Witch crowns', text: 'Killing the witch before she hurts anyone, including draw crowns (startling her first).' },
  { label: 'Tongue clears', text: 'Freeing a teammate from a smoker before they get dragged in.' },
  { label: 'Insta clears', text: 'Freeing a pinned teammate within 0.75 seconds.' },
  { label: 'Damage pounces', text: 'Pounces from high enough up to count as a damage pounce.' },
  { label: 'Damage from pounces', text: 'The damage pounces deal on impact, which grows with how far the hunter flew. Scratching after landing counts toward Hunter damage.' },
  { label: 'Quad caps', text: 'All four survivors pinned at the same time.' },
  { label: 'Booms landed', text: 'Boomer lives that got vomit on at least one survivor, by a direct hit or the explosion.' },
  { label: 'Biggest SR climb', text: 'The most SR gained from the start of the week to the end.' },
  { label: 'Best win rate', text: 'Wins and losses from games with a winner; draws do not count.' },
  { label: 'Iron man', text: 'The most games played this week.' },
  { label: 'Endorsements', text: 'Most endorsed counts every kind. Each award goes to whoever the most different people endorsed that week, so the same friend endorsing you every game counts once; a tie goes to the most endorsements. An endorsement counts for the week it was given.' },
  { label: 'Slowest ready-up', text: 'The longest average time spent not ready before a round.' },
  { label: 'Friendly fire', text: 'The most damage done to teammates, per game.' },
  { label: 'Group hug', text: 'Caught in the most quad caps, per game.' },
];

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
    case 'endorsed_total': case 'endorsed_caller': case 'endorsed_clutch': case 'endorsed_vibes': {
      const count = Number(w.detail ?? w.value);
      return `${n0(w.value)} ${w.value === 1 ? 'person' : 'people'}, ${n0(count)} total`;
    }
    default: return `${DAMAGE.has(a.key) ? n0(w.value) : (Math.round(w.value * 10) / 10).toFixed(1)} per game`;
  }
}

/** A winner's face, or their initial when Steam gave us no avatar. */
function Face({ w }: { w: WeeklyWinner }) {
  return w.avatar
    ? <img class="wk__face" src={w.avatar} alt="" width={24} height={24} loading="lazy" />
    : <span class="wk__face wk__face--none" aria-hidden="true" data-initial={w.name.slice(0, 1).toUpperCase()} />;
}

/** One line of a card: what it is, who (ties share the line), how much. */
function Winners({ a }: { a: WeeklyAward }) {
  const kind = a.kind === 'avg' ? 'Best average' : a.kind === 'total' ? 'Most total' : '';
  return (
    <div class="weekly__winner wk__row">
      {kind && <span class="weekly__kind wk__kind">{kind}</span>}
      <span class="wk__who">
        <Face w={a.winners[0]} />
        <span class="wk__names">
          {a.winners.map((w) => <PlayerLink key={w.steamid} steamid={w.steamid} name={w.name} />)}
        </span>
      </span>
      <span class="weekly__value wk__value">{(() => {
        // "6,517 per game" -> the number stands out, the unit stays quiet.
        const v = value(a, a.winners[0]);
        const cut = v.indexOf(' ');
        return cut > 0 ? <><span class="wk__num">{v.slice(0, cut)}</span> <span class="wk__unit">{v.slice(cut + 1)}</span></> : v;
      })()}</span>
    </div>
  );
}

/** "2d 19h" to the given moment, or null once it has passed. */
function untilText(at: number, now: number): string | null {
  const ms = at - now;
  if (ms <= 0) return null;
  const h = Math.floor(ms / 3_600_000);
  return h >= 24 ? `${Math.floor(h / 24)}d ${h % 24}h` : h >= 1 ? `${h}h ${Math.floor((ms % 3_600_000) / 60_000)}m` : `${Math.max(1, Math.ceil(ms / 60_000))}m`;
}

/** 1st, 2nd, 3rd, 4th, 11th, 12th, 13th, 21st. */
export function ordinal(n: number): string {
  const t = n % 100;
  if (t >= 11 && t <= 13) return `${n}th`;
  return `${n}${({ 1: 'st', 2: 'nd', 3: 'rd' } as Record<number, string>)[n % 10] ?? 'th'}`;
}

/** The viewer's own number on a card, formatted like the winner's. */
function youValue(key: string, kind: 'avg' | 'total', v: number): string {
  if (kind === 'total') return n0(v);
  return DAMAGE.has(key) ? n0(v) : (Math.round(v * 10) / 10).toFixed(1);
}

/** "Close" means on the podium or within a tenth of the leader. */
function closeness(s: WeeklyStanding): 'lead' | 'close' | null {
  if (s.rank === 1 && s.value > 0) return 'lead';
  if (s.rank === null || s.value <= 0) return null;
  return s.rank <= 3 || (s.leader > 0 && s.value >= s.leader * 0.9) ? 'close' : null;
}

/** One "You" row under a card: the viewer's number, rank and gap to #1. */
function YouRow({ statKey, kind, s }: { statKey: string; kind: 'avg' | 'total'; s: WeeklyStanding }) {
  const near = closeness(s);
  const unit = kind === 'avg' ? 'per game' : 'total';
  const where = s.rank === null
    ? 'not ranked yet'
    : near === 'lead' ? `1st of ${s.of}, you lead`
      : `${ordinal(s.rank)} of ${s.of}, ${youValue(statKey, kind, s.gap)} behind`;
  return (
    <div class={`wk__you${near ? ` wk__you--${near}` : ''}`}>
      <span class="wk__youkind">{kind === 'avg' ? 'Your average' : 'Your total'}</span>
      <span class="wk__youval"><span class="wk__num">{youValue(statKey, kind, s.value)}</span> <span class="wk__unit">{unit}</span></span>
      <span class="wk__youwhere">{where}</span>
    </div>
  );
}

function YouLines({ stat }: { stat: WeeklyPlayerStat | undefined }) {
  if (!stat || (!stat.avg && !stat.total)) return null;
  return (
    <div class="wk__yous" aria-label="Your numbers">
      {stat.avg && <YouRow statKey={stat.key} kind="avg" s={stat.avg} />}
      {stat.total && <YouRow statKey={stat.key} kind="total" s={stat.total} />}
    </div>
  );
}

/** The signed-in viewer's week at a glance, above the cards. */
function YourWeek({ me }: { me: WeeklyPlayerWeek }) {
  const short = me.minGames - me.games;
  return (
    <div class="wk__yourweek" aria-label="Your week">
      <span class="wk__yourweek-title">Your week</span>
      <span><strong class="num">{me.games}</strong> {me.games === 1 ? 'game' : 'games'}</span>
      <span>{me.games === 0
        ? 'Play a game this week to see where you stand.'
        : short > 0
          ? <>{short} more {short === 1 ? 'game' : 'games'} to qualify for averages</>
          : <>Averages count from {me.minGames} games, you qualify</>}</span>
    </div>
  );
}

export function WeeklyBoard({ week, onWeek, me }: { week?: string; onWeek: (w: string | undefined) => void; me?: string | null }) {
  const { data: list } = useFetch((s) => api.weeklyWeeks(s).catch(() => ({ current: '', weeks: [] as string[] })), []);
  // The Discord post and profile chips link `?week=<that week's Monday>`.
  // Once that week is the live one again (a new week started), the linked
  // Monday IS the current week, so treat it as no week at all (live) rather
  // than asking the API for a week id that no longer means anything special.
  const effectiveWeek = list && week && week === list.current ? undefined : week;
  // One quiet retry: a request that lands during a deploy's two second restart
  // fails once and would otherwise strand the reader on "Could not load".
  const { data, error, reload } = useFetch(
    (s) => api.weekly(s, effectiveWeek).catch(() => new Promise<never>((_, reject) => setTimeout(reject, 1500)).catch(() => api.weekly(s, effectiveWeek))),
    [effectiveWeek],
  );
  // The signed-in viewer's own standing on every board, for the "You" rows.
  const { data: mine } = useFetch(
    (s) => (me ? api.weeklyPlayer(me, s, effectiveWeek).catch(() => null) : Promise.resolve(null)),
    [me, effectiveWeek],
  );

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
        <Empty>
          Could not load this week.{' '}
          <button type="button" class="btn btn--ghost btn--sm" onClick={reload}>Try again</button>
        </Empty>
      </div>
    );
  }
  if (!data) return null;
  return (
    <div class="weekly">
      <div class="weekly__bar">
        {picker}
        {data.live && (() => {
          const final = Date.parse(`${data.week}T12:00:00Z`) + 7 * 86_400_000;
          const left = untilText(final, Date.now());
          return (
            <span class="weekly__note wk__strip">
              <span class="wk__live">Live</span>
              <span>Averages need {data.minGames}+ games</span>
              <span>final Monday 12:00 UTC{left ? <>, <strong class="num">{left}</strong> left</> : ''}</span>
            </span>
          );
        })()}
      </div>
      {mine && <YourWeek me={mine} />}
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
                  <div class="weekly__card wk__card" key={k}>
                    <div class="weekly__label wk__title">{parts[0].label}</div>
                    {parts.map((a) => <Winners key={a.kind} a={a} />)}
                    {mine && <YouLines stat={mine.stats.find((x) => x.key === k)} />}
                  </div>
                );
              })}
            </div>
          </Panel>
        );
      })}
      <Panel>
        <h3 class="weekly__group">What these mean</h3>
        <dl class="weekly__glossary">
          {GLOSSARY.map((g) => (
            <div class="weekly__glossary-entry" key={g.label}>
              <dt>{g.label}</dt>
              <dd>{g.text.replace('{minGames}', String(data.minGames))}</dd>
            </div>
          ))}
        </dl>
      </Panel>
    </div>
  );
}
