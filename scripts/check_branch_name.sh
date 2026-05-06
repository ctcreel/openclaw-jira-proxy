#!/usr/bin/env bash

set -euo pipefail

# GitHub Actions: on pull_request events HEAD is the merge commit (detached),
# so prefer GITHUB_HEAD_REF; on push events use GITHUB_REF. Locally (husky
# pre-push), fall back to the current branch.
if [ -n "${GITHUB_HEAD_REF:-}" ]; then
    BRANCH_NAME="$GITHUB_HEAD_REF"
elif [ -n "${GITHUB_REF:-}" ] && [[ "$GITHUB_REF" == refs/heads/* ]]; then
    BRANCH_NAME="${GITHUB_REF#refs/heads/}"
else
    BRANCH_NAME=$(git symbolic-ref --short HEAD 2>/dev/null || git rev-parse --short HEAD)
fi

# Long-lived branches
LONG_LIVED_BRANCHES="^(main|development|testing|demo|production)$"

# Feature branches: <type>/[<TICKET-ID>-]<description>
#
# Type vocabulary mirrors conventional-commits (the same set our pre-commit
# hook enforces on commit messages), with the legacy aliases retained:
#   feat / feature  — new functionality
#   fix / bugfix    — defect fix
#   hotfix          — production-bound urgent fix
#   docs            — documentation only
#   style           — formatting / whitespace
#   refactor        — code change that doesn't add or fix
#   perf            — performance improvement
#   test            — tests only
#   build           — build-system / dependency
#   ci              — CI configuration
#   chore           — anything else (deploy scripts, repo hygiene)
#   revert          — revert a prior commit
#
# The TICKET-ID segment is OPTIONAL. Tickets are still encouraged for any
# planned work that's tracked in Jira, but small fixes (typo, dependency
# bump, lint cleanup) can omit it. The description segment is the same
# 3-50 lowercase-and-hyphens form either way.
FEATURE_BRANCHES='^(feat|feature|fix|bugfix|hotfix|docs|style|refactor|perf|test|build|ci|chore|revert)/([A-Z]{2,}-[0-9]+-)?[a-z0-9][a-z0-9-]{2,49}$'

if [[ "$BRANCH_NAME" =~ $LONG_LIVED_BRANCHES ]]; then
    exit 0
fi

if [[ "$BRANCH_NAME" =~ $FEATURE_BRANCHES ]]; then
    # Check for consecutive hyphens or trailing hyphen in description.
    # Strip the type prefix and (optional) ticket-id segment first.
    DESCRIPTION="${BRANCH_NAME#*/}"
    if [[ "$DESCRIPTION" =~ ^[A-Z]{2,}-[0-9]+- ]]; then
        DESCRIPTION="${DESCRIPTION#*-*-}"
    fi
    if [[ "$DESCRIPTION" =~ -- ]] || [[ "$DESCRIPTION" =~ -$ ]]; then
        echo "ERROR: Branch description cannot contain consecutive hyphens or end with a hyphen"
        echo "Branch: $BRANCH_NAME"
        exit 1
    fi
    exit 0
fi

echo "ERROR: Branch name does not follow Sc0red conventions"
echo ""
echo "Branch: $BRANCH_NAME"
echo ""
echo "Valid formats:"
echo "  Long-lived: main, development, testing, demo, production"
echo "  With ticket:    <type>/<TICKET-ID>-<description>   e.g. fix/SPE-2010-csv-bot-blocked"
echo "  Without ticket: <type>/<description>               e.g. chore/relax-branch-name-rule"
echo ""
echo "Types: feat|feature|fix|bugfix|hotfix|docs|style|refactor|perf|test|build|ci|chore|revert"
echo "Ticket ID (optional): 2+ uppercase letters, dash, 1+ digits (e.g., SPE-123)"
echo "Description: 3-50 chars, lowercase + numbers + hyphens, no consecutive '--', no trailing '-'"
exit 1
