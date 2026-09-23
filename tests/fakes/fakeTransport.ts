import { NotInGuildError } from '../../src/discord/transport.js';
import type {
  BotInteraction, BotTransport, InboundAttachment, InboundMessage, InteractionReply, MessageCommandDef, MessageHooks,
  MessagePayload, ModerationOps, ModerationResult, RoleOps, SlashCommandDef, ThreadOps, VoiceOps,
} from '../../src/discord/transport.js';

export interface FakeMessage { channelId: string; id: string; payload: MessagePayload; deleted: boolean }

export interface FakeThread {
  id: string;
  parentId: string;
  /** Who created it. Threads the fake makes belong to the bot; a test sets
   *  this to somebody else to stand for a post the bot must not touch. */
  ownerId: string;
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
  /** The bot's own user id: what it creates, it owns. */
  botUserId = 'bot';
  threadsById = new Map<string, FakeThread>();
  /** channelId -> the members holding a permission overwrite on it. */
  channelAccess = new Map<string, Set<string>>();
  /** User ids that are not in the server: adding them to a thread or to a
   *  channel's overwrites is refused, as Discord refuses it. */
  notInGuild = new Set<string>();
  /** User ids whose permission overwrite Discord refuses to delete: they keep
   *  the access they should have lost, which is the failure the caller has to
   *  hear about. */
  accessRemovalsRefused = new Set<string>();
  /** Make the next N thread operations throw. */
  failThreadOps = 0;
  opensModal: ((customId: string) => boolean) | null = null;

  // Message world: what people, not the bot, wrote.
  inbox: (InboundMessage & { deleted: boolean })[] = [];
  hooks: MessageHooks | null = null;
  messageCommands: MessageCommandDef[] = [];
  /** How many messages one fetchAfter returns. Discord's is 100. */
  fetchPageSize = 100;
  /** What the hooks threw, in order. The transport contains a hook that
   *  throws rather than letting it escape into Discord's packet handling, so
   *  a test proving that still needs somewhere to look. */
  hookErrors: unknown[] = [];

  watchMessages(h: MessageHooks): void {
    this.hooks = h;
  }

  /** Every hook call goes through here, as it does in the real transport: a
   *  mirror with a locked database must not fail the Discord side. */
  private deliver(run: () => void): void {
    try {
      run();
    } catch (err) {
      this.hookErrors.push(err);
    }
  }

  private view(m: InboundMessage & { deleted: boolean }): InboundMessage {
    const { deleted: _deleted, ...rest } = m;
    return { ...rest, attachments: [...m.attachments] };
  }

  /** One of the bot's own messages as Discord reports it: through the hooks
   *  when it is sent, and in the thread's history afterwards. */
  private ownInbound(m: FakeMessage): InboundMessage {
    return {
      id: m.id, threadId: m.channelId, authorId: this.botUserId, authorName: 'bot', authorIsBot: true,
      content: m.payload.content ?? '', attachments: [],
      createdAt: new Date(Date.UTC(2026, 8, 22, 9, 0, 0)).toISOString(), editedAt: null,
    };
  }

  /** Someone writes in a channel. `deliver: false` is a message the bot was
   *  not online to hear: it is only there for a later fetchAfter.
   *
   *  Deliberately does NOT unarchive the thread, which is what Discord does
   *  when a person writes in an archived one. The archived flag is state the
   *  test sets, and a fake that changed it behind the test's back would hide
   *  the archived-thread refusals every write path is checked against. A test
   *  that wants the real behaviour calls setArchived(id, false) itself. */
  userPost(
    threadId: string,
    m: { authorId: string; authorName?: string; content: string; attachments?: InboundAttachment[]; bot?: boolean },
    deliver = true,
  ): InboundMessage {
    const msg = {
      id: this.snowflake(), threadId, authorId: m.authorId, authorName: m.authorName ?? `user${m.authorId}`,
      authorIsBot: m.bot ?? false, content: m.content, attachments: m.attachments ?? [],
      createdAt: new Date(Date.UTC(2026, 8, 22, 10, 0, this.inbox.length)).toISOString(), editedAt: null, deleted: false,
    };
    this.inbox.push(msg);
    // As the real transport does: ask first, hand over nothing on a no.
    if (deliver) this.deliver(() => { if (this.hooks?.watches(threadId)) this.hooks.create(this.view(msg)); });
    return this.view(msg);
  }

  userEdit(messageId: string, content: string, deliver = true): void {
    const msg = this.inbox.find((m) => m.id === messageId);
    if (!msg) throw new Error(`no such message ${messageId}`);
    msg.content = content;
    msg.editedAt = new Date(Date.UTC(2026, 8, 22, 11, 0, 0)).toISOString();
    if (deliver) this.deliver(() => { if (this.hooks?.watches(msg.threadId)) this.hooks.update(this.view(msg)); });
  }

