import { describe, it, expect, beforeEach } from 'vitest';
import { openDb, type DB, DEFAULT_SETTINGS } from '../src/db.js';
import { getSetting, setSetting } from '../src/settings.js';
import { SETTINGS_SCHEMA } from '../src/settingsSchema.js';
import { upsertPlayer, activatePlayer, currentSeasonId, linkDiscord } from '../src/players.js';
import {
  recentCoPlayers, resolveByName, reportModal, opensReportModal, OTHER, ReportButton,
  handleReportButton, handleReportModal,
} from '../src/discord/reportButton.js';
import { REPORT_LABELS } from '../src/discord/commands.js';
import { FakeTransport } from './fakes/fakeTransport.js';

let db: DB;

beforeEach(() => {
  db = openDb(':memory:');
});

const IDS = Array.from({ length: 6 }, (_, i) => `7656119900000010${i}`);
const [ME, ALICE, BOB1, BOB2, CARL, DEE] = IDS;

const seedPlayers = (d: DB) => {
  const names: Record<string, string> = {
    [ME]: 'me', [ALICE]: 'Alice', [BOB1]: 'Bob', [BOB2]: 'bob',
    [CARL]: 'Carl_99', [DEE]: 'Dee%Dee',
  };
  for (const id of IDS) {
    upsertPlayer(d, { steamid: id, name: names[id], avatar: null }, []);
    activatePlayer(d, id);
  }
};

// `matches` requires season_id and campaign, both NOT NULL. A fresh database
// seeds "Season 1", so currentSeasonId always has something to return.
const seedMatch = (d: DB, matchId: number, players: string[], state = 'completed') => {
  d.prepare(
    `INSERT INTO matches (id, season_id, state, campaign, created_at)
     VALUES (?, ?, ?, 'l4d_vs_smalltown', '2026-09-22T00:00:00.000Z')`,
  ).run(matchId, currentSeasonId(d), state);
  const ins = d.prepare("INSERT INTO match_players (match_id, player_id, team) VALUES (?, ?, 'a')");
  for (const p of players) ins.run(matchId, p);
};

describe('report button schema', () => {
  it('creates the pending_reports and report_message tables', () => {
    const names = (db.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('pending_reports', 'report_message')",
    ).all() as { name: string }[]).map((r) => r.name).sort();
    expect(names).toEqual(['pending_reports', 'report_message']);
  });

  it('holds report_message to a single row', () => {
    const ins = db.prepare(
      "INSERT INTO report_message (id, channel_id, message_id, hash, updated_at) VALUES (?, 'c1', 'm1', 'h', '2026-09-22T00:00:00.000Z')",
    );
    ins.run(1);
    expect(() => ins.run(2)).toThrow();
  });

  it('defaults the report channel setting to empty', () => {
    expect(getSetting(db, 'discord_report_channel_id')).toBe('');
  });

  it('keeps a pending report only for a real player', () => {
    expect(() => db.prepare(
      "INSERT INTO pending_reports (reporter_id, category, text, typed_name, candidates, created_at) VALUES ('76561199000000099', 'griefing', '', 'bob', '[]', '2026-09-22T00:00:00.000Z')",
    ).run()).toThrow();
  });
});

describe('settings parity', () => {
  it('gives every default a schema entry and every schema entry a default', () => {
    const defaults = Object.keys(DEFAULT_SETTINGS).sort();
    const schema = SETTINGS_SCHEMA.map((s) => s.key).sort();
    expect(defaults).toEqual(schema);
  });
});

import { COMMAND_DEFS } from '../src/discord/commands.js';

describe('details wording', () => {
  const report = () => COMMAND_DEFS.find((c) => c.name === 'report')!;
  const details = () => report().options!.find((o) => o.name === 'details')!;

  it('does not lead with the map', () => {
    expect(details().description.toLowerCase()).not.toContain('map');
  });

  it('asks for what happened, in the reporter\'s own words', () => {
    expect(details().description).toBe('What happened, in your own words');
  });

  it('stays inside Discord\'s 100 character limit', () => {
    expect(details().description.length).toBeLessThanOrEqual(100);
  });

  it('exports the category labels so the form can share them', () => {
    expect(REPORT_LABELS.unsafe).toBe('Safety concern (handled privately)');
  });
});

