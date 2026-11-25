let current = null;         // { job, message, suggestedGroupId, groups }
let selectedGroupId = null;
let excluded = new Set();   // friends unticked in the selected group, by index
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
  document.getElementById("email-btn").addEventListener("click", emailGroup);
  document.getElementById("copy-btn").addEventListener("click", copyMessage);
  document.getElementById("message-box").addEventListener("input", e => { current.message = e.target.value; });
  document.getElementById("group-chips").addEventListener("click", onChipClick);
  document.getElementById("member-list").addEventListener("change", onMemberToggle);
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
      showInput("Found a job posting on this page. Check the text, then draft a message:", response.text);
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
    current = await analyzeViaBackground(text);
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

function renderResults() {
  showState("results");
  const job = current.job || {};
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

  document.getElementById("message-box").value = current.message;
  document.getElementById("recruiter-input").value = "";
  updateRecruiter();
  document.getElementById("group-hint").textContent = current.suggestedGroupId
    ? "Claude's pick is highlighted. Tap another group to switch."
    : "No group was a clear fit. Pick one:";
  selectGroup(current.suggestedGroupId);
}

function selectGroup(id) {
  selectedGroupId = id;
  excluded = new Set();
  const esc = JN.escHtml;
  document.getElementById("group-chips").innerHTML = current.groups.map(g => `
    <button type="button" class="group-chip" role="radio" data-id="${esc(g.id)}"
            aria-checked="${g.id === id}">${esc(g.name)}${g.id === current.suggestedGroupId ? '<span class="suggested">★</span>' : ""}</button>
  `).join("");

  const group = selectedGroup();
  document.getElementById("member-list").innerHTML = group ? group.members.map((m, i) => `
    <li><label>
      <input type="checkbox" data-index="${i}" ${m.contact ? "checked" : "disabled"}>
      <span class="member-name">${esc(m.name)}</span>
      <span class="member-contact">${esc(m.contact || "no email")}</span>
    </label></li>
  `).join("") : "";
  updateEmailButton();
}

function selectedGroup() {
  return current.groups.find(g => g.id === selectedGroupId) || null;
}

function recipients() {
  const group = selectedGroup();
  return group ? group.members.filter((m, i) => m.contact && !excluded.has(i)) : [];
}

function onChipClick(e) {
  const chip = e.target.closest(".group-chip");
  if (chip) selectGroup(chip.dataset.id);
}

function onMemberToggle(e) {
  const i = parseInt(e.target.dataset.index);
  e.target.checked ? excluded.delete(i) : excluded.add(i);
  updateEmailButton();
}

function updateEmailButton() {
  const btn = document.getElementById("email-btn");
  const n = recipients().length;
  btn.disabled = !n;
  btn.textContent = !selectedGroup() ? "Pick a group"
    : n ? `Email ${n} friend${n === 1 ? "" : "s"}` : "No one to email";
}

function emailGroup(e) {
  window.open(JN.groupMailtoUrl(recipients(), current.job, current.message, recruiterUrl));
  flashButton(e.target, "Opened!");
}

async function copyMessage(e) {
  await copyToClipboard(JN.shareText(current.job, current.message, recruiterUrl));
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
    : url ? "Added to your email." : "";
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
    if (btn.id === "email-btn") updateEmailButton();
  }, 1500);
}
