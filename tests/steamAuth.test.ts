import { describe, it, expect, beforeEach } from 'vitest';
import { loginUrl, verifyLogin, fetchPersona, _resetNonces } from '../src/steamAuth.js';

const VALID_QUERY: Record<string, string> = {
  'openid.ns': 'http://specs.openid.net/auth/2.0',
  'openid.mode': 'id_res',
  'openid.claimed_id': 'https://steamcommunity.com/openid/id/76561198000000001',
  'openid.identity': 'https://steamcommunity.com/openid/id/76561198000000001',
  'openid.sig': 'abc',
  'openid.signed': 'signed,op_endpoint,claimed_id',
};

let nonceSeq = 0;
function freshQuery(): Record<string, string> {
  return {
    ...VALID_QUERY,
    // OpenID 2.0 §11.3 disallows fractional seconds in the nonce timestamp.
    'openid.response_nonce': `${new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')}salt${++nonceSeq}`,
  };
}

function fakeFetch(body: string) {
  return async () => new Response(body, { status: 200 });
}

beforeEach(() => _resetNonces());

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
    const id = await verifyLogin(freshQuery(), fakeFetch('ns:http://specs.openid.net/auth/2.0\nis_valid:true\n'));
    expect(id).toBe('76561198000000001');
  });

  it('returns null when steam says is_valid:false', async () => {
    const id = await verifyLogin(freshQuery(), fakeFetch('is_valid:false\n'));
    expect(id).toBeNull();
  });

  it('returns null for a malformed claimed_id even if valid', async () => {
    const q = { ...freshQuery(), 'openid.claimed_id': 'https://evil.example/openid/id/123' };
    const id = await verifyLogin(q, fakeFetch('is_valid:true\n'));
    expect(id).toBeNull();
  });

  it('returns null when the response_nonce is replayed', async () => {
    const q = freshQuery();
    const fetchFn = fakeFetch('is_valid:true\n');
    const first = await verifyLogin(q, fetchFn);
    expect(first).toBe('76561198000000001');
    const second = await verifyLogin(q, fetchFn);
    expect(second).toBeNull();
  });

  it('returns null when the response_nonce is stale', async () => {
    const q = { ...VALID_QUERY, 'openid.response_nonce': '2020-01-01T00:00:00Zoldsalt' };
    const id = await verifyLogin(q, fakeFetch('is_valid:true\n'));
    expect(id).toBeNull();
  });

  it('returns null when the response_nonce is missing', async () => {
    const q = { ...VALID_QUERY };
    delete q['openid.response_nonce'];
    const id = await verifyLogin(q, fakeFetch('is_valid:true\n'));
    expect(id).toBeNull();
  });
});

describe('fetchPersona', () => {
  it('falls back to steamid when apiKey is null, without calling fetch', async () => {
    const steamid = '76561198000000001';
    const fetchFn = async (): Promise<Response> => {
      throw new Error('fetch should not be called when apiKey is null');
    };
    const persona = await fetchPersona(steamid, null, fetchFn);
    expect(persona).toEqual({ name: steamid, avatar: null });
  });

  it('returns the persona name and avatar on a successful lookup', async () => {
    const steamid = '76561198000000001';
    const fetchFn = async () =>
      new Response(
        JSON.stringify({ response: { players: [{ personaname: 'alice', avatarfull: 'a.jpg' }] } }),
      );
    const persona = await fetchPersona(steamid, 'key', fetchFn);
    expect(persona).toEqual({ name: 'alice', avatar: 'a.jpg' });
  });

  it('falls back to steamid when fetch throws', async () => {
    const steamid = '76561198000000001';
    const fetchFn = async (): Promise<Response> => {
      throw new Error('network error');
    };
    const persona = await fetchPersona(steamid, 'key', fetchFn);
    expect(persona).toEqual({ name: steamid, avatar: null });
  });
});
