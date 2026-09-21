import { useEffect, useRef, useState } from 'preact/hooks';

/**
 * The app's confirm dialog, in the site's own clothes.
 *
 * `window.confirm` put a browser chrome box titled 'JavaScript from
 * "https://riversidepug.com"' over the page, and ran the whole prompt together
 * as one paragraph, so "Restart Dallas after every match?" and the three
 * sentences explaining what that costs arrived as an undifferentiated wall
 * (owner, 2026-09-21). This is the same question with a heading, a body and
 * named buttons.
 *
 * Promise-based and driven from a module-level store rather than context, so
 * calling it needs no provider, no props threaded down and no hook: any code
 * anywhere does `if (!await confirm(...)) return;`. That is the same shape as
 * the backend's adminFeed bus and it is what keeps the one call site in
 * useAction a one-line change.
 *
 * What a native dialog gives away for free, and what this therefore has to
 * earn back or be a downgrade: Escape and Enter, focus moved in on open and
 * put back on the trigger on close, Tab trapped while open, a backdrop that
 * cancels, the alertdialog role, and the page behind it not scrolling.
 */

export interface ConfirmOptions {
  /** The question. Kept short: it is the heading. */
  title: string;
  /** What the reader needs before answering. Optional. */
  body?: string;
  /** The affirmative button. Defaults to "Confirm"; a verb beats "OK". */
  confirmLabel?: string;
  cancelLabel?: string;
  /** Red confirm button, for something destructive or hard to undo. */
  danger?: boolean;
}

interface Pending extends ConfirmOptions {
  resolve(ok: boolean): void;
}

type Listener = (p: Pending | null) => void;

let listener: Listener | null = null;
let queued: Pending | null = null;

/**
 * Ask, and resolve true only if they said yes.
 *
 * A bare string is accepted so every existing call site keeps working
 * unchanged; it becomes the title.
 *
 * With no host mounted this resolves FALSE rather than hanging or silently
 * proceeding. The dialog is the gate in front of aborting a match and banning
 * a player, and "nobody can see the question" must not mean "the answer was
 * yes".
 */
export function confirm(opts: ConfirmOptions | string): Promise<boolean> {
  const o: ConfirmOptions = typeof opts === 'string' ? { title: opts } : opts;
  if (!listener) return Promise.resolve(false);
  // A second ask while one is open answers the first with a cancel rather than
  // stacking dialogs or dropping the new one. Nothing in the app does this
  // today; leaving it undefined is how it would one day lose a resolve and
  // hang an await forever.
  queued?.resolve(false);
  return new Promise<boolean>((resolve) => {
    queued = { ...o, resolve };
    listener?.(queued);
  });
}

/** Mounted once, in App. Renders nothing until something asks. */
export function ConfirmHost() {
  const [pending, setPending] = useState<Pending | null>(null);
  const panel = useRef<HTMLDivElement | null>(null);
  const confirmBtn = useRef<HTMLButtonElement | null>(null);
  /** What had focus when the dialog opened, to give it back on close. */
  const opener = useRef<Element | null>(null);

  useEffect(() => {
    listener = setPending;
    return () => { listener = null; };
  }, []);

  const settle = (ok: boolean) => {
    const p = queued;
    queued = null;
    setPending(null);
    p?.resolve(ok);
  };

  useEffect(() => {
    if (!pending) return undefined;
    opener.current = document.activeElement;
    // The affirmative button, not the panel: Enter then works without a second
    // keystroke, which is the one thing people are used to from the native box.
    confirmBtn.current?.focus();
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        settle(false);
        return;
      }
      if (e.key !== 'Tab' || !panel.current) return;
      // Trap: without this, Tab walks out into the page behind and the next
      // Enter presses whatever it landed on.
      const focusable = panel.current.querySelectorAll<HTMLElement>('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])');
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };

    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('keydown', onKey, true);
      document.body.style.overflow = prevOverflow;
      // Back to the button they clicked, so a keyboard user is not dropped at
      // the top of the document.
      if (opener.current instanceof HTMLElement) opener.current.focus();
    };
  }, [pending]);

  if (!pending) return null;

  return (
    <div
      class="modal"
      // Cancels only when the backdrop ITSELF is the target. Without the
      // check, a click that starts on the panel and drifts onto the backdrop
      // closes the dialog under the reader's hand.
      onClick={(e) => { if (e.target === e.currentTarget) settle(false); }}
    >
      <div
        class={`modal__panel ${pending.danger ? 'modal__panel--danger' : ''}`}
        ref={panel}
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="modal-title"
        aria-describedby={pending.body ? 'modal-body' : undefined}
      >
        <h2 class={`modal__title ${pending.danger ? 'modal__title--danger' : ''}`} id="modal-title">{pending.title}</h2>
        {pending.body && <p class="modal__body" id="modal-body">{pending.body}</p>}
        <div class="modal__actions">
          <button
            class="btn--ghost"
            type="button"
            onClick={() => settle(false)}
          >
            {pending.cancelLabel ?? 'Cancel'}
          </button>
          <button
            class={`btn ${pending.danger ? 'btn--danger' : ''}`}
            type="button"
            ref={confirmBtn}
            onClick={() => settle(true)}
          >
            {pending.confirmLabel ?? 'Confirm'}
          </button>
        </div>
      </div>
    </div>
  );
}
