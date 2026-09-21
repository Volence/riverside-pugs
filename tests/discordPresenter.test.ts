import { describe, it, expect } from 'vitest';
import {
  renderPanel, renderLobby, renderLobbyFailed, renderMatch, renderResult, renderCancelled, playerLabel,
  renderEndorsePicker, renderEndorseKinds,
} from '../src/discord/presenter.js';
import type { MessagePayload } from '../src/discord/transport.js';
import type { EndorseKind } from '../src/endorsements.js';

const URL_ = 'https://pug.test';
const text = (p: MessagePayload) => JSON.stringify(p);
const buttons = (p: MessagePayload) => p.components.flat();
const alice = { name: 'alice', discordId: '111', sr: 1200 };
const bob = { name: 'b*o_b', discordId: null, sr: null };

describe('playerLabel', () => {
  it('mentions linked players, escapes markdown in plain names, appends SR', () => {
    expect(playerLabel(alice)).toBe('<@111> (1200)');
    expect(playerLabel(bob)).toBe('b\\*o\\_b');
  });

  it('mentions alone when the discord name is the same as the steam name', () => {
    expect(playerLabel({ ...alice, discordName: 'Alice' })).toBe('<@111> (1200)');
  });

  it('adds the steam name beside the mention when the discord name reads differently', () => {
    expect(playerLabel({ ...alice, discordName: 'br1' })).toBe('<@111> (alice) (1200)');
  });

  it('eight players with long, differing names still fit an embed field (1024 chars)', () => {
    const roster = Array.from({ length: 8 }, (_, i) => ({
      name: 'x'.repeat(32), discordId: String(1000 + i), discordName: 'y'.repeat(32), sr: 1234,
    }));
    const field = roster.map((p) => playerLabel(p)).join('\n');
    expect(field.length).toBeLessThanOrEqual(1024);
  });
});

describe('renderPanel', () => {
  it('shows the count, the players and the queue buttons', () => {
    const p = renderPanel({ publicUrl: URL_, size: 8, players: [alice, bob], phase: null });
    expect(p.embeds[0].title).toContain('Queue');
    expect(text(p)).toContain('2/8');
    expect(text(p)).toContain('<@111> (1200)');
    const b = buttons(p);
    expect(b.find((x) => x.kind === 'button' && x.customId === 'q:join')).toBeTruthy();
    expect(b.find((x) => x.kind === 'button' && x.customId === 'q:leave')).toBeTruthy();
    expect(b.find((x) => x.kind === 'link' && x.url === `${URL_}/`)).toBeTruthy();
    expect(b.find((x) => x.kind === 'link' && x.url === `${URL_}/leaderboard`)).toBeTruthy();
    // Nobody is pinged by the panel.
    expect(p.mentionUserIds ?? []).toEqual([]);
  });

  it('says the queue is empty rather than listing nothing', () => {
    expect(text(renderPanel({ publicUrl: URL_, size: 8, players: [], phase: null }))).toContain('empty');
  });
});

describe('renderLobby', () => {
  const players = [{ ...alice, ready: true }, { ...bob, ready: false }];

  it('ready check: deadline, ticks, a Ready button, pings linked players', () => {
    const p = renderLobby({
      lobbyId: 'lob_1', phase: 'ready_check', deadlineMs: 1_800_000_000_000, players, options: [],
    });
    expect(text(p)).toContain('<t:1800000000:R>');
    expect(text(p)).toContain('✅');
    expect(text(p)).toContain('⬜');
    expect(buttons(p)).toContainEqual(expect.objectContaining({ customId: 'l:lob_1:ready' }));
    expect(p.content).toContain('<@111>');
    expect(p.mentionUserIds).toEqual(['111']);
  });

  it('ready check with voice required: marks who is not in voice and says so in the footer', () => {
    const p = renderLobby({
      lobbyId: 'lob_1', phase: 'ready_check', deadlineMs: 1_800_000_000_000, options: [],
      voiceRequired: true,
      players: [{ ...alice, ready: true, blocked: false }, { ...bob, ready: false, blocked: true }],
    });
    const desc = p.embeds[0].description!;
    expect(desc).toContain('✅ <@111> (1200)');
    expect(desc).toContain('⬜ 🔇 b\\*o\\_b');
    expect(p.embeds[0].footer).toMatch(/voice channel/i);
  });

  it('ready check without voice required: no markers, the old footer', () => {
    const p = renderLobby({
      lobbyId: 'lob_1', phase: 'ready_check', deadlineMs: 1_800_000_000_000, options: [], players,
    });
    expect(text(p)).not.toContain('🔇');
    expect(p.embeds[0].footer).not.toMatch(/voice/i);
  });

  it('map vote: one button per campaign with counts', () => {
    const p = renderLobby({
      lobbyId: 'lob_1', phase: 'map_vote', deadlineMs: 1_800_000_000_000, players,
      options: [{ campaign: 'dead_air', name: 'Dead Air', votes: 3 }, { campaign: 'no_mercy', name: 'No Mercy', votes: 0 }],
    });
    const b = buttons(p);
    expect(b).toContainEqual(expect.objectContaining({ customId: 'l:lob_1:vote:dead_air', label: 'Dead Air (3)' }));
    expect(b).toContainEqual(expect.objectContaining({ customId: 'l:lob_1:vote:no_mercy', label: 'No Mercy (0)' }));
    expect(b.find((x) => x.kind === 'button' && x.customId.endsWith(':ready'))).toBeUndefined();
  });
});

