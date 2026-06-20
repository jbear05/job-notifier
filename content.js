let capturedJobText = null;
let overlayShown = false;
let currentMatches = [];
let currentJob = null;
let checkTimer = null;
let lastUrl = location.href;

const CONFIRMATION_PATTERNS = [
  /application\s+submitted/i,
  /application\s+received/i,
  /thanks?\s+for\s+appl/i,
  /thank\s+you\s+for\s+appl/i,
  /successfully\s+applied/i,
  /application\s+(is\s+)?complete/i,
  /your\s+application\s+has\s+been/i,
  /we\s+received\s+your\s+application/i,
  /you'?ve?\s+(now\s+)?applied/i,
  /application\s+was\s+sent/i,
];

const JOB_SIGNALS = [
  /\b(job|position|role|opening|opportunity)\b/i,
  /\b(responsibilities|qualifications|requirements|about the role)\b/i,
  /\b(apply|application|candidates)\b/i,
  /\b(salary|compensation|benefits|equity)\b/i,
  /\b(full.?time|part.?time|contract|internship|remote|hybrid|on.?site)\b/i,
  /\b(experience|years|skills|proficiency)\b/i,
];

function extractPageText() {
  const clone = document.body.cloneNode(true);
  clone.querySelectorAll('script, style, nav, footer, header').forEach(el => el.remove());
  return (clone.innerText || clone.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 8000);
}

function isJobPage(text) {
  if (text.length < 200) return false;
  return JOB_SIGNALS.filter(re => re.test(text)).length >= 2;
}

function isConfirmationPage(text) {
  return CONFIRMATION_PATTERNS.some(p => p.test(text));
}

function checkPage() {
  const text = extractPageText();

  if (isConfirmationPage(text) && !overlayShown) {
    chrome.storage.local.get('autoDetect', data => {
      if (data.autoDetect !== false) triggerAnalysis();
    });
    return;
  }

  if (isJobPage(text)) {
    capturedJobText = text;
    try { sessionStorage.setItem('__jn_jobText', text); } catch (e) {}
  }
}

async function triggerAnalysis() {
  if (overlayShown) return;
  overlayShown = true;

  let jobText = capturedJobText;
  if (!jobText) {
    try { jobText = sessionStorage.getItem('__jn_jobText'); } catch (e) {}
  }
  if (!jobText) jobText = extractPageText();

  showOverlayLoading();

  const port = chrome.runtime.connect({ name: 'analyze' });

  let responded = false;
  const timeout = setTimeout(() => {
    if (!responded) {
      port.disconnect();
      renderOverlayError('Request timed out. Please try again.');
    }
  }, 30000);

  port.onMessage.addListener(response => {
    clearTimeout(timeout);
    responded = true;
    port.disconnect();
    if (!response.ok) {
      renderOverlayError(response.error || 'Analysis failed.');
      return;
    }
    currentJob = response.result.job;
    currentMatches = response.result.matches || [];
    renderOverlayResults();
  });

  port.onDisconnect.addListener(() => {
    if (!responded) {
      clearTimeout(timeout);
      renderOverlayError(chrome.runtime.lastError?.message || 'Connection closed unexpectedly.');
    }
  });

  port.postMessage({ type: 'ANALYZE_JOB', jobText, config: CONFIG });
}

// ── Overlay ──

