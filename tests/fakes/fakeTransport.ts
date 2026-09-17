import type {
  BotInteraction, BotTransport, InteractionReply, MessagePayload, SlashCommandDef, VoiceOps,
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
  moves: { userId: string; channelId: string }[] = [];
  failVoice = false;

  async send(channelId: string, payload: MessagePayload): Promise<string> {
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

  /** Messages still present, oldest first. */
  live(): FakeMessage[] {
    return this.messages.filter((m) => !m.deleted);
  }

  byId(id: string): FakeMessage | undefined {
    return this.messages.find((m) => m.id === id);
  }

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
      this.moves.push({ userId, channelId });
      const prev = this.voiceOf.get(userId);
      if (prev) this.channels.get(prev)?.members.delete(userId);
      this.voiceOf.set(userId, channelId);
      this.channels.get(channelId)?.members.add(userId);
    },
    channelMemberCount: async (channelId) => this.channels.get(channelId)?.members.size ?? null,
    deleteChannel: async (channelId) => { this.channels.delete(channelId); },
  };
}
