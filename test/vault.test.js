// Tests for passphrase-protected vault storage (docs/specs/passphrase-storage.md,
// acceptance criteria P-01 through P-09).
//
// Exact JN helper signatures expected in lib/core.js:
// - JN.validatePassphrase(passphrase: string): string | null
//     Returns null if valid (8..512 chars, non-empty, not all-whitespace, no trimming);
//     otherwise returns an error message string.
// - JN.newVaultKdf(iterations?: number): { name: 'PBKDF2', hash: 'SHA-256', iterations: number, salt: string }
//     Generates a 16-byte random salt (base64) with default 600000 iterations.
// - JN.buildVaultAad(kdf: { name, hash, iterations, salt }): Uint8Array
//     UTF-8 encoding of `job-notifier:vault:v1|${kdf.name}|${kdf.hash}|${kdf.iterations}|${kdf.salt}`.
// - JN.validateVaultEnvelope(envelope: unknown): boolean
//     Validates v === 1, PBKDF2/SHA-256, integer iterations in [600000, 5000000],
//     16-byte base64 salt, AES-GCM tagLength 128, 12-byte base64 iv, valid base64 ct (>= 16 bytes).
// - JN.deriveVaultKeyBytes(passphrase: string, saltBytes: Uint8Array, iterations?: number): Promise<Uint8Array>
//     Derives 32 bytes via PBKDF2-SHA256 without trimming passphrase.
// - JN.importVaultKey(keyBytes: Uint8Array): Promise<CryptoKey>
//     Imports non-extractable 256-bit AES-GCM CryptoKey with ['encrypt', 'decrypt'].
// - JN.encryptVault(payload: { v?: number, apiKey?: string, friends?: Array }, cryptoKey: CryptoKey, kdf: object): Promise<VaultEnvelope>
//     Encrypts normalized { v: 1, apiKey, friends } using a fresh 12-byte random IV and buildVaultAad(kdf).
// - JN.decryptVault(envelope: object, cryptoKey: CryptoKey): Promise<{ v: 1, apiKey: string, friends: Array }>
//     Validates envelope, verifies GCM tag + AAD, checks parsed v === 1, normalizes apiKey and friends.
// - JN.detectLegacyPreEncryption200(localData: object): boolean
//     Detects valid pre-encryption 2.0.0 { settings, friends } when vault is absent and key/friends non-empty;
//     rejects 1.x profiles, extra keys, malformed friend types, or empty data.
// - JN.isStaticExtensionSender(sender: object, page: string, runtimeId: string): boolean
//     Accepts only chrome-extension://<runtimeId>/<page> with frameId === undefined || frameId === 0.
// - JN.isSettingsSender(sender: object, runtimeId: string): boolean
//     Equivalent to JN.isStaticExtensionSender(sender, 'options.html', runtimeId).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const JN = require('../lib/core.js');

const ROOT = path.join(__dirname, '..');
const RID = 'abcdefghijklmnopabcdefghijklmnop';
const POSTING = 'Responsibilities and qualifications. Salary and benefits. Full-time, remote. ' +
  '3+ years experience with Go. Apply now. '.repeat(5);

const nextTask = () => new Promise(resolve => setImmediate(resolve));
const settle = async () => { for (let i = 0; i < 40; i++) await nextTask(); };

// Security Low 2: options sends these directly to the extension service worker.
const VAULT_TYPES = new Set(['VAULT_STATUS', 'VAULT_SETUP', 'VAULT_UNLOCK', 'VAULT_RESET', 'VAULT_GET_DATA', 'VAULT_SAVE_CLAUDE', 'VAULT_SAVE_FRIENDS', 'VAULT_CONVERT_LEGACY']);
const copy = value => (value === undefined ? undefined : JSON.parse(JSON.stringify(value)));
const read = rel => fs.readFileSync(path.join(ROOT, rel), 'utf8');

function storageArea(initial = {}) {
  const data = copy(initial);
  return {
    data,
    async get(keys) {
      await nextTask();
      const defaults = keys && typeof keys === 'object' && !Array.isArray(keys) ? keys : {};
      const names = keys == null ? Object.keys(data) : typeof keys === 'string' ? [keys] : Array.isArray(keys) ? keys : Object.keys(keys);
      const out = {};
      for (const k of names) {
        if (k in data) out[k] = copy(data[k]);
        else if (k in defaults) out[k] = copy(defaults[k]);
      }
      return out;
    },
    async set(items) {
      await nextTask();
      Object.assign(data, copy(items));
    },
    async remove(keys) {
      await nextTask();
      for (const k of [].concat(keys)) delete data[k];
    },
  };
}

function event() {
  const fns = [];
  return {
    addListener: fn => fns.push(fn),
    removeListener: fn => fns.includes(fn) && fns.splice(fns.indexOf(fn), 1),
    hasListener: fn => fns.includes(fn),
    fire: (...args) => fns.map(fn => fn(...args)),
  };
}

function loadWorker({
  localInitial = {},
  sessionInitial = {},
  fetch = async () => { throw new Error('no network in tests'); },
  abortSignal = AbortSignal,
} = {}) {
  const local = storageArea(localInitial);
  const session = storageArea(sessionInitial);
  const broadcasts = [];
  const workerMessages = event();
  const chrome = {
    storage: { local, session, onChanged: event() },
    permissions: { contains: async () => true, request: async () => true, remove: async () => true, onAdded: event(), onRemoved: event() },
    scripting: {
      getRegisteredContentScripts: async () => [{ id: 'job-notifier-detect' }],
      registerContentScripts: async () => {},
      unregisterContentScripts: async () => {},
    },
    runtime: {
      id: RID,
      getURL: p => `chrome-extension://${RID}/${p}`,
      openOptionsPage() {},
      sendMessage: async msg => { broadcasts.push(copy(msg)); },
      onStartup: event(), onInstalled: event(), onMessage: event(), onConnect: event(),
    },
    tabs: { onUpdated: event(), onRemoved: event(), query: async () => [], sendMessage: () => Promise.resolve(), create: async () => {} },
  };
  const ctx = {
    chrome,
    self: { addEventListener(type, fn) {
      if (type === 'message') workerMessages.addListener(fn);
    } },
    crypto: globalThis.crypto,
    URL,
    TextEncoder,
    TextDecoder,
    Uint8Array,
    btoa,
    atob,
    AbortController,
    AbortSignal: abortSignal,
    setTimeout,
    clearTimeout,
    fetch,
  };
  vm.createContext(ctx);
  ctx.importScripts = (...files) => {
    for (const f of files) vm.runInContext(fs.readFileSync(path.join(ROOT, f), 'utf8'), ctx, { filename: f });
  };
  ctx.importScripts('background.js');

  // chrome.runtime.sendMessage as the worker sees it: resolves with its reply, or undefined if unhandled.
  const sendMessageOnly = (msg, sender) => new Promise(resolve => {
    let replied = false;
    const kept = chrome.runtime.onMessage.fire(msg, sender, reply => { replied = true; resolve(copy(reply)); });
    if (!kept.includes(true) && !replied) resolve(undefined);
  });

  // The old extension-wide port, exercised to verify that it declines vault requests.
  const sendOnVaultPort = (msg, sender) => new Promise(resolve => {
    let done = false;
    const finish = value => { if (!done) { done = true; resolve(value); } };
    const port = {
      name: 'vault', sender, onMessage: event(), onDisconnect: event(),
      postMessage: reply => finish(copy(reply)),
      disconnect: () => finish(undefined),
    };
    chrome.runtime.onConnect.fire(port);
    if (!done) port.onMessage.fire(msg);
    setTimeout(() => finish('no reply within 5 s'), 5000).unref();
  });

  const directVault = async (data, source, portCount = 1) => {
    const replies = [];
    const tasks = [];
    const ports = Array.from({ length: portCount }, (_, index) => ({
      postMessage: reply => replies.push({ index, reply: copy(reply) }),
      close() {},
    }));
    const origin = source?.url?.match(/^\w[\w-]*:\/\/[^/]+/)?.[0] || '';
    workerMessages.fire({ data, source, origin, ports, waitUntil: task => tasks.push(task) });
    await Promise.all(tasks);
    if (ports.length !== 1) assert.deepEqual(replies, [], 'invalid port counts get no reply on any port');
    assert.ok(replies.length <= 1, 'one request gets at most one reply');
    return replies[0]?.reply;
  };

  const send = (msg, sender) => {
    if (!VAULT_TYPES.has(msg?.type)) return sendMessageOnly(msg, sender);
    const url = sender.id === RID ? sender.url : sender.url?.replace(`chrome-extension://${RID}/`, 'chrome-extension://other-extension/');
    return directVault(msg, windowClient({ url, frameType: sender.frameId ? 'nested' : 'top-level' }));
  };

  const connectAnalyze = (msg, sender) => new Promise(resolve => {
    let settledPort = false;
    const port = {
      name: 'analyze',
      sender,
      onMessage: event(),
      onDisconnect: event(),
      postMessage: reply => {
        if (!settledPort) {
          settledPort = true;
          resolve(copy(reply));
        }
      },
      disconnect: () => {
        if (!settledPort) {
          settledPort = true;
          resolve({ disconnected: true });
        }
      },
    };
    chrome.runtime.onConnect.fire(port);
    if (!settledPort) port.onMessage.fire(msg);
  });

  return { chrome, local, session, broadcasts, send, sendMessageOnly, sendOnVaultPort, directVault, connectAnalyze };
}

