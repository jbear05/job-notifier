// Popup (spec Design: Popup). Queries worker vault status before reading the active
// tab through activeTab + scripting (criterion 5) and waits for a click.

const $ = id => document.getElementById(id);
const HELP = "The first 8,000 characters are sent to Claude, with your included friends' names, skills, interests, and level.";
let input = null; // the last input state, so Edit text can return to it
let moveFocus = false; // after the first click or lock, each new state's heading takes focus
let popupEpoch = 0;
let panelKind = 'none';

document.addEventListener('DOMContentLoaded', init);

function init() {
  $('settings-btn').addEventListener('click', () => openSettings());
  $('popup-lock-btn').addEventListener('click', () => {
    lockPopup(true);
    chrome.runtime.sendMessage({ type: 'VAULT_LOCK' }).catch(() => {});
  });
  initAutoDetect();

  chrome.runtime.onMessage.addListener(msg => {
    if (msg?.type === 'VAULT_LOCKED') {
      const hadResultsOrLoading = panelKind === 'loading' || panelKind === 'results' || panelKind === 'no-matches';
      lockPopup(moveFocus || hadResultsOrLoading);
    } else if (msg?.type === 'VAULT_CHANGED') {
      popupEpoch++;
      input = null;
      refreshStatus();
    }
  });

  refreshStatus();
}

async function refreshStatus() {
  const myEpoch = popupEpoch;
  const status = await chrome.runtime.sendMessage({ type: 'POPUP_STATUS' }).catch(() => null);
  if (myEpoch !== popupEpoch) return;

  const vaultState = status?.vaultState || 'locked';
  $('popup-footer').hidden = vaultState !== 'unlocked';

  if (vaultState === 'uninitialized' || vaultState === 'needs-conversion') {
    return showVaultUninitialized();
  }
  if (vaultState === 'locked') {
    return showLocked();
  }
  if (vaultState === 'unreadable') {
    return showUnreadable();
  }
  if (!status.hasKey) return showSetup();
  if (status.friendsStatus !== 'ok') return showNoFriends(status.friendsStatus);
  readPage(myEpoch);
}

function show(kind, title, nodes, error = false) {
  panelKind = kind;
  const heading = h('h2', { tabindex: '-1' }, title);
  $('panel').replaceChildren(h('div', { class: error ? 'stack error-block' : 'stack' }, heading, ...nodes));
  if (moveFocus) heading.focus();
}

function lockPopup(focusHeading) {
  popupEpoch++;
  input = null;
  $('popup-footer').hidden = true;
  if (focusHeading) moveFocus = true;
  showLocked();
}

// ── States ──

function showVaultUninitialized() {
  show('uninitialized', 'Set up Job Notifier', [
    h('p', null, 'Job Notifier encrypts your Anthropic API key and friends list in this browser. Open settings to create a passphrase, add your key, and add at least one friend.'),
    row(btn('Open settings', () => openSettings(), 'primary')),
  ]);
}

function showLocked() {
  show('locked', 'Locked', [
    h('p', null, 'Unlock your saved API key and friends list in settings to analyze job postings.'),
    row(btn('Open settings to unlock', () => openSettings(), 'primary')),
  ]);
}

function showUnreadable() {
  show('unreadable', "Saved data can't be read", [
    h('p', null, "Your encrypted data couldn't be read. Open settings to inspect or reset it."),
    row(btn('Open settings', () => openSettings(), 'primary')),
  ]);
}

function showSetup() {
  show('setup', 'Set up Job Notifier', [
    h('p', null, "Job Notifier drafts messages to friends who'd fit a job posting. It uses your own Anthropic API key, so you pay Anthropic directly for each analysis. Add your key and at least one friend to start."),
    row(btn('Open settings', () => openSettings(), 'primary')),
  ]);
}

function showNoFriends(status) {
  const [title, body] = COPY[status] || COPY.empty;
  const action = status === 'none-included'
    ? btn('Open settings', () => openSettings(), 'primary')
    : btn('Add friends', () => openSettings('friends'), 'primary');
  show('no-friends', title, [h('p', null, body), row(action)]);
}

async function readPage(myEpoch) {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true }).catch(() => []);
  if (myEpoch !== popupEpoch) return;
  const url = (tab && tab.url) || '';
  // chrome:// pages, the Web Store, and other non-http(s) pages can't be scripted.
  if (!/^https?:/.test(url) || /^https:\/\/(chromewebstore\.google\.com|chrome\.google\.com\/webstore)\//.test(url)) {
    return showInput('Paste a job posting', "Chrome doesn't let extensions read this page. Paste the posting text below.");
  }
  let text = '';
  try {
    const target = { tabId: tab.id };
    await chrome.scripting.executeScript({ target, files: ['lib/core.js'] });
    [{ result: text }] = await chrome.scripting.executeScript({ target, func: () => JN.extractJobText(document) });
  } catch (e) {
    if (myEpoch !== popupEpoch) return;
    return showInput('Paste a job posting', "Couldn't read this page. Reload it and open Job Notifier again, or paste the posting text below.");
  }
  if (myEpoch !== popupEpoch) return;
  if (JN.isJobPage(text)) showInput('Job posting found', 'Check the text, then find friends who fit.', text);
  else showInput('Paste a job posting', "This page doesn't look like a job posting. Paste the posting text below.");
}

