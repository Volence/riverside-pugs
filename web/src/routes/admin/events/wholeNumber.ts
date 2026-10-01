/**
 * A number typed into an event or stage form. Number('') is 0 and anything
 * else unreadable is NaN (sent as null in JSON), and either would quietly
 * change a rule, so a field is read here instead: blank is null only where
 * null means "not set" (a team cap, an SR bound, an advance count), and is
 * otherwise an error the form shows without sending anything.
 */
export type WholeNumber = { ok: true; value: number | null } | { ok: false; error: string };

export function readWhole(raw: string, label: string, blankIsNone: boolean): WholeNumber {
  const t = raw.trim();
  if (t === '') return blankIsNone ? { ok: true, value: null } : { ok: false, error: `${label} needs a whole number.` };
  if (!/^-?\d+$/.test(t)) return { ok: false, error: `${label} needs a whole number${blankIsNone ? ', or leave it blank' : ''}.` };
  return { ok: true, value: Number(t) };
}
