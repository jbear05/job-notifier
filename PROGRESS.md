# Progress: public release (v2.0.0)

Spec: [docs/specs/public-release.md](docs/specs/public-release.md). Branch: `feat/public-release` (stacked on `chore/claude-test-hook`, PR #4).

## Done
- Public release implementation, documentation, package, and store assets are in place through the reviewed runtime checkpoint `5a993bf`. The settings image is current and the store has a fourth image for the confirmation prompt.
- Reviewer, designer, and security passed round 3 for the navigation, overlay, and storage-scope fixes. Full suite passed 95/95, exact Bash syntax check passed, and the checkpoint ZIP contained only runtime files with no production-shaped key. The headless visual review covered 22 screenshots.
- The user chose passphrase encryption for API keys and friend records as part of v2.0.0. See Decision 21 and the [draft passphrase storage spec](docs/specs/passphrase-storage.md).

## Next
- Record the remaining passphrase decisions, specify design and security details, then run the test-first implementation and review cycle. Update store copy and screenshots to match.
- Build and verify the final ZIP, run the user's clean-profile Chrome walkthrough, and replace the popup store screenshot with a whole-window capture. Open the release PR and verify remote CI after those checks. PR #4 was still open when checked.
- PM closeout and retro after verification. Record the previously approved exception for the owner's email in public history and the intentional red runs reported in the handoff.

## Blocked
- Passphrase implementation awaits decisions on unlock duration, friends export format, and existing private prerelease data. The local ZIP built from `5a993bf` still uses the earlier storage design. It is a checkpoint build for testing and needs rebuilding after encryption.
