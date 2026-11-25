importScripts('lib/core.js');

// Storage (criterion 34):
// - chrome.storage.local: settings { apiKey, model, effort, threshold }, autoDetect, friends.
// - chrome.storage.session (memory only, cleared when Chrome closes, not readable
//   by content scripts): jobs { [tabId]: posting }, prompts { [tabId]: posting
//   offered on a confirmation page }, prompted [posting hashes already offered].

const SITES = { origins: JN.ALL_SITES };
const SCRIPT_ID = 'job-notifier-detect';
const API_TIMEOUT_MS = 25000;
const API_TIMEOUT_ERROR = {
  ...JN.ERRORS.timeout,
  body: `There was no response after ${API_TIMEOUT_MS / 1000} seconds. Try again.`,
};

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
  contentDocuments.clear();
  if (scripts.length) await chrome.scripting.unregisterContentScripts({ ids: [SCRIPT_ID] });
  if (access) await chrome.permissions.remove(SITES);
  await inSession(() => chrome.storage.session.remove('prompts'));
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
  if (area !== 'local' || !('autoDetect' in changes)) return;
  if (changes.autoDetect.newValue !== true) contentDocuments.clear();
  syncAutoDetect();
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

// Serialize session map changes and prompt lookups so tabs don't overwrite
// each other's entries or retrieve a prompt while its deletion is queued.
let sessionOperations = Promise.resolve();
// Tokens distinguish an in-flight content message from one sent after a full navigation.
const contentDocuments = new Map();

function currentDocument(tabId) {
  if (!contentDocuments.has(tabId)) contentDocuments.set(tabId, Symbol());
  const token = contentDocuments.get(tabId);
  return () => contentDocuments.get(tabId) === token;
}

function inSession(step) {
  const run = sessionOperations.then(step);
  sessionOperations = run.catch(() => {});
  return run;
}

// Only the posting's hostname is kept as `url`.
function rememberJob(sender, msg, isCurrent) {
  return inSession(async () => {
    const { jobs = {} } = await chrome.storage.session.get('jobs');
    if (!isCurrent()) return;
    jobs[sender.tab.id] = { text: msg.text, title: msg.title || '', url: new URL(sender.url).hostname, seenAt: Date.now(), hash: JN.hashText(msg.text) };
    await chrome.storage.session.set({ jobs });
  });
}

// A confirmation page in `tab` can offer a posting from the same tab or its
// opener tab (Decision 13), once per posting. Resolves to whether to show the prompt.
function offerPrompt(sender, isCurrent) {
  return inSession(async () => {
    const { jobs = {}, prompts = {}, prompted = [] } = await chrome.storage.session.get(['jobs', 'prompts', 'prompted']);
    if (!isCurrent()) return false;
    const posting = JN.recallPosting(jobs, sender.tab);
    if (!posting || prompted.includes(posting.hash)) return false;
    prompts[sender.tab.id] = { ...posting, origin: originOf(sender.url), contentDocumentId: sender.documentId };
    await chrome.storage.session.set({ prompts, prompted: [...prompted, posting.hash].slice(-100) });
    return isCurrent();
  });
}

// Read inside the session queue, after any navigation cleanup already enqueued.
function readPrompt(prompts, tab) {
  const prompt = prompts[tab.id];
  return prompt && prompt.origin === originOf(tab.url) ? prompt : null;
}

function dropPrompt(tabId, contentDocumentId) {
  return inSession(async () => {
    const { prompts = {} } = await chrome.storage.session.get('prompts');
    const prompt = prompts[tabId];
    if (!prompt || (contentDocumentId && contentDocumentId !== prompt.contentDocumentId)) return;
    delete prompts[tabId];
    await chrome.storage.session.set({ prompts });
  });
}

// A full navigation or reload clears the tab's prompt (criterion 31). Same-document
// URL changes (single-page apps) arrive without status 'loading' and keep it.
chrome.tabs.onUpdated.addListener((tabId, info) => {
  if (info.status !== 'loading') return;
  contentDocuments.delete(tabId);
  dropPrompt(tabId);
});