const optionsSender = (extra = {}) => ({ id: RID, url: `chrome-extension://${RID}/options.html`, frameId: 0, ...extra });
const windowClient = (extra = {}) => ({ id: 'window-client-id', type: 'window', frameType: 'top-level', url: `chrome-extension://${RID}/options.html`, ...extra });
const popupSender = (extra = {}) => ({ id: RID, url: `chrome-extension://${RID}/popup.html`, ...extra });
const overlaySender = (tabId, url, docId = 'doc-overlay-1') => ({
  id: RID,
  url: `chrome-extension://${RID}/overlay.html`,
  tab: { id: tabId, url },
  frameId: 3,
  documentId: docId,
});
const contentSender = (tabId, url, docId = 'doc-content-1') => ({
  id: RID,
  url,
  tab: { id: tabId, url },
  frameId: 0,
  documentId: docId,
});

const SAMPLE_FRIENDS = [
  { name: 'Priya Shah', contact: 'priya.shah@example.com', skills: ['Go', 'PostgreSQL'], interests: ['climate'], level: 'Mid level', notify: true },
  { name: 'Marcus Lee', contact: 'marcus.lee@example.com', skills: ['React'], interests: ['devtools'], level: 'Senior', notify: false },
];
const SAMPLE_KEY = 'sk-ant-' + 'api03-test-key-1234567890abcdef'; // built at runtime so the tree scan stays clean
const PASS_1 = 'correct-horse-battery-staple';
const PASS_2 = 'different-passphrase-value';

function okApiResponse(friendIds = [0]) {
  return {
    ok: true,
    status: 200,
    async json() {
      return {
        stop_reason: 'end_turn',
        content: [{
          type: 'text',
          text: JSON.stringify({
            job: { title: 'Backend Engineer', company: 'Kestrel Grid', skills: ['Go'], level: 'Mid level', location: 'Remote', remote: true },
            matches: friendIds.map(id => ({ id, score: 0.9, message: 'Great match for your Go experience.' })),
          }),
        }],
      };
    },
  };
}

// ── 1. Pure JN helpers (lib/core.js) ──

test('P-02: validatePassphrase enforces length, non-whitespace, and preserves exact characters', () => {
  for (const bad of ['', null, undefined, 12345678, '1234567', '        ', ' \t\n     ', ' '.repeat(20), 'a'.repeat(513), ' ' + 'a'.repeat(512)]) {
    assert.equal(typeof JN.validatePassphrase(bad), 'string', `should reject ${JSON.stringify(bad)?.slice(0, 30)}`);
  }
  for (const good of ['12345678', '  123456', '      ab', 'a'.repeat(512), PASS_1]) {
    assert.equal(JN.validatePassphrase(good), null, `should accept ${JSON.stringify(good)?.slice(0, 30)}`);
  }
});

test('P-02: buildVaultAad binds version and KDF parameters as UTF-8 bytes', () => {
  const kdf = { name: 'PBKDF2', hash: 'SHA-256', iterations: 600000, salt: 'AAAAAAAAAAAAAAAAAAAAAA==' };
  const aad = JN.buildVaultAad(kdf);
  assert.ok(aad instanceof Uint8Array);
  assert.equal(new TextDecoder().decode(aad), 'job-notifier:vault:v1|PBKDF2|SHA-256|600000|AAAAAAAAAAAAAAAAAAAAAA==');
});

test('P-02: validateVaultEnvelope accepts valid envelopes and fails closed on malformed/unsupported fields', () => {
  const valid = () => ({
    v: 1,
    kdf: { name: 'PBKDF2', hash: 'SHA-256', iterations: 600000, salt: Buffer.alloc(16, 1).toString('base64') },
    cipher: { name: 'AES-GCM', tagLength: 128, iv: Buffer.alloc(12, 2).toString('base64') },
    ct: Buffer.alloc(32, 3).toString('base64'),
  });
  assert.equal(JN.validateVaultEnvelope(valid()), true);
  assert.equal(JN.validateVaultEnvelope({ ...valid(), kdf: { ...valid().kdf, iterations: 5000000 } }), true);

  const cases = [
    ['null', null],
    ['array', []],
    ['wrong v (2)', { ...valid(), v: 2 }],
    ['wrong v (string)', { ...valid(), v: '1' }],
    ['wrong kdf.name', { ...valid(), kdf: { ...valid().kdf, name: 'scrypt' } }],
    ['wrong kdf.hash', { ...valid(), kdf: { ...valid().kdf, hash: 'SHA-512' } }],
    ['iterations below min', { ...valid(), kdf: { ...valid().kdf, iterations: 599999 } }],
    ['iterations above max', { ...valid(), kdf: { ...valid().kdf, iterations: 5000001 } }],
    ['float iterations', { ...valid(), kdf: { ...valid().kdf, iterations: 600000.5 } }],
    ['string iterations', { ...valid(), kdf: { ...valid().kdf, iterations: '600000' } }],
    ['15-byte salt', { ...valid(), kdf: { ...valid().kdf, salt: Buffer.alloc(15, 1).toString('base64') } }],
    ['17-byte salt', { ...valid(), kdf: { ...valid().kdf, salt: Buffer.alloc(17, 1).toString('base64') } }],
    ['invalid base64 salt', { ...valid(), kdf: { ...valid().kdf, salt: 'not!valid!base64!' } }],
    ['wrong cipher.name', { ...valid(), cipher: { ...valid().cipher, name: 'AES-CBC' } }],
    ['wrong tagLength', { ...valid(), cipher: { ...valid().cipher, tagLength: 96 } }],
    ['11-byte iv', { ...valid(), cipher: { ...valid().cipher, iv: Buffer.alloc(11, 2).toString('base64') } }],
    ['13-byte iv', { ...valid(), cipher: { ...valid().cipher, iv: Buffer.alloc(13, 2).toString('base64') } }],
    ['invalid base64 iv', { ...valid(), cipher: { ...valid().cipher, iv: '===bad===' } }],
    ['missing ct', { ...valid(), ct: undefined }],
    ['empty ct', { ...valid(), ct: '' }],
    ['short ct (<16 bytes)', { ...valid(), ct: Buffer.alloc(15, 3).toString('base64') }],
    ['invalid base64 ct', { ...valid(), ct: 'bad*base64' }],
  ];
  for (const [label, env] of cases) {
    assert.equal(JN.validateVaultEnvelope(env), false, label);
  }
});

