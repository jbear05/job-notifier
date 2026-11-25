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
  return { frame, styles, timers, focused, isStopped: () => disconnected, receive: msg => receive(msg, { id: ctx.chrome.runtime.id }) };
}

test('criterion 31: a confirmation iframe cannot intercept clicks while awaiting readiness', async () => {
  const { frame, styles, timers } = await openConfirmation();
  const inert = frame.hidden || frame.inert || styles.get('display') === 'none' ||
    styles.get('visibility') === 'hidden' || styles.get('pointer-events') === 'none' || frame.style.pointerEvents === 'none';
  assert.ok(inert, 'the pending frame leaves the host page clickable');
  assert.equal(timers.size, 1, 'a watchdog is pending until the overlay renders');
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