chrome.tabs.onRemoved.addListener(tabId => {
  contentDocuments.delete(tabId);
  return inSession(async () => {
    const { jobs = {}, prompts = {} } = await chrome.storage.session.get(['jobs', 'prompts']);
    if (!jobs[tabId] && !prompts[tabId]) return;
    delete jobs[tabId];
    delete prompts[tabId];
    await chrome.storage.session.set({ jobs, prompts });
  });
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
  // Finish before Chrome's 30 s service worker fetch-response deadline. The
  // extension pages handle port disconnects if Chrome still stops the worker.
  const signal = AbortSignal.timeout(API_TIMEOUT_MS);
  const timedOut = e => e?.name === 'TimeoutError';
  let response;
  try {
    response = await fetch(req.url, { method: 'POST', headers: req.headers, body: JSON.stringify(req.body), signal });
  } catch (e) {
    return { ok: false, error: timedOut(e) ? API_TIMEOUT_ERROR : JN.describeApiError(0) };
  }
  if (!response.ok) {
    return { ok: false, error: JN.describeApiError(response.status, await response.json().catch(() => null)) };
  }
  try {
    // threshold (normalized, 0-1) lets the overlay name it without reading storage.
    return { ok: true, result: JN.parseResponse(await response.json(), friends, settings.threshold), threshold: settings.threshold };
  } catch (e) {
    return { ok: false, error: timedOut(e) ? API_TIMEOUT_ERROR : JN.ERRORS[e.code] || JN.ERRORS.incomplete };
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
  // The host page closed the frame (Escape, or the overlay never confirmed).
  // Closing is always safe, so this needs no auto-detect check.
  if (msg.type === 'OVERLAY_DISMISSED') {
    await dropPrompt(sender.tab.id, sender.documentId);
    return { ok: true };
  }
  const isCurrent = currentDocument(sender.tab.id);
  if (!(await getSettings()).autoDetect) return { off: true };
  if (msg.type === 'JOB_SEEN') {
    await rememberJob(sender, msg, isCurrent);
    return { ok: true };
  }
  return { show: await offerPrompt(sender, isCurrent) };
}

function isOverlayFrame(sender) {
  return sender.tab && sender.frameId > 0 && /^chrome-extension:\/\/[^/]+\/overlay\.html$/.test(sender.url) &&
    (!sender.documentLifecycle || sender.documentLifecycle === 'active');
}

function ownsPrompt(prompt, sender) {
  return prompt && prompt.overlayFrameId === sender.frameId && prompt.overlayDocumentId === sender.documentId;
}

// The first overlay that loads state for the prompt owns readiness, analysis
// and closing. Browser-supplied IDs survive service worker restarts in session storage.
function onOverlayMessage(msg, sender) {
  const { tab } = sender;
  const isCurrent = currentDocument(tab.id);
  return inSession(async () => {
    const { prompts = {} } = await chrome.storage.session.get('prompts');
    const prompt = isCurrent() ? readPrompt(prompts, tab) : null;
    if (msg.type === 'OVERLAY_STATE') {
      if (!prompt || (prompt.overlayFrameId && !ownsPrompt(prompt, sender))) return { state: 'none' };
      const settings = await getSettings();
      if (!settings.autoDetect || !isCurrent()) return { state: 'none' };
      prompt.overlayFrameId = sender.frameId;
      prompt.overlayDocumentId = sender.documentId;
      await chrome.storage.session.set({ prompts });
      if (!isCurrent()) return { state: 'none' };
      return { state: 'prompt', posting: JN.postingLabel(prompt), hasKey: !!settings.apiKey };
    }
    if (!ownsPrompt(prompt, sender)) return { ok: false };
    const target = prompt.contentDocumentId ? { documentId: prompt.contentDocumentId } : { frameId: 0 };
    if (msg.type === 'OVERLAY_READY') {
      await chrome.tabs.sendMessage(tab.id, { type: 'OVERLAY_READY' }, target).catch(() => {});
    } else {
      delete prompts[tab.id];
      await chrome.storage.session.set({ prompts });
      await chrome.tabs.sendMessage(tab.id, { type: 'CLOSE_OVERLAY' }, target).catch(() => {});
    }
    return { ok: true };
  });
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  let reply;
  if (JN.isValidContentMessage(msg, sender, chrome.runtime.id)) {
    reply = onContentMessage(msg, sender);
  } else if (JN.isExtensionPage(sender, chrome.runtime.id) && isOverlayFrame(sender) && ['OVERLAY_STATE', 'OVERLAY_READY', 'OVERLAY_CLOSE'].includes(msg?.type)) {
    reply = onOverlayMessage(msg, sender);
  } else {
    return false;
  }
  reply.then(sendResponse, () => sendResponse(undefined));
  return true;
});

// The port returns the analysis result or notifies the caller if the worker restarts.
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
    } else if (msg?.type === 'ANALYZE_TAB' && isOverlayFrame(sender)) {
      const isCurrent = currentDocument(sender.tab.id);
      const prompt = await inSession(async () => {
        const { prompts = {} } = await chrome.storage.session.get('prompts');
        const current = readPrompt(prompts, sender.tab);
        if (!isCurrent() || !ownsPrompt(current, sender)) return null;
        const { autoDetect } = await getSettings();
        return autoDetect && isCurrent() ? current : null;
      });
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
