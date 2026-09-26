# src/api/ynab.py
"""
YNAB integration: OAuth (authorization code + PKCE) and server-side export.

Why this exists: YNAB rejected the app because it asked users for a Personal
Access Token, which their API Terms forbid. Tokens now come from the OAuth
flow, are stored encrypted (KMS, bound to the user id) and every call to YNAB
is made from the backend. The browser never sees a YNAB token.

Storage: one attribute on the user's row in USERS_TABLE.
  ynabPending  {state, verifier, expiresAt}   one in-flight authorization
  ynab         {accessTokenEnc, refreshTokenEnc, accessExpiresAt,
                connectedAt, planId, planName, accountId, accountName}
"""
from __future__ import annotations

import base64
import datetime as dt
import functools
import hashlib
import hmac
import os
import re
import secrets
import time
from decimal import ROUND_HALF_UP, Decimal, InvalidOperation
from typing import Any, Dict, List, Optional
from urllib.parse import urlencode

import boto3
import requests
from botocore.exceptions import ClientError

from ssm_cache import get_env_param_name, get_param

AUTHORIZE_URL = "https://app.ynab.com/oauth/authorize"
TOKEN_URL = "https://app.ynab.com/oauth/token"
API_URL = "https://api.ynab.com/v1"

PENDING_TTL_SECONDS = 600
REFRESH_SKEW_SECONDS = 120
HTTP_TIMEOUT_SECONDS = 15
EXPORT_BATCH_SIZE = 100
EXPORT_MAX_RECEIPTS = 200

_ID_RE = re.compile(r"^[0-9a-fA-F-]{36}$")


class YnabError(Exception):
    def __init__(self, status: int, code: str, message: str):
        super().__init__(message)
        self.status = status
        self.code = code
        self.message = message


# --------------------------------------------------------------------------
# AWS handles (created lazily so tests can replace them)
# --------------------------------------------------------------------------

@functools.lru_cache(maxsize=None)
def _ddb():
    return boto3.resource("dynamodb")


@functools.lru_cache(maxsize=None)
def _kms():
    return boto3.client("kms")


def _users_table():
    name = os.getenv("USERS_TABLE", "")
    if not name:
        raise RuntimeError("USERS_TABLE env var missing")
    return _ddb().Table(name)


def _receipts_table():
    name = os.getenv("RECEIPTS_TABLE", "")
    if not name:
        raise RuntimeError("RECEIPTS_TABLE env var missing")
    return _ddb().Table(name)


def _kms_key() -> str:
    key = os.getenv("YNAB_KMS_KEY_ID", "").strip()
    if not key:
        raise RuntimeError("YNAB_KMS_KEY_ID env var missing")
    return key


def _redirect_uri() -> str:
    # Built server-side from configuration, never taken from the request:
    # a caller-supplied redirect URI would be an open redirect.
    base = os.getenv("APP_BASE_URL", "").rstrip("/")
    if not base:
        raise RuntimeError("APP_BASE_URL env var missing")
    return f"{base}/ynab/callback"


def _client_credentials() -> Dict[str, str]:
    return {
        "client_id": get_param(get_env_param_name("YNAB_CLIENT_ID_PARAM"), decrypt=False),
        "client_secret": get_param(get_env_param_name("YNAB_CLIENT_SECRET_PARAM"), decrypt=True),
    }


def _now() -> int:
    return int(time.time())


# --------------------------------------------------------------------------
# Token encryption
# --------------------------------------------------------------------------

def _encrypt(sub: str, plaintext: str) -> str:
    resp = _kms().encrypt(
        KeyId=_kms_key(),
        Plaintext=plaintext.encode("utf-8"),
        EncryptionContext={"userId": sub},
    )
    return base64.b64encode(resp["CiphertextBlob"]).decode("ascii")


def _decrypt(sub: str, blob: str) -> str:
    resp = _kms().decrypt(
        KeyId=_kms_key(),
        CiphertextBlob=base64.b64decode(blob),
        EncryptionContext={"userId": sub},
    )
    return resp["Plaintext"].decode("utf-8")


# --------------------------------------------------------------------------
# User row helpers
# --------------------------------------------------------------------------

def _get_user(sub: str) -> Dict[str, Any]:
    item = _users_table().get_item(Key={"userId": sub}).get("Item")
    if not item:
        raise YnabError(409, "profile_not_ready", "User profile not initialised yet")
    return item


def _connection(sub: str) -> Dict[str, Any]:
    conn = _get_user(sub).get("ynab")
    if not conn:
        raise YnabError(409, "ynab_not_connected", "YNAB is not connected")
    return conn


