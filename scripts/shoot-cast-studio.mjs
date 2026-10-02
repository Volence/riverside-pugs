// scripts/shoot-cast-studio.mjs
// Screenshots of every caster studio scene at 1920x1080 and the producer panel
// at desktop and phone widths, in headless Chrome over the DevTools protocol.
// Needs a DEV_MODE API on a scratch database seeded by
// scripts/seed-cast-studio.ts, and vite in front of it:
//
//   BASE   the vite URL, default http://localhost:5183
//   OUT    folder for the PNGs (required)
//   MATCH  the seeded live match id (required)
//
// Layers (gameplay, scorebug, round HUD, lower third) are shot over a game
// still, so their legibility on top of the game can be judged.
import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const BASE = process.env.BASE ?? 'http://localhost:5183';
const OUT = process.env.OUT;
const MATCH = Number(process.env.MATCH);
if (!OUT || !MATCH) throw new Error('Set OUT and MATCH.');
mkdirSync(OUT, { recursive: true });
const CASTER = '76561198000009001';
const PORT = 9343;
// BG_FILE: a 1920x1080 screenshot to shoot the gameplay layers over (for
// example a spectator probe shot), instead of the bundled still.
const BG = process.env.BG_FILE
  ? `url(data:image/png;base64,${readFileSync(process.env.BG_FILE).toString('base64')}) center / cover`
  : 'url(/hud-backdrops/survivor-hilltop.jpg) center / cover';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const profile = join(OUT, '.profile');
rmSync(profile, { recursive: true, force: true });
const chrome = spawn('google-chrome-stable', [
  '--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
  '--no-first-run', '--no-default-browser-check', '--hide-scrollbars', 'about:blank',
], { stdio: 'ignore' });

let ws; let id = 0; const pending = new Map();
const send = (method, params = {}) => {
  const i = ++id;
  ws.send(JSON.stringify({ id: i, method, params }));
  return new Promise((res, rej) => pending.set(i, (m) => (m.error ? rej(new Error(`${method} ${JSON.stringify(m.error)}`)) : res(m.result))));
};
const ev = async (expression) => {
  const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
  return r.result.value;
};
const go = async (url) => { await send('Page.navigate', { url }); await sleep(400); await ev('new Promise(r => document.readyState === "complete" ? r() : addEventListener("load", r))'); };
const shot = async (name, opts = {}) => {
  const r = await send('Page.captureScreenshot', { format: 'png', ...opts });
  writeFileSync(join(OUT, `${name}.png`), Buffer.from(r.data, 'base64'));
  console.log('shot', name);
};
const size = (width, height, mobile = false) => send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile });
const api = (method, path, body) => ev(`fetch(${JSON.stringify(path)}, { method: ${JSON.stringify(method)}, headers: { 'content-type': 'application/json' }, body: ${body === undefined ? 'undefined' : JSON.stringify(JSON.stringify(body))} }).then(r => r.json())`);

