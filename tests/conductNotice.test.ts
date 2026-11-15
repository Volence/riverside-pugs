import { describe, it, expect, beforeEach } from 'vitest';
import { openDb, type DB } from '../src/db.js';
import { upsertPlayer } from '../src/players.js';
import { setSetting } from '../src/settings.js';
import { handleConduct, type ConductPost } from '../src/conductFlags.js';
import { conductNoticeText, sendConductNotice } from '../src/conductNotice.js';
import type { LeaseRcon } from '../src/practiceLeases.js';

const P = '76561199048276493';
const t0 = new Date('2026-11-15T20:00:00Z');
const at = (s: number) => new Date(t0.getTime() + s * 1000);

let db: DB;
let sent: string[];
const rcon: LeaseRcon = async (_server, commands) => { sent.push(...commands); return commands.map(() => 'staffsay delivered=1'); };

beforeEach(() => {
  db = openDb(':memory:');
  upsertPlayer(db, { steamid: P, name: 'zero', avatar: null }, []);
  db.prepare("INSERT INTO servers (id, name, host, port, rcon_port, rcon_password) VALUES (1, 'Dallas', '127.0.0.1', 27015, 27015, 'x')").run();
  setSetting(db, 'discord_admin_channel_id', 'admins');
  sent = [];
});

/** What server.ts does with each line: notify on every post handleConduct makes. */
async function line(ev: Parameters<typeof handleConduct>[1], s: number, serverId: number | null = 1): Promise<void> {
  const post = handleConduct(db, ev, serverId, at(s));
  if (post) await sendConductNotice(db, rcon, post);
}

describe('the conduct notice to the player', () => {
  it('the exact wording, short and with no em dash', () => {
    expect(conductNoticeText('chat')).toBe('Staff were notified about your chat message.');
    expect(conductNoticeText('name')).toBe('Staff were notified about your name.');
    expect(conductNoticeText('chat') + conductNoticeText('name')).not.toMatch(/\u2014/);
  });

  it('is one private whisper per staff post, not one per line of a stream', async () => {
    const say = (message: string) => ({ kind: 'say' as const, steamid: P, team: 3, scope: null, message });
    await line(say('nigger'), 0);
    await line(say('faggot'), 30);
    await line(say('retard'), 80);
    await line(say('kys'), 150);
    expect(sent).toEqual([
      `sm_pug_staffsay ${P} "PUG" "Staff were notified about your chat message." 1`,
      `sm_pug_staffsay ${P} "PUG" "Staff were notified about your chat message." 2`,
    ]);
    // Kept in that server's chat log like any staff whisper.
    const rows = db.prepare("SELECT kind, to_kind, to_value, sent_by, name FROM server_chat ORDER BY id").all();
    expect(rows).toEqual([
      { kind: 'staff_out', to_kind: 'player', to_value: P, sent_by: 'system', name: 'PUG' },
      { kind: 'staff_out', to_kind: 'player', to_value: P, sent_by: 'system', name: 'PUG' },
    ]);
  });

  it('says it was their name for a name hit, once per name', async () => {
    const name = (n: string) => ({ kind: 'name' as const, steamid: P, event: 'connect' as const, name: n });
    await line(name('n1gga'), 0);
    await line(name('n1gga'), 3600);
    expect(sent).toEqual([`sm_pug_staffsay ${P} "PUG" "Staff were notified about your name." 1`]);
  });

  it('sends nothing when staff were not told: the feed off, no channel, or no server', async () => {
    const say = { kind: 'say' as const, steamid: P, team: 3, scope: null, message: 'nigger' };
    setSetting(db, 'admin_feed_conduct', '0');
    await line(say, 0);
    setSetting(db, 'admin_feed_conduct', '1');
    setSetting(db, 'discord_admin_channel_id', '');
    await line(say, 100);
    setSetting(db, 'discord_admin_channel_id', 'admins');
    await line(say, 200, null);
    expect(sent).toEqual([]);
  });

  it('fails silently when the server cannot be reached', async () => {
    const down: LeaseRcon = async () => { throw new Error('ECONNREFUSED'); };
    const post = handleConduct(db, { kind: 'say', steamid: P, team: 3, scope: null, message: 'nigger' }, 1, t0) as ConductPost;
    await expect(sendConductNotice(db, down, post)).resolves.toBe(false);
    const gone = { ...post, serverId: 99 };
    await expect(sendConductNotice(db, rcon, gone)).resolves.toBe(false);
  });
});
