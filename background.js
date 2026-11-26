importScripts('lib/core.js');

// Storage (criterion 34, P-01 through P-08):
// - chrome.storage.local:
//     vault: encrypted { v: 1, kdf, cipher, ct } holding { v: 1, apiKey, friends }
//     settings: { model, effort, threshold } (non-sensitive preferences only)
//     autoDetect: boolean
// - chrome.storage.session (memory only, cleared when Chrome closes, not readable
//   by content scripts):
//     vaultKey: base64 256-bit derived key while unlocked for this session
//     jobs: { [tabId]: posting }
//     prompts: { [tabId]: posting offered on a confirmation page }
//     prompted: [posting hashes already offered]

const SITES = { origins: JN.ALL_SITES };
const SCRIPT_ID = 'job-notifier-detect';
const API_TIMEOUT_MS = 25000;
const API_TIMEOUT_ERROR = {
  ...JN.ERRORS.timeout,
  body: `There was no response after ${API_TIMEOUT_MS / 1000} seconds. Try again.`,
};

// ── Non-sensitive settings (apiKey is never written to or read from settings) ──

function cleanNonSensitiveSettings(settings) {
  const s = settings && typeof settings === 'object' ? settings : {};
  const norm = JN.normalizeSettings({ model: s.model, effort: s.effort, threshold: s.threshold });
  return { model: norm.model, effort: norm.effort, threshold: norm.threshold };
}

async function getNonSensitiveSettings() {
  const { settings, autoDetect } = await chrome.storage.local.get(['settings', 'autoDetect']);
  const s = settings && typeof settings === 'object' ? settings : {};
  return JN.normalizeSettings({ model: s.model, effort: s.effort, threshold: s.threshold, autoDetect });
}

// ── Vault concurrency, epoch, and key lifecycle ──

let vaultOperations = Promise.resolve();
let vaultEpoch = 0;
const activeAnalyses = new Set();

function inVault(step) {
  const run = vaultOperations.then(step);
  vaultOperations = run.catch(() => {});
  return run;
}

function abortAllAnalyses() {
  for (const controller of activeAnalyses) {
    try { controller.abort(); } catch (e) {}
  }
  activeAnalyses.clear();
}

function computeVaultRev(vault) {
  return `${vault.kdf.salt}|${vault.cipher.iv}|${JN.hashText(vault.ct)}|${vault.ct.length}`;
}

function broadcast(msg) {
  try {
    return Promise.resolve(chrome.runtime.sendMessage?.(msg)).catch(() => {});
  } catch (e) {
    return Promise.resolve();
  }
}

async function inspectVaultState() {
  const local = await chrome.storage.local.get(['vault', 'settings', 'friends']);
  if (Object.prototype.hasOwnProperty.call(local, 'vault') && local.vault !== undefined) {
    if (!JN.validateVaultEnvelope(local.vault)) {
      return { vaultState: 'unreadable', local };
    }
    const { vaultKey } = await chrome.storage.session.get('vaultKey');
    if (typeof vaultKey !== 'string' || !vaultKey) {
      return { vaultState: 'locked', local, vault: local.vault };
    }
    const keyBytes = JN.base64ToBytes(vaultKey);
    if (!keyBytes || keyBytes.length !== 32) {
      await chrome.storage.session.remove('vaultKey');
      return { vaultState: 'locked', local, vault: local.vault };
    }
    try {
      const cryptoKey = await JN.importVaultKey(keyBytes);
      const data = await JN.decryptVault(local.vault, cryptoKey);
      return {
        vaultState: 'unlocked',
        local,
        vault: local.vault,
        cryptoKey,
        data,
        vaultRev: computeVaultRev(local.vault),
      };
    } catch (e) {
      if (e?.code === 'UNREADABLE') {
        return { vaultState: 'unreadable', local, vault: local.vault };
      }
      await chrome.storage.session.remove('vaultKey');
      return { vaultState: 'locked', local, vault: local.vault };
    } finally {
      keyBytes.fill(0);
    }
  }

  if (JN.detectLegacyPreEncryption200(local)) {
    return {
      vaultState: 'needs-conversion',
      local,
      legacySummary: {
        hasKey: !!(local.settings && typeof local.settings.apiKey === 'string' && local.settings.apiKey.trim()),
        friendCount: Array.isArray(local.friends) ? local.friends.length : 0,
      },
    };
  }

  return { vaultState: 'uninitialized', local };
}

