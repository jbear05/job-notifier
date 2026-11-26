# Job Notifier — Technical Documentation

## Architecture

Job Notifier is a Chrome Manifest V3 extension with no backend. Each user brings their own Anthropic API key, and the service worker calls `https://api.anthropic.com` directly with it. Nothing goes to a developer server, because there isn't one.

It has five contexts:

```
┌──────────────────────────────────────────────────────────┐
│  A web page (only while auto-detect is on)               │
│  ┌────────────────────────────────────────────────────┐  │
│  │ lib/core.js + content.js (registered at runtime)   │  │
│  │  - Reads visible text locally                      │  │
│  │  - Reports postings and confirmations              │  │
│  │  - Adds the overlay iframe; renders no HTML itself │  │
│  └──────────────┬─────────────────────────────────────┘  │
│  ┌──────────────┼─────────────────────────────────────┐  │
│  │ overlay.html │ (extension page in an iframe)       │  │
│  │  - Prompt, locked/setup, loading, results, errors  │  │
│  └──────────────┼─────────────────────────────────────┘  │
└─────────────────┼────────────────────────────────────────┘
                  │ runtime messages (sender-checked)
┌─────────────────▼────────────────────────────────────────┐
│  background.js (service worker)                          │
│  - Sole authority for vault crypto, lock/unlock, API     │
│  - Remembers recent postings per tab (storage.session)   │
│  - Registers/unregisters the content script              │
│  - Only place that calls the Anthropic API               │
└──────────────────────────────────────────────────────────┘
┌──────────────────────────┐ ┌────────────────────────────┐
│ popup.html / popup.js    │ │ options.html / options.js  │
│ - Reads the active tab   │ │ - Passphrase setup/unlock/ │
│   (activeTab+scripting)  │ │   lock/reset/P3 conversion │
│ - Manual analysis        │ │ - API key, model, effort,  │
│ - Auto-detect & Lock now │ │   threshold, friends CRUD  │
└──────────────────────────┘ └────────────────────────────┘
```

`lib/core.js` holds all the pure logic: detection patterns, settings normalization and allowlists, friend validation, passphrase validation, PBKDF2/AES-GCM vault helpers, legacy P3 detection, prompt and request building, response parsing, error mapping, sender checks, and mailto helpers. It defines a global `JN` in the extension and is `require()`d by the Node tests.

The API call and all vault encryption/decryption run in the **service worker**, which checks who asked and can fetch even when a job site's Content Security Policy blocks outbound requests from content scripts. The popup and overlay receive analysis replies over a `chrome.runtime.connect` port and show an error if the port disconnects before the reply.

---

## Permissions and site access

| Manifest entry | Used for |
|---|---|
| `activeTab` + `scripting` | The popup reads the tab it was opened on with `chrome.scripting.executeScript`. This works on tabs that were open before install, and needs no all-sites access. |
| `scripting` | `chrome.scripting.registerContentScripts` / `unregisterContentScripts` for auto-detect. |
| `storage` | `chrome.storage.local` and `chrome.storage.session` (see Storage). |
| `clipboardWrite` | The copy fallback when the Clipboard API isn't available. |
| `host_permissions: https://api.anthropic.com/*` | The Messages API call from the service worker. |
| `optional_host_permissions: https://*/*, http://*/*` | Requested only when the user turns auto-detect on. |

There are no `content_scripts` in the manifest. The service worker registers `lib/core.js` + `content.js` (id `job-notifier-detect`, all http(s) pages, top frame only) only while `autoDetect` is `true` and all-sites access is held. It re-checks on install or update, on startup, on `chrome.permissions.onAdded`/`onRemoved`, and whenever `autoDetect` changes.

- **Turning it on:** the popup or settings page calls `chrome.permissions.request` for all sites from the click, then sets `autoDetect: true`. The worker also sets it when `onAdded` reports all-sites access, which covers the popup closing while Chrome's dialog is open.
- **Turning it off** sets `autoDetect: false`. The worker unregisters the script, calls `chrome.permissions.remove`, clears pending prompts, and sends `STOP` to open tabs. Running scripts stop reading the page and remove any open overlay, restoring focus when the previous control is still present.
- **Access removed in Chrome:** `onRemoved` sets `autoDetect: false`.

