import { useId } from 'preact/hooks';
import {
  PRESET_LABEL, PRESET_MIN_POOL, VETO_PRESETS, checkVeto, presetConfig, presetOf, vetoSummary, type VetoConfig, type VetoPreset,
} from '../../../../../src/events/vetoConfig';
import { FormRow } from './FormRow';

const pick = (e: Event): string => (e.target as HTMLSelectElement).value;

/** Plan T3a Ruling 3: a preset, then every knob. */
export function VetoFields({ value, poolSize, onChange }: { value: VetoConfig; poolSize: number; onChange: (v: VetoConfig) => void }) {
  const uid = useId();
  const id = (k: string) => `${uid}-${k}`;
  const set = (patch: Partial<VetoConfig>) => onChange({ ...value, ...patch });
  const preset = presetOf(value, poolSize);
  const verdict = checkVeto(value, poolSize);
  const problem = verdict === 'ok' ? null
    : verdict === 'bad_pool_for_veto' ? `The pool needs at least ${value.banTo} campaigns for this.`
      : value.banTo < value.games ? 'Ban down to at least one campaign per game.'
        : value.games === 2 && value.laterPicks === 'loser' ? 'A total score Bo2 has no loser to pick next.'
          : 'Too many extra bans: nothing would be left for the last game.';
  const bo1 = value.games === 1;
  return (
    <>
      <FormRow label="Veto format" help="A preset fills the settings below; change any of them for a custom veto." for={id('preset')}>
        <select id={id('preset')} aria-label="Veto format" value={preset} onChange={(e) => {
          const p = pick(e);
          if (p !== 'custom') onChange(presetConfig(p as VetoPreset, poolSize));
        }}>
          {VETO_PRESETS.map((p) => {
            const short = PRESET_MIN_POOL[p] > poolSize;
            return <option key={p} value={p} disabled={short}>{`${PRESET_LABEL[p]}${short ? ` (needs ${PRESET_MIN_POOL[p]} campaigns)` : ''}`}</option>;
          })}
          <option value="custom">{PRESET_LABEL.custom}</option>
        </select>
      </FormRow>
      <FormRow label="Series" for={id('games')}>
        <select id={id('games')} aria-label="Series" value={String(value.games)} onChange={(e) => {
          const games = Number(pick(e)) as VetoConfig['games'];
          set({ games, laterPicks: games === 2 ? 'alternate' : value.laterPicks, lateBans: games === 1 ? 0 : value.lateBans, banTo: Math.max(value.banTo, games) });
        }}>
          <option value="1">Bo1</option>
          <option value="2">Bo2, total score</option>
          <option value="3">Bo3</option>
          <option value="5">Bo5</option>
        </select>
      </FormRow>
      <FormRow label="Ban down to" help={`Campaigns left after the opening bans (1 to ${poolSize}; ${poolSize} means no bans).`} for={id('banTo')}>
        <input id={id('banTo')} aria-label="Ban down to" type="number" min={1} max={poolSize} value={String(value.banTo)}
          onInput={(e) => { const n = Number((e.target as HTMLInputElement).value); if (Number.isInteger(n)) set({ banTo: n }); }} />
      </FormRow>
      <FormRow label="Who goes first" for={id('firstBan')}>
        <select id={id('firstBan')} aria-label="Who goes first" value={value.firstBan} onChange={(e) => set({ firstBan: pick(e) as VetoConfig['firstBan'] })}>
          <option value="higher_chooses">Higher seed chooses first or second</option>
          <option value="higher">Higher seed</option>
          <option value="lower">Lower seed</option>
          <option value="coin">Coin flip</option>
        </select>
      </FormRow>
      {!(bo1 && value.banTo === 1) && (
        <FormRow label="Game 1 is picked by" for={id('firstPick')}>
          <select id={id('firstPick')} aria-label="Game 1 is picked by" value={value.firstPick} onChange={(e) => set({ firstPick: pick(e) as VetoConfig['firstPick'] })}>
            <option value="higher">Higher seed</option>
            <option value="lower">Lower seed</option>
            <option value="first">Team that goes first</option>
            <option value="second">Team that goes second</option>
            <option value="coin">Coin flip</option>
          </select>
        </FormRow>
      )}
      {!bo1 && (
        <FormRow label="Later games" for={id('laterPicks')}>
          <select id={id('laterPicks')} aria-label="Later games" value={value.laterPicks}
            onChange={(e) => set({ laterPicks: pick(e) as VetoConfig['laterPicks'], lateBans: pick(e) === 'loser' ? 0 : value.lateBans })}>
            <option value="loser" disabled={value.games === 2}>Loser of the previous game picks</option>
            <option value="alternate">Teams take turns</option>
          </select>
        </FormRow>
      )}
      {!bo1 && value.games !== 2 && value.laterPicks === 'alternate' && (
        <FormRow label="Extra bans before the last game" for={id('lateBans')}>
          <input id={id('lateBans')} aria-label="Extra bans before the last game" type="number" min={0} max={poolSize} value={String(value.lateBans)}
            onInput={(e) => { const n = Number((e.target as HTMLInputElement).value); if (Number.isInteger(n)) set({ lateBans: n }); }} />
        </FormRow>
      )}
      <FormRow label="Sides" for={id('sides')}>
        <select id={id('sides')} aria-label="Sides" value={value.sides} onChange={(e) => set({ sides: pick(e) as VetoConfig['sides'] })}>
          <option value="non_picker">Team that did not pick chooses</option>
          <option value="higher">Higher seed chooses</option>
          <option value="coin">Coin flip</option>
        </select>
      </FormRow>
      <p class={problem ? 'error' : 'muted'} role={problem ? 'alert' : undefined}>{problem ?? vetoSummary(value, poolSize)}</p>
    </>
  );
}
