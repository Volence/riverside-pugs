import { describe, it, expect, afterEach, vi } from 'vitest';
import { cleanup, render, screen, waitFor, fireEvent } from '@testing-library/preact';
import CastDesk from './CastDesk';
import { sampleFeed } from '../overlay/sample';
import { defaultStudioState, SCENE_HOTKEYS } from '../../../src/cast/types';

afterEach(() => { cleanup(); history.replaceState(null, '', '/'); vi.unstubAllGlobals(); });

describe('caster desk', () => {
  it('shows both sides as HP numbers, items, flow, !health and the box score from the feed', () => {
    history.replaceState(null, '', '/cast/desk?sample');
    const { container } = render(<CastDesk />);
    const surv = [...container.querySelectorAll('.desk__surv tbody tr')].map((r) => r.querySelector('.desk__hp')?.textContent);
    // Sample: 71, 38+22 temp, 210 while down, 100.
    expect(surv).toEqual(['71', '60', '210', '100']);
    expect(container.querySelector('.desk__surv tbody tr:nth-child(2)')?.textContent).toContain('+22');
    expect(container.querySelector('.desk__surv tbody tr:nth-child(3) .desk__state')?.textContent).toBe('Down');
    const inf = [...container.querySelectorAll('.desk__inf tbody tr')].map((r) => r.querySelector('.desk__hp')?.textContent);
    expect(inf).toEqual(['250', '4,200', '-', '-']);
    expect(container.querySelector('.desk__tank')?.textContent).toContain('/ 6,000');
    expect(container.querySelector('.desk__surv')?.textContent).toContain('Kit Pills Molly');
    expect(container.querySelectorAll('.desk__boxtable tbody').length).toBe(2);
    expect(container.querySelector('.desk__maptable')?.textContent).toContain('(now)');
    const now = container.querySelector('.desk__now')!.textContent!;
    expect(now).toContain('47%');
    expect(now).toContain('1,155');
  });

  it('is the studio for a caster: number keys cut scenes and save, the match picker is there', async () => {
    const studio = defaultStudioState();
    const feed = sampleFeed(studio, Date.now());
    const saves: unknown[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      const u = String(url);
      if (u.endsWith('/api/cast/studio') && init?.method === 'PUT') {
        const body = JSON.parse(String(init.body));
        saves.push(body);
        return new Response(JSON.stringify({ studio: body, rev: 2 }), { status: 200 });
      }
      if (u.endsWith('/api/cast/studio')) {
        return new Response(JSON.stringify({ studio, rev: 1, key: 'k', matches: [], bookings: [], drafts: [], obsScenes: {} }), { status: 200 });
      }
      if (u.endsWith('/api/cast/studio/feed')) return new Response(JSON.stringify(feed), { status: 200 });
      return new Response(JSON.stringify({ matches: [] }), { status: 200 });
    }));
    history.replaceState(null, '', '/cast/desk');
    const { container } = render(<CastDesk />);
    await waitFor(() => expect(container.querySelector('.desk__controls')).not.toBeNull());
    await waitFor(() => expect(container.querySelector('.desk__surv')).not.toBeNull());
    expect(screen.getByText(/^Match:/)).toBeTruthy();
    const scene = (Object.keys(SCENE_HOTKEYS) as (keyof typeof SCENE_HOTKEYS)[]).find((s) => s !== studio.scene)!;
    fireEvent.keyDown(window, { key: SCENE_HOTKEYS[scene] });
    await waitFor(() => expect(saves.some((s) => (s as { scene: string }).scene === scene)).toBe(true));
  });
});
