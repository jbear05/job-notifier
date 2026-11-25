// Renders the icons, store assets, and designer-review shots with the local
// Chrome (or Edge) in headless mode, driven over the DevTools protocol on a pipe.
// No npm dependencies. Windows: store PNGs are re-saved as 24-bit RGB through
// PowerShell's System.Drawing, since Chrome writes RGBA.
//
//   node docs/assets/harness/render.js [review-dir]
//
// Without review-dir it renders only icons/*.png and docs/assets/*.png.
const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const ROOT = path.resolve(__dirname, '../../..');
const ASSETS = path.join(ROOT, 'docs/assets');
const REVIEW = process.argv[2];
const STUB = fs.readFileSync(path.join(__dirname, 'stub.js'), 'utf8');
const CHROME = process.env.CHROME || [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
].find(f => fs.existsSync(f));
const url = rel => pathToFileURL(path.join(ROOT, rel)).href;

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'jn-render-'));
const browser = spawn(CHROME, [
  '--headless', '--remote-debugging-pipe', `--user-data-dir=${profile}`, '--allow-file-access-from-files',
  '--hide-scrollbars', '--force-device-scale-factor=1', '--no-first-run', '--no-default-browser-check', 'about:blank',
], { stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'] });

// DevTools protocol over the pipe: NUL-terminated JSON both ways.
let nextId = 0;
let buf = '';
const pending = new Map();
browser.stdio[4].setEncoding('utf8');
browser.stdio[4].on('data', chunk => {
  buf += chunk;
  for (let i; (i = buf.indexOf('\0')) >= 0; buf = buf.slice(i + 1)) {
    const msg = JSON.parse(buf.slice(0, i));
    const p = pending.get(msg.id);
    if (!p) continue;
    pending.delete(msg.id);
    if (msg.error) p.reject(new Error(msg.error.message));
    else p.resolve(msg.result);
  }
});
const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
  const id = ++nextId;
  pending.set(id, { resolve, reject });
  browser.stdio[3].write(`${JSON.stringify({ id, method, params, sessionId })}\0`);
});
const sleep = ms => new Promise(r => setTimeout(r, ms));

// One capture. `full` sizes the viewport to the content height first.
async function shot({ page, out, width, height, state = '', full = false, transparent = false, scale = 1, svg = false }) {
  const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
  const cdp = (m, p) => send(m, p, sessionId);
  const evaluate = async expression => (await cdp('Runtime.evaluate', { expression, returnByValue: true })).result.value;
  const viewport = h => cdp('Emulation.setDeviceMetricsOverride', { width, height: h, deviceScaleFactor: 1, mobile: false });

  await viewport(full ? 100 : height);
  if (transparent) await cdp('Emulation.setDefaultBackgroundColorOverride', { color: { r: 0, g: 0, b: 0, a: 0 } });
  await cdp('Page.enable'); // without it the injected stub never runs
  await cdp('Page.addScriptToEvaluateOnNewDocument', { source: `window.__shot = ${JSON.stringify({ state })};\n${STUB}` });
  await cdp('Page.navigate', { url: page });

  const ready = svg
    ? "location.protocol === 'file:' && document.readyState === 'complete' ? 'ok' : ''"
    : "location.protocol === 'file:' && document.documentElement.dataset.shotReady || ''";
  for (const end = Date.now() + 15000; ;) {
    const status = await evaluate(ready).catch(() => '');
    if (status === 'ok') break;
    if (status) throw new Error(`${out}: ${status}`);
    if (Date.now() > end) throw new Error(`${out}: timed out waiting for the page`);
    await sleep(50);
  }
  if (full) {
    height = await evaluate('document.documentElement.scrollHeight');
    await viewport(height);
    await sleep(100);
  }
  const { data } = await cdp('Page.captureScreenshot', { format: 'png', clip: { x: 0, y: 0, width, height, scale } });
  fs.writeFileSync(out, Buffer.from(data, 'base64'));
  await send('Target.closeTarget', { targetId });
  console.log(`${path.relative(ROOT, out)}  ${Math.round(width * scale)}x${Math.round(height * scale)}`);
}