// Nothing gets focus here, so a stray Enter can't start a paid request.
function showInput(title, body, text = '') {
  input = { title, body, text };
  const box = h('textarea', { id: 'posting', rows: 8, 'aria-describedby': 'posting-help posting-error', value: text || '' });
  const error = h('p', { id: 'posting-error', class: 'small error-text' });
  const find = () => {
    const jobText = box.value.trim();
    if (jobText.length < 50) {
      box.setAttribute('aria-invalid', 'true');
      error.textContent = 'Paste more of the posting. Job Notifier needs at least 50 characters.';
      return box.focus();
    }
    analyze(jobText);
  };
  show('input', title, [
    h('p', null, body),
    h('div', { class: 'field' },
      h('label', { class: 'label', for: 'posting' }, 'Posting text'),
      h('p', { id: 'posting-help', class: 'small muted' }, HELP),
      box, error),
    row(btn('Find friends', find, 'primary')),
  ]);
}

async function analyze(jobText) {
  const myEpoch = popupEpoch;
  moveFocus = true;
  input.text = jobText;
  show('loading', COPY.loading[0], [loadingView()]);
  const reply = await analyzeRequest({ type: 'ANALYZE_JOB', jobText });
  if (myEpoch !== popupEpoch) return;
  if (reply.ok) return showResult(reply.result, reply.threshold);
  if (reply.code === 'LOCKED') return lockPopup(true);
  if (reply.code === 'UNINITIALIZED' || reply.code === 'NEEDS_CONVERSION') {
    $('popup-footer').hidden = true;
    return showVaultUninitialized();
  }
  if (reply.code === 'UNREADABLE') {
    $('popup-footer').hidden = true;
    return showUnreadable();
  }
  if (reply.code === 'NO_API_KEY') return showSetup();
  if (reply.code === 'NO_FRIENDS') return showNoFriends(reply.friends);
  showError(reply.error || JN.ERRORS.incomplete, () => analyze(jobText));
}

// threshold comes with the worker's reply: the setting that analysis actually used.
function showResult(result, threshold) {
  const n = result.matches.length;
  if (!n) return show('no-matches', 'No strong matches', noMatchesView(result.job, threshold));
  show('results', resultsHeading(n), resultsView(result));
}

function showError(error, retry) {
  show('error', error.title, [
    h('p', null, error.body),
    row(...errorActions(error.action, retry), btn('Edit text', () => showInput(input.title, input.body, input.text))),
  ], true);
}

// ── Auto-detect switch (criteria 7, 36) ──
// The worker drives registration from chrome.permissions events, because this
// popup can close while Chrome's permission dialog is open.

function initAutoDetect() {
  const toggle = $('auto-toggle');
  const panel = $('auto-panel');
  const say = text => { $('auto-status').textContent = text; };
  let access = false;

  const sync = async () => {
    const [{ autoDetect }, granted] = await Promise.all([
      chrome.storage.local.get('autoDetect'),
      chrome.permissions.contains({ origins: JN.ALL_SITES }),
    ]);
    access = granted;
    toggle.checked = autoDetect === true && granted;
  };
  sync();
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && 'autoDetect' in changes) sync();
  });
  chrome.permissions.onAdded.addListener(sync);
  chrome.permissions.onRemoved.addListener(sync);

  toggle.addEventListener('change', () => {
    if (!toggle.checked) {
      chrome.storage.local.set({ autoDetect: false });
      return say('Auto-detect is off.');
    }
    if (access) {
      chrome.storage.local.set({ autoDetect: true });
      return say('Auto-detect is on.');
    }
    // Explain before Chrome's prompt; the switch stays off until access is granted.
    toggle.checked = false;
    panel.hidden = false;
    $('auto-heading').focus();
  });

  $('auto-continue').addEventListener('click', async () => {
    const granted = await chrome.permissions.request({ origins: JN.ALL_SITES });
    if (granted) await chrome.storage.local.set({ autoDetect: true });
    toggle.checked = granted;
    panel.hidden = true;
    say(granted ? 'Auto-detect is on.' : "Chrome didn't grant site access, so auto-detect is still off.");
    toggle.focus();
  });
  $('auto-cancel').addEventListener('click', () => {
    panel.hidden = true;
    toggle.focus();
  });
}
