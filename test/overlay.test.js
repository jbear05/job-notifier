// Runs lib/core.js, ui.js and overlay.js in a vm with a minimal fake DOM and chrome.runtime, so overlay
// state rules can be tested in Node. Test names cite the criterion, design rule, or walkthrough step.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const settle = async () => { for (let i = 0; i < 20; i++) await new Promise(resolve => setImmediate(resolve)); };

class El {
  constructor(tag, doc) {
    Object.assign(this, { tagName: tag.toUpperCase(), doc, children: [], attrs: {}, listeners: {}, style: {}, hidden: false, ownText: '', value: '' });
    this.classList = { toggle() {}, add() {}, remove() {}, contains: () => false };
  }
  setAttribute(k, v) { this.attrs[k] = String(v); if (k === 'hidden') this.hidden = true; }
  getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; }
  removeAttribute(k) { delete this.attrs[k]; }
  addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); }
  append(...nodes) { for (const n of nodes) this.children.push(typeof n === 'string' ? Object.assign(new El('#text', this.doc), { ownText: n }) : n); }
  replaceChildren(...nodes) { this.children = []; this.append(...nodes); }
  get textContent() { return this.ownText + this.children.map(c => c.textContent).join(''); }
  set textContent(v) { this.ownText = String(v); this.children = []; }
  focus() { this.doc.activeElement = this; }
  select() {}
  remove() {}
  contains() { return true; }
  getClientRects() { return [{}]; }
  querySelectorAll() { return []; }
  // Dispatches a DOM-like event; returns whether a listener called preventDefault().
  fire(type, props = {}) {
    let prevented = false;
    const ev = { type, button: 0, target: this, preventDefault() { prevented = true; }, ...props };
    for (const fn of this.listeners[type] || []) fn(ev);
    return prevented;
  }
  click() { this.fire('click'); }
  find(pred) { return pred(this) ? this : this.children.reduce((hit, c) => hit || c.find(pred), null); }
}

const POSTING = { title: 'Data Engineering Intern | Kestrel Grid', meta: 'Viewed on kestrel-grid.example just now' };
const PROMPT = { state: 'prompt', posting: POSTING, vaultState: 'unlocked', hasKey: true };

// Loads the overlay for a tab; `state` is the worker's OVERLAY_STATE reply (an unlocked prompt with a key by default).
async function openOverlay(state = PROMPT) {
  const ids = new Map();
  const docListeners = {};
  const document = {
    activeElement: null,
    visibilityState: 'visible',
    createElement: tag => new El(tag, document),
    getElementById: id => { if (!ids.has(id)) ids.set(id, new El('div', document)); return ids.get(id); },
    addEventListener: (type, fn) => { (docListeners[type] ||= []).push(fn); },
    execCommand: () => false,
  };
  document.body = new El('body', document);
  const sent = [];
  const ports = [];
  let stateReply = state;
  const ctx = {
    document,
    navigator: { clipboard: { writeText: async () => {} } },
    Node: { DOCUMENT_POSITION_PRECEDING: 2, DOCUMENT_POSITION_FOLLOWING: 4 },
    window: { open() {} },
    setTimeout: () => 0, // no real timers: the 90 s analysis timer would hold the test process open
    clearTimeout() {},
    URL, TextEncoder, TextDecoder, crypto: globalThis.crypto, btoa, atob,
    chrome: {
      runtime: {
        id: 'abcdefghijklmnopabcdefghijklmnop',
        sendMessage: async msg => {
          sent.push(msg.type);
          return msg.type === 'OVERLAY_STATE' ? stateReply : { ok: true };
        },
        connect: () => {
          const port = { listeners: [], onMessage: { addListener: fn => port.listeners.push(fn) }, onDisconnect: { addListener() {} }, postMessage() {}, disconnect() {} };
          ports.push(port);
          return port;
        },
        onMessage: { addListener() {} },
        openOptionsPage() {},
      },
      tabs: { create() {} },
    },
  };
  vm.createContext(ctx);
  for (const f of ['lib/core.js', 'ui.js', 'overlay.js']) vm.runInContext(fs.readFileSync(path.join(ROOT, f), 'utf8'), ctx, { filename: f });
  await settle();
  const $ = id => document.getElementById(id);
  assert.equal($('state-heading').textContent, 'Find friends for this job?', 'the overlay rendered its prompt');
  const o = {
    ctx, $, sent, ports, document,
    heading: () => $('state-heading').textContent,
    button: text => $('panel-body').find(el => el.tagName === 'BUTTON' && el.textContent === text),
    closes: () => sent.filter(t => t === 'OVERLAY_CLOSE').length,
    // The worker's reply to the next OVERLAY_STATE, e.g. after the user unlocks in settings.
    setState: reply => { stateReply = reply; },
    fireDocument: (type, props = {}) => { for (const fn of docListeners[type] || []) fn({ type, preventDefault() {}, ...props }); },
    // Find friends, then the worker's reply on the analyze port.
    async findFriends(reply) {
      o.button('Find friends').click();
      await settle();
      if (reply) { o.ports.at(-1).listeners.forEach(fn => fn(reply)); await settle(); }
    },
    // A full scrim click: mousedown (whose default would move focus), then click.
    scrimClick() {
      const prevented = $('scrim').fire('mousedown');
      $('scrim').click();
      return prevented;
    },
  };
  return o;
}

const RESULT = {
  ok: true,
  threshold: 0.6,
  result: {
    job: { title: 'Data Engineering Intern', company: 'Kestrel Grid', skills: ['Python'], level: 'Internship', location: 'Remote', remote: true },
    matches: [{ name: 'Sam', contact: 'sam@example.com', score: 0.9, message: 'Hey Sam, this one fits your Python work.' }],
  },
};

