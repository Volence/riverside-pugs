/**
 * The rank-up and placement animations (owner-approved mockup, 2026-10-20),
 * played into a stage element by RankMoment. Plain DOM and the Web
 * Animations API: the stage is built here and owned by this code, so Preact
 * never sees the shards and sparks it adds and removes.
 *
 * Division up: the SR counts to the line while the bar fills and the old
 * emblem strains, then it shatters with a flash and a shockwave and the new
 * one slams in with rays and sparks. Tier up is the same, bigger: longer
 * charge, the room's colour shifts, two rings, more sparks, "Promoted".
 * Placement: the fifth pip lights, the emblem spins through the ranks like a
 * slot machine and lands. Under reduced motion every step lands at once.
 */
import { emblemUrl } from './components/SeasonRank';

const TIER_C: Record<string, string> = {
  bronze: '#c3804f', silver: '#b9c1c9', gold: '#e3b341', platinum: '#5fc9bd', diamond: '#6fa8ff', master: '#c88cff',
};
const tierOf = (rank: string) => rank.split(' ')[0].toLowerCase();
const colourOf = (rank: string) => TIER_C[tierOf(rank)] ?? '#46c8ee';

export type MomentData =
  | { kind: 'placed'; to: string; srAfter: number; next: number | null; nextName: string | null }
  | { kind: 'up'; tierUp: boolean; from: string; to: string; srBefore: number; srAfter: number; floor: number; fromFloor: number; next: number | null; nextName: string | null };

const reduced = () => typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

interface Stage {
  el: HTMLElement; wash: HTMLElement; fx: HTMLElement; rays: HTMLElement; glow: HTMLElement; rings: NodeListOf<HTMLElement>;
  em: HTMLElement; old: HTMLImageElement; neu: HTMLImageElement; kicker: HTMLElement; name: HTMLElement;
  srLine: HTMLElement; n: HTMLElement; delta: HTMLElement; barWrap: HTMLElement; bar: HTMLElement; next: HTMLElement; flash: HTMLElement;
}

function build(el: HTMLElement): Stage {
  el.innerHTML = `
    <div class="ru__wash"></div>
    <div class="ru__fx">
      <div class="ru__rays"></div><div class="ru__glow"></div>
      <div class="ru__ring"></div><div class="ru__ring"></div>
      <div class="ru__em"><img class="ru__old" alt=""><img class="ru__new" alt=""></div>
    </div>
    <div class="ru__text">
      <p class="ru__kicker"></p>
      <p class="ru__name"></p>
      <p class="ru__sr"><span><span class="ru__n">0</span> SR</span><span class="ru__delta"></span></p>
      <div class="ru__bar"><i></i></div>
      <p class="ru__next"></p>
    </div>
    <div class="ru__flash"></div>`;
  const q = <T extends HTMLElement>(s: string) => el.querySelector(s) as T;
  return {
    el, wash: q('.ru__wash'), fx: q('.ru__fx'), rays: q('.ru__rays'), glow: q('.ru__glow'), rings: el.querySelectorAll('.ru__ring'),
    em: q('.ru__em'), old: q<HTMLImageElement>('.ru__old'), neu: q<HTMLImageElement>('.ru__new'), kicker: q('.ru__kicker'),
    name: q('.ru__name'), srLine: q('.ru__sr'), n: q('.ru__n'), delta: q('.ru__delta'), barWrap: q('.ru__bar'), bar: q('.ru__bar i'),
    next: q('.ru__next'), flash: q('.ru__flash'),
  };
}

/** Plays the moment into `el`. Resolves when it has settled; `cancelled`
 *  stops it between steps (the dialog closed). */
