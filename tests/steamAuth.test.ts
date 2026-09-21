import { describe, it, expect, beforeEach } from 'vitest';
import { loginUrl, steamReturnUrl, verifyLogin, fetchPersona, _resetNonces } from '../src/steamAuth.js';

const PUBLIC_URL = 'https://pug.example';
const RETURN_TO = steamReturnUrl(PUBLIC_URL);

const VALID_QUERY: Record<string, string> = {
  'openid.ns': 'http://specs.openid.net/auth/2.0',
  'openid.mode': 'id_res',
  'openid.claimed_id': 'https://steamcommunity.com/openid/id/76561198000000001',
  'openid.identity': 'https://steamcommunity.com/openid/id/76561198000000001',
  'openid.op_endpoint': 'https://steamcommunity.com/openid/login',
  'openid.return_to': RETURN_TO,
  'openid.sig': 'abc',
  'openid.signed': 'signed,op_endpoint,claimed_id,identity,return_to,response_nonce,assoc_handle',
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

  it('sends the same return_to that verifyLogin will demand', () => {
    const url = new URL(loginUrl(PUBLIC_URL));
    expect(url.searchParams.get('openid.return_to')).toBe(RETURN_TO);
  });

  it('does not double the slash when PUBLIC_URL ends in one', () => {
    expect(steamReturnUrl('https://pug.example/')).toBe('https://pug.example/auth/steam/return');
    const url = new URL(loginUrl('https://pug.example/'));
    expect(url.searchParams.get('openid.return_to')).toBe('https://pug.example/auth/steam/return');
  });
});

describe('verifyLogin', () => {
  it('returns steamid64 when steam says is_valid:true', async () => {
    const id = await verifyLogin(freshQuery(), RETURN_TO, fakeFetch('ns:http://specs.openid.net/auth/2.0\nis_valid:true\n'));
    expect(id).toBe('76561198000000001');
  });

  it('returns null when steam says is_valid:false', async () => {
    const id = await verifyLogin(freshQuery(), RETURN_TO, fakeFetch('is_valid:false\n'));
    expect(id).toBeNull();
  });

  it('returns null for a malformed claimed_id even if valid', async () => {
    const q = { ...freshQuery(), 'openid.claimed_id': 'https://evil.example/openid/id/123' };
    const id = await verifyLogin(q, RETURN_TO, fakeFetch('is_valid:true\n'));
    expect(id).toBeNull();
  });

  it('returns null when the response_nonce is replayed', async () => {
    const q = freshQuery();
    const fetchFn = fakeFetch('is_valid:true\n');
    const first = await verifyLogin(q, RETURN_TO, fetchFn);
    expect(first).toBe('76561198000000001');
    const second = await verifyLogin(q, RETURN_TO, fetchFn);
    expect(second).toBeNull();
  });

  it('returns null when the response_nonce is stale', async () => {
    const q = { ...VALID_QUERY, 'openid.response_nonce': '2020-01-01T00:00:00Zoldsalt' };
    const id = await verifyLogin(q, RETURN_TO, fakeFetch('is_valid:true\n'));
    expect(id).toBeNull();
  });

  // An assertion Steam signed for some other "Sign in through Steam" site is
  // perfectly valid to Steam. Only return_to says who it was issued for.
  function neverFetch(): Promise<Response> {
    throw new Error('must be rejected before asking steam');
  }

  it('rejects an assertion issued for another site', async () => {
    const q = { ...freshQuery(), 'openid.return_to': 'https://other.example/auth/steam/return' };
    expect(await verifyLogin(q, RETURN_TO, neverFetch)).toBeNull();
  });

  it('rejects a return_to that only starts with ours', async () => {
    const q = { ...freshQuery(), 'openid.return_to': `${RETURN_TO}?x=1` };
    expect(await verifyLogin(q, RETURN_TO, neverFetch)).toBeNull();
  });

  it('rejects a missing return_to', async () => {
    const q = freshQuery();
    delete q['openid.return_to'];
    expect(await verifyLogin(q, RETURN_TO, neverFetch)).toBeNull();
  });

  it.each(['return_to', 'claimed_id', 'identity', 'response_nonce'])(
    'rejects when %s is not in the signed list', async (field) => {
      const q = freshQuery();
      q['openid.signed'] = q['openid.signed'].split(',').filter((f) => f !== field).join(',');
      expect(await verifyLogin(q, RETURN_TO, neverFetch)).toBeNull();
    });

  it('rejects a missing signed list', async () => {
    const q = freshQuery();
    delete q['openid.signed'];
    expect(await verifyLogin(q, RETURN_TO, neverFetch)).toBeNull();
  });

  it('rejects a repeated parameter, which arrives as an array', async () => {
    const q = freshQuery() as Record<string, unknown>;
    q['openid.return_to'] = [RETURN_TO, 'https://other.example/'];
    expect(await verifyLogin(q as Record<string, string>, RETURN_TO, neverFetch)).toBeNull();
    q['openid.return_to'] = RETURN_TO;
    q['openid.signed'] = ['return_to', 'claimed_id'];
    expect(await verifyLogin(q as Record<string, string>, RETURN_TO, neverFetch)).toBeNull();
  });

  it('rejects an op_endpoint that is not steam', async () => {
    const q = { ...freshQuery(), 'openid.op_endpoint': 'https://evil.example/openid/login' };
    expect(await verifyLogin(q, RETURN_TO, neverFetch)).toBeNull();
  });

  it('accepts a response with no op_endpoint at all', async () => {
    const q = freshQuery();
    delete q['openid.op_endpoint'];
    expect(await verifyLogin(q, RETURN_TO, fakeFetch('is_valid:true\n'))).toBe('76561198000000001');
  });

  it('does not burn the nonce on a rejected assertion', async () => {
    const q = freshQuery();
    const bad = { ...q, 'openid.return_to': 'https://other.example/auth/steam/return' };
    expect(await verifyLogin(bad, RETURN_TO, neverFetch)).toBeNull();
    expect(await verifyLogin(q, RETURN_TO, fakeFetch('is_valid:true\n'))).toBe('76561198000000001');
  });

  it('returns null when the response_nonce is missing', async () => {
    const q = { ...VALID_QUERY };
    delete q['openid.response_nonce'];
    const id = await verifyLogin(q, RETURN_TO, fakeFetch('is_valid:true\n'));
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