// Every state from the Find friends click on (Design, "Scrim clicks", revised 2026-11-26): how to reach it, and its heading.
const AFTER_FIND_FRIENDS = [
  ['loading', o => o.findFriends(), 'Finding friends…'],
  ['results', o => o.findFriends(RESULT), '1 friend might want this job'],
  ['no matches', o => o.findFriends({ ...RESULT, result: { ...RESULT.result, matches: [] } }), 'No strong matches'],
  ['no friends (empty list)', o => o.findFriends({ ok: false, code: 'NO_FRIENDS', friends: 'empty' }), 'Add a friend first'],
  ['no friends (none included)', o => o.findFriends({ ok: false, code: 'NO_FRIENDS', friends: 'none-included' }), 'No friends included'],
  ['error', o => o.findFriends({ ok: false, error: { title: "Anthropic's API is busy", body: 'Try again in a few minutes.', action: 'retry' } }), "Anthropic's API is busy"],
  ['"Job Notifier is locked"', o => o.findFriends({ ok: false, code: 'LOCKED' }), 'Job Notifier is locked'],
  ['a prompt variant a reply leads back to (no key)', o => o.findFriends({ ok: false, code: 'NO_API_KEY' }), 'Find friends for this job?'],
];

// The prompt's variants when the overlay opens: the worker's OVERLAY_STATE replies.
const OPENING_PROMPTS = [
  ['prompt', PROMPT],
  ['no-key prompt', { ...PROMPT, hasKey: false }],
  ['setup prompt', { state: 'prompt', posting: POSTING, vaultState: 'uninitialized' }],
  ['locked prompt', { state: 'prompt', posting: POSTING, vaultState: 'locked' }],
  ['unreadable prompt', { state: 'prompt', posting: POSTING, vaultState: 'unreadable' }],
];

for (const [name, reply] of OPENING_PROMPTS) {
  test(`design (scrim clicks): a scrim click closes the ${name} when the overlay opens`, async () => {
    const o = await openOverlay(reply);
    o.scrimClick();
    assert.equal(o.closes(), 1);
  });
}

test('design (scrim clicks): a prompt reloaded by load() after returning from settings closes on a scrim click', async () => {
  // Opened locked; the user unlocks in settings and comes back, so the overlay asks the worker again.
  const o = await openOverlay({ state: 'prompt', posting: POSTING, vaultState: 'locked' });
  assert.ok(o.button('Open settings to unlock'));
  o.setState(PROMPT);
  o.fireDocument('visibilitychange');
  await settle();
  assert.ok(o.button('Find friends'), 'load() showed the unlocked prompt');
  o.scrimClick();
  assert.equal(o.closes(), 1);
});

test('design (scrim clicks): after Find friends led back to the no-key prompt, a prompt reloaded by load() closes on a scrim click again', async () => {
  const o = await openOverlay();
  await o.findFriends({ ok: false, code: 'NO_API_KEY' });
  assert.ok(o.button('Open settings'), 'the reply led back to the no-key prompt');
  o.setState(PROMPT); // the user added a key in settings and came back
  o.fireDocument('visibilitychange');
  await settle();
  assert.ok(o.button('Find friends'), 'load() showed the prompt with Find friends');
  o.scrimClick();
  assert.equal(o.closes(), 1);
});

for (const [name, reach, heading] of AFTER_FIND_FRIENDS) {
  test(`design (scrim clicks) / walkthrough 8.4: after Find friends, a scrim click does nothing in ${name}, and focus stays put`, async () => {
    const o = await openOverlay();
    await reach(o);
    assert.equal(o.heading(), heading, `reached ${name}`);
    const focused = o.document.activeElement;
    const prevented = o.scrimClick();
    assert.equal(o.closes(), 0, 'the overlay stays open');
    assert.equal(prevented, true, "the scrim's mousedown default is prevented, so focus doesn't move");
    assert.equal(o.document.activeElement, focused, 'focus stays where it was');
  });
}

for (const [name, reach, heading] of [['prompt', async () => {}, 'Find friends for this job?'], ...AFTER_FIND_FRIENDS]) {
  test(`design: Escape and Close both close the overlay in ${name}`, async () => {
    const o = await openOverlay();
    await reach(o);
    assert.equal(o.heading(), heading, `reached ${name}`);
    o.fireDocument('keydown', { key: 'Escape' });
    assert.equal(o.closes(), 1, 'Escape closes');
    o.$('close-btn').click();
    assert.equal(o.closes(), 2, 'Close closes');
  });
}

test('walkthrough 8.4: a scrim click while Find friends is loading keeps the overlay, and the results still arrive', async () => {
  const o = await openOverlay();
  await o.findFriends();
  assert.equal(o.ports.length, 1, 'one analyze request is running');
  // The second click of a double-click lands here once the panel shrinks to the loading state.
  o.scrimClick();
  assert.equal(o.closes(), 0, 'a request in flight is not thrown away by a stray click');
  o.ports[0].listeners.forEach(fn => fn(RESULT));
  await settle();
  assert.equal(o.heading(), '1 friend might want this job');
});

// Security approval for walkthrough 10.3 keeps this fallback: copying works when the Clipboard API is blocked.
test('criterion 10 / walkthrough 10.3: copying falls back to execCommand when the Clipboard API is blocked', async () => {
  const o = await openOverlay();
  o.ctx.navigator.clipboard.writeText = async () => { throw new Error('blocked by permissions policy'); };
  const copied = [];
  o.ctx.document.execCommand = command => { copied.push(command); return true; };
  assert.equal(await vm.runInContext('copyText("draft text")', o.ctx), true);
  assert.deepEqual(copied, ['copy']);
});
