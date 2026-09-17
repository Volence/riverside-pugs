import type { DiscordApi } from '../../src/discord/api.js';

/** In-memory DiscordApi. `members` maps user id to role ids; absent = not in the guild. */
export function fakeDiscordApi(opts: {
  members?: Record<string, string[]>;
  users?: Record<string, { id: string; username: string; globalName: string | null }>;
  failMembers?: boolean;
}): DiscordApi & { exchanged: string[] } {
  const exchanged: string[] = [];
  return {
    exchanged,
    async exchangeCode(code) {
      exchanged.push(code);
      if (!opts.users?.[code]) throw new Error('bad code');
      return { accessToken: `tok:${code}` };
    },
    async getCurrentUser(accessToken) {
      const u = opts.users?.[accessToken.replace(/^tok:/, '')];
      if (!u) throw new Error('bad token');
      return u;
    },
    async getGuildMember(userId) {
      if (opts.failMembers) throw new Error('discord down');
      const roles = opts.members?.[userId];
      return roles ? { roles } : null;
    },
  };
}
