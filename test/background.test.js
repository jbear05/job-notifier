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
// Objects built by the code under test carry the vm realm's prototypes, which deepStrictEqual rejects
// against this realm's literals. structuredClone rebuilds them here and, unlike JSON, keeps undefined values.
const mainRealm = value => structuredClone(value);

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
  const sendMessage = (msg, sender) => new Promise(resolve => {
    let replied = false;
    const kept = chrome.runtime.onMessage.fire(msg, sender, reply => { replied = true; resolve(reply); });
    if (!kept.includes(true) && !replied) resolve(undefined);
  });
  // Security Low 2: the settings page's vault messages travel on a one-request 'vault' port (see vault.test.js).
  const sendOnVaultPort = (msg, sender) => new Promise(resolve => {
    let done = false;
    const finish = value => { if (!done) { done = true; resolve(value); } };
    const port = { name: 'vault', sender, onMessage: event(), onDisconnect: event(), postMessage: finish, disconnect: () => finish(undefined) };
    chrome.runtime.onConnect.fire(port);
    if (!done) port.onMessage.fire(msg);
    setTimeout(() => finish('no reply within 5 s'), 5000).unref();
  });
  const send = (msg, sender) => (/^VAULT_(?!LOCK$)/.test(msg?.type || '') ? sendOnVaultPort : sendMessage)(msg, sender);
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

// The same document after history.pushState or a hash change: Chrome keeps sender.documentId.
const movedContent = (sender, url) => ({ ...sender, url, tab: { ...sender.tab, url } });
const movedOverlay = (sender, url) => ({ ...sender, tab: { ...sender.tab, url } });

// The worker checks a stored prompt's page with a no-data ping to its documentId (security contract,
// criterion 31). Here, as in Chrome, the ping rejects once that document is gone.
const PING = { type: 'DOCUMENT_PING' };
const isPing = msg => msg?.type === PING.type;
function liveDocuments(chrome) {
  const live = new Map(); // tabId -> the documentId currently loaded in its top frame
  const toTabs = [];
  chrome.tabs.sendMessage = async (tabId, msg, options) => {
    toTabs.push([tabId, msg, options]);
    if (!isPing(msg)) return undefined;
    if (options?.documentId && live.get(tabId) === options.documentId) return { ok: true };
    throw new Error('Could not establish connection. Receiving end does not exist.');
  };
  return { live, pings: () => toTabs.filter(([, msg]) => isPing(msg)) };
}

// The overlay's analyze port, as chrome.runtime.connect from the frame.
function analyzeTab(chrome, sender) {
  return new Promise(resolve => {
    const port = { name: 'analyze', sender, onMessage: event(), postMessage: resolve, disconnect() { resolve('disconnected'); } };
    chrome.runtime.onConnect.fire(port);
    port.onMessage.fire({ type: 'ANALYZE_TAB' });
  });
}

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

// Criterion 31, corrected after the walkthrough pre-check (docs/walkthrough-auto/RESULTS.md, finding 1).
// Chrome 157 and Edge 158 fire tabs.onUpdated { status: 'loading', url } then { status: 'complete' } for
// history.pushState and hash changes exactly as for a real navigation, so status can't tell them apart.
// The browser's sender.documentId can: it stays the same for those changes and is new after a reload or
// navigation (probed in both browsers on 2026-11-26).