def _drop_connection(sub: str) -> None:
    _users_table().update_item(
        Key={"userId": sub},
        UpdateExpression="REMOVE ynab, ynabPending",
    )


# --------------------------------------------------------------------------
# OAuth
# --------------------------------------------------------------------------

def start_authorization(sub: str) -> Dict[str, str]:
    _get_user(sub)

    verifier = secrets.token_urlsafe(64)
    challenge = (
        base64.urlsafe_b64encode(hashlib.sha256(verifier.encode("ascii")).digest())
        .rstrip(b"=")
        .decode("ascii")
    )
    state = secrets.token_urlsafe(32)

    _users_table().update_item(
        Key={"userId": sub},
        UpdateExpression="SET ynabPending = :p",
        ExpressionAttributeValues={
            ":p": {"state": state, "verifier": verifier, "expiresAt": _now() + PENDING_TTL_SECONDS}
        },
    )

    # No `scope=read-only`: creating transactions is a write.
    query = urlencode(
        {
            "client_id": _client_credentials()["client_id"],
            "redirect_uri": _redirect_uri(),
            "response_type": "code",
            "state": state,
            "code_challenge": challenge,
            "code_challenge_method": "S256",
        }
    )
    return {"authorizeUrl": f"{AUTHORIZE_URL}?{query}"}


def _token_request(fields: Dict[str, str]) -> Dict[str, Any]:
    body = {**_client_credentials(), **fields}
    try:
        resp = requests.post(TOKEN_URL, data=body, timeout=HTTP_TIMEOUT_SECONDS)
    except requests.RequestException:
        raise YnabError(502, "ynab_unreachable", "Could not reach YNAB")

    try:
        data = resp.json()
    except ValueError:
        data = {}

    if resp.status_code != 200 or not data.get("access_token"):
        # Log the OAuth error code only, never the request or response body.
        print(f"[ynab] token request failed status={resp.status_code} error={data.get('error')}")
        if resp.status_code in (400, 401):
            raise YnabError(400, "ynab_token_rejected", "YNAB did not accept the authorization")
        # 5xx / 429: YNAB is having a problem, the grant itself may be fine.
        raise YnabError(502, "ynab_unavailable", "YNAB is temporarily unavailable")
    return data


def _connection_from_tokens(sub: str, tokens: Dict[str, Any], previous: Optional[Dict[str, Any]]) -> Dict[str, Any]:
    refresh = tokens.get("refresh_token")
    if not refresh:
        raise YnabError(502, "ynab_bad_response", "YNAB returned no refresh token")
    conn = dict(previous or {})
    conn.update(
        accessTokenEnc=_encrypt(sub, tokens["access_token"]),
        refreshTokenEnc=_encrypt(sub, refresh),
        accessExpiresAt=_now() + int(tokens.get("expires_in") or 7200),
    )
    conn.setdefault("connectedAt", _now())
    return conn


def complete_authorization(sub: str, code: str, state: str) -> Dict[str, Any]:
    if not code or not state:
        raise YnabError(400, "invalid_request", "Missing code or state")

    user = _get_user(sub)
    pending = user.get("ynabPending") or {}

    # Consume the pending authorization first, so a code/state pair is single use
    # whatever happens next.
    _users_table().update_item(Key={"userId": sub}, UpdateExpression="REMOVE ynabPending")

    if (
        not pending
        or int(pending.get("expiresAt", 0)) < _now()
        or not hmac.compare_digest(str(pending.get("state", "")), state)
    ):
        raise YnabError(400, "invalid_state", "Authorization expired or invalid, please try again")

    tokens = _token_request(
        {
            "grant_type": "authorization_code",
            "code": code,
            "redirect_uri": _redirect_uri(),
            "code_verifier": pending["verifier"],
        }
    )

    # Reconnecting keeps the plan/account the user already chose.
    conn = _connection_from_tokens(sub, tokens, user.get("ynab"))
    _users_table().update_item(
        Key={"userId": sub},
        UpdateExpression="SET ynab = :c",
        ExpressionAttributeValues={":c": conn},
    )
    return status(sub)


def _refresh(sub: str, conn: Dict[str, Any]) -> Dict[str, Any]:
    try:
        refresh_token = _decrypt(sub, conn["refreshTokenEnc"])
    except ClientError:
        raise YnabError(409, "ynab_reconnect_required", "Please reconnect YNAB")

    try:
        tokens = _token_request({"grant_type": "refresh_token", "refresh_token": refresh_token})
    except YnabError as e:
        if e.code == "ynab_token_rejected":
            # Revoked in YNAB or expired: the stored connection is useless.
            _drop_connection(sub)
            raise YnabError(409, "ynab_reconnect_required", "Please reconnect YNAB")
        raise

    new_conn = _connection_from_tokens(sub, tokens, conn)
    try:
        _users_table().update_item(
            Key={"userId": sub},
            UpdateExpression="SET ynab = :c",
            ConditionExpression="ynab.refreshTokenEnc = :old",
            ExpressionAttributeValues={":c": new_conn, ":old": conn["refreshTokenEnc"]},
        )
    except ClientError as e:
        if e.response.get("Error", {}).get("Code") != "ConditionalCheckFailedException":
            raise
        # A concurrent request refreshed first; use its tokens.
        return _connection(sub)
    return new_conn


