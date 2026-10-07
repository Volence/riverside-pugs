import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { mkdtempSync, readdirSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config.js';
import { buildServer } from '../src/server.js';
import { authedCookie, stubOrchestrator } from './helpers.js';
import * as D from '../src/events/drafts.js';
import * as N from '../src/events/entries.js';
import * as E from '../src/events/events.js';
import { ADMIN, NOW } from './eventFixture.js';
import { P, cutDraft, type DraftFixture } from './draftFixture.js';
import { png } from './pngFixture.js';

const days = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString();
const ID = (f: DraftFixture, entryId: number, o: { steamid: string; staff?: boolean; name?: string; tag?: string; logoKey?: string | null }) =>
  N.setEntryIdentity(f.db, { eventId: f.eventId, entryId, staff: false, now: NOW, ...o });
const err = (r: { ok: boolean; error?: string }) => (r.ok ? null : r.error);

/** A draft with its teams published: entries[i] is captain CAPS[i]'s. */
function made(): { f: DraftFixture; entries: N.EntryRow[] } {
  const f = cutDraft({ balance: true, startsAt: days(9) });
  const r = N.createDraftEntries(f.db, { eventId: f.eventId, actor: ADMIN, now: NOW });
  if (!r.ok) throw new Error(r.error);
  return { f, entries: N.entriesOf(f.db, f.eventId) };
}
const capOf = (e: N.EntryRow) => e.captain_steamid!;

describe('setEntryIdentity', () => {
  it('lets the captain rename, tag and give a logo, one log row each, leaving other fields alone', () => {
    const { f, entries } = made();
    const e = entries[0]!;
    expect(ID(f, e.id, { steamid: capOf(e), name: '  Night   Owls ' }).ok).toBe(true);
    expect(N.getEntry(f.db, e.id)).toMatchObject({ name: 'Night Owls', tag: '' });
    expect(ID(f, e.id, { steamid: capOf(e), tag: 'OWL' }).ok).toBe(true);
    expect(N.getEntry(f.db, e.id)).toMatchObject({ name: 'Night Owls', tag: 'OWL' });
    const key = 'a'.repeat(64);
    expect(ID(f, e.id, { steamid: capOf(e), logoKey: key }).ok).toBe(true);
    expect(N.getEntry(f.db, e.id)).toMatchObject({ name: 'Night Owls', tag: 'OWL', logo_key: key });
    expect(ID(f, e.id, { steamid: capOf(e), tag: '' }).ok).toBe(true);
    expect(N.getEntry(f.db, e.id)!.tag).toBe('');
    expect(f.db.prepare("SELECT COUNT(*) AS n FROM event_log WHERE action = 'entry_identity_set'").get()).toEqual({ n: 4 });
  });

  it('refuses a starter who is not the captain, and lets staff do it', () => {
    const { f, entries } = made();
    const e = entries[0]!;
    const starter = N.placesOf(f.db, e.id).map((p) => p.steamid).find((s) => s !== capOf(e))!;
    expect(err(ID(f, e.id, { steamid: starter, name: 'Hijack' }))).toBe('not_captain');
    expect(err(ID(f, e.id, { steamid: capOf(entries[1]!), name: 'Hijack' }))).toBe('not_captain');
    expect(N.getEntry(f.db, e.id)!.name).not.toBe('Hijack');
    expect(ID(f, e.id, { steamid: ADMIN, staff: true, name: 'Staff Pick', tag: 'STF' }).ok).toBe(true);
    expect(N.getEntry(f.db, e.id)).toMatchObject({ name: 'Staff Pick', tag: 'STF' });
  });

  it('refuses a name another entry holds, by the normalized key, but not the entry own name', () => {
    const { f, entries } = made();
    const [a, b] = [entries[0]!, entries[1]!];
    expect(err(ID(f, a.id, { steamid: capOf(a), name: b.name.toUpperCase() }))).toBe('name_taken');
    expect(err(ID(f, a.id, { steamid: capOf(a), name: 'ＮＩＧＨＴ' }))).toBeNull();
    expect(err(ID(f, b.id, { steamid: capOf(b), name: 'night' }))).toBe('name_taken');
    // Own name, and a tag change that repeats the name, are not a clash.
    expect(err(ID(f, a.id, { steamid: capOf(a), name: a.name.toLowerCase().replace(/^./, 'x') }))).toBeNull();
    const cur = N.getEntry(f.db, a.id)!;
    expect(err(ID(f, a.id, { steamid: capOf(a), name: cur.name, tag: 'ABC' }))).toBeNull();
    expect(N.getEntry(f.db, a.id)!.tag).toBe('ABC');
  });

  it('refuses a slur, a bad length and a bad tag, writing nothing', () => {
    const { f, entries } = made();
    const e = entries[0]!;
    const before = JSON.stringify(N.getEntry(f.db, e.id));
    expect(err(ID(f, e.id, { steamid: capOf(e), name: 'ab' }))).toBe('bad_entry_name');
    expect(err(ID(f, e.id, { steamid: capOf(e), name: 'x'.repeat(25) }))).toBe('bad_entry_name');
    expect(err(ID(f, e.id, { steamid: capOf(e), name: 'nigger' }))).toBe('name_not_allowed');
    expect(err(ID(f, e.id, { steamid: capOf(e), tag: 'a' }))).toBe('bad_tag');
    expect(err(ID(f, e.id, { steamid: capOf(e), tag: 'toolong' }))).toBe('bad_tag');
    expect(err(ID(f, e.id, { steamid: capOf(e) }))).toBe('bad_request');
    expect(JSON.stringify(N.getEntry(f.db, e.id))).toBe(before);
  });

  it('is identity_locked once the event is live, finished or cancelled', () => {
    for (const status of ['live', 'finished', 'cancelled']) {
      const { f, entries } = made();
      const e = entries[0]!;
      f.db.prepare('UPDATE events SET status = ? WHERE id = ?').run(status, f.eventId);
      expect(err(ID(f, e.id, { steamid: capOf(e), name: 'Too Late' })), status).toBe('identity_locked');
      expect(err(ID(f, e.id, { steamid: ADMIN, staff: true, name: 'Too Late' })), status).toBe('identity_locked');
      expect(N.identityRefusal(E.getEvent(f.db, f.eventId)!, N.getEntry(f.db, e.id)!, capOf(e), false), status).toBe('identity_locked');
      expect(N.getEntry(f.db, e.id)!.name).toBe(e.name);
    }
  });

  it('refuses a team entry with not_draft_entry', () => {
    const { f, entries } = made();
    const e = entries[0]!;
    f.db.prepare('UPDATE event_entries SET captain_steamid = NULL WHERE id = ?').run(e.id);
    expect(err(ID(f, e.id, { steamid: ADMIN, staff: true, name: 'Anything' }))).toBe('not_draft_entry');
    f.db.prepare("UPDATE events SET entry_kind = 'team' WHERE id = ?").run(f.eventId);
    expect(err(ID(f, entries[1]!.id, { steamid: capOf(entries[1]!), name: 'Anything' }))).toBe('not_draft_entry');
  });
});

describe('identity over HTTP', () => {
  let f: DraftFixture; let entries: N.EntryRow[]; let app: FastifyInstance; let communityDir: string;
  const cookies: Record<string, Record<string, string>> = {};
  beforeEach(async () => {
    ({ f, entries } = made());
    communityDir = mkdtempSync(join(tmpdir(), 'identity-'));
    mkdirSync(join(communityDir, 'logos'), { recursive: true });
    app = await buildServer({
      config: { ...loadConfig({}), communityDir }, db: f.db, orchestrator: stubOrchestrator(), serverCleaner: async () => {}, serverExec: async () => {},
    });
    for (const s of [...P, ADMIN]) cookies[s] = authedCookie(app, f.db, s);
    f.db.prepare('UPDATE players SET is_admin = 1 WHERE steamid = ?').run(ADMIN);
  });
  afterEach(async () => { await app.close(); });
  const post = (url: string, as: string, body: object) => app.inject({ method: 'POST', url, cookies: cookies[as], payload: body });
  const get = (url: string, as?: string) => app.inject({ method: 'GET', url, cookies: as ? cookies[as] : undefined });
  const png256 = () => png(256, 256).toString('base64');

  it('lets the captain set name, tag and logo, shows it on the public page and in mine', async () => {
    const e = entries[0]!;
    const base = `/api/events/${f.slug}/entries/${e.id}`;
    expect((await post(`${base}/identity`, capOf(e), { name: 'Night Owls', tag: 'OWL' })).statusCode).toBe(200);
    const up = await post(`${base}/logo`, capOf(e), { png: png256() });
    expect(up.statusCode).toBe(200);
    const { logoKey } = up.json();
    const pub = (await get(`/api/events/${f.slug}`)).json();
    expect(pub.entries.find((x: { id: number }) => x.id === e.id)).toMatchObject({ name: 'Night Owls', tag: 'OWL', logoKey });
    const img = await get(`/api/events/logos/${logoKey}.png`);
    expect(img.statusCode).toBe(200);
    const mine = (await get(`/api/events/${f.slug}/mine`, capOf(e))).json();
    expect(mine.captainOf).toEqual({ entryId: e.id, name: 'Night Owls', tag: 'OWL', logoKey, editable: true });
    const other = N.placesOf(f.db, e.id).find((p) => p.steamid !== capOf(e))!.steamid;
    expect((await get(`/api/events/${f.slug}/mine`, other)).json().captainOf).toBeNull();
  });

  it('refuses a non-captain starter, a bad logo, and everyone once live', async () => {
    const e = entries[0]!;
    const base = `/api/events/${f.slug}/entries/${e.id}`;
    const other = N.placesOf(f.db, e.id).find((p) => p.steamid !== capOf(e))!.steamid;
    expect((await post(`${base}/identity`, other, { name: 'Nope' })).statusCode).toBe(403);
    expect((await post(`${base}/logo`, other, { png: png256() })).statusCode).toBe(403);
    expect((await post(`${base}/logo`, capOf(e), { png: png(100, 100).toString('base64') })).statusCode).toBe(400);
    expect((await post(`${base}/identity`, capOf(e), { name: entries[1]!.name })).statusCode).toBe(409);
    f.db.prepare("UPDATE events SET status = 'live' WHERE id = ?").run(f.eventId);
    const late = await post(`${base}/identity`, capOf(e), { name: 'Late Name' });
    expect([late.statusCode, late.json().error]).toEqual([409, 'Team names and logos are final once the event is live.']);
    const lateLogo = await post(`${base}/logo`, capOf(e), { png: png256() });
    expect([lateLogo.statusCode, lateLogo.json().error]).toEqual([409, 'Team names and logos are final once the event is live.']);
    expect(N.getEntry(f.db, e.id)!.logo_key).toBeNull();
  });

  it('refuses a mod who is not the captain on the player routes, and a dropped entry before any file is stored', async () => {
    const e = entries[0]!;
    const mod = P[0]!;
    f.db.prepare('UPDATE players SET is_mod = 1 WHERE steamid = ?').run(mod);
    expect(N.placesOf(f.db, e.id).some((p) => p.steamid === mod)).toBe(false);
    const base = `/api/events/${f.slug}/entries/${e.id}`;
    const a = await post(`${base}/identity`, mod, { name: 'Mod Edit' });
    expect(a.statusCode).toBe(403);
    expect((await post(`${base}/logo`, mod, { png: png256() })).statusCode).toBe(403);
    expect(N.getEntry(f.db, e.id)!.name).toBe(e.name);
    f.db.prepare("UPDATE event_entries SET status = 'dropped' WHERE id = ?").run(e.id);
    const shelf = () => readdirSync(join(communityDir, 'logos')).length;
    const before = shelf();
    expect((await post(`${base}/logo`, capOf(e), { png: png256() })).statusCode).toBe(409);
    expect(shelf()).toBe(before);
  });

  it('gives staff the same from the desk, audited, and refuses it to a non-admin', async () => {
    const e = entries[1]!;
    const base = `/api/admin/events/${f.eventId}/entries/${e.id}`;
    expect((await post(`${base}/identity`, capOf(e), { name: 'Sneaky' })).statusCode).toBeGreaterThanOrEqual(401);
    expect((await post(`${base}/identity`, ADMIN, { name: 'Desk Name', tag: 'DSK' })).statusCode).toBe(200);
    const up = await post(`${base}/logo`, ADMIN, { png: png256() });
    expect(up.statusCode).toBe(200);
    expect(N.getEntry(f.db, e.id)).toMatchObject({ name: 'Desk Name', tag: 'DSK', logo_key: up.json().logoKey });
    expect(JSON.parse((f.db.prepare("SELECT detail FROM admin_actions WHERE action = 'event_entry_identity'").get() as { detail: string }).detail)).toMatchObject({ name: 'Desk Name', tag: 'DSK' });
    expect(f.db.prepare("SELECT COUNT(*) AS n FROM admin_actions WHERE action IN ('event_entry_identity','event_entry_logo')").get()).toEqual({ n: 2 });
    expect((await post(`${base}/identity`, ADMIN, { name: entries[0]!.name })).statusCode).toBe(409);
  });
});
