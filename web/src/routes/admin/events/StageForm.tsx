import { useId, useState } from 'preact/hooks';
import type { AdminEventOptions, Scheduling, StageSettings, StageType } from '../../../api';
import { presetConfig, presetOf } from '../../../../../src/events/vetoConfig';
import { draftFrom, settingsFrom, staleValues, type StageDraft } from './stageDraft';
import { readWhole } from './wholeNumber';
import { FormGroup, FormRow, ToggleRow } from './FormRow';
import { SeasonCalc } from './SeasonCalc';
import { VetoFields } from './VetoFields';

const TYPES: [StageType, string][] = [
  ['single_elim', 'Single elimination'], ['double_elim', 'Double elimination'], ['round_robin', 'Round robin'], ['swiss', 'Swiss'], ['league', 'League'],
];
const val = (e: Event): string => (e.target as HTMLInputElement).value;
const STALE = ' (no longer available)';

/** The number fields, kept as typed and read only at Save (wholeNumber.ts). */
type NumKey = 'groups' | 'rounds' | 'matches' | 'matchesPerWeek' | 'chapters' | 'advanceCount';
const NUM_LABEL: Record<NumKey, string> = {
  groups: 'Groups', rounds: 'Rounds', matches: 'Matches per team', matchesPerWeek: 'Matches a week', chapters: 'Chapters', advanceCount: 'Advance count',
};
const typedOf = (d: StageDraft): Record<NumKey, string> => ({
  groups: String(d.groups), rounds: String(d.rounds), matches: String(d.matches), matchesPerWeek: String(d.matchesPerWeek),
  chapters: String(d.chapters ?? 3), advanceCount: d.advanceCount === null ? '' : String(d.advanceCount),
});
/** Which number fields the chosen settings use. */
const usedNums = (d: StageDraft): NumKey[] => [
  ...(d.type === 'round_robin' ? ['groups' as const] : []),
  ...(d.type === 'swiss' ? ['rounds' as const] : []),
  ...(d.type === 'league' ? ['matches' as const, 'matchesPerWeek' as const] : []),
  ...(d.chapters !== null ? ['chapters' as const] : []),
  'advanceCount',
];
const pick = (e: Event): string => (e.target as HTMLSelectElement).value;
/** A typed field as a whole number for the live calculator, or null. */
const wholeOrNull = (s: string): number | null => (/^\d+$/.test(s.trim()) ? Number(s) : null);

