import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/preact';
import type { AdminRuleset, MatchRules } from '../../../api';

const { mockAdmin, mockConfirm } = vi.hoisted(() => ({
  mockAdmin: { rulesets: vi.fn(), createRuleset: vi.fn(), updateRuleset: vi.fn(), archiveRuleset: vi.fn(), unarchiveRuleset: vi.fn() },
  mockConfirm: vi.fn(),
}));
vi.mock('../../../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../api')>();
  return { ...actual, adminApi: { ...actual.adminApi, ...mockAdmin } };
});
vi.mock('../../../components/Confirm', () => ({ confirm: mockConfirm }));
const { AdminRulesets } = await import('./AdminRulesets');
const { ApiError } = await import('../../../api');

const PUG_RULES: MatchRules = {
  rated: true, pause: { limit: 3, seconds: 120, mutualUnpause: false, techPauses: 0 }, teamLock: true, playerMapControl: false,
  restartHalf: { allowed: false, lockAfterDamage: false }, noShowGraceMinutes: 10, penalties: true, bosses: 'random_published',
  sideRule: 'coin', spectate: { sideLocked: false },
};
const SCRIM_RULES: MatchRules = {
  rated: false, pause: { limit: null, seconds: null, mutualUnpause: true, techPauses: 0 }, teamLock: true, playerMapControl: true,
  restartHalf: { allowed: true, lockAfterDamage: false }, noShowGraceMinutes: 15, penalties: false, bosses: 'random_published',
  sideRule: 'non_picker_chooses', spectate: { sideLocked: false },
};
const none = { bookings: 0, events: 0 };
const ROWS: AdminRuleset[] = [
  { id: 1, name: 'PUG', template: true, basedOn: null, readOnly: true, archived: false, summary: '3 pauses of 120 s · coin toss for sides · 10 min no-show grace', rules: PUG_RULES, inUse: none },
  { id: 3, name: 'Casual Scrim', template: true, basedOn: null, readOnly: false, archived: false, summary: 'Unlimited pauses · non-picker picks sides · 15 min no-show grace', rules: SCRIM_RULES, inUse: { bookings: 2, events: 1 } },
  { id: 4, name: 'Late Night', template: false, basedOn: 'Casual Scrim', readOnly: false, archived: false, summary: 'Unlimited pauses · non-picker picks sides · 15 min no-show grace', rules: SCRIM_RULES, inUse: none },
  { id: 5, name: 'Old Rules', template: false, basedOn: 'PUG', readOnly: false, archived: true, summary: '3 pauses of 120 s · coin toss for sides · 10 min no-show grace', rules: { ...PUG_RULES, rated: false, penalties: false }, inUse: none },
];
const rowOf = (name: string) => screen.getByText(name, { selector: 'strong' }).closest('li') as HTMLElement;
const within = (el: HTMLElement) => ({
  button: (name: string) => Array.from(el.querySelectorAll('button')).find((b) => b.textContent === name) ?? null,
});

afterEach(() => cleanup());
beforeEach(() => {
  for (const f of [...Object.values(mockAdmin), mockConfirm]) f.mockReset();
  mockAdmin.rulesets.mockResolvedValue({ rulesets: ROWS });
  for (const f of [mockAdmin.createRuleset, mockAdmin.updateRuleset, mockAdmin.archiveRuleset, mockAdmin.unarchiveRuleset]) f.mockResolvedValue({ ok: true });
  mockConfirm.mockResolvedValue(true);
});

