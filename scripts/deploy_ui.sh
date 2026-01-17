#!/usr/bin/env bash
set -euo pipefail

# ------------------------------------------------------------
# Usage:
#   ./scripts/deploy_ui.sh dev
#   ./scripts/deploy_ui.sh prod
#
# Optional env vars:
#   REPO_DIR=easyreceipts-review   # folder containing Lovable UI repo
#   DIST_DIR=dist                  # Vite default output
#   BRANCH=main                    # git branch to deploy
#   REGION=eu-central-1            # aws region
# ------------------------------------------------------------

ENV="${1:-}"
if [[ "$ENV" != "dev" && "$ENV" != "prod" ]]; then
  echo "Usage: $0 {dev|prod}"
  exit 1
fi

STACK="easyreceipts-${ENV}"
REGION="${REGION:-${AWS_REGION:-eu-central-1}}"

REPO_DIR="${REPO_DIR:-easyreceipts-review}"
DIST_DIR="${DIST_DIR:-dist}"
BRANCH="${BRANCH:-main}"

need_cmd() { command -v "$1" >/dev/null 2>&1 || { echo "❌ Missing command: $1"; exit 1; }; }

get_output () {
  local key="$1"
  aws cloudformation describe-stacks \
    --region "$REGION" \
    --stack-name "$STACK" \
    --query "Stacks[0].Outputs[?OutputKey=='${key}'].OutputValue" \
    --output text
}

echo "🚀 Deploying Lovable UI"
echo "  env     : $ENV"
echo "  stack   : $STACK"
echo "  region  : $REGION"
echo "  repo    : $REPO_DIR"
echo "  branch  : $BRANCH"
echo "  dist    : $DIST_DIR"

need_cmd aws
need_cmd git
need_cmd npm

if [[ ! -d "$REPO_DIR" ]]; then
  echo "❌ Repo directory '$REPO_DIR' not found (expected at: $(pwd)/$REPO_DIR)"
  exit 1
fi

# --- Update sources ------------------------------------------
echo "🔄 Updating sources (git pull)..."
pushd "$REPO_DIR" >/dev/null

git rev-parse --is-inside-work-tree >/dev/null 2>&1 || { echo "❌ $REPO_DIR is not a git repository"; exit 1; }

git fetch --all --prune
git checkout "$BRANCH"
git pull --ff-only

echo "✅ Repo commit: $(git rev-parse --short HEAD)"

# --- Install deps --------------------------------------------
if [[ -f package-lock.json ]]; then
  echo "📦 Installing dependencies (npm ci)..."
  npm ci
else
  echo "📦 Installing dependencies (npm install)..."
  npm install
fi

# --- Build (Lovable/Vite) ------------------------------------
echo "🏗️  Building (npm run build)..."
npm run build

# --- Validate dist output ------------------------------------
if [[ ! -d "$DIST_DIR" ]]; then
  echo "❌ Build output dir '$REPO_DIR/$DIST_DIR' not found."
  echo "   If your build outputs elsewhere, run: DIST_DIR=<dir> $0 $ENV"
  exit 1
fi

if [[ ! -f "$DIST_DIR/index.html" ]]; then
  echo "❌ '$REPO_DIR/$DIST_DIR/index.html' not found."
  echo "   Build did not produce a static site entrypoint. Check your Lovable/Vite config."
  exit 1
fi

popd >/dev/null

# --- Read infra outputs --------------------------------------
UI_BUCKET="$(get_output UiBucketName)"
UI_DOMAIN="$(get_output UiDistributionDomain)"

if [[ -z "${UI_BUCKET:-}" || "$UI_BUCKET" == "None" || -z "${UI_DOMAIN:-}" || "$UI_DOMAIN" == "None" ]]; then
  echo "❌ Unable to read UiBucketName/UiDistributionDomain outputs from stack $STACK"
  exit 1
fi

echo "📦 UI bucket: $UI_BUCKET"
echo "🌍 CloudFront domain: $UI_DOMAIN"

# --- Sync dist to S3 -----------------------------------------
echo "⬆️  Syncing ${REPO_DIR}/${DIST_DIR}/ -> s3://${UI_BUCKET}/"
aws s3 sync "${REPO_DIR}/${DIST_DIR}/" "s3://${UI_BUCKET}/" --delete

# --- Resolve CloudFront distribution ID ----------------------
echo "🔎 Resolving CloudFront distribution ID..."
DISTRIBUTION_ID="$(aws cloudfront list-distributions \
  --query "DistributionList.Items[?DomainName=='${UI_DOMAIN}'].Id" \
  --output text)"

if [[ -z "${DISTRIBUTION_ID:-}" || "$DISTRIBUTION_ID" == "None" ]]; then
  echo "❌ Unable to resolve CloudFront distribution ID for domain: $UI_DOMAIN"
  exit 1
fi

echo "🆔 CloudFront distribution ID: $DISTRIBUTION_ID"

# --- Invalidate ------------------------------------------------
echo "♻️  Creating CloudFront invalidation..."
aws cloudfront create-invalidation \
  --distribution-id "$DISTRIBUTION_ID" \
  --paths "/*" \
  >/dev/null

echo "✅ Done."
echo "➡️  UI URL: https://${UI_DOMAIN}"
