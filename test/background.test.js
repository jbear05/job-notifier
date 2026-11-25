// Runs background.js in a vm with an in-memory chrome.* so service-worker flows
// can be tested in Node. Storage calls resolve on the next macrotask, like
// Chrome's async storage, so handlers that run at the same time interleave.
// Test names cite the criterion or the review finding they check.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const RID = 'abcdefghijklmnopabcdefghijklmnop';
const POSTING = 'Responsibilities and qualifications. Salary and benefits. Full-time, remote. ' +
  '3+ years experience with Go. Apply now. '.repeat(5);

const nextTask = () => new Promise(resolve => setImmediate(resolve));
const settle = async () => { for (let i = 0; i < 50; i++) await nextTask(); };
const copy = value => (value === undefined ? undefined : JSON.parse(JSON.stringify(value)));

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

// Auto-detect on, all-sites access granted, a key, and one friend.
function loadWorker({ fetch = async () => { throw new Error('no network in tests'); }, abortSignal = AbortSignal } = {}) {
  const local = storageArea({
    autoDetect: true,
    settings: { apiKey: 'sk-ant-test' },
    friends: [{ name: 'Sam', contact: 'sam@example.com', skills: ['Go'] }],
  });
  const session = storageArea();
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
      sendMessage: async () => {},
      onStartup: event(), onInstalled: event(), onMessage: event(), onConnect: event(),
    },
    tabs: { onUpdated: event(), onRemoved: event(), query: async () => [], sendMessage: () => Promise.resolve(), create: async () => {} },
  };
  const ctx = {
    chrome, crypto: globalThis.crypto, URL, TextEncoder, TextDecoder, Uint8Array, btoa, atob,
    AbortController, AbortSignal: abortSignal, setTimeout, clearTimeout, fetch,
  };
  vm.createContext(ctx);
  ctx.importScripts = (...files) => {
    for (const f of files) vm.runInContext(fs.readFileSync(path.join(ROOT, f), 'utf8'), ctx, { filename: f });
  };
  ctx.importScripts('background.js');

  // chrome.runtime.sendMessage as seen by the worker: resolves with its reply, or undefined if unhandled.
  const send = (msg, sender) => new Promise(resolve => {
    let replied = false;
    const kept = chrome.runtime.onMessage.fire(msg, sender, reply => { replied = true; resolve(reply); });
    if (!kept.includes(true) && !replied) resolve(undefined);
  });
  return { chrome, session, send };
}

const documentIds = new Map();

function documentId(tabId, frameId, url) {
  // Chrome keeps the opaque document ID the same after a fragment change.
  const key = `${tabId}:${frameId}:${url.split('#')[0]}`;
  if (!documentIds.has(key)) documentIds.set(key, `document-${documentIds.size + 1}`);
  return documentIds.get(key);
}

const content = (tabId, url) => ({ id: RID, url, tab: { id: tabId, url }, frameId: 0, documentId: documentId(tabId, 0, url) });
const overlay = (tabId, url) => ({ id: RID, url: `chrome-extension://${RID}/overlay.html`, tab: { id: tabId, url }, frameId: 3, documentId: documentId(tabId, 3, url) });
const jobSeen = (n = '') => ({ type: 'JOB_SEEN', text: `${POSTING} ${n}`, title: `Job ${n}` });
const TABS = [1, 2, 3, 4, 5];

test('review 1 finding 1: postings reported by five tabs at once are all kept', async () => {
  const { send } = loadWorker();
  await Promise.all(TABS.map(t => send(jobSeen(t), content(t, `https://jobs${t}.example/posting`))));
  const offered = [];
  for (const t of TABS) {
    const reply = await send({ type: 'CONFIRMATION_SEEN' }, content(t, `https://ats${t}.example/done`));
    if (reply?.show === true) offered.push(t);
  }
  assert.deepEqual(offered, TABS, 'every tab can still offer the posting it reported');
});

test('review 1 finding 1: prompts for five tabs confirmed at once are all kept', async () => {
  const { send } = loadWorker();
  for (const t of TABS) await send(jobSeen(t), content(t, `https://jobs${t}.example/posting`));
  const replies = await Promise.all(TABS.map(t => send({ type: 'CONFIRMATION_SEEN' }, content(t, `https://ats${t}.example/done`))));
  assert.deepEqual(replies.map(r => r?.show), TABS.map(() => true));
  const states = [];
  for (const t of TABS) states.push((await send({ type: 'OVERLAY_STATE' }, overlay(t, `https://ats${t}.example/done`)))?.state);
  assert.deepEqual(states, TABS.map(() => 'prompt'), 'each tab\'s overlay still finds its prompt');
});

