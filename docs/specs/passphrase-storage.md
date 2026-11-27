# Passphrase protection for saved data

## Goal

Protect the Anthropic API key and every saved friend field at rest for the Job Notifier 2.0.0 Chrome Web Store release. Users create a passphrase in extension settings and unlock their saved data before using it. Completion requires test evidence for storage, lifecycle, and regressions, plus designer, reviewer, and security approval and clean-profile Chrome evidence.

The Chrome Web Store guidance calls for strong encryption at rest and disclosure of locally handled user data. This spec updates the plaintext storage design in public-release criterion 34 and its related settings copy, privacy policy, technical docs, and listing. [Chrome Web Store user data FAQ](https://developer.chrome.com/docs/webstore/program-policies/user-data-faq)

## Scope

- Save the bring-your-own API key and full friend records in encrypted extension storage. Keep the existing friend validator, model picker, effort, threshold, auto-detect permissions, same-tab/opener posting rules, and click-to-analyze requirement.
- Use Chrome's built-in Web Crypto and extension storage. Keep the direct Anthropic request and bundled runtime. Non-sensitive preferences can stay in `chrome.storage.local`. Recent postings remain in `chrome.storage.session` under the existing retention rules.
- Put passphrase creation and entry in the extension's top-level settings page. Add locked and first-run paths to settings, popup, and overlay, including an unlock return path. Update the release screenshots that show changed UI.
- Preserve the public release decision on 1.x upgrades. Treat existing plaintext in private development profiles as a separate, explicit decision. The Web Store submission remains the user's step.

## Decisions (answered by the user, 2026-11-25)

- **P1. Unlock duration:** Once per Chrome session with a **Lock now** action.
- **P2. Friends export:** Keep readable JSON export, labeled as readable outside Chrome (excludes API key; legacy JSON import stays supported).
- **P3. Private development profiles:** Explicit conversion of existing pre-encryption 2.0.0 data (verify encrypted copy can be read and authenticated before clearing original; no automatic 1.x migration).

## Proposed behavior

- On a fresh install, settings explains that the passphrase protects saved data in this Chrome profile and that Job Notifier cannot recover it. Create requires matching entries and gives actionable validation feedback. The API key and friend data can be saved after setup. Setup itself makes no network request.
- A locked extension provides a clear **Open settings to unlock** action from popup and overlay. Passphrase controls appear only in extension settings. A successful unlock restores the user's existing options and friends. Returning to or reopening the overlay or popup restores the eligible posting or input state when that state is still available. The user still clicks **Find friends** after unlocking. A wrong passphrase or unreadable encrypted record leaves the record intact and the extension locked.
- While unlocked, settings keeps its masked key, disclosures, and friends editing/import/export flows. Lock clears the unlocked session state and cancels or ignores stale operations. Visible extension surfaces clear API key fields, friend details, and any results they hold when locked. The lock never sends a message to a friend or starts an API request.
- For a forgotten passphrase, settings explains the data cannot be unlocked and explains the approved way to start fresh. Removing existing saved data requires an explicit confirmation that identifies what will be removed. An accidental or canceled action leaves it intact.
- For P3 conversion, only validated records from the approved private-build path are candidates. Preserve data until a replacement can be read and authenticated. Any interrupted conversion can be retried without combining records, dropping edits, or continuing to use plaintext silently. Document the scope of cleanup within Chrome's storage API, including limits on prior copies and backups.

## Acceptance criteria

| ID | Required evidence |
|---|---|
| P-01 | Fresh install contains an empty friends state and no key. Passphrase setup and unlock happen locally and cause zero API requests. Saving any of the fields persists the complete API key and all friend fields only inside authenticated ciphertext. Inspect all persistent extension storage and synthetic raw storage values. Verify non-sensitive preferences and posting-session behavior still work. |
| P-02 | Encrypt with authenticated Web Crypto and a passphrase-derived key. Security approves and records a versioned format, derivation parameters, randomly generated salt, and a unique nonce for each encryption under a given key. The passphrase, reusable derived key, and decrypted values never enter persistent extension storage, sync, diagnostics, or exports. Tests cover the valid round trip, wrong passphrase, changed ciphertext, malformed/unsupported record, and unique values across writes. [W3C Web Cryptography API](https://www.w3.org/TR/2017/REC-WebCryptoAPI-20170126/) |
| P-03 | Passphrase, key, and decrypted data stay within authorized extension contexts. Only the owning settings page can create or unlock storage. Popup and overlay receive the minimum status they need before analysis. Anthropic is the only external recipient of the key, which authorizes requests after the user clicks **Find friends** or **Try again**. The request excludes structured friend contact fields and recruiter links. The overlay's current sender/frame ownership and no-external-messages contract remain enforced. |
| P-04 | Lock and unlock follow P1. A service worker restart and a browser restart behave as specified. Browser restart never restores an unlocked state automatically. Concurrency tests cover lock during unlock, save, and analysis, plus edits from two settings pages. A failed/interrupted operation leaves the last confirmed encrypted data readable. [Chrome storage areas](https://developer.chrome.com/docs/extensions/reference/api/storage#storage-areas) |
| P-05 | Settings handles setup, locked, unlocking, unlocked, incorrect passphrase, and unreadable storage. One action at a time while work is pending. Sensitive fields clear after use or lock. Keyboard focus, accessible labels, visible focus, and status announcements match the existing design rules. Screenshot states and verify real Chrome keyboard flow. |
| P-06 | Popup and overlay distinguish missing setup, locked storage, and existing no-friends/key states. Locked surfaces show the settings action and prevent analysis. Worker checks lock independently of the UI. Unlock alone causes zero requests. A finished analysis that arrives after a lock does not display stale friend data. Validate both the toolbar and confirmation flows. |
| P-07 | While unlocked, add/edit/exclude/remove, key update/clear, and friends import/export keep working. Imports run the same validator and existing 1 MB/500-friend limits. Export follows P2, requires unlock and an explicit action, and excludes key/passphrase and settings. Rejected import or failed save leaves ciphertext and previously saved friends intact. |
| P-08 | Existing private-profile plaintext follows P3. Neither startup nor cancellation erases or transfers it. For approved conversion, a synthetic upgrade fixture proves preservation across failure, successful encrypted replacement and logical removal of legacy key/contact values after confirmation. For an approved reset path, test confirmation, cancellation, and empty post-reset setup. No 1.x fixture is automatically upgraded. |
| P-09 | README, PRIVACY.md, DOCS.md, settings disclosures and store listing agree with the new at-rest protection, lock lifetime, what is sent, how to delete data, and the export format. Verify the manifest permissions and API destination are unchanged. The privacy explanation covers the unlocked period and the consequences of losing the passphrase. |
| P-10 | Existing release tests pass, including permissions, data flow, ZIP allowlist, artifact secret scan, and manifest references. The final ZIP loads in a clean Chrome profile. Designer signs off on updated screens and assets using fictional data. Security and reviewer sign off on the scoped change. |

## Design

This extends the v2.0.0 design system in [public-release.md](public-release.md#design) and reuses `ui.css` and `ui.js` verbatim: Fraunces 600 headings, IBM Plex Sans 400/600 body, neutral base (`--bg`, `--bg-subtle`, `--border`, `--border-strong`, `--text`, `--text-muted`) with `--accent` (`#0f766e`) and `--error` (`#b42318`), `<= 4px` border radius, `--shadow-panel` on the overlay dialog only, no gradients, no blur, no emoji or symbol icons, and left-aligned layouts.

Shared rules for every new state:
- **Passphrase inputs:** use `type="password"`, `autocomplete="off"`, and `spellcheck="false"`, with **no show/hide toggle** (consistent with `#api-key` in `options.html`).
- **Sensitive input clearing:** clear passphrase fields (`.value = ''`) immediately after reading their value on submit/use (create, convert, unlock, or validation failure) and whenever locking or canceling. When locking, also clear `#api-key`, all `#friend-form` inputs, `#import-panel`, and every rendered friend/result node from the DOM and in-memory state.
- **Pending buttons:** never set HTML `disabled` on a focused control. While work is pending, set `aria-disabled="true"` (`.btn[aria-disabled="true"]`), keep the button focusable, and ignore clicks (`isBusy`).
- **Focus on state change:** move focus to the new state's heading (`tabindex="-1"`) when an action transitions between vault states, opens an inline confirmation panel, or locks/clears results.
- **Safe text rendering:** every count, error, and stored status uses `textContent` or `.value` (never `innerHTML`).

### Settings page (`options.html`, `options.css`, `options.js`)

Add a `#vault` section (`class="section"`, keeping the two-column `220px minmax(0, 520px)` grid and `< 880px` stacked layout) immediately below `.page-header` and above `#claude`.

- **Section visibility by vault state:**
  - In `uninitialized`, `needs-conversion`, `locked`, `unreadable`, and `pending` (before unlock): `#vault` is visible; `#claude` and `#friends` stay `hidden` with their sensitive fields and DOM emptied; `#auto-detect` and `#privacy` remain visible below `#vault` so non-sensitive preferences and privacy links always work.
  - In `unlocked`: `#vault` collapses to a compact `Passphrase lock` section above `#claude`, and `#claude` and `#friends` are visible.
- **State-aware `.lede` under `<h1>Job Notifier settings</h1>`:**
  - `uninitialized`: `Create a passphrase to encrypt your API key and friends list in this browser.`
  - `needs-conversion`: `Create a passphrase to encrypt your existing API key and friends list in this browser.`
  - `locked` / `unreadable`: `Your saved API key and friends list are locked in this browser.`
  - `unlocked`: `Your API key and friends list are encrypted in this browser. Lock them anytime when you step away.`

#### 1. Fresh passphrase setup (`uninitialized`)

- **Left column (`.section-intro`):**
  - `h2#vault-heading[tabindex="-1"]`: `Create a passphrase`
  - `p.small.muted`: `Protects your API key and friends list in this Chrome profile.`
- **Right column (`<form id="setup-form" class="section-body" novalidate>`):**
  - **Setup disclosure (`.disclosure`):**
    - Title (`.label`): `Before you create a passphrase`
    - List:
      - **Encrypted in this Chrome profile.** Your passphrase encrypts your Anthropic API key and friends list on disk.
      - **No recovery.** Job Notifier has no server and cannot recover a forgotten passphrase. If you forget it, you will have to erase saved data and start over.
      - **Unlocked per Chrome session.** Once unlocked, your data stays unlocked until you click **Lock now** or quit Chrome completely.
  - **Field 1:** Label `Passphrase` (`#setup-passphrase`, `type="password"`, `autocomplete="off"`, `spellcheck="false"`, `aria-describedby="setup-passphrase-help setup-passphrase-error"`).
    - Help (`#setup-passphrase-help`, `.small.muted`): `At least 8 characters. Job Notifier cannot recover a forgotten passphrase.`
    - Error (`#setup-passphrase-error`, `.small.error-text`): empty until invalid.
  - **Field 2:** Label `Confirm passphrase` (`#setup-confirm`, `type="password"`, `autocomplete="off"`, `spellcheck="false"`, `aria-describedby="setup-confirm-error"`).
    - Error (`#setup-confirm-error`, `.small.error-text`): empty until invalid.
  - **Actions (`.actions`):** Primary button `Create passphrase` (`#setup-submit`), status `#setup-status` (`role="status"`).
- **Validation & focus:**
  - Empty passphrase: set `aria-invalid="true"` on `#setup-passphrase`, error `Enter a passphrase.`, clear both fields, focus `#setup-passphrase`.
  - Whitespace-only or `< 8` characters: set `aria-invalid="true"` on `#setup-passphrase`, error `Use at least 8 characters (not all spaces).`, clear both fields, focus `#setup-passphrase`.
  - `> 512` characters: set `aria-invalid="true"` on `#setup-passphrase`, error `Passphrase must be 512 characters or fewer.`, clear both fields, focus `#setup-passphrase`.
  - Empty confirmation: set `aria-invalid="true"` on `#setup-confirm`, error `Confirm your passphrase.`, focus `#setup-confirm`.
  - Mismatch: set `aria-invalid="true"` on `#setup-confirm`, error `Passphrases don't match. Enter the same passphrase in both fields.`, clear `#setup-confirm`, focus `#setup-confirm`.
  - Success: clear both passphrase fields, reveal `#claude` and `#friends`, focus `#vault-heading` (or `#friends-heading` if `location.hash === '#friends'`), and set `#vault-status` to `Passphrase created. Unlocked for this session.`

#### 2. P3 existing pre-encryption 2.0.0 data conversion (`needs-conversion`)

Shown only when validated pre-encryption 2.0.0 data (`settings.apiKey` and/or `friends`) exists in `chrome.storage.local` with no encrypted vault. Never shown for 1.x profiles.

- **Left column:**
  - `h2#vault-heading[tabindex="-1"]`: `Encrypt existing saved data`
  - `p.small.muted`: `Unencrypted 2.0.0 data was found in this browser.`
- **Right column (`<form id="convert-form" class="section-body" novalidate>`):**
  - **Conversion disclosure (`.disclosure`):**
    - Title (`.label`): `Existing saved data found`
    - Summary line (counts/presence only—never display the raw key or friend names/emails before encryption): `Found {a saved API key / no API key} and {n} saved {friend / friends} stored without encryption.`
    - Body: `Create a passphrase to encrypt this data. Job Notifier checks that the encrypted copy can be read before removing the unencrypted original. Canceling or leaving this page leaves your existing data unchanged and locked.`
  - **Fields:** `Passphrase` (`#convert-passphrase`) and `Confirm passphrase` (`#convert-confirm`), using the same password attributes, help line, and validation/mismatch rules as Fresh setup.
  - **Actions:** Primary button `Encrypt saved data` (`#convert-submit`), text button `Erase existing data instead` (`#convert-reset-toggle`), status/alert `#convert-error` (`.small.error-text`, `role="alert"`).
- **Failure / interruption handling:**
  - If writing or authenticating the encrypted copy fails, preserve the unencrypted original intact, clear `#convert-passphrase` and `#convert-confirm`, render an `.error-block` above `#convert-form` (`heading`: `Couldn't encrypt saved data`, `body`: `Your existing data wasn't changed or deleted. Try creating your passphrase again.`), and focus its heading (`tabindex="-1"`). Retrying performs a clean conversion from the preserved original.
  - Success: clear both fields, transition to `unlocked`, focus `#vault-heading`, and announce `Existing data encrypted and unlocked for this session.` in `#vault-status`.

#### 3. Locked state (`locked`)

- **Left column:**
  - `h2#vault-heading[tabindex="-1"]`: `Unlock saved data`
  - `p.small.muted`: `Your API key and friends list are encrypted.`
- **Right column:**
  - **Unlock form (`<form id="unlock-form" class="stack" novalidate>`):**
    - Field: Label `Passphrase` (`#unlock-passphrase`, `type="password"`, `autocomplete="off"`, `spellcheck="false"`, `aria-describedby="unlock-passphrase-help unlock-passphrase-error"`).
      - Help (`#unlock-passphrase-help`, `.small.muted`): `Unlocks your saved data for this Chrome session.`
      - Error (`#unlock-passphrase-error`, `.small.error-text`, `role="alert"`): empty until error.
    - Actions: Primary button `Unlock` (`#unlock-submit`), text button `Forgot passphrase?` (`#forgot-btn`), status `#unlock-status` (`.small`, `role="status"`).
  - **Wrong passphrase error:**
    - Leave stored ciphertext untouched and extension locked.
    - Clear `#unlock-passphrase.value = ''`, set `aria-invalid="true"` on `#unlock-passphrase`, set `#unlock-passphrase-error` to `Wrong passphrase. Try again, or use Forgot passphrase? to erase saved data and start over.`, and focus `#unlock-passphrase`.
  - **Forgotten-passphrase reset panel (`#reset-panel`, `class="import-panel stack"`, `hidden` by default):**
    - Clicking `Forgot passphrase?` reveals `#reset-panel` and moves focus to `#reset-heading` (`tabindex="-1"`).
    - `h3#reset-heading[tabindex="-1"]` (Subheading 17/22): `Forgot your passphrase?`
    - Body: `Job Notifier cannot unlock or recover your saved data without your passphrase. Starting fresh permanently deletes:`
    - Bullet list:
      - `Your saved Anthropic API key`
      - `Your entire saved friends list`
    - Note (`.small.muted`): `Your model and match settings, Auto-detect preference, and any exported JSON files on your computer are not deleted.`
    - Confirmation checkbox (`.check`): `<input id="reset-confirm-check" type="checkbox" aria-describedby="reset-confirm-error" /> Yes, permanently erase my saved API key and friends list`
    - Error (`#reset-confirm-error`, `.small.error-text`, `role="alert"`): if `Erase saved data` is clicked unchecked, show `Check the box to confirm you want to erase your saved data.` and focus `#reset-confirm-check`.
    - Actions: Secondary button `Erase saved data` (`#reset-confirm-btn`), text button `Cancel` (`#reset-cancel-btn`).
    - On `Cancel`: hide `#reset-panel`, uncheck `#reset-confirm-check`, clear `#reset-confirm-error`, return focus to `#forgot-btn` (or `#convert-reset-toggle` / `#unreadable-reset-btn` depending on opener). Storage remains untouched.
    - On confirmed `Erase saved data`: enter pending state, delete encrypted vault (and any unmigrated P3 data), clear all inputs, transition to `uninitialized`, focus `#vault-heading` (`Create a passphrase`), and set `#setup-status` to `Saved data erased. Create a new passphrase to start fresh.`

#### 4. Unreadable storage (`unreadable`)

Shown when stored vault metadata/format is corrupted or an unsupported version on load or unlock (distinct from wrong passphrase on valid ciphertext).

- **Left column:**
  - `h2#vault-heading[tabindex="-1"]`: `Saved data can't be read`
  - `p.small.muted`: `The encrypted record in this browser is damaged or unsupported.`
- **Right column:**
  - `.error-block.stack`:
    - `p.label`: `Unable to unlock saved data`
    - `p`: `Job Notifier couldn't verify the stored vault. Your existing storage was left untouched.`
    - Actions: Secondary button `Erase and start fresh` (`#unreadable-reset-btn`). Clicking opens `#reset-panel` (same explicit confirmation checkbox flow above; canceling returns focus to `#unreadable-reset-btn` and leaves storage intact).

#### 5. Unlocking / pending state (`pending`)

Applies during passphrase creation, P3 conversion, unlock, lock, or reset. Only one vault operation may run at a time:
- Show an inline `.loading` row (`role="status"`) with `.spinner` (`aria-hidden="true"`) and text:
  - Setup: `Encrypting and saving…`
  - Conversion: `Encrypting and verifying saved data…`
  - Unlock: `Unlocking saved data…`
  - Reset: `Erasing saved data…`
  - Lock: `Locking…`
- Keep active action buttons in `#vault` focusable with `aria-disabled="true"` (ignoring clicks) and set active passphrase inputs `readOnly = true` until the operation resolves, then clear the passphrase inputs.

#### 6. Unlocked state (`unlocked`)

- **`#vault` section:**
  - Left column: `h2#vault-heading[tabindex="-1"]`: `Passphrase lock` | `p.small.muted`: `Unlocked for this Chrome session.`
  - Right column:
    - `p`: `Your API key and friends list stay unlocked until you click Lock now or quit Chrome completely.`
    - `.actions`: Secondary button `Lock now` (`#lock-btn`), status `#vault-status` (`.small`, `role="status"`).
  - Clicking **Lock now** locks the session in the worker, clears `#api-key`, `#friend-form`, `#friend-list`, and in-memory `friends`/`pendingImport`, hides `#claude` and `#friends`, switches `#vault` to `locked`, focuses `#vault-heading` (`Unlock saved data`), and sets `#unlock-status` to `Locked. Your API key and friends were cleared from memory.`
  - Multi-tab sync: if another extension context locks, unlocks, or resets the vault, this page immediately synchronizes its UI and clears sensitive DOM/memory on lock.
- **`#claude` section disclosure update:**
  - Replace the `"Stored unencrypted."` bullet in `.disclosure` with:
    - `<strong>Encrypted with your passphrase.</strong> Your API key and friends list are encrypted in this Chrome profile and stay unlocked until you click Lock now or quit Chrome completely. To cap what any key can cost, set a spend limit in the Anthropic Console. <a href="https://platform.claude.com/settings/spend-limits" target="_blank" rel="noopener">Set a spend limit</a>`
  - Add to the `"Never sent:"` bullet: `Your passphrase never leaves this browser.`
- **`#friends` section export update (P2):**
  - Keep `Export JSON` (`#export-btn`, available only while unlocked and list is non-empty).
  - Update `#export-note` (`.small.muted`) to: `Exports a readable, unencrypted JSON file of your friends list (including email addresses, excluding your API key). Anyone with this file can read it outside Chrome.`
- **`#privacy` section update:**
  - Paragraph 1: `Your API key and friends list are encrypted with your passphrase in this browser and stay unlocked until you click Lock now or quit Chrome completely. Your model, match, and auto-detect preferences aren't encrypted. Job postings you view are kept in memory until you close their tab or quit Chrome completely.`
  - Paragraph 3: `To delete everything Job Notifier stored, use Forgot passphrase? to erase saved data or remove it from Chrome's Extensions page. To remove only your key, unlock settings, clear the key field, and save.`

### Popup (`popup.html`, `popup.css`, `popup.js`)

Passphrase controls never appear in the popup. On open (`init()`), the popup queries the worker's vault/session status before checking key/friends or reading the active tab.

| State | When | Heading (`h2[tabindex="-1"]`) | Body | Actions |
|---|---|---|---|---|
| Uninitialized | No vault created yet (`uninitialized` or `needs-conversion`) | `Set up Job Notifier` | `Job Notifier encrypts your Anthropic API key and friends list in this browser. Open settings to create a passphrase, add your key, and add at least one friend.` | Primary `Open settings` (`openSettings()`) |
| Locked | Vault exists, session is locked | `Locked` | `Unlock your saved API key and friends list in settings to analyze job postings.` | Primary `Open settings to unlock` (`openSettings()`) |
| Unreadable | Stored vault record is damaged/unsupported | `Saved data can't be read` | `Your encrypted data couldn't be read. Open settings to inspect or reset it.` | Primary `Open settings` (`openSettings()`) |
| Unlocked, no API key | Vault unlocked, no key saved | `Set up Job Notifier` | (Existing setup body from `public-release.md` criterion 11) | Primary `Open settings` |
| Unlocked, no friends / none included | Vault unlocked, key set | (Existing `Add a friend first` / `No friends included` states) | (Existing copy) | Primary `Add friends` / `Open settings` |
| Unlocked, ready / loading / results / error | Vault unlocked, key + friends ok | (Existing input, loading, results, no-matches, error states) | (Existing copy) | (Existing actions) |

- **No error styling on setup/locked:** neither `Uninitialized` nor `Locked` uses `.error-block` or "failed" wording.
- **Auto-detect switch:** remains usable in `.popup-header` in all states because `autoDetect` is a non-sensitive preference.
- **Unlocked footer with Lock now:** when the vault is `unlocked`, show a slim footer below `#panel` (`.popup-footer`: `margin-top: var(--space-4); padding-top: var(--space-3); border-top: 1px solid var(--border); display: flex; align-items: center; justify-content: space-between;`):
  - Left: `<span class="small muted">Unlocked for this session</span>`
  - Right: text button `Lock now` (`#popup-lock-btn`).
  - Hide `.popup-footer` whenever not `unlocked`.
  - Clicking `Lock now` sends `VAULT_LOCK` to the worker, immediately clears `input`, any rendered results/drafts/job summary in `#panel`, hides `.popup-footer`, shows the `Locked` state, and focuses the `Locked` heading.
- **Mid-flight or external lock handling:**
  - If `ANALYZE_JOB` fails with `LOCKED`, if the worker broadcasts `VAULT_LOCKED` while the popup is open, or if a late analysis reply arrives after locking: immediately discard any results/friend data, clear `#panel`, hide `.popup-footer`, transition to `Locked`, and move focus to the `Locked` heading (if `moveFocus` is true or results/loading were visible). Never display stale friend data.
- **Return / reopen behavior:**
  - Opening settings closes Chrome's toolbar popup. When the user unlocks in settings and reopens the popup on the posting tab, `init()` sees `unlocked`, verifies key/friends, and runs `readPage()`, restoring `"Job posting found"` (or `"Paste a job posting"`) and waiting for a **Find friends** click (zero automatic API requests on unlock/reopen).
  - If the popup remains open when settings unlocks the vault (`VAULT_CHANGED`), re-run `init()` automatically.

### Overlay (`overlay.html`, `overlay.css`, `overlay.js`)

The iframe isolation, transparent `html, body`, `420px` top-right panel (`8px` inset under `480px`), `Close` button, `role="dialog"`, `aria-modal="true"`, `aria-labelledby="state-heading"`, Tab wrapping, `Escape` handling, and `OVERLAY_READY` gating from `public-release.md` stay unchanged. Passphrase controls never appear in the overlay.

On `load()`, `OVERLAY_STATE` returns `{ state: 'none' }` or `{ state: 'prompt', posting: { title, meta }, vaultState: 'uninitialized' | 'needs-conversion' | 'locked' | 'unreadable' | 'unlocked', hasKey }` — carrying zero key or friend data (`hasKey` omitted unless `unlocked`).

- **Confirmation prompt variants (`state: 'prompt'`):**
  - **`vaultState === 'uninitialized' || vaultState === 'needs-conversion'`:**
    - Heading: `Find friends for this job?`
    - Posting block (`.posting`): `posting.title` and `posting.meta` (from the tab's posting, never from encrypted storage).
    - Body (`#prompt-body`, `aria-describedby`): `Set up Job Notifier in settings first. You'll create a passphrase, add your Anthropic API key, and add at least one friend.`
    - Actions: Primary `Open settings` (`recheck = true`, calls `openSettings()`), Secondary `Not now` (`OVERLAY_CLOSE`).
  - **`vaultState === 'locked'`:**
    - Heading: `Find friends for this job?`
    - Posting block (`.posting`): `posting.title` and `posting.meta`.
    - Body (`#prompt-body`, `aria-describedby`): `Your saved API key and friends list are locked. Open settings to unlock them, then return here to run the check.`
    - Actions: Primary `Open settings to unlock` (`recheck = true`, calls `openSettings()`), Secondary `Not now` (`OVERLAY_CLOSE`).
  - **`vaultState === 'unreadable'`:**
    - Heading: `Find friends for this job?`
    - Posting block (`.posting`): `posting.title` and `posting.meta`.
    - Body (`#prompt-body`, `aria-describedby`): `Your saved data can't be read. Open settings to inspect or reset it.`
    - Actions: Primary `Open settings` (`recheck = true`, calls `openSettings()`), Secondary `Not now` (`OVERLAY_CLOSE`).
  - **`vaultState === 'unlocked' && !hasKey`:** existing no-key prompt (`Open settings` / `Not now`, `recheck = true`).
  - **`vaultState === 'unlocked' && hasKey`:** existing confirmation prompt (`Find friends` / `Not now`).
- **Locked mid-flow or on results (`ANALYZE_TAB` returns `code: 'LOCKED'`, or worker pushes `VAULT_LOCKED` while open):**
  - Immediately clear `#panel-body` and discard any in-memory `result`, match cards, drafts, or friend names/emails. Ignore any late `ANALYZE_TAB` response that arrives after lock.
  - Show `locked-cleared` state (`recheck = true`):
    - Heading (`#state-heading[tabindex="-1"]`): `Job Notifier is locked`
    - Body: `Your saved API key and friends list were locked, so any results were cleared. Open settings to unlock.`
    - Actions: Primary `Open settings to unlock` (`openSettings()`), Secondary `Close` (`OVERLAY_CLOSE`).
    - Focus moves to `#state-heading`.
    - Scrim click closes this state (`state !== 'results'`), `Escape` closes, Tab wraps between `Close`, `Open settings to unlock`, and `Close`.
- **Return from settings (`visibilitychange` when `recheck` is true):**
  - When the user unlocks (or completes setup) in settings and returns to the confirmation tab, `overlay.js` re-runs `load()` (`OVERLAY_STATE`).
  - If the tab's prompt state is still valid (`state === 'prompt'`, `vaultState === 'unlocked'`, `hasKey === true`), the overlay updates to the unlocked confirmation prompt (`Find friends for this job?` with **Find friends** primary button), focuses `#state-heading`, and waits for the user's click (unlocking never triggers `ANALYZE_TAB` automatically).
  - If the prompt is no longer valid (`state === 'none'`), `overlay.js` calls `OVERLAY_CLOSE`.

### Store assets and review screenshots (`docs/assets/` and `dist/review/`)

All store screenshots use `1280x800` RGB PNG (color type 2, no transparency, no captions/frames/mockups) and the fictional Kestrel Grid / Priya Shah / Marcus Lee / Dana Okafor demo data from `public-release.md`.

**Updated Chrome Web Store screenshots (`docs/assets/`):**
1. `screenshot-1-overlay.png` (1280x800, viewport only): unchanged layout — demo confirmation page behind scrim with unlocked overlay showing `"2 friends might want this job"` and two fictional match cards.
2. `screenshot-2-popup.png` (1280x800, whole Chrome browser window captured manually in real Chrome with toolbar visible): demo posting at `http://kestrel-grid.localhost:<port>/`, unlocked popup in `"Job posting found"` state showing `"Find friends"` and the slim `"Unlocked for this session · Lock now"` footer.
3. `screenshot-3-settings.png` (1280x800, viewport only): top of unlocked settings page showing `h1`, updated lede, `#vault` `"Passphrase lock"` with `"Lock now"`, and `#claude` with the **updated `"Encrypted with your passphrase."` disclosure box**, masked API key field, and model select.
4. `screenshot-4-prompt.png` (1280x800, viewport only): unlocked confirmation prompt on the demo confirmation page (`"Find friends for this job?"` + `"Find friends"`).

**Required review screenshots (`dist/review/`, fictional data) for Designer sign-off:**
- **Settings:** `settings-setup-1280.png`, `settings-setup-375.png`, `settings-setup-mismatch-1280.png`, `settings-p3-convert-1280.png`, `settings-locked-1280.png`, `settings-locked-error-1280.png`, `settings-reset-confirm-1280.png`, `settings-unreadable-1280.png`, `settings-unlocked-1280.png`, `settings-unlocked-800.png`, `settings-unlocked-375.png`.
- **Popup (380px wide):** `popup-uninitialized.png`, `popup-locked.png`, `popup-posting-found.png`.
- **Overlay (1280x800 composite + 375px narrow):** `overlay-uninitialized.png`, `overlay-locked-prompt.png`, `overlay-locked-cleared.png`.

## Security

### Assets, trust boundaries, and untrusted inputs

- **Assets to protect:**
  - The user's Anthropic API key (`apiKey`) and the billing charges authorized by it.
  - All saved friend fields (`name`, `contact`, `skills`, `interests`, `level`, `notify`) and the user's personal social graph.
  - Derived encryption key material (`CryptoKey`, raw session key bytes) and the user's passphrase.
  - Existing release assets (job-search activity, `jobs`/`prompts` session state, host pages) remain protected under `docs/specs/public-release.md` criteria 24–38.
- **Trust boundaries:**
  1. **Persistent local storage (`chrome.storage.local`):** Readable offline from Chrome profile/disk backups and readable at runtime by extension content scripts. Must never hold the passphrase, reusable derived key, plaintext `apiKey`, or plaintext friend records (except transient pre-conversion P3 data prior to explicit conversion/reset).
  2. **Session memory (`chrome.storage.session`):** Memory-only for the Chrome browser session and kept at Chrome's default `TRUSTED_CONTEXTS` access level (`setAccessLevel` is never called). Content scripts cannot access it. Never stores the passphrase or plaintext API key/friends; holds only the session-scoped `vaultKey` (while unlocked) alongside existing `jobs`, `prompts`, and `prompted`.
  3. **Service worker (`background.js`):** Sole authority for cryptographic operations, `vault` reads/writes, lock/unlock state, and Claude API calls.
  4. **Static extension pages (`options.html`, `popup.html`):** Run on `chrome-extension://<chrome.runtime.id>/` with CSP `script-src 'self'; object-src 'self'`. Only `options.html` handles passphrase entry and decrypted `apiKey`/friend editing. `popup.html` receives only minimal status before analysis and analysis results when unlocked.
  5. **Web-accessible overlay frame (`overlay.html`):** Loaded with `use_dynamic_url: true` inside a host-page iframe. Never handles passphrases, never initiates lock/unlock/setup/reset, and receives only tab-owned prompt status and analysis results while unlocked.
  6. **Content scripts (`content.js`) and host pages:** Untrusted renderer boundary. Zero access to `chrome.storage` or any `VAULT_*` message.

### Crypto envelope, KDF/AEAD parameters, and versioned record schema

All cryptographic operations use Chrome's built-in Web Crypto API (`crypto.subtle` and `crypto.getRandomValues`) with no third-party crypto dependencies.

- **KDF:** `PBKDF2` with `SHA-256`, **600,000 iterations**, deriving 256 bits via `crypto.subtle.deriveBits`.
  - **Salt:** 16 random bytes (128 bits) generated via `crypto.getRandomValues` on passphrase creation/reset/conversion.
  - **Passphrase constraints:** Minimum 8 characters, maximum 512 characters, non-empty and not all-whitespace; exact bytes preserved (no silent trimming). Setup requires exact match on confirmation. The passphrase `CryptoKey` (`importKey('raw', ..., 'PBKDF2', false, ['deriveBits'])`) is non-extractable and discarded immediately after `deriveBits`.
  - **Parameter validation on read:** Reject any record whose `iterations` is not an integer within `[600000, 5000000]` (prevents both downgrade and CPU-exhaustion DoS).
- **AEAD Cipher:** `AES-GCM` with a 256-bit key (`tagLength: 128`).
  - **IV / Nonce:** 12 random bytes (96 bits) generated fresh via `crypto.getRandomValues` on **every** encryption/write. Never reused or incremented.
  - **Additional Authenticated Data (AAD):** UTF-8 encoding of `"job-notifier:vault:v1|" + kdf.name + "|" + kdf.hash + "|" + kdf.iterations + "|" + kdf.salt`, binding the ciphertext to the record version and KDF parameters so header tampering fails GCM tag verification.
- **Persistent storage schema (`chrome.storage.local`):**
  - `vault` (encrypted envelope):
    ```json
    {
      "v": 1,
      "kdf": {
        "name": "PBKDF2",
        "hash": "SHA-256",
        "iterations": 600000,
        "salt": "<base64, 16 decoded bytes>"
      },
      "cipher": {
        "name": "AES-GCM",
        "tagLength": 128,
        "iv": "<base64, 12 decoded bytes>"
      },
      "ct": "<base64, ciphertext + 16-byte GCM auth tag>"
    }
    ```
  - Decrypted plaintext payload inside `ct`:
    ```json
    {
      "v": 1,
      "apiKey": "",
      "friends": []
    }
    ```
    After decryption and JSON parsing, `apiKey` is normalized (`JN.str(..., 500)`) and `friends` is validated via `JN.storedFriends(...)` (and `v === 1` verified).
  - Non-sensitive preferences remain in `chrome.storage.local`:
    - `settings`: `{ model, effort, threshold }` — **`apiKey` is removed from `settings` and must never be written to `settings` in 2.0.0.**
    - `autoDetect`: `boolean`.
- **Fail-closed record validation:** If `vault` exists and fails schema validation (unknown `v`, invalid KDF/cipher names, out-of-range iterations, non-16-byte salt, non-12-byte IV, invalid base64, or missing `ct`), treat storage as `unreadable`—never fall back to plaintext, never auto-overwrite `vault`, and require an explicit user reset to start fresh.

### Session storage boundary (P1: once per Chrome session + Lock now)

- **Unlock lifetime:**
  - On valid unlock (or setup/conversion), `deriveBits` produces 32 raw key bytes. The worker imports a non-extractable working `CryptoKey` (`extractable: false`, `['encrypt', 'decrypt']`), authenticates/decrypts `vault` to verify the passphrase before marking the session unlocked, writes the 32-byte key as base64 to `chrome.storage.session` under `vaultKey`, and zeroes the temporary `Uint8Array` buffer.
  - The passphrase travels only from settings to the manifest service worker through its direct message channel. It never enters browser storage, logs, or extension-wide messaging.
- **Service worker restart (same Chrome session):**
  - `chrome.storage.session` persists across MV3 service worker idle restarts. On demand, the worker reads `vaultKey` from `chrome.storage.session`, imports it (`extractable: false`), and decrypts + authenticates `vault` from `chrome.storage.local`. No re-prompt is required.
- **Browser restart / extension reload:**
  - Chrome clears `chrome.storage.session` automatically. `vaultKey` is absent, so the extension starts **locked** and never auto-unlocks.
- **Lock now:**
  - Immediately increments `vaultEpoch` (invalidating all in-flight operations), zeroes/drops any in-memory `CryptoKey` or cached decrypted data in the worker, aborts active Claude `fetch` requests, removes `vaultKey` from `chrome.storage.session`, and broadcasts a data-free `VAULT_LOCKED` signal to extension pages.
  - All visible extension surfaces (`options.html`, `popup.html`, `overlay.html`) immediately clear API key inputs, friend lists, pending form/import edits, and displayed analysis results/drafts/recruiter fields.
  - `jobs` and `prompts` in `chrome.storage.session` (which contain no vault secrets) may remain under existing TTL/navigation rules so returning to the posting/confirmation flow after unlock still works when available.

### Allowed sender contexts and message contracts

Every worker listener checks `sender` before dispatching:

| Context | Sender check | Allowed messages | Prohibited |
|---|---|---|---|
| **Settings (`options.html`)** | Direct service-worker message from this extension's top-level settings `WindowClient`, with one reply port. `isSettingsSender` verifies the data-free `VAULT_LOCK` runtime message. | `VAULT_STATUS`, `VAULT_SETUP`, `VAULT_UNLOCK`, `VAULT_LOCK`, `VAULT_RESET`, `VAULT_GET_DATA`, `VAULT_SAVE_CLAUDE`, `VAULT_SAVE_FRIENDS`, `VAULT_CONVERT_LEGACY` | Passphrase stays out of storage and logs. `VAULT_GET_DATA` is rejected when locked. |
| **Popup (`popup.html`)** | `isStaticExtensionSender`: same origin check, `pathname === '/popup.html'`, `frameId === 0 \|\| undefined` | `POPUP_STATUS` (minimal state only), `VAULT_LOCK`, port `analyze` (`ANALYZE_JOB`) | `VAULT_SETUP`, `VAULT_UNLOCK`, `VAULT_RESET`, `VAULT_GET_DATA`, `VAULT_SAVE_*`, `VAULT_CONVERT_LEGACY`; never reads `vault` or `vaultKey` directly |
| **Overlay (`overlay.html`)** | `isExtensionPage` + `isOverlayFrame` + `ownsPrompt` (browser-assigned `frameId` & `documentId`) | `OVERLAY_STATE`, `OVERLAY_READY`, `OVERLAY_CLOSE`, port `analyze` (`ANALYZE_TAB`) | All `VAULT_*` messages; never reads `chrome.storage` |
| **Content script (`content.js`)** | `isValidContentMessage` (`sender.tab`, `frameId === 0`, `http(s):` URL, capped strings) | `JOB_SEEN`, `CONFIRMATION_SEEN`, `OVERLAY_DISMISSED` | All `VAULT_*` messages, all `analyze` ports, all `chrome.storage` access |
| **External pages / extensions** | No `onMessageExternal`, no `onConnectExternal`, no `externally_connectable` | None | All |

**Minimum-disclosure replies before analysis:**
- When `vaultState` is `'uninitialized'`, `'needs-conversion'`, `'locked'`, or `'unreadable'`, `POPUP_STATUS` and `OVERLAY_STATE` return `{ vaultState }` (plus `posting` for `OVERLAY_STATE` if a valid tab prompt exists) and **omit** `hasKey`, `friendsStatus`, `apiKey`, and `friends`.
- When `vaultState === 'unlocked'`, `POPUP_STATUS` and `OVERLAY_STATE` return `{ vaultState: 'unlocked', hasKey, friendsStatus }` (booleans/enum `'empty' | 'none-included' | 'ok'` only—no API key, no friend names/contacts/skills).

### Concurrency and race guarantees

All vault reads/writes execute sequentially through a single worker promise queue (`inVault`), paired with a synchronous monotonic `vaultEpoch` counter and a `vaultRev` revision token:

1. **Lock during Unlock:** `VAULT_LOCK` increments `vaultEpoch` **synchronously** upon receipt (before awaiting the queue), clears in-memory state, and queues `chrome.storage.session.remove('vaultKey')`. `VAULT_UNLOCK` captures `startEpoch = vaultEpoch` before PBKDF2 and verifies `startEpoch === vaultEpoch` after `deriveBits` and decryption complete. If `vaultEpoch` changed, `VAULT_UNLOCK` discards the key, does **not** write `vaultKey`, and replies `{ ok: false, code: 'LOCKED' }`.
2. **Lock during Save:** `VAULT_SAVE_*` checks lock state and `vaultEpoch` inside `inVault` before writing. If already locked, it aborts with `{ ok: false, code: 'LOCKED' }` without touching `chrome.storage.local.vault`. If encryption or `chrome.storage.local.set` fails, `vault` in `chrome.storage.local` is never overwritten and the last confirmed ciphertext remains readable.
3. **Lock during Analysis:** The worker captures `analysisEpoch` when it receives an authenticated analysis request. It checks the epoch after overlay prompt lookup, before the `inVault` credential snapshot, before `fetch`, and before posting results. `VAULT_LOCK` aborts registered requests. A changed epoch ends the old request with `{ ok: false, code: 'LOCKED' }`, including when the user has already started a new unlocked session. UI surfaces receiving `VAULT_LOCKED` or `code === 'LOCKED'` discard in-flight or late results.
4. **Concurrent edits from two settings pages:** `VAULT_GET_DATA` returns a `vaultRev` token (hash/counter of the current `vault` record). `VAULT_SAVE_*` requires `expectedRev`. If another settings tab saved or reset `vault` first, `expectedRev !== currentRev` rejects the stale write with `{ ok: false, code: 'STALE_EDIT' }`, preserving the newer ciphertext. Successful saves/setups/resets broadcast `VAULT_CHANGED` so other open `options.html` tabs reload fresh state.

### P2: Readable JSON export rules

- Exporting friends requires the vault to be **unlocked** (`VAULT_GET_DATA` / unlocked settings state) and an **explicit user click** on Export.
- The exported file (`job-notifier-friends.json`) contains only the validated JSON array of friend objects (`JN.cleanFriends` schema), preserving compatibility with legacy JSON import (`JN.parseFriendsImport`).
- Exports **never** include `apiKey`, passphrase, `vaultKey`, `vault` envelope metadata (`salt`, `iv`, `ct`), `settings` (`model`, `effort`, `threshold`), or `autoDetect`.
- The settings UI clearly labels the export as **unencrypted and readable outside Chrome**.

### P3: Pre-encryption 2.0.0 conversion detection and cleanup vs 1.x non-upgrade

- **Strict candidate detection (`detectLegacyPreEncryption200`):**
  - Only runs when `vault` is **absent** in `chrome.storage.local`.
  - Requires non-empty legacy data (`settings.apiKey` non-blank or `friends.length > 0`).
  - Validates strictly against the exact pre-encryption 2.0.0 schema:
    - If `settings` is present: plain object with **only** keys in `['apiKey', 'model', 'effort', 'threshold']`, `model` in `JN.MODELS`, `effort` in `JN.EFFORTS`, `threshold` finite in `[0, 1]`, and `apiKey` empty or starting with `sk-ant-`.
    - If `friends` is present: array passing `JN.cleanFriends(friends)` with zero errors and every entry having **only** known keys (`name`, `contact`, `skills`, `interests`, `level`, `notify`) of exact expected types (`Array` for `skills`/`interests`, `boolean` for `notify`, `string` for `name`/`contact`/`level`).
  - **1.x non-upgrade:** Any profile failing this strict check (for example, missing `effort`, an unlisted/free-text 1.x model, extra legacy properties, or non-conforming friend records) is **not** a P3 candidate and is never upgraded automatically or offered conversion.
- **No silent startup use or erasure:** Extension startup, unlock-screen cancellation, and popup/overlay checks never erase, migrate, or read plaintext `settings.apiKey` or `friends` for API calls. While `vault` is absent, analysis is blocked.
- **Verify-before-clear conversion protocol:**
  1. User explicitly chooses **Encrypt saved data** in `options.html` and sets/confirms a new passphrase.
  2. Inside `inVault`, re-read and re-validate legacy `settings` and `friends`. Encrypt `{ v: 1, apiKey, friends }` into a `vault` record.
  3. Write `{ vault }` to `chrome.storage.local` **first**, leaving legacy `settings.apiKey` and `friends` intact.
  4. Immediately read `vault` back from `chrome.storage.local`, decrypt and authenticate it with the new `CryptoKey`, and verify decrypted `apiKey` and `friends` match the source payload.
  5. Only if step 4 succeeds: overwrite `settings` with `{ model, effort, threshold }` (omitting `apiKey`), `chrome.storage.local.remove('friends')`, and write `vaultKey` to `chrome.storage.session`.
  - **Interruption recovery:**
    - If interrupted before step 3 completes or if step 4 fails: remove any unverified partial `vault` written in that attempt; original plaintext remains untouched and retryable without combining records or dropping edits.
    - If interrupted *between* step 4 and step 5 (so a valid `vault` exists alongside residual `settings.apiKey` or `friends`): startup treats the extension as **locked** using `vault` (never plaintext); on the next successful passphrase unlock (authenticating `vault`), the worker completes logical cleanup of residual `settings.apiKey` and `friends` without altering `vault`.
- **Reset / forgotten passphrase:** Requires explicit confirmation identifying that the saved API key and all saved friends will be permanently removed. Canceling leaves `vault` (and any legacy data) intact. Confirming clears `vault`, legacy `friends`, `settings.apiKey` (resetting `settings` to defaults if unconvertible), and `vaultKey`.
- **Cleanup limits disclosure:** `chrome.storage.local` removal/overwrite performs logical deletion via Chrome's storage API. Prior underlying storage compaction blocks or OS/browser profile backups created before encryption or reset are outside extension control and are documented in privacy/settings disclosures.

### Threats and mitigations

| Severity | Threat | Mitigation |
|---|---|---|
| **High** | Offline reading of Chrome profile / disk backups exposes API key or friend emails | Encrypt `apiKey` and all friend fields with AES-256-GCM under a PBKDF2-SHA256 (600,000 iterations) key; never store passphrase or `vaultKey` in `chrome.storage.local` or `sync`. |
| **High** | Offline brute-force guessing against stolen `vault` | 128-bit random per-vault salt + 600,000 PBKDF2-SHA256 iterations; minimum 8-character non-whitespace passphrase; user-facing guidance on strong passphrases and no recovery backdoor. |
| **High** | Content script or compromised site renderer reads `chrome.storage.local` or spoofs vault messages | Sensitive data in `chrome.storage.local` is encrypted; `chrome.storage.session` stays at `TRUSTED_CONTEXTS`; `VAULT_*` messages require `isSettingsSender` (`options.html` static origin) and reject content scripts and `overlay.html`. |
| **Medium** | GCM nonce reuse breaks confidentiality/authenticity across writes | Generate a fresh 96-bit CSPRNG IV on every encryption; bind version and KDF parameters in AAD. |
| **Medium** | Stale extension pages or late API responses leak data after Lock now | Increment `vaultEpoch` synchronously on lock, abort active `fetch`, discard pre-lock unlock/save/analysis results, clear `vaultKey` from `chrome.storage.session`, and broadcast `VAULT_LOCKED` so UI surfaces wipe DOM fields and results. |
| **Medium** | Tampered, corrupted, or downgraded `vault` record causes silent plaintext fallback or crash | Strict envelope schema and KDF iteration bounds `[600000, 5000000]`; fail closed to `unreadable` state without overwriting `vault` or using legacy plaintext. |
| **Medium** | Interrupted P3 conversion loses data or leaves plaintext active | Two-phase verify-before-clear: write `vault`, read back and GCM-authenticate before stripping `settings.apiKey` and removing `friends`; never use legacy plaintext while `vault` is absent or locked. |
| **Medium** | Two open settings tabs overwrite each other's changes | Worker `inVault` serialization + `expectedRev` optimistic concurrency check + `VAULT_CHANGED` broadcast. |
| **Low** | Accidental exposure of secrets in logs, error messages, diagnostics, or P2 exports | Never log passphrase, `vaultKey`, `apiKey`, or friend records; export requires unlock + click and outputs validated friends only, labeled as readable outside Chrome. |

### Residual threats (accepted / disclosed)

1. **While unlocked in an active Chrome session (P1):** `vaultKey` resides in `chrome.storage.session` (and `CryptoKey` / transient plaintext in service worker memory) until **Lock now** or browser close. An attacker with live OS memory access to the Chrome browser process, OS swap/hibernation files containing RAM pages, or local Chrome DevTools access to the extension background/settings pages while unlocked can recover the session key or decrypted data.
2. **Prior disk snapshots and LevelDB compaction lag:** Profile backups, OS snapshots, or uncompacted LevelDB blocks written *before* P3 conversion or reset are outside Chrome's extension API and cannot be retroactively scrubbed by the extension. Users migrating a previously plaintext dev profile should rotate their Anthropic API key if prior disk exposure is a concern.
3. **Weak user-chosen passphrases:** Offline resistance depends on passphrase entropy; a short or dictionary passphrase remains vulnerable to offline cracking if a disk copy of `vault` is obtained.
4. **Anthropic API transport/processing while unlocked:** As disclosed in settings and `PRIVACY.md`, once unlocked and explicitly triggered by clicking **Find friends**, `apiKey` authorizes the HTTPS call to `https://api.anthropic.com` and included friends' names, skills, interests, and levels are sent to Anthropic.

## Handoff log

| Role | Result and evidence | Next owner |
|---|---|---|
| Lead | User chose passphrase encryption for saved data. Existing release review round 3 passed for code, security, and design. Full suite passed 95/95 before encryption work. | PM |
| PM | Drafted scope and P-01–P-10. Routed P1 unlock duration, P2 export, and P3 private development profile handling as needs-user decisions. No implementation started. | Lead and user |
| Lead | Collected P1 (session unlock + Lock now), P2 (readable JSON export), P3 (explicit pre-encryption 2.0.0 conversion) from the user and updated `docs/specs/passphrase-storage.md`. | Security and Designer |
| Security | Completed `## Security` section (PBKDF2-SHA256 600k + AES-256-GCM envelope with AAD, session `vaultKey` boundary, sender matrix, `inVault`/`vaultEpoch`/`expectedRev` concurrency rules, P2 export, P3 verify-before-clear + 1.x non-upgrade, threats and residual risks). | Lead |
| Designer | Completed `## Design` section (settings `#vault` states, disclosure updates, P2 export label, P3 conversion and reset panels, popup & overlay locked/uninitialized/unreadable/mid-flight-lock states, and store/review screenshot plan). | Lead and QA |
| Lead | Integrated `## Design` and `## Security` into `docs/specs/passphrase-storage.md` with aligned validation copy, `unreadable` handling in popup/overlay, and reset-panel scope. | QA |
| QA | Wrote 15 failing tests in `test/vault.test.js` covering P-01–P-09 and verified red gate: `node --test test/vault.test.js` 0/15 pass, `npm test` 95/110 pass (all 95 existing tests green). Logged UI/Chrome screenshot checks. | Engineer |
| Engineer | Implemented passphrase vault in `lib/core.js`, `background.js`, `options.*`, `popup.*`, `overlay.js`, updated `PRIVACY.md`/`DOCS.md`/`README.md`/`docs/store-listing.md`, and aligned `test/background.test.js` & `test/release.test.js`. `npm test` 110/110, `node --check` 7/7, `git diff --check` pass. | Lead |
| Lead | Updated `docs/assets/harness/stub.js` & `render.js` and rendered store assets + 36 review screenshots into `dist/review-vault/`. | Reviewer, Designer, Security |
| Security | Round 1 **PASS** — Verified PBKDF2-SHA256/AES-GCM envelope, AAD, session `vaultKey` boundary, sender matrix, concurrency guards, P2 export, P3 verify-before-clear + 1.x non-upgrade, and disclosures. | Lead |
| Designer | Round 1 **FAIL** — Two findings: (1) `ui.css` `[aria-invalid="true"]` loses specificity to `input[type=...]`, leaving invalid passphrase borders grey; (2) `docs/assets/screenshot-3-settings.png` (1280x800) clips `#api-key` mid-input and pushes `#model` below the fold. | Lead |
| Reviewer | Round 1 **FAIL** — Two blocking bugs in `background.js`: (1) `handleVaultConvertLegacy` deletes verified `vault` if cleanup/`session.set` throws after `cleanupResidualLegacy` starts; (2) `handleVaultSaveClaude`/`Friends` do not re-check `vaultEpoch` after `storage.local.set` before broadcasting `VAULT_CHANGED`/returning `ok: true` (plus non-blocking `options.js` `VAULT_CHANGED` suppression on remote reset, `running.delete` identity guard, and save deduplication). | QA, Engineer |
| QA | Added 2 regression tests in `test/vault.test.js` for `handleVaultConvertLegacy` post-cleanup error preservation and `VAULT_LOCK` during `storage.local.set`. Confirmed red gate: 15/17 pass, both new regressions fail as expected. | Engineer |
| Engineer | Fixed all Round 1 findings (`background.js` `wroteVault` ordering & `saveUnlockedVault` post-write epoch guard + `running.delete` identity check; `options.js` lock/remote-reset race guards; `ui.css` `[aria-invalid="true"]` specificity; `options.css` compact unlocked `#vault` layout; `render.js` narrow vault overlay captures). `npm test` 112/112, `node --check` 7/7, `git diff --check` pass. Re-rendered `docs/assets/` and `dist/review-vault-r2/`. | Reviewer, Designer, Security |
| Security | Round 2 **PASS** — Verified `handleVaultConvertLegacy` `wroteVault` ordering, `saveUnlockedVault` post-write `vaultEpoch` guard, `analyzeOnce` `running.delete` identity check, `options.js` `LOCKED`/`VAULT_CHANGED` guards, and both new P-08/P-04 regression tests. | Lead |
| Designer | Round 2 **PASS** — Verified `--error` borders in `settings-setup-mismatch-1280.png` and `settings-locked-error-1280.png`, compact `#vault.is-unlocked` fitting `screenshot-3-settings.png` cleanly in 1280x800, and narrow overlay captures (`dist/review-vault-r2/`). Whole-window `screenshot-2-popup.png` and live Chrome keyboard flow remain for manual Chrome walkthrough. | Lead |
| Reviewer | Round 2 **FAIL** (1 finding in `options.js`) — Verified all Round 1 `background.js`, CSS, and test fixes, but `options.js:762` drops suppression of `confirmReset`'s own `VAULT_CHANGED (uninitialized)` broadcast, causing concurrent `loadVault` to wipe `#setup-status`. | Engineer |
| Engineer | Fixed Round 2 finding in `options.js` (`options.js:762` checks `vaultBusy \|\| msg.vaultState === 'unlocked'`; `options.js:280, 311, 352` call `loadVault({ focus: true })` on `LOCKED`). `npm test` 112/112, `node --check` 7/7, `git diff --check` pass. | Reviewer |
| Reviewer | Round 3 **PASS** — Verified `options.js` reset-broadcast suppression (`vaultBusy \|\| msg.vaultState === 'unlocked'`) and `loadVault` reconciliation on `LOCKED`, along with all Round 1–2 fixes. | QA |
| QA | Final milestone verification at `e7cd5da`: `npm test` **112/112** passed (`test/vault.test.js` 17/17 + existing release/core/background/content suites), `node --check` 7/7 (`npm run check --script-shell=bash`) and `git diff --check` passed. Rebuilt `dist/job-notifier-2.0.0.zip` (SHA-256 `5F682FA66D4BC150A8275DFE16A2AB13E235989A8901A781C6B4AB284E02092C`); runtime allowlist and zero-secret scan verified. | PM |
| PM | Passphrase-encryption milestone closeout at `e7cd5da`: audited `P-01`–`P-10` and `1`–`38` against QA, security, designer, and reviewer evidence; updated `PROGRESS.md` and `HANDOFF.md`; drafted the release retro. Code, tests, docs, assets (except manual whole-window `screenshot-2-popup.png`), and release ZIP are verified. Final release closeout awaits the user's clean-profile Chrome walkthrough, whole-window `screenshot-2-popup.png` recapture, and `feat/public-release` PR / remote CI pass. | Lead and user |
| PM | Pre-sign-off audit (2026-11-26) at HEAD `b33a65c`. The full table, evidence, and rule are in `public-release.md`, under "PM pre-sign-off audit (2026-11-26)" in its handoff log. **Met:** P-02, P-03, P-08, P-09 (tests plus security and code-reviewer PASS). **Pending manual evidence** (steps in `docs/release-walkthrough.md`): P-01 (2.2, 3.3, 3.10, 11.4), P-04 (4.1–4.8), P-05 (2.1, 4.2, 9.2, 12.1, 12.2), P-06 (1.3, 4.1, 4.5, 4.6, 6.6–6.8, 8.5), P-07 (3.5–3.9, 3.12), P-10 (1.1, 13). **Not met:** none. Remote CI on PR #5 now passes 2/2 after `fa35c09`. The current release zip SHA-256 is `a972905259c46777057c7d70591759f1fa6126302fc71b7232c0b774d8837f44`, which replaces the `e7cd5da` hash above. Correction to the PM row above: that release retro draft was never saved. The interim retro is now in the shared team-notes `retros.md`. | User (Chrome walkthrough), then PM |

**Team lead, independent security review of the vault (Claude `security`, 2026-11-26, at 62b7c48):** PASS. Nothing Critical, High or Medium; six Lows. Low 1: `analyze()` captures `analysisEpoch` after the queue, so a Lock right after Find friends can still send the request (background.js:553-586; fix before release). Low 2: options.js `sendWorker` uses `runtime.sendMessage`, which also delivers the passphrase, key and friends to other extension frames (popup, overlay); use a worker-only port. Low 3: options.html:311 says "settings" are encrypted; only the key and friends are. Low 4: a profile that fails the strict P3 check keeps plaintext after setup until the next unlock silently deletes it; dev-only (1.x and pre-encryption 2.0.0 were never public), accepted by the lead as a residual. Low 5: "close Chrome" should be "quit Chrome completely". Low 6: the store listing's authentication-info answer should cover the passphrase. Real-Chrome checks: content-script isolation of `storage.session`/`onChanged` (High if it fails), password-manager prompts, a real restart, windows-closed-but-running, reload/update locked, the lock race after the fix, a LevelDB grep, and `setAccessLevel` support. Next: qa tests for Lows 1–2, engineer fixes 1, 2, 3, 5 and 6, and qa adds the automatable checks to the pre-check.

**QA, red tests for the security review's Lows (2026-11-26, at 0097ab7):** `npm test` is 154 tests, 136 pass, 18 fail, each for the intended reason.
- **Low 1:** after a Lock sent in the same task as `ANALYZE_JOB`, the popup must get `{ ok: false, code: 'LOCKED' }` and no fetch happens. Fails now: results come back. The overlay's `ANALYZE_TAB` variant already passes (its prompt lookup queues behind the Lock) and stays as a guard.
- **Low 2, port contract:**
  - **Port:** options.js opens `chrome.runtime.connect({ name: 'vault' })` once per request and posts one message, which keeps today's message shapes (for example `{ type: 'VAULT_SETUP', passphrase }`). The worker answers with one `port.postMessage(reply)`, which keeps today's reply shapes, and options.js then disconnects. A disconnect before the reply counts as no reply.
  - **What goes on the port:** `VAULT_STATUS`, `VAULT_SETUP`, `VAULT_UNLOCK`, `VAULT_RESET`, `VAULT_GET_DATA`, `VAULT_SAVE_CLAUDE`, `VAULT_SAVE_FRIENDS` and `VAULT_CONVERT_LEGACY`. `VAULT_LOCK` carries nothing and stays on `sendMessage` for settings and the popup.
  - **Gate:** the worker accepts a `vault` port only when `JN.isSettingsSender(port.sender, chrome.runtime.id)`; otherwise it disconnects without a reply.
  - **Fail closed on `onMessage`:** `runtime.onMessage` no longer handles `VAULT_SETUP`, `VAULT_UNLOCK`, `VAULT_CONVERT_LEGACY`, `VAULT_SAVE_CLAUDE`, `VAULT_SAVE_FRIENDS` or `VAULT_GET_DATA`. No reply and no change, even from options.html.
  - **Tests:**
    - `test/vault.test.js` covers the worker side.
    - The new `test/options.test.js` runs options.js through setup, saving the key, adding a friend, lock, unlock and P3 conversion. It asserts that no `sendMessage` carries those types or the passphrase, key or friend, and that each went on the `vault` port.
    - The vault harness now sends the eight types on the port, so the 10 existing vault tests and the background timeout test fail until the port exists.
- **Lows 3, 5, 6, static checks:**
  - **Low 3:** options.html has no "settings … are encrypted".
  - **Low 5:** no "close Chrome" in runtime copy, PRIVACY.md or docs/store-listing.md, and "quit Chrome completely" appears in options.html, PRIVACY.md and the listing. README.md still says "close Chrome" five times and isn't tested.
  - **Low 6:** the listing's Authentication information row names the passphrase, local processing, never stored, and never sent.
- **Pre-check (not run yet):** rows V1, V3, V5, V6, V7 and V8 in `docs/walkthrough-auto/precheck.js` cover security's #1, #3 (Edge only), #5, #6, #7 and #8. #2 and #4 are marked manual.
- **Next owner:** engineer.

**Engineer, fixes for the security review's Lows 1, 2, 3, 5 and 6 (2026-11-26, on 0097ab7):** `npm test` is 154 tests, 154 pass. `npm run check --script-shell=bash` passes and `git diff --check` is clean. Nothing is committed. The crypto, the vault queue, the epoch checks, the reply shapes and the manifest are unchanged, and Low 4 was left alone as accepted.
- **Low 1 (`background.js:569`):** `analyze()` now captures `analysisEpoch` before `inVault()`. The queued step returns `{ ok: false, code: 'LOCKED' }` first if the epoch has changed (`:571`), so a Lock in the same task as `ANALYZE_JOB` makes no fetch. The later epoch checks are as before.
- **Low 2:**
  - **Worker (`background.js:749`):** a `vault` port is accepted only when `JN.isSettingsSender(port.sender, …)` passes; otherwise it disconnects with no reply. Each message on the port must be one of the eight `SETTINGS_MESSAGES` types, or the port disconnects. It runs through the existing `handleSettingsVaultMessage()` and gets one `postMessage(reply)`; a rejected handler disconnects with no reply.
  - **`runtime.onMessage` (`:732`):** the settings-vault branch is removed, so none of the eight types gets a reply or makes a change there. `VAULT_LOCK` (settings or popup) and `POPUP_STATUS` stay on `sendMessage`.
  - **Settings page (`options.js:217`):** `sendWorker` opens `chrome.runtime.connect({ name: 'vault' })` per request, posts the unchanged message, resolves with the first reply, then disconnects. A disconnect before the reply resolves `undefined` and reads `lastError` to keep the console quiet. `VAULT_LOCK` still uses `sendMessage`.
- **Low 3 (`options.html:311`):** the line now says "Your API key and friends list are encrypted with your passphrase in this browser…" and "Your model, match, and auto-detect preferences aren't encrypted."
- **Low 5:** every "close Chrome", "closes Chrome", and "close that tab or Chrome" became "quit Chrome completely" (or "quits Chrome completely").
  - `options.html`: lines 30, 137, 163 and 311.
  - `PRIVACY.md`: lines 23–25, 31 and 67.
  - `docs/store-listing.md`: lines 52, 104 and 138.
  - `README.md`: lines 22, 88, 100, 107 and 144.
- **Low 6 (`docs/store-listing.md:135`):** the row says the key is stored locally, encrypted with the user's passphrase, and sent only to Anthropic, and that the passphrase is processed locally in the browser, never stored, and never sent.
- **For the reviewer:**
  - `DOCS.md` still describes vault messages as plain "settings → worker" messages and doesn't mention the `vault` port. It was outside this brief.
  - The worker doesn't enforce one message per port. options.js disconnects after one reply.
- **For qa's pre-check:** V1 (the lock race) and the settings flows in a real Chrome: setup, unlock, save, P3 conversion and reset over the port. Also confirm that no "Unchecked runtime.lastError" appears when the worker restarts mid-request.
- **Next owner:** reviewer and security.

**Lead, vault-fix review (2026-11-26, at `87e56bd`):** Reviewer and security **FAIL**. Chrome extension runtime ports may have multiple receivers, so the named `vault` port does not enforce worker-only delivery. Security also found that an overlay click could survive a Lock and re-unlock while its prompt lookup was pending. Designer **PASS** for the settings copy and refreshed 1280×800 store capture. Verified the setup and unlocked settings at 375, 800, and 1280 pixels where applicable. The lead corrected the storage retention descriptions in the README and listing. [Chrome port lifetime](https://developer.chrome.com/docs/extensions/develop/concepts/messaging#port-lifetime)

**QA, direct messaging red gate:** `node --test --test-name-pattern 'security Low [12]' --test-reporter=spec test/vault.test.js test/options.test.js` ran before runtime changes. Six expected failures and two passes. The failed checks covered the stale overlay click, missing direct worker handler, remaining broad runtime port, and settings flows that needed the new channel. Next owner: engineer for direct `ServiceWorker.postMessage()` with a private reply port and lock-epoch validation at analysis request receipt.

**Engineer and QA, direct worker checkpoint `786a243`:** Settings now verifies the active manifest service worker and uses a fresh `MessageChannel` reply endpoint for each request. The worker checks the exact top-level settings client and its origin, then handles the event with `waitUntil()`. Analysis captures the vault epoch before overlay lookups and discards any reply from an earlier epoch. QA verified 9/9 focused tests and 157/157 full-suite tests. The exact Bash syntax check and archive checks for 19 and 38 passed.

**Lead, vault-fix follow-up reviews:** Reviewer **PASS** for message routing, lock ordering and documentation. Security **PASS** for the worker-only channel, source checks and stale-request rejection. Designer **PASS** on the final direct-worker harness renders, including confirmation reset, mismatch validation, responsive settings and the 1280×800 store shot. Next owner: QA for installed-browser pre-checks, then the lead for release evidence and manual instructions.

**QA and Security, browser evidence at `786a243`:** Both browsers passed direct worker messaging, guarded vault operations, same-document navigation, overlay double-click, and the Clipboard API. QA traced Chrome's Escape focus and scrim failures to an empty starting focus and a fixed click coordinate. The extra console check caught an injected test observer reading a port after production had disconnected it. Separately, Security inspected the synthetic Chromium session files and confirmed Blink persisted unowned results textareas as form state, including referral drafts. LevelDB contained none of the values checked. P-01/P-03/P-09 remain pending until fresh profiles show the draft opt-out works. Blink's form-state policy uses the owning form's autocomplete setting. [Chromium form-state source](https://chromium.googlesource.com/chromium/src/+/03b56190ff55b876dc1b4a1398930154240a3170/third_party/blink/renderer/core/html/forms/html_form_control_element_with_state.cc#142)

**QA, draft privacy red gate:** `node --test --test-name-pattern 'browser form restore|copying falls back' --test-reporter=spec test/overlay.test.js` ran before changing the shared results view. Both expected failures showed a missing owning form for the editable drafts and the temporary clipboard textarea. The next owner is engineer for the scoped form change, then QA for a full-profile scan and the complete browser rerun.

**Lead, draft-privacy reviews and Chrome/Edge rerun (2026-11-26, at `4f4b728`):** Code-reviewer **PASS**, Security **PASS**, UI-designer **PASS** on `ui.js` (`<form autocomplete="off" novalidate>` wrapping `resultsView` and `copyText` fallback `<textarea>`), `test/overlay.test.js`, and `precheck.js` (`V7` full-profile scan). `npm test` passed **158/158**. Fresh-profile headless reruns on the `4f4b728` ZIP (SHA-256 `2054d95aaa439207900e7a81dcb1ef386b07f8c94faafec42f77f8ce3440f861`) passed every automated step in both browsers: Chrome 158 (`71 PASS, 0 FAIL, 3 NOT AUTOMATED`, `X1`–`X6` `6/6` PASS, `V1`/`V5`/`V6`/`V7`/`V8` `5/5` PASS) and Edge 158 (`71 PASS, 0 FAIL, 3 NOT AUTOMATED`, `X1`–`X6` `6/6` PASS, `V1`/`V3`/`V5`/`V6`/`V7`/`V8` `6/6` PASS), with `V7` clean across LevelDB and all other profile/session-restore files. Updated `docs/walkthrough-auto/RESULTS.md`, `docs/release-walkthrough.md`, `PROGRESS.md`, and `HANDOFF.md`. Next: push `feat/public-release` / verify PR #5 CI, then user's shortened windowed Chrome walkthrough.

**PM, final sign-off (2026-11-27, at HEAD `b7c2823`):** This is a cross-reference. The full table, the evidence and the basis are in `public-release.md`, under "PM final sign-off (2026-11-27)" in its handoff log.
- **Met:** P-01–P-09. P-01, P-04, P-05, P-06 and P-07 moved from pending on qa's `4f4b728` Chrome 158 / Edge 158 pre-check and the user's real-Chrome run on 2026-11-27, where every step passed.
- **Security's vault checks:** V1 and V5–V8 passed in Chrome. V3 passed in Edge. The user covered V2 (no password-manager bubble) and V4 (locked after Chrome fully quit). V4's keep-running branch wasn't exercised.
- **Pending:** P-10, on the screenshot-2 decision. It needs designer sign-off on whichever screenshot 2 ships, or none if it's dropped. It also needs a designer re-check of `8384ea1`'s copy fixes, which isn't in the evidence.
- **Not met:** none.
- **Zip:** the release zip at `8384ea1` is SHA-256 `08034029587a173e723cfa6dd8380e9a3d13009a04b709548598287e7a9d952d`, which replaces `2054d…` above.
- **Stale copy:** the Design copy at lines 134 and 182–183 predates `8384ea1`. options.html is the shipped copy.
- **Next owner:** the user and the designer, then the lead.
