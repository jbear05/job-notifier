let friends = [];
let currentMatches = [];
let currentJob = null;

document.addEventListener("DOMContentLoaded", init);

async function init() {
  showState("loading");

  // Load friends list
  try {
    const resp = await fetch(chrome.runtime.getURL("friends.json"));
    friends = await resp.json();
  } catch (e) {
    showError("Could not load friends list.");
    return;
  }

  // Validate API key
  if (!CONFIG.ANTHROPIC_API_KEY || CONFIG.ANTHROPIC_API_KEY.startsWith("sk-ant-YOUR")) {
    showError(
      "API key not configured. Open <code>config.js</code> and replace the placeholder with your Anthropic API key."
    );
    return;
  }

  // Request page text from content script
  let tab;
  try {
    [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  } catch (e) {
    showError("Could not access the active tab.");
    return;
  }

  chrome.tabs.sendMessage(tab.id, { type: "GET_PAGE_TEXT" }, async (response) => {
    if (chrome.runtime.lastError || !response) {
      showManualFallback("Could not read the page. Paste the job text below:");
      return;
    }

    if (!response.isJobPage || response.length < 200) {
      showManualFallback("This doesn't look like a job posting. Paste the job text below:");
      return;
    }

    await runAnalysis(response.text);
  });
}

async function runAnalysis(jobText) {
  showState("loading");

  try {
    const result = await callClaude(jobText);
    currentMatches = result.matches || [];
    renderResults(result.job, currentMatches);
  } catch (e) {
    showError(`Analysis failed: ${e.message}`);
  }
}

async function callClaude(jobText, retry = false) {
  const activeFriends = friends.filter(f => f.notify !== false);
  const friendsJson = JSON.stringify(activeFriends, null, 2);

  const strictInstruction = retry
    ? "IMPORTANT: Your entire response must be ONLY the JSON object. No explanation, no markdown, no code fences."
    : "";

  const prompt = `You are a job notification assistant. Given a job posting and a list of friends, do two things:

1. Extract the job details as JSON.
2. For each friend with notify=true, decide if this job is relevant (score 0.0–1.0). If score >= ${CONFIG.RELEVANCE_THRESHOLD}, draft a short casual message (2–3 sentences) as if the user is texting the friend. The message should mention why it fits them specifically — reference their skills or interests.

Friends list:
${friendsJson}

Job posting text:
${jobText}

${strictInstruction}
Respond ONLY with valid JSON in exactly this shape:
{
  "job": { "title": "", "company": "", "skills": [], "level": "", "location": "", "remote": false },
  "matches": [
    { "name": "", "score": 0.0, "message": "" }
  ]
}
Only include friends with score >= ${CONFIG.RELEVANCE_THRESHOLD} in matches. Do not include any text outside the JSON.`;

  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": CONFIG.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
      "anthropic-dangerous-direct-browser-access": "true"
    },
    body: JSON.stringify({
      model: CONFIG.MODEL,
      max_tokens: 1024,
      messages: [{ role: "user", content: prompt }]
    })
  });

  if (!response.ok) {
    const err = await response.json().catch(() => ({}));
    throw new Error(err.error?.message || `API error ${response.status}`);
  }

  const data = await response.json();
  const raw = data.content?.[0]?.text || "";

  // Strip markdown code fences if present
  const cleaned = raw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```\s*$/, "").trim();

  let parsed;
  try {
    parsed = JSON.parse(cleaned);
  } catch (e) {
    if (!retry) {
      return callClaude(jobText, true);
    }
    throw new Error("Response was not valid JSON after retry.");
  }

  return parsed;
}

function renderResults(job, matches) {
  showState("results");
  currentJob = job;

  const jobCard = document.getElementById("job-card");
  jobCard.innerHTML = `
    <div class="job-title">${escHtml(job.title || "Unknown title")}</div>
    <div class="job-meta">
      <span>${escHtml(job.company || "Unknown company")}</span>
      ${job.level ? `<span class="tag">${escHtml(job.level)}</span>` : ""}
      ${job.remote ? `<span class="tag tag-remote">Remote</span>` : ""}
      ${job.location ? `<span class="tag-location">${escHtml(job.location)}</span>` : ""}
    </div>
    ${job.skills?.length ? `<div class="job-skills">${job.skills.map(s => `<span class="skill">${escHtml(s)}</span>`).join("")}</div>` : ""}
  `;

  const matchList = document.getElementById("match-list");
  const emptyState = document.getElementById("empty-state");
  const sendAllBtn = document.getElementById("send-all-btn");

  if (!matches.length) {
    matchList.innerHTML = "";
    emptyState.hidden = false;
    sendAllBtn.hidden = true;
    return;
  }

  emptyState.hidden = true;
  sendAllBtn.hidden = false;

  matchList.innerHTML = matches.map((m, i) => `
    <div class="match-card" data-index="${i}">
      <div class="match-header">
        <label class="match-select">
          <input type="checkbox" class="friend-checkbox" data-index="${i}" checked>
          <span class="match-name">${escHtml(m.name)}</span>
        </label>
        <span class="match-score" title="Relevance score">${Math.round(m.score * 100)}% match</span>
      </div>
      <textarea class="message-box" rows="4" data-index="${i}">${escHtml(m.message)}</textarea>
      <div class="card-actions">
        <button class="send-btn" data-index="${i}">Send</button>
        <button class="copy-btn" data-index="${i}">Copy</button>
      </div>
    </div>
  `).join("");

  // Keep in-memory messages in sync with edits
  matchList.querySelectorAll("textarea").forEach(ta => {
    ta.addEventListener("input", e => {
      const idx = parseInt(e.target.dataset.index);
      currentMatches[idx].message = e.target.value;
    });
  });

  // Per-card send buttons
  matchList.querySelectorAll(".send-btn").forEach(btn => {
    btn.addEventListener("click", e => {
      const idx = parseInt(e.target.dataset.index);
      openMailto(currentMatches[idx]);
      flashButton(e.target, "Opened!");
    });
  });

  // Per-card copy buttons
  matchList.querySelectorAll(".copy-btn").forEach(btn => {
    btn.addEventListener("click", async e => {
      const idx = parseInt(e.target.dataset.index);
      await copyToClipboard(currentMatches[idx].message);
      flashButton(e.target, "Copied!");
    });
  });
}

document.getElementById("send-all-btn")?.addEventListener("click", () => {
  const checkboxes = document.querySelectorAll(".friend-checkbox:checked");
  checkboxes.forEach(cb => {
    const idx = parseInt(cb.dataset.index);
    openMailto(currentMatches[idx]);
  });
  const btn = document.getElementById("send-all-btn");
  flashButton(btn, "All opened!");
});

document.getElementById("manual-analyze-btn")?.addEventListener("click", async () => {
  const text = document.getElementById("manual-input").value.trim();
  if (text.length < 50) {
    document.getElementById("manual-error").textContent = "Please paste more text (at least 50 characters).";
    return;
  }
  document.getElementById("manual-error").textContent = "";
  await runAnalysis(text);
});

function openMailto(match) {
  const friend = friends.find(f => f.name === match.name);
  const contact = friend?.contact || "";
  const subject = currentJob?.title && currentJob?.company
    ? `Job opportunity: ${currentJob.title} at ${currentJob.company}`
    : "Job opportunity";
  window.open(`mailto:${encodeURIComponent(contact)}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(match.message)}`);
}

// --- UI helpers ---

function showState(state) {
  document.getElementById("loading").hidden = state !== "loading";
  document.getElementById("results").hidden = state !== "results";
  document.getElementById("error-state").hidden = state !== "error";
  document.getElementById("manual-fallback").hidden = state !== "manual";
}

function showError(html) {
  showState("error");
  document.getElementById("error-message").innerHTML = html;
}

function showManualFallback(msg) {
  showState("manual");
  document.getElementById("fallback-message").textContent = msg;
}

async function copyToClipboard(text) {
  try {
    await navigator.clipboard.writeText(text);
  } catch (e) {
    // Fallback for older contexts
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
  }, 1500);
}

function escHtml(str) {
  return String(str ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
