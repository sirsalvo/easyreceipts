#!/usr/bin/env bash
set -euo pipefail
set -x

# Usage:
#   export ARTIFACTS_BUCKET="easyreceipts-sam-artifacts-...."
#   export TEST_USERNAME="sir_salvo@hotmail.com"
#   export TEST_PASSWORD="Password01"
#   export ORIGIN="https://d23kpndm5lpcnv.cloudfront.net"   # your CloudFront UI origin
#   ./scripts/deploy_and_test.sh [path/to/new-template.yaml]
#
# This script:
#  1) deploy backend (optional template override)
#  2) deploy UI to the UI bucket from CloudFormation outputs
#  3) run post-deploy tests

NEW_TEMPLATE="${1:-}"

BASE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

: "${ARTIFACTS_BUCKET:?set ARTIFACTS_BUCKET (SAM artifacts S3 bucket)}"

export STACK_NAME="${STACK_NAME:-easyreceipts-dev}"
export REGION="${REGION:-eu-central-1}"
export ORIGIN="${ORIGIN:-https://d23kpndm5lpcnv.cloudfront.net}"

# Required for tests (end-to-end auth). If you only run negative tests, you can skip these.
: "${TEST_USERNAME:?set TEST_USERNAME}"
: "${TEST_PASSWORD:?set TEST_PASSWORD}"

# Derive UI bucket from CloudFormation outputs
export UI_BUCKET="${UI_BUCKET:-$(aws cloudformation describe-stacks   --stack-name "${STACK_NAME}"   --region "${REGION}"   --query "Stacks[0].Outputs[?OutputKey=='UiBucketName'].OutputValue | [0]"   --output text)}"

if [ -z "${UI_BUCKET}" ] || [ "${UI_BUCKET}" = "None" ]; then
  echo "Unable to resolve UI_BUCKET from CloudFormation outputs." >&2
  exit 1
fi

# Optionally derive CloudFront Distribution Id from ORIGIN
if [ -z "${CLOUDFRONT_DISTRIBUTION_ID:-}" ]; then
  CF_DOMAIN="$(echo "${ORIGIN}" | sed -E 's#^https?://##' | sed -E 's#/$##')"
  export CLOUDFRONT_DISTRIBUTION_ID="$(aws cloudfront list-distributions     --query "DistributionList.Items[?DomainName=='${CF_DOMAIN}'].Id | [0]"     --output text 2>/dev/null || true)"
  if [ "${CLOUDFRONT_DISTRIBUTION_ID}" = "None" ]; then
    unset CLOUDFRONT_DISTRIBUTION_ID
  fi
fi

bash "${BASE_DIR}/scripts/deploy_new_template.sh" "${NEW_TEMPLATE}"

bash "${BASE_DIR}/scripts/deploy-ui.sh"

bash "${BASE_DIR}/scripts/post_deploy_test.sh"
