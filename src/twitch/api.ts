import type { TwitchConfig } from '../config.js';

export interface TwitchStream {
  userId: string;
  userLogin: string;
  title: string;
  gameName: string;
  viewers: number;
  /** Twitch's template, with {width} and {height} still in it. Substituted at
   *  render, not here, so one stored value can serve any size. */
  thumbnailUrl: string;
  startedAt: string;
}

export interface TwitchApi {
  exchangeCode(code: string, redirectUri: string): Promise<{ accessToken: string }>;
  getCurrentUser(accessToken: string): Promise<{ id: string; login: string }>;
  getStreams(userIds: string[]): Promise<TwitchStream[]>;
}

const TOKEN_URL = 'https://id.twitch.tv/oauth2/token';
const HELIX = 'https://api.twitch.tv/helix';

/** Helix accepts at most 100 user_id parameters per request. This is what
 *  makes the whole community one HTTP call per poll, and in turn what makes a
 *  60 second interval free rather than something to budget. */
const CHUNK = 100;

export function makeTwitchApi(cfg: TwitchConfig, fetchImpl: typeof fetch = fetch): TwitchApi {
  // The app token, cached in memory. Nothing persists it: it is cheap to
  // re-fetch and a restart is not a reason to keep a credential on disk.
  let appToken: string | null = null;
  let appTokenExpiry = 0;

  async function appAccessToken(force = false): Promise<string> {
    if (!force && appToken && Date.now() < appTokenExpiry) return appToken;
    const body = new URLSearchParams({
      client_id: cfg.clientId,
      client_secret: cfg.clientSecret,
      grant_type: 'client_credentials',
    });
    const res = await fetchImpl(TOKEN_URL, { method: 'POST', body });
    if (!res.ok) throw new Error(`twitch app token failed: ${res.status}`);
    const json = await res.json() as { access_token: string; expires_in?: number };
    appToken = json.access_token;
    // A minute of slack, so a token never expires mid-request.
    appTokenExpiry = Date.now() + Math.max(0, (json.expires_in ?? 3600) - 60) * 1000;
    return appToken;
  }

  function helix(path: string, token: string): Promise<Response> {
    return fetchImpl(`${HELIX}${path}`, {
      headers: { 'Client-Id': cfg.clientId, Authorization: `Bearer ${token}` },
    });
  }

  return {
    async exchangeCode(code, redirectUri) {
      const body = new URLSearchParams({
        client_id: cfg.clientId,
        client_secret: cfg.clientSecret,
        code,
        grant_type: 'authorization_code',
        redirect_uri: redirectUri,
      });
      const res = await fetchImpl(TOKEN_URL, { method: 'POST', body });
      if (!res.ok) throw new Error(`twitch code exchange failed: ${res.status}`);
      const json = await res.json() as { access_token: string };
      return { accessToken: json.access_token };
    },

    async getCurrentUser(accessToken) {
      // The USER's token, not the app token: helix/users with no login
      // parameter means "whoever this token belongs to", which is the entire
      // reason the OAuth flow exists here.
      const res = await helix('/users', accessToken);
      if (!res.ok) throw new Error(`twitch users failed: ${res.status}`);
      const json = await res.json() as { data?: { id: string; login: string }[] };
      const user = json.data?.[0];
      if (!user) throw new Error('twitch users returned nobody');
      return { id: user.id, login: user.login };
    },

    async getStreams(userIds) {
      if (userIds.length === 0) return [];
      const out: TwitchStream[] = [];
      for (let i = 0; i < userIds.length; i += CHUNK) {
        const params = new URLSearchParams();
        for (const id of userIds.slice(i, i + CHUNK)) params.append('user_id', id);
        let token = await appAccessToken();
        let res = await helix(`/streams?${params}`, token);
        if (res.status === 401) {
          // The cached token was rejected. Re-fetch once and retry; a second
          // 401 is a real failure and must not become a loop against Twitch.
          token = await appAccessToken(true);
          res = await helix(`/streams?${params}`, token);
        }
        if (!res.ok) throw new Error(`twitch streams failed: ${res.status}`);
        const json = await res.json() as {
          data?: {
            user_id: string; user_login?: string; title?: string; game_name?: string;
            viewer_count?: number; thumbnail_url?: string; started_at?: string;
          }[];
        };
        for (const s of json.data ?? []) {
          out.push({
            userId: s.user_id,
            userLogin: s.user_login ?? '',
            title: s.title ?? '',
            gameName: s.game_name ?? '',
            viewers: s.viewer_count ?? 0,
            thumbnailUrl: s.thumbnail_url ?? '',
            startedAt: s.started_at ?? '',
          });
        }
      }
      return out;
    },
  };
}
