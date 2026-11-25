let currentMatches = [];
let currentJob = null;
let recruiterUrl = ""; // optional, local only: never sent to Claude

document.addEventListener("DOMContentLoaded", init);

async function init() {
  const toggle = document.getElementById("auto-toggle");
  const { autoDetect } = await chrome.storage.local.get("autoDetect");
  toggle.checked = autoDetect !== false;
  toggle.addEventListener("change", () => chrome.storage.local.set({ autoDetect: toggle.checked }));

  document.getElementById("settings-btn").addEventListener("click", () => chrome.runtime.openOptionsPage());
  document.getElementById("error-settings-btn").addEventListener("click", () => chrome.runtime.openOptionsPage());
  document.getElementById("manual-analyze-btn").addEventListener("click", onAnalyzeClick);
  document.getElementById("send-all-btn").addEventListener("click", sendNext);
  document.getElementById("copy-all-btn").addEventListener("click", copyAll);
  document.getElementById("recruiter-input").addEventListener("input", updateRecruiter);

  const { settings } = await chrome.storage.local.get("settings");
  if (!settings?.apiKey) {
    showError("Add your Anthropic API key in settings to get started.", true);
    return;
  }

  // Opening the popup never calls Claude by itself; it just pre-fills the
  // detected posting so you can review it and click the button.
  let tab;
  try {
    [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  } catch (e) {
    showInput("Paste the job posting text below:");
    return;
  }

  chrome.tabs.sendMessage(tab.id, { type: "GET_PAGE_TEXT" }, response => {
    if (chrome.runtime.lastError || !response) {
      showInput("Couldn't read this page. Paste the job posting text below:");
    } else if (response.isJobPage) {
      showInput("Found a job posting on this page. Check the text, then find matches:", response.text);
    } else {
      showInput("This doesn't look like a job posting. Paste the job text below:");
    }
  });
}

async function onAnalyzeClick() {
  const text = document.getElementById("manual-input").value.trim();
  if (text.length < 50) {
    document.getElementById("manual-error").textContent = "Please paste more text (at least 50 characters).";
    return;
  }
  document.getElementById("manual-error").textContent = "";
  showState("loading");

  try {
    const result = await analyzeViaBackground(text);
    currentJob = result.job;
    currentMatches = result.matches || [];
    renderResults();
  } catch (e) {
    if (e.message === "NO_API_KEY") showError("Add your Anthropic API key in settings to get started.", true);
    else showError(`Analysis failed: ${e.message}`);
  }
}

// All Claude calls go through the background worker, so there's one code path.
function analyzeViaBackground(jobText) {
  return new Promise((resolve, reject) => {
    const port = chrome.runtime.connect({ name: "analyze" });
    let done = false;
    port.onMessage.addListener(msg => {
      done = true;
      port.disconnect();
      msg.ok ? resolve(msg.result) : reject(new Error(msg.error || "Analysis failed."));
    });
    port.onDisconnect.addListener(() => {
      if (!done) reject(new Error("Connection closed unexpectedly."));
    });
    port.postMessage({ type: "ANALYZE_JOB", jobText });
  });
}

// ── Results ──

const sent = new Set();

function renderResults() {
  showState("results");
  sent.clear();
  const job = currentJob || {};
  const esc = JN.escHtml;

  document.getElementById("job-card").innerHTML = `
    <div class="job-title">${esc(job.title || "Unknown title")}</div>
    <div class="job-meta">
      <span>${esc(job.company || "Unknown company")}</span>
      ${job.level ? `<span class="tag">${esc(job.level)}</span>` : ""}
      ${job.remote ? `<span class="tag tag-remote">Remote</span>` : ""}
      ${job.location ? `<span class="tag-location">${esc(job.location)}</span>` : ""}
    </div>
    ${job.skills?.length ? `<div class="job-skills">${job.skills.map(s => `<span class="skill">${esc(s)}</span>`).join("")}</div>` : ""}
  `;

  const matchList = document.getElementById("match-list");
  const count = currentMatches.length;
  document.getElementById("empty-state").hidden = count > 0;
  document.getElementById("bulk-actions").hidden = count < 2;
  document.getElementById("bulk-hint").hidden = count < 2;
  document.getElementById("recruiter").hidden = count === 0;
  document.getElementById("recruiter-input").value = "";
  updateRecruiter();

  matchList.innerHTML = currentMatches.map((m, i) => `
    <div class="match-card" data-index="${i}">
      <div class="match-header">
        <label class="match-select">
          <input type="checkbox" class="friend-checkbox" data-index="${i}" checked>
          <span class="match-name">${esc(m.name)}</span>
        </label>
        <span class="match-score" title="Relevance score">${Math.round(m.score * 100)}% match</span>
      </div>
      <textarea class="message-box" rows="4" data-index="${i}">${esc(m.message)}</textarea>
      <div class="card-actions">
        <button class="send-btn" data-index="${i}">Send</button>
        <button class="copy-btn" data-index="${i}">Copy</button>
      </div>
    </div>
  `).join("");

  matchList.querySelectorAll("textarea").forEach(ta => {
    ta.addEventListener("input", e => {
      currentMatches[parseInt(e.target.dataset.index)].message = e.target.value;
    });
  });
  matchList.querySelectorAll(".send-btn").forEach(btn => {
    btn.addEventListener("click", e => {
      send(parseInt(e.target.dataset.index));
      flashButton(e.target, "Opened!");
    });
  });
  matchList.querySelectorAll(".copy-btn").forEach(btn => {
    btn.addEventListener("click", async e => {
      const m = currentMatches[parseInt(e.target.dataset.index)];
      await copyToClipboard(JN.withRecruiter(m.message, recruiterUrl));
      flashButton(e.target, "Copied!");
    });
  });
  matchList.querySelectorAll(".friend-checkbox").forEach(cb => cb.addEventListener("change", updateSendAll));

  updateSendAll();
}

function checkedIndexes() {
  return [...document.querySelectorAll(".friend-checkbox:checked")].map(cb => parseInt(cb.dataset.index));
}

function send(i) {
  window.open(JN.mailtoUrl(currentMatches[i], currentJob, recruiterUrl));
  sent.add(i);
  updateSendAll();
}

// Browsers block all but the first window.open per click, so "send all"
// opens one checked email per click instead of firing them all at once.
function sendNext() {
  const next = checkedIndexes().find(i => !sent.has(i));
  if (next !== undefined) send(next);
}

function updateSendAll() {
  const btn = document.getElementById("send-all-btn");
  const left = checkedIndexes().filter(i => !sent.has(i)).length;
  btn.textContent = left ? `Open next email (${left} left)` : "All checked emails opened";
  btn.disabled = !left;
}

async function copyAll(e) {
  const selected = checkedIndexes().map(i => currentMatches[i]);
  await copyToClipboard(JN.combinedMessages(selected, currentJob, recruiterUrl));
  flashButton(e.target, "Copied!");
}

function updateRecruiter() {
  const input = document.getElementById("recruiter-input");
  const status = document.getElementById("recruiter-status");
  const url = JN.normalizeRecruiterUrl(input.value);
  recruiterUrl = url || "";
  const bad = url === null;
  input.classList.toggle("invalid", bad);
  status.className = `recruiter-status ${bad ? "bad" : url ? "ok" : ""}`;
  status.textContent = bad
    ? "That doesn't look like a LinkedIn link, so it won't be included."
    : url ? "Added to your emails." : "";
}

// ── UI helpers ──

function showState(state) {
  document.getElementById("loading").hidden = state !== "loading";
  document.getElementById("results").hidden = state !== "results";
  document.getElementById("error-state").hidden = state !== "error";
  document.getElementById("manual-fallback").hidden = state !== "manual";
}

function showError(text, offerSettings = false) {
  showState("error");
  document.getElementById("error-message").textContent = text;
  document.getElementById("error-settings-btn").hidden = !offerSettings;
}

function showInput(msg, prefill = "") {
  showState("manual");
  document.getElementById("fallback-message").textContent = msg;
  document.getElementById("manual-input").value = prefill;
}

async function copyToClipboard(text) {
  try {
    await navigator.clipboard.writeText(text);
  } catch (e) {
    const ta = document.createElement("textarea");
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand("copy");
    document.body.removeChild(ta);
  }
}

function flashButton(btn, label) {
  const original = btn.textContent;
  btn.textContent = label;
  btn.disabled = true;
  setTimeout(() => {
    btn.textContent = original;
    btn.disabled = false;
    if (btn.id === "send-all-btn") updateSendAll();
  }, 1500);
}
