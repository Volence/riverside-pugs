# Site Visual Sweep Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the Riverside PUG site one Left 4 Dead visual identity (versus-HUD structure, campaign-poster voice) across every route and the replay viewer, without changing what any page does or what any number means.

**Architecture:** Every color, type step and space on the site already resolves through `web/src/styles/tokens.css`, so the sweep is a token rewrite plus per-component restyling in `web/src/styles/app.css`, a handful of new shared components in `web/src/components/`, and route edits that swap the stat-card row for a poster page header. The replay canvas changes only where it paints chrome. Theater mode (spec section 7.1) is a separate plan, written after this one lands, because it builds on the restyled `HudStrip` and controls.

**Tech Stack:** Preact 10 + preact-iso, Vite 5, TypeScript, vitest 4 with happy-dom and `@testing-library/preact`, plain CSS with custom properties. Node 24. Headless Google Chrome over the DevTools protocol for screenshot passes.

**Spec:** `docs/superpowers/specs/2026-09-12-site-visual-sweep-design.md`. Read it first; every task below cites the section it implements.

## Global Constraints

- Branch: `feat/skill-stats-5`. One commit per task, message in the repo's `type(scope): summary` style, lower case, no trailing period. Never use an em dash anywhere: not in code, comments, commits or docs.
- `npm test` (808 tests before this plan) and `npm run typecheck` must pass before every commit. Run both from `/home/volence/l4d/pug`.
- Colors: `--accent` (#de4e40) is interactive and infected. `--rating` (#c9a45c) is ratings and top-three ranks only. `--win` (#45b39c) is wins and survivor health. Amber (#e3892b, #1a1206) and the old gold (#f2cd6a) are deleted and must not reappear; the tokens test fails if they do.
- Type: `--font-display` is Anton, `--font-label` is Oswald, `--font-body` is IBM Plex Sans. No other font families.
- Corners are square: `--radius: 0`, `--radius-lg: 2px`. Dots, rings and the `.tabs__count` pill are the only rounded shapes.
- `SLOT_COLORS`, `GHOST_COLOR`, `ENTITY_STYLES` and `TEMP_HEALTH_COLOR` in `web/src/replay/` are not changed by any task.
- Wordmark is "Riverside". The nav item and page title for `/maps` is "Campaigns". Route paths do not change.
- The route tests in `web/src/routes/routes.test.tsx` assert on visible strings: `Matches`, `Avg margin`, `Season 1`, `Team A`, `Match totals`, `Round 1`, `Dead Air`, `No Mercy`, `1200`, `+12`. Keep those strings on screen exactly once where the test uses `getByText` (it throws on duplicates).
- Nothing is deployed by this plan.

## File structure

New files:

- `scripts/shoot-pages.mjs`: headless Chrome screenshot rig for every route at 1400px and 390px.
- `web/src/styles/tokens.test.ts`: contrast assertions and the forbidden-hex scan.
- `web/src/components/PageHeader.tsx`: `PageHeader`, `Figures`, `Figure`. Replaces `Tile`/`Tiles`.
- `web/src/components/PageHeader.test.tsx`
- `web/src/components/CampaignTiles.tsx`: the poster tile grid.
- `web/src/components/CampaignTiles.test.tsx`
- `web/src/components/VersusHeader.tsx`: the two-team scoreboard header.
- `web/src/components/VersusHeader.test.tsx`
- `web/src/components/Headliner.tsx`: the rating hero card.
- `web/src/components/Headliner.test.tsx`
- `web/src/replay/ReplayHud.tsx`: the overlay inside the stage (time, counts, toggle chips).
- `web/src/replay/ReplayHud.test.tsx`

Modified files, by responsibility:

- `web/src/styles/tokens.css`: every color, font and radius token (spec 3).
- `web/src/styles/app.css`: every component style (spec 4, 5, 7). Sections are edited in place under their existing `/* ---------- name ---------- */` banners.
- `web/index.html`: font links and title.
- `web/src/format.ts`: `campaignTint`.
- `web/src/components/Nav.tsx`, `bits.tsx`, `StatTable.tsx`, `Countdown.tsx`.
- `web/src/routes/*.tsx`: one task each.
- `web/src/replay/Viewer.tsx`, `ReplayControls.tsx`, `HudStrip.tsx`, `hud.ts`, `draw.ts`.
- `web/src/main.tsx`: passes live state to the nav.

---

### Task 1: Screenshot rig

Spec 8. Every later task ends with a screenshot pass, so the rig comes first.

**Files:**
- Create: `scripts/shoot-pages.mjs`
- Modify: `package.json` (scripts), `.gitignore`

**Interfaces:**
- Produces: `npm run shoot` writes `shots/<route>-<width>.png` for every route against `http://localhost:5173`, and exits non-zero if any route fails to load.

- [ ] **Step 1: Write the rig**

```js
// scripts/shoot-pages.mjs
// Screenshot every route at desktop and phone widths with headless Chrome
// over the DevTools protocol. Needs `npm run dev` running on :5173 and the
// seeded local match 9001. Output: shots/<name>-<width>.png.
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';

const PORT = 9340;
const BASE = process.env.SHOOT_BASE ?? 'http://localhost:5173';
const OUT = 'shots';
const ROUTES = [
  ['home', '/'], ['live', '/live'], ['leaderboard', '/leaderboard'],
  ['matches', '/matches'], ['match-9001', '/match/9001'], ['campaigns', '/maps'],
  ['map-caves', '/map/l4d_vs_smalltown01_caves'], ['replays', '/replays'],
  ['profile', '/player/76561198000000001'],
];
const WIDTHS = [1400, 390];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const chrome = spawn('google-chrome-stable', [
  '--headless=new', `--remote-debugging-port=${PORT}`,
  `--user-data-dir=/tmp/shoot-pages-profile`, '--no-first-run', 'about:blank',
], { stdio: 'ignore' });

let ws; let id = 0; const pending = new Map();
function send(method, params = {}) {
  const i = ++id;
  ws.send(JSON.stringify({ id: i, method, params }));
  return new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error(`timeout ${method}`)), 20000);
    pending.set(i, (m) => { clearTimeout(t); m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result); });
  });
}

try {
  for (let i = 0; i < 40; i++) {
    try { await fetch(`http://localhost:${PORT}/json/version`); break; } catch { await sleep(250); }
  }
  const page = (await (await fetch(`http://localhost:${PORT}/json`)).json()).find((t) => t.type === 'page');
  ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((r) => { ws.onopen = r; });
  ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) pending.get(m.id)(m); };
  await send('Page.enable');
  await send('Runtime.enable');
  mkdirSync(OUT, { recursive: true });

  let failed = 0;
  for (const [name, path] of ROUTES) {
    for (const width of WIDTHS) {
      await send('Emulation.setDeviceMetricsOverride', { width, height: 1000, deviceScaleFactor: 1, mobile: width < 768 });
      await send('Page.navigate', { url: BASE + path });
      await sleep(path.startsWith('/match/') ? 4000 : 2000);
      const probe = await send('Runtime.evaluate', {
        returnByValue: true,
        expression: 'JSON.stringify({h: Math.min(document.documentElement.scrollHeight, 6000), overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth, empty: document.getElementById("app").children.length === 0})',
      });
      const { h, overflow, empty } = JSON.parse(probe.result.value);
      await send('Emulation.setDeviceMetricsOverride', { width, height: h, deviceScaleFactor: 1, mobile: width < 768 });
      await sleep(500);
      const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
      writeFileSync(`${OUT}/${name}-${width}.png`, Buffer.from(shot.data, 'base64'));
      const flags = [empty ? 'EMPTY' : '', overflow ? 'HORIZONTAL OVERFLOW' : ''].filter(Boolean).join(' ');
      if (flags) failed++;
      console.log(`${name}-${width}.png ${h}px ${flags}`);
    }
  }
  process.exitCode = failed ? 1 : 0;
} finally {
  chrome.kill();
}
```

- [ ] **Step 2: Add the npm script and ignore the output**

In `package.json` `scripts`, add:

```json
"shoot": "node scripts/shoot-pages.mjs"
```

Append to `.gitignore`:

```
# Screenshot passes from scripts/shoot-pages.mjs
shots/
```

- [ ] **Step 3: Run it against the dev server**

Start the dev server in the background if it is not running: `npm run dev &` (it serves on 5173 and proxies the API on 8080). Then:

Run: `npm run shoot`
Expected: eighteen lines like `home-1400.png 1000px`, no `EMPTY` or `HORIZONTAL OVERFLOW` flags, exit code 0. Open two of the PNGs to confirm they show the current site. These are the "before" images; keep them outside the repo if you want them later, the directory is ignored.

- [ ] **Step 4: Commit**

```bash
git add scripts/shoot-pages.mjs package.json .gitignore
git commit -m "chore(web): add a headless screenshot pass over every route"
```

---

### Task 2: Tokens, fonts and atmosphere

Spec 3.1 through 3.5, with two values corrected by measurement: `--accent` is `#de4e40` (the spec's `#c93a2e` is 3.9:1 on the page and fails as link text), `--accent-ink` is `#0b0908` (bone on red is 3.1:1), and `--text-muted` is `#958770` (5.06:1 on `--surface-2`; the spec's `#8d7f66` was 4.54:1 with no margin). Update the spec's tables to these three values as part of this task.

**Files:**
- Modify: `web/src/styles/tokens.css` (whole file)
- Modify: `web/src/styles/app.css` (`body` rule; `.hero--rating`; `.vote__bar`)
- Modify: `web/index.html`
- Modify: `web/src/components/Countdown.tsx:24-25` (document title)
- Modify: `docs/superpowers/specs/2026-09-12-site-visual-sweep-design.md` sections 3.1 and 3.2
- Test: `web/src/styles/tokens.test.ts`

**Interfaces:**
- Produces: the token names every later task uses: `--bg --surface --surface-2 --border --border-strong --text --text-bright --text-muted --accent --accent-ink --rule --rating --win --loss --draw --c-no-mercy --c-death-toll --c-dead-air --c-blood-harvest --font-display --font-label --font-body --fs-label --fs-dense --fs-body --fs-h3 --fs-h2 --fs-h1 --fs-title --fs-hero --sp-1..7 --radius --radius-lg --grain --vignette`.

- [ ] **Step 1: Write the failing tokens test**

```ts
// web/src/styles/tokens.test.ts
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { relativeLuminance } from '../replay/colorDistance';

const ROOT = join(__dirname, '..');
const css = readFileSync(join(__dirname, 'tokens.css'), 'utf8');

/** `--name: value;` pairs from the :root block. */
function tokens(): Record<string, string> {
  const out: Record<string, string> = {};
  const root = css.slice(css.indexOf(':root {'), css.indexOf('\n}', css.indexOf(':root {')));
  for (const m of root.matchAll(/--([a-z0-9-]+):\s*([^;]+);/g)) out[m[1]] = m[2].trim();
  return out;
}

function contrast(a: string, b: string): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(tsx?|css|html)$/.test(name) && !/\.test\./.test(name)) out.push(p);
  }
  return out;
}

describe('tokens.css', () => {
  const t = tokens();

  it('keeps body and muted text above AA on every surface they sit on', () => {
    for (const bg of ['bg', 'surface', 'surface-2']) {
      expect(contrast(t.text, t[bg]), `text on ${bg}`).toBeGreaterThanOrEqual(4.5);
      expect(contrast(t['text-bright'], t[bg]), `text-bright on ${bg}`).toBeGreaterThanOrEqual(4.5);
      expect(contrast(t['text-muted'], t[bg]), `text-muted on ${bg}`).toBeGreaterThanOrEqual(4.5);
    }
  });

  it('keeps the accent usable as link text on the page and on panels', () => {
    expect(contrast(t.accent, t.bg)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(t.accent, t.surface)).toBeGreaterThanOrEqual(4.5);
    // The rating and win colors are used as text too.
    expect(contrast(t.rating, t.surface)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(t.win, t.surface)).toBeGreaterThanOrEqual(4.5);
    // Ink on a filled accent button.
    expect(contrast(t['accent-ink'], t.accent)).toBeGreaterThanOrEqual(4.5);
  });

  it('names the three fonts and nothing else', () => {
    expect(t['font-display']).toMatch(/^"Anton"/);
    expect(t['font-label']).toMatch(/^"Oswald"/);
    expect(t['font-body']).toMatch(/^"IBM Plex Sans"/);
    expect(css).not.toMatch(/Barlow/);
  });

  it('has square corners', () => {
    expect(t.radius).toBe('0');
    expect(t['radius-lg']).toBe('2px');
  });

  it('has retired amber and the old gold everywhere under web/src', () => {
    const forbidden = [/#e3892b/i, /#1a1206/i, /#f2cd6a/i, /227 137 43/, /242 205 106/, /Barlow/];
    for (const file of walk(ROOT)) {
      const src = readFileSync(file, 'utf8');
      for (const re of forbidden) expect(src, `${file} contains ${re}`).not.toMatch(re);
    }
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run web/src/styles/tokens.test.ts`
Expected: FAIL. The fonts test fails on Barlow, the corners test fails on `6px`, the forbidden scan fails on `#e3892b` in tokens.css and on `227 137 43` in app.css.

- [ ] **Step 3: Rewrite tokens.css**

Replace the whole file with:

