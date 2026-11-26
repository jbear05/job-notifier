// Content script, registered only while auto-detect is on. It reads visible
// text locally and does two things: reports pages that look like job postings,
// and on a confirmation page asks the extension whether to offer one. If so,
// it adds a frame with the extension's overlay page. Friend, draft, and posting
// data never pass through this script or the host page (criteria 8, 30, 31).

let asked = false; // already asked about a confirmation on this page
let stopped = false;
let frame = null;
let readyTimer = null;
let returnFocus = null;
const READY_TIMEOUT_MS = 5000;
let checkTimer = null;
let observer = null;
let lastUrl = location.href;
let lastReportedHash = null;

// Confirmation messages live in headings, dialogs, alerts, or the main area.
function confirmationVisible() {
  const candidates = document.querySelectorAll(
    'h1, h2, h3, [role="dialog"], [role="alert"], [role="status"], [aria-live], main, [role="main"]'
  );
  for (const el of candidates) {
    const text = JN.visibleText(el);
    if (text.length <= 3000 && JN.isConfirmationText(text)) return true;
  }
  // Short pages (typical "thanks" screens) can be checked as a whole.
  const body = JN.visibleText(document.body);
  return body.length <= 3000 && JN.isConfirmationText(body);
}

function send(msg) {
  return chrome.runtime.sendMessage(msg).then(reply => {
    if (reply?.off) stop();
    return reply;
  }).catch(() => {}); // the extension was reloaded; this page's script is stale
}

function checkPage() {
  if (stopped || asked || !document.body) return;

  if (confirmationVisible()) {
    asked = true;
    send({ type: 'CONFIRMATION_SEEN' }).then(reply => { if (reply?.show) showFrame(); });
    return;
  }

  const text = JN.extractJobText(document);
  if (JN.isJobPage(text)) {
    const hash = JN.hashText(text);
    if (hash !== lastReportedHash) {
      lastReportedHash = hash;
      send({ type: 'JOB_SEEN', text, title: document.title.slice(0, JN.MAX_TITLE) });
    }
  }
}

// ── Overlay frame ──
// The overlay page gets its state from the service worker for this tab. The
// frame's URL carries no data, and nothing is posted into it.

function showFrame() {
  if (frame || stopped) return;
  returnFocus = document.activeElement;
  frame = document.createElement('iframe');
  frame.title = 'Job Notifier';
  // The frame's document has the static extension origin, not the dynamic src host,
  // so the grant names it (walkthrough 10.3). Never clipboard-read.
  frame.allow = `clipboard-write chrome-extension://${chrome.runtime.id}`;
  frame.tabIndex = -1;
  const style = {
    position: 'fixed', inset: '0', width: '100%', height: '100%', 'max-width': 'none', 'max-height': 'none',
    margin: '0', padding: '0', border: '0', display: 'block', visibility: 'visible', opacity: '1',
    background: 'transparent', 'color-scheme': 'normal', 'z-index': '2147483647', 'pointer-events': 'none',
  };
  for (const [prop, value] of Object.entries(style)) frame.style.setProperty(prop, value, 'important');
  frame.src = chrome.runtime.getURL('overlay.html');
  // Let the host remain clickable until the rendered overlay acknowledges readiness.
  readyTimer = setTimeout(dismiss, READY_TIMEOUT_MS);
  window.addEventListener('keydown', onHostKeydown, true);
  document.documentElement.appendChild(frame);
}

// Escape reaches the host document only when focus has left the frame.
function onHostKeydown(e) {
  if (e.key === 'Escape') dismiss();
}

// Closed from the host side: also clear this tab's prompt. Closing is always
// safe, so a page faking Escape can only dismiss its own prompt.
function dismiss() {
  if (!frame) return;
  closeFrame();
  send({ type: 'OVERLAY_DISMISSED' });
}

function closeFrame() {
  if (!frame) return;
  clearTimeout(readyTimer);
  readyTimer = null;
  window.removeEventListener('keydown', onHostKeydown, true);
  frame.remove();
  frame = null;
  if (returnFocus?.isConnected && typeof returnFocus.focus === 'function') returnFocus.focus();
  returnFocus = null;
}

// Auto-detect was turned off: stop reading this page.
function stop() {
  stopped = true;
  observer?.disconnect();
  clearTimeout(checkTimer);
  closeFrame();
}

// Only the extension can send these: the service worker confirms the overlay is
// showing, closes the frame when the overlay asks, and stops this script when
// auto-detect is turned off. It also pings this document before using its prompt.
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (sender?.id !== chrome.runtime.id || sender.tab) return;
  if (msg?.type === 'DOCUMENT_PING') {
    sendResponse({ ok: true });
    return;
  }
  if (msg?.type === 'OVERLAY_READY' && frame && readyTimer !== null) {
    clearTimeout(readyTimer);
    readyTimer = null;
    frame.style.setProperty('pointer-events', 'auto', 'important');
    frame.focus();
  }
  if (msg?.type === 'CLOSE_OVERLAY') closeFrame();
  if (msg?.type === 'STOP') stop();
});

// ── Init ──

function startWatching() {
  checkPage();

  observer = new MutationObserver(() => {
    // Single-page app navigation: this is a new page for detection.
    if (location.href !== lastUrl) {
      lastUrl = location.href;
      asked = false;
    }
    if (asked) return;
    clearTimeout(checkTimer);
    checkTimer = setTimeout(checkPage, 1000);
  });

  observer.observe(document.body, { subtree: true, childList: true, characterData: true });
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', startWatching);
} else {
  startWatching();
}
