#!/bin/bash
# Push commits to GitHub as the SignalField Claude bot.
#
# This script:
#   1. Generates a fresh installation token (if needed)
#   2. Pushes to the remote using HTTPS with the bot token
#   3. The commits themselves should already be authored by the bot
#      (use git_commit_as_bot.sh or set GIT_COMMITTER_NAME/EMAIL)
#
# Usage:
#   ./scripts/git-push-as-bot.sh [remote] [refspec]
#   ./scripts/git-push-as-bot.sh                        # push current branch to origin
#   ./scripts/git-push-as-bot.sh origin feature/my-branch
#   ./scripts/git-push-as-bot.sh origin HEAD:refs/heads/feature/my-branch
#
# Prerequisites:
#   - 1Password CLI authenticated
#   - PyJWT installed

set -euo pipefail

BLUE='\033[0;34m'
GREEN='\033[0;32m'
RED='\033[0;31m'
NC='\033[0m'

REMOTE="${1:-origin}"
BRANCH="${2:-$(git rev-parse --abbrev-ref HEAD)}"

# Get the HTTPS URL for the remote
REMOTE_URL=$(git remote get-url "$REMOTE")
# Convert SSH URLs to HTTPS: supports git@github.com:Org/Repo.git and ssh://git@github.com/Org/Repo.git
if [[ "$REMOTE_URL" == git@github.com:* ]]; then
    HTTPS_URL="https://github.com/${REMOTE_URL#git@github.com:}"
elif [[ "$REMOTE_URL" == ssh://git@github.com/* ]]; then
    HTTPS_URL="https://github.com/${REMOTE_URL#ssh://git@github.com/}"
elif [[ "$REMOTE_URL" == https://* ]]; then
    HTTPS_URL="$REMOTE_URL"
else
    echo -e "${RED}Error: Unsupported remote URL format: ${REMOTE_URL}${NC}" >&2
    exit 1
fi

# Generate or reuse token
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if [ -f /tmp/gh_app_token ]; then
    TOKEN=$(cat /tmp/gh_app_token)
    # Quick check if token is still valid
    HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" \
        -H "Authorization: token $TOKEN" \
        https://api.github.com/rate_limit)
    if [ "$HTTP_CODE" != "200" ]; then
        echo -e "${BLUE}Token expired, generating new one...${NC}" >&2
        TOKEN=$("${SCRIPT_DIR}/generate-github-app-token.sh")
    fi
else
    echo -e "${BLUE}No token found, generating...${NC}" >&2
    TOKEN=$("${SCRIPT_DIR}/generate-github-app-token.sh")
fi

# Push using HTTPS with token authentication
# The token is used as the password with x-access-token as username
# Extract org/repo from the HTTPS URL and build the authenticated URL directly
REPO_PATH="${HTTPS_URL#https://github.com/}"
PUSH_URL="https://x-access-token:${TOKEN}@github.com/${REPO_PATH}"

echo -e "${BLUE}Pushing ${BRANCH} to ${REMOTE} as signalfield-claude[bot]...${NC}" >&2

# Bypass global git config to avoid URL rewriting (e.g., insteadOf rules that convert HTTPS to SSH)
GIT_CONFIG_GLOBAL=/dev/null git push "$PUSH_URL" "$BRANCH" 2>&1 | while IFS= read -r line; do
    # Filter out the URL to avoid leaking the token
    echo "$line" | sed "s|${PUSH_URL}|${HTTPS_URL}|g"
done

echo -e "${GREEN}Pushed successfully as signalfield-claude[bot]${NC}" >&2
