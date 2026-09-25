#!/usr/bin/env bash
set -euo pipefail

# List Cognito users for an environment.
#
# Usage: ./scripts/check_users.sh {dev|prod}

ENV="${1:-}"
AWS_REGION="${AWS_REGION:-eu-central-1}"

if [[ "$ENV" != "dev" && "$ENV" != "prod" ]]; then
  echo "Usage: $0 {dev|prod}"
  exit 1
fi

USER_POOL_ID="$(aws cloudformation describe-stacks \
  --stack-name "easyreceipts-${ENV}" \
  --region "$AWS_REGION" \
  --query "Stacks[0].Outputs[?OutputKey=='UserPoolId'].OutputValue | [0]" \
  --output text)"

if [[ -z "$USER_POOL_ID" || "$USER_POOL_ID" == "None" ]]; then
  echo "❌ Could not resolve UserPoolId for easyreceipts-${ENV}"
  exit 1
fi

echo "👥 Users in ${ENV} (${USER_POOL_ID})"

aws cognito-idp list-users \
  --user-pool-id "$USER_POOL_ID" \
  --region "$AWS_REGION" \
  --query 'Users[*].{created:UserCreateDate,status:UserStatus,username:Username,email:Attributes[?Name==`email`].Value|[0]}' \
  --output table