test('criterion 31: pushState and hash changes (loading, then complete, same documentId) keep the prompt', async () => {
  const { chrome, session, send } = loadWorker();
  const docs = liveDocuments(chrome);
  const tabId = 30;
  await send(jobSeen(), content(tabId, 'https://jobs.example/posting/30'));
  const done = content(tabId, 'https://ats.example/apply');
  docs.live.set(tabId, done.documentId);
  assert.equal((await send({ type: 'CONFIRMATION_SEEN' }, done))?.show, true);
  const frame = overlay(tabId, done.url);
  assert.equal((await send({ type: 'OVERLAY_STATE' }, frame))?.state, 'prompt');

  for (const [changes, url] of [
    [[{ status: 'loading', url: 'https://ats.example/apply?step=done' }, { status: 'complete' }], 'https://ats.example/apply?step=done'],
    [[{ status: 'loading', url: 'https://ats.example/apply?step=done#receipt' }, { status: 'complete' }], 'https://ats.example/apply?step=done#receipt'],
    [[{ url: 'https://ats.example/apply?step=receipt' }], 'https://ats.example/apply?step=receipt'],
  ]) {
    for (const info of changes) chrome.tabs.onUpdated.fire(tabId, info, { id: tabId, url, status: info.status || 'complete' });
    await settle();
    // content.js checks the page again after a URL change, from the same document.
    await send({ type: 'CONFIRMATION_SEEN' }, movedContent(done, url));
    assert.ok(session.data.prompts?.[tabId], `the worker still holds the prompt after ${JSON.stringify(changes)}`);
    assert.equal((await send({ type: 'OVERLAY_STATE' }, movedOverlay(frame, url)))?.state, 'prompt', `the overlay still finds the prompt at ${url}`);
  }
});

test('criterion 31: a pushState while a confirmation is still processing does not cancel the offer', async () => {
  const { chrome, send } = loadWorker();
  const docs = liveDocuments(chrome);
  const tabId = 31;
  await send(jobSeen(), content(tabId, 'https://jobs.example/posting/31'));
  const done = content(tabId, 'https://ats.example/apply/31');
  docs.live.set(tabId, done.documentId);

  const local = chrome.storage.local;
  const get = local.get.bind(local);
  let releaseSettings;
  const settingsGate = new Promise(resolve => { releaseSettings = resolve; });
  local.get = async keys => { await settingsGate; return get(keys); };
  const handling = send({ type: 'CONFIRMATION_SEEN' }, done);
  const url = 'https://ats.example/apply/31?step=done';
  chrome.tabs.onUpdated.fire(tabId, { status: 'loading', url }, { id: tabId, url, status: 'loading' });
  chrome.tabs.onUpdated.fire(tabId, { status: 'complete' }, { id: tabId, url, status: 'complete' });
  await settle();
  releaseSettings();
  local.get = get;

  assert.equal((await handling)?.show, true, 'status "loading" for the same document must not invalidate the confirmation');
  assert.equal((await send({ type: 'OVERLAY_STATE' }, overlay(tabId, url)))?.state, 'prompt');
});

test('criterion 31: a report from a different document in the tab clears its prompt', async () => {
  const { chrome, session, send } = loadWorker();
  chrome.tabs.sendMessage = async () => ({ ok: true }); // every page answers, so only the reported documentId can clear
  for (const [tabId, report] of [
    // Reloaded confirmation page: same URL, new document.
    [32, done => ['CONFIRMATION_SEEN', { ...done, documentId: `reloaded-${done.documentId}` }]],
    // Navigated, same site, to another page that looks like a posting.
    [33, () => ['JOB_SEEN', content(33, 'https://ats.example/careers/next-role')]],
  ]) {
    await send(jobSeen(tabId), content(tabId, `https://jobs.example/posting/${tabId}`));
    const done = content(tabId, `https://ats.example/done/${tabId}`);
    assert.equal((await send({ type: 'CONFIRMATION_SEEN' }, done))?.show, true);
    const [type, sender] = report(done);
    await send(type === 'JOB_SEEN' ? jobSeen(`next-${tabId}`) : { type }, sender);
    assert.equal(session.data.prompts?.[tabId], undefined, `${type} from a new document drops tab ${tabId}'s prompt`);
    assert.equal((await send({ type: 'OVERLAY_STATE' }, overlay(tabId, sender.url)))?.state, 'none');
  }
});