async function cleanupResidualLegacy(local) {
  if (local.settings && typeof local.settings === 'object' && Object.prototype.hasOwnProperty.call(local.settings, 'apiKey')) {
    await chrome.storage.local.set({ settings: cleanNonSensitiveSettings(local.settings) });
  }
  if (Object.prototype.hasOwnProperty.call(local, 'friends')) {
    await chrome.storage.local.remove('friends');
  }
}

function handleVaultLock() {
  vaultEpoch++;
  abortAllAnalyses();
  running.clear();
  return inVault(async () => {
    await chrome.storage.session.remove('vaultKey');
    await broadcast({ type: 'VAULT_LOCKED' });
    return { ok: true, vaultState: 'locked' };
  });
}

function handleVaultReset() {
  vaultEpoch++;
  abortAllAnalyses();
  running.clear();
  return inVault(async () => {
    const { settings } = await chrome.storage.local.get('settings');
    await chrome.storage.local.remove(['vault', 'friends']);
    if (settings && typeof settings === 'object' && Object.prototype.hasOwnProperty.call(settings, 'apiKey')) {
      await chrome.storage.local.set({ settings: cleanNonSensitiveSettings(settings) });
    }
    await chrome.storage.session.remove('vaultKey');
    await broadcast({ type: 'VAULT_CHANGED', vaultState: 'uninitialized' });
    return { ok: true, vaultState: 'uninitialized' };
  });
}

function handlePopupStatus() {
  return inVault(async () => {
    const info = await inspectVaultState();
    if (info.vaultState !== 'unlocked') return { vaultState: info.vaultState };
    return {
      vaultState: 'unlocked',
      hasKey: !!info.data.apiKey,
      friendsStatus: JN.friendsStatus(info.data.friends),
    };
  });
}

function handleVaultSetup(msg) {
  const err = JN.validatePassphrase(msg?.passphrase);
  if (err) return Promise.resolve({ ok: false, code: 'INVALID_PASSPHRASE', error: err });
  const startEpoch = vaultEpoch;

  return inVault(async () => {
    const info = await inspectVaultState();
    if (info.vaultState !== 'uninitialized') {
      return { ok: false, code: info.vaultState.toUpperCase(), error: 'Vault is already initialized or needs conversion.' };
    }
    const kdf = JN.newVaultKdf();
    const saltBytes = JN.base64ToBytes(kdf.salt);
    const keyBytes = await JN.deriveVaultKeyBytes(msg.passphrase, saltBytes, kdf.iterations);
    try {
      if (startEpoch !== vaultEpoch) return { ok: false, code: 'LOCKED' };
      const cryptoKey = await JN.importVaultKey(keyBytes);
      const envelope = await JN.encryptVault({ v: 1, apiKey: '', friends: [] }, cryptoKey, kdf);
      if (startEpoch !== vaultEpoch) return { ok: false, code: 'LOCKED' };
      try {
        await chrome.storage.local.set({ vault: envelope });
      } catch (e) {
        return { ok: false, code: 'STORAGE_ERROR', error: 'Could not save passphrase vault.' };
      }
      if (startEpoch !== vaultEpoch) return { ok: false, code: 'LOCKED' };
      await chrome.storage.session.set({ vaultKey: JN.bytesToBase64(keyBytes) });
      if (startEpoch !== vaultEpoch) {
        await chrome.storage.session.remove('vaultKey');
        return { ok: false, code: 'LOCKED' };
      }
      await broadcast({ type: 'VAULT_CHANGED', vaultState: 'unlocked' });
      return { ok: true, vaultState: 'unlocked', vaultRev: computeVaultRev(envelope) };
    } finally {
      keyBytes.fill(0);
    }
  });
}

