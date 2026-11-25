// Static checks for the public release (docs/specs/public-release.md): manifest
// shape, packaging, docs, and grep-style rules over the runtime files. Each test
// name cites the acceptance criterion it checks.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync, spawnSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const exists = rel => fs.existsSync(path.join(ROOT, rel));
function read(rel, enc = 'utf8') {
  assert.ok(exists(rel), `${rel} is missing`);
  return fs.readFileSync(path.join(ROOT, rel), enc);
}
const git = (args, env) =>
  execFileSync('git', args, { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 1 << 28 });

const manifest = JSON.parse(read('manifest.json'));
const pkg = JSON.parse(read('package.json'));

// Files git would commit: tracked or untracked, minus .gitignore'd.
const treeFiles = git(['ls-files', '-co', '--exclude-standard']).toString().split('\n').filter(f => f && exists(f));

// Criterion 19's list: manifest, scripts, html/css, lib/, icons/, bundled fonts and their licenses.
const RUNTIME = /^(manifest\.json|[^/]+\.(js|html|css)|lib\/.+\.js|icons\/.+\.png|fonts\/.+\.(woff2|txt))$/;
const runtimeFiles = treeFiles.filter(f => RUNTIME.test(f));
const runtimeCode = runtimeFiles.filter(f => /\.(js|html|css)$/.test(f)).map(f => ({ f, text: read(f) }));
const runtimeJs = runtimeCode.filter(x => x.f.endsWith('.js'));
const runtimeCss = runtimeCode.filter(x => x.f.endsWith('.css'));
const grepRuntime = (re, files = runtimeCode) => files.filter(x => re.test(x.text)).map(x => x.f);
const KEY_RE = /sk-ant-[A-Za-z0-9_-]{20,}/;

