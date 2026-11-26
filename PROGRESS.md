# Progress: public release (v2.0.0)

Specs: [docs/specs/public-release.md](docs/specs/public-release.md) and [docs/specs/passphrase-storage.md](docs/specs/passphrase-storage.md). Branch: `feat/public-release` (stacked on `chore/claude-test-hook`, PR #4).

## Done
- Pre-encryption public release implementation, documentation, packaging, and store assets passed Round 3 reviews (`reviewer`, `designer`, `security`) at checkpoint `5a993bf` with 95/95 tests passing.
- Passphrase encryption (Decision 21 / P1–P3) implemented at `e7cd5da` across `lib/core.js`, `background.js`, `options.*`, `popup.*`, `overlay.js`, `ui.css`, docs, and store listing.
- Encryption reviews passed (`security` PASS in Rounds 1–2, `ui-designer` PASS in Round 2, `code-reviewer` PASS in Round 3).
- Updated store assets (`docs/assets/screenshot-1-overlay.png`, `screenshot-3-settings.png`, `screenshot-4-prompt.png`, `promo-440x280.png`) and headless review screenshots (`dist/review-vault-r2/`).
- Real-Chrome release walkthrough written: [docs/release-walkthrough.md](docs/release-walkthrough.md) (`befe0c4`).
- CI on PR #5 caught a CRLF/LF mismatch in the bundled IBM Plex license (criterion 38). Fixed in `fa35c09` (font files stored without line-ending conversion).
- The first browser pre-check found prompt loss on same-document navigation, overlay dismissal on double-click, and a Clipboard API permissions-policy mismatch. Fixed at `0097ab7`; both browsers passed the affected steps in the latest pre-check.
- Vault follow-up checkpoints `786a243` (direct worker transport & stale-click epoch guard) and `4f4b728` (editable drafts & `copyText` fallback wrapped in `<form autocomplete="off">` out of browser session restore) passed code, security, and design reviews.
- Verified at `4f4b728`: `npm test` **158/158** passed and `npm run check --script-shell=bash` passed. Release ZIP rebuilt at `4f4b728` (SHA-256 `2054d95aaa439207900e7a81dcb1ef386b07f8c94faafec42f77f8ce3440f861`).
- Headless pre-check rerun on the `4f4b728` ZIP with fresh profiles: Chrome 158 and Edge 158 both passed **71 PASS, 0 FAIL, 3 NOT AUTOMATED** (`40/40` automated blockers PASS, `6/6` extra checks `X1`–`X6` PASS including `X5` zero errors and `X6` direct worker routing, `5/5` Chrome / `6/6` Edge automated vault checks `V1`–`V8` PASS). `V7` scanned all LevelDB files (22 Chrome, 31 Edge) and all other profile/session-restore files with zero plaintext secrets or drafts (`[]`). Raw evidence is in `dist/precheck-4f4b728-chrome-r2/` and `dist/precheck-4f4b728-edge/` (`docs/walkthrough-auto/RESULTS.md` updated).
- PR #5 is open against `main` (local `feat/public-release` is ahead of `origin/feat/public-release`; push and verify remote CI on the latest head). PR #4 had green CI in the previous check. The [formal PM audit](docs/specs/public-release.md#handoff-log) recorded 20 of 48 criteria met and 28 pending.
- The previous interim retro is in `~/Documents/team-notes/retros.md`.

## Next
1. Push `feat/public-release` to `origin` and verify PR #5 remote CI passes on the updated head.
2. The user runs the shortened [windowed Chrome checks](docs/release-walkthrough.md) on the release ZIP (`2054d95aaa...`): native permission dialog (5.1–5.5), popup auto-detect off on release build (7.4), DevTools Offline (8.4), Notepad paste (10.1), mail app launch (10.5), password-manager bubbles (V2), windows-closed + Quit behavior (4.8 / V4), toolbar icon & overall look (11.5), and whole-window `docs/assets/screenshot-2-popup.png` (13.1–13.3).
3. The lead verifies and commits `docs/assets/screenshot-2-popup.png`, rebuilds/verifies the release ZIP and checks (`npm test`, `npm run check`, PR #5 CI), and PM closes out all acceptance criteria and writes the final retro to `~/Documents/team-notes/retros.md`.
4. Merge PR #4, then PR #5. The user submits to the Chrome Web Store using the checklist in `docs/store-listing.md`.

## Blocked
- Final sign-off awaits the user's shortened windowed Chrome walkthrough & popup capture and remote CI verification on the pushed PR #5 head. Merge and store submission follow sign-off.
