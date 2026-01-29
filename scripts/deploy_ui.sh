#!/usr/bin/env bash
set -euo pipefail

# ------------------------------------------------------------
# Spendify / EasyReceipts - UI deploy (dev|prod) with optional sync
#
# Usage:
#   ./scripts/deploy_ui.sh <dev|prod> [--sync]
#
# Examples:
#   ./scripts/deploy_ui.sh dev
#   ./scripts/deploy_ui.sh prod
#   ./scripts/deploy_ui.sh dev --sync
#   ./scripts/deploy_ui.sh prod --sync
#
# Optional overrides:
#   AWS_REGION=eu-central-1
#   CF_DISTRIBUTION_ID=<id>     # force invalidation id
#   CF_ALIAS=<alias-domain>     # used to lookup distribution id (e.g., app.spendifyapp.com)
# ------------------------------------------------------------

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
FRONTEND_DIR="${REPO_ROOT}/frontend"

AWS_REGION="${AWS_REGION:-eu-central-1}"

usage() {
  echo "Usage: $0 <dev|prod> [--sync]"
  exit 1
}

ENVIRONMENT="${1:-}"
[[ -z "${ENVIRONMENT}" ]] && usage
[[ "${ENVIRONMENT}" != "dev" && "${ENVIRONMENT}" != "prod" ]] && usage

SYNC_UI=0
shift || true

while [[ $# -gt 0 ]]; do
  case "$1" in
    --sync)
      SYNC_UI=1
      shift
      ;;
    *)
      echo "Unknown option: $1"
      usage
      ;;
  esac
done

STACK_NAME="easyreceipts-${ENVIRONMENT}"

# ---- Helpers ------------------------------------------------

get_stack_output() {
  local key="$1"
  aws cloudformation describe-stacks \
    --region "${AWS_REGION}" \
    --stack-name "${STACK_NAME}" \
    --query "Stacks[0].Outputs[?OutputKey=='${key}'].OutputValue | [0]" \
    --output text
}

find_cf_distribution_id_by_domain() {
  local domain="$1"
  # CloudFront list-distributions output is paginated, but this query works for most accounts.
  aws cloudfront list-distributions \
    --query "DistributionList.Items[?DomainName=='${domain}'].Id | [0]" \
    --output text 2>/dev/null || true
}

find_cf_distribution_id_by_alias() {
  local alias="$1"
  aws cloudfront list-distributions \
    --query "DistributionList.Items[?Aliases.Items && contains(Aliases.Items, '${alias}')].Id | [0]" \
    --output text 2>/dev/null || true
}

invalidate_cloudfront() {
  local cf_id="$1"
  echo "♻️  Invalidating CloudFront: ${cf_id}"
  aws cloudfront create-invalidation --distribution-id "${cf_id}" --paths "/*" >/dev/null
  echo "✅ CloudFront invalidation submitted."
}

# ---- Header -------------------------------------------------

echo "🚀 Deploy UI"
echo "   Environment : ${ENVIRONMENT}"
echo "   Stack       : ${STACK_NAME}"
echo "   Region      : ${AWS_REGION}"
echo "   Sync UI     : ${SYNC_UI}"
[[ -n "${CF_ALIAS:-}" ]] && echo "   CF Alias    : ${CF_ALIAS}"
[[ -n "${CF_DISTRIBUTION_ID:-}" ]] && echo "   CF ForcedID : ${CF_DISTRIBUTION_ID}"
echo "------------------------------------"

# ---- Optional sync from Lovable -----------------------------

if [[ "${SYNC_UI}" == "1" ]]; then
  echo "🔁 Syncing frontend from Lovable..."
  "${REPO_ROOT}/scripts/sync_frontend_from_lovable.sh"
fi

# ---- Build --------------------------------------------------

echo "🏗️  Building frontend (mode: ${ENVIRONMENT})..."
cd "${FRONTEND_DIR}"

# Install deps (cheap if already installed)
npm ci

# Build with Vite mode (loads .env.dev / .env.prod automatically)
npm run build -- --mode "${ENVIRONMENT}"

if [[ ! -d "${FRONTEND_DIR}/dist" ]]; then
  echo "❌ ERROR: dist/ not found. Build did not produce output."
  exit 1
fi

# ---- Resolve UI bucket & CloudFront --------------------------

UI_BUCKET="$(get_stack_output "UiBucketName")"
UI_CF_DOMAIN="$(get_stack_output "UiDistributionDomain")"

if [[ -z "${UI_BUCKET}" || "${UI_BUCKET}" == "None" ]]; then
  echo "❌ ERROR: Could not resolve UiBucketName from stack outputs."
  exit 1
fi

echo "📦 UI Bucket: ${UI_BUCKET}"

# ---- Upload -------------------------------------------------

echo "⬆️  Upload index.html (no-cache)"
aws s3 cp "${FRONTEND_DIR}/dist/index.html" "s3://${UI_BUCKET}/index.html" \
  --cache-control "no-cache, no-store, must-revalidate" \
  --content-type "text/html" \
  --region "${AWS_REGION}"

echo "⬆️  Sync static assets (long cache)"
aws s3 sync "${FRONTEND_DIR}/dist" "s3://${UI_BUCKET}/" \
  --exclude "index.html" \
  --cache-control "public, max-age=31536000, immutable" \
  --delete \
  --region "${AWS_REGION}"

# ---- Invalidation (best-effort) -----------------------------

CF_ID=""

if [[ -n "${CF_DISTRIBUTION_ID:-}" ]]; then
  CF_ID="${CF_DISTRIBUTION_ID}"
else
  # 1) Try lookup by distribution domain from stack output
  if [[ -n "${UI_CF_DOMAIN}" && "${UI_CF_DOMAIN}" != "None" ]]; then
    CF_ID="$(find_cf_distribution_id_by_domain "${UI_CF_DOMAIN}")"
  fi

  # 2) Fallback: lookup by alias if provided
  if [[ -z "${CF_ID}" || "${CF_ID}" == "None" ]]; then
    if [[ -n "${CF_ALIAS:-}" ]]; then
      CF_ID="$(find_cf_distribution_id_by_alias "${CF_ALIAS}")"
    fi
  fi
fi

if [[ -n "${CF_ID}" && "${CF_ID}" != "None" ]]; then
  invalidate_cloudfront "${CF_ID}"
else
  echo "⚠️  CloudFront distribution ID not found; skipping invalidation."
  echo "   - Set CF_DISTRIBUTION_ID=<id> to force invalidation, or"
  echo "   - Provide CF_ALIAS=<alias-domain> to enable alias-based lookup."
fi

echo "✅ Deploy completed for environment: ${ENVIRONMENT}"
