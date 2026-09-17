/**
 * The queue-pop chime, synthesized so there is no audio file to ship or cache.
 *
 * Browsers only let a page make sound after the viewer has interacted with it.
 * Joining the queue is a click, so the tab that joined can always play this;
 * a tab reloaded while queued and never clicked since may stay silent, and the
 * red border and tab title are still there for that case.
 */
let ctx: AudioContext | null = null;

export function playPopSound(): void {
  try {
    ctx ??= new AudioContext();
    if (ctx.state === 'suspended') void ctx.resume();
    const t0 = ctx.currentTime;
    // Three rising notes, loud enough to hear over a game in another window.
    [660, 880, 1320].forEach((freq, i) => {
      const osc = ctx!.createOscillator();
      const gain = ctx!.createGain();
      osc.type = 'triangle';
      osc.frequency.value = freq;
      const start = t0 + i * 0.16;
      gain.gain.setValueAtTime(0.0001, start);
      gain.gain.exponentialRampToValueAtTime(0.5, start + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.35);
      osc.connect(gain).connect(ctx!.destination);
      osc.start(start);
      osc.stop(start + 0.4);
    });
  } catch {
    // No Web Audio (or blocked): the visual alerts still fire.
  }
}