```css
/* "Poster" design tokens.
 *
 * Every color, space and type step in the app resolves to something in here.
 * A change of heart about the look is an edit to this file, not a grep through
 * components. Spec: docs/superpowers/specs/2026-09-12-site-visual-sweep-design.md
 *
 * Contrast ratios below were computed against WCAG relative luminance and are
 * asserted by tokens.test.ts, so they cannot drift silently. */

:root {
  /* Surfaces: warm near-black. */
  --bg: #0b0908;
  --surface: #15110e;
  --surface-2: #1c1713;
  --border: rgba(217, 203, 176, 0.14);
  --border-strong: rgba(217, 203, 176, 0.28);

  /* Text. --text 12.4:1 on bg. --text-muted 5.1:1 on surface-2, the tightest
   * pair on the site. */
  --text: #d9cbb0;
  --text-bright: #efe2c4;
  --text-muted: #958770;

  /* Blood red. The only interactive color, and the infected team's color.
   * 5.0:1 on bg and 4.7:1 on surface, so it works as link text. Ink is the
   * page black: bone on this red is only 3.1:1. */
  --accent: #de4e40;
  --accent-ink: #0b0908;
  /* The one decorative red: a 2px rule under a header. Never text. */
  --rule: #9b2a22;

  /* Gold. Ratings and the top three ranks, nowhere else. 8.0:1 on surface. */
  --rating: #c9a45c;

  /* Results and teams. Teal is wins and survivor health; red is losses and
   * infected, deliberately the same hue as the accent. 7.3:1 and 4.7:1 on
   * surface. A W/L/D glyph always accompanies the color. */
  --win: #45b39c;
  --loss: #de4e40;
  --draw: #958770;

  /* Campaign tints for the four L4D1 campaigns. Every other campaign gets a
   * tint from campaignTint() in web/src/format.ts, at the same weight. */
  --c-no-mercy: #6f8a7a;
  --c-death-toll: #5a6f8c;
  --c-dead-air: #b8842f;
  --c-blood-harvest: #8a3f32;

  --font-display: "Anton", Impact, "Arial Narrow", sans-serif;
  --font-label: "Oswald", "Arial Narrow", sans-serif;
  --font-body: "IBM Plex Sans", system-ui, "Segoe UI", sans-serif;

  --fs-label: 0.75rem;
  --fs-dense: 0.875rem;
  --fs-body: 1rem;
  --fs-h3: 1.25rem;
  --fs-h2: 1.75rem;
  --fs-h1: 2.5rem;
  /* Page titles in Anton, which sets tighter than a condensed grotesque. */
  --fs-title: 2.25rem;
  /* The versus scoreboard, the profile rating and the ready-check countdown. */
  --fs-hero: 5rem;

  --sp-1: 0.25rem;
  --sp-2: 0.5rem;
  --sp-3: 0.75rem;
  --sp-4: 1rem;
  --sp-5: 1.5rem;
  --sp-6: 2rem;
  --sp-7: 3rem;

  /* Square. The poster voice has no rounded panels; dots and rings are the
   * only curves left. */
  --radius: 0;
  --radius-lg: 2px;

  /* Atmosphere, painted once on body. Panels are flat --surface over it. */
  --grain: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='260' height='260'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.7' numOctaves='3' stitchTiles='stitch'/%3E%3CfeColorMatrix values='0 0 0 0 0.6  0 0 0 0 0.45  0 0 0 0 0.3  0 0 0 0.14 0'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)'/%3E%3C/svg%3E");
  --vignette:
    radial-gradient(ellipse at 50% 0%, rgba(120, 40, 30, 0.30), transparent 50%),
    radial-gradient(ellipse at 50% 60%, transparent 45%, rgba(0, 0, 0, 0.80) 100%);
}

/* The final ten seconds of a ready check. Set on the countdown panel and on
 * <body>, so the nav rule also changes and the state is visible from any page.
 * The accent is already red, so urgency brightens it rather than switching hue;
 * the nav rule thickens to 3px for the same reason (see .nav in app.css). */
[data-urgent='true'] {
  --accent: #f0655a;
}

@media (max-width: 640px) {
  :root { --fs-hero: 3.25rem; --fs-h1: 2rem; --fs-title: 1.75rem; }
}
```

- [ ] **Step 4: Paint the atmosphere and remove the two amber literals in app.css**

Replace the `body` rule at the top of `web/src/styles/app.css` with:

```css
body {
  margin: 0;
  min-height: 100vh;
  background-color: var(--bg);
  background-image: var(--vignette), var(--grain);
  background-attachment: fixed;
  color: var(--text);
  font-family: var(--font-body);
  font-size: var(--fs-body);
  line-height: 1.5;
  -webkit-font-smoothing: antialiased;
}
```

Replace `.hero--rating { color: var(--rating); text-shadow: 0 0 28px rgb(242 205 106 / 0.22); }` with:

```css
.hero--rating { color: var(--rating); text-shadow: 0 3px 0 #2b0e0b; }
```

Replace the `background: rgb(227 137 43 / 0.16);` line inside `.vote__bar` with:

```css
  background: color-mix(in srgb, var(--accent) 16%, transparent);
```

Delete the `@media (max-width: 640px) { :root { --fs-hero: 3.25rem; --fs-h1: 2rem; } ... }` block's `:root` line in app.css (the token file now owns it); keep the `.nav` and `.page` lines in that media block.

- [ ] **Step 5: Fonts and title in index.html, title in Countdown**

In `web/index.html` replace the `<title>` and the Google Fonts `<link>`:

```html
  <title>Riverside</title>
  <link rel="icon" href="/favicon.svg" type="image/svg+xml">
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Anton&family=Oswald:wght@400;500;600&family=IBM+Plex+Sans:wght@400;500;600&display=swap" rel="stylesheet">
```

In `web/src/components/Countdown.tsx`, both occurrences of `'L4D1 PUG'` become `'Riverside'`.

- [ ] **Step 6: Amend the spec tables**

In the spec, section 3.1: `--text-muted` value becomes `#958770`. Section 3.2: `--accent` becomes `#de4e40`, `--loss` becomes `#de4e40`, and the sentence about `--accent-ink` becomes: "`--accent-ink` becomes `#0b0908`, the page black: bone on this red is only 3.1:1, so a filled button carries dark ink." Section 10 gets one line: "Accent brightened to #de4e40 and ink darkened after measuring contrast; recorded in tokens.test.ts."

- [ ] **Step 7: Run the tests and typecheck**

Run: `npx vitest run web/src/styles/tokens.test.ts && npm test && npm run typecheck`
Expected: tokens test passes all five cases; the full suite passes (809 tests); typecheck clean. If the forbidden scan fails on a file this task did not touch, that file has an amber literal the spec missed: replace it with `var(--accent)` and note it in the commit body.

- [ ] **Step 8: Screenshot pass**

Run: `npm run shoot`
Expected: every route loads. The site will look half-finished (new colors, old shapes); that is expected at this step. Confirm text is legible everywhere and nothing is invisible (a component still hard-coding amber would show as a missing element).

- [ ] **Step 9: Commit**

```bash
git add web/src/styles/tokens.css web/src/styles/tokens.test.ts web/src/styles/app.css web/index.html web/src/components/Countdown.tsx docs/superpowers/specs/2026-09-12-site-visual-sweep-design.md
git commit -m "feat(web): poster tokens, Anton and Oswald, grain and vignette"
```

---

### Task 3: Nav and the page header component

Spec 4.1 and 4.2. The nav gets the wordmark, the renamed Campaigns item and a live indicator. `PageHeader` with `Figures`/`Figure` is the shape every route will migrate to in Tasks 9 to 18; `Tile`/`Tiles` stay until Task 19 deletes them.

**Files:**
- Modify: `web/src/components/Nav.tsx` (whole file)
- Modify: `web/src/components/Nav.test.ts`
- Modify: `web/src/main.tsx:39` (pass `state` to `Nav`)
- Create: `web/src/components/PageHeader.tsx`
- Create: `web/src/components/PageHeader.test.tsx`
- Modify: `web/src/styles/app.css` (`shell` section: `.nav*`, `.page__head` replaced by `.page-head*`, `.figures`, `.figure*`)

**Interfaces:**
- Produces:
  - `Nav({ session, state }: { session: Session; state: StateSnapshot | null })`
  - `PageHeader({ eyebrow, title, aside, children }: { eyebrow?: string; title: ComponentChildren; aside?: ComponentChildren; children?: ComponentChildren })` renders `<header class="page-head">` with the title in an `<h2>`, `aside` at the right, and `children` (normally a `<Figures>`) beneath the title row, above the red rule.
  - `Figures({ children })` is a flex row; `Figure({ label, value, sub, tone })` is one eyebrowed number, `tone?: 'rating' | 'win' | 'loss'`.

- [ ] **Step 1: Extend the Nav test**

Append to `web/src/components/Nav.test.ts`:

```ts
import { render, cleanup } from '@testing-library/preact';
import { LocationProvider } from 'preact-iso';
import { afterEach } from 'vitest';
import { Nav } from './Nav';

afterEach(cleanup);

describe('Nav', () => {
  it('calls the maps route Campaigns and keeps its path', () => {
    const maps = NAV_LINKS.find(([href]) => href === '/maps');
    expect(maps?.[1]).toBe('Campaigns');
  });

  it('shows the wordmark and no live indicator when nothing is live', () => {
    const { container } = render(
      <LocationProvider><Nav session={{ kind: 'anonymous' }} state={null} /></LocationProvider>,
    );
    expect(container.querySelector('.nav__brand')?.textContent).toBe('Riverside');
    expect(container.querySelector('.nav__live')).toBeNull();
  });

  it('shows a live indicator naming the campaign while a match is live', () => {
    const state = {
      queue: { count: 0, joined: false }, lobby: null,
      match: { id: 4, state: 'live', campaign: 'no_mercy', teamA: [], teamB: [] },
    };
    const { container } = render(
      <LocationProvider><Nav session={{ kind: 'anonymous' }} state={state} /></LocationProvider>,
    );
    const live = container.querySelector('.nav__live');
    expect(live?.textContent).toContain('No Mercy');
    expect(live?.getAttribute('href')).toBe('/live');
  });
});
```

Rename the file to `Nav.test.tsx` (it now contains JSX): `git mv web/src/components/Nav.test.ts web/src/components/Nav.test.tsx`.

- [ ] **Step 2: Write the PageHeader test**

```tsx
// web/src/components/PageHeader.test.tsx
import { describe, it, expect, afterEach } from 'vitest';
import { render, cleanup, screen } from '@testing-library/preact';
import { PageHeader, Figures, Figure } from './PageHeader';

afterEach(cleanup);

describe('PageHeader', () => {
  it('renders eyebrow, title, aside and figures', () => {
    render(
      <PageHeader eyebrow="Season 1" title="Leaderboard" aside={<span>24 players</span>}>
        <Figures>
          <Figure label="Players" value={24} />
          <Figure label="Top rating" value={1151} tone="rating" sub="fake_11" />
        </Figures>
      </PageHeader>,
    );
    expect(screen.getByRole('heading', { level: 2 }).textContent).toBe('Leaderboard');
    expect(screen.getByText('Season 1')).toBeTruthy();
    expect(screen.getByText('24 players')).toBeTruthy();
    expect(screen.getByText('Players')).toBeTruthy();
    expect(screen.getByText('1151').classList.contains('figure__value--rating')).toBe(true);
    expect(screen.getByText('fake_11')).toBeTruthy();
  });

  it('omits the eyebrow and aside when not given', () => {
    const { container } = render(<PageHeader title="Replays" />);
    expect(container.querySelector('.page-head__eyebrow')).toBeNull();
    expect(container.querySelector('.page-head__aside')).toBeNull();
  });
});
```

- [ ] **Step 3: Run both to verify they fail**

Run: `npx vitest run web/src/components/Nav.test.tsx web/src/components/PageHeader.test.tsx`
Expected: FAIL. PageHeader module not found; Nav renders "L4D1 PUG" and has no `.nav__live`.

- [ ] **Step 4: Write PageHeader**

```tsx
// web/src/components/PageHeader.tsx
import type { ComponentChildren } from 'preact';

/**
 * The poster page header: an eyebrow, an Anton title, an optional right-hand
 * aside, then a row of figures, all above one red rule.
 *
 * Replaces the stat-card row (Tile/Tiles). The summary numbers a page used to
 * put in cards sit here as figures, so the header carries the page's
 * headline facts and the panels below carry the detail.
 */
export function PageHeader(
  { eyebrow, title, aside, children }: {
    eyebrow?: string;
    title: ComponentChildren;
    aside?: ComponentChildren;
    children?: ComponentChildren;
  },
) {
  return (
    <header class="page-head">
      <div class="page-head__row">
        <div>
          {eyebrow && <p class="page-head__eyebrow eyebrow">{eyebrow}</p>}
          <h2 class="page-head__title">{title}</h2>
        </div>
        {aside && <div class="page-head__aside">{aside}</div>}
      </div>
      {children}
    </header>
  );
}

export function Figures({ children }: { children: ComponentChildren }) {
  return <div class="figures">{children}</div>;
}

/** One eyebrowed number. `tone` colors the number by role: gold for a
 *  rating, teal or red for a result. Untoned figures are bright bone. */
export function Figure(
  { label, value, sub, tone }: {
    label: string;
    value: string | number;
    sub?: string;
    tone?: 'rating' | 'win' | 'loss';
  },
) {
  return (
    <div class="figure">
      <p class="figure__label eyebrow">{label}</p>
      <p class={`figure__value num${tone ? ` figure__value--${tone}` : ''}`}>{value}</p>
      {sub && <p class="figure__sub">{sub}</p>}
    </div>
  );
}
```

- [ ] **Step 5: Rewrite Nav**

