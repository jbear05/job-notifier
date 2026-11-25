// Settings page (spec Design: Settings page). Each section saves on its own.
// Friends from the form and from imports go through JN.cleanFriends, the same
// validator the worker uses (criterion 35). The key stays in a password field.

const $ = id => document.getElementById(id);
const DEFAULT_MODEL = JN.MODELS.find(m => m.id === JN.DEFAULT_SETTINGS.model);
let friends = [];
let editing = -1; // index of the friend in the form, or -1 when adding
let pendingImport = null; // { file, friends } waiting for Add or Replace
let hadKey = false;

const plural = n => (n === 1 ? '1 friend' : `${n} friends`);

function say(id, text, error = false) {
  $(id).textContent = text;
  $(id).classList.toggle('error-text', error);
}

function setError(id, message) {
  $(id).setAttribute('aria-invalid', 'true');
  $(`${id}-error`).textContent = message;
}

function clearErrors(ids) {
  for (const id of ids) {
    $(id).removeAttribute('aria-invalid');
    $(`${id}-error`).textContent = '';
  }
}

// ── Claude ──

async function saveClaude(e) {
  e.preventDefault();
  clearErrors(['api-key', 'threshold']);
  const apiKey = $('api-key').value.trim();
  const threshold = $('threshold').valueAsNumber;
  let firstBad = null;
  if (apiKey && !apiKey.startsWith('sk-ant-')) {
    setError('api-key', 'That doesn\'t look like an Anthropic API key. Keys start with "sk-ant-".');
    firstBad = $('api-key');
  }
  if (!(threshold >= 0 && threshold <= 1)) {
    setError('threshold', 'Enter a number from 0 to 1, like 0.6.');
    $('more').open = true;
    firstBad = firstBad || $('threshold');
  }
  if (firstBad) return firstBad.focus();

  await chrome.storage.local.set({ settings: { apiKey, model: $('model').value, effort: $('effort').value, threshold } });
  $('model-note').hidden = true;
  say('claude-status', !apiKey && hadKey ? 'Saved. Your API key was removed from this browser.'
    : !friends.length ? 'Saved. Next, add at least one friend below.' : 'Saved.');
  hadKey = !!apiKey;
}

// ── Friends ──

function friendRow(f, i) {
  const contactLine = [f.contact || 'No email', f.level].filter(Boolean).join(' · ');
  return h('li', { class: f.notify ? 'friend-row' : 'friend-row excluded' },
    h('div', { class: 'friend-info' },
      h('p', { class: 'label friend-name' }, h('span', null, f.name), !f.notify && h('span', { class: 'chip' }, 'Excluded')),
      h('p', { class: 'small muted friend-line' }, contactLine),
      f.skills.length > 0 && h('p', { class: 'small muted friend-line' }, `Skills: ${f.skills.join(', ')}`),
      f.interests.length > 0 && h('p', { class: 'small muted friend-line' }, `Interests: ${f.interests.join(', ')}`)),
    h('div', { class: 'friend-actions' },
      h('label', { class: 'check small' },
        h('input', { type: 'checkbox', checked: f.notify, 'aria-label': `Include ${f.name} in matching`, onchange: e => setInclude(i, e.target.checked) }),
        'Include'),
      btn('Edit', () => openForm(i), 'text', { 'aria-label': `Edit ${f.name}`, 'data-edit': '' }),
      btn('Remove', () => removeFriend(i), 'text', { 'aria-label': `Remove ${f.name}` })));
}

const editButton = i => $('friend-list').children[i]?.querySelector('[data-edit]');

function renderFriends() {
  const empty = !friends.length;
  $('friends-empty').hidden = !empty;
  $('friend-list').hidden = empty;
  $('export-btn').hidden = empty;
  $('export-note').hidden = empty;
  $('form-cancel').hidden = empty;
  $('friend-list').replaceChildren(...friends.map(friendRow));
  if (empty && $('friend-form').hidden) openForm(-1, false);
}

// Returns null when saved, or the validator's message.
async function saveFriends(list) {
  const result = JN.cleanFriends(list);
  if (result.error) return result.error;
  friends = result.friends;
  await chrome.storage.local.set({ friends });
  renderFriends();
  return null;
}

async function setInclude(i, on) {
  await saveFriends(friends.map((f, j) => (j === i ? { ...f, notify: on } : f)));
  $('friend-list').children[i].querySelector('input').focus();
}

