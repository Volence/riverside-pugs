import { describe, it, expect, afterEach } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/preact';
import { confirm, ConfirmHost } from './Confirm';

afterEach(cleanup);

/** Wait until the dialog is not just rendered but OPEN: its effect runs after
 *  paint, and that effect is what moves focus, locks the page and binds the
 *  key handler. Asserting between the two is a test bug, not a product one. */
const dialog = async () => {
  const d = await waitFor(() => screen.getByRole('alertdialog'));
  await waitFor(() => expect(document.body.style.overflow).toBe('hidden'));
  return d;
};
const press = (name: string | RegExp) => fireEvent.click(screen.getByRole('button', { name }));

describe('confirm', () => {
  it('resolves true only when the affirmative button is pressed', async () => {
    render(<ConfirmHost />);
    const answer = confirm({ title: 'Void match #9?', confirmLabel: 'Void match' });
    await dialog();
    press('Void match');
    await expect(answer).resolves.toBe(true);
  });

  it('resolves false on Cancel', async () => {
    render(<ConfirmHost />);
    const answer = confirm('Abort match #9?');
    await dialog();
    press('Cancel');
    await expect(answer).resolves.toBe(false);
  });

  it('resolves false on Escape', async () => {
    render(<ConfirmHost />);
    const answer = confirm('Abort match #9?');
    await dialog();
    fireEvent.keyDown(document, { key: 'Escape' });
    await expect(answer).resolves.toBe(false);
  });

  it('resolves false when the backdrop is clicked', async () => {
    const { container } = render(<ConfirmHost />);
    const answer = confirm('Abort match #9?');
    await dialog();
    fireEvent.click(container.querySelector('.modal')!);
    await expect(answer).resolves.toBe(false);
  });

  // A click that starts on the panel and drifts onto the backdrop must not
  // close the dialog out from under the reader's hand.
  it('stays open when the click lands inside the panel', async () => {
    render(<ConfirmHost />);
    const answer = confirm('Abort match #9?');
    const d = await dialog();
    fireEvent.click(d);
    expect(screen.queryByRole('alertdialog')).toBeTruthy();
    press('Cancel');
    await expect(answer).resolves.toBe(false);
  });

  it('takes a bare string as the title, so old call sites still work', async () => {
    render(<ConfirmHost />);
    const answer = confirm('Unban griefer?');
    const d = await dialog();
    expect(d.textContent).toContain('Unban griefer?');
    press('Confirm');
    await expect(answer).resolves.toBe(true);
  });

  it('shows the body and names the buttons', async () => {
    render(<ConfirmHost />);
    const answer = confirm({
      title: 'Restart Dallas after every match?',
      body: 'It is asked to quit and its supervisor starts it again.',
      confirmLabel: 'Turn on',
      cancelLabel: 'Leave off',
    });
    const d = await dialog();
    expect(d.textContent).toContain('It is asked to quit');
    expect(d.getAttribute('aria-describedby')).toBe('modal-body');
    press('Leave off');
    await expect(answer).resolves.toBe(false);
  });

  // Focus is the half of a native dialog that is easiest to leave out and
  // most obvious to anyone on a keyboard.
  it('focuses the affirmative button, then gives focus back to the trigger', async () => {
    const trigger = document.createElement('button');
    document.body.appendChild(trigger);
    trigger.focus();
    render(<ConfirmHost />);

    const answer = confirm({ title: 'Ban griefer?', confirmLabel: 'Ban' });
    await dialog();
    expect((document.activeElement as HTMLElement).textContent).toBe('Ban');

    press('Ban');
    await answer;
    await waitFor(() => expect(document.activeElement).toBe(trigger));
    trigger.remove();
  });

  it('locks the page behind it and unlocks on close', async () => {
    render(<ConfirmHost />);
    const answer = confirm('Abort match #9?');
    await dialog();
    expect(document.body.style.overflow).toBe('hidden');
    press('Cancel');
    await answer;
    await waitFor(() => expect(document.body.style.overflow).not.toBe('hidden'));
  });

  // The WHOLE dialog carries it, not just the button: --accent and --loss are
  // both red and a few degrees apart, so recolouring one button is a
  // distinction nobody notices under their own hand.
  it('marks a destructive action so it does not look like a routine one', async () => {
    render(<ConfirmHost />);
    const answer = confirm({ title: 'Void match #9?', confirmLabel: 'Void match', danger: true });
    const d = await dialog();
    expect(screen.getByRole('button', { name: 'Void match' }).className).toContain('btn--danger');
    expect(d.className).toContain('modal__panel--danger');
    expect(d.querySelector('.modal__title')!.className).toContain('modal__title--danger');
    press('Cancel');
    await answer;
  });

  it('leaves a routine action unmarked', async () => {
    render(<ConfirmHost />);
    const answer = confirm({ title: 'Set Dallas idle?', confirmLabel: 'Set idle' });
    const d = await dialog();
    expect(d.className).not.toContain('modal__panel--danger');
    expect(screen.getByRole('button', { name: 'Set idle' }).className).not.toContain('btn--danger');
    press('Cancel');
    await answer;
  });

  // Not reachable from the app today. Left undefined it is how a second ask
  // would one day drop a resolve and hang an await forever.
  it('cancels an open question rather than stacking a second dialog', async () => {
    render(<ConfirmHost />);
    const first = confirm('First?');
    await dialog();
    const second = confirm('Second?');
    await expect(first).resolves.toBe(false);
    await waitFor(() => expect(screen.getByRole('alertdialog').textContent).toContain('Second?'));
    press('Confirm');
    await expect(second).resolves.toBe(true);
  });

  // With nothing mounted the answer must be no. This dialog is the gate in
  // front of aborting a match and banning a player.
  it('answers no when no host is mounted', async () => {
    await expect(confirm('Ban griefer?')).resolves.toBe(false);
  });
});
