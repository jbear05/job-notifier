const $ = id => document.getElementById(id);
const esc = JN.escHtml;

// Working copy of { groups, friends }; written to storage on Save.
let store = { groups: [], friends: [] };

async function load() {
  const data = await chrome.storage.local.get(["settings", "friends", "groups", "autoDetect"]);
  const s = { ...JN.DEFAULT_SETTINGS, ...(data.settings || {}) };
  $("api-key").value = s.apiKey;
  $("model").value = s.model;
  $("effort").value = s.effort;
  $("auto-detect").checked = data.autoDetect !== false;

  store = JN.normalizeStore(data);
  renderGroups();
  renderFriends();
}

function setStatus(text, kind) {
  const el = $("status");
  el.textContent = text;
  el.className = kind || "";
}

function markDirty() {
  setStatus("Unsaved changes.", "");
}

// ── Groups ──

function renderGroups() {
  const list = $("group-list");
  if (!store.groups.length) {
    list.innerHTML = `<li class="empty">No groups yet. Add one below.</li>`;
    return;
  }
  list.innerHTML = store.groups.map(g => {
    const n = JN.groupMembers(store, g.id).length;
    return `
      <li class="group-row" data-id="${esc(g.id)}">
        <input type="text" class="group-name" value="${esc(g.name)}" maxlength="40" aria-label="Group name" />
        <span class="count">${n} friend${n === 1 ? "" : "s"}</span>
        <button type="button" class="link-btn danger delete-group">Delete</button>
      </li>`;
  }).join("");
}

function addGroup(e) {
  e.preventDefault();
  const name = JN.cleanName($("new-group").value);
  if (!name) return;
  if (store.groups.some(g => g.name.toLowerCase() === name.toLowerCase())) {
    setStatus(`You already have a group called "${name}".`, "error");
    return;
  }
  store.groups.push({ id: JN.newId("g"), name });
  $("new-group").value = "";
  renderGroups();
  renderFriends();
  markDirty();
}

$("group-list").addEventListener("input", e => {
  if (!e.target.classList.contains("group-name")) return;
  const g = store.groups.find(x => x.id === e.target.closest(".group-row").dataset.id);
  g.name = e.target.value;
  // Keep the chip labels on friends in sync while typing.
  document.querySelectorAll(`.chip[data-group="${CSS.escape(g.id)}"]`).forEach(c => {
    c.textContent = JN.cleanName(g.name) || "Untitled";
  });
  markDirty();
});

$("group-list").addEventListener("click", e => {
  if (!e.target.classList.contains("delete-group")) return;
  const id = e.target.closest(".group-row").dataset.id;
  store.groups = store.groups.filter(g => g.id !== id);
  store.friends.forEach(f => { f.groups = f.groups.filter(x => x !== id); });
  renderGroups();
  renderFriends();
  markDirty();
});

// ── Friends ──

function renderFriends() {
  const list = $("friend-list");
  if (!store.friends.length) {
    list.innerHTML = `<li class="empty">No friends yet.</li>`;
    return;
  }
  list.innerHTML = store.friends.map(f => `
    <li class="friend-row" data-id="${esc(f.id)}">
      <div class="friend-fields">
        <input type="text" class="friend-name" value="${esc(f.name)}" placeholder="Name" aria-label="Name" />
        <input type="email" class="friend-contact" value="${esc(f.contact)}" placeholder="Email" aria-label="Email" />
        <button type="button" class="link-btn danger remove-friend">Remove</button>
      </div>
      <div class="chips">
        ${store.groups.length
          ? store.groups.map(g => `<button type="button" class="chip" data-group="${esc(g.id)}"
              aria-pressed="${f.groups.includes(g.id)}">${esc(JN.cleanName(g.name) || "Untitled")}</button>`).join("")
          : `<span class="muted">Add a group above to put this friend in it.</span>`}
      </div>
    </li>`).join("");
}

function friendFor(el) {
  const id = el.closest(".friend-row").dataset.id;
  return store.friends.find(f => f.id === id);
}

$("friend-list").addEventListener("input", e => {
  if (e.target.classList.contains("friend-name")) friendFor(e.target).name = e.target.value;
  else if (e.target.classList.contains("friend-contact")) friendFor(e.target).contact = e.target.value;
  else return;
  markDirty();
});

$("friend-list").addEventListener("click", e => {
  const t = e.target;
  if (t.classList.contains("chip")) {
    const f = friendFor(t);
    const id = t.dataset.group;
    f.groups = f.groups.includes(id) ? f.groups.filter(x => x !== id) : [...f.groups, id];
    t.setAttribute("aria-pressed", String(f.groups.includes(id)));
    renderGroups();
    markDirty();
  } else if (t.classList.contains("remove-friend")) {
    const f = friendFor(t);
    store.friends = store.friends.filter(x => x !== f);
    renderFriends();
    renderGroups();
    markDirty();
  }
});

$("add-friend").addEventListener("click", () => {
  store.friends.push({ id: JN.newId("f"), name: "", contact: "", groups: [] });
  renderFriends();
  const rows = document.querySelectorAll(".friend-row .friend-name");
  rows[rows.length - 1]?.focus();
});

// ── Save ──

async function save() {
  // Blank rows someone added and never filled in are just dropped.
  store.friends = store.friends.filter(f => JN.cleanName(f.name) || String(f.contact).trim());
  const problem = JN.validateStore(store);
  if (problem) {
    setStatus(problem, "error");
    return;
  }

  const apiKey = $("api-key").value.trim();
  if (apiKey && !apiKey.startsWith("sk-ant-")) {
    setStatus('That doesn\'t look like an Anthropic API key (it should start with "sk-ant-").', "error");
    return;
  }

  store = JN.normalizeStore(store);
  await chrome.storage.local.set({
    settings: {
      apiKey,
      model: $("model").value.trim() || JN.DEFAULT_SETTINGS.model,
      effort: $("effort").value,
    },
    autoDetect: $("auto-detect").checked,
    groups: store.groups,
    friends: store.friends,
  });
  renderGroups();
  renderFriends();
  setStatus(apiKey ? "Saved." : "Saved. Add an API key to start sharing jobs.", "ok");
}

document.addEventListener("DOMContentLoaded", () => {
  load();
  $("save").addEventListener("click", save);
  $("add-group").addEventListener("submit", addGroup);
});