function handleVaultUnlock(msg) {
  if (typeof msg?.passphrase !== 'string' || !msg.passphrase.length) {
    return Promise.resolve({ ok: false, code: 'INVALID_PASSPHRASE', error: 'Enter a passphrase.' });
  }
  const startEpoch = vaultEpoch;

  return inVault(async () => {
    const local = await chrome.storage.local.get(['vault', 'settings', 'friends']);
    if (!Object.prototype.hasOwnProperty.call(local, 'vault') || local.vault === undefined) {
      return { ok: false, code: 'UNINITIALIZED', error: 'No passphrase vault exists.' };
    }
    if (!JN.validateVaultEnvelope(local.vault)) {
      return { ok: false, code: 'UNREADABLE', vaultState: 'unreadable', error: 'Stored vault is unreadable.' };
    }
    const saltBytes = JN.base64ToBytes(local.vault.kdf.salt);
    const keyBytes = await JN.deriveVaultKeyBytes(msg.passphrase, saltBytes, local.vault.kdf.iterations);
    try {
      if (startEpoch !== vaultEpoch) return { ok: false, code: 'LOCKED' };
      const cryptoKey = await JN.importVaultKey(keyBytes);
      try {
        await JN.decryptVault(local.vault, cryptoKey);
      } catch (e) {
        if (e?.code === 'UNREADABLE') {
          return { ok: false, code: 'UNREADABLE', vaultState: 'unreadable', error: 'Stored vault is unreadable.' };
        }
        return { ok: false, code: 'WRONG_PASSPHRASE', error: 'Wrong passphrase.' };
      }
      if (startEpoch !== vaultEpoch) return { ok: false, code: 'LOCKED' };
      await chrome.storage.session.set({ vaultKey: JN.bytesToBase64(keyBytes) });
      if (startEpoch !== vaultEpoch) {
        await chrome.storage.session.remove('vaultKey');
        return { ok: false, code: 'LOCKED' };
      }
      await cleanupResidualLegacy(local);
      await broadcast({ type: 'VAULT_CHANGED', vaultState: 'unlocked' });
      return { ok: true, vaultState: 'unlocked', vaultRev: computeVaultRev(local.vault) };
    } finally {
      keyBytes.fill(0);
    }
  });
}

function handleVaultConvertLegacy(msg) {
  const err = JN.validatePassphrase(msg?.passphrase);
  if (err) return Promise.resolve({ ok: false, code: 'INVALID_PASSPHRASE', error: err });
  const startEpoch = vaultEpoch;

  return inVault(async () => {
    const local = await chrome.storage.local.get(['vault', 'settings', 'friends']);
    if (Object.prototype.hasOwnProperty.call(local, 'vault') && local.vault !== undefined) {
      return { ok: false, code: 'ALREADY_INITIALIZED', error: 'Encrypted vault already exists.' };
    }
    if (!JN.detectLegacyPreEncryption200(local)) {
      return { ok: false, code: 'NOT_CONVERTIBLE', error: 'No convertible pre-encryption 2.0.0 data found.' };
    }
    const apiKey = JN.str(local.settings?.apiKey, 500);
    const friends = JN.storedFriends(local.friends);
    const kdf = JN.newVaultKdf();
    const saltBytes = JN.base64ToBytes(kdf.salt);
    const keyBytes = await JN.deriveVaultKeyBytes(msg.passphrase, saltBytes, kdf.iterations);
    let wroteVault = false;

    try {
      if (startEpoch !== vaultEpoch) return { ok: false, code: 'LOCKED' };
      const cryptoKey = await JN.importVaultKey(keyBytes);
      const envelope = await JN.encryptVault({ v: 1, apiKey, friends }, cryptoKey, kdf);
      if (startEpoch !== vaultEpoch) return { ok: false, code: 'LOCKED' };

      // Write vault first while preserving original legacy fields until read-back authentication succeeds.
      await chrome.storage.local.set({ vault: envelope });
      wroteVault = true;

      const { vault: readBack } = await chrome.storage.local.get('vault');
      if (!JN.validateVaultEnvelope(readBack)) throw new Error('Vault read-back validation failed');
      const verified = await JN.decryptVault(readBack, cryptoKey);
      if (verified.apiKey !== apiKey || JSON.stringify(verified.friends) !== JSON.stringify(friends)) {
        throw new Error('Vault read-back mismatch');
      }

      if (startEpoch !== vaultEpoch) {
        await chrome.storage.local.remove('vault').catch(() => {});
        return { ok: false, code: 'LOCKED' };
      }

      // Vault is verified; never delete it if residual cleanup or session write fails.
      wroteVault = false;
      await cleanupResidualLegacy(local);
      await chrome.storage.session.set({ vaultKey: JN.bytesToBase64(keyBytes) });
      if (startEpoch !== vaultEpoch) {
        await chrome.storage.session.remove('vaultKey');
        return { ok: false, code: 'LOCKED' };
      }
      await broadcast({ type: 'VAULT_CHANGED', vaultState: 'unlocked' });
      return { ok: true, vaultState: 'unlocked', vaultRev: computeVaultRev(envelope) };
    } catch (e) {
      if (wroteVault) await chrome.storage.local.remove('vault').catch(() => {});
      return { ok: false, code: 'CONVERT_FAILED', error: 'Could not encrypt saved data.' };
    } finally {
      keyBytes.fill(0);
    }
  });
}

