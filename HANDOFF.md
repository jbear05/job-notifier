# Handoff: Job Notifier public release (v2.0.0)

Updated 2026-11-25 by the team lead. Contains no secrets.

## Goal and "done"
Make the Job Notifier Chrome extension (Manifest V3) ready for a public Chrome Web Store listing as v2.0.0. Done = every acceptance criterion 1–38 in `docs/specs/public-release.md` is met and verified, reviewer/designer/security reviews PASS, qa's full suite passes, pm has closed out (PROGRESS.md, retro), and the user's real-Chrome checks are done.

## Where things are
- Repo: `C:\Users\jairg\Desktop\Stuff\Prgrm Portfolio\job-notifier` (GitHub jbear05/job-notifier, public).
- Branch `feat/public-release`, stacked on `chore/claude-test-hook` (open [PR #4](https://github.com/jbear05/job-notifier/pull/4)). The remote had no release PR at the last check.
- Checkpoints: `f30f29a` (logic, security, docs, packaging), `208bda3` (UI and overlay), `396e478` (icon and store images), `7214fd5` (round 1 fixes), `4fbfdb7` (refreshed images and round 2 reviews), `5a993bf` (reviewed navigation and overlay fixes).
- Spec: `docs/specs/public-release.md`. Read Decisions 1–20 first (they override "[Qn]" notes), then the handoff log at the end (every role's entries, review round 1 findings and the fix plan).
- `PROGRESS.md`: Done / Next / Blocked.

## User decisions (full list in the spec's Decisions)
Public Web Store; bring-your-own Anthropic key, no backend; all-sites access is optional, requested when auto-detect is turned on and removed when it's turned off; auto-detect off by default; click-to-analyze prompt only for postings from the same tab or its opener; friends form with JSON import/export (1 MB / 500 cap); teal #0f766e restyle per the user's design rules, Fraunces + IBM Plex Sans bundled; default model claude-haiku-5-5 (dropdown: haiku/sonnet/opus 5.5), no migration for 1.x; MIT license, LICENSE included in the zip; PRIVACY.md with GitHub Issues as the contact; version 2.0.0; no dark mode; repo stays public, history left as is; store summary "Finds friends who'd fit a job posting and drafts a message to each. Uses your own Anthropic API key."; criterion 38 means no real API key (`sk-ant-` + 20 chars) in the zip.

## Verification (Windows)
- `npm test` at `5a993bf`: 95 passed, 0 failed. Focused command: `node --test --test-reporter=spec test/background.test.js test/content.test.js` passed 12/12.
- `npm run check --script-shell=bash` passed with `C:\Program Files\Git\bin` at the front of PATH in an approved execution. The sandbox blocks both the WindowsApps Bash shim and Git Bash startup.
- `npm run package --script-shell=bash` built `dist/job-notifier-2.0.0.zip` at `5a993bf`. `tar -tf dist/job-notifier-2.0.0.zip` showed only the approved runtime allowlist. `node --test --test-reporter=spec --test-name-pattern 'criterion 19|criterion 38' test/release.test.js` passed 3/3. ZIP SHA-256 `af8e7bd9f6f5942270963021c819160f0c03205359a4fd5b6cf1a2173db5db8d`. This checkpoint is for testing. Rebuild from the encryption commit before the release.
- `node docs/assets/harness/render.js <review-dir>`: re-renders the store images and review screenshots with headless Chrome.

## Review status
- Round 1: reviewer FAIL, designer FAIL, security PASS with three lows. `7214fd5` contains the associated fixes.
- Round 2: designer PASS for the rendered UI and generated assets. Reviewer and security FAIL for stale prompts around navigation, premature iframe readiness, and cleanup when auto-detect stops. Reviewer also flagged the worker timeout and the stored scheme/port. See the spec handoff log for findings and evidence.
- Round 2 red gate: with `test/background.test.js` and `test/content.test.js`, `node --test --test-reporter=spec test/background.test.js test/content.test.js` had 4 passes and 8 expected failures. Full suite had 87 passes and those same 8 failures. The fixes are in `5a993bf`.
- Round 3: reviewer, designer, and security all passed the round 2 fixes. Focused regressions passed 12/12, full suite passed 95/95, and the exact Bash syntax check passed. Twenty-one of 22 headless captures matched the prior approved set. The loading spinner was at a different animation frame.

## Next actions, in order
1. Specify and implement the user's passphrase encryption decision, then complete its focused tests, full QA run, and code, design and security reviews. See Decision 21 in the release spec. The earlier navigation and overlay fixes passed round 3.
2. QA runs the full suite. Build and inspect the archive from the committed candidate. PM checks every criterion, updates `PROGRESS.md`, and writes a retro to `C:\Users\jairg\.claude\team\retros.md`. Record review rounds, FAILs by role, routed questions, escalations, user corrections, and the earlier Stop hook's three blocks in each intentional red-test phase.
3. The user loads the unpacked candidate in a clean Chrome profile and runs the real-Chrome checks in the spec handoff log. Include dynamic iframe loading and `sender.url`, focus and timeout cleanup, `pushState`/hash navigation versus full navigation, permissions and no requests before a click. Recapture `docs/assets/screenshot-2-popup.png` as a whole-window shot.
4. Open a PR for `feat/public-release` after the Chrome evidence. If PR #4 is still open, base the release PR on its head branch. Otherwise target the merged base. Check release CI on the resulting PR.

## Storage decision
- The user chose passphrase-encrypted saved data in response to the [Chrome Web Store User Data FAQ](https://developer.chrome.com/docs/webstore/program-policies/user-data-faq). The approved round 2 runtime changes still use the earlier storage design. The next implementation must encrypt saved API keys and friend records and replace the unencrypted disclosure before the release.
- PM drafted `docs/specs/passphrase-storage.md`. Await answers to P1 (unlock lifetime), P2 (readable JSON vs encrypted export), and P3 (convert existing private prerelease data vs explicit reset). The lead asked all three in chat. Build begins after those answers and the security/design handoffs.

## Open questions for the user
- Change the global CLAUDE.md handoff rule to "write the handoff only when usage is actually running low"?
- The global CLAUDE.md now points team files at `~/.gemini/team/`, while the team uses `C:\Users\jairg\.claude\team\`. Intended?

## Resume prompt
"Lead the Job Notifier v2.0.0 release from the next unchecked action. Read HANDOFF.md, PROGRESS.md, and the Decisions and handoff log in docs/specs/public-release.md. Follow the user's team workflow, verify each remaining gate, and checkpoint the verified work."
