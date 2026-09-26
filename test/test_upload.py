"""
Offline test for POST /receipts content-type handling.

The presigned upload URL is signed for a fixed Content-Type. The frontend used
to send no type (so the URL was signed for image/jpeg) and then upload the file
with its real type, so every PNG failed with SignatureDoesNotMatch (403). The
API must sign for the type the client declares, and refuse types the OCR path
has not been verified to read.

Usage:
    python3 -m pip install boto3 requests
    python3 test/test_upload.py
"""

import json
import os
import sys

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(REPO_ROOT, "src", "api"))

os.environ.update(
    RECEIPTS_TABLE="test-receipts",
    UPLOADS_BUCKET="test-uploads",
    CORS_ORIGINS="https://app.spendifyapp.com",
    AWS_DEFAULT_REGION="eu-central-1",
)

import app  # noqa: E402

ORIGIN = "https://app.spendifyapp.com"
signed = []
stored = []


class FakeS3:
    def generate_presigned_url(self, ClientMethod, Params, ExpiresIn):
        signed.append(Params)
        return "https://example.invalid/upload"


class FakeTable:
    def put_item(self, Item):
        stored.append(Item)


app.s3 = FakeS3()
app._receipts_table = lambda: FakeTable()


def post(body):
    signed.clear()
    stored.clear()
    event = {
        "rawPath": "/receipts",
        "headers": {"origin": ORIGIN},
        "body": json.dumps(body) if body is not None else None,
        "requestContext": {
            "http": {"method": "POST"},
            "authorizer": {"jwt": {"claims": {"sub": "user-1"}}},
        },
    }
    res = app.handler(event, None)
    return res["statusCode"], json.loads(res["body"])


def test_png_is_signed_as_png():
    status, body = post({"contentType": "image/png"})
    assert status == 201, body
    assert signed[0]["ContentType"] == "image/png"
    assert stored[0]["contentType"] == "image/png"


def test_no_type_still_defaults_to_jpeg_for_older_clients():
    status, _ = post(None)
    assert status == 201 and signed[0]["ContentType"] == "image/jpeg"


def test_types_the_ocr_path_cannot_read_are_refused():
    for bad in ("application/pdf", "image/heic", "image/gif", "text/html"):
        status, body = post({"contentType": bad})
        assert status == 400 and body["error"] == "unsupported_content_type", (bad, status, body)
        assert not signed and not stored, f"{bad} must not create a receipt or a URL"


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