export async function playMoment(el: HTMLElement, m: MomentData, cancelled: () => boolean = () => false): Promise<void> {
  const still = reduced();
  const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, still ? 0 : ms));
  const anim = (node: Element, kf: Keyframe[], o: KeyframeAnimationOptions) =>
    (still || !node.animate ? { finished: Promise.resolve() } : node.animate(kf, { fill: 'forwards', ...o }));
  const countTo = (node: HTMLElement, from: number, to: number, ms: number, ease = (k: number) => 1 - Math.pow(1 - k, 3)) => {
    if (still) { node.textContent = String(to); return Promise.resolve(); }
    return new Promise<void>((res) => {
      const t0 = performance.now();
      const step = (t: number) => {
        const k = Math.min(1, (t - t0) / ms);
        node.textContent = String(Math.round(from + (to - from) * ease(k)));
        if (k < 1) requestAnimationFrame(step); else res();
      };
      requestAnimationFrame(step);
    });
  };
  const s = build(el);

  const slamName = (text: string, color: string) => {
    s.name.style.color = color;
    s.name.innerHTML = [...text].map((ch) => `<span>${ch === ' ' ? '&nbsp;' : ch}</span>`).join('');
    s.name.querySelectorAll('span').forEach((sp, i) => anim(sp, [
      { transform: 'translateY(-26px) scale(1.6)', opacity: 0, textShadow: '-6px 0 rgba(222,78,64,.9), 6px 0 rgba(70,200,238,.9)' },
      { transform: 'translateY(3px) scale(.96)', opacity: 1, offset: 0.6 },
      { transform: 'none', opacity: 1, textShadow: '0 0 0 transparent' },
    ], { duration: 420, delay: i * 45, easing: 'cubic-bezier(.2,.8,.3,1.2)' }));
  };
  const shatter = (src: string, power: number) => {
    s.old.style.opacity = '0';
    if (still) return;
    const pts = [[50, 0], [100, 0], [100, 50], [100, 100], [50, 100], [0, 100], [0, 50], [0, 0]];
    for (let k = 0; k < 8; k++) {
      const a = pts[k], b = pts[(k + 1) % 8];
      const img = document.createElement('img');
      img.src = src; img.className = 'ru__shard'; img.alt = '';
      img.style.clipPath = `polygon(50% 50%, ${a[0]}% ${a[1]}%, ${b[0]}% ${b[1]}%)`;
      s.em.appendChild(img);
      const mx = (a[0] + b[0]) / 2 - 50, my = (a[1] + b[1]) / 2 - 50, len = Math.hypot(mx, my) || 1;
      const d = (90 + Math.random() * 60) * power;
      void anim(img, [
        { transform: 'none', opacity: 1, filter: 'brightness(2.5)' },
        { transform: `translate(${(mx / len) * d}px, ${(my / len) * d + 40}px) rotate(${(Math.random() - 0.5) * 220}deg) scale(.6)`, opacity: 0, filter: 'brightness(1)' },
      ], { duration: 750 + Math.random() * 250, easing: 'cubic-bezier(.15,.7,.4,1)' }).finished.then(() => img.remove());
    }
  };
  const sparks = (n: number, color: string) => {
    if (still) return;
    for (let k = 0; k < n; k++) {
      const sp = document.createElement('i');
      sp.className = 'ru__spark';
      sp.style.background = color; sp.style.boxShadow = `0 0 8px ${color}`;
      s.fx.appendChild(sp);
      const a = Math.random() * Math.PI * 2, d = 70 + Math.random() * 120, sz = 0.5 + Math.random();
      void anim(sp, [
        { transform: `rotate(45deg) scale(${sz})`, opacity: 1 },
        { transform: `translate(${Math.cos(a) * d}px, ${Math.sin(a) * d + 30}px) rotate(45deg) scale(0)`, opacity: 0 },
      ], { duration: 700 + Math.random() * 600, easing: 'cubic-bezier(.1,.8,.3,1)' }).finished.then(() => sp.remove());
    }
  };
  const burst = (color: string, power: number) => {
    void anim(s.flash, [{ opacity: 0.95 }, { opacity: 0 }], { duration: 420 * power, easing: 'ease-out' });
    s.rings.forEach((r, i) => {
      r.style.borderColor = color; r.style.boxShadow = `0 0 18px ${color}, inset 0 0 12px ${color}`;
      if (i === 1 && power < 1.2) return;
      void anim(r, [{ transform: 'scale(.3)', opacity: 1 }, { transform: `scale(${3.2 * power})`, opacity: 0 }], { duration: 700, delay: i * 140, easing: 'cubic-bezier(.1,.7,.3,1)' });
    });
    if (!still) {
      s.el.animate([
        { transform: 'none' }, { transform: 'translate(-5px, 3px)' }, { transform: 'translate(4px, -4px)' },
        { transform: 'translate(-3px, -2px) scaleX(-1)' }, { transform: 'translate(2px, 2px)' }, { transform: 'none' },
      ], { duration: 320, easing: 'steps(5)' });
    }
    sparks(Math.round(26 * power), color);
  };
  const land = async (src: string) => {
    s.neu.src = src;
    s.neu.style.opacity = '1';
    await anim(s.neu, [
      { transform: 'scale(2.6)', opacity: 0, filter: 'brightness(4) blur(6px)' },
      { transform: 'scale(.88)', opacity: 1, filter: 'brightness(1.6) blur(0)', offset: 0.55 },
      { transform: 'scale(1.06)', filter: 'brightness(1.15)', offset: 0.8 },
      { transform: 'scale(1)', opacity: 1, filter: 'brightness(1)' },
    ], { duration: 650, easing: 'cubic-bezier(.2,.9,.3,1)' }).finished;
    if (!still) s.neu.animate([{ transform: 'translateY(0)' }, { transform: 'translateY(-5px)' }, { transform: 'translateY(0)' }], { duration: 2600, iterations: Infinity, easing: 'ease-in-out' });
  };
  const rays = (color: string) => {
    s.rays.style.background = `repeating-conic-gradient(from 0deg, color-mix(in srgb, ${color} 42%, transparent) 0deg 5deg, transparent 5deg 15deg)`;
    void anim(s.rays, [{ opacity: 0, transform: 'scale(.4)' }, { opacity: 1, transform: 'scale(1)' }], { duration: 600, easing: 'ease-out' });
    if (!still) s.rays.animate([{ rotate: '0deg' }, { rotate: '360deg' }], { duration: 30000, iterations: Infinity });
    void anim(s.glow, [{ opacity: 0 }, { opacity: 0.55 }], { duration: 500 });
  };
  const nextLine = (srAfter: number, next: number | null, nextName: string | null, override?: string) => {
    s.next.textContent = override ?? (next === null || nextName === null ? 'Top division' : `${next - srAfter} SR to ${nextName}`);
    void anim(s.next, [{ opacity: 0 }, { opacity: 1 }], { duration: 400 });
  };
  const toUrl = emblemUrl(m.to) ?? '';
  const toC = colourOf(m.to);

  if (m.kind === 'up') {
    const fromC = colourOf(m.from);
    const power = m.tierUp ? 1.45 : 1;
    const fromUrl = emblemUrl(m.from) ?? '';
    const span = Math.max(1, m.floor - m.fromFloor);
    const bar0 = Math.max(0, Math.min(97, ((m.srBefore - m.fromFloor) / span) * 100));
    const bar1 = m.next === null ? 100 : Math.max(2, Math.min(100, ((m.srAfter - m.floor) / Math.max(1, m.next - m.floor)) * 100));
    s.el.style.setProperty('--c', fromC);
    s.old.src = fromUrl;
    s.kicker.textContent = 'Match won';
    s.name.textContent = m.from; s.name.style.color = fromC;
    s.n.textContent = String(m.srBefore);
    s.delta.textContent = `+${m.srAfter - m.srBefore}`;
    s.bar.style.width = `${bar0}%`;
    await sleep(450);
    if (cancelled()) return;
    await anim(s.delta, [{ opacity: 0, transform: 'scale(2) translateY(-6px)' }, { opacity: 1, transform: 'none' }], { duration: 300, easing: 'cubic-bezier(.2,.9,.3,1.3)' }).finished;
    s.delta.style.opacity = '1';
    const climb = m.tierUp ? 1500 : 1150;
    void anim(s.bar, [{ width: `${bar0}%` }, { width: '100%' }], { duration: climb, easing: 'cubic-bezier(.5,0,.9,.6)' });
    void anim(s.glow, [{ opacity: 0 }, { opacity: 0.9 }], { duration: climb, easing: 'ease-in' });
    void anim(s.wash, [{ opacity: 0.35 }, { opacity: 0.8 }], { duration: climb });
    const shake = still ? null : s.old.animate([
      { transform: 'translate(0,0)' }, { transform: 'translate(-1px,1px) rotate(-1deg)' }, { transform: 'translate(2px,-1px) rotate(1.5deg)' },
      { transform: 'translate(-2px,-2px) rotate(-2deg)' }, { transform: 'translate(2px,2px) rotate(2deg)' },
    ], { duration: 90, iterations: Infinity, direction: 'alternate' });
    await countTo(s.n, m.srBefore, m.floor, climb, (k) => k * k);
    shake?.cancel();
    if (cancelled()) return;

    if (m.tierUp) s.el.style.setProperty('--c', toC);
    shatter(fromUrl, power);
    burst(toC, power);
    s.kicker.textContent = m.tierUp ? 'Promoted' : 'Ranked up';
    s.kicker.style.color = toC;
    void anim(s.kicker, [{ letterSpacing: '0.9em', opacity: 0 }, { letterSpacing: '0.3em', opacity: 1 }], { duration: 500, easing: 'ease-out' });
    s.bar.style.background = toC; s.bar.style.boxShadow = `0 0 10px ${toC}`;
    const landed = land(toUrl);
    setTimeout(() => slamName(m.to, toC), still ? 0 : 160);
    rays(toC);
    await landed;
    if (cancelled()) return;
    void anim(s.bar, [{ width: '0%' }, { width: `${bar1}%` }], { duration: 600, easing: 'ease-out' });
    await countTo(s.n, m.floor, m.srAfter, 600);
    nextLine(m.srAfter, m.next, m.nextName, m.tierUp ? `Welcome to ${m.to.split(' ')[0]}` : undefined);
    return;
  }

  // Placement.
  s.el.style.setProperty('--c', '#7f90a6');
  s.old.style.display = 'none';
  s.neu.src = emblemUrl('Silver III') ?? '';
  s.neu.style.opacity = '0.12'; s.neu.style.filter = 'brightness(0)';
  s.kicker.textContent = 'Placement 4 of 5';
  s.name.textContent = '? ? ?'; s.name.style.color = 'var(--text-muted)';
  s.srLine.innerHTML = '<span class="muted">SR hidden until game 5</span>';
  const pips = document.createElement('div');
  pips.className = 'ru__pips';
  pips.innerHTML = '<i class="on"></i><i class="on"></i><i class="on"></i><i class="on"></i><i></i>';
  s.barWrap.replaceWith(pips);
  await sleep(600);
  if (cancelled()) return;
  const lastPip = pips.children[4] as HTMLElement;
  lastPip.classList.add('on');
  await anim(lastPip, [{ transform: 'rotate(45deg) scale(2.2)' }, { transform: 'rotate(45deg) scale(1)' }], { duration: 350, easing: 'cubic-bezier(.2,.9,.3,1.3)' }).finished;
  s.kicker.textContent = 'Placement complete';
  const reel = ['Bronze II', 'Silver III', 'Gold III', 'Platinum II', 'Diamond III', 'Master III', 'Silver I', 'Platinum III', 'Bronze I', 'Diamond II', 'Silver II', 'Gold III'];
  s.neu.style.filter = 'brightness(.35) blur(1px)'; s.neu.style.opacity = '0.9';
  void anim(s.glow, [{ opacity: 0 }, { opacity: 0.6 }], { duration: 1600 });
  if (!still) {
    let gap = 70;
    for (const r of reel) {
      if (cancelled()) return;
      s.neu.src = emblemUrl(r) ?? '';
      s.el.style.setProperty('--c', colourOf(r));
      s.wash.style.opacity = '0.5';
      await sleep(gap);
      gap *= 1.17;
    }
    await sleep(220);
  }
  s.el.style.setProperty('--c', toC);
  s.neu.style.filter = ''; s.neu.style.opacity = '1';
  burst(toC, 1.25);
  rays(toC);
  const landed = land(toUrl);
  setTimeout(() => slamName(m.to, toC), still ? 0 : 160);
  s.kicker.textContent = 'You placed'; s.kicker.style.color = toC;
  await landed;
  if (cancelled()) return;
  s.srLine.innerHTML = '<span><span class="ru__n">0</span> SR</span>';
  await countTo(s.srLine.querySelector('.ru__n') as HTMLElement, 0, m.srAfter, 900);
  nextLine(m.srAfter, m.next, m.nextName);
}
