#!/usr/bin/env bash
set -euo pipefail
set -x

# Usage:
#   export ARTIFACTS_BUCKET="easyreceipts-sam-artifacts-...."
#   ./scripts/deploy_new_template.sh [path/to/new-template.yaml]
#
# Notes:
# - If no template is passed, it deploys the current template.yaml in the repo.
# - Treats "No changes to deploy" as success (SAM returns non-zero in that case).

TESTS_CLIENT_ID="17nmnav2nsjmlcdtfkmjokd9kt"
NEW_TEMPLATE="${1:-}"

BASE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TEMPLATE="template.yaml"
BCK_TEMPLATE="template.yaml.bck"

: "${ARTIFACTS_BUCKET:?set ARTIFACTS_BUCKET (SAM artifacts S3 bucket)}"
STACK_NAME="${STACK_NAME:-easyreceipts-dev}"
REGION="${REGION:-eu-central-1}"
APP_NAME="${APP_NAME:-easyreceipts}"
ENV_NAME="${ENV_NAME:-dev}"
UI_DOMAIN_PREFIX="${UI_DOMAIN_PREFIX:-easyreceipts-dev-ui-408959241421}"

if [ -n "${NEW_TEMPLATE}" ]; then
  echo "Uso nuovo template: ${NEW_TEMPLATE}"
  cp "${BASE_DIR}/${TEMPLATE}" "${BASE_DIR}/${BCK_TEMPLATE}"
  cp "${NEW_TEMPLATE}" "${BASE_DIR}/${TEMPLATE}"
else
  echo "Nessun template passato, uso quello attuale"
fi

sam validate --lint

sam build --use-container

# Deploy (SAM returns a non-zero exit code when there are no changes)
set +e
DEPLOY_OUT="$(sam deploy   --stack-name "${STACK_NAME}"   --region "${REGION}"   --capabilities CAPABILITY_IAM   --s3-bucket "${ARTIFACTS_BUCKET}"   --no-resolve-s3   --parameter-overrides     AppName="${APP_NAME}"     Env="${ENV_NAME}"     UiDomainPrefix="${UI_DOMAIN_PREFIX}"  TestsUserPoolClientId="$TESTS_CLIENT_ID"  2>&1)"
RC=$?
set -e

echo "${DEPLOY_OUT}"

if [ ${RC} -ne 0 ]; then
  if echo "${DEPLOY_OUT}" | grep -qi "No changes to deploy"; then
    echo "SAM: nessuna modifica da deployare (OK)"
  else
    echo "SAM deploy failed (rc=${RC})" >&2
    exit ${RC}
  fi
fi

echo "Deploy backend OK."
