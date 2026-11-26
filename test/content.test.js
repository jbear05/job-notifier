const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

async function openConfirmation() {
  const styles = new Map();
  const timers = new Map();
  const focused = [];
  const original = { isConnected: true, focus: () => { focused.push('page'); } };
  const frame = {
    style: { setProperty: (property, value) => styles.set(property, value) },
    addEventListener() {},
    focus: () => { focused.push('frame'); },
    remove() { frame.isConnected = false; },
  };
  let receive;
  let disconnected = false;
  const document = {
    activeElement: original,
    body: {},
    readyState: 'complete',
    querySelectorAll: () => [{}],
    createElement: () => frame,
    documentElement: { appendChild: node => { node.isConnected = true; } },
  };
  const ctx = {
    document,
    window: { addEventListener() {}, removeEventListener() {} },
    location: { href: 'https://ats.example/done' },
    JN: { visibleText: () => 'Application submitted', isConfirmationText: () => true },
    chrome: {
      runtime: {
        id: 'abcdefghijklmnopabcdefghijklmnop',
        getURL: name => `chrome-extension://abcdefghijklmnopabcdefghijklmnop/${name}`,
        sendMessage: async msg => msg.type === 'CONFIRMATION_SEEN' ? { show: true } : { ok: true },
        onMessage: { addListener: callback => { receive = callback; } },
      },
    },
    MutationObserver: class {
      observe() {}
      disconnect() { disconnected = true; }
    },
    setTimeout: callback => {
      const timer = Symbol();
      timers.set(timer, callback);
      return timer;
    },
    clearTimeout: timer => timers.delete(timer),
  };
  const source = fs.readFileSync(path.join(__dirname, '..', 'content.js'), 'utf8');
  vm.runInNewContext(source, ctx, { filename: 'content.js' });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(frame.isConnected, true, 'confirmation opened an overlay frame');
  return {
    frame, styles, timers, focused, isStopped: () => disconnected,
    receive: (msg, sendResponse = () => {}) => receive(msg, { id: ctx.chrome.runtime.id }, sendResponse),
  };
}

test('criterion 31: a confirmation iframe cannot intercept clicks while awaiting readiness', async () => {
  const { frame, styles, timers } = await openConfirmation();
  const inert = frame.hidden || frame.inert || styles.get('display') === 'none' ||
    styles.get('visibility') === 'hidden' || styles.get('pointer-events') === 'none' || frame.style.pointerEvents === 'none';
  assert.ok(inert, 'the pending frame leaves the host page clickable');
  assert.equal(timers.size, 1, 'a watchdog is pending until the overlay renders');
});

// Walkthrough 10.3 (RESULTS.md finding 3), approved by security: allow="clipboard-write" covers only the
// frame's src origin, the dynamic use_dynamic_url host, but the frame's document reports the static
// extension origin, so the Clipboard API was blocked and only the execCommand fallback worked.
test('security (walkthrough 10.3): the overlay frame grants clipboard-write to the static extension origin only', async () => {
  const { frame } = await openConfirmation();
  assert.equal(frame.allow, 'clipboard-write chrome-extension://abcdefghijklmnopabcdefghijklmnop',
    'built at runtime from chrome.runtime.id; never clipboard-read');
});

// Criterion 31 (security contract): before using a stored prompt the worker sends this document a no-data
// DOCUMENT_PING; a document that's gone can't answer, so its prompt is dropped.
test('criterion 31: the content script answers the worker\'s DOCUMENT_PING and changes nothing else', async () => {
  const { frame, receive, isStopped, timers } = await openConfirmation();
  const answers = [];
  receive({ type: 'DOCUMENT_PING' }, reply => answers.push(reply));
  // The reply is built in the vm realm; structuredClone rebuilds it here so deepStrictEqual compares values, not realms.
  assert.deepEqual(structuredClone(answers), [{ ok: true }], 'answers right away with { ok: true }');
  assert.equal(frame.isConnected, true, 'the overlay frame stays');
  assert.equal(isStopped(), false, 'page reading continues');
  assert.equal(timers.size, 1, 'the readiness watchdog is untouched');
});

test('criterion 36: STOP removes the overlay and restores the previous page focus', async () => {
  const { frame, focused, isStopped, receive, timers } = await openConfirmation();
  receive({ type: 'OVERLAY_READY' });
  receive({ type: 'STOP' });
  assert.equal(isStopped(), true, 'the observer disconnected');
  assert.equal(frame.isConnected, false, 'the overlay was removed');
  assert.equal(focused.at(-1), 'page', 'the previous page control received focus');
  assert.equal(timers.size, 0, 'no overlay watchdog is still armed');
});
