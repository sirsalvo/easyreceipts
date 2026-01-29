#!/usr/bin/env bash
set -euo pipefail

MONOREPO_DIR="${MONOREPO_DIR:-$HOME/easyreceipts}"
LOVABLE_REPO_DIR="${LOVABLE_REPO_DIR:-$HOME/lovable-sources/lovable-frontend}"
LOVABLE_BRANCH="${LOVABLE_BRANCH:-main}"

FRONTEND_DIR="$MONOREPO_DIR/frontend"

echo "==> Update Lovable repo: $LOVABLE_REPO_DIR ($LOVABLE_BRANCH)"
cd "$LOVABLE_REPO_DIR"
git fetch origin "$LOVABLE_BRANCH"
git checkout "$LOVABLE_BRANCH" >/dev/null 2>&1 || true
git pull --ff-only origin "$LOVABLE_BRANCH"

echo "==> Sync into monorepo: $FRONTEND_DIR"
mkdir -p "$FRONTEND_DIR"

# Mirror Lovable repo -> monorepo/frontend
# Exclude git metadata + build artifacts + local deps
rsync -a --delete \
  --exclude ".git/" \
  --exclude "node_modules/" \
  --exclude "dist/" \
  --exclude ".env" \
  --exclude ".env.*" \
  --exclude ".DS_Store" \
  "$LOVABLE_REPO_DIR/" "$FRONTEND_DIR/"

echo "==> Commit & push (if changes)"
cd "$MONOREPO_DIR"

git add "$FRONTEND_DIR"

if git diff --cached --quiet; then
  echo "No changes detected. Nothing to commit."
  exit 0
fi

LOVABLE_SHA="$(cd "$LOVABLE_REPO_DIR" && git rev-parse --short HEAD)"
LOVABLE_MSG="$(cd "$LOVABLE_REPO_DIR" && git log -1 --pretty=%s)"

git commit -m "chore(frontend): sync from lovable (${LOVABLE_SHA}) - ${LOVABLE_MSG}"
git push

echo "Done."
