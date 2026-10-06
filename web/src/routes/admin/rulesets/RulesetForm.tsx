import { useId, useState } from 'preact/hooks';
import type { AdminRuleset, EditableRules, MatchRules } from '../../../api';
import { FormGroup, FormRow, ToggleRow } from '../events/FormRow';
import { editableFrom, readRules, typedFrom, type RulesTyped } from './rulesDraft';

const BOSSES: [MatchRules['bosses'], string][] = [
  ['random_published', 'Random, shown in game'], ['fixed', 'Fixed'], ['voteboss', 'Voted by the teams'],
];
const SIDE_RULES: [MatchRules['sideRule'], string][] = [
  ['higher_seed_chooses', 'Higher seed picks sides'], ['non_picker_chooses', 'Non-picker picks sides'], ['coin', 'Coin toss'],
];
const val = (e: Event): string => (e.target as HTMLInputElement).value;

/** One ruleset's name and rules, laid out like the Settings desk. Rated and
 *  penalties are not here: only PUG has them, and PUG is read only. Saving
 *  hands the name and rules up; the desk sends them. */
export function RulesetForm({ ruleset, rules, busy, error, onSave, onCancel }: {
  ruleset: AdminRuleset; rules: MatchRules; busy: boolean; error?: string; onSave: (name: string, rules: EditableRules) => void; onCancel: () => void;
}) {
  const [name, setName] = useState(ruleset.name);
  const [d, setD] = useState<EditableRules>(() => editableFrom(rules));
  const [typed, setTyped] = useState<RulesTyped>(() => typedFrom(editableFrom(rules)));
  const [problem, setProblem] = useState<string | null>(null);
  const uid = useId();
  const id = (k: string): string => `${uid}-${k}`;
  const set = (patch: Partial<EditableRules>) => setD((x) => ({ ...x, ...patch }));
  const type = (k: keyof RulesTyped) => (e: Event) => { const v = val(e); setTyped((x) => ({ ...x, [k]: v })); };
  const submit = (e: Event) => {
    e.preventDefault();
    const r = readRules(d, typed);
    if (!r.ok) { setProblem(r.error); return; }
    setProblem(null);
    onSave(name, r.value);
  };

  return (
    <form class="eventform eventform--stage" onSubmit={submit}>
      {problem && <p class="error" role="alert">{problem}</p>}
      <FormGroup title="Ruleset">
        <FormRow label="Name" help={ruleset.template ? 'A built-in ruleset keeps its name.' : '3 to 40 characters, not used by another ruleset.'} for={id('name')}>
          <input id={id('name')} aria-label="Ruleset name" value={name} maxLength={40} disabled={ruleset.template} onInput={(e) => setName(val(e))} />
        </FormRow>
      </FormGroup>
      <FormGroup title="Pauses">
        <FormRow label="Pauses per team" help="Blank for no limit. (0 to 10)" for={id('limit')}>
          <input id={id('limit')} aria-label="Pauses per team" type="number" min={0} max={10} value={typed.limit} onInput={type('limit')} />
        </FormRow>
        <FormRow label="Pause length" help="Seconds each. Blank for no limit. (30 to 600)" for={id('seconds')}>
          <input id={id('seconds')} aria-label="Pause length" type="number" min={30} max={600} value={typed.seconds} onInput={type('seconds')} />
        </FormRow>
        <ToggleRow label="Both teams unpause" help="Unpausing needs both teams to type !unpause." checked={d.pause.mutualUnpause}
          onChange={() => set({ pause: { ...d.pause, mutualUnpause: !d.pause.mutualUnpause } })} />
        <FormRow label="Technical pauses" help="Technical pauses (!tech) each team may call per game. 0 turns them off. (0 to 5)" for={id('tech')}>
          <input id={id('tech')} aria-label="Technical pauses" type="number" min={0} max={5} value={typed.techPauses} onInput={type('techPauses')} />
        </FormRow>
      </FormGroup>
      <FormGroup title="Match">
        <ToggleRow label="Team lock" help="Rostered players stay on their side." checked={d.teamLock} onChange={() => set({ teamLock: !d.teamLock })} />
        <ToggleRow label="Players control the map" help="Players may use !nextmap and !stay and change the campaign." checked={d.playerMapControl}
          onChange={() => set({ playerMapControl: !d.playerMapControl })} />
        <ToggleRow label="Restart a half" help="Both teams may !restart the half they are playing." checked={d.restartHalf.allowed}
          onChange={() => set({ restartHalf: { allowed: !d.restartHalf.allowed, lockAfterDamage: false } })} />
        {d.restartHalf.allowed && (
          <ToggleRow label="Only before damage" help="No restart once a team has done damage." checked={d.restartHalf.lockAfterDamage}
            onChange={() => set({ restartHalf: { allowed: true, lockAfterDamage: !d.restartHalf.lockAfterDamage } })} />
        )}
        <FormRow label="No-show grace" help="Minutes a side has to arrive. (5 to 60)" for={id('grace')}>
          <input id={id('grace')} aria-label="No-show grace" type="number" min={5} max={60} value={typed.grace} onInput={type('grace')} />
        </FormRow>
        <FormRow label="Boss spawns" for={id('bosses')}>
          <select id={id('bosses')} aria-label="Boss spawns" value={d.bosses} onChange={(e) => set({ bosses: val(e) as MatchRules['bosses'] })}>
            {BOSSES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </select>
        </FormRow>
        <FormRow label="Side choice" for={id('side')}>
          <select id={id('side')} aria-label="Side choice" value={d.sideRule} onChange={(e) => set({ sideRule: val(e) as MatchRules['sideRule'] })}>
            {SIDE_RULES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </select>
        </FormRow>
        <ToggleRow label="Side-locked spectating" help="Team spectators see only their own side." checked={d.spectate.sideLocked}
          onChange={() => set({ spectate: { sideLocked: !d.spectate.sideLocked } })} />
      </FormGroup>
      <FormGroup title="Tournament play">
        <p class="muted">These apply on tournament servers only. PUGs and scrims never use them.</p>
        <FormRow label="Technical time" help="Seconds each team has per game for !tech pauses. Past it a pause uses the team's tactical pauses, then the game unpauses. (60 to 1800)" for={id('techSeconds')}>
          <input id={id('techSeconds')} aria-label="Technical time" type="number" min={60} max={1800} value={typed.techSeconds} onInput={type('techSeconds')} />
        </FormRow>
        <FormRow label="Reconnect time" help="Seconds per team per game while a player is disconnected (the game is paused). At zero the team forfeits the game. (60 to 3600)" for={id('reconnect')}>
          <input id={id('reconnect')} aria-label="Reconnect time" type="number" min={60} max={3600} value={typed.reconnect} onInput={type('reconnect')} />
        </FormRow>
        <FormRow label="Subs per match" help="Substitutions each team may make in a match. (0 to 4)" for={id('subs')}>
          <input id={id('subs')} aria-label="Subs per match" type="number" min={0} max={4} value={typed.subs} onInput={type('subs')} />
        </FormRow>
        <ToggleRow label="Emergency subs" help="While the game is paused for a disconnected player, a captain may !sub a bench player into that slot mid-chapter. It uses one of the match's subs." checked={d.subs.emergency}
          onChange={() => set({ subs: { ...d.subs, emergency: !d.subs.emergency } })} />
        {d.subs.emergency && (
          <FormRow label="Emergency sub cost" help="Seconds of the team's reconnect time an emergency sub uses. 0 for none. (0 to 600)" for={id('subCharge')}>
            <input id={id('subCharge')} aria-label="Emergency sub cost" type="number" min={0} max={600} value={typed.subCharge} onInput={type('subCharge')} />
          </FormRow>
        )}
        <FormRow label="!admin cooldown" help="Seconds before the same player can call staff with !admin again. (30 to 600)" for={id('cooldown')}>
          <input id={id('cooldown')} aria-label="!admin cooldown" type="number" min={30} max={600} value={typed.cooldown} onInput={type('cooldown')} />
        </FormRow>
        <FormRow label="Next game after" help="Seconds between two games of a series. The server loads the next game on its next minute pass after this. (30 to 600)" for={id('nextGame')}>
          <input id={id('nextGame')} aria-label="Next game after" type="number" min={30} max={600} value={typed.nextGame} onInput={type('nextGame')} />
        </FormRow>
      </FormGroup>
      <div class="eventform__actions">
        <button class="btn" type="submit" disabled={busy}>Save ruleset</button>
        <button class="btn btn--ghost" type="button" onClick={onCancel}>Cancel</button>
        {error && <p class="error" role="alert">{error}</p>}
      </div>
    </form>
  );
}