test('P-02: Web Crypto round-trip, wrong passphrase, tampering, AAD binding, and unique IV/salt', async () => {
  const kdf1 = JN.newVaultKdf();
  const kdf2 = JN.newVaultKdf();
  assert.notEqual(kdf1.salt, kdf2.salt, 'each new KDF generates a fresh random salt');

  const keyBytes1 = await JN.deriveVaultKeyBytes('  ' + PASS_1 + '  ', Buffer.from(kdf1.salt, 'base64'), kdf1.iterations);
  assert.equal(keyBytes1.length, 32);
  const key1 = await JN.importVaultKey(keyBytes1);
  assert.equal(key1.extractable, false, 'working CryptoKey must be non-extractable');

  const payload = { v: 1, apiKey: SAMPLE_KEY, friends: SAMPLE_FRIENDS };
  const env1 = await JN.encryptVault(payload, key1, kdf1);
  const env1b = await JN.encryptVault(payload, key1, kdf1);
  assert.equal(JN.validateVaultEnvelope(env1), true);
  assert.notEqual(env1.cipher.iv, env1b.cipher.iv, 'each encryption generates a fresh random IV');
  assert.notEqual(env1.ct, env1b.ct);

  const decrypted = await JN.decryptVault(env1, key1);
  assert.deepEqual(decrypted, payload);

  // Exact passphrase preservation (trimmed passphrase derives a different key and fails).
  const trimmedBytes = await JN.deriveVaultKeyBytes(PASS_1, Buffer.from(kdf1.salt, 'base64'), kdf1.iterations);
  const trimmedKey = await JN.importVaultKey(trimmedBytes);
  await assert.rejects(() => JN.decryptVault(env1, trimmedKey));

  // Wrong passphrase fails.
  const wrongBytes = await JN.deriveVaultKeyBytes(PASS_2, Buffer.from(kdf1.salt, 'base64'), kdf1.iterations);
  const wrongKey = await JN.importVaultKey(wrongBytes);
  await assert.rejects(() => JN.decryptVault(env1, wrongKey));

  // Tampering ct fails GCM verification.
  const badCt = Buffer.from(env1.ct, 'base64');
  badCt[0] ^= 0xff;
  await assert.rejects(() => JN.decryptVault({ ...env1, ct: badCt.toString('base64') }, key1));

  // Tampering iv fails GCM verification.
  const badIv = Buffer.from(env1.cipher.iv, 'base64');
  badIv[0] ^= 0xff;
  await assert.rejects(() => JN.decryptVault({ ...env1, cipher: { ...env1.cipher, iv: badIv.toString('base64') } }, key1));

  // Tampering salt or iterations fails AAD verification.
  const badSalt = Buffer.from(env1.kdf.salt, 'base64');
  badSalt[0] ^= 0xff;
  await assert.rejects(() => JN.decryptVault({ ...env1, kdf: { ...env1.kdf, salt: badSalt.toString('base64') } }, key1));
  await assert.rejects(() => JN.decryptVault({ ...env1, kdf: { ...env1.kdf, iterations: 600001 } }, key1));
});

test('P-08: detectLegacyPreEncryption200 strictly matches pre-encryption 2.0.0 data and rejects 1.x/malformed/vaulted data', () => {
  const validSettings = { apiKey: SAMPLE_KEY, model: 'claude-haiku-5-5', effort: 'low', threshold: 0.6 };
  const validFriends = [{ name: 'Priya', contact: 'priya@example.com', skills: ['Go'], interests: [], level: 'Mid', notify: true }];

  assert.equal(JN.detectLegacyPreEncryption200({ settings: validSettings, friends: validFriends }), true);
  assert.equal(JN.detectLegacyPreEncryption200({ settings: validSettings }), true);
  assert.equal(JN.detectLegacyPreEncryption200({ friends: validFriends }), true);
  assert.equal(JN.detectLegacyPreEncryption200({ settings: { ...validSettings, apiKey: '' }, friends: validFriends }), true);

  // Empty data is not a conversion candidate.
  assert.equal(JN.detectLegacyPreEncryption200({}), false);
  assert.equal(JN.detectLegacyPreEncryption200({ settings: { ...validSettings, apiKey: '' }, friends: [] }), false);

  // Any vault present disables conversion detection.
  assert.equal(JN.detectLegacyPreEncryption200({ vault: {}, settings: validSettings, friends: validFriends }), false);
  assert.equal(JN.detectLegacyPreEncryption200({ vault: null, settings: validSettings, friends: validFriends }), false);

  // 1.x / malformed profiles are rejected.
  assert.equal(JN.detectLegacyPreEncryption200({ settings: { apiKey: SAMPLE_KEY, model: 'claude-haiku-5-5', threshold: 0.6 } }), false, 'missing effort');
  assert.equal(JN.detectLegacyPreEncryption200({ settings: { ...validSettings, model: 'claude-3-5-sonnet-20241022' } }), false, 'unlisted 1.x model');
  assert.equal(JN.detectLegacyPreEncryption200({ settings: { ...validSettings, legacyFlag: true } }), false, 'extra settings key');
  assert.equal(JN.detectLegacyPreEncryption200({ settings: { ...validSettings, apiKey: 'not-sk-ant' } }), false, 'non-sk-ant key');
  assert.equal(JN.detectLegacyPreEncryption200({ settings: { ...validSettings, threshold: 1.5 } }), false, 'threshold out of range');
  assert.equal(JN.detectLegacyPreEncryption200({ friends: [{ name: 'Priya', contact: '', skills: [], interests: [], level: '', notify: 'true' }] }), false, 'non-boolean notify');
  assert.equal(JN.detectLegacyPreEncryption200({ friends: [{ name: 'Priya', contact: '', skills: [], interests: [], level: '', notify: true, extra: 1 }] }), false, 'extra friend key');
  assert.equal(JN.detectLegacyPreEncryption200({ friends: [{ name: 'Priya' }] }), false, 'partial 1.x friend without canonical 2.0.0 shape');
});

test('P-03: isSettingsSender and isStaticExtensionSender restrict to exact top-frame extension page', () => {
  assert.equal(JN.isSettingsSender(optionsSender(), RID), true);
  assert.equal(JN.isSettingsSender({ id: RID, url: `chrome-extension://${RID}/options.html#friends` }, RID), true);
  assert.equal(JN.isStaticExtensionSender(popupSender(), 'popup.html', RID), true);

  for (const bad of [
    popupSender(),
    overlaySender(1, 'https://jobs.example/done'),
    contentSender(1, 'https://jobs.example/done'),
    optionsSender({ frameId: 1 }),
    optionsSender({ id: 'otherext' }),
    { id: RID, url: 'chrome-extension://otherext/options.html', frameId: 0 },
    { id: RID, url: 'https://example.com/options.html', frameId: 0 },
    undefined,
  ]) {
    assert.equal(JN.isSettingsSender(bad, RID), false, `isSettingsSender should reject ${JSON.stringify(bad)}`);
  }
  assert.equal(JN.isStaticExtensionSender(optionsSender(), 'popup.html', RID), false);
});

// ── 2. Worker integration tests (background.js) ──

test('P-01 / P-02: fresh install starts uninitialized; VAULT_SETUP and saves store only ciphertext in local and vaultKey in session with zero fetch calls', async () => {
  let fetchCalls = 0;
  const { local, session, send } = loadWorker({
    fetch: async () => { fetchCalls++; return okApiResponse(); },
  });

  assert.deepEqual(await send({ type: 'VAULT_STATUS' }, optionsSender()), { ok: true, vaultState: 'uninitialized' });
  const initPopup = await send({ type: 'POPUP_STATUS' }, popupSender());
  assert.equal(initPopup?.vaultState, 'uninitialized');
  assert.equal('hasKey' in initPopup, false);
  assert.equal('friendsStatus' in initPopup, false);

  const setup = await send({ type: 'VAULT_SETUP', passphrase: PASS_1 }, optionsSender());
  assert.equal(setup?.ok, true);
  assert.equal(setup?.vaultState, 'unlocked');
  assert.equal(fetchCalls, 0);

  assert.equal(JN.validateVaultEnvelope(local.data.vault), true);
  assert.equal(typeof session.data.vaultKey, 'string');
  assert.ok(!JSON.stringify(local.data).includes(PASS_1), 'passphrase never enters chrome.storage.local');
  assert.ok(!JSON.stringify(session.data).includes(PASS_1), 'passphrase never enters chrome.storage.session');

  const data0 = await send({ type: 'VAULT_GET_DATA' }, optionsSender());
  assert.equal(data0?.ok, true);
  assert.equal(data0?.apiKey, '');
  assert.deepEqual(data0?.friends, []);

  const saveClaude = await send({
    type: 'VAULT_SAVE_CLAUDE',
    apiKey: SAMPLE_KEY,
    model: 'claude-sonnet-5-5',
    effort: 'medium',
    threshold: 0.75,
    expectedRev: data0.vaultRev,
  }, optionsSender());
  assert.equal(saveClaude?.ok, true);

  const saveFriends = await send({
    type: 'VAULT_SAVE_FRIENDS',
    friends: SAMPLE_FRIENDS,
    expectedRev: saveClaude.vaultRev,
  }, optionsSender());
  assert.equal(saveFriends?.ok, true);

  // Inspect raw storage: no plaintext apiKey or friend fields anywhere.
  assert.equal('apiKey' in (local.data.settings || {}), false, 'settings never stores apiKey');
  assert.deepEqual(local.data.settings, { model: 'claude-sonnet-5-5', effort: 'medium', threshold: 0.75 });
  assert.equal('friends' in local.data, false, 'friends never stored in plaintext in local');
  const rawLocal = JSON.stringify(local.data);
  const rawSession = JSON.stringify(session.data);
  for (const secret of [PASS_1, SAMPLE_KEY, 'Priya Shah', 'priya.shah@example.com', 'Marcus Lee', 'marcus.lee@example.com']) {
    assert.ok(!rawLocal.includes(secret), `local storage leaked "${secret}"`);
    assert.ok(!rawSession.includes(secret), `session storage leaked "${secret}"`);
  }

  // Non-sensitive preferences & posting session still work.
  await local.set({ autoDetect: true });
  await settle();
  await send({ type: 'JOB_SEEN', text: POSTING, title: 'Go Role' }, contentSender(1, 'https://jobs.example/1'));
  assert.equal((await send({ type: 'CONFIRMATION_SEEN' }, contentSender(1, 'https://ats.example/done')))?.show, true);
});

