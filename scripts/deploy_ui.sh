#!/usr/bin/env bash
set -euo pipefail

# ---------------------------------------
# Deploy UI to S3 + CloudFront invalidation
# Usage:
#   ./scripts/deploy_ui.sh dev
#   ./scripts/deploy_ui.sh prod
#
# Optional env vars:
#   REGION=eu-central-1
#   DO_SYNC=0|1
#   STACK_PREFIX=easyreceipts
#   UI_BUCKET=<bucket-name>                 # overrides CFN output
#   CF_DISTRIBUTION_ID=<cloudfront-id>      # forces invalidation
#   CF_ALIAS=<alias-domain>                 # enables alias lookup (prod default)
#   CF_DOMAIN=<dxxxx.cloudfront.net>        # enables DomainName lookup (dev default)
# ---------------------------------------

ENVIRONMENT="${1:-}"
if [[ "$ENVIRONMENT" != "dev" && "$ENVIRONMENT" != "prod" ]]; then
  echo "❌ Usage: $0 dev|prod"
  exit 1
fi

REGION="${REGION:-eu-central-1}"
DO_SYNC="${DO_SYNC:-0}"
STACK_PREFIX="${STACK_PREFIX:-easyreceipts}"
STACK_NAME="${STACK_PREFIX}-${ENVIRONMENT}"

# Defaults (based on your current CloudFront setup)
DEFAULT_PROD_ALIAS="app.spendifyapp.com"
DEFAULT_DEV_DOMAIN="d33xe02gdlyt8z.cloudfront.net"

CF_ALIAS="${CF_ALIAS:-}"
CF_DOMAIN="${CF_DOMAIN:-}"

if [[ -z "$CF_ALIAS" && "$ENVIRONMENT" == "prod" ]]; then
  CF_ALIAS="$DEFAULT_PROD_ALIAS"
fi

if [[ -z "$CF_DOMAIN" && "$ENVIRONMENT" == "dev" ]]; then
  CF_DOMAIN="$DEFAULT_DEV_DOMAIN"
fi

echo "🚀 Deploy UI"
echo "   Environment : $ENVIRONMENT"
echo "   Stack       : $STACK_NAME"
echo "   Region      : $REGION"
echo "   Sync UI     : $DO_SYNC"
if [[ -n "$CF_ALIAS" ]]; then echo "   CF Alias    : $CF_ALIAS"; fi
if [[ -n "$CF_DOMAIN" ]]; then echo "   CF Domain   : $CF_DOMAIN"; fi
echo "------------------------------------"

# ---------------------------------------
# (Optional) Sync frontend from Lovable
# ---------------------------------------
if [[ "$DO_SYNC" == "1" ]]; then
  echo "🔄 Sync frontend from Lovable..."
  bash scripts/sync_frontend_from_lovable.sh
fi

# ---------------------------------------
# Build frontend
# ---------------------------------------
echo "🏗️  Building frontend..."
pushd frontend >/dev/null
npm ci
npm run build
popd >/dev/null

# ---------------------------------------
# Resolve UI bucket (from CFN output unless overridden)
# ---------------------------------------
if [[ -z "${UI_BUCKET:-}" ]]; then
  UI_BUCKET="$(aws cloudformation describe-stacks \
    --stack-name "$STACK_NAME" \
    --region "$REGION" \
    --query "Stacks[0].Outputs[?OutputKey=='UiBucketName'].OutputValue" \
    --output text || true)"
fi

if [[ -z "${UI_BUCKET:-}" || "${UI_BUCKET:-}" == "None" ]]; then
  echo "❌ Cannot resolve UI bucket."
  echo "   - Ensure CFN stack '$STACK_NAME' has OutputKey 'UiBucketName', or"
  echo "   - Provide UI_BUCKET=<bucket-name>."
  exit 1
fi

echo "📦 UI Bucket: $UI_BUCKET"

# ---------------------------------------
# Deploy to S3
# ---------------------------------------
echo "⬆️  Upload index.html (no-cache)"
aws s3 cp frontend/dist/index.html "s3://${UI_BUCKET}/index.html" \
  --cache-control "no-cache, no-store, must-revalidate" \
  --content-type "text/html"

echo "⬆️  Sync static assets (long cache)"
aws s3 sync frontend/dist "s3://${UI_BUCKET}" \
  --exclude "index.html" \
  --delete \
  --cache-control "public, max-age=31536000, immutable"

# ---------------------------------------
# Resolve CloudFront distribution id
# - 1) CF_DISTRIBUTION_ID env override
# - 2) CFN output UiDistributionId
# - 3) Search by alias (if CF_ALIAS provided)
# - 4) Search by DomainName (if CF_DOMAIN provided)  <-- NEW for dev
# ---------------------------------------
RESOLVED_CF_ID="${CF_DISTRIBUTION_ID:-}"

if [[ -z "$RESOLVED_CF_ID" ]]; then
  RESOLVED_CF_ID="$(aws cloudformation describe-stacks \
    --stack-name "$STACK_NAME" \
    --region "$REGION" \
    --query "Stacks[0].Outputs[?OutputKey=='UiDistributionId'].OutputValue" \
    --output text 2>/dev/null || true)"
  if [[ "$RESOLVED_CF_ID" == "None" ]]; then
    RESOLVED_CF_ID=""
  fi
fi

if [[ -z "$RESOLVED_CF_ID" && -n "$CF_ALIAS" ]]; then
  RESOLVED_CF_ID="$(aws cloudfront list-distributions \
    --query "DistributionList.Items[?Aliases.Items && contains(Aliases.Items, '${CF_ALIAS}')].Id | [0]" \
    --output text 2>/dev/null || true)"
  if [[ "$RESOLVED_CF_ID" == "None" ]]; then
    RESOLVED_CF_ID=""
  fi
fi

if [[ -z "$RESOLVED_CF_ID" && -n "$CF_DOMAIN" ]]; then
  RESOLVED_CF_ID="$(aws cloudfront list-distributions \
    --query "DistributionList.Items[?DomainName=='${CF_DOMAIN}'].Id | [0]" \
    --output text 2>/dev/null || true)"
  if [[ "$RESOLVED_CF_ID" == "None" ]]; then
    RESOLVED_CF_ID=""
  fi
fi

# ---------------------------------------
# Invalidate CloudFront (if resolved)
# ---------------------------------------
if [[ -z "$RESOLVED_CF_ID" ]]; then
  echo "⚠️  CloudFront distribution ID not found; skipping invalidation."
  echo "   - Set CF_DISTRIBUTION_ID=<id> to force invalidation, or"
  echo "   - Set CF_ALIAS=<alias-domain> (if distribution has aliases), or"
  echo "   - Set CF_DOMAIN=<dxxxx.cloudfront.net> to enable DomainName lookup."
else
  echo "♻️  Invalidating CloudFront: $RESOLVED_CF_ID"
  aws cloudfront create-invalidation \
    --distribution-id "$RESOLVED_CF_ID" \
    --paths "/*" >/dev/null
  echo "✅ CloudFront invalidation submitted."
fi

echo "✅ Deploy completed for environment: $ENVIRONMENT"
