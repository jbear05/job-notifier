// Pre-checks docs/release-walkthrough.md in headless Chrome (or Edge) so the manual pass is shorter.
//
// Run from the repo root (Node 22+, no npm installs, nothing leaves 127.0.0.1):
//
//   node docs/walkthrough-auto/precheck.js [--browser chrome|edge|<exe path>] [--zip dist/job-notifier-2.0.0.zip]
//        [--work <scratch dir>] [--port 8080] [--results docs/walkthrough-auto/RESULTS.md] [--only A|B]
//
// About 7 minutes per browser. Use a new --work folder each time. Don't run two browsers at once on one port.
// Rows V1-V8 are security's real-Chrome checks from the vault review. #3 (V3) needs a relaunch that loads the
// extension from --load-extension, which only Edge accepts, so it runs as run C with --browser edge.
//
// - Unzips the release zip into <work>/ext-release, and makes <work>/ext-allsites: a test-only copy whose
//   manifest also lists https://*/* and http://*/* under host_permissions, because headless can't click
//   Chrome's permission prompt. Run A uses the release build; run B uses the copy for auto-detect and overlay steps.
// - Serves docs/ on 127.0.0.1:<port>; kestrel-grid.localhost and hire-portal.localhost resolve there.
// - Starts the browser headless with a fresh profile under <work>, loads the extension over the DevTools
//   protocol (Extensions.loadUnpacked, the protocol's Load unpacked), opens the real toolbar popup
//   (Extensions.triggerAction), and drives settings, pages, the overlay frame, and the service worker.
// - Every request goes through Fetch interception. api.anthropic.com is never contacted: its requests get
//   mocked replies in the shape lib/core.js parseResponse reads. The key is the placeholder sk-ant-placeholder.
// - Prints PASS / FAIL / NOT AUTOMATED per walkthrough step, writes <work>/results.json and screenshots in
//   <work>/shots, and with --results writes the markdown table. Exits 1 if anything failed.
'use strict';
const { spawn, execFileSync } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '../..');
const DOCS = path.join(ROOT, 'docs');
const PAGES = path.join(DOCS, 'walkthrough-pages');
const argv = process.argv.slice(2);
const arg = (name, def) => { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : def; };
const EXES = {
  chrome: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  edge: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
};
const EXE = EXES[arg('browser', 'chrome')] || arg('browser');
const IS_EDGE = /msedge/i.test(EXE);
const ZIP = path.resolve(ROOT, arg('zip', 'dist/job-notifier-2.0.0.zip'));
const WORK = path.resolve(arg('work', path.join(os.tmpdir(), `jn-precheck-${Date.now()}`)));
const PORT = Number(arg('port', '8080'));
const RESULTS = arg('results');
const SHOTS = path.join(WORK, 'shots');
const KEY = 'sk-ant-placeholder'; // passes the settings prefix check, too short to look like a real key
const PASS = 'walkthrough-pass-1';
const SITE = `http://kestrel-grid.localhost:${PORT}/walkthrough-pages`;
const ALL = ['https://*/*', 'http://*/*'];
const ERROR_RED = 'rgb(180, 35, 24)';
const PAYLOAD = '<img src=x onerror=alert(1)>';
const LINKEDIN = 'https://www.linkedin.com/in/example-recruiter';
// Vault messages that carry the passphrase, key, or friends go directly to the service worker.
const SECRET_TYPES = ['VAULT_SETUP', 'VAULT_UNLOCK', 'VAULT_CONVERT_LEGACY', 'VAULT_SAVE_CLAUDE', 'VAULT_SAVE_FRIENDS', 'VAULT_GET_DATA'];

const sleep = ms => new Promise(r => setTimeout(r, ms));
const J = JSON.stringify;
const short = (v, n = 220) => { const s = typeof v === 'string' ? v : J(v); return s && s.length > n ? `${s.slice(0, n)}…` : String(s); };
const log = (...a) => console.log(...a);

// ── Results ──

const STEPS = [
  ['1.1', 1, 'Install and first-run settings'], ['1.2', 1, 'No all-sites access at install'], ['1.3', 0, 'Popup before setup'], ['1.4', 0, 'Auto-detect section copy'],
  ['2.1', 0, 'Passphrase validation'], ['2.2', 1, 'Create passphrase'], ['2.3', 0, 'Popup after setup'],
  ['3.1', 0, 'Cost and data disclosure'], ['3.2', 0, 'Model menu'], ['3.3', 1, 'Save API key'], ['3.4', 1, 'Empty friends list and popup'],
  ['3.5', 0, 'Add friend, email check'], ['3.6', 0, 'Import demo-friends.json'], ['3.7', 1, 'Broken JSON import'], ['3.8', 0, 'Edit, exclude, remove'],
  ['3.9', 1, 'Export JSON'], ['3.10', 1, 'Storage contents'], ['3.11', 1, 'Popup reads a tab opened before install'], ['3.12', 0, 'Remove and restore the key'],
  ['4.1', 1, 'Lock now in settings'], ['4.2', 1, 'Wrong passphrase'], ['4.3', 1, 'Unlock'], ['4.4', 0, 'Two settings tabs stay in sync'],
  ['4.5', 1, 'Lock now in the popup'], ['4.6', 0, 'Unlock from the popup link'], ['4.7', 0, 'Worker stop keeps the session unlocked'], ['4.8', 1, 'Browser restart locks'],
  ['5.1', 1, 'Auto-detect panel, Deny'], ['5.2', 1, 'Allow registers the content script'], ['5.3', 1, 'Turn off removes script and access'],
  ['5.4', 0, 'Turn on from settings'], ['5.5', 1, 'Site access removed in Chrome'], ['5.6', 0, 'Auto-detect back on'],
  ['6.1', 1, 'Prompt appears, no request'], ['6.2', 1, 'Find friends sends one request'], ['6.3', 1, "Page can't read the overlay"], ['6.4', 1, 'Aggressive page CSS'],
  ['6.5', 1, 'Opener tab vs unrelated window'], ['6.6', 0, 'Locked prompt, then unlock'], ['6.7', 1, 'Lock while analyzing (overlay)'], ['6.8', 1, 'Lock while analyzing (popup)'],
  ['7.1', 0, 'One-page form (pushState)'], ['7.2', 0, 'pushState and hash keep the prompt'], ['7.3', 1, 'Reload clears the prompt'], ['7.4', 1, 'Auto-detect off removes the overlay'],
  ['8.1', 1, 'Overlay sender.url and inert frame'], ['8.2', 1, "Pages can't frame the overlay"], ['8.3', 1, 'HTML stays literal text'],
  ['8.4', 1, 'One request per double-click; offline'], ['8.5', 1, "Popup can't get vault data"],
  ['9.1', 0, 'Popup keyboard'], ['9.2', 0, 'Settings keyboard'], ['9.3', 0, 'Overlay keyboard'], ['9.4', 0, 'Overlay focus and scrim'],
  ['10.1', 0, 'Copy and Copy all (popup)'], ['10.2', 0, 'Copy failure (popup)'], ['10.3', 0, 'Copy in the overlay'], ['10.4', 0, 'Recruiter field'],
  ['10.5', 1, 'Open email'], ['10.6', 0, 'Open next email'], ['10.7', 0, 'Link note in drafts'],
  ['11.1', 1, 'Settings network'], ['11.2', 1, 'Popup network'], ['11.3', 1, 'Confirmation page network'], ['11.4', 1, 'Worker network log'], ['11.5', 0, 'Fonts and look'],
  ['12.1', 0, 'Unreadable vault'], ['12.2', 1, 'Forgot passphrase'], ['12.3', 1, 'Seed unencrypted 2.0.0 data'], ['12.4', 0, 'Erase existing data instead'], ['12.5', 1, 'Encrypt existing data'],
  ['13.1', 0, 'Screenshot 2: set up the state'], ['13.2', 0, 'Screenshot 2: snip the window'], ['13.3', 0, 'Screenshot 2: convert and npm test'],
  ['X1', 0, 'Extra: content-script negatives (32a)'], ['X2', 0, 'Extra: API error mapping (9, 25)'], ['X3', 0, 'Extra: what the request carries (15)'],
  ['X4', 0, 'Extra: closing a tab clears its posting'], ['X5', 0, 'Extra: no errors logged during the run'],
  ['X6', 0, 'Extra: vault messages use the worker-only port (security Low 2)'],
  // Security's real-Chrome checks from its vault review (docs/specs/passphrase-storage.md handoff log, 2026-11-26).
  ['V1', 1, 'Vault #1: a content script can\'t read the session key or see it change'], ['V2', 0, 'Vault #2: password-manager prompts'],
  ['V3', 1, 'Vault #3: a relaunch without re-adding the extension stays locked'], ['V4', 0, 'Vault #4: windows closed while Chrome keeps running'],
  ['V5', 1, 'Vault #5: an extension reload stays locked'], ['V6', 1, 'Vault #6: Lock right after Find friends sends no request'],
  ['V7', 1, 'Vault #7: no key, friend, passphrase, or session key in the profile\'s LevelDB'], ['V8', 0, 'Vault #8: storage setAccessLevel support (report)'],
];
const NOT_AUTOMATED = {
  '13.1': 'Needs a real Chrome window with its toolbar; headless has no browser UI.',
  '13.2': 'Windows snip of the real window.',
  '13.3': 'Depends on the 13.2 snip.',
  V2: 'Manual: headless shows no browser bubbles. Create the passphrase, unlock, and save the key in a windowed Chrome, and confirm Chrome never offers to save any of them as a password.',
  V3: IS_EDGE ? 'Run C did not run.' : 'Branded Chrome ignores --load-extension and drops DevTools-loaded extensions when it exits, so this runs only in Edge: --browser edge.',
  V4: 'Manual: headless has no windows. With Chrome set to keep running after its last window closes, close every window, reopen Chrome, and check the popup (still unlocked, which is why the copy says quit Chrome completely). Then quit Chrome completely and check it is locked.',
};
const R = new Map();
const rec = id => { if (!R.has(id)) R.set(id, { checks: [], notes: [], manual: '' }); return R.get(id); };
const report = {};
function check(id, pass, evidence) {
  rec(id).checks.push({ pass: !!pass, evidence });
  log(`   ${pass ? 'ok  ' : 'FAIL'} ${id} ${evidence}`);
  return !!pass;
}
function eq(id, label, actual, expected) {
  const pass = J(actual) === J(expected);
  return check(id, pass, `${label}: ${short(actual)}${pass ? '' : ` (expected ${short(expected)})`}`);
}
function note(id, text) { rec(id).notes.push(text); log(`   note ${id} ${text}`); }
function manual(id, text) { rec(id).manual = text; }
async function step(id, fn) {
  log(`-- ${id}`);
  try { await fn(); } catch (e) { check(id, false, `stopped: ${e.message.split('\n')[0]}`); }
}

// Page-side helpers prepended to every evaluation.
const PRE = [
  "const _q = (s, r = document) => r.querySelector(s), _qa = (s, r = document) => [...r.querySelectorAll(s)];",
  "const _id = i => document.getElementById(i), _vis = el => !!el && el.checkVisibility();",
  "const _t = el => el ? el.textContent.replace(/\\s+/g, ' ').trim() : null;",
  "const _btn = (t, r = document) => [...r.querySelectorAll('button, a')].find(b => _t(b) === t);",
  "const _el = s => s.startsWith('text=') ? _btn(s.slice(5)) : _q(s);",
  "const _ae = () => { const a = document.activeElement; return a ? (a.id || a.getAttribute('aria-label') || _t(a) || a.tagName) : null; };",
  "const _ring = el => { const t = el && el.matches('.switch input') ? el.nextElementSibling : el; const s = t && getComputedStyle(t);",
  "  return !!s && s.outlineStyle === 'solid' && s.outlineWidth === '2px' && s.outlineColor === 'rgb(15, 118, 110)'; };",
  "const _chip = n => { const li = _qa('#friend-list li').find(li => _t(_q('.friend-name span', li)) === n); return li ? !!_q('.chip', li) : null; };",
].join('\n');
const watch = id => `{ const el = _id(${J(id)}); new MutationObserver(() => { if (!el.hidden) window.__seen.push(_t(el)); }).observe(el, { attributes: true, attributeFilter: ['hidden'] }); }`;
const STUB_OPEN = "window.__opened = []; window.open = u => { window.__opened.push(String(u)); return null; }; return true;";
const STYLE = "(() => { const s = el => { const c = getComputedStyle(el); return [c.color, c.fontSize, c.fontFamily]; };"
  + " const b = getComputedStyle(_q('#panel-body .btn-primary')); return { heading: s(_id('state-heading')), body: s(_id('prompt-body')), button: [b.backgroundColor, b.color, b.fontSize] }; })()";
const LOOK = "(() => { const bad = []; for (const el of document.querySelectorAll('*')) { const s = getComputedStyle(el); const name = el.tagName + (el.id ? '#' + el.id : '') + (el.className && typeof el.className === 'string' ? '.' + el.className.split(' ')[0] : '');"
  + " if (/gradient/.test(s.backgroundImage)) bad.push('gradient ' + name); if (s.backdropFilter && s.backdropFilter !== 'none') bad.push('backdrop-filter ' + name); if (/blur/.test(s.filter)) bad.push('blur ' + name);"
  + " if (parseFloat(s.borderTopLeftRadius) > 4 && !el.classList.contains('spinner')) bad.push('radius ' + s.borderTopLeftRadius + ' ' + name); }"
  + " return { bad, emoji: /\\p{Extended_Pictographic}/u.test(document.body.innerText) }; })()";

// ── Browser over the DevTools pipe ──

