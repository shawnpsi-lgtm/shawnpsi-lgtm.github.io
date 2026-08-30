#!/usr/bin/env bash
# Build, commit any changes, and push to origin.
# GitHub Pages serves this repo from main, so pushing main deploys shawnsingh.me.
set -euo pipefail

branch="${1:-main}"
root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$root"

echo "→ Installing dependencies..."
npm ci

echo "→ Linting..."
npm run lint

echo "→ Building..."
npm run build

if git diff --quiet && git diff --staged --quiet; then
  echo "→ Working tree clean — nothing to commit."
else
  echo "→ Committing changes..."
  git add -A
  git commit -m "build"
fi

current="$(git branch --show-current)"
if [[ "$branch" == "$current" ]]; then
  echo "→ Pushing to origin/$branch..."
  git push -u origin "$branch"
else
  echo "→ On branch $current; merge or checkout $branch before deploying to Pages."
  exit 1
fi

echo "✓ Deploy complete."