The switch shows on only when `autoDetect` is `true` and the permission is held.

`web_accessible_resources` lists only the overlay HTML page, with `use_dynamic_url: true`, so a site can't probe a fixed URL to learn the extension is installed. There are no `onMessageExternal`/`onConnectExternal` listeners and no `externally_connectable`, so web pages and other extensions have no channel to the worker. The CSP is `script-src 'self'; object-src 'self'`, and fonts, icons, and scripts are all bundled.

---

## Storage and passphrase encryption

| Where | Key | Contents |
|-------|-----|----------|
| `chrome.storage.local` | `vault` | Versioned (`v: 1`) AES-GCM encrypted envelope: `{ v: 1, kdf: { name: 'PBKDF2', hash: 'SHA-256', iterations: 600000, salt }, cipher: { name: 'AES-GCM', tagLength: 128, iv }, ct }` holding `{ v: 1, apiKey, friends }`. AAD binds version and KDF parameters (`job-notifier:vault:v1\|...`). Absent on a fresh install. |
| `chrome.storage.local` | `settings` | `{ model, effort, threshold }`. Non-sensitive preferences only; `apiKey` is never written to `settings` in 2.0.0. Read through `JN.normalizeSettings`, so a model or effort outside the allowlists falls back to the default and the threshold is clamped to 0–1 |
| `chrome.storage.local` | `autoDetect` | boolean, default `false` |
| `chrome.storage.session` | `vaultKey` | Base64 256-bit derived key kept in memory only while unlocked for the Chrome session. Cleared on **Lock now**, vault reset, or browser close |
| `chrome.storage.session` | `jobs` | recently viewed postings by tab id: `{ [tabId]: { text, title, url, seenAt, hash } }`, text capped at 8,000 characters. `url` holds only the site's hostname, never the path, query, or fragment. Removed when the tab closes |
| `chrome.storage.session` | `prompts` | the posting and confirmation origin for each tab, with browser-supplied identifiers for the top-level document and the overlay frame and document that loaded the prompt. Cleared on close, when you leave or reload the page (in-page URL changes such as `pushState` or hash changes keep it), when the tab closes, and when auto-detect is turned off |
| `chrome.storage.session` | `prompted` | hashes of the last 100 postings already offered, so each posting is offered once |

Rules:
- `vault`, `settings`, and `autoDetect` live only in `chrome.storage.local`, never `storage.sync`.
- `vaultKey`, postings, and prompt state live only in `chrome.storage.session`, at its default trusted-contexts access level (no `setAccessLevel`), so content scripts can't read them. Session storage is memory only and is cleared when the browser closes.
- The passphrase itself is never stored in `chrome.storage.local`, `chrome.storage.session`, `storage.sync`, logs, or exports. Temporary `Uint8Array` key buffers are zeroed after use.
- **Cryptography:** `PBKDF2` (`SHA-256`, 600,000 iterations, 16-byte CSPRNG salt, validated in `[600000, 5000000]`) derives 256 bits, imported as a non-extractable `AES-GCM` `CryptoKey` (`tagLength: 128`) with a fresh 12-byte CSPRNG IV on every write. Malformed or unsupported `vault` records fail closed to `unreadable` without falling back to plaintext or overwriting `vault`.
- **Concurrency:** All vault reads/writes run sequentially inside `inVault`. A synchronous `vaultEpoch` counter invalidates in-flight unlocks, saves, and Claude `fetch` requests (`AbortController`) immediately when **Lock now** or **Reset** runs. Optimistic concurrency (`expectedRev` / `vaultRev`) prevents two open settings tabs from overwriting each other (`STALE_EDIT`), and `VAULT_LOCKED` / `VAULT_CHANGED` keep open pages synchronized.
- **Legacy pre-encryption 2.0.0 conversion (P3) vs 1.x:** When `vault` is absent, `JN.detectLegacyPreEncryption200()` strictly identifies non-empty pre-encryption 2.0.0 `{ settings, friends }` records (rejecting 1.x fixtures). Analysis refuses to run and plaintext is never used or deleted until the user sets a passphrase and the worker writes `vault`, reads it back, decrypts/authenticates it, and then removes `friends` and `settings.apiKey` (resuming residual cleanup on the next valid unlock if interrupted).
- **Exports (P2):** Exporting friends requires the vault to be unlocked and an explicit user click. It downloads `job-notifier-friends.json` containing only the validated friends array (no `apiKey`, passphrase, `vaultKey`, or settings), labeled as unencrypted and readable outside Chrome.
- Analysis results (job summary, scores, drafts) are never stored. They exist only in the open popup or overlay page while unlocked.
- Content scripts never call `chrome.storage`. They send messages to the worker instead.
- The API key never appears in a message to a content script, the popup, or the overlay, in an error message, in the friends export, or in console output. The settings page shows it in a password field while unlocked.
- No runtime file logs anything (no `console.` calls).