def _access_token(sub: str, conn: Dict[str, Any], force_refresh: bool = False) -> str:
    if force_refresh or int(conn.get("accessExpiresAt", 0)) - REFRESH_SKEW_SECONDS <= _now():
        conn = _refresh(sub, conn)
    return _decrypt(sub, conn["accessTokenEnc"])


# --------------------------------------------------------------------------
# YNAB API
# --------------------------------------------------------------------------

def _api(sub: str, method: str, path: str, json_body: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    conn = _connection(sub)
    resp = None
    for attempt in (0, 1):
        token = _access_token(sub, conn, force_refresh=(attempt == 1))
        try:
            resp = requests.request(
                method,
                f"{API_URL}{path}",
                headers={"Authorization": f"Bearer {token}"},
                json=json_body,
                timeout=HTTP_TIMEOUT_SECONDS,
            )
        except requests.RequestException:
            raise YnabError(502, "ynab_unreachable", "Could not reach YNAB")
        if resp.status_code != 401:
            break
        conn = _connection(sub)

    if resp.status_code == 401:
        _drop_connection(sub)
        raise YnabError(409, "ynab_reconnect_required", "Please reconnect YNAB")
    if resp.status_code == 429:
        raise YnabError(429, "ynab_rate_limited", "YNAB rate limit reached, try again later")
    if resp.status_code >= 400:
        print(f"[ynab] api error method={method} path={path.split('?')[0]} status={resp.status_code}")
        raise YnabError(502, "ynab_error", "YNAB rejected the request")
    try:
        return resp.json().get("data", {})
    except ValueError:
        raise YnabError(502, "ynab_bad_response", "Unexpected response from YNAB")


def _check_id(value: str, label: str) -> str:
    if not isinstance(value, str) or not _ID_RE.match(value):
        raise YnabError(400, "invalid_request", f"Invalid {label}")
    return value


def list_plans(sub: str) -> List[Dict[str, str]]:
    data = _api(sub, "GET", "/plans")
    plans = data.get("plans") or data.get("budgets") or []
    plans = sorted(plans, key=lambda p: p.get("last_modified_on") or "", reverse=True)
    return [{"id": p["id"], "name": p.get("name", "")} for p in plans]


def list_accounts(sub: str, plan_id: str) -> List[Dict[str, str]]:
    _check_id(plan_id, "planId")
    data = _api(sub, "GET", f"/plans/{plan_id}/accounts")
    accounts = [a for a in data.get("accounts", []) if not a.get("closed") and not a.get("deleted")]
    accounts.sort(key=lambda a: (a.get("name") or "").lower())
    return [{"id": a["id"], "name": a.get("name", ""), "type": a.get("type", "")} for a in accounts]


def save_settings(sub: str, plan_id: str, account_id: str) -> Dict[str, Any]:
    _check_id(plan_id, "planId")
    _check_id(account_id, "accountId")
    conn = _connection(sub)

    # Names come from YNAB, not from the client, and this proves the account
    # really belongs to the plan the user is allowed to see.
    plan = next((p for p in list_plans(sub) if p["id"] == plan_id), None)
    account = next((a for a in list_accounts(sub, plan_id) if a["id"] == account_id), None)
    if not plan or not account:
        raise YnabError(400, "invalid_request", "Plan or account not found in YNAB")

    conn = _connection(sub)  # tokens may have been refreshed by the calls above
    conn.update(planId=plan["id"], planName=plan["name"], accountId=account["id"], accountName=account["name"])
    _users_table().update_item(
        Key={"userId": sub},
        UpdateExpression="SET ynab = :c",
        ExpressionAttributeValues={":c": conn},
    )
    return status(sub)


def status(sub: str) -> Dict[str, Any]:
    conn = _get_user(sub).get("ynab")
    if not conn:
        return {"connected": False}
    return {
        "connected": True,
        "planId": conn.get("planId"),
        "planName": conn.get("planName"),
        "accountId": conn.get("accountId"),
        "accountName": conn.get("accountName"),
    }


def disconnect(sub: str) -> Dict[str, Any]:
    # YNAB has no token-revocation endpoint: users revoke access from
    # Account Settings > Authorized Apps. Deleting our copy is what we control.
    _drop_connection(sub)
    return {"connected": False}


# --------------------------------------------------------------------------
# Export
# --------------------------------------------------------------------------

def _to_milliunits(total: Any) -> Optional[int]:
    """Receipt total (str/Decimal/number, '.' or ',' decimals) -> outflow in milliunits."""
    try:
        value = Decimal(str(total).strip().replace(",", "."))
    except (InvalidOperation, AttributeError):
        return None
    if not value.is_finite() or value == 0:
        return None
    milliunits = int((value * 1000).quantize(Decimal(1), rounding=ROUND_HALF_UP))
    return -milliunits if milliunits else None


def _build_transaction(receipt: Dict[str, Any], account_id: str) -> Any:
    """Returns (transaction, None) or (None, reason)."""
    amount = _to_milliunits(receipt.get("total"))
    if amount is None:
        return None, "invalid_amount"
    try:
        date = dt.date.fromisoformat(str(receipt.get("date") or "")[:10]).isoformat()
    except ValueError:
        return None, "invalid_date"

    payee = str(receipt.get("payee") or "").strip() or "Unknown merchant"
    return (
        {
            "account_id": account_id,
            "date": date,
            "amount": amount,
            "payee_name": payee[:200],
            "memo": "Export Spendify",
            "cleared": "cleared",
            "approved": True,
            # A receipt id is a uuid4 (36 chars, YNAB's import_id limit). Sending
            # it twice is rejected by YNAB as a duplicate instead of creating a
            # second transaction, which makes retries safe.
            "import_id": str(receipt["receiptId"])[:36],
        },
        None,
    )


def export_receipts(sub: str, receipt_ids: List[str]) -> Dict[str, Any]:
    conn = _connection(sub)
    plan_id, account_id = conn.get("planId"), conn.get("accountId")
    if not plan_id or not account_id:
        raise YnabError(409, "ynab_not_configured", "Choose a YNAB plan and account first")

    ids = list(dict.fromkeys(str(r) for r in receipt_ids or []))
    if not ids:
        raise YnabError(400, "invalid_request", "No receipts selected")
    if len(ids) > EXPORT_MAX_RECEIPTS:
        raise YnabError(400, "too_many_receipts", f"At most {EXPORT_MAX_RECEIPTS} receipts per export")

    skipped: List[Dict[str, str]] = []
    pending: List[Dict[str, Any]] = []
    table = _receipts_table()
    for rid in ids:
        item = table.get_item(Key={"PK": f"USER#{sub}", "SK": f"RECEIPT#{rid}"}).get("Item")
        if not item:
            skipped.append({"receiptId": rid, "reason": "not_found"})
            continue
        if item.get("ynab_exported_at"):
            skipped.append({"receiptId": rid, "reason": "already_exported"})
            continue
        tx, reason = _build_transaction({**item, "receiptId": rid}, account_id)
        if reason:
            skipped.append({"receiptId": rid, "reason": reason})
        else:
            pending.append(tx)

    created: List[str] = []
    duplicates: List[str] = []
    failed: List[Dict[str, str]] = []
    last_error: Optional[YnabError] = None

    for i in range(0, len(pending), EXPORT_BATCH_SIZE):
        batch = pending[i : i + EXPORT_BATCH_SIZE]
        try:
            data = _api(sub, "POST", f"/plans/{plan_id}/transactions", {"transactions": batch})
        except YnabError as e:
            last_error = e
            failed.extend({"receiptId": t["import_id"], "reason": e.code} for t in batch)
            if e.code in ("ynab_reconnect_required", "ynab_rate_limited"):
                # Later batches would fail the same way.
                failed.extend(
                    {"receiptId": t["import_id"], "reason": e.code}
                    for t in pending[i + EXPORT_BATCH_SIZE :]
                )
                break
            continue
        dup = set(data.get("duplicate_import_ids") or [])
        for t in batch:
            (duplicates if t["import_id"] in dup else created).append(t["import_id"])

    if not created and not duplicates and last_error:
        raise last_error

    exported_at = dt.datetime.now(dt.timezone.utc).replace(microsecond=0).isoformat()
    for rid in created + duplicates:
        table.update_item(
            Key={"PK": f"USER#{sub}", "SK": f"RECEIPT#{rid}"},
            UpdateExpression="SET ynab_exported_at = :t",
            ExpressionAttributeValues={":t": exported_at},
        )

    return {
        "created": len(created),
        "duplicates": len(duplicates),
        "skipped": skipped,
        "failed": failed,
        "exportedAt": exported_at,
        "exportedIds": created + duplicates,
    }
