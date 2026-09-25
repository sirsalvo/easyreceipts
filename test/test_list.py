"""
Regression test for GET /receipts pagination (_list_receipts).

Guards the bug fixed in 1214c98: the endpoint read a single DynamoDB page
with Limit=50 and discarded the rest. Because the table's sort key is
RECEIPT#<uuid4>, that page was not even the 50 newest receipts - it was 50
arbitrary ones. In production the main account had 155 receipts and the API
returned 50, so 105 were invisible in the app and missing from every export.

Runs fully offline: DynamoDB and S3 are replaced with stubs, so no AWS
credentials and no network access are needed.

Usage:
    python3 -m pip install boto3      # only dependency (for botocore exceptions)
    python3 test/test_list.py
"""

import datetime as dt
import json
import os
import sys
from decimal import Decimal

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(REPO_ROOT, "src", "api"))

os.environ.update(
    RECEIPTS_TABLE="test-receipts",
    UPLOADS_BUCKET="test-uploads",
    CORS_ORIGINS="https://app.spendifyapp.com",
)

import boto3  # noqa: E402
from botocore.exceptions import ClientError  # noqa: E402

ORIGIN = "https://app.spendifyapp.com"
SUB = "00000000-0000-0000-0000-000000000001"

# How many receipts the fixture user owns. Deliberately well above the old
# hard-coded Limit=50, so a regression to single-page reads fails loudly.
RECEIPT_COUNT = 156


def _build_receipts():
    """
    Synthetic receipts shaped like the real production rows.

    Mirrors the traits that made the original bug possible and that the fix
    has to cope with:
      - SK is RECEIPT#<uuid-like>, unrelated to chronological order, so the
        table cannot sort by date and the Lambda must
      - date order deliberately disagrees with SK order
      - totals stored as strings, as _update_receipt writes them
      - a few unconfirmed rows with no payee/date/total, which are the only
        ones allowed to trigger the S3 OCR fallback
    """
    items = []
    for i in range(RECEIPT_COUNT):
        # Reverse the date sequence relative to the id, so any implementation
        # that leans on key order instead of sorting produces wrong output.
        day = dt.date(2026, 1, 1) + dt.timedelta(days=RECEIPT_COUNT - i)
        created = f"2026-01-01T{i % 24:02d}:00:00+00:00"
        rid = f"{i:08d}-0000-4000-8000-{i:012d}"

        item = {
            "PK": f"USER#{SUB}",
            "SK": f"RECEIPT#{rid}",
            "receiptId": rid,
            "createdAt": created,
            "s3Key": f"original/{SUB}/{rid}",
        }

        if i < 3:
            # Draft with nothing extracted yet: eligible for OCR fallback.
            item["status"] = "NEW"
        else:
            item.update(
                status="CONFIRMED",
                confirmedAt=created,
                date=day.isoformat(),
                payee=f"Merchant {i:03d}",
                total=f"{10 + i}.50",
                vat="2.00",
                vatRate="22",
            )
        items.append(item)
    return items


RECEIPTS = _build_receipts()

calls = {"query": 0, "s3_get": 0, "s3_head": 0, "update": 0}


class FakeTable:
    """Minimal DynamoDB table honouring pagination via LastEvaluatedKey."""

    def __init__(self, page_size):
        self.page_size = page_size

    def query(self, **kwargs):
        calls["query"] += 1
        rows = sorted(RECEIPTS, key=lambda r: r["SK"])

        start = 0
        if "ExclusiveStartKey" in kwargs:
            last_sk = kwargs["ExclusiveStartKey"]["SK"]
            start = next(n for n, r in enumerate(rows) if r["SK"] == last_sk) + 1

        chunk = rows[start:start + self.page_size]
        result = {"Items": chunk}
        if chunk and start + self.page_size < len(rows):
            result["LastEvaluatedKey"] = {"PK": chunk[-1]["PK"], "SK": chunk[-1]["SK"]}
        return result

    def update_item(self, **kwargs):
        calls["update"] += 1
        return {"Attributes": {}}


class FakeDynamoResource:
    def __init__(self, page_size):
        self.page_size = page_size

    def Table(self, _name):
        return FakeTable(self.page_size)


