"""
Offline tests for the YNAB OAuth flow and server-side export (src/api/ynab.py).

YNAB rejected the app for asking users for a Personal Access Token. These
tests pin the properties the replacement has to keep:
  - PKCE + single-use `state`, redirect URI built server-side
  - tokens never stored in clear, and bound to the user that owns them
  - a transient YNAB outage must not wipe a user's connection, a real
    revocation must
  - export is idempotent (import_id) and reports what it skipped

DynamoDB, KMS, SSM and the HTTP calls to YNAB are replaced with stubs: no AWS
credentials and no network access needed.

Usage:
    python3 -m pip install boto3 requests
    python3 test/test_ynab.py
"""

import base64
import hashlib
import json
import os
import sys
from urllib.parse import parse_qs, urlparse

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(REPO_ROOT, "src", "api"))

os.environ.update(
    USERS_TABLE="test-users",
    RECEIPTS_TABLE="test-receipts",
    APP_BASE_URL="https://app.spendifyapp.com",
    CORS_ORIGINS="https://app.spendifyapp.com",
    YNAB_KMS_KEY_ID="test-key",
    YNAB_CLIENT_ID_PARAM="/p/client_id",
    YNAB_CLIENT_SECRET_PARAM="/p/client_secret",
    UPLOADS_BUCKET="test-uploads",
    AWS_DEFAULT_REGION="eu-central-1",
)

from botocore.exceptions import ClientError  # noqa: E402

import ynab  # noqa: E402

SUB = "user-1"
OTHER = "user-2"
PLAN = "11111111-1111-4111-8111-111111111111"
ACCOUNT = "22222222-2222-4222-8222-222222222222"
SECRET = "the-client-secret"


# ------------------------------------------------------------------ fakes

def _client_error(code):
    return ClientError({"Error": {"Code": code}}, "op")


class FakeUsers:
    def __init__(self):
        self.items = {}

    def get_item(self, Key):
        item = self.items.get(Key["userId"])
        return {"Item": json.loads(json.dumps(item)) if item else None} if item else {}

    def update_item(self, Key, UpdateExpression, ExpressionAttributeValues=None, ConditionExpression=None):
        item = self.items.setdefault(Key["userId"], {"userId": Key["userId"]})
        values = ExpressionAttributeValues or {}
        if ConditionExpression == "ynab.refreshTokenEnc = :old":
            if (item.get("ynab") or {}).get("refreshTokenEnc") != values[":old"]:
                raise _client_error("ConditionalCheckFailedException")
        expr = UpdateExpression.strip()
        if expr.startswith("SET "):
            name, ref = [x.strip() for x in expr[4:].split("=")]
            item[name] = json.loads(json.dumps(values[ref]))
        elif expr.startswith("REMOVE "):
            for name in expr[7:].split(","):
                item.pop(name.strip(), None)
        else:
            raise AssertionError(f"unsupported expression {expr}")
        return {}


class FakeReceipts:
    def __init__(self):
        self.items = {}
        self.updates = []

    def add(self, sub, rid, **fields):
        self.items[(f"USER#{sub}", f"RECEIPT#{rid}")] = {"PK": f"USER#{sub}", "SK": f"RECEIPT#{rid}", **fields}

    def get_item(self, Key):
        item = self.items.get((Key["PK"], Key["SK"]))
        return {"Item": dict(item)} if item else {}

    def update_item(self, Key, UpdateExpression, ExpressionAttributeValues):
        assert UpdateExpression == "SET ynab_exported_at = :t"
        self.items[(Key["PK"], Key["SK"])]["ynab_exported_at"] = ExpressionAttributeValues[":t"]
        self.updates.append(Key["SK"])


class FakeDdb:
    def __init__(self, users, receipts):
        self.tables = {"test-users": users, "test-receipts": receipts}

    def Table(self, name):
        return self.tables[name]


