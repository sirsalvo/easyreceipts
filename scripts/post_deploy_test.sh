#!/usr/bin/env bash
set -euo pipefail


COGNITO_CLIENT_ID="17nmnav2nsjmlcdtfkmjokd9kt"

# --- Config (override via env) ---
STACK_NAME="${STACK_NAME:-easyreceipts-dev}"
REGION="${REGION:-eu-central-1}"

# Origin UI (serve per CORS)
ORIGIN="${ORIGIN:-https://d23kpndm5lpcnv.cloudfront.net}"

# API base (se vuoto, prova a leggerlo dagli Output CFN)
API_BASE="${API_BASE:-}"

# Cognito client id (se vuoto, prova a leggerlo dagli Output CFN)
USER_POOL_CLIENT_ID="${USER_POOL_CLIENT_ID:-}"

# Utente test Cognito (necessari per E2E)
TEST_USERNAME="${TEST_USERNAME:-}"
TEST_PASSWORD="${TEST_PASSWORD:-}"

# Immagine di test
TEST_IMAGE="/home/salvo/easyreceipts/test/fixtures/scontrino.jpg"

need() { command -v "$1" >/dev/null 2>&1 || { echo "Missing dependency: $1"; exit 1; }; }
need aws
need jq
need curl

# --- Discover outputs (optional) ---
if [[ -z "$API_BASE" ]]; then
  API_BASE="$(aws cloudformation describe-stacks --stack-name "$STACK_NAME" --region "$REGION" \
    --query "Stacks[0].Outputs[?OutputKey=='HttpApiUrl'].OutputValue | [0]" --output text 2>/dev/null || true)"
fi

if [[ -z "$USER_POOL_CLIENT_ID" ]]; then
  USER_POOL_CLIENT_ID="$(aws cloudformation describe-stacks --stack-name "$STACK_NAME" --region "$REGION" \
    --query "Stacks[0].Outputs[?OutputKey=='UserPoolClientId'].OutputValue | [0]" --output text 2>/dev/null || true)"
fi

echo "=== Config ==="
echo "STACK_NAME=$STACK_NAME"
echo "REGION=$REGION"
echo "ORIGIN=$ORIGIN"
echo "API_BASE=$API_BASE"
echo "USER_POOL_CLIENT_ID=$USER_POOL_CLIENT_ID"
echo "TEST_IMAGE=$TEST_IMAGE"
echo "COGNITO_CLIENT_ID=$COGNITO_CLIENT_ID"
echo

if [[ -z "$API_BASE" || "$API_BASE" == "None" ]]; then
  echo "ERROR: API_BASE not set and not found in stack outputs (OutputKey HttpApiUrl)."
  exit 1
fi

# --- Smoke: CORS preflight receipts ---
echo "=== Smoke: CORS preflight /receipts ==="
curl -is -X OPTIONS "$API_BASE/receipts" \
  -H "Origin: $ORIGIN" \
  -H "Access-Control-Request-Method: POST" \
  -H "Access-Control-Request-Headers: content-type,authorization" | sed -n '1,25p'
echo

# --- E2E requires test user ---
if [[ -z "$TEST_USERNAME" || -z "$TEST_PASSWORD" || -z "$USER_POOL_CLIENT_ID" || "$USER_POOL_CLIENT_ID" == "None" ]]; then
  echo "SKIP E2E: set TEST_USERNAME, TEST_PASSWORD, USER_POOL_CLIENT_ID to run end-to-end."
  exit 0
fi

# --- Auth: get token ---
echo "=== Auth: Cognito initiate-auth (USER_PASSWORD_AUTH) ==="
AUTH_JSON="$(aws cognito-idp initiate-auth --region "$REGION" \
  --client-id "$COGNITO_CLIENT_ID" \
  --auth-flow USER_PASSWORD_AUTH \
  --auth-parameters USERNAME="$TEST_USERNAME",PASSWORD="$TEST_PASSWORD")"

ACCESS_TOKEN="$(echo "$AUTH_JSON" | jq -r '.AuthenticationResult.AccessToken // empty')"
if [[ -z "$ACCESS_TOKEN" ]]; then
  echo "ERROR: could not obtain AccessToken."
  echo "$AUTH_JSON" | jq .
  exit 1
fi
echo "OK: AccessToken acquired (len=${#ACCESS_TOKEN})"
echo

# --- Create receipt ---
echo "=== E2E: POST /receipts (create + presign) ==="
CREATE_RESP="$(curl -sS -X POST "$API_BASE/receipts" \
  -H "Authorization: Bearer $ACCESS_TOKEN" \
  -H "Origin: $ORIGIN" \
  -H "Content-Type: application/json" \
  -d '{"contentType":"image/jpeg"}')"