test('P-03: sender isolation rejects VAULT_* from popup/overlay/content and omits sensitive fields when not unlocked', async () => {
  const { local, send } = loadWorker({ localInitial: { autoDetect: true } });
  await send({ type: 'VAULT_SETUP', passphrase: PASS_1 }, optionsSender());
  const d = await send({ type: 'VAULT_GET_DATA' }, optionsSender());
  await send({ type: 'VAULT_SAVE_CLAUDE', apiKey: SAMPLE_KEY, model: 'claude-haiku-5-5', effort: 'low', threshold: 0.6, expectedRev: d.vaultRev }, optionsSender());
  const beforeVault = copy(local.data.vault);

  const forbiddenSenders = [
    popupSender(),
    overlaySender(2, 'https://ats.example/done'),
    contentSender(2, 'https://ats.example/done'),
    optionsSender({ frameId: 1 }),
    { id: 'other-ext', url: `chrome-extension://${RID}/options.html`, frameId: 0 },
  ];
  for (const msg of [
    { type: 'VAULT_STATUS' },
    { type: 'VAULT_SETUP', passphrase: PASS_2 },
    { type: 'VAULT_UNLOCK', passphrase: PASS_1 },
    { type: 'VAULT_RESET' },
    { type: 'VAULT_GET_DATA' },
    { type: 'VAULT_SAVE_CLAUDE', apiKey: 'sk-ant-evil', model: 'claude-haiku-5-5', effort: 'low', threshold: 0.5, expectedRev: d.vaultRev },
    { type: 'VAULT_SAVE_FRIENDS', friends: [], expectedRev: d.vaultRev },
    { type: 'VAULT_CONVERT_LEGACY', passphrase: PASS_2 },
  ]) {
    for (const s of forbiddenSenders) {
      const reply = await send(msg, s);
      assert.ok(!reply || reply.ok === false, `${msg.type} must be rejected from ${s.url || s.id}`);
    }
  }
  assert.deepEqual(local.data.vault, beforeVault, 'rejected messages never alter vault');

  // VAULT_LOCK is rejected from overlay and content, allowed from popup and options.
  for (const s of [overlaySender(2, 'https://ats.example/done'), contentSender(2, 'https://ats.example/done')]) {
    const reply = await send({ type: 'VAULT_LOCK' }, s);
    assert.ok(!reply || reply.ok === false);
  }
  assert.equal((await send({ type: 'VAULT_STATUS' }, optionsSender()))?.vaultState, 'unlocked');

  // Unlocked POPUP_STATUS & OVERLAY_STATE expose only booleans/enums, never key or friends.
  await send({ type: 'JOB_SEEN', text: POSTING, title: 'Role' }, contentSender(3, 'https://jobs.example/3'));
  await send({ type: 'CONFIRMATION_SEEN' }, contentSender(3, 'https://ats.example/3'));
  const popUnlocked = await send({ type: 'POPUP_STATUS' }, popupSender());
  assert.deepEqual(popUnlocked, { vaultState: 'unlocked', hasKey: true, friendsStatus: 'empty' });
  const ovUnlocked = await send({ type: 'OVERLAY_STATE' }, overlaySender(3, 'https://ats.example/3'));
  assert.equal(ovUnlocked?.state, 'prompt');
  assert.equal(ovUnlocked?.vaultState, 'unlocked');
  assert.equal(ovUnlocked?.hasKey, true);
  assert.equal('apiKey' in ovUnlocked, false);
  assert.equal('friends' in ovUnlocked, false);

  // Popup can lock; once locked, POPUP_STATUS & OVERLAY_STATE omit hasKey and friendsStatus.
  assert.equal((await send({ type: 'VAULT_LOCK' }, popupSender()))?.ok, true);
  const popLocked = await send({ type: 'POPUP_STATUS' }, popupSender());
  assert.deepEqual(popLocked, { vaultState: 'locked' });
  const ovLocked = await send({ type: 'OVERLAY_STATE' }, overlaySender(3, 'https://ats.example/3'));
  assert.equal(ovLocked?.state, 'prompt');
  assert.equal(ovLocked?.vaultState, 'locked');
  assert.equal('hasKey' in ovLocked, false);
  assert.equal('friendsStatus' in ovLocked, false);
});

test('P-04: service worker restart stays unlocked, browser restart starts locked, wrong passphrase stays locked, unreadable vault fails closed', async () => {
  const w1 = loadWorker();
  await w1.send({ type: 'VAULT_SETUP', passphrase: PASS_1 }, optionsSender());
  const d1 = await w1.send({ type: 'VAULT_GET_DATA' }, optionsSender());
  await w1.send({ type: 'VAULT_SAVE_CLAUDE', apiKey: SAMPLE_KEY, model: 'claude-haiku-5-5', effort: 'low', threshold: 0.6, expectedRev: d1.vaultRev }, optionsSender());
  const s1 = await w1.send({ type: 'VAULT_GET_DATA' }, optionsSender());
  await w1.send({ type: 'VAULT_SAVE_FRIENDS', friends: SAMPLE_FRIENDS, expectedRev: s1.vaultRev }, optionsSender());

  // Service worker restart: same local + same session (with vaultKey).
  const wRestart = loadWorker({ localInitial: w1.local.data, sessionInitial: w1.session.data });
  assert.equal((await wRestart.send({ type: 'VAULT_STATUS' }, optionsSender()))?.vaultState, 'unlocked');
  const got = await wRestart.send({ type: 'VAULT_GET_DATA' }, optionsSender());
  assert.equal(got?.ok, true);
  assert.equal(got?.apiKey, SAMPLE_KEY);
  assert.equal(got?.friends?.length, 2);

  // Browser restart: same local, empty session.
  const wBrowserRestart = loadWorker({ localInitial: w1.local.data, sessionInitial: {} });
  assert.equal((await wBrowserRestart.send({ type: 'VAULT_STATUS' }, optionsSender()))?.vaultState, 'locked');
  assert.equal((await wBrowserRestart.send({ type: 'VAULT_GET_DATA' }, optionsSender()))?.code, 'LOCKED');

  // Wrong passphrase leaves vault untouched and locked.
  const wrong = await wBrowserRestart.send({ type: 'VAULT_UNLOCK', passphrase: PASS_2 }, optionsSender());
  assert.equal(wrong?.ok, false);
  assert.notEqual(wrong?.code, 'LOCKED');
  assert.equal(wBrowserRestart.session.data.vaultKey, undefined);
  assert.equal((await wBrowserRestart.send({ type: 'VAULT_STATUS' }, optionsSender()))?.vaultState, 'locked');

  // Correct passphrase unlocks and restores data.
  const okUnlock = await wBrowserRestart.send({ type: 'VAULT_UNLOCK', passphrase: PASS_1 }, optionsSender());
  assert.equal(okUnlock?.ok, true);
  assert.equal((await wBrowserRestart.send({ type: 'VAULT_GET_DATA' }, optionsSender()))?.apiKey, SAMPLE_KEY);

  // Unreadable vault (corrupted parameters) fails closed without overwriting local.vault.
  const badVault = { ...copy(w1.local.data.vault), kdf: { ...w1.local.data.vault.kdf, iterations: 100 } };
  const wBad = loadWorker({ localInitial: { vault: badVault } });
  assert.equal((await wBad.send({ type: 'VAULT_STATUS' }, optionsSender()))?.vaultState, 'unreadable');
  assert.equal((await wBad.send({ type: 'POPUP_STATUS' }, popupSender()))?.vaultState, 'unreadable');
  assert.equal((await wBad.send({ type: 'VAULT_UNLOCK', passphrase: PASS_1 }, optionsSender()))?.ok, false);
  assert.deepEqual(wBad.local.data.vault, badVault);
});

