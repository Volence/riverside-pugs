import { describe, it, expect } from 'vitest';
import { openDb } from '../src/db.js';
import { addServer, resolveServerBySource } from '../src/serverPool.js';

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
