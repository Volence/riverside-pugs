/** A stage's campaign order as the prep panel shows it: what was saved,
 *  then the rest of the pool, so every campaign has a place. */
export function fullOrder(pool: string[], saved: string[]): string[] {
  const kept = saved.filter((s) => pool.includes(s));
  return [...kept, ...pool.filter((s) => !kept.includes(s))];
}

export function moveIn(list: string[], i: number, by: -1 | 1): string[] {
  const j = i + by;
  if (j < 0 || j >= list.length) return list;
  const out = [...list];
  [out[i], out[j]] = [out[j]!, out[i]!];
  return out;
}
