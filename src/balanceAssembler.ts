/** Reassembles one go-live's BALANCE parts. Pure and in memory: a lost part
 *  loses that round's tag, and the next round resends the whole inventory. */
interface Pending { parts: Map<number, Record<string, string>>; firstAt: number }

export class BalanceAssembler {
  private pending = new Map<string, Pending>();
  constructor(private readonly maxAgeMs = 5 * 60 * 1000) {}

  part(token: string, half: 1 | 2, part: number, items: Record<string, string>, now = Date.now()): void {
    this.prune(now);
    const key = `${token}:${half}`;
    let p = this.pending.get(key);
    if (!p) { p = { parts: new Map(), firstAt: now }; this.pending.set(key, p); }
    p.parts.set(part, items);
  }

  end(token: string, half: 1 | 2, parts: number, count: number, now = Date.now()): Record<string, string> | null {
    const key = `${token}:${half}`;
    const p = this.pending.get(key);
    this.pending.delete(key);
    if (!p || now - p.firstAt > this.maxAgeMs) return null;
    if (p.parts.size !== parts) return null;
    const out: Record<string, string> = {};
    for (let i = 0; i < parts; i++) {
      const items = p.parts.get(i);
      if (!items) return null;
      Object.assign(out, items);
    }
    return Object.keys(out).length === count ? out : null;
  }

  private prune(now: number): void {
    for (const [k, p] of this.pending) if (now - p.firstAt > this.maxAgeMs) this.pending.delete(k);
  }
}
