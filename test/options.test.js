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

// The settings page with a stub worker that answers on either channel, as the real one would.
async function openSettings(vaultState = 'uninitialized') {
  const { document, fireDocument } = makeDocument();
  const sendMessages = []; // bodies passed to chrome.runtime.sendMessage
  const portMessages = []; // [port name, body] posted on chrome.runtime.connect ports
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
  const ctx = {
    document, location: { hash: '' }, confirm: () => true,
    setTimeout, clearTimeout, URL, TextEncoder, TextDecoder, crypto: globalThis.crypto, btoa, atob,
    chrome: {
      runtime: {
        id: RID,
        getManifest: () => ({ version: '2.0.0' }),
        getURL: p => `chrome-extension://${RID}/${p}`,
        openOptionsPage() {},
        sendMessage: async msg => { sendMessages.push(structuredClone(msg)); return answer(msg); },
        connect: ({ name } = {}) => {
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
  return { $, sendMessages, portMessages, heading: () => $('vault-heading').textContent };
}

function assertSecretsOnVaultPortOnly(s, expectedOnPort) {
  const leaked = s.sendMessages.filter(m => SECRET_TYPES.includes(m.type)).map(m => m.type);
  assert.deepEqual(leaked, [], 'runtime.sendMessage reaches every extension frame (popup, overlays), so these must not use it');
  for (const m of s.sendMessages) {
    for (const secret of [PASS, KEY, FRIEND.name, FRIEND.email]) {
      assert.ok(!JSON.stringify(m).includes(secret), `a runtime.sendMessage body (${m.type}) carries "${secret}"`);
    }
  }
  assert.deepEqual([...new Set(s.portMessages.map(([name]) => name))], ['vault'], 'the settings page opens only the vault port');
  const onPort = new Set(s.portMessages.map(([, m]) => m.type));
  for (const type of expectedOnPort) assert.ok(onPort.has(type), `${type} went over the vault port`);
}

test('security Low 2: setup, saving the key, adding a friend, and unlocking send secrets only on the "vault" port', async () => {
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

  assertSecretsOnVaultPortOnly(s, ['VAULT_SETUP', 'VAULT_GET_DATA', 'VAULT_SAVE_CLAUDE', 'VAULT_SAVE_FRIENDS', 'VAULT_UNLOCK']);
});

test('security Low 2: encrypting existing data (P3) sends the passphrase only on the "vault" port', async () => {
  const s = await openSettings('needs-conversion');
  const { $ } = s;
  assert.equal(s.heading(), 'Encrypt existing saved data');
  $('convert-passphrase').value = PASS;
  $('convert-confirm').value = PASS;
  $('convert-form').fire('submit');
  await settle();
  assert.equal(s.heading(), 'Passphrase lock', 'conversion finished');
  assertSecretsOnVaultPortOnly(s, ['VAULT_CONVERT_LEGACY', 'VAULT_GET_DATA']);
});
