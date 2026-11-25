importScripts('lib/core.js');

// Storage (criterion 34):
// - chrome.storage.local: settings { apiKey, model, effort, threshold }, autoDetect, friends.
// - chrome.storage.session (memory only, cleared when Chrome closes, not readable
//   by content scripts): jobs { [tabId]: posting }, prompts { [tabId]: posting
//   offered on a confirmation page }, prompted [posting hashes already offered].

const SITES = { origins: JN.ALL_SITES };
const SCRIPT_ID = 'job-notifier-detect';

// ── Settings & friends (set on the settings page) ──

async function getSettings() {
  const { settings, autoDetect } = await chrome.storage.local.get(['settings', 'autoDetect']);
  return JN.normalizeSettings({ ...settings, autoDetect });
}

// Re-checked on every read. Nothing exists until the user adds a friend.
async function getFriends() {
  const { friends } = await chrome.storage.local.get('friends');
  return JN.storedFriends(friends);
}

// ── Auto-detect (Decision 14, criteria 4 and 36) ──
// The content script is registered only while the setting is on and Chrome has
// granted all-sites access. The popup and settings page request the permission
// and write `autoDetect`; this worker drives everything else from these events,
// because the popup can close while Chrome's permission dialog is open.

let syncing = Promise.resolve();

function syncAutoDetect() {
  syncing = syncing.then(applyAutoDetect).catch(() => {});
  return syncing;
}

async function applyAutoDetect() {
  const [{ autoDetect }, access, scripts] = await Promise.all([
    chrome.storage.local.get('autoDetect'),
    chrome.permissions.contains(SITES),
    chrome.scripting.getRegisteredContentScripts({ ids: [SCRIPT_ID] }),
  ]);
  const on = autoDetect === true && access;
  // Site access removed in Chrome's extension settings: the setting follows.
  if (autoDetect === true && !access) await chrome.storage.local.set({ autoDetect: false });
  if (on && !scripts.length) {
    await chrome.scripting.registerContentScripts([
      { id: SCRIPT_ID, matches: JN.ALL_SITES, js: ['lib/core.js', 'content.js'], runAt: 'document_idle' },
    ]);
  }
  if (on || (!scripts.length && !access)) return;
  if (scripts.length) await chrome.scripting.unregisterContentScripts({ ids: [SCRIPT_ID] });
  if (access) await chrome.permissions.remove(SITES);
  await chrome.storage.session.remove('prompts');
  // Scripts already running in open pages stop reading them too.
  for (const tab of await chrome.tabs.query({})) {
    chrome.tabs.sendMessage(tab.id, { type: 'STOP' }).catch(() => {});
  }
}

// Granting all-sites access is how auto-detect gets turned on.
chrome.permissions.onAdded.addListener(async () => {
  if (await chrome.permissions.contains(SITES)) await chrome.storage.local.set({ autoDetect: true });
  syncAutoDetect();
});
chrome.permissions.onRemoved.addListener(() => syncAutoDetect());
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && 'autoDetect' in changes) syncAutoDetect();
});
chrome.runtime.onStartup.addListener(() => syncAutoDetect());
chrome.runtime.onInstalled.addListener(details => {
  if (details.reason === 'install') chrome.runtime.openOptionsPage();
  syncAutoDetect();
});

// ── Postings and confirmation prompts, per tab ──

function originOf(url) {
  try {
    return new URL(url).origin;
  } catch (e) {
    return '';
  }
}

async function rememberJob(sender, msg) {
  const { jobs = {} } = await chrome.storage.session.get('jobs');
  jobs[sender.tab.id] = { text: msg.text, title: msg.title || '', url: sender.url, seenAt: Date.now(), hash: JN.hashText(msg.text) };
  await chrome.storage.session.set({ jobs });
}

// A confirmation page in `tab` can offer a posting from the same tab or its
// opener tab (Decision 13), once per posting. Returns whether to show the prompt.
async function offerPrompt(sender) {
  const { jobs = {}, prompts = {}, prompted = [] } = await chrome.storage.session.get(['jobs', 'prompts', 'prompted']);
  const posting = JN.recallPosting(jobs, sender.tab);
  if (!posting || prompted.includes(posting.hash)) return false;
  prompts[sender.tab.id] = { ...posting, origin: originOf(sender.url) };
  await chrome.storage.session.set({ prompts, prompted: [...prompted, posting.hash].slice(-100) });
  return true;
}

// The prompt for a tab, only while the tab is still on the site that showed the confirmation.
async function getPrompt(tab) {
  const { prompts = {} } = await chrome.storage.session.get('prompts');
  const prompt = prompts[tab.id];
  return prompt && prompt.origin === originOf(tab.url) ? prompt : null;
}