Web pages can't read any of this, and nothing is written to the site's own `localStorage`/`sessionStorage`.

### Friends schema

| Field | Type | Description |
|-------|------|-------------|
| `name` | string | Required. Display name, up to 100 characters |
| `contact` | string | Email address used for `mailto:` links, or `""`. Up to 254 characters. Never sent to Claude |
| `skills` | string[] | Technical skills. Up to 50 items of 100 characters |
| `interests` | string[] | Industry or domain interests. Up to 50 items of 100 characters |
| `level` | string | e.g. `"internship"`, `"new grad"`, `"senior"`. Up to 50 characters |
| `notify` | boolean | `false` excludes the friend from matching without removing them. Default `true` |

`JN.cleanFriends()` is the one validator for the settings form, JSON import, and stored friends before they reach the prompt. It builds new objects with only these six keys (so `__proto__`, `constructor`, and anything else are dropped), trims and caps strings, and rejects more than 500 entries. `JN.parseFriendsImport()` also rejects files over 1 MB and invalid JSON. A rejected import leaves the saved list unchanged. Export writes only the friends array.

---

## Reading a page from the popup

1. Opening the popup queries `POPUP_STATUS`. If the vault is `uninitialized`/`needs-conversion`, `locked`, or `unreadable`, the popup renders a prompt directing the user to settings and does not read the page or call Claude.
2. When unlocked with an API key and at least one included friend, the popup calls `chrome.scripting.executeScript` on the active tab (allowed by `activeTab`): it injects `lib/core.js`, then runs `JN.extractJobText(document)` to read the visible text.
3. If the text looks like a posting (`JN.isJobPage`), it fills the "Posting text" box. Otherwise the user pastes the posting. Chrome-restricted pages (`chrome://`, the Web Store, the PDF viewer) and failed reads get their own messages.
4. **Find friends** sends `ANALYZE_JOB` with the text over the `analyze` port. The worker verifies vault unlock and caps the text at `JN.MAX_JOB_TEXT` (8,000) characters. Repeat clicks while a request is running share that request.

Opening the popup never calls Claude, and nothing is focused by default, so a stray Enter can't start a paid request.

---

## Auto-detection flow