describe('renderLobbyFailed', () => {
  it('names who did not ready and removes the buttons', () => {
    const p = renderLobbyFailed({ ready: [alice], notReady: [bob] });
    expect(text(p)).toContain('b\\\\*o\\\\_b');
    expect(p.components).toEqual([]);
  });
});

describe('renderMatch', () => {
  const base = {
    matchId: 42, campaignName: 'Dead Air', publicUrl: URL_,
    teamA: [alice], teamB: [bob], voice: null, unlinked: ['b*o_b'],
  };

  it('live: both teams, connect and match page buttons', () => {
    const p = renderMatch({ ...base, state: 'live' });
    expect(text(p)).toContain('Dead Air');
    expect(text(p)).toContain('<@111> (1200)');
    const b = buttons(p);
    expect(b).toContainEqual(expect.objectContaining({ customId: 'm:42:connect' }));
    expect(b).toContainEqual(expect.objectContaining({ url: `${URL_}/match/42` }));
  });

  it('waiting for a server says so and has no connect button yet', () => {
    const p = renderMatch({ ...base, state: 'waiting' });
    expect(text(p).toLowerCase()).toContain('waiting for a server');
    expect(buttons(p).find((x) => x.kind === 'button' && x.customId === 'm:42:connect')).toBeUndefined();
  });

  it('shows voice channels and who could not be moved', () => {
    const p = renderMatch({ ...base, state: 'live', voice: { teamAId: 'va', teamBId: 'vb' } });
    expect(text(p)).toContain('<#va>');
    expect(text(p)).toContain('<#vb>');
    expect(text(p)).toContain('not linked');
  });

  it('eight rostered players with 32-char names on both sides still fit each embed field', () => {
    const team = (offset: number) => Array.from({ length: 4 }, (_, i) => ({
      name: 'x'.repeat(32), discordId: String(2000 + offset + i), discordName: 'y'.repeat(32), sr: 1234,
    }));
    const p = renderMatch({ ...base, state: 'live', teamA: team(0), teamB: team(4) });
    for (const f of p.embeds[0].fields ?? []) expect(f.value.length).toBeLessThanOrEqual(1024);
  });

  it('finished and aborted drop the buttons except the match page', () => {
    for (const state of ['finished', 'aborted'] as const) {
      const p = renderMatch({ ...base, state });
      expect(buttons(p).every((x) => x.kind === 'link')).toBe(true);
    }
  });
});

describe('renderResult', () => {
  it('score, winner and signed SR changes', () => {
    const p = renderResult({
      matchId: 42, campaignName: 'Dead Air', publicUrl: URL_, scoreA: 1053, scoreB: 2548, winner: 'b',
      teamA: [{ ...alice, srBefore: 1200, srAfter: 1180 }],
      teamB: [{ ...bob, srBefore: 900, srAfter: 925 }],
    });
    const t = text(p);
    expect(t).toContain('1053');
    expect(t).toContain('2548');
    expect(t).toContain('Team B wins');
    expect(t).toContain('-20');
    expect(t).toContain('+25');
    expect(buttons(p)).toContainEqual(expect.objectContaining({ url: `${URL_}/match/42` }));
  });

  it('a draw says draw', () => {
    const p = renderResult({
      matchId: 1, campaignName: 'No Mercy', publicUrl: URL_, scoreA: 5, scoreB: 5, winner: 'draw', teamA: [], teamB: [],
    });
    expect(text(p)).toContain('Draw');
  });

  it('names both the steam and discord identity when they differ, mention alone when they do not, and the escaped steam name when unlinked', () => {
    const p = renderResult({
      matchId: 1, campaignName: 'No Mercy', publicUrl: URL_, scoreA: 5, scoreB: 5, winner: 'draw',
      teamA: [
        { name: 'mira', discordId: '111', discordName: 'br1', sr: null, srBefore: 1200, srAfter: 1180 },
        { name: 'js', discordId: '222', discordName: 'JS', sr: null, srBefore: 900, srAfter: 925 },
      ],
      teamB: [{ name: 'b*o_b', discordId: null, sr: null, srBefore: 800, srAfter: 800 }],
    });
    const t = text(p);
    expect(t).toContain('<@111> (mira) 1180 (-20)');
    expect(t).toContain('<@222> 925 (+25)');
    expect(t).not.toContain('<@222> (js)');
    expect(t).toContain('b\\\\*o\\\\_b 800 (+0)');
  });
});