describe('AdminRulesets', () => {
  it('lists each ruleset with where it came from, its summary and what uses it, and says edits never reach running games', async () => {
    render(<AdminRulesets />);
    await screen.findByText('Late Night', { selector: 'strong' });
    expect(screen.getByText('Changes apply to new bookings and events; running and finished ones keep the rules they started with.')).toBeTruthy();
    expect(rowOf('Late Night').textContent).toContain('Copy of Casual Scrim');
    expect(rowOf('Casual Scrim').textContent).toContain('Built-in');
    expect(rowOf('Casual Scrim').textContent).toContain('In use: 2 open bookings, 1 event');
    expect(rowOf('Late Night').textContent).toContain('Not in use');
    expect(rowOf('Old Rules').textContent).toContain('Archived');
    expect(within(rowOf('Casual Scrim')).button('Edit')).toBeTruthy();
    expect(screen.getAllByText('Unlimited pauses · non-picker picks sides · 15 min no-show grace')).toHaveLength(2);
  });

  it('PUG shows read only with no Edit or Archive; built-ins have no Archive; archived copies offer Unarchive', async () => {
    render(<AdminRulesets />);
    await screen.findByText('Late Night', { selector: 'strong' });
    expect(rowOf('PUG').textContent).toContain('Read only');
    expect(within(rowOf('PUG')).button('Edit')).toBeNull();
    expect(within(rowOf('PUG')).button('Archive')).toBeNull();
    expect(within(rowOf('Casual Scrim')).button('Archive')).toBeNull();
    fireEvent.click(within(rowOf('Old Rules')).button('Unarchive')!);
    await waitFor(() => expect(mockAdmin.unarchiveRuleset).toHaveBeenCalledWith(5));
  });

  it('archives a copy after asking', async () => {
    render(<AdminRulesets />);
    await screen.findByText('Late Night', { selector: 'strong' });
    fireEvent.click(within(rowOf('Late Night')).button('Archive')!);
    await waitFor(() => expect(mockAdmin.archiveRuleset).toHaveBeenCalledWith(4));
    expect(mockConfirm).toHaveBeenCalledWith(expect.objectContaining({ title: 'Archive Late Night?' }));
  });

  it('creates a copy of the chosen ruleset under the typed name', async () => {
    render(<AdminRulesets />);
    await screen.findByText('Late Night', { selector: 'strong' });
    fireEvent.change(screen.getByLabelText('Copy from'), { target: { value: '3' } });
    fireEvent.input(screen.getByLabelText('New ruleset name'), { target: { value: 'Thursday Scrims' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create copy' }));
    await waitFor(() => expect(mockAdmin.createRuleset).toHaveBeenCalledWith(3, 'Thursday Scrims'));
  });

  it('edits a copy: blank pause fields go out as no limit, rated and penalties never go out', async () => {
    render(<AdminRulesets />);
    await screen.findByText('Late Night', { selector: 'strong' });
    fireEvent.click(within(rowOf('Late Night')).button('Edit')!);
    fireEvent.input(screen.getByLabelText('Ruleset name'), { target: { value: 'Later Night' } });
    fireEvent.input(screen.getByLabelText('Pauses per team'), { target: { value: '2' } });
    fireEvent.input(screen.getByLabelText('No-show grace'), { target: { value: '20' } });
    fireEvent.change(screen.getByLabelText('Side choice'), { target: { value: 'coin' } });
    fireEvent.click(screen.getByLabelText('Only before damage'));
    fireEvent.click(screen.getByRole('button', { name: 'Save ruleset' }));
    await waitFor(() => expect(mockAdmin.updateRuleset).toHaveBeenCalled());
    const [id, name, rules] = mockAdmin.updateRuleset.mock.calls[0];
    expect([id, name]).toEqual([4, 'Later Night']);
    expect(rules).toEqual({
      pause: { limit: 2, seconds: null, mutualUnpause: true, techPauses: 0 }, teamLock: true, playerMapControl: true,
      restartHalf: { allowed: true, lockAfterDamage: true }, noShowGraceMinutes: 20, bosses: 'random_published', sideRule: 'coin',
      spectate: { sideLocked: false },
    });
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Save ruleset' })).toBeNull());
  });

  it('the side-choice options are short enough to read at 390px', async () => {
    render(<AdminRulesets />);
    await screen.findByText('Late Night', { selector: 'strong' });
    fireEvent.click(within(rowOf('Late Night')).button('Edit')!);
    const texts = Array.from((screen.getByLabelText('Side choice') as HTMLSelectElement).options).map((o) => o.textContent);
    expect(texts).toEqual(['Higher seed picks sides', 'Non-picker picks sides', 'Coin toss']);
    for (const t of texts) expect((t ?? '').length, t ?? '').toBeLessThanOrEqual(28);
  });

  it('a built-in keeps its name, and a blank grace is caught before anything is sent', async () => {
    render(<AdminRulesets />);
    await screen.findByText('Late Night', { selector: 'strong' });
    fireEvent.click(within(rowOf('Casual Scrim')).button('Edit')!);
    expect((screen.getByLabelText('Ruleset name') as HTMLInputElement).disabled).toBe(true);
    fireEvent.input(screen.getByLabelText('No-show grace'), { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save ruleset' }));
    expect(await screen.findByText('No-show grace needs a whole number.')).toBeTruthy();
    expect(mockAdmin.updateRuleset).not.toHaveBeenCalled();
  });

  it('a refusal keeps the form open and shows the reason next to Save, not off at the top of the page', async () => {
    mockAdmin.updateRuleset.mockRejectedValue(new ApiError(409, 'Another ruleset already has that name.'));
    render(<AdminRulesets />);
    await screen.findByText('Late Night', { selector: 'strong' });
    fireEvent.click(within(rowOf('Late Night')).button('Edit')!);
    fireEvent.input(screen.getByLabelText('Ruleset name'), { target: { value: 'casual scrim' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save ruleset' }));
    const message = await screen.findByText('Another ruleset already has that name.');
    expect(rowOf('Late Night').contains(message)).toBe(true);
    expect(screen.getByRole('button', { name: 'Save ruleset' }).parentElement?.contains(message)).toBe(true);
    expect(screen.getByRole('button', { name: 'Save ruleset' })).toBeTruthy();
  });

  it('a Create copy refusal while an editor is open shows by the create form, not in the editor', async () => {
    mockAdmin.createRuleset.mockRejectedValue(new ApiError(409, 'Another ruleset already has that name.'));
    render(<AdminRulesets />);
    await screen.findByText('Late Night', { selector: 'strong' });
    fireEvent.click(within(rowOf('Late Night')).button('Edit')!);
    fireEvent.input(screen.getByLabelText('New ruleset name'), { target: { value: 'Casual Scrim' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create copy' }));
    const message = await screen.findByText('Another ruleset already has that name.');
    expect(screen.getByRole('button', { name: 'Create copy' }).parentElement?.contains(message)).toBe(true);
    expect(rowOf('Late Night').contains(message)).toBe(false);
    // The open editor's own Save is unaffected by the create form's refusal.
    expect(screen.getByRole('button', { name: 'Save ruleset' })).toBeTruthy();
  });

  it('an Archive refusal for one row shows at the top, scrolled into view, not inside another row\'s open editor', async () => {
    const scrolled = vi.spyOn(HTMLElement.prototype, 'scrollIntoView').mockImplementation(() => {});
    mockAdmin.archiveRuleset.mockRejectedValueOnce(new ApiError(409, 'That ruleset is a built-in.'));
    render(<AdminRulesets />);
    await screen.findByText('Late Night', { selector: 'strong' });
    fireEvent.click(within(rowOf('Casual Scrim')).button('Edit')!);
    fireEvent.click(within(rowOf('Late Night')).button('Archive')!);
    const message = await screen.findByText('That ruleset is a built-in.');
    expect(rowOf('Casual Scrim').contains(message)).toBe(false);
    expect(rowOf('Late Night').contains(message)).toBe(false);
    await waitFor(() => expect(scrolled).toHaveBeenCalled());
    scrolled.mockRestore();
  });
});