async function removeFriend(i) {
  const { name } = friends[i];
  if (!confirm(`Remove ${name} from your friends list?`)) return;
  if (editing >= 0) closeForm();
  await saveFriends(friends.filter((_, j) => j !== i));
  say('friends-status', `Removed ${name}.`);
  (editButton(i) || editButton(i - 1) || $('add-friend')).focus();
}

function openForm(i, focus = true) {
  editing = i;
  const f = friends[i] || { name: '', contact: '', skills: [], interests: [], level: '', notify: true };
  $('form-heading').textContent = i >= 0 ? `Edit ${f.name}` : 'Add a friend';
  $('form-submit').textContent = i >= 0 ? 'Save changes' : 'Add friend';
  $('f-name').value = f.name;
  $('f-email').value = f.contact;
  $('f-skills').value = f.skills.join(', ');
  $('f-interests').value = f.interests.join(', ');
  $('f-level').value = f.level;
  $('f-notify').checked = f.notify;
  clearErrors(['f-name', 'f-email', 'f-skills', 'f-interests']);
  $('friend-form').hidden = false;
  if (focus) $('f-name').focus();
}

function closeForm() {
  if (!friends.length) return; // the form stays open while the list is empty
  $('friend-form').hidden = true;
  const back = editing >= 0 ? editButton(editing) : null;
  editing = -1;
  return back || $('add-friend');
}

const splitList = s => s.split(',').map(x => x.trim()).filter(Boolean);
const tooLong = list => list.length > 50 || list.some(x => x.length > 100);

async function submitFriend(e) {
  e.preventDefault();
  clearErrors(['f-name', 'f-email', 'f-skills', 'f-interests']);
  const entry = {
    name: $('f-name').value.trim(),
    contact: $('f-email').value.trim(),
    skills: splitList($('f-skills').value),
    interests: splitList($('f-interests').value),
    level: $('f-level').value.trim(),
    notify: $('f-notify').checked,
  };
  const bad = [];
  if (!entry.name) bad.push(['f-name', 'Enter a name.']);
  if (entry.contact && JN.cleanFriends([{ name: 'x', contact: entry.contact }]).error) {
    bad.push(['f-email', 'Enter an email like name@example.com, or leave it blank.']);
  }
  if (tooLong(entry.skills)) bad.push(['f-skills', 'Keep each skill under 100 characters and list 50 at most.']);
  if (tooLong(entry.interests)) bad.push(['f-interests', 'Keep each interest under 100 characters and list 50 at most.']);
  if (bad.length) {
    bad.forEach(([id, message]) => setError(id, message));
    return $(bad[0][0]).focus();
  }

  const adding = editing < 0;
  const list = [...friends];
  if (adding) list.push(entry);
  else list[editing] = entry;
  const error = await saveFriends(list);
  if (error) return say('friends-status', error, true);
  const index = adding ? friends.length - 1 : editing;
  $('friend-form').hidden = true;
  editing = -1;
  editButton(index).focus();
  say('friends-status', adding ? `Added ${entry.name}.` : `Saved changes to ${entry.name}.`);
}

// ── Import and export ──

async function onImportFile() {
  const file = $('import-file').files[0];
  $('import-file').value = '';
  if (!file) return;
  $('import-error').textContent = '';
  $('import-panel').hidden = true;
  // parseFriendsImport rejects anything over 1 MB; reading at most a little more keeps a huge file out of memory.
  const result = JN.parseFriendsImport(await file.slice(0, 2 ** 20 + 1).text());
  if (result.error) {
    $('import-error').textContent = `Couldn't import ${file.name}: ${result.error}`;
    return;
  }
  const n = result.friends.length;
  if (!friends.length) {
    const error = await saveFriends(result.friends);
    if (error) {
      $('import-error').textContent = `Couldn't import ${file.name}: ${error}`;
      return;
    }
    if (friends.length) $('friend-form').hidden = true;
    say('friends-status', `Imported ${plural(n)} from ${file.name}.`);
    return;
  }
  pendingImport = { file: file.name, friends: result.friends };
  $('import-summary').textContent = `${file.name} has ${plural(n)}. Your list has ${friends.length}.`;
  $('import-panel').hidden = false;
  $('import-summary').focus();
}

