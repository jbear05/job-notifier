// Runs background.js in a vm with an in-memory chrome.* so service-worker flows
// can be tested in Node. Storage calls resolve on the next macrotask, like
// Chrome's async storage, so handlers that run at the same time interleave.
// Test names cite the criterion or the review round 1 finding they check.
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
function loadWorker() {
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
      onStartup: event(), onInstalled: event(), onMessage: event(), onConnect: event(),
    },
    tabs: { onUpdated: event(), onRemoved: event(), query: async () => [], sendMessage: () => Promise.resolve(), create: async () => {} },
  };
  const ctx = {
    chrome, URL, TextEncoder, AbortController, AbortSignal, setTimeout, clearTimeout,
    fetch: async () => { throw new Error('no network in tests'); },
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

const content = (tabId, url) => ({ id: RID, url, tab: { id: tabId, url }, frameId: 0 });
const overlay = (tabId, url) => ({ id: RID, url: `chrome-extension://${RID}/overlay.html`, tab: { id: tabId, url }, frameId: 3 });
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
