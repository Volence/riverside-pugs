// scripts/shoot-community.mjs
// End-to-end check of the community page in headless Chrome over the DevTools
// protocol, three browsers with their own profiles: player A shares, player B
// browses, likes, opens, downloads and reports, a staff player removes.
//
// Needs a DEV_MODE API on a scratch database and vite in front of it, never
// the real data/ (see Task 13 of docs/superpowers/plans/2026-09-24-hud-community.md):
//
//   BASE      the vite URL, default http://127.0.0.1:5198
//   OUT       scratch folder for screenshots, downloads and Chrome profiles (required)
//   DB_PATH   the API's scratch database, to make the staff player a moderator (required)
//   FIXTURE   an imported HUD's .vpk under /home/volence/l4d (headless Chrome
//             cannot read files under /tmp/claude-1000), default the owner's test HUD
//   VPK_PY    a python with the `vpk` package, default /home/volence/l4d/hud/.venv/bin/python
//
// Exits 0 only when every step passed.
import { spawn, execFileSync } from 'node:child_process';
import { mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import Database from 'better-sqlite3';
import { hudPathProblem, hudSetProblem } from '../src/hudFiles.ts';

const BASE = process.env.BASE ?? 'http://127.0.0.1:5198';
const OUT = process.env.OUT;
const DB_PATH = process.env.DB_PATH;
const FIXTURE = resolve(process.env.FIXTURE ?? '/home/volence/l4d/hud/test-hud-2026-09-23/my_old_hud.vpk');
const VPK_PY = process.env.VPK_PY ?? '/home/volence/l4d/hud/.venv/bin/python';
if (!OUT || !DB_PATH) throw new Error('Set OUT and DB_PATH to the scratch folder and the scratch database.');
const SHOTS = join(OUT, 'shots');
mkdirSync(SHOTS, { recursive: true });

const A = '76561198000000001';
const B = '76561198000000002';
const STAFF = '76561198000000003';
const WIDTHS = [1400, 390];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const ok = (msg) => console.log(`  ok   ${msg}`);
const fail = (msg) => { failures++; console.log(`  FAIL ${msg}`); };
const check = (cond, msg) => (cond ? ok(msg) : fail(msg));
const step = (msg) => console.log(`\n== ${msg}`);

/** One headless Chrome with its own profile, driven over one page's websocket. */
class Browser {
  constructor(name, port) {
    this.name = name;
    this.port = port;
    this.dl = join(OUT, 'dl', name);
    // Emptied first: Chrome overwrites a same-named file from an earlier run,
    // which waitDownload would never see as new.
    rmSync(this.dl, { recursive: true, force: true });
    mkdirSync(this.dl, { recursive: true });
    const profile = join(OUT, 'profiles', name);
    rmSync(profile, { recursive: true, force: true });
    this.proc = spawn('google-chrome-stable', [
      '--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`,
      '--no-first-run', '--no-default-browser-check', 'about:blank',
    ], { stdio: 'ignore' });
    this.id = 0;
    this.pending = new Map();
    this.dialogs = [];
  }

  async start() {
    for (let i = 0; i < 80; i++) {
      try { await fetch(`http://127.0.0.1:${this.port}/json/version`); break; } catch { await sleep(250); }
    }
    const page = (await (await fetch(`http://127.0.0.1:${this.port}/json`)).json()).find((t) => t.type === 'page');
    this.ws = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((r) => { this.ws.onopen = r; });
    this.ws.onmessage = (e) => {
      const m = JSON.parse(e.data);
      if (m.id && this.pending.has(m.id)) this.pending.get(m.id)(m);
      else if (m.method === 'Page.javascriptDialogOpening') {
        this.dialogs.push(m.params.message);
        void this.send('Page.handleJavaScriptDialog', { accept: true });
      }
    };
    await this.send('Page.enable');
    await this.send('Runtime.enable');
    await this.send('DOM.enable');
    await this.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: this.dl })
      .catch(() => this.send('Page.setDownloadBehavior', { behavior: 'allow', downloadPath: this.dl }));
    await this.size(1400);
  }

  send(method, params = {}) {
    const i = ++this.id;
    this.ws.send(JSON.stringify({ id: i, method, params }));
    return new Promise((res, rej) => {
      const t = setTimeout(() => rej(new Error(`${this.name}: timeout ${method}`)), 30000);
      this.pending.set(i, (m) => {
        clearTimeout(t);
        this.pending.delete(i);
        m.error ? rej(new Error(`${this.name}: ${method} ${JSON.stringify(m.error)}`)) : res(m.result);
      });
    });
  }

  async ev(expression) {
    const r = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(`${this.name}: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`);
    return r.result.value;
  }

  async waitFor(expression, what, timeout = 15000) {
    const end = Date.now() + timeout;
    for (;;) {
      const v = await this.ev(expression).catch(() => null);
      if (v) return v;
      if (Date.now() > end) throw new Error(`${this.name}: timed out waiting for ${what}`);
      await sleep(200);
    }
  }

  async size(width) {
    await this.send('Emulation.setDeviceMetricsOverride', { width, height: 1000, deviceScaleFactor: 1, mobile: width < 768 });
  }

  async go(path) {
    await this.send('Page.navigate', { url: BASE + path });
    await this.waitFor(`document.readyState === 'complete' && document.getElementById('app')?.children.length > 0`, `${path} to render`);
    await sleep(600);
  }

  async login(steamid) {
    const r = await this.ev(`fetch('/api/dev/login', { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ steamid: '${steamid}' }) }).then((r) => r.json())`);
    if (!r?.ok) throw new Error(`${this.name}: dev login failed ${JSON.stringify(r)}`);
  }

  /** Click the first element matching `sel` whose text includes `text` (inside `within`, a selector, when given). */
  async click(sel, text = '', within = null) {
    const done = await this.waitFor(`(() => {
      const root = ${within ? `document.querySelector(${JSON.stringify(within)})` : 'document'};
      if (!root) return false;
      const el = [...root.querySelectorAll(${JSON.stringify(sel)})].find((e) => e.textContent.includes(${JSON.stringify(text)}) && !e.disabled);
      if (!el) return false;
      el.scrollIntoView({ block: 'center' });
      el.click();
      return true;
    })()`, `${sel} "${text}"`);
    await sleep(250);
    return done;
  }

  /** Type into an input or textarea the way Preact hears it. */
  async type(sel, value) {
    await this.waitFor(`(() => {
      const el = document.querySelector(${JSON.stringify(sel)});
      if (!el) return false;
      const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : el.tagName === 'SELECT' ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, ${JSON.stringify(value)});
      el.dispatchEvent(new Event(el.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true }));
      return true;
    })()`, `field ${sel}`);
    await sleep(150);
  }

  async setFile(sel, path) {
    const { root } = await this.send('DOM.getDocument', { depth: -1 });
    const { nodeId } = await this.send('DOM.querySelector', { nodeId: root.nodeId, selector: sel });
    if (!nodeId) throw new Error(`${this.name}: no ${sel}`);
    await this.send('DOM.setFileInputFiles', { nodeId, files: [path] });
  }

  text() { return this.ev('document.body.innerText'); }

  /** A confirm modal from components/Confirm, answered with the button labelled `label`, when one shows within `ms`. */
  async answerModal(label, ms = 2500) {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      const clicked = await this.ev(`(() => {
        const b = [...document.querySelectorAll('.modal button')].find((e) => e.textContent.trim() === ${JSON.stringify(label)});
        if (!b) return false; b.click(); return true;
      })()`);
      if (clicked) { await sleep(300); return true; }
      await sleep(150);
    }
    return false;
  }

  /** Screenshot the whole page at each width; false on an empty page or a horizontal overflow. */
  async shoot(name, path, { before } = {}) {
    let good = true;
    for (const width of WIDTHS) {
      await this.size(width);
      if (path) await this.go(path);
      if (before) await before();
      await sleep(500);
      const { h, overflow, empty, wide } = await this.ev(`(() => {
        const de = document.documentElement;
        const wide = [...document.querySelectorAll('body *')].filter((e) => {
          const r = e.getBoundingClientRect();
          return r.width > 0 && r.right > de.clientWidth + 1 && getComputedStyle(e).position !== 'fixed';
        }).slice(0, 5).map((e) => e.tagName.toLowerCase() + (e.className && typeof e.className === 'string' ? '.' + e.className.split(' ').join('.') : '') + ' ' + Math.round(e.getBoundingClientRect().right));
        return { h: Math.min(de.scrollHeight, 6000), overflow: de.scrollWidth > de.clientWidth,
          empty: document.getElementById('app').children.length === 0, wide };
      })()`);
      // As shoot-pages.mjs: no grain layer, backgrounds painted over the whole document.
      await this.ev(`(() => { const s = document.getElementById('shoot-override') || document.head.appendChild(Object.assign(document.createElement('style'), { id: 'shoot-override' })); s.textContent = 'body{background-attachment:scroll !important;background-image:var(--vignette) !important}'; })()`);
      await sleep(200);
      const shot = await this.send('Page.captureScreenshot', {
        format: 'png', captureBeyondViewport: true, clip: { x: 0, y: 0, width, height: h, scale: 1 },
      });
      const file = `${name}-${width}.png`;
      writeFileSync(join(SHOTS, file), Buffer.from(shot.data, 'base64'));
      if (empty) { good = false; fail(`${file}: empty page`); }
      if (overflow) { good = false; fail(`${file}: horizontal overflow (${wide.join(', ')})`); }
      if (!empty && !overflow) ok(`${file} ${h}px`);
    }
    await this.size(1400);
    return good;
  }

  async waitDownload(ext, before) {
    const end = Date.now() + 20000;
    while (Date.now() < end) {
      const got = readdirSync(this.dl).filter((f) => f.endsWith(ext) && !before.has(f));
      if (got.length && got.every((f) => statSync(join(this.dl, f)).size > 0)) return join(this.dl, got[0]);
      await sleep(250);
    }
    throw new Error(`${this.name}: no ${ext} download`);
  }

  close() { try { this.ws?.close(); } catch { /* closing anyway */ } this.proc.kill(); }
}