```tsx
// web/src/components/Nav.tsx
import { useLocation } from 'preact-iso';
import type { StateSnapshot } from '../api';
import { campaignName } from '../format';
import type { Session } from '../hooks/useLiveState';

/** [href, label, target?].
 *
 *  A target is what keeps preact-iso's click handler off a link: it only
 *  intercepts same-origin clicks whose target is absent or _self (router.js:45).
 *  The crosshair maker is a standalone static page with its own document, not a
 *  route, so without the target the router would swallow the click and show the
 *  SPA's not-found instead of the page.
 *
 *  The maps route is labelled Campaigns: that is how players refer to what it
 *  lists. The path stays /maps so nothing bookmarked breaks. */
export const NAV_LINKS: readonly (readonly [string, string, string?])[] = [
  ['/', 'Play'],
  ['/live', 'Live'],
  ['/leaderboard', 'Leaderboard'],
  ['/matches', 'Matches'],
  ['/maps', 'Campaigns'],
  ['/replays', 'Replays'],
  ['/crosshair.html', 'Crosshair', '_blank'],
];

export function Nav({ session, state }: { session: Session; state: StateSnapshot | null }) {
  const { path } = useLocation();
  const me = session.kind === 'active' || session.kind === 'pending' ? session.me : null;
  const live = state?.match && state.match.state === 'live' ? state.match : null;

  return (
    <header class="nav">
      <a class="nav__brand" href="/">Riverside</a>
      <nav class="nav__links">
        {NAV_LINKS.map(([href, label, target]) => (
          <a key={href} href={href} target={target}
             rel={target ? 'noopener' : undefined}
             aria-current={path === href ? 'page' : undefined}>{label}</a>
        ))}
      </nav>
      {live && (
        <a class="nav__live" href="/live">
          <span class="nav__live-dot" aria-hidden="true" />
          Live · {campaignName(live.campaign)}
        </a>
      )}
      {me && (
        <div class="nav__me">
          {me.avatar && <img src={me.avatar} alt="" />}
          <a href={`/player/${encodeURIComponent(me.steamid)}`}>{me.name}</a>
        </div>
      )}
    </header>
  );
}
```

In `web/src/main.tsx`, change `<Nav session={session} />` to `<Nav session={session} state={state} />`.

- [ ] **Step 6: Restyle the shell in app.css**

Replace everything from `/* ---------- shell ---------- */` up to (not including) `.nav__me {` with:

```css
/* ---------- shell ---------- */

.nav {
  display: flex;
  align-items: center;
  gap: var(--sp-5);
  height: 62px;
  padding: 0 var(--sp-5);
  background: color-mix(in srgb, var(--surface) 70%, transparent);
  /* Thickens and brightens with body[data-urgent], which is how a running
   * ready check stays visible while you are reading the leaderboard. */
  border-bottom: 1px solid var(--border);
  transition: border-color 200ms linear, border-width 200ms linear;
}
body[data-urgent='true'] .nav { border-bottom: 3px solid var(--accent); }

.nav__brand {
  font-family: var(--font-display);
  font-size: 1.625rem;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: var(--text-bright);
}
.nav__brand:hover { text-decoration: none; }
.nav__links { display: flex; gap: var(--sp-5); flex: 1; }
.nav__links a {
  font-family: var(--font-label);
  font-size: 0.8125rem;
  font-weight: 500;
  text-transform: uppercase;
  letter-spacing: 0.16em;
  color: var(--text-muted);
  padding-bottom: 3px;
  border-bottom: 2px solid transparent;
}
.nav__links a:hover { color: var(--text-bright); text-decoration: none; }
.nav__links a[aria-current='page'] { color: var(--text-bright); border-bottom-color: var(--accent); }

.nav__live {
  display: inline-flex;
  align-items: center;
  gap: var(--sp-2);
  font-family: var(--font-label);
  font-size: var(--fs-label);
  text-transform: uppercase;
  letter-spacing: 0.16em;
  color: var(--text);
}
.nav__live:hover { color: var(--text-bright); text-decoration: none; }
.nav__live-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--accent);
  box-shadow: 0 0 8px var(--accent);
}

```

Then replace the `.page__head { ... }` rule with:

```css
/* The poster page header. One red rule under everything, figures in a row. */
.page-head { margin-bottom: var(--sp-5); border-bottom: 2px solid var(--rule); padding-bottom: var(--sp-4); }
.page-head__row { display: flex; align-items: flex-end; justify-content: space-between; gap: var(--sp-4); }
.page-head__eyebrow { margin: 0 0 var(--sp-1); }
.page-head__title { font-size: var(--fs-title); }
.page-head__aside { color: var(--text-muted); font-family: var(--font-label); font-size: var(--fs-label); text-transform: uppercase; letter-spacing: 0.16em; text-align: right; }

.figures { display: flex; flex-wrap: wrap; gap: var(--sp-4) var(--sp-6); margin-top: var(--sp-4); }
.figure { min-width: 0; }
.figure__label { margin: 0 0 2px; }
.figure__value { margin: 0; font-family: var(--font-display); font-size: var(--fs-h2); line-height: 1; color: var(--text-bright); }
.figure__value--rating { color: var(--rating); }
.figure__value--win { color: var(--win); }
.figure__value--loss { color: var(--loss); }
.figure__sub { margin: var(--sp-1) 0 0; font-size: var(--fs-dense); color: var(--text-muted); }
```

Also update the two type rules at the top of the file: in `h1, h2, h3 { ... }` set `letter-spacing: 0.02em;` (Anton is already tight), and replace the `.eyebrow` rule with:

```css
.eyebrow {
  font-family: var(--font-label);
  font-size: var(--fs-label);
  font-weight: 500;
  text-transform: uppercase;
  letter-spacing: 0.18em;
  color: var(--text-muted);
}
```

- [ ] **Step 7: Run tests, typecheck, screenshots**

Run: `npm test && npm run typecheck && npm run shoot`
Expected: all pass (the two new test files add 5 tests). `routes.test.tsx` still passes because no route has changed yet. Screenshots show the new nav on every page; the old `.page__head` markup in routes is unstyled until each page migrates, which is expected.

- [ ] **Step 8: Commit**

```bash
git add web/src/components/Nav.tsx web/src/components/Nav.test.tsx web/src/components/PageHeader.tsx web/src/components/PageHeader.test.tsx web/src/main.tsx web/src/styles/app.css
git commit -m "feat(web): poster nav with live indicator, and the page header component"
```

---

### Task 4: Panels, tables, chips and controls

Spec 4.3, 5.2, 5.6. CSS only, plus one class on the countdown. Every existing class keeps its name so no component breaks; `.chip` is added as the canonical control and `.btn`, `.btn--ghost`, `.replay__btn`, `.vote` and `.tabs__tab` are restyled to match it. Task 20 renames `.replay__btn` to `.chip` in the viewer.

**Files:**
- Modify: `web/src/styles/app.css` (`controls` and `tables` sections, `.panel`, `.tabs`, `.countdown`, `.slot`, `.vote`, `.delta`, `.result`, `.avatar`, `.devpanel` untouched)

- [ ] **Step 1: Panels**

Replace the `.panel { ... }` rule with:

```css
.panel {
  background: var(--surface);
  border: 1px solid var(--border);
  padding: var(--sp-5);
}
/* A panel heading: Anton left, the section's eyebrow right, one red rule. */
.panel > h3:first-child,
.panel__head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: var(--sp-4);
  padding-bottom: var(--sp-2);
  margin-bottom: var(--sp-3);
  border-bottom: 2px solid var(--rule);
}
.panel > h3:first-child { display: block; }
```

- [ ] **Step 2: Controls**

Replace the whole `/* ---------- controls ---------- */` section (from that banner up to `/* ---------- tables ---------- */`) with:

```css
/* ---------- controls ---------- */

/* The chip is the site's one control shape: Oswald caps, hairline border,
 * muted until active, red border and bright text when on. A filled chip is
 * the primary action. Hit target is 36px tall on desktop and 44px on phones. */
.chip,
.replay__btn,
.btn--ghost,
.tabs__tab {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: var(--sp-2);
  min-height: 36px;
  padding: var(--sp-1) var(--sp-3);
  border: 1px solid var(--border);
  background: color-mix(in srgb, var(--surface) 85%, transparent);
  color: var(--text-muted);
  font-family: var(--font-label);
  font-size: var(--fs-label);
  font-weight: 500;
  text-transform: uppercase;
  letter-spacing: 0.12em;
  line-height: 1;
  cursor: pointer;
  transition: border-color 120ms linear, color 120ms linear;
}
.chip:hover, .replay__btn:hover, .btn--ghost:hover, .tabs__tab:hover {
  color: var(--text-bright);
  border-color: var(--border-strong);
  text-decoration: none;
  filter: none;
}
.chip.is-on, .replay__btn.is-on, .tabs__tab.is-active {
  border-color: var(--accent);
  color: var(--text-bright);
  outline: none;
  font-weight: 500;
}
.chip:disabled, .replay__btn:disabled { opacity: 0.5; cursor: default; }

.btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: var(--sp-2);
  min-height: 40px;
  padding: var(--sp-2) var(--sp-5);
  border: 1px solid var(--accent);
  background: var(--accent);
  color: var(--accent-ink);
  font-family: var(--font-label);
  font-size: var(--fs-dense);
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.14em;
  cursor: pointer;
  transition: filter 120ms linear;
}
.btn:hover { filter: brightness(1.1); text-decoration: none; }
.btn:disabled { opacity: 0.5; cursor: default; filter: none; }
.btn--block { width: 100%; }
.btn--ghost { background: transparent; border-color: var(--border); color: var(--text-muted); min-height: 40px; }

@media (max-width: 640px) {
  .chip, .replay__btn, .btn--ghost, .tabs__tab, .btn { min-height: 44px; }
}

:where(a, button, input):focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}

input {
  padding: var(--sp-3);
  border: 1px solid var(--border);
  background: var(--bg);
  color: var(--text);
  font-family: var(--font-body);
  font-size: var(--fs-body);
}
input:focus { border-color: var(--accent); }

```

- [ ] **Step 3: Tables base**

In the `tables` section, replace the `th { ... }` rule with:

```css
th {
  text-align: left;
  padding: var(--sp-2) var(--sp-3);
  font-family: var(--font-label);
  font-size: var(--fs-label);
  font-weight: 500;
  text-transform: uppercase;
  letter-spacing: 0.18em;
  color: var(--text-muted);
  border-bottom: 1px solid var(--border);
  white-space: nowrap;
}
```

and replace the `.rank` rules with:

```css
.rank {
  font-family: var(--font-display);
  font-size: 1.375rem;
  line-height: 1;
  color: var(--text-muted);
  width: 3.5rem;
}
.rank--top { color: var(--rating); }
```

and `.sr` with `.sr { font-family: var(--font-display); font-size: 1.5rem; line-height: 1; color: var(--rating); }`.

Replace `.sortable.is-sorted { color: var(--accent); }` with `.sortable.is-sorted { color: var(--rating); }`.

- [ ] **Step 4: Tabs, queue slots, countdown, vote, delta, result, avatar**

- `.tabs__tab`: delete its own `appearance`, `background`, `border`, `padding`, `font`, `letter-spacing` lines (the chip rule now owns them); keep `border-bottom: 2px solid transparent;` after the shared rule by adding `.tabs__tab { border-radius: 0; border-bottom-width: 2px; }` and `.tabs__tab.is-active { border-color: var(--border); border-bottom-color: var(--accent); }`.
- `.tabs__count { border-radius: 999px; }` stays (the one pill).
- `.slot { border-radius: 0; }` and `.countdown__track { border-radius: 0; }` and `.countdown__bar` unchanged. `.countdown__digits { color: var(--accent); font-family: var(--font-display); }`.
- `.vote`: change `border-radius: var(--radius);` to none (delete the line), `font-family: var(--font-label); text-transform: uppercase; letter-spacing: 0.1em; font-size: var(--fs-dense);`.
- `.delta { border-radius: 0; }`, `.result { border-radius: 0; font-family: var(--font-display); }`.
- `.avatar { border-radius: 0; }`.
- `.replay__canvas { border-radius: 0; }` (the sprocket frame comes in Task 20).

- [ ] **Step 5: Run tests, typecheck, screenshots**

Run: `npm test && npm run typecheck && npm run shoot`
Expected: green. Screenshots: every button and toggle is now an Oswald chip, tables have Oswald headers, panels are square. Check the Play page's queue at 390px: the Join button is at least 44px tall.

- [ ] **Step 6: Commit**

```bash
git add web/src/styles/app.css
git commit -m "feat(web): square panels, chip controls and poster table headers"
```

---

### Task 5: Stat table and leaderboard styles

Spec 5.1. The shared `StatTable` and the leaderboard's own table share the treatment: Anton ranks, Oswald names, gold ratings, a gold wash on the top row of a ranked table, team rows as eyebrows.

**Files:**
- Modify: `web/src/styles/app.css` (`tables` section, `.live__*` and `.lb*` rules)
- Modify: `web/src/components/StatTable.tsx:101` (player link cell class)
- Modify: `web/src/routes/Leaderboard.tsx:109` (add `lb--ranked`), `:128` (name cell class)

**Interfaces:**
- Produces: `.lb--ranked` marks a table whose first body row is the leader and gets the gold wash. `.pname` marks a player-name cell set in Oswald.

- [ ] **Step 1: Add the CSS**

Append to the `tables` section, after the `.rank--top` rule:

