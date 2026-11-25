// Content script: runs on every page, but only reads visible text locally.
// Page text is sent to the extension only when it looks like a job posting,
// and Claude is only called on a confirmation page that follows one.

let overlayShown = false;
let currentMatches = [];
let currentJob = null;
let recruiterUrl = ''; // optional, local only: never sent to Claude
let checkTimer = null;
let lastUrl = location.href;
let lastReportedHash = null;

function isRendered(el) {
  if (!el) return false;
  if (el.checkVisibility) return el.checkVisibility({ opacityProperty: true, visibilityProperty: true });
  return el.getClientRects().length > 0;
}

// Visible text only. innerText skips hidden descendants, but on an element
// that is itself hidden it falls back to all its text, so check that first.
// This keeps hidden "thanks for applying" templates from triggering anything.
function visibleText(el) {
  if (!isRendered(el)) return '';
  return JN.normalizeText(el.innerText || '');
}

// The posting itself, preferring the main content region over nav/sidebars.
function extractJobText() {
  const main = document.querySelector('main, [role="main"], article');
  const mainText = visibleText(main);
  const text = mainText.length >= 400 ? mainText : visibleText(document.body);
  return text.slice(0, JN.MAX_JOB_TEXT);
}

// Confirmation messages live in headings, dialogs, alerts, or the main area.
function confirmationVisible() {
  const candidates = document.querySelectorAll(
    'h1, h2, h3, [role="dialog"], [role="alert"], [role="status"], [aria-live], main, [role="main"]'
  );
  for (const el of candidates) {
    const text = visibleText(el);
    if (text.length <= 3000 && JN.isConfirmationText(text)) return true;
  }
  // Short pages (typical "thanks" screens) can be checked as a whole.
  const body = visibleText(document.body);
  return body.length <= 3000 && JN.isConfirmationText(body);
}

function checkPage() {
  if (overlayShown || !document.body) return;

  if (confirmationVisible()) {
    triggerAutoAnalysis();
    return;
  }

  const text = extractJobText();
  if (JN.isJobPage(text)) {
    const hash = JN.hashText(text);
    if (hash !== lastReportedHash) {
      lastReportedHash = hash;
      chrome.runtime.sendMessage({ type: 'JOB_SEEN', text }).catch(() => {});
    }
  }
}

function triggerAutoAnalysis() {
  if (overlayShown) return;
  overlayShown = true;

  let port;
  try {
    port = chrome.runtime.connect({ name: 'analyze' });
  } catch (e) {
    return; // extension was reloaded; this page's script is stale
  }

  let done = false;
  let timeout = null;

  port.onMessage.addListener(response => {
    if (response.skip) {
      done = true;
      port.disconnect();
      return; // nothing to do; leave overlayShown set so we don't re-ask
    }
    if (response.started) {
      showOverlayLoading();
      timeout = setTimeout(() => {
        if (!done) {
          done = true;
          port.disconnect();
          renderOverlayError('Request timed out. Please try again from the extension popup.');
        }
      }, 90000);
      return;
    }
    done = true;
    clearTimeout(timeout);
    port.disconnect();
    if (!response.ok) {
      if (response.error === 'NO_API_KEY') renderSetupNeeded();
      else renderOverlayError(response.error || 'Analysis failed.');
      return;
    }
    currentJob = response.result.job;
    currentMatches = response.result.matches || [];
    recruiterUrl = '';
    renderOverlayResults();
  });

  port.onDisconnect.addListener(() => {
    if (!done) {
      done = true;
      clearTimeout(timeout);
      renderOverlayError('Connection closed unexpectedly. Try again from the extension popup.');
    }
  });

  port.postMessage({ type: 'AUTO_ANALYZE' });
}

// ── Overlay ──

const esc = JN.escHtml;