/** Every path in a VPK, read by the python `vpk` package, not the site's own reader. */
function vpkPaths(file) {
  const out = execFileSync(VPK_PY, ['-c', `
import sys, json, vpk
p = vpk.open(sys.argv[1])
print(json.dumps({ path: p.get_file(path).read().hex() for path in p }))
`, file], { maxBuffer: 256 * 1024 * 1024 });
  return new Map(Object.entries(JSON.parse(out)).map(([k, v]) => [k, Uint8Array.from(Buffer.from(v, 'hex'))]));
}

function checkVpk(file, label) {
  const files = vpkPaths(file);
  const bad = [...files.keys()].filter((p) => p !== 'addoninfo.txt' && hudPathProblem(p) !== null);
  check(files.size > 0, `${label}: python vpk reads ${files.size} files`);
  check(bad.length === 0, `${label}: every path is allowlisted or addoninfo.txt${bad.length ? ` (bad: ${bad.join(', ')})` : ''}`);
  const rest = new Map([...files].filter(([p]) => p !== 'addoninfo.txt'));
  const problem = hudSetProblem(rest);
  check(problem === null, `${label}: contents pass hudSetProblem${problem ? ` (${problem})` : ''}`);
  return files;
}

/** Width, height and byte size of a PNG at `url`, read in the page from its IHDR. */
const pngInfo = (br, url) => br.ev(`fetch(${JSON.stringify(url)}).then(async (r) => {
  const b = new Uint8Array(await r.arrayBuffer()); const v = new DataView(b.buffer);
  const sig = b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47;
  return { status: r.status, sig, w: sig ? v.getUint32(16) : 0, h: sig ? v.getUint32(20) : 0, bytes: b.length };
})`);
const PREVIEW_CAP = 2.5 * 1024 * 1024;