class FakeKms:
    """Ciphertext embeds the encryption context, so decrypting for another user fails."""

    def encrypt(self, KeyId, Plaintext, EncryptionContext):
        blob = json.dumps({"ctx": EncryptionContext, "pt": Plaintext.decode()}).encode()
        return {"CiphertextBlob": b"ENC:" + blob}

    def decrypt(self, KeyId, CiphertextBlob, EncryptionContext):
        assert CiphertextBlob.startswith(b"ENC:")
        data = json.loads(CiphertextBlob[4:])
        if data["ctx"] != EncryptionContext:
            raise _client_error("InvalidCiphertextException")
        return {"Plaintext": data["pt"].encode()}


class Resp:
    def __init__(self, status, body=None):
        self.status_code = status
        self._body = body

    def json(self):
        if self._body is None:
            raise ValueError("no json")
        return self._body


class Http:
    """Scripted responses; records every call."""

    def __init__(self):
        self.token_calls = []
        self.api_calls = []
        self.token_responses = []
        self.api_handler = None

    def post(self, url, data=None, timeout=None):
        assert url == ynab.TOKEN_URL
        self.token_calls.append(dict(data))
        return self.token_responses.pop(0)

    def request(self, method, url, headers=None, json=None, timeout=None):
        self.api_calls.append({"method": method, "url": url, "auth": headers["Authorization"], "json": json})
        return self.api_handler(method, url, headers, json)


def tokens(n, expires_in=7200):
    return Resp(200, {"access_token": f"access-{n}", "refresh_token": f"refresh-{n}", "expires_in": expires_in})


users = receipts = http = None
now = [1_000_000]


def setup():
    global users, receipts, http
    users, receipts, http = FakeUsers(), FakeReceipts(), Http()
    users.items[SUB] = {"userId": SUB, "email": "a@example.com"}
    users.items[OTHER] = {"userId": OTHER, "email": "b@example.com"}
    ynab._ddb = lambda: FakeDdb(users, receipts)
    ynab._kms = lambda: FakeKms()
    ynab.get_param = lambda name, decrypt=False: {"/p/client_id": "cid", "/p/client_secret": SECRET}[name]
    ynab.requests.post = http.post
    ynab.requests.request = http.request
    ynab._now = lambda: now[0]


def expect_error(code, fn, *args):
    try:
        fn(*args)
    except ynab.YnabError as e:
        assert e.code == code, f"expected {code}, got {e.code}"
        return e
    raise AssertionError(f"expected YnabError {code}, nothing raised")


def connect(expires_in=7200):
    """Runs the full happy-path authorization for SUB."""
    url = ynab.start_authorization(SUB)["authorizeUrl"]
    state = parse_qs(urlparse(url).query)["state"][0]
    http.token_responses.append(tokens(1, expires_in))
    ynab.complete_authorization(SUB, "auth-code", state)


def configured():
    connect()
    users.items[SUB]["ynab"].update(planId=PLAN, planName="Plan", accountId=ACCOUNT, accountName="Cash")


# ------------------------------------------------------------------ tests

def test_authorize_url_uses_pkce_and_server_side_redirect():
    setup()
    url = ynab.start_authorization(SUB)["authorizeUrl"]
    parsed = urlparse(url)
    q = {k: v[0] for k, v in parse_qs(parsed.query).items()}
    assert f"{parsed.scheme}://{parsed.netloc}{parsed.path}" == ynab.AUTHORIZE_URL
    assert q["client_id"] == "cid"
    assert q["redirect_uri"] == "https://app.spendifyapp.com/ynab/callback"
    assert q["response_type"] == "code"
    assert q["code_challenge_method"] == "S256"
    assert "scope" not in q, "creating transactions needs write access"
    verifier = users.items[SUB]["ynabPending"]["verifier"]
    expected = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).rstrip(b"=").decode()
    assert q["code_challenge"] == expected
    assert q["state"] == users.items[SUB]["ynabPending"]["state"]
    assert SECRET not in url


