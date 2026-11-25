// The confirmation prompt and results, in the frame content.js adds to a tab
// (spec Design: Confirmation prompt and results overlay). Its only input is the
// service worker's replies for this tab (engineer A's contract): it never reads
// its own address, the host page, or window messages (criteria 30, 31).

const $ = id => document.getElementById(id);
const heading = $('state-heading');
let state = 'none';
let posting = null;
let recheck = false; // the shown state sent the user to settings; ask the worker again when they come back

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
  let reply;
  try {
    reply = await chrome.runtime.sendMessage({ type: 'OVERLAY_STATE' });
  } catch (e) {
    reply = null;
  }
  if (!reply || reply.state !== 'prompt') return close();
  posting = reply.posting;
  $('scrim').hidden = false;
  $('dialog').hidden = false;
  showPrompt(reply.hasKey);
  // The host frame remains noninteractive until this prompt is in the DOM.
  await chrome.runtime.sendMessage({ type: 'OVERLAY_READY' }).catch(() => {});
  if (state === 'prompt') heading.focus();
}

function showPrompt(hasKey) {
  recheck = !hasKey;
  show('prompt', 'Find friends for this job?', [
    h('div', { class: 'posting' },
      h('p', { class: 'posting-title' }, posting.title),
      h('p', { class: 'small muted' }, posting.meta)),
    h('p', { id: 'prompt-body' }, hasKey
      ? "Job Notifier will send this posting's text and your included friends' names, skills, interests, and level to Claude. It's billed to your Anthropic API key."
      : 'Add your Anthropic API key in settings first. Job Notifier needs it to match this posting to your friends.'),
    row(
      hasKey ? btn('Find friends', analyze, 'primary') : btn('Open settings', () => openSettings(), 'primary'),
      btn('Not now', close)),
  ], { describe: true });
}

function showNoFriends(status) {
  recheck = true;
  const [title, body] = COPY[status] || COPY.empty;
  show('no-friends', title, [h('p', null, body), row(btn('Open settings', () => openSettings('friends'), 'primary'))]);
}

// Find friends and Try again. No job text is sent; the worker uses the posting it recorded for this tab.
async function analyze() {
  recheck = false;
  show('loading', COPY.loading[0], [loadingView()]);
  const reply = await analyzeRequest({ type: 'ANALYZE_TAB' }, 90000);
  if (reply.ok) return showResult(reply.result, reply.threshold);
  if (reply.code === 'NO_API_KEY') return showPrompt(false);
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
// A stray click can't throw away edited drafts: the scrim doesn't close results.
$('scrim').addEventListener('click', () => {
  if (state !== 'results') close();
});
document.addEventListener('visibilitychange', () => {
  if (recheck && document.visibilityState === 'visible') {
    recheck = false;
    load();
  }
});

load();
