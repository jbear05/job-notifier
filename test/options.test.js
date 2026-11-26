// Runs lib/core.js, ui.js and options.js in a vm with the fake DOM and a stub worker, and records which
// channel each settings message uses. Test names cite the criterion or review finding.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { makeDocument } = require('./fake-dom');

const ROOT = path.join(__dirname, '..');
const RID = 'abcdefghijklmnopabcdefghijklmnop';
const PASS = 'correct-horse-battery-staple';
const KEY = 'sk-ant-' + 'api03-test-key-1234567890abcdef'; // built at runtime so the tree scan stays clean
const FRIEND = { name: 'Priya Shah', email: 'priya.shah@example.com' };
// Security Low 2: these carry the passphrase, the API key, or friends (in the request or the reply).
const SECRET_TYPES = ['VAULT_SETUP', 'VAULT_UNLOCK', 'VAULT_CONVERT_LEGACY', 'VAULT_SAVE_CLAUDE', 'VAULT_SAVE_FRIENDS', 'VAULT_GET_DATA'];
const settle = async () => { for (let i = 0; i < 30; i++) await new Promise(resolve => setImmediate(resolve)); };

// The settings page with both the extension runtime and the manifest service worker recorded separately.
async function openSettings(vaultState = 'uninitialized', workerScript = 'background.js') {
  const { document, fireDocument } = makeDocument();
  const sendMessages = []; // bodies passed to chrome.runtime.sendMessage
  const portMessages = []; // [port name, body] posted on chrome.runtime.connect ports
  const workerMessages = [];
  const runtimeConnections = [];
  const state = { vaultState, apiKey: '', friends: [], rev: 0 };
  const rev = () => `rev-${++state.rev}`;
  const answer = msg => {
    switch (msg?.type) {
      case 'VAULT_STATUS':
        return state.vaultState === 'needs-conversion'
          ? { ok: true, vaultState: 'needs-conversion', legacySummary: { hasKey: true, friendCount: 1 } }
          : { ok: true, vaultState: state.vaultState };
      case 'VAULT_SETUP': case 'VAULT_UNLOCK': case 'VAULT_CONVERT_LEGACY':
        state.vaultState = 'unlocked';
        return { ok: true, vaultState: 'unlocked', vaultRev: rev() };
      case 'VAULT_GET_DATA':
        return state.vaultState === 'unlocked'
          ? { ok: true, apiKey: state.apiKey, friends: state.friends, settings: { model: 'claude-haiku-5-5', effort: 'low', threshold: 0.6 }, vaultRev: rev() }
          : { ok: false, code: 'LOCKED' };
      case 'VAULT_SAVE_CLAUDE': state.apiKey = msg.apiKey; return { ok: true, vaultRev: rev() };
      case 'VAULT_SAVE_FRIENDS': state.friends = msg.friends; return { ok: true, vaultRev: rev() };
      case 'VAULT_LOCK': state.vaultState = 'locked'; return { ok: true, vaultState: 'locked' };
      case 'VAULT_RESET': state.vaultState = 'uninitialized'; return { ok: true, vaultState: 'uninitialized' };
      default: return undefined;
    }
  };
  class TestPort {
    onmessage = null;
    events = new Map();
    close() { this.closed = true; }
    start() {}
    addEventListener(type, fn) { this.events.set(type, fn); }
    postMessage(data) {
      const receiver = this.peer;
      setImmediate(() => {
        if (!receiver.closed) {
          receiver.onmessage?.({ data: structuredClone(data) });
          receiver.events.get('message')?.({ data: structuredClone(data) });
        }
      });
    }
  }
  class MessageChannel {
    constructor() {
      this.port1 = new TestPort();
      this.port2 = new TestPort();
      this.port1.peer = this.port2;
      this.port2.peer = this.port1;
    }
  }
  const active = {
    scriptURL: `chrome-extension://${RID}/${workerScript}`,
    state: 'activated',
    postMessage(msg, transfer) {
      const ports = Array.isArray(transfer) ? transfer : transfer?.transfer;
      workerMessages.push([structuredClone(msg), ports]);
      if (ports?.length === 1 && ports[0] instanceof TestPort) ports[0].postMessage(answer(msg));
    },
  };
  const ctx = {
    document, location: { hash: '' }, confirm: () => true,
    setTimeout, clearTimeout, URL, TextEncoder, TextDecoder, crypto: globalThis.crypto, btoa, atob, MessageChannel,
    navigator: { serviceWorker: { ready: Promise.resolve({ active, scope: `chrome-extension://${RID}/` }) } },
    chrome: {
      runtime: {
        id: RID,
        getManifest: () => ({ version: '2.0.0', background: { service_worker: 'background.js' } }),
        getURL: p => `chrome-extension://${RID}/${p}`,
        openOptionsPage() {},
        sendMessage: async msg => { sendMessages.push(structuredClone(msg)); return answer(msg); },
        connect: ({ name } = {}) => {
          runtimeConnections.push(name);
          const listeners = [];
          return {
            name,
            onMessage: { addListener: fn => listeners.push(fn) },
            onDisconnect: { addListener() {} },
            postMessage(msg) {
              portMessages.push([name, structuredClone(msg)]);
              const reply = answer(msg);
              setImmediate(() => listeners.forEach(fn => fn(reply)));
            },
            disconnect() {},
          };
        },
        onMessage: { addListener() {} },
      },
      storage: { local: { get: async () => ({}), set: async () => {} }, onChanged: { addListener() {} } },
      permissions: { contains: async () => false, request: async () => false, onRemoved: { addListener() {} } },
      tabs: { create() {} },
    },
  };
  vm.createContext(ctx);
  for (const f of ['lib/core.js', 'ui.js', 'options.js']) vm.runInContext(fs.readFileSync(path.join(ROOT, f), 'utf8'), ctx, { filename: f });
  fireDocument('DOMContentLoaded');
  await settle();
  const $ = id => document.getElementById(id);
  return { $, sendMessages, portMessages, workerMessages, runtimeConnections, heading: () => $('vault-heading').textContent };
}