function handleVaultGetData() {
  return inVault(async () => {
    const info = await inspectVaultState();
    if (info.vaultState !== 'unlocked') {
      return { ok: false, code: info.vaultState === 'locked' ? 'LOCKED' : info.vaultState.toUpperCase(), vaultState: info.vaultState };
    }
    const rawSettings = info.local.settings;
    const settings = cleanNonSensitiveSettings(rawSettings);
    const storedModel = rawSettings && typeof rawSettings.model === 'string' ? rawSettings.model : undefined;
    return {
      ok: true,
      apiKey: info.data.apiKey,
      friends: info.data.friends,
      settings,
      storedModel,
      vaultRev: info.vaultRev,
    };
  });
}

function saveUnlockedVault(msg, staleMessage, buildUpdate) {
  const startEpoch = vaultEpoch;
  return inVault(async () => {
    if (startEpoch !== vaultEpoch) return { ok: false, code: 'LOCKED' };
    const info = await inspectVaultState();
    if (info.vaultState !== 'unlocked') {
      return { ok: false, code: info.vaultState === 'locked' ? 'LOCKED' : info.vaultState.toUpperCase(), vaultState: info.vaultState };
    }
    if (msg?.expectedRev !== info.vaultRev) {
      return { ok: false, code: 'STALE_EDIT', error: staleMessage };
    }
    const update = buildUpdate(info);
    if (update.errorReply) return update.errorReply;
    const newEnvelope = await JN.encryptVault(update.payload, info.cryptoKey, info.vault.kdf);
    if (startEpoch !== vaultEpoch) return { ok: false, code: 'LOCKED' };
    const items = update.settings ? { vault: newEnvelope, settings: update.settings } : { vault: newEnvelope };
    try {
      await chrome.storage.local.set(items);
    } catch (e) {
      return { ok: false, code: 'STORAGE_ERROR', error: 'Could not save changes.' };
    }
    if (startEpoch !== vaultEpoch) return { ok: false, code: 'LOCKED' };
    await broadcast({ type: 'VAULT_CHANGED', vaultState: 'unlocked' });
    return { ok: true, vaultRev: computeVaultRev(newEnvelope) };
  });
}

function handleVaultSaveClaude(msg) {
  return saveUnlockedVault(msg, 'Settings changed in another tab. Reloading latest data.', info => {
    const apiKey = JN.str(msg.apiKey, 500);
    if (apiKey && !apiKey.startsWith('sk-ant-')) {
      return { errorReply: { ok: false, code: 'INVALID_INPUT', error: 'That doesn\'t look like an Anthropic API key. Keys start with "sk-ant-".' } };
    }
    if (typeof msg.threshold !== 'number' || !Number.isFinite(msg.threshold) || msg.threshold < 0 || msg.threshold > 1) {
      return { errorReply: { ok: false, code: 'INVALID_INPUT', error: 'Enter a number from 0 to 1, like 0.6.' } };
    }
    return {
      payload: { v: 1, apiKey, friends: info.data.friends },
      settings: cleanNonSensitiveSettings({ model: msg.model, effort: msg.effort, threshold: msg.threshold }),
    };
  });
}

function handleVaultSaveFriends(msg) {
  return saveUnlockedVault(msg, 'Friends changed in another tab. Reloading latest data.', info => {
    const cleaned = JN.cleanFriends(msg.friends);
    if (cleaned.error) return { errorReply: { ok: false, code: 'INVALID_FRIENDS', error: cleaned.error } };
    return { payload: { v: 1, apiKey: info.data.apiKey, friends: cleaned.friends } };
  });
}

function handleSettingsVaultMessage(msg) {
  switch (msg.type) {
    case 'VAULT_STATUS':
      return inVault(async () => {
        const info = await inspectVaultState();
        if (info.vaultState === 'needs-conversion') {
          return { ok: true, vaultState: info.vaultState, legacySummary: info.legacySummary };
        }
        return { ok: true, vaultState: info.vaultState };
      });
    case 'VAULT_SETUP':
      return handleVaultSetup(msg);
    case 'VAULT_UNLOCK':
      return handleVaultUnlock(msg);
    case 'VAULT_RESET':
      return handleVaultReset();
    case 'VAULT_GET_DATA':
      return handleVaultGetData();
    case 'VAULT_SAVE_CLAUDE':
      return handleVaultSaveClaude(msg);
    case 'VAULT_SAVE_FRIENDS':
      return handleVaultSaveFriends(msg);
    case 'VAULT_CONVERT_LEGACY':
      return handleVaultConvertLegacy(msg);
    default:
      return Promise.resolve({ ok: false });
  }
}

