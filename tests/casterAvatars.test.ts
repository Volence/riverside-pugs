import { describe, it, expect } from 'vitest';
import { openDb } from '../src/db.js';
import { casterAvatars } from '../src/cast/casterAvatars.js';

const line = (name: string, handle = '') => ({ name, handle, camUrl: '', ownCam: false });

describe('caster avatars (no-camera tile)', () => {
  it('matches the Twitch handle first, then the name, then Discord, and only a single account', () => {
    const db = openDb(':memory:');
    const add = (id: string, name: string, avatar: string | null, extra: Record<string, string> = {}) => {
      db.prepare('INSERT INTO players (steamid, name, avatar) VALUES (?, ?, ?)').run(id, name, avatar);
      for (const [k, v] of Object.entries(extra)) db.prepare(`UPDATE players SET ${k} = ? WHERE steamid = ?`).run(v, id);
    };
    add('76561198000000001', 'Volence', 'https://a/v.jpg', { twitch_name: 'volencetv' });
    add('76561198000000002', 'Mike', 'https://a/m1.jpg');
    add('76561198000000003', 'mike', 'https://a/m2.jpg');
    add('76561198000000004', 'Quiet', null);
    add('76561198000000005', 'Steamname', 'https://a/d.jpg', { discord_name: 'discordguy' });
    expect(casterAvatars(db, [
      line('Someone else', 'twitch.tv/VolenceTV'),
      line('VOLENCE'),
      line('Mike'),
      line('Quiet'),
      line('discordguy'),
      line('Nobody', '@nobody'),
    ])).toEqual(['https://a/v.jpg', 'https://a/v.jpg', null, null, 'https://a/d.jpg', null]);
  });
});
