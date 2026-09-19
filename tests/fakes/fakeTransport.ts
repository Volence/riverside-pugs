import type {
  BotInteraction, BotTransport, InteractionReply, MessagePayload, RoleOps, SlashCommandDef, VoiceOps,
} from '../../src/discord/transport.js';

export interface FakeMessage { channelId: string; id: string; payload: MessagePayload; deleted: boolean }

/** In-memory Discord. Messages are kept (with a deleted flag) so tests can
 *  assert on ordering and on what was removed. */
export class FakeTransport implements BotTransport {
  messages: FakeMessage[] = [];
  edits = 0;
  sends = 0;
  commands: SlashCommandDef[] = [];
  handler: ((i: BotInteraction) => Promise<InteractionReply>) | null = null;
  private seq = 0;

  // Voice world.
  channels = new Map<string, { name: string; members: Set<string>; allowed: string[] }>();
  voiceOf = new Map<string, string>();
  /** userId -> roles they hold. The queue-alert toggle is the only user. */
  rolesOf = new Map<string, Set<string>>();
  /** Set to make has() report "could not tell", the case that must not be
   *  mistaken for "does not have it". */
  rolesUnreadable = new Set<string>();
  moves: { userId: string; channelId: string }[] = [];
  failVoice = false;

  /** Make the next N sends throw, for testing what a Discord outage does. */
  failSends = 0;

  async send(channelId: string, payload: MessagePayload): Promise<string> {
    if (this.failSends > 0) { this.failSends--; throw new Error('discord down'); }
    const id = `m${++this.seq}`;
    this.sends++;
    this.messages.push({ channelId, id, payload, deleted: false });
    return id;
  }

  async edit(_channelId: string, messageId: string, payload: MessagePayload): Promise<boolean> {
    const m = this.messages.find((x) => x.id === messageId && !x.deleted);
    if (!m) return false;
    this.edits++;
    m.payload = payload;
    return true;
  }

  /** Direct messages, in order. */
  dms: { userId: string; payload: MessagePayload }[] = [];
  /** User ids whose DMs are closed: dm() rejects for them, as Discord does. */
  dmsClosed = new Set<string>();

  async dm(userId: string, payload: MessagePayload): Promise<void> {
    if (this.dmsClosed.has(userId)) throw new Error('Cannot send messages to this user');
    this.dms.push({ userId, payload });
  }

  async remove(_channelId: string, messageId: string): Promise<void> {
    const m = this.messages.find((x) => x.id === messageId);
    if (m) m.deleted = true;
  }

  onInteraction(handler: (i: BotInteraction) => Promise<InteractionReply>): void {
    this.handler = handler;
  }

  async registerCommands(defs: SlashCommandDef[]): Promise<void> {
    this.commands = defs;
  }

  guildMembers: string[] = [];
  memberHandlers: { all(ids: string[]): void; add(id: string): void; remove(id: string): void } | null = null;
  async watchMembers(h: { all(ids: string[]): void; add(id: string): void; remove(id: string): void }): Promise<void> {
    this.memberHandlers = h;
    h.all(this.guildMembers);
  }

  voiceHandlers: { all(states: [string, string][]): void; update(userId: string, channelId: string | null): void } | null = null;
  /** Reports voiceOf as the initial states. Tests drive changes through voiceHandlers. */
  async watchVoice(h: { all(states: [string, string][]): void; update(userId: string, channelId: string | null): void }): Promise<void> {
    this.voiceHandlers = h;
    h.all([...this.voiceOf.entries()]);
  }

  /** Messages still present, oldest first. */
  live(): FakeMessage[] {
    return this.messages.filter((m) => !m.deleted);
  }

  byId(id: string): FakeMessage | undefined {
    return this.messages.find((m) => m.id === id);
  }

  roles: RoleOps = {
    add: async (userId, roleId) => {
      const set = this.rolesOf.get(userId) ?? new Set<string>();
      set.add(roleId);
      this.rolesOf.set(userId, set);
    },
    remove: async (userId, roleId) => { this.rolesOf.get(userId)?.delete(roleId); },
    has: async (userId, roleId) => {
      if (this.rolesUnreadable.has(userId)) return null;
      return this.rolesOf.get(userId)?.has(roleId) ?? false;
    },
  };

  voice: VoiceOps = {
    createMatchChannels: async (name, teamA, teamB) => {
      if (this.failVoice) throw new Error('missing permissions');
      const categoryId = `cat${++this.seq}`;
      const teamAId = `va${++this.seq}`;
      const teamBId = `vb${++this.seq}`;
      this.channels.set(categoryId, { name, members: new Set(), allowed: [] });
      this.channels.set(teamAId, { name: teamA.label, members: new Set(), allowed: teamA.userIds });
      this.channels.set(teamBId, { name: teamB.label, members: new Set(), allowed: teamB.userIds });
      return { categoryId, teamAId, teamBId };
    },
    memberVoiceChannel: async (userId) => this.voiceOf.get(userId) ?? null,
    move: async (userId, channelId) => {
      // Discord rejects a move into a channel that is not there, which is how
      // a remembered origin that has since been deleted behaves.
      const dest = this.channels.get(channelId);
      if (!dest) throw new Error('Unknown Channel');
      this.moves.push({ userId, channelId });
      const prev = this.voiceOf.get(userId);
      if (prev) this.channels.get(prev)?.members.delete(userId);
      this.voiceOf.set(userId, channelId);
      dest.members.add(userId);
    },
    channelMemberCount: async (channelId) => this.channels.get(channelId)?.members.size ?? null,
    channelMemberIds: async (channelId) => {
      const ch = this.channels.get(channelId);
      return ch ? [...ch.members] : null;
    },
    deleteChannel: async (channelId) => { this.channels.delete(channelId); },
  };
}
