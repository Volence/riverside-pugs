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
  ['home', '/'], ['live', '/live'], ['streams', '/streams'], ['leaderboard', '/leaderboard'],
  ['matches', '/matches'], ['match-9001', '/match/9001'], ['campaigns', '/maps'],
  ['map-caves', '/map/l4d_vs_smalltown01_caves'],
  ['profile', '/player/76561198000000001'],
  ['hud', '/hud'],
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
      // Fix round 1 found that resizing the CDP viewport to the full document
      // height (a second setDeviceMetricsOverride to width x h) stalls
      // headless Chrome's compositor on tall pages once body paints two
      // stacked background layers (the grain feTurbulence filter plus the
      // vignette radial-gradients): captureScreenshot never returns,
      // independent of background-attachment mode. Fix round 2's approach A
      // (this code) never resizes the viewport past its initial width x
      // 1000. Instead it switches body to background-attachment: scroll so
      // the backgrounds paint over the whole document rather than being
      // pinned to the small viewport, then captures with a `clip` region
      // sized to the full document height via captureBeyondViewport. That
      // lets Chrome rasterize the tall backgrounds without ever inflating
      // the actual viewport/compositor surface, and it worked: no hang, and
      // the atmosphere is visible all the way to the bottom of the tallest
      // page (see task-2-report.md "Fix round 2").
      // Grain tile over full-page clip stalls headless compositor; drop it and keep vignette only
      await send('Runtime.evaluate', {
        expression: `(() => { const s = document.getElementById('shoot-override') || document.head.appendChild(Object.assign(document.createElement('style'), { id: 'shoot-override' })); s.textContent = 'body{background-attachment:scroll !important;background-image:var(--vignette) !important}'; })()`,
      });
      await sleep(300);
      const shot = await send('Page.captureScreenshot', {
        format: 'png',
        captureBeyondViewport: true,
        clip: { x: 0, y: 0, width, height: h, scale: 1 },
      });
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