```css
/* Player names in tables are Oswald caps, bright; links keep the accent on
 * hover only, so a table is not a wall of red. */
.pname, .pname a {
  font-family: var(--font-label);
  font-size: var(--fs-body);
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--text-bright);
}
.pname a:hover { color: var(--accent); }
td, th { height: 46px; }
tbody tr:hover { background: var(--surface-2); }
/* The leader's row on a ranked table carries a gold wash from the left. */
.lb--ranked tbody tr:first-child {
  background: linear-gradient(90deg, color-mix(in srgb, var(--rating) 10%, transparent), transparent 45%);
}
.lb--ranked tbody tr:first-child:hover {
  background: linear-gradient(90deg, color-mix(in srgb, var(--rating) 14%, transparent), var(--surface-2) 45%);
}
```

Replace the `.live__teamrow th, .live__teamrow td { ... }` rule with:

```css
.live__teamrow th,
.live__teamrow td {
  background: var(--surface-2);
  font-family: var(--font-label);
  font-size: var(--fs-label);
  font-weight: 500;
  letter-spacing: 0.18em;
  text-transform: uppercase;
  color: var(--text-muted);
  height: 34px;
  padding-top: 0;
  padding-bottom: 0;
}
```

- [ ] **Step 2: Mark the name cells and the ranked table**

In `web/src/components/StatTable.tsx`, the player cell `<td class="live__pcol"><PlayerLink .../></td>` becomes `<td class="live__pcol pname"><PlayerLink .../></td>`. The `Team total` cell stays as it is.

In `web/src/routes/Leaderboard.tsx`:
- `<div class="table-wrap lb">` becomes `<div class={\`table-wrap lb${sort.key === 'sr' && sort.desc ? ' lb--ranked' : ''}\`}>` so the wash only appears when the table is actually ranked by rating.
- `<td class="lb__pcol"><PlayerLink .../></td>` becomes `<td class="lb__pcol pname"><PlayerLink .../></td>`.
- The rank cell already zero-pads nothing; change `{i + 1}` to `{String(i + 1).padStart(2, '0')}` so the Anton column keeps one width.

In `web/src/routes/MapDetail.tsx` and `web/src/routes/Profile.tsx`, the `lb__pcol` cells that hold a `PlayerLink` or map link also get `pname`.

- [ ] **Step 3: Update the route test's rank expectation**

`routes.test.tsx` renders the leaderboard and looks for `alice`, `Season 1` and `1200`; none of those is a rank, so nothing there changes. Run the file to be sure:

Run: `npx vitest run web/src/routes/routes.test.tsx`
Expected: PASS.

- [ ] **Step 4: Full run and screenshots**

Run: `npm test && npm run typecheck && npm run shoot`
Expected: green. `leaderboard-1400.png`: ranks `01 02 03` in gold, names in Oswald caps, gold wash on row one, header `SR ▾` in gold. `match-9001-1400.png`: team rows as eyebrows.

- [ ] **Step 5: Commit**

```bash
git add web/src/styles/app.css web/src/components/StatTable.tsx web/src/routes/Leaderboard.tsx web/src/routes/MapDetail.tsx web/src/routes/Profile.tsx
git commit -m "feat(web): poster stat tables with Anton ranks and gold ratings"
```

---

### Task 6: Campaign tints and poster tiles

Spec 3.3 and 5.3. One function decides a campaign's color; the tile grid is a pure component the Play and Campaigns pages feed.

**Files:**
- Modify: `web/src/format.ts` (add `campaignTint`)
- Modify: `web/src/format.test.ts` (append tests)
- Create: `web/src/components/CampaignTiles.tsx`
- Create: `web/src/components/CampaignTiles.test.tsx`
- Modify: `web/src/styles/app.css` (add `.ctiles`, `.ctile*`; delete the four `[data-campaign=...]` selectors)
- Modify: `web/src/routes/Matches.tsx:65-66`, `web/src/routes/Profile.tsx:87-88`, `web/src/routes/Play.tsx:205` (inline `--campaign` from the helper)

**Interfaces:**
- Produces:
  - `campaignTint(slug: string): string` returns a CSS color string. Known slugs return `var(--c-<slug-with-dashes>)`; unknown slugs return an `oklch(0.42 0.06 <hue>)` string with hue derived from the slug.
  - `CampaignTiles({ items, onPick }: { items: CampaignTileItem[]; onPick?: (slug: string) => void })` where `CampaignTileItem = { slug: string; sub: string; active?: boolean; muted?: boolean }`. Renders `<button>`s when `onPick` is given, `<a href="/maps">`-free `<div>`s otherwise.

- [ ] **Step 1: Write the failing format tests**

Append to `web/src/format.test.ts`:

```ts
import { campaignTint } from './format';

describe('campaignTint', () => {
  it('returns the hand-picked token for the four L4D1 campaigns', () => {
    expect(campaignTint('no_mercy')).toBe('var(--c-no-mercy)');
    expect(campaignTint('death_toll')).toBe('var(--c-death-toll)');
    expect(campaignTint('dead_air')).toBe('var(--c-dead-air)');
    expect(campaignTint('blood_harvest')).toBe('var(--c-blood-harvest)');
  });

  it('gives an unknown campaign a stable oklch tint at the shared weight', () => {
    const a = campaignTint('crash_course');
    expect(a).toBe(campaignTint('crash_course'));
    expect(a).toMatch(/^oklch\(0\.42 0\.06 \d+(\.\d+)?\)$/);
  });

  it('spreads different unknown campaigns across different hues', () => {
    const hues = new Set(['crash_course', 'the_passing', 'suicide_blitz', 'dead_before_dawn']
      .map((s) => campaignTint(s).match(/ (\d+(\.\d+)?)\)$/)![1]));
    expect(hues.size).toBe(4);
  });
});
```

- [ ] **Step 2: Write the failing tiles test**

```tsx
// web/src/components/CampaignTiles.test.tsx
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, cleanup, screen, fireEvent } from '@testing-library/preact';
import { CampaignTiles } from './CampaignTiles';

afterEach(cleanup);

const ITEMS = [
  { slug: 'no_mercy', sub: '7 matches · last 1018 - 901' },
  { slug: 'death_toll', sub: '1 match · 412 - 289', active: true },
  { slug: 'crash_course', sub: 'Unplayed', muted: true },
];

describe('CampaignTiles', () => {
  it('names every campaign, known or not, and tints it', () => {
    const { container } = render(<CampaignTiles items={ITEMS} />);
    expect(screen.getByText('No Mercy')).toBeTruthy();
    expect(screen.getByText('crash_course')).toBeTruthy();
    const tiles = container.querySelectorAll('.ctile');
    expect(tiles).toHaveLength(3);
    expect((tiles[0] as HTMLElement).style.getPropertyValue('--campaign')).toBe('var(--c-no-mercy)');
    expect((tiles[2] as HTMLElement).style.getPropertyValue('--campaign')).toMatch(/^oklch/);
    expect(tiles[1].classList.contains('is-active')).toBe(true);
    expect(tiles[2].classList.contains('is-muted')).toBe(true);
  });

  it('is a row of buttons that report the slug when pickable', () => {
    const onPick = vi.fn();
    render(<CampaignTiles items={ITEMS} onPick={onPick} />);
    fireEvent.click(screen.getByRole('button', { name: /death toll/i }));
    expect(onPick).toHaveBeenCalledWith('death_toll');
  });

  it('renders no buttons when not pickable', () => {
    render(<CampaignTiles items={ITEMS} />);
    expect(screen.queryAllByRole('button')).toHaveLength(0);
  });
});
```

- [ ] **Step 3: Run both to verify they fail**

Run: `npx vitest run web/src/format.test.ts web/src/components/CampaignTiles.test.tsx`
Expected: FAIL. `campaignTint` is not exported; the tiles module does not exist.

- [ ] **Step 4: Implement campaignTint**

Add to `web/src/format.ts`, directly after `campaignName`:

```ts
/**
 * The color a campaign is tinted with, as a CSS color string.
 *
 * The four L4D1 campaigns keep their hand-picked tokens. Any other slug, and
 * custom campaigns are coming, hashes to a hue at a fixed chroma and
 * lightness, so a campaign the site has never seen still gets a tint at the
 * same visual weight as the originals, with no stylesheet edit. Deterministic
 * so the same campaign is the same color on every page and every visit.
 */
export function campaignTint(slug: string): string {
  if (slug in CAMPAIGN_NAMES) return `var(--c-${slug.replace(/_/g, '-')})`;
  // FNV-1a over the slug, then spread across the hue circle. Multiplying by
  // the golden angle keeps neighbouring hashes from landing on neighbouring
  // hues, so two custom campaigns added together still look distinct.
  let h = 0x811c9dc5;
  for (let i = 0; i < slug.length; i++) {
    h ^= slug.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  const hue = Math.round(((h % 360) * 137.508) % 360);
  return `oklch(0.42 0.06 ${hue})`;
}
```

- [ ] **Step 5: Write CampaignTiles**

```tsx
// web/src/components/CampaignTiles.tsx
import { campaignName, campaignTint } from '../format';

export interface CampaignTileItem {
  slug: string;
  /** The eyebrow line: match count and last score, or "Unplayed". */
  sub: string;
  /** The campaign in focus (being voted on, or the page's subject). */
  active?: boolean;
  /** Unplayed or unavailable: rendered at reduced opacity. */
  muted?: boolean;
}

/**
 * Campaigns as poster tiles: a dark gradient in the campaign's tint, a heavy
 * inset vignette, an eyebrow and the name in Anton at the bottom left.
 *
 * Pure: the callers decide which campaigns exist and what the eyebrow says.
 * With `onPick` the tiles are buttons (the campaign vote); without it they
 * are plain tiles (the Campaigns page).
 */
export function CampaignTiles(
  { items, onPick }: { items: CampaignTileItem[]; onPick?: (slug: string) => void },
) {
  return (
    <div class="ctiles">
      {items.map((it) => {
        const cls = `ctile${it.active ? ' is-active' : ''}${it.muted ? ' is-muted' : ''}`;
        const style = { '--campaign': campaignTint(it.slug) } as Record<string, string>;
        const body = (
          <>
            <span class="ctile__sub eyebrow">{it.sub}</span>
            <span class="ctile__name">{campaignName(it.slug)}</span>
          </>
        );
        return onPick
          ? <button type="button" class={cls} style={style} key={it.slug} onClick={() => onPick(it.slug)}>{body}</button>
          : <div class={cls} style={style} key={it.slug}>{body}</div>;
      })}
    </div>
  );
}
```

- [ ] **Step 6: Style the tiles and remove the attribute tints**

Append to app.css, after the `tables` section:

```css
/* ---------- campaign poster tiles ---------- */

.ctiles {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(11rem, 1fr));
  gap: var(--sp-4);
}
.ctile {
  position: relative;
  display: flex;
  flex-direction: column;
  justify-content: flex-end;
  align-items: flex-start;
  gap: var(--sp-1);
  min-height: 150px;
  padding: var(--sp-3) var(--sp-4);
  border: 1px solid var(--border-strong);
  background:
    linear-gradient(180deg, color-mix(in srgb, var(--campaign) 55%, var(--bg)) 0%, var(--bg) 100%);
  color: var(--text-bright);
  text-align: left;
  overflow: hidden;
  cursor: default;
  font: inherit;
}
.ctile::after {
  content: "";
  position: absolute;
  inset: 0;
  box-shadow: inset 0 0 60px rgba(0, 0, 0, 0.9);
  pointer-events: none;
}
.ctile > * { position: relative; z-index: 1; }
button.ctile { cursor: pointer; }
button.ctile:hover { border-color: var(--text-muted); }
.ctile.is-active { border-color: var(--rule); box-shadow: 0 0 0 1px var(--rule); }
.ctile.is-muted { opacity: 0.55; }
.ctile__sub { color: var(--rating); }
.ctile__name {
  font-family: var(--font-display);
  font-size: 1.875rem;
  line-height: 1;
  text-transform: uppercase;
  letter-spacing: 0.02em;
}
```

Delete these four lines from the `tables` section:

```css
[data-campaign='no_mercy'] { --campaign: var(--c-no-mercy); }
[data-campaign='death_toll'] { --campaign: var(--c-death-toll); }
[data-campaign='dead_air'] { --campaign: var(--c-dead-air); }
[data-campaign='blood_harvest'] { --campaign: var(--c-blood-harvest); }
```

- [ ] **Step 7: Feed `--campaign` from the helper at the three existing use sites**

`web/src/routes/Matches.tsx`: import `campaignTint` and change `<tr key={m.id} data-campaign={m.campaign}>` to `<tr key={m.id} style={{ '--campaign': campaignTint(m.campaign) } as Record<string, string>}>`.

`web/src/routes/Profile.tsx`: the same change on the recent-matches `<tr>`.

`web/src/routes/Play.tsx` `MapVote`: on the vote `<button>`, replace `data-campaign={c}` with `style={{ '--campaign': campaignTint(c) } as Record<string, string>}` and import `campaignTint`. (Task 9 replaces the vote list with tiles; this keeps the rule working until then.)

- [ ] **Step 8: Run tests, typecheck, screenshots**

Run: `npm test && npm run typecheck && npm run shoot`
Expected: green (six new tests). `matches-1400.png`: the left rule on each match row is still tinted.

- [ ] **Step 9: Commit**

```bash
git add web/src/format.ts web/src/format.test.ts web/src/components/CampaignTiles.tsx web/src/components/CampaignTiles.test.tsx web/src/styles/app.css web/src/routes/Matches.tsx web/src/routes/Profile.tsx web/src/routes/Play.tsx
git commit -m "feat(web): data-driven campaign tints and poster tiles"
```

---

### Task 7: Versus scoreboard header

Spec 5.4.

**Files:**
- Create: `web/src/components/VersusHeader.tsx`
- Create: `web/src/components/VersusHeader.test.tsx`
- Modify: `web/src/styles/app.css` (add `.versus*`)