/** Both sides' previews of a shared HUD: present, 960 x 540 PNGs, under the cap. */
async function checkPreviews(br, id, label) {
  const e = await br.ev(`fetch('/api/community/${id}').then((r) => r.json())`);
  check(!!e.previewUrl && !!e.previewInfectedUrl, `${label}: the entry has a survivor and an infected preview`);
  for (const [side, url] of [['survivor', e.previewUrl], ['infected', e.previewInfectedUrl]]) {
    if (!url) continue;
    const i = await pngInfo(br, url);
    check(i.status === 200 && i.sig && i.w === 960 && i.h === 540 && i.bytes < PREVIEW_CAP,
      `${label}: ${side} preview is a ${i.w} x ${i.h} PNG of ${(i.bytes / 1024).toFixed(0)} KB`);
  }
  return e;
}

/** Click a Survivor / Infected toggle inside `root` (an expression) and wait for that side's image. */
async function pickSide(br, root, side, label) {
  const name = side === 'infected' ? 'Infected' : 'Survivor';
  await br.ev(`[...${root}.querySelectorAll('.sidepv button')].find((x) => x.textContent.trim() === ${JSON.stringify(name)}).click()`);
  return br.waitFor(`(() => { const r = ${root}; const btn = [...r.querySelectorAll('.sidepv button')].find((x) => x.textContent.trim() === ${JSON.stringify(name)});
    const img = r.querySelector('img'); return btn?.getAttribute('aria-pressed') === 'true' && img?.alt.endsWith(${JSON.stringify(`${side} side`)}) && img.complete && img.naturalWidth > 0 ? img.getAttribute('src') : null; })()`, `${label}: the ${side} preview`);
}

