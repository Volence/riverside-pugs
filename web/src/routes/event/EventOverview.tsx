import type { EventEntryView, EventView } from '../../api';
import { entryLogoUrl } from '../../api';
import { Panel } from '../../components/bits';
import { Figure, Figures } from '../../components/PageHeader';
import { campaignTint } from '../../format';
import { placementText, roundWhenText, untilText } from '../../eventFormat';

/** One step on the event's timeline. */
export interface Milestone { key: string; label: string; at: string }

const STAGE_SHORT: Record<string, string> = {
  single_elim: 'Single elim', double_elim: 'Double elim', round_robin: 'Round robin', swiss: 'Swiss', league: 'League',
};

/** How many teams the bracket will have: the entries once there are any,
 *  otherwise for a draft the teams its signups make (four to a team). */
function teamCount(ev: EventView): number | null {
  const live = ev.entries.filter((e) => e.status !== 'disqualified').length;
  if (live > 0) return live;
  if (ev.entryKind === 'draft' && ev.draft) return Math.floor(ev.draft.signups / 4) || null;
  return ev.teamCap;
}

/** "Final", "Semifinals", "Quarterfinals" counted back from the last round of
 *  a single-elimination bracket; "Round n" when the size is unknown. */
export function roundName(round: number, rounds: number | null): string {
  if (rounds === null) return `Round ${round}`;
  const fromEnd = rounds - round;
  return fromEnd === 0 ? 'Final' : fromEnd === 1 ? 'Semifinals' : fromEnd === 2 ? 'Quarterfinals' : `Round ${round}`;
}

/** The event's dated steps in order: signups closing and draft night for a
 *  draft, check-in for a team event, the start, then each later round staff
 *  gave a time (rounds sharing a time share a step). */