def test_callback_rejects_wrong_state_and_burns_the_attempt():
    setup()
    url = ynab.start_authorization(SUB)["authorizeUrl"]
    good_state = parse_qs(urlparse(url).query)["state"][0]
    expect_error("invalid_state", ynab.complete_authorization, SUB, "code", "not-the-state")
    assert not http.token_calls, "must not call YNAB with an unverified state"
    http.token_responses.append(tokens(1))
    expect_error("invalid_state", ynab.complete_authorization, SUB, "code", good_state)
    assert not http.token_calls


def test_callback_rejects_state_issued_to_another_user():
    setup()
    url = ynab.start_authorization(SUB)["authorizeUrl"]
    state = parse_qs(urlparse(url).query)["state"][0]
    expect_error("invalid_state", ynab.complete_authorization, OTHER, "code", state)


def test_callback_rejects_expired_authorization():
    setup()
    url = ynab.start_authorization(SUB)["authorizeUrl"]
    state = parse_qs(urlparse(url).query)["state"][0]
    now[0] += ynab.PENDING_TTL_SECONDS + 1
    expect_error("invalid_state", ynab.complete_authorization, SUB, "code", state)
    now[0] = 1_000_000


def test_tokens_are_exchanged_with_verifier_and_stored_encrypted():
    setup()
    connect()
    call = http.token_calls[0]
    assert call["grant_type"] == "authorization_code" and call["code"] == "auth-code"
    assert call["client_secret"] == SECRET
    assert call["code_verifier"]
    assert call["redirect_uri"] == "https://app.spendifyapp.com/ynab/callback"
    stored = json.dumps(users.items[SUB])
    for plain in ("access-1", "refresh-1"):
        assert f'"{plain}"' not in stored, f"{plain} stored in clear"
    assert "ynabPending" not in users.items[SUB]
    assert ynab.status(SUB)["connected"] is True


def test_encrypted_token_cannot_be_read_for_another_user():
    setup()
    connect()
    blob = users.items[SUB]["ynab"]["refreshTokenEnc"]
    try:
        ynab._decrypt(OTHER, blob)
    except ClientError:
        return
    raise AssertionError("token decrypted under a different user id")


def test_expired_access_token_is_refreshed_before_the_call():
    setup()
    connect(expires_in=60)  # inside the refresh skew: already unusable
    http.token_responses.append(tokens(2))
    http.api_handler = lambda *a: Resp(200, {"data": {"plans": []}})
    ynab.list_plans(SUB)
    assert http.token_calls[-1]["grant_type"] == "refresh_token"
    assert http.token_calls[-1]["refresh_token"] == "refresh-1"
    assert http.api_calls[0]["auth"] == "Bearer access-2"
    assert ynab._decrypt(SUB, users.items[SUB]["ynab"]["refreshTokenEnc"]) == "refresh-2"


def test_revoked_grant_disconnects_but_a_ynab_outage_does_not():
    setup()
    connect(expires_in=60)
    http.token_responses.append(Resp(503, {}))
    expect_error("ynab_unavailable", ynab.list_plans, SUB)
    assert "ynab" in users.items[SUB], "a 503 from YNAB must not wipe the connection"

    http.token_responses.append(Resp(400, {"error": "invalid_grant"}))
    expect_error("ynab_reconnect_required", ynab.list_plans, SUB)
    assert "ynab" not in users.items[SUB]


def test_401_from_api_triggers_one_refresh_and_a_retry():
    setup()
    connect()
    http.token_responses.append(tokens(2))
    seen = []

    def handler(method, url, headers, body):
        seen.append(headers["Authorization"])
        return Resp(401, {}) if len(seen) == 1 else Resp(200, {"data": {"plans": []}})

    http.api_handler = handler
    ynab.list_plans(SUB)
    assert seen == ["Bearer access-1", "Bearer access-2"]


