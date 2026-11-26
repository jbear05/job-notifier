# Progress: public release (v2.0.0)

Specs: [docs/specs/public-release.md](docs/specs/public-release.md) and [docs/specs/passphrase-storage.md](docs/specs/passphrase-storage.md). Branch: `feat/public-release` (stacked on `chore/claude-test-hook`, PR #4).

## Done
- Pre-encryption public release implementation, documentation, packaging, and store assets passed Round 3 reviews (`reviewer`, `designer`, `security`) at checkpoint `5a993bf` with 95/95 tests passing.
- Passphrase encryption (Decision 21 / P1–P3) implemented at `e7cd5da` across `lib/core.js`, `background.js`, `options.*`, `popup.*`, `overlay.js`, `ui.css`, docs, and store listing.
- Encryption reviews passed (`security` PASS in Rounds 1–2, `ui-designer` PASS in Round 2, `code-reviewer` PASS in Round 3).
- Updated store assets (`docs/assets/screenshot-1-overlay.png`, `screenshot-3-settings.png`, `screenshot-4-prompt.png`, `promo-440x280.png`) and headless review screenshots (`dist/review-vault-r2/`).
- Real-Chrome release walkthrough written: [docs/release-walkthrough.md](docs/release-walkthrough.md) (`befe0c4`).
- CI on PR #5 caught a CRLF/LF mismatch in the bundled IBM Plex license (criterion 38). Fixed in `fa35c09` (font files stored without line-ending conversion).
- Verification at HEAD `b33a65c`:
  - `npm test` 112/112.
  - `npm run check --script-shell=bash` passes.
  - Release zip rebuilt at HEAD: 27 entries (runtime files plus LICENSE), no key-shaped strings, and the IBM Plex license matches its logged SHA-256. SHA-256 `a972905259c46777057c7d70591759f1fa6126302fc71b7232c0b774d8837f44` (replaces the `e7cd5da` zip, `5F68…`).
- PR #5 (release, against `main`): CI 2/2 green and mergeable. PR #4 (Stop hook): CI green.
- PM pre-sign-off audit (2026-11-26): 20 of 48 criteria met, 28 pending manual Chrome evidence, 0 not met. The audit is in the handoff log of [docs/specs/public-release.md](docs/specs/public-release.md).
- Interim retro written to the shared team-notes `retros.md`. The earlier milestone closeout said a retro was drafted, but that draft was never saved.

## Next
1. The user runs the clean-profile Chrome walkthrough in [docs/release-walkthrough.md](docs/release-walkthrough.md), including section 13 (recapture `docs/assets/screenshot-2-popup.png` as the whole window), and reports back as its "Report back" section describes. qa's headless Edge pre-check (`docs/walkthrough-auto/RESULTS.md`) lands first as an early signal.
2. The lead commits the new screenshot and re-runs `npm test`. PM does the final sign-off: marks each of the 28 pending criteria met or not met, and appends the retro addendum.
3. Merge PR #4, then PR #5.
4. The user submits to the Chrome Web Store, following the "Before you submit" checklist in `docs/store-listing.md`.

## Blocked
- Nothing in code, tests, or packaging.
- Final sign-off is waiting on the user's walkthrough evidence for 28 criteria. The merges wait on sign-off, and the store submission waits on the merges.
