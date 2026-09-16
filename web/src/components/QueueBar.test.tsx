import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, cleanup } from '@testing-library/preact';
import { LocationProvider } from 'preact-iso';
import type { StateSnapshot } from '../api';
import { QueueBar, queueBarStatus } from './QueueBar';

afterEach(() => {
  cleanup();
  document.body.removeAttribute('data-urgent');
  document.title = 'Riverside';
});

const EMPTY: StateSnapshot = {
  queue: { count: 0, joined: false, players: [] },
  lobby: null,
  match: null,
};

function snap(over: Partial<StateSnapshot>): StateSnapshot {
  return { ...EMPTY, ...over };
}

function lobby(phase: 'ready_check' | 'map_vote', deadline: number) {
  return {
    id: 'lob_1', phase, players: [], ready: [], options: [], votes: {},
    deadline, myVote: null,
  };
}

describe('queueBarStatus', () => {
  it('says nothing when the viewer is in no queue, lobby or match', () => {
    expect(queueBarStatus(snap({}))).toBeNull();
  });

  it('says nothing when a queue is running that the viewer has not joined', () => {
    // The bar is a personal status line, not a site-wide ticker. Showing a
    // queue you are not in would make every page nag about a game you are
    // not playing.
    expect(queueBarStatus(snap({ queue: { count: 5, joined: false, players: [] } }))).toBeNull();
  });

  it('reports queue position when the viewer has joined', () => {
    const s = queueBarStatus(snap({ queue: { count: 5, joined: true, players: [] } }));
    expect(s).toMatchObject({ kind: 'queue', text: 'In queue 5/8', urgent: false });
  });

  it('treats a ready check as urgent', () => {
    // The whole reason this component exists: a ready check is on a timer and
    // missing it dissolves the lobby for everyone.
    const s = queueBarStatus(snap({ lobby: lobby('ready_check', Date.now() + 30_000) }));
    expect(s).toMatchObject({ kind: 'ready_check', urgent: true });
  });

  it('does not treat a map vote as urgent', () => {
    // Missing a vote costs you a preference, not the match.
    const s = queueBarStatus(snap({ lobby: lobby('map_vote', Date.now() + 30_000) }));
    expect(s).toMatchObject({ kind: 'map_vote', urgent: false });
  });

  it('puts a live match ahead of a lobby, matching the Play page order', () => {
    const s = queueBarStatus(snap({
      lobby: lobby('ready_check', Date.now() + 30_000),
      match: {
        id: 7, state: 'live', campaign: 'no_mercy', teamA: [], teamB: [],
        connect: { host: 'h', port: 1, password: 'p' }, waitingForServer: false,
      },
    }));
    expect(s).toMatchObject({ kind: 'match' });
  });

  it('calls out a live match the viewer has not connected to as urgent', () => {
    // A match that has gone live without you is the other way to lose a game
    // by looking at a different page.
    const s = queueBarStatus(snap({
      match: {
        id: 7, state: 'live', campaign: 'no_mercy', teamA: [], teamB: [],
        connect: { host: 'h', port: 1, password: 'p' }, waitingForServer: false,
      },
    }));
    expect(s).toMatchObject({ kind: 'match', urgent: true });
    expect(s!.text).toMatch(/live/i);
  });

  it('reports waiting for a server without urgency', () => {
    // Nothing for the player to do, and with one box it can last a whole
    // match. Nagging for that long would train people to ignore the bar.
    const s = queueBarStatus(snap({
      match: {
        id: 7, state: 'configuring', campaign: 'no_mercy', teamA: [], teamB: [],
        connect: null, waitingForServer: true,
      },
    }));
    expect(s).toMatchObject({ kind: 'match', urgent: false });
    expect(s!.text).toMatch(/waiting/i);
  });
});

function renderBar(state: StateSnapshot | null, path = '/leaderboard') {
  return render(
    <LocationProvider>
      <QueueBar state={state} path={path} />
    </LocationProvider>,
  );
}

describe('QueueBar', () => {
  it('renders nothing when there is no status', () => {
    const { container } = renderBar(EMPTY);
    expect(container.textContent).toBe('');
  });

  it('shows the status and a way back to the queue', () => {
    renderBar(snap({ queue: { count: 5, joined: true, players: [] } }));
    expect(screen.getByText('In queue 5/8')).toBeTruthy();
    expect(screen.getByRole('link').getAttribute('href')).toBe('/');
  });

  it('stays out of the way on the play page, which already shows all of this', () => {
    const { container } = renderBar(snap({ queue: { count: 5, joined: true, players: [] } }), '/');
    expect(container.textContent).toBe('');
  });

  it('flags the body as urgent during a ready check on another page', () => {
    // This is the regression the component was built for. useCountdownChrome
    // lived inside Play.tsx, so navigating away unmounted it and its cleanup
    // cleared data-urgent, defeating the red nav border on exactly the pages
    // it was written to serve.
    renderBar(snap({ lobby: lobby('ready_check', Date.now() + 5_000) }));
    expect(document.body.getAttribute('data-urgent')).toBe('true');
  });

  it('keeps flagging urgency on the play page even though it draws nothing there', () => {
    // Hidden is not unmounted: the bar still owns the body flag and the tab
    // title everywhere, so there is exactly one owner rather than two that
    // clear each other's attribute on unmount.
    const { container } = renderBar(snap({ lobby: lobby('ready_check', Date.now() + 5_000) }), '/');
    expect(container.textContent).toBe('');
    expect(document.body.getAttribute('data-urgent')).toBe('true');
  });

  it('clears the urgent flag once the lobby is gone', () => {
    const { rerender } = renderBar(snap({ lobby: lobby('ready_check', Date.now() + 5_000) }));
    expect(document.body.getAttribute('data-urgent')).toBe('true');
    rerender(
      <LocationProvider>
        <QueueBar state={EMPTY} path="/leaderboard" />
      </LocationProvider>,
    );
    expect(document.body.getAttribute('data-urgent')).toBeNull();
  });

  it('puts the countdown in the tab title so another tab shows it', () => {
    renderBar(snap({ lobby: lobby('ready_check', Date.now() + 30_000) }));
    expect(document.title).toMatch(/Ready check/);
  });

  it('survives a null state, which is what an anonymous viewer has', () => {
    const { container } = renderBar(null);
    expect(container.textContent).toBe('');
    expect(document.body.getAttribute('data-urgent')).toBeNull();
  });
});
