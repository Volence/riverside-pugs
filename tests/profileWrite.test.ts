import { describe, it, expect, beforeEach } from 'vitest';
import { openDb, type DB } from '../src/db.js';
import {
  getProfileFields, linkTwitch, saveProfileFields, socialLinks, unlinkTwitch, upsertPlayer,
} from '../src/players.js';

const P1 = '76561198000000001';
const P2 = '76561198000000002';
let db: DB;

beforeEach(() => {
  db = openDb(':memory:');
  upsertPlayer(db, { steamid: P1, name: 'alice', avatar: null }, []);
  upsertPlayer(db, { steamid: P2, name: 'bob', avatar: null }, []);
});

describe('saveProfileFields', () => {
  it('starts empty', () => {
    expect(getProfileFields(db, P1)).toEqual({ bio: null, pronouns: null, country: null, links: {} });
  });

  it('saves and reads back every field', () => {
    const r = saveProfileFields(db, P1, {
      bio: 'i main hunter', pronouns: 'they/them', country: 'us',
      links: { x: '@alice', youtube: 'alicetv' },
    });
    expect(r.ok).toBe(true);
    expect(getProfileFields(db, P1)).toEqual({
      bio: 'i main hunter', pronouns: 'they/them', country: 'US',
      links: { x: 'alice', youtube: 'alicetv' },
    });
  });

  it('rejects the whole write when any field is invalid, changing nothing', () => {
    saveProfileFields(db, P1, { bio: 'good', links: {} });
    const r = saveProfileFields(db, P1, { bio: 'visit evil.gg', pronouns: 'they/them', links: {} });
    expect(r.ok).toBe(false);
    expect(getProfileFields(db, P1).bio).toBe('good');
    expect(getProfileFields(db, P1).pronouns).toBe(null);
  });

  it('rejects an invalid handle without saving the valid fields beside it', () => {
    const r = saveProfileFields(db, P1, {
      bio: 'fine', links: { x: 'https://x.com/alice' },
    });
    expect(r.ok).toBe(false);
    expect(getProfileFields(db, P1)).toEqual({ bio: null, pronouns: null, country: null, links: {} });
  });

  it('rejects an unknown platform', () => {
    expect(saveProfileFields(db, P1, { links: { myspace: 'alice' } }).ok).toBe(false);
  });

  it('rejects a body that is not an object', () => {
    expect(saveProfileFields(db, P1, null).ok).toBe(false);
    expect(saveProfileFields(db, P1, 'bio').ok).toBe(false);
    expect(saveProfileFields(db, P1, { links: 'x' }).ok).toBe(false);
  });

  it('clears a field with an empty string', () => {
    saveProfileFields(db, P1, { bio: 'hello', links: { x: 'alice' } });
    saveProfileFields(db, P1, { bio: '', links: { x: '' } });
    expect(getProfileFields(db, P1)).toEqual({ bio: null, pronouns: null, country: null, links: {} });
  });

  it('leaves a platform alone when the body does not mention it', () => {
    saveProfileFields(db, P1, { links: { x: 'alice', youtube: 'alicetv' } });
    saveProfileFields(db, P1, { links: { x: 'alice2' } });
    expect(getProfileFields(db, P1).links).toEqual({ x: 'alice2', youtube: 'alicetv' });
  });

  it('leaves other players alone', () => {
    saveProfileFields(db, P1, { bio: 'mine', links: { x: 'alice' } });
    expect(getProfileFields(db, P2)).toEqual({ bio: null, pronouns: null, country: null, links: {} });
  });
});

describe('socialLinks', () => {
  it('returns a built URL per saved handle, in platform order', () => {
    saveProfileFields(db, P1, { links: { tiktok: 'alice', x: 'alice' } });
    expect(socialLinks(db, P1)).toEqual([
      { platform: 'x', label: 'X', handle: 'alice', url: 'https://x.com/alice' },
      { platform: 'tiktok', label: 'TikTok', handle: 'alice', url: 'https://www.tiktok.com/@alice' },
    ]);
  });

  it('ignores a row whose platform is no longer known', () => {
    db.prepare('INSERT INTO player_links (player_id, platform, handle) VALUES (?,?,?)')
      .run(P1, 'myspace', 'alice');
    expect(socialLinks(db, P1)).toEqual([]);
  });

  it('is empty for a player with nothing saved', () => {
    expect(socialLinks(db, P1)).toEqual([]);
  });
});

describe('twitch link', () => {
  it('links and unlinks', () => {
    expect(linkTwitch(db, P1, '999', 'alicetv').ok).toBe(true);
    const row = db.prepare('SELECT twitch_id, twitch_name FROM players WHERE steamid = ?').get(P1);
    expect(row).toEqual({ twitch_id: '999', twitch_name: 'alicetv' });
    unlinkTwitch(db, P1);
    expect(db.prepare('SELECT twitch_id FROM players WHERE steamid = ?').get(P1))
      .toEqual({ twitch_id: null });
  });

  it('refuses a channel another player already holds', () => {
    linkTwitch(db, P1, '999', 'alicetv');
    expect(linkTwitch(db, P2, '999', 'alicetv').ok).toBe(false);
    expect(db.prepare('SELECT twitch_id FROM players WHERE steamid = ?').get(P2))
      .toEqual({ twitch_id: null });
  });

  it('relinking the same channel to the same player is fine', () => {
    linkTwitch(db, P1, '999', 'alicetv');
    expect(linkTwitch(db, P1, '999', 'alice_tv').ok).toBe(true);
    expect(db.prepare('SELECT twitch_name FROM players WHERE steamid = ?').get(P1))
      .toEqual({ twitch_name: 'alice_tv' });
  });

  it('unlinking drops the cached status row', () => {
    linkTwitch(db, P1, '999', 'alicetv');
    db.prepare('INSERT INTO twitch_status (player_id, is_live, checked_at) VALUES (?,1,?)')
      .run(P1, '2026-09-20T00:00:00Z');
    unlinkTwitch(db, P1);
    expect(db.prepare('SELECT COUNT(*) AS n FROM twitch_status').get()).toEqual({ n: 0 });
  });

  it('unlinking somebody with no link at all is a no-op, not an error', () => {
    expect(() => unlinkTwitch(db, P1)).not.toThrow();
  });
});