```
1. You view a job posting (auto-detect on)
   └─ content.js reads the visible text of <main>/<article> (or <body>)
   └─ If ≥3 job signals match, sends JOB_SEEN { text, title }
   └─ The worker checks the sender and fields (JN.isValidContentMessage)
      and stores the posting under this tab's id

2. You submit the application; a confirmation appears
   └─ content.js checks *rendered* headings, dialogs, alerts, live regions,
      and <main> (≤3000 chars each) for a confirmation phrase
   └─ Sends CONFIRMATION_SEEN (no fields). This message never starts a
      Claude call. The reply is { show }, or { off: true } when auto-detect
      is off, which stops the script.

3. background.js
   └─ JN.recallPosting(jobs, tab): a fresh posting (≤30 minutes) from this
      tab, else from the tab that opened it (openerTabId). Never another tab.
   └─ Skips if there is none, or it was already offered (prompted)
   └─ Otherwise stores prompts[tabId] (the posting, confirmation origin, and
      top-level document ID), adds the hash to prompted, and replies { show: true }
   └─ No browser document ID, no prompt. A report from another document in
      the tab (you left or reloaded the page) clears the prompt; in-page URL
      changes keep the document and the prompt. Before using a stored prompt,
      the worker sends DOCUMENT_PING to its document and drops the prompt if
      that document is gone.

4. content.js adds a full-viewport transparent iframe with overlay.html
   └─ The frame sends OVERLAY_STATE and gets the prompt for its own tab
      (sender.tab.id): the posting's title and site, and vaultState
      (omitting hasKey and friendsStatus unless unlocked)
   └─ If locked/uninitialized/unreadable, the overlay sends the user to
      settings and re-checks OVERLAY_STATE on visibilitychange when they return
   └─ The worker records the browser-supplied overlay frame and document IDs
      when it returns the prompt. The overlay sends OVERLAY_READY after it renders.
   └─ The worker forwards readiness to the original top-level document.
      Until then, the iframe leaves page clicks alone. The content script
      focuses it on readiness or removes it after a five-second timeout.
   └─ Only a click on Find friends opens the analyze port with ANALYZE_TAB.
      It carries no job text; the worker uses the posting it recorded.
   └─ Close, Not now, Escape, or a scrim click before Find friends sends
      OVERLAY_CLOSE. The worker clears prompts[tabId] and sends CLOSE_OVERLAY
      to the content script (even if the prompt is already gone),
      which removes the frame and returns focus to the page.
```

