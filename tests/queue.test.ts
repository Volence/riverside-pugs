import { describe, it, expect } from 'vitest';
import { Queue } from '../src/queue.js';

describe('Queue', () => {
  it('joins are ordered and idempotent', () => {
    const q = new Queue();
    q.join('a'); q.join('b'); q.join('a');
    expect(q.count()).toBe(2);
    expect(q.list()).toEqual(['a', 'b']);
    expect(q.has('a')).toBe(true);
  });

  it('leave removes', () => {
    const q = new Queue();
    q.join('a'); q.join('b'); q.leave('a');
    expect(q.list()).toEqual(['b']);
  });

  it('takeBatch pops the first n in order', () => {
    const q = new Queue();
    for (const id of ['a', 'b', 'c']) q.join(id);
    expect(q.takeBatch(2)).toEqual(['a', 'b']);
    expect(q.list()).toEqual(['c']);
  });

  it('requeueFront puts players ahead of existing queue', () => {
    const q = new Queue();
    q.join('x');
    q.requeueFront(['a', 'b']);
    expect(q.list()).toEqual(['a', 'b', 'x']);
  });
});
