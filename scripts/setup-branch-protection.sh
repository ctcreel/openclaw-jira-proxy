#!/bin/bash

# Setup Branch Protection Rules for Sc0red Repository
# Requires: GitHub CLI (gh) installed and authenticated

set -e

echo "Setting up branch protection rules..."
echo "This script requires GitHub CLI. Install with: brew install gh"
echo ""

# Check if gh is installed
if ! command -v gh &> /dev/null; then
    echo "GitHub CLI (gh) is not installed"
    echo "Install with: brew install gh"
    echo "Then authenticate with: gh auth login"
    exit 1
fi

# Get repository name
REPO=$(gh repo view --json nameWithOwner -q .nameWithOwner)
echo "Repository: $REPO"
echo ""

# Function to set branch protection
protect_branch() {
    local BRANCH=$1
    local REQUIRE_PR_REVIEWS=$2
    local REQUIRED_APPROVALS=$3
    local DISMISS_STALE=$4
    local REQUIRE_CODEOWNER=$5

    echo "Protecting branch: $BRANCH"

    # Create the branch protection rule
    gh api \
        --method PUT \
        -H "Accept: application/vnd.github+json" \
        "/repos/$REPO/branches/$BRANCH/protection" \
        -f "required_status_checks[strict]=true" \
        -f "required_status_checks[contexts][]=lint" \
        -f "required_status_checks[contexts][]=test" \
        -f "required_status_checks[contexts][]=security" \
        -f "required_status_checks[contexts][]=sonarcloud" \
        -f "enforce_admins=false" \
        -f "required_pull_request_reviews[dismiss_stale_reviews]=$DISMISS_STALE" \
        -f "required_pull_request_reviews[require_code_owner_reviews]=$REQUIRE_CODEOWNER" \
        -f "required_pull_request_reviews[required_approving_review_count]=$REQUIRED_APPROVALS" \
        -f "restrictions=null" \
        -f "allow_force_pushes=false" \
        -f "allow_deletions=false" \
        -f "block_creations=false" \
        -f "required_conversation_resolution=true" \
        -f "lock_branch=false" \
        -f "allow_fork_syncing=true"

    echo "Branch $BRANCH protected"
    echo ""
}

# Configure each branch with different rules
echo "Configuring branch protection rules..."
echo ""

# Development - least restrictive
# - 1 approval required
# - Stale reviews not dismissed
# - CodeOwner review not required
protect_branch "development" true 1 false false

# Testing - moderate protection
# - 1 approval required
# - Stale reviews dismissed
# - CodeOwner review not required
protect_branch "testing" true 1 true false

# Demo - strict protection
# - 2 approvals required
# - Stale reviews dismissed
# - CodeOwner review required
protect_branch "demo" true 2 true true

# Production - most restrictive
# - 2 approvals required
# - Stale reviews dismissed
# - CodeOwner review required
# Additional: only specific people can merge (set manually in GitHub UI)
protect_branch "production" true 2 true true

echo "Branch protection configured successfully!"
echo ""
echo "Next steps:"
echo "1. Add CODEOWNERS file if using code owner reviews"
echo "2. Configure merge restrictions for production branch in GitHub UI"
echo "3. Add team members who can approve PRs"
echo "4. Configure CodeRabbit for each protected branch"