// ── Auto-detect (Decision 14, criteria 4 and 36) ──
// The content script is registered only while the setting is on and Chrome has
// granted all-sites access. The popup and settings page request the permission
// and write `autoDetect`; this worker drives everything else from these events,
// because the popup can close while Chrome's permission dialog is open.

let syncing = Promise.resolve();

function syncAutoDetect() {
  syncing = syncing.then(applyAutoDetect).catch(() => {});
  return syncing;
}

async function applyAutoDetect() {
  const [{ autoDetect }, access, scripts] = await Promise.all([
    chrome.storage.local.get('autoDetect'),
    chrome.permissions.contains(SITES),
    chrome.scripting.getRegisteredContentScripts({ ids: [SCRIPT_ID] }),
  ]);
  const on = autoDetect === true && access;
  // Site access removed in Chrome's extension settings: the setting follows.
  if (autoDetect === true && !access) await chrome.storage.local.set({ autoDetect: false });
  if (on && !scripts.length) {
    await chrome.scripting.registerContentScripts([
      { id: SCRIPT_ID, matches: JN.ALL_SITES, js: ['lib/core.js', 'content.js'], runAt: 'document_idle' },
    ]);
  }
  if (on || (!scripts.length && !access)) return;
  contentDocuments.clear();
  if (scripts.length) await chrome.scripting.unregisterContentScripts({ ids: [SCRIPT_ID] });
  if (access) await chrome.permissions.remove(SITES);
  await inSession(() => chrome.storage.session.remove('prompts'));
  // Scripts already running in open pages stop reading them too.
  for (const tab of await chrome.tabs.query({})) {
    chrome.tabs.sendMessage(tab.id, { type: 'STOP' }).catch(() => {});
  }
}

// Granting all-sites access is how auto-detect gets turned on.
chrome.permissions.onAdded.addListener(async () => {
  if (await chrome.permissions.contains(SITES)) await chrome.storage.local.set({ autoDetect: true });
  syncAutoDetect();
});
chrome.permissions.onRemoved.addListener(() => syncAutoDetect());
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || !('autoDetect' in changes)) return;
  if (changes.autoDetect.newValue !== true) contentDocuments.clear();
  syncAutoDetect();
});
chrome.runtime.onStartup.addListener(() => syncAutoDetect());
chrome.runtime.onInstalled.addListener(details => {
  if (details.reason === 'install') chrome.runtime.openOptionsPage();
  syncAutoDetect();
});

// ── Postings and confirmation prompts, per tab ──

function originOf(url) {
  try {
    return new URL(url).origin;
  } catch (e) {
    return '';
  }
}

// Serialize session map changes and prompt lookups so tabs don't overwrite
// each other's entries or retrieve a prompt while its deletion is queued.
let sessionOperations = Promise.resolve();
// Tokens invalidate in-flight content messages when the tab closes or auto-detect turns off.
const contentDocuments = new Map();

function currentDocument(tabId) {
  if (!contentDocuments.has(tabId)) contentDocuments.set(tabId, Symbol());
  const token = contentDocuments.get(tabId);
  return () => contentDocuments.get(tabId) === token;
}

function inSession(step) {
  const run = sessionOperations.then(step);
  sessionOperations = run.catch(() => {});
  return run;
}

// Only the posting's hostname is kept as `url`.
function rememberJob(sender, msg, isCurrent) {
  return inSession(async () => {
    const { jobs = {} } = await chrome.storage.session.get('jobs');
    if (!isCurrent()) return;
    jobs[sender.tab.id] = { text: msg.text, title: msg.title || '', url: new URL(sender.url).hostname, seenAt: Date.now(), hash: JN.hashText(msg.text) };
    await chrome.storage.session.set({ jobs });
  });
}

// A confirmation page in `tab` can offer a posting from the same tab or its
// opener tab (Decision 13), once per posting. Resolves to whether to show the prompt.
function offerPrompt(sender, isCurrent) {
  return inSession(async () => {
    const { jobs = {}, prompts = {}, prompted = [] } = await chrome.storage.session.get(['jobs', 'prompts', 'prompted']);
    // Without the browser's document ID the prompt can't be tied to this page (fail closed).
    if (!isCurrent() || !sender.documentId) return false;
    const posting = JN.recallPosting(jobs, sender.tab);
    if (!posting || prompted.includes(posting.hash)) return false;
    prompts[sender.tab.id] = { ...posting, origin: originOf(sender.url), contentDocumentId: sender.documentId };
    await chrome.storage.session.set({ prompts, prompted: [...prompted, posting.hash].slice(-100) });
    return isCurrent();
  });
}

