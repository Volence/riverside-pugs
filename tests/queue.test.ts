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

describe('Queue stints', () => {
  const rig = () => {
    let t = 1000;
    const ended: import('../src/queue.js').QueueStint[] = [];
    const q = new Queue({ now: () => t, onStintEnd: (s) => ended.push(s) });
    return { q, ended, at: (ms: number) => { t = ms; } };
  };

  it('a pop ends each taken stint as popped, with its own join time', () => {
    const { q, ended, at } = rig();
    q.join('a'); at(5000); q.join('b'); at(9000);
    q.takeBatch(2);
    expect(ended).toEqual([
      { steamid: 'a', joinedAt: 1000, endedAt: 9000, outcome: 'popped', requeued: false },
      { steamid: 'b', joinedAt: 5000, endedAt: 9000, outcome: 'popped', requeued: false },
    ]);
  });

  it('leaving ends the stint as left; leaving when not queued records nothing', () => {
    const { q, ended, at } = rig();
    q.join('a'); at(4000); q.leave('a'); q.leave('a'); q.leave('zz');
    expect(ended).toEqual([{ steamid: 'a', joinedAt: 1000, endedAt: 4000, outcome: 'left', requeued: false }]);
  });

  it('a second join while queued keeps the first join time', () => {
    const { q, ended, at } = rig();
    q.join('a'); at(3000); q.join('a'); at(6000); q.takeBatch(1);
    expect(ended[0].joinedAt).toBe(1000);
  });

  it('a requeue after a failed pop starts a new stint marked requeued', () => {
    const { q, ended, at } = rig();
    q.join('a'); at(2000); q.takeBatch(1);
    at(3000); q.requeueFront(['a']);
    at(7000); q.takeBatch(1);
    expect(ended[1]).toEqual({ steamid: 'a', joinedAt: 3000, endedAt: 7000, outcome: 'popped', requeued: true });
  });

  it('a restored join time is kept and exposed for saving', () => {
    const { q, ended, at } = rig();
    q.join('a', 500); q.join('b');
    expect(q.joinTimes()).toEqual({ a: 500, b: 1000 });
    at(2000); q.takeBatch(1);
    expect(ended[0].joinedAt).toBe(500);
  });

  it('a throwing hook never breaks the queue', () => {
    const q = new Queue({ onStintEnd: () => { throw new Error('boom'); } });
    q.join('a'); q.join('b');
    expect(q.takeBatch(1)).toEqual(['a']);
    expect(q.list()).toEqual(['b']);
  });
});

describe('Queue requeue flag survives a restore', () => {
  it('a restored requeued stint stays marked requeued', () => {
    const ended: import('../src/queue.js').QueueStint[] = [];
    const q = new Queue({ now: () => 10, onStintEnd: (s) => ended.push(s) });
    q.requeueFront(['a']); q.join('b');
    expect(q.requeuedIds()).toEqual(['a']);
    const r = new Queue({ now: () => 20, onStintEnd: (s) => ended.push(s) });
    r.join('a', 10, true); r.takeBatch(1);
    expect(ended[0].requeued).toBe(true);
  });
});
