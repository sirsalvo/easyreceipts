#!/usr/bin/env bash
set -euo pipefail

# Usage:
#   export UI_BUCKET="easyreceipts-dev-ui-408959241421"
#   export CLOUDFRONT_DISTRIBUTION_ID="EPI8UHJW1QQSO"   # optional
#   ./deploy-ui.sh
#
# This script:
#  - builds the Vite app (dist/)
#  - uploads HTML with no-cache (so changes are immediately visible)
#  - uploads all other assets with long cache (immutable)
#  - optionally invalidates CloudFront

: "${UI_BUCKET:?UI_BUCKET is required}"

cd easy-receipt-hub-main/

echo "==> Installing deps"
npm ci

echo "==> Building"
npm run build

if [ ! -d "dist" ]; then
  echo "ERROR: dist/ not found. Build did not produce output."
  exit 1
fi



echo "==> Uploading HTML (no-cache)"
aws s3 sync dist/ "s3://${UI_BUCKET}/" \
  --exclude "*" \
  --include "*.html" \
  --cache-control "no-cache, no-store, must-revalidate" \
  --delete

echo "==> Uploading other assets (immutable cache)"
aws s3 sync dist/ "s3://${UI_BUCKET}/" \
  --exclude "*.html" \
  --cache-control "public, max-age=31536000, immutable" \
  --delete

if [ -n "${CLOUDFRONT_DISTRIBUTION_ID:-}" ]; then
  echo "==> CloudFront invalidation: ${CLOUDFRONT_DISTRIBUTION_ID}"
  aws cloudfront create-invalidation \
    --distribution-id "${CLOUDFRONT_DISTRIBUTION_ID}" \
    --paths "/*" >/dev/null
  echo "Invalidation requested."
else
  echo "==> Skipping CloudFront invalidation (set CLOUDFRONT_DISTRIBUTION_ID to enable)."
fi

echo "Done."

cd ..