// Read inside the session queue, after any navigation cleanup already enqueued.
function readPrompt(prompts, tab) {
  const prompt = prompts[tab.id];
  return prompt && prompt.origin === originOf(tab.url) ? prompt : null;
}

// A stored prompt is used only while the page that reported it is still loaded
// (criterion 31): a no-data ping to its document fails after a reload, navigation,
// or back/forward. Same-document URL changes (pushState, hash) keep the document.
// Must run inside the session queue; a stale prompt is deleted.
async function livePrompt(prompts, tab) {
  const prompt = readPrompt(prompts, tab);
  if (prompt?.contentDocumentId) {
    try {
      await chrome.tabs.sendMessage(tab.id, { type: 'DOCUMENT_PING' }, { documentId: prompt.contentDocumentId });
      return prompt;
    } catch (e) {
      // The document is gone.
    }
  }
  if (prompts[tab.id]) {
    delete prompts[tab.id];
    await chrome.storage.session.set({ prompts });
  }
  return null;
}

// Drops the tab's prompt, or with `keepDocumentId`, only a prompt from another document.
function dropPrompt(tabId, keepDocumentId) {
  return inSession(async () => {
    const { prompts = {} } = await chrome.storage.session.get('prompts');
    const prompt = prompts[tabId];
    if (!prompt || (keepDocumentId && keepDocumentId === prompt.contentDocumentId)) return;
    delete prompts[tabId];
    await chrome.storage.session.set({ prompts });
  });
}

chrome.tabs.onRemoved.addListener(tabId => {
  contentDocuments.delete(tabId);
  return inSession(async () => {
    const { jobs = {}, prompts = {} } = await chrome.storage.session.get(['jobs', 'prompts']);
    if (!jobs[tabId] && !prompts[tabId]) return;
    delete jobs[tabId];
    delete prompts[tabId];
    await chrome.storage.session.set({ jobs, prompts });
  });
});

// ── Claude ──

// Resolves to the reply the popup or overlay gets. Never throws.
async function analyze(jobText) {
  // Captured before queueing, so a Lock sent right after the request still stops it (security Low 1).
  const analysisEpoch = vaultEpoch;
  const snapshot = await inVault(async () => {
    if (analysisEpoch !== vaultEpoch) return { errorReply: { ok: false, code: 'LOCKED' } };
    const info = await inspectVaultState();
    if (info.vaultState !== 'unlocked') {
      return { errorReply: { ok: false, code: info.vaultState === 'needs-conversion' ? 'NEEDS_CONVERSION' : info.vaultState.toUpperCase() } };
    }
    if (!info.data.apiKey) return { errorReply: { ok: false, code: 'NO_API_KEY' } };
    const status = JN.friendsStatus(info.data.friends);
    if (status !== 'ok') return { errorReply: { ok: false, code: 'NO_FRIENDS', friends: status } };
    const settings = await getNonSensitiveSettings();
    return {
      analysisEpoch,
      friends: info.data.friends,
      settings: { ...settings, apiKey: info.data.apiKey },
    };
  });

  if (snapshot.errorReply) return snapshot.errorReply;
  if (snapshot.analysisEpoch !== vaultEpoch) return { ok: false, code: 'LOCKED' };

  const req = JN.buildRequest(jobText, snapshot.friends, snapshot.settings);
  // Finish before Chrome's 30 s service worker fetch-response deadline, and allow
  // synchronous abort when the vault locks mid-flight.
  const controller = new AbortController();
  activeAnalyses.add(controller);
  const timeoutSignal = AbortSignal.timeout(API_TIMEOUT_MS);
  const onTimeout = () => controller.abort(timeoutSignal.reason);
  if (timeoutSignal.aborted) onTimeout();
  else timeoutSignal.addEventListener('abort', onTimeout, { once: true });

  const timedOut = e => e?.name === 'TimeoutError';
  let response;
  try {
    if (snapshot.analysisEpoch !== vaultEpoch) return { ok: false, code: 'LOCKED' };
    try {
      response = await fetch(req.url, { method: 'POST', headers: req.headers, body: JSON.stringify(req.body), signal: controller.signal });
    } catch (e) {
      if (snapshot.analysisEpoch !== vaultEpoch) return { ok: false, code: 'LOCKED' };
      return { ok: false, error: timedOut(e) ? API_TIMEOUT_ERROR : JN.describeApiError(0) };
    }
    if (snapshot.analysisEpoch !== vaultEpoch) return { ok: false, code: 'LOCKED' };
    if (!response.ok) {
      const errBody = await response.json().catch(() => null);
      if (snapshot.analysisEpoch !== vaultEpoch) return { ok: false, code: 'LOCKED' };
      return { ok: false, error: JN.describeApiError(response.status, errBody) };
    }
    try {
      const data = await response.json();
      if (snapshot.analysisEpoch !== vaultEpoch) return { ok: false, code: 'LOCKED' };
      // threshold (normalized, 0-1) lets the overlay name it without reading storage.
      return { ok: true, result: JN.parseResponse(data, snapshot.friends, snapshot.settings.threshold), threshold: snapshot.settings.threshold };
    } catch (e) {
      if (snapshot.analysisEpoch !== vaultEpoch) return { ok: false, code: 'LOCKED' };
      return { ok: false, error: timedOut(e) ? API_TIMEOUT_ERROR : JN.ERRORS[e.code] || JN.ERRORS.incomplete };
    }
  } finally {
    activeAnalyses.delete(controller);
    if (!timeoutSignal.aborted && typeof timeoutSignal.removeEventListener === 'function') {
      timeoutSignal.removeEventListener('abort', onTimeout);
    }
  }
}

