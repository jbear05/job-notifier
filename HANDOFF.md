# Handoff: Job Notifier public release (v2.0.0)

Updated 2026-11-25 by the team lead (Claude). Self-contained: give this file to any model to resume. Contains no secrets.

## Goal and "done"
Make the Job Notifier Chrome extension (Manifest V3) ready for a public Chrome Web Store listing as v2.0.0. Done = every acceptance criterion 1–38 in `docs/specs/public-release.md` is met and verified, reviewer/designer/security reviews PASS, qa's full suite passes, pm has closed out (PROGRESS.md, retro), and the user's real-Chrome checks are done.

## Where things are
- Repo: `C:\Users\jairg\Desktop\Stuff\Prgrm Portfolio\job-notifier` (GitHub jbear05/job-notifier, public).
- Branch `feat/public-release`, stacked on `chore/claude-test-hook` (open PR #4: a Stop hook that runs checks/tests when Claude finishes and blocks up to 3 times on failure).
- Commits so far: f30f29a (logic, security, docs, packaging), 208bda3 (UI + overlay), 396e478 (icon + store images), then the review round 1 fixes checkpoint (see `git log`).
- Spec: `docs/specs/public-release.md`. Read Decisions 1–20 first (they override "[Qn]" notes), then the handoff log at the end (every role's entries, review round 1 findings and the fix plan).
- `PROGRESS.md`: Done / Next / Blocked.

## User decisions (full list in the spec's Decisions)
Public Web Store; bring-your-own Anthropic key, no backend; all-sites access is optional, requested when auto-detect is turned on and removed when it's turned off; auto-detect off by default; click-to-analyze prompt only for postings from the same tab or its opener; friends form with JSON import/export (1 MB / 500 cap); teal #0f766e restyle per the user's design rules, Fraunces + IBM Plex Sans bundled; default model claude-haiku-5-5 (dropdown: haiku/sonnet/opus 5.5), no migration for 1.x; MIT license, LICENSE included in the zip; PRIVACY.md with GitHub Issues as the contact; version 2.0.0; no dark mode; repo stays public, history left as is; store summary "Finds friends who'd fit a job posting and drafts a message to each. Uses your own Anthropic API key."; criterion 38 means no real API key (`sk-ant-` + 20 chars) in the zip.

## Verification (Windows)
- `npm test`: 87 tests, last run 87 pass, 0 fail.
- `npm run check --script-shell=bash`: syntax check, passes.
- `npm run package --script-shell=bash`: builds `dist/job-notifier-2.0.0.zip` from HEAD (commit first).
- `node docs/assets/harness/render.js <review-dir>`: re-renders the store images and review screenshots with headless Chrome.

## Status of review round 1
- reviewer FAIL, designer FAIL, security PASS (three Lows). Findings and plan are in the handoff log.
- Fixed: engineer A (storage race, isExtensionPage accepts a dynamic chrome-extension: URL with a matching sender.id, overlay fail-safe + Escape, prompt cleared on full navigation, stripDelimiters backtracking, hostname-only storage, fetch timeout); engineer B (retention wording, hostname wording, "Before you submit" checklist in docs/store-listing.md); engineer C (settings column cap, single "Add friend", retention copy, key-phishing help line, success flashes, list gap, bulk label, popup threshold).
- Engineer A's final report hadn't arrived when this was written. Check its handoff-log entry.

## Next actions, in order
1. Confirm engineer A's handoff-log entry; run `npm test` and the check; commit anything uncommitted.
2. Engineer D: generate `docs/assets/screenshot-4-prompt.png` (one line in render.js) and re-render the store images and review screenshots (settings copy changed).
3. Review round 2, in parallel: reviewer (code, `git diff 396e478..HEAD` plus the round 1 findings), designer (new screenshots), security (re-review the isExtensionPage change and the overlay fail-safe). Any FAIL goes back to an engineer; stop after 3 failed rounds and ask the user.
4. qa full run; pm close-out: check every criterion, update PROGRESS.md, append a retro entry to `C:\Users\jairg\.claude\team\retros.md`. Include in the retro: review rounds, FAILs by role, routed questions, escalations, user corrections, and that the Stop hook blocked the lead 3 times in each intentional red-test phase.
5. The user, in real Chrome: load the zip unpacked in a clean profile, run security's real-Chrome checklist (in the round 1 log: frame loading under use_dynamic_url, sender.url, no click-blocking layer, criteria 4/6/8/10/12/29/30/31/33/36/37, whether Chrome reports `status: 'loading'` for pushState/hash changes), and recapture `docs/assets/screenshot-2-popup.png` as a whole-window shot.
6. Open a PR for `feat/public-release` once PR #4 is merged (or base it on #4).

## Open questions for the user
- Change the global CLAUDE.md handoff rule to "write the handoff only when usage is actually running low"?
- The global CLAUDE.md now points team files at `~/.gemini/team/`, while the team uses `C:\Users\jairg\.claude\team\`. Intended?

## Resume prompt
"You're the team lead for the Job Notifier public release. Read HANDOFF.md, PROGRESS.md and docs/specs/public-release.md (Decisions, criteria, Design, Security, handoff log) in C:\Users\jairg\Desktop\Stuff\Prgrm Portfolio\job-notifier. Continue from 'Next actions'. Follow the team workflow in the user's global CLAUDE.md. Run `npm test` and `npm run check --script-shell=bash` before calling anything done, and don't commit or push anything the user hasn't asked for beyond the multi-session checkpoint rule."
