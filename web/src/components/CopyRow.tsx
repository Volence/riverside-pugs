import { useEffect, useRef, useState } from 'preact/hooks';

/** A value with its own Copy button: the password on its own (the connect
 *  line above already carries it, but people paste it into the prompt L4D1
 *  shows on a steam:// join) and the invite link. */
export function CopyRow({ label, value, hint }: { label: string; value: string; hint?: string }) {
  const [copied, setCopied] = useState(false);
  const reset = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (reset.current !== null) clearTimeout(reset.current); }, []);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      reset.current = setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard denied. The value is on screen to select by hand.
    }
  };
  return (
    <div class="practice__copy">
      <p class="eyebrow">{label}</p>
      <div class="connect__line">
        <code>{value}</code>
        <button class="btn btn--block" type="button" onClick={copy} aria-label={`Copy ${label.toLowerCase()}`}>
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
      {hint && <p class="muted practice__hint">{hint}</p>}
    </div>
  );
}