function killStray(profile) {
  // Stops only processes of this browser whose command line names this run's profile folder.
  if (process.platform !== 'win32') return;
  const exe = path.basename(EXE).replace(/'/g, "''");
  const needle = profile.replace(/'/g, "''");
  const ps = `Get-CimInstance Win32_Process -Filter "Name='${exe}'" | Where-Object { $_.CommandLine -like '*${needle}*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`;
  try { execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', ps], { stdio: 'ignore', timeout: 30000 }); } catch (e) { /* nothing left */ }
}

class Browser {
  constructor(profile) { this.profile = profile; }

  start(extraArgs = []) {
    fs.mkdirSync(this.profile, { recursive: true });
    const args = ['--headless=new', '--remote-debugging-pipe', '--enable-unsafe-extension-debugging', `--user-data-dir=${this.profile}`,
      '--no-first-run', '--no-default-browser-check', '--window-size=1280,800', '--disable-background-networking', '--disable-component-update',
      '--disable-sync', '--disable-default-apps', '--no-pings', '--disable-domain-reliability', '--disable-client-side-phishing-detection', ...extraArgs, 'about:blank'];
    this.proc = spawn(EXE, args, { stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'] });
    this.exited = new Promise(r => this.proc.once('exit', r));
    this.nextId = 0;
    this.pending = new Map();
    this.listeners = new Set();
    let buf = '';
    this.proc.stdio[3].on('error', () => {});
    this.proc.stdio[4].setEncoding('utf8');
    this.proc.stdio[4].on('data', chunk => {
      buf += chunk;
      for (let i; (i = buf.indexOf('\0')) >= 0;) {
        const msg = JSON.parse(buf.slice(0, i));
        buf = buf.slice(i + 1);
        if (msg.id !== undefined) {
          const p = this.pending.get(msg.id);
          if (!p) continue;
          this.pending.delete(msg.id);
          clearTimeout(p.timer);
          if (msg.error) p.reject(new Error(`${p.method}: ${msg.error.message}`));
          else p.resolve(msg.result);
        } else {
          for (const l of [...this.listeners]) { try { l(msg); } catch (e) { log('event handler error:', e.message); } }
        }
      }
    });
  }

  send(method, params = {}, sessionId) {
    return new Promise((resolve, reject) => {
      const id = ++this.nextId;
      const timer = setTimeout(() => { if (this.pending.delete(id)) reject(new Error(`${method}: no reply in 60 s`)); }, 60000);
      this.pending.set(id, { resolve, reject, method, timer });
      this.proc.stdio[3].write(`${J({ id, method, params, sessionId })}\0`);
    });
  }

  on(fn) { this.listeners.add(fn); }

  async stop() {
    await Promise.race([this.send('Browser.close').catch(() => {}), sleep(5000)]);
    await Promise.race([this.exited, sleep(10000)]);
    if (this.proc.exitCode === null) this.proc.kill();
    killStray(this.profile);
  }
}

// ── API mock ──

function friendsIn(body) {
  const text = body?.messages?.[0]?.content || '';
  try { return JSON.parse(/<friends>\n([\s\S]*?)\n<\/friends>/.exec(text)[1]); } catch (e) { return []; }
}

function mockReply(body, plan) {
  if (plan.refusal) return { type: 'message', role: 'assistant', content: [], stop_reason: 'refusal' };
  if (plan.malformed) return { type: 'message', role: 'assistant', content: [{ type: 'text', text: 'not json' }], stop_reason: 'end_turn' };
  const title = plan.title || 'Data Engineering Intern';
  const matches = friendsIn(body).map((f, i) => ({
    id: f.id,
    score: Math.max(0.61, 0.92 - i * 0.05),
    message: `Hey ${f.name}, Kestrel Grid has a ${title} opening that lines up with your ${f.skills[0] || 'background'} work. Want me to pass it along?`,
  }));
  const job = { title, company: 'Kestrel Grid', skills: ['Python', 'SQL', 'Airflow'], level: 'Internship', location: 'Remote, United States', remote: true };
  return {
    id: 'msg_mock', type: 'message', role: 'assistant', model: body.model,
    content: [{ type: 'text', text: J({ job, matches }) }], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 },
  };
}

// ── One browser profile ──

class Run {
  constructor(name, extDir) {
    this.name = name;
    this.extDir = extDir;
    this.profile = path.join(WORK, `profile-${name}`);
    this.downloads = path.join(WORK, `downloads-${name}`);
    this.net = [];
    this.swNet = [];
    this.dialogs = [];
    this.dialogPlan = [];
    this.apiQueue = [];
    this.expectedApi = 0;
    this.logs = [];
    this.swSessions = new Set();
    this.swVersions = new Map();
  }

  async launch() {
    this.b = new Browser(this.profile);
    this.b.start(this.launchArgs);
    this.targets = new Map();
    this.frames = new Map();
    this.contexts = new Map();
    this.swSession = null;
    this.extS = null;
    this.settings = null;
    this.b.on(m => this.onEvent(m));
    this.version = (await this.b.send('Browser.getVersion')).product;
    await this.b.send('Target.setDiscoverTargets', { discover: true });
    await this.b.send('Fetch.enable', { patterns: [{ urlPattern: '*' }] });
    fs.mkdirSync(this.downloads, { recursive: true });
    await this.b.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: this.downloads, eventsEnabled: true });
    // Developer mode on, as in the walkthrough, so Chrome collects the extension's errors.
    await (await this.extPage()).raw('chrome.developerPrivate.updateProfileConfiguration({ inDeveloperMode: true })');
  }

  async install() {
    this.id = (await this.b.send('Extensions.loadUnpacked', { path: this.extDir })).id;
    this.origin = `chrome-extension://${this.id}`;
    await this.b.send('Browser.grantPermissions', { origin: this.origin, permissions: ['clipboardReadWrite', 'clipboardSanitizedWrite'] }).catch(() => {});
    return this.id;
  }

  async restart() {
    await this.b.stop();
    await this.launch();
    await this.install();
  }

  onEvent(m) {
    const p = m.params || {};
    switch (m.method) {
      case 'Target.targetCreated':
      case 'Target.targetInfoChanged':
        this.targets.set(p.targetInfo.targetId, p.targetInfo);
        for (const f of this.frames.values()) if (f.targetId === p.targetInfo.targetId) f.url = p.targetInfo.url;
        break;
      case 'Target.targetDestroyed': this.targets.delete(p.targetId); break;
      case 'Target.attachedToTarget':
        if (m.sessionId && p.targetInfo.type === 'iframe') {
          this.frames.set(p.sessionId, { parent: m.sessionId, url: p.targetInfo.url, targetId: p.targetInfo.targetId });
          this.b.send('Page.enable', {}, p.sessionId).catch(() => {});
          this.b.send('Runtime.enable', {}, p.sessionId).catch(() => {}); // the overlay's console, for X5
          this.b.send('Log.enable', {}, p.sessionId).catch(() => {});
          this.b.send('Emulation.setFocusEmulationEnabled', { enabled: true }, p.sessionId).catch(() => {});
        }
        break;
      case 'Target.detachedFromTarget': this.frames.delete(p.sessionId); break;
      case 'Fetch.requestPaused': if (!m.sessionId) this.onRequest(p); break;
      case 'Page.javascriptDialogOpening': this.onDialog(m); break;
      case 'Runtime.executionContextCreated':
        if (!this.contexts.has(m.sessionId)) this.contexts.set(m.sessionId, []);
        this.contexts.get(m.sessionId).push(p.context);
        break;
      case 'Runtime.executionContextsCleared': this.contexts.set(m.sessionId, []); break;
      case 'Log.entryAdded': this.logs.push({ session: m.sessionId, level: p.entry.level, text: p.entry.text }); break;
      case 'Runtime.consoleAPICalled':
        this.logs.push({ session: m.sessionId, level: p.type, text: p.args.map(a => a.value ?? a.description).join(' ') });
        break;
      case 'Runtime.exceptionThrown':
        this.logs.push({ session: m.sessionId, level: 'exception', text: p.exceptionDetails.exception?.description || p.exceptionDetails.text });
        break;
      case 'Debugger.paused': if (this.onPause) this.onPause(m); break;
      case 'ServiceWorker.workerVersionUpdated':
        for (const v of p.versions) this.swVersions.set(v.versionId, v);
        break;
      case 'Network.requestWillBeSent':
        if (this.swSessions.has(m.sessionId)) this.swNet.push({ t: Date.now(), id: p.requestId, method: p.request.method, url: p.request.url });
        break;
      case 'Network.loadingFailed':
        if (this.swSessions.has(m.sessionId)) {
          const e = this.swNet.find(x => x.id === p.requestId);
          if (e) e.failed = `${p.errorText}${p.canceled ? ' (canceled)' : ''}`;
        }
        break;
      default:
    }
  }

  async onRequest(p) {
    const { request, requestId, resourceType } = p;
    const entry = { t: Date.now(), method: request.method, url: request.url, type: resourceType };
    this.net.push(entry);
    if (!/^https:\/\/api\.anthropic\.com\//.test(request.url)) return this.b.send('Fetch.continueRequest', { requestId }).catch(() => {});
    const cors = [{ name: 'access-control-allow-origin', value: '*' }, { name: 'access-control-allow-headers', value: '*' }, { name: 'access-control-allow-methods', value: 'POST, OPTIONS' }];
    if (request.method === 'OPTIONS') return this.b.send('Fetch.fulfillRequest', { requestId, responseCode: 204, responseHeaders: cors }).catch(() => {});
    entry.api = true;
    const raw = request.postData ?? (request.postDataEntries || []).map(e => Buffer.from(e.bytes || '', 'base64').toString()).join('');
    let body = {};
    try { body = JSON.parse(raw); } catch (e) { /* recorded below */ }
    const hdr = Object.fromEntries(Object.entries(request.headers || {}).map(([k, v]) => [k.toLowerCase(), v]));
    entry.req = {
      model: body.model, keyIsPlaceholder: hdr['x-api-key'] === KEY, hasEmail: /@example\.com/.test(raw),
      hasRecruiter: /linkedin\.com/i.test(raw), friends: friendsIn(body).map(f => f.name), bodyParsed: !!body.model,
    };
    const plan = this.apiQueue.shift() || {};
    entry.plan = plan.offline ? 'offline' : plan.status ? `status ${plan.status}` : 'ok';
    await sleep(plan.delay ?? 400);
    if (plan.offline) {
      return this.b.send('Fetch.failRequest', { requestId, errorReason: 'InternetDisconnected' }).then(() => { entry.fulfill = 'failed as offline'; }, e => { entry.fulfill = `not delivered: ${e.message}`; });
    }
    const status = plan.status || 200;
    const json = status === 200 ? mockReply(body, plan) : { type: 'error', error: plan.error || { type: 'api_error', message: 'Mocked error' } };
    // A reason phrase is required for codes Chrome doesn't know (529), or the reply never arrives.
    return this.b.send('Fetch.fulfillRequest', {
      requestId, responseCode: status, responsePhrase: status === 200 ? 'OK' : 'Mocked error', responseHeaders: [{ name: 'content-type', value: 'application/json' }, ...cors],
      body: Buffer.from(J(json)).toString('base64'),
    }).then(() => { entry.fulfill = 'ok'; }, e => { entry.fulfill = `not delivered: ${e.message}`; });
  }

  onDialog(m) {
    const { type, message } = m.params;
    const now = Date.now();
    // The same dialog can be reported on the page and on its frame's session.
    const last = this.lastDialog;
    const dup = last && last.message === message && last.session !== m.sessionId && now - last.t < 300;
    const accept = dup ? last.accept : (this.dialogPlan.length ? this.dialogPlan.shift() : false);
    if (!dup) this.dialogs.push({ type, message });
    this.lastDialog = { message, t: now, accept, session: m.sessionId };
    // Under load the first answer can arrive before the dialog is up, so retry for a few seconds until one is accepted.
    (async () => {
      for (let i = 0; i < 10; i++) {
        if (await this.b.send('Page.handleJavaScriptDialog', { accept }, m.sessionId).then(() => true, () => false)) return;
        await sleep(300);
      }
    })();
  }

  mark() { return this.net.length; }
  api(since = 0) { return this.net.slice(since).filter(e => e.api); }

  wrap(sessionId, targetId) {
    const b = this.b;
    const run = this;
    const S = {
      sessionId, targetId,
      send: (method, params) => b.send(method, params, sessionId),
      async raw(expression, { gesture = false, contextId, timeout = 30000 } = {}) {
        const r = await Promise.race([
          b.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: gesture, contextId }, sessionId),
          sleep(timeout).then(() => { throw new Error(`evaluate timed out: ${short(expression, 80)}`); }),
        ]);
        if (r.exceptionDetails) throw new Error(`page error: ${(r.exceptionDetails.exception?.description || r.exceptionDetails.text).split('\n')[0]}`);
        return r.result.value;
      },
      js: (body, opts) => S.raw(`(async () => { ${PRE}\n${body}\n})()`, opts),
      v: (expr, opts) => S.js(`return (${expr});`, opts),
      text: sel => S.v(`_t(_el(${J(sel)}))`),
      async until(expr, timeout = 6000, label = expr) {
        const end = Date.now() + timeout;
        let last;
        for (;;) {
          try { last = await S.v(expr, { timeout: 5000 }); if (last) return last; } catch (e) { last = e.message; }
          if (Date.now() > end) throw new Error(`timed out waiting for ${short(label, 120)} (last: ${short(last, 120)})`);
          await sleep(100);
        }
      },
      click: sel => S.js(`const el = _el(${J(sel)}); if (!el) throw new Error('no element ' + ${J(sel)}); el.click(); return true;`, { gesture: true }),
      set: (sel, value) => S.js(`const el = _el(${J(sel)}); if (!el) throw new Error('no element ' + ${J(sel)}); el.value = ${J(value)};`
        + " el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); return true;"),
      center: sel => S.v(`(() => { const el = _el(${J(sel)}); if (!el) throw new Error('no element ' + ${J(sel)}); const r = el.getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2]; })()`),
      async mouse(x, y, clicks = 1) {
        await S.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
        for (let c = 1; c <= clicks; c++) {
          await S.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: c });
          await S.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: c });
        }
      },
      async key(name, shift = false) {
        const [code, text] = { Tab: [9], Enter: [13, '\r'], Escape: [27] }[name];
        const base = { key: name, code: name, windowsVirtualKeyCode: code, nativeVirtualKeyCode: code, modifiers: shift ? 8 : 0 };
        await S.send('Input.dispatchKeyEvent', { ...base, type: text ? 'keyDown' : 'rawKeyDown', text });
        await S.send('Input.dispatchKeyEvent', { ...base, type: 'keyUp' });
        await sleep(80);
      },
      async shot(name) {
        await b.send('Target.activateTarget', { targetId }).catch(() => {});
        const r = await Promise.race([S.send('Page.captureScreenshot', { format: 'png' }), sleep(15000)]).catch(() => null);
        if (!r) return `(screenshot ${name} failed)`;
        fs.mkdirSync(SHOTS, { recursive: true });
        const file = path.join(SHOTS, `${run.name}-${name}.png`);
        fs.writeFileSync(file, Buffer.from(r.data, 'base64'));
        return `shots/${path.basename(file)}`;
      },
      async fonts(selector) {
        await S.send('DOM.enable');
        await S.send('CSS.enable');
        const { root } = await S.send('DOM.getDocument', { depth: 0 });
        const { nodeId } = await S.send('DOM.querySelector', { nodeId: root.nodeId, selector });
        const { fonts } = await S.send('CSS.getPlatformFontsForNode', { nodeId });
        return fonts.map(f => f.familyName);
      },
    };
    return S;
  }

  async attach(targetId, { page = true } = {}) {
    const { sessionId } = await this.b.send('Target.attachToTarget', { targetId, flatten: true });
    const S = this.wrap(sessionId, targetId);
    if (page) {
      await S.send('Page.enable').catch(() => {});
      await S.send('Runtime.enable').catch(() => {});
      await S.send('Log.enable').catch(() => {});
      await S.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true }).catch(() => {});
      await S.send('Emulation.setFocusEmulationEnabled', { enabled: true }).catch(() => {});
    }
    return S;
  }

  async open(url, opts = {}) {
    const { targetId } = await this.b.send('Target.createTarget', { url: 'about:blank', ...opts });
    const S = await this.attach(targetId);
    if (url !== 'about:blank') await this.nav(S, url);
    return S;
  }

  async nav(S, url) {
    // Foreground tab, as when a person browses: background tabs in headless defer rendering work such as autofocus.
    await this.b.send('Target.activateTarget', { targetId: S.targetId }).catch(() => {});
    await S.send('Page.bringToFront').catch(() => {}); // focus back on the page, e.g. after a popup closed
    await S.send('Page.navigate', { url });
    await S.until(`location.href === ${J(url)} && document.readyState === 'complete'`, 10000, `load ${url}`);
  }

  close(S) { return this.b.send('Target.closeTarget', { targetId: S.targetId }).catch(() => {}); }

  async findTarget(pred, timeout = 8000, label = 'target') {
    const end = Date.now() + timeout;
    for (;;) {
      const t = [...this.targets.values()].find(pred);
      if (t) return t;
      if (Date.now() > end) throw new Error(`no ${label} within ${timeout} ms`);
      await sleep(100);
    }
  }

  async extPage() {
    if (!this.extS) this.extS = await this.open(IS_EDGE ? 'edge://extensions/' : 'chrome://extensions/');
    return this.extS;
  }

  async info() { return (await this.extPage()).raw(`chrome.developerPrivate.getExtensionInfo(${J(this.id)})`); }

  // Chrome's own site-access control (what the Details page's Site access menu calls).
  async siteAccess(hostAccess) {
    await (await this.extPage()).raw(`chrome.developerPrivate.updateExtensionConfiguration({ extensionId: ${J(this.id)}, hostAccess: ${J(hostAccess)} })`);
  }

  async sw() {
    const url = `${this.origin}/background.js`;
    const live = [...this.targets.values()].find(t => t.type === 'service_worker' && t.url === url);
    if (this.swSession && live && live.targetId === this.swSession.targetId) return this.swSession;
    if (!live && this.settings) await this.settings.raw("chrome.runtime.sendMessage({ type: 'WAKE' }).catch(() => 0)").catch(() => {});
    const t = live || await this.findTarget(x => x.type === 'service_worker' && x.url === url, 10000, 'service worker');
    const S = await this.attach(t.targetId, { page: false });
    this.swSessions.add(S.sessionId);
    await S.send('Runtime.enable').catch(() => {});
    await S.send('Network.enable').catch(() => {});
    // X6 records message types only. It never logs the values sent by settings.
    await S.raw(`globalThis.__jnChannels || (globalThis.__jnChannels = true,
      chrome.runtime.onMessage.addListener((m, s) => { console.debug('JNCHAN sendMessage', m && m.type, s.url); }),
      chrome.runtime.onConnect.addListener(p => p.onMessage.addListener(m => console.debug('JNCHAN port:' + p.name, m && m.type, p.sender.url))),
      self.addEventListener('message', e => { console.debug('JNCHAN service-worker', e.data?.type, e.source?.url); }))`).catch(() => {});
    this.swSession = S;
    return S;
  }

  // X6: vault message types seen per channel, from the worker-side log above.
  channels() {
    const lines = this.logs.filter(l => this.swSessions.has(l.session) && /^JNCHAN /.test(l.text)).map(l => l.text.split(' '));
    const settings = lines.filter(([, , , url]) => /^chrome-extension:\/\/[^/]+\/options\.html(?:[?#]|$)/.test(url || ''));
    return {
      extensionMessages: settings.filter(([, channel]) => channel !== 'service-worker').map(([, , type]) => type),
      directMessages: settings.filter(([, channel]) => channel === 'service-worker').map(([, , type]) => type),
    };
  }

  async swv(expr) { return (await this.sw()).raw(`(async () => (${expr}))()`); }

  async swUntil(expr, timeout = 8000, label = expr) {
    const end = Date.now() + timeout;
    for (;;) {
      const v = await this.swv(expr).catch(() => null);
      if (v) return v;
      if (Date.now() > end) throw new Error(`timed out waiting for ${short(label, 120)}`);
      await sleep(150);
    }
  }

  async snippets() { return this.swv(`[await chrome.scripting.getRegisteredContentScripts(), await chrome.permissions.contains({ origins: ${J(ALL)} })]`); }

  async tabTarget(page) {
    const tabs = (await this.b.send('Target.getTargets', { filter: [{ type: 'tab' }] })).targetInfos;
    const same = tabs.find(t => t.targetId === page.targetId);
    if (same) return same.targetId;
    const href = await page.v('location.href');
    const m = tabs.filter(t => t.url === href);
    if (m.length !== 1) throw new Error(`can't tell which tab shows ${href} (${m.length} matches)`);
    return m[0].targetId;
  }

  // The real toolbar popup for `page`'s tab (Extensions.triggerAction, like clicking the icon).
  async popup(page) {
    const url = `${this.origin}/popup.html`;
    for (const t of [...this.targets.values()]) if (t.type === 'page' && t.url === url) await this.b.send('Target.closeTarget', { targetId: t.targetId }).catch(() => {});
    // The popup reads the active tab, so bring this one to the front first, as clicking the icon would.
    await this.b.send('Target.activateTarget', { targetId: page.targetId });
    await sleep(300);
    const before = new Set(this.targets.keys());
    await this.b.send('Extensions.triggerAction', { id: this.id, targetId: await this.tabTarget(page) });
    const t = await this.findTarget(x => x.type === 'page' && x.url === url && !before.has(x.targetId), 8000, 'popup');
    const P = await this.attach(t.targetId);
    await P.until("_q('#panel h2') && _t(_q('#panel h2'))", 8000, 'popup state');
    return P;
  }

  async overlay(page, timeout = 8000) {
    const end = Date.now() + timeout;
    for (;;) {
      for (const [sid, f] of this.frames) {
        if (f.parent !== page.sessionId || !/\/overlay\.html$/.test(f.url)) continue;
        const O = this.wrap(sid, f.targetId);
        // Ready means rendered in the frame and made clickable by content.js (OVERLAY_READY).
        const ready = await O.v("!!_id('dialog') && !_id('dialog').hidden && !!_t(_id('state-heading'))", { timeout: 3000 }).catch(() => false)
          && await page.v("(_q('iframe[title=\"Job Notifier\"]') || {}).style?.pointerEvents === 'auto'").catch(() => false);
        if (ready) return O;
      }
      if (Date.now() > end) throw new Error('no overlay prompt');
      await sleep(100);
    }
  }

  hasFrame(page) { return page.v("!!_q('iframe[title=\"Job Notifier\"]')"); }

  // What a Find friends click led to: the results heading, or the overlay closing.
  async outcome(page, O, timeout = 10000) {
    const end = Date.now() + timeout;
    while (Date.now() < end) {
      if (!(await this.hasFrame(page).catch(() => true))) return 'overlay closed';
      const h = await O.text('#state-heading').catch(() => null);
      if (h && /might want this job$/.test(h)) return h;
      await sleep(100);
    }
    return 'no results';
  }

  // The content script's isolated world in `page`'s top frame (latest document).
  contentWorld(page) {
    return (this.contexts.get(page.sessionId) || []).filter(c => c.auxData?.type === 'isolated' && (c.name === 'Job Notifier' || (c.origin || '').startsWith('chrome-extension://'))).pop();
  }

  async setFile(S, sel, file) {
    await S.send('DOM.enable');
    const { result } = await S.send('Runtime.evaluate', { expression: `document.querySelector(${J(sel)})` });
    await S.send('DOM.setFileInputFiles', { files: [file], objectId: result.objectId });
  }

  async unlock(S, pass = PASS) {
    await S.js(`_id('unlock-passphrase').value = ${J(pass)}; _id('unlock-submit').click(); return true;`);
    await S.until("_t(_id('vault-heading')) === 'Passphrase lock' && _vis(_id('claude'))", 10000, 'unlocked');
    await sleep(400);
  }

  async lock(S) {
    await S.click('#lock-btn');
    await S.until("_t(_id('vault-heading')) === 'Unlock saved data'", 6000, 'locked');
  }

  async settingsTab() {
    const t = await this.findTarget(x => x.type === 'page' && x.url === `${this.origin}/options.html`, 6000, 'settings tab').catch(() => null);
    const S = t ? await this.attach(t.targetId) : await this.open(`${this.origin}/options.html`);
    this.settings = S;
    return S;
  }

  async waitJob(tabId, since) {
    await this.swUntil(`((await chrome.storage.session.get('jobs')).jobs || {})[${tabId}]?.seenAt > ${since}`, 8000, 'posting recorded by the worker');
  }

  async posting(page, tabId, url = `${SITE}/posting.html`) {
    const t = Date.now() - 500;
    await this.nav(page, url);
    await this.waitJob(tabId, t);
  }

  async confirm(page, tabId, link = 'a.apply') {
    await this.posting(page, tabId);
    await page.click(link);
    return this.overlay(page);
  }

  async results(S, headingSel) {
    await S.until(`/might want this job$/.test(_t(_q(${J(headingSel)})) || '')`, 12000, 'results');
  }

  async waitFile(file, timeout = 8000) {
    const end = Date.now() + timeout;
    while (!fs.existsSync(file)) {
      if (Date.now() > end) throw new Error(`no download at ${file}`);
      await sleep(150);
    }
    await sleep(300);
  }
}

// ── Run A: the release build ──

async function runA() {
  const A = new Run('A', path.join(WORK, 'ext-release'));
  await A.launch();
  report.versionA = A.version;
  // Opened before install and never reloaded (step 3.11).
  let first = await A.open(`${SITE}/posting.html?opened=before-install`);
  const m0 = A.mark();
  await A.install();
  report.idA = A.id;
  let S;

  await step('1.1', async () => {
    const t = await A.findTarget(x => x.type === 'page' && x.url === `${A.origin}/options.html`, 10000, 'settings tab opened on install');
    check('1.1', true, 'a settings tab opened by itself');
    S = A.settings = await A.attach(t.targetId);
    await S.until("_t(_id('vault-heading')) === 'Create a passphrase'", 8000);
    await sleep(1500);
    const info = await A.info();
    eq('1.1', 'card name, version, state', [info.name, info.version, info.state], ['Job Notifier', '2.0.0', 'ENABLED']);
    eq('1.1', 'Errors on the card (manifest, runtime)', [info.manifestErrors.length, info.runtimeErrors.length], [0, 0]);
    eq('1.1', 'lede', await S.text('#page-lede'), 'Create a passphrase to encrypt your API key and friends list in this browser.');
    eq('1.1', 'Claude, Friends visible', await S.v("[_vis(_id('claude')), _vis(_id('friends'))]"), [false, false]);
    eq('1.1', 'Auto-detect, Privacy and data visible', await S.v("[_vis(_id('auto-detect')), _vis(_id('privacy'))]"), [true, true]);
    // The already-open test page may fetch its own favicon from the local server; that isn't the extension.
    const outside = A.net.slice(m0).filter(e => /^https?:/.test(e.url) && !/^http:\/\/[a-z-]+\.localhost:/.test(e.url));
    eq('1.1', 'network requests at install (besides the test page\'s own)', outside.map(e => e.url), []);
  });

  await step('1.2', async () => {
    const info = await A.info();
    const rhp = info.permissions.runtimeHostPermissions || {};
    eq('1.2', 'site access', (rhp.hosts || []).map(h => `${h.host} granted=${h.granted}`), ['https://api.anthropic.com/* granted=true']);
    eq('1.2', 'hasAllHosts', rhp.hasAllHosts, false);
    const msgs = info.permissions.simplePermissions.map(p => p.message);
    check('1.2', !msgs.some(x => /all (web)?sites/i.test(x)), `permission lines: ${J(msgs)}`);
    const E = await A.extPage();
    await A.nav(E, `${IS_EDGE ? 'edge' : 'chrome'}://extensions/?id=${A.id}`);
    await sleep(800);
    note('1.2', `headless Details page: ${await E.shot('1.2-details')}`);
    manual('1.2', 'Report screenshot of the Details page from real Chrome, if the lead wants one from a windowed run.');
  });

  await step('V8', async () => {
    const r = await A.swv('[typeof chrome.storage.local.setAccessLevel, typeof chrome.storage.session.setAccessLevel]');
    check('V8', true, `reported: storage.local.setAccessLevel is ${r[0]}, storage.session.setAccessLevel is ${r[1]} (the extension never calls either)`);
  });

  await step('1.3', async () => {
    const P = await A.popup(S);
    eq('1.3', 'heading', await P.text('#panel h2'), 'Set up Job Notifier');
    const body = await P.text('#panel p');
    check('1.3', body.startsWith('Job Notifier encrypts your Anthropic API key and friends list in this browser. Open settings to create a passphrase'), `body: ${short(body)}`);
    eq('1.3', 'primary button', await P.v("_qa('#panel .btn-primary').map(_t)"), ['Open settings']);
    eq('1.3', 'error styling, "failed" wording', await P.v("[!!_q('.error-block'), /failed/i.test(document.body.innerText)]"), [false, false]);
    eq('1.3', 'footer hidden, switch checked', await P.v("[_id('popup-footer').hidden, _id('auto-toggle').checked]"), [true, false]);
    await A.close(P);
  });

  await step('1.4', async () => {
    eq('1.4', 'subtitle', await S.text('#auto-detect .section-intro p'), 'Off unless you turn it on.');
    eq('1.4', 'switch checked', await S.v("_id('auto-toggle').checked"), false);
    const help = await S.text('#auto-help-1');
    check('1.4', help.endsWith('Nothing is sent until you click Find friends.'), `help: …${help.slice(-60)}`);
  });

  await step('2.1', async () => {
    const submit = async (a, b) => { await S.js(`_id('setup-passphrase').value = ${J(a)}; _id('setup-confirm').value = ${J(b)}; _id('setup-submit').click(); return true;`); await sleep(300); };
    await submit('', '');
    eq('2.1', 'empty: error, aria-invalid, focus, border', await S.v("[_t(_id('setup-passphrase-error')), _id('setup-passphrase').getAttribute('aria-invalid'), document.activeElement.id, getComputedStyle(_id('setup-passphrase')).borderTopColor]"),
      ['Enter a passphrase.', 'true', 'setup-passphrase', ERROR_RED]);
    await submit('short', 'short');
    eq('2.1', 'short', await S.text('#setup-passphrase-error'), 'Use at least 8 characters (not all spaces).');
    await submit(PASS, 'walkthrough-pass-2');
    eq('2.1', 'mismatch: error, aria-invalid, border, cleared, focus', await S.v("[_t(_id('setup-confirm-error')), _id('setup-confirm').getAttribute('aria-invalid'), getComputedStyle(_id('setup-confirm')).borderTopColor, _id('setup-confirm').value, document.activeElement.id]"),
      ["Passphrases don't match. Enter the same passphrase in both fields.", 'true', ERROR_RED, '', 'setup-confirm']);
  });

  await step('2.2', async () => {
    const m = A.mark();
    await S.js(`window.__seen = []; ${watch('setup-pending')} _id('setup-passphrase').value = ${J(PASS)}; _id('setup-confirm').value = ${J(PASS)}; _id('setup-submit').click(); return true;`);
    await S.until("_t(_id('vault-status')) === 'Passphrase created. Unlocked for this session.'", 10000);
    check('2.2', (await S.v('window.__seen')).includes('Encrypting and saving…'), `pending text seen: ${J(await S.v('window.__seen'))}`);
    eq('2.2', 'heading, Lock now, Claude, Friends', await S.v("[_t(_id('vault-heading')), _vis(_id('lock-btn')), _vis(_id('claude')), _vis(_id('friends'))]"), ['Passphrase lock', true, true, true]);
    eq('2.2', 'passphrase fields', await S.v("[_id('setup-passphrase').value, _id('setup-confirm').value]"), ['', '']);
    eq('2.2', 'network requests', A.net.slice(m).filter(e => /^https?:/.test(e.url)).length, 0);
  });

  await step('2.3', async () => {
    const P = await A.popup(S);
    eq('2.3', 'heading', await P.text('#panel h2'), 'Set up Job Notifier');
    const body = await P.text('#panel p');
    check('2.3', body.includes('It uses your own Anthropic API key, so you pay Anthropic directly for each analysis'), `body: ${short(body)}`);
    eq('2.3', 'icon, error styling, "failed"', await P.v("[_qa('#panel img, #panel svg').length, !!_q('.error-block'), /failed/i.test(document.body.innerText)]"), [0, false, false]);
    eq('2.3', 'footer', await P.v("[!_id('popup-footer').hidden, _t(_q('#popup-footer span')), _t(_id('popup-lock-btn'))]"), [true, 'Unlocked for this session', 'Lock now']);
    note('2.3', `screenshot: ${await P.shot('2.3-popup')}`);
    await A.close(P);
  });

  await step('3.1', async () => {
    const d = await S.text('#claude .disclosure');
    eq('3.1', 'title', await S.text('#claude .disclosure .label'), 'What it costs and what gets sent');
    for (const part of ['billed to your Anthropic account', "the job posting text (up to 8,000 characters), and each included friend's name, skills, interests, and level",
      'Never sent:', 'email addresses', 'recruiter link', 'Your passphrase never leaves this browser.', 'Encrypted with your passphrase.']) {
      check('3.1', d.includes(part), `disclosure has "${short(part, 60)}"`);
    }
    eq('3.1', 'key field type, show toggle', await S.v("[_id('api-key').type, _qa('button', _id('api-key').closest('.field')).length]"), ['password', 0]);
    await S.js("_q('#claude .disclosure').scrollIntoView(); return true;");
    note('3.1', `screenshot: ${await S.shot('3.1-disclosure')}`);
  });

  await step('3.2', async () => {
    eq('3.2', 'options', await S.v("_qa('#model option').map(o => o.textContent)"), ['Claude Haiku 5.5 (default, lower cost)', 'Claude Sonnet 5.5', 'Claude Opus 5.5']);
    eq('3.2', 'selected', await S.v("_id('model').value"), 'claude-haiku-5-5');
  });

  await step('3.3', async () => {
    const m = A.mark();
    await S.set('#api-key', KEY);
    await S.click('#claude-save');
    await S.until("_t(_id('claude-status')) === 'Saved. Next, add at least one friend below.'");
    eq('3.3', 'key field masked', await S.v("_id('api-key').type"), 'password');
    eq('3.3', 'network requests', A.net.slice(m).filter(e => /^https?:/.test(e.url)).length, 0);
  });

  await step('3.4', async () => {
    eq('3.4', 'empty text, add form open, Export shown', await S.v("[_t(_id('friends-empty')), _vis(_id('friend-form')), _vis(_id('export-btn'))]"),
      ["No friends yet. Add the people you'd share job postings with.", true, false]);
    note('3.4', `settings screenshot: ${await S.shot('3.4-friends')}`);
    const P = await A.popup(S);
    eq('3.4', 'popup', await P.v("[_t(_q('#panel h2')), _t(_q('#panel p')), _qa('#panel button').map(_t)]"),
      ['Add a friend first', "Your friends list is empty, so there's no one to match a posting to.", ['Add friends']]);
    note('3.4', `popup screenshot: ${await P.shot('3.4-popup')}`);
    const before = new Set(A.targets.keys());
    await P.click('text=Add friends');
    const t = await A.findTarget(x => x.type === 'page' && !before.has(x.targetId) && x.url.startsWith(`${A.origin}/options.html`), 5000, 'settings tab');
    eq('3.4', 'Add friends opens', t.url.replace(A.origin, ''), '/options.html#friends');
    await A.b.send('Target.closeTarget', { targetId: t.targetId });
    await A.close(P);
  });

  await step('3.5', async () => {
    await S.set('#f-name', 'Test Friend');
    await S.set('#f-email', 'not-an-email');
    await S.click('#form-submit');
    await sleep(200);
    eq('3.5', 'bad email: error, aria-invalid, border, focus', await S.v("[_t(_id('f-email-error')), _id('f-email').getAttribute('aria-invalid'), getComputedStyle(_id('f-email')).borderTopColor, document.activeElement.id]"),
      ['Enter an email like name@example.com, or leave it blank.', 'true', ERROR_RED, 'f-email']);
    await S.set('#f-email', 'test.friend@example.com');
    await S.click('#form-submit');
    await S.until("_t(_id('friends-status')) === 'Added Test Friend.'");
    check('3.5', true, 'status: Added Test Friend.');
  });

  await step('3.6', async () => {
    await A.setFile(S, '#import-file', path.join(PAGES, 'demo-friends.json'));
    await S.until("_t(_id('import-summary')) === 'demo-friends.json has 4 friends. Your list has 1.'");
    check('3.6', true, 'summary: demo-friends.json has 4 friends. Your list has 1.');
    await S.click('#import-add');
    await S.until("_t(_id('friends-status')) === 'Added 4 friends from demo-friends.json.'");
    eq('3.6', 'friends in the list', await S.v("_qa('#friend-list li').length"), 5);
  });

  await step('3.7', async () => {
    await A.setFile(S, '#import-file', path.join(PAGES, 'bad-import.json'));
    await S.until("_t(_id('import-error'))");
    eq('3.7', 'error', await S.text('#import-error'), "Couldn't import bad-import.json: it isn't valid JSON.");
    eq('3.7', 'friends in the list', await S.v("_qa('#friend-list li').length"), 5);
  });

  await step('3.8', async () => {
    await S.click('[aria-label="Edit Test Friend"]');
    await S.set('#f-level', 'Senior');
    await S.click('#form-submit');
    await S.until("_t(_id('friends-status')) === 'Saved changes to Test Friend.'");
    check('3.8', true, 'status: Saved changes to Test Friend.');
    await S.click('[aria-label="Include Dana Okafor in matching"]');
    await S.until("_chip('Dana Okafor') === true");
    check('3.8', true, 'Dana Okafor shows the Excluded chip');
    const d0 = A.dialogs.length;
    A.dialogPlan = [false];
    await S.click('[aria-label="Remove Test Friend"]');
    await sleep(400);
    eq('3.8', 'dialog', A.dialogs.slice(d0).map(d => `${d.type}: ${d.message}`), ['confirm: Remove Test Friend from your friends list?']);
    eq('3.8', 'Cancel keeps the friend (rows)', await S.v("_qa('#friend-list li').length"), 5);
    A.dialogPlan = [true];
    await S.click('[aria-label="Remove Test Friend"]');
    await S.until("_t(_id('friends-status')) === 'Removed Test Friend.'");
    eq('3.8', 'OK removes (rows)', await S.v("_qa('#friend-list li').length"), 4);
  });

  await step('3.9', async () => {
    check('3.9', (await S.text('#export-note')).startsWith('Exports a readable, unencrypted JSON file'), `note: ${short(await S.text('#export-note'), 80)}`);
    const file = path.join(A.downloads, 'job-notifier-friends.json');
    await S.click('#export-btn');
    await A.waitFile(file);
    const text = fs.readFileSync(file, 'utf8');
    const list = JSON.parse(text);
    eq('3.9', 'entries', list.map(f => f.name), ['Priya Shah', 'Marcus Lee', 'Dana Okafor', 'Leo Martins']);
    eq('3.9', 'fields', [...new Set(list.map(o => Object.keys(o).sort().join(',')))], ['contact,interests,level,name,notify,skills']);
    check('3.9', !/sk-ant-|apiKey|vault|"model"|threshold|walkthrough-pass/.test(text), 'no key, settings, or vault fields in the file');
  });

  await step('3.10', async () => {
    const r = await A.swv(`(async () => {
      const local = await chrome.storage.local.get(null), session = await chrome.storage.session.get(null), sync = await chrome.storage.sync.get(null);
      const all = JSON.stringify([local, session, sync]);
      return { local: Object.keys(local).sort(), settings: local.settings, v: local.vault.v, kdf: local.vault.kdf, session: Object.keys(session), sync,
        includes: ['sk-ant-', 'Priya', 'priya.shah@example.com', ${J(PASS)}].map(s => s + ': ' + all.includes(s)), iv: local.vault.cipher.iv };
    })()`);
    check('3.10', r.local.includes('vault') && r.local.includes('settings') && !r.local.includes('friends'), `local keys: ${J(r.local)}`);
    eq('3.10', 'settings keys', Object.keys(r.settings).sort(), ['effort', 'model', 'threshold']);
    eq('3.10', 'vault.v and kdf', [r.v, r.kdf.name, r.kdf.hash, r.kdf.iterations, typeof r.kdf.salt === 'string' && r.kdf.salt.length > 0], [1, 'PBKDF2', 'SHA-256', 600000, true]);
    eq('3.10', 'session has vaultKey, sync', [r.session.includes('vaultKey'), r.sync], [true, {}]);
    eq('3.10', 'includes', r.includes, ['sk-ant-: false', 'Priya: false', 'priya.shah@example.com: false', `${PASS}: false`]);
    await S.click('[aria-label="Include Dana Okafor in matching"]');
    await S.until("_chip('Dana Okafor') === false");
    eq('3.10', 'fresh nonce after re-including Dana', await A.swv(`(await chrome.storage.local.get('vault')).vault.cipher.iv !== ${J(r.iv)}`), true);
    report.storage = r;
  });

  await step('3.11', async () => {
    const m = A.mark();
    const P = await A.popup(first);
    eq('3.11', 'heading', await P.text('#panel h2'), 'Job posting found');
    check('3.11', (await P.v("_id('posting').value")).includes('Kestrel Grid builds forecasting software'), 'the posting text is in the box');
    eq('3.11', 'requests', A.api(m).length, 0);
    await A.close(P);
  });

  await step('3.12', async () => {
    await S.set('#api-key', '');
    await S.click('#claude-save');
    await S.until("_t(_id('claude-status')) === 'Saved. Your API key was removed from this browser.'");
    check('3.12', true, 'status: Saved. Your API key was removed from this browser.');
    const P = await A.popup(first);
    eq('3.12', 'popup', [await P.text('#panel h2'), (await P.text('#panel p')).includes('It uses your own Anthropic API key')], ['Set up Job Notifier', true]);
    await A.close(P);
    await S.set('#api-key', KEY);
    await S.click('#claude-save');
    await S.until("_t(_id('claude-status')) === 'Saved.'");
    check('3.12', true, 'status after pasting the key back: Saved.');
  });

  await step('4.1', async () => {
    await S.js(`window.__seen = []; ${watch('lock-pending')} _id('lock-btn').click(); return true;`);
    await S.until("_t(_id('vault-heading')) === 'Unlock saved data'");
    check('4.1', (await S.v('window.__seen')).includes('Locking…'), `pending text seen: ${J(await S.v('window.__seen'))}`);
    eq('4.1', 'status, Claude, Friends', await S.v("[_t(_id('unlock-status')), _vis(_id('claude')), _vis(_id('friends'))]"), ['Locked. Your API key and friends were cleared from memory.', false, false]);
    eq('4.1', "session.get('vaultKey')", await A.swv("chrome.storage.session.get('vaultKey')"), {});
    const P = await A.popup(first);
    eq('4.1', 'popup', await P.v("[_t(_q('#panel h2')), _qa('#panel button').map(_t), _id('popup-footer').hidden]"), ['Locked', ['Open settings to unlock'], true]);
    await A.close(P);
  });

  await step('4.2', async () => {
    const before = await A.swv("JSON.stringify((await chrome.storage.local.get('vault')).vault)");
    await S.js(`window.__seen = []; ${watch('unlock-pending')} _id('unlock-passphrase').value = 'wrong-pass-123'; _id('unlock-submit').click(); return true;`);
    await S.until("_t(_id('unlock-passphrase-error'))", 10000);
    check('4.2', (await S.v('window.__seen')).includes('Unlocking saved data…'), `pending text seen: ${J(await S.v('window.__seen'))}`);
    eq('4.2', 'error, aria-invalid, border, cleared, focus, heading', await S.v("[_t(_id('unlock-passphrase-error')), _id('unlock-passphrase').getAttribute('aria-invalid'), getComputedStyle(_id('unlock-passphrase')).borderTopColor, _id('unlock-passphrase').value, document.activeElement.id, _t(_id('vault-heading'))]"),
      ['Wrong passphrase. Try again, or use Forgot passphrase? to erase saved data and start over.', 'true', ERROR_RED, '', 'unlock-passphrase', 'Unlock saved data']);
    eq('4.2', 'vault unchanged', await A.swv(`JSON.stringify((await chrome.storage.local.get('vault')).vault) === ${J(before)}`), true);
  });

  await step('4.3', async () => {
    const m = A.mark();
    await A.unlock(S);
    await S.until("_qa('#friend-list li').length === 4");
    eq('4.3', 'key field, friends, Dana excluded', await S.v("[_id('api-key').value === 'sk-ant-placeholder', _id('api-key').type, _qa('#friend-list li').length, _chip('Dana Okafor')]"), [true, 'password', 4, false]);
    eq('4.3', 'network requests', A.net.slice(m).filter(e => /^https?:/.test(e.url)).length, 0);
  });

  let S2;
  await step('4.4', async () => {
    S2 = await A.open(`${A.origin}/options.html`);
    await S2.until("_t(_id('vault-heading')) === 'Passphrase lock' && _qa('#friend-list li').length === 4");
    await A.lock(S);
    await S2.until("_t(_id('vault-heading')) === 'Unlock saved data'");
    eq('4.4', 'tab B after Lock now in tab A: key, friends, Claude', await S2.v("[_id('api-key').value, _qa('#friend-list li').length, _vis(_id('claude'))]"), ['', 0, false]);
    await A.unlock(S);
    await S2.until("_t(_id('vault-heading')) === 'Passphrase lock' && _qa('#friend-list li').length === 4");
    check('4.4', true, 'tab B shows Passphrase lock and 4 friends after unlocking in tab A');
    await S2.click('[aria-label="Include Marcus Lee in matching"]');
    await S.until("_chip('Marcus Lee') === true");
    check('4.4', true, 'tab A shows Excluded for Marcus after the change in tab B');
    await S2.until("!!_q('[aria-label=\"Include Marcus Lee in matching\"]')");
    await S2.click('[aria-label="Include Marcus Lee in matching"]');
    await S.until("_chip('Marcus Lee') === false");
  });

  await step('4.5', async () => {
    const P = await A.popup(first);
    await P.click('#popup-lock-btn');
    await P.until("_t(_q('#panel h2')) === 'Locked'");
    eq('4.5', 'heading focused', await P.v("document.activeElement === _q('#panel h2')"), true);
    await S.until("_t(_id('vault-heading')) === 'Unlock saved data'");
    await S2.until("_t(_id('vault-heading')) === 'Unlock saved data'");
    check('4.5', true, 'both settings tabs show Unlock saved data');
    await A.close(P);
  });

  await step('4.6', async () => {
    const m = A.mark();
    let P = await A.popup(first);
    const before = [...A.targets.values()].filter(t => t.url.startsWith(`${A.origin}/options.html`)).length;
    await P.click('text=Open settings to unlock');
    await sleep(800);
    const after = [...A.targets.values()].filter(t => t.url.startsWith(`${A.origin}/options.html`)).length;
    note('4.6', `settings tabs before/after the click: ${before}/${after} (openOptionsPage reuses an open settings tab)`);
    await A.unlock(S);
    P = await A.popup(first);
    eq('4.6', 'popup after unlock', await P.text('#panel h2'), 'Job posting found');
    eq('4.6', 'requests', A.api(m).length, 0);
    await A.close(P);
    await A.close(S2);
  });

  await step('4.7', async () => {
    // Like Stop on chrome://serviceworker-internals: stop the running version, then confirm a fresh worker answers.
    const sw = await A.sw();
    await sw.raw('(globalThis.__precheckMarker = 42)');
    await A.b.send('Target.detachFromTarget', { sessionId: sw.sessionId }).catch(() => {});
    A.swSession = null;
    await S.send('ServiceWorker.enable');
    await sleep(500);
    const script = `${A.origin}/background.js`;
    const running = [...A.swVersions.values()].filter(v => v.scriptURL === script && v.runningStatus === 'running');
    for (const v of running) await S.send('ServiceWorker.stopWorker', { versionId: v.versionId });
    const stopped = await (async () => {
      for (let i = 0; i < 50; i++) {
        if (running.length && running.every(v => A.swVersions.get(v.versionId).runningStatus === 'stopped')) return true;
        await sleep(100);
      }
      return false;
    })();
    check('4.7', stopped, `worker version stopped: ${stopped} (${running.length} running before)`);
    await S.send('ServiceWorker.disable').catch(() => {});
    const P = await A.popup(first);
    eq('4.7', 'popup after the worker restarts', await P.v("[_t(_q('#panel h2')), !_id('popup-footer').hidden]"), ['Job posting found', true]);
    eq('4.7', 'worker globals were reset (fresh worker)', await A.swv('typeof globalThis.__precheckMarker'), 'undefined');
    await A.close(P);
  });

  let first2;
  let m48 = 0;
  await step('4.8', async () => {
    const vault = await A.swv("JSON.stringify((await chrome.storage.local.get('vault')).vault)");
    await A.restart();
    check('4.8', true, `browser quit and relaunched on the same profile; extension re-added from the same folder (ID ${A.id === report.idA ? 'unchanged' : 'CHANGED'})`);
    m48 = A.mark();
    A.expectedApi = 0;
    first = null;
    first2 = await A.open(`${SITE}/posting.html?after=restart`);
    S = await A.settingsTab();
    await S.until("_t(_id('vault-heading')) && _t(_id('vault-heading')) !== ''");
    await sleep(800);
    eq('4.8', 'settings heading', await S.text('#vault-heading'), 'Unlock saved data');
    const P = await A.popup(first2);
    eq('4.8', 'popup', await P.text('#panel h2'), 'Locked');
    await A.close(P);
    eq('4.8', 'session.get(null)', await A.swv('chrome.storage.session.get(null)'), {});
    eq('4.8', 'encrypted vault kept on disk', await A.swv(`JSON.stringify((await chrome.storage.local.get('vault')).vault) === ${J(vault)}`), true);
    await A.unlock(S);
    manual('4.8', "Quit from Chrome's menu in a windowed run (headless was closed with Browser.close).");
  });

  await step('5.1', async () => {
    let P = await A.popup(first2);
    await P.click('#auto-toggle');
    eq('5.1', 'switch, panel, heading', await P.v("[_id('auto-toggle').checked, _vis(_id('auto-panel')), _t(_id('auto-heading'))]"), [false, true, 'Turn on auto-detect?']);
    const text = await P.text('#auto-panel p');
    for (const part of ['Job Notifier will read the visible text of pages you open', 'Nothing is sent to Claude until you click Find friends.', 'Chrome will ask you to allow access to all sites.']) {
      check('5.1', text.includes(part), `panel has "${part}"`);
    }
    await P.click('#auto-continue');
    await sleep(1500);
    // Chrome's prompt takes focus, so the popup closes, as it does in a windowed Chrome.
    note('5.1', `popup still open after Continue: ${A.targets.has(P.targetId)}`);
    const [scripts, has] = await A.snippets();
    eq('5.1', "while Chrome's prompt is open: autoDetect, scripts, all-sites access", [(await A.swv("(await chrome.storage.local.get('autoDetect')).autoDetect")) ?? null, scripts, has], [null, [], false]);
    await A.close(P);
    P = await A.popup(first2);
    eq('5.1', 'switch after reopening', await P.v("_id('auto-toggle').checked"), false);
    await A.close(P);
    manual('5.1', "Chrome's permission dialog (wording, screenshot), Deny, and the \"Chrome didn't grant site access\" line.");
  });

  await step('8.5', async () => {
    let P = await A.popup(first2);
    eq('8.5', 'POPUP_STATUS', await P.raw("chrome.runtime.sendMessage({ type: 'POPUP_STATUS' })"), { vaultState: 'unlocked', hasKey: true, friendsStatus: 'ok' });
    const data = await P.raw("chrome.runtime.sendMessage({ type: 'VAULT_GET_DATA' }).then(r => r === undefined ? 'undefined' : r, e => 'error: ' + e.message)");
    check('8.5', typeof data === 'string', `VAULT_GET_DATA from the popup: ${short(data)}`);
    await A.close(P);
    await A.lock(S);
    P = await A.popup(first2);
    const un = await P.raw(`chrome.runtime.sendMessage({ type: 'VAULT_UNLOCK', passphrase: ${J(PASS)} }).then(r => r === undefined ? 'undefined' : r, e => 'error: ' + e.message)`);
    check('8.5', typeof un === 'string', `VAULT_UNLOCK from the popup: ${short(un)}`);
    eq('8.5', 'POPUP_STATUS after that', await P.raw("chrome.runtime.sendMessage({ type: 'POPUP_STATUS' })"), { vaultState: 'locked' });
    const m = A.mark();
    const reply = await P.raw("new Promise(r => { const port = chrome.runtime.connect({ name: 'analyze' }); port.onMessage.addListener(r); port.onDisconnect.addListener(() => r('disconnected'));"
      + " port.postMessage({ type: 'ANALYZE_JOB', jobText: 'Data engineering intern, Python and SQL, remote internship. '.repeat(3) }); setTimeout(() => r('no reply in 5 s'), 5000); })");
    eq('8.5', 'analyze port while locked', reply, { ok: false, code: 'LOCKED' });
    eq('8.5', 'requests', A.api(m).length, 0);
    await A.close(P);
    await A.unlock(S);
  });

  await step('V6', async () => {
    // Security Low 1: the popup opens the analyze port and sends Lock in the same task, before the worker's vault queue runs.
    const P = await A.popup(first2);
    const m = A.mark();
    const reply = await P.raw("new Promise(r => { const port = chrome.runtime.connect({ name: 'analyze' }); port.onMessage.addListener(r); port.onDisconnect.addListener(() => r('disconnected'));"
      + " port.postMessage({ type: 'ANALYZE_JOB', jobText: 'Data engineering intern, Python and SQL, remote internship. '.repeat(3) });"
      + " chrome.runtime.sendMessage({ type: 'VAULT_LOCK' }); setTimeout(() => r('no reply in 10 s'), 10000); })");
    await sleep(1500);
    eq('V6', 'popup: analyze request, then Lock in the same task: reply', reply, { ok: false, code: 'LOCKED' });
    eq('V6', 'Claude requests', A.api(m).length, 0);
    await A.close(P);
    await S.until("_t(_id('vault-heading')) === 'Unlock saved data'", 6000);
    await A.unlock(S);
    manual('V6', 'The overlay variant (ANALYZE_TAB) is covered by test/vault.test.js; the overlay cannot send Lock itself, so a real-Chrome race needs two pages.');
  });

  await step('8.4', async () => {
    let P = await A.popup(first2);
    let m = A.mark();
    const [x, y] = await P.center('text=Find friends');
    await P.mouse(x, y, 2);
    await A.results(P, '#panel h2');
    await sleep(600);
    eq('8.4', 'popup: double-click Find friends, requests', A.api(m).length, 1);
    A.expectedApi += 1;
    await A.close(P);
    P = await A.popup(first2);
    m = A.mark();
    await P.js("const b = _btn('Find friends'); b.click(); b.click(); return true;", { gesture: true });
    await A.results(P, '#panel h2');
    await sleep(600);
    eq('8.4', 'popup: two clicks on the same button element, requests', A.api(m).length, 1);
    A.expectedApi += 1;
    await A.close(P);
    A.apiQueue = [{ offline: true }];
    P = await A.popup(first2);
    await P.click('text=Find friends');
    await P.until("_t(_q('#panel h2')) === \"Can't reach Anthropic\"", 10000);
    A.expectedApi += 1;
    eq('8.4', 'offline', await P.v("[_t(_q('#panel h2 + p')), _qa('#panel button').map(_t)]"),
      ['Check your internet connection. Work networks and VPNs sometimes block api.anthropic.com.', ['Try again', 'Edit text']]);
    m = A.mark();
    const [tx, ty] = await P.center('text=Try again');
    await P.mouse(tx, ty, 2);
    await A.results(P, '#panel h2');
    await sleep(600);
    eq('8.4', 'back online: double-click Try again, requests', A.api(m).length, 1);
    A.expectedApi += 1;
    await A.close(P);
    manual('8.4', 'The run simulated offline by failing the request; DevTools Offline throttling itself is not exercised.');
  });

  await step('X2', async () => {
    const cases = [
      [{ status: 401, error: { type: 'authentication_error', message: 'invalid x-api-key' } }, "Your API key wasn't accepted"],
      [{ status: 400, error: { type: 'invalid_request_error', message: 'Your credit balance is too low to access the Anthropic API.' } }, 'Your Anthropic account is out of credit'],
      [{ status: 403, error: { type: 'permission_error', message: 'nope' } }, "This key can't make that request"],
      [{ status: 429, error: { type: 'rate_limit_error', message: 'slow down' } }, 'Too many requests right now'],
      [{ status: 529, error: { type: 'overloaded_error', message: 'Overloaded' } }, "Anthropic's API is busy"],
      [{ status: 500, error: { type: 'api_error', message: 'Internal' } }, "Anthropic's API is busy"],
      [{ status: 404, error: { type: 'not_found_error', message: 'model: claude-haiku-5-5' } }, "The selected model isn't available"],
      [{ status: 418, error: { type: 'teapot', message: 'Rejected key sk-ant-placeholder here' } }, 'Analysis failed'],
      [{ refusal: true }, "Claude couldn't analyze this"],
      [{ malformed: true }, "Claude's reply was incomplete"],
    ];
    for (const [plan, title] of cases) {
      A.apiQueue = [plan];
      const P = await A.popup(first2);
      await P.click('text=Find friends');
      A.expectedApi += 1;
      await P.until("_q('#panel h2') && !['Finding friends…', 'Job posting found'].includes(_t(_q('#panel h2')))", 10000);
      const got = await P.v("[_t(_q('#panel h2')), _t(_q('#panel h2 + p'))]");
      const label = plan.status ? `status ${plan.status}` : plan.refusal ? 'refusal' : 'malformed JSON';
      eq('X2', label, got[0], title);
      if (plan.status === 418) check('X2', got[1].includes('(418)') && got[1].includes('[key hidden]') && !got[1].includes('sk-ant-'), `418 body hides key-shaped text: ${short(got[1])}`);
      await A.close(P);
    }
  });

  await step('9.1', async () => {
    const P = await A.popup(first2);
    const m = A.mark();
    await P.key('Enter');
    await sleep(800);
    eq('9.1', 'Enter right away: heading, requests', [await P.text('#panel h2'), A.api(m).length], ['Job posting found', 0]);
    const seq = [];
    for (let i = 0; i < 5; i++) { await P.key('Tab'); seq.push(await P.v('[_ae(), _ring(document.activeElement)]')); }
    eq('9.1', 'Tab order', seq.map(s => s[0]), ['auto-toggle', 'settings-btn', 'posting', 'Find friends', 'popup-lock-btn']);
    eq('9.1', '2px teal ring on each (switch: on the track)', seq.map(s => s[1]), [true, true, true, true, true]);
    await A.close(P);
  });

  await step('9.2', async () => {
    await S.js("document.activeElement && document.activeElement.blur(); window.scrollTo(0, 0); return true;");
    const expected = await S.v("_qa('a[href], button, input, select, textarea, summary').filter(el => el.tabIndex >= 0 && !el.disabled && el.type !== 'file' && _vis(el)).map(el => el.id || el.getAttribute('aria-label') || _t(el))");
    const seq = [];
    for (let i = 0; i < expected.length; i++) { await S.key('Tab'); seq.push(await S.v('[_ae(), _ring(document.activeElement)]')); }
    eq('9.2', `Tab order (${expected.length} controls, page order)`, seq.map(s => s[0]), expected);
    const noRing = seq.filter(s => !s[1]).map(s => s[0]);
    eq('9.2', 'controls without the 2px teal ring', noRing, []);
  });

  await step('10.1', async () => {
    const P = await A.popup(first2);
    await P.js(STUB_OPEN);
    await P.click('text=Find friends');
    A.expectedApi += 1;
    await A.results(P, '#panel h2');
    const copy = '.matches li:first-child [aria-label^="Copy message to"]';
    const draft = await P.v("_qa('.matches textarea')[0].value");
    await P.click(copy);
    await sleep(150);
    eq('10.1', 'Copy label', await P.text(copy), 'Copied');
    const clip = await P.raw('navigator.clipboard.readText()').catch(e => `clipboard read failed: ${e.message}`);
    eq('10.1', 'clipboard is the draft', clip, draft);
    await sleep(2300);
    eq('10.1', 'label after 2 s', await P.text(copy), 'Copy');
    const copyAll = '.matches ~ .stack .btn-secondary';
    await P.click(copyAll);
    await P.until(`_t(_q(${J(copyAll)})) === 'Copied'`, 3000, 'Copy all: Copied');
    await sleep(200);
    // The Windows clipboard hands text back with CRLF line endings.
    const all = await P.raw('navigator.clipboard.readText()').then(t => t.replace(/\r\n/g, '\n'), e => `clipboard read failed: ${e.message}`);
    const cards = await P.v("_qa('.matches li').map(li => [_t(_q('.match-select .label', li)), _t(_q('.match-email', li)), _q('textarea', li).value])");
    check('10.1', all.startsWith('Job opportunity: Data Engineering Intern at Kestrel Grid') && cards.every(([n, e, d]) => all.includes(`To ${n} <${e}>:\n${d}`)),
      `Copy all has the subject and all ${cards.length} checked drafts: ${short(all, 140)}`);
    await sleep(2300);
    manual('10.1', 'Pasting into Notepad (the run read the browser clipboard).');
    report.popupA = P;
  });

  await step('10.2', async () => {
    const P = report.popupA;
    await P.js("navigator.clipboard.writeText = () => Promise.reject(new Error('blocked')); document.execCommand = () => false; return true;");
    const copy = '.matches li:first-child [aria-label^="Copy message to"]';
    await P.click(copy);
    await sleep(200);
    eq('10.2', 'Copy: label, alert, draft focused, text selected', await P.v(`(() => { const li = _q('.matches li'); const ta = _q('textarea', li); return [_t(_q(${J(copy)})), _t(_q('[role=alert]', li)), document.activeElement === ta, ta.selectionStart === 0 && ta.selectionEnd === ta.value.length]; })()`),
      ['Copy', "Couldn't copy. The message is selected, so press Ctrl+C (Cmd+C on a Mac).", true, true]);
    await P.click('.matches ~ .stack .btn-secondary');
    await sleep(200);
    eq('10.2', 'Copy all alert', await P.v("_qa('[role=alert]').map(_t).filter(Boolean).pop()"), "Couldn't copy. Copy each message from its box instead.");
    await A.close(P);
  });

  await step('11.1', async () => {
    const m = A.mark();
    await S.send('Page.reload');
    await S.until("document.readyState === 'complete' && _t(_id('vault-heading')) === 'Passphrase lock'", 8000);
    await sleep(1500);
    const urls = A.net.slice(m).map(e => e.url);
    check('11.1', urls.length > 0 && urls.every(u => u.startsWith(`${A.origin}/`)), `${urls.length} requests, all chrome-extension://<ID>/: ${short([...new Set(urls.map(u => u.replace(A.origin, '')))].join(' '), 300)}`);
    check('11.1', !urls.some(u => /fonts\.googleapis|fonts\.gstatic|jsdelivr/.test(u)), 'nothing to fonts.googleapis.com, fonts.gstatic.com, or cdn.jsdelivr.net');
  });

  await step('11.2', async () => {
    const P = await A.popup(first2);
    const m = A.mark();
    await P.send('Page.reload');
    await P.until("document.readyState === 'complete' && _t(_q('#panel h2')) === 'Job posting found'", 8000);
    await sleep(1000);
    const urls = A.net.slice(m).map(e => e.url);
    check('11.2', urls.length > 0 && urls.every(u => u.startsWith(`${A.origin}/`)), `${urls.length} requests, all chrome-extension://<ID>/: ${short([...new Set(urls.map(u => u.replace(A.origin, '')))].join(' '), 300)}`);
    report.fontsPopup = [await P.fonts('#panel h2'), await P.fonts('#panel p')];
    report.lookPopup = await P.v(LOOK);
    note('11.5', `popup screenshot: ${await P.shot('11.5-popup')}`);
    await A.close(P);
  });

  await step('11.5', async () => {
    const [ph, pb] = report.fontsPopup;
    check('11.5', ph.some(f => /Fraunces/.test(f)) && pb.some(f => /IBM Plex Sans/.test(f)), `popup rendered fonts: heading ${J(ph)}, body ${J(pb)}`);
    const sh = await S.fonts('h1');
    const sb = await S.fonts('#page-lede');
    check('11.5', sh.some(f => /Fraunces/.test(f)) && sb.some(f => /IBM Plex Sans/.test(f)), `settings rendered fonts: heading ${J(sh)}, body ${J(sb)}`);
    eq('11.5', 'popup: gradients, blur, radius over 4px (spinner excepted), emoji', report.lookPopup, { bad: [], emoji: false });
    eq('11.5', 'settings: gradients, blur, radius over 4px (spinner excepted), emoji', await S.v(LOOK), { bad: [], emoji: false });
    await S.js('window.scrollTo(0, 0); return true;');
    note('11.5', `settings screenshot: ${await S.shot('11.5-settings')}`);
    manual('11.5', 'Toolbar icon (teal tile, white J), overall look, and the report screenshots.');
  });

  await step('12.1', async () => {
    await A.swv("(globalThis.saved = (await chrome.storage.local.get('vault')).vault, await chrome.storage.local.set({ vault: { ...globalThis.saved, v: 99 } }), true)");
    await S.send('Page.reload');
    await S.until("_t(_id('vault-heading')) === \"Saved data can't be read\"", 8000);
    eq('12.1', 'settings', await S.v("[_t(_q('#unreadable-view .label')), _vis(_id('unreadable-reset-btn')), _t(_id('unreadable-reset-btn'))]"), ['Unable to unlock saved data', true, 'Erase and start fresh']);
    const P = await A.popup(first2);
    eq('12.1', 'popup', await P.v("[_t(_q('#panel h2')), _qa('#panel button').map(_t)]"), ["Saved data can't be read", ['Open settings']]);
    await A.close(P);
    await S.click('#unreadable-reset-btn');
    await S.until("_vis(_id('reset-panel'))");
    await S.click('#reset-cancel-btn');
    eq('12.1', 'Cancel: focus, vault.v', [await S.v('document.activeElement.id'), await A.swv("(await chrome.storage.local.get('vault')).vault.v")], ['unreadable-reset-btn', 99]);
    await A.swv('(await chrome.storage.local.set({ vault: globalThis.saved }), true)');
    await S.send('Page.reload');
    await S.until("_t(_id('vault-heading')) === 'Passphrase lock'", 8000);
    check('12.1', true, 'restored vault: unlocked again after reload');
  });

  await step('12.2', async () => {
    await A.lock(S);
    const vault = await A.swv("JSON.stringify((await chrome.storage.local.get('vault')).vault)");
    const auto = await A.swv("(await chrome.storage.local.get('autoDetect')).autoDetect ?? null");
    await S.click('#forgot-btn');
    await S.until("_vis(_id('reset-panel'))");
    eq('12.2', 'panel focus and heading', await S.v("[document.activeElement.id, _t(_id('reset-heading'))]"), ['reset-heading', 'Forgot your passphrase?']);
    eq('12.2', 'lists', await S.v("_qa('#reset-panel li').map(_t)"), ['Your saved Anthropic API key', 'Your entire saved friends list']);
    eq('12.2', 'not deleted', await S.text('#reset-panel .small.muted'), 'Your model and match settings, Auto-detect preference, and any exported JSON files on your computer are not deleted.');
    await S.click('#reset-cancel-btn');
    eq('12.2', 'Cancel: focus, vault unchanged', [await S.v('document.activeElement.id'), await A.swv(`JSON.stringify((await chrome.storage.local.get('vault')).vault) === ${J(vault)}`)], ['forgot-btn', true]);
    await S.click('#forgot-btn');
    await S.click('#reset-confirm-btn');
    eq('12.2', 'unchecked: error, focus', await S.v("[_t(_id('reset-confirm-error')), document.activeElement.id]"), ['Check the box to confirm you want to erase your saved data.', 'reset-confirm-check']);
    await S.js(`window.__seen = []; ${watch('reset-pending')} _id('reset-confirm-check').click(); _id('reset-confirm-btn').click(); return true;`);
    await S.until("_t(_id('vault-heading')) === 'Create a passphrase'", 8000);
    check('12.2', (await S.v('window.__seen')).includes('Erasing saved data…'), `pending text seen: ${J(await S.v('window.__seen'))}`);
    eq('12.2', 'status', await S.text('#setup-status'), 'Saved data erased. Create a new passphrase to start fresh.');
    const local = await A.swv('chrome.storage.local.get(null)');
    eq('12.2', 'storage: vault, friends, settings.apiKey, autoDetect unchanged', ['vault' in local, 'friends' in local, 'apiKey' in (local.settings || {}), (local.autoDetect ?? null) === auto], [false, false, false, true]);
    const P = await A.popup(first2);
    eq('12.2', 'popup', await P.text('#panel h2'), 'Set up Job Notifier');
    await A.close(P);
  });

  const seed = `(await chrome.storage.local.set({ settings: { apiKey: ${J(KEY)}, model: 'claude-haiku-5-5', effort: 'low', threshold: 0.6 },
    friends: [{ name: 'Priya Shah', contact: 'priya.shah@example.com', skills: ['Go', 'PostgreSQL'], interests: ['climate'], level: 'Mid level', notify: true }] }), true)`;

  await step('12.3', async () => {
    await A.swv(seed);
    await S.send('Page.reload');
    await S.until("_t(_id('vault-heading')) === 'Encrypt existing saved data'", 8000);
    eq('12.3', 'summary', await S.text('#convert-summary'), 'Found a saved API key and 1 saved friend stored without encryption.');
    eq('12.3', 'key or name on screen, in fields', await S.v("[document.body.innerText.includes('sk-ant-placeholder') || document.body.innerText.includes('Priya'), _qa('input').some(i => i.value.includes('sk-ant'))]"), [false, false]);
    const P = await A.popup(first2);
    eq('12.3', 'popup: heading, Find friends offered', await P.v("[_t(_q('#panel h2')), !!_btn('Find friends')]"), ['Set up Job Notifier', false]);
    await A.close(P);
    await A.close(S);
    S = A.settings = await A.open(`${A.origin}/options.html`);
    await S.until("_t(_id('vault-heading')) === 'Encrypt existing saved data'", 8000);
    check('12.3', true, 'reopened settings shows the same screen');
    eq('12.3', 'seeded values still stored', await A.swv("(async () => { const l = await chrome.storage.local.get(['settings', 'friends']); return [l.settings.apiKey === 'sk-ant-placeholder', l.friends.length]; })()"), [true, 1]);
  });

  await step('12.4', async () => {
    await S.click('#convert-reset-toggle');
    await S.until("_vis(_id('reset-panel'))");
    await S.click('#reset-cancel-btn');
    eq('12.4', 'Cancel: focus, data intact', [await S.v('document.activeElement.id'), await A.swv("(async () => { const l = await chrome.storage.local.get(['settings', 'friends']); return !!l.settings.apiKey && l.friends.length === 1; })()")], ['convert-reset-toggle', true]);
    await S.click('#convert-reset-toggle');
    await S.js("_id('reset-confirm-check').click(); _id('reset-confirm-btn').click(); return true;");
    await S.until("_t(_id('vault-heading')) === 'Create a passphrase'", 8000);
    eq('12.4', 'storage: apiKey, friends', await A.swv("(async () => { const l = await chrome.storage.local.get(['settings', 'friends']); return ['apiKey' in (l.settings || {}), 'friends' in l]; })()"), [false, false]);
  });

  await step('12.5', async () => {
    await A.swv(seed);
    await S.send('Page.reload');
    await S.until("_t(_id('vault-heading')) === 'Encrypt existing saved data'", 8000);
    await S.js(`window.__seen = []; ${watch('convert-pending')} _id('convert-passphrase').value = ${J(PASS)}; _id('convert-confirm').value = ${J(PASS)}; _id('convert-submit').click(); return true;`);
    await S.until("_t(_id('vault-status')) === 'Existing data encrypted and unlocked for this session.'", 10000);
    check('12.5', (await S.v('window.__seen')).includes('Encrypting and verifying saved data…'), `pending text seen: ${J(await S.v('window.__seen'))}`);
    await S.until("_qa('#friend-list li').length === 1");
    eq('12.5', 'friends, key field', await S.v("[_qa('#friend-list .friend-name span').map(_t), _id('api-key').value === 'sk-ant-placeholder', _id('api-key').type]"), [['Priya Shah'], true, 'password']);
    const r = await A.swv("(async () => { const local = await chrome.storage.local.get(null), session = await chrome.storage.session.get(null), sync = await chrome.storage.sync.get(null);"
      + " const all = JSON.stringify([local, session, sync]); return ['vault' in local, 'apiKey' in local.settings, 'friends' in local, all.includes('sk-ant-'), all.includes('Priya')]; })()");
    eq('12.5', 'vault, settings.apiKey, friends key, includes sk-ant-, includes Priya', r, [true, false, false, false, false]);
  });

  await step('V5', async () => {
    eq('V5', 'unlocked before the reload', await A.swv("!!(await chrome.storage.session.get('vaultKey')).vaultKey"), true);
    const vault = await A.swv("JSON.stringify((await chrome.storage.local.get('vault')).vault)");
    const swUrl = `${A.origin}/background.js`;
    const oldSw = [...A.targets.values()].find(t => t.type === 'service_worker' && t.url === swUrl)?.targetId;
    // Loading the same folder again is how DevTools reloads an unpacked extension in place.
    const id = (await A.b.send('Extensions.loadUnpacked', { path: A.extDir })).id;
    check('V5', id === A.id, `reloaded in place, same ID: ${id === A.id}`);
    A.swSession = null;
    if (oldSw) A.targets.delete(oldSw);
    S = A.settings = await A.open(`${A.origin}/options.html`);
    await S.until("_t(_id('vault-heading')) && _t(_id('vault-heading')) !== ''", 8000);
    await sleep(800);
    eq('V5', 'settings after the reload', await S.text('#vault-heading'), 'Unlock saved data');
    eq('V5', 'session.get(null)', await A.swv('chrome.storage.session.get(null)'), {});
    eq('V5', 'encrypted vault kept', await A.swv(`JSON.stringify((await chrome.storage.local.get('vault')).vault) === ${J(vault)}`), true);
    const P = await A.popup(first2);
    eq('V5', 'popup', await P.text('#panel h2'), 'Locked');
    await A.close(P);
    manual('V5', 'A Chrome Web Store update (the run reloaded the unpacked folder).');
  });

  await step('11.4', async () => {
    const outside = A.net.slice(m48).filter(e => !e.url.startsWith('chrome-extension://') && !e.url.startsWith(`http://kestrel-grid.localhost:${PORT}/`));
    const notApi = outside.filter(e => !(e.method === 'POST' && e.url === 'https://api.anthropic.com/v1/messages'));
    eq('11.4', 'run A since 4.8: requests other than POST api.anthropic.com/v1/messages', notApi.map(e => `${e.method} ${e.url}`), []);
    eq('11.4', 'run A since 4.8: Claude requests vs Find friends / Try again clicks', outside.length, A.expectedApi);
    const swHttp = A.swNet.filter(e => /^https?:/.test(e.url));
    eq('11.4', 'run A worker Network log: entries other than POST api.anthropic.com/v1/messages', swHttp.filter(e => !(e.method === 'POST' && e.url === 'https://api.anthropic.com/v1/messages')).map(e => e.url), []);
    report.apiA = { calls: outside.length, expected: A.expectedApi };
  });

  await step('X5', async () => {
    const info = await A.info();
    eq('X5', 'run A: errors Chrome recorded for the extension', info.runtimeErrors.map(e => `${e.message} (${e.contextUrl || e.source}, ${e.occurrences}x)`), []);
    const swErr = A.logs.filter(l => A.swSessions.has(l.session) && /error|exception/.test(l.level)).map(l => l.text);
    eq('X5', 'run A: worker console errors', swErr, []);
    eq('X5', 'run A: "Unchecked runtime.lastError" or permissions-policy lines in any console (pages, frames, worker)',
      A.logs.filter(l => /Unchecked runtime\.lastError|Permissions policy/i.test(l.text)).map(l => l.text), []);
  });

  await step('X6', async () => {
    const { extensionMessages, directMessages } = A.channels();
    eq('X6', 'run A: secret-carrying vault messages from settings over extension messaging', extensionMessages.filter(t => SECRET_TYPES.includes(t)), []);
    const seen = new Set(directMessages);
    eq('X6', 'run A: flows not seen at the service worker (setup 2.2, save 3.3/3.5, unlock 4.3, reset 12.2, P3 12.5)',
      ['VAULT_SETUP', 'VAULT_SAVE_CLAUDE', 'VAULT_SAVE_FRIENDS', 'VAULT_UNLOCK', 'VAULT_GET_DATA', 'VAULT_RESET', 'VAULT_CONVERT_LEGACY'].filter(t => !seen.has(t)), []);
    note('X6', `run A: settings used extension messaging for ${J([...new Set(extensionMessages)])} and direct worker messages for ${J([...seen])}`);
  });

  report.dialogsA = A.dialogs;
  await A.b.stop();
}

// ── Run B: test copy with all-sites access, for auto-detect and the overlay ──

async function runB() {
  const B = new Run('B', path.join(WORK, 'ext-allsites'));
  await B.launch();
  report.versionB = B.version;
  const P = await B.open(`${SITE}/posting.html?tab=main`);
  await B.install();
  report.idB = B.id;
  const S = await B.settingsTab();
  await S.until("_t(_id('vault-heading')) === 'Create a passphrase'", 8000);
  await S.js(`_id('setup-passphrase').value = ${J(PASS)}; _id('setup-confirm').value = ${J(PASS)}; _id('setup-submit').click(); return true;`);
  // Wait for the unlocked data to load (the empty list opens the add form) before saving.
  await S.until("_t(_id('vault-heading')) === 'Passphrase lock' && _vis(_id('friend-form'))", 10000);
  await S.set('#api-key', KEY);
  await S.click('#claude-save');
  await S.until("_t(_id('claude-status')) === 'Saved. Next, add at least one friend below.'");
  await B.setFile(S, '#import-file', path.join(PAGES, 'demo-friends.json'));
  await S.until("_t(_id('friends-status')) === 'Imported 4 friends from demo-friends.json.'");
  const tabId = await B.swv("(await chrome.tabs.query({})).find(t => (t.url || '').includes('tab=main')).id");
  const autoOn = () => B.swUntil(`(await chrome.storage.local.get('autoDetect')).autoDetect === true && (await chrome.scripting.getRegisteredContentScripts()).length === 1`, 8000, 'auto-detect on');
  const closeOverlay = async O => { await O.click('text=Not now').catch(() => O.click('#close-btn')); await P.until("!_q('iframe[title=\"Job Notifier\"]')", 4000); };

  await step('5.2', async () => {
    const [s0, h0] = await B.snippets();
    note('5.2', `test copy before: autoDetect unset, scripts ${J(s0)}, all-sites ${h0} (granted at install because the copy lists it as required)`);
    await B.siteAccess('ON_CLICK');
    await sleep(800);
    await B.siteAccess('ON_ALL_SITES');
    await autoOn();
    const [scripts, has] = await B.snippets();
    eq('5.2', 'registered script', scripts.map(s => [s.id, s.js, [...s.matches].sort()]), [['job-notifier-detect', ['lib/core.js', 'content.js'], ['http://*/*', 'https://*/*']]]);
    eq('5.2', 'all-sites access', has, true);
    const Pop = await B.popup(P);
    eq('5.2', 'popup switch', await Pop.v("_id('auto-toggle').checked"), true);
    await B.close(Pop);
    const info = await B.info();
    eq('5.2', 'Details: all-sites access', [info.permissions.runtimeHostPermissions.hasAllHosts, info.permissions.runtimeHostPermissions.hostAccess], [true, 'ON_ALL_SITES']);
    manual('5.2', "Chrome's dialog and the Allow click on the release build. The run granted access through Chrome's site-access control on the test copy, which fires the same permissions.onAdded the worker listens to.");
  });

  await step('5.3', async () => {
    await S.until("_id('auto-toggle').checked");
    await S.click('#auto-toggle');
    await S.until("_t(_id('auto-status')) === 'Auto-detect is off.'");
    await sleep(1000);
    const [scripts, has] = await B.snippets();
    eq('5.3', 'registered scripts', scripts, []);
    note('5.3', `all-sites access after turning off: ${has}. Expected true on the test copy, where Chrome refuses to remove a required permission; the release build must return false.`);
    const Pop = await B.popup(P);
    eq('5.3', 'popup switch', await Pop.v("_id('auto-toggle').checked"), false);
    await B.close(Pop);
    manual('5.3', 'permissions.contains returning false and Details showing no all-sites access (release build only).');
  });

  await step('5.4', async () => {
    await S.click('#auto-toggle');
    await S.until("_t(_id('auto-status')) === 'Auto-detect is on.'");
    await autoOn();
    eq('5.4', 'switch', await S.v("_id('auto-toggle').checked"), true);
    manual('5.4', "Chrome's dialog appearing right away, then Allow (the test copy already holds access, so Chrome answered without a dialog).");
  });

  await step('5.5', async () => {
    await B.siteAccess('ON_CLICK');
    await S.until("!_id('auto-toggle').checked");
    await sleep(800);
    note('5.5', `settings status: "${await S.text('#auto-status')}"`);
    eq('5.5', 'scripts, all-sites access', await B.snippets(), [[], false]);
    eq('5.5', 'autoDetect', await B.swv("(await chrome.storage.local.get('autoDetect')).autoDetect"), false);
    const Pop = await B.popup(P);
    eq('5.5', 'popup switch', await Pop.v("_id('auto-toggle').checked"), false);
    await B.close(Pop);
    manual('5.5', "Remove the grant on the release build's Details page (the run used Chrome's site-access control on the test copy).");
  });

  await step('5.6', async () => {
    await B.siteAccess('ON_ALL_SITES');
    await autoOn();
    check('5.6', true, 'auto-detect on again with the script registered');
  });

  let base;
  await step('6.1', async () => {
    await B.posting(P, tabId);
    const m = B.mark();
    const t0 = Date.now();
    await P.click('a.apply');
    const O = await B.overlay(P);
    const ms = Date.now() - t0;
    check('6.1', ms < 4000, `prompt shown ${ms} ms after Apply now`);
    eq('6.1', 'eyebrow, Close, heading', await O.v("[_t(_q('.eyebrow')), _t(_id('close-btn')), _t(_id('state-heading'))]"), ['Job Notifier', 'Close', 'Find friends for this job?']);
    eq('6.1', 'posting block', await O.v("[_t(_q('.posting-title')), _t(_q('.posting .small'))]"), ['Data Engineering Intern | Kestrel Grid', 'Viewed on kestrel-grid.localhost just now']);
    eq('6.1', 'body', await O.text('#prompt-body'), "Job Notifier will send this posting's text and your included friends' names, skills, interests, and level to Claude. It's billed to your Anthropic API key.");
    eq('6.1', 'buttons', await O.v("_qa('#panel-body button').map(_t)"), ['Find friends', 'Not now']);
    eq('6.1', 'dimmed page, panel top right', await O.v("(() => { const r = _id('dialog').getBoundingClientRect(); return [_vis(_id('scrim')), r.right > innerWidth - 40 && r.top < 40]; })()"), [true, true]);
    eq('6.1', 'Claude requests', B.api(m).length, 0);
    note('6.1', `screenshot: ${await P.shot('6.1-prompt')}`);
    base = await O.v(STYLE);
    report.O61 = O;
  });

  await step('6.2', async () => {
    const O = report.O61;
    const m = B.mark();
    B.apiQueue = [{ delay: 1200 }];
    const t0 = Date.now();
    await O.click('text=Find friends');
    const loading = await O.until("_t(_id('state-heading')) === 'Finding friends…'", 3000).then(() => true, () => false);
    check('6.2', loading, 'Finding friends… shown');
    await B.results(O, '#state-heading');
    B.expectedApi += 1;
    eq('6.2', 'heading', await O.text('#state-heading'), '4 friends might want this job');
    eq('6.2', 'job summary, recruiter field, match cards', await O.v("[!!_q('.job-summary'), !!_id('recruiter-input'), _qa('li.card.match').length]"), [true, true, 4]);
    const calls = B.api(m);
    eq('6.2', 'requests', calls.map(c => `${c.method} ${c.url}`), ['POST https://api.anthropic.com/v1/messages']);
    check('6.2', calls[0] && calls[0].t >= t0, 'the request came after the click');
    eq('X3', 'request: model, placeholder key, friend names', calls[0] && [calls[0].req.model, calls[0].req.keyIsPlaceholder, calls[0].req.friends], ['claude-haiku-5-5', true, ['Priya Shah', 'Marcus Lee', 'Dana Okafor', 'Leo Martins']]);
    eq('X3', 'request carries email addresses, recruiter link', calls[0] && [calls[0].req.hasEmail, calls[0].req.hasRecruiter], [false, false]);
  });

  await step('6.3', async () => {
    const O = report.O61;
    check('6.3', await O.v("document.body.innerText.includes('Marcus Lee')"), 'Marcus Lee is on screen in the overlay');
    eq('6.3', '[innerText, querySelectorAll, outerHTML, window.find]', await P.v("(() => { const name = 'Marcus Lee', title = 'Data Engineering Intern'; return [document.body.innerText.includes(name), [...document.querySelectorAll('*')].some(el => el.textContent.includes(name)), document.documentElement.outerHTML.includes(title), window.find(name)]; })()"),
      [false, false, false, false]);
    await O.click('#close-btn');
    await P.until("!_q('iframe[title=\"Job Notifier\"]')", 4000);
  });

  await step('6.4', async () => {
    const O = await B.confirm(P, tabId, 'a[href="loud-css.html"]');
    eq('6.4', 'page text', await P.v("[getComputedStyle(_q('h1')).color, getComputedStyle(_q('h1')).fontSize]"), ['rgb(255, 0, 0)', '30px']);
    eq('6.4', 'overlay styles match 6.1', await O.v(STYLE), base);
    note('6.4', `screenshot: ${await P.shot('6.4-loud-css')}`);
    await closeOverlay(O);
  });

  await step('6.5', async () => {
    await B.posting(P, tabId);
    const W = await B.open(`${SITE}/confirmation.html`, { newWindow: true });
    await sleep(5000);
    eq('6.5', 'unrelated window: prompt after 5 s', await B.hasFrame(W), false);
    await B.close(W);
    const before = new Set(B.targets.keys());
    await P.click('a[href*="hire-portal"]');
    const t = await B.findTarget(x => x.type === 'page' && x.url.includes('hire-portal.localhost') && !before.has(x.targetId), 8000, 'partner tab');
    const H = await B.attach(t.targetId);
    const O = await B.overlay(H);
    eq('6.5', 'partner tab prompt', await O.text('.posting .small'), 'Viewed on kestrel-grid.localhost just now');
    await O.click('text=Not now');
    await H.until("!_q('iframe[title=\"Job Notifier\"]')", 4000);
    await B.close(H);
  });

  await step('6.6', async () => {
    await B.lock(S);
    const O = await B.confirm(P, tabId);
    const m = B.mark();
    eq('6.6', 'locked prompt', await O.v("[_t(_id('prompt-body')), _qa('#panel-body button').map(_t)]"),
      ['Your saved API key and friends list are locked. Open settings to unlock them, then return here to run the check.', ['Open settings to unlock', 'Not now']]);
    await O.click('text=Open settings to unlock');
    await sleep(600);
    await B.unlock(S);
    await B.b.send('Target.activateTarget', { targetId: P.targetId }).catch(() => {});
    await O.until("!!_btn('Find friends')", 8000);
    eq('6.6', 'back on the tab: heading, focus', await O.v("[_t(_id('state-heading')), document.activeElement.id]"), ['Find friends for this job?', 'state-heading']);
    eq('6.6', 'Claude requests', B.api(m).length, 0);
    report.O66 = O;
  });

  await step('6.7', async () => {
    const O = report.O66;
    const m = B.mark();
    B.apiQueue = [{ delay: 4000 }];
    await O.click('text=Find friends');
    await sleep(700);
    await B.lock(S);
    await O.until("_t(_id('state-heading')) === 'Job Notifier is locked'", 5000);
    eq('6.7', 'body', await O.v("_t(_q('#panel-body p'))"), 'Your saved API key and friends list were locked, so any results were cleared. Open settings to unlock.');
    let cards = 0;
    for (let i = 0; i < 25; i++) { cards = Math.max(cards, await O.v("_qa('li.card.match').length")); await sleep(200); }
    eq('6.7', 'match cards shown at any point in 5 s', cards, 0);
    const calls = B.api(m);
    B.expectedApi += calls.length;
    const sw = B.swNet.filter(e => e.url === 'https://api.anthropic.com/v1/messages').pop();
    note('6.7', `request: ${calls.length}, held reply ${calls[0]?.fulfill || 'n/a'}; worker log: ${sw?.failed || 'no failure recorded'}`);
    check('6.7', calls.length <= 1, `requests: ${calls.length}`);
    await O.click('#close-btn').catch(() => {});
    await P.until("!_q('iframe[title=\"Job Notifier\"]')", 4000).catch(() => {});
    await B.unlock(S);
  });

  await step('6.8', async () => {
    await B.posting(P, tabId);
    let Pop = await B.popup(P);
    const m = B.mark();
    B.apiQueue = [{ delay: 3000 }];
    await Pop.js("_btn('Find friends').click(); _id('popup-lock-btn').click(); return true;", { gesture: true });
    await Pop.until("_t(_q('#panel h2')) === 'Locked'", 4000);
    check('6.8', true, 'popup shows Locked');
    await B.close(Pop);
    await sleep(5000);
    Pop = await B.popup(P);
    eq('6.8', 'reopened: heading, results', await Pop.v("[_t(_q('#panel h2')), !!_q('.matches')]"), ['Locked', false]);
    await B.close(Pop);
    B.expectedApi += B.api(m).length;
    note('6.8', `requests started: ${B.api(m).length}`);
    await B.unlock(S);
    manual('6.8', 'The walkthrough waits 30 s; the run held the reply 3 s and reopened after 5 s.');
  });

  await (await B.sw()).raw('globalThis.__upd = []; chrome.tabs.onUpdated.addListener((id, info) => globalThis.__upd.push([Date.now(), id, JSON.stringify(info)])); true');
  const updSince = async n => B.swv(`globalThis.__upd.slice(${n}).filter(x => x[1] === ${tabId}).map(x => x[2])`);
  const updLen = () => B.swv('globalThis.__upd.length');

  let O71;
  await step('7.1', async () => {
    await B.posting(P, tabId);
    await P.click('a[href="spa.html"]');
    await P.until("location.pathname.endsWith('spa.html') && document.readyState === 'complete'");
    await sleep(1500);
    const n = await updLen();
    const t0 = Date.now();
    await P.click('#submit');
    O71 = await B.overlay(P);
    const ms = Date.now() - t0;
    eq('7.1', 'URL, heading', await P.v("[location.search, _t(_q('h1'))]"), ['?step=done', 'Application submitted']);
    check('7.1', ms < 3500, `prompt shown ${ms} ms after Submit application`);
    const lines = await updSince(n);
    report.pushState = lines;
    // Chrome and Edge send status 'loading' for pushState too, so criterion 31 (amended) keys on the document
    // instead; the step's "no loading" expectation is browser behavior, recorded here rather than checked.
    note('7.1', `onUpdated for the pushState: ${lines.join(' | ') || '(none)'}`);
    eq('7.1', "worker's prompt entry for the tab after the pushState", await B.swv(`((await chrome.storage.session.get('prompts')).prompts || {})[${tabId}] ? 'kept' : 'dropped'`), 'kept');
  });

  await step('7.2', async () => {
    const n = await updLen();
    await P.js("history.pushState({}, '', '?step=receipt'); return true;");
    await sleep(500);
    await P.js("location.hash = 'receipt'; return true;");
    await sleep(1500);
    const lines = await updSince(n);
    report.pushStateHash = lines;
    note('7.2', `onUpdated for the pushState and hash change: ${lines.join(' | ') || '(none)'}`);
    eq('7.2', 'prompt still showing', [await B.hasFrame(P), await O71.text('#state-heading')], [true, 'Find friends for this job?']);
    eq('7.2', "worker's prompt entry for the tab after the URL changes", await B.swv(`((await chrome.storage.session.get('prompts')).prompts || {})[${tabId}] ? 'kept' : 'dropped'`), 'kept');
    const m = B.mark();
    await O71.click('text=Find friends');
    const outcome = await B.outcome(P, O71);
    const calls = B.api(m).length;
    B.expectedApi += calls;
    eq('7.2', 'Find friends after the URL changes: outcome, requests', [outcome, calls], ['4 friends might want this job', 1]);
    if (await B.hasFrame(P)) {
      const heading = await O71.text('#state-heading').catch(e => e.message);
      await O71.click('#close-btn').catch(() => {});
      await sleep(1500);
      const afterClose = await B.hasFrame(P);
      await O71.js("_id('state-heading').focus(); return true;").catch(() => {});
      await P.key('Escape');
      await sleep(1500);
      eq('7.2', `overlay state 10 s after Find friends ("${heading}"): still showing after Close, after Escape`, [afterClose, await B.hasFrame(P)], [false, false]);
      if (await B.hasFrame(P)) await B.nav(P, `${SITE}/confirmation.html`); // clean up for the next steps
    }
  });

  await step('7.3', async () => {
    await B.confirm(P, tabId);
    const n = await updLen();
    await P.send('Page.reload');
    await sleep(300);
    await P.until("document.readyState === 'complete' && location.pathname.endsWith('confirmation.html')");
    eq('7.3', 'overlay right after reload', await B.hasFrame(P), false);
    await sleep(4000);
    eq('7.3', 'prompt 4 s after reload', await B.hasFrame(P), false);
    const lines = await updSince(n);
    check('7.3', lines.some(l => l.includes('"status":"loading"')), `onUpdated: ${lines.join(' | ')}`);
    eq('7.3', 'prompts entry for the tab', await B.swv(`((await chrome.storage.session.get('prompts')).prompts || {})[${tabId}] ?? null`), null);
  });

  await step('X4', async () => {
    const T = await B.open(`${SITE}/posting.html?tab=close`);
    const id2 = await B.swv("(await chrome.tabs.query({})).find(t => (t.url || '').includes('tab=close')).id");
    await B.waitJob(id2, Date.now() - 5000);
    await T.click('a.apply');
    await B.overlay(T);
    eq('X4', 'before closing: posting and prompt stored', await B.swv(`(async () => { const s = await chrome.storage.session.get(['jobs', 'prompts']); return [!!(s.jobs || {})[${id2}], !!(s.prompts || {})[${id2}]]; })()`), [true, true]);
    await B.close(T);
    await sleep(1000);
    eq('X4', 'after closing the tab', await B.swv(`(async () => { const s = await chrome.storage.session.get(['jobs', 'prompts']); return [!!(s.jobs || {})[${id2}], !!(s.prompts || {})[${id2}]]; })()`), [false, false]);
  });

  await step('7.4', async () => {
    await B.confirm(P, tabId);
    const Pop = await B.popup(P);
    await Pop.click('#auto-toggle');
    await Pop.until("_t(_id('auto-status')) === 'Auto-detect is off.'");
    await sleep(1200);
    note('7.4', `popup switch off on the test copy: overlay still showing=${await B.hasFrame(P)}, snippets=${J(await B.snippets())}. On the copy chrome.permissions.remove rejects for a required permission, so the worker stops before it clears prompts and sends STOP.`);
    await B.close(Pop);
    await S.until("!_id('auto-toggle').checked");
    await S.click('#auto-toggle');
    await autoOn();
    await B.confirm(P, tabId);
    const world = B.contentWorld(P);
    if (world) note('7.4', `content script will return focus to: ${await P.raw("returnFocus ? (returnFocus.id || returnFocus.tagName) : 'nothing'", { contextId: world.id }).catch(e => e.message)}`);
    const t0 = Date.now();
    await B.siteAccess('ON_CLICK');
    await P.until("!_q('iframe[title=\"Job Notifier\"]')", 3000);
    const ms = Date.now() - t0;
    check('7.4', ms < 2000, `overlay removed ${ms} ms after all-sites access was removed (same STOP path the switch takes once access is removed)`);
    eq('7.4', 'document.activeElement.textContent', await P.v('document.activeElement.textContent'), 'Download receipt');
    eq('7.4', 'scripts, all-sites access', await B.snippets(), [[], false]);
    await B.siteAccess('ON_ALL_SITES');
    await autoOn();
    manual('7.4', 'Turning auto-detect off from the popup on the release build: the overlay must go at once (the test copy stops at chrome.permissions.remove).');
  });

  await step('8.1', async () => {
    const sw = await B.sw();
    const src = fs.readFileSync(path.join(B.extDir, 'background.js'), 'utf8').split(/\r?\n/);
    const line = src.findIndex(l => l.includes('if (JN.isValidContentMessage(msg, sender, chrome.runtime.id)) {'));
    check('8.1', line >= 0, `breakpoint on background.js:${line + 1}`);
    await B.posting(P, tabId);
    await sleep(2000);
    await sw.send('Debugger.enable');
    const { breakpointId } = await sw.send('Debugger.setBreakpointByUrl', { lineNumber: line, url: `${B.origin}/background.js` });
    const pauses = [];
    B.onPause = m => { if (m.sessionId === sw.sessionId) pauses.push(m.params); };
    const nextPause = async () => { const end = Date.now() + 10000; while (!pauses.length) { if (Date.now() > end) throw new Error('the worker did not pause'); await sleep(50); } return pauses.shift(); };
    const at = (p, expr) => sw.send('Debugger.evaluateOnCallFrame', { callFrameId: p.callFrames[0].callFrameId, expression: expr, returnByValue: true }).then(r => r.result.value);
    const m = B.mark();
    try {
      await P.click('a.apply');
      let first;
      for (let i = 0; i < 10 && !first; i++) {
        const p = await nextPause();
        const v = await at(p, '[msg?.type, sender.url, sender.frameId]');
        if (v[0] === 'CONFIRMATION_SEEN') first = v;
        await sw.send('Debugger.resume');
      }
      eq('8.1', 'first pause', first, ['CONFIRMATION_SEEN', `${SITE}/confirmation.html`, 0]);
      let second;
      for (let i = 0; i < 10 && !second; i++) {
        const p = await nextPause();
        const v = await at(p, '[msg?.type, sender.url, sender.frameId, sender.id === chrome.runtime.id, new URL(sender.url).host === chrome.runtime.id]');
        if (v[0] === 'OVERLAY_STATE') second = v;
        else await sw.send('Debugger.resume');
      }
      report.senderUrl = second;
      check('8.1', second && /^chrome-extension:\/\/[^/]+\/overlay\.html$/.test(second[1]) && second[2] > 0 && second[3] === true,
        `second pause [type, sender.url, frameId, sender.id ok, host is runtime id]: ${J(second)}`);
      await sleep(1000);
      eq('8.1', 'frame present while paused', await B.hasFrame(P), true);
      const [x, y] = await P.center('#receipt');
      await P.mouse(x, y);
      await sleep(300);
      eq('8.1', 'click through the not-ready frame', await P.text('#receipt'), 'Receipt clicked');
      await sleep(5200);
      eq('8.1', 'frame after 6.5 s paused', await B.hasFrame(P), false);
    } finally {
      await sw.send('Debugger.removeBreakpoint', { breakpointId }).catch(() => {});
      await sw.send('Debugger.resume').catch(() => {});
      await sw.send('Debugger.disable').catch(() => {});
      B.onPause = null;
    }
    await sleep(2000);
    eq('8.1', 'after resuming: overlay, Claude requests', [await B.hasFrame(P), B.api(m).length], [false, 0]);
  });

  await step('8.2', async () => {
    const F = await B.open(`${SITE}/frame-test.html`);
    await F.send('Log.enable');
    const l0 = B.logs.length;
    await F.set('#url', `${B.origin}/overlay.html`);
    await F.click('#go');
    await sleep(2000);
    const denied = B.logs.slice(l0).filter(l => l.session === F.sessionId && /Denying load of chrome-extension:\/\//.test(l.text));
    check('8.2', denied.length > 0, `console: ${short(denied[0]?.text || 'no "Denying load" message', 160)}`);
    eq('8.2', 'overlay frames loaded from the static ID', [...B.frames.values()].filter(f => f.parent === F.sessionId && f.url.startsWith(B.origin)).length, 0);
    const O = await B.confirm(P, tabId);
    const src = await P.v("_q('iframe[title=\"Job Notifier\"]').src");
    report.dynamicHost = new URL(src).host !== B.id;
    check('8.2', true, `prompt frame host differs from the extension ID: ${report.dynamicHost}`);
    await closeOverlay(O);
    const m = B.mark();
    await F.set('#url', src);
    await F.click('#go');
    await sleep(2500);
    const framed = [...B.frames.entries()].filter(([, f]) => f.parent === F.sessionId && /\/overlay\.html$/.test(f.url));
    const states = [];
    for (const [sid, f] of framed) states.push(await B.wrap(sid, f.targetId).v("[_id('scrim').hidden, _id('dialog').hidden, _t(_id('state-heading'))]").catch(e => e.message));
    note('8.2', `dynamic URL framed by frame-test: ${framed.length} frame(s) loaded`);
    check('8.2', states.every(s => J(s) === J([true, true, ''])), `framed overlay [scrim hidden, dialog hidden, heading]: ${J(states)}`);
    eq('8.2', 'Claude requests', B.api(m).length, 0);
    await B.close(F);
  });

  await step('8.3', async () => {
    await B.setFile(S, '#import-file', path.join(PAGES, 'xss-friends.json'));
    await S.until("_t(_id('import-summary'))");
    await S.click('#import-add');
    await S.until("_t(_id('friends-status')) === 'Added 1 friend from xss-friends.json.'");
    eq('8.3', 'settings list', await S.v("(() => { const li = _qa('#friend-list li').find(li => _t(_q('.friend-name span', li)).includes('img')); return li && [_t(_q('.friend-name span', li)), _qa('.friend-line', li).map(_t).find(t => t.startsWith('Skills'))]; })()"),
      [PAYLOAD, `Skills: ${PAYLOAD}, Python, SQL, data pipelines`]);
    await B.posting(P, tabId, `${SITE}/xss-posting.html`);
    const Pop = await B.popup(P);
    await Pop.js(STUB_OPEN);
    B.apiQueue = [{ title: `${PAYLOAD} Data Engineering Intern` }];
    await Pop.click('text=Find friends');
    await B.results(Pop, '#panel h2');
    B.expectedApi += 1;
    eq('8.3', 'popup job title', await Pop.text('.job-title'), `${PAYLOAD} Data Engineering Intern`);
    eq('8.3', 'popup payload friend card', await Pop.v(`_qa('.match-select .label').map(_t).includes(${J(PAYLOAD)})`), true);
    await P.click('a.apply');
    const O = await B.overlay(P);
    eq('8.3', 'prompt title', await O.text('.posting-title'), `${PAYLOAD} Data Engineering Intern | Kestrel Grid`);
    B.apiQueue = [{ title: `${PAYLOAD} Data Engineering Intern` }];
    await O.js(STUB_OPEN);
    await O.click('text=Find friends');
    await B.results(O, '#state-heading');
    B.expectedApi += 1;
    await O.js(`const ta = _qa('.matches textarea')[0]; ta.value = ${J(PAYLOAD)}; ta.dispatchEvent(new Event('input', { bubbles: true })); return true;`);
    eq('8.3', 'typed draft stays text', await O.v("_qa('.matches textarea')[0].value"), PAYLOAD);
    const imgs = "_qa('img').filter(i => i.getAttribute('src') === 'x').length";
    eq('8.3', 'img[src="x"] in settings, popup, overlay, page', [await S.v(imgs), await Pop.v(imgs), await O.v(imgs), await P.v(imgs)], [0, 0, 0, 0]);
    eq('8.3', 'alert dialogs so far (runs A and B)', [...(report.dialogsA || []), ...B.dialogs].filter(d => d.type === 'alert').length, 0);
    await B.close(Pop);
    await O.click('#close-btn');
    await P.until("!_q('iframe[title=\"Job Notifier\"]')", 4000);
    B.dialogPlan = [true];
    await S.click(`[aria-label=${J(`Remove ${PAYLOAD}`)}]`);
    await S.until(`_t(_id('friends-status')) === ${J(`Removed ${PAYLOAD}.`)}`);
    check('8.3', true, 'payload friend removed');
  });

  await step('8.4', async () => {
    let O = await B.confirm(P, tabId);
    let m = B.mark();
    const [x, y] = await O.center('text=Find friends');
    // A real double-click: press/release with clickCount 1, then 2, at the same point. Between them,
    // record what sits under the pointer once the first click has re-rendered the panel.
    await P.mouse(x, y, 1);
    const under = await O.v(`(() => { const el = document.elementFromPoint(${x}, ${y}); const r = _id('dialog').getBoundingClientRect();`
      + ` return [el ? (el.id || el.tagName) : null, _t(_id('state-heading')), Math.round(r.bottom)]; })()`).catch(e => [e.message]);
    await P.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 2 });
    await P.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 2 });
    const outcome = await B.outcome(P, O);
    await sleep(600);
    let n = B.api(m).length;
    B.expectedApi += n;
    eq('8.4', 'overlay: double-click Find friends, requests', n, 1);
    eq('8.4', `overlay after the double-click (button center ${Math.round(x)},${Math.round(y)}; after the first click the point is over ${J(under)} [element, heading, panel bottom])`, outcome, '4 friends might want this job');
    if (await B.hasFrame(P)) { await O.click('#close-btn'); await P.until("!_q('iframe[title=\"Job Notifier\"]')", 4000); }
    O = await B.confirm(P, tabId);
    m = B.mark();
    await O.js("const b = _btn('Find friends'); b.click(); b.click(); return true;", { gesture: true });
    const outcome2 = await B.outcome(P, O);
    await sleep(600);
    n = B.api(m).length;
    B.expectedApi += n;
    eq('8.4', 'overlay: two clicks on the same button element: outcome, requests', [outcome2, n], ['4 friends might want this job', 1]);
    if (await B.hasFrame(P)) { await O.click('#close-btn'); await P.until("!_q('iframe[title=\"Job Notifier\"]')", 4000); }
  });

  await step('V1', async () => {
    // Security check #1: storage.session stays at TRUSTED_CONTEXTS, so a content script can't read vaultKey or hear it change.
    await B.posting(P, tabId);
    const world = B.contentWorld(P);
    if (!check('V1', !!world, `content script world found: ${world ? world.name : 'none'}`)) return;
    const read = await P.raw("chrome.storage.session.get('vaultKey').then(() => 'unexpectedly readable', e => 'refused: ' + e.message)", { contextId: world.id });
    check('V1', read.startsWith('refused'), `storage.session.get('vaultKey') from the content script: ${read}`);
    await P.raw("globalThis.__areas = []; chrome.storage.onChanged.addListener((c, area) => globalThis.__areas.push(area + ': ' + Object.keys(c).join(',')));"
      + " try { chrome.storage.session.onChanged.addListener(c => globalThis.__areas.push('session.onChanged: ' + Object.keys(c).join(','))); } catch (e) { globalThis.__areas.push('session.onChanged unavailable: ' + e.message); }"
      + ' true', { contextId: world.id });
    await B.lock(S);
    await B.unlock(S);
    await sleep(800);
    const areas = await P.raw('globalThis.__areas', { contextId: world.id });
    eq('V1', 'session-area change events the content script saw during Lock and unlock', areas.filter(a => /^session/.test(a) && !/unavailable/.test(a)), []);
    note('V1', `every storage event the content script saw: ${J(areas)}`);
  });

  await step('X1', async () => {
    await B.confirm(P, tabId);
    const ctx = B.contentWorld(P);
    if (!check('X1', !!ctx, `content script world found: ${ctx ? ctx.name : 'none'}`)) return;
    const m = B.mark();
    const port = await P.raw("new Promise(r => { const p = chrome.runtime.connect({ name: 'analyze' }); p.onDisconnect.addListener(() => r('disconnected')); p.onMessage.addListener(x => r('reply: ' + JSON.stringify(x)));"
      + " p.postMessage({ type: 'ANALYZE_TAB' }); p.postMessage({ type: 'ANALYZE_JOB', jobText: 'Data engineering intern, Python and SQL. '.repeat(3) }); setTimeout(() => r('still open after 3 s'), 3000); })", { contextId: ctx.id });
    eq('X1', 'analyze port from the content script', port, 'disconnected');
    for (const type of ['OVERLAY_STATE', 'OVERLAY_READY', 'VAULT_GET_DATA', 'POPUP_STATUS']) {
      const r = await P.raw(`chrome.runtime.sendMessage({ type: ${J(type)} }).then(r => r === undefined ? 'no reply' : 'reply: ' + JSON.stringify(r), e => 'no reply (' + e.message + ')')`, { contextId: ctx.id });
      check('X1', r.startsWith('no reply'), `${type} from the content script: ${r}`);
    }
    eq('X1', 'Claude requests', B.api(m).length, 0);
    const O = await B.overlay(P);
    await closeOverlay(O);
  });

  await step('9.3', async () => {
    await B.posting(P, tabId);
    await P.js("_q('a.apply').focus(); return true;");
    await P.key('Enter');
    const O = await B.overlay(P);
    await sleep(500);
    const m = B.mark();
    eq('9.3', 'focus on the heading', await O.v('document.activeElement.id'), 'state-heading');
    await P.key('Enter');
    await sleep(800);
    eq('9.3', 'Enter on the prompt: heading, requests', [await O.text('#state-heading'), B.api(m).length], ['Find friends for this job?', 0]);
    const fwd = [];
    const page = [];
    for (let i = 0; i < 4; i++) { await P.key('Tab'); fwd.push(await O.v('[_ae(), _ring(document.activeElement)]')); page.push(await P.v('document.activeElement.id || document.activeElement.tagName')); }
    eq('9.3', 'Tab', fwd.map(f => f[0]), ['Find friends', 'Not now', 'close-btn', 'Find friends']);
    const back = [];
    for (let i = 0; i < 3; i++) { await P.key('Tab', true); back.push(await O.v('_ae()')); page.push(await P.v('document.activeElement.id || document.activeElement.tagName')); }
    eq('9.3', 'Shift+Tab', back, ['close-btn', 'Not now', 'Find friends']);
    eq('9.3', 'rings', fwd.map(f => f[1]), [true, true, true, true]);
    check('9.3', !page.includes('receipt'), `page focus during the cycle: ${J([...new Set(page)])}`);
    const world = B.contentWorld(P);
    if (world) note('9.3', `content script will return focus to: ${await P.raw("returnFocus ? (returnFocus.id || returnFocus.tagName) : 'nothing'", { contextId: world.id }).catch(e => e.message)}`);
    await P.key('Escape');
    await P.until("!_q('iframe[title=\"Job Notifier\"]')", 3000);
    eq('9.3', 'after Escape: focus, :focus-visible', await P.v("[_t(document.activeElement), document.activeElement.matches(':focus-visible')]"), ['Download receipt', true]);
  });

  await step('9.4', async () => {
    await B.confirm(P, tabId);
    await P.mouse(60, 700);
    const closed = await P.until("!_q('iframe[title=\"Job Notifier\"]')", 3000).then(() => true, () => false);
    eq('9.4', 'click on the dimmed area closes the prompt', closed, true);
    const O = await B.confirm(P, tabId);
    B.apiQueue = [{ delay: 1500 }];
    await O.click('text=Find friends');
    const loadingFocus = await O.until("document.activeElement.id === 'state-heading' && _t(_id('state-heading')) === 'Finding friends…'", 2500).then(() => true, () => false);
    check('9.4', loadingFocus, 'focus on the Finding friends… heading');
    await B.results(O, '#state-heading');
    B.expectedApi += 1;
    eq('9.4', 'focus on the results heading', await O.v('document.activeElement.id'), 'state-heading');
    const expected = await O.v("_qa('#dialog a[href], #dialog button, #dialog input, #dialog select, #dialog textarea').filter(el => el.tabIndex >= 0 && el.getClientRects().length).map(el => el.id || el.getAttribute('aria-label') || _t(el))");
    const seq = [];
    for (let i = 0; i < expected.length; i++) { await P.key('Tab'); seq.push(await O.v('[_ae(), _ring(document.activeElement)]')); }
    const reached = new Set(seq.map(s => s[0]));
    eq('9.4', `controls not reached by Tab (of ${expected.length})`, expected.filter(e => !reached.has(e)), []);
    for (const want of [/^Select /, /^Message to /, /^Open email to /, /^Copy message to /, /^recruiter-input$/, /^Open next email/, /^Copy all$/]) {
      check('9.4', seq.some(s => want.test(s[0])), `Tab reaches ${want.source.replace(/[\\^$]/g, '')}`);
    }
    eq('9.4', 'controls without the ring', seq.filter(s => !s[1]).map(s => s[0]), []);
    await P.mouse(60, 700);
    await sleep(500);
    eq('9.4', 'dimmed-area click in results', await B.hasFrame(P), true);
    await O.js("_id('state-heading').focus(); return true;");
    await P.key('Escape');
    const gone = await P.until("!_q('iframe[title=\"Job Notifier\"]')", 3000).then(() => true, () => false);
    eq('9.4', 'Escape closes results', gone, true);
  });

  await step('10.3', async () => {
    const O = await B.confirm(P, tabId);
    await O.js(STUB_OPEN);
    await O.click('text=Find friends');
    await B.results(O, '#state-heading');
    B.expectedApi += 1;
    report.O10 = O;
    const copy = '.matches li:first-child [aria-label^="Copy message to"]';
    const draft = await O.v("_qa('.matches textarea')[0].value");
    const errorsBefore = (await B.info()).runtimeErrors.length;
    // Watch whether the Clipboard API itself works in the frame, or only ui.js's execCommand fallback.
    await O.js("const orig = navigator.clipboard.writeText.bind(navigator.clipboard); window.__clip = [];"
      + " navigator.clipboard.writeText = t => orig(t).then(r => { window.__clip.push('resolved'); return r; }, e => { window.__clip.push('rejected: ' + e.message); throw e; }); return true;");
    await O.click(copy);
    await sleep(150);
    eq('10.3', 'Copy label', await O.text(copy), 'Copied');
    const clip = await S.raw('navigator.clipboard.readText()').catch(e => `clipboard read failed: ${e.message}`);
    eq('10.3', 'clipboard is the draft', clip, draft);
    await sleep(2200);
    const errorsAfter = (await B.info()).runtimeErrors.length;
    const src = new URL(await P.v("_q('iframe[title=\"Job Notifier\"]').src")).host;
    eq('10.3', 'Clipboard API in the frame (writeText), not the execCommand fallback', await O.v('window.__clip'), ['resolved']);
    eq('10.3', "allowsFeature('clipboard-write') in the frame", await O.v("document.featurePolicy ? document.featurePolicy.allowsFeature('clipboard-write') : 'n/a'"), true);
    eq('10.3', 'frame allow attribute', await P.v("_q('iframe[title=\"Job Notifier\"]').allow"), `clipboard-write ${B.origin}`);
    eq('10.3', 'permissions-policy lines from the copy (console, extension errors)',
      [B.logs.filter(l => /Permissions policy/i.test(l.text)).map(l => l.text), errorsAfter - errorsBefore], [[], 0]);
    note('10.3', `frame src host ${src === B.id ? 'is the extension ID' : 'is a dynamic ID'}; frame document origin host ${(await O.v('location.host')) === B.id ? 'is the extension ID' : 'is not the extension ID'}`);
    await O.js("navigator.clipboard.writeText = () => Promise.reject(new Error('blocked')); document.execCommand = () => false; return true;");
    await O.click(copy);
    await sleep(200);
    eq('10.3', 'Copy failure: label, alert, focus, selection', await O.v(`(() => { const li = _q('.matches li'); const ta = _q('textarea', li); return [_t(_q(${J(copy)})), _t(_q('[role=alert]', li)), document.activeElement === ta, ta.selectionStart === 0 && ta.selectionEnd === ta.value.length]; })()`),
      ['Copy', "Couldn't copy. The message is selected, so press Ctrl+C (Cmd+C on a Mac).", true, true]);
    await O.click('.matches ~ .stack .btn-secondary');
    await sleep(200);
    eq('10.3', 'Copy all failure', await O.v("_qa('[role=alert]').map(_t).filter(Boolean).pop()"), "Couldn't copy. Copy each message from its box instead.");
  });

  await step('10.4', async () => {
    const O = report.O10;
    await O.set('#recruiter-input', 'https://example.com/recruiter');
    eq('10.4', 'non-LinkedIn link', await O.text('#recruiter-status'), "That doesn't look like a LinkedIn link, so it won't be included.");
    await O.set('#recruiter-input', LINKEDIN);
    eq('10.4', 'LinkedIn link', await O.text('#recruiter-status'), 'Added to your emails.');
  });

  await step('10.5', async () => {
    const O = report.O10;
    eq('10.5', 'opened before any click', await O.v('window.__opened.length'), 0);
    const open = '.matches li:first-child [aria-label^="Open email to"]';
    const [draft, email] = await O.v("[_qa('.matches textarea')[0].value, _t(_q('.matches li .match-email'))]");
    await O.click(open);
    await sleep(150);
    eq('10.5', 'label', await O.text(open), 'Opened');
    await sleep(2200);
    eq('10.5', 'label after 2 s', await O.text(open), 'Open email');
    const url = new URL((await O.v('window.__opened'))[0]);
    eq('10.5', 'mailto: to, subject, body', [url.protocol, decodeURIComponent(url.pathname), url.searchParams.get('subject'), url.searchParams.get('body')],
      ['mailto:', email, 'Job opportunity: Data Engineering Intern at Kestrel Grid', `${draft}\n\nRecruiter contact for this role: ${LINKEDIN}`]);
    manual('10.5', 'The mail app opening a draft (the run captured the mailto: URL instead of launching it).');
  });

  await step('10.6', async () => {
    const O = report.O10;
    const texts = [await O.v("_t(_q('.matches ~ .stack .btn-primary'))")];
    for (let i = 0; i < 3; i++) { await O.click('.matches ~ .stack .btn-primary'); await sleep(100); texts.push(await O.v("_t(_q('.matches ~ .stack .btn-primary'))")); }
    eq('10.6', 'button text per click', texts, ['Open next email (3 left)', 'Open next email (2 left)', 'Open next email (1 left)', 'All checked emails opened']);
    eq('10.6', 'drafts opened in total', await O.v('window.__opened.length'), 4);
    eq('10.6', 'done: aria-disabled, focusable', await O.v("(() => { const b = _q('.matches ~ .stack .btn-primary'); return [b.getAttribute('aria-disabled'), b.tabIndex >= 0 && !b.disabled]; })()"), ['true', true]);
    await O.js("_qa('.matches input[type=checkbox]').forEach(c => c.click()); return true;", { gesture: true });
    eq('10.6', 'all unchecked', await O.v("(() => { const b = _q('.matches ~ .stack .btn-primary'); return [_t(b), b.getAttribute('aria-disabled')]; })()"), ['Open next email (0 left)', 'true']);
  });

  await step('10.7', async () => {
    const O = report.O10;
    const sel = "_qa('.matches li')[1]";
    const orig = await O.v(`_q('textarea', ${sel}).value`);
    await O.js(`const ta = _q('textarea', ${sel}); ta.value += ' See www.example.com/apply'; ta.dispatchEvent(new Event('input', { bubbles: true })); return true;`);
    eq('10.7', 'with a link', await O.v(`[_vis(_q('.link-note', ${sel})), _t(_q('.link-note', ${sel}))]`), [true, 'This draft has a link or email address in it. Check it before you send.']);
    await O.js(`const ta = _q('textarea', ${sel}); ta.value = ${J(orig)}; ta.dispatchEvent(new Event('input', { bubbles: true })); return true;`);
    eq('10.7', 'after deleting it', await O.v(`_vis(_q('.link-note', ${sel}))`), false);
    await O.click('#close-btn');
    await P.until("!_q('iframe[title=\"Job Notifier\"]')", 4000);
  });

  await step('11.3', async () => {
    await B.posting(P, tabId);
    const m = B.mark();
    await P.click('a.apply');
    const O = await B.overlay(P);
    await sleep(1500);
    const urls = B.net.slice(m).map(e => e.url);
    eq('11.3', 'requests outside kestrel-grid.localhost and chrome-extension://', urls.filter(u => !u.startsWith(`http://kestrel-grid.localhost:${PORT}/`) && !u.startsWith('chrome-extension://')), []);
    const ext = [...new Set(urls.filter(u => u.startsWith('chrome-extension://')).map(u => new URL(u).pathname))].sort();
    // The frame's own overlay.html navigation isn't a Fetch-interceptable request; its subresources are.
    check('11.3', ['/overlay.css', '/ui.css', '/lib/core.js', '/ui.js', '/overlay.js', '/icons/icon16.png'].every(p => ext.includes(p)) && ext.some(p => p.startsWith('/fonts/')),
      `extension files (plus the overlay.html frame): ${ext.join(' ')}`);
    const fh = await O.fonts('#state-heading');
    const fb = await O.fonts('#prompt-body');
    check('11.5', fh.some(f => /Fraunces/.test(f)) && fb.some(f => /IBM Plex Sans/.test(f)), `overlay rendered fonts: heading ${J(fh)}, body ${J(fb)}`);
    eq('11.5', 'overlay: gradients, blur, radius over 4px (spinner excepted), emoji', await O.v(LOOK), { bad: [], emoji: false });
    note('11.5', `overlay screenshot: ${await P.shot('11.5-overlay')}`);
    await closeOverlay(O);
  });

  await step('11.4', async () => {
    const outside = B.net.filter(e => !e.url.startsWith('chrome-extension://') && !/^http:\/\/(kestrel-grid|hire-portal)\.localhost:/.test(e.url));
    eq('11.4', 'run B: requests other than POST api.anthropic.com/v1/messages', outside.filter(e => !(e.method === 'POST' && e.url === 'https://api.anthropic.com/v1/messages')).map(e => `${e.method} ${e.url}`), []);
    eq('11.4', 'run B: Claude requests vs Find friends / Try again clicks', outside.length, B.expectedApi);
    report.apiB = { calls: outside.length, expected: B.expectedApi };
  });

  await step('X5', async () => {
    const info = await B.info();
    eq('X5', 'run B: errors Chrome recorded for the extension', info.runtimeErrors.map(e => `${e.message} (${e.contextUrl || e.source}, ${e.occurrences}x)`), []);
    const swErr = B.logs.filter(l => B.swSessions.has(l.session) && /error|exception/.test(l.level)).map(l => l.text);
    eq('X5', 'run B: worker console errors', swErr, []);
    eq('X5', 'run B: "Unchecked runtime.lastError" or permissions-policy lines in any console (pages, frames, worker)',
      B.logs.filter(l => /Unchecked runtime\.lastError|Permissions policy/i.test(l.text)).map(l => l.text), []);
  });

  await step('X6', async () => {
    const { extensionMessages, directMessages } = B.channels();
    eq('X6', 'run B: secret-carrying vault messages from settings over extension messaging', extensionMessages.filter(t => SECRET_TYPES.includes(t)), []);
    note('X6', `run B: settings used extension messaging for ${J([...new Set(extensionMessages)])} and direct worker messages for ${J([...new Set(directMessages)])}`);
  });

  // V7 needs the live session key, so read it before Chrome exits and its LevelDB files are final.
  let vaultKey = (await B.swv("chrome.storage.session.get('vaultKey')").catch(() => ({}))).vaultKey;
  if (!vaultKey) {
    await B.unlock(S).catch(() => {});
    vaultKey = (await B.swv("chrome.storage.session.get('vaultKey')").catch(() => ({}))).vaultKey;
  }
  await B.b.stop();

  await step('V7', async () => {
    if (!check('V7', !!vaultKey, 'read the session key while unlocked')) return;
    const needles = [['API key', KEY], ['friend name', 'Priya Shah'], ['friend email', 'priya.shah@example.com'], ['passphrase', PASS], ['session vaultKey', vaultKey]];
    const hits = scanProfile(B.profile, needles);
    eq('V7', `plaintext secrets in the profile's LevelDB files (${hits.levelDbFiles} files searched)`, hits.levelDb, []);
    note('V7', `outside LevelDB (other profile files, for the #2 password-manager check): ${J(hits.other)}`);
  });
}