const cardExpr = (title) => `[...document.querySelectorAll('article.ccard')].find((c) => c.querySelector('.ccard__title')?.textContent.trim() === ${JSON.stringify(title)})`;

const STOCK_DESIGN = {
  v: 1, name: 'riverside_stock', preset: 'stock', advanced: false, aspect: '16:9', font: 'preset',
  crosshair: 'none',
  elements: {
    teamColumn: { fit: true, dir: 'column', gap: 4 },
    ownHealth: { x: 420, y: 380, scale: 1.25 },
    chat: { visible: false },
  },
  styles: {}, images: {}, children: {},
};
const XHAIR_STATE = {
  shape: 'cross', len: 10, thick: 2, gap: 4, dot: 0, radius: 8, round: false,
  color: '#ff3030', alpha: 100, outline: 1, oalpha: 80, backdrop: 'scene', res: '1080',
};

const TITLES = { stock: 'Riverside stock', imported: 'Old HUD import', xhair: 'Red cross' };

const a = new Browser('a', 9341);
const b = new Browser('b', 9342);
const s = new Browser('staff', 9343);
const ids = {};

async function share(br, openSel, openText, title, description) {
  await br.click(openSel, openText);
  await br.waitFor(`!!document.querySelector('.modal .share__form') || document.querySelector('.modal')?.innerText.includes('Sign in')`, 'the share dialog');
  await br.type('.share__field input', title);
  await br.type('.share__field textarea', description);
  await br.click('.share__check input');
}

async function submitShare(br) {
  await br.click('.modal button[type=submit]', 'Share');
  const txt = await br.waitFor(`(() => { const m = document.querySelector('.modal'); if (!m) return null;
    if (m.innerText.includes('Shared.')) return m.innerText;
    const e = m.querySelector('.error'); return e ? 'ERROR ' + e.textContent : null; })()`, 'the share to finish', 30000);
  const id = Number((await br.ev(`document.querySelector('.modal a[href^="/community/"]')?.getAttribute('href') ?? ''`)).split('/').pop());
  await br.click('.modal button', 'Done').catch(() => {});
  return { txt, id };
}

