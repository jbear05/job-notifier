# Handoff: Job Notifier public release (v2.0.0)

Updated 2026-11-26 by PM/lead after passphrase-encryption milestone `e7cd5da` (docs/handoff committed at `9562d31`). Contains no secrets.

## Goal and "done"
Make the Job Notifier Chrome extension (Manifest V3) ready for a public Chrome Web Store listing as v2.0.0 with passphrase-encrypted storage (`P-01`–`P-10` in `docs/specs/passphrase-storage.md` and `1`–`38` in `docs/specs/public-release.md`). Done = every automated and manual acceptance criterion is verified, all reviews PASS, QA's full suite and final ZIP checks pass, the user's real-Chrome walkthrough + whole-window `screenshot-2-popup.png` + `feat/public-release` PR/remote CI pass, and PM completes final release closeout.

## Where things are
- Repo: `C:\Users\jairg\Desktop\Stuff\Prgrm Portfolio\job-notifier` (GitHub `jbear05/job-notifier`, public).
- Branch `feat/public-release`, stacked on `chore/claude-test-hook` (PR #4 open, CI green). Release PR [#5](https://github.com/jbear05/job-notifier/pull/5) is open against `main` with Auto-fix on; its first CI run failed on criterion 38 (font license line endings), fixed in `fa35c09`.
- Checkpoints:
  - Pre-encryption release phase: `f30f29a` (logic, security, docs, packaging), `208bda3` (UI and overlay), `396e478` (icon and store images), `7214fd5` (round 1 fixes), `4fbfdb7` (refreshed images and round 2 reviews), `5a993bf` (reviewed navigation and overlay fixes, 95/95 tests).
  - Passphrase encryption phase: `e7cd5da` (PBKDF2-SHA256 600k + AES-256-GCM vault, P1–P3 lifecycle, UI states, updated docs/listing/assets, Round 3 fixes, 112/112 tests, rebuilt release ZIP), `9562d31` (PM milestone closeout in `PROGRESS.md`, `HANDOFF.md`, and `docs/specs/passphrase-storage.md`).
- Specs: `docs/specs/public-release.md` (Decisions 1–21) and `docs/specs/passphrase-storage.md` (Decisions P1–P3, `## Design`, `## Security`, and `## Handoff log`).
- `PROGRESS.md`: Done / Next / Blocked.

## User decisions (full list in both specs' Decisions)
- **Public release (1–21):** Public Web Store; bring-your-own Anthropic key, no backend; all-sites access optional (requested when auto-detect is turned on, removed when turned off); auto-detect off by default; click-to-analyze prompt only for postings from the same tab or its opener; friends form with JSON import/export (1 MB / 500 cap); teal `#0f766e` restyle per global design rules, Fraunces + IBM Plex Sans bundled; default model `claude-haiku-5-5` (dropdown: haiku/sonnet/opus 5.5), no 1.x migration; MIT license, `LICENSE` included in the zip; `PRIVACY.md` with GitHub Issues as contact; version `2.0.0`; no dark mode; repo stays public with previously approved exception for owner's email in history; store summary `"Finds friends who'd fit a job posting and drafts a message to each. Uses your own Anthropic API key."`; criterion 38 means no real API key (`sk-ant-` + 20+ chars) in the zip; Decision 21 replaces plaintext local storage with passphrase encryption.
- **Passphrase storage (P1–P3):**
  - **P1:** Unlock once per Chrome session (`chrome.storage.session` `vaultKey`) with a **Lock now** action in settings and popup.
  - **P2:** Keep readable JSON friends export (`job-notifier-friends.json`, excludes API key/passphrase/settings), labeled as unencrypted and readable outside Chrome.
  - **P3:** Explicit conversion of existing pre-encryption 2.0.0 data (verify encrypted copy can be read and authenticated before clearing legacy `settings.apiKey` and `friends`; no automatic 1.x migration).

## Verification (Windows, at `e7cd5da`)
- `npm test`: **112 passed, 0 failed** (`test/vault.test.js` 17/17 + `test/core.test.js` + `test/background.test.js` + `test/content.test.js` + `test/release.test.js`).
- `node --check` 7/7 / `npm run check --script-shell=bash`: passed (with `C:\Program Files\Git\bin` at the front of `PATH` outside the sandbox; sandbox blocks Git Bash startup `0xC0000022`).
- `git diff --check`: passed. (`git commit` ran outside the sandbox because `.git/index.lock` fails with `Permission denied` inside the sandbox.)
- `npm run package --script-shell=bash`: rebuilt `dist/job-notifier-2.0.0.zip` at `e7cd5da`.
  - ZIP SHA-256: `5F682FA66D4BC150A8275DFE16A2AB13E235989A8901A781C6B4AB284E02092C`
  - Verified runtime allowlist only (plus `LICENSE`) and zero secrets (`sk-ant-` + 20+ chars) via `test/release.test.js` and archive inspection.
- `node docs/assets/harness/render.js <review-dir>`: ran outside sandbox (sandbox blocks headless Chrome Crashpad). Store assets updated in `docs/assets/`; Round 2 review captures in `dist/review-vault-r2/`.

## Review status
- **Pre-encryption release phase (prior sessions):**
  - Round 1: `reviewer` FAIL, `designer` FAIL, `security` PASS (with 3 lows).
  - Round 2: `designer` PASS, `reviewer` FAIL, `security` FAIL.
  - Round 3: `reviewer` PASS, `designer` PASS, `security` PASS (95/95 tests).
- **Passphrase encryption phase (`e7cd5da`):**
  - Note: Built-in `designer` and `reviewer` subagents failed with a `read_file` tool-name conflict, so scoped `ui-designer` and `code-reviewer` subagents ran those roles.
  - Red gates: `0/15` on initial `test/vault.test.js` red gate (95/110 total); `15/17` on Round 1 regression red gate.
  - Round 1: `security` PASS; `ui-designer` FAIL (2 findings: `ui.css` `[aria-invalid="true"]` specificity, `screenshot-3-settings.png` clipping `#api-key`/`#model`); `code-reviewer` FAIL (2 blocking bugs in `background.js`: `handleVaultConvertLegacy` `wroteVault` cleanup race, `handleVaultSave*` post-`local.set` `vaultEpoch` check; plus non-blocking `options.js` `VAULT_CHANGED` suppression, `running.delete` identity guard, and save deduplication).
  - Round 2: `security` PASS; `ui-designer` PASS; `code-reviewer` FAIL (1 blocking finding: `options.js:762` dropping suppression on `confirmReset`'s own `VAULT_CHANGED (uninitialized)` broadcast).
  - Round 3: `code-reviewer` PASS.

## Next actions, in order
1. **User clean-profile Chrome walkthrough:** follow [docs/release-walkthrough.md](docs/release-walkthrough.md) (74 steps, 40 release blockers, local test pages in `docs/walkthrough-pages/`). It covers:
   - Passphrase setup, wrong passphrase, lock (`Lock now`) from settings & popup, browser restart staying locked, P3 conversion & cancel/reset confirmation flows, and multi-tab settings sync.
   - Live keyboard/focus flow across settings, popup, and overlay (Escape, Tab wrap, focus return, visible focus rings, `aria-invalid` borders).
   - Dynamic `overlay.html` iframe loading (`use_dynamic_url`) and `sender.url` check, `chrome.permissions` grant/revoke + `getRegisteredContentScripts()`, `pushState`/hash navigation vs full navigation cleanup, copy failure UI, XSS literal rendering, and Network panel showing zero requests to `api.anthropic.com` or font CDNs before **Find friends**.
2. **Whole-window popup screenshot:** Recapture `docs/assets/screenshot-2-popup.png` manually in real Chrome (1280x800 RGB PNG, whole browser window with toolbar visible, unlocked popup in `"Job posting found"` showing `"Unlocked for this session · Lock now"` footer) and commit/re-run `npm test` + `npm run package` if committed assets change.
3. **Release PR & remote CI:** PR #5 is open against `main` (it carries PR #4's commit until #4 merges). Confirm CI passes after `fa35c09`; Auto-fix reports failures to the lead session.
4. **Final PM closeout & store submission:** PM's earlier retro draft was never saved; pm writes the release retro to `C:\Users\jairg\Documents\team-notes\retros.md` (the shared team folder, also an Obsidian vault) and completes final v2.0.0 release closeout after real-Chrome evidence and CI pass. User handles Chrome Web Store developer submission.

## Open questions for the user
- Change the global CLAUDE.md handoff rule to "write the handoff only when usage is actually running low"?
- Resolved 2026-11-26: team files (retros, scorecard, proposals, changelog) live in `C:\Users\jairg\Documents\team-notes\`, used by Claude, Gemini and Codex through the shared global instruction file. The old copies in `C:\Users\jairg\.claude\team\` are stale and can be deleted by the user.

## Resume prompt
"Lead the Job Notifier v2.0.0 release from the next unchecked action. Read HANDOFF.md, PROGRESS.md, and the Handoff logs in docs/specs/public-release.md and docs/specs/passphrase-storage.md. Collect the user's clean-profile Chrome walkthrough evidence and whole-window screenshot-2-popup.png, open the feat/public-release PR and verify remote CI, then run final PM closeout."
