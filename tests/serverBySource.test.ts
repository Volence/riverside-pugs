import { describe, it, expect, afterEach } from 'vitest';
import { openDb } from '../src/db.js';
import { addServer, resolveServerBySource, isKnownServerAddress, _resetAmbiguityReports } from '../src/serverPool.js';
import { subscribeAdminEvents } from '../src/adminFeed.js';

describe('resolveServerBySource', () => {
  it('maps each datagram source to its own server when there are several', () => {
    const db = openDb(':memory:');
    const dallas = addServer(db, { name: 'dallas', host: '45.32.199.85', port: 27015, rconPort: 27015, rconPassword: 'x' });
    const chicago = addServer(db, { name: 'chicago', host: '104.153.111.16', port: 27015, rconPort: 27015, rconPassword: 'y' });
    expect(resolveServerBySource(db, '104.153.111.16', '45.32.199.85')).toBe(chicago);
    expect(resolveServerBySource(db, '45.32.199.85', '45.32.199.85')).toBe(dallas);
    expect(resolveServerBySource(db, '127.0.0.1', '45.32.199.85')).toBe(dallas);
    expect(resolveServerBySource(db, '9.9.9.9', '45.32.199.85')).toBeNull();
  });

  it('with one server, loopback and the feed host still resolve to it', () => {
    const db = openDb(':memory:');
    const only = addServer(db, { name: 's', host: '10.0.0.5', port: 27015, rconPort: 27015, rconPassword: 'x' });
    expect(resolveServerBySource(db, '127.0.0.1', '1.2.3.4')).toBe(only);
    expect(resolveServerBySource(db, '1.2.3.4', '1.2.3.4')).toBe(only);
    expect(resolveServerBySource(db, '8.8.8.8', '1.2.3.4')).toBeNull();
  });
});

// Riverside #3 and #4 are two srcds on one machine, so they share servers.host.
// Resolving on the address alone credited everything #4 sent to #3, and a match
// started in game on #4 was handed back to #3, which answered PUGERR bad token
// (match 73, 2026-09-20). srcds sends its log datagrams from its game socket,
// so the sender's PORT is servers.port.
describe('resolveServerBySource with two servers on one host', () => {
  let unsub: (() => void) | null = null;
  afterEach(() => { unsub?.(); unsub = null; _resetAmbiguityReports(); });

  function riverside() {
    const db = openDb(':memory:');
    const dallas = addServer(db, { name: 'dallas', host: '45.32.199.85', port: 27015, rconPort: 27015, rconPassword: 'x' });
    const r3 = addServer(db, { name: 'riverside3', host: '66.59.208.5', port: 27015, rconPort: 27015, rconPassword: 'x' });
    const r4 = addServer(db, { name: 'riverside4', host: '66.59.208.5', port: 27016, rconPort: 27016, rconPassword: 'x' });
    return { db, dallas, r3, r4 };
  }

  it('tells them apart by the port the datagram came from', () => {
    const { db, r3, r4 } = riverside();
    expect(resolveServerBySource(db, '66.59.208.5', '45.32.199.85', 27015)).toBe(r3);
    expect(resolveServerBySource(db, '66.59.208.5', '45.32.199.85', 27016)).toBe(r4);
  });

  it('resolves NEITHER when the port matches neither, and reports it once', () => {
    const { db } = riverside();
    const problems: string[] = [];
    unsub = subscribeAdminEvents((e) => { if (e.kind === 'problem') problems.push(e.text); });
    expect(resolveServerBySource(db, '66.59.208.5', '45.32.199.85', 40123)).toBeNull();
    expect(resolveServerBySource(db, '66.59.208.5', '45.32.199.85', 40123)).toBeNull();
    expect(resolveServerBySource(db, '66.59.208.5', '45.32.199.85')).toBeNull();
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('66.59.208.5');
    expect(problems[0]).toContain('40123');
    expect(problems[0]).toContain('riverside3');
    expect(problems[0]).toContain('riverside4');
  });

  it('still falls back to the host alone when only one server is on it, whatever the port', () => {
    const { db, dallas } = riverside();
    expect(resolveServerBySource(db, '45.32.199.85', '45.32.199.85', 51000)).toBe(dallas);
    expect(resolveServerBySource(db, '127.0.0.1', '45.32.199.85', 51000)).toBe(dallas);
  });

  it('applies the same rule to two servers behind the feed host', () => {
    const db = openDb(':memory:');
    const a = addServer(db, { name: 'a', host: '45.32.199.85', port: 27015, rconPort: 27015, rconPassword: 'x' });
    const b = addServer(db, { name: 'b', host: '45.32.199.85', port: 27016, rconPort: 27016, rconPassword: 'x' });
    expect(resolveServerBySource(db, '127.0.0.1', '45.32.199.85', 27016)).toBe(b);
    expect(resolveServerBySource(db, '127.0.0.1', '45.32.199.85', 27015)).toBe(a);
    expect(resolveServerBySource(db, '127.0.0.1', '45.32.199.85', 5)).toBeNull();
  });

  it('keeps ADMITTING a shared address it cannot attribute: admission and attribution are different questions', () => {
    const { db } = riverside();
    expect(isKnownServerAddress(db, '66.59.208.5', '45.32.199.85')).toBe(true);
    expect(isKnownServerAddress(db, '127.0.0.1', '45.32.199.85')).toBe(true);
    expect(isKnownServerAddress(db, '9.9.9.9', '45.32.199.85')).toBe(false);
  });
});