function injectStyles() {
  if (document.getElementById('jn-styles')) return;
  const s = document.createElement('style');
  s.id = 'jn-styles';
  s.textContent = `
    @keyframes jn-fade-in { from { opacity: 0 } to { opacity: 1 } }
    @keyframes jn-slide-up {
      from { opacity: 0; transform: scale(0.96) translateY(10px); }
      to   { opacity: 1; transform: scale(1)    translateY(0); }
    }
    @keyframes jn-spin { to { transform: rotate(360deg); } }

    #jn-overlay {
      position: fixed; inset: 0;
      background: rgba(10, 10, 20, 0.55);
      backdrop-filter: blur(6px);
      -webkit-backdrop-filter: blur(6px);
      z-index: 2147483647;
      display: flex; align-items: center; justify-content: center;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      font-size: 13px; color: #111;
      animation: jn-fade-in 0.2s ease;
    }
    #jn-modal {
      background: #fff;
      border-radius: 18px;
      width: 440px;
      max-height: 84vh;
      display: flex;
      flex-direction: column;
      box-shadow: 0 24px 64px rgba(0,0,0,0.28), 0 0 0 1px rgba(0,0,0,0.06);
      animation: jn-slide-up 0.28s cubic-bezier(0.34, 1.4, 0.64, 1);
    }
    /* Zero specificity so the jn- classes below can set their own spacing. */
    :where(#jn-modal *) { box-sizing: border-box; margin: 0; padding: 0; }

    /* ── Header ── */
    .jn-header {
      background: #fff;
      border-radius: 18px 18px 0 0;
      padding: 16px 20px 14px;
      display: flex; align-items: center; justify-content: space-between;
      flex-shrink: 0;
      border-bottom: 1px solid #f0f0f0;
    }
    .jn-header-left { display: flex; align-items: center; gap: 10px; }
    .jn-header-dot {
      width: 8px; height: 8px; border-radius: 50%;
      background: linear-gradient(135deg, #5b5bd6, #7c3aed);
      flex-shrink: 0;
    }
    .jn-header-text { display: flex; flex-direction: column; gap: 1px; }
    .jn-title { font-weight: 700; font-size: 14px; color: #111; letter-spacing: -0.2px; }
    .jn-subtitle { font-size: 11.5px; color: #888; }
    .jn-close {
      background: #f4f4f4; border: none; color: #555;
      width: 28px; height: 28px; border-radius: 50%; cursor: pointer;
      font-size: 15px; line-height: 1;
      display: flex; align-items: center; justify-content: center;
      transition: background 0.15s, color 0.15s; flex-shrink: 0;
    }
    .jn-close:hover { background: #e8e8e8; color: #111; }

    /* ── Scrollable body ── */
    .jn-body {
      overflow-y: auto; padding: 18px 20px 20px; flex: 1;
    }
    .jn-body::-webkit-scrollbar { width: 5px; }
    .jn-body::-webkit-scrollbar-track { background: transparent; }
    .jn-body::-webkit-scrollbar-thumb { background: #e0e0e0; border-radius: 4px; }

    /* ── Loading ── */
    .jn-loading {
      display: flex; flex-direction: column; align-items: center;
      padding: 32px 0 24px; gap: 14px;
    }
    .jn-spinner {
      width: 28px; height: 28px;
      border: 2.5px solid #ebebff; border-top-color: #5b5bd6;
      border-radius: 50%; animation: jn-spin 0.75s linear infinite;
    }
    .jn-loading-label { color: #444; font-size: 14px; font-weight: 500; }
    .jn-loading-sub { color: #999; font-size: 12px; margin-top: 3px; text-align: center; }

    /* ── Job card ── */
    .jn-job-card {
      background: linear-gradient(135deg, #f8f7ff, #f2f0ff);
      border: 1px solid #e2e0f8; border-radius: 12px;
      padding: 14px 16px; margin-bottom: 16px;
    }
    .jn-job-title { font-size: 14px; font-weight: 700; margin-bottom: 6px; color: #111; }
    .jn-job-meta { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; margin-bottom: 8px; }
    .jn-company { color: #555; font-size: 13px; }
    .jn-tag {
      background: #e8e8f5; color: #4a4a9a; border-radius: 6px;
      padding: 2px 8px; font-size: 11px; font-weight: 600; text-transform: capitalize;
    }
    .jn-tag-remote { background: #d1f5e0; color: #15622f; }
    .jn-location { color: #888; font-size: 11px; }
    .jn-skills { display: flex; flex-wrap: wrap; gap: 5px; }
    .jn-skill {
      background: #eeeeff; color: #3b3ba8; border-radius: 6px;
      padding: 3px 8px; font-size: 11px; font-weight: 500;
    }

    /* ── Match cards ── */
    .jn-match-card {
      background: #fafafa; border: 1.5px solid #f0f0f0; border-radius: 12px;
      padding: 14px 16px; margin-bottom: 10px;
      transition: border-color 0.15s, box-shadow 0.15s;
    }
    .jn-match-card:hover { border-color: #d8d8f5; box-shadow: 0 2px 10px rgba(91,91,214,0.08); }
    .jn-match-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 10px; }
    .jn-match-select { display: flex; align-items: center; gap: 10px; cursor: pointer; }
    .jn-match-select input[type="checkbox"] { width: 16px; height: 16px; accent-color: #5b5bd6; cursor: pointer; flex-shrink: 0; }
    .jn-avatar {
      width: 34px; height: 34px; border-radius: 50%; flex-shrink: 0;
      background: linear-gradient(135deg, #5b5bd6, #7c3aed);
      color: #fff; font-weight: 700; font-size: 13px;
      display: flex; align-items: center; justify-content: center;
    }
    .jn-match-name { font-weight: 600; font-size: 13px; color: #111; }
    .jn-match-score {
      font-size: 11px; font-weight: 700; color: #5b5bd6;
      background: #eeeeff; padding: 3px 9px; border-radius: 20px;
      white-space: nowrap;
    }
    .jn-message-box {
      width: 100%; border: 1.5px solid #ebebeb; border-radius: 8px;
      padding: 9px 11px; font-family: inherit; font-size: 12.5px;
      color: #222; line-height: 1.55; resize: vertical;
      background: #fff; outline: none; transition: border-color 0.15s;
    }
    .jn-message-box:focus { border-color: #5b5bd6; }
    .jn-card-actions { display: flex; gap: 8px; margin-top: 10px; }
    .jn-send-btn {
      flex: 1; padding: 8px 0; background: #5b5bd6; color: #fff;
      border: none; border-radius: 8px; font-size: 13px; font-weight: 600;
      cursor: pointer; transition: background 0.15s, transform 0.1s;
    }
    .jn-send-btn:hover { background: #4a4abf; }
    .jn-send-btn:active { transform: scale(0.98); }
    .jn-send-btn:disabled { opacity: 0.55; cursor: default; }
    .jn-copy-btn {
      padding: 8px 16px; background: transparent;
      border: 1.5px solid #e0e0e0; border-radius: 8px;
      font-size: 13px; font-weight: 500; cursor: pointer; color: #555;
      transition: border-color 0.15s, background 0.15s;
    }
    .jn-copy-btn:hover { border-color: #bbb; background: #f5f5f5; }
    .jn-copy-btn:disabled { opacity: 0.55; cursor: default; }

    /* ── Recruiter contact ── */
    .jn-recruiter {
      border: 1.5px dashed #e2e0f8; border-radius: 12px;
      padding: 12px 14px; margin-bottom: 14px;
    }
    .jn-recruiter-label { display: block; font-weight: 600; font-size: 12.5px; color: #333; margin-bottom: 2px; }
    .jn-recruiter-sub { color: #999; font-size: 11.5px; margin-bottom: 8px; }
    .jn-recruiter-input {
      width: 100%; border: 1.5px solid #ebebeb; border-radius: 8px;
      padding: 8px 10px; font-family: inherit; font-size: 12.5px; color: #222;
      background: #fff; outline: none; transition: border-color 0.15s;
    }
    .jn-recruiter-input:focus { border-color: #5b5bd6; }
    .jn-recruiter-input.jn-invalid { border-color: #e0a19a; }
    .jn-recruiter-status { font-size: 11.5px; margin-top: 6px; }
    .jn-recruiter-status:empty { display: none; }
    .jn-recruiter-status.jn-ok { color: #15622f; }
    .jn-recruiter-status.jn-bad { color: #c0392b; }

    /* ── Send all ── */
    .jn-send-all-btn {
      display: block; width: 100%; margin-top: 6px; padding: 12px;
      background: linear-gradient(135deg, #5b5bd6, #7c3aed);
      color: #fff; border: none; border-radius: 10px;
      font-size: 14px; font-weight: 700; cursor: pointer; letter-spacing: -0.2px;
      transition: opacity 0.15s, transform 0.1s;
    }
    .jn-send-all-btn:hover { opacity: 0.88; }
    .jn-send-all-btn:active { transform: scale(0.99); }
    .jn-send-all-btn:disabled { opacity: 0.55; cursor: default; }

    .jn-bulk-actions { display: flex; gap: 8px; margin-top: 6px; }
    .jn-bulk-actions .jn-send-all-btn { flex: 1; margin-top: 0; }
    .jn-bulk-actions .jn-copy-btn { white-space: nowrap; }
    .jn-hint { color: #999; font-size: 11.5px; text-align: center; margin-top: 8px; line-height: 1.4; }
    .jn-link-btn {
      margin-top: 4px; padding: 8px 14px; background: #5b5bd6; color: #fff;
      border: none; border-radius: 8px; font-size: 13px; font-weight: 600; cursor: pointer;
    }

    /* ── States ── */
    .jn-empty { text-align: center; color: #999; padding: 20px 0 8px; font-size: 13px; }
    .jn-error-wrap { display: flex; flex-direction: column; align-items: center; padding: 28px 0 16px; gap: 10px; }
    .jn-error-icon { font-size: 32px; }
    .jn-error-msg { color: #c0392b; font-size: 13px; text-align: center; line-height: 1.5; }
  `;
  document.head.appendChild(s);
}


