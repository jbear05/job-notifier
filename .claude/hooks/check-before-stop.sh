#!/usr/bin/env bash
# Stop hook: run the checks CI runs (syntax check + tests) when Claude finishes.
# On failure, exit 2 sends Claude back to fix them. Gives up after 3 blocked
# attempts in a row so a stuck loop comes back to the user instead of spinning.
cd "$CLAUDE_PROJECT_DIR" || exit 0
input=$(cat)
count_file="$(git rev-parse --git-dir)/claude-stop-hook-failures"

# A fresh stop (not one this hook caused) starts the count over.
echo "$input" | grep -Eq '"stop_hook_active"[[:space:]]*:[[:space:]]*true' || rm -f "$count_file"

# npm runs scripts with cmd.exe on Windows; the check script is a bash loop.
if out=$( { npm run --silent check --script-shell=bash && npm test --silent; } 2>&1 ); then
  rm -f "$count_file"
  exit 0
fi

n=$(( $(cat "$count_file" 2>/dev/null || echo 0) + 1 ))
if [ "$n" -gt 3 ]; then
  rm -f "$count_file"
  echo '{"systemMessage":"Checks or tests still fail after 3 attempts. Stopping so you can decide."}'
  exit 0
fi
echo "$n" > "$count_file"
echo "Checks or tests failed (attempt $n of 3). Fix the code before finishing; never delete, skip, or loosen a test." >&2
echo "$out" | tail -40 >&2
exit 2
