import { describe, it, expect } from 'vitest';
import { loginUrl, verifyLogin } from '../src/steamAuth.js';

const VALID_QUERY: Record<string, string> = {
  'openid.ns': 'http://specs.openid.net/auth/2.0',
  'openid.mode': 'id_res',
  'openid.claimed_id': 'https://steamcommunity.com/openid/id/76561198000000001',
  'openid.identity': 'https://steamcommunity.com/openid/id/76561198000000001',
  'openid.sig': 'abc',
  'openid.signed': 'signed,op_endpoint,claimed_id',
};

function fakeFetch(body: string) {
  return async () => new Response(body, { status: 200 });
}

describe('loginUrl', () => {
  it('builds a checkid_setup redirect to steam', () => {
    const url = new URL(loginUrl('http://localhost:8080'));
    expect(url.origin + url.pathname).toBe('https://steamcommunity.com/openid/login');
    expect(url.searchParams.get('openid.mode')).toBe('checkid_setup');
    expect(url.searchParams.get('openid.return_to')).toBe('http://localhost:8080/auth/steam/return');
    expect(url.searchParams.get('openid.realm')).toBe('http://localhost:8080');
  });
});

describe('verifyLogin', () => {
  it('returns steamid64 when steam says is_valid:true', async () => {
    const id = await verifyLogin(VALID_QUERY, fakeFetch('ns:http://specs.openid.net/auth/2.0\nis_valid:true\n'));
    expect(id).toBe('76561198000000001');
  });

  it('returns null when steam says is_valid:false', async () => {
    const id = await verifyLogin(VALID_QUERY, fakeFetch('is_valid:false\n'));
    expect(id).toBeNull();
  });

  it('returns null for a malformed claimed_id even if valid', async () => {
    const q = { ...VALID_QUERY, 'openid.claimed_id': 'https://evil.example/openid/id/123' };
    const id = await verifyLogin(q, fakeFetch('is_valid:true\n'));
    expect(id).toBeNull();
  });
});