// Security check #7: searches every file of a stopped profile for each [label, text] (UTF-8 and UTF-16LE).
// LevelDB files are *.ldb, *.log and MANIFEST-* in a folder that has a CURRENT file.
function scanProfile(dir, needles) {
  const out = { levelDb: [], other: [], levelDbFiles: 0 };
  const walk = d => {
    for (const ent of fs.readdirSync(d, { withFileTypes: true })) {
      const file = path.join(d, ent.name);
      if (ent.isDirectory()) { walk(file); continue; }
      let buf;
      try { if (fs.statSync(file).size > 64 * 1024 * 1024) continue; buf = fs.readFileSync(file); } catch (e) { continue; }
      const levelDb = /\.(ldb|log)$|^MANIFEST-/.test(ent.name) && fs.existsSync(path.join(d, 'CURRENT'));
      if (levelDb) out.levelDbFiles++;
      for (const [label, text] of needles) {
        if (buf.includes(Buffer.from(text, 'utf8')) || buf.includes(Buffer.from(text, 'utf16le'))) {
          (levelDb ? out.levelDb : out.other).push(`${label} in ${path.relative(dir, file)}`);
        }
      }
    }
  };
  walk(dir);
  return out;
}

// ── Run C (Edge only): security check #3, a real relaunch that loads the extension from the command line ──
// Branded Chrome ignores --load-extension and forgets DevTools-loaded extensions at exit, so it can't run this.

