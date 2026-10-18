import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import {
  currentAsnTable, ipToU32, loadAsnFile, parseIp2AsnTsv, refreshAsnTable, setAsnTable,
} from '../src/asnTable.js';

const SAMPLE = readFileSync(join(import.meta.dirname, 'fixtures/ip2asn-v4-sample.tsv'), 'utf8');
const gz = gzipSync(Buffer.from(SAMPLE));
const okFetch = (async () => new Response(gz as unknown as BodyInit)) as unknown as typeof fetch;

beforeEach(() => setAsnTable(null));

describe('ipToU32', () => {
  it('reads a dotted address and refuses anything else', () => {
    expect(ipToU32('1.0.0.0')).toBe(16777216);
    expect(ipToU32('255.255.255.255')).toBe(4294967295);
    expect(ipToU32('256.1.1.1')).toBeNull();
    expect(ipToU32('::1')).toBeNull();
  });
});

describe('parseIp2AsnTsv', () => {
  const t = parseIp2AsnTsv(SAMPLE);

  it('keeps routed ranges and skips "Not routed" and junk', () => {
    expect(t.size).toBe(4);
    expect(t.lookup('1.0.2.1')).toBeNull();
  });

  it('finds an address inside a range, at both edges', () => {
    expect(t.lookup('198.51.100.7')).toEqual({ asn: 212238, org: 'DATACAMP-LIMITED' });
    expect(t.lookup('45.76.0.0')?.asn).toBe(20473);
    expect(t.lookup('45.76.255.255')?.asn).toBe(20473);
  });

  it('returns null between ranges, past the last, and for a bad address', () => {
    expect(t.lookup('203.0.113.200')).toBeNull();
    expect(t.lookup('250.0.0.1')).toBeNull();
    expect(t.lookup('not an ip')).toBeNull();
  });
});

describe('loading and refreshing', () => {
  const dir = () => mkdtempSync(join(tmpdir(), 'asn-'));

  it('loads a gzipped file from disk', () => {
    const path = join(dir(), 'ip2asn-v4.tsv.gz');
    writeFileSync(path, gz);
    expect(loadAsnFile(path).lookup('1.0.0.9')?.asn).toBe(13335);
  });

  it('downloads when there is no file, then is fresh for a week', async () => {
    const path = join(dir(), 'ip2asn-v4.tsv.gz');
    expect(await refreshAsnTable({ path, fetchFn: okFetch, minRanges: 1 })).toBe('downloaded');
    expect(existsSync(path)).toBe(true);
    expect(currentAsnTable()?.lookup('198.51.100.1')?.asn).toBe(212238);
    let called = false;
    const spy = (async () => { called = true; return new Response(gz as unknown as BodyInit); }) as unknown as typeof fetch;
    expect(await refreshAsnTable({ path, fetchFn: spy, minRanges: 1 })).toBe('fresh');
    expect(called).toBe(false);
  });

  it('never replaces a working file with a bad download', async () => {
    const path = join(dir(), 'ip2asn-v4.tsv.gz');
    writeFileSync(path, gz);
    const old = readFileSync(path);
    const bad = (async () => new Response('<html>rate limited</html>')) as unknown as typeof fetch;
    const r = await refreshAsnTable({ path, fetchFn: bad, maxAgeMs: 0, minRanges: 1 });
    expect(r).toBe('failed');
    expect(readFileSync(path).equals(old)).toBe(true);
    expect(currentAsnTable()?.lookup('1.0.0.1')?.asn).toBe(13335); // fell back to the file
  });

  it('refuses a download with too few ranges', async () => {
    const path = join(dir(), 'ip2asn-v4.tsv.gz');
    expect(await refreshAsnTable({ path, fetchFn: okFetch })).toBe('failed'); // 4 < MIN_RANGES
    expect(existsSync(path)).toBe(false);
    expect(currentAsnTable()).toBeNull();
  });

  it('replaces a fresh but corrupt file with a valid download', async () => {
    const path = join(dir(), 'ip2asn-v4.tsv.gz');
    writeFileSync(path, Buffer.alloc(0));
    expect(await refreshAsnTable({ path, fetchFn: okFetch, minRanges: 1 })).toBe('downloaded');
    expect(readFileSync(path).equals(gz)).toBe(true);
    expect(currentAsnTable()?.lookup('1.0.0.1')?.asn).toBe(13335);
  });

  it('keeps the table in memory when a corrupt file meets a failing download', async () => {
    const path = join(dir(), 'ip2asn-v4.tsv.gz');
    writeFileSync(path, Buffer.from('not gzip'));
    const boom = (async () => { throw new Error('offline'); }) as unknown as typeof fetch;
    expect(await refreshAsnTable({ path, fetchFn: boom, minRanges: 1 })).toBe('failed'); // resolves, never rejects
    expect(readFileSync(path).toString()).toBe('not gzip');
    expect(currentAsnTable()).toBeNull();
    // with a table already in memory, a failing download leaves it in place
    setAsnTable(parseIp2AsnTsv(SAMPLE));
    expect(await refreshAsnTable({ path, fetchFn: boom, maxAgeMs: 0, minRanges: 1 })).toBe('failed');
    expect(currentAsnTable()?.lookup('1.0.0.1')?.asn).toBe(13335);
  });

  it('fails on a non-200 response and leaves the file alone', async () => {
    const path = join(dir(), 'ip2asn-v4.tsv.gz');
    writeFileSync(path, gz);
    const old = readFileSync(path);
    const f = (async () => new Response('nope', { status: 503 })) as unknown as typeof fetch;
    expect(await refreshAsnTable({ path, fetchFn: f, maxAgeMs: 0, minRanges: 1 })).toBe('failed');
    expect(readFileSync(path).equals(old)).toBe(true);
  });

  it('fails on a truncated gzip body and leaves the file alone', async () => {
    const path = join(dir(), 'ip2asn-v4.tsv.gz');
    writeFileSync(path, gz);
    const old = readFileSync(path);
    const cut = gz.subarray(0, gz.length - 12);
    const f = (async () => new Response(cut as unknown as BodyInit)) as unknown as typeof fetch;
    expect(await refreshAsnTable({ path, fetchFn: f, maxAgeMs: 0, minRanges: 1 })).toBe('failed');
    expect(readFileSync(path).equals(old)).toBe(true);
  });
});