try {
  await Promise.all([a.start(), b.start(), s.start()]);

  // A repeat run on the same scratch database would meet A's share caps (2
  // HUDs, 6 shares a day), so they are raised here. Earlier entries stay:
  // one shared before infected previews existed shows no toggle.
  {
    const w = new Database(DB_PATH);
    w.prepare("UPDATE settings SET value = '5' WHERE key = 'community_huds_per_player'").run();
    w.prepare("UPDATE settings SET value = '5' WHERE key = 'community_crosshairs_per_player'").run();
    w.prepare("UPDATE settings SET value = '50' WHERE key = 'community_shares_per_day'").run();
    w.close();
  }

  // ------------------------------------------------------------------ A shares
  step('A: share a crosshair from the crosshair maker');
  await a.go('/');
  await a.login(A);
  // Entries left by an earlier run on this database are deleted as A, so the
  // HUD cap never refuses this run's shares; one without an infected preview
  // (shared before there was one) is kept for the no-toggle check below.
  {
    const mine = await a.ev(`fetch('/api/community/mine').then((r) => r.json())`);
    const stale = mine.entries.filter((e) => e.removedByStaff === null && (e.kind === 'crosshair' || e.previewInfectedUrl));
    for (const e of stale) await a.ev(`fetch('/api/community/${e.id}', { method: 'DELETE' }).then((r) => r.status)`);
    if (stale.length) ok(`deleted ${stale.length} entries of A's from earlier runs`);
  }
  await a.ev(`localStorage.setItem('xhair', ${JSON.stringify(JSON.stringify(XHAIR_STATE))})`);
  await a.go('/crosshair');
  await share(a, 'button.xh__share', 'Share to community', TITLES.xhair, 'A red cross, a bit wider than stock.');
  let r = await submitShare(a);
  check(r.txt.includes('Shared.') && r.id > 0, `crosshair shared as entry ${r.id}`);
  ids.xhair = r.id;

  step('A: share a customised stock HUD from the HUD editor');
  await a.ev(`localStorage.setItem('hud', ${JSON.stringify(JSON.stringify(STOCK_DESIGN))})`);
  await a.go('/hud');
  await a.waitFor(`!!document.querySelector('canvas')`, 'the editor canvas');
  await share(a, 'button.hud__share', 'Share to community', TITLES.stock, 'Stock with the health moved in and chat hidden.');
  await a.waitFor(`document.querySelector('.share__preview')?.complete && document.querySelector('.share__preview').naturalWidth > 0`, 'the share preview');
  check(await a.ev(`document.querySelectorAll('.share__form .sidepv button').length === 2`), 'the share dialog has a Survivor / Infected toggle');
  await a.shoot('hud-share-dialog', null);
  {
    const dlg = `document.querySelector('.share__form')`;
    const survivorSrc = await a.ev(`${dlg}.querySelector('img').getAttribute('src')`);
    const infectedSrc = await pickSide(a, dlg, 'infected', 'share dialog');
    check(infectedSrc !== survivorSrc, 'the dialog shows a different image for the infected side');
    await a.shoot('hud-share-dialog-infected', null);
    await pickSide(a, dlg, 'survivor', 'share dialog');
  }
  r = await submitShare(a);
  check(r.txt.includes('Shared.') && r.id > 0, `stock HUD shared as entry ${r.id}`);
  ids.stock = r.id;
  await checkPreviews(a, ids.stock, 'stock HUD');

  step('A: import a HUD file and share it');
  await a.setFile('input[aria-label="Import a HUD file"]', FIXTURE);
  // A design with moves asks whether to reset them on switching base.
  const asked = await a.answerModal('Keep', 4000);
  const imported = await a.waitFor(`(() => { const t = document.body.innerText; const m = /Imported [^\\n]+/.exec(t); return m ? m[0] : null; })()`, 'the import status');
  ok(`import status: ${imported}${asked ? ' (answered the reset question with Keep)' : ''}`);
  const presetVal = await a.ev(`[...document.querySelectorAll('select')].find((s) => [...s.options].some((o) => o.value === 'stock'))?.value`);
  check(String(presetVal).startsWith('imported:'), `design is on the import (${presetVal})`);
  await sleep(500);
  await share(a, 'button.hud__share', 'Share to community', TITLES.imported, 'My old HUD, imported.');
  await a.waitFor(`document.querySelector('.share__preview')?.complete && document.querySelector('.share__preview').naturalWidth > 0`, 'the import share preview', 30000);
  const leftOut = await a.ev(`document.querySelector('.share__left')?.innerText ?? ''`);
  if (leftOut) ok(`share dialog lists files left out: ${leftOut.replace(/\n/g, ' ')}`);
  r = await submitShare(a);
  check(r.txt.includes('Shared.') && r.id > 0, `imported HUD shared as entry ${r.id}`);
  const aImported = JSON.parse(await a.ev(`localStorage.getItem('hud')`));
  ids.imported = r.id;
  await checkPreviews(a, ids.imported, 'imported HUD');

  // ------------------------------------------------------------------ B browses
  step('B: browse /community');
  await b.go('/');
  await b.login(B);
  await b.go('/community');
  await b.waitFor(`document.querySelectorAll('article.ccard').length >= 2`, 'two HUD cards');
  check(await b.ev(`!!${cardExpr(TITLES.stock)} && !!${cardExpr(TITLES.imported)}`), 'both shared HUDs are on the HUD tab');
  check(await b.ev(`${cardExpr(TITLES.imported)}.querySelector('.ccard__badge')?.textContent.startsWith('Imported: ')`), 'the imported HUD card carries its Imported badge');
  check(await b.ev(`[...document.querySelectorAll('img.ccard__preview')].every((i) => i.complete && i.naturalWidth > 0)`), 'every HUD preview image loaded');
  await b.shoot('community-huds', '/community', { before: () => b.waitFor(`document.querySelectorAll('img.ccard__preview').length >= 2`, 'previews') });

  step('B: the Survivor / Infected toggle on the gallery and the entry page');
  {
    const list = await b.ev(`fetch('/api/community?kind=hud').then((r) => r.json())`);
    const byId = new Map(list.entries.map((e) => [e.id, e]));
    for (const key of ['stock', 'imported']) {
      const card = cardExpr(TITLES[key]);
      check(await b.ev(`${card}.querySelectorAll('.sidepv button[aria-pressed]').length === 2`), `the ${key} card has the toggle`);
      const src = await pickSide(b, card, 'infected', `${key} card`);
      check(src === byId.get(ids[key])?.previewInfectedUrl, `the ${key} card shows its infected preview`);
    }
    const older = list.entries.filter((e) => !e.previewInfectedUrl);
    if (older.length) {
      const card = `[...document.querySelectorAll('article.ccard')].find((c) => c.querySelector('.ccard__title a')?.getAttribute('href') === '/community/${older[0].id}')`;
      check(await b.ev(`!!${card} && ${card}.querySelectorAll('.sidepv').length === 0`), `an entry shared before infected previews (${older[0].id}) shows no toggle`);
    }
    // Every card to the infected side, at both widths (no reload between them).
    await b.shoot('community-huds-infected', null, {
      before: () => b.ev(`[...document.querySelectorAll('.sidepv')].forEach((g) => [...g.querySelectorAll('button')].find((x) => x.textContent.trim() === 'Infected').click())`)
        .then(() => b.waitFor(`[...document.querySelectorAll('img.ccard__preview')].every((i) => i.complete && i.naturalWidth > 0)`, 'the infected previews')),
    });
    await b.shoot('entry-page-survivor', `/community/${ids.stock}`, { before: () => b.waitFor(`document.querySelector('img.ccard__preview')?.naturalWidth > 0`, 'the entry preview') });
    await b.shoot('entry-page-infected', null, { before: () => pickSide(b, `document.querySelector('article.ccard')`, 'infected', 'entry page') });
  }
  await b.shoot('community-crosshairs', '/community?kind=crosshair', { before: () => b.waitFor(`document.querySelectorAll('canvas.ccard__xhair').length >= 1`, 'the crosshair card') });
  check(await b.ev(`!!${cardExpr(TITLES.xhair)}`), 'the crosshair is on the Crosshairs tab');

  step('B: like the imported HUD');
  await b.go('/community');
  await b.waitFor(`!!${cardExpr(TITLES.imported)}`, 'the imported card');
  await b.ev(`${cardExpr(TITLES.imported)}.querySelector('button.ccard__like').click()`);
  const liked = await b.waitFor(`(() => { const t = ${cardExpr(TITLES.imported)}.querySelector('button.ccard__like').textContent; return t.startsWith('Liked') ? t : null; })()`, 'the like');
  check(liked === 'Liked, 1', `like button reads "${liked}"`);
  await b.go('/community');
  const kept = await b.waitFor(`${cardExpr(TITLES.imported)}?.querySelector('button.ccard__like')?.textContent`, 'the like after reload');
  check(kept === 'Liked, 1', `the like survives a reload ("${kept}")`);

  step('B: open the stock HUD in the editor');
  await b.go(`/hud?community=${ids.stock}`);
  await b.answerModal('Load link', 2500);
  const opened = await b.waitFor(`(() => { const m = /Opened [^\\n]+/.exec(document.body.innerText); return m ? m[0] : null; })()`, 'the open status');
  ok(opened);
  await sleep(500);
  const stockLoaded = JSON.parse(await b.ev(`localStorage.getItem('hud')`));
  check(stockLoaded.preset === 'stock', 'design is stock');
  check(JSON.stringify(stockLoaded.elements.ownHealth) === JSON.stringify(STOCK_DESIGN.elements.ownHealth), `ownHealth override came through (${JSON.stringify(stockLoaded.elements.ownHealth)})`);
  check(stockLoaded.elements.chat?.visible === false, 'hidden chat came through');
  check(stockLoaded.elements.teamColumn?.dir === 'column', 'team column direction came through');

  const canvasColours = () => b.ev(`(() => {
    const c = [...document.querySelectorAll('canvas')].sort((x, y) => y.width * y.height - x.width * x.height)[0];
    const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    const seen = new Set();
    for (let i = 0; i < d.length; i += 4 * 97) seen.add((d[i] << 16) | (d[i + 1] << 8) | d[i + 2]);
    return seen.size;
  })()`);

  step('B: open the imported HUD in the editor');
  await b.go(`/hud?community=${ids.imported}`);
  await b.answerModal('Load link', 4000);
  const opened2 = await b.waitFor(`(() => { const m = /Opened [^\\n]+/.exec(document.body.innerText); return m ? m[0] : (/safety check|cannot be shown|no longer available/.exec(document.body.innerText)?.[0] ? 'ERROR ' + document.body.innerText.slice(0, 300) : null); })()`, 'the open status', 30000);
  check(!opened2.startsWith('ERROR'), opened2);
  await sleep(1500);
  const impLoaded = JSON.parse(await b.ev(`localStorage.getItem('hud')`));
  check(impLoaded.preset === 'imported' && impLoaded.imported?.id?.length === 64, `design is on import ${impLoaded.imported?.id?.slice(0, 12)}`);
  check(impLoaded.crosshair === aImported.crosshair && JSON.stringify(impLoaded.elements) === JSON.stringify(aImported.elements),
    `crosshair choice (${impLoaded.crosshair}) and element edits match what A shared (${aImported.crosshair})`);
  const stored = await b.ev(`new Promise((res) => { const r = indexedDB.open('hud-editor', 1);
    r.onsuccess = () => { const q = r.result.transaction('imports').objectStore('imports').getAll();
      q.onsuccess = () => res(q.result.map((h) => ({ id: h.id, name: h.name, community: h.community ?? null, files: h.files.size }))); q.onerror = () => res(null); };
    r.onerror = () => res(null); })`);
  const rec = stored?.find((h) => h.id === impLoaded.imported?.id);
  check(!!rec, `the import is stored in B's IndexedDB (${rec?.files} files)`);
  check(rec?.community?.entryId === ids.imported, `the stored import is flagged community (entry ${rec?.community?.entryId})`);
  const colours = await canvasColours();
  check(colours > 20, `the editor canvas is drawn (${colours} distinct sampled colours)`);
  await b.shoot('hud-opened-imported', null);

  step('B: download each entry and read the VPKs with python');
  await b.go('/community');
  for (const [key, ext] of [['stock', '.vpk'], ['imported', '.vpk']]) {
    await b.waitFor(`!!${cardExpr(TITLES[key])}`, `the ${key} card`);
    const before = new Set(readdirSync(b.dl));
    await b.ev(`[...${cardExpr(TITLES[key])}.querySelectorAll('button')].find((x) => x.textContent.trim() === 'Download').click()`);
    const file = await b.waitDownload(ext, before);
    const status = await b.waitFor(`${cardExpr(TITLES[key])}.querySelector('.ccard__status')?.textContent`, 'the download status');
    ok(`${key}: ${status}`);
    const files = checkVpk(file, `${key} download ${file.split('/').pop()}`);
    if (key === 'stock') check(files.has('scripts/hudlayout.res'), 'stock download carries scripts/hudlayout.res');
  }
  await b.go('/community?kind=crosshair');
  await b.waitFor(`!!${cardExpr(TITLES.xhair)}`, 'the crosshair card');
  {
    const before = new Set(readdirSync(b.dl));
    await b.ev(`[...${cardExpr(TITLES.xhair)}.querySelectorAll('button')].find((x) => x.textContent.includes('Download')).click()`);
    const file = await b.waitDownload('.vpk', before);
    const files = vpkPaths(file);
    check([...files.keys()].some((p) => p.startsWith('materials/vgui/hud/')), `crosshair download holds ${[...files.keys()].join(', ')}`);
  }

  step('B: report the imported HUD');
  await b.go(`/community/${ids.imported}`);
  await b.click('button.report', 'Report');
  await b.type('.report__form select', 'other');
  await b.type('.report__form textarea', 'End to end check: reporting a shared HUD.');
  await b.click('.report__form button[type=submit]', 'Send report');
  const reported = await b.waitFor(`(() => { const t = document.querySelector('.report')?.innerText ?? ''; return /Thanks|error|Could not/i.test(t) ? t : null; })()`, 'the report reply');
  check(reported.includes('Thanks'), `report: ${reported.split('\n').pop()}`);
  const db = new Database(DB_PATH, { readonly: true });
  const tables = db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE '%report%'`).all().map((t) => t.name);
  ok(`report tables: ${tables.join(', ')}`);
  db.close();

  // ------------------------------------------------------------------ staff removes
  step('Staff: remove the imported HUD');
  await s.go('/');
  await s.login(STAFF);
  {
    const w = new Database(DB_PATH);
    w.prepare('UPDATE players SET is_mod = 1 WHERE steamid = ?').run(STAFF);
    w.close();
  }
  await s.go(`/community/${ids.imported}`);
  await s.click('.ccard__mod button', 'Remove');
  await s.type('.ccard__remove input', 'End to end check: staff removal.');
  await s.click('.ccard__remove button[type=submit]', 'Remove entry');
  const gone = await s.waitFor(`document.querySelector('.ccard--gone')?.innerText`, 'the removal');
  check(gone.includes('Removed'), `staff card reads "${gone}"`);
  await s.go(`/community/${ids.imported}`);
  const staffView = await s.waitFor(`document.querySelector('.community__removed')?.innerText`, 'the staff view of the removed entry');
  ok(`staff still sees the evidence: "${staffView}"`);
  await s.shoot('entry-removed-staff', `/community/${ids.imported}`);

  step('B: the removed HUD is gone from the gallery and the profile');
  await b.go('/community');
  await b.waitFor(`!!${cardExpr(TITLES.stock)}`, 'the gallery');
  check(!(await b.ev(`!!${cardExpr(TITLES.imported)}`)), 'the removed HUD is off the gallery');
  await b.go(`/player/${A}`);
  const shared = await b.waitFor(`document.querySelector('.profile-shared')?.innerText`, 'the profile Shared panel');
  check(shared.includes(TITLES.stock) && shared.includes(TITLES.xhair), 'profile Shared lists the stock HUD and the crosshair');
  check(!shared.includes(TITLES.imported), 'profile Shared no longer lists the removed HUD');
  await b.shoot('profile-shared', `/player/${A}`, { before: () => b.waitFor(`!!document.querySelector('.profile-shared')`, 'the Shared panel') });
  await b.go(`/community/${ids.imported}`);
  const entryGone = await b.waitFor(`document.querySelector('.page')?.innerText.includes('This entry was removed')`, 'the removed entry page');
  check(entryGone, 'the entry page reads "This entry was removed." to B');
  const fileStatus = await b.ev(`fetch('/api/community/${ids.imported}').then((r) => r.status)`);
  check(fileStatus === 404, `GET /api/community/${ids.imported} is 404 for B`);
  await b.shoot('entry-page', `/community/${ids.stock}`);

  step('A: sees the removal on the share dialog and the entry');
  const mine = await a.ev(`fetch('/api/community/mine').then((r) => r.json())`);
  const mineRow = mine.entries.find((e) => e.id === ids.imported);
  check(mineRow?.removedByStaff !== null && mineRow?.removedByStaff !== undefined, `A's own list shows the staff removal (${JSON.stringify(mineRow?.removedByStaff)})`);
} catch (e) {
  fail(`aborted: ${e.message}`);
} finally {
  a.close(); b.close(); s.close();
}

console.log(`\n${failures ? `${failures} FAILED` : 'ALL PASSED'}; entries ${JSON.stringify(ids)}; shots in ${SHOTS}`);
process.exitCode = failures ? 1 : 0;
