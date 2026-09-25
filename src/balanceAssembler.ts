/** Reassembles one go-live's BALANCE parts. Pure and in memory: a lost part
 *  loses that round's tag, and the next round resends the whole inventory. */
interface Part { items: Record<string, string>; sent: number }
interface Pending { parts: Map<number, Part>; firstAt: number }

export class BalanceAssembler {
  private pending = new Map<string, Pending>();
  constructor(private readonly maxAgeMs = 5 * 60 * 1000) {}

  /** `sent` is how many items the line carried, a repeated key counted each
   *  time (logParse's balance_part.sent); defaults to the distinct keys. */
  part(token: string, half: 1 | 2, part: number, items: Record<string, string>, now = Date.now(), sent = Object.keys(items).length): void {
    this.prune(now);
    const key = `${token}:${half}`;
    let p = this.pending.get(key);
    if (!p) { p = { parts: new Map(), firstAt: now }; this.pending.set(key, p); }
    p.parts.set(part, { items, sent });
  }

  /** The inventory, or null when anything is missing. `count` is the
   *  plugin's item count, which counts a key sent twice (a duplicate watch
   *  entry) twice: every item arrived when the items sent add up to it, even
   *  though the inventory has fewer distinct keys. */
  end(token: string, half: 1 | 2, parts: number, count: number, now = Date.now()): Record<string, string> | null {
    const key = `${token}:${half}`;
    const p = this.pending.get(key);
    this.pending.delete(key);
    if (!p || now - p.firstAt > this.maxAgeMs) return null;
    if (p.parts.size !== parts) return null;
    const out: Record<string, string> = {};
    let sent = 0;
    for (let i = 0; i < parts; i++) {
      const got = p.parts.get(i);
      if (!got) return null;
      Object.assign(out, got.items);
      sent += got.sent;
    }
    return sent === count || Object.keys(out).length === count ? out : null;
  }

  private prune(now: number): void {
    for (const [k, p] of this.pending) if (now - p.firstAt > this.maxAgeMs) this.pending.delete(k);
  }
}
