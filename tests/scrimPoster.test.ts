import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { openDb, type DB } from '../src/db.js';
import { addServer } from '../src/serverPool.js';
import { setSetting } from '../src/settings.js';
import { escapeName } from '../src/identity.js';
import { createTeam } from '../src/teams/teams.js';
import { acceptPost, confirmAccept, createPost, withdrawPost, type ScrimResult } from '../src/scrims/scrims.js';
import { ScrimPoster } from '../src/scrims/poster.js';
import { FakeTransport, type FakeMessage } from './fakes/fakeTransport.js';

const P = Array.from({ length: 3 }, (_, i) => `765611990000050${String(i).padStart(2, '0')}`);
const NOW = new Date('2026-10-01T12:00:00.000Z');
const START = '2026-10-02T20:00:00.000Z';
const PUBLIC_URL = 'https://riversidepug.test';
const CHANNEL = 'scrims-channel';

let db: DB;
let t: FakeTransport;
let poster: ScrimPoster;

const value = <T>(r: ScrimResult<T>): T => {
  if (!r.ok) throw new Error(r.error);
  return r.value;
};

beforeEach(() => {
  db = openDb(':memory:');
  const ins = db.prepare("INSERT INTO players (steamid, name, status) VALUES (?, ?, 'active')");
  P.forEach((id, i) => ins.run(id, `p${i}`));
  setSetting(db, 'competitive_enabled', 'everyone');
  setSetting(db, 'map_pool', JSON.stringify(['no_mercy', 'death_toll']));
  for (const n of ['a', 'bb', 'ccc']) {
    const id = addServer(db, { name: n, host: 'h', port: 27000 + n.length, rconPort: 1, rconPassword: 'x' });
    db.prepare("UPDATE servers SET status = 'idle' WHERE id = ?").run(id);
  }
  t = new FakeTransport();
  poster = new ScrimPoster({ db, transport: t, publicUrl: PUBLIC_URL, tickMs: 0 });
});
afterEach(() => poster.stop());

/** A public, pickup-side post by P[0], in the shared shape every test needs. */
function postId(note = ''): number {
  return value(createPost(db, {
    by: P[0], startsAt: START, minutes: 90, campaigns: ['no_mercy'], srRange: null, note, now: NOW,
  })).id;
}

const cardRow = (id: number) => db.prepare("SELECT * FROM discord_messages WHERE kind = 'scrim' AND ref = ?")
  .get(String(id)) as { channel_id: string; message_id: string; state: string } | undefined;
const liveIn = (channel: string) => t.live().filter((m) => m.channelId === channel);
const byId = (id: string): FakeMessage => t.live().find((m) => m.id === id)!;
const statusField = (m: FakeMessage) => (m.payload.embeds[0].fields as { name: string; value: string }[])
  .find((f) => f.name === 'Status')!.value;