Because the posting is stored by tab id in the extension (not in the site's storage), it survives same-tab cross-site hops such as LinkedIn → Workday, and "opens in a new tab" flows through `openerTabId`. Hidden elements are ignored, so pre-rendered "Thank you for applying" templates don't fire.

### Messages

| Message | From → to | Carries |
|---|---|---|
| `JOB_SEEN` | content script → worker | `{ text, title }` of a page that looks like a posting |
| `CONFIRMATION_SEEN` | content script → worker | nothing |
| `OVERLAY_DISMISSED` | content script → worker | data-free request to clear the prompt after a timeout or Escape in the host page |
| `CLOSE_OVERLAY` | worker → content script (top frame) | data-free signal to remove the frame and restore focus |
| `STOP` | worker → content script (top frame) | data-free signal to stop page reading and close the overlay |
| `DOCUMENT_PING` | worker → content script (the prompt's document) | nothing; the reply is `{ ok: true }`, and a failed send means the document is gone |
| `OVERLAY_STATE` | overlay → worker | nothing; the reply is this tab's prompt (`posting`, `vaultState`, and `hasKey`/`friendsStatus` only when unlocked) or `{ state: 'none' }` |
| `OVERLAY_READY` | overlay → worker → matching content document | data-free signal that the rendered frame can accept clicks and take focus |
| `OVERLAY_CLOSE` | overlay → worker | nothing |
| `POPUP_STATUS` | popup → worker | nothing; minimal `{ vaultState }` (plus `hasKey`, `friendsStatus` only when unlocked) |
| `VAULT_STATUS` | settings → worker (`vault` port) | nothing; `{ ok, vaultState, legacySummary? }` |
| `VAULT_SETUP` / `VAULT_UNLOCK` / `VAULT_CONVERT_LEGACY` | settings → worker (`vault` port) | `{ passphrase }` (never stored or logged) |
| `VAULT_LOCK` | settings or popup → worker | nothing |
| `VAULT_RESET` | settings → worker (`vault` port) | nothing |
| `VAULT_GET_DATA` | settings → worker (`vault` port) | nothing; returns `{ ok, apiKey, friends, settings, vaultRev }` when unlocked |
| `VAULT_SAVE_CLAUDE` / `VAULT_SAVE_FRIENDS` | settings → worker (`vault` port) | updated fields + `expectedRev` |
| `VAULT_LOCKED` / `VAULT_CHANGED` | worker → extension pages | data-free broadcast to sync open surfaces |
| `ANALYZE_TAB` | overlay → worker, `analyze` port | nothing; the worker uses `prompts[tabId]` |
| `ANALYZE_JOB` | popup → worker, `analyze` port | `{ jobText }` |

Both `analyze` requests get one reply: the results, or a code for locked/uninitialized/unreadable/no key/no friends/no posting, or a mapped error (see Errors).

### Overlay isolation

The prompt and results render in an extension iframe. Friend names, emails, drafts, the recruiter link, and the posting's site and title stay inside the frame, where page CSS can't restyle the panel. The frame gets state over the extension message channel from the worker for its own tab, while the tab is still on the origin that reported the confirmation. The worker checks which frame and document loaded the prompt before honoring readiness, analysis, or close requests. The readiness and close signals carry no user data. The dialog has `role="dialog"` and `aria-modal="true"`, takes focus when ready, closes on Escape, and returns focus to the page on close.

### Sender checks

Every message the worker handles goes through pure helpers in `lib/core.js`.

- `JN.isSettingsSender(sender, runtimeId)` and `JN.isStaticExtensionSender(sender, page, runtimeId)` require `sender.id === runtimeId`, top-level `frameId` (`0` or `undefined`), and exact `chrome-extension://<runtimeId>/<page>` URL. Vault setup, unlock, reset, data retrieval, and saves are restricted to `options.html`; `POPUP_STATUS` and `ANALYZE_JOB` are restricted to `popup.html`; `VAULT_LOCK` is accepted only from `options.html` or `popup.html`.
- The settings page sends every other vault message over a `chrome.runtime.connect({ name: 'vault' })` port, one request per port. Only the worker listens for that port, and it accepts it only when `JN.isSettingsSender` passes, so the passphrase, API key and friends never reach other extension pages (popup, overlay frames). `runtime.onMessage` ignores those message types.
- `JN.isExtensionPage(sender, runtimeId)` requires Chrome's `sender.id` to match this extension and `sender.url` to use the `chrome-extension:` scheme. This supports the dynamically assigned overlay origin. It applies to overlay page messages and the `analyze` port. A content script that connects to the port is disconnected because its sender URL belongs to the web page.
- `JN.isValidContentMessage(msg, sender, runtimeId)` accepts `JOB_SEEN`, `CONFIRMATION_SEEN`, and `OVERLAY_DISMISSED` from this extension's content script in a tab's top frame (`frameId === 0`) on an http(s) URL, with string fields under their caps (text ≤ `MAX_JOB_TEXT`, title ≤ 200). With auto-detect off, only dismissal is accepted.

### Detection patterns

See `JOB_SIGNALS` and `CONFIRMATION_PATTERNS` in `lib/core.js`. Add a phrase there (and a case in `test/core.test.js`) to support a new site.

---

## Claude request

`JN.buildRequest()` sends one request to `POST /v1/messages`:

- **Model and effort** come from allowlists through `JN.normalizeSettings`. `JN.MODELS` is `claude-haiku-5-5` (Claude Haiku 5.5, the default), `claude-sonnet-5-5`, and `claude-opus-5-5`. `JN.EFFORTS` is `low` (default), `medium`, and `high`. A stored model or effort outside these falls back to the default. `max_tokens` is fixed at 4096.
- **System prompt** holds all instructions. It says the posting and friend fields are untrusted content, that any instructions inside them must be ignored, and that drafts must not contain links or contact details.
- **User message** holds the friends (`{ id, name, skills, interests, level }`, after `cleanFriends`) inside `<friends>` and the posting text (capped at 8,000 characters) inside `<job_posting>`. Those tags are stripped from page text first, so a page can't close the delimiter.
- **Structured output**: `output_config.format` with a JSON schema.
- **Refusal fallback**: on models that support it (Sonnet 5.5 and Opus 5.5, not Haiku 5.5), `fallbacks: "default"` with the `server-side-fallback-2026-07-01` beta header.
- The request goes from the service worker with the `anthropic-dangerous-direct-browser-access` header. That's acceptable here because the key belongs to the person using this browser.

`JN.parseResponse()` treats Claude's output as untrusted. It handles `refusal` and `max_tokens` stop reasons, coerces job fields to their types and caps their length, requires a finite score and clamps it to 0–1, caps messages at 2,000 characters, drops unknown, duplicate, or non-integer ids and below-threshold scores, takes `contact` only from the stored friend, and sorts by score.

### Errors

`JN.describeApiError(status, body)` maps API failures to `{ title, body, action }` in plain language: invalid key (401), out of credit (400 mentioning the credit balance), no permission (403), rate limit (429), overloaded or server error (529, 5xx), unknown model (404, or a 400 naming the model), and no network (fetch threw). Only an unrecognized status shows the API's own message, with anything shaped like a key redacted.

The worker sets a 25-second request deadline ahead of Chrome's service worker fetch response limit. The overlay retains its 90-second fallback for a port that stops returning replies. Both surfaces handle a disconnected port. [Chrome service worker lifecycle](https://developer.chrome.com/docs/extensions/develop/concepts/service-workers/lifecycle/#idle-shutdown)

---

## Sending

`mailto:` links open the user's email client; they still press Send there. `JN.mailtoUrl()` takes the recipient only from the stored friend's `contact` and URL-encodes the subject and body, so page text or Claude's output can't add recipients or headers.

Browsers only allow one new window per click, so **Open next email** opens one checked email per click and counts down. **Copy all** copies every checked message as one block. If a clipboard write fails, the button says so instead of "Copied".

A draft that contains a URL or email address (`JN.draftHasLinkOrEmail`) shows a note on its card telling the user to check it before sending. The note updates as the draft is edited.

### Recruiter contact (optional)

When there are matches, the share step asks "Do you have a recruiter contact for this position?" You can paste a LinkedIn URL there; leave it blank and nothing changes.

- `JN.normalizeRecruiterUrl()` checks it loosely: any `http(s)` link on `linkedin.com` or a subdomain (`www.`, `uk.`, …). A missing scheme is fine (`linkedin.com/in/jane` becomes `https://linkedin.com/in/jane`). Anything else shows a warning and is left out.
- A valid link is added as a last line, `Recruiter contact for this role: <url>`, to each email body and per-friend **Copy**, and once under the subject line in **Copy all**. The editable draft boxes are not changed.
- The link is only held in memory for the open overlay or popup. It is never saved and never sent to Claude: the analysis request has already finished by the time you see the field.

---

## Packaging

`npm run package` (with `--script-shell=bash` on Windows) runs `git archive --format=zip` on `HEAD` and writes `dist/job-notifier-<version>.zip`. It packages committed files only. `.gitattributes` marks tests, docs, CI, Claude tooling, README, PRIVACY.md, and package.json `export-ignore`, so the zip holds the manifest, scripts, pages, styles, `lib/`, `icons/`, `fonts/`, and `LICENSE`. `dist/` is gitignored. The version in `manifest.json` and `package.json` must match; a test fails if they don't.

---

## Known limitations

- **Heuristic detection.** Confirmations shown inside cross-origin iframes, or only as images or animations, aren't detected. Use the popup.
- **Bring your own key.** Each user needs an Anthropic API key and pays Anthropic directly. There is no backend by design; the key and friends list are passphrase-encrypted at rest in `chrome.storage.local` and stay unlocked in `chrome.storage.session` until **Lock now** or browser close. Users should set a spend limit in the Claude Console.
- **Storage deletion boundaries.** Chrome's `chrome.storage.local` updates perform logical deletion; prior profile backups or uncompacted LevelDB blocks created before encryption or reset cannot be retroactively scrubbed by the extension.
- **Screen readers in the overlay.** `aria-modal` inside an iframe doesn't hide the host page from screen-reader browse mode. Fixing it would mean making the host page inert, which modifies its DOM, so it isn't done.
- **No true auto-send.** That would need OAuth with an email provider (Gmail API, Microsoft Graph).