test('criterion 31: a prompt whose document is gone is dropped before use (failed ping)', async () => {
  const { chrome, session, send } = loadWorker();
  const docs = liveDocuments(chrome);
  const tabId = 34;
  await send(jobSeen(), content(tabId, 'https://jobs.example/posting/34'));
  const done = content(tabId, 'https://ats.example/done/34');
  docs.live.set(tabId, done.documentId);
  assert.equal((await send({ type: 'CONFIRMATION_SEEN' }, done))?.show, true);
  const frame = overlay(tabId, done.url);
  assert.equal((await send({ type: 'OVERLAY_STATE' }, frame))?.state, 'prompt', 'a live document keeps its prompt');
  assert.deepEqual(mainRealm(docs.pings().at(-1)), [tabId, PING, { documentId: done.documentId }],
    'before using the prompt the worker pings the stored document, with no data');

  // The page reloaded or navigated and its new document hasn't reported anything yet.
  docs.live.set(tabId, 'some-newer-document');
  const reply = await analyzeTab(chrome, frame);
  assert.deepEqual(mainRealm(reply), { ok: false, code: 'NO_POSTING' }, 'Find friends on a stale prompt sends nothing');
  assert.equal(session.data.prompts?.[tabId], undefined, 'the stale prompt is dropped');
  assert.equal((await send({ type: 'OVERLAY_STATE' }, frame))?.state, 'none');
});

test('criterion 31 (fail closed): a confirmation without a browser documentId is not offered', async () => {
  const { session, send } = loadWorker();
  const tabId = 35;
  await send(jobSeen(), content(tabId, 'https://jobs.example/posting/35'));
  const { documentId, ...noDocument } = content(tabId, 'https://ats.example/done/35');
  assert.notEqual((await send({ type: 'CONFIRMATION_SEEN' }, noDocument))?.show, true, 'no prompt is offered');
  assert.equal(session.data.prompts?.[tabId], undefined, 'and none is stored');
  assert.equal((await send({ type: 'OVERLAY_STATE' }, overlay(tabId, noDocument.url)))?.state, 'none');
});

test('criterion 31 / walkthrough 7.3: a reload still clears the prompt, and the posting is not offered again', async () => {
  const { chrome, session, send } = loadWorker();
  const docs = liveDocuments(chrome);
  const tabId = 36;
  await send(jobSeen(), content(tabId, 'https://jobs.example/posting/36'));
  const done = content(tabId, 'https://ats.example/done/36');
  docs.live.set(tabId, done.documentId);
  assert.equal((await send({ type: 'CONFIRMATION_SEEN' }, done))?.show, true);

  chrome.tabs.onUpdated.fire(tabId, { status: 'loading' }, { id: tabId, url: done.url, status: 'loading' });
  const reloaded = { ...done, documentId: `reloaded-${done.documentId}` };
  docs.live.set(tabId, reloaded.documentId);
  chrome.tabs.onUpdated.fire(tabId, { status: 'complete' }, { id: tabId, url: done.url, status: 'complete' });
  await settle();
  assert.notEqual((await send({ type: 'CONFIRMATION_SEEN' }, reloaded))?.show, true, 'each posting is offered once');
  assert.equal((await send({ type: 'OVERLAY_STATE' }, overlay(tabId, done.url)))?.state, 'none');
  assert.equal(session.data.prompts?.[tabId], undefined);
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
  const docs = liveDocuments(chrome);
  const tabId = 13;
  await send(jobSeen(), content(tabId, 'https://ats.example/posting'));
  docs.live.set(tabId, content(tabId, 'https://ats.example/done').documentId);

  const local = chrome.storage.local;
  const get = local.get.bind(local);
  let releaseSettings;
  const settingsGate = new Promise(resolve => { releaseSettings = resolve; });
  local.get = async keys => {
    await settingsGate;
    return get(keys);
  };
  const handling = send({ type: 'CONFIRMATION_SEEN' }, content(tabId, 'https://ats.example/done'));
  // A real navigation: the old document is gone and a new one is loading.
  docs.live.set(tabId, content(tabId, 'https://ats.example/next').documentId);
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
  const docs = liveDocuments(chrome);
  const tabId = 14;
  await send(jobSeen(), content(tabId, 'https://ats.example/posting'));
  docs.live.set(tabId, content(tabId, 'https://ats.example/done').documentId);
  assert.equal((await send({ type: 'CONFIRMATION_SEEN' }, content(tabId, 'https://ats.example/done')))?.show, true);

  // A real navigation: the old document is gone and a new one is loading.
  docs.live.set(tabId, content(tabId, 'https://ats.example/next').documentId);
  chrome.tabs.onUpdated.fire(tabId, { status: 'loading' }, { id: tabId, url: 'https://ats.example/next' });
  const reply = await send({ type: 'OVERLAY_STATE' }, overlay(tabId, 'https://ats.example/next'));
  assert.equal(reply?.state, 'none', 'lookups cannot return the previous document’s prompt during cleanup');
});

