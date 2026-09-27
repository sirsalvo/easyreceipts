"""
Offline test for the free-tier quota (src/api/entitlements.py).

Replaces the old model (14-day trial, then hard-blocked on a dead route,
/exports/, that nothing ever calls) with a monthly quota enforced on the one
endpoint that actually costs money: POST /receipts, which hands out the
presigned upload URL before Textract ever runs.

DynamoDB is replaced with a stub that reproduces the one property the fix
depends on: the increment and the limit check happen as a single atomic
operation, so a request can never be counted past the limit.

Usage:
    python3 -m pip install boto3
    python3 test/test_entitlements.py
"""
import os
import sys

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(REPO_ROOT, "src", "api"))

os.environ.update(
    USERS_TABLE="test-users",
    USAGE_TABLE="test-usage",
    FREE_TIER_MONTHLY_LIMIT="5",
    AWS_DEFAULT_REGION="eu-central-1",
)

from botocore.exceptions import ClientError  # noqa: E402

import entitlements  # noqa: E402

SUB = "user-1"
OTHER = "user-2"


class FakeUsersTable:
    def __init__(self):
        self.rows = {}

    def get_item(self, Key):
        row = self.rows.get(Key["userId"])
        return {"Item": dict(row)} if row else {}

    def put_item(self, Item, ConditionExpression=None):
        if Item["userId"] in self.rows:
            raise ClientError({"Error": {"Code": "ConditionalCheckFailedException"}}, "PutItem")
        self.rows[Item["userId"]] = dict(Item)

    def update_item(self, Key, UpdateExpression, ExpressionAttributeNames, ExpressionAttributeValues):
        row = self.rows.setdefault(Key["userId"], {})
        row[ExpressionAttributeNames["#s"]] = ExpressionAttributeValues[":s"]
        row["updatedAt"] = ExpressionAttributeValues[":u"]


class FakeUsageTable:
    """A single-process stand-in for DynamoDB's atomic conditional update_item."""

    def __init__(self):
        self.rows = {}

    def get_item(self, Key):
        row = self.rows.get((Key["PK"], Key["SK"]))
        return {"Item": dict(row)} if row else {}

    def update_item(self, Key, UpdateExpression, ConditionExpression, ExpressionAttributeNames,
                     ExpressionAttributeValues, ReturnValues=None):
        assert UpdateExpression == "SET #c = if_not_exists(#c, :zero) + :one, updatedAt = :u"
        assert ConditionExpression == "attribute_not_exists(#c) OR #c < :limit"
        k = (Key["PK"], Key["SK"])
        row = self.rows.get(k, {})
        current = row.get("count", ExpressionAttributeValues[":zero"])
        if current >= ExpressionAttributeValues[":limit"]:
            raise ClientError({"Error": {"Code": "ConditionalCheckFailedException"}}, "UpdateItem")
        row["count"] = current + ExpressionAttributeValues[":one"]
        row["updatedAt"] = ExpressionAttributeValues[":u"]
        self.rows[k] = row
        return {"Attributes": dict(row)}


users = usage = None


def setup(now=1_700_000_000):
    global users, usage
    users, usage = FakeUsersTable(), FakeUsageTable()
    entitlements._users_table = lambda: users
    entitlements._usage_table = lambda: usage
    entitlements._now = lambda: now


def json_fn(status, body, origin):
    return status, body


def event(sub=SUB, email="a@example.com", method="POST", path="/receipts"):
    claims = {"sub": sub, "email": email} if sub else {}
    return {
        "requestContext": {"http": {"method": method}, "authorizer": {"jwt": {"claims": claims}}},
        "rawPath": path,
    }


def test_is_metered_endpoint_matches_only_receipt_creation():
    assert entitlements.is_metered_endpoint("POST", "/receipts")
    for method, path in [("GET", "/receipts"), ("PUT", "/receipts/x"), ("DELETE", "/receipts/x"),
                          ("GET", "/exports/x"), ("POST", "/exports/x"), ("POST", "/ynab/export"),
                          ("GET", "/me"), ("POST", "/categories")]:
        assert not entitlements.is_metered_endpoint(method, path), (method, path)


