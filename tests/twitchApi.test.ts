import { describe, it, expect } from 'vitest';
import { makeTwitchApi } from '../src/twitch/api.js';
import { loadConfig } from '../src/config.js';

const CFG = { clientId: 'cid', clientSecret: 'secret' };

function fetchStub(handler: (url: string, init?: RequestInit) => { status?: number; body: unknown }) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const impl = (async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    const { status = 200, body } = handler(url, init);
    return new Response(JSON.stringify(body), {
      status, headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch;
  return { impl, calls };
}

const tokenOk = { access_token: 'app1', expires_in: 3600 };

describe('twitch config', () => {
  it('is null when either variable is missing', () => {
    expect(loadConfig({}).twitch).toBe(null);
    expect(loadConfig({ TWITCH_CLIENT_ID: 'a' }).twitch).toBe(null);
    expect(loadConfig({ TWITCH_CLIENT_SECRET: 'b' }).twitch).toBe(null);
  });

  it('loads when both are present', () => {
    expect(loadConfig({ TWITCH_CLIENT_ID: 'a', TWITCH_CLIENT_SECRET: 'b' }).twitch)
      .toEqual({ clientId: 'a', clientSecret: 'b' });
  });

  it('ignores whitespace-only values', () => {
    expect(loadConfig({ TWITCH_CLIENT_ID: '  ', TWITCH_CLIENT_SECRET: 'b' }).twitch).toBe(null);
  });
});

describe('getStreams', () => {
  it('fetches an app token once and reuses it', async () => {
    const { impl, calls } = fetchStub((url) =>
      url.includes('oauth2/token') ? { body: tokenOk } : { body: { data: [] } });
    const api = makeTwitchApi(CFG, impl);
    await api.getStreams(['1']);
    await api.getStreams(['1']);
    expect(calls.filter((c) => c.url.includes('oauth2/token')).length).toBe(1);
  });

  it('sends every user id and the client id header', async () => {
    const { impl, calls } = fetchStub((url) =>
      url.includes('oauth2/token') ? { body: tokenOk } : { body: { data: [] } });
    const api = makeTwitchApi(CFG, impl);
    await api.getStreams(['11', '22']);
    const streams = calls.find((c) => c.url.includes('helix/streams'))!;
    expect(streams.url).toContain('user_id=11');
    expect(streams.url).toContain('user_id=22');
    const headers = streams.init!.headers as Record<string, string>;
    expect(headers['Client-Id']).toBe('cid');
    expect(headers.Authorization).toBe('Bearer app1');
  });

  it('chunks past 100 ids into separate requests', async () => {
    const { impl, calls } = fetchStub((url) =>
      url.includes('oauth2/token') ? { body: tokenOk } : { body: { data: [] } });
    const api = makeTwitchApi(CFG, impl);
    await api.getStreams(Array.from({ length: 150 }, (_, i) => String(i)));
    expect(calls.filter((c) => c.url.includes('helix/streams')).length).toBe(2);
  });

  it('maps a live stream onto our own shape', async () => {
    const { impl } = fetchStub((url) =>
      url.includes('oauth2/token') ? { body: tokenOk } : {
        body: {
          data: [{
            user_id: '11', user_login: 'alice', title: 'pugs', game_name: 'Left 4 Dead',
            viewer_count: 18, thumbnail_url: 'https://t/{width}x{height}.jpg',
            started_at: '2026-09-20T00:00:00Z',
          }],
        },
      });
    const api = makeTwitchApi(CFG, impl);
    expect(await api.getStreams(['11'])).toEqual([{
      userId: '11', userLogin: 'alice', title: 'pugs', gameName: 'Left 4 Dead',
      viewers: 18, thumbnailUrl: 'https://t/{width}x{height}.jpg',
      startedAt: '2026-09-20T00:00:00Z',
    }]);
  });

  it('tolerates a response missing the optional fields', async () => {
    const { impl } = fetchStub((url) =>
      url.includes('oauth2/token') ? { body: tokenOk } : { body: { data: [{ user_id: '11' }] } });
    const api = makeTwitchApi(CFG, impl);
    expect(await api.getStreams(['11'])).toEqual([{
      userId: '11', userLogin: '', title: '', gameName: '',
      viewers: 0, thumbnailUrl: '', startedAt: '',
    }]);
  });

  it('re-fetches the app token once on a 401 and retries', async () => {
    let streamCalls = 0;
    const { impl, calls } = fetchStub((url) => {
      if (url.includes('oauth2/token')) return { body: tokenOk };
      streamCalls += 1;
      if (streamCalls === 1) return { status: 401, body: { message: 'invalid' } };
      return { body: { data: [] } };
    });
    const api = makeTwitchApi(CFG, impl);
    await api.getStreams(['11']);
    expect(calls.filter((c) => c.url.includes('oauth2/token')).length).toBe(2);
    expect(streamCalls).toBe(2);
  });

  it('gives up rather than looping on a second 401', async () => {
    const { impl } = fetchStub((url) =>
      url.includes('oauth2/token') ? { body: tokenOk } : { status: 401, body: { message: 'invalid' } });
    const api = makeTwitchApi(CFG, impl);
    await expect(api.getStreams(['11'])).rejects.toThrow(/401/);
  });

  it('throws on a non-401 failure', async () => {
    const { impl } = fetchStub((url) =>
      url.includes('oauth2/token') ? { body: tokenOk } : { status: 500, body: {} });
    const api = makeTwitchApi(CFG, impl);
    await expect(api.getStreams(['11'])).rejects.toThrow(/500/);
  });

  it('asks for nothing when there is nobody to ask about', async () => {
    const { impl, calls } = fetchStub(() => ({ body: { data: [] } }));
    const api = makeTwitchApi(CFG, impl);
    expect(await api.getStreams([])).toEqual([]);
    expect(calls.length).toBe(0);
  });
});

describe('twitch oauth', () => {
  it('exchanges a code and reads the user', async () => {
    const { impl } = fetchStub((url) =>
      url.includes('oauth2/token')
        ? { body: { access_token: 'user1' } }
        : { body: { data: [{ id: '11', login: 'alice', display_name: 'Alice' }] } });
    const api = makeTwitchApi(CFG, impl);
    const { accessToken } = await api.exchangeCode('code', 'https://pug.test/cb');
    expect(accessToken).toBe('user1');
    expect(await api.getCurrentUser(accessToken)).toEqual({ id: '11', login: 'alice' });
  });

  it('throws when the user response is empty', async () => {
    const { impl } = fetchStub((url) =>
      url.includes('oauth2/token') ? { body: { access_token: 'user1' } } : { body: { data: [] } });
    const api = makeTwitchApi(CFG, impl);
    await expect(api.getCurrentUser('user1')).rejects.toThrow();
  });

  it('throws on a failed exchange', async () => {
    const { impl } = fetchStub(() => ({ status: 400, body: { message: 'bad code' } }));
    const api = makeTwitchApi(CFG, impl);
    await expect(api.exchangeCode('nope', 'https://pug.test/cb')).rejects.toThrow(/400/);
  });

  it('uses the user token, not the app token, to read the user', async () => {
    const { impl, calls } = fetchStub((url) =>
      url.includes('oauth2/token')
        ? { body: { access_token: 'user1' } }
        : { body: { data: [{ id: '11', login: 'alice' }] } });
    const api = makeTwitchApi(CFG, impl);
    await api.getCurrentUser('user1');
    const users = calls.find((c) => c.url.includes('helix/users'))!;
    expect((users.init!.headers as Record<string, string>).Authorization).toBe('Bearer user1');
  });
});
