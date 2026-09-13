import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, cleanup, screen, fireEvent } from '@testing-library/preact';
import { CampaignTiles } from './CampaignTiles';

afterEach(cleanup);

const ITEMS = [
  { slug: 'no_mercy', sub: '7 matches · last 1018 - 901' },
  { slug: 'death_toll', sub: '1 match · 412 - 289', active: true },
  { slug: 'crash_course', sub: 'Unplayed', muted: true },
];

describe('CampaignTiles', () => {
  it('names every campaign, known or not, and tints it', () => {
    const { container } = render(<CampaignTiles items={ITEMS} />);
    expect(screen.getByText('No Mercy')).toBeTruthy();
    expect(screen.getByText('crash_course')).toBeTruthy();
    const tiles = container.querySelectorAll('.ctile');
    expect(tiles).toHaveLength(3);
    expect((tiles[0] as HTMLElement).style.getPropertyValue('--campaign')).toMatch(/^var\(--c-no-mercy, oklch\(/);
    expect((tiles[2] as HTMLElement).style.getPropertyValue('--campaign')).toMatch(/^oklch/);
    expect(tiles[1].classList.contains('is-active')).toBe(true);
    expect(tiles[2].classList.contains('is-muted')).toBe(true);
  });

  it('is a row of buttons that report the slug when pickable', () => {
    const onPick = vi.fn();
    render(<CampaignTiles items={ITEMS} onPick={onPick} />);
    fireEvent.click(screen.getByRole('button', { name: /death toll/i }));
    expect(onPick).toHaveBeenCalledWith('death_toll');
  });

  it('renders no buttons when not pickable', () => {
    render(<CampaignTiles items={ITEMS} />);
    expect(screen.queryAllByRole('button')).toHaveLength(0);
  });
});
