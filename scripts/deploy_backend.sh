#!/usr/bin/env bash
set -euo pipefail

ENV="${1:-}"

if [[ "$ENV" != "dev" && "$ENV" != "prod" ]]; then
  echo "❌ Usage: ./scripts/deploy_backend.sh {dev|prod}"
  exit 1
fi

echo "🚀 Deploy backend [$ENV]"
echo

# Extra safety for PROD
if [[ "$ENV" == "prod" ]]; then
  echo "⚠️  WARNING: You are about to deploy to PRODUCTION"
  echo "Stack, Cognito, DynamoDB and Stripe LIVE may be affected."
  echo
  read -r -p "Type 'prod' to continue: " CONFIRM
  if [[ "$CONFIRM" != "prod" ]]; then
    echo "❌ Aborted."
    exit 1
  fi
  echo "✅ PROD confirmed"
  echo
fi

# Build (container needed for python3.11)
echo "🔧 sam build --use-container"
sam build --use-container

echo
echo "📦 sam deploy ($ENV)"

sam deploy \
  --config-file samconfig.toml \
  --config-env "$ENV" \
  --no-fail-on-empty-changeset

echo
echo "✅ Backend deployed successfully ($ENV)"