describe('copy rules', () => {
  it('no em dashes in anything rendered', () => {
    const all = [
      renderPanel({ publicUrl: URL_, size: 8, players: [alice], phase: 'ready_check' }),
      renderLobby({ lobbyId: 'x', phase: 'ready_check', deadlineMs: 0, players: [{ ...alice, ready: false }], options: [] }),
      renderLobbyFailed({ ready: [], notReady: [alice] }),
      renderMatch({ matchId: 1, campaignName: 'x', publicUrl: URL_, teamA: [], teamB: [], voice: null, unlinked: [], state: 'configuring' }),
      renderCancelled(),
    ];
    for (const p of all) expect(text(p)).not.toContain('—');
  });
});

describe('endorse flow payloads', () => {
  const cands = (n: number) => Array.from({ length: n }, (_, i) => ({
    steamid: `7656119800000000${i + 2}`, name: `p${i}`, given: null as EndorseKind | null,
  }));

  it('the result card carries an Endorse button beside the match page link', () => {
    const p = renderResult({
      matchId: 7, campaignName: 'No Mercy', publicUrl: 'https://pug.test',
      scoreA: 10, scoreB: 5, winner: 'a', teamA: [], teamB: [],
    });
    const row = p.components[0];
    expect(row).toHaveLength(2);
    expect(row[0]).toMatchObject({ kind: 'link', label: 'Match page' });
    expect(row[1]).toEqual({ kind: 'button', customId: 'm:7:endorse', label: 'Endorse', style: 'secondary' });
  });

  it('the picker fits seven players into two rows of at most five', () => {
    const p = renderEndorsePicker({ matchId: 7, budget: 2, remaining: 2, candidates: cands(7) });
    expect(p.components.map((r) => r.length)).toEqual([5, 2]);
    expect(p.components.flat().every((b) => b.kind === 'button' && b.customId.startsWith('e:7:p:'))).toBe(true);
    expect(p.content).toContain('2 of 2');
    expect(p.embeds).toEqual([]);
    expect(p.mentionUserIds).toEqual([]);
  });

  it('shows what was already given and locks that player', () => {
    const list = cands(7);
    list[0] = { ...list[0], given: 'caller' };
    const p = renderEndorsePicker({ matchId: 7, budget: 2, remaining: 1, candidates: list, notice: 'Endorsed p0 as Caller.' });
    const first = p.components[0][0];
    expect(first).toMatchObject({ kind: 'button', label: 'p0: Caller', disabled: true, style: 'success' });
    expect(p.components[0][1]).toMatchObject({ disabled: false });
    expect(p.content?.startsWith('Endorsed p0 as Caller.')).toBe(true);
  });

  it('locks everything once the budget is spent', () => {
    const p = renderEndorsePicker({ matchId: 7, budget: 2, remaining: 0, candidates: cands(7) });
    expect(p.components.flat().every((b) => b.kind === 'button' && b.disabled === true)).toBe(true);
    expect(p.content).toMatch(/given all/i);
  });

  it('never lets a long name break the 80 character label limit', () => {
    const p = renderEndorsePicker({
      matchId: 7, budget: 2, remaining: 2,
      candidates: [{ steamid: '76561198000000002', name: 'x'.repeat(200), given: null }],
    });
    const b = p.components[0][0];
    expect(b.kind === 'button' && b.label.length).toBe(80);
  });

  it('the kind step offers exactly the three kinds and a way back, and no negative one', () => {
    const p = renderEndorseKinds({ matchId: 7, steamid: '76561198000000002', name: 'b*ob' });
    expect(p.components).toHaveLength(1);
    expect(p.components[0].map((b) => (b.kind === 'button' ? b.customId : ''))).toEqual([
      'e:7:k:76561198000000002:caller', 'e:7:k:76561198000000002:clutch', 'e:7:k:76561198000000002:vibes', 'm:7:endorse',
    ]);
    expect(p.components[0].map((b) => b.label)).toEqual(['Caller', 'Clutch', 'Good vibes', 'Back']);
    // Names are user text and the content is markdown.
    expect(p.content).toContain('b\\*ob');
  });
});
