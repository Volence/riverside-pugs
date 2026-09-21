import type {
  BotInteraction, BotTransport, InteractionReply, MessagePayload, RoleOps, SlashCommandDef, ThreadOps, VoiceOps,
} from '../../src/discord/transport.js';

export interface FakeMessage { channelId: string; id: string; payload: MessagePayload; deleted: boolean }

export interface FakeThread {
  id: string;
  parentId: string;
  surface: 'forum' | 'private';
  name: string;
  tags: string[];
  members: Set<string>;
  locked: boolean;
  archived: boolean;
  deleted: boolean;
}

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
  channels = new Map<string, { name: string; members: Set<string>; allowed: string[]; staffRoleId: string | null }>();
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

  /** Make the next N edits throw, the transient that used to freeze a card. */
  failEdits = 0;

  // Thread world.
  threadsById = new Map<string, FakeThread>();
  /** channelId -> the members holding a permission overwrite on it. */
  channelAccess = new Map<string, Set<string>>();
  /** User ids that are not in the server: adding them to a thread or to a
   *  channel's overwrites is refused, as Discord refuses it. */
  notInGuild = new Set<string>();
  /** Make the next N thread operations throw. */
  failThreadOps = 0;
  opensModal: ((customId: string) => boolean) | null = null;

  threadsIn(parentId: string): FakeThread[] {
    return [...this.threadsById.values()].filter((th) => th.parentId === parentId && !th.deleted);
  }

  /** What Discord says about writing into this channel, when it is a thread. */
  private guardThread(channelId: string): void {
    const th = this.threadsById.get(channelId);
    if (!th) return;
    if (th.deleted) throw new Error('Unknown Channel');
    if (th.archived) throw new Error('Thread is archived');
  }

  private threadOp(): void {
    if (this.failThreadOps > 0) { this.failThreadOps--; throw new Error('discord down'); }
  }

  private liveThread(threadId: string): FakeThread {
    const th = this.threadsById.get(threadId);
    if (!th || th.deleted) throw new Error('Unknown Channel');
    return th;
  }

  /** Snowflake-shaped on purpose: phase 2b orders messages by id. */
  private snowflake(): string {
    return String(100000 + ++this.seq);
  }

  threads: ThreadOps = {
    createForumPost: async (forumId, post) => {
      this.threadOp();
      const id = this.snowflake();
      this.threadsById.set(id, { id, parentId: forumId, surface: 'forum', name: post.name, tags: [...post.tags], members: new Set(), locked: false, archived: false, deleted: false });
      // Discord gives a forum post's first message the thread's own id.
      this.messages.push({ channelId: id, id, payload: post.message, deleted: false });
      return { threadId: id, messageId: id };
    },
    createPrivateThread: async (channelId, thread) => {
      this.threadOp();
      const id = this.snowflake();
      this.threadsById.set(id, { id, parentId: channelId, surface: 'private', name: thread.name, tags: [], members: new Set(), locked: false, archived: false, deleted: false });
      return { threadId: id };
    },
    exists: async (threadId) => {
      const th = this.threadsById.get(threadId);
      return !!th && !th.deleted;
    },
    addMember: async (threadId, userId) => {
      this.threadOp();
      if (this.notInGuild.has(userId)) throw new Error('Unknown Member');
      this.liveThread(threadId).members.add(userId);
    },
    removeMember: async (threadId, userId) => {
      this.threadOp();
      this.liveThread(threadId).members.delete(userId);
    },
    memberIds: async (threadId) => {
      const th = this.threadsById.get(threadId);
      return !th || th.deleted ? null : [...th.members];
    },
    setLocked: async (threadId, locked) => { this.threadOp(); this.liveThread(threadId).locked = locked; },
    setArchived: async (threadId, archived) => { this.threadOp(); this.liveThread(threadId).archived = archived; },
    setTags: async (threadId, tags) => { this.threadOp(); this.liveThread(threadId).tags = [...tags]; },
    deleteThread: async (threadId) => {
      this.threadOp();
      const th = this.threadsById.get(threadId);
      if (th) th.deleted = true;
    },
    syncMemberAccess: async (channelId, userIds) => {
      this.threadOp();
      const have = this.channelAccess.get(channelId) ?? new Set<string>();
      const want = new Set(userIds);
      const added: string[] = [];
      const failed: string[] = [];
      for (const id of want) {
        if (have.has(id)) continue;
        if (this.notInGuild.has(id)) failed.push(id);
        else { have.add(id); added.push(id); }
      }
      const removed = [...have].filter((id) => !want.has(id));
      for (const id of removed) have.delete(id);
      this.channelAccess.set(channelId, have);
      return { added, removed, failed };
    },
  };

  async send(channelId: string, payload: MessagePayload): Promise<string> {
    if (this.failSends > 0) { this.failSends--; throw new Error('discord down'); }
    this.guardThread(channelId);
    const id = `m${++this.seq}`;
    this.sends++;
    this.messages.push({ channelId, id, payload, deleted: false });
    return id;
  }

  async edit(channelId: string, messageId: string, payload: MessagePayload): Promise<boolean> {
    if (this.failEdits > 0) { this.failEdits--; throw new Error('discord down'); }
    this.guardThread(channelId);
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

  onInteraction(handler: (i: BotInteraction) => Promise<InteractionReply>, opts?: { opensModal?: (customId: string) => boolean }): void {
    this.handler = handler;
    this.opensModal = opts?.opensModal ?? null;
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
    createMatchChannels: async (name, teamA, teamB, staffRoleId) => {
      if (this.failVoice) throw new Error('missing permissions');
      const categoryId = `cat${++this.seq}`;
      const teamAId = `va${++this.seq}`;
      const teamBId = `vb${++this.seq}`;
      this.channels.set(categoryId, { name, members: new Set(), allowed: [], staffRoleId: null });
      this.channels.set(teamAId, { name: teamA.label, members: new Set(), allowed: teamA.userIds, staffRoleId });
      this.channels.set(teamBId, { name: teamB.label, members: new Set(), allowed: teamB.userIds, staffRoleId });
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
