#!/bin/bash

# Push all branches to remote repository

echo "Pushing all branches to remote..."

# First, ensure we have a remote
if ! git remote | grep -q origin; then
    echo "No remote 'origin' configured"
    echo "Add remote with: git remote add origin <repository-url>"
    exit 1
fi

# Push all environment branches
for branch in development testing demo production; do
    echo "Pushing $branch..."
    git push -u origin $branch
done

echo ""
echo "Setting development as default branch..."
echo "Run: gh repo edit --default-branch development"

echo "All branches pushed successfully!"