// Re-save as 24-bit RGB: the Web Store wants no alpha channel (criterion 21).
function toRgb(files) {
  const list = files.map(f => `'${f.replace(/'/g, "''")}'`).join(',');
  const ps = `Add-Type -AssemblyName System.Drawing
foreach ($f in @(${list})) {
  $src = New-Object System.Drawing.Bitmap $f
  $dst = New-Object System.Drawing.Bitmap $src.Width, $src.Height, ([System.Drawing.Imaging.PixelFormat]::Format24bppRgb)
  $g = [System.Drawing.Graphics]::FromImage($dst)
  $g.DrawImage($src, 0, 0, $src.Width, $src.Height)
  $g.Dispose(); $src.Dispose()
  $dst.Save($f, [System.Drawing.Imaging.ImageFormat]::Png); $dst.Dispose()
}`;
  const r = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', '-'], { input: ps, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`RGB conversion failed: ${r.stderr}`);
}

const harness = (file, hash = '') => `${url(`docs/assets/harness/${file}`)}${hash}`;
const asset = f => path.join(ASSETS, f);
const review = f => path.join(REVIEW, f);

async function main() {
  // Icons (spec Design: Icon). They keep their transparency.
  await shot({ page: url('docs/assets/icon.svg'), out: path.join(ROOT, 'icons/icon128.png'), width: 128, height: 128, transparent: true, svg: true });
  await shot({ page: url('docs/assets/icon.svg'), out: path.join(ROOT, 'icons/icon48.png'), width: 128, height: 128, scale: 48 / 128, transparent: true, svg: true });
  await shot({ page: url('docs/assets/icon-16.svg'), out: path.join(ROOT, 'icons/icon16.png'), width: 16, height: 16, transparent: true, svg: true });

  // Store assets (spec Design: Store assets).
  const store = [
    { page: harness('promo.html'), out: asset('promo-440x280.png'), width: 440, height: 280 },
    { page: harness('demo-confirmation.html', '#overlay'), state: 'results', out: asset('screenshot-1-overlay.png'), width: 1280, height: 800 },
    { page: harness('demo-posting.html', '#popup'), state: 'posting-found', out: asset('screenshot-2-popup.png'), width: 1280, height: 800 },
    { page: url('options.html'), state: 'settings', out: asset('screenshot-3-settings.png'), width: 1280, height: 800 },
  ];
  for (const s of store) await shot(s);
  toRgb(store.map(s => s.out));

  if (!REVIEW) return;
  fs.mkdirSync(REVIEW, { recursive: true });
  // Every popup state in the Design's state table, plus the auto-detect panel. Full content height.
  for (const state of ['setup', 'no-friends', 'no-friends-included', 'posting-found', 'not-a-posting', 'page-chrome-blocks',
    'read-failed', 'loading', 'results', 'no-matches', 'error', 'auto-detect-panel']) {
    await shot({ page: url('popup.html'), state, out: review(`popup-${state}.png`), width: 380, full: true });
  }
  for (const width of [1280, 800, 375]) {
    await shot({ page: url('options.html'), state: 'settings', out: review(`settings-${width}.png`), width, full: true });
  }
  await shot({ page: url('options.html'), state: 'first-run', out: review('settings-first-run-1280.png'), width: 1280, full: true });
  for (const [name, state, width, height] of [
    ['overlay-prompt', 'prompt', 1280, 800],
    ['overlay-prompt-no-key', 'prompt-no-key', 1280, 800],
    ['overlay-results', 'results', 1280, 800],
    ['overlay-narrow-prompt', 'prompt', 375, 812],
    ['overlay-narrow-results', 'results', 375, 812],
  ]) {
    await shot({ page: harness('demo-confirmation.html', '#overlay'), state, out: review(`${name}.png`), width, height });
  }
  await shot({ page: harness('demo-posting.html', '#popup'), state: 'posting-found', out: review('popup-on-posting-1280.png'), width: 1280, height: 800 });
}

main()
  .catch(e => { console.error(e.message); process.exitCode = 1; })
  .finally(() => {
    browser.kill();
    setTimeout(() => { try { fs.rmSync(profile, { recursive: true, force: true }); } catch (e) { /* Chrome may still hold it */ } }, 1000);
  });