class FakeS3:
    """Every object is missing, so the fallback path is exercised but cheap."""

    def head_object(self, **kwargs):
        calls["s3_head"] += 1
        raise ClientError({"Error": {"Code": "404"}}, "HeadObject")

    def get_object(self, **kwargs):
        calls["s3_get"] += 1
        raise ClientError({"Error": {"Code": "NoSuchKey"}}, "GetObject")

    def generate_presigned_url(self, **kwargs):
        return "https://example.invalid/presigned"


def call_list(page_size, max_items=None):
    """Import app.py against the stubs and invoke _list_receipts once."""
    for key in calls:
        calls[key] = 0

    boto3.resource = lambda *a, **k: FakeDynamoResource(page_size)
    boto3.client = lambda *a, **k: FakeS3()
    sys.modules.pop("app", None)

    import app

    if max_items is not None:
        app.LIST_MAX_ITEMS = max_items

    event = {
        "version": "2.0",
        "rawPath": "/receipts",
        "headers": {"origin": ORIGIN},
        "requestContext": {
            "http": {"method": "GET"},
            "authorizer": {"jwt": {"claims": {"sub": SUB}}},
        },
    }
    response = app._list_receipts(event, ORIGIN)
    return response, json.loads(response["body"])


failures = []


def check(label, condition, detail=""):
    status = "PASS" if condition else "FAIL"
    if not condition:
        failures.append(label)
    print(f"  [{status}] {label}{(' ' + detail) if detail else ''}")


def main():
    print(f"Fixture: {RECEIPT_COUNT} receipts for one user\n")

    print("A) DynamoDB paginates at 50 per page (the old hard-coded limit)")
    _, body = call_list(page_size=50)
    check("returns every receipt", body["count"] == RECEIPT_COUNT,
          f"-> {body['count']}/{RECEIPT_COUNT}")
    check("followed LastEvaluatedKey", calls["query"] > 1,
          f"-> {calls['query']} queries")
    check("not flagged as truncated", body["truncated"] is False)

    print("\nB) Whole partition fits in one page")
    _, body = call_list(page_size=1000)
    check("returns every receipt", body["count"] == RECEIPT_COUNT,
          f"-> {body['count']}/{RECEIPT_COUNT}")
    check("single query", calls["query"] == 1)

    print("\nC) Ordering is by date, newest first")
    dates = [i["date"] for i in body["items"] if i.get("date")]
    check("dates descending", dates == sorted(dates, reverse=True),
          f"-> {dates[0]} .. {dates[-1]}")
    check("undated receipts sort last",
          all(i.get("date") for i in body["items"][:len(dates)]))
    check("ignores key order", body["items"][0]["receiptId"] != sorted(
        i["receiptId"] for i in body["items"])[0])

    print("\nD) S3 is only touched when a receipt really needs it")
    check("no head_object calls", calls["s3_head"] == 0, f"-> {calls['s3_head']}")
    check("one get_object per eligible draft only", calls["s3_get"] == 3,
          f"-> {calls['s3_get']} (3 drafts without fields)")

    print("\nE) Response shape stays compatible with the frontend")
    response, body = call_list(page_size=1000)
    check("'items' key present", "items" in body)
    check("every item carries receiptId",
          all(i.get("receiptId") for i in body["items"]))
    check("CORS header echoed",
          response["headers"].get("Access-Control-Allow-Origin") == ORIGIN)

    print("\nF) Safety cap reports itself instead of dropping rows silently")
    _, body = call_list(page_size=50, max_items=10)
    check("truncated flagged", body["truncated"] is True)
    check("cap respected", body["count"] == 10, f"-> {body['count']}")

    print("\nG) Cap exactly equal to the number of receipts is not truncation")
    _, body = call_list(page_size=1000, max_items=RECEIPT_COUNT)
    check("not flagged as truncated", body["truncated"] is False,
          f"-> {body['count']}")

    print("\nH) User with no receipts")
    saved = list(RECEIPTS)
    RECEIPTS.clear()
    try:
        _, body = call_list(page_size=50)
        check("empty list, no error", body["count"] == 0 and body["items"] == [])
    finally:
        RECEIPTS.extend(saved)

    print()
    if failures:
        print(f"FAILED: {len(failures)} check(s) -> {', '.join(failures)}")
        return 1
    print("All checks passed.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
