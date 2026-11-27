// Settings page (spec Design: Settings page). Passphrase setup, unlock, conversion,
// lock, and reset talk to the service worker; unlocked saves persist through the
// worker's encrypted vault with expectedRev optimistic concurrency.

const $ = id => document.getElementById(id);
const DEFAULT_MODEL = JN.MODELS.find(m => m.id === JN.DEFAULT_SETTINGS.model);
let friends = [];
let editing = -1; // index of the friend in the form, or -1 when adding
let pendingImport = null; // { file, friends } waiting for Add or Replace
let hadKey = false;
let currentVaultState = 'locked';
let currentVaultRev = null;
let legacySummary = { hasKey: false, friendCount: 0 };
let vaultBusy = false;
let resetOpener = null;
let ignoringNextVaultChanged = false;

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

function clearPassphraseInputs() {
  for (const id of ['setup-passphrase', 'setup-confirm', 'convert-passphrase', 'convert-confirm', 'unlock-passphrase']) {
    const el = $(id);
    if (el) {
      el.readOnly = false;
      el.value = '';
    }
  }
}

function clearSensitiveDom() {
  currentVaultRev = null;
  hadKey = false;
  $('api-key').value = '';
  $('claude-status').textContent = '';
  $('model-note').hidden = true;
  clearErrors(['api-key', 'threshold']);

  friends = [];
  editing = -1;
  pendingImport = null;
  $('friend-list').replaceChildren();
  $('friends-empty').hidden = true;
  $('import-panel').hidden = true;
  $('import-summary').textContent = '';
  $('friends-status').textContent = '';
  $('import-error').textContent = '';
  $('friend-form').hidden = true;
  $('add-friend').hidden = false;
  $('f-name').value = '';
  $('f-email').value = '';
  $('f-skills').value = '';
  $('f-interests').value = '';
  $('f-level').value = '';
  $('f-notify').checked = true;
  clearErrors(['f-name', 'f-email', 'f-skills', 'f-interests']);
  clearPassphraseInputs();
}

const VAULT_BUTTON_IDS = [
  'setup-submit', 'convert-submit', 'convert-reset-toggle',
  'unlock-submit', 'forgot-btn', 'unreadable-reset-btn',
  'reset-confirm-btn', 'reset-cancel-btn', 'lock-btn',
];
const VAULT_PENDING_IDS = {
  setup: 'setup-pending',
  convert: 'convert-pending',
  unlock: 'unlock-pending',
  reset: 'reset-pending',
  lock: 'lock-pending',
};
const VAULT_INPUT_IDS = [
  'setup-passphrase', 'setup-confirm',
  'convert-passphrase', 'convert-confirm',
  'unlock-passphrase',
];

function setVaultPending(kind, pending) {
  vaultBusy = pending;
  for (const id of VAULT_BUTTON_IDS) {
    const el = $(id);
    if (!el) continue;
    if (pending) el.setAttribute('aria-disabled', 'true');
    else el.removeAttribute('aria-disabled');
  }
  for (const [k, pid] of Object.entries(VAULT_PENDING_IDS)) {
    $(pid).hidden = !(pending && k === kind);
  }
  for (const id of VAULT_INPUT_IDS) {
    $(id).readOnly = pending;
  }
}

const VAULT_COPY = {
  uninitialized: {
    lede: 'Create a passphrase to encrypt your API key and friends list in this browser.',
    heading: 'Create a passphrase',
    subtitle: 'Protects your API key and friends list in this Chrome profile.',
  },
  'needs-conversion': {
    lede: 'Create a passphrase to encrypt your existing API key and friends list in this browser.',
    heading: 'Encrypt existing saved data',
    subtitle: 'Unencrypted 2.0.0 data was found in this browser.',
  },
  locked: {
    lede: 'Your saved API key and friends list are locked in this browser.',
    heading: 'Unlock saved data',
    subtitle: 'Your API key and friends list are encrypted.',
  },
  unreadable: {
    lede: 'Your saved API key and friends list are locked in this browser.',
    heading: "Saved data can't be read",
    subtitle: 'The encrypted record in this browser is damaged or unsupported.',
  },
  unlocked: {
    lede: 'Your API key and friends list are encrypted in this browser. Lock them anytime when you step away.',
    heading: 'Passphrase lock',
    subtitle: 'Unlocked for this Chrome session.',
  },
};

