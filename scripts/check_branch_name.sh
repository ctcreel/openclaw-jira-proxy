#!/usr/bin/env bash

set -euo pipefail

BRANCH_NAME=$(git symbolic-ref --short HEAD 2>/dev/null || git rev-parse --short HEAD)

# Long-lived branches
LONG_LIVED_BRANCHES="^(main|development|testing|demo|production)$"

# Feature branches: type/TICKET-ID-description
FEATURE_BRANCHES="^(feature|bugfix|hotfix|chore|docs|refactor|test)/[A-Z]{2,}-[0-9]+-[a-z0-9][a-z0-9-]{2,49}$"

if [[ "$BRANCH_NAME" =~ $LONG_LIVED_BRANCHES ]]; then
    exit 0
fi

if [[ "$BRANCH_NAME" =~ $FEATURE_BRANCHES ]]; then
    # Check for consecutive hyphens or trailing hyphen in description
    DESCRIPTION="${BRANCH_NAME#*/}"
    DESCRIPTION="${DESCRIPTION#*-*-}"
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
echo "  Feature:    feature/{TICKET-ID}-{description}"
echo "  Bugfix:     bugfix/{TICKET-ID}-{description}"
echo "  Hotfix:     hotfix/{TICKET-ID}-{description}"
echo "  Chore:      chore/{TICKET-ID}-{description}"
echo "  Docs:       docs/{TICKET-ID}-{description}"
echo "  Refactor:   refactor/{TICKET-ID}-{description}"
echo "  Test:       test/{TICKET-ID}-{description}"
echo ""
echo "Ticket ID: 2+ uppercase letters, dash, 1+ digits (e.g., SF-123)"
echo "Description: 3-50 chars, lowercase + numbers + hyphens"
exit 1
