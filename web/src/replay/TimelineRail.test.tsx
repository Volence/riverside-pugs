import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, cleanup, fireEvent, screen } from '@testing-library/preact';
import { TimelineRail } from './TimelineRail';
import { DEFAULT_TOGGLES } from './useToggles';
import { bookmarkSeekMs, type TimelineEntry } from './timeline';

afterEach(cleanup);

const NAMES = { A: 'volence', B: 'tino', H: 'hunter', Z: 'boomer', Q: 'quiet' };
const T: TimelineEntry[] = [
  { seq: 1, tMs: 1000, kind: 'event', event: 'boom', actor: 'Z', target: 'A', value: 0 },
  { seq: 2, tMs: 2000, kind: 'chat', actor: 'A', team: 'survivor', text: 'ugh' },
  { seq: 3, tMs: 30000, kind: 'event', event: 'dp', actor: 'H', target: 'B', value: 25 },
  { seq: 4, tMs: 40000, kind: 'event', event: 'boom', actor: 'Z', target: 'A', value: 0 },
  { seq: 5, tMs: 50000, kind: 'event', event: 'skeet', actor: 'A', target: 'H', value: 0 },
];

function mount(selected: string | null, tMs: number, seek = vi.fn()) {
  const r = render(
    <TimelineRail timeline={T} tMs={tMs} toggles={DEFAULT_TOGGLES} seek={seek} names={NAMES} selected={selected} />,
  );
  return { ...r, seek };
}

describe('TimelineRail, nobody selected', () => {
  it('shows the rolling window with names resolved on every id', () => {
    const { container } = mount(null, 35000);
    const rows = [...container.querySelectorAll('.replay__entry')];
    // 30000 is inside the 20s window ending at 35000; 1000 and 2000 are not.
    expect(rows).toHaveLength(1);
    expect(rows[0].textContent).toContain('hunter');
    expect(rows[0].textContent).toContain('pounced tino for 25');
    expect(rows[0].textContent).not.toMatch(/\bB\b/);
  });
});

describe('TimelineRail, a player selected', () => {
  it('shows the whole round for that player, grouped by kind and side with counts', () => {
    const { container } = mount('A', 0);
    const heads = [...container.querySelectorAll('.rail-group__head')].map((h) => h.textContent);
    expect(heads).toEqual(['Got boomed ×2', 'Skeets ×1', 'Chat ×1']);
    expect(container.querySelector('.rail-group__head--suffered')?.textContent).toContain('Got boomed');
    expect(container.querySelector('.rail-group__head--did')?.textContent).toContain('Skeets');
  });

  it('dims what is still ahead of the playhead and seeks on click', () => {
    const { container, seek } = mount('A', 1500);
    const rows = [...container.querySelectorAll('.replay__entry')];
    const ahead = rows.filter((r) => r.classList.contains('replay__entry--ahead'));
    // Everything after 1.5s: the second boom, the skeet, the chat at 2s.
    expect(ahead).toHaveLength(3);
    fireEvent.click(rows[1]);
    expect(seek).toHaveBeenCalledWith(bookmarkSeekMs(40000));
  });

  // Q is rostered but in no event and no chat line. (B would not do: B is
  // the target of the pounce at seq 3.)
  it('says so when the player has nothing this round', () => {
    mount('Q', 0);
    expect(screen.getByText(/nothing recorded for quiet/i)).toBeTruthy();
  });
});