export function milestones(ev: EventView): Milestone[] {
  const out: Milestone[] = [];
  if (ev.entryKind === 'draft' && ev.draft) {
    out.push({ key: 'close', label: 'Signups close', at: ev.draft.signupsCloseAt });
    out.push({ key: 'draft', label: 'Draft night', at: ev.draft.draftAt });
  }
  if (ev.entryKind === 'team' && ev.checkinOpensAt) out.push({ key: 'checkin', label: 'Check-in opens', at: ev.checkinOpensAt });
  out.push({ key: 'start', label: ev.entryKind === 'draft' ? 'First matches' : 'Starts', at: ev.startsAt });
  const first = ev.stages[0];
  if (first?.roundTimes?.length) {
    const n = teamCount(ev);
    const rounds = first.type === 'single_elim' && n !== null && n > 1 ? Math.ceil(Math.log2(n)) : null;
    const byTime = new Map<string, number[]>();
    for (const r of first.roundTimes) {
      if (Date.parse(r.at) <= Date.parse(ev.startsAt)) continue;
      byTime.set(r.at, [...(byTime.get(r.at) ?? []), r.round]);
    }
    for (const [at, list] of byTime) {
      const names = list.map((r) => roundName(r, rounds));
      const label = names.length === 1 ? names[0]! : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]!.toLowerCase()}`;
      out.push({ key: `r${list.join('-')}`, label, at });
    }
  }
  return out.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
}

/** The timeline strip under the header: done steps dim, the next one lit with
 *  its countdown. Hidden once the event is over. */
export function EventTimeline({ ev, now }: { ev: EventView; now: number }) {
  if (ev.status === 'finished' || ev.status === 'cancelled') return null;
  const steps = milestones(ev);
  if (steps.length < 2) return null;
  const next = steps.find((s) => Date.parse(s.at) > now);
  return (
    <ol class="evtimeline" aria-label="Schedule">
      {steps.map((s) => {
        const state = Date.parse(s.at) <= now ? 'done' : s === next ? 'next' : 'later';
        return (
          <li key={s.key} class={`evtimeline__step evtimeline__step--${state}`}>
            <span class="evtimeline__label eyebrow">{s.label}</span>
            <span class="evtimeline__when">{roundWhenText(s.at)}</span>
            {state === 'next' && <span class="evtimeline__until">{untilText(s.at, now)}</span>}
          </li>
        );
      })}
    </ol>
  );
}

/** The header's figures: who is in, the format, the map pool. */
export function EventFigures({ ev }: { ev: EventView }) {
  const first = ev.stages[0];
  const teams = ev.entries.filter((e) => e.status !== 'disqualified').length;
  const entries = ev.entryKind === 'draft' && teams === 0 && ev.draft
    ? { label: 'Signed up', value: ev.draft.signups, sub: ev.draft.signups >= 8 ? `${Math.floor(ev.draft.signups / 4)} teams of four` : 'players' }
    : { label: 'Teams', value: teams, sub: ev.teamCap !== null && ev.entryKind === 'team' ? `of ${ev.teamCap}` : undefined };
  return (
    <Figures>
      <Figure label={entries.label} value={entries.value} sub={entries.sub} />
      {first && <Figure label="Format" value={STAGE_SHORT[first.type] ?? first.type} sub={ev.stages.length > 1 ? `then ${ev.stages.length - 1} more stage${ev.stages.length > 2 ? 's' : ''}` : first.summary} />}
      {first && first.campaigns.length > 0 && <Figure label="Map pool" value={first.campaigns.length} sub="campaigns" />}
    </Figures>
  );
}

/** Two letters for a team with no logo: its tag, else the initials of its
 *  name without a leading "Team" ("Team Icy Inferno" is II, not TE). */
export function teamInitials(e: Pick<EventEntryView, 'name' | 'tag'>): string {
  if (e.tag) return e.tag.slice(0, 3).toUpperCase();
  const words = e.name.replace(/^team\s+/i, '').split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w));
  const letters = words.length > 1 ? words.slice(0, 2).map((w) => [...w.replace(/^[^\p{L}\p{N}]+/u, '')][0] ?? '') : [...(words[0] ?? e.name)].slice(0, 2);
  return letters.join('').toUpperCase() || '?';
}

function TeamCard({ e, teamEvent }: { e: EventEntryView; teamEvent: boolean }) {
  const players = e.playerLinks ?? (e.players ?? []).map((name) => ({ steamid: '', name }));
  return (
    <li class={`evteam${e.status === 'disqualified' ? ' evteam--out' : ''}${e.placement === 1 ? ' evteam--champion' : ''}`}>
      <div class="evteam__head">
        {e.logoKey
          ? <img class="evteam__logo" src={entryLogoUrl(e.logoKey)} alt="" width={40} height={40} />
          : <span class="evteam__logo evteam__logo--none" aria-hidden="true">{teamInitials(e)}</span>}
        <div class="evteam__title">
          <span class="evteam__name">{e.name}</span>
          <span class="evteam__meta">
            {e.seed !== null && <span class="evteam__seed">Seed {e.seed}</span>}
            {e.tag && <span class="evteam__tag">{e.tag}</span>}
          </span>
        </div>
        <span class="evteam__chips">
          {teamEvent && e.status === 'checked_in' && <span class="teamchip teamchip--ok">Checked in</span>}
          {e.waitlist !== null && <span class="teamchip">Waitlist {e.waitlist}</span>}
          {e.status === 'disqualified' && <span class="teamchip teamchip--bad">Disqualified</span>}
          {e.placement !== null && <span class="teamchip teamchip--ok">{placementText(e.placement)}</span>}
        </span>
      </div>
      {players.length > 0 && (
        <ul class="evteam__players" aria-label={`${e.name} players`}>
          {players.map((p, i) => (
            <li key={`${i}:${p.steamid || p.name}`}>
              {p.steamid ? <a href={`/player/${p.steamid}`}>{p.name}</a> : <span>{p.name}</span>}
              {i === 0 && <span class="evteam__cap" title="Captain" aria-label="captain">C</span>}
            </li>
          ))}
        </ul>
      )}
    </li>
  );
}

/** The entries as a grid of team cards: logo, seed, tag, players linked to
 *  their profiles (captain first, marked). */
export function TeamsGrid({ ev }: { ev: EventView }) {
  return <ul class="evteams">{ev.entries.map((e) => <TeamCard key={e.id} e={e} teamEvent={ev.entryKind === 'team'} />)}</ul>;
}

/** A rule line "Pauses: 3 per team" as a term and its value; a line without
 *  a colon stays one sentence. */
function splitRule(line: string): [string | null, string] {
  const i = line.indexOf(': ');
  return i > 0 && i < 40 ? [line.slice(0, i), line.slice(i + 2)] : [null, line];
}

/** One stage's rules as a term list, its veto and chapters, and its pool as
 *  tinted campaign chips. */
export function StageRulesCard({ s, only }: { s: EventView['stages'][number]; only: boolean }) {
  return (
    <Panel class="evside">
      <h3>{only ? 'Rules and campaigns' : `Stage ${s.ordinal}: rules and campaigns`}</h3>
      <p class="evside__lead">{s.veto}</p>
      <dl class="evrules">
        <div><dt>Ruleset</dt><dd>{s.rulesetName ?? 'Ruleset'}</dd></div>
        <div><dt>Chapters</dt><dd>{s.chapters}</dd></div>
        <div><dt>Schedule</dt><dd>{s.scheduling === 'window' ? 'Played in scheduled windows' : 'Played in one session'}</dd></div>
        <div><dt>Config</dt><dd>{s.gameConfig}</dd></div>
        {s.rules.map((r) => {
          const [term, value] = splitRule(r);
          return term
            ? <div key={r}><dt>{term}</dt><dd>{value}</dd></div>
            : <div key={r} class="evrules__line"><dd>{r}</dd></div>;
        })}
      </dl>
      <h4 class="evside__sub">Map pool</h4>
      <ul class="evpool">
        {s.campaigns.map((c) => (
          <li key={c.slug} class="evpool__item" style={{ '--campaign': campaignTint(c.slug) } as Record<string, string>}>{c.name}</li>
        ))}
      </ul>
    </Panel>
  );
}
