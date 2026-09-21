import {
  ApplicationCommandOptionType, ApplicationCommandType, ChannelType, Client, ComponentType, Events, GatewayIntentBits, MessageFlags,
  OverwriteType, PermissionFlagsBits, ThreadAutoArchiveDuration,
  type AnyThreadChannel, type ForumChannel, type Guild, type Interaction, type TextBasedChannel,
} from 'discord.js';
import type { DiscordConfig } from '../config.js';
import type {
  BotInteraction, BotTransport, Button, InteractionReply, MessagePayload, ModalDef, RoleOps, SlashCommandDef, ThreadOps, VoiceOps,
} from './transport.js';

/**
 * The only file that imports discord.js. Translates the plain transport types
 * 1:1 and owns the gateway connection. Verified live rather than unit tested:
 * everything with logic in it sits behind the BotTransport interface.
 */

const STYLE = { primary: 1, secondary: 2, success: 3, danger: 4 } as const;
const UNKNOWN_MESSAGE = 10008;
const UNKNOWN_CHANNEL = 10003;
const UNKNOWN_MEMBER = 10007;

function toButton(b: Button) {
  return b.kind === 'link'
    ? { type: 2, style: 5, label: b.label, url: b.url }
    : { type: 2, style: STYLE[b.style], label: b.label, custom_id: b.customId, disabled: b.disabled ?? false };
}

function toMessage(p: MessagePayload) {
  return {
    content: p.content ?? '',
    embeds: p.embeds.map((e) => ({
      title: e.title,
      url: e.url,
      description: e.description,
      color: e.color,
      fields: e.fields,
      footer: e.footer ? { text: e.footer } : undefined,
      image: e.imageUrl ? { url: e.imageUrl } : undefined,
    })),
    components: p.components.map((row) => ({ type: 1, components: row.map(toButton) })),
    // Nothing pings unless explicitly listed: names are user-controlled text.
    allowedMentions: { parse: [] as never[], users: p.mentionUserIds ?? [], roles: p.mentionRoleIds ?? [] },
  };
}

/**
 * A modal as raw API JSON, like toButton. Every field is wrapped in a Label
 * (component type 18), the only way a select can sit in a modal. A text input
 * inside a Label must NOT carry its own `label`: discord-api-types says so at
 * payloads/v10/message.d.ts:1463 ("Cannot be used in a label component").
 * Verified: LabelComponentData typings/index.d.ts:401, ModalComponentData
 * :2846, StringSelectMenuComponentData :7483, TextInputComponentData :7532.
 */
function toModal(m: ModalDef) {
  return {
    custom_id: m.customId,
    title: m.title.slice(0, 45),
    components: m.fields.map((f) => ({
      type: 18,
      label: f.label.slice(0, 45),
      component: f.kind === 'select'
        ? { type: 3, custom_id: f.id, required: true, options: f.options.map((o) => ({ label: o.label, value: o.value })) }
        : { type: 4, custom_id: f.id, style: f.style === 'paragraph' ? 2 : 1, required: f.required ?? false, max_length: f.maxLength },
    })),
  };
}

const codeOf = (err: unknown): number | undefined => (err as { code?: number }).code;