RID="$(echo "$CREATE_RESP" | jq -r '.receiptId // empty')"
UPLOAD_URL="$(echo "$CREATE_RESP" | jq -r '.uploadUrl // empty')"
if [[ -z "$RID" || -z "$UPLOAD_URL" ]]; then
  echo "ERROR: create receipt failed"
  echo "$CREATE_RESP" | jq .
  exit 1
fi
echo "RID=$RID"
echo

# --- Upload via presigned URL ---
echo "=== E2E: PUT presigned upload to S3 ==="
if [[ ! -f "$TEST_IMAGE" ]]; then
  echo "ERROR: TEST_IMAGE not found: $TEST_IMAGE"
  exit 1
fi

curl -is -X PUT \
  -H "Content-Type: image/jpeg" \
  --upload-file "$TEST_IMAGE" \
  "$UPLOAD_URL" | sed -n '1,15p'
echo

echo "=== E2E: Poll GET /receipts/{id} until ocrState=READY ==="
MAX_WAIT=240
SLEEP=5
ELAPSED=0
DONE=0

while [ "$ELAPSED" -lt "$MAX_WAIT" ]; do
  RESP=$(curl -s -w "\n%{http_code}" \
    -H "Authorization: Bearer $ACCESS_TOKEN" \
    -H "Origin: $ORIGIN" \
    "$API_BASE/receipts/$RID")

  BODY=$(echo "$RESP" | sed '$d')
  HTTP=$(echo "$RESP" | tail -n1)

  if [ "$HTTP" != "200" ]; then
    echo "poll: http=$HTTP body_snip=$(echo "$BODY" | head -c 200)"
    sleep "$SLEEP"
    ELAPSED=$((ELAPSED+SLEEP))
    continue
  fi

OCR_STATE=$(echo "$BODY" | jq -r '.item.ocrState // .item.ocr_state // .ocrState // .ocr_state // empty')
STATUS=$(echo "$BODY" | jq -r '.item.status // .status // empty')
OCR_RAW_KEY=$(echo "$BODY" | jq -r '.item.ocrRawKey // empty')
PROCESSED_KEY=$(echo "$BODY" | jq -r '.item.imageProcessedKey // empty')

echo "ocrState=$OCR_STATE status=$STATUS ocrRawKey=${OCR_RAW_KEY:+YES} processedKey=${PROCESSED_KEY:+YES}"

# ✅ Condizione “done” reale nel tuo backend
if [ "$STATUS" = "OCR_DONE" ] || [ "$OCR_STATE" = "READY" ] || [ -n "$OCR_RAW_KEY" ]; then
  echo "OK: OCR DONE"
  DONE=1
  break
fi


  sleep "$SLEEP"
  ELAPSED=$((ELAPSED+SLEEP))
done

if [ "$DONE" -ne 1 ]; then
  echo "ERROR: OCR not READY after ${MAX_WAIT}s"
  exit 1
fi


# --- Confirm metadata ---
echo "=== E2E: PUT /receipts/{id} status=CONFIRMED ==="
CONFIRM_PAYLOAD='{
  "status":"CONFIRMED",
  "payee":"DECATHLON",
  "date":"2025-11-14",
  "total":7.00,
  "vat":1.26,
  "vatRate":"22",
  "notes":""
}'

CONFIRM_RESP="$(curl -sS -X PUT "$API_BASE/receipts/$RID" \
  -H "Authorization: Bearer $ACCESS_TOKEN" \
  -H "Origin: $ORIGIN" \
  -H "Content-Type: application/json" \
  -d "$CONFIRM_PAYLOAD")"

CONFIRM_STATUS="$(echo "$CONFIRM_RESP" | jq -r '.item.status // empty')"
if [[ "$CONFIRM_STATUS" != "CONFIRMED" ]]; then
  echo "ERROR: confirm failed"
  echo "$CONFIRM_RESP" | jq .
  exit 1
fi
echo "OK: CONFIRMED"
echo

# --- List receipts (optional sanity) ---
echo "=== E2E: GET /receipts?limit=10 ==="
LIST_RESP="$(curl -sS -X GET "$API_BASE/receipts?limit=10" \
  -H "Authorization: Bearer $ACCESS_TOKEN" \
  -H "Origin: $ORIGIN")"

count="$(echo "$LIST_RESP" | jq -r '.items | length')"
echo "items_count=$count"
echo "ALL TESTS OK"