async function runC() {
  const dir = path.join(WORK, 'ext-release');
  const C = new Run('C', dir);
  C.launchArgs = [`--disable-extensions-except=${dir}`, `--load-extension=${dir}`];
  const startC = async () => {
    await C.launch();
    const E = await C.extPage();
    C.id = await E.until("chrome.developerPrivate.getExtensionsInfo().then(all => (all.find(e => e.name === 'Job Notifier') || {}).id)", 10000, 'the command-line extension');
    C.origin = `chrome-extension://${C.id}`;
  };
  await startC();
  await step('V3', async () => {
    const S = C.settings = await C.open(`${C.origin}/options.html`);
    await S.until("_t(_id('vault-heading')) === 'Create a passphrase'", 8000);
    await S.js(`_id('setup-passphrase').value = ${J(PASS)}; _id('setup-confirm').value = ${J(PASS)}; _id('setup-submit').click(); return true;`);
    await S.until("_t(_id('vault-heading')) === 'Passphrase lock' && _vis(_id('friend-form'))", 10000);
    eq('V3', 'unlocked before the relaunch', await C.swv("!!(await chrome.storage.session.get('vaultKey')).vaultKey"), true);
    const vault = await C.swv("JSON.stringify((await chrome.storage.local.get('vault')).vault)");
    await C.b.stop();
    await startC(); // same profile and flags; the extension is not loaded again through DevTools
    const S2 = C.settings = await C.open(`${C.origin}/options.html`);
    await S2.until("_t(_id('vault-heading')) && _t(_id('vault-heading')) !== ''", 8000);
    await sleep(800);
    eq('V3', 'settings after the relaunch', await S2.text('#vault-heading'), 'Unlock saved data');
    eq('V3', 'session.get(null)', await C.swv('chrome.storage.session.get(null)'), {});
    eq('V3', 'encrypted vault kept', await C.swv(`JSON.stringify((await chrome.storage.local.get('vault')).vault) === ${J(vault)}`), true);
    manual('V3', "Quit with Exit from Chrome's menu in a windowed run (4.8 / #4).");
  });
  await C.b.stop();
}