test('criterion 31 / review 1 finding 3: a full navigation clears the prompt; a same-document URL change keeps it', async () => {
  const { chrome, send } = loadWorker();
  const state = async (tabId, url) => (await send({ type: 'OVERLAY_STATE' }, overlay(tabId, url)))?.state;
  const navigate = async (tabId, changeInfo, url) => {
    chrome.tabs.onUpdated.fire(tabId, changeInfo, { id: tabId, url, status: changeInfo.status || 'complete' });
    await settle();
  };

  await send(jobSeen(), content(10, 'https://jobs.example/posting/1'));
  assert.equal((await send({ type: 'CONFIRMATION_SEEN' }, content(10, 'https://ats.example/done')))?.show, true);
  assert.equal(await state(10, 'https://ats.example/done'), 'prompt');

  await navigate(10, { url: 'https://ats.example/done#receipt' }, 'https://ats.example/done#receipt');
  assert.equal(await state(10, 'https://ats.example/done#receipt'), 'prompt', 'same-document URL change (no status) keeps it');

  await navigate(10, { status: 'loading', url: 'https://ats.example/next' }, 'https://ats.example/next');
  assert.equal(await state(10, 'https://ats.example/next'), 'none', 'full navigation within the same site clears it');

  // A reload is a full navigation too: status 'loading' with no url change.
  await send(jobSeen('b'), content(11, 'https://jobs.example/posting/2'));
  assert.equal((await send({ type: 'CONFIRMATION_SEEN' }, content(11, 'https://ats.example/done/2')))?.show, true);
  await navigate(11, { status: 'loading' }, 'https://ats.example/done/2');
  assert.equal(await state(11, 'https://ats.example/done/2'), 'none', 'reload clears it');
});

test('security low 2: a stored posting keeps the hostname, never the path or query', async () => {
  const { session, send } = loadWorker();
  await send(jobSeen(), content(12, 'https://www.kestrel-grid.example/jobs/4821/apply?ref=newsletter&token=s3cr3t#top'));
  assert.equal((await send({ type: 'CONFIRMATION_SEEN' }, content(12, 'https://ats.example/applications/99/done?session=abc')))?.show, true);
  const stored = JSON.stringify(session.data);
  for (const part of ['/jobs/4821', 'ref=newsletter', 's3cr3t', '#top', '/applications/99', 'session=abc']) {
    assert.ok(!stored.includes(part), `session storage holds "${part}"`);
  }
  assert.ok(stored.includes('kestrel-grid.example'), 'the hostname is kept for the prompt');
  const reply = await send({ type: 'OVERLAY_STATE' }, overlay(12, 'https://ats.example/applications/99/done?session=abc'));
  assert.equal(reply?.state, 'prompt');
  assert.equal(reply.posting.meta, 'Viewed on kestrel-grid.example just now', 'the prompt still names the site');
});

test('criterion 31: a confirmation still processing when its tab navigates cannot leave a prompt', async () => {
  const { chrome, send } = loadWorker();
  const tabId = 13;
  await send(jobSeen(), content(tabId, 'https://ats.example/posting'));

  const local = chrome.storage.local;
  const get = local.get.bind(local);
  let releaseSettings;
  const settingsGate = new Promise(resolve => { releaseSettings = resolve; });
  local.get = async keys => {
    await settingsGate;
    return get(keys);
  };
  const handling = send({ type: 'CONFIRMATION_SEEN' }, content(tabId, 'https://ats.example/done'));
  chrome.tabs.onUpdated.fire(tabId, { status: 'loading' }, { id: tabId, url: 'https://ats.example/next' });
  await settle();
  releaseSettings();
  await handling;
  await settle();

  const reply = await send({ type: 'OVERLAY_STATE' }, overlay(tabId, 'https://ats.example/next'));
  assert.equal(reply?.state, 'none', 'the previous document cannot restore a prompt after a full navigation');
});

test('criterion 31: a prompt lookup waits for a full-navigation cleanup already in progress', async () => {
  const { chrome, send } = loadWorker();
  const tabId = 14;
  await send(jobSeen(), content(tabId, 'https://ats.example/posting'));
  assert.equal((await send({ type: 'CONFIRMATION_SEEN' }, content(tabId, 'https://ats.example/done')))?.show, true);

  chrome.tabs.onUpdated.fire(tabId, { status: 'loading' }, { id: tabId, url: 'https://ats.example/next' });
  const reply = await send({ type: 'OVERLAY_STATE' }, overlay(tabId, 'https://ats.example/next'));
  assert.equal(reply?.state, 'none', 'lookups cannot return the previous document’s prompt during cleanup');
});

