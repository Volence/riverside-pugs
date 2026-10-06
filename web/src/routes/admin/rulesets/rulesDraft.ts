import type { EditableRules, MatchRules } from '../../../api';
import { readWhole } from '../events/wholeNumber';

/**
 * The Rulesets editor's number fields, kept as typed and read only at Save
 * (like the stage form): a blank pause limit or length means no limit and is
 * sent as null, never 0; a blank technical pauses or no-show grace is an
 * error the form shows without sending anything. The server
 * (src/rulesetStore.ts readEditableRules) judges every range. The
 * Tournament play numbers (plan T5) are read the same way; blank is an error.
 */
export interface RulesTyped {
  limit: string; seconds: string; techPauses: string; grace: string;
  /** Plan T5: the Tournament play group. */
  techSeconds: string; reconnect: string; subs: string; subCharge: string; cooldown: string; nextGame: string;
}

export function editableFrom(r: MatchRules): EditableRules {
  const { rated: _rated, penalties: _penalties, ...rest } = r;
  return rest;
}

export function typedFrom(r: EditableRules): RulesTyped {
  return {
    limit: r.pause.limit === null ? '' : String(r.pause.limit),
    seconds: r.pause.seconds === null ? '' : String(r.pause.seconds),
    techPauses: String(r.pause.techPauses),
    grace: String(r.noShowGraceMinutes),
    techSeconds: String(r.pause.techSeconds),
    reconnect: String(r.disconnect.teamSeconds),
    subs: String(r.subs.perMatch),
    subCharge: String(r.subs.emergencyChargeSeconds),
    cooldown: String(r.staffCall.cooldownSeconds),
    nextGame: String(r.series.nextGameSeconds),
  };
}

export function readRules(base: EditableRules, typed: RulesTyped): { ok: true; value: EditableRules } | { ok: false; error: string } {
  const limit = readWhole(typed.limit, 'Pauses per team', true);
  if (!limit.ok) return limit;
  const seconds = readWhole(typed.seconds, 'Pause length', true);
  if (!seconds.ok) return seconds;
  const tech = readWhole(typed.techPauses, 'Technical pauses', false);
  if (!tech.ok) return tech;
  const grace = readWhole(typed.grace, 'No-show grace', false);
  if (!grace.ok) return grace;
  // Plan T5: blank is an error for each, like the grace; the server judges the ranges.
  const nums: [keyof RulesTyped, string][] = [['techSeconds', 'Technical time'], ['reconnect', 'Reconnect time'], ['subs', 'Subs per match'],
    ['subCharge', 'Emergency sub cost'], ['cooldown', '!admin cooldown'], ['nextGame', 'Next game after']];
  const got: Partial<Record<keyof RulesTyped, number>> = {};
  for (const [k, label] of nums) {
    const r = readWhole(typed[k], label, false);
    if (!r.ok) return r;
    got[k] = r.value as number;
  }
  return {
    ok: true,
    value: {
      ...base,
      pause: { ...base.pause, limit: limit.value, seconds: seconds.value, techPauses: tech.value as number, techSeconds: got.techSeconds! },
      noShowGraceMinutes: grace.value as number,
      subs: { ...base.subs, perMatch: got.subs!, emergencyChargeSeconds: got.subCharge! },
      disconnect: { teamSeconds: got.reconnect! },
      staffCall: { cooldownSeconds: got.cooldown! },
      series: { nextGameSeconds: got.nextGame! },
    },
  };
}