// ── Report ──

function statusOf(id) {
  const r = R.get(id);
  if (!r || !r.checks.length) return 'NOT AUTOMATED';
  return r.checks.every(c => c.pass) ? 'PASS' : 'FAIL';
}

function markdown(meta) {
  const cell = s => String(s).replace(/\|/g, '\\|').replace(/</g, '&lt;').replace(/\r?\n/g, ' ');
  const counts = { PASS: 0, FAIL: 0, 'NOT AUTOMATED': 0 };
  const blockers = { PASS: 0, FAIL: 0, 'NOT AUTOMATED': 0 };
  const rows = [];
  for (const [id, blocker, title] of STEPS) {
    const st = statusOf(id);
    if (/^\d/.test(id)) { counts[st]++; if (blocker) blockers[st]++; } // X and V rows aren't walkthrough steps
    const r = R.get(id) || { checks: [], notes: [], manual: '' };
    const failed = r.checks.filter(c => !c.pass).map(c => `FAIL ${c.evidence}`);
    const passed = r.checks.filter(c => c.pass).map(c => c.evidence);
    const evidence = [...failed, ...passed, ...r.notes].map(e => short(e, 260)).join('; ') || NOT_AUTOMATED[id] || '';
    rows.push(`| ${id} ${cell(title)} | ${blocker ? 'Blocker' : ''} | ${st} | ${cell(evidence)} | ${cell(r.manual || (st === 'NOT AUTOMATED' ? 'All of it' : ''))} |`);
  }
  return [
    `Run: ${meta.date}, ${meta.browserA} (run A) / ${meta.browserB} (run B), zip SHA-256 \`${meta.sha}\`, extension IDs ${meta.idA} (A) and ${meta.idB} (B).`,
    '',
    `Walkthrough steps: ${counts.PASS} PASS, ${counts.FAIL} FAIL, ${counts['NOT AUTOMATED']} NOT AUTOMATED. Blockers: ${blockers.PASS} PASS, ${blockers.FAIL} FAIL, ${blockers['NOT AUTOMATED']} NOT AUTOMATED.`,
    `Recorded: sender.url at the OVERLAY_STATE pause ${J(meta.senderUrl)}; frame host differs from the extension ID: ${meta.dynamicHost}; onUpdated for pushState ${J(meta.pushState)}; for pushState and hash ${J(meta.pushStateHash)}.`,
    '',
    '| Step | Blocker | Status | Evidence | Still manual |',
    '|---|---|---|---|---|',
    ...rows,
    '',
  ].join('\n');
}