function assertSecretsDirectOnly(s, expectedDirect) {
  const leaked = s.sendMessages.filter(m => SECRET_TYPES.includes(m.type)).map(m => m.type);
  assert.deepEqual(leaked, [], 'runtime.sendMessage reaches every extension frame (popup, overlays), so these must not use it');
  for (const m of s.sendMessages) {
    for (const secret of [PASS, KEY, FRIEND.name, FRIEND.email]) {
      assert.ok(!JSON.stringify(m).includes(secret), `a runtime.sendMessage body (${m.type}) carries "${secret}"`);
    }
  }
  assert.deepEqual(s.runtimeConnections, [], 'runtime.connect also reaches other extension frames');
  assert.deepEqual(s.portMessages, [], 'no request was sent to a broadcast vault port');
  const directTypes = new Set(s.workerMessages.map(([msg]) => msg.type));
  for (const type of expectedDirect) assert.ok(directTypes.has(type), `${type} went straight to the manifest service worker`);
  const replies = new Set();
  for (const [msg, ports] of s.workerMessages) {
    assert.equal(ports?.length, 1, `${msg.type} transferred one reply endpoint`);
    assert.ok(!replies.has(ports[0]), `${msg.type} transferred its own reply endpoint`);
    replies.add(ports[0]);
  }
}

test('security Low 2: setup, key save, friend save and unlock address only the manifest service worker', async () => {
  const s = await openSettings();
  const { $ } = s;
  assert.equal(s.heading(), 'Create a passphrase');

  $('setup-passphrase').value = PASS;
  $('setup-confirm').value = PASS;
  $('setup-form').fire('submit');
  await settle();
  assert.equal(s.heading(), 'Passphrase lock', 'setup finished');

  $('api-key').value = KEY;
  $('threshold').valueAsNumber = 0.6;
  $('claude-form').fire('submit');
  await settle();
  assert.match($('claude-status').textContent, /^Saved/, 'the key was saved');

  $('f-name').value = FRIEND.name;
  $('f-email').value = FRIEND.email;
  $('friend-form').fire('submit');
  await settle();
  assert.equal($('friends-status').textContent, `Added ${FRIEND.name}.`, 'the friend was saved');

  $('lock-btn').click();
  await settle();
  assert.equal(s.heading(), 'Unlock saved data', 'locked');
  $('unlock-passphrase').value = PASS;
  $('unlock-form').fire('submit');
  await settle();
  assert.equal(s.heading(), 'Passphrase lock', 'unlocked again');

  assertSecretsDirectOnly(s, ['VAULT_SETUP', 'VAULT_GET_DATA', 'VAULT_SAVE_CLAUDE', 'VAULT_SAVE_FRIENDS', 'VAULT_UNLOCK']);
});

test('security Low 2: encrypting existing data (P3) addresses only the manifest service worker', async () => {
  const s = await openSettings('needs-conversion');
  const { $ } = s;
  assert.equal(s.heading(), 'Encrypt existing saved data');
  $('convert-passphrase').value = PASS;
  $('convert-confirm').value = PASS;
  $('convert-form').fire('submit');
  await settle();
  assert.equal(s.heading(), 'Passphrase lock', 'conversion finished');
  assertSecretsDirectOnly(s, ['VAULT_CONVERT_LEGACY', 'VAULT_GET_DATA']);
});

test('security Low 2: a registration for a different worker receives no vault messages and no fallback runs', async () => {
  const s = await openSettings('locked', 'another-worker.js');
  assert.equal(s.heading(), 'Unlock saved data');
  s.$('unlock-passphrase').value = PASS;
  s.$('unlock-form').fire('submit');
  await settle();

  assertSecretsDirectOnly(s, []);
  assert.deepEqual(s.workerMessages, [], 'the unrecognized worker receives nothing');
  assert.equal(s.heading(), 'Unlock saved data', 'the settings page stays locked');
});
