import { describe, it, expect, afterEach } from 'vitest';
import { render, cleanup } from '@testing-library/preact';
import { ReplayTooltip } from './ReplayTooltip';

afterEach(cleanup);

describe('ReplayTooltip', () => {
  it('renders nothing for a null text', () => {
    const { container } = render(<ReplayTooltip text={null} x={10} y={10} stageW={800} stageH={500} />);
    expect(container.innerHTML).toBe('');
  });

  it('renders the text with role="tooltip"', () => {
    const { getByRole } = render(<ReplayTooltip text="hank pounced alice" x={10} y={10} stageW={800} stageH={500} />);
    expect(getByRole('tooltip').textContent).toBe('hank pounced alice');
  });

  it('flips left when x is close to the right edge of the stage', () => {
    const { getByRole } = render(<ReplayTooltip text="tip" x={750} y={200} stageW={800} stageH={500} />);
    const el = getByRole('tooltip') as HTMLElement;
    expect(el.style.transform).toContain('-100%');
  });
});