test('P-04 / P-06: VAULT_LOCK cancels concurrent unlock, save, and mid-flight analysis and broadcasts VAULT_LOCKED', async () => {
  const w0 = loadWorker();
  await w0.send({ type: 'VAULT_SETUP', passphrase: PASS_1 }, optionsSender());
  const d0 = await w0.send({ type: 'VAULT_GET_DATA' }, optionsSender());
  const r1 = await w0.send({ type: 'VAULT_SAVE_CLAUDE', apiKey: SAMPLE_KEY, model: 'claude-haiku-5-5', effort: 'low', threshold: 0.6, expectedRev: d0.vaultRev }, optionsSender());
  await w0.send({ type: 'VAULT_SAVE_FRIENDS', friends: SAMPLE_FRIENDS, expectedRev: r1.vaultRev }, optionsSender());

  // 1) Lock during Unlock.
  const wLockUnlock = loadWorker({ localInitial: w0.local.data, sessionInitial: {} });
  const unlockPromise = wLockUnlock.send({ type: 'VAULT_UNLOCK', passphrase: PASS_1 }, optionsSender());
  const lockReply = await wLockUnlock.send({ type: 'VAULT_LOCK' }, optionsSender());
  assert.equal(lockReply?.ok, true);
  const unlockReply = await unlockPromise;
  assert.equal(unlockReply?.ok, false);
  assert.equal(unlockReply?.code, 'LOCKED');
  assert.equal(wLockUnlock.session.data.vaultKey, undefined);
  assert.ok(wLockUnlock.broadcasts.some(m => m?.type === 'VAULT_LOCKED'));

  // 2) Lock during Save.
  const wLockSave = loadWorker({ localInitial: w0.local.data, sessionInitial: w0.session.data });
  const dataSave = await wLockSave.send({ type: 'VAULT_GET_DATA' }, optionsSender());
  const beforeVault = copy(wLockSave.local.data.vault);
  const savePromise = wLockSave.send({
    type: 'VAULT_SAVE_FRIENDS',
    friends: [{ name: 'Should Not Save', contact: '', skills: [], interests: [], level: '', notify: true }],
    expectedRev: dataSave.vaultRev,
  }, optionsSender());
  await wLockSave.send({ type: 'VAULT_LOCK' }, optionsSender());
  const saveAfterLock = await savePromise;
  assert.equal(saveAfterLock?.ok, false);
  assert.equal(saveAfterLock?.code, 'LOCKED');
  assert.deepEqual(wLockSave.local.data.vault, beforeVault);

  // 3) Lock during active analyze fetch (both abort signal and late-response discard).
  let capturedSignal;
  let releaseFetch;
  const wAnalyze = loadWorker({
    localInitial: { ...w0.local.data, autoDetect: true },
    sessionInitial: w0.session.data,
    fetch: (_url, opts) => {
      capturedSignal = opts.signal;
      return new Promise(resolve => { releaseFetch = resolve; });
    },
  });
  const analyzePromise = wAnalyze.connectAnalyze({ type: 'ANALYZE_JOB', jobText: POSTING }, popupSender());
  await settle();
  assert.ok(capturedSignal, 'fetch started while unlocked');
  await wAnalyze.send({ type: 'VAULT_LOCK' }, optionsSender());
  assert.equal(capturedSignal.aborted, true, 'VAULT_LOCK aborts active fetch AbortSignal');
  releaseFetch(okApiResponse([0])); // Even if fetch resolves with matches after lock, worker must discard them.
  const analyzeReply = await analyzePromise;
  assert.equal(analyzeReply?.ok, false);
  assert.equal(analyzeReply?.code, 'LOCKED');
  assert.equal(analyzeReply?.result, undefined);
});

test('P-04: concurrent settings edits reject stale expectedRev with STALE_EDIT and storage errors preserve prior vault', async () => {
  const { local, send } = loadWorker();
  await send({ type: 'VAULT_SETUP', passphrase: PASS_1 }, optionsSender());
  const tabA = await send({ type: 'VAULT_GET_DATA' }, optionsSender());
  const tabB = await send({ type: 'VAULT_GET_DATA' }, optionsSender());

  const saveA = await send({
    type: 'VAULT_SAVE_CLAUDE',
    apiKey: SAMPLE_KEY,
    model: 'claude-haiku-5-5',
    effort: 'low',
    threshold: 0.6,
    expectedRev: tabA.vaultRev,
  }, optionsSender());
  assert.equal(saveA?.ok, true);

  const saveB = await send({
    type: 'VAULT_SAVE_FRIENDS',
    friends: SAMPLE_FRIENDS,
    expectedRev: tabB.vaultRev,
  }, optionsSender());
  assert.equal(saveB?.ok, false);
  assert.equal(saveB?.code, 'STALE_EDIT');

  const current = await send({ type: 'VAULT_GET_DATA' }, optionsSender());
  assert.equal(current?.apiKey, SAMPLE_KEY);
  assert.deepEqual(current?.friends, []);

  // Simulated storage write failure preserves last confirmed vault.
  const realSet = local.set.bind(local);
  local.set = async () => { throw new Error('QuotaExceededError'); };
  const failedSave = await send({
    type: 'VAULT_SAVE_FRIENDS',
    friends: SAMPLE_FRIENDS,
    expectedRev: current.vaultRev,
  }, optionsSender());
  assert.equal(failedSave?.ok, false);
  local.set = realSet;
  const stillReadable = await send({ type: 'VAULT_GET_DATA' }, optionsSender());
  assert.equal(stillReadable?.ok, true);
  assert.equal(stillReadable?.apiKey, SAMPLE_KEY);
});

test('P-06: analyze refuses when uninitialized, needs-conversion, locked, or unreadable with zero fetch calls, and checks lock for ANALYZE_TAB', async () => {
  for (const [label, localInitial] of [
    ['uninitialized', { autoDetect: true }],
    ['needs-conversion', { autoDetect: true, settings: { apiKey: SAMPLE_KEY, model: 'claude-haiku-5-5', effort: 'low', threshold: 0.6 }, friends: SAMPLE_FRIENDS }],
    ['unreadable', { autoDetect: true, vault: { v: 99 } }],
  ]) {
    let fetches = 0;
    const w = loadWorker({ localInitial, fetch: async () => { fetches++; return okApiResponse(); } });
    await w.send({ type: 'JOB_SEEN', text: POSTING, title: 'Role' }, contentSender(1, 'https://jobs.example/1'));
    await w.send({ type: 'CONFIRMATION_SEEN' }, contentSender(1, 'https://ats.example/1'));
    await w.send({ type: 'OVERLAY_STATE' }, overlaySender(1, 'https://ats.example/1'));

    const rJob = await w.connectAnalyze({ type: 'ANALYZE_JOB', jobText: POSTING }, popupSender());
    const rTab = await w.connectAnalyze({ type: 'ANALYZE_TAB' }, overlaySender(1, 'https://ats.example/1'));
    assert.equal(rJob?.ok, false, `${label} ANALYZE_JOB rejected`);
    assert.equal(rTab?.ok, false, `${label} ANALYZE_TAB rejected`);
    assert.ok(rJob?.code && rJob.code !== 'NO_API_KEY' && rJob.code !== 'NO_FRIENDS', `${label} code: ${rJob?.code}`);
    assert.equal(fetches, 0, `${label} made zero fetch calls`);
  }

  // Locked ANALYZE_TAB and mid-flight lock on ANALYZE_TAB.
  const wBase = loadWorker();
  await wBase.send({ type: 'VAULT_SETUP', passphrase: PASS_1 }, optionsSender());
  const d = await wBase.send({ type: 'VAULT_GET_DATA' }, optionsSender());
  const r = await wBase.send({ type: 'VAULT_SAVE_CLAUDE', apiKey: SAMPLE_KEY, model: 'claude-haiku-5-5', effort: 'low', threshold: 0.6, expectedRev: d.vaultRev }, optionsSender());
  await wBase.send({ type: 'VAULT_SAVE_FRIENDS', friends: SAMPLE_FRIENDS, expectedRev: r.vaultRev }, optionsSender());

  let releaseTabFetch;
  const wTab = loadWorker({
    localInitial: { ...wBase.local.data, autoDetect: true },
    sessionInitial: wBase.session.data,
    fetch: () => new Promise(resolve => { releaseTabFetch = resolve; }),
  });
  await wTab.send({ type: 'JOB_SEEN', text: POSTING, title: 'Role' }, contentSender(4, 'https://jobs.example/4'));
  await wTab.send({ type: 'CONFIRMATION_SEEN' }, contentSender(4, 'https://ats.example/4'));
  await wTab.send({ type: 'OVERLAY_STATE' }, overlaySender(4, 'https://ats.example/4'));
  const tabPromise = wTab.connectAnalyze({ type: 'ANALYZE_TAB' }, overlaySender(4, 'https://ats.example/4'));
  await settle();
  await wTab.send({ type: 'VAULT_LOCK' }, optionsSender());
  releaseTabFetch(okApiResponse([0]));
  const tabReply = await tabPromise;
  assert.equal(tabReply?.ok, false);
  assert.equal(tabReply?.code, 'LOCKED');

  // Locked ANALYZE_TAB right away.
  const lockedTabReply = await wTab.connectAnalyze({ type: 'ANALYZE_TAB' }, overlaySender(4, 'https://ats.example/4'));
  assert.equal(lockedTabReply?.ok, false);
  assert.equal(lockedTabReply?.code, 'LOCKED');
});