def test_a_new_user_can_use_exactly_the_limit_then_is_blocked():
    setup()
    for i in range(1, 6):
        r = entitlements.consume_quota(SUB)
        assert r["allowed"] and r["used"] == i, r
    r = entitlements.consume_quota(SUB)
    assert not r["allowed"] and r["used"] == 5 and r["remaining"] == 0


def test_get_usage_does_not_consume_the_quota():
    setup()
    for _ in range(3):
        entitlements.consume_quota(SUB)
    before = entitlements.get_usage(SUB)
    after = entitlements.get_usage(SUB)
    assert before == after == {
        "limit": 5, "used": 3, "remaining": 2,
        "period": entitlements._current_period(), "resetsAt": entitlements._period_ends_at(entitlements._current_period()),
    }


def test_quota_is_isolated_per_user():
    setup()
    for _ in range(5):
        assert entitlements.consume_quota(SUB)["allowed"]
    assert entitlements.consume_quota(SUB)["allowed"] is False
    assert entitlements.consume_quota(OTHER)["allowed"] is True, "one user's quota must not affect another's"


def test_quota_resets_on_a_new_calendar_month():
    setup(now=1_735_689_540)  # 2024-12-31 23:59:00 UTC
    assert entitlements._current_period() == "2024-12"
    for _ in range(5):
        assert entitlements.consume_quota(SUB)["allowed"]
    assert entitlements.consume_quota(SUB)["allowed"] is False

    entitlements._now = lambda: 1_735_689_540 + 3600  # 2025-01-01 00:59 UTC
    assert entitlements._current_period() == "2025-01"
    r = entitlements.consume_quota(SUB)
    assert r["allowed"] and r["used"] == 1, "a new month must start a fresh counter"


def test_resets_at_is_midnight_utc_on_the_1st_of_next_month():
    assert entitlements._period_ends_at("2026-09") == "2026-10-01T00:00:00+00:00"
    assert entitlements._period_ends_at("2026-12") == "2027-01-01T00:00:00+00:00"


def test_guard_lets_an_active_subscriber_through_regardless_of_usage():
    setup()
    users.rows[SUB] = {"userId": SUB, "status": entitlements.STATUS_ACTIVE, "createdAt": 0, "trialStartedAt": 0}
    for _ in range(10):
        assert entitlements.entitlement_guard(event(), "https://x", json_fn) is None
    assert usage.rows == {}, "an active user's usage must not even be tracked"


def test_guard_blocks_with_402_not_401_or_403_once_the_quota_is_used():
    setup()
    for _ in range(5):
        assert entitlements.entitlement_guard(event(), "https://x", json_fn) is None
    status, body = entitlements.entitlement_guard(event(), "https://x", json_fn)
    # apiRequest() in the frontend treats 401/403 as an expired session and
    # logs the user out - the wrong outcome for "you're out of free receipts".
    assert status == 402, status
    assert body["error"] == "QUOTA_EXCEEDED" and body["limit"] == 5 and body["used"] == 5
    assert "resetsAt" in body


def test_guard_requires_authentication():
    setup()
    status, body = entitlements.entitlement_guard(event(sub=None), "https://x", json_fn)
    assert status == 401 and body["error"] == "UNAUTHORIZED"


def test_guard_does_not_touch_unmetered_endpoints_even_over_quota():
    setup()
    for _ in range(5):
        entitlements.consume_quota(SUB)
    assert entitlements.entitlement_guard(event(method="GET", path="/receipts"), "https://x", json_fn) is None
    assert entitlements.entitlement_guard(event(method="GET", path="/me"), "https://x", json_fn) is None


def test_trial_still_expires_for_display_but_no_longer_blocks():
    setup(now=1_700_000_000)
    user = entitlements.get_or_create_user(SUB, "a@example.com")
    assert user["status"] == entitlements.STATUS_TRIAL and not user["_computed"]["expired"]

    entitlements._now = lambda: 1_700_000_000 + 15 * 86400  # past TRIAL_DAYS=14
    user = entitlements.get_or_create_user(SUB, "a@example.com")
    assert user["status"] == entitlements.STATUS_EXPIRED and user["_computed"]["expired"]

    # An "expired" user still gets the free tier, exactly like a fresh trial user.
    for _ in range(5):
        assert entitlements.entitlement_guard(event(), "https://x", json_fn) is None
    assert entitlements.entitlement_guard(event(), "https://x", json_fn)[0] == 402


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