describe('ScrimPoster', () => {
  it('posts a card for a public post, with the ruling 5 fields and a link button, and never for a challenge', async () => {
    setSetting(db, 'discord_scrims_channel_id', CHANNEL);
    const publicId = postId();
    const team = createTeam(db, { creator: P[1], name: 'Rats', tag: 'RR', now: NOW });
    if (!team.ok) throw new Error(team.error);
    const targetTeamId = team.value.id;
    const challengeId = value(createPost(db, {
      by: P[0], startsAt: START, minutes: 90, campaigns: ['no_mercy'], srRange: null, note: '', targetTeamId, now: NOW,
    })).id;

    await poster.tickNow();

    expect(liveIn(CHANNEL)).toHaveLength(1);
    const card = cardRow(publicId)!;
    expect(card.channel_id).toBe(CHANNEL);
    expect(cardRow(challengeId)).toBeUndefined();

    const msg = byId(card.message_id);
    expect(msg.payload.embeds[0].title).toBe('p0');
    const fields = msg.payload.embeds[0].fields as { name: string; value: string }[];
    expect(fields.find((f) => f.name === 'When')!.value).toBe(`<t:${Math.floor(Date.parse(START) / 1000)}:F>`);
    expect(fields.find((f) => f.name === 'Length')!.value).toBe('90 min');
    expect(fields.find((f) => f.name === 'Campaigns')!.value).toBe('No Mercy');
    expect(fields.find((f) => f.name === 'Average SR')).toBeTruthy();
    expect(msg.payload.components).toEqual([[{ kind: 'link', url: `${PUBLIC_URL}/scrims?post=${publicId}`, label: 'Accept on the site' }]]);
  });

  it('edits the card when the post is accepted (open -> pending)', async () => {
    setSetting(db, 'discord_scrims_channel_id', CHANNEL);
    const id = postId();
    await poster.tickNow();
    const card = cardRow(id)!;
    expect(statusField(byId(card.message_id))).toBe('Open');

    value(acceptPost(db, { postId: id, by: P[1], now: NOW }));
    await poster.tickNow();

    expect(t.edits).toBe(1);
    expect(statusField(byId(cardRow(id)!.message_id))).toMatch(/under review/);
  });

  it('edits the card to the closed line once the post is withdrawn, then never again', async () => {
    setSetting(db, 'discord_scrims_channel_id', CHANNEL);
    const id = postId();
    await poster.tickNow();
    const card = cardRow(id)!;

    value(withdrawPost(db, { postId: id, by: P[0], now: NOW }));
    await poster.tickNow();

    expect(t.edits).toBe(1);
    const closed = byId(card.message_id);
    expect(closed.payload.embeds[0].description).toBe('Withdrawn');
    expect(closed.payload.components).toEqual([]);
    expect(cardRow(id)!.state).toBe('closed');

    await poster.tickNow();
    expect(t.edits).toBe(1);
  });

  it('posts nothing when the scrims channel setting is blank', async () => {
    const id = postId();
    await poster.tickNow();
    expect(cardRow(id)).toBeUndefined();
    expect(t.sends).toBe(0);
  });

  it('sends no new card while competitive play is not public (admins or off), but keeps updating and closing one already posted', async () => {
    setSetting(db, 'discord_scrims_channel_id', CHANNEL);
    setSetting(db, 'competitive_enabled', 'admins');
    db.prepare("UPDATE players SET is_admin = 1 WHERE steamid = ?").run(P[0]); // canUse needs it, under 'admins'
    const underAdmins = postId();
    await poster.tickNow();
    expect(cardRow(underAdmins)).toBeUndefined();
    expect(t.sends).toBe(0);

    setSetting(db, 'competitive_enabled', 'off');
    await poster.tickNow();
    expect(cardRow(underAdmins)).toBeUndefined();
    expect(t.sends).toBe(0);
    // Withdrawn while never public, so it never gets a card even once the
    // switch later moves to 'everyone'.
    value(withdrawPost(db, { postId: underAdmins, by: P[0], now: NOW }));

    // A post whose card went out while public stays alive: it still updates
    // and closes after the switch moves back off 'everyone'.
    setSetting(db, 'competitive_enabled', 'everyone');
    const live = postId();
    await poster.tickNow();
    const card = cardRow(live)!;
    expect(t.sends).toBe(1);

    // acceptPost and withdrawPost need the switch at 'everyone' themselves
    // (they gate on canUse); only the poster's own behavior is under test.
    value(acceptPost(db, { postId: live, by: P[1], now: NOW }));
    setSetting(db, 'competitive_enabled', 'admins');
    await poster.tickNow();
    expect(t.edits).toBe(1);
    expect(statusField(byId(cardRow(live)!.message_id))).toMatch(/under review/);

    setSetting(db, 'competitive_enabled', 'everyone');
    value(withdrawPost(db, { postId: live, by: P[0], now: NOW }));
    setSetting(db, 'competitive_enabled', 'off');
    await poster.tickNow();
    const closed = byId(cardRow(live)!.message_id);
    expect(closed.id).toBe(card.message_id);
    expect(closed.payload.embeds[0].description).toBe('Withdrawn');
    expect(cardRow(live)!.state).toBe('closed');
  });

  it('retries an edit that throws on the next tick, without losing or duplicating the card', async () => {
    setSetting(db, 'discord_scrims_channel_id', CHANNEL);
    const id = postId();
    await poster.tickNow();
    const card = cardRow(id)!;

    value(acceptPost(db, { postId: id, by: P[1], now: NOW }));
    t.failEdits = 1;
    await poster.tickNow();

    // Nothing changed: same message id, and Discord still shows the stale copy.
    expect(cardRow(id)).toEqual(card);
    expect(statusField(byId(card.message_id))).toBe('Open');

    await poster.tickNow();
    expect(statusField(byId(cardRow(id)!.message_id))).toMatch(/under review/);
  });

  it('reposts a card whose message was deleted by hand', async () => {
    setSetting(db, 'discord_scrims_channel_id', CHANNEL);
    const id = postId();
    await poster.tickNow();
    const card = cardRow(id)!;
    t.messages.find((m) => m.id === card.message_id)!.deleted = true;

    value(acceptPost(db, { postId: id, by: P[1], now: NOW }));
    await poster.tickNow();

    const after = cardRow(id)!;
    expect(after.message_id).not.toBe(card.message_id);
    expect(after.channel_id).toBe(CHANNEL);
    expect(statusField(byId(after.message_id))).toMatch(/under review/);
  });

  it('escapes the note shown on the card', async () => {
    setSetting(db, 'discord_scrims_channel_id', CHANNEL);
    const note = 'gg *see you* [here](http://evil.example)';
    const id = postId(note);
    await poster.tickNow();
    const msg = byId(cardRow(id)!.message_id);
    const field = (msg.payload.embeds[0].fields as { name: string; value: string }[]).find((f) => f.name === 'Note')!;
    expect(field.value).toBe(escapeName(note));
    expect(field.value).not.toBe(note);
  });

  it('sends a fresh closed card when the open message was deleted by hand', async () => {
    setSetting(db, 'discord_scrims_channel_id', CHANNEL);
    const id = postId();
    await poster.tickNow();
    const card = cardRow(id)!;
    t.messages.find((m) => m.id === card.message_id)!.deleted = true;

    value(withdrawPost(db, { postId: id, by: P[0], now: NOW }));
    await poster.tickNow();

    const after = cardRow(id)!;
    expect(after.message_id).not.toBe(card.message_id);
    expect(after.channel_id).toBe(CHANNEL);
    expect(after.state).toBe('closed');
    const reposted = byId(after.message_id);
    expect(reposted.payload.embeds[0].description).toBe('Withdrawn');
    expect(reposted.payload.components).toEqual([]);
  });

  it('leaves the row open when the close edit throws, and closes it on the next tick', async () => {
    setSetting(db, 'discord_scrims_channel_id', CHANNEL);
    const id = postId();
    await poster.tickNow();
    const card = cardRow(id)!;

    value(withdrawPost(db, { postId: id, by: P[0], now: NOW }));
    t.failEdits = 1;
    await poster.tickNow();

    expect(cardRow(id)).toEqual(card);
    expect(t.edits).toBe(0);

    await poster.tickNow();
    const closedRow = cardRow(id)!;
    expect(closedRow.state).toBe('closed');
    expect(byId(closedRow.message_id).payload.embeds[0].description).toBe('Withdrawn');
  });

  describe('the weekly scrim night reminder', () => {
    function thursdayNight() {
      setSetting(db, 'scrim_night_day', 'thursday');
      setSetting(db, 'scrim_night_start_utc', '21:00');
      setSetting(db, 'scrim_night_hours', '4');
    }
    const reminderRow = () => db.prepare("SELECT * FROM discord_messages WHERE kind = 'scrim_night'")
      .get() as { ref: string; channel_id: string; message_id: string; state: string } | undefined;

    it('sends once, 2 hours before the window opens, and never again (even across a fresh poster instance)', async () => {
      setSetting(db, 'discord_scrims_channel_id', CHANNEL);
      thursdayNight();
      // The window starts 2026-10-01T21:00:00.000Z (a Thursday); 19:30 is
      // inside the 2 hour lead.
      poster = new ScrimPoster({ db, transport: t, publicUrl: PUBLIC_URL, tickMs: 0 });
      await poster.tickNow();
      expect(t.sends).toBe(0);

      const inLead = new Date('2026-10-01T19:30:00.000Z');
      const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(inLead.getTime());
      try {
        await poster.tickNow();
        expect(liveIn(CHANNEL)).toHaveLength(1);
        const row = reminderRow()!;
        expect(row.ref).toBe('2026-10-01T21:00:00.000Z');
        expect(row.state).toBe('closed');
        const msg = byId(row.message_id);
        expect(msg.payload.content).toContain('Scrim night starts in about 2 hours');
        expect(msg.payload.content).toContain(`<t:${Math.floor(Date.parse('2026-10-01T21:00:00.000Z') / 1000)}:`);
        expect(msg.payload.content).toContain(`${PUBLIC_URL}/scrims`);

        // A second tick in the same lead window sends nothing more.
        await poster.tickNow();
        expect(t.sends).toBe(1);

        // A restart (a fresh poster, same message store) still sends nothing.
        const restarted = new ScrimPoster({ db, transport: t, publicUrl: PUBLIC_URL, tickMs: 0 });
        await restarted.tickNow();
        restarted.stop();
        expect(t.sends).toBe(1);
      } finally {
        nowSpy.mockRestore();
      }
    });

    it('sends nothing while competitive play is not public, or with no channel set', async () => {
      thursdayNight();
      const inLead = new Date('2026-10-01T19:30:00.000Z');
      const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(inLead.getTime());
      try {
        // No channel set at all.
        await poster.tickNow();
        expect(t.sends).toBe(0);
        expect(reminderRow()).toBeUndefined();

        // Channel set, but competitive play not public.
        setSetting(db, 'discord_scrims_channel_id', CHANNEL);
        setSetting(db, 'competitive_enabled', 'admins');
        await poster.tickNow();
        expect(t.sends).toBe(0);
        expect(reminderRow()).toBeUndefined();
      } finally {
        nowSpy.mockRestore();
      }
    });

    it('retries a failed send on the next tick', async () => {
      setSetting(db, 'discord_scrims_channel_id', CHANNEL);
      thursdayNight();
      const inLead = new Date('2026-10-01T19:30:00.000Z');
      const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(inLead.getTime());
      try {
        t.failSends = 1;
        await poster.tickNow();
        expect(t.sends).toBe(0);
        expect(reminderRow()).toBeUndefined();

        await poster.tickNow();
        expect(t.sends).toBe(1);
        expect(reminderRow()).toBeTruthy();
      } finally {
        nowSpy.mockRestore();
      }
    });

    it('sends nothing outside the 2 hour lead, before or after it opens', async () => {
      setSetting(db, 'discord_scrims_channel_id', CHANNEL);
      thursdayNight();
      for (const at of ['2026-10-01T18:59:00.000Z', '2026-10-01T21:00:00.000Z', '2026-10-01T22:00:00.000Z']) {
        const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(new Date(at).getTime());
        try {
          await poster.tickNow();
        } finally {
          nowSpy.mockRestore();
        }
      }
      expect(t.sends).toBe(0);
      expect(reminderRow()).toBeUndefined();
    });
  });

  it('closes a booked post with the Booked line', async () => {
    setSetting(db, 'discord_scrims_channel_id', CHANNEL);
    const id = postId();
    await poster.tickNow();
    const card = cardRow(id)!;

    const acceptId = value(acceptPost(db, { postId: id, by: P[1], now: NOW })).id;
    value(confirmAccept(db, { acceptId, by: P[0], now: NOW }));
    await poster.tickNow();

    const closedRow = cardRow(id)!;
    expect(closedRow.state).toBe('closed');
    const closed = byId(closedRow.message_id);
    expect(closed.id).toBe(card.message_id);
    expect(closed.payload.embeds[0].description).toBe('Booked');
    expect(closed.payload.components).toEqual([]);
  });
});