function esc(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

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
    #jn-modal * { box-sizing: border-box; margin: 0; padding: 0; }

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

    /* ── States ── */
    .jn-empty { text-align: center; color: #999; padding: 20px 0 8px; font-size: 13px; }
    .jn-error-wrap { display: flex; flex-direction: column; align-items: center; padding: 28px 0 16px; gap: 10px; }
    .jn-error-icon { font-size: 32px; }
    .jn-error-msg { color: #c0392b; font-size: 13px; text-align: center; line-height: 1.5; }
  `;
  document.head.appendChild(s);
}

function showOverlayLoading() {
  injectStyles();
  document.getElementById('jn-overlay')?.remove();

  const overlay = document.createElement('div');
  overlay.id = 'jn-overlay';
  overlay.innerHTML = `
    <div id="jn-modal">
      <div class="jn-header">
        <div class="jn-header-left">
          <div class="jn-header-dot"></div>
          <div class="jn-header-text">
            <div class="jn-title">Job Notifier</div>
            <div class="jn-subtitle">Application detected</div>
          </div>
        </div>
        <button class="jn-close">&#x2715;</button>
      </div>
      <div class="jn-body">
        <div class="jn-loading">
          <div class="jn-spinner"></div>
          <div>
            <div class="jn-loading-label">Finding matches…</div>
            <div class="jn-loading-sub">Analyzing the job posting</div>
          </div>
        </div>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);
  overlay.querySelector('.jn-close').addEventListener('click', () => overlay.remove());
  overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove(); });
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
            <div class="jn-avatar">${esc(m.name[0].toUpperCase())}</div>
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

  const sendAllHtml = count
    ? `<button class="jn-send-all-btn">Send to all checked</button>`
    : '';

  const body = modal.querySelector('.jn-body');
  body.innerHTML = jobHtml + matchesHtml + sendAllHtml;

  body.querySelectorAll('.jn-message-box').forEach(ta => {
    ta.addEventListener('input', e => {
      currentMatches[parseInt(e.target.dataset.index)].message = e.target.value;
    });
  });

  body.querySelectorAll('.jn-send-btn').forEach(btn => {
    btn.addEventListener('click', e => {
      openMailto(currentMatches[parseInt(e.target.dataset.index)]);
      flashBtn(e.target, 'Opened!');
    });
  });

  body.querySelectorAll('.jn-copy-btn').forEach(btn => {
    btn.addEventListener('click', async e => {
      await navigator.clipboard.writeText(currentMatches[parseInt(e.target.dataset.index)].message).catch(() => {});
      flashBtn(e.target, 'Copied!');
    });
  });

  body.querySelector('.jn-send-all-btn')?.addEventListener('click', e => {
    body.querySelectorAll('.jn-checkbox:checked').forEach(cb => {
      openMailto(currentMatches[parseInt(cb.dataset.index)]);
    });
    flashBtn(e.target, 'All opened!');
  });
}

function renderOverlayError(msg) {
  const modal = document.getElementById('jn-modal');
  if (!modal) return;
  const body = modal.querySelector('.jn-body');
  if (body) {
    body.innerHTML = `
      <div class="jn-error-wrap">
        <div class="jn-error-icon">⚠️</div>
        <div class="jn-error-msg">${esc(msg)}</div>
      </div>
    `;
  }
}

function openMailto(match) {
  const subject = currentJob?.title && currentJob?.company
    ? `Job opportunity: ${currentJob.title} at ${currentJob.company}`
    : 'Job opportunity';
  window.open(`mailto:${encodeURIComponent(match.contact || '')}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(match.message)}`);
}

function flashBtn(btn, label) {
  const orig = btn.textContent;
  btn.textContent = label;
  btn.disabled = true;
  setTimeout(() => { btn.textContent = orig; btn.disabled = false; }, 1500);
}

// ── Message handler (keeps popup working) ──

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type !== 'GET_PAGE_TEXT') return;
  const text = extractPageText().slice(0, 3000);
  sendResponse({ text, isJobPage: isJobPage(text), length: text.length });
  return true;
});

// ── Init ──

function startWatching() {
  checkPage();

  const observer = new MutationObserver(() => {
    // Handle SPA URL changes
    if (location.href !== lastUrl) {
      lastUrl = location.href;
      overlayShown = false;
      capturedJobText = null;
    }

    if (overlayShown) return;
    clearTimeout(checkTimer);
    checkTimer = setTimeout(checkPage, 600);
  });

  observer.observe(document.body, { subtree: true, childList: true });
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', startWatching);
} else {
  startWatching();
}
