#!/usr/bin/env bash
set -euo pipefail

# Smoke test per EasyReceipts UI + Cognito Hosted UI wiring.
# Usa:
#   ./smoke.sh \
#     --ui https://d23kpndm5lpcnv.cloudfront.net \
#     --api https://<api-id>.execute-api.eu-central-1.amazonaws.com
#
# Opzionali:
#   --cognito-domain https://<your-domain>.auth.eu-central-1.amazoncognito.com
#   --client-id <clientId>
#
# Nota: senza cognito-domain/client-id fa solo test statico UI + API health endpoints (se presenti).

UI_BASE=""
API_BASE=""
COGNITO_DOMAIN=""
CLIENT_ID=""
VERBOSE=0

die(){ echo "ERROR: $*" >&2; exit 1; }
log(){ echo "[smoke] $*"; }
vlog(){ if [[ "$VERBOSE" == "1" ]]; then echo "[smoke][debug] $*"; fi }

while [[ $# -gt 0 ]]; do
  case "$1" in
    --ui) UI_BASE="${2:-}"; shift 2;;
    --api) API_BASE="${2:-}"; shift 2;;
    --cognito-domain) COGNITO_DOMAIN="${2:-}"; shift 2;;
    --client-id) CLIENT_ID="${2:-}"; shift 2;;
    -v|--verbose) VERBOSE=1; shift;;
    -h|--help)
      sed -n '1,80p' "$0"; exit 0;;
    *) die "Argomento sconosciuto: $1";;
  esac
done

[[ -n "$UI_BASE" ]] || die "Manca --ui"
[[ -n "$API_BASE" ]] || die "Manca --api"

# Basic sanity for URLs
UI_BASE="${UI_BASE%/}"
API_BASE="${API_BASE%/}"

REQ() {
  local url="$1"
  local expected_code="${2:-200}"
  vlog "GET $url (atteso $expected_code)"
  # -L: segue redirect; -sS: silenzioso ma mostra errori; -o /dev/null: scarta body
  local code
  code="$(curl -L -sS -o /dev/null -w '%{http_code}' "$url" || true)"
  if [[ "$code" != "$expected_code" ]]; then
    die "HTTP $code su $url (atteso $expected_code)"
  fi
  log "OK $expected_code $url"
}

# 1) UI reachable
REQ "$UI_BASE/" 200

# 2) Asset core (app.js deve esistere)
REQ "$UI_BASE/app.js" 200

# 3) Route settings (hash routing non è visibile a curl, quindi testiamo la pagina base + bundle)
# Se avete anche una route reale /settings come fallback, la testiamo.
code="$(curl -sS -o /dev/null -w '%{http_code}' "$UI_BASE/settings" || true)"
if [[ "$code" == "200" ]]; then
  log "OK 200 $UI_BASE/settings"
else
  log "INFO $UI_BASE/settings non esposto (OK se usi solo hash routing)."
fi

# 4) API OpenAPI / health (se c'è)
for path in "/openapi.json" "/health" "/"; do
  code="$(curl -sS -o /dev/null -w '%{http_code}' "$API_BASE$path" || true)"
  if [[ "$code" == "200" ]]; then
    log "OK 200 $API_BASE$path"
    break
  fi
done

# 5) Cognito Hosted UI wiring (opzionale ma consigliato)
if [[ -n "$COGNITO_DOMAIN" && -n "$CLIENT_ID" ]]; then
  COGNITO_DOMAIN="${COGNITO_DOMAIN%/}"
  # Importantissimo: niente frammenti (#) nei redirect Cognito.
  # Usiamo /callback (route reale) e poi la SPA può portarti su #/callback.
  REDIRECT_URI="$UI_BASE/callback"
  export REDIRECT_URI
  # Richiesta di authorize (non completa login ma verifica che l'endpoint risponda e non dia invalid_request).
  AUTH_URL="$COGNITO_DOMAIN/oauth2/authorize?response_type=code&client_id=$CLIENT_ID&redirect_uri=$(python3 - <<'PY'
import os, urllib.parse
print(urllib.parse.quote(os.environ['REDIRECT_URI'], safe=''))
PY
)&scope=openid+email"

  vlog "AUTH_URL=$AUTH_URL"

  # Cognito di solito risponde 200 (pagina login) o 302.
  code="$(curl -sS -o /dev/null -w '%{http_code}' "$AUTH_URL" || true)"
  if [[ "$code" != "200" && "$code" != "302" ]]; then
    die "Hosted UI authorize risponde $code (atteso 200/302). Verifica domain/clientId/redirectUri."
  fi
  log "OK Hosted UI authorize ($code)"
else
  log "INFO salto test Hosted UI (manca --cognito-domain o --client-id)"
fi

log "SMOKE TEST COMPLETATO ✅"
