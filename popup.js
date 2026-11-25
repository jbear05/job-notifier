// Popup (spec Design: Popup). Opening it never calls Claude: it reads the active
// tab through activeTab + scripting (criterion 5) and waits for a click.

const $ = id => document.getElementById(id);
const HELP = "The first 8,000 characters are sent to Claude, with your included friends' names, skills, interests, and level.";
let threshold = JN.DEFAULT_SETTINGS.threshold;
let input = null; // the last input state, so Edit text can return to it
let moveFocus = false; // after the first click, each new state's heading takes focus

document.addEventListener('DOMContentLoaded', init);

async function init() {
  $('settings-btn').addEventListener('click', () => openSettings());
  initAutoDetect();

  const { settings, friends } = await chrome.storage.local.get(['settings', 'friends']);
  const s = JN.normalizeSettings(settings);
  threshold = s.threshold;
  if (!s.apiKey) return showSetup();
  const status = JN.friendsStatus(JN.storedFriends(friends));
  if (status !== 'ok') return showNoFriends(status);
  readPage();
}

function show(title, nodes, error = false) {
  const heading = h('h2', { tabindex: '-1' }, title);
  $('panel').replaceChildren(h('div', { class: error ? 'stack error-block' : 'stack' }, heading, ...nodes));
  if (moveFocus) heading.focus();
}

// ── States ──

function showSetup() {
  show('Set up Job Notifier', [
    h('p', null, "Job Notifier drafts messages to friends who'd fit a job posting. It uses your own Anthropic API key, so you pay Anthropic directly for each analysis. Add your key and at least one friend to start."),
    row(btn('Open settings', () => openSettings(), 'primary')),
  ]);
}

function showNoFriends(status) {
  const [title, body] = COPY[status] || COPY.empty;
  const action = status === 'none-included'
    ? btn('Open settings', () => openSettings(), 'primary')
    : btn('Add friends', () => openSettings('friends'), 'primary');
  show(title, [h('p', null, body), row(action)]);
}

async function readPage() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true }).catch(() => []);
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
    return showInput('Paste a job posting', "Couldn't read this page. Reload it and open Job Notifier again, or paste the posting text below.");
  }
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
  show(title, [
    h('p', null, body),
    h('div', { class: 'field' },
      h('label', { class: 'label', for: 'posting' }, 'Posting text'),
      h('p', { id: 'posting-help', class: 'small muted' }, HELP),
      box, error),
    row(btn('Find friends', find, 'primary')),
  ]);
}

async function analyze(jobText) {
  moveFocus = true;
  input.text = jobText;
  show(COPY.loading[0], [loadingView()]);
  const reply = await analyzeRequest({ type: 'ANALYZE_JOB', jobText });
  if (reply.ok) return showResult(reply.result);
  if (reply.code === 'NO_API_KEY') return showSetup();
  if (reply.code === 'NO_FRIENDS') return showNoFriends(reply.friends);
  showError(reply.error || JN.ERRORS.incomplete, () => analyze(jobText));
}

function showResult(result) {
  const n = result.matches.length;
  if (!n) return show('No strong matches', noMatchesView(result.job, threshold));
  show(resultsHeading(n), resultsView(result));
}

function showError(error, retry) {
  show(error.title, [
    h('p', null, error.body),
    row(...errorActions(error.action, retry), btn('Edit text', () => showInput(input.title, input.body, input.text))),
  ], true);
}

// ── Auto-detect switch (engineer A's contract; criteria 7, 36) ──
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