export async function createDjsTransport(cfg: DiscordConfig): Promise<BotTransport & { destroy(): Promise<void> }> {
  const client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers, GatewayIntentBits.GuildVoiceStates],
  });
  client.on(Events.Error, (err) => console.error('[discord] client error:', err));

  const ready = new Promise<void>((resolve) => client.once(Events.ClientReady, () => resolve()));
  await client.login(cfg.botToken);
  await ready;
  const guild: Guild = await client.guilds.fetch(cfg.guildId);
  console.log(`[discord] bot logged in as ${client.user?.tag} in ${guild.name}`);

  const textChannel = async (id: string): Promise<TextBasedChannel & { send: Function }> => {
    const ch = await client.channels.fetch(id);
    if (!ch || !ch.isTextBased() || !('send' in ch)) throw new Error(`channel ${id} is not a text channel`);
    return ch as TextBasedChannel & { send: Function };
  };

  let handler: ((i: BotInteraction) => Promise<InteractionReply>) | null = null;
  let opensModal: ((customId: string) => boolean) | null = null;

  client.on(Events.InteractionCreate, async (i: Interaction) => {
    if (!handler) return;
    try {
      if (i.isButton()) {
        if (opensModal?.(i.customId)) {
          // showModal has to be the first response to the press, so this one
          // button is not deferred (showModal: typings/index.d.ts:684). Its
          // handler is a database read and answers well inside three seconds.
          const reply = await handler({
            kind: 'button', customId: i.customId, userId: i.user.id, userName: i.user.globalName ?? i.user.username,
          });
          if (reply.modal) {
            await i.showModal(toModal(reply.modal));
          } else {
            const m = toMessage(reply.payload);
            await i.reply({
              content: m.content || undefined, embeds: m.embeds, components: m.components as never,
              allowedMentions: m.allowedMentions, flags: MessageFlags.Ephemeral,
            });
          }
          return;
        }
        // Every button reply is private; defer first so a slow handler never
        // blows Discord's three second window.
        //
        // A button that sits on one of our OWN ephemeral replies (the endorse
        // picker) updates that reply in place rather than stacking a new one
        // under it: pick a player, pick a kind, and the same message shows what
        // remains. Buttons on public cards keep getting a fresh private reply.
        const inPlace = i.message.flags.has(MessageFlags.Ephemeral);
        if (inPlace) await i.deferUpdate();
        else await i.deferReply({ flags: MessageFlags.Ephemeral });
        const reply = await handler({
          kind: 'button', customId: i.customId, userId: i.user.id, userName: i.user.globalName ?? i.user.username,
        });
        const m = toMessage(reply.payload);
        // In place, an absent content must CLEAR the old text, and undefined
        // means "leave it as it was" to Discord.
        await i.editReply({ content: inPlace ? (m.content ?? '') : (m.content || undefined), embeds: m.embeds, components: m.components as never, allowedMentions: m.allowedMentions });
      } else if (i.isChatInputCommand()) {
        const options: Record<string, string> = {};
        for (const o of i.options.data) {
          if (o.value !== undefined) options[o.name] = String(o.value);
        }
        const interaction: BotInteraction = {
          kind: 'command', name: i.commandName, userId: i.user.id, userName: i.user.globalName ?? i.user.username, options,
        };
        // Whether the reply is private is only known after the handler ran,
        // and a deferral fixes it. Commands are fast DB reads, so reply directly.
        const reply = await handler(interaction);
        const m = toMessage(reply.payload);
        await i.reply({
          content: m.content || undefined, embeds: m.embeds, components: m.components as never,
          allowedMentions: m.allowedMentions, flags: reply.ephemeral ? MessageFlags.Ephemeral : undefined,
        });
      } else if (i.isModalSubmit()) {
        // isModalSubmit: typings/index.d.ts:2215. Deferred like a button: the
        // handler writes to the database and the reply is always private.
        await i.deferReply({ flags: MessageFlags.Ephemeral });
        const fields: Record<string, string> = {};
        // ModalSubmitFields.fields :2936, getStringSelectValues :2946.
        for (const [id, f] of i.fields.fields) {
          fields[id] = f.type === ComponentType.TextInput ? f.value
            : f.type === ComponentType.StringSelect ? (i.fields.getStringSelectValues(id)[0] ?? '') : '';
        }
        const reply = await handler({
          kind: 'modal', customId: i.customId, userId: i.user.id, userName: i.user.globalName ?? i.user.username, fields,
        });
        const m = toMessage(reply.payload);
        await i.editReply({ content: m.content || undefined, embeds: m.embeds, components: m.components as never, allowedMentions: m.allowedMentions });
      }
    } catch (err) {
      console.error('[discord] interaction failed:', err);
      try {
        if (i.isRepliable()) {
          if (i.deferred || i.replied) await i.editReply({ content: 'Something went wrong. Try again, or use the website.' });
          else await i.reply({ content: 'Something went wrong. Try again, or use the website.', flags: MessageFlags.Ephemeral });
        }
      } catch { /* the interaction is gone; nothing left to tell */ }
    }
  });

  const channelById = async (id: string) => {
    try {
      return guild.channels.cache.get(id) ?? (await guild.channels.fetch(id));
    } catch (err) {
      if (codeOf(err) === UNKNOWN_CHANNEL) return null;
      throw err;
    }
  };

  const voice: VoiceOps = {
    async createMatchChannels(name, teamA, teamB, staffRoleId) {
      const me = client.user!.id;
      // An overwrite for someone who is not in the guild is rejected by
      // Discord, which would fail the whole channel; keep members only.
      const members = async (ids: string[]) => {
        const out: string[] = [];
        for (const id of ids) {
          try {
            await guild.members.fetch(id);
            out.push(id);
          } catch { /* left the server */ }
        }
        return out;
      };
      const category = await guild.channels.create({ name, type: ChannelType.GuildCategory });
      const make = async (label: string, ids: string[], staff: string | null) => guild.channels.create({
        name: label,
        type: ChannelType.GuildVoice,
        parent: category.id,
        permissionOverwrites: [
          { id: guild.roles.everyone.id, allow: [PermissionFlagsBits.ViewChannel], deny: [PermissionFlagsBits.Connect] },
          ...(await members(ids)).map((id) => ({
            id, type: OverwriteType.Member,
            allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.Connect, PermissionFlagsBits.Speak],
          })),
          // MoveMembers as well as Connect: sorting someone into the right
          // team channel is the reason staff are in here at all.
          ...(staff ? [{
            id: staff, type: OverwriteType.Role,
            allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.Connect, PermissionFlagsBits.Speak, PermissionFlagsBits.MoveMembers],
          }] : []),
          {
            id: me, type: OverwriteType.Member,
            allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.Connect, PermissionFlagsBits.MoveMembers, PermissionFlagsBits.ManageChannels],
          },
        ],
      });
      // The staff overwrite is the one part of this that depends on a setting
      // naming a role the bot may not be allowed to grant, and a rejected
      // overwrite fails the whole channel. Team voice for a live match must
      // not be lost over it, so a failure retries once without staff and says
      // so, rather than taking the match's voice down with it.
      const makeSafe = async (label: string, ids: string[]) => {
        if (!staffRoleId) return make(label, ids, null);
        try {
          return await make(label, ids, staffRoleId);
        } catch (err) {
          console.error(`[discord] staff role ${staffRoleId} could not be added to ${label}; creating it without:`, err);
          return make(label, ids, null);
        }
      };
      const a = await makeSafe(teamA.label, teamA.userIds);
      const b = await makeSafe(teamB.label, teamB.userIds);
      return { categoryId: category.id, teamAId: a.id, teamBId: b.id };
    },
    async memberVoiceChannel(userId) {
      return guild.voiceStates.cache.get(userId)?.channelId ?? null;
    },
    async move(userId, channelId) {
      const member = await guild.members.fetch(userId);
      await member.voice.setChannel(channelId);
    },
    async channelMemberCount(channelId) {
      const ch = await channelById(channelId);
      if (!ch) return null;
      return 'members' in ch && ch.type === ChannelType.GuildVoice ? ch.members.size : 0;
    },
    async channelMemberIds(channelId) {
      const ch = await channelById(channelId);
      if (!ch) return null;
      return 'members' in ch && ch.type === ChannelType.GuildVoice ? [...ch.members.keys()] : [];
    },
    async deleteChannel(channelId) {
      const ch = await channelById(channelId);
      await ch?.delete().catch((err: unknown) => {
        if (codeOf(err) !== UNKNOWN_CHANNEL) throw err;
      });
    },
  };

  const roles: RoleOps = {
    async add(userId, roleId) {
      const member = await guild.members.fetch(userId);
      await member.roles.add(roleId);
    },
    async remove(userId, roleId) {
      const member = await guild.members.fetch(userId);
      await member.roles.remove(roleId);
    },
    async has(userId, roleId) {
      // Null rather than false when the member cannot be read: "we could not
      // tell" and "they do not have it" lead to opposite replies, and guessing
      // would tell someone they had been removed from a role they still hold.
      try {
        const member = await guild.members.fetch(userId);
        return member.roles.cache.has(roleId);
      } catch (err) {
        console.error(`[discord] could not read roles for ${userId}:`, err);
        return null;
      }
    },
  };

  const threadById = async (id: string): Promise<AnyThreadChannel | null> => {
    // guild.channels holds threads too (GuildBasedChannel :7965, fetch :5040).
    // An archived thread is not cached, so this falls through to a fetch.
    const ch = await channelById(id);
    return ch && ch.isThread() ? ch : null;                                   // isThread :1108
  };
  const needThread = async (id: string): Promise<AnyThreadChannel> => {
    const th = await threadById(id);
    if (!th) throw new Error(`thread ${id} does not exist`);
    return th;
  };

  /** Tag names to this forum's tag ids, creating what is missing. Moderated,
   *  so only the bot (Manage Threads) can put them on a post. A post carries
   *  at most five. availableTags :3147, setAvailableTags :3155,
   *  GuildForumTagData :3122. */
  const tagIds = async (forum: ForumChannel, names: string[]): Promise<string[]> => {
    const missing = names.filter((n) => !forum.availableTags.some((t) => t.name === n));
    const current = missing.length === 0 ? forum
      : await forum.setAvailableTags([...forum.availableTags, ...missing.map((name) => ({ name, moderated: true }))]);
    return names.map((n) => current.availableTags.find((t) => t.name === n)?.id).filter((id): id is string => !!id).slice(0, 5);
  };

  const threads: ThreadOps = {
    async createForumPost(forumId, post) {
      const forum = await channelById(forumId);
      if (!forum || forum.type !== ChannelType.GuildForum) throw new Error(`channel ${forumId} is not a forum`);
      const m = toMessage(post.message);
      // GuildForumThreadManager.create :5406, GuildForumThreadCreateOptions
      // :7987 ({ name, message, appliedTags }), StartThreadOptions :7865.
      const thread = await forum.threads.create({
        name: post.name.slice(0, 100),
        autoArchiveDuration: ThreadAutoArchiveDuration.OneWeek,
        message: { content: m.content || undefined, embeds: m.embeds, components: m.components as never, allowedMentions: m.allowedMentions },
        appliedTags: await tagIds(forum, post.tags),
      });
      // A forum post's first message has the id of the thread itself.
      return { threadId: thread.id, messageId: thread.id };
    },
    async createPrivateThread(channelId, thread) {
      const ch = await channelById(channelId);
      if (!ch || ch.type !== ChannelType.GuildText) throw new Error(`channel ${channelId} is not a text channel`);
      // GuildTextThreadManager.create :5400, GuildTextThreadCreateOptions
      // :7981 ({ type, invitable }). invitable false: only the bot adds people.
      const made = await ch.threads.create({
        name: thread.name.slice(0, 100),
        type: ChannelType.PrivateThread,
        invitable: false,
        autoArchiveDuration: ThreadAutoArchiveDuration.OneWeek,
      });
      return { threadId: made.id };
    },
    async exists(threadId) {
      return (await threadById(threadId)) !== null;
    },
    async addMember(threadId, userId) {
      await (await needThread(threadId)).members.add(userId);                 // ThreadMemberManager.add :5416
    },
    async removeMember(threadId, userId) {
      try {
        await (await needThread(threadId)).members.remove(userId);            // ThreadMemberManager.remove :5435
      } catch (err) {
        if (codeOf(err) !== UNKNOWN_MEMBER) throw err;
      }
    },
    async memberIds(threadId) {
      const th = await threadById(threadId);
      if (!th) return null;
      const members = await th.members.fetch();                               // ThreadMemberManager.fetch :5431
      return [...members.keys()].filter((id) => id !== client.user!.id);
    },
    async setLocked(threadId, locked) {
      await (await needThread(threadId)).setLocked(locked);                   // ThreadChannel.setLocked :3980
    },
    async setArchived(threadId, archived) {
      await (await needThread(threadId)).setArchived(archived);               // ThreadChannel.setArchived :3977
    },
    async setTags(threadId, tags) {
      const th = await needThread(threadId);
      const forum = th.parent;
      if (!forum || forum.type !== ChannelType.GuildForum) return;
      await th.setAppliedTags(await tagIds(forum, tags));                     // ThreadChannel.setAppliedTags :3983
    },
    async deleteThread(threadId) {
      const th = await threadById(threadId);
      await th?.delete().catch((err: unknown) => {                            // ThreadChannel.delete :3966
        if (codeOf(err) !== UNKNOWN_CHANNEL) throw err;
      });
    },
    async syncMemberAccess(channelId, userIds) {
      const ch = await channelById(channelId);
      if (!ch || !('permissionOverwrites' in ch)) throw new Error(`channel ${channelId} cannot hold permission overwrites`);
      const me = client.user!.id;
      // Member overwrites only, and never the bot's own: the owner's role
      // overwrites (everyone denied, the bot's role allowed) are not ours.
      const have = [...ch.permissionOverwrites.cache.values()]                // permissionOverwrites :1827
        .filter((o) => o.type === OverwriteType.Member && o.id !== me).map((o) => o.id);
      const want = new Set(userIds);
      const added: string[] = [];
      const failed: string[] = [];
      for (const id of want) {
        if (have.includes(id)) continue;
        try {
          // An overwrite for someone who is not in the guild is rejected.
          await guild.members.fetch(id);
          await ch.permissionOverwrites.create(id, {                          // PermissionOverwriteManager.create :5320
            ViewChannel: true, ReadMessageHistory: true, SendMessagesInThreads: true,
            AttachFiles: true, EmbedLinks: true, AddReactions: true,
          });
          added.push(id);
        } catch (err) {
          console.error(`[discord] could not give ${id} access to ${channelId}:`, err);
          failed.push(id);
        }
      }
      const removed = have.filter((id) => !want.has(id));
      for (const id of removed) await ch.permissionOverwrites.delete(id);     // PermissionOverwriteManager.delete :5330
      return { added, removed, failed };
    },
  };

  return {
    roles,
    async send(channelId, payload) {
      const ch = await textChannel(channelId);
      const msg = await ch.send(toMessage(payload));
      return msg.id as string;
    },
    async edit(channelId, messageId, payload) {
      const ch = await textChannel(channelId);
      try {
        const msg = await ch.messages.fetch(messageId);
        const m = toMessage(payload);
        await msg.edit({ content: m.content, embeds: m.embeds, components: m.components as never, allowedMentions: m.allowedMentions });
        return true;
      } catch (err) {
        if (codeOf(err) === UNKNOWN_MESSAGE) return false;
        throw err;
      }
    },
    async remove(channelId, messageId) {
      const ch = await textChannel(channelId);
      try {
        const msg = await ch.messages.fetch(messageId);
        await msg.delete();
      } catch (err) {
        if (codeOf(err) !== UNKNOWN_MESSAGE) throw err;
      }
    },
    async dm(userId, payload) {
      // No extra gateway intent: sending a DM is a REST call. users.fetch
      // resolves anyone by id; send() is what fails for closed DMs (50007).
      const user = await client.users.fetch(userId);
      const m = toMessage(payload);
      await user.send({
        content: m.content || undefined, embeds: m.embeds, components: m.components as never,
        allowedMentions: m.allowedMentions,
      });
    },
    onInteraction(h, opts) {
      handler = h;
      opensModal = opts?.opensModal ?? null;
    },
    async registerCommands(defs: SlashCommandDef[]) {
      await guild.commands.set(defs.map((d) => ({
        type: ApplicationCommandType.ChatInput as const,
        name: d.name,
        description: d.description,
        options: (d.options ?? []).map((o) => ({
          name: o.name,
          description: o.description,
          required: o.required ?? false,
          type: o.type === 'user' ? ApplicationCommandOptionType.User
            : o.type === 'integer' ? ApplicationCommandOptionType.Integer : ApplicationCommandOptionType.String,
          ...(o.choices ? { choices: o.choices } : {}),
        })) as never,
      })));
    },
    async watchMembers(h) {
      client.on(Events.GuildMemberAdd, (m) => { if (m.guild.id === guild.id) h.add(m.id); });
      client.on(Events.GuildMemberRemove, (m) => { if (m.guild.id === guild.id) h.remove(m.id); });
      const all = await guild.members.fetch();
      h.all([...all.keys()]);
      console.log(`[discord] tracking ${all.size} server members`);
    },
    async watchVoice(h) {
      client.on(Events.VoiceStateUpdate, (_before, after) => {
        if (after.guild.id === guild.id) h.update(after.id, after.channelId ?? null);
      });
      // The gateway sends the guild's voice states with the guild itself, so
      // this cache is complete as soon as the client is ready.
      const states: [string, string][] = [];
      for (const vs of guild.voiceStates.cache.values()) {
        if (vs.channelId) states.push([vs.id, vs.channelId]);
      }
      h.all(states);
      console.log(`[discord] tracking voice: ${states.length} in a channel`);
    },
    voice,
    threads,
    async destroy() {
      await client.destroy();
    },
  };
}
