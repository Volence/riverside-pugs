import { useState } from 'preact/hooks';
import type { AdminEventOptions, Scheduling, StageSettings, StageType, VetoType } from '../../../api';
import { draftFrom, settingsFrom, staleValues, type StageDraft } from './stageDraft';
import { readWhole } from './wholeNumber';

const TYPES: [StageType, string][] = [
  ['single_elim', 'Single elimination'], ['double_elim', 'Double elimination'], ['round_robin', 'Round robin'], ['swiss', 'Swiss'], ['league', 'League'],
];
const VETOES: [VetoType, string][] = [
  ['ban_to_one', 'Ban to one (Bo1)'], ['home_away', 'Home and away (Bo2 aggregate)'], ['pick_ban', 'Pick and ban (Bo3, exactly 7 campaigns)'],
];
const val = (e: Event): string => (e.target as HTMLInputElement).value;
const STALE = ' (no longer available)';

/** The number fields, kept as typed and read only at Save (wholeNumber.ts). */
type NumKey = 'groups' | 'rounds' | 'weeks' | 'matchesPerWeek' | 'chapters' | 'advanceCount';
const NUM_LABEL: Record<NumKey, string> = {
  groups: 'Groups', rounds: 'Rounds', weeks: 'Weeks', matchesPerWeek: 'Matches a week', chapters: 'Chapters', advanceCount: 'Advance count',
};
const typedOf = (d: StageDraft): Record<NumKey, string> => ({
  groups: String(d.groups), rounds: String(d.rounds), weeks: String(d.weeks), matchesPerWeek: String(d.matchesPerWeek),
  chapters: String(d.chapters ?? 3), advanceCount: d.advanceCount === null ? '' : String(d.advanceCount),
});
/** Which number fields the chosen settings use. */
const usedNums = (d: StageDraft): NumKey[] => [
  ...(d.type === 'round_robin' ? ['groups' as const] : []),
  ...(d.type === 'swiss' ? ['rounds' as const] : []),
  ...(d.type === 'league' ? ['weeks' as const, 'matchesPerWeek' as const] : []),
  ...(d.chapters !== null ? ['chapters' as const] : []),
  'advanceCount',
];
const pick = (e: Event): string => (e.target as HTMLSelectElement).value;

/** One stage's settings. Saving hands the settings up; the editor sends them. */
export function StageForm({ options, initial, busy, onSave, onCancel }: {
  options: AdminEventOptions; initial: StageSettings | null; busy: boolean; onSave: (s: StageSettings) => void; onCancel: () => void;
}) {
  const [d, setD] = useState<StageDraft>(() => draftFrom(initial, options));
  const [stale] = useState(() => staleValues(initial, options));
  const [typed, setTyped] = useState<Record<NumKey, string>>(() => typedOf(d));
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
  const toggle = (slug: string) =>
    set({ campaignPool: d.campaignPool.includes(slug) ? d.campaignPool.filter((s) => s !== slug) : [...d.campaignPool, slug] });

  return (
    <form class="admin-form admin-form--stack" onSubmit={submit}>
      {problem && <p class="error" role="alert">{problem}</p>}
      <label class="teamfield">Stage type
        <select aria-label="Stage type" value={d.type} onChange={(e) => {
          const type = pick(e) as StageType;
          set({ type, scheduling: type === 'league' ? 'window' : d.scheduling });
        }}>
          {TYPES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
        </select>
      </label>
      {d.type === 'single_elim' && (
        <label><input type="checkbox" aria-label="Third-place match" checked={d.thirdPlace} onChange={() => set({ thirdPlace: !d.thirdPlace })} /> Third-place match</label>
      )}
      {d.type === 'double_elim' && (
        <label><input type="checkbox" aria-label="Grand final reset" checked={d.grandFinalReset} onChange={() => set({ grandFinalReset: !d.grandFinalReset })} /> Grand final reset</label>
      )}
      {d.type === 'round_robin' && (
        <label class="teamfield">Groups<input aria-label="Groups" type="number" min={1} max={8} value={typed.groups} onInput={typeInto('groups')} /></label>
      )}
      {d.type === 'swiss' && (
        <label class="teamfield">Rounds<input aria-label="Rounds" type="number" min={1} max={9} value={typed.rounds} onInput={typeInto('rounds')} /></label>
      )}
      {d.type === 'league' && (
        <>
          <label class="teamfield">Weeks<input aria-label="Weeks" type="number" min={1} max={12} value={typed.weeks} onInput={typeInto('weeks')} /></label>
          <label class="teamfield">Matches a week<input aria-label="Matches a week" type="number" min={1} max={3} value={typed.matchesPerWeek} onInput={typeInto('matchesPerWeek')} /></label>
          <label class="teamfield">Pairing
            <select aria-label="League pairing" value={d.pairing} onChange={(e) => set({ pairing: pick(e) as 'swiss' | 'round_robin' })}>
              <option value="swiss">Swiss by record</option>
              <option value="round_robin">Full round robin over the weeks</option>
            </select>
          </label>
        </>
      )}
      <label class="teamfield">Ruleset
        <select aria-label="Ruleset" value={String(d.rulesetId)} onChange={(e) => set({ rulesetId: Number(pick(e)) })}>
          {stale.rulesetId !== null && <option value={String(stale.rulesetId)}>Ruleset {stale.rulesetId}{STALE}</option>}
          {options.rulesets.map((r) => <option key={r.id} value={String(r.id)}>{r.name}</option>)}
        </select>
      </label>
      <label class="teamfield">Game config
        <select aria-label="Game config" value={d.gameConfig} onChange={(e) => set({ gameConfig: pick(e) })}>
          {stale.gameConfig !== null && <option value={stale.gameConfig}>{stale.gameConfig}{STALE}</option>}
          {options.gameConfigs.map((g) => <option key={g.key} value={g.key}>{g.label}</option>)}
        </select>
      </label>
      <label class="teamfield">Veto
        <select aria-label="Veto" value={d.vetoType} onChange={(e) => set({ vetoType: pick(e) as VetoType })}>
          {VETOES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
        </select>
      </label>
      <fieldset class="bookform__fieldset">
        <legend class="teamsub">Campaign pool ({d.campaignPool.length} of up to 12)</legend>
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
      </fieldset>
      <label>
        <input type="checkbox" aria-label="Every chapter but the finale" checked={d.chapters === null}
          onChange={() => {
            if (d.chapters === null) setTyped((x) => ({ ...x, chapters: '3' }));
            set({ chapters: d.chapters === null ? 3 : null });
          }} /> Every chapter but the finale
      </label>
      {d.chapters !== null && (
        <label class="teamfield">Chapters<input aria-label="Chapters" type="number" min={1} max={5} value={typed.chapters} onInput={typeInto('chapters')} /></label>
      )}
      {d.type !== 'league' && (
        <label class="teamfield">Scheduling
          <select aria-label="Scheduling" value={d.scheduling} onChange={(e) => set({ scheduling: pick(e) as Scheduling })}>
            <option value="rolling">Rolling (one night)</option>
            <option value="window">Windows (long event)</option>
          </select>
        </label>
      )}
      <label class="teamfield">Teams that advance (blank on the last stage)
        <input aria-label="Advance count" type="number" min={2} max={128} value={typed.advanceCount} onInput={typeInto('advanceCount')} />
      </label>
      <span class="inlinerow">
        <button class="btn" type="submit" disabled={busy}>Save stage</button>
        <button class="btn btn--ghost" type="button" onClick={onCancel}>Cancel</button>
      </span>
    </form>
  );
}
