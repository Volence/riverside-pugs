import { useState } from 'preact/hooks';
import type { AdminEventOptions, Scheduling, StageSettings, StageType, VetoType } from '../../../api';
import { draftFrom, settingsFrom, type StageDraft } from './stageDraft';

const TYPES: [StageType, string][] = [
  ['single_elim', 'Single elimination'], ['double_elim', 'Double elimination'], ['round_robin', 'Round robin'], ['swiss', 'Swiss'], ['league', 'League'],
];
const VETOES: [VetoType, string][] = [
  ['ban_to_one', 'Ban to one (Bo1)'], ['home_away', 'Home and away (Bo2 aggregate)'], ['pick_ban', 'Pick and ban (Bo3, exactly 7 campaigns)'],
];
const num = (e: Event): number => Number((e.target as HTMLInputElement).value);
const numOrNull = (e: Event): number | null => {
  const v = (e.target as HTMLInputElement).value.trim();
  return v === '' ? null : Number(v);
};
const pick = (e: Event): string => (e.target as HTMLSelectElement).value;

/** One stage's settings. Saving hands the settings up; the editor sends them. */
export function StageForm({ options, initial, busy, onSave, onCancel }: {
  options: AdminEventOptions; initial: StageSettings | null; busy: boolean; onSave: (s: StageSettings) => void; onCancel: () => void;
}) {
  const [d, setD] = useState<StageDraft>(() => draftFrom(initial, options));
  const set = (patch: Partial<StageDraft>) => setD((x) => ({ ...x, ...patch }));
  const toggle = (slug: string) =>
    set({ campaignPool: d.campaignPool.includes(slug) ? d.campaignPool.filter((s) => s !== slug) : [...d.campaignPool, slug] });

  return (
    <form class="admin-form admin-form--stack" onSubmit={(e) => { e.preventDefault(); onSave(settingsFrom(d)); }}>
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
        <label class="teamfield">Groups<input aria-label="Groups" type="number" min={1} max={8} value={d.groups} onInput={(e) => set({ groups: num(e) })} /></label>
      )}
      {d.type === 'swiss' && (
        <label class="teamfield">Rounds<input aria-label="Rounds" type="number" min={1} max={9} value={d.rounds} onInput={(e) => set({ rounds: num(e) })} /></label>
      )}
      {d.type === 'league' && (
        <>
          <label class="teamfield">Weeks<input aria-label="Weeks" type="number" min={1} max={12} value={d.weeks} onInput={(e) => set({ weeks: num(e) })} /></label>
          <label class="teamfield">Matches a week<input aria-label="Matches a week" type="number" min={1} max={3} value={d.matchesPerWeek} onInput={(e) => set({ matchesPerWeek: num(e) })} /></label>
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
          {options.rulesets.map((r) => <option key={r.id} value={String(r.id)}>{r.name}</option>)}
        </select>
      </label>
      <label class="teamfield">Game config
        <select aria-label="Game config" value={d.gameConfig} onChange={(e) => set({ gameConfig: pick(e) })}>
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
      </fieldset>
      <label>
        <input type="checkbox" aria-label="Every chapter but the finale" checked={d.chapters === null}
          onChange={() => set({ chapters: d.chapters === null ? 3 : null })} /> Every chapter but the finale
      </label>
      {d.chapters !== null && (
        <label class="teamfield">Chapters<input aria-label="Chapters" type="number" min={1} max={5} value={d.chapters} onInput={(e) => set({ chapters: num(e) })} /></label>
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
        <input aria-label="Advance count" type="number" min={2} max={128} value={d.advanceCount ?? ''} onInput={(e) => set({ advanceCount: numOrNull(e) })} />
      </label>
      <span class="inlinerow">
        <button class="btn" type="submit" disabled={busy}>Save stage</button>
        <button class="btn btn--ghost" type="button" onClick={onCancel}>Cancel</button>
      </span>
    </form>
  );
}
