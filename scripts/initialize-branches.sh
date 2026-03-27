#!/bin/bash

# Initialize Sc0red repository with four-branch strategy
# This script sets up development, testing, demo, and production branches

set -euo pipefail

echo "Initializing Sc0red repository branches..."

# Get current branch
CURRENT_BRANCH=$(git branch --show-current)

echo "Current branch: $CURRENT_BRANCH"

# Create initial commit if repository is empty
git rev-parse HEAD
echo "Creating initial commit..."
git add .
git commit -m "Initial commit: Sc0red TypeScript template repository"

# Create and push development branch (default branch)
echo ""
echo "Creating development branch..."
git checkout -b development
echo "Created development branch"

# Push development branch
git remote get-url origin
echo "Pushing development branch..."
git push -u origin development

# Create testing branch from development
echo ""
echo "Creating testing branch..."
git checkout -b testing development
echo "Created testing branch"

# Push testing branch
git remote get-url origin
echo "Pushing testing branch..."
git push -u origin testing

# Create demo branch from testing
echo ""
echo "Creating demo branch..."
git checkout -b demo testing
echo "Created demo branch"

# Push demo branch
git remote get-url origin
echo "Pushing demo branch..."
git push -u origin demo

# Create production branch from demo
echo ""
echo "Creating production branch..."
git checkout -b production demo
echo "Created production branch"

# Push production branch
git remote get-url origin
echo "Pushing production branch..."
git push -u origin production

# Return to development branch
echo ""
echo "Switching back to development branch..."
git checkout development

# Set development as default branch
echo ""
echo "Setting development as default branch..."
gh repo edit --default-branch development
echo "Development set as default branch"

echo ""
echo "Branch initialization complete!"
echo ""
echo "Branch hierarchy:"
echo "  development -> testing -> demo -> production"
echo ""
echo "Promotion flow:"
echo "  1. Develop features in feature branches off development"
echo "  2. Merge to development for integration"
echo "  3. Promote to testing for QA"
echo "  4. Promote to demo for stakeholder review"
echo "  5. Promote to production for release"
echo ""
echo "Next steps:"
echo "  1. Run: ./scripts/setup-branch-protection.sh"
echo "  2. Configure GitHub Secrets for each environment"
echo "  3. Enable GitHub Actions in repository settings"
