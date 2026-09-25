import { describe, expect, it } from 'vitest';
import { BalanceAssembler } from '../src/balanceAssembler.js';

const T = 'a'.repeat(32);

describe('BalanceAssembler', () => {
  it('joins parts when the END counts match', () => {
    const a = new BalanceAssembler();
    a.part(T, 1, 0, { 'c:x': '1' }, 0);
    a.part(T, 1, 1, { 'c:y': '2', 'p:z.smx': '3.aa' }, 1);
    expect(a.end(T, 1, 2, 3, 2)).toEqual({ 'c:x': '1', 'c:y': '2', 'p:z.smx': '3.aa' });
  });

  it('returns null when a part is missing or the item count is off', () => {
    const a = new BalanceAssembler();
    a.part(T, 1, 1, { 'c:y': '2' }, 0);
    expect(a.end(T, 1, 2, 1, 1)).toBeNull();
    a.part(T, 2, 0, { 'c:y': '2' }, 0);
    expect(a.end(T, 2, 1, 5, 1)).toBeNull();
  });

  it('a duplicated datagram does not double count', () => {
    const a = new BalanceAssembler();
    a.part(T, 1, 0, { 'c:x': '1' }, 0);
    a.part(T, 1, 0, { 'c:x': '1' }, 0);
    expect(a.end(T, 1, 1, 1, 1)).toEqual({ 'c:x': '1' });
  });

  it('a key the plugin sent twice (a duplicate watch entry) still assembles', () => {
    const a = new BalanceAssembler();
    // Part 0 carried f:x twice (the parser collapses it, sent says 3); part 1
    // repeats c:y from part 0.
    a.part(T, 1, 0, { 'f:x': '1.a', 'c:y': '2' }, 0, 3);
    a.part(T, 1, 1, { 'c:y': '2', 'p:z.smx': '3.aa' }, 0, 2);
    expect(a.end(T, 1, 2, 5, 1)).toEqual({ 'f:x': '1.a', 'c:y': '2', 'p:z.smx': '3.aa' });
    // A genuinely lost item is still a lost round.
    a.part(T, 2, 0, { 'c:y': '2' }, 0, 1);
    expect(a.end(T, 2, 1, 2, 1)).toBeNull();
  });

  it('forgets a round after END and drops stale partials', () => {
    const a = new BalanceAssembler(1000);
    a.part(T, 1, 0, { 'c:x': '1' }, 0);
    expect(a.end(T, 1, 1, 1, 5000)).toBeNull(); // too old
    expect(a.end(T, 1, 1, 1, 5001)).toBeNull(); // already forgotten
  });
});