**Interfaces:**
- Produces: `VersusHeader({ teamA, teamB, scoreA, scoreB, eyebrowA, eyebrowB, subline }: { teamA: string[]; teamB: string[]; scoreA: number; scoreB: number; eyebrowA?: string; eyebrowB?: string; subline?: ComponentChildren })`. Names are display strings; the caller resolves them. The higher score is gold, the lower is bright, a tie is both bright.

- [ ] **Step 1: Write the failing test**

```tsx
// web/src/components/VersusHeader.test.tsx
import { describe, it, expect, afterEach } from 'vitest';
import { render, cleanup, screen } from '@testing-library/preact';
import { VersusHeader } from './VersusHeader';

afterEach(cleanup);

describe('VersusHeader', () => {
  it('lists both rosters and colors the leading score gold', () => {
    render(
      <VersusHeader
        teamA={['volence', 'dev_0001']} teamB={['Vodka', 'zeppelin']}
        scoreA={412} scoreB={289}
        eyebrowA="Team A · survivors first" eyebrowB="Team B · infected first"
      />,
    );
    expect(screen.getByText('volence · dev_0001')).toBeTruthy();
    expect(screen.getByText('Vodka · zeppelin')).toBeTruthy();
    expect(screen.getByText('412').classList.contains('versus__score--lead')).toBe(true);
    expect(screen.getByText('289').classList.contains('versus__score--lead')).toBe(false);
    expect(screen.getByText('Team A · survivors first')).toBeTruthy();
  });

  it('marks neither score on a tie', () => {
    render(<VersusHeader teamA={['a']} teamB={['b']} scoreA={100} scoreB={100} />);
    for (const el of screen.getAllByText('100')) {
      expect(el.classList.contains('versus__score--lead')).toBe(false);
    }
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run web/src/components/VersusHeader.test.tsx`
Expected: FAIL, module not found.

- [ ] **Step 3: Write the component**

```tsx
// web/src/components/VersusHeader.tsx
import type { ComponentChildren } from 'preact';

/**
 * The versus scoreboard: Team A left, both scores centre in Anton at hero
 * size, Team B right. A faint teal wash on the left edge and red on the
 * right, the survivor and infected colors, over a hairline top and a red
 * rule beneath.
 *
 * Names are passed as strings so the same header serves the match page
 * (roster from match players) and the live page (roster from the live
 * payload) without knowing either shape.
 */
export function VersusHeader(
  { teamA, teamB, scoreA, scoreB, eyebrowA = 'Team A', eyebrowB = 'Team B', subline }: {
    teamA: string[];
    teamB: string[];
    scoreA: number;
    scoreB: number;
    eyebrowA?: string;
    eyebrowB?: string;
    subline?: ComponentChildren;
  },
) {
  const lead = (mine: number, theirs: number) => (mine > theirs ? ' versus__score--lead' : '');
  return (
    <section class="versus">
      <div class="versus__side">
        <p class="eyebrow versus__eyebrow--a">{eyebrowA}</p>
        <p class="versus__names">{teamA.join(' · ')}</p>
      </div>
      <div class="versus__scores num">
        <span class={`versus__score${lead(scoreA, scoreB)}`}>{scoreA}</span>
        <span class="versus__slash">/</span>
        <span class={`versus__score${lead(scoreB, scoreA)}`}>{scoreB}</span>
      </div>
      <div class="versus__side versus__side--b">
        <p class="eyebrow versus__eyebrow--b">{eyebrowB}</p>
        <p class="versus__names">{teamB.join(' · ')}</p>
      </div>
      {subline && <p class="versus__sub">{subline}</p>}
    </section>
  );
}
```

- [ ] **Step 4: Style it**

Append to app.css after the campaign tiles section:

```css
/* ---------- versus scoreboard ---------- */

.versus {
  display: grid;
  grid-template-columns: 1fr auto 1fr;
  align-items: center;
  gap: var(--sp-4);
  padding: var(--sp-4) var(--sp-5);
  border-top: 1px solid var(--border);
  border-bottom: 2px solid var(--rule);
  background: linear-gradient(90deg,
    color-mix(in srgb, var(--win) 8%, transparent),
    transparent 35%, transparent 65%,
    color-mix(in srgb, var(--rule) 14%, transparent));
}
.versus__side { min-width: 0; }
.versus__side--b { text-align: right; }
.versus__eyebrow--a { color: var(--win); margin: 0 0 var(--sp-1); }
.versus__eyebrow--b { color: var(--accent); margin: 0 0 var(--sp-1); }
.versus__names {
  margin: 0;
  font-family: var(--font-label);
  font-size: var(--fs-h3);
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--text-bright);
  overflow-wrap: anywhere;
}
.versus__scores { display: flex; align-items: baseline; justify-content: center; gap: var(--sp-3); }
.versus__score {
  font-family: var(--font-display);
  font-size: var(--fs-hero);
  line-height: 1;
  color: var(--text-bright);
  text-shadow: 0 3px 0 #2b0e0b;
}
.versus__score--lead { color: var(--rating); }
.versus__slash { font-family: var(--font-display); font-size: var(--fs-h2); color: var(--text-muted); }
.versus__sub { grid-column: 1 / -1; margin: 0; text-align: center; color: var(--text-muted); font-size: var(--fs-dense); }
@media (max-width: 760px) {
  .versus { grid-template-columns: 1fr; text-align: center; }
  .versus__side--b { text-align: center; }
}
```

- [ ] **Step 5: Run, then commit**

Run: `npx vitest run web/src/components/VersusHeader.test.tsx && npm run typecheck`
Expected: PASS (2 tests), typecheck clean. No screenshot yet: nothing mounts it until Tasks 10 and 13.

```bash
git add web/src/components/VersusHeader.tsx web/src/components/VersusHeader.test.tsx web/src/styles/app.css
git commit -m "feat(web): versus scoreboard header component"
```

---

### Task 8: Headliner card

Spec 5.5.

**Files:**
- Create: `web/src/components/Headliner.tsx`
- Create: `web/src/components/Headliner.test.tsx`
- Modify: `web/src/styles/app.css` (add `.headliner*`)

**Interfaces:**
- Produces: `Headliner({ eyebrow, name, rating, delta, stats, avatar }: { eyebrow: string; name: string; rating: number | null; delta?: number | null; stats: { label: string; value: string | number; tone?: 'win' | 'loss' }[]; avatar?: string | null })`. `rating: null` renders "Unrated" in place of the number.

- [ ] **Step 1: Write the failing test**

```tsx
// web/src/components/Headliner.test.tsx
import { describe, it, expect, afterEach } from 'vitest';
import { render, cleanup, screen } from '@testing-library/preact';
import { Headliner } from './Headliner';

afterEach(cleanup);

describe('Headliner', () => {
  it('shows the name, the gold rating, a signed delta and the small stats', () => {
    render(
      <Headliner
        eyebrow="Top rated" name="fake_11" rating={1151} delta={151}
        stats={[{ label: 'SI dmg / rd', value: 1125 }, { label: 'FF dealt', value: 153, tone: 'loss' }]}
      />,
    );
    expect(screen.getByText('fake_11')).toBeTruthy();
    expect(screen.getByText('1151').classList.contains('headliner__rating')).toBe(true);
    expect(screen.getByText('+151')).toBeTruthy();
    expect(screen.getByText('153').classList.contains('headliner__stat-value--loss')).toBe(true);
  });

  it('says Unrated when there is no rating', () => {
    render(<Headliner eyebrow="Rating" name="bob" rating={null} stats={[]} />);
    expect(screen.getByText(/unrated/i)).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run web/src/components/Headliner.test.tsx`
Expected: FAIL, module not found.

- [ ] **Step 3: Write the component**

```tsx
// web/src/components/Headliner.tsx
import { fmtDelta, deltaClass } from '../format';

/**
 * The rating hero: eyebrow, name in Anton, rating in gold Anton at hero size
 * with a season delta beside it, then a small grid of eyebrowed numbers.
 * The profile's hero and the leaderboard's side card are this one shape.
 */
export function Headliner(
  { eyebrow, name, rating, delta, stats, avatar }: {
    eyebrow: string;
    name: string;
    rating: number | null;
    delta?: number | null;
    stats: { label: string; value: string | number; tone?: 'win' | 'loss' }[];
    avatar?: string | null;
  },
) {
  return (
    <section class="panel headliner">
      {avatar && <img class="headliner__avatar" src={avatar} alt="" />}
      <p class="eyebrow headliner__eyebrow">{eyebrow}</p>
      <h2 class="headliner__name">{name}</h2>
      <div class="headliner__row">
        {rating === null
          ? <span class="headliner__unrated">Unrated this season</span>
          : <span class="headliner__rating num">{rating}</span>}
        {delta !== undefined && delta !== null && (
          <span class={`${deltaClass(delta)} headliner__delta`}>{fmtDelta(delta)}</span>
        )}
      </div>
      {stats.length > 0 && (
        <div class="headliner__stats">
          {stats.map((s) => (
            <div key={s.label}>
              <p class="eyebrow">{s.label}</p>
              <p class={`headliner__stat-value num${s.tone ? ` headliner__stat-value--${s.tone}` : ''}`}>{s.value}</p>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
```

- [ ] **Step 4: Style it**

Append to app.css after the versus section:

```css
/* ---------- headliner ---------- */

.headliner { position: relative; background: color-mix(in srgb, var(--bg) 35%, var(--surface)); }
.headliner__avatar { position: absolute; top: var(--sp-5); right: var(--sp-5); width: 56px; height: 56px; object-fit: cover; }
.headliner__eyebrow { margin: 0; color: var(--rating); }
.headliner__name { font-size: var(--fs-h1); margin-top: var(--sp-1); }
.headliner__row { display: flex; align-items: baseline; gap: var(--sp-3); margin-top: var(--sp-2); }
.headliner__rating {
  font-family: var(--font-display);
  font-size: var(--fs-hero);
  line-height: 1;
  color: var(--rating);
  text-shadow: 0 3px 0 #2b0e0b;
}
.headliner__unrated { color: var(--text-muted); font-size: var(--fs-dense); }
.headliner__delta { align-self: center; }
.headliner__stats { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: var(--sp-3); margin-top: var(--sp-4); }
.headliner__stats p { margin: 0; }
.headliner__stat-value { font-family: var(--font-display); font-size: var(--fs-h3); line-height: 1.1; color: var(--text-bright); }
.headliner__stat-value--win { color: var(--win); }
.headliner__stat-value--loss { color: var(--loss); }
```

- [ ] **Step 5: Run, then commit**

Run: `npx vitest run web/src/components/Headliner.test.tsx && npm run typecheck`
Expected: PASS (2 tests), typecheck clean.

```bash
git add web/src/components/Headliner.tsx web/src/components/Headliner.test.tsx web/src/styles/app.css
git commit -m "feat(web): headliner rating card component"
```

---

## Step 4: pages

One task per route. Each swaps the old `.page__head` div and the `Tiles` row for `PageHeader` with `Figures`, mounts the new components where the spec puts them, and leaves every data computation exactly as it is. `Tile`/`Tiles` are deleted only in Task 19, so a page not yet migrated keeps working.

Shared pattern, shown once here and repeated in each task where it applies:

```tsx
import { PageHeader, Figures, Figure } from '../components/PageHeader';
```

### Task 9: Play

Spec 6, Play. Header for the whole flow, the vote as poster tiles.

**Files:**
- Modify: `web/src/routes/Play.tsx`
- Modify: `web/src/styles/app.css` (`play: campaign vote` section: delete `.votes`, `.vote*`)

- [ ] **Step 1: Header and vote tiles**

In `Play()`, wrap the flow in a header:

```tsx
  const wide = state.match !== null;
  return (
    <div class={`page ${wide ? 'page--play-teams' : 'page--play'}`}>
      <PageHeader eyebrow="Riverside" title="Ranked 4v4" />
      <Live state={state} me={session.me.steamid} refresh={refresh} />
    </div>
  );
```

Replace the body of `MapVote` from `<div class="votes">` through its closing `</div>` with:

```tsx
      <CampaignTiles
        onPick={(c) => api.vote(c).catch(() => {}).then(refresh)}
        items={lobby.options.map((c) => {
          const n = lobby.votes[c] ?? 0;
          const leading = n > 0 && n === leader;
          return {
            slug: c,
            sub: n === 0 ? 'No votes' : `${n} vote${n === 1 ? '' : 's'}${leading ? ' · leading' : ''}`,
            active: lobby.myVote === c,
          };
        })}
      />
```

Import `CampaignTiles` from `../components/CampaignTiles` and drop the now-unused `campaignTint` import added in Task 6. `SignIn` keeps its hero panel but its `<p class="eyebrow">Left 4 Dead</p>` becomes `Riverside`. In `Live()`'s match view, the two `<h3>Team {label}</h3>` stay (the test asserts `Team A` and `Team B`).

- [ ] **Step 2: Remove the vote list styles**

Delete the `.votes`, `.vote`, `.vote:hover`, `.vote--mine`, `.vote--leading .vote__name`, `.vote__name, .vote__count`, `.vote__count` and `.vote__bar` rules from app.css.

- [ ] **Step 3: Run tests, typecheck, screenshots**

Run: `npm test && npm run typecheck && npm run shoot`
Expected: green. The Play tests still find `/join queue/i`, `3`, `/match found/i`, `bob`, `No Mercy`, `Team A`, `Team B`. `home-1400.png` shows the header over the sign-in panel.

- [ ] **Step 4: Commit**