/** One stage's settings. Saving hands the settings up; the editor sends them. */
export function StageForm({ options, initial, busy, onSave, onCancel, teamCap }: {
  options: AdminEventOptions; initial: StageSettings | null; busy: boolean; onSave: (s: StageSettings) => void; onCancel: () => void;
  teamCap?: number | null;
}) {
  const [d, setD] = useState<StageDraft>(() => draftFrom(initial, options));
  const [stale] = useState(() => staleValues(initial, options));
  const [typed, setTyped] = useState<Record<NumKey, string>>(() => typedOf(d));
  const uid = useId();
  const id = (k: string): string => `${uid}-${k}`;
  const [problem, setProblem] = useState<string | null>(null);
  const set = (patch: Partial<StageDraft>) => setD((x) => ({ ...x, ...patch }));
  const typeInto = (k: NumKey) => (e: Event) => { const v = val(e); setTyped((x) => ({ ...x, [k]: v })); };
  const submit = (e: Event) => {
    e.preventDefault();
    const out: StageDraft = { ...d };
    for (const k of usedNums(d)) {
      const r = readWhole(typed[k], NUM_LABEL[k], k === 'advanceCount');
      if (!r.ok) { setProblem(r.error); return; }
      (out as unknown as Record<NumKey, number | null>)[k] = r.value;
    }
    setProblem(null);
    onSave(settingsFrom(out));
  };
  // The chosen ruleset in one line; an archived one (no longer offered) has none.
  const summary = options.rulesets.find((r) => r.id === d.rulesetId)?.summary ?? '';
  const toggle = (slug: string) => {
    const pool = d.campaignPool.includes(slug) ? d.campaignPool.filter((s) => s !== slug) : [...d.campaignPool, slug];
    const was = presetOf(d.veto, d.campaignPool.length);
    set({ campaignPool: pool, veto: was === 'custom' ? d.veto : presetConfig(was, pool.length) });
  };

  return (
    <form class="eventform eventform--stage" onSubmit={submit}>
      {problem && <p class="error" role="alert">{problem}</p>}
      <FormGroup title="Format">
        <FormRow label="Stage type" for={id('type')}>
          <select id={id('type')} aria-label="Stage type" value={d.type} onChange={(e) => {
            const type = pick(e) as StageType;
            set({ type, scheduling: type === 'league' ? 'window' : d.scheduling });
          }}>
            {TYPES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </select>
        </FormRow>
        {d.type === 'single_elim' && (
          <ToggleRow label="Third-place match" help="The two semifinal losers play for third." checked={d.thirdPlace} onChange={() => set({ thirdPlace: !d.thirdPlace })} />
        )}
        {d.type === 'double_elim' && (
          <ToggleRow label="Grand final reset" help="A second final if the lower bracket team wins the first." checked={d.grandFinalReset} onChange={() => set({ grandFinalReset: !d.grandFinalReset })} />
        )}
        {d.type === 'round_robin' && (
          <FormRow label="Groups" help="(1 to 8)" for={id('groups')}>
            <input id={id('groups')} aria-label="Groups" type="number" min={1} max={8} value={typed.groups} onInput={typeInto('groups')} />
          </FormRow>
        )}
        {d.type === 'swiss' && (
          <FormRow label="Rounds" help="(1 to 9)" for={id('rounds')}>
            <input id={id('rounds')} aria-label="Rounds" type="number" min={1} max={9} value={typed.rounds} onInput={typeInto('rounds')} />
          </FormRow>
        )}
        {d.type === 'league' && (
          <>
            <FormRow label="Matches per team" help="(1 to 40; a bye counts as one)" for={id('matches')}>
              <input id={id('matches')} aria-label="Matches per team" type="number" min={1} max={40} value={typed.matches} onInput={typeInto('matches')} />
            </FormRow>
            <FormRow label="Matches a week" help="(1 to 3)" for={id('mpw')}>
              <input id={id('mpw')} aria-label="Matches a week" type="number" min={1} max={3} value={typed.matchesPerWeek} onInput={typeInto('matchesPerWeek')} />
            </FormRow>
            <FormRow label="Season start" help="Week 1 starts this day. Empty: the day the stage starts." for={id('season')}>
              <input id={id('season')} aria-label="Season start" type="date" value={d.seasonStart ?? ''}
                onInput={(e) => set({ seasonStart: val(e) === '' ? null : val(e) })} />
            </FormRow>
            <FormRow label="Pairing" for={id('pairing')}>
              <select id={id('pairing')} aria-label="League pairing" value={d.pairing} onChange={(e) => set({ pairing: pick(e) as 'swiss' | 'round_robin' })}>
                <option value="swiss">Swiss by record</option>
                <option value="round_robin">Round robin, repeated until the season is played</option>
              </select>
            </FormRow>
            <SeasonCalc
              matches={wholeOrNull(typed.matches)} perWeek={wholeOrNull(typed.matchesPerWeek)} seasonStart={d.seasonStart} teamCap={teamCap}
              onUsePerWeek={(n) => setTyped((x) => ({ ...x, matchesPerWeek: String(n) }))}
            />
          </>
        )}
      </FormGroup>
      <FormGroup title="Matches">
        <FormRow label="Ruleset" help={<>Match rules: pauses, side choice, no-show grace.{summary && <><br /><span>{summary}</span></>}</>} for={id('ruleset')}>
          <select id={id('ruleset')} aria-label="Ruleset" value={String(d.rulesetId)} onChange={(e) => set({ rulesetId: Number(pick(e)) })}>
            {stale.rulesetId !== null && <option value={String(stale.rulesetId)}>Ruleset {stale.rulesetId}{STALE}</option>}
            {options.rulesets.map((r) => <option key={r.id} value={String(r.id)}>{r.name}</option>)}
          </select>
        </FormRow>
        <FormRow label="Game config" help="What the server runs (the cfg it loads)." for={id('config')}>
          <select id={id('config')} aria-label="Game config" value={d.gameConfig} onChange={(e) => set({ gameConfig: pick(e) })}>
            {stale.gameConfig !== null && <option value={stale.gameConfig}>{stale.gameConfig}{STALE}</option>}
            {options.gameConfigs.map((g) => <option key={g.key} value={g.key}>{g.label}</option>)}
          </select>
        </FormRow>
        <VetoFields value={d.veto} poolSize={d.campaignPool.length} onChange={(veto) => set({ veto })} />
      </FormGroup>
      <FormGroup title="Maps">
        <FormRow label="Campaign pool" help={`${d.campaignPool.length} picked, up to 12.`}>
          <div class="admin-checks">
            {options.campaigns.map((c) => (
              <label key={c.slug}>
                <input type="checkbox" aria-label={c.name} checked={d.campaignPool.includes(c.slug)} onChange={() => toggle(c.slug)} /> {c.name}
              </label>
            ))}
            {stale.campaigns.map((slug) => (
              <label key={slug}>
                <input type="checkbox" aria-label={`${slug}${STALE}`} checked={d.campaignPool.includes(slug)} onChange={() => toggle(slug)} /> {slug}{STALE}
              </label>
            ))}
          </div>
        </FormRow>
        <ToggleRow label="Every chapter but the finale" help="Off to play a set number of chapters instead." checked={d.chapters === null}
          onChange={() => {
            if (d.chapters === null) setTyped((x) => ({ ...x, chapters: '3' }));
            set({ chapters: d.chapters === null ? 3 : null });
          }} />
        {d.chapters !== null && (
          <FormRow label="Chapters" help="(1 to 5)" for={id('chapters')}>
            <input id={id('chapters')} aria-label="Chapters" type="number" min={1} max={5} value={typed.chapters} onInput={typeInto('chapters')} />
          </FormRow>
        )}
      </FormGroup>
      <FormGroup title="Schedule">
        {d.type !== 'league' && (
          <FormRow label="Scheduling" for={id('sched')}>
            <select id={id('sched')} aria-label="Scheduling" value={d.scheduling} onChange={(e) => set({ scheduling: pick(e) as Scheduling })}>
              <option value="rolling">Rolling (one night)</option>
              <option value="window">Windows (long event)</option>
            </select>
          </FormRow>
        )}
        <FormRow label="Teams that advance" help="Blank on the last stage. (2 to 128)" for={id('advance')}>
          <input id={id('advance')} aria-label="Advance count" type="number" min={2} max={128} value={typed.advanceCount} onInput={typeInto('advanceCount')} />
        </FormRow>
      </FormGroup>
      <div class="eventform__actions">
        <button class="btn" type="submit" disabled={busy}>Save stage</button>
        <button class="btn btn--ghost" type="button" onClick={onCancel}>Cancel</button>
      </div>
    </form>
  );
}
