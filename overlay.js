// The confirmation prompt and results, in the frame content.js adds to a tab
// (spec Design: Confirmation prompt and results overlay). Its only input is the
// service worker's replies for this tab: it never reads its own address, the
// host page, or window messages (criteria 30, 31).

const $ = id => document.getElementById(id);
const heading = $('state-heading');
let state = 'none';
let posting = null;
let recheck = false; // the shown state sent the user to settings; ask the worker again when they come back
let overlayEpoch = 0;
let requested = false; // Find friends was clicked; the scrim no longer closes (Design: Scrim clicks)

function show(name, title, nodes, { error = false, describe = false } = {}) {
  state = name;
  heading.textContent = title;
  $('panel-body').replaceChildren(h('div', { class: error ? 'stack error-block' : 'stack' }, ...nodes));
  $('panel-body').scrollTop = 0;
  if (describe) $('dialog').setAttribute('aria-describedby', 'prompt-body');
  else $('dialog').removeAttribute('aria-describedby');
  heading.focus();
}

// The worker clears this tab's state and has content.js remove the frame and
// return focus to the page.
function close() {
  chrome.runtime.sendMessage({ type: 'OVERLAY_CLOSE' }).catch(() => {});
}

async function load() {
  const myEpoch = overlayEpoch;
  let reply;
  try {
    reply = await chrome.runtime.sendMessage({ type: 'OVERLAY_STATE' });
  } catch (e) {
    reply = null;
  }
  if (myEpoch !== overlayEpoch) return;
  if (!reply || reply.state !== 'prompt') return close();
  posting = reply.posting;
  $('scrim').hidden = false;
  $('dialog').hidden = false;
  requested = false;
  showPrompt(reply.vaultState || 'unlocked', !!reply.hasKey);
  // The host frame remains noninteractive until this prompt is in the DOM.
  await chrome.runtime.sendMessage({ type: 'OVERLAY_READY' }).catch(() => {});
  if (state === 'prompt') heading.focus();
}

function postingBlock() {
  return h('div', { class: 'posting' },
    h('p', { class: 'posting-title' }, posting.title),
    h('p', { class: 'small muted' }, posting.meta));
}

function showPrompt(vaultState, hasKey) {
  let body;
  let primary;

  if (vaultState === 'uninitialized' || vaultState === 'needs-conversion') {
    recheck = true;
    body = "Set up Job Notifier in settings first. You'll create a passphrase, add your Anthropic API key, and add at least one friend.";
    primary = btn('Open settings', () => openSettings(), 'primary');
  } else if (vaultState === 'locked') {
    recheck = true;
    body = 'Your saved API key and friends list are locked. Open settings to unlock them, then return here to run the check.';
    primary = btn('Open settings to unlock', () => openSettings(), 'primary');
  } else if (vaultState === 'unreadable') {
    recheck = true;
    body = "Your saved data can't be read. Open settings to inspect or reset it.";
    primary = btn('Open settings', () => openSettings(), 'primary');
  } else if (!hasKey) {
    recheck = true;
    body = 'Add your Anthropic API key in settings first. Job Notifier needs it to match this posting to your friends.';
    primary = btn('Open settings', () => openSettings(), 'primary');
  } else {
    recheck = false;
    body = "Job Notifier will send this posting's text and your included friends' names, skills, interests, and level to Claude. It's billed to your Anthropic API key.";
    primary = btn('Find friends', analyze, 'primary');
  }

  show('prompt', 'Find friends for this job?', [
    postingBlock(),
    h('p', { id: 'prompt-body' }, body),
    row(primary, btn('Not now', close)),
  ], { describe: true });
}

function showLockedCleared() {
  overlayEpoch++;
  recheck = true;
  show('locked-cleared', 'Job Notifier is locked', [
    h('p', null, 'Your saved API key and friends list were locked, so any results were cleared. Open settings to unlock.'),
    row(btn('Open settings to unlock', () => openSettings(), 'primary'), btn('Close', close)),
  ]);
}

function showNoFriends(status) {
  recheck = true;
  const [title, body] = COPY[status] || COPY.empty;
  show('no-friends', title, [h('p', null, body), row(btn('Open settings', () => openSettings('friends'), 'primary'))]);
}

// Find friends and Try again. No job text is sent; the worker uses the posting it recorded for this tab.
async function analyze() {
  const myEpoch = overlayEpoch;
  recheck = false;
  requested = true;
  show('loading', COPY.loading[0], [loadingView()]);
  const reply = await analyzeRequest({ type: 'ANALYZE_TAB' }, 90000);
  if (myEpoch !== overlayEpoch) return;
  if (reply.ok) return showResult(reply.result, reply.threshold);
  if (reply.code === 'LOCKED') return showLockedCleared();
  if (reply.code === 'UNINITIALIZED' || reply.code === 'NEEDS_CONVERSION') return showPrompt('uninitialized', false);
  if (reply.code === 'UNREADABLE') return showPrompt('unreadable', false);
  if (reply.code === 'NO_API_KEY') return showPrompt('unlocked', false);
  if (reply.code === 'NO_FRIENDS') return showNoFriends(reply.friends);
  if (reply.code === 'NO_POSTING') return close();
  const error = reply.error || JN.ERRORS.incomplete;
  recheck = error.action === 'settings';
  show('error', error.title, [h('p', null, error.body), row(...errorActions(error.action, analyze))], { error: true });
}

// The worker sends the normalized threshold with the result, so this frame never reads storage (criterion 34).
function showResult(result, threshold) {
  const n = result.matches.length;
  if (n) return show('results', resultsHeading(n), resultsView(result));
  show('no-matches', 'No strong matches', noMatchesView(result.job, threshold));
}

// Tab and Shift+Tab wrap inside the panel; without this, Tab escapes into the host page.
function wrapTab(e) {
  const dialog = $('dialog');
  const items = [...dialog.querySelectorAll('a[href], button, input, select, textarea')]
    .filter(el => el.tabIndex >= 0 && el.getClientRects().length);
  if (!items.length) return e.preventDefault();
  const active = document.activeElement;
  const side = e.shiftKey ? Node.DOCUMENT_POSITION_PRECEDING : Node.DOCUMENT_POSITION_FOLLOWING;
  const rest = dialog.contains(active) ? items.filter(el => active.compareDocumentPosition(el) & side) : [];
  if (!rest.length) {
    e.preventDefault();
    (e.shiftKey ? items[items.length - 1] : items[0]).focus();
  }
}

document.addEventListener('keydown', e => {
  if (e.key === 'Escape') {
    e.preventDefault();
    close();
  } else if (e.key === 'Tab') {
    wrapTab(e);
  }
});
$('close-btn').addEventListener('click', close);
// The scrim closes only the prompt before Find friends: after that a stray click
// (such as a double-click's second) can't throw away a request, Try again, or drafts.
// A click that does nothing leaves focus where it was.
$('scrim').addEventListener('mousedown', e => e.preventDefault());
$('scrim').addEventListener('click', () => {
  if (state === 'prompt' && !requested) close();
});
document.addEventListener('visibilitychange', () => {
  if (recheck && document.visibilityState === 'visible') {
    recheck = false;
    load();
  }
});
chrome.runtime.onMessage.addListener(msg => {
  if (msg?.type === 'VAULT_LOCKED' && state !== 'none') {
    showLockedCleared();
  } else if (msg?.type === 'VAULT_CHANGED' && recheck && document.visibilityState === 'visible') {
    recheck = false;
    load();
  }
});

load();
