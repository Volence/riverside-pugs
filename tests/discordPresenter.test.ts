import { describe, it, expect } from 'vitest';
import {
  renderPanel, renderLobby, renderLobbyFailed, renderMatch, renderResult, renderCancelled, playerLabel,
} from '../src/discord/presenter.js';
import type { MessagePayload } from '../src/discord/transport.js';

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