```bash
git add web/src/routes/Play.tsx web/src/styles/app.css
git commit -m "feat(web): poster header on Play and the campaign vote as tiles"
```

---

### Task 10: Live

Spec 6, Live.

**Files:**
- Modify: `web/src/routes/Live.tsx`
- Modify: `web/src/styles/app.css` (`.live__head`, `.live__teams` unchanged; `.replay__live` handled in Task 20)

- [ ] **Step 1: Header and scoreboard**

Replace the `<div class="page__head">...</div>` in `Live()` with `<PageHeader eyebrow="Right now" title="Live" />`.

In `LiveCard`, replace the `<Tiles>...</Tiles>` block and the `<div class="live__head">...</div>` block with:

```tsx
      <VersusHeader
        teamA={m.teamA.map((p) => p.name)}
        teamB={m.teamB.map((p) => p.name)}
        scoreA={m.teamAScore}
        scoreB={m.teamBScore}
        subline={
          <>
            {campaignName(m.campaign)} · {m.currentMap ?? 'starting up'} · map {m.maps.length + 1}
            {m.stale && <span class="live__stale"> · no signal</span>}
            {' · '}<a href={`/match/${m.id}`}>#{m.id}</a>
          </>
        }
      />
```

Move the `<Viewer .../>` line to directly after the `VersusHeader` so the scoreboard sits above the map. Import `VersusHeader` from `../components/VersusHeader`; remove the `Tile, Tiles` imports.

- [ ] **Step 2: Run, screenshot, commit**

Run: `npm test && npm run typecheck && npm run shoot`
Expected: green. `live-1400.png` shows the header and the empty state (no live match locally).

```bash
git add web/src/routes/Live.tsx
git commit -m "feat(web): versus scoreboard on the live page"
```

---

### Task 11: Leaderboard

Spec 6, Leaderboard: table left, headliner right.

**Files:**
- Modify: `web/src/routes/Leaderboard.tsx`
- Modify: `web/src/routes/routes.test.tsx:76-78` (duplicates)
- Modify: `web/src/styles/app.css` (add `.lb-layout`)

- [ ] **Step 1: Loosen the two assertions that will see duplicates**

The top player's name and rating now appear in the table and in the headliner. In `routes.test.tsx`, in the leaderboard test at lines 76 to 78:

```ts
    await waitFor(() => expect(screen.getAllByText('alice').length).toBeGreaterThan(0));
    expect(screen.getByText('Season 1')).toBeTruthy();
    expect(screen.getAllByText('1200').length).toBeGreaterThan(0);
```

- [ ] **Step 2: Header, figures, layout**

Replace the `<div class="page__head">...</div>` and the `{rows.length > 0 && (<Tiles>...</Tiles>)}` block with:

```tsx
      <PageHeader title="Leaderboard" aside={data ? data.season.name : undefined}>
        {rows.length > 0 && (
          <Figures>
            <Figure label="Players" value={rows.length} />
            <Figure label="Matches rated" value={Math.max(...rows.map((r) => r.games))} />
            {totals.tank_damage ? <Figure label="Tank damage" value={totals.tank_damage} /> : null}
            {totals.skeets ? <Figure label="Skeets" value={totals.skeets} /> : null}
            {totals.boomer_rate !== undefined
              ? <Figure label="Boomer %" value={`${totals.boomer_rate}%`} sub="everyone" />
              : null}
          </Figures>
        )}
      </PageHeader>
```

The season name used to be a `<span class="eyebrow">`; the aside is styled the same, so `Season 1` still appears exactly once.

Wrap the table panel and a headliner in a two-column layout. The headliner is the top row by SR regardless of the current sort:

```tsx
      <div class="lb-layout">
        <Panel class="panel--table">
          {/* existing error / loading / empty / table branches, unchanged */}
        </Panel>
        {rows.length > 0 && (() => {
          const top = [...rows].sort((a, b) => b.sr - a.sr)[0];
          const decided = top.wins + top.losses;
          return (
            <Headliner
              eyebrow="Top rated"
              name={top.name}
              rating={top.sr}
              stats={[
                { label: 'Record', value: `${top.wins}W ${top.losses}L` },
                { label: 'Win %', value: decided > 0 ? `${Math.round((top.wins / decided) * 100)}%` : 'n/a' },
                { label: 'Games', value: top.games },
              ]}
            />
          );
        })()}
      </div>
```

Import `Headliner` from `../components/Headliner`; remove `Tile, Tiles` from the bits import.

Add to app.css after `.page--match`:

```css
.lb-layout { display: grid; grid-template-columns: minmax(0, 1fr) 320px; gap: var(--sp-5); align-items: start; }
@media (max-width: 960px) { .lb-layout { grid-template-columns: 1fr; } }
```

and change `.page--list { max-width: 880px; }` to `1120px` so the two columns fit.

- [ ] **Step 3: Run, screenshot, commit**

Run: `npm test && npm run typecheck && npm run shoot`
Expected: green. `leaderboard-1400.png` matches the canvas: table left, gold headliner right. `leaderboard-390.png`: single column, headliner below the table.

```bash
git add web/src/routes/Leaderboard.tsx web/src/routes/routes.test.tsx web/src/styles/app.css
git commit -m "feat(web): leaderboard with poster header and top-rated headliner"
```

---

### Task 12: Matches

**Files:**
- Modify: `web/src/routes/Matches.tsx`

- [ ] **Step 1: Header with figures**

Replace the `<div class="page__head">` and the whole `{data && data.matches.length > 0 && (() => { ... })()}` tile block with:

```tsx
      <PageHeader title="Recent matches">
        {data && data.matches.length > 0 && (() => {
          const n = data.matches.length;
          const campaigns = new Set(data.matches.map((m) => m.campaign));
          // Deliberately not "Team A wins". a and b are labels reassigned every
          // match, so a win rate under them aggregates different people each time
          // and describes nobody. Margin is a property of the match itself, so it
          // stays true however the sides were labelled.
          const margin = (m: typeof data.matches[number]) => Math.abs(m.teamAScore - m.teamBScore);
          const avgMargin = Math.round(data.matches.reduce((sum, m) => sum + margin(m), 0) / n);
          const closest = data.matches.reduce((best, m) => (margin(m) < margin(best) ? m : best));
          const widest = data.matches.reduce((best, m) => (margin(m) > margin(best) ? m : best));
          return (
            <Figures>
              <Figure label="Matches" value={n} />
              <Figure label="Campaigns" value={campaigns.size} />
              <Figure label="Avg margin" value={avgMargin} />
              <Figure label="Closest" value={`${closest.teamAScore} - ${closest.teamBScore}`} sub={campaignName(closest.campaign)} />
              <Figure label="Widest" value={`${widest.teamAScore} - ${widest.teamBScore}`} sub={campaignName(widest.campaign)} />
            </Figures>
          );
        })()}
      </PageHeader>
```

Remove `Tile, Tiles` from the imports. The campaign name cell keeps `pname`-free styling (it is a campaign, not a player).

- [ ] **Step 2: Run, screenshot, commit**

Run: `npm test && npm run typecheck && npm run shoot`
Expected: green; `Matches`, `Avg margin`, `200` each appear once.

```bash
git add web/src/routes/Matches.tsx
git commit -m "feat(web): matches page header figures"
```

---

### Task 13: Match detail

Spec 6, Match detail: versus header replaces the score block and the stat cards.

**Files:**
- Modify: `web/src/routes/MatchDetail.tsx`
- Modify: `web/src/styles/app.css` (delete `.scoreline*`)

- [ ] **Step 1: Header and scoreboard**

Replace the `<div class="page__head">...</div>` and the `{headlineCards.length > 0 && (<Tiles>...</Tiles>)}` block with:

```tsx
      <PageHeader
        eyebrow={`Match #${match.id} · ${winnerLabel(match.winner)} · ${fmtDate(match.endedAt)}`}
        title={campaignName(match.campaign)}
      >
        {headlineCards.length > 0 && (
          <Figures>
            {headlineCards.map((c) => (
              <Figure key={c.label} label={c.label} value={`${c.a ?? 'n/a'} - ${c.b ?? 'n/a'}`} sub={c.sub} />
            ))}
          </Figures>
        )}
      </PageHeader>

      <VersusHeader
        teamA={teamPlayers('a').map((p) => p.name)}
        teamB={teamPlayers('b').map((p) => p.name)}
        scoreA={match.teamAScore}
        scoreB={match.teamBScore}
      />
