# job-notifier

Chrome extension that drafts job referral messages for friends. Shared logic lives in `lib/core.js`; tests use Node's built-in runner (`node:test`).

## Checks
- Tests: `npm test`
- Syntax check: `npm run check` (a bash loop; on Windows run `npm run check --script-shell=bash`)
- CI (`.github/workflows/test.yml`) runs both, plus a check that every file `manifest.json` references exists.
- A Stop hook (`.claude/hooks/check-before-stop.sh`) runs the syntax check and tests whenever Claude finishes, and sends it back if they fail (up to 3 times, then stops for the user).
