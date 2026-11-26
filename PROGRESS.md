# Progress: public release (v2.0.0)

Specs: [docs/specs/public-release.md](docs/specs/public-release.md) and [docs/specs/passphrase-storage.md](docs/specs/passphrase-storage.md). Branch: `feat/public-release` (stacked on `chore/claude-test-hook`, PR #4).

## Done
- Pre-encryption public release implementation, documentation, packaging, and store assets passed Round 3 reviews (`reviewer`, `designer`, `security`) at checkpoint `5a993bf` with 95/95 tests passing.
- Passphrase encryption (Decision 21 / P1–P3) implemented at `e7cd5da` across `lib/core.js`, `background.js`, `options.*`, `popup.*`, `overlay.js`, `ui.css`, docs, and store listing.
- Final Round 3 reviews passed (`security` PASS in Rounds 1–2, `ui-designer` PASS in Round 2, `code-reviewer` PASS in Round 3).
- Automated verification at `e7cd5da`: `npm test` passed **112/112** (`test/vault.test.js` 17/17 + `test/core.test.js` + `test/background.test.js` + `test/content.test.js` + `test/release.test.js`), syntax check passed (`node --check` 7/7 / `npm run check --script-shell=bash`), and `git diff --check` passed.
- Rebuilt `dist/job-notifier-2.0.0.zip` at `e7cd5da` (SHA-256 `5F682FA66D4BC150A8275DFE16A2AB13E235989A8901A781C6B4AB284E02092C`); runtime allowlist and secret scan verified.
- Updated store assets (`docs/assets/screenshot-1-overlay.png`, `screenshot-3-settings.png`, `screenshot-4-prompt.png`, `promo-440x280.png`) and headless review screenshots (`dist/review-vault-r2/`).
- PM milestone closeout completed for passphrase encryption (`P-01`–`P-10` and `1`–`38` audited, handoff log updated, `HANDOFF.md` updated, and release retro drafted).

## Next
- User runs the clean-profile Chrome walkthrough (load unpacked candidate/`dist/job-notifier-2.0.0.zip`, verify passphrase setup/unlock/lock/reset/P3 flows, live keyboard/focus, `use_dynamic_url` & `sender.url`, permissions, navigation cleanup, copy failure, XSS literal rendering, and zero requests before click).
- User recaptures `docs/assets/screenshot-2-popup.png` as a whole Chrome window (1280x800 RGB PNG with toolbar visible, unlocked `"Job posting found"` + `"Unlocked for this session · Lock now"` footer).
- Open PR for `feat/public-release` and verify remote CI passes.
- Final PM release closeout after real-Chrome evidence and PR/CI pass.

## Blocked
- None for code or packaging. Real-Chrome manual checks, whole-window `screenshot-2-popup.png`, PR/CI verification, and Chrome Web Store submission are pending user steps.