function overlayShell(subtitle, bodyHtml) {
  injectStyles();
  document.getElementById('jn-overlay')?.remove();

  const overlay = document.createElement('div');
  overlay.id = 'jn-overlay';
  overlay.innerHTML = `
    <div id="jn-modal" role="dialog" aria-label="Job Notifier">
      <div class="jn-header">
        <div class="jn-header-left">
          <div class="jn-header-dot"></div>
          <div class="jn-header-text">
            <div class="jn-title">Job Notifier</div>
            <div class="jn-subtitle">${esc(subtitle)}</div>
          </div>
        </div>
        <button class="jn-close" aria-label="Close">&#x2715;</button>
      </div>
      <div class="jn-body">${bodyHtml}</div>
    </div>
  `;
  document.body.appendChild(overlay);
  overlay.querySelector('.jn-close').addEventListener('click', () => overlay.remove());
  overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove(); });
  return overlay;
}

function showOverlayLoading() {
  overlayShell('Application detected', `
    <div class="jn-loading">
      <div class="jn-spinner"></div>
      <div>
        <div class="jn-loading-label">Finding matches…</div>
        <div class="jn-loading-sub">Analyzing the job posting you just applied to</div>
      </div>
    </div>
  `);
}

function renderOverlayResults() {
  const modal = document.getElementById('jn-modal');
  if (!modal) return;

  const job = currentJob || {};
  const count = currentMatches.length;

  modal.querySelector('.jn-subtitle').textContent =
    count ? `${count} match${count > 1 ? 'es' : ''} found` : 'No matches found';

  const jobHtml = `
    <div class="jn-job-card">
      <div class="jn-job-title">${esc(job.title || 'Unknown title')}</div>
      <div class="jn-job-meta">
        <span class="jn-company">${esc(job.company || 'Unknown company')}</span>
        ${job.level ? `<span class="jn-tag">${esc(job.level)}</span>` : ''}
        ${job.remote ? `<span class="jn-tag jn-tag-remote">Remote</span>` : ''}
        ${job.location ? `<span class="jn-location">${esc(job.location)}</span>` : ''}
      </div>
      ${job.skills?.length ? `<div class="jn-skills">${job.skills.map(s => `<span class="jn-skill">${esc(s)}</span>`).join('')}</div>` : ''}
    </div>
  `;

  const matchesHtml = count
    ? currentMatches.map((m, i) => `
      <div class="jn-match-card">
        <div class="jn-match-header">
          <label class="jn-match-select">
            <input type="checkbox" class="jn-checkbox" data-index="${i}" checked>
            <div class="jn-avatar">${esc((m.name || '?')[0].toUpperCase())}</div>
            <span class="jn-match-name">${esc(m.name)}</span>
          </label>
          <span class="jn-match-score">${Math.round(m.score * 100)}% match</span>
        </div>
        <textarea class="jn-message-box" rows="3" data-index="${i}">${esc(m.message)}</textarea>
        <div class="jn-card-actions">
          <button class="jn-send-btn" data-index="${i}">Send email</button>
          <button class="jn-copy-btn" data-index="${i}">Copy</button>
        </div>
      </div>
    `).join('')
    : `<div class="jn-empty">No strong matches for this posting.</div>`;

  const recruiterHtml = count
    ? `<div class="jn-recruiter">
         <label class="jn-recruiter-label" for="jn-recruiter-input">Do you have a recruiter contact for this position?</label>
         <div class="jn-recruiter-sub">Optional. Paste their LinkedIn and it's added to each email and to Copy all.</div>
         <input id="jn-recruiter-input" class="jn-recruiter-input" type="url" inputmode="url" autocomplete="off"
                placeholder="https://www.linkedin.com/in/…" value="${esc(recruiterUrl)}">
         <div class="jn-recruiter-status" aria-live="polite"></div>
       </div>`
    : '';

  const bulkHtml = count > 1
    ? `<div class="jn-bulk-actions">
         <button class="jn-send-all-btn">Open next email</button>
         <button class="jn-copy-btn jn-copy-all-btn">Copy all</button>
       </div>
       <div class="jn-hint">Browsers only allow one email window per click, so this opens the checked emails one at a time.</div>`
    : '';

  const body = modal.querySelector('.jn-body');
  body.innerHTML = jobHtml + recruiterHtml + matchesHtml + bulkHtml;

  const recruiterInput = body.querySelector('.jn-recruiter-input');
  const recruiterStatus = body.querySelector('.jn-recruiter-status');
  function updateRecruiter() {
    const raw = recruiterInput.value;
    const url = JN.normalizeRecruiterUrl(raw);
    recruiterUrl = url || '';
    const bad = url === null;
    recruiterInput.classList.toggle('jn-invalid', bad);
    recruiterStatus.className = `jn-recruiter-status ${bad ? 'jn-bad' : url ? 'jn-ok' : ''}`;
    recruiterStatus.textContent = bad
      ? "That doesn't look like a LinkedIn link, so it won't be included."
      : url ? 'Added to your emails.' : '';
  }
  recruiterInput?.addEventListener('input', updateRecruiter);
  if (recruiterInput) updateRecruiter();

  body.querySelectorAll('.jn-message-box').forEach(ta => {
    ta.addEventListener('input', e => {
      currentMatches[parseInt(e.target.dataset.index)].message = e.target.value;
    });
  });

  const sent = new Set();
  const sendAllBtn = body.querySelector('.jn-send-all-btn');

  function checkedIndexes() {
    return [...body.querySelectorAll('.jn-checkbox:checked')].map(cb => parseInt(cb.dataset.index));
  }
  function updateSendAll() {
    if (!sendAllBtn) return;
    const left = checkedIndexes().filter(i => !sent.has(i)).length;
    sendAllBtn.textContent = left ? `Open next email (${left} left)` : 'All checked emails opened';
    sendAllBtn.disabled = !left;
  }
  function send(i) {
    window.open(JN.mailtoUrl(currentMatches[i], currentJob, recruiterUrl));
    sent.add(i);
    updateSendAll();
  }

  body.querySelectorAll('.jn-send-btn').forEach(btn => {
    btn.addEventListener('click', e => {
      send(parseInt(e.target.dataset.index));
      flashBtn(e.target, 'Opened!');
    });
  });

  body.querySelectorAll('.jn-card-actions .jn-copy-btn').forEach(btn => {
    btn.addEventListener('click', async e => {
      const m = currentMatches[parseInt(e.target.dataset.index)];
      await navigator.clipboard.writeText(JN.withRecruiter(m.message, recruiterUrl)).catch(() => {});
      flashBtn(e.target, 'Copied!');
    });
  });

  body.querySelectorAll('.jn-checkbox').forEach(cb => cb.addEventListener('change', updateSendAll));

  sendAllBtn?.addEventListener('click', () => {
    const next = checkedIndexes().find(i => !sent.has(i));
    if (next !== undefined) send(next);
  });

  body.querySelector('.jn-copy-all-btn')?.addEventListener('click', async e => {
    const selected = checkedIndexes().map(i => currentMatches[i]);
    await navigator.clipboard.writeText(JN.combinedMessages(selected, currentJob, recruiterUrl)).catch(() => {});
    flashBtn(e.target, 'Copied!');
  });

  updateSendAll();
}

