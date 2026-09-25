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
  # ⚠️ There is currently NO dev landing environment: the bucket above does not
  # exist and this distribution id is the PRODUCTION one (spendifyapp.com).
  # Running this script with "dev" would invalidate production, so we block it.
  echo "❌ No dev landing environment exists (bucket ${LANDING_BUCKET} not provisioned)."
  echo "   The configured distribution id is the production one - refusing to continue."
  exit 1
else
  LANDING_BUCKET="spendify-landing-prod-${ACCOUNT_ID}-${AWS_REGION}"
  DIST_ID="E32IUXP48RU6GA"
fi

echo "🚀 Deploy landing [$ENV]"
echo "Bucket: $LANDING_BUCKET"
echo "Distribution: $DIST_ID"
echo

# Guard: never publish a landing without the legally required pages.
# Stripe requires reachable Terms/Privacy, and the `s3 sync --delete` below
# would wipe them from production (this is how they returned 403 in Feb 2026).
# Checked BEFORE the confirmation prompt so it fails fast.
for f in privacy.html terms.html; do
  if [[ ! -f "landing/${f}" ]]; then
    echo "❌ Refusing to deploy: landing/${f} is missing."
    echo "   Restore it with: git checkout -- landing/${f}"
    exit 1
  fi
done
echo "✅ Legal pages present (privacy.html, terms.html)"
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