def test_settings_reject_an_account_that_is_not_in_the_plan():
    setup()
    connect()

    def handler(method, url, headers, body):
        if url.endswith("/plans"):
            return Resp(200, {"data": {"plans": [{"id": PLAN, "name": "Plan"}]}})
        return Resp(200, {"data": {"accounts": [{"id": ACCOUNT, "name": "Cash", "type": "cash"}]}})

    http.api_handler = handler
    other = "33333333-3333-4333-8333-333333333333"
    expect_error("invalid_request", ynab.save_settings, SUB, PLAN, other)
    expect_error("invalid_request", ynab.save_settings, SUB, "../../etc", ACCOUNT)
    out = ynab.save_settings(SUB, PLAN, ACCOUNT)
    assert out["planName"] == "Plan" and out["accountName"] == "Cash"


def test_closed_accounts_are_not_offered():
    setup()
    connect()
    http.api_handler = lambda *a: Resp(200, {"data": {"accounts": [
        {"id": ACCOUNT, "name": "Open", "type": "cash"},
        {"id": "x" * 36, "name": "Closed", "type": "cash", "closed": True},
    ]}})
    names = [a["name"] for a in ynab.list_accounts(SUB, PLAN)]
    assert names == ["Open"]


def _ok_post(created_status=200, duplicates=()):
    def handler(method, url, headers, body):
        assert method == "POST" and url.endswith(f"/plans/{PLAN}/transactions")
        return Resp(created_status, {"data": {"transaction_ids": ["t"], "duplicate_import_ids": list(duplicates)}})
    return handler


def test_export_builds_the_transaction_and_marks_the_receipt():
    setup()
    configured()
    rid = "aaaaaaaa-0000-4000-8000-000000000001"
    receipts.add(SUB, rid, date="2026-03-04", payee="Bar Roma", total="12,50")
    http.api_handler = _ok_post()

    out = ynab.export_receipts(SUB, [rid])

    tx = http.api_calls[0]["json"]["transactions"][0]
    assert tx == {
        "account_id": ACCOUNT, "date": "2026-03-04", "amount": -12500, "payee_name": "Bar Roma",
        "memo": "Export Spendify", "cleared": "cleared", "approved": True, "import_id": rid,
    }
    assert "category_id" not in tx, "categories must never be sent to YNAB"
    assert out["created"] == 1 and out["skipped"] == [] and out["failed"] == []
    assert receipts.items[(f"USER#{SUB}", f"RECEIPT#{rid}")]["ynab_exported_at"] == out["exportedAt"]


def test_export_reports_what_it_skips_and_never_sends_it():
    setup()
    configured()
    good = "aaaaaaaa-0000-4000-8000-000000000001"
    receipts.add(SUB, good, date="2026-03-04", payee="OK", total="5.00")
    receipts.add(SUB, "bad-amount", date="2026-03-04", payee="X", total="abc")
    receipts.add(SUB, "zero", date="2026-03-04", payee="X", total="0.0004")
    receipts.add(SUB, "bad-date", date="", payee="X", total="5")
    receipts.add(SUB, "done", date="2026-03-04", payee="X", total="5", ynab_exported_at="2026-03-05T00:00:00+00:00")
    receipts.add(OTHER, "someone-elses", date="2026-03-04", payee="X", total="5")
    http.api_handler = _ok_post()

    out = ynab.export_receipts(SUB, [good, "bad-amount", "zero", "bad-date", "done", "someone-elses", "missing"])

    reasons = {s["receiptId"]: s["reason"] for s in out["skipped"]}
    assert reasons == {
        "bad-amount": "invalid_amount", "zero": "invalid_amount", "bad-date": "invalid_date",
        "done": "already_exported", "someone-elses": "not_found", "missing": "not_found",
    }
    sent = [t["import_id"] for c in http.api_calls for t in c["json"]["transactions"]]
    assert sent == [good]


def test_export_treats_a_duplicate_import_id_as_already_there():
    setup()
    configured()
    rid = "aaaaaaaa-0000-4000-8000-000000000001"
    receipts.add(SUB, rid, date="2026-03-04", payee="OK", total="5.00")
    http.api_handler = _ok_post(duplicates=[rid])
    out = ynab.export_receipts(SUB, [rid])
    assert out["created"] == 0 and out["duplicates"] == 1
    assert "ynab_exported_at" in receipts.items[(f"USER#{SUB}", f"RECEIPT#{rid}")], "a retry must converge, not loop"