test('P-07: unlocked friend CRUD validates via cleanFriends, leaves ciphertext unchanged on rejection, and VAULT_GET_DATA fails when locked', async () => {
  const { local, send } = loadWorker();
  await send({ type: 'VAULT_SETUP', passphrase: PASS_1 }, optionsSender());
  const d0 = await send({ type: 'VAULT_GET_DATA' }, optionsSender());
  const saved = await send({ type: 'VAULT_SAVE_FRIENDS', friends: SAMPLE_FRIENDS, expectedRev: d0.vaultRev }, optionsSender());
  assert.equal(saved?.ok, true);
  const vaultBeforeBad = copy(local.data.vault);

  const badEmail = await send({
    type: 'VAULT_SAVE_FRIENDS',
    friends: [{ name: 'Bad', contact: 'not-an-email' }],
    expectedRev: saved.vaultRev,
  }, optionsSender());
  assert.equal(badEmail?.ok, false);
  assert.match(badEmail?.error || '', /email|contact/i);
  assert.deepEqual(local.data.vault, vaultBeforeBad, 'rejected friends save leaves vault ciphertext unchanged');

  const tooMany = await send({
    type: 'VAULT_SAVE_FRIENDS',
    friends: Array.from({ length: 501 }, (_, i) => ({ name: `F${i}` })),
    expectedRev: saved.vaultRev,
  }, optionsSender());
  assert.equal(tooMany?.ok, false);
  assert.deepEqual(local.data.vault, vaultBeforeBad);

  await send({ type: 'VAULT_LOCK' }, optionsSender());
  assert.equal((await send({ type: 'VAULT_GET_DATA' }, optionsSender()))?.ok, false);
});

test('P-08: P3 pre-encryption 2.0.0 conversion preserves data on failure, verifies before clearing, recovers interrupted cleanup, skips 1.x, and resets cleanly', async () => {
  const p3Local = {
    autoDetect: true,
    settings: { apiKey: SAMPLE_KEY, model: 'claude-sonnet-5-5', effort: 'high', threshold: 0.7 },
    friends: SAMPLE_FRIENDS,
  };

  // 1) Startup leaves P3 plaintext intact and blocks analysis.
  let fetches = 0;
  const wP3 = loadWorker({ localInitial: p3Local, fetch: async () => { fetches++; return okApiResponse(); } });
  const status = await wP3.send({ type: 'VAULT_STATUS' }, optionsSender());
  assert.equal(status?.vaultState, 'needs-conversion');
  assert.equal((await wP3.send({ type: 'POPUP_STATUS' }, popupSender()))?.vaultState, 'needs-conversion');
  assert.equal((await wP3.connectAnalyze({ type: 'ANALYZE_JOB', jobText: POSTING }, popupSender()))?.ok, false);
  assert.equal(fetches, 0);
  assert.equal(wP3.local.data.settings.apiKey, SAMPLE_KEY);
  assert.equal(wP3.local.data.friends.length, 2);

  // 2) Simulated read-back verification error leaves legacy data intact and no partial vault.
  const realGet = wP3.local.get.bind(wP3.local);
  let corruptNextVaultRead = false;
  const realSet = wP3.local.set.bind(wP3.local);
  wP3.local.set = async items => {
    if (items && 'vault' in items) corruptNextVaultRead = true;
    return realSet(items);
  };
  wP3.local.get = async keys => {
    const res = await realGet(keys);
    if (corruptNextVaultRead && res.vault) {
      corruptNextVaultRead = false;
      return { ...res, vault: { ...res.vault, ct: Buffer.alloc(32, 9).toString('base64') } };
    }
    return res;
  };
  const failedConvert = await wP3.send({ type: 'VAULT_CONVERT_LEGACY', passphrase: PASS_1 }, optionsSender());
  assert.equal(failedConvert?.ok, false);
  assert.equal(wP3.local.data.vault, undefined, 'unverified vault is cleaned up');
  assert.equal(wP3.local.data.settings.apiKey, SAMPLE_KEY, 'legacy apiKey preserved on failure');
  assert.equal(wP3.local.data.friends.length, 2, 'legacy friends preserved on failure');
  assert.equal(wP3.session.data.vaultKey, undefined);

  // 3) Successful conversion writes vault first, verifies, then removes friends & settings.apiKey.
  wP3.local.get = realGet;
  const writeLog = [];
  wP3.local.set = async items => {
    writeLog.push(Object.keys(items));
    return realSet(items);
  };
  const realRemove = wP3.local.remove.bind(wP3.local);
  wP3.local.remove = async keys => {
    writeLog.push(['remove', ...[].concat(keys)]);
    return realRemove(keys);
  };
  const okConvert = await wP3.send({ type: 'VAULT_CONVERT_LEGACY', passphrase: PASS_1 }, optionsSender());
  assert.equal(okConvert?.ok, true);
  assert.equal(okConvert?.vaultState, 'unlocked');
  assert.ok(writeLog[0].includes('vault') && !writeLog[0].includes('settings'), 'vault written before stripping settings.apiKey');
  assert.equal(JN.validateVaultEnvelope(wP3.local.data.vault), true);
  assert.equal('apiKey' in wP3.local.data.settings, false);
  assert.deepEqual(wP3.local.data.settings, { model: 'claude-sonnet-5-5', effort: 'high', threshold: 0.7 });
  assert.equal('friends' in wP3.local.data, false);
  const migrated = await wP3.send({ type: 'VAULT_GET_DATA' }, optionsSender());
  assert.equal(migrated?.apiKey, SAMPLE_KEY);
  assert.deepEqual(migrated?.friends, SAMPLE_FRIENDS);

  // 4) Interrupted post-verify state (both valid vault AND residual legacy fields present).
  const interruptedLocal = {
    vault: copy(wP3.local.data.vault),
    settings: copy(p3Local.settings),
    friends: copy(p3Local.friends),
  };
  const wInterrupted = loadWorker({ localInitial: interruptedLocal, sessionInitial: {} });
  assert.equal((await wInterrupted.send({ type: 'VAULT_STATUS' }, optionsSender()))?.vaultState, 'locked');
  assert.equal((await wInterrupted.connectAnalyze({ type: 'ANALYZE_JOB', jobText: POSTING }, popupSender()))?.code, 'LOCKED');
  assert.equal((await wInterrupted.send({ type: 'VAULT_UNLOCK', passphrase: PASS_1 }, optionsSender()))?.ok, true);
  assert.equal('apiKey' in wInterrupted.local.data.settings, false, 'unlock cleans up residual settings.apiKey');
  assert.equal('friends' in wInterrupted.local.data, false, 'unlock cleans up residual friends');
  assert.deepEqual(wInterrupted.local.data.vault, interruptedLocal.vault, 'vault preserved during residual cleanup');

  // 5) 1.x fixture stays uninitialized and is never upgraded.
  const w1x = loadWorker({
    localInitial: { settings: { apiKey: SAMPLE_KEY, model: 'claude-3-5-sonnet-20241022' }, friends: [{ name: 'Old' }] },
  });
  assert.equal((await w1x.send({ type: 'VAULT_STATUS' }, optionsSender()))?.vaultState, 'uninitialized');
  assert.equal((await w1x.send({ type: 'VAULT_CONVERT_LEGACY', passphrase: PASS_1 }, optionsSender()))?.ok, false);
  assert.equal((await w1x.connectAnalyze({ type: 'ANALYZE_JOB', jobText: POSTING }, popupSender()))?.ok, false);

  // 6) VAULT_RESET removes vault, legacy friends, settings.apiKey, and vaultKey, allowing fresh setup.
  const reset = await wP3.send({ type: 'VAULT_RESET' }, optionsSender());
  assert.equal(reset?.ok, true);
  assert.equal(reset?.vaultState, 'uninitialized');
  assert.equal(wP3.local.data.vault, undefined);
  assert.equal(wP3.local.data.friends, undefined);
  assert.equal('apiKey' in (wP3.local.data.settings || {}), false);
  assert.equal(wP3.session.data.vaultKey, undefined);
  assert.equal((await wP3.send({ type: 'VAULT_SETUP', passphrase: PASS_2 }, optionsSender()))?.ok, true);
});

