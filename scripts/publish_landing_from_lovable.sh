#!/usr/bin/env bash
set -euo pipefail

# -------------------------
# Config
# -------------------------
SRC_DIR="/home/salvo/spendify-landing-source/spendify-your-ynab-receipt-hub"
EASYRECEIPTS_DIR="/home/salvo/easyreceipts"
DEST_LANDING_DIR="${EASYRECEIPTS_DIR}/landing"
DEPLOY_SCRIPT="${EASYRECEIPTS_DIR}/scripts/deploy_landing.sh"
BRANCH="${BRANCH:-main}"

ENV="${1:-}"
if [[ "$ENV" != "dev" && "$ENV" != "prod" ]]; then
  echo "❌ Usage: $0 {dev|prod}"
  exit 1
fi

echo "📍 Source: $SRC_DIR"
echo "📦 Target landing dir: $DEST_LANDING_DIR"
echo "🚀 Deploy script: $DEPLOY_SCRIPT"
echo "🌿 Branch: $BRANCH"
echo "🏷️  Env: $ENV"
echo

# -------------------------
# 1) Pull from GitHub (Lovable)
# -------------------------
cd "$SRC_DIR"

if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  echo "❌ $SRC_DIR is not a git repository."
  exit 1
fi

echo "🔄 Fetch + rebase from origin/$BRANCH"
git fetch origin "$BRANCH"
git rebase "origin/$BRANCH"

echo "✅ Repo updated."
echo

# -------------------------
# 2) Build
# -------------------------
if [[ -f "package-lock.json" ]]; then
  echo "📦 Installing deps (npm ci)"
  npm ci
  echo "🏗️  Building (npm run build)"
  npm run build
elif [[ -f "bun.lockb" ]]; then
  echo "📦 Installing deps (bun install)"
  bun install
  echo "🏗️  Building (bun run build)"
  bun run build
else
  echo "❌ No lockfile found (package-lock.json or bun.lockb)."
  exit 1
fi

if [[ ! -d "dist" ]]; then
  echo "❌ Build output 'dist/' not found."
  exit 1
fi

echo "✅ Build done."
echo

# -------------------------
# 2b) Prerender the homepage
# -------------------------
# The build ships an empty <div id="root">: 1 character of indexable text and
# no <h1>. Bake the rendered markup in so crawlers see the content.
echo "🖨️  Prerendering homepage"
node "${EASYRECEIPTS_DIR}/scripts/prerender_landing.mjs" "${SRC_DIR}/dist"
echo

# -------------------------
# 3) Sync dist -> easyreceipts/landing
# -------------------------
# Pages NOT produced by the Lovable build that must survive the sync.
# Without these excludes, `rsync --delete` wipes them and the following
# `aws s3 sync --delete` propagates the deletion to production.
# This is exactly how privacy.html / terms.html went offline (403) in Feb 2026.
KEEP_FILES=(
  "privacy.html"
  "terms.html"
  # The Lovable build ships its own favicon.ico (the orange/blue heart), and
  # that file is what Google was actually displaying next to our result in
  # the SERP: Google falls back to /favicon.ico whenever the declared icon is
  # unusable, and ours was 694x677 - not square - so it was rejected. These
  # are the Spendify icons; excluding them keeps the build from overwriting
  # them on the next publish.
  "favicon.ico"
  "favicon-96.png"
  "favicon-192.png"
  "favicon-512.png"
  "apple-touch-icon.png"
  "spendify-icon.png"
  # The two content pages come from Lovable's public/ folder, but the copies
  # in landing/ carry SEO fixes (favicon, cross-links, social previews) that
  # do not exist upstream. Without these, the sync reverts them.
  "receipt-to-csv/index.html"
  "ynab-receipts/index.html"
  "og-receipt-to-csv.png"
  "og-ynab-receipts.png"
  "ynab-receipt-scanner/index.html"
  "og-ynab-receipt-scanner.png"
  "receipt-scanner-vat/index.html"
  "og-receipt-scanner-vat.png"
  # Upstream lastmod dates are stale (2026-02-11); the repo copy is maintained.
  "sitemap.xml"
)

RSYNC_EXCLUDES=()
for f in "${KEEP_FILES[@]}"; do
  RSYNC_EXCLUDES+=(--exclude "$f")
done

echo "🧰 Syncing dist/ → $DEST_LANDING_DIR"
echo "   Preserving: ${KEEP_FILES[*]}"
mkdir -p "$DEST_LANDING_DIR"
rsync -a --delete "${RSYNC_EXCLUDES[@]}" "dist/" "$DEST_LANDING_DIR/"

# Fail fast if a legally required page went missing for any other reason.
for f in "${KEEP_FILES[@]}"; do
  if [[ ! -f "${DEST_LANDING_DIR}/${f}" ]]; then
    echo "❌ Required page missing after sync: ${DEST_LANDING_DIR}/${f}"
    echo "   Restore it (git checkout -- landing/${f}) before deploying."
    exit 1
  fi
done

echo "✅ Landing folder updated."
echo

# -------------------------
# 4) Deploy (must run from easyreceipts dir because deploy_landing.sh uses relative landing/)
# -------------------------
if [[ ! -x "$DEPLOY_SCRIPT" ]]; then
  echo "❌ Deploy script not found or not executable: $DEPLOY_SCRIPT"
  echo "   Fix with: chmod +x $DEPLOY_SCRIPT"
  exit 1
fi

echo "📂 Switching to $EASYRECEIPTS_DIR (deploy script expects ./landing/)"
cd "$EASYRECEIPTS_DIR"

if [[ ! -d "landing" ]]; then
  echo "❌ Expected folder not found: $EASYRECEIPTS_DIR/landing"
  exit 1
fi

echo "🚀 Running deploy script: $DEPLOY_SCRIPT $ENV"
"$DEPLOY_SCRIPT" "$ENV"

echo
echo "✅ All done."
