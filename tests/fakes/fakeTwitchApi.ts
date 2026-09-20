import type { TwitchApi, TwitchStream } from '../../src/twitch/api.js';

export interface FakeTwitchOpts {
  /** OAuth: code -> the user it resolves to. Any other code is rejected. */
  users?: Record<string, { id: string; login: string }>;
  /** Who is live right now, keyed by twitch user id. */
  live?: Record<string, Partial<TwitchStream>>;
  /** When set, getStreams throws with this message, standing in for Twitch
   *  being down. */
  failStreams?: string;
}

export interface FakeTwitchApi extends TwitchApi {
  /** How many times getStreams has been called, so a test can assert the
   *  poller asks about nobody when nobody has linked. */
  readonly calls: number;
}

export function fakeTwitchApi(opts: FakeTwitchOpts = {}): FakeTwitchApi {
  const state = { calls: 0 };
  return {
    get calls() { return state.calls; },

    async exchangeCode(code) {
      if (!opts.users?.[code]) throw new Error('bad code');
      return { accessToken: `token:${code}` };
    },

    async getCurrentUser(accessToken) {
      const code = accessToken.replace(/^token:/, '');
      const user = opts.users?.[code];
      if (!user) throw new Error('bad token');
      return user;
    },

    async getStreams(userIds) {
      state.calls += 1;
      if (opts.failStreams) throw new Error(opts.failStreams);
      return userIds
        .filter((id) => opts.live?.[id])
        .map((id) => ({
          userId: id,
          userLogin: `login${id}`,
          title: 'streaming',
          gameName: 'Left 4 Dead',
          viewers: 10,
          thumbnailUrl: 'https://t/{width}x{height}.jpg',
          startedAt: '2026-09-20T00:00:00Z',
          ...opts.live![id],
        }));
    },
  };
}
