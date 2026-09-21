/**
 * The seam between the bot's logic and discord.js.
 *
 * Everything the bot decides is expressed in these plain types, so presenters,
 * the controller and the sync loop are tested against an in-memory fake. Only
 * djsTransport.ts imports discord.js, and it translates these types 1:1.
 */

export interface EmbedField { name: string; value: string; inline?: boolean }

export interface Embed {
  title?: string;
  url?: string;
  description?: string;
  color?: number;
  fields?: EmbedField[];
  footer?: string;
  imageUrl?: string;
}

export type Button =
  | {
      kind: 'button';
      customId: string;
      label: string;
      style: 'primary' | 'secondary' | 'success' | 'danger';
      disabled?: boolean;
    }
  | { kind: 'link'; url: string; label: string };

/** At most five buttons per row, at most five rows (Discord's limits). */
export type ActionRow = Button[];

export interface MessagePayload {
  content?: string;
  embeds: Embed[];
  components: ActionRow[];
  /** User ids the content may actually ping. Everything else is inert text,
   *  so a stray <@id> in a name can never mass-ping. */
  mentionUserIds?: string[];
  /** Role ids the content may ping, under the same allowlist rule. Separate
   *  from mentionUserIds because Discord treats them as different categories:
   *  permitting a user never permits a role, and the queue alert is the one
   *  message that needs a role and no users. */
  mentionRoleIds?: string[];
}

/** One field of a modal. Discord allows five per modal. */
export type ModalField =
  | { kind: 'text'; id: string; label: string; style: 'short' | 'paragraph'; required?: boolean; maxLength?: number }
  | { kind: 'select'; id: string; label: string; options: { label: string; value: string }[] };

export interface ModalDef {
  customId: string;
  title: string;
  fields: ModalField[];
}

export type BotInteraction =
  | { kind: 'button'; customId: string; userId: string; userName: string }
  | {
      kind: 'command';
      name: string;
      userId: string;
      userName: string;
      /** String options by name. A user option carries the user id. */
      options: Record<string, string>;
    }
  /** A submitted modal. `fields` is each field's value by id; a select
   *  carries the one value picked. */
  | { kind: 'modal'; customId: string; userId: string; userName: string; fields: Record<string, string> };

export interface InteractionReply {
  ephemeral: boolean;
  payload: MessagePayload;
  /** Answer a button with a form instead of a message. Only honoured for a
   *  button the transport was told opens one (see onInteraction's opensModal):
   *  a modal has to be Discord's FIRST response to a press, and every other
   *  button is deferred before the handler runs. `payload` is what is said
   *  when the modal cannot be shown. */
  modal?: ModalDef;
}

export interface SlashOption {
  name: string;
  description: string;
  type: 'user' | 'string' | 'integer';
  required?: boolean;
  /** Fixed choices, shown as a picker. */
  choices?: { name: string; value: string }[];
}

export interface SlashCommandDef {
  name: string;
  description: string;
  options?: SlashOption[];
}

/** The voice operations team channels need. Ids are Discord snowflakes. */
export interface VoiceOps {
  createMatchChannels(
    name: string,
    teamA: { label: string; userIds: string[] },
    teamB: { label: string; userIds: string[] },
    /** A role let into BOTH team channels, or null for none. Staff, so an
     *  admin can drop into either side without being on the roster. */
    staffRoleId: string | null,
  ): Promise<{ categoryId: string; teamAId: string; teamBId: string }>;
  /** The voice channel a guild member is sitting in, or null. */
  memberVoiceChannel(userId: string): Promise<string | null>;
  move(userId: string, channelId: string): Promise<void>;
  /** Members currently in the channel; null when the channel no longer exists. */
  channelMemberCount(channelId: string): Promise<number | null>;
  /** Who is currently in the channel; null when it no longer exists. */
  channelMemberIds(channelId: string): Promise<string[] | null>;
  deleteChannel(channelId: string): Promise<void>;
}

/** Adding and removing one opt-in role, for the queue-alert toggle.
 *
 *  Narrow on purpose: this is not general role management. The bot is given a
 *  single configured role id and can only put a member in it or take them out,
 *  so a bug here cannot hand anyone permissions. */
export interface RoleOps {
  add(userId: string, roleId: string): Promise<void>;
  remove(userId: string, roleId: string): Promise<void>;
  /** Whether the member currently holds it; null when the member or the role
   *  cannot be read, which the caller reports rather than guessing. */
  has(userId: string, roleId: string): Promise<boolean | null>;
}

/**
 * Threads, for tickets. Ids are Discord snowflakes.
 *
 * Narrow on purpose, like RoleOps. A forum post is addressed by its thread
 * id; its first message (the case card) has the same id as the thread, which
 * is how Discord numbers forum posts, so `send` and `edit` with the thread id
 * as the channel reach the inside of a thread with no new method.
 *
 * Tags are passed by NAME. The implementation creates any the forum lacks and
 * translates: tag ids are per forum and the bot's logic should not hold them.
 */
