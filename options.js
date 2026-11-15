const $ = id => document.getElementById(id);

async function load() {
  const data = await chrome.storage.local.get(["settings", "friends", "autoDetect"]);
  const s = { ...JN.DEFAULT_SETTINGS, ...(data.settings || {}) };
  $("api-key").value = s.apiKey;
  $("model").value = s.model;
  $("effort").value = s.effort;
  $("threshold").value = s.threshold;
  $("auto-detect").checked = data.autoDetect !== false;

  let friends = data.friends;
  if (!Array.isArray(friends)) {
    // First run: start from the bundled example so the format is obvious.
    friends = await fetch(chrome.runtime.getURL("friends.json")).then(r => r.json()).catch(() => []);
  }
  $("friends").value = JSON.stringify(friends, null, 2);
}

function setStatus(text, kind) {
  const el = $("status");
  el.textContent = text;
  el.className = kind;
}

async function save() {
  let friends;
  try {
    friends = JSON.parse($("friends").value || "[]");
  } catch (e) {
    setStatus(`Friends list isn't valid JSON: ${e.message}`, "error");
    return;
  }
  const problem = JN.validateFriends(friends);
  if (problem) {
    setStatus(problem, "error");
    return;
  }

  const threshold = parseFloat($("threshold").value);
  if (Number.isNaN(threshold) || threshold < 0 || threshold > 1) {
    setStatus("Match threshold must be between 0 and 1.", "error");
    return;
  }

  const apiKey = $("api-key").value.trim();
  if (apiKey && !apiKey.startsWith("sk-ant-")) {
    setStatus('That doesn\'t look like an Anthropic API key (it should start with "sk-ant-").', "error");
    return;
  }

  await chrome.storage.local.set({
    settings: {
      apiKey,
      model: $("model").value.trim() || JN.DEFAULT_SETTINGS.model,
      effort: $("effort").value,
      threshold,
    },
    autoDetect: $("auto-detect").checked,
    friends,
  });
  setStatus(apiKey ? "Saved." : "Saved. Add an API key to start getting matches.", "ok");
}

document.addEventListener("DOMContentLoaded", () => {
  load();
  $("save").addEventListener("click", save);
});
