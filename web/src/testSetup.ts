/**
 * Runs before every web test file. The HUD tab strip's feedback link asks
 * /api/site for the Discord invite on every page that shows the strip; with
 * no server behind the test DOM that request would hang up noisily. Answer it
 * with "no invite" here. A test that stubs fetch itself replaces this whole
 * function, so its own answers still win.
 */
const realFetch = globalThis.fetch;
globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  if (/\/api\/site$/.test(url)) {
    return Promise.resolve(new Response(JSON.stringify({ discordEnabled: false, discordInviteUrl: null, requireDiscord: false }), {
      status: 200, headers: { 'content-type': 'application/json' },
    }));
  }
  return realFetch(input, init);
}) as typeof fetch;
