import { describe, it, expect, afterEach } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/preact';
import { SidePreviews } from './SidePreviews';

afterEach(() => cleanup());

const S = '/api/community/files/previews/' + 'a'.repeat(64) + '.png';
const I = '/api/community/files/previews/' + 'b'.repeat(64) + '.png';

describe('SidePreviews', () => {
  it('shows the survivor preview alone, with no toggle, when there is no infected one', () => {
    render(<SidePreviews survivor={S} infected={null} alt="Preview of Clean" />);
    const img = screen.getByRole('img') as HTMLImageElement;
    expect(img.getAttribute('src')).toBe(S);
    expect(img.getAttribute('alt')).toBe('Preview of Clean');
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('toggles between the sides with pressed buttons, and names the side in the alt text', () => {
    render(<SidePreviews survivor={S} infected={I} alt="Preview of Clean" />);
    const group = screen.getByRole('group', { name: 'Preview side' });
    expect(group).toBeTruthy();
    const surv = screen.getByRole('button', { name: 'Survivor' });
    const inf = screen.getByRole('button', { name: 'Infected' });
    expect(surv.getAttribute('aria-pressed')).toBe('true');
    expect(inf.getAttribute('aria-pressed')).toBe('false');
    expect(screen.getByRole('img').getAttribute('src')).toBe(S);
    expect(screen.getByRole('img').getAttribute('alt')).toBe('Preview of Clean, survivor side');

    fireEvent.click(inf);
    expect(inf.getAttribute('aria-pressed')).toBe('true');
    expect(surv.getAttribute('aria-pressed')).toBe('false');
    expect(screen.getByRole('img').getAttribute('src')).toBe(I);
    expect(screen.getByRole('img').getAttribute('alt')).toBe('Preview of Clean, infected side');

    fireEvent.click(surv);
    expect(screen.getByRole('img').getAttribute('src')).toBe(S);
  });

  it('passes its classes and lazy loading to the image', () => {
    render(<SidePreviews survivor={S} infected={I} alt="x" imgClass="ccard__preview" lazy />);
    const img = screen.getByRole('img');
    expect(img.getAttribute('class')).toBe('ccard__preview');
    expect(img.getAttribute('loading')).toBe('lazy');
  });
});