test('criterion 31: the worker does not acknowledge readiness when reading overlay settings fails', async () => {
  const { chrome, send } = loadWorker();
  const tabId = 15;
  const done = 'https://ats.example/done';
  const messages = [];
  chrome.tabs.sendMessage = async (_tabId, msg) => { if (!isPing(msg)) messages.push(msg.type); };
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
  chrome.tabs.sendMessage = async (id, msg) => { if (!isPing(msg)) messages.push([id, msg.type]); };
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

// Walkthrough 7.2 (RESULTS.md finding 1): with the prompt gone, the worker ignored OVERLAY_CLOSE and the
// full-page frame stayed stuck. Closing is always safe, so a valid overlay frame can always close itself.
test('walkthrough 7.2: OVERLAY_CLOSE from the overlay frame always removes the frame, even with no stored prompt', async () => {
  const { chrome, session, send } = loadWorker();
  const toTabs = [];
  chrome.tabs.sendMessage = async (...args) => { toTabs.push(args); };
  const closes = () => toTabs.filter(([, msg]) => msg?.type === 'CLOSE_OVERLAY');
  const CLOSE = [{ type: 'CLOSE_OVERLAY' }, { frameId: 0 }];

  await send({ type: 'OVERLAY_CLOSE' }, overlay(40, 'https://ats.example/done/40'));
  assert.deepEqual(mainRealm(closes()), [[40, ...CLOSE]], 'a tab that never had a prompt');

  const tabId = 41;
  await send(jobSeen(), content(tabId, 'https://jobs.example/posting/41'));
  assert.equal((await send({ type: 'CONFIRMATION_SEEN' }, content(tabId, 'https://ats.example/done/41')))?.show, true);
  const frame = overlay(tabId, 'https://ats.example/done/41');
  assert.equal((await send({ type: 'OVERLAY_STATE' }, frame))?.state, 'prompt');
  delete session.data.prompts[tabId]; // dropped by the worker since the overlay loaded it
  await send({ type: 'OVERLAY_CLOSE' }, frame);
  assert.deepEqual(mainRealm(closes().at(-1)), [tabId, ...CLOSE], 'the overlay whose prompt was dropped (7.2)');

  const tabId2 = 42;
  await send(jobSeen('b'), content(tabId2, 'https://jobs.example/posting/42'));
  assert.equal((await send({ type: 'CONFIRMATION_SEEN' }, content(tabId2, 'https://ats.example/done/42')))?.show, true);
  const frame2 = overlay(tabId2, 'https://ats.example/done/42');
  assert.equal((await send({ type: 'OVERLAY_STATE' }, frame2))?.state, 'prompt');
  await send({ type: 'OVERLAY_CLOSE' }, frame2);
  assert.deepEqual(mainRealm(closes().at(-1)), [tabId2, ...CLOSE], 'the owning overlay, prompt still stored');
  assert.equal(session.data.prompts?.[tabId2], undefined, 'closing clears the owner\'s prompt');

  const before = closes().length;
  await send({ type: 'OVERLAY_CLOSE' }, content(43, 'https://ats.example/done/43'));
  await send({ type: 'OVERLAY_CLOSE' }, { id: RID, url: `chrome-extension://${RID}/popup.html`, frameId: 0 });
  await send({ type: 'OVERLAY_CLOSE' }, { ...overlay(44, 'https://ats.example/done/44'), url: `chrome-extension://${RID}/options.html` });
  assert.equal(closes().length, before, 'the sender gate stays: no content script, popup, or other extension page can close a tab\'s frame');
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
