import type { ComponentChildren } from 'preact';
import { useId } from 'preact/hooks';

/** One field of an event form, laid out like a Settings desk row: the label
 *  and a muted help line on the left, the control on the right, one column
 *  on a phone. `for` ties the label to the control's id; every control keeps
 *  its own aria-label, which stays its accessible name. `wide` stacks the
 *  control under the label at every width (the description). */
export function FormRow({ label, help, for: htmlFor, wide, aside, children }: {
  label: string; help?: ComponentChildren; for?: string; wide?: boolean; aside?: ComponentChildren; children: ComponentChildren;
}) {
  return (
    <div class={`admin-setting eventform__row${wide ? ' eventform__row--wide' : ''}`}>
      <div class={aside ? 'eventform__labelrow' : undefined}>
        <div>
          <label class="admin-setting__label" for={htmlFor}>{label}</label>
          {help && <p class="muted">{help}</p>}
        </div>
        {aside}
      </div>
      <div class="admin-setting__control">{children}</div>
    </div>
  );
}

/** A yes/no setting as the Settings desk shows one: a checkbox reading On or Off. */
export function ToggleRow({ label, help, checked, onChange, ariaLabel }: {
  label: string; help?: ComponentChildren; checked: boolean; onChange: () => void; ariaLabel?: string;
}) {
  const id = useId();
  return (
    <FormRow label={label} help={help} for={id}>
      <label class="admin-toggle">
        <input id={id} type="checkbox" aria-label={ariaLabel ?? label} checked={checked} onChange={onChange} />
        {checked ? 'On' : 'Off'}
      </label>
    </FormRow>
  );
}

/** A titled group of rows. A fieldset, so the title is also the group's name. */
export function FormGroup({ title, children }: { title: string; children: ComponentChildren }) {
  return (
    <fieldset class="eventform__group">
      <legend class="eventform__head">{title}</legend>
      {children}
    </fieldset>
  );
}