// What `git archive` would put in the zip if the working tree were committed now.
// Uses a throwaway index and object dir so nothing is written to the repo.
let packed;
function packList() {
  if (packed) return packed;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jn-pack-'));
  try {
    const env = {
      ...process.env,
      GIT_INDEX_FILE: path.join(tmp, 'index'),
      GIT_OBJECT_DIRECTORY: path.join(tmp, 'objects'),
      GIT_ALTERNATE_OBJECT_DIRECTORIES: path.resolve(ROOT, git(['rev-parse', '--git-path', 'objects']).toString().trim()),
    };
    fs.mkdirSync(env.GIT_OBJECT_DIRECTORY);
    git(['add', '-A'], env);
    const tree = git(['write-tree'], env).toString().trim();
    packed = tarFileNames(git(['archive', '--worktree-attributes', '--format=tar', tree], env));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  return packed;
}

// ponytail: reads ustar names only; paths over 100 chars (pax records) would come out truncated.
function tarFileNames(buf) {
  const str = (a, b) => buf.toString('utf8', a, b).replace(/\0.*$/s, '');
  const names = [];
  for (let off = 0; off + 512 <= buf.length && buf[off] !== 0;) {
    const size = parseInt(str(off + 124, off + 136).trim() || '0', 8);
    const prefix = str(off + 345, off + 500);
    const name = str(off, off + 100);
    if (buf[off + 156] === 0x30) names.push(prefix ? `${prefix}/${name}` : name);
    off += 512 + Math.ceil(size / 512) * 512;
  }
  return names;
}

// Files the manifest, HTML pages, and CSS point at.
function referencedFiles() {
  const m = manifest;
  const list = [
    ...Object.values(m.icons || {}),
    ...Object.values(m.action?.default_icon || {}),
    m.action?.default_popup,
    m.options_ui?.page,
    m.background?.service_worker,
    ...(m.web_accessible_resources || []).flatMap(w => w.resources || []),
    ...(m.content_scripts || []).flatMap(c => [...(c.js || []), ...(c.css || [])]),
  ].filter(Boolean);
  for (const { f, text } of runtimeCode) {
    const re = f.endsWith('.html') ? /\b(?:src|href)="([^"#:?]+)"/g : f.endsWith('.css') ? /url\(\s*["']?([^"')#:?]+)/g : null;
    if (!re) continue;
    for (const [, ref] of text.matchAll(re)) list.push(path.posix.normalize(path.posix.join(path.posix.dirname(f), ref)));
  }
  return [...new Set(list)];
}

function overlayPage() {
  const page = manifest.web_accessible_resources?.[0]?.resources?.[0];
  assert.ok(page, 'manifest has no web-accessible overlay page');
  return page;
}

function pngSize(rel) {
  const b = read(rel, null);
  assert.equal(b.toString('latin1', 1, 4), 'PNG', `${rel} isn't a PNG`);
  return { w: b.readUInt32BE(16), h: b.readUInt32BE(20), colorType: b[25] };
}

function hsl(r, g, b) {
  [r, g, b] = [r / 255, g / 255, b / 255];
  const max = Math.max(r, g, b), min = Math.min(r, g, b), l = (max + min) / 2, d = max - min;
  if (!d) return { h: 0, s: 0, l };
  const h = max === r ? 60 * (((g - b) / d) % 6) : max === g ? 60 * ((b - r) / d + 2) : 60 * ((r - g) / d + 4);
  return { h: (h + 360) % 360, s: d / (1 - Math.abs(2 * l - 1)), l };
}

function colorsIn(text) {
  const out = [];
  for (const [m, hex] of text.matchAll(/(?<![\w&])#([0-9a-f]{3,8})\b/gi)) {
    if (![3, 4, 6, 8].includes(hex.length)) continue;
    const full = hex.length <= 4 ? [...hex.slice(0, 3)].map(c => c + c).join('') : hex.slice(0, 6);
    out.push([m, ...[0, 2, 4].map(i => parseInt(full.slice(i, i + 2), 16))]);
  }
  for (const m of text.matchAll(/rgba?\(\s*(\d+)[\s,]+(\d+)[\s,]+(\d+)/gi)) out.push([m[0], +m[1], +m[2], +m[3]]);
  return out;
}

// ── Secrets and data hygiene ──

test('criterion 1: no API key anywhere in the working tree', () => {
  for (const f of treeFiles) assert.doesNotMatch(read(f, 'latin1'), KEY_RE, f);
});

test('criterion 2: the example friend is never loaded as data', () => {
  assert.deepEqual(grepRuntime(/friends\.json/), []);
});

// ── Permissions and site access ──

test('criterion 3/4: site access is optional all-sites access plus activeTab, nothing unused', () => {
  assert.equal(manifest.content_scripts, undefined, 'content scripts are registered at runtime, not in the manifest');
  assert.deepEqual(manifest.host_permissions, ['https://api.anthropic.com/*']);
  assert.deepEqual([...(manifest.optional_host_permissions || [])].sort(), ['http://*/*', 'https://*/*']);
  const perms = manifest.permissions || [];
  for (const p of ['activeTab', 'scripting', 'storage']) assert.ok(perms.includes(p), `permissions needs ${p}`);
  const js = runtimeJs.map(x => x.text).join('\n');
  const used = { activeTab: /./, scripting: /chrome\.scripting\./, storage: /chrome\.storage\./, clipboardWrite: /execCommand\(\s*['"]copy|clipboard\.write/ };
  for (const p of perms) {
    assert.ok(p in used, `${p} isn't a permission this release needs`);
    assert.match(js, used[p], `${p} is declared but unused`);
  }
});

test('criterion 3/21: README and the store listing justify every permission and host pattern', () => {
  const all = [...(manifest.permissions || []), ...(manifest.host_permissions || []), ...(manifest.optional_host_permissions || [])];
  const readme = read('README.md');
  const listing = read('docs/store-listing.md');
  for (const p of all) {
    assert.ok(readme.includes(p), `README doesn't mention ${p}`);
    assert.ok(listing.includes(p), `store listing doesn't mention ${p}`);
  }
});

test('criterion 5: the popup reads the page with scripting.executeScript, so tabs open before install work', () => {
  const popup = read('popup.js');
  assert.match(popup, /chrome\.scripting\.executeScript/);
  assert.doesNotMatch(popup, /chrome\.tabs\.sendMessage/, 'a content-script message fails in tabs opened before install');
});

// ── Auto-detect ──

test('criterion 7: the settings page states auto-detect is off unless turned on', () => {
  assert.match(read('options.html'), /Off unless you turn it on/);
});

test('criterion 36: turning auto-detect off unregisters the script and returns the all-sites permission', () => {
  const js = runtimeJs.map(x => x.text).join('\n');
  for (const api of ['scripting.registerContentScripts', 'scripting.unregisterContentScripts',
    'permissions.request', 'permissions.remove', 'permissions.onAdded', 'permissions.onRemoved']) {
    assert.ok(js.includes(api), `runtime code never calls ${api}`);
  }
  for (const page of ['popup', 'options']) {
    assert.match(read(`${page}.html`) + read(`${page}.js`), /Nothing is sent (to Claude )?until you click Find friends/, `${page} explains before Chrome's prompt`);
  }
});

// ── Errors, states, accessibility ──

test('criterion 12: pages declare lang="en", keep focus outlines, and the overlay is a modal dialog', () => {
  for (const { f, text } of runtimeCode.filter(x => x.f.endsWith('.html'))) assert.match(text, /<html\b[^>]*\blang="en"/, f);
  assert.deepEqual(grepRuntime(/outline(?:-style)?\s*[:=]\s*['"]?(none|0)\b/i), [], 'files that remove the focus outline');
  const html = read(overlayPage());
  assert.match(html, /role="dialog"/);
  assert.match(html, /aria-modal="true"/);
});

// ── Setup and settings ──

test('criterion 14: the model is picked from a select, not free text', () => {
  assert.match(read('options.html'), /<select\b[^>]*\bid="model"/);
});

test('criterion 15: the settings page explains cost and data use above the key field', () => {
  const html = read('options.html');
  const lower = html.toLowerCase();
  const key = html.search(/id="api-key"/);
  assert.ok(key > 0, 'options.html has the api-key field');
  for (const phrase of ['billed to your Anthropic account', '8,000 characters', 'skills, interests, and level',
    'Never sent', 'email addresses', 'recruiter link', 'unencrypted', 'spend limit']) {
    const i = lower.indexOf(phrase.toLowerCase());
    assert.ok(i >= 0 && i < key, `"${phrase}" should appear before the API key field`);
  }
});

test('criterion 34: settings page masks the key and says it is stored unencrypted', () => {
  const html = read('options.html');
  assert.match(html, /<input\b(?=[^>]*\bid="api-key")(?=[^>]*\btype="password")[^>]*>/);
  assert.match(html, /unencrypted/i);
  assert.match(html, /spend limit/i);
});

// ── Privacy, license, versioning ──

test('criterion 16: PRIVACY.md covers reading, storage, sending, deletion, and contact, and is linked', () => {
  const p = read('PRIVACY.md');
  for (const re of [/visible text/i, /chrome\.storage\.local/, /chrome\.storage\.session/, /Anthropic/, /analytics/i,
    /uninstall/i, /https:\/\/(www\.)?anthropic\.com\/[^\s)]*privacy/i, /https:\/\/github\.com\/[^\s)]+\/issues/,
    /unencrypted/i, /spend limit/i]) {
    assert.match(p, re);
  }
  assert.doesNotMatch(p, /[\w.+-]+@[\w-]+\.[a-z]{2,}/i, 'no email address is published (Decision 10)');
  assert.match(read('README.md'), /PRIVACY\.md/);
  assert.match(read('options.html'), /PRIVACY\.md/);
  assert.match(read('docs/store-listing.md'), /PRIVACY\.md/);
});

test('criterion 17: an MIT LICENSE matches package.json', () => {
  const license = read('LICENSE');
  assert.match(license, /^MIT License/);
  assert.match(license, /Permission is hereby granted, free of charge/);
  assert.equal(pkg.license, 'MIT');
});

test('criterion 18: manifest.json and package.json are both version 2.0.0', () => {
  assert.equal(manifest.version, pkg.version, 'versions differ');
  assert.equal(manifest.version, '2.0.0');
});

// ── Packaging and docs ──

test('criterion 19: the release zip holds only runtime files', () => {
  const files = packList();
  const friendsUsed = runtimeCode.some(x => x.text.includes('friends.json'));
  // Decision 17: LICENSE ships in the zip; README.md, PRIVACY.md, and other docs don't.
  const extra = files.filter(f => !RUNTIME.test(f) && f !== 'LICENSE' && !(f === 'friends.json' && friendsUsed));
  assert.deepEqual(extra, [], 'add export-ignore entries in .gitattributes for these');
  assert.ok(files.includes('LICENSE'), 'LICENSE must be in the zip (Decision 17)');
  for (const f of referencedFiles()) assert.ok(files.includes(f), `${f} is referenced but not in the zip`);
  assert.match(pkg.scripts?.package || '', /git archive\b.*--format=zip/, 'npm run package builds the zip with git archive');
  assert.match(read('README.md'), /npm run package/);
  assert.match(read('.gitignore'), /^\/?dist\/?$/m);
});

test('criterion 38: the release zip has no secrets', () => {
  for (const f of packList()) {
    assert.doesNotMatch(f, /(^|\/)(\.env[^/]*|config\.js)$/, f);
    assert.doesNotMatch(read(f, 'latin1'), KEY_RE, f);
  }
});

// Reads the team lead's table rows: | fonts/<file> | <source URL> | <bytes> | <SHA-256> |
test('criterion 38: every file in fonts/ matches its logged source URL and SHA-256', () => {
  const log = read('docs/specs/public-release.md');
  const rows = new Map([...log.matchAll(/^\|\s*(fonts\/[^|\s]+)\s*\|\s*(https:\/\/\S+)\s*\|\s*\d+\s*\|\s*([0-9a-f]{64})\s*\|/gm)]
    .map(m => [m[1], m[3]]));
  const fonts = runtimeFiles.filter(f => f.startsWith('fonts/'));
  assert.ok(fonts.some(f => f.endsWith('.woff2')), 'no bundled fonts under fonts/');
  for (const f of fonts) {
    assert.ok(rows.has(f), `${f} has no row (file | source URL | bytes | SHA-256) in the handoff log`);
    assert.equal(crypto.createHash('sha256').update(read(f, null)).digest('hex'), rows.get(f), `${f} doesn't match its logged SHA-256`);
  }
});

test('criterion 20: README covers the store install, privacy, troubleshooting; DOCS matches the code', () => {
  const r = read('README.md');
  assert.match(r, /Chrome Web Store/);
  assert.match(r, /PRIVACY\.md/);
  assert.match(r, /^#+ .*Troubleshooting/im);
  const dev = r.search(/^#+ .*Development/im);
  assert.ok(dev >= 0, 'README has a Development section');
  assert.ok(!r.slice(0, dev).includes('Load unpacked'), 'Load unpacked lives under Development');
  const d = read('DOCS.md');
  assert.doesNotMatch(d, /small backend/i, 'DOCS.md:123 matches the bring-your-own-key architecture');
  assert.doesNotMatch(d, /lastJob/, 'the any-tab fallback is gone (Decision 13)');
  assert.doesNotMatch(d, /`autoDetect`[^\n]*default `true`/, 'auto-detect defaults to off');
  assert.doesNotMatch(d, /until saved, `friends\.json`/, 'the example friend is not loaded');
});

test('criterion 21: the store listing doc has every required field', () => {
  const l = read('docs/store-listing.md');
  assert.equal(manifest.name, 'Job Notifier');
  assert.ok(manifest.description.length <= 132, 'manifest description is the 132-character summary');
  assert.ok(l.includes(manifest.description), 'listing summary matches the manifest description');
  for (const re of [/Job Notifier/, /Productivity/, /single purpose/i, /PRIVACY\.md/]) assert.match(l, re);
});

test('criterion 21: store assets are the required sizes, PNG without alpha', () => {
  for (const [f, w, h] of [
    ['docs/assets/screenshot-1-overlay.png', 1280, 800],
    ['docs/assets/screenshot-2-popup.png', 1280, 800],
    ['docs/assets/screenshot-3-settings.png', 1280, 800],
    ['docs/assets/promo-440x280.png', 440, 280],
  ]) {
    const p = pngSize(f);
    assert.deepEqual([p.w, p.h], [w, h], f);
    assert.equal(p.colorType, 2, `${f} must be 24-bit RGB with no alpha`);
  }
});

test('criterion 21: every manifest icon is a PNG of its declared size', () => {
  assert.ok(manifest.icons?.['128'], 'a 128px icon is declared');
  for (const icons of [manifest.icons, manifest.action?.default_icon]) {
    for (const [size, f] of Object.entries(icons || {})) {
      const p = pngSize(f);
      assert.deepEqual([p.w, p.h], [+size, +size], f);
    }
  }
});

// ── Look ──

test('criterion 22: no gradients, blur, or emoji and symbol icons', () => {
  assert.deepEqual(grepRuntime(/gradient\s*\(/i), [], 'files with gradients');
  assert.deepEqual(grepRuntime(/backdrop-filter|blur\s*\(/i), [], 'files with blur');
  assert.deepEqual(grepRuntime(/(?![©®™])[\p{Extended_Pictographic}■-◿☀-➿]/u), [], 'files with emoji or symbol characters');
});

test('criterion 22: corner radius 4px or less, and only the overlay panel has a shadow', () => {
  const bad = [];
  for (const { f, text } of runtimeCode) {
    for (const [, v] of text.matchAll(/(?:border(?:-[a-z]+)*-radius|borderRadius|--radius[\w-]*)\s*[:=]\s*['"]?([^;}'"\n]+)/gi)) {
      for (const tok of v.replace(/!important/, '').trim().split(/[\s/]+/)) {
        const px = /^(\d*\.?\d+)px$/.exec(tok);
        // 50% is allowed for the design's 16px spinner ring.
        const ok = tok === '0' || tok === '50%' || /^(var\(--[\w-]+\)|inherit|initial|unset)$/.test(tok) || (px && +px[1] <= 4);
        if (!ok) bad.push(`${f}: radius ${v.trim()}`);
      }
    }
    for (const [, v] of text.matchAll(/(?:box-shadow|boxShadow)\s*[:=]\s*['"]?([^;}'"\n]+)/gi)) {
      if (!/^(none|var\(--shadow-panel\)|inherit|initial|unset)$/.test(v.replace(/!important/, '').trim())) bad.push(`${f}: shadow ${v.trim()}`);
    }
  }
  assert.deepEqual(bad, []);
});

test('criterion 22: one teal accent plus the error red, no purple', () => {
  const bad = [];
  for (const { f, text } of runtimeCode) {
    for (const [m, r, g, b] of colorsIn(text)) {
      const { h, s, l } = hsl(r, g, b);
      const chromatic = s >= 0.2 && l > 0.08 && l < 0.95;
      const teal = h >= 160 && h <= 190;
      const errorRed = h <= 15 || h >= 345;
      if (chromatic && !teal && !errorRed) bad.push(`${f}: ${m}`);
    }
  }
  for (const { f, text } of runtimeCss) {
    if (/\b(purple|violet|indigo|magenta|fuchsia|orchid|plum|lavender)\b/i.test(text)) bad.push(`${f}: named purple color`);
  }
  assert.deepEqual(bad, []);
});

test('criterion 22: Fraunces and IBM Plex Sans are bundled with their OFL texts, and Inter is never used', () => {
  const faces = runtimeCss.flatMap(({ f, text }) => [...text.matchAll(/@font-face\s*{([^}]*)}/g)].map(m => ({ f, body: m[1] })));
  const families = new Set(faces.map(x => /font-family\s*:\s*["']?([^"';]+)/.exec(x.body)?.[1].trim()));
  assert.ok(families.has('Fraunces'), '@font-face for Fraunces');
  assert.ok(families.has('IBM Plex Sans'), '@font-face for IBM Plex Sans');
  for (const { f, body } of faces) {
    for (const [, u] of body.matchAll(/url\(\s*["']?([^"')]+)/g)) {
      assert.doesNotMatch(u, /^(https?:)?\/\//, `${f}: fonts load from the extension, not a CDN`);
      assert.ok(exists(path.posix.join(path.posix.dirname(f), u)), `${u} (from ${f}) is missing`);
    }
  }
  const licenses = runtimeFiles.filter(f => /^fonts\/.+\.txt$/.test(f)).map(f => read(f)).filter(t => /SIL Open Font License/.test(t));
  assert.ok(licenses.some(t => /Fraunces/.test(t)), 'Fraunces OFL text under fonts/');
  assert.ok(licenses.some(t => /Plex/.test(t)), 'IBM Plex OFL text under fonts/');
  for (const { f, text } of runtimeCss) {
    assert.doesNotMatch(text, /\bInter\b/, f);
    for (const [, v] of text.replace(/@font-face\s*{[^}]*}/g, '').matchAll(/font-family\s*:\s*([^;}]+)/g)) {
      assert.match(v, /Fraunces|IBM Plex Sans|var\(--font-|inherit/, `${f}: font-family ${v.trim()}`);
    }
  }
});

// ── Regression ──

test('criterion 23: every file the manifest, pages, and stylesheets reference exists', () => {
  const missing = referencedFiles().filter(f => !exists(f));
  assert.deepEqual(missing, []);
});

test('criterion 23: the CI manifest check passes on the current manifest', () => {
  const scripts = [...read('.github/workflows/test.yml').matchAll(/node -e '([^']*)'/g)].map(m => m[1]);
  assert.ok(scripts.length > 0, 'CI has a node -e manifest check');
  for (const s of scripts) {
    const r = spawnSync(process.execPath, ['-e', s], { cwd: ROOT, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr || r.stdout);
  }
});

// ── Security ──

test('criterion 28: no raw-HTML sinks or script URLs in runtime code', () => {
  assert.deepEqual(grepRuntime(/insertAdjacentHTML|outerHTML\s*=|document\.write|\beval\(|new Function\(|srcdoc|javascript:/), []);
});

test('criterion 29: the manifest CSP stays script-src self, object-src self', () => {
  assert.deepEqual(manifest.content_security_policy, { extension_pages: "script-src 'self'; object-src 'self'" });
});

test('criterion 29: runtime files load nothing remote; URLs are only Anthropic, Claude, GitHub, and LinkedIn', () => {
  const allowed = host => host === '*' || host === 'www.w3.org' || host === 'github.com' ||
    /(^|\.)(anthropic\.com|claude\.com|linkedin\.com)$/.test(host);
  const bad = [];
  for (const { f, text } of runtimeCode) {
    for (const [u, scheme, host] of text.matchAll(/\b(https?):\/\/([a-z0-9*.-]+)/gi)) {
      const h = host.toLowerCase();
      if (!allowed(h) || (scheme.toLowerCase() === 'http' && h !== '*' && h !== 'www.w3.org')) bad.push(`${f}: ${u}`);
    }
    if (f.endsWith('.css') && /url\(\s*['"]?(https?:)?\/\//i.test(text)) bad.push(`${f}: remote url()`);
    if (f.endsWith('.html') && /<(script|link|img|iframe)\b[^>]*\b(src|href)="(https?:)?\/\//i.test(text)) bad.push(`${f}: remote resource`);
  }
  assert.deepEqual(bad, []);
});

test('criterion 30: the overlay frame takes no data from the page, URL, or postMessage; content.js renders no HTML', () => {
  const page = overlayPage();
  const html = read(page);
  const scripts = [...html.matchAll(/<script\b[^>]*\bsrc="([^"]+)"/g)].map(m => path.posix.join(path.posix.dirname(page), m[1]));
  assert.ok(scripts.length > 0, `${page} loads its scripts from the extension`);
  for (const s of scripts) {
    assert.doesNotMatch(read(s), /addEventListener\(\s*['"]message['"]|\bonmessage\b|location\.(search|hash)|URLSearchParams/, s);
  }
  assert.doesNotMatch(read('content.js'), /innerHTML|insertAdjacentHTML|attachShadow/, 'content.js only adds the iframe');
});

test('criterion 31: only the overlay page is web-accessible, with a dynamic URL', () => {
  const war = manifest.web_accessible_resources;
  assert.ok(Array.isArray(war) && war.length === 1, 'one web_accessible_resources entry');
  assert.equal(war[0].resources?.length, 1, 'only the overlay HTML is listed');
  assert.match(war[0].resources[0], /\.html$/);
  assert.equal(war[0].use_dynamic_url, true);
  assert.ok(exists(war[0].resources[0]), `${war[0].resources[0]} is missing`);
});

test('criterion 32c: no external message channels', () => {
  assert.deepEqual(grepRuntime(/onMessageExternal|onConnectExternal/), []);
  assert.equal(manifest.externally_connectable, undefined);
});

test('criterion 34: no storage.sync, no setAccessLevel, no console output, and content scripts never touch storage', () => {
  assert.deepEqual(grepRuntime(/storage\.sync|setAccessLevel/), []);
  assert.deepEqual(grepRuntime(/\bconsole\./, runtimeJs), []);
  for (const f of ['content.js', 'lib/core.js']) assert.doesNotMatch(read(f), /chrome\.storage/, f);
});