```

Then wrap the existing `<div class="stack">` so the versus header has a gap beneath it: add `style={{ marginTop: 'var(--sp-5)' }}` to that div, or better, add `.versus + .stack { margin-top: var(--sp-5); }` to app.css after the versus section.

In `MapReplay`, the two round buttons become chips: `class={\`chip ${half === 1 ? 'is-on' : ''}\`}` and likewise for round 2.

Import `VersusHeader`; remove `Tile, Tiles`. Delete `.scoreline`, `.scoreline__score` and `.match-id` from app.css only if `match-id` is no longer referenced (Matches.tsx still uses `match-id`; keep that one rule).

- [ ] **Step 2: Run, screenshot, commit**

Run: `npm test && npm run typecheck && npm run shoot`
Expected: green. The match tests still find `Match totals`, `Round 1`, `1699 - n/a`, `Team A` (now in the versus eyebrow and the table team rows; both tests use `getAllByText`). `match-9001-1400.png` shows header, scoreboard, totals, then the two map panels with their viewers.

```bash
git add web/src/routes/MatchDetail.tsx web/src/styles/app.css
git commit -m "feat(web): match page with versus scoreboard and header figures"
```

---

### Task 14: Campaigns (the maps route)

**Files:**
- Modify: `web/src/routes/Maps.tsx`

- [ ] **Step 1: Header, tiles, per-campaign panels**

Replace the `<div class="page__head"><h2>Maps</h2></div>` and the `<Tiles>...</Tiles>` block with:

```tsx
      <PageHeader title="Campaigns">
        {maps.length > 0 && (
          <Figures>
            <Figure label="Maps played" value={maps.length} />
            <Figure label="Campaigns" value={[...groups.keys()].filter((k) => k !== 'other').length} />
            <Figure
              label="Most played"
              value={maps.reduce((a, b) => (b.played > a.played ? b : a)).played}
              sub={maps.reduce((a, b) => (b.played > a.played ? b : a)).map}
            />
          </Figures>
        )}
      </PageHeader>

      {maps.length > 0 && (
        <CampaignTiles
          items={[...groups.entries()]
            .filter(([slug]) => slug !== 'other')
            .map(([slug, rows]) => {
              const played = rows.reduce((n, m) => n + m.played, 0);
              return {
                slug,
                sub: played === 0 ? 'Unplayed' : `${rows.length} map${rows.length === 1 ? '' : 's'} · ${played} played`,
                muted: played === 0,
              };
            })}
        />
      )}
```

Keep the per-campaign `<Panel class="panel--table">` list beneath, and give the `.stack` a top margin by adding `.ctiles + .stack { margin-top: var(--sp-5); }` to app.css. Import `CampaignTiles`; remove `Tile, Tiles`. Note the `PageHeader` must render before the `maps.length === 0` branch, so restructure the return as header, then either the empty panel or the tiles and stack.

- [ ] **Step 2: Run, screenshot, commit**

Run: `npm test && npm run typecheck && npm run shoot`
Expected: green. `campaigns-1400.png` shows Death Toll and No Mercy tiles (the seeded data has only those, the `Other` group is tables only).

```bash
git add web/src/routes/Maps.tsx web/src/styles/app.css
git commit -m "feat(web): campaigns page with poster tiles"
```

---

### Task 15: Map detail

**Files:**
- Modify: `web/src/routes/MapDetail.tsx`

- [ ] **Step 1: Header with figures**

Replace the `<div class="page__head">...</div>` and `<Tiles>...</Tiles>` with:

```tsx
      <PageHeader eyebrow="Map" title={data.map}>
        <Figures>
          <Figure label="Played" value={data.played} />
          <Figure label="Avg score" value={`${data.avgTeamA} - ${data.avgTeamB}`} sub="A vs B" />
          <Figure label="Players" value={players.length} />
        </Figures>
      </PageHeader>
```

Remove `Tile, Tiles` from the import.

- [ ] **Step 2: Run, screenshot, commit**

Run: `npm test && npm run typecheck && npm run shoot`

```bash
git add web/src/routes/MapDetail.tsx
git commit -m "feat(web): map detail header figures"
```

---

### Task 16: Replays

**Files:**
- Modify: `web/src/routes/Replays.tsx`

- [ ] **Step 1: Header with figures**

Replace `<div class="page__head"><h2>Replays</h2></div>` and the `<Tiles>...</Tiles>` block with:

```tsx
      <PageHeader title="Replays">
        {sessions.length > 0 && (
          <Figures>
            <Figure label="Sessions" value={sessions.length} />
            <Figure label="Rounds" value={files} />
          </Figures>
        )}
      </PageHeader>
```

As in Task 14, the header renders before the empty-state branch. Remove `Tile, Tiles`.

- [ ] **Step 2: Run, screenshot, commit**

```bash
git add web/src/routes/Replays.tsx
git commit -m "feat(web): replays page header figures"
```

---

### Task 17: Replay page

**Files:**
- Modify: `web/src/routes/ReplayPage.tsx`

- [ ] **Step 1: Header**

```tsx
import { PageHeader } from '../components/PageHeader';
import { Viewer } from '../replay/Viewer';

export function ReplayPage({ name }: { name: string }) {
  const file = decodeURIComponent(name);
  return (
    <div class="page page--match">
      <PageHeader eyebrow={file} title="Replay" />
      <Viewer spec={{ kind: 'file', name: file }} />
    </div>
  );
}
```

- [ ] **Step 2: Run, commit**

Run: `npm test && npm run typecheck`

```bash
git add web/src/routes/ReplayPage.tsx
git commit -m "feat(web): replay page header"
```

---

### Task 18: Profile

Spec 6, Profile: the headliner is the hero.

**Files:**
- Modify: `web/src/routes/Profile.tsx`
- Modify: `web/src/styles/app.css` (delete `.profile-head*`, `.avatar*`, `.rating-line`)

- [ ] **Step 1: Hero and figures**

Replace the `<Panel class="profile-head">...</Panel>` block with:

```tsx
        <Headliner
          eyebrow={`Joined ${fmtDate(player.createdAt)}`}
          name={player.name}
          avatar={player.avatar}
          rating={rating ? rating.sr : null}
          delta={lastDelta}
          stats={rating ? [
            { label: 'Record', value: `${rating.wins}W ${rating.losses}L` },
            { label: 'Peak', value: peak ?? 'n/a' },
            { label: 'Matches', value: totals.games },
          ] : []}
        />
```

Replace `<ProfileTiles totals={totals} statTotals={statTotals} rating={rating} />` with `<ProfileFigures totals={totals} statTotals={statTotals} rating={rating} />` and rewrite that helper's return to:

```tsx
  return (
    <Panel>
      <Figures>
        {tiles.map((t) => <Figure key={t.label} label={t.label} value={t.value} sub={t.sub} />)}
      </Figures>
    </Panel>
  );
```

renaming the function `ProfileFigures`. Import `Headliner` and `Figures, Figure`; remove `Tile, Tiles, SrDelta` if `SrDelta` is now unused in the file (it is still used in the recent-matches table, so keep it). The `+12` delta appears twice: once in the headliner, once in the table row, which is what the test expects.

Delete from app.css: `.profile-head`, `.profile-head__id`, `.profile-head__rating`, `.avatar`, `.avatar--blank`, `.rating-line`.

- [ ] **Step 2: Run, screenshot, commit**

Run: `npm test && npm run typecheck && npm run shoot`
Expected: green; profile tests find `alice` and `1200` once each and `+12` twice.

```bash
git add web/src/routes/Profile.tsx web/src/styles/app.css
git commit -m "feat(web): profile hero as the headliner card"
```

---

### Task 19: Remove the stat-card vocabulary

Spec 4.2. Every route has migrated; the old shapes go.

**Files:**
- Modify: `web/src/components/bits.tsx` (delete `Tile`, `Tiles`)
- Modify: `web/src/styles/app.css` (delete `.tiles`, `.tile*`, `.page__head`, `.hero-panel .btn` stays)

- [ ] **Step 1: Prove nothing references them**

Run: `grep -rn "Tile\b\|Tiles\b\|page__head\|data-campaign" web/src --include='*.tsx' --include='*.ts' --include='*.css'`
Expected: only the definitions in `bits.tsx` and the CSS rules. If a route still imports them, that route's task was incomplete: fix it there first.

- [ ] **Step 2: Delete**

Remove the `Tile` and `Tiles` functions from `bits.tsx`. Remove the `.tiles`, `.tile`, `.tile__label`, `.tile__value`, `.tile__sub` rules and any leftover `.page__head` rule from app.css.

- [ ] **Step 3: Run, screenshot, commit**

Run: `npm test && npm run typecheck && npm run shoot`
Expected: green; screenshots unchanged from Task 18.

```bash
git add web/src/components/bits.tsx web/src/styles/app.css
git commit -m "refactor(web): remove the stat card component and styles"
```

---

## Step 5: replay viewer

Spec 7. The canvas math and the playback loop are untouched; every change here is chrome around the canvas or the color of chrome the canvas paints.

### Task 20: Stage frame and HUD overlay

**Files:**
- Create: `web/src/replay/ReplayHud.tsx`
- Create: `web/src/replay/ReplayHud.test.tsx`
- Modify: `web/src/replay/Viewer.tsx` (stage markup, status line removed)
- Modify: `web/src/replay/ReplayControls.tsx` (toggle row removed, `.replay__btn` becomes `.chip`)
- Modify: `web/src/styles/app.css` (replay section)

**Interfaces:**
- Produces: `ReplayHud({ tMs, endMs, counts, live, closed, toggles, toggle }: { tMs: number; endMs: number; counts: { survivors: number; commons: number; specials: number }; live: boolean; closed: boolean; toggles: Toggles; toggle: (k: keyof Toggles) => void })`, rendered inside `.replay__frame`, absolutely positioned.
- `ReplayControls` loses its toggle row and the `toggles`/`toggle` props that fed it; the interface after this task is `{ playback, endMs, live, followSlot, setFollowSlot, slots, names }` plus the optional `timeline` Task 21 adds.

- [ ] **Step 1: Write the failing ReplayHud test**

```tsx
// web/src/replay/ReplayHud.test.tsx
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, cleanup, screen, fireEvent } from '@testing-library/preact';
import { ReplayHud } from './ReplayHud';
import { DEFAULT_TOGGLES } from './useToggles';

afterEach(cleanup);

describe('ReplayHud', () => {
  it('shows the clock, the counts and one chip per toggle', () => {
    const toggle = vi.fn();
    render(
      <ReplayHud
        tMs={6000} endMs={69000}
        counts={{ survivors: 4, commons: 14, specials: 3 }}
        live={false} closed
        toggles={DEFAULT_TOGGLES} toggle={toggle}
      />,
    );
    expect(screen.getByText('0:06')).toBeTruthy();
    expect(screen.getByText('of 1:09')).toBeTruthy();
    expect(screen.getByText('4 alive · 14 common · 3 special')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Guns' }));
    expect(toggle).toHaveBeenCalledWith('guns');
    expect(screen.getByRole('button', { name: 'HP' }).classList.contains('is-on')).toBe(true);
    expect(screen.getByRole('button', { name: 'Guns' }).classList.contains('is-on')).toBe(false);
  });

  it('flags a live, still-recording round', () => {
    render(
      <ReplayHud tMs={0} endMs={0} counts={{ survivors: 0, commons: 0, specials: 0 }}
        live closed={false} toggles={DEFAULT_TOGGLES} toggle={() => {}} />,
    );
    expect(screen.getByText(/live, 10s delayed/i)).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run web/src/replay/ReplayHud.test.tsx`
Expected: FAIL, module not found.

- [ ] **Step 3: Write ReplayHud**

```tsx
// web/src/replay/ReplayHud.tsx
import { formatTime } from './ReplayControls';
import type { Toggles } from './useToggles';

const TOGGLE_LABELS: [keyof Toggles, string][] = [
  ['hp', 'HP'], ['names', 'Names'], ['guns', 'Guns'], ['events', 'Events'],
  ['chat', 'Chat'], ['ci', 'CI'], ['entities', 'Ents'],
];

/**
 * The overlay drawn over the stage: the clock and the alive counts top left,
 * the toggle chips top right, the live flag beneath the clock. What used to
 * be a status line under the canvas and a toggle row above the follow row.
 * Purely presentational, like ReplayControls.
 */
export function ReplayHud(
  { tMs, endMs, counts, live, closed, toggles, toggle }: {
    tMs: number;
    endMs: number;
    counts: { survivors: number; commons: number; specials: number };
    live: boolean;
    closed: boolean;
    toggles: Toggles;
    toggle: (k: keyof Toggles) => void;
  },
) {
  return (
    <div class="rhud">
      <div class="rhud__left">
        <span class="rhud__time num">{formatTime(tMs)}</span>
        <span class="rhud__of eyebrow">of {formatTime(endMs)}</span>
        <span class="rhud__counts eyebrow">
          {counts.survivors} alive · {counts.commons} common · {counts.specials} special
        </span>
        {live && !closed && <span class="rhud__live eyebrow">Live, 10s delayed</span>}
      </div>
      <div class="rhud__right">
        {TOGGLE_LABELS.map(([k, label]) => (
          <button key={k} type="button" class={`chip${toggles[k] ? ' is-on' : ''}`} onClick={() => toggle(k)}>
            {label}
          </button>
        ))}
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Mount it in the Viewer and frame the stage**

In `web/src/replay/Viewer.tsx`, import `ReplayHud` and replace the returned `<div class="replay">` block with:

```tsx
  return (
    <div class="replay">
      <div class="replay__frame">
        <div class="replay__sprocket replay__sprocket--l" aria-hidden="true" />
        <div class="replay__stage" ref={stageRef} style={stageStyle}>
          <ReplayCanvas
            transform={transform}
            view={view}
            size={size}
            backdrop={backdrop}
            trail={trail}
            frames={frames}
            timeRef={playback.tRef}
            show={show}
            followSlot={followSlot}
            names={names}
            slots={header.slots}
          />
          <div class="replay__vignette" aria-hidden="true" />
          <ReplayHud
            tMs={playback.tMs}
            endMs={endMs}
            counts={counts}
            live={live}
            closed={closed}
            toggles={toggles}
            toggle={toggle}
          />
        </div>
        <div class="replay__sprocket replay__sprocket--r" aria-hidden="true" />
      </div>

      {timeline && (toggles.events || toggles.chat) && (
        <TimelineRail
          timeline={timeline}
          tMs={playback.tMs}
          toggles={toggles}
          seek={playback.seek}
          names={names}
        />
      )}

      <ReplayControls
        playback={playback}
        endMs={endMs}
        live={live}
        followSlot={followSlot}
        setFollowSlot={setFollowSlot}
        slots={header.slots}
        names={names}
      />

      <HudStrip
        players={livePlayers}
        header={header}
        names={names}
        showHp={toggles.hp}
        showGuns={toggles.guns}
      />
    </div>
  );
```

The `replay__status` div is gone; `header.map` is already in the page heading above each viewer. The stage keeps its `ref`, inline `aspectRatio` and `maxWidth`, so `useCanvasSize` measures exactly the same element it did before, and the canvas is still its only sized child. The overlay and vignette are absolutely positioned and do not affect layout.

In `ReplayControls.tsx`: delete the middle `<div class="replay__toolbar">` that maps `TOGGLE_LABELS` and delete the `TOGGLE_LABELS` constant; change every `class="replay__btn"` and `` class={`replay__btn ${...}`} `` to `chip`, including `replay__btn--slot` which becomes `chip chip--slot`. Remove `toggles` and `toggle` from `ReplayControlsProps` and from the destructuring; the Viewer snippet above no longer passes them. Drop the now-unused `Toggles` import.

- [ ] **Step 5: Restyle the replay section**

In app.css, replace from `/* Replay viewer. */` through the `.replay__slot-name` rule with:

```css
/* ---------- replay viewer ---------- */

.replay { display: flex; flex-direction: column; gap: var(--sp-3); }

/* The film frame: sprocket bands either side of the stage. The stage owns
   the shape (inline aspect-ratio and max-width from the map's content box);
   the frame just wraps it. */
.replay__frame { display: flex; justify-content: center; background: #050403; border-top: 3px solid #1a1512; border-bottom: 3px solid #1a1512; }
.replay__sprocket {
  flex: none;
  width: 26px;
  background:
    repeating-linear-gradient(180deg, transparent 0 10px, #0b0908 10px 22px, transparent 22px 34px),
    #1a1512;
  position: relative;
}
.replay__sprocket::before {
  content: "";
  position: absolute;
  left: 7px; right: 7px; top: 0; bottom: 0;
  background: repeating-linear-gradient(180deg, #2b241f 0 10px, transparent 10px 22px, #2b241f 22px 34px);
}
.replay__stage { position: relative; width: 100%; }
.replay__canvas { display: block; width: 100%; height: 100%; background: var(--bg); }
/* Lighter than the poster mockup on purpose: infected rings must keep their
   contrast against the art. */
.replay__vignette { position: absolute; inset: 0; box-shadow: inset 0 0 110px rgba(0, 0, 0, 0.8); pointer-events: none; }

/* HUD overlay inside the stage. */
.rhud { position: absolute; inset: 0; display: flex; justify-content: space-between; align-items: flex-start; padding: var(--sp-3); pointer-events: none; }
.rhud__left { display: flex; flex-wrap: wrap; align-items: baseline; gap: var(--sp-3); }
.rhud__time { font-family: var(--font-display); font-size: 2.5rem; line-height: 1; color: var(--text-bright); text-shadow: 0 3px 0 #000; }
.rhud__of { color: var(--text); }
.rhud__counts { color: var(--win); }
.rhud__live { color: var(--accent); flex-basis: 100%; }
.rhud__right { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: var(--sp-1); pointer-events: auto; }
.rhud .chip { min-height: 28px; padding: 2px var(--sp-2); background: rgba(21, 17, 14, 0.85); }
@media (max-width: 640px) { .rhud__time { font-size: 1.75rem; } .rhud .chip { min-height: 32px; } }

.replay--empty { padding: 2rem; text-align: center; color: var(--text-muted); }
.replay__controls, .replay__toolbar, .replay__rounds { display: flex; gap: var(--sp-2); align-items: center; flex-wrap: wrap; }
.replay__scrub { flex: 1 1 200px; }
.replay__time { font-family: var(--font-label); font-variant-numeric: tabular-nums; font-size: var(--fs-dense); color: var(--text-muted); letter-spacing: 0.08em; }
.chip--slot { gap: 0.35rem; }
/* Inherits the chip's inline slot colour. A 0.6rem dot is a graphical
   object, so the 3:1 floor applies to it and the darkest slot clears it at
   3.5:1; the label beside it is text and goes back to --text. */
.replay__swatch { width: 0.6rem; height: 0.6rem; border-radius: 50%; background: currentColor; flex: none; }
.replay__slot-name { color: var(--text); }
.chip--slot.is-on { border-color: currentColor; }
```

Delete the old `.replay__status`, `.replay__live` and `.replay__btn*` rules (the chip rule from Task 4 still lists `.replay__btn` as a selector; remove it from that list too).

- [ ] **Step 6: Fix the render-rate test if it counts toggle buttons**

Run: `npx vitest run web/src/replay`
Expected: the new test passes; `renderRate.test.tsx` and `useCanvasSize.test.tsx` still pass because they mount `ReplayCanvas` and `useCanvasSize` directly, not the Viewer. If any replay test fails on a missing `.replay__status` or a removed prop, update the assertion to the new markup rather than restoring the old.

- [ ] **Step 7: Full run, screenshots, commit**

Run: `npm test && npm run typecheck && npm run shoot`
Expected: green. `match-9001-1400.png`: both viewers framed by sprockets, clock and counts top left inside the frame, toggle chips top right. Confirm on `match-9001-390.png` that the chips wrap rather than overflow.

```bash
git add web/src/replay/ReplayHud.tsx web/src/replay/ReplayHud.test.tsx web/src/replay/Viewer.tsx web/src/replay/ReplayControls.tsx web/src/styles/app.css
git commit -m "feat(replay): film frame around the stage with the HUD readout inside it"
```

---

### Task 21: Filmstrip scrub with event ticks

Spec 7, scrub. The range input stays the control; a tick layer is drawn over it from the timeline. Event ticks are red and chat ticks muted: the server sends `team: null` for events, so kind is the only signal the data carries today.

**Files:**
- Modify: `web/src/replay/ReplayControls.tsx` (add `timeline?: TimelineEntry[]`, render ticks)
- Modify: `web/src/replay/Viewer.tsx` (pass `timeline`)
- Create: `web/src/replay/ReplayControls.test.tsx`
- Modify: `web/src/styles/app.css`

**Interfaces:**
- Produces: `ReplayControlsProps.timeline?: TimelineEntry[]`. Ticks render as `<span class="scrub__tick scrub__tick--event|chat" style="left: N%">` inside `.scrub`.

- [ ] **Step 1: Write the failing test**

```tsx
// web/src/replay/ReplayControls.test.tsx
import { describe, it, expect, afterEach } from 'vitest';
import { render, cleanup } from '@testing-library/preact';
import { ReplayControls } from './ReplayControls';

afterEach(cleanup);

const playback = {
  tRef: { current: 0 }, tMs: 0, playing: true, speed: 1, following: false,
  play() {}, pause() {}, toggle() {}, seek() {}, setSpeed() {}, follow() {},
};

describe('ReplayControls ticks', () => {
  it('places one tick per timeline entry at its fraction of the round', () => {
    const { container } = render(
      <ReplayControls
        playback={playback} endMs={100000} live={false}
        followSlot={null} setFollowSlot={() => {}} slots={[]} names={{}}
        timeline={[
          { seq: 1, tMs: 25000, kind: 'event', text: 'pounced', actor: 'x', team: null },
          { seq: 2, tMs: 50000, kind: 'chat', text: 'gg', actor: 'y', team: 'survivor' },
        ]}
      />,
    );
    const ticks = container.querySelectorAll('.scrub__tick');
    expect(ticks).toHaveLength(2);
    expect((ticks[0] as HTMLElement).style.left).toBe('25%');
    expect(ticks[0].classList.contains('scrub__tick--event')).toBe(true);
    expect((ticks[1] as HTMLElement).style.left).toBe('50%');
    expect(ticks[1].classList.contains('scrub__tick--chat')).toBe(true);
  });

  it('renders no tick layer without a timeline', () => {
    const { container } = render(
      <ReplayControls playback={playback} endMs={1000} live={false}
        followSlot={null} setFollowSlot={() => {}} slots={[]} names={{}} />,
    );
    expect(container.querySelector('.scrub__tick')).toBeNull();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run web/src/replay/ReplayControls.test.tsx`
Expected: FAIL: `timeline` is not a known prop and no ticks render.

- [ ] **Step 3: Render the ticks**

In `ReplayControls.tsx` add `import type { TimelineEntry } from './timeline';`, add `timeline?: TimelineEntry[];` to `ReplayControlsProps`, destructure it, and replace the `<input class="replay__scrub" .../>` with:

```tsx
        <div class="scrub">
          <input
            class="scrub__range"
            type="range"
            min={0}
            max={Math.max(endMs, 1)}
            value={playback.tMs}
            aria-label="Round position"
            onInput={(e) => playback.seek(Number((e.target as HTMLInputElement).value))}
          />
          {timeline && endMs > 0 && (
            <div class="scrub__ticks" aria-hidden="true">
              {timeline.map((e) => (
                <span
                  key={e.seq}
                  class={`scrub__tick scrub__tick--${e.kind}`}
                  style={{ left: `${Math.min(100, Math.max(0, (e.tMs / endMs) * 100))}%` }}
                />
              ))}
            </div>
          )}
        </div>
```

In `Viewer.tsx`, pass `timeline={timeline}` to `ReplayControls`.

- [ ] **Step 4: Style the filmstrip**

Append to the replay section of app.css:

```css
/* Filmstrip scrub: a range input styled as a strip of frames, with event and
   chat ticks laid over it from the timeline. */
.scrub { position: relative; flex: 1 1 200px; height: 22px; }
.scrub__range {
  appearance: none;
  -webkit-appearance: none;
  width: 100%;
  height: 22px;
  margin: 0;
  padding: 0;
  border: 0;
  background: repeating-linear-gradient(90deg, #1a1512 0 26px, #241d18 26px 28px);
  cursor: pointer;
}
.scrub__range::-webkit-slider-runnable-track { height: 22px; background: transparent; }
.scrub__range::-moz-range-track { height: 22px; background: transparent; }
.scrub__range::-webkit-slider-thumb { -webkit-appearance: none; width: 3px; height: 30px; margin-top: -4px; background: var(--text-bright); border: 0; }
.scrub__range::-moz-range-thumb { width: 3px; height: 30px; background: var(--text-bright); border: 0; border-radius: 0; }
.scrub__range::-moz-range-progress { height: 22px; background: color-mix(in srgb, var(--rule) 70%, transparent); }
.scrub__ticks { position: absolute; inset: 0; pointer-events: none; }
.scrub__tick { position: absolute; top: 3px; width: 2px; height: 16px; }
.scrub__tick--event { background: var(--accent); }
.scrub__tick--chat { background: var(--text-muted); opacity: 0.6; }
```

Delete the `.replay__scrub` rule.

- [ ] **Step 5: Run, screenshot, commit**

Run: `npm test && npm run typecheck && npm run shoot`
Expected: green (2 new tests). `match-9001-1400.png`: the scrub is a dark filmstrip with red ticks where the seeded timeline has events.

```bash
git add web/src/replay/ReplayControls.tsx web/src/replay/ReplayControls.test.tsx web/src/replay/Viewer.tsx web/src/styles/app.css
git commit -m "feat(replay): filmstrip scrub bar with timeline ticks"
```

---

### Task 22: HUD strip tiles and the health palette

Spec 7, HUD strip. The panel markup is already right; the styling changes, and the three health colors move to the site's teal, gold and red. `healthColor` also colors the map ring, which the spec allows. Thresholds stay at the game's 40 and 20.

**Files:**
- Modify: `web/src/replay/hud.ts:3-10` (`healthColor` values)
- Modify: `web/src/replay/HudStrip.tsx` (class names only)
- Modify: `web/src/styles/app.css` (`.hud-*`, `.hudp*`)

- [ ] **Step 1: Change the palette**

In `hud.ts`:

```ts
export function healthColor(health: number, alive: boolean): string {
  if (!alive) return '#958770';
  if (health > 40) return '#45b39c';
  if (health > 20) return '#c9a45c';
  // The site's red. It is the infected color as well, which is fine here: a
  // survivor this low is about to become their problem.
  return '#de4e40';
}
```

Run: `npx vitest run web/src/replay/hud.test.ts web/src/replay/draw.test.ts`
Expected: PASS. `hud.test.ts` asserts the three bands differ from each other and from `TEMP_HEALTH_COLOR` (`#5f9d78`), which they do. `draw.test.ts:728` compares `GHOST_COLOR` against a literal and does not read `healthColor`.

- [ ] **Step 2: Restyle the tiles**

Replace from `/* HUD panel strip. */` through the `.hudp__bar-perm` rule in app.css with:

```css
/* HUD strip: portrait tiles with health bars, survivors then infected. The
   left stripe is the slot colour, set inline from the palette the map draws
   with, so a tile can be matched to a dot without reading. */
.hud-strip { display: flex; flex-direction: column; gap: var(--sp-2); }
.hud-row { display: flex; gap: var(--sp-2); align-items: stretch; flex-wrap: wrap; }
.hud-row__label { font-family: var(--font-label); font-size: var(--fs-label); text-transform: uppercase; letter-spacing: 0.18em; color: var(--text-muted); align-self: center; min-width: 5rem; }
.hudp { display: flex; gap: var(--sp-2); background: var(--surface); border: 1px solid var(--border); border-left-width: 3px; padding: var(--sp-2); min-width: 10rem; flex: 1 1 10rem; }
.hudp__slot { font-family: var(--font-label); font-size: var(--fs-label); color: var(--text-muted); font-variant-numeric: tabular-nums; }
.hudp--empty { visibility: hidden; }
.hudp--dead { filter: grayscale(1); opacity: 0.55; }
.hudp__face { width: 34px; height: 34px; object-fit: cover; }
.hudp__body { display: flex; flex-direction: column; gap: 3px; flex: 1; min-width: 0; }
.hudp__top { display: flex; justify-content: space-between; align-items: baseline; gap: var(--sp-2); }
.hudp__name { font-family: var(--font-label); font-size: var(--fs-dense); letter-spacing: 0.06em; text-transform: uppercase; color: var(--text-bright); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.hudp__hp { font-family: var(--font-display); font-size: 1.25rem; line-height: 1; font-variant-numeric: tabular-nums; }
.hudp__cls, .hudp__gun, .hudp__flags { font-family: var(--font-label); font-size: var(--fs-label); letter-spacing: 0.12em; text-transform: uppercase; color: var(--text-muted); }
.hudp__flags { color: var(--rating); }
.hudp__bar { position: relative; height: 8px; background: var(--bg); border: 1px solid var(--border); overflow: hidden; }
.hudp__bar-temp, .hudp__bar-perm { position: absolute; inset: 0 auto 0 0; }
.hudp__bar-temp { background: #5f9d78; } /* TEMP_HEALTH_COLOR in replay/hud.ts; keep the two in step. */
.hudp__bar-perm { background: #45b39c; }
```

The permanent-health bar segment is teal regardless of health here because the number beside it already carries the threshold color; the game's HUD does the same.

- [ ] **Step 3: Run, screenshot, commit**

Run: `npm test && npm run typecheck && npm run shoot`
Expected: green. `match-9001-1400.png`: eight tiles in the poster voice, health numbers in Anton.

```bash
git add web/src/replay/hud.ts web/src/styles/app.css
git commit -m "feat(replay): poster HUD tiles and the site health palette"
```

---

### Task 23: Canvas chrome

Spec 7, canvas chrome. Only colors the canvas paints for its own furniture: the clear fill, the label plates, the grid, the alert ring and the status glyph. Nothing about geometry, slot colors or entity colors changes.

**Files:**
- Modify: `web/src/replay/draw.ts` (five literals)

- [ ] **Step 1: Change the literals**

- `alertColor`: pinned returns `'#c9a45c'`, incapacitated or ledged returns `'#de4e40'`. Update the comment above it: "The rating gold and the site red, so the ring reads with the rest of the page."
- `drawLabels`: `ctx.fillStyle = 'rgba(8,10,7,0.78)'` becomes `'rgba(5,4,3,0.78)'`.
- `drawGrid`: `ctx.strokeStyle = 'rgba(255,255,255,0.05)'` becomes `'rgba(217,203,176,0.06)'`.
- `drawScene`: `ctx.fillStyle = '#11130f'` becomes `'#0b0908'`.
- The status glyph fill `ctx.fillStyle = '#e8b04b'` becomes `'#c9a45c'`.

- [ ] **Step 2: Run the draw tests**

Run: `npx vitest run web/src/replay/draw.test.ts`
Expected: PASS. If a test pins one of these literals, the assertion is about the literal and not about behaviour; update the expected value in the test and say so in the commit body.

- [ ] **Step 3: Full run, screenshots, commit**

Run: `npm test && npm run typecheck && npm run shoot`
Expected: green. Compare `match-9001-1400.png` with the reference canvas, page one: this is the end state of the sweep.

```bash
git add web/src/replay/draw.ts
git commit -m "feat(replay): canvas chrome in the site palette"
```

---

## After the last task

- Run the whole suite and typecheck one final time, then `npm run shoot` and look at all eighteen images side by side with the reference canvas at https://claude.ai/code/artifact/7f1d586e-6bfd-4382-bf39-0f41f59f758e. Anything that departs from the canvas is either fixed or recorded in the spec's section 10 with a reason.
- Update `docs/REPLAY_VIEWER_STATUS.md` section 3 to say the viewer carries the poster chrome, and add a line to the spec's status header: "Steps 1 to 5 implemented on `feat/skill-stats-5`; step 6 (theater mode) has its own plan."
- Theater mode (spec 7.1) is planned separately once this lands, because its edge HUD reuses the `HudStrip` markup and the `ReplayHud` overlay this plan produces.