// ── Setup and main ──

function prepare() {
  fs.mkdirSync(WORK, { recursive: true });
  const rel = path.join(WORK, 'ext-release');
  const all = path.join(WORK, 'ext-allsites');
  if (fs.existsSync(rel)) throw new Error(`${rel} already exists; pass a new --work folder`);
  fs.mkdirSync(rel);
  const tar = process.platform === 'win32' ? path.join(process.env.SystemRoot || 'C:/Windows', 'System32', 'tar.exe') : 'unzip';
  if (process.platform === 'win32') execFileSync(tar, ['-xf', ZIP, '-C', rel]);
  else execFileSync('unzip', ['-q', ZIP, '-d', rel]);
  fs.cpSync(rel, all, { recursive: true });
  const m = JSON.parse(fs.readFileSync(path.join(all, 'manifest.json'), 'utf8'));
  m.host_permissions = [...m.host_permissions, ...ALL];
  fs.writeFileSync(path.join(all, 'manifest.json'), J(m, null, 2));
  return crypto.createHash('sha256').update(fs.readFileSync(ZIP)).digest('hex');
}

function serve() {
  const types = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.json': 'application/json', '.js': 'text/javascript', '.png': 'image/png', '.svg': 'image/svg+xml' };
  const server = http.createServer((req, res) => {
    const file = path.join(DOCS, decodeURIComponent(new URL(req.url, 'http://x').pathname));
    if (!file.startsWith(DOCS)) { res.writeHead(403); return res.end(); }
    fs.readFile(file, (err, data) => {
      if (err) { res.writeHead(404); return res.end('not found'); }
      const body = file.endsWith('.html') && PORT !== 8080 ? Buffer.from(data.toString().replaceAll(':8080/', `:${PORT}/`)) : data;
      res.writeHead(200, { 'content-type': types[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' });
      res.end(body);
    });
  });
  return new Promise((resolve, reject) => server.once('error', reject).listen(PORT, '127.0.0.1', () => resolve(server)));
}

async function main() {
  const sha = prepare();
  log(`work folder: ${WORK}\nbrowser: ${EXE}\nzip: ${ZIP} (${sha})`);
  const server = await serve();
  try {
    const only = arg('only', 'ABC'); // --only A, B or C runs one profile, for debugging
    if (only.includes('A')) await runA().catch(e => log('run A stopped:', e.stack));
    if (only.includes('B')) await runB().catch(e => log('run B stopped:', e.stack));
    if (only.includes('C') && IS_EDGE) await runC().catch(e => log('run C stopped:', e.stack));
  } finally {
    server.close();
    killStray(path.join(WORK, 'profile-A'));
    killStray(path.join(WORK, 'profile-B'));
    killStray(path.join(WORK, 'profile-C'));
  }
  const meta = {
    date: new Date().toISOString().slice(0, 10), browserA: report.versionA, browserB: report.versionB, sha, idA: report.idA, idB: report.idB,
    senderUrl: report.senderUrl, dynamicHost: report.dynamicHost, pushState: report.pushState, pushStateHash: report.pushStateHash,
  };
  const table = markdown(meta);
  fs.writeFileSync(path.join(WORK, 'results.json'), J({ meta, report: { apiA: report.apiA, apiB: report.apiB, storage: report.storage },
    steps: Object.fromEntries(STEPS.map(([id]) => [id, { status: statusOf(id), ...(R.get(id) || {}) }])) }, null, 2));
  fs.writeFileSync(path.join(WORK, 'results-table.md'), table);
  if (RESULTS) {
    const file = path.resolve(ROOT, RESULTS);
    const old = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
    const cut = old.indexOf('<!-- precheck table -->');
    const head = cut >= 0 ? old.slice(0, cut) : '# Walkthrough pre-check results\n\n';
    fs.writeFileSync(file, `${head}<!-- precheck table -->\n${table}`);
  }
  log(`\n${table}`);
  log(`results: ${path.join(WORK, 'results.json')}`);
  process.exitCode = STEPS.some(([id]) => statusOf(id) === 'FAIL') ? 1 : 0;
}

main().catch(e => { console.error(e.stack); process.exitCode = 1; });