test('criterion 31: the worker does not acknowledge readiness when reading overlay settings fails', async () => {
  const { chrome, send } = loadWorker();
  const tabId = 15;
  const done = 'https://ats.example/done';
  const messages = [];
  chrome.tabs.sendMessage = async (_tabId, msg) => { messages.push(msg.type); };
  await send(jobSeen(), content(tabId, 'https://ats.example/posting'));
  assert.equal((await send({ type: 'CONFIRMATION_SEEN' }, content(tabId, done)))?.show, true);
  chrome.storage.local.get = async () => { throw new Error('settings unavailable'); };

  const reply = await send({ type: 'OVERLAY_STATE' }, overlay(tabId, done));
  assert.notEqual(reply?.state, 'prompt');
  assert.deepEqual(messages, [], 'a failed state request leaves the host watchdog active');
});

test('criterion 31: only the rendered overlay can acknowledge readiness', async () => {
  const { chrome, send } = loadWorker();
  const tabId = 16;
  const done = 'https://ats.example/done';
  const hostSender = content(tabId, done);
  const frameSender = overlay(tabId, done);
  const messages = [];
  chrome.tabs.sendMessage = async (id, msg) => { messages.push([id, msg.type]); };
  await send(jobSeen(), content(tabId, 'https://ats.example/posting'));
  assert.equal((await send({ type: 'CONFIRMATION_SEEN' }, hostSender))?.show, true);
  const reply = await send({ type: 'OVERLAY_STATE' }, frameSender);
  assert.equal(reply?.state, 'prompt');
  await send({ type: 'OVERLAY_READY' }, hostSender);
  assert.deepEqual(messages, [], 'neither a state reply nor the host message can confirm readiness');

  await send({ type: 'OVERLAY_READY' }, { ...frameSender, frameId: 4 });
  await send({ type: 'OVERLAY_READY' }, { ...frameSender, documentId: 'different-document' });
  assert.deepEqual(messages, [], 'an acknowledgment has to come from the frame and document that loaded the prompt');

  await send({ type: 'OVERLAY_READY' }, frameSender);
  assert.deepEqual(messages, [[tabId, 'OVERLAY_READY']]);
});

test('review 2 privacy: the stored posting site is the hostname without a non-default port', async () => {
  const { session, send } = loadWorker();
  const tabId = 17;
  await send(jobSeen(), content(tabId, 'http://www.kestrel-grid.example:12345/posting'));
  assert.equal(session.data.jobs[tabId].url, 'www.kestrel-grid.example');
});

test('review 2 timeout: the worker reports a fetch timeout before Chrome’s 30-second limit', async () => {
  const signal = AbortSignal.abort(new DOMException('Test deadline reached', 'TimeoutError'));
  let deadline;
  const { chrome, send } = loadWorker({
    abortSignal: { timeout: ms => { deadline = ms; return signal; } },
    fetch: async (_url, options) => { throw options.signal.reason; },
  });
  const optSender = { id: RID, url: `chrome-extension://${RID}/options.html`, frameId: 0 };
  const setup = await send({ type: 'VAULT_SETUP', passphrase: 'test-passphrase-value' }, optSender);
  assert.equal(setup?.ok, true);
  const claude = await send({
    type: 'VAULT_SAVE_CLAUDE',
    apiKey: 'sk-ant-test',
    model: 'claude-haiku-5-5',
    effort: 'low',
    threshold: 0.6,
    expectedRev: setup.vaultRev,
  }, optSender);
  assert.equal(claude?.ok, true);
  const friends = await send({
    type: 'VAULT_SAVE_FRIENDS',
    friends: [{ name: 'Sam', contact: 'sam@example.com', skills: ['Go'] }],
    expectedRev: claude.vaultRev,
  }, optSender);
  assert.equal(friends?.ok, true);

  const response = new Promise(resolve => {
    const port = {
      name: 'analyze',
      sender: { id: RID, url: `chrome-extension://${RID}/popup.html` },
      onMessage: event(),
      postMessage: resolve,
    };
    chrome.runtime.onConnect.fire(port);
    port.onMessage.fire({ type: 'ANALYZE_JOB', jobText: POSTING });
  });

  const reply = await response;
  assert.ok(deadline > 0 && deadline < 30_000, `worker timeout was ${deadline} ms`);
  assert.equal(reply.ok, false);
  assert.equal(reply.error.action, 'retry');
  assert.match(reply.error.title, /time/i);
  const displayedSeconds = reply.error.body.match(/\b(\d+) seconds\b/);
  if (displayedSeconds) assert.equal(Number(displayedSeconds[1]), deadline / 1000);
});