try {
  for (let i = 0; i < 80; i++) { try { await fetch(`http://127.0.0.1:${PORT}/json/version`); break; } catch { await sleep(250); } }
  const page = (await (await fetch(`http://127.0.0.1:${PORT}/json`)).json()).find((t) => t.type === 'page');
  ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((r) => { ws.onopen = r; });
  ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } };
  await send('Page.enable');
  await send('Runtime.enable');
  await size(1400, 1000);
  await go(`${BASE}/`);
  await api('POST', '/api/dev/login', { steamid: CASTER });
  const cur = (await api('GET', '/api/cast/studio')).studio;
  const state = {
    ...cur, matchId: MATCH, bookingId: null, title: 'Riverside PUGs', subtitle: 'Friday night versus',
    casters: [{ name: 'Volence', handle: '@volence', camUrl: '' }, { name: 'CasterOne', handle: 'twitch.tv/casterone', camUrl: '' }],
    countdownTo: new Date(Date.now() + 4 * 60_000 + 32_000).toISOString(),
    bosses: { tank: 74, witch: 31 },
    elements: { survivors: false, infected: true, tank: true, bosses: true, progress: true },
    hudStyle: process.env.HUD ?? 'plate', scorebugAt: 'top',
    lowerThird: { show: true, title: 'Map 2: The Crane', text: 'Team A leads by 64 after the greenhouse' },
    theme: process.env.THEME ?? 'riverside',
  };
  await api('PUT', '/api/cast/studio', state);
  const key = (await api('GET', '/api/cast/studio')).key;

  await send('Emulation.setDefaultBackgroundColorOverride', { color: { r: 0, g: 0, b: 0, a: 0 } });
  await size(1920, 1080);
  const layers = new Set(['gameplay', 'scorebug', 'roundhud', 'lowerthird']);
  const scenes = (process.env.SCENES ?? 'starting,casters,gameplay,mapintro,maps,lineups,stats,brb,winner,ending,scorebug,roundhud,lowerthird').split(',');
  for (const s of scenes) {
    if (s === 'gameplay') await api('POST', '/api/cast/studio/callout', { title: 'Triple skeet', text: 'Volence skeeted mira, gabe and Visceral', team: 'a' });
    await go(`${BASE}/overlay/${s}?k=${encodeURIComponent(key)}`);
    if (layers.has(s)) {
      await ev(`document.documentElement.style.background = ${JSON.stringify(BG)}`);
    }
    await sleep(s === 'gameplay' ? 2600 : 2400);
    await shot(`scene-${s}`);
  }

  // Every gameplay look, compact (the default: rows off) and with rows on.
  const rowsOn = { survivors: true, infected: true, tank: true, bosses: true, progress: true };
  // The default: survivor rows off (the game's bottom band has them), infected on.
  const compact = { survivors: false, infected: true, tank: true, bosses: true, progress: true };
  const looks = (process.env.LOOKS ?? 'plate,corners,rail,frame,scorebug').split(',');
  for (const look of looks) {
    for (const rows of look === 'frame' ? [false] : [false, true]) {
      await api('PUT', '/api/cast/studio', { ...state, hudStyle: look, elements: rows ? rowsOn : compact, lowerThird: { ...state.lowerThird, show: false } });
      await api('POST', '/api/cast/studio/callout', { title: 'Triple skeet', text: 'Volence skeeted mira, gabe and Visceral', team: 'a' });
      await go(`${BASE}/overlay/gameplay?k=${encodeURIComponent(key)}`);
      await ev(`document.documentElement.style.background = ${JSON.stringify(BG)}`);
      await sleep(2400);
      await shot(`gameplay-${look}-${rows ? 'rows' : 'compact'}`);
    }
  }
  // The tank damage card, on the default look.
  await api('PUT', '/api/cast/studio', { ...state, hudStyle: 'plate', lowerThird: { ...state.lowerThird, show: false } });
  await api('POST', '/api/dev/livehud', { token: 'a1'.repeat(16), tank: { aliveS: 84, controller: '76561198000009101', dealt: 312, players: [
    { steamid: '76561198000009104', dmg: 2870 }, { steamid: '76561198000009105', dmg: 1940 }, { steamid: '76561198000009106', dmg: 2210 }, { steamid: '76561198000009107', dmg: 980 },
  ] } });
  await go(`${BASE}/overlay/gameplay?k=${encodeURIComponent(key)}`);
  await ev(`document.documentElement.style.background = ${JSON.stringify(BG)}`);
  await sleep(2400);
  await shot('gameplay-plate-tank-recap');

  // Nothing on air: the OBS page is transparent (shot over the still).
  await api('PUT', '/api/cast/studio', { ...state, matchId: null, lowerThird: { ...state.lowerThird, show: false } });
  await go(`${BASE}/overlay/gameplay?k=${encodeURIComponent(key)}`);
  await ev(`document.documentElement.style.background = ${JSON.stringify(BG)}`);
  await sleep(1500);
  await shot('scene-gameplay-empty');

  await send('Emulation.clearDeviceMetricsOverride');
  await send('Emulation.setDefaultBackgroundColorOverride', {});
  // The panel with nothing on air (sample preview), then on air.
  await api('PUT', '/api/cast/studio', { ...state, matchId: null, scene: 'gameplay' });
  await size(1440, 900);
  await go(`${BASE}/cast/studio`);
  await sleep(2500);
  await shot('panel-1440-empty');
  await api('PUT', '/api/cast/studio', { ...state, scene: 'gameplay' });
  for (const [w, h, mobile] of [[1440, 900, false], [390, 844, true]]) {
    await size(w, h, mobile);
    await go(`${BASE}/cast/studio`);
    await sleep(2500);
    const full = await ev('Math.ceil(document.documentElement.scrollHeight)');
    await size(w, full, mobile);
    await sleep(600);
    await shot(`panel-${w}`, { captureBeyondViewport: true });
  }
} finally {
  chrome.kill();
}