async function applyImport(replace) {
  const { file, friends: incoming } = pendingImport;
  pendingImport = null;
  $('import-panel').hidden = true;
  if (editing >= 0) closeForm();
  const error = await saveFriends(replace ? incoming : [...friends, ...incoming]);
  if (error) $('import-error').textContent = `Couldn't import ${file}: ${error}`;
  else {
    const n = plural(incoming.length);
    say('friends-status', replace ? `Replaced your list with ${n} from ${file}.` : `Added ${n} from ${file}.`);
  }
  $('import-btn').focus();
}

// Writes only the friends list, in the format Import accepts. No key, no settings.
function exportFriends() {
  const url = URL.createObjectURL(new Blob([JSON.stringify(friends, null, 2)], { type: 'application/json' }));
  h('a', { href: url, download: 'job-notifier-friends.json' }).click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// ── Auto-detect (engineer A's contract; criteria 7, 36) ──

const REMOVED = "Auto-detect is off because site access was removed in Chrome's extension settings.";

async function renderAuto() {
  const [{ autoDetect }, access] = await Promise.all([
    chrome.storage.local.get('autoDetect'),
    chrome.permissions.contains({ origins: JN.ALL_SITES }),
  ]);
  $('auto-toggle').checked = autoDetect === true && access;
  if (autoDetect === true && !access) say('auto-status', REMOVED);
}

// The explanation is already on screen, so the click goes straight to Chrome's prompt.
function onAutoToggle(e) {
  const toggle = e.target;
  if (!toggle.checked) {
    chrome.storage.local.set({ autoDetect: false });
    return say('auto-status', 'Auto-detect is off.');
  }
  toggle.checked = false;
  chrome.permissions.request({ origins: JN.ALL_SITES }).then(async granted => {
    if (granted) await chrome.storage.local.set({ autoDetect: true });
    toggle.checked = granted;
    say('auto-status', granted ? 'Auto-detect is on.' : "Chrome didn't grant site access, so auto-detect is still off.");
  });
}

// ── Load ──

async function load() {
  const data = await chrome.storage.local.get(['settings', 'friends']);
  const s = JN.normalizeSettings(data.settings);
  hadKey = !!s.apiKey;
  $('api-key').value = s.apiKey;
  $('model').value = s.model;
  $('effort').value = s.effort;
  $('threshold').value = s.threshold;
  // A model saved by an earlier version that isn't offered now falls back to the default (criterion 33).
  const stored = data.settings && data.settings.model;
  if (typeof stored === 'string' && stored !== s.model) {
    $('model-note').textContent = `${stored} from an earlier version isn't offered anymore, so Job Notifier now uses ${DEFAULT_MODEL.name}.`;
    $('model-note').hidden = false;
  }
  // First run: no friends until the user adds one (criterion 2).
  friends = JN.storedFriends(data.friends);
  renderFriends();
  renderAuto();
}

document.addEventListener('DOMContentLoaded', () => {
  $('version').textContent = chrome.runtime.getManifest().version;
  $('model').replaceChildren(...JN.MODELS.map(m =>
    h('option', { value: m.id }, m.id === DEFAULT_MODEL.id ? `${m.name} (default, lower cost)` : m.name)));

  $('claude-form').addEventListener('submit', saveClaude);
  $('friend-form').addEventListener('submit', submitFriend);
  $('form-cancel').addEventListener('click', () => {
    const back = closeForm();
    if (back) back.focus();
  });
  $('add-friend').addEventListener('click', () => openForm(-1));
  $('import-btn').addEventListener('click', () => $('import-file').click());
  $('import-file').addEventListener('change', onImportFile);
  $('import-add').addEventListener('click', () => applyImport(false));
  $('import-replace').addEventListener('click', () => applyImport(true));
  $('import-cancel').addEventListener('click', () => {
    pendingImport = null;
    $('import-panel').hidden = true;
    $('import-btn').focus();
  });
  $('export-btn').addEventListener('click', exportFriends);

  $('auto-toggle').addEventListener('change', onAutoToggle);
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && 'autoDetect' in changes) renderAuto();
  });
  // Site access removed in Chrome while the switch shows on.
  chrome.permissions.onRemoved.addListener(() => {
    if ($('auto-toggle').checked) say('auto-status', REMOVED);
    renderAuto();
  });

  load();
});
