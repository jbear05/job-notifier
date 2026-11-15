importScripts('lib/core.js');

// ── Settings & friends (stored in chrome.storage.local, set on the options page) ──

async function getSettings() {
  const data = await chrome.storage.local.get(['settings', 'autoDetect']);
  const settings = { ...JN.DEFAULT_SETTINGS, ...(data.settings || {}) };
  if (typeof data.autoDetect === 'boolean') settings.autoDetect = data.autoDetect;
  return settings;
}

async function getFriends() {
  const { friends } = await chrome.storage.local.get('friends');
  if (Array.isArray(friends)) return friends;
  // First run: fall back to the bundled example list.
  try {
    const resp = await fetch(chrome.runtime.getURL('friends.json'));
    return await resp.json();
  } catch (e) {
    return [];
  }
}

// ── Recently viewed job postings ──
// Kept in chrome.storage.session: memory only, never readable by web pages,
// and cleared when the browser closes. Keyed by tab so a posting survives
// cross-site hops (e.g. LinkedIn → Workday) within the same tab.

async function rememberJob(tabId, text, url) {
  const entry = { text: text.slice(0, JN.MAX_JOB_TEXT), url, seenAt: Date.now(), hash: JN.hashText(text) };
  const { jobs = {} } = await chrome.storage.session.get('jobs');
  jobs[tabId] = entry;
  await chrome.storage.session.set({ jobs, lastJob: entry });
}

async function recallJob(tabId) {
  const { jobs = {}, lastJob } = await chrome.storage.session.get(['jobs', 'lastJob']);
  if (JN.isFresh(jobs[tabId])) return jobs[tabId];
  // Some ATS flows open the confirmation in a new tab or window.
  if (JN.isFresh(lastJob)) return lastJob;
  return null;
}

async function markAnalyzed(hash) {
  const { analyzed = [] } = await chrome.storage.session.get('analyzed');
  if (!analyzed.includes(hash)) analyzed.push(hash);
  await chrome.storage.session.set({ analyzed: analyzed.slice(-100) });
}

async function wasAnalyzed(hash) {
  const { analyzed = [] } = await chrome.storage.session.get('analyzed');
  return analyzed.includes(hash);
}

chrome.tabs.onRemoved.addListener(async tabId => {
  const { jobs = {} } = await chrome.storage.session.get('jobs');
  if (jobs[tabId]) {
    delete jobs[tabId];
    await chrome.storage.session.set({ jobs });
  }
});

// ── Claude ──

async function analyze(jobText) {
  const settings = await getSettings();
  if (!settings.apiKey) throw new Error('NO_API_KEY');
  const friends = await getFriends();
  if (!JN.activeFriends(friends).length) throw new Error('Your friends list is empty. Add friends on the settings page.');

  const req = JN.buildRequest(jobText, friends, settings);
  const response = await fetch(req.url, { method: 'POST', headers: req.headers, body: JSON.stringify(req.body) });
  if (!response.ok) {
    const err = await response.json().catch(() => ({}));
    throw new Error(err.error?.message || `API error ${response.status}`);
  }
  return JN.parseResponse(await response.json(), friends, settings.threshold);
}

// ── Messaging ──

chrome.runtime.onInstalled.addListener(details => {
  if (details.reason === 'install') chrome.runtime.openOptionsPage();
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'JOB_SEEN' && sender.tab) {
    rememberJob(sender.tab.id, msg.text, sender.tab.url).then(() => sendResponse({ ok: true }));
    return true;
  }
  if (msg.type === 'OPEN_OPTIONS') {
    chrome.runtime.openOptionsPage();
    return false;
  }
  return false;
});

// A long-lived port keeps the service worker alive for the whole API call.
chrome.runtime.onConnect.addListener(port => {
  if (port.name !== 'analyze') return;

  port.onMessage.addListener(async msg => {
    try {
      let jobText = msg.jobText;

      if (msg.type === 'AUTO_ANALYZE') {
        // Fired by a confirmation page. Only proceed if auto-detect is on and
        // we actually saw a job posting recently that hasn't been analyzed.
        const settings = await getSettings();
        if (!settings.autoDetect) return port.postMessage({ ok: false, skip: true });
        const job = await recallJob(port.sender?.tab?.id);
        if (!job || await wasAnalyzed(job.hash)) return port.postMessage({ ok: false, skip: true });
        jobText = job.text;
        await markAnalyzed(job.hash);
        port.postMessage({ started: true });
      } else if (msg.type !== 'ANALYZE_JOB') {
        return;
      }

      const result = await analyze(jobText);
      port.postMessage({ ok: true, result });
    } catch (e) {
      port.postMessage({ ok: false, error: e.message });
    }
  });
});