  userDelete(messageId: string, deliver = true): void {
    const msg = this.inbox.find((m) => m.id === messageId);
    if (!msg) throw new Error(`no such message ${messageId}`);
    msg.deleted = true;
    if (deliver) this.deliver(() => { if (this.hooks?.watches(msg.threadId)) this.hooks.remove(msg.threadId, messageId); });
  }

  /** A thread's whole history as Discord would list it: the bot's messages
   *  and everyone else's, oldest first. */
  private history(threadId: string): InboundMessage[] {
    const bot = this.messages
      .filter((m) => m.channelId === threadId && !m.deleted && /^\d+$/.test(m.id))
      .map((m) => this.ownInbound(m));
    const people = this.inbox.filter((m) => m.threadId === threadId && !m.deleted).map((m) => this.view(m));
    return [...bot, ...people].sort((a, b) => (BigInt(a.id) < BigInt(b.id) ? -1 : 1));
  }

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

  /** Every thread operation but setArchived goes through here: an archived
   *  thread refuses them all, and unarchiving is the only way out. */
  private writableThread(threadId: string): FakeThread {
    const th = this.liveThread(threadId);
    if (th.archived) throw new Error('Thread is archived');
    return th;
  }

  /** The real transport fetches the channel and throws when it is not there,
   *  which is what an unset channel setting looks like. */
  private needChannelId(channelId: string, complaint: string): void {
    if (!channelId) throw new Error(`channel ${channelId} ${complaint}`);
  }

  /** Snowflake-shaped on purpose: phase 2b orders messages by id. */
  private snowflake(): string {
    return String(100000 + ++this.seq);
  }

  /** Every moderation call, in order. */
  moderationCalls: { op: 'timeout' | 'removeTimeout' | 'ban' | 'unban'; userId: string; minutes?: number; reason: string }[] = [];
  /** userId -> the refusal Discord would give. */
  moderationRefusals = new Map<string, Extract<ModerationResult, { ok: false }>>();
  moderation: ModerationOps = {
    timeout: async (userId, minutes, reason) => this.moderate({ op: 'timeout', userId, minutes, reason }),
    removeTimeout: async (userId, reason) => this.moderate({ op: 'removeTimeout', userId, reason }),
    ban: async (userId, reason) => this.moderate({ op: 'ban', userId, reason }),
    unban: async (userId, reason) => this.moderate({ op: 'unban', userId, reason }),
  };
  private moderate(call: FakeTransport['moderationCalls'][number]): ModerationResult {
    this.moderationCalls.push(call);
    return this.moderationRefusals.get(call.userId) ?? { ok: true };
  }