function renderVaultState(state, { summary, focus = false, statusId, statusText } = {}) {
  currentVaultState = state;
  if (summary) legacySummary = summary;
  const copy = VAULT_COPY[state] || VAULT_COPY.locked;

  $('page-lede').textContent = copy.lede;
  $('vault-heading').textContent = copy.heading;
  $('vault-subtitle').textContent = copy.subtitle;

  $('setup-form').hidden = state !== 'uninitialized';
  $('convert-view').hidden = state !== 'needs-conversion';
  $('convert-error-block').hidden = true;
  $('unlock-form').hidden = state !== 'locked';
  $('unreadable-view').hidden = state !== 'unreadable';
  $('unlocked-view').hidden = state !== 'unlocked';
  $('reset-panel').hidden = true;
  $('reset-confirm-check').checked = false;
  $('reset-confirm-error').textContent = '';
  resetOpener = null;

  clearErrors([
    'setup-passphrase', 'setup-confirm',
    'convert-passphrase', 'convert-confirm',
    'unlock-passphrase',
  ]);
  for (const sid of ['setup-status', 'unlock-status', 'vault-status', 'convert-error']) {
    say(sid, '');
  }

  if (state === 'needs-conversion') {
    const n = legacySummary.friendCount || 0;
    const friendWord = n === 1 ? '1 saved friend' : `${n} saved friends`;
    $('convert-summary').textContent = `Found ${legacySummary.hasKey ? 'a saved API key' : 'no API key'} and ${friendWord} stored without encryption.`;
  }

  const unlocked = state === 'unlocked';
  $('vault').classList.toggle('is-unlocked', unlocked);
  $('claude').hidden = !unlocked;
  $('friends').hidden = !unlocked;
  if (!unlocked) clearSensitiveDom();
  else clearPassphraseInputs();

  if (statusId && statusText) say(statusId, statusText);
  if (focus) {
    const target = unlocked && location.hash === '#friends' ? $('friends-heading') : $('vault-heading');
    target.focus();
  }
}

function validatePassphrasePair(passId, confirmId) {
  const pass = $(passId).value;
  const confirm = $(confirmId).value;
  clearErrors([passId, confirmId]);

  const err = JN.validatePassphrase(pass);
  if (err) {
    setError(passId, err);
    $(passId).value = '';
    $(confirmId).value = '';
    $(passId).focus();
    return null;
  }
  if (!confirm.length) {
    setError(confirmId, 'Confirm your passphrase.');
    $(confirmId).focus();
    return null;
  }
  if (pass !== confirm) {
    setError(confirmId, "Passphrases don't match. Enter the same passphrase in both fields.");
    $(confirmId).value = '';
    $(confirmId).focus();
    return null;
  }
  return pass;
}

const WORKER_UNAVAILABLE = {
  ok: false,
  code: 'WORKER_UNAVAILABLE',
  error: 'Job Notifier did not receive a reply. Reload settings to check the current state.',
};