describe('recentCoPlayers', () => {
  beforeEach(() => { seedPlayers(db); });

  it('lists people from my matches, most recent first, never me', () => {
    seedMatch(db, 1, [ME, ALICE]);
    seedMatch(db, 2, [ME, CARL]);
    expect(recentCoPlayers(db, ME).map((c) => c.name)).toEqual(['Carl_99', 'Alice']);
  });

  it('lists someone once however many matches we shared', () => {
    seedMatch(db, 1, [ME, ALICE]);
    seedMatch(db, 2, [ME, ALICE]);
    expect(recentCoPlayers(db, ME)).toHaveLength(1);
  });

  it('is empty for someone who has never played', () => {
    expect(recentCoPlayers(db, ME)).toEqual([]);
  });

  it('honours the limit', () => {
    seedMatch(db, 1, [ME, ALICE, BOB1, CARL]);
    expect(recentCoPlayers(db, ME, 2)).toHaveLength(2);
  });

  it('does not list someone from a configuring match', () => {
    seedMatch(db, 1, [ME, ALICE], 'configuring');
    expect(recentCoPlayers(db, ME)).toEqual([]);
  });

  it('lists someone from a match that fell apart, because that is when you report them', () => {
    seedMatch(db, 1, [ME, ALICE], 'aborted');
    expect(recentCoPlayers(db, ME).map((c) => c.name)).toEqual(['Alice']);
  });
});

describe('resolveByName', () => {
  beforeEach(() => { seedPlayers(db); });

  it('finds one exact name regardless of case', () => {
    expect(resolveByName(db, 'ALICE').map((c) => c.steamid)).toEqual([ALICE]);
  });

  it('prefers exact matches over substrings', () => {
    // 'Bob' and 'bob' both match exactly; 'Bobby' would only match as a
    // substring and must not dilute an exact hit.
    upsertPlayer(db, { steamid: '76561199000000199', name: 'Bobby', avatar: null }, []);
    expect(resolveByName(db, 'bob').map((c) => c.steamid).sort()).toEqual([BOB1, BOB2].sort());
  });

  it('falls back to a substring when nothing matches exactly', () => {
    expect(resolveByName(db, 'arl').map((c) => c.steamid)).toEqual([CARL]);
  });

  it('returns nothing for a name nobody has', () => {
    expect(resolveByName(db, 'nobody')).toEqual([]);
  });

  it('treats LIKE wildcards as ordinary characters', () => {
    // '%' must not match everything, and '_' must not match any character.
    expect(resolveByName(db, '%').map((c) => c.steamid)).toEqual([DEE]);
    expect(resolveByName(db, 'Carl_').map((c) => c.steamid)).toEqual([CARL]);
  });

  it('ignores surrounding whitespace', () => {
    expect(resolveByName(db, '  Alice  ').map((c) => c.steamid)).toEqual([ALICE]);
  });

  it('returns at most the limit', () => {
    expect(resolveByName(db, 'e', 2).length).toBeLessThanOrEqual(2);
  });
});

describe('reportModal', () => {
  beforeEach(() => { seedPlayers(db); });

  it('has four fields in a fixed order', () => {
    const m = reportModal(db, ME);
    expect(m.fields.map((f) => f.id)).toEqual(['who', 'name', 'reason', 'details']);
  });

  it('leads the who dropdown with the sentinel, then recent opponents', () => {
    seedMatch(db, 1, [ME, ALICE]);
    const who = reportModal(db, ME).fields[0];
    if (who.kind !== 'select') throw new Error('who must be a select');
    expect(who.options[0].value).toBe(OTHER);
    expect(who.options.slice(1).map((o) => o.value)).toEqual([ALICE]);
  });

  it('still offers the sentinel when there are no recent opponents', () => {
    const who = reportModal(db, ME).fields[0];
    if (who.kind !== 'select') throw new Error('who must be a select');
    // A select with zero options is not a valid modal, so the sentinel is
    // what keeps the form openable for someone who has never played.
    expect(who.options).toHaveLength(1);
  });

  it('never offers the reporter themselves', () => {
    seedMatch(db, 1, [ME, ALICE]);
    const who = reportModal(db, ME).fields[0];
    if (who.kind !== 'select') throw new Error('who must be a select');
    expect(who.options.map((o) => o.value)).not.toContain(ME);
  });

  it('offers every report category, with the shared labels', () => {
    const reason = reportModal(db, ME).fields[2];
    if (reason.kind !== 'select') throw new Error('reason must be a select');
    expect(reason.options.map((o) => o.value)).toEqual(['griefing', 'cheating', 'toxicity', 'afk', 'unsafe', 'other']);
    expect(reason.options.find((o) => o.value === 'unsafe')!.label).toBe('Safety concern (handled privately)');
  });

  it('keeps the name and details boxes optional and caps details at 1000', () => {
    const [, name, , details] = reportModal(db, ME).fields;
    if (name.kind !== 'text' || details.kind !== 'text') throw new Error('expected text fields');
    expect(name.required).toBe(false);
    expect(details.required).toBe(false);
    expect(details.maxLength).toBe(1000);
    expect(details.style).toBe('paragraph');
  });

  it('keeps every select option label inside Discord\'s 100 characters', () => {
    upsertPlayer(db, { steamid: '76561199000000198', name: 'x'.repeat(200), avatar: null }, []);
    activatePlayer(db, '76561199000000198');
    seedMatch(db, 1, [ME, '76561199000000198']);
    const who = reportModal(db, ME).fields[0];
    if (who.kind !== 'select') throw new Error('who must be a select');
    for (const o of who.options) expect(o.label.length).toBeLessThanOrEqual(100);
  });

  it('knows which button opens a form', () => {
    expect(opensReportModal('rp:open')).toBe(true);
    expect(opensReportModal('rp:pick:1:76561199000000101')).toBe(false);
    expect(opensReportModal('t:1:claim')).toBe(false);
  });
});