test('P-08 regression: VAULT_CONVERT_LEGACY preserves verified vault if session.set fails after legacy cleanup', async () => {
  const p3Local = {
    autoDetect: true,
    settings: { apiKey: SAMPLE_KEY, model: 'claude-sonnet-5-5', effort: 'high', threshold: 0.7 },
    friends: SAMPLE_FRIENDS,
  };
  const w = loadWorker({ localInitial: p3Local });
  w.session.set = async items => {
    if (items && 'vaultKey' in items) throw new Error('session.set failed');
  };

  const reply = await w.send({ type: 'VAULT_CONVERT_LEGACY', passphrase: PASS_1 }, optionsSender());
  assert.equal(reply?.ok, false);
  assert.equal(JN.validateVaultEnvelope(w.local.data.vault), true, 'verified vault must not be deleted after legacy cleanup');

  // Verify the preserved vault can be unlocked on a clean worker and still holds all data.
  const wNext = loadWorker({ localInitial: w.local.data, sessionInitial: {} });
  const unlock = await wNext.send({ type: 'VAULT_UNLOCK', passphrase: PASS_1 }, optionsSender());
  assert.equal(unlock?.ok, true);
  const data = await wNext.send({ type: 'VAULT_GET_DATA' }, optionsSender());
  assert.equal(data?.apiKey, SAMPLE_KEY);
  assert.deepEqual(data?.friends, SAMPLE_FRIENDS);
});

test('P-04 regression: VAULT_LOCK during local.set in VAULT_SAVE_FRIENDS returns LOCKED and does not broadcast VAULT_CHANGED', async () => {
  const w = loadWorker();
  await w.send({ type: 'VAULT_SETUP', passphrase: PASS_1 }, optionsSender());
  const d0 = await w.send({ type: 'VAULT_GET_DATA' }, optionsSender());
  w.broadcasts.length = 0;

  const realSet = w.local.set.bind(w.local);
  let notifyInSet;
  const enteredSet = new Promise(resolve => { notifyInSet = resolve; });
  let releaseSet;
  const setGate = new Promise(resolve => { releaseSet = resolve; });
  w.local.set = async items => {
    if (items && 'vault' in items) {
      notifyInSet();
      await setGate;
    }
    return realSet(items);
  };

  const savePromise = w.send({
    type: 'VAULT_SAVE_FRIENDS',
    friends: SAMPLE_FRIENDS,
    expectedRev: d0.vaultRev,
  }, optionsSender());
  await enteredSet;
  const lockPromise = w.send({ type: 'VAULT_LOCK' }, optionsSender());
  await nextTask();
  releaseSet();

  const [saveReply, lockReply] = await Promise.all([savePromise, lockPromise]);
  assert.equal(lockReply?.ok, true);
  assert.equal(saveReply?.ok, false);
  assert.equal(saveReply?.code, 'LOCKED');
  assert.equal(w.broadcasts.some(m => m?.type === 'VAULT_LOCKED'), true);
  assert.equal(w.broadcasts.some(m => m?.type === 'VAULT_CHANGED'), false, 'must not broadcast VAULT_CHANGED after lock');
});

test('P-09: manifest permissions unchanged and docs/settings disclosures reflect passphrase encryption, lock lifetime, and readable export', () => {
  const manifest = JSON.parse(read('manifest.json'));
  assert.deepEqual([...(manifest.permissions || [])].sort(), ['activeTab', 'clipboardWrite', 'scripting', 'storage']);
  assert.deepEqual(manifest.host_permissions, ['https://api.anthropic.com/*']);
  assert.deepEqual([...(manifest.optional_host_permissions || [])].sort(), ['http://*/*', 'https://*/*']);

  const optionsHtml = read('options.html');
  assert.match(optionsHtml, /id="vault"/);
  assert.match(optionsHtml, /Encrypted with your passphrase/i);
  assert.doesNotMatch(optionsHtml, /Stored unencrypted/i);
  assert.match(optionsHtml, /passphrase never leaves this browser/i);
  assert.match(optionsHtml, /readable, unencrypted JSON/i);
  assert.match(optionsHtml, /Forgot passphrase\?/i);

  const privacy = read('PRIVACY.md');
  assert.doesNotMatch(privacy, /API key is stored \*\*unencrypted\*\*/i);
  assert.match(privacy, /passphrase/i);
  assert.match(privacy, /Lock now/i);
  assert.match(privacy, /cannot recover/i);

  const docs = read('DOCS.md');
  assert.doesNotMatch(docs, /API key is stored unencrypted/i);
  assert.match(docs, /vaultKey/);
  assert.match(docs, /PBKDF2|AES-GCM/i);

  const readme = read('README.md');
  assert.doesNotMatch(readme, /key is stored unencrypted/i);
  assert.match(readme, /passphrase/i);
  assert.match(readme, /Lock now/i);

  const listing = read('docs/store-listing.md');
  assert.match(listing, /passphrase|encrypted/i);
});

// ── Security review of the vault (docs/specs/passphrase-storage.md handoff log, 2026-11-26) ──

// An unlocked vault with the key and friends, built directly so these tests don't depend on any message channel.
async function unlockedFixture(extraLocal = {}) {
  const kdf = JN.newVaultKdf();
  const keyBytes = await JN.deriveVaultKeyBytes(PASS_1, JN.base64ToBytes(kdf.salt), kdf.iterations);
  const vault = await JN.encryptVault({ v: 1, apiKey: SAMPLE_KEY, friends: SAMPLE_FRIENDS }, await JN.importVaultKey(keyBytes), kdf);
  return {
    localInitial: { vault, settings: { model: 'claude-haiku-5-5', effort: 'low', threshold: 0.6 }, ...extraLocal },
    sessionInitial: { vaultKey: JN.bytesToBase64(keyBytes) },
  };
}

test('security Low 1: a Lock sent right after Find friends in the popup (ANALYZE_JOB) makes no request and replies LOCKED', async () => {
  let fetches = 0;
  const w = loadWorker({ ...(await unlockedFixture()), fetch: async () => { fetches++; return okApiResponse([0]); } });
  const analyzing = w.connectAnalyze({ type: 'ANALYZE_JOB', jobText: POSTING }, popupSender());
  const locking = w.send({ type: 'VAULT_LOCK' }, popupSender()); // same tick, before the analysis reaches the vault queue
  assert.deepEqual(await analyzing, { ok: false, code: 'LOCKED' });
  assert.equal((await locking)?.ok, true);
  await settle();
  assert.equal(fetches, 0, 'no request after the lock');
});

test('security Low 1: a Lock sent right after Find friends in the overlay (ANALYZE_TAB) makes no request and replies LOCKED', async () => {
  let fetches = 0;
  const w = loadWorker({ ...(await unlockedFixture({ autoDetect: true })), fetch: async () => { fetches++; return okApiResponse([0]); } });
  await w.send({ type: 'JOB_SEEN', text: POSTING, title: 'Role' }, contentSender(7, 'https://jobs.example/7'));
  assert.equal((await w.send({ type: 'CONFIRMATION_SEEN' }, contentSender(7, 'https://ats.example/7')))?.show, true);
  assert.equal((await w.send({ type: 'OVERLAY_STATE' }, overlaySender(7, 'https://ats.example/7')))?.state, 'prompt');
  const analyzing = w.connectAnalyze({ type: 'ANALYZE_TAB' }, overlaySender(7, 'https://ats.example/7'));
  const locking = w.send({ type: 'VAULT_LOCK' }, optionsSender());
  assert.deepEqual(await analyzing, { ok: false, code: 'LOCKED' });
  assert.equal((await locking)?.ok, true);
  await settle();
  assert.equal(fetches, 0, 'no request after the lock');
});