async function dropPrompt(tabId, keep = () => false) {
  const { prompts = {} } = await chrome.storage.session.get('prompts');
  if (!prompts[tabId] || keep(prompts[tabId])) return;
  delete prompts[tabId];
  await chrome.storage.session.set({ prompts });
}

// A tab that moves to another site loses its prompt; same-site changes (single-page apps) keep it.
chrome.tabs.onUpdated.addListener((tabId, info) => {
  if (info.url) dropPrompt(tabId, p => p.origin === originOf(info.url));
});

chrome.tabs.onRemoved.addListener(async tabId => {
  const { jobs = {}, prompts = {} } = await chrome.storage.session.get(['jobs', 'prompts']);
  if (!jobs[tabId] && !prompts[tabId]) return;
  delete jobs[tabId];
  delete prompts[tabId];
  await chrome.storage.session.set({ jobs, prompts });
});

// ── Claude ──

// Resolves to the reply the popup or overlay gets. Never throws.
async function analyze(jobText) {
  const settings = await getSettings();
  if (!settings.apiKey) return { ok: false, code: 'NO_API_KEY' };
  const friends = await getFriends();
  const status = JN.friendsStatus(friends);
  if (status !== 'ok') return { ok: false, code: 'NO_FRIENDS', friends: status };

  const req = JN.buildRequest(jobText, friends, settings);
  let response;
  try {
    response = await fetch(req.url, { method: 'POST', headers: req.headers, body: JSON.stringify(req.body) });
  } catch (e) {
    return { ok: false, error: JN.describeApiError(0) };
  }
  if (!response.ok) {
    return { ok: false, error: JN.describeApiError(response.status, await response.json().catch(() => null)) };
  }
  try {
    return { ok: true, result: JN.parseResponse(await response.json(), friends, settings.threshold) };
  } catch (e) {
    return { ok: false, error: JN.ERRORS[e.code] || JN.ERRORS.incomplete };
  }
}

// One request at a time per popup or tab: repeat clicks share the running one (criterion 33).
const running = new Map();

function analyzeOnce(key, jobText) {
  if (!running.has(key)) running.set(key, analyze(jobText).finally(() => running.delete(key)));
  return running.get(key);
}

// ── Messaging (criterion 32) ──
// Content scripts can report what they saw; only extension pages can start a
// Claude call or receive friend data. There are no external listeners.

async function onContentMessage(msg, sender) {
  if (!(await getSettings()).autoDetect) return { off: true };
  if (msg.type === 'JOB_SEEN') {
    await rememberJob(sender, msg);
    return { ok: true };
  }
  return { show: await offerPrompt(sender) };
}

// Messages from the overlay page, framed in a tab by the content script.
async function onOverlayMessage(msg, tab) {
  if (msg.type === 'OVERLAY_STATE') {
    const prompt = await getPrompt(tab);
    if (!prompt) return { state: 'none' };
    return { state: 'prompt', posting: JN.postingLabel(prompt), hasKey: !!(await getSettings()).apiKey };
  }
  await dropPrompt(tab.id);
  chrome.tabs.sendMessage(tab.id, { type: 'CLOSE_OVERLAY' }, { frameId: 0 }).catch(() => {});
  return { ok: true };
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  let reply;
  if (JN.isValidContentMessage(msg, sender, chrome.runtime.id)) {
    reply = onContentMessage(msg, sender);
  } else if (JN.isExtensionPage(sender, chrome.runtime.id) && sender.tab && ['OVERLAY_STATE', 'OVERLAY_CLOSE'].includes(msg?.type)) {
    reply = onOverlayMessage(msg, sender.tab);
  } else {
    return false;
  }
  reply.then(sendResponse, () => sendResponse(undefined));
  return true;
});

// A long-lived port keeps the service worker alive for the whole API call.
// Popup: { type: 'ANALYZE_JOB', jobText }. Overlay: { type: 'ANALYZE_TAB' },
// which carries no text; the worker uses the posting it recorded for that tab.
chrome.runtime.onConnect.addListener(port => {
  const sender = port.sender;
  if (port.name !== 'analyze' || !JN.isExtensionPage(sender, chrome.runtime.id)) {
    port.disconnect();
    return;
  }

  port.onMessage.addListener(async msg => {
    let reply;
    if (msg?.type === 'ANALYZE_JOB' && typeof msg.jobText === 'string') {
      reply = await analyzeOnce(sender.tab ? `tab:${sender.tab.id}` : `page:${sender.documentId || sender.url}`, msg.jobText);
    } else if (msg?.type === 'ANALYZE_TAB' && sender.tab) {
      const prompt = await getPrompt(sender.tab);
      reply = prompt ? await analyzeOnce(`tab:${sender.tab.id}`, prompt.text) : { ok: false, code: 'NO_POSTING' };
    } else {
      return;
    }
    try {
      port.postMessage(reply);
    } catch (e) {
      // The popup or overlay closed before the answer arrived.
    }
  });
});
