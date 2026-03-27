#!/bin/bash
# Claude Code hook: After a git push, remind Claude to check CodeRabbit feedback.
#
# This enforces the CLAUDE.md rule: "After pushing a PR, check CodeRabbit's
# review comments and fix every issue before marking the PR as ready."

set -euo pipefail

INPUT=$(cat)
COMMAND=$(echo "$INPUT" | jq -r '.tool_input.command // empty')

# Only trigger on git push commands
if ! echo "$COMMAND" | grep -qE '\bgit\s+push\b'; then
    exit 0
fi

# Output a reminder as a system message
cat <<'EOF'
{"decision": "block", "reason": "Push completed. CLAUDE.md requires you to check CodeRabbit review comments. Run: gh pr view --comments | head -100"}
EOF