function renderOverlayError(msg) {
  const body = document.querySelector('#jn-modal .jn-body');
  if (!body) return;
  body.innerHTML = `
    <div class="jn-error-wrap">
      <div class="jn-error-icon">⚠️</div>
      <div class="jn-error-msg">${esc(msg)}</div>
    </div>
  `;
}

function renderSetupNeeded() {
  if (!document.getElementById('jn-modal')) overlayShell('Setup needed', '');
  const body = document.querySelector('#jn-modal .jn-body');
  body.innerHTML = `
    <div class="jn-error-wrap">
      <div class="jn-error-msg" style="color:#444">Add your Anthropic API key in the extension settings to get friend matches for jobs you apply to.</div>
      <button class="jn-link-btn">Open settings</button>
    </div>
  `;
  body.querySelector('.jn-link-btn').addEventListener('click', () => {
    chrome.runtime.sendMessage({ type: 'OPEN_OPTIONS' }).catch(() => {});
  });
}

function flashBtn(btn, label) {
  const orig = btn.textContent;
  btn.textContent = label;
  btn.disabled = true;
  setTimeout(() => { btn.textContent = orig; btn.disabled = false; }, 1500);
}

// ── Popup support ──

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type !== 'GET_PAGE_TEXT') return;
  const text = extractJobText();
  sendResponse({ text, isJobPage: JN.isJobPage(text) });
});

// ── Init ──

function startWatching() {
  checkPage();

  const observer = new MutationObserver(() => {
    // SPA navigation: reset per-page state.
    if (location.href !== lastUrl) {
      lastUrl = location.href;
      overlayShown = false;
    }
    if (overlayShown) return;
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