async function getVaultWorker() {
  let timer;
  try {
    const registration = await Promise.race([
      navigator.serviceWorker?.ready,
      new Promise(resolve => { timer = setTimeout(resolve, 5000); }),
    ]);
    return registration?.active;
  } catch (e) {
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}

// Send vault data directly to the manifest worker, with a separate reply
// channel for each request. VAULT_LOCK carries no sensitive data.
async function sendWorker(msg) {
  if (msg.type === 'VAULT_LOCK') return chrome.runtime.sendMessage(msg);
  const worker = await getVaultWorker();
  if (worker?.scriptURL !== chrome.runtime.getURL('background.js')) return WORKER_UNAVAILABLE;
  return new Promise(resolve => {
    const { port1, port2 } = new MessageChannel();
    const finish = reply => {
      clearTimeout(timer);
      port1.close();
      resolve(reply ?? WORKER_UNAVAILABLE);
    };
    const timer = setTimeout(finish, 10000);
    port1.onmessage = event => finish(event.data);
    port1.onmessageerror = () => finish();
    try {
      worker.postMessage(msg, [port2]);
    } catch (e) {
      port2.close();
      finish();
    }
  });
}

async function loadUnlockedData() {
  const res = await sendWorker({ type: 'VAULT_GET_DATA' });
  if (currentVaultState !== 'unlocked') return false;
  if (!res || !res.ok) {
    if (res?.code === 'LOCKED') await loadVault({ focus: false });
    else if (res?.code === 'WORKER_UNAVAILABLE') {
      renderVaultState('locked');
      say('unlock-status', res.error, true);
    }
    else if (res?.vaultState) renderVaultState(res.vaultState);
    return false;
  }
  currentVaultRev = res.vaultRev;
  const s = JN.normalizeSettings(res.settings);
  hadKey = !!res.apiKey;
  $('api-key').value = res.apiKey;
  $('model').value = s.model;
  $('effort').value = s.effort;
  $('threshold').value = s.threshold;
  if (typeof res.storedModel === 'string' && res.storedModel !== s.model) {
    $('model-note').textContent = `${res.storedModel} from an earlier version isn't offered anymore, so Job Notifier now uses ${DEFAULT_MODEL.name}.`;
    $('model-note').hidden = false;
  } else {
    $('model-note').hidden = true;
  }
  friends = JN.storedFriends(res.friends);
  renderFriends();
  return true;
}

function handleLockTransition(focus = true) {
  clearSensitiveDom();
  renderVaultState('locked', {
    focus,
    statusId: 'unlock-status',
    statusText: 'Locked. Your API key and friends were cleared from memory.',
  });
}

// ── Vault actions ──

async function submitSetup(e) {
  e.preventDefault();
  if (vaultBusy) return;
  const pass = validatePassphrasePair('setup-passphrase', 'setup-confirm');
  if (!pass) return;

  setVaultPending('setup', true);
  ignoringNextVaultChanged = true;
  let res;
  try {
    res = await sendWorker({ type: 'VAULT_SETUP', passphrase: pass });
  } finally {
    clearPassphraseInputs();
    setVaultPending('setup', false);
    ignoringNextVaultChanged = false;
  }
  if (res?.ok) {
    renderVaultState('unlocked', {
      focus: true,
      statusId: 'vault-status',
      statusText: 'Passphrase created. Unlocked for this session.',
    });
    await loadUnlockedData();
    return;
  }
  if (res?.code === 'LOCKED') return loadVault({ focus: true });
  say('setup-status', res?.error || "Couldn't create passphrase.", true);
}

async function submitConvert(e) {
  e.preventDefault();
  if (vaultBusy) return;
  $('convert-error-block').hidden = true;
  say('convert-error', '');
  const pass = validatePassphrasePair('convert-passphrase', 'convert-confirm');
  if (!pass) return;

  setVaultPending('convert', true);
  ignoringNextVaultChanged = true;
  let res;
  try {
    res = await sendWorker({ type: 'VAULT_CONVERT_LEGACY', passphrase: pass });
  } finally {
    clearPassphraseInputs();
    setVaultPending('convert', false);
    ignoringNextVaultChanged = false;
  }
  if (res?.ok) {
    renderVaultState('unlocked', {
      focus: true,
      statusId: 'vault-status',
      statusText: 'Existing data encrypted and unlocked for this session.',
    });
    await loadUnlockedData();
    return;
  }
  if (res?.code === 'LOCKED') return loadVault({ focus: true });
  if (res?.code === 'WORKER_UNAVAILABLE') return say('convert-error', res.error, true);
  $('convert-error-block').hidden = false;
  $('convert-error-heading').focus();
}

async function submitUnlock(e) {
  e.preventDefault();
  if (vaultBusy) return;
  clearErrors(['unlock-passphrase']);
  say('unlock-status', '');
  const pass = $('unlock-passphrase').value;
  if (!pass.length) {
    setError('unlock-passphrase', 'Enter your passphrase.');
    $('unlock-passphrase').value = '';
    $('unlock-passphrase').focus();
    return;
  }

  setVaultPending('unlock', true);
  ignoringNextVaultChanged = true;
  let res;
  try {
    res = await sendWorker({ type: 'VAULT_UNLOCK', passphrase: pass });
  } finally {
    clearPassphraseInputs();
    setVaultPending('unlock', false);
    ignoringNextVaultChanged = false;
  }
  if (res?.ok) {
    renderVaultState('unlocked', { focus: true });
    await loadUnlockedData();
    return;
  }
  if (res?.code === 'UNREADABLE') {
    renderVaultState('unreadable', { focus: true });
    return;
  }
  if (res?.code === 'UNINITIALIZED') {
    renderVaultState('uninitialized', { focus: true });
    return;
  }
  if (res?.code === 'LOCKED') return loadVault({ focus: true });
  if (res?.code === 'WORKER_UNAVAILABLE') say('unlock-status', res.error, true);
  else setError('unlock-passphrase', 'Wrong passphrase. Try again, or use Forgot passphrase? to erase saved data and start over.');
  $('unlock-passphrase').focus();
}

async function onLockClick() {
  if (vaultBusy) return;
  setVaultPending('lock', true);
  try {
    await sendWorker({ type: 'VAULT_LOCK' });
  } finally {
    setVaultPending('lock', false);
  }
  handleLockTransition(true);
}

function openResetPanel(openerId) {
  if (vaultBusy) return;
  resetOpener = openerId;
  $('reset-confirm-check').checked = false;
  $('reset-confirm-error').textContent = '';
  $('reset-panel').hidden = false;
  $('reset-heading').focus();
}

function closeResetPanel() {
  if (vaultBusy) return;
  const opener = resetOpener;
  resetOpener = null;
  $('reset-panel').hidden = true;
  $('reset-confirm-check').checked = false;
  $('reset-confirm-error').textContent = '';
  if (opener && $(opener)) $(opener).focus();
}

async function confirmReset() {
  if (vaultBusy) return;
  $('reset-confirm-error').textContent = '';
  if (!$('reset-confirm-check').checked) {
    $('reset-confirm-error').textContent = 'Check the box to confirm you want to erase your saved data.';
    $('reset-confirm-check').focus();
    return;
  }
  setVaultPending('reset', true);
  ignoringNextVaultChanged = true;
  let res;
  try {
    res = await sendWorker({ type: 'VAULT_RESET' });
  } finally {
    clearSensitiveDom();
    setVaultPending('reset', false);
    ignoringNextVaultChanged = false;
  }
  if (res?.ok) {
    renderVaultState('uninitialized', {
      focus: true,
      statusId: 'setup-status',
      statusText: 'Saved data erased. Create a new passphrase to start fresh.',
    });
  }
}

// ── Claude ──

async function saveClaude(e) {
  e.preventDefault();
  if (vaultBusy || currentVaultState !== 'unlocked') return;
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

  ignoringNextVaultChanged = true;
  let res;
  try {
    res = await sendWorker({
      type: 'VAULT_SAVE_CLAUDE',
      apiKey,
      model: $('model').value,
      effort: $('effort').value,
      threshold,
      expectedRev: currentVaultRev,
    });
  } finally {
    ignoringNextVaultChanged = false;
  }
  if (currentVaultState !== 'unlocked') return;
  if (res?.ok) {
    currentVaultRev = res.vaultRev;
    $('model-note').hidden = true;
    say('claude-status', !apiKey && hadKey ? 'Saved. Your API key was removed from this browser.'
      : !friends.length ? 'Saved. Next, add at least one friend below.' : 'Saved.');
    hadKey = !!apiKey;
    return;
  }
  if (res?.code === 'LOCKED') return loadVault({ focus: true });
  if (res?.code === 'STALE_EDIT') {
    await loadUnlockedData();
    if (currentVaultState !== 'unlocked') return;
    return say('claude-status', 'Settings changed in another tab. Reloaded the latest saved data.', true);
  }
  say('claude-status', res?.error || 'Could not save settings.', true);
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

// Returns null when saved, or the validator/worker error message.
async function saveFriends(list) {
  const result = JN.cleanFriends(list);
  if (result.error) return result.error;
  ignoringNextVaultChanged = true;
  let res;
  try {
    res = await sendWorker({
      type: 'VAULT_SAVE_FRIENDS',
      friends: result.friends,
      expectedRev: currentVaultRev,
    });
  } finally {
    ignoringNextVaultChanged = false;
  }
  if (currentVaultState !== 'unlocked') return null;
  if (res?.ok) {
    currentVaultRev = res.vaultRev;
    friends = result.friends;
    renderFriends();
    return null;
  }
  if (res?.code === 'LOCKED') {
    await loadVault({ focus: true });
    return null;
  }
  if (res?.code === 'STALE_EDIT') {
    await loadUnlockedData();
    if (currentVaultState !== 'unlocked') return null;
    return 'Friends changed in another tab. Reloaded the latest list.';
  }
  return res?.error || 'Could not save friends.';
}

async function setInclude(i, on) {
  const error = await saveFriends(friends.map((f, j) => (j === i ? { ...f, notify: on } : f)));
  if (error) return say('friends-status', error, true);
  if (currentVaultState === 'unlocked' && $('friend-list').children[i]) {
    $('friend-list').children[i].querySelector('input').focus();
  }
}

async function removeFriend(i) {
  const { name } = friends[i];
  if (!confirm(`Remove ${name} from your friends list?`)) return;
  if (editing >= 0) closeForm();
  const error = await saveFriends(friends.filter((_, j) => j !== i));
  if (currentVaultState !== 'unlocked') return;
  if (error) return say('friends-status', error, true);
  say('friends-status', `Removed ${name}.`);
  // An empty list reopens the add form, which hides the Add friend button.
  (editButton(i) || editButton(i - 1) || $('f-name')).focus();
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
  $('add-friend').hidden = i < 0; // no second "Add friend" while the add form is open
  if (focus) $('f-name').focus();
}

function hideForm() {
  $('friend-form').hidden = true;
  $('add-friend').hidden = false;
  editing = -1;
}

function closeForm() {
  if (!friends.length) return; // the form stays open while the list is empty
  const back = editing >= 0 ? editButton(editing) : null;
  hideForm();
  return back || $('add-friend');
}

const splitList = s => s.split(',').map(x => x.trim()).filter(Boolean);
const tooLong = list => list.length > 50 || list.some(x => x.length > 100);

async function submitFriend(e) {
  e.preventDefault();
  if (currentVaultState !== 'unlocked') return;
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
  if (currentVaultState !== 'unlocked') return;
  if (error) return say('friends-status', error, true);
  const index = adding ? friends.length - 1 : editing;
  hideForm();
  editButton(index).focus();
  say('friends-status', adding ? `Added ${entry.name}.` : `Saved changes to ${entry.name}.`);
}

// ── Import and export ──

async function onImportFile() {
  if (currentVaultState !== 'unlocked') return;
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
    if (currentVaultState !== 'unlocked') return;
    if (error) {
      $('import-error').textContent = `Couldn't import ${file.name}: ${error}`;
      return;
    }
    if (friends.length) hideForm();
    say('friends-status', `Imported ${plural(n)} from ${file.name}.`);
    return;
  }
  pendingImport = { file: file.name, friends: result.friends };
  $('import-summary').textContent = `${file.name} has ${plural(n)}. Your list has ${friends.length}.`;
  $('import-panel').hidden = false;
  $('import-summary').focus();
}

async function applyImport(replace) {
  if (currentVaultState !== 'unlocked' || !pendingImport) return;
  const { file, friends: incoming } = pendingImport;
  pendingImport = null;
  $('import-panel').hidden = true;
  if (editing >= 0) closeForm();
  const error = await saveFriends(replace ? incoming : [...friends, ...incoming]);
  if (currentVaultState !== 'unlocked') return;
  if (error) $('import-error').textContent = `Couldn't import ${file}: ${error}`;
  else {
    const n = plural(incoming.length);
    say('friends-status', replace ? `Replaced your list with ${n} from ${file}.` : `Added ${n} from ${file}.`);
  }
  $('import-btn').focus();
}

// Writes only the friends list, in the format Import accepts. No key, no settings (P2).
function exportFriends() {
  if (currentVaultState !== 'unlocked' || !friends.length) return;
  const url = URL.createObjectURL(new Blob([JSON.stringify(friends, null, 2)], { type: 'application/json' }));
  h('a', { href: url, download: 'job-notifier-friends.json' }).click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// ── Auto-detect (criteria 7, 36) ──

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

// ── Load & sync ──

async function loadVault({ focus = false } = {}) {
  const status = await sendWorker({ type: 'VAULT_STATUS' }).catch(() => null);
  const state = status?.vaultState || 'locked';
  renderVaultState(state, { summary: status?.legacySummary, focus });
  if (status?.code === 'WORKER_UNAVAILABLE') say('unlock-status', status.error, true);
  if (state === 'unlocked') await loadUnlockedData();
}

document.addEventListener('DOMContentLoaded', () => {
  $('version').textContent = chrome.runtime.getManifest().version;
  $('model').replaceChildren(...JN.MODELS.map(m =>
    h('option', { value: m.id }, m.id === DEFAULT_MODEL.id ? `${m.name} (default, lower cost)` : m.name)));

  $('setup-form').addEventListener('submit', submitSetup);
  $('convert-form').addEventListener('submit', submitConvert);
  $('unlock-form').addEventListener('submit', submitUnlock);
  $('lock-btn').addEventListener('click', onLockClick);
  $('forgot-btn').addEventListener('click', () => openResetPanel('forgot-btn'));
  $('convert-reset-toggle').addEventListener('click', () => openResetPanel('convert-reset-toggle'));
  $('unreadable-reset-btn').addEventListener('click', () => openResetPanel('unreadable-reset-btn'));
  $('reset-cancel-btn').addEventListener('click', closeResetPanel);
  $('reset-confirm-btn').addEventListener('click', confirmReset);

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

  chrome.runtime.onMessage.addListener(msg => {
    if (msg?.type === 'VAULT_LOCKED') {
      handleLockTransition(true);
    } else if (msg?.type === 'VAULT_CHANGED') {
      if (ignoringNextVaultChanged && (vaultBusy || msg.vaultState === 'unlocked')) return;
      loadVault({ focus: false });
    }
  });

  renderAuto();
  loadVault({ focus: false });
});