  threads: ThreadOps = {
    createForumPost: async (forumId, post) => {
      this.threadOp();
      this.needChannelId(forumId, 'is not a forum');
      const id = this.snowflake();
      this.threadsById.set(id, { id, parentId: forumId, ownerId: this.botUserId, surface: 'forum', name: post.name, tags: [...post.tags], members: new Set(), locked: false, archived: false, deleted: false });
      // Discord gives a forum post's first message the thread's own id.
      this.messages.push({ channelId: id, id, payload: post.message, deleted: false });
      return { threadId: id, messageId: id };
    },
    createPrivateThread: async (channelId, thread) => {
      this.threadOp();
      this.needChannelId(channelId, 'is not a text channel');
      const id = this.snowflake();
      this.threadsById.set(id, { id, parentId: channelId, ownerId: this.botUserId, surface: 'private', name: thread.name, tags: [], members: new Set(), locked: false, archived: false, deleted: false });
      return { threadId: id };
    },
    exists: async (threadId) => {
      const th = this.threadsById.get(threadId);
      return !!th && !th.deleted;
    },
    listThreads: async (channelId) => {
      this.threadOp();
      this.needChannelId(channelId, 'is not a forum');
      // The bot's own only, as the real transport reports them: a sweep must
      // never be handed a post somebody else made.
      return [...this.threadsById.values()]
        .filter((th) => th.parentId === channelId && !th.deleted && th.ownerId === this.botUserId)
        .map((th) => ({ threadId: th.id, ownerId: th.ownerId }));
    },
    addMember: async (threadId, userId) => {
      this.threadOp();
      const th = this.writableThread(threadId);
      if (this.notInGuild.has(userId)) throw new NotInGuildError('Unknown Member');
      th.members.add(userId);
    },
    removeMember: async (threadId, userId) => {
      this.threadOp();
      this.writableThread(threadId).members.delete(userId);
    },
    memberIds: async (threadId) => {
      const th = this.threadsById.get(threadId);
      return !th || th.deleted ? null : [...th.members];
    },
    setLocked: async (threadId, locked) => { this.threadOp(); this.writableThread(threadId).locked = locked; },
    // A read, like exists and memberIds, so an outage does not fake it.
    isArchived: async (threadId) => this.liveThread(threadId).archived,
    // Not writableThread: unarchiving is the way out of an archived thread.
    setArchived: async (threadId, archived) => { this.threadOp(); this.liveThread(threadId).archived = archived; },
    setTags: async (threadId, tags) => { this.threadOp(); this.writableThread(threadId).tags = [...tags]; },
    deleteThread: async (threadId) => {
      this.threadOp();
      const th = this.threadsById.get(threadId);
      if (th) th.deleted = true;
    },
    // Reads, so liveThread and not writableThread: Discord lets anyone who
    // can see an archived thread read its history.
    fetchAfter: async (threadId, afterId) => {
      this.threadOp();
      this.liveThread(threadId);
      const after = BigInt(afterId ?? '0');
      return this.history(threadId).filter((m) => BigInt(m.id) > after).slice(0, this.fetchPageSize);
    },
    fetchMessage: async (threadId, messageId) => {
      this.threadOp();
      // Null rather than a throw for a thread that is gone, which is what the
      // real transport answers: "the message or the thread is gone".
      const th = this.threadsById.get(threadId);
      if (!th || th.deleted) return null;
      return this.history(threadId).find((m) => m.id === messageId) ?? null;
    },
    syncMemberAccess: async (channelId, userIds, opts) => {
      this.threadOp();
      this.needChannelId(channelId, 'cannot hold permission overwrites');
      const have = this.channelAccess.get(channelId) ?? new Set<string>();
      const want = new Set(userIds);
      const added: string[] = [];
      const removed: string[] = [];
      const failed: string[] = [];
      // Revocations first, one by one, as the real transport does them: one
      // the server refuses leaves that person with access and is reported.
      for (const id of [...have]) {
        if (want.has(id)) continue;
        if (this.accessRemovalsRefused.has(id)) failed.push(id);
        else { have.delete(id); removed.push(id); }
      }
      // Revoke-only stops here: nobody is added, as the real transport does.
      if (!opts?.revokeOnly) {
        for (const id of want) {
          if (have.has(id)) continue;
          if (this.notInGuild.has(id)) failed.push(id);
          else { have.add(id); added.push(id); }
        }
      }
      this.channelAccess.set(channelId, have);
      return { added, removed, failed };
    },
  };

  async send(channelId: string, payload: MessagePayload): Promise<string> {
    if (this.failSends > 0) { this.failSends--; throw new Error('discord down'); }
    this.guardThread(channelId);
    // Inside a thread the id is snowflake-shaped, so history sorts. Anywhere
    // else it stays 'm<n>', which a dozen older tests read.
    const id = this.threadsById.has(channelId) ? this.snowflake() : `m${++this.seq}`;
    this.sends++;
    const msg = { channelId, id, payload, deleted: false };
    this.messages.push(msg);
    // Discord announces the bot's own message to the bot like anyone else's,
    // and the listeners do not filter by author: the caller does. So the
    // mirror is tested against a Discord that echoes.
    this.deliver(() => { if (this.hooks?.watches(channelId)) this.hooks.create(this.ownInbound(msg)); });
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

  async remove(channelId: string, messageId: string): Promise<void> {
    this.guardThread(channelId);
    const m = this.messages.find((x) => x.id === messageId);
    const theirs = this.inbox.find((x) => x.id === messageId);
    // Whether this call is the one that deleted it. Discord announces a
    // delete it actually performed, so a second Remove of the same message
    // says nothing, and the mirror has to survive hearing its own once.
    const went = (!!m && !m.deleted) || (!!theirs && !theirs.deleted);
    if (m) m.deleted = true;
    if (theirs) theirs.deleted = true;
    if (went) this.deliver(() => { if (this.hooks?.watches(channelId)) this.hooks.remove(channelId, messageId); });
  }

  onInteraction(handler: (i: BotInteraction) => Promise<InteractionReply>, opts?: { opensModal?: (customId: string) => boolean }): void {
    this.handler = handler;
    this.opensModal = opts?.opensModal ?? null;
  }

  async registerCommands(defs: SlashCommandDef[], messageCommands: MessageCommandDef[] = []): Promise<void> {
    this.commands = defs;
    this.messageCommands = messageCommands;
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
