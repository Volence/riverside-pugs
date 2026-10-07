import { describe, it, expect, vi, afterEach } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/preact';

const { mockEvents, logoMock } = vi.hoisted(() => ({
  mockEvents: { setIdentity: vi.fn(), setLogo: vi.fn() },
  logoMock: vi.fn(async () => 'PNGDATA'),
}));
vi.mock('../../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../api')>();
  return { ...actual, eventsApi: { ...actual.eventsApi, ...mockEvents } };
});
vi.mock('../../teamLogo', () => ({ toLogoPng: logoMock }));
const { DraftIdentityPanel } = await import('./DraftIdentityPanel');
const { ApiError } = await import('../../api');

const mine = (over = {}) => ({ entryId: 7, name: 'Team Ann', tag: '', logoKey: null, editable: true, ...over });

afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe('DraftIdentityPanel', () => {
  it('saves the name and tag', async () => {
    mockEvents.setIdentity.mockResolvedValue({});
    const onChange = vi.fn();
    render(<DraftIdentityPanel slug="cup" mine={mine()} onChange={onChange} />);
    expect(screen.getByRole('heading', { name: 'Your team' })).toBeTruthy();
    fireEvent.input(screen.getByLabelText('Team name'), { target: { value: 'The Rats' } });
    fireEvent.input(screen.getByLabelText('Tag (optional)'), { target: { value: 'RAT' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(mockEvents.setIdentity).toHaveBeenCalledWith('cup', 7, { name: 'The Rats', tag: 'RAT' }));
    await waitFor(() => expect(onChange).toHaveBeenCalled());
  });

  it('uploads a logo', async () => {
    mockEvents.setLogo.mockResolvedValue({ logoKey: 'k' });
    render(<DraftIdentityPanel slug="cup" mine={mine()} onChange={() => {}} />);
    const file = new File(['x'], 'l.png', { type: 'image/png' });
    fireEvent.change(screen.getByLabelText('Logo'), { target: { files: [file] } });
    await waitFor(() => expect(mockEvents.setLogo).toHaveBeenCalledWith('cup', 7, 'PNGDATA'));
  });

  it('shows the server sentence for a bad name', async () => {
    mockEvents.setIdentity.mockRejectedValue(new ApiError(400, 'A team name is 3 to 24 characters of plain text, with at least one letter or digit.'));
    render(<DraftIdentityPanel slug="cup" mine={mine()} onChange={() => {}} />);
    fireEvent.input(screen.getByLabelText('Team name'), { target: { value: 'x' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('A team name is 3 to 24 characters of plain text, with at least one letter or digit.')).toBeTruthy();
  });

  it('is hidden once the event is live', () => {
    const { container } = render(<DraftIdentityPanel slug="cup" mine={mine({ editable: false })} onChange={() => {}} />);
    expect(container.textContent).toBe('');
  });
});