def test_export_batches_and_survives_a_failed_batch():
    setup()
    configured()
    ids = [f"{i:08d}-0000-4000-8000-000000000000" for i in range(150)]
    for rid in ids:
        receipts.add(SUB, rid, date="2026-03-04", payee="M", total="1.00")
    calls = []

    def handler(method, url, headers, body):
        calls.append(len(body["transactions"]))
        return Resp(200, {"data": {}}) if len(calls) == 1 else Resp(400, {"error": {"detail": "bad"}})

    http.api_handler = handler
    out = ynab.export_receipts(SUB, ids)
    assert calls == [100, 50]
    assert out["created"] == 100
    assert len(out["failed"]) == 50 and out["failed"][0]["reason"] == "ynab_error"
    assert len(receipts.updates) == 100, "only the receipts YNAB accepted are marked as exported"


def test_export_raises_when_everything_fails():
    setup()
    configured()
    rid = "aaaaaaaa-0000-4000-8000-000000000001"
    receipts.add(SUB, rid, date="2026-03-04", payee="OK", total="5.00")
    http.api_handler = lambda *a: Resp(429, {})
    expect_error("ynab_rate_limited", ynab.export_receipts, SUB, [rid])
    assert not receipts.updates


def test_export_preconditions():
    setup()
    expect_error("ynab_not_connected", ynab.export_receipts, SUB, ["x"])
    connect()
    expect_error("ynab_not_configured", ynab.export_receipts, SUB, ["x"])
    users.items[SUB]["ynab"].update(planId=PLAN, accountId=ACCOUNT)
    expect_error("invalid_request", ynab.export_receipts, SUB, [])
    expect_error("too_many_receipts", ynab.export_receipts, SUB, [str(i) for i in range(ynab.EXPORT_MAX_RECEIPTS + 1)])


def test_disconnect_removes_every_trace_of_the_tokens():
    setup()
    configured()
    ynab.disconnect(SUB)
    assert "ynab" not in users.items[SUB] and "ynabPending" not in users.items[SUB]
    assert ynab.status(SUB) == {"connected": False}


def test_reconnect_is_not_a_401_because_the_frontend_would_log_the_user_out():
    setup()
    connect(expires_in=60)
    http.token_responses.append(Resp(400, {"error": "invalid_grant"}))
    e = expect_error("ynab_reconnect_required", ynab.list_plans, SUB)
    assert e.status not in (401, 403), "apiRequest() treats 401/403 as an expired app session"


def test_route_maps_errors_and_requires_authentication():
    setup()
    import app

    def event(path, method, sub=SUB, body=None):
        claims = {"sub": sub} if sub else {}
        return {
            "rawPath": path,
            "headers": {"origin": "https://app.spendifyapp.com"},
            "body": json.dumps(body) if body is not None else None,
            "requestContext": {"http": {"method": method}, "authorizer": {"jwt": {"claims": claims}}},
        }

    assert app.handler(event("/ynab/status", "GET", sub=None), None)["statusCode"] == 401
    res = app.handler(event("/ynab/export", "POST", body={"receiptIds": ["x"]}), None)
    assert res["statusCode"] == 409 and json.loads(res["body"])["error"] == "ynab_not_connected"
    res = app.handler(event("/ynab/status", "GET"), None)
    assert res["statusCode"] == 200 and json.loads(res["body"]) == {"connected": False}
    assert app.handler(event("/ynab/nope", "GET"), None)["statusCode"] == 404


if __name__ == "__main__":
    tests = [(n, f) for n, f in sorted(globals().items()) if n.startswith("test_") and callable(f)]
    failures = 0
    for name, fn in tests:
        try:
            fn()
            print(f"ok    {name}")
        except Exception as exc:  # noqa: BLE001
            failures += 1
            print(f"FAIL  {name}: {type(exc).__name__}: {exc}")
    print(f"\n{len(tests) - failures}/{len(tests)} passed")
    sys.exit(1 if failures else 0)