export interface ThreadOps {
  createForumPost(
    forumId: string, post: { name: string; message: MessagePayload; tags: string[] },
  ): Promise<{ threadId: string; messageId: string }>;
  /** A private thread nobody can invite to. It starts with the bot alone. */
  createPrivateThread(channelId: string, thread: { name: string }): Promise<{ threadId: string }>;
  /** False once the thread has been deleted, by the bot or by hand. */
  exists(threadId: string): Promise<boolean>;
  /**
   * Every thread of this FORUM channel that the BOT ITSELF created, active
   * and archived alike, with the id of that owner. Only its own: which user
   * the bot is is known in the transport and nowhere else, and the caller
   * sweeps up what it finds, which must never be somebody else's post.
   * Throws when the channel is not a forum.
   */
  listThreads(channelId: string): Promise<{ threadId: string; ownerId: string | null }[]>;
  /** Rejects for someone who is not in the server. */
  addMember(threadId: string, userId: string): Promise<void>;
  removeMember(threadId: string, userId: string): Promise<void>;
  /** Everyone in the thread but the bot; null when the thread is gone. */
  memberIds(threadId: string): Promise<string[] | null>;
  setLocked(threadId: string, locked: boolean): Promise<void>;
  /** Whether Discord currently has the thread archived, which it does on its
   *  own after the auto-archive time passes, with nothing to say it did.
   *  Rejects for a thread that is gone. */
  isArchived(threadId: string): Promise<boolean>;
  /**
   * An archived thread refuses EVERY operation except setArchived(false):
   * no send, no edit, no tag, no lock, nobody added or removed. So closing a
   * thread locks first and archives last, and anything that touches a closed
   * thread unarchives first. Nothing unarchives on a caller's behalf.
   */
  setArchived(threadId: string, archived: boolean): Promise<void>;
  setTags(threadId: string, tags: string[]): Promise<void>;
  /** Deleting a thread that is already gone is not an error. */
  deleteThread(threadId: string): Promise<void>;
  /**
   * Make the FORUM channel's per-member permission overwrites exactly this
   * set: view, read history, talk inside threads, attach files, embed links
   * and add reactions. A channel that is not a forum is refused: the only
   * caller is the tickets forum's access list, the tickets channel setting
   * sits beside it in Settings, and a mis-pasted id here would strip a whole
   * channel's member overwrites and hand it to every moderator.
   *
   * Overwrites on one channel and never a role, so a bug here cannot hand
   * anyone anything anywhere else. The bot's own overwrite and every role
   * overwrite are left alone. Access is taken away before it is given, since
   * revocation is the direction that matters. `failed` is who could not be
   * added, which is ordinary (they have left the server), together with
   * anyone whose overwrite could not be deleted, which is not: an id in
   * `failed` that is not in `userIds` still has access it should have lost.
   *
   * `revokeOnly` does the revocations and nothing else: everyone whose
   * overwrite should go, goes, and nobody is added, so `added` comes back
   * empty. It is for a caller that knows who must lose access but cannot yet
   * be sure that giving it to somebody new is safe.
   */
  syncMemberAccess(
    channelId: string, userIds: string[], opts?: { revokeOnly?: boolean },
  ): Promise<{ added: string[]; removed: string[]; failed: string[] }>;
}

export interface BotTransport {
  send(channelId: string, payload: MessagePayload): Promise<string>;
  /** False when the message no longer exists (deleted by hand). */
  edit(channelId: string, messageId: string, payload: MessagePayload): Promise<boolean>;
  remove(channelId: string, messageId: string): Promise<void>;
  /** A direct message to one user. Rejects when Discord refuses it, which is
   *  ordinary: the user has DMs from server members closed, or has left the
   *  guild and shares no server with the bot. Callers decide what that means. */
  dm(userId: string, payload: MessagePayload): Promise<void>;
  onInteraction(
    handler: (i: BotInteraction) => Promise<InteractionReply>,
    /** `opensModal`: which buttons answer with a modal, asked BEFORE the
     *  handler runs. Such a button is not deferred, so its handler must be a
     *  quick database read. */
    opts?: { opensModal?: (customId: string) => boolean },
  ): void;
  registerCommands(defs: SlashCommandDef[]): Promise<void>;
  /** Load the server's member list, then report joins and leaves. */
  watchMembers(h: { all(ids: string[]): void; add(id: string): void; remove(id: string): void }): Promise<void>;
  /** Load who is in which voice channel, then report every change: the
   *  channel they are in now, or null when they left voice. */
  watchVoice(h: { all(states: [userId: string, channelId: string][]): void; update(userId: string, channelId: string | null): void }): Promise<void>;
  voice: VoiceOps;
  roles: RoleOps;
  threads: ThreadOps;
}