const liveIn = (d: DB, t: FakeTransport, channel: string) => {
  setSetting(d, 'discord_report_channel_id', channel);
  return new ReportButton({ db: d, transport: t as never, intervalMs: 0 });
};
const standing = (t: FakeTransport) => t.messages.filter((m) => !m.deleted);
const stored = (d: DB) => d.prepare('SELECT channel_id, message_id FROM report_message WHERE id = 1')
  .get() as { channel_id: string; message_id: string } | undefined;

describe('the standing message', () => {
  let t: FakeTransport;
  beforeEach(() => { seedPlayers(db); t = new FakeTransport(); });

  it('posts one message with one button', async () => {
    await liveIn(db, t, 'c1').tick();
    expect(standing(t)).toHaveLength(1);
    expect(standing(t)[0].payload.components[0][0]).toMatchObject({ kind: 'button', customId: 'rp:open' });
    expect(stored(db)).toMatchObject({ channel_id: 'c1' });
  });

  it('does not post a second one on the next tick', async () => {
    const rb = liveIn(db, t, 'c1');
    await rb.tick();
    await rb.tick();
    expect(standing(t)).toHaveLength(1);
  });

  it('posts nothing when the setting is blank', async () => {
    const rb = new ReportButton({ db, transport: t as never, intervalMs: 0 });
    await rb.tick();
    expect(standing(t)).toHaveLength(0);
    expect(stored(db)).toBeUndefined();
  });

  it('re-posts a message someone deleted', async () => {
    const rb = liveIn(db, t, 'c1');
    await rb.tick();
    const first = stored(db)!.message_id;
    t.messages.find((m) => m.id === first)!.deleted = true;
    await rb.tick();
    expect(stored(db)!.message_id).not.toBe(first);
    expect(standing(t)).toHaveLength(1);
  });

  it('moves to a new channel when the setting changes, and takes the old one down', async () => {
    const rb = liveIn(db, t, 'c1');
    await rb.tick();
    const old = stored(db)!.message_id;
    setSetting(db, 'discord_report_channel_id', 'c2');
    await rb.tick();
    expect(stored(db)).toMatchObject({ channel_id: 'c2' });
    expect(t.messages.find((m) => m.id === old)!.deleted).toBe(true);
    expect(standing(t)).toHaveLength(1);
  });

  it('still moves channel when the old message cannot be removed', async () => {
    const rb = liveIn(db, t, 'c1');
    await rb.tick();
    setSetting(db, 'discord_report_channel_id', 'c2');
    t.messages.length = 0; // the old message is gone from Discord's side
    await rb.tick();
    expect(stored(db)).toMatchObject({ channel_id: 'c2' });
  });

  it('edits a stale message in place, without re-sending, when the copy changed but the channel did not', async () => {
    const rb = liveIn(db, t, 'c1');
    await rb.tick();
    const first = stored(db)!.message_id;
    // Stand in for the button's copy changing between deploys: the row on
    // disk is now stale relative to whatever standingPayload() builds today.
    db.prepare("UPDATE report_message SET hash = 'stale' WHERE id = 1").run();
    await rb.tick();
    expect(stored(db)!.message_id).toBe(first);
    expect(standing(t)).toHaveLength(1);

    const hash = (db.prepare('SELECT hash FROM report_message WHERE id = 1').get() as { hash: string }).hash;
    expect(hash).not.toBe('stale');
    // Prove it is not just SOME new value, but the actual hash a fresh tick
    // would compute: run one on a brand new database and channel, with no
    // stale row to react to, and it must land on the same value.
    const freshDb = openDb(':memory:');
    seedPlayers(freshDb);
    await liveIn(freshDb, new FakeTransport(), 'somewhere-else').tick();
    const freshHash = (freshDb.prepare('SELECT hash FROM report_message WHERE id = 1').get() as { hash: string }).hash;
    expect(hash).toBe(freshHash);
  });

  it('never treats a failed edit on a stale message as success, so it sends fresh instead', async () => {
    const rb = liveIn(db, t, 'c1');
    await rb.tick();
    const first = stored(db)!.message_id;
    db.prepare("UPDATE report_message SET hash = 'stale' WHERE id = 1").run();
    // Discord has lost the message (not merely "Discord is down" for this
    // one call): the edit call finds nothing and reports false, which is the
    // exact case a false return exists to catch.
    t.messages.find((m) => m.id === first)!.deleted = true;
    await rb.tick();
    expect(stored(db)!.message_id).not.toBe(first);
    expect(standing(t)).toHaveLength(1);
  });
});

