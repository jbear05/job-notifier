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
- Headless pre-check rerun on the `4f4b728` ZIP with fresh profiles:
  - Chrome 158 and Edge 158 each got **71 PASS, 0 FAIL, 3 NOT AUTOMATED**.
  - All 40 automated blockers passed, and so did the 6 extra checks `X1`–`X6`, including `X5` (zero errors) and `X6` (direct worker routing).
  - Security's automated vault checks passed: `V1` and `V5`–`V8` in Chrome, and `V1`, `V3` and `V5`–`V8` in Edge.
  - `V7` scanned every LevelDB file (22 in Chrome, 31 in Edge) and every other profile and session-restore file, and found zero plaintext secrets or drafts.
  - Results are in `docs/walkthrough-auto/RESULTS.md`. The raw `dist/precheck-4f4b728-*` folders are no longer on disk.
- `8384ea1` applied the designer's three copy-accuracy fixes (options.html and `docs/store-listing.md`, copy only). At HEAD `b7c2823`, `npm test` passes **158/158** and `npm run check --script-shell=bash` passes. CI is green on PR #5 and PR #4.
- Release ZIP rebuilt at `8384ea1`: 27 entries, no key-shaped strings, SHA-256 `08034029587a173e723cfa6dd8380e9a3d13009a04b709548598287e7a9d952d`. It replaces every earlier hash.
- **Real-Chrome walkthrough passed (2026-11-27).** The user ran the shortened manual list in a clean, windowed Chrome profile, and every step passed. The evidence is the user's pass summary plus a screenshot of Chrome's 5.1 permission dialog. The headless pre-check covers the rest. Step 13 (screenshot 2) wasn't run.
- **[PM final sign-off](docs/specs/public-release.md#handoff-log) (2026-11-27):**
  - **46 of 48 met.**
  - **2 pending:** criterion 21 and P-10, both waiting on the screenshot-2 decision. P-10 also needs a designer re-check of `8384ea1`.
  - **0 not met.**
- Retro: the interim entry plus a final addendum are in `~/Documents/team-notes/retros.md`.

- 2026-11-27: designer confirmed `8384ea1`'s copy fixes and the spec Design copy now matches the shipped UI (`40d5bfb`); `precheck.js` 12.2 updated (`a0ca4ee`).
- 2026-11-27: store screenshot 2 recaptured by the user in the clean test profile on the store demo page (`kestrel-grid.localhost:8080/`), whole window, no taskbar or personal UI; scaled without distortion to 1280x800 RGB with the page's own white extending the bottom (no scrollbar, white bottom rows, edge columns checked). designer: PASS (candidate A, "Job posting found"). Criterion 21 and P-10 are now met: **48 of 48 criteria met.**

## Next
1. **Merge PR #4, then PR #5 (the user).** PRIVACY.md and the settings page link to `https://github.com/jbear05/job-notifier/blob/main/PRIVACY.md`, which only resolves after PR #5 merges, so merge before submitting.
2. **Build the store zip from `main`** after the merge: `npm run package --script-shell=bash`.
3. **Store submission (the user),** using the "Before you submit" checklist in `docs/store-listing.md` (developer account, data-use checkboxes, Productivity subcategory).

## Blocked
- Nothing. The remaining steps are the user's: merge, then submit.
