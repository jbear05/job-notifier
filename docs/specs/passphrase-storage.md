# Passphrase protection for saved data

## Goal

Protect the Anthropic API key and every saved friend field at rest for the Job Notifier 2.0.0 Chrome Web Store release. Users create a passphrase in extension settings and unlock their saved data before using it. Completion requires test evidence for storage, lifecycle, and regressions, plus designer, reviewer, and security approval and clean-profile Chrome evidence.

The Chrome Web Store guidance calls for strong encryption at rest and disclosure of locally handled user data. This spec updates the plaintext storage design in public-release criterion 34 and its related settings copy, privacy policy, technical docs, and listing. [Chrome Web Store user data FAQ](https://developer.chrome.com/docs/webstore/program-policies/user-data-faq)

## Scope

- Save the bring-your-own API key and full friend records in encrypted extension storage. Keep the existing friend validator, model picker, effort, threshold, auto-detect permissions, same-tab/opener posting rules, and click-to-analyze requirement.
- Use Chrome's built-in Web Crypto and extension storage. Keep the direct Anthropic request and bundled runtime. Non-sensitive preferences can stay in `chrome.storage.local`. Recent postings remain in `chrome.storage.session` under the existing retention rules.
- Put passphrase creation and entry in the extension's top-level settings page. Add locked and first-run paths to settings, popup, and overlay, including an unlock return path. Update the release screenshots that show changed UI.
- Preserve the public release decision on 1.x upgrades. Treat existing plaintext in private development profiles as a separate, explicit decision. The Web Store submission remains the user's step.

## Needs the user

| Decision | Choices and impact |
|---|---|
| P1. Unlock duration | Unlocking once per Chrome session with a **Lock now** action is the recommended choice. An idle timeout adds automatic relocking, including when Chrome stays open. Per-use unlocking requires the passphrase again for each analysis. |
| P2. Friends export | Keeping JSON export and labeling the download as readable outside Chrome is the recommended choice. Encrypted export adds a passphrase-protected backup format and restore flow. Legacy JSON import stays supported either way. Friends export never contains the API key. |
| P3. Private development profiles | An explicit conversion of existing pre-encryption 2.0.0 data is the recommended choice. Verify the encrypted copy before clearing the original, so a failed or canceled conversion preserves it. The other choice is to start fresh with an explicit confirmation to clear old data. No automatic 1.x migration. |

Lead collects decisions before implementation of affected work. Security selects and documents the cryptographic envelope and the session method after P1. Designer specifies the new states after P1–P3. QA builds failing tests from the agreed criteria before engineer implementation.

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

## Design handoff

Designer owns the final placements, labels, status and error copy, return-to-settings focus, and responsive states. Use the existing Fraunces and IBM Plex Sans styles and teal palette. Preserve the existing pre-key cost and data-use disclosure. Prepare a fresh setup/settings capture, locked popup and overlay captures, and review evidence for unlocking and returning to analysis. The store capture uses fictional data.

## Security handoff

Security owns the crypto and session boundary decisions, including allowed sender contexts, secret material lifetime, authentication of stored data, and behavior when vault operations and lock race. Threats to cover are disk/profile copies, offline passphrase guesses, stale extension pages, untrusted page or content-script messages, wrong or damaged data, migration interruption, and accidental disclosure in logs, snapshots or exports. Record which threats remain when a user has already unlocked data or an older copy exists.

## Handoff log

| Role | Result and evidence | Next owner |
|---|---|---|
| Lead | User chose passphrase encryption for saved data. Existing release review round 3 passed for code, security, and design. Full suite passed 95/95 before encryption work. | PM |
| PM | Drafted scope and P-01–P-10. Routed P1 unlock duration, P2 export, and P3 private development profile handling as needs-user decisions. No implementation started. | Lead and user |
