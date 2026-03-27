#!/bin/bash
# Claude Code hook: Block git commit unless make check-all is chained before it,
# and validate the commit message follows Conventional Commits format.
#
# This enforces CLAUDE.md's #1 rule: all checks must pass before completing any task.
# "make check-all" includes lint, test, security, naming, and SonarCloud.
# Instead of trusting the AI to remember, we mechanically block commits without it.
#
# Requires: jq (brew install jq)

set -euo pipefail

INPUT=$(cat)
COMMAND=$(echo "$INPUT" | jq -r '.tool_input.command // empty')

# Only intercept git commit commands
if ! echo "$COMMAND" | grep -qE '\bgit\s+commit\b'; then
    exit 0
fi

# Require bot identity (GIT_AUTHOR_EMAIL must be set in the command chain)
BOT_EMAIL="2881343+signalfield-claude[bot]@users.noreply.github.com"
if ! echo "$COMMAND" | grep -qF "$BOT_EMAIL"; then
    echo "Commits must use the SignalField Claude bot identity." >&2
    echo "Export these before committing:" >&2
    echo '  export GIT_AUTHOR_NAME="signalfield-claude[bot]"' >&2
    echo "  export GIT_AUTHOR_EMAIL=\"$BOT_EMAIL\"" >&2
    echo '  export GIT_COMMITTER_NAME="signalfield-claude[bot]"' >&2
    echo "  export GIT_COMMITTER_EMAIL=\"$BOT_EMAIL\"" >&2
    exit 2
fi

# Allow if make check-all is chained before git commit
if ! echo "$COMMAND" | grep -qE 'make\s+check-all.*&&.*git\s+commit'; then
    echo "CLAUDE.md requires 'make check-all' before every commit." >&2
    echo "Chain it: make check-all && git commit ..." >&2
    exit 2
fi

# Validate commit message follows Conventional Commits format
# Extract the message from -m "..." or -m '...' (macOS-compatible, no grep -P)
COMMIT_MSG=$(echo "$COMMAND" | sed -nE 's/.*-m[[:space:]]+"([^"]+)".*/\1/p' || true)
if [ -z "$COMMIT_MSG" ]; then
    COMMIT_MSG=$(echo "$COMMAND" | sed -nE "s/.*-m[[:space:]]+'([^']+)'.*/\1/p" || true)
fi

if [ -n "$COMMIT_MSG" ]; then
    PATTERN='^(feat|fix|docs|style|refactor|perf|test|build|ci|chore|revert)(\([a-z0-9-]+\))?!?: .+'
    if ! echo "$COMMIT_MSG" | grep -qE "$PATTERN"; then
        echo "Commit message does not follow Conventional Commits format." >&2
        echo "Required: type(scope): description" >&2
        echo "Types: feat|fix|docs|style|refactor|perf|test|build|ci|chore|revert" >&2
        echo "Example: feat(auth): add user login endpoint" >&2
        exit 2
    fi
fi

exit 0