test('security Low 1: a lock and unlock during overlay prompt lookup do not revive the original analysis', { timeout: 3000 }, async () => {
  let fetches = 0;
  const w = loadWorker({ ...(await unlockedFixture({ autoDetect: true })), fetch: async () => { fetches++; return okApiResponse([0]); } });
  const url = 'https://ats.example/8';
  const sender = overlaySender(8, url);
  await w.send({ type: 'JOB_SEEN', text: POSTING, title: 'Role' }, contentSender(8, 'https://jobs.example/8'));
  assert.equal((await w.send({ type: 'CONFIRMATION_SEEN' }, contentSender(8, url)))?.show, true);
  assert.equal((await w.send({ type: 'OVERLAY_STATE' }, sender))?.state, 'prompt');

  let markPromptLookup;
  let releasePromptLookup;
  const lookupStarted = new Promise(resolve => { markPromptLookup = resolve; });
  const lookupGate = new Promise(resolve => { releasePromptLookup = resolve; });
  w.chrome.tabs.sendMessage = async (_tabId, msg) => {
    if (msg.type !== 'DOCUMENT_PING') return undefined;
    markPromptLookup();
    await lookupGate;
    return { ok: true };
  };

  const analyzing = w.connectAnalyze({ type: 'ANALYZE_TAB' }, sender);
  await lookupStarted;
  try {
    assert.equal((await w.send({ type: 'VAULT_LOCK' }, optionsSender()))?.vaultState, 'locked');
    assert.equal((await w.send({ type: 'VAULT_UNLOCK', passphrase: PASS_1 }, optionsSender()))?.vaultState, 'unlocked');
  } finally {
    releasePromptLookup();
  }
  assert.deepEqual(await analyzing, { ok: false, code: 'LOCKED' });
  assert.equal(fetches, 0, 'the pre-lock click never makes a request');
  assert.equal((await w.connectAnalyze({ type: 'ANALYZE_TAB' }, sender))?.ok, true, 'a fresh click works after unlocking');
  assert.equal(fetches, 1);
});

test('security Low 2: only a top-level extension settings WindowClient and one reply port can access the vault', async () => {
  const w = loadWorker();
  const settings = windowClient();
  assert.deepEqual(await w.directVault({ type: 'VAULT_STATUS' }, settings), { ok: true, vaultState: 'uninitialized' }, 'the worker responds on the transferred MessagePort');
  assert.equal((await w.directVault({ type: 'VAULT_SETUP', passphrase: PASS_1 }, settings))?.ok, true);
  const d = await w.directVault({ type: 'VAULT_GET_DATA' }, settings);
  assert.equal(d?.ok, true, 'the options document reads the vault directly');
  const saved = await w.directVault({ type: 'VAULT_SAVE_CLAUDE', apiKey: SAMPLE_KEY, model: 'claude-haiku-5-5', effort: 'low', threshold: 0.6, expectedRev: d?.vaultRev }, settings);
  assert.equal(saved?.ok, true, 'and saves directly');
  const friendSave = await w.directVault({ type: 'VAULT_SAVE_FRIENDS', friends: SAMPLE_FRIENDS, expectedRev: saved?.vaultRev }, settings);
  assert.equal(friendSave?.ok, true);
  const directData = await w.directVault({ type: 'VAULT_GET_DATA' }, windowClient({ url: settings.url + '#friends' }));
  assert.equal(directData?.apiKey, SAMPLE_KEY, 'the documented friends anchor still addresses the options page');
  assert.deepEqual(directData?.friends, SAMPLE_FRIENDS, 'only the reply port receives the vault data');
  const before = copy(w.local.data.vault);

  for (const [label, source] of [
    ['popup', windowClient({ url: popupSender().url })],
    ['overlay frame', windowClient({ url: overlaySender(2, 'https://ats.example/done').url, frameType: 'nested' })],
    ['web page', windowClient({ url: 'https://ats.example/options.html' })],
    ['nested settings frame', windowClient({ frameType: 'nested' })],
    ['same path in another extension', windowClient({ url: 'chrome-extension://other-extension/options.html' })],
    ['different path', windowClient({ url: `chrome-extension://${RID}/another/options.html` })],
    ['non-window client', windowClient({ type: 'worker' })],
    ['missing source', null],
  ]) {
    for (const msg of [{ type: 'VAULT_GET_DATA' }, { type: 'VAULT_UNLOCK', passphrase: PASS_1 }, { type: 'VAULT_SAVE_FRIENDS', friends: [], expectedRev: friendSave?.vaultRev }]) {
      assert.equal(await w.directVault(msg, source), undefined, `${msg.type} from ${label} gets no reply`);
    }
  }
  for (const count of [0, 2]) {
    assert.equal(await w.directVault({ type: 'VAULT_SAVE_FRIENDS', friends: [], expectedRev: friendSave?.vaultRev }, settings, count), undefined);
    assert.equal(await w.directVault({ type: 'VAULT_GET_DATA' }, settings, count), undefined);
  }
  assert.deepEqual(w.local.data.vault, before, 'refused settings messages change nothing');
  for (const signal of w.broadcasts) {
    for (const secret of [PASS_1, SAMPLE_KEY, SAMPLE_FRIENDS[0].name, SAMPLE_FRIENDS[0].contact]) {
      assert.ok(!JSON.stringify(signal).includes(secret), 'vault broadcasts contain only status');
    }
  }
});

test('security Low 2: extension messaging refuses vault secrets even from options.html', async () => {
  const w = loadWorker(await unlockedFixture());
  const before = copy(w.local.data.vault);
  const current = await w.send({ type: 'VAULT_GET_DATA' }, optionsSender());
  for (const msg of [
    { type: 'VAULT_SETUP', passphrase: PASS_2 },
    { type: 'VAULT_UNLOCK', passphrase: PASS_1 },
    { type: 'VAULT_CONVERT_LEGACY', passphrase: PASS_2 },
    { type: 'VAULT_SAVE_CLAUDE', apiKey: SAMPLE_KEY, model: 'claude-haiku-5-5', effort: 'low', threshold: 0.6, expectedRev: current?.vaultRev },
    { type: 'VAULT_SAVE_FRIENDS', friends: [], expectedRev: current?.vaultRev },
    { type: 'VAULT_GET_DATA' },
  ]) {
    assert.equal(await w.sendMessageOnly(msg, optionsSender()), undefined, `${msg.type} over runtime.sendMessage gets no reply`);
    assert.equal(await w.sendOnVaultPort(msg, optionsSender()), undefined, `${msg.type} over runtime.connect gets no reply`);
  }
  assert.deepEqual(w.local.data.vault, before, 'and changes nothing');
  assert.equal((await w.sendMessageOnly({ type: 'VAULT_LOCK' }, optionsSender()))?.ok, true, 'VAULT_LOCK carries nothing and stays on sendMessage');
});

test('security Low 3: the settings page does not say settings are encrypted (only the API key and friends are)', () => {
  const text = read('options.html').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
  assert.doesNotMatch(text, /\bsettings\b[^.]*\bare encrypted\b/i);
  assert.match(text, /API key and friends list are encrypted/i);
});

test('security Low 5: lock-lifetime copy says "quit Chrome completely", never "close Chrome"', () => {
  const runtime = fs.readdirSync(ROOT).filter(f => /\.(html|js)$/.test(f)).concat('lib/core.js');
  for (const f of [...runtime, 'PRIVACY.md', 'docs/store-listing.md']) {
    assert.doesNotMatch(read(f), /\bclos(e|es|ing) Chrome\b/i, `${f}: closing every window can leave Chrome, and the unlock, running`);
  }
  for (const f of ['options.html', 'PRIVACY.md', 'docs/store-listing.md']) assert.match(read(f), /quit Chrome completely/i, f);
});

test('security Low 6: the store listing\'s authentication-information answer covers the passphrase (processed locally, never stored or sent)', () => {
  const row = read('docs/store-listing.md').split('\n').find(l => /^\|\s*Authentication information\s*\|/i.test(l));
  assert.ok(row, 'the data-use table has an Authentication information row');
  assert.match(row, /passphrase/i);
  assert.match(row, /\blocal(ly)?\b|in (the|this) browser|on the user's device/i, 'processed locally');
  assert.match(row, /\b(never|not)\b[^|]*\b(stored|saved)\b/i, 'never stored');
  assert.match(row, /\b(never|not)\b[^|]*\bsent\b/i, 'never sent');
});