// One request at a time per popup or tab: repeat clicks share the running one (criterion 33).
const running = new Map();

function analyzeOnce(key, jobText) {
  if (!running.has(key)) {
    const p = analyze(jobText).finally(() => {
      if (running.get(key) === p) running.delete(key);
    });
    running.set(key, p);
  }
  return running.get(key);
}

// ── Messaging (criterion 32, P-03) ──
// Content scripts can report what they saw; only extension pages can start a
// Claude call or receive friend data. Only options.html can manage the vault,
// over the 'vault' port; the popup can also lock it. There are no external listeners.

async function onContentMessage(msg, sender) {
  // The host page closed the frame (Escape, or the overlay never confirmed).
  // Closing is always safe, so this needs no auto-detect check.
  if (msg.type === 'OVERLAY_DISMISSED') {
    await dropPrompt(sender.tab.id);
    return { ok: true };
  }
  const isCurrent = currentDocument(sender.tab.id);
  // A report from a new document (reload or navigation) means the prompt's page is gone (criterion 31).
  await dropPrompt(sender.tab.id, sender.documentId);
  if (!(await getNonSensitiveSettings()).autoDetect) return { off: true };
  if (msg.type === 'JOB_SEEN') {
    await rememberJob(sender, msg, isCurrent);
    return { ok: true };
  }
  return { show: await offerPrompt(sender, isCurrent) };
}

function isOverlayFrame(sender) {
  return sender.tab && sender.frameId > 0 && /^chrome-extension:\/\/[^/]+\/overlay\.html$/.test(sender.url) &&
    (!sender.documentLifecycle || sender.documentLifecycle === 'active');
}

function ownsPrompt(prompt, sender) {
  return prompt && prompt.overlayFrameId === sender.frameId && prompt.overlayDocumentId === sender.documentId;
}

// The first overlay that loads state for the prompt owns readiness, analysis
// and closing. Browser-supplied IDs survive service worker restarts in session storage.
function onOverlayMessage(msg, sender) {
  const { tab } = sender;
  const isCurrent = currentDocument(tab.id);
  return inSession(async () => {
    const { prompts = {} } = await chrome.storage.session.get('prompts');
    // Closing is always safe: any overlay frame in the tab can remove it, even after
    // its prompt was dropped (walkthrough 7.2). Only the owner's close clears the prompt.
    if (msg.type === 'OVERLAY_CLOSE') {
      if (ownsPrompt(prompts[tab.id], sender)) {
        delete prompts[tab.id];
        await chrome.storage.session.set({ prompts });
      }
      await chrome.tabs.sendMessage(tab.id, { type: 'CLOSE_OVERLAY' }, { frameId: 0 }).catch(() => {});
      return { ok: true };
    }
    const prompt = isCurrent() ? await livePrompt(prompts, tab) : null;
    if (msg.type === 'OVERLAY_STATE') {
      if (!prompt || (prompt.overlayFrameId && !ownsPrompt(prompt, sender))) return { state: 'none' };
      const settings = await getNonSensitiveSettings();
      if (!settings.autoDetect || !isCurrent()) return { state: 'none' };
      const vaultInfo = await inVault(() => inspectVaultState());
      if (!isCurrent()) return { state: 'none' };
      prompt.overlayFrameId = sender.frameId;
      prompt.overlayDocumentId = sender.documentId;
      await chrome.storage.session.set({ prompts });
      if (!isCurrent()) return { state: 'none' };
      const reply = { state: 'prompt', posting: JN.postingLabel(prompt), vaultState: vaultInfo.vaultState };
      if (vaultInfo.vaultState === 'unlocked') {
        reply.hasKey = !!vaultInfo.data.apiKey;
        reply.friendsStatus = JN.friendsStatus(vaultInfo.data.friends);
      }
      return reply;
    }
    if (!ownsPrompt(prompt, sender)) return { ok: false };
    await chrome.tabs.sendMessage(tab.id, { type: 'OVERLAY_READY' }, { documentId: prompt.contentDocumentId }).catch(() => {});
    return { ok: true };
  });
}