describe('reaping drafts', () => {
  it('deletes a draft older than an hour and keeps a fresh one', async () => {
    seedPlayers(db);
    const t = new FakeTransport();
    const ins = db.prepare(
      'INSERT INTO pending_reports (reporter_id, category, text, typed_name, candidates, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    );
    ins.run(ME, 'griefing', '', 'bob', '[]', '2026-09-22T09:00:00.000Z');
    ins.run(ME, 'griefing', '', 'bob', '[]', '2026-09-22T11:59:00.000Z');
    const rb = new ReportButton({
      db, transport: t as never, intervalMs: 0, now: () => new Date('2026-09-22T12:00:00.000Z'),
    });
    await rb.tick();
    expect((db.prepare('SELECT COUNT(*) AS n FROM pending_reports').get() as { n: number }).n).toBe(1);
  });
});

const D = (steamid: string) => `90${IDS.indexOf(steamid)}`;
const hDeps = () => ({ db, adminSteamIds: [] as string[] });
const open = (steamid: string) => handleReportButton(hDeps(), {
  kind: 'button', customId: 'rp:open', userId: D(steamid), userName: 'x',
});
const submit = (steamid: string, fields: Record<string, string>) => handleReportModal(hDeps(), {
  kind: 'modal', customId: 'rp:new', userId: D(steamid), userName: 'x', fields,
});
const said = (r: { payload: { content?: string } }) => r.payload.content ?? '';
const reports = () => db.prepare('SELECT r.category, r.text, t.target_id FROM ticket_reports r JOIN tickets t ON t.id = r.ticket_id').all();

const linkAll = (d: DB) => { for (const id of IDS) linkDiscord(d, id, D(id), `d${id}`); };

describe('opening the form', () => {
  beforeEach(() => { seedPlayers(db); linkAll(db); });

  it('answers with the form', async () => {
    const r = await open(ME);
    expect(r.ephemeral).toBe(true);
    expect(r.modal?.customId).toBe('rp:new');
  });

  it('tells an unlinked presser to link first, and opens no form', async () => {
    const r = await handleReportButton(hDeps(), {
      kind: 'button', customId: 'rp:open', userId: 'nobody', userName: 'x',
    });
    expect(r.modal).toBeUndefined();
    expect(said(r)).toContain('/link');
  });
});

describe('submitting the form', () => {
  beforeEach(() => { seedPlayers(db); linkAll(db); });

  it('files against the dropdown pick', async () => {
    const r = await submit(ME, { who: ALICE, name: '', reason: 'griefing', details: 'threw the round' });
    expect(said(r)).toContain('Thanks');
    expect(reports()).toEqual([{ category: 'griefing', text: 'threw the round', target_id: ALICE }]);
  });

  it('files against a uniquely typed name', async () => {
    const r = await submit(ME, { who: OTHER, name: 'Alice', reason: 'toxicity', details: '' });
    expect(said(r)).toContain('Thanks');
    expect(reports()).toHaveLength(1);
  });

  it('asks for someone when neither field is filled', async () => {
    const r = await submit(ME, { who: OTHER, name: '   ', reason: 'griefing', details: '' });
    expect(said(r)).toContain('Pick someone from the list');
    expect(reports()).toHaveLength(0);
  });

  it('says so when nobody has that name', async () => {
    const r = await submit(ME, { who: OTHER, name: 'ghost', reason: 'griefing', details: '' });
    expect(said(r)).toContain('No player here by that name');
    expect(reports()).toHaveLength(0);
  });

  it('refuses a self report', async () => {
    const r = await submit(ME, { who: OTHER, name: 'me', reason: 'griefing', details: '' });
    expect(said(r).toLowerCase()).toContain('yourself');
    expect(reports()).toHaveLength(0);
  });

  it('surfaces a refusal from fileReport, such as a safety report with no words', async () => {
    const r = await submit(ME, { who: ALICE, name: '', reason: 'unsafe', details: '' });
    expect(said(r)).toContain('say what happened');
    expect(reports()).toHaveLength(0);
  });

  it('rejects a reason that is not a category', async () => {
    const r = await submit(ME, { who: ALICE, name: '', reason: 'nonsense', details: '' });
    expect(reports()).toHaveLength(0);
    expect(said(r)).toContain('pick a category');
  });

  it('offers the choices when a name is shared, and files nothing yet', async () => {
    const r = await submit(ME, { who: OTHER, name: 'bob', reason: 'cheating', details: 'walls' });
    expect(reports()).toHaveLength(0);
    expect(r.payload.components[0].map((b) => (b as { customId: string }).customId))
      .toEqual([`rp:pick:1:${BOB1}`, `rp:pick:1:${BOB2}`]);
    const held = db.prepare('SELECT reporter_id, category, text FROM pending_reports').all();
    expect(held).toEqual([{ reporter_id: ME, category: 'cheating', text: 'walls' }]);
  });

  it('asks for a more specific name when too many share it', async () => {
    for (let n = 0; n < 6; n++) {
      const id = `7656119900000030${n}`;
      upsertPlayer(db, { steamid: id, name: `same${n}`, avatar: null }, []);
      activatePlayer(db, id);
    }
    const r = await submit(ME, { who: OTHER, name: 'same', reason: 'griefing', details: '' });
    expect(said(r)).toContain('Type more of it');
    expect(db.prepare('SELECT COUNT(*) AS n FROM pending_reports').get()).toEqual({ n: 0 });
  });
});

const pick = (steamid: string, customId: string) => handleReportButton(hDeps(), {
  kind: 'button', customId, userId: D(steamid), userName: 'x',
});

describe('choosing between same-named players', () => {
  beforeEach(async () => {
    seedPlayers(db); linkAll(db);
    await submit(ME, { who: OTHER, name: 'bob', reason: 'cheating', details: 'walls' });
  });

  it('files against the one chosen, with the words kept', async () => {
    const r = await pick(ME, `rp:pick:1:${BOB2}`);
    expect(said(r)).toContain('Thanks');
    expect(reports()).toEqual([{ category: 'cheating', text: 'walls', target_id: BOB2 }]);
  });

  it('clears the draft once it is filed', async () => {
    await pick(ME, `rp:pick:1:${BOB2}`);
    expect(db.prepare('SELECT COUNT(*) AS n FROM pending_reports').get()).toEqual({ n: 0 });
  });

  it('cannot be pressed twice', async () => {
    await pick(ME, `rp:pick:1:${BOB2}`);
    const again = await pick(ME, `rp:pick:1:${BOB2}`);
    expect(said(again)).toContain('expired');
    expect(reports()).toHaveLength(1);
  });

  it('refuses someone else pressing it, and files nothing', async () => {
    const r = await pick(ALICE, `rp:pick:1:${BOB2}`);
    expect(said(r)).toContain('not yours');
    expect(reports()).toHaveLength(0);
    expect(db.prepare('SELECT COUNT(*) AS n FROM pending_reports').get()).toEqual({ n: 1 });
  });

  it('refuses a steamid that was never offered', async () => {
    const r = await pick(ME, `rp:pick:1:${CARL}`);
    expect(said(r)).toContain('not one of the choices');
    expect(reports()).toHaveLength(0);
  });

  it('says a reaped draft expired', async () => {
    db.prepare('DELETE FROM pending_reports').run();
    const r = await pick(ME, `rp:pick:1:${BOB2}`);
    expect(said(r)).toContain('expired');
  });
});
