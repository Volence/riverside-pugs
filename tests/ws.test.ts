import { describe, it, expect } from 'vitest';
import { Hub } from '../src/ws.js';

function fakeSocket() {
  const sent: string[] = [];
  return { sent, readyState: 1, send: (msg: string) => sent.push(msg) };
}

describe('Hub', () => {
  it('broadcasts to all open sockets', () => {
    const hub = new Hub();
    const s1 = fakeSocket();
    const s2 = fakeSocket();
    hub.add(s1 as any);
    hub.add(s2 as any);
    hub.broadcast('refresh');
    expect(s1.sent).toEqual(['{"event":"refresh"}']);
    expect(s2.sent).toEqual(['{"event":"refresh"}']);
  });

  it('skips closed sockets and removed sockets', () => {
    const hub = new Hub();
    const open = fakeSocket();
    const closed = { ...fakeSocket(), readyState: 3 };
    const removed = fakeSocket();
    hub.add(open as any);
    hub.add(closed as any);
    hub.add(removed as any);
    hub.remove(removed as any);
    hub.broadcast('refresh');
    expect(open.sent).toHaveLength(1);
    expect(closed.sent).toHaveLength(0);
    expect(removed.sent).toHaveLength(0);
  });
});
