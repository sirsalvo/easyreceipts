import json
import os
import time
from typing import Any, Dict, Optional, Tuple

import boto3


AWS_REGION = os.environ.get("AWS_REGION") or os.environ.get("AWS_DEFAULT_REGION") or "eu-central-1"

RECEIPTS_TABLE = os.environ.get("RECEIPTS_TABLE", "")
UPLOADS_BUCKET = os.environ.get("UPLOADS_BUCKET", "")

# Where we store raw Textract AnalyzeExpense output
OCR_PREFIX = os.environ.get("OCR_PREFIX", "ocr/")

OCR_PROVIDER = "textract_expense"
OCR_STATE_READY = "READY"
STATUS_OCR_DONE = "OCR_DONE"


textract = boto3.client("textract", region_name=AWS_REGION)
s3 = boto3.client("s3", region_name=AWS_REGION)
dynamodb = boto3.resource("dynamodb", region_name=AWS_REGION)


def _parse_s3_key(key: str) -> Optional[Tuple[str, str]]:
    """Extract (user_sub, receipt_id) from processed/<sub>/<rid>.jpg"""
    if not key.startswith("processed/"):
        return None
    parts = key.split("/")
    if len(parts) < 3:
        return None
    sub = parts[1]
    rid = parts[2]
    if rid.lower().endswith(".jpg"):
        rid = rid[: -len(".jpg")]
    return sub, rid


def _put_json(bucket: str, key: str, payload: Dict[str, Any]) -> None:
    s3.put_object(
        Bucket=bucket,
        Key=key,
        Body=json.dumps(payload, ensure_ascii=False).encode("utf-8"),
        ContentType="application/json",
    )


def _update_receipt(sub: str, rid: str, raw_key: str) -> None:
    if not RECEIPTS_TABLE:
        raise RuntimeError("RECEIPTS_TABLE env var not set")
    table = dynamodb.Table(RECEIPTS_TABLE)
    now_ms = int(time.time() * 1000)
    table.update_item(
        Key={"PK": f"USER#{sub}", "SK": f"RECEIPT#{rid}"},
        UpdateExpression=(
            "SET #s=:s, ocrState=:ocrState, ocrProvider=:ocrProvider, ocrRawKey=:ocrRawKey, updatedAt=:u"
        ),
        ExpressionAttributeNames={"#s": "status"},
        ExpressionAttributeValues={
            ":s": STATUS_OCR_DONE,
            ":ocrState": OCR_STATE_READY,
            ":ocrProvider": OCR_PROVIDER,
            ":ocrRawKey": raw_key,
            ":u": now_ms,
        },
    )


def handler(event, context):
    """Triggered by S3:ObjectCreated:* on prefix processed/"""
    # S3 event can contain multiple records
    records = event.get("Records") or []
    for rec in records:
        s3info = (rec.get("s3") or {}).get("object") or {}
        bucket = ((rec.get("s3") or {}).get("bucket") or {}).get("name") or UPLOADS_BUCKET
        key = s3info.get("key")
        if not bucket or not key:
            continue

        parsed = _parse_s3_key(key)
        if not parsed:
            continue
        sub, rid = parsed

        # Call Textract directly on the S3 object
        tex = textract.analyze_expense(
            Document={"S3Object": {"Bucket": bucket, "Name": key}}
        )

        raw_key = f"{OCR_PREFIX}{sub}/{rid}.json"
        _put_json(bucket, raw_key, tex)
        _update_receipt(sub, rid, raw_key)

    return {"ok": True}
