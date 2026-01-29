#!/usr/bin/env bash
set -euo pipefail

ENV="${1:-}"

if [[ "$ENV" != "dev" && "$ENV" != "prod" ]]; then
  echo "❌ Usage: ./scripts/deploy_landing.sh {dev|prod}"
  exit 1
fi

AWS_REGION="eu-central-1"
ACCOUNT_ID="$(aws sts get-caller-identity --query Account --output text)"

if [[ "$ENV" == "dev" ]]; then
  LANDING_BUCKET="spendify-landing-dev-${ACCOUNT_ID}-${AWS_REGION}"
  DIST_ID="E32IUXP48RU6GA"   # ⚠️ se in futuro separi dev/prod, cambia qui
else
  LANDING_BUCKET="spendify-landing-prod-${ACCOUNT_ID}-${AWS_REGION}"
  DIST_ID="E32IUXP48RU6GA"
fi

echo "🚀 Deploy landing [$ENV]"
echo "Bucket: $LANDING_BUCKET"
echo "Distribution: $DIST_ID"
echo

# Safety for prod
if [[ "$ENV" == "prod" ]]; then
  echo "⚠️  Deploying LANDING to PRODUCTION"
  read -r -p "Type 'prod' to continue: " CONFIRM
  [[ "$CONFIRM" == "prod" ]] || { echo "❌ Aborted."; exit 1; }
  echo
fi

# Sync
aws s3 sync landing/ "s3://${LANDING_BUCKET}" --delete

# Invalidate CloudFront
aws cloudfront create-invalidation \
  --distribution-id "$DIST_ID" \
  --paths "/*" >/dev/null

echo
echo "✅ Landing deployed ($ENV)"