const SETTINGS_MESSAGES = new Set([
  'VAULT_STATUS', 'VAULT_SETUP', 'VAULT_UNLOCK', 'VAULT_RESET',
  'VAULT_GET_DATA', 'VAULT_SAVE_CLAUDE', 'VAULT_SAVE_FRIENDS', 'VAULT_CONVERT_LEGACY',
]);

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  let reply;
  if (JN.isValidContentMessage(msg, sender, chrome.runtime.id)) {
    reply = onContentMessage(msg, sender);
  } else if (JN.isExtensionPage(sender, chrome.runtime.id) && isOverlayFrame(sender) && ['OVERLAY_STATE', 'OVERLAY_READY', 'OVERLAY_CLOSE'].includes(msg?.type)) {
    reply = onOverlayMessage(msg, sender);
  } else if (msg?.type === 'VAULT_LOCK' && (JN.isSettingsSender(sender, chrome.runtime.id) || JN.isStaticExtensionSender(sender, 'popup.html', chrome.runtime.id))) {
    reply = handleVaultLock();
  } else if (msg?.type === 'POPUP_STATUS' && JN.isStaticExtensionSender(sender, 'popup.html', chrome.runtime.id)) {
    reply = handlePopupStatus();
  } else {
    return false;
  }
  reply.then(sendResponse, () => sendResponse(undefined));
  return true;
});

// The port returns the analysis result or notifies the caller if the worker restarts.
// Popup: { type: 'ANALYZE_JOB', jobText }. Overlay: { type: 'ANALYZE_TAB' },
// which carries no text; the worker uses the posting it recorded for that tab.
chrome.runtime.onConnect.addListener(port => {
  const sender = port.sender;
  // Settings vault messages carry the passphrase, key, or friends. runtime.sendMessage would
  // also reach the popup and overlays, so they use this worker-only port (security Low 2):
  // one request, one reply, and no reply for anyone but options.html.
  if (port.name === 'vault') {
    if (!JN.isSettingsSender(sender, chrome.runtime.id)) {
      port.disconnect();
      return;
    }
    port.onMessage.addListener(msg => {
      if (!SETTINGS_MESSAGES.has(msg?.type)) {
        port.disconnect();
        return;
      }
      handleSettingsVaultMessage(msg).then(reply => {
        try {
          port.postMessage(reply);
        } catch (e) {
          // The settings page closed before the answer arrived.
        }
      }, () => port.disconnect());
    });
    return;
  }
  if (port.name !== 'analyze' || !JN.isExtensionPage(sender, chrome.runtime.id)) {
    port.disconnect();
    return;
  }

  port.onMessage.addListener(async msg => {
    let reply;
    if (msg?.type === 'ANALYZE_JOB' && typeof msg.jobText === 'string' && JN.isStaticExtensionSender(sender, 'popup.html', chrome.runtime.id)) {
      reply = await analyzeOnce(sender.tab ? `tab:${sender.tab.id}` : `page:${sender.documentId || sender.url}`, msg.jobText);
    } else if (msg?.type === 'ANALYZE_TAB' && isOverlayFrame(sender)) {
      const isCurrent = currentDocument(sender.tab.id);
      const prompt = await inSession(async () => {
        const { prompts = {} } = await chrome.storage.session.get('prompts');
        const current = isCurrent() ? await livePrompt(prompts, sender.tab) : null;
        if (!isCurrent() || !ownsPrompt(current, sender)) return null;
        const { autoDetect } = await getNonSensitiveSettings();
        return autoDetect && isCurrent() ? current : null;
      });
      reply = prompt ? await analyzeOnce(`tab:${sender.tab.id}`, prompt.text) : { ok: false, code: 'NO_POSTING' };
    } else {
      return;
    }
    try {
      port.postMessage(reply);
    } catch (e) {
      // The popup or overlay closed before the answer arrived.
    }
  });
});
